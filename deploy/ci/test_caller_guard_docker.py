"""Disposable Linux/Docker/systemd proof; enabled only on the runtime CI host."""

import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest

from test_caller_guard import GUARD, PROBE, guard, sidecars

ROOT = GUARD.parents[2]
IMAGE = os.environ.get("POISE_GUARD_IMAGE")
WRITER = r'''
import json, os, sys
from pathlib import Path
addresses = set()
for entry in Path('/proc').iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        if b'/opt/poise/dist/server.js' not in (entry / 'cmdline').read_bytes().split(b'\0'):
            continue
        addresses.update(value.partition(b'=')[2].decode() for value in (entry / 'environ').read_bytes().split(b'\0')
                         if value.startswith(b'POISE_NATIVE_CONTROL='))
    except (FileNotFoundError, ProcessLookupError):
        continue
assert len(addresses) == 1, addresses
os.environ['POISE_NATIVE_CONTROL'] = addresses.pop()
os.environ['AGENT_INTERFACE_DATA_DIR'] = json.loads(os.environ['POISE_NATIVE_CONTROL'])['store']['path']
import agent_interface as api
api.init_db()
connection = api.caller_store.connect(api.DB)
connection.execute('PRAGMA wal_autocheckpoint=0')
print('ready', flush=True)
for command in sys.stdin:
    if command.strip() == 'replace':
        root = Path(os.environ['AGENT_INTERFACE_DATA_DIR'])
        root.rename(root.with_name('agent-interface-original'))
        root.mkdir(mode=0o700)
        import sqlite3
        replacement = sqlite3.connect(root / 'calls.sqlite3')
        replacement.execute('PRAGMA journal_mode=WAL')
        replacement.execute('CREATE TABLE replacement (n INTEGER)')
        print('replaced', flush=True)
        continue
    call = api.track('component', 'host Caller fence no-effect component', actor='component', source='guard-component')
    api.finish(call, 'done')
    assert api.logs_selected({'latest': [], 'ids': [call], 'correlations': []})[0]['status'] == 'done'
    checkpoint = connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
    assert checkpoint[0] == 0, checkpoint
    assert connection.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    print('written', flush=True)
connection.close()
'''


@unittest.skipUnless(IMAGE, "set POISE_GUARD_IMAGE on a disposable root Docker/systemd host with runsc")
class CallerGuardDockerTest(unittest.TestCase):
    def run_command(self, *arguments, **options):
        return subprocess.run(arguments, text=True, capture_output=True, check=True, timeout=120, **options).stdout.strip()

    def setUp(self):
        self.assertEqual(os.getuid(), 0, "the host guard proof needs root")
        self.assertFalse(Path("/etc/systemd/system/poise-caller-guard.service").exists(), "refusing an existing guard installation")
        self.work = tempfile.TemporaryDirectory(prefix="caller-guard-docker-", dir="/tmp")
        self.addCleanup(self.work.cleanup)
        self.name = f"poise-guard-component-{os.getpid()}"
        self.volume = self.name + "-home"
        self.writer = None
        self.addCleanup(self.cleanup)
        self.run_command("docker", "volume", "create", self.volume)
        self.key = self.run_command("node", str(ROOT / "deploy/runtime/test/identity.mjs"), "key", self.work.name + "/key")

    def cleanup(self):
        try:
            self.stop_writer()
        finally:
            subprocess.run(["systemctl", "disable", "--now", "poise-caller-guard.service"], capture_output=True, check=False)
            subprocess.run(["docker", "rm", "--force", self.name], capture_output=True, check=False)
            subprocess.run(["docker", "volume", "rm", self.volume], capture_output=True, check=False)
            Path("/etc/systemd/system/poise-caller-guard.service").unlink(missing_ok=True)
            self.run_command("systemctl", "daemon-reload")

    def start_workspace(self, runtime):
        self.run_command("docker", "run", "--detach", "--name", self.name, "--runtime", runtime,
                         "--restart", "unless-stopped", "--label", "poise.managed=true", "--label", "poise.workspace=guard-component",
                         "--user", "10001:10001", "--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                         "--network", "none", "--no-healthcheck", "--memory", "2g", "--pids-limit", "256",
                         "--mount", f"type=volume,source={self.volume},target=/home/poise",
                         "-e", "POISE_MODE=service", "-e", "POISE_WORKSPACE_HANDLE=guard-component",
                         "-e", "POISE_WORKSPACE_OWNER=Guard-Component", "-e", "POISE_PUBLIC_ORIGIN=https://guard-component.poise.test",
                         "-e", f"POISE_GATEWAY_PUBLIC_KEY={self.key}", "-e", "POISE_SKIP_CLI_BOOTSTRAP=1", IMAGE)
        self.wait_health()
        self.home = Path(json.loads(self.run_command("docker", "inspect", self.name))[0]["Mounts"][0]["Source"])
        self.path = self.home / ".poise/agent-interface/calls.sqlite3"

    def wait_health(self):
        deadline = time.monotonic() + 90
        while True:
            result = subprocess.run(["docker", "exec", self.name, "curl", "-fsS", "--max-time", "3",
                                     "http://127.0.0.1:5555/api/service/health"], capture_output=True, text=True)
            if result.returncode == 0 and json.loads(result.stdout)["ok"]:
                return json.loads(result.stdout)
            self.assertLess(time.monotonic(), deadline, result.stderr)
            time.sleep(1)

    def start_writer(self):
        self.writer = subprocess.Popen(["docker", "exec", "--interactive", self.name, "/opt/caller/venv/bin/python", "-u", "-c", WRITER],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assert_line("ready")

    def stop_writer(self):
        if self.writer is not None:
            self.writer.stdin.close()
            self.writer.wait(timeout=15)
            error = self.writer.stderr.read()
            self.writer.stdout.close()
            self.writer.stderr.close()
            self.assertEqual(self.writer.returncode, 0, error)
            self.writer = None

    def assert_line(self, expected):
        self.assertTrue(select.select([self.writer.stdout], [], [], 30)[0], "guest Caller writer did not answer")
        line = self.writer.stdout.readline().strip()
        self.assertEqual(line, expected)

    def write(self):
        self.writer.stdin.write("write\n")
        self.writer.stdin.flush()
        self.assert_line("written")
        health = self.wait_health()
        self.assertIsNotNone(health["runningCallerCalls"], health)
        self.assertEqual(health["unsettledNativeCalls"], 0, health)

    def protected(self, *paths):
        snapshot = guard.check(guard.SOCKET)
        self.assertTrue(snapshot["locks"])
        for path in paths:
            before = sidecars(path)
            self.assertIn("-shm", before)
            for mode in ("ro", "rw"):
                answer = self.run_command(sys.executable, "-c", PROBE, str(path), mode)
                self.assertEqual(answer, "SQLITE_BUSY")
                self.assertEqual(sidecars(path), before, f"host {mode} changed guest sidecars through cleanup")

    def test_host_service_lifecycle_and_guest_caller_survive_the_fence(self):
        self.start_workspace("runsc")
        self.start_writer()
        self.run_command("bash", "-c", 'set -euo pipefail; . deploy/lib.sh; env_value() { :; }; ensure_caller_guard', cwd=ROOT)
        self.assertEqual(self.run_command("systemctl", "is-enabled", "poise-caller-guard.service"), "enabled")
        self.protected(self.path)
        self.write()

        self.writer.stdin.write("replace\n")
        self.writer.stdin.flush()
        self.assert_line("replaced")
        original = self.path.parent.with_name("agent-interface-original") / "calls.sqlite3"
        self.protected(original, self.path)
        self.write()  # Caller and health retain the supervisor's original metadata.
        old_pid = guard.check(guard.SOCKET)["pid"]
        self.run_command("systemctl", "kill", "--signal=KILL", "--kill-whom=main", "poise-caller-guard.service")
        deadline = time.monotonic() + 30
        last_error = "waiting for the replacement guard"
        while True:
            try:
                if guard.check(guard.SOCKET)["pid"] != old_pid:
                    break
            except (OSError, RuntimeError, ValueError) as error:
                last_error = str(error)
            self.assertLess(time.monotonic(), deadline, last_error)
            time.sleep(0.1)
        self.protected(original, self.path)
        self.write()

        self.stop_writer()
        # Quiesce the original before restoring its pathname; identity checks
        # remain intact. A new supervisor after restart pins this same store.
        self.run_command("docker", "stop", self.name)
        self.path.unlink()
        self.path.parent.rmdir()
        original.parent.rename(self.path.parent)
        self.run_command("docker", "start", self.name)
        self.wait_health()
        self.start_writer()
        self.protected(self.path)
        self.write()
        self.stop_writer()

        # Exercise boot-style independent restart policies, without a gateway.
        self.run_command("systemctl", "restart", "docker")
        self.wait_health()
        self.start_writer()
        self.protected(self.path)
        self.write()
        self.stop_writer()

        self.run_command("docker", "rm", "--force", self.name)
        self.start_workspace("runc")
        self.assertEqual(guard.check(guard.SOCKET)["locks"], [])
        self.start_writer()
        self.write()
        self.stop_writer()


if __name__ == "__main__":
    unittest.main()

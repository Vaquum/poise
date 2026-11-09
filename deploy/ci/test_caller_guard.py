"""Exercise actual fcntl locks and separate SQLite clients, without production data."""

import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import unittest

GUARD = Path(__file__).resolve().parents[1] / "caller-guard" / "guard.py"
SPEC = importlib.util.spec_from_file_location("caller_guard", GUARD)
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
PROBE = """
import sqlite3, sys
from pathlib import Path
connection = sqlite3.connect(Path(sys.argv[1]).as_uri() + '?mode=' + sys.argv[2], uri=True, timeout=0)
try:
    connection.execute('BEGIN IMMEDIATE' if sys.argv[2] == 'rw' else 'SELECT count(*) FROM sqlite_schema').fetchone()
except sqlite3.OperationalError as error:
    assert error.sqlite_errorcode == sqlite3.SQLITE_BUSY, (error, error.sqlite_errorcode)
    print('SQLITE_BUSY')
else:
    raise AssertionError('host SQL crossed the workspace fence')
finally:
    connection.close()
"""


def sidecars(path):
    return {suffix: (file.stat().st_ino, file.stat().st_size, file.stat().st_mtime_ns, file.read_bytes())
            for suffix in ("", "-wal", "-shm", "-journal") if (file := Path(str(path) + suffix)).exists()}


class CallerGuardTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="caller-guard-", dir="/tmp")
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.path = self.home / ".poise" / "agent-interface" / "calls.sqlite3"
        self.socket = str(self.root / "control.sock")
        self.state = self.root / "docker.json"
        self.set_runtime("runsc")
        binary = self.root / "bin"
        binary.mkdir()
        docker = binary / "docker"
        docker.write_text(f'#!{sys.executable}\n' + """
import json, os, sys
state = json.load(open(os.environ['GUARD_DOCKER_STATE']))
if state.get('unavailable'):
    sys.exit(1)
if sys.argv[1] == 'info':
    print(json.dumps({'runsc': {'path': '/usr/local/bin/runsc'}, 'sandbox': {'path': '/usr/local/bin/runsc'}, 'runc': {'path': 'runc'}}))
elif sys.argv[1] == 'ps':
    print('fixture')
elif sys.argv[1] == 'inspect':
    print(json.dumps([state['container']]))
else:
    sys.exit(2)
""")
        docker.chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.root), "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                    "GUARD_DOCKER_STATE": str(self.state), "POISE_WORKSPACE_RUNTIME": "runc"}
        self.process = None
        self.log = (self.root / "guard.log").open("w+")
        self.addCleanup(self.log.close)
        self.addCleanup(self.stop)

    def set_runtime(self, runtime, unavailable=False):
        self.state.write_text(json.dumps({"unavailable": unavailable, "container": {
            "Name": "/poise-ws-fixture", "State": {"Running": True}, "HostConfig": {"Runtime": runtime},
            "Mounts": [{"Type": "volume", "Destination": "/home/poise", "Source": str(self.home)}],
        }}))

    def database(self, path=None):
        path = path or self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        # Leave realistic WAL files without an active host-kernel SQLite lock.
        subprocess.run([sys.executable, "-c", "import os,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                        "c.execute('PRAGMA journal_mode=WAL'); c.execute('CREATE TABLE notes (n INTEGER)'); "
                        "c.execute('INSERT INTO notes VALUES (1)'); c.commit(); os._exit(0)", str(path)], check=True)

    def start(self):
        Path(self.socket).unlink(missing_ok=True)  # systemd RuntimeDirectory does this on restart.
        self.process = subprocess.Popen([sys.executable, str(GUARD), "--socket", self.socket],
                                        env=self.env, stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 5
        while not Path(self.socket).exists():
            self.log.seek(0)
            self.assertIsNone(self.process.poll(), self.log.read())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.01)

    def stop(self):
        if self.process is not None:
            self.process.kill()
            self.process.wait(timeout=5)
            self.process = None

    def check(self, ok=True):
        result = subprocess.run([sys.executable, str(GUARD), "--check", "--socket", self.socket],
                                env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return result

    def refused(self, path):
        before = sidecars(path)
        for mode in ("ro", "rw"):
            result = subprocess.run([sys.executable, "-c", PROBE, str(path), mode],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "SQLITE_BUSY\n", ""))
            self.assertEqual(sidecars(path), before, f"{mode} changed sidecars through connection cleanup")

    def test_rescans_retain_original_inode_and_alias_locks_across_replacement_and_guard_restart(self):
        self.database()
        self.start()
        self.check()
        self.refused(self.path)
        self.path.parents[1].rename(self.home / ".poise-original")
        original = self.home / ".poise-original" / "agent-interface" / "calls.sqlite3"
        self.database()
        alias = self.home / "alias"
        alias.mkdir()
        os.link(original, alias / "calls.sqlite3")
        pid = self.process.pid
        for _ in range(3):
            self.check()
            self.assertEqual(self.process.pid, pid)
            self.refused(original)
            self.refused(self.path)
        self.stop()
        self.start()
        self.check()
        self.refused(original)
        self.refused(self.path)

    def test_first_creation_docker_loss_and_actual_runtime_scope(self):
        self.start()
        self.assertIn("first Caller store", self.check(False).stderr)
        self.database()
        self.check()
        self.set_runtime("runsc", unavailable=True)
        self.check(False)
        self.refused(self.path)
        self.set_runtime("sandbox")  # Inspect the registered runsc alias, not .env.
        self.check()
        self.refused(self.path)
        self.set_runtime("runc")
        self.check()
        result = subprocess.run([sys.executable, "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
                                 "c.execute('INSERT INTO notes VALUES (2)'); c.commit(); "
                                 "assert c.execute('PRAGMA integrity_check').fetchone() == ('ok',); c.close()", str(self.path)],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_acquisition_failure_is_unhealthy_and_retries_without_dropping_existing_locks(self):
        self.database()
        self.start()
        self.check()
        second = self.home / "replacement" / "calls.sqlite3"
        self.database(second)
        with second.open("r+b") as foreign:
            fcntl.lockf(foreign, fcntl.LOCK_EX | fcntl.LOCK_NB, guard.LENGTH, guard.START)
            self.assertIn("protection unavailable", self.check(False).stderr)
            self.refused(self.path)
            self.assertIsNone(self.process.poll())
        self.check()
        self.refused(second)

    def test_renamed_failed_acquisition_stays_unhealthy_until_holder_exits(self):
        self.database()
        self.start()
        self.check()
        second = self.home / "replacement" / "calls.sqlite3"
        self.database(second)
        foreign = second.open("r+b")
        self.addCleanup(foreign.close)
        fcntl.lockf(foreign, fcntl.LOCK_EX | fcntl.LOCK_NB, guard.LENGTH, guard.START)
        self.assertIn("protection unavailable", self.check(False).stderr)
        renamed = second.parent / "calls.sqlite3.old"
        second.rename(renamed)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(second) + suffix)
            if sidecar.exists():
                sidecar.rename(Path(str(renamed) + suffix))
        self.database(second)
        # The retained original stays unlocked while its holder lives, even
        # though the replacement pathname already has an acquirable store.
        self.assertIn("protection unavailable", self.check(False).stderr)
        self.assertIsNone(self.process.poll())
        foreign.close()
        self.check()
        self.refused(renamed)
        self.refused(second)
        self.refused(self.path)

    def test_restart_rediscovers_renamed_old_store(self):
        self.database()
        self.start()
        self.check()
        self.refused(self.path)
        old = self.path.with_name("calls.sqlite3.old")
        self.path.rename(old)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(self.path) + suffix)
            if sidecar.exists():
                sidecar.rename(Path(str(old) + suffix))
        self.database()
        self.check()
        self.refused(old)
        self.refused(self.path)
        self.stop()
        self.start()
        self.check()
        self.refused(old)
        self.refused(self.path)

    def test_probe_rejects_a_live_process_without_the_lock(self):
        self.database()
        with self.path.open("rb") as file:
            node = os.fstat(file.fileno())
            snapshot = {"pid": os.getpid(), "locks": [{"fd": file.fileno(), "identity": [node.st_dev, node.st_ino]}]}
            result = subprocess.run([sys.executable, str(GUARD), "--probe"], input=json.dumps(snapshot),
                                    capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("host lock lost", result.stderr)

    def test_backup_refuses_a_live_separate_kernel_before_opening_any_database(self):
        operator = self.root / "operator"
        operator.mkdir()
        deploy = GUARD.parents[1]
        (operator / "backup.sh").write_text((deploy / "backup.sh").read_text())
        (operator / "lib.sh").write_text(f'. {shlex.quote(str(deploy / "lib.sh"))}\n' + """
require_linux() { :; }
require_docker() { :; }
require_env_file() { :; }
runtime_image() { printf '%s' fixture; }
docker() {
  case "$1" in
    image|volume) case "$2" in inspect) return 0 ;; ls) printf '%s\\n' poise-home-fixture ;; *) return 99 ;; esac ;;
    info) printf '%s\\n' runc ;;
    ps) printf '%s\\n' fixture ;;
    inspect) printf '%s\\n' 'fixture|/poise-ws-fixture|runsc|running||poise-home-fixture|end' ;;
    *) printf 'unsafe backup operation: %s\\n' "$*" >&2; return 99 ;;
  esac
}
""")
        output = self.root / "backups"
        result = subprocess.run(["bash", str(operator / "backup.sh"), str(output)],
                                capture_output=True, text=True, env=self.env, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing backup", result.stderr)
        self.assertIn("another kernel", result.stderr)
        self.assertNotIn("unsafe backup operation", result.stderr)
        self.assertFalse(output.exists())

    def test_backup_allows_containerd_runc_like_plain_runc(self):
        for runtime in ("runc", "io.containerd.runc.v2"):
            with self.subTest(runtime=runtime):
                operator = self.root / f"operator-{runtime.replace('.', '-')}"
                operator.mkdir()
                deploy = GUARD.parents[1]
                (operator / "backup.sh").write_text((deploy / "backup.sh").read_text())
                (operator / "lib.sh").write_text(f'. {shlex.quote(str(deploy / "lib.sh"))}\n' + f"""
require_linux() {{ :; }}
require_docker() {{ :; }}
require_env_file() {{ :; }}
runtime_image() {{ printf '%s' fixture; }}
docker() {{
  case "$1" in
    image|volume) case "$2" in inspect) return 0 ;; ls) printf '%s\\n' poise-home-fixture ;; *) return 99 ;; esac ;;
    info) printf '%s\\n' runc ;;
    ps) printf '%s\\n' fixture ;;
    inspect) printf '%s\\n' 'fixture|/poise-ws-fixture|{runtime}|running||poise-home-fixture|end' ;;
    *) printf 'unsafe backup operation: %s\\n' "$*" >&2; return 99 ;;
  esac
}}
""")
                output = self.root / f"backups-{runtime.replace('.', '-')}"
                result = subprocess.run(["bash", str(operator / "backup.sh"), str(output)],
                                        capture_output=True, text=True, env=self.env, timeout=5)
                self.assertNotIn("refusing backup", result.stderr)
                self.assertIn("unsafe backup operation", result.stderr)

    def test_padded_workspace_runtime_still_installs_gvisor_guard(self):
        # A quoted padded setting is valid: the gateway trims it to runsc, so
        # the host fence must be installed rather than skipped via exit 10.
        deploy = GUARD.parents[1]
        env_file = self.root / "poise.env"
        env_file.write_text('POISE_WORKSPACE_RUNTIME=" runsc "\n')
        sudo_log = self.root / "sudo.log"
        sudo_log.write_text("")
        binary = self.root / "guard-bin"
        binary.mkdir()
        (binary / "docker").write_text("""#!/bin/bash
if [ "$1" = info ]; then
  case "$3" in
    *json*) printf '{"runsc": {"path": "/usr/local/bin/runsc"}, "runc": {"path": "runc"}}' ;;
    *) printf 'runc' ;;
  esac
elif [ "$1" = ps ]; then
  : # Fresh deployment: no workspace containers yet.
else
  echo "unexpected docker $*" >&2; exit 99
fi
""")
        (binary / "sudo").write_text("""#!/bin/bash
echo "$*" >> "$GUARD_SUDO_LOG"
for argument in "$@"; do
  if [ "$argument" = --check ]; then
    echo 'Host locks verified on 1 Caller inode(s)'
    exit 0
  fi
done
exit 0
""")
        (binary / "id").write_text("#!/bin/bash\nif [ \"$1\" = -u ]; then echo 1000; else exec /usr/bin/id \"$@\"; fi\n")
        for name in ("docker", "sudo", "id"):
            (binary / name).chmod(0o755)
        env = {**self.env, "PATH": str(binary) + os.pathsep + self.env["PATH"],
               "GUARD_SUDO_LOG": str(sudo_log)}
        script = (f"set -uo pipefail\n. {shlex.quote(str(deploy / 'lib.sh'))}\n"
                  f"env_file={shlex.quote(str(env_file))}\n"
                  "ensure_caller_guard\nprintf 'RC=%s\\n' \"$?\"\n")
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Host locks verified", result.stdout)
        self.assertIn("install", sudo_log.read_text(),
                      "padded runsc must reach guard installation, not exit 10")

    def test_whitespace_only_runtime_falls_back_to_docker_default(self):
        # Whitespace-only means unset: the gateway trims it and Docker's
        # default runtime applies, so a runsc default must install the guard.
        deploy = GUARD.parents[1]
        env_file = self.root / "poise.env"
        env_file.write_text('POISE_WORKSPACE_RUNTIME="   "\n')
        sudo_log = self.root / "sudo.log"
        sudo_log.write_text("")
        binary = self.root / "guard-bin-ws"
        binary.mkdir()
        (binary / "docker").write_text("""#!/bin/bash
if [ "$1" = info ]; then
  case "$3" in
    *json*) printf '{"runsc": {"path": "/usr/local/bin/runsc"}, "runc": {"path": "runc"}}' ;;
    *) printf 'runsc' ;;
  esac
elif [ "$1" = ps ]; then
  : # Fresh deployment: no workspace containers yet.
else
  echo "unexpected docker $*" >&2; exit 99
fi
""")
        (binary / "sudo").write_text("""#!/bin/bash
echo "$*" >> "$GUARD_SUDO_LOG"
for argument in "$@"; do
  if [ "$argument" = --check ]; then
    echo 'Host locks verified on 1 Caller inode(s)'
    exit 0
  fi
done
exit 0
""")
        (binary / "id").write_text("#!/bin/bash\nif [ \"$1\" = -u ]; then echo 1000; else exec /usr/bin/id \"$@\"; fi\n")
        for name in ("docker", "sudo", "id"):
            (binary / name).chmod(0o755)
        env = {**self.env, "PATH": str(binary) + os.pathsep + self.env["PATH"],
               "GUARD_SUDO_LOG": str(sudo_log)}
        script = (f"set -uo pipefail\n. {shlex.quote(str(deploy / 'lib.sh'))}\n"
                  f"env_file={shlex.quote(str(env_file))}\n"
                  "ensure_caller_guard\nprintf 'RC=%s\\n' \"$?\"\n")
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Host locks verified", result.stdout)
        self.assertIn("install", sudo_log.read_text(),
                      "whitespace-only runtime must fall back to the runsc Docker default, not exit 10")

    def test_runc_deployment_needs_no_host_guard_or_python(self):
        library = shlex.quote(str(GUARD.parents[1] / "lib.sh"))
        result = subprocess.run(["bash", "-c", f'. {library}\n' + """
set -euo pipefail
env_value() { :; }
docker() {
  case "$1 $2" in
    'info --format'|'inspect --format') printf '%s\\n' runc ;;
    'ps --all') printf '%s\\n' fixture ;;
    *) return 99 ;;
  esac
}
python3() { printf 'unexpected host guard operation\\n' >&2; return 99; }
sudo() { printf 'unexpected host guard operation\\n' >&2; return 99; }
ensure_caller_guard
"""], capture_output=True, text=True, env=self.env, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")


if __name__ == "__main__":
    unittest.main()

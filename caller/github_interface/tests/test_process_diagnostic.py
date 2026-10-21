import io
import json
import signal
import subprocess
import sys
import tempfile
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from time import monotonic, sleep
from unittest import TestCase
from unittest.mock import patch

from github_interface import cli
from github_interface.atoms import review_diff as rd
from github_interface.atoms.process_diagnostic import MARKER, GitProcessError, STDERR_BYTES, redact


class TestProcessDiagnostic(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.env = {**rd._env('test-private-token'), 'PATH': str(self.root)}

    def fake(self, body):
        path = self.root / 'git'
        path.write_text(f'#!{sys.executable}\n' + body)
        path.chmod(0o700)

    def failure(self, *args, **kwargs):
        with self.assertRaises(GitProcessError) as error:
            rd._git(str(self.root), self.env, *args, **kwargs)
        return error.exception

    def test_actual_operation_and_multiline_cause_survive_flags(self):
        for cause in ('fatal: permission denied', 'fatal: Authentication failed',
                      'fatal: unable to resolve host', 'fatal: invalid ref', 'fatal: unspecified failure'):
            with self.subTest(cause=cause):
                self.fake(f'import sys\nsys.stderr.write({(cause + chr(10) + "detail follows")!r})\nsys.exit(128)\n')
                error = self.failure('-c', 'core.quotePath=false', 'diff', '--raw')
                self.assertIn('git diff', str(error))
                self.assertIn(cause, str(error))
                self.assertEqual(error.diagnostic['exit_code'], 128)
                self.assertEqual(error.diagnostic['stderr'], cause + '\ndetail follows')

    def test_capture_drains_large_output_and_never_exposes_credential_fragments(self):
        credential = self.env['GIT_CONFIG_VALUE_0']
        self.fake(f'import sys\nsys.stderr.write("fatal: fetch failed\\n" + {credential!r} + "\\n" + "x" * 2000000 + "\\nunderlying cause: network unreachable\\n")\nsys.exit(1)\n')
        error = self.failure('fetch')
        self.assertTrue(error.diagnostic['stderr_truncated'])
        self.assertLess(len(error.diagnostic['stderr']), STDERR_BYTES + 100)
        self.assertIn('fatal: fetch failed', error.diagnostic['stderr'])
        self.assertIn('network unreachable', error.diagnostic['stderr'])
        self.assertNotIn(credential.split()[-1], str(error))
        self.assertNotIn('test-private-token', str(error))
        self.assertIn('truncated', str(error))

    def test_credentials_are_redacted_before_cli_serialization(self):
        credential = self.env['GIT_CONFIG_VALUE_0'].split()[-1]
        secrets = 'test-private-token ' + credential + '\nAuthorization: Basic ' + credential + '\nCookie: session=hidden-cookie\nhttps://name:password@example.com/a?token=hidden-query\nghp_hiddenkey'
        self.fake(f'import sys\nsys.stderr.write({secrets!r})\nsys.exit(1)\n')
        failure = self.failure('fetch')

        async def fail(payload):
            raise failure

        output = io.StringIO()
        with patch.object(cli, 'checkout_review', fail), patch.object(sys, 'argv', ['github-interface', '--checkout-review', '#1', '--path', '/unused', '--base-sha', 'b' * 40, '--merge-base-sha', 'b' * 40, '--expected-head', 'a' * 40, '--token-user', 'bot']), redirect_stderr(output), self.assertRaises(SystemExit):
            cli.main()
        record = json.loads(output.getvalue().removeprefix('caller_diagnostic: '))
        self.assertEqual(record['operation'], 'fetch')
        for secret in ('test-private-token', credential, 'hidden-cookie', 'password', 'hidden-query', 'ghp_hiddenkey'):
            self.assertNotIn(secret, output.getvalue())

    def test_secrets_of_every_length_are_redacted(self):
        self.env.update(TEST_PASSWORD='pw7!', TEST_TOKEN='s2')
        self.fake('import sys\nsys.stderr.write("fatal: pw7! rejected for s2\\n")\nsys.exit(128)\n')
        error = self.failure('fetch')
        self.assertEqual(error.diagnostic['stderr'], 'fatal: [redacted] rejected for [redacted]')
        for secret in ('pw7!', 's2'):
            self.assertNotIn(secret, str(error))

    def test_a_one_letter_secret_keeps_header_redaction_and_markers_whole(self):
        self.env['TEST_KEY'] = 'e'
        self.fake('import sys\nsys.stderr.write("fatal: e\\nSet-Cookie: session=hidden\\n")\nsys.exit(128)\n')
        error = self.failure('fetch')
        self.assertEqual(error.diagnostic['stderr'], 'fatal: [redacted]\n[redacted header]')
        once = redact('kept' + MARKER + 'e [redacted credential]', self.env)
        self.assertEqual(once, 'k[redacted]pt' + MARKER + '[redacted] [redacted credential]')
        self.assertEqual(redact(once, self.env), once)

    def test_signal_timeout_missing_binary_and_empty_stderr_are_distinct(self):
        self.fake('import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n')
        self.assertEqual(self.failure('checkout').diagnostic['signal'], signal.SIGTERM)
        ready = self.root / 'stderr-ready'
        self.fake('import sys, time\nfrom pathlib import Path\nsys.stderr.write("waiting for peer\\n"); sys.stderr.flush()\n'
                  f'Path({str(ready)!r}).touch()\ntime.sleep(10)\n')
        child = subprocess.Popen(['git', 'fetch'], cwd=self.root, env=self.env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = monotonic() + 3
            while not ready.exists() and child.poll() is None and monotonic() < deadline:
                sleep(.01)
            self.assertTrue(ready.exists(), 'Git fixture did not reach its stderr write')
            # Test the deadline of an I/O-ready process, independently of interpreter startup.
            with patch.object(rd.subprocess, 'Popen', return_value=child) as spawn:
                error = self.failure('fetch', timeout=0.1)
            spawn.assert_called_once()
            self.assertIsInstance(error, TimeoutError)
            self.assertEqual(error.diagnostic['outcome'], 'timed_out')
            self.assertEqual(error.diagnostic['timeout_seconds'], 0.1)
            self.assertEqual(child.returncode, -signal.SIGKILL)
            self.assertIn('waiting for peer', str(error))
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
            child.stdout.close()
            child.stderr.close()
        (self.root / 'git').unlink()
        self.assertEqual(self.failure('init').diagnostic['outcome'], 'missing_executable')
        self.fake('raise SystemExit(128)\n')
        self.assertIn('cause unknown', str(self.failure('fetch')))

    def test_silent_process_deadline_keeps_missing_stderr_explicit(self):
        self.fake('import time\ntime.sleep(10)\n')
        error = self.failure('fetch', timeout=0.01)
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(error.diagnostic['outcome'], 'timed_out')
        self.assertEqual(error.diagnostic['stderr'], '')
        self.assertIn('no stderr was provided; cause unknown', str(error))

    def test_malformed_optional_basic_credential_never_masks_the_git_cause(self):
        self.env['EXTRA_AUTHORIZATION'] = 'authorization: basic abc'
        self.fake('import sys\nsys.stderr.write("fatal: permission denied\\n")\nsys.exit(128)\n')
        error = self.failure('fetch')
        self.assertIn('permission denied', str(error))
        self.assertEqual(error.diagnostic['exit_code'], 128)

    def test_deadline_during_stderr_drain_cannot_turn_success_into_timeout(self):
        self.fake('print("completed diff")\n')
        state = {}
        def timer(seconds, expire):
            state['expire'] = expire
            return SimpleNamespace(start=lambda: None, cancel=lambda: state.update(cancelled=True))
        def join(**kwargs):
            if not state.get('cancelled'):
                state['expire']()
        reader = SimpleNamespace(start=lambda: None, join=join, is_alive=lambda: False)
        with patch.object(rd.threading, 'Timer', side_effect=timer), patch.object(rd.threading, 'Thread', return_value=reader):
            self.assertEqual(rd._git(str(self.root), self.env, 'diff'), b'completed diff\n')

    def test_resource_evidence_is_measured_at_failure_and_missing_measurement_is_explicit(self):
        self.fake('import sys\nsys.stderr.write("fatal: No space left on device\\n")\nsys.exit(1)\n')
        event = self.failure('checkout').diagnostic
        self.assertEqual(event['outcome'], 'resource_failure')
        self.assertIsInstance(event['filesystem']['free_bytes'], int)
        self.assertIsInstance(event['filesystem']['free_inodes'], int)
        self.assertIn('measured_at', event['filesystem'])
        with patch('os.statvfs', side_effect=OSError('measurement refused')):
            event = self.failure('checkout').diagnostic
        self.assertIsNone(event['filesystem']['free_bytes'])
        self.assertIn('measurement refused', event['filesystem']['measurement_error'])

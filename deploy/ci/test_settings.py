"""Tests the settings checks deploy/lib.sh gives the operator scripts.

    python3 -m unittest discover --start-directory deploy/ci --pattern 'test_*.py'
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LIB = os.path.join(ROOT, 'deploy', 'lib.sh')
REQUIRED = {
    'POISE_DOMAIN': 'poise.example.com',
    'POISE_GITHUB_CLIENT_ID': 'id',
    'POISE_GITHUB_CLIENT_SECRET': 'secret',
    'POISE_ADMINS': 'root',
}


class LibTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.env_file = os.path.join(self.work.name, '.env')

    def write_env(self, **settings):
        with open(self.env_file, 'w') as file:
            file.writelines(f'{name}={value}\n' for name, value in settings.items())
        os.chmod(self.env_file, 0o600)

    def lib(self, script, *args, path=None):
        """Runs SCRIPT with deploy/lib.sh sourced and deploy/.env replaced by this test's file."""
        env = dict(os.environ)
        env.pop('COMPOSE_FILE', None)
        if path:
            env['PATH'] = f'{path}{os.pathsep}{env["PATH"]}'
        return subprocess.run(
            ['bash', '-c', f'. "$0"; env_file=$1; shift; {script}', LIB, self.env_file, *args],
            capture_output=True, text=True, env=env,
        )


class ListenAddressTest(LibTest):
    def test_accepts_one_address_and_port(self):
        for value in ['127.0.0.1:8080', '192.168.150.10:80', '10.0.0.1:65535', '[::1]:8080', '[fd00::5]:8080', '[FD00::5]:8080']:
            self.assertEqual(self.lib('listen_address "$1"', value).returncode, 0, value)

    def test_refuses_every_address_a_port_alone_and_malformed_values(self):
        for value in [
            '8080', ':8080', '127.0.0.1', '0.0.0.0:8080', '[::]:8080', '[::0]:8080', '[0:0:0:0:0:0:0:0]:8080',
            'localhost:8080', '::1:8080', '127.0.0.1:0', '127.0.0.1:08080', '127.0.0.1:65536', '256.0.0.1:8080',
            '127.0.0.01:8080', '127.0.0:8080', 'http://127.0.0.1:8080', '127.0.0.1:8080/', '',
        ]:
            self.assertEqual(self.lib('listen_address "$1"', value).returncode, 1, value)


class ComposeTest(LibTest):
    def setUp(self):
        super().setUp()
        # A docker that prints the Compose files it was given instead of running anything.
        self.bin = os.path.join(self.work.name, 'bin')
        os.mkdir(self.bin)
        docker = os.path.join(self.bin, 'docker')
        with open(docker, 'w') as file:
            file.write('#!/bin/sh\nprintf "%s %s\\n" "$PWD" "$COMPOSE_FILE"\n')
        os.chmod(docker, 0o755)

    def compose_files(self, script='compose config'):
        result = self.lib(script, path=self.bin)
        self.assertEqual(result.returncode, 0, result.stderr)
        directory, files = result.stdout.split()
        self.assertEqual(os.path.realpath(directory), os.path.realpath(os.path.join(ROOT, 'deploy')))
        return files

    def test_runs_the_bundled_stack_without_proxy_listen(self):
        self.write_env(**REQUIRED, POISE_ACME_EMAIL='ops@example.com')
        self.assertEqual(self.compose_files(), 'compose.yaml')

    def test_adds_the_proxy_file_with_proxy_listen(self):
        self.write_env(**REQUIRED, POISE_PROXY_LISTEN='127.0.0.1:8080')
        self.assertEqual(self.compose_files(), 'compose.yaml:compose.proxy.yaml')
        self.assertEqual(self.compose_files('COMPOSE_FILE=compose.yaml:ci/compose.yaml compose config'),
                         'compose.yaml:ci/compose.yaml:compose.proxy.yaml')


@unittest.skipUnless(sys.platform.startswith('linux'), 'deploy/lib.sh reads the file mode with GNU stat, as on the Linux server')
class RequireEnvFileTest(LibTest):
    def test_requires_the_acme_email_for_the_bundled_caddy(self):
        self.write_env(**REQUIRED)
        result = self.lib('require_env_file')
        self.assertEqual(result.returncode, 1)
        self.assertIn('sets no POISE_ACME_EMAIL;', result.stderr)

    def test_needs_no_acme_email_behind_another_proxy(self):
        self.write_env(**REQUIRED, POISE_PROXY_LISTEN='[::1]:8080')
        result = self.lib('require_env_file')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_refuses_a_proxy_listen_on_every_address(self):
        self.write_env(**REQUIRED, POISE_PROXY_LISTEN='0.0.0.0:8080')
        result = self.lib('require_env_file')
        self.assertEqual(result.returncode, 1)
        self.assertIn('POISE_PROXY_LISTEN in', result.stderr)
        self.assertIn('must be the one IP address and port your proxy reaches the gateway at', result.stderr)


class LintTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('shellcheck'), 'shellcheck is not installed')
    def test_operator_scripts_pass_shellcheck(self):
        scripts = sorted(glob.glob('deploy/*.sh', root_dir=ROOT) + glob.glob('deploy/ci/*.sh', root_dir=ROOT))
        result = subprocess.run(['shellcheck', '-x', *scripts], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()

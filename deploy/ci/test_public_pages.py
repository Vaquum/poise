"""The operator command streams reviewed content and restarts only after installation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class PublicPagesCommandTest(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        self.deploy = self.root / 'deploy'
        self.deploy.mkdir()
        for name in ['lib.sh', 'public-pages.sh']:
            shutil.copy(ROOT / 'deploy' / name, self.deploy / name)
        (self.deploy / '.env').write_text('POISE_DOMAIN=writing.example.org\nPOISE_GITHUB_CLIENT_ID=id\nPOISE_GITHUB_CLIENT_SECRET=secret\nPOISE_ADMINS=root\nPOISE_PROXY_LISTEN=127.0.0.1:8080\n')
        (self.deploy / '.env').chmod(0o600)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name, output in [('uname', 'Linux'), ('stat', '600')]:
            file = self.bin / name
            file.write_text(f'#!/bin/sh\nprintf "%s\\n" "{output}"\n')
            file.chmod(0o755)
        docker = self.bin / 'docker'
        docker.write_text('#!' + sys.executable + '\n' + '''import json, os, sys
from pathlib import Path
a=sys.argv[1:]
with open(os.environ['PUBLIC_TEST_LOG'],'a') as f: f.write(json.dumps(a)+'\\n')
if a[:1]==['version']: print('24.0.0')
elif a[:2]==['compose','version']: print('Docker Compose version v2.30.0')
elif a[:2]==['compose','exec']:
 if len(a)<3 or a[2]!='-T': sys.exit('unsupported exec option')
 Path(os.environ['PUBLIC_TEST_INPUT']).write_text(sys.stdin.read())
 if os.environ.get('PUBLIC_TEST_FAIL'): sys.exit(1)
elif a[:1]==['inspect']:
 if 'RestartCount' in ' '.join(a) and 'State.Status' not in ' '.join(a): print('0')
 elif 'State.Status' in ' '.join(a): print('running healthy 0')
 else: print('poise-edge')
''')
        docker.chmod(0o755)
        self.file = self.root / 'reviewed content.json'
        self.file.write_text('{"operator":"reviewed content"}')
        self.log = self.root / 'commands.jsonl'
        self.input = self.root / 'stdin.json'

    def command(self, action, fail=False):
        env = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'], 'PUBLIC_TEST_LOG': str(self.log), 'PUBLIC_TEST_INPUT': str(self.input)}
        if fail:
            env['PUBLIC_TEST_FAIL'] = '1'
        result = subprocess.run(['bash', str(self.deploy / 'public-pages.sh'), action, str(self.file)], env=env, capture_output=True, text=True)
        commands = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, commands

    def test_validation_is_not_publication(self):
        result, commands = self.command('validate')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.input.read_bytes(), self.file.read_bytes())
        self.assertIn(['compose', 'exec', '-T', 'gateway', 'node', 'dist/public-pages-cli.js', 'validate'], commands)
        self.assertFalse(any('restart' in c for c in commands))

    def test_explicit_publication_installs_then_restarts_the_same_gateway(self):
        result, commands = self.command('publish')
        self.assertEqual(result.returncode, 0, result.stderr)
        install = ['compose', 'exec', '-T', 'gateway', 'node', 'dist/public-pages-cli.js', 'install']
        self.assertIn(install, commands)
        self.assertGreater(commands.index(['compose', 'restart', 'gateway']), commands.index(install))
        self.assertEqual(self.input.read_bytes(), self.file.read_bytes())
        self.assertFalse(any('up' in c or 'build' in c for c in commands))

    def test_invalid_install_does_not_restart_or_hide_failure(self):
        result, commands = self.command('publish', fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('restart' in c for c in commands))

    def test_unknown_action_never_invokes_docker(self):
        result, commands = self.command('unknown')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, [])

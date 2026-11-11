"""Tests deploy/lib.sh's refresh_test_job_image: a deploy has Render build the
test jobs' image again only when what a job runs with changed since the commit
Render last built, with nothing on the host but Docker and git, and never stops
for Render.

    python3 -m unittest discover --start-directory deploy/ci --pattern 'test_*.py'
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LIB = os.path.join(ROOT, 'deploy', 'lib.sh')

# Docker as these calls use it: an image is there, and a container runs its
# entrypoint here, with stdin. Every command line is logged.
FAKE_DOCKER = f'''#!{sys.executable}
import json, os, sys
args = sys.argv[1:]
with open(os.environ['FAKE_DOCKER_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args[:2] == ['image', 'inspect']:
    sys.exit(0)
if args[:1] == ['run']:
    at = args.index('--entrypoint')
    os.execvp(args[at + 1], [args[at + 1], *args[at + 3:]])
sys.exit(1)
'''


class RenderServer(ThreadingHTTPServer):
    """Render's deploys of one cron job service, as far as these calls see them."""

    def __init__(self):
        super().__init__(('127.0.0.1', 0), Render)
        self.state = {'deploys': [], 'calls': [], 'fail': False, 'refuse': False}


class Render(BaseHTTPRequestHandler):
    server: RenderServer

    def answer(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        state = self.server.state
        state['calls'].append({'method': 'GET', 'path': self.path, 'authorization': self.headers.get('authorization')})
        if state['fail']:
            self.answer(503, {'message': 'unavailable'})
        else:
            self.answer(200, [{'cursor': 'c', 'deploy': deploy} for deploy in state['deploys']])

    def do_POST(self):
        state = self.server.state
        body = self.rfile.read(int(self.headers.get('content-length', 0))).decode()
        state['calls'].append({'method': 'POST', 'path': self.path, 'authorization': self.headers.get('authorization'), 'body': json.loads(body)})
        if 'commitId' in json.loads(body):
            # Render's own answer: a cron job builds only its branch's newest commit.
            self.answer(400, {'message': 'cannot deploy cron job service crn-test by commit reference ID'})
        elif state['fail'] or state['refuse']:
            self.answer(503, {'message': 'unavailable'})
        else:
            self.answer(201, {'id': 'dep-new', 'status': 'created'})

    def log_message(self, format, *args):
        pass


@unittest.skipUnless(shutil.which('node'), 'Node runs the calls, as it does in the workspace image')
class RefreshTestJobImageTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.bin = os.path.join(self.work.name, 'bin')
        os.mkdir(self.bin)
        docker = os.path.join(self.bin, 'docker')
        with open(docker, 'w') as file:
            file.write(FAKE_DOCKER)
        os.chmod(docker, 0o755)
        self.docker_log = os.path.join(self.work.name, 'docker.log')
        self.server = RenderServer()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.repo = os.path.join(self.work.name, 'repo')
        self.git('init', '-q', self.repo, cwd=self.work.name)
        self.commits = {}
        for name, path in [('first', 'deploy/runtime/Dockerfile'), ('poise', 'src/app.ts'),
                           ('caller', 'caller/agent_interface/run.py'), ('runtime', 'deploy/runtime/Dockerfile'),
                           ('lock', 'package-lock.json')]:
            os.makedirs(os.path.join(self.repo, os.path.dirname(path)), exist_ok=True)
            with open(os.path.join(self.repo, path), 'a') as file:
                file.write(f'{name}\n')
            self.git('add', '.')
            self.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', name)
            self.commits[name] = self.git('rev-parse', 'HEAD').stdout.strip()
        self.env_file = os.path.join(self.work.name, '.env')

    def git(self, *args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd or self.repo, capture_output=True, text=True, check=True)

    def refresh(self, sha, deploys, settings=True, fail=False, refuse=False):
        with open(self.env_file, 'w') as file:
            if settings:
                file.write('POISE_TEST_RENDER_API_KEY=render-secret\nPOISE_TEST_BASE_SERVICE=crn-test\n')
        self.server.state.update(deploys=deploys, calls=[], fail=fail, refuse=refuse)
        open(self.docker_log, 'w').close()
        env = {name: value for name, value in os.environ.items() if not name.startswith('POISE_')}
        env.update(PATH=f'{self.bin}{os.pathsep}{env["PATH"]}', FAKE_DOCKER_LOG=self.docker_log)
        api = f'http://127.0.0.1:{self.server.server_address[1]}'
        script = (f'set -euo pipefail; . "$0"; root={self.repo}; env_file={self.env_file}; render_api={api}; '
                  f'refresh_test_job_image {sha}; echo finished')
        result = subprocess.run(['bash', '-c', script, LIB], capture_output=True, text=True, env=env)
        return result, list(self.server.state['calls'])

    def built(self, commit, status='live'):
        return {'id': f'dep-{commit[:7]}', 'status': status, 'commit': {'id': commit}}

    def test_builds_nothing_when_what_jobs_run_with_is_unchanged(self):
        result, calls = self.refresh(self.commits['poise'], [self.built(self.commits['first'])])
        self.assertIn('finished', result.stdout, result.stderr)
        self.assertEqual([call['method'] for call in calls], ['GET'])

    def test_builds_the_branch_when_the_image_caller_or_the_lock_changed(self):
        for since, sha in [('poise', 'caller'), ('caller', 'runtime'), ('runtime', 'lock')]:
            with self.subTest(since=since, sha=sha):
                result, calls = self.refresh(self.commits[sha], [self.built(self.commits[since])])
                self.assertIn('finished', result.stdout, result.stderr)
                self.assertNotIn('warning', result.stderr)
                self.assertEqual(calls[-1]['method'], 'POST')
                self.assertEqual(calls[-1]['path'], '/services/crn-test/deploys')
                self.assertEqual(calls[-1]['body'], {})

    def test_goes_by_the_last_build_that_did_not_fail(self):
        _, calls = self.refresh(self.commits['poise'], [self.built('f' * 40, 'build_failed'), self.built(self.commits['first'])])
        self.assertEqual(len(calls), 1)
        _, calls = self.refresh(self.commits['poise'], [self.built(self.commits['poise'], 'build_in_progress'), self.built(self.commits['first'])])
        self.assertEqual(len(calls), 1)

    def test_builds_when_render_names_no_build_or_one_this_checkout_lacks(self):
        for deploys in ([], [self.built('a' * 40)]):
            with self.subTest(deploys=deploys):
                _, calls = self.refresh(self.commits['poise'], deploys)
                self.assertEqual(calls[-1]['body'], {})

    def test_asks_render_nothing_without_the_settings(self):
        result, calls = self.refresh(self.commits['poise'], [], settings=False)
        self.assertIn('finished', result.stdout)
        self.assertEqual(calls, [])

    def test_a_render_that_fails_only_warns_with_its_answer(self):
        result, calls = self.refresh(self.commits['poise'], [], fail=True)
        self.assertIn('finished', result.stdout)
        self.assertIn('Render answered with HTTP 503: {"message": "unavailable"}', result.stderr)
        self.assertIn('stays as it is', result.stderr)
        self.assertEqual(len(calls), 1)
        result, calls = self.refresh(self.commits['caller'], [self.built(self.commits['poise'])], refuse=True)
        self.assertIn('finished', result.stdout)
        self.assertIn('Render answered with HTTP 503: {"message": "unavailable"}', result.stderr)
        self.assertIn(f'jobs keep the image of {self.commits["poise"]}', result.stderr)
        self.assertEqual([call['method'] for call in calls], ['GET', 'POST'])

    def test_runs_with_docker_alone_and_the_key_never_on_a_command_line(self):
        _, calls = self.refresh(self.commits['caller'], [self.built(self.commits['poise'])])
        self.assertEqual([call['authorization'] for call in calls], ['Bearer render-secret'] * 2)
        with open(self.docker_log) as file:
            commands = [json.loads(line) for line in file]
        self.assertTrue(commands)
        self.assertTrue(all(command[:2] in (['image', 'inspect'], ['run', '--rm']) for command in commands))
        self.assertNotIn('render-secret', json.dumps(commands))

    def test_every_upgrade_asks_once_its_image_is_built(self):
        with open(os.path.join(ROOT, 'deploy', 'upgrade.sh')) as file:
            upgrade = file.read()
        self.assertIn('build_runtime_image "$image" "$sha"\nrefresh_test_job_image "$sha"\n', upgrade)


if __name__ == '__main__':
    unittest.main()

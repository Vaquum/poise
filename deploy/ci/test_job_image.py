"""Tests deploy/lib.sh's refresh_test_job_image: a deploy has Render build the
test jobs' image again only when what a job runs with changed since the commit
Render last built, and never stops for Render.

    python3 -m unittest discover --start-directory deploy/ci --pattern 'test_*.py'
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LIB = os.path.join(ROOT, 'deploy', 'lib.sh')

# Render's API as curl reaches it: logs each call, with the headers it read from
# files, and answers from FAKE_RENDER.
FAKE_CURL = f'''#!{sys.executable}
import json, os, sys
args, headers, url, data = sys.argv[1:], [], None, None
index = 0
while index < len(args):
    arg = args[index]
    if arg == '--header':
        value = args[index + 1]
        headers.append(open(value[1:]).read().strip() if value.startswith('@') else value)
        index += 2
    elif arg == '--data':
        data = args[index + 1]
        index += 2
    elif arg == '--max-time':
        index += 2
    elif arg.startswith('-'):
        index += 1
    else:
        url = arg
        index += 1
render = json.load(open(os.environ['FAKE_RENDER']))
render['calls'].append({{'argv': sys.argv[1:], 'headers': headers, 'url': url, 'data': data}})
json.dump(render, open(os.environ['FAKE_RENDER'], 'w'))
if render.get('fail'):
    sys.stderr.write('curl: (22) The requested URL returned error: 503\\n')
    sys.exit(22)
if data is None:
    print(json.dumps([{{'cursor': 'c', 'deploy': deploy}} for deploy in render['deploys']]))
else:
    print(json.dumps({{'id': 'dep-new', 'status': 'created'}}))
'''


class RefreshTestJobImageTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.bin = os.path.join(self.work.name, 'bin')
        os.mkdir(self.bin)
        curl = os.path.join(self.bin, 'curl')
        with open(curl, 'w') as file:
            file.write(FAKE_CURL)
        os.chmod(curl, 0o755)
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
        self.render = os.path.join(self.work.name, 'render.json')

    def git(self, *args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd or self.repo, capture_output=True, text=True, check=True)

    def refresh(self, sha, deploys, settings=True, fail=False):
        with open(self.env_file, 'w') as file:
            if settings:
                file.write('POISE_TEST_RENDER_API_KEY=render-secret\nPOISE_TEST_BASE_SERVICE=crn-test\n')
        with open(self.render, 'w') as file:
            json.dump({'deploys': deploys, 'calls': [], 'fail': fail}, file)
        env = {name: value for name, value in os.environ.items() if not name.startswith('POISE_')}
        env.update(PATH=f'{self.bin}{os.pathsep}{env["PATH"]}', FAKE_RENDER=self.render)
        script = f'set -euo pipefail; . "$0"; root={self.repo}; env_file={self.env_file}; refresh_test_job_image {sha}; echo finished'
        result = subprocess.run(['bash', '-c', script, LIB], capture_output=True, text=True, env=env)
        with open(self.render) as file:
            return result, json.load(file)['calls']

    def built(self, commit, status='live'):
        return {'id': f'dep-{commit[:7]}', 'status': status, 'commit': {'id': commit}}

    def test_builds_nothing_when_what_jobs_run_with_is_unchanged(self):
        result, calls = self.refresh(self.commits['poise'], [self.built(self.commits['first'])])
        self.assertIn('finished', result.stdout)
        self.assertEqual([call['data'] for call in calls], [None])

    def test_builds_at_the_deployed_commit_when_the_image_caller_or_the_lock_changed(self):
        for since, sha in [('poise', 'caller'), ('caller', 'runtime'), ('runtime', 'lock')]:
            with self.subTest(since=since, sha=sha):
                result, calls = self.refresh(self.commits[sha], [self.built(self.commits[since])])
                self.assertIn('finished', result.stdout)
                self.assertEqual(calls[-1]['url'], 'https://api.render.com/v1/services/crn-test/deploys')
                self.assertEqual(json.loads(calls[-1]['data']), {'commitId': self.commits[sha]})

    def test_goes_by_the_last_build_that_did_not_fail(self):
        deploys = [self.built('f' * 40, 'build_failed'), self.built(self.commits['first'])]
        _, calls = self.refresh(self.commits['poise'], deploys)
        self.assertEqual(len(calls), 1)
        _, calls = self.refresh(self.commits['poise'], [self.built(self.commits['poise'], 'build_in_progress'), self.built(self.commits['first'])])
        self.assertEqual(len(calls), 1)

    def test_builds_when_render_names_no_build_or_one_this_checkout_lacks(self):
        for deploys in ([], [self.built('a' * 40)]):
            with self.subTest(deploys=deploys):
                _, calls = self.refresh(self.commits['poise'], deploys)
                self.assertEqual(json.loads(calls[-1]['data']), {'commitId': self.commits['poise']})

    def test_asks_render_nothing_without_the_settings(self):
        result, calls = self.refresh(self.commits['poise'], [], settings=False)
        self.assertIn('finished', result.stdout)
        self.assertEqual(calls, [])

    def test_a_render_that_fails_only_warns(self):
        result, calls = self.refresh(self.commits['poise'], [], fail=True)
        self.assertIn('finished', result.stdout)
        self.assertIn('stays as it is', result.stderr)
        self.assertEqual(len(calls), 1)

    def test_the_key_goes_in_a_header_file_never_on_the_command_line(self):
        _, calls = self.refresh(self.commits['caller'], [self.built(self.commits['poise'])])
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertIn('Authorization: Bearer render-secret', call['headers'])
            self.assertNotIn('render-secret', ' '.join(call['argv']))

    def test_every_upgrade_asks_once_its_image_is_built(self):
        with open(os.path.join(ROOT, 'deploy', 'upgrade.sh')) as file:
            upgrade = file.read()
        self.assertIn('build_runtime_image "$image" "$sha"\nrefresh_test_job_image "$sha"\n', upgrade)


if __name__ == '__main__':
    unittest.main()

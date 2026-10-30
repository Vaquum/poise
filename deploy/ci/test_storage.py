"""Tests what deploy/lib.sh's prune_docker_storage removes after a deploy.

    python3 -m unittest discover --start-directory deploy/ci --pattern 'test_*.py'
"""

import json
import os
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LIB = os.path.join(ROOT, 'deploy', 'lib.sh')

# A docker that answers from a JSON state file and records what it was asked to do.
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
state_path = os.environ['FAKE_DOCKER_STATE']
state = json.load(open(state_path))
args = sys.argv[1:]

def save():
    json.dump(state, open(state_path, 'w'))

def image(ref):
    name = ref if ':' in ref else ref + ':latest'
    for entry in state['images']:
        if name in entry['tags'] or ref == entry['id']:
            return entry
    return None

def fmt(args):
    return args[args.index('--format') + 1] if '--format' in args else ''

state['calls'].append(' '.join(args))
save()
if args[:2] == ['image', 'inspect']:
    entry = image(args[-1])
    if entry is None:
        sys.exit(1)
    print(entry['id'] if fmt(args) == '{{.Id}}' else f"{entry['created']} {entry['id']}")
elif args[:2] == ['image', 'ls']:
    repo = args[2]
    for entry in sorted(state['images'], key=lambda e: e['created'], reverse=True):
        for tag in entry['tags']:
            if tag.split(':')[0] == repo:
                print(tag.split(':', 1)[1])
elif args[:1] == ['ps']:
    for index, _ in enumerate(state['containers']):
        print(f'c{index}')
elif args[:1] == ['inspect']:
    for name in args[3:]:
        print(state['containers'][int(name[1:])])
elif args[:2] == ['image', 'rm']:
    entry = image(args[2])
    if entry is None or entry['id'] in state['containers']:
        sys.exit(1)
    entry['tags'].remove(args[2])
    save()
elif args[:2] == ['image', 'prune'] or args[:2] == ['builder', 'prune']:
    if '--help' in args:
        print(state.get('builder_help', '--max-used-space bytes'))
else:
    sys.exit(2)
'''


class PruneTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.bin = os.path.join(self.work.name, 'bin')
        os.mkdir(self.bin)
        docker = os.path.join(self.bin, 'docker')
        with open(docker, 'w') as file:
            file.write(FAKE_DOCKER)
        os.chmod(docker, 0o755)
        self.state = os.path.join(self.work.name, 'state.json')

    def prune(self, images, containers, builder_help=None):
        state = {'images': images, 'containers': containers, 'calls': []}
        if builder_help is not None:
            state['builder_help'] = builder_help
        with open(self.state, 'w') as file:
            json.dump(state, file)
        env = {**os.environ, 'PATH': f'{self.bin}{os.pathsep}{os.environ["PATH"]}', 'FAKE_DOCKER_STATE': self.state}
        result = subprocess.run(['bash', '-c', '. "$0"; set -euo pipefail; prune_docker_storage poise-runtime:latest', LIB],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.state) as file:
            return json.load(file), result

    @staticmethod
    def sha(n):
        return f'{n:040x}'

    def build(self, n, *extra):
        return {'id': f'sha256:{n}', 'created': f'2026-10-0{n}T00:00:00Z', 'tags': [f'poise-runtime:{self.sha(n)}', *extra]}

    def test_keeps_the_current_and_previous_builds_and_any_image_a_container_uses(self):
        images = [self.build(1), self.build(2), self.build(3), self.build(4), self.build(5, 'poise-runtime:latest')]
        state, result = self.prune(images, ['sha256:2'])
        left = {tag for entry in state['images'] for tag in entry['tags']}
        self.assertEqual(left, {
            'poise-runtime:latest', f'poise-runtime:{self.sha(5)}', f'poise-runtime:{self.sha(4)}', f'poise-runtime:{self.sha(2)}',
        })
        self.assertIn('Removed 2 workspace images of earlier commits.', result.stdout)

    def test_removes_untagged_poise_images_and_caps_the_build_cache(self):
        state, result = self.prune([self.build(1, 'poise-runtime:latest')], [])
        self.assertIn('image prune --force --filter label=poise.image', state['calls'])
        self.assertIn('builder prune --force --max-used-space 5GB', state['calls'])
        self.assertIn("Docker's build cache keeps at most 5GB.", result.stdout)

    def test_uses_the_older_build_cache_flag_on_an_older_docker(self):
        state, _ = self.prune([self.build(1, 'poise-runtime:latest')], [], builder_help='--keep-storage bytes')
        self.assertIn('builder prune --force --keep-storage 5GB', state['calls'])


if __name__ == '__main__':
    unittest.main()

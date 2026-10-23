"""Tests deploy/lib.sh's workspace verification: a deploy reports success only
once every workspace serves the deployed commit, else pending with its age.

    python3 -m unittest discover --start-directory deploy/ci --pattern 'test_*.py'
"""

import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
LIB = os.path.join(ROOT, 'deploy', 'lib.sh')

OLD = '353d13078c523c4155d9d28097b98350ed59436d'
NEW = 'c04cca1bc8ebcb1e931c84027296bcff0e3cf6f0'
IMAGE_ID = 'sha256:aaaabbbbcccc'
OLD_IMAGE_ID = 'sha256:ddddffff0000'

# A docker that answers from a JSON state file. Containers print their canned
# inspect line; exec serves the next health answer for the container (the last
# one repeats), and a container without one is unreachable.
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
state_path = os.environ['FAKE_DOCKER_STATE']
state = json.load(open(state_path))
args = sys.argv[1:]

def save():
    json.dump(state, open(state_path, 'w'))

state['calls'].append(' '.join(args))
save()
if args[:2] == ['image', 'inspect']:
    if not state.get('image_ok', True):
        sys.exit(1)
    print(state['image_id'])
elif args[:1] == ['ps']:
    if not state.get('ps_ok', True):
        sys.exit(1)
    inventories = state.get('inventories')
    if inventories:
        seen = state.get('inventories_seen', 0)
        state['containers'] = inventories[min(seen, len(inventories) - 1)]
        state['inventories_seen'] = seen + 1
        save()
    for index, line in enumerate(state['containers']):
        if '--format' in args:
            print(f'c{index} {line.split()[0]}')
        else:
            print(f'c{index}')
elif args[:1] == ['inspect']:
    seen = state.get('inspect_seen', 0)
    state['inspect_seen'] = seen + 1
    save()
    if seen < state.get('inspect_fail_times', 0):
        sys.exit(1)
    missing = state.get('inspect_missing', []) if seen < state.get('inspect_missing_times', 0) else []
    for name in args[3:]:
        if int(name[1:]) not in missing:
            print(state['containers'][int(name[1:])])
    if missing:
        sys.exit(1)
elif args[:1] == ['exec']:
    answers = state['health'].get(args[1], [])
    seen = state.setdefault('execs', {}).get(args[1], 0)
    state['execs'][args[1]] = seen + 1
    save()
    if not answers:
        sys.exit(1)
    print(answers[min(seen, len(answers) - 1)])
elif args[:1] == ['build']:
    state['containers'] = state['after_build']
    save()
elif args[:2] == ['volume', 'inspect']:
    sys.exit(0 if args[-1] in state.get('volumes', []) else 1)
elif args[:2] == ['volume', 'create']:
    state.setdefault('volumes', []).append(args[-1])
    save()
elif args[:2] == ['volume', 'rm']:
    state['volumes'] = [volume for volume in state.get('volumes', []) if volume not in args[2:]]
    save()
elif args[:1] == ['run']:
    sys.exit(0 if state.get('restore_ok', True) else 1)
else:
    sys.exit(2)
'''


def health(active, desired=None, installed=None, since=None, old=False):
    """A workspace health answer. An old server predates desired/installed/since tracking."""
    body = {'ok': True, 'mode': 'service', 'version': active, 'activeChatTurns': 4,
            'runningCallerCalls': 2, 'backgroundWork': 14, 'idle': False, 'draining': False,
            'release': active, 'switching': desired}
    if not old:
        body.update(desiredRelease=desired if desired is not None else active,
                    installedRelease=installed, pendingSince=since)
    return json.dumps(body)


class LibTest(unittest.TestCase):
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

    def lib(self, script, state=None):
        if state is not None:
            with open(self.state, 'w') as file:
                json.dump({**state, 'calls': []}, file)
        env = {name: value for name, value in os.environ.items() if not name.startswith(('POISE_', 'COMPOSE_'))}
        env.update(PATH=f'{self.bin}{os.pathsep}{env["PATH"]}', FAKE_DOCKER_STATE=self.state)
        return subprocess.run(['bash', '-c', f'. "$0"; workspace_proof_file="$FAKE_DOCKER_STATE.proof"; {script}', LIB],
                              capture_output=True, text=True, env=env)

    def calls(self):
        with open(self.state) as file:
            return json.load(file)['calls']


class HealthFieldTest(LibTest):
    def field(self, key, body):
        result = self.lib(f'health_field \'{body}\' {key}')
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_reads_string_values_and_empty_for_null_or_absent(self):
        body = health(OLD, desired=NEW, installed=NEW, since='2026-10-22T18:00:00.000Z')
        self.assertEqual(self.field('release', body), OLD)
        self.assertEqual(self.field('desiredRelease', body), NEW)
        self.assertEqual(self.field('installedRelease', body), NEW)
        self.assertEqual(self.field('pendingSince', body), '2026-10-22T18:00:00.000Z')
        self.assertEqual(self.field('switching', health(OLD)), '')
        self.assertEqual(self.field('pendingSince', health(OLD, old=True)), '')


class FormatAgeTest(LibTest):
    def test_reads_like_a_wait(self):
        for seconds, reads in [(0, '0s'), (45, '45s'), (65, '1m05s'), (3599, '59m59s'),
                               (3600, '1h00m'), (7380, '2h03m'), (90000, '1d01h')]:
            result = self.lib(f'format_age {seconds}')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, reads, seconds)


@unittest.skipUnless(sys.platform.startswith('linux'), 'pending_age reads ISO times with GNU date, as on the Linux server')
class PendingAgeTest(LibTest):
    def age(self, since):
        result = self.lib(f'pending_age \'{since}\'')
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_counts_from_the_iso_time(self):
        since = (datetime.now(timezone.utc) - timedelta(hours=2, minutes=30)).isoformat().replace('+00:00', 'Z')
        self.assertRegex(self.age(since), r'^2h3\dm$')

    def test_future_is_zero_and_unreadable_is_unknown(self):
        since = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace('+00:00', 'Z')
        self.assertEqual(self.age(since), '0s')
        self.assertEqual(self.age(''), 'unknown')
        self.assertEqual(self.age('not a time'), 'unknown')


class VerifyTest(LibTest):
    def verify(self, state, sha=NEW, timeout=0, expire_after_poll=False):
        clock = 'sleep() { SECONDS=$((SECONDS + verify_timeout_seconds)); }; ' if expire_after_poll else ''
        script = (clock + f'verify_timeout_seconds={timeout}; verify_poll_seconds=0; '
                  'expected=$(workspace_handles) || exit 1; '
                  f'verify_workspaces \'{sha}\' poise-runtime:latest "$expected"')
        return self.lib(script, {'image_id': IMAGE_ID, 'containers': [], 'health': {}, **state})

    def test_skips_a_development_build_and_an_empty_server(self):
        result = self.verify({}, sha='')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('skipping workspace verification', result.stdout)
        result = self.verify({})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('No workspace exists yet.', result.stdout)

    def test_reports_success_once_every_workspace_serves_the_commit(self):
        result = self.verify({
            'containers': [f'alice {IMAGE_ID} true /poise-ws-alice', f'bob {IMAGE_ID} false /poise-ws-bob'],
            'health': {'poise-ws-alice': [health(NEW)]},
        })
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'Every workspace serves {NEW}: alice bob (stopped).', result.stdout)

    def test_waits_for_a_switch_that_lands(self):
        result = self.verify({
            'containers': [f'alice {IMAGE_ID} true /poise-ws-alice'],
            'health': {'poise-ws-alice': [health(OLD, desired=NEW, installed=NEW), health(NEW)]},
        }, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'Every workspace serves {NEW}: alice.', result.stdout)
        execs = [call for call in self.calls() if call.startswith('exec ')]
        self.assertGreaterEqual(len(execs), 2)

    def test_missing_workspace_before_first_poll_cannot_hide_behind_a_healthy_one(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {OLD_IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'inventories': [[alice, bob], [alice]],
                              'health': {'poise-ws-alice': [health(NEW)]}})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('bob: missing (waiting for its replacement)', result.stderr)
        self.assertNotIn('Every workspace serves', result.stdout)

    def test_workspace_seen_after_snapshot_remains_required_when_it_disappears(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {OLD_IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'inventories': [[alice], [alice, bob], [alice]],
                              'health': {'poise-ws-alice': [health(NEW)], 'poise-ws-bob': [health(OLD)]}},
                             timeout=30, expire_after_poll=True)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('bob: missing (waiting for its replacement)', result.stderr)
        self.assertNotIn('Every workspace serves', result.stdout)

    def test_remove_create_gap_waits_and_recovers_only_after_replacement_is_verified(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {OLD_IMAGE_ID} true /poise-ws-bob'
        replacement = f'bob {IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'inventories': [[alice, bob], [alice], [alice, replacement]],
                              'health': {'poise-ws-alice': [health(NEW)], 'poise-ws-bob': [health(NEW)]}}, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'Every workspace serves {NEW}: alice bob.', result.stdout)
        self.assertTrue(any(call.startswith('exec poise-ws-bob ') for call in self.calls()))

    def test_container_removed_between_ps_and_inspect_retries_instead_of_aborting(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'containers': [alice, bob],
                              'health': {'poise-ws-alice': [health(NEW)], 'poise-ws-bob': [health(NEW)]},
                              'inspect_missing': [1], 'inspect_missing_times': 1}, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'Every workspace serves {NEW}: alice bob.', result.stdout)
        inspects = [call for call in self.calls() if call.startswith('inspect ')]
        self.assertGreaterEqual(len(inspects), 2)

    def test_uninspectable_containers_report_missing_until_the_timeout(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        result = self.verify({'containers': [alice],
                              'health': {'poise-ws-alice': [health(NEW)]},
                              'inspect_fail_times': 99})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('alice: missing (waiting for its replacement)', result.stderr)
        self.assertNotIn('cannot inspect', result.stderr)

    def test_new_workspace_after_empty_snapshot_stays_pending_when_inspection_fails(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        result = self.verify({'inventories': [[], [alice]], 'inspect_fail_times': 99})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('workspace inventory: incomplete', result.stderr)
        self.assertNotIn('No workspace exists yet.', result.stdout)
        self.assertNotIn('Every workspace serves', result.stdout)
        self.assertTrue(os.path.exists(self.state + '.proof'))

    def test_partial_inspection_cannot_skip_a_new_workspace_beside_a_healthy_one(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'inventories': [[alice], [alice, bob]],
                              'health': {'poise-ws-alice': [health(NEW)], 'poise-ws-bob': [health(NEW)]},
                              'inspect_missing': [1], 'inspect_missing_times': 99})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('workspace inventory: incomplete', result.stderr)
        self.assertNotIn('Every workspace serves', result.stdout)
        with open(self.state + '.proof') as file:
            self.assertIn('alice', file.read())

    def test_new_workspace_after_empty_snapshot_recovers_after_complete_inspection(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        result = self.verify({'inventories': [[], [alice]], 'inspect_fail_times': 1,
                              'health': {'poise-ws-alice': [health(NEW)]}}, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'Every workspace serves {NEW}: alice.', result.stdout)
        self.assertGreaterEqual(sum(call.startswith('inspect ') for call in self.calls()), 2)

    def test_uninspectable_new_workspace_remains_required_after_the_next_empty_poll(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        result = self.verify({'inventories': [[], [alice], []], 'inspect_fail_times': 99},
                             timeout=30, expire_after_poll=True)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('alice: missing (waiting for its replacement)', result.stderr)
        self.assertNotIn('No workspace exists yet.', result.stdout)
        self.assertNotIn('Every workspace serves', result.stdout)
        with open(self.state + '.proof') as file:
            self.assertIn('alice', file.read())

    def test_uninspectable_new_workspace_cannot_disappear_behind_a_healthy_one_next_poll(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'inventories': [[alice], [alice, bob], [alice]],
                              'health': {'poise-ws-alice': [health(NEW)]},
                              'inspect_missing': [1], 'inspect_missing_times': 1},
                             timeout=30, expire_after_poll=True)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('bob: missing (waiting for its replacement)', result.stderr)
        self.assertNotIn('Every workspace serves', result.stdout)
        with open(self.state + '.proof') as file:
            self.assertIn('bob', file.read())
        result = self.verify({'containers': [alice], 'health': {'poise-ws-alice': [health(NEW)]}})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('bob: missing (waiting for its replacement)', result.stderr)

    def test_uninspectable_new_workspace_recovers_after_a_replacement_gap(self):
        alice = f'alice {OLD_IMAGE_ID} true /poise-ws-alice'
        replacement = f'alice {IMAGE_ID} true /poise-ws-alice'
        result = self.verify({'inventories': [[], [alice], [], [replacement]], 'inspect_fail_times': 1,
                              'health': {'poise-ws-alice': [health(NEW)]}}, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'Every workspace serves {NEW}: alice.', result.stdout)
        self.assertFalse(os.path.exists(self.state + '.proof'))

    def test_all_workspaces_missing_before_first_poll_remain_pending(self):
        result = self.verify({'inventories': [[f'alice {IMAGE_ID} true /poise-ws-alice',
                                                f'bob {IMAGE_ID} true /poise-ws-bob'], []]})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('alice: missing', result.stderr)
        self.assertIn('bob: missing', result.stderr)
        self.assertNotIn('No workspace exists yet.', result.stdout)
        self.assertNotIn('Every workspace serves', result.stdout)

    def test_failed_attempt_retains_private_obligations_until_a_verified_retry(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'inventories': [[alice, bob], [alice]],
                              'health': {'poise-ws-alice': [health(NEW)]}})
        self.assertEqual(result.returncode, 1, result.stdout)
        proof = self.state + '.proof'
        self.assertEqual(os.stat(proof).st_mode & 0o777, 0o600)
        # Bob is already absent before the retry's initial snapshot.
        result = self.verify({'containers': [alice], 'health': {'poise-ws-alice': [health(NEW)]}})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('bob: missing', result.stderr)
        result = self.verify({'containers': [alice, bob],
                              'health': {'poise-ws-alice': [health(NEW)], 'poise-ws-bob': [health(NEW)]}})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(os.path.exists(proof))

    def test_newly_observed_workspace_survives_a_failed_poll_into_the_next_attempt(self):
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {OLD_IMAGE_ID} true /poise-ws-bob'
        result = self.verify({'inventories': [[alice], [alice, bob]],
                              'health': {'poise-ws-alice': [health(NEW)], 'poise-ws-bob': [health(OLD)]}})
        self.assertEqual(result.returncode, 1, result.stdout)
        result = self.verify({'containers': [alice], 'health': {'poise-ws-alice': [health(NEW)]}})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('bob: missing', result.stderr)

    def test_development_build_does_not_clear_an_unproved_workspace(self):
        proof = self.state + '.proof'
        with open(proof, 'w') as file:
            file.write('bob ')
        result = self.verify({}, sha='')
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(proof) as file:
            self.assertEqual(file.read().strip(), 'bob')

    def test_corrupt_or_nonregular_pending_inventory_fails_loud(self):
        proof = self.state + '.proof'
        with open(proof, 'w') as file:
            file.write('bob --all')
        result = self.verify({})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('invalid workspace handle', result.stderr)
        self.assertEqual(self.calls(), [])
        os.unlink(proof)
        os.mkdir(proof)
        result = self.verify({})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('regular file', result.stderr)
        self.assertEqual(self.calls(), [])
        os.rmdir(proof)
        os.symlink(self.state, proof)
        result = self.verify({})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('symbolic link', result.stderr)
        self.assertEqual(self.calls(), [])

    def test_operator_scripts_capture_workspaces_before_build_can_remove_them(self):
        # Execute the real entrypoints. Building retags the image, which can
        # trigger even the old gateway before compose replaces that gateway.
        directory = os.path.join(self.work.name, 'operator')
        os.mkdir(directory)
        with open(os.path.join(directory, 'lib.sh'), 'w') as file:
            file.write(f'. {shlex.quote(LIB)}\n'
                       'workspace_proof_file="$FAKE_DOCKER_STATE.proof"\n'
                       'require_linux() { :; }\nrequire_docker() { :; }\n'
                       'require_env_file() { require_free_ports() { :; }; }\n'
                       'env_value() { :; }\nproxy_listen() { :; }\n'
                       f'source_sha() {{ printf %s {NEW}; }}\n'
                       'runtime_image() { printf %s poise-runtime:latest; }\n'
                       'build_runtime_image() { docker build; }\n'
                       'compose() { :; }\nwait_for_gateway() { :; }\n'
                       'check_gateway_networks() { :; }\nprune_docker_storage() { :; }\n'
                       'verify_timeout_seconds=0\nverify_poll_seconds=0\n')
        alice = f'alice {IMAGE_ID} true /poise-ws-alice'
        bob = f'bob {OLD_IMAGE_ID} true /poise-ws-bob'
        for name, args in [('install.sh', []), ('upgrade.sh', ['--no-pull'])]:
            with self.subTest(script=name):
                proof = self.state + '.proof'
                if os.path.exists(proof):
                    os.unlink(proof)
                target = os.path.join(directory, name)
                with open(os.path.join(ROOT, 'deploy', name)) as source, open(target, 'w') as output:
                    output.write(source.read())
                with open(self.state, 'w') as file:
                    json.dump({'image_id': IMAGE_ID, 'containers': [alice, bob], 'after_build': [alice],
                               'health': {'poise-ws-alice': [health(NEW)]}, 'calls': []}, file)
                env = {key: value for key, value in os.environ.items() if not key.startswith(('POISE_', 'COMPOSE_'))}
                env.update(PATH=f'{self.bin}{os.pathsep}{env["PATH"]}', FAKE_DOCKER_STATE=self.state)
                result = subprocess.run(['bash', target, *args], capture_output=True, text=True, env=env)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn('bob: missing', result.stderr)
                self.assertNotIn('Every workspace serves', result.stdout)

    def test_reports_a_stuck_switch_as_pending_instead_of_success(self):
        result = self.verify({
            'containers': [f'alice {IMAGE_ID} true /poise-ws-alice'],
            'health': {'poise-ws-alice': [health(OLD, desired=NEW, installed=NEW)]},
        })
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'the deploy of {NEW} is still pending after 0s', result.stderr)
        self.assertIn(f'alice: pending {NEW} (active {OLD}, pending unknown)', result.stderr)
        self.assertNotIn('not installed', result.stderr)

    def test_names_a_desired_release_that_is_not_installed(self):
        result = self.verify({
            'containers': [f'alice {IMAGE_ID} true /poise-ws-alice'],
            'health': {'poise-ws-alice': [health(OLD, desired=NEW, installed=None)]},
        })
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(f'alice: pending {NEW} (active {OLD}, not installed, pending unknown)', result.stderr)

    def test_reads_an_old_server_without_pending_tracking(self):
        result = self.verify({
            'containers': [f'alice {IMAGE_ID} true /poise-ws-alice'],
            'health': {'poise-ws-alice': [health(OLD, desired=NEW, old=True)]},
        })
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(f'alice: pending {NEW} (active {OLD}, pending unknown)', result.stderr)
        self.assertNotIn('not installed', result.stderr)

    def test_reports_unreachable_and_stopped_old_workspaces(self):
        result = self.verify({
            'containers': [f'alice {IMAGE_ID} true /poise-ws-alice', f'bob {OLD_IMAGE_ID} false /poise-ws-bob'],
            'health': {},
        })
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('alice: unreachable (its health check did not answer)', result.stderr)
        self.assertIn('bob: stopped, still on an older image', result.stderr)

    def test_fails_loud_when_the_proof_cannot_be_read(self):
        result = self.verify({'image_ok': False})
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot read the workspace image', result.stderr)
        result = self.verify({'ps_ok': False})
        self.assertEqual(result.returncode, 1)
        self.assertIn('cannot list the managed workspaces', result.stderr)


class RestoreProofTest(LibTest):
    def restore(self, succeeds, unclearable_proof=False):
        directory = os.path.join(self.work.name, 'operator')
        os.mkdir(directory)
        with open(os.path.join(directory, 'lib.sh'), 'w') as file:
            file.write(f'. {shlex.quote(LIB)}\n'
                       'workspace_proof_file="$FAKE_DOCKER_STATE.proof"\n'
                       'require_linux() { :; }\nrequire_docker() { :; }\nrequire_env_file() { :; }\n'
                       'runtime_image() { printf %s poise-runtime:latest; }\n')
        target = os.path.join(directory, 'restore.sh')
        with open(os.path.join(ROOT, 'deploy/restore.sh')) as source, open(target, 'w') as output:
            output.write(source.read())
        backup = os.path.join(self.work.name, 'backup')
        os.mkdir(backup)
        archive = 'poise-home-alice.tar.gz'
        payload = b'fixture volume archive consumed by fake Docker'
        with open(os.path.join(backup, archive), 'wb') as file:
            file.write(payload)
        with open(os.path.join(backup, 'SHA256SUMS'), 'w') as file:
            file.write(f'{hashlib.sha256(payload).hexdigest()}  {archive}\n')
        # macOS calls its real SHA-256 checker shasum; the deployment uses
        # GNU sha256sum on Linux. Both check the actual fixture bytes.
        if not shutil.which('sha256sum'):
            with open(os.path.join(self.bin, 'sha256sum'), 'w') as file:
                file.write(f'#!/bin/sh\nexec {shlex.quote(shutil.which("shasum"))} -a 256 "$@"\n')
            os.chmod(os.path.join(self.bin, 'sha256sum'), 0o755)
        proof = self.state + '.proof'
        if unclearable_proof:
            os.mkdir(proof)
            proof = os.path.join(proof, 'pending')
        with open(proof, 'w') as file:
            file.write('bob ')
        with open(self.state, 'w') as file:
            json.dump({'image_id': IMAGE_ID, 'containers': [], 'health': {},
                       'restore_ok': succeeds, 'calls': []}, file)
        env = {key: value for key, value in os.environ.items() if not key.startswith(('POISE_', 'COMPOSE_'))}
        env.update(PATH=f'{self.bin}{os.pathsep}{env["PATH"]}', FAKE_DOCKER_STATE=self.state)
        return subprocess.run(['bash', target, backup], capture_output=True, text=True, env=env)

    def test_completed_restore_clears_old_host_proof_and_keeps_lazy_container_creation(self):
        result = self.restore(True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(os.path.exists(self.state + '.proof'))
        result = self.lib(f'expected=$(workspace_handles); verify_workspaces {NEW} poise-runtime:latest "$expected"')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('No workspace exists yet.', result.stdout)

    def test_failed_archive_restore_retains_previous_pending_proof(self):
        result = self.restore(False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        with open(self.state + '.proof') as file:
            self.assertEqual(file.read(), 'bob ')

    def test_unclearable_proof_rolls_back_restored_volumes_and_retains_proof(self):
        result = self.restore(True, unclearable_proof=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('cannot clear the completed workspace proof', result.stderr)
        with open(os.path.join(self.state + '.proof', 'pending')) as file:
            self.assertEqual(file.read(), 'bob ')
        with open(self.state) as file:
            state = json.load(file)
        self.assertEqual(state['volumes'], [])
        self.assertTrue(any(call.startswith('volume rm ') for call in state['calls']))


class RollbackProofTest(LibTest):
    def test_pending_proof_keeps_an_older_checkout_clean_for_an_exact_sha_rollback(self):
        checkout = os.path.join(self.work.name, 'rollback')
        directory = os.path.join(checkout, 'deploy')
        os.makedirs(directory)
        library = os.path.join(directory, 'lib.sh')
        shutil.copyfile(LIB, library)
        # This ignore rule predates deployment verification. Rolling back
        # must not turn its retained private proof into an untracked source edit.
        with open(os.path.join(checkout, '.gitignore'), 'w') as file:
            file.write('.env\n.env.*\n!.env.example\n')
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('POISE_', 'COMPOSE_', 'GIT_'))}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
                   GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
                   GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
                   PATH=f'{self.bin}{os.pathsep}{env["PATH"]}', FAKE_DOCKER_STATE=self.state)
        for args in [('init', '--quiet'), ('add', '.'), ('commit', '--quiet', '-m', 'chore: fixture rollback target')]:
            subprocess.run(['git', '-C', checkout, *args], env=env, check=True, capture_output=True)
        target = subprocess.check_output(['git', '-C', checkout, 'rev-parse', 'HEAD'], env=env, text=True).strip()
        with open(self.state, 'w') as file:
            json.dump({'containers': [f'bob {OLD_IMAGE_ID} true /poise-ws-bob'], 'calls': []}, file)
        result = subprocess.run(['bash', '-c', '. "$0"; workspace_handles >/dev/null; source_sha', library],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, target, result.stderr)


@unittest.skipUnless(sys.platform.startswith('linux'), 'pending ages read ISO times with GNU date, as on the Linux server')
class VerifyAgeTest(LibTest):
    def test_reports_how_long_the_switch_has_been_pending(self):
        since = (datetime.now(timezone.utc) - timedelta(hours=2, minutes=30)).isoformat().replace('+00:00', 'Z')
        script = ('verify_timeout_seconds=0; verify_poll_seconds=0; '
                  'expected=$(workspace_handles) || exit 1; '
                  f'verify_workspaces \'{NEW}\' poise-runtime:latest "$expected"')
        result = self.lib(script, {'image_id': IMAGE_ID,
                                   'containers': [f'alice {IMAGE_ID} true /poise-ws-alice'],
                                   'health': {'poise-ws-alice': [health(OLD, desired=NEW, installed=NEW, since=since)]}})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertRegex(result.stderr, rf'alice: pending {NEW} \(active {OLD}, pending 2h3\dm\)')


if __name__ == '__main__':
    unittest.main()

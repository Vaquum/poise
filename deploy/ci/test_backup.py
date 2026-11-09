"""Run backup.sh against a Docker stand-in and the real SQLite archiver."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / 'deploy/backup.sh'
GATEWAY = 'poise-gateway-data'
HOME_VOLUME = 'poise-home-alice'

FAKE_DOCKER = r'''import json, os, runpy, sqlite3, sys
from pathlib import Path

path = Path(os.environ['BACKUP_TEST_STATE'])
state = json.loads(path.read_text())
args = sys.argv[1:]
state['calls'].append(args)

def save():
    path.write_text(json.dumps(state))

def event(command):
    counts = state.setdefault('counts', {})
    counts[command] = counts.get(command, 0) + 1
    for change in state.get('events', []):
        if change['on'] == command and change['count'] == counts[command]:
            state.update(change.get('set', {}))
            if change.get('fail'):
                print('partial inventory')
                save()
                sys.exit('injected Docker inventory failure')
            if change.get('empty'):
                save()
                sys.exit(0)
    save()

command = ' '.join(args[:2]) if args[0] in ('volume', 'image', 'compose') else args[0]
event(command)
if command == 'version':
    print('24.0.0')
elif command in ('compose version', 'image inspect', 'volume inspect'):
    pass
elif command == 'info':
    print(state['default_runtime'])
elif command == 'volume ls':
    print('\n'.join(state['volumes']))
elif command == 'ps':
    for container in state['containers']:
        if '--all' not in args and container['status'] in ('created', 'exited', 'dead'):
            continue
        if 'label=poise.managed=true' in args and not container['managed']:
            continue
        print(container['id'])
elif command == 'inspect':
    container = next((c for c in state['containers'] if c['id'] == args[-1]), None)
    if container is None:
        sys.exit('container disappeared')
    template = args[args.index('--format') + 1]
    if '|' in template:
        setting = container['workspace_runtime']
        print('|'.join([container['id'], '/' + container['name'], container['runtime'],
                        container['status'], '' if setting is None else 'POISE_WORKSPACE_RUNTIME=' + setting,
                        ' '.join(container['mounts']), 'end']))
    else:
        print('/' + container['name'], container['runtime'])
elif command == 'run':
    mounts = {}
    for index, arg in enumerate(args):
        if arg == '--mount':
            mount = dict(part.split('=', 1) for part in args[index + 1].split(',') if '=' in part)
            mounts[mount['target']] = mount['source']
    volume = mounts['/volume']
    runtime = next((a.split('=', 1)[1] for a in args if a.startswith('--runtime=')), state['default_runtime'])
    state['helpers'].append(volume)
    save()
    connect = sqlite3.connect

    def observed_connect(database, *positional, **keywords):
        if str(database).endswith('?mode=ro'):
            event('opening')
            unsafe = any(volume in c['mounts'] and c['runtime'] != runtime
                         and c['status'] not in ('created', 'exited', 'dead') for c in state['containers'])
            state['database_opens'].append({'volume': volume, 'unsafe': unsafe})
            save()
        return connect(database, *positional, **keywords)

    sqlite3.connect = observed_connect
    archiver = runpy.run_path(mounts['/volume-archive.py'])
    archiver['main']([state['volumes'][volume], str(Path(mounts['/backup']) / (volume + '.tar.gz')),
                      f'{os.getuid()}:{os.getgid()}'])
    state['archived'].append(volume)
    event('archived')
else:
    sys.exit('unexpected Docker command: ' + repr(args))
'''


def container(name='poise-ws-alice', runtime='runc', status='running', volume=HOME_VOLUME,
              workspace_runtime=None, managed=True):
    return {'id': hashlib.sha256(name.encode()).hexdigest(), 'name': name, 'runtime': runtime,
            'status': status, 'mounts': [volume], 'workspace_runtime': workspace_runtime, 'managed': managed}


def gateway(status='running', workspace_runtime='runc'):
    return container('poise-gateway', status=status, volume=GATEWAY,
                     workspace_runtime=workspace_runtime, managed=False)


@unittest.skipUnless(sys.platform.startswith('linux'), 'backup.sh requires Linux')
class BackupTest(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.work = Path(work.name)
        self.deploy = self.work / 'deploy'
        self.deploy.mkdir()
        shutil.copy(BACKUP, self.deploy / 'backup.sh')
        for name in ('lib.sh', 'volume-archive.py'):
            shutil.copy(ROOT / 'deploy' / name, self.deploy / name)
        (self.deploy / '.env').write_text('POISE_DOMAIN=poise.test\nPOISE_GITHUB_CLIENT_ID=id\n'
                                         'POISE_GITHUB_CLIENT_SECRET=fixture\nPOISE_ADMINS=alice\n'
                                         'POISE_PROXY_LISTEN=127.0.0.1:8080\n')
        (self.deploy / '.env').chmod(0o600)
        self.bin = self.work / 'bin'
        self.bin.mkdir()
        docker = self.bin / 'docker'
        docker.write_text('#!' + sys.executable + '\n' + FAKE_DOCKER)
        docker.chmod(0o755)
        self.state = self.work / 'docker.json'
        self.backups = self.work / 'backups'
        self.previous = self.backups / 'previous'
        self.previous.mkdir(parents=True)
        (self.previous / 'keep').write_text('previous backup')
        self.volumes = {}
        self.writers = []
        for volume in (GATEWAY, HOME_VOLUME):
            directory = self.work / volume
            directory.mkdir()
            self.volumes[volume] = str(directory)
            writer = sqlite3.connect(directory / 'live.db', isolation_level=None)
            self.addCleanup(writer.close)
            self.writers.append(writer)
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('PRAGMA wal_autocheckpoint=0')
            writer.execute('CREATE TABLE notes (n INTEGER)')
            writer.executemany('INSERT INTO notes VALUES (?)', [(n,) for n in range(50)])

    def backup(self, containers=None, events=(), default_runtime='runc'):
        self.state.write_text(json.dumps({
            'containers': [gateway(), container()] if containers is None else containers,
            'volumes': self.volumes, 'events': events, 'default_runtime': default_runtime,
            'calls': [], 'helpers': [], 'archived': [], 'database_opens': [],
        }))
        env = {name: value for name, value in os.environ.items() if not name.startswith(('POISE_', 'COMPOSE_'))}
        env.update(PATH=str(self.bin) + os.pathsep + env['PATH'], BACKUP_TEST_STATE=str(self.state))
        result = subprocess.run(['bash', str(self.deploy / 'backup.sh'), str(self.backups)],
                                capture_output=True, text=True, env=env, timeout=30)
        return result, json.loads(self.state.read_text())

    def assert_refused(self, result, state, archived=()):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(state['helpers'], list(archived), 'an unsafe archive helper was launched')
        self.assertEqual(state['archived'], list(archived))
        self.assertFalse(any(opened['unsafe'] for opened in state['database_opens']), state['database_opens'])
        self.assertEqual(list(self.backups.iterdir()), [self.previous], 'a partial backup survived refusal')
        self.assertEqual((self.previous / 'keep').read_text(), 'previous backup')
        self.assertNotIn('Backed up', result.stdout)

    def test_refuses_live_cross_kernel_consumers_before_any_sqlite_access(self):
        for status in ('running', 'paused', 'restarting', 'removing'):
            for volume in (HOME_VOLUME, GATEWAY):
                with self.subTest(status=status, volume=volume):
                    unsafe = container('unlabelled-workspace', runtime='runsc', status=status,
                                       volume=volume, managed=False)
                    result, state = self.backup([gateway(), unsafe])
                    self.assert_refused(result, state)
                    self.assertEqual(state['database_opens'], [])
                    self.assertIn('unlabelled-workspace', result.stderr)
                    self.assertIn(volume, result.stderr)
                    self.assertIn('Stop poise-gateway first', result.stderr)
                    self.assertIn('docs/Operating.md', result.stderr)

    def test_admin_stopped_gvisor_is_unsafe_while_gateway_can_start_it(self):
        for status in ('running', 'paused', 'restarting'):
            with self.subTest(gateway=status):
                result, state = self.backup([gateway(status), container(runtime='runsc', status='exited')])
                self.assert_refused(result, state)
                self.assertIn('poise-ws-alice', result.stderr)
                self.assertIn('can start or replace workspaces', result.stderr)

    def test_fences_cross_kernel_replacements_of_current_runc_workspaces(self):
        for setting, default in [('runsc', 'runc'), (None, 'runsc')]:
            with self.subTest(setting=setting, default=default):
                result, state = self.backup([gateway(workspace_runtime=setting), container()], default_runtime=default)
                self.assert_refused(result, state)
                self.assertIn(HOME_VOLUME, result.stderr)
                self.assertIn('runsc', result.stderr)

    def test_inventory_errors_and_incomplete_inspection_fail_closed(self):
        for command, count, empty, archived in [
            ('volume ls', 1, False, ()), ('info', 1, False, ()), ('info', 1, True, ()),
            ('ps', 1, False, ()), ('inspect', 2, False, ()), ('inspect', 2, True, ()),
            ('ps', 3, False, (GATEWAY,)), ('inspect', 6, False, (GATEWAY,)),
        ]:
            with self.subTest(command=command, count=count, empty=empty):
                result, state = self.backup(events=[{'on': command, 'count': count,
                                                      'empty' if empty else 'fail': True}])
                self.assert_refused(result, state, archived)
        result, state = self.backup(events=[{'on': 'inspect', 'count': 2,
                                              'set': {'containers': [gateway()]}}])
        self.assert_refused(result, state)
        self.assertIn('cannot inspect container', result.stderr)

    def test_start_and_replacement_races_remove_even_completed_archives(self):
        for phase, count, archived in [('ps', 2, ()), ('opening', 1, (GATEWAY,)),
                                       ('archived', 1, (GATEWAY,)), ('archived', 2, (GATEWAY, HOME_VOLUME))]:
            for status in ('running', 'paused', 'restarting'):
                with self.subTest(phase=phase, status=status):
                    replacement = container('replacement-alice', runtime='runsc', status=status, managed=False)
                    result, state = self.backup(
                        [gateway('exited'), container(runtime='runsc', status='exited')],
                        events=[{'on': phase, 'count': count,
                                 'set': {'containers': [gateway(), replacement]}}])
                    self.assert_refused(result, state, archived)
                    self.assertIn('replacement-alice', result.stderr)
                    self.assertEqual([opened['volume'] for opened in state['database_opens']], list(archived))

    def test_gateway_restart_cannot_hide_behind_a_workspace_replacement_gap(self):
        result, state = self.backup([gateway('exited'), container(runtime='runsc', status='exited')],
                                   events=[{'on': 'opening', 'count': 1, 'set': {'containers': [gateway()]}}])
        self.assert_refused(result, state, (GATEWAY,))
        self.assertIn('poise-ws-alice', result.stderr)

    def assert_restorable(self, result, state):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(state['archived'], [GATEWAY, HOME_VOLUME])
        self.assertEqual(len(state['database_opens']), 2)
        self.assertFalse(any(opened['unsafe'] for opened in state['database_opens']))
        runs = [call for call in state['calls'] if call[0] == 'run']
        self.assertTrue(all('--runtime=runc' in call for call in runs))
        backup = next(directory for directory in self.backups.iterdir() if directory != self.previous)
        checksums = (backup / 'SHA256SUMS').read_text().splitlines()
        self.assertEqual(len(checksums), 2)
        for line in checksums:
            digest, name = line.split()
            archive = backup / name
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), digest)
            restored = self.work / (name + '.restored')
            with tarfile.open(archive) as tar:
                self.assertIn('live.db', tar.getnames())
                self.assertNotIn('live.db-wal', tar.getnames())
                self.assertNotIn('live.db-shm', tar.getnames())
                tar.extractall(restored, filter='fully_trusted')
            database = sqlite3.connect(restored / 'live.db')
            self.addCleanup(database.close)
            self.assertEqual(database.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(database.execute('SELECT count(*) FROM notes').fetchone(), (50,))

    def test_live_runc_wal_backup_uses_runc_even_when_docker_defaults_to_runsc(self):
        for directory in self.volumes.values():
            self.assertGreater((Path(directory) / 'live.db-wal').stat().st_size, 0)
        result, state = self.backup(default_runtime='runsc')
        self.assert_restorable(result, state)

    def test_stopped_gvisor_and_gateway_support_offline_backup(self):
        for writer in self.writers:
            writer.close()
        result, state = self.backup([gateway('exited', 'runsc'), container(runtime='runsc', status='exited')])
        self.assert_restorable(result, state)

    def test_unrelated_gvisor_container_does_not_block_same_kernel_backup(self):
        result, state = self.backup([gateway(), container(), container('unrelated', runtime='runsc', volume='other')])
        self.assert_restorable(result, state)


if __name__ == '__main__':
    unittest.main()

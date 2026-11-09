"""Actual service/supervisor switch with native review and implementation Calls.

Providers and GitHub operations are stand-ins; Caller execution,
publication receipts, namespaces and resource settlement use production code.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

signal.alarm(120)

if not sys.argv[1:]:
    source = Path(os.environ['AGENT_INTERFACE_ROOT']).parents[1]
    supervisor = source / 'deploy/runtime/supervisor.mjs'
    if not supervisor.is_file():
        supervisor = Path('/opt/poise-runtime/supervisor.mjs')
    with TemporaryDirectory(prefix='native-switch-service-', dir=Path.home()) as temporary:
        home = Path(temporary)
        binaries = home / '.local/bin'
        binaries.mkdir(parents=True)
        for name in ('claude', 'codex', 'gh', 'grok', 'muse', 'agy'):
            binary = binaries / name
            binary.write_text('#!/bin/sh\nexit 1\n')
            binary.chmod(0o700)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        environment = {'HOME': str(home), 'PATH': f'{binaries}:{os.environ["PATH"]}',
            'AGENT_INTERFACE_DATA_DIR': str(home / '.poise/agent-interface'),
            'PYTHONPATH': str(source / 'caller/agent_interface'),
            'POISE_MODE': 'service', 'POISE_WORKSPACE_HANDLE': 'native-component',
            'POISE_WORKSPACE_OWNER': 'Native-Component', 'POISE_PUBLIC_ORIGIN': 'https://native-component.poise.test',
            'POISE_HOST': '127.0.0.1', 'POISE_PORT': str(port), 'POISE_SKIP_CLI_BOOTSTRAP': '1',
            'POISE_COMPONENT_URL': f'http://127.0.0.1:{port}'}
        program = f"""
import {{ supervisor }} from {json.dumps(supervisor.as_uri())};
import {{ generateKeyPairSync }} from 'node:crypto';
const {{ publicKey }} = generateKeyPairSync('ed25519');
const env = {{ ...process.env, POISE_GATEWAY_PUBLIC_KEY: Buffer.from(publicKey.export({{ type: 'spki', format: 'pem' }})).toString('base64') }};
const instance = supervisor({{ home: env.HOME, env, base: 'native-switch-component',
    image: {{ name: 'native-component-before', poise: {json.dumps(str(source))}, venv: {json.dumps(str(Path(sys.executable).parent.parent))} }} }});
process.on('SIGTERM', () => instance.stop('SIGTERM'));
process.exitCode = await instance.run();
"""
        with (home / 'server.log').open('w') as output:
            server = subprocess.Popen(['node', '--input-type=module', '-e', program], env=environment,
                                      stdout=output, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 30
                while True:
                    assert server.poll() is None, (home / 'server.log').read_text()
                    try:
                        with urllib.request.urlopen(environment['POISE_COMPONENT_URL'] + '/api/service/health', timeout=2):
                            break
                    except (urllib.error.URLError, TimeoutError):
                        assert time.monotonic() < deadline, (home / 'server.log').read_text()
                        time.sleep(0.1)
                result = subprocess.run([sys.executable, __file__, 'exercise'], env=environment, timeout=100)
                assert result.returncode == 0, (home / 'server.log').read_text()
            finally:
                server.terminate()
                server.wait(timeout=15)
    raise SystemExit(0)

url = os.environ.get('POISE_COMPONENT_URL', 'http://127.0.0.1:5555')


def health():
    with urllib.request.urlopen(url + '/api/service/health', timeout=5) as response:
        return json.load(response)


if sys.argv[1:2] != ['worker']:
    original = health()
    environments = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            values = dict(value.split(b'=', 1) for value in (entry / 'environ').read_bytes().split(b'\0') if b'=' in value)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if values.get(b'POISE_RELEASE') == original['release'].encode() and b'POISE_NATIVE_CONTROL' in values \
                and values.get(b'HOME') == str(Path.home()).encode():
            environments.append((int(entry.name), {key.decode(): value.decode() for key, value in values.items()}))
    assert len(environments) == 1, environments
    server_pid, environment = environments[0]
    os.environ['POISE_NATIVE_CONTROL'] = environment['POISE_NATIVE_CONTROL']
os.environ['AGENT_INTERFACE_DATA_DIR'] = json.loads(os.environ['POISE_NATIVE_CONTROL'])['store']['path']
import agent_interface as api
from agent_interface import native_namespace, resource_ownership, review_receipt


if sys.argv[1:2] == ['worker']:
    from agent_interface import issue_review

    _, _, kind, directory, correlation = sys.argv
    work = Path(directory)
    actor, repo = 'component-reviewer', 'example/release-switch'
    number = 23 if kind == 'neighbor' else 21

    def interface(*args, **kwargs):
        assert args[args.index('--token-user') + 1] == actor
        flag = args[0]
        if flag == '--read-issue':
            return {'issue': {'number': number, 'title': 'Switch component', 'body': 'Preserve this Call',
                              'state': 'open', 'user': {'login': actor}, 'labels': []}}
        if flag == '--issue-comments':
            return {'comments': []}
        if flag == '--sub-issues':
            return {'sub_issues': []}
        if flag == '--checkout-repo':
            Path(args[args.index('--path') + 1]).mkdir()
            return {'head_sha': 'a' * 40, 'branch': 'main'}
        if flag == '--comment-issue':
            assert (work / 'release').exists(), 'review published before its provider was released'
            native_namespace.active().require_idle()
            return {'action': 'commented_issue', 'repository': repo, 'issue_number': number,
                    'comment': {'id': 2101, 'user': {'login': actor}}}
        assert flag == '--issue-work', args
        mode = args[args.index('--mode') + 1]
        if mode == 'prepare':
            Path(args[args.index('--path') + 1]).mkdir()
            return {'outcome': 'prepared', 'checkout_head': 'a' * 40}
        assert (work / 'release').exists(), 'implementation published before its provider was released'
        native_namespace.active().require_idle()
        if mode == 'validate':
            return {'outcome': 'validated'}
        assert mode == 'publish'
        review_receipt.work_publication('b' * 40)
        review_receipt.work_publication('b' * 40, start_replies=True)
        return {'outcome': 'published', 'head_sha': 'b' * 40, 'pull_number': 22}

    def command(model, prompt, checkout, owned, seconds, *extra):
        output = {'comments': [{'issue': f'#{number}', 'body': 'Retained review result.'}]} if kind != 'implementation' else {
            'commitMessage': 'fix: preserve component work', 'title': 'fix: preserve component work',
            'body': 'Controlled native switch regression.', 'replies': [], 'blocked': None}
        destination = owned / ('publication.json' if kind == 'implementation' else 'review.json')
        body = ('import json, os, time\nfrom pathlib import Path\n'
                f'work = Path({str(work)!r})\n'
                'work.joinpath("ready").write_text(json.dumps({"call": os.environ["AGENT_INTERFACE_RECEIPT_CALL"], "provider_pid": os.getpid()}))\n'
                'while not work.joinpath("release").exists(): time.sleep(0.02)\n'
                f'Path({str(destination)!r}).write_text({json.dumps(output)!r})\n'
                'print(json.dumps({"type": "turn.completed"}), flush=True)\n')
        return [sys.executable, '-c', body], '', os.environ.copy()

    # The test must never prepare or reach a real provider or its credentials.
    api._prepare_native_clis = lambda call: None
    issue_review.interface, issue_review.command = interface, command
    os.environ['GITHUB_INTERFACE_AGENT_USER'] = actor
    sys.argv = ['agent-interface', '--atomic-work' if kind == 'implementation' else '--issue-review', f'{repo}#{number}',
                '--actor', actor, '--source', 'poise:behavior-chain', '--correlation-id', correlation,
                '--model', 'gpt-6-astra-ultra']
    if kind == 'implementation':
        sys.argv += ['--branch', 'fix/component-switch']
    api.main()
    raise SystemExit(0)


def wait_for(predicate, evidence):
    deadline = time.monotonic() + 30
    while not predicate():
        assert time.monotonic() < deadline, evidence()
        time.sleep(0.05)


def row(call):
    with api.db() as database:
        return dict(database.execute('select * from calls where id=?', (call,)).fetchone())


with TemporaryDirectory(prefix='native-switch-', dir=Path.home()) as temporary:
    root = Path(temporary)
    for switching in (False, True):
        workers, originals = [], []
        try:
            for kind in ('review', 'implementation', 'neighbor'):
                directory = root / f'{switching}-{kind}'
                directory.mkdir()
                with (directory / 'output').open('w') as output:
                    worker = subprocess.Popen([sys.executable, __file__, 'worker', kind, str(directory), directory.name],
                                              stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                              start_new_session=True)
                workers.append(worker)
                wait_for(lambda: (directory / 'ready').exists(), lambda: (directory / 'output').read_text())
                ready = json.loads((directory / 'ready').read_text())
                stored = row(ready['call'])
                assert stored['status'] == 'running' and stored['pid'] == str(worker.pid), stored
                owned = json.loads(stored['resource_ownership'])
                scope = native_namespace.Namespace.restore(json.loads(stored['namespace_control']), owned['namespace']['binding'])
                assert ready['provider_pid'] > 2 and ready['provider_pid'] in scope.read()['pids'], 'provider was not live'
                originals.append((directory, ready, native_namespace.task_identity(worker.pid), scope))
            before = health()
            assert before['runningCallerCalls'] >= 3
            if switching:
                release = 'native-component-switch'
                installed = Path.home() / '.poise' / 'releases' / release
                installed.mkdir(parents=True)
                source = Path(environment['AGENT_INTERFACE_ROOT']).parents[1]
                # A distinct installed entrypoint, as install-release.sh copies
                # it; a symlink would skip production's direct-entrypoint guard.
                for name in ('dist', 'scripts', 'caller', 'gateway'):
                    shutil.copytree(source / name, installed / 'poise' / name,
                                    ignore=shutil.ignore_patterns('.venv', '__pycache__', 'data', 'build', '*.egg-info'))
                shutil.copyfile(source / 'package.json', installed / 'poise' / 'package.json')
                (installed / 'poise' / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
                (installed / 'venv').symlink_to(Path(environment['CALLER_BIN_ROOT']).parent, target_is_directory=True)
                (installed / 'base').write_text(environment['POISE_BASE'])
                (installed / 'installed').touch()
                request = urllib.request.Request(url + '/api/service/switch', method='POST',
                    data=json.dumps({'release': release}).encode(), headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=5) as response:
                    assert response.status == 202 and json.load(response)['switching']

                def activated():
                    try:
                        return health()['release'] == release
                    except (urllib.error.URLError, ConnectionError):
                        return False

                wait_for(activated, lambda: 'new release never activated while the original Calls were live')
                assert not Path(f'/proc/{server_pid}').exists(), 'old Poise process did not exit'
            after = health()
            assert after['runningCallerCalls'] >= 3
            for directory, ready, identity, scope in originals:
                assert native_namespace.task_identity(identity['pid']) == identity
                assert row(ready['call'])['status'] == 'running'
                assert ready['provider_pid'] in scope.read()['pids'], 'original provider ended before activation'
            print(json.dumps({'kind': 'native-switch-originals-live', 'switched': switching, 'release': after['release'],
                'calls': [{'call': ready['call'], 'identity': identity, 'provider_pid': ready['provider_pid']}
                          for _, ready, identity, _ in originals]}), flush=True)
            for worker, (directory, ready, identity, scope) in zip(workers, originals):
                (directory / 'release').touch()
                assert worker.wait(timeout=20) == 0, (directory / 'output').read_text()
                result = api.logs_selected({'latest': [], 'ids': [ready['call']]})[0]
                assert result['status'] == 'completed', result
                assert result['resources_settled_at'] and resource_ownership.released(result['resource_ownership']), result
                assert all(not Path(owned['path']).exists() for owned in result['resource_ownership']['roots'])
                if directory.name.endswith('implementation'):
                    assert result['action'] == 'published' and result['artifact']['publication_head'] == 'b' * 40
                    assert result['artifact']['replies_started'] is True
                else:
                    assert result['action'] == 'commented' and result['receipts'][0]['comment_id'] == 2101
                with api.db() as database:
                    assert database.execute('select count(*) from calls where correlation_id=?', (directory.name,)).fetchone()[0] == 1
                print(json.dumps({'kind': 'native-switch-original-settled', 'switched': switching,
                                  'call': ready['call'], 'identity': identity, 'provider_pid': ready['provider_pid'],
                                  'release_before': before['release'], 'release_after': after['release'],
                                  'action': result['action'], 'resources_settled_at': result['resources_settled_at'],
                                  'provider_and_github_standins': True}), flush=True)
                if worker != workers[-1]:
                    assert workers[-1].poll() is None, 'unrelated original Call was interrupted'
        finally:
            for worker in workers:
                if worker.poll() is None:
                    worker.terminate()
                    worker.wait(timeout=10)

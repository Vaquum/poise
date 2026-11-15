"""Real confined publication CLI and original-Call recovery; Git/GitHub stand-ins.

No provider, credentials or external writes participate in this component proof.
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import AsyncMock, patch

START, HEAD = 'a' * 40, 'b' * 40
BRANCH = 'poise/issue-7'
PUBLICATION = {'commitMessage': 'fix: repair seed', 'title': 'fix: repair seed', 'body': 'Concrete repair.',
               'replies': [{'commentId': 17, 'body': 'Fixed the original finding.'}]}


def helper_cli():
    import httpx
    import agent_interface as api
    from agent_interface import native_namespace
    from github_interface import cli, interface
    from github_interface.behaviors import issue_work

    state_path = Path(os.environ['PUBLICATION_STATE'])
    state = json.loads(state_path.read_text())
    scenario = state['scenario']
    if scenario == 'foreign' and not os.environ.get('PUBLICATION_FOREIGN_CHILD'):
        # The real executed CLI has a foreign parent, still inside the original
        # namespace. It must refuse without waiting for that parent to leave.
        result = subprocess.run([sys.executable, __file__, *sys.argv[1:]],
                                env={**os.environ, 'PUBLICATION_FOREIGN_CHILD': '1'}, timeout=10)
        raise SystemExit(result.returncode)

    def save():
        state_path.write_text(json.dumps(state))

    def pull():
        return {'number': 3, 'state': 'open', 'user': {'login': 'author'},
                'html_url': 'https://github.com/example/repo/pull/3',
                'body': '<!-- poise-chain example/repo#7 -->',
                'head': {'ref': BRANCH, 'sha': state['head'], 'repo': {'full_name': 'example/repo'}}}

    async def get(path):
        if path == '/repos/example/repo':
            return {'full_name': 'example/repo', 'default_branch': 'main'}
        if path.endswith('/issues/7'):
            return {'state': 'open'}
        assert path == '/repos/example/repo/pulls/3', path
        return pull()

    async def paginate(path, params=None):
        if path.endswith('/comments'):
            return [{'id': 17}, *state['replies']]
        assert path == '/repos/example/repo/pulls', path
        return [pull()]

    async def graph(*args):
        return {'repository': {'ref': {'target': {'oid': state['head'],
                'message': f"fix: repair\n\nPoise-Invocation: {os.environ['AGENT_INTERFACE_RECEIPT_CALL']}"}},
                'defaultBranchRef': {'target': {'oid': 'c' * 40}},
                'issue': {'closedByPullRequestsReferences': {'nodes': [], 'pageInfo': {'hasNextPage': False}}}}}

    async def post(path, **payload):
        assert path == '/repos/example/repo/pulls/3/comments/17/replies', path
        with api.db() as database:
            artifact = json.loads(database.execute(
                'select artifact from calls where id=?', (os.environ['AGENT_INTERFACE_RECEIPT_CALL'],)).fetchone()[0])
        assert artifact['replies_started'] is True
        state['post_attempts'] += 1
        reply = {'id': 201, 'in_reply_to_id': 17, 'body': payload['json']['body'], 'user': {'login': 'author'}}
        if scenario == 'attempted':
            state['uncertain_reply'] = reply
            save()
            raise httpx.ReadTimeout('reply response lost; private-token')
        state['replies'].append(reply)
        save()
        return reply

    def member():
        # An orphan is reaped by the real PID 1, independently of the CLI's
        # polling. Keep it live until the first controller read proves it.
        read_fd, write_fd = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(read_fd)
            if os.fork():
                os._exit(0)
            os.write(write_fd, str(os.getpid()).encode())
            os.close(write_fd)
            os.closerange(0, 1024)
            while not state_path.with_suffix('.read').exists():
                time.sleep(0.005)
            time.sleep(0.05 if scenario == 'transient' else 60)
            os._exit(0)
        os.close(write_fd)
        state['member'] = int(os.read(read_fd, 32))
        os.close(read_fd)
        os.waitpid(child, 0)

    def git(args, *credentials):
        command = args[3:]
        if command == ['branch', '--show-current']:
            return BRANCH
        if command == ['remote', 'get-url', 'origin']:
            return 'https://github.com/example/repo.git'
        if command == ['rev-parse', 'HEAD']:
            return HEAD if state['commits'] else START
        if command == ['status', '--porcelain']:
            return ' M candidate.txt'
        if command == ['add', '-A']:
            return ''
        if command[:1] == ['commit']:
            state['commits'] += 1
        else:
            assert 'push' in command, command
            state['pushes'] += 1
            state['head'] = HEAD
            if scenario in {'transient', 'persistent'}:
                member()
        save()
        return ''

    original_read = native_namespace.Namespace.read

    def read(scope, **kwargs):
        evidence = original_read(scope, **kwargs)
        state['reads'].append({'helper': os.getpid(), 'pids': evidence['pids'], **kwargs})
        save()
        state_path.with_suffix('.read').touch()
        if scenario == 'timeout':
            raise TimeoutError('private-token namespace read timed out')
        if scenario == 'io':
            raise OSError('private-token namespace I/O failed')
        return evidence

    client = AsyncMock(token='private-token')
    client.get.side_effect, client.paginate.side_effect = get, paginate
    client.graphql.side_effect, client.post.side_effect = graph, post
    with patch.object(interface, 'GitHubClient', return_value=client), \
            patch.object(issue_work, '_run', side_effect=git), \
            patch.object(native_namespace.Namespace, 'read', read):
        cli.main()


if sys.argv[1:2] == ['--issue-work']:
    helper_cli()
    raise SystemExit(0)

signal.alarm(90)
with TemporaryDirectory(prefix='native-publication-', dir='/tmp') as temporary:
    root = Path(temporary)
    os.environ['AGENT_INTERFACE_DATA_DIR'] = str(root / 'caller')
    os.environ.pop('POISE_NATIVE_CONTROL', None)
    os.environ.pop('AGENT_INTERFACE_RECEIPT_DB', None)
    os.environ.pop('AGENT_INTERFACE_RECEIPT_CALL', None)
    import agent_interface as api
    from agent_interface import issue_review, native_namespace, progress, resource_ownership, review_receipt

    # Use the existing image controller fixture and the invoking interpreter's
    # installed candidate for the exec boundary.
    server = subprocess.Popen(['node', str(Path(__file__).with_name('control.mjs'))], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    os.environ['POISE_NATIVE_CONTROL'] = server.stdout.readline().strip()
    launcher = root / 'github-interface'
    launcher.write_text(f'#!{sys.executable}\nimport runpy\nrunpy.run_path({__file__!r}, run_name="__main__")\n')
    launcher.chmod(0o700)
    os.environ['GITHUB_INTERFACE_CLI'] = str(launcher)
    try:
        for scenario in ('transient', 'persistent', 'foreign', 'timeout', 'io', 'attempted'):
            state_path = root / f'{scenario}.json'
            state_path.write_text(json.dumps({'scenario': scenario, 'head': START, 'commits': 0, 'pushes': 0,
                                             'post_attempts': 0, 'replies': [], 'reads': []}))
            os.environ['PUBLICATION_STATE'] = str(state_path)
            correlation = f'publication-{scenario}'

            def publish():
                call = api.track('native-action', 'publication component', '3', 'example/repo', 'author', 'repair_pr',
                                 expected_head=START, source='poise:behavior-chain', correlation_id=correlation)
                assert os.getpid() == 2 and native_namespace.active().key['callId'] == call
                checkout = resource_ownership.allocate(api.DB, call, resource_ownership.call_directory(api.DB, call)) / 'repo'
                checkout.mkdir()
                digest = api.persist_action_plan(call, {'kind': 'atomic_work', 'publication': PUBLICATION})
                with api.db() as database:
                    database.execute('update calls set artifact=? where id=?', (json.dumps({
                        'phase': 'preparing_publication', 'plan_sha': digest,
                        'prepared': {'repository': 'example/repo', 'issue_number': 7, 'pull_number': 3,
                                     'branch': BRANCH, 'actor': 'author'}}), call))
                with review_receipt.invocation_environment(api.DB, call, True, initialize=False), \
                        progress.Progress(api.DB, call, 'publishing'):
                    try:
                        result = issue_review.interface('--issue-work', '7', '--repository', 'example/repo', '--mode', 'publish',
                            '--branch', BRANCH, '--pull-number', '3', '--expected-head', START, '--starting-head', START,
                            '--invocation-id', call, '--token-user', 'author', '--path', str(checkout),
                            '--message', PUBLICATION['commitMessage'], '--title', PUBLICATION['title'], '--body', PUBLICATION['body'],
                            '--replies-json', json.dumps(PUBLICATION['replies']), seconds=10)
                    except RuntimeError as error:
                        evidence = api.retain_native_failure(call, error, diagnostic=error.diagnostic)
                        api.finish(call, 'failed', error=str(error), error_code='atomic_work_failed', diagnostic=evidence)
                        with TestCase().assertRaises(ValueError):
                            api.complete_atomic_publication(call, digest, HEAD)
                    else:
                        api.finish(call, 'completed', response=json.dumps(result), outcome=result['outcome'],
                                   action=result['outcome'], head_sha=result['head_sha'])

            argv = ['agent-interface', '--native-action', '--source', 'poise:behavior-chain', '--correlation-id', correlation]
            with patch.object(sys, 'argv', argv), patch.object(api, '_main', side_effect=publish):
                try:
                    api.main()
                except SystemExit as result:
                    if native_namespace.active() is not None:
                        os._exit(result.code)
                    assert result.code == 0, result.code
                if native_namespace.active() is not None:
                    os._exit(0)

            row, = api.logs_selected({'latest': [], 'ids': [], 'correlations': [correlation]})
            artifact, call = row['artifact'], row['id']
            assert row['resources_settled_at'] and resource_ownership.released(row['resource_ownership']), row
            state = json.loads(state_path.read_text())
            assert (state['commits'], state['pushes'], state['head']) == (1, 1, HEAD), state
            assert artifact['publication_head'] == HEAD and api.read_action_plan(call)['sha'] == artifact['plan_sha']
            if scenario == 'transient':
                assert row['status'] == 'completed' and artifact['replies_started'] is True, row
                assert state['member'] in state['reads'][0]['pids'], state
                assert len(state['reads']) > 1 and set(state['reads'][-1]['pids']) == {1, 2, state['reads'][-1]['helper']}, state
            else:
                reasons = {'persistent': ('namespace_busy', 'namespace_read_timeout'), 'foreign': ('helper_parent',),
                           'timeout': ('namespace_read_timeout',), 'io': ('namespace_read_io',), 'attempted': ('reply response lost',)}[scenario]
                assert row['status'] == 'failed' and any(reason in row['diagnostic']['message'] for reason in reasons), row
                if scenario == 'persistent':
                    assert state['reads'] and all(state['member'] in read['pids'] for read in state['reads']), state
                assert row['diagnostic']['operation'] == 'issue_work.publish', row
                assert 'private-token' not in json.dumps(row), row
                assert artifact['replies_started'] is (scenario == 'attempted'), row
                assert state['post_attempts'] == (1 if scenario == 'attempted' else 0), state
                assert not state['replies'], state
                for digest, head in ((artifact['plan_sha'], 'd' * 40), ('d' * 64, HEAD)):
                    with TestCase().assertRaises(ValueError):
                        api.complete_atomic_publication(call, digest, head)
                if scenario == 'attempted':
                    with TestCase().assertRaises(ValueError):
                        api.complete_atomic_publication(call, artifact['plan_sha'], HEAD)
                    with review_receipt.invocation_environment(api.DB, call, True, initialize=False):
                        args = ('--issue-work', '7', '--repository', 'example/repo', '--mode', 'inspect', '--branch', BRANCH,
                                '--pull-number', '3', '--invocation-id', call, '--token-user', 'author',
                                '--replies-json', json.dumps(PUBLICATION['replies']))
                        assert issue_review.interface(*args)['replies_complete'] is False
                        state['replies'].append(state.pop('uncertain_reply'))
                        state_path.write_text(json.dumps(state))
                        assert issue_review.interface(*args)['replies_complete'] is True
                else:
                    assert api.complete_atomic_publication(call, artifact['plan_sha'], HEAD)['outcome'] == 'published'
                    recovered, = api.logs_selected({'latest': [], 'ids': [call]})
                    assert recovered['artifact']['replies_started'] is True and recovered['diagnostic'] == row['diagnostic']
            state = json.loads(state_path.read_text())
            assert state['pushes'] == state['post_attempts'] == len(state['replies']) == 1, state
            assert state['replies'][0]['body'].endswith(f'<!-- poise-reply {call} 17 -->'), state
            assert all(0 < read['timeout_seconds'] <= native_namespace.SETTLE_SECONDS for read in state['reads']), state
            print(json.dumps({'kind': 'confined-publication', 'scenario': scenario, 'call': call,
                              'pushes': state['pushes'], 'replies': len(state['replies'])}), flush=True)
        assert native_namespace.control_request(json.loads(os.environ['POISE_NATIVE_CONTROL']), 'hello')['witnesses'] == 0
    finally:
        server.stdin.close()
        stdout, stderr = server.communicate(timeout=5)
        assert server.returncode == 0 and not stdout and not stderr, (server.returncode, stdout, stderr)

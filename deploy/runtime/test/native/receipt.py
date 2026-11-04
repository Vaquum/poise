"""Actual Caller/kernel/SQLite resource boundary with a no-effect test body.
This does not execute or validate a provider or a GitHub behavior workflow.
"""
import hashlib
import json
import os
import platform
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch

os.environ['AGENT_INTERFACE_DATA_DIR'] = '/tmp/isolated-call-resource-proof'
slow = sys.argv[1:] == ['slow']
assert not sys.argv[1:] or slow
import agent_interface as api
from agent_interface import checkout_lock, native_namespace, resource_ownership, review_receipt

signal.alarm(90 if slow else 30)
server = subprocess.Popen(['node', '/contract/control.mjs'], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
address = json.loads(server.stdout.readline())
os.environ['POISE_NATIVE_CONTROL'] = json.dumps(address)
foreign = Path('/tmp/neighbor-user-evidence')
foreign.write_text('retained neighbor/user/evidence sentinel')
foreign_hash = hashlib.sha256(foreign.read_bytes()).hexdigest()
legacy_directory = Path.home() / '.poise' / 'locks'
legacy_before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in legacy_directory.glob('checkout-*.sqlite3')}
correlation = 'kernel-call-slow' if slow else 'kernel-call-original'

def no_effect_body():
    call = api.track('native-action', 'no-effect resource component', '21', 'example/repo', 'reviewer', 'native_action',
                     expected_head='a' * 40, source='poise:behavior-chain', correlation_id=correlation)
    assert os.getpid() == 2 and native_namespace.active().key['callId'] == call
    # Executed helpers cannot see the outer supervisor's PID. Exercise the
    # original metadata binding through a fresh interpreter in this scope.
    helper = subprocess.run([sys.executable, '-c',
                             'import agent_interface as api; '
                             'from agent_interface import caller_store; '
                             'connection = caller_store.connect(api.DB); '
                             'assert connection.execute("select count(*) from calls").fetchone()[0] > 0; '
                             'connection.close(); print("original-metadata-read")'],
                            capture_output=True, text=True, timeout=10)
    assert helper.returncode == 0 and helper.stdout == 'original-metadata-read\n' and not helper.stderr, helper
    if slow:
        # Setup/receipt overhead must not consume the wrapped command's
        # original 30-second budget. This is a no-effect component body.
        time.sleep(31)
    root = resource_ownership.allocate(api.DB, call, resource_ownership.call_directory(api.DB, call))
    (root / 'disposable-build-output').write_text('owned component output')
    checkout = root / 'repo'
    checkout.mkdir()
    with review_receipt.invocation_environment(api.DB, call, True, initialize=False):
        lease = checkout_lock.Lease(str(checkout), call, 'native no-effect coordination component').acquire()
        assert lease.path == root / 'checkout-lease.sqlite3'
        # An explicit no-effect process exercises the real installed writer
        # gate, SQLite heartbeat/registration and positive idle requirement.
        result = checkout_lock.run_gated(lease, [sys.executable, '-c', 'print("component-no-effect")'],
                                         cwd=str(checkout), env=None, timeout=10)
        assert result.returncode == 0 and result.stdout == 'component-no-effect\n' and not result.stderr, result
        assert not lease.held and lease.path.is_file()
        lease.acquire()
        assert lease.release()
        # The real publication CLI is exec'd, so it has no in-memory scope.
        # This no-effect component reserves only a local reply receipt.
        with api.db() as database:
            database.execute("update calls set behavior='repair_pr',action_plan='{}',artifact=? where id=?",
                             (json.dumps({'phase': 'publishing', 'plan_sha': 'b' * 64}), call))
        review_receipt.work_publication('a' * 40)
        helper = subprocess.run([sys.executable, '-c',
                                "from agent_interface.review_receipt import work_publication; "
                                "work_publication('a' * 40, start_replies=True); print('original-publication-helper')"],
                               capture_output=True, text=True, timeout=10)
        assert helper.returncode == 0 and helper.stdout == 'original-publication-helper\n' and not helper.stderr, helper
        with api.db() as database:
            assert json.loads(database.execute('select artifact from calls where id=?', (call,)).fetchone()[0])['replies_started'] is True
    api.finish(call, 'failed', error='Explicit no-effect component body; no provider or GitHub action started',
               outcome='preflight_failed', action='not_started', error_code='component_no_effect')

try:
    argv = ['agent-interface', '--native-action', '--source', 'poise:behavior-chain', '--correlation-id', correlation]
    with patch.object(sys, 'argv', argv), patch.object(api, '_main', side_effect=no_effect_body):
        try:
            api.main()
        except SystemExit as result:
            if native_namespace.active() is not None:
                os._exit(result.code)
            assert result.code == 0, result.code
        if native_namespace.active() is not None:
            os._exit(0)
    rows = api.logs_selected({'latest': [], 'ids': [], 'correlations': [correlation]})
    assert len(rows) == 1
    row = rows[0]
    owned = row['resource_ownership']
    assert owned['version'] == 2 and owned['namespace']['state'] == 'settled', rows
    assert owned['namespace']['callId'] == row['id'] and owned['namespace']['correlation'] == correlation
    assert len(owned['roots']) == 1 and owned['roots'][0]['state'] == 'reclaimed'
    assert not Path(owned['roots'][0]['path']).exists()
    assert row['resources_settled_at'] and resource_ownership.released(owned)
    assert row['status'] == 'failed' and row['action'] == 'not_started'
    assert hashlib.sha256(foreign.read_bytes()).hexdigest() == foreign_hash
    assert legacy_before == {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                             for path in legacy_directory.glob('checkout-*.sqlite3')}
    with api.db() as database:
        original = database.execute('select namespace_control,resources_settled_at from calls where id=?', (row['id'],)).fetchone()
    private = json.loads(original[0])
    encoded = json.dumps(rows)
    assert private['token'] not in encoded and private['address']['path'] not in encoded
    assert native_namespace.control_request(address, 'hello')['witnesses'] == 0
    assert server.poll() is None
    print(json.dumps({'kind': 'actual-call-resource-component', 'kernel': platform.release(), 'architecture': platform.machine(),
        'caller_rows': rows, 'foreign_sentinel_unchanged': True,
        'private_checkout_coordination_reclaimed': True, 'shared_lease_inventory_unchanged': True,
        'provider_or_workflow_acceptance': False}))
finally:
    server.stdin.close()
    stdout, stderr = server.communicate(timeout=5)
    assert server.returncode == 0 and not stdout and not stderr, (server.returncode, stdout, stderr)

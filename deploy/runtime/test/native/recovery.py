"""Installed-image resource recovery regression. No provider or GitHub action.

The allocation body is an explicit component fixture. Process containment,
SQLite, the installed Caller, service maintenance and kernel observations are real.
"""
import hashlib
import json
import os
import runpy
import signal
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from unittest.mock import patch

signal.alarm(180)
addresses = set()
for entry in Path('/proc').iterdir():
    if not entry.name.isdecimal():
        continue
    try:
        if b'/opt/poise/dist/server.js' not in (entry / 'cmdline').read_bytes().split(b'\0'):
            continue
        environment = (entry / 'environ').read_bytes().split(b'\0')
    except (FileNotFoundError, ProcessLookupError):
        continue
    addresses.update(value.partition(b'=')[2].decode() for value in environment
                     if value.startswith(b'POISE_NATIVE_CONTROL='))
assert len(addresses) == 1
address = json.loads(addresses.pop())
os.environ['POISE_NATIVE_CONTROL'] = json.dumps(address)
os.environ['AGENT_INTERFACE_DATA_DIR'] = str(Path.home() / '.poise' / 'agent-interface')
import agent_interface as api
from agent_interface import checkout_lock, issue_review, native_cleanup, native_namespace, process_identity, resource_ownership, review_receipt

if sys.argv[1:2] == ['cleaner']:
    original_remove = resource_ownership._remove_directory

    def unlink_then_interrupt(*args, **kwargs):
        original_remove(*args, **kwargs)
        os._exit(91)

    with patch.object(resource_ownership, '_remove_directory', side_effect=unlink_then_interrupt):
        native_cleanup.recover(api.DB)
    raise AssertionError('cleanup interruption did not reach the real unlink window')

variant = sys.argv[-1] if len(sys.argv) > 1 else 'parent-loss'
correlation = f'recovery-{variant}'
if sys.argv[1:2] == ['worker']:
    original_register = resource_ownership.register_namespace

    def register(database, call, receipt):
        if variant == 'before-active':
            print(json.dumps({'kind': 'allocation-ready', 'call': call,
                              'root': str(resource_ownership.call_directory(api.DB, call))}), flush=True)
            assert os.read(0, 1) == b'X'
        original_register(database, call, receipt)

    def allocation_body():
        call = api.track('native-action', 'no-effect cleanup baseline', '21', 'example/repo', 'reviewer', 'native_action',
                         expected_head='a' * 40, source='poise:behavior-chain', correlation_id=correlation)
        if variant == 'metadata-pid-collision':
            runpy.run_path('/contract/metadata_collision.py')['validate']()
        root = resource_ownership.allocate(api.DB, call, resource_ownership.call_directory(api.DB, call))
        (root / 'disposable-output').write_bytes(b'owned component output\n' * 4096)
        if variant in {'native-coordination', 'native-coordination-replaced'}:
            checkout = root / 'repo'
            checkout.mkdir()
            with review_receipt.invocation_environment(api.DB, call, True, initialize=False):
                lease = checkout_lock.Lease(str(checkout), call, 'native post-loss coordination component').acquire()
                assert lease.path == root / 'checkout-lease.sqlite3' and lease.path.is_file()
                lease.start_heartbeat()
            # This writes explicit fixture history, not a provider result.
            # The actual command builder must place it inside the owned root.
            model = api.CATALOG.resolve('gpt-6-astra-ultra')
            _, _, env = issue_review.command(model, 'no provider is started', checkout, root, 600)
            history = Path(env['CODEX_HOME']) / 'sessions'
            history.mkdir()
            (history / 'component-fixture.jsonl').write_text('explicit component history fixture')
            assert history.is_relative_to(root)
        if variant == 'permission-zero':
            locked = root / 'locked'
            locked.mkdir()
            (locked / 'output').write_text('owned unreadable disposable output')
            locked.chmod(0)
        if variant in {'partial-root', 'partial-before-mkdir'}:
            partial = root / 'registered-child'
            with api.db() as db:
                receipt = resource_ownership.read(db, call)
                receipt['roots'].append({'path': str(partial), 'state': 'registered'})
                resource_ownership._write(db, call, receipt)
            if variant == 'partial-root':
                native_namespace.active().resource('allocate-root', partial)
        print(json.dumps({'kind': 'allocation-ready', 'call': call, 'root': str(root)}), flush=True)
        assert os.read(0, 1) == b'X'
    with patch.object(resource_ownership, 'register_namespace', side_effect=register), \
            patch.object(sys, 'argv', ['agent-interface', '--native-action', '--source', 'poise:behavior-chain',
                                  '--correlation-id', correlation]), patch.object(api, '_main', side_effect=allocation_body):
        api.main()
    os._exit(3)

assert sys.argv[1:2] != ['worker']
foreign = Path.home() / 'user-evidence-sentinel'
foreign.write_text('retained user and authentication evidence sentinel')
foreign_hash = hashlib.sha256(foreign.read_bytes()).hexdigest()
legacy_directory = Path.home() / '.poise' / 'locks'
legacy_before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in legacy_directory.glob('checkout-*.sqlite3')}
shared_provider = Path.home() / 'protected-codex-component'
shared_provider.mkdir(exist_ok=True)
(shared_provider / 'auth.json').write_text('{"auth_mode":"component-fixture-no-credentials"}')
(shared_provider / 'history-sentinel').write_text('retained shared provider history fixture')
shared_before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in shared_provider.iterdir()}
os.environ['CODEX_HOME'] = str(shared_provider)
worker = subprocess.Popen([sys.executable, '-u', __file__, 'worker', variant], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    ready = json.loads(worker.stdout.readline())
    assert ready['kind'] == 'allocation-ready', ready
    with api.db() as db:
        original = db.execute('select process_identity,namespace_control,resource_ownership from calls where id=?',
                              (ready['call'],)).fetchone()
    ownership = json.loads(original['resource_ownership'])
    private = json.loads(original['namespace_control'])
    assert ownership['namespace']['state'] == ('requested' if variant == 'before-active' else 'active')
    key = {name: private[name] for name in ('callId', 'correlation', 'token')}
    with process_identity.pinned(original['process_identity'], worker.pid) as pinned:
        assert pinned is not None
        pinned.signal(signal.SIGKILL)
        assert pinned.wait(5)
    assert worker.wait(timeout=5) == -signal.SIGKILL
    deadline = time.monotonic() + 2
    while True:
        observed = native_namespace.control_request(address, 'read', **key)
        if variant != 'before-active':
            assert observed['binding'] == ownership['namespace']['binding']
        if observed['empty']:
            break
        assert time.monotonic() < deadline, observed
        time.sleep(0.005)
    before = api.logs_selected({'latest': [], 'ids': [ready['call']]})[0]
    assert before['status'] == 'failed' and before['resources_settled_at'] is None
    empty_at = time.monotonic()
    deadline = empty_at + 180
    original_root = Path(ready['root'])
    replacement = None
    original_ancestor = None
    foreign_files = {}
    if variant in {'base-replaced', 'data-replaced', 'native-coordination-replaced'}:
        ancestor = api.DATA_DIR if variant == 'data-replaced' else api.DATA_DIR / 'native-resources'
        original_ancestor = ancestor.with_name(f'{ancestor.name}-retained-{variant}')
        ancestor.rename(original_ancestor)
        replacement = Path.home() / f'foreign-{variant}'
        replacement.mkdir()
        with sqlite3.connect(replacement / 'calls.sqlite3') as db:
            db.execute('create table foreign_data(value text)')
            db.execute('insert into foreign_data values(?)', ('protected user data',))
        (replacement / 'responses').mkdir()
        (replacement / 'responses' / 'evidence').write_text('retained authentication evidence')
        foreign_files = {str(path.relative_to(replacement)): hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in replacement.rglob('*') if path.is_file()}
        ancestor.symlink_to(replacement, target_is_directory=True)
        original_root = original_ancestor / (f'native-resources/{ready["call"]}' if variant == 'data-replaced' else ready['call'])
    if variant == 'deleted-before-ack':
        shutil.rmtree(original_root)
        positive = native_namespace.control_request(address, 'read-root', root=ready['root'], **key)
        assert positive['resource']['unlinked'] is True
    if variant == 'cleaner-loss':
        cleaner = subprocess.run([sys.executable, '-u', __file__, 'cleaner', ready['call']], capture_output=True, text=True, timeout=20)
        assert cleaner.returncode == 91 and not cleaner.stderr, cleaner
        assert not original_root.exists()
    if variant == 'unknown-process-error':
        resource_ownership.failure(api.DB, ready['call'], 'resources_unknown')
        with api.db() as db:
            receipt = resource_ownership.read(db, ready['call'])
            receipt['process_pending'] = True
            resource_ownership._write(db, ready['call'], receipt)
    request = urllib.request.Request('http://127.0.0.1:5555/api/storage/maintenance',
                                     data=b'{"dryRun":false}', headers={'Content-Type': 'application/json'}, method='POST')
    if variant == 'paused-maintenance-tick':
        drain = urllib.request.Request('http://127.0.0.1:5555/api/service/drain', data=b'{}', method='POST')
        with urllib.request.urlopen(drain, timeout=5) as response:
            draining = json.load(response)
        assert draining['draining'] is True and draining['idle'] is False
        assert draining['backgroundWork'] > 0
        while True:
            candidate = api.logs_selected({'latest': [], 'ids': [ready['call']]})[0]
            if candidate['resources_settled_at'] is not None:
                break
            assert time.monotonic() < deadline
            time.sleep(0.25)
        maintenance = {'trigger': 'existing-one-minute-opportunity-while-drained'}
        # Release is durable before the cleanup claim retires. Wait for both
        # within the original deadline; neither alone establishes service idle.
        while True:
            with urllib.request.urlopen('http://127.0.0.1:5555/api/service/health', timeout=5) as response:
                drained = json.load(response)
            assert drained['draining'] is True, drained
            if drained['idle'] is True:
                break
            assert time.monotonic() < deadline, drained
            time.sleep(0.25)
        assert drained['draining'] is True and drained['idle'] is True, drained
        assert drained['unsettledNativeCalls'] == 0 and drained['backgroundWork'] == 0, drained
        resume = urllib.request.Request('http://127.0.0.1:5555/api/service/resume', data=b'{}', method='POST')
        with urllib.request.urlopen(resume, timeout=5) as response:
            assert json.load(response)['draining'] is False
    else:
        with urllib.request.urlopen(request, timeout=30) as response:
            maintenance = json.load(response)
    # A periodic pass can already own cleanup when the explicit pass arrives.
    # Its retained retry runs on the existing tick, under the same release bound.
    while True:
        after = api.logs_selected({'latest': [], 'ids': [ready['call']]})[0]
        if after['resources_settled_at'] is not None:
            break
        assert time.monotonic() < deadline, {'maintenance': maintenance, 'call': after}
        time.sleep(0.25)
    # The service reader may still have its earlier snapshot. It must expose
    # the same positive release, not merely accept a row with no release field.
    while True:
        with urllib.request.urlopen(f'http://127.0.0.1:5555/api/agent-logs?id={ready["call"]}', timeout=30) as response:
            decoded = json.load(response)
        assert decoded['quarantined'] == [] and len(decoded['logs']) == 1, decoded
        assert decoded['logs'][0]['id'] == ready['call']
        if decoded['logs'][0].get('resources_settled_at') == after['resources_settled_at']:
            break
        assert time.monotonic() < deadline, decoded
        time.sleep(0.25)
    assert decoded['logs'][0]['resources_settled_at'] == after['resources_settled_at']
    root = original_root
    payload = root / 'disposable-output'
    unchanged = hashlib.sha256(foreign.read_bytes()).hexdigest() == foreign_hash
    if replacement is not None:
        unchanged = unchanged and foreign_files == {
            str(path.relative_to(replacement)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in replacement.rglob('*') if path.is_file()}
    assert unchanged
    assert legacy_before == {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                             for path in legacy_directory.glob('checkout-*.sqlite3')}
    assert shared_before == {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in shared_provider.iterdir()}
    print(json.dumps({'kind': 'native-recovery-component', 'variant': variant, 'source': Path('/opt/poise/RELEASE').read_text().strip(),
                      'original_namespace_positive_empty': observed['empty'], 'call_status': after['status'],
                      'before_release': before['resources_settled_at'], 'after_release': after['resources_settled_at'],
                      'payload_exists': payload.exists(), 'payload_bytes': payload.stat().st_size if payload.exists() else 0,
                      'foreign_unchanged': unchanged, 'maintenance': maintenance,
                      'installed_service_decoder_accepted': True,
                      'metadata_pid_collision_validated': variant == 'metadata-pid-collision',
                      'private_checkout_coordination_reclaimed': variant in {'native-coordination', 'native-coordination-replaced'} and not root.exists(),
                      'shared_lease_inventory_unchanged': True,
                      'shared_auth_and_history_unchanged': True,
                      'seconds_from_original_empty': time.monotonic() - empty_at,
                      'original_resource_state': after['resource_ownership'], 'caller_rows': [after],
                      'provider_or_workflow_acceptance': False}), flush=True)
    assert after['resources_settled_at'] is not None and not root.exists(), \
        'original namespace is positively empty, but actual maintenance leaves its owned disk and reservation pending'
    settled_at = after['resources_settled_at']
    if variant == 'before-active':
        assert after['action'] == 'not_started' and after['outcome'] == 'preflight_failed'
        assert after['resource_ownership']['namespace']['no_effect'] == 'verified-pre-go'
    with urllib.request.urlopen(request, timeout=30) as response:
        repeated = json.load(response)
    assert api.logs_selected({'latest': [], 'ids': [ready['call']]})[0]['resources_settled_at'] == settled_at
    assert repeated.get('nativeCleanupCompleted') == 0
    if original_ancestor is not None:
        ancestor.unlink()
        original_ancestor.rename(ancestor)
finally:
    worker.stdin.close()
    worker.stdout.close()
    stderr = worker.stderr.read()
    worker.stderr.close()
    assert not stderr, stderr

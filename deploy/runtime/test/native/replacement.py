"""Real persistent-home replacement boundary; no provider or work-item actions."""
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from unittest.mock import patch

signal.alarm(90)
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
    addresses.update(value.partition(b'=')[2].decode() for value in environment if value.startswith(b'POISE_NATIVE_CONTROL='))
assert len(addresses) == 1
os.environ['POISE_NATIVE_CONTROL'] = addresses.pop()
os.environ['AGENT_INTERFACE_DATA_DIR'] = json.loads(os.environ['POISE_NATIVE_CONTROL'])['store']['path']
import agent_interface as api
from agent_interface import resource_ownership

mode = sys.argv[-1]
marker = Path.home() / f'replacement-{mode}.json'
foreign = Path.home() / 'replacement-foreign-sentinel'


def health():
    request = urllib.request.Request('http://127.0.0.1:5555/api/service/drain', data=b'', method='POST')
    with urllib.request.urlopen(request, timeout=10) as response:
        answer = json.load(response)
    assert answer['ok'] and answer['draining'], answer
    return answer


if sys.argv[1:2] == ['worker']:
    def body():
        call = api.track('native-action', 'explicit no-effect replacement component', '21', 'example/repo', 'reviewer',
                         'native_action', expected_head='a' * 40, source='poise:behavior-chain',
                         correlation_id=f'replacement-{mode}')
        root = resource_ownership.allocate(api.DB, call, resource_ownership.call_directory(api.DB, call))
        (root / 'owned-output').write_bytes(b'x' * (8 * 1024 * 1024))
        marker.write_text(json.dumps({'call': call, 'root': str(root)}))
        print(marker.read_text(), flush=True)
        if mode == 'cooperative':
            assert os.read(0, 1) == b'X'
            api.finish(call, 'failed', error='Explicit component body completed without any external action',
                       outcome='preflight_failed', action='not_started', error_code='component_no_effect')
        else:
            while True:
                time.sleep(0.1)
    with patch.object(sys, 'argv', ['agent-interface', '--native-action', '--source', 'poise:behavior-chain',
                                 '--correlation-id', f'replacement-{mode}']), patch.object(api, '_main', side_effect=body):
        api.main()
elif sys.argv[1] == 'before':
    foreign.write_bytes(b'foreign persistent fixture')
    worker = subprocess.Popen([sys.executable, '-u', __file__, 'worker', mode], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ready = json.loads(worker.stdout.readline())
    answer = health()
    assert answer['unsettledNativeCalls'] >= 1 and not answer['idle'], answer
    if mode == 'cooperative':
        worker.stdin.write('X')
        worker.stdin.flush()
        output, errors = worker.communicate(timeout=15)
        assert worker.returncode == 0, (output, errors)
        deadline = time.monotonic() + 15
        while True:
            answer = health()
            if answer['idle']:
                break
            assert time.monotonic() < deadline, answer
            time.sleep(0.1)
        assert answer['unsettledNativeCalls'] == 0, answer
        assert not Path(ready['root']).exists()
        rows = api.logs_selected({'latest': [], 'ids': [ready['call']]})
        assert rows[0]['resources_settled_at'] and rows[0]['resource_ownership']['namespace']['state'] == 'settled'
        ready['receipt'] = rows
    else:
        # The container replacement, not process-name matching, ends this original boundary.
        worker.stdin.close()
    marker.write_text(json.dumps(ready))
    print(json.dumps({'kind': 'replacement-before', 'mode': mode, 'health': answer,
                      'call': ready['call'], 'receipt': ready.get('receipt'),
                      'provider_or_workflow_acceptance': False}), flush=True)
else:
    api.init_db()
    original = json.loads(marker.read_text())
    rows = api.logs_selected({'latest': [], 'ids': [original['call']]})
    row = rows[0]
    answer = health()
    assert hashlib.sha256(foreign.read_bytes()).hexdigest() == hashlib.sha256(b'foreign persistent fixture').hexdigest()
    if mode == 'cooperative':
        assert rows == original['receipt'], (rows, original['receipt'])
        assert answer['unsettledNativeCalls'] == 0 and answer['idle'], answer
        assert not Path(original['root']).exists()
    else:
        assert not row['resources_settled_at'], row
        assert Path(original['root']).is_dir()
        assert (Path(original['root']) / 'owned-output').stat().st_blocks * 512 >= 8 * 1024 * 1024
        assert answer['unsettledNativeCalls'] >= 1 and not answer['idle'], answer
        assert row['status'] == 'failed' and row['error_code'] == 'interrupted', row
    with api.db() as database:
        assert database.execute('select count(*) from calls where correlation_id=?', (f'replacement-{mode}',)).fetchone()[0] == 1
    print(json.dumps({'kind': 'replacement-after', 'mode': mode, 'health': answer, 'receipt': rows,
                      'foreignUnchanged': True, 'provider_or_workflow_acceptance': False}), flush=True)

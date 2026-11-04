"""Real allocation/namespace/SQLite component proof. No provider or GitHub work.

The unchanged image must remain alive above the frozen ceilings. The fixed
image must stop only the original Call and retain its typed cause and receipts.
"""
import json
import os
import select
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

signal.alarm(120)
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
from agent_interface import native_namespace, resource_ownership

mode = sys.argv[-1]
correlation = f'limit-{mode}-{uuid4().hex}'
MiB = 1024 * 1024
is_memory = mode in {'memory', 'busy-memory'}
ceilings = {'version': 1, 'memoryBytes': 256 * MiB if is_memory else None,
            'diskBytes': 8 * MiB if not is_memory else None}

if sys.argv[1:2] == ['worker']:
    def allocation():
        call = api.track('native-action', 'real allocation component', '21', 'example/repo', 'reviewer', 'native_action',
                         expected_head='a' * 40, source='poise:behavior-chain', correlation_id=correlation)
        root = resource_ownership.allocate(api.DB, call, resource_ownership.call_directory(api.DB, call))
        if mode == 'neighbor':
            (root / 'heartbeat').write_text(str(time.monotonic()))
        print(json.dumps({'call': call, 'root': str(root)}), flush=True)
        if mode == 'neighbor':
            while not select.select([0], [], [], 0.1)[0]:
                native_namespace.active().require_idle()
                native_namespace.active().read()
                (root / 'next-heartbeat').write_text(str(time.monotonic()))
                (root / 'next-heartbeat').replace(root / 'heartbeat')
            assert os.read(0, 1) == b'X'
            api.finish(call, 'failed', error='component neighbor finished', error_code='component_done')
            return
        # Independent child: actual touched allocations and fsynced blocks.
        body = '''
import mmap, os, sys, tempfile, time
from pathlib import Path
mode, root = sys.argv[1], Path(sys.argv[2])
time.sleep(2)
if mode == 'memory':
    chunks = []
    for _ in range(48):
        chunk = bytearray(8 * 1024 * 1024)
        for offset in range(0, len(chunk), 4096): chunk[offset] = 123
        chunks.append(chunk)
        time.sleep(0.125)
elif mode == 'unavailable':
    root.chmod(0)
else:
    directory = Path('/tmp') if mode == 'deleted-tmp' else root
    fd, name = tempfile.mkstemp(dir=directory)
    with os.fdopen(fd, 'wb', buffering=0) as output:
        if mode.startswith('deleted-'): os.unlink(name)
        for _ in range(64):
            output.write(b'x' * (256 * 1024))
            os.fsync(output.fileno())
            time.sleep(0.125)
        while True: time.sleep(0.1)
while True: time.sleep(0.1)
'''
        child = subprocess.Popen([sys.executable, '-c', body, 'memory' if is_memory else mode, str(root)])
        child.wait()
        raise AssertionError('allocation child ended without enforcement')

    args = ['agent-interface', '--native-action', '--source', 'poise:behavior-chain', '--correlation-id', correlation]
    if mode != 'neighbor':
        args += ['--resource-limits-json', json.dumps(ceilings)]
    with patch.object(sys, 'argv', args), patch.object(api, '_main', side_effect=allocation):
        api.main()
    raise SystemExit(0)

assert sys.argv[1] in ('baseline', 'enforced')
baseline = sys.argv[1] == 'baseline'
headroom = json.loads(os.environ['POISE_COMPONENT_HEADROOM'])
assert headroom['source'] == 'outside-guest-Docker-memory-stats'
assert headroom['freeBytes'] >= 1024 * MiB
assert 0 <= time.time() * 1000 - headroom['measuredAt'] < 5000
neighbor = worker = None
try:
    neighbor = subprocess.Popen([sys.executable, '-u', __file__, 'worker', 'neighbor'], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    other = json.loads(neighbor.stdout.readline())
    worker = subprocess.Popen([sys.executable, '-u', __file__, 'worker', mode], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ready = json.loads(worker.stdout.readline())
    call, root = ready['call'], Path(ready['root'])
    locked = False
    deadline = time.monotonic() + 35
    observed_overrun = False
    initial_memory = None
    observations = []
    empty_observed = None
    while time.monotonic() < deadline:
        with api.db() as db:
            row = dict(db.execute('select * from calls where id=?', (call,)).fetchone())
        ownership = json.loads(row['resource_ownership'])
        if empty_observed is None and row['resources_settled_at'] and ownership['namespace']['state'] == 'settled':
            empty_observed = time.monotonic()
        binding = ownership['namespace']['binding']
        # This reader is independent of the new sampler and its receipt.
        if worker.poll() is None:
            view = Path(f"/proc/{binding['pid']}/root/proc")
            try:
                directories = [view / entry.name for entry in view.iterdir() if entry.name.isdecimal()]
                directories += [Path(f"/proc/{binding[key]['pid']}") for key in ('owner', 'holder')]
                rss = 0
                for directory in directories:
                    rss += int(next(line.split()[1] for line in (directory / 'status').read_text().splitlines()
                                    if line.startswith('VmRSS:'))) * 1024
                if initial_memory is None:
                    initial_memory = rss
                    assert initial_memory < 256 * MiB, initial_memory
                disk = 0
                seen = set()
                for directory in directories:
                    for entry in (directory / 'fd').iterdir():
                        try:
                            name, node = os.readlink(entry), entry.stat()
                        except FileNotFoundError:
                            continue
                        if (name.startswith(str(root)) or name.startswith('/tmp/')) and (node.st_dev, node.st_ino) not in seen:
                            seen.add((node.st_dev, node.st_ino))
                            disk += node.st_blocks * 512
                observations.append({'at': time.monotonic(), 'rssBytes': rss, 'openAllocatedBytes': disk})
                observed_overrun |= rss > 256 * MiB if is_memory else disk > 8 * MiB
                if mode == 'busy-memory' and not locked:
                    with api.db() as writer:
                        writer.execute('begin immediate')
                        time.sleep(2.2)
                    locked = True
            except (FileNotFoundError, ProcessLookupError, StopIteration, PermissionError) as error:
                observations.append({'at': time.monotonic(), 'coverage': 'unavailable', 'error': str(error)[:300]})
        heartbeat = Path(other['root']) / 'heartbeat'
        assert neighbor.poll() is None and heartbeat.exists()
        assert time.monotonic() - float(heartbeat.read_text()) < 2
        if baseline and observed_overrun:
            assert worker.poll() is None
            print(json.dumps({'kind': 'unchanged-live-overrun', 'mode': mode, 'call': call,
                              'initialRssBytes': initial_memory, 'samples': observations, 'neighborAlive': True}), flush=True)
            break
        if not baseline and row['resources_settled_at']:
            # Maintenance may publish release while the original owner is
            # still committing its actual post-signal timing annotation.
            if worker.poll() is None:
                time.sleep(0.05)
                continue
            with api.db() as db:
                row = dict(db.execute('select * from calls where id=?', (call,)).fetchone())
            assert initial_memory is not None and initial_memory < 256 * MiB
            assert ownership['namespace']['state'] == 'settled'
            guard = json.loads(row['resource_guard'])
            failure = guard['failure']
            expected = 'resource_memory_exceeded' if is_memory else 'resource_measurement_unavailable' if mode == 'unavailable' else 'resource_disk_exceeded'
            assert row['error_code'] == expected, row
            if 'signalMonotonic' in failure:
                assert failure['signalMonotonic'] - failure['observedMonotonic'] <= 2, failure
            else:
                # Positive emptiness within two seconds is stronger evidence
                # than stop initiation within two; it invents no signal time.
                assert empty_observed is not None and empty_observed - failure['observedMonotonic'] <= 2, row
            assert time.monotonic() - failure['observedMonotonic'] <= 10, failure
            if is_memory:
                assert guard['peakMemoryBytes'] <= 256 * MiB + 192 * MiB, guard
                assert max(sample['rssBytes'] for sample in observations if 'rssBytes' in sample) <= 256 * MiB + 192 * MiB
            elif mode != 'unavailable':
                assert guard['peakDiskBytes'] <= 8 * MiB + 8 * MiB, guard
                assert max(sample['openAllocatedBytes'] for sample in observations if 'openAllocatedBytes' in sample) <= 8 * MiB + 8 * MiB
            assert not root.exists(), root
            assert row['action'] is None and row['outcome'] is None
            with urllib.request.urlopen(f'http://127.0.0.1:5555/api/agent-logs?id={call}', timeout=10) as response:
                decoded = json.load(response)
            assert decoded['quarantined'] == [] and len(decoded['logs']) == 1, decoded
            assert decoded['logs'][0]['resource_guard'] == guard, decoded
            receipt = api.logs_selected({'latest': [], 'ids': [call], 'correlations': []})
            assert decoded['logs'][0]['resources_settled_at'] == receipt[0]['resources_settled_at'], decoded
            print(json.dumps({'kind': 'actual-live-resource-stop', 'mode': mode, 'call': call,
                              'initialRssBytes': initial_memory, 'samples': observations, 'receipt': receipt,
                              'headroom': headroom, 'neighborAlive': True, 'installedServiceDecoderAccepted': True,
                              'signalTimingAvailable': 'signalMonotonic' in failure,
                              'emptyObservedMonotonic': empty_observed}), flush=True)
            break
        if not baseline and worker.poll() is not None and not row['resources_settled_at']:
            raise AssertionError({'row': row, 'stdout': worker.stdout.read(), 'stderr': worker.stderr.read()})
        time.sleep(0.05)
    else:
        raise AssertionError({'mode': mode, 'baseline': baseline, 'overrun': observed_overrun})
finally:
    if worker is not None and worker.poll() is None:
        worker.kill()
    if worker is not None:
        worker.communicate(timeout=15)
    if neighbor is not None:
        if neighbor.poll() is None:
            neighbor.stdin.write('X')
            neighbor.stdin.flush()
        output, errors = neighbor.communicate(timeout=15)
        if neighbor.returncode != 0:
            with api.db() as db:
                after = dict(db.execute('select id,error,error_code,resource_ownership,resources_settled_at from calls where id=?', (other['call'],)).fetchone())
            print(json.dumps({'kind': 'neighbor-cleanup-failure', 'row': after}), flush=True)
        if not baseline:
            assert neighbor.returncode == 0, errors

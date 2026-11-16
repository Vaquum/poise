"""Exercise the replacement fixture's after branch without a running container."""

import ast
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, call


FIXTURE = Path(__file__).resolve().parents[1] / 'runtime/test/native/replacement.py'
source = ast.parse(FIXTURE.read_text(), filename=str(FIXTURE))
# Skip the container-only controller bootstrap and the worker/before branches.
AFTER = compile(ast.Module(body=source.body[-1].orelse[0].orelse, type_ignores=[]), str(FIXTURE), 'exec')


class RuntimeReplacementTest(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        root = Path(work.name)
        rows = [{'id': 'original-call', 'resources_settled_at': 'original-settlement',
                 'resource_ownership': {'namespace': {'state': 'settled'}}}]
        marker = root / 'replacement-cooperative.json'
        marker.write_text(json.dumps({'call': 'original-call', 'root': str(root / 'owned'), 'receipt': rows}))
        foreign = root / 'foreign'
        foreign.write_bytes(b'foreign persistent fixture')
        self.api = MagicMock()
        self.api.logs_selected.return_value = rows
        self.api.db.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = (1,)
        self.health = Mock()
        self.clock = Mock()
        self.print = Mock()
        self.namespace = dict(api=self.api, marker=marker, foreign=foreign, mode='cooperative',
                              health=self.health, time=self.clock, Path=Path, hashlib=hashlib,
                              json=json, print=self.print)
        self.busy = {'ok': True, 'draining': True, 'activeChatTurns': 0, 'runningCallerCalls': 0,
                     'unsettledNativeCalls': 0, 'backgroundWork': 1, 'idle': False}

    def test_waits_for_background_startup_work_to_settle(self):
        idle = {**self.busy, 'backgroundWork': 0, 'idle': True}
        self.health.side_effect = [self.busy, idle]
        self.clock.monotonic.side_effect = [100, 100]

        exec(AFTER, self.namespace)

        self.assertEqual(self.health.call_count, 2)
        self.clock.sleep.assert_called_once_with(0.1)
        result = json.loads(self.print.call_args.args[0])
        self.assertEqual(result['health'], idle)
        self.assertEqual(result['receipt'], self.api.logs_selected.return_value)
        self.assertTrue(result['foreignUnchanged'])
        self.api.db.return_value.__enter__.return_value.execute.assert_called_once_with(
            'select count(*) from calls where correlation_id=?', ('replacement-cooperative',))

    def test_fails_at_the_fixed_deadline_with_the_latest_busy_response(self):
        last = {**self.busy, 'backgroundWork': 2}
        self.health.side_effect = [self.busy, self.busy, last]
        self.clock.monotonic.side_effect = [100, 100, 114.9, 115]

        with self.assertRaises(AssertionError) as failure:
            exec(AFTER, self.namespace)

        self.assertIs(failure.exception.args[0], last)
        self.assertEqual(self.health.call_count, 3)
        self.assertEqual(self.clock.sleep.call_args_list, [call(0.1), call(0.1)])
        self.print.assert_not_called()

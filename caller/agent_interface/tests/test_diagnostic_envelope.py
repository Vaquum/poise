"""Every Caller process diagnostic carries the complete envelope Poise validates.

server/process-diagnostic.ts quarantines any agent log row whose diagnostic
lacks version/source/severity, string operation/phase/outcome/stderr, or
boolean stderr_truncated, and the behavior loses the run's result. These
tests pin the producer side of that contract.
"""
import json
import shutil
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import process_diagnostic


def assert_complete_envelope(value):
    assert value["version"] == 1
    assert value["source"] == "caller"
    assert value["severity"] == "error"
    for key in ("operation", "phase", "outcome", "stderr"):
        assert isinstance(value[key], str), key
    assert isinstance(value["stderr_truncated"], bool)


class DiagnosticEnvelopeCase(TestCase):
    def test_envelope_carries_the_complete_contract(self):
        value = process_diagnostic.diagnostic_envelope(
            operation="provider.review", phase="validating", outcome="invalid_output",
            stderr="cause", provider="grok", submission="none")
        assert_complete_envelope(value)
        self.assertEqual((value["provider"], value["submission"]), ("grok", "none"))

    def test_envelope_defaults_to_untruncated_empty_stderr(self):
        value = process_diagnostic.diagnostic_envelope(
            operation="issue.checkout", phase="checking_out", outcome="timed_out")
        assert_complete_envelope(value)
        self.assertEqual((value["stderr"], value["stderr_truncated"]), ("", False))


class FinishFallbackCase(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        patches = (("DB", root / "calls.sqlite3"), ("RESPONSES", root / "responses"))
        for name, value in patches:
            target = patch.object(agent_interface, name, value)
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()

    def test_response_persist_failure_stores_a_complete_diagnostic(self):
        id_ = agent_interface.track("opus-5-max", "private-prompt", repo="acme/app", behavior="pr_review")
        shutil.rmtree(agent_interface.RESPONSES)
        agent_interface.finish(id_, "completed", response="verdict", outcome="approved",
                               head_sha="a" * 40, action="approved")
        with agent_interface.db() as conn:
            row = conn.execute("select response_path, diagnostic from calls where id=?", (id_,)).fetchone()
        self.assertIsNone(row["response_path"])
        diagnostic = json.loads(row["diagnostic"])
        assert_complete_envelope(diagnostic)
        self.assertTrue(diagnostic["stderr"])

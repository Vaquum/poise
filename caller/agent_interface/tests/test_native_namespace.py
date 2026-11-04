"""Negative native boundary contracts; positive kernel proof runs on Linux."""
import json

import pytest

from agent_interface import native_namespace


@pytest.mark.parametrize("call_id,correlation,token", [
    ("../foreign", "original", "b" * 32),
    ("a" * 32, "", "b" * 32),
    ("a" * 32, "another#issue", "b" * 32),
    ("a" * 32, "original", "another"),
])
def test_invalid_invocation_never_contacts_a_controller(monkeypatch, call_id, correlation, token):
    def unexpected():
        raise AssertionError("invalid invocation reached the workspace controller")

    monkeypatch.setattr(native_namespace, "control_address", unexpected)
    with pytest.raises(ValueError, match="original native namespace identity"):
        native_namespace.Namespace(call_id, correlation, token=token)


def test_unsupported_platform_refuses_before_any_local_process_or_socket(monkeypatch):
    monkeypatch.setattr(native_namespace.sys, "platform", "darwin")
    with pytest.raises(native_namespace.NamespaceUnavailable, match="supported unprivileged Linux workspace"):
        native_namespace.control_address()


def test_missing_controller_is_not_an_unsupported_platform_fallback(monkeypatch):
    monkeypatch.setattr(native_namespace.sys, "platform", "linux")
    monkeypatch.setattr(native_namespace.os, "getuid", lambda: 10001)
    monkeypatch.delenv("POISE_NATIVE_CONTROL", raising=False)
    with pytest.raises(native_namespace.NamespaceUnavailable, match="workspace supervisor"):
        native_namespace.control_address()


def test_older_controller_cannot_advertise_safe_persistent_home_cleanup(monkeypatch):
    monkeypatch.setattr(native_namespace, "control_address", lambda: {"store": {"path": "/isolated"}})
    monkeypatch.setattr(native_namespace, "control_request", lambda *args: {"resourceProtocol": 2})
    with pytest.raises(native_namespace.NamespaceUnavailable, match="persistent-home reclamation support"):
        native_namespace.require_resource_controller()


@pytest.mark.parametrize("evidence", [
    {"pids": [], "empty": True},
    {"callId": "f" * 32, "correlation": "original", "binding": {"namespace": "pid:[9]"}, "pids": [], "empty": True, "namespace": "pid:[9]"},
    {"callId": "a" * 32, "correlation": "original", "binding": {"namespace": "pid:[9]"}, "pids": [2], "empty": True, "namespace": "pid:[9]"},
    {"callId": "a" * 32, "correlation": "original", "binding": {"namespace": "pid:[9]"}, "pids": [], "empty": True, "namespace": "pid:[10]"},
])
def test_missing_or_contradictory_evidence_cannot_authorize_retirement(monkeypatch, evidence):
    monkeypatch.setattr(native_namespace, "control_address", lambda: {"version": 1, "instance": "c" * 32, "path": "/test-only"})
    requests = []

    def control(address, operation, **values):
        requests.append(operation)
        return {"available": True} if operation == "hello" else evidence

    monkeypatch.setattr(native_namespace, "control_request", control)
    scope = native_namespace.Namespace("a" * 32, "original")
    scope.binding = {"namespace": "pid:[9]"}
    with pytest.raises(RuntimeError, match="differs from its original registration"):
        scope.release()
    assert requests == ["hello", "read"]


def test_unavailable_reader_never_certifies_emptiness(monkeypatch):
    monkeypatch.setattr(native_namespace, "control_address", lambda: {"version": 1, "instance": "c" * 32, "path": "/test-only"})
    scope = native_namespace.Namespace.__new__(native_namespace.Namespace)
    scope.address = {"version": 1, "instance": "c" * 32, "path": "/test-only"}
    scope.key = {"callId": "a" * 32, "correlation": "original", "token": "b" * 32}
    scope.binding = {"namespace": "pid:[9]"}

    def unavailable(*args, **kwargs):
        raise OSError("original controller was lost")

    monkeypatch.setattr(native_namespace, "control_request", unavailable)
    with pytest.raises(OSError, match="original controller was lost"):
        scope.read()


def test_controller_frame_has_a_fixed_size_bound_before_connecting(monkeypatch):
    def unexpected(*args, **kwargs):
        raise AssertionError("oversized frame reached a socket")

    monkeypatch.setattr(native_namespace.socket, "socket", unexpected)
    with pytest.raises(RuntimeError, match="request exceeds its limit"):
        native_namespace.control_request({"version": 1, "instance": "c" * 32, "path": "/test-only"},
                                         "register", identity=json.dumps({"oversized": "x" * (16 * 1024)}))


def test_capability_reports_the_refusal_without_starting_a_behavior(monkeypatch):
    monkeypatch.setattr(native_namespace.sys, "platform", "darwin")
    assert native_namespace.capability() == {"version": 1, "supported": False,
        "error": "v2 cleanup requires a supported unprivileged Linux workspace"}

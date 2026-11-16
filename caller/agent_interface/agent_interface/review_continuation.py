"""Opt-in, receipt-owned continuation of structured review and finalization."""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from hashlib import sha256
from time import monotonic, time
from uuid import uuid4

from . import caller_store, progress, resource_ownership, review_budget, review_receipt, review_stages
from .process_diagnostic import diagnostic_envelope

MAX_UNITS = 256
MAX_STORAGE_BYTES = 32_000_000
MAX_STALLED_ATTEMPTS = 2
FINALIZATION_RESERVE_SECONDS = 120
OBLIGATION_TIME_MS = 2 * review_budget.REVIEW_TIMEOUT_SECONDS * 1000
_request: ContextVar[tuple[str, str | None, int | None] | None] = ContextVar("review_continuation_request", default=None)


class Continuation(review_budget.ReviewLimitError):
    def __init__(self, reason: str, result: dict):
        held = result["outcome"] == "held"
        diagnostic = diagnostic_envelope(operation="provider.review", phase=progress.phase() or "analysis",
                                         outcome="held", message=reason[:500],
                                         submission="uncertain" if result["publication_started"] else "none") if held else None
        super().__init__(reason, "review_continuation_held" if held else "review_continuation_required", diagnostic)
        self.result = {**result, "reason": reason}


@contextmanager
def request(slot: str | None, resume: str | None, units_per_call: int | None = None):
    if (resume or units_per_call is not None) and not slot:
        raise ValueError("review continuation arguments require --review-slot")
    if slot is not None and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", slot):
        raise ValueError("review slot must be a bounded stable reviewer slot identity")
    if resume is not None and not re.fullmatch(r"[0-9a-f]{32}:[0-9]+", resume):
        raise ValueError("resume review must name ROOT_CALL_ID:GENERATION")
    if units_per_call is not None and not 1 <= units_per_call <= 32:
        raise ValueError("review unit limit must be between 1 and 32")
    token = _request.set((slot, resume, units_per_call) if slot is not None else None)
    try:
        yield
    finally:
        _request.reset(token)


def enabled() -> bool:
    return _request.get() is not None


def select_automatically() -> bool:
    request = _request.get()
    return request is not None and request[1] is None and request[2] is not None


def ordinary_review() -> None:
    _request.set(None)


def digest(value) -> str:
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def matches_followup(issue: dict, effect: dict) -> bool:
    return (digest(issue.get("body")) == effect["body_sha"] and issue.get("title") == effect["title"]
            and str((issue.get("user") or {}).get("login", "")).lower() == effect["actor"].lower()
            and type(issue.get("number")) is int and issue["number"] > 0)


def analysis_basis(packet: dict, policy: str) -> str:
    # Do not hash volatile GitHub counters/timestamps on the pull object.
    requested, bound = _request.get(), review_receipt._call.get()
    if requested and requested[1] and bound:
        with caller_store.connect(bound[0]) as conn:
            original = _artifact(conn, requested[1].split(":")[0])
        finalization = original.get("review_progress", {}).get("finalization", {})
        effect = finalization.get("followup")
        if effect:
            # Only our exact original issue may be removed from the live basis.
            # A missing search result never proves its creation failed.
            issues = packet.get("linked_issues", [])
            matches = [issue for issue in issues if matches_followup(issue, effect)]
            if len(matches) == 1:
                packet = {**packet, "linked_issues": [issue for issue in issues if issue is not matches[0]]}
    pull = packet["pull"]
    material = {key: value for key, value in packet.items() if key != "pull"}
    return digest({"packet": material, "base": pull["base"]["sha"], "title": pull["title"],
                   "body": pull.get("body") or "", "policy": policy})


def _artifact(conn, call_id: str) -> dict:
    row = conn.execute("select artifact from calls where id=?", (call_id,)).fetchone()
    if row is None:
        raise RuntimeError("review continuation lacks its original native receipt")
    return json.loads(row[0] or "{}")


def _write(conn, call_id: str, artifact: dict) -> None:
    encoded = json.dumps(artifact)
    if len(encoded.encode()) > 128 * 1024:
        raise RuntimeError("review continuation exceeds its receipt bound")
    conn.execute("update calls set artifact=? where id=?", (encoded, call_id))


def authority(conn, call_id: str, artifact: dict, *, publishing: bool = False) -> bool:
    """Use the same transaction as response retention / the native POST fence."""
    link = artifact.get("review_resume")
    if link is None:
        return False
    original = _artifact(conn, link["root_call"])
    saved = original["review_progress"]
    if saved["owner"] != call_id or saved["generation"] != link["generation"] \
            or saved["phase"] != "finalizing" or not saved.get("complete") \
            or saved["basis"] != link["basis"] or saved.get("publisher") \
            or artifact["review_context"]["analysis_sha"] != link["analysis_sha"] \
            or digest(artifact.get("verification_candidates", {})) != link["verification_sha"]:
        raise RuntimeError("review continuation has no complete, exclusively reserved finalization")
    finalization = saved.get("finalization", {})
    if link.get("publication_call", call_id) != finalization.get("call", call_id):
        raise RuntimeError("review continuation differs from its original publication identity")
    response_sha = finalization.get("response_sha")
    if response_sha and digest(artifact.get("review_response")) != response_sha:
        raise RuntimeError("retained review response differs from its original finalization")
    if publishing:
        if finalization and finalization["step"] != "submitting":
            raise RuntimeError("review finalization has not reserved its original submission")
        if finalization.get("followup") and not finalization["followup"].get("issue"):
            raise RuntimeError("original follow-up creation must be reconciled before review submission")
        saved.update(phase="publishing", publisher=finalization.get("call", call_id))
        _write(conn, link["root_call"], original)
    return True


def reconciled(call_id: str, receipt: dict) -> bool:
    bound = review_receipt._call.get()
    if not enabled() or bound is None or bound[1] != call_id:
        return False
    with caller_store.connect(bound[0]) as conn:
        current = _artifact(conn, call_id)
        link = current.get("review_resume")
        if not link or current.get("review_reconciliation") != receipt:
            return False
        saved = _artifact(conn, link["root_call"])["review_progress"]
        return (saved["owner"] == call_id and saved["generation"] == link["generation"]
                and saved.get("publisher") == receipt["review_response"]["invocation_id"]
                and digest(receipt["review_response"]) == saved["finalization"]["response_sha"])


class Session:
    def __init__(self, packet: str, model: str):
        from . import RESPONSES
        bound, requested = review_receipt._call.get(), _request.get()
        if bound is None or requested is None:
            raise RuntimeError("review continuation requires a bound native invocation and slot")
        self.database, self.call = bound
        self.responses = RESPONSES
        slot, resume, self.units_per_call = requested
        self.root = resume.split(":")[0] if resume else self.call
        self.saved = {}
        self.finalization = None
        expected = int(resume.split(":")[1]) if resume else 0
        self.generation = expected
        self.meter = monotonic()
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            current = _artifact(conn, self.call)
            row = conn.execute(f"select actor,behavior,status,{resource_ownership.MANAGED_CALLS},source from calls where id=?",
                               (self.call,)).fetchone()
            if row[2] != "running" or not row[3] or row[1] not in {"pr_review", "pr_approve"}:
                raise RuntimeError("review continuation requires a running managed PR review")
            basis = digest({"analysis": current["review_context"]["analysis_sha"], "actor": row[0],
                            "behavior": row[1], "model": model, "slot": slot, "policy": review_budget.REVIEW_POLICY})
            if not resume:
                existing = conn.execute("select id,artifact from calls where repo=? and pr_id=? and actor=? and behavior=? "
                    "and (json_extract(artifact,'$.review_progress.basis')=? or "
                    "(json_extract(artifact,'$.review_progress.finalization.slot')=? "
                    "and json_extract(artifact,'$.review_context.head_sha')=? "
                    "and json_extract(artifact,'$.review_context.context_sha')=?)) limit 1",
                    (json.loads(packet)["repository"], str(json.loads(packet)["pull_number"]), row[0], row[1], basis,
                     slot, current["review_context"]["head_sha"], current["review_context"]["context_sha"])).fetchone()
                if existing:
                    self.root = existing[0]
                    self.saved = json.loads(existing[1])["review_progress"]
                    self.generation = self.saved["generation"]
                    self.stop(f"saved review already exists; resume {self.root}:{self.generation}")
            original = _artifact(conn, self.root)
            saved = original.get("review_progress")
            if saved:
                self.saved = saved
            if resume:
                if not saved:
                    self.stop("review continuation checkpoint is missing")
                original_source = conn.execute("select source from calls where id=?", (self.root,)).fetchone()[0]
                if original_source != row[4]:
                    self.stop("review continuation belongs to a different launch source")
                if saved["phase"] in {"finalizing", "publishing"} and not saved.get("finalization"):
                    self.stop(f"review finalization belongs to Call {saved.get('publisher') or saved['owner']}; reconcile that Call")
                self.finalization = saved.get("finalization")
                reconciling = self.finalization and self.finalization["step"] == "submitting"
                if saved["basis"] != basis and not reconciling:
                    self.stop("material review basis changed; saved analysis and repair verifications are invalid")
                if saved["generation"] != expected:
                    self.stop("review continuation generation changed; refresh the saved receipt")
                if saved["phase"] == "held":
                    self.stop(saved["reason"])
                previous = conn.execute("select status,resources_settled_at,resource_ownership,artifact from calls where id=?",
                                        (saved["last_call"],)).fetchone()
                if not previous or previous[0] == "running" or not resource_ownership.publication_released(
                        previous[1], previous[2], json.loads(previous[3] or "{}")):
                    self.stop("previous review claimant has not released its resources")
                if self.finalization:
                    publisher = _artifact(conn, self.finalization["call"])
                    identity = conn.execute("select actor,behavior from calls where id=?", (self.finalization["call"],)).fetchone()
                    if identity != row[:2] or self.finalization["slot"] != slot:
                        self.stop("material review basis changed; original finalization identity differs")
                    response = publisher.get("review_response")
                    if not self.finalization.get("response_sha") or digest(response) != self.finalization["response_sha"]:
                        self.stop("retained review response differs from its original finalization")
                    context = current["review_context"]
                    if any(response.get(key) != context.get(key) for key in
                           ("repository", "pull_number", "head_sha", "context_sha", "model")):
                        self.stop("material review basis changed; original finalization cannot publish")
                used = review_budget.usage()
                saved["spent_ms"] += math.ceil((used["used_seconds"] if used else 0) * 1000)
            else:
                if saved is not None:
                    self.stop("review continuation already exists on this Call")
                used = review_budget.usage()
                saved = {"basis": basis, "generation": 0, "phase": "analyzing", "owner": None,
                         "allowance_ms": OBLIGATION_TIME_MS,
                         "spent_ms": math.ceil((used["used_seconds"] if used else 0) * 1000),
                         "retained_bytes": 0, "attempts": 0, "complete": False}
            saved.update(owner=self.call, last_call=self.call, generation=expected + 1,
                         phase="publishing" if self.finalization and self.finalization["step"] == "submitting"
                         else "finalizing" if self.finalization else "analyzing")
            self.saved = saved
            self.generation = saved["generation"]
            original["review_progress"] = saved
            _write(conn, self.root, original)
            current = _artifact(conn, self.call)
            if self.finalization:
                current["review_response"] = response
                if self.finalization["step"] == "submitting":
                    current["phase"] = "submitting_review"
                elif self.finalization.get("followup"):
                    current["phase"] = "filing_followup"
            if self.finalization:
                from . import utc_stamp
                publisher_row = conn.execute("select started_at from calls where id=?", (self.finalization["call"],)).fetchone()
                try:
                    publisher_started_at = utc_stamp(publisher_row[0]) if publisher_row else None
                except (TypeError, ValueError, OSError, OverflowError):
                    publisher_started_at = None
                if publisher_started_at is None:
                    self.stop("original finalization lacks its publication start")
                publication = {"publication_call": self.finalization["call"],
                               "publisher_started_at": publisher_started_at}
            else:
                publication = {}
            # The link names the basis the resumed computation ran against. A
            # reconciling resume tolerates live packet drift, so the live basis
            # would disagree with the checkpoint copied from saved progress.
            current["review_resume"] = {"root_call": self.root, "generation": self.generation, "basis": saved["basis"],
                                       "slot": slot,
                                       "analysis_sha": current["review_context"]["analysis_sha"],
                                       "verification_sha": digest(current.get("verification_candidates", {})),
                                       **publication}
            self.retain_progress(conn, saved, current)
        self.meter = monotonic()
        self.live_packet = packet
        self.packet = packet
        if saved.get("checkpoint"):
            self.state = self.read(saved["checkpoint"])
            self.manifest = self.read(saved["manifest"])
            self.packet = self.read(self.manifest["packet"])
        else:
            self.state = {"unit": 0, "results": [], "inspection": [], "pending": [],
                          "provisional": [], "verified": {}, "stalled": 0}
            self.manifest = None
        if self.finalization:
            if self.state["unit"] != len(self.manifest["units"]) + 1 \
                    or len(self.state["results"]) != self.state["unit"]:
                self.stop("retained finalization lacks complete source and integration evidence")
            for reference in self.state["results"]:
                self.result(reference)

    def retain_finalization(self, verdict: dict, head: str, step: str) -> None:
        review_receipt.retain_verdict(verdict, head)
        reference = self.put(verdict)
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            current = _artifact(conn, self.call)
            finalization = saved.get("finalization", {"call": self.call, "slot": _request.get()[0]})
            finalization.update(verdict=reference, step=step, response_sha=digest(current["review_response"]))
            saved["finalization"] = self.finalization = finalization
            _write(conn, self.root, original)

    def begin_review(self, action: str) -> None:
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved["finalization"].update(step="submitting", action=action)
            self.finalization = saved["finalization"]
            _write(conn, self.root, original)

    def finalization_failure(self, error: BaseException) -> None:
        diagnostic = getattr(error, "diagnostic", None) or {}
        transient = getattr(error, "code", None) == "review_budget_exhausted" \
            or diagnostic.get("outcome") == "timed_out"
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved["spent_ms"] += math.ceil((monotonic() - self.meter) * 1000)
            resumable = transient and saved.get("finalization") is not None \
                and saved["allowance_ms"] > saved["spent_ms"]
            saved.update(phase="finalizing" if resumable else "held", reason=str(error))
            _write(conn, self.root, original)
        self.stop(str(error), resumable=resumable)

    def remap(self, function) -> None:
        def execute(grant):
            with review_budget.ReviewBudget(grant, cap=grant):
                function()
        self.funded(execute, review_budget.timeout(600))

    def followup_issue(self) -> dict | None:
        effect = self.finalization.get("followup")
        if not effect:
            return None
        if effect.get("issue"):
            return effect["issue"]
        matches = [issue for issue in json.loads(self.live_packet).get("linked_issues", []) if matches_followup(issue, effect)]
        if len(matches) != 1:
            self.stop("original follow-up creation is uncertain; reconcile that Call before another write")
        return self.confirm_followup(matches[0])

    def begin_followup(self, title: str, body: str, actor: str) -> str:
        body = body.rstrip() + f"\n\n<!-- poise-invocation {self.finalization['call']} -->"
        node = json.loads(self.packet)
        original_body = body.strip() + f"\n\nRelated PR: https://github.com/{node['repository']}/pull/{node['pull_number']}"
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            if saved["finalization"].get("followup"):
                self.stop("original follow-up creation already attempted; reconcile that Call")
            saved["finalization"]["followup"] = {"title": title, "body_sha": digest(original_body), "actor": actor}
            self.finalization = saved["finalization"]
            _write(conn, self.root, original)
            current = _artifact(conn, self.call)
            current["phase"] = "filing_followup"
            _write(conn, self.call, current)
        return body

    def confirm_followup(self, issue: dict) -> dict:
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved["finalization"]["followup"]["issue"] = {
                "number": issue["number"], "html_url": issue.get("html_url") or issue.get("url")}
            self.finalization = saved["finalization"]
            _write(conn, self.root, original)
        return issue

    def reconcile_review(self, pwd: str, pr: str, actor: str) -> str:
        from .atoms import pr_ref
        response = self.read(self.finalization["verdict"])
        with caller_store.connect(self.database) as conn:
            retained = _artifact(conn, self.finalization["call"])["review_response"]
        args = [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), "--pull-action-state", pr_ref(pr),
                "--queue-evidence", "--token-user", actor]
        done = self.funded(lambda grant: subprocess.run(args, cwd=pwd, text=True, capture_output=True, timeout=grant),
                           review_budget.timeout(60, reserve=review_budget.FINAL_CHECK_SECONDS),
                           reserve=review_budget.FINAL_CHECK_SECONDS)
        if done.returncode:
            self.stop("cannot reconcile the original review publication: " + (done.stderr or done.stdout)[:500])
        state = json.loads(done.stdout)
        expected = {"request_changes": "CHANGES_REQUESTED", "reviewed_clean": "COMMENTED", "approve": "APPROVED"}[self.finalization["action"]]
        matches = [item for item in state["my_reviews"] if item.get("invocation_id") == retained["invocation_id"]]
        if state.get("repository") != retained["repository"] or state.get("pull_number") != retained["pull_number"] \
                or state.get("head_sha") != retained["head_sha"] or state.get("review_context") != retained["context_sha"] \
                or len(matches) != 1:
            self.stop("original review publication is uncertain; reconcile that Call before another write")
        item = matches[0]
        submitted = datetime.fromisoformat(item["submitted_at"].replace("Z", "+00:00"))
        if item.get("review_response") != retained or item.get("state") != expected \
                or item.get("commit_id") != retained["head_sha"] or type(item.get("id")) is not int or item["id"] <= 0 \
                or submitted.tzinfo is None or not retained["completed_at"] <= submitted.timestamp() * 1000 + 999 \
                <= time() * 1000 + 999:
            self.stop("original review publication differs from its retained verdict")
        receipt = {"action": {"CHANGES_REQUESTED": "requested_changes", "COMMENTED": "reviewed_clean", "APPROVED": "approved_pr"}[expected],
                   "review_id": item["id"], "head_sha": retained["head_sha"], "review_response": retained,
                   "submitted_at": item["submitted_at"]}
        review_receipt.record(json.dumps(receipt))
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            self.owned(conn)
            current = _artifact(conn, self.call)
            current["review_reconciliation"] = receipt
            _write(conn, self.call, current)
        return json.dumps(response, ensure_ascii=False) + "\n" + json.dumps(receipt)

    def stop(self, reason: str, *, resumable: bool = False) -> None:
        raise Continuation(reason, {"outcome": "continuation_required" if resumable else "held",
                                    "root_call": self.root, "generation": self.saved.get("generation", self.generation),
                                    "unit": getattr(self, "state", {}).get("unit"),
                                    "remaining_ms": max(0, self.saved.get("allowance_ms", 0) - self.saved.get("spent_ms", 0)),
                                    "attempts": self.saved.get("attempts", 0),
                                    "publication_started": bool(self.finalization and
                                        (self.finalization.get("followup") or self.finalization["step"] == "submitting"))})

    def owned(self, conn) -> tuple[dict, dict]:
        original = _artifact(conn, self.root)
        saved = original["review_progress"]
        self.saved = saved
        row = conn.execute("select status,error_code from calls where id=?", (self.call,)).fetchone()
        if saved["owner"] != self.call or saved["generation"] != self.generation \
                or saved["phase"] not in {"analyzing", "finalizing", "publishing"} or not row or row[0] != "running" \
                or row[1] in {"stopping", "stopped"}:
            self.stop("stale review claimant cannot advance or finalize saved analysis")
        return original, saved

    def read(self, reference: dict):
        if not isinstance(reference, dict) or set(reference) != {"id", "sha256", "bytes"} \
                or not isinstance(reference["id"], str) or not re.fullmatch(r"[0-9a-f]{32}", reference["id"]) \
                or not isinstance(reference["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", reference["sha256"]) \
                or type(reference["bytes"]) is not int or not 0 < reference["bytes"] <= MAX_STORAGE_BYTES:
            self.stop("review evidence reference is malformed")
        path = caller_store.response(self.responses / f"{reference['id']}.txt", self.responses)
        try:
            with path.open("rb") as handle:
                raw = handle.read(reference["bytes"] + 1)
            if len(raw) != reference["bytes"] or sha256(raw).hexdigest() != reference["sha256"]:
                self.stop("retained review evidence digest or length differs")
            return json.loads(raw)
        except (OSError, ValueError) as error:
            self.stop(f"retained review evidence is missing or malformed: {error}")

    def put(self, value) -> dict:
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        reference = {"id": uuid4().hex, "sha256": sha256(raw.encode()).hexdigest(), "bytes": len(raw.encode())}
        # Charge before allocation. An interruption or orphaned write cannot
        # restore storage allowance on restart.
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            if saved["retained_bytes"] + reference["bytes"] > MAX_STORAGE_BYTES:
                self.stop("cumulative retained review storage allowance exhausted")
            saved["retained_bytes"] += reference["bytes"]
            _write(conn, self.root, original)
        caller_store.write_response_text(self.responses / f"{reference['id']}.txt", self.responses, raw)
        return reference

    def retain_progress(self, conn, saved: dict, current: dict) -> None:
        current["review_resume"]["generation"] = self.generation
        if saved.get("last_progress_at") is not None:
            current["review_checkpoint"] = {"root_call": self.root, **{key: saved[key] for key in (
                "basis", "generation", "unit", "required_units", "attempts", "spent_ms", "allowance_ms", "last_progress_at", "progress_call",
            )}}
        _write(conn, self.call, current)

    def checkpoint(self, *, advanced: bool = False) -> None:
        reference = self.put(self.state)
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved.update(checkpoint=reference, generation=self.generation + 1, unit=self.state["unit"],
                         required_units=len(self.manifest["units"]) + 1)
            if advanced:
                saved["last_progress_at"] = max(saved.get("last_progress_at", 0), int(time() * 1000))
                saved["progress_call"] = self.call
            self.generation += 1
            _write(conn, self.root, original)
            self.retain_progress(conn, saved, _artifact(conn, self.call))

    def initialize(self, repository) -> None:
        if self.manifest is not None:
            return
        packet = self.funded(lambda grant: repository.diff_packet(self.packet, MAX_STORAGE_BYTES // 3, timeout_s=grant),
                             review_budget.timeout(review_budget.REVIEW_TIMEOUT_SECONDS,
                                                   reserve=FINALIZATION_RESERVE_SECONDS))
        node = json.loads(packet)
        if review_receipt.coverage_disposition(node) != "complete":
            self.stop("required review source coverage is incomplete")
        self.packet = packet
        self.manifest = {"packet": self.put(packet), "units": [self.put(unit) for unit in
            review_stages.required_stages(packet, max_units=MAX_UNITS)]}
        reference = self.put(self.manifest)
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved["manifest"] = reference
            _write(conn, self.root, original)
        self.checkpoint(advanced=True)

    def funded(self, function, seconds: float, *, reserve: float = 0):
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved["spent_ms"] += math.ceil((monotonic() - self.meter) * 1000)
            remaining_ms = saved["allowance_ms"] - saved["spent_ms"] - math.ceil(reserve * 1000) \
                if saved["complete"] else analysis_remaining_ms(saved)
            if remaining_ms <= 0:
                self.stop("cumulative review time allowance exhausted")
            if saved["attempts"] >= 2 * (MAX_UNITS + 1) * 13:
                self.stop("cumulative review execution attempts exhausted")
            grant = min(seconds, remaining_ms / 1000)
            reserved = min(remaining_ms, math.ceil(grant * 1000))
            saved["spent_ms"] += reserved
            saved["attempts"] += 1
            _write(conn, self.root, original)
            self.retain_progress(conn, saved, _artifact(conn, self.call))
        started = monotonic()
        try:
            result = function(grant)
        except BaseException:
            # A failed/killed attempt keeps its whole precharged allowance.
            self.meter = monotonic()
            raise
        elapsed = monotonic() - started
        self.meter = monotonic()
        used = min(reserved, math.ceil(elapsed * 1000))
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved["spent_ms"] -= reserved - used
            _write(conn, self.root, original)
            self.retain_progress(conn, saved, _artifact(conn, self.call))
        if elapsed > grant:
            raise review_budget.ReviewLimitError("review execution exceeded its cumulative allowance", "review_budget_exhausted")
        return result

    def pause(self, reason: str, *, terminal: bool = False) -> None:
        with caller_store.connect(self.database) as conn:
            conn.execute("begin immediate")
            original, saved = self.owned(conn)
            saved["spent_ms"] += math.ceil((monotonic() - self.meter) * 1000)
            exhausted = analysis_remaining_ms(saved) <= 0
            held = terminal or exhausted or self.state["stalled"] >= MAX_STALLED_ATTEMPTS
            if exhausted:
                reason = "cumulative review time allowance exhausted; " + reason
            elif self.state["stalled"] >= MAX_STALLED_ATTEMPTS:
                reason = "same immutable review unit made no validated advancement in two attempts; " + reason
            saved.update(phase="held" if held else "paused", owner=None, reason=reason)
            _write(conn, self.root, original)
            self.retain_progress(conn, saved, _artifact(conn, self.call))
        self.stop(reason, resumable=not held)

    def verified(self, roots: list[int]) -> dict:
        packet = json.loads(self.packet)
        candidates = set(packet.get("verification_candidates", []))
        fixes = {str(thread["root_comment_id"]): {"id": thread["id"], "revision": thread["repair_answer"]["revision"]}
                 for thread in packet.get("review_threads", []) if thread.get("root_comment_id") in candidates}
        if any(str(root) not in fixes for root in roots):
            raise ValueError("verified repair differs from its original answer revision")
        return {str(root): fixes[str(root)] for root in roots}

    def result(self, reference: dict) -> dict:
        value = self.read(reference)
        verdict = value["verdict"]
        if value["verified_fixes"] != self.verified(review_receipt.verified_fix_ids(verdict["assessment"])):
            raise ValueError("saved verification differs from its original repair revision")
        return verdict


def analysis_remaining_ms(saved: dict) -> int:
    return saved["allowance_ms"] - saved["spent_ms"] - FINALIZATION_RESERVE_SECONDS * 1000


class Unit:
    def __init__(self, session: Session, identities: list[str], packet: str):
        self.session, self.identities = session, identities
        source = json.loads(packet)
        self.head = json.loads(session.packet)["head_sha"]
        self.locations = review_stages.diff_line_sets(source["diff"], [entry["filename"] for entry in source["files"]])

    def evidence(self) -> list[str]:
        return self.identities + [ref["sha256"] for ref in self.session.state["inspection"]]

    def remaining(self) -> float:
        return analysis_remaining_ms(self.session.saved) / 1000

    def context(self) -> str:
        return "\n\nValidated inspection checkpoints (review input):\n" + json.dumps(
            {"inspection": [self.session.read(ref) for ref in self.session.state["inspection"]],
             "findings": self.session.state["provisional"], "verified_fixes": self.session.state["verified"]})

    def findings(self, verdict: dict) -> None:
        from .structured_review import _reaffirming_thread
        threads = json.loads(self.session.packet).get("review_threads", [])
        for finding in verdict["comments"]:
            if finding["line"] not in self.locations.get(finding["path"], {}).get(finding["side"].lower(), set()) \
                    and _reaffirming_thread(finding, threads, in_since_diff=False) is None:
                raise ValueError("continuation finding lacks a required diff location")

    def inspected(self, step: dict, result: dict) -> None:
        state = self.session.state
        results = result["results"]
        self.findings(step)
        evidence = {"step": step, "result": result}
        # Provider prose and identical reads cannot reset the no-progress bound.
        known = [self.session.read(ref)["result"] for ref in state["inspection"]]
        changed = False
        if any(not response.get("error") for response in results) and result not in known:
            state["inspection"].append(self.session.put(evidence))
            state["stalled"] = 0
            changed = True
        for finding in step["comments"]:
            if finding not in state["provisional"]:
                state["provisional"].append(finding)
                changed = True
        verified = self.session.verified(review_receipt.verified_fix_ids(step["assessment"]))
        if any(state["verified"].get(key) != value for key, value in verified.items()):
            state["verified"].update(verified)
            changed = True
        if changed or any(response.get("error") for response in results):
            self.session.checkpoint(advanced=changed)

    def terminal(self, verdict: dict, evidence) -> dict:
        if not isinstance(evidence, list) or any(not isinstance(item, str) for item in evidence) \
                or len(evidence) != len(set(evidence)) or set(evidence) != set(self.evidence()):
            raise ValueError("terminal review must account for every required unit and inspected evidence ID")
        self.findings(verdict)
        for finding in self.session.state["provisional"]:
            if finding not in verdict["comments"]:
                verdict["comments"].append(finding)
        roots = {int(root) for root in self.session.state["verified"]} | set(review_receipt.verified_fix_ids(verdict["assessment"]))
        if roots:
            verdict["assessment"]["verified_fixes"] = sorted(roots)
        if verdict["comments"]:
            verdict["action"] = "request_changes"
        return verdict


def analyze(pwd, system, text, model, behavior, pr, actor, head, seconds, repository, packet, root, watch, ask, warnings):
    from . import atoms, structured_review
    from .atoms import AgentPreflightError, ReviewVerdictError
    session = Session(packet, model.identity)
    warnings[:] = list(dict.fromkeys([*session.state.get("warnings", []), *warnings]))
    session.state["warnings"] = warnings
    try:
        if session.finalization:
            return session.read(session.finalization["verdict"]), session.packet, session
        session.initialize(repository)
        units = session.manifest["units"]
        first_unit = session.state["unit"]
        deadline = monotonic() + min(seconds, structured_review.PROVIDER_ANALYSIS_SECONDS.get(model.provider, seconds))
        while session.state["unit"] <= len(units):
            index = session.state["unit"]
            integration = index == len(units)
            completed = [session.result(ref) for ref in session.state["results"]]
            if integration:
                summaries = []
                for reference, verdict in zip(units, completed, strict=True):
                    source = json.loads(session.read(reference))
                    lines = source["diff"].splitlines()
                    summaries.append({"evidence_id": reference["sha256"], "files": source["files"],
                                      "boundary_diff": lines[:16] + lines[-16:], "verdict": verdict})
                stage_packet = json.dumps({**json.loads(packet), "required_cross_unit_evidence": summaries,
                    "review_scope": "Verify cross-unit contracts and both sides of every subdivision boundary. "
                                    "Inspect pinned source for any missing context before a final verdict."})
                identities = [ref["sha256"] for ref in units]
            else:
                stage_packet = session.read(units[index])
                identities = [units[index]["sha256"]]
            unit = Unit(session, identities, session.packet)
            stage_text = text.replace(packet, stage_packet, 1)
            stage_text += "\n\nCompleted unit findings (retain them):\n" + json.dumps([v["comments"] for v in completed])
            session.state["stalled"] += 1
            session.checkpoint()

            def funded_ask(work, spec, policy, prompt, schema, observer, timeout):
                return session.funded(lambda grant: ask(work, spec, policy, prompt, schema, observer, grant), timeout)

            class Inspection:
                def inspect(self, requests, *, timeout_s):
                    return session.funded(lambda grant: repository.inspect(requests, timeout_s=grant), timeout_s)

            _raw, verdict, _used = structured_review._review_once(root, funded_ask, model, system, stage_text,
                watch, seconds, deadline, Inspection(), behavior, bool(json.loads(packet).get("verification_candidates")),
                groups_remaining=len(units) + 1 - index, total_groups=len(units) + 1,
                expected_group_seconds=session.state.get("mean_seconds", 60),
                checkpoint=unit, warnings=warnings)
            candidates = set(json.loads(packet).get("verification_candidates", []))
            if set(review_receipt.verified_fix_ids(verdict["assessment"])) - candidates:
                raise ValueError("verified repair differs from its original answer revision")
            session.state["results"].append(session.put({"verdict": verdict,
                "verified_fixes": session.verified(review_receipt.verified_fix_ids(verdict["assessment"]))}))
            session.state["mean_seconds"] = (session.state.get("mean_seconds", 0) * index + _used) / (index + 1)
            session.state.update(unit=index + 1, inspection=[], pending=[], provisional=[], verified={}, stalled=0)
            session.checkpoint(advanced=True)
            if session.units_per_call is not None and session.state["unit"] <= len(units) \
                    and session.state["unit"] - first_unit >= session.units_per_call:
                session.pause("completed the scheduled review units; continue the saved checkpoint")
        verdicts = [session.result(ref) for ref in session.state["results"]]
        verdict = verdicts[-1]
        findings, fixes = [], set()
        for value in verdicts:
            for finding in value["comments"]:
                if finding not in findings:
                    findings.append(finding)
            fixes.update(review_receipt.verified_fix_ids(value["assessment"]))
        verdict["comments"] = findings
        verdict["action"] = "request_changes" if findings else "reviewed_clean" if behavior == "pr_review" else "approve"
        if fixes:
            verdict["assessment"]["verified_fixes"] = sorted(fixes)
        if session.units_per_call is not None:
            original_packet = json.loads(packet)
            fresh_packet = json.loads(atoms.packet(pwd, pr, actor, head, original_packet.get("p"),
                reserve=structured_review.VERIFICATION_RESERVE_SECONDS, manifest=True, fresh=True))
            if analysis_basis(fresh_packet, "") != analysis_basis(original_packet, ""):
                session.pause("material review basis changed before submission; inspect the current review inputs", terminal=True)
        with caller_store.connect(session.database) as conn:
            conn.execute("begin immediate")
            original, saved = session.owned(conn)
            saved["spent_ms"] += math.ceil((monotonic() - session.meter) * 1000)
            if analysis_remaining_ms(saved) <= 0:
                session.stop("cumulative review time allowance exhausted before finalization")
            saved.update(phase="finalizing", complete=True)
            _write(conn, session.root, original)
            session.retain_progress(conn, saved, _artifact(conn, session.call))
        session.meter = monotonic()
        return verdict, session.packet, session
    except Continuation as error:
        if error.result["outcome"] == "held":
            with caller_store.connect(session.database) as conn:
                saved = _artifact(conn, session.root)["review_progress"]
            if saved["owner"] == session.call and saved["phase"] == "analyzing":
                session.pause(str(error), terminal=True)
        raise
    except review_budget.ReviewLimitError as error:
        session.pause(str(error), terminal=error.code not in {"review_budget_exhausted", "review_inspection_timeout"})
    except (AgentPreflightError, ReviewVerdictError) as error:
        with caller_store.connect(session.database) as conn:
            conn.execute("begin immediate")
            original, saved = session.owned(conn)
            saved.update(phase="held", owner=None, reason=f"{error.code}: {error}")
            _write(conn, session.root, original)
        raise
    except (ValueError, OSError) as error:
        session.pause(f"review checkpoint validation failed: {error}", terminal=True)

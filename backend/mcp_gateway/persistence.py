"""Append-only durable state for :mod:`backend.mcp_gateway`.

The capability gateway intentionally contains coordination state that is not
part of the canonical PCB graph: questions, exact approvals, evidence, and
idempotency results.  This module persists that state as closed canonical JSON
in an HMAC chained SQLite journal.  It never deserializes Python objects and it
does not accept paths through MCP requests.

The HMAC detects edits and key replacement.  Like any local file journal it
cannot, by itself, detect rollback of the database and key to a common older
snapshot; deployments needing that property must anchor the latest generation
outside the state directory.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from threading import RLock
from typing import Any, Protocol, cast, runtime_checkable

from .codec import canonical_data, canonical_json
from .errors import StateConflict, StateIntegrityError, StateUnavailable
from .models import (
    AgentRun,
    ApprovalDecision,
    ApprovalKind,
    ApprovalReceipt,
    ApprovalRequestRecord,
    EvidenceRecord,
    PatchPreview,
    QuestionRecord,
    RunState,
    ToolName,
    ToolResult,
    VerificationFinding,
    VerificationReport,
)

_SCHEMA_VERSION = 1
_GENESIS_MAC = "0" * 64


@dataclass(frozen=True, slots=True)
class GatewayIdempotencyRecord:
    actor_id: str
    tool_name: ToolName
    idempotency_key: str
    input_digest: str
    result: ToolResult


@dataclass(frozen=True, slots=True)
class GatewaySnapshot:
    """Complete immutable process state required for safe restart."""

    runs: tuple[AgentRun, ...] = ()
    questions: tuple[QuestionRecord, ...] = ()
    approvals: tuple[ApprovalRequestRecord, ...] = ()
    receipts: tuple[ApprovalReceipt, ...] = ()
    previews: tuple[PatchPreview, ...] = ()
    reports: tuple[VerificationReport, ...] = ()
    idempotency: tuple[GatewayIdempotencyRecord, ...] = ()
    evidence: tuple[EvidenceRecord, ...] = ()

    def __post_init__(self) -> None:
        collections: tuple[tuple[str, tuple[object, ...], type[object]], ...] = (
            ("runs", self.runs, AgentRun),
            ("questions", self.questions, QuestionRecord),
            ("approvals", self.approvals, ApprovalRequestRecord),
            ("receipts", self.receipts, ApprovalReceipt),
            ("previews", self.previews, PatchPreview),
            ("reports", self.reports, VerificationReport),
            ("idempotency", self.idempotency, GatewayIdempotencyRecord),
            ("evidence", self.evidence, EvidenceRecord),
        )
        for label, values, expected in collections:
            if type(values) is not tuple or any(type(item) is not expected for item in values):
                raise StateIntegrityError(
                    f"gateway snapshot {label} must be an exact immutable record tuple"
                )
        uniqueness = (
            ("run", tuple(item.run_id for item in self.runs)),
            ("question", tuple(item.question_id for item in self.questions)),
            ("approval", tuple(item.approval_id for item in self.approvals)),
            ("receipt", tuple(item.receipt_id for item in self.receipts)),
            ("preview", tuple(item.preview_digest for item in self.previews)),
            ("report", tuple(item.report_digest for item in self.reports)),
            ("evidence", tuple(item.evidence_id for item in self.evidence)),
            (
                "idempotency",
                tuple(
                    (item.actor_id, item.tool_name.value, item.idempotency_key)
                    for item in self.idempotency
                ),
            ),
        )
        for label, values in uniqueness:
            if len(values) != len(set(values)):
                raise StateIntegrityError(f"gateway snapshot contains duplicate {label} identity")


@dataclass(frozen=True, slots=True)
class StoredGatewaySnapshot:
    generation: int
    snapshot: GatewaySnapshot

    def __post_init__(self) -> None:
        if type(self.generation) is not int or self.generation < 0:
            raise StateIntegrityError("gateway state generation must be non-negative")
        if type(self.snapshot) is not GatewaySnapshot:
            raise StateIntegrityError("stored gateway state has an invalid snapshot")


@runtime_checkable
class GatewayStateStore(Protocol):
    """Optimistic durable store injected into ``CapabilitySafeGateway``."""

    def load(self) -> StoredGatewaySnapshot: ...

    def save(
        self,
        snapshot: GatewaySnapshot,
        *,
        expected_generation: int,
    ) -> StoredGatewaySnapshot: ...


def _expect_object(value: object, label: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise StateIntegrityError(f"{label} must be an exact object")
    raw = cast(dict[object, object], value)
    if any(type(key) is not str for key in raw):
        raise StateIntegrityError(f"{label} keys must be exact strings")
    return cast(dict[str, Any], raw)


def _expect_keys(value: Mapping[str, Any], expected: frozenset[str], label: str) -> None:
    if frozenset(value) != expected:
        raise StateIntegrityError(f"{label} fields do not match schema")


def _expect_list(value: object, label: str) -> list[object]:
    if type(value) is not list:
        raise StateIntegrityError(f"{label} must be an exact array")
    return cast(list[object], value)


def _text(value: object, label: str) -> str:
    if type(value) is not str:
        raise StateIntegrityError(f"{label} must be exact text")
    return value


def _optional_text(value: object, label: str) -> str | None:
    if value is not None and type(value) is not str:
        raise StateIntegrityError(f"{label} must be exact text or null")
    return cast(str | None, value)


def _integer(value: object, label: str) -> int:
    if type(value) is not int:
        raise StateIntegrityError(f"{label} must be an exact integer")
    return value


def _boolean(value: object, label: str) -> bool:
    if type(value) is not bool:
        raise StateIntegrityError(f"{label} must be an exact boolean")
    return value


def _optional_boolean(value: object, label: str) -> bool | None:
    if value is not None and type(value) is not bool:
        raise StateIntegrityError(f"{label} must be an exact boolean or null")
    return cast(bool | None, value)


def _optional_integer(value: object, label: str) -> int | None:
    if value is not None and type(value) is not int:
        raise StateIntegrityError(f"{label} must be an exact integer or null")
    return cast(int | None, value)


def _strings(value: object, label: str) -> tuple[str, ...]:
    return tuple(_text(item, f"{label} item") for item in _expect_list(value, label))


def _timestamp(value: object, label: str) -> datetime:
    text = _text(value, label)
    if not text.endswith("Z"):
        raise StateIntegrityError(f"{label} must use canonical UTC Z syntax")
    try:
        result = datetime.fromisoformat(text[:-1] + "+00:00")
    except ValueError as exc:
        raise StateIntegrityError(f"{label} is not a valid timestamp") from exc
    if canonical_data(result) != text:
        raise StateIntegrityError(f"{label} is not a canonical timestamp")
    return result


def _optional_timestamp(value: object, label: str) -> datetime | None:
    return None if value is None else _timestamp(value, label)


def _enum[T: Enum](enum_type: type[T], value: object, label: str) -> T:
    try:
        return enum_type(_text(value, label))
    except ValueError as exc:
        raise StateIntegrityError(f"{label} is not supported") from exc


def _run(value: object) -> AgentRun:
    item = _expect_object(value, "run")
    _expect_keys(
        item,
        frozenset(
            {
                "run_id",
                "project_id",
                "objective",
                "project_revision",
                "run_revision",
                "state",
                "strict_user_coordination",
                "max_parallel_agents",
                "token_budget",
                "question_ids",
                "approval_ids",
                "staged_revision",
                "verification_report_digest",
            }
        ),
        "run",
    )
    return AgentRun(
        run_id=_text(item["run_id"], "run.run_id"),
        project_id=_text(item["project_id"], "run.project_id"),
        objective=_text(item["objective"], "run.objective"),
        project_revision=_text(item["project_revision"], "run.project_revision"),
        run_revision=_integer(item["run_revision"], "run.run_revision"),
        state=_enum(RunState, item["state"], "run.state"),
        strict_user_coordination=_boolean(
            item["strict_user_coordination"], "run.strict_user_coordination"
        ),
        max_parallel_agents=_optional_integer(
            item["max_parallel_agents"], "run.max_parallel_agents"
        ),
        token_budget=_optional_integer(item["token_budget"], "run.token_budget"),
        question_ids=_strings(item["question_ids"], "run.question_ids"),
        approval_ids=_strings(item["approval_ids"], "run.approval_ids"),
        staged_revision=_optional_text(item["staged_revision"], "run.staged_revision"),
        verification_report_digest=_optional_text(
            item["verification_report_digest"], "run.verification_report_digest"
        ),
    )


def _question(value: object) -> QuestionRecord:
    item = _expect_object(value, "question")
    _expect_keys(
        item,
        frozenset(
            {
                "question_id",
                "run_id",
                "prompt",
                "rationale",
                "blocking",
                "options",
                "answer",
                "answered_by",
                "answered_at",
            }
        ),
        "question",
    )
    return QuestionRecord(
        question_id=_text(item["question_id"], "question.question_id"),
        run_id=_text(item["run_id"], "question.run_id"),
        prompt=_text(item["prompt"], "question.prompt"),
        rationale=_text(item["rationale"], "question.rationale"),
        blocking=_boolean(item["blocking"], "question.blocking"),
        options=_strings(item["options"], "question.options"),
        answer=_optional_text(item["answer"], "question.answer"),
        answered_by=_optional_text(item["answered_by"], "question.answered_by"),
        answered_at=_optional_timestamp(item["answered_at"], "question.answered_at"),
    )


def _approval(value: object) -> ApprovalRequestRecord:
    item = _expect_object(value, "approval")
    _expect_keys(
        item,
        frozenset(
            {
                "approval_id",
                "run_id",
                "kind",
                "subject_digest",
                "summary",
                "decision",
                "requested_at",
            }
        ),
        "approval",
    )
    return ApprovalRequestRecord(
        approval_id=_text(item["approval_id"], "approval.approval_id"),
        run_id=_text(item["run_id"], "approval.run_id"),
        kind=_enum(ApprovalKind, item["kind"], "approval.kind"),
        subject_digest=_text(item["subject_digest"], "approval.subject_digest"),
        summary=_text(item["summary"], "approval.summary"),
        decision=_enum(ApprovalDecision, item["decision"], "approval.decision"),
        requested_at=_timestamp(item["requested_at"], "approval.requested_at"),
    )


def _receipt(value: object) -> ApprovalReceipt:
    item = _expect_object(value, "receipt")
    _expect_keys(
        item,
        frozenset(
            {
                "receipt_id",
                "approval_id",
                "run_id",
                "kind",
                "subject_digest",
                "decision",
                "decided_by",
                "decided_at",
                "reason",
                "receipt_digest",
            }
        ),
        "receipt",
    )
    return ApprovalReceipt(
        receipt_id=_text(item["receipt_id"], "receipt.receipt_id"),
        approval_id=_text(item["approval_id"], "receipt.approval_id"),
        run_id=_text(item["run_id"], "receipt.run_id"),
        kind=_enum(ApprovalKind, item["kind"], "receipt.kind"),
        subject_digest=_text(item["subject_digest"], "receipt.subject_digest"),
        decision=_enum(ApprovalDecision, item["decision"], "receipt.decision"),
        decided_by=_text(item["decided_by"], "receipt.decided_by"),
        decided_at=_timestamp(item["decided_at"], "receipt.decided_at"),
        reason=_text(item["reason"], "receipt.reason"),
        receipt_digest=_text(item["receipt_digest"], "receipt.receipt_digest"),
    )


def _preview(value: object) -> PatchPreview:
    item = _expect_object(value, "preview")
    _expect_keys(
        item,
        frozenset(
            {
                "project_id",
                "base_revision",
                "prospective_revision",
                "patch_digest",
                "preview_digest",
                "operation_summaries",
                "added",
                "removed",
                "modified",
            }
        ),
        "preview",
    )
    return PatchPreview(
        project_id=_text(item["project_id"], "preview.project_id"),
        base_revision=_text(item["base_revision"], "preview.base_revision"),
        prospective_revision=_text(item["prospective_revision"], "preview.prospective_revision"),
        patch_digest=_text(item["patch_digest"], "preview.patch_digest"),
        preview_digest=_text(item["preview_digest"], "preview.preview_digest"),
        operation_summaries=_strings(item["operation_summaries"], "preview.operation_summaries"),
        added=_strings(item["added"], "preview.added"),
        removed=_strings(item["removed"], "preview.removed"),
        modified=_strings(item["modified"], "preview.modified"),
    )


def _finding(value: object) -> VerificationFinding:
    item = _expect_object(value, "finding")
    _expect_keys(
        item,
        frozenset({"finding_id", "rule_id", "severity", "message", "operation_ids"}),
        "finding",
    )
    return VerificationFinding(
        finding_id=_text(item["finding_id"], "finding.finding_id"),
        rule_id=_text(item["rule_id"], "finding.rule_id"),
        severity=_text(item["severity"], "finding.severity"),
        message=_text(item["message"], "finding.message"),
        operation_ids=_strings(item["operation_ids"], "finding.operation_ids"),
    )


def _report(value: object) -> VerificationReport:
    item = _expect_object(value, "report")
    _expect_keys(
        item,
        frozenset(
            {
                "report_id",
                "project_id",
                "base_revision",
                "staged_revision",
                "engine_version",
                "passed",
                "findings",
                "report_digest",
                "input_hash",
                "rule_set_hash",
                "compiler_manifest_digest",
                "compiler_bundle_digest",
                "manufacturing_release_eligible",
            }
        ),
        "report",
    )
    return VerificationReport(
        report_id=_text(item["report_id"], "report.report_id"),
        project_id=_text(item["project_id"], "report.project_id"),
        base_revision=_text(item["base_revision"], "report.base_revision"),
        staged_revision=_text(item["staged_revision"], "report.staged_revision"),
        engine_version=_text(item["engine_version"], "report.engine_version"),
        passed=_boolean(item["passed"], "report.passed"),
        findings=tuple(_finding(value) for value in _expect_list(item["findings"], "findings")),
        report_digest=_text(item["report_digest"], "report.report_digest"),
        input_hash=_optional_text(item["input_hash"], "report.input_hash"),
        rule_set_hash=_optional_text(item["rule_set_hash"], "report.rule_set_hash"),
        compiler_manifest_digest=_optional_text(
            item["compiler_manifest_digest"], "report.compiler_manifest_digest"
        ),
        compiler_bundle_digest=_optional_text(
            item["compiler_bundle_digest"], "report.compiler_bundle_digest"
        ),
        manufacturing_release_eligible=_boolean(
            item["manufacturing_release_eligible"],
            "report.manufacturing_release_eligible",
        ),
    )


def _evidence(value: object) -> EvidenceRecord:
    item = _expect_object(value, "evidence")
    _expect_keys(
        item,
        frozenset(
            {
                "evidence_id",
                "tool_name",
                "actor_id",
                "project_id",
                "project_revision",
                "input_digest",
                "output_digest",
                "captured_at",
                "manifest_digest",
            }
        ),
        "evidence",
    )
    return EvidenceRecord(
        evidence_id=_text(item["evidence_id"], "evidence.evidence_id"),
        tool_name=_enum(ToolName, item["tool_name"], "evidence.tool_name"),
        actor_id=_text(item["actor_id"], "evidence.actor_id"),
        project_id=_text(item["project_id"], "evidence.project_id"),
        project_revision=_text(item["project_revision"], "evidence.project_revision"),
        input_digest=_text(item["input_digest"], "evidence.input_digest"),
        output_digest=_text(item["output_digest"], "evidence.output_digest"),
        captured_at=_timestamp(item["captured_at"], "evidence.captured_at"),
        manifest_digest=_text(item["manifest_digest"], "evidence.manifest_digest"),
    )


def _tool_result(value: object) -> ToolResult:
    item = _expect_object(value, "tool result")
    _expect_keys(
        item,
        frozenset({"tool_name", "payload_json", "evidence", "manifest_digest"}),
        "tool result",
    )
    return ToolResult(
        tool_name=_enum(ToolName, item["tool_name"], "tool result.tool_name"),
        payload_json=_text(item["payload_json"], "tool result.payload_json"),
        evidence=_evidence(item["evidence"]),
        manifest_digest=_text(item["manifest_digest"], "tool result.manifest_digest"),
    )


def _idempotency(value: object) -> GatewayIdempotencyRecord:
    item = _expect_object(value, "idempotency record")
    _expect_keys(
        item,
        frozenset({"actor_id", "tool_name", "idempotency_key", "input_digest", "result"}),
        "idempotency record",
    )
    record = GatewayIdempotencyRecord(
        actor_id=_text(item["actor_id"], "idempotency.actor_id"),
        tool_name=_enum(ToolName, item["tool_name"], "idempotency.tool_name"),
        idempotency_key=_text(item["idempotency_key"], "idempotency.idempotency_key"),
        input_digest=_text(item["input_digest"], "idempotency.input_digest"),
        result=_tool_result(item["result"]),
    )
    if record.result.tool_name is not record.tool_name:
        raise StateIntegrityError("idempotency result belongs to a different tool")
    return record


def snapshot_payload(snapshot: GatewaySnapshot) -> dict[str, object]:
    """Return the unique normalized representation stored in the journal."""

    if type(snapshot) is not GatewaySnapshot:
        raise StateIntegrityError("gateway persistence requires an exact snapshot")
    return {
        "schema_version": _SCHEMA_VERSION,
        "runs": [canonical_data(item) for item in sorted(snapshot.runs, key=lambda x: x.run_id)],
        "questions": [
            canonical_data(item) for item in sorted(snapshot.questions, key=lambda x: x.question_id)
        ],
        "approvals": [
            canonical_data(item) for item in sorted(snapshot.approvals, key=lambda x: x.approval_id)
        ],
        "receipts": [
            canonical_data(item) for item in sorted(snapshot.receipts, key=lambda x: x.receipt_id)
        ],
        "previews": [
            canonical_data(item)
            for item in sorted(snapshot.previews, key=lambda x: x.preview_digest)
        ],
        "reports": [
            canonical_data(item) for item in sorted(snapshot.reports, key=lambda x: x.report_digest)
        ],
        "idempotency": [
            canonical_data(item)
            for item in sorted(
                snapshot.idempotency,
                key=lambda x: (x.actor_id, x.tool_name.value, x.idempotency_key),
            )
        ],
        "evidence": [
            canonical_data(item) for item in sorted(snapshot.evidence, key=lambda x: x.evidence_id)
        ],
    }


def snapshot_from_payload(value: object) -> GatewaySnapshot:
    item = _expect_object(value, "gateway snapshot")
    _expect_keys(
        item,
        frozenset(
            {
                "schema_version",
                "runs",
                "questions",
                "approvals",
                "receipts",
                "previews",
                "reports",
                "idempotency",
                "evidence",
            }
        ),
        "gateway snapshot",
    )
    if _integer(item["schema_version"], "gateway schema version") != _SCHEMA_VERSION:
        raise StateIntegrityError("gateway state schema version is unsupported")
    snapshot = GatewaySnapshot(
        runs=tuple(_run(entry) for entry in _expect_list(item["runs"], "runs")),
        questions=tuple(_question(entry) for entry in _expect_list(item["questions"], "questions")),
        approvals=tuple(_approval(entry) for entry in _expect_list(item["approvals"], "approvals")),
        receipts=tuple(_receipt(entry) for entry in _expect_list(item["receipts"], "receipts")),
        previews=tuple(_preview(entry) for entry in _expect_list(item["previews"], "previews")),
        reports=tuple(_report(entry) for entry in _expect_list(item["reports"], "reports")),
        idempotency=tuple(
            _idempotency(entry) for entry in _expect_list(item["idempotency"], "idempotency")
        ),
        evidence=tuple(_evidence(entry) for entry in _expect_list(item["evidence"], "evidence")),
    )
    if snapshot_payload(snapshot) != item:
        raise StateIntegrityError("gateway snapshot is not normalized canonical state")
    return snapshot


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise StateIntegrityError(f"duplicate gateway JSON key: {key}")
        result[key] = value
    return result


def _reject_number(value: str) -> None:
    raise StateIntegrityError(f"unsupported gateway JSON number: {value}")


class SQLiteGatewayStateStore:
    """HMAC-chained, append-only coordination/idempotency journal."""

    def __init__(
        self,
        path: Path,
        *,
        state_id: str,
        hmac_key: bytes,
        key_id: str,
    ) -> None:
        if not isinstance(path, Path) or not path.is_absolute():
            raise ValueError("gateway journal path must be an absolute Path")
        if type(state_id) is not str or not state_id:
            raise ValueError("gateway journal state_id must be non-empty")
        if type(hmac_key) is not bytes or len(hmac_key) != 32:
            raise ValueError("gateway journal HMAC key must contain exactly 32 bytes")
        if type(key_id) is not str or not key_id:
            raise ValueError("gateway journal key_id must be non-empty")
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise StateIntegrityError("gateway journal must be a regular non-symlink file")
        self._path = path
        self._state_id = state_id
        self._key = hmac_key
        self._key_id = key_id
        self._lock = RLock()
        try:
            self._connection = sqlite3.connect(
                path,
                isolation_level=None,
                check_same_thread=False,
                timeout=30,
            )
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA busy_timeout = 30000")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = FULL")
            self._connection.execute("PRAGMA trusted_schema = OFF")
            self._initialize()
        except sqlite3.Error as exc:
            raise StateUnavailable("gateway state journal could not be opened") from exc

    def close(self) -> None:
        with self._lock:
            try:
                self._connection.close()
            except sqlite3.Error as exc:
                raise StateUnavailable("gateway state journal could not be closed") from exc

    def _binding_mac(self) -> str:
        material = canonical_json(
            {
                "domain": "evleda-gateway-state-key-binding-v1",
                "key_id": self._key_id,
                "schema_version": _SCHEMA_VERSION,
                "state_id": self._state_id,
            }
        ).encode("utf-8")
        return hmac.new(self._key, material, hashlib.sha256).hexdigest()

    def _event_mac(
        self,
        generation: int,
        body_sha256: str,
        previous_mac: str,
    ) -> str:
        material = canonical_json(
            {
                "body_sha256": body_sha256,
                "domain": "evleda-gateway-state-event-v1",
                "generation": generation,
                "previous_mac": previous_mac,
                "state_id": self._state_id,
            }
        ).encode("utf-8")
        return hmac.new(self._key, material, hashlib.sha256).hexdigest()

    def _initialize(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS gateway_state_binding (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                schema_version INTEGER NOT NULL CHECK (schema_version = 1),
                state_id TEXT NOT NULL,
                key_id TEXT NOT NULL,
                binding_mac TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS gateway_state_events (
                generation INTEGER PRIMARY KEY CHECK (generation > 0),
                state_id TEXT NOT NULL,
                body TEXT NOT NULL,
                body_sha256 TEXT NOT NULL,
                previous_mac TEXT NOT NULL,
                event_mac TEXT NOT NULL
            ) STRICT;
            CREATE TRIGGER IF NOT EXISTS gateway_state_binding_no_update
            BEFORE UPDATE ON gateway_state_binding BEGIN
                SELECT RAISE(ABORT, 'gateway state binding is immutable');
            END;
            CREATE TRIGGER IF NOT EXISTS gateway_state_binding_no_delete
            BEFORE DELETE ON gateway_state_binding BEGIN
                SELECT RAISE(ABORT, 'gateway state binding is immutable');
            END;
            CREATE TRIGGER IF NOT EXISTS gateway_state_events_no_update
            BEFORE UPDATE ON gateway_state_events BEGIN
                SELECT RAISE(ABORT, 'gateway state events are immutable');
            END;
            CREATE TRIGGER IF NOT EXISTS gateway_state_events_no_delete
            BEFORE DELETE ON gateway_state_events BEGIN
                SELECT RAISE(ABORT, 'gateway state events are immutable');
            END;
            """
        )
        row = self._connection.execute(
            "SELECT schema_version,state_id,key_id,binding_mac FROM gateway_state_binding"
        ).fetchone()
        expected = self._binding_mac()
        if row is None:
            self._connection.execute(
                "INSERT INTO gateway_state_binding VALUES (1,1,?,?,?)",
                (self._state_id, self._key_id, expected),
            )
            return
        if (
            row["schema_version"] != _SCHEMA_VERSION
            or row["state_id"] != self._state_id
            or row["key_id"] != self._key_id
            or type(row["binding_mac"]) is not str
            or not hmac.compare_digest(row["binding_mac"], expected)
        ):
            raise StateIntegrityError(
                "gateway state journal is not bound to this project and HMAC key"
            )

    @staticmethod
    def _decode_body(body: object) -> GatewaySnapshot:
        if type(body) is not str:
            raise StateIntegrityError("gateway event body must be exact text")
        try:
            value = json.loads(
                body,
                object_pairs_hook=_unique_json_object,
                parse_float=_reject_number,
                parse_constant=_reject_number,
            )
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise StateIntegrityError("gateway event body is not valid JSON") from exc
        snapshot = snapshot_from_payload(value)
        if canonical_json(snapshot_payload(snapshot)) != body:
            raise StateIntegrityError("gateway event body is not canonical JSON")
        return snapshot

    def _load_locked(self) -> StoredGatewaySnapshot:
        rows = self._connection.execute(
            "SELECT generation,state_id,body,body_sha256,previous_mac,event_mac "
            "FROM gateway_state_events ORDER BY generation"
        ).fetchall()
        previous_mac = _GENESIS_MAC
        snapshot = GatewaySnapshot()
        for expected_generation, row in enumerate(rows, start=1):
            body = row["body"]
            body_digest = hashlib.sha256(
                _text(body, "gateway event body").encode("utf-8")
            ).hexdigest()
            expected_mac = self._event_mac(
                expected_generation,
                body_digest,
                previous_mac,
            )
            if (
                row["generation"] != expected_generation
                or row["state_id"] != self._state_id
                or row["body_sha256"] != body_digest
                or row["previous_mac"] != previous_mac
                or type(row["event_mac"]) is not str
                or not hmac.compare_digest(row["event_mac"], expected_mac)
            ):
                raise StateIntegrityError("gateway state event chain failed verification")
            snapshot = self._decode_body(body)
            previous_mac = expected_mac
        return StoredGatewaySnapshot(len(rows), snapshot)

    def load(self) -> StoredGatewaySnapshot:
        with self._lock:
            try:
                return self._load_locked()
            except (StateIntegrityError, StateUnavailable):
                raise
            except sqlite3.Error as exc:
                raise StateUnavailable("gateway state journal could not be read") from exc

    def save(
        self,
        snapshot: GatewaySnapshot,
        *,
        expected_generation: int,
    ) -> StoredGatewaySnapshot:
        if type(snapshot) is not GatewaySnapshot:
            raise StateIntegrityError("gateway save requires an exact snapshot")
        if type(expected_generation) is not int or expected_generation < 0:
            raise ValueError("expected gateway generation must be non-negative")
        body = canonical_json(snapshot_payload(snapshot))
        body_digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                current = self._load_locked()
                if current.generation != expected_generation:
                    raise StateConflict(
                        "durable gateway state advanced; reload exact coordination state"
                    )
                row = self._connection.execute(
                    "SELECT event_mac FROM gateway_state_events ORDER BY generation DESC LIMIT 1"
                ).fetchone()
                previous_mac = (
                    _GENESIS_MAC
                    if row is None
                    else _text(row["event_mac"], "gateway previous event MAC")
                )
                generation = expected_generation + 1
                event_mac = self._event_mac(generation, body_digest, previous_mac)
                self._connection.execute(
                    "INSERT INTO gateway_state_events VALUES (?,?,?,?,?,?)",
                    (
                        generation,
                        self._state_id,
                        body,
                        body_digest,
                        previous_mac,
                        event_mac,
                    ),
                )
                self._connection.execute("COMMIT")
                return StoredGatewaySnapshot(generation, snapshot)
            except (StateConflict, StateIntegrityError):
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise
            except sqlite3.Error as exc:
                if self._connection.in_transaction:
                    try:
                        self._connection.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                raise StateUnavailable("gateway state journal could not be committed") from exc


__all__ = (
    "GatewayIdempotencyRecord",
    "GatewaySnapshot",
    "GatewayStateStore",
    "SQLiteGatewayStateStore",
    "StoredGatewaySnapshot",
    "snapshot_from_payload",
    "snapshot_payload",
)

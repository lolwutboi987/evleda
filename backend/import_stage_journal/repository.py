"""Rollback-resistant SQLite orchestration for canonical-import staging.

All forward side effects run inside a cross-process execution lease.  Callers
provide callbacks, never evidence digests: server-owned adapters inspect the
real approval, project, transaction, and candidate stores after each callback.
The SQLite file is an audit projection; an external monotonic anchor is the
rollback-resistant source of its operation and journal-wide catalog heads.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager, suppress
from dataclasses import asdict, fields
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from types import MappingProxyType
from typing import cast

from backend.import_approval import AuthorizedImportStagingInput

from .models import (
    CompletedStageReceipt,
    IllegalStageOperationTransition,
    ImportStageJournalError,
    InvalidStageOperation,
    PrepareResult,
    StageJournalUnavailable,
    StageOperation,
    StageOperationBinding,
    StageOperationConcurrencyConflict,
    StageOperationEvent,
    StageOperationEventKind,
    StageOperationEvidenceMismatch,
    StageOperationExpired,
    StageOperationIntegrityError,
    StageOperationNotFound,
    StageOperationRecoveryRequired,
    StageOperationReplayError,
    StageOperationState,
    TransitionResult,
    UnsupportedStageJournalSchema,
    VerifiedStageCapability,
    issue_verified_stage_capability,
    operation_id_for,
    require_nonnegative_int,
    require_public_id,
    require_sha256,
    require_time,
    time_text,
)
from .trust import (
    AuthorizationVerification,
    CandidateDisposition,
    CandidatePreflightEvidence,
    CandidateStagedEvidence,
    ExclusiveStageExecutionCoordinator,
    ExecutionLease,
    ExecutionLeaseValidation,
    LeaseMode,
    LiveAuthorityEvidence,
    MonotonicAnchorState,
    MonotonicStageJournalAnchor,
    RecoveryCause,
    RecoveryEvidence,
    RollbackEvidence,
    StageAuthorizationVerifier,
    TransactionDisposition,
    TransactionOpenEvidence,
    TransactionPreflightEvidence,
    TrustedStageEvidenceProvider,
)

IMPORT_STAGE_JOURNAL_SCHEMA_VERSION = 3
_APPLICATION_ID = 0x46534A33  # "FSJ3"
_SCHEMA_NAME = "flux-clone-import-stage-journal"
_ZERO_DIGEST = "0" * 64
_IDENTITY_DOMAIN = b"flux-clone.import-stage-journal.identity.v3\0"
_PAYLOAD_DOMAIN = b"flux-clone.import-stage-journal.event-payload.v3\0"
_REQUEST_DOMAIN = b"flux-clone.import-stage-journal.transition-request.v3\0"
_EVENT_DOMAIN = b"flux-clone.import-stage-journal.event.v3\0"
_TRANSITION_ID_DOMAIN = b"flux-clone.import-stage-journal.transition-id.v2\0"
_SCHEMA_DOMAIN = b"flux-clone.import-stage-journal.schema.v3\0"
_CATALOG_DOMAIN = b"flux-clone.import-stage-journal.catalog.v1\0"
_JOURNAL_KEY_DOMAIN = b"flux-clone.import-stage-journal.storage-key.v1\0"
_TRANSITION_ENVELOPE_DOMAIN = (
    b"flux-clone.import-stage-journal.transition-envelope.v1\0"
)
_CAPABILITY_MAC_DOMAIN = b"flux-clone.import-stage-journal.capability-mac.v1\0"

_SCHEMA_DDL = """
CREATE TABLE import_stage_journal_metadata(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    schema_name TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint) = 64),
    journal_key TEXT NOT NULL UNIQUE,
    journal_incarnation TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE import_stage_journal_head(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    journal_key TEXT NOT NULL UNIQUE,
    journal_incarnation TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL CHECK(generation >= 0),
    catalog_sha256 TEXT NOT NULL CHECK(length(catalog_sha256) = 64),
    anchor_attestation_sha256 TEXT NOT NULL
        CHECK(length(anchor_attestation_sha256) = 64)
);
CREATE TABLE import_stage_operations(
    operation_id TEXT PRIMARY KEY,
    authorization_id TEXT NOT NULL UNIQUE,
    authorization_digest TEXT NOT NULL UNIQUE CHECK(length(authorization_digest) = 64),
    project_id TEXT NOT NULL,
    target_store_id TEXT NOT NULL,
    target_store_incarnation TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    candidate_generation INTEGER NOT NULL CHECK(candidate_generation >= 0),
    candidate_last_event_sha256 TEXT NOT NULL CHECK(length(candidate_last_event_sha256) = 64),
    mapping_evidence_id TEXT NOT NULL,
    mapping_evidence_generation INTEGER NOT NULL CHECK(mapping_evidence_generation >= 0),
    mapping_evidence_last_event_sha256 TEXT NOT NULL
        CHECK(length(mapping_evidence_last_event_sha256) = 64),
    owner_session_id TEXT NOT NULL,
    prepared_at TEXT NOT NULL,
    identity_json TEXT NOT NULL,
    identity_sha256 TEXT NOT NULL CHECK(length(identity_sha256) = 64),
    state TEXT NOT NULL CHECK(state IN (
        'prepared', 'transaction_open_started', 'transaction_open',
        'candidate_stage_started', 'candidate_staged',
        'side_effect_uncertain', 'recovery_required',
        'rollback_started', 'rolled_back'
    )),
    generation INTEGER NOT NULL CHECK(generation >= 0),
    last_event_sha256 TEXT NOT NULL CHECK(length(last_event_sha256) = 64),
    updated_at TEXT NOT NULL,
    anchor_attestation_sha256 TEXT NOT NULL CHECK(length(anchor_attestation_sha256) = 64),
    UNIQUE(target_store_id, target_store_incarnation, transaction_id)
);
CREATE TABLE import_stage_operation_events(
    operation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 0),
    transition_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (
        'prepared', 'transaction_open_started', 'transaction_opened',
        'candidate_stage_started', 'candidate_staged',
        'side_effect_uncertain', 'recovery_required',
        'rollback_started', 'rollback_completed'
    )),
    from_state TEXT,
    to_state TEXT NOT NULL,
    actor TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64),
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
    previous_event_sha256 TEXT NOT NULL CHECK(length(previous_event_sha256) = 64),
    event_sha256 TEXT NOT NULL UNIQUE CHECK(length(event_sha256) = 64),
    PRIMARY KEY(operation_id, sequence),
    UNIQUE(operation_id, transition_id),
    FOREIGN KEY(operation_id) REFERENCES import_stage_operations(operation_id)
);
CREATE UNIQUE INDEX idx_import_stage_operations_candidate_target
ON import_stage_operations(
    project_id, target_store_id, target_store_incarnation,
    candidate_id, candidate_generation, candidate_last_event_sha256
);
CREATE UNIQUE INDEX idx_import_stage_operations_mapping_target
ON import_stage_operations(
    project_id, mapping_evidence_id, mapping_evidence_generation,
    mapping_evidence_last_event_sha256
);
CREATE TRIGGER import_stage_metadata_no_update
BEFORE UPDATE ON import_stage_journal_metadata
BEGIN SELECT RAISE(ABORT, 'stage journal metadata is immutable'); END;
CREATE TRIGGER import_stage_metadata_no_delete
BEFORE DELETE ON import_stage_journal_metadata
BEGIN SELECT RAISE(ABORT, 'stage journal metadata is immutable'); END;
CREATE TRIGGER import_stage_head_no_delete
BEFORE DELETE ON import_stage_journal_head
BEGIN SELECT RAISE(ABORT, 'stage journal head is durable'); END;
CREATE TRIGGER import_stage_head_monotonic_update
BEFORE UPDATE ON import_stage_journal_head
WHEN NEW.singleton != OLD.singleton
 OR NEW.journal_key != OLD.journal_key
 OR NEW.journal_incarnation != OLD.journal_incarnation
 OR NEW.generation != OLD.generation + 1
 OR NEW.catalog_sha256 = OLD.catalog_sha256
 OR NEW.anchor_attestation_sha256 = OLD.anchor_attestation_sha256
BEGIN SELECT RAISE(ABORT, 'stage journal head update is not monotonic'); END;
CREATE TRIGGER import_stage_operations_no_delete
BEFORE DELETE ON import_stage_operations
BEGIN SELECT RAISE(ABORT, 'stage operations are durable'); END;
CREATE TRIGGER import_stage_operations_identity_immutable
BEFORE UPDATE ON import_stage_operations
WHEN NEW.operation_id != OLD.operation_id
 OR NEW.authorization_id != OLD.authorization_id
 OR NEW.authorization_digest != OLD.authorization_digest
 OR NEW.project_id != OLD.project_id
 OR NEW.target_store_id != OLD.target_store_id
 OR NEW.target_store_incarnation != OLD.target_store_incarnation
 OR NEW.transaction_id != OLD.transaction_id
 OR NEW.candidate_id != OLD.candidate_id
 OR NEW.candidate_generation != OLD.candidate_generation
 OR NEW.candidate_last_event_sha256 != OLD.candidate_last_event_sha256
 OR NEW.mapping_evidence_id != OLD.mapping_evidence_id
 OR NEW.mapping_evidence_generation != OLD.mapping_evidence_generation
 OR NEW.mapping_evidence_last_event_sha256 != OLD.mapping_evidence_last_event_sha256
 OR NEW.owner_session_id != OLD.owner_session_id
 OR NEW.prepared_at != OLD.prepared_at
 OR NEW.identity_json != OLD.identity_json
 OR NEW.identity_sha256 != OLD.identity_sha256
BEGIN SELECT RAISE(ABORT, 'stage operation identity is immutable'); END;
CREATE TRIGGER import_stage_operations_monotonic_update
BEFORE UPDATE ON import_stage_operations
WHEN NEW.generation != OLD.generation + 1
 OR NEW.last_event_sha256 = OLD.last_event_sha256
 OR NEW.anchor_attestation_sha256 = OLD.anchor_attestation_sha256
 OR NOT EXISTS(
    SELECT 1 FROM import_stage_operation_events e
    WHERE e.operation_id = OLD.operation_id
      AND e.sequence = NEW.generation
      AND e.event_sha256 = NEW.last_event_sha256
      AND e.from_state = OLD.state
      AND e.to_state = NEW.state
 )
BEGIN SELECT RAISE(ABORT, 'stage operation update is not monotonic'); END;
CREATE TRIGGER import_stage_events_no_update
BEFORE UPDATE ON import_stage_operation_events
BEGIN SELECT RAISE(ABORT, 'stage operation events are append-only'); END;
CREATE TRIGGER import_stage_events_no_delete
BEFORE DELETE ON import_stage_operation_events
BEGIN SELECT RAISE(ABORT, 'stage operation events are append-only'); END;
CREATE TRIGGER import_stage_events_append_chain
BEFORE INSERT ON import_stage_operation_events
WHEN (
    NEW.sequence = 0 AND (
        NEW.from_state IS NOT NULL
        OR NEW.to_state != 'prepared'
        OR NEW.previous_event_sha256 !=
           '0000000000000000000000000000000000000000000000000000000000000000'
        OR NOT EXISTS(
            SELECT 1 FROM import_stage_operations o
            WHERE o.operation_id = NEW.operation_id
              AND o.generation = 0
              AND o.state = 'prepared'
              AND o.last_event_sha256 = NEW.event_sha256
        )
        OR EXISTS(
            SELECT 1 FROM import_stage_operation_events e
            WHERE e.operation_id = NEW.operation_id
        )
    )
) OR (
    NEW.sequence > 0 AND NOT EXISTS(
        SELECT 1 FROM import_stage_operation_events e
        JOIN import_stage_operations o ON o.operation_id = e.operation_id
        WHERE e.operation_id = NEW.operation_id
          AND e.sequence = NEW.sequence - 1
          AND e.event_sha256 = NEW.previous_event_sha256
          AND e.to_state = NEW.from_state
          AND o.generation = NEW.sequence - 1
          AND o.last_event_sha256 = e.event_sha256
          AND o.state = e.to_state
    )
)
BEGIN SELECT RAISE(ABORT, 'stage operation event chain is invalid'); END;
"""

_BINDING_FIELDS = {item.name for item in fields(StageOperationBinding)}
_LEGAL_TRANSITIONS = {
    (
        StageOperationState.PREPARED,
        StageOperationState.TRANSACTION_OPEN_STARTED,
    ),
    (StageOperationState.PREPARED, StageOperationState.TRANSACTION_OPEN),
    (StageOperationState.PREPARED, StageOperationState.RECOVERY_REQUIRED),
    (
        StageOperationState.TRANSACTION_OPEN_STARTED,
        StageOperationState.TRANSACTION_OPEN,
    ),
    (
        StageOperationState.TRANSACTION_OPEN_STARTED,
        StageOperationState.SIDE_EFFECT_UNCERTAIN,
    ),
    (
        StageOperationState.TRANSACTION_OPEN_STARTED,
        StageOperationState.RECOVERY_REQUIRED,
    ),
    (
        StageOperationState.TRANSACTION_OPEN,
        StageOperationState.CANDIDATE_STAGE_STARTED,
    ),
    (StageOperationState.TRANSACTION_OPEN, StageOperationState.CANDIDATE_STAGED),
    (StageOperationState.TRANSACTION_OPEN, StageOperationState.RECOVERY_REQUIRED),
    (
        StageOperationState.CANDIDATE_STAGE_STARTED,
        StageOperationState.CANDIDATE_STAGED,
    ),
    (
        StageOperationState.CANDIDATE_STAGE_STARTED,
        StageOperationState.SIDE_EFFECT_UNCERTAIN,
    ),
    (
        StageOperationState.CANDIDATE_STAGE_STARTED,
        StageOperationState.RECOVERY_REQUIRED,
    ),
    (StageOperationState.CANDIDATE_STAGED, StageOperationState.RECOVERY_REQUIRED),
    (
        StageOperationState.SIDE_EFFECT_UNCERTAIN,
        StageOperationState.RECOVERY_REQUIRED,
    ),
    (
        StageOperationState.RECOVERY_REQUIRED,
        StageOperationState.ROLLBACK_STARTED,
    ),
    (StageOperationState.RECOVERY_REQUIRED, StageOperationState.ROLLED_BACK),
    (
        StageOperationState.ROLLBACK_STARTED,
        StageOperationState.SIDE_EFFECT_UNCERTAIN,
    ),
    (
        StageOperationState.ROLLBACK_STARTED,
        StageOperationState.RECOVERY_REQUIRED,
    ),
    (StageOperationState.ROLLBACK_STARTED, StageOperationState.ROLLED_BACK),
}
_KIND_TARGET = {
    StageOperationEventKind.PREPARED: StageOperationState.PREPARED,
    StageOperationEventKind.TRANSACTION_OPEN_STARTED: (
        StageOperationState.TRANSACTION_OPEN_STARTED
    ),
    StageOperationEventKind.TRANSACTION_OPENED: StageOperationState.TRANSACTION_OPEN,
    StageOperationEventKind.CANDIDATE_STAGE_STARTED: (
        StageOperationState.CANDIDATE_STAGE_STARTED
    ),
    StageOperationEventKind.CANDIDATE_STAGED: StageOperationState.CANDIDATE_STAGED,
    StageOperationEventKind.SIDE_EFFECT_UNCERTAIN: (
        StageOperationState.SIDE_EFFECT_UNCERTAIN
    ),
    StageOperationEventKind.RECOVERY_REQUIRED: StageOperationState.RECOVERY_REQUIRED,
    StageOperationEventKind.ROLLBACK_STARTED: StageOperationState.ROLLBACK_STARTED,
    StageOperationEventKind.ROLLBACK_COMPLETED: StageOperationState.ROLLED_BACK,
}
_GUARD_TOKEN = object()


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as exc:
        raise InvalidStageOperation("journal evidence is not canonical JSON data") from exc


def _domain_hash(domain: bytes, value: object) -> str:
    return hashlib.sha256(domain + _canonical_json(value).encode("utf-8")).hexdigest()


def _transition_label(kind: StageOperationEventKind) -> str:
    return {
        StageOperationEventKind.PREPARED: "prepare",
        StageOperationEventKind.TRANSACTION_OPEN_STARTED: "transaction-open-started",
        StageOperationEventKind.TRANSACTION_OPENED: "transaction-open",
        StageOperationEventKind.CANDIDATE_STAGE_STARTED: "candidate-stage-started",
        StageOperationEventKind.CANDIDATE_STAGED: "candidate-stage",
        StageOperationEventKind.SIDE_EFFECT_UNCERTAIN: "side-effect-uncertain",
        StageOperationEventKind.RECOVERY_REQUIRED: "recovery-required",
        StageOperationEventKind.ROLLBACK_STARTED: "rollback-started",
        StageOperationEventKind.ROLLBACK_COMPLETED: "rollback-completed",
    }[kind]


def _transition_id_for(
    *,
    operation_id: str,
    sequence: int,
    kind: StageOperationEventKind,
    from_state: StageOperationState | None,
    to_state: StageOperationState,
    previous_event_sha256: str,
) -> str:
    """Name one deterministic transition slot in the operation hash chain."""

    coordinate = {
        "operation_id": operation_id,
        "expected_generation": sequence - 1,
        "result_generation": sequence,
        "previous_event_sha256": previous_event_sha256,
        "kind": kind.value,
        "from_state": from_state.value if from_state is not None else None,
        "to_state": to_state.value,
    }
    return f"stage-transition-v2:{_domain_hash(_TRANSITION_ID_DOMAIN, coordinate)}"


def _legacy_transition_id_for(
    operation_id: str, kind: StageOperationEventKind
) -> str:
    """Recognize one pre-v2 event of each kind in an existing clean v3 journal."""

    return f"{_transition_label(kind)}:{operation_id[-24:]}"


def _require_transition_identity(
    event: StageOperationEvent,
    prior_events: tuple[StageOperationEvent, ...] | list[StageOperationEvent],
) -> None:
    expected = _transition_id_for(
        operation_id=event.operation_id,
        sequence=event.sequence,
        kind=event.kind,
        from_state=event.from_state,
        to_state=event.to_state,
        previous_event_sha256=event.previous_event_sha256,
    )
    if event.transition_id == expected:
        return
    legacy = _legacy_transition_id_for(event.operation_id, event.kind)
    if event.transition_id == legacy and all(
        prior.kind is not event.kind for prior in prior_events
    ):
        return
    raise StageOperationIntegrityError(
        "transition ID does not bind its exact operation chain position"
    )


def _json_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise StageOperationIntegrityError(
                "persisted journal JSON has a duplicate object key"
            )
        result[key] = value
    return result


def _reject_number(value: str) -> None:
    raise StageOperationIntegrityError(
        f"floating-point journal evidence is forbidden: {value}"
    )


def _load_canonical_json(source: object, label: str) -> object:
    if type(source) is not str:
        raise StageOperationIntegrityError(f"persisted {label} must be JSON text")
    try:
        value = json.loads(
            source,
            object_pairs_hook=_json_pairs,
            parse_float=_reject_number,
            parse_constant=_reject_number,
        )
    except StageOperationIntegrityError:
        raise
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise StageOperationIntegrityError(
            f"persisted {label} is not valid JSON"
        ) from exc
    if _canonical_json(value) != source:
        raise StageOperationIntegrityError(
            f"persisted {label} does not use canonical JSON"
        )
    return cast(object, value)


def _decode_time(value: object, label: str) -> datetime:
    if type(value) is not str or not value.endswith("Z"):
        raise StageOperationIntegrityError(
            f"persisted {label} is not canonical UTC text"
        )
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise StageOperationIntegrityError(f"persisted {label} is invalid") from exc
    if time_text(parsed) != value:
        raise StageOperationIntegrityError(
            f"persisted {label} is not canonical UTC text"
        )
    return parsed


def _binding_payload(binding: StageOperationBinding) -> dict[str, object]:
    payload = asdict(binding)
    payload["command_hashes"] = list(binding.command_hashes)
    for name in (
        "authorization_issued_at",
        "authorization_expires_at",
        "prepared_at",
    ):
        payload[name] = time_text(getattr(binding, name))
    return payload


def _binding_from_payload(value: object) -> StageOperationBinding:
    if type(value) is not dict:
        raise StageOperationIntegrityError(
            "persisted stage-operation binding fields are not exact"
        )
    payload = dict(cast(dict[str, object], value))
    if set(payload) != _BINDING_FIELDS:
        raise StageOperationIntegrityError(
            "persisted stage-operation binding fields are not exact"
        )
    if type(payload["command_hashes"]) is not list:
        raise StageOperationIntegrityError(
            "persisted ordered command hashes must be an array"
        )
    payload["command_hashes"] = tuple(
        cast(list[object], payload["command_hashes"])
    )
    payload["authorization_issued_at"] = _decode_time(
        payload["authorization_issued_at"], "authorization issue time"
    )
    payload["authorization_expires_at"] = _decode_time(
        payload["authorization_expires_at"], "authorization expiry"
    )
    payload["prepared_at"] = _decode_time(payload["prepared_at"], "preparation time")
    try:
        return StageOperationBinding(**payload)  # type: ignore[arg-type]
    except (InvalidStageOperation, TypeError) as exc:
        raise StageOperationIntegrityError(
            "persisted stage-operation binding is invalid"
        ) from exc


def _authorization_projection(
    authorization: AuthorizedImportStagingInput, *, service_actor: str
) -> dict[str, object]:
    return {
        "authorization_id": authorization.authorization_id,
        "authorization_digest": authorization.authorization_digest,
        "authorization_issuer_id": authorization.issuer_id,
        "authorization_issuer_seal": authorization.issuer_seal,
        "authorization_request_id": authorization.request_id,
        "authorization_request_digest": authorization.request_digest,
        "authorization_subject_digest": authorization.subject_digest,
        "mapping_approval_id": authorization.mapping_approval_id,
        "mapping_approval_digest": authorization.mapping_approval_digest,
        "project_id": authorization.project_id,
        "expected_head": authorization.base_revision,
        "run_id": authorization.run_id,
        "run_revision": authorization.run_revision,
        "coordination_incarnation": authorization.coordination_incarnation,
        "coordination_context_digest": authorization.coordination_context_digest,
        "candidate_id": authorization.candidate_id,
        "candidate_sha256": authorization.candidate_sha256,
        "candidate_generation": authorization.candidate_generation,
        "candidate_last_event_sha256": authorization.candidate_last_event_sha256,
        "mapping_evidence_id": authorization.mapping_evidence_id,
        "mapping_evidence_sha256": authorization.mapping_evidence_sha256,
        "mapping_evidence_generation": authorization.mapping_evidence_generation,
        "mapping_evidence_last_event_sha256": (
            authorization.mapping_evidence_last_event_sha256
        ),
        "canonical_candidate_sha256": authorization.canonical_candidate_sha256,
        "mapper_result_sha256": authorization.mapper_result_sha256,
        "source_snapshot_sha256": authorization.source_snapshot_sha256,
        "transaction_id": authorization.transaction_id,
        "command_hashes": authorization.command_hashes,
        "commands_sha256": authorization.commands_sha256,
        "prospective_graph_sha256": authorization.prospective_graph_sha256,
        "prospective_revision_sha256": authorization.prospective_revision_sha256,
        "preview_digest": authorization.preview_digest,
        "review_manifest_sha256": authorization.review_manifest_sha256,
        "approval_operation_key": authorization.operation_key,
        "uploader_actor": authorization.uploader_actor,
        "authorized_human_actor": authorization.authorized_human_actor,
        "mapping_command_actor": authorization.mapping_command_actor,
        "staging_service_actor": authorization.staging_service_actor,
        "uploader_principal_sha256": authorization.uploader_principal_sha256,
        "reviewer_principal_sha256": authorization.reviewer_principal_sha256,
        "mapper_principal_sha256": authorization.mapper_principal_sha256,
        "staging_service_principal_sha256": (
            authorization.staging_service_principal_sha256
        ),
        "project_event_head_sha256": authorization.project_event_head_sha256,
        "run_incarnation": authorization.run_incarnation,
        "run_event_head_sha256": authorization.run_event_head_sha256,
        "coordination_event_head_sha256": (
            authorization.coordination_event_head_sha256
        ),
        "target_store_id": authorization.target_store_id,
        "target_store_incarnation": authorization.target_store_incarnation,
        "authority_snapshot_sha256": authorization.authority_snapshot_sha256,
        "principal_authority_snapshot_sha256": (
            authorization.principal_authority_snapshot_sha256
        ),
        "service_actor": service_actor,
        "authorization_issued_at": authorization.issued_at,
        "authorization_expires_at": authorization.expires_at,
        "authorization_lifecycle_generation": authorization.lifecycle_generation,
        "scope": authorization.scope.value,
        "authorizes_internal_commit": authorization.authorizes_internal_commit,
        "authorizes_manufacturing_release": (
            authorization.authorizes_manufacturing_release
        ),
    }


def _binding_authorization_projection(binding: StageOperationBinding) -> dict[str, object]:
    excluded = {
        "operation_id",
        "prepared_at",
        "owner_session_id",
        "candidate_stage_receipt_sha256",
        "authorization_verifier_id",
        "authorization_verifier_incarnation",
        "authorization_verification_sha256",
        "authorization_consumption_fence_id",
        "authorization_consumption_fence_sha256",
        "evidence_provider_id",
        "evidence_provider_incarnation",
        "execution_coordinator_id",
        "execution_coordinator_incarnation",
        "monotonic_anchor_id",
        "monotonic_anchor_incarnation",
        "journal_key",
        "journal_incarnation",
    }
    payload = asdict(binding)
    payload["command_hashes"] = binding.command_hashes
    return {key: value for key, value in payload.items() if key not in excluded}


def _attestation_payload(value: object) -> dict[str, object]:
    payload = cast(dict[str, object], asdict(value))  # type: ignore[arg-type]
    for key, item in tuple(payload.items()):
        if type(item) is datetime:
            payload[key] = time_text(item)
        elif type(item) in {
            CandidateDisposition,
            LeaseMode,
            RecoveryCause,
            TransactionDisposition,
        }:
            payload[key] = cast(
                CandidateDisposition
                | LeaseMode
                | RecoveryCause
                | TransactionDisposition,
                item,
            ).value
        elif type(item) is tuple:
            payload[key] = list(cast(tuple[object, ...], item))
    return payload


def _decode_attestation[T](cls: type[T], value: object, label: str) -> T:
    if type(value) is not dict:
        raise StageOperationIntegrityError(f"persisted {label} must be an object")
    expected = {item.name for item in fields(cls)}  # type: ignore[arg-type]
    payload = dict(cast(dict[str, object], value))
    if set(payload) != expected:
        raise StageOperationIntegrityError(f"persisted {label} fields are not exact")
    for time_field in ("observed_at", "acquired_at"):
        if time_field in payload:
            payload[time_field] = _decode_time(
                payload[time_field], f"{label} {time_field}"
            )
    if cls in {TransactionOpenEvidence, TransactionPreflightEvidence}:
        if type(payload["command_hashes"]) is not list:
            raise StageOperationIntegrityError(f"persisted {label} commands are invalid")
        payload["command_hashes"] = tuple(
            cast(list[object], payload["command_hashes"])
        )
    if cls is LiveAuthorityEvidence:
        payload["candidate_disposition"] = CandidateDisposition(
            payload["candidate_disposition"]
        )
    if cls is TransactionPreflightEvidence:
        payload["disposition"] = TransactionDisposition(payload["disposition"])
    if cls is CandidatePreflightEvidence:
        payload["disposition"] = CandidateDisposition(payload["disposition"])
    if cls in {ExecutionLease, ExecutionLeaseValidation}:
        payload["mode"] = LeaseMode(payload["mode"])
    if cls is RecoveryEvidence:
        payload["cause"] = RecoveryCause(payload["cause"])
        payload["transaction_disposition"] = TransactionDisposition(
            payload["transaction_disposition"]
        )
        payload["candidate_disposition"] = CandidateDisposition(
            payload["candidate_disposition"]
        )
    if cls is RollbackEvidence:
        payload["transaction_disposition"] = TransactionDisposition(
            payload["transaction_disposition"]
        )
        payload["candidate_disposition"] = CandidateDisposition(
            payload["candidate_disposition"]
        )
    try:
        return cls(**payload)  # type: ignore[arg-type]
    except Exception as exc:
        raise StageOperationIntegrityError(f"persisted {label} is invalid") from exc


def _capture_trusted_output[T](cls: type[T], value: object, label: str) -> T:
    """Copy an exact trusted record into non-virtual builtin fields once."""

    if type(value) is not cls:
        raise StageOperationEvidenceMismatch(
            f"trusted {label} returned a subclass/non-exact record"
        )
    try:
        snapshot = _attestation_payload(value)
        captured = _decode_attestation(cls, snapshot, label)
        if _attestation_payload(value) != snapshot:
            raise StageOperationEvidenceMismatch(
                f"trusted {label} fields changed while being captured"
            )
        return captured
    except StageOperationEvidenceMismatch:
        raise
    except Exception as exc:
        raise StageOperationEvidenceMismatch(
            f"trusted {label} is malformed"
        ) from exc


def _request_digest(
    *,
    operation_id: str,
    expected_generation: int,
    transition_id: str,
    kind: StageOperationEventKind,
    from_state: StageOperationState | None,
    to_state: StageOperationState,
    actor: str,
    payload_sha256: str,
) -> str:
    return _domain_hash(
        _REQUEST_DOMAIN,
        {
            "operation_id": operation_id,
            "expected_generation": expected_generation,
            "transition_id": transition_id,
            "kind": kind.value,
            "from_state": from_state.value if from_state is not None else None,
            "to_state": to_state.value,
            "actor": actor,
            "payload_sha256": payload_sha256,
        },
    )


def _event_digest(event: Mapping[str, object]) -> str:
    return _domain_hash(_EVENT_DOMAIN, event)


def _transaction_effect_identity(
    value: TransactionOpenEvidence,
) -> tuple[object, ...]:
    """Stable transaction facts; observation time and attestation are fresh."""

    return (
        value.provider_id,
        value.provider_incarnation,
        value.authorization_digest,
        value.project_id,
        value.project_head,
        value.target_store_id,
        value.target_store_incarnation,
        value.transaction_id,
        value.transaction_generation,
        value.command_hashes,
        value.commands_sha256,
        value.prospective_graph_sha256,
        value.preview_digest,
        value.transaction_snapshot_sha256,
    )


def _candidate_effect_identity(
    value: CandidateStagedEvidence,
) -> tuple[object, ...]:
    """Stable candidate-CAS facts; observation time and attestation are fresh."""

    return (
        value.provider_id,
        value.provider_incarnation,
        value.authorization_digest,
        value.candidate_id,
        value.prior_candidate_sha256,
        value.prior_candidate_generation,
        value.prior_candidate_last_event_sha256,
        value.staged_candidate_generation,
        value.staged_candidate_last_event_sha256,
        value.staged_candidate_snapshot_sha256,
        value.candidate_stage_receipt_sha256,
        value.transaction_id,
        value.transaction_snapshot_sha256,
    )


def _event_envelope_payload(event: StageOperationEvent) -> dict[str, object]:
    return {
        "operation_id": event.operation_id,
        "sequence": event.sequence,
        "transition_id": event.transition_id,
        "kind": event.kind.value,
        "from_state": (
            event.from_state.value if event.from_state is not None else None
        ),
        "to_state": event.to_state.value,
        "actor": event.actor,
        "occurred_at": time_text(event.occurred_at),
        "request_sha256": event.request_sha256,
        "payload": dict(event.payload),
        "payload_sha256": event.payload_sha256,
        "previous_event_sha256": event.previous_event_sha256,
        "event_sha256": event.event_sha256,
    }


def _event_from_envelope(value: object) -> StageOperationEvent:
    expected = {
        "operation_id",
        "sequence",
        "transition_id",
        "kind",
        "from_state",
        "to_state",
        "actor",
        "occurred_at",
        "request_sha256",
        "payload",
        "payload_sha256",
        "previous_event_sha256",
        "event_sha256",
    }
    if type(value) is not dict:
        raise StageOperationIntegrityError(
            "anchored transition event fields are not exact"
        )
    value = cast(dict[str, object], value)
    if set(value) != expected:
        raise StageOperationIntegrityError(
            "anchored transition event fields are not exact"
        )
    try:
        operation_id = require_public_id(value["operation_id"], "event operation ID")
        sequence = require_nonnegative_int(value["sequence"], "event sequence")
        transition_id = require_public_id(value["transition_id"], "transition ID")
        kind = StageOperationEventKind(value["kind"])
        from_state = (
            StageOperationState(value["from_state"])
            if value["from_state"] is not None
            else None
        )
        to_state = StageOperationState(value["to_state"])
        actor = require_public_id(value["actor"], "event actor")
        occurred_at = _decode_time(value["occurred_at"], "event time")
        payload = value["payload"]
        if type(payload) is not dict:
            raise StageOperationIntegrityError("anchored event payload is not exact")
        payload = cast(dict[str, object], payload)
        for name in (
            "request_sha256",
            "payload_sha256",
            "previous_event_sha256",
            "event_sha256",
        ):
            require_sha256(value[name], f"anchored event {name}")
        previous_event_sha256 = require_sha256(
            value["previous_event_sha256"], "anchored event previous head"
        )
        event_sha256 = require_sha256(
            value["event_sha256"], "anchored event digest"
        )
    except (InvalidStageOperation, ValueError) as exc:
        raise StageOperationIntegrityError(
            "anchored transition event is malformed"
        ) from exc
    payload_sha256 = _domain_hash(_PAYLOAD_DOMAIN, payload)
    request_sha256 = _request_digest(
        operation_id=operation_id,
        expected_generation=sequence - 1,
        transition_id=transition_id,
        kind=kind,
        from_state=from_state,
        to_state=to_state,
        actor=actor,
        payload_sha256=payload_sha256,
    )
    material = {
        "operation_id": operation_id,
        "sequence": sequence,
        "transition_id": transition_id,
        "kind": kind.value,
        "from_state": from_state.value if from_state is not None else None,
        "to_state": to_state.value,
        "actor": actor,
        "occurred_at": time_text(occurred_at),
        "request_sha256": request_sha256,
        "payload_sha256": payload_sha256,
        "previous_event_sha256": previous_event_sha256,
    }
    if (
        value["payload_sha256"] != payload_sha256
        or value["request_sha256"] != request_sha256
        or value["event_sha256"] != _event_digest(material)
    ):
        raise StageOperationIntegrityError(
            "anchored transition event digest is inconsistent"
        )
    return StageOperationEvent(
        operation_id=operation_id,
        sequence=sequence,
        transition_id=transition_id,
        kind=kind,
        from_state=from_state,
        to_state=to_state,
        actor=actor,
        occurred_at=occurred_at,
        request_sha256=request_sha256,
        payload_sha256=payload_sha256,
        previous_event_sha256=previous_event_sha256,
        event_sha256=event_sha256,
        payload=MappingProxyType(dict(payload)),
    )


def _transition_envelope(
    *,
    kind: str,
    journal_key: str,
    journal_incarnation: str,
    expected_journal_generation: int,
    expected_journal_catalog_sha256: str,
    journal_generation: int,
    journal_catalog_sha256: str,
    binding: StageOperationBinding,
    identity_json: str,
    identity_sha256: str,
    expected_operation_generation: int | None,
    expected_operation_event_head_sha256: str,
    expected_operation_state: StageOperationState | None,
    event: StageOperationEvent,
) -> tuple[str, str]:
    envelope = {
        "version": 1,
        "kind": kind,
        "journal_key": journal_key,
        "journal_incarnation": journal_incarnation,
        "expected_journal_generation": expected_journal_generation,
        "expected_journal_catalog_sha256": expected_journal_catalog_sha256,
        "journal_generation": journal_generation,
        "journal_catalog_sha256": journal_catalog_sha256,
        "operation_id": binding.operation_id,
        "identity_json": identity_json,
        "identity_sha256": identity_sha256,
        "expected_operation_generation": expected_operation_generation,
        "expected_operation_event_head_sha256": (
            expected_operation_event_head_sha256
        ),
        "expected_operation_state": (
            expected_operation_state.value
            if expected_operation_state is not None
            else None
        ),
        "result_operation_generation": event.sequence,
        "result_operation_event_head_sha256": event.event_sha256,
        "result_operation_state": event.to_state.value,
        "event": _event_envelope_payload(event),
    }
    encoded = _canonical_json(envelope)
    return encoded, hashlib.sha256(
        _TRANSITION_ENVELOPE_DOMAIN + encoded.encode("utf-8")
    ).hexdigest()


def _catalog_digest(
    journal_key: str,
    journal_incarnation: str,
    operations: list[dict[str, object]],
) -> str:
    return _domain_hash(
        _CATALOG_DOMAIN,
        {
            "journal_key": journal_key,
            "journal_incarnation": journal_incarnation,
            "operations": sorted(operations, key=lambda item: str(item["operation_id"])),
        },
    )


def _schema_catalog(connection: sqlite3.Connection) -> tuple[dict[str, object], ...]:
    rows = connection.execute(
        "SELECT type, name, sql FROM sqlite_master "
        "WHERE type IN ('table','index','trigger','view') "
        "ORDER BY type, name"
    ).fetchall()
    return tuple(
        {
            "type": str(row[0]),
            "name": str(row[1]),
            # Keep exact stored SQL.  Whitespace normalization is unsafe here:
            # it also normalizes whitespace inside SQL string literals and can
            # make different trigger/check behavior share one fingerprint.
            "sql": None if row[2] is None else str(row[2]),
        }
        for row in rows
    )


def _compiled_schema() -> tuple[tuple[dict[str, object], ...], str]:
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(_SCHEMA_DDL)
        catalog = _schema_catalog(connection)
    finally:
        connection.close()
    digest = _domain_hash(
        _SCHEMA_DOMAIN,
        {
            "application_id": _APPLICATION_ID,
            "schema_name": _SCHEMA_NAME,
            "schema_version": IMPORT_STAGE_JOURNAL_SCHEMA_VERSION,
            "objects": catalog,
        },
    )
    return catalog, digest


_EXPECTED_SCHEMA_CATALOG, _EXPECTED_SCHEMA_FINGERPRINT = _compiled_schema()


class StageExecutionGuard:
    """Unforgeable-in-process capability held only under an execution lease."""

    def __init__(
        self,
        token: object,
        journal: SQLiteImportStageOperationJournal,
        capability: object,
        operation_id: str,
        service_actor: str,
    ) -> None:
        if token is not _GUARD_TOKEN:
            raise InvalidStageOperation("execution guards are journal-issued")
        self._journal = journal
        self._capability = capability
        self._operation_id = operation_id
        self._service_actor = service_actor

    @property
    def operation(self) -> StageOperation:
        return self._journal._guard_operation(  # pyright: ignore[reportPrivateUsage]
            self._capability, LeaseMode.EXECUTION
        )

    def execute_transaction_open(
        self, side_effect: Callable[[StageOperationBinding], object]
    ) -> TransitionResult:
        return self._journal._execute_transaction_open(  # pyright: ignore[reportPrivateUsage]
            self._capability, self._operation_id, self._service_actor, side_effect
        )

    def execute_candidate_stage(
        self, side_effect: Callable[[StageOperationBinding, str], object]
    ) -> TransitionResult:
        return self._journal._execute_candidate_stage(  # pyright: ignore[reportPrivateUsage]
            self._capability, self._operation_id, self._service_actor, side_effect
        )


class StageRecoveryGuard:
    """Rollback-only capability held under the same exclusive coordinator."""

    def __init__(
        self,
        token: object,
        journal: SQLiteImportStageOperationJournal,
        capability: object,
        operation_id: str,
        service_actor: str,
    ) -> None:
        if token is not _GUARD_TOKEN:
            raise InvalidStageOperation("recovery guards are journal-issued")
        self._journal = journal
        self._capability = capability
        self._operation_id = operation_id
        self._service_actor = service_actor

    @property
    def operation(self) -> StageOperation:
        return self._journal._guard_operation(  # pyright: ignore[reportPrivateUsage]
            self._capability, LeaseMode.RECOVERY
        )

    def execute_rollback(
        self, side_effect: Callable[[StageOperationBinding], object]
    ) -> TransitionResult:
        return self._journal._execute_rollback(  # pyright: ignore[reportPrivateUsage]
            self._capability, self._operation_id, self._service_actor, side_effect
        )


class SQLiteImportStageOperationJournal:
    """Durable stage journal with mandatory external trust boundaries."""

    def __init__(
        self,
        path: str | Path,
        *,
        authorization_verifier: StageAuthorizationVerifier,
        evidence_provider: TrustedStageEvidenceProvider,
        execution_coordinator: ExclusiveStageExecutionCoordinator,
        monotonic_anchor: MonotonicStageJournalAnchor,
        receipt_mac_key: bytes,
        clock: Callable[[], datetime] | None = None,
        journal_key: str | None = None,
    ) -> None:
        requirements = (
            (authorization_verifier, StageAuthorizationVerifier, "authorization verifier"),
            (evidence_provider, TrustedStageEvidenceProvider, "evidence provider"),
            (
                execution_coordinator,
                ExclusiveStageExecutionCoordinator,
                "execution coordinator",
            ),
            (monotonic_anchor, MonotonicStageJournalAnchor, "monotonic anchor"),
        )
        for value, protocol, label in requirements:
            if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
                value, protocol
            ):
                raise InvalidStageOperation(f"journal requires a trusted {label}")
        if clock is not None and not callable(clock):
            raise InvalidStageOperation("journal clock must be callable")
        if type(receipt_mac_key) is not bytes or len(receipt_mac_key) < 32:
            raise InvalidStageOperation(
                "journal receipt MAC key must be at least 32 exact bytes"
            )
        self._authorization_verifier = authorization_verifier
        self._evidence_provider = evidence_provider
        self._execution_coordinator = execution_coordinator
        self._monotonic_anchor = monotonic_anchor
        captured_identities = (
            (authorization_verifier.verifier_id, "authorization verifier ID"),
            (
                authorization_verifier.verifier_incarnation,
                "authorization verifier incarnation",
            ),
            (evidence_provider.provider_id, "evidence provider ID"),
            (evidence_provider.provider_incarnation, "evidence provider incarnation"),
            (execution_coordinator.coordinator_id, "execution coordinator ID"),
            (
                execution_coordinator.coordinator_incarnation,
                "execution coordinator incarnation",
            ),
            (monotonic_anchor.anchor_id, "monotonic anchor ID"),
            (monotonic_anchor.anchor_incarnation, "monotonic anchor incarnation"),
        )
        for value, label in captured_identities:
            require_public_id(value, label)
        (
            (self._authorization_verifier_id, _),
            (self._authorization_verifier_incarnation, _),
            (self._evidence_provider_id, _),
            (self._evidence_provider_incarnation, _),
            (self._execution_coordinator_id, _),
            (self._execution_coordinator_incarnation, _),
            (self._monotonic_anchor_id, _),
            (self._monotonic_anchor_incarnation, _),
        ) = captured_identities
        self._verify_and_consume_call = authorization_verifier.verify_and_consume
        self._verify_live_call = authorization_verifier.verify_live
        self._live_authority_call = evidence_provider.live_authority
        self._transaction_preflight_call = evidence_provider.transaction_preflight
        self._transaction_open_call = evidence_provider.transaction_open
        self._candidate_preflight_call = evidence_provider.candidate_preflight
        self._candidate_staged_call = evidence_provider.candidate_staged
        self._recovery_state_call = evidence_provider.recovery_state
        self._rollback_complete_call = evidence_provider.rollback_complete
        self._lease_acquire_call = execution_coordinator.acquire
        self._lease_validate_call = execution_coordinator.validate
        self._anchor_claim_call = monotonic_anchor.claim
        self._anchor_advance_call = monotonic_anchor.advance
        self._anchor_current_call = monotonic_anchor.current
        self._anchor_current_journal_call = monotonic_anchor.current_journal
        self._receipt_mac_key = bytes(receipt_mac_key)
        self._receipt_mac_key_id = hashlib.sha256(
            b"flux-clone.import-stage-journal.capability-key.v1\0"
            + self._receipt_mac_key
        ).hexdigest()
        self._path = str(path)
        if journal_key is None:
            location = (
                f"memory:{self._monotonic_anchor_id}:"
                f"{self._monotonic_anchor_incarnation}"
                if self._path == ":memory:"
                else str(Path(self._path).resolve()).casefold()
            )
            journal_key = "stage-journal-" + _domain_hash(
                _JOURNAL_KEY_DOMAIN, {"location": location}
            )[:40]
        self._journal_key = require_public_id(journal_key, "stage journal key")
        self._clock = clock or (lambda: datetime.now(UTC))
        self._lock = RLock()
        self._active_guards: dict[
            int, tuple[object, LeaseMode, str, ExecutionLease]
        ] = {}
        self._session_id = f"stage-session-{secrets.token_hex(32)}"
        try:
            self._connection = sqlite3.connect(
                self._path,
                timeout=10.0,
                isolation_level=None,
                check_same_thread=False,
            )
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute("PRAGMA busy_timeout = 10000")
            self._connection.execute("PRAGMA trusted_schema = OFF")
            if self._path != ":memory:":
                self._connection.execute("PRAGMA journal_mode = WAL")
                self._connection.execute("PRAGMA synchronous = FULL")
            self._initialize_schema()
            with self._transaction(write=True):
                self._verify_schema_locked()
                self._recover_anchor_projection_locked()
                self._verify_all_locked()
        except ImportStageJournalError:
            if hasattr(self, "_connection"):
                self._connection.close()
            raise
        except sqlite3.Error as exc:
            if hasattr(self, "_connection"):
                self._connection.close()
            raise StageJournalUnavailable(
                f"could not open import stage journal: {exc}"
            ) from exc

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def journal_key(self) -> str:
        return self._journal_key

    def close(self) -> None:
        with self._lock:
            if self._active_guards:
                raise StageOperationRecoveryRequired(
                    "cannot close a journal while an execution/recovery guard is live"
                )
            self._connection.close()

    def __enter__(self) -> SQLiteImportStageOperationJournal:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _now(self) -> datetime:
        try:
            return require_time(self._clock(), "journal clock value")
        except InvalidStageOperation:
            raise
        except Exception as exc:
            raise InvalidStageOperation("journal clock failed") from exc

    @contextmanager
    def _transaction(self, *, write: bool) -> Generator[None, None, None]:
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield
                self._connection.execute("COMMIT")
            except BaseException:
                with suppress(sqlite3.Error):
                    self._connection.execute("ROLLBACK")
                raise

    def _initialize_schema(self) -> None:
        with self._transaction(write=True):
            application_id = int(
                self._connection.execute("PRAGMA application_id").fetchone()[0]
            )
            user_version = int(
                self._connection.execute("PRAGMA user_version").fetchone()[0]
            )
            object_count = int(
                self._connection.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0]
            )
            truly_empty = application_id == 0 and user_version == 0 and object_count == 0
            if truly_empty:
                external = self._current_journal_anchor()
                if external is not None:
                    raise StageOperationIntegrityError(
                        "refusing to bootstrap a replaced/rolled-back journal database"
                    )
                self._connection.execute(f"PRAGMA application_id = {_APPLICATION_ID}")
                self._connection.execute(
                    f"PRAGMA user_version = {IMPORT_STAGE_JOURNAL_SCHEMA_VERSION}"
                )
                self._execute_ddl_locked(_SCHEMA_DDL)
                self._journal_incarnation = (
                    f"stage-journal-incarnation-{secrets.token_hex(32)}"
                )
                created_at = self._now()
                empty_catalog = _catalog_digest(
                    self._journal_key, self._journal_incarnation, []
                )
                self._connection.execute(
                    "INSERT INTO import_stage_journal_metadata VALUES(1,?,?,?,?,?,?)",
                    (
                        _SCHEMA_NAME,
                        IMPORT_STAGE_JOURNAL_SCHEMA_VERSION,
                        _EXPECTED_SCHEMA_FINGERPRINT,
                        self._journal_key,
                        self._journal_incarnation,
                        time_text(created_at),
                    ),
                )
                self._connection.execute(
                    "INSERT INTO import_stage_journal_head VALUES(1,?,?,?,?,?)",
                    (
                        self._journal_key,
                        self._journal_incarnation,
                        0,
                        empty_catalog,
                        _ZERO_DIGEST,
                    ),
                )
                return
            if (
                application_id != _APPLICATION_ID
                or user_version != IMPORT_STAGE_JOURNAL_SCHEMA_VERSION
            ):
                raise UnsupportedStageJournalSchema(
                    "refusing to claim an unrecognized or unsupported database"
                )
            self._verify_schema_locked()
            row = self._connection.execute(
                "SELECT * FROM import_stage_journal_metadata WHERE singleton = 1"
            ).fetchone()
            if row is None or row["journal_key"] != self._journal_key:
                raise StageOperationIntegrityError(
                    "journal file is not bound to this configured storage key"
                )
            self._journal_incarnation = require_public_id(
                row["journal_incarnation"], "persisted journal incarnation"
            )

    def _execute_ddl_locked(self, script: str) -> None:
        statement = ""
        for line in script.splitlines(keepends=True):
            statement += line
            if sqlite3.complete_statement(statement):
                self._connection.execute(statement)
                statement = ""
        if statement.strip():
            raise UnsupportedStageJournalSchema("journal schema DDL is incomplete")

    def _verify_schema_locked(self) -> None:
        if int(self._connection.execute("PRAGMA application_id").fetchone()[0]) != _APPLICATION_ID:
            raise UnsupportedStageJournalSchema("journal application identity changed")
        if (
            int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            != IMPORT_STAGE_JOURNAL_SCHEMA_VERSION
        ):
            raise UnsupportedStageJournalSchema("journal schema version changed")
        observed = _schema_catalog(self._connection)
        if observed != _EXPECTED_SCHEMA_CATALOG:
            raise StageOperationIntegrityError(
                "journal schema differs from the compiled expected DDL"
            )
        observed_digest = _domain_hash(
            _SCHEMA_DOMAIN,
            {
                "application_id": _APPLICATION_ID,
                "schema_name": _SCHEMA_NAME,
                "schema_version": IMPORT_STAGE_JOURNAL_SCHEMA_VERSION,
                "objects": observed,
            },
        )
        row = self._connection.execute(
            "SELECT * FROM import_stage_journal_metadata WHERE singleton = 1"
        ).fetchone()
        if (
            row is None
            or row["schema_name"] != _SCHEMA_NAME
            or row["schema_version"] != IMPORT_STAGE_JOURNAL_SCHEMA_VERSION
            or row["schema_fingerprint"] != _EXPECTED_SCHEMA_FINGERPRINT
            or observed_digest != _EXPECTED_SCHEMA_FINGERPRINT
        ):
            raise StageOperationIntegrityError("journal schema metadata is invalid")
        require_public_id(row["journal_key"], "persisted journal key")
        require_public_id(row["journal_incarnation"], "persisted journal incarnation")
        _decode_time(row["created_at"], "journal schema creation time")

    def prepare(
        self,
        authorization: AuthorizedImportStagingInput,
        *,
        service_actor: str,
    ) -> PrepareResult:
        """Consume and authenticate one seal, then durably record PREPARED."""

        if type(authorization) is not AuthorizedImportStagingInput:
            raise InvalidStageOperation(
                "preparation requires AuthorizedImportStagingInput"
            )
        require_public_id(service_actor, "stage service actor")
        authorization_snapshot = _authorization_projection(
            authorization, service_actor=service_actor
        )
        verification = self._verify_and_consume(authorization, service_actor)
        if _authorization_projection(
            authorization, service_actor=service_actor
        ) != authorization_snapshot:
            raise StageOperationEvidenceMismatch(
                "authorization fields changed during trusted verification"
            )
        operation_id = operation_id_for(authorization.authorization_digest)
        with self._transaction(write=True):
            self._verify_journal_head_locked()
            existing_row = self._connection.execute(
                "SELECT * FROM import_stage_operations "
                "WHERE operation_id=? OR authorization_id=? OR authorization_digest=?",
                (
                    operation_id,
                    authorization.authorization_id,
                    authorization.authorization_digest,
                ),
            ).fetchone()
            if existing_row is not None:
                existing = self._load_operation_row_locked(existing_row)
                if _binding_authorization_projection(
                    existing.binding
                ) != _authorization_projection(
                    authorization, service_actor=service_actor
                ):
                    raise StageOperationReplayError(
                        "authorization was already consumed by a different binding"
                    )
                self._validate_verification(
                    existing.binding,
                    verification,
                    not_before=existing.binding.prepared_at,
                    not_after=self._now(),
                    initial=False,
                )
                return PrepareResult(existing, created=False)
            duplicate = self._connection.execute(
                """SELECT operation_id FROM import_stage_operations
                   WHERE (target_store_id=? AND target_store_incarnation=? AND transaction_id=?)
                      OR (project_id=? AND target_store_id=? AND target_store_incarnation=?
                          AND candidate_id=? AND candidate_generation=?
                          AND candidate_last_event_sha256=?)
                      OR (project_id=? AND mapping_evidence_id=?
                          AND mapping_evidence_generation=?
                          AND mapping_evidence_last_event_sha256=?)""",
                (
                    authorization.target_store_id,
                    authorization.target_store_incarnation,
                    authorization.transaction_id,
                    authorization.project_id,
                    authorization.target_store_id,
                    authorization.target_store_incarnation,
                    authorization.candidate_id,
                    authorization.candidate_generation,
                    authorization.candidate_last_event_sha256,
                    authorization.project_id,
                    authorization.mapping_evidence_id,
                    authorization.mapping_evidence_generation,
                    authorization.mapping_evidence_last_event_sha256,
                ),
            ).fetchone()
            if duplicate is not None:
                raise StageOperationReplayError(
                    "exact transaction/candidate/mapping target was already consumed"
                )
            prepared_at = self._now()
            if verification.observed_at > prepared_at:
                raise StageOperationEvidenceMismatch(
                    "authorization verification is from the future"
                )
            binding = StageOperationBinding.from_authorization(
                authorization,
                service_actor=service_actor,
                verification=verification,
                evidence_provider_id=self._evidence_provider_id,
                evidence_provider_incarnation=self._evidence_provider_incarnation,
                execution_coordinator_id=self._execution_coordinator_id,
                execution_coordinator_incarnation=(
                    self._execution_coordinator_incarnation
                ),
                monotonic_anchor_id=self._monotonic_anchor_id,
                monotonic_anchor_incarnation=self._monotonic_anchor_incarnation,
                journal_key=self._journal_key,
                journal_incarnation=self._journal_incarnation,
                prepared_at=prepared_at,
                owner_session_id=self._session_id,
            )
            if _binding_authorization_projection(binding) != authorization_snapshot:
                raise StageOperationEvidenceMismatch(
                    "captured binding changed from the verified authorization snapshot"
                )
            identity = _binding_payload(binding)
            identity_json = _canonical_json(identity)
            identity_sha256 = _domain_hash(_IDENTITY_DOMAIN, identity)
            payload: dict[str, object] = {
                "authorization_digest": binding.authorization_digest,
                "identity_sha256": identity_sha256,
                "authorization_verification": _attestation_payload(verification),
            }
            event = self._make_event(
                operation_id=binding.operation_id,
                sequence=0,
                kind=StageOperationEventKind.PREPARED,
                from_state=None,
                to_state=StageOperationState.PREPARED,
                actor=service_actor,
                occurred_at=prepared_at,
                payload=payload,
                previous_event_sha256=_ZERO_DIGEST,
            )
            self._validate_event_payload(
                binding, event, previous=None, integrity=False
            )
            head = self._head_row_locked()
            catalog = self._prospective_catalog_digest_locked(
                {
                    "operation_id": binding.operation_id,
                    "identity_sha256": identity_sha256,
                    "generation": 0,
                    "last_event_sha256": event.event_sha256,
                    "state": StageOperationState.PREPARED.value,
                }
            )
            anchor = self._claim_anchor(
                binding=binding,
                identity_sha256=identity_sha256,
                event=event,
                journal_generation=int(head["generation"]) + 1,
                journal_catalog_sha256=catalog,
                expected_journal_catalog_sha256=str(head["catalog_sha256"]),
            )
            try:
                self._connection.execute(
                    """INSERT INTO import_stage_operations(
                        operation_id,authorization_id,authorization_digest,
                        project_id,target_store_id,target_store_incarnation,
                        transaction_id,candidate_id,candidate_generation,
                        candidate_last_event_sha256,mapping_evidence_id,
                        mapping_evidence_generation,mapping_evidence_last_event_sha256,
                        owner_session_id,prepared_at,identity_json,identity_sha256,
                        state,generation,last_event_sha256,updated_at,
                        anchor_attestation_sha256
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)""",
                    (
                        binding.operation_id,
                        binding.authorization_id,
                        binding.authorization_digest,
                        binding.project_id,
                        binding.target_store_id,
                        binding.target_store_incarnation,
                        binding.transaction_id,
                        binding.candidate_id,
                        binding.candidate_generation,
                        binding.candidate_last_event_sha256,
                        binding.mapping_evidence_id,
                        binding.mapping_evidence_generation,
                        binding.mapping_evidence_last_event_sha256,
                        binding.owner_session_id,
                        time_text(binding.prepared_at),
                        identity_json,
                        identity_sha256,
                        StageOperationState.PREPARED.value,
                        event.event_sha256,
                        time_text(prepared_at),
                        anchor.attestation_sha256,
                    ),
                )
                self._insert_event_locked(event)
                self._advance_head_row_locked(anchor)
            except sqlite3.IntegrityError as exc:
                raise StageOperationReplayError(
                    "authorization or exact stage target was already consumed"
                ) from exc
            return PrepareResult(
                self._load_operation_locked(binding.operation_id), created=True
            )

    def get(self, operation_id: str) -> StageOperation:
        require_public_id(operation_id, "stage operation ID")
        with self._transaction(write=False):
            self._verify_journal_head_locked()
            return self._load_operation_locked(operation_id)

    def list_operations(self) -> tuple[StageOperation, ...]:
        with self._transaction(write=False):
            self._verify_journal_head_locked()
            rows = self._connection.execute(
                "SELECT * FROM import_stage_operations ORDER BY operation_id"
            ).fetchall()
            return tuple(self._load_operation_row_locked(row) for row in rows)

    def verify_completed_stage_receipt(
        self, receipt: object
    ) -> VerifiedStageCapability:
        """Authenticate raw audit data against live stores and issue a MACed capability."""

        if type(receipt) is not CompletedStageReceipt:
            raise StageOperationEvidenceMismatch(
                "receipt verification requires an exact CompletedStageReceipt"
            )
        operation = self.get(receipt.operation_id)
        current = operation.completed_stage_receipt
        if type(current) is not CompletedStageReceipt or current != receipt:
            raise StageOperationEvidenceMismatch(
                "raw stage receipt is not the journal's exact current outcome"
            )
        transaction = self._transaction_evidence(operation)
        candidate = self._candidate_evidence(operation)
        verified_at = self._now()
        nonce = f"stage-capability-{secrets.token_hex(32)}"
        material = {
            "operation_id": operation.binding.operation_id,
            "outcome_receipt_sha256": receipt.outcome_receipt_sha256,
            "journal_key": self._journal_key,
            "journal_incarnation": self._journal_incarnation,
            "operation_generation": operation.generation,
            "operation_event_head_sha256": operation.last_event_sha256,
            "journal_generation": operation.journal_generation,
            "journal_catalog_sha256": operation.journal_catalog_sha256,
            "transaction_attestation_sha256": transaction.attestation_sha256,
            "candidate_attestation_sha256": candidate.attestation_sha256,
            "capability_key_id": self._receipt_mac_key_id,
            "verified_at": time_text(verified_at),
            "nonce": nonce,
        }
        mac_sha256 = hmac.new(
            self._receipt_mac_key,
            _CAPABILITY_MAC_DOMAIN + _canonical_json(material).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        issue_values: dict[str, object] = dict(material)
        issue_values["verified_at"] = verified_at
        issue_values["mac_sha256"] = mac_sha256
        return issue_verified_stage_capability(**issue_values)

    def require_verified_stage_capability(
        self, capability: object
    ) -> VerifiedStageCapability:
        """Revalidate a journal-issued capability immediately before acceptance."""

        if type(capability) is not VerifiedStageCapability:
            raise StageOperationEvidenceMismatch(
                "downstream stage acceptance requires an exact verified capability"
            )
        material = {
            "operation_id": object.__getattribute__(capability, "_operation_id"),
            "outcome_receipt_sha256": object.__getattribute__(
                capability, "_outcome_receipt_sha256"
            ),
            "journal_key": object.__getattribute__(capability, "_journal_key"),
            "journal_incarnation": object.__getattribute__(
                capability, "_journal_incarnation"
            ),
            "operation_generation": object.__getattribute__(
                capability, "_operation_generation"
            ),
            "operation_event_head_sha256": object.__getattribute__(
                capability, "_operation_event_head_sha256"
            ),
            "journal_generation": object.__getattribute__(
                capability, "_journal_generation"
            ),
            "journal_catalog_sha256": object.__getattribute__(
                capability, "_journal_catalog_sha256"
            ),
            "transaction_attestation_sha256": object.__getattribute__(
                capability, "_transaction_attestation_sha256"
            ),
            "candidate_attestation_sha256": object.__getattribute__(
                capability, "_candidate_attestation_sha256"
            ),
            "capability_key_id": object.__getattribute__(
                capability, "_capability_key_id"
            ),
            "verified_at": time_text(
                object.__getattribute__(capability, "_verified_at")
            ),
            "nonce": object.__getattribute__(capability, "_nonce"),
        }
        supplied_mac = object.__getattribute__(capability, "_mac_sha256")
        expected_mac = hmac.new(
            self._receipt_mac_key,
            _CAPABILITY_MAC_DOMAIN + _canonical_json(material).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if (
            material["journal_key"] != self._journal_key
            or material["journal_incarnation"] != self._journal_incarnation
            or material["capability_key_id"] != self._receipt_mac_key_id
            or type(supplied_mac) is not str
            or not hmac.compare_digest(supplied_mac, expected_mac)
        ):
            raise StageOperationEvidenceMismatch(
                "verified stage capability MAC/issuer is invalid"
            )
        operation = self.get(str(material["operation_id"]))
        current = operation.completed_stage_receipt
        if (
            type(current) is not CompletedStageReceipt
            or current.outcome_receipt_sha256
            != material["outcome_receipt_sha256"]
            or operation.generation != material["operation_generation"]
            or operation.last_event_sha256
            != material["operation_event_head_sha256"]
            or operation.journal_generation != material["journal_generation"]
            or operation.journal_catalog_sha256
            != material["journal_catalog_sha256"]
            or self._now()
            < object.__getattribute__(capability, "_verified_at")
        ):
            raise StageOperationEvidenceMismatch(
                "verified stage capability is stale or revoked"
            )
        # Re-read both external effects now. Their new observation timestamps
        # need not equal the issuance attestations; exact target validation is
        # performed by these journal-owned methods on every acceptance.
        self._transaction_evidence(operation)
        self._candidate_evidence(operation)
        return capability

    @contextmanager
    def execution_guard(
        self,
        operation_id: str,
        *,
        expected_generation: int,
        service_actor: str,
    ) -> Generator[StageExecutionGuard, None, None]:
        """Acquire the sole pre-side-effect capability for forward execution."""

        require_public_id(operation_id, "stage operation ID")
        require_nonnegative_int(expected_generation, "expected operation generation")
        require_public_id(service_actor, "stage service actor")
        manager = self._lease_acquire_call(
            operation_id=operation_id,
            session_id=self._session_id,
            mode=LeaseMode.EXECUTION,
        )
        with manager as lease:
            lease = self._validate_lease(
                lease, operation_id, LeaseMode.EXECUTION
            )
            self._execution_precheck(
                operation_id,
                expected_generation=expected_generation,
                service_actor=service_actor,
                allowed={
                    StageOperationState.PREPARED,
                    StageOperationState.TRANSACTION_OPEN,
                },
            )
            capability = object()
            self._activate_guard(
                capability, LeaseMode.EXECUTION, operation_id, lease
            )
            guard = StageExecutionGuard(
                _GUARD_TOKEN, self, capability, operation_id, service_actor
            )
            try:
                try:
                    yield guard
                except BaseException:
                    with suppress(BaseException):
                        self._require_recovery_under_lease(
                            operation_id, service_actor, lease
                        )
                    raise
                current = self.get(operation_id)
                if current.state in {
                    StageOperationState.PREPARED,
                    StageOperationState.TRANSACTION_OPEN_STARTED,
                    StageOperationState.TRANSACTION_OPEN,
                    StageOperationState.CANDIDATE_STAGE_STARTED,
                    StageOperationState.SIDE_EFFECT_UNCERTAIN,
                }:
                    try:
                        self._require_recovery_under_lease(
                            operation_id, service_actor, lease
                        )
                    except BaseException as exc:
                        raise StageOperationRecoveryRequired(
                            "execution ended in durable uncertain/recovery-only state"
                        ) from exc
                    raise StageOperationRecoveryRequired(
                        "execution guard ended before exact candidate staging completed"
                    )
            finally:
                self._deactivate_guard(capability)

    @contextmanager
    def recovery_guard(
        self,
        operation_id: str,
        *,
        expected_generation: int,
        service_actor: str,
    ) -> Generator[StageRecoveryGuard, None, None]:
        """Acquire rollback-only ownership after a crash or failed execution."""

        require_public_id(operation_id, "stage operation ID")
        require_nonnegative_int(expected_generation, "expected operation generation")
        require_public_id(service_actor, "stage service actor")
        manager = self._lease_acquire_call(
            operation_id=operation_id,
            session_id=self._session_id,
            mode=LeaseMode.RECOVERY,
        )
        with manager as lease:
            lease = self._validate_lease(lease, operation_id, LeaseMode.RECOVERY)
            operation = self.get(operation_id)
            self._require_actor(operation.binding, service_actor)
            if operation.generation != expected_generation:
                raise StageOperationConcurrencyConflict(
                    f"operation is generation {operation.generation}, not {expected_generation}"
                )
            if operation.state is StageOperationState.ROLLED_BACK:
                self._rollback_evidence(operation)
            else:
                evidence = self._recovery_evidence(operation)
                if operation.state is not StageOperationState.RECOVERY_REQUIRED:
                    self._validate_live_lease(lease)
                    operation = self._append_transition(
                        operation,
                        kind=StageOperationEventKind.RECOVERY_REQUIRED,
                        target=StageOperationState.RECOVERY_REQUIRED,
                        payload={"recovery_evidence": _attestation_payload(evidence)},
                    ).operation
            capability = object()
            self._activate_guard(
                capability, LeaseMode.RECOVERY, operation_id, lease
            )
            guard = StageRecoveryGuard(
                _GUARD_TOKEN, self, capability, operation_id, service_actor
            )
            try:
                yield guard
            finally:
                self._deactivate_guard(capability)

    def _execute_transaction_open(
        self,
        capability: object,
        operation_id: str,
        service_actor: str,
        side_effect: Callable[[StageOperationBinding], object],
    ) -> TransitionResult:
        lease = self._assert_guard(capability, LeaseMode.EXECUTION, operation_id)
        if not callable(side_effect):
            raise InvalidStageOperation("transaction side effect must be callable")
        operation = self.get(operation_id)
        self._require_actor(operation.binding, service_actor)
        if operation.state in {
            StageOperationState.TRANSACTION_OPEN,
            StageOperationState.CANDIDATE_STAGED,
        }:
            self._transaction_evidence(operation)
            return self._existing_transition(
                operation, StageOperationEventKind.TRANSACTION_OPENED
            )
        operation, live_verification, live_authority = self._execution_precheck(
            operation_id,
            expected_generation=operation.generation,
            service_actor=service_actor,
            allowed={StageOperationState.PREPARED},
        )
        preflight = self._transaction_preflight(operation)
        if preflight.disposition is TransactionDisposition.OPEN:
            evidence = self._transaction_evidence(operation)
            if (
                preflight.transaction_snapshot_sha256
                != evidence.transaction_snapshot_sha256
            ):
                raise StageOperationEvidenceMismatch(
                    "open transaction preflight/evidence snapshots differ"
                )
            self._validate_live_lease(lease)
            return self._append_transition(
                operation,
                kind=StageOperationEventKind.TRANSACTION_OPENED,
                target=StageOperationState.TRANSACTION_OPEN,
                payload={
                    "authorization_verification": _attestation_payload(
                        live_verification
                    ),
                    "live_authority": _attestation_payload(live_authority),
                    "transaction_preflight": _attestation_payload(preflight),
                    "transaction_evidence": _attestation_payload(evidence),
                },
            )
        if preflight.disposition is not TransactionDisposition.ABSENT:
            raise StageOperationRecoveryRequired(
                "transaction preflight is neither absent nor exact open"
            )
        started = self._append_transition(
            operation,
            kind=StageOperationEventKind.TRANSACTION_OPEN_STARTED,
            target=StageOperationState.TRANSACTION_OPEN_STARTED,
            payload={
                "phase": "transaction_open",
                "authorization_verification": _attestation_payload(
                    live_verification
                ),
                "live_authority": _attestation_payload(live_authority),
                "transaction_preflight": _attestation_payload(preflight),
                "lease_validation": _attestation_payload(
                    self._validate_live_lease(lease)
                ),
            },
        ).operation
        self._validate_live_lease(lease)
        try:
            side_effect(started.binding)
        except BaseException:
            # *_STARTED is already retry-blocking if uncertainty projection
            # itself is unavailable; preserve the callback's original abort.
            with suppress(BaseException):
                self._mark_uncertain_under_guard(
                    capability, operation_id, service_actor
                )
            raise
        self._validate_live_lease(lease)
        self._require_time_window(started, self._now(), forward=True)
        live_verification = self._verify_live(started)
        live_authority = self._live_authority(started)
        evidence = self._transaction_evidence(started)
        self._validate_live_lease(lease)
        return self._append_transition(
            started,
            kind=StageOperationEventKind.TRANSACTION_OPENED,
            target=StageOperationState.TRANSACTION_OPEN,
            payload={
                "authorization_verification": _attestation_payload(live_verification),
                "live_authority": _attestation_payload(live_authority),
                "transaction_preflight": _attestation_payload(preflight),
                "transaction_evidence": _attestation_payload(evidence),
            },
        )

    def _execute_candidate_stage(
        self,
        capability: object,
        operation_id: str,
        service_actor: str,
        side_effect: Callable[[StageOperationBinding, str], object],
    ) -> TransitionResult:
        lease = self._assert_guard(capability, LeaseMode.EXECUTION, operation_id)
        if not callable(side_effect):
            raise InvalidStageOperation("candidate side effect must be callable")
        operation = self.get(operation_id)
        self._require_actor(operation.binding, service_actor)
        if operation.state is StageOperationState.CANDIDATE_STAGED:
            self._candidate_evidence(operation)
            return self._existing_transition(
                operation, StageOperationEventKind.CANDIDATE_STAGED
            )
        operation, live_verification, live_authority = self._execution_precheck(
            operation_id,
            expected_generation=operation.generation,
            service_actor=service_actor,
            allowed={StageOperationState.TRANSACTION_OPEN},
        )
        self._transaction_evidence(operation)
        preflight = self._candidate_preflight(operation)
        if preflight.disposition is CandidateDisposition.STAGED:
            evidence = self._candidate_evidence(operation)
            if (
                preflight.candidate_last_event_sha256
                != evidence.staged_candidate_last_event_sha256
            ):
                raise StageOperationEvidenceMismatch(
                    "staged candidate preflight/evidence heads differ"
                )
            live_authority = self._live_authority(
                operation,
                expected_candidate_disposition=CandidateDisposition.STAGED,
                expected_candidate_generation=evidence.staged_candidate_generation,
                expected_candidate_last_event_sha256=(
                    evidence.staged_candidate_last_event_sha256
                ),
            )
            self._validate_live_lease(lease)
            return self._append_transition(
                operation,
                kind=StageOperationEventKind.CANDIDATE_STAGED,
                target=StageOperationState.CANDIDATE_STAGED,
                payload={
                    "authorization_verification": _attestation_payload(
                        live_verification
                    ),
                    "live_authority": _attestation_payload(live_authority),
                    "candidate_preflight": _attestation_payload(preflight),
                    "candidate_evidence": _attestation_payload(evidence),
                },
            )
        if preflight.disposition is not CandidateDisposition.RESOLVED:
            raise StageOperationRecoveryRequired(
                "candidate preflight is neither resolved nor exact staged successor"
            )
        started = self._append_transition(
            operation,
            kind=StageOperationEventKind.CANDIDATE_STAGE_STARTED,
            target=StageOperationState.CANDIDATE_STAGE_STARTED,
            payload={
                "phase": "candidate_stage",
                "authorization_verification": _attestation_payload(
                    live_verification
                ),
                "live_authority": _attestation_payload(live_authority),
                "candidate_preflight": _attestation_payload(preflight),
                "lease_validation": _attestation_payload(
                    self._validate_live_lease(lease)
                ),
            },
        ).operation
        self._validate_live_lease(lease)
        try:
            side_effect(
                started.binding,
                started.binding.candidate_stage_receipt_sha256,
            )
        except BaseException:
            with suppress(BaseException):
                self._mark_uncertain_under_guard(
                    capability, operation_id, service_actor
                )
            raise
        self._validate_live_lease(lease)
        self._require_time_window(started, self._now(), forward=True)
        live_verification = self._verify_live(started)
        evidence = self._candidate_evidence(started)
        live_authority = self._live_authority(
            started,
            expected_candidate_disposition=CandidateDisposition.STAGED,
            expected_candidate_generation=evidence.staged_candidate_generation,
            expected_candidate_last_event_sha256=(
                evidence.staged_candidate_last_event_sha256
            ),
        )
        now = self._now()
        self._require_time_window(started, now, forward=True)
        self._validate_live_lease(lease)
        return self._append_transition(
            started,
            kind=StageOperationEventKind.CANDIDATE_STAGED,
            target=StageOperationState.CANDIDATE_STAGED,
            payload={
                "authorization_verification": _attestation_payload(live_verification),
                "live_authority": _attestation_payload(live_authority),
                "candidate_preflight": _attestation_payload(preflight),
                "candidate_evidence": _attestation_payload(evidence),
            },
            occurred_at=now,
        )

    def _execute_rollback(
        self,
        capability: object,
        operation_id: str,
        service_actor: str,
        side_effect: Callable[[StageOperationBinding], object],
    ) -> TransitionResult:
        lease = self._assert_guard(capability, LeaseMode.RECOVERY, operation_id)
        if not callable(side_effect):
            raise InvalidStageOperation("rollback side effect must be callable")
        operation = self.get(operation_id)
        self._require_actor(operation.binding, service_actor)
        if operation.state is StageOperationState.ROLLED_BACK:
            self._rollback_evidence(operation)
            return self._existing_transition(
                operation, StageOperationEventKind.ROLLBACK_COMPLETED
            )
        if operation.state is not StageOperationState.RECOVERY_REQUIRED:
            raise IllegalStageOperationTransition(
                "rollback requires RECOVERY_REQUIRED under a recovery guard"
            )
        preflight = self._recovery_evidence(operation)
        rollback_already_complete = (
            preflight.transaction_disposition
            in {TransactionDisposition.ABSENT, TransactionDisposition.ROLLED_BACK}
            and preflight.candidate_disposition
            in {CandidateDisposition.RESOLVED, CandidateDisposition.INVALIDATED}
        )
        if rollback_already_complete:
            evidence = self._rollback_evidence(operation)
            self._validate_live_lease(lease)
            return self._append_transition(
                operation,
                kind=StageOperationEventKind.ROLLBACK_COMPLETED,
                target=StageOperationState.ROLLED_BACK,
                payload={
                    "rollback_preflight": _attestation_payload(preflight),
                    "rollback_evidence": _attestation_payload(evidence),
                },
            )
        started = self._append_transition(
            operation,
            kind=StageOperationEventKind.ROLLBACK_STARTED,
            target=StageOperationState.ROLLBACK_STARTED,
            payload={
                "phase": "rollback",
                "rollback_preflight": _attestation_payload(preflight),
                "lease_validation": _attestation_payload(
                    self._validate_live_lease(lease)
                ),
            },
        ).operation
        self._validate_live_lease(lease)
        try:
            side_effect(started.binding)
        except BaseException:
            with suppress(BaseException):
                self._mark_uncertain_under_guard(
                    capability, operation_id, service_actor
                )
            raise
        self._validate_live_lease(lease)
        evidence = self._rollback_evidence(started)
        self._validate_live_lease(lease)
        return self._append_transition(
            started,
            kind=StageOperationEventKind.ROLLBACK_COMPLETED,
            target=StageOperationState.ROLLED_BACK,
            payload={
                "rollback_preflight": _attestation_payload(preflight),
                "rollback_evidence": _attestation_payload(evidence),
            },
        )

    def _mark_uncertain_under_guard(
        self,
        capability: object,
        operation_id: str,
        service_actor: str,
    ) -> StageOperation:
        with self._lock:
            existing = self._active_guards.get(id(capability))
        if (
            existing is None
            or existing[0] is not capability
            or existing[2] != operation_id
        ):
            raise StageOperationRecoveryRequired("guard is no longer live")
        operation = self.get(operation_id)
        self._require_actor(operation.binding, service_actor)
        phase = {
            StageOperationState.TRANSACTION_OPEN_STARTED: "transaction_open",
            StageOperationState.CANDIDATE_STAGE_STARTED: "candidate_stage",
            StageOperationState.ROLLBACK_STARTED: "rollback",
        }.get(operation.state)
        if phase is None:
            return operation
        return self._append_transition(
            operation,
            kind=StageOperationEventKind.SIDE_EFFECT_UNCERTAIN,
            target=StageOperationState.SIDE_EFFECT_UNCERTAIN,
            payload={"phase": phase},
        ).operation

    def _require_recovery_under_lease(
        self,
        operation_id: str,
        service_actor: str,
        lease: ExecutionLease,
    ) -> StageOperation:
        self._validate_live_lease(lease)
        operation = self.get(operation_id)
        self._require_actor(operation.binding, service_actor)
        if operation.state in {
            StageOperationState.TRANSACTION_OPEN_STARTED,
            StageOperationState.CANDIDATE_STAGE_STARTED,
            StageOperationState.ROLLBACK_STARTED,
        }:
            phase = {
                StageOperationState.TRANSACTION_OPEN_STARTED: "transaction_open",
                StageOperationState.CANDIDATE_STAGE_STARTED: "candidate_stage",
                StageOperationState.ROLLBACK_STARTED: "rollback",
            }[operation.state]
            self._validate_live_lease(lease)
            operation = self._append_transition(
                operation,
                kind=StageOperationEventKind.SIDE_EFFECT_UNCERTAIN,
                target=StageOperationState.SIDE_EFFECT_UNCERTAIN,
                payload={"phase": phase},
            ).operation
        if operation.state in {
            StageOperationState.RECOVERY_REQUIRED,
            StageOperationState.ROLLED_BACK,
        }:
            return operation
        evidence = self._recovery_evidence(operation)
        self._validate_live_lease(lease)
        return self._append_transition(
            operation,
            kind=StageOperationEventKind.RECOVERY_REQUIRED,
            target=StageOperationState.RECOVERY_REQUIRED,
            payload={"recovery_evidence": _attestation_payload(evidence)},
        ).operation

    def _execution_precheck(
        self,
        operation_id: str,
        *,
        expected_generation: int | None,
        service_actor: str,
        allowed: set[StageOperationState],
    ) -> tuple[StageOperation, AuthorizationVerification, LiveAuthorityEvidence]:
        operation = self.get(operation_id)
        self._require_actor(operation.binding, service_actor)
        if expected_generation is not None and operation.generation != expected_generation:
            raise StageOperationConcurrencyConflict(
                f"operation is generation {operation.generation}, not {expected_generation}"
            )
        if operation.state not in allowed:
            raise IllegalStageOperationTransition(
                f"operation is {operation.state.value}, not executable"
            )
        if operation.recovery_only_in(self._session_id):
            raise StageOperationRecoveryRequired(
                "PREPARED/TRANSACTION_OPEN restored in another session is rollback-only"
            )
        self._require_time_window(operation, self._now(), forward=True)
        verification = self._verify_live(operation)
        authority = self._live_authority(operation)
        self._require_time_window(operation, self._now(), forward=True)
        return operation, verification, authority

    def _require_time_window(
        self, operation: StageOperation, now: datetime, *, forward: bool
    ) -> None:
        if now < operation.updated_at:
            raise InvalidStageOperation("journal clock moved backwards")
        if forward and now >= operation.binding.authorization_expires_at:
            raise StageOperationExpired("stage authorization expired before side effect")

    def _verify_and_consume(
        self, authorization: AuthorizedImportStagingInput, service_actor: str
    ) -> AuthorizationVerification:
        try:
            value = self._verify_and_consume_call(
                authorization, service_actor=service_actor
            )
        except Exception as exc:
            raise StageOperationEvidenceMismatch(
                "trusted approval verifier rejected authorization consumption"
            ) from exc
        value = _capture_trusted_output(
            AuthorizationVerification,
            value,
            "authorization consumption attestation",
        )
        if (
            value.verifier_id != self._authorization_verifier_id
            or value.verifier_incarnation
            != self._authorization_verifier_incarnation
            or value.authorization_id != authorization.authorization_id
            or value.authorization_digest != authorization.authorization_digest
            or value.authorization_issuer_seal != authorization.issuer_seal
            or value.service_actor != service_actor
            or value.service_principal_sha256
            != authorization.staging_service_principal_sha256
            or value.authority_snapshot_sha256
            != authorization.authority_snapshot_sha256
            or value.principal_authority_snapshot_sha256
            != authorization.principal_authority_snapshot_sha256
        ):
            raise StageOperationEvidenceMismatch(
                "approval verifier attestation does not bind the exact sealed authorization"
            )
        return value

    def _verify_live(self, operation: StageOperation) -> AuthorizationVerification:
        try:
            value = self._verify_live_call(operation.binding)
        except Exception as exc:
            raise StageOperationEvidenceMismatch(
                "authorization seal/consumption is no longer live"
            ) from exc
        value = _capture_trusted_output(
            AuthorizationVerification, value, "live authorization attestation"
        )
        observed_not_after = self._now()
        self._require_time_window(operation, observed_not_after, forward=True)
        self._validate_verification(
            operation.binding,
            value,
            not_before=operation.updated_at,
            not_after=observed_not_after,
            initial=False,
        )
        return value

    def _validate_verification(
        self,
        binding: StageOperationBinding,
        value: AuthorizationVerification,
        *,
        not_before: datetime,
        not_after: datetime,
        initial: bool,
    ) -> None:
        if type(value) is not AuthorizationVerification:
            raise StageOperationEvidenceMismatch(
                "authorization verifier returned invalid evidence"
            )
        if (
            value.verifier_id != binding.authorization_verifier_id
            or value.verifier_incarnation
            != binding.authorization_verifier_incarnation
            or value.authorization_id != binding.authorization_id
            or value.authorization_digest != binding.authorization_digest
            or value.authorization_issuer_seal != binding.authorization_issuer_seal
            or value.service_actor != binding.service_actor
            or value.service_principal_sha256
            != binding.staging_service_principal_sha256
            or value.authority_snapshot_sha256
            != binding.authority_snapshot_sha256
            or value.principal_authority_snapshot_sha256
            != binding.principal_authority_snapshot_sha256
            or value.consumption_fence_id
            != binding.authorization_consumption_fence_id
            or value.consumption_fence_sha256
            != binding.authorization_consumption_fence_sha256
            or (initial and value.attestation_sha256
                != binding.authorization_verification_sha256)
            or not (not_before <= value.observed_at <= not_after)
        ):
            raise StageOperationEvidenceMismatch(
                "authorization verification/fence is stale or rebound"
            )

    def _live_authority(
        self,
        operation: StageOperation,
        *,
        expected_candidate_disposition: CandidateDisposition = (
            CandidateDisposition.RESOLVED
        ),
        expected_candidate_generation: int | None = None,
        expected_candidate_last_event_sha256: str | None = None,
    ) -> LiveAuthorityEvidence:
        try:
            value = self._live_authority_call(operation.binding)
        except Exception as exc:
            raise StageOperationEvidenceMismatch(
                "trusted live-authority query failed"
            ) from exc
        value = _capture_trusted_output(
            LiveAuthorityEvidence, value, "live authority attestation"
        )
        observed_not_after = self._now()
        self._require_time_window(operation, observed_not_after, forward=True)
        self._validate_live_authority(
            operation.binding,
            value,
            not_before=operation.updated_at,
            not_after=observed_not_after,
            expected_candidate_disposition=expected_candidate_disposition,
            expected_candidate_generation=expected_candidate_generation,
            expected_candidate_last_event_sha256=(
                expected_candidate_last_event_sha256
            ),
        )
        return value

    def _validate_live_authority(
        self,
        binding: StageOperationBinding,
        value: LiveAuthorityEvidence,
        *,
        not_before: datetime,
        not_after: datetime,
        expected_candidate_disposition: CandidateDisposition = (
            CandidateDisposition.RESOLVED
        ),
        expected_candidate_generation: int | None = None,
        expected_candidate_last_event_sha256: str | None = None,
    ) -> None:
        candidate_generation = (
            binding.candidate_generation
            if expected_candidate_generation is None
            else expected_candidate_generation
        )
        candidate_last_event_sha256 = (
            binding.candidate_last_event_sha256
            if expected_candidate_last_event_sha256 is None
            else expected_candidate_last_event_sha256
        )
        expected = {
            "provider_id": binding.evidence_provider_id,
            "provider_incarnation": binding.evidence_provider_incarnation,
            "authorization_digest": binding.authorization_digest,
            "authority_snapshot_sha256": binding.authority_snapshot_sha256,
            "principal_authority_snapshot_sha256": (
                binding.principal_authority_snapshot_sha256
            ),
            "project_id": binding.project_id,
            "project_head": binding.expected_head,
            "project_event_head_sha256": binding.project_event_head_sha256,
            "run_id": binding.run_id,
            "run_revision": binding.run_revision,
            "run_incarnation": binding.run_incarnation,
            "run_event_head_sha256": binding.run_event_head_sha256,
            "coordination_context_digest": binding.coordination_context_digest,
            "coordination_incarnation": binding.coordination_incarnation,
            "coordination_event_head_sha256": binding.coordination_event_head_sha256,
            "target_store_id": binding.target_store_id,
            "target_store_incarnation": binding.target_store_incarnation,
            "candidate_id": binding.candidate_id,
            "candidate_sha256": binding.candidate_sha256,
            "candidate_generation": candidate_generation,
            "candidate_last_event_sha256": candidate_last_event_sha256,
            "candidate_disposition": expected_candidate_disposition,
            "mapping_evidence_id": binding.mapping_evidence_id,
            "mapping_evidence_sha256": binding.mapping_evidence_sha256,
            "mapping_evidence_generation": binding.mapping_evidence_generation,
            "mapping_evidence_last_event_sha256": (
                binding.mapping_evidence_last_event_sha256
            ),
            "mapping_active": True,
            "service_actor": binding.service_actor,
            "service_principal_sha256": binding.staging_service_principal_sha256,
        }
        if type(value) is not LiveAuthorityEvidence or any(
            getattr(value, key) != item for key, item in expected.items()
        ) or not (not_before <= value.observed_at <= not_after):
            raise StageOperationEvidenceMismatch(
                "live project/run/candidate/mapping/principal authority changed"
            )

    def _transaction_evidence(
        self, operation: StageOperation
    ) -> TransactionOpenEvidence:
        try:
            value = self._transaction_open_call(operation.binding)
        except Exception as exc:
            raise StageOperationEvidenceMismatch(
                "trusted provider found no exact open transaction"
            ) from exc
        value = _capture_trusted_output(
            TransactionOpenEvidence, value, "open transaction evidence"
        )
        binding = operation.binding
        if (
            type(value) is not TransactionOpenEvidence
            or value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.project_id != binding.project_id
            or value.project_head != binding.expected_head
            or value.target_store_id != binding.target_store_id
            or value.target_store_incarnation != binding.target_store_incarnation
            or value.transaction_id != binding.transaction_id
            or value.command_hashes != binding.command_hashes
            or value.commands_sha256 != binding.commands_sha256
            or value.prospective_graph_sha256 != binding.prospective_graph_sha256
            or value.preview_digest != binding.preview_digest
            or not (operation.updated_at <= value.observed_at <= self._now())
        ):
            raise StageOperationEvidenceMismatch(
                "open transaction evidence is stale or not exact"
            )
        recorded_event = next(
            (
                event
                for event in operation.events
                if event.kind is StageOperationEventKind.TRANSACTION_OPENED
            ),
            None,
        )
        if recorded_event is not None:
            recorded = _decode_attestation(
                TransactionOpenEvidence,
                recorded_event.payload.get("transaction_evidence"),
                "recorded open transaction evidence",
            )
            if _transaction_effect_identity(value) != _transaction_effect_identity(
                recorded
            ):
                raise StageOperationEvidenceMismatch(
                    "live transaction generation or snapshot changed after recording"
                )
        return value

    def _transaction_preflight(
        self, operation: StageOperation
    ) -> TransactionPreflightEvidence:
        try:
            value = self._transaction_preflight_call(operation.binding)
        except BaseException as exc:
            raise StageOperationEvidenceMismatch(
                "trusted provider could not preflight the exact transaction"
            ) from exc
        value = _capture_trusted_output(
            TransactionPreflightEvidence,
            value,
            "transaction preflight evidence",
        )
        binding = operation.binding
        if (
            value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.project_id != binding.project_id
            or value.project_head != binding.expected_head
            or value.target_store_id != binding.target_store_id
            or value.target_store_incarnation != binding.target_store_incarnation
            or value.transaction_id != binding.transaction_id
            or value.command_hashes != binding.command_hashes
            or value.commands_sha256 != binding.commands_sha256
            or value.prospective_graph_sha256 != binding.prospective_graph_sha256
            or value.preview_digest != binding.preview_digest
            or not (operation.updated_at <= value.observed_at <= self._now())
        ):
            raise StageOperationEvidenceMismatch(
                "transaction preflight is stale or not exact"
            )
        return value

    def _candidate_evidence(
        self,
        operation: StageOperation,
        *,
        observed_not_after: datetime | None = None,
    ) -> CandidateStagedEvidence:
        try:
            value = self._candidate_staged_call(operation.binding)
        except Exception as exc:
            raise StageOperationEvidenceMismatch(
                "trusted provider found no exact staged candidate"
            ) from exc
        value = _capture_trusted_output(
            CandidateStagedEvidence, value, "staged candidate evidence"
        )
        binding = operation.binding
        opened = next(
            (
                event
                for event in operation.events
                if event.kind is StageOperationEventKind.TRANSACTION_OPENED
            ),
            None,
        )
        if opened is None:
            raise StageOperationIntegrityError(
                "candidate outcome has no transaction-open event"
            )
        transaction = _decode_attestation(
            TransactionOpenEvidence,
            opened.payload["transaction_evidence"],
            "transaction evidence",
        )
        end = observed_not_after or self._now()
        if (
            type(value) is not CandidateStagedEvidence
            or value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.candidate_id != binding.candidate_id
            or value.prior_candidate_sha256 != binding.candidate_sha256
            or value.prior_candidate_generation != binding.candidate_generation
            or value.prior_candidate_last_event_sha256
            != binding.candidate_last_event_sha256
            or value.staged_candidate_generation != binding.candidate_generation + 1
            or value.candidate_stage_receipt_sha256
            != binding.candidate_stage_receipt_sha256
            or value.transaction_id != binding.transaction_id
            or value.transaction_snapshot_sha256
            != transaction.transaction_snapshot_sha256
            or not (operation.updated_at <= value.observed_at <= end)
        ):
            raise StageOperationEvidenceMismatch(
                "staged candidate evidence is stale or not the exact CAS successor"
            )
        recorded_event = next(
            (
                event
                for event in operation.events
                if event.kind is StageOperationEventKind.CANDIDATE_STAGED
            ),
            None,
        )
        if recorded_event is not None:
            recorded = _decode_attestation(
                CandidateStagedEvidence,
                recorded_event.payload.get("candidate_evidence"),
                "recorded staged candidate evidence",
            )
            if _candidate_effect_identity(value) != _candidate_effect_identity(recorded):
                raise StageOperationEvidenceMismatch(
                    "live staged candidate generation, event, or snapshot changed"
                )
        return value

    def _candidate_preflight(
        self, operation: StageOperation
    ) -> CandidatePreflightEvidence:
        try:
            value = self._candidate_preflight_call(operation.binding)
        except BaseException as exc:
            raise StageOperationEvidenceMismatch(
                "trusted provider could not preflight the exact candidate"
            ) from exc
        value = _capture_trusted_output(
            CandidatePreflightEvidence,
            value,
            "candidate preflight evidence",
        )
        binding = operation.binding
        opened = next(
            (
                event
                for event in operation.events
                if event.kind is StageOperationEventKind.TRANSACTION_OPENED
            ),
            None,
        )
        if opened is None:
            raise StageOperationIntegrityError(
                "candidate preflight has no transaction-open event"
            )
        transaction = _decode_attestation(
            TransactionOpenEvidence,
            opened.payload["transaction_evidence"],
            "transaction evidence",
        )
        resolved = value.disposition is CandidateDisposition.RESOLVED
        staged = value.disposition is CandidateDisposition.STAGED
        exact_version = (
            resolved
            and value.candidate_generation == binding.candidate_generation
            and value.candidate_last_event_sha256
            == binding.candidate_last_event_sha256
            and value.stage_receipt_sha256 is None
        ) or (
            staged
            and value.candidate_generation == binding.candidate_generation + 1
            and value.stage_receipt_sha256
            == binding.candidate_stage_receipt_sha256
        )
        if (
            value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.candidate_id != binding.candidate_id
            or value.candidate_sha256 != binding.candidate_sha256
            or value.transaction_id != binding.transaction_id
            or value.transaction_snapshot_sha256
            != transaction.transaction_snapshot_sha256
            or not exact_version
            or not (operation.updated_at <= value.observed_at <= self._now())
        ):
            raise StageOperationEvidenceMismatch(
                "candidate preflight is stale or not the exact source/successor"
            )
        return value

    def _recovery_evidence(self, operation: StageOperation) -> RecoveryEvidence:
        try:
            value = self._recovery_state_call(
                operation.binding, journal_state=operation.state
            )
        except Exception as exc:
            raise StageOperationEvidenceMismatch(
                "trusted provider could not establish external recovery state"
            ) from exc
        value = _capture_trusted_output(
            RecoveryEvidence, value, "recovery-state evidence"
        )
        if (
            type(value) is not RecoveryEvidence
            or value.provider_id != operation.binding.evidence_provider_id
            or value.provider_incarnation
            != operation.binding.evidence_provider_incarnation
            or value.operation_id != operation.binding.operation_id
            or value.authorization_digest != operation.binding.authorization_digest
            or not (operation.updated_at <= value.observed_at <= self._now())
        ):
            raise StageOperationEvidenceMismatch(
                "recovery evidence is stale or target-rebound"
            )
        return value

    def _rollback_evidence(self, operation: StageOperation) -> RollbackEvidence:
        try:
            value = self._rollback_complete_call(operation.binding)
        except Exception as exc:
            raise StageOperationEvidenceMismatch(
                "trusted provider did not verify rollback/absence"
            ) from exc
        value = _capture_trusted_output(
            RollbackEvidence, value, "rollback-completion evidence"
        )
        if (
            type(value) is not RollbackEvidence
            or value.provider_id != operation.binding.evidence_provider_id
            or value.provider_incarnation
            != operation.binding.evidence_provider_incarnation
            or value.operation_id != operation.binding.operation_id
            or value.authorization_digest != operation.binding.authorization_digest
            or not (operation.updated_at <= value.observed_at <= self._now())
        ):
            raise StageOperationEvidenceMismatch(
                "rollback evidence is stale or target-rebound"
            )
        return value

    def _append_transition(
        self,
        operation: StageOperation,
        *,
        kind: StageOperationEventKind,
        target: StageOperationState,
        payload: dict[str, object],
        occurred_at: datetime | None = None,
    ) -> TransitionResult:
        with self._transaction(write=True):
            self._verify_journal_head_locked()
            current = self._load_operation_locked(operation.binding.operation_id)
            if current.generation != operation.generation:
                raise StageOperationConcurrencyConflict(
                    "operation changed before trusted evidence could be recorded"
                )
            if (current.state, target) not in _LEGAL_TRANSITIONS:
                raise IllegalStageOperationTransition(
                    f"cannot move {current.state.value} to {target.value}"
                )
            now = occurred_at or self._now()
            if now < current.updated_at:
                raise InvalidStageOperation("journal clock moved backwards")
            if target in {
                StageOperationState.TRANSACTION_OPEN_STARTED,
                StageOperationState.TRANSACTION_OPEN,
                StageOperationState.CANDIDATE_STAGE_STARTED,
                StageOperationState.CANDIDATE_STAGED,
            } and now >= current.binding.authorization_expires_at:
                raise StageOperationExpired("authorization expired before transition")
            event = self._make_event(
                operation_id=current.binding.operation_id,
                sequence=current.generation + 1,
                kind=kind,
                from_state=current.state,
                to_state=target,
                actor=current.binding.service_actor,
                occurred_at=now,
                payload=payload,
                previous_event_sha256=current.last_event_sha256,
            )
            self._validate_event_payload(
                current.binding,
                event,
                previous=current,
                integrity=False,
            )
            head = self._head_row_locked()
            catalog = self._prospective_catalog_digest_locked(
                {
                    "operation_id": current.binding.operation_id,
                    "identity_sha256": _domain_hash(
                        _IDENTITY_DOMAIN, _binding_payload(current.binding)
                    ),
                    "generation": event.sequence,
                    "last_event_sha256": event.event_sha256,
                    "state": target.value,
                }
            )
            anchor = self._advance_anchor(
                current,
                event,
                journal_generation=int(head["generation"]) + 1,
                journal_catalog_sha256=catalog,
            )
            self._insert_event_locked(event)
            cursor = self._connection.execute(
                """UPDATE import_stage_operations
                   SET state=?, generation=?, last_event_sha256=?, updated_at=?,
                       anchor_attestation_sha256=?
                   WHERE operation_id=? AND generation=? AND last_event_sha256=?""",
                (
                    target.value,
                    event.sequence,
                    event.event_sha256,
                    time_text(now),
                    anchor.attestation_sha256,
                    current.binding.operation_id,
                    current.generation,
                    current.last_event_sha256,
                ),
            )
            if cursor.rowcount != 1:
                raise StageOperationConcurrencyConflict(
                    "operation CAS lost while recording trusted evidence"
                )
            self._advance_head_row_locked(anchor)
            updated = self._load_operation_locked(current.binding.operation_id)
            return TransitionResult(updated, event, idempotent_retry=False)

    def _existing_transition(
        self, operation: StageOperation, kind: StageOperationEventKind
    ) -> TransitionResult:
        event = next((item for item in operation.events if item.kind is kind), None)
        if event is None:
            raise StageOperationIntegrityError("idempotent transition event is missing")
        return TransitionResult(operation, event, idempotent_retry=True)

    def _make_event(
        self,
        *,
        operation_id: str,
        sequence: int,
        kind: StageOperationEventKind,
        from_state: StageOperationState | None,
        to_state: StageOperationState,
        actor: str,
        occurred_at: datetime,
        payload: dict[str, object],
        previous_event_sha256: str,
    ) -> StageOperationEvent:
        transition_id = _transition_id_for(
            operation_id=operation_id,
            sequence=sequence,
            kind=kind,
            from_state=from_state,
            to_state=to_state,
            previous_event_sha256=previous_event_sha256,
        )
        payload_sha256 = _domain_hash(_PAYLOAD_DOMAIN, payload)
        request_sha256 = _request_digest(
            operation_id=operation_id,
            expected_generation=sequence - 1,
            transition_id=transition_id,
            kind=kind,
            from_state=from_state,
            to_state=to_state,
            actor=actor,
            payload_sha256=payload_sha256,
        )
        material = {
            "operation_id": operation_id,
            "sequence": sequence,
            "transition_id": transition_id,
            "kind": kind.value,
            "from_state": from_state.value if from_state is not None else None,
            "to_state": to_state.value,
            "actor": actor,
            "occurred_at": time_text(occurred_at),
            "request_sha256": request_sha256,
            "payload_sha256": payload_sha256,
            "previous_event_sha256": previous_event_sha256,
        }
        return StageOperationEvent(
            operation_id=operation_id,
            sequence=sequence,
            transition_id=transition_id,
            kind=kind,
            from_state=from_state,
            to_state=to_state,
            actor=actor,
            occurred_at=occurred_at,
            request_sha256=request_sha256,
            payload_sha256=payload_sha256,
            previous_event_sha256=previous_event_sha256,
            event_sha256=_event_digest(material),
            payload=MappingProxyType(dict(payload)),
        )

    def _insert_event_locked(self, event: StageOperationEvent) -> None:
        self._connection.execute(
            """INSERT INTO import_stage_operation_events(
                operation_id,sequence,transition_id,kind,from_state,to_state,
                actor,occurred_at,request_sha256,payload_json,payload_sha256,
                previous_event_sha256,event_sha256
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                event.operation_id,
                event.sequence,
                event.transition_id,
                event.kind.value,
                event.from_state.value if event.from_state is not None else None,
                event.to_state.value,
                event.actor,
                time_text(event.occurred_at),
                event.request_sha256,
                _canonical_json(dict(event.payload)),
                event.payload_sha256,
                event.previous_event_sha256,
                event.event_sha256,
            ),
        )

    def _decode_event_row(self, row: sqlite3.Row) -> StageOperationEvent:
        payload = _load_canonical_json(row["payload_json"], "event payload")
        if type(payload) is not dict:
            raise StageOperationIntegrityError("event payload must be an object")
        payload = cast(dict[str, object], payload)
        try:
            kind = StageOperationEventKind(row["kind"])
            from_state = (
                StageOperationState(row["from_state"])
                if row["from_state"] is not None
                else None
            )
            to_state = StageOperationState(row["to_state"])
            occurred_at = _decode_time(row["occurred_at"], "event time")
            sequence = require_nonnegative_int(row["sequence"], "event sequence")
            require_public_id(row["operation_id"], "event operation ID")
            require_public_id(row["transition_id"], "event transition ID")
            require_public_id(row["actor"], "event actor")
            for name in (
                "request_sha256",
                "payload_sha256",
                "previous_event_sha256",
                "event_sha256",
            ):
                require_sha256(row[name], f"event {name}")
        except (InvalidStageOperation, ValueError) as exc:
            raise StageOperationIntegrityError("persisted event is malformed") from exc
        if _domain_hash(_PAYLOAD_DOMAIN, payload) != row["payload_sha256"]:
            raise StageOperationIntegrityError("event payload digest mismatch")
        request = _request_digest(
            operation_id=row["operation_id"],
            expected_generation=sequence - 1,
            transition_id=row["transition_id"],
            kind=kind,
            from_state=from_state,
            to_state=to_state,
            actor=row["actor"],
            payload_sha256=row["payload_sha256"],
        )
        material = {
            "operation_id": row["operation_id"],
            "sequence": sequence,
            "transition_id": row["transition_id"],
            "kind": kind.value,
            "from_state": from_state.value if from_state is not None else None,
            "to_state": to_state.value,
            "actor": row["actor"],
            "occurred_at": time_text(occurred_at),
            "request_sha256": row["request_sha256"],
            "payload_sha256": row["payload_sha256"],
            "previous_event_sha256": row["previous_event_sha256"],
        }
        if request != row["request_sha256"] or _event_digest(material) != row["event_sha256"]:
            raise StageOperationIntegrityError("event request/hash chain digest mismatch")
        return StageOperationEvent(
            operation_id=row["operation_id"],
            sequence=sequence,
            transition_id=row["transition_id"],
            kind=kind,
            from_state=from_state,
            to_state=to_state,
            actor=row["actor"],
            occurred_at=occurred_at,
            request_sha256=row["request_sha256"],
            payload_sha256=row["payload_sha256"],
            previous_event_sha256=row["previous_event_sha256"],
            event_sha256=row["event_sha256"],
            payload=MappingProxyType(payload),
        )

    def _load_operation_locked(self, operation_id: str) -> StageOperation:
        row = self._connection.execute(
            "SELECT * FROM import_stage_operations WHERE operation_id=?",
            (operation_id,),
        ).fetchone()
        if row is None:
            raise StageOperationNotFound(f"stage operation {operation_id} not found")
        return self._load_operation_row_locked(row)

    def _load_operation_row_locked(
        self, row: sqlite3.Row, *, verify_anchor: bool = True
    ) -> StageOperation:
        identity = _load_canonical_json(row["identity_json"], "operation identity")
        if _domain_hash(_IDENTITY_DOMAIN, identity) != row["identity_sha256"]:
            raise StageOperationIntegrityError("operation identity digest mismatch")
        binding = _binding_from_payload(identity)
        checks = {
            "operation_id": binding.operation_id,
            "authorization_id": binding.authorization_id,
            "authorization_digest": binding.authorization_digest,
            "project_id": binding.project_id,
            "target_store_id": binding.target_store_id,
            "target_store_incarnation": binding.target_store_incarnation,
            "transaction_id": binding.transaction_id,
            "candidate_id": binding.candidate_id,
            "candidate_generation": binding.candidate_generation,
            "candidate_last_event_sha256": binding.candidate_last_event_sha256,
            "mapping_evidence_id": binding.mapping_evidence_id,
            "mapping_evidence_generation": binding.mapping_evidence_generation,
            "mapping_evidence_last_event_sha256": (
                binding.mapping_evidence_last_event_sha256
            ),
            "owner_session_id": binding.owner_session_id,
            "prepared_at": time_text(binding.prepared_at),
        }
        if any(row[name] != value for name, value in checks.items()):
            raise StageOperationIntegrityError("operation index/identity mismatch")
        try:
            state = StageOperationState(row["state"])
            generation = require_nonnegative_int(row["generation"], "operation generation")
            require_sha256(row["last_event_sha256"], "operation event head")
            require_sha256(row["anchor_attestation_sha256"], "operation anchor attestation")
            updated_at = _decode_time(row["updated_at"], "operation update time")
        except (InvalidStageOperation, ValueError) as exc:
            raise StageOperationIntegrityError("operation state index is malformed") from exc
        event_rows = self._connection.execute(
            "SELECT * FROM import_stage_operation_events WHERE operation_id=? ORDER BY sequence",
            (binding.operation_id,),
        ).fetchall()
        events = tuple(self._decode_event_row(item) for item in event_rows)
        self._verify_event_history(binding, events)
        if not events:
            raise StageOperationIntegrityError("operation has no PREPARED event")
        last = events[-1]
        if (
            generation != len(events) - 1
            or generation != last.sequence
            or state is not last.to_state
            or row["last_event_sha256"] != last.event_sha256
            or updated_at != last.occurred_at
        ):
            raise StageOperationIntegrityError("operation event head/index mismatch")
        head = self._head_row_locked()
        operation = StageOperation(
            binding=binding,
            state=state,
            generation=generation,
            last_event_sha256=last.event_sha256,
            updated_at=updated_at,
            events=events,
            journal_generation=int(head["generation"]),
            journal_catalog_sha256=str(head["catalog_sha256"]),
            journal_anchor_attestation_sha256=str(head["anchor_attestation_sha256"]),
        )
        if verify_anchor:
            self._verify_operation_anchor(
                operation,
                row["identity_sha256"],
                row["anchor_attestation_sha256"],
            )
        return operation

    def _verify_event_history(
        self, binding: StageOperationBinding, events: tuple[StageOperationEvent, ...]
    ) -> None:
        previous_state: StageOperationState | None = None
        previous_digest = _ZERO_DIGEST
        previous_time = binding.prepared_at
        prior_events: list[StageOperationEvent] = []
        for index, event in enumerate(events):
            _require_transition_identity(event, prior_events)
            if (
                event.operation_id != binding.operation_id
                or event.sequence != index
                or event.previous_event_sha256 != previous_digest
                or event.from_state is not previous_state
                or event.actor != binding.service_actor
                or event.to_state is not _KIND_TARGET[event.kind]
                or (index > 0 and (previous_state, event.to_state) not in _LEGAL_TRANSITIONS)
                or event.occurred_at < previous_time
            ):
                raise StageOperationIntegrityError("operation event chain is inconsistent")
            if index == 0 and (
                event.kind is not StageOperationEventKind.PREPARED
                or event.occurred_at != binding.prepared_at
            ):
                raise StageOperationIntegrityError("first event is not exact PREPARED")
            if index > 0 and event.kind in {
                StageOperationEventKind.TRANSACTION_OPEN_STARTED,
                StageOperationEventKind.TRANSACTION_OPENED,
                StageOperationEventKind.CANDIDATE_STAGE_STARTED,
                StageOperationEventKind.CANDIDATE_STAGED,
            } and event.occurred_at >= binding.authorization_expires_at:
                raise StageOperationIntegrityError("forward event occurred after expiry")
            previous = None
            if index > 0:
                previous = StageOperation(
                    binding=binding,
                    state=previous_state,  # type: ignore[arg-type]
                    generation=index - 1,
                    last_event_sha256=previous_digest,
                    updated_at=previous_time,
                    events=tuple(prior_events),
                    journal_generation=0,
                    journal_catalog_sha256=_ZERO_DIGEST,
                    journal_anchor_attestation_sha256=_ZERO_DIGEST,
                )
            self._validate_event_payload(binding, event, previous=previous, integrity=True)
            prior_events.append(event)
            previous_state = event.to_state
            previous_digest = event.event_sha256
            previous_time = event.occurred_at

    def _validate_event_payload(
        self,
        binding: StageOperationBinding,
        event: StageOperationEvent,
        *,
        previous: StageOperation | None,
        integrity: bool,
    ) -> None:
        try:
            if event.kind is StageOperationEventKind.PREPARED:
                if set(event.payload) != {
                    "authorization_digest",
                    "identity_sha256",
                    "authorization_verification",
                }:
                    raise StageOperationIntegrityError("PREPARED evidence fields changed")
                verification = _decode_attestation(
                    AuthorizationVerification,
                    event.payload["authorization_verification"],
                    "authorization verification",
                )
                if (
                    event.payload["authorization_digest"] != binding.authorization_digest
                    or event.payload["identity_sha256"]
                    != _domain_hash(_IDENTITY_DOMAIN, _binding_payload(binding))
                ):
                    raise StageOperationEvidenceMismatch("PREPARED binding changed")
                self._validate_verification(
                    binding,
                    verification,
                    not_before=binding.authorization_issued_at,
                    not_after=event.occurred_at,
                    initial=True,
                )
                return
            assert previous is not None
            if event.kind is StageOperationEventKind.TRANSACTION_OPEN_STARTED:
                expected = {
                    "phase",
                    "authorization_verification",
                    "live_authority",
                    "transaction_preflight",
                    "lease_validation",
                }
                if set(event.payload) != expected or event.payload["phase"] != "transaction_open":
                    raise StageOperationIntegrityError(
                        "transaction-start evidence fields changed"
                    )
                verification = _decode_attestation(
                    AuthorizationVerification,
                    event.payload["authorization_verification"],
                    "live authorization verification",
                )
                authority = _decode_attestation(
                    LiveAuthorityEvidence,
                    event.payload["live_authority"],
                    "live authority evidence",
                )
                preflight = _decode_attestation(
                    TransactionPreflightEvidence,
                    event.payload["transaction_preflight"],
                    "transaction preflight evidence",
                )
                lease = _decode_attestation(
                    ExecutionLeaseValidation,
                    event.payload["lease_validation"],
                    "lease validation",
                )
                self._validate_verification(
                    binding,
                    verification,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                    initial=False,
                )
                self._validate_live_authority(
                    binding,
                    authority,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                )
                self._validate_transaction_preflight_fields(
                    binding,
                    preflight,
                    event,
                    expected_disposition=TransactionDisposition.ABSENT,
                )
                self._validate_lease_fields(
                    binding, lease, event, LeaseMode.EXECUTION
                )
                return
            if event.kind is StageOperationEventKind.TRANSACTION_OPENED:
                expected = {
                    "authorization_verification",
                    "live_authority",
                    "transaction_preflight",
                    "transaction_evidence",
                }
                if set(event.payload) != expected:
                    raise StageOperationIntegrityError("transaction evidence fields changed")
                verification = _decode_attestation(
                    AuthorizationVerification,
                    event.payload["authorization_verification"],
                    "live authorization verification",
                )
                authority = _decode_attestation(
                    LiveAuthorityEvidence,
                    event.payload["live_authority"],
                    "live authority evidence",
                )
                transaction = _decode_attestation(
                    TransactionOpenEvidence,
                    event.payload["transaction_evidence"],
                    "transaction evidence",
                )
                preflight = _decode_attestation(
                    TransactionPreflightEvidence,
                    event.payload["transaction_preflight"],
                    "transaction preflight evidence",
                )
                self._validate_verification(
                    binding,
                    verification,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                    initial=False,
                )
                self._validate_live_authority(
                    binding,
                    authority,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                )
                self._validate_transaction_fields(binding, transaction, previous, event)
                expected_preflight = (
                    TransactionDisposition.ABSENT
                    if previous.state
                    is StageOperationState.TRANSACTION_OPEN_STARTED
                    else TransactionDisposition.OPEN
                )
                self._validate_transaction_preflight_fields(
                    binding,
                    preflight,
                    event,
                    expected_disposition=expected_preflight,
                )
                if (
                    expected_preflight is TransactionDisposition.OPEN
                    and preflight.transaction_snapshot_sha256
                    != transaction.transaction_snapshot_sha256
                ):
                    raise StageOperationEvidenceMismatch(
                        "open transaction preflight/evidence snapshots differ"
                    )
                return
            if event.kind is StageOperationEventKind.CANDIDATE_STAGE_STARTED:
                expected = {
                    "phase",
                    "authorization_verification",
                    "live_authority",
                    "candidate_preflight",
                    "lease_validation",
                }
                if set(event.payload) != expected or event.payload["phase"] != "candidate_stage":
                    raise StageOperationIntegrityError(
                        "candidate-start evidence fields changed"
                    )
                verification = _decode_attestation(
                    AuthorizationVerification,
                    event.payload["authorization_verification"],
                    "live authorization verification",
                )
                authority = _decode_attestation(
                    LiveAuthorityEvidence,
                    event.payload["live_authority"],
                    "live authority evidence",
                )
                preflight = _decode_attestation(
                    CandidatePreflightEvidence,
                    event.payload["candidate_preflight"],
                    "candidate preflight evidence",
                )
                lease = _decode_attestation(
                    ExecutionLeaseValidation,
                    event.payload["lease_validation"],
                    "lease validation",
                )
                self._validate_verification(
                    binding,
                    verification,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                    initial=False,
                )
                self._validate_live_authority(
                    binding,
                    authority,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                )
                self._validate_candidate_preflight_fields(
                    binding,
                    preflight,
                    previous,
                    event,
                    expected_disposition=CandidateDisposition.RESOLVED,
                )
                self._validate_lease_fields(
                    binding, lease, event, LeaseMode.EXECUTION
                )
                return
            if event.kind is StageOperationEventKind.CANDIDATE_STAGED:
                expected = {
                    "authorization_verification",
                    "live_authority",
                    "candidate_preflight",
                    "candidate_evidence",
                }
                if set(event.payload) != expected:
                    raise StageOperationIntegrityError("candidate evidence fields changed")
                verification = _decode_attestation(
                    AuthorizationVerification,
                    event.payload["authorization_verification"],
                    "live authorization verification",
                )
                authority = _decode_attestation(
                    LiveAuthorityEvidence,
                    event.payload["live_authority"],
                    "live authority evidence",
                )
                candidate = _decode_attestation(
                    CandidateStagedEvidence,
                    event.payload["candidate_evidence"],
                    "candidate evidence",
                )
                preflight = _decode_attestation(
                    CandidatePreflightEvidence,
                    event.payload["candidate_preflight"],
                    "candidate preflight evidence",
                )
                self._validate_verification(
                    binding,
                    verification,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                    initial=False,
                )
                self._validate_live_authority(
                    binding,
                    authority,
                    not_before=previous.updated_at,
                    not_after=event.occurred_at,
                    expected_candidate_disposition=CandidateDisposition.STAGED,
                    expected_candidate_generation=(
                        candidate.staged_candidate_generation
                    ),
                    expected_candidate_last_event_sha256=(
                        candidate.staged_candidate_last_event_sha256
                    ),
                )
                self._validate_candidate_fields(binding, candidate, previous, event)
                expected_preflight = (
                    CandidateDisposition.RESOLVED
                    if previous.state
                    is StageOperationState.CANDIDATE_STAGE_STARTED
                    else CandidateDisposition.STAGED
                )
                self._validate_candidate_preflight_fields(
                    binding,
                    preflight,
                    previous,
                    event,
                    expected_disposition=expected_preflight,
                )
                if (
                    expected_preflight is CandidateDisposition.STAGED
                    and preflight.candidate_last_event_sha256
                    != candidate.staged_candidate_last_event_sha256
                ):
                    raise StageOperationEvidenceMismatch(
                        "staged candidate preflight/evidence heads differ"
                    )
                return
            if event.kind is StageOperationEventKind.SIDE_EFFECT_UNCERTAIN:
                phase = {
                    StageOperationState.TRANSACTION_OPEN_STARTED: "transaction_open",
                    StageOperationState.CANDIDATE_STAGE_STARTED: "candidate_stage",
                    StageOperationState.ROLLBACK_STARTED: "rollback",
                }.get(previous.state)
                if set(event.payload) != {"phase"} or event.payload["phase"] != phase:
                    raise StageOperationIntegrityError(
                        "uncertain side-effect phase is invalid"
                    )
                return
            if event.kind is StageOperationEventKind.RECOVERY_REQUIRED:
                if set(event.payload) != {"recovery_evidence"}:
                    raise StageOperationIntegrityError("recovery evidence fields changed")
                recovery = _decode_attestation(
                    RecoveryEvidence,
                    event.payload["recovery_evidence"],
                    "recovery evidence",
                )
                if (
                    recovery.provider_id != binding.evidence_provider_id
                    or recovery.provider_incarnation
                    != binding.evidence_provider_incarnation
                    or recovery.operation_id != binding.operation_id
                    or recovery.authorization_digest != binding.authorization_digest
                    or not (previous.updated_at <= recovery.observed_at <= event.occurred_at)
                ):
                    raise StageOperationEvidenceMismatch("recovery evidence is rebound")
                return
            if event.kind is StageOperationEventKind.ROLLBACK_STARTED:
                expected = {"phase", "rollback_preflight", "lease_validation"}
                if set(event.payload) != expected or event.payload["phase"] != "rollback":
                    raise StageOperationIntegrityError(
                        "rollback-start evidence fields changed"
                    )
                recovery = _decode_attestation(
                    RecoveryEvidence,
                    event.payload["rollback_preflight"],
                    "rollback preflight evidence",
                )
                lease = _decode_attestation(
                    ExecutionLeaseValidation,
                    event.payload["lease_validation"],
                    "lease validation",
                )
                self._validate_recovery_fields(
                    binding, recovery, previous, event
                )
                self._validate_lease_fields(
                    binding, lease, event, LeaseMode.RECOVERY
                )
                return
            if event.kind is StageOperationEventKind.ROLLBACK_COMPLETED:
                if set(event.payload) != {
                    "rollback_preflight",
                    "rollback_evidence",
                }:
                    raise StageOperationIntegrityError("rollback evidence fields changed")
                preflight = _decode_attestation(
                    RecoveryEvidence,
                    event.payload["rollback_preflight"],
                    "rollback preflight evidence",
                )
                rollback = _decode_attestation(
                    RollbackEvidence,
                    event.payload["rollback_evidence"],
                    "rollback evidence",
                )
                self._validate_recovery_fields(
                    binding, preflight, previous, event
                )
                if (
                    rollback.provider_id != binding.evidence_provider_id
                    or rollback.provider_incarnation
                    != binding.evidence_provider_incarnation
                    or rollback.operation_id != binding.operation_id
                    or rollback.authorization_digest != binding.authorization_digest
                    or not (previous.updated_at <= rollback.observed_at <= event.occurred_at)
                ):
                    raise StageOperationEvidenceMismatch("rollback evidence is rebound")
                return
            raise StageOperationIntegrityError("unknown stage event")
        except ImportStageJournalError:
            raise
        except Exception as exc:
            error = StageOperationIntegrityError if integrity else StageOperationEvidenceMismatch
            raise error("stage event trusted evidence is malformed") from exc

    def _validate_transaction_fields(
        self,
        binding: StageOperationBinding,
        value: TransactionOpenEvidence,
        previous: StageOperation,
        event: StageOperationEvent,
    ) -> None:
        if (
            value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.project_id != binding.project_id
            or value.project_head != binding.expected_head
            or value.target_store_id != binding.target_store_id
            or value.target_store_incarnation != binding.target_store_incarnation
            or value.transaction_id != binding.transaction_id
            or value.command_hashes != binding.command_hashes
            or value.commands_sha256 != binding.commands_sha256
            or value.prospective_graph_sha256 != binding.prospective_graph_sha256
            or value.preview_digest != binding.preview_digest
            or not (previous.updated_at <= value.observed_at <= event.occurred_at)
        ):
            raise StageOperationEvidenceMismatch("transaction evidence is rebound")

    def _validate_transaction_preflight_fields(
        self,
        binding: StageOperationBinding,
        value: TransactionPreflightEvidence,
        event: StageOperationEvent,
        *,
        expected_disposition: TransactionDisposition,
    ) -> None:
        if (
            type(value) is not TransactionPreflightEvidence
            or value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.project_id != binding.project_id
            or value.project_head != binding.expected_head
            or value.target_store_id != binding.target_store_id
            or value.target_store_incarnation != binding.target_store_incarnation
            or value.transaction_id != binding.transaction_id
            or value.disposition is not expected_disposition
            or value.command_hashes != binding.command_hashes
            or value.commands_sha256 != binding.commands_sha256
            or value.prospective_graph_sha256 != binding.prospective_graph_sha256
            or value.preview_digest != binding.preview_digest
            or not (
                binding.prepared_at <= value.observed_at <= event.occurred_at
            )
        ):
            raise StageOperationEvidenceMismatch(
                "transaction preflight evidence is rebound"
            )

    def _validate_candidate_fields(
        self,
        binding: StageOperationBinding,
        value: CandidateStagedEvidence,
        previous: StageOperation,
        event: StageOperationEvent,
    ) -> None:
        opened = next(
            item
            for item in previous.events
            if item.kind is StageOperationEventKind.TRANSACTION_OPENED
        )
        transaction = _decode_attestation(
            TransactionOpenEvidence,
            opened.payload["transaction_evidence"],
            "transaction evidence",
        )
        if (
            value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.candidate_id != binding.candidate_id
            or value.prior_candidate_sha256 != binding.candidate_sha256
            or value.prior_candidate_generation != binding.candidate_generation
            or value.prior_candidate_last_event_sha256
            != binding.candidate_last_event_sha256
            or value.staged_candidate_generation != binding.candidate_generation + 1
            or value.candidate_stage_receipt_sha256
            != binding.candidate_stage_receipt_sha256
            or value.transaction_id != binding.transaction_id
            or value.transaction_snapshot_sha256
            != transaction.transaction_snapshot_sha256
            or not (previous.updated_at <= value.observed_at <= event.occurred_at)
        ):
            raise StageOperationEvidenceMismatch("candidate evidence is rebound")

    def _validate_candidate_preflight_fields(
        self,
        binding: StageOperationBinding,
        value: CandidatePreflightEvidence,
        previous: StageOperation,
        event: StageOperationEvent,
        *,
        expected_disposition: CandidateDisposition,
    ) -> None:
        opened = next(
            item
            for item in previous.events
            if item.kind is StageOperationEventKind.TRANSACTION_OPENED
        )
        transaction = _decode_attestation(
            TransactionOpenEvidence,
            opened.payload["transaction_evidence"],
            "transaction evidence",
        )
        expected_generation = binding.candidate_generation
        expected_last_event = binding.candidate_last_event_sha256
        expected_receipt = None
        if expected_disposition is CandidateDisposition.STAGED:
            expected_generation += 1
            expected_last_event = value.candidate_last_event_sha256
            expected_receipt = binding.candidate_stage_receipt_sha256
        if (
            type(value) is not CandidatePreflightEvidence
            or value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.authorization_digest != binding.authorization_digest
            or value.candidate_id != binding.candidate_id
            or value.candidate_sha256 != binding.candidate_sha256
            or value.candidate_generation != expected_generation
            or value.candidate_last_event_sha256 != expected_last_event
            or value.disposition is not expected_disposition
            or value.stage_receipt_sha256 != expected_receipt
            or value.transaction_id != binding.transaction_id
            or value.transaction_snapshot_sha256
            != transaction.transaction_snapshot_sha256
            or not (
                binding.prepared_at <= value.observed_at <= event.occurred_at
            )
        ):
            raise StageOperationEvidenceMismatch(
                "candidate preflight evidence is rebound"
            )

    def _validate_recovery_fields(
        self,
        binding: StageOperationBinding,
        value: RecoveryEvidence,
        previous: StageOperation,
        event: StageOperationEvent,
    ) -> None:
        if (
            type(value) is not RecoveryEvidence
            or value.provider_id != binding.evidence_provider_id
            or value.provider_incarnation != binding.evidence_provider_incarnation
            or value.operation_id != binding.operation_id
            or value.authorization_digest != binding.authorization_digest
            or not (
                binding.prepared_at <= value.observed_at <= event.occurred_at
            )
        ):
            raise StageOperationEvidenceMismatch("recovery evidence is rebound")

    def _validate_lease_fields(
        self,
        binding: StageOperationBinding,
        value: ExecutionLeaseValidation,
        event: StageOperationEvent,
        mode: LeaseMode,
    ) -> None:
        if (
            type(value) is not ExecutionLeaseValidation
            or value.coordinator_id != binding.execution_coordinator_id
            or value.coordinator_incarnation
            != binding.execution_coordinator_incarnation
            or value.operation_id != binding.operation_id
            or value.mode is not mode
            or (
                mode is LeaseMode.EXECUTION
                and value.session_id != binding.owner_session_id
            )
            or not (
                binding.prepared_at <= value.observed_at <= event.occurred_at
            )
        ):
            raise StageOperationEvidenceMismatch(
                "lease validation evidence is rebound"
            )

    def _head_row_locked(self) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM import_stage_journal_head WHERE singleton=1"
        ).fetchone()
        if row is None:
            raise StageOperationIntegrityError("journal catalog head is missing")
        return row

    def _catalog_entries_locked(self) -> list[dict[str, object]]:
        return [
            {
                "operation_id": row["operation_id"],
                "identity_sha256": row["identity_sha256"],
                "generation": row["generation"],
                "last_event_sha256": row["last_event_sha256"],
                "state": row["state"],
            }
            for row in self._connection.execute(
                "SELECT operation_id,identity_sha256,generation,last_event_sha256,state "
                "FROM import_stage_operations ORDER BY operation_id"
            )
        ]

    def _prospective_catalog_digest_locked(
        self, changed: dict[str, object]
    ) -> str:
        entries = {
            str(item["operation_id"]): item for item in self._catalog_entries_locked()
        }
        entries[str(changed["operation_id"])] = changed
        return _catalog_digest(
            self._journal_key, self._journal_incarnation, list(entries.values())
        )

    def _recover_anchor_projection_locked(self) -> None:
        """Project one fully anchored successor after an interrupted SQLite commit."""

        head = self._head_row_locked()
        if (
            head["journal_key"] != self._journal_key
            or head["journal_incarnation"] != self._journal_incarnation
        ):
            raise StageOperationIntegrityError("journal catalog identity changed")
        local_generation = require_nonnegative_int(
            head["generation"], "journal generation"
        )
        local_catalog = require_sha256(
            head["catalog_sha256"], "journal catalog digest"
        )
        actual_catalog = _catalog_digest(
            self._journal_key,
            self._journal_incarnation,
            self._catalog_entries_locked(),
        )
        if local_catalog != actual_catalog:
            raise StageOperationIntegrityError(
                "cannot recover an already-tampered SQLite projection"
            )
        external = self._current_journal_anchor()
        if external is None or external.journal_generation == local_generation:
            return
        if external.journal_generation != local_generation + 1:
            raise StageOperationIntegrityError(
                "external anchor is not one exact recoverable successor"
            )
        envelope = _load_canonical_json(
            external.transition_envelope_json,
            "anchored transition envelope",
        )
        expected_fields = {
            "version",
            "kind",
            "journal_key",
            "journal_incarnation",
            "expected_journal_generation",
            "expected_journal_catalog_sha256",
            "journal_generation",
            "journal_catalog_sha256",
            "operation_id",
            "identity_json",
            "identity_sha256",
            "expected_operation_generation",
            "expected_operation_event_head_sha256",
            "expected_operation_state",
            "result_operation_generation",
            "result_operation_event_head_sha256",
            "result_operation_state",
            "event",
        }
        if type(envelope) is not dict:
            raise StageOperationIntegrityError(
                "anchored transition envelope fields are not exact"
            )
        envelope = cast(dict[str, object], envelope)
        if set(envelope) != expected_fields:
            raise StageOperationIntegrityError(
                "anchored transition envelope fields are not exact"
            )
        exact_strings = (
            "kind",
            "journal_key",
            "journal_incarnation",
            "expected_journal_catalog_sha256",
            "journal_catalog_sha256",
            "operation_id",
            "identity_json",
            "identity_sha256",
            "expected_operation_event_head_sha256",
            "result_operation_event_head_sha256",
            "result_operation_state",
        )
        exact_integers = (
            "version",
            "expected_journal_generation",
            "journal_generation",
            "result_operation_generation",
        )
        if (
            any(type(envelope[name]) is not str for name in exact_strings)
            or any(type(envelope[name]) is not int for name in exact_integers)
            or (
                envelope["expected_operation_generation"] is not None
                and type(envelope["expected_operation_generation"]) is not int
            )
            or (
                envelope["expected_operation_state"] is not None
                and type(envelope["expected_operation_state"]) is not str
            )
            or type(envelope["event"]) is not dict
        ):
            raise StageOperationIntegrityError(
                "anchored transition envelope uses non-exact builtin field types"
            )
        if (
            envelope["version"] != 1
            or envelope["kind"] not in {"claim", "advance"}
            or envelope["journal_key"] != self._journal_key
            or envelope["journal_incarnation"] != self._journal_incarnation
            or envelope["expected_journal_generation"] != local_generation
            or envelope["expected_journal_catalog_sha256"] != local_catalog
            or envelope["journal_generation"] != external.journal_generation
            or envelope["journal_catalog_sha256"]
            != external.journal_catalog_sha256
            or envelope["operation_id"] != external.operation_id
            or envelope["identity_sha256"] != external.identity_sha256
            or envelope["result_operation_generation"] != external.generation
            or envelope["result_operation_event_head_sha256"]
            != external.journal_event_head_sha256
        ):
            raise StageOperationIntegrityError(
                "anchored transition envelope is rebound or contradictory"
            )
        identity_json = envelope["identity_json"]
        identity = _load_canonical_json(identity_json, "anchored operation identity")
        if _domain_hash(_IDENTITY_DOMAIN, identity) != envelope["identity_sha256"]:
            raise StageOperationIntegrityError(
                "anchored operation identity digest is inconsistent"
            )
        binding = _binding_from_payload(identity)
        if (
            binding.operation_id != envelope["operation_id"]
            or binding.journal_key != self._journal_key
            or binding.journal_incarnation != self._journal_incarnation
            or binding.authorization_verifier_id != self._authorization_verifier_id
            or binding.authorization_verifier_incarnation
            != self._authorization_verifier_incarnation
            or binding.evidence_provider_id != self._evidence_provider_id
            or binding.evidence_provider_incarnation
            != self._evidence_provider_incarnation
            or binding.execution_coordinator_id != self._execution_coordinator_id
            or binding.execution_coordinator_incarnation
            != self._execution_coordinator_incarnation
            or binding.monotonic_anchor_id != self._monotonic_anchor_id
            or binding.monotonic_anchor_incarnation
            != self._monotonic_anchor_incarnation
        ):
            raise StageOperationIntegrityError(
                "anchored transition binding does not match configured trust adapters"
            )
        event = _event_from_envelope(
            cast(dict[str, object], envelope["event"])
        )
        if (
            event.operation_id != binding.operation_id
            or event.sequence != envelope["result_operation_generation"]
            or event.event_sha256
            != envelope["result_operation_event_head_sha256"]
            or event.to_state.value != envelope["result_operation_state"]
        ):
            raise StageOperationIntegrityError(
                "anchored transition event/result is inconsistent"
            )
        row = self._connection.execute(
            "SELECT * FROM import_stage_operations WHERE operation_id=?",
            (binding.operation_id,),
        ).fetchone()
        if envelope["kind"] == "claim":
            if (
                row is not None
                or envelope["expected_operation_generation"] is not None
                or envelope["expected_operation_state"] is not None
                or envelope["expected_operation_event_head_sha256"] != _ZERO_DIGEST
                or event.kind is not StageOperationEventKind.PREPARED
                or event.sequence != 0
            ):
                raise StageOperationIntegrityError(
                    "anchored claim does not apply to an absent operation"
                )
            _require_transition_identity(event, ())
            self._validate_event_payload(
                binding, event, previous=None, integrity=True
            )
        else:
            if row is None:
                raise StageOperationIntegrityError(
                    "anchored advance references a missing operation"
                )
            operation = self._load_operation_row_locked(row, verify_anchor=False)
            if (
                row["identity_json"] != identity_json
                or operation.generation != envelope["expected_operation_generation"]
                or operation.last_event_sha256
                != envelope["expected_operation_event_head_sha256"]
                or operation.state.value != envelope["expected_operation_state"]
                or event.sequence != operation.generation + 1
                or event.from_state is not operation.state
                or (operation.state, event.to_state) not in _LEGAL_TRANSITIONS
            ):
                raise StageOperationIntegrityError(
                    "anchored advance is not the exact SQLite successor"
                )
            _require_transition_identity(event, operation.events)
            self._validate_event_payload(
                binding, event, previous=operation, integrity=True
            )
        prospective_catalog = self._prospective_catalog_digest_locked(
            {
                "operation_id": binding.operation_id,
                "identity_sha256": envelope["identity_sha256"],
                "generation": event.sequence,
                "last_event_sha256": event.event_sha256,
                "state": event.to_state.value,
            }
        )
        if prospective_catalog != external.journal_catalog_sha256:
            raise StageOperationIntegrityError(
                "anchored successor catalog is inconsistent"
            )
        self._validate_anchor_state(
            external,
            binding=binding,
            identity_sha256=cast(str, envelope["identity_sha256"]),
            generation=event.sequence,
            event_head=event.event_sha256,
            attestation_sha256=None,
            journal_generation=external.journal_generation,
            journal_catalog_sha256=external.journal_catalog_sha256,
            transition_envelope_json=external.transition_envelope_json,
            transition_envelope_sha256=external.transition_envelope_sha256,
        )
        if envelope["kind"] == "claim":
            self._connection.execute(
                """INSERT INTO import_stage_operations(
                    operation_id,authorization_id,authorization_digest,
                    project_id,target_store_id,target_store_incarnation,
                    transaction_id,candidate_id,candidate_generation,
                    candidate_last_event_sha256,mapping_evidence_id,
                    mapping_evidence_generation,mapping_evidence_last_event_sha256,
                    owner_session_id,prepared_at,identity_json,identity_sha256,
                    state,generation,last_event_sha256,updated_at,
                    anchor_attestation_sha256
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)""",
                (
                    binding.operation_id,
                    binding.authorization_id,
                    binding.authorization_digest,
                    binding.project_id,
                    binding.target_store_id,
                    binding.target_store_incarnation,
                    binding.transaction_id,
                    binding.candidate_id,
                    binding.candidate_generation,
                    binding.candidate_last_event_sha256,
                    binding.mapping_evidence_id,
                    binding.mapping_evidence_generation,
                    binding.mapping_evidence_last_event_sha256,
                    binding.owner_session_id,
                    time_text(binding.prepared_at),
                    identity_json,
                    envelope["identity_sha256"],
                    event.to_state.value,
                    event.event_sha256,
                    time_text(event.occurred_at),
                    external.attestation_sha256,
                ),
            )
            self._insert_event_locked(event)
        else:
            self._insert_event_locked(event)
            cursor = self._connection.execute(
                """UPDATE import_stage_operations
                   SET state=?,generation=?,last_event_sha256=?,updated_at=?,
                       anchor_attestation_sha256=?
                   WHERE operation_id=? AND generation=?
                     AND last_event_sha256=?""",
                (
                    event.to_state.value,
                    event.sequence,
                    event.event_sha256,
                    time_text(event.occurred_at),
                    external.attestation_sha256,
                    binding.operation_id,
                    envelope["expected_operation_generation"],
                    envelope["expected_operation_event_head_sha256"],
                ),
            )
            if cursor.rowcount != 1:
                raise StageOperationConcurrencyConflict(
                    "anchored SQLite projection CAS was lost"
                )
        self._advance_head_row_locked(external)

    def _verify_journal_head_locked(self) -> None:
        # Recheck the compiled schema inside the same SQLite transaction used
        # for every read/transition, not only at process startup.  A live
        # process must fail closed if another connection replaces a trigger,
        # index, table, or view after construction.
        self._verify_schema_locked()
        head = self._head_row_locked()
        if (
            head["journal_key"] != self._journal_key
            or head["journal_incarnation"] != self._journal_incarnation
        ):
            raise StageOperationIntegrityError("journal catalog identity changed")
        generation = require_nonnegative_int(head["generation"], "journal generation")
        require_sha256(head["catalog_sha256"], "journal catalog digest")
        require_sha256(head["anchor_attestation_sha256"], "journal anchor attestation")
        actual = _catalog_digest(
            self._journal_key,
            self._journal_incarnation,
            self._catalog_entries_locked(),
        )
        if actual != head["catalog_sha256"]:
            raise StageOperationIntegrityError("journal catalog digest mismatch")
        external = self._current_journal_anchor()
        if generation == 0:
            if (
                self._catalog_entries_locked()
                or head["anchor_attestation_sha256"] != _ZERO_DIGEST
                or external is not None
            ):
                raise StageOperationIntegrityError(
                    "unanchored journal contains state or an external prior incarnation"
                )
            return
        if external is None:
            raise StageOperationIntegrityError("external journal anchor is missing")
        if (
            external.journal_key != self._journal_key
            or external.journal_incarnation != self._journal_incarnation
            or external.journal_generation != generation
            or external.journal_catalog_sha256 != actual
            or external.attestation_sha256 != head["anchor_attestation_sha256"]
        ):
            raise StageOperationIntegrityError(
                "SQLite journal is behind, ahead of, or rebound from its monotonic anchor"
            )

    def _verify_operation_anchor(
        self, operation: StageOperation, identity_sha256: str, attestation_sha256: str
    ) -> None:
        try:
            external = self._anchor_current_call(
                operation_id=operation.binding.operation_id
            )
        except Exception as exc:
            raise StageOperationIntegrityError(
                "external operation anchor is missing/unavailable"
            ) from exc
        external = _capture_trusted_output(
            MonotonicAnchorState, external, "external operation anchor"
        )
        self._validate_anchor_state(
            external,
            binding=operation.binding,
            identity_sha256=identity_sha256,
            generation=operation.generation,
            event_head=operation.last_event_sha256,
            attestation_sha256=attestation_sha256,
            journal_generation=None,
            journal_catalog_sha256=None,
        )

    def _current_journal_anchor(self) -> MonotonicAnchorState | None:
        try:
            value = self._anchor_current_journal_call(
                journal_key=self._journal_key
            )
        except Exception as exc:
            raise StageJournalUnavailable(
                "external journal anchor lookup failed"
            ) from exc
        if value is not None:
            value = _capture_trusted_output(
                MonotonicAnchorState, value, "external journal anchor"
            )
        if value is not None and (
            value.anchor_id != self._monotonic_anchor_id
            or value.anchor_incarnation
            != self._monotonic_anchor_incarnation
        ):
            raise StageOperationIntegrityError(
                "external journal anchor returned malformed/rebound state"
            )
        return value

    def _claim_anchor(
        self,
        *,
        binding: StageOperationBinding,
        identity_sha256: str,
        event: StageOperationEvent,
        journal_generation: int,
        journal_catalog_sha256: str,
        expected_journal_catalog_sha256: str,
    ) -> MonotonicAnchorState:
        identity_json = _canonical_json(_binding_payload(binding))
        envelope_json, envelope_sha256 = _transition_envelope(
            kind="claim",
            journal_key=self._journal_key,
            journal_incarnation=self._journal_incarnation,
            expected_journal_generation=journal_generation - 1,
            expected_journal_catalog_sha256=expected_journal_catalog_sha256,
            journal_generation=journal_generation,
            journal_catalog_sha256=journal_catalog_sha256,
            binding=binding,
            identity_json=identity_json,
            identity_sha256=identity_sha256,
            expected_operation_generation=None,
            expected_operation_event_head_sha256=_ZERO_DIGEST,
            expected_operation_state=None,
            event=event,
        )
        try:
            value = self._anchor_claim_call(
                journal_key=self._journal_key,
                journal_incarnation=self._journal_incarnation,
                journal_generation=journal_generation,
                journal_catalog_sha256=journal_catalog_sha256,
                operation_id=binding.operation_id,
                authorization_id=binding.authorization_id,
                authorization_digest=binding.authorization_digest,
                identity_sha256=identity_sha256,
                generation=0,
                journal_event_head_sha256=event.event_sha256,
                transition_envelope_json=envelope_json,
                transition_envelope_sha256=envelope_sha256,
            )
        except Exception as exc:
            raise StageOperationReplayError(
                "external anchor rejected reused/rebound authorization or journal"
            ) from exc
        value = _capture_trusted_output(
            MonotonicAnchorState, value, "claimed monotonic anchor"
        )
        self._validate_anchor_state(
            value,
            binding=binding,
            identity_sha256=identity_sha256,
            generation=0,
            event_head=event.event_sha256,
            attestation_sha256=None,
            journal_generation=journal_generation,
            journal_catalog_sha256=journal_catalog_sha256,
            transition_envelope_json=envelope_json,
            transition_envelope_sha256=envelope_sha256,
        )
        return value

    def _advance_anchor(
        self,
        operation: StageOperation,
        event: StageOperationEvent,
        *,
        journal_generation: int,
        journal_catalog_sha256: str,
    ) -> MonotonicAnchorState:
        binding = operation.binding
        identity_sha256 = _domain_hash(_IDENTITY_DOMAIN, _binding_payload(binding))
        identity_json = _canonical_json(_binding_payload(binding))
        envelope_json, envelope_sha256 = _transition_envelope(
            kind="advance",
            journal_key=self._journal_key,
            journal_incarnation=self._journal_incarnation,
            expected_journal_generation=operation.journal_generation,
            expected_journal_catalog_sha256=operation.journal_catalog_sha256,
            journal_generation=journal_generation,
            journal_catalog_sha256=journal_catalog_sha256,
            binding=binding,
            identity_json=identity_json,
            identity_sha256=identity_sha256,
            expected_operation_generation=operation.generation,
            expected_operation_event_head_sha256=operation.last_event_sha256,
            expected_operation_state=operation.state,
            event=event,
        )
        try:
            value = self._anchor_advance_call(
                journal_key=self._journal_key,
                journal_incarnation=self._journal_incarnation,
                expected_journal_generation=operation.journal_generation,
                journal_generation=journal_generation,
                journal_catalog_sha256=journal_catalog_sha256,
                operation_id=binding.operation_id,
                authorization_id=binding.authorization_id,
                authorization_digest=binding.authorization_digest,
                identity_sha256=identity_sha256,
                expected_generation=operation.generation,
                generation=event.sequence,
                journal_event_head_sha256=event.event_sha256,
                transition_envelope_json=envelope_json,
                transition_envelope_sha256=envelope_sha256,
            )
        except Exception as exc:
            raise StageOperationConcurrencyConflict(
                "external monotonic anchor CAS rejected transition"
            ) from exc
        value = _capture_trusted_output(
            MonotonicAnchorState, value, "advanced monotonic anchor"
        )
        self._validate_anchor_state(
            value,
            binding=binding,
            identity_sha256=identity_sha256,
            generation=event.sequence,
            event_head=event.event_sha256,
            attestation_sha256=None,
            journal_generation=journal_generation,
            journal_catalog_sha256=journal_catalog_sha256,
            transition_envelope_json=envelope_json,
            transition_envelope_sha256=envelope_sha256,
        )
        return value

    def _validate_anchor_state(
        self,
        value: MonotonicAnchorState,
        *,
        binding: StageOperationBinding,
        identity_sha256: str,
        generation: int,
        event_head: str,
        attestation_sha256: str | None,
        journal_generation: int | None,
        journal_catalog_sha256: str | None,
        transition_envelope_json: str | None = None,
        transition_envelope_sha256: str | None = None,
    ) -> None:
        if (
            type(value) is not MonotonicAnchorState
            or value.anchor_id != binding.monotonic_anchor_id
            or value.anchor_incarnation != binding.monotonic_anchor_incarnation
            or value.journal_key != binding.journal_key
            or value.journal_incarnation != binding.journal_incarnation
            or value.operation_id != binding.operation_id
            or value.authorization_id != binding.authorization_id
            or value.authorization_digest != binding.authorization_digest
            or value.identity_sha256 != identity_sha256
            or value.generation != generation
            or value.journal_event_head_sha256 != event_head
            or (attestation_sha256 is not None
                and value.attestation_sha256 != attestation_sha256)
            or (journal_generation is not None
                and value.journal_generation != journal_generation)
            or (journal_catalog_sha256 is not None
                and value.journal_catalog_sha256 != journal_catalog_sha256)
            or (
                transition_envelope_json is not None
                and value.transition_envelope_json != transition_envelope_json
            )
            or (
                transition_envelope_sha256 is not None
                and value.transition_envelope_sha256
                != transition_envelope_sha256
            )
        ):
            raise StageOperationIntegrityError(
                "external anchor state does not exactly bind this journal operation"
            )

    def _advance_head_row_locked(self, anchor: MonotonicAnchorState) -> None:
        cursor = self._connection.execute(
            """UPDATE import_stage_journal_head
               SET generation=?, catalog_sha256=?, anchor_attestation_sha256=?
               WHERE singleton=1 AND generation=?""",
            (
                anchor.journal_generation,
                anchor.journal_catalog_sha256,
                anchor.attestation_sha256,
                anchor.journal_generation - 1,
            ),
        )
        if cursor.rowcount != 1:
            raise StageOperationConcurrencyConflict("journal catalog CAS was lost")

    def _verify_all_locked(self) -> None:
        self._verify_journal_head_locked()
        rows = self._connection.execute(
            "SELECT * FROM import_stage_operations ORDER BY operation_id"
        ).fetchall()
        for row in rows:
            self._load_operation_row_locked(row)
        orphan = int(
            self._connection.execute(
                """SELECT COUNT(*) FROM import_stage_operation_events e
                   LEFT JOIN import_stage_operations o ON o.operation_id=e.operation_id
                   WHERE o.operation_id IS NULL"""
            ).fetchone()[0]
        )
        if orphan:
            raise StageOperationIntegrityError("journal contains orphan events")

    def _validate_lease(
        self, lease: ExecutionLease, operation_id: str, mode: LeaseMode
    ) -> ExecutionLease:
        lease = _capture_trusted_output(
            ExecutionLease, lease, "execution lease"
        )
        if (
            lease.coordinator_id != self._execution_coordinator_id
            or lease.coordinator_incarnation
            != self._execution_coordinator_incarnation
            or lease.operation_id != operation_id
            or lease.session_id != self._session_id
            or lease.mode is not mode
            or lease.acquired_at > self._now()
        ):
            raise StageOperationEvidenceMismatch(
                "execution coordinator returned a rebound/invalid lease"
            )
        self._validate_live_lease(lease)
        return lease

    def _validate_live_lease(
        self, lease: ExecutionLease
    ) -> ExecutionLeaseValidation:
        try:
            value = self._lease_validate_call(lease)
        except BaseException as exc:
            raise StageOperationEvidenceMismatch(
                "execution lease/fencing token is no longer live"
            ) from exc
        value = _capture_trusted_output(
            ExecutionLeaseValidation, value, "execution lease validation"
        )
        now = self._now()
        if (
            value.coordinator_id != lease.coordinator_id
            or value.coordinator_incarnation != lease.coordinator_incarnation
            or value.lease_id != lease.lease_id
            or value.operation_id != lease.operation_id
            or value.session_id != lease.session_id
            or value.mode is not lease.mode
            or value.fencing_token != lease.fencing_token
            or value.lease_attestation_sha256 != lease.attestation_sha256
            or not (lease.acquired_at <= value.observed_at <= now)
        ):
            raise StageOperationEvidenceMismatch(
                "execution lease validation is stale or rebound"
            )
        return value

    def _activate_guard(
        self,
        capability: object,
        mode: LeaseMode,
        operation_id: str,
        lease: ExecutionLease,
    ) -> None:
        with self._lock:
            self._active_guards[id(capability)] = (
                capability,
                mode,
                operation_id,
                lease,
            )

    def _deactivate_guard(self, capability: object) -> None:
        with self._lock:
            self._active_guards.pop(id(capability), None)

    def _assert_guard(
        self, capability: object, mode: LeaseMode, operation_id: str
    ) -> ExecutionLease:
        with self._lock:
            existing = self._active_guards.get(id(capability))
        if (
            existing is None
            or existing[0] is not capability
            or existing[1] is not mode
            or existing[2] != operation_id
        ):
            raise StageOperationRecoveryRequired(
                "execution/recovery guard is no longer live"
            )
        self._validate_live_lease(existing[3])
        return existing[3]

    def _guard_operation(
        self, capability: object, mode: LeaseMode
    ) -> StageOperation:
        with self._lock:
            existing = self._active_guards.get(id(capability))
        if existing is None or existing[0] is not capability or existing[1] is not mode:
            raise StageOperationRecoveryRequired("guard is no longer live")
        self._validate_live_lease(existing[3])
        return self.get(existing[2])

    @staticmethod
    def _require_actor(binding: StageOperationBinding, service_actor: str) -> None:
        if service_actor != binding.service_actor:
            raise StageOperationEvidenceMismatch(
                "stage service actor does not match the sealed binding"
            )


__all__ = (
    "IMPORT_STAGE_JOURNAL_SCHEMA_VERSION",
    "SQLiteImportStageOperationJournal",
    "StageExecutionGuard",
    "StageRecoveryGuard",
)

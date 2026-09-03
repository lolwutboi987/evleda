# ruff: noqa: SIM117 - nested assertion/context scopes are security-test boundaries
from __future__ import annotations

import multiprocessing
import secrets
import shutil
import sqlite3
import unittest
from contextlib import closing, contextmanager, suppress
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from unittest.mock import patch

from backend.design_kernel import stable_hash
from backend.import_approval import (
    AuthorizedImportStagingInput,
    ImportApprovalScope,
    commands_sha256,
    import_preview_digest,
    prospective_revision_sha256,
)
from backend.import_approval.models import ApprovalSourceSnapshot
from backend.import_stage_journal import (
    AuthorizationVerification,
    CandidateDisposition,
    CandidatePreflightEvidence,
    CandidateStagedEvidence,
    ExecutionLease,
    ExecutionLeaseValidation,
    FileStageExecutionCoordinator,
    IllegalStageOperationTransition,
    LeaseMode,
    LiveAuthorityEvidence,
    MonotonicAnchorState,
    RecoveryCause,
    RecoveryEvidence,
    RollbackEvidence,
    SQLiteImportStageOperationJournal,
    StageOperationConcurrencyConflict,
    StageOperationEventKind,
    StageOperationEvidenceMismatch,
    StageOperationExpired,
    StageOperationIntegrityError,
    StageOperationRecoveryRequired,
    StageOperationState,
    TransactionDisposition,
    TransactionOpenEvidence,
    TransactionPreflightEvidence,
    VerifiedStageCapability,
)
from tests.import_stage_journal.test_repository import (
    PROJECT_ID,
    RUN_ID,
    RUN_REVISION,
    SERVICE,
    ApprovalFixture,
    MutableClock,
)


def _hold_real_file_lease(root: str, ready, stop, results) -> None:
    """Spawn target: hold a real OS lock until the parent terminates us."""

    try:
        coordinator = FileStageExecutionCoordinator(
            root, coordinator_id="stage-test-real-coordinator"
        )
        with coordinator.acquire(
            operation_id="stage-test-real-operation",
            session_id="stage-test-child-session",
            mode=LeaseMode.EXECUTION,
        ) as lease:
            results.put(
                ("ok", lease.fencing_token, coordinator.coordinator_incarnation)
            )
            ready.set()
            # A process crash/termination, not context cleanup, must release the
            # operating-system lock.
            while not stop.wait(1.0):
                pass
    except BaseException as exc:
        results.put(("error", repr(exc), ""))
        ready.set()


def make_authorization(fixture, clock):
    transaction = fixture.mapping.transaction_input
    assert transaction is not None
    command_hashes = tuple(command.command_hash for command in transaction.commands)
    commands_digest = commands_sha256(command_hashes)
    preview = import_preview_digest(
        base_revision=fixture.base_revision,
        transaction_id=transaction.transaction_id,
        prospective_graph_sha256=transaction.prospective_graph_sha256,
        command_hashes=command_hashes,
    )
    prospective = prospective_revision_sha256(
        project_id=PROJECT_ID,
        base_revision=fixture.base_revision,
        prospective_graph_sha256=transaction.prospective_graph_sha256,
        commands_digest=commands_digest,
        preview_digest=preview,
    )
    candidate_version = stable_hash(
        {
            "candidate_id": fixture.candidate.candidate_id,
            "candidate_sha256": fixture.candidate.candidate_digest,
            "generation": fixture.candidate.generation,
            "last_event_sha256": fixture.candidate.last_event_digest,
            "state": "resolved",
        },
        domain="flux-clone-import-approval-candidate-version-v1",
    )
    mapping_version = stable_hash(
        {
            "mapping_evidence_id": fixture.mapping_evidence.mapping_evidence_id,
            "mapping_evidence_sha256": (
                fixture.mapping_evidence.mapping_evidence_digest
            ),
            "generation": fixture.mapping_evidence.generation,
            "last_event_sha256": fixture.mapping_evidence.last_event_digest,
            "state": "active",
        },
        domain="flux-clone-import-approval-mapping-version-v1",
    )
    principal_authority_snapshot = stable_hash(
        (
            fixture.context.uploader_principal.principal_digest,
            fixture.context.authorized_human_principal.principal_digest,
            fixture.context.mapping_command_principal.principal_digest,
            fixture.context.staging_service_principal.principal_digest,
        ),
        domain="stage-test-principal-authority-snapshot-v1",
    )
    source_snapshot = ApprovalSourceSnapshot.create(
        candidate_id=fixture.candidate.candidate_id,
        candidate_version_sha256=candidate_version,
        mapping_evidence_id=fixture.mapping_evidence.mapping_evidence_id,
        mapping_version_sha256=mapping_version,
        authority_snapshot_sha256=fixture.context.authority_snapshot.snapshot_digest,
        principal_authority_snapshot_sha256=principal_authority_snapshot,
    )
    issued_at = clock()
    expires_at = issued_at + timedelta(minutes=10)
    material = {
        "issuer_id": "stage-test-sealed-issuer",
        "request_id": "stage-test-request",
        "request_digest": "d" * 64,
        "subject_digest": "e" * 64,
        "mapping_approval_id": "stage-test-mapping-approval",
        "mapping_approval_digest": "f" * 64,
        "candidate_id": fixture.candidate.candidate_id,
        "candidate_sha256": fixture.candidate.candidate_digest,
        "candidate_generation": fixture.candidate.generation,
        "candidate_last_event_sha256": fixture.candidate.last_event_digest,
        "mapping_evidence_id": fixture.mapping_evidence.mapping_evidence_id,
        "mapping_evidence_sha256": fixture.mapping_evidence.mapping_evidence_digest,
        "mapping_evidence_generation": fixture.mapping_evidence.generation,
        "mapping_evidence_last_event_sha256": fixture.mapping_evidence.last_event_digest,
        "canonical_candidate_sha256": transaction.candidate_sha256,
        "mapper_result_sha256": fixture.mapping_evidence.mapper_result_sha256,
        "source_snapshot_sha256": source_snapshot.snapshot_sha256,
        "project_id": PROJECT_ID,
        "base_revision": fixture.base_revision,
        "prospective_graph_sha256": transaction.prospective_graph_sha256,
        "prospective_revision_sha256": prospective,
        "transaction_id": transaction.transaction_id,
        "command_hashes": command_hashes,
        "commands_sha256": commands_digest,
        "preview_digest": preview,
        "review_manifest_sha256": "9" * 64,
        "operation_key": "stage-test-operation",
        "uploader_actor": fixture.context.uploader_principal.principal_id,
        "authorized_human_actor": fixture.context.authorized_human_actor,
        "mapping_command_actor": fixture.context.mapping_command_actor,
        "staging_service_actor": fixture.context.staging_service_actor,
        "uploader_principal_sha256": fixture.context.uploader_principal.principal_digest,
        "reviewer_principal_sha256": (
            fixture.context.authorized_human_principal.principal_digest
        ),
        "mapper_principal_sha256": (
            fixture.context.mapping_command_principal.principal_digest
        ),
        "staging_service_principal_sha256": (
            fixture.context.staging_service_principal.principal_digest
        ),
        "run_id": RUN_ID,
        "run_revision": RUN_REVISION,
        "project_event_head_sha256": fixture.context.project_event_head_sha256,
        "run_incarnation": fixture.context.run_incarnation,
        "run_event_head_sha256": fixture.context.run_event_head_sha256,
        "coordination_incarnation": fixture.context.coordination_incarnation,
        "coordination_context_digest": fixture.context.coordination_context_digest,
        "coordination_event_head_sha256": fixture.context.coordination_event_head_sha256,
        "target_store_id": fixture.context.target_store_id,
        "target_store_incarnation": fixture.context.target_store_incarnation,
        "authority_snapshot_sha256": fixture.context.authority_snapshot.snapshot_digest,
        "principal_authority_snapshot_sha256": principal_authority_snapshot,
        "issued_at": issued_at.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "expires_at": expires_at.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "lifecycle_generation": 2,
        "scope": ImportApprovalScope.MAPPING_TO_CANONICAL_STAGE.value,
        "authorizes_internal_commit": False,
        "authorizes_manufacturing_release": False,
        "commit_approval_id": None,
        "release_approval_id": None,
    }
    digest = stable_hash(
        material, domain="flux-clone-authorized-import-staging-input-v1"
    )
    return AuthorizedImportStagingInput(
        authorization_id=f"import-stage-authorization-{digest[:32]}",
        issuer_id=material["issuer_id"],
        request_id=material["request_id"],
        request_digest=material["request_digest"],
        subject_digest=material["subject_digest"],
        mapping_approval_id=material["mapping_approval_id"],
        mapping_approval_digest=material["mapping_approval_digest"],
        candidate_id=material["candidate_id"],
        candidate_sha256=material["candidate_sha256"],
        candidate_generation=material["candidate_generation"],
        candidate_last_event_sha256=material["candidate_last_event_sha256"],
        mapping_evidence_id=material["mapping_evidence_id"],
        mapping_evidence_sha256=material["mapping_evidence_sha256"],
        mapping_evidence_generation=material["mapping_evidence_generation"],
        mapping_evidence_last_event_sha256=(
            material["mapping_evidence_last_event_sha256"]
        ),
        canonical_candidate_sha256=material["canonical_candidate_sha256"],
        mapper_result_sha256=material["mapper_result_sha256"],
        source_snapshot_sha256=material["source_snapshot_sha256"],
        project_id=material["project_id"],
        base_revision=material["base_revision"],
        prospective_graph_sha256=material["prospective_graph_sha256"],
        prospective_revision_sha256=material["prospective_revision_sha256"],
        transaction_id=material["transaction_id"],
        command_hashes=command_hashes,
        commands_sha256=commands_digest,
        preview_digest=preview,
        review_manifest_sha256=material["review_manifest_sha256"],
        operation_key=material["operation_key"],
        uploader_actor=material["uploader_actor"],
        authorized_human_actor=material["authorized_human_actor"],
        mapping_command_actor=material["mapping_command_actor"],
        staging_service_actor=material["staging_service_actor"],
        uploader_principal_sha256=material["uploader_principal_sha256"],
        reviewer_principal_sha256=material["reviewer_principal_sha256"],
        mapper_principal_sha256=material["mapper_principal_sha256"],
        staging_service_principal_sha256=material["staging_service_principal_sha256"],
        run_id=RUN_ID,
        run_revision=RUN_REVISION,
        project_event_head_sha256=material["project_event_head_sha256"],
        run_incarnation=material["run_incarnation"],
        run_event_head_sha256=material["run_event_head_sha256"],
        coordination_incarnation=material["coordination_incarnation"],
        coordination_context_digest=material["coordination_context_digest"],
        coordination_event_head_sha256=material["coordination_event_head_sha256"],
        target_store_id=material["target_store_id"],
        target_store_incarnation=material["target_store_incarnation"],
        authority_snapshot_sha256=material["authority_snapshot_sha256"],
        principal_authority_snapshot_sha256=(
            material["principal_authority_snapshot_sha256"]
        ),
        issued_at=issued_at,
        expires_at=expires_at,
        lifecycle_generation=2,
        transaction_input=transaction,
        authorization_digest=digest,
        issuer_seal="0" * 64,
    )


class FakeAuthorizationVerifier:
    verifier_id = "stage-test-authorization-verifier"
    verifier_incarnation = "stage-test-verifier-incarnation"

    def __init__(self, authorization, consumed, clock) -> None:
        self.authorization = authorization
        self.consumed = consumed
        self.clock = clock
        self._initial = None

    def _authenticate(self, authorization, service_actor) -> None:
        if authorization != self.authorization or service_actor != SERVICE:
            raise ValueError("unknown, rebound, or forged authorization")

    def _attest(self, authorization):
        fence_id = f"approval-consumption-{authorization.authorization_digest[:32]}"
        fence_sha = stable_hash(
            {
                "authorization_id": authorization.authorization_id,
                "authorization_digest": authorization.authorization_digest,
                "service_actor": SERVICE,
            },
            domain="test-stage-approval-consumption-fence-v1",
        )
        prior = self.consumed.setdefault(
            authorization.authorization_digest, (fence_id, fence_sha)
        )
        if prior != (fence_id, fence_sha):
            raise ValueError("authorization consumption fence changed")
        return AuthorizationVerification.create(
            verifier_id=self.verifier_id,
            verifier_incarnation=self.verifier_incarnation,
            authorization_id=authorization.authorization_id,
            authorization_digest=authorization.authorization_digest,
            authorization_issuer_seal=authorization.issuer_seal,
            service_actor=SERVICE,
            service_principal_sha256=(
                authorization.staging_service_principal_sha256
            ),
            authority_snapshot_sha256=authorization.authority_snapshot_sha256,
            principal_authority_snapshot_sha256=(
                authorization.principal_authority_snapshot_sha256
            ),
            consumption_fence_id=fence_id,
            consumption_fence_sha256=fence_sha,
            observed_at=self.clock(),
        )

    def verify_and_consume(self, authorization, *, service_actor):
        self._authenticate(authorization, service_actor)
        if self._initial is None:
            self._initial = self._attest(authorization)
        return self._initial

    def verify_live(self, binding):
        if binding.authorization_digest != self.authorization.authorization_digest:
            raise ValueError("authorization binding changed")
        self._authenticate(self.authorization, binding.service_actor)
        return self._attest(self.authorization)


class FakeExternalStageStore:
    def __init__(self) -> None:
        self.transaction = TransactionDisposition.ABSENT
        self.candidate = CandidateDisposition.RESOLVED
        self.transaction_generation = 0
        self.transaction_snapshot = "a" * 64
        self.candidate_generation: int | None = None
        self.candidate_event = "b" * 64
        self.candidate_snapshot = "c" * 64
        self.candidate_transaction_snapshot = self.transaction_snapshot

    def open_transaction(self, binding) -> None:
        self.transaction = TransactionDisposition.OPEN

    def stage_candidate(self, binding, correlation_receipt) -> None:
        if self.transaction is not TransactionDisposition.OPEN:
            raise ValueError("transaction is not open")
        if correlation_receipt != binding.candidate_stage_receipt_sha256:
            raise ValueError("wrong candidate correlation receipt")
        self.candidate = CandidateDisposition.STAGED
        self.candidate_generation = binding.candidate_generation + 1
        self.candidate_transaction_snapshot = self.transaction_snapshot

    def rollback(self, binding) -> None:
        self.transaction = TransactionDisposition.ROLLED_BACK
        self.candidate = CandidateDisposition.INVALIDATED


class FakeEvidenceProvider:
    provider_id = "stage-test-evidence-provider"
    provider_incarnation = "stage-test-evidence-incarnation"

    def __init__(self, store, clock) -> None:
        self.store = store
        self.clock = clock
        self.rebind_project = False
        self.fail_recovery = False
        self.return_preflight_subclass = False

    def live_authority(self, binding):
        if self.store.candidate is CandidateDisposition.STAGED:
            candidate_generation = self.store.candidate_generation
            if candidate_generation is None:
                raise ValueError("staged candidate generation is unavailable")
            candidate_last_event = self.store.candidate_event
        else:
            candidate_generation = binding.candidate_generation
            candidate_last_event = binding.candidate_last_event_sha256
        return LiveAuthorityEvidence.create(
            provider_id=self.provider_id,
            provider_incarnation=self.provider_incarnation,
            authorization_digest=binding.authorization_digest,
            authority_snapshot_sha256=binding.authority_snapshot_sha256,
            principal_authority_snapshot_sha256=(
                binding.principal_authority_snapshot_sha256
            ),
            project_id=("attacker-project" if self.rebind_project else binding.project_id),
            project_head=binding.expected_head,
            project_event_head_sha256=binding.project_event_head_sha256,
            run_id=binding.run_id,
            run_revision=binding.run_revision,
            run_incarnation=binding.run_incarnation,
            run_event_head_sha256=binding.run_event_head_sha256,
            coordination_context_digest=binding.coordination_context_digest,
            coordination_incarnation=binding.coordination_incarnation,
            coordination_event_head_sha256=binding.coordination_event_head_sha256,
            target_store_id=binding.target_store_id,
            target_store_incarnation=binding.target_store_incarnation,
            candidate_id=binding.candidate_id,
            candidate_sha256=binding.candidate_sha256,
            candidate_generation=candidate_generation,
            candidate_last_event_sha256=candidate_last_event,
            candidate_disposition=self.store.candidate,
            mapping_evidence_id=binding.mapping_evidence_id,
            mapping_evidence_sha256=binding.mapping_evidence_sha256,
            mapping_evidence_generation=binding.mapping_evidence_generation,
            mapping_evidence_last_event_sha256=(
                binding.mapping_evidence_last_event_sha256
            ),
            mapping_active=True,
            service_actor=binding.service_actor,
            service_principal_sha256=binding.staging_service_principal_sha256,
            observed_at=self.clock(),
        )

    def transaction_open(self, binding):
        if self.store.transaction is not TransactionDisposition.OPEN:
            raise ValueError("transaction is absent")
        return TransactionOpenEvidence.create(
            provider_id=self.provider_id,
            provider_incarnation=self.provider_incarnation,
            authorization_digest=binding.authorization_digest,
            project_id=binding.project_id,
            project_head=binding.expected_head,
            target_store_id=binding.target_store_id,
            target_store_incarnation=binding.target_store_incarnation,
            transaction_id=binding.transaction_id,
            transaction_generation=self.store.transaction_generation,
            command_hashes=binding.command_hashes,
            commands_sha256=binding.commands_sha256,
            prospective_graph_sha256=binding.prospective_graph_sha256,
            preview_digest=binding.preview_digest,
            transaction_snapshot_sha256=self.store.transaction_snapshot,
            observed_at=self.clock(),
        )

    def transaction_preflight(self, binding):
        snapshot = (
            "0" * 64
            if self.store.transaction is TransactionDisposition.ABSENT
            else self.store.transaction_snapshot
        )
        evidence_type = (
            ForgedTransactionPreflightEvidence
            if self.return_preflight_subclass
            else TransactionPreflightEvidence
        )
        return evidence_type.create(
            provider_id=self.provider_id,
            provider_incarnation=self.provider_incarnation,
            authorization_digest=binding.authorization_digest,
            project_id=binding.project_id,
            project_head=binding.expected_head,
            target_store_id=binding.target_store_id,
            target_store_incarnation=binding.target_store_incarnation,
            transaction_id=binding.transaction_id,
            disposition=self.store.transaction,
            transaction_generation=self.store.transaction_generation,
            command_hashes=binding.command_hashes,
            commands_sha256=binding.commands_sha256,
            prospective_graph_sha256=binding.prospective_graph_sha256,
            preview_digest=binding.preview_digest,
            transaction_snapshot_sha256=snapshot,
            observed_at=self.clock(),
        )

    def candidate_staged(self, binding):
        if self.store.candidate is not CandidateDisposition.STAGED:
            raise ValueError("candidate is not staged")
        if self.store.candidate_generation is None:
            raise ValueError("staged candidate generation is unavailable")
        return CandidateStagedEvidence.create(
            provider_id=self.provider_id,
            provider_incarnation=self.provider_incarnation,
            authorization_digest=binding.authorization_digest,
            candidate_id=binding.candidate_id,
            prior_candidate_sha256=binding.candidate_sha256,
            prior_candidate_generation=binding.candidate_generation,
            prior_candidate_last_event_sha256=binding.candidate_last_event_sha256,
            staged_candidate_generation=self.store.candidate_generation,
            staged_candidate_last_event_sha256=self.store.candidate_event,
            staged_candidate_snapshot_sha256=self.store.candidate_snapshot,
            candidate_stage_receipt_sha256=binding.candidate_stage_receipt_sha256,
            transaction_id=binding.transaction_id,
            transaction_snapshot_sha256=(
                self.store.candidate_transaction_snapshot
            ),
            observed_at=self.clock(),
        )

    def candidate_preflight(self, binding):
        staged = self.store.candidate is CandidateDisposition.STAGED
        if staged and self.store.candidate_generation is None:
            raise ValueError("staged candidate generation is unavailable")
        return CandidatePreflightEvidence.create(
            provider_id=self.provider_id,
            provider_incarnation=self.provider_incarnation,
            authorization_digest=binding.authorization_digest,
            candidate_id=binding.candidate_id,
            candidate_sha256=binding.candidate_sha256,
            candidate_generation=(
                self.store.candidate_generation
                if staged
                else binding.candidate_generation
            ),
            candidate_last_event_sha256=(
                self.store.candidate_event
                if staged
                else binding.candidate_last_event_sha256
            ),
            disposition=self.store.candidate,
            stage_receipt_sha256=(
                binding.candidate_stage_receipt_sha256 if staged else None
            ),
            transaction_id=binding.transaction_id,
            transaction_snapshot_sha256=(
                self.store.candidate_transaction_snapshot
                if staged
                else self.store.transaction_snapshot
            ),
            observed_at=self.clock(),
        )

    def recovery_state(self, binding, *, journal_state):
        if self.fail_recovery:
            raise RuntimeError("recovery provider unavailable")
        return RecoveryEvidence.create(
            provider_id=self.provider_id,
            provider_incarnation=self.provider_incarnation,
            operation_id=binding.operation_id,
            authorization_digest=binding.authorization_digest,
            cause=RecoveryCause.PROCESS_RESTART,
            transaction_disposition=self.store.transaction,
            candidate_disposition=self.store.candidate,
            transaction_evidence_sha256=stable_hash(
                {"transaction": self.store.transaction.value},
                domain="test-recovery-transaction-v1",
            ),
            candidate_evidence_sha256=stable_hash(
                {"candidate": self.store.candidate.value},
                domain="test-recovery-candidate-v1",
            ),
            observed_at=self.clock(),
        )

    def rollback_complete(self, binding):
        return RollbackEvidence.create(
            provider_id=self.provider_id,
            provider_incarnation=self.provider_incarnation,
            operation_id=binding.operation_id,
            authorization_digest=binding.authorization_digest,
            transaction_disposition=self.store.transaction,
            candidate_disposition=self.store.candidate,
            transaction_rollback_receipt_sha256=stable_hash(
                {"transaction": self.store.transaction.value},
                domain="test-rollback-transaction-v1",
            ),
            candidate_rollback_receipt_sha256=stable_hash(
                {"candidate": self.store.candidate.value},
                domain="test-rollback-candidate-v1",
            ),
            observed_at=self.clock(),
        )


class ForgedTransactionPreflightEvidence(TransactionPreflightEvidence):
    pass


class ForgedExecutionLease(ExecutionLease):
    pass


class ForgedMonotonicAnchorState(MonotonicAnchorState):
    pass


class FakeCoordinator:
    coordinator_id = "stage-test-execution-coordinator"
    coordinator_incarnation = "stage-test-coordinator-incarnation"

    def __init__(self, clock) -> None:
        self.clock = clock
        self._catalog_lock = Lock()
        self._locks = {}
        self._fencing_tokens = {}
        self._active = {}
        self.return_lease_subclass = False

    @contextmanager
    def acquire(self, *, operation_id, session_id, mode):
        with self._catalog_lock:
            lock = self._locks.setdefault(operation_id, Lock())
        if not lock.acquire(blocking=False):
            raise RuntimeError("live owner holds the execution lease")
        try:
            with self._catalog_lock:
                token = self._fencing_tokens.get(operation_id, 0) + 1
                self._fencing_tokens[operation_id] = token
            lease_type = (
                ForgedExecutionLease
                if self.return_lease_subclass
                else ExecutionLease
            )
            lease = lease_type.create(
                coordinator_id=self.coordinator_id,
                coordinator_incarnation=self.coordinator_incarnation,
                lease_id=f"stage-lease-{secrets.token_hex(16)}",
                operation_id=operation_id,
                session_id=session_id,
                mode=mode,
                fencing_token=token,
                acquired_at=self.clock(),
            )
            self._active[lease.lease_id] = lease
            yield lease
        finally:
            if "lease" in locals():
                self._active.pop(lease.lease_id, None)
            lock.release()

    def validate(self, lease):
        current = self._active.get(lease.lease_id)
        if current != lease:
            raise RuntimeError("lease is not active")
        return ExecutionLeaseValidation.create(
            coordinator_id=self.coordinator_id,
            coordinator_incarnation=self.coordinator_incarnation,
            lease_id=lease.lease_id,
            operation_id=lease.operation_id,
            session_id=lease.session_id,
            mode=lease.mode,
            fencing_token=lease.fencing_token,
            lease_attestation_sha256=lease.attestation_sha256,
            observed_at=self.clock(),
        )


class FakeMonotonicAnchor:
    anchor_id = "stage-test-monotonic-anchor"
    anchor_incarnation = "stage-test-anchor-incarnation"

    def __init__(self, clock) -> None:
        self.clock = clock
        self.lock = Lock()
        self.operations = {}
        self.authorizations = {}
        self.journals = {}
        self.reject_next_advance = False
        self.return_state_subclass = False

    def _state(self, values):
        state_type = (
            ForgedMonotonicAnchorState
            if self.return_state_subclass
            else MonotonicAnchorState
        )
        return state_type.create(
            anchor_id=self.anchor_id,
            anchor_incarnation=self.anchor_incarnation,
            observed_at=self.clock(),
            **values,
        )

    def claim(self, **values):
        with self.lock:
            operation_id = values["operation_id"]
            existing = self.operations.get(operation_id)
            if existing is not None:
                if any(getattr(existing, key) != value for key, value in values.items()):
                    raise ValueError("operation claim was rebound")
                return existing
            authorization = values["authorization_digest"]
            if authorization in self.authorizations:
                raise ValueError("authorization already claimed")
            journal = self.journals.get(values["journal_key"])
            if journal is None:
                if values["journal_generation"] != 1:
                    raise ValueError("new journal did not begin at generation one")
            elif (
                journal.journal_incarnation != values["journal_incarnation"]
                or values["journal_generation"] != journal.journal_generation + 1
            ):
                raise ValueError("journal claim CAS failed")
            state = self._state(values)
            self.operations[operation_id] = state
            self.authorizations[authorization] = operation_id
            self.journals[values["journal_key"]] = state
            return state

    def advance(self, **values):
        with self.lock:
            if self.reject_next_advance:
                self.reject_next_advance = False
                raise RuntimeError("injected anchor CAS rejection")
            expected_generation = values.pop("expected_generation")
            expected_journal_generation = values.pop("expected_journal_generation")
            current = self.operations[values["operation_id"]]
            journal = self.journals[values["journal_key"]]
            if (
                current.generation != expected_generation
                or journal.journal_generation != expected_journal_generation
                or values["generation"] != current.generation + 1
                or values["journal_generation"] != journal.journal_generation + 1
                or current.authorization_digest != values["authorization_digest"]
                or current.identity_sha256 != values["identity_sha256"]
                or current.journal_incarnation != values["journal_incarnation"]
            ):
                raise ValueError("anchor CAS failed")
            state = self._state(values)
            self.operations[values["operation_id"]] = state
            self.journals[values["journal_key"]] = state
            return state

    def current(self, *, operation_id):
        with self.lock:
            return self.operations[operation_id]

    def current_journal(self, *, journal_key):
        with self.lock:
            return self.journals.get(journal_key)


class ImportStageJournalHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.temporary.name)
        self.clock = MutableClock()
        self.fixture = ApprovalFixture(self.root, self.clock)
        self.authorization = make_authorization(self.fixture, self.clock)
        self.database = self.root / "stage-journal.sqlite3"
        self.consumed = {}
        self.verifier = FakeAuthorizationVerifier(
            self.authorization, self.consumed, self.clock
        )
        self.store = FakeExternalStageStore()
        self.provider = FakeEvidenceProvider(self.store, self.clock)
        self.coordinator = FakeCoordinator(self.clock)
        self.anchor = FakeMonotonicAnchor(self.clock)
        self.journal = self._new_journal()

    def _new_journal(self):
        return SQLiteImportStageOperationJournal(
            self.database,
            authorization_verifier=self.verifier,
            evidence_provider=self.provider,
            execution_coordinator=self.coordinator,
            monotonic_anchor=self.anchor,
            receipt_mac_key=b"stage-test-receipt-mac-key-material-32-bytes",
            clock=self.clock,
        )

    def tearDown(self) -> None:
        with suppress(sqlite3.Error, StageOperationRecoveryRequired):
            self.journal.close()
        self.fixture.close()
        self.temporary.cleanup()

    def _prepare(self):
        return self.journal.prepare(
            self.authorization, service_actor=SERVICE
        ).operation

    def _stage_from(self, prepared):
        with self.journal.execution_guard(
            prepared.binding.operation_id,
            expected_generation=prepared.generation,
            service_actor=SERVICE,
        ) as guard:
            self.clock.value += timedelta(seconds=1)
            opened = guard.execute_transaction_open(self.store.open_transaction)
            retry = guard.execute_transaction_open(
                lambda _: self.fail("idempotent open reran callback")
            )
            self.assertTrue(retry.idempotent_retry)
            self.clock.value += timedelta(seconds=1)
            staged = guard.execute_candidate_stage(self.store.stage_candidate)
            retry = guard.execute_candidate_stage(
                lambda *_: self.fail("idempotent stage reran callback")
            )
            self.assertTrue(retry.idempotent_retry)
        return opened, staged

    def test_constructor_requires_every_external_trust_boundary(self) -> None:
        with self.assertRaises(TypeError):
            SQLiteImportStageOperationJournal(self.root / "unsafe.sqlite3")

    def test_real_coordinator_fences_processes_and_recovers_after_crash(self) -> None:
        context = multiprocessing.get_context("spawn")
        ready = context.Event()
        stop = context.Event()
        results = context.Queue()
        coordinator_root = self.root / "real-coordinator"
        process = context.Process(
            target=_hold_real_file_lease,
            args=(str(coordinator_root), ready, stop, results),
        )
        process.start()
        try:
            self.assertTrue(ready.wait(10), "child did not acquire a real lease")
            status, first_token, incarnation = results.get(timeout=5)
            self.assertEqual(status, "ok")
            parent = FileStageExecutionCoordinator(
                coordinator_root,
                coordinator_id="stage-test-real-coordinator",
            )
            self.assertEqual(parent.coordinator_incarnation, incarnation)
            with self.assertRaises(StageOperationRecoveryRequired), parent.acquire(
                operation_id="stage-test-real-operation",
                session_id="stage-test-parent-session",
                mode=LeaseMode.RECOVERY,
            ):
                self.fail("a live process must retain exclusive ownership")

            # Termination exercises kernel crash cleanup; the child never exits
            # its lease context or runs its finally block.
            process.terminate()
            process.join(10)
            self.assertFalse(process.is_alive())
            with parent.acquire(
                operation_id="stage-test-real-operation",
                session_id="stage-test-parent-session",
                mode=LeaseMode.RECOVERY,
            ) as recovered:
                self.assertGreater(recovered.fencing_token, first_token)
                validation = parent.validate(recovered)
                self.assertEqual(
                    validation.fencing_token, recovered.fencing_token
                )
        finally:
            if process.is_alive():
                process.terminate()
                process.join(10)
            results.close()

    def test_real_coordinator_fence_history_and_schema_fail_closed(self) -> None:
        coordinator_root = self.root / "tamper-coordinator"
        coordinator = FileStageExecutionCoordinator(
            coordinator_root,
            coordinator_id="stage-test-real-coordinator",
        )
        with coordinator.acquire(
            operation_id="stage-test-real-operation",
            session_id="stage-test-parent-session",
            mode=LeaseMode.EXECUTION,
        ):
            pass
        database = coordinator_root / "fencing.sqlite3"
        with closing(sqlite3.connect(database)) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE operation_fences SET fencing_token=0"
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM operation_fences")
            connection.execute("DROP TRIGGER operation_fences_monotonic")
            connection.execute(
                "CREATE TRIGGER operation_fences_monotonic "
                "BEFORE UPDATE ON operation_fences BEGIN SELECT 1; END"
            )
            connection.commit()
        with self.assertRaises(StageOperationIntegrityError):
            FileStageExecutionCoordinator(
                coordinator_root,
                coordinator_id="stage-test-real-coordinator",
            )

    def test_prepare_authenticates_seal_and_binds_trust_identities(self) -> None:
        operation = self._prepare()
        binding = operation.binding
        self.assertEqual(operation.state, StageOperationState.PREPARED)
        self.assertEqual(binding.authorization_verifier_id, self.verifier.verifier_id)
        self.assertEqual(binding.evidence_provider_id, self.provider.provider_id)
        self.assertEqual(binding.execution_coordinator_id, self.coordinator.coordinator_id)
        self.assertEqual(binding.monotonic_anchor_id, self.anchor.anchor_id)
        self.assertEqual(binding.journal_key, self.journal.journal_key)
        self.assertFalse(operation.grants_commit_authority)
        self.assertFalse(operation.grants_manufacturing_authority)
        forged = replace(self.authorization, issuer_seal="f" * 64)
        with self.assertRaises(StageOperationEvidenceMismatch):
            self.journal.prepare(forged, service_actor=SERVICE)

    def test_no_store_mutation_cannot_mint_syntactic_receipts(self) -> None:
        prepared = self._prepare()
        with self.assertRaises(StageOperationEvidenceMismatch):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_transaction_open(lambda _: None)
        recovered = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(recovered.state, StageOperationState.RECOVERY_REQUIRED)
        self.assertIsNone(recovered.completed_stage_receipt)

    def test_happy_path_is_callback_only_idempotent_and_externally_anchored(self) -> None:
        prepared = self._prepare()
        opened, staged = self._stage_from(prepared)
        self.assertEqual(opened.operation.state, StageOperationState.TRANSACTION_OPEN)
        self.assertEqual(staged.operation.state, StageOperationState.CANDIDATE_STAGED)
        receipt = staged.operation.completed_stage_receipt
        self.assertIsNotNone(receipt)
        assert receipt is not None
        self.assertEqual(receipt.candidate_staged_event_sha256, staged.event.event_sha256)
        self.assertEqual(
            receipt.journal_anchor_attestation_sha256,
            staged.operation.journal_anchor_attestation_sha256,
        )
        self.assertEqual(receipt.journal_catalog_generation, 5)
        self.assertFalse(receipt.authorizes_internal_commit)
        self.assertFalse(receipt.authorizes_manufacturing_release)
        self.clock.value += timedelta(seconds=7)
        capability = self.journal.verify_completed_stage_receipt(receipt)
        self.assertIs(type(capability), VerifiedStageCapability)
        self.clock.value += timedelta(seconds=11)
        self.assertIs(
            self.journal.require_verified_stage_capability(capability), capability
        )
        for unsafe_name in (
            "mark_transaction_open",
            "mark_candidate_staged",
            "require_recovery",
            "mark_rolled_back",
        ):
            self.assertFalse(hasattr(self.journal, unsafe_name))

    def test_live_effect_drift_blocks_receipt_mint_and_capability_acceptance(
        self,
    ) -> None:
        prepared = self._prepare()
        _, staged = self._stage_from(prepared)
        receipt = staged.operation.completed_stage_receipt
        self.assertIsNotNone(receipt)
        assert receipt is not None
        self.assertIsNotNone(self.store.candidate_generation)

        mutations = (
            ("transaction_generation", self.store.transaction_generation + 1),
            ("transaction_snapshot", "d" * 64),
            ("candidate_generation", self.store.candidate_generation + 1),
            ("candidate_event", "e" * 64),
            ("candidate_snapshot", "f" * 64),
        )
        for field, changed in mutations:
            with self.subTest(boundary="mint", field=field):
                original = getattr(self.store, field)
                setattr(self.store, field, changed)
                try:
                    with self.assertRaises(StageOperationEvidenceMismatch):
                        self.journal.verify_completed_stage_receipt(receipt)
                finally:
                    setattr(self.store, field, original)

        capability = self.journal.verify_completed_stage_receipt(receipt)
        for field, changed in mutations:
            with self.subTest(boundary="accept", field=field):
                original = getattr(self.store, field)
                setattr(self.store, field, changed)
                try:
                    with self.assertRaises(StageOperationEvidenceMismatch):
                        self.journal.require_verified_stage_capability(capability)
                finally:
                    setattr(self.store, field, original)
        self.assertIs(
            self.journal.require_verified_stage_capability(capability), capability
        )

    def test_raw_records_and_syntactic_receipts_are_never_accepted(self) -> None:
        prepared = self._prepare()
        prepared_event = prepared.events[0]
        opened = replace(
            prepared_event,
            sequence=1,
            transition_id="transaction-open",
            kind=StageOperationEventKind.TRANSACTION_OPENED,
            from_state=StageOperationState.PREPARED,
            to_state=StageOperationState.TRANSACTION_OPEN,
            request_sha256="1" * 64,
            payload_sha256="2" * 64,
            previous_event_sha256=prepared_event.event_sha256,
            event_sha256="3" * 64,
            payload={},
        )
        staged_event = replace(
            opened,
            sequence=2,
            transition_id="candidate-stage",
            kind=StageOperationEventKind.CANDIDATE_STAGED,
            from_state=StageOperationState.TRANSACTION_OPEN,
            to_state=StageOperationState.CANDIDATE_STAGED,
            request_sha256="4" * 64,
            payload_sha256="5" * 64,
            previous_event_sha256=opened.event_sha256,
            event_sha256="6" * 64,
            payload={
                "candidate_evidence": {
                    "staged_candidate_generation": (
                        prepared.binding.candidate_generation + 1
                    ),
                    "staged_candidate_last_event_sha256": "7" * 64,
                    "attestation_sha256": "8" * 64,
                }
            },
        )
        forged_operation = replace(
            prepared,
            state=StageOperationState.CANDIDATE_STAGED,
            generation=2,
            last_event_sha256=staged_event.event_sha256,
            events=(prepared_event, opened, staged_event),
            journal_generation=3,
        )
        raw_receipt = forged_operation.completed_stage_receipt
        self.assertIsNotNone(raw_receipt)
        assert raw_receipt is not None
        self.assertFalse(raw_receipt.is_authority)
        with self.assertRaises(StageOperationEvidenceMismatch):
            self.journal.verify_completed_stage_receipt(raw_receipt)
        with self.assertRaises(StageOperationEvidenceMismatch):
            self.journal.require_verified_stage_capability(raw_receipt)

    def test_verified_capability_is_revoked_by_any_journal_successor(self) -> None:
        prepared = self._prepare()
        _, staged = self._stage_from(prepared)
        receipt = staged.operation.completed_stage_receipt
        assert receipt is not None
        capability = self.journal.verify_completed_stage_receipt(receipt)
        with self.journal.recovery_guard(
            prepared.binding.operation_id,
            expected_generation=staged.operation.generation,
            service_actor=SERVICE,
        ) as guard:
            with self.assertRaises(StageOperationEvidenceMismatch):
                self.journal.require_verified_stage_capability(capability)
            guard.execute_rollback(self.store.rollback)
        with self.assertRaises(StageOperationEvidenceMismatch):
            self.journal.require_verified_stage_capability(capability)

    def test_already_applied_transaction_is_preflighted_and_callback_is_skipped(self) -> None:
        prepared = self._prepare()
        self.store.open_transaction(prepared.binding)
        calls = []
        with self.journal.execution_guard(
            prepared.binding.operation_id,
            expected_generation=0,
            service_actor=SERVICE,
        ) as guard:
            opened = guard.execute_transaction_open(
                lambda _: calls.append("must-not-run")
            )
            self.clock.value += timedelta(seconds=1)
            guard.execute_candidate_stage(self.store.stage_candidate)
        self.assertEqual(calls, [])
        self.assertEqual(opened.operation.generation, 1)
        self.assertFalse(
            any(
                event.kind is StageOperationEventKind.TRANSACTION_OPEN_STARTED
                for event in opened.operation.events
            )
        )

    def test_ambiguous_base_exception_blocks_same_session_retry_without_recovery(self) -> None:
        class SimulatedProcessAbort(BaseException):
            pass

        prepared = self._prepare()
        self.provider.fail_recovery = True
        calls = []

        def mutate_then_abort(binding):
            calls.append("called")
            self.store.open_transaction(binding)
            raise SimulatedProcessAbort()

        with self.assertRaises(StageOperationRecoveryRequired):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                with self.assertRaises(SimulatedProcessAbort):
                    guard.execute_transaction_open(mutate_then_abort)
                with self.assertRaises(IllegalStageOperationTransition):
                    guard.execute_transaction_open(mutate_then_abort)
        self.assertEqual(calls, ["called"])
        operation = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(operation.state, StageOperationState.SIDE_EFFECT_UNCERTAIN)
        self.assertIsNone(operation.completed_stage_receipt)

    def test_repeated_rollback_recovery_cycles_have_unique_transition_slots(
        self,
    ) -> None:
        class SimulatedRollbackAbort(BaseException):
            pass

        prepared = self._prepare()
        _, staged = self._stage_from(prepared)
        calls: list[str] = []

        def partially_rollback_then_abort(binding) -> None:
            calls.append("abort")
            self.store.transaction = TransactionDisposition.ROLLED_BACK
            raise SimulatedRollbackAbort()

        for _ in range(2):
            current = self.journal.get(prepared.binding.operation_id)
            with self.assertRaises(SimulatedRollbackAbort):
                with self.journal.recovery_guard(
                    prepared.binding.operation_id,
                    expected_generation=current.generation,
                    service_actor=SERVICE,
                ) as guard:
                    guard.execute_rollback(partially_rollback_then_abort)
            current = self.journal.get(prepared.binding.operation_id)
            self.assertIs(current.state, StageOperationState.SIDE_EFFECT_UNCERTAIN)

        current = self.journal.get(prepared.binding.operation_id)
        with self.journal.recovery_guard(
            prepared.binding.operation_id,
            expected_generation=current.generation,
            service_actor=SERVICE,
        ) as guard:
            completed = guard.execute_rollback(self.store.rollback)
        self.assertIs(completed.operation.state, StageOperationState.ROLLED_BACK)
        self.assertEqual(completed.operation.generation, 13)
        self.assertEqual(calls, ["abort", "abort"])
        kinds = tuple(event.kind for event in completed.operation.events)
        self.assertEqual(kinds.count(StageOperationEventKind.RECOVERY_REQUIRED), 3)
        self.assertEqual(kinds.count(StageOperationEventKind.ROLLBACK_STARTED), 3)
        self.assertEqual(kinds.count(StageOperationEventKind.SIDE_EFFECT_UNCERTAIN), 2)
        transition_ids = tuple(
            event.transition_id for event in completed.operation.events
        )
        self.assertEqual(len(transition_ids), len(set(transition_ids)))
        self.assertEqual(
            tuple(event.sequence for event in completed.operation.events),
            tuple(range(14)),
        )

    def test_repeated_recovery_anchor_successor_projects_after_sqlite_failure(
        self,
    ) -> None:
        class SimulatedRollbackAbort(BaseException):
            pass

        prepared = self._prepare()
        _, staged = self._stage_from(prepared)

        def complete_rollback_then_abort(binding) -> None:
            self.store.rollback(binding)
            raise SimulatedRollbackAbort()

        with self.assertRaises(SimulatedRollbackAbort):
            with self.journal.recovery_guard(
                prepared.binding.operation_id,
                expected_generation=staged.operation.generation,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_rollback(complete_rollback_then_abort)
        uncertain = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(uncertain.generation, 7)
        original_insert = self.journal._insert_event_locked

        def fail_second_recovery(event):
            if (
                event.kind is StageOperationEventKind.RECOVERY_REQUIRED
                and event.sequence == 8
            ):
                raise sqlite3.OperationalError(
                    "injected repeated recovery projection failure"
                )
            return original_insert(event)

        with self.assertRaises(sqlite3.OperationalError), patch.object(
            self.journal,
            "_insert_event_locked",
            side_effect=fail_second_recovery,
        ):
            with self.journal.recovery_guard(
                prepared.binding.operation_id,
                expected_generation=uncertain.generation,
                service_actor=SERVICE,
            ):
                self.fail("recovery guard yielded before its durable transition")
        external = self.anchor.current(operation_id=prepared.binding.operation_id)
        self.assertEqual(external.generation, 8)
        with closing(sqlite3.connect(self.database)) as connection:
            state, generation = connection.execute(
                "SELECT state,generation FROM import_stage_operations"
            ).fetchone()
        self.assertEqual((state, generation), ("side_effect_uncertain", 7))

        self.journal.close()
        self.journal = self._new_journal()
        recovered = self.journal.get(prepared.binding.operation_id)
        self.assertIs(recovered.state, StageOperationState.RECOVERY_REQUIRED)
        self.assertEqual(recovered.generation, 8)
        recovery_events = tuple(
            event
            for event in recovered.events
            if event.kind is StageOperationEventKind.RECOVERY_REQUIRED
        )
        self.assertEqual(len(recovery_events), 2)
        self.assertNotEqual(
            recovery_events[0].transition_id, recovery_events[1].transition_id
        )

        calls: list[str] = []

        with self.journal.recovery_guard(
            prepared.binding.operation_id,
            expected_generation=recovered.generation,
            service_actor=SERVICE,
        ) as guard:
            completed = guard.execute_rollback(
                lambda _: calls.append("must-not-rerun")
            )
        self.assertIs(completed.operation.state, StageOperationState.ROLLED_BACK)
        self.assertEqual(calls, [])

    def test_exact_trusted_types_and_captured_adapter_identity_are_required(self) -> None:
        prepared = self._prepare()
        calls = []
        original_provider_id = self.provider.provider_id

        # A changed adapter attribute cannot redefine the identity captured by
        # the journal constructor, even if all returned hashes remain valid.
        self.provider.provider_id = "stage-test-changed-provider"
        with self.assertRaises(StageOperationEvidenceMismatch):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_transaction_open(lambda _: calls.append("changed-id"))
        self.provider.provider_id = original_provider_id

        self.provider.return_preflight_subclass = True
        with self.assertRaises(StageOperationEvidenceMismatch):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_transaction_open(lambda _: calls.append("subclass"))
        self.assertEqual(calls, [])

    def test_execution_lease_subclass_is_rejected_before_callback(self) -> None:
        prepared = self._prepare()
        self.coordinator.return_lease_subclass = True
        calls = []
        with self.assertRaises(StageOperationEvidenceMismatch):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_transaction_open(lambda _: calls.append("forged-lease"))
        self.assertEqual(calls, [])

    def test_post_callback_fencing_loss_blocks_projection_and_forward_retry(self) -> None:
        prepared = self._prepare()
        calls = []

        def mutate_then_lose_fence(binding):
            calls.append("open")
            self.store.open_transaction(binding)
            self.coordinator._active.clear()

        with self.assertRaises(StageOperationEvidenceMismatch):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_transaction_open(mutate_then_lose_fence)
        operation = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(
            operation.state, StageOperationState.TRANSACTION_OPEN_STARTED
        )
        self.assertEqual(calls, ["open"])
        with self.assertRaises(IllegalStageOperationTransition):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=operation.generation,
                service_actor=SERVICE,
            ):
                pass
        self.assertEqual(calls, ["open"])

    def test_anchor_state_subclass_is_rejected_even_with_valid_fields(self) -> None:
        self.anchor.return_state_subclass = True
        with self.assertRaises(StageOperationEvidenceMismatch):
            self._prepare()

    def test_outcome_receipt_is_revoked_by_recovery_and_rollback(self) -> None:
        prepared = self._prepare()
        _, staged = self._stage_from(prepared)
        self.assertIsNotNone(staged.operation.completed_stage_receipt)
        with self.journal.recovery_guard(
            prepared.binding.operation_id,
            expected_generation=staged.operation.generation,
            service_actor=SERVICE,
        ) as guard:
            self.assertIsNone(guard.operation.completed_stage_receipt)
            rolled = guard.execute_rollback(self.store.rollback)
        self.assertEqual(rolled.operation.state, StageOperationState.ROLLED_BACK)
        self.assertIsNone(rolled.operation.completed_stage_receipt)

    def test_second_instance_cannot_recover_while_live_execution_lease_is_held(self) -> None:
        prepared = self._prepare()
        other = self._new_journal()
        try:
            with self.assertRaises(StageOperationRecoveryRequired):
                with self.journal.execution_guard(
                    prepared.binding.operation_id,
                    expected_generation=0,
                    service_actor=SERVICE,
                ):
                    with self.assertRaises(RuntimeError):
                        with other.recovery_guard(
                            prepared.binding.operation_id,
                            expected_generation=0,
                            service_actor=SERVICE,
                        ):
                            pass
            self.assertEqual(
                self.journal.get(prepared.binding.operation_id).state,
                StageOperationState.RECOVERY_REQUIRED,
            )
        finally:
            other.close()

    def test_restart_is_rollback_only_and_prepare_retry_never_reowns(self) -> None:
        prepared = self._prepare()
        owner = self.journal.session_id
        self.journal.close()
        self.journal = self._new_journal()
        retried = self.journal.prepare(self.authorization, service_actor=SERVICE)
        self.assertFalse(retried.created)
        self.assertEqual(retried.operation.binding.owner_session_id, owner)
        with self.assertRaises(StageOperationRecoveryRequired):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ):
                pass
        with self.journal.recovery_guard(
            prepared.binding.operation_id,
            expected_generation=0,
            service_actor=SERVICE,
        ) as guard:
            rolled = guard.execute_rollback(self.store.rollback)
        self.assertEqual(rolled.operation.state, StageOperationState.ROLLED_BACK)

    def test_expiry_and_rebound_authority_fail_before_side_effect(self) -> None:
        prepared = self._prepare()
        calls = []
        self.provider.rebind_project = True
        with self.assertRaises(StageOperationEvidenceMismatch):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_transaction_open(lambda _: calls.append("stale"))
        self.assertEqual(calls, [])

        # Recovery from the stale-authority attempt is already journaled; use a
        # fresh fixture in the expiry-specific test below.

    def test_expiry_fails_before_side_effect(self) -> None:
        prepared = self._prepare()
        self.clock.value = self.authorization.expires_at
        calls = []
        with self.assertRaises(StageOperationExpired), self.journal.execution_guard(
            prepared.binding.operation_id,
            expected_generation=0,
            service_actor=SERVICE,
        ) as guard:
            guard.execute_transaction_open(lambda _: calls.append("expired"))
        self.assertEqual(calls, [])

    def test_candidate_callback_race_rechecks_expiry_and_live_authority(self) -> None:
        prepared = self._prepare()
        with self.assertRaises(StageOperationExpired), self.journal.execution_guard(
            prepared.binding.operation_id,
            expected_generation=0,
            service_actor=SERVICE,
        ) as guard:
            self.clock.value += timedelta(seconds=1)
            guard.execute_transaction_open(self.store.open_transaction)

            def stage_then_expire(binding, receipt):
                self.store.stage_candidate(binding, receipt)
                self.clock.value = self.authorization.expires_at

            guard.execute_candidate_stage(stage_then_expire)
        operation = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(operation.state, StageOperationState.RECOVERY_REQUIRED)
        self.assertIsNone(operation.completed_stage_receipt)

    def test_candidate_callback_race_rechecks_mutable_authority(self) -> None:
        prepared = self._prepare()
        with self.assertRaises(StageOperationEvidenceMismatch):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                self.clock.value += timedelta(seconds=1)
                guard.execute_transaction_open(self.store.open_transaction)

                def stage_then_rebind(binding, receipt):
                    self.store.stage_candidate(binding, receipt)
                    self.provider.rebind_project = True

                guard.execute_candidate_stage(stage_then_rebind)
        operation = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(operation.state, StageOperationState.RECOVERY_REQUIRED)
        self.assertIsNone(operation.completed_stage_receipt)

    def test_anchor_cas_rejection_records_only_verified_recovery(self) -> None:
        prepared = self._prepare()
        self.anchor.reject_next_advance = True
        with self.assertRaises(StageOperationConcurrencyConflict):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                guard.execute_transaction_open(self.store.open_transaction)
        operation = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(operation.state, StageOperationState.RECOVERY_REQUIRED)
        self.assertEqual(operation.generation, 1)
        self.assertIsNone(operation.completed_stage_receipt)
        self.assertEqual(
            self.anchor.current(operation_id=prepared.binding.operation_id).generation,
            1,
        )

    def test_anchor_ahead_after_sqlite_failure_projects_exact_successor(self) -> None:
        prepared = self._prepare()
        with self.assertRaises(sqlite3.OperationalError), self.journal.execution_guard(
            prepared.binding.operation_id,
            expected_generation=0,
            service_actor=SERVICE,
        ) as guard, patch.object(
            self.journal,
            "_insert_event_locked",
            side_effect=sqlite3.OperationalError("injected SQLite failure"),
        ):
            guard.execute_transaction_open(self.store.open_transaction)
        external = self.anchor.current(operation_id=prepared.binding.operation_id)
        self.assertEqual(external.generation, 1)
        with closing(sqlite3.connect(self.database)) as connection:
            state, generation = connection.execute(
                "SELECT state,generation FROM import_stage_operations"
            ).fetchone()
        self.assertEqual((state, generation), ("prepared", 0))
        self.journal.close()
        self.journal = self._new_journal()
        recovered = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(
            recovered.state, StageOperationState.TRANSACTION_OPEN_STARTED
        )
        self.assertEqual(recovered.generation, 1)
        self.assertIsNone(recovered.completed_stage_receipt)
        self.assertIs(self.store.transaction, TransactionDisposition.ABSENT)

    def test_post_yield_anchor_mismatch_deactivates_guard_before_restart(
        self,
    ) -> None:
        prepared = self._prepare()
        with patch.object(
            self.journal,
            "_deactivate_guard",
            wraps=self.journal._deactivate_guard,
        ) as deactivate, patch.object(
            self.journal,
            "_insert_event_locked",
            side_effect=sqlite3.OperationalError(
                "injected post-yield projection failure"
            ),
        ), self.assertRaisesRegex(
            StageOperationIntegrityError,
            "SQLite journal is behind, ahead of, or rebound from its monotonic anchor",
        ):
            with self.journal.execution_guard(
                prepared.binding.operation_id,
                expected_generation=0,
                service_actor=SERVICE,
            ) as guard:
                with self.assertRaisesRegex(
                    sqlite3.OperationalError,
                    "injected post-yield projection failure",
                ):
                    guard.execute_transaction_open(self.store.open_transaction)
        deactivate.assert_called_once()
        self.assertEqual(self.journal._active_guards, {})
        self.assertEqual(self.coordinator._active, {})
        external = self.anchor.current(operation_id=prepared.binding.operation_id)
        self.assertEqual(external.generation, 1)
        with closing(sqlite3.connect(self.database)) as connection:
            state, generation = connection.execute(
                "SELECT state,generation FROM import_stage_operations"
            ).fetchone()
        self.assertEqual((state, generation), ("prepared", 0))

        self.journal.close()
        self.journal = self._new_journal()
        recovered = self.journal.get(prepared.binding.operation_id)
        self.assertIs(
            recovered.state, StageOperationState.TRANSACTION_OPEN_STARTED
        )
        self.assertEqual(recovered.generation, 1)
        self.assertIsNone(recovered.completed_stage_receipt)
        self.assertIs(self.store.transaction, TransactionDisposition.ABSENT)

    def test_post_callback_sqlite_failure_projects_result_without_rerun(self) -> None:
        prepared = self._prepare()
        calls = []
        original_insert = self.journal._insert_event_locked

        def fail_result(event):
            if event.kind is StageOperationEventKind.TRANSACTION_OPENED:
                raise sqlite3.OperationalError("injected result projection failure")
            return original_insert(event)

        def open_once(binding):
            calls.append("open")
            self.store.open_transaction(binding)

        with self.assertRaises(sqlite3.OperationalError), self.journal.execution_guard(
            prepared.binding.operation_id,
            expected_generation=0,
            service_actor=SERVICE,
        ) as guard, patch.object(
            self.journal, "_insert_event_locked", side_effect=fail_result
        ):
            guard.execute_transaction_open(open_once)
        self.assertEqual(calls, ["open"])
        self.journal.close()
        self.journal = self._new_journal()
        recovered = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(recovered.state, StageOperationState.TRANSACTION_OPEN)
        self.assertEqual(recovered.generation, 2)
        self.assertIsNone(recovered.completed_stage_receipt)

    def test_completed_rollback_projection_is_recovered_without_rerun(self) -> None:
        prepared = self._prepare()
        _, staged = self._stage_from(prepared)
        calls = []
        original_insert = self.journal._insert_event_locked

        def fail_completed(event):
            if event.kind is StageOperationEventKind.ROLLBACK_COMPLETED:
                raise sqlite3.OperationalError("injected rollback projection failure")
            return original_insert(event)

        def rollback_once(binding):
            calls.append("rollback")
            self.store.rollback(binding)

        with self.assertRaises(sqlite3.OperationalError), self.journal.recovery_guard(
            prepared.binding.operation_id,
            expected_generation=staged.operation.generation,
            service_actor=SERVICE,
        ) as guard, patch.object(
            self.journal, "_insert_event_locked", side_effect=fail_completed
        ):
            guard.execute_rollback(rollback_once)
        self.assertEqual(calls, ["rollback"])
        self.journal.close()
        self.journal = self._new_journal()
        recovered = self.journal.get(prepared.binding.operation_id)
        self.assertEqual(recovered.state, StageOperationState.ROLLED_BACK)
        with self.journal.recovery_guard(
            prepared.binding.operation_id,
            expected_generation=recovered.generation,
            service_actor=SERVICE,
        ) as guard:
            retry = guard.execute_rollback(
                lambda _: calls.append("must-not-rerun")
            )
        self.assertTrue(retry.idempotent_retry)
        self.assertEqual(calls, ["rollback"])

    def test_whole_file_rollback_and_clean_replacement_fail_at_open(self) -> None:
        prepared = self._prepare()
        backup = self.root / "old.sqlite3"
        with closing(sqlite3.connect(self.database)) as source, closing(
            sqlite3.connect(backup)
        ) as target:
            source.backup(target)
        self._stage_from(prepared)
        self.journal.close()
        Path(str(self.database) + "-wal").unlink(missing_ok=True)
        Path(str(self.database) + "-shm").unlink(missing_ok=True)
        shutil.copy2(backup, self.database)
        with self.assertRaises(StageOperationIntegrityError):
            self.journal = self._new_journal()

        self.database.unlink(missing_ok=True)
        Path(str(self.database) + "-wal").unlink(missing_ok=True)
        Path(str(self.database) + "-shm").unlink(missing_ok=True)
        with self.assertRaises(StageOperationIntegrityError):
            self.journal = self._new_journal()

    def test_recognized_forged_schema_cannot_self_bootstrap(self) -> None:
        self.journal.close()
        self.database.unlink(missing_ok=True)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("PRAGMA application_id = 1179863603")
            connection.execute("PRAGMA user_version = 3")
            connection.execute("CREATE TABLE import_stage_journal_metadata(x)")
            connection.execute("CREATE TABLE import_stage_journal_head(x)")
            connection.execute("CREATE TABLE import_stage_operations(target TEXT)")
            connection.execute("CREATE TABLE import_stage_operation_events(x)")
            connection.execute(
                "CREATE INDEX idx_import_stage_operations_candidate_target "
                "ON import_stage_operations(target)"
            )
            connection.execute(
                "CREATE INDEX idx_import_stage_operations_mapping_target "
                "ON import_stage_operations(target)"
            )
            triggers = (
                ("import_stage_metadata_no_update", "import_stage_journal_metadata"),
                ("import_stage_metadata_no_delete", "import_stage_journal_metadata"),
                ("import_stage_head_no_delete", "import_stage_journal_head"),
                ("import_stage_head_monotonic_update", "import_stage_journal_head"),
                ("import_stage_operations_no_delete", "import_stage_operations"),
                ("import_stage_operations_identity_immutable", "import_stage_operations"),
                ("import_stage_operations_monotonic_update", "import_stage_operations"),
                ("import_stage_events_no_update", "import_stage_operation_events"),
                ("import_stage_events_no_delete", "import_stage_operation_events"),
                ("import_stage_events_append_chain", "import_stage_operation_events"),
            )
            for name, table in triggers:
                connection.execute(
                    f"CREATE TRIGGER {name} AFTER INSERT ON {table} "
                    "BEGIN SELECT 1; END"
                )
            connection.execute("INSERT INTO import_stage_operations VALUES('same-target')")
            connection.execute("INSERT INTO import_stage_operations VALUES('same-target')")
        with self.assertRaises(StageOperationIntegrityError):
            self.journal = self._new_journal()

    def test_append_only_triggers_and_same_name_trigger_tamper_fail_closed(self) -> None:
        self._prepare()
        with closing(sqlite3.connect(self.database)) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("UPDATE import_stage_operation_events SET actor='x'")
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM import_stage_operations")
        self.journal.close()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("DROP TRIGGER import_stage_events_no_update")
            connection.execute(
                "CREATE TRIGGER import_stage_events_no_update "
                "BEFORE UPDATE ON import_stage_operation_events BEGIN SELECT 1; END"
            )
        with self.assertRaises(StageOperationIntegrityError):
            self.journal = self._new_journal()

    def test_external_anchor_rejects_authorization_reuse_after_database_loss(self) -> None:
        self._prepare()
        self.journal.close()
        self.database.unlink(missing_ok=True)
        with self.assertRaises(StageOperationIntegrityError):
            self.journal = self._new_journal()
        self.assertEqual(len(self.anchor.authorizations), 1)


if __name__ == "__main__":
    unittest.main()

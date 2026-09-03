from __future__ import annotations

# These tests intentionally import sealed-ledger internals and upstream test
# fixtures in order to inject corruption at otherwise unreachable boundaries.
# pyright: reportPrivateUsage=false
import json
import shutil
import sqlite3
import unittest
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Protocol, cast

from backend.canonical_import import (
    ImportMappingResult,
    MappingEvidenceDraft,
    MappingEvidenceRepository,
    SQLiteMappingEvidenceRepository,
    map_project_import,
)
from backend.design_kernel import DesignGraph, DesignKernel, stable_hash
from backend.design_kernel.model import canonical_json
from backend.import_approval import (
    ApprovalLedgerAnchor,
    ApprovalSourceSnapshot,
    AuthenticatedPrincipal,
    AuthorizedImportStagingInput,
    CurrentAuthoritySnapshot,
    ImportApprovalActorMismatch,
    ImportApprovalContext,
    ImportApprovalContract,
    ImportApprovalEvidenceMismatch,
    ImportApprovalExpired,
    ImportApprovalIntegrityError,
    ImportApprovalInvariantError,
    ImportApprovalLifecycle,
    ImportApprovalLifecycleError,
    ImportApprovalStale,
    ImportApprovalStatus,
    MappingApprovalRequest,
    MappingDecision,
    PrincipalRole,
    ReviewManifest,
    ReviewQuestionAnswer,
)
from backend.import_approval.ledger import _SCHEMA_STATEMENTS, SQLiteApprovalLedger
from backend.import_approval.serialization import decode_record_json, record_json
from backend.kicad_import_candidates import (
    ImportCandidate,
    ImportCandidateRepository,
    SQLiteImportCandidateRepository,
)
from backend.kicad_project import ProjectBundleInput
from tests.canonical_import.test_evidence_store import (
    pending_candidate,  # pyright: ignore[reportUnknownVariableType]
)
from tests.canonical_import.test_mapper import FixtureResolver, _import, _source

PROJECT_ID = "approval-import-project"
UPLOADER = "candidate-owner"
REVIEWER = "mapping-reviewer"
MAPPER = "trusted-import-boundary"
SERVICE = "canonical-import-staging-service"
AUTHORITY_ID = "workspace-authentication-authority"
RUN_ID = "mapping-evidence-run"
RUN_REVISION = 4
ISSUER_KEY = b"import-approval-test-key-material-32-bytes-minimum"


class _PendingCandidate(Protocol):
    def __call__(
        self,
        database: Path,
        mapping_result: ImportMappingResult,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> tuple[SQLiteImportCandidateRepository, ImportCandidate]: ...


_pending_candidate = cast(_PendingCandidate, pending_candidate)


class MutableClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 8, 29, 20, 0, tzinfo=UTC)
        self.sequence: list[datetime] = []

    def __call__(self) -> datetime:
        if self.sequence:
            return self.sequence.pop(0)
        return self.value


class MutableAuthorityProvider:
    def __init__(
        self,
        snapshot: CurrentAuthoritySnapshot,
        principals: tuple[AuthenticatedPrincipal, ...],
    ) -> None:
        self.snapshot = snapshot
        self.principals = {
            (principal.principal_id, principal.role): principal
            for principal in principals
        }
        self.candidate_repository: ImportCandidateRepository | None = None
        self.mapping_repository: MappingEvidenceRepository | None = None
        self.fail_source_cas = False
        self.source_cas_hook: Callable[[], None] | None = None
        self.attest_hook: Callable[[], None] | None = None
        self.authority_collect_count = 0
        self.authority_collect_hook: Callable[[int], None] | None = None

    def current_authority(
        self,
        *,
        project_id: str,
        run_id: str,
    ) -> CurrentAuthoritySnapshot:
        self.authority_collect_count += 1
        if self.authority_collect_hook is not None:
            self.authority_collect_hook(self.authority_collect_count)
        if project_id != self.snapshot.project_id or run_id != self.snapshot.run_id:
            raise KeyError("unknown authority subject")
        return self.snapshot

    def attest_principal(
        self,
        *,
        principal: AuthenticatedPrincipal,
        role: PrincipalRole,
    ) -> AuthenticatedPrincipal:
        current = self.principals[(principal.principal_id, role)]
        if current is not principal:
            raise PermissionError("principal object was not provider-issued")
        if self.attest_hook is not None:
            self.attest_hook()
        return current

    def principal_authority_snapshot_sha256(self) -> str:
        return stable_hash(
            tuple(
                sorted(
                    (
                        principal.principal_id,
                        principal.role.value,
                        principal.authority_id,
                        principal.authentication_event_sha256,
                    )
                    for principal in self.principals.values()
                )
            ),
            domain="flux-clone-test-principal-authority-snapshot-v1",
        )

    def compare_and_swap_source_snapshot(
        self,
        *,
        expected: ApprovalSourceSnapshot,
        operation_id: str,
    ) -> ApprovalSourceSnapshot:
        if self.fail_source_cas:
            raise RuntimeError("source CAS unavailable")
        if self.source_cas_hook is not None:
            self.source_cas_hook()
        if self.candidate_repository is None or self.mapping_repository is None:
            raise RuntimeError("source repositories were not configured")
        candidate = self.candidate_repository.get(expected.candidate_id)
        mapping = self.mapping_repository.get(expected.mapping_evidence_id)
        current = ApprovalSourceSnapshot.create(
            candidate_id=candidate.candidate_id,
            candidate_version_sha256=stable_hash(
                {
                    "candidate_id": candidate.candidate_id,
                    "candidate_sha256": candidate.candidate_digest,
                    "generation": candidate.generation,
                    "last_event_sha256": candidate.last_event_digest,
                    "state": candidate.state.value,
                },
                domain="flux-clone-import-approval-candidate-version-v1",
            ),
            mapping_evidence_id=mapping.mapping_evidence_id,
            mapping_version_sha256=stable_hash(
                {
                    "mapping_evidence_id": mapping.mapping_evidence_id,
                    "mapping_evidence_sha256": mapping.mapping_evidence_digest,
                    "generation": mapping.generation,
                    "last_event_sha256": mapping.last_event_digest,
                    "state": mapping.state.value,
                },
                domain="flux-clone-import-approval-mapping-version-v1",
            ),
            authority_snapshot_sha256=self.snapshot.snapshot_digest,
            principal_authority_snapshot_sha256=(
                self.principal_authority_snapshot_sha256()
            ),
        )
        if current.snapshot_sha256 != expected.snapshot_sha256:
            raise RuntimeError("source snapshot compare-and-swap conflict")
        return current


class InMemoryAnchorStore:
    def __init__(self) -> None:
        self.anchors: dict[str, ApprovalLedgerAnchor] = {}
        self.available = True
        self.fail_cas = False
        self.cas_conflict_anchor: ApprovalLedgerAnchor | None = None

    def provision(self, issuer_id: str) -> None:
        self.anchors[issuer_id] = ApprovalLedgerAnchor(0, "0" * 64)

    def read_anchor(self, *, issuer_id: str) -> ApprovalLedgerAnchor:
        if not self.available:
            raise RuntimeError("anchor unavailable")
        return self.anchors[issuer_id]

    def compare_and_swap_anchor(
        self,
        *,
        issuer_id: str,
        expected: ApprovalLedgerAnchor,
        replacement: ApprovalLedgerAnchor,
    ) -> ApprovalLedgerAnchor:
        if not self.available or self.fail_cas:
            raise RuntimeError("anchor CAS unavailable")
        if self.cas_conflict_anchor is not None:
            self.anchors[issuer_id] = self.cas_conflict_anchor
            raise RuntimeError("injected anchor CAS conflict")
        current = self.anchors[issuer_id]
        if current.sequence != expected.sequence or current.digest != expected.digest:
            raise RuntimeError("anchor compare-and-swap conflict")
        self.anchors[issuer_id] = replacement
        return replacement


class _ClosedContract:
    def close(self) -> None:
        pass


class ImportApprovalContractTests(unittest.TestCase):
    base_revision: str
    mapping: ImportMappingResult

    @classmethod
    def setUpClass(cls) -> None:
        empty = DesignKernel(DesignGraph(1, PROJECT_ID))
        cls.base_revision = empty.head.revision_hash
        cls.mapping = map_project_import(
            _import(exact_stage=True),
            source_payload=cast(ProjectBundleInput, _source(exact_stage=True)),
            project_id=PROJECT_ID,
            base_revision=cls.base_revision,
            transaction_id="transaction-import-approved",
            actor=MAPPER,
            component_resolver=FixtureResolver(),
        )
        assert cls.mapping.transaction_input is not None

    def setUp(self) -> None:
        self.clock = MutableClock()
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repository, pending = _pending_candidate(
            self.root / "candidates.sqlite3",
            self.mapping,
            clock=self.clock,
        )
        self.mapping_evidence_repository = SQLiteMappingEvidenceRepository(
            self.root / "mapping-evidence.sqlite3",
            clock=self.clock,
        )
        self.mapping_evidence = self.mapping_evidence_repository.create(
            MappingEvidenceDraft.from_mapping(pending, self.mapping)
        )
        self.candidate = self.repository.resolve(
            pending.candidate_id,
            expected_generation=pending.generation,
            actor_id=UPLOADER,
            resolution_receipt_digest=self.mapping_evidence.mapping_evidence_digest,
        )
        self.uploader = self.principal(UPLOADER, PrincipalRole.HUMAN_REVIEWER, "1")
        self.reviewer = self.principal(REVIEWER, PrincipalRole.HUMAN_REVIEWER, "2")
        self.mapper = self.principal(MAPPER, PrincipalRole.TRUSTED_MAPPER, "3")
        self.service = self.principal(SERVICE, PrincipalRole.STAGING_SERVICE, "4")
        self.snapshot = CurrentAuthoritySnapshot(
            project_id=PROJECT_ID,
            project_head_revision=self.base_revision,
            project_event_head_sha256="5" * 64,
            run_id=RUN_ID,
            run_revision=RUN_REVISION,
            run_incarnation="run-incarnation-1",
            run_event_head_sha256="6" * 64,
            coordination_context_digest="c" * 64,
            coordination_incarnation="coordination-incarnation-1",
            coordination_event_head_sha256="7" * 64,
            target_store_id="canonical-project-store",
            target_store_incarnation="project-store-incarnation-1",
        )
        self.authority = MutableAuthorityProvider(
            self.snapshot,
            (self.uploader, self.reviewer, self.mapper, self.service),
        )
        self.authority.candidate_repository = self.repository
        self.authority.mapping_repository = self.mapping_evidence_repository
        self.anchor_store = InMemoryAnchorStore()
        self.anchor_store.provision("canonical-import-approval-boundary")
        self.context = self.context_for(self.snapshot)
        self.review = self.review_manifest()
        self.ledger_path = self.root / "approval-ledger.sqlite3"
        self.contract: ImportApprovalContract = self.contract_for()

    def tearDown(self) -> None:
        self.contract.close()
        self.mapping_evidence_repository.close()
        self.repository.close()
        self.temporary.cleanup()

    @staticmethod
    def principal(
        principal_id: str,
        role: PrincipalRole,
        seed: str,
        *,
        authority_id: str = AUTHORITY_ID,
    ) -> AuthenticatedPrincipal:
        return AuthenticatedPrincipal(
            principal_id=principal_id,
            role=role,
            authority_id=authority_id,
            authentication_event_sha256=seed * 64,
        )

    def contract_for(
        self,
        *,
        clock: Callable[[], datetime] | None = None,
        require_distinct: bool = True,
    ) -> ImportApprovalContract:
        return ImportApprovalContract(
            issuer_id="canonical-import-approval-boundary",
            sealing_key=ISSUER_KEY,
            candidate_repository=self.repository,
            mapping_evidence_repository=self.mapping_evidence_repository,
            ledger_path=self.ledger_path,
            current_authority_provider=self.authority,
            trusted_principal_provider=self.authority,
            source_cas_provider=self.authority,
            ledger_anchor_store=self.anchor_store,
            principal_authority_id=AUTHORITY_ID,
            require_distinct_uploader_reviewer=require_distinct,
            clock=clock or self.clock,
        )

    def context_for(
        self,
        snapshot: CurrentAuthoritySnapshot,
        *,
        uploader: AuthenticatedPrincipal | None = None,
        reviewer: AuthenticatedPrincipal | None = None,
        mapper: AuthenticatedPrincipal | None = None,
        service: AuthenticatedPrincipal | None = None,
    ) -> ImportApprovalContext:
        assert self.mapping.transaction_input is not None
        return ImportApprovalContext(
            project_id=snapshot.project_id,
            base_revision=snapshot.project_head_revision,
            prospective_graph_sha256=(
                self.mapping.transaction_input.prospective_graph_sha256
            ),
            run_id=snapshot.run_id,
            run_revision=snapshot.run_revision,
            project_event_head_sha256=snapshot.project_event_head_sha256,
            run_incarnation=snapshot.run_incarnation,
            run_event_head_sha256=snapshot.run_event_head_sha256,
            coordination_incarnation=snapshot.coordination_incarnation,
            coordination_context_digest=snapshot.coordination_context_digest,
            coordination_event_head_sha256=(
                snapshot.coordination_event_head_sha256
            ),
            target_store_id=snapshot.target_store_id,
            target_store_incarnation=snapshot.target_store_incarnation,
            uploader_principal=uploader or self.uploader,
            authorized_human_principal=reviewer or self.reviewer,
            mapping_command_principal=mapper or self.mapper,
            staging_service_principal=service or self.service,
        )

    def review_manifest(self, **changes: Any) -> ReviewManifest:
        transaction = self.mapping.transaction_input
        assert transaction is not None and self.mapping.candidate is not None
        values: dict[str, Any] = {
            "semantic_diff": {
                "projectId": PROJECT_ID,
                "baseRevision": self.base_revision,
                "transactionId": transaction.transaction_id,
                "prospectiveGraphSha256": transaction.prospective_graph_sha256,
                "previewDigest": stable_hash(
                    {
                        "base_revision": self.base_revision,
                        "transaction_id": transaction.transaction_id,
                        "staged_graph_hash": transaction.prospective_graph_sha256,
                        "command_hashes": tuple(
                            command.command_hash for command in transaction.commands
                        ),
                    },
                    domain="flux-clone-preview-v2",
                ),
                "orderedCommandHashes": [
                    command.command_hash for command in transaction.commands
                ],
            },
            "commands_sha256": transaction.commands_sha256,
            "provenance_set_sha256": self.mapping.candidate.provenance_set_sha256,
            "advisories_sha256": stable_hash(
                self.mapping.advisories,
                domain="flux-clone-import-review-advisories-v1",
            ),
            "limitations": tuple(
                sorted(
                    {
                        "canonical-stage-only",
                        "deterministic-verification-and-commit-approval-still-required",
                        "kicad-execution-not-run",
                        "manufacturing-release-not-authorized",
                    }
                )
            ),
            "questions_and_answers": (
                ReviewQuestionAnswer(
                    "confirm-mapping",
                    "Do the exact resolved components and nets match the intended design?",
                    "Yes; I reviewed the exact manifest.",
                ),
            ),
            "challenge_sha256": "8" * 64,
        }
        values.update(changes)
        return ReviewManifest.create(**values)

    def request(
        self,
        operation_key: str = "request-operation-1",
        **changes: Any,
    ) -> MappingApprovalRequest:
        values: dict[str, Any] = {
            "candidate": self.candidate,
            "mapping": self.mapping,
            "mapping_evidence": self.mapping_evidence,
            "context": self.context,
            "review_manifest": self.review,
            "operation_key": operation_key,
            "expires_at": self.clock.value + timedelta(minutes=10),
            "expected_candidate_generation": self.candidate.generation,
            "expected_mapping_evidence_generation": self.mapping_evidence.generation,
        }
        values.update(changes)
        return self.contract.request_mapping_approval(**values)

    def approve(
        self,
        request: MappingApprovalRequest | None = None,
    ) -> tuple[MappingApprovalRequest, Any]:
        request = request or self.request()
        return request, self.contract.decide_mapping(
            request,
            principal=self.reviewer,
            decision=MappingDecision.APPROVED,
            expected_lifecycle_generation=0,
        )

    def authorize(
        self,
    ) -> tuple[MappingApprovalRequest, Any, AuthorizedImportStagingInput]:
        request, approval = self.approve()
        authorization = self.contract.authorize_staging(
            approval,
            candidate=self.candidate,
            mapping=self.mapping,
            mapping_evidence=self.mapping_evidence,
            context=self.context,
            principal=self.service,
            expected_candidate_generation=self.candidate.generation,
            expected_mapping_evidence_generation=self.mapping_evidence.generation,
            expected_lifecycle_generation=1,
        )
        return request, approval, authorization

    def validate(
        self,
        authorization: AuthorizedImportStagingInput,
    ) -> AuthorizedImportStagingInput:
        return self.contract.validate_staging_authorization(
            authorization,
            candidate=self.candidate,
            mapping=self.mapping,
            mapping_evidence=self.mapping_evidence,
            context=self.context,
            principal=self.service,
            expected_candidate_generation=self.candidate.generation,
            expected_mapping_evidence_generation=self.mapping_evidence.generation,
        )

    def test_exact_stage_authorization_binds_review_principals_target_and_commands(self) -> None:
        original = DesignKernel(DesignGraph(1, PROJECT_ID)).head
        request, approval, authorization = self.authorize()
        self.assertIs(self.validate(authorization), authorization)
        self.assertEqual(request.review_manifest, self.review)
        self.assertEqual(approval.decided_principal_sha256, self.reviewer.principal_digest)
        self.assertEqual(authorization.target_store_id, self.snapshot.target_store_id)
        self.assertEqual(
            authorization.command_hashes,
            tuple(command.command_hash for command in authorization.transaction_input.commands),
        )
        self.assertFalse(authorization.authorizes_internal_commit)
        self.assertFalse(authorization.authorizes_manufacturing_release)
        self.assertEqual(DesignKernel(DesignGraph(1, PROJECT_ID)).head, original)

    def test_request_retry_uses_explicit_operation_key_and_rejects_rebinding(self) -> None:
        expiry = self.clock.value + timedelta(minutes=10)
        first = self.request(expires_at=expiry)
        self.clock.value += timedelta(seconds=1)
        second = self.request(expires_at=expiry)
        self.assertEqual(first, second)
        with self.assertRaises(ImportApprovalLifecycleError):
            self.request(expires_at=expiry + timedelta(seconds=1))
        with self.assertRaises(ImportApprovalLifecycleError):
            self.request(operation_key="different-operation", expires_at=expiry)

    def test_restart_restores_exact_authorization_and_replay_fences(self) -> None:
        request, approval, authorization = self.authorize()
        self.contract.close()
        self.contract = self.contract_for()
        status = self.contract.get_status(request.request_id)
        self.assertEqual(status.state, ImportApprovalLifecycle.AUTHORIZED)
        self.assertEqual(status.approval, approval)
        self.assertEqual(status.authorization, authorization)
        self.assertEqual(self.validate(authorization), authorization)

    def test_rejection_survives_restart_and_requires_a_new_subject_generation(self) -> None:
        request = self.request()
        alternate = self.request(
            operation_key="parallel-review-before-rejection",
            review_manifest=self.review_manifest(challenge_sha256="a" * 64),
        )
        rejected = self.contract.decide_mapping(
            request,
            principal=self.reviewer,
            decision=MappingDecision.REJECTED,
            expected_lifecycle_generation=0,
            reason="Resolved footprint provenance is unacceptable.",
        )
        self.assertEqual(rejected.decision, MappingDecision.REJECTED)
        self.contract.close()
        self.contract = self.contract_for()
        self.assertEqual(
            self.contract.get_status(request.request_id).state,
            ImportApprovalLifecycle.REJECTED,
        )
        with self.assertRaises(ImportApprovalLifecycleError):
            self.contract.decide_mapping(
                alternate,
                principal=self.reviewer,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )
        self.review = self.review_manifest(challenge_sha256="b" * 64)
        with self.assertRaises(ImportApprovalLifecycleError):
            self.request(operation_key="post-restart-retry")

    def test_late_rejection_revokes_parallel_same_generation_authorization(self) -> None:
        rejecting_request = self.request()
        approved_request = self.request(
            operation_key="parallel-approval-before-rejection",
            review_manifest=self.review_manifest(challenge_sha256="a" * 64),
        )
        _, approval = self.approve(approved_request)
        authorization = self.contract.authorize_staging(
            approval,
            candidate=self.candidate,
            mapping=self.mapping,
            mapping_evidence=self.mapping_evidence,
            context=self.context,
            principal=self.service,
            expected_candidate_generation=self.candidate.generation,
            expected_mapping_evidence_generation=self.mapping_evidence.generation,
            expected_lifecycle_generation=1,
        )
        self.contract.decide_mapping(
            rejecting_request,
            principal=self.reviewer,
            decision=MappingDecision.REJECTED,
            expected_lifecycle_generation=0,
            reason="A competing exact review rejected this evidence generation.",
        )
        with self.assertRaises(ImportApprovalLifecycleError):
            self.validate(authorization)

    def test_invalidation_actor_and_reason_survive_restart(self) -> None:
        request = self.request()
        status = self.contract.invalidate(
            request.request_id,
            principal=self.service,
            reason="The coordination authority changed before staging.",
            expected_lifecycle_generation=0,
        )
        self.assertEqual(status.state, ImportApprovalLifecycle.INVALIDATED)
        self.contract.close()
        self.contract = self.contract_for()
        restored = self.contract.get_status(request.request_id)
        self.assertEqual(restored.invalidated_by, SERVICE)
        self.assertEqual(
            restored.invalidated_principal_sha256,
            self.service.principal_digest,
        )

    def test_ledger_body_tamper_fails_hmac_and_hash_chain_on_restart(self) -> None:
        self.request()
        self.contract.close()
        connection = sqlite3.connect(self.ledger_path)
        try:
            connection.execute("DROP TRIGGER import_approval_events_no_update")
            connection.execute(
                "UPDATE import_approval_ledger_events SET record_json = ? WHERE sequence = 1",
                ("{}",),
            )
            connection.commit()
        finally:
            connection.close()
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()
        self.contract = _ClosedContract()  # type: ignore[assignment]

    def test_live_authority_is_reread_at_decision_and_authorization(self) -> None:
        request = self.request()
        self.authority.snapshot = replace(
            self.snapshot,
            run_revision=self.snapshot.run_revision + 1,
            run_event_head_sha256="9" * 64,
        )
        with self.assertRaises(ImportApprovalStale):
            self.contract.decide_mapping(
                request,
                principal=self.reviewer,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )

        self.authority.snapshot = self.snapshot
        _, approval = self.approve(request)
        self.authority.snapshot = replace(
            self.snapshot,
            target_store_incarnation="project-store-incarnation-2",
        )
        with self.assertRaises(ImportApprovalStale):
            self.contract.authorize_staging(
                approval,
                candidate=self.candidate,
                mapping=self.mapping,
                mapping_evidence=self.mapping_evidence,
                context=self.context,
                principal=self.service,
                expected_candidate_generation=self.candidate.generation,
                expected_mapping_evidence_generation=self.mapping_evidence.generation,
                expected_lifecycle_generation=1,
            )
        self.authority.snapshot = self.snapshot
        authorization = self.contract.authorize_staging(
            approval,
            candidate=self.candidate,
            mapping=self.mapping,
            mapping_evidence=self.mapping_evidence,
            context=self.context,
            principal=self.service,
            expected_candidate_generation=self.candidate.generation,
            expected_mapping_evidence_generation=self.mapping_evidence.generation,
            expected_lifecycle_generation=1,
        )
        self.authority.snapshot = replace(
            self.snapshot,
            coordination_event_head_sha256="b" * 64,
        )
        with self.assertRaises(ImportApprovalStale):
            self.validate(authorization)

    def test_durable_repositories_are_reread_before_human_decision(self) -> None:
        request = self.request()
        self.mapping_evidence_repository.invalidate(
            self.mapping_evidence.mapping_evidence_id,
            expected_generation=self.mapping_evidence.generation,
            actor_id=SERVICE,
            reason="Evidence changed before the reviewer answered.",
        )
        with self.assertRaises(ImportApprovalStale):
            self.contract.decide_mapping(
                request,
                principal=self.reviewer,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )

    def test_role_confusion_untrusted_authority_and_four_eyes_fail_closed(self) -> None:
        same_human_context = self.context_for(
            self.snapshot,
            reviewer=self.uploader,
        )
        with self.assertRaises(ImportApprovalActorMismatch):
            self.request(context=same_human_context)

        request = self.request()
        with self.assertRaises(ImportApprovalActorMismatch):
            self.contract.decide_mapping(
                request,
                principal=self.mapper,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )
        forged = self.principal(
            REVIEWER,
            PrincipalRole.HUMAN_REVIEWER,
            "2",
            authority_id="untrusted-authority",
        )
        with self.assertRaises(ImportApprovalActorMismatch):
            self.contract.decide_mapping(
                request,
                principal=forged,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )

    def test_stale_or_revoked_principal_is_reread_from_trusted_provider(self) -> None:
        request = self.request()
        refreshed = self.principal(
            REVIEWER,
            PrincipalRole.HUMAN_REVIEWER,
            "d",
        )
        self.authority.principals[(REVIEWER, PrincipalRole.HUMAN_REVIEWER)] = refreshed
        with self.assertRaises(ImportApprovalActorMismatch):
            self.contract.decide_mapping(
                request,
                principal=self.reviewer,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )

        del self.authority.principals[(REVIEWER, PrincipalRole.HUMAN_REVIEWER)]
        with self.assertRaises(ImportApprovalActorMismatch):
            self.contract.decide_mapping(
                request,
                principal=self.reviewer,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )

    def test_only_the_request_bound_staging_service_can_invalidate(self) -> None:
        request = self.request()
        other_service = self.principal(
            "other-staging-service",
            PrincipalRole.STAGING_SERVICE,
            "e",
        )
        self.authority.principals[
            (other_service.principal_id, other_service.role)
        ] = other_service
        with self.assertRaises(ImportApprovalActorMismatch):
            self.contract.invalidate(
                request.request_id,
                principal=other_service,
                reason="Attempted cross-service invalidation.",
                expected_lifecycle_generation=0,
            )

    def test_visible_principal_claim_clone_and_subclass_are_not_attestations(self) -> None:
        request = self.request()
        clone = self.principal(REVIEWER, PrincipalRole.HUMAN_REVIEWER, "2")
        with self.assertRaises(ImportApprovalActorMismatch):
            self.contract.decide_mapping(
                request,
                principal=clone,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )

        class PrincipalSubclass(AuthenticatedPrincipal):
            pass

        subclass = PrincipalSubclass(
            principal_id=REVIEWER,
            role=PrincipalRole.HUMAN_REVIEWER,
            authority_id=AUTHORITY_ID,
            authentication_event_sha256="2" * 64,
        )
        with self.assertRaises(ImportApprovalInvariantError):
            self.contract.decide_mapping(
                request,
                principal=subclass,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )

    def test_double_collect_and_final_source_cas_close_freshness_windows(self) -> None:
        def change_on_final_collect(call: int) -> None:
            if call == 3:
                self.authority.snapshot = replace(
                    self.snapshot,
                    run_revision=self.snapshot.run_revision + 1,
                    run_event_head_sha256="d" * 64,
                )

        self.authority.authority_collect_hook = change_on_final_collect
        with self.assertRaises(ImportApprovalStale):
            self.request()
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"].sequence,
            0,
        )

        self.authority.snapshot = self.snapshot
        self.authority.authority_collect_hook = None
        self.authority.authority_collect_count = 0
        self.authority.source_cas_hook = lambda: setattr(
            self.authority,
            "snapshot",
            replace(
                self.snapshot,
                target_store_incarnation="project-store-incarnation-after-cas",
            ),
        )
        with self.assertRaises(ImportApprovalStale):
            self.request(operation_key="source-cas-race")
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"].sequence,
            0,
        )

    def test_idempotent_return_requires_a_final_source_cas(self) -> None:
        first = self.request()
        self.authority.fail_source_cas = True
        with self.assertRaises(ImportApprovalStale):
            self.request(expires_at=first.expires_at)
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"].sequence,
            1,
        )

    def test_invalidation_is_freshness_fenced_after_principal_attestation(self) -> None:
        request = self.request()
        anchor_before = self.anchor_store.anchors[
            "canonical-import-approval-boundary"
        ]

        def rotate_service_principal() -> None:
            self.authority.attest_hook = None
            rotated = self.principal(
                SERVICE,
                PrincipalRole.STAGING_SERVICE,
                "9",
            )
            self.authority.principals[(SERVICE, PrincipalRole.STAGING_SERVICE)] = rotated

        self.authority.attest_hook = rotate_service_principal
        with self.assertRaises(ImportApprovalStale):
            self.contract.invalidate(
                request.request_id,
                principal=self.service,
                reason="Invalidate only under the exact principal authority snapshot.",
                expected_lifecycle_generation=0,
            )
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"],
            anchor_before,
        )

        self.authority.principals[(SERVICE, PrincipalRole.STAGING_SERVICE)] = self.service
        self.authority.fail_source_cas = True
        with self.assertRaises(ImportApprovalStale):
            self.contract.invalidate(
                request.request_id,
                principal=self.service,
                reason="The final source CAS must succeed before invalidation.",
                expected_lifecycle_generation=0,
            )
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"],
            anchor_before,
        )

    def test_rejected_lifecycle_cannot_be_invalidated_or_corrupt_restart(self) -> None:
        request = self.request()
        self.contract.decide_mapping(
            request,
            principal=self.reviewer,
            decision=MappingDecision.REJECTED,
            expected_lifecycle_generation=0,
            reason="Rejected evidence remains a terminal negative decision.",
        )
        with self.assertRaises(ImportApprovalLifecycleError):
            self.contract.invalidate(
                request.request_id,
                principal=self.service,
                reason="Must not rewrite rejection as invalidation.",
                expected_lifecycle_generation=1,
            )
        self.contract.close()
        self.contract = self.contract_for()
        self.assertEqual(
            self.contract.get_status(request.request_id).state,
            ImportApprovalLifecycle.REJECTED,
        )

    def test_cross_request_decision_splice_fails_status_and_restart_replay(self) -> None:
        request_a = self.request(operation_key="splice-request-a")
        request_b = self.request(
            operation_key="splice-request-b",
            review_manifest=self.review_manifest(challenge_sha256="a" * 64),
        )
        approval_b = self.contract.decide_mapping(
            request_b,
            principal=self.reviewer,
            decision=MappingDecision.APPROVED,
            expected_lifecycle_generation=0,
        )
        with self.assertRaises(ImportApprovalInvariantError):
            ImportApprovalStatus(
                request=request_a,
                state=ImportApprovalLifecycle.APPROVED,
                generation=1,
                approval=approval_b,
            )

        seal = self.contract._seal
        self.contract.close()
        splice_path = self.root / "cross-record-splice.sqlite3"
        splice_anchor = InMemoryAnchorStore()
        splice_anchor.provision("canonical-import-approval-boundary")
        ledger = SQLiteApprovalLedger(
            splice_path,
            issuer_id="canonical-import-approval-boundary",
            seal=seal,
            anchor_store=splice_anchor,
        )
        try:
            requested_record = record_json(
                {
                    "version": 1,
                    "request": request_a,
                    "state": ImportApprovalLifecycle.REQUESTED.value,
                    "generation": 0,
                    "approval": None,
                    "authorization": None,
                    "invalidated_by": None,
                    "invalidated_principal_sha256": None,
                    "invalidation_reason": None,
                }
            )
            head = ledger.append(
                expected_head="0" * 64,
                request_id=request_a.request_id,
                subject_digest=request_a.subject_digest,
                operation_key=request_a.operation_key,
                state=ImportApprovalLifecycle.REQUESTED.value,
                generation=0,
                occurred_at=request_a.requested_at,
                record_json=requested_record,
            )
            spliced_record = record_json(
                {
                    "version": 1,
                    "request": request_a,
                    "state": ImportApprovalLifecycle.APPROVED.value,
                    "generation": 1,
                    "approval": approval_b,
                    "authorization": None,
                    "invalidated_by": None,
                    "invalidated_principal_sha256": None,
                    "invalidation_reason": None,
                }
            )
            ledger.append(
                expected_head=head,
                request_id=request_a.request_id,
                subject_digest=request_a.subject_digest,
                operation_key=request_a.operation_key,
                state=ImportApprovalLifecycle.APPROVED.value,
                generation=1,
                occurred_at=approval_b.decided_at,
                record_json=spliced_record,
            )
        finally:
            ledger.close()

        splice_anchor.anchors["canonical-import-approval-boundary"] = (
            ApprovalLedgerAnchor(0, "0" * 64)
        )
        self.ledger_path = splice_path
        self.anchor_store = splice_anchor
        self.contract = _ClosedContract()  # type: ignore[assignment]
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()
        self.assertEqual(
            splice_anchor.anchors["canonical-import-approval-boundary"],
            ApprovalLedgerAnchor(0, "0" * 64),
        )

    def test_restart_replay_rejects_event_time_outside_snapshot_semantics(self) -> None:
        request = self.request(operation_key="event-time-replay")
        seal = self.contract._seal
        self.contract.close()
        replay_path = self.root / "event-time-replay.sqlite3"
        replay_anchor = InMemoryAnchorStore()
        replay_anchor.provision("canonical-import-approval-boundary")
        ledger = SQLiteApprovalLedger(
            replay_path,
            issuer_id="canonical-import-approval-boundary",
            seal=seal,
            anchor_store=replay_anchor,
        )
        try:
            requested_record = record_json(
                {
                    "version": 1,
                    "request": request,
                    "state": ImportApprovalLifecycle.REQUESTED.value,
                    "generation": 0,
                    "approval": None,
                    "authorization": None,
                    "invalidated_by": None,
                    "invalidated_principal_sha256": None,
                    "invalidation_reason": None,
                }
            )
            ledger.append(
                expected_head="0" * 64,
                request_id=request.request_id,
                subject_digest=request.subject_digest,
                operation_key=request.operation_key,
                state=ImportApprovalLifecycle.REQUESTED.value,
                generation=0,
                occurred_at=request.requested_at + timedelta(microseconds=1),
                record_json=requested_record,
            )
        finally:
            ledger.close()

        self.ledger_path = replay_path
        self.anchor_store = replay_anchor
        self.contract = _ClosedContract()  # type: ignore[assignment]
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()

    def test_initialized_database_never_repairs_missing_state_or_schema(self) -> None:
        self.contract.close()
        connection = sqlite3.connect(self.ledger_path)
        try:
            connection.execute("DROP TRIGGER import_approval_state_no_delete")
            connection.execute("DELETE FROM import_approval_ledger_state")
            state_trigger = next(
                statement
                for statement in _SCHEMA_STATEMENTS
                if statement.startswith("CREATE TRIGGER import_approval_state_no_delete")
            )
            connection.execute(state_trigger)
            connection.commit()
        finally:
            connection.close()
        self.contract = _ClosedContract()  # type: ignore[assignment]
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()
        connection = sqlite3.connect(self.ledger_path)
        try:
            count = connection.execute(
                "SELECT COUNT(*) FROM import_approval_ledger_state"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(count, 0)

    def test_dirty_database_and_schema_identity_tamper_never_bootstrap(self) -> None:
        self.contract.close()
        self.ledger_path = self.root / "dirty-approval.sqlite3"
        connection = sqlite3.connect(self.ledger_path)
        try:
            connection.execute("CREATE TABLE attacker_owned (value TEXT)")
            connection.commit()
        finally:
            connection.close()
        self.contract = _ClosedContract()  # type: ignore[assignment]
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()
        connection = sqlite3.connect(self.ledger_path)
        try:
            names = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        finally:
            connection.close()
        self.assertEqual(names, {"attacker_owned"})

    def test_application_id_user_version_and_trigger_fingerprint_are_exact(self) -> None:
        self.contract.close()
        self.contract = _ClosedContract()  # type: ignore[assignment]
        mutations = (
            "PRAGMA application_id = 0",
            "PRAGMA user_version = 99",
            "DROP TRIGGER import_approval_events_no_update",
        )
        for index, mutation in enumerate(mutations):
            with self.subTest(mutation=mutation):
                self.ledger_path = self.root / f"identity-{index}.sqlite3"
                temporary_contract = self.contract_for()
                temporary_contract.close()
                connection = sqlite3.connect(self.ledger_path)
                try:
                    connection.execute(mutation)
                    connection.commit()
                finally:
                    connection.close()
                with self.assertRaises(ImportApprovalIntegrityError):
                    self.contract_for()

    def test_external_anchor_recovers_exact_verified_prefix_but_rejects_other_states(self) -> None:
        request = self.request()
        current = self.anchor_store.anchors["canonical-import-approval-boundary"]
        self.contract.close()
        self.contract = _ClosedContract()  # type: ignore[assignment]
        self.anchor_store.anchors["canonical-import-approval-boundary"] = (
            ApprovalLedgerAnchor(0, "0" * 64)
        )
        recovered = self.contract_for()
        recovered.close()
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"],
            current,
        )
        for anchor in (
            ApprovalLedgerAnchor(current.sequence + 1, "a" * 64),
            ApprovalLedgerAnchor(current.sequence, "b" * 64),
        ):
            with self.subTest(anchor=anchor):
                self.anchor_store.available = True
                self.anchor_store.anchors["canonical-import-approval-boundary"] = anchor
                with self.assertRaises(ImportApprovalIntegrityError):
                    self.contract_for()
        self.anchor_store.anchors["canonical-import-approval-boundary"] = current
        self.anchor_store.available = False
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()
        self.anchor_store.available = True
        del self.anchor_store.anchors["canonical-import-approval-boundary"]
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()
        self.assertTrue(request.request_id.startswith("import-map-request-"))

    def test_external_anchor_detects_whole_database_rollback(self) -> None:
        request = self.request()
        self.contract.close()
        backup = self.root / "approval-backup.sqlite3"
        shutil.copy2(self.ledger_path, backup)
        self.contract = self.contract_for()
        self.contract.decide_mapping(
            request,
            principal=self.reviewer,
            decision=MappingDecision.APPROVED,
            expected_lifecycle_generation=0,
        )
        self.contract.close()
        for suffix in ("-wal", "-shm"):
            Path(f"{self.ledger_path}{suffix}").unlink(missing_ok=True)
        shutil.copy2(backup, self.ledger_path)
        self.contract = _ClosedContract()  # type: ignore[assignment]
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()

    def test_anchor_post_commit_pre_cas_crash_recovers_only_verified_successor(self) -> None:
        self.anchor_store.fail_cas = True
        with self.assertRaises(ImportApprovalIntegrityError):
            self.request()
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract.get_status("import-map-request-" + "0" * 32)
        self.contract.close()
        self.contract = _ClosedContract()  # type: ignore[assignment]
        self.anchor_store.fail_cas = False
        self.contract = self.contract_for()
        recovered = self.request()
        self.assertEqual(
            self.contract.get_status(recovered.request_id).state,
            ImportApprovalLifecycle.REQUESTED,
        )
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"].sequence,
            1,
        )

    def test_anchor_recovery_rejects_tampered_successor_and_cas_conflict(self) -> None:
        self.anchor_store.fail_cas = True
        with self.assertRaises(ImportApprovalIntegrityError):
            self.request()
        self.contract.close()
        connection = sqlite3.connect(self.ledger_path)
        try:
            connection.execute("DROP TRIGGER import_approval_events_no_update")
            connection.execute(
                "UPDATE import_approval_ledger_events SET record_json = '{}' "
                "WHERE sequence = 1"
            )
            connection.commit()
        finally:
            connection.close()
        self.anchor_store.fail_cas = False
        self.contract = _ClosedContract()  # type: ignore[assignment]
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"].sequence,
            0,
        )

        self.ledger_path = self.root / "anchor-conflict.sqlite3"
        self.anchor_store.cas_conflict_anchor = ApprovalLedgerAnchor(1, "f" * 64)
        fresh_contract = self.contract_for()
        try:
            with self.assertRaises(ImportApprovalIntegrityError):
                fresh_contract.request_mapping_approval(
                    candidate=self.candidate,
                    mapping=self.mapping,
                    mapping_evidence=self.mapping_evidence,
                    context=self.context,
                    review_manifest=self.review,
                    operation_key="anchor-conflict-request",
                    expires_at=self.clock.value + timedelta(minutes=10),
                    expected_candidate_generation=self.candidate.generation,
                    expected_mapping_evidence_generation=self.mapping_evidence.generation,
                )
        finally:
            fresh_contract.close()
        self.anchor_store.cas_conflict_anchor = None
        with self.assertRaises(ImportApprovalIntegrityError):
            self.contract_for()

    def test_reload_precedes_clock_sampling_across_concurrent_contracts(self) -> None:
        request = self.request()
        fast_clock = MutableClock()
        fast_clock.value = self.clock.value + timedelta(seconds=10)
        second = self.contract_for(clock=fast_clock)
        try:
            second.decide_mapping(
                request,
                principal=self.reviewer,
                decision=MappingDecision.APPROVED,
                expected_lifecycle_generation=0,
            )
        finally:
            second.close()
        self.clock.value += timedelta(seconds=5)
        with self.assertRaises(ImportApprovalStale):
            self.contract.get_status(request.request_id)

    def test_serialization_and_clock_reject_subclasses_and_noncanonical_utc(self) -> None:
        class TextSubclass(str):
            pass

        with self.assertRaises(ImportApprovalIntegrityError):
            record_json({"value": TextSubclass("attacker-controlled")})
        with self.assertRaises(ImportApprovalIntegrityError):
            decode_record_json(
                TextSubclass(canonical_json({"value": "attacker-controlled"}))
            )

        canonical = "2026-08-29T20:00:00.000000Z"
        decoded = decode_record_json(
            canonical_json({"value": {"$datetime": canonical}})
        )
        self.assertEqual(decoded["value"], self.clock.value)
        for bad in (
            "2026-08-29T20:00:00Z",
            "2026-08-29T20:00:00.000000+00:00",
            "2026-08-29T20:00:00.000000z",
            "2026-08-29T20:00:00.000000Zjunk",
        ):
            with self.subTest(bad=bad):
                source = canonical_json({"value": {"$datetime": bad}})
                with self.assertRaises(ImportApprovalIntegrityError):
                    decode_record_json(source)
                with self.assertRaises(ImportApprovalIntegrityError):
                    SQLiteApprovalLedger._decode_time(bad)

        class DatetimeSubclass(datetime):
            pass

        request = self.request(operation_key="clock-subclass-request")
        anchor_before = self.anchor_store.anchors[
            "canonical-import-approval-boundary"
        ]
        with self.assertRaises(ImportApprovalInvariantError):
            self.contract.get_status(TextSubclass(request.request_id))
        with self.assertRaises(ImportApprovalInvariantError):
            self.contract.invalidate(
                TextSubclass(request.request_id),
                principal=self.service,
                reason="String subclasses are not trusted request identifiers.",
                expected_lifecycle_generation=0,
            )
        self.assertEqual(
            self.anchor_store.anchors["canonical-import-approval-boundary"],
            anchor_before,
        )
        self.contract.close()
        evil_time = DatetimeSubclass(
            2026,
            8,
            29,
            20,
            0,
            tzinfo=UTC,
        )
        self.contract = self.contract_for(clock=lambda: evil_time)
        with self.assertRaises(ImportApprovalInvariantError):
            self.contract.get_status(request.request_id)

    def test_review_manifest_mismatch_and_semantic_rebinding_are_rejected(self) -> None:
        wrong_commands = self.review_manifest(commands_sha256="f" * 64)
        with self.assertRaises(ImportApprovalEvidenceMismatch):
            self.request(review_manifest=wrong_commands)
        semantic = json.loads(self.review.semantic_diff_json)
        semantic["previewDigest"] = "e" * 64
        rebound = self.review_manifest(semantic_diff=semantic)
        with self.assertRaises(ImportApprovalEvidenceMismatch):
            self.request(review_manifest=rebound)

    def test_expiry_crossing_during_repository_checks_fails_closed(self) -> None:
        crossing = MutableClock()
        expiry = crossing.value + timedelta(minutes=1)
        crossing.sequence = [crossing.value, expiry]
        self.contract.close()
        self.ledger_path = self.root / "crossing-ledger.sqlite3"
        self.contract = self.contract_for(clock=crossing)
        with self.assertRaises(ImportApprovalExpired):
            self.request(expires_at=expiry)

    def test_clock_rollback_is_detected_in_process_and_after_restart(self) -> None:
        request = self.request()
        self.clock.value -= timedelta(seconds=1)
        with self.assertRaises(ImportApprovalStale):
            self.contract.get_status(request.request_id)
        self.contract.close()
        self.contract = self.contract_for()
        with self.assertRaises(ImportApprovalStale):
            self.contract.get_status(request.request_id)

    def test_mapping_invalidation_and_unsafe_reconciliation_fail_closed(self) -> None:
        _, approval = self.approve()
        self.mapping_evidence_repository.invalidate(
            self.mapping_evidence.mapping_evidence_id,
            expected_generation=self.mapping_evidence.generation,
            actor_id=SERVICE,
            reason="Mapping authority changed.",
        )
        with self.assertRaises(ImportApprovalStale):
            self.contract.authorize_staging(
                approval,
                candidate=self.candidate,
                mapping=self.mapping,
                mapping_evidence=self.mapping_evidence,
                context=self.context,
                principal=self.service,
                expected_candidate_generation=self.candidate.generation,
                expected_mapping_evidence_generation=self.mapping_evidence.generation,
                expected_lifecycle_generation=1,
            )
        with self.assertRaises(ImportApprovalLifecycleError):
            self.contract.reconcile_staged(None, candidate=self.candidate)  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()

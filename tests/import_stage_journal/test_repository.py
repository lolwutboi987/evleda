from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock

from backend.canonical_import import (
    MappingEvidenceDraft,
    SQLiteMappingEvidenceRepository,
    map_project_import,
)
from backend.design_kernel import DesignGraph, DesignKernel, stable_hash
from backend.import_approval import (
    ApprovalLedgerAnchor,
    ApprovalSourceSnapshot,
    ImportApprovalContext,
    ImportApprovalContract,
    MappingDecision,
)
from backend.import_approval.models import (
    AuthenticatedPrincipal,
    CurrentAuthoritySnapshot,
    PrincipalRole,
    ReviewManifest,
    ReviewQuestionAnswer,
)
from tests.canonical_import.test_evidence_store import pending_candidate
from tests.canonical_import.test_mapper import FixtureResolver, _import, _source

PROJECT_ID = "stage-journal-project"
UPLOADER = "candidate-owner"
HUMAN = "stage-approval-human"
MAPPER = "stage-mapping-service"
SERVICE = "stage-journal-service"
RUN_ID = "mapping-evidence-run"
RUN_REVISION = 4
INCARNATION = "4" * 64
CONTEXT_DIGEST = "c" * 64
ISSUER_KEY = b"stage-journal-test-key-material-at-least-32-bytes"
AUTHORITY_ID = "stage-test-principal-authority"


class AuthorityProvider:
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
        self.candidate_repository = None
        self.mapping_repository = None

    def current_authority(
        self, *, project_id: str, run_id: str
    ) -> CurrentAuthoritySnapshot:
        if project_id != self.snapshot.project_id or run_id != self.snapshot.run_id:
            raise KeyError("unknown authority target")
        return self.snapshot

    def attest_principal(
        self, *, principal: AuthenticatedPrincipal, role: PrincipalRole
    ) -> AuthenticatedPrincipal:
        current = self.principals[(principal.principal_id, role)]
        if current is not principal:
            raise PermissionError("principal object was not provider-issued")
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
            domain="flux-clone-stage-test-principal-authority-snapshot-v1",
        )

    def compare_and_swap_source_snapshot(
        self,
        *,
        expected: ApprovalSourceSnapshot,
        operation_id: str,
    ) -> ApprovalSourceSnapshot:
        if self.candidate_repository is None or self.mapping_repository is None:
            raise RuntimeError("approval source repositories are not configured")
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
            raise RuntimeError("approval source snapshot CAS conflict")
        return current


class InMemoryApprovalAnchorStore:
    def __init__(self) -> None:
        self.anchors: dict[str, ApprovalLedgerAnchor] = {}
        self.lock = Lock()

    def provision(self, issuer_id: str) -> None:
        with self.lock:
            self.anchors[issuer_id] = ApprovalLedgerAnchor(0, "0" * 64)

    def read_anchor(self, *, issuer_id: str) -> ApprovalLedgerAnchor:
        with self.lock:
            return self.anchors[issuer_id]

    def compare_and_swap_anchor(
        self,
        *,
        issuer_id: str,
        expected: ApprovalLedgerAnchor,
        replacement: ApprovalLedgerAnchor,
    ) -> ApprovalLedgerAnchor:
        with self.lock:
            current = self.anchors[issuer_id]
            if current != expected:
                raise RuntimeError("approval ledger anchor CAS conflict")
            self.anchors[issuer_id] = replacement
            return replacement


class MutableClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 8, 29, 21, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.value


class ApprovalFixture:
    def __init__(self, root: Path, clock: MutableClock) -> None:
        self.root = root
        self.clock = clock
        kernel = DesignKernel(DesignGraph(1, PROJECT_ID))
        self.base_revision = kernel.head.revision_hash
        self.mapping = map_project_import(
            _import(exact_stage=True),
            source_payload=_source(exact_stage=True),
            project_id=PROJECT_ID,
            base_revision=self.base_revision,
            transaction_id="stage-journal-transaction",
            actor=MAPPER,
            component_resolver=FixtureResolver(),
        )
        if not self.mapping.stage_eligible or self.mapping.transaction_input is None:
            raise AssertionError("stage journal mapping fixture is unexpectedly blocked")
        self.candidates, pending = pending_candidate(
            root / "candidates.sqlite3", self.mapping, clock=clock
        )
        self.mappings = SQLiteMappingEvidenceRepository(
            root / "mapping.sqlite3", clock=clock
        )
        self.mapping_evidence = self.mappings.create(
            MappingEvidenceDraft.from_mapping(pending, self.mapping)
        )
        self.candidate = self.candidates.resolve(
            pending.candidate_id,
            expected_generation=pending.generation,
            actor_id=HUMAN,
            resolution_receipt_digest=self.mapping_evidence.mapping_evidence_digest,
        )
        self.uploader = AuthenticatedPrincipal(
            principal_id=UPLOADER,
            role=PrincipalRole.HUMAN_REVIEWER,
            authority_id=AUTHORITY_ID,
            authentication_event_sha256="1" * 64,
        )
        self.reviewer = AuthenticatedPrincipal(
            principal_id=HUMAN,
            role=PrincipalRole.HUMAN_REVIEWER,
            authority_id=AUTHORITY_ID,
            authentication_event_sha256="2" * 64,
        )
        self.mapper = AuthenticatedPrincipal(
            principal_id=MAPPER,
            role=PrincipalRole.TRUSTED_MAPPER,
            authority_id=AUTHORITY_ID,
            authentication_event_sha256="3" * 64,
        )
        self.staging_service = AuthenticatedPrincipal(
            principal_id=SERVICE,
            role=PrincipalRole.STAGING_SERVICE,
            authority_id=AUTHORITY_ID,
            authentication_event_sha256="4" * 64,
        )
        self.snapshot = CurrentAuthoritySnapshot(
            project_id=PROJECT_ID,
            project_head_revision=self.base_revision,
            project_event_head_sha256="5" * 64,
            run_id=RUN_ID,
            run_revision=RUN_REVISION,
            run_incarnation="stage-test-run-incarnation",
            run_event_head_sha256="6" * 64,
            coordination_context_digest=CONTEXT_DIGEST,
            coordination_incarnation=INCARNATION,
            coordination_event_head_sha256="7" * 64,
            target_store_id="stage-test-project-store",
            target_store_incarnation="stage-test-store-incarnation",
        )
        self.authority_provider = AuthorityProvider(
            self.snapshot,
            (self.uploader, self.reviewer, self.mapper, self.staging_service),
        )
        self.authority_provider.candidate_repository = self.candidates
        self.authority_provider.mapping_repository = self.mappings
        self.approval_anchor = InMemoryApprovalAnchorStore()
        self.contracts: list[ImportApprovalContract] = []
        self.context = ImportApprovalContext(
            project_id=PROJECT_ID,
            base_revision=self.base_revision,
            prospective_graph_sha256=(
                self.mapping.transaction_input.prospective_graph_sha256
            ),
            run_id=RUN_ID,
            run_revision=RUN_REVISION,
            project_event_head_sha256=self.snapshot.project_event_head_sha256,
            run_incarnation=self.snapshot.run_incarnation,
            run_event_head_sha256=self.snapshot.run_event_head_sha256,
            coordination_incarnation=INCARNATION,
            coordination_context_digest=CONTEXT_DIGEST,
            coordination_event_head_sha256=(
                self.snapshot.coordination_event_head_sha256
            ),
            target_store_id=self.snapshot.target_store_id,
            target_store_incarnation=self.snapshot.target_store_incarnation,
            uploader_principal=self.uploader,
            authorized_human_principal=self.reviewer,
            mapping_command_principal=self.mapper,
            staging_service_principal=self.staging_service,
        )

    def authorization(self, suffix: str = "one"):
        issuer_id = f"stage-approval-boundary-{suffix}"
        self.approval_anchor.provision(issuer_id)
        contract = ImportApprovalContract(
            issuer_id=issuer_id,
            sealing_key=ISSUER_KEY + suffix.encode("ascii"),
            candidate_repository=self.candidates,
            mapping_evidence_repository=self.mappings,
            ledger_path=self.root / f"approval-{suffix}.sqlite3",
            current_authority_provider=self.authority_provider,
            trusted_principal_provider=self.authority_provider,
            source_cas_provider=self.authority_provider,
            ledger_anchor_store=self.approval_anchor,
            principal_authority_id=AUTHORITY_ID,
            clock=self.clock,
        )
        self.contracts.append(contract)
        transaction = self.mapping.transaction_input
        assert transaction is not None
        command_hashes = tuple(command.command_hash for command in transaction.commands)
        review = ReviewManifest.create(
            semantic_diff={
                "projectId": PROJECT_ID,
                "baseRevision": self.base_revision,
                "transactionId": transaction.transaction_id,
                "prospectiveGraphSha256": transaction.prospective_graph_sha256,
                "previewDigest": stable_hash(
                    {
                        "base_revision": self.base_revision,
                        "transaction_id": transaction.transaction_id,
                        "staged_graph_hash": transaction.prospective_graph_sha256,
                        "command_hashes": command_hashes,
                    },
                    domain="flux-clone-preview-v2",
                ),
                "orderedCommandHashes": list(command_hashes),
            },
            commands_sha256=transaction.commands_sha256,
            provenance_set_sha256=self.mapping_evidence.provenance_set_sha256,
            advisories_sha256=stable_hash(
                self.mapping.advisories,
                domain="flux-clone-import-review-advisories-v1",
            ),
            limitations=tuple(
                sorted(
                    {
                        "canonical-stage-only",
                        "deterministic-verification-and-commit-approval-still-required",
                        "kicad-execution-not-run",
                        "manufacturing-release-not-authorized",
                    }
                )
            ),
            questions_and_answers=(
                ReviewQuestionAnswer(
                    question_id="confirm-stage-preview",
                    question="Stage this exact canonical preview?",
                    answer="Approved for isolated staging only.",
                ),
            ),
            challenge_sha256="8" * 64,
        )
        request = contract.request_mapping_approval(
            candidate=self.candidate,
            mapping=self.mapping,
            mapping_evidence=self.mapping_evidence,
            context=self.context,
            review_manifest=review,
            operation_key=f"stage-review-operation-{suffix}",
            expires_at=self.clock.value + timedelta(minutes=10),
            expected_candidate_generation=self.candidate.generation,
            expected_mapping_evidence_generation=self.mapping_evidence.generation,
        )
        approval = contract.decide_mapping(
            request,
            principal=self.reviewer,
            decision=MappingDecision.APPROVED,
            expected_lifecycle_generation=0,
        )
        return contract.authorize_staging(
            approval,
            candidate=self.candidate,
            mapping=self.mapping,
            mapping_evidence=self.mapping_evidence,
            context=self.context,
            principal=self.staging_service,
            expected_candidate_generation=self.candidate.generation,
            expected_mapping_evidence_generation=self.mapping_evidence.generation,
            expected_lifecycle_generation=1,
        )

    def close(self) -> None:
        for contract in self.contracts:
            contract.close()
        self.mappings.close()
        self.candidates.close()

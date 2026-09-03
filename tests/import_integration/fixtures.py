"""Exact fixtures and scripted read adapters for import-integration tests."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

from backend.canonical_import import (
    CanonicalMappingEvidence,
    ImportMappingResult,
    MappingEvidenceDraft,
    MappingEvidenceEvent,
    SQLiteMappingEvidenceRepository,
    map_project_import,
)
from backend.import_approval import CurrentAuthoritySnapshot
from backend.import_integration import (
    CurrentAuthorityProvider,
    DeterministicImportRemapper,
    HostOwnedArtifactReader,
    ResolvedCandidateReader,
    ResolvedImportSubjectLoader,
    ResolvedImportSubjectRequestIssuer,
    ResolvedMappingReader,
)
from backend.interchange_artifacts import (
    ArtifactContent,
    ArtifactKind,
    ArtifactRecord,
    ArtifactSource,
    QuarantineStatus,
)
from backend.kicad_import_candidates import (
    CandidateTransitionEvent,
    ImportCandidate,
    SQLiteImportCandidateRepository,
)
from backend.kicad_project import (
    ProjectBundleInput,
    ProjectImportResult,
    UnsupportedPolicy,
    import_project_bundle,
)
from tests.canonical_import.test_evidence_store import (
    pending_candidate,  # pyright: ignore[reportUnknownVariableType]
    successful_mapping,
)
from tests.canonical_import.test_mapper import FixtureResolver

_FIXTURES = Path(__file__).parents[1] / "fixtures"
_PROJECT_FIXTURES = _FIXTURES / "kicad_project"
_BOARD_FIXTURES = _FIXTURES / "kicad"


def _exact_source() -> ProjectBundleInput:
    board_payload = (_BOARD_FIXTURES / "supported_board.kicad_pcb").read_bytes()
    board_text = board_payload.decode("utf-8")
    board_text = board_text.replace("    (attr smd)\n", "")
    board_text = board_text.replace("    (attr through_hole)\n", "")
    board_text = board_text.replace("smd roundrect", "smd rect")
    board_text = board_text.replace("      (roundrect_rratio 0.25)\n", "")
    board_text = board_text.replace(
        '(layers "F.Cu" "F.Paste" "F.Mask")',
        '(layers "F.Cu")',
    )
    board_text = board_text.replace(
        '(layers "*.Cu" "*.Mask")',
        '(layers "*.Cu")',
    )
    return ProjectBundleInput(
        "supported_project",
        (_PROJECT_FIXTURES / "supported_project.kicad_pro").read_bytes(),
        (_PROJECT_FIXTURES / "supported_project.kicad_sch").read_bytes(),
        board_text.encode("utf-8"),
    )


def _exact_import() -> ProjectImportResult:
    return import_project_bundle(
        _exact_source(),
        unsupported_policy=UnsupportedPolicy.REJECT,
    )


class ScriptedArtifactReader:
    def __init__(self, content: ArtifactContent) -> None:
        self.content = content
        self.outputs: list[object] = []
        self.calls: list[tuple[str, str, str, ArtifactKind]] = []

    def read_exact(
        self,
        *,
        project_id: str,
        artifact_id: str,
        artifact_sha256: str,
        artifact_kind: ArtifactKind,
    ) -> ArtifactContent:
        self.calls.append((project_id, artifact_id, artifact_sha256, artifact_kind))
        value: object = self.outputs.pop(0) if self.outputs else self.content
        if isinstance(value, BaseException):
            raise value
        return cast(ArtifactContent, value)


class ScriptedCandidateReader:
    def __init__(self, repository: SQLiteImportCandidateRepository) -> None:
        self.repository = repository
        self.get_outputs: list[object] = []
        self.event_outputs: list[object] = []
        self.get_calls = 0
        self.event_calls = 0

    def get(self, candidate_id: str) -> ImportCandidate:
        self.get_calls += 1
        value: object = (
            self.get_outputs.pop(0) if self.get_outputs else self.repository.get(candidate_id)
        )
        if isinstance(value, BaseException):
            raise value
        return cast(ImportCandidate, value)

    def list_events(self, candidate_id: str) -> tuple[CandidateTransitionEvent, ...]:
        self.event_calls += 1
        value: object = (
            self.event_outputs.pop(0)
            if self.event_outputs
            else self.repository.list_events(candidate_id)
        )
        if isinstance(value, BaseException):
            raise value
        return cast(tuple[CandidateTransitionEvent, ...], value)


class ScriptedMappingReader:
    def __init__(self, repository: SQLiteMappingEvidenceRepository) -> None:
        self.repository = repository
        self.get_outputs: list[object] = []
        self.list_outputs: list[object] = []
        self.event_outputs: list[object] = []
        self.get_calls = 0
        self.list_calls = 0
        self.event_calls = 0

    def get(self, mapping_evidence_id: str) -> CanonicalMappingEvidence:
        self.get_calls += 1
        value: object = (
            self.get_outputs.pop(0)
            if self.get_outputs
            else self.repository.get(mapping_evidence_id)
        )
        if isinstance(value, BaseException):
            raise value
        return cast(CanonicalMappingEvidence, value)

    def list_for_candidate(self, import_candidate_id: str) -> tuple[CanonicalMappingEvidence, ...]:
        self.list_calls += 1
        value: object = (
            self.list_outputs.pop(0)
            if self.list_outputs
            else self.repository.list_for_candidate(import_candidate_id)
        )
        if isinstance(value, BaseException):
            raise value
        return cast(tuple[CanonicalMappingEvidence, ...], value)

    def list_events(self, mapping_evidence_id: str) -> tuple[MappingEvidenceEvent, ...]:
        self.event_calls += 1
        value: object = (
            self.event_outputs.pop(0)
            if self.event_outputs
            else self.repository.list_events(mapping_evidence_id)
        )
        if isinstance(value, BaseException):
            raise value
        return cast(tuple[MappingEvidenceEvent, ...], value)


RemapHook = Callable[
    [ArtifactContent, ImportCandidate, CurrentAuthoritySnapshot],
    None,
]


class ScriptedRemapper:
    def __init__(self, result: ImportMappingResult) -> None:
        self.result: object = result
        self.hook: RemapHook | None = None
        self.calls: list[tuple[ArtifactContent, ImportCandidate, CurrentAuthoritySnapshot]] = []

    def remap(
        self,
        *,
        artifact: ArtifactContent,
        candidate: ImportCandidate,
        authority: CurrentAuthoritySnapshot,
    ) -> ImportMappingResult:
        self.calls.append((artifact, candidate, authority))
        if self.hook is not None:
            self.hook(artifact, candidate, authority)
        value = self.result
        if isinstance(value, BaseException):
            raise value
        return cast(ImportMappingResult, value)


class ScriptedAuthorityProvider:
    def __init__(self, authority: CurrentAuthoritySnapshot) -> None:
        self.authority = authority
        self.outputs: list[object] = []
        self.calls: list[tuple[str, str]] = []

    def current_authority(
        self,
        *,
        project_id: str,
        run_id: str,
    ) -> CurrentAuthoritySnapshot:
        self.calls.append((project_id, run_id))
        value: object = self.outputs.pop(0) if self.outputs else self.authority
        if isinstance(value, BaseException):
            raise value
        return cast(CurrentAuthoritySnapshot, value)


class LoaderFixture:
    def __init__(self) -> None:
        self.temporary: TemporaryDirectory[str] = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.candidate_database = self.root / "candidates.sqlite3"
        self.mapping_database = self.root / "mapping.sqlite3"
        self.mapping = successful_mapping()
        (
            self.candidate_store,
            self.pending_candidate,
        ) = pending_candidate(  # pyright: ignore[reportUnknownVariableType]
            self.candidate_database,
            self.mapping,
        )
        self.mapping_store = SQLiteMappingEvidenceRepository(self.mapping_database)
        self.mapping_evidence = self.mapping_store.create(
            MappingEvidenceDraft.from_mapping(
                self.pending_candidate,
                self.mapping,
            )
        )
        self.candidate = self.candidate_store.resolve(
            self.pending_candidate.candidate_id,
            expected_generation=self.pending_candidate.generation,
            actor_id=self.mapping.authorized_actor,
            resolution_receipt_digest=(self.mapping_evidence.mapping_evidence_digest),
        )
        self.authority = CurrentAuthoritySnapshot(
            project_id=self.candidate.project_id,
            project_head_revision=self.candidate.expected_project_revision,
            project_event_head_sha256="a" * 64,
            run_id=self.candidate.run_id,
            run_revision=self.candidate.expected_run_revision,
            run_incarnation="fixture-run-incarnation",
            run_event_head_sha256="b" * 64,
            coordination_context_digest=(self.mapping_evidence.coordination_context_digest),
            coordination_incarnation="fixture-coordination-incarnation",
            coordination_event_head_sha256="d" * 64,
            target_store_id="fixture-project-store",
            target_store_incarnation="fixture-store-incarnation",
        )
        payload = b"managed-project-bundle"
        self.artifact = ArtifactContent(
            ArtifactRecord(
                artifact_id=self.candidate.artifact_id,
                kind=ArtifactKind.KICAD_PROJECT_BUNDLE,
                media_type="application/zip",
                size_bytes=len(payload),
                sha256=self.candidate.artifact_sha256,
                quarantine_status=QuarantineStatus.STORED_UNINSPECTED,
                actor_id=self.candidate.created_by,
                source=ArtifactSource.USER_UPLOAD,
                idempotency_key="fixture-artifact-upload",
                created_at=datetime(2026, 8, 29, 19, 0, tzinfo=UTC),
            ),
            payload,
        )
        self.issuer = ResolvedImportSubjectRequestIssuer(
            issuer_id="fixture-request-issuer",
            issuer_incarnation="fixture-request-incarnation",
        )
        self.request = self.issuer.issue(
            candidate=self.candidate,
            mapping_evidence=self.mapping_evidence,
            authority=self.authority,
        )
        self.artifact_reader = ScriptedArtifactReader(self.artifact)
        self.candidate_reader = ScriptedCandidateReader(self.candidate_store)
        self.mapping_reader = ScriptedMappingReader(self.mapping_store)
        self.remapper = ScriptedRemapper(self.mapping)
        self.authority_provider = ScriptedAuthorityProvider(self.authority)

    def loader(
        self,
        *,
        request_issuer: ResolvedImportSubjectRequestIssuer | None = None,
        artifact_reader: HostOwnedArtifactReader | None = None,
        candidate_repository: ResolvedCandidateReader | None = None,
        mapping_repository: ResolvedMappingReader | None = None,
        remapper: DeterministicImportRemapper | None = None,
        authority_provider: CurrentAuthorityProvider | None = None,
    ) -> ResolvedImportSubjectLoader:
        return ResolvedImportSubjectLoader(
            request_issuer=request_issuer or self.issuer,
            artifact_reader=artifact_reader or self.artifact_reader,
            candidate_repository=(candidate_repository or self.candidate_reader),
            mapping_repository=mapping_repository or self.mapping_reader,
            remapper=remapper or self.remapper,
            authority_provider=(authority_provider or self.authority_provider),
        )

    def alternate_mapping(
        self,
        *,
        transaction_id: str = "alternate-import-transaction",
        actor: str | None = None,
    ) -> ImportMappingResult:
        return map_project_import(
            _exact_import(),
            source_payload=_exact_source(),
            project_id=self.candidate.project_id,
            base_revision=self.candidate.expected_project_revision,
            transaction_id=transaction_id,
            actor=actor or self.mapping.authorized_actor,
            component_resolver=FixtureResolver(),
        )

    def restart_durable_readers(self) -> None:
        """Close and reopen both durable repositories without changing evidence."""

        self.mapping_store.close()
        self.candidate_store.close()
        self.candidate_store = SQLiteImportCandidateRepository(self.candidate_database)
        self.mapping_store = SQLiteMappingEvidenceRepository(self.mapping_database)
        self.candidate = self.candidate_store.get(self.candidate.candidate_id)
        self.mapping_evidence = self.mapping_store.get(self.mapping_evidence.mapping_evidence_id)
        self.candidate_reader = ScriptedCandidateReader(self.candidate_store)
        self.mapping_reader = ScriptedMappingReader(self.mapping_store)

    def close(self) -> None:
        self.mapping_store.close()
        self.candidate_store.close()
        self.temporary.cleanup()


__all__ = (
    "LoaderFixture",
    "ScriptedArtifactReader",
    "ScriptedAuthorityProvider",
    "ScriptedCandidateReader",
    "ScriptedMappingReader",
    "ScriptedRemapper",
)

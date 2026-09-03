from __future__ import annotations

# pyright: reportPrivateUsage=false
import hashlib
import inspect
import json
import sqlite3
import unittest
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import fields, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from typing import cast

from backend.canonical_import import (
    IllegalMappingEvidenceTransition,
    ImportMappingInvariantError,
    ImportMappingResult,
    InvalidMappingEvidence,
    MappingEvidenceConcurrencyConflict,
    MappingEvidenceDraft,
    MappingEvidenceIntegrityError,
    MappingEvidenceState,
    SQLiteMappingEvidenceRepository,
    UnsupportedMappingEvidenceStoreSchema,
    map_project_import,
)
from backend.canonical_import.model import _mint_mapper_seal
from backend.design_kernel import DesignCommand, DesignGraph, DesignKernel, stable_hash
from backend.interchange_artifacts import ArtifactKind
from backend.kicad_import_candidates import (
    CandidateState,
    ImportCandidate,
    ImportCandidateDraft,
    SQLiteImportCandidateRepository,
    canonical_json,
)
from backend.kicad_project import (
    BundleImportEvidence,
    ProjectAuxiliaryFile,
    ProjectBundleInput,
    import_project_bundle,
)

from .test_mapper import FixtureResolver, _source

_TIME = datetime(2026, 8, 29, 19, 0, tzinfo=UTC)
_RECEIPT_DOMAIN = b"flux-clone-kicad-inspection-receipt-v1\0"


class AdvancingClock:
    def __init__(self) -> None:
        self.value = _TIME

    def __call__(self) -> datetime:
        current = self.value
        self.value += timedelta(microseconds=1)
        return current


def successful_mapping(
    *, source_payload: ProjectBundleInput | None = None
) -> ImportMappingResult:
    source_payload = source_payload or _source(exact_stage=True)
    imported = import_project_bundle(source_payload)
    project_id = "mapping-evidence-project"
    kernel = DesignKernel(DesignGraph(1, project_id))
    result = map_project_import(
        imported,
        source_payload=source_payload,
        project_id=project_id,
        base_revision=kernel.head.revision_hash,
        transaction_id="transaction-mapping-evidence",
        actor="trusted-import-boundary",
        component_resolver=FixtureResolver(),
    )
    assert result.candidate is not None
    assert result.transaction_input is not None
    return result


def auxiliary_source() -> ProjectBundleInput:
    table = (
        b'(lib (name "FluxGenerated")(type "KiCad")(uri "URI")'
        b'(options "")(descr ""))'
    )
    files = (
        ProjectAuxiliaryFile(
            "FluxGenerated.kicad_sym",
            "application/octet-stream",
            b'(kicad_symbol_lib (version 20240529)(generator "flux_clone")'
            b'(generator_version "10.0"))',
        ),
        ProjectAuxiliaryFile(
            "FluxGenerated.pretty/fp_one.kicad_mod",
            "application/octet-stream",
            b'(footprint "fp_one" (version 20240108)(generator "flux_clone")'
            b'(generator_version "10.0")(layer "F.Cu")'
            b'(pad "1" smd rect (at 0 0)(size 1 1)(layers "F.Cu")'
            b'(uuid "00000000-0000-4000-8000-000000000001")))',
        ),
        ProjectAuxiliaryFile(
            "fp-lib-table",
            "application/octet-stream",
            b'(fp_lib_table (version 7)'
            + table.replace(b"URI", b"${KIPRJMOD}/FluxGenerated.pretty")
            + b")",
        ),
        ProjectAuxiliaryFile(
            "sym-lib-table",
            "application/octet-stream",
            b'(sym_lib_table (version 7)'
            + table.replace(b"URI", b"${KIPRJMOD}/FluxGenerated.kicad_sym")
            + b")",
        ),
    )
    return replace(
        _source(exact_stage=True),
        auxiliary_files=tuple(
            sorted(
                files,
                key=lambda item: (
                    item.relative_name.casefold(),
                    item.relative_name,
                ),
            )
        ),
    )


def legacy_source_import_evidence_payload(
    evidence: BundleImportEvidence,
) -> dict[str, object]:
    return {
        "board_ir_sha256": evidence.board_ir_sha256,
        "board_source_sha256": evidence.board_source_sha256,
        "bundle_ir_sha256": evidence.bundle_ir_sha256,
        "diagnostics_manifest_sha256": evidence.diagnostics_manifest_sha256,
        "kicad_execution": evidence.kicad_execution,
        "manufacturing_release_eligible": evidence.manufacturing_release_eligible,
        "parser_id": evidence.parser_id,
        "project_ir_sha256": evidence.project_ir_sha256,
        "project_source_sha256": evidence.project_source_sha256,
        "schematic_ir_sha256": evidence.schematic_ir_sha256,
        "schematic_source_sha256": evidence.schematic_source_sha256,
    }


def legacy_source_import_evidence_sha256(evidence: BundleImportEvidence) -> str:
    return stable_hash(
        legacy_source_import_evidence_payload(evidence),
        domain="flux-clone-kicad-project-import-evidence-v1",
    )


def legacy_source_evidence_draft(
    draft: MappingEvidenceDraft,
) -> MappingEvidenceDraft:
    source_evidence_sha256 = legacy_source_import_evidence_sha256(
        draft.source_import_evidence
    )
    mapper_candidate_sha256 = stable_hash(
        {
            "project_id": draft.project_id,
            "base_revision": draft.canonical_base_revision,
            "authorized_actor": draft.authorized_actor,
            "source_bundle_ir_sha256": draft.source_bundle_ir_sha256,
            "source_import_evidence_sha256": source_evidence_sha256,
            "diagnostics_manifest_sha256": draft.diagnostics_manifest_sha256,
            "graph_sha256": draft.canonical_graph_sha256,
            "provenance_set_sha256": draft.provenance_set_sha256,
            "kicad_execution": draft.kicad_execution,
            "manufacturing_release_eligible": draft.manufacturing_release_eligible,
        },
        domain="flux-clone-canonical-import-candidate-v1",
    )
    mapper_result_sha256 = stable_hash(
        {
            "source_bundle_ir_sha256": draft.source_bundle_ir_sha256,
            "authorized_actor": draft.authorized_actor,
            "candidate_sha256": mapper_candidate_sha256,
            "transaction_commands_sha256": draft.transaction_commands_sha256,
            "blockers": (),
            "advisories": draft.mapping_advisories,
            "kicad_execution": draft.kicad_execution,
            "manufacturing_release_eligible": draft.manufacturing_release_eligible,
        },
        domain="flux-clone-canonical-import-mapping-result-v1",
    )
    return replace(
        draft,
        source_import_evidence_sha256=source_evidence_sha256,
        mapper_candidate_sha256=mapper_candidate_sha256,
        mapper_result_sha256=mapper_result_sha256,
        mapper_issuance_seal=_mint_mapper_seal(mapper_result_sha256),
    )


def pending_candidate(
    database: Path,
    mapping_result: ImportMappingResult,
    *,
    clock: Callable[[], datetime] | None = None,
) -> tuple[SQLiteImportCandidateRepository, ImportCandidate]:
    mapped = mapping_result.candidate
    assert mapped is not None
    source_artifact_id = "artifact_" + "1" * 32
    source_artifact_sha256 = hashlib.sha256(b"managed-project-bundle").hexdigest()
    context_digest = "c" * 64
    evidence = mapped.source_import_evidence
    inspection_payload = {
        "canonicalImportBlockers": ["canonical graph mapping has not run"],
        "canonicalImportEligible": False,
        "coordinationContextDigest": context_digest,
        "counts": {"footprints": len(mapped.source_bundle.board.footprints)},
        "diagnostics": [],
        "evidence": {
            "boardImportedIrSha256": evidence.board_ir_sha256,
            "boardExportSha256": "1" * 64,
            "boardSemanticParity": True,
            "boardSourceSha256": evidence.board_source_sha256,
            "bundleImportedIrSha256": evidence.bundle_ir_sha256,
            "bundleReparsedIrSha256": evidence.bundle_ir_sha256,
            "diagnosticsManifestSha256": evidence.diagnostics_manifest_sha256,
            "diagnosticsParity": True,
            "evidenceSha256": "2" * 64,
            "kicadExecution": "not-run",
            "manufacturingReleaseEligible": False,
            "parserId": evidence.parser_id,
            "projectImportedIrSha256": evidence.project_ir_sha256,
            "projectExportSha256": "3" * 64,
            "projectSemanticParity": True,
            "projectSourceSha256": evidence.project_source_sha256,
            "schematicImportedIrSha256": evidence.schematic_ir_sha256,
            "schematicExportSha256": "4" * 64,
            "schematicSemanticParity": True,
            "schematicSourceSha256": evidence.schematic_source_sha256,
            "semanticParity": True,
            "sourceSha256": source_artifact_sha256,
        },
        "expectedProjectRevision": mapped.base_revision,
        "format": {
            "kind": ArtifactKind.KICAD_PROJECT_BUNDLE.value,
            "stem": mapped.source_bundle.stem,
        },
        "kicadExecution": "not-run",
        "manufacturingReleaseEligible": False,
        "mode": "inspection-only",
        "mutatesDesign": False,
        "outlineVerticesNm": [],
        "projectId": mapped.project_id,
        "projectRevision": mapped.base_revision,
        "runId": "mapping-evidence-run",
        "runRevision": 4,
        "source": {
            "artifactId": source_artifact_id,
            "kind": ArtifactKind.KICAD_PROJECT_BUNDLE.value,
            "sha256": source_artifact_sha256,
            "sizeBytes": 4096,
        },
        "stageEligible": False,
        "truth": {
            "canonicalMapping": "blocked",
            "codecParse": "passed",
            "diagnosticsRoundTrip": "passed",
            "downloadEligible": False,
            "engineAgreement": "not-evaluated",
            "kicadChecks": "not-run",
            "kicadExecution": "not-run",
            "manufacturingReleaseEligible": False,
            "nativeChecks": "not-run",
            "semanticRoundTrip": "passed",
        },
    }
    inspection_json = canonical_json(inspection_payload)
    inspection_sha256 = hashlib.sha256(inspection_json.encode("utf-8")).hexdigest()
    receipt_material = {
        "artifact_id": source_artifact_id,
        "inspection_payload_sha256": inspection_sha256,
        "project_id": mapped.project_id,
        "project_revision": mapped.base_revision,
        "run_id": "mapping-evidence-run",
        "run_revision": 4,
        "source_sha256": source_artifact_sha256,
    }
    receipt_digest = hashlib.sha256(
        _RECEIPT_DOMAIN + canonical_json(receipt_material).encode("utf-8")
    ).hexdigest()
    managed_inspection = {
        **inspection_payload,
        "inspectionPayloadSha256": inspection_sha256,
        "inspectionReceiptDigest": receipt_digest,
        "inspectionReceiptId": f"inspection_{receipt_digest[:32]}",
    }
    draft = ImportCandidateDraft.from_managed_inspection(
        artifact_id=source_artifact_id,
        artifact_sha256=source_artifact_sha256,
        artifact_kind=ArtifactKind.KICAD_PROJECT_BUNDLE,
        project_id=mapped.project_id,
        expected_project_revision=mapped.base_revision,
        run_id="mapping-evidence-run",
        expected_run_revision=4,
        managed_inspection=managed_inspection,
        created_by="candidate-owner",
    )
    repository = SQLiteImportCandidateRepository(
        database, clock=clock or AdvancingClock()
    )
    return repository, repository.create(draft)


def rebound_binding(binding, request, graph):
    component = next(
        item for item in graph.components if item.component_id == binding.component_id
    )
    evidence_sha256 = stable_hash(
        {
            "request_sha256": request.request_sha256,
            "evidence_id": binding.component_evidence_id,
            "resolver_id": binding.resolver_id,
            "trust_snapshot_sha256": binding.trust_snapshot_sha256,
            "component": component,
        },
        domain="flux-clone-trusted-component-resolution-v1",
    )
    return replace(
        binding,
        request=request,
        request_sha256=request.request_sha256,
        evidence_sha256=evidence_sha256,
    )


def replace_with_rehashed_provenance(draft, bindings):
    provenance_set_sha256 = stable_hash(
        bindings,
        domain="flux-clone-component-provenance-set-v1",
    )
    mapper_candidate_sha256 = stable_hash(
        {
            "project_id": draft.project_id,
            "base_revision": draft.canonical_base_revision,
            "authorized_actor": draft.authorized_actor,
            "source_bundle_ir_sha256": draft.source_bundle_ir_sha256,
            "source_import_evidence_sha256": draft.source_import_evidence_sha256,
            "diagnostics_manifest_sha256": draft.diagnostics_manifest_sha256,
            "graph_sha256": draft.canonical_graph_sha256,
            "provenance_set_sha256": provenance_set_sha256,
            "kicad_execution": draft.kicad_execution,
            "manufacturing_release_eligible": draft.manufacturing_release_eligible,
        },
        domain="flux-clone-canonical-import-candidate-v1",
    )
    mapper_result_sha256 = stable_hash(
        {
            "source_bundle_ir_sha256": draft.source_bundle_ir_sha256,
            "authorized_actor": draft.authorized_actor,
            "candidate_sha256": mapper_candidate_sha256,
            "transaction_commands_sha256": draft.transaction_commands_sha256,
            "blockers": (),
            "advisories": draft.mapping_advisories,
            "kicad_execution": draft.kicad_execution,
            "manufacturing_release_eligible": draft.manufacturing_release_eligible,
        },
        domain="flux-clone-canonical-import-mapping-result-v1",
    )
    return replace(
        draft,
        provenance_bindings=bindings,
        provenance_set_sha256=provenance_set_sha256,
        mapper_candidate_sha256=mapper_candidate_sha256,
        mapper_result_sha256=mapper_result_sha256,
    )


class MappingEvidenceStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "mapping-evidence.sqlite3"
        self.mapping = successful_mapping()
        self.candidate_repository, self.candidate = pending_candidate(
            self.root / "candidates.sqlite3", self.mapping
        )
        self.draft = MappingEvidenceDraft.from_mapping(
            self.candidate, self.mapping
        )

    def tearDown(self) -> None:
        self.candidate_repository.close()
        self.temporary.cleanup()

    def repository(
        self,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> SQLiteMappingEvidenceRepository:
        return SQLiteMappingEvidenceRepository(
            self.database,
            clock=clock or AdvancingClock(),
        )

    def test_draft_binds_candidate_source_context_graph_resolver_and_mapper(self) -> None:
        mapped = self.mapping.candidate
        assert mapped is not None
        self.assertEqual(self.candidate.candidate_id, self.draft.import_candidate_id)
        self.assertEqual(
            self.candidate.candidate_digest, self.draft.import_candidate_digest
        )
        self.assertEqual(CandidateState.PENDING, self.draft.import_candidate_state)
        self.assertEqual(
            self.candidate.last_event_digest,
            self.draft.import_candidate_last_event_digest,
        )
        self.assertEqual(self.candidate.artifact_id, self.draft.source_artifact_id)
        self.assertEqual("c" * 64, self.draft.coordination_context_digest)
        self.assertEqual(mapped.graph, self.draft.canonical_graph)
        self.assertEqual(mapped.graph_sha256, self.draft.canonical_graph_sha256)
        self.assertEqual(mapped.provenance_bindings, self.draft.provenance_bindings)
        self.assertEqual(self.mapping.mapping_sha256, self.draft.mapper_result_sha256)
        assert self.mapping.transaction_input is not None
        self.assertEqual(
            self.mapping.transaction_input.transaction_id,
            self.draft.transaction_id,
        )
        self.assertEqual(
            tuple(
                command.command_hash
                for command in self.mapping.transaction_input.commands
            ),
            self.draft.transaction_command_hashes,
        )
        self.assertEqual(
            self.mapping.transaction_input.commands_sha256,
            self.draft.transaction_commands_sha256,
        )
        self.assertTrue(self.candidate.blockers)
        self.assertFalse(self.draft.staging_authorized)
        self.assertFalse(self.draft.manufacturing_release_eligible)

        with self.assertRaises(InvalidMappingEvidence):
            replace(self.draft, mapper_result_sha256="f" * 64)
        with self.assertRaises(InvalidMappingEvidence):
            replace(self.draft, provenance_set_sha256="e" * 64)

        resolved = self.candidate_repository.resolve(
            self.candidate.candidate_id,
            expected_generation=0,
            actor_id="candidate-reviewer",
            resolution_receipt_digest="d" * 64,
        )
        with self.assertRaises(InvalidMappingEvidence):
            MappingEvidenceDraft.from_mapping(resolved, self.mapping)

    def test_mapping_identity_cannot_collapse_or_append_a_repeated_physical_pad(self) -> None:
        graph = self.draft.canonical_graph
        source_pad = graph.pads[0]
        repeated_pad = replace(
            source_pad,
            pad_id="pad-repeated-physical",
            center=replace(
                source_pad.center,
                x=source_pad.center.x + 3_000_000,
            ),
        )
        expanded = replace(graph, pads=graph.pads + (repeated_pad,)).normalized()
        self.assertEqual(
            sum(
                pad.pad_number == source_pad.pad_number
                and pad.component_id == source_pad.component_id
                for pad in expanded.pads
            ),
            2,
        )
        self.assertNotEqual(expanded.graph_hash, graph.graph_hash)
        with self.assertRaisesRegex(
            InvalidMappingEvidence,
            "digest|commands|mapper|replay",
        ):
            replace(
                self.draft,
                canonical_graph=expanded,
                canonical_graph_sha256=expanded.graph_hash,
            )

    def test_shifted_geometry_cannot_reuse_or_recompute_mapper_authority(self) -> None:
        mapped = self.mapping.candidate
        transaction = self.mapping.transaction_input
        assert mapped is not None
        assert transaction is not None
        placement = mapped.graph.placements[0]
        shifted_placement = replace(
            placement,
            position=replace(
                placement.position,
                x=placement.position.x + 1_000_000,
            ),
        )
        shifted_graph = replace(
            mapped.graph,
            placements=(shifted_placement, *mapped.graph.placements[1:]),
        ).normalized()
        shifted_candidate = replace(
            mapped,
            graph=shifted_graph,
            graph_sha256=shifted_graph.graph_hash,
        )
        shifted_commands = []
        for command in transaction.commands:
            if (
                command.kind.value == "footprint.place"
                and command.payload["component_id"] == placement.component_id
            ):
                payload = dict(command.payload)
                payload["x_nm"] = int(payload["x_nm"]) + 1_000_000
                command = DesignCommand.create(
                    command_id=command.command_id,
                    base_revision=command.base_revision,
                    transaction_id=command.transaction_id,
                    actor=command.actor,
                    kind=command.kind,
                    payload=payload,
                    idempotency_key=command.idempotency_key,
                )
            shifted_commands.append(command)
        shifted_commands_tuple = tuple(shifted_commands)
        shifted_commands_sha256 = stable_hash(
            tuple(command.command_hash for command in shifted_commands_tuple),
            domain="flux-clone-canonical-import-commands-v1",
        )
        shifted_transaction = replace(
            transaction,
            candidate_sha256=shifted_candidate.candidate_sha256,
            prospective_graph_sha256=shifted_graph.graph_hash,
            commands=shifted_commands_tuple,
            commands_sha256=shifted_commands_sha256,
        )

        # Every public digest and command body is self-consistent, including a
        # full replay to the shifted graph, but the genuine mapper seal remains
        # bound to the original result and cannot be reused.
        with self.assertRaisesRegex(
            ImportMappingInvariantError,
            "deterministic mapper boundary",
        ):
            replace(
                self.mapping,
                candidate=shifted_candidate,
                transaction_input=shifted_transaction,
            )

        forged_result_sha256 = stable_hash(
            {
                "source_bundle_ir_sha256": self.draft.source_bundle_ir_sha256,
                "authorized_actor": self.draft.authorized_actor,
                "candidate_sha256": shifted_candidate.candidate_sha256,
                "transaction_commands_sha256": shifted_commands_sha256,
                "blockers": (),
                "advisories": self.draft.mapping_advisories,
                "kicad_execution": "not-run",
                "manufacturing_release_eligible": False,
            },
            domain="flux-clone-canonical-import-mapping-result-v1",
        )
        with self.assertRaisesRegex(InvalidMappingEvidence, "sealed mapper"):
            replace(
                self.draft,
                canonical_graph=shifted_graph,
                canonical_graph_sha256=shifted_graph.graph_hash,
                mapper_candidate_sha256=shifted_candidate.candidate_sha256,
                mapper_result_sha256=forged_result_sha256,
                transaction_commands=shifted_commands_tuple,
                transaction_command_hashes=tuple(
                    command.command_hash for command in shifted_commands_tuple
                ),
                transaction_commands_sha256=shifted_commands_sha256,
            )

    def test_restart_restores_exact_graph_and_provenance_with_root_event(self) -> None:
        with self.repository() as repository:
            created = repository.create(self.draft)
            retried = repository.create(self.draft)
            self.assertEqual(created, retried)
            self.assertEqual((created,), repository.list_for_candidate(self.candidate.candidate_id))
            with self.assertRaisesRegex(
                InvalidMappingEvidence,
                "deterministic mapper issuance",
            ):
                repository.create(created.draft())

        with self.repository() as restarted:
            restored = restarted.get(created.mapping_evidence_id)
            self.assertEqual(created, restored)
            self.assertEqual(self.draft.canonical_graph, restored.canonical_graph)
            self.assertEqual(self.draft.provenance_bindings, restored.provenance_bindings)
            self.assertEqual(self.draft.transaction_id, restored.transaction_id)
            self.assertEqual(
                self.draft.transaction_command_hashes,
                restored.transaction_command_hashes,
            )
            self.assertEqual(
                self.draft.transaction_commands,
                restored.transaction_commands,
            )
            transaction = self.mapping.transaction_input
            assert transaction is not None
            preview_kernel = DesignKernel(DesignGraph(1, restored.project_id))
            preview_kernel.begin_transaction(
                restored.transaction_id,
                base_revision=restored.canonical_base_revision,
            )
            staged = preview_kernel.stage_batch(transaction.commands)
            projected_preview_digest = stable_hash(
                {
                    "base_revision": restored.canonical_base_revision,
                    "transaction_id": restored.transaction_id,
                    "staged_graph_hash": restored.canonical_graph_sha256,
                    "command_hashes": restored.transaction_command_hashes,
                },
                domain="flux-clone-preview-v2",
            )
            self.assertEqual(staged.preview_digest, projected_preview_digest)
            self.assertEqual((restored,), restarted.list_for_project(restored.project_id))
            events = restarted.list_events(restored.mapping_evidence_id)
            self.assertEqual(1, len(events))
            self.assertEqual(restored.mapping_evidence_digest, events[0].mapping_evidence_digest)
            self.assertEqual(restored.authorized_actor, events[0].actor_id)

    def test_restart_preserves_nonempty_auxiliary_source_manifest_exactly(self) -> None:
        source = auxiliary_source()
        mapping = successful_mapping(source_payload=source)
        candidate_repository, candidate = pending_candidate(
            self.root / "auxiliary-candidates.sqlite3",
            mapping,
        )
        try:
            draft = MappingEvidenceDraft.from_mapping(candidate, mapping)
            self.assertEqual(
                source.auxiliary_manifest_sha256,
                draft.source_import_evidence.auxiliary_source_manifest_sha256,
            )
            with SQLiteMappingEvidenceRepository(
                self.root / "auxiliary-evidence.sqlite3",
                clock=AdvancingClock(),
            ) as repository:
                created = repository.create(draft)
            with SQLiteMappingEvidenceRepository(
                self.root / "auxiliary-evidence.sqlite3",
                clock=AdvancingClock(),
            ) as restarted:
                restored = restarted.get(created.mapping_evidence_id)
            self.assertEqual(draft.source_import_evidence, restored.source_import_evidence)
            self.assertEqual(
                source.auxiliary_manifest_sha256,
                restored.source_import_evidence.auxiliary_source_manifest_sha256,
            )

            legacy_digest = legacy_source_import_evidence_sha256(
                draft.source_import_evidence
            )
            with self.assertRaisesRegex(
                InvalidMappingEvidence,
                "source import evidence digest does not match its exact body",
            ):
                replace(
                    draft,
                    source_import_evidence_sha256=legacy_digest,
                )
        finally:
            candidate_repository.close()

    def test_restart_accepts_exact_legacy_omission_as_empty_manifest_only(self) -> None:
        legacy_draft = legacy_source_evidence_draft(self.draft)
        with self.repository() as repository:
            created = repository.create(legacy_draft)

        connection = sqlite3.connect(self.database)
        try:
            trigger_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
                "AND name = 'canonical_mapping_evidence_identity_immutable'"
            ).fetchone()[0]
            connection.execute(
                "DROP TRIGGER canonical_mapping_evidence_identity_immutable"
            )
            connection.execute(
                "UPDATE canonical_mapping_evidence "
                "SET source_import_evidence_json = ? "
                "WHERE mapping_evidence_id = ?",
                (
                    canonical_json(
                        legacy_source_import_evidence_payload(
                            self.draft.source_import_evidence
                        )
                    ),
                    created.mapping_evidence_id,
                ),
            )
            connection.execute(trigger_sql)
            connection.commit()
        finally:
            connection.close()

        with self.repository() as restarted:
            restored = restarted.get(created.mapping_evidence_id)
        self.assertEqual(created.mapping_evidence_id, restored.mapping_evidence_id)
        self.assertEqual(
            legacy_draft.source_import_evidence_sha256,
            restored.source_import_evidence_sha256,
        )
        self.assertEqual(
            self.draft.source_import_evidence.auxiliary_source_manifest_sha256,
            restored.source_import_evidence.auxiliary_source_manifest_sha256,
        )

    def test_persisted_auxiliary_manifest_field_rejects_malformed_and_extra_data(
        self,
    ) -> None:
        def malformed(payload: dict[str, object]) -> None:
            payload["auxiliary_source_manifest_sha256"] = "A" * 64

        def extra(payload: dict[str, object]) -> None:
            payload["unexpected_auxiliary_fact"] = "forged"

        def digest_mismatch(payload: dict[str, object]) -> None:
            payload["auxiliary_source_manifest_sha256"] = "f" * 64

        cases: tuple[
            tuple[str, Callable[[dict[str, object]], None], str],
            ...,
        ] = (
            (
                "malformed",
                malformed,
                "source-import evidence is malformed",
            ),
            (
                "extra",
                extra,
                "source-import evidence fields are not exact",
            ),
            (
                "digest-mismatch",
                digest_mismatch,
                "canonical mapping evidence is malformed",
            ),
        )
        for label, mutate, expected_error in cases:
            with self.subTest(case=label):
                database = self.root / f"auxiliary-{label}-tamper.sqlite3"
                with SQLiteMappingEvidenceRepository(
                    database,
                    clock=AdvancingClock(),
                ) as repository:
                    created = repository.create(self.draft)

                connection = sqlite3.connect(database)
                try:
                    trigger_sql = connection.execute(
                        "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
                        "AND name = 'canonical_mapping_evidence_identity_immutable'"
                    ).fetchone()[0]
                    source_json = connection.execute(
                        "SELECT source_import_evidence_json "
                        "FROM canonical_mapping_evidence "
                        "WHERE mapping_evidence_id = ?",
                        (created.mapping_evidence_id,),
                    ).fetchone()[0]
                    payload = cast(dict[str, object], json.loads(source_json))
                    mutate(payload)
                    connection.execute(
                        "DROP TRIGGER canonical_mapping_evidence_identity_immutable"
                    )
                    connection.execute(
                        "UPDATE canonical_mapping_evidence "
                        "SET source_import_evidence_json = ? "
                        "WHERE mapping_evidence_id = ?",
                        (canonical_json(payload), created.mapping_evidence_id),
                    )
                    connection.execute(trigger_sql)
                    connection.commit()
                finally:
                    connection.close()

                with SQLiteMappingEvidenceRepository(
                    database,
                    clock=AdvancingClock(),
                ) as restarted, self.assertRaisesRegex(
                    MappingEvidenceIntegrityError,
                    expected_error,
                ):
                    restarted.get(created.mapping_evidence_id)

    def test_invalidation_is_terminal_generation_cas_and_replays_after_restart(self) -> None:
        first = self.repository(clock=AdvancingClock())
        second = self.repository(clock=AdvancingClock())
        try:
            active = first.create(self.draft)
            stale = second.get(active.mapping_evidence_id)
            invalidated = first.invalidate(
                active.mapping_evidence_id,
                expected_generation=active.generation,
                actor_id="context-monitor",
                reason="Project or coordination context changed.",
            )
            self.assertEqual(MappingEvidenceState.INVALIDATED, invalidated.state)
            self.assertEqual(1, invalidated.generation)
            self.assertFalse(invalidated.is_active)
            self.assertEqual(invalidated.is_active, invalidated.is_current)
            with self.assertRaises(MappingEvidenceConcurrencyConflict):
                second.invalidate(
                    stale.mapping_evidence_id,
                    expected_generation=stale.generation,
                    actor_id="stale-writer",
                    reason="A stale writer must fail closed.",
                )
            with self.assertRaises(IllegalMappingEvidenceTransition):
                first.invalidate(
                    invalidated.mapping_evidence_id,
                    expected_generation=invalidated.generation,
                    actor_id="context-monitor",
                    reason="Terminal evidence cannot transition twice.",
                )
        finally:
            first.close()
            second.close()

        with self.repository() as restarted:
            restored = restarted.get(invalidated.mapping_evidence_id)
            events = restarted.list_events(restored.mapping_evidence_id)
            self.assertEqual(2, len(events))
            self.assertEqual(events[0].event_digest, events[1].previous_event_digest)
            self.assertEqual(restored.last_event_digest, events[1].event_digest)
            self.assertEqual(restored.invalidation_reason, events[1].reason)

    def test_database_guards_and_event_replay_fail_closed_on_tamper(self) -> None:
        with self.repository() as repository:
            evidence = repository.create(self.draft)

        connection = sqlite3.connect(self.database)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE canonical_mapping_evidence "
                    "SET canonical_graph_sha256 = ? WHERE mapping_evidence_id = ?",
                    ("f" * 64, evidence.mapping_evidence_id),
                )
            connection.rollback()
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "DELETE FROM canonical_mapping_evidence_events "
                    "WHERE mapping_evidence_id = ?",
                    (evidence.mapping_evidence_id,),
                )
            connection.rollback()
            connection.execute(
                "UPDATE canonical_mapping_evidence "
                "SET state = 'invalidated', generation = 1, "
                "invalidation_reason = ? WHERE mapping_evidence_id = ?",
                ("Forged lifecycle state.", evidence.mapping_evidence_id),
            )
            connection.commit()
        finally:
            connection.close()

        with self.repository() as restarted, self.assertRaises(
            MappingEvidenceIntegrityError
        ):
            restarted.get(evidence.mapping_evidence_id)

    def test_restore_recomputes_every_immutable_evidence_body_after_tamper(self) -> None:
        def alter_json(source: str, path: tuple[object, ...], value: object) -> str:
            payload = json.loads(source)
            target = payload
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            return canonical_json(payload)

        cases = (
            (
                "mapper_result_sha256",
                lambda _: "f" * 64,
            ),
            (
                "transaction_id",
                lambda _: "transaction-forged",
            ),
            (
                "transaction_command_hashes_json",
                lambda source: canonical_json(list(reversed(json.loads(source)))),
            ),
            (
                "transaction_commands_json",
                lambda source: alter_json(
                    source,
                    (0, "payload_json"),
                    canonical_json({"vertices": [[0, 0], [1, 1], [2, 2]]}),
                ),
            ),
            (
                "canonical_graph_json",
                lambda source: alter_json(source, ("project_id",), "attacker-project"),
            ),
            (
                "provenance_bindings_json",
                lambda source: alter_json(
                    source, (0, "trust_snapshot_sha256"), "e" * 64
                ),
            ),
            (
                "source_import_evidence_json",
                lambda source: alter_json(source, ("parser_id",), "attacker-parser"),
            ),
            (
                "mapping_advisories_json",
                lambda source: canonical_json(
                    [
                        *json.loads(source),
                        {
                            "code": "forged-advisory",
                            "detail": "This advisory was not emitted by the mapper.",
                            "entity_id": "project-bundle",
                        },
                    ]
                ),
            ),
        )
        for field_name, replacement in cases:
            with self.subTest(field=field_name):
                database = self.root / f"identity-tamper-{field_name}.sqlite3"
                with SQLiteMappingEvidenceRepository(
                    database, clock=AdvancingClock()
                ) as repository:
                    evidence = repository.create(self.draft)

                connection = sqlite3.connect(database)
                try:
                    trigger_sql = connection.execute(
                        "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
                        "AND name = 'canonical_mapping_evidence_identity_immutable'"
                    ).fetchone()[0]
                    original = connection.execute(
                        f"SELECT {field_name} FROM canonical_mapping_evidence "
                        "WHERE mapping_evidence_id = ?",
                        (evidence.mapping_evidence_id,),
                    ).fetchone()[0]
                    connection.execute(
                        "DROP TRIGGER canonical_mapping_evidence_identity_immutable"
                    )
                    connection.execute(
                        f"UPDATE canonical_mapping_evidence SET {field_name} = ? "
                        "WHERE mapping_evidence_id = ?",
                        (replacement(original), evidence.mapping_evidence_id),
                    )
                    connection.execute(trigger_sql)
                    connection.commit()
                finally:
                    connection.close()

                with SQLiteMappingEvidenceRepository(
                    database, clock=AdvancingClock()
                ) as restarted, self.assertRaises(MappingEvidenceIntegrityError):
                    restarted.get(evidence.mapping_evidence_id)

    def test_recomputed_provenance_hashes_cannot_hide_named_net_or_symbol_aliasing(
        self,
    ) -> None:
        first = self.draft.provenance_bindings[0]
        first_pin = first.request.pins[0]
        changed_net_name = None if first_pin.net_name is not None else "forged-net"
        forged_pin = replace(first_pin, net_name=changed_net_name)
        forged_request = replace(
            first.request,
            pins=(forged_pin, *first.request.pins[1:]),
        )
        forged_binding = rebound_binding(
            first,
            forged_request,
            self.draft.canonical_graph,
        )
        named_net_bindings = (
            forged_binding,
            *self.draft.provenance_bindings[1:],
        )
        with self.assertRaisesRegex(
            InvalidMappingEvidence,
            "named-net facts disagree",
        ):
            replace_with_rehashed_provenance(self.draft, named_net_bindings)

        self.assertGreaterEqual(len(self.draft.provenance_bindings), 2)
        first_symbol_id = first.request.schematic_symbol_instance_id
        second = self.draft.provenance_bindings[1]
        duplicate_request = replace(
            second.request,
            schematic_symbol_instance_id=first_symbol_id,
        )
        duplicate_binding = rebound_binding(
            second,
            duplicate_request,
            self.draft.canonical_graph,
        )
        duplicate_symbol_bindings = (
            first,
            duplicate_binding,
            *self.draft.provenance_bindings[2:],
        )
        with self.assertRaisesRegex(
            InvalidMappingEvidence,
            "schematic symbol instance IDs must be unique",
        ):
            replace_with_rehashed_provenance(
                self.draft,
                duplicate_symbol_bindings,
            )

    def test_schema_creation_is_atomic_after_failure_and_safe_on_concurrent_open(
        self,
    ) -> None:
        interrupted_database = self.root / "interrupted-schema.sqlite3"

        class InterruptedSchemaRepository(SQLiteMappingEvidenceRepository):
            def _create_schema(self) -> None:
                self._connection.execute(
                    "CREATE TABLE interrupted_partial(value TEXT) STRICT"
                )
                raise RuntimeError("injected schema creation failure")

        with self.assertRaisesRegex(RuntimeError, "injected schema"):
            InterruptedSchemaRepository(interrupted_database)

        connection = sqlite3.connect(interrupted_database)
        try:
            tables = connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
            self.assertEqual([], tables)
            self.assertEqual(0, connection.execute("PRAGMA user_version").fetchone()[0])
            self.assertEqual(0, connection.execute("PRAGMA application_id").fetchone()[0])
        finally:
            connection.close()

        with SQLiteMappingEvidenceRepository(interrupted_database) as recovered:
            created = recovered.create(self.draft)
            self.assertEqual(self.draft.mapping_evidence_id, created.mapping_evidence_id)

        concurrent_database = self.root / "concurrent-schema.sqlite3"
        barrier = Barrier(2)

        def open_repository() -> str:
            barrier.wait(timeout=5)
            with SQLiteMappingEvidenceRepository(concurrent_database) as repository:
                return repository.create(self.draft).mapping_evidence_id

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = tuple(executor.map(lambda _: open_repository(), range(2)))
        self.assertEqual(
            (self.draft.mapping_evidence_id, self.draft.mapping_evidence_id),
            results,
        )

    def test_v1_upgrade_requires_source_reresolution_for_existing_rows(self) -> None:
        empty_database = self.root / "empty-v1.sqlite3"
        with SQLiteMappingEvidenceRepository(empty_database):
            pass
        connection = sqlite3.connect(empty_database)
        try:
            connection.execute(
                "UPDATE mapping_evidence_repository_meta SET schema_version = 1"
            )
            connection.execute("PRAGMA user_version = 1")
            connection.commit()
        finally:
            connection.close()
        with SQLiteMappingEvidenceRepository(empty_database):
            pass
        connection = sqlite3.connect(empty_database)
        try:
            self.assertEqual(
                3,
                connection.execute("PRAGMA user_version").fetchone()[0],
            )
            columns = {
                row[1]
                for row in connection.execute(
                    "PRAGMA table_info(canonical_mapping_evidence)"
                )
            }
            self.assertIn("transaction_commands_json", columns)
        finally:
            connection.close()

        populated_database = self.root / "populated-v1.sqlite3"
        with SQLiteMappingEvidenceRepository(populated_database) as repository:
            repository.create(self.draft)
        connection = sqlite3.connect(populated_database)
        try:
            connection.execute(
                "UPDATE mapping_evidence_repository_meta SET schema_version = 1"
            )
            connection.execute("PRAGMA user_version = 1")
            connection.commit()
        finally:
            connection.close()
        with self.assertRaisesRegex(
            UnsupportedMappingEvidenceStoreSchema,
            "source re-resolution",
        ):
            SQLiteMappingEvidenceRepository(populated_database)

    def test_v2_geometry_evidence_requires_source_reresolution_when_populated(self) -> None:
        empty_database = self.root / "empty-v2.sqlite3"
        with SQLiteMappingEvidenceRepository(empty_database):
            pass
        connection = sqlite3.connect(empty_database)
        try:
            connection.execute(
                "UPDATE mapping_evidence_repository_meta SET schema_version = 2"
            )
            connection.execute("PRAGMA user_version = 2")
            connection.commit()
        finally:
            connection.close()
        with SQLiteMappingEvidenceRepository(empty_database):
            pass
        connection = sqlite3.connect(empty_database)
        try:
            self.assertEqual(
                3,
                connection.execute("PRAGMA user_version").fetchone()[0],
            )
        finally:
            connection.close()

        populated_database = self.root / "populated-v2.sqlite3"
        with SQLiteMappingEvidenceRepository(populated_database) as repository:
            repository.create(self.draft)
        connection = sqlite3.connect(populated_database)
        try:
            connection.execute(
                "UPDATE mapping_evidence_repository_meta SET schema_version = 2"
            )
            connection.execute("PRAGMA user_version = 2")
            connection.commit()
        finally:
            connection.close()
        with self.assertRaisesRegex(
            UnsupportedMappingEvidenceStoreSchema,
            "source re-resolution",
        ):
            SQLiteMappingEvidenceRepository(populated_database)

    def test_public_store_has_no_approval_staging_commit_or_release_authority(self) -> None:
        methods = {
            name.casefold()
            for name, member in inspect.getmembers(
                SQLiteMappingEvidenceRepository, inspect.isfunction
            )
            if not name.startswith("_")
        }
        self.assertFalse(
            any(
                token in method
                for method in methods
                for token in ("approve", "stage", "commit", "release")
            )
        )
        state_values = {item.value for item in MappingEvidenceState}
        self.assertEqual({"active", "invalidated"}, state_values)
        record_fields = {field.name for field in fields(type(self.draft))}
        self.assertNotIn("approval", record_fields)
        self.assertNotIn("stage_receipt_digest", record_fields)


if __name__ == "__main__":
    unittest.main()

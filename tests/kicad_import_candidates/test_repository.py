from __future__ import annotations

import hashlib
import inspect
import json
import sqlite3
import tempfile
import unittest
from dataclasses import fields, replace
from datetime import datetime, timezone
from pathlib import Path

from backend.design_kernel import DesignGraph, DesignKernel
from backend.kicad_import_candidates import (
    STORE_SCHEMA_VERSION,
    ArtifactKind,
    CandidateBlocker,
    CandidateConcurrencyConflict,
    CandidateDiagnostic,
    CandidateEventKind,
    CandidateIdentityScheme,
    CandidateIntegrityError,
    CandidateState,
    DiagnosticSeverity,
    IllegalCandidateTransition,
    ImportCandidate,
    ImportCandidateDraft,
    InvalidCandidate,
    SQLiteImportCandidateRepository,
    UnsupportedCandidateStoreSchema,
    canonical_json,
)

_TIME = datetime(2026, 8, 29, 12, 0, tzinfo=timezone.utc)


def downgrade_candidate_table_to_v2(connection: sqlite3.Connection) -> None:
    """Rebuild the candidate table with the actual nullable v2 shape."""

    connection.execute("PRAGMA foreign_keys = OFF")
    connection.executescript(
        """
        DROP TRIGGER import_candidates_identity_immutable;
        DROP TRIGGER import_candidates_no_delete;
        CREATE TABLE import_candidates_v2 (
            candidate_id TEXT PRIMARY KEY,
            candidate_digest TEXT NOT NULL UNIQUE,
            artifact_id TEXT NOT NULL,
            artifact_sha256 TEXT NOT NULL,
            artifact_kind TEXT NOT NULL
                CHECK (artifact_kind IN ('kicad_pcb','kicad_project_bundle')),
            project_id TEXT NOT NULL,
            expected_project_revision TEXT,
            run_id TEXT NOT NULL,
            expected_run_revision INTEGER NOT NULL
                CHECK (expected_run_revision >= 0),
            inspection_payload_json TEXT NOT NULL,
            inspection_payload_digest TEXT NOT NULL,
            inspection_receipt_digest TEXT NOT NULL,
            diagnostics_json TEXT NOT NULL,
            diagnostics_digest TEXT NOT NULL,
            blockers_json TEXT NOT NULL,
            blockers_digest TEXT NOT NULL,
            created_by TEXT NOT NULL,
            state TEXT NOT NULL
                CHECK (state IN (
                    'pending','resolved','staged','rejected','invalidated'
                )),
            generation INTEGER NOT NULL CHECK (generation >= 0),
            resolution_receipt_digest TEXT,
            stage_receipt_digest TEXT,
            terminal_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_event_digest TEXT NOT NULL
        ) STRICT;
        INSERT INTO import_candidates_v2 (
            candidate_id, candidate_digest, artifact_id, artifact_sha256,
            artifact_kind, project_id, expected_project_revision, run_id,
            expected_run_revision, inspection_payload_json,
            inspection_payload_digest, inspection_receipt_digest,
            diagnostics_json, diagnostics_digest, blockers_json,
            blockers_digest, created_by, state, generation,
            resolution_receipt_digest, stage_receipt_digest, terminal_reason,
            created_at, updated_at, last_event_digest
        )
        SELECT candidate_id, candidate_digest, artifact_id, artifact_sha256,
            artifact_kind, project_id, expected_project_revision, run_id,
            expected_run_revision, inspection_payload_json,
            inspection_payload_digest, inspection_receipt_digest,
            diagnostics_json, diagnostics_digest, blockers_json,
            blockers_digest, created_by, state, generation,
            resolution_receipt_digest, stage_receipt_digest, terminal_reason,
            created_at, updated_at, last_event_digest
        FROM import_candidates;
        DROP TABLE import_candidates;
        ALTER TABLE import_candidates_v2 RENAME TO import_candidates;
        CREATE INDEX import_candidates_project_order
            ON import_candidates(project_id, created_at, candidate_id);
        """
    )
    connection.execute("PRAGMA foreign_keys = ON")


def managed_inspection() -> dict[str, object]:
    receipt_payload: dict[str, object] = {
        "mode": "inspection-only",
        "mutatesDesign": False,
        "projectRevision": "3" * 64,
        "kicadExecution": "not-run",
        "manufacturingReleaseEligible": False,
        "canonicalImportEligible": False,
        "canonicalImportBlockers": ["canonical graph mapping has not run"],
        "coordinationContextDigest": "c" * 64,
        "truth": {
            "codecParse": "passed",
            "semanticRoundTrip": "passed",
            "diagnosticsRoundTrip": "passed",
            "canonicalMapping": "blocked",
            "nativeChecks": "not-run",
            "kicadExecution": "not-run",
            "kicadChecks": "not-run",
            "engineAgreement": "not-evaluated",
            "downloadEligible": False,
            "manufacturingReleaseEligible": False,
        },
        "format": {"kind": "kicad_pcb", "version": 20240108},
        "counts": {"footprints": 1},
        "outlineVerticesNm": [],
        "diagnostics": [
            {
                "scope": "board",
                "path": "board[0]",
                "head": "future_construct",
                "disposition": "unsupported",
                "reason": "The construct requires explicit resolution.",
                "constructSha256": "4" * 64,
            }
        ],
        "evidence": {
            "diagnosticsParity": True,
            "evidenceSha256": "9" * 64,
            "exportedSha256": "8" * 64,
            "importedIrSha256": "5" * 64,
            "importedManifestSha256": "4" * 64,
            "reparsedIrSha256": "5" * 64,
            "reparsedManifestSha256": "4" * 64,
            "semanticParity": True,
            "sourceSha256": "2" * 64,
        },
        "projectId": "project-candidate",
        "expectedProjectRevision": "3" * 64,
        "runId": "run-candidate",
        "runRevision": 7,
        "source": {
            "artifactId": "artifact_" + "1" * 32,
            "kind": "kicad_pcb",
            "sizeBytes": 1024,
            "sha256": "2" * 64,
        },
        "stageEligible": False,
    }
    payload_sha256 = hashlib.sha256(
        canonical_json(receipt_payload).encode("utf-8")
    ).hexdigest()
    receipt_material = {
        "artifact_id": "artifact_" + "1" * 32,
        "inspection_payload_sha256": payload_sha256,
        "project_id": "project-candidate",
        "project_revision": "3" * 64,
        "run_id": "run-candidate",
        "run_revision": 7,
        "source_sha256": "2" * 64,
    }
    receipt_digest = hashlib.sha256(
        b"flux-clone-kicad-inspection-receipt-v1\0"
        + canonical_json(receipt_material).encode("utf-8")
    ).hexdigest()
    return {
        **receipt_payload,
        "inspectionReceiptId": f"inspection_{receipt_digest[:32]}",
        "inspectionReceiptDigest": receipt_digest,
        "inspectionPayloadSha256": payload_sha256,
    }


def rebound_managed_inspection(
    inspection: dict[str, object],
) -> dict[str, object]:
    receipt_payload = {
        key: value
        for key, value in inspection.items()
        if key
        not in {
            "inspectionPayloadSha256",
            "inspectionReceiptDigest",
            "inspectionReceiptId",
        }
    }
    payload_sha256 = hashlib.sha256(
        canonical_json(receipt_payload).encode("utf-8")
    ).hexdigest()
    source = receipt_payload["source"]
    assert isinstance(source, dict)
    receipt_material = {
        "artifact_id": source["artifactId"],
        "inspection_payload_sha256": payload_sha256,
        "project_id": receipt_payload["projectId"],
        "project_revision": receipt_payload["expectedProjectRevision"],
        "run_id": receipt_payload["runId"],
        "run_revision": receipt_payload["runRevision"],
        "source_sha256": source["sha256"],
    }
    receipt_digest = hashlib.sha256(
        b"flux-clone-kicad-inspection-receipt-v1\0"
        + canonical_json(receipt_material).encode("utf-8")
    ).hexdigest()
    return {
        **receipt_payload,
        "inspectionPayloadSha256": payload_sha256,
        "inspectionReceiptDigest": receipt_digest,
        "inspectionReceiptId": f"inspection_{receipt_digest[:32]}",
    }


def draft(**changes: object) -> ImportCandidateDraft:
    values: dict[str, object] = {
        "artifact_id": "artifact_" + "1" * 32,
        "artifact_sha256": "2" * 64,
        "artifact_kind": ArtifactKind.KICAD_PCB,
        "project_id": "project-candidate",
        "expected_project_revision": "3" * 64,
        "run_id": "run-candidate",
        "expected_run_revision": 7,
        "inspection_payload": {
            "codecEvidence": {
                "diagnosticsManifestSha256": "4" * 64,
                "kicadExecution": "not-run",
                "normalizedIrSha256": "5" * 64,
            },
            "mapping": {"graphSha256": None, "stageEligible": False},
            "source": {
                "artifactId": "artifact_" + "1" * 32,
                "sha256": "2" * 64,
            },
            "truth": {
                "kicadExecution": "not-run",
                "manufacturingReleaseEligible": False,
            },
        },
        "inspection_receipt_digest": "6" * 64,
        "diagnostics": (
            CandidateDiagnostic(
                "diagnostic-1",
                "pcb-only-schematic-parity-unproven",
                DiagnosticSeverity.BLOCKER,
                "board",
                "The PCB file cannot prove schematic parity.",
                "7" * 64,
                "board",
            ),
        ),
        "blockers": (
            CandidateBlocker(
                "blocker-1",
                "component-provenance-required",
                "U1 needs an exact component-evidence binding.",
                "8" * 64,
                ("U1",),
            ),
        ),
        "created_by": "user-candidate",
    }
    values.update(changes)
    return ImportCandidateDraft.from_payload(**values)  # type: ignore[arg-type]


def managed_draft(
    inspection: dict[str, object] | None = None,
    **changes: object,
) -> ImportCandidateDraft:
    base = draft()
    values: dict[str, object] = {
        "artifact_id": base.artifact_id,
        "artifact_sha256": base.artifact_sha256,
        "artifact_kind": base.artifact_kind,
        "project_id": base.project_id,
        "expected_project_revision": base.expected_project_revision,
        "run_id": base.run_id,
        "expected_run_revision": base.expected_run_revision,
        "managed_inspection": (
            inspection if inspection is not None else managed_inspection()
        ),
        "created_by": base.created_by,
    }
    values.update(changes)
    return ImportCandidateDraft.from_managed_inspection(  # type: ignore[arg-type]
        **values
    )


class ImportCandidateRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Path(self.temporary.name) / "candidates.sqlite3"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def repository(self) -> SQLiteImportCandidateRepository:
        return SQLiteImportCandidateRepository(self.database, clock=lambda: _TIME)

    def test_identity_binds_every_normative_inspection_subject(self) -> None:
        original = draft()
        replacements = (
            replace(original, artifact_id="artifact_" + "9" * 32),
            replace(original, artifact_sha256="9" * 64),
            replace(original, artifact_kind=ArtifactKind.KICAD_PROJECT_BUNDLE),
            replace(original, project_id="project-other"),
            replace(original, expected_project_revision="9" * 64),
            replace(original, run_id="run-other"),
            replace(original, expected_run_revision=8),
            replace(
                original,
                inspection_payload_json=canonical_json({"inspection": "different"}),
            ),
            replace(original, inspection_receipt_digest="9" * 64),
            replace(original, diagnostics=()),
            replace(original, blockers=()),
        )
        for changed in replacements:
            with self.subTest(changed=changed):
                self.assertNotEqual(original.candidate_digest, changed.candidate_digest)
                self.assertNotEqual(original.candidate_id, changed.candidate_id)

    def test_create_is_idempotent_and_restores_complete_inspection(self) -> None:
        candidate_draft = draft()
        with self.repository() as repository:
            created = repository.create(candidate_draft)
            retried = repository.create(candidate_draft)
            self.assertEqual(created, retried)
            self.assertEqual(created.state, CandidateState.PENDING)
            self.assertEqual(created.generation, 0)
            self.assertEqual(
                created.decoded_inspection_payload(),
                json.loads(candidate_draft.inspection_payload_json),
            )
            self.assertEqual(created.diagnostics, candidate_draft.diagnostics)
            self.assertEqual(created.blockers, candidate_draft.blockers)

        with self.repository() as restarted:
            restored = restarted.get(candidate_draft.candidate_id)
            self.assertEqual(restored, created)
            events = restarted.list_events(restored.candidate_id)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].kind, CandidateEventKind.CREATED)
            self.assertEqual(events[0].receipt_digest, "6" * 64)

    def test_managed_inspection_factory_binds_receipt_and_survives_restart(self) -> None:
        inspection = managed_inspection()
        candidate_draft = managed_draft(inspection)
        self.assertEqual(
            candidate_draft.inspection_payload_digest,
            inspection["inspectionPayloadSha256"],
        )
        self.assertEqual(
            candidate_draft.inspection_payload_sha256,
            inspection["inspectionPayloadSha256"],
        )
        self.assertEqual(
            candidate_draft.inspection_receipt_digest,
            inspection["inspectionReceiptDigest"],
        )
        self.assertEqual(len(candidate_draft.diagnostics), 1)
        self.assertEqual(
            candidate_draft.diagnostics[0].severity,
            DiagnosticSeverity.BLOCKER,
        )
        self.assertEqual(len(candidate_draft.blockers), 1)
        factory_parameters = inspect.signature(
            ImportCandidateDraft.from_managed_inspection
        ).parameters
        self.assertNotIn("diagnostics", factory_parameters)
        self.assertNotIn("blockers", factory_parameters)
        with self.repository() as repository:
            created = repository.create(candidate_draft)
            self.assertNotIn(
                "inspectionReceiptDigest",
                created.decoded_inspection_payload(),
            )

        with self.repository() as restarted:
            restored = restarted.get(candidate_draft.candidate_id)
            resolved = restarted.resolve(
                restored.candidate_id,
                expected_generation=0,
                actor_id="user-resolver",
                resolution_receipt_digest="a" * 64,
            )
            staged = restarted.mark_staged(
                resolved.candidate_id,
                expected_generation=1,
                actor_id="service-stager",
                stage_receipt_digest="b" * 64,
            )
            self.assertEqual(staged.state, CandidateState.STAGED)

    def test_managed_inspection_evidence_schema_and_parity_boole_are_exact(self) -> None:
        extra_field = managed_inspection()
        extra_evidence = dict(extra_field["evidence"])  # type: ignore[arg-type]
        extra_evidence["callerSuppliedHash"] = "a" * 64
        extra_field["evidence"] = extra_evidence
        with self.assertRaisesRegex(
            InvalidCandidate,
            "evidence fields are not exact",
        ):
            managed_draft(rebound_managed_inspection(extra_field))

        integer_parity = managed_inspection()
        integer_evidence = dict(integer_parity["evidence"])  # type: ignore[arg-type]
        integer_evidence["semanticParity"] = 1
        integer_parity["evidence"] = integer_evidence
        with self.assertRaisesRegex(
            InvalidCandidate,
            "semanticParity must be an exact boolean",
        ):
            managed_draft(rebound_managed_inspection(integer_parity))

    def test_managed_inspection_rejects_contradictory_candidate_subjects(self) -> None:
        contradictions = (
            {"artifact_id": "artifact_" + "9" * 32},
            {"project_id": "project-other"},
            {"run_id": "run-other"},
        )
        for changes in contradictions:
            with self.subTest(changes=changes):
                with self.assertRaises(InvalidCandidate):
                    managed_draft(**changes)

        with self.repository() as repository:
            self.assertEqual(repository.list_for_project("project-candidate"), ())

    def test_managed_inspection_rejects_missing_unknown_and_opaque_receipts(self) -> None:
        cases: list[dict[str, object]] = []
        missing_project = managed_inspection()
        del missing_project["projectId"]
        cases.append(missing_project)
        unknown_location = managed_inspection()
        unknown_location["sourceUrl"] = "file:///host/secret.kicad_pcb"
        cases.append(unknown_location)
        invalid_context = managed_inspection()
        invalid_context["coordinationContextDigest"] = "not-a-digest"
        cases.append(invalid_context)
        wrong_payload_digest = managed_inspection()
        wrong_payload_digest["inspectionPayloadSha256"] = "9" * 64
        cases.append(wrong_payload_digest)
        wrong_receipt_digest = managed_inspection()
        wrong_receipt_digest["inspectionReceiptDigest"] = "9" * 64
        wrong_receipt_digest["inspectionReceiptId"] = "inspection_" + "9" * 32
        cases.append(wrong_receipt_digest)

        for inspection in cases:
            with self.subTest(fields=tuple(sorted(inspection))):
                with self.assertRaises(InvalidCandidate):
                    managed_draft(inspection)

    def test_candidate_accepts_the_real_canonical_kernel_revision_shape(self) -> None:
        revision = DesignKernel(DesignGraph(1, "project-candidate")).head.revision_hash
        self.assertRegex(revision, r"^[0-9a-f]{64}$")
        candidate_draft = draft(expected_project_revision=revision)
        with self.repository() as repository:
            created = repository.create(candidate_draft)
            self.assertEqual(created.expected_project_revision, revision)
        with self.assertRaises(InvalidCandidate):
            draft(expected_project_revision=f"rev_{revision}")

    def test_candidate_requires_a_non_null_canonical_project_revision(self) -> None:
        with self.assertRaises(InvalidCandidate):
            draft(expected_project_revision=None)
        with self.repository() as repository:
            self.assertEqual(repository.list_for_project("project-candidate"), ())
            columns = {
                row[1]: row
                for row in repository._connection.execute(  # noqa: SLF001
                    "PRAGMA table_info(import_candidates)"
                ).fetchall()
            }
            self.assertEqual(columns["expected_project_revision"][3], 1)

    def test_legal_lifecycle_is_receipt_bound_and_digest_chained(self) -> None:
        with self.repository() as repository:
            pending = repository.create(draft())
            resolved = repository.resolve(
                pending.candidate_id,
                expected_generation=0,
                actor_id="user-resolver",
                resolution_receipt_digest="a" * 64,
            )
            staged = repository.mark_staged(
                resolved.candidate_id,
                expected_generation=1,
                actor_id="service-stager",
                stage_receipt_digest="b" * 64,
            )
            invalidated = repository.invalidate(
                staged.candidate_id,
                expected_generation=2,
                actor_id="service-coordinator",
                reason="Canonical project revision changed.",
            )

            self.assertEqual(invalidated.state, CandidateState.INVALIDATED)
            self.assertEqual(invalidated.generation, 3)
            self.assertEqual(invalidated.resolution_receipt_digest, "a" * 64)
            self.assertEqual(invalidated.stage_receipt_digest, "b" * 64)
            self.assertEqual(
                invalidated.terminal_reason,
                "Canonical project revision changed.",
            )
            events = repository.list_events(pending.candidate_id)
            self.assertEqual([event.sequence for event in events], [0, 1, 2, 3])
            self.assertEqual(
                [event.state for event in events],
                [
                    CandidateState.PENDING,
                    CandidateState.RESOLVED,
                    CandidateState.STAGED,
                    CandidateState.INVALIDATED,
                ],
            )
            for previous, current in zip(events[:-1], events[1:], strict=True):
                self.assertEqual(current.previous_event_digest, previous.event_digest)

    def test_rejection_is_legal_before_or_after_resolution_and_terminal(self) -> None:
        with self.repository() as repository:
            pending = repository.create(draft())
            rejected = repository.reject(
                pending.candidate_id,
                expected_generation=0,
                actor_id="user-reviewer",
                reason="User cancelled this exact candidate.",
            )
            self.assertEqual(rejected.state, CandidateState.REJECTED)
            with self.assertRaises(IllegalCandidateTransition):
                repository.resolve(
                    rejected.candidate_id,
                    expected_generation=1,
                    actor_id="user-reviewer",
                    resolution_receipt_digest="a" * 64,
                )

            second = repository.create(draft(run_id="run-second"))
            resolved = repository.resolve(
                second.candidate_id,
                expected_generation=0,
                actor_id="user-reviewer",
                resolution_receipt_digest="c" * 64,
            )
            rejected_after_resolution = repository.reject(
                resolved.candidate_id,
                expected_generation=1,
                actor_id="user-reviewer",
                reason="Resolved mapping was not acceptable.",
            )
            self.assertEqual(
                rejected_after_resolution.resolution_receipt_digest, "c" * 64
            )

    def test_compare_and_swap_rejects_stale_repository_instance(self) -> None:
        first = self.repository()
        second = self.repository()
        try:
            pending = first.create(draft())
            stale = second.get(pending.candidate_id)
            resolved = first.resolve(
                pending.candidate_id,
                expected_generation=pending.generation,
                actor_id="user-one",
                resolution_receipt_digest="a" * 64,
            )
            with self.assertRaises(CandidateConcurrencyConflict):
                second.resolve(
                    stale.candidate_id,
                    expected_generation=stale.generation,
                    actor_id="user-two",
                    resolution_receipt_digest="b" * 64,
                )
            self.assertEqual(second.get(pending.candidate_id), resolved)
        finally:
            first.close()
            second.close()

    def test_database_guards_identity_and_event_history(self) -> None:
        with self.repository() as repository:
            candidate = repository.create(draft())

        connection = sqlite3.connect(self.database)
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "UPDATE import_candidates SET artifact_sha256 = ? "
                    "WHERE candidate_id = ?",
                    ("f" * 64, candidate.candidate_id),
                )
            connection.rollback()
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "DELETE FROM import_candidate_events WHERE candidate_id = ?",
                    (candidate.candidate_id,),
                )
            connection.rollback()
            connection.execute(
                "UPDATE import_candidates SET state = 'resolved', generation = 1, "
                "resolution_receipt_digest = ? WHERE candidate_id = ?",
                ("e" * 64, candidate.candidate_id),
            )
            connection.commit()
        finally:
            connection.close()

        with self.repository() as restarted:
            with self.assertRaises(CandidateIntegrityError):
                restarted.get(candidate.candidate_id)

    def test_event_replay_rejects_lifecycle_receipt_and_reason_row_tampering(self) -> None:
        cases = ("resolution", "stage", "terminal")
        for case in cases:
            with self.subTest(case=case):
                database = Path(self.temporary.name) / f"tamper-{case}.sqlite3"
                with SQLiteImportCandidateRepository(
                    database, clock=lambda: _TIME
                ) as repository:
                    candidate = repository.create(draft(run_id=f"run-{case}"))
                    if case in {"resolution", "stage"}:
                        candidate = repository.resolve(
                            candidate.candidate_id,
                            expected_generation=0,
                            actor_id="user-resolver",
                            resolution_receipt_digest="5" * 64,
                        )
                    if case == "stage":
                        candidate = repository.mark_staged(
                            candidate.candidate_id,
                            expected_generation=1,
                            actor_id="service-stager",
                            stage_receipt_digest="7" * 64,
                        )
                    if case == "terminal":
                        candidate = repository.reject(
                            candidate.candidate_id,
                            expected_generation=0,
                            actor_id="user-reviewer",
                            reason="Original rejection reason.",
                        )

                connection = sqlite3.connect(database)
                try:
                    if case == "resolution":
                        connection.execute(
                            "UPDATE import_candidates "
                            "SET resolution_receipt_digest = ? WHERE candidate_id = ?",
                            ("6" * 64, candidate.candidate_id),
                        )
                    elif case == "stage":
                        connection.execute(
                            "UPDATE import_candidates SET stage_receipt_digest = ? "
                            "WHERE candidate_id = ?",
                            ("8" * 64, candidate.candidate_id),
                        )
                    else:
                        connection.execute(
                            "UPDATE import_candidates SET terminal_reason = ? "
                            "WHERE candidate_id = ?",
                            ("Tampered rejection reason.", candidate.candidate_id),
                        )
                    connection.commit()
                finally:
                    connection.close()

                with SQLiteImportCandidateRepository(
                    database, clock=lambda: _TIME
                ) as restarted:
                    with self.assertRaises(CandidateIntegrityError):
                        restarted.get(candidate.candidate_id)

    def test_creation_event_independently_binds_creator_and_inspection_receipt(self) -> None:
        for field_name, replacement in (
            ("created_by", "attacker-actor"),
            ("inspection_receipt_digest", "f" * 64),
        ):
            with self.subTest(field=field_name):
                database = Path(self.temporary.name) / f"root-{field_name}.sqlite3"
                repository = SQLiteImportCandidateRepository(database, clock=lambda: _TIME)
                try:
                    candidate = repository.create(draft(run_id=f"run-{field_name}"))
                    connection = sqlite3.connect(database)
                    try:
                        connection.execute(
                            "DROP TRIGGER import_candidates_identity_immutable"
                        )
                        connection.execute(
                            f"UPDATE import_candidates SET {field_name} = ? "
                            "WHERE candidate_id = ?",
                            (replacement, candidate.candidate_id),
                        )
                        connection.commit()
                    finally:
                        connection.close()
                    with self.assertRaises(CandidateIntegrityError):
                        repository.get(candidate.candidate_id)
                finally:
                    repository.close()

    def test_schema_v1_migrates_through_digest_chain_to_v3(self) -> None:
        with self.repository() as repository:
            candidate = repository.create(draft())

        connection = sqlite3.connect(self.database)
        try:
            downgrade_candidate_table_to_v2(connection)
            connection.executescript(
                """
                DROP TRIGGER import_candidate_events_no_update;
                DROP TRIGGER import_candidate_events_no_delete;
                DROP TABLE import_candidate_events;
                ALTER TABLE import_candidates DROP COLUMN last_event_digest;
                UPDATE import_candidate_repository_meta SET schema_version = 1;
                PRAGMA user_version = 1;
                """
            )
            connection.commit()
        finally:
            connection.close()

        with self.repository() as migrated:
            restored = migrated.get(candidate.candidate_id)
            events = migrated.list_events(candidate.candidate_id)
            self.assertEqual(restored.state, CandidateState.PENDING)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].kind, CandidateEventKind.MIGRATED)
            self.assertEqual(events[0].state, CandidateState.PENDING)
            resolved = migrated.resolve(
                restored.candidate_id,
                expected_generation=0,
                actor_id="user-after-migration",
                resolution_receipt_digest="d" * 64,
            )
            self.assertEqual(migrated.get(restored.candidate_id), resolved)
            self.assertEqual(
                [event.kind for event in migrated.list_events(restored.candidate_id)],
                [CandidateEventKind.MIGRATED, CandidateEventKind.TRANSITIONED],
            )
        connection = sqlite3.connect(self.database)
        try:
            self.assertEqual(
                connection.execute("PRAGMA user_version").fetchone()[0],
                STORE_SCHEMA_VERSION,
            )
        finally:
            connection.close()

    def test_schema_v2_preserves_legacy_domain_digest_identity_in_v3(self) -> None:
        legacy_draft = replace(
            managed_draft(),
            identity_scheme=CandidateIdentityScheme.LEGACY_V2,
        )
        with self.repository() as repository:
            legacy = repository.create(legacy_draft)

        connection = sqlite3.connect(self.database)
        try:
            downgrade_candidate_table_to_v2(connection)
            connection.execute(
                "UPDATE import_candidate_repository_meta SET schema_version = 2"
            )
            connection.execute("PRAGMA user_version = 2")
            connection.commit()
        finally:
            connection.close()

        with self.repository() as migrated:
            restored = migrated.get(legacy.candidate_id)
            self.assertEqual(restored.candidate_id, legacy.candidate_id)
            self.assertEqual(restored.candidate_digest, legacy.candidate_digest)
            self.assertEqual(
                restored.inspection_payload_digest,
                legacy.inspection_payload_digest,
            )
            self.assertEqual(
                restored.identity_scheme,
                CandidateIdentityScheme.LEGACY_V2,
            )
            plain_payload_sha256 = hashlib.sha256(
                restored.inspection_payload_json.encode("utf-8")
            ).hexdigest()
            self.assertEqual(
                restored.inspection_payload_sha256,
                plain_payload_sha256,
            )
            self.assertNotEqual(
                restored.inspection_payload_digest,
                restored.inspection_payload_sha256,
            )
            receipt_payload = restored.decoded_inspection_payload()
            receipt_material = {
                "artifact_id": receipt_payload["source"]["artifactId"],
                "inspection_payload_sha256": plain_payload_sha256,
                "project_id": receipt_payload["projectId"],
                "project_revision": receipt_payload[
                    "expectedProjectRevision"
                ],
                "run_id": receipt_payload["runId"],
                "run_revision": receipt_payload["runRevision"],
                "source_sha256": receipt_payload["source"]["sha256"],
            }
            recomputed_receipt = hashlib.sha256(
                b"flux-clone-kicad-inspection-receipt-v1\0"
                + canonical_json(receipt_material).encode("utf-8")
            ).hexdigest()
            self.assertEqual(
                restored.inspection_receipt_digest,
                recomputed_receipt,
            )
            resolved = migrated.resolve(
                restored.candidate_id,
                expected_generation=0,
                actor_id="user-after-v2-migration",
                resolution_receipt_digest="e" * 64,
            )
            self.assertEqual(resolved.state, CandidateState.RESOLVED)

    def test_schema_v2_null_revision_fails_migration_transaction_closed(self) -> None:
        with self.repository() as repository:
            candidate = repository.create(draft(run_id="run-null-v2"))

        connection = sqlite3.connect(self.database)
        try:
            downgrade_candidate_table_to_v2(connection)
            connection.execute(
                "UPDATE import_candidates SET expected_project_revision = NULL "
                "WHERE candidate_id = ?",
                (candidate.candidate_id,),
            )
            connection.execute(
                "UPDATE import_candidate_repository_meta SET schema_version = 2"
            )
            connection.execute("PRAGMA user_version = 2")
            connection.commit()
        finally:
            connection.close()

        with self.assertRaises(CandidateIntegrityError):
            self.repository()
        connection = sqlite3.connect(self.database)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)
            columns = {
                row[1]: row
                for row in connection.execute(
                    "PRAGMA table_info(import_candidates)"
                ).fetchall()
            }
            self.assertEqual(columns["expected_project_revision"][3], 0)
            self.assertNotIn("identity_scheme", columns)
        finally:
            connection.close()

    def test_unsupported_schema_fails_closed(self) -> None:
        connection = sqlite3.connect(self.database)
        try:
            connection.execute("PRAGMA application_id = 1179206482")
            connection.execute("PRAGMA user_version = 99")
            connection.execute("CREATE TABLE import_candidate_repository_meta (x)")
            connection.execute("CREATE TABLE import_candidates (x)")
            connection.commit()
        finally:
            connection.close()
        with self.assertRaises(UnsupportedCandidateStoreSchema):
            self.repository()

    def test_payload_rejects_raw_capabilities_bytes_floats_and_release_claims(self) -> None:
        for payload in (
            {"outputPath": "C:/unsafe/output.kicad_pcb"},
            {"diagnostic": {"path": "C:/host/secret.kicad_pcb"}},
            {"nested": {"command": "kicad-cli pcb drc"}},
            {"url": "file:///host/secret.kicad_pcb"},
            {"URL": "file:///host/secret.kicad_pcb"},
            {"sourceUrl": "file:///host/secret.kicad_pcb"},
            {"nested": {"source_url": "file:///host/secret.kicad_pcb"}},
            {"Path": "C:/host/secret.kicad_pcb"},
            {"hostPath": "C:/host/secret.kicad_pcb"},
            {"nested": {"FilePath": "C:/host/secret.kicad_pcb"}},
            {"nested": {"p_a-t.h": "/host/secret.kicad_pcb"}},
            {"location": "file:///host/secret.kicad_pcb"},
            {"Path": " C:/host/secret.kicad_pcb"},
            {"note": " file:///host/secret.kicad_pcb"},
            {"note": " C:/host/secret.kicad_pcb"},
            {"note": " /home/user/secret.kicad_pcb"},
            {"location": "C:/host/secret.kicad_pcb"},
            {"nested": {"host_location": " /host/secret.kicad_pcb"}},
            {"Path": "../host/secret.kicad_pcb"},
            {"Path": "..\\host\\secret.kicad_pcb"},
            {"location": "C:secret.kicad_pcb"},
            {"note": "file:C:/host/secret.kicad_pcb"},
            {"source_path": "host/secret.kicad_pcb"},
            {"note": "/workspace/private/secret.kicad_pcb"},
            {"note": "ｆｉｌｅ：／／／host／secret.kicad_pcb"},
            {"note": "Ｃ：／host／secret.kicad_pcb"},
            {"note": "／workspace／private／secret.kicad_pcb"},
            {"payload": b"raw-bytes"},
            {"coordinate": 1.25},
            {"manufacturingReleaseEligible": True},
            {"kicadExecution": "passed"},
            {"kicad_execution": True},
            {"truth": {"kicadChecks": "passed"}},
            {"nested": {"truth": {"kicad_checks": "passed"}}},
            {"truth": {"nativeChecks": "passed"}},
            {"truth": {"canonicalMapping": "passed"}},
            {"truth": {"engineAgreement": "passed"}},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(InvalidCandidate):
                    draft(inspection_payload=payload)

    def test_restore_rejects_top_level_and_nested_execution_claim_tampering(self) -> None:
        for label, payload in (
            ("top", {"kicadExecution": "passed"}),
            ("nested", {"truth": {"kicadChecks": "passed"}}),
        ):
            with self.subTest(label=label):
                database = Path(self.temporary.name) / f"claim-{label}.sqlite3"
                with SQLiteImportCandidateRepository(
                    database, clock=lambda: _TIME
                ) as repository:
                    candidate = repository.create(draft(run_id=f"run-{label}"))

                connection = sqlite3.connect(database)
                try:
                    trigger_sql = connection.execute(
                        "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
                        "AND name = 'import_candidates_identity_immutable'"
                    ).fetchone()[0]
                    connection.execute(
                        "DROP TRIGGER import_candidates_identity_immutable"
                    )
                    connection.execute(
                        "UPDATE import_candidates SET inspection_payload_json = ? "
                        "WHERE candidate_id = ?",
                        (canonical_json(payload), candidate.candidate_id),
                    )
                    connection.execute(trigger_sql)
                    connection.commit()
                finally:
                    connection.close()

                with SQLiteImportCandidateRepository(
                    database, clock=lambda: _TIME
                ) as restarted:
                    with self.assertRaises(CandidateIntegrityError):
                        restarted.get(candidate.candidate_id)

    def test_restore_rejects_casefolded_nested_host_location_tampering(self) -> None:
        with self.repository() as repository:
            candidate = repository.create(draft(run_id="run-location-tamper"))

        connection = sqlite3.connect(self.database)
        try:
            trigger_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' "
                "AND name = 'import_candidates_identity_immutable'"
            ).fetchone()[0]
            connection.execute("DROP TRIGGER import_candidates_identity_immutable")
            connection.execute(
                "UPDATE import_candidates SET inspection_payload_json = ? "
                "WHERE candidate_id = ?",
                (
                    canonical_json(
                        {"nested": {"FilePath": "C:/host/secret.kicad_pcb"}}
                    ),
                    candidate.candidate_id,
                ),
            )
            connection.execute(trigger_sql)
            connection.commit()
        finally:
            connection.close()

        with self.repository() as restarted:
            with self.assertRaises(CandidateIntegrityError):
                restarted.get(candidate.candidate_id)

    def test_public_record_and_repository_have_no_mutation_or_manufacturing_surface(self) -> None:
        field_names = {field.name.casefold() for field in fields(ImportCandidate)}
        self.assertFalse(any("manufactur" in name for name in field_names))
        self.assertFalse(any("path" in name or "bytes" in name for name in field_names))
        public_methods = {
            name
            for name, member in inspect.getmembers(
                SQLiteImportCandidateRepository, inspect.isfunction
            )
            if not name.startswith("_")
        }
        self.assertEqual(
            public_methods,
            {
                "close",
                "create",
                "get",
                "invalidate",
                "list_events",
                "list_for_project",
                "mark_staged",
                "reject",
                "resolve",
            },
        )
        self.assertTrue(
            {"commit", "stage_graph", "write_file", "release_manufacturing"}.isdisjoint(
                public_methods
            )
        )


if __name__ == "__main__":
    unittest.main()

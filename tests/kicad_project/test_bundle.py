from __future__ import annotations

import hashlib
import inspect
import unittest
from dataclasses import replace
from pathlib import Path

from backend.kicad_project import (
    BundleImportEvidence,
    BundleLimits,
    ProjectBundleInput,
    ProjectInvariantError,
    ProjectSyntaxError,
    UnsupportedPolicy,
    UnsupportedProjectConstructError,
    export_project_bundle,
    import_project_bundle,
    round_trip_project_bundle,
)

PROJECT_FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad_project"
PCB_FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad"


def supported_source(stem: str = "supported_project") -> ProjectBundleInput:
    project_name = (
        "supported_project.kicad_pro"
        if stem == "supported_project"
        else "unsupported_settings.kicad_pro"
    )
    return ProjectBundleInput(
        stem,
        (PROJECT_FIXTURES / project_name).read_bytes(),
        (PROJECT_FIXTURES / "supported_project.kicad_sch").read_bytes(),
        (PCB_FIXTURES / "supported_board.kicad_pcb").read_bytes(),
    )


class ProjectBundleTests(unittest.TestCase):
    def test_import_binds_all_bytes_IRs_diagnostics_and_exact_cross_artifact_parity(self) -> None:
        source = supported_source()
        result = import_project_bundle(source)
        self.assertEqual(
            result.evidence.project_source_sha256,
            hashlib.sha256(source.project_payload).hexdigest(),
        )
        self.assertEqual(
            result.evidence.schematic_source_sha256,
            hashlib.sha256(source.schematic_payload).hexdigest(),
        )
        self.assertEqual(
            result.evidence.board_source_sha256,
            hashlib.sha256(source.board_payload).hexdigest(),
        )
        self.assertEqual(
            result.evidence.project_ir_sha256,
            result.bundle.manifest.normalized_ir_sha256,
        )
        self.assertEqual(
            result.evidence.schematic_ir_sha256,
            result.bundle.schematic.normalized_ir_sha256,
        )
        self.assertEqual(result.evidence.board_ir_sha256, result.bundle.board.normalized_ir_sha256)
        self.assertEqual(result.evidence.bundle_ir_sha256, result.bundle.normalized_ir_sha256)
        self.assertEqual(result.evidence.kicad_execution, "not-run")
        self.assertFalse(result.evidence.manufacturing_release_eligible)
        self.assertFalse(result.bundle.diagnostics.unsupported)

    def test_export_and_full_three_artifact_round_trip_are_deterministic(self) -> None:
        imported = import_project_bundle(supported_source())
        first = export_project_bundle(imported.bundle)
        second = export_project_bundle(imported.bundle)
        self.assertEqual(first, second)
        self.assertEqual(
            first.evidence.project_export_sha256,
            hashlib.sha256(first.payload.project_payload).hexdigest(),
        )
        self.assertEqual(
            first.evidence.schematic_export_sha256,
            hashlib.sha256(first.payload.schematic_payload).hexdigest(),
        )
        self.assertEqual(
            first.evidence.board_export_sha256,
            hashlib.sha256(first.payload.board_payload).hexdigest(),
        )
        parity = round_trip_project_bundle(supported_source())
        self.assertTrue(parity.evidence.project_semantic_parity)
        self.assertTrue(parity.evidence.schematic_semantic_parity)
        self.assertTrue(parity.evidence.board_semantic_parity)
        self.assertTrue(parity.evidence.diagnostics_parity)
        self.assertTrue(parity.evidence.semantic_parity)
        self.assertEqual(parity.evidence.kicad_execution, "not-run")
        self.assertFalse(parity.evidence.manufacturing_release_eligible)

    def test_project_rule_settings_fail_strict_and_review_mode_preserves_them(self) -> None:
        source = supported_source("unsupported_settings")
        with self.assertRaises(UnsupportedProjectConstructError) as caught:
            import_project_bundle(source)
        self.assertEqual(len(caught.exception.manifest_sha256), 64)
        self.assertTrue(
            any(
                item.artifact == "project" and item.head == "net_settings"
                for item in caught.exception.diagnostics
            )
        )

        reviewed = import_project_bundle(
            source, unsupported_policy=UnsupportedPolicy.MANIFEST
        )
        with self.assertRaises(UnsupportedProjectConstructError):
            export_project_bundle(reviewed.bundle)
        exported = export_project_bundle(reviewed.bundle, preserve_unsupported=True)
        self.assertIn(b'"net_settings"', exported.payload.project_payload)
        self.assertTrue(exported.evidence.preserved_unsupported)
        parity = round_trip_project_bundle(
            source, unsupported_policy=UnsupportedPolicy.MANIFEST
        )
        self.assertTrue(parity.evidence.semantic_parity)
        self.assertTrue(parity.evidence.diagnostics_parity)

    def test_hierarchy_or_unsupported_board_copper_produces_bundle_level_unknown_parity(
        self,
    ) -> None:
        source = supported_source()
        hierarchy = b'''  (sheet
    (at 50.8 50.8)
    (size 25.4 12.7)
    (uuid "10000000-0000-4000-8000-000000000701"))
'''
        source_with_sheet = replace(
            source,
            schematic_payload=source.schematic_payload.replace(
                b"  (sheet_instances", hierarchy + b"  (sheet_instances", 1
            ),
        )
        with self.assertRaises(UnsupportedProjectConstructError):
            import_project_bundle(source_with_sheet)
        reviewed = import_project_bundle(
            source_with_sheet, unsupported_policy=UnsupportedPolicy.MANIFEST
        )
        self.assertTrue(
            any(item.artifact == "bundle" for item in reviewed.bundle.diagnostics.unsupported)
        )

        unsupported_board = replace(
            source,
            board_payload=(PCB_FIXTURES / "unsupported_zone.kicad_pcb").read_bytes(),
        )
        reviewed_board = import_project_bundle(
            unsupported_board, unsupported_policy=UnsupportedPolicy.MANIFEST
        )
        self.assertTrue(
            any(item.artifact == "board" for item in reviewed_board.bundle.diagnostics.unsupported)
        )
        self.assertTrue(
            any(item.artifact == "bundle" for item in reviewed_board.bundle.diagnostics.unsupported)
        )

    def test_schematic_PCB_net_or_population_drift_fails_closed(self) -> None:
        source = supported_source()
        changed = replace(
            source,
            schematic_payload=source.schematic_payload.replace(b'"SIG"', b'"SIGNAL"', 1),
        )
        with self.assertRaises(ProjectInvariantError):
            import_project_bundle(changed)

        missing_symbol = replace(
            source,
            schematic_payload=source.schematic_payload.replace(b'"J1"', b'"J9"', 1),
        )
        with self.assertRaises(ProjectInvariantError):
            import_project_bundle(missing_symbol)

    def test_stem_is_not_a_path_and_per_artifact_plus_total_byte_limits_are_enforced(self) -> None:
        source = supported_source()
        for stem in ("../escape", "folder/project", r"folder\project", "."):
            with self.assertRaises(ProjectInvariantError):
                replace(source, stem=stem)
        with self.assertRaises(ProjectSyntaxError):
            import_project_bundle(
                source,
                limits=replace(
                    BundleLimits(), maximum_schematic_bytes=len(source.schematic_payload) - 1
                ),
            )
        with self.assertRaises(ProjectSyntaxError):
            import_project_bundle(
                source,
                limits=replace(
                    BundleLimits(),
                    maximum_total_bytes=(
                        len(source.project_payload)
                        + len(source.schematic_payload)
                        + len(source.board_payload)
                        - 1
                    ),
                ),
            )

    def test_public_exchange_surface_has_no_path_shell_or_process_parameter(self) -> None:
        callables = (
            import_project_bundle,
            export_project_bundle,
            round_trip_project_bundle,
        )
        forbidden = {"path", "directory", "destination", "command", "shell", "process"}
        for operation in callables:
            parameters = set(inspect.signature(operation).parameters)
            self.assertFalse(parameters & forbidden)
        self.assertEqual(
            tuple(ProjectBundleInput.__dataclass_fields__),
            (
                "stem",
                "project_payload",
                "schematic_payload",
                "board_payload",
                "auxiliary_files",
            ),
        )

    def test_evidence_constructor_can_never_claim_KiCad_execution_or_release(self) -> None:
        digest = "0" * 64
        with self.assertRaises(ProjectInvariantError):
            BundleImportEvidence(
                digest,
                digest,
                digest,
                digest,
                digest,
                digest,
                digest,
                digest,
                "test-parser",
                kicad_execution="executed",
            )
        with self.assertRaises(ProjectInvariantError):
            BundleImportEvidence(
                digest,
                digest,
                digest,
                digest,
                digest,
                digest,
                digest,
                digest,
                "test-parser",
                manufacturing_release_eligible=True,
            )


if __name__ == "__main__":
    unittest.main()

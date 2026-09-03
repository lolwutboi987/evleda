from __future__ import annotations

import json
import unittest
from dataclasses import replace
from pathlib import Path

from backend.kicad_project import (
    BundleLimits,
    ProjectInvariantError,
    ProjectSyntaxError,
    parse_project_manifest,
    render_project_manifest,
)

FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad_project"


class ProjectManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = (FIXTURES / "supported_project.kicad_pro").read_bytes()

    def test_parses_exact_single_sheet_membership_and_canonicalizes_deterministically(self) -> None:
        first = parse_project_manifest(
            self.payload, stem="supported_project", limits=BundleLimits()
        )
        second = parse_project_manifest(
            render_project_manifest(first), stem="supported_project", limits=BundleLimits()
        )
        self.assertEqual(first.schema_version, 3)
        self.assertEqual(first.filename, "supported_project.kicad_pro")
        self.assertEqual(len(first.sheets), 1)
        self.assertEqual(len(first.top_level_sheets), 1)
        self.assertEqual(first.sheets[0].file_id, first.top_level_sheets[0].sheet_id)
        self.assertEqual(
            first.top_level_sheets[0].filename, "supported_project.kicad_sch"
        )
        self.assertEqual(first.normalized_ir_sha256, second.normalized_ir_sha256)
        self.assertEqual(render_project_manifest(first), render_project_manifest(second))
        self.assertFalse(first.diagnostics.unsupported)

    def test_rejects_duplicate_keys_wrong_schema_filename_and_external_sheet_names(self) -> None:
        duplicate = self.payload.replace(
            b'"version": 3', b'"version": 3, "version": 3', 1
        )
        with self.assertRaises(ProjectSyntaxError):
            parse_project_manifest(duplicate, stem="supported_project", limits=BundleLimits())

        wrong_schema = self.payload.replace(b'"version": 3', b'"version": 2', 1)
        with self.assertRaises(ProjectInvariantError):
            parse_project_manifest(
                wrong_schema, stem="supported_project", limits=BundleLimits()
            )

        wrong_filename = self.payload.replace(
            b'"supported_project.kicad_pro"', b'"other.kicad_pro"', 1
        )
        with self.assertRaises(ProjectInvariantError):
            parse_project_manifest(
                wrong_filename, stem="supported_project", limits=BundleLimits()
            )

        external_sheet = self.payload.replace(
            b'"supported_project.kicad_sch"', b'"../outside.kicad_sch"', 1
        )
        with self.assertRaises(ProjectInvariantError):
            parse_project_manifest(
                external_sheet, stem="supported_project", limits=BundleLimits()
            )

    def test_bounded_json_enforces_bytes_depth_and_nodes_before_semantic_use(self) -> None:
        with self.assertRaises(ProjectSyntaxError):
            parse_project_manifest(
                self.payload,
                stem="supported_project",
                limits=replace(BundleLimits(), maximum_project_bytes=16),
            )
        with self.assertRaises(ProjectSyntaxError):
            parse_project_manifest(
                self.payload,
                stem="supported_project",
                limits=replace(BundleLimits(), maximum_json_depth=2),
            )
        with self.assertRaises(ProjectSyntaxError):
            parse_project_manifest(
                self.payload,
                stem="supported_project",
                limits=replace(BundleLimits(), maximum_json_nodes=8),
            )

    def test_realistic_rule_settings_are_retained_as_explicit_unsupported_json(self) -> None:
        payload = (FIXTURES / "unsupported_settings.kicad_pro").read_bytes()
        result = parse_project_manifest(
            payload, stem="unsupported_settings", limits=BundleLimits()
        )
        self.assertEqual(len(result.diagnostics.unsupported), 1)
        diagnostic = result.diagnostics.unsupported[0]
        self.assertEqual(diagnostic.path, "$.net_settings")
        self.assertIn('"clearance":0.2', diagnostic.canonical_payload)
        self.assertEqual(render_project_manifest(result), render_project_manifest(result))

    def _payload_with_supported_board_settings(
        self,
        *,
        minimum_clearance: float = 0.2,
        minimum_hole_clearance: float = 0.15,
        exclusions: list[str] | None = None,
        extra_rules: dict[str, float] | None = None,
    ) -> bytes:
        document = json.loads(self.payload)
        rules = {
            "min_clearance": minimum_clearance,
            "min_hole_clearance": minimum_hole_clearance,
        }
        rules.update(extra_rules or {})
        document["board"] = {
            "design_settings": {
                "drc_exclusions": exclusions or [],
                "meta": {
                    "filename": "board_design_settings.json",
                    "version": 2,
                },
                "rules": rules,
            }
        }
        return json.dumps(document, sort_keys=True, separators=(",", ":")).encode()

    def test_exact_board_design_rules_are_typed_fixed_point_and_hash_bound(self) -> None:
        payload = self._payload_with_supported_board_settings()
        first = parse_project_manifest(
            payload, stem="supported_project", limits=BundleLimits()
        )
        second = parse_project_manifest(
            self._payload_with_supported_board_settings(minimum_clearance=0.25),
            stem="supported_project",
            limits=BundleLimits(),
        )
        settings = first.board_design_settings
        self.assertIsNotNone(settings)
        assert settings is not None
        self.assertEqual(settings.metadata_filename, "board_design_settings.json")
        self.assertEqual(settings.metadata_version, 2)
        self.assertEqual(settings.drc_exclusions, ())
        self.assertEqual(settings.rules.minimum_clearance_nm, 200_000)
        self.assertEqual(settings.rules.minimum_hole_clearance_nm, 150_000)
        self.assertFalse(first.diagnostics.unsupported)
        self.assertNotEqual(first.normalized_ir_sha256, second.normalized_ir_sha256)
        reparsed = parse_project_manifest(
            render_project_manifest(first), stem="supported_project", limits=BundleLimits()
        )
        self.assertEqual(first.normalized_ir_sha256, reparsed.normalized_ir_sha256)

    def test_board_exclusions_and_unknown_rules_remain_explicitly_unsupported(self) -> None:
        excluded = parse_project_manifest(
            self._payload_with_supported_board_settings(exclusions=["rule:ignored"]),
            stem="supported_project",
            limits=BundleLimits(),
        )
        self.assertEqual(
            excluded.diagnostics.unsupported[0].path,
            "$.board.design_settings.drc_exclusions",
        )
        extra = parse_project_manifest(
            self._payload_with_supported_board_settings(extra_rules={"track_width": 0.25}),
            stem="supported_project",
            limits=BundleLimits(),
        )
        self.assertTrue(
            any(
                item.path == "$.board.design_settings.rules.track_width"
                for item in extra.diagnostics.unsupported
            )
        )

    def test_board_rule_values_must_resolve_to_nonnegative_integer_nanometres(self) -> None:
        for value in (-0.1, 0.0000001):
            with self.assertRaises(ProjectInvariantError):
                parse_project_manifest(
                    self._payload_with_supported_board_settings(
                        minimum_clearance=value
                    ),
                    stem="supported_project",
                    limits=BundleLimits(),
                )


if __name__ == "__main__":
    unittest.main()

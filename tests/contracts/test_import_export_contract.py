from __future__ import annotations

from dataclasses import fields
import inspect
import unittest

from backend.kicad_io import (
    ExportEvidence,
    ImportEvidence,
    RoundTripEvidence,
    to_design_graph,
)
from backend.kicad_io.sexpr import DEFAULT_LIMITS
from backend.mcp_gateway import CapabilityTier
from backend.mcp_server.hooks import KICAD_HOOK_BY_NAME, kicad_import_subject_digest
from backend.mcp_server.server import MAX_MESSAGE_BYTES


_SHA = "a" * 64
_FORBIDDEN_OPERATION_FIELDS = {
    "path",
    "filePath",
    "inputPath",
    "outputPath",
    "destination",
    "cwd",
    "command",
    "executable",
    "args",
    "argv",
    "shell",
    "script",
    "env",
    "url",
    "sourceUrl",
    "bytes",
    "content",
    "base64",
    "overwrite",
    "recursive",
    "file_path",
    "input_path",
    "output_path",
    "source_url",
}


def _schema_property_names(schema: object) -> set[str]:
    if isinstance(schema, list):
        result: set[str] = set()
        for item in schema:
            result.update(_schema_property_names(item))
        return result
    if not isinstance(schema, dict):
        return set()
    result = set(schema.get("properties", {}))
    for value in schema.values():
        result.update(_schema_property_names(value))
    return result


class ImportExportBoundaryContractTests(unittest.TestCase):
    def test_worker_import_is_digest_managed_human_release_operation(self) -> None:
        hook = KICAD_HOOK_BY_NAME["kicad_import"]
        self.assertEqual(hook.required_tier, CapabilityTier.RELEASE)
        self.assertTrue(hook.destructive)
        self.assertTrue(hook.requires_user)
        self.assertFalse(hook.input_schema["additionalProperties"])
        self.assertEqual(
            set(hook.input_schema["properties"]),
            {
                "project_id",
                "expected_project_revision",
                "source_artifact_id",
                "source_sha256",
                "approval_receipt_id",
            },
        )

    def test_worker_export_names_revision_format_and_no_destination(self) -> None:
        hook = KICAD_HOOK_BY_NAME["kicad_export"]
        self.assertEqual(hook.required_tier, CapabilityTier.RELEASE)
        self.assertFalse(hook.input_schema["additionalProperties"])
        self.assertEqual(
            set(hook.input_schema["properties"]),
            {"project_id", "expected_project_revision", "format"},
        )
        self.assertTrue(
            _FORBIDDEN_OPERATION_FIELDS.isdisjoint(
                _schema_property_names(hook.input_schema)
            )
        )

    def test_all_worker_hooks_have_closed_top_level_schemas_without_escape_fields(self) -> None:
        for hook in KICAD_HOOK_BY_NAME.values():
            with self.subTest(hook=hook.name):
                self.assertIs(hook.input_schema["additionalProperties"], False)
                self.assertTrue(
                    _FORBIDDEN_OPERATION_FIELDS.isdisjoint(
                        _schema_property_names(hook.input_schema)
                    )
                )

    def test_import_approval_subject_changes_with_every_import_identity(self) -> None:
        base = {
            "project_id": "project-a",
            "expected_project_revision": "rev_" + "b" * 64,
            "source_artifact_id": "artifact-a",
            "source_sha256": "c" * 64,
            "approval_receipt_id": "receipt-a",
        }
        digest = kicad_import_subject_digest(base)
        for field_name, replacement in (
            ("project_id", "project-b"),
            ("expected_project_revision", "rev_" + "d" * 64),
            ("source_artifact_id", "artifact-b"),
            ("source_sha256", "e" * 64),
        ):
            changed = dict(base)
            changed[field_name] = replacement
            with self.subTest(field=field_name):
                self.assertNotEqual(digest, kicad_import_subject_digest(changed))

    def test_mcp_framing_is_not_a_raw_artifact_transport(self) -> None:
        self.assertEqual(MAX_MESSAGE_BYTES, 1_048_576)
        self.assertEqual(DEFAULT_LIMITS.maximum_bytes, 32 * 1024 * 1024)
        self.assertEqual(DEFAULT_LIMITS.maximum_tokens, 2_000_000)
        self.assertEqual(DEFAULT_LIMITS.maximum_depth, 128)
        self.assertEqual(DEFAULT_LIMITS.maximum_atom_characters, 1_000_000)
        self.assertLess(MAX_MESSAGE_BYTES, DEFAULT_LIMITS.maximum_bytes)

    def test_codec_evidence_types_cannot_claim_kicad_execution(self) -> None:
        imported = ImportEvidence(_SHA, _SHA, _SHA, "parser")
        exported = ExportEvidence(_SHA, _SHA, _SHA, "writer", False)
        round_trip = RoundTripEvidence(
            _SHA,
            _SHA,
            _SHA,
            _SHA,
            _SHA,
            _SHA,
            True,
            True,
        )
        self.assertEqual(imported.kicad_execution, "not-run")
        self.assertEqual(exported.kicad_execution, "not-run")
        self.assertEqual(round_trip.kicad_execution, "not-run")
        self.assertIn("kicad_execution", {item.name for item in fields(type(imported))})

    def test_canonical_import_requires_an_explicit_component_resolver(self) -> None:
        signature = inspect.signature(to_design_graph)
        resolver = signature.parameters["component_resolver"]
        self.assertEqual(resolver.kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIs(resolver.default, inspect.Parameter.empty)


if __name__ == "__main__":
    unittest.main()

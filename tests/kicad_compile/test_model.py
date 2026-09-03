from __future__ import annotations

import hashlib
import json
from dataclasses import FrozenInstanceError, replace

import pytest

from backend.kicad_compile import (
    CompilationManifest,
    CompilationProfileEvidence,
    FileDigest,
)

_GRAPH_SHA256 = "1" * 64


def _evidence(**overrides: object) -> CompilationProfileEvidence:
    values: dict[str, object] = {
        "profile_id": "fixture-profile",
        "profile_version": "4.0.0-fixture",
        "subject_graph_sha256": _GRAPH_SHA256,
        "assembly_catalog_sha256": "2" * 64,
        "assembly_placement_sha256": "3" * 64,
        "silkscreen_plan_sha256": "4" * 64,
        "model_catalog_sha256": "5" * 64,
        "model_emitted_manifest_sha256": "6" * 64,
        "model_omitted_manifest_sha256": "7" * 64,
        "model_emitted_count": 15,
        "model_omitted_count": 8,
        "human_plan_sha256": "8" * 64,
        "human_symbol_catalog_sha256": "9" * 64,
        "human_emission_sha256": "a" * 64,
        "source_receipt_manifest_sha256": "b" * 64,
    }
    values.update(overrides)
    return CompilationProfileEvidence.create(**values)  # type: ignore[arg-type]


def _manifest(
    schema_version: int,
    evidence: CompilationProfileEvidence | None = None,
) -> CompilationManifest:
    files = tuple(
        FileDigest(
            filename=f"fixture-{index}.txt",
            media_type="text/plain",
            byte_length=index,
            sha256=f"{index + 1:x}" * 64,
        )
        for index in range(6)
    )
    return CompilationManifest(
        schema_version=schema_version,
        compiler_id="fixture-compiler",
        compiler_version="4.0.0-fixture",
        project_stem="fixture",
        input_graph_sha256=_GRAPH_SHA256,
        files=files,
        output_bundle_sha256="7" * 64,
        project_ir_sha256="8" * 64,
        schematic_ir_sha256="9" * 64,
        board_ir_sha256="a" * 64,
        diagnostics_manifest_sha256="b" * 64,
        identity_bindings=(),
        compilation_profile_evidence=evidence,
    )


def test_profile_evidence_is_immutable_exact_and_domain_hash_bound() -> None:
    evidence = _evidence()
    fields = evidence.to_primitive()
    aggregate = fields.pop("aggregate_sha256")
    canonical = json.dumps(
        fields,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    assert aggregate == hashlib.sha256(
        b"flux-clone-compilation-profile-evidence-v1\x00" + canonical
    ).hexdigest()
    assert CompilationProfileEvidence.from_primitive(evidence.to_primitive()) == evidence
    with pytest.raises(FrozenInstanceError):
        evidence.profile_id = "mutated"  # type: ignore[misc]
    with pytest.raises(ValueError, match="aggregate digest does not match"):
        replace(evidence, aggregate_sha256="c" * 64)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    (
        ("profile_id", 1, "profile ID"),
        ("assembly_catalog_sha256", "A" * 64, "lowercase SHA-256"),
        ("model_emitted_count", True, "non-negative exact integer"),
        ("model_omitted_count", -1, "non-negative exact integer"),
    ),
)
def test_profile_evidence_rejects_wrong_types_hashes_and_counts(
    field: str,
    value: object,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        _evidence(**{field: value})


def test_profile_evidence_primitive_is_closed_and_complete() -> None:
    primitive = _evidence().to_primitive()
    with pytest.raises(ValueError, match="unknown=.*future"):
        CompilationProfileEvidence.from_primitive({**primitive, "future": "rejected"})
    primitive.pop("human_emission_sha256")
    with pytest.raises(ValueError, match="missing=.*human_emission_sha256"):
        CompilationProfileEvidence.from_primitive(primitive)


@pytest.mark.parametrize("schema_version", (1, 2))
def test_legacy_manifest_schemas_remain_exactly_readable_without_evidence(
    schema_version: int,
) -> None:
    manifest = _manifest(schema_version)
    primitive = manifest.to_primitive()
    assert "compilation_profile_evidence" not in primitive
    assert CompilationManifest.from_primitive(primitive) == manifest
    with pytest.raises(ValueError, match="schemas 1 and 2 cannot carry"):
        replace(manifest, compilation_profile_evidence=_evidence())
    with pytest.raises(ValueError, match="unknown=.*compilation_profile_evidence"):
        CompilationManifest.from_primitive(
            {**primitive, "compilation_profile_evidence": None}
        )


def test_schema_three_requires_complete_graph_matching_evidence_and_round_trips() -> None:
    evidence = _evidence()
    manifest = _manifest(3, evidence)
    primitive = manifest.to_primitive()
    assert primitive["compilation_profile_evidence"] == evidence.to_primitive()
    assert CompilationManifest.from_primitive(primitive) == manifest
    with pytest.raises(ValueError, match="schema 3 requires exact"):
        _manifest(3)
    with pytest.raises(ValueError, match="must match the manifest input graph"):
        _manifest(3, _evidence(subject_graph_sha256="c" * 64))


def test_manifest_primitive_rejects_unknown_keys_and_wrong_container_types() -> None:
    primitive = _manifest(3, _evidence()).to_primitive()
    with pytest.raises(ValueError, match="unknown=.*future"):
        CompilationManifest.from_primitive({**primitive, "future": False})
    with pytest.raises(ValueError, match="files must be an exact array"):
        CompilationManifest.from_primitive({**primitive, "files": ()})
    with pytest.raises(ValueError, match="schema must be"):
        CompilationManifest.from_primitive({**primitive, "schema_version": True})

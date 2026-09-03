from __future__ import annotations

import csv
import hashlib
import json
from collections.abc import Callable
from dataclasses import replace
from io import StringIO

import pytest

from backend.kicad_compile import (
    CompilationManifest,
    CompiledProject,
    FileDigest,
    IdentityBinding,
)
from backend.kicad_manufacturing_candidate.bom import (
    CandidateBomEvidence,
    candidate_bom_evidence_payload,
    extract_candidate_bom,
)
from backend.kicad_manufacturing_candidate.model import (
    CandidateContractError,
    CandidateGenerationError,
    CandidateSource,
    canonical_bytes,
)
from backend.kicad_project import ProjectBundleInput

_STEM = "candidate_bom_test"
_ROWS: list[dict[str, object]] = [
    {
        "assembly_role": "input bypass",
        "component_id": "cap-c1",
        "fitted": True,
        "manufacturer": "Acme, Inc.",
        "manufacturer_part_number": "CAP-1UF",
        "package": "0805",
        "quantity": 1,
        "reference": "C1",
        "source_evidence_ids": ["src-cap", "src-regulator"],
        "value": "1uF 16V",
    },
    {
        "assembly_role": "linear regulator",
        "component_id": "reg-u1",
        "fitted": True,
        "manufacturer": "Example Semiconductor",
        "manufacturer_part_number": "REG-3V3",
        "package": "SOT-223-5",
        "quantity": 1,
        "reference": "U1",
        "source_evidence_ids": ["src-regulator"],
        "value": "3.3V LDO",
    },
]


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _property(name: str, value: str) -> str:
    return f'(property "{name}" "{value}")'


def _compiled_payload(root: str, entity: str, uuid_suffix: str) -> bytes:
    entities: list[str] = []
    for index, row in enumerate(_ROWS, start=1):
        properties = " ".join(
            (
                _property("Reference", str(row["reference"])),
                _property("Value", str(row["value"])),
                _property("CanonicalComponentId", str(row["component_id"])),
                _property(
                    "ManufacturerPartNumber",
                    str(row["manufacturer_part_number"]),
                ),
            )
        )
        entity_uuid = f"00000000-0000-0000-0000-{uuid_suffix}{index:02d}"
        entities.append(
            f'({entity} "Generated:{row["reference"]}" '
            f"(uuid {entity_uuid}) {properties})"
        )
    return f"({root} {' '.join(entities)})\n".encode()


def _bundle_sha256(files: tuple[FileDigest, ...]) -> str:
    body = canonical_bytes(
        tuple(
            {
                "filename": item.filename,
                "byteLength": item.byte_length,
                "sha256": item.sha256,
            }
            for item in files
        )
    ) + b"\n"
    return _sha(b"flux-clone-compiled-bundle-v1\x00" + body)


def _candidate_source(*, expected_bundle_sha256: str | None = None) -> CandidateSource:
    project = b"{}\n"
    schematic = _compiled_payload("kicad_sch", "symbol", "0000000001")
    board = _compiled_payload("kicad_pcb", "footprint", "0000000002")
    bundle = ProjectBundleInput(_STEM, project, schematic, board)
    files = tuple(
        FileDigest(item.relative_name, item.media_type, len(item.payload), item.sha256)
        for item in bundle.all_files
    )
    bindings: list[IdentityBinding] = []
    for index, row in enumerate(_ROWS, start=1):
        component_id = str(row["component_id"])
        bindings.extend(
            (
                IdentityBinding(
                    "component",
                    component_id,
                    "pcb-footprint",
                    (f"00000000-0000-0000-0000-0000000002{index:02d}",),
                ),
                IdentityBinding(
                    "component",
                    component_id,
                    "schematic-symbol",
                    (f"00000000-0000-0000-0000-0000000001{index:02d}",),
                ),
            )
        )
    bundle_sha256 = _bundle_sha256(files)
    manifest = CompilationManifest(
        schema_version=1,
        compiler_id="test-compiler",
        compiler_version="1.0.0",
        project_stem=_STEM,
        input_graph_sha256="1" * 64,
        files=files,
        output_bundle_sha256=bundle_sha256,
        project_ir_sha256="2" * 64,
        schematic_ir_sha256="3" * 64,
        board_ir_sha256="4" * 64,
        diagnostics_manifest_sha256="5" * 64,
        identity_bindings=tuple(sorted(bindings)),
    )
    manifest_payload = canonical_bytes(manifest.to_primitive()) + b"\n"
    compiled = CompiledProject(bundle, manifest, manifest_payload, _sha(manifest_payload))
    return CandidateSource(
        compiled,
        expected_bundle_sha256 or bundle_sha256,
        compiled.manifest_sha256,
        reference_design_artifact_sha256="6" * 64,
        reference_package_manifest_sha256="7" * 64,
    )


def _bom_payloads(
    rows: list[dict[str, object]] | None = None,
) -> tuple[bytes, bytes]:
    values = _ROWS if rows is None else rows
    json_payload = canonical_bytes(values) + b"\n"
    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(
        (
            "reference",
            "manufacturer",
            "manufacturer_part_number",
            "value",
            "package",
            "assembly_role",
            "source_evidence_ids",
        )
    )
    for row in values:
        writer.writerow(
            (
                row["reference"],
                row["manufacturer"],
                row["manufacturer_part_number"],
                row["value"],
                row["package"],
                row["assembly_role"],
                ";".join(row["source_evidence_ids"]),  # type: ignore[arg-type]
            )
        )
    return output.getvalue().encode(), json_payload


def test_extract_candidate_bom_copies_exact_source_bytes_and_binds_compiler() -> None:
    csv_payload, json_payload = _bom_payloads()
    source = _candidate_source()
    result = extract_candidate_bom(
        source,
        source_csv_payload=csv_payload,
        source_json_payload=json_payload,
    )

    assert tuple(item.filename for item in result.artifacts) == (
        f"assembly/{_STEM}.bom.csv",
        f"assembly/{_STEM}.bom.json",
    )
    assert result.csv_artifact.payload == csv_payload
    assert result.json_artifact.payload == json_payload
    assert result.csv_artifact.sha256 == _sha(csv_payload)
    assert result.json_artifact.sha256 == _sha(json_payload)
    assert result.evidence.component_count == 2
    assert result.evidence.compiler_bundle_sha256 == source.expected_source_bundle_sha256
    assert tuple(item.sha256 for item in result.evidence.source_files) == tuple(
        item.sha256 for item in result.evidence.candidate_artifacts
    )
    assert result.evidence.reference_design_artifact_sha256 == "6" * 64
    assert result.evidence.reference_package_manifest_sha256 == "7" * 64


def test_candidate_bom_and_evidence_are_deterministic_and_canonical() -> None:
    csv_payload, json_payload = _bom_payloads()
    first = extract_candidate_bom(
        _candidate_source(),
        source_csv_payload=csv_payload,
        source_json_payload=json_payload,
    )
    second = extract_candidate_bom(
        _candidate_source(),
        source_csv_payload=csv_payload,
        source_json_payload=json_payload,
    )

    assert first == second
    evidence_payload = candidate_bom_evidence_payload(first.evidence)
    assert evidence_payload.endswith(b"\n")
    assert canonical_bytes(json.loads(evidence_payload)) + b"\n" == evidence_payload
    assert json.loads(evidence_payload)["evidence_sha256"] == (
        first.evidence.evidence_sha256
    )


def _make_noncanonical(payload: bytes) -> bytes:
    return payload[:-1] + b" \n"


def _add_duplicate_key(payload: bytes) -> bytes:
    return payload.replace(
        b'"assembly_role":',
        b'"assembly_role":"duplicate","assembly_role":',
        1,
    )


@pytest.mark.parametrize(
    "mutation,match",
    (
        (_make_noncanonical, "canonical JSON"),
        (_add_duplicate_key, "duplicate key"),
    ),
)
def test_candidate_bom_rejects_noncanonical_or_ambiguous_json(
    mutation: Callable[[bytes], bytes],
    match: str,
) -> None:
    csv_payload, json_payload = _bom_payloads()
    with pytest.raises(CandidateGenerationError, match=match):
        extract_candidate_bom(
            _candidate_source(),
            source_csv_payload=csv_payload,
            source_json_payload=mutation(json_payload),
        )


def test_candidate_bom_rejects_csv_json_disagreement() -> None:
    csv_payload, json_payload = _bom_payloads()
    with pytest.raises(CandidateGenerationError) as raised:
        extract_candidate_bom(
            _candidate_source(),
            source_csv_payload=csv_payload.replace(b"Acme, Inc.", b"Other, Inc."),
            source_json_payload=json_payload,
        )
    assert raised.value.code == "bom_cross_format_mismatch"


def test_candidate_bom_rejects_joint_csv_json_tamper_against_compiler() -> None:
    rows = [dict(row) for row in _ROWS]
    rows[1]["manufacturer_part_number"] = "REG-TAMPERED"
    csv_payload, json_payload = _bom_payloads(rows)
    with pytest.raises(CandidateGenerationError) as raised:
        extract_candidate_bom(
            _candidate_source(),
            source_csv_payload=csv_payload,
            source_json_payload=json_payload,
        )
    assert raised.value.code == "bom_compiler_parity_mismatch"


def test_candidate_bom_rejects_unsorted_rows_and_formula_cells() -> None:
    for rows, message in (
        (list(reversed(_ROWS)), "references must be sorted"),
        ([{**_ROWS[0], "manufacturer": "=HYPERLINK(1)"}, _ROWS[1]], "formula prefix"),
    ):
        csv_payload, json_payload = _bom_payloads(rows)
        with pytest.raises(CandidateGenerationError, match=message):
            extract_candidate_bom(
                _candidate_source(),
                source_csv_payload=csv_payload,
                source_json_payload=json_payload,
            )


def test_candidate_bom_rejects_unbound_compiler_bundle() -> None:
    csv_payload, json_payload = _bom_payloads()
    with pytest.raises(CandidateGenerationError) as raised:
        extract_candidate_bom(
            _candidate_source(expected_bundle_sha256="0" * 64),
            source_csv_payload=csv_payload,
            source_json_payload=json_payload,
        )
    assert raised.value.code == "bom_compiler_source_invalid"


def test_candidate_bom_evidence_is_self_authenticating() -> None:
    csv_payload, json_payload = _bom_payloads()
    evidence = extract_candidate_bom(
        _candidate_source(),
        source_csv_payload=csv_payload,
        source_json_payload=json_payload,
    ).evidence
    with pytest.raises(CandidateContractError, match="does not bind"):
        replace(evidence, bom_semantic_sha256="0" * 64)
    with pytest.raises(CandidateContractError, match="exact evidence"):
        candidate_bom_evidence_payload(object())  # type: ignore[arg-type]
    assert isinstance(evidence, CandidateBomEvidence)

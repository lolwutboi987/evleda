from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import asdict
from io import StringIO
from pathlib import Path
from typing import cast

import pytest

from backend.kicad_io.sexpr import SExpr, canonical_text, head, parse
from backend.kicad_manufacturing_candidate import (
    CandidateHostConfiguration,
    CandidateSource,
    KiCadManufacturingCandidatePipeline,
    candidate_source_from_reference,
)
from backend.kicad_manufacturing_candidate.bom import extract_candidate_bom
from backend.kicad_manufacturing_candidate.source_zone_identity import (
    compare_source_zone_identity,
)
from backend.reference_design import PROJECT_STEM, BomLine, build_reference_artifact_set

pytestmark = pytest.mark.restricted_evidence

_BOM_HEADER = (
    "reference",
    "manufacturer",
    "manufacturer_part_number",
    "value",
    "package",
    "assembly_role",
    "source_evidence_ids",
)
_EXPECTED_REFERENCES = frozenset(
    {
        "C1",
        "C2",
        "C3",
        "C4",
        "D1",
        "D2",
        "J1",
        "J2",
        "R1",
        "R2",
        "R3",
        "R4",
        "R5",
        "R6",
        "R7",
        "R8",
        "R9",
        "TP1",
        "TP2",
        "TP3",
        "TP4",
        "U1",
        "U2",
    }
)


class _SourcePreflightPipeline(KiCadManufacturingCandidatePipeline):
    def validate_source_for_test(self, source: CandidateSource) -> tuple[tuple[str, bytes], ...]:
        return self._validate_source(source)


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _bom_payloads(rows: tuple[BomLine, ...]) -> tuple[bytes, bytes]:
    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(_BOM_HEADER)
    for row in rows:
        writer.writerow(
            (
                row.reference,
                row.manufacturer,
                row.manufacturer_part_number,
                row.value,
                row.package,
                row.assembly_role,
                ";".join(row.source_evidence_ids),
            )
        )
    csv_payload = output.getvalue().encode("utf-8")
    json_payload = (
        json.dumps(
            [asdict(row) for row in rows],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")
    return csv_payload, json_payload


def _synthetic_fill_only_derivative(source_pcb: bytes) -> bytes:
    """Add one generated node; the provenance oracle must ignore only this node."""

    root = parse(source_pcb)
    assert isinstance(root, tuple)
    generated_fill = parse(
        b'(filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 1 2) (xy 2 2) (xy 2 1)))'
    )
    zone_count = 0
    derivative_items: list[SExpr] = []
    for item in root:
        if head(item) == "zone":
            assert isinstance(item, tuple)
            zone_count += 1
            derivative_items.append((*item, generated_fill))
        else:
            derivative_items.append(item)
    assert zone_count == 1
    return (canonical_text(tuple(derivative_items)) + "\n").encode("utf-8")


def test_exact_r2_candidate_source_bom_and_authored_zone_are_bound_without_kicad(
    tmp_path: Path,
) -> None:
    artifact_set = build_reference_artifact_set()
    compiled = artifact_set.compiled
    source = candidate_source_from_reference(artifact_set)

    assert compiled.bundle.stem == PROJECT_STEM == "reference_usb_c_3v3_r2"
    assert compiled.manifest.schema_version == 3
    assert compiled.manifest.compiler_version == "4.0.0"
    assert source.expected_source_bundle_sha256 == compiled.manifest.output_bundle_sha256
    assert source.expected_manifest_sha256 == compiled.manifest_sha256
    assert source.reference_design_artifact_sha256 == artifact_set.result.artifact_hash
    assert source.bom_result is not None
    assert source.bom_result.evidence.component_count == 23
    assert tuple(item.filename for item in source.bom_result.artifacts) == (
        f"assembly/{PROJECT_STEM}.bom.csv",
        f"assembly/{PROJECT_STEM}.bom.json",
    )

    # Exercise the exact pipeline preflight without launching KiCad.  The inert
    # executable only satisfies the host-configuration boundary and is never run.
    executable = tmp_path / "kicad-cli.exe"
    executable_payload = b"inert integration-test executable\n"
    executable.write_bytes(executable_payload)
    pipeline = _SourcePreflightPipeline(
        CandidateHostConfiguration(
            executable=executable,
            executable_sha256=_sha256(executable_payload),
            kicad_version="10.0.6",
            temp_root=tmp_path / "operations",
        )
    )
    accepted_files = pipeline.validate_source_for_test(source)
    accepted_names = {name for name, _ in accepted_files}
    core_names = {
        f"{PROJECT_STEM}.kicad_pcb",
        f"{PROJECT_STEM}.kicad_pro",
        f"{PROJECT_STEM}.kicad_sch",
    }
    table_names = {"fp-lib-table", "sym-lib-table"}
    symbol_names = {"FluxGenerated.kicad_sym"}
    module_names = {name for name in accepted_names if name.endswith(".kicad_mod")}
    assert len(accepted_files) == len(compiled.manifest.files) == 29
    assert len(module_names) == 23
    assert accepted_names == core_names | table_names | symbol_names | module_names
    assert not any(name.casefold().endswith(".kicad_prl") for name in accepted_names)

    manifest_files = {item.filename: item for item in compiled.manifest.files}
    bundle_files = {item.relative_name: item.payload for item in compiled.bundle.all_files}
    assert accepted_names == set(manifest_files) == set(bundle_files)
    for filename, payload in accepted_files:
        digest = manifest_files[filename]
        assert payload == bundle_files[filename]
        assert (len(payload), _sha256(payload)) == (digest.byte_length, digest.sha256)

    csv_payload, json_payload = _bom_payloads(artifact_set.result.bom)
    bom_result = extract_candidate_bom(
        source,
        source_csv_payload=csv_payload,
        source_json_payload=json_payload,
    )
    assert tuple(item.filename for item in bom_result.artifacts) == (
        f"assembly/{PROJECT_STEM}.bom.csv",
        f"assembly/{PROJECT_STEM}.bom.json",
    )
    assert tuple(item.payload for item in bom_result.artifacts) == (
        csv_payload,
        json_payload,
    )
    assert tuple(item.digest for item in bom_result.artifacts) == (
        bom_result.evidence.candidate_artifacts
    )
    assert bom_result.evidence.component_count == 23
    assert bom_result.evidence.project_stem == PROJECT_STEM
    assert bom_result.evidence.compiler_bundle_sha256 == source.expected_source_bundle_sha256
    assert bom_result.evidence.compiler_manifest_sha256 == source.expected_manifest_sha256
    assert (
        bom_result.evidence.reference_design_artifact_sha256
        == source.reference_design_artifact_sha256
    )
    assert tuple(
        (source_file.byte_length, source_file.sha256)
        for source_file in bom_result.evidence.source_files
    ) == tuple(
        (artifact.byte_length, artifact.sha256)
        for artifact in bom_result.evidence.candidate_artifacts
    )

    raw_json_rows = json.loads(json_payload)
    assert isinstance(raw_json_rows, list)
    json_rows = cast(list[dict[str, object]], raw_json_rows)
    assert all(type(row.get("reference")) is str for row in json_rows)
    json_by_reference = {cast(str, row["reference"]): row for row in json_rows}
    csv_reader = csv.DictReader(StringIO(csv_payload.decode("utf-8"), newline=""))
    assert tuple(csv_reader.fieldnames or ()) == _BOM_HEADER
    csv_by_reference = {row["reference"]: row for row in csv_reader}
    assert frozenset(json_by_reference) == frozenset(csv_by_reference) == _EXPECTED_REFERENCES
    for line in artifact_set.result.bom:
        json_row = json_by_reference[line.reference]
        csv_row = csv_by_reference[line.reference]
        assert json_row == {
            "assembly_role": line.assembly_role,
            "component_id": line.component_id,
            "fitted": line.fitted,
            "manufacturer": line.manufacturer,
            "manufacturer_part_number": line.manufacturer_part_number,
            "package": line.package,
            "quantity": line.quantity,
            "reference": line.reference,
            "source_evidence_ids": list(line.source_evidence_ids),
            "value": line.value,
        }
        assert csv_row == {
            "assembly_role": line.assembly_role,
            "manufacturer": line.manufacturer,
            "manufacturer_part_number": line.manufacturer_part_number,
            "package": line.package,
            "reference": line.reference,
            "source_evidence_ids": ";".join(line.source_evidence_ids),
            "value": line.value,
        }
    assert json_by_reference["U2"]["manufacturer_part_number"] == "LP38692MPX-3.3/NOPB"
    assert json_by_reference["C3"]["manufacturer_part_number"] == "T598B226M010ATE070"
    assert json_by_reference["R9"]["manufacturer_part_number"] == "WSLP0603R0100FEA"
    assert json_by_reference["J2"]["value"] == "3V3 OUT 100mA MAX / DO NOT APPLY POWER"

    source_pcb = compiled.bundle.board_payload
    derivative_pcb = _synthetic_fill_only_derivative(source_pcb)
    zone_evidence = compare_source_zone_identity(
        source_pcb,
        derivative_pcb,
        source_bundle_sha256=source.expected_source_bundle_sha256,
    )
    assert zone_evidence.source_bundle_sha256 == source.expected_source_bundle_sha256
    assert zone_evidence.source_board_sha256 == _sha256(source_pcb)
    assert zone_evidence.derivative_board_sha256 == _sha256(derivative_pcb)
    assert zone_evidence.generated_fill_node_count >= 1
    assert zone_evidence.zone_count == len(zone_evidence.zones) == 1
    zone = zone_evidence.zones[0]
    assert (zone.zone_uuid, zone.net_name, zone.layer) == (
        "cba00138-ee48-5700-98f9-89ead970dcfa",
        "/GND",
        "B.Cu",
    )
    assert zone.normalized_outline_nm == (
        (500_000, 500_000),
        (500_000, 29_500_000),
        (49_500_000, 29_500_000),
        (49_500_000, 500_000),
    )

    assert compiled.manifest.manufacturing_release_eligible is False
    assert artifact_set.result.manufacturing_release_passed is False
    assert artifact_set.result.manufacturing_blockers

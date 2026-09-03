"""Strict, source-bound BOM artifacts for a manufacturing candidate.

The KiCad compiler bundle deliberately does not invent a bill of materials.  A
candidate therefore copies the reference package's BOM bytes, after proving that
the JSON and CSV are canonical views of the same rows and that every row agrees
with the component identities embedded in both compiled KiCad files.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
from dataclasses import dataclass
from io import StringIO
from typing import Any, cast

from backend.kicad_compile import FileDigest
from backend.kicad_io.sexpr import SExpr, head, parse, scalar_text

from .model import (
    ArtifactDigest,
    CandidateArtifact,
    CandidateContractError,
    CandidateGenerationError,
    CandidateSource,
    canonical_bytes,
    stable_sha256,
)

_MAX_BOM_BYTES = 8 * 1024 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}")
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_REFERENCE = re.compile(r"[A-Z][A-Z0-9]*[1-9][0-9]*")
_CSV_HEADER = (
    "reference",
    "manufacturer",
    "manufacturer_part_number",
    "value",
    "package",
    "assembly_role",
    "source_evidence_ids",
)
_JSON_FIELDS = frozenset(
    {
        "assembly_role",
        "component_id",
        "fitted",
        "manufacturer",
        "manufacturer_part_number",
        "package",
        "quantity",
        "reference",
        "source_evidence_ids",
        "value",
    }
)
_IDENTITY_PROPERTIES = (
    "CanonicalComponentId",
    "ManufacturerPartNumber",
    "Reference",
    "Value",
)
_EVIDENCE_KIND = "source-bound-candidate-bom"
# This intentionally matches ReferenceDesignResult.bom_hash.  It is distinct
# from either raw CSV/JSON byte digest and lets the reference authority compare
# its in-memory BomLine tuple to this independently decoded representation.
_SEMANTIC_DOMAIN = "flux-clone-reference-bom-v1"
_COMPILED_IDENTITY_DOMAIN = "kicad-cam-candidate-bom-compiled-identity-v1"
_EVIDENCE_DOMAIN = "kicad-cam-candidate-bom-evidence-v1"


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise CandidateContractError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_identifier(value: object, label: str) -> str:
    if type(value) is not str or _IDENTIFIER.fullmatch(value) is None:
        raise CandidateContractError(f"{label} must be a canonical identifier")
    return value


def _bom_error(detail: str, *, code: str = "bom_source_invalid") -> CandidateGenerationError:
    return CandidateGenerationError(code, detail)


def _bom_text(value: object, label: str, *, identifier: bool = False) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or len(value) > 1024
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise _bom_error(f"{label} must be trimmed, bounded, control-free text")
    if identifier and _IDENTIFIER.fullmatch(value) is None:
        raise _bom_error(f"{label} must be a canonical identifier")
    if value[0] in "=+-@":
        raise _bom_error(f"{label} has a spreadsheet formula prefix")
    return value


@dataclass(frozen=True, slots=True)
class _BomLine:
    reference: str
    component_id: str
    manufacturer: str
    manufacturer_part_number: str
    value: str
    package: str
    assembly_role: str
    source_evidence_ids: tuple[str, ...]
    quantity: int
    fitted: bool

    def __post_init__(self) -> None:
        if type(self) is not _BomLine:
            raise _bom_error("BOM rows must use the exact internal row type")
        reference = _bom_text(self.reference, "BOM reference")
        if _REFERENCE.fullmatch(reference) is None:
            raise _bom_error("BOM reference is not canonical")
        _bom_text(self.component_id, "BOM component ID", identifier=True)
        for value, label in (
            (self.manufacturer, "BOM manufacturer"),
            (self.manufacturer_part_number, "BOM manufacturer part number"),
            (self.value, "BOM value"),
            (self.package, "BOM package"),
            (self.assembly_role, "BOM assembly role"),
        ):
            _bom_text(value, label)
        if (
            type(self.source_evidence_ids) is not tuple
            or not self.source_evidence_ids
            or any(type(item) is not str for item in self.source_evidence_ids)
        ):
            raise _bom_error("BOM evidence IDs must be a non-empty exact tuple")
        for item in self.source_evidence_ids:
            _bom_text(item, "BOM evidence ID", identifier=True)
        if tuple(sorted(set(self.source_evidence_ids))) != self.source_evidence_ids:
            raise _bom_error("BOM evidence IDs must be sorted and unique")
        if type(self.quantity) is not int or self.quantity != 1:
            raise _bom_error("candidate BOM rows require exact quantity one")
        if type(self.fitted) is not bool or not self.fitted:
            raise _bom_error("candidate BOM rows must be fitted")

    def primitive(self) -> dict[str, object]:
        return {
            "assembly_role": self.assembly_role,
            "component_id": self.component_id,
            "fitted": self.fitted,
            "manufacturer": self.manufacturer,
            "manufacturer_part_number": self.manufacturer_part_number,
            "package": self.package,
            "quantity": self.quantity,
            "reference": self.reference,
            "source_evidence_ids": list(self.source_evidence_ids),
            "value": self.value,
        }

    def csv_row(self) -> tuple[str, ...]:
        return (
            self.reference,
            self.manufacturer,
            self.manufacturer_part_number,
            self.value,
            self.package,
            self.assembly_role,
            ";".join(self.source_evidence_ids),
        )


@dataclass(frozen=True, slots=True)
class _CompiledIdentity:
    reference: str
    component_id: str
    value: str
    manufacturer_part_number: str
    board_uuid: str
    schematic_uuid: str

    def primitive(self) -> dict[str, str]:
        return {
            "board_uuid": self.board_uuid,
            "component_id": self.component_id,
            "manufacturer_part_number": self.manufacturer_part_number,
            "reference": self.reference,
            "schematic_uuid": self.schematic_uuid,
            "value": self.value,
        }


@dataclass(frozen=True, slots=True)
class CandidateBomEvidence:
    """Hash-complete proof that copied BOM artifacts match the compiled design."""

    schema_version: int
    evidence_kind: str
    project_stem: str
    compiler_bundle_sha256: str
    compiler_manifest_sha256: str
    input_graph_sha256: str
    reference_design_artifact_sha256: str | None
    reference_package_manifest_sha256: str | None
    source_files: tuple[FileDigest, ...]
    candidate_artifacts: tuple[ArtifactDigest, ...]
    component_count: int
    bom_semantic_sha256: str
    compiled_identity_sha256: str
    evidence_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not CandidateBomEvidence:
            raise CandidateContractError("candidate BOM evidence must use the exact type")
        if type(self.schema_version) is not int or self.schema_version != 1:
            raise CandidateContractError("candidate BOM evidence schema must be 1")
        if self.evidence_kind != _EVIDENCE_KIND:
            raise CandidateContractError("candidate BOM evidence kind is invalid")
        _require_identifier(self.project_stem, "candidate BOM project stem")
        for value, label in (
            (self.compiler_bundle_sha256, "compiler bundle hash"),
            (self.compiler_manifest_sha256, "compiler manifest hash"),
            (self.input_graph_sha256, "input graph hash"),
            (self.bom_semantic_sha256, "BOM semantic hash"),
            (self.compiled_identity_sha256, "compiled component identity hash"),
            (self.evidence_sha256, "candidate BOM evidence hash"),
        ):
            _require_sha256(value, label)
        for value, label in (
            (self.reference_design_artifact_sha256, "reference artifact hash"),
            (self.reference_package_manifest_sha256, "reference package manifest hash"),
        ):
            if value is not None:
                _require_sha256(value, label)
        if (
            self.reference_package_manifest_sha256 is not None
            and self.reference_design_artifact_sha256 is None
        ):
            raise CandidateContractError(
                "reference package manifest hash requires a reference artifact hash"
            )
        if type(self.component_count) is not int or self.component_count < 1:
            raise CandidateContractError("candidate BOM component count must be positive")
        if (
            type(self.source_files) is not tuple
            or any(type(item) is not FileDigest for item in self.source_files)
            or tuple(
                sorted(
                    self.source_files,
                    key=lambda item: (item.filename.casefold(), item.filename),
                )
            )
            != self.source_files
        ):
            raise CandidateContractError("candidate BOM source files must be exactly sorted")
        if (
            type(self.candidate_artifacts) is not tuple
            or any(type(item) is not ArtifactDigest for item in self.candidate_artifacts)
            or tuple(sorted(self.candidate_artifacts)) != self.candidate_artifacts
        ):
            raise CandidateContractError(
                "candidate BOM artifact digests must be exactly sorted"
            )
        expected_sources = (
            (f"{self.project_stem}.bom.csv", "text/csv"),
            (f"{self.project_stem}.bom.json", "application/json"),
        )
        expected_artifacts = (
            (f"assembly/{self.project_stem}.bom.csv", "text/csv"),
            (f"assembly/{self.project_stem}.bom.json", "application/json"),
        )
        if tuple((item.filename, item.media_type) for item in self.source_files) != (
            expected_sources
        ):
            raise CandidateContractError("candidate BOM source filename inventory drifted")
        if tuple((item.filename, item.media_type) for item in self.candidate_artifacts) != (
            expected_artifacts
        ):
            raise CandidateContractError("candidate BOM artifact filename inventory drifted")
        for source, artifact in zip(
            self.source_files,
            self.candidate_artifacts,
            strict=True,
        ):
            if (
                source.byte_length < 1
                or source.byte_length != artifact.byte_length
                or source.sha256 != artifact.sha256
            ):
                raise CandidateContractError(
                    "candidate BOM artifact digest does not copy its exact source bytes"
                )
        if self.evidence_sha256 != _evidence_sha256(self):
            raise CandidateContractError(
                "candidate BOM evidence hash does not bind the exact evidence"
            )

    def to_primitive(self) -> dict[str, object]:
        return {
            **_evidence_material(self),
            "evidence_sha256": self.evidence_sha256,
        }


@dataclass(frozen=True, slots=True)
class CandidateBomResult:
    """The two copied payloads and the proof that authorizes their inclusion."""

    artifacts: tuple[CandidateArtifact, ...]
    evidence: CandidateBomEvidence

    def __post_init__(self) -> None:
        if type(self) is not CandidateBomResult:
            raise CandidateContractError("candidate BOM result must use the exact type")
        if (
            type(self.artifacts) is not tuple
            or any(type(item) is not CandidateArtifact for item in self.artifacts)
            or tuple(sorted(self.artifacts, key=lambda item: item.filename)) != self.artifacts
        ):
            raise CandidateContractError("candidate BOM artifacts must be exactly sorted")
        if type(self.evidence) is not CandidateBomEvidence:
            raise CandidateContractError("candidate BOM result requires exact evidence")
        if tuple(item.digest for item in self.artifacts) != self.evidence.candidate_artifacts:
            raise CandidateContractError(
                "candidate BOM payloads do not match their evidence inventory"
            )

    @property
    def csv_artifact(self) -> CandidateArtifact:
        return self.artifacts[0]

    @property
    def json_artifact(self) -> CandidateArtifact:
        return self.artifacts[1]


def _file_primitive(item: FileDigest | ArtifactDigest) -> dict[str, object]:
    return {
        "byte_length": item.byte_length,
        "filename": item.filename,
        "media_type": item.media_type,
        "sha256": item.sha256,
    }


def _evidence_material(evidence: CandidateBomEvidence) -> dict[str, object]:
    return {
        "bom_semantic_sha256": evidence.bom_semantic_sha256,
        "candidate_artifacts": [
            _file_primitive(item) for item in evidence.candidate_artifacts
        ],
        "compiled_identity_sha256": evidence.compiled_identity_sha256,
        "compiler_bundle_sha256": evidence.compiler_bundle_sha256,
        "compiler_manifest_sha256": evidence.compiler_manifest_sha256,
        "component_count": evidence.component_count,
        "evidence_kind": evidence.evidence_kind,
        "input_graph_sha256": evidence.input_graph_sha256,
        "project_stem": evidence.project_stem,
        "reference_design_artifact_sha256": (
            evidence.reference_design_artifact_sha256
        ),
        "reference_package_manifest_sha256": (
            evidence.reference_package_manifest_sha256
        ),
        "schema_version": evidence.schema_version,
        "source_files": [_file_primitive(item) for item in evidence.source_files],
    }


def _evidence_sha256(evidence: CandidateBomEvidence) -> str:
    return stable_sha256(_evidence_material(evidence), domain=_EVIDENCE_DOMAIN)


def candidate_bom_evidence_payload(evidence: CandidateBomEvidence) -> bytes:
    """Return canonical UTF-8 JSON evidence with one final LF."""

    if type(evidence) is not CandidateBomEvidence:
        raise CandidateContractError("BOM evidence payload requires exact evidence")
    return canonical_bytes(evidence.to_primitive()) + b"\n"


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _bom_error(f"BOM JSON has duplicate key {key!r}")
        result[key] = value
    return result


def _parse_json_rows(payload: bytes) -> tuple[_BomLine, ...]:
    if type(payload) is not bytes or not payload or len(payload) > _MAX_BOM_BYTES:
        raise CandidateContractError("source BOM JSON must be bounded non-empty exact bytes")
    try:
        text = payload.decode("utf-8", errors="strict")
        decoded = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=lambda value: (_ for _ in ()).throw(
                _bom_error(f"BOM JSON has non-finite value {value!r}")
            ),
        )
    except CandidateGenerationError:
        raise
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise _bom_error("BOM JSON is not strict UTF-8 JSON") from exc
    if type(decoded) is not list or not decoded:
        raise _bom_error("BOM JSON root must be a non-empty array")
    if canonical_bytes(decoded) + b"\n" != payload:
        raise _bom_error("BOM JSON is not exact canonical JSON with one final LF")

    rows: list[_BomLine] = []
    for index, value in enumerate(cast(list[object], decoded)):
        if type(value) is not dict:
            raise _bom_error(f"BOM JSON row {index} must be an exact object")
        raw = cast(dict[object, object], value)
        if any(type(key) is not str for key in raw) or frozenset(raw) != _JSON_FIELDS:
            raise _bom_error(f"BOM JSON row {index} fields do not match the closed schema")
        row = cast(dict[str, object], raw)
        evidence_ids = row["source_evidence_ids"]
        if type(evidence_ids) is not list or any(
            type(item) is not str for item in cast(list[object], evidence_ids)
        ):
            raise _bom_error(f"BOM JSON row {index} evidence IDs must be an array of text")
        rows.append(
            _BomLine(
                reference=cast(str, row["reference"]),
                component_id=cast(str, row["component_id"]),
                manufacturer=cast(str, row["manufacturer"]),
                manufacturer_part_number=cast(str, row["manufacturer_part_number"]),
                value=cast(str, row["value"]),
                package=cast(str, row["package"]),
                assembly_role=cast(str, row["assembly_role"]),
                source_evidence_ids=tuple(cast(list[str], evidence_ids)),
                quantity=cast(int, row["quantity"]),
                fitted=cast(bool, row["fitted"]),
            )
        )
    result = tuple(rows)
    references = tuple(item.reference for item in result)
    component_ids = tuple(item.component_id for item in result)
    if references != tuple(sorted(references)) or len(references) != len(set(references)):
        raise _bom_error("BOM JSON references must be sorted and unique")
    if len(component_ids) != len(set(component_ids)):
        raise _bom_error("BOM JSON component IDs must be unique")
    return result


def _render_csv(rows: tuple[_BomLine, ...]) -> bytes:
    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(_CSV_HEADER)
    for row in rows:
        writer.writerow(row.csv_row())
    return output.getvalue().encode("utf-8")


def _parse_csv_rows(payload: bytes, expected: tuple[_BomLine, ...]) -> None:
    if type(payload) is not bytes or not payload or len(payload) > _MAX_BOM_BYTES:
        raise CandidateContractError("source BOM CSV must be bounded non-empty exact bytes")
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise _bom_error("BOM CSV is not strict UTF-8") from exc
    if "\r" in text or not text.endswith("\n"):
        raise _bom_error("BOM CSV must use LF records and one final LF")
    if any(ord(character) < 32 and character not in {"\n", "\t"} for character in text):
        raise _bom_error("BOM CSV contains an unsupported control byte")
    try:
        parsed = tuple(tuple(row) for row in csv.reader(StringIO(text, newline=""), strict=True))
    except csv.Error as exc:
        raise _bom_error("BOM CSV violates the strict CSV grammar") from exc
    expected_rows = (_CSV_HEADER, *(row.csv_row() for row in expected))
    if parsed != expected_rows:
        raise _bom_error(
            "BOM CSV does not exactly match the canonical JSON rows",
            code="bom_cross_format_mismatch",
        )
    if _render_csv(expected) != payload:
        raise _bom_error("BOM CSV is not the exact deterministic serialization")


def _children(expression: SExpr, child_head: str) -> tuple[tuple[SExpr, ...], ...]:
    if not isinstance(expression, tuple):
        return ()
    return tuple(
        child
        for child in expression[1:]
        if isinstance(child, tuple) and head(child) == child_head
    )


def _one_scalar_child(expression: tuple[SExpr, ...], child_head: str, label: str) -> str:
    children = _children(expression, child_head)
    if len(children) != 1 or len(children[0]) != 2:
        raise _bom_error(f"{label} requires one exact {child_head} scalar")
    try:
        return scalar_text(children[0][1], label=label)
    except Exception as exc:
        raise _bom_error(f"{label} scalar is invalid") from exc


def _compiled_entities(
    payload: bytes,
    *,
    root_head: str,
    entity_head: str,
    label: str,
) -> dict[str, tuple[dict[str, str], str]]:
    try:
        root = parse(payload)
    except Exception as exc:
        raise _bom_error(f"compiled {label} cannot be parsed for BOM identity") from exc
    if not isinstance(root, tuple) or head(root) != root_head:
        raise _bom_error(f"compiled {label} has the wrong root expression")
    result: dict[str, tuple[dict[str, str], str]] = {}
    entities = _children(root, entity_head)
    if not entities:
        raise _bom_error(f"compiled {label} has no component entities")
    for index, entity in enumerate(entities):
        properties: dict[str, str] = {}
        for prop in _children(entity, "property"):
            if len(prop) < 3:
                raise _bom_error(f"compiled {label} property {index} is malformed")
            try:
                name = scalar_text(prop[1], label=f"{label} property name")
                value = scalar_text(prop[2], label=f"{label} property value")
            except Exception as exc:
                raise _bom_error(f"compiled {label} property {index} is not scalar") from exc
            if name in properties:
                raise _bom_error(f"compiled {label} has duplicate property {name!r}")
            properties[name] = value
        if any(name not in properties for name in _IDENTITY_PROPERTIES):
            raise _bom_error(f"compiled {label} is missing BOM identity properties")
        reference = _bom_text(properties["Reference"], f"compiled {label} reference")
        if reference in result:
            raise _bom_error(f"compiled {label} has duplicate reference {reference!r}")
        entity_uuid = _one_scalar_child(entity, "uuid", f"compiled {label} entity UUID")
        result[reference] = (properties, entity_uuid)
    return result


def _manifest_component_ids(source: CandidateSource, target_kind: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for binding in source.compiled_project.manifest.identity_bindings:
        if binding.source_kind != "component" or binding.target_kind != target_kind:
            continue
        if binding.source_id in result or len(binding.emitted_ids) != 1:
            raise _bom_error(
                f"compiler manifest has ambiguous {target_kind} component bindings"
            )
        result[binding.source_id] = binding.emitted_ids[0]
    if not result:
        raise _bom_error(f"compiler manifest has no {target_kind} component bindings")
    return result


def _compiled_identities(
    source: CandidateSource,
    rows: tuple[_BomLine, ...],
) -> tuple[_CompiledIdentity, ...]:
    bundle = source.compiled_project.bundle
    board = _compiled_entities(
        bundle.board_payload,
        root_head="kicad_pcb",
        entity_head="footprint",
        label="PCB",
    )
    schematic = _compiled_entities(
        bundle.schematic_payload,
        root_head="kicad_sch",
        entity_head="symbol",
        label="schematic",
    )
    references = {row.reference for row in rows}
    if set(board) != references or set(schematic) != references:
        raise _bom_error(
            "BOM, PCB, and schematic reference populations differ",
            code="bom_compiler_parity_mismatch",
        )
    board_bindings = _manifest_component_ids(source, "pcb-footprint")
    schematic_bindings = _manifest_component_ids(source, "schematic-symbol")
    component_ids = {row.component_id for row in rows}
    if set(board_bindings) != component_ids or set(schematic_bindings) != component_ids:
        raise _bom_error(
            "BOM component IDs differ from compiler manifest component bindings",
            code="bom_compiler_parity_mismatch",
        )

    identities: list[_CompiledIdentity] = []
    for row in rows:
        board_properties, board_uuid = board[row.reference]
        schematic_properties, schematic_uuid = schematic[row.reference]
        expected = {
            "CanonicalComponentId": row.component_id,
            "ManufacturerPartNumber": row.manufacturer_part_number,
            "Reference": row.reference,
            "Value": row.value,
        }
        if any(board_properties[name] != value for name, value in expected.items()) or any(
            schematic_properties[name] != value for name, value in expected.items()
        ):
            raise _bom_error(
                f"BOM identity differs from compiled component {row.reference}",
                code="bom_compiler_parity_mismatch",
            )
        if (
            board_bindings[row.component_id] != board_uuid
            or schematic_bindings[row.component_id] != schematic_uuid
        ):
            raise _bom_error(
                f"compiler manifest UUID binding differs for {row.reference}",
                code="bom_compiler_parity_mismatch",
            )
        identities.append(
            _CompiledIdentity(
                row.reference,
                row.component_id,
                row.value,
                row.manufacturer_part_number,
                board_uuid,
                schematic_uuid,
            )
        )
    return tuple(identities)


def _validate_compiled_source(source: CandidateSource) -> None:
    compiled = source.compiled_project
    manifest = compiled.manifest
    expected_manifest_payload = canonical_bytes(manifest.to_primitive()) + b"\n"
    if (
        expected_manifest_payload != compiled.manifest_payload
        or _sha256(compiled.manifest_payload) != compiled.manifest_sha256
        or compiled.manifest_sha256 != source.expected_manifest_sha256
    ):
        raise _bom_error(
            "candidate source compiler manifest bytes are not exactly bound",
            code="bom_compiler_source_invalid",
        )
    actual_files = {
        item.relative_name: item for item in compiled.bundle.all_files
    }
    if len(actual_files) != len(compiled.bundle.all_files) or len(actual_files) != len(
        manifest.files
    ):
        raise _bom_error(
            "candidate source compiler file inventory is ambiguous",
            code="bom_compiler_source_invalid",
        )
    for item in manifest.files:
        actual = actual_files.get(item.filename)
        if (
            actual is None
            or actual.media_type != item.media_type
            or len(actual.payload) != item.byte_length
            or actual.sha256 != item.sha256
        ):
            raise _bom_error(
                f"candidate source compiler file is not bound: {item.filename}",
                code="bom_compiler_source_invalid",
            )
    bundle_body = canonical_bytes(
        tuple(
            {
                "filename": item.filename,
                "byteLength": item.byte_length,
                "sha256": item.sha256,
            }
            for item in manifest.files
        )
    ) + b"\n"
    bundle_sha256 = _sha256(b"flux-clone-compiled-bundle-v1\x00" + bundle_body)
    if (
        bundle_sha256 != manifest.output_bundle_sha256
        or bundle_sha256 != source.expected_source_bundle_sha256
    ):
        raise _bom_error(
            "candidate source compiler bundle digest is not exactly bound",
            code="bom_compiler_source_invalid",
        )


def _new_evidence(
    source: CandidateSource,
    *,
    rows: tuple[_BomLine, ...],
    identities: tuple[_CompiledIdentity, ...],
    source_files: tuple[FileDigest, ...],
    artifacts: tuple[CandidateArtifact, ...],
) -> CandidateBomEvidence:
    values: dict[str, Any] = {
        "schema_version": 1,
        "evidence_kind": _EVIDENCE_KIND,
        "project_stem": source.compiled_project.bundle.stem,
        "compiler_bundle_sha256": source.expected_source_bundle_sha256,
        "compiler_manifest_sha256": source.expected_manifest_sha256,
        "input_graph_sha256": source.compiled_project.manifest.input_graph_sha256,
        "reference_design_artifact_sha256": source.reference_design_artifact_sha256,
        "reference_package_manifest_sha256": source.reference_package_manifest_sha256,
        "source_files": source_files,
        "candidate_artifacts": tuple(item.digest for item in artifacts),
        "component_count": len(rows),
        "bom_semantic_sha256": stable_sha256(
            tuple(row.primitive() for row in rows),
            domain=_SEMANTIC_DOMAIN,
        ),
        "compiled_identity_sha256": stable_sha256(
            tuple(item.primitive() for item in identities),
            domain=_COMPILED_IDENTITY_DOMAIN,
        ),
    }
    values["evidence_sha256"] = stable_sha256(
        {
            "bom_semantic_sha256": values["bom_semantic_sha256"],
            "candidate_artifacts": [
                _file_primitive(item)
                for item in cast(tuple[ArtifactDigest, ...], values["candidate_artifacts"])
            ],
            "compiled_identity_sha256": values["compiled_identity_sha256"],
            "compiler_bundle_sha256": values["compiler_bundle_sha256"],
            "compiler_manifest_sha256": values["compiler_manifest_sha256"],
            "component_count": values["component_count"],
            "evidence_kind": values["evidence_kind"],
            "input_graph_sha256": values["input_graph_sha256"],
            "project_stem": values["project_stem"],
            "reference_design_artifact_sha256": values[
                "reference_design_artifact_sha256"
            ],
            "reference_package_manifest_sha256": values[
                "reference_package_manifest_sha256"
            ],
            "schema_version": values["schema_version"],
            "source_files": [
                _file_primitive(item)
                for item in cast(tuple[FileDigest, ...], values["source_files"])
            ],
        },
        domain=_EVIDENCE_DOMAIN,
    )
    return CandidateBomEvidence(**values)


def extract_candidate_bom(
    source: CandidateSource,
    *,
    source_csv_payload: bytes,
    source_json_payload: bytes,
) -> CandidateBomResult:
    """Copy and validate the two authoritative reference-package BOM files.

    No BOM field is inferred from KiCad.  The KiCad and compiler identities are
    used as an independent parity oracle for the authoritative source rows.
    """

    if type(source) is not CandidateSource:
        raise CandidateContractError("candidate BOM source must use exact CandidateSource")
    _validate_compiled_source(source)
    rows = _parse_json_rows(source_json_payload)
    _parse_csv_rows(source_csv_payload, rows)
    identities = _compiled_identities(source, rows)

    stem = source.compiled_project.bundle.stem
    source_files = (
        FileDigest(
            f"{stem}.bom.csv",
            "text/csv",
            len(source_csv_payload),
            _sha256(source_csv_payload),
        ),
        FileDigest(
            f"{stem}.bom.json",
            "application/json",
            len(source_json_payload),
            _sha256(source_json_payload),
        ),
    )
    artifacts = tuple(
        sorted(
            (
                CandidateArtifact(
                    f"assembly/{stem}.bom.csv",
                    "text/csv",
                    source_csv_payload,
                    source_files[0].sha256,
                ),
                CandidateArtifact(
                    f"assembly/{stem}.bom.json",
                    "application/json",
                    source_json_payload,
                    source_files[1].sha256,
                ),
            ),
            key=lambda item: item.filename,
        )
    )
    evidence = _new_evidence(
        source,
        rows=rows,
        identities=identities,
        source_files=source_files,
        artifacts=artifacts,
    )
    return CandidateBomResult(artifacts, evidence)


__all__ = (
    "CandidateBomEvidence",
    "CandidateBomResult",
    "candidate_bom_evidence_payload",
    "extract_candidate_bom",
)

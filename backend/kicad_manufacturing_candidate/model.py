"""Immutable models for a non-release KiCad CAM candidate."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, fields, is_dataclass
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from backend.kicad_compile import CompiledProject

if TYPE_CHECKING:
    from .bom import CandidateBomResult
    from .filled_board_semantics import FilledBoardSemanticEvidence
    from .source_zone_identity import SourceZoneIdentityEvidence

_SHA256 = re.compile(r"[0-9a-f]{64}")
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_LIBRARY_ONLY_TYPES = frozenset({"lib_footprint_issues", "lib_footprint_mismatch"})
_KNOWN_IGNORED_CHECK_KEYS = frozenset(
    {
        "footprint_filters_mismatch",
        "footprint_type_mismatch",
        "missing_courtyard",
        "track_not_centered_on_via",
        "tuning_profile_track_geometries",
    }
)
NON_FABRICATION_NOTICE_FILENAME = "NOT_FOR_FABRICATION.txt"
NON_FABRICATION_NOTICE_PAYLOAD = (
    b"NOT FOR FABRICATION OR MANUFACTURING RELEASE\n"
    b"manufacturing_release_eligible=false\n"
    b"\n"
    b"This KiCad CAM candidate is for prototype/reference engineering review only.\n"
    b"Do not send these files to a fabricator, assembler, or contract manufacturer\n"
    b"for production or physical build without explicit qualified physical/CM approval.\n"
    b"\n"
    b"Required before any physical build: fabricator/CM DFM and CAM approval, approved\n"
    b"stackup and process capability review, component/source qualification, and documented\n"
    b"electrical, thermal, functional, and first-article review.\n"
    b"\n"
    b"3V3 is OUTPUT ONLY (100 mA max). DO NOT APPLY POWER TO THE 3V3 OUTPUT.\n"
)
NON_FABRICATION_NOTICE_SHA256 = hashlib.sha256(NON_FABRICATION_NOTICE_PAYLOAD).hexdigest()


class CandidateContractError(ValueError):
    """An input or output crossed the candidate boundary with an invalid shape."""


class CandidateGenerationError(RuntimeError):
    """KiCad could not produce a trustworthy derivative candidate."""

    def __init__(self, code: str, detail: str) -> None:
        _require_identifier(code, "failure code")
        _require_text(detail, "failure detail")
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")


def _require_text(value: object, label: str) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or any(ord(character) < 32 for character in value)
    ):
        raise CandidateContractError(f"{label} must be exact trimmed control-free text")
    return value


def _require_identifier(value: object, label: str) -> str:
    text = _require_text(value, label)
    if _IDENTIFIER.fullmatch(text) is None:
        raise CandidateContractError(f"{label} must be a canonical identifier")
    return text


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise CandidateContractError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _canonical_data(value: Any) -> Any:
    if value is None or type(value) in {str, int, bool}:
        return value
    if isinstance(value, Enum):
        return _canonical_data(value.value)
    if is_dataclass(value) and not isinstance(value, type):
        dataclass_value = cast(Any, value)
        return {
            field.name: _canonical_data(getattr(dataclass_value, field.name))
            for field in fields(dataclass_value)
        }
    if type(value) in {tuple, list}:
        sequence = cast(tuple[Any, ...] | list[Any], value)
        return [_canonical_data(item) for item in sequence]
    if type(value) is dict:
        untyped_mapping = cast(dict[object, Any], value)
        if any(type(key) is not str for key in untyped_mapping):
            raise CandidateContractError("canonical object keys must be exact strings")
        mapping = cast(dict[str, Any], untyped_mapping)
        return {key: _canonical_data(mapping[key]) for key in sorted(mapping)}
    raise CandidateContractError(f"unsupported canonical value: {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        _canonical_data(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def stable_sha256(value: Any, *, domain: str) -> str:
    _require_identifier(domain, "hash domain")
    return hashlib.sha256(domain.encode("ascii") + b"\x00" + canonical_bytes(value)).hexdigest()


@dataclass(frozen=True, slots=True)
class CandidateSource:
    """Host-owned compiler result with independently supplied exact hash expectations."""

    compiled_project: CompiledProject
    expected_source_bundle_sha256: str
    expected_manifest_sha256: str
    reference_design_artifact_sha256: str | None = None
    reference_package_manifest_sha256: str | None = None
    reference_publication_manifest_sha256: str | None = None
    bom_result: CandidateBomResult | None = None

    def __post_init__(self) -> None:
        if type(self) is not CandidateSource:
            raise CandidateContractError("candidate source must use the exact type")
        if type(self.compiled_project) is not CompiledProject:
            raise CandidateContractError("candidate source requires exact CompiledProject")
        _require_sha256(self.expected_source_bundle_sha256, "expected source bundle hash")
        _require_sha256(self.expected_manifest_sha256, "expected compiler manifest hash")
        for value, label in (
            (self.reference_design_artifact_sha256, "reference design artifact hash"),
            (self.reference_package_manifest_sha256, "reference package manifest hash"),
            (
                self.reference_publication_manifest_sha256,
                "reference publication manifest hash",
            ),
        ):
            if value is not None:
                _require_sha256(value, label)
        if (
            self.reference_package_manifest_sha256 is not None
            or self.reference_publication_manifest_sha256 is not None
        ) and self.reference_design_artifact_sha256 is None:
            raise CandidateContractError(
                "reference package/publication hashes require an artifact hash"
            )
        if self.bom_result is not None:
            from .bom import CandidateBomResult

            if type(self.bom_result) is not CandidateBomResult:
                raise CandidateContractError("candidate BOM result must use the exact type")
            evidence = self.bom_result.evidence
            if (
                evidence.project_stem != self.compiled_project.bundle.stem
                or evidence.compiler_bundle_sha256 != self.expected_source_bundle_sha256
                or evidence.compiler_manifest_sha256 != self.expected_manifest_sha256
                or evidence.reference_design_artifact_sha256
                != self.reference_design_artifact_sha256
                or evidence.reference_package_manifest_sha256
                != self.reference_package_manifest_sha256
            ):
                raise CandidateContractError("candidate BOM evidence subject is inconsistent")


@dataclass(frozen=True, slots=True)
class CandidatePolicy:
    """Host-owned closed policy; request callers cannot supply paths or CLI options."""

    policy_id: str = "flux-kicad10-cam-candidate"
    policy_version: str = "2.0.0"
    allowed_library_only_types: tuple[str, ...] = ()
    acknowledged_ignored_check_keys: tuple[str, ...] = ()
    timeout_seconds: int = 120
    max_source_files: int = 256
    max_source_file_bytes: int = 64 * 1024 * 1024
    max_source_bundle_bytes: int = 256 * 1024 * 1024
    max_filled_board_bytes: int = 128 * 1024 * 1024
    max_report_bytes: int = 16 * 1024 * 1024
    max_artifact_bytes: int = 128 * 1024 * 1024
    max_candidate_bytes: int = 512 * 1024 * 1024
    max_stdout_bytes: int = 2 * 1024 * 1024
    max_stderr_bytes: int = 2 * 1024 * 1024

    def __post_init__(self) -> None:
        if type(self) is not CandidatePolicy:
            raise CandidateContractError("candidate policy must use the exact type")
        _require_identifier(self.policy_id, "policy ID")
        _require_identifier(self.policy_version, "policy version")
        if type(self.allowed_library_only_types) is not tuple or any(
            type(item) is not str or _IDENTIFIER.fullmatch(item) is None
            for item in self.allowed_library_only_types
        ):
            raise CandidateContractError(
                "library-only classifications must be an exact canonical identifier tuple"
            )
        if tuple(sorted(set(self.allowed_library_only_types))) != self.allowed_library_only_types:
            raise CandidateContractError("library-only classifications must be sorted and unique")
        if not set(self.allowed_library_only_types).issubset(_LIBRARY_ONLY_TYPES):
            raise CandidateContractError(
                "library-only classifications contain a non-library DRC type"
            )
        if type(self.acknowledged_ignored_check_keys) is not tuple or tuple(
            sorted(set(self.acknowledged_ignored_check_keys))
        ) != self.acknowledged_ignored_check_keys:
            raise CandidateContractError(
                "acknowledged ignored-check keys must be a sorted unique exact tuple"
            )
        if not set(self.acknowledged_ignored_check_keys).issubset(
            _KNOWN_IGNORED_CHECK_KEYS
        ):
            raise CandidateContractError("policy acknowledges an unknown ignored-check key")
        for field_name in (
            "timeout_seconds",
            "max_source_files",
            "max_source_file_bytes",
            "max_source_bundle_bytes",
            "max_filled_board_bytes",
            "max_report_bytes",
            "max_artifact_bytes",
            "max_candidate_bytes",
            "max_stdout_bytes",
            "max_stderr_bytes",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 1:
                raise CandidateContractError(f"{field_name} must be a positive exact integer")

    @property
    def policy_sha256(self) -> str:
        return stable_sha256(self, domain="kicad-cam-candidate-policy-v2")


@dataclass(frozen=True, slots=True)
class CandidateHostConfiguration:
    executable: Path
    executable_sha256: str
    kicad_version: str
    temp_root: Path

    def __post_init__(self) -> None:
        if type(self) is not CandidateHostConfiguration:
            raise CandidateContractError("candidate host configuration must use the exact type")
        if type(self.executable) is not type(Path()) or not self.executable.is_absolute():
            raise CandidateContractError("KiCad executable must be an absolute Path")
        if self.executable.name.lower() not in {"kicad-cli", "kicad-cli.exe"}:
            raise CandidateContractError("candidate host executable must be kicad-cli")
        _require_sha256(self.executable_sha256, "KiCad executable hash")
        version = _require_text(self.kicad_version, "KiCad version")
        if re.fullmatch(r"10\.0\.[0-9]+", version) is None:
            raise CandidateContractError("candidate host must pin a KiCad 10.0 patch version")
        if type(self.temp_root) is not type(Path()) or not self.temp_root.is_absolute():
            raise CandidateContractError("candidate temp root must be an absolute Path")


@dataclass(frozen=True, slots=True, order=True)
class ArtifactDigest:
    filename: str
    media_type: str
    byte_length: int
    sha256: str

    def __post_init__(self) -> None:
        if type(self) is not ArtifactDigest:
            raise CandidateContractError("artifact digest must use the exact type")
        _require_text(self.filename, "artifact filename")
        if (
            "/" not in self.filename
            and self.filename != NON_FABRICATION_NOTICE_FILENAME
        ) or self.filename.startswith(("/", "\\")):
            raise CandidateContractError("artifact filename must be a contained relative path")
        if "\\" in self.filename or any(
            part in {"", ".", ".."} for part in self.filename.split("/")
        ):
            raise CandidateContractError("artifact filename is not canonical")
        _require_text(self.media_type, "artifact media type")
        if type(self.byte_length) is not int or self.byte_length < 1:
            raise CandidateContractError("artifact byte length must be positive")
        _require_sha256(self.sha256, "artifact hash")


@dataclass(frozen=True, slots=True, order=True)
class CandidateArtifact:
    filename: str
    media_type: str
    payload: bytes
    sha256: str

    def __post_init__(self) -> None:
        if type(self) is not CandidateArtifact:
            raise CandidateContractError("candidate artifact must use the exact type")
        if type(self.payload) is not bytes or not self.payload:
            raise CandidateContractError("candidate artifact payload must be non-empty exact bytes")
        digest = ArtifactDigest(self.filename, self.media_type, len(self.payload), self.sha256)
        del digest
        if hashlib.sha256(self.payload).hexdigest() != self.sha256:
            raise CandidateContractError("candidate artifact hash does not bind its payload")

    @property
    def digest(self) -> ArtifactDigest:
        return ArtifactDigest(self.filename, self.media_type, len(self.payload), self.sha256)


@dataclass(frozen=True, slots=True, order=True)
class CommandReceipt:
    stage: str
    logical_argv: tuple[str, ...]
    argv_sha256: str
    exit_code: int
    stdout_sha256: str
    stderr_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not CommandReceipt:
            raise CandidateContractError("command receipt must use the exact type")
        _require_identifier(self.stage, "command stage")
        if type(self.logical_argv) is not tuple or not self.logical_argv or any(
            type(item) is not str or not item for item in self.logical_argv
        ):
            raise CandidateContractError("logical argv must be a non-empty exact string tuple")
        if self.logical_argv[0] != "kicad-cli":
            raise CandidateContractError("logical argv must hide the host executable path")
        if any(
            "<WORKDIR>" not in item and ("/" in item or "\\" in item)
            for item in self.logical_argv[1:]
        ):
            raise CandidateContractError("logical argv may not expose host paths")
        for value, label in (
            (self.argv_sha256, "argv hash"),
            (self.stdout_sha256, "stdout hash"),
            (self.stderr_sha256, "stderr hash"),
        ):
            _require_sha256(value, label)
        if self.argv_sha256 != stable_sha256(
            self.logical_argv, domain="kicad-cam-candidate-argv-v1"
        ):
            raise CandidateContractError("argv hash does not bind logical argv")
        if type(self.exit_code) is not int:
            raise CandidateContractError("command exit code must be an exact integer")


@dataclass(frozen=True, slots=True)
class CandidateReceipt:
    schema_version: int
    receipt_kind: str
    manufacturing_release_eligible: bool
    source_bundle_sha256: str
    source_manifest_sha256: str
    reference_design_artifact_sha256: str | None
    reference_package_manifest_sha256: str | None
    reference_publication_manifest_sha256: str | None
    source_file_digests: tuple[ArtifactDigest, ...]
    source_board_sha256: str
    non_fabrication_notice_filename: str
    non_fabrication_notice_sha256: str
    bom_evidence_sha256: str | None
    bom_component_count: int
    bom_artifacts: tuple[ArtifactDigest, ...]
    canonical_source_unchanged: bool
    runtime_prl_unchanged: bool
    runtime_support_policy_version: str
    runtime_support_template_sha256: str
    runtime_support_manifest_sha256: str
    runtime_prl_sha256: str
    kicad_executable_sha256: str
    kicad_version: str
    policy_sha256: str
    filled_board_sha256: str
    filled_board_bytes: int
    filled_board_normalizer_id: str
    filled_board_normalizer_version: str
    filled_board_semantic_sha256: str
    filled_board_semantic_evidence_sha256: str
    filled_copper_geometry_sha256: str
    filled_zone_count: int
    filled_polygon_count: int
    filled_vertex_count: int
    filled_area2_nm2: int
    volatile_property_uuid_count: int
    volatile_property_paths_sha256: str
    authored_zone_unchanged: bool
    authored_zone_evidence_sha256: str | None
    authored_zone_intent_sha256: str | None
    authored_zone_count: int
    generated_fill_node_count: int
    drc_report_sha256: str
    normalized_drc_sha256: str
    normalized_drc_evidence_sha256: str
    drc_finding_count: int
    library_only_finding_types: tuple[str, ...]
    ignored_check_keys: tuple[str, ...]
    cam_output_determinism: str
    commands: tuple[CommandReceipt, ...]
    cam_artifacts: tuple[ArtifactDigest, ...]
    cam_inventory_sha256: str
    cam_content_validation_sha256: str
    candidate_sha256: str
    receipt_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not CandidateReceipt:
            raise CandidateContractError("candidate receipt must use the exact type")
        if type(self.schema_version) is not int or self.schema_version != 3:
            raise CandidateContractError("candidate receipt schema must be 3")
        if self.receipt_kind != "non-release-kicad-cam-candidate":
            raise CandidateContractError("candidate receipt kind is invalid")
        if (
            type(self.manufacturing_release_eligible) is not bool
            or self.manufacturing_release_eligible
        ):
            raise CandidateContractError("candidate receipt can never authorize manufacturing")
        for value, label in (
            (self.source_bundle_sha256, "source bundle hash"),
            (self.source_manifest_sha256, "source manifest hash"),
            (self.source_board_sha256, "source board hash"),
            (self.non_fabrication_notice_sha256, "non-fabrication notice hash"),
            (self.runtime_support_template_sha256, "runtime-support template hash"),
            (self.runtime_support_manifest_sha256, "runtime-support manifest hash"),
            (self.runtime_prl_sha256, "runtime PRL hash"),
            (self.kicad_executable_sha256, "KiCad executable hash"),
            (self.policy_sha256, "policy hash"),
            (self.filled_board_sha256, "filled board hash"),
            (self.filled_board_semantic_sha256, "filled board semantic hash"),
            (
                self.filled_board_semantic_evidence_sha256,
                "filled board semantic-evidence hash",
            ),
            (self.filled_copper_geometry_sha256, "filled copper geometry hash"),
            (
                self.volatile_property_paths_sha256,
                "volatile property path hash",
            ),
            (self.drc_report_sha256, "DRC report hash"),
            (self.normalized_drc_sha256, "normalized DRC hash"),
            (self.normalized_drc_evidence_sha256, "normalized DRC evidence hash"),
            (self.cam_inventory_sha256, "CAM inventory hash"),
            (self.cam_content_validation_sha256, "CAM content-validation hash"),
            (self.candidate_sha256, "candidate hash"),
            (self.receipt_sha256, "receipt hash"),
        ):
            _require_sha256(value, label)
        for value, label in (
            (self.bom_evidence_sha256, "BOM evidence hash"),
            (self.authored_zone_evidence_sha256, "authored-zone evidence hash"),
            (self.authored_zone_intent_sha256, "authored-zone intent hash"),
        ):
            if value is not None:
                _require_sha256(value, label)
        for value, label in (
            (self.reference_design_artifact_sha256, "reference design artifact hash"),
            (self.reference_package_manifest_sha256, "reference package manifest hash"),
            (
                self.reference_publication_manifest_sha256,
                "reference publication manifest hash",
            ),
        ):
            if value is not None:
                _require_sha256(value, label)
        if (
            self.reference_package_manifest_sha256 is not None
            or self.reference_publication_manifest_sha256 is not None
        ) and self.reference_design_artifact_sha256 is None:
            raise CandidateContractError(
                "receipt reference package/publication hashes require an artifact hash"
            )
        _require_text(self.kicad_version, "KiCad version")
        if self.non_fabrication_notice_filename != NON_FABRICATION_NOTICE_FILENAME:
            raise CandidateContractError("non-fabrication notice filename is invalid")
        if self.non_fabrication_notice_sha256 != NON_FABRICATION_NOTICE_SHA256:
            raise CandidateContractError("non-fabrication notice hash is invalid")
        _require_identifier(self.filled_board_normalizer_id, "filled-board normalizer ID")
        _require_identifier(
            self.filled_board_normalizer_version,
            "filled-board normalizer version",
        )
        _require_identifier(
            self.runtime_support_policy_version,
            "runtime-support policy version",
        )
        if self.cam_output_determinism != "run-specific-content-addressed":
            raise CandidateContractError(
                "KiCad CAM output must be labeled run-specific and content-addressed"
            )
        for value, label in (
            (self.canonical_source_unchanged, "source unchanged proof"),
            (self.runtime_prl_unchanged, "runtime PRL unchanged proof"),
            (self.authored_zone_unchanged, "authored-zone unchanged proof"),
        ):
            if type(value) is not bool or not value:
                raise CandidateContractError(f"{label} must be exact true")
        for value, label in (
            (self.filled_board_bytes, "filled board size"),
            (self.filled_zone_count, "filled-board zone count"),
            (self.filled_polygon_count, "filled polygon count"),
            (self.filled_vertex_count, "filled vertex count"),
            (self.filled_area2_nm2, "filled doubled area"),
            (self.volatile_property_uuid_count, "volatile-property UUID count"),
            (self.bom_component_count, "BOM component count"),
            (self.authored_zone_count, "authored-zone count"),
            (self.generated_fill_node_count, "generated fill-node count"),
            (self.drc_finding_count, "DRC finding count"),
        ):
            if type(value) is not int or value < 0:
                raise CandidateContractError(f"{label} must be a non-negative exact integer")
        for collection, item_type, label in (
            (self.source_file_digests, ArtifactDigest, "source file digests"),
            (self.bom_artifacts, ArtifactDigest, "BOM artifact digests"),
            (self.commands, CommandReceipt, "command receipts"),
            (self.cam_artifacts, ArtifactDigest, "CAM artifact digests"),
        ):
            if type(collection) is not tuple or any(
                type(item) is not item_type for item in collection
            ):
                raise CandidateContractError(f"{label} must be an exact immutable tuple")
        if tuple(sorted(self.source_file_digests)) != self.source_file_digests:
            raise CandidateContractError("source file digests must be sorted")
        if tuple(sorted(self.bom_artifacts)) != self.bom_artifacts:
            raise CandidateContractError("BOM artifact digests must be sorted")
        if tuple(sorted(self.cam_artifacts)) != self.cam_artifacts:
            raise CandidateContractError("CAM artifact digests must be sorted")
        source_boards = tuple(
            item
            for item in self.source_file_digests
            if item.filename.casefold().endswith(".kicad_pcb")
        )
        if len(source_boards) != 1 or source_boards[0].sha256 != self.source_board_sha256:
            raise CandidateContractError("source board hash is not bound by source inventory")
        has_bom = self.bom_evidence_sha256 is not None
        if has_bom != bool(self.bom_artifacts) or has_bom != (self.bom_component_count > 0):
            raise CandidateContractError("candidate BOM evidence is incomplete")
        if self.bom_artifacts and (
            len(self.bom_artifacts) != 2
            or not self.bom_artifacts[0].filename.endswith(".bom.csv")
            or self.bom_artifacts[0].media_type != "text/csv"
            or not self.bom_artifacts[1].filename.endswith(".bom.json")
            or self.bom_artifacts[1].media_type != "application/json"
        ):
            raise CandidateContractError("candidate BOM artifact inventory is malformed")
        has_zones = self.authored_zone_count > 0
        if (
            has_zones != (self.authored_zone_evidence_sha256 is not None)
            or has_zones != (self.authored_zone_intent_sha256 is not None)
            or has_zones != (self.generated_fill_node_count > 0)
        ):
            raise CandidateContractError("authored-zone evidence is incomplete")
        if type(self.library_only_finding_types) is not tuple or tuple(
            sorted(set(self.library_only_finding_types))
        ) != self.library_only_finding_types:
            raise CandidateContractError("library-only finding types must be sorted and unique")
        if any(_IDENTIFIER.fullmatch(item) is None for item in self.library_only_finding_types):
            raise CandidateContractError("library-only finding types are not canonical")
        if type(self.ignored_check_keys) is not tuple or tuple(
            sorted(set(self.ignored_check_keys))
        ) != self.ignored_check_keys:
            raise CandidateContractError("ignored check keys must be sorted and unique")
        if any(_IDENTIFIER.fullmatch(item) is None for item in self.ignored_check_keys):
            raise CandidateContractError("ignored check keys are not canonical")
        if self.receipt_sha256 != receipt_sha256(self):
            raise CandidateContractError("receipt hash does not bind the exact receipt")


def receipt_sha256(receipt: CandidateReceipt) -> str:
    if type(receipt) is not CandidateReceipt:
        raise CandidateContractError("receipt hash subject must be exact CandidateReceipt")
    payload = {
        field.name: getattr(receipt, field.name)
        for field in fields(CandidateReceipt)
        if field.name != "receipt_sha256"
    }
    return stable_sha256(payload, domain="kicad-cam-candidate-receipt-v3")


@dataclass(frozen=True, slots=True)
class ManufacturingCandidate:
    filled_board_payload: bytes
    filled_board_semantic_evidence: FilledBoardSemanticEvidence
    authored_zone_evidence: SourceZoneIdentityEvidence | None
    bom_result: CandidateBomResult | None
    drc_report_payload: bytes
    normalized_drc_payload: bytes
    artifacts: tuple[CandidateArtifact, ...]
    receipt: CandidateReceipt

    def __post_init__(self) -> None:
        if type(self) is not ManufacturingCandidate:
            raise CandidateContractError("manufacturing candidate must use the exact type")
        if type(self.filled_board_payload) is not bytes or not self.filled_board_payload:
            raise CandidateContractError("filled board payload must be non-empty exact bytes")
        from .filled_board_semantics import (
            FilledBoardSemanticEvidence,
            filled_board_evidence_payload,
        )

        if type(self.filled_board_semantic_evidence) is not FilledBoardSemanticEvidence:
            raise CandidateContractError(
                "candidate requires exact filled-board semantic evidence"
            )
        from .bom import CandidateBomResult, candidate_bom_evidence_payload
        from .source_zone_identity import SourceZoneIdentityEvidence

        if self.bom_result is not None and type(self.bom_result) is not CandidateBomResult:
            raise CandidateContractError("candidate BOM result must use the exact type")
        if self.authored_zone_evidence is not None and type(
            self.authored_zone_evidence
        ) is not SourceZoneIdentityEvidence:
            raise CandidateContractError("authored-zone evidence must use the exact type")
        if type(self.drc_report_payload) is not bytes or not self.drc_report_payload:
            raise CandidateContractError("DRC report payload must be non-empty exact bytes")
        if type(self.normalized_drc_payload) is not bytes or not self.normalized_drc_payload:
            raise CandidateContractError(
                "normalized DRC payload must be non-empty exact bytes"
            )
        if type(self.artifacts) is not tuple or any(
            type(item) is not CandidateArtifact for item in self.artifacts
        ):
            raise CandidateContractError("candidate artifacts must be an exact tuple")
        if tuple(sorted(self.artifacts, key=lambda item: item.filename)) != self.artifacts:
            raise CandidateContractError("candidate artifacts must be sorted by filename")
        if type(self.receipt) is not CandidateReceipt:
            raise CandidateContractError("candidate requires exact CandidateReceipt")
        if (
            hashlib.sha256(self.filled_board_payload).hexdigest()
            != self.receipt.filled_board_sha256
        ):
            raise CandidateContractError("filled board payload does not match receipt")
        evidence = self.filled_board_semantic_evidence
        if evidence.raw_board_sha256 != self.receipt.filled_board_sha256:
            raise CandidateContractError("filled-board evidence does not bind raw bytes")
        if evidence.normalized_semantic_sha256 != self.receipt.filled_board_semantic_sha256:
            raise CandidateContractError("filled-board semantic hash does not match receipt")
        if (
            evidence.filled_copper_geometry_sha256
            != self.receipt.filled_copper_geometry_sha256
        ):
            raise CandidateContractError("filled-copper geometry does not match receipt")
        if (
            evidence.normalizer_id != self.receipt.filled_board_normalizer_id
            or evidence.normalizer_version != self.receipt.filled_board_normalizer_version
            or evidence.zone_count != self.receipt.filled_zone_count
            or evidence.filled_polygon_count != self.receipt.filled_polygon_count
            or evidence.filled_vertex_count != self.receipt.filled_vertex_count
            or evidence.filled_area2_nm2 != self.receipt.filled_area2_nm2
            or evidence.volatile_property_uuid_count
            != self.receipt.volatile_property_uuid_count
            or evidence.volatile_property_paths_sha256
            != self.receipt.volatile_property_paths_sha256
        ):
            raise CandidateContractError("filled-board evidence summary does not match receipt")
        if (
            hashlib.sha256(filled_board_evidence_payload(evidence)).hexdigest()
            != self.receipt.filled_board_semantic_evidence_sha256
        ):
            raise CandidateContractError("filled-board evidence payload does not match receipt")
        if hashlib.sha256(self.drc_report_payload).hexdigest() != self.receipt.drc_report_sha256:
            raise CandidateContractError("DRC report payload does not match receipt")
        if (
            hashlib.sha256(self.normalized_drc_payload).hexdigest()
            != self.receipt.normalized_drc_evidence_sha256
        ):
            raise CandidateContractError("normalized DRC payload does not match receipt")
        if tuple(item.digest for item in self.artifacts) != self.receipt.cam_artifacts:
            raise CandidateContractError("candidate artifacts do not match receipt inventory")
        if self.bom_result is None:
            if (
                self.receipt.bom_evidence_sha256 is not None
                or self.receipt.bom_component_count != 0
                or self.receipt.bom_artifacts
            ):
                raise CandidateContractError("receipt claims absent candidate BOM evidence")
        else:
            bom_evidence = self.bom_result.evidence
            if (
                hashlib.sha256(candidate_bom_evidence_payload(bom_evidence)).hexdigest()
                != self.receipt.bom_evidence_sha256
                or bom_evidence.component_count != self.receipt.bom_component_count
                or bom_evidence.candidate_artifacts != self.receipt.bom_artifacts
            ):
                raise CandidateContractError("candidate BOM evidence does not match receipt")
        if self.authored_zone_evidence is None:
            if (
                self.receipt.authored_zone_evidence_sha256 is not None
                or self.receipt.authored_zone_intent_sha256 is not None
                or self.receipt.authored_zone_count != 0
                or self.receipt.generated_fill_node_count != 0
            ):
                raise CandidateContractError("receipt claims absent authored-zone evidence")
        else:
            zone_evidence = self.authored_zone_evidence
            zone_payload = canonical_bytes(zone_evidence) + b"\n"
            if (
                hashlib.sha256(zone_payload).hexdigest()
                != self.receipt.authored_zone_evidence_sha256
                or zone_evidence.source_bundle_sha256 != self.receipt.source_bundle_sha256
                or zone_evidence.source_board_sha256 != self.receipt.source_board_sha256
                or zone_evidence.derivative_board_sha256 != self.receipt.filled_board_sha256
                or zone_evidence.authored_zone_intent_sha256
                != self.receipt.authored_zone_intent_sha256
                or zone_evidence.zone_count != self.receipt.authored_zone_count
                or zone_evidence.generated_fill_node_count
                != self.receipt.generated_fill_node_count
            ):
                raise CandidateContractError("authored-zone evidence does not match receipt")


__all__ = (
    "ArtifactDigest",
    "CandidateArtifact",
    "CandidateContractError",
    "CandidateGenerationError",
    "CandidateHostConfiguration",
    "CandidatePolicy",
    "CandidateReceipt",
    "CandidateSource",
    "CommandReceipt",
    "ManufacturingCandidate",
    "NON_FABRICATION_NOTICE_FILENAME",
    "NON_FABRICATION_NOTICE_PAYLOAD",
    "NON_FABRICATION_NOTICE_SHA256",
    "canonical_bytes",
    "receipt_sha256",
    "stable_sha256",
)

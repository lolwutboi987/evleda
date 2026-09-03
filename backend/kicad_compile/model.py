"""Immutable evidence models for deterministic canonical-to-KiCad compilation."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Self, cast

from backend.kicad_project import ProjectAuxiliaryFile, ProjectBundleInput

_SHA256 = re.compile(r"[0-9a-f]{64}")
_PROFILE_EVIDENCE_HASH_DOMAIN = b"flux-clone-compilation-profile-evidence-v1\x00"

_PROFILE_EVIDENCE_FIELDS = (
    "profile_id",
    "profile_version",
    "subject_graph_sha256",
    "assembly_catalog_sha256",
    "assembly_placement_sha256",
    "silkscreen_plan_sha256",
    "model_catalog_sha256",
    "model_emitted_manifest_sha256",
    "model_omitted_manifest_sha256",
    "model_emitted_count",
    "model_omitted_count",
    "human_plan_sha256",
    "human_symbol_catalog_sha256",
    "human_emission_sha256",
    "source_receipt_manifest_sha256",
)
_PROFILE_EVIDENCE_KEYS = frozenset((*_PROFILE_EVIDENCE_FIELDS, "aggregate_sha256"))


def _require_text(value: object, label: str) -> str:
    if type(value) is not str or not value or any(ord(character) < 32 for character in value):
        raise ValueError(f"{label} must be non-empty control-free text")
    return value


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_exact_object(
    value: object,
    keys: frozenset[str],
    label: str,
) -> dict[str, object]:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an exact object")
    raw = cast(dict[object, object], value)
    if any(type(key) is not str for key in raw):
        raise ValueError(f"{label} keys must be exact text")
    result = {cast(str, key): item for key, item in raw.items()}
    actual = frozenset(result)
    if actual != keys:
        missing = sorted(keys - actual)
        unknown = sorted(actual - keys)
        raise ValueError(
            f"{label} fields do not match the exact schema "
            f"(missing={missing!r}, unknown={unknown!r})"
        )
    return result


def _profile_evidence_aggregate(values: dict[str, object]) -> str:
    payload = json.dumps(
        {key: values[key] for key in _PROFILE_EVIDENCE_FIELDS},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(_PROFILE_EVIDENCE_HASH_DOMAIN + payload).hexdigest()


def _validate_profile_evidence_values(values: dict[str, object]) -> None:
    _require_text(values["profile_id"], "compilation profile ID")
    _require_text(values["profile_version"], "compilation profile version")
    for field_name in _PROFILE_EVIDENCE_FIELDS:
        if field_name in {
            "profile_id",
            "profile_version",
            "model_emitted_count",
            "model_omitted_count",
        }:
            continue
        _require_sha256(values[field_name], field_name.replace("_", " "))
    for field_name, label in (
        ("model_emitted_count", "emitted model count"),
        ("model_omitted_count", "omitted model count"),
    ):
        value = values[field_name]
        if type(value) is not int or value < 0:
            raise ValueError(f"{label} must be a non-negative exact integer")


@dataclass(frozen=True, slots=True)
class CompilationProfileEvidence:
    """Exact content bindings for one reviewed compilation profile."""

    profile_id: str
    profile_version: str
    subject_graph_sha256: str
    assembly_catalog_sha256: str
    assembly_placement_sha256: str
    silkscreen_plan_sha256: str
    model_catalog_sha256: str
    model_emitted_manifest_sha256: str
    model_omitted_manifest_sha256: str
    model_emitted_count: int
    model_omitted_count: int
    human_plan_sha256: str
    human_symbol_catalog_sha256: str
    human_emission_sha256: str
    source_receipt_manifest_sha256: str
    aggregate_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not CompilationProfileEvidence:
            raise TypeError(
                "compilation profile evidence must use the exact "
                "CompilationProfileEvidence type"
            )
        _validate_profile_evidence_values(self._aggregate_values())
        _require_sha256(self.aggregate_sha256, "compilation profile aggregate digest")
        if self.aggregate_sha256 != _profile_evidence_aggregate(self._aggregate_values()):
            raise ValueError("compilation profile aggregate digest does not match its fields")

    @classmethod
    def create(
        cls,
        *,
        profile_id: str,
        profile_version: str,
        subject_graph_sha256: str,
        assembly_catalog_sha256: str,
        assembly_placement_sha256: str,
        silkscreen_plan_sha256: str,
        model_catalog_sha256: str,
        model_emitted_manifest_sha256: str,
        model_omitted_manifest_sha256: str,
        model_emitted_count: int,
        model_omitted_count: int,
        human_plan_sha256: str,
        human_symbol_catalog_sha256: str,
        human_emission_sha256: str,
        source_receipt_manifest_sha256: str,
    ) -> Self:
        """Build evidence while deriving its domain-separated aggregate digest."""

        values: dict[str, object] = {
            "profile_id": profile_id,
            "profile_version": profile_version,
            "subject_graph_sha256": subject_graph_sha256,
            "assembly_catalog_sha256": assembly_catalog_sha256,
            "assembly_placement_sha256": assembly_placement_sha256,
            "silkscreen_plan_sha256": silkscreen_plan_sha256,
            "model_catalog_sha256": model_catalog_sha256,
            "model_emitted_manifest_sha256": model_emitted_manifest_sha256,
            "model_omitted_manifest_sha256": model_omitted_manifest_sha256,
            "model_emitted_count": model_emitted_count,
            "model_omitted_count": model_omitted_count,
            "human_plan_sha256": human_plan_sha256,
            "human_symbol_catalog_sha256": human_symbol_catalog_sha256,
            "human_emission_sha256": human_emission_sha256,
            "source_receipt_manifest_sha256": source_receipt_manifest_sha256,
        }
        _validate_profile_evidence_values(values)
        return cls(**values, aggregate_sha256=_profile_evidence_aggregate(values))  # type: ignore[arg-type]

    def _aggregate_values(self) -> dict[str, object]:
        return {field_name: getattr(self, field_name) for field_name in _PROFILE_EVIDENCE_FIELDS}

    def to_primitive(self) -> dict[str, object]:
        """Return the exact canonical-JSON-ready evidence object."""

        result = self._aggregate_values()
        result["aggregate_sha256"] = self.aggregate_sha256
        return result

    @classmethod
    def from_primitive(cls, value: object) -> Self:
        """Decode only the complete, closed evidence schema."""

        fields = _require_exact_object(
            value,
            _PROFILE_EVIDENCE_KEYS,
            "compilation profile evidence",
        )
        return cls(
            profile_id=fields["profile_id"],  # type: ignore[arg-type]
            profile_version=fields["profile_version"],  # type: ignore[arg-type]
            subject_graph_sha256=fields["subject_graph_sha256"],  # type: ignore[arg-type]
            assembly_catalog_sha256=fields["assembly_catalog_sha256"],  # type: ignore[arg-type]
            assembly_placement_sha256=fields["assembly_placement_sha256"],  # type: ignore[arg-type]
            silkscreen_plan_sha256=fields["silkscreen_plan_sha256"],  # type: ignore[arg-type]
            model_catalog_sha256=fields["model_catalog_sha256"],  # type: ignore[arg-type]
            model_emitted_manifest_sha256=fields["model_emitted_manifest_sha256"],  # type: ignore[arg-type]
            model_omitted_manifest_sha256=fields["model_omitted_manifest_sha256"],  # type: ignore[arg-type]
            model_emitted_count=fields["model_emitted_count"],  # type: ignore[arg-type]
            model_omitted_count=fields["model_omitted_count"],  # type: ignore[arg-type]
            human_plan_sha256=fields["human_plan_sha256"],  # type: ignore[arg-type]
            human_symbol_catalog_sha256=fields["human_symbol_catalog_sha256"],  # type: ignore[arg-type]
            human_emission_sha256=fields["human_emission_sha256"],  # type: ignore[arg-type]
            source_receipt_manifest_sha256=fields["source_receipt_manifest_sha256"],  # type: ignore[arg-type]
            aggregate_sha256=fields["aggregate_sha256"],  # type: ignore[arg-type]
        )


@dataclass(frozen=True, slots=True, order=True)
class CompilationBlocker:
    """One stable, entity-addressed reason compilation cannot be lossless."""

    code: str
    entity_id: str
    detail: str

    def __post_init__(self) -> None:
        if type(self) is not CompilationBlocker:
            raise TypeError("compilation blockers must use the exact CompilationBlocker type")
        _require_text(self.code, "blocker code")
        _require_text(self.entity_id, "blocker entity ID")
        _require_text(self.detail, "blocker detail")


class CompilationBlockedError(ValueError):
    """Raised before byte generation when the graph exceeds the reviewed subset."""

    def __init__(self, blockers: tuple[CompilationBlocker, ...]) -> None:
        if type(blockers) is not tuple or not blockers or any(
            type(item) is not CompilationBlocker for item in blockers
        ):
            raise TypeError("blockers must be a non-empty exact CompilationBlocker tuple")
        self.blockers = tuple(sorted(blockers))
        codes = ", ".join(sorted({item.code for item in self.blockers}))
        super().__init__(f"canonical graph cannot be compiled losslessly: {codes}")


class CompilationParityError(RuntimeError):
    """Raised when emitted or supplied bytes do not prove exact compiler parity."""


@dataclass(frozen=True, slots=True, order=True)
class FileDigest:
    filename: str
    media_type: str
    byte_length: int
    sha256: str

    def __post_init__(self) -> None:
        if type(self) is not FileDigest:
            raise TypeError("file digests must use the exact FileDigest type")
        _require_text(self.filename, "file name")
        _require_text(self.media_type, "media type")
        if type(self.byte_length) is not int or self.byte_length < 0:
            raise ValueError("file byte length must be a non-negative integer")
        _require_sha256(self.sha256, "file digest")


@dataclass(frozen=True, slots=True, order=True)
class IdentityBinding:
    """Source identity to deterministic KiCad UUID/canonical-ID mapping."""

    source_kind: str
    source_id: str
    target_kind: str
    emitted_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if type(self) is not IdentityBinding:
            raise TypeError("identity bindings must use the exact IdentityBinding type")
        _require_text(self.source_kind, "source kind")
        _require_text(self.source_id, "source ID")
        _require_text(self.target_kind, "target kind")
        if type(self.emitted_ids) is not tuple or not self.emitted_ids or any(
            type(item) is not str or not item for item in self.emitted_ids
        ):
            raise ValueError("emitted IDs must be a non-empty immutable text tuple")
        if tuple(sorted(set(self.emitted_ids))) != self.emitted_ids:
            raise ValueError("emitted IDs must be sorted and unique")


_MANIFEST_PRIMITIVE_KEYS = frozenset(
    {
        "schema_version",
        "compiler_id",
        "compiler_version",
        "project_stem",
        "input_graph_sha256",
        "files",
        "output_bundle_sha256",
        "project_ir_sha256",
        "schematic_ir_sha256",
        "board_ir_sha256",
        "diagnostics_manifest_sha256",
        "identity_bindings",
        "semanticParity",
        "referenceDesignReady",
        "kicadExecution",
        "manufacturingReleaseEligible",
    }
)
_FILE_DIGEST_KEYS = frozenset({"filename", "media_type", "byte_length", "sha256"})
_IDENTITY_BINDING_KEYS = frozenset(
    {"source_kind", "source_id", "target_kind", "emitted_ids"}
)


@dataclass(frozen=True, slots=True)
class CompilationManifest:
    schema_version: int
    compiler_id: str
    compiler_version: str
    project_stem: str
    input_graph_sha256: str
    files: tuple[FileDigest, ...]
    output_bundle_sha256: str
    project_ir_sha256: str
    schematic_ir_sha256: str
    board_ir_sha256: str
    diagnostics_manifest_sha256: str
    identity_bindings: tuple[IdentityBinding, ...]
    semantic_parity: bool = True
    reference_design_ready: bool = True
    kicad_execution: str = "not-run"
    manufacturing_release_eligible: bool = False
    compilation_profile_evidence: CompilationProfileEvidence | None = None

    def __post_init__(self) -> None:
        if type(self) is not CompilationManifest:
            raise TypeError("manifest must use the exact CompilationManifest type")
        if type(self.schema_version) is not int or self.schema_version not in {1, 2, 3}:
            raise ValueError("compiler manifest schema must be legacy 1, hermetic 2, or profile 3")
        for value, label in (
            (self.compiler_id, "compiler ID"),
            (self.compiler_version, "compiler version"),
            (self.project_stem, "project stem"),
        ):
            _require_text(value, label)
        for value, label in (
            (self.input_graph_sha256, "input graph digest"),
            (self.output_bundle_sha256, "output bundle digest"),
            (self.project_ir_sha256, "project IR digest"),
            (self.schematic_ir_sha256, "schematic IR digest"),
            (self.board_ir_sha256, "board IR digest"),
            (self.diagnostics_manifest_sha256, "diagnostics manifest digest"),
        ):
            _require_sha256(value, label)
        minimum_files = 3 if self.schema_version == 1 else 6
        if type(self.files) is not tuple or len(self.files) < minimum_files or any(
            type(item) is not FileDigest for item in self.files
        ):
            raise ValueError(
                "compiler manifest file inventory is incomplete for its schema"
            )
        if tuple(
            sorted(self.files, key=lambda item: (item.filename.casefold(), item.filename))
        ) != self.files:
            raise ValueError("compiler files must be sorted by filename")
        if len({item.filename.casefold() for item in self.files}) != len(self.files):
            raise ValueError("compiler file names must be case-insensitively unique")
        if type(self.identity_bindings) is not tuple or any(
            type(item) is not IdentityBinding for item in self.identity_bindings
        ):
            raise ValueError("identity bindings must be an immutable exact tuple")
        if tuple(sorted(self.identity_bindings)) != self.identity_bindings:
            raise ValueError("identity bindings must be deterministically sorted")
        for value, label in (
            (self.semantic_parity, "semantic parity"),
            (self.reference_design_ready, "reference-design readiness"),
            (self.manufacturing_release_eligible, "manufacturing release eligibility"),
        ):
            if type(value) is not bool:
                raise ValueError(f"{label} must be boolean")
        if not self.semantic_parity or not self.reference_design_ready:
            raise ValueError("a returned compiler manifest must prove parity and readiness")
        if self.kicad_execution != "not-run":
            raise ValueError("the byte compiler cannot claim KiCad execution")
        if self.manufacturing_release_eligible:
            raise ValueError("codec-only compilation cannot authorize manufacturing release")
        if self.schema_version in {1, 2}:
            if self.compilation_profile_evidence is not None:
                raise ValueError("compiler manifest schemas 1 and 2 cannot carry profile evidence")
        else:
            if type(self.compilation_profile_evidence) is not CompilationProfileEvidence:
                raise ValueError(
                    "compiler manifest schema 3 requires exact compilation profile evidence"
                )
            if (
                self.compilation_profile_evidence.subject_graph_sha256
                != self.input_graph_sha256
            ):
                raise ValueError(
                    "compilation profile subject graph digest must match the manifest input graph"
                )

    def to_primitive(self) -> dict[str, object]:
        """Return the exact schema-selected canonical-JSON-ready manifest object."""

        document: dict[str, object] = {
            "schema_version": self.schema_version,
            "compiler_id": self.compiler_id,
            "compiler_version": self.compiler_version,
            "project_stem": self.project_stem,
            "input_graph_sha256": self.input_graph_sha256,
            "files": [
                {
                    "filename": item.filename,
                    "media_type": item.media_type,
                    "byte_length": item.byte_length,
                    "sha256": item.sha256,
                }
                for item in self.files
            ],
            "output_bundle_sha256": self.output_bundle_sha256,
            "project_ir_sha256": self.project_ir_sha256,
            "schematic_ir_sha256": self.schematic_ir_sha256,
            "board_ir_sha256": self.board_ir_sha256,
            "diagnostics_manifest_sha256": self.diagnostics_manifest_sha256,
            "identity_bindings": [
                {
                    "source_kind": item.source_kind,
                    "source_id": item.source_id,
                    "target_kind": item.target_kind,
                    "emitted_ids": list(item.emitted_ids),
                }
                for item in self.identity_bindings
            ],
            "semanticParity": self.semantic_parity,
            "referenceDesignReady": self.reference_design_ready,
            "kicadExecution": self.kicad_execution,
            "manufacturingReleaseEligible": self.manufacturing_release_eligible,
        }
        if self.schema_version == 3:
            assert self.compilation_profile_evidence is not None
            document["compilation_profile_evidence"] = (
                self.compilation_profile_evidence.to_primitive()
            )
        return document

    @classmethod
    def from_primitive(cls, value: object) -> Self:
        """Decode schema 1–3 manifests while rejecting every unrecognized shape."""

        if type(value) is not dict:
            raise ValueError("compiler manifest must be an exact object")
        raw_value = cast(dict[object, object], value)
        if "schema_version" not in raw_value:
            raise ValueError("compiler manifest is missing schema_version")
        schema_version = raw_value["schema_version"]
        if type(schema_version) is not int or schema_version not in {1, 2, 3}:
            raise ValueError("compiler manifest schema must be legacy 1, hermetic 2, or profile 3")
        expected_keys = _MANIFEST_PRIMITIVE_KEYS
        if schema_version == 3:
            expected_keys = frozenset((*expected_keys, "compilation_profile_evidence"))
        fields = _require_exact_object(raw_value, expected_keys, "compiler manifest")

        file_values = fields["files"]
        if type(file_values) is not list:
            raise ValueError("compiler manifest files must be an exact array")
        files: list[FileDigest] = []
        for index, item in enumerate(cast(list[object], file_values)):
            item_fields = _require_exact_object(
                item,
                _FILE_DIGEST_KEYS,
                f"compiler manifest file {index}",
            )
            files.append(
                FileDigest(
                    filename=item_fields["filename"],  # type: ignore[arg-type]
                    media_type=item_fields["media_type"],  # type: ignore[arg-type]
                    byte_length=item_fields["byte_length"],  # type: ignore[arg-type]
                    sha256=item_fields["sha256"],  # type: ignore[arg-type]
                )
            )

        binding_values = fields["identity_bindings"]
        if type(binding_values) is not list:
            raise ValueError("identity bindings must be an exact array")
        bindings: list[IdentityBinding] = []
        for index, item in enumerate(cast(list[object], binding_values)):
            item_fields = _require_exact_object(
                item,
                _IDENTITY_BINDING_KEYS,
                f"identity binding {index}",
            )
            emitted_values = item_fields["emitted_ids"]
            if type(emitted_values) is not list:
                raise ValueError("identity binding emitted IDs must be an exact array")
            emitted_items = cast(list[object], emitted_values)
            if any(type(emitted_id) is not str for emitted_id in emitted_items):
                raise ValueError("identity binding emitted IDs must be exact text")
            bindings.append(
                IdentityBinding(
                    source_kind=item_fields["source_kind"],  # type: ignore[arg-type]
                    source_id=item_fields["source_id"],  # type: ignore[arg-type]
                    target_kind=item_fields["target_kind"],  # type: ignore[arg-type]
                    emitted_ids=tuple(cast(str, emitted_id) for emitted_id in emitted_items),
                )
            )

        evidence = None
        if schema_version == 3:
            evidence = CompilationProfileEvidence.from_primitive(
                fields["compilation_profile_evidence"]
            )
        return cls(
            schema_version=schema_version,
            compiler_id=fields["compiler_id"],  # type: ignore[arg-type]
            compiler_version=fields["compiler_version"],  # type: ignore[arg-type]
            project_stem=fields["project_stem"],  # type: ignore[arg-type]
            input_graph_sha256=fields["input_graph_sha256"],  # type: ignore[arg-type]
            files=tuple(files),
            output_bundle_sha256=fields["output_bundle_sha256"],  # type: ignore[arg-type]
            project_ir_sha256=fields["project_ir_sha256"],  # type: ignore[arg-type]
            schematic_ir_sha256=fields["schematic_ir_sha256"],  # type: ignore[arg-type]
            board_ir_sha256=fields["board_ir_sha256"],  # type: ignore[arg-type]
            diagnostics_manifest_sha256=fields["diagnostics_manifest_sha256"],  # type: ignore[arg-type]
            identity_bindings=tuple(bindings),
            semantic_parity=fields["semanticParity"],  # type: ignore[arg-type]
            reference_design_ready=fields["referenceDesignReady"],  # type: ignore[arg-type]
            kicad_execution=fields["kicadExecution"],  # type: ignore[arg-type]
            manufacturing_release_eligible=fields["manufacturingReleaseEligible"],  # type: ignore[arg-type]
            compilation_profile_evidence=evidence,
        )


@dataclass(frozen=True, slots=True)
class CompiledProject:
    """Managed in-memory KiCad bytes and their content-addressed compiler evidence."""

    bundle: ProjectBundleInput
    manifest: CompilationManifest
    manifest_payload: bytes
    manifest_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not CompiledProject:
            raise TypeError("compiled project must use the exact CompiledProject type")
        if type(self.bundle) is not ProjectBundleInput:
            raise TypeError("compiled bundle must use the exact ProjectBundleInput type")
        if type(self.manifest) is not CompilationManifest:
            raise TypeError("compiled manifest must use the exact CompilationManifest type")
        if type(self.manifest_payload) is not bytes:
            raise TypeError("compiler manifest payload must be bytes")
        _require_sha256(self.manifest_sha256, "compiler manifest digest")
        if self.bundle.stem != self.manifest.project_stem:
            raise ValueError("bundle stem and compiler manifest stem must match")

    @property
    def project_filename(self) -> str:
        return self.bundle.project_filename

    @property
    def schematic_filename(self) -> str:
        return self.bundle.schematic_filename

    @property
    def board_filename(self) -> str:
        return self.bundle.board_filename

    @property
    def compiler_manifest_filename(self) -> str:
        return f"{self.bundle.stem}.flux-compile.json"

    @property
    def auxiliary_files(self) -> tuple[ProjectAuxiliaryFile, ...]:
        return self.bundle.auxiliary_files

    @property
    def all_files(self) -> tuple[ProjectAuxiliaryFile, ...]:
        return self.bundle.all_files

    @property
    def kicad_execution(self) -> str:
        return self.manifest.kicad_execution


@dataclass(frozen=True, slots=True)
class CompilationVerification:
    input_graph_sha256: str
    manifest_sha256: str
    output_bundle_sha256: str
    reparsed_bundle_ir_sha256: str
    semantic_parity: bool
    diagnostics_supported: bool
    kicad_execution: str = "not-run"

    def __post_init__(self) -> None:
        if type(self) is not CompilationVerification:
            raise TypeError("verification must use the exact CompilationVerification type")
        for value, label in (
            (self.input_graph_sha256, "input graph digest"),
            (self.manifest_sha256, "manifest digest"),
            (self.output_bundle_sha256, "output bundle digest"),
            (self.reparsed_bundle_ir_sha256, "reparsed bundle IR digest"),
        ):
            _require_sha256(value, label)
        if type(self.semantic_parity) is not bool or type(self.diagnostics_supported) is not bool:
            raise ValueError("verification flags must be boolean")
        if not self.semantic_parity or not self.diagnostics_supported:
            raise ValueError("successful verification must prove supported semantic parity")
        if self.kicad_execution != "not-run":
            raise ValueError("compiler verification cannot claim KiCad execution")

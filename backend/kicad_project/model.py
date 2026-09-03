"""Immutable project/schematic IR and content-addressed evidence models."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, fields, is_dataclass
from enum import Enum
from typing import Any

from backend.kicad_io import Board, PointNm

from .errors import ProjectInvariantError

_SHA256 = re.compile(r"[0-9a-f]{64}")
_STEM = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_INT64_MIN = -(1 << 63)
_INT64_MAX = (1 << 63) - 1


def require_int(value: object, label: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProjectInvariantError(f"{label} must be an integer")
    if not _INT64_MIN <= value <= _INT64_MAX:
        raise ProjectInvariantError(f"{label} must fit in a signed 64-bit integer")
    if minimum is not None and value < minimum:
        raise ProjectInvariantError(f"{label} must be at least {minimum}")
    return value


def require_text(value: object, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ProjectInvariantError(f"{label} must be a string")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ProjectInvariantError(f"{label} must be valid Unicode") from exc
    if unicodedata.normalize("NFC", value) != value:
        raise ProjectInvariantError(f"{label} must be NFC-normalized")
    if (not allow_empty and not value) or any(
        unicodedata.category(character).startswith("C") for character in value
    ):
        raise ProjectInvariantError(f"{label} contains empty or control-character text")
    return value


def require_uuid(value: object, label: str) -> str:
    text = require_text(value, label)
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError) as exc:
        raise ProjectInvariantError(f"{label} must be a UUID") from exc
    if str(parsed) != text:
        raise ProjectInvariantError(f"{label} must use canonical lowercase UUID syntax")
    return text


def require_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ProjectInvariantError(f"{label} must be a lowercase SHA-256 digest")
    return value


def require_stem(value: object) -> str:
    text = require_text(value, "project stem")
    if _STEM.fullmatch(text) is None:
        raise ProjectInvariantError(
            "project stem must be 1-64 ASCII letters, digits, underscores, or hyphens; "
            "path separators and dot segments are forbidden"
        )
    return text


def require_project_relative_name(value: object) -> str:
    """Validate one portable project-local relative artifact name."""

    text = require_text(value, "project-relative file name")
    if (
        "\\" in text
        or text.startswith("/")
        or text.endswith("/")
        or ":" in text
        or len(text.encode("utf-8")) > 240
    ):
        raise ProjectInvariantError(
            "project-relative names must be short POSIX-relative paths without drives"
        )
    parts = text.split("/")
    if len(parts) > 8:
        raise ProjectInvariantError("project-relative paths permit at most eight segments")
    reserved = {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{index}" for index in range(1, 10)),
        *(f"LPT{index}" for index in range(1, 10)),
    }
    if any(
        part in {"", ".", ".."}
        or part != part.strip()
        or part.endswith((".", " "))
        or len(part.encode("utf-8")) > 120
        or part.split(".", 1)[0].upper() in reserved
        or any(character in '<>:"|?*' for character in part)
        for part in parts
    ):
        raise ProjectInvariantError(
            "project-relative names forbid empty/dot segments and Windows-reserved characters"
        )
    return text


def canonical_data(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        raise ProjectInvariantError("floating-point values are forbidden in project IR")
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: canonical_data(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ProjectInvariantError("canonical object keys must be strings")
        return {key: canonical_data(value[key]) for key in sorted(value)}
    if isinstance(value, (tuple, list)):
        return [canonical_data(item) for item in value]
    raise ProjectInvariantError(f"unsupported canonical value type {type(value).__name__}")


def stable_hash(value: Any, *, domain: str) -> str:
    require_text(domain, "hash domain")
    body = json.dumps(
        canonical_data(value),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(domain.encode("utf-8") + b"\x00" + body).hexdigest()


class UnsupportedPolicy(str, Enum):  # noqa: UP042 - preserve Enum's public __str__ behavior
    REJECT = "reject"
    MANIFEST = "manifest"


class DiagnosticDisposition(str, Enum):  # noqa: UP042 - preserve Enum's public __str__ behavior
    PRESERVED = "preserved"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class ProjectDiagnostic:
    artifact: str
    path: str
    head: str
    disposition: DiagnosticDisposition
    reason: str
    canonical_payload: str
    payload_sha256: str

    def __post_init__(self) -> None:
        require_text(self.artifact, "diagnostic artifact")
        require_text(self.path, "diagnostic path")
        require_text(self.head, "diagnostic head")
        if not isinstance(self.disposition, DiagnosticDisposition):
            raise ProjectInvariantError("diagnostic disposition is invalid")
        require_text(self.reason, "diagnostic reason")
        require_text(self.canonical_payload, "diagnostic canonical payload")
        require_sha256(self.payload_sha256, "diagnostic payload hash")
        expected = hashlib.sha256(self.canonical_payload.encode("utf-8")).hexdigest()
        if expected != self.payload_sha256:
            raise ProjectInvariantError("diagnostic hash does not bind canonical payload")


@dataclass(frozen=True, slots=True)
class ProjectDiagnostics:
    constructs: tuple[ProjectDiagnostic, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.constructs, tuple) or any(
            not isinstance(item, ProjectDiagnostic) for item in self.constructs
        ):
            raise ProjectInvariantError("diagnostics must be an immutable diagnostic tuple")
        keys = tuple((item.artifact, item.path) for item in self.constructs)
        if len(keys) != len(set(keys)):
            raise ProjectInvariantError("diagnostic artifact/path pairs must be unique")

    def normalized(self) -> ProjectDiagnostics:
        return ProjectDiagnostics(
            tuple(
                sorted(
                    self.constructs,
                    key=lambda item: (
                        item.artifact,
                        item.path,
                        item.disposition.value,
                        item.payload_sha256,
                    ),
                )
            )
        )

    @property
    def unsupported(self) -> tuple[ProjectDiagnostic, ...]:
        return tuple(
            item
            for item in self.normalized().constructs
            if item.disposition is DiagnosticDisposition.UNSUPPORTED
        )

    @property
    def manifest_sha256(self) -> str:
        return stable_hash(
            self.normalized(), domain="flux-clone-kicad-project-diagnostics-v1"
        )


@dataclass(frozen=True, slots=True)
class ProjectFileInfo:
    file_id: str
    display_name: str

    def __post_init__(self) -> None:
        require_uuid(self.file_id, "project file ID")
        require_text(self.display_name, "project file display name", allow_empty=True)


@dataclass(frozen=True, slots=True)
class TopLevelSheet:
    sheet_id: str
    name: str
    filename: str

    def __post_init__(self) -> None:
        require_uuid(self.sheet_id, "top-level sheet ID")
        require_text(self.name, "top-level sheet name", allow_empty=True)
        require_text(self.filename, "top-level sheet filename")
        if "/" in self.filename or "\\" in self.filename or self.filename in {".", ".."}:
            raise ProjectInvariantError("top-level sheet filename must be a project-local basename")


@dataclass(frozen=True, slots=True)
class ProjectBoardDesignRules:
    minimum_clearance_nm: int
    minimum_hole_clearance_nm: int

    def __post_init__(self) -> None:
        require_int(self.minimum_clearance_nm, "minimum board clearance", minimum=0)
        require_int(
            self.minimum_hole_clearance_nm,
            "minimum board hole clearance",
            minimum=0,
        )


@dataclass(frozen=True, slots=True)
class ProjectBoardDesignSettings:
    metadata_filename: str
    metadata_version: int
    drc_exclusions: tuple[str, ...]
    rules: ProjectBoardDesignRules

    def __post_init__(self) -> None:
        if self.metadata_filename != "board_design_settings.json":
            raise ProjectInvariantError(
                "board design-settings metadata filename must be "
                "'board_design_settings.json'"
            )
        if self.metadata_version != 2:
            raise ProjectInvariantError("supported board design-settings version is exactly 2")
        if self.drc_exclusions:
            raise ProjectInvariantError(
                "supported board design settings cannot contain DRC exclusions"
            )
        if type(self.rules) is not ProjectBoardDesignRules:
            raise ProjectInvariantError("board design settings require typed minimum rules")


@dataclass(frozen=True, slots=True)
class ProjectManifest:
    schema_version: int
    filename: str
    boards: tuple[ProjectFileInfo, ...]
    sheets: tuple[ProjectFileInfo, ...]
    top_level_sheets: tuple[TopLevelSheet, ...]
    board_design_settings: ProjectBoardDesignSettings | None
    canonical_source_json: str
    diagnostics: ProjectDiagnostics = ProjectDiagnostics()

    def __post_init__(self) -> None:
        require_int(self.schema_version, "project schema version", minimum=1)
        require_text(self.filename, "project filename")
        for label, values, kind in (
            ("boards", self.boards, ProjectFileInfo),
            ("sheets", self.sheets, ProjectFileInfo),
            ("top-level sheets", self.top_level_sheets, TopLevelSheet),
        ):
            if not isinstance(values, tuple) or any(not isinstance(item, kind) for item in values):
                raise ProjectInvariantError(f"{label} must be an immutable {kind.__name__} tuple")
        require_text(self.canonical_source_json, "canonical project JSON")
        if not isinstance(self.diagnostics, ProjectDiagnostics):
            raise ProjectInvariantError("manifest diagnostics must be ProjectDiagnostics")
        if self.board_design_settings is not None and type(
            self.board_design_settings
        ) is not ProjectBoardDesignSettings:
            raise ProjectInvariantError(
                "project board design settings must be typed or absent"
            )
        if len({item.file_id for item in self.boards}) != len(self.boards):
            raise ProjectInvariantError("board project IDs must be unique")
        if len({item.file_id for item in self.sheets}) != len(self.sheets):
            raise ProjectInvariantError("sheet project IDs must be unique")
        if len({item.sheet_id for item in self.top_level_sheets}) != len(
            self.top_level_sheets
        ):
            raise ProjectInvariantError("top-level sheet IDs must be unique")

    @property
    def normalized_ir_sha256(self) -> str:
        return stable_hash(
            {
                "schema_version": self.schema_version,
                "filename": self.filename,
                "boards": self.boards,
                "sheets": self.sheets,
                "top_level_sheets": self.top_level_sheets,
                "board_design_settings": self.board_design_settings,
            },
            domain="flux-clone-kicad-project-manifest-ir-v1",
        )


class LabelKind(str, Enum):  # noqa: UP042 - preserve Enum's public __str__ behavior
    LOCAL = "local"
    GLOBAL = "global"


@dataclass(frozen=True, slots=True)
class LibraryPin:
    number: str
    name: str
    electrical_type: str
    unit: int
    position: PointNm
    rotation_udeg: int

    def __post_init__(self) -> None:
        require_text(self.number, "library pin number")
        require_text(self.name, "library pin name", allow_empty=True)
        require_text(self.electrical_type, "library pin electrical type")
        require_int(self.unit, "library pin unit", minimum=1)
        if not isinstance(self.position, PointNm):
            raise ProjectInvariantError("library pin position must be PointNm")
        require_int(self.rotation_udeg, "library pin rotation", minimum=0)
        if self.rotation_udeg >= 360_000_000:
            raise ProjectInvariantError("library pin rotation must be normalized")


@dataclass(frozen=True, slots=True)
class LibrarySymbol:
    library_id: str
    pins: tuple[LibraryPin, ...]

    def __post_init__(self) -> None:
        require_text(self.library_id, "library symbol ID")
        if not isinstance(self.pins, tuple) or any(
            not isinstance(item, LibraryPin) for item in self.pins
        ):
            raise ProjectInvariantError("library pins must be an immutable LibraryPin tuple")
        identities = tuple((item.unit, item.number) for item in self.pins)
        if len(identities) != len(set(identities)):
            raise ProjectInvariantError("library pin unit/number pairs must be unique")


@dataclass(frozen=True, slots=True)
class SchematicPin:
    pin_id: str
    number: str
    name: str
    electrical_type: str
    position: PointNm

    def __post_init__(self) -> None:
        require_uuid(self.pin_id, "schematic pin ID")
        require_text(self.number, "schematic pin number")
        require_text(self.name, "schematic pin name", allow_empty=True)
        require_text(self.electrical_type, "schematic pin electrical type")
        if not isinstance(self.position, PointNm):
            raise ProjectInvariantError("schematic pin position must be PointNm")


@dataclass(frozen=True, slots=True)
class SchematicSymbol:
    symbol_id: str
    library_id: str
    reference: str
    value: str
    footprint: str
    position: PointNm
    rotation_udeg: int
    unit: int
    pins: tuple[SchematicPin, ...]

    def __post_init__(self) -> None:
        require_uuid(self.symbol_id, "schematic symbol ID")
        require_text(self.library_id, "schematic symbol library ID")
        require_text(self.reference, "schematic symbol reference")
        require_text(self.value, "schematic symbol value", allow_empty=True)
        require_text(self.footprint, "schematic symbol footprint", allow_empty=True)
        if not isinstance(self.position, PointNm):
            raise ProjectInvariantError("schematic symbol position must be PointNm")
        require_int(self.rotation_udeg, "schematic symbol rotation", minimum=0)
        if self.rotation_udeg >= 360_000_000:
            raise ProjectInvariantError("schematic symbol rotation must be normalized")
        require_int(self.unit, "schematic symbol unit", minimum=1)
        if not isinstance(self.pins, tuple) or any(
            not isinstance(item, SchematicPin) for item in self.pins
        ):
            raise ProjectInvariantError("schematic pins must be an immutable SchematicPin tuple")
        if len({item.pin_id for item in self.pins}) != len(self.pins):
            raise ProjectInvariantError("schematic pin IDs must be unique")
        if len({item.number for item in self.pins}) != len(self.pins):
            raise ProjectInvariantError("schematic pin numbers must be unique")


@dataclass(frozen=True, slots=True)
class SchematicWire:
    wire_id: str
    start: PointNm
    end: PointNm
    width_nm: int
    stroke_type: str

    def __post_init__(self) -> None:
        require_uuid(self.wire_id, "schematic wire ID")
        if not isinstance(self.start, PointNm) or not isinstance(self.end, PointNm):
            raise ProjectInvariantError("schematic wire endpoints must be PointNm")
        if self.start == self.end:
            raise ProjectInvariantError("schematic wire must have non-zero length")
        require_int(self.width_nm, "schematic wire width", minimum=0)
        require_text(self.stroke_type, "schematic wire stroke type")


@dataclass(frozen=True, slots=True)
class SchematicJunction:
    junction_id: str
    position: PointNm
    diameter_nm: int
    color_rgba: tuple[int, int, int, int]

    def __post_init__(self) -> None:
        require_uuid(self.junction_id, "schematic junction ID")
        if not isinstance(self.position, PointNm):
            raise ProjectInvariantError("schematic junction position must be PointNm")
        require_int(self.diameter_nm, "schematic junction diameter", minimum=0)
        if (
            not isinstance(self.color_rgba, tuple)
            or len(self.color_rgba) != 4
            or any(
                isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255
                for value in self.color_rgba
            )
        ):
            raise ProjectInvariantError("junction color must be four integer channels in 0..255")


@dataclass(frozen=True, slots=True)
class SchematicLabel:
    label_id: str
    kind: LabelKind
    name: str
    position: PointNm
    rotation_udeg: int

    def __post_init__(self) -> None:
        require_uuid(self.label_id, "schematic label ID")
        if not isinstance(self.kind, LabelKind):
            raise ProjectInvariantError("schematic label kind is invalid")
        require_text(self.name, "schematic label name")
        if not isinstance(self.position, PointNm):
            raise ProjectInvariantError("schematic label position must be PointNm")
        require_int(self.rotation_udeg, "schematic label rotation", minimum=0)
        if self.rotation_udeg >= 360_000_000:
            raise ProjectInvariantError("schematic label rotation must be normalized")


@dataclass(frozen=True, slots=True)
class SchematicNoConnect:
    marker_id: str
    position: PointNm

    def __post_init__(self) -> None:
        require_uuid(self.marker_id, "no-connect marker ID")
        if not isinstance(self.position, PointNm):
            raise ProjectInvariantError("no-connect position must be PointNm")


@dataclass(frozen=True, slots=True, order=True)
class SchematicPinRef:
    symbol_id: str
    pin_id: str
    pin_number: str

    def __post_init__(self) -> None:
        require_uuid(self.symbol_id, "pin-ref symbol ID")
        require_uuid(self.pin_id, "pin-ref pin ID")
        require_text(self.pin_number, "pin-ref number")


@dataclass(frozen=True, slots=True)
class SchematicNet:
    net_id: str
    name: str | None
    wire_ids: tuple[str, ...]
    junction_ids: tuple[str, ...]
    label_ids: tuple[str, ...]
    pin_refs: tuple[SchematicPinRef, ...]

    def __post_init__(self) -> None:
        require_text(self.net_id, "schematic net ID")
        if self.name is not None:
            require_text(self.name, "schematic net name")
        for label, values in (
            ("wire IDs", self.wire_ids),
            ("junction IDs", self.junction_ids),
            ("label IDs", self.label_ids),
        ):
            if not isinstance(values, tuple) or any(not isinstance(item, str) for item in values):
                raise ProjectInvariantError(f"{label} must be an immutable string tuple")
            if tuple(sorted(set(values))) != values:
                raise ProjectInvariantError(f"{label} must be sorted and unique")
        if not isinstance(self.pin_refs, tuple) or any(
            not isinstance(item, SchematicPinRef) for item in self.pin_refs
        ):
            raise ProjectInvariantError("net pin refs must be an immutable SchematicPinRef tuple")
        if tuple(sorted(set(self.pin_refs))) != self.pin_refs:
            raise ProjectInvariantError("net pin refs must be sorted and unique")
        if not self.wire_ids and not self.label_ids and len(self.pin_refs) < 2:
            raise ProjectInvariantError("a modeled net requires connectivity evidence")


@dataclass(frozen=True, slots=True)
class Schematic:
    format_version: int
    generator: str
    generator_version: str
    schematic_id: str
    library_symbols: tuple[LibrarySymbol, ...]
    symbols: tuple[SchematicSymbol, ...]
    wires: tuple[SchematicWire, ...]
    junctions: tuple[SchematicJunction, ...]
    labels: tuple[SchematicLabel, ...]
    no_connects: tuple[SchematicNoConnect, ...]
    nets: tuple[SchematicNet, ...]
    diagnostics: ProjectDiagnostics = ProjectDiagnostics()

    def __post_init__(self) -> None:
        require_int(self.format_version, "schematic format version", minimum=1)
        require_text(self.generator, "schematic generator")
        require_text(self.generator_version, "schematic generator version")
        require_uuid(self.schematic_id, "schematic ID")
        collections: tuple[tuple[str, object, type[object]], ...] = (
            ("library symbols", self.library_symbols, LibrarySymbol),
            ("symbols", self.symbols, SchematicSymbol),
            ("wires", self.wires, SchematicWire),
            ("junctions", self.junctions, SchematicJunction),
            ("labels", self.labels, SchematicLabel),
            ("no-connects", self.no_connects, SchematicNoConnect),
            ("nets", self.nets, SchematicNet),
        )
        for label, values, kind in collections:
            if not isinstance(values, tuple) or any(not isinstance(item, kind) for item in values):
                raise ProjectInvariantError(f"{label} must be an immutable {kind.__name__} tuple")
        if not isinstance(self.diagnostics, ProjectDiagnostics):
            raise ProjectInvariantError("schematic diagnostics must be ProjectDiagnostics")
        identities = (
            *(item.symbol_id for item in self.symbols),
            *(item.wire_id for item in self.wires),
            *(item.junction_id for item in self.junctions),
            *(item.label_id for item in self.labels),
            *(item.marker_id for item in self.no_connects),
        )
        if len(identities) != len(set(identities)):
            raise ProjectInvariantError("schematic object UUIDs must be globally unique")

    @property
    def normalized_ir_sha256(self) -> str:
        # Generator identity and retained source expressions are evidence metadata,
        # not electrical semantics.  The diagnostics digest binds all retained text.
        return stable_hash(
            {
                "format_version": self.format_version,
                "schematic_id": self.schematic_id,
                "library_symbols": tuple(
                    sorted(self.library_symbols, key=lambda item: item.library_id)
                ),
                "symbols": tuple(sorted(self.symbols, key=lambda item: item.symbol_id)),
                "wires": tuple(sorted(self.wires, key=lambda item: item.wire_id)),
                "junctions": tuple(
                    sorted(self.junctions, key=lambda item: item.junction_id)
                ),
                "labels": tuple(sorted(self.labels, key=lambda item: item.label_id)),
                "no_connects": tuple(
                    sorted(self.no_connects, key=lambda item: item.marker_id)
                ),
                "nets": tuple(sorted(self.nets, key=lambda item: item.net_id)),
            },
            domain="flux-clone-kicad-schematic-ir-v1",
        )


@dataclass(frozen=True, slots=True)
class ProjectAuxiliaryFile:
    """One immutable, project-local support file carried entirely in memory."""

    relative_name: str
    media_type: str
    payload: bytes

    def __post_init__(self) -> None:
        if type(self) is not ProjectAuxiliaryFile:
            raise ProjectInvariantError(
                "auxiliary files must use the exact ProjectAuxiliaryFile type"
            )
        require_project_relative_name(self.relative_name)
        require_text(self.media_type, "auxiliary media type")
        if type(self.payload) is not bytes:
            raise TypeError("auxiliary payload must be exact bytes")

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.payload).hexdigest()


def auxiliary_files_sha256(files: tuple[ProjectAuxiliaryFile, ...]) -> str:
    if type(files) is not tuple or any(type(item) is not ProjectAuxiliaryFile for item in files):
        raise ProjectInvariantError(
            "auxiliary files must be an immutable exact ProjectAuxiliaryFile tuple"
        )
    return stable_hash(
        tuple(
            {
                "relative_name": item.relative_name,
                "media_type": item.media_type,
                "byte_length": len(item.payload),
                "sha256": item.sha256,
            }
            for item in files
        ),
        domain="flux-clone-kicad-project-auxiliary-files-v1",
    )


def _validate_auxiliary_files(
    files: tuple[ProjectAuxiliaryFile, ...],
    *,
    reserved_names: tuple[str, ...],
) -> None:
    if type(files) is not tuple or any(type(item) is not ProjectAuxiliaryFile for item in files):
        raise ProjectInvariantError(
            "auxiliary files must be an immutable exact ProjectAuxiliaryFile tuple"
        )
    expected = tuple(
        sorted(files, key=lambda item: (item.relative_name.casefold(), item.relative_name))
    )
    if files != expected:
        raise ProjectInvariantError(
            "auxiliary files must be sorted by portable case-insensitive name"
        )
    if any(item.relative_name.casefold().endswith(".kicad_prl") for item in files):
        raise ProjectInvariantError(
            "active KiCad .kicad_prl UI state is runtime support, never source content"
        )
    all_names = (*reserved_names, *(item.relative_name for item in files))
    folded = tuple(item.casefold() for item in all_names)
    if len(folded) != len(set(folded)):
        raise ProjectInvariantError(
            "project files must not collide exactly or case-insensitively on Windows"
        )


_EMPTY_AUXILIARY_FILES_SHA256 = auxiliary_files_sha256(())


@dataclass(frozen=True, slots=True)
class ProjectBundleInput:
    stem: str
    project_payload: bytes
    schematic_payload: bytes
    board_payload: bytes
    auxiliary_files: tuple[ProjectAuxiliaryFile, ...] = ()

    def __post_init__(self) -> None:
        require_stem(self.stem)
        for value, label in (
            (self.project_payload, "project payload"),
            (self.schematic_payload, "schematic payload"),
            (self.board_payload, "board payload"),
        ):
            if not isinstance(value, bytes):
                raise TypeError(f"{label} must be bytes")
        _validate_auxiliary_files(
            self.auxiliary_files,
            reserved_names=(
                self.project_filename,
                self.schematic_filename,
                self.board_filename,
                f"{self.stem}.flux-compile.json",
            ),
        )

    @property
    def project_filename(self) -> str:
        return f"{self.stem}.kicad_pro"

    @property
    def schematic_filename(self) -> str:
        return f"{self.stem}.kicad_sch"

    @property
    def board_filename(self) -> str:
        return f"{self.stem}.kicad_pcb"

    @property
    def auxiliary_manifest_sha256(self) -> str:
        return auxiliary_files_sha256(self.auxiliary_files)

    @property
    def all_files(self) -> tuple[ProjectAuxiliaryFile, ...]:
        """Return the complete deterministic project set, including primary files."""

        primary = (
            ProjectAuxiliaryFile(self.project_filename, "application/json", self.project_payload),
            ProjectAuxiliaryFile(
                self.schematic_filename,
                "application/x-kicad-schematic",
                self.schematic_payload,
            ),
            ProjectAuxiliaryFile(
                self.board_filename,
                "application/x-kicad-pcb",
                self.board_payload,
            ),
        )
        return tuple(
            sorted(
                (*primary, *self.auxiliary_files),
                key=lambda item: (item.relative_name.casefold(), item.relative_name),
            )
        )


@dataclass(frozen=True, slots=True)
class ProjectBundle:
    stem: str
    manifest: ProjectManifest
    schematic: Schematic
    board: Board
    diagnostics: ProjectDiagnostics
    auxiliary_files: tuple[ProjectAuxiliaryFile, ...] = ()

    def __post_init__(self) -> None:
        require_stem(self.stem)
        if not isinstance(self.manifest, ProjectManifest):
            raise ProjectInvariantError("bundle manifest must be ProjectManifest")
        if not isinstance(self.schematic, Schematic):
            raise ProjectInvariantError("bundle schematic must be Schematic")
        if not isinstance(self.board, Board):
            raise ProjectInvariantError("bundle board must be Board")
        if not isinstance(self.diagnostics, ProjectDiagnostics):
            raise ProjectInvariantError("bundle diagnostics must be ProjectDiagnostics")
        _validate_auxiliary_files(
            self.auxiliary_files,
            reserved_names=(
                f"{self.stem}.kicad_pro",
                f"{self.stem}.kicad_sch",
                f"{self.stem}.kicad_pcb",
                f"{self.stem}.flux-compile.json",
            ),
        )
        if self.manifest.filename != f"{self.stem}.kicad_pro":
            raise ProjectInvariantError("project filename does not match bundle stem")
        if len(self.manifest.top_level_sheets) != 1:
            raise ProjectInvariantError("supported bundle requires exactly one top-level sheet")
        sheet = self.manifest.top_level_sheets[0]
        if sheet.sheet_id != self.schematic.schematic_id:
            raise ProjectInvariantError("project and schematic root UUIDs do not match")
        if sheet.filename != f"{self.stem}.kicad_sch":
            raise ProjectInvariantError("top-level sheet filename does not match bundle stem")

    @property
    def normalized_ir_sha256(self) -> str:
        return stable_hash(
            {
                "stem": self.stem,
                "project": self.manifest.normalized_ir_sha256,
                "schematic": self.schematic.normalized_ir_sha256,
                "board": self.board.normalized_ir_sha256,
                "auxiliary_files": auxiliary_files_sha256(self.auxiliary_files),
            },
            domain="flux-clone-kicad-project-bundle-ir-v1",
        )


@dataclass(frozen=True, slots=True)
class BundleLimits:
    maximum_project_bytes: int = 4 * 1024 * 1024
    maximum_schematic_bytes: int = 16 * 1024 * 1024
    maximum_board_bytes: int = 24 * 1024 * 1024
    maximum_auxiliary_file_bytes: int = 16 * 1024 * 1024
    maximum_auxiliary_total_bytes: int = 64 * 1024 * 1024
    maximum_auxiliary_file_count: int = 4096
    maximum_total_bytes: int = 96 * 1024 * 1024
    maximum_schematic_tokens: int = 2_000_000
    maximum_schematic_depth: int = 128
    maximum_atom_characters: int = 1_000_000
    maximum_json_depth: int = 64
    maximum_json_nodes: int = 500_000

    def __post_init__(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError("all project bundle limits must be positive integers")


@dataclass(frozen=True, slots=True)
class BundleImportEvidence:
    project_source_sha256: str
    schematic_source_sha256: str
    board_source_sha256: str
    project_ir_sha256: str
    schematic_ir_sha256: str
    board_ir_sha256: str
    bundle_ir_sha256: str
    diagnostics_manifest_sha256: str
    parser_id: str
    kicad_execution: str = "not-run"
    manufacturing_release_eligible: bool = False
    auxiliary_source_manifest_sha256: str = _EMPTY_AUXILIARY_FILES_SHA256

    def __post_init__(self) -> None:
        for field_name in (
            "project_source_sha256",
            "schematic_source_sha256",
            "board_source_sha256",
            "project_ir_sha256",
            "schematic_ir_sha256",
            "board_ir_sha256",
            "bundle_ir_sha256",
            "diagnostics_manifest_sha256",
        ):
            require_sha256(getattr(self, field_name), field_name)
        require_text(self.parser_id, "bundle parser ID")
        require_sha256(
            self.auxiliary_source_manifest_sha256,
            "auxiliary source manifest digest",
        )
        if self.kicad_execution != "not-run":
            raise ProjectInvariantError("codec evidence cannot claim KiCad execution")
        if self.manufacturing_release_eligible is not False:
            raise ProjectInvariantError("codec-only bundle evidence can never authorize release")

    @property
    def evidence_sha256(self) -> str:
        return stable_hash(self, domain="flux-clone-kicad-project-import-evidence-v1")


@dataclass(frozen=True, slots=True)
class BundleExportEvidence:
    project_export_sha256: str
    schematic_export_sha256: str
    board_export_sha256: str
    bundle_ir_sha256: str
    diagnostics_manifest_sha256: str
    writer_id: str
    preserved_unsupported: bool
    kicad_execution: str = "not-run"
    manufacturing_release_eligible: bool = False
    auxiliary_source_manifest_sha256: str = _EMPTY_AUXILIARY_FILES_SHA256

    def __post_init__(self) -> None:
        for field_name in (
            "project_export_sha256",
            "schematic_export_sha256",
            "board_export_sha256",
            "bundle_ir_sha256",
            "diagnostics_manifest_sha256",
        ):
            require_sha256(getattr(self, field_name), field_name)
        require_text(self.writer_id, "bundle writer ID")
        require_sha256(
            self.auxiliary_source_manifest_sha256,
            "auxiliary source manifest digest",
        )
        if not isinstance(self.preserved_unsupported, bool):
            raise ProjectInvariantError("preserved-unsupported flag must be boolean")
        if self.kicad_execution != "not-run":
            raise ProjectInvariantError("codec evidence cannot claim KiCad execution")
        if self.manufacturing_release_eligible is not False:
            raise ProjectInvariantError("codec-only bundle evidence can never authorize release")

    @property
    def evidence_sha256(self) -> str:
        return stable_hash(self, domain="flux-clone-kicad-project-export-evidence-v1")


@dataclass(frozen=True, slots=True)
class BundleRoundTripEvidence:
    project_semantic_parity: bool
    schematic_semantic_parity: bool
    board_semantic_parity: bool
    diagnostics_parity: bool
    imported_bundle_sha256: str
    reparsed_bundle_sha256: str
    kicad_execution: str = "not-run"
    manufacturing_release_eligible: bool = False
    auxiliary_files_parity: bool = True

    def __post_init__(self) -> None:
        for label, value in (
            ("project semantic parity", self.project_semantic_parity),
            ("schematic semantic parity", self.schematic_semantic_parity),
            ("board semantic parity", self.board_semantic_parity),
            ("diagnostics parity", self.diagnostics_parity),
        ):
            if not isinstance(value, bool):
                raise ProjectInvariantError(f"{label} must be boolean")
        require_sha256(self.imported_bundle_sha256, "imported bundle hash")
        require_sha256(self.reparsed_bundle_sha256, "reparsed bundle hash")
        if self.kicad_execution != "not-run":
            raise ProjectInvariantError("round-trip evidence cannot claim KiCad execution")
        if self.manufacturing_release_eligible is not False:
            raise ProjectInvariantError("codec-only bundle evidence can never authorize release")
        if type(self.auxiliary_files_parity) is not bool:
            raise ProjectInvariantError("auxiliary file parity must be boolean")

    @property
    def semantic_parity(self) -> bool:
        return (
            self.project_semantic_parity
            and self.schematic_semantic_parity
            and self.board_semantic_parity
        )

    @property
    def evidence_sha256(self) -> str:
        return stable_hash(self, domain="flux-clone-kicad-project-round-trip-v1")

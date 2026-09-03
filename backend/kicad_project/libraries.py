"""Bounded parsers for hermetic project-local KiCad symbol/footprint libraries."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import PurePosixPath

from backend.kicad_io import PointNm
from backend.kicad_io.sexpr import Atom, SExpr, canonical_text, head, parse, scalar_text

from .errors import ProjectInvariantError, ProjectSyntaxError
from .model import (
    BundleLimits,
    ProjectAuxiliaryFile,
    auxiliary_files_sha256,
    require_int,
    require_project_relative_name,
    require_sha256,
    require_text,
    require_uuid,
)

_LOCAL_ID = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}")
_VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)*")
_DECIMAL = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?")
_MODEL_PREFIX = "${KICAD10_3DMODEL_DIR}/"
_MODEL_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+() -]{0,119}")
_GRAPHIC_KINDS = {"fp_line", "fp_rect", "fp_poly", "fp_text"}
_GRAPHIC_LAYERS = {"F.Fab", "F.CrtYd", "F.SilkS"}
_STROKE_TYPES = {"default", "solid", "dash", "dot", "dash_dot", "dash_dot_dot"}
_FILL_TYPES = {"none", "solid"}
_DEFAULT_LIMITS = BundleLimits()


def _children(expression: SExpr, wanted: str) -> tuple[tuple[SExpr, ...], ...]:
    if not isinstance(expression, tuple):
        return ()
    return tuple(
        child
        for child in expression[1:]
        if isinstance(child, tuple) and head(child) == wanted
    )


def _one(expression: SExpr, wanted: str, label: str) -> tuple[SExpr, ...]:
    result = _children(expression, wanted)
    if len(result) != 1:
        raise ProjectInvariantError(f"{label} requires exactly one {wanted} expression")
    return result[0]


def _scalar(expression: SExpr, wanted: str, label: str) -> str:
    child = _one(expression, wanted, label)
    if len(child) != 2:
        raise ProjectInvariantError(f"{label} {wanted} requires one scalar")
    return scalar_text(child[1], label=f"{label} {wanted}")


def _first(expression: tuple[SExpr, ...], label: str) -> str:
    if len(expression) < 2:
        raise ProjectInvariantError(f"{label} requires a name")
    return scalar_text(expression[1], label=label)


def _require_only_children(
    expression: tuple[SExpr, ...],
    *,
    start: int,
    allowed: set[str],
    label: str,
) -> None:
    for child in expression[start:]:
        child_head = head(child)
        if child_head is None or child_head not in allowed:
            raise ProjectInvariantError(f"{label} contains an unreviewed construct")


def _decimal_integer(
    expression: SExpr,
    *,
    scale: int,
    label: str,
) -> int:
    if not isinstance(expression, Atom) or _DECIMAL.fullmatch(expression.value) is None:
        raise ProjectInvariantError(f"{label} must be a plain decimal atom")
    try:
        scaled = Decimal(expression.value) * scale
    except InvalidOperation as exc:  # pragma: no cover - guarded by the grammar
        raise ProjectInvariantError(f"{label} is not a finite decimal") from exc
    if scaled != scaled.to_integral_value():
        raise ProjectInvariantError(f"{label} exceeds the supported exact resolution")
    return require_int(int(scaled), label)


def _point(expression: tuple[SExpr, ...], label: str) -> PointNm:
    if len(expression) != 3:
        raise ProjectInvariantError(f"{label} requires exactly two coordinates")
    return PointNm(
        _decimal_integer(expression[1], scale=1_000_000, label=f"{label} x"),
        _decimal_integer(expression[2], scale=1_000_000, label=f"{label} y"),
    )


def _graphic_layer(expression: tuple[SExpr, ...], label: str) -> str:
    layer = _scalar(expression, "layer", label)
    if layer not in _GRAPHIC_LAYERS:
        raise ProjectInvariantError(
            f"{label} layer must be one of the reviewed footprint presentation layers"
        )
    return layer


def _stroke(expression: tuple[SExpr, ...], label: str) -> tuple[int, str]:
    stroke = _one(expression, "stroke", label)
    _require_only_children(
        stroke,
        start=1,
        allowed={"width", "type"},
        label=f"{label} stroke",
    )
    width_node = _one(stroke, "width", f"{label} stroke")
    if len(width_node) != 2:
        raise ProjectInvariantError(f"{label} stroke width requires one scalar")
    width_nm = _decimal_integer(
        width_node[1], scale=1_000_000, label=f"{label} stroke width"
    )
    if width_nm < 0:
        raise ProjectInvariantError(f"{label} stroke width cannot be negative")
    stroke_type = _scalar(stroke, "type", f"{label} stroke")
    if stroke_type not in _STROKE_TYPES:
        raise ProjectInvariantError(f"{label} stroke type is outside the reviewed subset")
    return width_nm, stroke_type


def _fill(expression: tuple[SExpr, ...], label: str) -> str:
    fill = _scalar(expression, "fill", label)
    if fill not in _FILL_TYPES:
        raise ProjectInvariantError(f"{label} fill type is outside the reviewed subset")
    return fill


def _require_model_path(value: object) -> str:
    path = require_text(value, "model path")
    if not path.startswith(_MODEL_PREFIX):
        raise ProjectInvariantError(
            "model path must use the portable ${KICAD10_3DMODEL_DIR}/ prefix"
        )
    relative = path.removeprefix(_MODEL_PREFIX)
    posix = PurePosixPath(relative)
    if (
        not relative
        or "\\" in relative
        or relative.startswith("/")
        or ":" in relative
        or posix.is_absolute()
        or any(part in {"", ".", ".."} for part in relative.split("/"))
        or any(_MODEL_SEGMENT.fullmatch(part) is None for part in relative.split("/"))
        or posix.suffix.lower() not in {".step", ".wrl"}
    ):
        raise ProjectInvariantError(
            "model path must be a traversal-free POSIX-relative STEP or WRL reference"
        )
    require_project_relative_name(relative)
    return path


def _model_vector(
    expression: tuple[SExpr, ...],
    wanted: str,
    *,
    scale: int,
    label: str,
) -> tuple[int, int, int]:
    outer = _one(expression, wanted, label)
    _require_only_children(outer, start=1, allowed={"xyz"}, label=f"{label} {wanted}")
    xyz = _one(outer, "xyz", f"{label} {wanted}")
    if len(xyz) != 4:
        raise ProjectInvariantError(f"{label} {wanted} xyz requires exactly three values")
    return (
        _decimal_integer(xyz[1], scale=scale, label=f"{label} {wanted} x"),
        _decimal_integer(xyz[2], scale=scale, label=f"{label} {wanted} y"),
        _decimal_integer(xyz[3], scale=scale, label=f"{label} {wanted} z"),
    )


def _parse_model_reference(expression: tuple[SExpr, ...]) -> ProjectModelReference:
    label = "footprint model"
    if len(expression) < 2:
        raise ProjectInvariantError("footprint model requires a path")
    path = _require_model_path(scalar_text(expression[1], label="footprint model path"))
    _require_only_children(
        expression,
        start=2,
        allowed={"offset", "scale", "rotate"},
        label=label,
    )
    return ProjectModelReference(
        path,
        _model_vector(expression, "offset", scale=1_000_000, label=label),
        _model_vector(expression, "scale", scale=1_000_000, label=label),
        _model_vector(expression, "rotate", scale=1_000_000, label=label),
        canonical_text(expression),
    )


def _parse_text_graphic(expression: tuple[SExpr, ...]) -> ProjectFootprintGraphic:
    label = "footprint text"
    if len(expression) < 3:
        raise ProjectInvariantError("footprint text requires a kind and text")
    text_kind = scalar_text(expression[1], label="footprint text kind")
    if text_kind not in {"reference", "value", "user"}:
        raise ProjectInvariantError("footprint text kind is outside the reviewed subset")
    text = require_text(
        scalar_text(expression[2], label="footprint text"),
        "footprint text",
        allow_empty=True,
    )
    _require_only_children(
        expression,
        start=3,
        allowed={"at", "layer", "effects", "uuid"},
        label=label,
    )
    at = _one(expression, "at", label)
    if len(at) not in {3, 4}:
        raise ProjectInvariantError("footprint text at requires x, y, and optional rotation")
    position = _point((at[0], at[1], at[2]), "footprint text at")
    rotation_udeg = (
        0
        if len(at) == 3
        else _decimal_integer(at[3], scale=1_000_000, label="footprint text rotation")
    )
    effects = _one(expression, "effects", label)
    _require_only_children(effects, start=1, allowed={"font"}, label="footprint text effects")
    font = _one(effects, "font", "footprint text effects")
    _require_only_children(
        font,
        start=1,
        allowed={"size", "thickness"},
        label="footprint text font",
    )
    size = _one(font, "size", "footprint text font")
    if len(size) != 3:
        raise ProjectInvariantError("footprint text font size requires x and y")
    font_size = (
        _decimal_integer(size[1], scale=1_000_000, label="footprint text font x size"),
        _decimal_integer(size[2], scale=1_000_000, label="footprint text font y size"),
    )
    thickness = _one(font, "thickness", "footprint text font")
    if len(thickness) != 2:
        raise ProjectInvariantError("footprint text font thickness requires one value")
    font_thickness = _decimal_integer(
        thickness[1], scale=1_000_000, label="footprint text font thickness"
    )
    graphic_id = require_uuid(_scalar(expression, "uuid", label), "footprint text UUID")
    return ProjectFootprintGraphic(
        "fp_text",
        graphic_id,
        _graphic_layer(expression, label),
        (position,),
        font_thickness,
        "default",
        "solid",
        text_kind,
        text,
        rotation_udeg,
        font_size,
        font_thickness,
        canonical_text(expression),
    )


def _parse_shape_graphic(expression: tuple[SExpr, ...]) -> ProjectFootprintGraphic:
    kind = head(expression)
    if kind not in {"fp_line", "fp_rect", "fp_poly"}:
        raise ProjectInvariantError("footprint graphic kind is outside the reviewed subset")
    label = f"footprint {kind.removeprefix('fp_')}"
    allowed = {"stroke", "layer", "uuid"}
    if kind == "fp_poly":
        allowed |= {"pts", "fill"}
    else:
        allowed |= {"start", "end"}
        if kind == "fp_rect":
            allowed.add("fill")
    _require_only_children(expression, start=1, allowed=allowed, label=label)
    if kind == "fp_poly":
        pts = _one(expression, "pts", label)
        _require_only_children(pts, start=1, allowed={"xy"}, label=f"{label} points")
        points = tuple(_point(item, f"{label} point") for item in _children(pts, "xy"))
        if len(points) < 3:
            raise ProjectInvariantError("footprint polygon requires at least three points")
        if len(points) != len(set(points)):
            raise ProjectInvariantError("footprint polygon points must be unique")
    else:
        points = (_point(_one(expression, "start", label), f"{label} start"),)
        points += (_point(_one(expression, "end", label), f"{label} end"),)
        if points[0] == points[1]:
            raise ProjectInvariantError(f"{label} must have non-zero geometry")
        if kind == "fp_rect" and (
            points[0].x == points[1].x or points[0].y == points[1].y
        ):
            raise ProjectInvariantError("footprint rectangle must have non-zero area")
    stroke_width_nm, stroke_type = _stroke(expression, label)
    graphic_id = require_uuid(_scalar(expression, "uuid", label), f"{label} UUID")
    return ProjectFootprintGraphic(
        kind,
        graphic_id,
        _graphic_layer(expression, label),
        points,
        stroke_width_nm,
        stroke_type,
        None if kind == "fp_line" else _fill(expression, label),
        None,
        None,
        0,
        None,
        None,
        canonical_text(expression),
    )


def _parse_footprint_graphic(expression: tuple[SExpr, ...]) -> ProjectFootprintGraphic:
    if head(expression) == "fp_text":
        return _parse_text_graphic(expression)
    return _parse_shape_graphic(expression)


def _parse_auxiliary_sexpr(file: ProjectAuxiliaryFile, limits: BundleLimits) -> SExpr:
    if len(file.payload) > limits.maximum_auxiliary_file_bytes:
        raise ProjectSyntaxError(
            f"auxiliary file {file.relative_name!r} exceeds its byte limit"
        )
    try:
        return parse(file.payload)
    except Exception as exc:
        raise ProjectSyntaxError(
            f"auxiliary file {file.relative_name!r} is not a KiCad S-expression"
        ) from exc


@dataclass(frozen=True, slots=True)
class ProjectLibraryTable:
    table_kind: str
    version: int
    library_name: str
    library_type: str
    uri: str
    source_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not ProjectLibraryTable:
            raise ProjectInvariantError("library table must use the exact concrete type")
        if self.table_kind not in {"symbol", "footprint"}:
            raise ProjectInvariantError("library table kind must be symbol or footprint")
        require_int(self.version, "library table version", minimum=1)
        require_text(self.library_name, "library table name")
        require_text(self.library_type, "library table type")
        require_text(self.uri, "library table URI")
        require_sha256(self.source_sha256, "library table source hash")


@dataclass(frozen=True, slots=True, order=True)
class ProjectSymbolDefinition:
    local_id: str
    canonical_payload: str

    def __post_init__(self) -> None:
        if type(self) is not ProjectSymbolDefinition or _LOCAL_ID.fullmatch(self.local_id) is None:
            raise ProjectInvariantError("symbol definition local ID is not portable")
        require_text(self.canonical_payload, "symbol canonical payload")


@dataclass(frozen=True, slots=True)
class ProjectSymbolLibrary:
    format_version: int
    generator: str
    generator_version: str
    definitions: tuple[ProjectSymbolDefinition, ...]
    source_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not ProjectSymbolLibrary:
            raise ProjectInvariantError("symbol library must use the exact concrete type")
        require_int(self.format_version, "symbol library format version", minimum=1)
        require_text(self.generator, "symbol library generator")
        if _VERSION.fullmatch(self.generator_version) is None:
            raise ProjectInvariantError("symbol library generator version is invalid")
        if type(self.definitions) is not tuple or any(
            type(item) is not ProjectSymbolDefinition for item in self.definitions
        ):
            raise ProjectInvariantError("symbol definitions must be an immutable exact tuple")
        if tuple(sorted(self.definitions)) != self.definitions:
            raise ProjectInvariantError("symbol definitions must be deterministically sorted")
        if len({item.local_id.casefold() for item in self.definitions}) != len(
            self.definitions
        ):
            raise ProjectInvariantError("symbol IDs collide case-insensitively")
        require_sha256(self.source_sha256, "symbol library source hash")


@dataclass(frozen=True, slots=True)
class ProjectFootprintGraphic:
    """One reviewed, source-ordered footprint presentation primitive."""

    kind: str
    graphic_id: str
    layer: str
    points_nm: tuple[PointNm, ...]
    stroke_width_nm: int
    stroke_type: str
    fill_type: str | None
    text_kind: str | None
    text: str | None
    rotation_udeg: int
    font_size_nm: tuple[int, int] | None
    font_thickness_nm: int | None
    canonical_payload: str

    def __post_init__(self) -> None:
        if type(self) is not ProjectFootprintGraphic:
            raise ProjectInvariantError("footprint graphic must use the exact concrete type")
        if self.kind not in _GRAPHIC_KINDS:
            raise ProjectInvariantError("footprint graphic kind is outside the reviewed subset")
        require_uuid(self.graphic_id, "footprint graphic UUID")
        if self.layer not in _GRAPHIC_LAYERS:
            raise ProjectInvariantError("footprint graphic layer is outside the reviewed subset")
        if self.layer == "F.SilkS" and self.kind != "fp_text":
            raise ProjectInvariantError(
                "legacy front-silkscreen compatibility is limited to footprint text"
            )
        if type(self.points_nm) is not tuple or any(
            type(item) is not PointNm for item in self.points_nm
        ):
            raise ProjectInvariantError("footprint graphic points must be an exact PointNm tuple")
        expected_points = {"fp_line": 2, "fp_rect": 2, "fp_text": 1}
        if self.kind == "fp_poly":
            if len(self.points_nm) < 3:
                raise ProjectInvariantError("footprint polygon requires at least three points")
        elif len(self.points_nm) != expected_points[self.kind]:
            raise ProjectInvariantError("footprint graphic has the wrong point count")
        require_int(self.stroke_width_nm, "footprint graphic stroke width", minimum=0)
        if self.stroke_type not in _STROKE_TYPES:
            raise ProjectInvariantError("footprint graphic stroke type is invalid")
        if self.fill_type is not None and self.fill_type not in _FILL_TYPES:
            raise ProjectInvariantError("footprint graphic fill type is invalid")
        require_int(self.rotation_udeg, "footprint graphic rotation")
        if not -360_000_000 < self.rotation_udeg < 360_000_000:
            raise ProjectInvariantError("footprint graphic rotation must be within one turn")
        if self.kind == "fp_text":
            if self.text_kind not in {"reference", "value", "user"}:
                raise ProjectInvariantError("footprint text kind is invalid")
            require_text(self.text, "footprint graphic text", allow_empty=True)
            if (
                type(self.font_size_nm) is not tuple
                or len(self.font_size_nm) != 2
                or any(type(value) is not int or value <= 0 for value in self.font_size_nm)
            ):
                raise ProjectInvariantError(
                    "footprint text font size must be two positive integers"
                )
            if self.font_thickness_nm is None:
                raise ProjectInvariantError("footprint text requires a font thickness")
            require_int(
                self.font_thickness_nm,
                "footprint text font thickness",
                minimum=0,
            )
            if self.fill_type != "solid":
                raise ProjectInvariantError("footprint text must use its implicit solid fill")
        elif any(
            value is not None
            for value in (
                self.text_kind,
                self.text,
                self.font_size_nm,
                self.font_thickness_nm,
            )
        ):
            raise ProjectInvariantError("non-text footprint graphics cannot carry text fields")
        if self.kind == "fp_line" and self.fill_type is not None:
            raise ProjectInvariantError("footprint lines cannot carry a fill")
        if self.kind in {"fp_rect", "fp_poly"} and self.fill_type is None:
            raise ProjectInvariantError("footprint area graphics require an explicit fill")
        require_text(self.canonical_payload, "footprint graphic canonical payload")

    @property
    def uuid(self) -> str:
        """Return the source UUID using KiCad's field terminology."""

        return self.graphic_id

    @property
    def points(self) -> tuple[PointNm, ...]:
        return self.points_nm

    @property
    def fill(self) -> str | None:
        return self.fill_type


@dataclass(frozen=True, slots=True)
class ProjectModelReference:
    """One portable KiCad 3D-model reference and its exact fixed-point transform."""

    path: str
    offset_nm: tuple[int, int, int]
    scale_ppm: tuple[int, int, int]
    rotate_udeg: tuple[int, int, int]
    canonical_payload: str

    def __post_init__(self) -> None:
        if type(self) is not ProjectModelReference:
            raise ProjectInvariantError("model reference must use the exact concrete type")
        _require_model_path(self.path)
        for label, vector in (
            ("model offset", self.offset_nm),
            ("model scale", self.scale_ppm),
            ("model rotation", self.rotate_udeg),
        ):
            if type(vector) is not tuple or len(vector) != 3:
                raise ProjectInvariantError(f"{label} must be an exact three-integer tuple")
            for value in vector:
                require_int(value, label)
        if any(value <= 0 for value in self.scale_ppm):
            raise ProjectInvariantError("model scale must be strictly positive")
        if any(not -360_000_000 < value < 360_000_000 for value in self.rotate_udeg):
            raise ProjectInvariantError("model rotation components must be within one turn")
        require_text(self.canonical_payload, "model reference canonical payload")

    @property
    def model_path(self) -> str:
        return self.path

    @property
    def offset(self) -> tuple[int, int, int]:
        return self.offset_nm

    @property
    def scale(self) -> tuple[int, int, int]:
        return self.scale_ppm

    @property
    def rotate(self) -> tuple[int, int, int]:
        return self.rotate_udeg


@dataclass(frozen=True, slots=True, order=True)
class ProjectFootprintModule:
    relative_name: str
    local_id: str
    format_version: int
    generator: str
    generator_version: str
    canonical_payload: str
    source_sha256: str
    graphics: tuple[ProjectFootprintGraphic, ...] = field(default=(), compare=False)
    models: tuple[ProjectModelReference, ...] = field(default=(), compare=False)

    def __post_init__(self) -> None:
        if type(self) is not ProjectFootprintModule:
            raise ProjectInvariantError("footprint module must use the exact concrete type")
        require_project_relative_name(self.relative_name)
        if _LOCAL_ID.fullmatch(self.local_id) is None:
            raise ProjectInvariantError("footprint module local ID is not portable")
        require_int(self.format_version, "footprint format version", minimum=1)
        require_text(self.generator, "footprint generator")
        if _VERSION.fullmatch(self.generator_version) is None:
            raise ProjectInvariantError("footprint generator version is invalid")
        require_text(self.canonical_payload, "footprint canonical payload")
        require_sha256(self.source_sha256, "footprint module source hash")
        if type(self.graphics) is not tuple or any(
            type(item) is not ProjectFootprintGraphic for item in self.graphics
        ):
            raise ProjectInvariantError("footprint graphics must be an immutable exact tuple")
        if type(self.models) is not tuple or any(
            type(item) is not ProjectModelReference for item in self.models
        ):
            raise ProjectInvariantError("footprint models must be an immutable exact tuple")
        for graphic_id in {item.graphic_id for item in self.graphics}:
            matches = tuple(
                item for item in self.graphics if item.graphic_id == graphic_id
            )
            if len(matches) < 2:
                continue
            legacy_v3_annotation = (
                self.generator == "flux_clone"
                and not self.models
                and all(item.kind in {"fp_line", "fp_text"} for item in self.graphics)
                and all(
                    item.kind == "fp_text"
                    and item.layer == "F.SilkS"
                    and item.text_kind == "user"
                    for item in matches
                )
                and len({item.text for item in matches}) == 1
                and len({item.points_nm for item in matches}) == len(matches)
            )
            if not legacy_v3_annotation:
                raise ProjectInvariantError("footprint graphic UUIDs must be unique")
        model_paths = tuple(item.path.casefold() for item in self.models)
        if len(model_paths) != len(set(model_paths)):
            raise ProjectInvariantError("footprint model paths must be unique")

    @property
    def model_references(self) -> tuple[ProjectModelReference, ...]:
        return self.models


@dataclass(frozen=True, slots=True)
class HermeticProjectLibraries:
    symbol_table: ProjectLibraryTable
    footprint_table: ProjectLibraryTable
    symbol_library: ProjectSymbolLibrary
    footprint_modules: tuple[ProjectFootprintModule, ...]
    auxiliary_manifest_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not HermeticProjectLibraries:
            raise ProjectInvariantError("hermetic libraries must use the exact concrete type")
        if type(self.symbol_table) is not ProjectLibraryTable:
            raise ProjectInvariantError("symbol table has an invalid type")
        if type(self.footprint_table) is not ProjectLibraryTable:
            raise ProjectInvariantError("footprint table has an invalid type")
        if type(self.symbol_library) is not ProjectSymbolLibrary:
            raise ProjectInvariantError("symbol library has an invalid type")
        if type(self.footprint_modules) is not tuple or any(
            type(item) is not ProjectFootprintModule for item in self.footprint_modules
        ):
            raise ProjectInvariantError("footprint modules must be an immutable exact tuple")
        if tuple(sorted(self.footprint_modules)) != self.footprint_modules:
            raise ProjectInvariantError("footprint modules must be deterministically sorted")
        require_sha256(self.auxiliary_manifest_sha256, "auxiliary manifest digest")


def _parse_table(
    file: ProjectAuxiliaryFile,
    *,
    root_head: str,
    table_kind: str,
    expected_uri: str,
    limits: BundleLimits,
) -> ProjectLibraryTable:
    expression = _parse_auxiliary_sexpr(file, limits)
    if not isinstance(expression, tuple) or head(expression) != root_head:
        raise ProjectInvariantError(f"{file.relative_name} has the wrong table root")
    version_text = _scalar(expression, "version", file.relative_name)
    if not version_text.isascii() or not version_text.isdigit() or int(version_text) != 7:
        raise ProjectInvariantError("project library tables require exact version 7")
    libraries = _children(expression, "lib")
    if len(libraries) != 1:
        raise ProjectInvariantError("hermetic library table requires exactly one entry")
    library = libraries[0]
    values = {
        key: _scalar(library, key, "library entry")
        for key in ("name", "type", "uri", "options", "descr")
    }
    if (
        values["name"] != "FluxGenerated"
        or values["type"] != "KiCad"
        or values["uri"] != expected_uri
        or values["options"]
        or values["descr"]
    ):
        raise ProjectInvariantError("library table entry is not the sealed FluxGenerated entry")
    known = {"version", "lib"}
    if any(head(child) not in known for child in expression[1:] if isinstance(child, tuple)):
        raise ProjectInvariantError("library table contains an unreviewed root construct")
    return ProjectLibraryTable(
        table_kind,
        7,
        values["name"],
        values["type"],
        values["uri"],
        file.sha256,
    )


def _parse_symbol_library(
    file: ProjectAuxiliaryFile,
    limits: BundleLimits,
) -> ProjectSymbolLibrary:
    expression = _parse_auxiliary_sexpr(file, limits)
    if not isinstance(expression, tuple) or head(expression) != "kicad_symbol_lib":
        raise ProjectInvariantError("FluxGenerated.kicad_sym has the wrong root")
    version_text = _scalar(expression, "version", "symbol library")
    if not version_text.isdigit():
        raise ProjectInvariantError("symbol library version must be an integer date")
    generator = _scalar(expression, "generator", "symbol library")
    generator_version = _scalar(expression, "generator_version", "symbol library")
    definitions = tuple(
        sorted(
            ProjectSymbolDefinition(_first(item, "symbol definition"), canonical_text(item))
            for item in _children(expression, "symbol")
        )
    )
    known = {"version", "generator", "generator_version", "symbol"}
    if any(head(child) not in known for child in expression[1:] if isinstance(child, tuple)):
        raise ProjectInvariantError("symbol library contains an unreviewed root construct")
    return ProjectSymbolLibrary(
        int(version_text),
        generator,
        generator_version,
        definitions,
        file.sha256,
    )


def _parse_footprint_module(
    file: ProjectAuxiliaryFile,
    limits: BundleLimits,
) -> ProjectFootprintModule:
    expression = _parse_auxiliary_sexpr(file, limits)
    if not isinstance(expression, tuple) or head(expression) != "footprint":
        raise ProjectInvariantError(f"{file.relative_name} has the wrong footprint root")
    local_id = _first(expression, "footprint module")
    expected_name = file.relative_name.removeprefix("FluxGenerated.pretty/").removesuffix(
        ".kicad_mod"
    )
    if local_id != expected_name:
        raise ProjectInvariantError("footprint module name must match its portable filename")
    version_text = _scalar(expression, "version", "footprint module")
    if not version_text.isdigit():
        raise ProjectInvariantError("footprint module version must be an integer date")
    generator = _scalar(expression, "generator", "footprint module")
    generator_version = _scalar(expression, "generator_version", "footprint module")
    if _scalar(expression, "layer", "footprint module") != "F.Cu":
        raise ProjectInvariantError("project-local footprint modules must be front-layer links")
    if not _children(expression, "pad"):
        raise ProjectInvariantError("footprint module requires at least one pad")
    if len(_children(expression, "attr")) > 1:
        raise ProjectInvariantError("footprint module permits at most one attr expression")
    property_names = tuple(
        _first(item, "footprint property") for item in _children(expression, "property")
    )
    if len(property_names) != len(set(property_names)):
        raise ProjectInvariantError("footprint property names must be unique")
    known = {
        "version",
        "generator",
        "generator_version",
        "layer",
        "property",
        "attr",
        "pad",
        *_GRAPHIC_KINDS,
        "model",
    }
    _require_only_children(
        expression,
        start=2,
        allowed=known,
        label="footprint module",
    )
    graphics = tuple(
        _parse_footprint_graphic(child)
        for child in expression[2:]
        if isinstance(child, tuple) and head(child) in _GRAPHIC_KINDS
    )
    models = tuple(
        _parse_model_reference(child)
        for child in expression[2:]
        if isinstance(child, tuple) and head(child) == "model"
    )
    return ProjectFootprintModule(
        file.relative_name,
        local_id,
        int(version_text),
        generator,
        generator_version,
        canonical_text(expression),
        file.sha256,
        graphics,
        models,
    )


def parse_hermetic_project_libraries(
    files: tuple[ProjectAuxiliaryFile, ...],
    *,
    limits: BundleLimits = _DEFAULT_LIMITS,
) -> HermeticProjectLibraries:
    """Parse and validate the exact closed FluxGenerated auxiliary-file set."""

    if type(files) is not tuple or any(type(item) is not ProjectAuxiliaryFile for item in files):
        raise TypeError("files must be an exact ProjectAuxiliaryFile tuple")
    if type(limits) is not BundleLimits:
        raise TypeError("limits must use the exact BundleLimits type")
    if len(files) > limits.maximum_auxiliary_file_count:
        raise ProjectSyntaxError("hermetic auxiliary file count exceeds its limit")
    if sum(len(item.payload) for item in files) > limits.maximum_auxiliary_total_bytes:
        raise ProjectSyntaxError("hermetic auxiliary files exceed their aggregate limit")
    by_name = {item.relative_name: item for item in files}
    if len(by_name) != len(files):
        raise ProjectInvariantError("auxiliary file names must be unique")
    required = {"sym-lib-table", "fp-lib-table", "FluxGenerated.kicad_sym"}
    missing = required - by_name.keys()
    if missing:
        raise ProjectInvariantError(
            "hermetic library bundle is missing: " + ", ".join(sorted(missing))
        )
    module_names = tuple(
        sorted(
            name
            for name in by_name
            if name.startswith("FluxGenerated.pretty/") and name.endswith(".kicad_mod")
        )
    )
    if set(by_name) != required | set(module_names):
        raise ProjectInvariantError("auxiliary file set contains an unreviewed file")
    symbol_table = _parse_table(
        by_name["sym-lib-table"],
        root_head="sym_lib_table",
        table_kind="symbol",
        expected_uri="${KIPRJMOD}/FluxGenerated.kicad_sym",
        limits=limits,
    )
    footprint_table = _parse_table(
        by_name["fp-lib-table"],
        root_head="fp_lib_table",
        table_kind="footprint",
        expected_uri="${KIPRJMOD}/FluxGenerated.pretty",
        limits=limits,
    )
    symbol_library = _parse_symbol_library(by_name["FluxGenerated.kicad_sym"], limits)
    modules = tuple(_parse_footprint_module(by_name[name], limits) for name in module_names)
    if len({item.local_id.casefold() for item in modules}) != len(modules):
        raise ProjectInvariantError("footprint module IDs collide case-insensitively")
    return HermeticProjectLibraries(
        symbol_table,
        footprint_table,
        symbol_library,
        modules,
        auxiliary_files_sha256(files),
    )

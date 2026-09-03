"""Immutable integer-geometry IR for the supported KiCad PCB exchange slice."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import uuid
from dataclasses import dataclass, fields, is_dataclass, replace
from enum import Enum
from typing import Any, Mapping

from .errors import KiCadInvariantError

_SHA256 = re.compile(r"[0-9a-f]{64}")
_INT64_MIN = -(1 << 63)
_INT64_MAX = (1 << 63) - 1


def _require_int(value: object, label: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise KiCadInvariantError(f"{label} must be an integer")
    if not _INT64_MIN <= value <= _INT64_MAX:
        raise KiCadInvariantError(f"{label} must fit in a signed 64-bit integer")
    if minimum is not None and value < minimum:
        raise KiCadInvariantError(f"{label} must be at least {minimum}")
    return value


def _require_text(value: object, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise KiCadInvariantError(f"{label} must be a string")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise KiCadInvariantError(f"{label} must be valid Unicode") from exc
    if unicodedata.normalize("NFC", value) != value:
        raise KiCadInvariantError(f"{label} must be NFC-normalized")
    if (not allow_empty and not value) or any(
        unicodedata.category(character).startswith("C") for character in value
    ):
        raise KiCadInvariantError(f"{label} contains empty or control-character text")
    return value


def _require_uuid(value: object, label: str) -> str:
    text = _require_text(value, label)
    try:
        parsed = uuid.UUID(text)
    except (ValueError, AttributeError) as exc:
        raise KiCadInvariantError(f"{label} must be a UUID") from exc
    if str(parsed) != text:
        raise KiCadInvariantError(f"{label} must use canonical lowercase UUID syntax")
    return text


def _canonical_data(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        raise KiCadInvariantError("floating-point values are forbidden in the KiCad IR")
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: _canonical_data(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise KiCadInvariantError("canonical mapping keys must be strings")
        return {key: _canonical_data(value[key]) for key in sorted(value)}
    if isinstance(value, (tuple, list)):
        return [_canonical_data(item) for item in value]
    raise KiCadInvariantError(f"value of type {type(value).__name__} is not canonical")


def _stable_hash(value: Any, *, domain: str) -> str:
    body = json.dumps(
        _canonical_data(value),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(domain.encode("utf-8") + b"\x00" + body).hexdigest()


def canonical_net_id(name: str) -> str:
    """Create a stable canonical identity independent of KiCad's local net code."""

    normalized = unicodedata.normalize("NFC", name)
    _require_text(normalized, "net name")
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.casefold()).strip("-")[:24] or "named"
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"net-{slug}-{digest}"


class DiagnosticDisposition(str, Enum):
    PRESERVED = "preserved"
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True, slots=True)
class DiagnosticConstruct:
    scope: str
    path: str
    head: str
    disposition: DiagnosticDisposition
    reason: str
    canonical_sexpr: str
    construct_sha256: str

    def __post_init__(self) -> None:
        _require_text(self.scope, "diagnostic scope")
        _require_text(self.path, "diagnostic path")
        _require_text(self.head, "diagnostic head")
        if not isinstance(self.disposition, DiagnosticDisposition):
            raise KiCadInvariantError("diagnostic disposition is invalid")
        _require_text(self.reason, "diagnostic reason")
        _require_text(self.canonical_sexpr, "diagnostic canonical S-expression")
        if _SHA256.fullmatch(self.construct_sha256) is None:
            raise KiCadInvariantError("diagnostic construct hash must be lowercase SHA-256")
        expected = hashlib.sha256(self.canonical_sexpr.encode("utf-8")).hexdigest()
        if expected != self.construct_sha256:
            raise KiCadInvariantError("diagnostic construct hash does not bind its S-expression")


@dataclass(frozen=True, slots=True)
class DiagnosticsManifest:
    constructs: tuple[DiagnosticConstruct, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.constructs, tuple) or any(
            not isinstance(item, DiagnosticConstruct) for item in self.constructs
        ):
            raise KiCadInvariantError("diagnostic constructs must be an immutable tuple")
        identities = [(item.scope, item.path) for item in self.constructs]
        if len(identities) != len(set(identities)):
            raise KiCadInvariantError("diagnostic paths must be unique within a scope")

    def normalized(self) -> "DiagnosticsManifest":
        return DiagnosticsManifest(
            tuple(
                sorted(
                    self.constructs,
                    key=lambda item: (
                        item.scope,
                        item.head,
                        _diagnostic_occurrence(item.path),
                        item.disposition.value,
                        item.construct_sha256,
                    ),
                )
            )
        )

    @property
    def unsupported(self) -> tuple[DiagnosticConstruct, ...]:
        return tuple(
            item
            for item in self.normalized().constructs
            if item.disposition is DiagnosticDisposition.UNSUPPORTED
        )

    @property
    def manifest_sha256(self) -> str:
        return _stable_hash(
            self.normalized(), domain="flux-clone-kicad-diagnostics-manifest-v1"
        )


@dataclass(frozen=True, slots=True, order=True)
class PointNm:
    x: int
    y: int

    def __post_init__(self) -> None:
        _require_int(self.x, "x coordinate in nanometres")
        _require_int(self.y, "y coordinate in nanometres")


@dataclass(frozen=True, slots=True)
class Layer:
    ordinal: int
    name: str
    kind: str
    user_name: str | None = None

    def __post_init__(self) -> None:
        _require_int(self.ordinal, "layer ordinal", minimum=0)
        _require_text(self.name, "layer name")
        _require_text(self.kind, "layer kind")
        if self.user_name is not None:
            _require_text(self.user_name, "layer user name")


@dataclass(frozen=True, slots=True)
class Net:
    net_id: str
    name: str

    def __post_init__(self) -> None:
        _require_text(self.net_id, "canonical net ID")
        _require_text(self.name, "net name")


class PadKind(str, Enum):
    SMD = "smd"
    THROUGH_HOLE = "thru_hole"
    NPTH = "np_thru_hole"


class PadDrillShape(str, Enum):
    CIRCLE = "circle"
    OVAL = "oval"


class PadShape(str, Enum):
    CIRCLE = "circle"
    RECT = "rect"
    OVAL = "oval"
    ROUNDRECT = "roundrect"


@dataclass(frozen=True, slots=True)
class Pad:
    pad_id: str
    number: str
    kind: PadKind
    shape: PadShape
    position: PointNm
    rotation_udeg: int
    size_x_nm: int
    size_y_nm: int
    drill_x_nm: int
    drill_y_nm: int
    layers: tuple[str, ...]
    net_id: str | None = None
    pin_function: str | None = None
    pin_type: str | None = None
    roundrect_ratio_ppm: int | None = None
    locked: bool = False

    def __post_init__(self) -> None:
        if type(self) is not Pad:
            raise KiCadInvariantError("pad must be the exact concrete Pad type")
        _require_uuid(self.pad_id, "pad ID")
        _require_text(self.number, "pad number", allow_empty=True)
        if type(self.kind) is not PadKind or type(self.shape) is not PadShape:
            raise KiCadInvariantError("pad kind and shape must be supported enum values")
        if type(self.position) is not PointNm:
            raise KiCadInvariantError("pad position must be PointNm")
        _require_int(self.rotation_udeg, "pad rotation", minimum=0)
        if self.rotation_udeg >= 360_000_000:
            raise KiCadInvariantError("pad rotation must be normalized below 360 degrees")
        _require_int(self.size_x_nm, "pad x size", minimum=1)
        _require_int(self.size_y_nm, "pad y size", minimum=1)
        _require_int(self.drill_x_nm, "pad x drill", minimum=0)
        _require_int(self.drill_y_nm, "pad y drill", minimum=0)
        if type(self.layers) is not tuple or not self.layers:
            raise KiCadInvariantError("pad layers must be a non-empty unique tuple")
        for layer in self.layers:
            _require_text(layer, "pad layer")
        if len(self.layers) != len(set(self.layers)):
            raise KiCadInvariantError("pad layers must be a non-empty unique tuple")
        if self.kind is PadKind.SMD and (self.drill_x_nm or self.drill_y_nm):
            raise KiCadInvariantError("SMD pads must carry a zero drill")
        if self.kind in {PadKind.THROUGH_HOLE, PadKind.NPTH} and (
            self.drill_x_nm <= 0 or self.drill_y_nm <= 0
        ):
            raise KiCadInvariantError("drilled pads require positive X/Y drill dimensions")
        if self.kind is PadKind.THROUGH_HOLE and self.layers not in {
            ("*.Cu",),
            ("*.Cu", "*.Mask"),
        }:
            raise KiCadInvariantError(
                "plated through-hole pads require ordered '*.Cu' and optional '*.Mask'"
            )
        if self.kind is PadKind.NPTH and self.layers != ("*.Cu", "*.Mask"):
            raise KiCadInvariantError("NPTH pads require ordered '*.Cu', '*.Mask' layers")
        if self.kind is PadKind.THROUGH_HOLE and (
            self.drill_x_nm >= self.size_x_nm or self.drill_y_nm >= self.size_y_nm
        ):
            raise KiCadInvariantError("plated through-hole pads require positive copper annulus")
        if self.kind is PadKind.NPTH:
            if self.number or self.net_id is not None:
                raise KiCadInvariantError("NPTH pads cannot claim a pad number or electrical net")
            if self.pin_function is not None or self.pin_type is not None:
                raise KiCadInvariantError("NPTH pads cannot claim schematic pin metadata")
            if (self.size_x_nm, self.size_y_nm) != (self.drill_x_nm, self.drill_y_nm):
                raise KiCadInvariantError(
                    "NPTH pad size must exactly equal its drill envelope (no copper annulus)"
                )
            expected_shape = (
                PadShape.CIRCLE
                if self.drill_x_nm == self.drill_y_nm
                else PadShape.OVAL
            )
            if self.shape is not expected_shape:
                raise KiCadInvariantError(
                    "NPTH pad shape must match its circular or oval drill geometry"
                )
        if self.net_id is not None:
            _require_text(self.net_id, "pad net ID")
        if self.pin_function is not None:
            _require_text(self.pin_function, "pad pin function", allow_empty=True)
        if self.pin_type is not None:
            _require_text(self.pin_type, "pad pin type", allow_empty=True)
        if self.roundrect_ratio_ppm is not None:
            _require_int(self.roundrect_ratio_ppm, "roundrect ratio", minimum=0)
            if self.shape is not PadShape.ROUNDRECT or self.roundrect_ratio_ppm > 500_000:
                raise KiCadInvariantError(
                    "roundrect ratio requires a roundrect pad and must be <= 0.5"
                )
        elif self.shape is PadShape.ROUNDRECT:
            raise KiCadInvariantError("roundrect pads require an explicit corner ratio")
        if not isinstance(self.locked, bool):
            raise KiCadInvariantError("pad locked flag must be boolean")

    @property
    def drill_shape(self) -> PadDrillShape | None:
        if self.drill_x_nm == 0:
            return None
        return (
            PadDrillShape.CIRCLE
            if self.drill_x_nm == self.drill_y_nm
            else PadDrillShape.OVAL
        )

    @property
    def drill_rotation_udeg(self) -> int:
        """Return the KiCad-local drill angle implied by the pad ``at`` angle.

        KiCad has no independent drill-angle token.  An oval drill is aligned
        with the pad axes and therefore inherits the pad rotation modulo 180
        degrees.  Circular drills use the canonical zero orientation.
        """

        return self.rotation_udeg % 180_000_000 if self.drill_shape is PadDrillShape.OVAL else 0

    @property
    def plated(self) -> bool:
        return self.kind is PadKind.THROUGH_HOLE


@dataclass(frozen=True, slots=True)
class Footprint:
    footprint_id: str
    library_id: str
    reference: str
    value: str
    layer: str
    position: PointNm
    rotation_udeg: int
    pads: tuple[Pad, ...]
    attributes: tuple[str, ...] = ()
    locked: bool = False

    def __post_init__(self) -> None:
        _require_uuid(self.footprint_id, "footprint ID")
        for value, label in (
            (self.library_id, "footprint library ID"),
            (self.reference, "footprint reference"),
            (self.value, "footprint value"),
            (self.layer, "footprint layer"),
        ):
            _require_text(value, label)
        if not isinstance(self.position, PointNm):
            raise KiCadInvariantError("footprint position must be PointNm")
        _require_int(self.rotation_udeg, "footprint rotation", minimum=0)
        if self.rotation_udeg >= 360_000_000:
            raise KiCadInvariantError("footprint rotation must be normalized below 360 degrees")
        if not isinstance(self.pads, tuple) or any(not isinstance(item, Pad) for item in self.pads):
            raise KiCadInvariantError("footprint pads must be an immutable tuple")
        pad_ids = [item.pad_id for item in self.pads]
        if len(pad_ids) != len(set(pad_ids)):
            raise KiCadInvariantError("pad IDs must be unique within a footprint")
        if len(self.attributes) != len(set(self.attributes)):
            raise KiCadInvariantError("footprint attributes must be unique")
        for attribute in self.attributes:
            _require_text(attribute, "footprint attribute")
        if not isinstance(self.locked, bool):
            raise KiCadInvariantError("footprint locked flag must be boolean")

    def normalized(self) -> "Footprint":
        return replace(
            self,
            pads=tuple(sorted(self.pads, key=lambda item: item.pad_id)),
            attributes=tuple(sorted(self.attributes)),
        )


@dataclass(frozen=True, slots=True)
class OutlineEdge:
    edge_id: str
    start: PointNm
    end: PointNm
    width_nm: int
    stroke_type: str = "default"
    locked: bool = False

    def __post_init__(self) -> None:
        _require_uuid(self.edge_id, "outline edge ID")
        if not isinstance(self.start, PointNm) or not isinstance(self.end, PointNm):
            raise KiCadInvariantError("outline edge endpoints must be PointNm")
        if self.start == self.end:
            raise KiCadInvariantError("outline edge must have non-zero length")
        _require_int(self.width_nm, "outline stroke width", minimum=0)
        _require_text(self.stroke_type, "outline stroke type")
        if not isinstance(self.locked, bool):
            raise KiCadInvariantError("outline locked flag must be boolean")

    def normalized(self) -> "OutlineEdge":
        if self.end < self.start:
            return replace(self, start=self.end, end=self.start)
        return self


@dataclass(frozen=True, slots=True)
class Segment:
    segment_id: str
    net_id: str
    layer: str
    start: PointNm
    end: PointNm
    width_nm: int
    locked: bool = False

    def __post_init__(self) -> None:
        _require_uuid(self.segment_id, "segment ID")
        _require_text(self.net_id, "segment net ID")
        _require_text(self.layer, "segment layer")
        if not isinstance(self.start, PointNm) or not isinstance(self.end, PointNm):
            raise KiCadInvariantError("segment endpoints must be PointNm")
        if self.start == self.end:
            raise KiCadInvariantError("segment must have non-zero length")
        _require_int(self.width_nm, "segment width", minimum=1)
        if not isinstance(self.locked, bool):
            raise KiCadInvariantError("segment locked flag must be boolean")

    def normalized(self) -> "Segment":
        if self.end < self.start:
            return replace(self, start=self.end, end=self.start)
        return self


class ViaKind(str, Enum):
    THROUGH = "through"
    BLIND = "blind"
    MICRO = "micro"


@dataclass(frozen=True, slots=True)
class Via:
    via_id: str
    net_id: str
    center: PointNm
    diameter_nm: int
    drill_nm: int
    layers: tuple[str, ...]
    kind: ViaKind = ViaKind.THROUGH
    locked: bool = False

    def __post_init__(self) -> None:
        _require_uuid(self.via_id, "via ID")
        _require_text(self.net_id, "via net ID")
        if not isinstance(self.center, PointNm):
            raise KiCadInvariantError("via center must be PointNm")
        _require_int(self.diameter_nm, "via diameter", minimum=1)
        _require_int(self.drill_nm, "via drill", minimum=1)
        if self.drill_nm >= self.diameter_nm:
            raise KiCadInvariantError("via drill must be smaller than via diameter")
        if len(self.layers) < 2 or len(self.layers) != len(set(self.layers)):
            raise KiCadInvariantError("via must carry a unique full layer span")
        for layer in self.layers:
            _require_text(layer, "via layer")
        if not isinstance(self.kind, ViaKind) or not isinstance(self.locked, bool):
            raise KiCadInvariantError("via kind or locked flag is invalid")


@dataclass(frozen=True, slots=True)
class Zone:
    zone_id: str
    net_id: str
    net_name: str
    layer: str
    boundary: tuple[PointNm, ...]
    clearance_nm: int
    minimum_thickness_nm: int
    hatch_style: str
    hatch_pitch_nm: int
    name: str | None = None

    def __post_init__(self) -> None:
        _require_uuid(self.zone_id, "zone ID")
        _require_text(self.net_id, "zone net ID")
        _require_text(self.net_name, "zone net name")
        _require_text(self.layer, "zone layer")
        if len(self.boundary) < 3 or any(not isinstance(item, PointNm) for item in self.boundary):
            raise KiCadInvariantError("zone boundary requires at least three integer-nm points")
        points = self.boundary[:-1] if self.boundary[0] == self.boundary[-1] else self.boundary
        if len(points) < 3 or len(points) != len(set(points)):
            raise KiCadInvariantError("zone boundary must be a non-degenerate closed ring")
        _validate_simple_polygon(points, "zone boundary")
        _require_int(self.clearance_nm, "zone clearance", minimum=0)
        _require_int(self.minimum_thickness_nm, "zone minimum thickness", minimum=1)
        _require_text(self.hatch_style, "zone hatch style")
        _require_int(self.hatch_pitch_nm, "zone hatch pitch", minimum=1)
        if self.name is not None:
            _require_text(self.name, "zone name", allow_empty=True)

    def normalized(self) -> "Zone":
        points = self.boundary[:-1] if self.boundary[0] == self.boundary[-1] else self.boundary
        rotations = tuple(points[index:] + points[:index] for index in range(len(points)))
        reverse = tuple(reversed(points))
        reverse_rotations = tuple(
            reverse[index:] + reverse[:index] for index in range(len(reverse))
        )
        return replace(self, boundary=min(rotations + reverse_rotations))


@dataclass(frozen=True, slots=True)
class Board:
    format_version: int
    generator: str
    generator_version: str | None
    layers: tuple[Layer, ...]
    nets: tuple[Net, ...]
    outline_edges: tuple[OutlineEdge, ...]
    footprints: tuple[Footprint, ...]
    segments: tuple[Segment, ...]
    vias: tuple[Via, ...]
    zones: tuple[Zone, ...]
    diagnostics: DiagnosticsManifest = DiagnosticsManifest()

    def __post_init__(self) -> None:
        _require_int(self.format_version, "KiCad format version", minimum=1)
        _require_text(self.generator, "KiCad generator")
        if self.generator_version is not None:
            _require_text(self.generator_version, "KiCad generator version")
        collections: tuple[tuple[str, object, type[object]], ...] = (
            ("layers", self.layers, Layer),
            ("nets", self.nets, Net),
            ("outline edges", self.outline_edges, OutlineEdge),
            ("footprints", self.footprints, Footprint),
            ("segments", self.segments, Segment),
            ("vias", self.vias, Via),
            ("zones", self.zones, Zone),
        )
        for label, values, item_type in collections:
            if not isinstance(values, tuple) or any(
                not isinstance(item, item_type) for item in values
            ):
                raise KiCadInvariantError(
                    f"{label} must be an immutable tuple of {item_type.__name__}"
                )
        if not isinstance(self.diagnostics, DiagnosticsManifest):
            raise KiCadInvariantError("board diagnostics must be a DiagnosticsManifest")
        validate_board(self)

    def normalized(self) -> "Board":
        return replace(
            self,
            layers=tuple(sorted(self.layers, key=lambda item: (item.ordinal, item.name))),
            nets=tuple(sorted(self.nets, key=lambda item: item.net_id)),
            outline_edges=tuple(
                sorted(
                    (item.normalized() for item in self.outline_edges),
                    key=lambda item: item.edge_id,
                )
            ),
            footprints=tuple(
                sorted(
                    (item.normalized() for item in self.footprints),
                    key=lambda item: item.footprint_id,
                )
            ),
            segments=tuple(
                sorted(
                    (item.normalized() for item in self.segments),
                    key=lambda item: item.segment_id,
                )
            ),
            vias=tuple(sorted(self.vias, key=lambda item: item.via_id)),
            zones=tuple(
                sorted((item.normalized() for item in self.zones), key=lambda item: item.zone_id)
            ),
            diagnostics=self.diagnostics.normalized(),
        )

    @property
    def normalized_ir_sha256(self) -> str:
        normalized = self.normalized()
        validate_board(normalized)
        # Opaque constructs are bound independently by diagnostics_manifest_sha256.
        # Keeping them out of the supported IR digest makes the parity assertion
        # state exactly what it proves instead of conflating syntax preservation
        # with modeled electrical/geometry parity.
        supported = replace(normalized, diagnostics=DiagnosticsManifest())
        return _stable_hash(supported, domain="flux-clone-kicad-board-ir-v1")

    @property
    def outline_vertices(self) -> tuple[PointNm, ...]:
        return ordered_outline_vertices(self.outline_edges)


def ordered_outline_vertices(edges: tuple[OutlineEdge, ...]) -> tuple[PointNm, ...]:
    """Return the one normalized closed Edge.Cuts ring, or fail closed."""

    if not edges:
        raise KiCadInvariantError("board requires a closed Edge.Cuts outline")
    adjacency: dict[PointNm, list[PointNm]] = {}
    for edge in edges:
        adjacency.setdefault(edge.start, []).append(edge.end)
        adjacency.setdefault(edge.end, []).append(edge.start)
    if any(len(neighbours) != 2 for neighbours in adjacency.values()):
        raise KiCadInvariantError("Edge.Cuts must form one unbranched closed ring")
    start = min(adjacency)

    def walk(first_next: PointNm) -> tuple[PointNm, ...]:
        result = [start]
        previous = start
        current = first_next
        while current != start:
            if current in result or len(result) > len(edges):
                raise KiCadInvariantError("Edge.Cuts contains a disconnected or repeated cycle")
            result.append(current)
            next_candidates = [item for item in adjacency[current] if item != previous]
            if len(next_candidates) != 1:
                raise KiCadInvariantError("Edge.Cuts traversal is ambiguous")
            previous, current = current, next_candidates[0]
        if len(result) != len(edges):
            raise KiCadInvariantError("Edge.Cuts contains more than one closed ring")
        return tuple(result)

    candidates = tuple(walk(item) for item in sorted(adjacency[start]))
    result = min(candidates)
    _validate_simple_polygon(result, "Edge.Cuts outline")
    return result


def _diagnostic_occurrence(path: str) -> int:
    match = re.fullmatch(r"[^\[\]]+\[([0-9]+)\]", path)
    if match is None:
        raise KiCadInvariantError("diagnostic path must end in a numeric occurrence")
    return int(match.group(1))


def _orientation(a: PointNm, b: PointNm, c: PointNm) -> int:
    cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    return (cross > 0) - (cross < 0)


def _point_on_segment(point: PointNm, start: PointNm, end: PointNm) -> bool:
    return (
        _orientation(start, end, point) == 0
        and min(start.x, end.x) <= point.x <= max(start.x, end.x)
        and min(start.y, end.y) <= point.y <= max(start.y, end.y)
    )


def _segments_intersect(a: PointNm, b: PointNm, c: PointNm, d: PointNm) -> bool:
    first = _orientation(a, b, c)
    second = _orientation(a, b, d)
    third = _orientation(c, d, a)
    fourth = _orientation(c, d, b)
    if first * second < 0 and third * fourth < 0:
        return True
    return (
        (first == 0 and _point_on_segment(c, a, b))
        or (second == 0 and _point_on_segment(d, a, b))
        or (third == 0 and _point_on_segment(a, c, d))
        or (fourth == 0 and _point_on_segment(b, c, d))
    )


def _validate_simple_polygon(points: tuple[PointNm, ...], label: str) -> None:
    if len(points) < 3 or len(points) != len(set(points)):
        raise KiCadInvariantError(f"{label} requires at least three unique vertices")
    twice_area = sum(
        first.x * second.y - second.x * first.y
        for first, second in zip(points, points[1:] + points[:1], strict=True)
    )
    if twice_area == 0:
        raise KiCadInvariantError(f"{label} must enclose non-zero area")
    segments = tuple(zip(points, points[1:] + points[:1], strict=True))
    for first_index, (a, b) in enumerate(segments):
        for second_index in range(first_index + 1, len(segments)):
            if second_index in {
                first_index,
                (first_index + 1) % len(segments),
            } or first_index == (second_index + 1) % len(segments):
                continue
            c, d = segments[second_index]
            if _segments_intersect(a, b, c, d):
                raise KiCadInvariantError(f"{label} must not self-intersect")


def validate_board(board: Board) -> None:
    layer_names = [item.name for item in board.layers]
    layer_ordinals = [item.ordinal for item in board.layers]
    if not layer_names or len(layer_names) != len(set(layer_names)):
        raise KiCadInvariantError("board layer names must be non-empty and unique")
    if len(layer_ordinals) != len(set(layer_ordinals)):
        raise KiCadInvariantError("board layer ordinals must be unique")
    copper_layers = {
        item.name
        for item in board.layers
        if item.kind in {"signal", "power", "mixed", "jumper"}
    }
    if not copper_layers:
        raise KiCadInvariantError("board requires at least one copper layer")
    if "Edge.Cuts" not in set(layer_names):
        raise KiCadInvariantError("board layer table must contain Edge.Cuts")
    ordered_outline_vertices(board.outline_edges)

    net_ids = [item.net_id for item in board.nets]
    net_names = [item.name for item in board.nets]
    if len(net_ids) != len(set(net_ids)) or len(net_names) != len(set(net_names)):
        raise KiCadInvariantError("canonical net IDs and names must be unique")
    known_nets = set(net_ids)
    known_layers = set(layer_names)

    entity_ids: list[str] = []
    references: list[str] = []
    for footprint in board.footprints:
        entity_ids.append(footprint.footprint_id)
        references.append(footprint.reference)
        if footprint.layer not in known_layers:
            raise KiCadInvariantError("footprint references an unknown board layer")
        for pad in footprint.pads:
            entity_ids.append(pad.pad_id)
            if pad.net_id is not None and pad.net_id not in known_nets:
                raise KiCadInvariantError("pad references an unknown canonical net")
            for layer in pad.layers:
                if not (layer.startswith("*.") or layer in known_layers):
                    raise KiCadInvariantError("pad references an unknown board layer")
    if len(references) != len(set(references)):
        raise KiCadInvariantError("footprint references must be unique")

    for segment in board.segments:
        entity_ids.append(segment.segment_id)
        if segment.net_id not in known_nets or segment.layer not in copper_layers:
            raise KiCadInvariantError("segment references an unknown net or copper layer")
    for via in board.vias:
        entity_ids.append(via.via_id)
        if via.net_id not in known_nets or any(layer not in copper_layers for layer in via.layers):
            raise KiCadInvariantError("via references an unknown net or copper layer span")
    for zone in board.zones:
        entity_ids.append(zone.zone_id)
        if (
            zone.net_id not in known_nets
            or zone.layer not in copper_layers
            or next(item.name for item in board.nets if item.net_id == zone.net_id) != zone.net_name
        ):
            raise KiCadInvariantError("zone references an unknown or inconsistent net/layer")
    entity_ids.extend(item.edge_id for item in board.outline_edges)
    if len(entity_ids) != len(set(entity_ids)):
        raise KiCadInvariantError("all KiCad entity UUIDs must be globally unique")


@dataclass(frozen=True, slots=True)
class ImportEvidence:
    source_sha256: str
    normalized_ir_sha256: str
    diagnostics_manifest_sha256: str
    parser_id: str
    kicad_execution: str = "not-run"

    def __post_init__(self) -> None:
        _validate_evidence_hashes(
            self.source_sha256,
            self.normalized_ir_sha256,
            self.diagnostics_manifest_sha256,
        )
        _require_text(self.parser_id, "parser ID")
        if self.kicad_execution != "not-run":
            raise KiCadInvariantError("file codec evidence cannot claim KiCad execution")


@dataclass(frozen=True, slots=True)
class ExportEvidence:
    normalized_ir_sha256: str
    exported_sha256: str
    diagnostics_manifest_sha256: str
    writer_id: str
    preserved_unsupported: bool
    kicad_execution: str = "not-run"

    def __post_init__(self) -> None:
        _validate_evidence_hashes(
            self.normalized_ir_sha256,
            self.exported_sha256,
            self.diagnostics_manifest_sha256,
        )
        _require_text(self.writer_id, "writer ID")
        if not isinstance(self.preserved_unsupported, bool):
            raise KiCadInvariantError("preserved_unsupported must be boolean")
        if self.kicad_execution != "not-run":
            raise KiCadInvariantError("file codec evidence cannot claim KiCad execution")


@dataclass(frozen=True, slots=True)
class RoundTripEvidence:
    source_sha256: str
    imported_ir_sha256: str
    exported_sha256: str
    reparsed_ir_sha256: str
    imported_manifest_sha256: str
    reparsed_manifest_sha256: str
    semantic_parity: bool
    diagnostics_parity: bool
    kicad_execution: str = "not-run"

    def __post_init__(self) -> None:
        _validate_evidence_hashes(
            self.source_sha256,
            self.imported_ir_sha256,
            self.exported_sha256,
            self.reparsed_ir_sha256,
            self.imported_manifest_sha256,
            self.reparsed_manifest_sha256,
        )
        if not isinstance(self.semantic_parity, bool) or not isinstance(
            self.diagnostics_parity, bool
        ):
            raise KiCadInvariantError("round-trip parity flags must be boolean")
        if self.kicad_execution != "not-run":
            raise KiCadInvariantError("file codec evidence cannot claim KiCad execution")

    @property
    def evidence_sha256(self) -> str:
        return _stable_hash(self, domain="flux-clone-kicad-round-trip-evidence-v1")


def _validate_evidence_hashes(*values: str) -> None:
    if any(not isinstance(value, str) or _SHA256.fullmatch(value) is None for value in values):
        raise KiCadInvariantError("evidence digests must be lowercase SHA-256")

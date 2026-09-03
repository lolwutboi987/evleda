"""Immutable design-graph, command, transaction, and revision models."""

from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass, fields, is_dataclass, replace
from enum import Enum
from typing import Any, Mapping


class InvariantViolation(ValueError):
    """The canonical graph or a command would violate a hard invariant."""


_INT64_MIN = -(1 << 63)
_INT64_MAX = (1 << 63) - 1


def _require_utf8(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise InvariantViolation(f"{label} must be a string")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise InvariantViolation(f"{label} must contain valid Unicode") from exc
    return value


def _require_text(value: object, label: str) -> str:
    text = _require_utf8(value, label)
    if not text.strip() or any(
        unicodedata.category(character).startswith("C") for character in text
    ):
        raise InvariantViolation(f"{label} must be non-empty text without control characters")
    return text


def _require_bool(value: object, label: str) -> None:
    if not isinstance(value, bool):
        raise InvariantViolation(f"{label} must be a boolean")


def _require_int64(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvariantViolation(f"{label} must be an integer")
    if not _INT64_MIN <= value <= _INT64_MAX:
        raise InvariantViolation(f"{label} must fit in a signed 64-bit integer")
    return value


def canonical_data(value: Any) -> Any:
    """Convert typed values to the one accepted deterministic JSON shape."""

    if isinstance(value, Enum):
        return canonical_data(value.value)
    if value is None or isinstance(value, (str, int, bool)):
        if isinstance(value, str):
            _require_utf8(value, "canonical string")
        return value
    if isinstance(value, float):
        raise InvariantViolation("floating-point values are forbidden in canonical ECAD data")
    if is_dataclass(value) and not isinstance(value, type):
        return {field.name: canonical_data(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, Mapping):
        keys = tuple(value.keys())
        if any(not isinstance(key, str) for key in keys):
            raise InvariantViolation("canonical object keys must be strings")
        return {key: canonical_data(value[key]) for key in sorted(keys)}
    if isinstance(value, (tuple, list)):
        return [canonical_data(item) for item in value]
    if isinstance(value, (set, frozenset)):
        raise InvariantViolation("sets are not canonical; sort them into a tuple first")
    raise InvariantViolation(f"unsupported canonical type: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(
        canonical_data(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def stable_hash(value: Any, *, domain: str) -> str:
    if not isinstance(domain, str) or not domain or "\x00" in domain:
        raise InvariantViolation("hash domain must be a non-empty NUL-free string")
    _require_utf8(domain, "hash domain")
    body = domain.encode("utf-8") + b"\x00" + canonical_json(value).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _require_id(value: object, label: str) -> None:
    text = _require_utf8(value, label)
    if (
        not text
        or text != text.strip()
        or any(character.isspace() for character in text)
        or any(unicodedata.category(character).startswith("C") for character in text)
        or unicodedata.normalize("NFC", text) != text
    ):
        raise InvariantViolation(
            f"{label} must be a non-empty NFC, whitespace-free identifier "
            "without control characters"
        )


def _require_sha256(value: object, label: str) -> None:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise InvariantViolation(f"{label} must be a lowercase SHA-256 digest")


@dataclass(frozen=True, slots=True, order=True)
class PointNm:
    x: int
    y: int

    def __post_init__(self) -> None:
        _require_int64(self.x, "x coordinate in nanometres")
        _require_int64(self.y, "y coordinate in nanometres")


def _open_ring(vertices: tuple[PointNm, ...]) -> tuple[PointNm, ...]:
    if len(vertices) > 1 and vertices[0] == vertices[-1]:
        return vertices[:-1]
    return vertices


def _normalized_ring(vertices: tuple[PointNm, ...]) -> tuple[PointNm, ...]:
    vertices = _open_ring(vertices)
    if not vertices:
        return ()
    rotations = tuple(vertices[index:] + vertices[:index] for index in range(len(vertices)))
    reversed_vertices = tuple(reversed(vertices))
    reverse_rotations = tuple(
        reversed_vertices[index:] + reversed_vertices[:index]
        for index in range(len(reversed_vertices))
    )
    return min(rotations + reverse_rotations)


def _cross(a: PointNm, b: PointNm, c: PointNm) -> int:
    """Return the exact signed cross product of AB and AC."""

    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)


def _point_on_segment(point: PointNm, start: PointNm, end: PointNm) -> bool:
    return (
        _cross(start, end, point) == 0
        and min(start.x, end.x) <= point.x <= max(start.x, end.x)
        and min(start.y, end.y) <= point.y <= max(start.y, end.y)
    )


def _segments_intersect(a: PointNm, b: PointNm, c: PointNm, d: PointNm) -> bool:
    ab_c = _cross(a, b, c)
    ab_d = _cross(a, b, d)
    cd_a = _cross(c, d, a)
    cd_b = _cross(c, d, b)
    if ab_c == 0 and _point_on_segment(c, a, b):
        return True
    if ab_d == 0 and _point_on_segment(d, a, b):
        return True
    if cd_a == 0 and _point_on_segment(a, c, d):
        return True
    if cd_b == 0 and _point_on_segment(b, c, d):
        return True
    return (ab_c < 0 < ab_d or ab_d < 0 < ab_c) and (cd_a < 0 < cd_b or cd_b < 0 < cd_a)


def _collinear_overlap_has_length(a: PointNm, b: PointNm, c: PointNm, d: PointNm) -> bool:
    if _cross(a, b, c) != 0 or _cross(a, b, d) != 0:
        return False
    if a.x != b.x:
        return max(min(a.x, b.x), min(c.x, d.x)) < min(max(a.x, b.x), max(c.x, d.x))
    return max(min(a.y, b.y), min(c.y, d.y)) < min(max(a.y, b.y), max(c.y, d.y))


def _validate_simple_polygon(vertices: tuple[PointNm, ...], label: str) -> None:
    ring = _open_ring(vertices)
    if len(ring) < 3:
        raise InvariantViolation(f"{label} requires at least three vertices")
    if len(ring) != len(set(ring)):
        raise InvariantViolation(
            f"{label} vertices must be unique except for an optional closing vertex"
        )
    twice_area = sum(
        start.x * end.y - end.x * start.y
        for start, end in zip(ring, ring[1:] + ring[:1], strict=True)
    )
    if twice_area == 0:
        raise InvariantViolation(f"{label} must enclose non-zero area")
    edges = tuple(zip(ring, ring[1:] + ring[:1], strict=True))
    for first_index, (a, b) in enumerate(edges):
        if a == b:
            raise InvariantViolation(f"{label} cannot contain zero-length edges")
        for second_index in range(first_index + 1, len(edges)):
            if second_index == first_index + 1 or (
                first_index == 0 and second_index == len(edges) - 1
            ):
                continue
            c, d = edges[second_index]
            if _segments_intersect(a, b, c, d):
                raise InvariantViolation(f"{label} must be a simple non-self-intersecting polygon")


@dataclass(frozen=True, slots=True, order=True)
class PinRef:
    component_id: str
    pin_number: str

    def __post_init__(self) -> None:
        _require_id(self.component_id, "pin component ID")
        _require_id(self.pin_number, "pin number")


@dataclass(frozen=True, slots=True)
class PinDefinition:
    number: str
    name: str
    electrical_type: str
    pad_number: str
    required: bool = True

    def __post_init__(self) -> None:
        _require_id(self.number, "pin number")
        _require_id(self.pad_number, "pad number")
        _require_text(self.name, "pin name")
        _require_id(self.electrical_type, "pin electrical type")
        _require_bool(self.required, "pin required flag")


@dataclass(frozen=True, slots=True)
class Component:
    component_id: str
    reference: str
    value: str
    manufacturer_part_number: str
    package: str
    symbol_id: str
    footprint_id: str
    datasheet_sha256: str
    pin_map_sha256: str
    pins: tuple[PinDefinition, ...]

    def __post_init__(self) -> None:
        _require_id(self.component_id, "component ID")
        _require_id(self.reference, "reference")
        _require_text(self.value, "component value")
        _require_text(self.manufacturer_part_number, "exact manufacturer part number")
        _require_text(self.package, "component package")
        _require_text(self.symbol_id, "component symbol ID")
        _require_text(self.footprint_id, "component footprint ID")
        _require_sha256(self.datasheet_sha256, "datasheet_sha256")
        _require_sha256(self.pin_map_sha256, "pin_map_sha256")
        if not isinstance(self.pins, tuple) or any(
            not isinstance(pin, PinDefinition) for pin in self.pins
        ):
            raise InvariantViolation("component pins must be an immutable tuple of PinDefinition")
        if not self.pins:
            raise InvariantViolation("components require at least one pin")
        numbers = [pin.number for pin in self.pins]
        pads = [pin.pad_number for pin in self.pins]
        if len(numbers) != len(set(numbers)) or len(pads) != len(set(pads)):
            raise InvariantViolation("component pin and pad numbers must be unique")

    def normalized(self) -> "Component":
        return replace(self, pins=tuple(sorted(self.pins, key=lambda pin: pin.number)))


@dataclass(frozen=True, slots=True)
class Net:
    net_id: str
    name: str
    members: tuple[PinRef, ...] = ()

    def __post_init__(self) -> None:
        _require_id(self.net_id, "net ID")
        _require_text(self.name, "net name")
        if not isinstance(self.members, tuple) or any(
            not isinstance(member, PinRef) for member in self.members
        ):
            raise InvariantViolation("net members must be an immutable tuple of PinRef")
        if len(self.members) != len(set(self.members)):
            raise InvariantViolation("net members must be unique")

    def normalized(self) -> "Net":
        return replace(self, members=tuple(sorted(self.members)))


@dataclass(frozen=True, slots=True)
class FootprintPlacement:
    component_id: str
    position: PointNm
    rotation_udeg: int = 0
    side: str = "front"
    locked: bool = False

    def __post_init__(self) -> None:
        _require_id(self.component_id, "placement component ID")
        if not isinstance(self.position, PointNm):
            raise InvariantViolation("placement position must be PointNm")
        if self.side not in {"front", "back"}:
            raise InvariantViolation("placement side must be front or back")
        _require_int64(self.rotation_udeg, "rotation in integer microdegrees")
        if not 0 <= self.rotation_udeg < 360_000_000:
            raise InvariantViolation("rotation must be normalized to [0, 360°)")
        _require_bool(self.locked, "placement locked flag")


_PAD_SHAPES = frozenset({"circle", "oval", "rect", "roundrect"})


@dataclass(frozen=True, slots=True)
class FootprintPad:
    """Exact physical copper geometry for one component pad.

    ``center`` is expressed in board coordinates. ``pad_drill_nm`` is retained
    as the legacy minor drill dimension so older circular-pad callers remain
    source compatible.  ``drill_x_nm``, ``drill_y_nm``, and
    ``drill_rotation_udeg`` are the authoritative physical drill geometry.  A
    circular drill has equal X/Y dimensions and canonical zero rotation; an
    oval/slot has distinct dimensions and a canonical rotation in ``[0, 180°)``.
    Integer nanometres and integer microdegrees are the only accepted geometry
    units at this canonical boundary.
    """

    pad_id: str
    component_id: str
    pad_number: str
    center: PointNm
    size_x_nm: int
    size_y_nm: int
    shape: str
    rotation_udeg: int
    layers: tuple[str, ...]
    pad_drill_nm: int = 0
    net_id: str | None = None
    locked: bool = False
    drill_x_nm: int = 0
    drill_y_nm: int = 0
    drill_rotation_udeg: int = 0
    shared_land_group_id: str | None = None

    def __post_init__(self) -> None:
        if type(self) is not FootprintPad:
            raise InvariantViolation("footprint pad must be the exact concrete type")
        _require_id(self.pad_id, "pad ID")
        _require_id(self.component_id, "pad component ID")
        _require_id(self.pad_number, "pad number")
        if type(self.center) is not PointNm:
            raise InvariantViolation("pad center must be PointNm")
        _require_int64(self.size_x_nm, "pad X size in nanometres")
        _require_int64(self.size_y_nm, "pad Y size in nanometres")
        if self.size_x_nm <= 0 or self.size_y_nm <= 0:
            raise InvariantViolation("pad dimensions must be positive")
        if self.shape not in _PAD_SHAPES:
            raise InvariantViolation(f"pad shape must be one of {', '.join(sorted(_PAD_SHAPES))}")
        _require_int64(self.rotation_udeg, "pad rotation in integer microdegrees")
        if not 0 <= self.rotation_udeg < 360_000_000:
            raise InvariantViolation("pad rotation must be normalized to [0, 360°)")
        if not isinstance(self.layers, tuple) or not self.layers:
            raise InvariantViolation("pad layers must be a non-empty immutable tuple")
        for layer in self.layers:
            _require_text(layer, "pad copper layer")
        if len(self.layers) != len(set(self.layers)):
            raise InvariantViolation("pad copper layers must be unique")
        _require_int64(self.pad_drill_nm, "pad drill diameter in nanometres")
        _require_int64(self.drill_x_nm, "pad drill X size in nanometres")
        _require_int64(self.drill_y_nm, "pad drill Y size in nanometres")
        _require_int64(
            self.drill_rotation_udeg,
            "pad drill rotation in integer microdegrees",
        )
        if self.pad_drill_nm < 0 or self.drill_x_nm < 0 or self.drill_y_nm < 0:
            raise InvariantViolation("pad drill dimensions cannot be negative")
        drill_x_nm = self.drill_x_nm
        drill_y_nm = self.drill_y_nm
        if drill_x_nm == 0 and drill_y_nm == 0 and self.pad_drill_nm > 0:
            drill_x_nm = self.pad_drill_nm
            drill_y_nm = self.pad_drill_nm
            object.__setattr__(self, "drill_x_nm", drill_x_nm)
            object.__setattr__(self, "drill_y_nm", drill_y_nm)
        if (drill_x_nm == 0) != (drill_y_nm == 0):
            raise InvariantViolation("pad drill X/Y dimensions must both be zero or positive")
        if drill_x_nm > 0:
            minor_dimension = min(drill_x_nm, drill_y_nm)
            if self.pad_drill_nm == 0:
                object.__setattr__(self, "pad_drill_nm", minor_dimension)
            elif self.pad_drill_nm != minor_dimension:
                raise InvariantViolation(
                    "legacy pad drill diameter must equal the exact drill minor dimension"
                )
            if drill_x_nm >= self.size_x_nm or drill_y_nm >= self.size_y_nm:
                raise InvariantViolation("a drilled pad requires positive copper annulus")
        elif self.pad_drill_nm != 0:
            raise InvariantViolation("a legacy pad drill requires exact X/Y geometry")
        if not 0 <= self.drill_rotation_udeg < 360_000_000:
            raise InvariantViolation("pad drill rotation must be normalized to [0, 360°)")
        if drill_x_nm == drill_y_nm and self.drill_rotation_udeg not in {0, 180_000_000}:
            raise InvariantViolation("a circular pad drill cannot carry an oriented rotation")
        if drill_x_nm > 0 and len(self.layers) < 2:
            raise InvariantViolation("a drilled pad must span at least two copper layers")
        if self.net_id is not None:
            _require_id(self.net_id, "pad net ID")
        if self.shared_land_group_id is not None:
            _require_id(self.shared_land_group_id, "shared land group ID")
        _require_bool(self.locked, "pad locked flag")

    def normalized(self) -> "FootprintPad":
        drill_rotation_udeg = (
            0 if self.drill_x_nm == self.drill_y_nm else self.drill_rotation_udeg % 180_000_000
        )
        return replace(
            self,
            layers=tuple(sorted(self.layers)),
            drill_rotation_udeg=drill_rotation_udeg,
        )

    @property
    def drill_is_slot(self) -> bool:
        return self.drill_x_nm > 0 and self.drill_x_nm != self.drill_y_nm


@dataclass(frozen=True, slots=True)
class FootprintHole:
    """An exact circular or oval/slot footprint hole.

    ``diameter_nm`` is the legacy minor-dimension alias.  New callers retain
    exact X/Y drill dimensions and absolute board rotation through the
    ``drill_*`` fields.  Plated holes bind one exact physical ``pad_id``;
    non-plated mechanical holes deliberately cannot claim a copper binding.
    """

    hole_id: str
    component_id: str
    center: PointNm
    diameter_nm: int
    plated: bool = False
    pad_id: str | None = None
    locked: bool = False
    drill_x_nm: int = 0
    drill_y_nm: int = 0
    drill_rotation_udeg: int = 0

    def __post_init__(self) -> None:
        if type(self) is not FootprintHole:
            raise InvariantViolation("footprint hole must be the exact concrete type")
        _require_id(self.hole_id, "hole ID")
        _require_id(self.component_id, "hole component ID")
        if type(self.center) is not PointNm:
            raise InvariantViolation("hole center must be PointNm")
        _require_int64(self.diameter_nm, "hole diameter in nanometres")
        _require_int64(self.drill_x_nm, "hole drill X size in nanometres")
        _require_int64(self.drill_y_nm, "hole drill Y size in nanometres")
        _require_int64(
            self.drill_rotation_udeg,
            "hole drill rotation in integer microdegrees",
        )
        if self.diameter_nm <= 0:
            raise InvariantViolation("hole minor dimension must be positive")
        drill_x_nm = self.drill_x_nm
        drill_y_nm = self.drill_y_nm
        if drill_x_nm == 0 and drill_y_nm == 0:
            drill_x_nm = self.diameter_nm
            drill_y_nm = self.diameter_nm
            object.__setattr__(self, "drill_x_nm", drill_x_nm)
            object.__setattr__(self, "drill_y_nm", drill_y_nm)
        if drill_x_nm <= 0 or drill_y_nm <= 0:
            raise InvariantViolation("hole drill X/Y dimensions must both be positive")
        if self.diameter_nm != min(drill_x_nm, drill_y_nm):
            raise InvariantViolation(
                "legacy hole diameter must equal the exact drill minor dimension"
            )
        if not 0 <= self.drill_rotation_udeg < 360_000_000:
            raise InvariantViolation("hole drill rotation must be normalized to [0, 360°)")
        if drill_x_nm == drill_y_nm and self.drill_rotation_udeg not in {0, 180_000_000}:
            raise InvariantViolation("a circular hole cannot carry an oriented rotation")
        _require_bool(self.plated, "hole plated flag")
        if self.pad_id is not None:
            _require_id(self.pad_id, "hole pad ID")
        if self.plated != (self.pad_id is not None):
            raise InvariantViolation(
                "a plated hole must identify its pad; an unplated hole must not"
            )
        _require_bool(self.locked, "hole locked flag")

    def normalized(self) -> "FootprintHole":
        drill_rotation_udeg = (
            0 if self.drill_x_nm == self.drill_y_nm else self.drill_rotation_udeg % 180_000_000
        )
        return replace(self, drill_rotation_udeg=drill_rotation_udeg)

    @property
    def drill_is_slot(self) -> bool:
        return self.drill_x_nm != self.drill_y_nm


@dataclass(frozen=True, slots=True)
class Via:
    via_id: str
    net_id: str
    center: PointNm
    diameter_nm: int
    drill_nm: int
    layers: tuple[str, ...]
    locked: bool = False

    def __post_init__(self) -> None:
        _require_id(self.via_id, "via ID")
        _require_id(self.net_id, "via net ID")
        if not isinstance(self.center, PointNm):
            raise InvariantViolation("via center must be PointNm")
        _require_int64(self.diameter_nm, "via diameter in nanometres")
        _require_int64(self.drill_nm, "via drill diameter in nanometres")
        if self.drill_nm <= 0 or self.diameter_nm <= self.drill_nm:
            raise InvariantViolation("via drill must be positive and smaller than its diameter")
        if not isinstance(self.layers, tuple) or len(self.layers) < 2:
            raise InvariantViolation("via layer span must contain at least two copper layers")
        for layer in self.layers:
            _require_text(layer, "via copper layer")
        if len(self.layers) != len(set(self.layers)):
            raise InvariantViolation("via copper layers must be unique")
        _require_bool(self.locked, "via locked flag")

    def normalized(self) -> "Via":
        return replace(self, layers=tuple(sorted(self.layers)))


class ZoneFillState(str, Enum):
    """Whether a zone is only an intent or source-verified filled copper."""

    UNFILLED_INTENT = "unfilled-intent"
    VERIFIED_FILLED = "verified-filled"


@dataclass(frozen=True, slots=True)
class ZoneFillEvidence:
    """Deterministic provenance for one externally verified zone fill.

    The evidence binds the source graph/revision, the exact filled geometry,
    and the identity of the fill engine.  Merely selecting VERIFIED_FILLED is
    therefore never sufficient to create authoritative copper.
    """

    source_graph_hash: str
    source_revision: str
    fill_engine_id: str
    fill_engine_revision: str
    filled_geometry_hash: str
    evidence_hash: str

    def __post_init__(self) -> None:
        if type(self) is not ZoneFillEvidence:
            raise InvariantViolation("zone fill evidence must be exact ZoneFillEvidence")
        _require_sha256(self.source_graph_hash, "zone fill source graph hash")
        _require_sha256(self.source_revision, "zone fill source revision")
        _require_id(self.fill_engine_id, "zone fill engine ID")
        _require_id(self.fill_engine_revision, "zone fill engine revision")
        _require_sha256(self.filled_geometry_hash, "zone filled geometry hash")
        _require_sha256(self.evidence_hash, "zone fill evidence hash")
        expected = stable_hash(
            {
                "source_graph_hash": self.source_graph_hash,
                "source_revision": self.source_revision,
                "fill_engine_id": self.fill_engine_id,
                "fill_engine_revision": self.fill_engine_revision,
                "filled_geometry_hash": self.filled_geometry_hash,
            },
            domain="pcb-zone-fill-evidence-v1",
        )
        if self.evidence_hash != expected:
            raise InvariantViolation("zone fill evidence hash does not bind its provenance")


@dataclass(frozen=True, slots=True)
class CopperZone:
    zone_id: str
    net_id: str
    layer: str
    outline: tuple[PointNm, ...]
    clearance_nm: int
    min_thickness_nm: int = 100_000
    priority: int = 0
    locked: bool = False
    fill_state: ZoneFillState = ZoneFillState.UNFILLED_INTENT
    fill_evidence: ZoneFillEvidence | None = None

    def __post_init__(self) -> None:
        if type(self) is not CopperZone:
            raise InvariantViolation("copper zone must be exact CopperZone")
        _require_id(self.zone_id, "zone ID")
        _require_id(self.net_id, "zone net ID")
        _require_text(self.layer, "zone copper layer")
        if not isinstance(self.outline, tuple) or any(
            not isinstance(vertex, PointNm) for vertex in self.outline
        ):
            raise InvariantViolation("zone outline must be an immutable tuple of PointNm")
        _validate_simple_polygon(self.outline, "zone outline")
        _require_int64(self.clearance_nm, "zone clearance in nanometres")
        if self.clearance_nm < 0:
            raise InvariantViolation("zone clearance cannot be negative")
        _require_int64(self.min_thickness_nm, "zone minimum thickness in nanometres")
        if self.min_thickness_nm <= 0:
            raise InvariantViolation("zone minimum thickness must be positive")
        _require_int64(self.priority, "zone priority")
        if self.priority < 0:
            raise InvariantViolation("zone priority cannot be negative")
        _require_bool(self.locked, "zone locked flag")
        if type(self.fill_state) is not ZoneFillState:
            raise InvariantViolation("zone fill state must be exact ZoneFillState")
        if self.fill_state is ZoneFillState.UNFILLED_INTENT:
            if self.fill_evidence is not None:
                raise InvariantViolation("unfilled zone intent cannot carry fill evidence")
        elif self.fill_state is ZoneFillState.VERIFIED_FILLED:
            if type(self.fill_evidence) is not ZoneFillEvidence:
                raise InvariantViolation(
                    "verified filled zone requires exact source-bound fill evidence"
                )
            if self.fill_evidence.filled_geometry_hash != zone_filled_geometry_hash(self):
                raise InvariantViolation(
                    "zone fill evidence does not bind the exact modeled filled geometry"
                )

    def normalized(self) -> "CopperZone":
        return replace(self, outline=_normalized_ring(self.outline))


def zone_filled_geometry_hash(zone: CopperZone) -> str:
    """Hash the exact simple-polygon copper represented by a verified fill."""

    if type(zone) is not CopperZone:
        raise InvariantViolation("filled geometry subject must be exact CopperZone")
    return stable_hash(
        {
            "zone_id": zone.zone_id,
            "net_id": zone.net_id,
            "layer": zone.layer,
            "outline": {"vertices": _normalized_ring(zone.outline)},
            "clearance_nm": zone.clearance_nm,
        },
        domain="pcb-zone-filled-geometry-v1",
    )


def bind_verified_zone_fill(
    zone: CopperZone,
    *,
    source_graph: DesignGraph,
    source_revision: str,
    fill_engine_id: str,
    fill_engine_revision: str,
) -> CopperZone:
    """Bind a trusted fill-engine result to an existing unfilled zone intent.

    Product command payloads cannot invoke this function or set fill state.
    The future KiCad worker boundary must call it only after independently
    verifying that the returned filled polygon equals this modeled geometry.
    """

    if type(zone) is not CopperZone or zone.fill_state is not ZoneFillState.UNFILLED_INTENT:
        raise InvariantViolation("only an exact unfilled zone intent can receive fill evidence")
    if zone.fill_evidence is not None:
        raise InvariantViolation("zone intent already carries unexpected fill evidence")
    if type(source_graph) is not DesignGraph:
        raise InvariantViolation("zone fill source graph must be exact DesignGraph")
    normalized_source = source_graph.normalized()
    validate_graph(normalized_source)
    if normalized_source != source_graph:
        raise InvariantViolation("zone fill source graph must be normalized")
    matching_zones = tuple(item for item in source_graph.zones if item.zone_id == zone.zone_id)
    if len(matching_zones) != 1 or matching_zones[0] != zone:
        raise InvariantViolation("zone fill evidence subject must exactly match its source graph")
    source_graph_hash = source_graph.graph_hash
    geometry_hash = zone_filled_geometry_hash(zone)
    evidence_payload = {
        "source_graph_hash": source_graph_hash,
        "source_revision": source_revision,
        "fill_engine_id": fill_engine_id,
        "fill_engine_revision": fill_engine_revision,
        "filled_geometry_hash": geometry_hash,
    }
    evidence = ZoneFillEvidence(
        source_graph_hash=source_graph_hash,
        source_revision=source_revision,
        fill_engine_id=fill_engine_id,
        fill_engine_revision=fill_engine_revision,
        filled_geometry_hash=geometry_hash,
        evidence_hash=stable_hash(
            evidence_payload,
            domain="pcb-zone-fill-evidence-v1",
        ),
    )
    return replace(
        zone,
        fill_state=ZoneFillState.VERIFIED_FILLED,
        fill_evidence=evidence,
    )


@dataclass(frozen=True, slots=True)
class SchematicWire:
    wire_id: str
    net_id: str
    vertices: tuple[PointNm, ...]
    sheet_id: str = "root"
    locked: bool = False

    def __post_init__(self) -> None:
        _require_id(self.wire_id, "schematic wire ID")
        _require_id(self.net_id, "schematic wire net ID")
        _require_id(self.sheet_id, "schematic wire sheet ID")
        if not isinstance(self.vertices, tuple) or any(
            not isinstance(vertex, PointNm) for vertex in self.vertices
        ):
            raise InvariantViolation(
                "schematic wire vertices must be an immutable tuple of PointNm"
            )
        if len(self.vertices) < 2:
            raise InvariantViolation("schematic wire requires at least two vertices")
        if any(
            start == end
            for start, end in zip(self.vertices, self.vertices[1:], strict=False)
        ):
            raise InvariantViolation("schematic wire cannot contain a zero-length segment")
        if len(self.vertices) != len(set(self.vertices)):
            raise InvariantViolation("schematic wire cannot revisit a vertex")
        segments = tuple(zip(self.vertices, self.vertices[1:], strict=False))
        for first_index, (a, b) in enumerate(segments):
            for second_index in range(first_index + 2, len(segments)):
                c, d = segments[second_index]
                if _segments_intersect(a, b, c, d):
                    raise InvariantViolation("schematic wire cannot self-intersect")
        _require_bool(self.locked, "schematic wire locked flag")

    def normalized(self) -> "SchematicWire":
        reversed_vertices = tuple(reversed(self.vertices))
        return replace(self, vertices=min(self.vertices, reversed_vertices))


@dataclass(frozen=True, slots=True)
class SchematicJunction:
    junction_id: str
    net_id: str
    position: PointNm
    sheet_id: str = "root"
    locked: bool = False

    def __post_init__(self) -> None:
        _require_id(self.junction_id, "schematic junction ID")
        _require_id(self.net_id, "schematic junction net ID")
        _require_id(self.sheet_id, "schematic junction sheet ID")
        if not isinstance(self.position, PointNm):
            raise InvariantViolation("schematic junction position must be PointNm")
        _require_bool(self.locked, "schematic junction locked flag")


@dataclass(frozen=True, slots=True)
class Track:
    track_id: str
    net_id: str
    layer: str
    start: PointNm
    end: PointNm
    width_nm: int
    locked: bool = False

    def __post_init__(self) -> None:
        _require_id(self.track_id, "track ID")
        _require_id(self.net_id, "track net ID")
        _require_text(self.layer, "track layer")
        if not isinstance(self.start, PointNm) or not isinstance(self.end, PointNm):
            raise InvariantViolation("track endpoints must be PointNm")
        _require_int64(self.width_nm, "track width in nanometres")
        _require_bool(self.locked, "track locked flag")
        if self.width_nm <= 0 or self.start == self.end:
            raise InvariantViolation("track requires a layer, positive width, and non-zero length")

    def normalized(self) -> "Track":
        return replace(self, start=min(self.start, self.end), end=max(self.start, self.end))


@dataclass(frozen=True, slots=True)
class DesignGraph:
    schema_version: int
    project_id: str
    layers: tuple[str, ...] = ("F.Cu", "B.Cu")
    board_outline: tuple[PointNm, ...] = ()
    components: tuple[Component, ...] = ()
    nets: tuple[Net, ...] = ()
    placements: tuple[FootprintPlacement, ...] = ()
    tracks: tuple[Track, ...] = ()
    pads: tuple[FootprintPad, ...] = ()
    holes: tuple[FootprintHole, ...] = ()
    vias: tuple[Via, ...] = ()
    zones: tuple[CopperZone, ...] = ()
    schematic_wires: tuple[SchematicWire, ...] = ()
    schematic_junctions: tuple[SchematicJunction, ...] = ()

    def __post_init__(self) -> None:
        _require_int64(self.schema_version, "design graph schema version")
        _require_id(self.project_id, "project ID")
        collections: tuple[tuple[str, object, type[object]], ...] = (
            ("layers", self.layers, str),
            ("board outline", self.board_outline, PointNm),
            ("components", self.components, Component),
            ("nets", self.nets, Net),
            ("placements", self.placements, FootprintPlacement),
            ("tracks", self.tracks, Track),
            ("pads", self.pads, FootprintPad),
            ("holes", self.holes, FootprintHole),
            ("vias", self.vias, Via),
            ("zones", self.zones, CopperZone),
            ("schematic wires", self.schematic_wires, SchematicWire),
            ("schematic junctions", self.schematic_junctions, SchematicJunction),
        )
        for label, values, item_type in collections:
            if not isinstance(values, tuple) or any(
                not isinstance(item, item_type) for item in values
            ):
                raise InvariantViolation(
                    f"{label} must be an immutable tuple of {item_type.__name__}"
                )
        for layer in self.layers:
            _require_text(layer, "copper layer name")

    def normalized(self) -> "DesignGraph":
        outline = _normalized_ring(self.board_outline)
        return replace(
            self,
            layers=tuple(sorted(self.layers)),
            board_outline=outline,
            components=tuple(
                sorted(
                    (item.normalized() for item in self.components),
                    key=lambda item: item.component_id,
                )
            ),
            nets=tuple(
                sorted((item.normalized() for item in self.nets), key=lambda item: item.net_id)
            ),
            placements=tuple(sorted(self.placements, key=lambda item: item.component_id)),
            tracks=tuple(
                sorted((item.normalized() for item in self.tracks), key=lambda item: item.track_id)
            ),
            pads=tuple(
                sorted((item.normalized() for item in self.pads), key=lambda item: item.pad_id)
            ),
            holes=tuple(
                sorted((item.normalized() for item in self.holes), key=lambda item: item.hole_id)
            ),
            vias=tuple(
                sorted((item.normalized() for item in self.vias), key=lambda item: item.via_id)
            ),
            zones=tuple(
                sorted((item.normalized() for item in self.zones), key=lambda item: item.zone_id)
            ),
            schematic_wires=tuple(
                sorted(
                    (item.normalized() for item in self.schematic_wires),
                    key=lambda item: item.wire_id,
                )
            ),
            schematic_junctions=tuple(
                sorted(self.schematic_junctions, key=lambda item: item.junction_id)
            ),
        )

    @property
    def graph_hash(self) -> str:
        normalized = self.normalized()
        validate_graph(normalized)
        return stable_hash(normalized, domain="flux-clone-design-graph-v1")


def validate_graph(graph: DesignGraph) -> None:
    if not isinstance(graph, DesignGraph):
        raise InvariantViolation("graph must be a DesignGraph")
    if graph.schema_version != 1:
        raise InvariantViolation("unsupported design graph schema")
    _require_id(graph.project_id, "project ID")
    if not graph.layers or any(not layer.strip() for layer in graph.layers):
        raise InvariantViolation("at least one non-empty copper layer is required")
    if len(graph.layers) != len(set(graph.layers)):
        raise InvariantViolation("layer names must be unique")
    if graph.board_outline:
        _validate_simple_polygon(graph.board_outline, "board outline")

    component_ids = [component.component_id for component in graph.components]
    references = [component.reference for component in graph.components]
    net_ids = [net.net_id for net in graph.nets]
    net_names = [net.name for net in graph.nets]
    placement_ids = [placement.component_id for placement in graph.placements]
    track_ids = [track.track_id for track in graph.tracks]
    pad_ids = [pad.pad_id for pad in graph.pads]
    hole_ids = [hole.hole_id for hole in graph.holes]
    via_ids = [via.via_id for via in graph.vias]
    zone_ids = [zone.zone_id for zone in graph.zones]
    wire_ids = [wire.wire_id for wire in graph.schematic_wires]
    junction_ids = [junction.junction_id for junction in graph.schematic_junctions]
    for label, values in (
        ("component IDs", component_ids),
        ("component references", references),
        ("net IDs", net_ids),
        ("net names", net_names),
        ("placement component IDs", placement_ids),
        ("track IDs", track_ids),
        ("pad IDs", pad_ids),
        ("hole IDs", hole_ids),
        ("via IDs", via_ids),
        ("zone IDs", zone_ids),
        ("schematic wire IDs", wire_ids),
        ("schematic junction IDs", junction_ids),
    ):
        if len(values) != len(set(values)):
            raise InvariantViolation(f"{label} must be unique")

    components = {component.component_id: component for component in graph.components}
    pin_to_net: dict[PinRef, str] = {}
    for net in graph.nets:
        for member in net.members:
            component = components.get(member.component_id)
            if component is None:
                raise InvariantViolation(
                    f"net {net.net_id} references unknown component {member.component_id}"
                )
            if member.pin_number not in {pin.number for pin in component.pins}:
                raise InvariantViolation(
                    f"net {net.net_id} references unknown pin {member.pin_number}"
                )
            if member in pin_to_net:
                raise InvariantViolation(f"pin {member} belongs to multiple nets")
            pin_to_net[member] = net.net_id
    for placement in graph.placements:
        if placement.component_id not in components:
            raise InvariantViolation("placement references an unknown component")
    known_nets = set(net_ids)
    known_layers = set(graph.layers)
    known_placements = set(placement_ids)
    for track in graph.tracks:
        if track.net_id not in known_nets or track.layer not in known_layers:
            raise InvariantViolation("track references an unknown net or layer")

    pads = {pad.pad_id: pad for pad in graph.pads}
    logical_pad_groups: dict[tuple[str, str], list[FootprintPad]] = {}
    for pad in graph.pads:
        component = components.get(pad.component_id)
        if component is None or pad.component_id not in known_placements:
            raise InvariantViolation("pad requires a known, placed component")
        matching_pins = tuple(pin for pin in component.pins if pin.pad_number == pad.pad_number)
        if len(matching_pins) != 1:
            raise InvariantViolation("pad number must map to exactly one component pin")
        if any(layer not in known_layers for layer in pad.layers):
            raise InvariantViolation("pad references an unknown copper layer")
        if pad.net_id is not None and pad.net_id not in known_nets:
            raise InvariantViolation("pad references an unknown net")
        schematic_net = pin_to_net.get(PinRef(pad.component_id, matching_pins[0].number))
        if schematic_net is not None and pad.net_id != schematic_net:
            raise InvariantViolation(
                f"pad {pad.pad_id} net disagrees with schematic pin connectivity"
            )
        logical_pad_groups.setdefault((pad.component_id, pad.pad_number), []).append(pad)

    for (component_id, pad_number), physical_pads in logical_pad_groups.items():
        logical_nets = {pad.net_id for pad in physical_pads}
        if len(logical_nets) != 1:
            raise InvariantViolation(
                f"physical pads for {component_id}:{pad_number} must have identical net semantics"
            )

    def shared_land_geometry(pad: FootprintPad) -> tuple[object, ...]:
        normalized_pad = pad.normalized()
        return (
            normalized_pad.component_id,
            normalized_pad.center,
            normalized_pad.size_x_nm,
            normalized_pad.size_y_nm,
            normalized_pad.shape,
            normalized_pad.rotation_udeg,
            normalized_pad.layers,
            normalized_pad.drill_x_nm,
            normalized_pad.drill_y_nm,
            normalized_pad.drill_rotation_udeg,
            normalized_pad.net_id,
        )

    shared_land_groups: dict[str, list[FootprintPad]] = {}
    for pad in graph.pads:
        if pad.shared_land_group_id is not None:
            shared_land_groups.setdefault(pad.shared_land_group_id, []).append(pad)
    for group_id, group_pads in shared_land_groups.items():
        if len(group_pads) < 2:
            raise InvariantViolation(
                f"shared land group {group_id} must contain at least two physical pad records"
            )
        if len({pad.component_id for pad in group_pads}) != 1:
            raise InvariantViolation(
                f"shared land group {group_id} cannot cross component boundaries"
            )
        if len({pad.pad_number for pad in group_pads}) != len(group_pads):
            raise InvariantViolation(
                f"shared land group {group_id} must preserve distinct logical pad numbers"
            )
        geometry = shared_land_geometry(group_pads[0])
        if any(shared_land_geometry(pad) != geometry for pad in group_pads[1:]):
            raise InvariantViolation(
                f"shared land group {group_id} members must have exact identical geometry and net"
            )
        group_pad_ids = {pad.pad_id for pad in group_pads}
        if any(
            pad.pad_id not in group_pad_ids and shared_land_geometry(pad) == geometry
            for pad in graph.pads
        ):
            raise InvariantViolation(
                f"shared land group {group_id} cannot omit an exact coincident physical pad"
            )

    bound_pad_ids: set[str] = set()
    for hole in graph.holes:
        if hole.component_id not in components or hole.component_id not in known_placements:
            raise InvariantViolation("footprint hole requires a known, placed component")
        if hole.pad_id is not None:
            if hole.pad_id in bound_pad_ids:
                raise InvariantViolation("a physical pad can bind only one plated footprint hole")
            bound_pad_ids.add(hole.pad_id)
            pad = pads.get(hole.pad_id)
            if pad is None or pad.component_id != hole.component_id:
                raise InvariantViolation(
                    "plated footprint hole references an unknown component pad"
                )
            if (
                pad.drill_x_nm != hole.drill_x_nm
                or pad.drill_y_nm != hole.drill_y_nm
                or pad.normalized().drill_rotation_udeg != hole.normalized().drill_rotation_udeg
            ):
                raise InvariantViolation(
                    "plated footprint hole must match its exact pad drill geometry"
                )
            if pad.center != hole.center:
                raise InvariantViolation("plated footprint hole must share its pad center")

    for via in graph.vias:
        if via.net_id not in known_nets or any(layer not in known_layers for layer in via.layers):
            raise InvariantViolation("via references an unknown net or copper layer")

    for zone in graph.zones:
        if zone.net_id not in known_nets or zone.layer not in known_layers:
            raise InvariantViolation("zone references an unknown net or copper layer")
        _validate_simple_polygon(zone.outline, f"zone {zone.zone_id} outline")

    for wire in graph.schematic_wires:
        if wire.net_id not in known_nets:
            raise InvariantViolation("schematic wire references an unknown net")

    # Crossings between different nets are unambiguous only when neither wire
    # touches nor overlaps the other. A proper interior crossing is permitted;
    # endpoint contact and collinear overlap would imply an accidental short.
    for first_index, first in enumerate(graph.schematic_wires):
        for second in graph.schematic_wires[first_index + 1 :]:
            if first.sheet_id != second.sheet_id:
                continue
            for a, b in zip(first.vertices, first.vertices[1:], strict=False):
                for c, d in zip(second.vertices, second.vertices[1:], strict=False):
                    if not _segments_intersect(a, b, c, d):
                        continue
                    if _collinear_overlap_has_length(a, b, c, d):
                        raise InvariantViolation("schematic wire segments cannot overlap")
                    if first.net_id == second.net_id:
                        continue
                    endpoint_touch = any(
                        _point_on_segment(point, other_start, other_end)
                        for point, other_start, other_end in (
                            (a, c, d),
                            (b, c, d),
                            (c, a, b),
                            (d, a, b),
                        )
                    )
                    if endpoint_touch:
                        raise InvariantViolation(
                            "schematic wires on different nets cannot touch or overlap"
                        )

    junction_locations: set[tuple[str, PointNm]] = set()
    for junction in graph.schematic_junctions:
        if junction.net_id not in known_nets:
            raise InvariantViolation("schematic junction references an unknown net")
        location = (junction.sheet_id, junction.position)
        if location in junction_locations:
            raise InvariantViolation("a schematic sheet position can contain only one junction")
        junction_locations.add(location)
        supporting_wires = {
            wire.wire_id
            for wire in graph.schematic_wires
            if wire.sheet_id == junction.sheet_id
            and wire.net_id == junction.net_id
            and any(
                _point_on_segment(junction.position, start, end)
                for start, end in zip(wire.vertices, wire.vertices[1:], strict=False)
            )
        }
        if len(supporting_wires) < 2:
            raise InvariantViolation(
                "schematic junction must join at least two wires on its exact net and sheet"
            )


class CommandKind(str, Enum):
    COMPONENT_ADD = "component.add"
    COMPONENT_REMOVE = "component.remove"
    NET_CREATE = "net.create"
    NET_CONNECT = "net.connect"
    FOOTPRINT_PLACE = "footprint.place"
    FOOTPRINT_PAD_ADD = "footprint.pad.add"
    FOOTPRINT_PAD_GROUP_ADD = "footprint.pad_group.add"
    FOOTPRINT_HOLE_ADD = "footprint.hole.add"
    TRACK_ADD = "track.add"
    VIA_ADD = "via.add"
    ZONE_ADD = "zone.add"
    SCHEMATIC_WIRE_ADD = "schematic.wire.add"
    SCHEMATIC_JUNCTION_ADD = "schematic.junction.add"
    BOARD_SET_OUTLINE = "board.set_outline"


@dataclass(frozen=True, slots=True)
class DesignCommand:
    command_id: str
    base_revision: str
    transaction_id: str
    actor: str
    kind: CommandKind
    payload_json: str
    idempotency_key: str

    def __post_init__(self) -> None:
        for label, value in (
            ("command ID", self.command_id),
            ("transaction ID", self.transaction_id),
            ("actor", self.actor),
            ("idempotency key", self.idempotency_key),
        ):
            _require_id(value, label)
        _require_sha256(self.base_revision, "base revision")
        if not isinstance(self.kind, CommandKind):
            raise InvariantViolation("command kind must be a supported CommandKind")
        _require_utf8(self.payload_json, "command payload JSON")
        try:
            payload = json.loads(
                self.payload_json,
                object_pairs_hook=_unique_json_object,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    InvariantViolation(f"non-finite JSON number is forbidden: {value}")
                ),
            )
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise InvariantViolation("command payload must be valid JSON") from exc
        if not isinstance(payload, dict) or canonical_json(payload) != self.payload_json:
            raise InvariantViolation("command payload must be a canonical JSON object")

    @classmethod
    def create(
        cls,
        *,
        command_id: str,
        base_revision: str,
        transaction_id: str,
        actor: str,
        kind: CommandKind,
        payload: Mapping[str, Any],
        idempotency_key: str,
    ) -> "DesignCommand":
        return cls(
            command_id,
            base_revision,
            transaction_id,
            actor,
            kind,
            canonical_json(payload),
            idempotency_key,
        )

    @property
    def payload(self) -> dict[str, Any]:
        value = json.loads(self.payload_json, object_pairs_hook=_unique_json_object)
        if not isinstance(value, dict):
            raise InvariantViolation("command payload is not an object")
        return value

    @property
    def command_hash(self) -> str:
        return stable_hash(self, domain="flux-clone-design-command-v1")


class TransactionState(str, Enum):
    OPEN = "open"
    VERIFIED = "verified"
    COMMITTED = "committed"
    ROLLED_BACK = "rolled_back"


@dataclass(frozen=True, slots=True)
class SemanticDiff:
    base_revision: str
    staged_graph_hash: str
    added: tuple[str, ...]
    removed: tuple[str, ...]
    modified: tuple[str, ...]
    command_ids: tuple[str, ...]
    preview_digest: str

    def __post_init__(self) -> None:
        _require_sha256(self.base_revision, "semantic diff base revision")
        _require_sha256(self.staged_graph_hash, "semantic diff staged graph hash")
        _require_sha256(self.preview_digest, "semantic diff preview digest")
        for label, values in (
            ("added entities", self.added),
            ("removed entities", self.removed),
            ("modified entities", self.modified),
            ("command IDs", self.command_ids),
        ):
            if not isinstance(values, tuple) or any(not isinstance(value, str) for value in values):
                raise InvariantViolation(f"{label} must be an immutable tuple of strings")


@dataclass(frozen=True, slots=True)
class DesignTransaction:
    transaction_id: str
    base_revision: str
    staged_graph: DesignGraph
    commands: tuple[DesignCommand, ...] = ()
    state: TransactionState = TransactionState.OPEN
    verification_report_hash: str | None = None
    commit_gate_passed: bool = False
    preview_digest: str = ""
    verification_preview_digest: str | None = None
    committed_revision_hash: str | None = None

    def __post_init__(self) -> None:
        _require_id(self.transaction_id, "transaction ID")
        _require_sha256(self.base_revision, "transaction base revision")
        if not isinstance(self.staged_graph, DesignGraph):
            raise InvariantViolation("transaction staged graph must be a DesignGraph")
        if not isinstance(self.commands, tuple) or any(
            not isinstance(command, DesignCommand) for command in self.commands
        ):
            raise InvariantViolation("transaction commands must be an immutable command tuple")
        if not isinstance(self.state, TransactionState):
            raise InvariantViolation("transaction state must be TransactionState")
        _require_bool(self.commit_gate_passed, "transaction commit gate result")
        if self.preview_digest:
            _require_sha256(self.preview_digest, "transaction preview digest")
        if self.verification_report_hash is not None:
            _require_sha256(self.verification_report_hash, "verification report hash")
        if self.verification_preview_digest is not None:
            _require_sha256(self.verification_preview_digest, "verified preview digest")
        if self.committed_revision_hash is not None:
            _require_sha256(self.committed_revision_hash, "committed revision hash")
        command_ids = [command.command_id for command in self.commands]
        idempotency_keys = [command.idempotency_key for command in self.commands]
        if len(command_ids) != len(set(command_ids)):
            raise InvariantViolation("transaction command IDs must be unique")
        if len(idempotency_keys) != len(set(idempotency_keys)):
            raise InvariantViolation("transaction idempotency keys must be unique")
        if any(
            command.transaction_id != self.transaction_id
            or command.base_revision != self.base_revision
            for command in self.commands
        ):
            raise InvariantViolation("transaction commands must bind to the transaction and base")
        if self.state is TransactionState.VERIFIED and (
            not self.commit_gate_passed
            or self.verification_report_hash is None
            or self.verification_preview_digest != self.preview_digest
        ):
            raise InvariantViolation(
                "verified transaction must bind a passed report to its preview"
            )
        if self.state is TransactionState.COMMITTED and self.committed_revision_hash is None:
            raise InvariantViolation("committed transaction must identify its revision")
        if self.state is TransactionState.OPEN and self.commit_gate_passed:
            raise InvariantViolation("open transaction cannot have a passed commit gate")
        if (
            self.state is not TransactionState.COMMITTED
            and self.committed_revision_hash is not None
        ):
            raise InvariantViolation(
                "only a committed transaction may identify a committed revision"
            )


@dataclass(frozen=True, slots=True)
class DesignRevision:
    revision_hash: str
    parent_revision: str | None
    sequence: int
    graph: DesignGraph
    graph_hash: str
    command_hashes: tuple[str, ...]
    verification_report_hash: str | None
    approval_preview_digest: str | None

    def __post_init__(self) -> None:
        _require_sha256(self.revision_hash, "revision hash")
        if self.parent_revision is not None:
            _require_sha256(self.parent_revision, "parent revision hash")
        if (
            not isinstance(self.sequence, int)
            or isinstance(self.sequence, bool)
            or self.sequence < 0
        ):
            raise InvariantViolation("revision sequence must be a non-negative integer")
        if not isinstance(self.graph, DesignGraph):
            raise InvariantViolation("revision graph must be a DesignGraph")
        _require_sha256(self.graph_hash, "revision graph hash")
        if self.graph_hash != self.graph.graph_hash:
            raise InvariantViolation("revision graph hash does not match its graph")
        if not isinstance(self.command_hashes, tuple):
            raise InvariantViolation("revision command hashes must be an immutable tuple")
        for command_hash in self.command_hashes:
            _require_sha256(command_hash, "revision command hash")
        if self.verification_report_hash is not None:
            _require_sha256(self.verification_report_hash, "revision verification report hash")
        if self.approval_preview_digest is not None:
            _require_sha256(self.approval_preview_digest, "revision approval preview digest")
        if self.sequence == 0:
            if (
                self.parent_revision is not None
                or self.command_hashes
                or self.verification_report_hash is not None
                or self.approval_preview_digest is not None
            ):
                raise InvariantViolation("genesis revision cannot contain commit evidence")
        elif (
            self.parent_revision is None
            or not self.command_hashes
            or self.verification_report_hash is None
            or self.approval_preview_digest is None
        ):
            raise InvariantViolation(
                "non-genesis revision requires parent, commands, verification, and approval"
            )


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InvariantViolation(f"duplicate JSON object key: {key}")
        result[key] = value
    return result

"""Explicit KiCad-10 filled-board semantic normalization and copper evidence."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from backend.kicad_io.sexpr import Atom, Quoted, SExpr, canonical_text, head, parse, scalar_text

from .model import CandidateContractError, canonical_bytes, stable_sha256

NORMALIZER_ID = "kicad10-filled-board-semantics"
NORMALIZER_VERSION = "1.0.0"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_VOLATILE_PROPERTIES = frozenset({"Datasheet", "Description"})
_MAX_VOLATILE_PROPERTY_VALUE_CHARS = 4096


@dataclass(frozen=True, slots=True, order=True)
class FilledPolygonEvidence:
    zone_uuid: str
    net_name: str
    zone_layer: str
    fill_layer: str
    island: bool
    vertices_nm: tuple[tuple[int, int], ...]
    area2_nm2: int
    geometry_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not FilledPolygonEvidence:
            raise CandidateContractError("filled polygon evidence must use the exact type")
        for value, label in (
            (self.zone_uuid, "filled polygon zone UUID"),
            (self.net_name, "filled polygon net"),
            (self.zone_layer, "filled polygon zone layer"),
            (self.fill_layer, "filled polygon layer"),
        ):
            if type(value) is not str or not value:
                raise CandidateContractError(f"{label} must be non-empty exact text")
        if _UUID.fullmatch(self.zone_uuid) is None:
            raise CandidateContractError("filled polygon zone UUID is invalid")
        if type(self.island) is not bool:
            raise CandidateContractError("filled polygon island flag must be exact bool")
        if type(self.vertices_nm) is not tuple or len(self.vertices_nm) < 3:
            raise CandidateContractError("filled polygon needs at least three exact vertices")
        if any(
            type(point) is not tuple
            or len(point) != 2
            or any(type(coordinate) is not int for coordinate in point)
            for point in self.vertices_nm
        ):
            raise CandidateContractError("filled polygon vertices must be exact integer pairs")
        if type(self.area2_nm2) is not int or self.area2_nm2 <= 0:
            raise CandidateContractError("filled polygon doubled area must be positive")
        if (
            type(self.geometry_sha256) is not str
            or len(self.geometry_sha256) != 64
            or any(character not in "0123456789abcdef" for character in self.geometry_sha256)
        ):
            raise CandidateContractError("filled polygon geometry hash is invalid")
        expected = stable_sha256(
            {
                "zone_uuid": self.zone_uuid,
                "net_name": self.net_name,
                "zone_layer": self.zone_layer,
                "fill_layer": self.fill_layer,
                "island": self.island,
                "vertices_nm": self.vertices_nm,
                "area2_nm2": self.area2_nm2,
            },
            domain="kicad-filled-copper-polygon-v1",
        )
        if expected != self.geometry_sha256:
            raise CandidateContractError("filled polygon geometry hash is inconsistent")


@dataclass(frozen=True, slots=True)
class FilledBoardSemanticEvidence:
    schema_version: int
    normalizer_id: str
    normalizer_version: str
    raw_board_sha256: str
    normalized_semantic_sha256: str
    volatile_property_uuid_count: int
    volatile_property_paths_sha256: str
    zone_count: int
    filled_polygon_count: int
    filled_vertex_count: int
    filled_area2_nm2: int
    filled_copper_geometry_sha256: str
    filled_polygons: tuple[FilledPolygonEvidence, ...]

    def __post_init__(self) -> None:
        if type(self) is not FilledBoardSemanticEvidence:
            raise CandidateContractError("filled-board evidence must use the exact type")
        if type(self.schema_version) is not int or self.schema_version != 1:
            raise CandidateContractError("filled-board evidence schema must be 1")
        if self.normalizer_id != NORMALIZER_ID or self.normalizer_version != NORMALIZER_VERSION:
            raise CandidateContractError("filled-board normalizer identity is invalid")
        for value, label in (
            (self.raw_board_sha256, "raw filled-board hash"),
            (self.normalized_semantic_sha256, "filled-board semantic hash"),
            (self.volatile_property_paths_sha256, "volatile-property path hash"),
            (self.filled_copper_geometry_sha256, "filled-copper geometry hash"),
        ):
            if (
                type(value) is not str
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise CandidateContractError(f"{label} is invalid")
        for value, label in (
            (self.volatile_property_uuid_count, "volatile-property UUID count"),
            (self.zone_count, "zone count"),
            (self.filled_polygon_count, "filled polygon count"),
            (self.filled_vertex_count, "filled vertex count"),
            (self.filled_area2_nm2, "filled doubled area"),
        ):
            if type(value) is not int or value < 0:
                raise CandidateContractError(f"{label} must be a non-negative exact integer")
        if type(self.filled_polygons) is not tuple or any(
            type(item) is not FilledPolygonEvidence for item in self.filled_polygons
        ):
            raise CandidateContractError("filled polygons must be an exact evidence tuple")
        if tuple(sorted(self.filled_polygons)) != self.filled_polygons:
            raise CandidateContractError("filled polygon evidence must be sorted")
        if self.filled_polygon_count != len(self.filled_polygons):
            raise CandidateContractError("filled polygon count is inconsistent")
        if self.filled_vertex_count != sum(len(item.vertices_nm) for item in self.filled_polygons):
            raise CandidateContractError("filled vertex count is inconsistent")
        if self.filled_area2_nm2 != sum(item.area2_nm2 for item in self.filled_polygons):
            raise CandidateContractError("filled polygon area is inconsistent")
        expected_geometry = stable_sha256(
            self.filled_polygons,
            domain="kicad-filled-copper-geometry-v1",
        )
        if self.filled_copper_geometry_sha256 != expected_geometry:
            raise CandidateContractError("filled-copper geometry hash is inconsistent")


def _child(expression: SExpr, name: str) -> tuple[SExpr, ...] | None:
    if not isinstance(expression, tuple):
        return None
    for item in expression[1:]:
        if head(item) == name:
            assert isinstance(item, tuple)
            return item
    return None


def _scalar_child(expression: SExpr, name: str) -> str | None:
    item = _child(expression, name)
    if item is None or len(item) < 2:
        return None
    return scalar_text(item[1], label=name)


def _millimetres_to_nm(value: SExpr) -> int:
    try:
        scaled = Decimal(scalar_text(value, label="coordinate")) * Decimal(1_000_000)
    except InvalidOperation as exc:
        raise CandidateContractError("filled polygon coordinate is invalid") from exc
    integral = scaled.to_integral_value()
    if scaled != integral:
        raise CandidateContractError("filled polygon has sub-nanometre coordinate precision")
    return int(integral)


def _normalize_ring(points: tuple[tuple[int, int], ...]) -> tuple[tuple[int, int], ...]:
    values = points[:-1] if len(points) > 1 and points[0] == points[-1] else points
    if len(values) < 3:
        raise CandidateContractError("filled polygon has fewer than three vertices")
    rotations = tuple(values[index:] + values[:index] for index in range(len(values)))
    reverse = tuple(reversed(values))
    reverse_rotations = tuple(
        reverse[index:] + reverse[:index] for index in range(len(reverse))
    )
    return min(rotations + reverse_rotations)


def _polygon_points(expression: SExpr) -> tuple[tuple[int, int], ...]:
    points_node = _child(expression, "pts")
    if points_node is None:
        raise CandidateContractError("filled polygon is missing points")
    points: list[tuple[int, int]] = []
    for item in points_node[1:]:
        if head(item) != "xy" or not isinstance(item, tuple) or len(item) != 3:
            raise CandidateContractError("filled polygon contains a non-vertex primitive")
        points.append((_millimetres_to_nm(item[1]), _millimetres_to_nm(item[2])))
    return _normalize_ring(tuple(points))


def _area2(points: tuple[tuple[int, int], ...]) -> int:
    return abs(
        sum(
            first[0] * second[1] - second[0] * first[1]
            for first, second in zip(points, points[1:] + points[:1], strict=True)
        )
    )


def _validate_volatile_property_value(value: str) -> None:
    """Allow KiCad's nonempty compiler provenance value without erasing it."""

    if (
        len(value) > _MAX_VOLATILE_PROPERTY_VALUE_CHARS
        or value != value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise CandidateContractError("volatile KiCad property value is not canonical")


def _normalize_volatile_property_uuids(
    root: SExpr,
) -> tuple[SExpr, tuple[str, ...]]:
    paths: list[str] = []

    def walk(expression: SExpr, path: str, footprint_uuid: str | None) -> SExpr:
        if not isinstance(expression, tuple):
            return expression
        expression_head = head(expression)
        current_footprint = footprint_uuid
        if expression_head == "footprint":
            current_footprint = _scalar_child(expression, "uuid")
            if current_footprint is None or _UUID.fullmatch(current_footprint) is None:
                raise CandidateContractError("filled board footprint UUID is invalid")
        if expression_head == "property" and len(expression) >= 3:
            property_name = scalar_text(expression[1], label="property name")
            property_value = scalar_text(expression[2], label="property value")
            if property_name in _VOLATILE_PROPERTIES:
                if current_footprint is None:
                    raise CandidateContractError(
                        "volatile KiCad property UUID pattern has unexpected semantics"
                    )
                _validate_volatile_property_value(property_value)
                hide = _child(expression, "hide")
                if hide is None or len(hide) != 2 or scalar_text(hide[1], label="hide") != "yes":
                    raise CandidateContractError(
                        "volatile KiCad property UUID is not on a hidden property"
                    )
                uuid_indices = [
                    index for index, item in enumerate(expression) if head(item) == "uuid"
                ]
                if len(uuid_indices) != 1:
                    raise CandidateContractError(
                        "volatile KiCad property must have exactly one UUID"
                    )
                uuid_index = uuid_indices[0]
                uuid_node = expression[uuid_index]
                assert isinstance(uuid_node, tuple)
                if (
                    len(uuid_node) != 2
                    or not isinstance(uuid_node[1], (Atom, Quoted))
                    or _UUID.fullmatch(uuid_node[1].value) is None
                ):
                    raise CandidateContractError("volatile KiCad property UUID is invalid")
                identity = f"{current_footprint}/{property_name}"
                paths.append(identity)
                replacement = (uuid_node[0], Quoted(f"<volatile:{identity}>"))
                expression = (
                    *expression[:uuid_index],
                    replacement,
                    *expression[uuid_index + 1 :],
                )
        return tuple(
            walk(item, f"{path}/{expression_head or 'list'}[{index}]", current_footprint)
            for index, item in enumerate(expression)
        )

    normalized = walk(root, "root", None)
    if len(paths) != len(set(paths)):
        raise CandidateContractError("volatile KiCad property identities are not unique")
    return normalized, tuple(sorted(paths))


def _filled_polygons(root: SExpr) -> tuple[int, tuple[FilledPolygonEvidence, ...]]:
    if not isinstance(root, tuple) or head(root) != "kicad_pcb":
        raise CandidateContractError("filled board must be a KiCad PCB S-expression")
    result: list[FilledPolygonEvidence] = []
    zones = tuple(item for item in root[1:] if head(item) == "zone")
    for zone in zones:
        zone_uuid = _scalar_child(zone, "uuid")
        net_name = _scalar_child(zone, "net")
        zone_layer = _scalar_child(zone, "layer")
        if (
            zone_uuid is None
            or _UUID.fullmatch(zone_uuid) is None
            or net_name is None
            or zone_layer is None
        ):
            raise CandidateContractError("filled zone identity/net/layer is invalid")
        assert isinstance(zone, tuple)
        if any(head(item) == "fill_segments" for item in zone[1:]):
            raise CandidateContractError(
                "filled-board normalizer does not flatten fill_segments geometry"
            )
        zone_polygons = tuple(item for item in zone[1:] if head(item) == "filled_polygon")
        if not zone_polygons:
            raise CandidateContractError("zone has no source-verified filled polygon")
        for item in zone_polygons:
            fill_layer = _scalar_child(item, "layer")
            if fill_layer is None or fill_layer != zone_layer:
                raise CandidateContractError("filled polygon layer disagrees with zone layer")
            vertices = _polygon_points(item)
            area2 = _area2(vertices)
            if area2 <= 0:
                raise CandidateContractError("filled polygon has zero exact doubled area")
            payload = {
                "zone_uuid": zone_uuid,
                "net_name": net_name,
                "zone_layer": zone_layer,
                "fill_layer": fill_layer,
                "island": _child(item, "island") is not None,
                "vertices_nm": vertices,
                "area2_nm2": area2,
            }
            result.append(
                FilledPolygonEvidence(
                    zone_uuid=zone_uuid,
                    net_name=net_name,
                    zone_layer=zone_layer,
                    fill_layer=fill_layer,
                    island=_child(item, "island") is not None,
                    vertices_nm=vertices,
                    area2_nm2=area2,
                    geometry_sha256=stable_sha256(
                        payload,
                        domain="kicad-filled-copper-polygon-v1",
                    ),
                )
            )
    return len(zones), tuple(sorted(result))


def analyze_filled_board(payload: bytes) -> FilledBoardSemanticEvidence:
    """Hash exact raw bytes and a narrowly normalized semantic S-expression."""

    if type(payload) is not bytes or not payload:
        raise CandidateContractError("filled board must be non-empty exact bytes")
    root = parse(payload)
    normalized_root, volatile_paths = _normalize_volatile_property_uuids(root)
    zone_count, polygons = _filled_polygons(root)
    return FilledBoardSemanticEvidence(
        schema_version=1,
        normalizer_id=NORMALIZER_ID,
        normalizer_version=NORMALIZER_VERSION,
        raw_board_sha256=hashlib.sha256(payload).hexdigest(),
        normalized_semantic_sha256=stable_sha256(
            canonical_text(normalized_root),
            domain="kicad-filled-board-semantic-v1",
        ),
        volatile_property_uuid_count=len(volatile_paths),
        volatile_property_paths_sha256=stable_sha256(
            volatile_paths,
            domain="kicad-volatile-property-paths-v1",
        ),
        zone_count=zone_count,
        filled_polygon_count=len(polygons),
        filled_vertex_count=sum(len(item.vertices_nm) for item in polygons),
        filled_area2_nm2=sum(item.area2_nm2 for item in polygons),
        filled_copper_geometry_sha256=stable_sha256(
            polygons,
            domain="kicad-filled-copper-geometry-v1",
        ),
        filled_polygons=polygons,
    )


def filled_board_evidence_payload(evidence: FilledBoardSemanticEvidence) -> bytes:
    if type(evidence) is not FilledBoardSemanticEvidence:
        raise CandidateContractError("filled-board payload requires exact evidence")
    return canonical_bytes(evidence) + b"\n"


__all__ = (
    "NORMALIZER_ID",
    "NORMALIZER_VERSION",
    "FilledBoardSemanticEvidence",
    "FilledPolygonEvidence",
    "analyze_filled_board",
    "filled_board_evidence_payload",
)

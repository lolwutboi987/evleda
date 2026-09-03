"""Source-bound authored-zone identity for a KiCad-filled PCB derivative.

KiCad serializes a board again when it fills zones.  The serialization changes
some non-semantic defaults and net-code spelling in addition to adding the
filled copper polygons.  This module reduces both boards to one deliberately
narrow semantic form, while retaining every authored zone setting.  It then
requires the two forms to be identical before emitting digest-bound evidence.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from backend.kicad_io.sexpr import Atom, Quoted, SExpr, canonical_text, head, parse, scalar_text

from .model import CandidateContractError, stable_sha256

ZONE_IDENTITY_NORMALIZER_ID = "kicad10-source-zone-identity"
ZONE_IDENTITY_NORMALIZER_VERSION = "1.0.0"

_SHA256 = re.compile(r"[0-9a-f]{64}")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_VOLATILE_PROPERTIES = frozenset({"Datasheet", "Description"})
_GENERATED_ZONE_HEADS = frozenset({"filled_polygon", "fill_segments"})
_DEFAULT_FILL_VALUES = {
    "island_removal_mode": "0",
    "thermal_bridge_width": "0.5",
    "thermal_gap": "0.5",
}
_MAX_VOLATILE_PROPERTY_VALUE_CHARS = 4096


@dataclass(frozen=True, slots=True, order=True)
class AuthoredZoneIdentity:
    """Exact semantic identity of one source-authored single-layer zone."""

    zone_uuid: str
    net_name: str
    layer: str
    normalized_outline_nm: tuple[tuple[int, int], ...]
    authored_zone_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not AuthoredZoneIdentity:
            raise CandidateContractError("authored zone identity must use the exact type")
        if type(self.zone_uuid) is not str or _UUID.fullmatch(self.zone_uuid) is None:
            raise CandidateContractError("authored zone UUID is invalid")
        for value, label in ((self.net_name, "authored zone net"), (self.layer, "zone layer")):
            if type(value) is not str or not value:
                raise CandidateContractError(f"{label} must be non-empty exact text")
        if type(self.normalized_outline_nm) is not tuple or len(self.normalized_outline_nm) < 3:
            raise CandidateContractError("authored zone outline needs at least three vertices")
        if any(
            type(point) is not tuple
            or len(point) != 2
            or any(type(coordinate) is not int for coordinate in point)
            for point in self.normalized_outline_nm
        ):
            raise CandidateContractError("authored zone outline must use exact integer-nm pairs")
        _require_sha256(self.authored_zone_sha256, "authored zone semantic hash")


@dataclass(frozen=True, slots=True)
class SourceZoneIdentityEvidence:
    """Proof that a filled derivative retains the exact authored board intent."""

    schema_version: int
    normalizer_id: str
    normalizer_version: str
    source_bundle_sha256: str
    source_board_sha256: str
    derivative_board_sha256: str
    normalized_board_semantic_sha256: str
    authored_zone_intent_sha256: str
    volatile_property_uuid_count: int
    volatile_property_paths_sha256: str
    generated_fill_node_count: int
    zone_count: int
    zones: tuple[AuthoredZoneIdentity, ...]

    def __post_init__(self) -> None:
        if type(self) is not SourceZoneIdentityEvidence:
            raise CandidateContractError("source-zone evidence must use the exact type")
        if type(self.schema_version) is not int or self.schema_version != 1:
            raise CandidateContractError("source-zone evidence schema must be 1")
        if (
            self.normalizer_id != ZONE_IDENTITY_NORMALIZER_ID
            or self.normalizer_version != ZONE_IDENTITY_NORMALIZER_VERSION
        ):
            raise CandidateContractError("source-zone normalizer identity is invalid")
        for value, label in (
            (self.source_bundle_sha256, "source bundle hash"),
            (self.source_board_sha256, "source board hash"),
            (self.derivative_board_sha256, "derivative board hash"),
            (self.normalized_board_semantic_sha256, "normalized board semantic hash"),
            (self.authored_zone_intent_sha256, "authored zone intent hash"),
            (self.volatile_property_paths_sha256, "volatile-property path hash"),
        ):
            _require_sha256(value, label)
        for value, label in (
            (self.volatile_property_uuid_count, "volatile-property UUID count"),
            (self.generated_fill_node_count, "generated fill-node count"),
            (self.zone_count, "authored zone count"),
        ):
            if type(value) is not int or value < 0:
                raise CandidateContractError(f"{label} must be a non-negative exact integer")
        if self.generated_fill_node_count < 1:
            raise CandidateContractError("filled derivative must contain generated zone fill")
        if type(self.zones) is not tuple or any(
            type(item) is not AuthoredZoneIdentity for item in self.zones
        ):
            raise CandidateContractError("authored zones must be an exact evidence tuple")
        if tuple(sorted(self.zones)) != self.zones:
            raise CandidateContractError("authored zones must be deterministically sorted")
        if self.zone_count != len(self.zones) or self.zone_count < 1:
            raise CandidateContractError("authored zone count is inconsistent")
        expected_intent = stable_sha256(self.zones, domain="kicad-authored-zone-intent-v1")
        if expected_intent != self.authored_zone_intent_sha256:
            raise CandidateContractError("authored zone intent hash is inconsistent")


@dataclass(frozen=True, slots=True)
class _NormalizedBoard:
    semantic_text: str
    volatile_paths: tuple[str, ...]
    generated_fill_node_count: int
    zones: tuple[AuthoredZoneIdentity, ...]


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise CandidateContractError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _children(expression: SExpr, name: str) -> tuple[tuple[SExpr, ...], ...]:
    if not isinstance(expression, tuple):
        return ()
    return tuple(item for item in expression[1:] if isinstance(item, tuple) and head(item) == name)


def _only_child(expression: SExpr, name: str, *, label: str) -> tuple[SExpr, ...]:
    matches = _children(expression, name)
    if len(matches) != 1:
        raise CandidateContractError(f"{label} requires exactly one {name}")
    return matches[0]


def _only_scalar_child(expression: SExpr, name: str, *, label: str) -> str:
    child = _only_child(expression, name, label=label)
    if len(child) != 2:
        raise CandidateContractError(f"{label} {name} must contain one exact scalar")
    return scalar_text(child[1], label=f"{label} {name}")


def _canonical_decimal(value: str, *, label: str) -> str:
    if _DECIMAL.fullmatch(value) is None:
        raise CandidateContractError(f"{label} is not an exact decimal")
    try:
        decimal = Decimal(value)
    except InvalidOperation as exc:
        raise CandidateContractError(f"{label} is not an exact decimal") from exc
    if not decimal.is_finite():
        raise CandidateContractError(f"{label} must be finite")
    if decimal == 0:
        return "0"
    if decimal == decimal.to_integral_value():
        return str(int(decimal))
    return format(decimal.normalize(), "f")


def _validate_volatile_property_value(value: str) -> None:
    if (
        len(value) > _MAX_VOLATILE_PROPERTY_VALUE_CHARS
        or value != value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise CandidateContractError("volatile property value is not canonical")


def _millimetres_to_nm(value: SExpr, *, label: str) -> int:
    canonical = _canonical_decimal(scalar_text(value, label=label), label=label)
    scaled = Decimal(canonical) * Decimal(1_000_000)
    integral = scaled.to_integral_value()
    if scaled != integral:
        raise CandidateContractError(f"{label} has sub-nanometre precision")
    return int(integral)


def _normalize_ring(points: tuple[tuple[int, int], ...]) -> tuple[tuple[int, int], ...]:
    values = points[:-1] if len(points) > 1 and points[0] == points[-1] else points
    if len(values) < 3 or len(set(values)) < 3:
        raise CandidateContractError("authored zone outline has fewer than three unique vertices")
    rotations = tuple(values[index:] + values[:index] for index in range(len(values)))
    reverse = tuple(reversed(values))
    reverse_rotations = tuple(
        reverse[index:] + reverse[:index] for index in range(len(reverse))
    )
    return min(rotations + reverse_rotations)


def _polygon_outline(polygon: tuple[SExpr, ...]) -> tuple[tuple[int, int], ...]:
    if len(polygon) != 2 or head(polygon[1]) != "pts":
        raise CandidateContractError("authored zone polygon must contain only one pts list")
    points_node = polygon[1]
    assert isinstance(points_node, tuple)
    points: list[tuple[int, int]] = []
    for item in points_node[1:]:
        if not isinstance(item, tuple) or head(item) != "xy" or len(item) != 3:
            raise CandidateContractError("authored zone outline contains a non-xy primitive")
        points.append(
            (
                _millimetres_to_nm(item[1], label="zone outline X"),
                _millimetres_to_nm(item[2], label="zone outline Y"),
            )
        )
    return _normalize_ring(tuple(points))


def _zone_outline(zone: SExpr) -> tuple[tuple[int, int], ...]:
    polygons = _children(zone, "polygon")
    if len(polygons) != 1:
        raise CandidateContractError("authored zone requires exactly one polygon outline")
    return _polygon_outline(polygons[0])


def _net_table(root: SExpr) -> dict[str, str]:
    if not isinstance(root, tuple) or head(root) != "kicad_pcb":
        raise CandidateContractError("board must be a KiCad PCB S-expression")
    result: dict[str, str] = {}
    names: set[str] = set()
    for item in root[1:]:
        if head(item) != "net":
            continue
        assert isinstance(item, tuple)
        if len(item) != 3:
            raise CandidateContractError("root net declaration must contain code and name")
        code = scalar_text(item[1], label="root net code")
        name = scalar_text(item[2], label="root net name")
        if not code.isdecimal() or code in result or name in names:
            raise CandidateContractError("root net table is not unique and canonical")
        result[code] = name
        names.add(name)
    return result


def _resolve_net(node: tuple[SExpr, ...], net_table: dict[str, str], *, label: str) -> str:
    if len(node) not in {2, 3}:
        raise CandidateContractError(f"{label} net must contain a name or code/name pair")
    first = scalar_text(node[1], label=f"{label} net")
    resolved = net_table.get(first, first)
    if len(node) == 3:
        supplied = scalar_text(node[2], label=f"{label} net name")
        if supplied != resolved:
            raise CandidateContractError(f"{label} net code/name pair is inconsistent")
    if not resolved:
        raise CandidateContractError(f"{label} must bind a connected net")
    return resolved


def _zone_net(zone: SExpr, net_table: dict[str, str]) -> str:
    node = _only_child(zone, "net", label="authored zone")
    name = _resolve_net(node, net_table, label="authored zone")
    supplied_names = _children(zone, "net_name")
    if supplied_names:
        if len(supplied_names) != 1 or len(supplied_names[0]) != 2:
            raise CandidateContractError("authored zone net_name is malformed or duplicated")
        supplied = scalar_text(supplied_names[0][1], label="authored zone net_name")
        if supplied != name:
            raise CandidateContractError("authored zone net and net_name disagree")
    return name


def _canonical_scalar(value: SExpr) -> Quoted:
    text = scalar_text(value, label="KiCad scalar")
    if _DECIMAL.fullmatch(text) is not None:
        return Quoted(f"#number:{_canonical_decimal(text, label='KiCad number')}")
    return Quoted(f"#text:{text}")


def _canonical_node(name: str, values: list[SExpr]) -> tuple[SExpr, ...]:
    return (Atom(name), *values)


def _sort_nodes(values: list[SExpr]) -> list[SExpr]:
    scalars = [item for item in values if not isinstance(item, tuple)]
    children = [item for item in values if isinstance(item, tuple)]
    return [*scalars, *sorted(children, key=canonical_text)]


def _is_exact_scalar_node(expression: SExpr, name: str, value: str) -> bool:
    return (
        isinstance(expression, tuple)
        and head(expression) == name
        and len(expression) == 2
        and scalar_text(expression[1], label=name) == value
    )


def _is_exact_front_back(expression: SExpr, name: str, value: str) -> bool:
    if not isinstance(expression, tuple) or head(expression) != name or len(expression) != 3:
        return False
    entries = {
        head(item): scalar_text(item[1], label=f"{name} side")
        for item in expression[1:]
        if isinstance(item, tuple) and len(item) == 2
    }
    return entries == {"front": value, "back": value}


def _is_kicad_default_tenting(expression: SExpr) -> bool:
    """Recognize only KiCad's injected two-sided default tenting setting."""

    if _is_exact_front_back(expression, "tenting", "yes"):
        return True
    if not isinstance(expression, tuple) or head(expression) != "tenting":
        return False
    atoms = tuple(
        scalar_text(item, label="tenting side")
        for item in expression[1:]
        if not isinstance(item, tuple)
    )
    return len(expression) == 3 and frozenset(atoms) == frozenset(("front", "back"))


def _effective_fill(
    expression: SExpr | None,
    recurse: Callable[[SExpr, str, str | None, str | None], SExpr | None],
) -> tuple[SExpr, ...]:
    values = dict(_DEFAULT_FILL_VALUES)
    extras: list[SExpr] = []
    if expression is not None:
        assert isinstance(expression, tuple)
        if len(expression) < 2 or scalar_text(expression[1], label="zone fill mode") != "yes":
            raise CandidateContractError("zone fill must use exact KiCad mode 'yes'")
        seen: set[str] = set()
        for item in expression[2:]:
            item_head = head(item)
            if item_head in _DEFAULT_FILL_VALUES:
                assert isinstance(item, tuple)
                if item_head in seen or len(item) != 2:
                    raise CandidateContractError("zone fill default is malformed or duplicated")
                seen.add(item_head)
                value = scalar_text(item[1], label=f"zone fill {item_head}")
                values[item_head] = _canonical_decimal(value, label=f"zone fill {item_head}")
            else:
                normalized = recurse(item, "fill", None, None)
                assert isinstance(normalized, tuple)
                extras.append(normalized)
    children: list[SExpr] = [Quoted("#text:yes")]
    children.extend(
        _canonical_node(name, [Quoted(f"#number:{value}")])
        for name, value in sorted(values.items())
    )
    children.extend(sorted(extras, key=canonical_text))
    return _canonical_node("fill", children)


def _normalize_board(payload: bytes, *, derivative: bool) -> _NormalizedBoard:
    if type(payload) is not bytes or not payload:
        raise CandidateContractError("source and derivative boards must be non-empty exact bytes")
    root = parse(payload)
    if not isinstance(root, tuple) or head(root) != "kicad_pcb":
        raise CandidateContractError("board must be a KiCad PCB S-expression")
    nets = _net_table(root)
    volatile_paths: list[str] = []
    generated_fill_node_count = 0

    def recurse(
        expression: SExpr,
        parent: str,
        footprint_uuid: str | None,
        footprint_library: str | None,
    ) -> SExpr | None:
        nonlocal generated_fill_node_count
        if not isinstance(expression, tuple):
            return _canonical_scalar(expression)
        expression_head = head(expression)
        if expression_head is None:
            values = [
                normalized
                for item in expression
                if (normalized := recurse(item, parent, footprint_uuid, footprint_library))
                is not None
            ]
            return tuple(values)

        current_uuid = footprint_uuid
        current_library = footprint_library
        if expression_head == "footprint":
            if len(expression) < 2:
                raise CandidateContractError("footprint is missing its library identity")
            current_library = scalar_text(expression[1], label="footprint library identity")
            current_uuid = _only_scalar_child(expression, "uuid", label="footprint")
            if _UUID.fullmatch(current_uuid) is None:
                raise CandidateContractError("footprint UUID is invalid")

        if expression_head == "property" and len(expression) >= 3:
            property_name = scalar_text(expression[1], label="property name")
            property_value = scalar_text(expression[2], label="property value")
            if property_name == "Footprint":
                if current_library is None or property_value != current_library:
                    raise CandidateContractError(
                        "redundant Footprint property disagrees with library"
                    )
                # KiCad 10 drops this compiler-emitted redundant property on save.
                return None
            if property_name in _VOLATILE_PROPERTIES:
                if current_uuid is None:
                    raise CandidateContractError("volatile property is outside a footprint")
                _validate_volatile_property_value(property_value)
                hide = _only_child(expression, "hide", label="volatile property")
                if len(hide) != 2 or scalar_text(hide[1], label="hide") != "yes":
                    raise CandidateContractError("volatile property must be hidden")
                uuid_node = _only_child(expression, "uuid", label="volatile property")
                if len(uuid_node) != 2:
                    raise CandidateContractError("volatile property UUID is malformed")
                property_uuid = scalar_text(uuid_node[1], label="volatile property UUID")
                if _UUID.fullmatch(property_uuid) is None:
                    raise CandidateContractError("volatile property UUID is invalid")
                identity = f"{current_uuid}/{property_name}"
                volatile_paths.append(identity)
                if property_value == "":
                    # KiCad may either rewrite these UUIDs or inject the entire
                    # empty hidden property. Once validated, it is non-semantic.
                    return None
                # Compiler-owned nonempty provenance values are semantic. KiCad
                # may still rewrite their property UUID, so replace only UUID.
                expression = tuple(
                    (Atom("uuid"), Quoted(f"<volatile:{identity}>"))
                    if head(item) == "uuid"
                    else item
                    for item in expression
                )

        if expression_head == "polygon" and parent == "zone":
            outline = _polygon_outline(expression)
            points: list[SExpr] = [
                _canonical_node(
                    "xy",
                    [Quoted(f"#nm:{point[0]}"), Quoted(f"#nm:{point[1]}")],
                )
                for point in outline
            ]
            return _canonical_node("polygon", [_canonical_node("pts", points)])

        if expression_head == "net" and parent != "kicad_pcb":
            return _canonical_node(
                "net",
                [Quoted(f"#text:{_resolve_net(expression, nets, label=parent or 'entity')}")],
            )

        normalized_values: list[SExpr] = []
        fill_node: SExpr | None = None
        for item in expression[1:]:
            item_head = head(item)
            if expression_head == "kicad_pcb" and item_head in {
                "version",
                "generator",
                "generator_version",
                "embedded_fonts",
                "net",
                # The root layer table is a KiCad serialization registry.  It
                # changes numeric IDs and redundant aliases during a save; every
                # feature's explicit layer name (including zones) remains in the
                # semantic projection below and is therefore still protected.
                "layers",
            }:
                continue
            if expression_head == "zone":
                if item_head == "net_name":
                    continue
                if item_head in _GENERATED_ZONE_HEADS:
                    if not derivative:
                        raise CandidateContractError("source board contains generated zone fill")
                    generated_fill_node_count += 1
                    continue
                if item_head == "fill":
                    if fill_node is not None:
                        raise CandidateContractError("zone has duplicate fill configuration")
                    fill_node = item
                    continue
            if (
                expression_head == "footprint"
                and item_head in {"embedded_fonts", "duplicate_pad_numbers_are_jumpers"}
                and _is_exact_scalar_node(item, item_head, "no")
            ):
                continue
            if (
                expression_head == "pad"
                and item_head == "remove_unused_layers"
                and _is_exact_scalar_node(item, "remove_unused_layers", "no")
            ):
                continue
            if (
                expression_head == "gr_line"
                and item_head == "fill"
                and _is_exact_scalar_node(item, "fill", "none")
            ):
                continue
            if expression_head in {"setup", "via"}:
                if item_head in {"covering", "plugging"} and _is_exact_front_back(
                    item, item_head, "no"
                ):
                    continue
                if item_head in {"capping", "filling"} and _is_exact_scalar_node(
                    item, item_head, "no"
                ):
                    continue
                if expression_head == "setup" and item_head == "pcbplotparams":
                    # Plot preferences are not board geometry.  They are injected by
                    # KiCad when absent and are kept only when authored on both sides.
                    continue
                if expression_head == "setup" and _is_kicad_default_tenting(item):
                    # KiCad 10.0.6 writes this default when it was absent.  A
                    # non-default or malformed tenting declaration stays semantic.
                    continue
            normalized = recurse(item, expression_head, current_uuid, current_library)
            if normalized is not None:
                normalized_values.append(normalized)

        if expression_head == "zone":
            normalized_values.append(_effective_fill(fill_node, recurse))
        if expression_head == "tenting":
            atoms = {
                scalar_text(item, label="tenting side")
                for item in expression[1:]
                if not isinstance(item, tuple)
            }
            if atoms:
                if atoms != {"front", "back"} or len(expression) != 3:
                    raise CandidateContractError("setup tenting shorthand is unsupported")
                normalized_values = [
                    _canonical_node("back", [Quoted("#text:yes")]),
                    _canonical_node("front", [Quoted("#text:yes")]),
                ]
        if expression_head == "at" and len(normalized_values) == 2:
            normalized_values.append(Quoted("#number:0"))
        if expression_head == "at" and len(normalized_values) >= 3:
            angle_node = normalized_values[-1]
            if not isinstance(angle_node, Quoted) or not angle_node.value.startswith("#number:"):
                raise CandidateContractError("KiCad at angle is not numeric")
            angle = Decimal(angle_node.value.removeprefix("#number:")) % Decimal(360)
            if angle < 0:
                angle += Decimal(360)
            canonical_angle = str(int(angle)) if angle == angle.to_integral_value() else format(
                angle.normalize(), "f"
            )
            normalized_values[-1] = Quoted(f"#number:{canonical_angle}")
        if expression_head == "layers" and parent != "kicad_pcb":
            normalized_values = sorted(normalized_values, key=canonical_text)
        elif expression_head not in {"pts", "layers"}:
            normalized_values = _sort_nodes(normalized_values)
        return _canonical_node(expression_head, normalized_values)

    normalized_root = recurse(root, "", None, None)
    assert isinstance(normalized_root, tuple)
    if derivative and generated_fill_node_count < 1:
        raise CandidateContractError("derivative board contains no generated zone fill")
    if len(volatile_paths) != len(set(volatile_paths)):
        raise CandidateContractError("volatile property identities are not unique")

    zone_nodes = tuple(item for item in root[1:] if head(item) == "zone")
    zones: list[AuthoredZoneIdentity] = []
    for zone in zone_nodes:
        zone_uuid = _only_scalar_child(zone, "uuid", label="authored zone")
        if _UUID.fullmatch(zone_uuid) is None:
            raise CandidateContractError("authored zone UUID is invalid")
        layer_nodes = _children(zone, "layer")
        layers_nodes = _children(zone, "layers")
        if len(layer_nodes) == 1 and not layers_nodes and len(layer_nodes[0]) == 2:
            layer = scalar_text(layer_nodes[0][1], label="authored zone layer")
        elif not layer_nodes and len(layers_nodes) == 1 and len(layers_nodes[0]) == 2:
            layer = scalar_text(layers_nodes[0][1], label="authored zone layer")
        else:
            raise CandidateContractError("authored zone must use exactly one layer")
        net_name = _zone_net(zone, nets)
        generated_before_authored_projection = generated_fill_node_count
        authored_node = recurse(zone, "kicad_pcb", None, None)
        generated_fill_node_count = generated_before_authored_projection
        assert isinstance(authored_node, tuple)
        zones.append(
            AuthoredZoneIdentity(
                zone_uuid=zone_uuid,
                net_name=net_name,
                layer=layer,
                normalized_outline_nm=_zone_outline(zone),
                authored_zone_sha256=stable_sha256(
                    canonical_text(authored_node), domain="kicad-authored-zone-v1"
                ),
            )
        )
    ordered_zones = tuple(sorted(zones))
    if not ordered_zones:
        raise CandidateContractError("board must contain one or more authored zones")
    if len({item.zone_uuid for item in ordered_zones}) != len(ordered_zones):
        raise CandidateContractError("authored zone UUIDs are not unique")
    return _NormalizedBoard(
        semantic_text=canonical_text(normalized_root),
        volatile_paths=tuple(sorted(volatile_paths)),
        generated_fill_node_count=generated_fill_node_count,
        zones=ordered_zones,
    )


def compare_source_zone_identity(
    source_pcb: bytes,
    derivative_pcb: bytes,
    *,
    source_bundle_sha256: str,
) -> SourceZoneIdentityEvidence:
    """Prove that a KiCad-filled derivative preserves exact authored intent."""

    _require_sha256(source_bundle_sha256, "source bundle hash")
    source = _normalize_board(source_pcb, derivative=False)
    derivative = _normalize_board(derivative_pcb, derivative=True)
    if not set(source.volatile_paths).issubset(derivative.volatile_paths):
        raise CandidateContractError("source volatile property disappeared in derivative")
    if source.zones != derivative.zones:
        raise CandidateContractError("authored zone intent changed in derivative")
    if source.semantic_text != derivative.semantic_text:
        raise CandidateContractError("non-fill authored board semantics changed in derivative")
    semantic_sha256 = stable_sha256(
        source.semantic_text, domain="kicad-filled-derivative-authored-semantics-v1"
    )
    zone_intent_sha256 = stable_sha256(
        source.zones, domain="kicad-authored-zone-intent-v1"
    )
    return SourceZoneIdentityEvidence(
        schema_version=1,
        normalizer_id=ZONE_IDENTITY_NORMALIZER_ID,
        normalizer_version=ZONE_IDENTITY_NORMALIZER_VERSION,
        source_bundle_sha256=source_bundle_sha256,
        source_board_sha256=hashlib.sha256(source_pcb).hexdigest(),
        derivative_board_sha256=hashlib.sha256(derivative_pcb).hexdigest(),
        normalized_board_semantic_sha256=semantic_sha256,
        authored_zone_intent_sha256=zone_intent_sha256,
        volatile_property_uuid_count=len(derivative.volatile_paths),
        volatile_property_paths_sha256=stable_sha256(
            derivative.volatile_paths, domain="kicad-source-zone-volatile-property-paths-v1"
        ),
        generated_fill_node_count=derivative.generated_fill_node_count,
        zone_count=len(source.zones),
        zones=source.zones,
    )


def source_authored_zone_count(source_pcb: bytes) -> int:
    """Return the strict count of source-authored zones, including exact zero."""

    if type(source_pcb) is not bytes or not source_pcb:
        raise CandidateContractError("source board must be non-empty exact bytes")
    root = parse(source_pcb)
    if not isinstance(root, tuple) or head(root) != "kicad_pcb":
        raise CandidateContractError("source board must be a KiCad PCB S-expression")
    nets = _net_table(root)
    zone_uuids: set[str] = set()
    count = 0
    for zone in root[1:]:
        if not isinstance(zone, tuple) or head(zone) != "zone":
            continue
        count += 1
        zone_uuid = _only_scalar_child(zone, "uuid", label="authored zone")
        if _UUID.fullmatch(zone_uuid) is None or zone_uuid in zone_uuids:
            raise CandidateContractError("source authored zone UUID is invalid or duplicated")
        zone_uuids.add(zone_uuid)
        _zone_net(zone, nets)
        _zone_outline(zone)
        layer_nodes = _children(zone, "layer")
        layers_nodes = _children(zone, "layers")
        single_layer = (
            len(layer_nodes) == 1
            and not layers_nodes
            and len(layer_nodes[0]) == 2
        ) or (
            not layer_nodes
            and len(layers_nodes) == 1
            and len(layers_nodes[0]) == 2
        )
        if not single_layer:
            raise CandidateContractError("source authored zone must use exactly one layer")
        if any(head(item) in _GENERATED_ZONE_HEADS for item in zone[1:]):
            raise CandidateContractError("source board contains generated zone fill")
    return count


__all__ = (
    "ZONE_IDENTITY_NORMALIZER_ID",
    "ZONE_IDENTITY_NORMALIZER_VERSION",
    "AuthoredZoneIdentity",
    "SourceZoneIdentityEvidence",
    "compare_source_zone_identity",
    "source_authored_zone_count",
)

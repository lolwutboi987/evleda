"""Strict single-sheet KiCad 10 schematic parser, writer, and net resolver."""

from __future__ import annotations

import hashlib
import re
from decimal import Decimal, InvalidOperation

from backend.kicad_io import PointNm, canonical_net_id
from backend.kicad_io.sexpr import (
    ParseLimits,
    SExpr,
    atom,
    canonical_text,
    head,
    node,
    parse,
    quoted,
    render,
    scalar_text,
)

from .errors import ProjectInvariantError, ProjectSyntaxError
from .model import (
    BundleLimits,
    DiagnosticDisposition,
    LabelKind,
    LibraryPin,
    LibrarySymbol,
    ProjectDiagnostic,
    ProjectDiagnostics,
    Schematic,
    SchematicJunction,
    SchematicLabel,
    SchematicNet,
    SchematicNoConnect,
    SchematicPin,
    SchematicPinRef,
    SchematicSymbol,
    SchematicWire,
    stable_hash,
)

_KNOWN_KICAD_10_SCHEMATIC_VERSIONS = {20250114, 20260306}
_INTEGER = re.compile(r"-?(?:0|[1-9][0-9]*)")
_UNIT_SUFFIX = re.compile(r"_([0-9]+)_([0-9]+)$")


class _Recorder:
    def __init__(self) -> None:
        self.items: list[ProjectDiagnostic] = []
        self.counts: dict[str, int] = {}

    def record(
        self,
        expression: SExpr,
        *,
        disposition: DiagnosticDisposition,
        reason: str,
        path: str | None = None,
    ) -> None:
        expression_head = head(expression) or "atom"
        occurrence = self.counts.get(expression_head, 0)
        self.counts[expression_head] = occurrence + 1
        body = canonical_text(expression)
        self.items.append(
            ProjectDiagnostic(
                "schematic",
                path or f"$.{expression_head}[{occurrence}]",
                expression_head,
                disposition,
                reason,
                body,
                hashlib.sha256(body.encode("utf-8")).hexdigest(),
            )
        )

    def manifest(self) -> ProjectDiagnostics:
        return ProjectDiagnostics(tuple(self.items)).normalized()


def _child_nodes(expression: SExpr, wanted: str) -> tuple[tuple[SExpr, ...], ...]:
    if not isinstance(expression, tuple):
        return ()
    return tuple(
        child
        for child in expression[1:]
        if isinstance(child, tuple) and head(child) == wanted
    )


def _one_child(expression: SExpr, wanted: str, label: str) -> tuple[SExpr, ...]:
    matches = _child_nodes(expression, wanted)
    if len(matches) != 1:
        raise ProjectInvariantError(f"{label} requires exactly one {wanted} expression")
    return matches[0]


def _optional_child(expression: SExpr, wanted: str, label: str) -> tuple[SExpr, ...] | None:
    matches = _child_nodes(expression, wanted)
    if len(matches) > 1:
        raise ProjectInvariantError(f"{label} permits at most one {wanted} expression")
    return matches[0] if matches else None


def _scalar_child(expression: SExpr, wanted: str, label: str) -> str:
    child = _one_child(expression, wanted, label)
    if len(child) != 2:
        raise ProjectInvariantError(f"{label} {wanted} must carry exactly one scalar")
    try:
        return scalar_text(child[1], label=f"{label} {wanted}")
    except Exception as exc:
        raise ProjectInvariantError(f"{label} {wanted} must be scalar") from exc


def _first_scalar(expression: tuple[SExpr, ...], label: str, index: int = 1) -> str:
    if len(expression) <= index:
        raise ProjectInvariantError(f"{label} is missing scalar attribute {index}")
    try:
        return scalar_text(expression[index], label=label)
    except Exception as exc:
        raise ProjectInvariantError(f"{label} attribute must be scalar") from exc


def _integer_text(text: str, label: str) -> int:
    if _INTEGER.fullmatch(text) is None:
        raise ProjectInvariantError(f"{label} must be an integer")
    return int(text)


def _scaled_decimal(text: str, label: str, scale: int) -> int:
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise ProjectInvariantError(f"{label} must be a decimal number") from exc
    if not value.is_finite():
        raise ProjectInvariantError(f"{label} must be finite")
    scaled = value * scale
    if scaled != scaled.to_integral_value():
        raise ProjectInvariantError(f"{label} is below the exact integer-unit resolution")
    result = int(scaled)
    if not -(1 << 63) <= result <= (1 << 63) - 1:
        raise ProjectInvariantError(f"{label} exceeds signed 64-bit range")
    return result


def _nm(text: str, label: str) -> int:
    return _scaled_decimal(text, label, 1_000_000)


def _angle(text: str, label: str) -> int:
    value = _scaled_decimal(text, label, 1_000_000)
    if value < 0 or value >= 360_000_000:
        raise ProjectInvariantError(f"{label} must be normalized into [0, 360) degrees")
    return value


def _point_child(expression: SExpr, wanted: str, label: str) -> tuple[PointNm, int]:
    child = _one_child(expression, wanted, label)
    if len(child) not in {3, 4}:
        raise ProjectInvariantError(f"{label} {wanted} requires x, y, and optional angle")
    x = _nm(_first_scalar(child, f"{label} x", 1), f"{label} x")
    y = _nm(_first_scalar(child, f"{label} y", 2), f"{label} y")
    rotation = _angle(_first_scalar(child, f"{label} angle", 3), f"{label} angle") \
        if len(child) == 4 else 0
    return PointNm(x, y), rotation


def _xy(expression: SExpr, label: str) -> PointNm:
    if not isinstance(expression, tuple) or head(expression) != "xy" or len(expression) != 3:
        raise ProjectInvariantError(f"{label} must be (xy X Y)")
    return PointNm(
        _nm(_first_scalar(expression, f"{label} x", 1), f"{label} x"),
        _nm(_first_scalar(expression, f"{label} y", 2), f"{label} y"),
    )


def _major_version(value: str) -> int | None:
    match = re.fullmatch(r"([0-9]+)(?:\.[0-9]+)*(?:[-+][A-Za-z0-9.-]+)?", value)
    return int(match.group(1)) if match is not None else None


def _transform(local: PointNm, origin: PointNm, rotation_udeg: int) -> PointNm:
    if rotation_udeg % 90_000_000:
        raise ProjectInvariantError(
            "supported schematic symbols require an integer quarter-turn rotation"
        )
    quarter = rotation_udeg // 90_000_000
    # Embedded-library coordinates are Cartesian (positive Y is up), while
    # schematic-sheet coordinates have positive Y down.  KiCad applies the
    # placed-symbol angle after that local-to-sheet reflection.  Keeping the
    # four exact integer matrices explicit avoids lossy trigonometry at nm
    # resolution.
    x, y = local.x, -local.y
    transformed = ((x, y), (y, -x), (-x, -y), (-y, x))[quarter]
    return PointNm(origin.x + transformed[0], origin.y + transformed[1])


def _parse_library_symbols(
    expression: tuple[SExpr, ...], recorder: _Recorder
) -> tuple[LibrarySymbol, ...]:
    result: list[LibrarySymbol] = []
    for definition_index, definition in enumerate(expression[1:]):
        if not isinstance(definition, tuple) or head(definition) != "symbol":
            recorder.record(
                definition,
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason="lib_symbols may contain only symbol definitions in this subset",
                path=f"$.lib_symbols[0].child[{definition_index}]",
            )
            continue
        library_id = _first_scalar(definition, "library symbol ID")
        if _child_nodes(definition, "extends"):
            recorder.record(
                definition,
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason="inherited library symbols are not flattened or guessed",
                path=f"$.lib_symbols[0].symbol[{definition_index}]",
            )
            continue
        pins: list[LibraryPin] = []

        def visit(
            container: tuple[SExpr, ...],
            unit: int | None,
            *,
            definition_index: int = definition_index,
            pins: list[LibraryPin] = pins,
        ) -> None:
            for child in container[1:]:
                if not isinstance(child, tuple):
                    continue
                child_head = head(child)
                if child_head == "symbol":
                    nested_name = _first_scalar(child, "nested symbol name")
                    match = _UNIT_SUFFIX.search(nested_name)
                    nested_unit = int(match.group(1)) if match is not None else unit
                    visit(child, nested_unit)
                    continue
                if child_head != "pin":
                    continue
                if unit is None or unit <= 0:
                    recorder.record(
                        child,
                        disposition=DiagnosticDisposition.UNSUPPORTED,
                        reason="library pins must belong to an explicit positive symbol unit",
                        path=(
                            f"$.lib_symbols[0].symbol[{definition_index}]."
                            f"pin_ambiguous_unit[{len(pins)}]"
                        ),
                    )
                    continue
                if len(child) < 3:
                    raise ProjectInvariantError("library pin requires electrical and graphic types")
                electrical_type = _first_scalar(child, "library pin electrical type", 1)
                position, rotation = _point_child(child, "at", "library pin")
                name_expression = _one_child(child, "name", "library pin")
                number_expression = _one_child(child, "number", "library pin")
                name = _first_scalar(name_expression, "library pin name")
                number = _first_scalar(number_expression, "library pin number")
                pins.append(
                    LibraryPin(number, name, electrical_type, unit, position, rotation)
                )

        visit(definition, 1)
        result.append(
            LibrarySymbol(library_id, tuple(sorted(pins, key=lambda p: (p.unit, p.number))))
        )
    if len({item.library_id for item in result}) != len(result):
        raise ProjectInvariantError("embedded library symbol IDs must be unique")
    return tuple(sorted(result, key=lambda item: item.library_id))


def _parse_symbol(
    expression: tuple[SExpr, ...],
    libraries: dict[str, LibrarySymbol],
    recorder: _Recorder,
    index: int,
) -> SchematicSymbol | None:
    library_id = _scalar_child(expression, "lib_id", "schematic symbol")
    unsupported_reason: str | None = None
    if library_id.casefold().startswith("power:"):
        unsupported_reason = "implicit power-symbol net naming is not modeled"
    elif _child_nodes(expression, "mirror"):
        unsupported_reason = "mirrored symbol pin transforms are not modeled"
    elif library_id not in libraries:
        unsupported_reason = "placed symbol has no exact embedded library definition"
    position, rotation = _point_child(expression, "at", "schematic symbol")
    if rotation % 90_000_000:
        unsupported_reason = "non-quarter-turn symbol transforms are not modeled"
    if unsupported_reason is not None:
        recorder.record(
            expression,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason=unsupported_reason,
            path=f"$.symbol[{index}]",
        )
        return None

    symbol_id = _scalar_child(expression, "uuid", "schematic symbol")
    unit_child = _optional_child(expression, "unit", "schematic symbol")
    unit = 1 if unit_child is None else _integer_text(
        _first_scalar(unit_child, "schematic symbol unit"), "schematic symbol unit"
    )
    if unit < 1:
        raise ProjectInvariantError("schematic symbol unit must be positive")
    properties: dict[str, str] = {}
    for prop in _child_nodes(expression, "property"):
        if len(prop) < 3:
            raise ProjectInvariantError("schematic symbol property requires name and value")
        name = _first_scalar(prop, "schematic symbol property name", 1)
        value = _first_scalar(prop, "schematic symbol property value", 2)
        if name in properties:
            raise ProjectInvariantError(f"duplicate schematic symbol property {name!r}")
        properties[name] = value
    if "Reference" not in properties or "Value" not in properties:
        raise ProjectInvariantError("schematic symbol requires Reference and Value properties")

    placed_pin_ids: dict[str, str] = {}
    for pin in _child_nodes(expression, "pin"):
        number = _first_scalar(pin, "placed pin number")
        pin_id = _scalar_child(pin, "uuid", "placed pin")
        if number in placed_pin_ids:
            raise ProjectInvariantError("placed symbol pin numbers must be unique")
        placed_pin_ids[number] = pin_id
    definitions = tuple(pin for pin in libraries[library_id].pins if pin.unit == unit)
    if not definitions:
        raise ProjectInvariantError("placed symbol unit has no exact embedded pin definitions")
    if set(placed_pin_ids) != {pin.number for pin in definitions}:
        raise ProjectInvariantError(
            "placed symbol pin UUID map must exactly match embedded-library pin numbers"
        )
    pins = tuple(
        sorted(
            (
                SchematicPin(
                    placed_pin_ids[pin.number],
                    pin.number,
                    pin.name,
                    pin.electrical_type,
                    _transform(pin.position, position, rotation),
                )
                for pin in definitions
            ),
            key=lambda item: item.number,
        )
    )
    recorder.record(
        expression,
        disposition=DiagnosticDisposition.PRESERVED,
        reason=(
            "placed-symbol presentation, properties, and instance records are retained "
            "verbatim while identity and pins are modeled"
        ),
        path=f"$.symbol[{index}]",
    )
    return SchematicSymbol(
        symbol_id,
        library_id,
        properties["Reference"],
        properties["Value"],
        properties.get("Footprint", ""),
        position,
        rotation,
        unit,
        pins,
    )


def _parse_wire(expression: tuple[SExpr, ...]) -> SchematicWire:
    points = _one_child(expression, "pts", "wire")
    vertices = tuple(_xy(item, "wire point") for item in points[1:])
    if len(vertices) != 2:
        raise ProjectInvariantError("supported wire requires exactly two endpoints")
    stroke = _one_child(expression, "stroke", "wire")
    width = _nm(_scalar_child(stroke, "width", "wire stroke"), "wire width")
    if width < 0:
        raise ProjectInvariantError("wire width must be non-negative")
    stroke_type = _scalar_child(stroke, "type", "wire stroke")
    wire_id = _scalar_child(expression, "uuid", "wire")
    return SchematicWire(wire_id, vertices[0], vertices[1], width, stroke_type)


def _parse_junction(expression: tuple[SExpr, ...]) -> SchematicJunction:
    position, rotation = _point_child(expression, "at", "junction")
    if rotation:
        raise ProjectInvariantError("junction position cannot carry rotation")
    diameter = _nm(_scalar_child(expression, "diameter", "junction"), "junction diameter")
    if diameter < 0:
        raise ProjectInvariantError("junction diameter must be non-negative")
    color = _one_child(expression, "color", "junction")
    if len(color) != 5:
        raise ProjectInvariantError("junction color requires RGBA channels")
    channels = tuple(
        _integer_text(_first_scalar(color, "junction color", index), "junction color")
        for index in range(1, 5)
    )
    if any(not 0 <= value <= 255 for value in channels):
        raise ProjectInvariantError("junction color channels must be in 0..255")
    junction_id = _scalar_child(expression, "uuid", "junction")
    return SchematicJunction(junction_id, position, diameter, channels)  # type: ignore[arg-type]


def _parse_label(expression: tuple[SExpr, ...], kind: LabelKind) -> SchematicLabel:
    name = _first_scalar(expression, "schematic label")
    position, rotation = _point_child(expression, "at", "schematic label")
    label_id = _scalar_child(expression, "uuid", "schematic label")
    return SchematicLabel(label_id, kind, name, position, rotation)


def _parse_no_connect(expression: tuple[SExpr, ...]) -> SchematicNoConnect:
    position, rotation = _point_child(expression, "at", "no-connect marker")
    if rotation:
        raise ProjectInvariantError("no-connect position cannot carry rotation")
    return SchematicNoConnect(
        _scalar_child(expression, "uuid", "no-connect marker"), position
    )


def _orientation(a: PointNm, b: PointNm, c: PointNm) -> int:
    value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    return (value > 0) - (value < 0)


def _on_segment(a: PointNm, b: PointNm, point: PointNm) -> bool:
    return (
        _orientation(a, b, point) == 0
        and min(a.x, b.x) <= point.x <= max(a.x, b.x)
        and min(a.y, b.y) <= point.y <= max(a.y, b.y)
    )


def _segments_intersect(first: SchematicWire, second: SchematicWire) -> bool:
    a, b, c, d = first.start, first.end, second.start, second.end
    orientations = (
        _orientation(a, b, c),
        _orientation(a, b, d),
        _orientation(c, d, a),
        _orientation(c, d, b),
    )
    if orientations[0] != orientations[1] and orientations[2] != orientations[3]:
        return True
    return (
        (orientations[0] == 0 and _on_segment(a, b, c))
        or (orientations[1] == 0 and _on_segment(a, b, d))
        or (orientations[2] == 0 and _on_segment(c, d, a))
        or (orientations[3] == 0 and _on_segment(c, d, b))
    )


class _DisjointSet:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, item: int) -> int:
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, first: int, second: int) -> None:
        a, b = self.find(first), self.find(second)
        if a != b:
            self.parent[max(a, b)] = min(a, b)


def _resolve_nets(
    symbols: tuple[SchematicSymbol, ...],
    wires: tuple[SchematicWire, ...],
    junctions: tuple[SchematicJunction, ...],
    labels: tuple[SchematicLabel, ...],
    no_connects: tuple[SchematicNoConnect, ...],
) -> tuple[SchematicNet, ...]:
    for first_index, first in enumerate(wires):
        for second in wires[first_index + 1 :]:
            shared = {first.start, first.end} & {second.start, second.end}
            if _segments_intersect(first, second) and not shared:
                raise ProjectInvariantError(
                    "wire crossings, overlaps, and mid-segment joins must be explicitly split "
                    "into endpoint segments before deterministic connectivity import"
                )

    points = {
        *(wire.start for wire in wires),
        *(wire.end for wire in wires),
        *(junction.position for junction in junctions),
        *(label.position for label in labels),
        *(marker.position for marker in no_connects),
        *(pin.position for symbol in symbols for pin in symbol.pins),
    }
    ordered_points = tuple(sorted(points))
    point_index = {point: index for index, point in enumerate(ordered_points)}
    dsu = _DisjointSet(len(ordered_points))
    incident: dict[PointNm, set[str]] = {}
    for wire in wires:
        dsu.union(point_index[wire.start], point_index[wire.end])
        incident.setdefault(wire.start, set()).add(wire.wire_id)
        incident.setdefault(wire.end, set()).add(wire.wire_id)

    junction_by_point = {item.position: item for item in junctions}
    if len(junction_by_point) != len(junctions):
        raise ProjectInvariantError("junction positions must be unique")
    for junction in junctions:
        if junction.position not in incident or len(incident[junction.position]) < 2:
            raise ProjectInvariantError("junctions must coincide with at least two wire endpoints")
    for point, wire_ids in incident.items():
        if len(wire_ids) >= 3 and point not in junction_by_point:
            raise ProjectInvariantError(
                "three-or-more-way wire joins require an explicit junction marker"
            )

    pins_by_point: dict[PointNm, list[SchematicPinRef]] = {}
    for symbol in symbols:
        for pin in symbol.pins:
            pins_by_point.setdefault(pin.position, []).append(
                SchematicPinRef(symbol.symbol_id, pin.pin_id, pin.number)
            )
    labels_by_point: dict[PointNm, list[SchematicLabel]] = {}
    for label in labels:
        labels_by_point.setdefault(label.position, []).append(label)
        if label.position not in incident and label.position not in pins_by_point:
            raise ProjectInvariantError("labels must anchor to a wire endpoint or symbol pin")

    no_connect_points: set[PointNm] = set()
    for marker in no_connects:
        if marker.position in no_connect_points:
            raise ProjectInvariantError("no-connect marker positions must be unique")
        no_connect_points.add(marker.position)
        if len(pins_by_point.get(marker.position, ())) != 1:
            raise ProjectInvariantError(
                "no-connect marker must coincide with exactly one symbol pin"
            )
        if (
            marker.position in incident
            or marker.position in labels_by_point
            or marker.position in junction_by_point
        ):
            raise ProjectInvariantError("no-connect marker cannot share electrical connectivity")

    first_label_point: dict[str, PointNm] = {}
    for label in sorted(labels, key=lambda item: item.label_id):
        if label.name in first_label_point:
            dsu.union(point_index[first_label_point[label.name]], point_index[label.position])
        else:
            first_label_point[label.name] = label.position

    groups: dict[int, set[PointNm]] = {}
    for point in ordered_points:
        groups.setdefault(dsu.find(point_index[point]), set()).add(point)
    nets: list[SchematicNet] = []
    for group_points in groups.values():
        if group_points & no_connect_points:
            continue
        wire_ids = tuple(
            sorted(
                wire.wire_id
                for wire in wires
                if wire.start in group_points or wire.end in group_points
            )
        )
        group_labels = tuple(
            sorted(
                (label for label in labels if label.position in group_points),
                key=lambda item: item.label_id,
            )
        )
        pin_refs = tuple(
            sorted(
                ref
                for point in group_points
                for ref in pins_by_point.get(point, ())
            )
        )
        if not wire_ids and not group_labels and len(pin_refs) < 2:
            continue
        names = {label.name for label in group_labels}
        if len(names) > 1:
            raise ProjectInvariantError(
                "one connected schematic component cannot carry conflicting net labels"
            )
        name = next(iter(names)) if names else None
        junction_ids = tuple(
            sorted(
                junction.junction_id
                for junction in junctions
                if junction.position in group_points
            )
        )
        label_ids = tuple(item.label_id for item in group_labels)
        if name is not None:
            net_id = canonical_net_id(name)
        else:
            digest = stable_hash(
                {
                    "wire_ids": wire_ids,
                    "junction_ids": junction_ids,
                    "pin_refs": pin_refs,
                },
                domain="flux-clone-kicad-unnamed-schematic-net-v1",
            )
            net_id = f"net-unnamed-{digest[:16]}"
        nets.append(
            SchematicNet(net_id, name, wire_ids, junction_ids, label_ids, pin_refs)
        )
    if len({item.net_id for item in nets}) != len(nets):
        raise ProjectInvariantError("resolved schematic net IDs must be unique")
    return tuple(sorted(nets, key=lambda item: item.net_id))


def _validate_root_sheet_instances(expression: tuple[SExpr, ...]) -> None:
    paths = _child_nodes(expression, "path")
    if len(paths) != 1 or _first_scalar(paths[0], "root sheet instance path") != "/":
        raise ProjectInvariantError(
            "supported single-sheet schematic requires one root sheet instance path '/'"
        )
    page = _scalar_child(paths[0], "page", "root sheet instance")
    if not page:
        raise ProjectInvariantError("root sheet page must be non-empty")


def parse_schematic(payload: bytes, *, limits: BundleLimits) -> Schematic:
    """Parse a bounded, single-sheet KiCad 10 schematic without invoking KiCad."""

    if not isinstance(payload, bytes):
        raise TypeError("schematic payload must be bytes")
    if len(payload) > limits.maximum_schematic_bytes:
        raise ProjectSyntaxError(
            f"schematic exceeds the {limits.maximum_schematic_bytes}-byte limit"
        )
    try:
        root = parse(
            payload,
            limits=ParseLimits(
                maximum_bytes=limits.maximum_schematic_bytes,
                maximum_tokens=limits.maximum_schematic_tokens,
                maximum_depth=limits.maximum_schematic_depth,
                maximum_atom_characters=limits.maximum_atom_characters,
            ),
        )
    except Exception as exc:
        if isinstance(exc, ProjectInvariantError):
            raise
        raise ProjectSyntaxError("schematic is not a bounded KiCad S-expression") from exc
    if not isinstance(root, tuple) or head(root) != "kicad_sch":
        raise ProjectSyntaxError("schematic root must be '(kicad_sch ...)' ")

    version_text = _scalar_child(root, "version", "schematic root")
    version = _integer_text(version_text, "schematic format version")
    if version not in _KNOWN_KICAD_10_SCHEMATIC_VERSIONS:
        raise ProjectInvariantError(
            "schematic version is not one of the explicitly reviewed KiCad 10 formats: "
            + ", ".join(str(item) for item in sorted(_KNOWN_KICAD_10_SCHEMATIC_VERSIONS))
        )
    generator = _scalar_child(root, "generator", "schematic root")
    generator_version = _scalar_child(root, "generator_version", "schematic root")
    if _major_version(generator_version) != 10:
        raise ProjectInvariantError("schematic must declare generator_version 10.x")
    schematic_id = _scalar_child(root, "uuid", "schematic root")
    library_expression = _one_child(root, "lib_symbols", "schematic root")

    recorder = _Recorder()
    recorder.record(
        library_expression,
        disposition=DiagnosticDisposition.PRESERVED,
        reason=(
            "embedded symbol graphics and presentation are retained exactly while pin "
            "definitions are modeled"
        ),
        path="$.lib_symbols[0]",
    )
    library_symbols = _parse_library_symbols(library_expression, recorder)
    libraries = {item.library_id: item for item in library_symbols}
    symbols: list[SchematicSymbol] = []
    wires: list[SchematicWire] = []
    junctions: list[SchematicJunction] = []
    labels: list[SchematicLabel] = []
    no_connects: list[SchematicNoConnect] = []

    headers = {"version", "generator", "generator_version", "uuid", "lib_symbols"}
    presentation_heads = {
        "paper",
        "title_block",
        "text",
        "text_box",
        "polyline",
        "rectangle",
        "circle",
        "arc",
        "image",
        "group",
        "embedded_fonts",
    }
    unsupported_heads = {
        "bus_alias",
        "bus",
        "bus_entry",
        "hierarchical_label",
        "sheet",
        "rule_area",
        "netclass_flag",
        "directive_label",
        "symbol_instances",
    }
    occurrence: dict[str, int] = {}
    for expression in root[1:]:
        expression_head = head(expression)
        if expression_head in headers:
            continue
        name = expression_head or "atom"
        index = occurrence.get(name, 0)
        occurrence[name] = index + 1
        if not isinstance(expression, tuple):
            recorder.record(
                expression,
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason="schematic root atoms outside a named expression are not modeled",
                path=f"$.atom[{index}]",
            )
        elif expression_head == "symbol":
            parsed_symbol = _parse_symbol(expression, libraries, recorder, index)
            if parsed_symbol is not None:
                symbols.append(parsed_symbol)
        elif expression_head == "wire":
            wires.append(_parse_wire(expression))
        elif expression_head == "junction":
            junctions.append(_parse_junction(expression))
        elif expression_head == "no_connect":
            no_connects.append(_parse_no_connect(expression))
        elif expression_head == "label":
            labels.append(_parse_label(expression, LabelKind.LOCAL))
            recorder.record(
                expression,
                disposition=DiagnosticDisposition.PRESERVED,
                reason="label text effects are retained while label connectivity is modeled",
                path=f"$.label[{index}]",
            )
        elif expression_head == "global_label":
            labels.append(_parse_label(expression, LabelKind.GLOBAL))
            recorder.record(
                expression,
                disposition=DiagnosticDisposition.PRESERVED,
                reason=(
                    "global-label shape and text effects are retained while connectivity is modeled"
                ),
                path=f"$.global_label[{index}]",
            )
        elif expression_head == "sheet_instances":
            _validate_root_sheet_instances(expression)
            recorder.record(
                expression,
                disposition=DiagnosticDisposition.PRESERVED,
                reason="single root-sheet page metadata is retained exactly",
                path=f"$.sheet_instances[{index}]",
            )
        elif expression_head in presentation_heads:
            recorder.record(
                expression,
                disposition=DiagnosticDisposition.PRESERVED,
                reason="presentation-only schematic construct is retained exactly",
                path=f"$.{name}[{index}]",
            )
        elif expression_head in unsupported_heads:
            recorder.record(
                expression,
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason=(
                    "hierarchy, buses, rule areas, directives, and legacy instance tables can "
                    "change electrical meaning and are not flattened"
                ),
                path=f"$.{name}[{index}]",
            )
        else:
            recorder.record(
                expression,
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason="unknown schematic root construct is not silently ignored",
                path=f"$.{name}[{index}]",
            )

    typed_symbols = tuple(sorted(symbols, key=lambda item: item.symbol_id))
    typed_wires = tuple(sorted(wires, key=lambda item: item.wire_id))
    typed_junctions = tuple(sorted(junctions, key=lambda item: item.junction_id))
    typed_labels = tuple(sorted(labels, key=lambda item: item.label_id))
    typed_no_connects = tuple(sorted(no_connects, key=lambda item: item.marker_id))
    nets = _resolve_nets(
        typed_symbols,
        typed_wires,
        typed_junctions,
        typed_labels,
        typed_no_connects,
    )
    return Schematic(
        version,
        generator,
        generator_version,
        schematic_id,
        library_symbols,
        typed_symbols,
        typed_wires,
        typed_junctions,
        typed_labels,
        typed_no_connects,
        nets,
        recorder.manifest(),
    )


def _unit_text(value: int, scale: int = 1_000_000) -> str:
    negative = value < 0
    absolute = abs(value)
    whole, remainder = divmod(absolute, scale)
    if remainder:
        fraction = f"{remainder:0{len(str(scale)) - 1}d}".rstrip("0")
        result = f"{whole}.{fraction}"
    else:
        result = str(whole)
    return "-" + result if negative else result


def _at(position: PointNm, rotation_udeg: int | None = None) -> tuple[SExpr, ...]:
    values: list[SExpr] = [atom(_unit_text(position.x)), atom(_unit_text(position.y))]
    if rotation_udeg is not None:
        values.append(atom(_unit_text(rotation_udeg)))
    return node("at", *values)


def _retained_expressions(schematic: Schematic) -> tuple[tuple[SExpr, ...], ...]:
    result: list[tuple[str, tuple[SExpr, ...]]] = []
    for item in schematic.diagnostics.normalized().constructs:
        if item.artifact != "schematic":
            continue
        try:
            expression = parse(item.canonical_payload.encode("utf-8"))
        except Exception as exc:
            raise ProjectInvariantError(
                "retained schematic expression is no longer parseable"
            ) from exc
        if not isinstance(expression, tuple):
            raise ProjectInvariantError("retained root construct must be an S-expression list")
        result.append((item.path, expression))
    priority = {
        "paper": 10,
        "title_block": 11,
        "lib_symbols": 20,
        "text": 30,
        "text_box": 31,
        "polyline": 32,
        "rectangle": 33,
        "circle": 34,
        "arc": 35,
        "image": 36,
        "group": 37,
        "label": 60,
        "global_label": 61,
        "symbol": 70,
        "bus_alias": 80,
        "bus": 81,
        "bus_entry": 82,
        "hierarchical_label": 83,
        "sheet": 84,
        "rule_area": 85,
        "netclass_flag": 86,
        "directive_label": 87,
        "symbol_instances": 88,
        "sheet_instances": 90,
        "embedded_fonts": 91,
    }
    return tuple(
        expression
        for _, expression in sorted(
            result,
            key=lambda pair: (
                priority.get(head(pair[1]) or "", 89),
                _retained_path_sort_key(pair[0]),
                canonical_text(pair[1]),
            ),
        )
    )


def _retained_path_sort_key(path: str) -> tuple[str, int, str]:
    """Sort recorder paths by numeric occurrence, never lexicographic digits."""

    prefix, separator, suffix = path.rpartition("[")
    if separator and suffix.endswith("]") and suffix[:-1].isdigit():
        return prefix, int(suffix[:-1]), ""
    return path, -1, path


def render_schematic(schematic: Schematic) -> bytes:
    """Render deterministic supported geometry plus digest-bound retained expressions."""

    if not isinstance(schematic, Schematic):
        raise TypeError("schematic must be Schematic")
    retained = _retained_expressions(schematic)
    early = tuple(item for item in retained if (head(item) or "") not in {
        "label", "global_label", "symbol", "sheet_instances", "embedded_fonts",
        "bus_alias", "bus", "bus_entry", "hierarchical_label", "sheet", "rule_area",
        "netclass_flag", "directive_label", "symbol_instances",
    })
    labels = tuple(item for item in retained if head(item) in {"label", "global_label"})
    symbols = tuple(item for item in retained if head(item) == "symbol")
    unsupported = tuple(item for item in retained if head(item) in {
        "bus_alias", "bus", "bus_entry", "hierarchical_label", "sheet", "rule_area",
        "netclass_flag", "directive_label", "symbol_instances",
    })
    tail = tuple(item for item in retained if head(item) in {"sheet_instances", "embedded_fonts"})

    junction_expressions = tuple(
        node(
            "junction",
            _at(item.position),
            node("diameter", atom(_unit_text(item.diameter_nm))),
            node("color", *(atom(value) for value in item.color_rgba)),
            node("uuid", quoted(item.junction_id)),
        )
        for item in schematic.junctions
    )
    no_connect_expressions = tuple(
        node("no_connect", _at(item.position), node("uuid", quoted(item.marker_id)))
        for item in schematic.no_connects
    )
    wire_expressions = tuple(
        node(
            "wire",
            node(
                "pts",
                node("xy", atom(_unit_text(item.start.x)), atom(_unit_text(item.start.y))),
                node("xy", atom(_unit_text(item.end.x)), atom(_unit_text(item.end.y))),
            ),
            node(
                "stroke",
                node("width", atom(_unit_text(item.width_nm))),
                node("type", atom(item.stroke_type)),
            ),
            node("uuid", quoted(item.wire_id)),
        )
        for item in schematic.wires
    )
    root = node(
        "kicad_sch",
        node("version", atom(schematic.format_version)),
        node("generator", atom("flux_clone")),
        node("generator_version", quoted("10.0")),
        node("uuid", quoted(schematic.schematic_id)),
        *early,
        *junction_expressions,
        *no_connect_expressions,
        *wire_expressions,
        *labels,
        *symbols,
        *unsupported,
        *tail,
    )
    return render(root)

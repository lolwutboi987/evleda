"""Exact R2 functional-block placement and explicit property reservation."""

from __future__ import annotations

from dataclasses import dataclass

from .catalog import SymbolCatalog
from .model import (
    A4_LANDSCAPE_HEIGHT_NM,
    A4_LANDSCAPE_WIDTH_NM,
    GRID_NM,
    ComponentPlacement,
    FunctionalBlock,
    GridEnvelope,
    GridPoint,
    HumanSchematicError,
    PinAnchor,
    PropertyRecord,
    SemanticComponent,
    SemanticGraph,
    SemanticPin,
    SheetSpec,
    SymbolTemplate,
)

R2_PROJECT_ID = "reference-usb-c-3v3-r2"
R2_PLANNER_ID = "flux-human-schematic-r2-v1"


@dataclass(frozen=True, slots=True)
class _PlacementRule:
    component_id: str
    reference: str
    expected_symbol_id: str
    block_id: str
    origin: GridPoint
    rotation_deg: int
    property_sides: tuple[str, ...]


def _rule(
    component_id: str,
    reference: str,
    expected_symbol_id: str,
    block_id: str,
    x: int,
    y: int,
    rotation_deg: int = 0,
    property_sides: tuple[str, ...] = ("east", "south", "north", "west"),
) -> _PlacementRule:
    return _PlacementRule(
        component_id,
        reference,
        expected_symbol_id,
        block_id,
        GridPoint(x, y),
        rotation_deg,
        property_sides,
    )


_RULES = tuple(
    sorted(
        (
            _rule(
                "usb-j1",
                "J1",
                "Connector_Generic:USB_C_Receptacle_USB2.0_16P",
                "usb-input",
                24,
                60,
                property_sides=("north", "south", "east", "west"),
            ),
            _rule("tvs-d1", "D1", "Device:D_TVS", "usb-input", 52, 75),
            _rule("cin-c1", "C1", "Device:C", "usb-input", 62, 75),
            _rule(
                "tp-1",
                "TP1",
                "Connector:TestPoint",
                "usb-input",
                70,
                72,
                property_sides=("north", "east", "west", "south"),
            ),
            _rule(
                "cc-r1",
                "R1",
                "Device:R",
                "usb-input",
                42,
                98,
                property_sides=("south", "east", "west", "north"),
            ),
            _rule(
                "cc-r2",
                "R2",
                "Device:R",
                "usb-input",
                54,
                98,
                property_sides=("south", "east", "west", "north"),
            ),
            _rule("dvdt-c4", "C4", "Device:C", "protection", 78, 57, 180),
            _rule("en-hi-r6", "R6", "Device:R", "protection", 80, 75),
            _rule("en-lo-r7", "R7", "Device:R", "protection", 80, 81),
            _rule(
                "efuse-u1",
                "U1",
                "Power_Management:TPS259620",
                "protection",
                94,
                66,
                property_sides=("north", "south", "east", "west"),
            ),
            _rule("ilim-r3", "R3", "Device:R", "protection", 108, 63),
            _rule("ovc-r4", "R4", "Device:R", "protection", 106, 90),
            _rule("ovc-r5", "R5", "Device:R", "protection", 106, 96),
            _rule("cldo-c2", "C2", "Device:C", "protection", 116, 75),
            _rule(
                "tp-2",
                "TP2",
                "Connector:TestPoint",
                "protection",
                124,
                72,
                property_sides=("north", "west", "east", "south"),
            ),
            _rule(
                "ldo-u2",
                "U2",
                "Regulator_Linear:LP38692",
                "regulation",
                142,
                66,
                property_sides=("north", "south", "east", "west"),
            ),
            _rule("cout-esr-r9", "R9", "Device:R", "regulation", 160, 75),
            _rule(
                "cout-c3",
                "C3",
                "Device:C_Polarized",
                "regulation",
                160,
                92,
                property_sides=("west", "south", "east", "north"),
            ),
            _rule(
                "tp-3",
                "TP3",
                "Connector:TestPoint",
                "regulation",
                170,
                72,
                property_sides=("north", "west", "east", "south"),
            ),
            _rule(
                "led-r8",
                "R8",
                "Device:R",
                "output",
                174,
                54,
                270,
                property_sides=("north", "south", "east", "west"),
            ),
            _rule(
                "led-d2",
                "D2",
                "Device:LED",
                "output",
                188,
                54,
                property_sides=("north", "south", "east", "west"),
            ),
            _rule(
                "tp-4",
                "TP4",
                "Connector:TestPoint",
                "output",
                188,
                70,
                property_sides=("south", "west", "east", "north"),
            ),
            _rule(
                "out-j2",
                "J2",
                "Connector_Generic:Conn_01x02",
                "output",
                199,
                71,
                property_sides=("south", "west", "north", "east"),
            ),
        ),
        key=lambda item: item.component_id,
    )
)


def default_sheet() -> SheetSpec:
    return SheetSpec(
        "A4",
        "landscape",
        A4_LANDSCAPE_WIDTH_NM,
        A4_LANDSCAPE_HEIGHT_NM,
        GRID_NM,
        GridEnvelope(GridPoint(8, 8), GridPoint(226, 150)),
    )


def _text_width(text: str) -> int:
    # A 1.27 mm KiCad field averages approximately 0.6 grid cells per glyph.
    # Rounding upward makes the reservation deliberately conservative.
    return max(1, (3 * len(text) + 4) // 5)


def _title_envelope(anchor: GridPoint, title: str) -> GridEnvelope:
    return GridEnvelope(anchor, GridPoint(anchor.x + _text_width(title) - 1, anchor.y))


def _blocks() -> tuple[FunctionalBlock, ...]:
    definitions = (
        (
            "usb-input",
            "USB-C DEFAULT 5 V SINK / TRANSIENT",
            GridEnvelope(GridPoint(12, 14), GridPoint(72, 118)),
            GridPoint(14, 18),
        ),
        (
            "protection",
            "EFUSE / UVLO / ILM / OVC / dVdt",
            GridEnvelope(GridPoint(74, 14), GridPoint(126, 118)),
            GridPoint(76, 18),
        ),
        (
            "regulation",
            "LP38692 / DAMPED OUTPUT CAPACITOR",
            GridEnvelope(GridPoint(128, 14), GridPoint(172, 118)),
            GridPoint(130, 18),
        ),
        (
            "output",
            "3V3 OUTPUT / INDICATION",
            GridEnvelope(GridPoint(173, 14), GridPoint(220, 118)),
            GridPoint(175, 18),
        ),
    )
    return tuple(
        sorted(
            (
                FunctionalBlock(
                    block_id,
                    title,
                    envelope,
                    anchor,
                    _title_envelope(anchor, title),
                    tuple(
                        sorted(item.component_id for item in _RULES if item.block_id == block_id)
                    ),
                )
                for block_id, title, envelope, anchor in definitions
            ),
            key=lambda item: item.block_id,
        )
    )


def _rotate_point(point: GridPoint, rotation_deg: int) -> GridPoint:
    if rotation_deg == 0:
        return point
    if rotation_deg == 90:
        return GridPoint(-point.y, point.x)
    if rotation_deg == 180:
        return GridPoint(-point.x, -point.y)
    if rotation_deg == 270:
        return GridPoint(point.y, -point.x)
    raise ValueError("symbol rotation must be a quadrant")


def _rotate_direction(direction: str, rotation_deg: int) -> str:
    cycle = ("north", "east", "south", "west")
    return cycle[(cycle.index(direction) + rotation_deg // 90) % len(cycle)]


def _absolute_point(origin: GridPoint, offset: GridPoint, rotation_deg: int) -> GridPoint:
    rotated = _rotate_point(offset, rotation_deg)
    return GridPoint(origin.x + rotated.x, origin.y + rotated.y)


def _absolute_envelope(
    origin: GridPoint, envelope: GridEnvelope, rotation_deg: int
) -> GridEnvelope:
    corners = tuple(
        _absolute_point(origin, GridPoint(x, y), rotation_deg)
        for x in (envelope.minimum.x, envelope.maximum.x)
        for y in (envelope.minimum.y, envelope.maximum.y)
    )
    return GridEnvelope(
        GridPoint(min(item.x for item in corners), min(item.y for item in corners)),
        GridPoint(max(item.x for item in corners), max(item.y for item in corners)),
    )


def _visible_candidates(
    body: GridEnvelope,
    reference: str,
    value: str,
    sides: tuple[str, ...],
) -> tuple[tuple[GridEnvelope, GridEnvelope], ...]:
    reference_width = _text_width(reference)
    value_width = _text_width(value)
    candidates: list[tuple[GridEnvelope, GridEnvelope]] = []
    for distance in range(2, 33):
        for side in sides:
            if side == "north":
                reference_anchor = GridPoint(body.minimum.x, body.minimum.y - distance - 2)
                value_anchor = GridPoint(body.minimum.x, body.minimum.y - distance)
            elif side == "south":
                reference_anchor = GridPoint(body.minimum.x, body.maximum.y + distance)
                value_anchor = GridPoint(body.minimum.x, body.maximum.y + distance + 2)
            elif side == "east":
                reference_anchor = GridPoint(body.maximum.x + distance, body.minimum.y)
                value_anchor = GridPoint(body.maximum.x + distance, body.minimum.y + 2)
            elif side == "west":
                reference_anchor = GridPoint(
                    body.minimum.x - distance - reference_width, body.minimum.y
                )
                value_anchor = GridPoint(
                    body.minimum.x - distance - value_width, body.minimum.y + 2
                )
            else:
                raise ValueError("property side must be cardinal")
            candidates.append(
                (
                    GridEnvelope(
                        reference_anchor,
                        GridPoint(reference_anchor.x + reference_width - 1, reference_anchor.y),
                    ),
                    GridEnvelope(
                        value_anchor,
                        GridPoint(value_anchor.x + value_width - 1, value_anchor.y),
                    ),
                )
            )
    return tuple(candidates)


def _inside(outer: GridEnvelope, inner: GridEnvelope) -> bool:
    return outer.contains(inner.minimum) and outer.contains(inner.maximum)


def _properties(
    component: SemanticComponent,
    template: SymbolTemplate,
    origin: GridPoint,
    body: GridEnvelope,
    sides: tuple[str, ...],
    content: GridEnvelope,
    occupied: list[GridEnvelope],
) -> tuple[PropertyRecord, ...]:
    visible_pair: tuple[GridEnvelope, GridEnvelope] | None = None
    for candidate in _visible_candidates(body, component.reference, component.value, sides):
        reference_envelope, value_envelope = candidate
        if not _inside(content, reference_envelope) or not _inside(content, value_envelope):
            continue
        if reference_envelope.intersects(value_envelope):
            continue
        if any(
            reference_envelope.intersects(item) or value_envelope.intersects(item)
            for item in occupied
        ):
            continue
        visible_pair = candidate
        break
    if visible_pair is None:
        raise HumanSchematicError(
            "human-property-envelope-unavailable",
            component.component_id,
            "no explicit Reference/Value field pair fits the reviewed A4 placement",
        )
    reference_envelope, value_envelope = visible_pair
    occupied.extend((reference_envelope, value_envelope))
    hidden_values = {
        "CanonicalComponentId": component.component_id,
        "CanonicalPinMapSha256": component.pin_map_sha256,
        "Datasheet": f"urn:sha256:{component.datasheet_sha256}",
        "DatasheetSha256": component.datasheet_sha256,
        "Description": (f"{component.package}; exact MPN {component.manufacturer_part_number}"),
        "Footprint": component.footprint_id,
        "ManufacturerPartNumber": component.manufacturer_part_number,
    }
    records = [
        PropertyRecord(
            f"property:{component.component_id}:Reference",
            component.component_id,
            "Reference",
            component.reference,
            True,
            component.component_digest,
            template.template_digest,
            reference_envelope.minimum,
            reference_envelope,
        ),
        PropertyRecord(
            f"property:{component.component_id}:Value",
            component.component_id,
            "Value",
            component.value,
            True,
            component.component_digest,
            template.template_digest,
            value_envelope.minimum,
            value_envelope,
        ),
    ]
    records.extend(
        PropertyRecord(
            f"property:{component.component_id}:{name}",
            component.component_id,
            name,
            value,
            False,
            component.component_digest,
            template.template_digest,
            origin,
            GridEnvelope(origin, origin),
        )
        for name, value in hidden_values.items()
    )
    return tuple(sorted(records, key=lambda item: item.name))


def _provisional_placement(
    component: SemanticComponent,
    rule: _PlacementRule,
    template: SymbolTemplate,
) -> ComponentPlacement:
    definition_index = {item.number: item for item in component.pin_definitions}
    anchors = tuple(
        sorted(
            (
                PinAnchor(
                    SemanticPin(component.component_id, port.logical_number),
                    f"anchor:{component.component_id}:{port.logical_number}",
                    definition_index[port.logical_number],
                    port.emitted_number,
                    port.electrical_type,
                    template.template_digest,
                    _absolute_point(rule.origin, port.offset, rule.rotation_deg),
                    _rotate_direction(port.direction, rule.rotation_deg),
                )
                for port in template.pin_ports
            ),
            key=lambda item: item.pin.pin_number,
        )
    )
    return ComponentPlacement(
        f"symbol:{component.component_id}",
        component.component_id,
        component.reference,
        rule.block_id,
        template.profile_id,
        component.component_digest,
        template.template_digest,
        rule.origin,
        rule.rotation_deg,
        _absolute_envelope(rule.origin, template.body, rule.rotation_deg),
        anchors,
        (),
    )


def place_r2_components(
    semantic_graph: SemanticGraph,
    catalog: SymbolCatalog,
    sheet: SheetSpec,
) -> tuple[tuple[FunctionalBlock, ...], tuple[ComponentPlacement, ...]]:
    """Place the exact R2 semantic graph, then reserve every visible property."""

    if type(semantic_graph) is not SemanticGraph:
        raise TypeError("R2 placement requires an exact SemanticGraph")
    if type(catalog) is not SymbolCatalog or type(sheet) is not SheetSpec:
        raise TypeError("R2 placement requires exact catalog and sheet values")
    if semantic_graph.project_id != R2_PROJECT_ID:
        raise HumanSchematicError(
            "human-layout-profile-required",
            semantic_graph.project_id,
            f"this placement core is reviewed only for {R2_PROJECT_ID}",
        )
    component_index = {item.component_id: item for item in semantic_graph.components}
    rule_index = {item.component_id: item for item in _RULES}
    if set(component_index) != set(rule_index):
        raise HumanSchematicError(
            "human-layout-profile-required",
            semantic_graph.project_id,
            "component population differs from the exact 23-component R2 profile",
        )
    blocks = _blocks()
    block_index = {item.block_id: item for item in blocks}
    provisionals: list[ComponentPlacement] = []
    for component_id in sorted(component_index):
        component = component_index[component_id]
        rule = rule_index[component_id]
        template = catalog.resolve(component)
        if component.reference != rule.reference or component.symbol_id != rule.expected_symbol_id:
            raise HumanSchematicError(
                "human-component-profile-mismatch",
                component_id,
                "reference or graph symbol differs from the reviewed R2 placement profile",
            )
        placement = _provisional_placement(component, rule, template)
        block = block_index[placement.block_id]
        if not _inside(block.envelope, placement.body):
            raise HumanSchematicError(
                "human-component-outside-functional-block",
                component_id,
                "real-symbol body does not fit its reviewed functional block",
            )
        provisionals.append(placement)

    bodies = [item.body for item in provisionals]
    for first_index, first in enumerate(bodies):
        if any(first.intersects(second) for second in bodies[first_index + 1 :]):
            raise HumanSchematicError(
                "human-component-body-overlap",
                semantic_graph.project_id,
                "reviewed R2 symbol body envelopes overlap",
            )
    occupied = bodies + [item.title_envelope for item in blocks]
    # Keep visible properties away from the left-to-right power-flow corridor.
    occupied.append(GridEnvelope(GridPoint(32, 71), GridPoint(202, 73)))
    occupied.extend(
        GridEnvelope(anchor.position, anchor.position)
        for placement in provisionals
        for anchor in placement.pin_anchors
    )
    placement_index = {item.component_id: item for item in provisionals}
    placements: list[ComponentPlacement] = []
    for component_id in sorted(component_index):
        component = component_index[component_id]
        rule = rule_index[component_id]
        provisional = placement_index[component_id]
        placements.append(
            ComponentPlacement(
                provisional.semantic_id,
                provisional.component_id,
                provisional.reference,
                provisional.block_id,
                provisional.symbol_profile_id,
                provisional.component_digest,
                provisional.symbol_template_digest,
                provisional.origin,
                provisional.rotation_deg,
                provisional.body,
                provisional.pin_anchors,
                _properties(
                    component,
                    catalog.resolve(component),
                    provisional.origin,
                    provisional.body,
                    rule.property_sides,
                    sheet.content,
                    occupied,
                ),
            )
        )
    return blocks, tuple(placements)


__all__ = (
    "R2_PLANNER_ID",
    "R2_PROJECT_ID",
    "default_sheet",
    "place_r2_components",
)

"""Deterministic geometric design-rule checks."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

from .geometry import (
    ExactPoint,
    exact_point,
    exact_point_in_outline,
    exact_point_segment_distance_squared,
    exact_segment_distance_squared,
    exact_segments_intersect,
    minimum_outlines_distance_squared,
    outline_defects,
    outlines_overlap,
)
from .model import (
    BoardGraph,
    BoardOutline,
    EntityRef,
    EvidenceItem,
    Hole,
    PadShape,
    ParameterSpec,
    ParameterType,
    PhysicalPad,
    RuleDefinition,
    RuleDomain,
    Severity,
    Zone,
    ZoneFillState,
)
from .rule import FindingDraft, RuleContext


def _drill_dimensions(legacy_minor_nm: int, drill_x_nm: int, drill_y_nm: int) -> tuple[int, int]:
    if drill_x_nm == 0 and drill_y_nm == 0:
        return legacy_minor_nm, legacy_minor_nm
    return drill_x_nm, drill_y_nm


def _quadrant_dimensions(size_x_nm: int, size_y_nm: int, rotation_udeg: int) -> tuple[int, int]:
    if (rotation_udeg // 90_000_000) % 2:
        return size_y_nm, size_x_nm
    return size_x_nm, size_y_nm


class OutlineValidityRule:
    definition = RuleDefinition(
        rule_id="GEO.OUTLINE.VALID",
        version="1.0.0",
        domain=RuleDomain.GEOMETRY,
        title="Closed simple board outline",
        description="The board outline must be a non-zero-area simple polygon.",
        default_severity=Severity.FATAL,
        mandatory=True,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        return tuple(
            FindingDraft(
                f"Invalid board outline: {kind}",
                (EntityRef("outline", board.design_id),),
                (
                    EvidenceItem("defect", kind),
                    EvidenceItem("edge_indices", tuple(indices)),
                ),
            )
            for kind, indices in outline_defects(board.outline, context.geometry)
        )


class CopperTopologyRule:
    definition = RuleDefinition(
        rule_id="ALG.ROUTING.TOPOLOGY",
        version="1.0.0",
        domain=RuleDomain.ALGORITHM,
        title="Copper topology references are legal",
        description="Pads, tracks, vias, and zones must use valid copper geometry and references.",
        default_severity=Severity.FATAL,
        mandatory=True,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        nets = {net.net_id for net in board.nets}
        layers = set(board.layers)
        findings: list[FindingDraft] = []
        pad_index: dict[str, PhysicalPad] = {}
        for component in board.components:
            for pin in component.pins:
                has_geometry = (
                    pin.pad_center is not None
                    or pin.pad_diameter_nm != 0
                    or pin.pad_drill_nm != 0
                    or bool(pin.layers)
                )
                if not has_geometry:
                    continue
                issues: list[str] = []
                if pin.pad_center is None:
                    issues.append("missing_center")
                if pin.pad_diameter_nm <= 0:
                    issues.append("non_positive_copper_diameter")
                if not pin.layers:
                    issues.append("no_copper_layers")
                if any(layer not in layers for layer in pin.layers):
                    issues.append("unknown_layer")
                if pin.pad_drill_nm < 0:
                    issues.append("negative_drill")
                if pin.pad_drill_nm > 0 and pin.pad_drill_nm >= pin.pad_diameter_nm:
                    issues.append("drill_not_smaller_than_copper")
                if issues:
                    pin_id = f"{component.component_id}:{pin.number}"
                    findings.append(
                        FindingDraft(
                            (
                                f"Pad {component.reference}.{pin.number} has invalid "
                                "copper/drill topology"
                            ),
                            (EntityRef("pin", pin_id),),
                            (
                                EvidenceItem("issues", tuple(issues)),
                                EvidenceItem("copper_diameter_nm", pin.pad_diameter_nm),
                                EvidenceItem("drill_nm", pin.pad_drill_nm),
                                EvidenceItem("layers", pin.layers),
                            ),
                        )
                    )
        component_ids = {component.component_id for component in board.components}
        component_pin_numbers = {
            component.component_id: {pin.pad_number or pin.number for pin in component.pins}
            for component in board.components
        }
        known_nets = {net.net_id for net in board.nets}
        logical_pad_nets = _physical_pad_nets(board)
        pad_ids = [pad.pad_id for pad in board.pads]
        duplicate_pad_ids = {pad_id for pad_id in pad_ids if pad_ids.count(pad_id) > 1}
        for pad in board.pads:
            issues = []
            if pad.pad_id in duplicate_pad_ids:
                issues.append("duplicate_pad_id")
            elif pad.pad_id:
                pad_index[pad.pad_id] = pad
            if not pad.pad_id:
                issues.append("missing_pad_id")
            if pad.component_id not in component_ids:
                issues.append("unknown_component")
            elif pad.pad_number not in component_pin_numbers[pad.component_id]:
                issues.append("unknown_logical_pad_number")
            if pad.net_id is not None and pad.net_id not in known_nets:
                issues.append("unknown_net")
            derived_net_id = logical_pad_nets.get((pad.component_id, pad.pad_number))
            if (
                pad.net_id is not None
                and derived_net_id is not None
                and pad.net_id != derived_net_id
            ):
                issues.append("logical_net_mismatch")
            if pad.size_x_nm <= 0 or pad.size_y_nm <= 0:
                issues.append("non_positive_copper_size")
            if pad.shape is PadShape.CIRCLE and pad.size_x_nm != pad.size_y_nm:
                issues.append("circle_requires_equal_dimensions")
            if not 0 <= pad.rotation_udeg < 360_000_000:
                issues.append("rotation_out_of_range")
            if not pad.layers:
                issues.append("no_copper_layers")
            if any(layer not in layers for layer in pad.layers):
                issues.append("unknown_layer")
            drill_x_nm, drill_y_nm = _drill_dimensions(pad.drill_nm, pad.drill_x_nm, pad.drill_y_nm)
            if pad.drill_nm < 0 or drill_x_nm < 0 or drill_y_nm < 0:
                issues.append("negative_drill")
            if (drill_x_nm == 0) != (drill_y_nm == 0):
                issues.append("partial_drill_dimensions")
            copper_x_nm, copper_y_nm = _quadrant_dimensions(
                pad.size_x_nm, pad.size_y_nm, pad.rotation_udeg
            )
            board_drill_x_nm, board_drill_y_nm = _quadrant_dimensions(
                drill_x_nm, drill_y_nm, pad.drill_rotation_udeg
            )
            if drill_x_nm > 0 and (
                board_drill_x_nm >= copper_x_nm or board_drill_y_nm >= copper_y_nm
            ):
                issues.append("drill_not_smaller_than_copper")
            if issues:
                findings.append(
                    FindingDraft(
                        (
                            f"Physical pad {pad.pad_id or '<missing>'} has invalid "
                            "copper/drill topology"
                        ),
                        (EntityRef("pad", pad.pad_id or "<missing>"),),
                        (
                            EvidenceItem("issues", tuple(issues)),
                            EvidenceItem("component_id", pad.component_id),
                            EvidenceItem("pad_number", pad.pad_number),
                            EvidenceItem("shape", pad.shape.value),
                            EvidenceItem("size_x_nm", pad.size_x_nm),
                            EvidenceItem("size_y_nm", pad.size_y_nm),
                            EvidenceItem("rotation_udeg", pad.rotation_udeg),
                            EvidenceItem("drill_nm", pad.drill_nm),
                            EvidenceItem("drill_x_nm", pad.drill_x_nm),
                            EvidenceItem("drill_y_nm", pad.drill_y_nm),
                            EvidenceItem("drill_rotation_udeg", pad.drill_rotation_udeg),
                            EvidenceItem("layers", pad.layers),
                        ),
                    )
                )
        shared_groups: dict[str, list[PhysicalPad]] = {}
        for pad in board.pads:
            if pad.shared_land_group_id is not None:
                shared_groups.setdefault(pad.shared_land_group_id, []).append(pad)
        for group_id, pads in sorted(shared_groups.items()):
            signatures = {
                (
                    pad.component_id,
                    pad.net_id or logical_pad_nets.get((pad.component_id, pad.pad_number), ""),
                    pad.center,
                    pad.size_x_nm,
                    pad.size_y_nm,
                    pad.shape,
                    pad.rotation_udeg,
                    pad.layers,
                    pad.drill_nm,
                    pad.drill_x_nm,
                    pad.drill_y_nm,
                    pad.drill_rotation_udeg,
                )
                for pad in pads
            }
            logical_numbers = {pad.pad_number for pad in pads}
            if (
                len(pads) >= 2
                and len(logical_numbers) == len(pads)
                and len(signatures) == 1
            ):
                continue
            findings.append(
                FindingDraft(
                    f"Shared land group {group_id} does not describe one exact copper land",
                    tuple(EntityRef("pad", pad.pad_id) for pad in pads),
                    (
                        EvidenceItem("shared_land_group_id", group_id),
                        EvidenceItem("pad_ids", tuple(sorted(pad.pad_id for pad in pads))),
                        EvidenceItem("distinct_geometry_net_signatures", len(signatures)),
                    ),
                )
            )
        hole_ids = [hole.hole_id for hole in board.holes]
        duplicate_hole_ids = {hole_id for hole_id in hole_ids if hole_ids.count(hole_id) > 1}
        for hole in board.holes:
            issues = []
            if hole.hole_id in duplicate_hole_ids:
                issues.append("duplicate_hole_id")
            if hole.component_id not in component_ids:
                issues.append("unknown_component")
            if hole.diameter_nm <= 0:
                issues.append("non_positive_diameter")
            hole_drill_x_nm, hole_drill_y_nm = _drill_dimensions(
                hole.diameter_nm, hole.drill_x_nm, hole.drill_y_nm
            )
            if hole_drill_x_nm <= 0 or hole_drill_y_nm <= 0:
                issues.append("non_positive_drill_dimensions")
            if hole.plated != (hole.pad_id is not None):
                issues.append("plating_pad_association_mismatch")
            associated = pad_index.get(hole.pad_id or "")
            if hole.plated and associated is None:
                issues.append("unknown_pad")
            elif hole.plated and associated is not None:
                if associated.component_id != hole.component_id:
                    issues.append("pad_component_mismatch")
                if associated.center != hole.center:
                    issues.append("pad_center_mismatch")
                pad_drill_x_nm, pad_drill_y_nm = _drill_dimensions(
                    associated.drill_nm,
                    associated.drill_x_nm,
                    associated.drill_y_nm,
                )
                if (
                    (pad_drill_x_nm, pad_drill_y_nm) != (hole_drill_x_nm, hole_drill_y_nm)
                    or associated.drill_rotation_udeg % 180_000_000
                    != hole.drill_rotation_udeg % 180_000_000
                ):
                    issues.append("pad_drill_mismatch")
            if issues:
                findings.append(
                    FindingDraft(
                        f"Footprint hole {hole.hole_id} has invalid drill topology",
                        (EntityRef("hole", hole.hole_id),),
                        (
                            EvidenceItem("issues", tuple(issues)),
                            EvidenceItem("component_id", hole.component_id),
                            EvidenceItem("diameter_nm", hole.diameter_nm),
                            EvidenceItem("plated", hole.plated),
                            EvidenceItem("pad_id", hole.pad_id or ""),
                            EvidenceItem("drill_x_nm", hole.drill_x_nm),
                            EvidenceItem("drill_y_nm", hole.drill_y_nm),
                            EvidenceItem("drill_rotation_udeg", hole.drill_rotation_udeg),
                        ),
                    )
                )
        for track in board.tracks:
            issues: list[str] = []
            if track.net_id not in nets:
                issues.append("unknown_net")
            if track.layer not in layers:
                issues.append("unknown_layer")
            if track.start == track.end:
                issues.append("zero_length")
            if track.width_nm <= 0:
                issues.append("non_positive_width")
            if issues:
                findings.append(
                    FindingDraft(
                        f"Track {track.track_id} has invalid topology",
                        (EntityRef("track", track.track_id),),
                        (
                            EvidenceItem("issues", tuple(issues)),
                            EvidenceItem("layer", track.layer),
                            EvidenceItem("net_id", track.net_id),
                        ),
                    )
                )
        for via in board.vias:
            issues = []
            if via.net_id not in nets:
                issues.append("unknown_net")
            if len(via.layers) < 2:
                issues.append("fewer_than_two_layers")
            if any(layer not in layers for layer in via.layers):
                issues.append("unknown_layer")
            if via.diameter_nm <= 0:
                issues.append("non_positive_diameter")
            if via.drill_nm <= 0:
                issues.append("non_positive_drill")
            if via.drill_nm >= via.diameter_nm:
                issues.append("drill_not_smaller_than_diameter")
            if issues:
                findings.append(
                    FindingDraft(
                        f"Via {via.via_id} has invalid topology",
                        (EntityRef("via", via.via_id),),
                        (
                            EvidenceItem("issues", tuple(issues)),
                            EvidenceItem("layers", via.layers),
                            EvidenceItem("net_id", via.net_id),
                        ),
                    )
                )
        for zone in board.zones:
            issues = []
            if zone.net_id not in nets:
                issues.append("unknown_net")
            if zone.layer not in layers:
                issues.append("unknown_layer")
            if zone.clearance_nm < 0:
                issues.append("negative_clearance")
            if issues:
                findings.append(
                    FindingDraft(
                        f"Zone {zone.zone_id} has invalid topology",
                        (EntityRef("zone", zone.zone_id),),
                        (
                            EvidenceItem("issues", tuple(issues)),
                            EvidenceItem("layer", zone.layer),
                            EvidenceItem("net_id", zone.net_id),
                            EvidenceItem("clearance_nm", zone.clearance_nm),
                        ),
                    )
                )
        return tuple(findings)


class MinimumTrackWidthRule:
    definition = RuleDefinition(
        rule_id="GEO.TRACK.MIN_WIDTH",
        version="1.0.0",
        domain=RuleDomain.GEOMETRY,
        title="Minimum track width",
        description="Every copper track must meet the configured fabrication width.",
        default_severity=Severity.ERROR,
        parameters=(ParameterSpec("minimum_width_nm", ParameterType.INTEGER, 150_000, 1),),
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        minimum = context.integer("minimum_width_nm")
        return tuple(
            FindingDraft(
                f"Track {track.track_id} width is below {minimum} nm",
                (EntityRef("track", track.track_id),),
                (
                    EvidenceItem("actual_width_nm", track.width_nm),
                    EvidenceItem("minimum_width_nm", minimum),
                ),
            )
            for track in board.tracks
            if track.width_nm < minimum
        )


class MinimumViaAnnularRingRule:
    definition = RuleDefinition(
        rule_id="GEO.VIA.MIN_ANNULAR_RING",
        version="1.1.0",
        domain=RuleDomain.GEOMETRY,
        title="Minimum via annular ring",
        description="Via diameter minus drill must provide the configured radial annular ring.",
        default_severity=Severity.ERROR,
        parameters=(ParameterSpec("minimum_annular_ring_nm", ParameterType.INTEGER, 100_000, 1),),
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        minimum = context.integer("minimum_annular_ring_nm")
        return tuple(
            FindingDraft(
                f"Via {via.via_id} annular ring is below {minimum} nm",
                (EntityRef("via", via.via_id),),
                (
                    EvidenceItem("diameter_minus_drill_nm", via.diameter_nm - via.drill_nm),
                    EvidenceItem(
                        "actual_annular_ring_numerator_nm", via.diameter_nm - via.drill_nm
                    ),
                    EvidenceItem("actual_annular_ring_denominator", 2),
                    EvidenceItem("required_diameter_minus_drill_nm", 2 * minimum),
                ),
            )
            for via in board.vias
            if via.diameter_nm - via.drill_nm < 2 * minimum
        )


class MinimumPadAnnularRingRule:
    definition = RuleDefinition(
        rule_id="GEO.PAD.MIN_ANNULAR_RING",
        version="2.0.0",
        domain=RuleDomain.GEOMETRY,
        title="Minimum drilled-pad annular ring",
        description="Every centered circular pad drill must retain copper in both pad axes.",
        default_severity=Severity.ERROR,
        parameters=(ParameterSpec("minimum_annular_ring_nm", ParameterType.INTEGER, 100_000, 1),),
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        minimum = context.integer("minimum_annular_ring_nm")
        findings: list[FindingDraft] = []
        if board.pads:
            for pad in board.pads:
                drill_x_nm, drill_y_nm = _drill_dimensions(
                    pad.drill_nm, pad.drill_x_nm, pad.drill_y_nm
                )
                if drill_x_nm <= 0 or drill_y_nm <= 0:
                    continue
                copper_x_nm, copper_y_nm = _quadrant_dimensions(
                    pad.size_x_nm, pad.size_y_nm, pad.rotation_udeg
                )
                board_drill_x_nm, board_drill_y_nm = _quadrant_dimensions(
                    drill_x_nm, drill_y_nm, pad.drill_rotation_udeg
                )
                limiting_difference = min(
                    copper_x_nm - board_drill_x_nm,
                    copper_y_nm - board_drill_y_nm,
                )
                if limiting_difference <= 0 or limiting_difference >= 2 * minimum:
                    continue
                findings.append(
                    FindingDraft(
                        f"Pad {pad.pad_id} annular ring is below {minimum} nm",
                        (EntityRef("pad", pad.pad_id),),
                        (
                            EvidenceItem(
                                "actual_annular_ring_numerator_nm",
                                limiting_difference,
                            ),
                            EvidenceItem("actual_annular_ring_denominator", 2),
                            EvidenceItem("required_annular_ring_nm", minimum),
                            EvidenceItem("copper_span_x_nm", copper_x_nm),
                            EvidenceItem("copper_span_y_nm", copper_y_nm),
                            EvidenceItem("drill_span_x_nm", board_drill_x_nm),
                            EvidenceItem("drill_span_y_nm", board_drill_y_nm),
                        ),
                    )
                )
            return tuple(findings)
        for component in board.components:
            for pin in component.pins:
                minimum_copper_span = pin.pad_diameter_nm
                if (
                    pin.pad_drill_nm <= 0
                    or minimum_copper_span <= pin.pad_drill_nm
                    or minimum_copper_span - pin.pad_drill_nm >= 2 * minimum
                ):
                    continue
                pin_id = f"{component.component_id}:{pin.number}"
                findings.append(
                    FindingDraft(
                        (
                            f"Pad {component.reference}.{pin.number} annular ring is "
                            f"below {minimum} nm"
                        ),
                        (EntityRef("pin", pin_id),),
                        (
                            EvidenceItem(
                                "actual_annular_ring_numerator_nm",
                                minimum_copper_span - pin.pad_drill_nm,
                            ),
                            EvidenceItem("actual_annular_ring_denominator", 2),
                            EvidenceItem("required_annular_ring_nm", minimum),
                            EvidenceItem("limiting_pad_axis_nm", minimum_copper_span),
                        ),
                    )
                )
        return tuple(findings)


class ZoneOutlineValidityRule:
    definition = RuleDefinition(
        rule_id="GEO.ZONE.OUTLINE_VALID",
        version="1.0.0",
        domain=RuleDomain.GEOMETRY,
        title="Simple filled-zone outlines",
        description="Every modeled filled copper zone must be a non-zero-area simple polygon.",
        default_severity=Severity.FATAL,
        mandatory=True,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        findings: list[FindingDraft] = []
        for zone in board.zones:
            for kind, indices in outline_defects(zone.outline, context.geometry):
                findings.append(
                    FindingDraft(
                        f"Zone {zone.zone_id} has invalid outline: {kind}",
                        (EntityRef("zone", zone.zone_id),),
                        (
                            EvidenceItem("defect", kind),
                            EvidenceItem("edge_indices", tuple(indices)),
                        ),
                    )
                )
        return tuple(findings)


class ZoneFillVerificationRule:
    definition = RuleDefinition(
        rule_id="GEO.ZONE.FILL_UNVERIFIED",
        version="1.0.0",
        domain=RuleDomain.GEOMETRY,
        title="Zone fill must be independently verified",
        description=(
            "An unfilled zone remains design intent and is not authoritative copper until a "
            "source-bound fill-engine result is recorded."
        ),
        default_severity=Severity.WARNING,
        mandatory=True,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        return tuple(
            FindingDraft(
                f"Zone {zone.zone_id} is unfilled intent; copper fill is not verified",
                (EntityRef("zone", zone.zone_id),),
                (
                    EvidenceItem("fill_state", zone.fill_state.value),
                    EvidenceItem("layer", zone.layer),
                    EvidenceItem("net_id", zone.net_id),
                ),
            )
            for zone in board.zones
            if zone.fill_state is ZoneFillState.UNFILLED_INTENT
        )


@dataclass(frozen=True, slots=True)
class _CoreBox:
    minimum_x: Fraction
    minimum_y: Fraction
    maximum_x: Fraction
    maximum_y: Fraction

    @property
    def corners(self) -> tuple[ExactPoint, ...]:
        return (
            ExactPoint(self.minimum_x, self.minimum_y),
            ExactPoint(self.maximum_x, self.minimum_y),
            ExactPoint(self.maximum_x, self.maximum_y),
            ExactPoint(self.minimum_x, self.maximum_y),
        )

    @property
    def edges(self) -> tuple[tuple[ExactPoint, ExactPoint], ...]:
        corners = self.corners
        return tuple(
            (corners[index], corners[(index + 1) % len(corners)]) for index in range(len(corners))
        )


@dataclass(frozen=True, slots=True)
class _CopperPrimitive:
    primitive_id: str
    entity: EntityRef
    net_id: str
    layers: tuple[str, ...]
    center: ExactPoint | None
    start: ExactPoint | None
    end: ExactPoint | None
    box: _CoreBox | None
    width_nm: int

    @property
    def is_segment(self) -> bool:
        return self.start is not None and self.end is not None

    @property
    def is_box(self) -> bool:
        return self.box is not None


def _pad_core(
    pad: PhysicalPad,
) -> tuple[ExactPoint | None, ExactPoint | None, ExactPoint | None, _CoreBox | None, int] | None:
    """Represent a quadrant-rotated pad exactly as core geometry plus disk diameter."""

    if pad.size_x_nm <= 0 or pad.size_y_nm <= 0 or pad.rotation_udeg % 90_000_000:
        return None
    size_x_nm, size_y_nm = pad.size_x_nm, pad.size_y_nm
    if (pad.rotation_udeg // 90_000_000) % 2:
        size_x_nm, size_y_nm = size_y_nm, size_x_nm
    center = exact_point(pad.center)
    if pad.shape is PadShape.CIRCLE:
        if size_x_nm != size_y_nm:
            return None
        return center, None, None, None, size_x_nm
    if pad.shape is PadShape.OVAL:
        minor = min(size_x_nm, size_y_nm)
        major_delta = Fraction(abs(size_x_nm - size_y_nm), 2)
        if major_delta == 0:
            return center, None, None, None, minor
        if size_x_nm > size_y_nm:
            start = ExactPoint(center.x - major_delta, center.y)
            end = ExactPoint(center.x + major_delta, center.y)
        else:
            start = ExactPoint(center.x, center.y - major_delta)
            end = ExactPoint(center.x, center.y + major_delta)
        return None, start, end, None, minor
    half_x = Fraction(size_x_nm, 2)
    half_y = Fraction(size_y_nm, 2)
    radius = 0 if pad.shape is PadShape.RECT else min(size_x_nm, size_y_nm) // 4
    box = _CoreBox(
        center.x - half_x + radius,
        center.y - half_y + radius,
        center.x + half_x - radius,
        center.y + half_y - radius,
    )
    return None, None, None, box, 2 * radius


def _physical_pad_nets(board: BoardGraph) -> dict[tuple[str, str], str]:
    pin_by_number = {
        (component.component_id, pin.number): pin
        for component in board.components
        for pin in component.pins
    }
    result: dict[tuple[str, str], str] = {}
    for net in board.nets:
        for connection in net.connections:
            pin = pin_by_number.get((connection.component_id, connection.pin_number))
            if pin is not None:
                result[(connection.component_id, pin.pad_number or pin.number)] = net.net_id
    return result


def _copper_primitives(board: BoardGraph) -> tuple[_CopperPrimitive, ...]:
    pin_nets = {
        (connection.component_id, connection.pin_number): net.net_id
        for net in board.nets
        for connection in net.connections
    }
    primitives: list[_CopperPrimitive] = []
    if board.pads:
        pad_nets = _physical_pad_nets(board)
        represented_shared_groups: set[str] = set()
        for pad in board.pads:
            if pad.shared_land_group_id is not None:
                if pad.shared_land_group_id in represented_shared_groups:
                    continue
                represented_shared_groups.add(pad.shared_land_group_id)
            core = _pad_core(pad)
            if core is None or not pad.layers:
                continue
            center, start, end, box, width_nm = core
            net_id = pad.net_id or pad_nets.get((pad.component_id, pad.pad_number), "")
            primitives.append(
                _CopperPrimitive(
                    f"pad:{pad.pad_id}",
                    EntityRef("pad", pad.pad_id),
                    net_id,
                    pad.layers,
                    center,
                    start,
                    end,
                    box,
                    width_nm,
                )
            )
    else:
        for component in board.components:
            for pin in component.pins:
                net_id = pin_nets.get((component.component_id, pin.number))
                if not (
                    net_id and pin.pad_center is not None and pin.pad_diameter_nm > 0 and pin.layers
                ):
                    continue
                pin_id = f"{component.component_id}:{pin.number}"
                primitives.append(
                    _CopperPrimitive(
                        f"pad:{pin_id}",
                        EntityRef("pin", pin_id),
                        net_id,
                        pin.layers,
                        exact_point(pin.pad_center),
                        None,
                        None,
                        None,
                        pin.pad_diameter_nm,
                    )
                )
    primitives.extend(
        _CopperPrimitive(
            f"track:{track.track_id}",
            EntityRef("track", track.track_id),
            track.net_id,
            (track.layer,),
            None,
            exact_point(track.start),
            exact_point(track.end),
            None,
            track.width_nm,
        )
        for track in board.tracks
        if track.width_nm > 0
    )
    primitives.extend(
        _CopperPrimitive(
            f"via:{via.via_id}",
            EntityRef("via", via.via_id),
            via.net_id,
            via.layers,
            exact_point(via.center),
            None,
            None,
            None,
            via.diameter_nm,
        )
        for via in board.vias
        if via.diameter_nm > 0
    )
    return tuple(sorted(primitives, key=lambda item: item.primitive_id))


def _point_distance_squared(first: ExactPoint, second: ExactPoint) -> Fraction:
    return (first.x - second.x) ** 2 + (first.y - second.y) ** 2


def _point_in_box(point: ExactPoint, box: _CoreBox) -> bool:
    return box.minimum_x <= point.x <= box.maximum_x and box.minimum_y <= point.y <= box.maximum_y


def _point_box_distance_squared(point: ExactPoint, box: _CoreBox) -> Fraction:
    dx = max(box.minimum_x - point.x, Fraction(0), point.x - box.maximum_x)
    dy = max(box.minimum_y - point.y, Fraction(0), point.y - box.maximum_y)
    return dx * dx + dy * dy


def _segment_box_distance_squared(start: ExactPoint, end: ExactPoint, box: _CoreBox) -> Fraction:
    if (
        _point_in_box(start, box)
        or _point_in_box(end, box)
        or any(
            exact_segments_intersect(start, end, edge_start, edge_end)
            for edge_start, edge_end in box.edges
        )
    ):
        return Fraction(0)
    return min(
        _point_box_distance_squared(start, box),
        _point_box_distance_squared(end, box),
        *(exact_point_segment_distance_squared(corner, start, end) for corner in box.corners),
    )


def _box_distance_squared(first: _CoreBox, second: _CoreBox) -> Fraction:
    dx = max(
        first.minimum_x - second.maximum_x,
        Fraction(0),
        second.minimum_x - first.maximum_x,
    )
    dy = max(
        first.minimum_y - second.maximum_y,
        Fraction(0),
        second.minimum_y - first.maximum_y,
    )
    return dx * dx + dy * dy


def _hole_primitive(hole: Hole, layers: tuple[str, ...]) -> _CopperPrimitive:
    drill_x_nm, drill_y_nm = _drill_dimensions(hole.diameter_nm, hole.drill_x_nm, hole.drill_y_nm)
    if hole.drill_rotation_udeg % 90_000_000:
        raise ValueError(f"unsupported non-quadrant hole rotation: {hole.hole_id}")
    drill_x_nm, drill_y_nm = _quadrant_dimensions(drill_x_nm, drill_y_nm, hole.drill_rotation_udeg)
    center = exact_point(hole.center)
    minor = min(drill_x_nm, drill_y_nm)
    major_delta = Fraction(abs(drill_x_nm - drill_y_nm), 2)
    if major_delta == 0:
        start = None
        end = None
        point_center: ExactPoint | None = center
    elif drill_x_nm > drill_y_nm:
        start = ExactPoint(center.x - major_delta, center.y)
        end = ExactPoint(center.x + major_delta, center.y)
        point_center = None
    else:
        start = ExactPoint(center.x, center.y - major_delta)
        end = ExactPoint(center.x, center.y + major_delta)
        point_center = None
    return _CopperPrimitive(
        f"hole:{hole.hole_id}",
        EntityRef("hole", hole.hole_id),
        "",
        layers,
        point_center,
        start,
        end,
        None,
        minor,
    )


def _distance_squared(
    first: _CopperPrimitive, second: _CopperPrimitive, context: RuleContext
) -> Fraction:
    del context
    if first.is_box and second.is_box:
        assert first.box is not None and second.box is not None
        return _box_distance_squared(first.box, second.box)
    if first.is_box:
        assert first.box is not None
        if second.is_segment:
            assert second.start is not None and second.end is not None
            return _segment_box_distance_squared(second.start, second.end, first.box)
        assert second.center is not None
        return _point_box_distance_squared(second.center, first.box)
    if second.is_box:
        assert second.box is not None
        if first.is_segment:
            assert first.start is not None and first.end is not None
            return _segment_box_distance_squared(first.start, first.end, second.box)
        assert first.center is not None
        return _point_box_distance_squared(first.center, second.box)
    if first.is_segment and second.is_segment:
        assert first.start is not None and first.end is not None
        assert second.start is not None and second.end is not None
        return exact_segment_distance_squared(first.start, first.end, second.start, second.end)
    if first.is_segment:
        assert first.start is not None and first.end is not None and second.center is not None
        return exact_point_segment_distance_squared(second.center, first.start, first.end)
    if second.is_segment:
        assert second.start is not None and second.end is not None and first.center is not None
        return exact_point_segment_distance_squared(first.center, second.start, second.end)
    assert first.center is not None and second.center is not None
    return _point_distance_squared(first.center, second.center)


def _exact_outline_edges(outline: BoardOutline) -> tuple[tuple[ExactPoint, ExactPoint], ...]:
    vertices = outline.vertices
    return tuple(
        (exact_point(vertices[index]), exact_point(vertices[(index + 1) % len(vertices)]))
        for index in range(len(vertices))
    )


def _core_outline_distance_squared(
    primitive: _CopperPrimitive, outline: BoardOutline
) -> Fraction:
    edges = _exact_outline_edges(outline)
    if not edges:
        return Fraction(0)
    if primitive.is_box:
        assert primitive.box is not None
        return min(_segment_box_distance_squared(start, end, primitive.box) for start, end in edges)
    if primitive.is_segment:
        assert primitive.start is not None and primitive.end is not None
        return min(
            exact_segment_distance_squared(primitive.start, primitive.end, start, end)
            for start, end in edges
        )
    assert primitive.center is not None
    return min(
        exact_point_segment_distance_squared(primitive.center, start, end) for start, end in edges
    )


def _core_overlaps_outline(primitive: _CopperPrimitive, outline: BoardOutline) -> bool:
    edges = _exact_outline_edges(outline)
    if primitive.is_box:
        assert primitive.box is not None
        return (
            any(exact_point_in_outline(corner, outline) for corner in primitive.box.corners)
            or any(_point_in_box(start, primitive.box) for start, _ in edges)
            or any(
                exact_segments_intersect(a, b, c, d)
                for a, b in primitive.box.edges
                for c, d in edges
            )
        )
    if primitive.is_segment:
        assert primitive.start is not None and primitive.end is not None
        return (
            exact_point_in_outline(primitive.start, outline)
            or exact_point_in_outline(primitive.end, outline)
            or any(
                exact_segments_intersect(primitive.start, primitive.end, start, end)
                for start, end in edges
            )
        )
    assert primitive.center is not None
    return exact_point_in_outline(primitive.center, outline)


def _core_inside_outline(primitive: _CopperPrimitive, outline: BoardOutline) -> bool:
    edges = _exact_outline_edges(outline)
    if primitive.is_box:
        assert primitive.box is not None
        return all(
            exact_point_in_outline(corner, outline) for corner in primitive.box.corners
        ) and not any(
            exact_segments_intersect(a, b, c, d) for a, b in primitive.box.edges for c, d in edges
        )
    if primitive.is_segment:
        assert primitive.start is not None and primitive.end is not None
        return (
            exact_point_in_outline(primitive.start, outline)
            and exact_point_in_outline(primitive.end, outline)
            and not any(
                exact_segments_intersect(primitive.start, primitive.end, start, end)
                for start, end in edges
            )
        )
    assert primitive.center is not None
    return exact_point_in_outline(primitive.center, outline)


def _primitive_zone_distance_squared(
    primitive: _CopperPrimitive, zone: Zone, context: RuleContext
) -> tuple[Fraction, bool]:
    """Return exact boundary distance and whether copper enters the filled zone."""

    del context
    return (
        _core_outline_distance_squared(primitive, zone.outline),
        _core_overlaps_outline(primitive, zone.outline),
    )


def _valid_zones(board: BoardGraph, context: RuleContext) -> tuple[Zone, ...]:
    return tuple(
        zone
        for zone in board.zones
        if zone.fill_state is ZoneFillState.VERIFIED_FILLED
        and not outline_defects(zone.outline, context.geometry)
    )


class MinimumCopperClearanceRule:
    definition = RuleDefinition(
        rule_id="GEO.COPPER.MIN_CLEARANCE",
        version="2.0.0",
        domain=RuleDomain.GEOMETRY,
        title="Minimum inter-net copper clearance",
        description="Pads, tracks, vias, and filled zones on different nets must meet clearance.",
        default_severity=Severity.ERROR,
        parameters=(ParameterSpec("minimum_clearance_nm", ParameterType.INTEGER, 150_000, 0),),
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        clearance = context.integer("minimum_clearance_nm")
        primitives = _copper_primitives(board)
        findings: list[FindingDraft] = []
        for first_index, first in enumerate(primitives):
            for second in primitives[first_index + 1 :]:
                if first.net_id == second.net_id or not set(first.layers).intersection(
                    second.layers
                ):
                    continue
                distance_squared = _distance_squared(first, second, context)
                # 2*center-distance >= width_a + width_b + 2*clearance.
                required_doubled = first.width_nm + second.width_nm + 2 * clearance
                if 4 * distance_squared < required_doubled * required_doubled:
                    findings.append(
                        FindingDraft(
                            (
                                "Copper clearance violation between "
                                f"{first.primitive_id} and {second.primitive_id}"
                            ),
                            (first.entity, second.entity),
                            (
                                EvidenceItem("first_net_id", first.net_id),
                                EvidenceItem("second_net_id", second.net_id),
                                EvidenceItem(
                                    "shared_layers",
                                    tuple(sorted(set(first.layers).intersection(second.layers))),
                                ),
                                EvidenceItem(
                                    "center_distance_squared_numerator", distance_squared.numerator
                                ),
                                EvidenceItem(
                                    "center_distance_squared_denominator",
                                    distance_squared.denominator,
                                ),
                                EvidenceItem(
                                    "required_center_distance_doubled_nm", required_doubled
                                ),
                            ),
                        )
                    )
        zones = _valid_zones(board, context)
        for hole in board.holes:
            if hole.plated or hole.diameter_nm <= 0:
                continue
            hole_primitive = _hole_primitive(hole, board.layers)
            for primitive in primitives:
                distance_squared = _distance_squared(hole_primitive, primitive, context)
                required_doubled = hole_primitive.width_nm + primitive.width_nm + 2 * clearance
                if 4 * distance_squared < required_doubled * required_doubled:
                    findings.append(
                        FindingDraft(
                            (
                                "Copper clearance violation between "
                                f"{primitive.primitive_id} and NPTH {hole.hole_id}"
                            ),
                            (primitive.entity, hole_primitive.entity),
                            (
                                EvidenceItem("hole_id", hole.hole_id),
                                EvidenceItem("hole_diameter_nm", hole.diameter_nm),
                                EvidenceItem("copper_net_id", primitive.net_id),
                                EvidenceItem(
                                    "core_distance_squared_numerator",
                                    distance_squared.numerator,
                                ),
                                EvidenceItem(
                                    "core_distance_squared_denominator",
                                    distance_squared.denominator,
                                ),
                                EvidenceItem(
                                    "required_core_distance_doubled_nm",
                                    required_doubled,
                                ),
                            ),
                        )
                    )
        for zone in zones:
            for primitive in primitives:
                if primitive.net_id == zone.net_id or zone.layer not in primitive.layers:
                    continue
                distance_squared, overlaps = _primitive_zone_distance_squared(
                    primitive, zone, context
                )
                required_clearance = max(clearance, zone.clearance_nm)
                required_doubled = primitive.width_nm + 2 * required_clearance
                if overlaps or 4 * distance_squared < required_doubled * required_doubled:
                    findings.append(
                        FindingDraft(
                            (
                                "Copper clearance violation between "
                                f"{primitive.primitive_id} and zone:{zone.zone_id}"
                            ),
                            (primitive.entity, EntityRef("zone", zone.zone_id)),
                            (
                                EvidenceItem("first_net_id", primitive.net_id),
                                EvidenceItem("second_net_id", zone.net_id),
                                EvidenceItem("shared_layers", (zone.layer,)),
                                EvidenceItem(
                                    "boundary_distance_squared_numerator",
                                    distance_squared.numerator,
                                ),
                                EvidenceItem(
                                    "boundary_distance_squared_denominator",
                                    distance_squared.denominator,
                                ),
                                EvidenceItem(
                                    "required_center_distance_doubled_nm",
                                    required_doubled,
                                ),
                                EvidenceItem("copper_overlaps_zone", overlaps),
                            ),
                        )
                    )
        for first_index, first in enumerate(zones):
            for second in zones[first_index + 1 :]:
                if first.net_id == second.net_id or first.layer != second.layer:
                    continue
                distance_squared = minimum_outlines_distance_squared(
                    first.outline, second.outline, context.geometry
                )
                overlaps = outlines_overlap(first.outline, second.outline, context.geometry)
                required_clearance = max(clearance, first.clearance_nm, second.clearance_nm)
                if overlaps or distance_squared < required_clearance * required_clearance:
                    findings.append(
                        FindingDraft(
                            (
                                "Copper clearance violation between "
                                f"zone:{first.zone_id} and zone:{second.zone_id}"
                            ),
                            (
                                EntityRef("zone", first.zone_id),
                                EntityRef("zone", second.zone_id),
                            ),
                            (
                                EvidenceItem("first_net_id", first.net_id),
                                EvidenceItem("second_net_id", second.net_id),
                                EvidenceItem("shared_layers", (first.layer,)),
                                EvidenceItem(
                                    "boundary_distance_squared_numerator",
                                    distance_squared.numerator,
                                ),
                                EvidenceItem(
                                    "boundary_distance_squared_denominator",
                                    distance_squared.denominator,
                                ),
                                EvidenceItem("required_clearance_nm", required_clearance),
                                EvidenceItem("zones_overlap", overlaps),
                            ),
                        )
                    )
        return tuple(findings)


class BoardEdgeClearanceRule:
    definition = RuleDefinition(
        rule_id="GEO.COPPER.BOARD_EDGE_CLEARANCE",
        version="2.0.0",
        domain=RuleDomain.GEOMETRY,
        title="Copper to board-edge clearance",
        description="All modeled copper must be inside the outline and clear of its boundary.",
        default_severity=Severity.ERROR,
        parameters=(ParameterSpec("minimum_edge_clearance_nm", ParameterType.INTEGER, 250_000, 0),),
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        # Avoid derivative noise when the mandatory outline rule already rejects the polygon.
        if outline_defects(board.outline, context.geometry):
            return ()
        clearance = context.integer("minimum_edge_clearance_nm")
        findings: list[FindingDraft] = []
        for primitive in _copper_primitives(board):
            inside = _core_inside_outline(primitive, board.outline)
            distance_squared = _core_outline_distance_squared(primitive, board.outline)
            required_doubled = primitive.width_nm + 2 * clearance
            if not inside or 4 * distance_squared < required_doubled * required_doubled:
                findings.append(
                    FindingDraft(
                        f"{primitive.primitive_id} violates board-edge clearance",
                        (primitive.entity, EntityRef("outline", board.design_id)),
                        (
                            EvidenceItem("inside_outline", inside),
                            EvidenceItem(
                                "boundary_distance_squared_numerator", distance_squared.numerator
                            ),
                            EvidenceItem(
                                "boundary_distance_squared_denominator",
                                distance_squared.denominator,
                            ),
                            EvidenceItem("required_center_distance_doubled_nm", required_doubled),
                        ),
                    )
                )
        for hole in board.holes:
            if hole.plated or hole.diameter_nm <= 0:
                continue
            primitive = _hole_primitive(hole, board.layers)
            inside = _core_inside_outline(primitive, board.outline)
            distance_squared = _core_outline_distance_squared(primitive, board.outline)
            required_doubled = hole.diameter_nm + 2 * clearance
            if not inside or 4 * distance_squared < required_doubled * required_doubled:
                findings.append(
                    FindingDraft(
                        f"NPTH {hole.hole_id} violates board-edge clearance",
                        (EntityRef("hole", hole.hole_id), EntityRef("outline", board.design_id)),
                        (
                            EvidenceItem("inside_outline", inside),
                            EvidenceItem(
                                "boundary_distance_squared_numerator",
                                distance_squared.numerator,
                            ),
                            EvidenceItem(
                                "boundary_distance_squared_denominator",
                                distance_squared.denominator,
                            ),
                            EvidenceItem("required_center_distance_doubled_nm", required_doubled),
                        ),
                    )
                )
        for zone in _valid_zones(board, context):
            inside = all(
                context.geometry.point_in_outline(vertex, board.outline)
                for vertex in zone.outline.vertices
            )
            distance_squared = minimum_outlines_distance_squared(
                zone.outline, board.outline, context.geometry
            )
            if not inside or distance_squared < clearance * clearance:
                findings.append(
                    FindingDraft(
                        f"zone:{zone.zone_id} violates board-edge clearance",
                        (
                            EntityRef("zone", zone.zone_id),
                            EntityRef("outline", board.design_id),
                        ),
                        (
                            EvidenceItem("inside_outline", inside),
                            EvidenceItem(
                                "boundary_distance_squared_numerator",
                                distance_squared.numerator,
                            ),
                            EvidenceItem(
                                "boundary_distance_squared_denominator",
                                distance_squared.denominator,
                            ),
                            EvidenceItem("required_boundary_clearance_nm", clearance),
                        ),
                    )
                )
        return tuple(findings)


def geometric_rules() -> tuple[object, ...]:
    return (
        OutlineValidityRule(),
        CopperTopologyRule(),
        MinimumTrackWidthRule(),
        MinimumViaAnnularRingRule(),
        MinimumPadAnnularRingRule(),
        ZoneOutlineValidityRule(),
        ZoneFillVerificationRule(),
        MinimumCopperClearanceRule(),
        BoardEdgeClearanceRule(),
    )

"""Loss-aware bridge from KiCad PCB IR to the canonical product graph."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol

from backend.design_kernel import (
    Component,
    CopperZone,
    DesignGraph,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    PinRef,
    Track,
)
from backend.design_kernel import (
    Net as DesignNet,
)
from backend.design_kernel import (
    PointNm as DesignPoint,
)
from backend.design_kernel import (
    Via as DesignVia,
)

from .errors import CanonicalMappingError
from .model import Board, Footprint, Pad, PadKind, PointNm, ViaKind


@dataclass(frozen=True, slots=True, order=True)
class MappingGap:
    code: str
    entity_id: str
    detail: str
    release_blocking: bool


class ComponentResolver(Protocol):
    """Trusted library boundary for exact component provenance and pin maps."""

    def resolve(self, footprint: Footprint) -> Component:
        """Resolve one PCB footprint to a fully provenanced canonical component."""

        ...


@dataclass(frozen=True, slots=True)
class CanonicalConversionResult:
    graph: DesignGraph
    source_ir_sha256: str
    diagnostics_manifest_sha256: str
    graph_sha256: str
    gaps: tuple[MappingGap, ...]

    @property
    def release_eligible(self) -> bool:
        return not any(item.release_blocking for item in self.gaps)


def to_design_graph(
    board: Board,
    *,
    project_id: str,
    component_resolver: ComponentResolver,
) -> CanonicalConversionResult:
    """Map exact representable PCB facts and name every remaining parity gap.

    The component resolver is mandatory because a PCB file cannot prove an exact
    manufacturer part number, datasheet digest, symbol identity, or pin map.
    Geometry requiring an inexact transform is rejected rather than rounded.
    The returned graph can be used for deterministic staging and verification,
    while ``release_eligible`` remains false until every blocking gap is resolved
    by a richer import surface or explicit source-bound workflow.
    """

    if not isinstance(board, Board):
        raise TypeError("board must be a KiCad exchange Board")
    if not isinstance(project_id, str) or not project_id:
        raise TypeError("project_id must be non-empty text")
    normalized = board.normalized()
    fatal: list[MappingGap] = []
    gaps: list[MappingGap] = []

    for diagnostic in normalized.diagnostics.unsupported:
        fatal.append(
            MappingGap(
                "unsupported-source-construct",
                diagnostic.scope,
                f"{diagnostic.path}: {diagnostic.reason}",
                True,
            )
        )
    if fatal:
        raise CanonicalMappingError(
            "unsupported KiCad constructs block canonical conversion",
            gaps=tuple(sorted(fatal)),
        )

    copper_layers = tuple(
        layer.name
        for layer in normalized.layers
        if layer.kind in {"signal", "power", "mixed", "jumper"}
    )
    if not copper_layers:
        raise CanonicalMappingError(
            "KiCad board has no modeled copper layers",
            gaps=(
                MappingGap(
                    "copper-layers-missing",
                    "board",
                    "at least one copper layer is required",
                    True,
                ),
            ),
        )

    components: list[Component] = []
    placements: list[FootprintPlacement] = []
    resolved: dict[str, Component] = {}
    for footprint in normalized.footprints:
        component = component_resolver.resolve(footprint)
        if not isinstance(component, Component):
            fatal.append(
                MappingGap(
                    "resolver-type-invalid",
                    footprint.footprint_id,
                    "component resolver did not return a canonical Component",
                    True,
                )
            )
            continue
        mismatches: list[str] = []
        if component.reference != footprint.reference:
            mismatches.append("reference")
        if component.value != footprint.value:
            mismatches.append("value")
        if component.footprint_id != footprint.library_id:
            mismatches.append("footprint library ID")
        if mismatches:
            fatal.append(
                MappingGap(
                    "resolver-identity-mismatch",
                    footprint.footprint_id,
                    "resolver disagrees on " + ", ".join(mismatches),
                    True,
                )
            )
            continue
        if footprint.layer != "F.Cu":
            fatal.append(
                MappingGap(
                    "back-side-transform-unsupported",
                    footprint.footprint_id,
                    "exact mirrored local-pad transform is not yet modeled",
                    True,
                )
            )
            continue
        if footprint.rotation_udeg % 90_000_000:
            fatal.append(
                MappingGap(
                    "non-orthogonal-transform-unsupported",
                    footprint.footprint_id,
                    "integer-nm conversion refuses trigonometric rounding",
                    True,
                )
            )
            continue
        resolved[footprint.footprint_id] = component
        components.append(component)
        placements.append(
            FootprintPlacement(
                component.component_id,
                DesignPoint(footprint.position.x, footprint.position.y),
                footprint.rotation_udeg,
                "front",
                footprint.locked,
            )
        )
        if footprint.attributes:
            gaps.append(
                MappingGap(
                    "footprint-attributes-source-retained",
                    footprint.footprint_id,
                    "assembly attributes are retained only in the KiCad IR: "
                    + ", ".join(footprint.attributes),
                    True,
                )
            )

    if fatal:
        raise CanonicalMappingError(
            "component provenance or placement cannot be mapped exactly",
            gaps=tuple(sorted(fatal)),
        )

    members: dict[str, set[PinRef]] = {net.net_id: set() for net in normalized.nets}
    pads: list[FootprintPad] = []
    holes: list[FootprintHole] = []
    for footprint in normalized.footprints:
        component = resolved[footprint.footprint_id]
        pins_by_pad = {pin.pad_number: pin for pin in component.pins}
        electrical_pads = tuple(
            pad for pad in footprint.pads if pad.kind is not PadKind.NPTH
        )
        pads_by_number: dict[str, list[Pad]] = {}
        for pad in electrical_pads:
            pads_by_number.setdefault(pad.number, []).append(pad)
        for number, physical_group in pads_by_number.items():
            net_ids = {pad.net_id for pad in physical_group}
            if len(net_ids) > 1:
                fatal.append(
                    MappingGap(
                        "repeated-pad-net-mismatch",
                        footprint.footprint_id,
                        f"physical pads sharing number {number!r} have different net claims",
                        True,
                    )
                )

        coincident: dict[tuple[object, ...], list[Pad]] = {}
        for pad in electrical_pads:
            key = (
                pad.position,
                pad.rotation_udeg,
                pad.size_x_nm,
                pad.size_y_nm,
                pad.shape,
                pad.kind,
                pad.drill_x_nm,
                pad.drill_y_nm,
                tuple(sorted(pad.layers)),
                pad.roundrect_ratio_ppm,
            )
            coincident.setdefault(key, []).append(pad)
        shared_land_group_ids: dict[str, str] = {}
        for physical_group in coincident.values():
            if len(physical_group) < 2:
                continue
            net_ids = {pad.net_id for pad in physical_group}
            if len(net_ids) > 1:
                fatal.append(
                    MappingGap(
                        "shared-land-net-mismatch",
                        footprint.footprint_id,
                        "exact coincident physical pads have different net claims",
                        True,
                    )
                )
                continue
            numbers = [pad.number for pad in physical_group]
            if len(numbers) != len(set(numbers)):
                # Repeated physical pads for one logical number are already
                # represented by that number. A mixed duplicate/distinct set
                # cannot form the canonical distinct-contact shared-land group.
                if len(set(numbers)) > 1:
                    fatal.append(
                        MappingGap(
                            "shared-land-pad-number-ambiguous",
                            footprint.footprint_id,
                            "coincident shared-land contacts must have distinct pad numbers",
                            True,
                        )
                    )
                continue
            member_ids = tuple(sorted(pad.pad_id for pad in physical_group))
            digest = hashlib.sha256("\0".join(member_ids).encode("ascii")).hexdigest()[:24]
            group_id = f"kicad-shared-land-{digest}"
            shared_land_group_ids.update(
                {pad.pad_id: group_id for pad in physical_group}
            )

        for pad in footprint.pads:
            center = _local_to_board(
                pad.position,
                footprint.position,
                footprint.rotation_udeg,
            )
            combined_rotation = (
                footprint.rotation_udeg + pad.rotation_udeg
            ) % 360_000_000
            drill_rotation = (
                combined_rotation % 180_000_000
                if pad.drill_x_nm != pad.drill_y_nm
                else 0
            )
            if pad.drill_x_nm != pad.drill_y_nm and drill_rotation % 90_000_000:
                fatal.append(
                    MappingGap(
                        "non-cardinal-drill-rotation-unsupported",
                        pad.pad_id,
                        "canonical KiCad staging accepts oval drills only at 0/90 degrees",
                        True,
                    )
                )
                continue
            if pad.kind is PadKind.NPTH:
                holes.append(
                    FootprintHole(
                        hole_id=f"hole-{pad.pad_id}",
                        component_id=component.component_id,
                        center=DesignPoint(center.x, center.y),
                        diameter_nm=min(pad.drill_x_nm, pad.drill_y_nm),
                        plated=False,
                        pad_id=None,
                        locked=pad.locked,
                        drill_x_nm=pad.drill_x_nm,
                        drill_y_nm=pad.drill_y_nm,
                        drill_rotation_udeg=drill_rotation,
                    )
                )
                continue
            pin = pins_by_pad.get(pad.number)
            if pin is None:
                fatal.append(
                    MappingGap(
                        "pad-pin-map-missing",
                        pad.pad_id,
                        f"resolver has no pin mapped to pad number {pad.number!r}",
                        True,
                    )
                )
                continue
            pad_layers, unrepresented_layers = _canonical_pad_layers(
                pad.layers,
                copper_layers,
            )
            if not pad_layers:
                fatal.append(
                    MappingGap(
                        "pad-copper-layers-missing",
                        pad.pad_id,
                        "pad has no resolvable copper layer",
                        True,
                    )
                )
                continue
            if unrepresented_layers:
                gaps.append(
                    MappingGap(
                        "pad-fabrication-layers-source-retained",
                        pad.pad_id,
                        "mask/paste or other layers remain only in KiCad IR: "
                        + ", ".join(unrepresented_layers),
                        True,
                    )
                )
            if pad.roundrect_ratio_ppm is not None:
                gaps.append(
                    MappingGap(
                        "roundrect-ratio-source-retained",
                        pad.pad_id,
                        "exact roundrect corner ratio remains only in the KiCad IR",
                        True,
                    )
                )
            pads.append(
                FootprintPad(
                    pad_id=pad.pad_id,
                    component_id=component.component_id,
                    pad_number=pad.number,
                    center=DesignPoint(center.x, center.y),
                    size_x_nm=pad.size_x_nm,
                    size_y_nm=pad.size_y_nm,
                    shape=pad.shape.value,
                    rotation_udeg=combined_rotation,
                    layers=pad_layers,
                    pad_drill_nm=min(pad.drill_x_nm, pad.drill_y_nm),
                    net_id=pad.net_id,
                    locked=pad.locked,
                    drill_x_nm=pad.drill_x_nm,
                    drill_y_nm=pad.drill_y_nm,
                    drill_rotation_udeg=drill_rotation,
                    shared_land_group_id=shared_land_group_ids.get(pad.pad_id),
                )
            )
            if pad.kind is PadKind.THROUGH_HOLE:
                holes.append(
                    FootprintHole(
                        hole_id=f"hole-{pad.pad_id}",
                        component_id=component.component_id,
                        center=DesignPoint(center.x, center.y),
                        diameter_nm=min(pad.drill_x_nm, pad.drill_y_nm),
                        plated=True,
                        pad_id=pad.pad_id,
                        locked=pad.locked,
                        drill_x_nm=pad.drill_x_nm,
                        drill_y_nm=pad.drill_y_nm,
                        drill_rotation_udeg=drill_rotation,
                    )
                )
            if pad.net_id is not None:
                members[pad.net_id].add(PinRef(component.component_id, pin.number))
            if pad.pin_function is not None and pad.pin_function != pin.name:
                gaps.append(
                    MappingGap(
                        "pin-function-resolver-mismatch",
                        pad.pad_id,
                        f"KiCad {pad.pin_function!r} vs resolved {pin.name!r}",
                        True,
                    )
                )
            if pad.pin_type is not None and pad.pin_type != pin.electrical_type:
                gaps.append(
                    MappingGap(
                        "pin-type-resolver-mismatch",
                        pad.pad_id,
                        f"KiCad {pad.pin_type!r} vs resolved {pin.electrical_type!r}",
                        True,
                    )
                )

    for via in normalized.vias:
        if via.kind is not ViaKind.THROUGH:
            fatal.append(
                MappingGap(
                    "via-kind-unrepresented",
                    via.via_id,
                    f"canonical v1 cannot retain KiCad via kind {via.kind.value}",
                    True,
                )
            )
    if fatal:
        raise CanonicalMappingError(
            "KiCad pad or via geometry cannot be mapped exactly",
            gaps=tuple(sorted(fatal)),
        )

    graph = DesignGraph(
        1,
        project_id,
        copper_layers,
        tuple(DesignPoint(point.x, point.y) for point in normalized.outline_vertices),
        tuple(components),
        tuple(
            DesignNet(net.net_id, net.name, tuple(sorted(members[net.net_id])))
            for net in normalized.nets
        ),
        tuple(placements),
        tuple(
            Track(
                item.segment_id,
                item.net_id,
                item.layer,
                DesignPoint(item.start.x, item.start.y),
                DesignPoint(item.end.x, item.end.y),
                item.width_nm,
                item.locked,
            )
            for item in normalized.segments
        ),
        tuple(pads),
        tuple(holes),
        tuple(
            DesignVia(
                item.via_id,
                item.net_id,
                DesignPoint(item.center.x, item.center.y),
                item.diameter_nm,
                item.drill_nm,
                item.layers,
                item.locked,
            )
            for item in normalized.vias
        ),
        tuple(
            CopperZone(
                item.zone_id,
                item.net_id,
                item.layer,
                tuple(DesignPoint(point.x, point.y) for point in item.boundary),
                item.clearance_nm,
                item.minimum_thickness_nm,
                0,
                False,
            )
            for item in normalized.zones
        ),
    ).normalized()
    graph_hash = graph.graph_hash

    if normalized.diagnostics.constructs:
        gaps.append(
            MappingGap(
                "opaque-source-manifest-required",
                "board",
                "syntax outside the canonical graph remains bound by diagnostics manifest "
                + normalized.diagnostics.manifest_sha256,
                False,
            )
        )
    technical_layers = tuple(
        item.name
        for item in normalized.layers
        if item.kind not in {"signal", "power", "mixed", "jumper"}
    )
    if technical_layers:
        gaps.append(
            MappingGap(
                "technical-layer-table-source-retained",
                "board",
                "non-copper layer declarations remain in KiCad IR: "
                + ", ".join(technical_layers),
                False,
            )
        )
    if normalized.outline_edges:
        gaps.append(
            MappingGap(
                "edge-cuts-stroke-source-retained",
                "board",
                "Edge.Cuts UUIDs, stroke widths, and stroke types remain in KiCad IR",
                False,
            )
        )
    if any(item.locked for item in normalized.outline_edges):
        gaps.append(
            MappingGap(
                "locked-outline-source-retained",
                "board",
                "canonical v1 does not carry per-edge outline locks",
                True,
            )
        )
    for net in normalized.nets:
        if members[net.net_id]:
            gaps.append(
                MappingGap(
                    "net-membership-inferred-from-pcb-pads",
                    net.net_id,
                    "PCB pad assignments cannot independently prove schematic connectivity",
                    True,
                )
            )
    for zone in normalized.zones:
        if zone.name:
            gaps.append(
                MappingGap(
                    "zone-name-source-retained",
                    zone.zone_id,
                    "zone name remains in the KiCad IR",
                    False,
                )
            )
        gaps.append(
            MappingGap(
                "zone-hatch-source-retained",
                zone.zone_id,
                f"hatch {zone.hatch_style}/{zone.hatch_pitch_nm}nm remains in KiCad IR",
                False,
            )
        )
    gaps.append(
        MappingGap(
            "pcb-only-schematic-parity-unproven",
            "board",
            "a .kicad_pcb file cannot prove schematic wires, junctions, or source ERC parity",
            True,
        )
    )
    return CanonicalConversionResult(
        graph,
        normalized.normalized_ir_sha256,
        normalized.diagnostics.manifest_sha256,
        graph_hash,
        tuple(sorted(gaps)),
    )


def _local_to_board(local: PointNm, origin: PointNm, rotation_udeg: int) -> PointNm:
    quarter_turns = (rotation_udeg // 90_000_000) % 4
    if quarter_turns == 0:
        x, y = local.x, local.y
    elif quarter_turns == 1:
        x, y = -local.y, local.x
    elif quarter_turns == 2:
        x, y = -local.x, -local.y
    else:
        x, y = local.y, -local.x
    return PointNm(origin.x + x, origin.y + y)


def _canonical_pad_layers(
    layers: tuple[str, ...], copper_layers: tuple[str, ...]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    copper_set = set(copper_layers)
    resolved: set[str] = set()
    unrepresented: set[str] = set()
    for layer in layers:
        if layer == "*.Cu":
            resolved.update(copper_layers)
        elif layer in copper_set:
            resolved.add(layer)
        else:
            unrepresented.add(layer)
    return tuple(sorted(resolved)), tuple(sorted(unrepresented))

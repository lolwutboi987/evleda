"""Loss-aware adapter from the product graph to deterministic verification input."""

from __future__ import annotations

from backend.verification.model import (
    BoardGraph,
    BoardOutline,
    NetConnection,
    PadShape,
    PinElectricalType,
)
from backend.verification.model import (
    Component as VerificationComponent,
)
from backend.verification.model import (
    Hole as VerificationHole,
)
from backend.verification.model import (
    Net as VerificationNet,
)
from backend.verification.model import (
    PhysicalPad as VerificationPhysicalPad,
)
from backend.verification.model import (
    Pin as VerificationPin,
)
from backend.verification.model import (
    PointNm as VerificationPoint,
)
from backend.verification.model import (
    Track as VerificationTrack,
)
from backend.verification.model import (
    Via as VerificationVia,
)
from backend.verification.model import (
    Zone as VerificationZone,
)
from backend.verification.model import (
    ZoneFillEvidence as VerificationZoneFillEvidence,
)
from backend.verification.model import ZoneFillState as VerificationZoneFillState

from .model import DesignGraph, DesignRevision, InvariantViolation, validate_graph

_PIN_TYPES = {item.value: item for item in PinElectricalType}


def to_verification_board(graph: DesignGraph, *, revision: str) -> BoardGraph:
    """Create a normalized verification board without synthesizing missing geometry.

    Geometry is translated only where the verification model can represent it
    without loss. Unsupported pad shapes, holes, schematic drawing primitives,
    zone attributes, and locked metadata are named in ``unsupported_features`` so a
    strict verification policy fails closed instead of checking invented data.
    """

    if type(graph) is not DesignGraph:
        raise InvariantViolation("verification subject graph must be exact DesignGraph")
    if (
        type(revision) is not str
        or len(revision) != 64
        or any(character not in "0123456789abcdef" for character in revision)
    ):
        raise InvariantViolation("verification subject revision must be a lowercase SHA-256 digest")
    normalized = graph.normalized()
    validate_graph(normalized)
    placements = {item.component_id: item for item in normalized.placements}
    pads = {(item.component_id, item.pad_number): item for item in normalized.pads}
    pin_memberships = {
        (member.component_id, member.pin_number): net.net_id
        for net in normalized.nets
        for member in net.members
    }
    unsupported: list[str] = []
    if not normalized.board_outline:
        unsupported.append("board-outline-missing")

    components: list[VerificationComponent] = []
    for component in normalized.components:
        placement = placements.get(component.component_id)
        if placement is None:
            unsupported.append(f"footprint-placement-missing:{component.component_id}")
        elif placement.locked:
            unsupported.append(f"locked-placement-metadata-unrepresented:{component.component_id}")

        pins: list[VerificationPin] = []
        for pin in component.pins:
            electrical_type = _PIN_TYPES.get(pin.electrical_type)
            if electrical_type is None:
                electrical_type = PinElectricalType.UNSPECIFIED
                unsupported.append(
                    f"pin-electrical-type-unsupported:{component.component_id}:{pin.number}:{pin.electrical_type}"
                )
            pad = pads.get((component.component_id, pin.pad_number))
            pad_center = None
            pad_diameter_nm = 0
            pad_layers: tuple[str, ...] = ()
            pad_drill_nm = 0
            if pad is None:
                unsupported.append(
                    f"pin-pad-geometry-missing:{component.component_id}:{pin.number}"
                )
            else:
                pad_center = VerificationPoint(pad.center.x, pad.center.y)
                # Retained for schema-v1 consumers only. Schema-v2 geometry
                # always uses the exact shape and both exact dimensions below.
                pad_diameter_nm = min(pad.size_x_nm, pad.size_y_nm)
                pad_layers = pad.layers
                pad_drill_nm = pad.pad_drill_nm
                if pad.shape == "circle" and pad.size_x_nm != pad.size_y_nm:
                    unsupported.append(f"exact-pad-circle-nonsquare-not-supported:{pad.pad_id}")
                if pad.shape == "roundrect":
                    unsupported.append(f"exact-pad-roundrect-radius-not-represented:{pad.pad_id}")
                if pad.shape != "circle" and pad.rotation_udeg % 90_000_000:
                    unsupported.append(
                        f"exact-pad-rotation-not-supported:{pad.pad_id}:{pad.rotation_udeg}"
                    )
                if pad.drill_x_nm != pad.drill_y_nm and pad.drill_rotation_udeg % 90_000_000:
                    unsupported.append(
                        f"exact-drill-rotation-not-supported:pad:{pad.pad_id}:{pad.drill_rotation_udeg}"
                    )
            if pad is not None:
                if pad.locked:
                    unsupported.append(f"locked-pad-metadata-unrepresented:{pad.pad_id}")
                if (
                    pad.net_id is not None
                    and (component.component_id, pin.number) not in pin_memberships
                ):
                    unsupported.append(f"pad-only-net-binding-unrepresented:{pad.pad_id}")
            pins.append(
                VerificationPin(
                    number=pin.number,
                    name=pin.name,
                    electrical_type=electrical_type,
                    required=pin.required,
                    pad_center=pad_center,
                    pad_diameter_nm=pad_diameter_nm,
                    layers=pad_layers,
                    pad_drill_nm=pad_drill_nm,
                    pad_number=pin.pad_number,
                )
            )
        components.append(
            VerificationComponent(
                component.component_id,
                component.reference,
                component.value,
                component.footprint_id,
                component.manufacturer_part_number,
                component.datasheet_sha256,
                component.pin_map_sha256,
                tuple(pins),
            )
        )

    tracks: list[VerificationTrack] = []
    for track in normalized.tracks:
        if track.locked:
            unsupported.append(f"locked-track-metadata-unrepresented:{track.track_id}")
        tracks.append(
            VerificationTrack(
                track.track_id,
                track.net_id,
                track.layer,
                VerificationPoint(track.start.x, track.start.y),
                VerificationPoint(track.end.x, track.end.y),
                track.width_nm,
            )
        )

    vias: list[VerificationVia] = []
    for via in normalized.vias:
        if via.locked:
            unsupported.append(f"locked-via-metadata-unrepresented:{via.via_id}")
        vias.append(
            VerificationVia(
                via.via_id,
                via.net_id,
                VerificationPoint(via.center.x, via.center.y),
                via.diameter_nm,
                via.drill_nm,
                via.layers,
            )
        )

    zones: list[VerificationZone] = []
    for zone in normalized.zones:
        if zone.min_thickness_nm != 100_000:
            unsupported.append(f"zone-minimum-thickness-unrepresented:{zone.zone_id}")
        if zone.priority:
            unsupported.append(f"zone-priority-unrepresented:{zone.zone_id}")
        if zone.locked:
            unsupported.append(f"locked-zone-metadata-unrepresented:{zone.zone_id}")
        zones.append(
            VerificationZone(
                zone_id=zone.zone_id,
                net_id=zone.net_id,
                layer=zone.layer,
                outline=BoardOutline(
                    tuple(VerificationPoint(point.x, point.y) for point in zone.outline)
                ),
                clearance_nm=zone.clearance_nm,
                fill_state=VerificationZoneFillState(zone.fill_state.value),
                fill_evidence=(
                    None
                    if zone.fill_evidence is None
                    else VerificationZoneFillEvidence(
                        source_graph_hash=zone.fill_evidence.source_graph_hash,
                        source_revision=zone.fill_evidence.source_revision,
                        fill_engine_id=zone.fill_evidence.fill_engine_id,
                        fill_engine_revision=zone.fill_evidence.fill_engine_revision,
                        filled_geometry_hash=zone.fill_evidence.filled_geometry_hash,
                        evidence_hash=zone.fill_evidence.evidence_hash,
                    )
                ),
            )
        )

    holes = tuple(
        VerificationHole(
            hole_id=hole.hole_id,
            component_id=hole.component_id,
            center=VerificationPoint(hole.center.x, hole.center.y),
            diameter_nm=hole.diameter_nm,
            plated=hole.plated,
            pad_id=hole.pad_id,
            drill_x_nm=hole.drill_x_nm,
            drill_y_nm=hole.drill_y_nm,
            drill_rotation_udeg=hole.drill_rotation_udeg,
        )
        for hole in normalized.holes
    )
    physical_pads = tuple(
        VerificationPhysicalPad(
            pad_id=pad.pad_id,
            component_id=pad.component_id,
            pad_number=pad.pad_number,
            net_id=pad.net_id,
            center=VerificationPoint(pad.center.x, pad.center.y),
            size_x_nm=pad.size_x_nm,
            size_y_nm=pad.size_y_nm,
            shape=PadShape(pad.shape),
            rotation_udeg=pad.rotation_udeg,
            layers=pad.layers,
            drill_nm=pad.pad_drill_nm,
            drill_x_nm=pad.drill_x_nm,
            drill_y_nm=pad.drill_y_nm,
            drill_rotation_udeg=pad.drill_rotation_udeg,
            shared_land_group_id=pad.shared_land_group_id,
        )
        for pad in normalized.pads
    )
    unsupported.extend(
        f"locked-hole-metadata-unrepresented:{hole.hole_id}"
        for hole in normalized.holes
        if hole.locked
    )
    unsupported.extend(
        f"schematic-wire-unrepresented:{wire.wire_id}" for wire in normalized.schematic_wires
    )
    unsupported.extend(
        f"schematic-junction-unrepresented:{junction.junction_id}"
        for junction in normalized.schematic_junctions
    )

    return BoardGraph(
        3,
        normalized.project_id,
        revision,
        normalized.layers,
        BoardOutline(
            tuple(VerificationPoint(point.x, point.y) for point in normalized.board_outline)
        ),
        tuple(components),
        tuple(
            VerificationNet(
                net.net_id,
                net.name,
                tuple(
                    NetConnection(member.component_id, member.pin_number) for member in net.members
                ),
            )
            for net in normalized.nets
        ),
        tuple(tracks),
        tuple(vias),
        tuple(unsupported),
        tuple(zones),
        holes,
        physical_pads,
    ).normalized()


def revision_to_verification_board(revision: DesignRevision) -> BoardGraph:
    """Adapt a committed canonical revision with its exact revision identity."""

    if type(revision) is not DesignRevision:
        raise InvariantViolation("revision must be exact DesignRevision")
    return to_verification_board(revision.graph, revision=revision.revision_hash)

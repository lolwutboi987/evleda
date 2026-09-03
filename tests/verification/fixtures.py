"""Small immutable board-graph fixtures with integer nanometre geometry."""

from __future__ import annotations

from dataclasses import replace

from backend.verification import (
    BoardGraph,
    BoardOutline,
    Component,
    Net,
    NetConnection,
    Pin,
    PinElectricalType,
    PointNm,
    Track,
    Via,
    Zone,
    ZoneFillEvidence,
    ZoneFillState,
    zone_fill_evidence_hash,
    zone_filled_geometry_hash,
)

MM = 1_000_000
DATASHEET_HASH = "1" * 64
PIN_MAP_HASH = "2" * 64


def verified_zone(
    zone_id: str,
    net_id: str,
    layer: str,
    outline: BoardOutline,
    clearance_nm: int = 0,
) -> Zone:
    """Build a fixture zone with internally consistent external-fill evidence."""

    intent = Zone(zone_id, net_id, layer, outline, clearance_nm)
    provisional = ZoneFillEvidence(
        source_graph_hash="a" * 64,
        source_revision="b" * 64,
        fill_engine_id="fixture-fill-engine",
        fill_engine_revision="fixture-v1",
        filled_geometry_hash=zone_filled_geometry_hash(intent),
        evidence_hash="0" * 64,
    )
    evidence = replace(provisional, evidence_hash=zone_fill_evidence_hash(provisional))
    return replace(
        intent,
        fill_state=ZoneFillState.VERIFIED_FILLED,
        fill_evidence=evidence,
    )


def _component(
    component_id: str,
    reference: str,
    pin_type: PinElectricalType,
    point: PointNm,
    *,
    footprint: str = "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    mpn: str = "SN74LVC1G17DBVR",
    datasheet_hash: str = DATASHEET_HASH,
    pin_map_hash: str = PIN_MAP_HASH,
) -> Component:
    return Component(
        component_id,
        reference,
        "logic",
        footprint,
        mpn,
        datasheet_hash,
        pin_map_hash,
        (
            Pin(
                "1",
                "IO",
                pin_type,
                True,
                point,
                800_000,
                ("F.Cu",),
            ),
        ),
    )


def safe_board() -> BoardGraph:
    driver = _component("cmp-driver", "U1", PinElectricalType.OUTPUT, PointNm(4 * MM, 5 * MM))
    sink = _component("cmp-sink", "U2", PinElectricalType.INPUT, PointNm(8 * MM, 5 * MM))
    signal = Net(
        "net-signal",
        "SIGNAL",
        (NetConnection("cmp-driver", "1"), NetConnection("cmp-sink", "1")),
    )
    return BoardGraph(
        3,
        "fixture-safe",
        "rev-001",
        ("F.Cu", "B.Cu"),
        BoardOutline(
            (
                PointNm(0, 0),
                PointNm(12 * MM, 0),
                PointNm(12 * MM, 10 * MM),
                PointNm(0, 10 * MM),
            )
        ),
        (driver, sink),
        (signal,),
        (
            Track(
                "track-signal",
                "net-signal",
                "F.Cu",
                PointNm(4 * MM, 5 * MM),
                PointNm(8 * MM, 5 * MM),
                200_000,
            ),
        ),
        (),
    )


def reordered_safe_board() -> BoardGraph:
    board = safe_board()
    net = board.nets[0]
    track = board.tracks[0]
    vertices = board.outline.vertices
    return replace(
        board,
        layers=tuple(reversed(board.layers)),
        outline=BoardOutline((vertices[2], vertices[1], vertices[0], vertices[3])),
        components=tuple(reversed(board.components)),
        nets=(replace(net, connections=tuple(reversed(net.connections))),),
        tracks=(replace(track, start=track.end, end=track.start),),
    )


def broken_board() -> BoardGraph:
    board = safe_board()
    driver = board.components[0]
    sink = board.components[1]
    broken_sink = replace(
        sink,
        footprint="",
        manufacturer_part_number="",
        datasheet_sha256="not-a-hash",
        pin_map_sha256="",
        pins=sink.pins
        + (
            Pin(
                "2",
                "FLOATING_INPUT",
                PinElectricalType.INPUT,
                True,
                PointNm(8 * MM, 6 * MM),
                800_000,
                ("F.Cu",),
            ),
        ),
    )
    other_driver = _component(
        "cmp-driver-2", "U3", PinElectricalType.OUTPUT, PointNm(9 * MM, 5 * MM)
    )
    contended = replace(
        board.nets[0],
        connections=board.nets[0].connections + (NetConnection("cmp-driver-2", "1"),),
    )
    dangling = Net("net-dangling", "DANGLING", (NetConnection("cmp-sink", "2"),))
    return replace(
        board,
        components=(driver, broken_sink, other_driver),
        nets=(contended, dangling),
        tracks=(replace(board.tracks[0], width_nm=100_000),),
        vias=(
            Via(
                "via-small-ring",
                "net-signal",
                PointNm(6 * MM, 5 * MM),
                300_000,
                200_000,
                ("F.Cu", "B.Cu"),
            ),
        ),
    )


def clearance_board(center_distance_nm: int) -> BoardGraph:
    return BoardGraph(
        3,
        "fixture-clearance",
        "rev-001",
        ("F.Cu", "B.Cu"),
        BoardOutline(
            (
                PointNm(0, 0),
                PointNm(12 * MM, 0),
                PointNm(12 * MM, 10 * MM),
                PointNm(0, 10 * MM),
            )
        ),
        (),
        (Net("net-a", "A", ()), Net("net-b", "B", ())),
        (
            Track(
                "track-a",
                "net-a",
                "F.Cu",
                PointNm(3 * MM, 5 * MM),
                PointNm(9 * MM, 5 * MM),
                200_000,
            ),
            Track(
                "track-b",
                "net-b",
                "F.Cu",
                PointNm(3 * MM, 5 * MM + center_distance_nm),
                PointNm(9 * MM, 5 * MM + center_distance_nm),
                200_000,
            ),
        ),
        (),
    )


def disconnected_board() -> BoardGraph:
    board = safe_board()
    track = board.tracks[0]
    return replace(board, tracks=(replace(track, end=PointNm(6 * MM, 5 * MM)),))


def invalid_outline_board() -> BoardGraph:
    board = safe_board()
    return replace(
        board,
        outline=BoardOutline(
            (
                PointNm(0, 0),
                PointNm(12 * MM, 10 * MM),
                PointNm(0, 10 * MM),
                PointNm(12 * MM, 0),
            )
        ),
    )


def drilled_pad_board(copper_diameter_nm: int, drill_nm: int) -> BoardGraph:
    board = safe_board()
    component = board.components[0]
    pin = replace(
        component.pins[0],
        pad_diameter_nm=copper_diameter_nm,
        pad_drill_nm=drill_nm,
    )
    return replace(
        board,
        components=(replace(component, pins=(pin,)), board.components[1]),
    )


def via_attachment_board(*, attached: bool) -> BoardGraph:
    board = safe_board()
    center = PointNm(6 * MM, 5 * MM) if attached else PointNm(6 * MM, 8 * MM)
    return replace(
        board,
        vias=(Via("via-signal", "net-signal", center, 400_000, 200_000, ("F.Cu", "B.Cu")),),
    )


def zone_pad_clearance_board(boundary_to_center_nm: int) -> BoardGraph:
    pad_component = _component(
        "cmp-pad",
        "U1",
        PinElectricalType.OUTPUT,
        PointNm(4 * MM + boundary_to_center_nm, 3 * MM),
    )
    return BoardGraph(
        3,
        "fixture-zone-pad-clearance",
        "rev-001",
        ("F.Cu", "B.Cu"),
        BoardOutline(
            (
                PointNm(0, 0),
                PointNm(12 * MM, 0),
                PointNm(12 * MM, 10 * MM),
                PointNm(0, 10 * MM),
            )
        ),
        (pad_component,),
        (
            Net("net-zone", "ZONE", ()),
            Net("net-pad", "PAD", (NetConnection("cmp-pad", "1"),)),
        ),
        (),
        (),
        zones=(
            verified_zone(
                "zone-a",
                "net-zone",
                "F.Cu",
                BoardOutline(
                    (
                        PointNm(2 * MM, 2 * MM),
                        PointNm(4 * MM, 2 * MM),
                        PointNm(4 * MM, 4 * MM),
                        PointNm(2 * MM, 4 * MM),
                    )
                ),
                150_000,
            ),
        ),
    )


def zone_pair_clearance_board(gap_nm: int, *, reverse: bool = False) -> BoardGraph:
    zones = (
        verified_zone(
            "zone-a",
            "net-a",
            "F.Cu",
            BoardOutline(
                (
                    PointNm(2 * MM, 2 * MM),
                    PointNm(4 * MM, 2 * MM),
                    PointNm(4 * MM, 4 * MM),
                    PointNm(2 * MM, 4 * MM),
                )
            ),
            0,
        ),
        verified_zone(
            "zone-b",
            "net-b",
            "F.Cu",
            BoardOutline(
                (
                    PointNm(4 * MM + gap_nm, 2 * MM),
                    PointNm(6 * MM + gap_nm, 2 * MM),
                    PointNm(6 * MM + gap_nm, 4 * MM),
                    PointNm(4 * MM + gap_nm, 4 * MM),
                )
            ),
            0,
        ),
    )
    return BoardGraph(
        3,
        "fixture-zone-pair-clearance",
        "rev-001",
        ("F.Cu", "B.Cu"),
        BoardOutline(
            (
                PointNm(0, 0),
                PointNm(12 * MM, 0),
                PointNm(12 * MM, 10 * MM),
                PointNm(0, 10 * MM),
            )
        ),
        (),
        (Net("net-a", "A", ()), Net("net-b", "B", ())),
        (),
        (),
        zones=tuple(reversed(zones)) if reverse else zones,
    )


def zone_edge_clearance_board(edge_distance_nm: int) -> BoardGraph:
    return BoardGraph(
        3,
        "fixture-zone-edge-clearance",
        "rev-001",
        ("F.Cu", "B.Cu"),
        BoardOutline(
            (
                PointNm(0, 0),
                PointNm(12 * MM, 0),
                PointNm(12 * MM, 10 * MM),
                PointNm(0, 10 * MM),
            )
        ),
        (),
        (Net("net-zone", "ZONE", ()),),
        (),
        (),
        zones=(
            verified_zone(
                "zone-edge",
                "net-zone",
                "F.Cu",
                BoardOutline(
                    (
                        PointNm(edge_distance_nm, 2 * MM),
                        PointNm(3 * MM, 2 * MM),
                        PointNm(3 * MM, 4 * MM),
                        PointNm(edge_distance_nm, 4 * MM),
                    )
                ),
            ),
        ),
    )

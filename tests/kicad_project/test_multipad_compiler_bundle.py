from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace

import pytest

import backend.kicad_project.bundle as kicad_project_bundle
from backend.design_kernel import (
    Component,
    DesignGraph,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    Net,
    PinDefinition,
    PinRef,
    PointNm,
)
from backend.kicad_compile import compile_design_graph, verify_compiled_project
from backend.kicad_io import Pad, PadKind, export_board, import_board
from backend.kicad_project import (
    ProjectBundleInput,
    ProjectInvariantError,
    SchematicNet,
    import_project_bundle,
    round_trip_project_bundle,
)


def _pad(
    pad_id: str,
    number: str,
    center: PointNm,
    net_id: str,
    *,
    size_x_nm: int = 600_000,
    size_y_nm: int = 1_200_000,
    shape: str = "rect",
    rotation_udeg: int = 0,
    drill_x_nm: int = 0,
    drill_y_nm: int = 0,
    shared_land_group_id: str | None = None,
) -> FootprintPad:
    return FootprintPad(
        pad_id=pad_id,
        component_id="usb-c-j1",
        pad_number=number,
        center=center,
        size_x_nm=size_x_nm,
        size_y_nm=size_y_nm,
        shape=shape,
        rotation_udeg=rotation_udeg,
        layers=("F.Cu", "B.Cu") if drill_x_nm else ("F.Cu",),
        pad_drill_nm=min(drill_x_nm, drill_y_nm) if drill_x_nm else 0,
        net_id=net_id,
        drill_x_nm=drill_x_nm,
        drill_y_nm=drill_y_nm,
        drill_rotation_udeg=rotation_udeg if drill_x_nm != drill_y_nm else 0,
        shared_land_group_id=shared_land_group_id,
    )


def _usb_c_graph() -> DesignGraph:
    pins = (
        PinDefinition("A1", "VBUS_A", "power_in", "A1"),
        PinDefinition("B12", "VBUS_B", "power_in", "B12"),
        PinDefinition("GND", "GND", "power_in", "GND"),
        PinDefinition("S1", "SHIELD", "passive", "S1"),
        PinDefinition("VBUS", "VBUS", "power_in", "VBUS"),
    )
    component = Component(
        "usb-c-j1",
        "J1",
        "USB_C_RECEPTACLE_MULTIPAD",
        "USB-C-MULTIPAD-FIXTURE",
        "USB-C SMT/PTH",
        "Connector_Generic:USB_C_Multipad",
        "Connector_USB:USB_C_Multipad",
        "a" * 64,
        "b" * 64,
        pins,
    )
    vbus_members = (
        PinRef(component.component_id, "A1"),
        PinRef(component.component_id, "B12"),
        PinRef(component.component_id, "VBUS"),
    )
    gnd_members = (
        PinRef(component.component_id, "GND"),
        PinRef(component.component_id, "S1"),
    )

    pads: list[FootprintPad] = []
    for index, x_nm in enumerate((17_000_000, 18_000_000, 22_000_000, 23_000_000), 1):
        pads.append(
            _pad(
                f"pad-vbus-{index}",
                "VBUS",
                PointNm(x_nm, 8_500_000),
                "net-vbus",
            )
        )
    for index, x_nm in enumerate((17_000_000, 18_000_000, 22_000_000, 23_000_000), 1):
        pads.append(
            _pad(
                f"pad-gnd-{index}",
                "GND",
                PointNm(x_nm, 10_000_000),
                "net-gnd",
            )
        )

    slot_centers = (
        PointNm(15_000_000, 12_000_000),
        PointNm(15_000_000, 15_000_000),
        PointNm(25_000_000, 12_000_000),
        PointNm(25_000_000, 15_000_000),
    )
    for index, center in enumerate(slot_centers, 1):
        pads.append(
            _pad(
                f"pad-shell-{index}",
                "S1",
                center,
                "net-gnd",
                size_x_nm=1_200_000,
                size_y_nm=1_700_000,
                shape="oval",
                rotation_udeg=90_000_000,
                drill_x_nm=600_000,
                drill_y_nm=1_100_000,
            )
        )

    shared_center = PointNm(20_000_000, 7_000_000)
    for number in ("A1", "B12"):
        pads.append(
            _pad(
                f"pad-{number.lower()}",
                number,
                shared_center,
                "net-vbus",
                shared_land_group_id="shared-vbus-land",
            )
        )

    plated_slots = tuple(
        FootprintHole(
            hole_id=f"hole-shell-{index}",
            component_id=component.component_id,
            center=center,
            diameter_nm=600_000,
            plated=True,
            pad_id=f"pad-shell-{index}",
            drill_x_nm=600_000,
            drill_y_nm=1_100_000,
            drill_rotation_udeg=90_000_000,
        )
        for index, center in enumerate(slot_centers, 1)
    )
    locator_holes = (
        FootprintHole(
            "hole-locator-left",
            component.component_id,
            PointNm(18_000_000, 14_000_000),
            650_000,
        ),
        FootprintHole(
            "hole-locator-right",
            component.component_id,
            PointNm(22_000_000, 14_000_000),
            650_000,
        ),
    )
    return DesignGraph(
        schema_version=1,
        project_id="usb-c-multipad-project",
        layers=("F.Cu", "B.Cu"),
        board_outline=(
            PointNm(0, 0),
            PointNm(40_000_000, 0),
            PointNm(40_000_000, 25_000_000),
            PointNm(0, 25_000_000),
        ),
        components=(component,),
        nets=(
            Net("net-gnd", "GND", gnd_members),
            Net("net-vbus", "VBUS", vbus_members),
        ),
        placements=(
            FootprintPlacement(component.component_id, PointNm(20_000_000, 12_000_000)),
        ),
        pads=tuple(pads),
        holes=(*plated_slots, *locator_holes),
    )


def _compiled_source(stem: str = "usb_c_multipad") -> ProjectBundleInput:
    return compile_design_graph(_usb_c_graph(), stem).bundle


def _mutate_first_pad(
    source: ProjectBundleInput,
    *,
    number: str,
    replacement: Callable[[Pad], Pad],
) -> ProjectBundleInput:
    board = import_board(source.board_payload).board
    footprint = board.footprints[0]
    changed = False
    pads: list[Pad] = []
    for pad in footprint.pads:
        if not changed and pad.number == number:
            pad = replacement(pad)
            changed = True
        pads.append(pad)
    assert changed
    mutated = replace(
        board,
        footprints=(replace(footprint, pads=tuple(pads)),),
    )
    return replace(source, board_payload=export_board(mutated).payload)


def test_compiled_usb_c_bundle_import_and_reopen_preserve_every_physical_contact() -> None:
    graph = _usb_c_graph()
    compiled = compile_design_graph(graph, "usb_c_multipad")
    verification = verify_compiled_project(graph, compiled)
    imported = import_project_bundle(compiled.bundle)
    round_trip = round_trip_project_bundle(compiled.bundle)

    assert verification.semantic_parity
    assert round_trip.evidence.semantic_parity
    assert imported.bundle.normalized_ir_sha256 == round_trip.reparsed.bundle.normalized_ir_sha256

    for bundle in (imported.bundle, round_trip.reparsed.bundle):
        symbol = bundle.schematic.symbols[0]
        footprint = bundle.board.footprints[0]
        assert (symbol.reference, symbol.value, symbol.footprint) == (
            footprint.reference,
            footprint.value,
            footprint.library_id,
        )
        assert {pin.number for pin in symbol.pins} == {"A1", "B12", "GND", "S1", "VBUS"}

        electrical_pads = tuple(pad for pad in footprint.pads if pad.kind is not PadKind.NPTH)
        npth = tuple(pad for pad in footprint.pads if pad.kind is PadKind.NPTH)
        assert len(electrical_pads) == 14
        assert len(npth) == 2
        assert all(pad.number == "" and pad.net_id is None for pad in npth)
        assert {number: sum(pad.number == number for pad in electrical_pads) for number in (
            "VBUS",
            "GND",
            "S1",
        )} == {"VBUS": 4, "GND": 4, "S1": 4}
        assert len({pad.pad_id for pad in footprint.pads}) == 16

        shared = tuple(pad for pad in electrical_pads if pad.number in {"A1", "B12"})
        assert len(shared) == 2
        assert {pad.number for pad in shared} == {"A1", "B12"}
        assert shared[0].position == shared[1].position
        assert shared[0].net_id == shared[1].net_id

        slots = tuple(pad for pad in electrical_pads if pad.number == "S1")
        assert all(pad.kind is PadKind.THROUGH_HOLE for pad in slots)
        assert {
            (pad.size_x_nm, pad.size_y_nm, pad.drill_x_nm, pad.drill_y_nm)
            for pad in slots
        } == {(1_200_000, 1_700_000, 600_000, 1_100_000)}


def test_repeated_logical_pad_rejects_mixed_net_semantics() -> None:
    source = _compiled_source()
    board = import_board(source.board_payload).board
    vbus_net_id = next(net.net_id for net in board.nets if net.name == "VBUS")
    malformed = _mutate_first_pad(
        source,
        number="S1",
        replacement=lambda pad: replace(pad, net_id=vbus_net_id),
    )
    with pytest.raises(ProjectInvariantError, match="must have identical net semantics"):
        import_project_bundle(malformed)


def test_repeated_logical_pad_rejects_ambiguous_pin_metadata() -> None:
    source = _compiled_source()
    malformed = _mutate_first_pad(
        source,
        number="VBUS",
        replacement=lambda pad: replace(pad, pin_function="VBUS_WRONG"),
    )
    with pytest.raises(ProjectInvariantError, match="ambiguous pin function"):
        import_project_bundle(malformed)


def test_coincident_distinct_contacts_reject_mixed_net_ownership() -> None:
    source = _compiled_source()
    board = import_board(source.board_payload).board
    gnd_net_id = next(net.net_id for net in board.nets if net.name == "GND")
    malformed = _mutate_first_pad(
        source,
        number="B12",
        replacement=lambda pad: replace(pad, net_id=gnd_net_id),
    )
    with pytest.raises(ProjectInvariantError, match="pin/pad net mismatch|identical net semantics"):
        import_project_bundle(malformed)


def test_coincident_land_check_is_independent_of_per_pin_net_parity() -> None:
    source = _compiled_source()
    imported = import_project_bundle(source)
    board = imported.bundle.board
    gnd_net_id = next(net.net_id for net in board.nets if net.name == "GND")
    malformed = _mutate_first_pad(
        source,
        number="B12",
        replacement=lambda pad: replace(pad, net_id=gnd_net_id),
    )
    malformed_board = import_board(malformed.board_payload).board

    schematic = imported.bundle.schematic
    b12_ref = next(
        pin_ref
        for net in schematic.nets
        for pin_ref in net.pin_refs
        if pin_ref.pin_number == "B12"
    )
    moved_nets: list[SchematicNet] = []
    for net in schematic.nets:
        if net.name == "VBUS":
            pin_refs = tuple(item for item in net.pin_refs if item != b12_ref)
        elif net.name == "GND":
            pin_refs = tuple(sorted((*net.pin_refs, b12_ref)))
        else:
            pin_refs = net.pin_refs
        moved_nets.append(replace(net, pin_refs=pin_refs))
    malformed_schematic = replace(schematic, nets=tuple(moved_nets))

    with pytest.raises(
        ProjectInvariantError,
        match="coincident PCB lands.*identical net semantics",
    ):
        kicad_project_bundle._validate_schematic_board_parity(  # pyright: ignore[reportPrivateUsage]
            malformed_schematic,
            malformed_board,
        )

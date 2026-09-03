"""A compact routed two-layer design with slots, vias, zones, and a shared land."""

from __future__ import annotations

from backend.design_kernel import (
    Component,
    CopperZone,
    DesignGraph,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    Net,
    PinDefinition,
    PinRef,
    PointNm,
    SchematicJunction,
    SchematicWire,
    Track,
    Via,
)

DATASHEET = "a" * 64
PIN_MAP = "b" * 64


def _component(
    component_id: str,
    reference: str,
    value: str,
    footprint_id: str,
    symbol_id: str,
    pins: tuple[PinDefinition, ...],
) -> Component:
    return Component(
        component_id,
        reference,
        value,
        f"MPN-{reference}",
        "reviewed-package",
        symbol_id,
        footprint_id,
        DATASHEET,
        PIN_MAP,
        pins,
    )


def reference_graph() -> DesignGraph:
    j1 = _component(
        "component-j1",
        "J1",
        "POWER_IN",
        "Flux:Power_Input",
        "Flux:Power_Input_Symbol",
        (
            PinDefinition("1", "VIN", "power_out", "1"),
            PinDefinition("2", "GND", "power_out", "2"),
        ),
    )
    u1 = _component(
        "component-u1",
        "U1",
        "LOAD",
        "Flux:Load_SMD",
        "Flux:Load_Symbol",
        (
            PinDefinition("1", "VIN", "power_in", "1"),
            PinDefinition("2", "GND", "power_in", "2"),
        ),
    )
    sh1 = _component(
        "component-sh1",
        "SH1",
        "SHIELD",
        "Flux:Shield_Land",
        "Flux:Shield_Symbol",
        (
            PinDefinition("1", "SHIELD_A", "passive", "1"),
            PinDefinition("2", "SHIELD_B", "passive", "2"),
        ),
    )
    vin = Net(
        "net-vin",
        "VIN",
        (PinRef("component-j1", "1"), PinRef("component-u1", "1")),
    )
    gnd = Net(
        "net-gnd",
        "GND",
        (
            PinRef("component-j1", "2"),
            PinRef("component-sh1", "1"),
            PinRef("component-sh1", "2"),
            PinRef("component-u1", "2"),
        ),
    )
    j1_pad_1 = FootprintPad(
        "pad-j1-1",
        "component-j1",
        "1",
        PointNm(6_000_000, 8_000_000),
        2_400_000,
        3_000_000,
        "oval",
        0,
        ("F.Cu", "B.Cu"),
        900_000,
        "net-vin",
        False,
        900_000,
        1_500_000,
        0,
    )
    j1_pad_2 = FootprintPad(
        "pad-j1-2",
        "component-j1",
        "2",
        PointNm(6_000_000, 12_000_000),
        2_000_000,
        2_000_000,
        "circle",
        0,
        ("F.Cu", "B.Cu"),
        900_000,
        "net-gnd",
    )
    pads = (
        j1_pad_1,
        j1_pad_2,
        FootprintPad(
            "pad-u1-1",
            "component-u1",
            "1",
            PointNm(27_000_000, 9_000_000),
            1_200_000,
            1_600_000,
            "roundrect",
            0,
            ("F.Cu",),
            net_id="net-vin",
        ),
        FootprintPad(
            "pad-u1-2",
            "component-u1",
            "2",
            PointNm(27_000_000, 11_000_000),
            1_200_000,
            1_600_000,
            "rect",
            0,
            ("F.Cu",),
            net_id="net-gnd",
        ),
        FootprintPad(
            "pad-sh1-1",
            "component-sh1",
            "1",
            PointNm(35_000_000, 10_000_000),
            3_000_000,
            2_000_000,
            "rect",
            0,
            ("F.Cu",),
            net_id="net-gnd",
            shared_land_group_id="shield-land",
        ),
        FootprintPad(
            "pad-sh1-2",
            "component-sh1",
            "2",
            PointNm(35_000_000, 10_000_000),
            3_000_000,
            2_000_000,
            "rect",
            0,
            ("F.Cu",),
            net_id="net-gnd",
            shared_land_group_id="shield-land",
        ),
    )
    holes = (
        FootprintHole(
            "hole-j1-1",
            "component-j1",
            j1_pad_1.center,
            900_000,
            True,
            j1_pad_1.pad_id,
            drill_x_nm=900_000,
            drill_y_nm=1_500_000,
        ),
        FootprintHole(
            "hole-j1-2",
            "component-j1",
            j1_pad_2.center,
            900_000,
            True,
            j1_pad_2.pad_id,
        ),
        FootprintHole(
            "hole-j1-locate",
            "component-j1",
            PointNm(3_000_000, 10_000_000),
            1_000_000,
            drill_x_nm=1_000_000,
            drill_y_nm=1_600_000,
            drill_rotation_udeg=90_000_000,
        ),
    )
    return DesignGraph(
        1,
        "reference-power-board",
        ("F.Cu", "B.Cu"),
        (
            PointNm(0, 0),
            PointNm(40_000_000, 0),
            PointNm(40_000_000, 20_000_000),
            PointNm(0, 20_000_000),
        ),
        (j1, u1, sh1),
        (vin, gnd),
        (
            FootprintPlacement("component-j1", PointNm(6_000_000, 10_000_000)),
            FootprintPlacement("component-u1", PointNm(28_000_000, 10_000_000)),
            FootprintPlacement("component-sh1", PointNm(35_000_000, 10_000_000)),
        ),
        (
            Track(
                "track-vin-front",
                "net-vin",
                "F.Cu",
                PointNm(6_000_000, 8_000_000),
                PointNm(18_000_000, 8_000_000),
                300_000,
            ),
            Track(
                "track-vin-back",
                "net-vin",
                "B.Cu",
                PointNm(18_000_000, 8_000_000),
                PointNm(24_000_000, 8_000_000),
                300_000,
            ),
            Track(
                "track-vin-return-front",
                "net-vin",
                "F.Cu",
                PointNm(24_000_000, 8_000_000),
                PointNm(27_000_000, 9_000_000),
                300_000,
            ),
            Track(
                "track-gnd-left",
                "net-gnd",
                "F.Cu",
                PointNm(6_000_000, 12_000_000),
                PointNm(27_000_000, 11_000_000),
                300_000,
            ),
            Track(
                "track-gnd-right",
                "net-gnd",
                "F.Cu",
                PointNm(27_000_000, 11_000_000),
                PointNm(35_000_000, 10_000_000),
                300_000,
            ),
        ),
        pads,
        holes,
        (
            Via(
                "via-vin",
                "net-vin",
                PointNm(18_000_000, 8_000_000),
                800_000,
                400_000,
                ("F.Cu", "B.Cu"),
            ),
            Via(
                "via-vin-return",
                "net-vin",
                PointNm(24_000_000, 8_000_000),
                800_000,
                400_000,
                ("F.Cu", "B.Cu"),
            ),
        ),
        (
            CopperZone(
                "zone-gnd",
                "net-gnd",
                "F.Cu",
                (
                    PointNm(1_000_000, 1_000_000),
                    PointNm(39_000_000, 1_000_000),
                    PointNm(39_000_000, 19_000_000),
                    PointNm(1_000_000, 19_000_000),
                ),
                200_000,
                250_000,
            ),
        ),
        (
            SchematicWire(
                "wire-vin",
                "net-vin",
                (PointNm(10_160_000, 50_800_000), PointNm(30_480_000, 50_800_000)),
            ),
            SchematicWire(
                "wire-gnd-left",
                "net-gnd",
                (PointNm(10_160_000, 60_960_000), PointNm(20_320_000, 60_960_000)),
            ),
            SchematicWire(
                "wire-gnd-right",
                "net-gnd",
                (PointNm(20_320_000, 60_960_000), PointNm(30_480_000, 60_960_000)),
            ),
        ),
        (
            SchematicJunction(
                "junction-gnd",
                "net-gnd",
                PointNm(20_320_000, 60_960_000),
            ),
        ),
    )

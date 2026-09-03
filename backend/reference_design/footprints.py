"""Deterministic land patterns and placement for the reference power board.

All geometry is integer nanometres in absolute board coordinates.  The USB4105
contact lands, asymmetric shell slots, locating holes, and PCB-edge datum are
transcribed solely from the pinned public KiCad library footprint.  Its
repository revision and raw-file digest are pinned below.  This preserves the
public library geometry but makes no connector-fit or mechanical-mating claim.
Primary component evidence remains in :mod:`specification`.

Stable identifiers use ``pad:<component_id>:<logical-number>:<ordinal>``.
Ordinal zero is retained for single-pad logical pins so route and review
artifacts never depend on tuple position.
"""

from __future__ import annotations

from backend.design_kernel import (
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    PointNm,
)

from .specification import (
    BOARD_HEIGHT_NM,
    BOARD_WIDTH_NM,
    KEMET_C0G_FAMILY_SHA256,
    KEMET_T59X_SHA256,
    KICAD_FOOTPRINT_COMMIT,
    KICAD_USB4105_FOOTPRINT_SHA256,
    LP38692_SHA256,
    VISHAY_WSLP_SHA256,
    components,
)

NM_PER_MM = 1_000_000
PAD_ID_FORMAT = "pad:<component_id>:<logical-number>:<ordinal>"
HOLE_ID_FORMAT = "hole:<component_id>:<role>:<ordinal>"
FRONT_COPPER = ("F.Cu",)
THROUGH_COPPER = ("F.Cu", "B.Cu")

# (profile, repository-relative file, SHA-256 of raw file at the commit above)
KICAD_LIBRARY_PROVENANCE = (
    (
        "usb4105",
        "Connector_USB.pretty/USB_C_Receptacle_GCT_USB4105-xx-A_16P_"
        "TopMnt_Horizontal.kicad_mod",
        KICAD_USB4105_FOOTPRINT_SHA256,
    ),
    (
        "dda-leads",
        "Package_SO.pretty/Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm.kicad_mod",
        "a2de8e28dd9f6a17dc2592de4c8500ac34f85d12e9e90e9c6499dc9de4937d91",
    ),
    (
        "resistor-0603",
        "Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod",
        "7190ac4a00125b807e54129ef0d87d87f2a658eeb74d025a7028203419b09f23",
    ),
    (
        "capacitor-0805",
        "Capacitor_SMD.pretty/C_0805_2012Metric.kicad_mod",
        "62775a51fe74ba7f1b572de327bdbd3fc92582721b2abcaa47787865590d89cb",
    ),
    (
        "led-0603",
        "LED_SMD.pretty/LED_0603_1608Metric.kicad_mod",
        "7931ed1efba34cb13c8d74a60eb1dca4b0be57d950c38e08c3e7f007db500a1c",
    ),
    (
        "header-1x02",
        "Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical."
        "kicad_mod",
        "5301303268f72ba9cc94b7fdbac355951933e6854272ce8d300b679b86b5d45d",
    ),
    (
        "keystone-5015",
        "TestPoint.pretty/TestPoint_Keystone_5015_Micro_Mini.kicad_mod",
        "f14e0e7d28a0a75298142634f99f433f44d1ae9130852870e630df717f3bf647",
    ),
)

# (manufacturer-land profile, specification evidence ID, SHA-256 of that source).
# These profiles deliberately do not reuse KiCad-library identifiers: their copper
# lands are exact source geometry for the fitted MPNs or density-B policy stated
# by the named manufacturer evidence.
MANUFACTURER_LAND_PROVENANCE = (
    ("ti-lp38692-ndc", "src-ti-lp38692-datasheet", LP38692_SHA256),
    ("kemet-t598b-density-b", "src-kemet-t59x", KEMET_T59X_SHA256),
    ("vishay-wslp0603", "src-vishay-wslp", VISHAY_WSLP_SHA256),
    ("kemet-c1206-density-b", "src-kemet-c0g-family", KEMET_C0G_FAMILY_SHA256),
)

# (component_id, x_nm, y_nm, rotation_udeg).  This is public so routing and
# review code can bind evidence to the exact placement contract.
PLACEMENT_SPECIFICATIONS = (
    ("usb-j1", 3_675_000, 15_000_000, 90_000_000),
    ("efuse-u1", 17_000_000, 15_000_000, 0),
    ("ldo-u2", 28_000_000, 19_000_000, 180_000_000),
    ("tvs-d1", 10_200_000, 15_000_000, 90_000_000),
    ("cc-r1", 9_400_000, 12_250_000, 90_000_000),
    ("cc-r2", 9_400_000, 17_750_000, 90_000_000),
    ("ilim-r3", 22_000_000, 11_200_000, 0),
    ("ovc-r4", 21_500_000, 9_500_000, 0),
    ("ovc-r5", 24_500_000, 9_500_000, 0),
    ("en-hi-r6", 14_500_000, 9_500_000, 0),
    ("en-lo-r7", 17_500_000, 9_500_000, 0),
    ("led-r8", 37_000_000, 13_500_000, 0),
    ("cout-esr-r9", 27_250_000, 22_250_000, 270_000_000),
    ("cin-c1", 12_050_000, 15_000_000, 90_000_000),
    ("cldo-c2", 22_500_000, 19_000_000, 180_000_000),
    ("cout-c3", 29_250_000, 26_000_000, 0),
    ("dvdt-c4", 11_650_000, 10_750_000, 270_000_000),
    ("led-d2", 34_000_000, 13_500_000, 0),
    ("out-j2", 47_000_000, 13_730_000, 0),
    ("tp-1", 11_000_000, 23_000_000, 0),
    ("tp-2", 23_000_000, 23_000_000, 0),
    ("tp-3", 35_000_000, 23_000_000, 0),
    ("tp-4", 42_000_000, 23_000_000, 0),
)

USB_CONTACT_PAD_IDS = tuple(
    f"pad:usb-j1:{number}:0"
    for number in (
        "A1", "A4", "A5", "A6", "A7", "A8", "A9", "A12",
        "B1", "B4", "B5", "B6", "B7", "B8", "B9", "B12",
    )
)
USB_SHELL_PAD_IDS = tuple(f"pad:usb-j1:S1:{ordinal}" for ordinal in range(4))
USB_LOCATING_HOLE_IDS = tuple(f"hole:usb-j1:locating:{ordinal}" for ordinal in range(2))
HEADER_PAD_IDS = ("pad:out-j2:1:0", "pad:out-j2:2:0")


def _pad_id(component_id: str, pad_number: str, ordinal: int = 0) -> str:
    return f"pad:{component_id}:{pad_number}:{ordinal}"


def _hole_id(component_id: str, role: str, ordinal: int) -> str:
    return f"hole:{component_id}:{role}:{ordinal}"


def _transform(placement: FootprintPlacement, x_nm: int, y_nm: int) -> PointNm:
    """Transform a local point using one exact quadrant rotation."""

    rotation = placement.rotation_udeg
    if rotation == 0:
        dx, dy = x_nm, y_nm
    elif rotation == 90_000_000:
        dx, dy = -y_nm, x_nm
    elif rotation == 180_000_000:
        dx, dy = -x_nm, -y_nm
    elif rotation == 270_000_000:
        dx, dy = y_nm, -x_nm
    else:  # guarded by the private, constant placement table
        raise ValueError("reference footprints permit quadrant rotations only")
    return PointNm(placement.position.x + dx, placement.position.y + dy)


def _pad(
    placement: FootprintPlacement,
    pad_number: str,
    ordinal: int,
    x_nm: int,
    y_nm: int,
    size_x_nm: int,
    size_y_nm: int,
    *,
    shape: str = "rect",
    layers: tuple[str, ...] = FRONT_COPPER,
    drill_x_nm: int = 0,
    drill_y_nm: int = 0,
    drill_rotation_udeg: int = 0,
    shared_land_group_id: str | None = None,
) -> FootprintPad:
    absolute_rotation = (placement.rotation_udeg + drill_rotation_udeg) % 360_000_000
    return FootprintPad(
        _pad_id(placement.component_id, pad_number, ordinal),
        placement.component_id,
        pad_number,
        _transform(placement, x_nm, y_nm),
        size_x_nm,
        size_y_nm,
        shape,
        placement.rotation_udeg,
        layers,
        min(drill_x_nm, drill_y_nm) if drill_x_nm and drill_y_nm else 0,
        None,
        False,
        drill_x_nm,
        drill_y_nm,
        absolute_rotation if drill_x_nm else 0,
        shared_land_group_id,
    )


def _hole_for_pad(pad: FootprintPad, role: str, ordinal: int) -> FootprintHole:
    return FootprintHole(
        _hole_id(pad.component_id, role, ordinal),
        pad.component_id,
        pad.center,
        pad.pad_drill_nm,
        True,
        pad.pad_id,
        False,
        pad.drill_x_nm,
        pad.drill_y_nm,
        pad.drill_rotation_udeg,
    )


def _usb4105(
    placement: FootprintPlacement,
) -> tuple[tuple[FootprintPad, ...], tuple[FootprintHole, ...]]:
    # Local geometry follows only the pinned public KiCad footprint.  A1/B12,
    # A4/B9, A9/B4, and A12/B1 are distinct logical contacts sharing four
    # physical lands; explicit group IDs are required by the canonical graph.
    contact_geometry = (
        ("A1", -3_200_000, 600_000, "usb-j1-shared-gnd-left"),
        ("A4", -2_400_000, 600_000, "usb-j1-shared-vbus-left"),
        ("A5", -1_250_000, 300_000, None),
        ("A6", -250_000, 300_000, None),
        ("A7", 250_000, 300_000, None),
        ("A8", 1_250_000, 300_000, None),
        ("A9", 2_400_000, 600_000, "usb-j1-shared-vbus-right"),
        ("A12", 3_200_000, 600_000, "usb-j1-shared-gnd-right"),
        ("B1", 3_200_000, 600_000, "usb-j1-shared-gnd-right"),
        ("B4", 2_400_000, 600_000, "usb-j1-shared-vbus-right"),
        ("B5", 1_750_000, 300_000, None),
        ("B6", 750_000, 300_000, None),
        ("B7", -750_000, 300_000, None),
        ("B8", -1_750_000, 300_000, None),
        ("B9", -2_400_000, 600_000, "usb-j1-shared-vbus-left"),
        ("B12", -3_200_000, 600_000, "usb-j1-shared-gnd-left"),
    )
    pads = [
        _pad(
            placement,
            number,
            0,
            x_nm,
            -3_680_000,
            width_nm,
            1_150_000,
            shared_land_group_id=group_id,
        )
        for number, x_nm, width_nm, group_id in contact_geometry
    ]

    # The two rear slots and two front slots have different public-library land
    # and drill lengths.  Both copper and oval drills are preserved exactly;
    # their suitability for a fabricated board and fitted connector is not.
    shell_geometry = (
        (-4_320_000, -3_105_000, 1_000_000, 2_100_000, 600_000, 1_700_000),
        (4_320_000, -3_105_000, 1_000_000, 2_100_000, 600_000, 1_700_000),
        (-4_320_000, 1_075_000, 1_000_000, 1_800_000, 600_000, 1_400_000),
        (4_320_000, 1_075_000, 1_000_000, 1_800_000, 600_000, 1_400_000),
    )
    shell_pads = tuple(
        _pad(
            placement,
            "S1",
            ordinal,
            x_nm,
            y_nm,
            size_x_nm,
            size_y_nm,
            shape="oval",
            layers=THROUGH_COPPER,
            drill_x_nm=drill_x_nm,
            drill_y_nm=drill_y_nm,
        )
        for ordinal, (
            x_nm,
            y_nm,
            size_x_nm,
            size_y_nm,
            drill_x_nm,
            drill_y_nm,
        ) in enumerate(shell_geometry)
    )
    pads.extend(shell_pads)
    plated_holes = tuple(
        _hole_for_pad(pad, "shell-slot", ordinal)
        for ordinal, pad in enumerate(shell_pads)
    )
    locating_holes = tuple(
        FootprintHole(
            _hole_id("usb-j1", "locating", ordinal),
            "usb-j1",
            _transform(placement, x_nm, -2_605_000),
            650_000,
            False,
            None,
            False,
            650_000,
            650_000,
            0,
        )
        for ordinal, x_nm in enumerate((-2_890_000, 2_890_000))
    )
    return tuple(pads), plated_holes + locating_holes


def _dda(placement: FootprintPlacement) -> tuple[FootprintPad, ...]:
    pin_geometry = (
        ("1", -2_700_000, -1_905_000),
        ("2", -2_700_000, -635_000),
        ("3", -2_700_000, 635_000),
        ("4", -2_700_000, 1_905_000),
        ("5", 2_700_000, 1_905_000),
        ("6", 2_700_000, 635_000),
        ("7", 2_700_000, -635_000),
        ("8", 2_700_000, -1_905_000),
    )
    pads = tuple(
        _pad(placement, number, 0, x_nm, y_nm, 1_550_000, 600_000)
        for number, x_nm, y_nm in pin_geometry
    )
    # Pinned KiCad Texas_HSOP DDA policy separates the 2.95 x 4.90 mm copper
    # land from its 2.60 x 3.10 mm mask/paste apertures.  FootprintPad models
    # copper, so using the smaller aperture dimensions here would be a layer
    # conflation.  The EP is soldered to ground by the circuit binding.
    return pads + (_pad(placement, "9", 0, 0, 0, 2_950_000, 4_900_000),)


def _lp38692_ndc(placement: FootprintPlacement) -> tuple[FootprintPad, ...]:
    """Return TI LP38692 NDC copper lands with the tab bound to pin 5."""

    # At the prescribed 180-degree placement, these local positions yield the
    # source-checked global pin row 30.250, 28.750, 27.250, and 25.750 mm.
    pin_row = tuple(
        _pad(placement, str(number), 0, x_nm, 0, 1_000_000, 1_500_000)
        for number, x_nm in enumerate((-2_250_000, -750_000, 750_000, 2_250_000), start=1)
    )
    return pin_row + (_pad(placement, "5", 0, 0, 6_300_000, 3_300_000, 1_500_000),)


def _two_terminal(
    placement: FootprintPlacement,
    *,
    pitch_nm: int,
    size_x_nm: int,
    size_y_nm: int,
    reverse_local_axis: bool = False,
) -> tuple[FootprintPad, ...]:
    half_pitch = pitch_nm // 2
    pin_one_x_nm, pin_two_x_nm = (
        (half_pitch, -half_pitch) if reverse_local_axis else (-half_pitch, half_pitch)
    )
    return (
        _pad(placement, "1", 0, pin_one_x_nm, 0, size_x_nm, size_y_nm),
        _pad(placement, "2", 0, pin_two_x_nm, 0, size_x_nm, size_y_nm),
    )


def _header(
    placement: FootprintPlacement,
) -> tuple[tuple[FootprintPad, ...], tuple[FootprintHole, ...]]:
    pad_one = _pad(
        placement,
        "1",
        0,
        0,
        0,
        1_700_000,
        1_700_000,
        layers=THROUGH_COPPER,
        drill_x_nm=1_100_000,
        drill_y_nm=1_100_000,
    )
    pad_two = _pad(
        placement,
        "2",
        0,
        0,
        2_540_000,
        1_700_000,
        1_700_000,
        shape="circle",
        layers=THROUGH_COPPER,
        drill_x_nm=1_100_000,
        drill_y_nm=1_100_000,
    )
    pads = (pad_one, pad_two)
    return pads, tuple(_hole_for_pad(pad, "pin", ordinal) for ordinal, pad in enumerate(pads))


def build_footprints(
) -> tuple[tuple[FootprintPlacement, ...], tuple[FootprintPad, ...], tuple[FootprintHole, ...]]:
    """Build all 23 placed component land patterns in stable reference order."""

    placement_specs = {item[0]: item[1:] for item in PLACEMENT_SPECIFICATIONS}
    placements = tuple(
        FootprintPlacement(
            component.component_id,
            PointNm(
                placement_specs[component.component_id][0],
                placement_specs[component.component_id][1],
            ),
            placement_specs[component.component_id][2],
            "front",
            False,
        )
        for component in components()
    )
    placement_index = {placement.component_id: placement for placement in placements}
    pads: list[FootprintPad] = []
    holes: list[FootprintHole] = []

    usb_pads, usb_holes = _usb4105(placement_index["usb-j1"])
    pads.extend(usb_pads)
    holes.extend(usb_holes)
    pads.extend(_dda(placement_index["efuse-u1"]))
    pads.extend(_lp38692_ndc(placement_index["ldo-u2"]))
    # Nexperia DFN1610-2 Fig. 11 copper land: 1.25 mm pitch and 0.70 x 1.20 mm.
    # The smaller 0.60 x 1.10 mm dimensions are not copper-land dimensions.
    pads.extend(
        _two_terminal(
            placement_index["tvs-d1"],
            pitch_nm=1_250_000,
            size_x_nm=700_000,
            size_y_nm=1_200_000,
        )
    )

    for component_id in (
        "cc-r1", "cc-r2", "ilim-r3", "ovc-r4", "ovc-r5", "en-hi-r6",
        "en-lo-r7", "led-r8",
    ):
        pads.extend(
            _two_terminal(
                placement_index[component_id],
                pitch_nm=1_650_000,
                size_x_nm=800_000,
                size_y_nm=950_000,
            )
        )
    # Vishay WSLP0603 source land pattern, not the generic KiCad 0603 profile.
    pads.extend(
        _two_terminal(
            placement_index["cout-esr-r9"],
            pitch_nm=1_520_000,
            size_x_nm=1_020_000,
            size_y_nm=1_020_000,
            # Route A is a KiCad-authored 270-degree placement: pad 1 is the
            # upper terminal at y=21.49 mm and pad 2 is the lower terminal at
            # y=23.01 mm.  Reversing this non-polar resistor's local axis here
            # preserves that reviewed physical pin/net binding exactly.
            reverse_local_axis=True,
        )
    )
    pads.extend(
        _two_terminal(
            placement_index["cin-c1"],
            pitch_nm=1_800_000,
            size_x_nm=1_000_000,
            size_y_nm=1_300_000,
        )
    )
    pads.extend(
        _two_terminal(
            placement_index["cldo-c2"],
            pitch_nm=2_050_000,
            size_x_nm=1_150_000,
            size_y_nm=1_450_000,
        )
    )
    # KEMET T598B density-B lands; pin 1 is the polarized positive terminal.
    pads.extend(
        _two_terminal(
            placement_index["cout-c3"],
            pitch_nm=2_920_000,
            size_x_nm=1_800_000,
            size_y_nm=2_230_000,
        )
    )
    pads.extend(
        _two_terminal(
            placement_index["dvdt-c4"],
            pitch_nm=3_000_000,
            size_x_nm=1_150_000,
            size_y_nm=1_800_000,
        )
    )
    pads.extend(
        _two_terminal(
            placement_index["led-d2"],
            pitch_nm=1_575_000,
            size_x_nm=875_000,
            size_y_nm=950_000,
        )
    )
    header_pads, header_holes = _header(placement_index["out-j2"])
    pads.extend(header_pads)
    holes.extend(header_holes)
    for component_id in ("tp-1", "tp-2", "tp-3", "tp-4"):
        pads.append(
            _pad(
                placement_index[component_id],
                "1",
                0,
                0,
                0,
                3_400_000,
                1_800_000,
            )
        )

    result = placements, tuple(pads), tuple(holes)
    if {placement.component_id for placement in placements} != {
        component.component_id for component in components()
    }:
        raise AssertionError("reference placement coverage drifted from the exact BOM")
    if any(
        not (0 <= pad.center.x <= BOARD_WIDTH_NM and 0 <= pad.center.y <= BOARD_HEIGHT_NM)
        for pad in result[1]
    ):
        raise AssertionError("reference pad center is outside the board")
    return result


def placement_by_component(component_id: str) -> FootprintPlacement:
    """Return the one exact placement for ``component_id``."""

    for placement in build_footprints()[0]:
        if placement.component_id == component_id:
            return placement
    raise KeyError(component_id)


def pads_by_component_and_number(
    component_id: str,
    pad_number: str,
) -> tuple[FootprintPad, ...]:
    """Return every physical pad for one logical component pad number."""

    matches = tuple(
        pad
        for pad in build_footprints()[1]
        if pad.component_id == component_id and pad.pad_number == pad_number
    )
    if not matches:
        raise KeyError((component_id, pad_number))
    return matches


def pad_by_id(pad_id: str) -> FootprintPad:
    """Return one physical pad by its stable ID."""

    for pad in build_footprints()[1]:
        if pad.pad_id == pad_id:
            return pad
    raise KeyError(pad_id)


__all__ = (
    "HEADER_PAD_IDS",
    "HOLE_ID_FORMAT",
    "KICAD_FOOTPRINT_COMMIT",
    "KICAD_LIBRARY_PROVENANCE",
    "MANUFACTURER_LAND_PROVENANCE",
    "NM_PER_MM",
    "PAD_ID_FORMAT",
    "PLACEMENT_SPECIFICATIONS",
    "USB_CONTACT_PAD_IDS",
    "USB_LOCATING_HOLE_IDS",
    "USB_SHELL_PAD_IDS",
    "build_footprints",
    "pad_by_id",
    "pads_by_component_and_number",
    "placement_by_component",
)

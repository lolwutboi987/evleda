from __future__ import annotations

from itertools import combinations

import pytest

from backend.design_kernel import FootprintHole, FootprintPad, FootprintPlacement, PointNm
from backend.reference_design.footprints import (
    HEADER_PAD_IDS,
    KICAD_FOOTPRINT_COMMIT,
    KICAD_LIBRARY_PROVENANCE,
    MANUFACTURER_LAND_PROVENANCE,
    PLACEMENT_SPECIFICATIONS,
    USB_CONTACT_PAD_IDS,
    USB_LOCATING_HOLE_IDS,
    USB_SHELL_PAD_IDS,
    build_footprints,
    pad_by_id,
    pads_by_component_and_number,
    placement_by_component,
)
from backend.reference_design.specification import (
    BOARD_HEIGHT_NM,
    BOARD_WIDTH_NM,
    KEMET_C0G_FAMILY_SHA256,
    KEMET_C1206C104_SHA256,
    KEMET_CAP_SHA256,
    KEMET_T59X_SHA256,
    KICAD_USB4105_FOOTPRINT_SHA256,
    LP38692_SHA256,
    USB4105_SPEC_SHA256,
    VISHAY_WSLP_SHA256,
    WURTH_CAP_SHA256,
    components,
    constraints,
    sources,
)


def _axis_aligned_half_extents(pad: FootprintPad) -> tuple[int, int]:
    if pad.rotation_udeg in {0, 180_000_000}:
        return pad.size_x_nm // 2, pad.size_y_nm // 2
    return pad.size_y_nm // 2, pad.size_x_nm // 2


def _bounds(pad: FootprintPad) -> tuple[int, int, int, int]:
    half_x, half_y = _axis_aligned_half_extents(pad)
    return (
        pad.center.x - half_x,
        pad.center.y - half_y,
        pad.center.x + half_x,
        pad.center.y + half_y,
    )


def _positive_area_overlap(left: FootprintPad, right: FootprintPad) -> bool:
    left_min_x, left_min_y, left_max_x, left_max_y = _bounds(left)
    right_min_x, right_min_y, right_max_x, right_max_y = _bounds(right)
    return (
        max(left_min_x, right_min_x) < min(left_max_x, right_max_x)
        and max(left_min_y, right_min_y) < min(left_max_y, right_max_y)
    )


def test_build_is_deterministic_exact_and_covers_every_component() -> None:
    first = build_footprints()
    second = build_footprints()
    assert first == second
    placements, pads, holes = first
    assert len(placements) == 23
    assert all(type(item) is FootprintPlacement for item in placements)
    assert all(type(item) is FootprintPad for item in pads)
    assert all(type(item) is FootprintHole for item in holes)
    expected_components = {component.component_id for component in components()}
    assert {placement.component_id for placement in placements} == expected_components
    assert len({placement.component_id for placement in placements}) == len(placements)
    assert len({pad.pad_id for pad in pads}) == len(pads)
    assert len({hole.hole_id for hole in holes}) == len(holes)
    assert all(not placement.locked for placement in placements)
    assert tuple(item[0] for item in PLACEMENT_SPECIFICATIONS) == tuple(
        component.component_id for component in components()
    )


def test_usb4105_true_edge_datum_contacts_and_shared_lands_are_exact() -> None:
    placement = placement_by_component("usb-j1")
    assert placement == FootprintPlacement(
        "usb-j1", PointNm(3_675_000, 15_000_000), 90_000_000, "front", False
    )
    # The official footprint's PCB-edge *line* is local y=+3.675 mm.  Its
    # text label is at y=+3.1 mm and is deliberately not used as a datum.
    assert placement.position.x - 3_675_000 == 0

    expected = {
        "A1": (7_355_000, 11_800_000, 600_000),
        "A4": (7_355_000, 12_600_000, 600_000),
        "A5": (7_355_000, 13_750_000, 300_000),
        "A6": (7_355_000, 14_750_000, 300_000),
        "A7": (7_355_000, 15_250_000, 300_000),
        "A8": (7_355_000, 16_250_000, 300_000),
        "A9": (7_355_000, 17_400_000, 600_000),
        "A12": (7_355_000, 18_200_000, 600_000),
        "B1": (7_355_000, 18_200_000, 600_000),
        "B4": (7_355_000, 17_400_000, 600_000),
        "B5": (7_355_000, 16_750_000, 300_000),
        "B6": (7_355_000, 15_750_000, 300_000),
        "B7": (7_355_000, 14_250_000, 300_000),
        "B8": (7_355_000, 13_250_000, 300_000),
        "B9": (7_355_000, 12_600_000, 600_000),
        "B12": (7_355_000, 11_800_000, 600_000),
    }
    assert len(USB_CONTACT_PAD_IDS) == len(set(USB_CONTACT_PAD_IDS)) == 16
    for number, (x_nm, y_nm, width_nm) in expected.items():
        pad = pads_by_component_and_number("usb-j1", number)[0]
        assert pad.pad_id == f"pad:usb-j1:{number}:0"
        assert pad.center == PointNm(x_nm, y_nm)
        assert (pad.size_x_nm, pad.size_y_nm, pad.shape, pad.rotation_udeg) == (
            width_nm,
            1_150_000,
            "rect",
            90_000_000,
        )

    shared_pairs = (
        ("A1", "B12", "usb-j1-shared-gnd-left"),
        ("A4", "B9", "usb-j1-shared-vbus-left"),
        ("A9", "B4", "usb-j1-shared-vbus-right"),
        ("A12", "B1", "usb-j1-shared-gnd-right"),
    )
    for first_number, second_number, group_id in shared_pairs:
        first = pads_by_component_and_number("usb-j1", first_number)[0]
        second = pads_by_component_and_number("usb-j1", second_number)[0]
        assert first.shared_land_group_id == second.shared_land_group_id == group_id
        assert (
            first.center,
            first.size_x_nm,
            first.size_y_nm,
            first.rotation_udeg,
        ) == (
            second.center,
            second.size_x_nm,
            second.size_y_nm,
            second.rotation_udeg,
        )


def test_usb4105_asymmetric_plated_slots_and_locators_match_public_kicad_footprint() -> None:
    _, _, holes = build_footprints()
    shell_pads = tuple(pad_by_id(pad_id) for pad_id in USB_SHELL_PAD_IDS)
    assert tuple(
        (pad.size_x_nm, pad.size_y_nm, pad.drill_x_nm, pad.drill_y_nm)
        for pad in shell_pads
    ) == (
        (1_000_000, 2_100_000, 600_000, 1_700_000),
        (1_000_000, 2_100_000, 600_000, 1_700_000),
        (1_000_000, 1_800_000, 600_000, 1_400_000),
        (1_000_000, 1_800_000, 600_000, 1_400_000),
    )
    assert tuple(pad.center for pad in shell_pads) == (
        PointNm(6_780_000, 10_680_000),
        PointNm(6_780_000, 19_320_000),
        PointNm(2_600_000, 10_680_000),
        PointNm(2_600_000, 19_320_000),
    )
    assert all(pad.shape == "oval" and pad.drill_is_slot for pad in shell_pads)
    assert all(pad.drill_rotation_udeg == 90_000_000 for pad in shell_pads)

    shell_holes = tuple(hole for hole in holes if hole.hole_id.startswith("hole:usb-j1:shell"))
    assert len(shell_holes) == 4
    assert {hole.pad_id for hole in shell_holes} == set(USB_SHELL_PAD_IDS)
    assert all(hole.plated and hole.drill_is_slot for hole in shell_holes)
    locators = tuple(hole for hole in holes if hole.hole_id in USB_LOCATING_HOLE_IDS)
    assert tuple(hole.center for hole in locators) == (
        PointNm(6_280_000, 12_110_000),
        PointNm(6_280_000, 17_890_000),
    )
    assert all(
        not hole.plated
        and hole.pad_id is None
        and hole.drill_x_nm == hole.drill_y_nm == 650_000
        for hole in locators
    )


def test_usb4105_public_provenance_and_mechanical_nonqualification_are_closed() -> None:
    by_source_id = {source.evidence_id: source for source in sources()}
    assert all(
        "drawing" not in evidence_id
        for evidence_id in by_source_id
        if "usb4105" in evidence_id
    )
    public_source = by_source_id["src-kicad-footprint-usb4105"]
    assert public_source.sha256 == KICAD_USB4105_FOOTPRINT_SHA256
    assert KICAD_FOOTPRINT_COMMIT in public_source.document_revision
    assert all("confidential" not in fact.casefold() for fact in public_source.facts)

    by_constraint_id = {item.constraint_id: item for item in constraints()}
    thickness = by_constraint_id["pcb-thickness"]
    assert (thickness.minimum, thickness.maximum, thickness.nominal, thickness.unit) == (
        None,
        None,
        800_000,
        "nm",
    )
    assert thickness.source_evidence_ids == ()
    assert "conservative project choice" in thickness.statement
    assert "mechanical mating remain unqualified" in thickness.statement

    local_clearance = by_constraint_id["usb4105-public-footprint-local-clearance"]
    assert local_clearance.minimum is None
    assert local_clearance.nominal == 175_100
    assert local_clearance.source_evidence_ids == ("src-kicad-footprint-usb4105",)
    assert "not a manufacturer-authorized minimum" in local_clearance.statement

    mating = by_constraint_id["usb4105-mechanical-mating-unqualified"]
    assert mating.category == "release"
    assert "Manufacturing release remains blocked" in mating.statement


def test_every_component_pin_has_exact_physical_pad_binding() -> None:
    _, pads, _ = build_footprints()
    component_index = {component.component_id: component for component in components()}
    expected_bindings = {
        (component.component_id, pin.pad_number)
        for component in component_index.values()
        for pin in component.pins
    }
    actual_bindings = {(pad.component_id, pad.pad_number) for pad in pads}
    assert actual_bindings == expected_bindings
    for pad in pads:
        assert pad.pad_id.startswith(f"pad:{pad.component_id}:{pad.pad_number}:")
    assert len(pads_by_component_and_number("usb-j1", "S1")) == 4
    assert all(
        len(pads_by_component_and_number(component.component_id, pin.pad_number)) == 1
        for component in components()
        for pin in component.pins
        if not (component.component_id == "usb-j1" and pin.pad_number == "S1")
    )


def test_package_land_patterns_are_exact() -> None:
    connector = next(component for component in components() if component.component_id == "usb-j1")
    assert connector.datasheet_sha256 == USB4105_SPEC_SHA256
    assert next(
        digest for profile, _, digest in KICAD_LIBRARY_PROVENANCE if profile == "usb4105"
    ) == KICAD_USB4105_FOOTPRINT_SHA256
    assert (pad_by_id("pad:efuse-u1:1:0").center, pad_by_id("pad:efuse-u1:1:0").size_x_nm) == (
        PointNm(14_300_000, 13_095_000),
        1_550_000,
    )
    ep = pad_by_id("pad:efuse-u1:9:0")
    assert (ep.center, ep.size_x_nm, ep.size_y_nm) == (
        PointNm(17_000_000, 15_000_000),
        2_950_000,
        4_900_000,
    )
    u2_pads = tuple(pads_by_component_and_number("ldo-u2", number)[0] for number in "12345")
    assert tuple(pad.pad_id for pad in u2_pads) == tuple(
        f"pad:ldo-u2:{number}:0" for number in "12345"
    )
    assert tuple(pad.center for pad in u2_pads) == (
        PointNm(30_250_000, 19_000_000),
        PointNm(28_750_000, 19_000_000),
        PointNm(27_250_000, 19_000_000),
        PointNm(25_750_000, 19_000_000),
        PointNm(28_000_000, 12_700_000),
    )
    assert tuple(
        (pad.size_x_nm, pad.size_y_nm, pad.shape, pad.rotation_udeg) for pad in u2_pads
    ) == (
        (1_000_000, 1_500_000, "rect", 180_000_000),
        (1_000_000, 1_500_000, "rect", 180_000_000),
        (1_000_000, 1_500_000, "rect", 180_000_000),
        (1_000_000, 1_500_000, "rect", 180_000_000),
        (3_300_000, 1_500_000, "rect", 180_000_000),
    )
    assert all(
        (pads_by_component_and_number("tvs-d1", number)[0].size_x_nm,
         pads_by_component_and_number("tvs-d1", number)[0].size_y_nm)
        == (700_000, 1_200_000)
        for number in ("1", "2")
    )
    assert (
        pad_by_id("pad:cc-r1:1:0").size_x_nm,
        pad_by_id("pad:cc-r1:1:0").size_y_nm,
    ) == (800_000, 950_000)
    assert (
        pad_by_id("pad:cin-c1:1:0").size_x_nm,
        pad_by_id("pad:cin-c1:1:0").size_y_nm,
    ) == (1_000_000, 1_300_000)
    c2_pads = tuple(pads_by_component_and_number("cldo-c2", number)[0] for number in "12")
    assert tuple(pad.center for pad in c2_pads) == (
        PointNm(23_525_000, 19_000_000),
        PointNm(21_475_000, 19_000_000),
    )
    assert all(
        (pad.size_x_nm, pad.size_y_nm, pad.shape, pad.rotation_udeg)
        == (1_150_000, 1_450_000, "rect", 180_000_000)
        for pad in c2_pads
    )
    c3_pads = tuple(pads_by_component_and_number("cout-c3", number)[0] for number in "12")
    assert tuple(pad.pad_id for pad in c3_pads) == ("pad:cout-c3:1:0", "pad:cout-c3:2:0")
    # T598B pad 1 is the positive terminal and stays on the left at rotation zero.
    assert tuple(pad.center for pad in c3_pads) == (
        PointNm(27_790_000, 26_000_000),
        PointNm(30_710_000, 26_000_000),
    )
    assert all(
        (pad.size_x_nm, pad.size_y_nm, pad.shape, pad.rotation_udeg)
        == (1_800_000, 2_230_000, "rect", 0)
        for pad in c3_pads
    )
    r9_pads = tuple(pads_by_component_and_number("cout-esr-r9", number)[0] for number in "12")
    assert tuple(pad.center for pad in r9_pads) == (
        PointNm(27_250_000, 21_490_000),
        PointNm(27_250_000, 23_010_000),
    )
    assert all(
        (pad.size_x_nm, pad.size_y_nm, pad.shape, pad.rotation_udeg)
        == (1_020_000, 1_020_000, "rect", 270_000_000)
        for pad in r9_pads
    )
    c4_pads = tuple(pads_by_component_and_number("dvdt-c4", number)[0] for number in "12")
    assert tuple(pad.center for pad in c4_pads) == (
        PointNm(11_650_000, 12_250_000),
        PointNm(11_650_000, 9_250_000),
    )
    assert all(
        (pad.size_x_nm, pad.size_y_nm, pad.shape, pad.rotation_udeg)
        == (1_150_000, 1_800_000, "rect", 270_000_000)
        for pad in c4_pads
    )
    assert (
        pad_by_id("pad:led-d2:1:0").size_x_nm,
        pad_by_id("pad:led-d2:1:0").size_y_nm,
    ) == (875_000, 950_000)
    assert tuple(pad_by_id(pad_id).pad_drill_nm for pad_id in HEADER_PAD_IDS) == (
        1_100_000,
        1_100_000,
    )
    assert all(
        (pad_by_id(f"pad:tp-{index}:1:0").size_x_nm,
         pad_by_id(f"pad:tp-{index}:1:0").size_y_nm)
        == (3_400_000, 1_800_000)
        for index in range(1, 5)
    )
    capacitor_components = {
        component.reference: component
        for component in components()
        if component.reference in {"C1", "C2", "C3", "C4"}
    }
    assert (
        capacitor_components["C1"].manufacturer_part_number,
        capacitor_components["C1"].datasheet_sha256,
    ) == ("885012207051", WURTH_CAP_SHA256)
    c2 = capacitor_components["C2"]
    assert (
        c2.manufacturer_part_number,
        c2.value,
        c2.package,
        c2.footprint_id,
        c2.datasheet_sha256,
    ) == (
        "C0805C475K3RACTU",
        "4.7uF 25V X7R",
        "0805",
        "Capacitor_SMD:C_0805_2012Metric",
        KEMET_CAP_SHA256,
    )
    c3 = capacitor_components["C3"]
    assert (
        c3.manufacturer_part_number,
        c3.value,
        c3.package,
        c3.symbol_id,
        c3.footprint_id,
        c3.datasheet_sha256,
    ) == (
        "T598B226M010ATE070",
        "22uF 10V polymer +/-20%",
        "B/3528-20 polarized",
        "Device:C_Polarized",
        "Capacitor_SMD:CP_EIA-3528-21_Kemet-B",
        KEMET_T59X_SHA256,
    )
    c4 = capacitor_components["C4"]
    assert (
        c4.manufacturer_part_number,
        c4.value,
        c4.package,
        c4.footprint_id,
        c4.datasheet_sha256,
    ) == (
        "C1206C104J3GACTU",
        "100nF 25V C0G +/-5%",
        "1206",
        "Capacitor_SMD:C_1206_3216Metric",
        KEMET_C1206C104_SHA256,
    )
    assert WURTH_CAP_SHA256 == (
        "eff87bfa4247a47581c55478f6785a150e90385c3d6ac9ccae441ed9a5903f18"
    )


def test_all_copper_and_holes_are_in_bounds_with_no_implicit_pad_overlap() -> None:
    _, pads, holes = build_footprints()
    for pad in pads:
        min_x, min_y, max_x, max_y = _bounds(pad)
        assert 0 <= min_x < max_x <= BOARD_WIDTH_NM
        assert 0 <= min_y < max_y <= BOARD_HEIGHT_NM
        if pad.component_id != "usb-j1":
            assert min_x >= 500_000
            assert min_y >= 500_000
            assert max_x <= BOARD_WIDTH_NM - 500_000
            assert max_y <= BOARD_HEIGHT_NM - 500_000
    for hole in holes:
        if hole.drill_rotation_udeg == 90_000_000:
            half_x, half_y = hole.drill_y_nm // 2, hole.drill_x_nm // 2
        else:
            half_x, half_y = hole.drill_x_nm // 2, hole.drill_y_nm // 2
        assert 0 <= hole.center.x - half_x <= hole.center.x + half_x <= BOARD_WIDTH_NM
        assert 0 <= hole.center.y - half_y <= hole.center.y + half_y <= BOARD_HEIGHT_NM

    for left, right in combinations(pads, 2):
        if not _positive_area_overlap(left, right):
            continue
        assert (
            left.shared_land_group_id is not None
            and left.shared_land_group_id == right.shared_land_group_id
        ), f"implicit overlap: {left.pad_id}, {right.pad_id}"


def test_r2_placement_delta_and_copper_collision_cleanup_are_exact() -> None:
    expected_placements = {
        "ldo-u2": (28_000_000, 19_000_000, 180_000_000),
        "tvs-d1": (10_200_000, 15_000_000, 90_000_000),
        "cc-r1": (9_400_000, 12_250_000, 90_000_000),
        "cc-r2": (9_400_000, 17_750_000, 90_000_000),
        "ilim-r3": (22_000_000, 11_200_000, 0),
        "cout-esr-r9": (27_250_000, 22_250_000, 270_000_000),
        "cin-c1": (12_050_000, 15_000_000, 90_000_000),
        "cldo-c2": (22_500_000, 19_000_000, 180_000_000),
        "cout-c3": (29_250_000, 26_000_000, 0),
        "dvdt-c4": (11_650_000, 10_750_000, 270_000_000),
    }
    for component_id, (x_nm, y_nm, rotation_udeg) in expected_placements.items():
        assert placement_by_component(component_id) == FootprintPlacement(
            component_id,
            PointNm(x_nm, y_nm),
            rotation_udeg,
            "front",
            False,
        )

    expected_centers = {
        "cc-r1": (PointNm(9_400_000, 11_425_000), PointNm(9_400_000, 13_075_000)),
        "cc-r2": (PointNm(9_400_000, 16_925_000), PointNm(9_400_000, 18_575_000)),
        "tvs-d1": (PointNm(10_200_000, 14_375_000), PointNm(10_200_000, 15_625_000)),
        "cin-c1": (PointNm(12_050_000, 14_100_000), PointNm(12_050_000, 15_900_000)),
    }
    for component_id, centers in expected_centers.items():
        actual_centers = tuple(
            pads_by_component_and_number(component_id, number)[0].center for number in "12"
        )
        assert actual_centers == centers

    u1_pads = tuple(pad for pad in build_footprints()[1] if pad.component_id == "efuse-u1")
    r3_pads = tuple(pad for pad in build_footprints()[1] if pad.component_id == "ilim-r3")
    assert all(
        not _positive_area_overlap(u1_pad, r3_pad) for u1_pad in u1_pads for r3_pad in r3_pads
    )


def test_manufacturer_land_profiles_are_hash_pinned_and_never_masquerade_as_kicad() -> None:
    source_hashes = {source.evidence_id: source.sha256 for source in sources()}
    assert MANUFACTURER_LAND_PROVENANCE == (
        ("ti-lp38692-ndc", "src-ti-lp38692-datasheet", LP38692_SHA256),
        ("kemet-t598b-density-b", "src-kemet-t59x", KEMET_T59X_SHA256),
        ("vishay-wslp0603", "src-vishay-wslp", VISHAY_WSLP_SHA256),
        ("kemet-c1206-density-b", "src-kemet-c0g-family", KEMET_C0G_FAMILY_SHA256),
    )
    assert all(
        source_hashes[source_id] == digest for _, source_id, digest in MANUFACTURER_LAND_PROVENANCE
    )
    assert {profile for profile, _, _ in MANUFACTURER_LAND_PROVENANCE}.isdisjoint(
        profile for profile, _, _ in KICAD_LIBRARY_PROVENANCE
    )


def test_lookup_fail_closed_and_library_policy_is_revision_pinned() -> None:
    assert len(KICAD_FOOTPRINT_COMMIT) == 40
    assert len(KICAD_LIBRARY_PROVENANCE) == 7
    assert len({profile for profile, _, _ in KICAD_LIBRARY_PROVENANCE}) == 7
    assert all(
        path.endswith(".kicad_mod")
        and len(digest) == 64
        and set(digest) <= set("0123456789abcdef")
        for _, path, digest in KICAD_LIBRARY_PROVENANCE
    )
    dda = next(component for component in components() if component.component_id == "efuse-u1")
    assert dda.footprint_id == (
        "Package_SO:Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm"
    )
    dda_source_path = next(
        path for profile, path, _ in KICAD_LIBRARY_PROVENANCE if profile == "dda-leads"
    )
    assert dda_source_path == dda.footprint_id.replace(":", ".pretty/") + ".kicad_mod"
    dda_ep = next(pin for pin in dda.pins if pin.number == "EP")
    assert dda_ep.pad_number == "9"
    assert pads_by_component_and_number("efuse-u1", "9") == (
        pad_by_id("pad:efuse-u1:9:0"),
    )
    with pytest.raises(KeyError):
        placement_by_component("missing")
    with pytest.raises(KeyError):
        pads_by_component_and_number("usb-j1", "missing")
    with pytest.raises(KeyError):
        pad_by_id("pad:missing:1:0")

from __future__ import annotations

from dataclasses import replace

import pytest

from backend.reference_design.assembly_geometry import (
    REFERENCE_COURTYARD_POLICY,
    REFERENCE_PROFILE_RECORDS,
    AssemblyGeometryProvenanceError,
    AssemblyPlacement,
    BoardOverhang,
    CourtyardClearancePolicy,
    CourtyardCollision,
    FootprintProfile,
    GeometrySource,
    OrientationMark,
    Outline,
    PlacedProfile,
    ReferenceProfileRecord,
    _rect,
    all_profiles,
    board_overhangs,
    courtyard_collisions,
    profile_for_component,
    resolve_placed_profiles,
    validate_reference_inventory,
)
from backend.reference_design.footprints import build_footprints
from backend.reference_design.specification import BOARD_HEIGHT_NM, BOARD_WIDTH_NM, components


def _frozen_placements() -> tuple[AssemblyPlacement, ...]:
    placements, _, _ = build_footprints()
    footprints = {component.component_id: component.footprint_id for component in components()}
    return tuple(
        AssemblyPlacement(
            placement.component_id,
            footprints[placement.component_id],
            placement.position.x,
            placement.position.y,
            placement.rotation_udeg,
        )
        for placement in placements
    )


def test_all_23_frozen_r2_components_have_exact_source_profile_bindings() -> None:
    current = components()
    assert len(current) == len(REFERENCE_PROFILE_RECORDS) == 23
    assert {
        (record.component_id, record.reference, record.footprint_id)
        for record in REFERENCE_PROFILE_RECORDS
    } == {
        (component.component_id, component.reference, component.footprint_id)
        for component in current
    }

    profiles = all_profiles()
    assert len(profiles) == 12
    assert {record.profile_id for record in REFERENCE_PROFILE_RECORDS} == {
        profile.profile_id for profile in profiles
    }
    assert all(profile.sources for profile in profiles)
    assert all(
        len(source.sha256) == 64 and set(source.sha256) <= set("0123456789abcdef")
        for profile in profiles
        for source in profile.sources
    )


def test_every_profile_has_an_exhaustive_source_outline_orientation_receipt() -> None:
    expected = {
        "capacitor_0805": (
            (
                (
                    "pinned-kicad-footprint",
                    "kicad/libraries/kicad-footprints",
                    "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
                    "Capacitor_SMD.pretty/C_0805_2012Metric.kicad_mod",
                    "62775a51fe74ba7f1b572de327bdbd3fc92582721b2abcaa47787865590d89cb",
                ),
            ),
            ((-1_000_000, -625_000, 1_000_000, 625_000), "direct"),
            ((-1_700_000, -980_000, 1_700_000, 980_000), "direct"),
            ("none", "direct", "none", None),
            False,
        ),
        "header_1x02": (
            (
                (
                    "pinned-kicad-footprint",
                    "kicad/libraries/kicad-footprints",
                    "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
                    "Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical.kicad_mod",
                    "5301303268f72ba9cc94b7fdbac355951933e6854272ce8d300b679b86b5d45d",
                ),
            ),
            ((-1_270_000, -1_270_000, 1_270_000, 3_810_000), "direct"),
            ((-1_770_000, -1_770_000, 1_770_000, 4_320_000), "direct"),
            ("pin-one", "direct", "fab-chamfer", (-635_000, -1_270_000)),
            False,
        ),
        "kemet_c1206_density_b": (
            (
                (
                    "manufacturer-document",
                    "KEMET/YAGEO",
                    "2025-02-20",
                    "KEM C1003 C0G SMD family data sheet, IPC-7351 density-B table",
                    "02d179914aeb9585eb2229ba8e18ef9d6b01c77c056de2af295d6950a2a5cc0d",
                ),
                (
                    "manufacturer-document",
                    "KEMET/YAGEO",
                    "C1206C104J3GACTU",
                    "C1206C104J3GACTU exact-MPN specification sheet",
                    "dbafe0002fa3f302ec182bbe37f000f47190256b73ee7c10b8066a55df835609",
                ),
            ),
            ((-1_600_000, -800_000, 1_600_000, 800_000), "direct"),
            ((-2_350_000, -1_150_000, 2_350_000, 1_150_000), "direct"),
            ("none", "direct", "none", None),
            False,
        ),
        "kemet_t598b_density_b": (
            (
                (
                    "manufacturer-document",
                    "KEMET/YAGEO",
                    "T2073_T59X-2025-11-05",
                    "T2073_T59X.pdf, pages 8 and 22",
                    "64cc7925483d23bc88a92c0dde3bba58e60152765bed5602f859c04c0c5db729",
                ),
            ),
            ((-1_750_000, -1_400_000, 1_750_000, 1_400_000), "direct"),
            ((-2_610_000, -1_750_000, 2_610_000, 1_750_000), "direct"),
            ("polarity", "direct", "polarity-end-view", (-1_460_000, 0)),
            False,
        ),
        "led_0603": (
            (
                (
                    "pinned-kicad-footprint",
                    "kicad/libraries/kicad-footprints",
                    "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
                    "LED_SMD.pretty/LED_0603_1608Metric.kicad_mod",
                    "7931ed1efba34cb13c8d74a60eb1dca4b0be57d950c38e08c3e7f007db500a1c",
                ),
            ),
            ((-800_000, -400_000, 800_000, 400_000), "direct"),
            ((-1_480_000, -730_000, 1_480_000, 730_000), "direct"),
            ("polarity", "direct", "fab-chamfer", (-500_000, -400_000)),
            False,
        ),
        "nexperia_ptvs_dfn1610_2": (
            (
                (
                    "manufacturer-document",
                    "Nexperia",
                    "v1-2024-10-28",
                    "PTVS5V5Z1UPC.pdf",
                    "dd54840b481bf99b3a1082dd08cd556e695991a1b36799e98eb43b7e890e00c1",
                ),
            ),
            ((-800_000, -500_000, 800_000, 500_000), "direct"),
            ((-975_000, -600_000, 975_000, 600_000), "derived"),
            ("polarity", "direct", "terminal-map", (-625_000, 0)),
            False,
        ),
        "resistor_0603": (
            (
                (
                    "pinned-kicad-footprint",
                    "kicad/libraries/kicad-footprints",
                    "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
                    "Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod",
                    "7190ac4a00125b807e54129ef0d87d87f2a658eeb74d025a7028203419b09f23",
                ),
            ),
            ((-800_000, -412_500, 800_000, 412_500), "direct"),
            ((-1_480_000, -730_000, 1_480_000, 730_000), "direct"),
            ("none", "direct", "none", None),
            False,
        ),
        "testpoint_keystone_5015": (
            (
                (
                    "pinned-kicad-footprint",
                    "kicad/libraries/kicad-footprints",
                    "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
                    "TestPoint.pretty/TestPoint_Keystone_5015_Micro_Mini.kicad_mod",
                    "f14e0e7d28a0a75298142634f99f433f44d1ae9130852870e630df717f3bf647",
                ),
            ),
            ((-1_350_000, -500_000, 1_350_000, 500_000), "direct"),
            ((-2_150_000, -1_350_000, 2_150_000, 1_350_000), "direct"),
            ("none", "direct", "none", None),
            False,
        ),
        "ti_lp38692_ndc": (
            (
                (
                    "manufacturer-document",
                    "Texas Instruments",
                    "SNVS322M Rev M, December 2015",
                    "LP38692 datasheet, NDC0005A package drawing, page 31",
                    "37d312bc1c8189f8fe4275ceaf8928d447cb6faaa2796e503d6120a891376352",
                ),
            ),
            ((-3_250_000, 1_700_000, 3_250_000, 5_260_000), "derived"),
            ((-3_250_000, -750_000, 3_250_000, 7_050_000), "derived"),
            ("pin-one", "direct", "terminal-map", (-2_250_000, 0)),
            False,
        ),
        "tps259620_dda": (
            (
                (
                    "pinned-kicad-footprint",
                    "kicad/libraries/kicad-footprints",
                    "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
                    "Package_SO.pretty/Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm.kicad_mod",
                    "a2de8e28dd9f6a17dc2592de4c8500ac34f85d12e9e90e9c6499dc9de4937d91",
                ),
            ),
            ((-1_950_000, -2_450_000, 1_950_000, 2_450_000), "direct"),
            ((-3_750_000, -2_750_000, 3_750_000, 2_750_000), "direct"),
            ("pin-one", "direct", "fab-chamfer", (-950_000, -2_450_000)),
            False,
        ),
        "usb4105": (
            (
                (
                    "pinned-kicad-footprint",
                    "kicad/libraries/kicad-footprints",
                    "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
                    "Connector_USB.pretty/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.kicad_mod",
                    "3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8",
                ),
            ),
            ((-4_470_000, -3_675_000, 4_470_000, 3_675_000), "direct"),
            ((-5_320_000, -4_760_000, 5_320_000, 4_180_000), "direct"),
            ("none", "direct", "none", None),
            True,
        ),
        "vishay_wslp0603": (
            (
                (
                    "manufacturer-document",
                    "Vishay Dale",
                    "document-30122-2024-09-09",
                    "WSLP.pdf, page 2",
                    "5d20b5572767451d6a38e1e37c6f0f3113eb604e72593a6cd97a0a944458455b",
                ),
            ),
            ((-760_000, -380_000, 760_000, 380_000), "direct"),
            ((-1_270_000, -510_000, 1_270_000, 510_000), "derived"),
            ("none", "direct", "none", None),
            False,
        ),
    }
    actual = {
        profile.profile_id: (
            tuple(
                (source.kind, source.publisher, source.revision, source.locator, source.sha256)
                for source in profile.sources
            ),
            (profile.fab_outline.bounds_nm, profile.fab_outline.status),
            (profile.courtyard_outline.bounds_nm, profile.courtyard_outline.status),
            (
                profile.orientation_mark.role,
                profile.orientation_mark.status,
                profile.orientation_mark.feature,
                profile.orientation_mark.local_anchor_nm,
            ),
            profile.permits_board_edge_overhang,
        )
        for profile in all_profiles()
    }
    assert actual == expected
    validate_reference_inventory()


def test_source_records_keep_direct_and_derived_dimensions_distinct() -> None:
    u2 = profile_for_component("ldo-u2", "Package_TO_SOT_SMD:SOT-223-5_TabPin5")
    d1 = profile_for_component("tvs-d1", "Diode_SMD:Nexperia_DFN1610-2")
    r9 = profile_for_component("cout-esr-r9", "Resistor_SMD:R_0603_1608Metric")
    c3 = profile_for_component("cout-c3", "Capacitor_SMD:CP_EIA-3528-21_Kemet-B")
    c4 = profile_for_component("dvdt-c4", "Capacitor_SMD:C_1206_3216Metric")

    assert (u2.fab_outline.status, u2.courtyard_outline.status) == ("derived", "derived")
    assert u2.fab_outline.derivation is not None
    assert (d1.fab_outline.status, d1.courtyard_outline.status) == ("direct", "derived")
    assert r9.courtyard_outline.status == "derived"
    assert (c3.fab_outline.status, c3.courtyard_outline.status) == ("direct", "direct")
    assert (c4.fab_outline.status, c4.courtyard_outline.status) == ("direct", "direct")
    assert u2.sources[0].publisher == "Texas Instruments"
    assert c3.sources[0].publisher == "KEMET/YAGEO"
    assert r9.sources[0].publisher == "Vishay Dale"


def test_direct_body_and_courtyard_dimensions_match_pinned_or_manufacturer_sources() -> None:
    assert profile_for_component(
        "efuse-u1", "Package_SO:Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm"
    ).fab_outline.bounds_nm == (-1_950_000, -2_450_000, 1_950_000, 2_450_000)
    assert profile_for_component(
        "cout-c3", "Capacitor_SMD:CP_EIA-3528-21_Kemet-B"
    ).courtyard_outline.bounds_nm == (-2_610_000, -1_750_000, 2_610_000, 1_750_000)
    assert profile_for_component(
        "dvdt-c4", "Capacitor_SMD:C_1206_3216Metric"
    ).courtyard_outline.bounds_nm == (-2_350_000, -1_150_000, 2_350_000, 1_150_000)
    assert profile_for_component(
        "cout-esr-r9", "Resistor_SMD:R_0603_1608Metric"
    ).fab_outline.bounds_nm == (-760_000, -380_000, 760_000, 380_000)


def test_pin_one_and_polarity_semantics_are_source_backed_not_synthetic() -> None:
    assert (
        profile_for_component(
            "efuse-u1", "Package_SO:Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm"
        ).orientation_mark.feature
        == "fab-chamfer"
    )
    assert (
        profile_for_component(
            "ldo-u2", "Package_TO_SOT_SMD:SOT-223-5_TabPin5"
        ).orientation_mark.feature
        == "terminal-map"
    )
    assert (
        profile_for_component("tvs-d1", "Diode_SMD:Nexperia_DFN1610-2").orientation_mark.role
        == "polarity"
    )
    assert (
        profile_for_component(
            "cout-c3", "Capacitor_SMD:CP_EIA-3528-21_Kemet-B"
        ).orientation_mark.feature
        == "polarity-end-view"
    )
    assert (
        profile_for_component("led-d2", "LED_SMD:LED_0603_1608Metric").orientation_mark.feature
        == "fab-chamfer"
    )


def test_absent_or_changed_footprint_profile_fails_closed() -> None:
    with pytest.raises(AssemblyGeometryProvenanceError, match="no source-backed"):
        profile_for_component("missing", "Package_SO:SO-8")
    with pytest.raises(AssemblyGeometryProvenanceError, match="footprint changed"):
        profile_for_component("ldo-u2", "Package_TO_SOT_SMD:SOT-23-5")


def test_runtime_invariants_reject_invalid_literals_geometry_and_anchor_semantics() -> None:
    source = GeometrySource("manufacturer-document", "publisher", "revision", "locator", "a" * 64)
    body = _rect(-10, -10, 10, 10, "F.Fab", "body", 1)
    courtyard = _rect(-20, -20, 20, 20, "F.CrtYd", "courtyard", 1)

    with pytest.raises(ValueError, match="source kind"):
        GeometrySource("unknown", "publisher", "revision", "locator", "a" * 64)
    with pytest.raises(ValueError, match="outline layer"):
        Outline("B.Fab", "body", ((0, 0), (1, 0), (0, 1), (0, 0)), 1, "direct")
    with pytest.raises(ValueError, match="outline role"):
        Outline("F.Fab", "mark", ((0, 0), (1, 0), (0, 1), (0, 0)), 1, "direct")
    with pytest.raises(ValueError, match="dimension status"):
        Outline("F.Fab", "body", ((0, 0), (1, 0), (0, 1), (0, 0)), 1, "approximate")
    with pytest.raises(ValueError, match="closed"):
        Outline("F.Fab", "body", ((0, 0), (1, 0), (0, 1), (2, 2)), 1, "direct")
    with pytest.raises(ValueError, match="self-intersect"):
        Outline("F.Fab", "body", ((0, 0), (2, 2), (0, 2), (2, 0), (0, 0)), 1, "direct")
    with pytest.raises(ValueError, match="nonzero area"):
        Outline("F.Fab", "body", ((0, 0), (1, 0), (2, 0), (0, 0)), 1, "direct")
    with pytest.raises(ValueError, match="ordered, nonzero area"):
        _rect(10, 0, 0, 10, "F.Fab", "body", 1)
    with pytest.raises(ValueError, match="orientation mark role"):
        OrientationMark("index", "direct", "description", "none")
    with pytest.raises(ValueError, match="orientation mark feature"):
        OrientationMark("pin-one", "direct", "description", "circle", (0, 0))
    with pytest.raises(ValueError, match="requires an anchor"):
        OrientationMark("pin-one", "direct", "description", "terminal-map")
    with pytest.raises(ValueError, match="cannot have an anchor"):
        OrientationMark("none", "direct", "description", "none", (0, 0))
    with pytest.raises(ValueError, match="fab-chamfer orientation anchor"):
        FootprintProfile(
            "profile",
            "Library:Footprint",
            (source,),
            body,
            courtyard,
            OrientationMark("pin-one", "direct", "description", "fab-chamfer", (0, 1)),
        )
    with pytest.raises(ValueError, match="repeat a source receipt"):
        FootprintProfile(
            "profile",
            "Library:Footprint",
            (source, source),
            body,
            courtyard,
            OrientationMark("none", "direct", "description", "none"),
        )
    with pytest.raises(ValueError, match="collision axis"):
        CourtyardCollision("a", "b", "one", "two", 1, 1, 1, "z")
    with pytest.raises(ValueError, match="overhang permission"):
        BoardOverhang("a", "profile", (0, 0, 1, 1), 1)
    with pytest.raises(ValueError, match="reference component ID"):
        ReferenceProfileRecord("", "R1", "Library:Footprint", "profile")


def test_collision_policy_handles_overlap_touching_minimum_clearance_and_x_ties() -> None:
    def placed(second_x_nm: int, second_y_nm: int = 10_000_000) -> tuple[PlacedProfile, ...]:
        return resolve_placed_profiles(
            (
                AssemblyPlacement(
                    "cc-r1", "Resistor_SMD:R_0603_1608Metric", 10_000_000, 10_000_000, 0
                ),
                AssemblyPlacement(
                    "cc-r2", "Resistor_SMD:R_0603_1608Metric", second_x_nm, second_y_nm, 0
                ),
            )
        )

    overlap = courtyard_collisions(placed(12_000_000))
    assert [
        (item.overlap_x_nm, item.overlap_y_nm, item.required_translation_nm, item.translation_axis)
        for item in overlap
    ] == [(960_000, 1_460_000, 960_000, "x")]
    touching = placed(12_960_000)
    assert courtyard_collisions(touching) == ()
    assert (
        courtyard_collisions(
            touching,
            CourtyardClearancePolicy(
                minimum_clearance_nm=100_000,
                permit_profile_board_edge_overhang=True,
            ),
        )[0].required_translation_nm
        == 100_000
    )
    tie = courtyard_collisions(placed(12_460_000, 10_960_000))
    assert [(item.overlap_x_nm, item.overlap_y_nm, item.translation_axis) for item in tie] == [
        (500_000, 500_000, "x")
    ]


def test_duplicate_placements_invalid_board_bounds_and_forbidden_overhang_fail() -> None:
    first = _frozen_placements()[0]
    with pytest.raises(ValueError, match="repeat a subject ID"):
        resolve_placed_profiles((first, first))

    at_board_origin = resolve_placed_profiles(
        (AssemblyPlacement("cc-r1", "Resistor_SMD:R_0603_1608Metric", 0, 0, 0),)
    )
    overhang = board_overhangs(at_board_origin, (0, 0, BOARD_WIDTH_NM, BOARD_HEIGHT_NM))
    assert len(overhang) == 1 and not overhang[0].permitted
    with pytest.raises(ValueError, match="positive area"):
        board_overhangs(at_board_origin, (0, 0, 0, BOARD_HEIGHT_NM))


def test_exact_quadrant_transforms_are_deterministic_for_usb_and_u2() -> None:
    placements = _frozen_placements()
    first = resolve_placed_profiles(placements)
    assert first == resolve_placed_profiles(tuple(reversed(placements)))
    assert len(first) == len(placements) == 23
    assert {item.placement.subject_id for item in first} == {
        record.component_id for record in REFERENCE_PROFILE_RECORDS
    }
    by_subject = {item.placement.subject_id: item for item in first}
    assert by_subject["usb-j1"].courtyard_bounds_nm == (
        -505_000,
        9_680_000,
        8_435_000,
        20_320_000,
    )
    assert by_subject["ldo-u2"].courtyard_bounds_nm == (
        24_750_000,
        11_950_000,
        31_250_000,
        19_750_000,
    )

    u2 = next(item for item in placements if item.subject_id == "ldo-u2")
    expected_by_rotation = {
        0: (24_750_000, 18_250_000, 31_250_000, 26_050_000),
        90_000_000: (20_950_000, 15_750_000, 28_750_000, 22_250_000),
        180_000_000: (24_750_000, 11_950_000, 31_250_000, 19_750_000),
        270_000_000: (27_250_000, 15_750_000, 35_050_000, 22_250_000),
    }
    assert {
        rotation: resolve_placed_profiles((replace(u2, rotation_udeg=rotation),))[
            0
        ].courtyard_bounds_nm
        for rotation in expected_by_rotation
    } == expected_by_rotation


def test_final_r2_placement_has_no_ordinary_intersections_and_one_expected_overhang() -> None:
    placed = resolve_placed_profiles(_frozen_placements())
    assert courtyard_collisions(placed) == ()
    assert REFERENCE_COURTYARD_POLICY.minimum_clearance_nm == 0
    overhangs = board_overhangs(placed, (0, 0, BOARD_WIDTH_NM, BOARD_HEIGHT_NM))
    assert [
        (item.subject_id, item.profile_id, item.bounds_nm, item.permitted) for item in overhangs
    ] == [("usb-j1", "usb4105", (-505_000, 9_680_000, 8_435_000, 20_320_000), True)]

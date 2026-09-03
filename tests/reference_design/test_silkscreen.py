from __future__ import annotations

import pytest

from backend.design_kernel import FootprintPad
from backend.reference_design import silkscreen as silkscreen_module
from backend.reference_design.assembly_geometry import (
    REFERENCE_PROFILE_RECORDS,
    AssemblyPlacement,
    PlacedProfile,
    resolve_placed_profiles,
)
from backend.reference_design.footprints import build_footprints
from backend.reference_design.silkscreen import (
    FINAL_PLACEMENTS,
    KICAD_GLYPH_ADVANCE_DENOMINATOR,
    KICAD_GLYPH_ADVANCE_NUMERATOR,
    SILK_CLEARANCE_NM,
    Envelope,
    FittedPart,
    PlacementRequest,
    PlannerInput,
    RectNm,
    SilkscreenPlanningError,
    TextPrimitive,
    plan_silkscreen,
    reference_orientation_marks,
    reference_silkscreen_requests,
)


def _pad_bounds(pad: FootprintPad) -> RectNm:
    if pad.rotation_udeg in {0, 180_000_000}:
        half_x_nm, half_y_nm = pad.size_x_nm // 2, pad.size_y_nm // 2
    else:
        half_x_nm, half_y_nm = pad.size_y_nm // 2, pad.size_x_nm // 2
    return RectNm(
        pad.center.x - half_x_nm,
        pad.center.y - half_y_nm,
        pad.center.x + half_x_nm,
        pad.center.y + half_y_nm,
    )


def _transform(x_nm: int, y_nm: int, placement: AssemblyPlacement) -> tuple[int, int]:
    if placement.rotation_udeg == 0:
        dx_nm, dy_nm = x_nm, y_nm
    elif placement.rotation_udeg == 90_000_000:
        dx_nm, dy_nm = -y_nm, x_nm
    elif placement.rotation_udeg == 180_000_000:
        dx_nm, dy_nm = -x_nm, -y_nm
    else:
        dx_nm, dy_nm = y_nm, -x_nm
    return placement.x_nm + dx_nm, placement.y_nm + dy_nm


def _body_bounds(placed: PlacedProfile) -> RectNm:
    points = tuple(
        _transform(*point, placed.placement) for point in placed.profile.fab_outline.vertices
    )
    return RectNm(
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    )


def _input() -> PlannerInput:
    """Use actual R2 pads and the source-backed assembly sidecar, not mock boxes."""

    placements, pads, _ = build_footprints()
    records = {record.component_id: record for record in REFERENCE_PROFILE_RECORDS}
    assembly_placements = tuple(
        AssemblyPlacement(
            placement.component_id,
            records[placement.component_id].footprint_id,
            placement.position.x,
            placement.position.y,
            placement.rotation_udeg,
        )
        for placement in placements
    )
    profiles = {
        item.placement.subject_id: item for item in resolve_placed_profiles(assembly_placements)
    }
    pads_by_component = {
        component_id: tuple(_pad_bounds(pad) for pad in pads if pad.component_id == component_id)
        for _, component_id, _, _ in FINAL_PLACEMENTS
    }
    parts = tuple(
        FittedPart(
            reference,
            component_id,
            x_nm,
            y_nm,
            _body_bounds(profiles[component_id]),
            _body_bounds(profiles[component_id]),
            RectNm(*profiles[component_id].courtyard_bounds_nm),
            pads_by_component[component_id],
            connector_or_probe=reference in {"J1", "J2", "TP1", "TP2", "TP3", "TP4"},
        )
        for reference, component_id, x_nm, y_nm in FINAL_PLACEMENTS
    )
    return PlannerInput(RectNm(0, 0, 50_000_000, 30_000_000), parts)


def test_rect_clearance_is_zero_for_contact_and_positive_for_disjoint_rectangles() -> None:
    origin = RectNm(0, 0, 10, 10)
    assert origin.clearance_to(RectNm(5, 5, 15, 15)) == 0
    assert origin.clearance_to(RectNm(10, 0, 20, 10)) == 0
    assert origin.clearance_to(RectNm(13, 2, 20, 8)) == 3
    assert origin.clearance_to(RectNm(13, 14, 20, 20)) == 5


def test_reference_input_is_frozen_to_23_real_r2_placements_and_envelopes() -> None:
    planner_input = _input()
    assert len(planner_input.fitted_parts) == len(FINAL_PLACEMENTS) == 23
    assert all(part.pad_envelopes for part in planner_input.fitted_parts)
    assert all(part.source_envelope == part.body_envelope for part in planner_input.fitted_parts)
    assert {part.reference for part in planner_input.fitted_parts} == {
        reference for reference, _, _, _ in FINAL_PLACEMENTS
    }
    assert next(
        part for part in planner_input.fitted_parts if part.reference == "C3"
    ).courtyard_envelope == RectNm(26_640_000, 24_250_000, 31_860_000, 27_750_000)


def test_reference_intent_covers_final_population_and_required_text() -> None:
    requests = reference_silkscreen_requests()
    refs = {
        request.primitive.owner_reference
        for request in requests
        if request.primitive.role == "refdes"
    }
    assert refs == {placement[0] for placement in FINAL_PLACEMENTS}
    text = {request.primitive.text for request in requests}
    assert {"REFERENCE USB C 3V3", "REV 2", "USB 5V IN", "3V3", "GND", "VBUS", "V5"} <= text
    assert {"3V3 OUT 100mA MAX", "DO NOT APPLY POWER"} <= text
    assert all(request.primitive.height_nm >= 600_000 for request in requests)
    assert all(request.primitive.stroke_nm >= 120_000 for request in requests)
    assert (KICAD_GLYPH_ADVANCE_NUMERATOR, KICAD_GLYPH_ADVANCE_DENOMINATOR) == (3, 4)


def test_plan_is_deterministic_and_emits_one_visible_refdes_per_fitted_part() -> None:
    first = plan_silkscreen(_input())
    second = plan_silkscreen(_input())
    assert first == second
    refdes = [
        primitive
        for primitive in first.primitives
        if isinstance(primitive, TextPrimitive) and primitive.role == "refdes"
    ]
    assert {primitive.owner_reference for primitive in refdes} == {
        item[0] for item in FINAL_PLACEMENTS
    }
    assert len(refdes) == len(FINAL_PLACEMENTS)
    assert len(first.primitives) == len(first.reports) == 46
    assert all(report.accepted and report.clearance_nm >= 0 for report in first.reports)
    assert all('layer "F.SilkS"' in primitive for primitive in first.kicad_primitives())
    text_by_id = {
        item.identifier: item for item in first.primitives if isinstance(item, TextPrimitive)
    }
    assert (text_by_id["refdes:C1"].x_nm, text_by_id["refdes:C1"].y_nm) == (
        13_850_000,
        11_100_000,
    )
    assert (text_by_id["output-warning-1"].x_nm, text_by_id["output-warning-1"].y_nm) == (
        39_000_000,
        3_500_000,
    )
    assert (text_by_id["output-warning-2"].x_nm, text_by_id["output-warning-2"].y_nm) == (
        39_000_000,
        4_900_000,
    )
    assert (text_by_id["refdes:C3"].x_nm, text_by_id["refdes:C3"].y_nm) == (
        33_000_000,
        26_500_000,
    )
    assert (text_by_id["refdes:R9"].x_nm, text_by_id["refdes:R9"].y_nm) == (
        29_500_000,
        22_250_000,
    )
    warning_bounds = [
        text_by_id[identifier].expanded_bounds()
        for identifier in ("output-warning-1", "output-warning-2")
    ]
    assert all(
        bounds.min_x_nm >= 500_000
        and bounds.min_y_nm >= 500_000
        and bounds.max_x_nm <= 49_500_000
        and bounds.max_y_nm <= 29_500_000
        for bounds in warning_bounds
    )
    primitives_by_id = {item.identifier: item for item in first.primitives}
    plus_bounds = primitives_by_id["c3-positive"].expanded_bounds()
    assert (
        getattr(primitives_by_id["c3-positive"], "x_nm", None),
        getattr(primitives_by_id["c3-positive"], "y_nm", None),
    ) == (24_900_000, 26_000_000)
    for identifier in (
        "c3-positive-arrow-shaft",
        "c3-positive-arrow-head-a",
        "c3-positive-arrow-head-b",
    ):
        assert plus_bounds.clearance_to(
            primitives_by_id[identifier].expanded_bounds()
        ) > SILK_CLEARANCE_NM
    assert first.digest == "22599058e3c54a14d7db12f2be490947eddd3518226ddf008f60510238f2a379"


def test_required_polarity_and_pin_one_marks_are_explicit() -> None:
    identifiers = {mark.identifier for mark in reference_orientation_marks()}
    assert {
        "d1-cathode",
        "d2-cathode",
        "c3-positive",
        "c3-positive-arrow-shaft",
        "c3-positive-arrow-head-a",
        "c3-positive-arrow-head-b",
    } <= identifiers
    assert {
        "u1-pin1-a",
        "u1-pin1-b",
        "u1-pin1-c",
        "u2-pin1-a",
        "u2-pin1-b",
        "u2-pin1-c",
    } <= identifiers


def test_collision_search_moves_a_blocked_text_without_relaxing_clearance() -> None:
    request = PlacementRequest(
        TextPrimitive("probe", "R", 25_000_000, 5_000_000, 0),
        25_000_000,
        5_000_000,
    )
    candidate, report = silkscreen_module._choose_candidate(  # pyright: ignore[reportPrivateUsage]
        request,
        RectNm(0, 0, 50_000_000, 30_000_000),
        (
            Envelope(
                "blocker", "silk", RectNm(25_550_000, 4_900_000, 25_650_000, 5_100_000), 150_000
            ),
        ),
        [],
    )
    assert candidate is not None
    assert (candidate.x_nm, candidate.y_nm) == (24_800_000, 5_200_000)
    assert report.accepted and report.clearance_nm > 0


def test_missing_verified_geometry_fails_closed() -> None:
    parts = list(_input().fitted_parts)
    missing = parts[0]
    parts[0] = FittedPart(
        missing.reference,
        missing.component_id,
        missing.anchor_x_nm,
        missing.anchor_y_nm,
        None,
        missing.body_envelope,
        missing.courtyard_envelope,
    )
    with pytest.raises(SilkscreenPlanningError, match="lacks verified source geometry"):
        plan_silkscreen(PlannerInput(RectNm(0, 0, 50_000_000, 30_000_000), tuple(parts)))


def test_edge_collision_fails_closed_when_no_candidate_can_fit() -> None:
    tiny = PlannerInput(RectNm(0, 0, 1_000_000, 1_000_000), _input().fitted_parts)
    with pytest.raises(SilkscreenPlanningError, match="unsafe required F.SilkS mark"):
        plan_silkscreen(tiny)

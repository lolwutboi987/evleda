"""Hardening tests for the reference-specific audit receipt."""

from __future__ import annotations

from dataclasses import replace

import pytest

from backend.reference_design import audit as audit_module
from backend.reference_design.audit import audit_reference_board
from backend.reference_design.builder import (
    ReferenceBoardBuild,
    _analog_bias_proof_hash,
    build_reference_board,
)
from backend.reference_design.model import ReferenceDesignViolation
from backend.reference_design.router import FROZEN_ROUTE_PLAN_HASH, FROZEN_ROUTE_REVIEW_HASH


pytestmark = pytest.mark.restricted_evidence


def test_audit_is_deterministic_and_binds_reviewed_route_subject() -> None:
    build = build_reference_board()
    first = audit_reference_board(build)
    second = audit_reference_board(build)
    assert first == second
    assert first.route_provenance == "frozen-authored-route-not-human-reviewed"
    assert first.audit_version == "reference-usb-c-3v3-audit-v5"
    assert first.route_plan_hash == FROZEN_ROUTE_PLAN_HASH
    assert first.route_review_hash == FROZEN_ROUTE_REVIEW_HASH
    assert first.blocking_findings == ()
    assert "frozen-route-hash" in first.passed_check_ids
    assert "analog-bias-proof" in first.passed_check_ids
    assert "source-digest-format" in first.passed_check_ids
    assert "source-evidence-manifest" in first.passed_check_ids
    assert "source-digests" not in first.passed_check_ids
    assert "output-current-target-closure" in first.passed_check_ids
    assert "r2-electrical-constraint-closure" in first.passed_check_ids
    assert {
        "corrected-clearance-positive-margin",
        "cout-entirely-080",
        "enumerated-030-power-throats",
        "no-redundant-route-copper",
        "no-via-in-smd-copper",
        "production-020-clearance-with-public-footprint-usb-exceptions",
        "route-a-output-network",
        "r9-cout-branch-only",
        "split-tee-topology-without-same-net-overlap",
        "thirteen-net-connectivity",
        "u2-external-thermal-vias",
        "u2-output-paths-exclude-r9",
    } <= set(first.passed_check_ids)
    sections = {section.section_id: section for section in first.electrical_calculations.sections}
    assert set(sections) == {
        "current-budget",
        "output-reverse-policy",
        "protection-thresholds",
        "stability",
        "startup",
        "thermal",
    }
    current = {item.quantity_id: item for item in sections["current-budget"].quantities}
    assert current["efuse-ilim-datasheet-table"].minimum is not None
    assert current["efuse-ilim-datasheet-table"].minimum.numerator == 224
    assert current["protected-path-static-load"].typical is not None
    assert current["protected-path-static-load"].typical.numerator == 103_846_533
    assert current["protected-path-static-load"].typical.denominator == 1_000_000
    assert first.electrical_calculations.qualification_blockers


def test_audit_rejects_route_mutation_even_when_the_build_receipt_is_reused() -> None:
    build = build_reference_board()
    object.__setattr__(build, "graph", replace(build.graph, tracks=build.graph.tracks[1:]))
    _rebind_analog_proof(build)
    with pytest.raises(ReferenceDesignViolation, match="frozen-route-population"):
        audit_reference_board(build)


def test_audit_requires_exact_build_type() -> None:
    assert type(build_reference_board()) is ReferenceBoardBuild


def _rebind_analog_proof(build: ReferenceBoardBuild) -> None:
    object.__setattr__(build, "analog_bias_proof_hash", _analog_bias_proof_hash(build.graph))


def test_audit_rejects_u2_thermal_via_net_and_drill_mutations() -> None:
    for attribute, value in (("net_id", "net-3v3"), ("drill_nm", 350_000)):
        build = build_reference_board()
        vias = tuple(
            replace(via, **{attribute: value})
            if via.via_id == "minimal-via:10:gnd-u2-left"
            else via
            for via in build.graph.vias
        )
        object.__setattr__(build, "graph", replace(build.graph, vias=vias))
        _rebind_analog_proof(build)
        with pytest.raises(ReferenceDesignViolation, match="frozen-route-population"):
            audit_reference_board(build)


def test_audit_rejects_thermal_path_and_usb_exception_mutations() -> None:
    build = build_reference_board()
    tracks = tuple(
        replace(track, width_nm=700_000) if track.track_id == "minimal:113:gnd-u2-left" else track
        for track in build.graph.tracks
    )
    object.__setattr__(build, "graph", replace(build.graph, tracks=tracks))
    _rebind_analog_proof(build)
    with pytest.raises(ReferenceDesignViolation, match="frozen-route-population"):
        audit_reference_board(build)

    build = build_reference_board()
    pads = tuple(
        replace(pad, size_x_nm=pad.size_x_nm + 10_000)
        if pad.pad_id in {"pad:usb-j1:A1:0", "pad:usb-j1:B12:0"}
        else pad
        for pad in build.graph.pads
    )
    object.__setattr__(build, "graph", replace(build.graph, pads=pads))
    _rebind_analog_proof(build)
    with pytest.raises(ReferenceDesignViolation, match="USB exception geometry"):
        audit_reference_board(build)


def test_audit_rejects_input_scope_constraint_drift(monkeypatch: pytest.MonkeyPatch) -> None:
    build = build_reference_board()
    original = audit_module.constraints()
    monkeypatch.setattr(
        audit_module,
        "constraints",
        lambda: tuple(
            replace(item, maximum=9_000) if item.constraint_id == "usb-input-scope" else item
            for item in original
        ),
    )
    with pytest.raises(ReferenceDesignViolation, match="usb-input-scope-closure"):
        audit_reference_board(build)


@pytest.mark.parametrize(
    ("component_id", "value"),
    (("ilim-r3", "10k 1%"), ("ovc-r4", "220k 1%"), ("cin-c1", "4.7uF 16V X7R")),
)
def test_audit_rejects_electrical_receipt_component_drift(component_id: str, value: str) -> None:
    build = build_reference_board()
    components = tuple(
        replace(component, value=value) if component.component_id == component_id else component
        for component in build.graph.components
    )
    object.__setattr__(build, "graph", replace(build.graph, components=components))
    _rebind_analog_proof(build)
    with pytest.raises(ReferenceDesignViolation, match="electrical receipt fitted-value"):
        audit_reference_board(build)


@pytest.mark.parametrize(
    ("component_id", "manufacturer_part_number"),
    (
        ("ovc-r5", "CRCW0603220KFKEA"),
        ("cin-c1", "UNREVIEWED-CAPACITOR"),
        ("out-j2", "61300111121"),
    ),
)
def test_audit_rejects_electrical_receipt_mpn_drift(
    component_id: str,
    manufacturer_part_number: str,
) -> None:
    build = build_reference_board()
    mutated = tuple(
        replace(component, manufacturer_part_number=manufacturer_part_number)
        if component.component_id == component_id
        else component
        for component in build.graph.components
    )
    object.__setattr__(build, "graph", replace(build.graph, components=mutated))
    _rebind_analog_proof(build)
    with pytest.raises(ReferenceDesignViolation, match="electrical receipt fitted-value"):
        audit_reference_board(build)

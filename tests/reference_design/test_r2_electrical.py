"""Focused logical/evidence contract for the R2 power architecture."""

from __future__ import annotations

from dataclasses import replace
from fractions import Fraction

from backend.design_kernel import DesignGraph, PinRef, stable_hash
from backend.reference_design.audit import electrical_calculations_for_graph
from backend.reference_design.circuit import build_circuit
from backend.reference_design.model import ReferenceDesignViolation
from backend.reference_design.specification import (
    OUTPUT_MARKING,
    PROJECT_ID,
    SCHEMATIC_REVISION,
    bom,
    components,
    constraints,
    sources,
)


def _logical_graph() -> DesignGraph:
    circuit = build_circuit()
    return DesignGraph(
        schema_version=1,
        project_id=PROJECT_ID,
        components=components(),
        nets=circuit.nets,
        schematic_wires=circuit.wires,
        schematic_junctions=circuit.junctions,
    )


def test_r2_population_pin_and_net_invariants_are_derived_and_exact() -> None:
    fitted = components()
    circuit = build_circuit()
    assert PROJECT_ID == "reference-usb-c-3v3-r2"
    assert SCHEMATIC_REVISION == "REV2"
    assert len(fitted) == len(bom()) == 23
    assert sum(len(component.pins) for component in fitted) == 67
    assert len(circuit.nets) == 13
    assert sum(len(net.members) for net in circuit.nets) == 59
    assert len(circuit.no_connects) == 8
    assert {pin for pin in circuit.no_connects} == {
        PinRef("efuse-u1", "6"),
        PinRef("ldo-u2", "2"),
        *(PinRef("usb-j1", pin) for pin in ("A6", "A7", "A8", "B6", "B7", "B8")),
    }


def test_r2_exact_parts_pin_map_and_capacitor_only_damping_branch() -> None:
    by_ref = {component.reference: component for component in components()}
    assert by_ref["U2"].manufacturer_part_number == "LP38692MPX-3.3/NOPB"
    assert tuple((pin.number, pin.name) for pin in by_ref["U2"].pins) == (
        ("1", "EN"),
        ("2", "NC"),
        ("3", "OUT"),
        ("4", "IN"),
        ("5", "GND/TAB"),
    )
    assert by_ref["R3"].manufacturer_part_number == "CRCW06033K83FKEA"
    assert by_ref["C3"].manufacturer_part_number == "T598B226M010ATE070"
    assert by_ref["C4"].manufacturer_part_number == "C1206C104J3GACTU"
    assert by_ref["R9"].manufacturer_part_number == "WSLP0603R0100FEA"
    assert "U3" not in by_ref

    membership = {
        member: net.name for net in build_circuit().nets for member in net.members
    }
    assert membership[PinRef("ldo-u2", "1")] == "V5_PROTECTED"
    assert membership[PinRef("ldo-u2", "4")] == "V5_PROTECTED"
    assert membership[PinRef("ldo-u2", "3")] == "3V3"
    assert membership[PinRef("ldo-u2", "5")] == "GND"
    assert membership[PinRef("efuse-u1", "2")] == "DVDT_SET"
    assert membership[PinRef("dvdt-c4", "1")] == "DVDT_SET"
    assert membership[PinRef("cout-esr-r9", "1")] == "3V3"
    assert membership[PinRef("cout-esr-r9", "2")] == "COUT_DAMPED"
    assert membership[PinRef("cout-c3", "1")] == "COUT_DAMPED"
    assert membership[PinRef("cout-c3", "2")] == "GND"
    assert membership[PinRef("out-j2", "1")] == "3V3"
    assert membership[PinRef("tp-3", "1")] == "3V3"
    assert by_ref["J2"].value == OUTPUT_MARKING


def test_r2_bom_constraints_and_live_sources_have_exact_parity() -> None:
    component_set = components()
    lines = bom()
    assert {line.component_id for line in lines} == {
        component.component_id for component in component_set
    }
    source_ids = {source.evidence_id for source in sources()}
    assert "src-ap2112" not in source_ids
    assert {
        "src-kemet-c0g-family",
        "src-kemet-c1206c104",
        "src-kemet-t59x",
        "src-ti-lp38692-datasheet",
        "src-vishay-wslp",
    } <= source_ids
    assert all(set(line.source_evidence_ids) <= source_ids for line in lines)
    assert all(set(item.source_evidence_ids) <= source_ids for item in constraints())


def test_r2_calculation_payload_is_canonical_source_linked_and_not_hash_only() -> None:
    payload = electrical_calculations_for_graph(_logical_graph())
    assert {component_id for component_id, _mpn in payload.subject_component_mpns} == {
        component.component_id for component in components()
    }
    sections = {section.section_id: section for section in payload.sections}
    assert set(sections) == {
        "current-budget",
        "output-reverse-policy",
        "protection-thresholds",
        "stability",
        "startup",
        "thermal",
    }
    current = {item.quantity_id: item for item in sections["current-budget"].quantities}
    static = current["protected-path-static-load"].typical
    margin = current["startup-margin-to-engineering-ilim-floor"].minimum
    assert static is not None and (static.numerator, static.denominator) == (
        103_846_533,
        1_000_000,
    )
    assert margin is not None and (margin.numerator, margin.denominator) == (
        102_381_837,
        1_000_000,
    )
    startup = {item.quantity_id: item for item in sections["startup"].quantities}
    assert startup["c4-effective-capacitance"].minimum is not None
    assert startup["c4-effective-capacitance"].minimum.numerator == 18_943
    assert startup["c4-effective-capacitance"].minimum.denominator == 200
    capacitance = startup["downstream-capacitance-assumption"].typical
    inrush = startup["capacitive-inrush"]
    assert capacitance is not None and (capacitance.numerator, capacitance.denominator) == (
        267,
        10,
    )
    assert inrush.minimum is not None and (
        inrush.minimum.numerator,
        inrush.minimum.denominator,
    ) == (194_643, 20_000)
    assert inrush.typical is not None and (
        inrush.typical.numerator,
        inrush.typical.denominator,
    ) == (36_846, 3_125)
    assert inrush.maximum is not None and (
        inrush.maximum.numerator,
        inrush.maximum.denominator,
    ) == (1_412_163, 100_000)
    assert payload.qualification_blockers
    assert stable_hash(
        payload,
        domain="flux-clone-reference-electrical-calculations-v3",
    ) == "798d8348edea4eb9a0ce92d1c556d58b181a8c3a4a8cb3e65ea28b5e88fb4aa5"


def test_r2_downstream_capacitance_receipt_is_derived_from_fitted_bom() -> None:
    fitted_capacitors = {line.reference: line for line in bom() if line.reference in {"C2", "C3"}}
    assert set(fitted_capacitors) == {"C2", "C3"}
    nominal_uf = sum(
        (
            Fraction(line.value.partition("uF")[0])
            for line in fitted_capacitors.values()
        ),
        start=Fraction(),
    )
    assert nominal_uf == Fraction(267, 10)

    payload = electrical_calculations_for_graph(_logical_graph())
    startup = next(section for section in payload.sections if section.section_id == "startup")
    assumption = next(
        item
        for item in startup.quantities
        if item.quantity_id == "downstream-capacitance-assumption"
    ).typical
    assert assumption is not None
    assert Fraction(assumption.numerator, assumption.denominator) == nominal_uf


def test_every_fitted_value_and_mpn_is_part_of_the_exact_calculation_subject() -> None:
    graph = _logical_graph()
    for component in graph.components:
        for field, replacement in (
            ("value", component.value + " DRIFT"),
            (
                "manufacturer_part_number",
                component.manufacturer_part_number + "-DRIFT",
            ),
        ):
            drifted = replace(
                graph,
                components=tuple(
                    replace(item, **{field: replacement}) if item is component else item
                    for item in graph.components
                ),
            )
            try:
                electrical_calculations_for_graph(drifted)
            except ReferenceDesignViolation as error:
                assert "electrical receipt fitted-value/MPN subject drifted" in str(error)
            else:
                raise AssertionError(
                    f"electrical receipt accepted {component.component_id}.{field} drift"
                )

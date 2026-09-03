from __future__ import annotations

import base64
import gzip
import hashlib
from dataclasses import replace
from pathlib import Path

import pytest

from backend.design_kernel import DesignGraph, PinDefinition
from backend.kicad_compile.human_schematic import (
    A4_LANDSCAPE_HEIGHT_NM,
    A4_LANDSCAPE_WIDTH_NM,
    GRID_NM,
    ComponentPlacement,
    GridEnvelope,
    GridPoint,
    HumanSchematicError,
    HumanSchematicPlan,
    PinPort,
    SemanticPin,
    SemanticPinDefinition,
    SymbolCatalog,
    SymbolSource,
    SymbolTemplate,
    WireSegment,
    default_symbol_catalog,
    plan_r2_human_schematic,
    segment_points,
)
from backend.reference_design.circuit import build_circuit
from backend.reference_design.specification import PROJECT_ID, components


def _r2_graph() -> DesignGraph:
    circuit = build_circuit()
    return DesignGraph(
        1,
        PROJECT_ID,
        components=components(),
        nets=circuit.nets,
    ).normalized()


_SOURCE_ROOT = Path(__file__).resolve().parents[3] / "backend" / "kicad_compile" / "human_schematic"


def _source_payload(source: SymbolSource) -> bytes:
    return (_SOURCE_ROOT / source.path).read_bytes()


def _plan(graph: DesignGraph | None = None) -> HumanSchematicPlan:
    return plan_r2_human_schematic(
        _r2_graph() if graph is None else graph,
        source_payload_resolver=_source_payload,
    )


def _placement(plan: HumanSchematicPlan, component_id: str) -> ComponentPlacement:
    return next(item for item in plan.placements if item.component_id == component_id)


def _pin_position(plan: HumanSchematicPlan, component_id: str, pin_number: str) -> GridPoint:
    placement = _placement(plan, component_id)
    return next(
        item.position for item in placement.pin_anchors if item.pin.pin_number == pin_number
    )


def test_r2_population_exact_grid_and_functional_placement() -> None:
    plan = _plan()

    assert len(plan.semantic_graph.components) == 23
    assert len(plan.semantic_graph.nets) == 13
    assert sum(len(item.pin_numbers) for item in plan.semantic_graph.components) == 67
    assert len(plan.semantic_graph.memberships) == 59
    assert len(plan.no_connects) == 8
    assert plan.sheet.paper == "A4"
    assert plan.sheet.orientation == "landscape"
    assert plan.sheet.width_nm == A4_LANDSCAPE_WIDTH_NM
    assert plan.sheet.height_nm == A4_LANDSCAPE_HEIGHT_NM
    assert plan.sheet.connection_grid_nm == GRID_NM
    assert GridPoint(142, 66).x_nm == 180_340_000

    origins = {item.component_id: item.origin for item in plan.placements}
    assert origins["ldo-u2"] == GridPoint(142, 66)
    assert origins["cout-esr-r9"] == GridPoint(160, 75)
    assert origins["cout-c3"] == GridPoint(160, 92)
    assert origins["dvdt-c4"] == GridPoint(78, 57)
    assert _pin_position(plan, "ldo-u2", "1") == GridPoint(134, 68)
    assert _pin_position(plan, "ldo-u2", "2") == GridPoint(150, 66)
    assert _pin_position(plan, "ldo-u2", "3") == GridPoint(150, 72)
    assert _pin_position(plan, "ldo-u2", "4") == GridPoint(134, 72)
    assert _pin_position(plan, "ldo-u2", "5") == GridPoint(142, 56)
    assert _pin_position(plan, "cout-esr-r9", "1") == GridPoint(160, 72)
    assert _pin_position(plan, "cout-esr-r9", "2") == GridPoint(160, 78)
    assert _pin_position(plan, "cout-c3", "1") == GridPoint(160, 89)
    assert _pin_position(plan, "cout-c3", "2") == GridPoint(160, 95)
    assert _pin_position(plan, "dvdt-c4", "1") == GridPoint(78, 60)
    assert _pin_position(plan, "dvdt-c4", "2") == GridPoint(78, 54)

    assert [item.block_id for item in plan.blocks] == [
        "output",
        "protection",
        "regulation",
        "usb-input",
    ]
    assert {item.component_id for item in plan.placements if item.block_id == "regulation"} == {
        "cout-c3",
        "cout-esr-r9",
        "ldo-u2",
        "tp-3",
    }
    assert all(
        (item.envelope.minimum.y, item.envelope.maximum.y, item.title_anchor.y)
        == (14, 118, 18)
        for item in plan.blocks
    )


def test_real_symbol_profiles_sources_and_explicit_properties() -> None:
    plan = _plan()
    template_index = {item.graph_symbol_id: item for item in plan.symbol_templates}

    lp38692 = template_index["Regulator_Linear:LP38692"]
    assert lp38692.flattened_library_id == "FluxHuman:LP38692MPX_3V3"
    assert lp38692.source_ids == ("lp38692-pinout-derivation-receipt",)
    assert [item.emitted_number for item in lp38692.pin_ports] == ["1", "2", "3", "4", "5"]
    assert len(lp38692.template_digest) == 64
    polarized = template_index["Device:C_Polarized"]
    assert polarized.source_ids == ("kicad-device-c-polarized-10.0.6",)
    assert all(len(item.sha256) == 64 and item.byte_length > 0 for item in plan.symbol_sources)
    assert {(item.source_id, item.byte_length, item.sha256) for item in plan.symbol_sources} == {
        (item.source_id, item.byte_length, item.sha256) for item in plan.source_verifications
    }

    for placement in plan.placements:
        assert placement.fields_autoplaced is False
        assert len(placement.properties) == 9
        property_index = {item.name: item for item in placement.properties}
        assert property_index["Reference"].visible
        assert property_index["Value"].visible
        assert property_index["CanonicalComponentId"].value == placement.component_id
        assert all(
            item.component_digest == placement.component_digest
            and item.symbol_template_digest == placement.symbol_template_digest
            for item in placement.properties
        )
        assert not property_index["Footprint"].visible
        assert property_index["Footprint"].anchor == placement.origin
        assert property_index["Footprint"].envelope == GridEnvelope(
            placement.origin, placement.origin
        )

    visible = tuple(
        prop for placement in plan.placements for prop in placement.properties if prop.visible
    )
    assert all(
        prop.anchor == prop.envelope.minimum and prop.envelope.maximum.y == prop.anchor.y
        for prop in visible
    )
    assert all(
        block.title_anchor == block.title_envelope.minimum
        and block.title_envelope.maximum.y == block.title_anchor.y
        for block in plan.blocks
    )
    c3 = _placement(plan, "cout-c3")
    assert all(
        prop.envelope.maximum.x < c3.body.minimum.x
        for prop in c3.properties
        if prop.visible
    )
    bodies = tuple(item.body for item in plan.placements)
    assert all(not prop.envelope.intersects(body) for prop in visible for body in bodies)
    assert all(
        not first.envelope.intersects(second.envelope)
        for index, first in enumerate(visible)
        for second in visible[index + 1 :]
    )


def test_every_semantic_pin_definition_port_and_anchor_binds_exact_graph_pin() -> None:
    graph = _r2_graph()
    plan = _plan(graph)
    semantic_index = {item.component_id: item for item in plan.semantic_graph.components}
    template_index = {item.profile_id: item for item in plan.symbol_templates}
    for component in graph.components:
        expected = tuple(
            sorted(
                (
                    SemanticPinDefinition(
                        pin.number,
                        pin.name,
                        pin.electrical_type,
                        pin.pad_number,
                        pin.required,
                    )
                    for pin in component.pins
                ),
                key=lambda item: item.number,
            )
        )
        semantic = semantic_index[component.component_id]
        placement = _placement(plan, component.component_id)
        template = template_index[placement.symbol_profile_id]
        assert semantic.pin_definitions == expected
        assert tuple(item.canonical_definition for item in template.pin_ports) == expected
        assert tuple(item.canonical_definition for item in placement.pin_anchors) == expected
        assert placement.component_digest == semantic.component_digest
        assert placement.symbol_template_digest == template.template_digest

    assert semantic_index["ldo-u2"].pin_definitions == (
        SemanticPinDefinition("1", "EN", "input", "1", True),
        SemanticPinDefinition("2", "NC", "no_connect", "2", False),
        SemanticPinDefinition("3", "OUT", "power_out", "3", True),
        SemanticPinDefinition("4", "IN", "power_in", "4", True),
        SemanticPinDefinition("5", "GND/TAB", "passive", "5", True),
    )


def test_all_23_placements_profiles_references_and_values_are_exact() -> None:
    plan = _plan()
    expected = {
        "cc-r1": ("R1", "5.1k 1%", "device-r", (42, 98), 0),
        "cc-r2": ("R2", "5.1k 1%", "device-r", (54, 98), 0),
        "cin-c1": ("C1", "1uF 16V X7R", "device-c", (62, 75), 0),
        "cldo-c2": ("C2", "4.7uF 25V X7R", "device-c", (116, 75), 0),
        "cout-c3": (
            "C3",
            "22uF 10V polymer +/-20%",
            "device-c-polarized-t598",
            (160, 92),
            0,
        ),
        "cout-esr-r9": ("R9", "10mOhm 1%", "device-r", (160, 75), 0),
        "dvdt-c4": ("C4", "100nF 25V C0G +/-5%", "device-c", (78, 57), 180),
        "efuse-u1": (
            "U1",
            "0.247A eFuse/OVC latch-off",
            "power-management-tps259620ddar",
            (94, 66),
            0,
        ),
        "en-hi-r6": ("R6", "249k 1%", "device-r", (80, 75), 0),
        "en-lo-r7": ("R7", "100k 1%", "device-r", (80, 81), 0),
        "ilim-r3": ("R3", "3.83k 1%", "device-r", (108, 63), 0),
        "ldo-u2": (
            "U2",
            "3.3V 1A LDO",
            "regulator-lp38692mpx-3v3",
            (142, 66),
            0,
        ),
        "led-d2": ("D2", "green 0603 LED", "device-led", (188, 54), 0),
        "led-r8": ("R8", "1k 1%", "device-r", (174, 54), 270),
        "out-j2": (
            "J2",
            "3V3 OUT 100mA MAX / DO NOT APPLY POWER",
            "connector-01x02",
            (199, 71),
            0,
        ),
        "ovc-r4": ("R4", "200k 1%", "device-r", (106, 90), 0),
        "ovc-r5": ("R5", "200k 1%", "device-r", (106, 96), 0),
        "tp-1": ("TP1", "VBUS_RAW", "connector-testpoint", (70, 72), 0),
        "tp-2": ("TP2", "V5_PROTECTED", "connector-testpoint", (124, 72), 0),
        "tp-3": ("TP3", "3V3", "connector-testpoint", (170, 72), 0),
        "tp-4": ("TP4", "GND", "connector-testpoint", (188, 70), 0),
        "tvs-d1": (
            "D1",
            "5.5V unidirectional TVS",
            "device-d-tvs",
            (52, 75),
            0,
        ),
        "usb-j1": (
            "J1",
            "USB-C 5V sink",
            "connector-usb4105-gf-a",
            (24, 60),
            0,
        ),
    }
    actual = {}
    for placement in plan.placements:
        properties = {item.name: item.value for item in placement.properties}
        actual[placement.component_id] = (
            properties["Reference"],
            properties["Value"],
            placement.symbol_profile_id,
            (placement.origin.x, placement.origin.y),
            placement.rotation_deg,
        )
        assert set(properties) == {
            "CanonicalComponentId",
            "CanonicalPinMapSha256",
            "Datasheet",
            "DatasheetSha256",
            "Description",
            "Footprint",
            "ManufacturerPartNumber",
            "Reference",
            "Value",
        }
    assert actual == expected


def test_orthogonal_routes_have_no_cross_net_or_body_intersections() -> None:
    plan = _plan()
    wire_points = {item.semantic_id: set(segment_points(item)) for item in plan.wires}
    assert plan.global_label_count == 0
    assert all(item.start.x == item.end.x or item.start.y == item.end.y for item in plan.wires)
    for index, first in enumerate(plan.wires):
        for second in plan.wires[index + 1 :]:
            if first.net_id != second.net_id:
                assert wire_points[first.semantic_id].isdisjoint(wire_points[second.semantic_id])
    obstacles = (
        tuple(item.body for item in plan.placements)
        + tuple(
            prop.envelope
            for placement in plan.placements
            for prop in placement.properties
            if prop.visible
        )
        + tuple(item.title_envelope for item in plan.blocks)
    )
    assert all(
        not obstacle.contains(point)
        for points in wire_points.values()
        for point in points
        for obstacle in obstacles
    )

    degree: dict[tuple[str, GridPoint], int] = {}
    for wire in plan.wires:
        degree[(wire.net_id, wire.start)] = degree.get((wire.net_id, wire.start), 0) + 1
        degree[(wire.net_id, wire.end)] = degree.get((wire.net_id, wire.end), 0) + 1
    assert max(degree.values()) <= 3
    assert {(item.net_id, item.position) for item in plan.junctions} == {
        subject for subject, value in degree.items() if value == 3
    }
    assert all(item.degree == 3 for item in plan.junctions)


def test_local_label_fallback_is_deterministic_and_never_global() -> None:
    first = _plan()
    second = _plan()

    assert first.local_labels == second.local_labels
    fallback_reasons = {
        (item.net_id, item.reason)
        for item in first.local_labels
        if item.reason != "canonical-net-name"
    }
    assert fallback_reasons == {
        ("net-gnd", "fanout-limit"),
        ("net-ovc-mid", "coincident-pin-join"),
    }
    assert {item.net_id for item in first.local_labels if item.reason == "canonical-net-name"} == {
        item.net_id
        for item in first.semantic_graph.nets
        if item.net_id not in {"net-gnd", "net-ovc-mid"}
    }
    assert {item.net_id for item in first.local_labels} == {
        item.net_id for item in first.semantic_graph.nets
    }
    wire_endpoints = {(wire.net_id, wire.start) for wire in first.wires} | {
        (wire.net_id, wire.end) for wire in first.wires
    }
    assert all(
        (item.net_id, item.anchor) in wire_endpoints
        for item in first.local_labels
        if item.reason == "canonical-net-name"
    )
    assert {item.name for item in first.local_labels if item.net_id == "net-gnd"} == {"GND"}
    assert all(item.semantic_id.startswith("label:") for item in first.local_labels)
    for item in first.local_labels:
        width = max(2, (3 * len(item.name) + 4) // 5)
        expected_envelope = {
            "east": GridEnvelope(
                item.anchor,
                GridPoint(item.anchor.x + width - 1, item.anchor.y),
            ),
            "west": GridEnvelope(
                GridPoint(item.anchor.x - width + 1, item.anchor.y),
                item.anchor,
            ),
            "north": GridEnvelope(
                GridPoint(item.anchor.x, item.anchor.y - width + 1),
                item.anchor,
            ),
            "south": GridEnvelope(
                item.anchor,
                GridPoint(item.anchor.x, item.anchor.y + width - 1),
            ),
        }[item.direction]
        assert item.envelope == expected_envelope
        for wire in first.wires:
            covered = {
                point for point in segment_points(wire) if item.envelope.contains(point)
            }
            assert covered <= {item.anchor}
    assert first.global_label_count == 0


def test_reviewed_r2_routes_labels_and_junction_are_exact() -> None:
    plan = _plan()

    expected_routes = {
        "net-cc1": (
            ((42, 95), (35, 95)),
            ((35, 95), (35, 68)),
            ((35, 68), (36, 68)),
        ),
        "net-cc2": (
            ((54, 95), (54, 96)),
            ((54, 96), (34, 96)),
            ((34, 96), (34, 66)),
            ((34, 66), (36, 66)),
        ),
        "net-ovcsel": (
            ((106, 87), (101, 87)),
            ((101, 87), (101, 57)),
            ((101, 57), (87, 57)),
            ((87, 57), (87, 61)),
            ((87, 61), (75, 61)),
            ((75, 61), (75, 64)),
            ((75, 64), (86, 64)),
        ),
        "net-cout-damped": (((160, 89), (160, 78)),),
    }
    for net_id, expected in expected_routes.items():
        assert tuple(
            ((wire.start.x, wire.start.y), (wire.end.x, wire.end.y))
            for wire in plan.wires
            if wire.net_id == net_id
        ) == expected

    assert any(
        wire.net_id == "net-3v3"
        and wire.start == GridPoint(195, 72)
        and wire.end == GridPoint(173, 72)
        for wire in plan.wires
    )
    assert {(item.net_id, item.position, item.degree) for item in plan.junctions} == {
        ("net-3v3", GridPoint(173, 72), 3)
    }
    label_index = {(item.name, item.anchor): item.direction for item in plan.local_labels}
    assert label_index[("DVDT_SET", GridPoint(86, 60))] == "north"
    assert label_index[("COUT_DAMPED", GridPoint(160, 89))] == "east"
    assert label_index[("OVC_MID", GridPoint(106, 93))] == "east"
    assert label_index[("GND", GridPoint(94, 56))] == "east"


def test_settled_r2_routing_geometry_matches_exact_golden_payload_and_digests() -> None:
    plan = _plan()
    encoded = Path(__file__).with_name("r2_routing_geometry.json.gz.b64").read_bytes()
    golden = gzip.decompress(base64.b64decode(encoded))

    assert plan.routing_geometry_payload == golden
    assert hashlib.sha256(golden).hexdigest() == (
        "8cc0ae74db0b8e20f715dc9beadfeb46fd4e344d724ca93c22e72f46b7a31f19"
    )
    assert plan.routing_geometry_digest == (
        "7376d4bb292280290ca6bd01bd901f278b35dbba7fbe49e6b413ee8b57ec08ae"
    )
    assert plan.geometry_digest == (
        "62a9dd217eed5187f658337c93cb423c79f7e69aa41e6dca40aaf4a7b65ca105"
    )
    assert plan.plan_digest == ("bc0ca8ca2c08589b5426855ff6c8e1d926c7558f02f261469707289a3581163c")


def test_no_connect_inventory_is_exact_and_dvdt_is_connected() -> None:
    plan = _plan()
    actual = {item.pin for item in plan.no_connects}
    assert actual == {
        SemanticPin("usb-j1", "A6"),
        SemanticPin("usb-j1", "A7"),
        SemanticPin("usb-j1", "A8"),
        SemanticPin("usb-j1", "B6"),
        SemanticPin("usb-j1", "B7"),
        SemanticPin("usb-j1", "B8"),
        SemanticPin("efuse-u1", "6"),
        SemanticPin("ldo-u2", "2"),
    }
    assert SemanticPin("efuse-u1", "2") not in actual
    dvdt = next(item for item in plan.semantic_graph.nets if item.net_id == "net-dvdt")
    assert dvdt.name == "DVDT_SET"
    assert {item.pin for item in plan.semantic_graph.memberships if item.net_id == "net-dvdt"} == {
        SemanticPin("efuse-u1", "2"),
        SemanticPin("dvdt-c4", "1"),
    }


def test_lp38692_and_damped_capacitor_branch_preserve_r2_topology() -> None:
    plan = _plan()
    component_index = {item.component_id: item for item in plan.semantic_graph.components}
    assert component_index["ldo-u2"].manufacturer_part_number == "LP38692MPX-3.3/NOPB"
    assert component_index["ilim-r3"].manufacturer_part_number == "CRCW06033K83FKEA"
    assert component_index["cout-esr-r9"].manufacturer_part_number == "WSLP0603R0100FEA"
    assert component_index["cout-c3"].manufacturer_part_number == "T598B226M010ATE070"
    assert component_index["dvdt-c4"].manufacturer_part_number == "C1206C104J3GACTU"

    members = {
        net.net_id: {
            item.pin for item in plan.semantic_graph.memberships if item.net_id == net.net_id
        }
        for net in plan.semantic_graph.nets
    }
    assert {
        SemanticPin("ldo-u2", "1"),
        SemanticPin("ldo-u2", "4"),
    }.issubset(members["net-v5-protected"])
    assert members["net-cout-damped"] == {
        SemanticPin("cout-esr-r9", "2"),
        SemanticPin("cout-c3", "1"),
    }
    assert SemanticPin("cout-esr-r9", "1") in members["net-3v3"]
    assert SemanticPin("cout-c3", "1") not in members["net-3v3"]
    assert SemanticPin("cout-c3", "2") in members["net-gnd"]
    assert SemanticPin("ldo-u2", "3") in members["net-3v3"]
    assert SemanticPin("ldo-u2", "5") in members["net-gnd"]


def test_permuted_graph_produces_identical_plan_and_digest() -> None:
    graph = _r2_graph()
    permuted = replace(
        graph,
        components=tuple(reversed(graph.components)),
        nets=tuple(
            replace(net, members=tuple(reversed(net.members))) for net in reversed(graph.nets)
        ),
    )

    first = _plan(graph)
    second = _plan(permuted)
    assert first == second
    assert first.canonical_payload == second.canonical_payload
    assert first.plan_digest == second.plan_digest


def test_semantic_mutation_changes_digest_without_coordinate_ids() -> None:
    graph = _r2_graph()
    baseline = _plan(graph)
    mutated_components = tuple(
        replace(component, value="100nF 25V C0G +/-5% MUTATION")
        if component.component_id == "dvdt-c4"
        else component
        for component in graph.components
    )
    mutated = _plan(replace(graph, components=mutated_components))

    assert mutated.plan_digest != baseline.plan_digest
    assert (
        mutated.semantic_graph.subject_graph_sha256 != baseline.semantic_graph.subject_graph_sha256
    )
    assert {item.semantic_id for item in mutated.placements} == {
        item.semantic_id for item in baseline.placements
    }
    assert {item.semantic_id for item in mutated.semantic_graph.memberships} == {
        item.semantic_id for item in baseline.semantic_graph.memberships
    }

    wire = baseline.wires[0]
    changed_end = (
        GridPoint(wire.end.x + 1, wire.end.y)
        if wire.start.y == wire.end.y
        else GridPoint(wire.end.x, wire.end.y + 1)
    )
    moved_wire = replace(wire, end=changed_end)
    assert moved_wire.semantic_id == wire.semantic_id
    assert moved_wire.route_id == wire.route_id
    assert moved_wire != wire


def test_unknown_or_wrong_symbol_profile_fails_closed() -> None:
    graph = _r2_graph()
    c4 = next(item for item in graph.components if item.component_id == "dvdt-c4")
    unknown = replace(c4, symbol_id="Unknown:C")
    unknown_graph = replace(
        graph,
        components=tuple(
            unknown if item.component_id == c4.component_id else item for item in graph.components
        ),
    )
    with pytest.raises(HumanSchematicError) as captured:
        _plan(unknown_graph)
    assert captured.value.code == "human-symbol-template-required"

    wrong_known = replace(c4, symbol_id="Device:R")
    wrong_graph = replace(
        graph,
        components=tuple(
            wrong_known if item.component_id == c4.component_id else item
            for item in graph.components
        ),
    )
    with pytest.raises(HumanSchematicError) as captured:
        _plan(wrong_graph)
    assert captured.value.code == "human-component-profile-mismatch"


def test_pin_name_type_pad_and_required_mutations_fail_exact_profile_binding() -> None:
    graph = _r2_graph()
    for mutation in ("name", "electrical_type", "pad_number", "required"):
        component = next(item for item in graph.components if item.component_id == "dvdt-c4")
        pins: list[PinDefinition] = []
        for pin in component.pins:
            if pin.number != "1":
                pins.append(pin)
            elif mutation == "name":
                pins.append(replace(pin, name="MUTATED_PIN_NAME"))
            elif mutation == "electrical_type":
                pins.append(replace(pin, electrical_type="output"))
            elif mutation == "pad_number":
                pins.append(replace(pin, pad_number="99"))
            else:
                pins.append(replace(pin, required=False))
        mutated_component = replace(component, pins=tuple(pins))
        mutated_graph = replace(
            graph,
            components=tuple(
                mutated_component if item.component_id == component.component_id else item
                for item in graph.components
            ),
        )
        with pytest.raises(HumanSchematicError) as captured:
            _plan(mutated_graph)
        assert captured.value.code == "human-symbol-pin-profile-mismatch"


def test_template_placement_anchor_and_property_binding_mutations_fail() -> None:
    graph = _r2_graph()
    catalog = default_symbol_catalog()
    template = next(item for item in catalog.templates if item.graph_symbol_id == "Device:C")
    first_port = template.pin_ports[0]
    mutated_port = replace(first_port, canonical_name="MUTATED_PIN_NAME")
    mutated_template = replace(
        template,
        pin_ports=(mutated_port,) + template.pin_ports[1:],
    )
    mutated_catalog = SymbolCatalog(
        catalog.sources,
        tuple(
            mutated_template if item.profile_id == template.profile_id else item
            for item in catalog.templates
        ),
    )
    with pytest.raises(HumanSchematicError) as captured:
        plan_r2_human_schematic(
            graph,
            catalog=mutated_catalog,
            source_payload_resolver=_source_payload,
        )
    assert captured.value.code == "human-symbol-pin-profile-mismatch"

    plan = _plan(graph)
    placement = _placement(plan, "dvdt-c4")
    mutated_placement = replace(placement, component_digest="0" * 64)
    with pytest.raises(ValueError, match="exact semantic component"):
        replace(
            plan,
            placements=tuple(
                mutated_placement if item.component_id == placement.component_id else item
                for item in plan.placements
            ),
        )

    anchor = placement.pin_anchors[0]
    mutated_anchor = replace(
        anchor,
        canonical_definition=replace(
            anchor.canonical_definition,
            name="MUTATED_PIN_NAME",
        ),
    )
    anchor_placement = replace(
        placement,
        pin_anchors=(mutated_anchor,) + placement.pin_anchors[1:],
    )
    with pytest.raises(ValueError, match="canonical graph pin definition"):
        replace(
            plan,
            placements=tuple(
                anchor_placement if item.component_id == placement.component_id else item
                for item in plan.placements
            ),
        )

    value_property = next(item for item in placement.properties if item.name == "Value")
    mutated_property = replace(value_property, value="MUTATED PROPERTY")
    property_placement = replace(
        placement,
        properties=tuple(
            mutated_property if item.name == value_property.name else item
            for item in placement.properties
        ),
    )
    with pytest.raises(ValueError, match="properties do not exactly project"):
        replace(
            plan,
            placements=tuple(
                property_placement if item.component_id == placement.component_id else item
                for item in plan.placements
            ),
        )

    with pytest.raises(ValueError, match="property names must be unique"):
        replace(
            placement,
            properties=tuple(
                sorted(
                    placement.properties + (placement.properties[0],),
                    key=lambda item: item.name,
                )
            ),
        )


def test_r2_population_mutation_fails_closed() -> None:
    graph = _r2_graph()
    mutated = replace(
        graph,
        components=tuple(item for item in graph.components if item.component_id != "tp-4"),
        nets=tuple(
            replace(
                net,
                members=tuple(item for item in net.members if item.component_id != "tp-4"),
            )
            for net in graph.nets
        ),
    )
    with pytest.raises(HumanSchematicError) as captured:
        _plan(mutated)
    assert captured.value.code == "human-r2-topology-mismatch"


def test_planner_requires_and_verifies_an_explicit_source_payload_resolver() -> None:
    graph = _r2_graph()
    with pytest.raises(HumanSchematicError) as captured:
        plan_r2_human_schematic(graph)
    assert captured.value.code == "human-symbol-source-resolver-required"

    def mutated_resolver(source: SymbolSource) -> bytes:
        payload = _source_payload(source)
        if source.source_id == "kicad-device-c-10.0.6":
            return payload[:-1] + bytes((payload[-1] ^ 1,))
        return payload

    with pytest.raises(HumanSchematicError) as captured:
        plan_r2_human_schematic(graph, source_payload_resolver=mutated_resolver)
    assert captured.value.code == "human-symbol-source-digest-mismatch"


def test_catalog_source_payload_verification_detects_one_byte_mutation() -> None:
    payload = b"reviewed-symbol-source"
    source = SymbolSource(
        "source-fixture",
        "test authority",
        "fixture revision",
        "fixture.kicad_sym",
        len(payload),
        hashlib.sha256(payload).hexdigest(),
    )
    template = SymbolTemplate(
        "profile-fixture",
        "Fixture:Symbol",
        "FluxHuman:Fixture",
        "flattened fixture",
        GridEnvelope(GridPoint(-1, -1), GridPoint(1, 1)),
        (
            PinPort(
                "1",
                "1",
                "passive",
                "1",
                "passive",
                "1",
                True,
                GridPoint(0, 2),
                "south",
            ),
        ),
        (source.source_id,),
    )
    catalog = SymbolCatalog((source,), (template,))

    catalog.verify_source_payloads({source.source_id: payload})
    with pytest.raises(HumanSchematicError) as captured:
        catalog.verify_source_payloads({source.source_id: payload[:-1] + b"X"})
    assert captured.value.code == "human-symbol-source-digest-mismatch"


def test_default_catalog_digest_is_stable() -> None:
    first = default_symbol_catalog()
    second = default_symbol_catalog()
    assert first == second
    assert first.catalog_digest == second.catalog_digest
    assert len(first.catalog_digest) == 64
    assert len({item.template_digest for item in first.templates}) == len(first.templates)


def test_wire_segment_rejects_nonorthogonal_geometry() -> None:
    with pytest.raises(ValueError, match="orthogonal"):
        WireSegment(
            "wire:route:fixture:0",
            "route:fixture",
            "net-fixture",
            0,
            GridPoint(1, 1),
            GridPoint(2, 2),
        )


def test_plan_mutations_cannot_add_body_penetration_or_cross_net_intersection() -> None:
    plan = _plan()
    penetration_route = "route:net-dvdt:penetration-probe"
    penetration = WireSegment(
        f"wire:{penetration_route}:0",
        penetration_route,
        "net-dvdt",
        0,
        GridPoint(86, 60),
        GridPoint(90, 60),
    )
    with pytest.raises(ValueError, match="penetrate"):
        replace(
            plan,
            wires=tuple(sorted(plan.wires + (penetration,), key=lambda item: item.semantic_id)),
        )

    crossing_route = "route:net-cc1:cross-net-probe"
    crossing = WireSegment(
        f"wire:{crossing_route}:0",
        crossing_route,
        "net-cc1",
        0,
        GridPoint(40, 72),
        GridPoint(48, 72),
    )
    with pytest.raises(ValueError, match="Different schematic nets|different schematic nets"):
        replace(
            plan,
            wires=tuple(sorted(plan.wires + (crossing,), key=lambda item: item.semantic_id)),
        )


def test_label_junction_nc_and_global_label_mutations_fail_closed() -> None:
    plan = _plan()
    label = plan.local_labels[0]
    mutated_label = replace(label, name="BAD")
    with pytest.raises(ValueError, match="semantic net name"):
        replace(
            plan,
            local_labels=tuple(
                mutated_label if item.semantic_id == label.semantic_id else item
                for item in plan.local_labels
            ),
        )

    wire_covering_label = replace(
        label,
        direction="west",
        envelope=GridEnvelope(label.anchor.moved("west"), label.anchor),
    )
    with pytest.raises(ValueError, match="wire beyond its anchor"):
        replace(
            plan,
            local_labels=tuple(
                wire_covering_label if item.semantic_id == label.semantic_id else item
                for item in plan.local_labels
            ),
        )

    wrong_member_label = replace(
        label,
        members=(SemanticPin("dvdt-c4", "1"),),
    )
    with pytest.raises(ValueError, match="members of their exact semantic net"):
        replace(
            plan,
            local_labels=tuple(
                wrong_member_label if item.semantic_id == label.semantic_id else item
                for item in plan.local_labels
            ),
        )

    with pytest.raises(ValueError, match="every semantic net requires"):
        replace(
            plan,
            local_labels=tuple(item for item in plan.local_labels if item.net_id != "net-3v3"),
        )

    junction = plan.junctions[0]
    mutated_junction = replace(junction, position=junction.position.moved("south"))
    with pytest.raises(ValueError, match="junction inventory"):
        replace(plan, junctions=(mutated_junction,))

    no_connect = plan.no_connects[0]
    mutated_no_connect = replace(
        no_connect,
        marker=no_connect.marker.moved("east"),
    )
    with pytest.raises(ValueError, match="exact emitted pin anchor"):
        replace(
            plan,
            no_connects=tuple(
                mutated_no_connect if item.semantic_id == no_connect.semantic_id else item
                for item in plan.no_connects
            ),
        )

    with pytest.raises(ValueError, match="global labels are forbidden"):
        replace(plan, global_label_count=1)


def test_visible_text_envelopes_reject_non_left_anchored_mutations() -> None:
    plan = _plan()
    placement = plan.placements[0]
    prop = next(item for item in placement.properties if item.visible)
    with pytest.raises(ValueError, match="left-anchored"):
        replace(
            prop,
            envelope=GridEnvelope(prop.anchor.moved("west"), prop.envelope.maximum),
        )

    block = plan.blocks[0]
    with pytest.raises(ValueError, match="left-anchored"):
        replace(
            block,
            title_envelope=GridEnvelope(
                block.title_anchor.moved("west"),
                block.title_envelope.maximum,
            ),
        )


def test_degree_duplicate_and_same_net_overlap_mutations_fail_closed() -> None:
    plan = _plan()
    junction = plan.junctions[0]
    degree_route = "route:net-3v3:degree-probe"
    degree_wire = WireSegment(
        f"wire:{degree_route}:0",
        degree_route,
        "net-3v3",
        0,
        junction.position,
        junction.position.moved("south", 3),
    )
    with pytest.raises(ValueError, match="degree cannot exceed three"):
        replace(
            plan,
            wires=tuple(sorted(plan.wires + (degree_wire,), key=lambda item: item.semantic_id)),
        )

    with pytest.raises(ValueError, match="semantic IDs must be unique"):
        replace(
            plan,
            wires=tuple(sorted(plan.wires + (plan.wires[0],), key=lambda item: item.semantic_id)),
        )

    base = next(
        item
        for item in plan.wires
        if item.net_id == "net-vbus-raw" and abs(item.start.x - item.end.x) >= 4
    )
    low_x = min(base.start.x, base.end.x)
    overlap_route = "route:net-vbus-raw:overlap-probe"
    overlap = WireSegment(
        f"wire:{overlap_route}:0",
        overlap_route,
        "net-vbus-raw",
        0,
        GridPoint(low_x + 1, base.start.y),
        GridPoint(low_x + 3, base.start.y),
    )
    with pytest.raises(ValueError, match="same-net segments"):
        replace(
            plan,
            wires=tuple(sorted(plan.wires + (overlap,), key=lambda item: item.semantic_id)),
        )

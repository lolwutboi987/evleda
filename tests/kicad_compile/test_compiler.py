from __future__ import annotations

import hashlib
import json
import subprocess
from collections import Counter
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from backend.design_kernel import DesignGraph, PinDefinition, PointNm, SchematicWire
from backend.kicad_compile import (
    COMPILER_ID,
    CompilationBlockedError,
    CompilationParityError,
    CompilationProfileEvidence,
    CompiledProject,
    compile_design_graph,
    verify_compiled_project,
)
from backend.kicad_compile.compiler import (
    _board_to_local,
    _boxes_intersect,
    _expanded,
    _local_to_board,
    _manifest_payload,
    _pad_bounds,
    _sha256,
    _text_box,
    _uuid,
    _world_box,
)
from backend.kicad_io import PadKind, export_board, import_board
from backend.kicad_io.sexpr import head, parse, scalar_text
from backend.kicad_project import (
    BundleLimits,
    import_project_bundle,
    parse_hermetic_project_libraries,
    parse_project_manifest,
    parse_schematic,
)
from backend.reference_design.builder import _bind_pad_nets, _board_outline
from backend.reference_design.circuit import build_circuit
from backend.reference_design.footprints import build_footprints
from backend.reference_design.layout import build_layout
from backend.reference_design.model import ReferenceDesignViolation
from backend.reference_design.specification import PROJECT_ID
from backend.reference_design.specification import components as reference_components
from tests.kicad_cli import discover_kicad_cli

from .fixtures import reference_graph

_KICAD_10_0_6_CLI = discover_kicad_cli()


def test_board_local_transform_matches_kicad_clockwise_screen_rotation() -> None:
    origin = PointNm(25_000_000, 16_000_000)
    canonical_pad = PointNm(25_000_000, 14_975_000)
    local = _board_to_local(canonical_pad, origin, 90_000_000)
    assert (local.x, local.y) == (1_025_000, 0)
    restored = _local_to_board(local, origin, 90_000_000)
    assert (restored.x, restored.y) == (canonical_pad.x, canonical_pad.y)

    canonical_pad_2 = PointNm(25_000_000, 17_025_000)
    local_2 = _board_to_local(canonical_pad_2, origin, 90_000_000)
    assert (local_2.x, local_2.y) == (-1_025_000, 0)
    restored_2 = _local_to_board(local_2, origin, 90_000_000)
    assert (restored_2.x, restored_2.y) == (canonical_pad_2.x, canonical_pad_2.y)


def test_compiles_deterministic_closed_hermetic_project_with_strict_reparse() -> None:
    graph = reference_graph()
    first = compile_design_graph(graph, "power_reference")
    second = compile_design_graph(graph, "power_reference")

    assert first == second
    assert first.project_filename == "power_reference.kicad_pro"
    assert first.schematic_filename == "power_reference.kicad_sch"
    assert first.board_filename == "power_reference.kicad_pcb"
    assert first.manifest.compiler_id == COMPILER_ID
    assert first.manifest.input_graph_sha256 == graph.graph_hash
    assert first.manifest.semantic_parity
    assert first.manifest.reference_design_ready
    assert first.kicad_execution == "not-run"
    assert not first.manifest.manufacturing_release_eligible
    assert first.manifest_sha256 == hashlib.sha256(first.manifest_payload).hexdigest()
    names = {item.relative_name for item in first.bundle.all_files}
    assert {
        "FluxGenerated.kicad_sym",
        "fp-lib-table",
        "sym-lib-table",
        "power_reference.kicad_pcb",
        "power_reference.kicad_pro",
        "power_reference.kicad_sch",
    } <= names
    assert len(
        [item for item in names if item.startswith("FluxGenerated.pretty/")]
    ) == len(graph.components)
    assert tuple(item.filename for item in first.manifest.files) == tuple(
        item.relative_name for item in first.bundle.all_files
    )
    libraries = parse_hermetic_project_libraries(first.bundle.auxiliary_files)
    assert len(libraries.symbol_library.definitions) == len(
        {item.symbol_id for item in graph.components}
    )
    assert len(libraries.footprint_modules) == len(graph.components)
    imported_bundle = import_project_bundle(first.bundle)
    assert imported_bundle.bundle.auxiliary_files == first.bundle.auxiliary_files
    assert imported_bundle.evidence.auxiliary_source_manifest_sha256 == (
        first.bundle.auxiliary_manifest_sha256
    )

    project = parse_project_manifest(
        first.bundle.project_payload,
        stem=first.bundle.stem,
        limits=BundleLimits(),
    )
    schematic = parse_schematic(first.bundle.schematic_payload, limits=BundleLimits())
    board = import_board(first.bundle.board_payload).board
    assert not project.diagnostics.unsupported
    assert not schematic.diagnostics.unsupported
    assert not board.diagnostics.unsupported
    assert {item.name for item in schematic.nets} == {"VIN", "GND"}
    assert {item.name for item in board.nets} == {"VIN", "GND"}


def test_slot_and_shared_land_are_reversible_and_identity_bound() -> None:
    artifact = compile_design_graph(reference_graph(), "slot_shared_land")
    board = import_board(artifact.bundle.board_payload).board
    connector = next(item for item in board.footprints if item.reference == "J1")
    slot = next(item for item in connector.pads if item.number == "1")
    assert slot.kind is PadKind.THROUGH_HOLE
    assert (slot.drill_x_nm, slot.drill_y_nm) == (900_000, 1_500_000)

    shield = next(item for item in board.footprints if item.reference == "SH1")
    assert {item.number for item in shield.pads} == {"1", "2"}
    assert shield.pads[0].position == shield.pads[1].position
    group_binding = next(
        item
        for item in artifact.manifest.identity_bindings
        if item.source_kind == "shared-land-group" and item.source_id == "shield-land"
    )
    assert len(group_binding.emitted_ids) == 2

    npth = next(item for item in connector.pads if item.kind is PadKind.NPTH)
    assert npth.number == ""
    assert npth.net_id is None
    assert (npth.drill_x_nm, npth.drill_y_nm, npth.drill_rotation_udeg) == (
        1_000_000,
        1_600_000,
        90_000_000,
    )


def test_component_unique_module_ids_survive_casefolding_reference_aliases() -> None:
    graph = reference_graph()
    changed_components = tuple(
        replace(item, reference="j1") if item.component_id == "component-u1" else item
        for item in graph.components
    )
    artifact = compile_design_graph(
        replace(graph, components=changed_components),
        "casefold_references",
    )
    board = import_board(artifact.bundle.board_payload).board
    links = tuple(item.library_id for item in board.footprints)
    assert len(links) == len(set(item.casefold() for item in links))
    module_ids = tuple(
        item.relative_name.removeprefix("FluxGenerated.pretty/")
        for item in artifact.bundle.auxiliary_files
        if item.relative_name.startswith("FluxGenerated.pretty/")
    )
    assert len(module_ids) == len(set(item.casefold() for item in module_ids))


def _child(expression: tuple[object, ...], wanted: str) -> tuple[object, ...]:
    return next(item for item in expression[1:] if isinstance(item, tuple) and head(item) == wanted)


def _children(expression: tuple[object, ...], wanted: str) -> tuple[tuple[object, ...], ...]:
    return tuple(
        item for item in expression[1:] if isinstance(item, tuple) and head(item) == wanted
    )


def test_native_kicad10_board_schema_binds_stackup_layers_and_pad_net_names() -> None:
    artifact = compile_design_graph(reference_graph(), "native_schema")
    root = parse(artifact.bundle.board_payload)
    assert isinstance(root, tuple)
    assert scalar_text(_child(root, "version")[1], label="board version") == "20241229"

    general = _child(root, "general")
    assert scalar_text(_child(general, "thickness")[1], label="board thickness") == "0.8"
    setup = _child(root, "setup")
    stackup = _child(setup, "stackup")
    stackup_layers = {
        scalar_text(item[1], label="stackup layer"): item for item in _children(stackup, "layer")
    }
    assert (
        scalar_text(_child(stackup_layers["F.Cu"], "thickness")[1], label="front copper") == "0.035"
    )
    assert (
        scalar_text(_child(stackup_layers["B.Cu"], "thickness")[1], label="back copper") == "0.035"
    )
    assert (
        scalar_text(
            _child(stackup_layers["dielectric 1"], "thickness")[1],
            label="dielectric",
        )
        == "0.71"
    )
    assert scalar_text(_child(stackup, "copper_finish")[1], label="finish") == "ENIG"

    layer_table = {
        scalar_text(item[1], label="layer name"): int(scalar_text(item[0], label="layer ordinal"))
        for item in _child(root, "layers")[1:]
        if isinstance(item, tuple)
    }
    assert layer_table == {
        "F.Cu": 0,
        "B.Cu": 2,
        "F.Mask": 1,
        "B.Mask": 3,
        "F.SilkS": 5,
        "B.SilkS": 7,
        "F.Paste": 13,
        "B.Paste": 15,
        "Edge.Cuts": 25,
        "F.CrtYd": 31,
        "F.Fab": 35,
    }
    net_names = {
        scalar_text(item[1], label="net code"): scalar_text(item[2], label="net name")
        for item in _children(root, "net")
    }
    for footprint in _children(root, "footprint"):
        for pad in _children(footprint, "pad"):
            net = _children(pad, "net")
            if not net:
                continue
            assert len(net[0]) == 3
            code = scalar_text(net[0][1], label="pad net code")
            assert scalar_text(net[0][2], label="pad net name") == net_names[code]


def test_schematic_symbols_are_visible_separated_and_use_global_net_labels() -> None:
    graph = reference_graph()
    artifact = compile_design_graph(graph, "reviewable_schematic")
    root = parse(artifact.bundle.schematic_payload)
    assert isinstance(root, tuple)
    library = _child(root, "lib_symbols")
    for symbol in _children(library, "symbol"):
        nested = _children(symbol, "symbol")
        assert any(_children(item, "rectangle") for item in nested)
        pins = tuple(pin for item in nested for pin in _children(item, "pin"))
        assert pins
        assert all(len(_child(pin, "at")) == 4 for pin in pins)

    placed = _children(root, "symbol")
    assert len(placed) == len(graph.components)
    for symbol in placed:
        properties = {
            scalar_text(item[1], label="property name"): item
            for item in _children(symbol, "property")
        }
        assert _child(properties["Reference"], "at") != _child(properties["Value"], "at")
        footprint_effects = _child(properties["Footprint"], "effects")
        assert (
            scalar_text(_child(footprint_effects, "hide")[1], label="property visibility") == "yes"
        )

    assert not _children(root, "label")
    global_labels = _children(root, "global_label")
    label_positions = {
        (
            int(Decimal(scalar_text(_child(item, "at")[1], label="label x")) * 1_000_000),
            int(Decimal(scalar_text(_child(item, "at")[2], label="label y")) * 1_000_000),
        )
        for item in global_labels
    }
    wire_endpoints = {
        (point.x, point.y)
        for wire in graph.schematic_wires
        for point in (wire.vertices[0], wire.vertices[-1])
    }
    assert wire_endpoints <= label_positions


def test_installed_kicad_10_0_6_loads_and_reports_compiler_output(tmp_path: Path) -> None:
    if _KICAD_10_0_6_CLI is None:
        pytest.skip("KiCad CLI is not configured with EVLEDA_KICAD_CLI or on PATH")
    version = subprocess.run(
        [str(_KICAD_10_0_6_CLI), "version"],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if version.returncode != 0 or version.stdout.strip() != "10.0.6":
        pytest.skip("the installed KiCad CLI is not the reviewed 10.0.6 build")

    artifact = compile_design_graph(reference_graph(), "live_native")
    schematic = tmp_path / artifact.schematic_filename
    board = tmp_path / artifact.board_filename
    _stage_compiled_project(tmp_path, artifact)

    erc_report = tmp_path / "erc.json"
    erc = subprocess.run(
        [
            str(_KICAD_10_0_6_CLI),
            "sch",
            "erc",
            "--format",
            "json",
            "--severity-all",
            "--exit-code-violations",
            "--output",
            str(erc_report),
            str(schematic),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert erc.returncode == 0, erc.stderr or erc.stdout
    erc_payload = json.loads(erc_report.read_text(encoding="utf-8"))
    erc_violations = [
        violation for sheet in erc_payload["sheets"] for violation in sheet["violations"]
    ]
    assert not erc_violations

    drc_report = tmp_path / "drc.json"
    drc = subprocess.run(
        [
            str(_KICAD_10_0_6_CLI),
            "pcb",
            "drc",
            "--format",
            "json",
            "--severity-all",
            "--schematic-parity",
            "--exit-code-violations",
            "--output",
            str(drc_report),
            str(board),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert drc.returncode == 0, drc.stderr or drc.stdout
    drc_payload = json.loads(drc_report.read_text(encoding="utf-8"))
    assert not drc_payload["schematic_parity"]
    assert not drc_payload["unconnected_items"]
    assert not drc_payload["violations"]

    rotated_graph = replace(
        reference_graph(),
        placements=(
            reference_graph().placements[0],
            replace(reference_graph().placements[1], rotation_udeg=90_000_000),
            reference_graph().placements[2],
        ),
    )
    rotated_artifact = compile_design_graph(rotated_graph, "live_rotated")
    rotated_directory = tmp_path / "rotated"
    rotated_directory.mkdir()
    _stage_compiled_project(rotated_directory, rotated_artifact)
    rotated_board = rotated_directory / rotated_artifact.board_filename
    rotated_report = rotated_directory / "drc.json"
    rotated_drc = subprocess.run(
        [
            str(_KICAD_10_0_6_CLI),
            "pcb",
            "drc",
            "--format",
            "json",
            "--severity-all",
            "--schematic-parity",
            "--exit-code-violations",
            "--output",
            str(rotated_report),
            str(rotated_board),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert rotated_drc.returncode == 0, rotated_drc.stderr or rotated_drc.stdout
    rotated_payload = json.loads(rotated_report.read_text(encoding="utf-8"))
    assert not rotated_payload["schematic_parity"]
    assert not rotated_payload["unconnected_items"]
    assert not rotated_payload["violations"]


def _graphic_texts(artifact: object) -> list[tuple[str, str, tuple[object, ...]]]:
    board = import_board(artifact.bundle.board_payload).board
    result: list[tuple[str, str, tuple[object, ...]]] = []
    for construct in board.diagnostics.constructs:
        expression = parse(construct.canonical_sexpr.encode("utf-8"))
        if head(expression) not in {"fp_text", "gr_text"}:
            continue
        values = expression
        text_index = 2 if head(expression) == "fp_text" else 1
        result.append(
            (
                construct.scope,
                scalar_text(values[text_index], label="graphic text"),
                values,
            )
        )
    return result


def test_reference_board_has_digest_bound_review_graphics_with_clear_silkscreen() -> None:
    graph = reference_graph()
    artifact = compile_design_graph(graph, "review_graphics")
    board = import_board(artifact.bundle.board_payload).board
    texts = _graphic_texts(artifact)
    values = {text for _, text, _ in texts}

    assert {"J1 USB INPUT", "U1", "SH1", "VIN", "GND", "REFERENCE POWER BOARD", "REV 1"} <= values
    assert "F.Fab" in {layer.name for layer in board.layers}
    assert any('(layer "F.Fab")' in item.canonical_sexpr for item in board.diagnostics.constructs)
    assert not any(
        '(layer "F.CrtYd")' in item.canonical_sexpr for item in board.diagnostics.constructs
    )
    assert not board.diagnostics.unsupported
    # The low-level codec deliberately omits KiCad 10's redundant pad net-name
    # token.  Its re-emission is therefore not the compiler's final byte stream,
    # but it must preserve the modeled board and every review construct exactly.
    reemitted = import_board(export_board(board).payload).board
    assert reemitted.normalized_ir_sha256 == board.normalized_ir_sha256
    assert reemitted.diagnostics.manifest_sha256 == board.diagnostics.manifest_sha256
    assert reemitted.diagnostics.constructs == board.diagnostics.constructs

    placements = {item.component_id: item for item in graph.placements}
    components = {item.reference: item for item in graph.components}
    footprints = {item.footprint_id: item for item in board.footprints}
    forbidden = []
    for footprint in board.footprints:
        component = components[footprint.reference]
        placement = placements[component.component_id]
        forbidden.append(
            _expanded(
                _world_box(
                    _pad_bounds(footprint.pads, placement.rotation_udeg),
                    placement.position,
                    placement.rotation_udeg,
                ),
                300_000,
            )
        )
    graphic_boxes = []
    outline = graph.normalized().board_outline
    board_bounds = (
        min(point.x for point in outline),
        min(point.y for point in outline),
        max(point.x for point in outline),
        max(point.y for point in outline),
    )
    for scope, text, expression in texts:
        at = _child(expression, "at")
        position = PointNm(
            int(Decimal(scalar_text(at[1], label="graphic x")) * 1_000_000),
            int(Decimal(scalar_text(at[2], label="graphic y")) * 1_000_000),
        )
        font = _child(_child(expression, "effects"), "font")
        size = _child(font, "size")
        size_nm = int(Decimal(scalar_text(size[1], label="font size")) * 1_000_000)
        if scope == "root":
            box = _text_box(position, text, size_nm)
        else:
            footprint = footprints[scope.removeprefix("footprint:")]
            component = components[footprint.reference]
            placement = placements[component.component_id]
            box = _world_box(
                _text_box(position, text, size_nm),
                placement.position,
                placement.rotation_udeg,
            )
        assert box[0] >= board_bounds[0]
        assert box[1] >= board_bounds[1]
        assert box[2] <= board_bounds[2]
        assert box[3] <= board_bounds[3]
        assert not any(_boxes_intersect(box, item) for item in forbidden)
        assert not any(_boxes_intersect(box, item) for item in graphic_boxes)
        graphic_boxes.append(box)


def test_connector_rail_and_diode_graphic_policy_is_source_pin_driven() -> None:
    graph = reference_graph()
    j2 = graph.components[2]
    diode = graph.components[1]
    rendered = compile_design_graph(
        replace(
            graph,
            components=(
                graph.components[0],
                replace(
                    diode,
                    reference="D1",
                    pins=(
                        PinDefinition("1", "K", "passive", "1"),
                        PinDefinition("2", "A", "passive", "2"),
                    ),
                ),
                replace(
                    j2,
                    reference="J2",
                    pins=(
                        PinDefinition("1", "3V3", "passive", "1"),
                        PinDefinition("2", "GND", "passive", "2"),
                    ),
                ),
            ),
        ),
        "policy_graphics",
    )
    values = {text for _, text, _ in _graphic_texts(rendered)}
    assert {"3V3", "GND", "K", "A"} <= values
    board = import_board(rendered.bundle.board_payload).board
    diode_footprint = next(item for item in board.footprints if item.reference == "D1")
    diode_graphics = tuple(
        item.canonical_sexpr
        for item in board.diagnostics.constructs
        if item.scope == f"footprint:{diode_footprint.footprint_id}"
    )
    assert any(
        text.startswith('(fp_text user "K"')
        and _uuid("review-graphic", diode_footprint.footprint_id, "diode-cathode", "1") in text
        for text in diode_graphics
    )
    assert any(
        text.startswith('(fp_text user "A"')
        and _uuid("review-graphic", diode_footprint.footprint_id, "diode-anode", "2") in text
        for text in diode_graphics
    )


def test_test_point_rails_use_canonical_component_value_not_generic_pin_name() -> None:
    graph = reference_graph()
    values = ("VBUS_RAW", "V5_PROTECTED", "3V3")
    rendered = compile_design_graph(
        replace(
            graph,
            components=tuple(
                replace(component, reference=f"TP{index}", value=value)
                for index, (component, value) in enumerate(
                    zip(graph.components, values, strict=True), start=1
                )
            ),
        ),
        "test-point-rails",
    )
    labels = {text for _, text, _ in _graphic_texts(rendered)}
    assert set(values) <= labels
    assert "TEST" not in labels


def _full_reference_graph() -> DesignGraph:
    circuit = build_circuit()
    placements, pads, holes = build_footprints()
    try:
        tracks, vias, zones = build_layout()
    except ReferenceDesignViolation as exc:
        pytest.skip(f"reference route plan is intentionally fail-closed after input drift: {exc}")
    return DesignGraph(
        1,
        PROJECT_ID,
        ("F.Cu", "B.Cu"),
        _board_outline(),
        reference_components(),
        circuit.nets,
        tuple(replace(item, locked=False) for item in placements),
        tracks,
        _bind_pad_nets(circuit, pads),
        holes,
        vias,
        zones,
        circuit.wires,
        circuit.junctions,
    ).normalized()


@pytest.mark.restricted_evidence
def test_full_reference_emits_exact_r2_profile_artwork_silk_and_model_evidence() -> None:
    graph = _full_reference_graph()
    artifact = compile_design_graph(graph, "full-reference-review")
    project = parse_project_manifest(
        artifact.bundle.project_payload,
        stem=artifact.bundle.stem,
        limits=BundleLimits(),
    )
    schematic = parse_schematic(artifact.bundle.schematic_payload, limits=BundleLimits())
    expected_root_id = _uuid("schematic-root", graph.project_id)
    assert project.top_level_sheets[0].sheet_id == schematic.schematic_id == expected_root_id
    assert artifact.manifest.schema_version == 3
    assert artifact.manifest.compiler_version == "4.0.0"
    evidence = artifact.manifest.compilation_profile_evidence
    assert evidence is not None
    assert evidence.subject_graph_sha256 == graph.graph_hash
    assert (evidence.model_emitted_count, evidence.model_omitted_count) == (16, 7)
    assert len(artifact.bundle.all_files) == 29
    texts = _graphic_texts(artifact)
    labels = {text for _, text, _ in texts}
    references = {component.reference for component in graph.components}
    assert references <= labels
    assert {
        "REFERENCE USB C 3V3",
        "USB 5V IN",
        "VBUS",
        "V5",
        "3V3",
        "GND",
        "+",
        "REV 2",
        "3V3 OUT 100mA MAX",
        "DO NOT APPLY POWER",
    } <= labels
    assert {"K", "A", "REV 1"}.isdisjoint(labels)
    board = import_board(artifact.bundle.board_payload).board
    footprints_by_reference = {item.reference: item for item in board.footprints}
    for reference in references:
        footprint = footprints_by_reference[reference]
        constructs = tuple(
            item
            for item in board.diagnostics.constructs
            if item.scope == f"footprint:{footprint.footprint_id}"
        )
        component = next(item for item in graph.components if item.reference == reference)
        assert any(
            item.canonical_sexpr.startswith(
                f'(property "CanonicalComponentId" "{component.component_id}"'
            )
            for item in constructs
        )
        assert any('(layer "F.Fab")' in item.canonical_sexpr for item in constructs)
        assert any('(layer "F.CrtYd")' in item.canonical_sexpr for item in constructs)
    assert len(
        {
            item.source_id
            for item in artifact.manifest.identity_bindings
            if item.source_kind == "r2-3d-model"
        }
    ) == 16
    assert len(
        {
            item.source_id
            for item in artifact.manifest.identity_bindings
            if item.source_kind == "r2-3d-model-omission"
        }
    ) == 7
    changed = replace(
        graph,
        components=(
            replace(graph.components[0], value="changed review subject"),
            *graph.components[1:],
        ),
    )
    with pytest.raises(CompilationBlockedError) as blocked:
        compile_design_graph(changed, "full-reference-review-changed")
    assert {item.code for item in blocked.value.blockers} == {
        "reference-r2-source-hash-required"
    }


@pytest.mark.restricted_evidence
def test_full_reference_dda_ep_separates_copper_mask_and_paste_apertures() -> None:
    graph = _full_reference_graph()
    artifact = compile_design_graph(graph, "full-reference-apertures")
    project = json.loads(artifact.bundle.project_payload)
    assert project["board"]["design_settings"]["rules"] == {
        "min_clearance": 0.2,
        "min_hole_clearance": 0.15,
    }
    board = import_board(artifact.bundle.board_payload).board
    footprint = next(item for item in board.footprints if item.reference == "U1")
    copper = next(item for item in footprint.pads if item.number == "9")
    assert (copper.size_x_nm, copper.size_y_nm, copper.layers) == (
        2_950_000,
        4_900_000,
        ("F.Cu",),
    )
    apertures = {
        item.layers[0]: item
        for item in footprint.pads
        if item.number == "" and item.layers in {("F.Mask",), ("F.Paste",)}
    }
    assert set(apertures) == {"F.Mask", "F.Paste"}
    assert {
        (item.size_x_nm, item.size_y_nm, item.net_id, item.pin_function)
        for item in apertures.values()
    } == {(2_400_000, 3_100_000, None, None)}
    bindings = {
        (item.source_id, item.target_kind, item.emitted_ids)
        for item in artifact.manifest.identity_bindings
        if item.source_kind == "compiler-aperture"
    }
    assert {item[0] for item in bindings if item[0].startswith("pad:efuse-u1")} == {
        "pad:efuse-u1:9:0:F.Mask",
        "pad:efuse-u1:9:0:F.Paste",
    }

    tvs = next(item for item in board.footprints if item.reference == "D1")
    assert {
        (item.number, item.size_x_nm, item.size_y_nm, item.layers)
        for item in tvs.pads
        if item.number
    } == {
        ("1", 700_000, 1_200_000, ("F.Cu",)),
        ("2", 700_000, 1_200_000, ("F.Cu",)),
    }
    tvs_apertures = [item for item in tvs.pads if not item.number]
    assert Counter(
        (item.size_x_nm, item.size_y_nm, item.layers, item.net_id)
        for item in tvs_apertures
    ) == {
        (600_000, 1_100_000, ("F.Mask",), None): 2,
        (350_000, 1_000_000, ("F.Paste",), None): 2,
    }
    assert {
        item[0] for item in bindings if item[0].startswith("pad:tvs-d1")
    } == {
        "pad:tvs-d1:1:0:F.Mask",
        "pad:tvs-d1:1:0:F.Paste",
        "pad:tvs-d1:2:0:F.Mask",
        "pad:tvs-d1:2:0:F.Paste",
    }
    receipts = {
        item.source_id: item.emitted_ids
        for item in artifact.manifest.identity_bindings
        if item.source_kind == "fabrication-policy"
    }
    assert receipts["tps259620dda-ep-apertures"] == tuple(
        sorted(
            (
                "aperture-mask-2400000x3100000nm",
                "aperture-paste-2400000x3100000nm-stencil-example-127000nm",
                "datasheet-sha256:66f6bae4494f7bfe7dfdc314e508f0291d9ca1e87265cca9b6fdfeaa5cb19fe9",
            )
        )
    )
    assert receipts["ptvs5v5z1upc-terminal-apertures"] == tuple(
        sorted(
            (
                "aperture-mask-600000x1100000nm",
                "aperture-paste-350000x1000000nm-stencil-example-100000nm",
                "datasheet-sha256:dd54840b481bf99b3a1082dd08cd556e695991a1b36799e98eb43b7e890e00c1",
            )
        )
    )
    assert receipts["reference-hole-clearance-layering"] == tuple(
        sorted(
            (
                "canonical-route-to-hole-minimum-200000nm",
                "graph-sha256:4b4e91e04078276aecd6e9d4f084871c49377c59d5c7a53edb714a96c6c228ee",
                "native-project-min-clearance-200000nm",
                "native-project-min-hole-clearance-150000nm",
            )
        )
    )


@pytest.mark.restricted_evidence
def test_r2_permutation_profile_and_module_tampering_fail_closed() -> None:
    graph = _full_reference_graph()
    permuted = replace(
        graph,
        components=tuple(reversed(graph.components)),
        nets=tuple(
            replace(net, members=tuple(reversed(net.members)))
            for net in reversed(graph.nets)
        ),
        placements=tuple(reversed(graph.placements)),
        tracks=tuple(reversed(graph.tracks)),
        pads=tuple(reversed(graph.pads)),
        holes=tuple(reversed(graph.holes)),
        vias=tuple(reversed(graph.vias)),
        zones=tuple(reversed(graph.zones)),
        schematic_wires=tuple(reversed(graph.schematic_wires)),
        schematic_junctions=tuple(reversed(graph.schematic_junctions)),
    )
    artifact = compile_design_graph(graph, "r2-permutation")
    assert artifact == compile_design_graph(permuted, "r2-permutation")

    evidence = artifact.manifest.compilation_profile_evidence
    assert evidence is not None
    mutated_evidence = CompilationProfileEvidence.create(
        profile_id=evidence.profile_id,
        profile_version=evidence.profile_version,
        subject_graph_sha256=evidence.subject_graph_sha256,
        assembly_catalog_sha256=evidence.assembly_catalog_sha256,
        assembly_placement_sha256=evidence.assembly_placement_sha256,
        silkscreen_plan_sha256=evidence.silkscreen_plan_sha256,
        model_catalog_sha256=evidence.model_catalog_sha256,
        model_emitted_manifest_sha256=evidence.model_emitted_manifest_sha256,
        model_omitted_manifest_sha256=evidence.model_omitted_manifest_sha256,
        model_emitted_count=evidence.model_emitted_count,
        model_omitted_count=evidence.model_omitted_count,
        human_plan_sha256=evidence.human_plan_sha256,
        human_symbol_catalog_sha256=evidence.human_symbol_catalog_sha256,
        human_emission_sha256="0" * 64,
        source_receipt_manifest_sha256=evidence.source_receipt_manifest_sha256,
    )
    mutated_manifest = replace(
        artifact.manifest,
        compilation_profile_evidence=mutated_evidence,
    )
    mutated_manifest_payload = _manifest_payload(mutated_manifest)
    with pytest.raises(CompilationParityError, match="profile evidence"):
        verify_compiled_project(
            graph,
            replace(
                artifact,
                manifest=mutated_manifest,
                manifest_payload=mutated_manifest_payload,
                manifest_sha256=_sha256(mutated_manifest_payload),
            ),
        )

    module = next(
        item
        for item in artifact.bundle.auxiliary_files
        if item.relative_name.endswith(".kicad_mod")
        and b'F.CrtYd' in item.payload
    )
    mutated_module = replace(
        module,
        payload=module.payload.replace(b'F.CrtYd', b'F.Fab', 1),
    )
    mutated_auxiliary = tuple(
        mutated_module if item is module else item
        for item in artifact.bundle.auxiliary_files
    )
    with pytest.raises(CompilationParityError, match="compiled file bytes were mutated"):
        verify_compiled_project(
            graph,
            replace(
                artifact,
                bundle=replace(
                    artifact.bundle,
                    auxiliary_files=mutated_auxiliary,
                ),
            ),
        )


@pytest.mark.restricted_evidence
def test_installed_kicad_10_0_6_accepts_final_reference_and_refill(
    tmp_path: Path,
) -> None:
    if _KICAD_10_0_6_CLI is None:
        pytest.skip("KiCad CLI is not configured with EVLEDA_KICAD_CLI or on PATH")
    version = subprocess.run(
        [str(_KICAD_10_0_6_CLI), "version"],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if version.returncode != 0 or version.stdout.strip() != "10.0.6":
        pytest.skip("the installed KiCad CLI is not the reviewed 10.0.6 build")

    artifact = compile_design_graph(_full_reference_graph(), "live_full")
    schematic = tmp_path / artifact.schematic_filename
    board = tmp_path / artifact.board_filename
    _stage_compiled_project(tmp_path, artifact)

    erc_report = tmp_path / "erc.json"
    erc = subprocess.run(
        [
            str(_KICAD_10_0_6_CLI),
            "sch",
            "erc",
            "--format",
            "json",
            "--severity-all",
            "--exit-code-violations",
            "--output",
            str(erc_report),
            str(schematic),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert erc.returncode == 0, erc.stderr or erc.stdout
    erc_payload = json.loads(erc_report.read_text(encoding="utf-8"))
    erc_violations = [
        violation
        for sheet in erc_payload["sheets"]
        for violation in sheet["violations"]
    ]
    assert not erc_violations

    def run_drc(report: Path, *, refill: bool) -> dict[str, object]:
        arguments = [
            str(_KICAD_10_0_6_CLI),
            "pcb",
            "drc",
            "--format",
            "json",
            "--severity-all",
            "--schematic-parity",
        ]
        if refill:
            arguments.append("--refill-zones")
        arguments.extend(
            ("--exit-code-violations", "--output", str(report), str(board))
        )
        result = subprocess.run(
            arguments,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, result.stderr or result.stdout
        payload = json.loads(report.read_text(encoding="utf-8"))
        assert not payload["schematic_parity"]
        assert not payload["unconnected_items"]
        assert not payload["violations"]
        return payload

    source_sha256 = hashlib.sha256(board.read_bytes()).hexdigest()
    run_drc(tmp_path / "drc-unfilled.json", refill=False)
    assert hashlib.sha256(board.read_bytes()).hexdigest() == source_sha256
    run_drc(tmp_path / "drc-refilled.json", refill=True)
    assert hashlib.sha256(board.read_bytes()).hexdigest() == source_sha256


def test_input_order_cannot_change_any_emitted_or_manifest_byte() -> None:
    graph = reference_graph()
    reordered = replace(
        graph,
        components=tuple(reversed(graph.components)),
        nets=tuple(reversed(graph.nets)),
        placements=tuple(reversed(graph.placements)),
        tracks=tuple(reversed(graph.tracks)),
        pads=tuple(reversed(graph.pads)),
        holes=tuple(reversed(graph.holes)),
        schematic_wires=tuple(reversed(graph.schematic_wires)),
    )
    assert compile_design_graph(graph, "ordering") == compile_design_graph(reordered, "ordering")


def test_mutated_file_or_manifest_fails_before_semantic_use() -> None:
    graph = reference_graph()
    artifact = compile_design_graph(graph, "mutation")
    mutated_bundle = replace(
        artifact.bundle,
        board_payload=artifact.bundle.board_payload.replace(b"(version", b"(versioN", 1),
    )
    with pytest.raises(CompilationParityError, match="mutated"):
        verify_compiled_project(graph, replace(artifact, bundle=mutated_bundle))
    mutated_graphic_bundle = replace(
        artifact.bundle,
        board_payload=artifact.bundle.board_payload.replace(b"J1 USB INPUT", b"J1 XXX INPUT", 1),
    )
    with pytest.raises(CompilationParityError, match="mutated"):
        verify_compiled_project(graph, replace(artifact, bundle=mutated_graphic_bundle))
    with pytest.raises(CompilationParityError, match="manifest"):
        verify_compiled_project(
            graph,
            replace(artifact, manifest_payload=artifact.manifest_payload + b" "),
        )
    symbol_file = next(
        item
        for item in artifact.bundle.auxiliary_files
        if item.relative_name == "FluxGenerated.kicad_sym"
    )
    mutated_symbol = replace(symbol_file, payload=symbol_file.payload + b" ")
    mutated_auxiliary = tuple(
        mutated_symbol if item is symbol_file else item
        for item in artifact.bundle.auxiliary_files
    )
    mutated_auxiliary = tuple(
        sorted(
            mutated_auxiliary,
            key=lambda item: (item.relative_name.casefold(), item.relative_name),
        )
    )
    mutated_bundle = replace(artifact.bundle, auxiliary_files=mutated_auxiliary)
    with pytest.raises(CompilationParityError, match="mutated"):
        verify_compiled_project(graph, replace(artifact, bundle=mutated_bundle))


def _stage_compiled_project(root: Path, artifact: CompiledProject) -> None:
    for item in artifact.bundle.all_files:
        destination = root / Path(item.relative_name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(item.payload)


def test_unsupported_constructs_are_entity_addressed_blockers() -> None:
    graph = reference_graph()
    back = replace(
        graph,
        placements=(replace(graph.placements[0], side="back"), *graph.placements[1:]),
    )
    with pytest.raises(CompilationBlockedError) as caught:
        compile_design_graph(back, "blocked_back")
    assert {item.code for item in caught.value.blockers} == {"back-side-transform-unsupported"}

    priority = replace(graph, zones=(replace(graph.zones[0], priority=1),))
    with pytest.raises(CompilationBlockedError) as zone_caught:
        compile_design_graph(priority, "blocked_zone")
    assert {item.code for item in zone_caught.value.blockers} == {"zone-priority-unsupported"}

    crossing = replace(
        graph,
        schematic_wires=(
            *graph.schematic_wires,
            SchematicWire(
                "wire-gnd-crossing",
                "net-gnd",
                (
                    PointNm(20_000_000, 40_000_000),
                    PointNm(20_000_000, 55_000_000),
                ),
            ),
        ),
    )
    with pytest.raises(CompilationBlockedError) as crossing_caught:
        compile_design_graph(crossing, "blocked_crossing")
    assert "schematic-wire-intersection-unsupported" in {
        item.code for item in crossing_caught.value.blockers
    }


@pytest.mark.parametrize("stem", ("../escape", "folder/project", r"folder\project", "."))
def test_public_compiler_never_accepts_a_path_as_project_stem(stem: str) -> None:
    with pytest.raises(ValueError):
        compile_design_graph(reference_graph(), stem)

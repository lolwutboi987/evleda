from __future__ import annotations

import hashlib
import json
import os
import subprocess
import uuid
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from typing import cast

import pytest

from backend.design_kernel import DesignGraph
from backend.design_kernel.model import canonical_json
from backend.kicad_compile.human_schematic import (
    HumanEmissionBinding,
    HumanSchematicEmission,
    HumanSchematicError,
    HumanSchematicPlan,
    SemanticPin,
    SymbolSource,
    emit_human_schematic,
    plan_r2_human_schematic,
    verify_human_schematic_emission,
)
from backend.kicad_io.sexpr import Atom, Quoted, SExpr, atom, head, node, parse, quoted, render
from backend.kicad_project import BundleLimits, parse_schematic
from backend.reference_design.circuit import build_circuit
from backend.reference_design.specification import PROJECT_ID, components
from tests.kicad_cli import discover_kicad_cli

_SOURCE_ROOT = Path(__file__).resolve().parents[3] / "backend" / "kicad_compile" / "human_schematic"
_KICAD_10_0_6_CLI = discover_kicad_cli()
_UUID_NAMESPACE = uuid.UUID("e654b4c4-6a95-5cc0-8dd4-777ddf7efe97")


def _graph() -> DesignGraph:
    return DesignGraph(
        1,
        PROJECT_ID,
        components=components(),
        nets=build_circuit().nets,
    ).normalized()


def _source_payload(source: SymbolSource) -> bytes:
    return (_SOURCE_ROOT / source.path).read_bytes()


def _uuid_factory(domain: str, semantic_id: str) -> str:
    return str(uuid.uuid5(_UUID_NAMESPACE, f"{domain}\x1f{semantic_id}"))


def _footprint_link(component_id: str) -> str:
    digest = uuid.uuid5(_UUID_NAMESPACE, f"footprint\x1f{component_id}").hex
    return f"FluxGenerated:fp_{digest}"


def _plan(graph: DesignGraph | None = None) -> HumanSchematicPlan:
    return plan_r2_human_schematic(
        _graph() if graph is None else graph,
        source_payload_resolver=_source_payload,
    )


def _emission(plan: HumanSchematicPlan | None = None) -> HumanSchematicEmission:
    return emit_human_schematic(
        _plan() if plan is None else plan,
        stem="human_r2",
        uuid_factory=_uuid_factory,
        footprint_link_factory=_footprint_link,
        source_payload_resolver=_source_payload,
    )


def _children(expression: SExpr, wanted: str) -> tuple[tuple[SExpr, ...], ...]:
    if not isinstance(expression, tuple):
        return ()
    return tuple(
        child for child in expression[1:] if isinstance(child, tuple) and head(child) == wanted
    )


def _first(expression: tuple[SExpr, ...], index: int = 1) -> str:
    value = expression[index]
    assert isinstance(value, (Atom, Quoted))
    return value.value


def _child(expression: tuple[SExpr, ...], wanted: str) -> tuple[SExpr, ...]:
    matches = _children(expression, wanted)
    assert len(matches) == 1
    return matches[0]


def _replace_direct_child(
    expression: tuple[SExpr, ...],
    target: tuple[SExpr, ...],
    replacement: tuple[SExpr, ...],
) -> tuple[SExpr, ...]:
    return tuple(replacement if child is target else child for child in expression)


def _reseal(
    source: HumanSchematicEmission,
    *,
    schematic_payload: bytes | None = None,
    symbol_library_payload: bytes | None = None,
    identity_bindings: tuple[HumanEmissionBinding, ...] | None = None,
) -> HumanSchematicEmission:
    schematic = source.schematic_payload if schematic_payload is None else schematic_payload
    library = (
        source.symbol_library_payload if symbol_library_payload is None else symbol_library_payload
    )
    bindings = source.identity_bindings if identity_bindings is None else identity_bindings
    schematic_sha256 = hashlib.sha256(schematic).hexdigest()
    library_sha256 = hashlib.sha256(library).hexdigest()
    identity_payload = (
        canonical_json(
            {
                "schema": "flux-human-schematic-identity-manifest-v1",
                "bindings": [
                    {
                        "source_kind": item.source_kind,
                        "source_id": item.source_id,
                        "target_kind": item.target_kind,
                        "emitted_ids": list(item.emitted_ids),
                    }
                    for item in bindings
                ],
            }
        )
        + "\n"
    ).encode("utf-8")
    identity_sha256 = hashlib.sha256(identity_payload).hexdigest()
    emission_payload = (
        canonical_json(
            {
                "schema": "flux-human-schematic-emission-v1",
                "emitter_id": source.emitter_id,
                "emitter_version": source.emitter_version,
                "subject_graph_sha256": source.subject_graph_sha256,
                "plan_sha256": source.plan_sha256,
                "schematic_sha256": schematic_sha256,
                "symbol_library_sha256": library_sha256,
                "identity_manifest_sha256": identity_sha256,
            }
        )
        + "\n"
    ).encode("utf-8")
    return HumanSchematicEmission(
        source.emitter_id,
        source.emitter_version,
        source.subject_graph_sha256,
        source.plan_sha256,
        schematic,
        library,
        bindings,
        schematic_sha256,
        library_sha256,
        identity_sha256,
        hashlib.sha256(emission_payload).hexdigest(),
    )


def _verify(plan: HumanSchematicPlan, emission: HumanSchematicEmission) -> None:
    verify_human_schematic_emission(
        plan,
        emission,
        stem="human_r2",
        uuid_factory=_uuid_factory,
        footprint_link_factory=_footprint_link,
        source_payload_resolver=_source_payload,
    )


def test_emission_is_twice_and_input_order_deterministic() -> None:
    graph = _graph()
    permuted = replace(
        graph,
        components=tuple(reversed(graph.components)),
        nets=tuple(
            replace(net, members=tuple(reversed(net.members))) for net in reversed(graph.nets)
        ),
    )
    first_plan = _plan(graph)
    second_plan = _plan(permuted)
    first = _emission(first_plan)
    second = _emission(second_plan)

    assert first == _emission(first_plan)
    assert first == second
    _verify(first_plan, first)


def test_exact_ast_counts_properties_bindings_and_payload_digests() -> None:
    plan = _plan()
    emission = _emission(plan)
    root = emission.schematic_expression
    assert isinstance(root, tuple) and head(root) == "kicad_sch"
    embedded = _child(root, "lib_symbols")
    placed = _children(root, "symbol")

    assert len(_children(embedded, "symbol")) == 10
    assert len(placed) == 23
    assert all(len(_children(item, "property")) == 9 for item in placed)
    assert len(_children(root, "wire")) == 39
    assert len(_children(root, "label")) == 29
    assert len(_children(root, "global_label")) == 0
    assert len(_children(root, "junction")) == 1
    assert len(_children(root, "no_connect")) == 8
    assert len(_children(root, "rectangle")) == 4
    assert len(_children(root, "text")) == 4
    assert len(emission.identity_bindings) == 389
    assert emission.emitter_version == "1.0.2"
    title_block = _child(root, "title_block")
    assert _first(_child(title_block, "title")) == (
        "USB-C 5 V sink to 3.3 V reference PCB"
    )
    assert _first(_child(title_block, "rev")) == "REV2"
    comment = _child(title_block, "comment")
    assert (_first(comment), _first(comment, 2)) == (
        "1",
        "3V3 OUT 100mA MAX / DO NOT APPLY POWER",
    )
    assert not _children(title_block, "date")

    for symbol in placed:
        properties = {_first(item): item for item in _children(symbol, "property")}
        for name in ("Reference", "Value"):
            effects = _child(properties[name], "effects")
            assert _first(_child(effects, "justify")) == "left"
    for text_expression in _children(root, "text"):
        effects = _child(text_expression, "effects")
        assert _first(_child(effects, "justify")) == "left"

    label_angles = {"east": "0", "north": "90", "south": "270", "west": "180"}
    for record, expression in zip(
        sorted(plan.local_labels, key=lambda item: item.semantic_id),
        _children(root, "label"),
        strict=True,
    ):
        at = _child(expression, "at")
        assert _first(expression) == record.name
        assert Decimal(_first(at)) == Decimal(record.anchor.x) * Decimal("1.27")
        assert Decimal(_first(at, 2)) == Decimal(record.anchor.y) * Decimal("1.27")
        assert _first(at, 3) == label_angles[record.direction]
        assert _first(_child(_child(expression, "effects"), "justify")) == "left"

    expected_root_id = _uuid_factory("schematic-root", PROJECT_ID)
    assert _first(_child(root, "uuid")) == expected_root_id
    assert next(
        item
        for item in emission.identity_bindings
        if (
            item.source_kind,
            item.source_id,
            item.target_kind,
        )
        == ("project", PROJECT_ID, "schematic-root")
    ).emitted_ids == (expected_root_id,)
    assert emission.plan_sha256 == plan.plan_digest
    assert emission.schematic_sha256 == (
        "d12ed73027efdb09c44941571cba54921a8e63283b4fe366a74dae8581e0bfd6"
    )
    assert emission.symbol_library_sha256 == (
        "24093a514af911a7bec717da6931bd57ce8a6e056c351365ce286b783efe0808"
    )
    assert emission.identity_manifest_sha256 == (
        "1cff946dfac0a0615750a778a8b6e629bf257ddec3d81ab47754a95f594149ae"
    )
    assert emission.emission_sha256 == (
        "c0d1018bf57f81dd8ed28aa391991a6bcbc90e3bef5d0b9f364b986eaa964ba3"
    )


def test_embedded_pin_contract_and_component_unique_footprint_links_are_exact() -> None:
    plan = _plan()
    emission = _emission(plan)
    root = emission.schematic_expression
    assert isinstance(root, tuple)
    library = _child(root, "lib_symbols")
    definitions = {_first(item): item for item in _children(library, "symbol")}
    templates = {item.profile_id: item for item in plan.symbol_templates}
    placements = {item.component_id: item for item in plan.placements}

    for placement in plan.placements:
        template = templates[placement.symbol_profile_id]
        definition = definitions[
            "FluxGenerated:" + template.flattened_library_id.removeprefix("FluxHuman:")
        ]
        pins: list[tuple[SExpr, ...]] = []
        for nested in _children(definition, "symbol"):
            pins.extend(_children(nested, "pin"))
        actual = {
            (
                _first(pin, 1),
                _first(_child(pin, "name")),
                _first(_child(pin, "number")),
            )
            for pin in pins
        }
        assert actual == {
            (port.canonical_electrical_type, port.canonical_name, port.emitted_number)
            for port in template.pin_ports
        }

    footprint_links: dict[str, str] = {}
    for symbol in _children(root, "symbol"):
        properties = {_first(item): _first(item, 2) for item in _children(symbol, "property")}
        reference = properties["Reference"]
        component_id = next(
            item.component_id for item in placements.values() if item.reference == reference
        )
        footprint_links[component_id] = properties["Footprint"]
    assert footprint_links == {
        component_id: _footprint_link(component_id) for component_id in placements
    }
    assert len(set(footprint_links.values())) == 23


def test_strict_project_parser_resolves_the_exact_13_net_memberships() -> None:
    plan = _plan()
    emission = _emission(plan)
    parsed = parse_schematic(emission.schematic_payload, limits=BundleLimits())
    component_ids = {
        item.emitted_ids[0]: item.source_id
        for item in emission.identity_bindings
        if item.source_kind == "component" and item.target_kind == "schematic-symbol"
    }
    logical_by_pad = {
        (placement.component_id, anchor.emitted_number): anchor.pin.pin_number
        for placement in plan.placements
        for anchor in placement.pin_anchors
    }
    actual_by_name = {
        net.name: frozenset(
            SemanticPin(
                component_ids[pin.symbol_id],
                logical_by_pad[(component_ids[pin.symbol_id], pin.pin_number)],
            )
            for pin in net.pin_refs
        )
        for net in parsed.nets
    }
    expected_by_name = {
        net.name: frozenset(
            membership.pin
            for membership in plan.semantic_graph.memberships
            if membership.net_id == net.net_id
        )
        for net in plan.semantic_graph.nets
    }
    assert len(parsed.library_symbols) == 10
    assert len(parsed.symbols) == 23
    assert len(parsed.nets) == 13
    assert actual_by_name == expected_by_name


def test_one_byte_and_source_payload_tampering_fail_closed() -> None:
    plan = _plan()
    emission = _emission(plan)
    mutated = emission.schematic_payload[:-1] + bytes((emission.schematic_payload[-1] ^ 1,))
    with pytest.raises(ValueError, match="digest|payload|S-expression"):
        replace(emission, schematic_payload=mutated)

    def mutated_source(source: SymbolSource) -> bytes:
        payload = _source_payload(source)
        if source.source_id == "kicad-device-c-10.0.6":
            return payload[:-1] + bytes((payload[-1] ^ 1,))
        return payload

    with pytest.raises(HumanSchematicError) as caught:
        emit_human_schematic(
            plan,
            stem="human_r2",
            uuid_factory=_uuid_factory,
            footprint_link_factory=_footprint_link,
            source_payload_resolver=mutated_source,
        )
    assert caught.value.code == "human-symbol-source-digest-mismatch"

    constant_uuid = str(uuid.uuid5(_UUID_NAMESPACE, "constant"))
    with pytest.raises(HumanSchematicError) as uuid_caught:
        emit_human_schematic(
            plan,
            stem="human_r2",
            uuid_factory=lambda domain, semantic_id: constant_uuid,
            footprint_link_factory=_footprint_link,
            source_payload_resolver=_source_payload,
        )
    assert uuid_caught.value.code == "human-emission-uuid-collision"

    with pytest.raises(HumanSchematicError) as footprint_caught:
        emit_human_schematic(
            plan,
            stem="human_r2",
            uuid_factory=_uuid_factory,
            footprint_link_factory=lambda component_id: "FluxGenerated:one-footprint",
            source_payload_resolver=_source_payload,
        )
    assert footprint_caught.value.code == "human-footprint-link-collision"


def _mutated_root_payload(emission: HumanSchematicEmission, kind: str) -> bytes:
    parsed = parse(emission.schematic_payload)
    assert isinstance(parsed, tuple)
    root = parsed
    if kind in {"property", "pin"}:
        symbol = _children(root, "symbol")[0]
        if kind == "property":
            prop = _children(symbol, "property")[0]
            replacement = (prop[0], prop[1], quoted("MUTATED"), *prop[3:])
            mutated_symbol = _replace_direct_child(symbol, prop, replacement)
        else:
            pin = _children(symbol, "pin")[0]
            replacement = (pin[0], quoted("MUTATED"), *pin[2:])
            mutated_symbol = _replace_direct_child(symbol, pin, replacement)
        return render(_replace_direct_child(root, symbol, mutated_symbol))

    target = _children(root, kind)[0]
    if kind in {"wire", "junction", "no_connect"}:
        position = _child(target, "pts") if kind == "wire" else _child(target, "at")
        if kind == "wire":
            point = _children(position, "xy")[0]
            replacement_point = (point[0], atom("1.27"), *point[2:])
            replacement_position = _replace_direct_child(position, point, replacement_point)
        else:
            replacement_position = (position[0], atom("1.27"), *position[2:])
        replacement = _replace_direct_child(target, position, replacement_position)
    elif kind == "label":
        replacement = (target[0], quoted("MUTATED"), *target[2:])
    else:
        raise AssertionError(f"unknown mutation kind {kind}")
    return render(_replace_direct_child(root, target, replacement))


@pytest.mark.parametrize(
    "kind",
    ("property", "pin", "wire", "label", "junction", "no_connect"),
)
def test_resealed_schematic_semantic_mutations_fail_ast_plan_parity(kind: str) -> None:
    plan = _plan()
    emission = _emission(plan)
    mutated = _reseal(emission, schematic_payload=_mutated_root_payload(emission, kind))
    with pytest.raises(HumanSchematicError) as caught:
        _verify(plan, mutated)
    assert caught.value.code == "human-emission-schematic-parity-failed"


def test_resealed_external_library_and_identity_mutations_fail_parity() -> None:
    plan = _plan()
    emission = _emission(plan)
    parsed_library = parse(emission.symbol_library_payload)
    assert isinstance(parsed_library, tuple)
    definition = _children(parsed_library, "symbol")[0]
    mutated_definition = (definition[0], quoted("MUTATED"), *definition[2:])
    mutated_library = render(_replace_direct_child(parsed_library, definition, mutated_definition))
    with pytest.raises(HumanSchematicError) as library_caught:
        _verify(plan, _reseal(emission, symbol_library_payload=mutated_library))
    assert library_caught.value.code == "human-emission-library-parity-failed"

    binding = emission.identity_bindings[0]
    mutated_binding = replace(
        binding,
        emitted_ids=(str(uuid.uuid5(_UUID_NAMESPACE, "mutated-identity")),),
    )
    mutated_bindings = tuple(sorted((mutated_binding, *emission.identity_bindings[1:])))
    with pytest.raises(HumanSchematicError) as identity_caught:
        _verify(plan, _reseal(emission, identity_bindings=mutated_bindings))
    assert identity_caught.value.code == "human-emission-identity-parity-failed"


def test_exact_kicad_10_0_6_reports_erc_zero_without_mutating_source(
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

    emission = _emission()
    schematic = tmp_path / "human_r2.kicad_sch"
    schematic.write_bytes(emission.schematic_payload)
    symbol_library = tmp_path / "FluxGenerated.kicad_sym"
    symbol_library.write_bytes(emission.symbol_library_payload)
    footprint_directory = tmp_path / "FluxGenerated.pretty"
    footprint_directory.mkdir()
    for component in _plan().semantic_graph.components:
        local_id = _footprint_link(component.component_id).removeprefix("FluxGenerated:")
        (footprint_directory / f"{local_id}.kicad_mod").write_bytes(
            render(
                node(
                    "footprint",
                    quoted(local_id),
                    node("version", atom("20240108")),
                    node("generator", quoted("flux_clone")),
                    node("generator_version", quoted("10.0")),
                    node("layer", quoted("F.Cu")),
                    node("attr", atom("smd")),
                )
            )
        )
    config = tmp_path / "config" / "10.0"
    config.mkdir(parents=True)

    def table(*, symbol: bool) -> bytes:
        uri = symbol_library.resolve() if symbol else footprint_directory.resolve()
        return render(
            node(
                "sym_lib_table" if symbol else "fp_lib_table",
                node("version", atom("7")),
                node(
                    "lib",
                    node("name", quoted("FluxGenerated")),
                    node("type", quoted("KiCad")),
                    node("uri", quoted(uri.as_posix())),
                    node("options", quoted("")),
                    node("descr", quoted("")),
                ),
            )
        )

    (config / "sym-lib-table").write_bytes(table(symbol=True))
    (config / "fp-lib-table").write_bytes(table(symbol=False))
    source_paths = tuple(
        path
        for path in tmp_path.rglob("*")
        if path.is_file() and "config/10.0/" not in path.as_posix()
    )
    source_digests = {
        path.relative_to(tmp_path).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source_paths
    }
    report = tmp_path / "erc.json"
    environment = os.environ.copy()
    environment["KICAD_CONFIG_HOME"] = str(tmp_path / "config")
    environment["KICAD_CONFIG_HOME_IS_QA"] = "1"
    result = subprocess.run(
        [
            str(_KICAD_10_0_6_CLI),
            "sch",
            "erc",
            "--format",
            "json",
            "--severity-all",
            "--exit-code-violations",
            "--output",
            str(report),
            str(schematic),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    payload_object: object = json.loads(report.read_text(encoding="utf-8"))
    assert isinstance(payload_object, dict)
    payload = cast(dict[str, object], payload_object)
    sheets_object = payload["sheets"]
    assert isinstance(sheets_object, list)
    sheets = cast(list[object], sheets_object)
    for sheet_object in sheets:
        assert isinstance(sheet_object, dict)
        sheet = cast(dict[str, object], sheet_object)
        violations = sheet["violations"]
        assert isinstance(violations, list)
        assert not violations
    assert not (tmp_path / "human_r2.kicad_prl").exists()
    assert source_digests == {
        path.relative_to(tmp_path).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source_paths
    }

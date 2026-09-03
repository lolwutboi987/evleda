"""Pure orchestration from a canonical R2 graph to a neutral drawing plan."""

from __future__ import annotations

from backend.design_kernel import DesignGraph, PinRef, validate_graph

from .catalog import SourcePayloadProvider, SymbolCatalog, default_symbol_catalog
from .layout import R2_PLANNER_ID, default_sheet, place_r2_components
from .model import (
    HumanSchematicError,
    HumanSchematicPlan,
    NetMembership,
    SemanticComponent,
    SemanticGraph,
    SemanticNet,
    SemanticPin,
    SemanticPinDefinition,
    SheetSpec,
)
from .router import route_semantic_graph

_R2_COMPONENT_COUNT = 23
_R2_NET_COUNT = 13
_R2_LOGICAL_PIN_COUNT = 67
_R2_CONNECTED_PIN_COUNT = 59
_R2_NO_CONNECT_COUNT = 8


def semantic_graph_from_design(graph: DesignGraph) -> SemanticGraph:
    """Project a canonical graph into its normalized component/net bipartite graph."""

    if type(graph) is not DesignGraph:
        raise TypeError("human schematic planning requires an exact DesignGraph")
    normalized = graph.normalized()
    validate_graph(normalized)
    components = tuple(
        SemanticComponent(
            component.component_id,
            component.reference,
            component.value,
            component.manufacturer_part_number,
            component.package,
            component.symbol_id,
            component.footprint_id,
            component.datasheet_sha256,
            component.pin_map_sha256,
            tuple(
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
            ),
        )
        for component in normalized.components
    )
    nets = tuple(SemanticNet(net.net_id, net.name) for net in normalized.nets)
    memberships = tuple(
        sorted(
            (
                NetMembership(
                    f"membership:{net.net_id}:{member.component_id}:{member.pin_number}",
                    net.net_id,
                    SemanticPin(member.component_id, member.pin_number),
                )
                for net in normalized.nets
                for member in net.members
            ),
            key=lambda item: item.semantic_id,
        )
    )
    connected = {PinRef(item.pin.component_id, item.pin.pin_number) for item in memberships}
    no_connects: list[SemanticPin] = []
    for component in normalized.components:
        for pin in component.pins:
            subject = PinRef(component.component_id, pin.number)
            if subject in connected:
                if pin.electrical_type == "no_connect":
                    raise HumanSchematicError(
                        "human-no-connect-pin-is-connected",
                        f"{component.component_id}:{pin.number}",
                        "a graph-declared no-connect pin cannot belong to a schematic net",
                    )
                continue
            if pin.required or pin.electrical_type != "no_connect":
                raise HumanSchematicError(
                    "human-explicit-no-connect-required",
                    f"{component.component_id}:{pin.number}",
                    "every unconnected graph pin must be an intentional non-required no-connect",
                )
            no_connects.append(SemanticPin(component.component_id, pin.number))
    return SemanticGraph(
        normalized.project_id,
        normalized.graph_hash,
        components,
        nets,
        memberships,
        tuple(sorted(no_connects)),
    )


def _require_r2_population(semantic_graph: SemanticGraph) -> None:
    counts = (
        len(semantic_graph.components),
        len(semantic_graph.nets),
        sum(len(item.pin_numbers) for item in semantic_graph.components),
        len(semantic_graph.memberships),
        len(semantic_graph.no_connects),
    )
    expected = (
        _R2_COMPONENT_COUNT,
        _R2_NET_COUNT,
        _R2_LOGICAL_PIN_COUNT,
        _R2_CONNECTED_PIN_COUNT,
        _R2_NO_CONNECT_COUNT,
    )
    if counts != expected:
        raise HumanSchematicError(
            "human-r2-topology-mismatch",
            semantic_graph.project_id,
            f"component/net/pin/connected/NC counts {counts!r} do not equal R2 {expected!r}",
        )
    required_components = {"ldo-u2", "cout-esr-r9", "cout-c3", "dvdt-c4"}
    required_nets = {"net-3v3", "net-cout-damped", "net-dvdt", "net-v5-protected"}
    if not required_components.issubset(
        {item.component_id for item in semantic_graph.components}
    ) or not required_nets.issubset({item.net_id for item in semantic_graph.nets}):
        raise HumanSchematicError(
            "human-r2-topology-mismatch",
            semantic_graph.project_id,
            "LP38692, R9/C3 damping, or C4 dVdt semantic subjects are absent",
        )


def plan_r2_human_schematic(
    graph: DesignGraph,
    *,
    source_payload_resolver: SourcePayloadProvider | None = None,
    catalog: SymbolCatalog | None = None,
    sheet: SheetSpec | None = None,
) -> HumanSchematicPlan:
    """Return the deterministic transport-neutral R2 human-schematic plan."""

    selected_catalog = default_symbol_catalog() if catalog is None else catalog
    selected_sheet = default_sheet() if sheet is None else sheet
    if type(selected_catalog) is not SymbolCatalog:
        raise TypeError("human schematic catalog must be an exact SymbolCatalog")
    if type(selected_sheet) is not SheetSpec:
        raise TypeError("human schematic sheet must be an exact SheetSpec")
    if source_payload_resolver is None:
        raise HumanSchematicError(
            "human-symbol-source-resolver-required",
            "symbol-catalog",
            "planning requires explicit retained source bytes or a payload resolver",
        )
    semantic_graph = semantic_graph_from_design(graph)
    _require_r2_population(semantic_graph)

    resolved_templates = tuple(
        sorted(
            {selected_catalog.resolve(component) for component in semantic_graph.components},
            key=lambda item: item.profile_id,
        )
    )
    source_ids = {source_id for template in resolved_templates for source_id in template.source_ids}
    resolved_sources = tuple(
        item for item in selected_catalog.sources if item.source_id in source_ids
    )
    if {item.source_id for item in resolved_sources} != source_ids:
        raise HumanSchematicError(
            "human-symbol-source-inventory-mismatch",
            semantic_graph.project_id,
            "resolved real-symbol templates do not have complete source receipts",
        )
    source_verifications = selected_catalog.verify_sources(
        source_payload_resolver,
        frozenset(source_ids),
    )
    blocks, placements = place_r2_components(
        semantic_graph,
        selected_catalog,
        selected_sheet,
    )
    wires, local_labels, junctions, no_connects = route_semantic_graph(
        semantic_graph,
        selected_sheet,
        blocks,
        placements,
    )
    return HumanSchematicPlan(
        1,
        R2_PLANNER_ID,
        semantic_graph,
        selected_sheet,
        resolved_sources,
        source_verifications,
        resolved_templates,
        blocks,
        placements,
        wires,
        local_labels,
        junctions,
        no_connects,
    )


__all__ = ("plan_r2_human_schematic", "semantic_graph_from_design")

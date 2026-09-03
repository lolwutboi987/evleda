"""Deterministic orthogonal grid router with a local-label fallback."""

from __future__ import annotations

import heapq
from dataclasses import dataclass

from backend.design_kernel import stable_hash

from .model import (
    ComponentPlacement,
    FunctionalBlock,
    GridEnvelope,
    GridPoint,
    HumanSchematicError,
    Junction,
    LocalLabel,
    NetMembership,
    NoConnect,
    SemanticGraph,
    SemanticNet,
    SemanticPin,
    SheetSpec,
    WireSegment,
    local_label_envelope,
    segment_points,
)

_DIRECTION_ORDER = ("east", "south", "west", "north")
_MAX_WIRED_ISLANDS = 8
_MAX_EXPANSIONS = 100_000
_MAX_ROUTE_STEPS = 260


@dataclass(frozen=True, slots=True)
class _Island:
    island_id: str
    members: tuple[SemanticPin, ...]
    position: GridPoint
    directions: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _RouteResult:
    wires: tuple[WireSegment, ...]
    labels: tuple[LocalLabel, ...]


def _envelope_points(envelope: GridEnvelope) -> set[GridPoint]:
    return {
        GridPoint(x, y)
        for x in range(envelope.minimum.x, envelope.maximum.x + 1)
        for y in range(envelope.minimum.y, envelope.maximum.y + 1)
    }


def _static_obstacles(
    placements: tuple[ComponentPlacement, ...], blocks: tuple[FunctionalBlock, ...]
) -> set[GridPoint]:
    result: set[GridPoint] = set()
    for placement in placements:
        result.update(_envelope_points(placement.body))
        for prop in placement.properties:
            if prop.visible:
                result.update(_envelope_points(prop.envelope))
    for block in blocks:
        result.update(_envelope_points(block.title_envelope))
    return result


def _anchor_index(
    placements: tuple[ComponentPlacement, ...],
) -> dict[SemanticPin, tuple[GridPoint, str]]:
    return {
        anchor.pin: (anchor.position, anchor.direction)
        for placement in placements
        for anchor in placement.pin_anchors
    }


def _island_id(members: tuple[SemanticPin, ...]) -> str:
    subject = stable_hash(
        tuple(item.semantic_id for item in members),
        domain="flux-clone-human-route-island-v1",
    )[:20]
    return f"island-{subject}"


def _islands_for_net(
    net: SemanticNet,
    memberships: tuple[NetMembership, ...],
    anchors: dict[SemanticPin, tuple[GridPoint, str]],
) -> tuple[_Island, ...]:
    grouped: dict[GridPoint, list[SemanticPin]] = {}
    for membership in memberships:
        if membership.net_id == net.net_id:
            grouped.setdefault(anchors[membership.pin][0], []).append(membership.pin)
    result: list[_Island] = []
    for position, members_list in grouped.items():
        members = tuple(sorted(members_list))
        directions = tuple(sorted({anchors[item][1] for item in members}))
        result.append(_Island(_island_id(members), members, position, directions))
    return tuple(
        sorted(result, key=lambda item: (item.position.x, item.position.y, item.island_id))
    )


def _manhattan(first: GridPoint, second: GridPoint) -> int:
    return abs(first.x - second.x) + abs(first.y - second.y)


def _direction_index(start: GridPoint, end: GridPoint) -> int:
    if end.x > start.x:
        return 0
    if end.y > start.y:
        return 1
    if end.x < start.x:
        return 2
    return 3


def _neighbor(point: GridPoint, direction_index: int) -> GridPoint:
    return point.moved(_DIRECTION_ORDER[direction_index])


def _reconstruct(
    state: tuple[GridPoint, int],
    parents: dict[tuple[GridPoint, int], tuple[GridPoint, int] | None],
) -> tuple[GridPoint, ...]:
    points: list[GridPoint] = []
    current: tuple[GridPoint, int] | None = state
    while current is not None:
        points.append(current[0])
        current = parents[current]
    points.reverse()
    compact: list[GridPoint] = []
    for point in points:
        if not compact or compact[-1] != point:
            compact.append(point)
    return tuple(compact)


def _astar(
    start: GridPoint,
    goals: frozenset[GridPoint],
    content: GridEnvelope,
    static: set[GridPoint],
    globally_occupied: set[GridPoint],
    tree_points: set[GridPoint],
    all_pin_positions: set[GridPoint],
) -> tuple[GridPoint, ...] | None:
    if not goals:
        return None
    if start in goals:
        return (start,)
    parents: dict[tuple[GridPoint, int], tuple[GridPoint, int] | None] = {}
    costs: dict[tuple[GridPoint, int], tuple[int, int]] = {}
    queue: list[tuple[int, int, int, int, int, int, GridPoint]] = []
    for direction_index in range(len(_DIRECTION_ORDER)):
        state = (start, direction_index)
        parents[state] = None
        costs[state] = (0, 0)
        heuristic = min(_manhattan(start, goal) for goal in goals)
        heapq.heappush(
            queue,
            (heuristic * 10, 0, 0, start.x, start.y, direction_index, start),
        )
    expansions = 0
    while queue:
        _, bends, steps, _, _, prior_direction, point = heapq.heappop(queue)
        state = (point, prior_direction)
        if costs.get(state) != (bends, steps):
            continue
        if point in goals and point != start:
            return _reconstruct(state, parents)
        expansions += 1
        if expansions > _MAX_EXPANSIONS or steps >= _MAX_ROUTE_STEPS:
            continue
        for direction_index in range(len(_DIRECTION_ORDER)):
            next_point = _neighbor(point, direction_index)
            if not content.contains(next_point) or next_point in static:
                continue
            is_goal = next_point in goals
            if next_point in globally_occupied:
                continue
            if next_point in tree_points and not is_goal:
                continue
            if next_point in all_pin_positions and next_point != start and not is_goal:
                continue
            next_bends = bends + int(direction_index != prior_direction)
            next_steps = steps + 1
            next_state = (next_point, direction_index)
            next_cost = (next_bends, next_steps)
            prior_cost = costs.get(next_state)
            if prior_cost is not None and prior_cost <= next_cost:
                continue
            costs[next_state] = next_cost
            parents[next_state] = state
            heuristic = min(_manhattan(next_point, goal) for goal in goals)
            score = next_steps * 10 + next_bends * 4 + heuristic * 10
            heapq.heappush(
                queue,
                (
                    score,
                    next_bends,
                    next_steps,
                    next_point.x,
                    next_point.y,
                    direction_index,
                    next_point,
                ),
            )
    return None


def _compress_path(
    path: tuple[GridPoint, ...], route_id: str, net_id: str
) -> tuple[WireSegment, ...]:
    if len(path) < 2:
        return ()
    vertices = [path[0]]
    prior_direction = _direction_index(path[0], path[1])
    for index in range(1, len(path) - 1):
        direction = _direction_index(path[index], path[index + 1])
        if direction != prior_direction:
            vertices.append(path[index])
            prior_direction = direction
    vertices.append(path[-1])
    return tuple(
        WireSegment(
            f"wire:{route_id}:{ordinal}",
            route_id,
            net_id,
            ordinal,
            start,
            end,
        )
        for ordinal, (start, end) in enumerate(zip(vertices, vertices[1:], strict=False))
    )


def _route_wired_net(
    net: SemanticNet,
    islands: tuple[_Island, ...],
    content: GridEnvelope,
    static: set[GridPoint],
    globally_occupied: set[GridPoint],
    all_pin_positions: set[GridPoint],
) -> tuple[WireSegment, ...] | None:
    if len(islands) < 2:
        return None
    root = islands[0]
    remaining = list(islands[1:])
    tree_points = {root.position}
    tree_vertices = {root.position}
    degrees: dict[GridPoint, int] = {root.position: 0}
    wires: list[WireSegment] = []
    while remaining:
        island = min(
            remaining,
            key=lambda item: (
                min(_manhattan(item.position, vertex) for vertex in tree_vertices),
                item.position.x,
                item.position.y,
                item.island_id,
            ),
        )
        goals = frozenset(vertex for vertex in tree_vertices if degrees.get(vertex, 0) < 3)
        path = _astar(
            island.position,
            goals,
            content,
            static,
            globally_occupied,
            tree_points,
            all_pin_positions,
        )
        if path is None or len(path) < 2:
            return None
        route_id = f"route:{net.net_id}:{island.island_id}"
        segments = _compress_path(path, route_id, net.net_id)
        if not segments:
            return None
        for segment in segments:
            degrees[segment.start] = degrees.get(segment.start, 0) + 1
            degrees[segment.end] = degrees.get(segment.end, 0) + 1
            if degrees[segment.start] > 3 or degrees[segment.end] > 3:
                return None
            tree_vertices.update((segment.start, segment.end))
            tree_points.update(segment_points(segment))
        wires.extend(segments)
        remaining.remove(island)
    return tuple(wires)


def _stub_points(start: GridPoint, end: GridPoint) -> tuple[GridPoint, ...]:
    if start.x == end.x:
        step = 1 if end.y >= start.y else -1
        return tuple(GridPoint(start.x, y) for y in range(start.y, end.y + step, step))
    if start.y == end.y:
        step = 1 if end.x >= start.x else -1
        return tuple(GridPoint(x, start.y) for x in range(start.x, end.x + step, step))
    raise ValueError("local-label stubs must be orthogonal")


def _direction_candidates(island: _Island) -> tuple[str, ...]:
    ordered = list(island.directions) + list(_DIRECTION_ORDER)
    result: list[str] = []
    for item in ordered:
        if item not in result:
            result.append(item)
    return tuple(result)


def _fallback_labels(
    net: SemanticNet,
    islands: tuple[_Island, ...],
    reason: str,
    content: GridEnvelope,
    static: set[GridPoint],
    globally_occupied: set[GridPoint],
    all_pin_positions: set[GridPoint],
    label_points: set[GridPoint],
) -> _RouteResult:
    wires: list[WireSegment] = []
    labels: list[LocalLabel] = []
    local_occupied: set[GridPoint] = set()
    for island in islands:
        selected: tuple[GridPoint, GridEnvelope, str, tuple[GridPoint, ...]] | None = None
        for direction in _direction_candidates(island):
            for distance in range(0, 13):
                anchor = island.position.moved(direction, distance)
                envelope = local_label_envelope(anchor, net.name, direction)
                stub = _stub_points(island.position, anchor)
                if not content.contains(envelope.minimum) or not content.contains(envelope.maximum):
                    continue
                if any(point in static for point in _envelope_points(envelope)):
                    continue
                if any(
                    point in static
                    or point in globally_occupied
                    or point in local_occupied
                    or point in label_points
                    for point in stub[1:]
                ):
                    continue
                envelope_points = _envelope_points(envelope)
                if envelope_points & (globally_occupied | local_occupied | label_points):
                    continue
                if (envelope_points & set(stub)) - {anchor}:
                    continue
                foreign_pins = all_pin_positions - {island.position}
                if envelope_points & foreign_pins or set(stub[1:]) & foreign_pins:
                    continue
                selected = anchor, envelope, direction, stub
                break
            if selected is not None:
                break
        if selected is None:
            raise HumanSchematicError(
                "human-local-label-placement-failed",
                f"{net.net_id}:{island.island_id}",
                "no collision-free local-label escape exists on the A4 connection grid",
            )
        anchor, envelope, direction, stub = selected
        labels.append(
            LocalLabel(
                f"label:{net.net_id}:{island.island_id}",
                net.net_id,
                net.name,
                island.island_id,
                island.members,
                anchor,
                envelope,
                direction,
                reason,
            )
        )
        envelope_points = _envelope_points(envelope)
        label_points.update(envelope_points)
        local_occupied.update(envelope_points)
        if len(stub) > 1:
            route_id = f"route:{net.net_id}:label-{island.island_id}"
            segment = WireSegment(
                f"wire:{route_id}:0",
                route_id,
                net.net_id,
                0,
                stub[0],
                stub[-1],
            )
            wires.append(segment)
            local_occupied.update(segment_points(segment))
    return _RouteResult(tuple(wires), tuple(labels))


def _net_priority(net_id: str) -> tuple[int, str]:
    priorities = {
        "net-vbus-raw": 0,
        "net-v5-protected": 1,
        "net-3v3": 2,
        "net-cout-damped": 3,
        "net-dvdt": 4,
        "net-ilm": 5,
        "net-led-a": 6,
        "net-en-uvlo": 7,
        "net-ovc-mid": 8,
        "net-ovcsel": 9,
        "net-cc1": 10,
        "net-cc2": 11,
        "net-gnd": 99,
    }
    return priorities.get(net_id, 50), net_id


def _canonical_net_name_labels(
    semantic_graph: SemanticGraph,
    sheet: SheetSpec,
    anchors: dict[SemanticPin, tuple[GridPoint, str]],
    static: set[GridPoint],
    wires: tuple[WireSegment, ...],
    existing_labels: tuple[LocalLabel, ...],
    label_points: set[GridPoint],
) -> tuple[LocalLabel, ...]:
    """Name every wired net once without replacing required fallback labels."""

    named_net_ids = {item.net_id for item in existing_labels}
    endpoints_by_net: dict[str, set[GridPoint]] = {}
    all_wire_points: set[GridPoint] = set()
    for wire in wires:
        all_wire_points.update(segment_points(wire))
        endpoints_by_net.setdefault(wire.net_id, set()).update((wire.start, wire.end))
    all_pin_positions = {position for position, _direction in anchors.values()}
    result: list[LocalLabel] = []
    for net in sorted(semantic_graph.nets, key=lambda item: _net_priority(item.net_id)):
        if net.net_id in named_net_ids:
            continue
        members = tuple(
            sorted(
                membership.pin
                for membership in semantic_graph.memberships
                if membership.net_id == net.net_id
            )
        )
        member_positions = {anchors[member][0] for member in members}
        net_endpoints = endpoints_by_net.get(net.net_id, set())
        selected: tuple[SemanticPin, GridPoint, str, GridEnvelope] | None = None
        for member in members:
            position, preferred_direction = anchors[member]
            if position not in net_endpoints:
                continue
            directions = tuple(dict.fromkeys((preferred_direction, *_DIRECTION_ORDER)))
            for direction in directions:
                envelope = local_label_envelope(position, net.name, direction)
                envelope_points = _envelope_points(envelope)
                if not sheet.content.contains(envelope.minimum) or not sheet.content.contains(
                    envelope.maximum
                ):
                    continue
                if envelope_points & (static | label_points):
                    continue
                if (envelope_points & all_wire_points) - {position}:
                    continue
                if envelope_points & (all_pin_positions - member_positions):
                    continue
                selected = member, position, direction, envelope
                break
            if selected is not None:
                break
        if selected is None:
            raise HumanSchematicError(
                "human-net-name-label-placement-failed",
                net.net_id,
                "no collision-free canonical local label fits an existing wired pin endpoint",
            )
        member, anchor, direction, envelope = selected
        island_id = f"name-{_island_id((member,)).removeprefix('island-')}"
        result.append(
            LocalLabel(
                f"label:{net.net_id}:{island_id}",
                net.net_id,
                net.name,
                island_id,
                (member,),
                anchor,
                envelope,
                direction,
                "canonical-net-name",
            )
        )
        label_points.update(_envelope_points(envelope))
    return tuple(sorted(result, key=lambda item: item.semantic_id))


def _junctions(wires: tuple[WireSegment, ...]) -> tuple[Junction, ...]:
    incident: dict[tuple[str, GridPoint], list[str]] = {}
    for wire in wires:
        incident.setdefault((wire.net_id, wire.start), []).append(wire.semantic_id)
        incident.setdefault((wire.net_id, wire.end), []).append(wire.semantic_id)
    result: list[Junction] = []
    for (net_id, point), wire_ids_list in incident.items():
        if len(wire_ids_list) != 3:
            continue
        wire_ids = tuple(sorted(wire_ids_list))
        subject = stable_hash(
            {"net_id": net_id, "incident_wire_ids": wire_ids},
            domain="flux-clone-human-junction-subject-v1",
        )[:20]
        result.append(
            Junction(
                f"junction:{net_id}:{subject}",
                net_id,
                wire_ids,
                point,
                3,
            )
        )
    return tuple(sorted(result, key=lambda item: item.semantic_id))


def route_semantic_graph(
    semantic_graph: SemanticGraph,
    sheet: SheetSpec,
    blocks: tuple[FunctionalBlock, ...],
    placements: tuple[ComponentPlacement, ...],
) -> tuple[
    tuple[WireSegment, ...],
    tuple[LocalLabel, ...],
    tuple[Junction, ...],
    tuple[NoConnect, ...],
]:
    """Route every semantic net without crossings, or use deterministic local labels."""

    if type(semantic_graph) is not SemanticGraph or type(sheet) is not SheetSpec:
        raise TypeError("routing requires exact semantic graph and sheet records")
    if type(blocks) is not tuple or any(type(item) is not FunctionalBlock for item in blocks):
        raise TypeError("routing functional blocks must be an exact tuple")
    if type(placements) is not tuple or any(
        type(item) is not ComponentPlacement for item in placements
    ):
        raise TypeError("routing placements must be an exact tuple")
    anchors = _anchor_index(placements)
    static = _static_obstacles(placements, blocks)
    all_pin_positions = {item[0] for item in anchors.values()}
    globally_occupied: set[GridPoint] = set()
    label_points: set[GridPoint] = set()
    wires: list[WireSegment] = []
    labels: list[LocalLabel] = []
    for net in sorted(semantic_graph.nets, key=lambda item: _net_priority(item.net_id)):
        islands = _islands_for_net(net, semantic_graph.memberships, anchors)
        if not islands:
            raise HumanSchematicError(
                "human-net-without-pin-island",
                net.net_id,
                "semantic net has no routed pin island",
            )
        fallback_reason: str | None = None
        net_wires: tuple[WireSegment, ...] | None = None
        if len(islands) == 1:
            fallback_reason = "coincident-pin-join"
        elif len(islands) > _MAX_WIRED_ISLANDS:
            fallback_reason = "fanout-limit"
        else:
            net_wires = _route_wired_net(
                net,
                islands,
                sheet.content,
                static | label_points,
                globally_occupied,
                all_pin_positions,
            )
            if net_wires is None:
                fallback_reason = "orthogonal-route-unavailable"
        if fallback_reason is not None:
            fallback = _fallback_labels(
                net,
                islands,
                fallback_reason,
                sheet.content,
                static,
                globally_occupied,
                all_pin_positions,
                label_points,
            )
            net_wires = fallback.wires
            labels.extend(fallback.labels)
        if net_wires is None:
            raise AssertionError("router must produce wires or a fail-closed fallback")
        net_points = {point for wire in net_wires for point in segment_points(wire)}
        if net_points & globally_occupied:
            raise HumanSchematicError(
                "human-cross-net-intersection",
                net.net_id,
                "deterministic router attempted to occupy prior-net geometry",
            )
        globally_occupied.update(net_points)
        wires.extend(net_wires)

    sorted_wires = tuple(sorted(wires, key=lambda item: item.semantic_id))
    labels.extend(
        _canonical_net_name_labels(
            semantic_graph,
            sheet,
            anchors,
            static,
            sorted_wires,
            tuple(labels),
            label_points,
        )
    )
    sorted_labels = tuple(sorted(labels, key=lambda item: item.semantic_id))
    no_connects = tuple(
        sorted(
            (
                NoConnect(
                    f"no-connect:{pin.component_id}:{pin.pin_number}",
                    pin,
                    next(
                        anchor.emitted_number
                        for placement in placements
                        for anchor in placement.pin_anchors
                        if anchor.pin == pin
                    ),
                    anchors[pin][0],
                )
                for pin in semantic_graph.no_connects
            ),
            key=lambda item: item.semantic_id,
        )
    )
    return sorted_wires, sorted_labels, _junctions(sorted_wires), no_connects


__all__ = ("route_semantic_graph",)

"""Deterministic algorithm validators independent of any AI planner."""

# This sibling module intentionally consumes the verification package's exact
# copper primitives; they are internal to the package, not public API.
# pyright: reportPrivateUsage=false

from __future__ import annotations

from typing import Protocol

from .geometric import (
    _copper_primitives,
    _CopperPrimitive,
    _distance_squared,
    _primitive_zone_distance_squared,
    _valid_zones,
)
from .model import (
    BoardGraph,
    EntityRef,
    EvidenceItem,
    PointNm,
    RuleDefinition,
    RuleDomain,
    Severity,
    Track,
)
from .rule import FindingDraft, RuleContext


class AlgorithmValidator(Protocol):
    """Pure validation algorithm contract usable by the verification engine."""

    algorithm_id: str
    version: str

    def validate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]: ...


class _DisjointSet:
    def __init__(self, size: int) -> None:
        self._parent = list(range(size))

    def find(self, item: int) -> int:
        while self._parent[item] != item:
            self._parent[item] = self._parent[self._parent[item]]
            item = self._parent[item]
        return item

    def union(self, first: int, second: int) -> None:
        first_root = self.find(first)
        second_root = self.find(second)
        if first_root != second_root:
            # Stable root choice avoids traversal-dependent group identities.
            low, high = sorted((first_root, second_root))
            self._parent[high] = low


def _touches(first: _CopperPrimitive, second: _CopperPrimitive, context: RuleContext) -> bool:
    if not set(first.layers).intersection(second.layers):
        return False
    distance_squared = _distance_squared(first, second, context)
    combined_width = first.width_nm + second.width_nm
    return 4 * distance_squared <= combined_width * combined_width


class RoutingConnectivityValidator:
    algorithm_id = "routing-copper-connectivity"
    version = "1.0.0"

    def validate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        all_primitives = _copper_primitives(board)
        findings: list[FindingDraft] = []
        for net in board.nets:
            primitives = tuple(item for item in all_primitives if item.net_id == net.net_id)
            if not primitives:
                if net.connections:
                    findings.append(
                        FindingDraft(
                            f"Net {net.name} has no modeled copper",
                            (EntityRef("net", net.net_id),),
                            (EvidenceItem("connection_count", len(net.connections)),),
                        )
                    )
                continue
            dsu = _DisjointSet(len(primitives))
            for first_index, first in enumerate(primitives):
                for second_index in range(first_index + 1, len(primitives)):
                    if _touches(first, primitives[second_index], context):
                        dsu.union(first_index, second_index)

            groups: dict[int, list[str]] = {}
            pad_roots: set[int] = set()
            for index, primitive in enumerate(primitives):
                root = dsu.find(index)
                groups.setdefault(root, []).append(primitive.primitive_id)
                if primitive.primitive_id.startswith("pad:"):
                    pad_roots.add(root)
            normalized_groups = tuple(sorted("|".join(sorted(group)) for group in groups.values()))
            orphan_groups = tuple(
                group
                for root, group in sorted(
                    ((root, "|".join(sorted(values))) for root, values in groups.items()),
                    key=lambda item: item[1],
                )
                if root not in pad_roots
            )
            if len(pad_roots) > 1 or orphan_groups:
                findings.append(
                    FindingDraft(
                        f"Net {net.name} is not one connected copper component",
                        (EntityRef("net", net.net_id),),
                        (
                            EvidenceItem("connected_groups", normalized_groups),
                            EvidenceItem("pad_group_count", len(pad_roots)),
                            EvidenceItem("orphan_groups", orphan_groups),
                        ),
                    )
                )
        return tuple(findings)


class RoutingModelCompletenessRule:
    definition = RuleDefinition(
        rule_id="ALG.ROUTING.MODEL_COMPLETENESS",
        version="1.0.0",
        domain=RuleDomain.ALGORITHM,
        title="Routing model contains pad geometry",
        description="Every connected pin must expose pad center, size, and copper layers.",
        default_severity=Severity.FATAL,
        mandatory=True,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        components = {component.component_id: component for component in board.components}
        findings: list[FindingDraft] = []
        for net in board.nets:
            for connection in net.connections:
                component = components.get(connection.component_id)
                if component is None:
                    continue
                pin = next(
                    (item for item in component.pins if item.number == connection.pin_number), None
                )
                if pin is None:
                    continue
                missing: list[str] = []
                if pin.pad_center is None:
                    missing.append("pad_center")
                if pin.pad_diameter_nm <= 0:
                    missing.append("pad_diameter_nm")
                if not pin.layers:
                    missing.append("layers")
                if missing:
                    pin_id = f"{component.component_id}:{pin.number}"
                    findings.append(
                        FindingDraft(
                            (
                                f"Connected pin {component.reference}.{pin.number} "
                                "lacks routing geometry"
                            ),
                            (EntityRef("net", net.net_id), EntityRef("pin", pin_id)),
                            (EvidenceItem("missing_fields", tuple(missing)),),
                        )
                    )
        return tuple(findings)


class RoutingConnectivityRule:
    definition = RuleDefinition(
        rule_id="ALG.ROUTING.CONNECTIVITY",
        version="1.0.0",
        domain=RuleDomain.ALGORITHM,
        title="Routed copper connectivity",
        description=(
            "Exact copper contact graph must connect all pads and contain no orphan islands."
        ),
        default_severity=Severity.ERROR,
    )

    def __init__(self, validator: AlgorithmValidator | None = None) -> None:
        self._validator = validator or RoutingConnectivityValidator()

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        return self._validator.validate(board, context)


def _cross(first: PointNm, second: PointNm, third: PointNm) -> int:
    """Return the exact signed twice-area of ``first, second, third``."""

    return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)


def _positive_collinear_overlap(first: Track, second: Track) -> tuple[PointNm, PointNm, str] | None:
    """Return a canonical positive-length overlap interval for two tracks.

    Board normalization orders each track's endpoints lexicographically.  For
    collinear points that ordering is also an exact one-dimensional ordering,
    including vertical and negative-slope lines, so overlap boundaries are
    selected from original integer endpoints without division or rounding.
    """

    if first.layer != second.layer or first.net_id != second.net_id:
        return None
    if first.start == first.end or second.start == second.end:
        return None
    if _cross(first.start, first.end, second.start) != 0:
        return None
    if _cross(first.start, first.end, second.end) != 0:
        return None

    overlap_start = max(first.start, second.start)
    overlap_end = min(first.end, second.end)
    # Equality is a permitted endpoint-only junction, not redundant copper.
    if overlap_start >= overlap_end:
        return None

    if first.start == second.start and first.end == second.end:
        overlap_kind = "identical"
    elif (first.start <= second.start and second.end <= first.end) or (
        second.start <= first.start and first.end <= second.end
    ):
        overlap_kind = "contained"
    else:
        overlap_kind = "partial"
    return overlap_start, overlap_end, overlap_kind


class RedundantRouteCopperRule:
    definition = RuleDefinition(
        rule_id="ALG.ROUTING.REDUNDANT_COPPER",
        version="1.0.0",
        domain=RuleDomain.ALGORITHM,
        title="No redundant routed copper",
        description=(
            "Same-net tracks may meet at endpoints but may not share a positive-length "
            "collinear interval, and vias may not duplicate a center and layer span."
        ),
        default_severity=Severity.ERROR,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        findings: list[FindingDraft] = []
        tracks = tuple(sorted(board.tracks, key=lambda item: item.track_id))
        for first_index, first in enumerate(tracks):
            for second in tracks[first_index + 1 :]:
                overlap = _positive_collinear_overlap(first, second)
                if overlap is None:
                    continue
                overlap_start, overlap_end, overlap_kind = overlap
                entity_ids = (first.track_id, second.track_id)
                findings.append(
                    FindingDraft(
                        f"Tracks {first.track_id} and {second.track_id} share routed copper",
                        (
                            EntityRef("track", first.track_id),
                            EntityRef("track", second.track_id),
                            EntityRef("net", first.net_id),
                        ),
                        (
                            EvidenceItem("entity_ids", entity_ids),
                            EvidenceItem("layer", first.layer),
                            EvidenceItem("net_id", first.net_id),
                            EvidenceItem("overlap_end_x_nm", overlap_end.x),
                            EvidenceItem("overlap_end_y_nm", overlap_end.y),
                            EvidenceItem("overlap_kind", overlap_kind),
                            EvidenceItem("overlap_start_x_nm", overlap_start.x),
                            EvidenceItem("overlap_start_y_nm", overlap_start.y),
                        ),
                    )
                )

        vias = tuple(sorted(board.vias, key=lambda item: item.via_id))
        for first_index, first in enumerate(vias):
            for second in vias[first_index + 1 :]:
                if (
                    first.net_id != second.net_id
                    or first.center != second.center
                    or first.layers != second.layers
                ):
                    continue
                entity_ids = (first.via_id, second.via_id)
                findings.append(
                    FindingDraft(
                        f"Vias {first.via_id} and {second.via_id} duplicate routed copper",
                        (
                            EntityRef("via", first.via_id),
                            EntityRef("via", second.via_id),
                            EntityRef("net", first.net_id),
                        ),
                        (
                            EvidenceItem("center_x_nm", first.center.x),
                            EvidenceItem("center_y_nm", first.center.y),
                            EvidenceItem("entity_ids", entity_ids),
                            EvidenceItem("layers", first.layers),
                            EvidenceItem("net_id", first.net_id),
                        ),
                    )
                )
        return tuple(findings)


class ViaNetConnectivityRule:
    definition = RuleDefinition(
        rule_id="ALG.VIA.NET_CONNECTIVITY",
        version="1.0.0",
        domain=RuleDomain.ALGORITHM,
        title="Vias attach to declared-net copper",
        description="Every via must make exact geometric contact with copper on its declared net.",
        default_severity=Severity.ERROR,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        known_nets = {net.net_id for net in board.nets}
        primitives = _copper_primitives(board)
        primitive_by_id = {item.primitive_id: item for item in primitives}
        zones = _valid_zones(board, context)
        findings: list[FindingDraft] = []
        for via in board.vias:
            if via.net_id not in known_nets:
                continue
            via_primitive = primitive_by_id.get(f"via:{via.via_id}")
            if via_primitive is None:
                continue
            attachments: list[str] = []
            touched_layers: set[str] = set()
            for primitive in primitives:
                if primitive is via_primitive or primitive.net_id != via.net_id:
                    continue
                if _touches(via_primitive, primitive, context):
                    attachments.append(primitive.primitive_id)
                    touched_layers.update(set(via.layers).intersection(primitive.layers))
            for zone in zones:
                if zone.net_id != via.net_id or zone.layer not in via.layers:
                    continue
                distance_squared, overlaps = _primitive_zone_distance_squared(
                    via_primitive, zone, context
                )
                if overlaps or 4 * distance_squared <= via.diameter_nm * via.diameter_nm:
                    attachments.append(f"zone:{zone.zone_id}")
                    touched_layers.add(zone.layer)
            if not attachments:
                findings.append(
                    FindingDraft(
                        f"Via {via.via_id} is not attached to copper on net {via.net_id}",
                        (EntityRef("via", via.via_id), EntityRef("net", via.net_id)),
                        (
                            EvidenceItem("declared_layers", via.layers),
                            EvidenceItem("net_id", via.net_id),
                            EvidenceItem("attached_primitives", ()),
                            EvidenceItem("touched_layers", tuple(sorted(touched_layers))),
                        ),
                    )
                )
        return tuple(findings)


def algorithm_rules() -> tuple[object, ...]:
    return (
        RoutingModelCompletenessRule(),
        RoutingConnectivityRule(),
        RedundantRouteCopperRule(),
        ViaNetConnectivityRule(),
    )

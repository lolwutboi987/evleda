"""Bounded deterministic two-layer visibility-grid router for the reference board."""

from __future__ import annotations

import base64
import binascii
import heapq
import json
import zlib
from dataclasses import dataclass
from math import inf
from time import perf_counter_ns

from backend.design_kernel import FootprintHole, FootprintPad, PointNm, Track, Via, stable_hash

from .model import ReferenceDesignViolation
from .specification import BOARD_HEIGHT_NM, BOARD_WIDTH_NM

_LAYERS = ("F.Cu", "B.Cu")
_CLEARANCE_NM = 200_000
_EDGE_NM = 200_000
_GRID_NM = 500_000
_VIA_DIAMETER_NM = 700_000
_VIA_DRILL_NM = 300_000
_VIA_COST_NM = 4_000_000


@dataclass(frozen=True, slots=True)
class RouteSearchBudget:
    """Fail-closed resource limits for an auditable route regeneration."""

    max_visibility_states: int = 250_000
    max_expansions_per_pair: int = 50_000
    max_total_expansions: int = 2_000_000
    max_pair_runtime_ms: int = 30_000
    max_total_runtime_ms: int = 120_000

    def __post_init__(self) -> None:
        for name in (
            "max_visibility_states",
            "max_expansions_per_pair",
            "max_total_expansions",
            "max_pair_runtime_ms",
            "max_total_runtime_ms",
        ):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ReferenceDesignViolation(f"route budget {name} must be a positive integer")


DEFAULT_ROUTE_SEARCH_BUDGET = RouteSearchBudget()


def router_configuration_hash() -> str:
    """Bind the exact live-search geometry and default resource policy."""

    return stable_hash(
        {
            "algorithm": "bounded-two-layer-visibility-a-star-v2",
            "layers": _LAYERS,
            "clearance_nm": _CLEARANCE_NM,
            "edge_nm": _EDGE_NM,
            "grid_nm": _GRID_NM,
            "via_diameter_nm": _VIA_DIAMETER_NM,
            "via_drill_nm": _VIA_DRILL_NM,
            "via_cost_nm": _VIA_COST_NM,
            "default_budget": DEFAULT_ROUTE_SEARCH_BUDGET,
        },
        domain="flux-clone-reference-router-configuration-v1",
    )


@dataclass(frozen=True, slots=True)
class _Obstacle:
    x0: int
    y0: int
    x1: int
    y1: int
    layers: tuple[str, ...]
    net_id: str | None
    visibility_anchor: bool


def _oriented_size(x_nm: int, y_nm: int, rotation_udeg: int) -> tuple[int, int]:
    return (y_nm, x_nm) if rotation_udeg % 180_000_000 else (x_nm, y_nm)


def _pad_obstacle(pad: FootprintPad) -> _Obstacle:
    sx, sy = _oriented_size(pad.size_x_nm, pad.size_y_nm, pad.rotation_udeg)
    return _Obstacle(
        pad.center.x - sx // 2,
        pad.center.y - sy // 2,
        pad.center.x + (sx + 1) // 2,
        pad.center.y + (sy + 1) // 2,
        pad.layers,
        pad.net_id,
        True,
    )


def _hole_obstacle(hole: FootprintHole, net_id: str | None) -> _Obstacle:
    sx, sy = _oriented_size(hole.drill_x_nm, hole.drill_y_nm, hole.drill_rotation_udeg)
    return _Obstacle(
        hole.center.x - sx // 2,
        hole.center.y - sy // 2,
        hole.center.x + (sx + 1) // 2,
        hole.center.y + (sy + 1) // 2,
        _LAYERS,
        net_id,
        True,
    )


def _track_obstacle(track: Track) -> _Obstacle:
    radius = (track.width_nm + 1) // 2
    return _Obstacle(
        min(track.start.x, track.end.x) - radius,
        min(track.start.y, track.end.y) - radius,
        max(track.start.x, track.end.x) + radius,
        max(track.start.y, track.end.y) + radius,
        (track.layer,),
        track.net_id,
        False,
    )


def _via_obstacle(via: Via) -> _Obstacle:
    radius = (via.diameter_nm + 1) // 2
    return _Obstacle(
        via.center.x - radius,
        via.center.y - radius,
        via.center.x + radius,
        via.center.y + radius,
        via.layers,
        via.net_id,
        False,
    )


def _inflated(obstacle: _Obstacle, margin: int) -> tuple[int, int, int, int]:
    return (
        obstacle.x0 - margin,
        obstacle.y0 - margin,
        obstacle.x1 + margin,
        obstacle.y1 + margin,
    )


def _point_blocked(
    point: PointNm,
    layer: str,
    *,
    net_id: str,
    margin: int,
    obstacles: tuple[_Obstacle, ...],
) -> bool:
    if (
        point.x < _EDGE_NM + margin
        or point.x > BOARD_WIDTH_NM - _EDGE_NM - margin
        or point.y < _EDGE_NM + margin
        or point.y > BOARD_HEIGHT_NM - _EDGE_NM - margin
    ):
        return True
    for obstacle in obstacles:
        if layer not in obstacle.layers or obstacle.net_id == net_id:
            continue
        x0, y0, x1, y1 = _inflated(obstacle, margin)
        if x0 < point.x < x1 and y0 < point.y < y1:
            return True
    return False


def _segment_clear(
    start: PointNm,
    end: PointNm,
    layer: str,
    *,
    net_id: str,
    margin: int,
    obstacles: tuple[_Obstacle, ...],
) -> bool:
    if start.x != end.x and start.y != end.y:
        return False
    if _point_blocked(start, layer, net_id=net_id, margin=margin, obstacles=obstacles):
        return False
    if _point_blocked(end, layer, net_id=net_id, margin=margin, obstacles=obstacles):
        return False
    sx0, sx1 = sorted((start.x, end.x))
    sy0, sy1 = sorted((start.y, end.y))
    for obstacle in obstacles:
        if layer not in obstacle.layers or obstacle.net_id == net_id:
            continue
        x0, y0, x1, y1 = _inflated(obstacle, margin)
        if start.y == end.y:
            if y0 < start.y < y1 and max(sx0, x0) < min(sx1, x1):
                return False
        elif x0 < start.x < x1 and max(sy0, y0) < min(sy1, y1):
            return False
    return True


def _via_clear(
    point: PointNm,
    *,
    net_id: str,
    obstacles: tuple[_Obstacle, ...],
) -> bool:
    margin = _CLEARANCE_NM + _VIA_DIAMETER_NM // 2
    return all(
        not _point_blocked(
            point,
            layer,
            net_id=net_id,
            margin=margin,
            obstacles=obstacles,
        )
        for layer in _LAYERS
    )


def _axis_values(
    maximum: int,
    terminals: tuple[PointNm, ...],
    obstacles: tuple[_Obstacle, ...],
    margin: int,
    *,
    x_axis: bool,
) -> tuple[int, ...]:
    values = set(range(_EDGE_NM + margin, maximum - _EDGE_NM - margin + 1, _GRID_NM))
    values.update(point.x if x_axis else point.y for point in terminals)
    for obstacle in obstacles:
        if not obstacle.visibility_anchor:
            continue
        low = obstacle.x0 if x_axis else obstacle.y0
        high = obstacle.x1 if x_axis else obstacle.y1
        values.update((low - margin, low + margin, high - margin, high + margin))
    return tuple(
        sorted(
            value for value in values if _EDGE_NM + margin <= value <= maximum - _EDGE_NM - margin
        )
    )


def _route_pair(
    net_id: str,
    route_index: int,
    start: PointNm,
    goal: PointNm,
    width_nm: int,
    obstacles: tuple[_Obstacle, ...],
    *,
    budget: RouteSearchBudget,
    total_deadline_ns: int,
    remaining_total_expansions: int,
) -> tuple[tuple[Track, ...], tuple[Via, ...], int]:
    margin = _CLEARANCE_NM + (width_nm + 1) // 2
    terminals = (start, goal)
    xs = _axis_values(BOARD_WIDTH_NM, terminals, obstacles, margin, x_axis=True)
    ys = _axis_values(BOARD_HEIGHT_NM, terminals, obstacles, margin, x_axis=False)
    x_index = {value: index for index, value in enumerate(xs)}
    y_index = {value: index for index, value in enumerate(ys)}
    visibility_states = len(_LAYERS) * len(xs) * len(ys)
    if visibility_states > budget.max_visibility_states:
        raise ReferenceDesignViolation(
            "router visibility-state budget exceeded for "
            f"{net_id} route {route_index}: {visibility_states} > "
            f"{budget.max_visibility_states}; start={start!r}; goal={goal!r}"
        )
    if (
        start.x not in x_index
        or goal.x not in x_index
        or start.y not in y_index
        or goal.y not in y_index
    ):
        raise ReferenceDesignViolation(f"router terminal grid is incomplete for {net_id}")

    start_state = (x_index[start.x], y_index[start.y], 0)
    # Every reference footprint pad exposes F.Cu, while most do not expose
    # B.Cu.  Finishing a search on B.Cu at an F.Cu-only pad leaves a geometric
    # open even though the XY coordinates match.  Requiring F.Cu here makes the
    # state path include the terminal via whenever the approach is on B.Cu.
    goal_states = {(x_index[goal.x], y_index[goal.y], 0)}
    frontier: list[tuple[int, int, int, int, int]] = []
    heapq.heappush(frontier, (abs(start.x - goal.x) + abs(start.y - goal.y), 0, *start_state))
    previous: dict[tuple[int, int, int], tuple[int, int, int] | None] = {start_state: None}
    cost: dict[tuple[int, int, int], int] = {start_state: 0}
    found: tuple[int, int, int] | None = None
    expansions = 0
    pair_expansion_limit = min(
        budget.max_expansions_per_pair,
        remaining_total_expansions,
    )
    pair_deadline_ns = min(
        total_deadline_ns,
        perf_counter_ns() + budget.max_pair_runtime_ms * 1_000_000,
    )

    while frontier:
        _, current_cost, ix, iy, layer_index = heapq.heappop(frontier)
        state = (ix, iy, layer_index)
        if current_cost != cost.get(state):
            continue
        expansions += 1
        if expansions > pair_expansion_limit:
            raise ReferenceDesignViolation(
                "router expansion budget exceeded for "
                f"{net_id} route {route_index}: {expansions} > "
                f"{pair_expansion_limit}; start={start!r}; goal={goal!r}"
            )
        if perf_counter_ns() > pair_deadline_ns:
            raise ReferenceDesignViolation(
                "router runtime budget exceeded for "
                f"{net_id} route {route_index}; start={start!r}; goal={goal!r}"
            )
        if state in goal_states:
            found = state
            break
        point = PointNm(xs[ix], ys[iy])
        candidates: list[tuple[tuple[int, int, int], int]] = []
        for nx, ny in ((ix - 1, iy), (ix + 1, iy), (ix, iy - 1), (ix, iy + 1)):
            if not (0 <= nx < len(xs) and 0 <= ny < len(ys)):
                continue
            target = PointNm(xs[nx], ys[ny])
            if _segment_clear(
                point,
                target,
                _LAYERS[layer_index],
                net_id=net_id,
                margin=margin,
                obstacles=obstacles,
            ):
                candidates.append(
                    (
                        (nx, ny, layer_index),
                        abs(point.x - target.x) + abs(point.y - target.y),
                    )
                )
        other_layer = 1 - layer_index
        if _via_clear(point, net_id=net_id, obstacles=obstacles):
            candidates.append(((ix, iy, other_layer), _VIA_COST_NM))
        for next_state, step_cost in candidates:
            next_cost = current_cost + step_cost
            if next_cost >= cost.get(next_state, inf):
                continue
            cost[next_state] = next_cost
            previous[next_state] = state
            nx, ny, nl = next_state
            heuristic = abs(xs[nx] - goal.x) + abs(ys[ny] - goal.y)
            heapq.heappush(frontier, (next_cost + heuristic, next_cost, nx, ny, nl))
    if found is None:
        raise ReferenceDesignViolation(f"deterministic router found no path for {net_id}")

    states: list[tuple[int, int, int]] = []
    cursor: tuple[int, int, int] | None = found
    while cursor is not None:
        states.append(cursor)
        cursor = previous[cursor]
    states.reverse()
    tracks: list[Track] = []
    vias: list[Via] = []
    segment_start = states[0]
    segment_direction: tuple[int, int, int] | None = None
    segment_index = 0
    via_index = 0

    def emit_segment(first: tuple[int, int, int], last: tuple[int, int, int]) -> None:
        nonlocal segment_index
        if first == last:
            return
        tracks.append(
            Track(
                f"route:{net_id}:{route_index}:{segment_index}",
                net_id,
                _LAYERS[first[2]],
                PointNm(xs[first[0]], ys[first[1]]),
                PointNm(xs[last[0]], ys[last[1]]),
                width_nm,
            )
        )
        segment_index += 1

    for left, right in zip(states, states[1:], strict=False):
        if left[2] != right[2]:
            emit_segment(segment_start, left)
            point = PointNm(xs[left[0]], ys[left[1]])
            vias.append(
                Via(
                    f"route-via:{net_id}:{route_index}:{via_index}",
                    net_id,
                    point,
                    _VIA_DIAMETER_NM,
                    _VIA_DRILL_NM,
                    _LAYERS,
                )
            )
            via_index += 1
            segment_start = right
            segment_direction = None
            continue
        direction = (right[0] - left[0], right[1] - left[1], left[2])
        normalized = (
            0 if direction[0] == 0 else (1 if direction[0] > 0 else -1),
            0 if direction[1] == 0 else (1 if direction[1] > 0 else -1),
            direction[2],
        )
        if segment_direction is None:
            segment_direction = normalized
        elif normalized != segment_direction:
            emit_segment(segment_start, left)
            segment_start = left
            segment_direction = normalized
    emit_segment(segment_start, states[-1])
    return tuple(tracks), tuple(vias), expansions


def route_all(
    pad_points_by_net: dict[str, tuple[PointNm, ...]],
    pads: tuple[FootprintPad, ...],
    holes: tuple[FootprintHole, ...],
    widths: dict[str, int],
    order: tuple[str, ...],
    *,
    budget: RouteSearchBudget = DEFAULT_ROUTE_SEARCH_BUDGET,
) -> tuple[tuple[Track, ...], tuple[Via, ...]]:
    """Route all terminals in deterministic net order while preserving prior copper."""

    tracks: list[Track] = []
    vias: list[Via] = []
    if type(budget) is not RouteSearchBudget:
        raise ReferenceDesignViolation("router budget must be exact RouteSearchBudget")
    total_deadline_ns = perf_counter_ns() + budget.max_total_runtime_ms * 1_000_000
    total_expansions = 0
    pad_nets = {pad.pad_id: pad.net_id for pad in pads}
    base = tuple(_pad_obstacle(pad) for pad in pads) + tuple(
        _hole_obstacle(
            hole,
            pad_nets.get(hole.pad_id or "") if hole.plated else None,
        )
        for hole in holes
    )
    for net_id in order:
        points = tuple(sorted(set(pad_points_by_net[net_id])))
        if len(points) < 2:
            continue
        for route_index, (start, goal) in enumerate(zip(points, points[1:], strict=False)):
            obstacles = (
                base
                + tuple(_track_obstacle(track) for track in tracks)
                + tuple(_via_obstacle(via) for via in vias)
            )
            new_tracks, new_vias, expansions = _route_pair(
                net_id,
                route_index,
                start,
                goal,
                widths[net_id],
                obstacles,
                budget=budget,
                total_deadline_ns=total_deadline_ns,
                remaining_total_expansions=budget.max_total_expansions - total_expansions,
            )
            total_expansions += expansions
            tracks.extend(new_tracks)
            vias.extend(new_vias)
    return (
        tuple(sorted(tracks, key=lambda item: item.track_id)),
        tuple(sorted(vias, key=lambda item: item.via_id)),
    )


ROUTE_INPUT_SCHEMA = "reviewed-multi-agent-content-addressed-route-v1"
FROZEN_ROUTE_AUTHORITY = "reviewed-r2-route-a-output-network-v3"
FROZEN_ROUTE_INPUT_HASH = "1a33c590fb5bb85301119f358c73e5074aad577fcb431ca9246251c7f478c911"
FROZEN_ROUTE_PLAN_HASH = "5352788cdbe7ca5cb11e059cefbc4807ebb537fea483d24f0c2776a42117f203"
FROZEN_ROUTE_TRACK_COUNT = 125
FROZEN_ROUTE_VIA_COUNT = 14
FROZEN_ROUTE_TREE_COUNT = 13
FROZEN_ROUTE_MANHATTAN_LENGTH_NM = 381_190_000
FROZEN_ROUTE_TURN_COUNT = 87
FROZEN_ROUTE_ZONE_INTENT = (
    "zone-intent:gnd:bcu-full-board",
    "net-gnd",
    "B.Cu",
    "unfilled-intent",
)
FROZEN_ROUTE_REVIEW_CONTRACT = (
    "canonical-r2-13-net-order-and-default-widths",
    "candidate-native-verifier-zero-findings",
    "production-native-unfilled-zone-warning-only",
    "preview-and-commit-pass",
    "manufacturing-release-requires-trusted-kicad-drc-v1",
    "exact-0.20mm-route-clearance-with-source-bound-usb-pad-npth-local-exceptions",
    "corrected-clearance-pairs-have-positive-margin-over-0.20mm",
    "r9-cout-branch-only",
    "u2-to-j2-and-tp3-excludes-r9",
    "power-trunks-0.8mm-with-enumerated-0.3mm-throats",
    "cout-damped-entirely-0.8mm",
    "no-via-in-smd-copper",
    "u2-external-thermal-stitches",
    "no-redundant-copper",
    "thirteen-connected-route-trees",
    "split-tee-topology-without-same-net-overlap",
    "unfilled-bcu-ground-zone-intent",
    "route-a-ldo-output-network-native-kicad-10.0.6-zero-findings",
    "r9-at-27.25mm-22.25mm-270deg-and-c3-at-29.25mm-26mm",
    "u2-out-to-r9-pad1-2.49mm-zero-via",
    "r9-pad2-to-c3-positive-3.53mm-zero-via",
    "c3-negative-via-outside-pad-at-30.71mm-28mm",
)
FROZEN_ROUTE_REVIEW_HASH = "0f7c189617f4855fdf6343767c07fd9616c9d5811d1b7b5da31223ac83335948"

# Retained only to keep the superseded R1 payload inspectable in source.  The
# decoder below authenticates and returns only the compact R2 payload.
_SUPERSEDED_R1_ROUTE_PLAN_B85 = (
    "c-oblOLH4J4uJoQ&(;>-4;^Q#=1)xJ;D?fU<47)9at>Sj-?!~<fZZerLUW0XDSQo*011NRfA22mho@ifcl&?"
    "-x%+WGU60SZ^WkzmANQA!_r1EizdIf-yC28r>DOQX`uFwj-e&dr-@R5Lef>zW7JU8v?VciPg4hB;;GG&0&4&"
    "2*mIwf?d?j%V(h|s)u#yDhN#^_I<?{4%|8zKB4(I(N(RMR8ZGylLlo+o%t>0q5E5ck8(w9+_ae#~2FXpOF7g"
    "StLaT`jJge>Dy-COzrC~eR5xc@O^*Sd&E6K6n_cJ1ronPggP^xUl`%mkE(nBR$}GfZtg-}K9yquXwvr5XrE+"
    "V)Q-Whck9gCV-={UbG*OhW^MtZ}e}c78Ic=|sm=GeII@lHpYBTsc+s6^==TQn3@6jpc>;cKUNT?;g(&#|dda"
    ">@-XeN7G-$nV^N*fiq#C8t*yi$K&;V|8zPY4^NlVxs2DRe0P5MgB_gHJl*9541eqB=O0$~0X_Nv0y9i8k}q7"
    "|^uCMMdLd|V*&@jkUII6LI4}W)5{#KNf<N3sADKRN^{?mCpW~OuoUWI*>xFWf<QJfgc6OQsLx2*FJoH7o3|s"
    "4+JuGxc+Z%sxdjos6NML9O@Q?Q{9G7<V5|lVQ=;|-{wQsnyWu@~A65>D7hF{Lt<FC;e)+1KdKaiv@_I&tpeS"
    "P?hN=2|u)?baDES<aI-l8vpM8ejT-3_Tod}kJ%+0$IQe}8*99(J#X?-xm?3IbvopuxW%UXBbHIb33~CV%+-)"
    "nFHY_}$z2beU$u!zvN-b$^spj_>Oku5W~US!aJa^=EhNyUPL*G?37sWCZWe+YPEnAZkW%Glm1I4aowZ7Wd2H"
    "asRb(!rpj#(%8$<dWgh1Bv*oUuQxDFz=G?;W<d`|nU?gdoYVX-{H@g@=)zd1)j8I48cK3AUshx-BLl~nv@BL"
    "bvSDMP;h<#t;T21^A~JGtMH-VGOKvzt(k^-xIq|bEF42$+pri-P<eHDEM2<HCHRG`8pvee5Rx6=-*;JCAdF1"
    "j{)IH?eVxW-$1EhN>=>Y=;Y}JdTN$x6O<bj|boDl*^Cv4S=WYmY52ZDN3Q3f=W6PlhAPPr%Rgobp&))<tGV#"
    "H_`i0VlibjAob1Y)2g%Tb+F3<a)-3j{9A8|9*n0&SCLagoD;_O#}B87>jHM!N`-;v1V;+@g&czzAnKUk2CBW"
    "gpD@vh{><sBO)*D4=1c?HU(29M029OL>v3+Uh>AsoGY+!~+*~t_-{dI$}7Q-d_nKI~-2&Rq7={m_nqIbj>4+"
    "RE_#dl6m)Yh6m<4ksksFh52Sgg5!P0ITi@&rSdWaQZdr17fEshpJAf}v~S>1Q4*KJAZlkZE)8(=gjMsqICB1"
    "j>5js&{^Bv<OiK&PUMxc0Bn&oZUa`iRYH}VLr%4=ie1kK5Y<MHX!EVa%BjGK#PJ*@^=Onlyu!FwyT#f<SavT"
    "+8?X;w=UR-4~Q3cBJYCl^E_?bSC)1HU9#6mibk{A>_8iAblob{>$1W6a@d7#RWJ650Q0s{?HUEm_=0;3cNk`"
    "Q=c;(?3$st*Ui$oov(PRt{piHh|ZtomV%xIGlEfb<a-mdBx(A_p2FFhk;&c%O-6n1FhQMP1HwB3@edL)j17O"
    "U6j8t@GS*V;mVFs0|xJF)qq*3H)%-cVu*cc7jArjLQ<7ac(Q<;lQ|;*WW~;(MDI5Fr5wTmN$_%FluX1kOx^%"
    "(i{%7jf2C{5zdgfO1lUKo{}t!^KcL%42wjT3u<i?XgkP*5}6v9RH@5>S>!B6mE$+ZI!jJugX`-rr7|1%WW#W"
    "W1}26%6>_pe1FToATf1u8TxFKG)+o!~c)^mSg%f_u`-@SI1cJI*g6#&NmjNBrWeq>O7)8y@D|I-kmjj~=7+o"
    "dl0x1`4)mIXi_&&@$5Y%U{5dgK+4PlTCTX!~^nxP4EP=Z&+dO&K9CT^U`fkp;INzT02Xe#ntfF472Inc>~p+"
    "1`G0zG@n4AsRzLwgPSh`P~htc<7eJjAf)GguiveLTG%Ufb0qV_p=ieMyh#g~Vx6TC#`0R`0ReUIB|fEXYz|E"
    "Wq9Gm-UidFY&heM2`rQ*WtLke!QND&6iiY+Rgc3Su1moS@yy$bCGnIRPlW>L(%Ip2s-PsRYL<^Znp0O19gw7"
    "q4Lo(LDFNIAyYx()qJJLv~s3{B}eh6RMvH!2uh&gR-_jrF}vks2Tw>EVx1m~iBU`pvS`FZlGnrY?qQXk#1yv"
    "~o_AG3)^qht6H(v98;OpKL^x(?LbC@`Qu6|yZ$#caO%ogaA{jN<42U==SYR3vZSOiG7O1Bk)wW`70_!<=_A*"
    "8$1%2z;1shLa8e}2Brd)~)VkF*L20;%Qd&us^YRBJn@}z^qsd4S#gM&qHy5r*0_7*mC@q3H3W90Ivrujw>Ir"
    "g3w=~##Ke(aEoOD9+k2R`om-h%{iNGURpya&C7yR*Du2Ht<v;y;x`b^Hel<L%Aoatj1Q1#<w+wmRe+ptv&zN"
    "e3FKX1ji~+3OKe^)GzqDua+)sBeHqVWJYd0gi|i;*Ct(Hx%v_*Gv%fkWP*SLDsyL-3Zrq=}sVskwK0`flZvR"
    "$Jj?Mdru&Uk?95`2pr$=enjF%4sYSfkco*$xUk&BXD1w!y1_hIs*9E7(G}?VZZ2^tx(5!oflDC_Bt39sFB2o"
    "im&%9`oNff;U2D&mNK%$v*@njoVsIAtR((0X<62qWXk+ulqGzM<?FIo3><&5`Avn}8PDWt<9(;pYNw$0bZ})"
    "c}FAu$E=+pmNR|=cg-OZ~h>fQ00(7r7mAYQ+kh5GH2-GTn)ZBsmLpVAKWuX_6yzkPi=25c(U?Nigv)3d4Xmx"
    "r5eF48{A8A9Oo=kDjrkDm>&dFLtTy`KKGxN1K&qEXKc+joXT3h}P6eH%5R5Dy63M@g|WpL|j_XFSby>#gRu|"
    "NS5Fj;x~"
)

# Kept solely as an inspectable rejected candidate: it passed the verifier's
# 0.15 mm default but failed the production 0.20 mm route policy.  The decoder
# never reads this payload.
_SUPERSEDED_150UM_R2_ROUTE_PLAN_B64 = (
    "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"
)


_SUPERSEDED_COMPACT_R2_ROUTE_PLAN_B64 = (
    "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"
    "//sfu3fapA=="
)

# Route A keeps the load trunk direct on 3V3 while moving only the local
# R9/C3 damping branch and its dedicated ground return.  The payload was
# independently checked by KiCad 10.0.6 both before and after zone refill.
_FROZEN_ROUTE_PLAN_B64 = (
    "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"
)


def route_input_hash(
    pad_points_by_net: dict[str, tuple[PointNm, ...]],
    pads: tuple[FootprintPad, ...],
    holes: tuple[FootprintHole, ...],
    widths: dict[str, int],
    order: tuple[str, ...],
) -> str:
    """Hash every authoritative input that makes a frozen route applicable."""

    return stable_hash(
        {
            # The resealed R2 plan was generated against this exact existing
            # input schema value.  Review authority is versioned separately so
            # promotion cannot relabel or silently invalidate the input hash.
            "schema": ROUTE_INPUT_SCHEMA,
            "board_width_nm": BOARD_WIDTH_NM,
            "board_height_nm": BOARD_HEIGHT_NM,
            "pads": pads,
            "holes": holes,
            "points_by_net": tuple(
                (net_id, tuple(sorted(pad_points_by_net[net_id]))) for net_id in order
            ),
            "widths": tuple((net_id, widths[net_id]) for net_id in order),
            "order": order,
        },
        domain="flux-clone-reference-route-input-v1",
    )


def frozen_route_plan(input_hash: str) -> tuple[tuple[Track, ...], tuple[Via, ...]]:
    """Decode and authenticate the reviewed route without rerunning maze search."""

    if input_hash != FROZEN_ROUTE_INPUT_HASH:
        raise ReferenceDesignViolation(
            "reviewed route input drifted; author, diff, and reapprove a bounded candidate"
        )
    review_hash = stable_hash(
        {
            "authority": FROZEN_ROUTE_AUTHORITY,
            "input_schema": ROUTE_INPUT_SCHEMA,
            "input_hash": FROZEN_ROUTE_INPUT_HASH,
            "plan_hash": FROZEN_ROUTE_PLAN_HASH,
            "track_count": FROZEN_ROUTE_TRACK_COUNT,
            "via_count": FROZEN_ROUTE_VIA_COUNT,
            "route_tree_count": FROZEN_ROUTE_TREE_COUNT,
            "manhattan_length_nm": FROZEN_ROUTE_MANHATTAN_LENGTH_NM,
            "turn_count": FROZEN_ROUTE_TURN_COUNT,
            "zone_intent": FROZEN_ROUTE_ZONE_INTENT,
            "review_contract": FROZEN_ROUTE_REVIEW_CONTRACT,
        },
        domain="flux-clone-reference-reviewed-route-evidence-v2",
    )
    if review_hash != FROZEN_ROUTE_REVIEW_HASH:
        raise ReferenceDesignViolation("reviewed route evidence hash is inconsistent")
    try:
        payload = json.loads(
            zlib.decompress(base64.b64decode(_FROZEN_ROUTE_PLAN_B64, validate=True)).decode("utf-8")
        )
        if payload["schema"] != "r2-compact-route-plan-v3":
            raise ValueError("unexpected compact route payload schema")
        tracks = tuple(
            Track(
                row[0],
                row[1],
                row[2],
                PointNm(row[3], row[4]),
                PointNm(row[5], row[6]),
                row[7],
            ).normalized()
            for row in payload["tracks"]
        )
        vias = tuple(
            Via(
                row[0],
                row[1],
                PointNm(row[2], row[3]),
                row[4],
                row[5],
                _LAYERS,
            ).normalized()
            for row in payload["vias"]
        )
    except (binascii.Error, KeyError, TypeError, ValueError, UnicodeError, zlib.error) as exc:
        raise ReferenceDesignViolation("frozen route payload is malformed") from exc
    tracks = tuple(sorted(tracks, key=lambda item: item.track_id))
    vias = tuple(sorted(vias, key=lambda item: item.via_id))
    if len(tracks) != FROZEN_ROUTE_TRACK_COUNT or len(vias) != FROZEN_ROUTE_VIA_COUNT:
        raise ReferenceDesignViolation("frozen route population is inconsistent")
    if len({track.track_id for track in tracks}) != len(tracks):
        raise ReferenceDesignViolation("frozen route contains duplicate track IDs")
    if len({via.via_id for via in vias}) != len(vias):
        raise ReferenceDesignViolation("frozen route contains duplicate via IDs")
    if len({item.net_id for item in (*tracks, *vias)}) != FROZEN_ROUTE_TREE_COUNT:
        raise ReferenceDesignViolation("frozen route net-tree population is inconsistent")
    length_nm = sum(
        abs(track.end.x - track.start.x) + abs(track.end.y - track.start.y) for track in tracks
    )
    if length_nm != FROZEN_ROUTE_MANHATTAN_LENGTH_NM:
        raise ReferenceDesignViolation("frozen route Manhattan length is inconsistent")
    if _route_turn_count(tracks) != FROZEN_ROUTE_TURN_COUNT:
        raise ReferenceDesignViolation("frozen route turn population is inconsistent")
    actual_hash = stable_hash(
        {"tracks": tracks, "vias": vias},
        domain="flux-clone-reference-route-plan-v1",
    )
    if actual_hash != FROZEN_ROUTE_PLAN_HASH:
        raise ReferenceDesignViolation("frozen route payload hash is inconsistent")
    return tracks, vias


def _route_turn_count(tracks: tuple[Track, ...]) -> int:
    """Count unique orthogonal turn/tee points using the candidate metric."""

    if any(track.start.x != track.end.x and track.start.y != track.end.y for track in tracks):
        raise ReferenceDesignViolation("frozen route contains a diagonal track")
    count = 0
    for net_id, layer in sorted({(track.net_id, track.layer) for track in tracks}):
        layer_tracks = tuple(
            track for track in tracks if track.net_id == net_id and track.layer == layer
        )
        points = {point for track in layer_tracks for point in (track.start, track.end)}
        for point in points:
            orientations = {
                "vertical" if track.start.x == track.end.x else "horizontal"
                for track in layer_tracks
                if (
                    track.start.x == track.end.x == point.x
                    and min(track.start.y, track.end.y)
                    <= point.y
                    <= max(track.start.y, track.end.y)
                )
                or (
                    track.start.y == track.end.y == point.y
                    and min(track.start.x, track.end.x)
                    <= point.x
                    <= max(track.start.x, track.end.x)
                )
            }
            count += orientations == {"horizontal", "vertical"}
    return count


__all__ = (
    "DEFAULT_ROUTE_SEARCH_BUDGET",
    "FROZEN_ROUTE_AUTHORITY",
    "FROZEN_ROUTE_INPUT_HASH",
    "FROZEN_ROUTE_MANHATTAN_LENGTH_NM",
    "FROZEN_ROUTE_PLAN_HASH",
    "FROZEN_ROUTE_REVIEW_CONTRACT",
    "FROZEN_ROUTE_REVIEW_HASH",
    "FROZEN_ROUTE_TRACK_COUNT",
    "FROZEN_ROUTE_TREE_COUNT",
    "FROZEN_ROUTE_TURN_COUNT",
    "FROZEN_ROUTE_VIA_COUNT",
    "FROZEN_ROUTE_ZONE_INTENT",
    "ROUTE_INPUT_SCHEMA",
    "RouteSearchBudget",
    "frozen_route_plan",
    "route_all",
    "route_input_hash",
    "router_configuration_hash",
)

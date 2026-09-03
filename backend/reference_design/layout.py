"""Reviewed content-addressed copper and bounded candidate search."""

from __future__ import annotations

from dataclasses import replace

from backend.design_kernel import (
    CopperZone,
    FootprintHole,
    FootprintPad,
    PinRef,
    PointNm,
    Track,
    Via,
)

from .circuit import (
    NET_3V3,
    NET_CC1,
    NET_CC2,
    NET_COUT_DAMPED,
    NET_DVDT,
    NET_EN_UVLO,
    NET_GND,
    NET_ILM,
    NET_LED_A,
    NET_OVC_MID,
    NET_OVCSEL,
    NET_V5_PROTECTED,
    NET_VBUS_RAW,
    build_circuit,
)
from .footprints import build_footprints
from .model import ReferenceDesignViolation
from .router import (
    DEFAULT_ROUTE_SEARCH_BUDGET,
    RouteSearchBudget,
    frozen_route_plan,
    route_all,
    route_input_hash,
)
from .specification import BOARD_HEIGHT_NM, BOARD_WIDTH_NM, components

POWER_WIDTH_NM = 800_000
POWER_ESCAPE_WIDTH_NM = 300_000
SIGNAL_WIDTH_NM = 250_000
CONTROL_WIDTH_NM = 300_000
GROUND_BREAKOUT_WIDTH_NM = 400_000
VIA_DIAMETER_NM = 700_000
VIA_DRILL_NM = 300_000
ZONE_CLEARANCE_NM = 200_000

# The route-input order is part of the content-addressed R2 authority.  Keep
# the widths as an immutable ordered tuple so adding a circuit net or changing
# a default cannot silently retain the reviewed input hash.
ROUTE_NET_ORDER = (
    NET_CC1,
    NET_CC2,
    NET_DVDT,
    NET_ILM,
    NET_OVCSEL,
    NET_OVC_MID,
    NET_EN_UVLO,
    NET_LED_A,
    NET_COUT_DAMPED,
    NET_VBUS_RAW,
    NET_V5_PROTECTED,
    NET_3V3,
    NET_GND,
)
ROUTE_DEFAULT_WIDTHS_NM = (
    (NET_CC1, SIGNAL_WIDTH_NM),
    (NET_CC2, SIGNAL_WIDTH_NM),
    (NET_DVDT, CONTROL_WIDTH_NM),
    (NET_ILM, CONTROL_WIDTH_NM),
    (NET_OVCSEL, CONTROL_WIDTH_NM),
    (NET_OVC_MID, CONTROL_WIDTH_NM),
    (NET_EN_UVLO, CONTROL_WIDTH_NM),
    (NET_LED_A, SIGNAL_WIDTH_NM),
    (NET_COUT_DAMPED, POWER_WIDTH_NM),
    (NET_VBUS_RAW, POWER_WIDTH_NM),
    (NET_V5_PROTECTED, POWER_WIDTH_NM),
    (NET_3V3, POWER_WIDTH_NM),
    (NET_GND, GROUND_BREAKOUT_WIDTH_NM),
)


def _ground_plane_intent() -> CopperZone:
    """Declare the desired B.Cu ground pour without asserting filled copper."""

    inset_nm = 500_000
    return CopperZone(
        "zone-intent:gnd:bcu-full-board",
        NET_GND,
        "B.Cu",
        (
            PointNm(inset_nm, inset_nm),
            PointNm(BOARD_WIDTH_NM - inset_nm, inset_nm),
            PointNm(BOARD_WIDTH_NM - inset_nm, BOARD_HEIGHT_NM - inset_nm),
            PointNm(inset_nm, BOARD_HEIGHT_NM - inset_nm),
        ),
        ZONE_CLEARANCE_NM,
    )


def _physical_net_map() -> dict[tuple[str, str], str | None]:
    circuit = build_circuit()
    logical_nets = {member: net.net_id for net in circuit.nets for member in net.members}
    no_connects = set(circuit.no_connects)
    result: dict[tuple[str, str], str | None] = {}
    for component in components():
        for pin in component.pins:
            logical = PinRef(component.component_id, pin.number)
            net_id = None if logical in no_connects else logical_nets.get(logical)
            if logical not in no_connects and net_id is None:
                raise ReferenceDesignViolation(
                    f"layout pin has no circuit subject: {component.component_id}:{pin.number}"
                )
            key = (component.component_id, pin.pad_number)
            previous = result.get(key, net_id)
            if key in result and previous != net_id:
                raise ReferenceDesignViolation("one physical pad number maps to mixed nets")
            result[key] = net_id
    return result


def _route_inputs() -> tuple[
    dict[str, tuple[PointNm, ...]],
    tuple[FootprintPad, ...],
    tuple[FootprintHole, ...],
    dict[str, int],
    tuple[str, ...],
]:
    """Return the exact frozen-plan subject in deterministic routing order."""

    _, pads, holes = build_footprints()
    physical_nets = _physical_net_map()
    pads = tuple(
        replace(pad, net_id=physical_nets[(pad.component_id, pad.pad_number)]) for pad in pads
    )
    points_by_net: dict[str, set[PointNm]] = {}
    for pad in pads:
        net_id = physical_nets[(pad.component_id, pad.pad_number)]
        if net_id is not None:
            points_by_net.setdefault(net_id, set()).add(pad.center)
    order = ROUTE_NET_ORDER
    widths = dict(ROUTE_DEFAULT_WIDTHS_NM)
    points = {net_id: tuple(sorted(points_by_net[net_id])) for net_id in order}
    return points, pads, holes, widths, order


def build_layout() -> tuple[tuple[Track, ...], tuple[Via, ...], tuple[CopperZone, ...]]:
    """Replay the reviewed hash-bound route plan in milliseconds."""

    points, pads, holes, widths, order = _route_inputs()
    input_hash = route_input_hash(points, pads, holes, widths, order)
    tracks, vias = frozen_route_plan(input_hash)
    return tracks, vias, (_ground_plane_intent(),)


def search_candidate_layout(
    *,
    budget: RouteSearchBudget = DEFAULT_ROUTE_SEARCH_BUDGET,
) -> tuple[tuple[Track, ...], tuple[Via, ...], tuple[CopperZone, ...]]:
    """Search a new bounded candidate; it does not reproduce the authored plan."""

    points, pads, holes, widths, order = _route_inputs()
    tracks, vias = route_all(points, pads, holes, widths, order, budget=budget)
    return tracks, vias, (_ground_plane_intent(),)


__all__ = (
    "GROUND_BREAKOUT_WIDTH_NM",
    "CONTROL_WIDTH_NM",
    "POWER_ESCAPE_WIDTH_NM",
    "POWER_WIDTH_NM",
    "ROUTE_DEFAULT_WIDTHS_NM",
    "ROUTE_NET_ORDER",
    "SIGNAL_WIDTH_NM",
    "VIA_DIAMETER_NM",
    "VIA_DRILL_NM",
    "ZONE_CLEARANCE_NM",
    "build_layout",
    "search_candidate_layout",
)

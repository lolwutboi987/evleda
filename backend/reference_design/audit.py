"""Fail-closed, reference-specific audit for the USB-C 5 V sink board.

This is deliberately a package audit, not a claim that a local KiCad process
ran.  It proves the canonical subject and the compiler reparse; genuine ERC,
DRC and manufacturing release remain external evidence requirements.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable
from fractions import Fraction
from math import isqrt
from pathlib import Path
from typing import TypedDict, cast

from backend.design_kernel import DesignGraph, PinRef, PointNm, Track, Via, stable_hash
from backend.verification import (
    BoardGraph,
    ParameterValue,
    RuleOverride,
    VerificationEngine,
    VerificationPolicy,
    VerificationReport,
    strict_policy,
)

from . import builder
from .builder import ReferenceBoardBuild
from .circuit import (
    NET_3V3,
    NET_CC1,
    NET_CC2,
    NET_COUT_DAMPED,
    NET_DVDT,
    NET_GND,
    NET_V5_PROTECTED,
    NET_VBUS_RAW,
    build_circuit,
)
from .footprints import (
    KICAD_FOOTPRINT_COMMIT,
    KICAD_LIBRARY_PROVENANCE,
    MANUFACTURER_LAND_PROVENANCE,
    USB_LOCATING_HOLE_IDS,
)
from .layout import ROUTE_DEFAULT_WIDTHS_NM, ROUTE_NET_ORDER
from .model import (
    BoardAudit,
    CalculationQuantity,
    ElectricalCalculations,
    ElectricalCalculationSection,
    ExactRational,
    ReferenceDesignViolation,
)
from .router import (
    FROZEN_ROUTE_AUTHORITY,
    FROZEN_ROUTE_INPUT_HASH,
    FROZEN_ROUTE_MANHATTAN_LENGTH_NM,
    FROZEN_ROUTE_PLAN_HASH,
    FROZEN_ROUTE_REVIEW_CONTRACT,
    FROZEN_ROUTE_REVIEW_HASH,
    FROZEN_ROUTE_TRACK_COUNT,
    FROZEN_ROUTE_TREE_COUNT,
    FROZEN_ROUTE_TURN_COUNT,
    FROZEN_ROUTE_VIA_COUNT,
    FROZEN_ROUTE_ZONE_INTENT,
    ROUTE_INPUT_SCHEMA,
    frozen_route_plan,
)
from .specification import OUTPUT_MARKING, bom, components, constraints, sources

_POWER_NET_NAMES = frozenset({"GND", "VBUS_RAW", "V5_PROTECTED", "3V3", "COUT_DAMPED"})
_ELECTRICAL_FITTED_SUBJECT = (
    ("cc-r1", "5.1k 1%", "CRCW06035K10FKEA"),
    ("cc-r2", "5.1k 1%", "CRCW06035K10FKEA"),
    ("cin-c1", "1uF 16V X7R", "885012207051"),
    ("cldo-c2", "4.7uF 25V X7R", "C0805C475K3RACTU"),
    ("cout-c3", "22uF 10V polymer +/-20%", "T598B226M010ATE070"),
    ("cout-esr-r9", "10mOhm 1%", "WSLP0603R0100FEA"),
    ("dvdt-c4", "100nF 25V C0G +/-5%", "C1206C104J3GACTU"),
    ("efuse-u1", "0.247A eFuse/OVC latch-off", "TPS259620DDAR"),
    ("en-hi-r6", "249k 1%", "CRCW0603249KFKEA"),
    ("en-lo-r7", "100k 1%", "CRCW0603100KFKEA"),
    ("ilim-r3", "3.83k 1%", "CRCW06033K83FKEA"),
    ("ldo-u2", "3.3V 1A LDO", "LP38692MPX-3.3/NOPB"),
    ("led-d2", "green 0603 LED", "150060VS75000"),
    ("led-r8", "1k 1%", "CRCW06031K00FKEA"),
    ("out-j2", "3V3 OUT 100mA MAX / DO NOT APPLY POWER", "61300211121"),
    ("ovc-r4", "200k 1%", "CRCW0603200KFKEA"),
    ("ovc-r5", "200k 1%", "CRCW0603200KFKEA"),
    ("tp-1", "VBUS_RAW", "5015"),
    ("tp-2", "V5_PROTECTED", "5015"),
    ("tp-3", "3V3", "5015"),
    ("tp-4", "GND", "5015"),
    ("tvs-d1", "5.5V unidirectional TVS", "PTVS5V5Z1UPC"),
    ("usb-j1", "USB-C 5V sink", "USB4105-GF-A"),
)
_NARROW_POWER_THROAT_TRACK_IDS = frozenset(
    {
        "minimal:033:vbus-usb-low:0",
        "minimal:034:vbus-usb-high:0",
        "minimal:035:vbus-usb-high:1",
        "minimal:036:vbus-usb-high:2",
        "minimal:037:vbus-tvs",
        "minimal:038:vbus-c1:0",
        "minimal:039:vbus-c1:1",
        "minimal:040:vbus-c1:2",
        "minimal:041:vbus-r6:0",
        "minimal:042:vbus-u1",
        "minimal:051:v5-u1-throat",
    }
)
_U2_THERMAL_VIAS = (
    ("minimal-via:10:gnd-u2-left", 27_200_000, 14_100_000),
    ("minimal-via:11:gnd-u2-right", 28_800_000, 14_100_000),
)
_USB_LOCAL_EXCEPTION_PAD_IDS = frozenset(
    {
        "pad:usb-j1:A1:0",
        "pad:usb-j1:B12:0",
        "pad:usb-j1:A12:0",
        "pad:usb-j1:B1:0",
    }
)
_USB_LOCAL_EXCEPTION_MESSAGES = frozenset(
    {
        "Copper clearance violation between pad:pad:usb-j1:A1:0 and NPTH hole:usb-j1:locating:0",
        "Copper clearance violation between pad:pad:usb-j1:A12:0 and NPTH hole:usb-j1:locating:1",
    }
)


class _AuditPayload(TypedDict):
    audit_version: str
    graph_hash: str
    revision_hash: str
    constraints_hash: str
    sources_hash: str
    implementation_hash: str
    checker_code_hash: str
    evidence_receipts_hash: str
    electrical_calculations: ElectricalCalculations
    electrical_calculations_hash: str
    route_plan_hash: str
    route_input_hash: str
    route_provenance: str
    route_review_hash: str
    analog_bias_proof_hash: str
    passed_check_ids: tuple[str, ...]
    blocking_findings: tuple[str, ...]


def _load_analog_bias_proof() -> Callable[[object], str]:
    private_name = "_analog_bias_proof_hash"
    return cast(Callable[[object], str], getattr(builder, private_name))


_analog_bias_proof = _load_analog_bias_proof()


def _load_verification_board() -> Callable[[object], BoardGraph]:
    private_name = "_verification_board"
    return cast(Callable[[object], BoardGraph], getattr(builder, private_name))


_verification_board = _load_verification_board()
_PRODUCTION_ROUTE_POLICY = VerificationPolicy(
    overrides=(
        RuleOverride(
            "GEO.COPPER.MIN_CLEARANCE",
            parameters=(ParameterValue("minimum_clearance_nm", 200_000),),
        ),
    ),
    gates=strict_policy().gates,
)


def _manifest_text(entry: dict[str, object], field: str) -> str:
    value = entry.get(field)
    if type(value) is not str:
        raise ReferenceDesignViolation(f"reference source manifest {field} is malformed")
    return value


def _implementation_hash(build: ReferenceBoardBuild) -> str:
    return stable_hash(
        {
            "components": build.graph.components,
            "placements": build.graph.placements,
            "pads": build.graph.pads,
            "holes": build.graph.holes,
            "tracks": build.graph.tracks,
            "vias": build.graph.vias,
            "zones": build.graph.zones,
            "bom": bom(),
            "constraints": constraints(),
            "sources": sources(),
            "kicad_footprint_commit": KICAD_FOOTPRINT_COMMIT,
            "kicad_footprint_files": KICAD_LIBRARY_PROVENANCE,
            "manufacturer_land_sources": MANUFACTURER_LAND_PROVENANCE,
        },
        domain="flux-clone-reference-implementation-v2",
    )


def _checker_code_hash() -> str:
    """Hash the complete source bundle that defines this audit's decisions."""

    names = (
        "audit.py",
        "builder.py",
        "circuit.py",
        "footprints.py",
        "layout.py",
        "router.py",
        "specification.py",
    )
    directory = Path(__file__).parent
    payload = b"\x00".join(
        name.encode("ascii") + b"\x00" + (directory / name).read_bytes() for name in names
    )
    return hashlib.sha256(payload).hexdigest()


def _point_on_track(point: PointNm, track: Track) -> bool:
    if track.start.x == track.end.x:
        return point.x == track.start.x and min(track.start.y, track.end.y) <= point.y <= max(
            track.start.y, track.end.y
        )
    if track.start.y == track.end.y:
        return point.y == track.start.y and min(track.start.x, track.end.x) <= point.x <= max(
            track.start.x, track.end.x
        )
    raise ReferenceDesignViolation("split-tee topology requires orthogonal route tracks")


_RouteNode = tuple[str, int, int]


def _route_node(layer: str, point: PointNm) -> _RouteNode:
    return layer, point.x, point.y


def _split_route_topology(
    tracks: tuple[Track, ...],
    vias: tuple[Via, ...],
    net_id: str,
    terminals: Iterable[PointNm] = (),
) -> tuple[dict[_RouteNode, frozenset[_RouteNode]], int]:
    """Split every same-net tee/crossing into atomic non-overlapping edges."""

    net_tracks = tuple(track for track in tracks if track.net_id == net_id)
    if len({track.track_id for track in net_tracks}) != len(net_tracks):
        raise ReferenceDesignViolation("split-tee topology found duplicate track IDs")
    split_points = {track.track_id: {track.start, track.end} for track in net_tracks}
    for index, left in enumerate(net_tracks):
        _point_on_track(left.start, left)
        for right in net_tracks[index + 1 :]:
            if left.layer != right.layer:
                continue
            left_horizontal = left.start.y == left.end.y
            right_horizontal = right.start.y == right.end.y
            if left_horizontal == right_horizontal:
                same_axis = (
                    left.start.y == right.start.y
                    if left_horizontal
                    else left.start.x == right.start.x
                )
                if not same_axis:
                    continue
                left_limits = sorted(
                    (left.start.x, left.end.x) if left_horizontal else (left.start.y, left.end.y)
                )
                right_limits = sorted(
                    (right.start.x, right.end.x)
                    if right_horizontal
                    else (right.start.y, right.end.y)
                )
                if max(left_limits[0], right_limits[0]) < min(left_limits[1], right_limits[1]):
                    raise ReferenceDesignViolation(
                        "split-tee topology found overlapping same-net route segments"
                    )
                continue
            horizontal, vertical = (left, right) if left_horizontal else (right, left)
            intersection = PointNm(vertical.start.x, horizontal.start.y)
            if _point_on_track(intersection, horizontal) and _point_on_track(
                intersection, vertical
            ):
                split_points[horizontal.track_id].add(intersection)
                split_points[vertical.track_id].add(intersection)

    extra_points = tuple(terminals) + tuple(via.center for via in vias if via.net_id == net_id)
    for track in net_tracks:
        split_points[track.track_id].update(
            point for point in extra_points if _point_on_track(point, track)
        )

    adjacency: dict[_RouteNode, set[_RouteNode]] = {}

    def connect(left: _RouteNode, right: _RouteNode) -> None:
        adjacency.setdefault(left, set()).add(right)
        adjacency.setdefault(right, set()).add(left)

    atomic_edge_count = 0
    for track in net_tracks:
        points = sorted(
            split_points[track.track_id],
            key=(
                (lambda point: (point.x, point.y))
                if track.start.y == track.end.y
                else (lambda point: (point.y, point.x))
            ),
        )
        for start, end in zip(points, points[1:], strict=False):
            connect(_route_node(track.layer, start), _route_node(track.layer, end))
            atomic_edge_count += 1
    for via in (item for item in vias if item.net_id == net_id):
        nodes = tuple(_route_node(layer, via.center) for layer in via.layers)
        for left, right in zip(nodes, nodes[1:], strict=False):
            connect(left, right)
    return (
        {node: frozenset(neighbors) for node, neighbors in sorted(adjacency.items())},
        atomic_edge_count,
    )


def _route_path_exists(
    adjacency: dict[_RouteNode, frozenset[_RouteNode]],
    start: _RouteNode,
    goal: _RouteNode,
    *,
    forbidden: frozenset[_RouteNode] = frozenset(),
) -> bool:
    if start in forbidden or goal in forbidden:
        return False
    pending = [start]
    reached = {start}
    while pending:
        current = pending.pop(0)
        if current == goal:
            return True
        for neighbor in sorted(adjacency.get(current, ())):
            if neighbor not in forbidden and neighbor not in reached:
                reached.add(neighbor)
                pending.append(neighbor)
    return False


def _route_turn_count(tracks: tuple[Track, ...]) -> int:
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
                if _point_on_track(point, track)
            }
            if orientations == {"horizontal", "vertical"}:
                count += 1
    return count


def _via_smd_clearance_receipt(graph: DesignGraph) -> tuple[tuple[object, ...], ...]:
    """Prove every complete via annulus is outside all rectangular SMD copper."""

    smd_pads = tuple(pad for pad in graph.pads if pad.drill_x_nm == 0 and pad.drill_y_nm == 0)
    if len(smd_pads) != 64 or any(pad.shape != "rect" for pad in smd_pads):
        raise ReferenceDesignViolation("no-via-in-smd proof requires the 64 rectangular R2 lands")
    receipt: list[tuple[object, ...]] = []
    for via in graph.vias:
        closest: tuple[int, str, int] | None = None
        for pad in smd_pads:
            size_x_nm, size_y_nm = (
                (pad.size_y_nm, pad.size_x_nm)
                if pad.rotation_udeg % 180_000_000
                else (pad.size_x_nm, pad.size_y_nm)
            )
            dx2_nm = max(2 * abs(via.center.x - pad.center.x) - size_x_nm, 0)
            dy2_nm = max(2 * abs(via.center.y - pad.center.y) - size_y_nm, 0)
            twice_distance_squared_nm2 = dx2_nm * dx2_nm + dy2_nm * dy2_nm
            if twice_distance_squared_nm2 <= via.diameter_nm * via.diameter_nm:
                raise ReferenceDesignViolation(
                    f"no-via-in-smd proof failed for {via.via_id} and {pad.pad_id}"
                )
            candidate = (twice_distance_squared_nm2, pad.pad_id, via.diameter_nm**2)
            if closest is None or candidate < closest:
                closest = candidate
        assert closest is not None
        receipt.append((via.via_id, via.net_id, via.center, *closest))
    return tuple(receipt)


def _production_route_report(build: ReferenceBoardBuild) -> VerificationReport:
    """Run the exact 0.20 mm production-route policy on the bound revision."""

    return VerificationEngine().verify(
        _verification_board(build.revision),
        _PRODUCTION_ROUTE_POLICY,
    )


def _corrected_clearance_receipt(graph: DesignGraph) -> dict[str, object]:
    """Retain exact positive margins for the two independently found defects."""

    pads = {pad.pad_id: pad for pad in graph.pads}
    vias = {via.via_id: via for via in graph.vias}
    tracks = {track.track_id: track for track in graph.tracks}
    pad = pads["pad:usb-j1:A12:0"]
    high_via = vias["minimal-via:05:vbus-usb-high"]
    pad_size_x_nm, pad_size_y_nm = (
        (pad.size_y_nm, pad.size_x_nm)
        if pad.rotation_udeg % 180_000_000
        else (pad.size_x_nm, pad.size_y_nm)
    )
    dx2_nm = max(2 * abs(high_via.center.x - pad.center.x) - pad_size_x_nm, 0)
    dy2_nm = max(2 * abs(high_via.center.y - pad.center.y) - pad_size_y_nm, 0)
    core_distance_squared_nm2 = dx2_nm * dx2_nm + dy2_nm * dy2_nm
    required_core_distance_doubled_nm = high_via.diameter_nm + 2 * 200_000
    high_clearance_floor_nm = isqrt(core_distance_squared_nm2) // 2 - high_via.diameter_nm // 2
    high_margin_floor_nm = high_clearance_floor_nm - 200_000

    spine = tracks["minimal:045:vbus-spine"]
    ground_via = vias["minimal-via:09:gnd-r1"]
    if spine.start.x != spine.end.x or not min(
        spine.start.y, spine.end.y
    ) <= ground_via.center.y <= max(spine.start.y, spine.end.y):
        raise ReferenceDesignViolation("corrected VBUS-spine/GND-via subject drifted")
    spine_clearance_nm = (
        abs(ground_via.center.x - spine.start.x) - spine.width_nm // 2 - ground_via.diameter_nm // 2
    )
    spine_margin_nm = spine_clearance_nm - 200_000
    if (
        core_distance_squared_nm2 <= required_core_distance_doubled_nm**2
        or high_margin_floor_nm <= 0
        or spine_margin_nm <= 0
    ):
        raise ReferenceDesignViolation(
            "corrected route clearances require positive margin over 0.20 mm"
        )
    return {
        "minimum_required_clearance_nm": 200_000,
        "vbus_high_via_to_usb_ground_pad": {
            "pad_id": pad.pad_id,
            "via_id": high_via.via_id,
            "twice_point_to_pad_dx_nm": dx2_nm,
            "twice_point_to_pad_dy_nm": dy2_nm,
            "core_distance_squared_nm2": core_distance_squared_nm2,
            "required_core_distance_doubled_nm": required_core_distance_doubled_nm,
            "clearance_floor_nm": high_clearance_floor_nm,
            "margin_floor_nm": high_margin_floor_nm,
        },
        "vbus_spine_to_ground_via": {
            "track_id": spine.track_id,
            "via_id": ground_via.via_id,
            "centerline_distance_nm": abs(ground_via.center.x - spine.start.x),
            "clearance_nm": spine_clearance_nm,
            "margin_nm": spine_margin_nm,
        },
    }


def _evidence_receipts_hash(build: ReferenceBoardBuild) -> str:
    """Bind source-backed connector exceptions, trunk inventory, and land policy."""

    from backend.evidence.reference_sources import DEFAULT_MANIFEST_PATH

    usb_geometry_source = next(
        item for item in sources() if item.evidence_id == "src-kicad-footprint-usb4105"
    )
    manifest_payload = DEFAULT_MANIFEST_PATH.read_bytes()
    decoded_manifest = json.loads(manifest_payload)
    if not isinstance(decoded_manifest, dict):
        raise ReferenceDesignViolation("reference source manifest is malformed")
    manifest = cast(dict[str, object], decoded_manifest)
    sources_value = manifest.get("sources")
    if not isinstance(sources_value, list):
        raise ReferenceDesignViolation("reference source manifest sources are malformed")
    manifest_entries: list[dict[str, object]] = []
    for raw_entry in cast(list[object], sources_value):
        if not isinstance(raw_entry, dict):
            raise ReferenceDesignViolation("reference source manifest entry is malformed")
        manifest_entries.append(cast(dict[str, object], raw_entry))
    retained_ids = tuple(
        sorted(
            _manifest_text(item, "evidence_id")
            for item in manifest_entries
            if _manifest_text(item, "retention_status") == "verified"
        )
    )
    manifest_only_ids = tuple(
        sorted(
            _manifest_text(item, "evidence_id")
            for item in manifest_entries
            if _manifest_text(item, "retention_status") == "manifest-only-unverified"
        )
    )
    public_external_ids = tuple(
        sorted(
            _manifest_text(item, "evidence_id")
            for item in manifest_entries
            if _manifest_text(item, "retention_status") == "public-pinned-external"
        )
    )
    power_net_ids = {net.net_id for net in build.graph.nets if net.name in _POWER_NET_NAMES}
    trunk_tracks = tuple(
        (track.track_id, track.net_id, track.layer, track.width_nm)
        for track in build.graph.tracks
        if track.net_id in power_net_ids and track.width_nm == 800_000
    )
    throat_tracks = tuple(
        (track.track_id, track.net_id, track.layer, track.width_nm)
        for track in build.graph.tracks
        if track.track_id in _NARROW_POWER_THROAT_TRACK_IDS
    )
    production_route_report = _production_route_report(build)
    pads = {item.pad_id: item for item in build.graph.pads}
    holes = {item.hole_id: item for item in build.graph.holes}
    exception_pairs = (
        (
            "usb-j1-shared-gnd-left",
            ("pad:usb-j1:A1:0", "pad:usb-j1:B12:0"),
            "hole:usb-j1:locating:0",
        ),
        (
            "usb-j1-shared-gnd-right",
            ("pad:usb-j1:A12:0", "pad:usb-j1:B1:0"),
            "hole:usb-j1:locating:1",
        ),
    )
    usb_exception_receipt: list[dict[str, object]] = []
    for group_id, pad_ids, hole_id in exception_pairs:
        hole = holes[hole_id]
        pad_subjects = tuple(pads[item] for item in pad_ids)
        if any(item.shared_land_group_id != group_id for item in pad_subjects):
            raise ReferenceDesignViolation("USB exception shared-land binding drifted")
        # The pads are quarter-turned.  Compute the nearest pad-rectangle
        # corner to the hole centre before subtracting the circular radius.
        # Keeping its squared norm avoids claiming a rounded value is exact.
        corner_dx_nm = min(
            item.center.x - item.size_y_nm // 2 - hole.center.x for item in pad_subjects
        )
        corner_dy_nm = min(
            abs(item.center.y - hole.center.y) - item.size_x_nm // 2 for item in pad_subjects
        )
        core_squared_nm2 = corner_dx_nm * corner_dx_nm + corner_dy_nm * corner_dy_nm
        hole_radius_nm = hole.drill_x_nm // 2
        computed_gap_floor_nm = isqrt(core_squared_nm2) - hole_radius_nm
        if (
            corner_dx_nm != 500_000
            or corner_dy_nm != 10_000
            or core_squared_nm2 != 250_100_000_000
            or hole.drill_x_nm != hole.drill_y_nm
            or computed_gap_floor_nm != 175_099
        ):
            raise ReferenceDesignViolation("USB exception geometry drifted")
        usb_exception_receipt.append(
            {
                "shared_land_group_id": group_id,
                "pad_ids": pad_ids,
                "hole_id": hole_id,
                "nearest_corner_vector_nm": (corner_dx_nm, corner_dy_nm),
                "core_distance_squared_nm2": core_squared_nm2,
                "hole_radius_nm": hole_radius_nm,
                "computed_clearance_floor_nm": computed_gap_floor_nm,
                "qualification": "public-library-geometry-preserved;mechanical-mating-unqualified",
            }
        )
    return stable_hash(
        {
            "usb4105-public-footprint-npth-receipt": {
                "evidence_id": usb_geometry_source.evidence_id,
                "source_sha256": usb_geometry_source.sha256,
                "pairs": tuple(usb_exception_receipt),
            },
            "power-trunk-receipt": {
                "route_authority": FROZEN_ROUTE_AUTHORITY,
                "route_input_schema": ROUTE_INPUT_SCHEMA,
                "route_input_hash": FROZEN_ROUTE_INPUT_HASH,
                "route_plan_hash": FROZEN_ROUTE_PLAN_HASH,
                "route_review_hash": FROZEN_ROUTE_REVIEW_HASH,
                "route_review_contract": FROZEN_ROUTE_REVIEW_CONTRACT,
                "trunks": trunk_tracks,
                "enumerated_throats": throat_tracks,
                "minimum_width_nm": 800_000,
            },
            "production-route-clearance-receipt": {
                "minimum_clearance_nm": 200_000,
                "report": production_route_report,
                "accepted_public_footprint_geometry_messages": tuple(
                    sorted(_USB_LOCAL_EXCEPTION_MESSAGES)
                ),
                "corrected_pair_margins": _corrected_clearance_receipt(build.graph),
            },
            "pinned-kicad-footprints": {
                "commit": KICAD_FOOTPRINT_COMMIT,
                "raw_file_digests": KICAD_LIBRARY_PROVENANCE,
            },
            "manufacturer-land-provenance": MANUFACTURER_LAND_PROVENANCE,
            "reference-source-manifest": {
                "manifest_sha256": hashlib.sha256(manifest_payload).hexdigest(),
                "retained_and_rehashed_evidence_ids": retained_ids,
                "manifest_only_unverified_evidence_ids": manifest_only_ids,
                "public_pinned_external_evidence_ids": public_external_ids,
            },
        },
        domain="flux-clone-reference-evidence-receipts-v3",
    )


def _exact(value: Fraction | int) -> ExactRational:
    rational = Fraction(value)
    return ExactRational(rational.numerator, rational.denominator)


def _quantity(
    quantity_id: str,
    unit: str,
    basis: str,
    source_evidence_ids: tuple[str, ...],
    *,
    minimum: Fraction | int | None = None,
    typical: Fraction | int | None = None,
    maximum: Fraction | int | None = None,
) -> CalculationQuantity:
    return CalculationQuantity(
        quantity_id,
        unit,
        basis,
        source_evidence_ids,
        _exact(minimum) if minimum is not None else None,
        _exact(typical) if typical is not None else None,
        _exact(maximum) if maximum is not None else None,
    )


def _nominal_capacitance_uf(value: str) -> Fraction:
    """Decode the leading fitted-value capacitance without a float round trip."""

    magnitude, separator, _qualifiers = value.partition("uF")
    if not separator or not magnitude:
        raise ReferenceDesignViolation("electrical receipt capacitance value is not in uF")
    try:
        nominal_uf = Fraction(magnitude)
    except (ValueError, ZeroDivisionError) as error:
        raise ReferenceDesignViolation(
            "electrical receipt capacitance magnitude is invalid"
        ) from error
    if nominal_uf <= 0:
        raise ReferenceDesignViolation("electrical receipt capacitance must be positive")
    return nominal_uf


def electrical_calculations_for_graph(graph: DesignGraph) -> ElectricalCalculations:
    """Return the complete R2 calculation body retained beside its digest."""

    if type(graph) is not DesignGraph:
        raise ReferenceDesignViolation("electrical calculations require exact DesignGraph")
    component_map = {component.component_id: component for component in graph.components}
    expected_subject = {
        component_id: (value, manufacturer_part_number)
        for component_id, value, manufacturer_part_number in _ELECTRICAL_FITTED_SUBJECT
    }
    actual_subject = {
        component_id: (
            component_map[component_id].value,
            component_map[component_id].manufacturer_part_number,
        )
        for component_id in expected_subject
        if component_id in component_map
    }
    if set(component_map) != set(expected_subject) or actual_subject != expected_subject:
        raise ReferenceDesignViolation("electrical receipt fitted-value/MPN subject drifted")
    if graph.nets != build_circuit().nets:
        raise ReferenceDesignViolation("electrical receipt logical topology drifted")

    # The protected-path terms are explicit so the ~103.847 mA result is not
    # a magic literal. TPS2596 IQ is drawn upstream of the monitored OUT path.
    protected_path_terms_ma = (
        Fraction(100),
        Fraction(3_522_899, 1_000_000),
        Fraction(220, 1_000),
        Fraction(100, 1_000),
        Fraction(1, 1_000),
        Fraction(2_634, 1_000_000),
    )
    static_load_ma = sum(protected_path_terms_ma, start=Fraction())
    downstream_capacitance_uf = sum(
        (
            _nominal_capacitance_uf(component_map[component_id].value)
            for component_id in ("cldo-c2", "cout-c3")
        ),
        start=Fraction(),
    )
    slew_min_mv_per_us = Fraction(3_645, 10_000)
    slew_typ_mv_per_us = Fraction(4_416, 10_000)
    slew_max_mv_per_us = Fraction(5_289, 10_000)
    # uF * mV/us is numerically mA. Keep all three products exact: these
    # bounds are calculation evidence, not three-decimal display estimates.
    inrush_min_ma = downstream_capacitance_uf * slew_min_mv_per_us
    inrush_typ_ma = downstream_capacitance_uf * slew_typ_mv_per_us
    inrush_max_ma = downstream_capacitance_uf * slew_max_mv_per_us
    startup_total_ma = static_load_ma + inrush_max_ma
    engineering_ilim_min_ma = Fraction(220_350, 1_000)
    startup_margin_ma = engineering_ilim_min_ma - startup_total_ma
    if (
        downstream_capacitance_uf != Fraction(267, 10)
        or inrush_min_ma != Fraction(194_643, 20_000)
        or inrush_typ_ma != Fraction(36_846, 3_125)
        or inrush_max_ma != Fraction(1_412_163, 100_000)
        or static_load_ma != Fraction(103_846_533, 1_000_000)
        or startup_total_ma != Fraction(117_968_163, 1_000_000)
        or startup_margin_ma != Fraction(102_381_837, 1_000_000)
    ):
        raise ReferenceDesignViolation("R2 current-budget calculation drifted")

    r6_low, r6_high = 246_510, 251_490
    r7_low, r7_high = 99_000, 101_000
    uvlo_low_mv = Fraction(1_180 * (r6_low + r7_high), r7_high)
    uvlo_high_mv = Fraction(1_220 * (r6_high + r7_low), r7_low)
    en_at_21v_mv = Fraction(21_000 * r7_high, r6_low + r7_high)
    if not (Fraction(4_060) <= uvlo_low_mv <= Fraction(4_061)):
        raise ReferenceDesignViolation("UVLO lower-bound calculation drifted")
    if not (Fraction(4_319) <= uvlo_high_mv <= Fraction(4_320)):
        raise ReferenceDesignViolation("UVLO upper-bound calculation drifted")
    if en_at_21v_mv >= 7_000:
        raise ReferenceDesignViolation("EN absolute-maximum calculation failed")

    current_sources = (
        "src-kemet-cap",
        "src-kemet-t59x",
        "src-ti-lp38692-datasheet",
        "src-tps2596",
        "src-vishay-resistors",
    )
    current_blockers = ("c2-effective-capacitance-and-high-temperature-leakage-not-guaranteed",)
    current = ElectricalCalculationSection(
        "current-budget",
        current_sources,
        (
            _quantity(
                "efuse-ilim-datasheet-table",
                "mA",
                "Direct TPS2596 electrical-characteristics row at RILM=3.83 kOhm.",
                ("src-tps2596",),
                minimum=224,
                typical=247,
                maximum=269,
            ),
            _quantity(
                "efuse-ilim-tolerance-tcr-screen",
                "mA",
                "Approximate inverse-resistance extension for R3 +/-1 percent and "
                "+/-100 ppm/K over 65 K; not an additional TI guarantee.",
                ("src-tps2596", "src-vishay-resistors"),
                minimum=engineering_ilim_min_ma,
                typical=247,
                maximum=Fraction(273_500, 1_000),
            ),
            _quantity(
                "lp38692-loaded-iq",
                "mA",
                "Guaranteed maximum for 100 uA through 1 A load over -40 C to +125 C.",
                ("src-ti-lp38692-datasheet",),
                maximum=Fraction(1, 10),
            ),
            _quantity(
                "protected-path-static-load",
                "mA",
                "100 mA header + 3.522899 mA LED-short screen + 0.220 mA C3 "
                "leakage + 0.100 mA loaded IQ + 0.001 mA EN leakage + "
                "0.002634 mA provisional C2 leakage screen.",
                (
                    "src-kemet-cap",
                    "src-kemet-t59x",
                    "src-ti-lp38692-datasheet",
                    "src-vishay-resistors",
                ),
                typical=static_load_ma,
            ),
            _quantity(
                "startup-capacitive-plus-static-load",
                "mA",
                "Static screen plus the exact 14.12163 mA nominal-capacitance inrush maximum.",
                current_sources,
                maximum=startup_total_ma,
            ),
            _quantity(
                "startup-margin-to-engineering-ilim-floor",
                "mA",
                "220.350 mA engineering ILIM floor minus 117.968163 mA startup screen.",
                current_sources,
                minimum=startup_margin_ma,
            ),
        ),
        (
            "The screened protected-path static load is 103.846533 mA, approximately 103.847 mA.",
            "The 102.381837 mA startup margin supports the selected setpoint but does "
            "not qualify actual attached capacitance, startup load, or temperature behavior.",
        ),
        current_blockers,
    )

    output_blockers = ("j2-output-only-reverse-current-policy-not-approved-or-validated",)
    output_policy = ElectricalCalculationSection(
        "output-reverse-policy",
        ("src-ti-lp38692-datasheet", "src-wurth-header"),
        (
            _quantity(
                "external-drive-allowed-current",
                "mA",
                "Output-only product rule; applying power at J2 is prohibited.",
                ("src-ti-lp38692-datasheet", "src-wurth-header"),
                maximum=0,
            ),
            _quantity(
                "header-output-current",
                "mA",
                "Available at J2 in addition to onboard LED and qualified overhead.",
                ("src-ti-lp38692-datasheet", "src-wurth-header"),
                maximum=100,
            ),
        ),
        (
            OUTPUT_MARKING,
            "J2 and TP3 are directly on 3V3; R9 is only in the C3 branch.",
            "LP38692 has sustained OUT-to-IN paths; no LM66100, U3, or internal "
            "3V3 split is present.",
        ),
        output_blockers,
    )

    protection = ElectricalCalculationSection(
        "protection-thresholds",
        (
            "src-ti-usb-c-guide",
            "src-tps2596",
            "src-vishay-resistors",
            "src-wurth-cap",
        ),
        (
            _quantity(
                "en-at-21v",
                "mV",
                "Worst divider endpoint used only for the TPS2596 EN absolute-maximum screen.",
                ("src-tps2596", "src-vishay-resistors"),
                maximum=en_at_21v_mv,
            ),
            _quantity(
                "ovcsel-series-resistance",
                "ohm",
                "Two 200 kOhm +/-1 percent resistors in series.",
                ("src-tps2596", "src-vishay-resistors"),
                minimum=396_000,
                typical=400_000,
                maximum=404_000,
            ),
            _quantity(
                "raw-vbus-capacitance",
                "nF",
                "C1 nominal value, below the 10 uF passive-sink screen.",
                ("src-ti-usb-c-guide", "src-wurth-cap"),
                typical=1_000,
                maximum=10_000,
            ),
            _quantity(
                "uvlo-rising-threshold",
                "mV",
                "TPS2596 EN threshold and R6/R7 tolerance endpoints.",
                ("src-tps2596", "src-vishay-resistors"),
                minimum=uvlo_low_mv,
                maximum=uvlo_high_mv,
            ),
        ),
        (
            "Only compliant USB Type-C default 4.75 V to 5.50 V input is qualified.",
            "TPS259620 ratings and the 5.61 V at 10 mA clamp-table corner are not "
            "a sustained-overvoltage product rating.",
        ),
    )

    r9_min_mohm = Fraction(1_965_843, 200_000)
    r9_max_mohm = Fraction(2_034_443, 200_000)
    stability_blockers = ("c3-r9-full-temperature-capacitance-esr-and-stability-not-qualified",)
    stability = ElectricalCalculationSection(
        "stability",
        ("src-kemet-t59x", "src-ti-lp38692-datasheet", "src-vishay-wslp"),
        (
            _quantity(
                "c3-capacitance-screen",
                "uF",
                "22 uF with -20 percent initial tolerance and -20 percent "
                "temperature-stability screen.",
                ("src-kemet-t59x", "src-ti-lp38692-datasheet"),
                minimum=Fraction(352, 25),
                typical=22,
            ),
            _quantity(
                "c3-esr-at-25c-100khz",
                "mOhm",
                "Exact T598 row; not a full-temperature or all-frequency limit.",
                ("src-kemet-t59x",),
                maximum=70,
            ),
            _quantity(
                "lp38692-guidance-esr-window",
                "mOhm",
                "TI application guidance, explicitly outside the warranted "
                "component specification.",
                ("src-ti-lp38692-datasheet",),
                minimum=5,
                maximum=500,
            ),
            _quantity(
                "r9-resistance-screen",
                "mOhm",
                "10 mOhm with +/-1 percent and +/-110 ppm/C over the 65 K excursion.",
                ("src-vishay-wslp",),
                minimum=r9_min_mohm,
                typical=10,
                maximum=r9_max_mohm,
            ),
            _quantity(
                "series-branch-esr-at-25c-100khz",
                "mOhm",
                "C3 70 mOhm maximum plus R9 maximum screen at the stated C3 condition.",
                ("src-kemet-t59x", "src-vishay-wslp"),
                maximum=70 + r9_max_mohm,
            ),
        ),
        (
            "C3 pin 1 is positive on COUT_DAMPED and pin 2 is negative on GND.",
            "R9 open removes the required output capacitor; R9 short removes the "
            "source-backed ESR floor. Either fault fails release qualification.",
        ),
        stability_blockers,
    )

    startup_blockers = (
        "lp38692-repeated-enable-brownout-and-bounce-not-qualified",
        "tps2596-loaded-startup-over-temperature-not-qualified",
    )
    startup = ElectricalCalculationSection(
        "startup",
        (
            "src-kemet-cap",
            "src-kemet-t59x",
            "src-kemet-c0g-family",
            "src-kemet-c1206c104",
            "src-tps2596",
        ),
        (
            _quantity(
                "c4-effective-capacitance",
                "nF",
                "100 nF +/-5 percent combined with a conservative +/-0.30 percent "
                "C0G temperature envelope.",
                ("src-kemet-c0g-family", "src-kemet-c1206c104"),
                minimum=Fraction(94_715, 1_000),
                typical=100,
                maximum=Fraction(105_315, 1_000),
            ),
            _quantity(
                "capacitive-inrush",
                "mA",
                "Exact bounded slew multiplied by 26.7 uF fitted nominal downstream capacitance.",
                (
                    "src-kemet-cap",
                    "src-kemet-t59x",
                    "src-kemet-c1206c104",
                    "src-tps2596",
                ),
                minimum=inrush_min_ma,
                typical=inrush_typ_ma,
                maximum=inrush_max_ma,
            ),
            _quantity(
                "downstream-capacitance-assumption",
                "uF",
                "Fitted nominal C2 plus C3 used only for the dVdt inrush screen.",
                ("src-kemet-cap", "src-kemet-t59x"),
                typical=downstream_capacitance_uf,
            ),
            _quantity(
                "dvdt-charging-current",
                "uA",
                "TPS2596 electrical-characteristics min/typ/max row.",
                ("src-tps2596",),
                minimum=Fraction(189, 100),
                typical=Fraction(211, 100),
                maximum=Fraction(233, 100),
            ),
            _quantity(
                "dvdt-gain",
                "V",
                "TPS2596 electrical-characteristics min/typ/max row.",
                ("src-tps2596",),
                minimum=Fraction(2_031, 100),
                typical=Fraction(2_093, 100),
                maximum=Fraction(43, 2),
            ),
            _quantity(
                "five-volt-ramp",
                "ms",
                "Inverse of the bounded slew at a 5 V ramp.",
                ("src-kemet-c1206c104", "src-tps2596"),
                minimum=Fraction(9_454, 1_000),
                typical=Fraction(11_322, 1_000),
                maximum=Fraction(13_718, 1_000),
            ),
            _quantity(
                "slew-rate",
                "mV_per_us",
                "IDVDT*GDVDT/C4 using tabulated IC extrema rather than the 42000 "
                "design-rule nominal constant.",
                ("src-kemet-c1206c104", "src-tps2596"),
                minimum=slew_min_mv_per_us,
                typical=slew_typ_mv_per_us,
                maximum=slew_max_mv_per_us,
            ),
        ),
        (
            "The exact 9.73215 to 14.12163 mA bounds are capacitive inrush only; active load, "
            "actual capacitance, source droop, ESR/ESL, and pre-bias are excluded.",
            "Scope VBUS_RAW, V5_PROTECTED, 3V3, and input current over temperature "
            "and on repeated-enable, bounce, brownout, and eFuse-reset sequences.",
        ),
        startup_blockers,
    )

    thermal_blockers = ("lp38692-board-specific-thermal-evidence-not-recorded",)
    thermal = ElectricalCalculationSection(
        "thermal",
        ("src-ti-lp38692-datasheet",),
        (
            _quantity(
                "assembled-board-theta-ja-maximum",
                "C_per_W",
                "(125 C junction limit - 80 C ambient) / 0.25733 W; margin still required.",
                ("src-ti-lp38692-datasheet",),
                maximum=Fraction(17_487, 100),
            ),
            _quantity(
                "high-k-test-board-theta-ja",
                "C_per_W",
                "TI High-K test-board figure; not transferable proof for this PCB.",
                ("src-ti-lp38692-datasheet",),
                typical=Fraction(137, 2),
            ),
            _quantity(
                "ldo-dissipation",
                "W",
                "5.61 V stress input, 3.135 V output minimum, 103.742899 mA "
                "pass load, and 101 uA IQ plus EN current.",
                ("src-ti-lp38692-datasheet",),
                maximum=Fraction(25_733, 100_000),
            ),
            _quantity(
                "screen-ambient",
                "C",
                "Upper board qualification ambient.",
                ("src-ti-lp38692-datasheet",),
                maximum=80,
            ),
            _quantity(
                "screen-junction-limit",
                "C",
                "Upper qualified junction used for this design screen.",
                ("src-ti-lp38692-datasheet",),
                maximum=125,
            ),
        ),
        (
            "U2 pin 5/tab needs a reviewed NDC0005A land, substantial top GND copper, "
            "and multiple low-impedance ground/thermal stitches.",
            "A board-specific model or measurement must demonstrate thetaJA below "
            "174.87 C/W with production margin at the stress corner.",
        ),
        thermal_blockers,
    )

    sections = (current, output_policy, protection, stability, startup, thermal)
    consolidated_blockers = tuple(
        sorted(blocker for section in sections for blocker in section.qualification_blockers)
    )
    return ElectricalCalculations(
        "reference-usb-c-3v3-r2-calculations-v1",
        tuple(
            sorted(
                (
                    component_id,
                    component_map[component_id].manufacturer_part_number,
                )
                for component_id in expected_subject
            )
        ),
        sections,
        consolidated_blockers,
    )


def _require(condition: bool, check_id: str) -> None:
    if not condition:
        raise ReferenceDesignViolation(f"reference board audit failed: {check_id}")


def audit_reference_board(build: ReferenceBoardBuild) -> BoardAudit:
    """Audit exact engineering invariants and return a content-bound receipt."""

    from backend.evidence.reference_sources import verify_manifest

    if type(build) is not ReferenceBoardBuild:
        raise ReferenceDesignViolation("reference audit requires exact ReferenceBoardBuild")
    graph = build.graph
    component_by_id = {item.component_id: item for item in graph.components}
    _require(len(component_by_id) == len(graph.components), "component-identity-unique")
    component_spec = components()
    expected_circuit = build_circuit()
    expected_component_count = len(component_spec)
    expected_pin_count = sum(len(component.pins) for component in component_spec)
    expected_net_count = len(expected_circuit.nets)
    expected_connected_pin_count = sum(len(net.members) for net in expected_circuit.nets)
    expected_no_connect_count = len(expected_circuit.no_connects)
    _require(
        expected_component_count == 23 and len(graph.components) == expected_component_count,
        "r2-component-count",
    )
    _require(
        expected_pin_count == 67
        and sum(len(component.pins) for component in graph.components) == expected_pin_count,
        "r2-pin-count",
    )
    _require(graph.nets == expected_circuit.nets, "r2-logical-netlist")
    _require(expected_net_count == 13 and len(graph.nets) == expected_net_count, "r2-net-count")
    _require(
        expected_connected_pin_count == 59
        and sum(len(net.members) for net in graph.nets) == expected_connected_pin_count,
        "r2-connected-pin-count",
    )
    _require(
        expected_no_connect_count == 8
        and sum(
            pin.electrical_type == "no_connect"
            for component in graph.components
            for pin in component.pins
        )
        == expected_no_connect_count,
        "r2-no-connect-count",
    )
    _require(
        all(
            component.reference != "U3" and "LM66100" not in component.manufacturer_part_number
            for component in graph.components
        ),
        "lm66100-u3-excluded",
    )

    checks: list[str] = []
    # Electrical subject: independently anchor the two CC resistors and the
    # exact passive UVLO divider used by the builder's v2 native projection.
    memberships = {pin: net.net_id for net in graph.nets for pin in net.members}
    _require(memberships[PinRef("usb-j1", "A5")] == NET_CC1, "cc1-net")
    _require(memberships[PinRef("usb-j1", "B5")] == NET_CC2, "cc2-net")
    _require(
        memberships[PinRef("usb-j1", "A5")] != memberships[PinRef("usb-j1", "B5")],
        "cc-net-separation",
    )
    _require(memberships[PinRef("cc-r1", "2")] == NET_GND, "cc1-rd-ground")
    _require(memberships[PinRef("cc-r2", "2")] == NET_GND, "cc2-rd-ground")
    _require(component_by_id["cc-r1"].value == "5.1k 1%", "cc1-rd-value")
    _require(component_by_id["cc-r2"].value == "5.1k 1%", "cc2-rd-value")
    _require(component_by_id["en-hi-r6"].value == "249k 1%", "uvlo-upper-value")
    _require(component_by_id["en-lo-r7"].value == "100k 1%", "uvlo-lower-value")
    _require(memberships[PinRef("efuse-u1", "2")] == NET_DVDT, "u1-dvdt-connected")
    _require(memberships[PinRef("dvdt-c4", "1")] == NET_DVDT, "c4-dvdt-connected")
    _require(memberships[PinRef("dvdt-c4", "2")] == NET_GND, "c4-ground")
    _require(memberships[PinRef("ldo-u2", "1")] == NET_V5_PROTECTED, "u2-enable")
    _require(memberships[PinRef("ldo-u2", "3")] == NET_3V3, "u2-output")
    _require(memberships[PinRef("ldo-u2", "4")] == NET_V5_PROTECTED, "u2-input")
    _require(memberships[PinRef("ldo-u2", "5")] == NET_GND, "u2-tab-ground")
    _require(memberships[PinRef("cout-esr-r9", "1")] == NET_3V3, "r9-rail-side")
    _require(
        memberships[PinRef("cout-esr-r9", "2")] == NET_COUT_DAMPED,
        "r9-capacitor-side",
    )
    _require(memberships[PinRef("cout-c3", "1")] == NET_COUT_DAMPED, "c3-positive")
    _require(memberships[PinRef("cout-c3", "2")] == NET_GND, "c3-negative")
    _require(memberships[PinRef("out-j2", "1")] == NET_3V3, "j2-direct-3v3")
    _require(memberships[PinRef("tp-3", "1")] == NET_3V3, "tp3-direct-3v3")
    _require(
        _analog_bias_proof(graph) == build.analog_bias_proof_hash,
        "analog-bias-proof",
    )
    checks.extend(
        (
            "cc1-net",
            "cc2-net",
            "cc-net-separation",
            "cc1-rd-ground",
            "cc2-rd-ground",
            "cc1-rd-value",
            "cc2-rd-value",
            "uvlo-upper-value",
            "uvlo-lower-value",
            "r2-component-count",
            "r2-pin-count",
            "r2-logical-netlist",
            "r2-net-count",
            "r2-connected-pin-count",
            "r2-no-connect-count",
            "lm66100-u3-excluded",
            "u1-dvdt-connected",
            "c4-dvdt-connected",
            "c4-ground",
            "u2-enable",
            "u2-output",
            "u2-input",
            "u2-tab-ground",
            "r9-rail-side",
            "r9-capacitor-side",
            "c3-positive",
            "c3-negative",
            "j2-direct-3v3",
            "tp3-direct-3v3",
            "analog-bias-proof",
        )
    )

    # Physical subject: explicit NCs stay unassigned; USB duplicate contacts
    # share only their same-net land; all intended slots and locating holes are
    # present.  The two locating holes are the sole connector-local ~0.1751 mm
    # exceptions in the pinned public KiCad footprint geometry, not route
    # exceptions or manufacturer-authorized clearance minima.  Mechanical
    # mating remains unqualified.
    nc = {
        (component.component_id, pin.pad_number)
        for component in graph.components
        for pin in component.pins
        if pin.electrical_type == "no_connect"
    }
    _require(
        all(pad.net_id is None for pad in graph.pads if (pad.component_id, pad.pad_number) in nc),
        "no-connect-pad-unassigned",
    )
    shared: dict[str, set[str | None]] = {}
    for pad in graph.pads:
        if pad.shared_land_group_id is not None:
            shared.setdefault(pad.shared_land_group_id, set()).add(pad.net_id)
    _require(
        len(shared) == 4 and all(len(nets) == 1 for nets in shared.values()),
        "shared-land-net-unity",
    )
    usb_holes = tuple(hole for hole in graph.holes if hole.component_id == "usb-j1")
    _require(sum(hole.plated and hole.drill_is_slot for hole in usb_holes) == 4, "usb-shell-slots")
    _require(
        {hole.hole_id for hole in usb_holes if not hole.plated} == set(USB_LOCATING_HOLE_IDS),
        "usb-locating-npth",
    )
    _require(
        {
            pad.pad_id
            for pad in graph.pads
            if pad.component_id == "usb-j1" and pad.pad_id in _USB_LOCAL_EXCEPTION_PAD_IDS
        }
        == set(_USB_LOCAL_EXCEPTION_PAD_IDS),
        "usb-local-exception-enumeration",
    )
    checks.extend(
        (
            "no-connect-pad-unassigned",
            "shared-land-net-unity",
            "usb-shell-slots",
            "usb-locating-npth",
            "usb-local-exception-enumeration",
        )
    )

    # The bounded router remains candidate generation only.  Production
    # replays this independently reviewed, compressed, content-addressed R2
    # tree and then proves the electrical and geometric obligations below.
    expected_tracks, expected_vias = frozen_route_plan(FROZEN_ROUTE_INPUT_HASH)
    _require(
        graph.tracks == expected_tracks and graph.vias == expected_vias,
        "frozen-route-population",
    )
    _require(
        stable_hash(
            {"tracks": graph.tracks, "vias": graph.vias},
            domain="flux-clone-reference-route-plan-v1",
        )
        == FROZEN_ROUTE_PLAN_HASH,
        "frozen-route-hash",
    )
    _require(
        (
            len(graph.tracks),
            len(graph.vias),
            len({item.net_id for item in (*graph.tracks, *graph.vias)}),
            sum(
                abs(track.end.x - track.start.x) + abs(track.end.y - track.start.y)
                for track in graph.tracks
            ),
            _route_turn_count(graph.tracks),
        )
        == (
            FROZEN_ROUTE_TRACK_COUNT,
            FROZEN_ROUTE_VIA_COUNT,
            FROZEN_ROUTE_TREE_COUNT,
            FROZEN_ROUTE_MANHATTAN_LENGTH_NM,
            FROZEN_ROUTE_TURN_COUNT,
        ),
        "frozen-route-metrics",
    )
    _require(
        {net.net_id for net in graph.nets} == set(ROUTE_NET_ORDER),
        "thirteen-route-tree-subjects",
    )
    _require(
        tuple(net_id for net_id, _ in ROUTE_DEFAULT_WIDTHS_NM) == ROUTE_NET_ORDER,
        "route-default-width-order",
    )
    _require(
        all(track.width_nm >= 250_000 for track in graph.tracks),
        "minimum-authored-track-width",
    )
    rail_net_ids = {NET_VBUS_RAW, NET_V5_PROTECTED, NET_3V3, NET_COUT_DAMPED}
    rail_tracks = tuple(track for track in graph.tracks if track.net_id in rail_net_ids)
    narrow_tracks = tuple(track for track in rail_tracks if track.width_nm < 800_000)
    _require(
        {track.track_id for track in narrow_tracks} == set(_NARROW_POWER_THROAT_TRACK_IDS)
        and all(track.width_nm == 300_000 for track in narrow_tracks),
        "enumerated-030-power-throats",
    )
    _require(
        all(
            track.width_nm == 800_000
            for track in rail_tracks
            if track.track_id not in _NARROW_POWER_THROAT_TRACK_IDS
        ),
        "power-trunks-080",
    )
    cout_tracks = tuple(track for track in graph.tracks if track.net_id == NET_COUT_DAMPED)
    _require(
        len(cout_tracks) == 2
        and all(track.width_nm == 800_000 for track in cout_tracks)
        and not any(via.net_id == NET_COUT_DAMPED for via in graph.vias),
        "cout-entirely-080",
    )
    tracks_by_id = {track.track_id: track for track in graph.tracks}
    placements_by_id = {placement.component_id: placement for placement in graph.placements}
    pads_by_id = {pad.pad_id: pad for pad in graph.pads}
    vias_by_id = {via.via_id: via for via in graph.vias}
    _require(
        (
            placements_by_id["cout-esr-r9"].position,
            placements_by_id["cout-esr-r9"].rotation_udeg,
            placements_by_id["cout-c3"].position,
            placements_by_id["cout-c3"].rotation_udeg,
        )
        == (
            PointNm(27_250_000, 22_250_000),
            270_000_000,
            PointNm(29_250_000, 26_000_000),
            0,
        )
        and (
            pads_by_id["pad:cout-esr-r9:1:0"].center,
            pads_by_id["pad:cout-esr-r9:2:0"].center,
            pads_by_id["pad:cout-c3:1:0"].center,
            pads_by_id["pad:cout-c3:2:0"].center,
        )
        == (
            PointNm(27_250_000, 21_490_000),
            PointNm(27_250_000, 23_010_000),
            PointNm(27_790_000, 26_000_000),
            PointNm(30_710_000, 26_000_000),
        )
        and {
            (
                track.track_id,
                track.net_id,
                track.layer,
                track.start,
                track.end,
                track.width_nm,
            )
            for track in tracks_by_id.values()
            if track.track_id
            in {
                "minimal:058:v3-main:0",
                "minimal:059:v3-main:1",
                "minimal:059:v3-r9",
                "minimal:023:cout:0",
                "minimal:024:cout:1",
                "minimal:115:gnd-c3-front",
                "minimal:116:gnd-c3-back",
            }
        }
        == {
            (
                "minimal:058:v3-main:0",
                NET_3V3,
                "F.Cu",
                PointNm(27_250_000, 19_000_000),
                PointNm(27_250_000, 20_600_000),
                800_000,
            ),
            (
                "minimal:059:v3-main:1",
                NET_3V3,
                "F.Cu",
                PointNm(27_250_000, 20_600_000),
                PointNm(31_500_000, 20_600_000),
                800_000,
            ),
            (
                "minimal:059:v3-r9",
                NET_3V3,
                "F.Cu",
                PointNm(27_250_000, 20_600_000),
                PointNm(27_250_000, 21_490_000),
                800_000,
            ),
            (
                "minimal:023:cout:0",
                NET_COUT_DAMPED,
                "F.Cu",
                PointNm(27_250_000, 23_010_000),
                PointNm(27_790_000, 23_010_000),
                800_000,
            ),
            (
                "minimal:024:cout:1",
                NET_COUT_DAMPED,
                "F.Cu",
                PointNm(27_790_000, 23_010_000),
                PointNm(27_790_000, 26_000_000),
                800_000,
            ),
            (
                "minimal:115:gnd-c3-front",
                NET_GND,
                "F.Cu",
                PointNm(30_710_000, 26_000_000),
                PointNm(30_710_000, 28_000_000),
                400_000,
            ),
            (
                "minimal:116:gnd-c3-back",
                NET_GND,
                "B.Cu",
                PointNm(30_710_000, 25_000_000),
                PointNm(30_710_000, 28_000_000),
                400_000,
            ),
        }
        and (
            vias_by_id["minimal-via:13:gnd-c3"].net_id,
            vias_by_id["minimal-via:13:gnd-c3"].center,
            vias_by_id["minimal-via:13:gnd-c3"].diameter_nm,
            vias_by_id["minimal-via:13:gnd-c3"].drill_nm,
            vias_by_id["minimal-via:13:gnd-c3"].layers,
        )
        == (
            NET_GND,
            PointNm(30_710_000, 28_000_000),
            700_000,
            300_000,
            ("B.Cu", "F.Cu"),
        ),
        "route-a-output-network",
    )

    via_smd_receipt = _via_smd_clearance_receipt(graph)
    _require(
        len(via_smd_receipt) == FROZEN_ROUTE_VIA_COUNT,
        "no-via-in-smd-copper",
    )
    _require(
        {
            (
                via.via_id,
                via.net_id,
                via.center.x,
                via.center.y,
                via.diameter_nm,
                via.drill_nm,
                via.layers,
            )
            for via in graph.vias
            if via.via_id in {item[0] for item in _U2_THERMAL_VIAS}
        }
        == {
            (via_id, NET_GND, x_nm, y_nm, 700_000, 300_000, ("B.Cu", "F.Cu"))
            for via_id, x_nm, y_nm in _U2_THERMAL_VIAS
        },
        "u2-external-thermal-vias",
    )
    _require(
        {
            (track.track_id, track.net_id, track.layer, track.start, track.end, track.width_nm)
            for track in graph.tracks
            if track.track_id
            in {
                "minimal:079:gnd-u2-left-spine",
                "minimal:080:gnd-u2-right-spine",
                "minimal:113:gnd-u2-left",
                "minimal:114:gnd-u2-right",
            }
        }
        == {
            (
                "minimal:079:gnd-u2-left-spine",
                NET_GND,
                "B.Cu",
                PointNm(27_200_000, 14_100_000),
                PointNm(27_200_000, 25_000_000),
                800_000,
            ),
            (
                "minimal:080:gnd-u2-right-spine",
                NET_GND,
                "B.Cu",
                PointNm(28_800_000, 14_100_000),
                PointNm(28_800_000, 25_000_000),
                800_000,
            ),
            (
                "minimal:113:gnd-u2-left",
                NET_GND,
                "F.Cu",
                PointNm(27_200_000, 12_700_000),
                PointNm(27_200_000, 14_100_000),
                800_000,
            ),
            (
                "minimal:114:gnd-u2-right",
                NET_GND,
                "F.Cu",
                PointNm(28_800_000, 12_700_000),
                PointNm(28_800_000, 14_100_000),
                800_000,
            ),
        },
        "u2-external-thermal-paths",
    )

    pads_by_id = {pad.pad_id: pad for pad in graph.pads}
    topologies: dict[str, dict[_RouteNode, frozenset[_RouteNode]]] = {}
    atomic_edge_count = 0
    for net_id in ROUTE_NET_ORDER:
        topology, net_atomic_edges = _split_route_topology(
            graph.tracks,
            graph.vias,
            net_id,
            (pad.center for pad in graph.pads if pad.net_id == net_id),
        )
        topologies[net_id] = topology
        atomic_edge_count += net_atomic_edges
    _require(
        atomic_edge_count > len(graph.tracks),
        "split-tee-topology-without-same-net-overlap",
    )

    u2_output = _route_node("F.Cu", pads_by_id["pad:ldo-u2:3:0"].center)
    r9_rail = _route_node("F.Cu", pads_by_id["pad:cout-esr-r9:1:0"].center)
    r9_cout = _route_node("F.Cu", pads_by_id["pad:cout-esr-r9:2:0"].center)
    c3_positive = _route_node("F.Cu", pads_by_id["pad:cout-c3:1:0"].center)
    j2_output = _route_node("F.Cu", pads_by_id["pad:out-j2:1:0"].center)
    tp3 = _route_node("F.Cu", pads_by_id["pad:tp-3:1:0"].center)
    rail_topology = topologies[NET_3V3]
    cout_topology = topologies[NET_COUT_DAMPED]
    _require(
        len(rail_topology.get(r9_rail, ())) == 1
        and len(cout_topology.get(r9_cout, ())) == 1
        and len(cout_topology.get(c3_positive, ())) == 1
        and _route_path_exists(cout_topology, r9_cout, c3_positive),
        "r9-cout-branch-only",
    )
    _require(
        _route_path_exists(
            rail_topology,
            u2_output,
            j2_output,
            forbidden=frozenset({r9_rail}),
        )
        and _route_path_exists(
            rail_topology,
            u2_output,
            tp3,
            forbidden=frozenset({r9_rail}),
        ),
        "u2-output-paths-exclude-r9",
    )

    _require(
        not any(
            finding.rule_id == "ALG.ROUTING.CONNECTIVITY"
            for finding in build.native_report.findings
        ),
        "thirteen-net-connectivity",
    )
    _require(
        not any(
            finding.rule_id == "ALG.ROUTING.REDUNDANT_COPPER"
            for finding in build.native_report.findings
        ),
        "no-redundant-route-copper",
    )
    production_route_report = _production_route_report(build)
    production_clearance_findings = tuple(
        finding
        for finding in production_route_report.findings
        if finding.rule_id == "GEO.COPPER.MIN_CLEARANCE"
    )
    _require(
        {finding.message for finding in production_clearance_findings}
        == set(_USB_LOCAL_EXCEPTION_MESSAGES)
        and all(
            {entity.kind for entity in finding.entities} == {"pad", "hole"}
            for finding in production_clearance_findings
        )
        and all(
            finding.rule_id in {"GEO.COPPER.MIN_CLEARANCE", "GEO.ZONE.FILL_UNVERIFIED"}
            for finding in production_route_report.findings
        ),
        "production-020-clearance-with-public-footprint-usb-exceptions",
    )
    corrected_clearances = _corrected_clearance_receipt(graph)
    _require(bool(corrected_clearances), "corrected-clearance-positive-margin")
    _require(
        {
            (
                finding.rule_id,
                finding.severity.value,
                tuple((entity.kind, entity.entity_id) for entity in finding.entities),
            )
            for finding in build.native_report.findings
        }
        == {
            (
                "GEO.ZONE.FILL_UNVERIFIED",
                "warning",
                (("zone", "zone-intent:gnd:bcu-full-board"),),
            )
        },
        "native-unfilled-zone-warning-only",
    )
    _require(
        {(zone.zone_id, zone.net_id, zone.layer, zone.fill_state.value) for zone in graph.zones}
        == {FROZEN_ROUTE_ZONE_INTENT},
        "ground-zone-unfilled-intent",
    )
    checks.extend(
        (
            "frozen-route-population",
            "frozen-route-hash",
            "frozen-route-metrics",
            "thirteen-route-tree-subjects",
            "route-default-width-order",
            "minimum-authored-track-width",
            "enumerated-030-power-throats",
            "power-trunks-080",
            "cout-entirely-080",
            "route-a-output-network",
            "no-via-in-smd-copper",
            "u2-external-thermal-vias",
            "u2-external-thermal-paths",
            "split-tee-topology-without-same-net-overlap",
            "r9-cout-branch-only",
            "u2-output-paths-exclude-r9",
            "thirteen-net-connectivity",
            "no-redundant-route-copper",
            "production-020-clearance-with-public-footprint-usb-exceptions",
            "corrected-clearance-positive-margin",
            "native-unfilled-zone-warning-only",
            "ground-zone-unfilled-intent",
        )
    )

    # Evidence/BOM parity has both source identity and subject coverage.
    source_set = sources()
    source_ids = {source.evidence_id for source in source_set}
    _require(len(source_ids) == len(source_set), "source-identity-unique")
    _require(
        all(
            len(source.sha256) == 64
            and source.sha256 == source.sha256.lower()
            and all(character in "0123456789abcdef" for character in source.sha256)
            for source in source_set
        ),
        "source-digest-format",
    )
    _require(verify_manifest() == (), "source-evidence-manifest")
    _require("src-usb-type-c-r25" in source_ids, "usb-if-r25-source")
    _require(
        "src-ap2112" not in source_ids
        and {
            "src-kemet-c0g-family",
            "src-kemet-c1206c104",
            "src-kemet-t59x",
            "src-ti-lp38692-datasheet",
            "src-ti-lp38692-package-materials",
            "src-ti-lp38692-product",
            "src-vishay-wslp",
            "src-vishay-wslp-product",
        }
        <= source_ids,
        "r2-live-source-inventory",
    )
    _require(
        KICAD_FOOTPRINT_COMMIT
        and len(KICAD_FOOTPRINT_COMMIT) == 40
        and bool(KICAD_LIBRARY_PROVENANCE)
        and all(len(item) == 3 and len(item[2]) == 64 for item in KICAD_LIBRARY_PROVENANCE),
        "pinned-kicad-footprint-digests",
    )
    _require(
        bool(MANUFACTURER_LAND_PROVENANCE)
        and all(len(item) == 3 and len(item[2]) == 64 for item in MANUFACTURER_LAND_PROVENANCE),
        "manufacturer-land-provenance",
    )
    fitted = bom()
    _require({line.component_id for line in fitted} == set(component_by_id), "bom-component-parity")
    _require(
        all(set(line.source_evidence_ids) <= source_ids for line in fitted), "bom-source-parity"
    )
    _require(
        all(set(item.source_evidence_ids) <= source_ids for item in constraints()),
        "constraint-source-parity",
    )
    usb_constraints = {
        item.constraint_id: item for item in constraints() if item.constraint_id.startswith("usb-")
    }
    _require(
        {"usb-mode", "usb-rd-cc1", "usb-rd-cc2"} <= set(usb_constraints)
        and all(
            "src-usb-type-c-r25" in usb_constraints[item].source_evidence_ids
            for item in ("usb-mode", "usb-rd-cc1", "usb-rd-cc2")
        ),
        "usb-if-r25-constraint-closure",
    )
    input_scope = usb_constraints.get("usb-input-scope")
    _require(
        input_scope is not None
        and (
            input_scope.minimum,
            input_scope.maximum,
            input_scope.nominal,
            input_scope.unit,
        )
        == (4_750, 5_500, 5_000, "mV")
        and {"src-usb-type-c-r25", "src-ti-usb-c-guide", "src-tps2596", "src-ptvs"}
        <= set(input_scope.source_evidence_ids)
        and "no sustained 9 V, 12 V, 19 V, or 21 V survival claim" in input_scope.statement,
        "usb-input-scope-closure",
    )
    cap_constraints = {item.constraint_id: item for item in constraints()}
    _require(
        {
            "ldo-input-effective-capacitance",
            "ldo-output-capacitance-screen",
            "ldo-output-esr-screen",
            "ldo-capacitor-production-qualification",
            "efuse-current-limit",
            "efuse-current-limit-engineering-screen",
            "efuse-dvdt-capacitance",
            "efuse-startup-slew",
            "efuse-capacitive-inrush",
            "ldo-thermal-board-qualification",
            "header-output-only",
        }
        <= set(cap_constraints)
        and (
            cap_constraints["ldo-input-effective-capacitance"].minimum,
            cap_constraints["ldo-input-effective-capacitance"].nominal,
            cap_constraints["ldo-output-capacitance-screen"].minimum,
            cap_constraints["ldo-output-capacitance-screen"].nominal,
        )
        == (1_000, 2_827, 1_000, 14_080)
        and "src-kemet-cap"
        in cap_constraints["ldo-input-effective-capacitance"].source_evidence_ids
        and "src-kemet-t59x" in cap_constraints["ldo-output-capacitance-screen"].source_evidence_ids
        and (
            cap_constraints["efuse-current-limit"].minimum,
            cap_constraints["efuse-current-limit"].nominal,
            cap_constraints["efuse-current-limit"].maximum,
        )
        == (224, 247, 269)
        and (
            cap_constraints["efuse-dvdt-capacitance"].minimum,
            cap_constraints["efuse-dvdt-capacitance"].maximum,
            cap_constraints["efuse-startup-slew"].minimum,
            cap_constraints["efuse-startup-slew"].maximum,
            cap_constraints["efuse-capacitive-inrush"].minimum,
            cap_constraints["efuse-capacitive-inrush"].maximum,
        )
        == (94_715, 105_315, 364_500, 528_900, 9_732_150, 14_121_630)
        and cap_constraints["efuse-capacitive-inrush"].unit == "nA"
        and OUTPUT_MARKING in cap_constraints["header-output-only"].statement
        and "No LM66100 or U3 is fitted" in cap_constraints["header-output-only"].statement,
        "r2-electrical-constraint-closure",
    )
    output_current = cap_constraints.get("output-current")
    _require(
        output_current is not None
        and (output_current.maximum, output_current.nominal, output_current.unit)
        == (100, 100, "mA")
        and "design target" in output_current.statement
        and "-40 C to +80 C" in output_current.statement
        and "not a production qualification" in output_current.statement,
        "output-current-target-closure",
    )
    checks.extend(
        (
            "source-identity-unique",
            "source-digest-format",
            "source-evidence-manifest",
            "usb-if-r25-source",
            "r2-live-source-inventory",
            "pinned-kicad-footprint-digests",
            "manufacturer-land-provenance",
            "bom-component-parity",
            "bom-source-parity",
            "constraint-source-parity",
            "usb-if-r25-constraint-closure",
            "usb-input-scope-closure",
            "r2-electrical-constraint-closure",
            "output-current-target-closure",
        )
    )

    electrical_calculations = electrical_calculations_for_graph(build.graph)
    electrical_calculations_hash = stable_hash(
        electrical_calculations,
        domain="flux-clone-reference-electrical-calculations-v3",
    )
    checks.append("electrical-calculations")
    implementation_hash = _implementation_hash(build)
    audit_payload: _AuditPayload = {
        "audit_version": "reference-usb-c-3v3-audit-v5",
        "graph_hash": build.graph_hash,
        "revision_hash": build.revision_hash,
        "constraints_hash": stable_hash(
            constraints(), domain="flux-clone-reference-constraints-v1"
        ),
        "sources_hash": stable_hash(source_set, domain="flux-clone-reference-sources-v1"),
        "implementation_hash": implementation_hash,
        "checker_code_hash": _checker_code_hash(),
        "evidence_receipts_hash": _evidence_receipts_hash(build),
        "electrical_calculations": electrical_calculations,
        "electrical_calculations_hash": electrical_calculations_hash,
        "route_plan_hash": FROZEN_ROUTE_PLAN_HASH,
        "route_input_hash": FROZEN_ROUTE_INPUT_HASH,
        "route_provenance": "frozen-authored-route-not-human-reviewed",
        "route_review_hash": FROZEN_ROUTE_REVIEW_HASH,
        "analog_bias_proof_hash": build.analog_bias_proof_hash,
        "passed_check_ids": tuple(sorted(checks)),
        "blocking_findings": (),
    }
    return BoardAudit(
        **audit_payload,
        audit_hash=stable_hash(audit_payload, domain="flux-clone-reference-board-audit-v4"),
    )


__all__ = ("audit_reference_board", "electrical_calculations_for_graph")

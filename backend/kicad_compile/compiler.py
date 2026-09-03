"""Fail-closed, deterministic lowering from canonical ECAD state to KiCad 10 bytes."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

from backend.design_kernel import (
    Component,
    DesignGraph,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    PinRef,
    validate_graph,
)
from backend.design_kernel import (
    PointNm as DesignPoint,
)
from backend.design_kernel import (
    SchematicWire as DesignWire,
)
from backend.kicad_io import (
    Board,
    DiagnosticConstruct,
    DiagnosticDisposition,
    DiagnosticsManifest,
    Footprint,
    Layer,
    OutlineEdge,
    Pad,
    PadKind,
    PadShape,
    PointNm,
    Segment,
    ViaKind,
    Zone,
    canonical_net_id,
    export_board,
    import_board,
)
from backend.kicad_io import (
    Net as KiCadNet,
)
from backend.kicad_io import (
    UnsupportedPolicy as BoardUnsupportedPolicy,
)
from backend.kicad_io import (
    Via as KiCadVia,
)
from backend.kicad_io.sexpr import (
    SExpr,
    atom,
    canonical_text,
    head,
    node,
    parse,
    quoted,
    render,
    scalar_text,
)
from backend.kicad_project import (
    BundleLimits,
    HermeticProjectLibraries,
    ProjectAuxiliaryFile,
    ProjectBundleInput,
    parse_hermetic_project_libraries,
    parse_project_manifest,
    parse_schematic,
)
from backend.kicad_project.model import (
    DiagnosticDisposition as ProjectDiagnosticDisposition,
)
from backend.kicad_project.model import ProjectDiagnostic, ProjectManifest, Schematic

from .human_schematic import (
    HumanEmissionBinding,
    HumanSchematicEmission,
    HumanSchematicError,
    HumanSchematicPlan,
    SymbolSource,
    default_symbol_catalog,
    emit_human_schematic,
    plan_r2_human_schematic,
    verify_human_schematic_emission,
)
from .model import (
    CompilationBlockedError,
    CompilationBlocker,
    CompilationManifest,
    CompilationParityError,
    CompilationVerification,
    CompiledProject,
    FileDigest,
    IdentityBinding,
)

if TYPE_CHECKING:
    from .reference_r2 import R2CompilationProfile

COMPILER_ID = "flux-clone-canonical-kicad-compiler"
COMPILER_VERSION = "4.0.0"
_GENERIC_UUID_POLICY_VERSION = "3.0.0"
_R2_PROJECT_ID = "reference-usb-c-3v3-r2"
_SCHEMATIC_VERSION = 20250114
_BOARD_VERSION = 20241229
_UUID_NAMESPACE = uuid.UUID("be47dd87-d43e-5d4f-a7ee-b0db1bcc77b9")
_INNER_LAYER = re.compile(r"In([1-9]|[12][0-9]|30)\.Cu")
_ELECTRICAL_TYPES = frozenset(
    {
        "input",
        "output",
        "bidirectional",
        "tri_state",
        "passive",
        "free",
        "unspecified",
        "power_in",
        "power_out",
        "open_collector",
        "open_emitter",
        "no_connect",
    }
)
_GRID_NM = 2_540_000
_SILK_WIDTH_NM = 150_000
_FAB_WIDTH_NM = 100_000
_COURTYARD_WIDTH_NM = 50_000
_TEXT_SIZE_NM = 1_000_000
_TEXT_HEIGHT_NM = 1_200_000
_MIN_SILK_TEXT_SIZE_NM = 800_000
_GRAPHIC_CLEARANCE_NM = 300_000
_REFERENCE_PROJECT_ID = "reference-usb-c-3v3-r1"
_REFERENCE_GRAPH_SHA256 = "5834ec5a835cddbfe9da8b527fa576d004b7a310ef8958ed9896734cf3bcbc3c"
_REFERENCE_DDA_COMPONENT_ID = "efuse-u1"
_REFERENCE_DDA_EP_PAD_ID = "pad:efuse-u1:9:0"
_REFERENCE_DDA_APERTURE_SIZE_NM = (2_400_000, 3_100_000)
_REFERENCE_DDA_DATASHEET_SHA256 = (
    "66f6bae4494f7bfe7dfdc314e508f0291d9ca1e87265cca9b6fdfeaa5cb19fe9"
)
_REFERENCE_PTVS_COMPONENT_ID = "tvs-d1"
_REFERENCE_PTVS_PAD_IDS = frozenset({"pad:tvs-d1:1:0", "pad:tvs-d1:2:0"})
_REFERENCE_PTVS_MASK_SIZE_NM = (600_000, 1_100_000)
_REFERENCE_PTVS_PASTE_SIZE_NM = (350_000, 1_000_000)
_REFERENCE_PTVS_DATASHEET_SHA256 = (
    "dd54840b481bf99b3a1082dd08cd556e695991a1b36799e98eb43b7e890e00c1"
)

# Pinned review-table coordinates for the one released reference subject.
# Each row is (reference, text, board-x-nm, board-y-nm, global-rotation-udeg,
# text-size-nm, role). The separately pinned graph hash makes it impossible to
# apply these layout-specific marks to merely similarly named input.
_REFERENCE_REVIEW_ROWS = (
    ("J1", "J1", 8_900_000, 15_000_000, 90_000_000, 1_000_000, "reference"),
    ("U1", "U1", 17_000_000, 11_500_000, 0, 1_000_000, "reference"),
    ("U2", "U2", 28_000_000, 12_600_000, 0, 1_000_000, "reference"),
    ("D1", "D1", 10_800_000, 11_500_000, 0, 1_000_000, "reference"),
    ("D2", "D2", 34_000_000, 11_800_000, 0, 1_000_000, "reference"),
    ("R1", "R1", 9_200_000, 10_000_000, 0, 1_000_000, "reference"),
    ("R2", "R2", 8_550_000, 20_800_000, 0, 1_000_000, "reference"),
    ("R3", "R3", 22_000_000, 11_600_000, 0, 1_000_000, "reference"),
    ("R4", "R4", 21_500_000, 7_500_000, 0, 1_000_000, "reference"),
    ("R5", "R5", 24_500_000, 7_500_000, 0, 1_000_000, "reference"),
    ("R6", "R6", 14_500_000, 7_500_000, 0, 1_000_000, "reference"),
    ("R7", "R7", 17_500_000, 7_500_000, 0, 1_000_000, "reference"),
    ("R8", "R8", 37_000_000, 11_800_000, 0, 1_000_000, "reference"),
    ("C1", "C1", 12_600_000, 18_500_000, 0, 1_000_000, "reference"),
    ("C2", "C2", 25_000_000, 18_500_000, 0, 1_000_000, "reference"),
    ("C3", "C3", 31_000_000, 18_500_000, 0, 1_000_000, "reference"),
    ("J2", "J2", 47_000_000, 10_300_000, 0, 1_000_000, "reference"),
    ("TP1", "TP1", 11_000_000, 20_750_000, 0, 1_000_000, "reference"),
    ("TP2", "TP2", 23_000_000, 20_750_000, 0, 1_000_000, "reference"),
    ("TP3", "TP3", 35_000_000, 20_750_000, 0, 1_000_000, "reference"),
    ("TP4", "TP4", 42_000_000, 20_750_000, 0, 1_000_000, "reference"),
    ("D1", "K", 10_800_000, 13_100_000, 0, 800_000, "diode-cathode"),
    ("D2", "K", 31_650_000, 13_450_000, 0, 800_000, "diode-cathode"),
    ("J2", "3V3", 44_000_000, 13_730_000, 0, 800_000, "connector-rail"),
    ("J2", "GND", 44_000_000, 16_270_000, 0, 800_000, "connector-rail"),
    ("TP1", "VBUS", 11_000_000, 25_200_000, 0, 800_000, "test-point-rail"),
    ("TP2", "V5", 23_000_000, 25_200_000, 0, 800_000, "test-point-rail"),
    ("TP3", "3V3", 35_000_000, 25_200_000, 0, 800_000, "test-point-rail"),
    ("TP4", "GND", 42_000_000, 25_200_000, 0, 800_000, "test-point-rail"),
)


def _nm_atom(value: int) -> SExpr:
    """Return a KiCad decimal atom from an exact integer-nm coordinate."""

    sign = "-" if value < 0 else ""
    whole, fraction = divmod(abs(value), 1_000_000)
    if fraction == 0:
        return atom(f"{sign}{whole}")
    return atom(f"{sign}{whole}.{str(fraction).rjust(6, '0').rstrip('0')}")


def _graphic_uuid(*parts: object) -> SExpr:
    return node("uuid", atom(_uuid("review-graphic", *parts)))


def _graphic_text(
    text: str,
    position: PointNm,
    layer: str,
    size_nm: int,
    *identity: object,
    root: bool = False,
    rotation_udeg: int = 0,
) -> SExpr:
    """Create an opaque but fully digest-bound KiCad presentation text construct."""

    return node(
        "gr_text" if root else "fp_text",
        *( () if root else (atom("user"),) ),
        quoted(text),
        node(
            "at",
            _nm_atom(position.x),
            _nm_atom(position.y),
            *(() if rotation_udeg == 0 else (_nm_atom(rotation_udeg),)),
        ),
        node("layer", quoted(layer)),
        node(
            "effects",
            node(
                "font",
                node("size", _nm_atom(size_nm), _nm_atom(size_nm)),
                node("thickness", _nm_atom(_SILK_WIDTH_NM)),
            ),
        ),
        _graphic_uuid(*identity),
    )


def _graphic_line(
    start: PointNm,
    end: PointNm,
    layer: str,
    width_nm: int,
    *identity: object,
) -> SExpr:
    return node(
        "fp_line",
        node("start", _nm_atom(start.x), _nm_atom(start.y)),
        node("end", _nm_atom(end.x), _nm_atom(end.y)),
        node("stroke", node("width", _nm_atom(width_nm)), node("type", atom("default"))),
        node("layer", quoted(layer)),
        _graphic_uuid(*identity),
    )


def _rect_lines(
    left: int,
    top: int,
    right: int,
    bottom: int,
    layer: str,
    width_nm: int,
    *identity: object,
) -> tuple[SExpr, ...]:
    corners = (
        PointNm(left, top),
        PointNm(right, top),
        PointNm(right, bottom),
        PointNm(left, bottom),
    )
    return tuple(
        _graphic_line(start, end, layer, width_nm, *identity, index)
        for index, (start, end) in enumerate(
            zip(corners, corners[1:] + corners[:1], strict=True)
        )
    )


def _uuid(kind: str, *parts: object) -> str:
    # UUID continuity is a separate compatibility contract from compiler
    # evidence/versioning.  V4 preserves all generic-v3 project identities.
    text = "\x1f".join(
        (
            COMPILER_ID,
            _GENERIC_UUID_POLICY_VERSION,
            kind,
            *(str(item) for item in parts),
        )
    )
    return str(uuid.uuid5(_UUID_NAMESPACE, text))


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _to_point(point: DesignPoint) -> PointNm:
    return PointNm(point.x, point.y)


def _layer_sort_key(layer: str) -> tuple[int, int, str]:
    if layer == "F.Cu":
        return (0, 0, layer)
    match = _INNER_LAYER.fullmatch(layer)
    if match is not None:
        return (1, int(match.group(1)), layer)
    if layer == "B.Cu":
        return (2, 31, layer)
    return (3, 0, layer)


def _ordered_copper_layers(graph: DesignGraph) -> tuple[str, ...]:
    return tuple(sorted(graph.layers, key=_layer_sort_key))


def _board_layers(graph: DesignGraph) -> tuple[Layer, ...]:
    copper: list[Layer] = []
    for name in _ordered_copper_layers(graph):
        if name == "F.Cu":
            ordinal = 0
        elif name == "B.Cu":
            ordinal = 2
        else:
            match = _INNER_LAYER.fullmatch(name)
            if match is None:  # pragma: no cover - preflight owns this branch
                raise CompilationParityError(f"unreviewed copper layer escaped preflight: {name}")
            ordinal = 2 + 2 * int(match.group(1))
        copper.append(Layer(ordinal, name, "signal"))
    return (
        *copper,
        Layer(13, "F.Paste", "user"),
        Layer(15, "B.Paste", "user"),
        Layer(5, "F.SilkS", "user", "F.Silkscreen"),
        Layer(7, "B.SilkS", "user", "B.Silkscreen"),
        Layer(1, "F.Mask", "user"),
        Layer(3, "B.Mask", "user"),
        Layer(25, "Edge.Cuts", "user"),
        Layer(31, "F.CrtYd", "user", "F.Courtyard"),
        Layer(35, "F.Fab", "user"),
    )


def _blockers(graph: DesignGraph) -> tuple[CompilationBlocker, ...]:
    blockers: list[CompilationBlocker] = []
    if not graph.board_outline:
        blockers.append(
            CompilationBlocker(
                "board-outline-required",
                graph.project_id,
                "the reviewed KiCad board subset requires one closed polygon outline",
            )
        )
    layer_set = set(graph.layers)
    if "F.Cu" not in layer_set or "B.Cu" not in layer_set:
        blockers.append(
            CompilationBlocker(
                "outer-copper-layers-required",
                graph.project_id,
                "compiled boards require explicit F.Cu and B.Cu outer layers",
            )
        )
    for layer in graph.layers:
        if layer not in {"F.Cu", "B.Cu"} and _INNER_LAYER.fullmatch(layer) is None:
            blockers.append(
                CompilationBlocker(
                    "copper-layer-name-unsupported",
                    layer,
                    "only F.Cu, B.Cu, and KiCad In1.Cu..In30.Cu names are reviewed",
                )
            )
    if len(graph.layers) > 32:
        blockers.append(
            CompilationBlocker(
                "copper-layer-count-unsupported",
                graph.project_id,
                "KiCad layer lowering supports at most 32 copper layers",
            )
        )

    placements = {item.component_id: item for item in graph.placements}
    pins_to_net = {
        member: net.net_id for net in graph.nets for member in net.members
    }
    pads_by_component: dict[str, list[FootprintPad]] = defaultdict(list)
    for pad in graph.pads:
        pads_by_component[pad.component_id].append(pad)

    if len(graph.components) > 4096:
        blockers.append(
            CompilationBlocker(
                "schematic-symbol-capacity-exceeded",
                graph.project_id,
                "the deterministic single-sheet symbol planner permits at most 4096 components",
            )
        )
    if sum(len(item.pins) for item in graph.components) > 100_000:
        blockers.append(
            CompilationBlocker(
                "schematic-pin-capacity-exceeded",
                graph.project_id,
                "the bounded single-sheet compiler permits at most 100000 logical pins",
            )
        )
    for component in graph.components:
        placement = placements.get(component.component_id)
        if placement is None:
            blockers.append(
                CompilationBlocker(
                    "component-placement-required",
                    component.component_id,
                    "every emitted schematic symbol requires one corresponding PCB footprint",
                )
            )
        elif placement.side != "front":
            blockers.append(
                CompilationBlocker(
                    "back-side-transform-unsupported",
                    component.component_id,
                    "mirrored footprint-local transforms are not yet part of this "
                    "compiler contract",
                )
            )
        elif placement.rotation_udeg % 90_000_000:
            blockers.append(
                CompilationBlocker(
                    "non-quarter-placement-unsupported",
                    component.component_id,
                    "integer-nanometre inverse placement requires an exact quarter turn",
                )
            )
        if any(pin.electrical_type not in _ELECTRICAL_TYPES for pin in component.pins):
            blockers.append(
                CompilationBlocker(
                    "pin-electrical-type-unsupported",
                    component.component_id,
                    "all pins must use a reviewed KiCad electrical type",
                )
            )
        logical_numbers = {pin.pad_number for pin in component.pins}
        emitted_numbers = {pad.pad_number for pad in pads_by_component[component.component_id]}
        missing = sorted(logical_numbers - emitted_numbers)
        if missing:
            blockers.append(
                CompilationBlocker(
                    "logical-pin-pad-missing",
                    component.component_id,
                    "physical copper is missing for logical pad number(s): " + ", ".join(missing),
                )
            )
        for pin in component.pins:
            if pin.required and PinRef(component.component_id, pin.number) not in pins_to_net:
                blockers.append(
                    CompilationBlocker(
                        "required-pin-unconnected",
                        f"{component.component_id}:{pin.number}",
                        "required logical pins must belong to a named canonical net",
                    )
                )

    holes_by_pad: dict[str, list[FootprintHole]] = defaultdict(list)
    for hole in graph.holes:
        if hole.plated:
            assert hole.pad_id is not None
            holes_by_pad[hole.pad_id].append(hole)
    for pad in graph.pads:
        placement = placements[pad.component_id]
        local_rotation = (pad.rotation_udeg - placement.rotation_udeg) % 360_000_000
        if local_rotation % 90_000_000:
            blockers.append(
                CompilationBlocker(
                    "non-quarter-pad-rotation-unsupported",
                    pad.pad_id,
                    "integer-nanometre pad transforms require an exact quarter turn",
                )
            )
        if pad.drill_x_nm:
            paired = holes_by_pad.get(pad.pad_id, [])
            if len(paired) != 1:
                blockers.append(
                    CompilationBlocker(
                        "plated-hole-binding-required",
                        pad.pad_id,
                        "each drilled copper pad must bind exactly one plated hole record",
                    )
                )
            relative_drill = (pad.drill_rotation_udeg - pad.rotation_udeg) % 180_000_000
            if pad.drill_is_slot and relative_drill not in {0, 90_000_000}:
                blockers.append(
                    CompilationBlocker(
                        "independent-slot-angle-unsupported",
                        pad.pad_id,
                        "KiCad pad drills can align with or be perpendicular to the pad axis only",
                    )
                )
            if set(pad.layers) != layer_set:
                blockers.append(
                    CompilationBlocker(
                        "partial-span-plated-pad-unsupported",
                        pad.pad_id,
                        "through-hole pads must span the complete canonical copper stack",
                    )
                )
        else:
            if len(pad.layers) != 1 or pad.layers[0] != "F.Cu":
                blockers.append(
                    CompilationBlocker(
                        "front-smd-layer-unsupported",
                        pad.pad_id,
                        "front-side SMD pads must occupy exactly F.Cu",
                    )
                )
            if holes_by_pad.get(pad.pad_id):
                blockers.append(
                    CompilationBlocker(
                        "plated-hole-without-pad-drill",
                        pad.pad_id,
                        "a plated-hole record cannot bind an undrilled pad",
                    )
                )
    for hole in graph.holes:
        if hole.plated and hole.pad_id is not None:
            pad = next((item for item in graph.pads if item.pad_id == hole.pad_id), None)
            if pad is not None and hole.locked != pad.locked:
                blockers.append(
                    CompilationBlocker(
                        "independent-hole-lock-unsupported",
                        hole.hole_id,
                        "a plated hole and its KiCad pad must share one lock state",
                    )
                )

    for zone in graph.zones:
        if zone.priority:
            blockers.append(
                CompilationBlocker(
                    "zone-priority-unsupported",
                    zone.zone_id,
                    "the reviewed KiCad Zone IR does not model zone priority",
                )
            )
        if zone.locked:
            blockers.append(
                CompilationBlocker(
                    "zone-lock-unsupported",
                    zone.zone_id,
                    "the reviewed KiCad Zone IR does not model locked state",
                )
            )
    wires_by_net: dict[str, list[DesignWire]] = defaultdict(list)
    for wire in graph.schematic_wires:
        wires_by_net[wire.net_id].append(wire)
        if wire.sheet_id != "root":
            blockers.append(
                CompilationBlocker(
                    "schematic-hierarchy-unsupported",
                    wire.wire_id,
                    "only the canonical root sheet is compiled",
                )
            )
        if wire.locked:
            blockers.append(
                CompilationBlocker(
                    "schematic-wire-lock-unsupported",
                    wire.wire_id,
                    "KiCad schematic wire lock state is not modeled by the strict parser",
                )
            )
    for junction in graph.schematic_junctions:
        if junction.sheet_id != "root":
            blockers.append(
                CompilationBlocker(
                    "schematic-hierarchy-unsupported",
                    junction.junction_id,
                    "only the canonical root sheet is compiled",
                )
            )
        if junction.locked:
            blockers.append(
                CompilationBlocker(
                    "schematic-junction-lock-unsupported",
                    junction.junction_id,
                    "KiCad schematic junction lock state is not modeled by the strict parser",
                )
            )
    for net in graph.nets:
        if not net.members and not wires_by_net[net.net_id]:
            blockers.append(
                CompilationBlocker(
                    "net-schematic-anchor-required",
                    net.net_id,
                    "every PCB net needs a logical pin or schematic wire anchor",
                )
            )

    wire_parts = _wire_parts(graph)
    flat_parts = tuple(
        (wire.net_id, target, start, end)
        for wire in graph.schematic_wires
        for target, start, end in wire_parts[wire.wire_id]
    )
    for index, (first_net, first_id, first_start, first_end) in enumerate(flat_parts):
        for second_net, second_id, second_start, second_end in flat_parts[index + 1 :]:
            if not _segments_intersect(
                first_start,
                first_end,
                second_start,
                second_end,
            ):
                continue
            shared = {first_start, first_end} & {second_start, second_end}
            if not shared:
                blockers.append(
                    CompilationBlocker(
                        "schematic-wire-intersection-unsupported",
                        f"{first_id}:{second_id}",
                        "the strict schematic codec requires crossings and mid-segment "
                        "joins to be remodeled explicitly",
                    )
                )
            elif first_net != second_net:
                blockers.append(
                    CompilationBlocker(
                        "schematic-net-contact-conflict",
                        f"{first_id}:{second_id}",
                        "wire segments on different nets cannot share an endpoint",
                    )
                )
    incidence: dict[DesignPoint, set[str]] = defaultdict(set)
    for _, target, start, end in flat_parts:
        incidence[start].add(target)
        incidence[end].add(target)
    explicit_junctions = {item.position for item in graph.schematic_junctions}
    for point, wire_ids in incidence.items():
        if len(wire_ids) >= 3 and point not in explicit_junctions:
            blockers.append(
                CompilationBlocker(
                    "schematic-junction-required",
                    f"{point.x}:{point.y}",
                    "three-or-more-way joins require an explicit canonical junction",
                )
            )

    definitions: dict[str, tuple[tuple[str, str, str], ...]] = {}
    for component in graph.components:
        definition = tuple(
            sorted((pin.number, pin.name, pin.electrical_type) for pin in component.pins)
        )
        prior = definitions.setdefault(component.symbol_id, definition)
        if prior != definition:
            blockers.append(
                CompilationBlocker(
                    "symbol-library-definition-conflict",
                    component.symbol_id,
                    "components sharing a symbol ID must have identical pin definitions",
                )
            )
    return tuple(sorted(set(blockers)))


def _board_to_local(point: DesignPoint, origin: DesignPoint, rotation_udeg: int) -> PointNm:
    x = point.x - origin.x
    y = point.y - origin.y
    quarter = (rotation_udeg // 90_000_000) % 4
    if quarter == 0:
        local_x, local_y = x, y
    elif quarter == 1:
        local_x, local_y = -y, x
    elif quarter == 2:
        local_x, local_y = -x, -y
    else:
        local_x, local_y = y, -x
    return PointNm(local_x, local_y)


def _local_to_board(point: PointNm, origin: DesignPoint, rotation_udeg: int) -> PointNm:
    """The exact inverse of :func:`_board_to_local` for supported quarter turns."""

    quarter = (rotation_udeg // 90_000_000) % 4
    if quarter == 0:
        x, y = point.x, point.y
    elif quarter == 1:
        x, y = point.y, -point.x
    elif quarter == 2:
        x, y = -point.x, -point.y
    else:
        x, y = -point.y, point.x
    return PointNm(origin.x + x, origin.y + y)


def _pad_bounds(
    pads: tuple[Pad, ...],
    footprint_rotation_udeg: int = 0,
) -> tuple[int, int, int, int]:
    """Conservative exact local bounds. Quarter turns keep every bound integral."""

    if not pads:
        return (-500_000, -500_000, 500_000, 500_000)
    extents: list[tuple[int, int, int, int]] = []
    for pad in pads:
        half_x, half_y = pad.size_x_nm // 2, pad.size_y_nm // 2
        relative_rotation = (
            pad.rotation_udeg - footprint_rotation_udeg
        ) % 360_000_000
        if (relative_rotation // 90_000_000) % 2:
            half_x, half_y = half_y, half_x
        extents.append(
            (
                pad.position.x - half_x,
                pad.position.y - half_y,
                pad.position.x + half_x,
                pad.position.y + half_y,
            )
        )
    return (
        min(item[0] for item in extents),
        min(item[1] for item in extents),
        max(item[2] for item in extents),
        max(item[3] for item in extents),
    )


def _world_box(
    local_box: tuple[int, int, int, int],
    origin: DesignPoint,
    rotation_udeg: int,
) -> tuple[int, int, int, int]:
    left, top, right, bottom = local_box
    corners = tuple(
        _local_to_board(PointNm(x, y), origin, rotation_udeg)
        for x, y in ((left, top), (right, top), (right, bottom), (left, bottom))
    )
    return (
        min(item.x for item in corners),
        min(item.y for item in corners),
        max(item.x for item in corners),
        max(item.y for item in corners),
    )


def _boxes_intersect(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> bool:
    return not (
        left[2] < right[0]
        or right[2] < left[0]
        or left[3] < right[1]
        or right[3] < left[1]
    )


def _expanded(box: tuple[int, int, int, int], amount_nm: int) -> tuple[int, int, int, int]:
    return (
        box[0] - amount_nm,
        box[1] - amount_nm,
        box[2] + amount_nm,
        box[3] + amount_nm,
    )


def _text_box(position: PointNm, text: str, size_nm: int) -> tuple[int, int, int, int]:
    # KiCad's stroke font is variable-width; this integer envelope deliberately
    # overestimates it so collision decisions do not depend on a renderer.
    half_width = max(size_nm, len(text) * size_nm * 3 // 10)
    half_height = size_nm * 3 // 5
    return (
        position.x - half_width,
        position.y - half_height,
        position.x + half_width,
        position.y + half_height,
    )


def _rotated_text_box(
    position: PointNm,
    text: str,
    size_nm: int,
    rotation_udeg: int,
) -> tuple[int, int, int, int]:
    box = _text_box(position, text, size_nm)
    if rotation_udeg % 180_000_000 == 0:
        return box
    if rotation_udeg % 90_000_000 != 0:
        raise CompilationParityError("review text rotation must be a quarter turn")
    half_width = (box[2] - box[0]) // 2
    half_height = (box[3] - box[1]) // 2
    return (
        position.x - half_height,
        position.y - half_width,
        position.x + half_height,
        position.y + half_width,
    )


def _review_box_is_clear(
    box: tuple[int, int, int, int],
    board_box: tuple[int, int, int, int],
    forbidden: tuple[tuple[int, int, int, int], ...],
    occupied: tuple[tuple[int, int, int, int], ...],
) -> bool:
    return (
        box[0] >= board_box[0] + _GRAPHIC_CLEARANCE_NM
        and box[1] >= board_box[1] + _GRAPHIC_CLEARANCE_NM
        and box[2] <= board_box[2] - _GRAPHIC_CLEARANCE_NM
        and box[3] <= board_box[3] - _GRAPHIC_CLEARANCE_NM
        and not any(_boxes_intersect(box, item) for item in forbidden)
        and not any(
            _boxes_intersect(
                box,
                _expanded(item, _GRAPHIC_CLEARANCE_NM + 1),
            )
            for item in occupied
        )
    )


def _board_bounds(graph: DesignGraph) -> tuple[int, int, int, int]:
    outline = graph.normalized().board_outline
    return (
        min(point.x for point in outline),
        min(point.y for point in outline),
        max(point.x for point in outline),
        max(point.y for point in outline),
    )


def _presentation_diagnostic(
    scope: str,
    expression: SExpr,
    occurrence: int,
) -> DiagnosticConstruct:
    text = canonical_text(expression)
    construct_head = text[1:].split(" ", 1)[0]
    return DiagnosticConstruct(
        scope,
        f"{construct_head}[{occurrence}]",
        construct_head,
        DiagnosticDisposition.PRESERVED,
        "compiler-owned review graphic is preserved outside the electrical ECAD IR",
        text,
        _sha256(text.encode("utf-8")),
    )


def _reference_profile_graphics(
    component: Component,
    footprint: Footprint,
    placement: FootprintPlacement,
    occupied_silk: list[tuple[int, int, int, int]],
    forbidden_silk: tuple[tuple[int, int, int, int], ...],
    board_box: tuple[int, int, int, int],
) -> tuple[SExpr, ...]:
    """Emit the hash-bound graphics plan for the pinned USB-C reference board."""

    left, top, right, bottom = _pad_bounds(
        footprint.pads, placement.rotation_udeg
    )
    expressions: list[SExpr] = [
        *_rect_lines(
            left - 250_000,
            top - 250_000,
            right + 250_000,
            bottom + 250_000,
            "F.Fab",
            _FAB_WIDTH_NM,
            footprint.footprint_id,
            "derived-pad-envelope-fab",
        ),
    ]
    logical_pin_one = next((pin for pin in component.pins if pin.number == "1"), None)
    if logical_pin_one is not None:
        pin_one = next(
            (pad for pad in footprint.pads if pad.number == logical_pin_one.pad_number),
            None,
        )
        if pin_one is not None:
            marker_x = left - 250_000
            marker_y = top - 250_000
            expressions.extend(
                (
                    _graphic_line(
                        PointNm(marker_x, marker_y + 600_000),
                        PointNm(marker_x, marker_y),
                        "F.Fab",
                        _FAB_WIDTH_NM,
                        footprint.footprint_id,
                        "derived-pad-envelope-pin-one-a",
                    ),
                    _graphic_line(
                        PointNm(marker_x, marker_y),
                        PointNm(marker_x + 600_000, marker_y),
                        "F.Fab",
                        _FAB_WIDTH_NM,
                        footprint.footprint_id,
                        "derived-pad-envelope-pin-one-b",
                    ),
                )
            )
    rows = tuple(item for item in _REFERENCE_REVIEW_ROWS if item[0] == component.reference)
    if not rows:
        raise CompilationBlockedError(
            (
                CompilationBlocker(
                    "reference-review-table-entry-required",
                    component.component_id,
                    "the hash-bound reference graphics table has no fitted-component entry",
                ),
            )
        )
    for _, text, x_nm, y_nm, global_rotation, size_nm, role in rows:
        layer = "F.Fab" if role == "reference" else "F.SilkS"
        if layer == "F.SilkS":
            text_box = _rotated_text_box(
                PointNm(x_nm, y_nm), text, size_nm, global_rotation
            )
            if not _review_box_is_clear(
                text_box,
                board_box,
                forbidden_silk,
                tuple(occupied_silk),
            ):
                if role == "diode-anode":
                    continue
                raise CompilationBlockedError(
                    (
                        CompilationBlocker(
                            "reference-review-clearance-required",
                            f"{component.component_id}:{role}",
                            "the source-bound required review mark does not have 0.30 mm "
                            "mask-domain and pairwise clearance",
                        ),
                    )
                )
            occupied_silk.append(text_box)
        local = _board_to_local(
            DesignPoint(x_nm, y_nm), placement.position, placement.rotation_udeg
        )
        local_rotation = (global_rotation - placement.rotation_udeg) % 360_000_000
        expressions.append(
            _graphic_text(
                text,
                local,
                layer,
                size_nm,
                footprint.footprint_id,
                role,
                text,
                rotation_udeg=local_rotation,
            )
        )
    # The source table pins KiCad-library-equivalent pin-one triangle geometry
    # for the two IC profiles. It is written as exact lines so it remains in the
    # existing bounded presentation-preservation subset.
    triangles = {
        "U1": (
            (14_135_000, 12_045_000),
            (14_615_000, 12_375_000),
            (14_375_000, 12_375_000),
        ),
        "U2": (
            (26_310_000, 13_010_000),
            (26_790_000, 13_340_000),
            (26_550_000, 13_340_000),
        ),
    }
    triangle = triangles.get(component.reference)
    if triangle is not None:
        triangle_box = (
            min(item[0] for item in triangle) - _SILK_WIDTH_NM // 2,
            min(item[1] for item in triangle) - _SILK_WIDTH_NM // 2,
            max(item[0] for item in triangle) + _SILK_WIDTH_NM // 2,
            max(item[1] for item in triangle) + _SILK_WIDTH_NM // 2,
        )
        if not _review_box_is_clear(
            triangle_box,
            board_box,
            forbidden_silk,
            tuple(occupied_silk),
        ):
            raise CompilationBlockedError(
                (
                    CompilationBlocker(
                        "reference-review-clearance-required",
                        f"{component.component_id}:pin-one",
                        "the source-bound IC pin-one mark does not have 0.30 mm "
                        "mask-domain and pairwise clearance",
                    ),
                )
            )
        occupied_silk.append(triangle_box)
        local_triangle = tuple(
            _board_to_local(DesignPoint(x_nm, y_nm), placement.position, placement.rotation_udeg)
            for x_nm, y_nm in triangle
        )
        expressions.extend(
            _graphic_line(
                start,
                end,
                "F.SilkS",
                _SILK_WIDTH_NM,
                footprint.footprint_id,
                "official-pin-one-triangle",
                index,
            )
            for index, (start, end) in enumerate(
                zip(local_triangle, local_triangle[1:] + local_triangle[:1], strict=True)
            )
        )
    return tuple(expressions)


def _component_review_graphics(
    component: Component,
    footprint: Footprint,
    placement: FootprintPlacement,
    occupied: list[tuple[int, int, int, int]],
    forbidden: tuple[tuple[int, int, int, int], ...],
    board_box: tuple[int, int, int, int],
) -> tuple[SExpr, ...]:
    """Generate deterministic documentation layers from actual emitted pad bounds.

    The graphics are deliberately presentation-only opaque KiCad constructs.
    Their canonical S-expressions are included in the diagnostics manifest, so
    a strict parse/re-emission cannot silently discard a design-review mark.
    """

    # ``FootprintPlacement`` is intentionally structural here: importing that
    # model solely for these two scalar fields would broaden the codec boundary.
    origin = placement.position
    rotation_udeg = placement.rotation_udeg
    left, top, right, bottom = _pad_bounds(
        footprint.pads, placement.rotation_udeg
    )
    fab_margin = 250_000
    expressions: list[SExpr] = [
        *_rect_lines(
            left - fab_margin,
            top - fab_margin,
            right + fab_margin,
            bottom + fab_margin,
            "F.Fab",
            _FAB_WIDTH_NM,
            footprint.footprint_id,
            "fab-body",
        ),
    ]

    # PCB pad numbers are the physical footprint identity; a schematic pin
    # number can intentionally differ, so graphics must follow ``pad_number``.
    pins_by_pad = {pin.pad_number: pin for pin in component.pins}
    logical_pin_one = next((pin for pin in component.pins if pin.number == "1"), None)
    pin_one = (
        next(
            (item for item in footprint.pads if item.number == logical_pin_one.pad_number),
            None,
        )
        if logical_pin_one is not None
        else None
    )

    # A Fab-layer pin-one corner is useful for assembly even when the package
    # has no library body. The matching SilkS ``1`` is emitted only when it can
    # be kept clear of all emitted copper/mask openings.
    if pin_one is not None:
        marker_x = left - fab_margin
        marker_y = top - fab_margin
        expressions.extend(
            (
                _graphic_line(
                    PointNm(marker_x, marker_y + 600_000),
                    PointNm(marker_x, marker_y),
                    "F.Fab",
                    _FAB_WIDTH_NM,
                    footprint.footprint_id,
                    "fab-pin-one-a",
                ),
                _graphic_line(
                    PointNm(marker_x, marker_y),
                    PointNm(marker_x + 600_000, marker_y),
                    "F.Fab",
                    _FAB_WIDTH_NM,
                    footprint.footprint_id,
                    "fab-pin-one-b",
                ),
            )
        )

    label = "J1 USB INPUT" if component.reference == "J1" else component.reference
    reference_size = (
        _MIN_SILK_TEXT_SIZE_NM if component.reference == "J1" else _TEXT_SIZE_NM
    )
    defer_reference = component.reference.startswith(("D", "TP", "U"))
    local_candidates = tuple(
        candidate
        for offset in (1_500_000, 2_300_000, 3_100_000, 3_900_000)
        for candidate in (
            PointNm((left + right) // 2, top - offset),
            PointNm((left + right) // 2, bottom + offset),
            PointNm(left - offset, (top + bottom) // 2),
            PointNm(right + offset, (top + bottom) // 2),
        )
    )
    reference_position: PointNm | None = None
    reference_emitted = False
    if not defer_reference:
        for local in local_candidates:
            candidate = _world_box(
                _text_box(local, label, reference_size), origin, rotation_udeg
            )
            clear = (
                candidate[0] >= board_box[0] + _GRAPHIC_CLEARANCE_NM
                and candidate[1] >= board_box[1] + _GRAPHIC_CLEARANCE_NM
                and candidate[2] <= board_box[2] - _GRAPHIC_CLEARANCE_NM
                and candidate[3] <= board_box[3] - _GRAPHIC_CLEARANCE_NM
                and not any(
                    _boxes_intersect(candidate, item) for item in forbidden + tuple(occupied)
                )
            )
            if clear:
                reference_position = local
                occupied.append(candidate)
                break
        if reference_position is not None:
            expressions.append(
                _graphic_text(
                    label,
                    reference_position,
                    "F.SilkS",
                    reference_size,
                    footprint.footprint_id,
                    "reference",
                )
            )
            reference_emitted = True

    pin_one_emitted = not component.reference.startswith("U")
    if pin_one is not None and component.reference.startswith("U"):
        for offset in (900_000, 1_700_000, 2_500_000, 3_300_000):
            local = PointNm(left - offset, top - offset)
            candidate = _world_box(
                _text_box(local, "1", _MIN_SILK_TEXT_SIZE_NM), origin, rotation_udeg
            )
            clear = (
                candidate[0] >= board_box[0] + _GRAPHIC_CLEARANCE_NM
                and candidate[1] >= board_box[1] + _GRAPHIC_CLEARANCE_NM
                and candidate[2] <= board_box[2] - _GRAPHIC_CLEARANCE_NM
                and candidate[3] <= board_box[3] - _GRAPHIC_CLEARANCE_NM
                and not any(
                    _boxes_intersect(candidate, item) for item in forbidden + tuple(occupied)
                )
            )
            if not clear:
                continue
            occupied.append(candidate)
            expressions.append(
                _graphic_text(
                    "1",
                    local,
                    "F.SilkS",
                    _MIN_SILK_TEXT_SIZE_NM,
                    footprint.footprint_id,
                    "silk-pin-one",
                )
            )
            pin_one_emitted = True
            break

    if component.reference.startswith("J"):
        # Connector contact labels expose the exact canonical pin names, which
        # makes 3V3/GND headers and USB signal/power contacts reviewable.
        for pad in footprint.pads:
            pin = pins_by_pad.get(pad.number)
            if pin is None:
                continue
            candidate_locals = tuple(
                candidate
                for offset in (1_500_000, 2_300_000, 3_100_000, 3_900_000)
                for candidate in (
                    PointNm(left - offset, pad.position.y),
                    PointNm(right + offset, pad.position.y),
                    PointNm(pad.position.x, top - offset),
                    PointNm(pad.position.x, bottom + offset),
                )
            )
            for local in candidate_locals:
                candidate = _world_box(
                    _text_box(local, pin.name, _MIN_SILK_TEXT_SIZE_NM),
                    origin,
                    rotation_udeg,
                )
                clear = (
                    candidate[0] >= board_box[0] + _GRAPHIC_CLEARANCE_NM
                    and candidate[1] >= board_box[1] + _GRAPHIC_CLEARANCE_NM
                    and candidate[2] <= board_box[2] - _GRAPHIC_CLEARANCE_NM
                    and candidate[3] <= board_box[3] - _GRAPHIC_CLEARANCE_NM
                    and not any(
                        _boxes_intersect(candidate, item)
                        for item in forbidden + tuple(occupied)
                    )
                )
                if not clear:
                    continue
                occupied.append(candidate)
                expressions.append(
                    _graphic_text(
                        pin.name,
                        local,
                        "F.SilkS",
                        _MIN_SILK_TEXT_SIZE_NM,
                        footprint.footprint_id,
                        "connector-pin",
                        pad.number,
                    )
                )
                break
    elif component.reference.startswith("TP") and pin_one is not None:
        # Test-point pin symbols conventionally say TEST; the fitted part value
        # is the canonical rail designation (for example VBUS_RAW or 3V3).
        rail = component.value
        rail_candidates = tuple(
            candidate
            for offset in (1_500_000, 2_300_000, 3_100_000, 3_900_000)
            for candidate in (
                PointNm(right + offset, pin_one.position.y),
                PointNm(left - offset, pin_one.position.y),
                PointNm(pin_one.position.x, top - offset),
                PointNm(pin_one.position.x, bottom + offset),
            )
        )
        rail_emitted = False
        for local in rail_candidates:
            candidate = _world_box(
                _text_box(local, rail, _MIN_SILK_TEXT_SIZE_NM), origin, rotation_udeg
            )
            clear = (
                candidate[0] >= board_box[0] + _GRAPHIC_CLEARANCE_NM
                and candidate[1] >= board_box[1] + _GRAPHIC_CLEARANCE_NM
                and candidate[2] <= board_box[2] - _GRAPHIC_CLEARANCE_NM
                and candidate[3] <= board_box[3] - _GRAPHIC_CLEARANCE_NM
                and not any(
                    _boxes_intersect(candidate, item) for item in forbidden + tuple(occupied)
                )
            )
            if not clear:
                continue
            occupied.append(candidate)
            expressions.append(
                _graphic_text(
                    rail,
                    local,
                    "F.SilkS",
                    _MIN_SILK_TEXT_SIZE_NM,
                    footprint.footprint_id,
                    "test-point-rail",
                )
            )
            rail_emitted = True
            break
        if not rail_emitted:
            raise CompilationBlockedError(
                (
                    CompilationBlocker(
                        "review-rail-label-placement-required",
                        component.component_id,
                        "test-point rail label cannot clear the reviewed front-side obstacles",
                    ),
                )
            )
    elif component.reference.startswith("D"):
        emitted_marker_kinds: set[str] = set()
        marker_pins = (
            (
                next(
                    (
                        pin
                        for pin in component.pins
                        if pin.name.casefold() in {"k", "cathode"}
                    ),
                    None,
                ),
                "K",
                "diode-cathode",
            ),
            (
                next(
                    (
                        pin
                        for pin in component.pins
                        if pin.name.casefold() in {"a", "anode"}
                    ),
                    None,
                ),
                "A",
                "diode-anode",
            ),
        )
        for marker_pin, polarity, marker_kind in marker_pins:
            pad = next(
                (
                    item
                    for item in footprint.pads
                    if marker_pin is not None and item.number == marker_pin.pad_number
                ),
                None,
            )
            if pad is None:
                continue
            candidates = tuple(
                candidate
                for offset in (900_000, 1_700_000, 2_500_000, 3_300_000)
                for candidate in (
                    PointNm(pad.position.x, top - offset),
                    PointNm(right + offset, pad.position.y),
                    PointNm(left - offset, pad.position.y),
                    PointNm(pad.position.x, bottom + offset),
                )
            )
            for local in candidates:
                candidate = _world_box(
                    _text_box(local, polarity, _MIN_SILK_TEXT_SIZE_NM),
                    origin,
                    rotation_udeg,
                )
                clear = (
                    candidate[0] >= board_box[0] + _GRAPHIC_CLEARANCE_NM
                    and candidate[1] >= board_box[1] + _GRAPHIC_CLEARANCE_NM
                    and candidate[2] <= board_box[2] - _GRAPHIC_CLEARANCE_NM
                    and candidate[3] <= board_box[3] - _GRAPHIC_CLEARANCE_NM
                    and not any(
                        _boxes_intersect(candidate, item)
                        for item in forbidden + tuple(occupied)
                    )
                )
                if not clear:
                    continue
                occupied.append(candidate)
                expressions.append(
                    _graphic_text(
                        polarity,
                        local,
                        "F.SilkS",
                        _MIN_SILK_TEXT_SIZE_NM,
                        footprint.footprint_id,
                        marker_kind,
                        pad.number,
                    )
                )
                emitted_marker_kinds.add(marker_kind)
                break
        required_marker_kinds = {
            kind
            for pin, _, kind in marker_pins
            if pin is not None
        }
        if emitted_marker_kinds != required_marker_kinds:
            raise CompilationBlockedError(
                (
                    CompilationBlocker(
                        "review-polarity-placement-required",
                        component.component_id,
                        "diode anode/cathode marks cannot clear the reviewed front-side obstacles",
                    ),
                )
            )
    if defer_reference:
        for local in local_candidates:
            candidate = _world_box(
                _text_box(local, label, reference_size), origin, rotation_udeg
            )
            clear = (
                candidate[0] >= board_box[0] + _GRAPHIC_CLEARANCE_NM
                and candidate[1] >= board_box[1] + _GRAPHIC_CLEARANCE_NM
                and candidate[2] <= board_box[2] - _GRAPHIC_CLEARANCE_NM
                and candidate[3] <= board_box[3] - _GRAPHIC_CLEARANCE_NM
                and not any(
                    _boxes_intersect(candidate, item) for item in forbidden + tuple(occupied)
                )
            )
            if not clear:
                continue
            occupied.append(candidate)
            expressions.append(
                _graphic_text(
                    label,
                    local,
                    "F.SilkS",
                    reference_size,
                    footprint.footprint_id,
                    "reference",
                )
            )
            reference_emitted = True
            break
    if not reference_emitted:
        raise CompilationBlockedError(
            (
                CompilationBlocker(
                    "review-reference-placement-required",
                    component.component_id,
                    "visible fitted-component reference cannot clear reviewed front-side obstacles",
                ),
            )
        )
    if not pin_one_emitted:
        raise CompilationBlockedError(
            (
                CompilationBlocker(
                    "review-pin-one-placement-required",
                    component.component_id,
                    "visible IC pin-one marker cannot clear reviewed front-side obstacles",
                ),
            )
        )
    return tuple(expressions)


def _r2_presentation_manifest(
    graph: DesignGraph,
    footprints: tuple[Footprint, ...],
    state: _R2CompilationState,
) -> tuple[DiagnosticsManifest, tuple[IdentityBinding, ...]]:
    from backend.reference_design.assembly_geometry import profile_for_component

    placements = {item.component_id: item for item in graph.placements}
    footprint_by_component = {
        component.component_id: next(
            item for item in footprints if item.reference == component.reference
        )
        for component in graph.components
    }
    entries: list[DiagnosticConstruct] = []
    bindings: list[IdentityBinding] = []
    occurrences: dict[tuple[str, str], int] = defaultdict(int)

    plan_placements = {item.component_id: item for item in state.plan.placements}
    for component in sorted(graph.components, key=lambda item: item.component_id):
        footprint = footprint_by_component[component.component_id]
        for record in plan_placements[component.component_id].properties:
            if record.name in {"Reference", "Value"}:
                continue
            property_id = _uuid(
                "r2-footprint-property",
                component.component_id,
                record.name,
            )
            value = (
                _local_footprint_link(component)
                if record.name == "Footprint"
                else record.value
            )
            expression = node(
                "property",
                quoted(record.name),
                quoted(value),
                node("at", atom("0"), atom("0"), atom("0")),
                node("layer", quoted("F.Fab")),
                node("hide", atom("yes")),
                node("uuid", quoted(property_id)),
                node(
                    "effects",
                    node(
                        "font",
                        node("size", atom("1"), atom("1")),
                        node("thickness", atom("0.15")),
                    ),
                ),
            )
            scope = f"footprint:{footprint.footprint_id}"
            occurrence = occurrences[(scope, "property")]
            entries.append(_presentation_diagnostic(scope, expression, occurrence))
            occurrences[(scope, "property")] = occurrence + 1
            bindings.append(
                IdentityBinding(
                    "property",
                    record.semantic_id,
                    "pcb-footprint-property",
                    (property_id,),
                )
            )

    for record in (*state.profile.fab_records, *state.profile.courtyard_records):
        footprint = footprint_by_component[record.component_id]
        placement = placements[record.component_id]
        source_profile = profile_for_component(record.component_id, record.footprint_id)
        outline = (
            source_profile.fab_outline
            if record.layer == "F.Fab"
            else source_profile.courtyard_outline
        )
        local_vertices = tuple(
            _board_to_local(
                DesignPoint(x_nm, y_nm),
                placement.position,
                placement.rotation_udeg,
            )
            for x_nm, y_nm in record.vertices_nm
        )
        graphic_ids: list[str] = []
        scope = f"footprint:{footprint.footprint_id}"
        for index, (start, end) in enumerate(
            zip(local_vertices, local_vertices[1:], strict=False)
        ):
            graphic_id = _uuid(
                "review-graphic",
                footprint.footprint_id,
                "r2-assembly",
                record.profile_id,
                record.layer,
                index,
            )
            expression = _graphic_line(
                start,
                end,
                record.layer,
                outline.stroke_nm,
                footprint.footprint_id,
                "r2-assembly",
                record.profile_id,
                record.layer,
                index,
            )
            graphic_ids.append(graphic_id)
            occurrence = occurrences[(scope, "fp_line")]
            entries.append(_presentation_diagnostic(scope, expression, occurrence))
            occurrences[(scope, "fp_line")] = occurrence + 1
        sources = tuple(
            sorted(
                f"source-sha256:{item.sha256}" for item in source_profile.sources
            )
        )
        bindings.append(
            IdentityBinding(
                "r2-assembly-profile",
                f"{record.component_id}:{record.profile_id}:{record.layer}",
                "pcb-footprint-graphics",
                tuple(sorted((*graphic_ids, *sources, f"status:{record.dimension_status}"))),
            )
        )

    for model in state.profile.emitted_model_records:
        footprint = footprint_by_component[model.component_id]
        if model.kicad_reference is None or model.model_sha256 is None:
            raise CompilationParityError("R2 emitted model record is incomplete")
        expression = node(
            "model",
            quoted(model.kicad_reference),
            node("offset", node("xyz", atom("0"), atom("0"), atom("0"))),
            node("scale", node("xyz", atom("1"), atom("1"), atom("1"))),
            node("rotate", node("xyz", atom("0"), atom("0"), atom("0"))),
        )
        scope = f"footprint:{footprint.footprint_id}"
        occurrence = occurrences[(scope, "model")]
        entries.append(_presentation_diagnostic(scope, expression, occurrence))
        occurrences[(scope, "model")] = occurrence + 1
        bindings.append(
            IdentityBinding(
                "r2-3d-model",
                model.component_id,
                "pcb-3d-model-reference",
                tuple(
                    sorted(
                        (
                            model.kicad_reference,
                            f"model-sha256:{model.model_sha256}",
                            f"confidence:{model.confidence}",
                        )
                    )
                ),
            )
        )
    for model in state.profile.omitted_model_records:
        if not model.omission_reason:
            raise CompilationParityError("R2 omitted model record lacks its reason")
        bindings.append(
            IdentityBinding(
                "r2-3d-model-omission",
                model.component_id,
                "not-emitted",
                (
                    "not-emitted",
                    f"reason-sha256:{_sha256(model.omission_reason.encode('utf-8'))}",
                ),
            )
        )

    root_occurrence: dict[str, int] = defaultdict(int)
    for record in state.profile.silkscreen_records:
        expression = parse(record.kicad.encode("utf-8"))
        if not isinstance(expression, tuple) or head(expression) not in {
            "gr_text",
            "gr_line",
        }:
            raise CompilationParityError("R2 silkscreen record has invalid KiCad syntax")
        graphic_id = _uuid("r2-silkscreen", record.identifier)
        expression = (*expression, node("uuid", quoted(graphic_id)))
        expression_head = head(expression)
        assert expression_head is not None
        occurrence = root_occurrence[expression_head]
        entries.append(_presentation_diagnostic("root", expression, occurrence))
        root_occurrence[expression_head] = occurrence + 1
        bindings.append(
            IdentityBinding(
                "r2-silkscreen-primitive",
                record.identifier,
                "pcb-root-graphic",
                (graphic_id,),
            )
        )
    bindings.append(
        IdentityBinding(
            "r2-compilation-profile",
            state.profile.evidence.profile_id,
            "profile-evidence",
            (state.profile.evidence.aggregate_sha256,),
        )
    )
    return DiagnosticsManifest(tuple(entries)).normalized(), tuple(sorted(bindings))


def _presentation_manifest(
    graph: DesignGraph, footprints: tuple[Footprint, ...]
) -> DiagnosticsManifest:
    """Bind every compiler-generated visual construct to exact preserved syntax."""

    is_reference_subject = graph.project_id == _REFERENCE_PROJECT_ID
    if is_reference_subject and graph.graph_hash != _REFERENCE_GRAPH_SHA256:
        raise CompilationBlockedError(
            (
                CompilationBlocker(
                    "reference-review-source-hash-required",
                    graph.project_id,
                    "the pinned reference graphics table cannot be applied to a changed graph",
                ),
            )
        )
    placements = {item.component_id: item for item in graph.placements}
    by_component = {
        component.component_id: next(
            footprint
            for footprint in footprints
            if footprint.reference == component.reference
        )
        for component in graph.components
    }
    board_box = _board_bounds(graph)
    forbidden: list[tuple[int, int, int, int]] = []
    for pad in graph.pads:
        if pad.rotation_udeg % 180_000_000:
            width, height = pad.size_y_nm, pad.size_x_nm
        else:
            width, height = pad.size_x_nm, pad.size_y_nm
        forbidden.append(
            _expanded(
                (
                    pad.center.x - width // 2,
                    pad.center.y - height // 2,
                    pad.center.x + width // 2,
                    pad.center.y + height // 2,
                ),
                _GRAPHIC_CLEARANCE_NM,
            )
        )
    for hole in graph.holes:
        if hole.plated:
            continue
        if hole.drill_rotation_udeg % 180_000_000:
            width, height = hole.drill_y_nm, hole.drill_x_nm
        else:
            width, height = hole.drill_x_nm, hole.drill_y_nm
        forbidden.append(
            _expanded(
                (
                    hole.center.x - width // 2,
                    hole.center.y - height // 2,
                    hole.center.x + width // 2,
                    hole.center.y + height // 2,
                ),
                _GRAPHIC_CLEARANCE_NM,
            )
        )
    # Covered copper is below solder mask and is not a front-silk obstacle.
    # The compiler-owned board setup tents vias on both sides, so only explicit
    # pad/mask and unplated-hole openings enter this mask-domain obstacle set.
    occupied: list[tuple[int, int, int, int]] = []
    entries: list[DiagnosticConstruct] = []
    for component in sorted(graph.components, key=lambda item: item.component_id):
        footprint = by_component[component.component_id]
        expressions = (
            _reference_profile_graphics(
                component,
                footprint,
                placements[component.component_id],
                occupied,
                tuple(forbidden),
                board_box,
            )
            if is_reference_subject
            else _component_review_graphics(
                component,
                footprint,
                placements[component.component_id],
                occupied,
                tuple(forbidden),
                board_box,
            )
        )
        occurrence: dict[str, int] = defaultdict(int)
        for expression in expressions:
            text = canonical_text(expression)
            construct_head = text[1:].split(" ", 1)[0]
            entries.append(
                _presentation_diagnostic(
                    f"footprint:{footprint.footprint_id}",
                    expression,
                    occurrence[construct_head],
                )
            )
            occurrence[construct_head] += 1

    name = graph.project_id.replace("-", " ").upper()
    title = PointNm((board_box[0] + board_box[2]) // 2, board_box[1] + 1_500_000)
    revision = PointNm((board_box[0] + board_box[2]) // 2, board_box[3] - 1_500_000)
    root_rows = [
        (name, title, _TEXT_SIZE_NM, "board-name"),
        ("REV 1", revision, _MIN_SILK_TEXT_SIZE_NM, "revision"),
    ]
    if is_reference_subject:
        root_rows.append(
            ("USB 5V IN", PointNm(4_000_000, 24_500_000), _TEXT_SIZE_NM, "usb-input")
        )
    root_graphics: list[SExpr] = []
    for text, position, size_nm, role in root_rows:
        if is_reference_subject:
            text_box = _rotated_text_box(position, text, size_nm, 0)
            if not _review_box_is_clear(
                text_box,
                board_box,
                tuple(forbidden),
                tuple(occupied),
            ):
                raise CompilationBlockedError(
                    (
                        CompilationBlocker(
                            "reference-review-clearance-required",
                            f"{graph.project_id}:{role}",
                            "the source-bound root review mark does not have 0.30 mm "
                            "mask-domain and pairwise clearance",
                        ),
                    )
                )
            occupied.append(text_box)
        root_graphics.append(
            _graphic_text(
                text,
                position,
                "F.SilkS",
                size_nm,
                graph.project_id,
                role,
                root=True,
            )
        )
    for root_index, expression in enumerate(root_graphics):
        entries.append(_presentation_diagnostic("root", expression, root_index))
    return DiagnosticsManifest(tuple(entries)).normalized()


def _unconnected_pad_nets(
    graph: DesignGraph,
) -> dict[tuple[str, str], tuple[str, str]]:
    connected = {member for net in graph.nets for member in net.members}
    result: dict[tuple[str, str], tuple[str, str]] = {}
    source_names = {net.name for net in graph.nets}
    for component in graph.components:
        for pin in component.pins:
            if PinRef(component.component_id, pin.number) in connected:
                continue
            name = (
                f"unconnected-({component.reference}-{pin.name}-Pad{pin.pad_number})"
            )
            if name in source_names:
                raise CompilationBlockedError(
                    (
                        CompilationBlocker(
                            "unconnected-net-name-collision",
                            f"{component.component_id}:{pin.number}",
                            "a canonical net name collides with KiCad's deterministic "
                            "isolated-pad net name",
                        ),
                    )
                )
            result[(component.component_id, pin.pad_number)] = (
                canonical_net_id(name),
                name,
            )
    return result


def _is_r2_subject(graph: DesignGraph) -> bool:
    if graph.project_id != _R2_PROJECT_ID:
        return False
    from .reference_r2 import R2_GRAPH_SHA256

    return graph.graph_hash == R2_GRAPH_SHA256


def _is_source_bound_reference(graph: DesignGraph) -> bool:
    return (
        graph.project_id == _REFERENCE_PROJECT_ID
        and graph.graph_hash == _REFERENCE_GRAPH_SHA256
    ) or _is_r2_subject(graph)


def _is_reference_dda_ep(graph: DesignGraph, component: Component, pad_id: str) -> bool:
    return (
        _is_source_bound_reference(graph)
        and component.component_id == _REFERENCE_DDA_COMPONENT_ID
        and component.manufacturer_part_number == "TPS259620DDAR"
        and component.datasheet_sha256 == _REFERENCE_DDA_DATASHEET_SHA256
        and pad_id == _REFERENCE_DDA_EP_PAD_ID
    )


def _reference_aperture_sizes(
    graph: DesignGraph,
    component: Component,
    pad_id: str,
) -> tuple[tuple[str, tuple[int, int]], ...]:
    if _is_reference_dda_ep(graph, component, pad_id):
        return (
            ("F.Mask", _REFERENCE_DDA_APERTURE_SIZE_NM),
            ("F.Paste", _REFERENCE_DDA_APERTURE_SIZE_NM),
        )
    if (
        _is_source_bound_reference(graph)
        and component.component_id == _REFERENCE_PTVS_COMPONENT_ID
        and component.manufacturer_part_number == "PTVS5V5Z1UPC"
        and component.datasheet_sha256 == _REFERENCE_PTVS_DATASHEET_SHA256
        and pad_id in _REFERENCE_PTVS_PAD_IDS
    ):
        return (
            ("F.Mask", _REFERENCE_PTVS_MASK_SIZE_NM),
            ("F.Paste", _REFERENCE_PTVS_PASTE_SIZE_NM),
        )
    return ()


def _build_board(
    graph: DesignGraph,
    r2_state: _R2CompilationState | None = None,
) -> tuple[Board, tuple[IdentityBinding, ...]]:
    output_net_names = {
        net.net_id: (f"/{net.name}" if r2_state is not None else net.name)
        for net in graph.nets
    }
    net_ids = {
        net.net_id: canonical_net_id(output_net_names[net.net_id])
        for net in graph.nets
    }
    unconnected_pad_nets = _unconnected_pad_nets(graph)
    placements = {item.component_id: item for item in graph.placements}
    bindings: list[IdentityBinding] = []
    if _is_source_bound_reference(graph):
        bindings.append(
            IdentityBinding(
                "fabrication-policy",
                "tps259620dda-ep-apertures",
                "source-receipt",
                tuple(
                    sorted(
                        (
                            "aperture-mask-2400000x3100000nm",
                            "aperture-paste-2400000x3100000nm-stencil-example-127000nm",
                            f"datasheet-sha256:{_REFERENCE_DDA_DATASHEET_SHA256}",
                        )
                    )
                ),
            )
        )
        bindings.append(
            IdentityBinding(
                "fabrication-policy",
                "ptvs5v5z1upc-terminal-apertures",
                "source-receipt",
                tuple(
                    sorted(
                        (
                            "aperture-mask-600000x1100000nm",
                            "aperture-paste-350000x1000000nm-stencil-example-100000nm",
                            f"datasheet-sha256:{_REFERENCE_PTVS_DATASHEET_SHA256}",
                        )
                    )
                ),
            )
        )
        bindings.append(
            IdentityBinding(
                "fabrication-policy",
                "reference-hole-clearance-layering",
                "source-receipt",
                tuple(
                    sorted(
                        (
                            "canonical-route-to-hole-minimum-200000nm",
                            f"graph-sha256:{graph.graph_hash}",
                            "native-project-min-clearance-200000nm",
                            "native-project-min-hole-clearance-150000nm",
                        )
                    )
                ),
            )
        )
    footprints: list[Footprint] = []
    for component in sorted(graph.components, key=lambda item: item.component_id):
        placement = placements[component.component_id]
        footprint_uuid = _uuid("footprint", component.component_id)
        local_footprint_link = _local_footprint_link(component)
        bindings.append(
            IdentityBinding("component", component.component_id, "pcb-footprint", (footprint_uuid,))
        )
        bindings.append(
            IdentityBinding(
                "source-footprint-library-id",
                component.footprint_id,
                "project-local-footprint-library-id",
                (local_footprint_link,),
            )
        )
        pins_by_pad = {pin.pad_number: pin for pin in component.pins}
        pads: list[Pad] = []
        component_pads = sorted(
            (item for item in graph.pads if item.component_id == component.component_id),
            key=lambda item: item.pad_id,
        )
        for source in component_pads:
            pad_uuid = _uuid("pad", source.pad_id)
            bindings.append(IdentityBinding("pad", source.pad_id, "pcb-pad", (pad_uuid,)))
            local = _board_to_local(source.center, placement.position, placement.rotation_udeg)
            # KiCad PCB pad angles are absolute/global even though pad centres
            # are footprint-local.  Subtracting the footprint rotation keeps
            # centres correct but rotates asymmetric copper into the wrong net.
            local_rotation = source.rotation_udeg
            pin = pins_by_pad[source.pad_number]
            aperture_sizes: tuple[tuple[str, tuple[int, int]], ...] = ()
            if source.drill_x_nm:
                kind = PadKind.THROUGH_HOLE
                layers = ("*.Cu", "*.Mask")
                relative_drill = (
                    source.drill_rotation_udeg - source.rotation_udeg
                ) % 180_000_000
                if relative_drill == 90_000_000:
                    drill_x, drill_y = source.drill_y_nm, source.drill_x_nm
                else:
                    drill_x, drill_y = source.drill_x_nm, source.drill_y_nm
            else:
                kind = PadKind.SMD
                aperture_sizes = _reference_aperture_sizes(
                    graph, component, source.pad_id
                )
                layers = (
                    ("F.Cu",)
                    if aperture_sizes
                    else ("F.Cu", "F.Paste", "F.Mask")
                )
                drill_x = drill_y = 0
            shape = PadShape(source.shape)
            pad_net_id = (
                net_ids[source.net_id]
                if source.net_id is not None
                else unconnected_pad_nets[(source.component_id, source.pad_number)][0]
            )
            pads.append(
                Pad(
                    pad_uuid,
                    source.pad_number,
                    kind,
                    shape,
                    local,
                    local_rotation,
                    source.size_x_nm,
                    source.size_y_nm,
                    drill_x,
                    drill_y,
                    layers,
                    pad_net_id,
                    pin.name,
                    pin.electrical_type,
                    250_000 if shape is PadShape.ROUNDRECT else None,
                    source.locked,
                )
            )
            if kind is PadKind.SMD:
                for aperture_layer, aperture_size in aperture_sizes:
                    aperture_uuid = _uuid(
                        "compiler-aperture",
                        source.pad_id,
                        aperture_layer,
                    )
                    bindings.append(
                        IdentityBinding(
                            "compiler-aperture",
                            f"{source.pad_id}:{aperture_layer}",
                            "pcb-pad",
                            (aperture_uuid,),
                        )
                    )
                    pads.append(
                        Pad(
                            aperture_uuid,
                            "",
                            PadKind.SMD,
                            PadShape.RECT,
                            local,
                            source.rotation_udeg,
                            aperture_size[0],
                            aperture_size[1],
                            0,
                            0,
                            (aperture_layer,),
                            locked=source.locked,
                        )
                    )
            if source.shared_land_group_id is not None:
                bindings.append(
                    IdentityBinding(
                        "shared-land-group",
                        source.shared_land_group_id,
                        "pcb-pad",
                        (pad_uuid,),
                    )
                )
        component_holes = sorted(
            (
                item
                for item in graph.holes
                if item.component_id == component.component_id and not item.plated
            ),
            key=lambda item: item.hole_id,
        )
        for source in component_holes:
            hole_uuid = _uuid("npth", source.hole_id)
            bindings.append(
                IdentityBinding("hole", source.hole_id, "npth-pad", (hole_uuid,))
            )
            local = _board_to_local(
                source.center,
                placement.position,
                placement.rotation_udeg,
            )
            local_rotation = source.drill_rotation_udeg
            pads.append(
                Pad(
                    hole_uuid,
                    "",
                    PadKind.NPTH,
                    (
                        PadShape.CIRCLE
                        if source.drill_x_nm == source.drill_y_nm
                        else PadShape.OVAL
                    ),
                    local,
                    local_rotation,
                    source.drill_x_nm,
                    source.drill_y_nm,
                    source.drill_x_nm,
                    source.drill_y_nm,
                    ("*.Cu", "*.Mask"),
                    locked=source.locked,
                )
            )
        attributes: tuple[str, ...]
        if pads and all(item.kind is PadKind.SMD for item in pads):
            attributes = ("smd",)
        elif pads and all(item.kind is PadKind.THROUGH_HOLE for item in pads):
            attributes = ("through_hole",)
        else:
            attributes = ()
        footprints.append(
            Footprint(
                footprint_uuid,
                local_footprint_link,
                component.reference,
                component.value,
                "F.Cu",
                _to_point(placement.position),
                placement.rotation_udeg,
                tuple(pads),
                attributes,
                placement.locked,
            )
        )

    outline = graph.normalized().board_outline
    outline_edges: list[OutlineEdge] = []
    for index, (start, end) in enumerate(
        zip(outline, outline[1:] + outline[:1], strict=True)
    ):
        edge_uuid = _uuid("outline-edge", graph.project_id, index, start.x, start.y, end.x, end.y)
        outline_edges.append(
            OutlineEdge(edge_uuid, _to_point(start), _to_point(end), 50_000)
        )
        bindings.append(
            IdentityBinding(
                "board-outline",
                f"{graph.project_id}:{index}",
                "edge-cuts-line",
                (edge_uuid,),
            )
        )
    tracks: list[Segment] = []
    for item in graph.tracks:
        target = _uuid("segment", item.track_id)
        bindings.append(IdentityBinding("track", item.track_id, "pcb-segment", (target,)))
        tracks.append(
            Segment(
                target,
                net_ids[item.net_id],
                item.layer,
                _to_point(item.start),
                _to_point(item.end),
                item.width_nm,
                item.locked,
            )
        )
    vias: list[KiCadVia] = []
    for item in graph.vias:
        target = _uuid("via", item.via_id)
        bindings.append(IdentityBinding("via", item.via_id, "pcb-via", (target,)))
        vias.append(
            KiCadVia(
                target,
                net_ids[item.net_id],
                _to_point(item.center),
                item.diameter_nm,
                item.drill_nm,
                tuple(sorted(item.layers, key=_layer_sort_key)),
                ViaKind.THROUGH,
                item.locked,
            )
        )
    zones: list[Zone] = []
    net_names = output_net_names
    for item in graph.zones:
        target = _uuid("zone", item.zone_id)
        bindings.append(IdentityBinding("zone", item.zone_id, "pcb-zone", (target,)))
        zones.append(
            Zone(
                target,
                net_ids[item.net_id],
                net_names[item.net_id],
                item.layer,
                tuple(_to_point(point) for point in item.normalized().outline),
                item.clearance_nm,
                item.min_thickness_nm,
                "edge",
                500_000,
            )
        )
    for net in graph.nets:
        bindings.append(
            IdentityBinding("net", net.net_id, "kicad-canonical-net", (net_ids[net.net_id],))
        )
    for (component_id, pad_number), (net_id, _) in sorted(
        unconnected_pad_nets.items()
    ):
        component = next(item for item in graph.components if item.component_id == component_id)
        pin = next(item for item in component.pins if item.pad_number == pad_number)
        bindings.append(
            IdentityBinding(
                "logical-pin",
                f"{component_id}:{pin.number}",
                "pcb-unconnected-net",
                (net_id,),
            )
        )
    for hole in graph.holes:
        if hole.plated:
            assert hole.pad_id is not None
            bindings.append(
                IdentityBinding(
                    "hole",
                    hole.hole_id,
                    "plated-pad-drill",
                    (_uuid("pad", hole.pad_id),),
                )
            )
    if r2_state is None:
        presentation = _presentation_manifest(graph, tuple(footprints))
        presentation_bindings: tuple[IdentityBinding, ...] = ()
    else:
        presentation, presentation_bindings = _r2_presentation_manifest(
            graph,
            tuple(footprints),
            r2_state,
        )
    bindings.extend(presentation_bindings)
    board = Board(
        _BOARD_VERSION,
        "flux_clone",
        "10.0.0",
        _board_layers(graph),
        tuple(
            [
                KiCadNet(net_ids[item.net_id], output_net_names[item.net_id])
                for item in graph.nets
            ]
            + [
                KiCadNet(net_id, name)
                for net_id, name in sorted(set(unconnected_pad_nets.values()))
            ]
        ),
        tuple(outline_edges),
        tuple(footprints),
        tuple(tracks),
        tuple(vias),
        tuple(zones),
        presentation,
    ).normalized()
    return board, _merged_bindings(bindings)


def _export_kicad10_board(board: Board) -> bytes:
    """Finalize codec IR into the exact KiCad-10 board schema used by the product."""

    normalized = board.normalized()
    expression = parse(export_board(normalized).payload)
    if not isinstance(expression, tuple) or head(expression) != "kicad_pcb":
        raise CompilationParityError("codec did not emit a KiCad PCB root")
    names_by_code = {
        str(index): net.name for index, net in enumerate(normalized.nets, start=1)
    }

    def property_rendering(footprint_id: str, property_name: str) -> tuple[SExpr, ...]:
        return (
            node("at", atom("0"), atom("0"), atom("0")),
            node("layer", quoted("F.Fab")),
            node("hide", atom("yes")),
            node(
                "uuid",
                quoted(_uuid("footprint-property", footprint_id, property_name)),
            ),
            node(
                "effects",
                node(
                    "font",
                    node("size", atom("1"), atom("1")),
                    node("thickness", atom("0.15")),
                ),
            ),
        )

    transformed_children: list[SExpr] = []
    for child in expression[1:]:
        if not isinstance(child, tuple) or head(child) != "footprint":
            transformed_children.append(child)
            continue
        footprint_uuid_node = next(
            (
                item
                for item in child[1:]
                if isinstance(item, tuple) and head(item) == "uuid"
            ),
            None,
        )
        if footprint_uuid_node is None or len(footprint_uuid_node) != 2:
            raise CompilationParityError("codec footprint omitted its deterministic UUID")
        footprint_id = scalar_text(footprint_uuid_node[1], label="footprint UUID")
        footprint_children: list[SExpr] = [child[0]]
        for footprint_child in child[1:]:
            if (
                isinstance(footprint_child, tuple)
                and head(footprint_child) == "property"
                and len(footprint_child) >= 3
            ):
                property_name = scalar_text(
                    footprint_child[1], label="footprint property name"
                )
                if property_name in {"Reference", "Value"}:
                    footprint_children.append(
                        (
                            *footprint_child[:3],
                            *property_rendering(footprint_id, property_name),
                        )
                    )
                else:
                    footprint_children.append(footprint_child)
                continue
            if not isinstance(footprint_child, tuple) or head(footprint_child) != "pad":
                footprint_children.append(footprint_child)
                continue
            if not footprint_child:
                raise CompilationParityError("codec emitted an empty pad expression")
            pad_children: list[SExpr] = [footprint_child[0]]
            for pad_child in footprint_child[1:]:
                if isinstance(pad_child, tuple) and head(pad_child) == "net":
                    if len(pad_child) != 2:
                        raise CompilationParityError(
                            "codec pad net unexpectedly contained a name before finalization"
                        )
                    code = scalar_text(pad_child[1], label="pad net code")
                    try:
                        name = names_by_code[code]
                    except KeyError as exc:
                        raise CompilationParityError(
                            f"codec pad references unknown deterministic net code: {code}"
                        ) from exc
                    pad_children.append(node("net", pad_child[1], quoted(name)))
                else:
                    pad_children.append(pad_child)
            footprint_children.append(tuple(pad_children))
        transformed_children.append(tuple(footprint_children))

    copper_layers = tuple(
        item.name
        for item in normalized.layers
        if item.kind in {"signal", "power", "mixed", "jumper"}
    )
    if set(copper_layers) == {"F.Cu", "B.Cu"} and len(copper_layers) == 2:
        general = node(
            "general",
            node("thickness", atom("0.8")),
            node("legacy_teardrops", atom("no")),
        )
        setup = node(
            "setup",
            node(
                "stackup",
                node("layer", quoted("F.SilkS"), node("type", quoted("Top Silk Screen"))),
                node("layer", quoted("F.Paste"), node("type", quoted("Top Solder Paste"))),
                node(
                    "layer",
                    quoted("F.Mask"),
                    node("type", quoted("Top Solder Mask")),
                    node("color", quoted("Green")),
                    node("thickness", atom("0.01")),
                ),
                node(
                    "layer",
                    quoted("F.Cu"),
                    node("type", quoted("copper")),
                    node("thickness", atom("0.035")),
                ),
                node(
                    "layer",
                    quoted("dielectric 1"),
                    node("type", quoted("core")),
                    node("thickness", atom("0.71")),
                    node("material", quoted("FR4")),
                    node("epsilon_r", atom("4.5")),
                    node("loss_tangent", atom("0.02")),
                ),
                node(
                    "layer",
                    quoted("B.Cu"),
                    node("type", quoted("copper")),
                    node("thickness", atom("0.035")),
                ),
                node(
                    "layer",
                    quoted("B.Mask"),
                    node("type", quoted("Bottom Solder Mask")),
                    node("color", quoted("Green")),
                    node("thickness", atom("0.01")),
                ),
                node("layer", quoted("B.Paste"), node("type", quoted("Bottom Solder Paste"))),
                node("layer", quoted("B.SilkS"), node("type", quoted("Bottom Silk Screen"))),
                node("copper_finish", quoted("ENIG")),
                node("dielectric_constraints", atom("no")),
            ),
            node("pad_to_mask_clearance", atom("0")),
            node("allow_soldermask_bridges_in_footprints", atom("no")),
            node("tenting", atom("front"), atom("back")),
        )
    else:
        raise CompilationParityError(
            "the reviewed KiCad-10 stackup finalizer currently requires exactly two copper layers"
        )

    without_metadata = [
        item
        for item in transformed_children
        if head(item) not in {"general", "paper", "setup"}
    ]
    layers_expression = next(
        (item for item in without_metadata if head(item) == "layers"), None
    )
    if not isinstance(layers_expression, tuple):
        raise CompilationParityError("codec board omitted its layer table")

    def layer_order(item: SExpr) -> tuple[int, int, str]:
        if not isinstance(item, tuple) or len(item) < 3:
            raise CompilationParityError("codec emitted a malformed layer table entry")
        name = scalar_text(item[1], label="layer name")
        if name == "F.Cu":
            return (0, 0, name)
        inner = _INNER_LAYER.fullmatch(name)
        if inner is not None:
            return (0, int(inner.group(1)), name)
        order = {
            "B.Cu": 31,
            "F.Paste": 40,
            "B.Paste": 41,
            "F.SilkS": 42,
            "B.SilkS": 43,
            "F.Mask": 44,
            "B.Mask": 45,
            "Edge.Cuts": 50,
            "F.CrtYd": 51,
            "F.Fab": 52,
        }
        return (1, order.get(name, 1_000), name)

    ordered_layers = (layers_expression[0], *sorted(layers_expression[1:], key=layer_order))
    without_metadata = [
        ordered_layers if item is layers_expression else item for item in without_metadata
    ]
    groups: dict[str, list[SExpr]] = defaultdict(list)
    for item in without_metadata:
        groups[head(item) or "atom"].append(item)
    ordered_root_children: list[SExpr] = []
    for wanted in ("version", "generator", "generator_version"):
        ordered_root_children.extend(groups.pop(wanted, ()))
    ordered_root_children.extend((general, node("paper", quoted("A4"))))
    ordered_root_children.extend(groups.pop("layers", ()))
    ordered_root_children.append(setup)
    for wanted in (
        "net",
        "footprint",
        "gr_text",
        "gr_line",
        "segment",
        "via",
        "zone",
        "embedded_fonts",
    ):
        ordered_root_children.extend(groups.pop(wanted, ()))
    for wanted in sorted(groups):
        ordered_root_children.extend(groups[wanted])
    return render(node("kicad_pcb", *ordered_root_children))


def _pin_number_sort_key(number: str) -> tuple[tuple[int, int | str], ...]:
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"([0-9]+)", number)
        if part
    )


def _pin_layout(component: Component) -> dict[str, PointNm]:
    ordered = sorted(
        component.pins, key=lambda item: _pin_number_sort_key(item.number)
    )
    return {
        pin.number: PointNm(
            (2 * index - (len(ordered) - 1)) * (_GRID_NM // 2),
            0,
        )
        for index, pin in enumerate(ordered)
    }


def _pin_rotation(component: Component, pin_number: str) -> int:
    ordered_numbers = [
        item.number
        for item in sorted(
            component.pins, key=lambda item: _pin_number_sort_key(item.number)
        )
    ]
    return (
        90_000_000
        if ordered_numbers.index(pin_number) < (len(ordered_numbers) + 1) // 2
        else 270_000_000
    )


def _symbol_half_height(component: Component) -> int:
    return 3 * _GRID_NM


def _symbol_half_width(component: Component) -> int:
    positions = _pin_layout(component).values()
    return max(
        _GRID_NM,
        max((abs(item.x) for item in positions), default=0) + _GRID_NM // 2,
    )


def _symbol_origins(graph: DesignGraph) -> dict[str, PointNm]:
    occupied = {
        _to_point(point)
        for wire in graph.schematic_wires
        for point in wire.vertices
    }
    occupied.update(_to_point(item.position) for item in graph.schematic_junctions)
    source_segments = tuple(
        (start, end)
        for wire in graph.schematic_wires
        for start, end in zip(wire.vertices, wire.vertices[1:], strict=False)
    )
    result: dict[str, PointNm] = {}
    cursor_x = 25_400_000
    cursor_y = 25_400_000
    for component in sorted(graph.components, key=lambda item: item.component_id):
        local = _pin_layout(component)
        half_height = _symbol_half_height(component)
        symbol_height = 2 * half_height
        if cursor_y + half_height + 5_080_000 > 190_000_000:
            # Keep every new symbol column on KiCad's 1.27 mm connection grid.
            cursor_x += 30_480_000
            cursor_y = 25_400_000
        candidate_x = cursor_x
        while True:
            origin = PointNm(candidate_x, cursor_y)
            points = {
                PointNm(origin.x + point.x, origin.y + point.y)
                for point in local.values()
            }
            intersects_source = any(
                _point_on_segment(
                    DesignPoint(point.x, point.y),
                    start,
                    end,
                )
                for point in points
                for start, end in source_segments
            )
            if not points & occupied and not intersects_source:
                break
            candidate_x += 2 * _GRID_NM
        result[component.component_id] = origin
        occupied.update(points)
        minimum_step = symbol_height + 4 * _GRID_NM
        cursor_y += ((minimum_step + _GRID_NM - 1) // _GRID_NM) * _GRID_NM
    return result


def _point_on_segment(point: DesignPoint, start: DesignPoint, end: DesignPoint) -> bool:
    cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (
        point.x - start.x
    )
    return cross == 0 and min(start.x, end.x) <= point.x <= max(
        start.x, end.x
    ) and min(start.y, end.y) <= point.y <= max(start.y, end.y)


def _orientation(a: DesignPoint, b: DesignPoint, c: DesignPoint) -> int:
    cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    return (cross > 0) - (cross < 0)


def _segments_intersect(
    a: DesignPoint,
    b: DesignPoint,
    c: DesignPoint,
    d: DesignPoint,
) -> bool:
    orientations = (
        _orientation(a, b, c),
        _orientation(a, b, d),
        _orientation(c, d, a),
        _orientation(c, d, b),
    )
    if orientations[0] * orientations[1] < 0 and orientations[2] * orientations[3] < 0:
        return True
    return (
        (orientations[0] == 0 and _point_on_segment(c, a, b))
        or (orientations[1] == 0 and _point_on_segment(d, a, b))
        or (orientations[2] == 0 and _point_on_segment(a, c, d))
        or (orientations[3] == 0 and _point_on_segment(b, c, d))
    )


def _wire_parts(
    graph: DesignGraph,
) -> dict[str, tuple[tuple[str, DesignPoint, DesignPoint], ...]]:
    junctions_by_net: dict[str, tuple[DesignPoint, ...]] = {
        net.net_id: tuple(
            item.position for item in graph.schematic_junctions if item.net_id == net.net_id
        )
        for net in graph.nets
    }
    result: dict[str, tuple[tuple[str, DesignPoint, DesignPoint], ...]] = {}
    for wire in sorted(graph.schematic_wires, key=lambda item: item.wire_id):
        parts: list[tuple[str, DesignPoint, DesignPoint]] = []
        ordinal = 0
        for start, end in zip(wire.vertices, wire.vertices[1:], strict=False):
            inner = [
                point
                for point in junctions_by_net[wire.net_id]
                if point not in {start, end} and _point_on_segment(point, start, end)
            ]
            ordered = sorted(
                {start, *inner, end},
                key=lambda point: (point.x - start.x) * (end.x - start.x)
                + (point.y - start.y) * (end.y - start.y),
            )
            for first, second in zip(ordered, ordered[1:], strict=False):
                target = _uuid(
                    "schematic-wire-segment",
                    wire.wire_id,
                    ordinal,
                    first.x,
                    first.y,
                    second.x,
                    second.y,
                )
                parts.append((target, first, second))
                ordinal += 1
        result[wire.wire_id] = tuple(parts)
    return result


def _effects(*, hidden: bool = False) -> tuple[SExpr, ...]:
    children: list[SExpr] = [node("font", node("size", atom("1.27"), atom("1.27")))]
    if hidden:
        children.append(node("hide", atom("yes")))
    return node("effects", *children)


def _nm_text(value: int) -> str:
    sign = "-" if value < 0 else ""
    whole, fraction = divmod(abs(value), 1_000_000)
    if not fraction:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{fraction:06d}".rstrip("0")


def _at(point: PointNm, rotation_udeg: int = 0) -> tuple[SExpr, ...]:
    return node(
        "at",
        atom(_nm_text(point.x)),
        atom(_nm_text(point.y)),
        atom(_nm_text(rotation_udeg)),
    )


def _at_xy(point: PointNm) -> tuple[SExpr, ...]:
    return node("at", atom(_nm_text(point.x)), atom(_nm_text(point.y)))


def _schematic_property(
    name: str,
    value: str,
    position: PointNm,
    *,
    hidden: bool = False,
) -> SExpr:
    return node(
        "property",
        quoted(name),
        quoted(value),
        _at(position),
        _effects(hidden=hidden),
    )


def _embedded_symbol_id(source_symbol_id: str) -> str:
    """Return a compiler-owned ID so host libraries cannot replace cached pins."""

    return "FluxGenerated:" + _uuid(
        "embedded-library-symbol", source_symbol_id
    ).replace("-", "")


def _local_footprint_id(component: Component) -> str:
    """Return a portable per-component module ID immune to case-fold collisions."""

    return "fp_" + _uuid(
        "project-local-footprint",
        component.component_id,
        component.footprint_id,
    ).replace("-", "")


def _local_footprint_link(component: Component) -> str:
    return "FluxGenerated:" + _local_footprint_id(component)


@dataclass(frozen=True, slots=True)
class _R2CompilationState:
    plan: HumanSchematicPlan
    emission: HumanSchematicEmission
    profile: R2CompilationProfile
    symbol_catalog_sha256: str


_HUMAN_SCHEMATIC_SOURCE_ROOT = (
    Path(__file__).resolve().parent / "human_schematic"
).resolve()


def _human_source_payload(source: SymbolSource) -> bytes:
    relative = PurePosixPath(source.path)
    if relative.is_absolute() or ".." in relative.parts or "\\" in source.path:
        raise HumanSchematicError(
            "human-symbol-source-path-unsafe",
            source.source_id,
            "retained source path must remain beneath the compiler package",
        )
    candidate = _HUMAN_SCHEMATIC_SOURCE_ROOT.joinpath(*relative.parts)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise HumanSchematicError(
            "human-symbol-source-unavailable",
            source.source_id,
            "retained source payload is unavailable",
        ) from exc
    if not resolved.is_relative_to(_HUMAN_SCHEMATIC_SOURCE_ROOT) or not resolved.is_file():
        raise HumanSchematicError(
            "human-symbol-source-path-unsafe",
            source.source_id,
            "retained source path escaped the compiler package",
        )
    return resolved.read_bytes()


def _human_uuid_factory(domain: str, semantic_id: str) -> str:
    # KiCad requires the project top-level sheet identity to be the schematic
    # document root identity.  All drawing-owned identities remain isolated in
    # the human namespace; only this project-owned identity is shared.
    if domain == "schematic-root":
        return _uuid(domain, semantic_id)
    return _uuid(f"human-{domain}", semantic_id)


def _prepare_r2_state(graph: DesignGraph, stem: str) -> _R2CompilationState | None:
    if graph.project_id != _R2_PROJECT_ID:
        return None
    # Lazy import avoids reference_design.__init__ -> artifacts -> compiler
    # recursion for every generic compiler import.
    from .reference_r2 import (
        R2_GRAPH_SHA256,
        R2CompilationProfileError,
        build_r2_compilation_profile,
    )

    if graph.graph_hash != R2_GRAPH_SHA256:
        raise CompilationBlockedError(
            (
                CompilationBlocker(
                    "reference-r2-source-hash-required",
                    graph.project_id,
                    "the sealed R2 profile cannot be applied to a changed graph",
                ),
            )
        )
    catalog = default_symbol_catalog()
    component_index = {item.component_id: item for item in graph.components}

    def footprint_link(component_id: str) -> str:
        try:
            return _local_footprint_link(component_index[component_id])
        except KeyError as exc:
            raise HumanSchematicError(
                "human-footprint-link-subject-missing",
                component_id,
                "human schematic referenced an unknown canonical component",
            ) from exc

    try:
        plan = plan_r2_human_schematic(
            graph,
            catalog=catalog,
            source_payload_resolver=_human_source_payload,
        )
        emission = emit_human_schematic(
            plan,
            stem=stem,
            uuid_factory=_human_uuid_factory,
            footprint_link_factory=footprint_link,
            source_payload_resolver=_human_source_payload,
        )
        verify_human_schematic_emission(
            plan,
            emission,
            stem=stem,
            uuid_factory=_human_uuid_factory,
            footprint_link_factory=footprint_link,
            source_payload_resolver=_human_source_payload,
        )
        profile = build_r2_compilation_profile(
            graph,
            human_plan_sha256=plan.plan_digest,
            human_symbol_catalog_sha256=catalog.catalog_digest,
            human_emission_sha256=emission.emission_sha256,
        )
    except (HumanSchematicError, R2CompilationProfileError) as exc:
        code = (
            exc.code
            if isinstance(exc, HumanSchematicError)
            else "reference-r2-profile-required"
        )
        raise CompilationBlockedError(
            (
                CompilationBlocker(
                    code,
                    graph.project_id,
                    str(exc),
                ),
            )
        ) from exc
    return _R2CompilationState(plan, emission, profile, catalog.catalog_digest)


def _human_bindings(
    bindings: tuple[HumanEmissionBinding, ...],
) -> tuple[IdentityBinding, ...]:
    return tuple(
        IdentityBinding(
            item.source_kind,
            item.source_id,
            item.target_kind,
            item.emitted_ids,
        )
        for item in bindings
    )


def _r2_evidence_bindings(state: _R2CompilationState) -> tuple[IdentityBinding, ...]:
    evidence = state.profile.evidence
    return tuple(
        sorted(
            (
                IdentityBinding(
                    "r2-human-schematic-plan",
                    state.plan.semantic_graph.project_id,
                    "profile-evidence",
                    (evidence.human_plan_sha256,),
                ),
                IdentityBinding(
                    "r2-human-symbol-catalog",
                    state.plan.semantic_graph.project_id,
                    "profile-evidence",
                    (evidence.human_symbol_catalog_sha256,),
                ),
                IdentityBinding(
                    "r2-human-schematic-emission",
                    state.plan.semantic_graph.project_id,
                    "profile-evidence",
                    (evidence.human_emission_sha256,),
                ),
                IdentityBinding(
                    "r2-source-receipt-manifest",
                    evidence.profile_id,
                    "profile-evidence",
                    (evidence.source_receipt_manifest_sha256,),
                ),
            )
        )
    )


def _emitted_pin_type(source_type: str) -> str:
    # A canonical ``no_connect`` pin is represented in KiCad as a passive pin
    # plus an explicit no-connect marker.  KiCad otherwise creates a synthetic
    # net for the pin and reports false PCB/schematic parity conflicts.
    return "passive" if source_type == "no_connect" else source_type


def _build_schematic(
    graph: DesignGraph,
    stem: str,
) -> tuple[bytes, tuple[IdentityBinding, ...]]:
    root_id = _uuid("schematic-root", graph.project_id)
    origins = _symbol_origins(graph)
    pin_positions: dict[PinRef, PointNm] = {}
    bindings: list[IdentityBinding] = [
        IdentityBinding("project", graph.project_id, "schematic-root", (root_id,))
    ]

    library_expressions: list[SExpr] = []
    representative: dict[str, Component] = {}
    for component in sorted(graph.components, key=lambda item: item.component_id):
        representative.setdefault(component.symbol_id, component)
    for library_id, component in sorted(representative.items()):
        emitted_library_id = _embedded_symbol_id(library_id)
        bindings.append(
            IdentityBinding(
                "symbol-library",
                library_id,
                "embedded-schematic-library-id",
                (emitted_library_id,),
            )
        )
        local = _pin_layout(component)
        half_height = _symbol_half_height(component)
        half_width = _symbol_half_width(component)
        pin_expressions: list[SExpr] = []
        for pin in sorted(
            component.pins, key=lambda item: _pin_number_sort_key(item.number)
        ):
            pin_expressions.append(
                node(
                    "pin",
                    atom(_emitted_pin_type(pin.electrical_type)),
                    atom("line"),
                    _at(local[pin.number], _pin_rotation(component, pin.number)),
                    node("length", atom("2.54")),
                    node("name", quoted(pin.name), _effects()),
                    node("number", quoted(pin.pad_number), _effects()),
                )
        )
        prefix_match = re.match(r"[A-Za-z#]+", component.reference)
        reference_prefix = prefix_match.group(0) if prefix_match is not None else "U"
        # KiCad validates the unit-name prefix against the exact library-symbol
        # leaf, including punctuation such as the dot in ``USB2.0``.
        nested_base = emitted_library_id.rsplit(":", 1)[-1]
        body_name = f"{nested_base}_0_1"
        pin_name = f"{nested_base}_1_1"
        reference_position = PointNm(0, -half_height - _GRID_NM)
        value_position = PointNm(0, half_height + _GRID_NM)
        library_expressions.append(
            node(
                "symbol",
                quoted(emitted_library_id),
                node("pin_names", node("offset", atom("0.508"))),
                node("exclude_from_sim", atom("no")),
                node("in_bom", atom("yes")),
                node("on_board", atom("yes")),
                node("duplicate_pin_numbers_are_jumpers", atom("no")),
                _schematic_property(
                    "Reference", reference_prefix, reference_position
                ),
                _schematic_property("Value", component.value, value_position),
                _schematic_property("Footprint", "", PointNm(0, 0), hidden=True),
                _schematic_property("Datasheet", "", PointNm(0, 0), hidden=True),
                _schematic_property("Description", "", PointNm(0, 0), hidden=True),
                node(
                    "symbol",
                    quoted(body_name),
                    node(
                        "rectangle",
                        node(
                            "start",
                            atom(_nm_text(-half_width)),
                            atom(_nm_text(-half_height)),
                        ),
                        node(
                            "end",
                            atom(_nm_text(half_width)),
                            atom(_nm_text(-_GRID_NM)),
                        ),
                        node(
                            "stroke",
                            node("width", atom("0.254")),
                            node("type", atom("default")),
                        ),
                        node("fill", node("type", atom("background"))),
                    ),
                    node(
                        "rectangle",
                        node(
                            "start",
                            atom(_nm_text(-half_width)),
                            atom(_nm_text(_GRID_NM)),
                        ),
                        node(
                            "end",
                            atom(_nm_text(half_width)),
                            atom(_nm_text(half_height)),
                        ),
                        node(
                            "stroke",
                            node("width", atom("0.254")),
                            node("type", atom("default")),
                        ),
                        node("fill", node("type", atom("background"))),
                    ),
                ),
                node("symbol", quoted(pin_name), *pin_expressions),
                node("embedded_fonts", atom("no")),
            )
        )

    symbol_expressions: list[SExpr] = []
    no_connect_expressions: list[SExpr] = []
    member_to_net = {
        member: net for net in graph.nets for member in net.members
    }
    for component in sorted(graph.components, key=lambda item: item.component_id):
        symbol_id = _uuid("schematic-symbol", component.component_id)
        bindings.append(
            IdentityBinding("component", component.component_id, "schematic-symbol", (symbol_id,))
        )
        origin = origins[component.component_id]
        local = _pin_layout(component)
        half_height = _symbol_half_height(component)
        reference_position = PointNm(origin.x, origin.y - half_height - _GRID_NM)
        value_position = PointNm(origin.x, origin.y + half_height + _GRID_NM)
        placed_pins: list[SExpr] = []
        for pin in sorted(
            component.pins, key=lambda item: _pin_number_sort_key(item.number)
        ):
            pin_id = _uuid("schematic-pin", component.component_id, pin.number)
            bindings.append(
                IdentityBinding(
                    "logical-pin",
                    f"{component.component_id}:{pin.number}",
                    "schematic-pin",
                    (pin_id,),
                )
            )
            position = PointNm(
                origin.x + local[pin.number].x,
                origin.y + local[pin.number].y,
            )
            pin_positions[PinRef(component.component_id, pin.number)] = position
            placed_pins.append(
                node("pin", quoted(pin.pad_number), node("uuid", quoted(pin_id)))
            )
            if PinRef(component.component_id, pin.number) not in member_to_net:
                marker_id = _uuid("no-connect", component.component_id, pin.number)
                no_connect_expressions.append(
                    node("no_connect", _at_xy(position), node("uuid", quoted(marker_id)))
                )
        symbol_expressions.append(
            node(
                "symbol",
                node("lib_id", quoted(_embedded_symbol_id(component.symbol_id))),
                _at(origin),
                node("unit", atom("1")),
                node("exclude_from_sim", atom("no")),
                node("in_bom", atom("yes")),
                node("on_board", atom("yes")),
                node("dnp", atom("no")),
                node("uuid", quoted(symbol_id)),
                _schematic_property(
                    "Reference", component.reference, reference_position
                ),
                _schematic_property("Value", component.value, value_position),
                _schematic_property(
                    "Footprint", _local_footprint_link(component), origin, hidden=True
                ),
                _schematic_property("Datasheet", "", origin, hidden=True),
                _schematic_property("Description", "", origin, hidden=True),
                *placed_pins,
                node(
                    "instances",
                    node(
                        "project",
                        quoted(stem),
                        node(
                            "path",
                            quoted(f"/{root_id}"),
                            node("reference", quoted(component.reference)),
                            node("unit", atom("1")),
                        ),
                    ),
                ),
            )
        )

    wire_parts = _wire_parts(graph)
    wire_expressions: list[SExpr] = []
    wire_net: dict[str, str] = {}
    for wire in sorted(graph.schematic_wires, key=lambda item: item.wire_id):
        targets: list[str] = []
        for target, start, end in wire_parts[wire.wire_id]:
            targets.append(target)
            wire_net[target] = wire.net_id
            wire_expressions.append(
                node(
                    "wire",
                    node(
                        "pts",
                        node("xy", atom(_nm_text(start.x)), atom(_nm_text(start.y))),
                        node("xy", atom(_nm_text(end.x)), atom(_nm_text(end.y))),
                    ),
                    node("stroke", node("width", atom("0")), node("type", atom("default"))),
                    node("uuid", quoted(target)),
                )
            )
        bindings.append(
            IdentityBinding(
                "schematic-wire",
                wire.wire_id,
                "schematic-wire-segment",
                tuple(sorted(targets)),
            )
        )

    junction_expressions: list[SExpr] = []
    for item in sorted(graph.schematic_junctions, key=lambda value: value.junction_id):
        target = _uuid("schematic-junction", item.junction_id)
        bindings.append(
            IdentityBinding("schematic-junction", item.junction_id, "junction", (target,))
        )
        junction_expressions.append(
            node(
                "junction",
                _at_xy(_to_point(item.position)),
                node("diameter", atom("0")),
                node("color", atom("0"), atom("0"), atom("0"), atom("0")),
                node("uuid", quoted(target)),
            )
        )

    label_expressions: list[SExpr] = []
    label_anchors: set[tuple[str, PointNm]] = set()
    nets = {item.net_id: item for item in graph.nets}
    for net in graph.nets:
        for member in net.members:
            label_anchors.add((net.net_id, pin_positions[member]))
    for wire in graph.schematic_wires:
        label_anchors.add((wire.net_id, _to_point(wire.vertices[0])))
        label_anchors.add((wire.net_id, _to_point(wire.vertices[-1])))
    for net_id, position in sorted(
        label_anchors, key=lambda item: (item[0], item[1].x, item[1].y)
    ):
        label_id = _uuid("schematic-label", net_id, position.x, position.y)
        label_expressions.append(
            node(
                "global_label",
                quoted(nets[net_id].name),
                node("shape", atom("bidirectional")),
                _at(position),
                node("fields_autoplaced", atom("yes")),
                _effects(),
                node("uuid", quoted(label_id)),
            )
        )

    expression = node(
        "kicad_sch",
        node("version", atom(str(_SCHEMATIC_VERSION))),
        node("generator", quoted("flux_clone")),
        node("generator_version", quoted("10.0")),
        node("uuid", quoted(root_id)),
        node("paper", quoted("A4")),
        node("lib_symbols", *library_expressions),
        *junction_expressions,
        *no_connect_expressions,
        *wire_expressions,
        *label_expressions,
        *symbol_expressions,
        node("sheet_instances", node("path", quoted("/"), node("page", quoted("1")))),
        node("embedded_fonts", atom("no")),
    )
    return render(expression), _merged_bindings(bindings)


def _library_table_payload(*, symbol: bool) -> bytes:
    table_head = "sym_lib_table" if symbol else "fp_lib_table"
    uri = (
        "${KIPRJMOD}/FluxGenerated.kicad_sym"
        if symbol
        else "${KIPRJMOD}/FluxGenerated.pretty"
    )
    return render(
        node(
            table_head,
            node("version", atom("7")),
            node(
                "lib",
                node("name", quoted("FluxGenerated")),
                node("type", quoted("KiCad")),
                node("uri", quoted(uri)),
                node("options", quoted("")),
                node("descr", quoted("")),
            ),
        )
    )


def _child_nodes(expression: SExpr, wanted: str) -> tuple[tuple[SExpr, ...], ...]:
    if not isinstance(expression, tuple):
        return ()
    return tuple(
        child
        for child in expression[1:]
        if isinstance(child, tuple) and head(child) == wanted
    )


def _one_child(expression: SExpr, wanted: str, label: str) -> tuple[SExpr, ...]:
    result = _child_nodes(expression, wanted)
    if len(result) != 1:
        raise CompilationParityError(f"{label} requires exactly one {wanted}")
    return result[0]


def _symbol_library_payload(schematic_payload: bytes) -> bytes:
    expression = parse(schematic_payload)
    if not isinstance(expression, tuple) or head(expression) != "kicad_sch":
        raise CompilationParityError("generated schematic does not have a KiCad root")
    embedded = _one_child(expression, "lib_symbols", "generated schematic")
    external_definitions: list[SExpr] = []
    for definition in embedded[1:]:
        if not isinstance(definition, tuple) or head(definition) != "symbol" or len(
            definition
        ) < 2:
            raise CompilationParityError("embedded symbol library contains a malformed child")
        full_id = scalar_text(definition[1], label="embedded symbol ID")
        prefix = "FluxGenerated:"
        if not full_id.startswith(prefix) or not full_id.removeprefix(prefix):
            raise CompilationParityError("embedded symbol ID is not compiler-local")
        external_definitions.append(
            (definition[0], quoted(full_id.removeprefix(prefix)), *definition[2:])
        )
    return render(
        node(
            "kicad_symbol_lib",
            node("version", atom("20240529")),
            node("generator", quoted("flux_clone")),
            node("generator_version", quoted("10.0")),
            *external_definitions,
        )
    )


def _angle_udeg(at_expression: tuple[SExpr, ...], label: str) -> int:
    if len(at_expression) not in {3, 4}:
        raise CompilationParityError(f"{label} at expression is malformed")
    if len(at_expression) == 3:
        return 0
    value = Decimal(scalar_text(at_expression[3], label=f"{label} angle")) * 1_000_000
    if value != value.to_integral_value():
        raise CompilationParityError(f"{label} angle is below microdegree resolution")
    return int(value) % 360_000_000


def _module_pad_expression(
    pad_expression: tuple[SExpr, ...],
    footprint_rotation_udeg: int,
) -> tuple[SExpr, ...]:
    at_expression = _one_child(pad_expression, "at", "placed pad")
    local_angle = (
        _angle_udeg(at_expression, "placed pad") - footprint_rotation_udeg
    ) % 360_000_000
    transformed_at: tuple[SExpr, ...] = node(
        "at",
        at_expression[1],
        at_expression[2],
        atom(_nm_text(local_angle)),
    )
    children: list[SExpr] = [pad_expression[0]]
    for child in pad_expression[1:]:
        if isinstance(child, tuple) and head(child) == "net":
            continue
        if child is at_expression:
            children.append(transformed_at)
        else:
            children.append(child)
    return tuple(children)


def _footprint_module_payloads(
    graph: DesignGraph,
    board_payload: bytes,
) -> tuple[tuple[ProjectAuxiliaryFile, ...], tuple[IdentityBinding, ...]]:
    expression = parse(board_payload)
    if not isinstance(expression, tuple) or head(expression) != "kicad_pcb":
        raise CompilationParityError("generated board does not have a KiCad root")
    components_by_link = {
        _local_footprint_link(component): component for component in graph.components
    }
    result: list[ProjectAuxiliaryFile] = []
    bindings: list[IdentityBinding] = []
    seen: set[str] = set()
    for placed in _child_nodes(expression, "footprint"):
        if len(placed) < 2:
            raise CompilationParityError("placed footprint omitted its library link")
        full_link = scalar_text(placed[1], label="placed footprint link")
        try:
            component = components_by_link[full_link]
        except KeyError as exc:
            raise CompilationParityError(
                f"placed footprint has no canonical local-library owner: {full_link}"
            ) from exc
        local_id = _local_footprint_id(component)
        if local_id.casefold() in seen:
            raise CompilationParityError("project-local footprint IDs collide")
        seen.add(local_id.casefold())
        root_at = _one_child(placed, "at", "placed footprint")
        footprint_rotation = _angle_udeg(root_at, "placed footprint")
        module_children: list[SExpr] = [
            atom("footprint"),
            quoted(local_id),
            node("version", atom("20240108")),
            node("generator", quoted("flux_clone")),
            node("generator_version", quoted("10.0")),
        ]
        for child in placed[2:]:
            if isinstance(child, tuple) and head(child) in {"uuid", "at"}:
                continue
            if not isinstance(child, tuple):
                # Root `locked`/`placed` flags belong to the board instance.
                continue
            if head(child) == "pad":
                module_children.append(_module_pad_expression(child, footprint_rotation))
            else:
                module_children.append(child)
        payload = render(tuple(module_children))
        relative_name = f"FluxGenerated.pretty/{local_id}.kicad_mod"
        result.append(
            ProjectAuxiliaryFile(
                relative_name,
                "application/x-kicad-footprint",
                payload,
            )
        )
        bindings.append(
            IdentityBinding(
                "component",
                component.component_id,
                "project-local-footprint-file",
                (relative_name,),
            )
        )
    if set(components_by_link) != {
        _local_footprint_link(component)
        for component in graph.components
        if _local_footprint_id(component).casefold() in seen
    }:
        raise CompilationParityError("project-local footprint module population is incomplete")
    return tuple(result), _merged_bindings(bindings)


def _build_auxiliary_files(
    graph: DesignGraph,
    schematic_payload: bytes,
    board_payload: bytes,
    symbol_library_payload: bytes | None = None,
) -> tuple[
    tuple[ProjectAuxiliaryFile, ...],
    tuple[IdentityBinding, ...],
    HermeticProjectLibraries,
]:
    modules, bindings = _footprint_module_payloads(graph, board_payload)
    derived_symbol_library = _symbol_library_payload(schematic_payload)
    if (
        symbol_library_payload is not None
        and symbol_library_payload != derived_symbol_library
    ):
        raise CompilationParityError(
            "human emitter symbol library differs from embedded schematic definitions"
        )
    selected_symbol_library = (
        derived_symbol_library
        if symbol_library_payload is None
        else symbol_library_payload
    )
    base = (
        ProjectAuxiliaryFile(
            "fp-lib-table",
            "application/x-kicad-library-table",
            _library_table_payload(symbol=False),
        ),
        ProjectAuxiliaryFile(
            "FluxGenerated.kicad_sym",
            "application/x-kicad-symbol-library",
            selected_symbol_library,
        ),
        ProjectAuxiliaryFile(
            "sym-lib-table",
            "application/x-kicad-library-table",
            _library_table_payload(symbol=True),
        ),
        *modules,
    )
    files = tuple(
        sorted(base, key=lambda item: (item.relative_name.casefold(), item.relative_name))
    )
    libraries = parse_hermetic_project_libraries(files)
    return files, bindings, libraries


def _assert_hermetic_library_parity(
    graph: DesignGraph,
    source: ProjectBundleInput,
    schematic: Schematic,
    board: Board,
    libraries: HermeticProjectLibraries,
    r2_state: _R2CompilationState | None = None,
) -> None:
    if libraries.auxiliary_manifest_sha256 != source.auxiliary_manifest_sha256:
        raise CompilationParityError("parsed libraries do not bind the auxiliary file set")
    schematic_expression = parse(source.schematic_payload)
    embedded = _one_child(schematic_expression, "lib_symbols", "generated schematic")
    embedded_payloads: dict[str, str] = {}
    for definition in embedded[1:]:
        if not isinstance(definition, tuple) or head(definition) != "symbol":
            raise CompilationParityError("embedded library contains a malformed definition")
        full_id = scalar_text(definition[1], label="embedded symbol ID")
        if not full_id.startswith("FluxGenerated:"):
            raise CompilationParityError("embedded symbol is not project-local")
        local_id = full_id.removeprefix("FluxGenerated:")
        normalized = (definition[0], quoted(local_id), *definition[2:])
        embedded_payloads[local_id] = canonical_text(normalized)
    external_payloads = {
        item.local_id: item.canonical_payload
        for item in libraries.symbol_library.definitions
    }
    if embedded_payloads != external_payloads:
        raise CompilationParityError(
            "external symbol library differs from embedded typed symbol definitions"
        )
    expected_symbol_ids = (
        {
            "FluxGenerated:"
            + item.flattened_library_id.removeprefix("FluxHuman:")
            for item in r2_state.plan.symbol_templates
        }
        if r2_state is not None
        else {
            _embedded_symbol_id(component.symbol_id) for component in graph.components
        }
    )
    if {item.library_id for item in schematic.library_symbols} != expected_symbol_ids:
        raise CompilationParityError("schematic embedded-symbol population is incomplete")
    if {item.library_id for item in schematic.symbols} != expected_symbol_ids:
        raise CompilationParityError("placed schematic symbol links are incomplete")

    expected_links = {
        component.reference: _local_footprint_link(component)
        for component in graph.components
    }
    board_links = {item.reference: item.library_id for item in board.footprints}
    schematic_links = {item.reference: item.footprint for item in schematic.symbols}
    if board_links != expected_links or schematic_links != expected_links:
        raise CompilationParityError(
            "placed schematic/PCB footprints do not share exact project-local links"
        )
    expected_local_ids = {
        _local_footprint_id(component) for component in graph.components
    }
    actual_local_ids = {item.local_id for item in libraries.footprint_modules}
    if actual_local_ids != expected_local_ids:
        raise CompilationParityError("project-local footprint module coverage is incomplete")
    if r2_state is not None:
        modules = {item.local_id: item for item in libraries.footprint_modules}
        fab_by_component = {
            item.component_id: item for item in r2_state.profile.fab_records
        }
        courtyard_by_component = {
            item.component_id: item for item in r2_state.profile.courtyard_records
        }
        emitted_models = {
            item.component_id: item for item in r2_state.profile.emitted_model_records
        }
        for component in graph.components:
            module = modules[_local_footprint_id(component)]
            layer_counts = {
                layer: sum(item.layer == layer for item in module.graphics)
                for layer in {"F.Fab", "F.CrtYd"}
            }
            expected_counts = {
                "F.Fab": len(fab_by_component[component.component_id].vertices_nm) - 1,
                "F.CrtYd": (
                    len(courtyard_by_component[component.component_id].vertices_nm) - 1
                ),
            }
            if layer_counts != expected_counts:
                raise CompilationParityError(
                    f"R2 module assembly artwork drifted: {component.component_id}"
                )
            expected_model = emitted_models.get(component.component_id)
            if expected_model is None:
                if module.models:
                    raise CompilationParityError(
                        f"R2 omitted model was emitted: {component.component_id}"
                    )
            elif (
                len(module.models) != 1
                or module.models[0].path != expected_model.kicad_reference
                or module.models[0].offset_nm != (0, 0, 0)
                or module.models[0].scale_ppm != (1_000_000, 1_000_000, 1_000_000)
                or module.models[0].rotate_udeg != (0, 0, 0)
            ):
                raise CompilationParityError(
                    f"R2 module 3D model reference drifted: {component.component_id}"
                )


def _reference_board_settings() -> dict[str, object]:
    return {
        "design_settings": {
            "drc_exclusions": [],
            "meta": {"filename": "board_design_settings.json", "version": 2},
            "rules": {
                "min_clearance": 0.2,
                "min_hole_clearance": 0.15,
            },
        }
    }


def _project_payload(graph: DesignGraph, stem: str) -> bytes:
    root_id = _uuid("schematic-root", graph.project_id)
    board_id = _uuid("board-file", graph.project_id)
    document: dict[str, object] = {
        "boards": [[board_id, stem]],
        "meta": {"filename": f"{stem}.kicad_pro", "version": 3},
        "schematic": {
            "top_level_sheets": [
                {
                    "filename": f"{stem}.kicad_sch",
                    "name": "Root",
                    "uuid": root_id,
                }
            ]
        },
        "sheets": [[root_id, "Root"]],
    }
    if _is_source_bound_reference(graph):
        document["board"] = _reference_board_settings()
    return _canonical_json(document)


def _merged_bindings(bindings: list[IdentityBinding]) -> tuple[IdentityBinding, ...]:
    grouped: dict[tuple[str, str, str], set[str]] = defaultdict(set)
    for item in bindings:
        grouped[(item.source_kind, item.source_id, item.target_kind)].update(item.emitted_ids)
    return tuple(
        sorted(
            IdentityBinding(source_kind, source_id, target_kind, tuple(sorted(targets)))
            for (source_kind, source_id, target_kind), targets in grouped.items()
        )
    )


def _bundle_sha256(files: tuple[FileDigest, ...]) -> str:
    body = _canonical_json(
        [
            {
                "filename": item.filename,
                "byteLength": item.byte_length,
                "sha256": item.sha256,
            }
            for item in files
        ]
    )
    return hashlib.sha256(b"flux-clone-compiled-bundle-v1\x00" + body).hexdigest()


def _manifest_payload(manifest: CompilationManifest) -> bytes:
    return _canonical_json(manifest.to_primitive())


def _project_diagnostics_supported(manifest: ProjectManifest) -> bool:
    unsupported = manifest.diagnostics.unsupported
    if not unsupported:
        return True
    expected_payload = _canonical_json(_reference_board_settings()).decode("utf-8").rstrip("\n")
    expected_reason = (
        "project settings outside the modeled membership manifest can affect library "
        "resolution, ERC/DRC, text expansion, or fabrication behavior"
    )
    if len(unsupported) != 1 or type(unsupported[0]) is not ProjectDiagnostic:
        return False
    diagnostic = unsupported[0]
    return (
        diagnostic.artifact,
        diagnostic.path,
        diagnostic.head,
        diagnostic.disposition,
        diagnostic.reason,
        diagnostic.canonical_payload,
        diagnostic.payload_sha256,
    ) == (
        "project",
        "$.board",
        "board",
        ProjectDiagnosticDisposition.UNSUPPORTED,
        expected_reason,
        expected_payload,
        _sha256(expected_payload.encode("utf-8")),
    )


def _parse_outputs(source: ProjectBundleInput) -> tuple[ProjectManifest, Schematic, Board]:
    limits = BundleLimits()
    manifest = parse_project_manifest(source.project_payload, stem=source.stem, limits=limits)
    schematic = parse_schematic(source.schematic_payload, limits=limits)
    board = import_board(
        source.board_payload,
        unsupported_policy=BoardUnsupportedPolicy.REJECT,
    ).board
    if (
        not _project_diagnostics_supported(manifest)
        or schematic.diagnostics.unsupported
        or board.diagnostics.unsupported
    ):
        raise CompilationParityError("compiler output contains an unsupported codec diagnostic")
    return manifest, schematic, board


def _binding_map(
    bindings: tuple[IdentityBinding, ...], source_kind: str, target_kind: str
) -> dict[str, tuple[str, ...]]:
    return {
        item.source_id: item.emitted_ids
        for item in bindings
        if item.source_kind == source_kind and item.target_kind == target_kind
    }


def _assert_board_parity(
    graph: DesignGraph,
    board: Board,
    bindings: tuple[IdentityBinding, ...],
    r2_state: _R2CompilationState | None = None,
) -> None:
    expected_net_names = {
        item.net_id: (f"/{item.name}" if r2_state is not None else item.name)
        for item in graph.nets
    }
    expected_net_ids = {
        item.net_id: canonical_net_id(expected_net_names[item.net_id])
        for item in graph.nets
    }
    unconnected_pad_nets = _unconnected_pad_nets(graph)
    expected_board_nets = {
        (expected_net_ids[item.net_id], expected_net_names[item.net_id])
        for item in graph.nets
    } | set(unconnected_pad_nets.values())
    if {(item.net_id, item.name) for item in board.nets} != expected_board_nets:
        raise CompilationParityError("PCB net identity/name population drifted")
    copper = {
        item.name
        for item in board.layers
        if item.kind in {"signal", "power", "mixed", "jumper"}
    }
    if copper != set(graph.layers):
        raise CompilationParityError("PCB copper layer population drifted")
    graph_outline = graph.normalized().board_outline
    board_outline = tuple(DesignPoint(item.x, item.y) for item in board.outline_vertices)
    if graph_outline != DesignGraph(
        1, "parity-outline", tuple(graph.layers), board_outline
    ).normalized().board_outline:
        raise CompilationParityError("PCB Edge.Cuts geometry drifted")

    footprint_ids = _binding_map(bindings, "component", "pcb-footprint")
    footprints = {item.footprint_id: item for item in board.footprints}
    placements = {item.component_id: item for item in graph.placements}
    components = {item.component_id: item for item in graph.components}
    pad_ids = _binding_map(bindings, "pad", "pcb-pad")
    board_pads = {
        item.pad_id: (footprint, item)
        for footprint in board.footprints
        for item in footprint.pads
    }
    for component_id, component in components.items():
        target = footprint_ids[component_id][0]
        footprint = footprints.get(target)
        placement = placements[component_id]
        if footprint is None or (
            footprint.reference,
            footprint.value,
            footprint.library_id,
            footprint.layer,
            footprint.position,
            footprint.rotation_udeg,
            footprint.locked,
        ) != (
            component.reference,
            component.value,
            _local_footprint_link(component),
            "F.Cu",
            _to_point(placement.position),
            placement.rotation_udeg,
            placement.locked,
        ):
            raise CompilationParityError(f"PCB component/placement drifted: {component_id}")
    for source in graph.pads:
        footprint, pad = board_pads[pad_ids[source.pad_id][0]]
        placement = placements[source.component_id]
        local = _board_to_local(source.center, placement.position, placement.rotation_udeg)
        local_rotation = source.rotation_udeg
        if source.drill_x_nm:
            expected_kind = PadKind.THROUGH_HOLE
            expected_layers = {"*.Cu", "*.Mask"}
            relative = (source.drill_rotation_udeg - source.rotation_udeg) % 180_000_000
            expected_drill = (
                (source.drill_y_nm, source.drill_x_nm)
                if relative == 90_000_000
                else (source.drill_x_nm, source.drill_y_nm)
            )
        else:
            expected_kind = PadKind.SMD
            expected_apertures = _reference_aperture_sizes(
                graph,
                components[source.component_id],
                source.pad_id,
            )
            expected_layers = (
                {"F.Cu"}
                if expected_apertures
                else {"F.Cu", "F.Paste", "F.Mask"}
            )
            expected_drill = (0, 0)
        if footprint.footprint_id != footprint_ids[source.component_id][0] or (
            pad.number,
            pad.kind,
            pad.shape.value,
            pad.position,
            pad.rotation_udeg,
            pad.size_x_nm,
            pad.size_y_nm,
            pad.drill_x_nm,
            pad.drill_y_nm,
            set(pad.layers),
            pad.net_id,
            pad.locked,
        ) != (
            source.pad_number,
            expected_kind,
            source.shape,
            local,
            local_rotation,
            source.size_x_nm,
            source.size_y_nm,
            expected_drill[0],
            expected_drill[1],
            expected_layers,
            (
                expected_net_ids[source.net_id]
                if source.net_id is not None
                else unconnected_pad_nets[
                    (source.component_id, source.pad_number)
                ][0]
            ),
            source.locked,
        ):
            raise CompilationParityError(f"PCB pad/drill semantics drifted: {source.pad_id}")
    aperture_ids = _binding_map(bindings, "compiler-aperture", "pcb-pad")
    expected_aperture_sources = {
        f"{source.pad_id}:{layer}": (source, layer, size)
        for source in graph.pads
        for layer, size in _reference_aperture_sizes(
            graph,
            components[source.component_id],
            source.pad_id,
        )
    }
    if set(aperture_ids) != set(expected_aperture_sources):
        raise CompilationParityError("compiler-owned aperture identity population drifted")
    for aperture_source_id, (source, layer, size) in expected_aperture_sources.items():
        footprint, aperture = board_pads[aperture_ids[aperture_source_id][0]]
        placement = placements[source.component_id]
        local = _board_to_local(
            source.center,
            placement.position,
            placement.rotation_udeg,
        )
        if footprint.footprint_id != footprint_ids[source.component_id][0] or (
            aperture.number,
            aperture.kind,
            aperture.shape,
            aperture.position,
            aperture.rotation_udeg,
            aperture.size_x_nm,
            aperture.size_y_nm,
            aperture.drill_x_nm,
            aperture.drill_y_nm,
            aperture.layers,
            aperture.net_id,
            aperture.pin_function,
            aperture.pin_type,
            aperture.locked,
        ) != (
            "",
            PadKind.SMD,
            PadShape.RECT,
            local,
            source.rotation_udeg,
            size[0],
            size[1],
            0,
            0,
            (layer,),
            None,
            None,
            None,
            source.locked,
        ):
            raise CompilationParityError(
                f"compiler-owned aperture semantics drifted: {aperture_source_id}"
            )
    npth_ids = _binding_map(bindings, "hole", "npth-pad")
    for source in (item for item in graph.holes if not item.plated):
        footprint, pad = board_pads[npth_ids[source.hole_id][0]]
        placement = placements[source.component_id]
        local = _board_to_local(source.center, placement.position, placement.rotation_udeg)
        local_rotation = source.drill_rotation_udeg
        expected_shape = (
            PadShape.CIRCLE
            if source.drill_x_nm == source.drill_y_nm
            else PadShape.OVAL
        )
        if footprint.footprint_id != footprint_ids[source.component_id][0] or (
            pad.number,
            pad.kind,
            pad.shape,
            pad.position,
            pad.rotation_udeg,
            pad.size_x_nm,
            pad.size_y_nm,
            pad.drill_x_nm,
            pad.drill_y_nm,
            pad.layers,
            pad.net_id,
            pad.pin_function,
            pad.pin_type,
            pad.locked,
        ) != (
            "",
            PadKind.NPTH,
            expected_shape,
            local,
            local_rotation,
            source.drill_x_nm,
            source.drill_y_nm,
            source.drill_x_nm,
            source.drill_y_nm,
            ("*.Cu", "*.Mask"),
            None,
            None,
            None,
            source.locked,
        ):
            raise CompilationParityError(f"NPTH hole semantics drifted: {source.hole_id}")

    track_ids = _binding_map(bindings, "track", "pcb-segment")
    tracks = {item.segment_id: item for item in board.segments}
    for source in graph.tracks:
        target = tracks[track_ids[source.track_id][0]]
        endpoints = {
            DesignPoint(target.start.x, target.start.y),
            DesignPoint(target.end.x, target.end.y),
        }
        if (
            target.net_id,
            target.layer,
            endpoints,
            target.width_nm,
            target.locked,
        ) != (
            expected_net_ids[source.net_id],
            source.layer,
            {source.start, source.end},
            source.width_nm,
            source.locked,
        ):
            raise CompilationParityError(f"PCB track semantics drifted: {source.track_id}")
    via_ids = _binding_map(bindings, "via", "pcb-via")
    vias = {item.via_id: item for item in board.vias}
    for source in graph.vias:
        target = vias[via_ids[source.via_id][0]]
        if (
            target.net_id,
            DesignPoint(target.center.x, target.center.y),
            target.diameter_nm,
            target.drill_nm,
            set(target.layers),
            target.kind,
            target.locked,
        ) != (
            expected_net_ids[source.net_id],
            source.center,
            source.diameter_nm,
            source.drill_nm,
            set(source.layers),
            ViaKind.THROUGH,
            source.locked,
        ):
            raise CompilationParityError(f"PCB via semantics drifted: {source.via_id}")
    zone_ids = _binding_map(bindings, "zone", "pcb-zone")
    zones = {item.zone_id: item for item in board.zones}
    net_names = expected_net_names
    for source in graph.zones:
        target = zones[zone_ids[source.zone_id][0]]
        boundary = tuple(DesignPoint(item.x, item.y) for item in target.normalized().boundary)
        if (
            target.net_id,
            target.net_name,
            target.layer,
            boundary,
            target.clearance_nm,
            target.minimum_thickness_nm,
        ) != (
            expected_net_ids[source.net_id],
            net_names[source.net_id],
            source.layer,
            source.normalized().outline,
            source.clearance_nm,
            source.min_thickness_nm,
        ):
            raise CompilationParityError(f"PCB zone semantics drifted: {source.zone_id}")


def _assert_schematic_parity(
    graph: DesignGraph,
    schematic: Schematic,
    bindings: tuple[IdentityBinding, ...],
    r2_state: _R2CompilationState | None = None,
) -> None:
    symbol_ids = _binding_map(bindings, "component", "schematic-symbol")
    symbols = {item.symbol_id: item for item in schematic.symbols}
    components = {item.component_id: item for item in graph.components}
    symbol_to_component: dict[str, str] = {}
    for component_id, target_ids in symbol_ids.items():
        symbol = symbols[target_ids[0]]
        component = components[component_id]
        symbol_to_component[symbol.symbol_id] = component_id
        pins = {(item.number, item.name, item.electrical_type) for item in symbol.pins}
        if (
            symbol.reference,
            symbol.value,
            symbol.footprint,
            pins,
        ) != (
            component.reference,
            component.value,
            _local_footprint_link(component),
            {
                (
                    item.pad_number,
                    item.name,
                    (
                        item.electrical_type
                        if r2_state is not None
                        else _emitted_pin_type(item.electrical_type)
                    ),
                )
                for item in component.pins
            },
        ):
            raise CompilationParityError(f"schematic component/pins drifted: {component_id}")
    logical_pin_by_emitted = {
        (component.component_id, pin.pad_number): pin.number
        for component in graph.components
        for pin in component.pins
    }
    if r2_state is not None:
        actual_net_members = {
            frozenset(
                PinRef(
                    symbol_to_component[ref.symbol_id],
                    logical_pin_by_emitted[
                        (symbol_to_component[ref.symbol_id], ref.pin_number)
                    ],
                )
                for ref in net.pin_refs
            )
            for net in schematic.nets
        }
        expected_net_members = {frozenset(net.members) for net in graph.nets}
        if actual_net_members != expected_net_members or len(schematic.nets) != len(
            graph.nets
        ):
            raise CompilationParityError("R2 human schematic net memberships drifted")
        if (
            schematic.normalized_ir_sha256
            != parse_schematic(
                r2_state.emission.schematic_payload,
                limits=BundleLimits(),
            ).normalized_ir_sha256
        ):
            raise CompilationParityError("R2 human schematic parser IR drifted")
        return
    actual_members: dict[str, set[PinRef]] = defaultdict(set)
    actual_wire_ids: dict[str, set[str]] = defaultdict(set)
    for net in schematic.nets:
        if net.name is None:
            raise CompilationParityError("compiler emitted an unnamed schematic net")
        for ref in net.pin_refs:
            component_id = symbol_to_component[ref.symbol_id]
            actual_members[net.name].add(
                PinRef(
                    component_id,
                    logical_pin_by_emitted[(component_id, ref.pin_number)],
                )
            )
        actual_wire_ids[net.name].update(net.wire_ids)
    for net in graph.nets:
        if actual_members[net.name] != set(net.members):
            raise CompilationParityError(f"schematic pin connectivity drifted: {net.net_id}")
    wire_bindings = _binding_map(
        bindings, "schematic-wire", "schematic-wire-segment"
    )
    net_names = {item.net_id: item.name for item in graph.nets}
    source_wires = {item.wire_id: item for item in graph.schematic_wires}
    parsed_wires = {item.wire_id: item for item in schematic.wires}
    expected_parts = _wire_parts(graph)
    for source_id, target_ids in wire_bindings.items():
        source = source_wires[source_id]
        expected = {
            (target, (start.x, start.y), (end.x, end.y))
            for target, start, end in expected_parts[source_id]
        }
        actual = {
            (
                target,
                (parsed_wires[target].start.x, parsed_wires[target].start.y),
                (parsed_wires[target].end.x, parsed_wires[target].end.y),
            )
            for target in target_ids
        }
        normalized_actual = {
            (target, *sorted((start, end))) for target, start, end in actual
        }
        normalized_expected = {
            (target, *sorted((start, end))) for target, start, end in expected
        }
        if normalized_actual != normalized_expected or not set(target_ids) <= actual_wire_ids[
            net_names[source.net_id]
        ]:
            raise CompilationParityError(f"schematic wire semantics drifted: {source_id}")
    junction_ids = _binding_map(bindings, "schematic-junction", "junction")
    parsed_junctions = {item.junction_id: item for item in schematic.junctions}
    for source in graph.schematic_junctions:
        parsed = parsed_junctions[junction_ids[source.junction_id][0]]
        if DesignPoint(parsed.position.x, parsed.position.y) != source.position:
            raise CompilationParityError(
                f"schematic junction geometry drifted: {source.junction_id}"
            )


def _assert_semantic_parity(
    graph: DesignGraph,
    schematic: Schematic,
    board: Board,
    bindings: tuple[IdentityBinding, ...],
    r2_state: _R2CompilationState | None = None,
) -> None:
    _assert_board_parity(graph, board, bindings, r2_state)
    _assert_schematic_parity(graph, schematic, bindings, r2_state)


def _diagnostics_sha256(
    project: ProjectManifest,
    schematic: Schematic,
    board: Board,
) -> str:
    return hashlib.sha256(
        b"\x00".join(
            (
                project.diagnostics.manifest_sha256.encode("ascii"),
                schematic.diagnostics.manifest_sha256.encode("ascii"),
                board.diagnostics.manifest_sha256.encode("ascii"),
            )
        )
    ).hexdigest()


def compile_design_graph(graph: DesignGraph, project_stem: str) -> CompiledProject:
    """Compile a valid graph into one closed project; never touch a path or shell."""

    if type(graph) is not DesignGraph:
        raise TypeError("graph must use the exact DesignGraph type")
    if type(project_stem) is not str:
        raise TypeError("project_stem must be text")
    # This constructor is the single basename/path traversal guard.
    ProjectBundleInput(project_stem, b"", b"", b"")
    normalized = graph.normalized()
    validate_graph(normalized)
    blockers = _blockers(normalized)
    if blockers:
        raise CompilationBlockedError(blockers)

    r2_state = _prepare_r2_state(normalized, project_stem)
    board, board_bindings = _build_board(normalized, r2_state)
    board_payload = _export_kicad10_board(board)
    if r2_state is None:
        schematic_payload, schematic_bindings = _build_schematic(
            normalized,
            project_stem,
        )
        emitted_symbol_library: bytes | None = None
    else:
        schematic_payload = r2_state.emission.schematic_payload
        schematic_bindings = _human_bindings(r2_state.emission.identity_bindings)
        emitted_symbol_library = r2_state.emission.symbol_library_payload
    project_payload = _project_payload(normalized, project_stem)
    auxiliary_files, auxiliary_bindings, libraries = _build_auxiliary_files(
        normalized,
        schematic_payload,
        board_payload,
        emitted_symbol_library,
    )
    source = ProjectBundleInput(
        project_stem,
        project_payload,
        schematic_payload,
        board_payload,
        auxiliary_files,
    )
    project, schematic, reparsed_board = _parse_outputs(source)
    bindings = _merged_bindings(
        [
            *board_bindings,
            *schematic_bindings,
            *auxiliary_bindings,
            *(() if r2_state is None else _r2_evidence_bindings(r2_state)),
        ]
    )
    _assert_semantic_parity(
        normalized,
        schematic,
        reparsed_board,
        bindings,
        r2_state,
    )
    _assert_hermetic_library_parity(
        normalized,
        source,
        schematic,
        reparsed_board,
        libraries,
        r2_state,
    )

    files = tuple(
        sorted(
            tuple(
                FileDigest(
                    item.relative_name,
                    item.media_type,
                    len(item.payload),
                    item.sha256,
                )
                for item in source.all_files
            ),
            key=lambda item: (item.filename.casefold(), item.filename),
        )
    )
    manifest = CompilationManifest(
        3 if r2_state is not None else 2,
        COMPILER_ID,
        COMPILER_VERSION,
        project_stem,
        normalized.graph_hash,
        files,
        _bundle_sha256(files),
        project.normalized_ir_sha256,
        schematic.normalized_ir_sha256,
        reparsed_board.normalized_ir_sha256,
        _diagnostics_sha256(project, schematic, reparsed_board),
        bindings,
        compilation_profile_evidence=(
            None if r2_state is None else r2_state.profile.evidence
        ),
    )
    manifest_payload = _manifest_payload(manifest)
    artifact = CompiledProject(source, manifest, manifest_payload, _sha256(manifest_payload))
    verify_compiled_project(normalized, artifact)
    return artifact


def verify_compiled_project(
    graph: DesignGraph,
    artifact: CompiledProject,
) -> CompilationVerification:
    """Reparse and prove all hash, identity, geometry, and logical-connectivity bindings."""

    if type(graph) is not DesignGraph:
        raise TypeError("graph must use the exact DesignGraph type")
    if type(artifact) is not CompiledProject:
        raise TypeError("artifact must use the exact CompiledProject type")
    normalized = graph.normalized()
    validate_graph(normalized)
    blockers = _blockers(normalized)
    if blockers:
        raise CompilationBlockedError(blockers)
    r2_state = _prepare_r2_state(normalized, artifact.bundle.stem)
    if artifact.manifest.input_graph_sha256 != normalized.graph_hash:
        raise CompilationParityError("compiler manifest does not bind the supplied graph")
    if (
        artifact.manifest.compiler_id != COMPILER_ID
        or artifact.manifest.compiler_version != COMPILER_VERSION
    ):
        raise CompilationParityError("compiler identity/version binding was mutated")
    expected_schema = 3 if r2_state is not None else 2
    if artifact.manifest.schema_version != expected_schema:
        raise CompilationParityError("compiler manifest schema/profile selection drifted")
    if artifact.manifest.compilation_profile_evidence != (
        None if r2_state is None else r2_state.profile.evidence
    ):
        raise CompilationParityError("compiler profile evidence was mutated")
    expected_manifest_payload = _manifest_payload(artifact.manifest)
    if expected_manifest_payload != artifact.manifest_payload or _sha256(
        artifact.manifest_payload
    ) != artifact.manifest_sha256:
        raise CompilationParityError("compiler manifest bytes or digest were mutated")
    payloads = {item.relative_name: item.payload for item in artifact.bundle.all_files}
    for item in artifact.manifest.files:
        payload = payloads.get(item.filename)
        if payload is None or len(payload) != item.byte_length or _sha256(payload) != item.sha256:
            raise CompilationParityError(f"compiled file bytes were mutated: {item.filename}")
    if _bundle_sha256(artifact.manifest.files) != artifact.manifest.output_bundle_sha256:
        raise CompilationParityError("compiled bundle digest was mutated")
    project, schematic, board = _parse_outputs(artifact.bundle)
    libraries = parse_hermetic_project_libraries(artifact.bundle.auxiliary_files)
    if (
        project.normalized_ir_sha256,
        schematic.normalized_ir_sha256,
        board.normalized_ir_sha256,
    ) != (
        artifact.manifest.project_ir_sha256,
        artifact.manifest.schematic_ir_sha256,
        artifact.manifest.board_ir_sha256,
    ):
        raise CompilationParityError("reparsed KiCad IR hashes differ from the compiler manifest")
    if _diagnostics_sha256(project, schematic, board) != (
        artifact.manifest.diagnostics_manifest_sha256
    ):
        raise CompilationParityError("reparsed diagnostic hashes differ from the compiler manifest")
    expected_board, board_bindings = _build_board(normalized, r2_state)
    expected_board_payload = _export_kicad10_board(expected_board)
    if r2_state is None:
        expected_schematic_payload, schematic_bindings = _build_schematic(
            normalized,
            artifact.bundle.stem,
        )
        expected_symbol_library: bytes | None = None
    else:
        expected_schematic_payload = r2_state.emission.schematic_payload
        schematic_bindings = _human_bindings(r2_state.emission.identity_bindings)
        expected_symbol_library = r2_state.emission.symbol_library_payload
    expected_project_payload = _project_payload(normalized, artifact.bundle.stem)
    expected_auxiliary, auxiliary_bindings, expected_libraries = _build_auxiliary_files(
        normalized,
        expected_schematic_payload,
        expected_board_payload,
        expected_symbol_library,
    )
    if (
        artifact.bundle.project_payload,
        artifact.bundle.schematic_payload,
        artifact.bundle.board_payload,
        artifact.bundle.auxiliary_files,
    ) != (
        expected_project_payload,
        expected_schematic_payload,
        expected_board_payload,
        expected_auxiliary,
    ):
        raise CompilationParityError("compiled files differ from deterministic compiler output")
    expected_bindings = _merged_bindings(
        [
            *board_bindings,
            *schematic_bindings,
            *auxiliary_bindings,
            *(() if r2_state is None else _r2_evidence_bindings(r2_state)),
        ]
    )
    if artifact.manifest.identity_bindings != expected_bindings:
        raise CompilationParityError("identity mapping manifest was mutated")
    _assert_semantic_parity(
        normalized,
        schematic,
        board,
        expected_bindings,
        r2_state,
    )
    _assert_hermetic_library_parity(
        normalized,
        artifact.bundle,
        schematic,
        board,
        libraries,
        r2_state,
    )
    if libraries != expected_libraries:
        raise CompilationParityError("reparsed hermetic library IR drifted")
    return CompilationVerification(
        normalized.graph_hash,
        artifact.manifest_sha256,
        artifact.manifest.output_bundle_sha256,
        hashlib.sha256(
            b"\x00".join(
                (
                    project.normalized_ir_sha256.encode("ascii"),
                    schematic.normalized_ir_sha256.encode("ascii"),
                    board.normalized_ir_sha256.encode("ascii"),
                )
            )
        ).hexdigest(),
        True,
        True,
    )

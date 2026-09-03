"""Fail-closed KiCad 10 PCB subset importer, exporter, and parity evidence."""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import Enum

from .errors import KiCadInvariantError, KiCadSyntaxError, UnsupportedConstructError
from .model import (
    Board,
    DiagnosticConstruct,
    DiagnosticDisposition,
    DiagnosticsManifest,
    ExportEvidence,
    Footprint,
    ImportEvidence,
    Layer,
    Net,
    OutlineEdge,
    Pad,
    PadKind,
    PadShape,
    PointNm,
    RoundTripEvidence,
    Segment,
    Via,
    ViaKind,
    Zone,
    canonical_net_id,
)
from .sexpr import (
    Atom,
    Quoted,
    SExpr,
    canonical_text,
    head,
    node,
    parse,
    render,
    scalar_text,
)

PARSER_ID = "flux-clone-kicad-pcb-subset-v2"
WRITER_ID = "flux-clone-kicad-pcb-writer-v2"
_UUID_NAMESPACE = uuid.UUID("07dc3093-2bbd-5ef8-96a0-8e5ea82dfe1b")
_INTEGER = re.compile(r"0|[1-9][0-9]*")


class UnsupportedPolicy(str, Enum):
    REJECT = "reject"
    MANIFEST = "manifest"


@dataclass(frozen=True, slots=True)
class ImportResult:
    board: Board
    evidence: ImportEvidence


@dataclass(frozen=True, slots=True)
class ExportResult:
    payload: bytes
    evidence: ExportEvidence


@dataclass(frozen=True, slots=True)
class RoundTripResult:
    imported: ImportResult
    exported: ExportResult
    reparsed: ImportResult
    evidence: RoundTripEvidence


class _Recorder:
    def __init__(self) -> None:
        self._items: list[DiagnosticConstruct] = []
        self._counts: dict[tuple[str, str], int] = {}

    def record(
        self,
        expression: SExpr,
        *,
        scope: str,
        disposition: DiagnosticDisposition,
        reason: str,
    ) -> None:
        expression_head = head(expression) or "atom"
        key = (scope, expression_head)
        occurrence = self._counts.get(key, 0)
        self._counts[key] = occurrence + 1
        body = canonical_text(expression)
        self._items.append(
            DiagnosticConstruct(
                scope,
                f"{expression_head}[{occurrence}]",
                expression_head,
                disposition,
                reason,
                body,
                hashlib.sha256(body.encode("utf-8")).hexdigest(),
            )
        )

    def manifest(self) -> DiagnosticsManifest:
        return DiagnosticsManifest(tuple(self._items)).normalized()


def import_board(
    source: bytes,
    *,
    unsupported_policy: UnsupportedPolicy = UnsupportedPolicy.REJECT,
) -> ImportResult:
    """Import one KiCad 10-declared PCB file into exact integer geometry.

    ``REJECT`` is the production-safe default. ``MANIFEST`` is intended for a
    review UI: it retains every opaque expression in the digest-bound manifest,
    while downstream release code can continue to block on ``manifest.unsupported``.
    No KiCad process is invoked by this function.
    """

    if not isinstance(unsupported_policy, UnsupportedPolicy):
        raise TypeError("unsupported_policy must be an UnsupportedPolicy")
    root = parse(source)
    if not isinstance(root, tuple) or head(root) != "kicad_pcb":
        raise KiCadSyntaxError("KiCad PCB root must be '(kicad_pcb ...)'")

    recorder = _Recorder()
    version = _required_integer_child(root, "version", label="KiCad format version")
    generator = _required_scalar_child(root, "generator", label="KiCad generator")
    generator_version = _optional_scalar_child(root, "generator_version")
    if generator_version is None or _major_version(generator_version) != 10:
        raise KiCadInvariantError(
            "project must declare generator_version 10.x for this KiCad 10 exchange boundary"
        )

    layers_node = _required_child(root, "layers")
    layers = _parse_layers(layers_node)
    source_nets, nets = _parse_nets(root)

    outline: list[OutlineEdge] = []
    footprints: list[Footprint] = []
    segments: list[Segment] = []
    vias: list[Via] = []
    zones: list[Zone] = []

    modeled_root_heads = {
        "version",
        "generator",
        "generator_version",
        "layers",
        "net",
    }
    preserved_root_heads = {
        "general",
        "paper",
        "setup",
        "embedded_fonts",
        "gr_text",
        "dimension",
        "image",
        "group",
        "target",
    }
    for index, expression in enumerate(root[1:]):
        expression_head = head(expression)
        if expression_head in modeled_root_heads:
            continue
        if expression_head == "footprint":
            footprints.append(_parse_footprint(expression, source_nets, recorder, index))
            continue
        if expression_head == "segment":
            segments.append(_parse_segment(expression, source_nets, recorder, index))
            continue
        if expression_head == "via":
            vias.append(_parse_via(expression, source_nets, recorder, index))
            continue
        if expression_head == "zone":
            zone = _parse_zone(expression, source_nets, recorder, index)
            if zone is not None:
                zones.append(zone)
            continue
        if expression_head == "gr_line":
            layer_name = _optional_scalar_child(expression, "layer")
            if layer_name == "Edge.Cuts":
                outline.append(_parse_outline_edge(expression, recorder, index))
            else:
                recorder.record(
                    expression,
                    scope="root",
                    disposition=DiagnosticDisposition.PRESERVED,
                    reason=(
                        "non-Edge.Cuts graphical line is syntax-preserved "
                        "but not in the ECAD IR"
                    ),
                )
            continue
        if expression_head in {"gr_arc", "gr_rect", "gr_poly", "gr_curve"}:
            disposition = (
                DiagnosticDisposition.UNSUPPORTED
                if _optional_scalar_child(expression, "layer") == "Edge.Cuts"
                else DiagnosticDisposition.PRESERVED
            )
            recorder.record(
                expression,
                scope="root",
                disposition=disposition,
                reason=(
                    "non-linear or compound Edge.Cuts primitives are unsupported"
                    if disposition is DiagnosticDisposition.UNSUPPORTED
                    else "non-outline graphical primitive is syntax-preserved"
                ),
            )
            continue
        if expression_head in preserved_root_heads:
            recorder.record(
                expression,
                scope="root",
                disposition=DiagnosticDisposition.PRESERVED,
                reason="top-level metadata or presentation syntax is preserved outside the ECAD IR",
            )
            continue
        recorder.record(
            expression,
            scope="root",
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="top-level construct is outside the supported deterministic subset",
        )

    manifest = recorder.manifest()
    board = Board(
        version,
        generator,
        generator_version,
        layers,
        nets,
        tuple(outline),
        tuple(footprints),
        tuple(segments),
        tuple(vias),
        tuple(zones),
        manifest,
    ).normalized()
    evidence = ImportEvidence(
        hashlib.sha256(source).hexdigest(),
        board.normalized_ir_sha256,
        manifest.manifest_sha256,
        PARSER_ID,
    )
    if manifest.unsupported and unsupported_policy is UnsupportedPolicy.REJECT:
        summaries = ", ".join(
            f"{item.scope}/{item.path}" for item in manifest.unsupported[:5]
        )
        if len(manifest.unsupported) > 5:
            summaries += f", +{len(manifest.unsupported) - 5} more"
        raise UnsupportedConstructError(
            f"unsupported KiCad constructs require review: {summaries}",
            manifest_sha256=manifest.manifest_sha256,
            diagnostics=manifest.unsupported,
        )
    return ImportResult(board, evidence)


def _parse_layers(expression: tuple[SExpr, ...]) -> tuple[Layer, ...]:
    layers: list[Layer] = []
    for index, entry in enumerate(expression[1:]):
        if not isinstance(entry, tuple) or len(entry) not in {3, 4}:
            raise KiCadSyntaxError(
                f"layers[{index}] must have ordinal, name, kind, and optional user name"
            )
        ordinal_text = scalar_text(entry[0], label=f"layers[{index}] ordinal")
        if _INTEGER.fullmatch(ordinal_text) is None:
            raise KiCadSyntaxError(f"layers[{index}] ordinal must be a non-negative integer")
        name = scalar_text(entry[1], label=f"layers[{index}] name")
        kind = scalar_text(entry[2], label=f"layers[{index}] kind")
        user_name = (
            scalar_text(entry[3], label=f"layers[{index}] user name")
            if len(entry) == 4
            else None
        )
        layers.append(Layer(int(ordinal_text), name, kind, user_name))
    return tuple(layers)


def _parse_nets(root: tuple[SExpr, ...]) -> tuple[dict[int, Net | None], tuple[Net, ...]]:
    source_map: dict[int, Net | None] = {}
    nets: list[Net] = []
    for index, expression in enumerate(_children(root, "net")):
        if len(expression) != 3:
            raise KiCadSyntaxError(f"net[{index}] must contain code and name")
        code_text = scalar_text(expression[1], label=f"net[{index}] code")
        if _INTEGER.fullmatch(code_text) is None:
            raise KiCadSyntaxError(f"net[{index}] code must be a non-negative integer")
        code = int(code_text)
        name = scalar_text(expression[2], label=f"net[{index}] name")
        if code in source_map:
            raise KiCadInvariantError(f"duplicate KiCad net code {code}")
        if code == 0:
            if name:
                raise KiCadInvariantError("KiCad net code 0 must have an empty name")
            source_map[code] = None
            continue
        net = Net(canonical_net_id(name), name)
        source_map[code] = net
        nets.append(net)
    if 0 not in source_map:
        source_map[0] = None
    return source_map, tuple(nets)


def _parse_footprint(
    expression: SExpr,
    source_nets: dict[int, Net | None],
    recorder: _Recorder,
    index: int,
) -> Footprint:
    value = _as_list(expression, "footprint")
    if len(value) < 2:
        raise KiCadSyntaxError("footprint requires a library identifier")
    library_id = scalar_text(value[1], label="footprint library ID")
    layer = _required_scalar_child(value, "layer", label="footprint layer")
    position, rotation = _parse_at(_required_child(value, "at"), label="footprint at")
    footprint_id = _entity_uuid(value, seed=f"footprint:{index}:{canonical_text(value)}")
    scope = f"footprint:{footprint_id}"

    properties: dict[str, tuple[SExpr, ...]] = {}
    for property_node in _children(value, "property"):
        if len(property_node) < 3:
            raise KiCadSyntaxError("footprint property requires name and value")
        property_name = scalar_text(property_node[1], label="footprint property name")
        if property_name in properties:
            raise KiCadInvariantError(f"duplicate footprint property {property_name!r}")
        properties[property_name] = property_node
        if property_name not in {"Reference", "Value"}:
            recorder.record(
                property_node,
                scope=scope,
                disposition=DiagnosticDisposition.PRESERVED,
                reason="non-identity footprint property is syntax-preserved",
            )
            continue
        property_scope = f"{scope}:property:{property_name}"
        for tail in property_node[3:]:
            recorder.record(
                tail,
                scope=property_scope,
                disposition=DiagnosticDisposition.PRESERVED,
                reason="property rendering metadata is syntax-preserved",
            )
    if "Reference" not in properties or "Value" not in properties:
        raise KiCadInvariantError("footprint requires Reference and Value properties")
    reference = scalar_text(properties["Reference"][2], label="footprint Reference")
    footprint_value = scalar_text(properties["Value"][2], label="footprint Value")

    attributes: tuple[str, ...] = ()
    attribute_node = _optional_child(value, "attr")
    if attribute_node is not None:
        attributes = tuple(
            scalar_text(item, label="footprint attribute") for item in attribute_node[1:]
        )
    pads = tuple(
        _parse_pad(item, footprint_id, source_nets, recorder, pad_index)
        for pad_index, item in enumerate(_children(value, "pad"))
    )

    known = {"layer", "uuid", "at", "property", "attr", "pad", "locked"}
    presentation = {
        "descr",
        "tags",
        "path",
        "sheetname",
        "sheetfile",
        "fp_text",
        "fp_line",
        "fp_rect",
        "fp_circle",
        "fp_arc",
        "fp_poly",
        "model",
        "embedded_fonts",
    }
    for child in value[2:]:
        child_head = head(child)
        if child_head in known:
            continue
        if child_head in presentation:
            recorder.record(
                child,
                scope=scope,
                disposition=DiagnosticDisposition.PRESERVED,
                reason="footprint presentation/library metadata is syntax-preserved",
            )
            continue
        if isinstance(child, Atom) and child.value == "locked":
            continue
        recorder.record(
            child,
            scope=scope,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="footprint construct may affect fabrication but is not modeled",
        )
    return Footprint(
        footprint_id,
        library_id,
        reference,
        footprint_value,
        layer,
        position,
        rotation,
        pads,
        attributes,
        _parse_locked(value),
    )


def _parse_pad(
    expression: tuple[SExpr, ...],
    footprint_id: str,
    source_nets: dict[int, Net | None],
    recorder: _Recorder,
    index: int,
) -> Pad:
    if len(expression) < 4:
        raise KiCadSyntaxError("pad requires number, kind, and shape")
    number = scalar_text(expression[1], label="pad number")
    try:
        kind = PadKind(scalar_text(expression[2], label="pad kind"))
        shape = PadShape(scalar_text(expression[3], label="pad shape"))
    except ValueError as exc:
        raise KiCadInvariantError("pad kind or shape is outside the supported subset") from exc
    position, rotation = _parse_at(_required_child(expression, "at"), label="pad at")
    size = _required_child(expression, "size")
    if len(size) != 3:
        raise KiCadSyntaxError("pad size requires x and y")
    size_x = _millimetres_to_nm(size[1], label="pad x size")
    size_y = _millimetres_to_nm(size[2], label="pad y size")
    drill_x = 0
    drill_y = 0
    drill = _optional_child(expression, "drill")
    if kind in {PadKind.THROUGH_HOLE, PadKind.NPTH}:
        if drill is None:
            raise KiCadInvariantError("through-hole and NPTH pads require drill geometry")
        drill_values = list(drill[1:])
        oval = bool(
            drill_values
            and isinstance(drill_values[0], Atom)
            and drill_values[0].value == "oval"
        )
        if oval:
            drill_values.pop(0)
        nested = tuple(item for item in drill_values if isinstance(item, tuple))
        if any(head(item) == "offset" for item in nested):
            raise KiCadInvariantError(
                "pad drill offsets are unsupported; drill and pad centers must coincide"
            )
        if any(head(item) in {"angle", "rotate", "rotation"} for item in nested):
            raise KiCadInvariantError(
                "independent drill rotation is unsupported; KiCad drill orientation "
                "must inherit the pad at-angle"
            )
        if nested:
            raise KiCadSyntaxError("pad drill contains an unsupported nested construct")
        if oval and len(drill_values) != 2:
            raise KiCadSyntaxError("oval pad drill requires exact x and y dimensions")
        if not oval and len(drill_values) != 1:
            raise KiCadSyntaxError(
                "circular pad drill requires one diameter; two dimensions require 'oval'"
            )
        drill_x = _millimetres_to_nm(drill_values[0], label="pad x drill")
        drill_y = (
            _millimetres_to_nm(drill_values[1], label="pad y drill")
            if oval
            else drill_x
        )
        if oval and drill_x == drill_y:
            raise KiCadInvariantError(
                "an oval drill must have distinct x/y dimensions; use circular syntax otherwise"
            )
    elif drill is not None:
        raise KiCadInvariantError("SMD pad cannot carry drill geometry")
    layers_node = _required_child(expression, "layers")
    layers = tuple(scalar_text(item, label="pad layer") for item in layers_node[1:])

    net_id: str | None = None
    net_node = _optional_child(expression, "net")
    if net_node is not None:
        if kind is PadKind.NPTH:
            raise KiCadInvariantError("NPTH pads cannot contain a net claim, including net 0")
        if len(net_node) not in {2, 3}:
            raise KiCadSyntaxError("pad net requires code and optional name")
        net = _net_for_code(net_node[1], source_nets, label="pad net")
        net_id = net.net_id if net is not None else None
        if net is not None and len(net_node) == 3:
            supplied_name = scalar_text(net_node[2], label="pad net name")
            if supplied_name != net.name:
                raise KiCadInvariantError("pad net code/name pair is inconsistent")
    pin_function = _optional_scalar_child(expression, "pinfunction")
    pin_type = _optional_scalar_child(expression, "pintype")
    if kind is PadKind.NPTH and (pin_function is not None or pin_type is not None):
        raise KiCadInvariantError("NPTH pads cannot contain schematic pin metadata")
    ratio_node = _optional_child(expression, "roundrect_rratio")
    ratio = (
        _decimal_to_scaled(ratio_node[1], 1_000_000, label="roundrect ratio")
        if ratio_node is not None and len(ratio_node) == 2
        else None
    )
    if ratio_node is not None and len(ratio_node) != 2:
        raise KiCadSyntaxError("roundrect_rratio requires one value")

    pad_id = _entity_uuid(
        expression,
        seed=f"pad:{footprint_id}:{index}:{canonical_text(expression)}",
    )
    scope = f"pad:{pad_id}"
    known = {
        "at",
        "size",
        "drill",
        "layers",
        "net",
        "pinfunction",
        "pintype",
        "roundrect_rratio",
        "uuid",
        "locked",
    }
    for child in expression[4:]:
        if head(child) in known or (isinstance(child, Atom) and child.value == "locked"):
            continue
        recorder.record(
            child,
            scope=scope,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason=(
                "pad construct may affect copper, mask, paste, or fabrication "
                "and is not modeled"
            ),
        )
    return Pad(
        pad_id=pad_id,
        number=number,
        kind=kind,
        shape=shape,
        position=position,
        rotation_udeg=rotation,
        size_x_nm=size_x,
        size_y_nm=size_y,
        drill_x_nm=drill_x,
        drill_y_nm=drill_y,
        layers=layers,
        net_id=net_id,
        pin_function=pin_function,
        pin_type=pin_type,
        roundrect_ratio_ppm=ratio,
        locked=_parse_locked(expression),
    )


def _parse_outline_edge(
    expression: SExpr,
    recorder: _Recorder,
    index: int,
) -> OutlineEdge:
    value = _as_list(expression, "gr_line")
    start = _parse_xy_pair(_required_child(value, "start"), label="outline start")
    end = _parse_xy_pair(_required_child(value, "end"), label="outline end")
    stroke = _required_child(value, "stroke")
    width = _millimetres_to_nm(
        _required_child(stroke, "width")[1], label="outline stroke width"
    )
    stroke_type = _required_scalar_child(stroke, "type", label="outline stroke type")
    edge_id = _entity_uuid(value, seed=f"outline:{index}:{canonical_text(value)}")
    scope = f"outline-edge:{edge_id}"
    for child in stroke[1:]:
        if head(child) not in {"width", "type"}:
            recorder.record(
                child,
                scope=f"{scope}:stroke",
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason="outline stroke construct is not modeled",
            )
    known = {"start", "end", "stroke", "layer", "uuid", "locked"}
    for child in value[1:]:
        if head(child) in known or (isinstance(child, Atom) and child.value == "locked"):
            continue
        recorder.record(
            child,
            scope=scope,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="Edge.Cuts line construct is not modeled",
        )
    return OutlineEdge(
        edge_id,
        start,
        end,
        width,
        stroke_type,
        _parse_locked(value),
    )


def _parse_segment(
    expression: SExpr,
    source_nets: dict[int, Net | None],
    recorder: _Recorder,
    index: int,
) -> Segment:
    value = _as_list(expression, "segment")
    start = _parse_xy_pair(_required_child(value, "start"), label="segment start")
    end = _parse_xy_pair(_required_child(value, "end"), label="segment end")
    width_node = _required_child(value, "width")
    if len(width_node) != 2:
        raise KiCadSyntaxError("segment width requires one value")
    width = _millimetres_to_nm(width_node[1], label="segment width")
    layer = _required_scalar_child(value, "layer", label="segment layer")
    net = _net_for_code(
        _required_child(value, "net")[1], source_nets, label="segment net"
    )
    if net is None:
        raise KiCadInvariantError("routed segment cannot reference unconnected net code 0")
    segment_id = _entity_uuid(value, seed=f"segment:{index}:{canonical_text(value)}")
    scope = f"segment:{segment_id}"
    known = {"start", "end", "width", "layer", "net", "uuid", "locked"}
    for child in value[1:]:
        if head(child) in known or (isinstance(child, Atom) and child.value == "locked"):
            continue
        recorder.record(
            child,
            scope=scope,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="segment construct may change copper geometry and is not modeled",
        )
    return Segment(
        segment_id,
        net.net_id,
        layer,
        start,
        end,
        width,
        _parse_locked(value),
    )


def _parse_via(
    expression: SExpr,
    source_nets: dict[int, Net | None],
    recorder: _Recorder,
    index: int,
) -> Via:
    value = _as_list(expression, "via")
    center = _parse_xy_pair(_required_child(value, "at"), label="via at")
    size_node = _required_child(value, "size")
    drill_node = _required_child(value, "drill")
    if len(size_node) != 2 or len(drill_node) != 2:
        raise KiCadSyntaxError("via size and drill require one value each")
    diameter = _millimetres_to_nm(size_node[1], label="via diameter")
    drill = _millimetres_to_nm(drill_node[1], label="via drill")
    layers_node = _required_child(value, "layers")
    layers = tuple(scalar_text(item, label="via layer") for item in layers_node[1:])
    net = _net_for_code(_required_child(value, "net")[1], source_nets, label="via net")
    if net is None:
        raise KiCadInvariantError("via cannot reference unconnected net code 0")
    atoms = {
        item.value for item in value[1:] if isinstance(item, Atom)
    }
    via_kinds = atoms & {"blind", "micro"}
    if len(via_kinds) > 1:
        raise KiCadInvariantError("via cannot be both blind and micro")
    kind = (
        ViaKind.BLIND
        if "blind" in via_kinds
        else ViaKind.MICRO
        if "micro" in via_kinds
        else ViaKind.THROUGH
    )
    via_id = _entity_uuid(value, seed=f"via:{index}:{canonical_text(value)}")
    scope = f"via:{via_id}"
    known = {"at", "size", "drill", "layers", "net", "uuid", "locked"}
    for child in value[1:]:
        if head(child) in known:
            continue
        if isinstance(child, Atom) and child.value in {"blind", "micro", "locked"}:
            continue
        recorder.record(
            child,
            scope=scope,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="via construct may change copper or drill geometry and is not modeled",
        )
    return Via(
        via_id,
        net.net_id,
        center,
        diameter,
        drill,
        layers,
        kind,
        _parse_locked(value),
    )


def _parse_zone(
    expression: SExpr,
    source_nets: dict[int, Net | None],
    recorder: _Recorder,
    index: int,
) -> Zone | None:
    value = _as_list(expression, "zone")
    net = _net_for_code(_required_child(value, "net")[1], source_nets, label="zone net")
    if net is None:
        recorder.record(
            value,
            scope="root",
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="unconnected/rule-area zones are preserved opaque and not flattened",
        )
        return None
    supplied_name = _required_scalar_child(value, "net_name", label="zone net name")
    if supplied_name != net.name:
        raise KiCadInvariantError("zone net code/name pair is inconsistent")

    layer_nodes = _children(value, "layer")
    layers_nodes = _children(value, "layers")
    if len(layer_nodes) == 1 and not layers_nodes:
        layer = scalar_text(layer_nodes[0][1], label="zone layer")
    elif not layer_nodes and len(layers_nodes) == 1 and len(layers_nodes[0]) == 2:
        layer = scalar_text(layers_nodes[0][1], label="zone layer")
    else:
        recorder.record(
            value,
            scope="root",
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="multi-layer or malformed zones are preserved opaque and not flattened",
        )
        return None

    hatch = _required_child(value, "hatch")
    if len(hatch) != 3:
        raise KiCadSyntaxError("zone hatch requires style and pitch")
    hatch_style = scalar_text(hatch[1], label="zone hatch style")
    hatch_pitch = _millimetres_to_nm(hatch[2], label="zone hatch pitch")
    minimum_node = _required_child(value, "min_thickness")
    if len(minimum_node) != 2:
        raise KiCadSyntaxError("zone min_thickness requires one value")
    minimum = _millimetres_to_nm(minimum_node[1], label="zone minimum thickness")

    connect = _required_child(value, "connect_pads")
    clearance_node = _required_child(connect, "clearance")
    if len(clearance_node) != 2:
        raise KiCadSyntaxError("zone connect_pads clearance requires one value")
    clearance = _millimetres_to_nm(clearance_node[1], label="zone clearance")
    zone_id = _entity_uuid(value, seed=f"zone:{index}:{canonical_text(value)}")
    scope = f"zone:{zone_id}"
    for connect_child in connect[1:]:
        if head(connect_child) == "clearance":
            continue
        recorder.record(
            connect_child,
            scope=f"{scope}:connect_pads",
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="zone thermal-spoke/connectivity mode is preserved, never flattened",
        )

    polygons = _children(value, "polygon")
    if not polygons:
        raise KiCadInvariantError("zone requires an explicit polygon boundary")
    boundary = _parse_polygon(polygons[0], recorder, f"{scope}:polygon")
    for extra_polygon in polygons[1:]:
        recorder.record(
            extra_polygon,
            scope=scope,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason="additional zone polygon/hole is preserved, never flattened into the outer ring",
        )

    known = {
        "net",
        "net_name",
        "layer",
        "layers",
        "uuid",
        "name",
        "hatch",
        "connect_pads",
        "min_thickness",
        "polygon",
    }
    thermal_heads = {"fill", "filled_polygon", "fill_segments", "keepout"}
    for child in value[1:]:
        child_head = head(child)
        if child_head in known:
            continue
        recorder.record(
            child,
            scope=scope,
            disposition=DiagnosticDisposition.UNSUPPORTED,
            reason=(
                "zone fill, holes, keepout, or thermal-spoke geometry is preserved, never flattened"
                if child_head in thermal_heads
                else "zone construct is outside the modeled subset"
            ),
        )
    name = _optional_scalar_child(value, "name")
    return Zone(
        zone_id,
        net.net_id,
        net.name,
        layer,
        boundary,
        clearance,
        minimum,
        hatch_style,
        hatch_pitch,
        name,
    )


def _parse_polygon(
    expression: tuple[SExpr, ...],
    recorder: _Recorder,
    scope: str,
) -> tuple[PointNm, ...]:
    points_node = _required_child(expression, "pts")
    points: list[PointNm] = []
    for child in points_node[1:]:
        if isinstance(child, tuple) and head(child) == "xy":
            points.append(_parse_xy_pair(child, label="zone polygon point"))
        else:
            recorder.record(
                child,
                scope=f"{scope}:pts",
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason="zone polygon primitive is not an xy vertex",
            )
    for child in expression[1:]:
        if head(child) != "pts":
            recorder.record(
                child,
                scope=scope,
                disposition=DiagnosticDisposition.UNSUPPORTED,
                reason="zone polygon metadata is not modeled",
            )
    return tuple(points)


def _as_list(expression: SExpr, label: str) -> tuple[SExpr, ...]:
    if not isinstance(expression, tuple) or head(expression) != label:
        raise KiCadSyntaxError(f"{label} must be a list expression")
    return expression


def _children(expression: tuple[SExpr, ...], wanted_head: str) -> tuple[tuple[SExpr, ...], ...]:
    return tuple(
        child
        for child in expression[1:]
        if isinstance(child, tuple) and head(child) == wanted_head
    )


def _required_child(expression: tuple[SExpr, ...], wanted_head: str) -> tuple[SExpr, ...]:
    matches = _children(expression, wanted_head)
    if len(matches) != 1:
        raise KiCadSyntaxError(
            f"{head(expression) or 'expression'} requires exactly one {wanted_head} child"
        )
    return matches[0]


def _optional_child(
    expression: tuple[SExpr, ...], wanted_head: str
) -> tuple[SExpr, ...] | None:
    matches = _children(expression, wanted_head)
    if len(matches) > 1:
        raise KiCadSyntaxError(
            f"{head(expression) or 'expression'} allows at most one {wanted_head} child"
        )
    return matches[0] if matches else None


def _required_scalar_child(
    expression: tuple[SExpr, ...], wanted_head: str, *, label: str
) -> str:
    child = _required_child(expression, wanted_head)
    if len(child) != 2:
        raise KiCadSyntaxError(f"{label} requires exactly one value")
    return scalar_text(child[1], label=label)


def _optional_scalar_child(expression: SExpr, wanted_head: str) -> str | None:
    value = _as_list(expression, head(expression) or "expression")
    child = _optional_child(value, wanted_head)
    if child is None:
        return None
    if len(child) != 2:
        raise KiCadSyntaxError(f"{wanted_head} requires exactly one value")
    return scalar_text(child[1], label=wanted_head)


def _required_integer_child(
    expression: tuple[SExpr, ...], wanted_head: str, *, label: str
) -> int:
    value = _required_scalar_child(expression, wanted_head, label=label)
    if _INTEGER.fullmatch(value) is None:
        raise KiCadSyntaxError(f"{label} must be a non-negative integer")
    return int(value)


def _major_version(value: str) -> int | None:
    match = re.fullmatch(r"([0-9]+)(?:\.[0-9A-Za-z.+-]+)*", value)
    return int(match.group(1)) if match is not None else None


def _decimal_to_scaled(expression: SExpr, scale: int, *, label: str) -> int:
    text = scalar_text(expression, label=label)
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        raise KiCadSyntaxError(f"{label} must be a finite decimal") from exc
    if not value.is_finite():
        raise KiCadSyntaxError(f"{label} must be a finite decimal")
    scaled = value * scale
    integral = scaled.to_integral_value()
    if scaled != integral:
        raise KiCadInvariantError(f"{label} is finer than the exact supported resolution")
    result = int(integral)
    if not -(1 << 63) <= result <= (1 << 63) - 1:
        raise KiCadInvariantError(f"{label} exceeds signed 64-bit geometry")
    return 0 if result == 0 else result


def _millimetres_to_nm(expression: SExpr, *, label: str) -> int:
    return _decimal_to_scaled(expression, 1_000_000, label=label)


def _parse_xy_pair(expression: tuple[SExpr, ...], *, label: str) -> PointNm:
    if len(expression) != 3:
        raise KiCadSyntaxError(f"{label} requires x and y")
    return PointNm(
        _millimetres_to_nm(expression[1], label=f"{label} x"),
        _millimetres_to_nm(expression[2], label=f"{label} y"),
    )


def _parse_at(expression: tuple[SExpr, ...], *, label: str) -> tuple[PointNm, int]:
    if len(expression) not in {3, 4}:
        raise KiCadSyntaxError(f"{label} requires x, y, and optional rotation")
    point = PointNm(
        _millimetres_to_nm(expression[1], label=f"{label} x"),
        _millimetres_to_nm(expression[2], label=f"{label} y"),
    )
    rotation = (
        _decimal_to_scaled(expression[3], 1_000_000, label=f"{label} rotation")
        if len(expression) == 4
        else 0
    )
    return point, rotation % 360_000_000


def _entity_uuid(expression: tuple[SExpr, ...], *, seed: str) -> str:
    uuid_node = _optional_child(expression, "uuid")
    if uuid_node is None:
        return str(uuid.uuid5(_UUID_NAMESPACE, seed))
    if len(uuid_node) != 2:
        raise KiCadSyntaxError("uuid requires exactly one value")
    value = scalar_text(uuid_node[1], label="entity UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise KiCadInvariantError("entity UUID is invalid") from exc
    if str(parsed) != value:
        raise KiCadInvariantError("entity UUID must use canonical lowercase syntax")
    return value


def _parse_locked(expression: tuple[SExpr, ...]) -> bool:
    if any(isinstance(item, Atom) and item.value == "locked" for item in expression[1:]):
        return True
    locked = _optional_child(expression, "locked")
    if locked is None:
        return False
    if len(locked) != 2:
        raise KiCadSyntaxError("locked requires yes or no")
    value = scalar_text(locked[1], label="locked")
    if value not in {"yes", "no"}:
        raise KiCadSyntaxError("locked must be yes or no")
    return value == "yes"


def _net_for_code(
    expression: SExpr,
    source_nets: dict[int, Net | None],
    *,
    label: str,
) -> Net | None:
    text = scalar_text(expression, label=label)
    if _INTEGER.fullmatch(text) is None:
        raise KiCadSyntaxError(f"{label} code must be a non-negative integer")
    code = int(text)
    if code not in source_nets:
        raise KiCadInvariantError(f"{label} references undeclared KiCad net code {code}")
    return source_nets[code]


def export_board(
    board: Board,
    *,
    preserve_unsupported: bool = False,
) -> ExportResult:
    """Serialize the normalized subset with digest-bound evidence.

    Unsupported expressions are never silently emitted: callers must opt into
    exact canonical preservation. Preserved presentation/metadata expressions
    are always emitted because they are already classified as lossless opaque
    data. This function never invokes KiCad and its evidence says so explicitly.
    """

    if not isinstance(board, Board):
        raise TypeError("board must be a KiCad exchange Board")
    if not isinstance(preserve_unsupported, bool):
        raise TypeError("preserve_unsupported must be a boolean")
    normalized = board.normalized()
    unsupported = normalized.diagnostics.unsupported
    if unsupported and not preserve_unsupported:
        raise UnsupportedConstructError(
            "export is blocked because the diagnostics manifest contains unsupported constructs",
            manifest_sha256=normalized.diagnostics.manifest_sha256,
            diagnostics=unsupported,
        )
    if normalized.generator_version is None or _major_version(normalized.generator_version) != 10:
        raise KiCadInvariantError("export requires a declared KiCad generator_version 10.x")

    net_codes = {
        net.net_id: index for index, net in enumerate(normalized.nets, start=1)
    }
    children: list[SExpr] = [
        node("version", Atom(str(normalized.format_version))),
        node("generator", Atom(normalized.generator)),
        node("generator_version", Atom(normalized.generator_version)),
        _export_layers(normalized.layers),
        node("net", Atom("0"), Quoted("")),
    ]
    children.extend(
        node("net", Atom(str(net_codes[net.net_id])), Quoted(net.name))
        for net in normalized.nets
    )
    children.extend(
        _export_footprint(item, net_codes, normalized.diagnostics, preserve_unsupported)
        for item in normalized.footprints
    )
    children.extend(
        _export_outline_edge(item, normalized.diagnostics, preserve_unsupported)
        for item in normalized.outline_edges
    )
    children.extend(
        _export_segment(item, net_codes, normalized.diagnostics, preserve_unsupported)
        for item in normalized.segments
    )
    children.extend(
        _export_via(item, net_codes, normalized.diagnostics, preserve_unsupported)
        for item in normalized.vias
    )
    children.extend(
        _export_zone(item, net_codes, normalized.diagnostics, preserve_unsupported)
        for item in normalized.zones
    )
    children.extend(
        _opaque_for_scope(
            normalized.diagnostics,
            "root",
            preserve_unsupported=preserve_unsupported,
        )
    )
    payload = render(node("kicad_pcb", *children))
    evidence = ExportEvidence(
        normalized.normalized_ir_sha256,
        hashlib.sha256(payload).hexdigest(),
        normalized.diagnostics.manifest_sha256,
        WRITER_ID,
        bool(unsupported),
    )
    return ExportResult(payload, evidence)


def round_trip(
    source: bytes,
    *,
    unsupported_policy: UnsupportedPolicy = UnsupportedPolicy.REJECT,
) -> RoundTripResult:
    """Import, deterministically export, re-import, and bind parity evidence."""

    imported = import_board(source, unsupported_policy=unsupported_policy)
    exported = export_board(
        imported.board,
        preserve_unsupported=unsupported_policy is UnsupportedPolicy.MANIFEST,
    )
    reparsed = import_board(exported.payload, unsupported_policy=unsupported_policy)
    evidence = RoundTripEvidence(
        imported.evidence.source_sha256,
        imported.evidence.normalized_ir_sha256,
        exported.evidence.exported_sha256,
        reparsed.evidence.normalized_ir_sha256,
        imported.evidence.diagnostics_manifest_sha256,
        reparsed.evidence.diagnostics_manifest_sha256,
        imported.evidence.normalized_ir_sha256 == reparsed.evidence.normalized_ir_sha256,
        imported.evidence.diagnostics_manifest_sha256
        == reparsed.evidence.diagnostics_manifest_sha256,
    )
    return RoundTripResult(imported, exported, reparsed, evidence)


def _export_layers(layers: tuple[Layer, ...]) -> tuple[SExpr, ...]:
    entries: list[SExpr] = []
    for layer in layers:
        values: list[SExpr] = [
            Atom(str(layer.ordinal)),
            Quoted(layer.name),
            Atom(layer.kind),
        ]
        if layer.user_name is not None:
            values.append(Quoted(layer.user_name))
        entries.append(tuple(values))
    return node("layers", *entries)


def _export_footprint(
    footprint: Footprint,
    net_codes: dict[str, int],
    manifest: DiagnosticsManifest,
    preserve_unsupported: bool,
) -> tuple[SExpr, ...]:
    scope = f"footprint:{footprint.footprint_id}"
    children: list[SExpr] = [
        Quoted(footprint.library_id),
        node("layer", Quoted(footprint.layer)),
        node("uuid", Atom(footprint.footprint_id)),
        _at_node(footprint.position, footprint.rotation_udeg),
        node(
            "property",
            Quoted("Reference"),
            Quoted(footprint.reference),
            *_opaque_for_scope(
                manifest,
                f"{scope}:property:Reference",
                preserve_unsupported=preserve_unsupported,
            ),
        ),
        node(
            "property",
            Quoted("Value"),
            Quoted(footprint.value),
            *_opaque_for_scope(
                manifest,
                f"{scope}:property:Value",
                preserve_unsupported=preserve_unsupported,
            ),
        ),
    ]
    if footprint.attributes:
        children.append(node("attr", *(Atom(item) for item in footprint.attributes)))
    if footprint.locked:
        children.append(node("locked", Atom("yes")))
    children.extend(
        _export_pad(item, net_codes, manifest, preserve_unsupported)
        for item in footprint.pads
    )
    children.extend(
        _opaque_for_scope(manifest, scope, preserve_unsupported=preserve_unsupported)
    )
    return node("footprint", *children)


def _export_pad(
    pad: Pad,
    net_codes: dict[str, int],
    manifest: DiagnosticsManifest,
    preserve_unsupported: bool,
) -> tuple[SExpr, ...]:
    children: list[SExpr] = [
        Quoted(pad.number),
        Atom(pad.kind.value),
        Atom(pad.shape.value),
        _at_node(pad.position, pad.rotation_udeg),
        node("size", _nm_atom(pad.size_x_nm), _nm_atom(pad.size_y_nm)),
    ]
    if pad.kind in {PadKind.THROUGH_HOLE, PadKind.NPTH}:
        if pad.drill_x_nm == pad.drill_y_nm:
            children.append(node("drill", _nm_atom(pad.drill_x_nm)))
        else:
            children.append(
                node(
                    "drill",
                    Atom("oval"),
                    _nm_atom(pad.drill_x_nm),
                    _nm_atom(pad.drill_y_nm),
                )
            )
    children.append(node("layers", *(Quoted(layer) for layer in pad.layers)))
    if pad.net_id is not None:
        children.append(node("net", Atom(str(net_codes[pad.net_id]))))
    if pad.pin_function is not None:
        children.append(node("pinfunction", Quoted(pad.pin_function)))
    if pad.pin_type is not None:
        children.append(node("pintype", Quoted(pad.pin_type)))
    if pad.roundrect_ratio_ppm is not None:
        children.append(
            node("roundrect_rratio", _scaled_atom(pad.roundrect_ratio_ppm, 1_000_000))
        )
    children.append(node("uuid", Atom(pad.pad_id)))
    if pad.locked:
        children.append(node("locked", Atom("yes")))
    children.extend(
        _opaque_for_scope(
            manifest,
            f"pad:{pad.pad_id}",
            preserve_unsupported=preserve_unsupported,
        )
    )
    return node("pad", *children)


def _export_outline_edge(
    edge: OutlineEdge,
    manifest: DiagnosticsManifest,
    preserve_unsupported: bool,
) -> tuple[SExpr, ...]:
    scope = f"outline-edge:{edge.edge_id}"
    stroke = node(
        "stroke",
        node("width", _nm_atom(edge.width_nm)),
        node("type", Atom(edge.stroke_type)),
        *_opaque_for_scope(
            manifest,
            f"{scope}:stroke",
            preserve_unsupported=preserve_unsupported,
        ),
    )
    children: list[SExpr] = [
        _point_node("start", edge.start),
        _point_node("end", edge.end),
        stroke,
        node("layer", Quoted("Edge.Cuts")),
        node("uuid", Atom(edge.edge_id)),
    ]
    if edge.locked:
        children.append(node("locked", Atom("yes")))
    children.extend(
        _opaque_for_scope(manifest, scope, preserve_unsupported=preserve_unsupported)
    )
    return node("gr_line", *children)


def _export_segment(
    segment: Segment,
    net_codes: dict[str, int],
    manifest: DiagnosticsManifest,
    preserve_unsupported: bool,
) -> tuple[SExpr, ...]:
    children: list[SExpr] = [
        _point_node("start", segment.start),
        _point_node("end", segment.end),
        node("width", _nm_atom(segment.width_nm)),
        node("layer", Quoted(segment.layer)),
        node("net", Atom(str(net_codes[segment.net_id]))),
        node("uuid", Atom(segment.segment_id)),
    ]
    if segment.locked:
        children.append(node("locked", Atom("yes")))
    children.extend(
        _opaque_for_scope(
            manifest,
            f"segment:{segment.segment_id}",
            preserve_unsupported=preserve_unsupported,
        )
    )
    return node("segment", *children)


def _export_via(
    via: Via,
    net_codes: dict[str, int],
    manifest: DiagnosticsManifest,
    preserve_unsupported: bool,
) -> tuple[SExpr, ...]:
    children: list[SExpr] = []
    if via.kind is ViaKind.BLIND:
        children.append(Atom("blind"))
    elif via.kind is ViaKind.MICRO:
        children.append(Atom("micro"))
    children.extend(
        (
            _point_node("at", via.center),
            node("size", _nm_atom(via.diameter_nm)),
            node("drill", _nm_atom(via.drill_nm)),
            node("layers", *(Quoted(layer) for layer in via.layers)),
            node("net", Atom(str(net_codes[via.net_id]))),
            node("uuid", Atom(via.via_id)),
        )
    )
    if via.locked:
        children.append(node("locked", Atom("yes")))
    children.extend(
        _opaque_for_scope(
            manifest,
            f"via:{via.via_id}",
            preserve_unsupported=preserve_unsupported,
        )
    )
    return node("via", *children)


def _export_zone(
    zone: Zone,
    net_codes: dict[str, int],
    manifest: DiagnosticsManifest,
    preserve_unsupported: bool,
) -> tuple[SExpr, ...]:
    scope = f"zone:{zone.zone_id}"
    connect = node(
        "connect_pads",
        node("clearance", _nm_atom(zone.clearance_nm)),
        *_opaque_for_scope(
            manifest,
            f"{scope}:connect_pads",
            preserve_unsupported=preserve_unsupported,
        ),
    )
    points = node(
        "pts",
        *(node("xy", _nm_atom(point.x), _nm_atom(point.y)) for point in zone.boundary),
        *_opaque_for_scope(
            manifest,
            f"{scope}:polygon:pts",
            preserve_unsupported=preserve_unsupported,
        ),
    )
    polygon = node(
        "polygon",
        points,
        *_opaque_for_scope(
            manifest,
            f"{scope}:polygon",
            preserve_unsupported=preserve_unsupported,
        ),
    )
    children: list[SExpr] = [
        node("net", Atom(str(net_codes[zone.net_id]))),
        node("net_name", Quoted(zone.net_name)),
        node("layer", Quoted(zone.layer)),
        node("uuid", Atom(zone.zone_id)),
    ]
    if zone.name is not None:
        children.append(node("name", Quoted(zone.name)))
    children.extend(
        (
            node("hatch", Atom(zone.hatch_style), _nm_atom(zone.hatch_pitch_nm)),
            connect,
            node("min_thickness", _nm_atom(zone.minimum_thickness_nm)),
            polygon,
        )
    )
    children.extend(
        _opaque_for_scope(manifest, scope, preserve_unsupported=preserve_unsupported)
    )
    return node("zone", *children)


def _opaque_for_scope(
    manifest: DiagnosticsManifest,
    scope: str,
    *,
    preserve_unsupported: bool,
) -> tuple[SExpr, ...]:
    expressions: list[SExpr] = []
    for item in manifest.normalized().constructs:
        if item.scope != scope:
            continue
        if (
            item.disposition is DiagnosticDisposition.UNSUPPORTED
            and not preserve_unsupported
        ):
            continue
        parsed = parse(item.canonical_sexpr.encode("utf-8"))
        if canonical_text(parsed) != item.canonical_sexpr:
            raise KiCadInvariantError("diagnostic construct is not canonically encoded")
        expressions.append(parsed)
    return tuple(expressions)


def _point_node(node_head: str, point: PointNm) -> tuple[SExpr, ...]:
    return node(node_head, _nm_atom(point.x), _nm_atom(point.y))


def _at_node(point: PointNm, rotation_udeg: int) -> tuple[SExpr, ...]:
    if rotation_udeg:
        return node(
            "at",
            _nm_atom(point.x),
            _nm_atom(point.y),
            _scaled_atom(rotation_udeg, 1_000_000),
        )
    return node("at", _nm_atom(point.x), _nm_atom(point.y))


def _nm_atom(value: int) -> Atom:
    return _scaled_atom(value, 1_000_000)


def _scaled_atom(value: int, scale: int) -> Atom:
    sign = "-" if value < 0 else ""
    magnitude = abs(value)
    integer, fraction = divmod(magnitude, scale)
    if fraction == 0:
        return Atom(f"{sign}{integer}")
    digits = str(fraction).rjust(len(str(scale)) - 1, "0").rstrip("0")
    return Atom(f"{sign}{integer}.{digits}")

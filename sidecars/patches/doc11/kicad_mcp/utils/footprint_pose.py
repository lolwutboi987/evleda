"""DOC11: project an unplaced front library template into a cardinal root pose.

KiCad 10.0.3 FootprintLoad/SetOrientationDegrees/SaveBoard oracle establishes:
pad, property and fp_text angles are absolute while their XY stays local.
This only splices those angle tokens. It never operates on an existing board
instance, normalizes arbitrary geometry, or drops unknown physical members.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import re

_MAX_BYTES = 500_000
_MAX_NODES = 50_000
_MAX_DEPTH = 64
_TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|[()]|[^\s()"]+')


@dataclass(frozen=True)
class _Atom:
    text: str
    start: int
    end: int


@dataclass(frozen=True)
class _Node:
    name: str
    start: int
    end: int
    values: tuple[_Atom, ...]
    children: tuple[_Node, ...]


def _parse(source: str) -> _Node:
    if not isinstance(source, str) or not source or len(source.encode("utf-8", errors="strict")) > _MAX_BYTES or "\x00" in source:
        raise ValueError("DOC11 footprint template is not bounded UTF-8 text")
    tokens = list(_TOKEN.finditer(source))
    if len(tokens) > _MAX_NODES * 12:
        raise ValueError("DOC11 footprint token bound exceeded")
    previous = 0
    for token in tokens:
        if source[previous:token.start()].strip():
            raise ValueError("DOC11 malformed source token or string")
        previous = token.end()
    if source[previous:].strip():
        raise ValueError("DOC11 malformed trailing source")
    cursor = 0
    count = 0

    def take() -> _Atom:
        nonlocal cursor
        if cursor >= len(tokens):
            raise ValueError("DOC11 truncated S-expression")
        token = tokens[cursor]
        cursor += 1
        return _Atom(token.group(), token.start(), token.end())

    def node(depth: int) -> _Node:
        nonlocal count
        count += 1
        if count > _MAX_NODES or depth > _MAX_DEPTH:
            raise ValueError("DOC11 footprint node/depth bound exceeded")
        begin, name = take(), take()
        if begin.text != "(" or name.text in ("(", ")") or name.text.startswith('"'):
            raise ValueError("DOC11 malformed source form")
        values, children = [], []
        while cursor < len(tokens) and tokens[cursor].group() != ")":
            if tokens[cursor].group() == "(":
                children.append(node(depth + 1))
            else:
                if children:
                    raise ValueError("DOC11 scalar after nested source form")
                atom = take()
                if atom.start <= name.end or values and atom.start <= values[-1].end:
                    raise ValueError("DOC11 adjacent source atoms")
                values.append(atom)
        end = take()
        if end.text != ")":
            raise ValueError("DOC11 unclosed source form")
        return _Node(name.text, begin.start, end.end, tuple(values), tuple(children))

    root = node(0)
    if cursor != len(tokens) or root.name != "footprint":
        raise ValueError("DOC11 source must contain exactly one footprint")
    return root


def _field(owner: _Node, name: str, optional: bool = False) -> _Node | None:
    values = [node for node in owner.children if node.name == name]
    if len(values) != 1 and not (optional and not values):
        raise ValueError("DOC11 missing or duplicate " + owner.name + "/" + name)
    return values[0] if values else None


def _cardinal(text: str) -> int:
    if len(text) > 32 or not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
        raise ValueError("DOC11 invalid cardinal angle")
    try:
        value = Decimal(text)
    except InvalidOperation as error:
        raise ValueError("DOC11 invalid angle") from error
    if not value.is_finite() or value < -360 or value > 360 or value != value.to_integral_value() or int(value) % 90:
        raise ValueError("DOC11 only exact cardinal angles within one turn are supported")
    return int(value) % 360


def _coordinate_nm(text: str) -> int:
    if len(text) > 128 or not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
        raise ValueError("DOC11 malformed ASCII child coordinate")
    try:
        value = Decimal(text)
    except InvalidOperation as error:
        raise ValueError("DOC11 malformed child coordinate") from error
    if not value.is_finite() or abs(value.as_tuple().exponent) > 100:
        raise ValueError("DOC11 child coordinate exponent is outside its bound")
    numerator, denominator = value.as_integer_ratio()
    scaled = numerator * 1_000_000
    if scaled % denominator or abs(scaled) > 2_000_000_000 * denominator:
        raise ValueError("DOC11 child coordinate is outside exact native nanometres")
    return scaled // denominator


def project_library_footprint_angles(source: str, rotation: int) -> str:
    """Return the stock template with absolute child angles for one root pose.

    The caller still owns root placement/UUID insertion and native migration.
    Caller-supplied source must be an unplaced library template, never a saved
    instance. Unknown root forms, mirrors and uncharacterized angle forms reject.
    """
    if isinstance(rotation, bool) or not isinstance(rotation, int):
        raise ValueError("DOC11 root rotation must be an integer cardinal angle")
    target = _cardinal(str(rotation))
    root = _parse(source)
    if len(root.values) != 1 or not root.values[0].text.startswith('"'):
        raise ValueError("DOC11 footprint requires one quoted library identity")
    layer = _field(root, "layer")
    if layer.children or [value.text for value in layer.values] != ['"F.Cu"']:
        raise ValueError("DOC11 only front-side library templates are supported")
    if any(node.name in {"at", "uuid", "tstamp", "path", "sheetname", "sheetfile"} for node in root.children):
        raise ValueError("DOC11 refuses an already placed or identified footprint instance")
    metadata = {"version", "generator", "generator_version", "layer", "descr", "tags", "attr", "locked", "placed",
                "autoplace_cost90", "autoplace_cost180", "solder_mask_margin", "solder_paste_margin", "solder_paste_ratio",
                "clearance", "zone_connect", "thermal_width", "thermal_gap", "duplicate_pad_numbers_are_jumpers",
                "embedded_fonts", "private_layers", "net_tie_pad_groups"}
    graphics = {"fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve"}
    edits: list[tuple[int, int, str]] = []
    seen_properties: set[str] = set()

    def no_mirror(node: _Node) -> None:
        if node.name == "mirror" or node.name == "justify" and any(value.text == "mirror" for value in node.values):
            raise ValueError("DOC11 mirrored source is outside front-template coverage")
        for child in node.children:
            no_mirror(child)

    for child in root.children:
        if child.name == "model":
            # Model coordinate frames stay opaque and byte-identical.
            continue
        no_mirror(child)
        if child.name in metadata or child.name in graphics:
            continue
        if child.name not in {"pad", "property", "fp_text"}:
            raise ValueError("DOC11 uncharacterized footprint child " + child.name)
        if child.name == "property":
            if len(child.values) != 2 or not all(atom.text.startswith('"') for atom in child.values) or child.values[0].text in seen_properties:
                raise ValueError("DOC11 malformed or duplicate property")
            seen_properties.add(child.values[0].text)
        elif child.name == "fp_text":
            if len(child.values) != 2 or child.values[0].text != "user" or not child.values[1].text.startswith('"'):
                raise ValueError("DOC11 only user fp_text beside native property fields is supported")
        elif len(child.values) != 3 or not child.values[0].text.startswith('"') or child.values[1].text not in {"smd", "thru_hole", "np_thru_hole", "connect"} or child.values[2].text not in {"rect", "roundrect", "oval", "circle", "trapezoid", "custom"}:
            raise ValueError("DOC11 unsupported pad header")
        pose = _field(child, "at")
        values = list(pose.values)
        if child.name != "pad" and values and values[-1].text == "unlocked":
            values.pop()
        if pose.children or len(values) not in (2, 3):
            raise ValueError("DOC11 unsupported child pose")
        for coordinate in values[:2]:
            _coordinate_nm(coordinate.text)
        previous = _cardinal(values[2].text) if len(values) == 3 else 0
        next_angle = (previous + target) % 360
        if target == 0:
            continue
        if len(values) == 3:
            token = values[2]
            edits.append((token.start, token.end, "" if child.name == "pad" and next_angle == 0 else str(next_angle)))
        elif next_angle != 0 or child.name != "pad":
            edits.append((values[1].end, values[1].end, " " + str(next_angle)))
    for start, end, text in sorted(edits, reverse=True):
        source = source[:start] + text + source[end:]
    return source

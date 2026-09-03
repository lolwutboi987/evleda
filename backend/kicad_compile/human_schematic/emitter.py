"""Deterministic KiCad-10 emission for the reviewed R2 human schematic.

This module deliberately depends on the transport-neutral human-schematic plan,
not on the project compiler.  Compiler-owned identity and footprint policies are
injected as two small callables.  The emitter reparses its own bytes and compares
the complete S-expression tree against an independently plan-derived tree before
returning any evidence.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Protocol, cast

from backend.design_kernel.model import canonical_json
from backend.kicad_io.sexpr import Atom, Quoted, SExpr, atom, head, node, parse, quoted, render

from .catalog import SourcePayloadProvider
from .model import (
    GRID_NM,
    GridPoint,
    HumanSchematicError,
    HumanSchematicPlan,
    PinPort,
    PropertyRecord,
    SymbolSource,
    SymbolTemplate,
)

HUMAN_SCHEMATIC_EMITTER_ID = "flux-human-schematic-kicad10-emitter"
HUMAN_SCHEMATIC_EMITTER_VERSION = "1.0.2"
_SCHEMATIC_VERSION = 20250114
_SYMBOL_LIBRARY_VERSION = 20240529
_EXPECTED_COUNTS = (10, 23, 39, 29, 1, 8)
_SHA256 = re.compile(r"[0-9a-f]{64}")
_NESTED_SYMBOL_SUFFIX = re.compile(r"(_[0-9]+_[0-9]+)$")
_GRAPHIC_HEADS = frozenset({"arc", "bezier", "circle", "polyline", "rectangle", "text", "text_box"})
_POINT_HEADS = frozenset({"at", "center", "end", "mid", "start", "xy"})


class HumanUUIDFactory(Protocol):
    """Compiler-owned deterministic UUID policy."""

    def __call__(self, domain: str, semantic_id: str) -> str: ...


class HumanFootprintLinkFactory(Protocol):
    """Compiler-owned component-unique footprint-link policy."""

    def __call__(self, component_id: str) -> str: ...


@dataclass(frozen=True, slots=True, order=True)
class HumanEmissionBinding:
    """Neutral semantic identity to emitted KiCad identity evidence."""

    source_kind: str
    source_id: str
    target_kind: str
    emitted_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        for value, label in (
            (self.source_kind, "binding source kind"),
            (self.source_id, "binding source ID"),
            (self.target_kind, "binding target kind"),
        ):
            _require_text(value, label)
        if (
            type(self.emitted_ids) is not tuple
            or not self.emitted_ids
            or any(type(item) is not str or not item for item in self.emitted_ids)
        ):
            raise ValueError("binding emitted IDs must be a non-empty exact text tuple")
        if self.emitted_ids != tuple(sorted(set(self.emitted_ids))):
            raise ValueError("binding emitted IDs must be sorted and unique")


def _identity_payload(bindings: tuple[HumanEmissionBinding, ...]) -> bytes:
    return (
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


def _emission_digest_payload(emission: HumanSchematicEmission) -> bytes:
    return (
        canonical_json(
            {
                "schema": "flux-human-schematic-emission-v1",
                "emitter_id": emission.emitter_id,
                "emitter_version": emission.emitter_version,
                "subject_graph_sha256": emission.subject_graph_sha256,
                "plan_sha256": emission.plan_sha256,
                "schematic_sha256": emission.schematic_sha256,
                "symbol_library_sha256": emission.symbol_library_sha256,
                "identity_manifest_sha256": emission.identity_manifest_sha256,
            }
        )
        + "\n"
    ).encode("utf-8")


@dataclass(frozen=True, slots=True)
class HumanSchematicEmission:
    """Immutable, digest-closed schematic payload and identity evidence."""

    emitter_id: str
    emitter_version: str
    subject_graph_sha256: str
    plan_sha256: str
    schematic_payload: bytes
    symbol_library_payload: bytes
    identity_bindings: tuple[HumanEmissionBinding, ...]
    schematic_sha256: str
    symbol_library_sha256: str
    identity_manifest_sha256: str
    emission_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not HumanSchematicEmission:
            raise TypeError("human emission must use the exact immutable record type")
        if self.emitter_id != HUMAN_SCHEMATIC_EMITTER_ID:
            raise ValueError("human emission has an unknown emitter ID")
        if self.emitter_version != HUMAN_SCHEMATIC_EMITTER_VERSION:
            raise ValueError("human emission has an unknown emitter version")
        for value, label in (
            (self.subject_graph_sha256, "subject graph digest"),
            (self.plan_sha256, "human plan digest"),
            (self.schematic_sha256, "schematic payload digest"),
            (self.symbol_library_sha256, "symbol-library payload digest"),
            (self.identity_manifest_sha256, "identity-manifest digest"),
            (self.emission_sha256, "whole-emission digest"),
        ):
            _require_sha256(value, label)
        if type(self.schematic_payload) is not bytes or not self.schematic_payload:
            raise ValueError("schematic payload must be non-empty exact bytes")
        if type(self.symbol_library_payload) is not bytes or not self.symbol_library_payload:
            raise ValueError("symbol-library payload must be non-empty exact bytes")
        if type(self.identity_bindings) is not tuple or any(
            type(item) is not HumanEmissionBinding for item in self.identity_bindings
        ):
            raise TypeError("identity bindings must be an exact immutable tuple")
        if self.identity_bindings != tuple(sorted(self.identity_bindings)):
            raise ValueError("identity bindings must be deterministically sorted")
        subjects = tuple(
            (item.source_kind, item.source_id, item.target_kind) for item in self.identity_bindings
        )
        if len(subjects) != len(set(subjects)):
            raise ValueError("identity binding subjects must be unique")
        expected = (
            _sha256(self.schematic_payload),
            _sha256(self.symbol_library_payload),
            _sha256(_identity_payload(self.identity_bindings)),
        )
        actual = (
            self.schematic_sha256,
            self.symbol_library_sha256,
            self.identity_manifest_sha256,
        )
        if actual != expected:
            raise ValueError("human emission payload or identity digest does not match its bytes")
        if self.emission_sha256 != _sha256(_emission_digest_payload(self)):
            raise ValueError("whole human-emission digest does not match its evidence")
        _parse_canonical(self.schematic_payload, "schematic")
        _parse_canonical(self.symbol_library_payload, "symbol library")

    @property
    def schematic_expression(self) -> SExpr:
        return _parse_canonical(self.schematic_payload, "schematic")

    @property
    def symbol_library_expression(self) -> SExpr:
        return _parse_canonical(self.symbol_library_payload, "symbol library")

    @property
    def identity_manifest_payload(self) -> bytes:
        return _identity_payload(self.identity_bindings)


@dataclass(frozen=True, slots=True)
class _ProfileSpec:
    profile_id: str
    source_id: str
    source_symbol_id: str | None
    rotation_deg: int = 0
    mirror_y: bool = False
    translate_x_grid: int = 0
    translate_y_grid: int = 0
    pin_number_map: tuple[tuple[str, str], ...] = ()


_PROFILE_SPECS = tuple(
    sorted(
        (
            _ProfileSpec(
                "connector-01x02",
                "kicad-connector-generic-01x02-10.0.6",
                "Conn_01x02",
                mirror_y=True,
                translate_y_grid=-1,
            ),
            _ProfileSpec(
                "connector-testpoint",
                "kicad-connector-testpoint-10.0.6",
                "TestPoint",
            ),
            _ProfileSpec(
                "connector-usb4105-gf-a",
                "kicad-connector-usb-c-16p-10.0.6",
                "USB_C_Receptacle_USB2.0_16P",
                mirror_y=True,
                pin_number_map=(("S1", "SH"),),
            ),
            _ProfileSpec("device-c", "kicad-device-c-10.0.6", "C"),
            _ProfileSpec(
                "device-c-polarized-t598",
                "kicad-device-c-polarized-10.0.6",
                "C_Polarized",
            ),
            _ProfileSpec("device-d-tvs", "kicad-device-d-tvs-10.0.6", "D_TVS", 270),
            _ProfileSpec("device-led", "kicad-device-led-10.0.6", "LED", 180),
            _ProfileSpec("device-r", "kicad-device-r-10.0.6", "R"),
            _ProfileSpec(
                "power-management-tps259620ddar",
                "kicad-power-management-tps2596xx-10.0.6",
                "TPS2596xx",
                mirror_y=True,
                pin_number_map=(("EP", "9"),),
            ),
            _ProfileSpec(
                "regulator-lp38692mpx-3v3",
                "lp38692-pinout-derivation-receipt",
                None,
            ),
        ),
        key=lambda item: item.profile_id,
    )
)


def _require_text(value: object, label: str) -> str:
    if (
        type(value) is not str
        or not value
        or value != value.strip()
        or any(ord(character) < 32 for character in value)
    ):
        raise ValueError(f"{label} must be non-empty, trimmed, control-free text")
    return value


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _validate_stem(stem: str) -> None:
    _require_text(stem, "project stem")
    if stem in {".", ".."} or any(character in stem for character in "/\\:"):
        raise ValueError("project stem must be one portable basename")


def _parse_canonical(payload: bytes, label: str) -> SExpr:
    try:
        expression = parse(payload)
    except Exception as exc:
        raise HumanSchematicError(
            "human-emission-syntax-invalid",
            label.replace(" ", "-"),
            "emitted bytes are not one bounded KiCad S-expression",
        ) from exc
    if render(expression) != payload:
        raise HumanSchematicError(
            "human-emission-noncanonical-payload",
            label.replace(" ", "-"),
            "emitted bytes are not the deterministic canonical rendering",
        )
    return expression


def _children(expression: SExpr, wanted: str) -> tuple[tuple[SExpr, ...], ...]:
    if not isinstance(expression, tuple):
        return ()
    return tuple(
        child for child in expression[1:] if isinstance(child, tuple) and head(child) == wanted
    )


def _scalar(expression: SExpr, label: str) -> str:
    if isinstance(expression, (Atom, Quoted)):
        return expression.value
    raise HumanSchematicError(
        "human-symbol-source-unemittable", label.replace(" ", "-"), "expected a scalar"
    )


def _first(expression: tuple[SExpr, ...], label: str, index: int = 1) -> str:
    if len(expression) <= index:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            label.replace(" ", "-"),
            "required scalar is absent",
        )
    return _scalar(expression[index], label)


def _one_child(expression: tuple[SExpr, ...], wanted: str, label: str) -> tuple[SExpr, ...]:
    matches = _children(expression, wanted)
    if len(matches) != 1:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            label.replace(" ", "-"),
            f"expected exactly one {wanted} expression",
        )
    return matches[0]


def _resolve_source_payloads(
    plan: HumanSchematicPlan, provider: SourcePayloadProvider
) -> dict[str, bytes]:
    sources = {item.source_id: item for item in plan.symbol_sources}
    mapping = cast(Mapping[str, bytes], provider) if isinstance(provider, Mapping) else None
    resolver = None if mapping is not None else cast(Callable[[SymbolSource], bytes], provider)
    if mapping is not None and set(mapping) != set(sources):
        raise HumanSchematicError(
            "human-symbol-source-inventory-mismatch",
            plan.semantic_graph.project_id,
            "emission source keys must exactly equal the plan source inventory",
        )
    result: dict[str, bytes] = {}
    for source_id, source in sorted(sources.items()):
        try:
            payload = (
                mapping[source_id]
                if mapping is not None
                else cast(Callable[[SymbolSource], bytes], resolver)(source)
            )
        except Exception as exc:
            raise HumanSchematicError(
                "human-symbol-source-unavailable",
                source_id,
                "the explicit emission resolver did not return retained bytes",
            ) from exc
        if type(payload) is not bytes:
            raise TypeError("retained emission source payloads must be exact bytes")
        if len(payload) != source.byte_length or _sha256(payload) != source.sha256:
            raise HumanSchematicError(
                "human-symbol-source-digest-mismatch",
                source_id,
                "emission source bytes differ from the exact plan receipt",
            )
        result[source_id] = payload
    return result


def _mm_from_grid(value: int) -> str:
    return _decimal_text(Decimal(value) * Decimal(GRID_NM) / Decimal(1_000_000))


def _decimal_text(value: Decimal) -> str:
    if not value.is_finite():
        raise ValueError("KiCad coordinates must be finite")
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    if result in {"", "-0"}:
        return "0"
    return result


def _decimal(expression: SExpr, label: str) -> Decimal:
    try:
        return Decimal(_scalar(expression, label))
    except InvalidOperation as exc:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            label.replace(" ", "-"),
            "coordinate is not an exact decimal",
        ) from exc


def _rotate_decimal(x: Decimal, y: Decimal, rotation_deg: int) -> tuple[Decimal, Decimal]:
    if rotation_deg == 0:
        return x, y
    if rotation_deg == 90:
        return -y, x
    if rotation_deg == 180:
        return -x, -y
    if rotation_deg == 270:
        return y, -x
    raise ValueError("profile rotations must be quadrants")


def _transform_point_values(x: Decimal, y: Decimal, spec: _ProfileSpec) -> tuple[Decimal, Decimal]:
    if spec.mirror_y:
        y = -y
    rotated_x, rotated_y = _rotate_decimal(x, y, spec.rotation_deg)
    grid_mm = Decimal(GRID_NM) / Decimal(1_000_000)
    return (
        rotated_x + Decimal(spec.translate_x_grid) * grid_mm,
        rotated_y + Decimal(spec.translate_y_grid) * grid_mm,
    )


def _transform_angle(angle: Decimal, spec: _ProfileSpec) -> Decimal:
    if spec.mirror_y:
        angle = -angle
    return (angle + spec.rotation_deg + 360) % 360


def _transform_graphic(expression: SExpr, spec: _ProfileSpec) -> SExpr:
    if not isinstance(expression, tuple):
        return expression
    expression_head = head(expression)
    if expression_head in _POINT_HEADS:
        expected_lengths = {3, 4} if expression_head == "at" else {3}
        if len(expression) not in expected_lengths:
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                spec.profile_id,
                f"graphic {expression_head} has an unsupported coordinate shape",
            )
        x, y = _transform_point_values(
            _decimal(expression[1], f"{spec.profile_id} graphic X"),
            _decimal(expression[2], f"{spec.profile_id} graphic Y"),
            spec,
        )
        children: list[SExpr] = [atom(_decimal_text(x)), atom(_decimal_text(y))]
        if len(expression) == 4:
            angle = _decimal(expression[3], f"{spec.profile_id} graphic angle")
            children.append(atom(_decimal_text(_transform_angle(angle, spec))))
        return node(expression_head, *children)
    return tuple(_transform_graphic(child, spec) for child in expression)


def _source_definition(payload: bytes, spec: _ProfileSpec) -> tuple[SExpr, ...]:
    try:
        root = parse(payload)
    except Exception as exc:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            spec.source_id,
            "reviewed symbol bytes no longer parse",
        ) from exc
    if not isinstance(root, tuple) or head(root) != "kicad_symbol_lib":
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            spec.source_id,
            "reviewed symbol source has the wrong root",
        )
    definitions = _children(root, "symbol")
    if len(definitions) != 1 or _first(definitions[0], spec.source_id) != spec.source_symbol_id:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            spec.source_id,
            "reviewed source does not contain its one expected symbol definition",
        )
    if _children(definitions[0], "extends"):
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            spec.source_id,
            "inherited symbols are not silently flattened",
        )
    return definitions[0]


def _source_pins(definition: tuple[SExpr, ...], spec: _ProfileSpec) -> dict[str, tuple[SExpr, ...]]:
    pins: list[tuple[SExpr, ...]] = []

    def visit(expression: tuple[SExpr, ...]) -> None:
        for child in expression[1:]:
            if not isinstance(child, tuple):
                continue
            if head(child) == "pin":
                pins.append(child)
            elif head(child) == "symbol":
                visit(child)

    visit(definition)
    result: dict[str, tuple[SExpr, ...]] = {}
    for pin in pins:
        number = _first(_one_child(pin, "number", spec.profile_id), spec.profile_id)
        if number in result:
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                spec.profile_id,
                "reviewed source pin numbers are not unique",
            )
        result[number] = pin
    return result


def _source_graphics(
    definition: tuple[SExpr, ...], spec: _ProfileSpec, local_id: str
) -> tuple[tuple[SExpr, ...], ...]:
    result: list[tuple[SExpr, ...]] = []
    for nested in _children(definition, "symbol"):
        source_name = _first(nested, spec.profile_id)
        suffix_match = _NESTED_SYMBOL_SUFFIX.search(source_name)
        if suffix_match is None:
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                spec.profile_id,
                "reviewed graphic unit does not have an explicit KiCad unit/body suffix",
            )
        graphic_children = tuple(
            child
            for child in nested[2:]
            if isinstance(child, tuple) and head(child) in _GRAPHIC_HEADS
        )
        other_children = tuple(
            child
            for child in nested[2:]
            if isinstance(child, tuple) and head(child) not in _GRAPHIC_HEADS | {"pin"}
        )
        if other_children:
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                spec.profile_id,
                "reviewed graphic unit contains an unsupported primitive inventory",
            )
        if not graphic_children:
            continue
        result.append(
            node(
                "symbol",
                quoted(local_id + suffix_match.group(1)),
                *(_transform_graphic(child, spec) for child in graphic_children),
            )
        )
    if not result:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            spec.profile_id,
            "reviewed source has no concrete graphics to flatten",
        )
    return tuple(result)


def _pin_angle(direction: str) -> int:
    try:
        return {"east": 180, "north": 270, "south": 90, "west": 0}[direction]
    except KeyError as exc:
        raise ValueError("pin direction must be cardinal") from exc


def _effects(
    *, hidden: bool = False, bold: bool = False, justify_left: bool = False
) -> tuple[SExpr, ...]:
    font_children: list[SExpr] = [node("size", atom("1.27"), atom("1.27"))]
    if bold:
        font_children.append(node("bold", atom("yes")))
    children: list[SExpr] = [node("font", *font_children)]
    if justify_left:
        children.append(node("justify", atom("left")))
    if hidden:
        children.append(node("hide", atom("yes")))
    return node("effects", *children)


def _pin_expression(
    port: PinPort, *, source_pin: tuple[SExpr, ...] | None = None
) -> tuple[SExpr, ...]:
    length = "2.54"
    hidden = False
    if source_pin is not None:
        length_expression = _one_child(source_pin, "length", port.logical_number)
        length = _first(length_expression, port.logical_number)
        hidden_nodes = _children(source_pin, "hide")
        if len(hidden_nodes) > 1:
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                port.logical_number,
                "source pin has duplicate hide declarations",
            )
        hidden = bool(hidden_nodes) and _first(hidden_nodes[0], port.logical_number) == "yes"
    children: list[SExpr] = [
        node(
            "at",
            atom(_mm_from_grid(port.offset.x)),
            atom(_mm_from_grid(-port.offset.y)),
            atom(str(_pin_angle(port.direction))),
        ),
        node("length", atom(length)),
    ]
    if hidden:
        children.append(node("hide", atom("yes")))
    children.extend(
        (
            node("name", quoted(port.canonical_name), _effects()),
            node("number", quoted(port.emitted_number), _effects()),
        )
    )
    return node("pin", atom(port.canonical_electrical_type), atom("line"), *children)


def _validate_source_pin_projection(
    template: SymbolTemplate,
    spec: _ProfileSpec,
    source_pins: dict[str, tuple[SExpr, ...]],
) -> dict[str, tuple[SExpr, ...]]:
    remap = dict(spec.pin_number_map)
    expected_source_numbers = {
        remap.get(port.logical_number, port.logical_number) for port in template.pin_ports
    }
    if set(source_pins) != expected_source_numbers:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            template.profile_id,
            "retained source pin inventory differs from the explicit flattening map",
        )
    result: dict[str, tuple[SExpr, ...]] = {}
    for port in template.pin_ports:
        source_number = remap.get(port.logical_number, port.logical_number)
        source_pin = source_pins[source_number]
        if (
            len(source_pin) < 3
            or _first(source_pin, template.profile_id, 1) != port.electrical_type
        ):
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                template.profile_id,
                f"source electrical type changed for logical pin {port.logical_number}",
            )
        at_expression = _one_child(source_pin, "at", template.profile_id)
        source_x = _decimal(at_expression[1], template.profile_id)
        source_y = _decimal(at_expression[2], template.profile_id)
        transformed = _transform_point_values(source_x, source_y, spec)
        expected = (
            Decimal(_mm_from_grid(port.offset.x)),
            Decimal(_mm_from_grid(-port.offset.y)),
        )
        if transformed != expected:
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                template.profile_id,
                f"source pin geometry changed for logical pin {port.logical_number}",
            )
        source_angle = int(_decimal(at_expression[3], template.profile_id))
        if int(_transform_angle(Decimal(source_angle), spec)) != _pin_angle(port.direction):
            raise HumanSchematicError(
                "human-symbol-source-unemittable",
                template.profile_id,
                f"source pin direction changed for logical pin {port.logical_number}",
            )
        result[port.logical_number] = source_pin
    return result


def _validate_lp38692_receipt(payload: bytes, template: SymbolTemplate) -> None:
    try:
        receipt_value: object = json.loads(payload.decode("utf-8", errors="strict"))
    except Exception as exc:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            template.profile_id,
            "LP38692 derivation receipt is not strict UTF-8 JSON",
        ) from exc
    if not isinstance(receipt_value, dict):
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            template.profile_id,
            "LP38692 derivation receipt must be one JSON object",
        )
    receipt = cast(dict[str, object], receipt_value)
    if receipt.get("schema") != "flux-human-symbol-derivation-receipt-v1":
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            template.profile_id,
            "LP38692 derivation receipt has an unknown schema",
        )
    body = receipt.get("body_grid")
    expected_body = {
        "minimum": [template.body.minimum.x, template.body.minimum.y],
        "maximum": [template.body.maximum.x, template.body.maximum.y],
    }
    expected_pins = [
        {
            "number": port.logical_number,
            "name": port.canonical_name,
            "electrical_type": port.canonical_electrical_type,
            "pad_number": port.canonical_pad_number,
            "required": port.canonical_required,
            "port": [port.offset.x, port.offset.y, port.direction],
        }
        for port in template.pin_ports
    ]
    if body != expected_body or receipt.get("pins") != expected_pins:
        raise HumanSchematicError(
            "human-symbol-source-unemittable",
            template.profile_id,
            "LP38692 receipt no longer equals the exact template body and pin contract",
        )


def _library_property(name: str, value: str, position: GridPoint, *, hidden: bool = False) -> SExpr:
    return node(
        "property",
        quoted(name),
        quoted(value),
        node("at", atom(_mm_from_grid(position.x)), atom(_mm_from_grid(position.y)), atom("0")),
        _effects(hidden=hidden),
    )


def _reference_prefix(reference: str) -> str:
    match = re.match(r"[A-Za-z#]+", reference)
    return match.group(0) if match is not None else "U"


def _local_library_id(template: SymbolTemplate) -> str:
    prefix = "FluxHuman:"
    if not template.flattened_library_id.startswith(prefix):
        raise HumanSchematicError(
            "human-symbol-template-unemittable",
            template.profile_id,
            "flattened library ID is outside the reviewed FluxHuman namespace",
        )
    local_id = template.flattened_library_id.removeprefix(prefix)
    _require_text(local_id, "flattened local library ID")
    if ":" in local_id:
        raise HumanSchematicError(
            "human-symbol-template-unemittable",
            template.profile_id,
            "flattened local library ID must be one leaf",
        )
    return local_id


def _symbol_definition(
    template: SymbolTemplate,
    spec: _ProfileSpec,
    payloads: Mapping[str, bytes],
    reference: str,
) -> tuple[SExpr, ...]:
    local_id = _local_library_id(template)
    graphics: tuple[tuple[SExpr, ...], ...]
    pins: tuple[tuple[SExpr, ...], ...]
    if spec.source_symbol_id is None:
        _validate_lp38692_receipt(payloads[spec.source_id], template)
        graphics = (
            node(
                "symbol",
                quoted(f"{local_id}_0_1"),
                node(
                    "rectangle",
                    node(
                        "start",
                        atom(_mm_from_grid(template.body.minimum.x)),
                        atom(_mm_from_grid(-template.body.minimum.y)),
                    ),
                    node(
                        "end",
                        atom(_mm_from_grid(template.body.maximum.x)),
                        atom(_mm_from_grid(-template.body.maximum.y)),
                    ),
                    node("stroke", node("width", atom("0.254")), node("type", atom("default"))),
                    node("fill", node("type", atom("background"))),
                ),
            ),
        )
        pins = tuple(_pin_expression(port) for port in template.pin_ports)
    else:
        source = _source_definition(payloads[spec.source_id], spec)
        source_pins = _validate_source_pin_projection(template, spec, _source_pins(source, spec))
        graphics = _source_graphics(source, spec, local_id)
        pins = tuple(
            _pin_expression(port, source_pin=source_pins[port.logical_number])
            for port in template.pin_ports
        )
    pin_unit = node("symbol", quoted(f"{local_id}_1_1"), *pins)
    reference_position = GridPoint(template.body.minimum.x, template.body.minimum.y - 2)
    value_position = GridPoint(template.body.minimum.x, template.body.maximum.y + 2)
    return node(
        "symbol",
        quoted(f"FluxGenerated:{local_id}"),
        node("pin_names", node("offset", atom("0.508"))),
        node("exclude_from_sim", atom("no")),
        node("in_bom", atom("yes")),
        node("on_board", atom("yes")),
        node("in_pos_files", atom("yes")),
        node("duplicate_pin_numbers_are_jumpers", atom("no")),
        _library_property("Reference", _reference_prefix(reference), reference_position),
        _library_property("Value", local_id, value_position),
        _library_property("Footprint", "", GridPoint(0, 0), hidden=True),
        _library_property("Datasheet", "", GridPoint(0, 0), hidden=True),
        _library_property("Description", template.derivation, GridPoint(0, 0), hidden=True),
        *graphics,
        pin_unit,
        node("embedded_fonts", atom("no")),
    )


def _external_definition(definition: tuple[SExpr, ...]) -> tuple[SExpr, ...]:
    full_id = _first(definition, "embedded library definition")
    prefix = "FluxGenerated:"
    if not full_id.startswith(prefix) or not full_id.removeprefix(prefix):
        raise HumanSchematicError(
            "human-emission-library-invalid",
            full_id.replace(" ", "_"),
            "embedded definition is outside the FluxGenerated namespace",
        )
    return (definition[0], quoted(full_id.removeprefix(prefix)), *definition[2:])


def _uuid_value(factory: HumanUUIDFactory, domain: str, semantic_id: str) -> str:
    value = factory(domain, semantic_id)
    if type(value) is not str:
        raise TypeError("human UUID factory must return exact text")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise HumanSchematicError(
            "human-emission-uuid-invalid",
            semantic_id,
            "UUID factory did not return a canonical UUID",
        ) from exc
    if str(parsed) != value:
        raise HumanSchematicError(
            "human-emission-uuid-invalid",
            semantic_id,
            "UUID factory output must use lowercase canonical form",
        )
    return value


def _looks_like_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _binding(
    source_kind: str, source_id: str, target_kind: str, *emitted_ids: str
) -> HumanEmissionBinding:
    return HumanEmissionBinding(
        source_kind, source_id, target_kind, tuple(sorted(set(emitted_ids)))
    )


def _at_grid(point: GridPoint, rotation_deg: int | None = None) -> tuple[SExpr, ...]:
    children: list[SExpr] = [atom(_mm_from_grid(point.x)), atom(_mm_from_grid(point.y))]
    if rotation_deg is not None:
        children.append(atom(str(rotation_deg)))
    return node("at", *children)


def _placed_property(record: PropertyRecord, value: str) -> tuple[SExpr, ...]:
    return node(
        "property",
        quoted(record.name),
        quoted(value),
        _at_grid(record.anchor, 0),
        _effects(hidden=not record.visible, justify_left=record.visible),
    )


def _block_expressions(
    plan: HumanSchematicPlan,
    uuid_factory: HumanUUIDFactory,
) -> tuple[tuple[SExpr, ...], tuple[HumanEmissionBinding, ...]]:
    expressions: list[tuple[SExpr, ...]] = []
    bindings: list[HumanEmissionBinding] = []
    for block in sorted(plan.blocks):
        rectangle_id = _uuid_value(uuid_factory, "human-block-rectangle", block.block_id)
        title_id = _uuid_value(uuid_factory, "human-block-title", block.block_id)
        expressions.extend(
            (
                node(
                    "rectangle",
                    node(
                        "start",
                        atom(_mm_from_grid(block.envelope.minimum.x)),
                        atom(_mm_from_grid(block.envelope.minimum.y)),
                    ),
                    node(
                        "end",
                        atom(_mm_from_grid(block.envelope.maximum.x)),
                        atom(_mm_from_grid(block.envelope.maximum.y)),
                    ),
                    node("stroke", node("width", atom("0.254")), node("type", atom("dash"))),
                    node("fill", node("type", atom("none"))),
                    node("uuid", quoted(rectangle_id)),
                ),
                node(
                    "text",
                    quoted(block.title),
                    node("exclude_from_sim", atom("no")),
                    _at_grid(block.title_anchor, 0),
                    _effects(bold=True, justify_left=True),
                    node("uuid", quoted(title_id)),
                ),
            )
        )
        bindings.append(
            _binding(
                "functional-block",
                block.block_id,
                "schematic-block-graphics",
                rectangle_id,
                title_id,
            )
        )
    return tuple(expressions), tuple(bindings)


def _placed_symbols(
    plan: HumanSchematicPlan,
    stem: str,
    root_id: str,
    uuid_factory: HumanUUIDFactory,
    footprint_link_factory: HumanFootprintLinkFactory,
) -> tuple[tuple[tuple[SExpr, ...], ...], tuple[HumanEmissionBinding, ...]]:
    templates = {item.profile_id: item for item in plan.symbol_templates}
    expressions: list[tuple[SExpr, ...]] = []
    bindings: list[HumanEmissionBinding] = []
    footprint_links: dict[str, str] = {}
    for placement in sorted(plan.placements, key=lambda item: item.component_id):
        symbol_id = _uuid_value(uuid_factory, "human-symbol", placement.semantic_id)
        template = templates[placement.symbol_profile_id]
        link = footprint_link_factory(placement.component_id)
        _require_text(link, "component footprint link")
        footprint_links[placement.component_id] = link
        property_expressions: list[tuple[SExpr, ...]] = []
        for record in sorted(placement.properties, key=lambda item: item.name):
            property_evidence_id = _uuid_value(
                uuid_factory, "human-property-evidence", record.semantic_id
            )
            value = link if record.name == "Footprint" else record.value
            property_expressions.append(_placed_property(record, value))
            bindings.append(
                _binding(
                    "property",
                    record.semantic_id,
                    "schematic-property-evidence",
                    property_evidence_id,
                )
            )
        pin_expressions: list[tuple[SExpr, ...]] = []
        for anchor in sorted(placement.pin_anchors, key=lambda item: item.pin.pin_number):
            pin_id = _uuid_value(uuid_factory, "human-pin", anchor.semantic_id)
            pin_expressions.append(
                node("pin", quoted(anchor.emitted_number), node("uuid", quoted(pin_id)))
            )
            bindings.append(
                _binding(
                    "logical-pin",
                    f"{anchor.pin.component_id}:{anchor.pin.pin_number}",
                    "schematic-pin",
                    pin_id,
                )
            )
        expressions.append(
            node(
                "symbol",
                node("lib_id", quoted(f"FluxGenerated:{_local_library_id(template)}")),
                _at_grid(placement.origin, (-placement.rotation_deg) % 360),
                node("unit", atom("1")),
                node("body_style", atom("1")),
                node("exclude_from_sim", atom("no")),
                node("in_bom", atom("yes")),
                node("on_board", atom("yes")),
                node("in_pos_files", atom("yes")),
                node("dnp", atom("no")),
                node("uuid", quoted(symbol_id)),
                *property_expressions,
                *pin_expressions,
                node(
                    "instances",
                    node(
                        "project",
                        quoted(stem),
                        node(
                            "path",
                            quoted(f"/{root_id}"),
                            node("reference", quoted(placement.reference)),
                            node("unit", atom("1")),
                        ),
                    ),
                ),
            )
        )
        bindings.append(
            _binding("component", placement.component_id, "schematic-symbol", symbol_id)
        )
    links = tuple(footprint_links.values())
    if len(links) != len(set(links)):
        raise HumanSchematicError(
            "human-footprint-link-collision",
            plan.semantic_graph.project_id,
            "footprint-link factory must return one component-unique link per placement",
        )
    return tuple(expressions), tuple(bindings)


def _wire_expressions(
    plan: HumanSchematicPlan, uuid_factory: HumanUUIDFactory
) -> tuple[tuple[tuple[SExpr, ...], ...], tuple[HumanEmissionBinding, ...]]:
    expressions: list[tuple[SExpr, ...]] = []
    bindings: list[HumanEmissionBinding] = []
    for wire in sorted(plan.wires, key=lambda item: item.semantic_id):
        wire_id = _uuid_value(uuid_factory, "human-wire", wire.semantic_id)
        expressions.append(
            node(
                "wire",
                node(
                    "pts",
                    node(
                        "xy",
                        atom(_mm_from_grid(wire.start.x)),
                        atom(_mm_from_grid(wire.start.y)),
                    ),
                    node("xy", atom(_mm_from_grid(wire.end.x)), atom(_mm_from_grid(wire.end.y))),
                ),
                node("stroke", node("width", atom("0")), node("type", atom("default"))),
                node("uuid", quoted(wire_id)),
            )
        )
        bindings.append(_binding("wire", wire.semantic_id, "schematic-wire", wire_id))
    return tuple(expressions), tuple(bindings)


def _label_angle(direction: str) -> int:
    try:
        return {"east": 0, "north": 90, "south": 270, "west": 180}[direction]
    except KeyError as exc:
        raise ValueError("label direction must be cardinal") from exc


def _label_expressions(
    plan: HumanSchematicPlan, uuid_factory: HumanUUIDFactory
) -> tuple[tuple[tuple[SExpr, ...], ...], tuple[HumanEmissionBinding, ...]]:
    expressions: list[tuple[SExpr, ...]] = []
    bindings: list[HumanEmissionBinding] = []
    for label in sorted(plan.local_labels, key=lambda item: item.semantic_id):
        label_id = _uuid_value(uuid_factory, "human-local-label", label.semantic_id)
        expressions.append(
            node(
                "label",
                quoted(label.name),
                _at_grid(label.anchor, _label_angle(label.direction)),
                _effects(justify_left=True),
                node("uuid", quoted(label_id)),
            )
        )
        bindings.append(
            _binding("local-label", label.semantic_id, "schematic-local-label", label_id)
        )
    return tuple(expressions), tuple(bindings)


def _junction_expressions(
    plan: HumanSchematicPlan, uuid_factory: HumanUUIDFactory
) -> tuple[tuple[tuple[SExpr, ...], ...], tuple[HumanEmissionBinding, ...]]:
    expressions: list[tuple[SExpr, ...]] = []
    bindings: list[HumanEmissionBinding] = []
    for junction in sorted(plan.junctions, key=lambda item: item.semantic_id):
        junction_id = _uuid_value(uuid_factory, "human-junction", junction.semantic_id)
        expressions.append(
            node(
                "junction",
                _at_grid(junction.position),
                node("diameter", atom("0")),
                node("color", atom("0"), atom("0"), atom("0"), atom("0")),
                node("uuid", quoted(junction_id)),
            )
        )
        bindings.append(
            _binding("junction", junction.semantic_id, "schematic-junction", junction_id)
        )
    return tuple(expressions), tuple(bindings)


def _no_connect_expressions(
    plan: HumanSchematicPlan, uuid_factory: HumanUUIDFactory
) -> tuple[tuple[tuple[SExpr, ...], ...], tuple[HumanEmissionBinding, ...]]:
    expressions: list[tuple[SExpr, ...]] = []
    bindings: list[HumanEmissionBinding] = []
    for marker in sorted(plan.no_connects, key=lambda item: item.semantic_id):
        marker_id = _uuid_value(uuid_factory, "human-no-connect", marker.semantic_id)
        expressions.append(
            node("no_connect", _at_grid(marker.marker), node("uuid", quoted(marker_id)))
        )
        bindings.append(
            _binding("no-connect", marker.semantic_id, "schematic-no-connect", marker_id)
        )
    return tuple(expressions), tuple(bindings)


def _validate_plan_for_emission(plan: HumanSchematicPlan) -> None:
    if type(plan) is not HumanSchematicPlan:
        raise TypeError("human emission requires an exact HumanSchematicPlan")
    try:
        HumanSchematicPlan(
            plan.schema_version,
            plan.planner_id,
            plan.semantic_graph,
            plan.sheet,
            plan.symbol_sources,
            plan.source_verifications,
            plan.symbol_templates,
            plan.blocks,
            plan.placements,
            plan.wires,
            plan.local_labels,
            plan.junctions,
            plan.no_connects,
            plan.global_label_count,
            plan.manufacturing_release_eligible,
        )
    except (TypeError, ValueError) as exc:
        raise HumanSchematicError(
            "human-emission-plan-invalid",
            plan.semantic_graph.project_id,
            "human-schematic plan was mutated after invariant validation",
        ) from exc
    actual = (
        len(plan.symbol_templates),
        len(plan.placements),
        len(plan.wires),
        len(plan.local_labels),
        len(plan.junctions),
        len(plan.no_connects),
    )
    if actual != _EXPECTED_COUNTS or plan.global_label_count != 0:
        raise HumanSchematicError(
            "human-emission-profile-mismatch",
            plan.semantic_graph.project_id,
            "definition/symbol/wire/label/junction/NC counts "
            f"{actual!r} are not R2 {_EXPECTED_COUNTS!r}",
        )
    if any(len(item.properties) != 9 for item in plan.placements):
        raise HumanSchematicError(
            "human-emission-profile-mismatch",
            plan.semantic_graph.project_id,
            "every placed symbol must carry exactly nine explicit plan properties",
        )
    expected_profiles = tuple(item.profile_id for item in _PROFILE_SPECS)
    actual_profiles = tuple(item.profile_id for item in plan.symbol_templates)
    if actual_profiles != expected_profiles:
        raise HumanSchematicError(
            "human-symbol-template-unemittable",
            plan.semantic_graph.project_id,
            "plan template inventory differs from the closed ten-profile emitter",
        )
    spec_index = {item.profile_id: item for item in _PROFILE_SPECS}
    for template in plan.symbol_templates:
        spec = spec_index[template.profile_id]
        if template.source_ids != (spec.source_id,):
            raise HumanSchematicError(
                "human-symbol-template-unemittable",
                template.profile_id,
                "template source binding differs from the explicit emitter profile",
            )


@dataclass(frozen=True, slots=True)
class _BuiltEmission:
    schematic_expression: tuple[SExpr, ...]
    symbol_library_expression: tuple[SExpr, ...]
    bindings: tuple[HumanEmissionBinding, ...]


def _build_emission(
    plan: HumanSchematicPlan,
    *,
    stem: str,
    uuid_factory: HumanUUIDFactory,
    footprint_link_factory: HumanFootprintLinkFactory,
    source_payload_resolver: SourcePayloadProvider,
) -> _BuiltEmission:
    _validate_plan_for_emission(plan)
    _validate_stem(stem)
    if not callable(uuid_factory) or not callable(footprint_link_factory):
        raise TypeError("human emission identity and footprint policies must be callable")
    payloads = _resolve_source_payloads(plan, source_payload_resolver)
    spec_index = {item.profile_id: item for item in _PROFILE_SPECS}
    placement_index = {item.symbol_profile_id: item for item in plan.placements}
    definitions = tuple(
        _symbol_definition(
            template,
            spec_index[template.profile_id],
            payloads,
            placement_index[template.profile_id].reference,
        )
        for template in plan.symbol_templates
    )
    # The schematic root is a project-file identity, not an emitter-private
    # drawing identity.  Sharing this semantic key with the .kicad_pro emitter
    # keeps KiCad's top-level sheet UUID and the .kicad_sch root UUID exact.
    root_id = _uuid_value(uuid_factory, "schematic-root", plan.semantic_graph.project_id)
    block_expressions, block_bindings = _block_expressions(plan, uuid_factory)
    junction_expressions, junction_bindings = _junction_expressions(plan, uuid_factory)
    no_connect_expressions, no_connect_bindings = _no_connect_expressions(plan, uuid_factory)
    wire_expressions, wire_bindings = _wire_expressions(plan, uuid_factory)
    label_expressions, label_bindings = _label_expressions(plan, uuid_factory)
    symbol_expressions, symbol_bindings = _placed_symbols(
        plan, stem, root_id, uuid_factory, footprint_link_factory
    )
    bindings: list[HumanEmissionBinding] = [
        _binding("project", plan.semantic_graph.project_id, "schematic-root", root_id)
    ]
    for template in plan.symbol_templates:
        bindings.append(
            _binding(
                "symbol-template",
                template.profile_id,
                "embedded-library-symbol",
                f"FluxGenerated:{_local_library_id(template)}",
            )
        )
    bindings.extend(
        (
            *block_bindings,
            *junction_bindings,
            *no_connect_bindings,
            *wire_bindings,
            *label_bindings,
            *symbol_bindings,
        )
    )
    emitted_uuid_ids = tuple(
        emitted_id
        for binding in bindings
        for emitted_id in binding.emitted_ids
        if _looks_like_uuid(emitted_id)
    )
    if len(emitted_uuid_ids) != len(set(emitted_uuid_ids)):
        raise HumanSchematicError(
            "human-emission-uuid-collision",
            plan.semantic_graph.project_id,
            "UUID factory returned one identity for multiple semantic subjects",
        )
    schematic = node(
        "kicad_sch",
        node("version", atom(str(_SCHEMATIC_VERSION))),
        node("generator", quoted("flux_clone")),
        node("generator_version", quoted("10.0")),
        node("uuid", quoted(root_id)),
        node("paper", quoted("A4")),
        node(
            "title_block",
            node("title", quoted("USB-C 5 V sink to 3.3 V reference PCB")),
            node("rev", quoted("REV2")),
            node(
                "comment",
                atom("1"),
                quoted("3V3 OUT 100mA MAX / DO NOT APPLY POWER"),
            ),
        ),
        node("lib_symbols", *definitions),
        *block_expressions,
        *junction_expressions,
        *no_connect_expressions,
        *wire_expressions,
        *label_expressions,
        *symbol_expressions,
        node("sheet_instances", node("path", quoted("/"), node("page", quoted("1")))),
        node("embedded_fonts", atom("no")),
    )
    library = node(
        "kicad_symbol_lib",
        node("version", atom(str(_SYMBOL_LIBRARY_VERSION))),
        node("generator", quoted("flux_clone")),
        node("generator_version", quoted("10.0")),
        *(_external_definition(item) for item in definitions),
    )
    return _BuiltEmission(schematic, library, tuple(sorted(bindings)))


def _new_emission(plan: HumanSchematicPlan, built: _BuiltEmission) -> HumanSchematicEmission:
    schematic_payload = render(built.schematic_expression)
    symbol_library_payload = render(built.symbol_library_expression)
    schematic_sha256 = _sha256(schematic_payload)
    symbol_library_sha256 = _sha256(symbol_library_payload)
    identity_manifest_sha256 = _sha256(_identity_payload(built.bindings))
    provisional = HumanSchematicEmission.__new__(HumanSchematicEmission)
    object.__setattr__(provisional, "emitter_id", HUMAN_SCHEMATIC_EMITTER_ID)
    object.__setattr__(provisional, "emitter_version", HUMAN_SCHEMATIC_EMITTER_VERSION)
    object.__setattr__(
        provisional, "subject_graph_sha256", plan.semantic_graph.subject_graph_sha256
    )
    object.__setattr__(provisional, "plan_sha256", plan.plan_digest)
    object.__setattr__(provisional, "schematic_payload", schematic_payload)
    object.__setattr__(provisional, "symbol_library_payload", symbol_library_payload)
    object.__setattr__(provisional, "identity_bindings", built.bindings)
    object.__setattr__(provisional, "schematic_sha256", schematic_sha256)
    object.__setattr__(provisional, "symbol_library_sha256", symbol_library_sha256)
    object.__setattr__(provisional, "identity_manifest_sha256", identity_manifest_sha256)
    object.__setattr__(provisional, "emission_sha256", "0" * 64)
    emission_sha256 = _sha256(_emission_digest_payload(provisional))
    return HumanSchematicEmission(
        HUMAN_SCHEMATIC_EMITTER_ID,
        HUMAN_SCHEMATIC_EMITTER_VERSION,
        plan.semantic_graph.subject_graph_sha256,
        plan.plan_digest,
        schematic_payload,
        symbol_library_payload,
        built.bindings,
        schematic_sha256,
        symbol_library_sha256,
        identity_manifest_sha256,
        emission_sha256,
    )


def _verify_against_built(
    plan: HumanSchematicPlan,
    emission: HumanSchematicEmission,
    built: _BuiltEmission,
) -> HumanSchematicEmission:
    if type(emission) is not HumanSchematicEmission:
        raise TypeError("human emission verification requires the exact emission record")
    try:
        HumanSchematicEmission(
            emission.emitter_id,
            emission.emitter_version,
            emission.subject_graph_sha256,
            emission.plan_sha256,
            emission.schematic_payload,
            emission.symbol_library_payload,
            emission.identity_bindings,
            emission.schematic_sha256,
            emission.symbol_library_sha256,
            emission.identity_manifest_sha256,
            emission.emission_sha256,
        )
    except (TypeError, ValueError) as exc:
        raise HumanSchematicError(
            "human-emission-evidence-invalid",
            plan.semantic_graph.project_id,
            "emission payload or digest evidence was mutated",
        ) from exc
    if emission.subject_graph_sha256 != plan.semantic_graph.subject_graph_sha256:
        raise HumanSchematicError(
            "human-emission-subject-mismatch",
            plan.semantic_graph.project_id,
            "emission subject graph digest differs from the exact plan subject",
        )
    if emission.plan_sha256 != plan.plan_digest:
        raise HumanSchematicError(
            "human-emission-plan-mismatch",
            plan.semantic_graph.project_id,
            "emission plan digest differs from the exact plan",
        )
    actual_schematic = _parse_canonical(emission.schematic_payload, "schematic")
    if actual_schematic != built.schematic_expression:
        raise HumanSchematicError(
            "human-emission-schematic-parity-failed",
            plan.semantic_graph.project_id,
            "reparsed schematic AST differs from exact plan identities, geometry, or properties",
        )
    actual_library = _parse_canonical(emission.symbol_library_payload, "symbol-library")
    if actual_library != built.symbol_library_expression:
        raise HumanSchematicError(
            "human-emission-library-parity-failed",
            plan.semantic_graph.project_id,
            "reparsed FluxGenerated library differs from exact flattened definitions",
        )
    if emission.identity_bindings != built.bindings:
        raise HumanSchematicError(
            "human-emission-identity-parity-failed",
            plan.semantic_graph.project_id,
            "identity evidence differs from exact semantic-to-KiCad mappings",
        )
    return emission


def emit_human_schematic(
    plan: HumanSchematicPlan,
    *,
    stem: str,
    uuid_factory: HumanUUIDFactory,
    footprint_link_factory: HumanFootprintLinkFactory,
    source_payload_resolver: SourcePayloadProvider,
) -> HumanSchematicEmission:
    """Emit and self-verify one exact KiCad-10 R2 human schematic."""

    built = _build_emission(
        plan,
        stem=stem,
        uuid_factory=uuid_factory,
        footprint_link_factory=footprint_link_factory,
        source_payload_resolver=source_payload_resolver,
    )
    return _verify_against_built(plan, _new_emission(plan, built), built)


def verify_human_schematic_emission(
    plan: HumanSchematicPlan,
    emission: HumanSchematicEmission,
    *,
    stem: str,
    uuid_factory: HumanUUIDFactory,
    footprint_link_factory: HumanFootprintLinkFactory,
    source_payload_resolver: SourcePayloadProvider,
) -> HumanSchematicEmission:
    """Rebuild the expected AST and prove exact payload/evidence parity."""

    built = _build_emission(
        plan,
        stem=stem,
        uuid_factory=uuid_factory,
        footprint_link_factory=footprint_link_factory,
        source_payload_resolver=source_payload_resolver,
    )
    return _verify_against_built(plan, emission, built)


__all__ = (
    "HUMAN_SCHEMATIC_EMITTER_ID",
    "HUMAN_SCHEMATIC_EMITTER_VERSION",
    "HumanEmissionBinding",
    "HumanFootprintLinkFactory",
    "HumanSchematicEmission",
    "HumanUUIDFactory",
    "emit_human_schematic",
    "verify_human_schematic_emission",
)

"""Pure records and invariants for a deterministic human-schematic plan.

The records in this module are deliberately independent of KiCad's S-expression
transport.  Coordinates are integer indices on the 1.27 mm connection grid;
conversion to nanometres is exact and happens only through :class:`GridPoint`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from backend.design_kernel import stable_hash
from backend.design_kernel.model import canonical_json

GRID_NM = 1_270_000
A4_LANDSCAPE_WIDTH_NM = 297_000_000
A4_LANDSCAPE_HEIGHT_NM = 210_000_000
PLAN_HASH_DOMAIN = "flux-clone-human-schematic-plan-v1"

_SHA256 = re.compile(r"[0-9a-f]{64}")
_DIRECTIONS = frozenset({"east", "north", "south", "west"})
_ROTATIONS = frozenset({0, 90, 180, 270})


class HumanSchematicError(ValueError):
    """A stable fail-closed planning or validation error."""

    def __init__(self, code: str, entity_id: str, detail: str) -> None:
        _require_id(code, "error code")
        _require_id(entity_id, "error entity ID")
        _require_text(detail, "error detail")
        self.code = code
        self.entity_id = entity_id
        self.detail = detail
        super().__init__(f"{code}: {entity_id}: {detail}")


def _require_text(value: object, label: str) -> str:
    if (
        type(value) is not str
        or not value.strip()
        or any(ord(character) < 32 for character in value)
    ):
        raise ValueError(f"{label} must be non-empty control-free text")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{label} must contain valid Unicode") from exc
    return value


def _require_id(value: object, label: str) -> str:
    text = _require_text(value, label)
    if text != text.strip() or any(character.isspace() for character in text):
        raise ValueError(f"{label} must be a whitespace-free identifier")
    return text


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_int(value: object, label: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{label} must be an integer")
    return value


@dataclass(frozen=True, slots=True, order=True)
class GridPoint:
    """One exact point on the 1.27 mm schematic connection grid."""

    x: int
    y: int

    def __post_init__(self) -> None:
        _require_int(self.x, "grid X")
        _require_int(self.y, "grid Y")

    @property
    def x_nm(self) -> int:
        return self.x * GRID_NM

    @property
    def y_nm(self) -> int:
        return self.y * GRID_NM

    def moved(self, direction: str, distance: int = 1) -> GridPoint:
        if direction not in _DIRECTIONS:
            raise ValueError("direction must be north, east, south, or west")
        _require_int(distance, "grid distance")
        if distance < 0:
            raise ValueError("grid distance cannot be negative")
        dx, dy = {
            "east": (1, 0),
            "north": (0, -1),
            "south": (0, 1),
            "west": (-1, 0),
        }[direction]
        return GridPoint(self.x + dx * distance, self.y + dy * distance)


@dataclass(frozen=True, slots=True, order=True)
class GridEnvelope:
    """Closed, axis-aligned integer-grid envelope."""

    minimum: GridPoint
    maximum: GridPoint

    def __post_init__(self) -> None:
        if type(self.minimum) is not GridPoint or type(self.maximum) is not GridPoint:
            raise TypeError("grid envelope corners must be exact GridPoint values")
        if self.minimum.x > self.maximum.x or self.minimum.y > self.maximum.y:
            raise ValueError("grid envelope minimum must not exceed its maximum")

    def contains(self, point: GridPoint) -> bool:
        return (
            self.minimum.x <= point.x <= self.maximum.x
            and self.minimum.y <= point.y <= self.maximum.y
        )

    def intersects(self, other: GridEnvelope) -> bool:
        return not (
            self.maximum.x < other.minimum.x
            or other.maximum.x < self.minimum.x
            or self.maximum.y < other.minimum.y
            or other.maximum.y < self.minimum.y
        )

    def translated(self, offset: GridPoint) -> GridEnvelope:
        return GridEnvelope(
            GridPoint(self.minimum.x + offset.x, self.minimum.y + offset.y),
            GridPoint(self.maximum.x + offset.x, self.maximum.y + offset.y),
        )

    def expanded(self, amount: int) -> GridEnvelope:
        _require_int(amount, "envelope expansion")
        if amount < 0:
            raise ValueError("envelope expansion cannot be negative")
        return GridEnvelope(
            GridPoint(self.minimum.x - amount, self.minimum.y - amount),
            GridPoint(self.maximum.x + amount, self.maximum.y + amount),
        )


def local_label_envelope(anchor: GridPoint, name: str, direction: str) -> GridEnvelope:
    """Return the exact grid envelope of a left-anchored cardinal local label."""

    if type(anchor) is not GridPoint:
        raise TypeError("local-label anchor must be an exact GridPoint")
    _require_text(name, "local-label name")
    if direction not in _DIRECTIONS:
        raise ValueError("local-label direction must be cardinal")
    width = max(2, (3 * len(name) + 4) // 5)
    if direction == "east":
        return GridEnvelope(anchor, GridPoint(anchor.x + width - 1, anchor.y))
    if direction == "west":
        return GridEnvelope(GridPoint(anchor.x - width + 1, anchor.y), anchor)
    if direction == "north":
        return GridEnvelope(GridPoint(anchor.x, anchor.y - width + 1), anchor)
    return GridEnvelope(anchor, GridPoint(anchor.x, anchor.y + width - 1))


@dataclass(frozen=True, slots=True, order=True)
class SheetSpec:
    paper: str
    orientation: str
    width_nm: int
    height_nm: int
    connection_grid_nm: int
    content: GridEnvelope

    def __post_init__(self) -> None:
        if self.paper != "A4" or self.orientation != "landscape":
            raise ValueError("human schematic sheet must be A4 landscape")
        if self.width_nm != A4_LANDSCAPE_WIDTH_NM or self.height_nm != A4_LANDSCAPE_HEIGHT_NM:
            raise ValueError("A4 landscape sheet dimensions must be exact integer nanometres")
        if self.connection_grid_nm != GRID_NM:
            raise ValueError("human schematic connection grid must be exactly 1.27 mm")
        if type(self.content) is not GridEnvelope:
            raise TypeError("sheet content bounds must be an exact GridEnvelope")
        if self.content.minimum.x < 0 or self.content.minimum.y < 0:
            raise ValueError("sheet content cannot start outside the page")
        if (
            self.content.maximum.x * GRID_NM > self.width_nm
            or self.content.maximum.y * GRID_NM > self.height_nm
        ):
            raise ValueError("sheet content grid must fit inside A4 landscape")


@dataclass(frozen=True, slots=True, order=True)
class SemanticPin:
    component_id: str
    pin_number: str

    def __post_init__(self) -> None:
        _require_id(self.component_id, "pin component ID")
        _require_id(self.pin_number, "logical pin number")

    @property
    def semantic_id(self) -> str:
        return f"pin:{self.component_id}:{self.pin_number}"


@dataclass(frozen=True, slots=True, order=True)
class SemanticPinDefinition:
    """One exact canonical graph pin definition, without presentation projection."""

    number: str
    name: str
    electrical_type: str
    pad_number: str
    required: bool

    def __post_init__(self) -> None:
        _require_id(self.number, "canonical pin number")
        _require_text(self.name, "canonical pin name")
        _require_id(self.electrical_type, "canonical pin electrical type")
        _require_id(self.pad_number, "canonical pin pad number")
        if type(self.required) is not bool:
            raise ValueError("canonical pin required flag must be boolean")


@dataclass(frozen=True, slots=True, order=True)
class SemanticComponent:
    component_id: str
    reference: str
    value: str
    manufacturer_part_number: str
    package: str
    symbol_id: str
    footprint_id: str
    datasheet_sha256: str
    pin_map_sha256: str
    pin_definitions: tuple[SemanticPinDefinition, ...]

    def __post_init__(self) -> None:
        _require_id(self.component_id, "component ID")
        _require_id(self.reference, "component reference")
        for value, label in (
            (self.value, "component value"),
            (self.manufacturer_part_number, "manufacturer part number"),
            (self.package, "component package"),
            (self.symbol_id, "component symbol ID"),
            (self.footprint_id, "component footprint ID"),
        ):
            _require_text(value, label)
        _require_sha256(self.datasheet_sha256, "component datasheet digest")
        _require_sha256(self.pin_map_sha256, "component pin-map digest")
        if (
            type(self.pin_definitions) is not tuple
            or not self.pin_definitions
            or any(type(item) is not SemanticPinDefinition for item in self.pin_definitions)
        ):
            raise ValueError("component pin definitions must be a non-empty exact tuple")
        if self.pin_definitions != tuple(
            sorted(self.pin_definitions, key=lambda item: item.number)
        ):
            raise ValueError("component pin definitions must be sorted by canonical number")
        if len({item.number for item in self.pin_definitions}) != len(self.pin_definitions):
            raise ValueError("component canonical pin numbers must be unique")
        if len({item.pad_number for item in self.pin_definitions}) != len(self.pin_definitions):
            raise ValueError("component canonical pad numbers must be unique")

    @property
    def semantic_id(self) -> str:
        return f"component:{self.component_id}"

    @property
    def pin_numbers(self) -> tuple[str, ...]:
        return tuple(item.number for item in self.pin_definitions)

    @property
    def component_digest(self) -> str:
        return stable_hash(self, domain="flux-clone-human-semantic-component-v1")

    def pin_definition(self, pin_number: str) -> SemanticPinDefinition:
        return next(item for item in self.pin_definitions if item.number == pin_number)


@dataclass(frozen=True, slots=True, order=True)
class SemanticNet:
    net_id: str
    name: str

    def __post_init__(self) -> None:
        _require_id(self.net_id, "net ID")
        _require_text(self.name, "net name")

    @property
    def semantic_id(self) -> str:
        return f"net:{self.net_id}"


@dataclass(frozen=True, slots=True, order=True)
class NetMembership:
    semantic_id: str
    net_id: str
    pin: SemanticPin

    def __post_init__(self) -> None:
        _require_id(self.semantic_id, "membership semantic ID")
        _require_id(self.net_id, "membership net ID")
        if type(self.pin) is not SemanticPin:
            raise TypeError("membership pin must be an exact SemanticPin")
        expected = f"membership:{self.net_id}:{self.pin.component_id}:{self.pin.pin_number}"
        if self.semantic_id != expected:
            raise ValueError("membership semantic ID must derive only from semantic subjects")


@dataclass(frozen=True, slots=True)
class SemanticGraph:
    project_id: str
    subject_graph_sha256: str
    components: tuple[SemanticComponent, ...]
    nets: tuple[SemanticNet, ...]
    memberships: tuple[NetMembership, ...]
    no_connects: tuple[SemanticPin, ...]

    def __post_init__(self) -> None:
        _require_id(self.project_id, "semantic graph project ID")
        _require_sha256(self.subject_graph_sha256, "semantic graph subject digest")
        if type(self.components) is not tuple or any(
            type(item) is not SemanticComponent for item in self.components
        ):
            raise TypeError("semantic components must be an exact immutable tuple")
        if type(self.nets) is not tuple or any(type(item) is not SemanticNet for item in self.nets):
            raise TypeError("semantic nets must be an exact immutable tuple")
        if type(self.memberships) is not tuple or any(
            type(item) is not NetMembership for item in self.memberships
        ):
            raise TypeError("semantic memberships must be an exact immutable tuple")
        if type(self.no_connects) is not tuple or any(
            type(item) is not SemanticPin for item in self.no_connects
        ):
            raise TypeError("semantic no-connects must be an exact immutable tuple")
        if self.components != tuple(sorted(self.components, key=lambda item: item.component_id)):
            raise ValueError("semantic components must be sorted by component ID")
        if self.nets != tuple(sorted(self.nets, key=lambda item: item.net_id)):
            raise ValueError("semantic nets must be sorted by net ID")
        if self.memberships != tuple(sorted(self.memberships, key=lambda item: item.semantic_id)):
            raise ValueError("semantic memberships must be sorted by semantic ID")
        if self.no_connects != tuple(sorted(self.no_connects)):
            raise ValueError("semantic no-connects must be sorted")

        component_index = {item.component_id: item for item in self.components}
        net_ids = {item.net_id for item in self.nets}
        if len(component_index) != len(self.components) or len(net_ids) != len(self.nets):
            raise ValueError("semantic component and net IDs must be unique")
        if len({item.reference for item in self.components}) != len(self.components):
            raise ValueError("semantic component references must be unique")
        all_pins = {
            SemanticPin(component.component_id, pin_number)
            for component in self.components
            for pin_number in component.pin_numbers
        }
        connected = {item.pin for item in self.memberships}
        no_connects = set(self.no_connects)
        if len(connected) != len(self.memberships):
            raise ValueError("a semantic pin cannot belong to multiple nets")
        if any(item.net_id not in net_ids for item in self.memberships):
            raise ValueError("semantic membership references an unknown net")
        if connected & no_connects:
            raise ValueError("a semantic pin cannot be both connected and no-connect")
        if connected | no_connects != all_pins:
            raise ValueError("every semantic pin must be connected or explicitly no-connect")


@dataclass(frozen=True, slots=True, order=True)
class SymbolSource:
    source_id: str
    authority: str
    revision: str
    path: str
    byte_length: int
    sha256: str

    def __post_init__(self) -> None:
        _require_id(self.source_id, "symbol source ID")
        _require_text(self.authority, "symbol source authority")
        _require_text(self.revision, "symbol source revision")
        _require_text(self.path, "symbol source path")
        _require_int(self.byte_length, "symbol source byte length")
        if self.byte_length <= 0:
            raise ValueError("symbol source byte length must be positive")
        _require_sha256(self.sha256, "symbol source digest")


@dataclass(frozen=True, slots=True, order=True)
class SourceVerification:
    """Proof that a resolver returned exact bytes for one source receipt."""

    source_id: str
    byte_length: int
    sha256: str

    def __post_init__(self) -> None:
        _require_id(self.source_id, "verified symbol source ID")
        _require_int(self.byte_length, "verified symbol source byte length")
        if self.byte_length <= 0:
            raise ValueError("verified symbol source byte length must be positive")
        _require_sha256(self.sha256, "verified symbol source digest")


@dataclass(frozen=True, slots=True, order=True)
class PinPort:
    logical_number: str
    emitted_number: str
    electrical_type: str
    canonical_name: str
    canonical_electrical_type: str
    canonical_pad_number: str
    canonical_required: bool
    offset: GridPoint
    direction: str

    def __post_init__(self) -> None:
        _require_id(self.logical_number, "port logical pin number")
        _require_id(self.emitted_number, "port emitted pin number")
        _require_id(self.electrical_type, "port electrical type")
        _require_text(self.canonical_name, "port canonical pin name")
        _require_id(self.canonical_electrical_type, "port canonical electrical type")
        _require_id(self.canonical_pad_number, "port canonical pad number")
        if type(self.canonical_required) is not bool:
            raise ValueError("port canonical required flag must be boolean")
        if self.emitted_number != self.canonical_pad_number:
            raise ValueError("emitted pin number must equal the canonical physical pad number")
        if type(self.offset) is not GridPoint:
            raise TypeError("port offset must be an exact GridPoint")
        if self.direction not in _DIRECTIONS:
            raise ValueError("port direction must be north, east, south, or west")

    @property
    def canonical_definition(self) -> SemanticPinDefinition:
        return SemanticPinDefinition(
            self.logical_number,
            self.canonical_name,
            self.canonical_electrical_type,
            self.canonical_pad_number,
            self.canonical_required,
        )


@dataclass(frozen=True, slots=True, order=True)
class SymbolTemplate:
    profile_id: str
    graph_symbol_id: str
    flattened_library_id: str
    derivation: str
    body: GridEnvelope
    pin_ports: tuple[PinPort, ...]
    source_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_id(self.profile_id, "symbol profile ID")
        _require_text(self.graph_symbol_id, "graph symbol ID")
        _require_text(self.flattened_library_id, "flattened library ID")
        _require_text(self.derivation, "symbol derivation")
        if type(self.body) is not GridEnvelope:
            raise TypeError("symbol body must be an exact GridEnvelope")
        if (
            type(self.pin_ports) is not tuple
            or not self.pin_ports
            or any(type(item) is not PinPort for item in self.pin_ports)
        ):
            raise ValueError("symbol pin ports must be a non-empty exact tuple")
        if self.pin_ports != tuple(sorted(self.pin_ports, key=lambda item: item.logical_number)):
            raise ValueError("symbol pin ports must be sorted by logical pin number")
        if len({item.logical_number for item in self.pin_ports}) != len(self.pin_ports):
            raise ValueError("symbol logical pin ports must be unique")
        if len({item.emitted_number for item in self.pin_ports}) != len(self.pin_ports):
            raise ValueError("symbol emitted pin ports must be unique")
        if any(self.body.contains(item.offset) for item in self.pin_ports):
            raise ValueError("symbol pin connection points must remain outside the body envelope")
        if (
            type(self.source_ids) is not tuple
            or not self.source_ids
            or any(type(item) is not str for item in self.source_ids)
        ):
            raise ValueError("symbol source IDs must be a non-empty exact tuple")
        if self.source_ids != tuple(sorted(set(self.source_ids))):
            raise ValueError("symbol source IDs must be sorted and unique")
        for source_id in self.source_ids:
            _require_id(source_id, "symbol source ID")

    @property
    def template_digest(self) -> str:
        return stable_hash(self, domain="flux-clone-human-symbol-template-v1")

    @property
    def canonical_pin_contract_digest(self) -> str:
        return stable_hash(
            tuple(item.canonical_definition for item in self.pin_ports),
            domain="flux-clone-human-symbol-pin-contract-v1",
        )


@dataclass(frozen=True, slots=True, order=True)
class PinAnchor:
    pin: SemanticPin
    semantic_id: str
    canonical_definition: SemanticPinDefinition
    emitted_number: str
    electrical_type: str
    symbol_template_digest: str
    position: GridPoint
    direction: str

    def __post_init__(self) -> None:
        if type(self.pin) is not SemanticPin:
            raise TypeError("pin anchor subject must be an exact SemanticPin")
        _require_id(self.semantic_id, "pin anchor semantic ID")
        if type(self.canonical_definition) is not SemanticPinDefinition:
            raise TypeError("pin anchor requires an exact canonical pin definition")
        if self.semantic_id != f"anchor:{self.pin.component_id}:{self.pin.pin_number}":
            raise ValueError("pin anchor ID must derive only from its semantic pin")
        if self.canonical_definition.number != self.pin.pin_number:
            raise ValueError("pin anchor canonical definition must match its semantic pin")
        _require_id(self.emitted_number, "pin anchor emitted number")
        _require_id(self.electrical_type, "pin anchor electrical type")
        _require_sha256(self.symbol_template_digest, "pin anchor symbol-template digest")
        if self.emitted_number != self.canonical_definition.pad_number:
            raise ValueError("pin anchor emitted number must equal canonical pad number")
        if type(self.position) is not GridPoint:
            raise TypeError("pin anchor position must be an exact GridPoint")
        if self.direction not in _DIRECTIONS:
            raise ValueError("pin anchor direction must be cardinal")


@dataclass(frozen=True, slots=True, order=True)
class PropertyRecord:
    semantic_id: str
    component_id: str
    name: str
    value: str
    visible: bool
    component_digest: str
    symbol_template_digest: str
    anchor: GridPoint
    envelope: GridEnvelope

    def __post_init__(self) -> None:
        _require_id(self.semantic_id, "property semantic ID")
        _require_id(self.component_id, "property component ID")
        _require_text(self.name, "property name")
        _require_text(self.value, "property value")
        if type(self.visible) is not bool:
            raise ValueError("property visibility must be boolean")
        _require_sha256(self.component_digest, "property component digest")
        _require_sha256(self.symbol_template_digest, "property symbol-template digest")
        if type(self.anchor) is not GridPoint or type(self.envelope) is not GridEnvelope:
            raise TypeError("property geometry must use exact grid records")
        expected = f"property:{self.component_id}:{self.name}"
        if self.semantic_id != expected:
            raise ValueError("property semantic ID must derive only from component and field name")
        if not self.envelope.contains(self.anchor):
            raise ValueError("property envelope must contain its explicit anchor")
        if self.visible and (
            self.envelope.minimum != self.anchor or self.envelope.maximum.y != self.anchor.y
        ):
            raise ValueError("visible property envelopes must be left-anchored horizontal text")


@dataclass(frozen=True, slots=True, order=True)
class ComponentPlacement:
    semantic_id: str
    component_id: str
    reference: str
    block_id: str
    symbol_profile_id: str
    component_digest: str
    symbol_template_digest: str
    origin: GridPoint
    rotation_deg: int
    body: GridEnvelope
    pin_anchors: tuple[PinAnchor, ...]
    properties: tuple[PropertyRecord, ...]
    fields_autoplaced: bool = False

    def __post_init__(self) -> None:
        _require_id(self.semantic_id, "placement semantic ID")
        _require_id(self.component_id, "placement component ID")
        _require_id(self.reference, "placement reference")
        _require_id(self.block_id, "functional block ID")
        _require_id(self.symbol_profile_id, "placement symbol profile ID")
        _require_sha256(self.component_digest, "placement component digest")
        _require_sha256(self.symbol_template_digest, "placement symbol-template digest")
        if self.semantic_id != f"symbol:{self.component_id}":
            raise ValueError("placement semantic ID must derive only from component ID")
        if type(self.origin) is not GridPoint or type(self.body) is not GridEnvelope:
            raise TypeError("placement geometry must use exact grid records")
        if self.rotation_deg not in _ROTATIONS:
            raise ValueError("symbol rotation must be an exact quadrant")
        if type(self.pin_anchors) is not tuple or any(
            type(item) is not PinAnchor for item in self.pin_anchors
        ):
            raise TypeError("placement pin anchors must be an exact tuple")
        if self.pin_anchors != tuple(
            sorted(self.pin_anchors, key=lambda item: item.pin.pin_number)
        ):
            raise ValueError("placement pin anchors must be sorted by logical pin")
        if len({item.pin for item in self.pin_anchors}) != len(self.pin_anchors):
            raise ValueError("placement pin anchors must be unique")
        if type(self.properties) is not tuple or any(
            type(item) is not PropertyRecord for item in self.properties
        ):
            raise TypeError("placement properties must be an exact tuple")
        if self.properties != tuple(sorted(self.properties, key=lambda item: item.name)):
            raise ValueError("placement properties must be sorted by name")
        if len({item.name for item in self.properties}) != len(self.properties):
            raise ValueError("placement property names must be unique")
        if any(item.pin.component_id != self.component_id for item in self.pin_anchors):
            raise ValueError("placement pin anchors must belong to its component")
        if any(item.component_id != self.component_id for item in self.properties):
            raise ValueError("placement properties must belong to its component")
        if type(self.fields_autoplaced) is not bool or self.fields_autoplaced:
            raise ValueError("human-schematic property auto-placement is forbidden")


@dataclass(frozen=True, slots=True, order=True)
class FunctionalBlock:
    block_id: str
    title: str
    envelope: GridEnvelope
    title_anchor: GridPoint
    title_envelope: GridEnvelope
    component_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_id(self.block_id, "functional block ID")
        _require_text(self.title, "functional block title")
        if (
            type(self.envelope) is not GridEnvelope
            or type(self.title_anchor) is not GridPoint
            or type(self.title_envelope) is not GridEnvelope
        ):
            raise TypeError("functional block geometry must use exact grid records")
        if not self.title_envelope.contains(self.title_anchor):
            raise ValueError("functional block title envelope must contain its anchor")
        if (
            self.title_envelope.minimum != self.title_anchor
            or self.title_envelope.maximum.y != self.title_anchor.y
        ):
            raise ValueError("functional block titles must be left-anchored horizontal text")
        if not self.envelope.contains(self.title_anchor):
            raise ValueError("functional block title must be inside its block")
        if (
            type(self.component_ids) is not tuple
            or not self.component_ids
            or any(type(item) is not str for item in self.component_ids)
        ):
            raise ValueError("functional block component IDs must be a non-empty exact tuple")
        if self.component_ids != tuple(sorted(set(self.component_ids))):
            raise ValueError("functional block component IDs must be sorted and unique")


@dataclass(frozen=True, slots=True, order=True)
class WireSegment:
    semantic_id: str
    route_id: str
    net_id: str
    ordinal: int
    start: GridPoint
    end: GridPoint

    def __post_init__(self) -> None:
        _require_id(self.semantic_id, "wire semantic ID")
        _require_id(self.route_id, "wire route ID")
        _require_id(self.net_id, "wire net ID")
        _require_int(self.ordinal, "wire segment ordinal")
        if self.ordinal < 0:
            raise ValueError("wire segment ordinal cannot be negative")
        if type(self.start) is not GridPoint or type(self.end) is not GridPoint:
            raise TypeError("wire endpoints must be exact GridPoint values")
        if self.start == self.end or (self.start.x != self.end.x and self.start.y != self.end.y):
            raise ValueError("human schematic wires must be non-zero and orthogonal")
        if self.semantic_id != f"wire:{self.route_id}:{self.ordinal}":
            raise ValueError("wire semantic ID must derive from semantic route and ordinal")


@dataclass(frozen=True, slots=True, order=True)
class LocalLabel:
    semantic_id: str
    net_id: str
    name: str
    island_id: str
    members: tuple[SemanticPin, ...]
    anchor: GridPoint
    envelope: GridEnvelope
    direction: str
    reason: str

    def __post_init__(self) -> None:
        _require_id(self.semantic_id, "local-label semantic ID")
        _require_id(self.net_id, "local-label net ID")
        _require_text(self.name, "local-label name")
        _require_id(self.island_id, "local-label island ID")
        if (
            type(self.members) is not tuple
            or not self.members
            or any(type(item) is not SemanticPin for item in self.members)
        ):
            raise ValueError("local-label members must be a non-empty exact tuple")
        if self.members != tuple(sorted(set(self.members))):
            raise ValueError("local-label members must be sorted and unique")
        if type(self.anchor) is not GridPoint or type(self.envelope) is not GridEnvelope:
            raise TypeError("local-label geometry must use exact grid records")
        if self.direction not in _DIRECTIONS:
            raise ValueError("local-label direction must be cardinal")
        if self.envelope != local_label_envelope(self.anchor, self.name, self.direction):
            raise ValueError("local-label envelope must exactly match its cardinal text transform")
        _require_text(self.reason, "local-label fallback reason")
        if self.semantic_id != f"label:{self.net_id}:{self.island_id}":
            raise ValueError("local-label semantic ID must derive only from net and island")


@dataclass(frozen=True, slots=True, order=True)
class Junction:
    semantic_id: str
    net_id: str
    incident_wire_ids: tuple[str, ...]
    position: GridPoint
    degree: int

    def __post_init__(self) -> None:
        _require_id(self.semantic_id, "junction semantic ID")
        _require_id(self.net_id, "junction net ID")
        if type(self.incident_wire_ids) is not tuple or self.incident_wire_ids != tuple(
            sorted(set(self.incident_wire_ids))
        ):
            raise ValueError("junction incident wire IDs must be a sorted unique tuple")
        if type(self.position) is not GridPoint:
            raise TypeError("junction position must be an exact GridPoint")
        _require_int(self.degree, "junction degree")
        if self.degree != 3 or len(self.incident_wire_ids) != 3:
            raise ValueError("only exact degree-three junctions may be emitted")
        subject = stable_hash(
            {"net_id": self.net_id, "incident_wire_ids": self.incident_wire_ids},
            domain="flux-clone-human-junction-subject-v1",
        )[:20]
        if self.semantic_id != f"junction:{self.net_id}:{subject}":
            raise ValueError("junction semantic ID must derive from semantic incident wires")


@dataclass(frozen=True, slots=True, order=True)
class NoConnect:
    semantic_id: str
    pin: SemanticPin
    emitted_number: str
    marker: GridPoint

    def __post_init__(self) -> None:
        _require_id(self.semantic_id, "no-connect semantic ID")
        if type(self.pin) is not SemanticPin:
            raise TypeError("no-connect subject must be an exact SemanticPin")
        _require_id(self.emitted_number, "no-connect emitted pin number")
        if type(self.marker) is not GridPoint:
            raise TypeError("no-connect marker must be an exact GridPoint")
        if self.semantic_id != f"no-connect:{self.pin.component_id}:{self.pin.pin_number}":
            raise ValueError("no-connect semantic ID must derive only from semantic pin")


def segment_points(segment: WireSegment) -> tuple[GridPoint, ...]:
    """Return every integer connection-grid point occupied by an orthogonal segment."""

    if segment.start.x == segment.end.x:
        low, high = sorted((segment.start.y, segment.end.y))
        return tuple(GridPoint(segment.start.x, y) for y in range(low, high + 1))
    low, high = sorted((segment.start.x, segment.end.x))
    return tuple(GridPoint(x, segment.start.y) for x in range(low, high + 1))


def _visible_envelopes(placements: tuple[ComponentPlacement, ...]) -> tuple[GridEnvelope, ...]:
    return tuple(
        prop.envelope for placement in placements for prop in placement.properties if prop.visible
    )


def _validate_plan_geometry(plan: HumanSchematicPlan) -> None:
    content = plan.sheet.content
    bodies = tuple(item.body for item in plan.placements)
    properties = _visible_envelopes(plan.placements)
    title_envelopes = tuple(item.title_envelope for item in plan.blocks)
    obstacles = bodies + properties + title_envelopes

    for label, points in (
        ("body", tuple(point for item in bodies for point in (item.minimum, item.maximum))),
        (
            "property",
            tuple(point for item in properties for point in (item.minimum, item.maximum)),
        ),
        (
            "pin anchor",
            tuple(anchor.position for item in plan.placements for anchor in item.pin_anchors),
        ),
        ("wire", tuple(point for item in plan.wires for point in (item.start, item.end))),
        (
            "local label",
            tuple(
                point
                for item in plan.local_labels
                for point in (item.envelope.minimum, item.envelope.maximum)
            ),
        ),
        ("junction", tuple(item.position for item in plan.junctions)),
        ("no-connect", tuple(item.marker for item in plan.no_connects)),
    ):
        if any(not content.contains(point) for point in points):
            raise ValueError(f"{label} geometry must remain inside A4 content bounds")

    for first_index, first in enumerate(bodies):
        if any(first.intersects(second) for second in bodies[first_index + 1 :]):
            raise ValueError("component body envelopes cannot overlap")
    for prop in properties:
        if any(prop.intersects(body) for body in bodies):
            raise ValueError("visible property envelopes cannot penetrate symbol bodies")
    for first_index, first in enumerate(properties):
        if any(first.intersects(second) for second in properties[first_index + 1 :]):
            raise ValueError("visible property envelopes cannot overlap")

    wire_points = {item.semantic_id: frozenset(segment_points(item)) for item in plan.wires}
    for wire in plan.wires:
        if any(
            any(obstacle.contains(point) for point in wire_points[wire.semantic_id])
            for obstacle in obstacles
        ):
            raise ValueError("wire cannot penetrate a symbol body, property, or block title")
    for first_index, first in enumerate(plan.wires):
        first_points = wire_points[first.semantic_id]
        for second in plan.wires[first_index + 1 :]:
            shared = first_points & wire_points[second.semantic_id]
            if not shared:
                continue
            if first.net_id != second.net_id:
                raise ValueError("different schematic nets cannot intersect")
            common_endpoints = frozenset({first.start, first.end} & {second.start, second.end})
            if shared != common_endpoints or len(shared) != 1:
                raise ValueError("same-net segments may meet only at one split endpoint")

    for label in plan.local_labels:
        if any(label.envelope.intersects(obstacle) for obstacle in obstacles):
            raise ValueError("local-label envelope cannot overlap a body or property")
        for wire in plan.wires:
            covered = {
                point
                for point in wire_points[wire.semantic_id]
                if label.envelope.contains(point)
            }
            if covered - {label.anchor}:
                raise ValueError("local-label envelope cannot cover a wire beyond its anchor")
    for first_index, first in enumerate(plan.local_labels):
        for second in plan.local_labels[first_index + 1 :]:
            if first.envelope.intersects(second.envelope):
                raise ValueError("local-label envelopes cannot overlap")

    pin_nets = {item.pin: item.net_id for item in plan.semantic_graph.memberships}
    pins_at_position: dict[GridPoint, list[SemanticPin]] = {}
    for placement in plan.placements:
        for anchor in placement.pin_anchors:
            pins_at_position.setdefault(anchor.position, []).append(anchor.pin)
    no_connects = set(plan.semantic_graph.no_connects)
    for wire in plan.wires:
        for point in wire_points[wire.semantic_id]:
            for pin in pins_at_position.get(point, []):
                if pin in no_connects or pin_nets.get(pin) != wire.net_id:
                    raise ValueError("wire cannot touch a foreign-net or no-connect pin anchor")

    degrees: dict[tuple[str, GridPoint], list[str]] = {}
    for wire in plan.wires:
        degrees.setdefault((wire.net_id, wire.start), []).append(wire.semantic_id)
        degrees.setdefault((wire.net_id, wire.end), []).append(wire.semantic_id)
    if any(len(items) > 3 for items in degrees.values()):
        raise ValueError("schematic wire graph degree cannot exceed three")
    expected_junctions = {
        (net_id, point): tuple(sorted(items))
        for (net_id, point), items in degrees.items()
        if len(items) == 3
    }
    actual_junctions = {
        (item.net_id, item.position): item.incident_wire_ids for item in plan.junctions
    }
    if actual_junctions != expected_junctions:
        raise ValueError("junction inventory must exactly mark every degree-three split join")


@dataclass(frozen=True, slots=True)
class HumanSchematicPlan:
    """Complete neutral human-schematic plan bound to one canonical graph."""

    schema_version: int
    planner_id: str
    semantic_graph: SemanticGraph
    sheet: SheetSpec
    symbol_sources: tuple[SymbolSource, ...]
    source_verifications: tuple[SourceVerification, ...]
    symbol_templates: tuple[SymbolTemplate, ...]
    blocks: tuple[FunctionalBlock, ...]
    placements: tuple[ComponentPlacement, ...]
    wires: tuple[WireSegment, ...]
    local_labels: tuple[LocalLabel, ...]
    junctions: tuple[Junction, ...]
    no_connects: tuple[NoConnect, ...]
    global_label_count: int = 0
    manufacturing_release_eligible: bool = False

    def __post_init__(self) -> None:
        if self.schema_version != 1:
            raise ValueError("human schematic plan schema must be 1")
        _require_id(self.planner_id, "human schematic planner ID")
        if type(self.semantic_graph) is not SemanticGraph or type(self.sheet) is not SheetSpec:
            raise TypeError("plan requires exact semantic graph and sheet records")
        collections: tuple[tuple[str, object, type[object]], ...] = (
            ("symbol sources", self.symbol_sources, SymbolSource),
            ("source verifications", self.source_verifications, SourceVerification),
            ("symbol templates", self.symbol_templates, SymbolTemplate),
            ("functional blocks", self.blocks, FunctionalBlock),
            ("placements", self.placements, ComponentPlacement),
            ("wires", self.wires, WireSegment),
            ("local labels", self.local_labels, LocalLabel),
            ("junctions", self.junctions, Junction),
            ("no-connects", self.no_connects, NoConnect),
        )
        for label, values, item_type in collections:
            if type(values) is not tuple or any(type(item) is not item_type for item in values):
                raise TypeError(f"{label} must be an exact immutable tuple")
        if self.symbol_sources != tuple(
            sorted(self.symbol_sources, key=lambda item: item.source_id)
        ):
            raise ValueError("symbol sources must be deterministically sorted")
        if self.symbol_templates != tuple(
            sorted(self.symbol_templates, key=lambda item: item.profile_id)
        ):
            raise ValueError("symbol templates must be deterministically sorted")
        if self.source_verifications != tuple(
            sorted(self.source_verifications, key=lambda item: item.source_id)
        ):
            raise ValueError("source verifications must be deterministically sorted")
        if self.blocks != tuple(sorted(self.blocks)):
            raise ValueError("functional blocks must be deterministically sorted")
        if self.placements != tuple(sorted(self.placements, key=lambda item: item.component_id)):
            raise ValueError("placements must be deterministically sorted")
        if self.wires != tuple(sorted(self.wires, key=lambda item: item.semantic_id)):
            raise ValueError("wires must be deterministically sorted")
        if self.local_labels != tuple(sorted(self.local_labels, key=lambda item: item.semantic_id)):
            raise ValueError("local labels must be deterministically sorted")
        if self.junctions != tuple(sorted(self.junctions, key=lambda item: item.semantic_id)):
            raise ValueError("junctions must be deterministically sorted")
        if self.no_connects != tuple(sorted(self.no_connects, key=lambda item: item.semantic_id)):
            raise ValueError("no-connects must be deterministically sorted")
        for label, values in (
            ("symbol source IDs", tuple(item.source_id for item in self.symbol_sources)),
            (
                "verified symbol source IDs",
                tuple(item.source_id for item in self.source_verifications),
            ),
            ("symbol profile IDs", tuple(item.profile_id for item in self.symbol_templates)),
            ("functional block IDs", tuple(item.block_id for item in self.blocks)),
            ("placement component IDs", tuple(item.component_id for item in self.placements)),
            ("wire semantic IDs", tuple(item.semantic_id for item in self.wires)),
            ("local-label semantic IDs", tuple(item.semantic_id for item in self.local_labels)),
            ("junction semantic IDs", tuple(item.semantic_id for item in self.junctions)),
            ("no-connect semantic IDs", tuple(item.semantic_id for item in self.no_connects)),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"{label} must be unique")
        if type(self.global_label_count) is not int or self.global_label_count != 0:
            raise ValueError("global labels are forbidden in a human schematic plan")
        if (
            type(self.manufacturing_release_eligible) is not bool
            or self.manufacturing_release_eligible
        ):
            raise ValueError("a presentation plan cannot authorize manufacturing release")

        source_ids = {item.source_id for item in self.symbol_sources}
        if any(
            source_id not in source_ids
            for template in self.symbol_templates
            for source_id in template.source_ids
        ):
            raise ValueError("symbol template references an unbound source digest")
        source_index = {item.source_id: item for item in self.symbol_sources}
        verification_index = {item.source_id: item for item in self.source_verifications}
        if set(verification_index) != source_ids:
            raise ValueError("every resolved symbol source requires exact byte verification")
        if any(
            verification.byte_length != source_index[source_id].byte_length
            or verification.sha256 != source_index[source_id].sha256
            for source_id, verification in verification_index.items()
        ):
            raise ValueError("source verification does not match its exact source receipt")
        template_index = {item.profile_id: item for item in self.symbol_templates}
        component_ids = {item.component_id for item in self.semantic_graph.components}
        placement_ids = {item.component_id for item in self.placements}
        if placement_ids != component_ids:
            raise ValueError("placement coverage must exactly equal semantic components")
        if any(item.symbol_profile_id not in template_index for item in self.placements):
            raise ValueError("placement references an unknown symbol template")
        block_components = tuple(item for block in self.blocks for item in block.component_ids)
        if set(block_components) != component_ids or len(block_components) != len(component_ids):
            raise ValueError("functional blocks must partition the component population")
        block_index = {item.block_id: item for item in self.blocks}
        if any(
            placement.block_id not in block_index
            or placement.component_id not in block_index[placement.block_id].component_ids
            for placement in self.placements
        ):
            raise ValueError("placement functional-block binding is inconsistent")
        for placement in self.placements:
            template = template_index[placement.symbol_profile_id]
            component = next(
                item
                for item in self.semantic_graph.components
                if item.component_id == placement.component_id
            )
            if template.graph_symbol_id != component.symbol_id:
                raise ValueError("placement template does not match graph symbol ID")
            if placement.component_digest != component.component_digest:
                raise ValueError("placement does not bind the exact semantic component")
            if placement.symbol_template_digest != template.template_digest:
                raise ValueError("placement does not bind the exact symbol template")
            if (
                tuple(item.pin.pin_number for item in placement.pin_anchors)
                != component.pin_numbers
            ):
                raise ValueError("placement pin anchors do not cover the exact component pins")
            anchor_index_by_number = {item.pin.pin_number: item for item in placement.pin_anchors}
            port_index = {item.logical_number: item for item in template.pin_ports}
            for definition in component.pin_definitions:
                anchor = anchor_index_by_number[definition.number]
                port = port_index[definition.number]
                if anchor.canonical_definition != definition:
                    raise ValueError("pin anchor does not bind the canonical graph pin definition")
                if port.canonical_definition != definition:
                    raise ValueError("symbol port does not bind the canonical graph pin definition")
                if anchor.electrical_type != port.electrical_type:
                    raise ValueError("pin anchor electrical projection differs from symbol port")
                if anchor.symbol_template_digest != template.template_digest:
                    raise ValueError("pin anchor does not bind the exact symbol template")
            expected_property_values = {
                "CanonicalComponentId": component.component_id,
                "CanonicalPinMapSha256": component.pin_map_sha256,
                "Datasheet": f"urn:sha256:{component.datasheet_sha256}",
                "DatasheetSha256": component.datasheet_sha256,
                "Description": (
                    f"{component.package}; exact MPN {component.manufacturer_part_number}"
                ),
                "Footprint": component.footprint_id,
                "ManufacturerPartNumber": component.manufacturer_part_number,
                "Reference": component.reference,
                "Value": component.value,
            }
            if {item.name: item.value for item in placement.properties} != expected_property_values:
                raise ValueError("properties do not exactly project their semantic component")
            if any(
                item.component_digest != component.component_digest
                or item.symbol_template_digest != template.template_digest
                for item in placement.properties
            ):
                raise ValueError("property does not bind exact component and symbol template")

        net_ids = {item.net_id for item in self.semantic_graph.nets}
        if any(item.net_id not in net_ids for item in self.wires):
            raise ValueError("wire references an unknown semantic net")
        if any(item.net_id not in net_ids for item in self.local_labels):
            raise ValueError("local label references an unknown semantic net")
        if any(item.net_id not in net_ids for item in self.junctions):
            raise ValueError("junction references an unknown semantic net")
        expected_no_connects = set(self.semantic_graph.no_connects)
        actual_no_connects = {item.pin for item in self.no_connects}
        if actual_no_connects != expected_no_connects:
            raise ValueError("no-connect markers must exactly equal semantic explicit opens")
        anchor_index = {
            anchor.pin: anchor for placement in self.placements for anchor in placement.pin_anchors
        }
        if any(
            item.marker != anchor_index[item.pin].position
            or item.emitted_number != anchor_index[item.pin].emitted_number
            for item in self.no_connects
        ):
            raise ValueError("no-connect marker must land on its exact emitted pin anchor")

        semantic_memberships = {(item.net_id, item.pin) for item in self.semantic_graph.memberships}
        label_memberships = {
            (label.net_id, member) for label in self.local_labels for member in label.members
        }
        if not label_memberships.issubset(semantic_memberships):
            raise ValueError("local labels may cover only members of their exact semantic net")
        if sum(len(item.members) for item in self.local_labels) != len(label_memberships):
            raise ValueError("a semantic pin cannot be assigned to multiple local-label islands")
        net_names = {item.net_id: item.name for item in self.semantic_graph.nets}
        if any(item.name != net_names[item.net_id] for item in self.local_labels):
            raise ValueError("local-label text must exactly equal its semantic net name")
        if {item.net_id for item in self.local_labels} != net_ids:
            raise ValueError("every semantic net requires at least one canonical local label")
        wire_endpoints_by_net: dict[str, set[GridPoint]] = {}
        for wire in self.wires:
            wire_endpoints_by_net.setdefault(wire.net_id, set()).update((wire.start, wire.end))
        if any(
            label.anchor not in wire_endpoints_by_net.get(label.net_id, set())
            and label.anchor not in {anchor_index[member].position for member in label.members}
            for label in self.local_labels
        ):
            raise ValueError("local labels must anchor to their exact net endpoint or pin")
        for membership in self.semantic_graph.memberships:
            anchor = anchor_index[membership.pin]
            if (
                anchor.position not in wire_endpoints_by_net.get(membership.net_id, set())
                and (membership.net_id, membership.pin) not in label_memberships
            ):
                raise ValueError("every connected pin needs a wire endpoint or local-label island")
        _validate_plan_geometry(self)

    @property
    def plan_digest(self) -> str:
        return stable_hash(self, domain=PLAN_HASH_DOMAIN)

    @property
    def canonical_payload(self) -> bytes:
        return canonical_json(self).encode("utf-8")

    @property
    def geometry_record(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "planner_id": self.planner_id,
            "sheet": self.sheet,
            "blocks": self.blocks,
            "placements": self.placements,
            "wires": self.wires,
            "local_labels": self.local_labels,
            "junctions": self.junctions,
            "no_connects": self.no_connects,
            "global_label_count": self.global_label_count,
        }

    @property
    def geometry_payload(self) -> bytes:
        return canonical_json(self.geometry_record).encode("utf-8")

    @property
    def geometry_digest(self) -> str:
        return stable_hash(
            self.geometry_record,
            domain="flux-clone-human-schematic-geometry-v1",
        )

    @property
    def routing_geometry_record(self) -> dict[str, object]:
        return {
            "wires": self.wires,
            "local_labels": self.local_labels,
            "junctions": self.junctions,
            "no_connects": self.no_connects,
            "global_label_count": self.global_label_count,
        }

    @property
    def routing_geometry_payload(self) -> bytes:
        return canonical_json(self.routing_geometry_record).encode("utf-8")

    @property
    def routing_geometry_digest(self) -> str:
        return stable_hash(
            self.routing_geometry_record,
            domain="flux-clone-human-schematic-routing-geometry-v1",
        )


__all__ = (
    "A4_LANDSCAPE_HEIGHT_NM",
    "A4_LANDSCAPE_WIDTH_NM",
    "ComponentPlacement",
    "FunctionalBlock",
    "GRID_NM",
    "GridEnvelope",
    "GridPoint",
    "HumanSchematicError",
    "HumanSchematicPlan",
    "Junction",
    "LocalLabel",
    "NetMembership",
    "NoConnect",
    "PinAnchor",
    "PinPort",
    "PropertyRecord",
    "SemanticComponent",
    "SemanticGraph",
    "SemanticNet",
    "SemanticPin",
    "SemanticPinDefinition",
    "SheetSpec",
    "SourceVerification",
    "SymbolSource",
    "SymbolTemplate",
    "WireSegment",
    "segment_points",
)

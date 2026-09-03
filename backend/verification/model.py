"""Typed immutable model for deterministic PCB verification."""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
from typing import TypeAlias

from .canonical import stable_hash

Scalar: TypeAlias = str | int | bool


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    FATAL = "fatal"

    @property
    def rank(self) -> int:
        return {
            Severity.INFO: 0,
            Severity.WARNING: 1,
            Severity.ERROR: 2,
            Severity.FATAL: 3,
        }[self]


class RuleDomain(str, Enum):
    SYSTEM = "system"
    ELECTRICAL = "electrical"
    GEOMETRY = "geometry"
    ALGORITHM = "algorithm"


class ParameterType(str, Enum):
    INTEGER = "integer"
    BOOLEAN = "boolean"
    STRING = "string"


class RuleExecutionOutcome(str, Enum):
    """Closed result algebra for one configured rule execution."""

    PASS = "pass"
    FAIL = "fail"
    NOT_RUN = "not_run"


class PinElectricalType(str, Enum):
    INPUT = "input"
    OUTPUT = "output"
    BIDIRECTIONAL = "bidirectional"
    PASSIVE = "passive"
    POWER_IN = "power_in"
    POWER_OUT = "power_out"
    OPEN_COLLECTOR = "open_collector"
    NO_CONNECT = "no_connect"
    UNSPECIFIED = "unspecified"


class PadShape(str, Enum):
    """Closed pad-shape vocabulary shared with the canonical design graph."""

    CIRCLE = "circle"
    OVAL = "oval"
    RECT = "rect"
    ROUNDRECT = "roundrect"


@dataclass(frozen=True, slots=True, order=True)
class PointNm:
    x: int
    y: int


@dataclass(frozen=True, slots=True, order=True)
class EntityRef:
    kind: str
    entity_id: str


@dataclass(frozen=True, slots=True)
class Pin:
    number: str
    name: str
    electrical_type: PinElectricalType
    required: bool = True
    pad_center: PointNm | None = None
    pad_diameter_nm: int = 0
    layers: tuple[str, ...] = ()
    # Zero denotes an undrilled/SMD pad. Positive values model a circular
    # plated drill inside the circular copper diameter above.
    pad_drill_nm: int = 0
    # Logical footprint-pad number from the reviewed symbol-to-footprint map.
    # Multiple PhysicalPad records may share this number.
    pad_number: str = ""

    def normalized(self) -> "Pin":
        return replace(self, layers=tuple(sorted(set(self.layers))))


@dataclass(frozen=True, slots=True)
class Component:
    component_id: str
    reference: str
    value: str
    footprint: str
    manufacturer_part_number: str
    datasheet_sha256: str
    pin_map_sha256: str
    pins: tuple[Pin, ...]

    def normalized(self) -> "Component":
        return replace(
            self,
            pins=tuple(sorted((pin.normalized() for pin in self.pins), key=lambda p: p.number)),
        )


@dataclass(frozen=True, slots=True, order=True)
class NetConnection:
    component_id: str
    pin_number: str


@dataclass(frozen=True, slots=True)
class Net:
    net_id: str
    name: str
    connections: tuple[NetConnection, ...]
    external_source: bool = False

    def normalized(self) -> "Net":
        return replace(self, connections=tuple(sorted(self.connections)))


@dataclass(frozen=True, slots=True)
class Track:
    track_id: str
    net_id: str
    layer: str
    start: PointNm
    end: PointNm
    width_nm: int

    def normalized(self) -> "Track":
        if self.end < self.start:
            return replace(self, start=self.end, end=self.start)
        return self


@dataclass(frozen=True, slots=True)
class Via:
    via_id: str
    net_id: str
    center: PointNm
    diameter_nm: int
    drill_nm: int
    layers: tuple[str, ...]

    def normalized(self) -> "Via":
        return replace(self, layers=tuple(sorted(set(self.layers))))


@dataclass(frozen=True, slots=True)
class PhysicalPad:
    """One exact physical copper pad bound to a logical component pin/pad number."""

    pad_id: str
    component_id: str
    pad_number: str
    net_id: str | None
    center: PointNm
    size_x_nm: int
    size_y_nm: int
    shape: PadShape
    rotation_udeg: int
    layers: tuple[str, ...]
    drill_nm: int = 0
    drill_x_nm: int = 0
    drill_y_nm: int = 0
    drill_rotation_udeg: int = 0
    shared_land_group_id: str | None = None

    def normalized(self) -> "PhysicalPad":
        return replace(self, layers=tuple(sorted(set(self.layers))))


@dataclass(frozen=True, slots=True)
class Hole:
    """Exact circular footprint drill.

    Plated drills identify their associated pad. NPTH/mechanical holes have no
    pad and deliberately have no net: they are physical clearance obstacles,
    not electrical connectivity nodes.
    """

    hole_id: str
    component_id: str
    center: PointNm
    diameter_nm: int
    plated: bool = False
    pad_id: str | None = None
    drill_x_nm: int = 0
    drill_y_nm: int = 0
    drill_rotation_udeg: int = 0


@dataclass(frozen=True, slots=True)
class BoardOutline:
    vertices: tuple[PointNm, ...]

    def normalized(self) -> "BoardOutline":
        vertices = self.vertices
        if len(vertices) > 1 and vertices[0] == vertices[-1]:
            vertices = vertices[:-1]
        if not vertices:
            return BoardOutline(())

        def rotations(points: tuple[PointNm, ...]) -> tuple[tuple[PointNm, ...], ...]:
            return tuple(points[index:] + points[:index] for index in range(len(points)))

        forward = min(rotations(vertices))
        reverse = min(rotations(tuple(reversed(vertices))))
        return BoardOutline(min(forward, reverse))


class ZoneFillState(str, Enum):
    """Truthful interpretation of a zone polygon at verification time."""

    UNFILLED_INTENT = "unfilled-intent"
    VERIFIED_FILLED = "verified-filled"


@dataclass(frozen=True, slots=True)
class ZoneFillEvidence:
    source_graph_hash: str
    source_revision: str
    fill_engine_id: str
    fill_engine_revision: str
    filled_geometry_hash: str
    evidence_hash: str


def zone_filled_geometry_hash(zone: "Zone") -> str:
    if type(zone) is not Zone:
        raise ValueError("filled geometry subject must be exact Zone")
    return stable_hash(
        {
            "zone_id": zone.zone_id,
            "net_id": zone.net_id,
            "layer": zone.layer,
            "outline": zone.outline.normalized(),
            "clearance_nm": zone.clearance_nm,
        },
        domain="pcb-zone-filled-geometry-v1",
    )


def zone_fill_evidence_hash(evidence: ZoneFillEvidence) -> str:
    if type(evidence) is not ZoneFillEvidence:
        raise ValueError("zone fill evidence must be exact ZoneFillEvidence")
    return stable_hash(
        {
            "source_graph_hash": evidence.source_graph_hash,
            "source_revision": evidence.source_revision,
            "fill_engine_id": evidence.fill_engine_id,
            "fill_engine_revision": evidence.fill_engine_revision,
            "filled_geometry_hash": evidence.filled_geometry_hash,
        },
        domain="pcb-zone-fill-evidence-v1",
    )


@dataclass(frozen=True, slots=True)
class Zone:
    """A zone intent, optionally backed by verified simple-polygon copper."""

    zone_id: str
    net_id: str
    layer: str
    outline: BoardOutline
    clearance_nm: int = 0
    fill_state: ZoneFillState = ZoneFillState.UNFILLED_INTENT
    fill_evidence: ZoneFillEvidence | None = None

    def normalized(self) -> "Zone":
        return replace(self, outline=self.outline.normalized())


@dataclass(frozen=True, slots=True)
class BoardGraph:
    schema_version: int
    design_id: str
    revision: str
    layers: tuple[str, ...]
    outline: BoardOutline
    components: tuple[Component, ...]
    nets: tuple[Net, ...]
    tracks: tuple[Track, ...]
    vias: tuple[Via, ...]
    unsupported_features: tuple[str, ...] = ()
    zones: tuple[Zone, ...] = ()
    holes: tuple[Hole, ...] = ()
    pads: tuple[PhysicalPad, ...] = ()

    def normalized(self) -> "BoardGraph":
        """Return the canonical ordering used by hashes and evaluators."""

        return replace(
            self,
            layers=tuple(sorted(set(self.layers))),
            outline=self.outline.normalized(),
            components=tuple(
                sorted(
                    (component.normalized() for component in self.components),
                    key=lambda c: c.component_id,
                )
            ),
            nets=tuple(sorted((net.normalized() for net in self.nets), key=lambda n: n.net_id)),
            tracks=tuple(
                sorted((track.normalized() for track in self.tracks), key=lambda t: t.track_id)
            ),
            vias=tuple(sorted((via.normalized() for via in self.vias), key=lambda v: v.via_id)),
            unsupported_features=tuple(sorted(set(self.unsupported_features))),
            zones=tuple(
                sorted((zone.normalized() for zone in self.zones), key=lambda z: z.zone_id)
            ),
            holes=tuple(sorted(self.holes, key=lambda hole: hole.hole_id)),
            pads=tuple(sorted((pad.normalized() for pad in self.pads), key=lambda pad: pad.pad_id)),
        )


@dataclass(frozen=True, slots=True)
class ParameterSpec:
    name: str
    parameter_type: ParameterType
    default: Scalar
    minimum: int | None = None
    maximum: int | None = None


@dataclass(frozen=True, slots=True)
class RuleDefinition:
    rule_id: str
    version: str
    domain: RuleDomain
    title: str
    description: str
    default_severity: Severity
    parameters: tuple[ParameterSpec, ...] = ()
    mandatory: bool = False


@dataclass(frozen=True, slots=True, order=True)
class ParameterValue:
    name: str
    value: Scalar


@dataclass(frozen=True, slots=True)
class RuleOverride:
    rule_id: str
    enabled: bool = True
    severity: Severity | None = None
    parameters: tuple[ParameterValue, ...] = ()

    def normalized(self) -> "RuleOverride":
        return replace(self, parameters=tuple(sorted(self.parameters)))


@dataclass(frozen=True, slots=True)
class GateDefinition:
    gate_id: str
    title: str
    block_at_or_above: Severity
    domains: tuple[RuleDomain, ...] = ()
    rule_ids: tuple[str, ...] = ()
    exempt_rule_ids: tuple[str, ...] = ()
    required_external_evidence_ids: tuple[str, ...] = ()

    def normalized(self) -> "GateDefinition":
        return replace(
            self,
            domains=tuple(sorted(set(self.domains), key=lambda item: item.value)),
            rule_ids=tuple(sorted(set(self.rule_ids))),
            exempt_rule_ids=tuple(sorted(set(self.exempt_rule_ids))),
            required_external_evidence_ids=tuple(sorted(set(self.required_external_evidence_ids))),
        )


@dataclass(frozen=True, slots=True)
class VerificationPolicy:
    overrides: tuple[RuleOverride, ...] = ()
    gates: tuple[GateDefinition, ...] = ()

    def normalized(self) -> "VerificationPolicy":
        return replace(
            self,
            overrides=tuple(
                sorted(
                    (item.normalized() for item in self.overrides), key=lambda item: item.rule_id
                )
            ),
            gates=tuple(
                sorted((gate.normalized() for gate in self.gates), key=lambda gate: gate.gate_id)
            ),
        )


@dataclass(frozen=True, slots=True, order=True)
class EvidenceItem:
    name: str
    value: Scalar | tuple[Scalar, ...]


@dataclass(frozen=True, slots=True)
class Finding:
    finding_id: str
    rule_id: str
    rule_version: str
    domain: RuleDomain
    severity: Severity
    message: str
    entities: tuple[EntityRef, ...]
    evidence: tuple[EvidenceItem, ...]
    evidence_hash: str


@dataclass(frozen=True, slots=True)
class RuleExecution:
    rule_id: str
    rule_version: str
    enabled: bool
    severity: Severity
    parameters: tuple[ParameterValue, ...]
    finding_ids: tuple[str, ...]
    outcome: RuleExecutionOutcome
    blocker_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class GateDecision:
    gate_id: str
    passed: bool
    blocking_finding_ids: tuple[str, ...]
    blocking_rule_ids: tuple[str, ...]
    unavailable_evidence_ids: tuple[str, ...]
    evidence_hash: str


@dataclass(frozen=True, slots=True)
class VerificationReport:
    schema_version: int
    engine_version: str
    run_id: str
    input_hash: str
    rule_set_hash: str
    findings: tuple[Finding, ...]
    executions: tuple[RuleExecution, ...]
    gates: tuple[GateDecision, ...]
    report_hash: str

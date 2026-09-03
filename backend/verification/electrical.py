"""Deterministic electrical and netlist rules."""

from __future__ import annotations

import re

from .model import (
    BoardGraph,
    EntityRef,
    EvidenceItem,
    ParameterSpec,
    ParameterType,
    Pin,
    PinElectricalType,
    RuleDefinition,
    RuleDomain,
    Severity,
)
from .rule import FindingDraft, RuleContext

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _component_pin_index(board: BoardGraph) -> dict[tuple[str, str], Pin]:
    return {
        (component.component_id, pin.number): pin
        for component in board.components
        for pin in component.pins
    }


class GraphReferenceIntegrityRule:
    definition = RuleDefinition(
        rule_id="SYS.GRAPH.REFERENCE_INTEGRITY",
        version="1.0.0",
        domain=RuleDomain.SYSTEM,
        title="Graph reference integrity",
        description="All graph IDs and net-to-pin references must be unique and resolvable.",
        default_severity=Severity.FATAL,
        mandatory=True,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        findings: list[FindingDraft] = []

        def duplicates(values: list[str]) -> tuple[str, ...]:
            return tuple(sorted({value for value in values if values.count(value) > 1}))

        collections = (
            ("component", [item.component_id for item in board.components]),
            ("reference", [item.reference for item in board.components]),
            ("net", [item.net_id for item in board.nets]),
            ("track", [item.track_id for item in board.tracks]),
            ("via", [item.via_id for item in board.vias]),
            ("zone", [item.zone_id for item in board.zones]),
        )
        for kind, values in collections:
            for duplicate in duplicates(values):
                findings.append(
                    FindingDraft(
                        f"Duplicate {kind} identifier: {duplicate}",
                        (EntityRef(kind, duplicate),),
                        (EvidenceItem("duplicate_id", duplicate), EvidenceItem("kind", kind)),
                    )
                )

        component_ids = {item.component_id for item in board.components}
        pin_index = _component_pin_index(board)
        for component in board.components:
            for duplicate in duplicates([pin.number for pin in component.pins]):
                findings.append(
                    FindingDraft(
                        f"Duplicate pin {duplicate} on {component.reference}",
                        (
                            EntityRef("component", component.component_id),
                            EntityRef("pin", duplicate),
                        ),
                        (EvidenceItem("duplicate_pin", duplicate),),
                    )
                )

        pin_nets: dict[tuple[str, str], list[str]] = {}
        for net in board.nets:
            seen: set[tuple[str, str]] = set()
            for connection in net.connections:
                key = (connection.component_id, connection.pin_number)
                connection_ref = f"{connection.component_id}:{connection.pin_number}"
                if connection.component_id not in component_ids:
                    findings.append(
                        FindingDraft(
                            (
                                f"Net {net.name} references missing component "
                                f"{connection.component_id}"
                            ),
                            (
                                EntityRef("net", net.net_id),
                                EntityRef("component", connection.component_id),
                            ),
                            (EvidenceItem("connection", connection_ref),),
                        )
                    )
                elif key not in pin_index:
                    findings.append(
                        FindingDraft(
                            f"Net {net.name} references missing pin {connection_ref}",
                            (EntityRef("net", net.net_id), EntityRef("pin", connection_ref)),
                            (EvidenceItem("connection", connection_ref),),
                        )
                    )
                if key in seen:
                    findings.append(
                        FindingDraft(
                            f"Net {net.name} repeats connection {connection_ref}",
                            (EntityRef("net", net.net_id), EntityRef("pin", connection_ref)),
                            (EvidenceItem("connection", connection_ref),),
                        )
                    )
                seen.add(key)
                pin_nets.setdefault(key, []).append(net.net_id)

        for key, net_ids in sorted(pin_nets.items()):
            unique_net_ids = tuple(sorted(set(net_ids)))
            if len(unique_net_ids) > 1:
                connection_ref = f"{key[0]}:{key[1]}"
                findings.append(
                    FindingDraft(
                        f"Pin {connection_ref} belongs to multiple nets",
                        (EntityRef("pin", connection_ref),),
                        (EvidenceItem("net_ids", unique_net_ids),),
                    )
                )
        return tuple(findings)


class UnsupportedFeatureRule:
    definition = RuleDefinition(
        rule_id="SYS.COVERAGE.UNSUPPORTED_FEATURE",
        version="1.0.0",
        domain=RuleDomain.SYSTEM,
        title="Unsupported board feature",
        description="Unmodeled features prevent a complete authoritative verification claim.",
        default_severity=Severity.FATAL,
        mandatory=True,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        return tuple(
            FindingDraft(
                f"Unsupported feature is present: {feature}",
                (EntityRef("unsupported_feature", feature),),
                (EvidenceItem("feature", feature),),
            )
            for feature in board.unsupported_features
        )


class FootprintRequiredRule:
    definition = RuleDefinition(
        rule_id="ELEC.COMPONENT.FOOTPRINT_REQUIRED",
        version="1.0.0",
        domain=RuleDomain.ELECTRICAL,
        title="Footprint assignment required",
        description="Every component must resolve to an explicit footprint.",
        default_severity=Severity.ERROR,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        return tuple(
            FindingDraft(
                f"{component.reference} has no footprint assignment",
                (EntityRef("component", component.component_id),),
                (EvidenceItem("footprint", component.footprint),),
            )
            for component in board.components
            if not component.footprint.strip()
        )


class PartProvenanceRequiredRule:
    definition = RuleDefinition(
        rule_id="ELEC.COMPONENT.PART_PROVENANCE_REQUIRED",
        version="1.0.0",
        domain=RuleDomain.ELECTRICAL,
        title="Exact part provenance required",
        description="MPN, datasheet hash, and reviewed pin-map hash are hard evidence inputs.",
        default_severity=Severity.ERROR,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        findings: list[FindingDraft] = []
        for component in board.components:
            missing: list[str] = []
            if not component.manufacturer_part_number.strip():
                missing.append("manufacturer_part_number")
            if not _SHA256.fullmatch(component.datasheet_sha256):
                missing.append("datasheet_sha256")
            if not _SHA256.fullmatch(component.pin_map_sha256):
                missing.append("pin_map_sha256")
            if missing:
                findings.append(
                    FindingDraft(
                        f"{component.reference} lacks verified exact-part evidence",
                        (EntityRef("component", component.component_id),),
                        (EvidenceItem("invalid_or_missing_fields", tuple(missing)),),
                    )
                )
        return tuple(findings)


class UnconnectedRequiredPinRule:
    definition = RuleDefinition(
        rule_id="ELEC.PIN.UNCONNECTED_REQUIRED",
        version="1.0.0",
        domain=RuleDomain.ELECTRICAL,
        title="Required pin connected",
        description="Required pins must be assigned to exactly one net unless marked no-connect.",
        default_severity=Severity.ERROR,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        connected = {
            (connection.component_id, connection.pin_number)
            for net in board.nets
            for connection in net.connections
        }
        findings: list[FindingDraft] = []
        for component in board.components:
            for pin in component.pins:
                key = (component.component_id, pin.number)
                if (
                    pin.required
                    and pin.electrical_type is not PinElectricalType.NO_CONNECT
                    and key not in connected
                ):
                    pin_ref = f"{component.component_id}:{pin.number}"
                    findings.append(
                        FindingDraft(
                            f"Required pin {component.reference}.{pin.number} is unconnected",
                            (
                                EntityRef("component", component.component_id),
                                EntityRef("pin", pin_ref),
                            ),
                            (EvidenceItem("electrical_type", pin.electrical_type.value),),
                        )
                    )
                if pin.electrical_type is PinElectricalType.NO_CONNECT and key in connected:
                    pin_ref = f"{component.component_id}:{pin.number}"
                    findings.append(
                        FindingDraft(
                            (
                                f"No-connect pin {component.reference}.{pin.number} "
                                "is assigned to a net"
                            ),
                            (
                                EntityRef("component", component.component_id),
                                EntityRef("pin", pin_ref),
                            ),
                            (EvidenceItem("electrical_type", pin.electrical_type.value),),
                        )
                    )
        return tuple(findings)


class SingleConnectionNetRule:
    definition = RuleDefinition(
        rule_id="ELEC.NET.SINGLE_CONNECTION",
        version="1.0.0",
        domain=RuleDomain.ELECTRICAL,
        title="Net has at least two endpoints",
        description="Internal nets with fewer than two unique endpoints are dangling.",
        default_severity=Severity.ERROR,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        findings: list[FindingDraft] = []
        for net in board.nets:
            endpoints = tuple(
                sorted({(item.component_id, item.pin_number) for item in net.connections})
            )
            if not net.external_source and len(endpoints) < 2:
                findings.append(
                    FindingDraft(
                        f"Internal net {net.name} has only {len(endpoints)} unique endpoint(s)",
                        (EntityRef("net", net.net_id),),
                        (EvidenceItem("endpoint_count", len(endpoints)),),
                    )
                )
        return tuple(findings)


class OutputContentionRule:
    definition = RuleDefinition(
        rule_id="ELEC.NET.OUTPUT_CONTENTION",
        version="1.0.0",
        domain=RuleDomain.ELECTRICAL,
        title="No strong-output contention",
        description="A net may not contain multiple strong output or power-output drivers.",
        default_severity=Severity.ERROR,
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        del context
        pins = _component_pin_index(board)
        strong_types = {PinElectricalType.OUTPUT, PinElectricalType.POWER_OUT}
        findings: list[FindingDraft] = []
        for net in board.nets:
            drivers = tuple(
                sorted(
                    f"{item.component_id}:{item.pin_number}"
                    for item in net.connections
                    if (pin := pins.get((item.component_id, item.pin_number))) is not None
                    and pin.electrical_type in strong_types
                )
            )
            if len(drivers) > 1:
                findings.append(
                    FindingDraft(
                        f"Net {net.name} has {len(drivers)} strong drivers",
                        (EntityRef("net", net.net_id),)
                        + tuple(EntityRef("pin", driver) for driver in drivers),
                        (
                            EvidenceItem("drivers", drivers),
                            EvidenceItem("driver_count", len(drivers)),
                        ),
                    )
                )
        return tuple(findings)


class InputDrivenRule:
    definition = RuleDefinition(
        rule_id="ELEC.NET.INPUT_DRIVEN",
        version="1.0.0",
        domain=RuleDomain.ELECTRICAL,
        title="Input nets have a driver",
        description="Internal nets containing required inputs must have a recognized source.",
        default_severity=Severity.ERROR,
        parameters=(
            ParameterSpec("bidirectional_is_driver", ParameterType.BOOLEAN, True),
            ParameterSpec("open_collector_is_driver", ParameterType.BOOLEAN, True),
        ),
    )

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]:
        pins = _component_pin_index(board)
        sink_types = {PinElectricalType.INPUT, PinElectricalType.POWER_IN}
        driver_types = {PinElectricalType.OUTPUT, PinElectricalType.POWER_OUT}
        if context.boolean("bidirectional_is_driver"):
            driver_types.add(PinElectricalType.BIDIRECTIONAL)
        if context.boolean("open_collector_is_driver"):
            driver_types.add(PinElectricalType.OPEN_COLLECTOR)
        findings: list[FindingDraft] = []
        for net in board.nets:
            if net.external_source:
                continue
            connected_pins = tuple(
                pin
                for item in net.connections
                if (pin := pins.get((item.component_id, item.pin_number))) is not None
            )
            sinks = sum(pin.electrical_type in sink_types for pin in connected_pins)
            drivers = sum(pin.electrical_type in driver_types for pin in connected_pins)
            if sinks and not drivers:
                findings.append(
                    FindingDraft(
                        f"Net {net.name} contains input pins but no recognized driver",
                        (EntityRef("net", net.net_id),),
                        (EvidenceItem("driver_count", drivers), EvidenceItem("sink_count", sinks)),
                    )
                )
        return tuple(findings)


def electrical_rules() -> tuple[object, ...]:
    return (
        GraphReferenceIntegrityRule(),
        UnsupportedFeatureRule(),
        FootprintRequiredRule(),
        PartProvenanceRequiredRule(),
        UnconnectedRequiredPinRule(),
        SingleConnectionNetRule(),
        OutputContentionRule(),
        InputDrivenRule(),
    )

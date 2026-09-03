"""Deterministic logical circuit for the USB-C to 3.3 V reference board.

This module deliberately contains no placement or routing policy.  It binds
every logical component pin either to exactly one named net or to the explicit
no-connect inventory. Schematic drawing primitives remain empty because the
canonical model does not bind symbol-pin positions; the KiCad compiler emits
labels directly at its deterministic symbol-pin positions from these nets.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.design_kernel import (
    DesignGraph,
    Net,
    PinRef,
    SchematicJunction,
    SchematicWire,
    validate_graph,
)

from .model import ReferenceDesignViolation
from .specification import PROJECT_ID, components

NET_3V3 = "net-3v3"
NET_CC1 = "net-cc1"
NET_CC2 = "net-cc2"
NET_COUT_DAMPED = "net-cout-damped"
NET_DVDT = "net-dvdt"
NET_EN_UVLO = "net-en-uvlo"
NET_GND = "net-gnd"
NET_ILM = "net-ilm"
NET_LED_A = "net-led-a"
NET_OVC_MID = "net-ovc-mid"
NET_OVCSEL = "net-ovcsel"
NET_V5_PROTECTED = "net-v5-protected"
NET_VBUS_RAW = "net-vbus-raw"


def _pin(component_id: str, pin_number: str) -> PinRef:
    return PinRef(component_id, pin_number)


def _net(net_id: str, name: str, *members: PinRef) -> Net:
    return Net(net_id, name, tuple(sorted(members)))


def _schematic_for(
    nets: tuple[Net, ...],
) -> tuple[tuple[SchematicWire, ...], tuple[SchematicJunction, ...]]:
    """Return no non-authoritative drawing geometry for logical-only nets."""

    if type(nets) is not tuple or any(type(net) is not Net for net in nets):
        raise ReferenceDesignViolation("schematic source nets must be exact")
    return (), ()


@dataclass(frozen=True, slots=True)
class CircuitTopology:
    """Exact, fully covered logical and schematic topology."""

    nets: tuple[Net, ...]
    wires: tuple[SchematicWire, ...]
    junctions: tuple[SchematicJunction, ...]
    no_connects: tuple[PinRef, ...]

    def __post_init__(self) -> None:
        if type(self) is not CircuitTopology:
            raise ReferenceDesignViolation("circuit topology must be exact CircuitTopology")
        for label, values, item_type in (
            ("nets", self.nets, Net),
            ("schematic wires", self.wires, SchematicWire),
            ("schematic junctions", self.junctions, SchematicJunction),
            ("no-connect pins", self.no_connects, PinRef),
        ):
            if type(values) is not tuple or any(type(item) is not item_type for item in values):
                raise ReferenceDesignViolation(
                    f"circuit {label} must be an immutable tuple of exact {item_type.__name__}"
                )

        normalized_nets = tuple(
            sorted((net.normalized() for net in self.nets), key=lambda net: net.net_id)
        )
        normalized_wires = tuple(
            sorted((wire.normalized() for wire in self.wires), key=lambda wire: wire.wire_id)
        )
        if self.nets != normalized_nets or self.wires != normalized_wires:
            raise ReferenceDesignViolation("circuit nets and wires must be canonically ordered")
        if self.junctions != tuple(
            sorted(self.junctions, key=lambda junction: junction.junction_id)
        ) or self.no_connects != tuple(sorted(self.no_connects)):
            raise ReferenceDesignViolation(
                "circuit junctions and no-connects must be canonically ordered"
            )

        for label, values in (
            ("net IDs", tuple(net.net_id for net in self.nets)),
            ("net names", tuple(net.name for net in self.nets)),
            ("wire IDs", tuple(wire.wire_id for wire in self.wires)),
            ("junction IDs", tuple(junction.junction_id for junction in self.junctions)),
            ("no-connect pins", self.no_connects),
        ):
            if len(values) != len(set(values)):
                raise ReferenceDesignViolation(f"circuit {label} must be unique")
        if any(len(net.members) < 2 for net in self.nets):
            raise ReferenceDesignViolation("every reference net must join at least two pins")

        component_set = components()
        pin_definitions = {
            PinRef(component.component_id, pin.number): pin
            for component in component_set
            for pin in component.pins
        }
        connected = tuple(member for net in self.nets for member in net.members)
        if len(connected) != len(set(connected)):
            raise ReferenceDesignViolation("a logical pin cannot belong to multiple nets")
        connected_set = set(connected)
        no_connect_set = set(self.no_connects)
        if connected_set & no_connect_set:
            raise ReferenceDesignViolation("an explicit no-connect pin cannot belong to a net")
        if connected_set | no_connect_set != set(pin_definitions):
            raise ReferenceDesignViolation(
                "every fitted component pin must appear exactly once as connected or no-connect"
            )
        if any(
            pin_definitions[member].electrical_type == "no_connect" for member in connected_set
        ):
            raise ReferenceDesignViolation("a no-connect pin cannot be assigned to a net")
        if any(
            pin_definitions[member].electrical_type != "no_connect"
            for member in no_connect_set
        ):
            raise ReferenceDesignViolation("only declared no-connect pins may be left open")
        if any(
            pin.required and member not in connected_set
            for member, pin in pin_definitions.items()
        ):
            raise ReferenceDesignViolation("every required pin must belong to exactly one net")

        expected_wires, expected_junctions = _schematic_for(self.nets)
        if self.wires != expected_wires or self.junctions != expected_junctions:
            raise ReferenceDesignViolation(
                "logical-only circuit cannot carry unbound schematic drawing primitives"
            )
        validate_graph(
            DesignGraph(
                1,
                PROJECT_ID,
                components=component_set,
                nets=self.nets,
                schematic_wires=self.wires,
                schematic_junctions=self.junctions,
            )
        )


def build_circuit() -> CircuitTopology:
    """Return the exact reference-board logical circuit and explicit opens."""

    nets = tuple(
        sorted(
            (
                _net(
                    NET_3V3,
                    "3V3",
                    _pin("ldo-u2", "3"),
                    _pin("cout-esr-r9", "1"),
                    _pin("led-r8", "1"),
                    _pin("out-j2", "1"),
                    _pin("tp-3", "1"),
                ),
                _net(NET_CC1, "CC1", _pin("usb-j1", "A5"), _pin("cc-r1", "1")),
                _net(NET_CC2, "CC2", _pin("usb-j1", "B5"), _pin("cc-r2", "1")),
                _net(
                    NET_COUT_DAMPED,
                    "COUT_DAMPED",
                    _pin("cout-esr-r9", "2"),
                    _pin("cout-c3", "1"),
                ),
                _net(
                    NET_DVDT,
                    "DVDT_SET",
                    _pin("efuse-u1", "2"),
                    _pin("dvdt-c4", "1"),
                ),
                _net(
                    NET_EN_UVLO,
                    "EN_UVLO",
                    _pin("efuse-u1", "3"),
                    _pin("en-hi-r6", "2"),
                    _pin("en-lo-r7", "1"),
                ),
                _net(
                    NET_GND,
                    "GND",
                    _pin("usb-j1", "A1"),
                    _pin("usb-j1", "A12"),
                    _pin("usb-j1", "B1"),
                    _pin("usb-j1", "B12"),
                    _pin("usb-j1", "S1"),
                    _pin("efuse-u1", "1"),
                    _pin("efuse-u1", "EP"),
                    _pin("ldo-u2", "5"),
                    _pin("tvs-d1", "2"),
                    _pin("cc-r1", "2"),
                    _pin("cc-r2", "2"),
                    _pin("ilim-r3", "2"),
                    _pin("ovc-r5", "2"),
                    _pin("en-lo-r7", "2"),
                    _pin("cin-c1", "2"),
                    _pin("cldo-c2", "2"),
                    _pin("cout-c3", "2"),
                    _pin("dvdt-c4", "2"),
                    _pin("led-d2", "1"),
                    _pin("out-j2", "2"),
                    _pin("tp-4", "1"),
                ),
                _net(NET_ILM, "ILM_SET", _pin("efuse-u1", "7"), _pin("ilim-r3", "1")),
                _net(NET_LED_A, "LED_A", _pin("led-r8", "2"), _pin("led-d2", "2")),
                _net(
                    NET_OVC_MID,
                    "OVC_MID",
                    _pin("ovc-r4", "2"),
                    _pin("ovc-r5", "1"),
                ),
                _net(
                    NET_OVCSEL,
                    "OVCSEL_SET",
                    _pin("efuse-u1", "8"),
                    _pin("ovc-r4", "1"),
                ),
                _net(
                    NET_V5_PROTECTED,
                    "V5_PROTECTED",
                    _pin("efuse-u1", "5"),
                    _pin("ldo-u2", "1"),
                    _pin("ldo-u2", "4"),
                    _pin("cldo-c2", "1"),
                    _pin("tp-2", "1"),
                ),
                _net(
                    NET_VBUS_RAW,
                    "VBUS_RAW",
                    _pin("usb-j1", "A4"),
                    _pin("usb-j1", "A9"),
                    _pin("usb-j1", "B4"),
                    _pin("usb-j1", "B9"),
                    _pin("efuse-u1", "4"),
                    _pin("tvs-d1", "1"),
                    _pin("en-hi-r6", "1"),
                    _pin("cin-c1", "1"),
                    _pin("tp-1", "1"),
                ),
            ),
            key=lambda net: net.net_id,
        )
    )
    no_connects = tuple(
        sorted(
            (
                _pin("usb-j1", "A6"),
                _pin("usb-j1", "A7"),
                _pin("usb-j1", "A8"),
                _pin("usb-j1", "B6"),
                _pin("usb-j1", "B7"),
                _pin("usb-j1", "B8"),
                _pin("efuse-u1", "6"),
                _pin("ldo-u2", "2"),
            )
        )
    )
    wires, junctions = _schematic_for(nets)
    return CircuitTopology(nets, wires, junctions, no_connects)


__all__ = (
    "CircuitTopology",
    "NET_3V3",
    "NET_CC1",
    "NET_CC2",
    "NET_COUT_DAMPED",
    "NET_DVDT",
    "NET_EN_UVLO",
    "NET_GND",
    "NET_ILM",
    "NET_LED_A",
    "NET_OVC_MID",
    "NET_OVCSEL",
    "NET_V5_PROTECTED",
    "NET_VBUS_RAW",
    "build_circuit",
)

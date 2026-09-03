"""Executable contract for the deterministic first reference board."""

from __future__ import annotations

import unittest
from dataclasses import replace

from backend.design_kernel import PinRef
from backend.reference_design import (
    BOARD_HEIGHT_NM,
    BOARD_WIDTH_NM,
    build_reference_board,
)
from backend.reference_design.builder import (
    ReferenceBoardBuildError,
    _analog_bias_proof_hash,
    _bind_pad_nets,
)
from backend.reference_design.circuit import build_circuit
from backend.reference_design.footprints import build_footprints


class ReferenceBoardBuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.build = build_reference_board()
        cls.graph = cls.build.graph

    def test_repeat_build_is_byte_subject_deterministic(self) -> None:
        repeated = build_reference_board()
        self.assertEqual(self.build, repeated)
        self.assertEqual(self.build.graph_hash, repeated.graph_hash)
        self.assertEqual(self.build.revision_hash, repeated.revision_hash)
        self.assertEqual(self.build.native_report.report_hash, repeated.native_report.report_hash)

    def test_exact_component_net_and_board_populations(self) -> None:
        self.assertEqual(23, len(self.graph.components))
        self.assertEqual(
            {
                "C1",
                "C2",
                "C3",
                "C4",
                "D1",
                "D2",
                "J1",
                "J2",
                "R1",
                "R2",
                "R3",
                "R4",
                "R5",
                "R6",
                "R7",
                "R8",
                "R9",
                "TP1",
                "TP2",
                "TP3",
                "TP4",
                "U1",
                "U2",
            },
            {component.reference for component in self.graph.components},
        )
        names = {net.name for net in self.graph.nets}
        self.assertEqual(
            {
                "3V3",
                "CC1",
                "CC2",
                "COUT_DAMPED",
                "DVDT_SET",
                "EN_UVLO",
                "GND",
                "ILM_SET",
                "LED_A",
                "OVC_MID",
                "OVCSEL_SET",
                "V5_PROTECTED",
                "VBUS_RAW",
            },
            names,
        )
        self.assertEqual(67, sum(len(component.pins) for component in self.graph.components))
        self.assertEqual(59, sum(len(net.members) for net in self.graph.nets))
        xs = [point.x for point in self.graph.board_outline]
        ys = [point.y for point in self.graph.board_outline]
        self.assertEqual(BOARD_WIDTH_NM, max(xs) - min(xs))
        self.assertEqual(BOARD_HEIGHT_NM, max(ys) - min(ys))
        self.assertEqual(("B.Cu", "F.Cu"), self.graph.layers)

    def test_cc_contacts_remain_on_separate_nets(self) -> None:
        memberships = {member: net.name for net in self.graph.nets for member in net.members}
        self.assertEqual("CC1", memberships[PinRef("usb-j1", "A5")])
        self.assertEqual("CC2", memberships[PinRef("usb-j1", "B5")])
        self.assertNotEqual(
            memberships[PinRef("usb-j1", "A5")],
            memberships[PinRef("usb-j1", "B5")],
        )

    def test_pad_binding_is_exact_and_rejects_injected_source_nets(self) -> None:
        circuit = build_circuit()
        raw_pads = build_footprints()[1]
        bound = _bind_pad_nets(circuit, raw_pads)
        memberships = {
            (member.component_id, member.pin_number): net.net_id
            for net in circuit.nets
            for member in net.members
        }
        no_connects = {(pin.component_id, pin.pin_number) for pin in circuit.no_connects}
        physical_to_logical = {
            (component.component_id, pin.pad_number): pin.number
            for component in self.graph.components
            for pin in component.pins
        }
        for pad in bound:
            logical_key = (
                pad.component_id,
                physical_to_logical[(pad.component_id, pad.pad_number)],
            )
            self.assertEqual(
                None if logical_key in no_connects else memberships[logical_key],
                pad.net_id,
            )

        exposed_pin = next(
            pin
            for component in self.graph.components
            if component.component_id == "efuse-u1"
            for pin in component.pins
            if pin.number == "EP"
        )
        exposed_pad = next(
            pad for pad in bound if pad.component_id == "efuse-u1" and pad.pad_number == "9"
        )
        self.assertEqual("9", exposed_pin.pad_number)
        self.assertEqual("net-gnd", exposed_pad.net_id)

        injected = (replace(raw_pads[0], net_id="net-gnd"),) + raw_pads[1:]
        with self.assertRaises(ReferenceBoardBuildError):
            _bind_pad_nets(circuit, injected)

    def test_analog_bias_proof_fails_on_part_net_or_pad_drift(self) -> None:
        r6 = next(
            component for component in self.graph.components if component.component_id == "en-hi-r6"
        )
        part_drift = replace(
            self.graph,
            components=tuple(
                replace(component, value="250k 1%") if component is r6 else component
                for component in self.graph.components
            ),
        )
        with self.assertRaises(ReferenceBoardBuildError):
            _analog_bias_proof_hash(part_drift)

        en_net = next(net for net in self.graph.nets if net.net_id == "net-en-uvlo")
        net_drift = replace(
            self.graph,
            nets=tuple(
                replace(net, members=net.members[:-1]) if net is en_net else net
                for net in self.graph.nets
            ),
        )
        with self.assertRaises(ReferenceBoardBuildError):
            _analog_bias_proof_hash(net_drift)

        r7_ground = next(
            pad
            for pad in self.graph.pads
            if pad.component_id == "en-lo-r7" and pad.pad_number == "2"
        )
        pad_drift = replace(
            self.graph,
            pads=tuple(
                replace(pad, net_id="net-vbus-raw") if pad is r7_ground else pad
                for pad in self.graph.pads
            ),
        )
        with self.assertRaises(ReferenceBoardBuildError):
            _analog_bias_proof_hash(pad_drift)

    def test_connector_preserves_shared_lands_slots_npth_and_nc(self) -> None:
        connector_pads = tuple(pad for pad in self.graph.pads if pad.component_id == "usb-j1")
        shared_groups: dict[str, list[object]] = {}
        for pad in connector_pads:
            if pad.shared_land_group_id is not None:
                shared_groups.setdefault(pad.shared_land_group_id, []).append(pad)
        self.assertEqual(4, len(shared_groups))
        self.assertTrue(all(len(group) == 2 for group in shared_groups.values()))

        connector_holes = tuple(hole for hole in self.graph.holes if hole.component_id == "usb-j1")
        plated_slots = tuple(hole for hole in connector_holes if hole.plated)
        locating_holes = tuple(hole for hole in connector_holes if not hole.plated)
        self.assertEqual(4, len(plated_slots))
        self.assertTrue(all(hole.drill_is_slot for hole in plated_slots))
        self.assertEqual(2, len(locating_holes))
        self.assertTrue(all(not hole.drill_is_slot for hole in locating_holes))

        no_connects = {
            (component.component_id, pin.pad_number)
            for component in self.graph.components
            for pin in component.pins
            if pin.electrical_type == "no_connect"
        }
        nc_pads = {
            (pad.component_id, pad.pad_number)
            for pad in self.graph.pads
            if (pad.component_id, pad.pad_number) in no_connects
        }
        self.assertEqual(no_connects, nc_pads)
        self.assertTrue(
            all(
                pad.net_id is None
                for pad in self.graph.pads
                if (pad.component_id, pad.pad_number) in no_connects
            )
        )

    def test_power_routes_have_wide_trunks_and_enumerated_neckdowns(self) -> None:
        net_ids = {net.name: net.net_id for net in self.graph.nets}
        tracks = {track.track_id: track for track in self.graph.tracks}
        rail_ids = {
            net_ids["VBUS_RAW"],
            net_ids["V5_PROTECTED"],
            net_ids["3V3"],
            net_ids["COUT_DAMPED"],
        }
        narrow_ids = {
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
        rail_tracks = tuple(track for track in self.graph.tracks if track.net_id in rail_ids)
        self.assertEqual(
            narrow_ids, {track.track_id for track in rail_tracks if track.width_nm < 800_000}
        )
        self.assertTrue(all(tracks[track_id].width_nm == 300_000 for track_id in narrow_ids))
        self.assertTrue(
            all(
                track.width_nm == 800_000
                for track in rail_tracks
                if track.track_id not in narrow_ids
            )
        )
        self.assertEqual(
            {800_000},
            {track.width_nm for track in rail_tracks if track.net_id == net_ids["COUT_DAMPED"]},
        )

    def test_native_gate_outcomes_are_exact_and_truthful(self) -> None:
        gates = {gate.gate_id: gate for gate in self.build.native_report.gates}
        self.assertTrue(gates["preview"].passed)
        self.assertTrue(gates["commit"].passed)
        self.assertFalse(gates["manufacturing-release"].passed)
        self.assertEqual(
            ("trusted-kicad-drc-v1",),
            gates["manufacturing-release"].unavailable_evidence_ids,
        )


if __name__ == "__main__":
    unittest.main()

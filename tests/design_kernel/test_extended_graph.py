from __future__ import annotations

import unittest
from dataclasses import FrozenInstanceError, replace

from backend.design_kernel import (
    CommandKind,
    CopperZone,
    DesignCommand,
    DesignGraph,
    DesignKernel,
    FootprintPad,
    InvariantViolation,
    Net,
    PointNm,
    ZoneFillEvidence,
    ZoneFillState,
    bind_verified_zone_fill,
    to_verification_board,
)
from backend.verification import VerificationEngine

DATASHEET = "a" * 64
PIN_MAP = "b" * 64


def component_payload() -> dict:
    return {
        "component_id": "cmp-u1",
        "reference": "U1",
        "value": "Test controller",
        "manufacturer_part_number": "EXACT-123",
        "package": "QFN-2",
        "symbol_id": "symbol:test-controller",
        "footprint_id": "Package_QFN:QFN-2",
        "datasheet_sha256": DATASHEET,
        "pin_map_sha256": PIN_MAP,
        "pins": [
            {
                "number": "1",
                "name": "A",
                "electrical_type": "input",
                "pad_number": "1",
                "required": True,
            },
            {
                "number": "2",
                "name": "B",
                "electrical_type": "output",
                "pad_number": "2",
                "required": True,
            },
        ],
    }


class ExtendedGraphTests(unittest.TestCase):
    def setUp(self) -> None:
        self.kernel = DesignKernel(DesignGraph(1, "extended-board"))
        self.kernel.begin_transaction("txn-extended", base_revision=self.kernel.head.revision_hash)
        self._next_command = 0

    def stage(self, kind: CommandKind, payload: dict) -> None:
        self._next_command += 1
        command_id = f"cmd-{self._next_command}"
        transaction = self.kernel.get_transaction("txn-extended")
        self.kernel.stage(
            DesignCommand.create(
                command_id=command_id,
                base_revision=transaction.base_revision,
                transaction_id="txn-extended",
                actor="agent:kernel-test",
                kind=kind,
                payload=payload,
                idempotency_key=command_id,
            )
        )

    def add_component_nets_and_placement(self, *, second_net: bool = False) -> None:
        self.stage(CommandKind.COMPONENT_ADD, component_payload())
        self.stage(CommandKind.NET_CREATE, {"net_id": "net-a", "name": "A"})
        if second_net:
            self.stage(CommandKind.NET_CREATE, {"net_id": "net-b", "name": "B"})
        self.stage(
            CommandKind.NET_CONNECT,
            {"net_id": "net-a", "component_id": "cmp-u1", "pin_number": "1"},
        )
        self.stage(
            CommandKind.FOOTPRINT_PLACE,
            {
                "component_id": "cmp-u1",
                "x_nm": 10_000_000,
                "y_nm": 20_000_000,
                "rotation_udeg": 0,
                "side": "front",
            },
        )

    @staticmethod
    def pad_payload(
        pad_id: str,
        pad_number: str,
        *,
        net_id: str | None,
        drill_nm: int = 0,
    ) -> dict:
        payload = {
            "pad_id": pad_id,
            "component_id": "cmp-u1",
            "pad_number": pad_number,
            "center_x_nm": 10_000_000,
            "center_y_nm": 20_000_000,
            "size_x_nm": 800_000,
            "size_y_nm": 800_000,
            "shape": "circle",
            "rotation_udeg": 0,
            "layers": ["F.Cu", "B.Cu"] if drill_nm else ["F.Cu"],
            "pad_drill_nm": drill_nm,
        }
        if net_id is not None:
            payload["net_id"] = net_id
        return payload

    def test_all_new_typed_entities_stage_and_appear_in_semantic_diff(self) -> None:
        self.add_component_nets_and_placement()
        self.stage(CommandKind.FOOTPRINT_PAD_ADD, self.pad_payload("pad-1", "1", net_id="net-a"))
        self.stage(
            CommandKind.FOOTPRINT_PAD_ADD,
            self.pad_payload("pad-2", "2", net_id=None, drill_nm=300_000),
        )
        self.stage(
            CommandKind.FOOTPRINT_HOLE_ADD,
            {
                "hole_id": "hole-1",
                "component_id": "cmp-u1",
                "center_x_nm": 10_000_000,
                "center_y_nm": 20_000_000,
                "diameter_nm": 300_000,
                "plated": True,
                "pad_id": "pad-2",
            },
        )
        self.stage(
            CommandKind.VIA_ADD,
            {
                "via_id": "via-1",
                "net_id": "net-a",
                "center_x_nm": 12_000_000,
                "center_y_nm": 20_000_000,
                "diameter_nm": 600_000,
                "drill_nm": 300_000,
                "layers": ["F.Cu", "B.Cu"],
            },
        )
        self.stage(
            CommandKind.FOOTPRINT_HOLE_ADD,
            {
                "hole_id": "hole-npth",
                "component_id": "cmp-u1",
                "center_x_nm": 11_000_000,
                "center_y_nm": 20_000_000,
                "diameter_nm": 500_000,
                "plated": False,
                "drill_x_nm": 500_000,
                "drill_y_nm": 900_000,
                "drill_rotation_udeg": 90_000_000,
            },
        )
        self.stage(
            CommandKind.ZONE_ADD,
            {
                "zone_id": "zone-1",
                "net_id": "net-a",
                "layer": "F.Cu",
                "outline": [[0, 0], [4_000_000, 0], [4_000_000, 3_000_000], [0, 3_000_000], [0, 0]],
                "clearance_nm": 200_000,
                "min_thickness_nm": 150_000,
                "priority": 1,
            },
        )
        self.stage(
            CommandKind.SCHEMATIC_WIRE_ADD,
            {"wire_id": "wire-1", "net_id": "net-a", "vertices": [[0, 0], [1_000_000, 0]]},
        )
        self.stage(
            CommandKind.SCHEMATIC_WIRE_ADD,
            {
                "wire_id": "wire-2",
                "net_id": "net-a",
                "vertices": [[1_000_000, 0], [1_000_000, 1_000_000]],
            },
        )
        self.stage(
            CommandKind.SCHEMATIC_JUNCTION_ADD,
            {"junction_id": "junction-1", "net_id": "net-a", "x_nm": 1_000_000, "y_nm": 0},
        )

        graph = self.kernel.get_transaction("txn-extended").staged_graph
        self.assertEqual(graph.pads[0].net_id, "net-a")
        self.assertEqual(graph.pads[1].pad_drill_nm, 300_000)
        self.assertEqual(graph.vias[0].layers, ("B.Cu", "F.Cu"))
        self.assertEqual(len(graph.zones[0].outline), 4)
        diff = self.kernel.preview("txn-extended")
        self.assertEqual(
            set(diff.added),
            {
                "component:cmp-u1",
                "net:net-a",
                "placement:cmp-u1",
                "pad:pad-1",
                "pad:pad-2",
                "hole:hole-1",
                "hole:hole-npth",
                "via:via-1",
                "zone:zone-1",
                "schematic-wire:wire-1",
                "schematic-wire:wire-2",
                "schematic-junction:junction-1",
            },
        )

    def test_canonical_hash_ignores_nonsemantic_order_direction_and_ring_origin(self) -> None:
        self.add_component_nets_and_placement()
        self.stage(CommandKind.FOOTPRINT_PAD_ADD, self.pad_payload("pad-1", "1", net_id="net-a"))
        self.stage(
            CommandKind.VIA_ADD,
            {
                "via_id": "via-1",
                "net_id": "net-a",
                "center_x_nm": 1,
                "center_y_nm": 2,
                "diameter_nm": 600_000,
                "drill_nm": 300_000,
                "layers": ["F.Cu", "B.Cu"],
            },
        )
        self.stage(
            CommandKind.ZONE_ADD,
            {
                "zone_id": "zone-1",
                "net_id": "net-a",
                "layer": "F.Cu",
                "outline": [[0, 0], [3, 0], [3, 2], [0, 2]],
                "clearance_nm": 0,
            },
        )
        self.stage(
            CommandKind.SCHEMATIC_WIRE_ADD,
            {"wire_id": "wire-1", "net_id": "net-a", "vertices": [[-5, 0], [0, 0], [5, 0]]},
        )
        graph = self.kernel.get_transaction("txn-extended").staged_graph
        zone = graph.zones[0]
        variant = replace(
            graph,
            layers=tuple(reversed(graph.layers)),
            pads=(replace(graph.pads[0], layers=tuple(reversed(graph.pads[0].layers))),),
            vias=(replace(graph.vias[0], layers=tuple(reversed(graph.vias[0].layers))),),
            zones=(
                replace(
                    zone,
                    outline=(
                        zone.outline[2],
                        zone.outline[1],
                        zone.outline[0],
                        zone.outline[3],
                        zone.outline[2],
                    ),
                ),
            ),
            schematic_wires=(
                replace(
                    graph.schematic_wires[0],
                    vertices=tuple(reversed(graph.schematic_wires[0].vertices)),
                ),
            ),
        )
        self.assertEqual(graph.graph_hash, variant.graph_hash)

    def test_pad_net_binding_must_match_connected_schematic_pin(self) -> None:
        self.add_component_nets_and_placement(second_net=True)
        before = self.kernel.get_transaction("txn-extended")
        with self.assertRaisesRegex(InvariantViolation, "disagrees with schematic"):
            self.stage(
                CommandKind.FOOTPRINT_PAD_ADD, self.pad_payload("pad-1", "1", net_id="net-b")
            )
        after = self.kernel.get_transaction("txn-extended")
        self.assertEqual(before, after)
        self.assertEqual(after.staged_graph.pads, ())

    def test_plated_hole_must_match_exact_pad_drill(self) -> None:
        self.add_component_nets_and_placement()
        self.stage(
            CommandKind.FOOTPRINT_PAD_ADD,
            self.pad_payload("pad-2", "2", net_id=None, drill_nm=300_000),
        )
        with self.assertRaisesRegex(InvariantViolation, "match its exact pad drill"):
            self.stage(
                CommandKind.FOOTPRINT_HOLE_ADD,
                {
                    "hole_id": "hole-bad",
                    "component_id": "cmp-u1",
                    "center_x_nm": 0,
                    "center_y_nm": 0,
                    "diameter_nm": 299_999,
                    "plated": True,
                    "pad_id": "pad-2",
                },
            )
        with self.assertRaisesRegex(InvariantViolation, "share its pad center"):
            self.stage(
                CommandKind.FOOTPRINT_HOLE_ADD,
                {
                    "hole_id": "hole-off-center",
                    "component_id": "cmp-u1",
                    "center_x_nm": 10_000_001,
                    "center_y_nm": 20_000_000,
                    "diameter_nm": 300_000,
                    "plated": True,
                    "pad_id": "pad-2",
                },
            )

    def test_via_and_pad_fail_closed_on_invalid_topology(self) -> None:
        self.add_component_nets_and_placement()
        with self.assertRaisesRegex(InvariantViolation, "smaller than"):
            self.stage(
                CommandKind.VIA_ADD,
                {
                    "via_id": "via-bad",
                    "net_id": "net-a",
                    "center_x_nm": 0,
                    "center_y_nm": 0,
                    "diameter_nm": 300_000,
                    "drill_nm": 300_000,
                    "layers": ["F.Cu", "B.Cu"],
                },
            )
        with self.assertRaisesRegex(InvariantViolation, "span at least two"):
            self.stage(
                CommandKind.FOOTPRINT_PAD_ADD,
                {
                    **self.pad_payload("pad-bad", "2", net_id=None, drill_nm=300_000),
                    "layers": ["F.Cu"],
                },
            )
        with self.assertRaisesRegex(InvariantViolation, "unknown net"):
            self.stage(
                CommandKind.VIA_ADD,
                {
                    "via_id": "via-unknown",
                    "net_id": "net-missing",
                    "center_x_nm": 0,
                    "center_y_nm": 0,
                    "diameter_nm": 600_000,
                    "drill_nm": 300_000,
                    "layers": ["F.Cu", "B.Cu"],
                },
            )

    def test_polygon_and_integer_boundaries_are_exact(self) -> None:
        self.assertEqual(PointNm(-(1 << 63), (1 << 63) - 1).x, -(1 << 63))
        for value in ((1 << 63), -(1 << 63) - 1, True, 0.5):
            with self.subTest(value=value), self.assertRaises(InvariantViolation):
                PointNm(value, 0)  # type: ignore[arg-type]
        with self.assertRaises(InvariantViolation):
            CopperZone(
                "zone-bow-tie",
                "net-a",
                "F.Cu",
                (PointNm(0, 0), PointNm(2, 2), PointNm(0, 2), PointNm(2, 0)),
                0,
            )
        with self.assertRaises(InvariantViolation):
            self.stage(
                CommandKind.BOARD_SET_OUTLINE,
                {"vertices": [[0, 0], [2, 2], [0, 2], [2, 0]]},
            )
        self.assertEqual(self.kernel.get_transaction("txn-extended").staged_graph.board_outline, ())
        lower = -(1 << 63)
        upper = (1 << 63) - 1
        self.stage(
            CommandKind.BOARD_SET_OUTLINE,
            {"vertices": [[lower, lower], [upper, lower], [upper, upper], [lower, upper]]},
        )
        self.assertEqual(
            len(self.kernel.get_transaction("txn-extended").staged_graph.board_outline), 4
        )
        with self.assertRaises(InvariantViolation):
            DesignCommand.create(
                command_id="cmd-float",
                base_revision=self.kernel.head.revision_hash,
                transaction_id="txn-extended",
                actor="agent:test",
                kind=CommandKind.ZONE_ADD,
                payload={"zone_id": "z", "clearance_nm": 0.1},
                idempotency_key="float",
            )

    def test_schematic_junction_support_and_cross_net_contact_are_unambiguous(self) -> None:
        self.stage(CommandKind.NET_CREATE, {"net_id": "net-a", "name": "A"})
        self.stage(CommandKind.NET_CREATE, {"net_id": "net-b", "name": "B"})
        self.stage(
            CommandKind.SCHEMATIC_WIRE_ADD,
            {"wire_id": "wire-a", "net_id": "net-a", "vertices": [[0, 0], [2_000_000, 0]]},
        )
        with self.assertRaisesRegex(InvariantViolation, "at least two wires"):
            self.stage(
                CommandKind.SCHEMATIC_JUNCTION_ADD,
                {"junction_id": "junction-early", "net_id": "net-a", "x_nm": 0, "y_nm": 0},
            )
        self.stage(
            CommandKind.SCHEMATIC_WIRE_ADD,
            {
                "wire_id": "wire-b-cross",
                "net_id": "net-b",
                "vertices": [[1_000_000, -1], [1_000_000, 1]],
            },
        )
        with self.assertRaisesRegex(InvariantViolation, "cannot overlap"):
            self.stage(
                CommandKind.SCHEMATIC_WIRE_ADD,
                {
                    "wire_id": "wire-a-overlap",
                    "net_id": "net-a",
                    "vertices": [[1_000_000, 0], [3_000_000, 0]],
                },
            )
        with self.assertRaisesRegex(InvariantViolation, "cannot touch"):
            self.stage(
                CommandKind.SCHEMATIC_WIRE_ADD,
                {
                    "wire_id": "wire-b-touch",
                    "net_id": "net-b",
                    "vertices": [[0, 0], [0, 1_000_000]],
                },
            )
        self.stage(
            CommandKind.SCHEMATIC_WIRE_ADD,
            {
                "wire_id": "wire-a-branch",
                "net_id": "net-a",
                "vertices": [[2_000_000, 0], [2_000_000, 1_000_000]],
            },
        )
        self.stage(
            CommandKind.SCHEMATIC_JUNCTION_ADD,
            {"junction_id": "junction-ok", "net_id": "net-a", "x_nm": 2_000_000, "y_nm": 0},
        )

    def test_entities_and_collections_are_immutable(self) -> None:
        pad = FootprintPad(
            "pad-immutable",
            "cmp-u1",
            "1",
            PointNm(0, 0),
            1,
            1,
            "rect",
            0,
            ("F.Cu",),
        )
        with self.assertRaises(FrozenInstanceError):
            pad.size_x_nm = 2  # type: ignore[misc]
        with self.assertRaises(InvariantViolation):
            DesignGraph(1, "bad-mutable", pads=[pad])  # type: ignore[arg-type]

    def test_verification_adapter_maps_exact_geometry_and_reports_every_loss(self) -> None:
        self.add_component_nets_and_placement()
        self.stage(
            CommandKind.FOOTPRINT_PAD_ADD,
            self.pad_payload("pad-1", "1", net_id="net-a", drill_nm=300_000),
        )
        self.stage(
            CommandKind.FOOTPRINT_PAD_ADD,
            {
                **self.pad_payload("pad-2", "2", net_id="net-a"),
                "shape": "rect",
            },
        )
        self.stage(
            CommandKind.VIA_ADD,
            {
                "via_id": "via-1",
                "net_id": "net-a",
                "center_x_nm": 12,
                "center_y_nm": 34,
                "diameter_nm": 600_000,
                "drill_nm": 300_000,
                "layers": ["F.Cu", "B.Cu"],
            },
        )
        self.stage(
            CommandKind.FOOTPRINT_HOLE_ADD,
            {
                "hole_id": "hole-npth",
                "component_id": "cmp-u1",
                "center_x_nm": 11_000_000,
                "center_y_nm": 20_000_000,
                "diameter_nm": 500_000,
                "plated": False,
                "drill_x_nm": 500_000,
                "drill_y_nm": 900_000,
                "drill_rotation_udeg": 90_000_000,
            },
        )
        self.stage(
            CommandKind.ZONE_ADD,
            {
                "zone_id": "zone-1",
                "net_id": "net-a",
                "layer": "F.Cu",
                "outline": [[0, 0], [3_000_000, 0], [3_000_000, 2_000_000], [0, 2_000_000]],
                "clearance_nm": 200_000,
            },
        )
        board = to_verification_board(
            self.kernel.get_transaction("txn-extended").staged_graph,
            revision="c" * 64,
        )
        first_pin = board.components[0].pins[0]
        self.assertEqual((first_pin.pad_center.x, first_pin.pad_center.y), (10_000_000, 20_000_000))
        self.assertEqual(first_pin.pad_diameter_nm, 800_000)
        self.assertEqual(first_pin.pad_drill_nm, 300_000)
        self.assertEqual(board.vias[0].via_id, "via-1")
        self.assertEqual(board.zones[0].zone_id, "zone-1")
        self.assertNotIn("pad-drill-unrepresented:pad-1", board.unsupported_features)
        self.assertNotIn("pin-pad-shape-unrepresented:pad-2:rect", board.unsupported_features)
        self.assertIn("pad-only-net-binding-unrepresented:pad-2", board.unsupported_features)
        self.assertEqual(3, board.schema_version)
        self.assertEqual(("pad-1", "pad-2"), tuple(pad.pad_id for pad in board.pads))
        self.assertEqual((800_000, 800_000), (board.pads[1].size_x_nm, board.pads[1].size_y_nm))
        self.assertEqual("rect", board.pads[1].shape.value)
        self.assertEqual("hole-npth", board.holes[0].hole_id)
        self.assertFalse(board.holes[0].plated)
        self.assertEqual((500_000, 900_000), (board.holes[0].drill_x_nm, board.holes[0].drill_y_nm))
        self.assertEqual(90_000_000, board.holes[0].drill_rotation_udeg)


class ZoneFillKernelTests(unittest.TestCase):
    _OUTLINE = (
        PointNm(0, 0),
        PointNm(2_000_000, 0),
        PointNm(2_000_000, 2_000_000),
        PointNm(0, 2_000_000),
    )

    def test_zone_add_defaults_to_intent_and_rejects_fill_assertion(self) -> None:
        kernel = DesignKernel(DesignGraph(1, "zone-fill-kernel"))
        base = kernel.head.revision_hash
        kernel.begin_transaction("txn-zone", base_revision=base)
        create_net = DesignCommand.create(
            command_id="cmd-net",
            base_revision=base,
            transaction_id="txn-zone",
            actor="agent:test",
            kind=CommandKind.NET_CREATE,
            payload={"net_id": "net-a", "name": "A"},
            idempotency_key="net-a",
        )
        kernel.stage(create_net)
        payload = {
            "zone_id": "zone-intent",
            "net_id": "net-a",
            "layer": "B.Cu",
            "outline": [[point.x, point.y] for point in self._OUTLINE],
            "clearance_nm": 200_000,
        }
        kernel.stage(
            DesignCommand.create(
                command_id="cmd-zone",
                base_revision=base,
                transaction_id="txn-zone",
                actor="agent:test",
                kind=CommandKind.ZONE_ADD,
                payload=payload,
                idempotency_key="zone-intent",
            )
        )
        graph = kernel.get_transaction("txn-zone").staged_graph
        intent = graph.zones[0]
        self.assertIs(intent.fill_state, ZoneFillState.UNFILLED_INTENT)
        self.assertIsNone(intent.fill_evidence)

        forged = DesignCommand.create(
            command_id="cmd-zone-forged",
            base_revision=base,
            transaction_id="txn-zone",
            actor="agent:test",
            kind=CommandKind.ZONE_ADD,
            payload={
                **payload,
                "zone_id": "zone-forged",
                "fill_state": ZoneFillState.VERIFIED_FILLED.value,
            },
            idempotency_key="zone-forged",
        )
        with self.assertRaisesRegex(InvariantViolation, "unknown: fill_state"):
            kernel.stage(forged)

        filled = bind_verified_zone_fill(
            intent,
            source_graph=graph,
            source_revision=base,
            fill_engine_id="kicad-zone-fill",
            fill_engine_revision="10.0.0",
        )
        self.assertIs(filled.fill_state, ZoneFillState.VERIFIED_FILLED)
        self.assertIsNotNone(filled.fill_evidence)
        verification_board = to_verification_board(
            replace(graph, zones=(filled,)).normalized(),
            revision="c" * 64,
        )
        report = VerificationEngine().verify(verification_board)
        self.assertFalse(
            any(finding.rule_id == "GEO.ZONE.FILL_UNVERIFIED" for finding in report.findings)
        )

    def test_bool_subclass_missing_and_tampered_fill_evidence_fail_closed(self) -> None:
        with self.assertRaisesRegex(InvariantViolation, "exact ZoneFillState"):
            CopperZone(
                "zone-bool", "net-a", "B.Cu", self._OUTLINE, 0, fill_state=True
            )  # type: ignore[arg-type]
        with self.assertRaisesRegex(InvariantViolation, "requires exact source-bound"):
            CopperZone(
                "zone-missing",
                "net-a",
                "B.Cu",
                self._OUTLINE,
                0,
                fill_state=ZoneFillState.VERIFIED_FILLED,
            )

        class EvidenceSubclass(ZoneFillEvidence):
            pass

        with self.assertRaisesRegex(InvariantViolation, "must be exact ZoneFillEvidence"):
            EvidenceSubclass("a" * 64, "b" * 64, "engine", "v1", "c" * 64, "d" * 64)

        intent = CopperZone("zone-valid", "net-a", "B.Cu", self._OUTLINE, 0)
        source = DesignGraph(
            1,
            "zone-evidence-source",
            nets=(Net("net-a", "A"),),
            zones=(intent,),
        ).normalized()
        intent = source.zones[0]
        filled = bind_verified_zone_fill(
            intent,
            source_graph=source,
            source_revision="b" * 64,
            fill_engine_id="kicad-zone-fill",
            fill_engine_revision="10.0.0",
        )
        assert filled.fill_evidence is not None
        with self.assertRaisesRegex(InvariantViolation, "does not bind its provenance"):
            replace(filled.fill_evidence, source_graph_hash="f" * 64)


if __name__ == "__main__":
    unittest.main()

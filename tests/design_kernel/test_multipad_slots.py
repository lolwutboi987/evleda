from __future__ import annotations

import unittest
from dataclasses import replace

from backend.design_kernel import (
    CommandKind,
    Component,
    DesignCommand,
    DesignGraph,
    DesignKernel,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    InvariantViolation,
    Net,
    PinDefinition,
    PinRef,
    PointNm,
)

DATASHEET = "a" * 64
PIN_MAP = "b" * 64


def component() -> Component:
    return Component(
        "connector-j1",
        "J1",
        "Exact connector",
        "CONNECTOR-EXACT",
        "receptacle",
        "Connector:Exact",
        "Connector:Exact",
        DATASHEET,
        PIN_MAP,
        (
            PinDefinition("A1", "VBUS-A", "power_in", "A1"),
            PinDefinition("B12", "VBUS-B", "power_in", "B12"),
            PinDefinition("S1", "SHIELD", "passive", "S1"),
        ),
    )


def base_graph(*, connected: bool = True) -> DesignGraph:
    members = (
        (
            PinRef("connector-j1", "A1"),
            PinRef("connector-j1", "B12"),
            PinRef("connector-j1", "S1"),
        )
        if connected
        else ()
    )
    return DesignGraph(
        1,
        "multipad-board",
        components=(component(),),
        nets=(Net("net-gnd", "GND", members), Net("net-alt", "ALT")),
        placements=(FootprintPlacement("connector-j1", PointNm(10_000_000, 10_000_000)),),
    ).normalized()


def pad_payload(
    pad_id: str,
    pad_number: str,
    *,
    x_nm: int,
    y_nm: int,
    net_id: str | None = "net-gnd",
    shared_land_group_id: str | None = None,
    slot: bool = False,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "pad_id": pad_id,
        "component_id": "connector-j1",
        "pad_number": pad_number,
        "center_x_nm": x_nm,
        "center_y_nm": y_nm,
        "size_x_nm": 1_200_000 if slot else 1_000_000,
        "size_y_nm": 1_700_000 if slot else 600_000,
        "shape": "oval" if slot else "rect",
        "rotation_udeg": 90_000_000 if slot else 0,
        "layers": ["F.Cu", "B.Cu"] if slot else ["F.Cu"],
        "pad_drill_nm": 600_000 if slot else 0,
        "drill_x_nm": 600_000 if slot else 0,
        "drill_y_nm": 1_100_000 if slot else 0,
        "drill_rotation_udeg": 90_000_000 if slot else 0,
    }
    if net_id is not None:
        payload["net_id"] = net_id
    if shared_land_group_id is not None:
        payload["shared_land_group_id"] = shared_land_group_id
    return payload


class CanonicalMultipadAndSlotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.kernel = DesignKernel(base_graph())
        self.base_revision = self.kernel.head.revision_hash
        self.kernel.begin_transaction("txn-multipad", base_revision=self.base_revision)
        self.sequence = 0

    def stage(self, kind: CommandKind, payload: dict[str, object]):
        self.sequence += 1
        command_id = f"cmd-multipad-{self.sequence}"
        command = DesignCommand.create(
            command_id=command_id,
            base_revision=self.base_revision,
            transaction_id="txn-multipad",
            actor="agent:canonical-test",
            kind=kind,
            payload=payload,
            idempotency_key=command_id,
        )
        return self.kernel.stage(command), command

    def test_multiple_physical_pads_keep_one_manufacturer_pad_number(self) -> None:
        self.stage(
            CommandKind.FOOTPRINT_PAD_ADD,
            pad_payload("pad-shell-left", "S1", x_nm=8_000_000, y_nm=10_000_000),
        )
        self.stage(
            CommandKind.FOOTPRINT_PAD_ADD,
            pad_payload("pad-shell-right", "S1", x_nm=12_000_000, y_nm=10_000_000),
        )
        graph = self.kernel.get_transaction("txn-multipad").staged_graph
        shell_pads = tuple(pad for pad in graph.pads if pad.pad_number == "S1")
        self.assertEqual(
            tuple(pad.pad_id for pad in shell_pads),
            ("pad-shell-left", "pad-shell-right"),
        )
        self.assertEqual({pad.net_id for pad in shell_pads}, {"net-gnd"})
        self.assertEqual(
            next(pin for pin in graph.components[0].pins if pin.number == "S1").pad_number,
            "S1",
        )
        reordered = replace(graph, pads=tuple(reversed(graph.pads)))
        self.assertEqual(graph.graph_hash, reordered.graph_hash)
        reduced = replace(graph, pads=(graph.pads[0],))
        self.assertNotEqual(graph.graph_hash, reduced.graph_hash)

    def test_repeated_logical_pad_rejects_mixed_net_semantics(self) -> None:
        graph = base_graph(connected=False)
        first = FootprintPad(
            "pad-shell-left",
            "connector-j1",
            "S1",
            PointNm(8_000_000, 10_000_000),
            1_000_000,
            600_000,
            "rect",
            0,
            ("F.Cu",),
            net_id="net-gnd",
        )
        second = replace(
            first,
            pad_id="pad-shell-right",
            center=PointNm(12_000_000, 10_000_000),
            net_id="net-alt",
        )
        with self.assertRaisesRegex(InvariantViolation, "identical net semantics"):
            _ = replace(graph, pads=(first, second)).graph_hash

    def test_exact_plated_and_nonplated_slots_preserve_dimensions_and_rotation(self) -> None:
        self.stage(
            CommandKind.FOOTPRINT_PAD_ADD,
            pad_payload(
                "pad-shell-slot",
                "S1",
                x_nm=8_000_000,
                y_nm=10_000_000,
                slot=True,
            ),
        )
        before_hole = self.kernel.get_transaction("txn-multipad")
        with self.assertRaisesRegex(InvariantViolation, "exact pad drill geometry"):
            self.stage(
                CommandKind.FOOTPRINT_HOLE_ADD,
                {
                    "hole_id": "hole-shell-wrong",
                    "component_id": "connector-j1",
                    "center_x_nm": 8_000_000,
                    "center_y_nm": 10_000_000,
                    "diameter_nm": 600_000,
                    "drill_x_nm": 600_000,
                    "drill_y_nm": 1_100_000,
                    "drill_rotation_udeg": 0,
                    "plated": True,
                    "pad_id": "pad-shell-slot",
                },
            )
        self.assertEqual(
            self.kernel.get_transaction("txn-multipad").staged_graph,
            before_hole.staged_graph,
        )
        self.stage(
            CommandKind.FOOTPRINT_HOLE_ADD,
            {
                "hole_id": "hole-shell-slot",
                "component_id": "connector-j1",
                "center_x_nm": 8_000_000,
                "center_y_nm": 10_000_000,
                "diameter_nm": 600_000,
                "drill_x_nm": 600_000,
                "drill_y_nm": 1_100_000,
                "drill_rotation_udeg": 90_000_000,
                "plated": True,
                "pad_id": "pad-shell-slot",
            },
        )
        with self.assertRaisesRegex(InvariantViolation, "only one plated"):
            self.stage(
                CommandKind.FOOTPRINT_HOLE_ADD,
                {
                    "hole_id": "hole-shell-slot-duplicate",
                    "component_id": "connector-j1",
                    "center_x_nm": 8_000_000,
                    "center_y_nm": 10_000_000,
                    "diameter_nm": 600_000,
                    "drill_x_nm": 600_000,
                    "drill_y_nm": 1_100_000,
                    "drill_rotation_udeg": 90_000_000,
                    "plated": True,
                    "pad_id": "pad-shell-slot",
                },
            )
        self.stage(
            CommandKind.FOOTPRINT_HOLE_ADD,
            {
                "hole_id": "hole-locator-slot",
                "component_id": "connector-j1",
                "center_x_nm": 10_000_000,
                "center_y_nm": 12_000_000,
                "diameter_nm": 500_000,
                "drill_x_nm": 500_000,
                "drill_y_nm": 900_000,
                "drill_rotation_udeg": 45_000_000,
                "plated": False,
            },
        )
        graph = self.kernel.get_transaction("txn-multipad").staged_graph
        plated = next(hole for hole in graph.holes if hole.hole_id == "hole-shell-slot")
        nonplated = next(hole for hole in graph.holes if hole.hole_id == "hole-locator-slot")
        self.assertEqual(
            (plated.drill_x_nm, plated.drill_y_nm, plated.drill_rotation_udeg),
            (600_000, 1_100_000, 90_000_000),
        )
        self.assertTrue(plated.drill_is_slot)
        self.assertFalse(nonplated.plated)
        self.assertTrue(nonplated.drill_is_slot)

    def test_shared_land_group_is_atomic_exact_and_preserves_both_contacts(self) -> None:
        bad_pads = [
            pad_payload(
                "pad-a1",
                "A1",
                x_nm=10_000_000,
                y_nm=9_000_000,
                shared_land_group_id="land-vbus-1",
            ),
            pad_payload(
                "pad-b12",
                "B12",
                x_nm=10_000_001,
                y_nm=9_000_000,
                shared_land_group_id="land-vbus-1",
            ),
        ]
        with self.assertRaisesRegex(InvariantViolation, "exact identical geometry and net"):
            self.stage(
                CommandKind.FOOTPRINT_PAD_GROUP_ADD,
                {"shared_land_group_id": "land-vbus-1", "pads": bad_pads},
            )
        self.assertEqual(self.kernel.get_transaction("txn-multipad").staged_graph.pads, ())

        good_pads = [
            pad_payload(
                "pad-a1",
                "A1",
                x_nm=10_000_000,
                y_nm=9_000_000,
                shared_land_group_id="land-vbus-1",
            ),
            pad_payload(
                "pad-b12",
                "B12",
                x_nm=10_000_000,
                y_nm=9_000_000,
                shared_land_group_id="land-vbus-1",
            ),
        ]
        _, command = self.stage(
            CommandKind.FOOTPRINT_PAD_GROUP_ADD,
            {"shared_land_group_id": "land-vbus-1", "pads": good_pads},
        )
        graph = self.kernel.get_transaction("txn-multipad").staged_graph
        self.assertEqual({pad.pad_number for pad in graph.pads}, {"A1", "B12"})
        self.assertEqual({pad.shared_land_group_id for pad in graph.pads}, {"land-vbus-1"})
        self.assertEqual(len({pad.center for pad in graph.pads}), 1)

        replay = DesignKernel(base_graph())
        replay.begin_transaction("txn-multipad", base_revision=replay.head.revision_hash)
        replay.stage(command)
        self.assertEqual(
            replay.get_transaction("txn-multipad").staged_graph.graph_hash,
            graph.graph_hash,
        )
        regrouped = replace(
            graph,
            pads=tuple(replace(pad, shared_land_group_id="land-vbus-2") for pad in graph.pads),
        )
        self.assertNotEqual(graph.graph_hash, regrouped.graph_hash)

    def test_slot_rotation_and_legacy_circle_normalize_deterministically(self) -> None:
        pad = FootprintPad(
            "pad-slot-normalized",
            "connector-j1",
            "S1",
            PointNm(0, 0),
            1_200_000,
            1_700_000,
            "oval",
            90_000_000,
            ("F.Cu", "B.Cu"),
            600_000,
            "net-gnd",
            drill_x_nm=600_000,
            drill_y_nm=1_100_000,
            drill_rotation_udeg=270_000_000,
        )
        hole = FootprintHole(
            "hole-slot-normalized",
            "connector-j1",
            PointNm(0, 0),
            600_000,
            True,
            "pad-slot-normalized",
            drill_x_nm=600_000,
            drill_y_nm=1_100_000,
            drill_rotation_udeg=270_000_000,
        )
        variant = replace(
            base_graph(),
            pads=(replace(pad, drill_rotation_udeg=90_000_000),),
            holes=(replace(hole, drill_rotation_udeg=90_000_000),),
        )
        source = replace(base_graph(), pads=(pad,), holes=(hole,))
        self.assertEqual(source.graph_hash, variant.graph_hash)
        normalized = source.normalized()
        self.assertEqual(normalized.pads[0].drill_rotation_udeg, 90_000_000)
        self.assertEqual(normalized.holes[0].drill_rotation_udeg, 90_000_000)

        legacy_circle = FootprintHole(
            "hole-legacy-circle",
            "connector-j1",
            PointNm(1, 1),
            650_000,
        )
        self.assertEqual(
            (legacy_circle.drill_x_nm, legacy_circle.drill_y_nm),
            (650_000, 650_000),
        )

    def test_bool_and_subclass_aliases_fail_at_typed_geometry_boundaries(self) -> None:
        payload = pad_payload(
            "pad-bool",
            "S1",
            x_nm=8_000_000,
            y_nm=10_000_000,
            slot=True,
        )
        payload["drill_x_nm"] = True
        with self.assertRaisesRegex(InvariantViolation, "must be an integer"):
            self.stage(CommandKind.FOOTPRINT_PAD_ADD, payload)

        class PadAlias(FootprintPad):
            pass

        class HoleAlias(FootprintHole):
            pass

        with self.assertRaisesRegex(InvariantViolation, "exact concrete type"):
            PadAlias(
                "pad-alias",
                "connector-j1",
                "S1",
                PointNm(0, 0),
                1,
                1,
                "rect",
                0,
                ("F.Cu",),
            )
        with self.assertRaisesRegex(InvariantViolation, "exact concrete type"):
            HoleAlias("hole-alias", "connector-j1", PointNm(0, 0), 1)


if __name__ == "__main__":
    unittest.main()

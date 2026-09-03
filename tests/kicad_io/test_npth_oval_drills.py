from __future__ import annotations

import unittest
from dataclasses import replace
from pathlib import Path
from typing import cast

from backend.design_kernel import Component, PinDefinition
from backend.kicad_io import (
    CanonicalMappingError,
    Footprint,
    KiCadInvariantError,
    KiCadSyntaxError,
    MappingGap,
    Pad,
    PadDrillShape,
    PadKind,
    export_board,
    import_board,
    round_trip,
    to_design_graph,
)

FIXTURE = Path(__file__).with_name("fixtures") / "usb_c_npth_slots.kicad_pcb"
DATASHEET = "c" * 64
PIN_MAP = "d" * 64


class _PadSubclass(Pad):
    pass


class _UsbResolver:
    def resolve(self, footprint: Footprint) -> Component:
        return Component(
            "component-usb-j1",
            footprint.reference,
            footprint.value,
            "USB-C-RECEPTACLE-EXACT",
            "USB Type-C receptacle",
            "symbol:usb-c-receptacle",
            footprint.library_id,
            DATASHEET,
            PIN_MAP,
            (
                PinDefinition("A4", "VBUS_A", "power_in", "A4"),
                PinDefinition("B9", "VBUS_B", "power_in", "B9"),
                PinDefinition("S1", "SHIELD", "passive", "S1"),
            ),
        )


class KiCadNpthAndOvalDrillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = FIXTURE.read_bytes()
        self.board = import_board(self.source).board

    def test_usb_fixture_preserves_npth_plating_drill_axes_and_orientation(self) -> None:
        pads = self.board.footprints[0].pads
        npth = tuple(item for item in pads if item.kind is PadKind.NPTH)
        plated = tuple(item for item in pads if item.kind is PadKind.THROUGH_HOLE)

        self.assertEqual(len(npth), 2)
        self.assertEqual(len(plated), 2)
        self.assertTrue(all(item.number == "" and item.net_id is None for item in npth))
        self.assertTrue(all(item.drill_shape is PadDrillShape.CIRCLE for item in npth))
        self.assertEqual(
            {(item.size_x_nm, item.size_y_nm, item.drill_x_nm, item.drill_y_nm) for item in npth},
            {(650_000, 650_000, 650_000, 650_000)},
        )
        self.assertTrue(all(not item.plated and item.drill_rotation_udeg == 0 for item in npth))

        self.assertTrue(all(item.plated for item in plated))
        self.assertTrue(all(item.drill_shape is PadDrillShape.OVAL for item in plated))
        self.assertEqual(
            {(item.drill_x_nm, item.drill_y_nm, item.drill_rotation_udeg) for item in plated},
            {(600_000, 1_400_000, 90_000_000)},
        )

    def test_export_and_reparse_are_deterministic_and_geometry_bound(self) -> None:
        first = export_board(self.board)
        second = export_board(self.board)
        self.assertEqual(first, second)
        self.assertEqual(first.evidence.writer_id, "flux-clone-kicad-pcb-writer-v2")
        self.assertEqual(
            import_board(self.source).evidence.parser_id,
            "flux-clone-kicad-pcb-subset-v2",
        )
        self.assertIn(b'np_thru_hole', first.payload)
        self.assertIn(b'(drill oval 0.6 1.4)', first.payload)

        parity = round_trip(self.source)
        self.assertTrue(parity.evidence.semantic_parity)
        self.assertTrue(parity.evidence.diagnostics_parity)
        self.assertEqual(
            parity.imported.board.normalized_ir_sha256,
            parity.reparsed.board.normalized_ir_sha256,
        )

        footprint = self.board.footprints[0]
        npth = next(item for item in footprint.pads if item.kind is PadKind.NPTH)
        plated_variant = replace(
            npth,
            number="M1",
            kind=PadKind.THROUGH_HOLE,
            size_x_nm=1_050_000,
            size_y_nm=1_050_000,
        )
        plated_board = replace(
            self.board,
            footprints=(replace(footprint, pads=(plated_variant, *footprint.pads[1:])),),
        )
        self.assertNotEqual(
            self.board.normalized_ir_sha256,
            plated_board.normalized_ir_sha256,
        )

        resized_npth = replace(
            npth,
            size_x_nm=700_000,
            size_y_nm=700_000,
            drill_x_nm=700_000,
            drill_y_nm=700_000,
        )
        resized_board = replace(
            self.board,
            footprints=(replace(footprint, pads=(resized_npth, *footprint.pads[1:])),),
        )
        self.assertNotEqual(
            self.board.normalized_ir_sha256,
            resized_board.normalized_ir_sha256,
        )

        slot = next(item for item in footprint.pads if item.kind is PadKind.THROUGH_HOLE)
        rotated_board = replace(
            self.board,
            footprints=(
                replace(
                    footprint,
                    pads=tuple(
                        replace(item, rotation_udeg=0) if item.pad_id == slot.pad_id else item
                        for item in footprint.pads
                    ),
                ),
            ),
        )
        self.assertNotEqual(
            self.board.normalized_ir_sha256,
            rotated_board.normalized_ir_sha256,
        )

    def test_canonical_bridge_maps_npth_as_unplated_holes_and_plated_slots_exactly(self) -> None:
        result = to_design_graph(
            self.board,
            project_id="usb-c-npth-slot-fixture",
            component_resolver=_UsbResolver(),
        )
        self.assertEqual(len(result.graph.pads), 4)
        self.assertEqual(len(result.graph.holes), 4)
        unplated = tuple(item for item in result.graph.holes if not item.plated)
        plated = tuple(item for item in result.graph.holes if item.plated)
        self.assertEqual(len(unplated), 2)
        self.assertTrue(all(item.pad_id is None for item in unplated))
        self.assertEqual(
            {(item.drill_x_nm, item.drill_y_nm, item.drill_rotation_udeg) for item in unplated},
            {(650_000, 650_000, 0)},
        )
        self.assertEqual(len(plated), 2)
        self.assertTrue(all(item.pad_id is not None for item in plated))
        self.assertEqual(
            {(item.drill_x_nm, item.drill_y_nm, item.drill_rotation_udeg) for item in plated},
            {(600_000, 1_400_000, 90_000_000)},
        )
        slots = tuple(item for item in result.graph.pads if item.drill_is_slot)
        self.assertEqual(
            {(item.drill_x_nm, item.drill_y_nm, item.drill_rotation_udeg) for item in slots},
            {(600_000, 1_400_000, 90_000_000)},
        )
        repeated_shells = tuple(item for item in result.graph.pads if item.pad_number == "S1")
        self.assertEqual(len(repeated_shells), 2)
        self.assertEqual(len({item.pad_id for item in repeated_shells}), 2)
        gnd_id = next(net.net_id for net in result.graph.nets if net.name == "GND")
        self.assertEqual({item.net_id for item in repeated_shells}, {gnd_id})

        shared_contacts = tuple(
            item for item in result.graph.pads if item.pad_number in {"A4", "B9"}
        )
        self.assertEqual(len({item.center for item in shared_contacts}), 1)
        group_ids = {item.shared_land_group_id for item in shared_contacts}
        self.assertEqual(len(group_ids), 1)
        self.assertNotIn(None, group_ids)

    def test_npth_rejects_every_electrical_claim_and_noncanonical_layer_order(self) -> None:
        first_npth_uuid = b"      (uuid 10000000-0000-4000-8000-000000000011)"
        for claim in (
            b'      (net 0 "")\n',
            b'      (pinfunction "MECHANICAL")\n',
            b'      (pintype "passive")\n',
        ):
            malformed = self.source.replace(first_npth_uuid, claim + first_npth_uuid, 1)
            with self.subTest(claim=claim), self.assertRaises(KiCadInvariantError):
                import_board(malformed)

        reversed_layers = self.source.replace(
            b'(layers "*.Cu" "*.Mask")',
            b'(layers "*.Mask" "*.Cu")',
            1,
        )
        with self.assertRaises(KiCadInvariantError):
            import_board(reversed_layers)
        missing_npth_mask = self.source.replace(
            b'(layers "*.Cu" "*.Mask")',
            b'(layers "*.Cu")',
            1,
        )
        with self.assertRaises(KiCadInvariantError):
            import_board(missing_npth_mask)
        reversed_plated_layers = self.source.replace(
            b'(drill oval 0.6 1.4)\n      (layers "*.Cu" "*.Mask")',
            b'(drill oval 0.6 1.4)\n      (layers "*.Mask" "*.Cu")',
            1,
        )
        with self.assertRaises(KiCadInvariantError):
            import_board(reversed_plated_layers)

    def test_npth_requires_zero_annulus_and_shape_matching_its_drill(self) -> None:
        oversized = self.source.replace(b'(size 0.65 0.65)', b'(size 0.8 0.8)', 1)
        with self.assertRaises(KiCadInvariantError):
            import_board(oversized)
        wrong_shape = self.source.replace(
            b'np_thru_hole circle',
            b'np_thru_hole oval',
            1,
        )
        with self.assertRaises(KiCadInvariantError):
            import_board(wrong_shape)

    def test_plated_drill_requires_positive_annulus_on_both_axes(self) -> None:
        equal_x = self.source.replace(b'(size 1.2 2)', b'(size 0.6 2)', 1)
        equal_y = self.source.replace(b'(size 1.2 2)', b'(size 1.2 1.4)', 1)
        for malformed in (equal_x, equal_y):
            with self.subTest(malformed=malformed), self.assertRaises(KiCadInvariantError):
                import_board(malformed)

    def test_drill_grammar_rejects_offset_rotation_and_ambiguous_oval_syntax(self) -> None:
        mutations: tuple[tuple[bytes, type[Exception]], ...] = (
            (b'(drill oval 0.6 1.4 (offset 0.1 0))', KiCadInvariantError),
            (b'(drill oval 0.6 1.4 (rotation 45))', KiCadInvariantError),
            (b'(drill 0.6 1.4)', KiCadSyntaxError),
            (b'(drill oval 0.6)', KiCadSyntaxError),
            (b'(drill oval 0.6 0.6)', KiCadInvariantError),
        )
        for drill, error_type in mutations:
            malformed = self.source.replace(b'(drill oval 0.6 1.4)', drill, 1)
            with self.subTest(drill=drill), self.assertRaises(error_type):
                import_board(malformed)

    def test_bool_and_pad_subclass_inputs_are_rejected(self) -> None:
        pad = self.board.footprints[0].pads[0]
        with self.assertRaises(KiCadInvariantError):
            replace(pad, drill_x_nm=True)
        with self.assertRaises(KiCadInvariantError):
            replace(pad, rotation_udeg=True)
        with self.assertRaises(KiCadInvariantError):
            _PadSubclass(
                pad.pad_id,
                pad.number,
                pad.kind,
                pad.shape,
                pad.position,
                pad.rotation_udeg,
                pad.size_x_nm,
                pad.size_y_nm,
                pad.drill_x_nm,
                pad.drill_y_nm,
                pad.layers,
                pad.net_id,
                pad.pin_function,
                pad.pin_type,
                pad.roundrect_ratio_ppm,
                pad.locked,
            )

    def test_noncardinal_slot_rotation_is_an_explicit_mapping_failure(self) -> None:
        footprint = self.board.footprints[0]
        pads = tuple(
            replace(item, rotation_udeg=45_000_000)
            if item.kind is PadKind.THROUGH_HOLE
            else item
            for item in footprint.pads
        )
        rotated = replace(self.board, footprints=(replace(footprint, pads=pads),))
        with self.assertRaises(CanonicalMappingError) as caught:
            to_design_graph(
                rotated,
                project_id="noncardinal-usb-slot",
                component_resolver=_UsbResolver(),
            )
        gaps = cast(tuple[MappingGap, ...], caught.exception.gaps)
        self.assertTrue(
            all(
                item.code == "non-cardinal-drill-rotation-unsupported"
                for item in gaps
            )
        )

    def test_repeated_pad_and_shared_land_groups_reject_mixed_net_claims(self) -> None:
        repeated_shell_mismatch = self.source.replace(
            b'(net 1 "GND")\n      (pinfunction "SHIELD")',
            b'(net 2 "VBUS")\n      (pinfunction "SHIELD")',
            1,
        )
        shared_land_mismatch = self.source.replace(
            b'(net 2 "VBUS")\n      (pinfunction "VBUS_B")',
            b'(net 1 "GND")\n      (pinfunction "VBUS_B")',
            1,
        )
        cases = (
            (repeated_shell_mismatch, "repeated-pad-net-mismatch"),
            (shared_land_mismatch, "shared-land-net-mismatch"),
        )
        for source, expected_code in cases:
            board = import_board(source).board
            with self.subTest(expected_code=expected_code), self.assertRaises(
                CanonicalMappingError
            ) as caught:
                to_design_graph(
                    board,
                    project_id=f"mixed-net-{expected_code}",
                    component_resolver=_UsbResolver(),
                )
            gaps = cast(tuple[MappingGap, ...], caught.exception.gaps)
            self.assertIn(expected_code, {item.code for item in gaps})


if __name__ == "__main__":
    unittest.main()

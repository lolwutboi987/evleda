from __future__ import annotations

import unittest
from dataclasses import replace
from pathlib import Path

from backend.design_kernel import Component, PinDefinition
from backend.kicad_io import (
    CanonicalMappingError,
    Footprint,
    UnsupportedPolicy,
    canonical_net_id,
    import_board,
    to_design_graph,
)

FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad"
DATASHEET = "a" * 64
PIN_MAP = "b" * 64


class FixtureResolver:
    def resolve(self, footprint: Footprint) -> Component:
        definitions = {
            "U1": (
                PinDefinition("1", "GND", "power_in", "1"),
                PinDefinition("2", "OUT", "output", "2"),
            ),
            "J1": (PinDefinition("1", "GND", "passive", "1"),),
        }
        return Component(
            f"component-{footprint.reference.lower()}",
            footprint.reference,
            footprint.value,
            f"PROVEN-{footprint.reference}",
            "resolved-package",
            f"symbol:{footprint.reference.lower()}",
            footprint.library_id,
            DATASHEET,
            PIN_MAP,
            definitions[footprint.reference],
        )


class MismatchedResolver(FixtureResolver):
    def resolve(self, footprint: Footprint) -> Component:
        component = super().resolve(footprint)
        return replace(component, footprint_id="Wrong:Footprint")


class KiCadCanonicalAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        source = (FIXTURES / "supported_board.kicad_pcb").read_bytes()
        self.board = import_board(source).board

    def test_maps_exact_geometry_with_provenance_and_names_all_remaining_gaps(self) -> None:
        result = to_design_graph(
            self.board,
            project_id="kicad-import-fixture",
            component_resolver=FixtureResolver(),
        )
        graph = result.graph
        self.assertEqual(result.graph_sha256, graph.graph_hash)
        self.assertEqual(result.source_ir_sha256, self.board.normalized_ir_sha256)
        self.assertEqual(
            result.diagnostics_manifest_sha256,
            self.board.diagnostics.manifest_sha256,
        )
        self.assertEqual({item.reference for item in graph.components}, {"U1", "J1"})
        self.assertEqual(len(graph.board_outline), 4)
        self.assertEqual(len(graph.pads), 3)
        self.assertEqual(len(graph.holes), 1)
        self.assertEqual(graph.holes[0].diameter_nm, 900_000)
        drilled_pad = next(item for item in graph.pads if item.pad_drill_nm)
        self.assertEqual(graph.holes[0].pad_id, drilled_pad.pad_id)
        u1_pad_1 = next(
            item
            for item in graph.pads
            if item.component_id == "component-u1" and item.pad_number == "1"
        )
        self.assertEqual((u1_pad_1.center.x, u1_pad_1.center.y), (10_000_000, 9_000_000))
        self.assertEqual(u1_pad_1.rotation_udeg, 90_000_000)
        self.assertEqual(u1_pad_1.net_id, canonical_net_id("GND"))
        self.assertEqual(graph.vias[0].layers, ("B.Cu", "F.Cu"))
        self.assertEqual(graph.zones[0].clearance_nm, 200_000)
        gnd = next(item for item in graph.nets if item.name == "GND")
        self.assertEqual(
            {(item.component_id, item.pin_number) for item in gnd.members},
            {("component-u1", "1"), ("component-j1", "1")},
        )

        codes = {item.code for item in result.gaps}
        self.assertIn("pad-fabrication-layers-source-retained", codes)
        self.assertIn("footprint-attributes-source-retained", codes)
        self.assertIn("opaque-source-manifest-required", codes)
        self.assertIn("roundrect-ratio-source-retained", codes)
        self.assertIn("net-membership-inferred-from-pcb-pads", codes)
        self.assertIn("pcb-only-schematic-parity-unproven", codes)
        self.assertFalse(result.release_eligible)

    def test_resolver_identity_mismatch_fails_before_graph_creation(self) -> None:
        with self.assertRaises(CanonicalMappingError) as caught:
            to_design_graph(
                self.board,
                project_id="bad-resolver",
                component_resolver=MismatchedResolver(),
            )
        self.assertTrue(
            any(item.code == "resolver-identity-mismatch" for item in caught.exception.gaps)
        )

    def test_nonorthogonal_rotation_is_rejected_instead_of_rounded(self) -> None:
        footprint = replace(self.board.footprints[0], rotation_udeg=45_000_000)
        board = replace(
            self.board,
            footprints=(footprint, *self.board.footprints[1:]),
        )
        with self.assertRaises(CanonicalMappingError) as caught:
            to_design_graph(
                board,
                project_id="nonorthogonal",
                component_resolver=FixtureResolver(),
            )
        self.assertTrue(
            any(
                item.code == "non-orthogonal-transform-unsupported"
                for item in caught.exception.gaps
            )
        )

    def test_unsupported_manifest_blocks_canonical_conversion(self) -> None:
        source = (FIXTURES / "unsupported_zone.kicad_pcb").read_bytes()
        reviewed = import_board(source, unsupported_policy=UnsupportedPolicy.MANIFEST)
        with self.assertRaises(CanonicalMappingError) as caught:
            to_design_graph(
                reviewed.board,
                project_id="unsupported-zone",
                component_resolver=FixtureResolver(),
            )
        self.assertTrue(
            all(item.code == "unsupported-source-construct" for item in caught.exception.gaps)
        )


if __name__ == "__main__":
    unittest.main()

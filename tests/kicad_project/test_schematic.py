from __future__ import annotations

import unittest
from pathlib import Path

from backend.kicad_project import (
    BundleLimits,
    DiagnosticDisposition,
    LabelKind,
    ProjectInvariantError,
    parse_schematic,
    render_schematic,
)

FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad_project"


def _rotation_oracle_payload() -> bytes:
    placements = (
        ("R1", "53.34", "116.84", 0),
        ("R2", "100", "200", 90),
        ("R3", "300", "400", 180),
        ("R4", "500", "600", 270),
    )
    symbols: list[str] = []
    for index, (reference, x, y, angle) in enumerate(placements, start=1):
        symbol_id = f"30000000-0000-4000-8000-{100 + index:012d}"
        pin_ids = tuple(
            f"30000000-0000-4000-8000-{200 + 3 * index + pin:012d}"
            for pin in range(1, 4)
        )
        symbols.append(
            f'''  (symbol
    (lib_id "Device:TransformOracle")
    (at {x} {y} {angle})
    (unit 1)
    (uuid "{symbol_id}")
    (property "Reference" "{reference}")
    (property "Value" "ORACLE")
    (pin "1" (uuid "{pin_ids[0]}"))
    (pin "2" (uuid "{pin_ids[1]}"))
    (pin "3" (uuid "{pin_ids[2]}")))
'''
        )
    return (
        '''(kicad_sch
  (version 20260306)
  (generator "transform_oracle")
  (generator_version "10.0")
  (uuid "30000000-0000-4000-8000-000000000001")
  (lib_symbols
    (symbol "Device:TransformOracle"
      (symbol "TransformOracle_1_1"
        (pin passive line
          (at 2.000001 -3.000002 17)
          (name "VISIBLE")
          (number "1"))
        (pin passive line
          (at 0 -3.81 90)
          (name "R1_CASE")
          (number "2"))
        (pin power_in line
          (at 2.000001 -3.000002 197)
          (hide yes)
          (name "STACKED_HIDDEN")
          (number "3")))))
'''
        + "".join(symbols)
        + '''  (sheet_instances
    (path "/" (page "1"))))
'''
    ).encode("utf-8")


class SchematicCodecTests(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = (FIXTURES / "supported_project.kicad_sch").read_bytes()

    def test_models_symbols_pins_wires_junctions_labels_and_exact_connectivity(self) -> None:
        schematic = parse_schematic(self.payload, limits=BundleLimits())
        self.assertEqual(schematic.format_version, 20260306)
        self.assertEqual(schematic.generator_version, "10.0")
        self.assertEqual(len(schematic.library_symbols), 2)
        self.assertEqual(len(schematic.symbols), 2)
        self.assertEqual(len(schematic.wires), 4)
        self.assertEqual(len(schematic.junctions), 1)
        self.assertEqual(len(schematic.labels), 2)
        self.assertEqual(
            {item.kind for item in schematic.labels}, {LabelKind.LOCAL, LabelKind.GLOBAL}
        )
        self.assertEqual({item.name for item in schematic.nets}, {"GND", "SIG"})

        nets = {item.name: item for item in schematic.nets}
        self.assertEqual(len(nets["GND"].wire_ids), 3)
        self.assertEqual(len(nets["GND"].junction_ids), 1)
        self.assertEqual(
            {(item.pin_number) for item in nets["GND"].pin_refs}, {"1"}
        )
        self.assertEqual(len(nets["GND"].pin_refs), 2)
        self.assertEqual(len(nets["SIG"].wire_ids), 1)
        self.assertEqual([item.pin_number for item in nets["SIG"].pin_refs], ["2"])

        symbols = {item.reference: item for item in schematic.symbols}
        pins = {item.number: item for item in symbols["U1"].pins}
        self.assertEqual((pins["1"].position.x, pins["1"].position.y), (22_860_000, 25_400_000))
        self.assertEqual((pins["2"].position.x, pins["2"].position.y), (27_940_000, 25_400_000))
        self.assertFalse(schematic.diagnostics.unsupported)
        self.assertTrue(
            all(
                item.disposition is DiagnosticDisposition.PRESERVED
                for item in schematic.diagnostics.constructs
            )
        )

    def test_library_cartesian_y_and_placed_quarter_turns_use_exact_nm_oracles(self) -> None:
        schematic = parse_schematic(_rotation_oracle_payload(), limits=BundleLimits())
        symbols = {item.reference: item for item in schematic.symbols}
        expected = {
            "R1": {
                "1": (55_340_001, 119_840_002),
                "2": (53_340_000, 120_650_000),
                "3": (55_340_001, 119_840_002),
            },
            "R2": {
                "1": (103_000_002, 197_999_999),
                "2": (103_810_000, 200_000_000),
                "3": (103_000_002, 197_999_999),
            },
            "R3": {
                "1": (297_999_999, 396_999_998),
                "2": (300_000_000, 396_190_000),
                "3": (297_999_999, 396_999_998),
            },
            "R4": {
                "1": (496_999_998, 602_000_001),
                "2": (496_190_000, 600_000_000),
                "3": (496_999_998, 602_000_001),
            },
        }
        self.assertEqual(set(symbols), set(expected))
        for reference, expected_pins in expected.items():
            actual_pins = {
                pin.number: (pin.position.x, pin.position.y)
                for pin in symbols[reference].pins
            }
            self.assertEqual(actual_pins, expected_pins)

        reference_by_symbol_id = {
            symbol.symbol_id: symbol.reference for symbol in schematic.symbols
        }
        stacked_memberships = {
            frozenset(
                (reference_by_symbol_id[pin.symbol_id], pin.pin_number)
                for pin in net.pin_refs
            )
            for net in schematic.nets
        }
        self.assertEqual(
            stacked_memberships,
            {
                frozenset(((reference, "1"), (reference, "3")))
                for reference in expected
            },
        )

    def test_writer_is_deterministic_and_semantic_plus_retained_digests_round_trip(self) -> None:
        imported = parse_schematic(self.payload, limits=BundleLimits())
        first = render_schematic(imported)
        second = render_schematic(imported)
        reparsed = parse_schematic(first, limits=BundleLimits())
        self.assertEqual(first, second)
        self.assertEqual(imported.normalized_ir_sha256, reparsed.normalized_ir_sha256)
        self.assertEqual(
            imported.diagnostics.manifest_sha256,
            reparsed.diagnostics.manifest_sha256,
        )
        self.assertIn(b"(generator flux_clone)", first)

    def test_writer_preserves_numeric_occurrence_order_past_single_digits(self) -> None:
        presentations = b"".join(
            f'  (text "presentation-{index}")\n'.encode() for index in range(12)
        )
        source = self.payload.replace(
            b"  (sheet_instances", presentations + b"  (sheet_instances", 1
        )
        imported = parse_schematic(source, limits=BundleLimits())
        reparsed = parse_schematic(render_schematic(imported), limits=BundleLimits())
        self.assertEqual(imported.normalized_ir_sha256, reparsed.normalized_ir_sha256)
        self.assertEqual(
            imported.diagnostics.manifest_sha256,
            reparsed.diagnostics.manifest_sha256,
        )

    def test_explicit_no_connect_is_modeled_and_cannot_be_conflated_with_a_net(self) -> None:
        source = self.payload
        sig_wire = b'''  (wire
    (pts (xy 27.94 25.4) (xy 35.56 25.4))
    (stroke (width 0) (type default))
    (uuid "10000000-0000-4000-8000-000000000204"))
'''
        sig_label = b'''  (label "SIG"
    (at 35.56 25.4 0)
    (effects (font (size 1.27 1.27)))
    (uuid "10000000-0000-4000-8000-000000000302"))
'''
        source = source.replace(sig_wire, b"", 1).replace(
            sig_label,
            b'''  (no_connect
    (at 27.94 25.4)
    (uuid "10000000-0000-4000-8000-000000000501"))
''',
            1,
        )
        self.assertNotEqual(source, self.payload)
        schematic = parse_schematic(source, limits=BundleLimits())
        self.assertEqual(len(schematic.no_connects), 1)
        self.assertEqual({item.name for item in schematic.nets}, {"GND"})

    def test_bus_is_manifested_and_geometry_that_would_require_guessing_fails(self) -> None:
        bus = b'''  (bus
    (pts (xy 5.08 5.08) (xy 12.7 5.08))
    (stroke (width 0) (type default))
    (uuid "10000000-0000-4000-8000-000000000601"))
'''
        reviewed = parse_schematic(
            self.payload.replace(b"  (sheet_instances", bus + b"  (sheet_instances", 1),
            limits=BundleLimits(),
        )
        unsupported = reviewed.diagnostics.unsupported
        self.assertEqual(len(unsupported), 1)
        self.assertEqual(unsupported[0].head, "bus")
        self.assertIn("not flattened", unsupported[0].reason)

        crossing = b'''  (wire
    (pts (xy 19.05 20.32) (xy 19.05 27.94))
    (stroke (width 0) (type default))
    (uuid "10000000-0000-4000-8000-000000000602"))
'''
        with self.assertRaises(ProjectInvariantError):
            parse_schematic(
                self.payload.replace(
                    b"  (sheet_instances", crossing + b"  (sheet_instances", 1
                ),
                limits=BundleLimits(),
            )

    def test_rejects_unreviewed_format_sub_resolution_and_inexact_pin_uuid_map(self) -> None:
        with self.assertRaises(ProjectInvariantError):
            parse_schematic(
                self.payload.replace(b"20260306", b"20270101", 1),
                limits=BundleLimits(),
            )
        with self.assertRaises(ProjectInvariantError):
            parse_schematic(
                self.payload.replace(b"16.51 25.4", b"16.5100001 25.4", 1),
                limits=BundleLimits(),
            )
        missing_pin = self.payload.replace(
            b'    (pin "2" (uuid "10000000-0000-4000-8000-000000000412"))\n',
            b"",
            1,
        )
        with self.assertRaises(ProjectInvariantError):
            parse_schematic(missing_pin, limits=BundleLimits())


if __name__ == "__main__":
    unittest.main()

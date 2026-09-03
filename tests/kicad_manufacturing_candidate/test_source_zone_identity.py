from __future__ import annotations

import hashlib

import pytest

from backend.kicad_manufacturing_candidate.model import CandidateContractError
from backend.kicad_manufacturing_candidate.source_zone_identity import (
    ZONE_IDENTITY_NORMALIZER_ID,
    ZONE_IDENTITY_NORMALIZER_VERSION,
    compare_source_zone_identity,
    source_authored_zone_count,
)

_BUNDLE_SHA256 = "a" * 64
_SOURCE_VOLATILE_PROPERTY = b'''    (property "Datasheet" ""
      (at 0 0 0) (layer "F.Fab") (hide yes)
      (uuid "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    )
'''
_DERIVATIVE_VOLATILE_PROPERTY = b'''    (property "Datasheet" ""
      (at 0 0 0) (layer "F.Fab") (hide yes)
      (uuid "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    )
'''


def _source_board(*, zone_tail: str = "", last_x: str = "4") -> bytes:
    return f'''(kicad_pcb
  (version 20241229)
  (generator flux_clone)
  (generator_version 10.0.0)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (net 0 "")
  (net 1 "GND")
  (footprint "Fixture:X"
    (layer "F.Cu")
    (uuid 11111111-1111-4111-8111-111111111111)
    (at 1 1 270)
    (property "Datasheet" ""
      (at 0 0 0) (layer "F.Fab") (hide yes)
      (uuid "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    )
    (pad "1" smd rect (at 0 0) (size 1 1)
      (layers "F.Cu" "F.Paste" "F.Mask")
      (net 1 "GND")
      (uuid 33333333-3333-4333-8333-333333333333)
    )
  )
  (segment
    (start 1 1) (end 2 1) (width 0.25) (layer "B.Cu")
    (net 1) (uuid 44444444-4444-4444-8444-444444444444)
  )
  (zone
    (net 1)
    (net_name "GND")
    (layer "B.Cu")
    (uuid 22222222-2222-4222-8222-222222222222)
    (hatch edge 0.5)
    (priority 2)
    (connect_pads (clearance 0.2))
    (min_thickness 0.1)
    (polygon (pts (xy 0 0) (xy 0 3) (xy {last_x} 3) (xy {last_x} 0)))
    {zone_tail}
  )
)\n'''.encode()


def _derivative_board(
    *,
    zone_tail: str = "",
    first_x: str = "4",
    segment_end: str = "2",
) -> bytes:
    return f'''(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (embedded_fonts no)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (footprint "Fixture:X"
    (layer "F.Cu")
    (uuid "11111111-1111-4111-8111-111111111111")
    (at 1 1 -90)
    (property "Datasheet" ""
      (at 0 0 0) (layer "F.Fab") (hide yes)
      (uuid "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    )
    (duplicate_pad_numbers_are_jumpers no)
    (embedded_fonts no)
    (pad "1" smd rect (at 0 0) (size 1 1)
      (layers "F.Mask" "F.Paste" "F.Cu")
      (net "GND")
      (uuid "33333333-3333-4333-8333-333333333333")
    )
  )
  (segment
    (start 1 1) (end {segment_end} 1) (width 0.25) (layer "B.Cu")
    (net "GND") (uuid "44444444-4444-4444-8444-444444444444")
  )
  (zone
    (net "GND")
    (layer "B.Cu")
    (uuid "22222222-2222-4222-8222-222222222222")
    (hatch edge 0.5)
    (priority 2)
    (connect_pads (clearance 0.2))
    (min_thickness 0.1)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width .5) (island_removal_mode 0))
    (polygon (pts (xy {first_x} 0) (xy {first_x} 3) (xy 0 3) (xy 0 0)))
    (filled_polygon
      (layer "B.Cu")
      (pts (xy 0.1 0.1) (xy 0.1 2.9) (xy 3.9 2.9) (xy 3.9 0.1))
    )
    {zone_tail}
  )
)\n'''.encode()


def test_exact_source_zone_identity_binds_source_derivative_and_geometry() -> None:
    source = _source_board()
    derivative = _derivative_board()

    evidence = compare_source_zone_identity(
        source,
        derivative,
        source_bundle_sha256=_BUNDLE_SHA256,
    )

    assert evidence.schema_version == 1
    assert evidence.normalizer_id == ZONE_IDENTITY_NORMALIZER_ID
    assert evidence.normalizer_version == ZONE_IDENTITY_NORMALIZER_VERSION
    assert evidence.source_bundle_sha256 == _BUNDLE_SHA256
    assert evidence.source_board_sha256 == hashlib.sha256(source).hexdigest()
    assert evidence.derivative_board_sha256 == hashlib.sha256(derivative).hexdigest()
    assert evidence.zone_count == 1
    assert evidence.generated_fill_node_count == 1
    assert evidence.volatile_property_uuid_count == 1
    zone = evidence.zones[0]
    assert zone.zone_uuid == "22222222-2222-4222-8222-222222222222"
    assert zone.net_name == "GND"
    assert zone.layer == "B.Cu"
    assert zone.normalized_outline_nm == (
        (0, 0),
        (0, 3_000_000),
        (4_000_000, 3_000_000),
        (4_000_000, 0),
    )


@pytest.mark.parametrize(
    ("source", "derivative", "message"),
    (
        (_source_board(last_x="4.1"), _derivative_board(), "authored zone intent"),
        (_source_board(), _derivative_board(first_x="4.1"), "authored zone intent"),
        (_source_board(), _derivative_board(segment_end="2.1"), "board semantics"),
        (
            _source_board(),
            _derivative_board(zone_tail="(keepout (tracks not_allowed))"),
            "authored zone intent",
        ),
    ),
)
def test_authored_zone_or_nonfill_board_mutation_is_rejected(
    source: bytes,
    derivative: bytes,
    message: str,
) -> None:
    with pytest.raises(CandidateContractError, match=message):
        compare_source_zone_identity(
            source,
            derivative,
            source_bundle_sha256=_BUNDLE_SHA256,
        )


@pytest.mark.parametrize(
    ("derivative", "message"),
    (
        (
            _derivative_board().replace(
                b"22222222-2222-4222-8222-222222222222",
                b"55555555-5555-4555-8555-555555555555",
            ),
            "authored zone intent",
        ),
        (
            _derivative_board().replace(b'(net "GND")', b'(net "VCC")'),
            "authored zone intent",
        ),
        (
            _derivative_board().replace(b'(layer "B.Cu")', b'(layer "F.Cu")'),
            "authored zone intent",
        ),
    ),
)
def test_authored_zone_identity_fields_cannot_be_mutated(
    derivative: bytes,
    message: str,
) -> None:
    with pytest.raises(CandidateContractError, match=message):
        compare_source_zone_identity(
            _source_board(), derivative, source_bundle_sha256=_BUNDLE_SHA256
        )


def test_generated_fill_geometry_is_not_mistaken_for_authored_zone_intent() -> None:
    evidence = compare_source_zone_identity(
        _source_board(),
        _derivative_board().replace(b"(xy 3.9 0.1)", b"(xy 3.8 0.1)"),
        source_bundle_sha256=_BUNDLE_SHA256,
    )
    assert evidence.generated_fill_node_count == 1


def test_kicad_default_tenting_rewrite_is_not_mistaken_for_authored_intent() -> None:
    source = _source_board().replace(
        b'  (net 0 "")', b'  (setup (tenting front back))\n  (net 0 "")'
    )
    derivative = _derivative_board().replace(
        b'  (footprint',
        b'  (setup (tenting (front yes) (back yes)))\n  (footprint',
    )
    evidence = compare_source_zone_identity(
        source, derivative, source_bundle_sha256=_BUNDLE_SHA256
    )
    assert evidence.zone_count == 1


def test_derivative_fill_setting_mutation_is_not_hidden_as_generated_copper() -> None:
    derivative = _derivative_board().replace(b"(thermal_gap 0.5)", b"(thermal_gap 0.6)")
    with pytest.raises(CandidateContractError, match="authored zone intent"):
        compare_source_zone_identity(
            _source_board(),
            derivative,
            source_bundle_sha256=_BUNDLE_SHA256,
        )


def test_source_generated_fill_and_unfilled_derivative_are_rejected() -> None:
    with pytest.raises(CandidateContractError, match="source board contains generated"):
        compare_source_zone_identity(
            _source_board(
                zone_tail='(filled_polygon (layer "B.Cu") '
                '(pts (xy 0 0) (xy 0 1) (xy 1 1)))'
            ),
            _derivative_board(),
            source_bundle_sha256=_BUNDLE_SHA256,
        )
    derivative = _derivative_board().replace(
        b'''    (filled_polygon
      (layer "B.Cu")
      (pts (xy 0.1 0.1) (xy 0.1 2.9) (xy 3.9 2.9) (xy 3.9 0.1))
    )
''',
        b"",
    )
    with pytest.raises(CandidateContractError, match="no generated zone fill"):
        compare_source_zone_identity(
            _source_board(),
            derivative,
            source_bundle_sha256=_BUNDLE_SHA256,
        )


def test_source_bundle_hash_is_closed_and_exact() -> None:
    with pytest.raises(CandidateContractError, match="source bundle hash"):
        compare_source_zone_identity(
            _source_board(),
            _derivative_board(),
            source_bundle_sha256="A" * 64,
        )


def test_kicad_injected_empty_property_is_narrowly_nonsemantic() -> None:
    source = _source_board().replace(_SOURCE_VOLATILE_PROPERTY, b"")
    evidence = compare_source_zone_identity(
        source,
        _derivative_board(),
        source_bundle_sha256=_BUNDLE_SHA256,
    )
    assert evidence.volatile_property_uuid_count == 1

    derivative_without_source_property = _derivative_board().replace(
        _DERIVATIVE_VOLATILE_PROPERTY, b""
    )
    with pytest.raises(CandidateContractError, match="volatile property disappeared"):
        compare_source_zone_identity(
            _source_board(),
            derivative_without_source_property,
            source_bundle_sha256=_BUNDLE_SHA256,
        )


def test_nonempty_hidden_provenance_value_allows_uuid_rewrite_but_rejects_tamper() -> None:
    value = b"urn:sha256:" + b"a" * 64
    property_prefix = b'(property "Datasheet" "'
    source = _source_board().replace(property_prefix + b'"', property_prefix + value + b'"')
    derivative = _derivative_board().replace(
        property_prefix + b'"', property_prefix + value + b'"'
    )
    evidence = compare_source_zone_identity(
        source,
        derivative,
        source_bundle_sha256=_BUNDLE_SHA256,
    )
    assert evidence.volatile_property_uuid_count == 1

    with pytest.raises(CandidateContractError, match="board semantics"):
        compare_source_zone_identity(
            source,
            derivative.replace(value, b"urn:sha256:" + b"b" * 64),
            source_bundle_sha256=_BUNDLE_SHA256,
        )


def test_source_authored_zone_count_returns_exact_zero_or_validated_count() -> None:
    no_zone = b'''(kicad_pcb
  (version 20241229)
  (generator flux_clone)
  (generator_version 10.0.0)
)\n'''
    assert source_authored_zone_count(no_zone) == 0
    assert source_authored_zone_count(_source_board()) == 1
    with pytest.raises(CandidateContractError, match="source board contains generated"):
        source_authored_zone_count(
            _source_board(
                zone_tail='(filled_polygon (layer "B.Cu") '
                '(pts (xy 0 0) (xy 0 1) (xy 1 1)))'
            )
        )

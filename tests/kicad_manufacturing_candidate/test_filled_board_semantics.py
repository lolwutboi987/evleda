from __future__ import annotations

import hashlib

import pytest

from backend.kicad_manufacturing_candidate import analyze_filled_board
from backend.kicad_manufacturing_candidate.model import CandidateContractError


def _board(
    datasheet_uuid: str,
    description_uuid: str,
    *,
    last_x: str = "1",
    footprint_uuid: str = "11111111-1111-4111-8111-111111111111",
    datasheet_value: str = "",
) -> bytes:
    return f'''(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0.6")
  (footprint "Fixture:X"
    (uuid "{footprint_uuid}")
    (property "Datasheet" "{datasheet_value}"
      (at 0 0 0)
      (layer "F.Fab")
      (hide yes)
      (uuid "{datasheet_uuid}")
    )
    (property "Description" ""
      (at 0 0 0)
      (layer "F.Fab")
      (hide yes)
      (uuid "{description_uuid}")
    )
  )
  (zone
    (net "GND")
    (layer "B.Cu")
    (uuid "22222222-2222-4222-8222-222222222222")
    (filled_polygon
      (layer "B.Cu")
      (pts (xy 0 0) (xy 0 1) (xy 1 1) (xy {last_x} 0))
    )
  )
)\n'''.encode()


def test_exact_kicad10_hidden_property_uuid_rewrite_is_explicitly_nonsemantic() -> None:
    first_payload = _board(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    )
    second_payload = _board(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    )
    first = analyze_filled_board(first_payload)
    second = analyze_filled_board(second_payload)

    assert first.raw_board_sha256 != second.raw_board_sha256
    assert first.raw_board_sha256 == hashlib.sha256(first_payload).hexdigest()
    assert first.normalized_semantic_sha256 == second.normalized_semantic_sha256
    assert first.volatile_property_uuid_count == second.volatile_property_uuid_count == 2
    assert first.volatile_property_paths_sha256 == second.volatile_property_paths_sha256
    assert first.filled_polygons == second.filled_polygons
    assert first.filled_copper_geometry_sha256 == second.filled_copper_geometry_sha256
    assert first.zone_count == first.filled_polygon_count == 1
    assert first.filled_vertex_count == 4
    assert first.filled_area2_nm2 == 2_000_000_000_000


def test_copper_or_nonvolatile_identity_change_remains_semantic() -> None:
    base = analyze_filled_board(
        _board(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        )
    )
    changed_copper = analyze_filled_board(
        _board(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            last_x="2",
        )
    )
    changed_identity = analyze_filled_board(
        _board(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            footprint_uuid="33333333-3333-4333-8333-333333333333",
        )
    )

    assert base.filled_copper_geometry_sha256 != changed_copper.filled_copper_geometry_sha256
    assert base.normalized_semantic_sha256 != changed_copper.normalized_semantic_sha256
    assert base.normalized_semantic_sha256 != changed_identity.normalized_semantic_sha256


def test_nonempty_hidden_provenance_value_is_preserved_while_uuid_is_normalized() -> None:
    value = "urn:sha256:" + "a" * 64
    first = analyze_filled_board(
        _board(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            datasheet_value=value,
        )
    )
    second = analyze_filled_board(
        _board(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            datasheet_value=value,
        )
    )

    assert first.raw_board_sha256 != second.raw_board_sha256
    assert first.normalized_semantic_sha256 == second.normalized_semantic_sha256


def test_nonempty_hidden_provenance_value_tamper_remains_semantic() -> None:
    first = analyze_filled_board(
        _board(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            datasheet_value="urn:sha256:" + "a" * 64,
        )
    )
    changed = analyze_filled_board(
        _board(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            datasheet_value="urn:sha256:" + "b" * 64,
        )
    )

    assert first.normalized_semantic_sha256 != changed.normalized_semantic_sha256


@pytest.mark.parametrize("value", (" leading", "trailing ", "x" * 4097))
def test_nonempty_hidden_provenance_value_must_be_canonical_and_bounded(value: str) -> None:
    with pytest.raises(CandidateContractError, match="property value"):
        analyze_filled_board(
            _board(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                datasheet_value=value,
            )
        )

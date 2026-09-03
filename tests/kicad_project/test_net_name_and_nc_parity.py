from __future__ import annotations

from pathlib import Path

import pytest

from backend.kicad_project import (
    ProjectBundleInput,
    ProjectInvariantError,
    import_project_bundle,
    round_trip_project_bundle,
)

PROJECT_FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad_project"
PCB_FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad"

_PROJECT = (PROJECT_FIXTURES / "supported_project.kicad_pro").read_bytes()
_SCHEMATIC = (PROJECT_FIXTURES / "supported_project.kicad_sch").read_bytes()
_BOARD = (PCB_FIXTURES / "supported_board.kicad_pcb").read_bytes()
_AUTO_NAME = b"unconnected-(U1-OUT-Pad2)"

_SIG_WIRE = b'''  (wire
    (pts (xy 27.94 25.4) (xy 35.56 25.4))
    (stroke (width 0) (type default))
    (uuid "10000000-0000-4000-8000-000000000204"))
'''
_SIG_LABEL = b'''  (label "SIG"
    (at 35.56 25.4 0)
    (effects (font (size 1.27 1.27)))
    (uuid "10000000-0000-4000-8000-000000000302"))
'''
_NC_MARKER = b'''  (no_connect
    (at 27.94 25.4)
    (uuid "10000000-0000-4000-8000-000000000303"))
'''
_SEGMENT_ONE = b'''  (segment
    (start 11 10)
    (end 18 10)
    (width 0.25)
    (layer "F.Cu")
    (net 2)
    (uuid 00000000-0000-4000-8000-000000000401))
'''
_SEGMENT_TWO = b'''  (segment
    (start 18 10)
    (end 25 10)
    (width 0.25)
    (layer "B.Cu")
    (net 2)
    (uuid 00000000-0000-4000-8000-000000000402))
'''
_VIA = b'''  (via
    (at 18 10)
    (size 0.8)
    (drill 0.4)
    (layers "F.Cu" "B.Cu")
    (net 2)
    (uuid 00000000-0000-4000-8000-000000000501))
'''


def _source(*, schematic: bytes = _SCHEMATIC, board: bytes = _BOARD) -> ProjectBundleInput:
    return ProjectBundleInput("supported_project", _PROJECT, schematic, board)


def _nc_source() -> ProjectBundleInput:
    schematic = _SCHEMATIC.replace(_SIG_WIRE, b"").replace(_SIG_LABEL, b"")
    insertion = b'''  (symbol
    (lib_id "Sensor:Deterministic_SMD")'''
    assert schematic.count(insertion) == 1
    schematic = schematic.replace(insertion, _NC_MARKER + insertion, 1)

    board = _BOARD.replace(b'"SIG"', b'"' + _AUTO_NAME + b'"')
    for copper in (_SEGMENT_ONE, _SEGMENT_TWO, _VIA):
        assert board.count(copper) == 1
        board = board.replace(copper, b"")
    return _source(schematic=schematic, board=board)


def test_root_local_name_accepts_exact_canonical_kicad_qualification() -> None:
    source = _source(board=_BOARD.replace(b'"SIG"', b'"/SIG"'))
    imported = import_project_bundle(source)

    # Raw KiCad identity is retained in the board IR; normalization exists only
    # in the fail-closed cross-artifact comparison view.
    assert "/SIG" in {item.name for item in imported.bundle.board.nets}
    assert "SIG" in {item.name for item in imported.bundle.schematic.nets}


def test_unqualified_root_local_name_is_a_legacy_compatibility_form() -> None:
    # The hand-authored shared fixture predates canonical KiCad `/NAME` output.
    # Exact raw NAME remains accepted, but it is not rewritten in the board IR.
    imported = import_project_bundle(_source())
    assert "SIG" in {item.name for item in imported.bundle.board.nets}


def test_global_name_does_not_admit_root_local_slash_mapping() -> None:
    with pytest.raises(ProjectInvariantError, match="does not exactly identify"):
        import_project_bundle(_source(board=_BOARD.replace(b'"GND"', b'"/GND"')))


def _schematic_with_mixed_gnd_labels() -> bytes:
    local = b'''  (label "GND"
    (at 16.51 25.4 0)
    (effects (font (size 1.27 1.27)))
    (uuid "10000000-0000-4000-8000-000000000304"))
'''
    assert _SCHEMATIC.count(_SIG_LABEL) == 1
    return _SCHEMATIC.replace(_SIG_LABEL, local + _SIG_LABEL, 1)


def test_mixed_local_and_global_labels_keep_exact_global_board_name() -> None:
    imported = import_project_bundle(_source(schematic=_schematic_with_mixed_gnd_labels()))
    assert "GND" in {item.name for item in imported.bundle.board.nets}


def test_mixed_local_and_global_labels_do_not_admit_prefixed_name() -> None:
    board = _BOARD.replace(b'"GND"', b'"/GND"')
    with pytest.raises(ProjectInvariantError, match="does not exactly identify"):
        import_project_bundle(
            _source(schematic=_schematic_with_mixed_gnd_labels(), board=board)
        )


def test_literal_slash_in_local_label_is_preserved_not_blindly_stripped() -> None:
    schematic = _SCHEMATIC.replace(b'(label "SIG"', b'(label "/SIG"', 1)
    board = _BOARD.replace(b'"SIG"', b'"//SIG"')
    imported = import_project_bundle(_source(schematic=schematic, board=board))
    assert "//SIG" in {item.name for item in imported.bundle.board.nets}
    assert "/SIG" in {item.name for item in imported.bundle.schematic.nets}


def test_raw_and_prefixed_board_populations_cannot_claim_one_local_net() -> None:
    board = _BOARD.replace(b'  (net 2 "SIG")', b'  (net 2 "SIG")\n  (net 3 "/SIG")', 1)
    with pytest.raises(ProjectInvariantError, match="raw-name/root-local aliases collide"):
        import_project_bundle(_source(board=board))


def test_aliases_cannot_collide_across_distinct_schematic_nets() -> None:
    # Global literal `/SIG` collides with the canonical root-local alias of SIG.
    schematic = _SCHEMATIC.replace(
        b'(global_label "GND"', b'(global_label "/SIG"', 1
    )
    board = _BOARD.replace(b'"GND"', b'"/SIG"')
    with pytest.raises(ProjectInvariantError, match="aliases collide across distinct nets"):
        import_project_bundle(_source(schematic=schematic, board=board))


def test_exact_unrouted_auto_net_is_logical_none_only_for_explicit_nc_pin() -> None:
    imported = import_project_bundle(_nc_source())
    board_nets = {item.name for item in imported.bundle.board.nets}
    assert _AUTO_NAME.decode("ascii") in board_nets
    assert len(imported.bundle.schematic.no_connects) == 1


def test_root_local_and_proven_nc_semantics_survive_deterministic_round_trip() -> None:
    source = _nc_source()
    parity = round_trip_project_bundle(source)
    assert parity.evidence.semantic_parity
    assert (
        parity.imported.bundle.normalized_ir_sha256
        == parity.reparsed.bundle.normalized_ir_sha256
    )


def test_auto_net_uses_native_short_form_when_pin_name_equals_number() -> None:
    source = _nc_source()
    schematic = source.schematic_payload.replace(b'(name "OUT"', b'(name "2"', 1)
    board = source.board_payload.replace(_AUTO_NAME, b"unconnected-(U1-Pad2)").replace(
        b'(pinfunction "OUT")', b'(pinfunction "2")', 1
    )
    imported = import_project_bundle(_source(schematic=schematic, board=board))
    assert "unconnected-(U1-Pad2)" in {item.name for item in imported.bundle.board.nets}


@pytest.mark.parametrize("empty_pin_function", (b"", b'      (pinfunction "")\n'))
def test_auto_net_uses_native_short_form_for_unnamed_pin(
    empty_pin_function: bytes,
) -> None:
    source = _nc_source()
    schematic = source.schematic_payload.replace(b'(name "OUT"', b'(name ""', 1)
    board = source.board_payload.replace(_AUTO_NAME, b"unconnected-(U1-Pad2)").replace(
        b'      (pinfunction "OUT")\n', empty_pin_function, 1
    )
    imported = import_project_bundle(_source(schematic=schematic, board=board))
    assert "unconnected-(U1-Pad2)" in {item.name for item in imported.bundle.board.nets}


def test_auto_net_rejects_named_long_form_when_native_short_form_is_required() -> None:
    source = _nc_source()
    schematic = source.schematic_payload.replace(b'(name "OUT"', b'(name "2"', 1)
    board = source.board_payload.replace(_AUTO_NAME, b"unconnected-(U1-2-Pad2)").replace(
        b'(pinfunction "OUT")', b'(pinfunction "2")', 1
    )
    with pytest.raises(ProjectInvariantError, match="auto-net name mismatch"):
        import_project_bundle(_source(schematic=schematic, board=board))


@pytest.mark.parametrize(
    "wrong_name",
    (
        b"unconnected-(U9-OUT-Pad2)",
        b"unconnected-(U1-IN-Pad2)",
        b"unconnected-(U1-OUT-Pad9)",
        b"unconnected-(U1-OUT-Pad2)-suffix",
    ),
)
def test_auto_net_rejects_any_reference_pin_name_or_pad_number_drift(
    wrong_name: bytes,
) -> None:
    source = _nc_source()
    board = source.board_payload.replace(_AUTO_NAME, wrong_name)
    with pytest.raises(ProjectInvariantError, match="auto-net name mismatch"):
        import_project_bundle(_source(schematic=source.schematic_payload, board=board))


def test_auto_net_requires_explicit_schematic_nc_marker() -> None:
    source = _nc_source()
    with pytest.raises(ProjectInvariantError, match="lacks an explicit schematic NC marker"):
        import_project_bundle(_source(board=source.board_payload))


def test_auto_net_requires_exact_present_pin_function_metadata() -> None:
    source = _nc_source()
    board = source.board_payload.replace(b'      (pinfunction "OUT")\n', b"", 1)
    with pytest.raises(ProjectInvariantError, match="exact PCB pin-function metadata"):
        import_project_bundle(_source(schematic=source.schematic_payload, board=board))


def test_auto_net_rejects_a_mixed_non_nc_owning_pad() -> None:
    source = _nc_source()
    gnd_claim = b'''      (net 1 "GND")
      (pinfunction "GND")'''
    auto_claim = b'''      (net 2 "unconnected-(U1-OUT-Pad2)")
      (pinfunction "GND")'''
    assert source.board_payload.count(gnd_claim) == 2
    board = source.board_payload.replace(gnd_claim, auto_claim, 1)
    with pytest.raises(ProjectInvariantError, match="lacks an explicit schematic NC marker"):
        import_project_bundle(_source(schematic=source.schematic_payload, board=board))


def test_auto_net_rejects_orphan_declaration_without_owning_pad() -> None:
    source = _nc_source()
    claim = b'      (net 2 "unconnected-(U1-OUT-Pad2)")\n'
    assert source.board_payload.count(claim) == 1
    board = source.board_payload.replace(claim, b"", 1)
    with pytest.raises(ProjectInvariantError, match="requires at least one owning electrical pad"):
        import_project_bundle(_source(schematic=source.schematic_payload, board=board))


@pytest.mark.parametrize("copper", (_SEGMENT_ONE, _VIA))
def test_auto_net_rejects_segment_or_via_ownership(copper: bytes) -> None:
    source = _nc_source()
    board = source.board_payload.replace(b"  (zone\n", copper + b"  (zone\n", 1)
    expected = "routed segments" if copper == _SEGMENT_ONE else "vias"
    with pytest.raises(ProjectInvariantError, match=expected):
        import_project_bundle(_source(schematic=source.schematic_payload, board=board))


def test_auto_net_rejects_zone_ownership() -> None:
    source = _nc_source()
    old = b'''  (zone
    (net 1)
    (net_name "GND")'''
    new = b'''  (zone
    (net 2)
    (net_name "unconnected-(U1-OUT-Pad2)")'''
    assert source.board_payload.count(old) == 1
    board = source.board_payload.replace(old, new, 1)
    with pytest.raises(ProjectInvariantError, match="must not own zones"):
        import_project_bundle(_source(schematic=source.schematic_payload, board=board))


def _board_with_unnumbered_aperture(*, layer: bytes) -> bytes:
    aperture = b'''    (pad "" smd rect
      (at 0 2)
      (size 0.5 0.5)
      (layers "''' + layer + b'''")
      (uuid 00000000-0000-4000-8000-000000000113))
'''
    insertion = b'''    (pad "1" smd roundrect'''
    assert _BOARD.count(insertion) == 1
    return _BOARD.replace(insertion, aperture + insertion, 1)


def test_unnumbered_paste_or_mask_aperture_is_not_a_logical_pin() -> None:
    for layer in (b"F.Paste", b"F.Mask"):
        imported = import_project_bundle(
            _source(board=_board_with_unnumbered_aperture(layer=layer))
        )
        u1 = next(item for item in imported.bundle.board.footprints if item.reference == "U1")
        assert any(not pad.number and pad.layers == (layer.decode("ascii"),) for pad in u1.pads)


def test_unnumbered_copper_pad_cannot_bypass_pin_population_parity() -> None:
    with pytest.raises(ProjectInvariantError, match="unnumbered pad.*cannot carry"):
        import_project_bundle(_source(board=_board_with_unnumbered_aperture(layer=b"F.Cu")))

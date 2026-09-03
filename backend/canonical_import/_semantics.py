"""Shared KiCad source-to-canonical electrical semantics.

This module is deliberately private to the canonical-import boundary.  It is
the single implementation used by both the mapper and the candidate invariant
checker, so a candidate cannot be admitted under looser rules than those used
to construct it.
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.kicad_io import Pad, PadKind, canonical_net_id
from backend.kicad_project import LabelKind, ProjectBundle


@dataclass(frozen=True, slots=True)
class NamespaceIssue:
    code: str
    entity_id: str
    detail: str


@dataclass(frozen=True, slots=True)
class RootSheetNamespaceResolution:
    """One collision-free bijection from raw PCB nets to logical nets."""

    # (raw board net ID, logical schematic net ID, logical schematic name)
    mappings: tuple[tuple[str, str, str], ...]
    issues: tuple[NamespaceIssue, ...]

    @property
    def canonical_net_id_by_board_net_id(self) -> dict[str, str]:
        return {raw_id: logical_id for raw_id, logical_id, _name in self.mappings}

    @property
    def canonical_net_name_by_board_net_id(self) -> dict[str, str]:
        return {raw_id: name for raw_id, _logical_id, name in self.mappings}


def root_sheet_board_net_name(name: str, label_kinds: frozenset[LabelKind]) -> str:
    """Return KiCad's preferred raw PCB name for one root-sheet net."""

    if label_kinds == frozenset({LabelKind.LOCAL}):
        return f"/{name}"
    return name


def root_sheet_board_net_aliases(
    name: str,
    label_kinds: frozenset[LabelKind],
) -> frozenset[str]:
    """Return exact accepted raw names without stripping source slashes.

    KiCad emits ``/NAME`` for a root-sheet local label.  A collision-free raw
    ``NAME`` is also accepted for compatibility with older hand-authored
    fixtures.  Global (and mixed local/global) naming remains exact.  Thus a
    literal local label named ``/NAME`` admits ``/NAME`` and ``//NAME``; no
    prefix is ever blindly removed.
    """

    preferred = root_sheet_board_net_name(name, label_kinds)
    if label_kinds == frozenset({LabelKind.LOCAL}):
        return frozenset((name, preferred))
    return frozenset((preferred,))


def proven_no_connect_board_net_ids(bundle: ProjectBundle) -> frozenset[str]:
    """Return only isolated KiCad auto-nets that exactly encode explicit NCs."""

    schematic = bundle.schematic
    board = bundle.board
    no_connect_positions = {item.position for item in schematic.no_connects}
    expected_by_reference_and_pin = {
        (symbol.reference, pin.number): (pin.name, pin.electrical_type)
        for symbol in schematic.symbols
        for pin in symbol.pins
        if pin.position in no_connect_positions
    }
    pads_by_net_id: dict[str, list[tuple[str, Pad]]] = {}
    for footprint in board.footprints:
        for pad in footprint.pads:
            if pad.kind is not PadKind.NPTH and pad.net_id is not None:
                pads_by_net_id.setdefault(pad.net_id, []).append(
                    (footprint.reference, pad)
                )
    routed_net_ids = {
        *(item.net_id for item in board.segments),
        *(item.net_id for item in board.vias),
        *(item.net_id for item in board.zones),
    }
    proven: set[str] = set()
    for net in board.nets:
        pads = pads_by_net_id.get(net.net_id, ())
        if not pads or net.net_id in routed_net_ids:
            continue
        valid = True
        for reference, pad in pads:
            expected = expected_by_reference_and_pin.get((reference, pad.number))
            if expected is None:
                valid = False
                break
            pin_name, electrical_type = expected
            expected_name = (
                f"unconnected-({reference}-{pin_name}-Pad{pad.number})"
                if pin_name and pin_name != pad.number
                else f"unconnected-({reference}-Pad{pad.number})"
            )
            exact_pin_function = (
                pad.pin_function == pin_name
                if pin_name
                else pad.pin_function in {None, ""}
            )
            if (
                net.name != expected_name
                or not exact_pin_function
                or (pad.pin_type is not None and pad.pin_type != electrical_type)
            ):
                valid = False
                break
        if valid:
            proven.add(net.net_id)
    return frozenset(proven)


def resolve_root_sheet_namespace(
    bundle: ProjectBundle,
    *,
    ignored_board_net_ids: frozenset[str] = frozenset(),
) -> RootSheetNamespaceResolution:
    """Resolve a strict, collision-free raw-PCB/logical-schematic bijection."""

    schematic = bundle.schematic
    board = bundle.board
    issues: list[NamespaceIssue] = []
    labels_by_id = {item.label_id: item for item in schematic.labels}
    alias_owner: dict[str, str] = {}
    aliases_by_net_id: dict[str, frozenset[str]] = {}
    logical_name_by_net_id: dict[str, str] = {}

    for index, net in enumerate(schematic.nets):
        entity_id = f"schematic-net-{index}"
        if net.name is None:
            issues.append(
                NamespaceIssue(
                    "unnamed-schematic-net",
                    entity_id,
                    "every imported connected schematic net must be explicitly named",
                )
            )
            continue
        if net.net_id != canonical_net_id(net.name):
            issues.append(
                NamespaceIssue(
                    "schematic-net-id-parity-mismatch",
                    entity_id,
                    "schematic net ID does not bind its exact logical name",
                )
            )
        labels = tuple(labels_by_id.get(label_id) for label_id in net.label_ids)
        if not labels or any(label is None for label in labels):
            issues.append(
                NamespaceIssue(
                    "schematic-net-label-evidence-missing",
                    entity_id,
                    "a named schematic net requires complete label-kind evidence",
                )
            )
            continue
        if any(label.name != net.name for label in labels if label is not None):
            issues.append(
                NamespaceIssue(
                    "schematic-net-label-name-mismatch",
                    entity_id,
                    "every retained label for a net must carry its exact logical name",
                )
            )
            continue
        label_kinds = frozenset(label.kind for label in labels if label is not None)
        aliases = root_sheet_board_net_aliases(net.name, label_kinds)
        aliases_by_net_id[net.net_id] = aliases
        logical_name_by_net_id[net.net_id] = net.name
        for alias in sorted(aliases):
            previous = alias_owner.get(alias)
            if previous is not None and previous != net.net_id:
                issues.append(
                    NamespaceIssue(
                        "schematic-board-net-alias-collision",
                        entity_id,
                        f"raw PCB net alias {alias!r} is shared by distinct schematic nets",
                    )
                )
            else:
                alias_owner[alias] = net.net_id

    board_by_logical_net_id: dict[str, str] = {}
    mappings: list[tuple[str, str, str]] = []
    for index, net in enumerate(board.nets):
        if net.net_id in ignored_board_net_ids:
            continue
        if net.net_id != canonical_net_id(net.name):
            issues.append(
                NamespaceIssue(
                    "board-net-id-parity-mismatch",
                    f"board-net-{index}",
                    "PCB net ID does not bind its exact raw name",
                )
            )
        logical_net_id = alias_owner.get(net.name)
        if logical_net_id is None:
            issues.append(
                NamespaceIssue(
                    "named-net-population-mismatch",
                    "project-bundle",
                    f"raw PCB net {net.name!r} has no exact schematic namespace owner",
                )
            )
            continue
        previous_board_id = board_by_logical_net_id.get(logical_net_id)
        if previous_board_id is not None and previous_board_id != net.net_id:
            issues.append(
                NamespaceIssue(
                    "schematic-board-net-alias-ambiguous",
                    logical_net_id,
                    "more than one raw PCB net claims the same logical schematic net",
                )
            )
            continue
        board_by_logical_net_id[logical_net_id] = net.net_id
        mappings.append((net.net_id, logical_net_id, logical_name_by_net_id[logical_net_id]))

    missing = set(aliases_by_net_id) - set(board_by_logical_net_id)
    if missing:
        issues.append(
            NamespaceIssue(
                "named-net-population-mismatch",
                "project-bundle",
                "one or more logical schematic nets have no exact raw PCB net owner",
            )
        )
    return RootSheetNamespaceResolution(
        tuple(sorted(mappings)),
        tuple(sorted(set(issues), key=lambda item: (item.code, item.entity_id, item.detail))),
    )


__all__ = (
    "NamespaceIssue",
    "RootSheetNamespaceResolution",
    "proven_no_connect_board_net_ids",
    "resolve_root_sheet_namespace",
    "root_sheet_board_net_aliases",
    "root_sheet_board_net_name",
)

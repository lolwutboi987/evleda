"""Deterministic, side-effect-free canonical mapping for KiCad project IR."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, replace

from backend.design_kernel import (
    CommandKind,
    Component,
    DesignCommand,
    DesignGraph,
    FootprintPad,
    SchematicJunction,
    SchematicWire,
    stable_hash,
)
from backend.design_kernel import (
    PointNm as DesignPoint,
)
from backend.kicad_io import (
    Board,
    CanonicalMappingError,
    ComponentResolver,
    Footprint,
    MappingGap,
    PadKind,
    canonical_net_id,
    to_design_graph,
)
from backend.kicad_io import (
    Pad as SourcePad,
)
from backend.kicad_project import (
    PARSER_ID,
    LabelKind,
    ProjectBundleInput,
    ProjectImportResult,
    SchematicSymbol,
    UnsupportedPolicy,
    import_project_bundle,
)

from ._semantics import (
    proven_no_connect_board_net_ids,
    resolve_root_sheet_namespace,
    root_sheet_board_net_name,
)
from .model import (
    CanonicalImportCandidate,
    CanonicalImportTransactionInput,
    ComponentProvenanceBinding,
    ComponentProvenanceRequest,
    ImportMappingResult,
    MappingIssue,
    SourcePinPadBinding,
    TrustedComponentProvenanceResolver,
    TrustedComponentResolution,
)

_SHA256 = re.compile(r"[0-9a-f]{64}")
_PCB_ONLY_GAPS_RESOLVED_BY_PROJECT = frozenset(
    {
        "net-membership-inferred-from-pcb-pads",
        "pcb-only-schematic-parity-unproven",
    }
)


@dataclass(frozen=True, slots=True)
class _ParityContext:
    symbols_by_reference: dict[str, SchematicSymbol]
    board_net_name_by_id: dict[str, str]
    schematic_net_name_by_pin: dict[tuple[str, str], str]
    schematic_net_id_by_wire: dict[str, str]
    schematic_net_id_by_junction: dict[str, str]
    canonical_board: Board
    proven_no_connect_board_net_ids: frozenset[str]


class _ResolvedAdapter(ComponentResolver):
    def __init__(self, values: dict[str, TrustedComponentResolution]) -> None:
        self._values = values

    def resolve(self, footprint: Footprint) -> Component:
        return self._values[footprint.footprint_id].component


def _issue(code: str, entity_id: str, detail: str) -> MappingIssue:
    return MappingIssue(code, entity_id, detail)


def _sorted_issues(values: list[MappingIssue]) -> tuple[MappingIssue, ...]:
    return tuple(sorted(set(values)))


def _is_canonical_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and value == value.strip()
        and not any(character.isspace() for character in value)
    )


def _root_sheet_board_net_name(name: str, label_kinds: frozenset[LabelKind]) -> str:
    """Return KiCad's PCB namespace for one parsed root-sheet net name.

    The reviewed schematic codec accepts one root sheet. KiCad prefixes a net
    named only by root-sheet local labels with ``/`` on the PCB, while a global
    label keeps its name verbatim. Deliberately do not remove an existing slash:
    it may be source text, and a future hierarchical path must remain exact.
    """

    return root_sheet_board_net_name(name, label_kinds)


def _proven_no_connect_board_net_ids(source: ProjectImportResult) -> set[str]:
    """Identify exact KiCad auto-nets backed by explicit schematic NC markers."""
    return set(proven_no_connect_board_net_ids(source.bundle))


def _result(
    *,
    source_bundle_ir_sha256: str,
    authorized_actor: str,
    candidate: CanonicalImportCandidate | None,
    transaction_input: CanonicalImportTransactionInput | None,
    blockers: list[MappingIssue],
    advisories: list[MappingIssue],
) -> ImportMappingResult:
    return ImportMappingResult._issue(  # pyright: ignore[reportPrivateUsage]
        source_bundle_ir_sha256=source_bundle_ir_sha256,
        authorized_actor=authorized_actor,
        candidate=candidate,
        transaction_input=transaction_input,
        blockers=_sorted_issues(blockers),
        advisories=_sorted_issues(advisories),
    )


def _source_evidence_blockers(
    source: ProjectImportResult,
    source_payload: ProjectBundleInput,
) -> list[MappingIssue]:
    bundle = source.bundle
    evidence = source.evidence
    expected = {
        "project_ir_sha256": bundle.manifest.normalized_ir_sha256,
        "schematic_ir_sha256": bundle.schematic.normalized_ir_sha256,
        "board_ir_sha256": bundle.board.normalized_ir_sha256,
        "bundle_ir_sha256": bundle.normalized_ir_sha256,
        "diagnostics_manifest_sha256": bundle.diagnostics.manifest_sha256,
    }
    blockers: list[MappingIssue] = []
    raw_sources = (
        (
            "project-source",
            hashlib.sha256(source_payload.project_payload).hexdigest(),
            evidence.project_source_sha256,
        ),
        (
            "schematic-source",
            hashlib.sha256(source_payload.schematic_payload).hexdigest(),
            evidence.schematic_source_sha256,
        ),
        (
            "board-source",
            hashlib.sha256(source_payload.board_payload).hexdigest(),
            evidence.board_source_sha256,
        ),
    )
    for entity_id, actual_digest, evidence_digest in raw_sources:
        if actual_digest != evidence_digest:
            blockers.append(
                _issue(
                    "raw-source-digest-mismatch",
                    entity_id,
                    "exact source bytes do not match their import evidence digest",
                )
            )
    if source_payload.stem != bundle.stem:
        blockers.append(
            _issue(
                "raw-source-stem-mismatch",
                "project-bundle",
                "raw project-bundle stem does not match the normalized bundle",
            )
        )
    try:
        reparsed = import_project_bundle(
            source_payload,
            unsupported_policy=UnsupportedPolicy.MANIFEST,
        )
    except Exception:
        blockers.append(
            _issue(
                "raw-source-reparse-failed",
                "project-bundle",
                "exact source bytes cannot be deterministically reparsed",
            )
        )
    else:
        if reparsed.bundle != bundle:
            blockers.append(
                _issue(
                    "raw-source-bundle-mismatch",
                    "project-bundle",
                    "exact source bytes do not reproduce the supplied normalized bundle",
                )
            )
        if reparsed.evidence != evidence:
            blockers.append(
                _issue(
                    "raw-source-evidence-mismatch",
                    "project-bundle",
                    "exact source bytes do not reproduce the supplied import evidence",
                )
            )
    for field_name, expected_digest in expected.items():
        if getattr(evidence, field_name) != expected_digest:
            blockers.append(
                _issue(
                    "source-evidence-mismatch",
                    field_name,
                    "import evidence does not bind the supplied normalized project bundle",
                )
            )
    if evidence.parser_id != PARSER_ID:
        blockers.append(
            _issue(
                "untrusted-parser-id",
                "project-bundle",
                "canonical mapping accepts only the reviewed project-bundle parser identity",
            )
        )
    if (
        evidence.kicad_execution != "not-run"
        or evidence.manufacturing_release_eligible is not False
    ):
        blockers.append(
            _issue(
                "invalid-codec-truth-claim",
                "project-bundle",
                "codec import evidence must not claim KiCad execution or manufacturing release",
            )
        )
    return blockers


def _unsupported_blockers(source: ProjectImportResult) -> list[MappingIssue]:
    return [
        _issue(
            "unsupported-source-construct",
            f"diagnostic-{diagnostic.payload_sha256[:16]}",
            f"{diagnostic.path}: {diagnostic.reason}",
        )
        for diagnostic in source.bundle.diagnostics.unsupported
    ]


def _is_logical_electrical_pad(pad: SourcePad) -> bool:
    """Exclude NPTH and source-only mask/paste aperture records."""

    return pad.kind is not PadKind.NPTH and bool(pad.number)


def _explicit_no_connect_pin_keys(
    source: ProjectImportResult,
) -> tuple[frozenset[tuple[str, str]], frozenset[tuple[str, str]]]:
    positions = {item.position for item in source.bundle.schematic.no_connects}
    by_symbol = frozenset(
        (symbol.symbol_id, pin.number)
        for symbol in source.bundle.schematic.symbols
        for pin in symbol.pins
        if pin.position in positions
    )
    by_reference = frozenset(
        (symbol.reference, pin.number)
        for symbol in source.bundle.schematic.symbols
        for pin in symbol.pins
        if pin.position in positions
    )
    return by_symbol, by_reference


def _canonicalized_board(
    source: ProjectImportResult,
    *,
    canonical_net_id_by_board_net_id: dict[str, str],
    canonical_net_name_by_board_net_id: dict[str, str],
    proven_no_connect_ids: frozenset[str],
) -> Board:
    """Build an in-memory logical view without mutating retained source IR."""

    board = source.bundle.board
    def mapped_net_id(raw_net_id: str | None) -> str | None:
        if raw_net_id is None or raw_net_id in proven_no_connect_ids:
            return None
        return canonical_net_id_by_board_net_id[raw_net_id]

    footprints = tuple(
        replace(
            footprint,
            pads=tuple(
                replace(
                    pad,
                    net_id=mapped_net_id(pad.net_id),
                )
                for pad in footprint.pads
                if pad.kind is PadKind.NPTH or _is_logical_electrical_pad(pad)
            ),
        )
        for footprint in board.footprints
    )
    return replace(
        board,
        nets=tuple(
            replace(
                net,
                net_id=canonical_net_id_by_board_net_id[net.net_id],
                name=canonical_net_name_by_board_net_id[net.net_id],
            )
            for net in board.nets
            if net.net_id not in proven_no_connect_ids
        ),
        footprints=footprints,
        segments=tuple(
            replace(
                segment,
                net_id=canonical_net_id_by_board_net_id[segment.net_id],
            )
            for segment in board.segments
        ),
        vias=tuple(
            replace(via, net_id=canonical_net_id_by_board_net_id[via.net_id])
            for via in board.vias
        ),
        zones=tuple(
            replace(
                zone,
                net_id=canonical_net_id_by_board_net_id[zone.net_id],
                net_name=canonical_net_name_by_board_net_id[zone.net_id],
            )
            for zone in board.zones
        ),
    ).normalized()


def _parity_context(
    source: ProjectImportResult,
) -> tuple[_ParityContext | None, list[MappingIssue]]:
    bundle = source.bundle
    schematic = bundle.schematic
    board = bundle.board
    blockers: list[MappingIssue] = []

    for index, layer in enumerate(board.layers):
        if not layer.name.strip():
            blockers.append(
                _issue(
                    "board-layer-name-unrepresentable",
                    f"board-layer-{index}",
                    "board layer names must contain non-whitespace canonical text",
                )
            )

    symbols_by_reference: dict[str, SchematicSymbol] = {}
    for symbol in schematic.symbols:
        if symbol.reference in symbols_by_reference:
            blockers.append(
                _issue(
                    "duplicate-schematic-reference",
                    symbol.symbol_id,
                    "schematic component references must be unique",
                )
            )
        symbols_by_reference[symbol.reference] = symbol
    footprints_by_reference = {item.reference: item for item in board.footprints}
    if set(symbols_by_reference) != set(footprints_by_reference):
        blockers.append(
            _issue(
                "reference-population-mismatch",
                "project-bundle",
                "schematic symbols and PCB footprints must have the same exact references",
            )
        )

    board_net_name_by_id = {item.net_id: item.name for item in board.nets}
    for index, net in enumerate(board.nets):
        if not _is_canonical_id(net.net_id):
            blockers.append(
                _issue(
                    "board-net-id-unrepresentable",
                    f"board-net-{index}",
                    "PCB canonical net IDs must be whitespace-free graph identifiers",
                )
            )
        if not net.name.strip():
            blockers.append(
                _issue(
                    "board-net-name-unrepresentable",
                    f"board-net-{index}",
                    "PCB named nets must contain non-whitespace canonical text",
                )
            )
    schematic_net_name_by_pin: dict[tuple[str, str], str] = {}
    schematic_net_id_by_wire: dict[str, str] = {}
    schematic_net_id_by_junction: dict[str, str] = {}
    seen_schematic_net_ids: set[str] = set()
    seen_schematic_net_names: set[str] = set()
    for net_index, net in enumerate(schematic.nets):
        net_entity = f"schematic-net-{net_index}"
        if not _is_canonical_id(net.net_id):
            blockers.append(
                _issue(
                    "schematic-net-id-unrepresentable",
                    net_entity,
                    "schematic net IDs must be whitespace-free graph identifiers",
                )
            )
        if net.net_id in seen_schematic_net_ids:
            blockers.append(
                _issue(
                    "duplicate-schematic-net-id",
                    net_entity,
                    "schematic net IDs must be unique",
                )
            )
        seen_schematic_net_ids.add(net.net_id)
        if net.name is None:
            blockers.append(
                _issue(
                    "unnamed-schematic-net",
                    net_entity,
                    "every imported connected schematic net must be explicitly named",
                )
            )
            continue
        if not net.name.strip():
            blockers.append(
                _issue(
                    "schematic-net-name-unrepresentable",
                    net_entity,
                    "schematic named nets must contain non-whitespace canonical text",
                )
            )
        if net.name in seen_schematic_net_names:
            blockers.append(
                _issue(
                    "duplicate-schematic-net-name",
                    net_entity,
                    "schematic named-net records must be unique before canonical mapping",
                )
            )
        seen_schematic_net_names.add(net.name)
        for pin_ref in net.pin_refs:
            key = (pin_ref.symbol_id, pin_ref.pin_number)
            if key in schematic_net_name_by_pin:
                blockers.append(
                    _issue(
                        "schematic-pin-multiple-nets",
                        pin_ref.pin_id,
                        "one schematic pin cannot belong to multiple named nets",
                    )
                )
            schematic_net_name_by_pin[key] = net.name
        for wire_id in net.wire_ids:
            if wire_id in schematic_net_id_by_wire:
                blockers.append(
                    _issue(
                        "schematic-wire-multiple-nets",
                        wire_id,
                        "one schematic wire cannot belong to multiple nets",
                    )
                )
            schematic_net_id_by_wire[wire_id] = net.net_id
        for junction_id in net.junction_ids:
            if junction_id in schematic_net_id_by_junction:
                blockers.append(
                    _issue(
                        "schematic-junction-multiple-nets",
                        junction_id,
                        "one schematic junction cannot belong to multiple nets",
                    )
                )
            schematic_net_id_by_junction[junction_id] = net.net_id

    proven_no_connect_ids = frozenset(_proven_no_connect_board_net_ids(source))
    namespace = resolve_root_sheet_namespace(
        bundle,
        ignored_board_net_ids=proven_no_connect_ids,
    )
    blockers.extend(_issue(item.code, item.entity_id, item.detail) for item in namespace.issues)
    canonical_net_id_by_board_net_id = namespace.canonical_net_id_by_board_net_id
    canonical_net_name_by_board_net_id = namespace.canonical_net_name_by_board_net_id
    raw_name_by_logical_name = {
        logical_name: board_net_name_by_id[raw_id]
        for raw_id, _logical_id, logical_name in namespace.mappings
    }
    labels_by_id = {item.label_id: item for item in schematic.labels}
    for net_index, net in enumerate(schematic.nets):
        if net.name is None or any(
            label_id not in labels_by_id for label_id in net.label_ids
        ):
            continue
        label_kinds = frozenset(labels_by_id[label_id].kind for label_id in net.label_ids)
        preferred_name = _root_sheet_board_net_name(net.name, label_kinds)
        raw_name = raw_name_by_logical_name.get(net.name)
        if raw_name not in {net.name, preferred_name}:
            blockers.append(
                _issue(
                    "root-sheet-net-namespace-mismatch",
                    f"schematic-net-{net_index}",
                    "raw PCB net name is neither the exact logical nor preferred root name",
                )
            )
    nc_by_symbol, _nc_by_reference = _explicit_no_connect_pin_keys(source)
    missing_wire_ids = {item.wire_id for item in schematic.wires} - set(schematic_net_id_by_wire)
    for wire_id in sorted(missing_wire_ids):
        blockers.append(
            _issue(
                "schematic-wire-net-unresolved",
                wire_id,
                "every schematic wire must map to exactly one named net",
            )
        )
    missing_junction_ids = {item.junction_id for item in schematic.junctions} - set(
        schematic_net_id_by_junction
    )
    for junction_id in sorted(missing_junction_ids):
        blockers.append(
            _issue(
                "schematic-junction-net-unresolved",
                junction_id,
                "every schematic junction must map to exactly one named net",
            )
        )

    for reference in sorted(set(symbols_by_reference) & set(footprints_by_reference)):
        symbol = symbols_by_reference[reference]
        footprint = footprints_by_reference[reference]
        if not _is_canonical_id(reference):
            blockers.append(
                _issue(
                    "component-reference-unrepresentable",
                    symbol.symbol_id,
                    "component references must be whitespace-free graph identifiers",
                )
            )
        if not symbol.value.strip() or not footprint.value.strip():
            blockers.append(
                _issue(
                    "component-value-unrepresentable",
                    symbol.symbol_id,
                    "component values must contain non-whitespace canonical text",
                )
            )
        if not symbol.library_id.strip() or not footprint.library_id.strip():
            blockers.append(
                _issue(
                    "component-library-id-unrepresentable",
                    symbol.symbol_id,
                    "symbol and footprint library identities must contain canonical text",
                )
            )
        if symbol.value != footprint.value:
            blockers.append(
                _issue(
                    "value-parity-mismatch",
                    footprint.footprint_id,
                    "schematic and PCB values must match exactly",
                )
            )
        if symbol.footprint != footprint.library_id:
            blockers.append(
                _issue(
                    "footprint-parity-mismatch",
                    footprint.footprint_id,
                    "schematic and PCB footprint library identities must match exactly",
                )
            )
        pins_by_number = {item.number: item for item in symbol.pins}
        pads_by_number: dict[str, list[SourcePad]] = {}
        for footprint_pad in footprint.pads:
            if _is_logical_electrical_pad(footprint_pad):
                pads_by_number.setdefault(footprint_pad.number, []).append(footprint_pad)
        if not pins_by_number:
            blockers.append(
                _issue(
                    "component-without-pins-unrepresentable",
                    symbol.symbol_id,
                    "canonical components require at least one exact pin-pad binding",
                )
            )
        if set(pins_by_number) != set(pads_by_number):
            blockers.append(
                _issue(
                    "pin-pad-population-mismatch",
                    footprint.footprint_id,
                    "schematic pin and PCB pad numbers must match exactly",
                )
            )
            continue
        for number in sorted(pins_by_number):
            pin = pins_by_number[number]
            pads = pads_by_number[number]
            if not _is_canonical_id(number):
                blockers.append(
                    _issue(
                        "pin-pad-number-unrepresentable",
                        pin.pin_id,
                        "pin and pad numbers must be whitespace-free graph identifiers",
                    )
                )
            if not pin.name.strip():
                blockers.append(
                    _issue(
                        "empty-pin-name-unrepresentable",
                        pin.pin_id,
                        "canonical component provenance requires a non-empty exact pin name",
                    )
                )
            if not _is_canonical_id(pin.electrical_type):
                blockers.append(
                    _issue(
                        "pin-electrical-type-unrepresentable",
                        pin.pin_id,
                        "pin electrical types must be whitespace-free graph identifiers",
                    )
                )
            schematic_name = schematic_net_name_by_pin.get((symbol.symbol_id, number))
            canonical_board_net_ids = {
                (
                    None
                    if pad.net_id is None or pad.net_id in proven_no_connect_ids
                    else canonical_net_id_by_board_net_id.get(pad.net_id)
                )
                for pad in pads
            }
            expected_net_id = (
                None if schematic_name is None else canonical_net_id(schematic_name)
            )
            explicit_nc = (symbol.symbol_id, number) in nc_by_symbol
            if explicit_nc and pin.electrical_type != "no_connect":
                blockers.append(
                    _issue(
                        "schematic-no-connect-pin-type-unrepresented",
                        pin.pin_id,
                        "canonical NC staging requires an exact no_connect pin type",
                    )
                )
            if not explicit_nc and schematic_name is None:
                blockers.append(
                    _issue(
                        "unmarked-schematic-pin-unconnected",
                        pin.pin_id,
                        "a netless source pin requires an explicit no-connect marker",
                    )
                )
            if (
                canonical_board_net_ids != {expected_net_id}
                or (explicit_nc and any(
                    pad.net_id is not None and pad.net_id not in proven_no_connect_ids
                    for pad in pads
                ))
                or (not explicit_nc and schematic_name is None and any(
                    pad.net_id is not None for pad in pads
                ))
            ):
                blockers.append(
                    _issue(
                        "pin-pad-net-parity-mismatch",
                        pads[0].pad_id,
                        "every physical pad for a logical pin must match its "
                        "exact schematic named net",
                    )
                )

    if blockers:
        return None, blockers
    canonical_board = _canonicalized_board(
        source,
        canonical_net_id_by_board_net_id=canonical_net_id_by_board_net_id,
        canonical_net_name_by_board_net_id=canonical_net_name_by_board_net_id,
        proven_no_connect_ids=proven_no_connect_ids,
    )
    return (
        _ParityContext(
            symbols_by_reference,
            board_net_name_by_id,
            schematic_net_name_by_pin,
            schematic_net_id_by_wire,
            schematic_net_id_by_junction,
            canonical_board,
            proven_no_connect_ids,
        ),
        [],
    )


def _provenance_request(
    *,
    source: ProjectImportResult,
    footprint: Footprint,
    symbol: SchematicSymbol,
    context: _ParityContext,
) -> ComponentProvenanceRequest:
    return ComponentProvenanceRequest(
        source.bundle.normalized_ir_sha256,
        footprint.footprint_id,
        footprint.reference,
        footprint.value,
        footprint.library_id,
        symbol.symbol_id,
        symbol.library_id,
        tuple(
            sorted(
                SourcePinPadBinding(
                    pin.number,
                    pin.number,
                    pin.name,
                    pin.electrical_type,
                    context.schematic_net_name_by_pin.get((symbol.symbol_id, pin.number)),
                )
                for pin in symbol.pins
            )
        ),
    )


def _resolution_mismatches(
    request: ComponentProvenanceRequest,
    resolution: TrustedComponentResolution,
) -> list[str]:
    component = resolution.component
    mismatches: list[str] = []
    if resolution.request_sha256 != request.request_sha256:
        mismatches.append("source request digest")
    if component.reference != request.reference:
        mismatches.append("reference")
    if component.value != request.value:
        mismatches.append("value")
    if component.footprint_id != request.footprint_library_id:
        mismatches.append("footprint library identity")
    if component.symbol_id != request.schematic_library_id:
        mismatches.append("symbol library identity")
    expected = {item.pin_number: item for item in request.pins}
    resolved = {item.number: item for item in component.pins}
    if set(expected) != set(resolved):
        mismatches.append("pin population")
    else:
        for number in sorted(expected):
            source_pin = expected[number]
            component_pin = resolved[number]
            if component_pin.pad_number != source_pin.pad_number:
                mismatches.append(f"pin {number} pad mapping")
            if component_pin.name != source_pin.pin_name:
                mismatches.append(f"pin {number} name")
            if component_pin.electrical_type != source_pin.electrical_type:
                mismatches.append(f"pin {number} electrical type")
            if (
                source_pin.electrical_type == "no_connect"
                and source_pin.net_name is None
                and component_pin.required
            ):
                mismatches.append(f"pin {number} no-connect required flag")
    return mismatches


def _resolve_components(
    source: ProjectImportResult,
    context: _ParityContext,
    resolver: TrustedComponentProvenanceResolver,
) -> tuple[
    dict[str, TrustedComponentResolution],
    tuple[ComponentProvenanceBinding, ...],
    list[MappingIssue],
]:
    resolutions: dict[str, TrustedComponentResolution] = {}
    bindings: list[ComponentProvenanceBinding] = []
    blockers: list[MappingIssue] = []
    component_ids: set[str] = set()
    evidence_ids: set[str] = set()
    for footprint in source.bundle.board.normalized().footprints:
        symbol = context.symbols_by_reference[footprint.reference]
        request = _provenance_request(
            source=source,
            footprint=footprint,
            symbol=symbol,
            context=context,
        )
        try:
            resolution = resolver.resolve(request)
        except Exception:
            blockers.append(
                _issue(
                    "component-resolver-failed",
                    footprint.footprint_id,
                    "trusted component resolver failed closed for this source footprint",
                )
            )
            continue
        if resolution is None:
            blockers.append(
                _issue(
                    "component-provenance-unresolved",
                    footprint.footprint_id,
                    "no trusted exact component provenance resolution was returned",
                )
            )
            continue
        if type(resolution) is not TrustedComponentResolution:
            blockers.append(
                _issue(
                    "component-resolution-type-invalid",
                    footprint.footprint_id,
                    "trusted resolver returned an unsupported resolution type",
                )
            )
            continue
        mismatches = _resolution_mismatches(request, resolution)
        if mismatches:
            blockers.append(
                _issue(
                    "component-provenance-parity-mismatch",
                    footprint.footprint_id,
                    "trusted resolution disagrees on " + ", ".join(mismatches),
                )
            )
            continue
        component = resolution.component
        if component.component_id in component_ids:
            blockers.append(
                _issue(
                    "duplicate-resolved-component-id",
                    component.component_id,
                    "each source footprint requires a unique canonical component ID",
                )
            )
            continue
        if resolution.evidence_id in evidence_ids:
            blockers.append(
                _issue(
                    "duplicate-component-evidence-id",
                    resolution.evidence_id,
                    "each source footprint requires a distinct component evidence record",
                )
            )
            continue
        component_ids.add(component.component_id)
        evidence_ids.add(resolution.evidence_id)
        resolutions[footprint.footprint_id] = resolution
        bindings.append(
            ComponentProvenanceBinding(
                source_footprint_id=footprint.footprint_id,
                component_evidence_id=resolution.evidence_id,
                request=request,
                request_sha256=resolution.request_sha256,
                component_id=component.component_id,
                manufacturer_part_number=component.manufacturer_part_number,
                datasheet_sha256=component.datasheet_sha256,
                pin_map_sha256=component.pin_map_sha256,
                symbol_id=component.symbol_id,
                footprint_id=component.footprint_id,
                resolver_id=resolution.resolver_id,
                trust_snapshot_sha256=resolution.trust_snapshot_sha256,
                evidence_sha256=resolution.evidence_sha256,
            )
        )
    return (
        resolutions,
        tuple(
            sorted(
                bindings,
                key=lambda item: (
                    item.source_footprint_id,
                    item.component_evidence_id,
                    item.component_id,
                ),
            )
        ),
        blockers,
    )


def _adapter_issues(
    gaps: tuple[MappingGap, ...],
) -> tuple[list[MappingIssue], list[MappingIssue]]:
    blockers: list[MappingIssue] = []
    advisories: list[MappingIssue] = []
    for gap in gaps:
        if gap.code in _PCB_ONLY_GAPS_RESOLVED_BY_PROJECT:
            continue
        issue = _issue(gap.code, gap.entity_id, gap.detail)
        (blockers if gap.release_blocking else advisories).append(issue)
    return blockers, advisories


def _map_schematic_graph(
    source: ProjectImportResult,
    context: _ParityContext,
    board_graph: DesignGraph,
) -> DesignGraph:
    schematic = source.bundle.schematic
    sheet_id = schematic.schematic_id
    wires = tuple(
        SchematicWire(
            item.wire_id,
            context.schematic_net_id_by_wire[item.wire_id],
            (
                # Conversion is a direct integer-nanometre copy.
                DesignPoint(item.start.x, item.start.y),
                DesignPoint(item.end.x, item.end.y),
            ),
            sheet_id,
            False,
        )
        for item in schematic.wires
    )
    junctions = tuple(
        SchematicJunction(
            item.junction_id,
            context.schematic_net_id_by_junction[item.junction_id],
            DesignPoint(item.position.x, item.position.y),
            sheet_id,
            False,
        )
        for item in schematic.junctions
    )
    return replace(
        board_graph,
        schematic_wires=wires,
        schematic_junctions=junctions,
    ).normalized()


def _schematic_retention_issues(
    source: ProjectImportResult,
) -> tuple[list[MappingIssue], list[MappingIssue]]:
    schematic = source.bundle.schematic
    blockers: list[MappingIssue] = []
    advisories: list[MappingIssue] = []
    if schematic.no_connects:
        advisories.append(
            _issue(
                "schematic-no-connect-syntax-source-retained",
                schematic.schematic_id,
                "proven NC connectivity is canonical; marker UUIDs remain source-bound",
            )
        )
    for footprint in source.bundle.board.footprints:
        for pad in footprint.pads:
            if pad.kind is not PadKind.NPTH and not _is_logical_electrical_pad(pad):
                blockers.append(
                    _issue(
                        "non-electrical-aperture-pad-source-retained",
                        pad.pad_id,
                        "mask/paste-only aperture pad geometry is retained in source IR only",
                    )
                )
    if schematic.symbols:
        advisories.append(
            _issue(
                "schematic-symbol-presentation-source-retained",
                schematic.schematic_id,
                "symbol instance positions and presentation remain bound in the source bundle",
            )
        )
    if schematic.labels:
        advisories.append(
            _issue(
                "schematic-label-syntax-source-retained",
                schematic.schematic_id,
                "label syntax and positions remain source-bound after named-net mapping",
            )
        )
    if schematic.wires:
        advisories.append(
            _issue(
                "schematic-wire-style-source-retained",
                schematic.schematic_id,
                "wire width and stroke style remain bound in the source bundle",
            )
        )
    if schematic.junctions:
        advisories.append(
            _issue(
                "schematic-junction-style-source-retained",
                schematic.schematic_id,
                "junction diameter and color remain bound in the source bundle",
            )
        )
    if source.bundle.diagnostics.constructs:
        advisories.append(
            _issue(
                "project-diagnostics-source-retained",
                "project-bundle",
                "preserved project syntax remains bound by the diagnostics manifest",
            )
        )
    return blockers, advisories


def _payloads_for_graph(graph: DesignGraph) -> list[tuple[CommandKind, dict[str, object]]]:
    payloads: list[tuple[CommandKind, dict[str, object]]] = []
    if graph.board_outline:
        payloads.append(
            (
                CommandKind.BOARD_SET_OUTLINE,
                {"vertices": [[item.x, item.y] for item in graph.board_outline]},
            )
        )
    for item in graph.components:
        payloads.append(
            (
                CommandKind.COMPONENT_ADD,
                {
                    "component_id": item.component_id,
                    "reference": item.reference,
                    "value": item.value,
                    "manufacturer_part_number": item.manufacturer_part_number,
                    "package": item.package,
                    "symbol_id": item.symbol_id,
                    "footprint_id": item.footprint_id,
                    "datasheet_sha256": item.datasheet_sha256,
                    "pin_map_sha256": item.pin_map_sha256,
                    "pins": [
                        {
                            "number": pin.number,
                            "name": pin.name,
                            "electrical_type": pin.electrical_type,
                            "pad_number": pin.pad_number,
                            "required": pin.required,
                        }
                        for pin in item.pins
                    ],
                },
            )
        )
    for item in graph.nets:
        payloads.append((CommandKind.NET_CREATE, {"net_id": item.net_id, "name": item.name}))
    for item in graph.nets:
        for member in item.members:
            payloads.append(
                (
                    CommandKind.NET_CONNECT,
                    {
                        "net_id": item.net_id,
                        "component_id": member.component_id,
                        "pin_number": member.pin_number,
                    },
                )
            )
    for item in graph.placements:
        payloads.append(
            (
                CommandKind.FOOTPRINT_PLACE,
                {
                    "component_id": item.component_id,
                    "x_nm": item.position.x,
                    "y_nm": item.position.y,
                    "rotation_udeg": item.rotation_udeg,
                    "side": item.side,
                    "locked": item.locked,
                },
            )
        )

    def pad_payload(item: FootprintPad) -> dict[str, object]:
        payload: dict[str, object] = {
            "pad_id": item.pad_id,
            "component_id": item.component_id,
            "pad_number": item.pad_number,
            "center_x_nm": item.center.x,
            "center_y_nm": item.center.y,
            "size_x_nm": item.size_x_nm,
            "size_y_nm": item.size_y_nm,
            "shape": item.shape,
            "rotation_udeg": item.rotation_udeg,
            "layers": list(item.layers),
            "pad_drill_nm": item.pad_drill_nm,
            "drill_x_nm": item.drill_x_nm,
            "drill_y_nm": item.drill_y_nm,
            "drill_rotation_udeg": item.drill_rotation_udeg,
            "locked": item.locked,
        }
        if item.net_id is not None:
            payload["net_id"] = item.net_id
        if item.shared_land_group_id is not None:
            payload["shared_land_group_id"] = item.shared_land_group_id
        return payload

    emitted_land_groups: set[str] = set()
    for item in graph.pads:
        group_id = item.shared_land_group_id
        if group_id is None:
            payloads.append((CommandKind.FOOTPRINT_PAD_ADD, pad_payload(item)))
            continue
        if group_id in emitted_land_groups:
            continue
        group_pads = tuple(
            sorted(
                (pad for pad in graph.pads if pad.shared_land_group_id == group_id),
                key=lambda pad: pad.pad_id,
            )
        )
        payloads.append(
            (
                CommandKind.FOOTPRINT_PAD_GROUP_ADD,
                {
                    "shared_land_group_id": group_id,
                    "pads": [pad_payload(pad) for pad in group_pads],
                },
            )
        )
        emitted_land_groups.add(group_id)
    for item in graph.holes:
        payload: dict[str, object] = {
            "hole_id": item.hole_id,
            "component_id": item.component_id,
            "center_x_nm": item.center.x,
            "center_y_nm": item.center.y,
            "diameter_nm": item.diameter_nm,
            "drill_x_nm": item.drill_x_nm,
            "drill_y_nm": item.drill_y_nm,
            "drill_rotation_udeg": item.drill_rotation_udeg,
            "plated": item.plated,
            "locked": item.locked,
        }
        if item.pad_id is not None:
            payload["pad_id"] = item.pad_id
        payloads.append((CommandKind.FOOTPRINT_HOLE_ADD, payload))
    for item in graph.tracks:
        payloads.append(
            (
                CommandKind.TRACK_ADD,
                {
                    "track_id": item.track_id,
                    "net_id": item.net_id,
                    "layer": item.layer,
                    "start_x_nm": item.start.x,
                    "start_y_nm": item.start.y,
                    "end_x_nm": item.end.x,
                    "end_y_nm": item.end.y,
                    "width_nm": item.width_nm,
                    "locked": item.locked,
                },
            )
        )
    for item in graph.vias:
        payloads.append(
            (
                CommandKind.VIA_ADD,
                {
                    "via_id": item.via_id,
                    "net_id": item.net_id,
                    "center_x_nm": item.center.x,
                    "center_y_nm": item.center.y,
                    "diameter_nm": item.diameter_nm,
                    "drill_nm": item.drill_nm,
                    "layers": list(item.layers),
                    "locked": item.locked,
                },
            )
        )
    for item in graph.zones:
        payloads.append(
            (
                CommandKind.ZONE_ADD,
                {
                    "zone_id": item.zone_id,
                    "net_id": item.net_id,
                    "layer": item.layer,
                    "outline": [[point.x, point.y] for point in item.outline],
                    "clearance_nm": item.clearance_nm,
                    "min_thickness_nm": item.min_thickness_nm,
                    "priority": item.priority,
                    "locked": item.locked,
                },
            )
        )
    for item in graph.schematic_wires:
        payloads.append(
            (
                CommandKind.SCHEMATIC_WIRE_ADD,
                {
                    "wire_id": item.wire_id,
                    "net_id": item.net_id,
                    "vertices": [[point.x, point.y] for point in item.vertices],
                    "sheet_id": item.sheet_id,
                    "locked": item.locked,
                },
            )
        )
    for item in graph.schematic_junctions:
        payloads.append(
            (
                CommandKind.SCHEMATIC_JUNCTION_ADD,
                {
                    "junction_id": item.junction_id,
                    "net_id": item.net_id,
                    "x_nm": item.position.x,
                    "y_nm": item.position.y,
                    "sheet_id": item.sheet_id,
                    "locked": item.locked,
                },
            )
        )
    return payloads


def _transaction_input(
    *,
    candidate: CanonicalImportCandidate,
    empty_graph: DesignGraph,
    transaction_id: str,
) -> CanonicalImportTransactionInput:
    commands: list[DesignCommand] = []
    for ordinal, (kind, payload) in enumerate(_payloads_for_graph(candidate.graph), start=1):
        seed = stable_hash(
            {
                "candidate_sha256": candidate.candidate_sha256,
                "ordinal": ordinal,
                "kind": kind.value,
                "payload": payload,
            },
            domain="flux-clone-canonical-import-command-id-v1",
        )
        commands.append(
            DesignCommand.create(
                command_id=f"import-{seed[:24]}",
                base_revision=candidate.base_revision,
                transaction_id=transaction_id,
                actor=candidate.authorized_actor,
                kind=kind,
                payload=payload,
                idempotency_key=f"import-{seed}",
            )
        )
    typed_commands = tuple(commands)
    commands_sha256 = stable_hash(
        tuple(command.command_hash for command in typed_commands),
        domain="flux-clone-canonical-import-commands-v1",
    )
    return CanonicalImportTransactionInput(
        transaction_id=transaction_id,
        base_revision=candidate.base_revision,
        authorized_actor=candidate.authorized_actor,
        expected_empty_graph_sha256=empty_graph.graph_hash,
        candidate_sha256=candidate.candidate_sha256,
        prospective_graph_sha256=candidate.graph_sha256,
        commands=typed_commands,
        commands_sha256=commands_sha256,
    )


def map_project_import(
    source: ProjectImportResult,
    *,
    source_payload: ProjectBundleInput,
    project_id: str,
    base_revision: str,
    transaction_id: str,
    actor: str,
    component_resolver: TrustedComponentProvenanceResolver,
) -> ImportMappingResult:
    """Map one reviewed project bundle without mutating a ``DesignKernel``.

    The returned canonical graph is a preview candidate.  Typed commands are
    emitted only when every blocking parity, provenance, geometry, and loss
    condition is absent.  Those commands explicitly require an empty canonical
    base graph and remain unapplied.
    """

    if type(source) is not ProjectImportResult:
        raise TypeError("source must be ProjectImportResult")
    if type(source_payload) is not ProjectBundleInput:
        raise TypeError("source_payload must be ProjectBundleInput")
    if type(project_id) is not str or not project_id:
        raise TypeError("project_id must be non-empty text")
    if type(base_revision) is not str or _SHA256.fullmatch(base_revision) is None:
        raise TypeError("base_revision must be a lowercase SHA-256 digest")
    for value, label in ((transaction_id, "transaction_id"), (actor, "actor")):
        if (
            type(value) is not str
            or not value
            or value != value.strip()
            or any(character.isspace() for character in value)
        ):
            raise TypeError(f"{label} must be a non-empty whitespace-free identifier")

    # Construction validates the project ID and gives the future stage boundary
    # an exact empty-base precondition.  No kernel object is created or mutated.
    empty_graph = DesignGraph(1, project_id).normalized()
    source_digest = source.bundle.normalized_ir_sha256
    blockers = _source_evidence_blockers(source, source_payload)
    blockers.extend(_unsupported_blockers(source))
    context, parity_blockers = _parity_context(source)
    blockers.extend(parity_blockers)
    if blockers or context is None:
        return _result(
            source_bundle_ir_sha256=source_digest,
            authorized_actor=actor,
            candidate=None,
            transaction_input=None,
            blockers=blockers,
            advisories=[],
        )

    resolutions, bindings, provenance_blockers = _resolve_components(
        source,
        context,
        component_resolver,
    )
    blockers.extend(provenance_blockers)
    if blockers:
        return _result(
            source_bundle_ir_sha256=source_digest,
            authorized_actor=actor,
            candidate=None,
            transaction_input=None,
            blockers=blockers,
            advisories=[],
        )

    try:
        board_conversion = to_design_graph(
            context.canonical_board,
            project_id=project_id,
            component_resolver=_ResolvedAdapter(resolutions),
        )
    except CanonicalMappingError as exc:
        blockers.extend(
            _issue(gap.code, gap.entity_id, gap.detail)
            for gap in exc.gaps
            if isinstance(gap, MappingGap)
        )
        if not blockers:
            blockers.append(
                _issue(
                    "canonical-board-mapping-failed",
                    "project-bundle",
                    "board IR could not be mapped without invention or loss",
                )
            )
        return _result(
            source_bundle_ir_sha256=source_digest,
            authorized_actor=actor,
            candidate=None,
            transaction_input=None,
            blockers=blockers,
            advisories=[],
        )

    adapter_blockers, advisories = _adapter_issues(board_conversion.gaps)
    blockers.extend(adapter_blockers)
    schematic_blockers, schematic_advisories = _schematic_retention_issues(source)
    blockers.extend(schematic_blockers)
    advisories.extend(schematic_advisories)
    try:
        graph = _map_schematic_graph(source, context, board_conversion.graph)
        graph_sha256 = graph.graph_hash
    except Exception:
        blockers.append(
            _issue(
                "canonical-schematic-mapping-failed",
                "project-bundle",
                "schematic IR could not produce a valid canonical graph exactly",
            )
        )
        return _result(
            source_bundle_ir_sha256=source_digest,
            authorized_actor=actor,
            candidate=None,
            transaction_input=None,
            blockers=blockers,
            advisories=advisories,
        )

    if graph.layers != empty_graph.layers:
        blockers.append(
            _issue(
                "layer-table-command-unsupported",
                "project-bundle",
                "typed import commands cannot yet replace the canonical copper layer table",
            )
        )
    expected_empty_revision = stable_hash(
        {"parent": None, "sequence": 0, "graph_hash": empty_graph.graph_hash},
        domain="flux-clone-design-revision-v1",
    )
    if base_revision != expected_empty_revision:
        blockers.append(
            _issue(
                "target-base-not-proven-empty",
                "project-bundle",
                "typed full-project import currently requires the exact empty genesis revision",
            )
        )
    provenance_set_sha256 = stable_hash(
        bindings,
        domain="flux-clone-component-provenance-set-v1",
    )
    candidate = CanonicalImportCandidate(
        project_id=project_id,
        base_revision=base_revision,
        authorized_actor=actor,
        source_bundle_ir_sha256=source_digest,
        source_import_evidence_sha256=source.evidence.evidence_sha256,
        diagnostics_manifest_sha256=source.bundle.diagnostics.manifest_sha256,
        source_payload=source_payload,
        source_bundle=source.bundle,
        source_import_evidence=source.evidence,
        graph=graph,
        graph_sha256=graph_sha256,
        provenance_bindings=bindings,
        provenance_set_sha256=provenance_set_sha256,
    )
    transaction_input: CanonicalImportTransactionInput | None = None
    if not blockers:
        try:
            transaction_input = _transaction_input(
                candidate=candidate,
                empty_graph=empty_graph,
                transaction_id=transaction_id,
            )
        except Exception:
            blockers.append(
                _issue(
                    "typed-command-generation-failed",
                    "project-bundle",
                    "canonical graph could not be encoded as exact typed import commands",
                )
            )
    return _result(
        source_bundle_ir_sha256=source_digest,
        authorized_actor=actor,
        candidate=candidate,
        transaction_input=transaction_input,
        blockers=blockers,
        advisories=advisories,
    )

"""In-memory KiCad project-bundle import/export and semantic parity evidence."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from backend.kicad_io import (
    Board,
    Footprint,
    Pad,
    PadKind,
    export_board,
    import_board,
)
from backend.kicad_io import (
    DiagnosticDisposition as BoardDiagnosticDisposition,
)
from backend.kicad_io import (
    UnsupportedPolicy as BoardUnsupportedPolicy,
)

from .errors import ProjectInvariantError, ProjectSyntaxError, UnsupportedProjectConstructError
from .libraries import parse_hermetic_project_libraries
from .manifest import parse_project_manifest, render_project_manifest
from .model import (
    BundleExportEvidence,
    BundleImportEvidence,
    BundleLimits,
    BundleRoundTripEvidence,
    DiagnosticDisposition,
    LabelKind,
    ProjectBundle,
    ProjectBundleInput,
    ProjectDiagnostic,
    ProjectDiagnostics,
    Schematic,
    SchematicSymbol,
    UnsupportedPolicy,
)
from .schematic import parse_schematic, render_schematic

PARSER_ID = "flux-clone-kicad-project-bundle-parser-v1"
WRITER_ID = "flux-clone-kicad-project-bundle-writer-v1"
_DEFAULT_LIMITS = BundleLimits()


@dataclass(frozen=True, slots=True)
class ProjectImportResult:
    bundle: ProjectBundle
    evidence: BundleImportEvidence


@dataclass(frozen=True, slots=True)
class ProjectExportResult:
    payload: ProjectBundleInput
    evidence: BundleExportEvidence


@dataclass(frozen=True, slots=True)
class ProjectRoundTripResult:
    imported: ProjectImportResult
    exported: ProjectExportResult
    reparsed: ProjectImportResult
    evidence: BundleRoundTripEvidence


def _board_diagnostics(board: object) -> tuple[ProjectDiagnostic, ...]:
    diagnostics = getattr(board, "diagnostics", None)
    constructs = getattr(diagnostics, "constructs", ())
    result: list[ProjectDiagnostic] = []
    for item in constructs:
        disposition = (
            DiagnosticDisposition.PRESERVED
            if item.disposition is BoardDiagnosticDisposition.PRESERVED
            else DiagnosticDisposition.UNSUPPORTED
        )
        result.append(
            ProjectDiagnostic(
                "board",
                f"$.{item.scope}.{item.path}",
                item.head,
                disposition,
                item.reason,
                item.canonical_sexpr,
                item.construct_sha256,
            )
        )
    return tuple(result)


def _cross_parity_diagnostic(reason: str) -> ProjectDiagnostic:
    body = '{"status":"not-proven"}'
    return ProjectDiagnostic(
        "bundle",
        "$.schematic_board_parity",
        "schematic_board_parity",
        DiagnosticDisposition.UNSUPPORTED,
        reason,
        body,
        hashlib.sha256(body.encode("utf-8")).hexdigest(),
    )


def _pad_land_geometry(pad: Pad) -> tuple[object, ...]:
    """Return the electrical-land geometry that makes two PCB pads coincident.

    Pad number, UUID, net, and pin metadata are intentionally absent: those are
    the identities and claims that this grouping audits rather than geometry.
    """

    return (
        pad.kind,
        pad.shape,
        pad.position,
        pad.rotation_udeg,
        pad.size_x_nm,
        pad.size_y_nm,
        pad.drill_x_nm,
        pad.drill_y_nm,
        pad.layers,
        pad.roundrect_ratio_ppm,
    )


def _logical_pads(
    footprint: Footprint, *, copper_layers: set[str]
) -> tuple[Pad, ...]:
    """Separate numbered electrical lands from source-backed paste/mask apertures."""

    logical: list[Pad] = []
    for pad in footprint.pads:
        if pad.kind is PadKind.NPTH:
            continue
        if pad.number:
            logical.append(pad)
            continue
        if (
            pad.net_id is not None
            or pad.pin_function is not None
            or pad.pin_type is not None
            or any(layer == "*.Cu" or layer in copper_layers for layer in pad.layers)
        ):
            raise ProjectInvariantError(
                f"unnumbered pad {pad.pad_id!r} on {footprint.reference!r} cannot carry "
                "electrical copper, a net, or schematic pin metadata"
            )
        # KiCad footprints legitimately use unnumbered SMD-shaped records on
        # paste/mask-only layers to define source-backed manufacturing apertures.
    return tuple(logical)


def _schematic_net_aliases(schematic: Schematic) -> dict[str, str]:
    """Return exact PCB-name aliases for each modeled schematic net.

    KiCad qualifies a local label on the root sheet as ``/NAME`` in the PCB,
    while a global label remains ``NAME``.  Older supported exchange payloads
    can carry the unqualified local name, so that exact spelling remains an
    accepted compatibility form.  This is deliberately not slash stripping:
    aliases are constructed from the parsed label kind and literal label text,
    and every alias must identify exactly one schematic net.
    """

    labels_by_id = {item.label_id: item for item in schematic.labels}
    aliases: dict[str, str] = {}
    for net in schematic.nets:
        if net.name is None:
            raise ProjectInvariantError(
                "schematic-to-PCB parity requires every connected pin net to be explicitly named"
            )
        try:
            label_kinds = {labels_by_id[label_id].kind for label_id in net.label_ids}
        except KeyError as exc:  # defensive for caller-constructed typed IR
            raise ProjectInvariantError(
                "schematic net references an unknown label identity"
            ) from exc
        if not label_kinds:
            raise ProjectInvariantError(
                "an explicitly named schematic net requires label evidence"
            )
        accepted_names = {net.name}
        if label_kinds == {LabelKind.LOCAL}:
            accepted_names.add(f"/{net.name}")
        for accepted_name in accepted_names:
            previous = aliases.get(accepted_name)
            if previous is not None and previous != net.name:
                raise ProjectInvariantError(
                    "schematic PCB-name aliases collide across distinct nets: "
                    f"{accepted_name!r} identifies both {previous!r} and {net.name!r}"
                )
            aliases[accepted_name] = net.name
    return aliases


def _schematic_no_connect_pins(schematic: Schematic) -> set[tuple[str, str]]:
    """Return exact ``(symbol UUID, pin number)`` pairs carrying NC markers."""

    marker_positions = {item.position for item in schematic.no_connects}
    return {
        (symbol.symbol_id, pin.number)
        for symbol in schematic.symbols
        for pin in symbol.pins
        if pin.position in marker_positions
    }


def _prove_unconnected_auto_net(
    *,
    net_id: str,
    net_name: str,
    board: Board,
    symbols_by_reference: dict[str, SchematicSymbol],
    no_connect_pins: set[tuple[str, str]],
) -> None:
    """Fail unless one KiCad auto-net is exact, NC-only, and copper-free.

    This function intentionally has no permissive parser for auto-net names.
    It reconstructs the one accepted spelling from each owning footprint and
    schematic pin, so reference, pin name, and pad number must all agree.
    """

    if any(item.net_id == net_id for item in board.segments):
        raise ProjectInvariantError(
            f"unconnected auto-net {net_name!r} must not own routed segments"
        )
    if any(item.net_id == net_id for item in board.vias):
        raise ProjectInvariantError(
            f"unconnected auto-net {net_name!r} must not own vias"
        )
    if any(item.net_id == net_id for item in board.zones):
        raise ProjectInvariantError(
            f"unconnected auto-net {net_name!r} must not own zones"
        )

    owning_pads = tuple(
        (footprint, pad)
        for footprint in board.footprints
        for pad in footprint.pads
        if pad.kind is not PadKind.NPTH and pad.net_id == net_id
    )
    if not owning_pads:
        raise ProjectInvariantError(
            f"unconnected auto-net {net_name!r} requires at least one owning electrical pad"
        )
    for footprint, pad in owning_pads:
        symbol = symbols_by_reference.get(footprint.reference)
        if symbol is None:
            raise ProjectInvariantError(
                f"unconnected auto-net {net_name!r} references an unknown footprint symbol"
            )
        pins = {item.number: item for item in symbol.pins}
        pin = pins.get(pad.number)
        if pin is None:
            raise ProjectInvariantError(
                f"unconnected auto-net {net_name!r} references an unknown schematic pin"
            )
        pin_key = (symbol.symbol_id, pin.number)
        if pin_key not in no_connect_pins:
            raise ProjectInvariantError(
                f"unconnected auto-net {net_name!r} pad "
                f"{footprint.reference}.{pad.number} lacks an explicit schematic NC marker"
            )
        if pin.name:
            if pad.pin_function != pin.name:
                raise ProjectInvariantError(
                    f"unconnected auto-net {net_name!r} requires exact PCB pin-function "
                    f"metadata for {footprint.reference}.{pad.number}"
                )
        elif pad.pin_function not in {None, ""}:
            raise ProjectInvariantError(
                f"unconnected auto-net {net_name!r} requires absent or empty PCB "
                f"pin-function metadata for unnamed pin {footprint.reference}.{pad.number}"
            )
        if pin.name and pin.name != pin.number:
            expected_name = (
                f"unconnected-({footprint.reference}-{pin.name}-Pad{pad.number})"
            )
        else:
            # KiCad's SCH_PIN::GetDefaultNetName omits the redundant name
            # token when the shown pin name is empty or equals its number.
            expected_name = f"unconnected-({footprint.reference}-Pad{pad.number})"
        if net_name != expected_name:
            raise ProjectInvariantError(
                f"unconnected auto-net name mismatch for {footprint.reference}.{pad.number}: "
                f"expected {expected_name!r}, got {net_name!r}"
            )


def _validate_schematic_board_parity(schematic: Schematic, board: Board) -> None:
    board_footprints = board.footprints
    board_nets = board.nets
    references = [item.reference for item in board_footprints]
    if len(references) != len(set(references)):
        raise ProjectInvariantError("PCB footprint references must be unique")
    schematic_references = [item.reference for item in schematic.symbols]
    if len(schematic_references) != len(set(schematic_references)):
        raise ProjectInvariantError("schematic symbol references must be unique")
    if set(references) != set(schematic_references):
        raise ProjectInvariantError(
            "schematic symbol and PCB footprint reference populations must match exactly"
        )

    board_raw_net_names = {item.net_id: item.name for item in board_nets}
    if len(board_raw_net_names) != len(board_nets):
        raise ProjectInvariantError("PCB canonical net IDs must be unique")
    schematic_net_by_pin: dict[tuple[str, str], str] = {}
    schematic_names: set[str] = set()
    for net in schematic.nets:
        if net.name is None:
            raise ProjectInvariantError(
                "schematic-to-PCB parity requires every connected pin net to be explicitly named"
            )
        schematic_names.add(net.name)
        for ref in net.pin_refs:
            key = (ref.symbol_id, ref.pin_number)
            if key in schematic_net_by_pin:
                raise ProjectInvariantError("schematic pin belongs to more than one resolved net")
            schematic_net_by_pin[key] = net.name

    symbols_by_reference = {item.reference: item for item in schematic.symbols}
    copper_layers = {
        item.name
        for item in board.layers
        if item.kind in {"signal", "power", "mixed", "jumper"}
    }
    net_aliases = _schematic_net_aliases(schematic)
    no_connect_pins = _schematic_no_connect_pins(schematic)
    board_logical_net_names: dict[str, str | None] = {}
    logical_net_owners: dict[str, str] = {}
    for net in board_nets:
        logical_name = net_aliases.get(net.name)
        if logical_name is None:
            if not net.name.startswith("unconnected-("):
                raise ProjectInvariantError(
                    f"PCB net name {net.name!r} does not exactly identify a schematic net"
                )
            _prove_unconnected_auto_net(
                net_id=net.net_id,
                net_name=net.name,
                board=board,
                symbols_by_reference=symbols_by_reference,
                no_connect_pins=no_connect_pins,
            )
            board_logical_net_names[net.net_id] = None
            continue
        previous_net_id = logical_net_owners.get(logical_name)
        if previous_net_id is not None:
            raise ProjectInvariantError(
                "PCB raw-name/root-local aliases collide for schematic net "
                f"{logical_name!r}: net IDs {previous_net_id!r} and {net.net_id!r}"
            )
        logical_net_owners[logical_name] = net.net_id
        board_logical_net_names[net.net_id] = logical_name
    if schematic_names != set(logical_net_owners):
        raise ProjectInvariantError(
            "schematic and PCB named-net populations must match exactly after "
            "root-local qualification"
        )

    for footprint in board_footprints:
        symbol = symbols_by_reference[footprint.reference]
        if symbol.footprint != footprint.library_id:
            raise ProjectInvariantError(
                f"footprint identity mismatch for reference {footprint.reference!r}"
            )
        if symbol.value != footprint.value:
            raise ProjectInvariantError(
                f"schematic/PCB value mismatch for reference {footprint.reference!r}"
            )

        # NPTH records are mechanical holes, not logical pin mappings.  Every
        # electrical pad remains in a list keyed by its logical number so
        # repeated physical shell/ground/power lands cannot collapse through a
        # set or last-write-wins dictionary.
        pads_by_number: dict[str, list[Pad]] = {}
        lands_by_geometry: dict[tuple[object, ...], list[Pad]] = {}
        for pad in _logical_pads(footprint, copper_layers=copper_layers):
            pads_by_number.setdefault(pad.number, []).append(pad)
            lands_by_geometry.setdefault(_pad_land_geometry(pad), []).append(pad)

        pins_by_number = {pin.number: pin for pin in symbol.pins}
        if set(pads_by_number) != set(pins_by_number):
            raise ProjectInvariantError(
                f"pin/pad number population mismatch for reference {footprint.reference!r}"
            )

        for pad_number, physical_pads in pads_by_number.items():
            board_net_ids = {pad.net_id for pad in physical_pads}
            if len(board_net_ids) != 1:
                raise ProjectInvariantError(
                    f"repeated PCB pads for {footprint.reference}.{pad_number} "
                    "must have identical net semantics"
                )
            board_net_id = next(iter(board_net_ids))
            board_name = (
                None if board_net_id is None else board_logical_net_names[board_net_id]
            )
            schematic_name = schematic_net_by_pin.get((symbol.symbol_id, pad_number))
            if schematic_name != board_name:
                raise ProjectInvariantError(
                    f"pin/pad net mismatch for {footprint.reference}.{pad_number}: "
                    f"schematic={schematic_name!r}, PCB={board_name!r}"
                )
            pin = pins_by_number[pad_number]
            for pad in physical_pads:
                if pad.pin_function is not None and pad.pin_function != pin.name:
                    raise ProjectInvariantError(
                        f"ambiguous pin function for {footprint.reference}.{pad_number}: "
                        f"schematic={pin.name!r}, PCB={pad.pin_function!r}"
                    )
                if pad.pin_type is not None and pad.pin_type != pin.electrical_type:
                    raise ProjectInvariantError(
                        f"ambiguous pin electrical type for "
                        f"{footprint.reference}.{pad_number}: "
                        f"schematic={pin.electrical_type!r}, PCB={pad.pin_type!r}"
                    )

        # KiCad represents one copper land shared by distinct logical contacts
        # as distinct, coincident pad records.  Preserve those records and their
        # pin numbers, but reject an impossible mixed-net ownership claim.
        for coincident_pads in lands_by_geometry.values():
            if len(coincident_pads) < 2:
                continue
            coincident_net_ids = {pad.net_id for pad in coincident_pads}
            if len(coincident_net_ids) != 1:
                numbers = ", ".join(sorted({pad.number for pad in coincident_pads}))
                raise ProjectInvariantError(
                    f"coincident PCB lands for {footprint.reference} pad(s) {numbers} "
                    "must have identical net semantics"
                )


def _check_limits(source: ProjectBundleInput, limits: BundleLimits) -> None:
    sizes = (
        ("project", len(source.project_payload), limits.maximum_project_bytes),
        ("schematic", len(source.schematic_payload), limits.maximum_schematic_bytes),
        ("board", len(source.board_payload), limits.maximum_board_bytes),
    )
    for label, actual, maximum in sizes:
        if actual > maximum:
            raise ProjectSyntaxError(f"{label} payload exceeds the {maximum}-byte bundle limit")
    if len(source.auxiliary_files) > limits.maximum_auxiliary_file_count:
        raise ProjectSyntaxError(
            "auxiliary file count exceeds the bounded project-bundle limit"
        )
    for item in source.auxiliary_files:
        if len(item.payload) > limits.maximum_auxiliary_file_bytes:
            raise ProjectSyntaxError(
                f"auxiliary payload {item.relative_name!r} exceeds the per-file limit"
            )
    auxiliary_total = sum(len(item.payload) for item in source.auxiliary_files)
    if auxiliary_total > limits.maximum_auxiliary_total_bytes:
        raise ProjectSyntaxError("auxiliary payloads exceed the aggregate auxiliary limit")
    total = sum(item[1] for item in sizes) + auxiliary_total
    if total > limits.maximum_total_bytes:
        raise ProjectSyntaxError(
            f"project bundle exceeds the {limits.maximum_total_bytes}-byte aggregate limit"
        )


def import_project_bundle(
    source: ProjectBundleInput,
    *,
    unsupported_policy: UnsupportedPolicy = UnsupportedPolicy.REJECT,
    limits: BundleLimits = _DEFAULT_LIMITS,
) -> ProjectImportResult:
    """Import three caller-supplied byte payloads; no filesystem or KiCad process is used."""

    if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
        source, ProjectBundleInput
    ):
        raise TypeError("source must be ProjectBundleInput")
    if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
        unsupported_policy, UnsupportedPolicy
    ):
        raise TypeError("unsupported_policy must be UnsupportedPolicy")
    if not isinstance(limits, BundleLimits):  # pyright: ignore[reportUnnecessaryIsInstance]
        raise TypeError("limits must be BundleLimits")
    _check_limits(source, limits)
    if source.auxiliary_files:
        parse_hermetic_project_libraries(source.auxiliary_files, limits=limits)
    manifest = parse_project_manifest(source.project_payload, stem=source.stem, limits=limits)
    schematic = parse_schematic(source.schematic_payload, limits=limits)
    board_result = import_board(
        source.board_payload,
        unsupported_policy=BoardUnsupportedPolicy.MANIFEST,
    )
    diagnostics_items = (
        *manifest.diagnostics.constructs,
        *schematic.diagnostics.constructs,
        *_board_diagnostics(board_result.board),
    )
    electrical_unsupported = any(
        item.disposition is DiagnosticDisposition.UNSUPPORTED
        and item.artifact in {"schematic", "board"}
        for item in diagnostics_items
    )
    if electrical_unsupported:
        diagnostics_items = (
            *diagnostics_items,
            _cross_parity_diagnostic(
                "schematic-to-PCB parity cannot be proved while either electrical artifact "
                "contains an unsupported construct"
            ),
        )
    else:
        _validate_schematic_board_parity(schematic, board_result.board)
    diagnostics = ProjectDiagnostics(tuple(diagnostics_items)).normalized()
    bundle = ProjectBundle(
        source.stem,
        manifest,
        schematic,
        board_result.board,
        diagnostics,
        source.auxiliary_files,
    )
    if diagnostics.unsupported and unsupported_policy is UnsupportedPolicy.REJECT:
        raise UnsupportedProjectConstructError(
            "unsupported KiCad project constructs block strict bundle import",
            manifest_sha256=diagnostics.manifest_sha256,
            diagnostics=diagnostics.unsupported,
        )
    evidence = BundleImportEvidence(
        hashlib.sha256(source.project_payload).hexdigest(),
        hashlib.sha256(source.schematic_payload).hexdigest(),
        hashlib.sha256(source.board_payload).hexdigest(),
        manifest.normalized_ir_sha256,
        schematic.normalized_ir_sha256,
        board_result.board.normalized_ir_sha256,
        bundle.normalized_ir_sha256,
        diagnostics.manifest_sha256,
        PARSER_ID,
        auxiliary_source_manifest_sha256=source.auxiliary_manifest_sha256,
    )
    return ProjectImportResult(bundle, evidence)


def export_project_bundle(
    bundle: ProjectBundle,
    *,
    preserve_unsupported: bool = False,
) -> ProjectExportResult:
    """Export deterministic bundle bytes; explicit opt-in is required for opaque semantics."""

    if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
        bundle, ProjectBundle
    ):
        raise TypeError("bundle must be ProjectBundle")
    if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
        preserve_unsupported, bool
    ):
        raise TypeError("preserve_unsupported must be boolean")
    if bundle.diagnostics.unsupported and not preserve_unsupported:
        raise UnsupportedProjectConstructError(
            "unsupported KiCad project constructs block strict bundle export",
            manifest_sha256=bundle.diagnostics.manifest_sha256,
            diagnostics=bundle.diagnostics.unsupported,
        )
    if bundle.auxiliary_files:
        parse_hermetic_project_libraries(bundle.auxiliary_files)
    project_payload = render_project_manifest(bundle.manifest)
    schematic_payload = render_schematic(bundle.schematic)
    board_result = export_board(bundle.board, preserve_unsupported=preserve_unsupported)
    # Retained project/symbol expressions are intentionally opaque.  Reparse the
    # exact writer output before returning so callers cannot mutate typed fields
    # that the bounded writer does not actually serialize and still obtain a
    # misleading evidence record.
    reparsed_manifest = parse_project_manifest(
        project_payload, stem=bundle.stem, limits=BundleLimits()
    )
    reparsed_schematic = parse_schematic(schematic_payload, limits=BundleLimits())
    if (
        reparsed_manifest.normalized_ir_sha256 != bundle.manifest.normalized_ir_sha256
        or reparsed_manifest.diagnostics.manifest_sha256
        != bundle.manifest.diagnostics.manifest_sha256
    ):
        raise ProjectInvariantError(
            "project writer output does not bind the supplied typed manifest"
        )
    if (
        reparsed_schematic.normalized_ir_sha256 != bundle.schematic.normalized_ir_sha256
        or reparsed_schematic.diagnostics.manifest_sha256
        != bundle.schematic.diagnostics.manifest_sha256
    ):
        raise ProjectInvariantError(
            "schematic writer output does not bind the supplied typed schematic"
        )
    payload = ProjectBundleInput(
        bundle.stem,
        project_payload,
        schematic_payload,
        board_result.payload,
        bundle.auxiliary_files,
    )
    evidence = BundleExportEvidence(
        hashlib.sha256(project_payload).hexdigest(),
        hashlib.sha256(schematic_payload).hexdigest(),
        hashlib.sha256(board_result.payload).hexdigest(),
        bundle.normalized_ir_sha256,
        bundle.diagnostics.manifest_sha256,
        WRITER_ID,
        bool(bundle.diagnostics.unsupported),
        auxiliary_source_manifest_sha256=payload.auxiliary_manifest_sha256,
    )
    return ProjectExportResult(payload, evidence)


def round_trip_project_bundle(
    source: ProjectBundleInput,
    *,
    unsupported_policy: UnsupportedPolicy = UnsupportedPolicy.REJECT,
    limits: BundleLimits = _DEFAULT_LIMITS,
) -> ProjectRoundTripResult:
    imported = import_project_bundle(
        source, unsupported_policy=unsupported_policy, limits=limits
    )
    exported = export_project_bundle(
        imported.bundle,
        preserve_unsupported=unsupported_policy is UnsupportedPolicy.MANIFEST,
    )
    reparsed = import_project_bundle(
        exported.payload, unsupported_policy=unsupported_policy, limits=limits
    )
    evidence = BundleRoundTripEvidence(
        imported.bundle.manifest.normalized_ir_sha256
        == reparsed.bundle.manifest.normalized_ir_sha256,
        imported.bundle.schematic.normalized_ir_sha256
        == reparsed.bundle.schematic.normalized_ir_sha256,
        imported.bundle.board.normalized_ir_sha256
        == reparsed.bundle.board.normalized_ir_sha256,
        imported.bundle.diagnostics.manifest_sha256
        == reparsed.bundle.diagnostics.manifest_sha256,
        imported.bundle.normalized_ir_sha256,
        reparsed.bundle.normalized_ir_sha256,
        auxiliary_files_parity=(
            imported.bundle.auxiliary_files == reparsed.bundle.auxiliary_files
            == exported.payload.auxiliary_files
        ),
    )
    return ProjectRoundTripResult(imported, exported, reparsed, evidence)

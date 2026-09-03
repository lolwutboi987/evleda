"""Immutable contracts for fail-closed KiCad project-to-canonical mapping.

These records deliberately stop before persistence or kernel mutation.  A
trusted catalog implementation may satisfy the resolver protocol, but every
resolution must bind the exact source request and a catalog trust snapshot.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Protocol

from backend.design_kernel import (
    Component,
    DesignCommand,
    DesignGraph,
    DesignKernel,
    FootprintPad,
    stable_hash,
    validate_graph,
)
from backend.kicad_io import Pad as SourcePad
from backend.kicad_io import PadKind
from backend.kicad_project import (
    BundleImportEvidence,
    ProjectBundle,
    ProjectBundleInput,
    UnsupportedPolicy,
    import_project_bundle,
)

from ._semantics import (
    proven_no_connect_board_net_ids,
    resolve_root_sheet_namespace,
)

_SHA256 = re.compile(r"[0-9a-f]{64}")


class ImportMappingInvariantError(ValueError):
    """A caller supplied a malformed canonical-import contract value."""


def _require_id(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or any(character.isspace() for character in value)
    ):
        raise ImportMappingInvariantError(f"{label} must be a non-empty whitespace-free identifier")
    return value


def _require_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ImportMappingInvariantError(f"{label} must be non-empty text")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ImportMappingInvariantError(f"{label} must be valid Unicode") from exc
    return value


def _require_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ImportMappingInvariantError(f"{label} must be a lowercase SHA-256 digest")
    return value


_TRUSTED_MAPPER_AUTHORITY = object()
_DETERMINISTIC_MAPPER_ORIGIN = object()
_DURABLE_RESTORE_ORIGIN = object()


class MappingIssuanceSeal:
    """Object capability proving that the deterministic mapper issued a result."""

    __slots__ = ("mapping_sha256", "_origin")

    def __init__(
        self,
        mapping_sha256: str,
        *,
        authority: object,
        origin: object,
    ) -> None:
        if authority is not _TRUSTED_MAPPER_AUTHORITY:
            raise ImportMappingInvariantError(
                "trusted mapper seals can only be minted by the mapper boundary"
            )
        _require_sha256(mapping_sha256, "trusted mapper seal digest")
        self.mapping_sha256 = mapping_sha256
        self._origin = origin

    def has_origin(self, origin: object) -> bool:
        return self._origin is origin

    @property
    def is_deterministic_mapper_issuance(self) -> bool:
        return self._origin is _DETERMINISTIC_MAPPER_ORIGIN

    @property
    def is_durable_restore(self) -> bool:
        return self._origin is _DURABLE_RESTORE_ORIGIN


def _mint_mapper_seal(mapping_sha256: str) -> MappingIssuanceSeal:
    return MappingIssuanceSeal(
        mapping_sha256,
        authority=_TRUSTED_MAPPER_AUTHORITY,
        origin=_DETERMINISTIC_MAPPER_ORIGIN,
    )


def mint_restored_mapping_seal(mapping_sha256: str) -> MappingIssuanceSeal:
    return MappingIssuanceSeal(
        mapping_sha256,
        authority=_TRUSTED_MAPPER_AUTHORITY,
        origin=_DURABLE_RESTORE_ORIGIN,
    )


@dataclass(frozen=True, slots=True, order=True)
class SourcePinPadBinding:
    """Exact schematic pin, PCB pad, and named-net facts sent to a resolver."""

    pin_number: str
    pad_number: str
    pin_name: str
    electrical_type: str
    net_name: str | None

    def __post_init__(self) -> None:
        _require_id(self.pin_number, "source pin number")
        _require_id(self.pad_number, "source pad number")
        _require_text(self.pin_name, "source pin name")
        _require_id(self.electrical_type, "source pin electrical type")
        if self.net_name is not None:
            _require_text(self.net_name, "source named net")


@dataclass(frozen=True, slots=True)
class ComponentProvenanceRequest:
    """Source-bound request presented to the trusted component catalog."""

    source_bundle_ir_sha256: str
    source_footprint_id: str
    reference: str
    value: str
    footprint_library_id: str
    schematic_symbol_instance_id: str
    schematic_library_id: str
    pins: tuple[SourcePinPadBinding, ...]

    def __post_init__(self) -> None:
        _require_sha256(self.source_bundle_ir_sha256, "source bundle IR digest")
        for value, label in (
            (self.source_footprint_id, "source footprint ID"),
            (self.reference, "source reference"),
            (self.footprint_library_id, "source footprint library ID"),
            (self.schematic_symbol_instance_id, "schematic symbol instance ID"),
            (self.schematic_library_id, "schematic library ID"),
        ):
            _require_id(value, label)
        _require_text(self.value, "source value")
        if type(self.pins) is not tuple or any(
            type(item) is not SourcePinPadBinding for item in self.pins
        ):
            raise ImportMappingInvariantError(
                "source pins must be an immutable SourcePinPadBinding tuple"
            )
        if not self.pins:
            raise ImportMappingInvariantError("a component provenance request requires pins")
        if tuple(sorted(self.pins)) != self.pins:
            raise ImportMappingInvariantError(
                "source pin bindings must be deterministically sorted"
            )
        if len({item.pin_number for item in self.pins}) != len(self.pins):
            raise ImportMappingInvariantError("source pin numbers must be unique")
        if len({item.pad_number for item in self.pins}) != len(self.pins):
            raise ImportMappingInvariantError("source pad numbers must be unique")

    @property
    def request_sha256(self) -> str:
        return stable_hash(self, domain="flux-clone-component-provenance-request-v1")


@dataclass(frozen=True, slots=True)
class TrustedComponentResolution:
    """Resolver attestation for one exact request and one canonical component.

    The evidence digest is not a claim that arbitrary callers are trusted.  It
    makes the output tamper-evident after it crosses a separately configured
    trusted resolver boundary.
    """

    request_sha256: str
    evidence_id: str
    resolver_id: str
    trust_snapshot_sha256: str
    component: Component
    evidence_sha256: str

    def __post_init__(self) -> None:
        _require_sha256(self.request_sha256, "provenance request digest")
        _require_id(self.evidence_id, "component evidence ID")
        _require_id(self.resolver_id, "component resolver ID")
        _require_sha256(self.trust_snapshot_sha256, "resolver trust snapshot digest")
        if type(self.component) is not Component:
            raise ImportMappingInvariantError("resolution component must be Component")
        _require_sha256(self.evidence_sha256, "component evidence digest")
        if self.evidence_sha256 != self.expected_evidence_sha256:
            raise ImportMappingInvariantError(
                "component evidence digest does not bind the resolution"
            )

    @property
    def expected_evidence_sha256(self) -> str:
        return stable_hash(
            {
                "request_sha256": self.request_sha256,
                "evidence_id": self.evidence_id,
                "resolver_id": self.resolver_id,
                "trust_snapshot_sha256": self.trust_snapshot_sha256,
                "component": self.component,
            },
            domain="flux-clone-trusted-component-resolution-v1",
        )

    @classmethod
    def create(
        cls,
        *,
        request: ComponentProvenanceRequest,
        evidence_id: str,
        resolver_id: str,
        trust_snapshot_sha256: str,
        component: Component,
    ) -> TrustedComponentResolution:
        if type(request) is not ComponentProvenanceRequest:
            raise TypeError("request must be ComponentProvenanceRequest")
        preimage = {
            "request_sha256": request.request_sha256,
            "evidence_id": evidence_id,
            "resolver_id": resolver_id,
            "trust_snapshot_sha256": trust_snapshot_sha256,
            "component": component,
        }
        return cls(
            request.request_sha256,
            evidence_id,
            resolver_id,
            trust_snapshot_sha256,
            component,
            stable_hash(preimage, domain="flux-clone-trusted-component-resolution-v1"),
        )


class TrustedComponentProvenanceResolver(Protocol):
    """Explicit trust boundary for exact catalog provenance.

    ``None`` means the source part is unresolved.  Exceptions are treated as a
    closed resolver failure by the mapper and are never reflected verbatim.
    """

    def resolve(self, request: ComponentProvenanceRequest) -> TrustedComponentResolution | None: ...


@dataclass(frozen=True, slots=True, order=True)
class MappingIssue:
    code: str
    entity_id: str
    detail: str

    def __post_init__(self) -> None:
        _require_id(self.code, "mapping issue code")
        _require_id(self.entity_id, "mapping issue entity ID")
        _require_text(self.detail, "mapping issue detail")


@dataclass(frozen=True, slots=True)
class ComponentProvenanceBinding:
    source_footprint_id: str
    component_evidence_id: str
    request: ComponentProvenanceRequest
    request_sha256: str
    component_id: str
    manufacturer_part_number: str
    datasheet_sha256: str
    pin_map_sha256: str
    symbol_id: str
    footprint_id: str
    resolver_id: str
    trust_snapshot_sha256: str
    evidence_sha256: str

    def __post_init__(self) -> None:
        if type(self.request) is not ComponentProvenanceRequest:
            raise ImportMappingInvariantError("binding request must be ComponentProvenanceRequest")
        for value, label in (
            (self.source_footprint_id, "binding source footprint ID"),
            (self.component_evidence_id, "binding evidence ID"),
            (self.component_id, "binding component ID"),
            (self.symbol_id, "binding symbol ID"),
            (self.footprint_id, "binding footprint ID"),
            (self.resolver_id, "binding resolver ID"),
        ):
            _require_id(value, label)
        _require_text(self.manufacturer_part_number, "binding exact MPN")
        for value, label in (
            (self.request_sha256, "binding provenance request digest"),
            (self.datasheet_sha256, "binding datasheet digest"),
            (self.pin_map_sha256, "binding pin-map digest"),
            (self.trust_snapshot_sha256, "binding trust snapshot digest"),
            (self.evidence_sha256, "binding evidence digest"),
        ):
            _require_sha256(value, label)
        if self.request.request_sha256 != self.request_sha256:
            raise ImportMappingInvariantError(
                "binding request digest does not bind the retained request facts"
            )


@dataclass(frozen=True, slots=True)
class CanonicalImportCandidate:
    project_id: str
    base_revision: str
    authorized_actor: str
    source_bundle_ir_sha256: str
    source_import_evidence_sha256: str
    diagnostics_manifest_sha256: str
    source_payload: ProjectBundleInput
    source_bundle: ProjectBundle
    source_import_evidence: BundleImportEvidence
    graph: DesignGraph
    graph_sha256: str
    provenance_bindings: tuple[ComponentProvenanceBinding, ...]
    provenance_set_sha256: str
    kicad_execution: str = "not-run"
    manufacturing_release_eligible: bool = False

    def __post_init__(self) -> None:
        _require_id(self.project_id, "candidate project ID")
        _require_id(self.authorized_actor, "candidate authorized actor")
        for value, label in (
            (self.base_revision, "candidate base revision"),
            (self.source_bundle_ir_sha256, "candidate source bundle digest"),
            (self.source_import_evidence_sha256, "candidate source evidence digest"),
            (self.diagnostics_manifest_sha256, "candidate diagnostics digest"),
            (self.graph_sha256, "candidate graph digest"),
            (self.provenance_set_sha256, "candidate provenance-set digest"),
        ):
            _require_sha256(value, label)
        if type(self.graph) is not DesignGraph:
            raise ImportMappingInvariantError("candidate graph must be DesignGraph")
        if type(self.source_bundle) is not ProjectBundle:
            raise ImportMappingInvariantError("candidate source bundle must be ProjectBundle")
        if type(self.source_payload) is not ProjectBundleInput:
            raise ImportMappingInvariantError("candidate source payload must be ProjectBundleInput")
        if type(self.source_import_evidence) is not BundleImportEvidence:
            raise ImportMappingInvariantError(
                "candidate source evidence must be BundleImportEvidence"
            )
        if self.source_bundle.normalized_ir_sha256 != self.source_bundle_ir_sha256:
            raise ImportMappingInvariantError(
                "candidate retained source bundle does not match its source digest"
            )
        if self.source_payload.stem != self.source_bundle.stem:
            raise ImportMappingInvariantError(
                "candidate raw source stem does not match its retained source bundle"
            )
        raw_source_pairs = (
            (
                hashlib.sha256(self.source_payload.project_payload).hexdigest(),
                self.source_import_evidence.project_source_sha256,
            ),
            (
                hashlib.sha256(self.source_payload.schematic_payload).hexdigest(),
                self.source_import_evidence.schematic_source_sha256,
            ),
            (
                hashlib.sha256(self.source_payload.board_payload).hexdigest(),
                self.source_import_evidence.board_source_sha256,
            ),
        )
        if any(actual != expected for actual, expected in raw_source_pairs):
            raise ImportMappingInvariantError(
                "candidate raw source bytes do not match their import evidence digests"
            )
        try:
            reparsed_source = import_project_bundle(
                self.source_payload,
                unsupported_policy=UnsupportedPolicy.MANIFEST,
            )
        except Exception as exc:
            raise ImportMappingInvariantError(
                "candidate raw source payload cannot be deterministically reparsed"
            ) from exc
        if (
            reparsed_source.bundle != self.source_bundle
            or reparsed_source.evidence != self.source_import_evidence
        ):
            raise ImportMappingInvariantError(
                "candidate raw source reparse does not reproduce its exact bundle and evidence"
            )
        if self.source_bundle.diagnostics.manifest_sha256 != self.diagnostics_manifest_sha256:
            raise ImportMappingInvariantError(
                "candidate retained source diagnostics do not match their digest"
            )
        if self.source_import_evidence.evidence_sha256 != self.source_import_evidence_sha256:
            raise ImportMappingInvariantError(
                "candidate retained import evidence does not match its evidence digest"
            )
        source_evidence_pairs = (
            (
                self.source_import_evidence.project_ir_sha256,
                self.source_bundle.manifest.normalized_ir_sha256,
            ),
            (
                self.source_import_evidence.schematic_ir_sha256,
                self.source_bundle.schematic.normalized_ir_sha256,
            ),
            (
                self.source_import_evidence.board_ir_sha256,
                self.source_bundle.board.normalized_ir_sha256,
            ),
            (
                self.source_import_evidence.bundle_ir_sha256,
                self.source_bundle.normalized_ir_sha256,
            ),
            (
                self.source_import_evidence.diagnostics_manifest_sha256,
                self.source_bundle.diagnostics.manifest_sha256,
            ),
        )
        if any(actual != expected for actual, expected in source_evidence_pairs):
            raise ImportMappingInvariantError(
                "candidate retained import evidence does not bind its source bundle"
            )
        if self.graph.project_id != self.project_id or self.graph.graph_hash != self.graph_sha256:
            raise ImportMappingInvariantError("candidate graph identity or digest is inconsistent")
        if type(self.provenance_bindings) is not tuple or any(
            type(item) is not ComponentProvenanceBinding for item in self.provenance_bindings
        ):
            raise ImportMappingInvariantError(
                "candidate provenance bindings must be an immutable binding tuple"
            )
        if (
            tuple(
                sorted(
                    self.provenance_bindings,
                    key=lambda item: (
                        item.source_footprint_id,
                        item.component_evidence_id,
                        item.component_id,
                    ),
                )
            )
            != self.provenance_bindings
        ):
            raise ImportMappingInvariantError("candidate provenance bindings must be sorted")
        for label, values in (
            (
                "candidate binding source footprint IDs",
                tuple(item.source_footprint_id for item in self.provenance_bindings),
            ),
            (
                "candidate binding evidence IDs",
                tuple(item.component_evidence_id for item in self.provenance_bindings),
            ),
            (
                "candidate binding component IDs",
                tuple(item.component_id for item in self.provenance_bindings),
            ),
        ):
            if len(values) != len(set(values)):
                raise ImportMappingInvariantError(f"{label} must be unique")
        components = {item.component_id: item for item in self.graph.components}
        source_footprints = {
            item.footprint_id: item for item in self.source_bundle.board.footprints
        }
        source_symbols = {item.reference: item for item in self.source_bundle.schematic.symbols}
        proven_no_connect_ids = proven_no_connect_board_net_ids(self.source_bundle)
        namespace = resolve_root_sheet_namespace(
            self.source_bundle,
            ignored_board_net_ids=proven_no_connect_ids,
        )
        if namespace.issues:
            raise ImportMappingInvariantError(
                "candidate source bundle has unresolved PCB/schematic net namespace semantics"
            )
        canonical_net_id_by_board_net_id = namespace.canonical_net_id_by_board_net_id
        canonical_net_name_by_board_net_id = namespace.canonical_net_name_by_board_net_id
        expected_graph_nets = {
            (logical_id, logical_name)
            for _raw_id, logical_id, logical_name in namespace.mappings
        }
        if {(item.net_id, item.name) for item in self.graph.nets} != expected_graph_nets:
            raise ImportMappingInvariantError(
                "candidate graph net population is not the exact logical source namespace"
            )
        graph_tracks = {item.track_id: item for item in self.graph.tracks}
        if set(graph_tracks) != {
            item.segment_id for item in self.source_bundle.board.segments
        } or any(
            graph_tracks[item.segment_id].net_id
            != canonical_net_id_by_board_net_id[item.net_id]
            for item in self.source_bundle.board.segments
        ):
            raise ImportMappingInvariantError(
                "candidate tracks do not preserve exact source segment net identity"
            )
        graph_vias = {item.via_id: item for item in self.graph.vias}
        if set(graph_vias) != {item.via_id for item in self.source_bundle.board.vias} or any(
            graph_vias[item.via_id].net_id
            != canonical_net_id_by_board_net_id[item.net_id]
            for item in self.source_bundle.board.vias
        ):
            raise ImportMappingInvariantError(
                "candidate vias do not preserve exact source via net identity"
            )
        graph_zones = {item.zone_id: item for item in self.graph.zones}
        if set(graph_zones) != {item.zone_id for item in self.source_bundle.board.zones} or any(
            graph_zones[item.zone_id].net_id
            != canonical_net_id_by_board_net_id[item.net_id]
            for item in self.source_bundle.board.zones
        ):
            raise ImportMappingInvariantError(
                "candidate zones do not preserve exact source zone net identity"
            )
        source_schematic_wire_bindings = tuple(
            (wire_id, net.net_id)
            for net in self.source_bundle.schematic.nets
            for wire_id in net.wire_ids
        )
        source_schematic_net_id_by_wire = dict(source_schematic_wire_bindings)
        if len(source_schematic_net_id_by_wire) != len(
            source_schematic_wire_bindings
        ):
            raise ImportMappingInvariantError(
                "candidate source assigns a schematic wire to multiple nets"
            )
        graph_schematic_wires = {
            item.wire_id: item for item in self.graph.schematic_wires
        }
        if set(graph_schematic_wires) != set(source_schematic_net_id_by_wire) or any(
            graph_schematic_wires[wire_id].net_id != net_id
            for wire_id, net_id in source_schematic_net_id_by_wire.items()
        ):
            raise ImportMappingInvariantError(
                "candidate schematic wires do not preserve exact logical net identity"
            )
        source_schematic_junction_bindings = tuple(
            (junction_id, net.net_id)
            for net in self.source_bundle.schematic.nets
            for junction_id in net.junction_ids
        )
        source_schematic_net_id_by_junction = dict(
            source_schematic_junction_bindings
        )
        if len(source_schematic_net_id_by_junction) != len(
            source_schematic_junction_bindings
        ):
            raise ImportMappingInvariantError(
                "candidate source assigns a schematic junction to multiple nets"
            )
        graph_schematic_junctions = {
            item.junction_id: item for item in self.graph.schematic_junctions
        }
        if set(graph_schematic_junctions) != set(
            source_schematic_net_id_by_junction
        ) or any(
            graph_schematic_junctions[junction_id].net_id != net_id
            for junction_id, net_id in source_schematic_net_id_by_junction.items()
        ):
            raise ImportMappingInvariantError(
                "candidate schematic junctions do not preserve exact logical net identity"
            )
        no_connect_positions = {
            item.position for item in self.source_bundle.schematic.no_connects
        }
        explicit_no_connect_pins = {
            (symbol.symbol_id, pin.number)
            for symbol in self.source_bundle.schematic.symbols
            for pin in symbol.pins
            if pin.position in no_connect_positions
        }
        source_schematic_net_names: dict[tuple[str, str], str] = {}
        for net in self.source_bundle.schematic.nets:
            if net.name is None:
                continue
            for pin_ref in net.pin_refs:
                source_schematic_net_names[(pin_ref.symbol_id, pin_ref.pin_number)] = net.name
        if set(components) != {item.component_id for item in self.provenance_bindings}:
            raise ImportMappingInvariantError(
                "candidate provenance bindings must cover every exact graph component"
            )
        for binding in self.provenance_bindings:
            component = components[binding.component_id]
            request = binding.request
            if request.source_bundle_ir_sha256 != self.source_bundle_ir_sha256:
                raise ImportMappingInvariantError(
                    "candidate provenance request does not bind the exact source bundle"
                )
            if request.source_footprint_id != binding.source_footprint_id:
                raise ImportMappingInvariantError(
                    "candidate binding source footprint disagrees with its request"
                )
            source_footprint = source_footprints.get(request.source_footprint_id)
            if source_footprint is None:
                raise ImportMappingInvariantError(
                    "candidate provenance request names an unknown source footprint"
                )
            source_symbol = source_symbols.get(source_footprint.reference)
            if source_symbol is None:
                raise ImportMappingInvariantError(
                    "candidate provenance request source footprint lacks a schematic symbol"
                )
            if (
                request.reference != source_footprint.reference
                or request.reference != source_symbol.reference
                or request.value != source_footprint.value
                or request.value != source_symbol.value
                or request.footprint_library_id != source_footprint.library_id
                or request.footprint_library_id != source_symbol.footprint
                or request.schematic_symbol_instance_id != source_symbol.symbol_id
                or request.schematic_library_id != source_symbol.library_id
            ):
                raise ImportMappingInvariantError(
                    "candidate provenance request identity disagrees with retained source facts"
                )
            if (
                request.reference != component.reference
                or request.value != component.value
                or request.footprint_library_id != component.footprint_id
                or request.schematic_library_id != component.symbol_id
            ):
                raise ImportMappingInvariantError(
                    "candidate provenance request disagrees with its graph component identity"
                )
            if (
                binding.manufacturer_part_number != component.manufacturer_part_number
                or binding.datasheet_sha256 != component.datasheet_sha256
                or binding.pin_map_sha256 != component.pin_map_sha256
                or binding.symbol_id != component.symbol_id
                or binding.footprint_id != component.footprint_id
            ):
                raise ImportMappingInvariantError(
                    "candidate provenance binding disagrees with its graph component"
                )
            component_pins = {item.number: item for item in component.pins}
            request_pins = {item.pin_number: item for item in request.pins}
            source_pins = {item.number: item for item in source_symbol.pins}
            source_pads_by_number: dict[str, list[SourcePad]] = {}
            for source_pad in source_footprint.pads:
                if (
                    source_pad.kind is not PadKind.NPTH
                    and bool(source_pad.number)
                ):
                    source_pads_by_number.setdefault(source_pad.number, []).append(source_pad)
            if set(component_pins) != set(request_pins):
                raise ImportMappingInvariantError(
                    "candidate provenance request pin population disagrees with its component"
                )
            if set(request_pins) != set(source_pins) or {
                item.pad_number for item in request.pins
            } != set(source_pads_by_number):
                raise ImportMappingInvariantError(
                    "candidate provenance request pin-pad population disagrees "
                    "with retained source facts"
                )
            graph_pads_by_number: dict[str, list[FootprintPad]] = {}
            for graph_pad in self.graph.pads:
                if graph_pad.component_id == component.component_id:
                    graph_pads_by_number.setdefault(graph_pad.pad_number, []).append(graph_pad)
            if set(graph_pads_by_number) != {item.pad_number for item in request.pins}:
                raise ImportMappingInvariantError(
                    "candidate provenance request pad population disagrees with its graph"
                )
            pin_net_names: dict[str, str] = {}
            graph_net_names = {item.net_id: item.name for item in self.graph.nets}
            for net in self.graph.nets:
                for member in net.members:
                    if member.component_id == component.component_id:
                        pin_net_names[member.pin_number] = net.name
            for pin_number, request_pin in request_pins.items():
                component_pin = component_pins[pin_number]
                source_pin = source_pins[pin_number]
                source_pads = source_pads_by_number[request_pin.pad_number]
                graph_pads = graph_pads_by_number[request_pin.pad_number]
                if (
                    component_pin.pad_number != request_pin.pad_number
                    or component_pin.name != request_pin.pin_name
                    or component_pin.electrical_type != request_pin.electrical_type
                ):
                    raise ImportMappingInvariantError(
                        "candidate provenance request pin facts disagree with its component"
                    )
                source_pad_net_names = {
                    (
                        None
                        if source_pad.net_id is None
                        or source_pad.net_id in proven_no_connect_ids
                        else canonical_net_name_by_board_net_id[source_pad.net_id]
                    )
                    for source_pad in source_pads
                }
                source_is_explicit_nc = (
                    source_symbol.symbol_id,
                    source_pin.number,
                ) in explicit_no_connect_pins
                if (
                    request_pin.pin_name != source_pin.name
                    or request_pin.electrical_type != source_pin.electrical_type
                    or any(
                        request_pin.pad_number != source_pad.number for source_pad in source_pads
                    )
                    or request_pin.net_name
                    != source_schematic_net_names.get((source_symbol.symbol_id, source_pin.number))
                    or source_pad_net_names != {request_pin.net_name}
                    or (
                        source_is_explicit_nc
                        and (
                            request_pin.electrical_type != "no_connect"
                            or component_pin.required
                            or request_pin.net_name is not None
                        )
                    )
                    or (
                        not source_is_explicit_nc and request_pin.net_name is None
                    )
                ):
                    raise ImportMappingInvariantError(
                        "candidate provenance request pin facts disagree with retained source facts"
                    )
                if {pad.pad_id for pad in graph_pads} != {pad.pad_id for pad in source_pads}:
                    raise ImportMappingInvariantError(
                        "candidate physical pad identities disagree with retained source facts"
                    )
                pad_net_names = {
                    None if pad.net_id is None else graph_net_names[pad.net_id]
                    for pad in graph_pads
                }
                if pin_net_names.get(pin_number) != request_pin.net_name or pad_net_names != {
                    request_pin.net_name
                }:
                    raise ImportMappingInvariantError(
                        "candidate provenance request named-net facts disagree with its graph"
                    )
            expected_evidence = stable_hash(
                {
                    "request_sha256": binding.request_sha256,
                    "evidence_id": binding.component_evidence_id,
                    "resolver_id": binding.resolver_id,
                    "trust_snapshot_sha256": binding.trust_snapshot_sha256,
                    "component": component,
                },
                domain="flux-clone-trusted-component-resolution-v1",
            )
            if expected_evidence != binding.evidence_sha256:
                raise ImportMappingInvariantError(
                    "candidate binding evidence does not bind its exact component"
                )
        expected_set = stable_hash(
            self.provenance_bindings,
            domain="flux-clone-component-provenance-set-v1",
        )
        if expected_set != self.provenance_set_sha256:
            raise ImportMappingInvariantError("candidate provenance-set digest is inconsistent")
        if self.kicad_execution != "not-run":
            raise ImportMappingInvariantError("canonical mapping cannot claim KiCad execution")
        if self.manufacturing_release_eligible is not False:
            raise ImportMappingInvariantError(
                "canonical mapping cannot authorize manufacturing release"
            )

    @property
    def candidate_sha256(self) -> str:
        return stable_hash(
            {
                "project_id": self.project_id,
                "base_revision": self.base_revision,
                "authorized_actor": self.authorized_actor,
                "source_bundle_ir_sha256": self.source_bundle_ir_sha256,
                "source_import_evidence_sha256": self.source_import_evidence_sha256,
                "diagnostics_manifest_sha256": self.diagnostics_manifest_sha256,
                "graph_sha256": self.graph_sha256,
                "provenance_set_sha256": self.provenance_set_sha256,
                "kicad_execution": self.kicad_execution,
                "manufacturing_release_eligible": self.manufacturing_release_eligible,
            },
            domain="flux-clone-canonical-import-candidate-v1",
        )


@dataclass(frozen=True, slots=True)
class CanonicalImportTransactionInput:
    """Commands that populate an exact empty canonical graph.

    This is input to a future isolated staging boundary, not an applied
    transaction.  The expected empty graph digest is an explicit precondition.
    """

    transaction_id: str
    base_revision: str
    authorized_actor: str
    expected_empty_graph_sha256: str
    candidate_sha256: str
    prospective_graph_sha256: str
    commands: tuple[DesignCommand, ...]
    commands_sha256: str

    def __post_init__(self) -> None:
        _require_id(self.transaction_id, "import transaction ID")
        _require_id(self.authorized_actor, "import transaction authorized actor")
        for value, label in (
            (self.base_revision, "import transaction base revision"),
            (self.expected_empty_graph_sha256, "expected empty graph digest"),
            (self.candidate_sha256, "transaction candidate digest"),
            (self.prospective_graph_sha256, "prospective graph digest"),
            (self.commands_sha256, "import commands digest"),
        ):
            _require_sha256(value, label)
        if type(self.commands) is not tuple or any(
            type(item) is not DesignCommand for item in self.commands
        ):
            raise ImportMappingInvariantError(
                "import commands must be an immutable DesignCommand tuple"
            )
        if any(
            command.transaction_id != self.transaction_id
            or command.base_revision != self.base_revision
            for command in self.commands
        ):
            raise ImportMappingInvariantError(
                "import commands must bind the exact transaction and base revision"
            )
        if any(command.actor != self.authorized_actor for command in self.commands):
            raise ImportMappingInvariantError(
                "every import command actor must equal the trusted authorized actor"
            )
        command_ids = tuple(item.command_id for item in self.commands)
        idempotency_keys = tuple(item.idempotency_key for item in self.commands)
        if len(command_ids) != len(set(command_ids)):
            raise ImportMappingInvariantError("import command IDs must be unique")
        if len(idempotency_keys) != len(set(idempotency_keys)):
            raise ImportMappingInvariantError("import idempotency keys must be unique")
        expected_commands = stable_hash(
            tuple(command.command_hash for command in self.commands),
            domain="flux-clone-canonical-import-commands-v1",
        )
        if expected_commands != self.commands_sha256:
            raise ImportMappingInvariantError("import commands digest is inconsistent")


@dataclass(frozen=True, slots=True)
class ImportMappingResult:
    source_bundle_ir_sha256: str
    authorized_actor: str
    candidate: CanonicalImportCandidate | None
    transaction_input: CanonicalImportTransactionInput | None
    blockers: tuple[MappingIssue, ...]
    advisories: tuple[MappingIssue, ...]
    mapper_issuance_seal: MappingIssuanceSeal = field(repr=False, compare=False)
    kicad_execution: str = "not-run"
    manufacturing_release_eligible: bool = False

    def __post_init__(self) -> None:
        _require_sha256(self.source_bundle_ir_sha256, "mapping source bundle digest")
        _require_id(self.authorized_actor, "mapping authorized actor")
        if self.candidate is not None and type(self.candidate) is not CanonicalImportCandidate:
            raise ImportMappingInvariantError("mapping candidate has an invalid type")
        if (
            self.candidate is not None
            and self.candidate.source_bundle_ir_sha256 != self.source_bundle_ir_sha256
        ):
            raise ImportMappingInvariantError(
                "mapping result source digest must bind the exact candidate source"
            )
        if self.candidate is not None and self.candidate.authorized_actor != self.authorized_actor:
            raise ImportMappingInvariantError(
                "mapping candidate must bind the trusted authorized actor"
            )
        if (
            self.transaction_input is not None
            and type(self.transaction_input) is not CanonicalImportTransactionInput
        ):
            raise ImportMappingInvariantError("mapping transaction input has an invalid type")
        for label, values in (
            ("mapping blockers", self.blockers),
            ("mapping advisories", self.advisories),
        ):
            if type(values) is not tuple or any(
                type(item) is not MappingIssue for item in values
            ):
                raise ImportMappingInvariantError(f"{label} must be MappingIssue tuples")
            if tuple(sorted(set(values))) != values:
                raise ImportMappingInvariantError(f"{label} must be sorted and unique")
        if self.transaction_input is not None:
            if self.candidate is None or self.blockers:
                raise ImportMappingInvariantError(
                    "transaction input requires a blocker-free candidate"
                )
            if self.transaction_input.candidate_sha256 != self.candidate.candidate_sha256:
                raise ImportMappingInvariantError("transaction input must bind the exact candidate")
            if self.transaction_input.base_revision != self.candidate.base_revision:
                raise ImportMappingInvariantError(
                    "transaction input must bind the candidate base revision"
                )
            if (
                self.transaction_input.authorized_actor != self.candidate.authorized_actor
                or self.transaction_input.authorized_actor != self.authorized_actor
            ):
                raise ImportMappingInvariantError(
                    "transaction input must bind the trusted authorized actor"
                )
            if self.transaction_input.prospective_graph_sha256 != self.candidate.graph_sha256:
                raise ImportMappingInvariantError(
                    "transaction input must bind the candidate prospective graph"
                )
            empty_graph = DesignGraph(1, self.candidate.project_id).normalized()
            if self.transaction_input.expected_empty_graph_sha256 != empty_graph.graph_hash:
                raise ImportMappingInvariantError(
                    "transaction input empty-base precondition is inconsistent"
                )
            expected_empty_revision = stable_hash(
                {"parent": None, "sequence": 0, "graph_hash": empty_graph.graph_hash},
                domain="flux-clone-design-revision-v1",
            )
            if self.transaction_input.base_revision != expected_empty_revision:
                raise ImportMappingInvariantError(
                    "transaction input base is not the proven empty genesis revision"
                )
            # The engine's command application function is pure: it returns a
            # new graph and does not touch a DesignKernel instance.  Replaying
            # here proves that the typed input, from its declared empty base,
            # produces the exact candidate rather than merely naming its hash.
            replay = empty_graph
            for command in self.transaction_input.commands:
                try:
                    next_graph = DesignKernel._apply(  # pyright: ignore[reportPrivateUsage]
                        replay, command
                    ).normalized()
                    validate_graph(next_graph)
                except Exception as exc:
                    raise ImportMappingInvariantError(
                        "transaction input command replay failed"
                    ) from exc
                if next_graph == replay:
                    raise ImportMappingInvariantError(
                        "transaction input contains a command with no semantic effect"
                    )
                replay = next_graph
            if replay != self.candidate.graph:
                raise ImportMappingInvariantError(
                    "transaction input does not replay to the exact candidate graph"
                )
        if self.kicad_execution != "not-run":
            raise ImportMappingInvariantError("mapping cannot claim KiCad execution")
        if self.manufacturing_release_eligible is not False:
            raise ImportMappingInvariantError("mapping cannot authorize manufacturing release")
        if (
            type(self.mapper_issuance_seal) is not MappingIssuanceSeal
            or not self.mapper_issuance_seal.is_deterministic_mapper_issuance
            or self.mapper_issuance_seal.mapping_sha256 != self.mapping_sha256
        ):
            raise ImportMappingInvariantError(
                "mapping result was not issued by the deterministic mapper boundary"
            )

    @classmethod
    def _issue(
        cls,
        *,
        source_bundle_ir_sha256: str,
        authorized_actor: str,
        candidate: CanonicalImportCandidate | None,
        transaction_input: CanonicalImportTransactionInput | None,
        blockers: tuple[MappingIssue, ...],
        advisories: tuple[MappingIssue, ...],
        kicad_execution: str = "not-run",
        manufacturing_release_eligible: bool = False,
    ) -> ImportMappingResult:
        mapping_sha256 = cls._mapping_sha256_for(
            source_bundle_ir_sha256=source_bundle_ir_sha256,
            authorized_actor=authorized_actor,
            candidate=candidate,
            transaction_input=transaction_input,
            blockers=blockers,
            advisories=advisories,
            kicad_execution=kicad_execution,
            manufacturing_release_eligible=manufacturing_release_eligible,
        )
        return cls(
            source_bundle_ir_sha256=source_bundle_ir_sha256,
            authorized_actor=authorized_actor,
            candidate=candidate,
            transaction_input=transaction_input,
            blockers=blockers,
            advisories=advisories,
            mapper_issuance_seal=_mint_mapper_seal(mapping_sha256),
            kicad_execution=kicad_execution,
            manufacturing_release_eligible=manufacturing_release_eligible,
        )

    @staticmethod
    def _mapping_sha256_for(
        *,
        source_bundle_ir_sha256: str,
        authorized_actor: str,
        candidate: CanonicalImportCandidate | None,
        transaction_input: CanonicalImportTransactionInput | None,
        blockers: tuple[MappingIssue, ...],
        advisories: tuple[MappingIssue, ...],
        kicad_execution: str,
        manufacturing_release_eligible: bool,
    ) -> str:
        return stable_hash(
            {
                "source_bundle_ir_sha256": source_bundle_ir_sha256,
                "authorized_actor": authorized_actor,
                "candidate_sha256": (None if candidate is None else candidate.candidate_sha256),
                "transaction_commands_sha256": (
                    None if transaction_input is None else transaction_input.commands_sha256
                ),
                "blockers": blockers,
                "advisories": advisories,
                "kicad_execution": kicad_execution,
                "manufacturing_release_eligible": manufacturing_release_eligible,
            },
            domain="flux-clone-canonical-import-mapping-result-v1",
        )

    @property
    def stage_eligible(self) -> bool:
        return (
            self.candidate is not None and not self.blockers and self.transaction_input is not None
        )

    @property
    def mapping_sha256(self) -> str:
        return self._mapping_sha256_for(
            source_bundle_ir_sha256=self.source_bundle_ir_sha256,
            authorized_actor=self.authorized_actor,
            candidate=self.candidate,
            transaction_input=self.transaction_input,
            blockers=self.blockers,
            advisories=self.advisories,
            kicad_execution=self.kicad_execution,
            manufacturing_release_eligible=self.manufacturing_release_eligible,
        )

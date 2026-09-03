"""Durable, consistency-checked evidence for provenance-bound mappings.

This boundary records what the isolated mapper proved.  It deliberately has
no approval, staging, kernel, filesystem, or manufacturing-release authority.
The only lifecycle mutation is terminal invalidation of an active record.

The domain-separated hashes and append-only SQLite triggers detect accidental
or partial mutation.  They are not an authenticity boundary against a writer
that can replace the database and recompute every unkeyed hash.  The database
path is trusted host configuration; deployments needing protection from a
hostile database writer must anchor or authenticate evidence outside this file.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from threading import RLock
from time import monotonic, sleep
from typing import Any, ClassVar, Protocol, TypeGuard, cast, runtime_checkable

from backend.design_kernel import (
    CommandKind,
    DesignCommand,
    DesignGraph,
    DesignKernel,
    FootprintPad,
    stable_hash,
    validate_graph,
)
from backend.design_kernel.model import canonical_json
from backend.interchange_artifacts import ArtifactKind
from backend.kicad_import_candidates import (
    CandidateRepositoryError,
    CandidateState,
    ImportCandidate,
    ImportCandidateDraft,
)
from backend.kicad_project import BundleImportEvidence
from backend.kicad_project.model import auxiliary_files_sha256
from backend.project_store.codec import graph_from_payload, graph_payload

from .model import (
    ComponentProvenanceBinding,
    ComponentProvenanceRequest,
    ImportMappingResult,
    MappingIssuanceSeal,
    MappingIssue,
    SourcePinPadBinding,
    mint_restored_mapping_seal,
)

MAPPING_EVIDENCE_STORE_SCHEMA_VERSION = 3
_APPLICATION_ID = 0x464D4553  # "FMES": Flux Mapping Evidence Store
_SCHEMA_NAME = "flux-clone-canonical-mapping-evidence"
_ZERO_DIGEST = "0" * 64
_PUBLIC_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_ARTIFACT_ID = re.compile(r"artifact_[0-9a-f]{32}")
_IMPORT_CANDIDATE_ID = re.compile(r"import_candidate_[0-9a-f]{32}")
_MAPPING_EVIDENCE_ID = re.compile(r"mapping_evidence_[0-9a-f]{32}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_IDENTITY_DOMAIN = "flux-clone.canonical-mapping-evidence.identity.v1"
_EVENT_DOMAIN = "flux-clone.canonical-mapping-evidence.event.v1"
_MAPPER_CANDIDATE_DOMAIN = "flux-clone-canonical-import-candidate-v1"
_MAPPER_RESULT_DOMAIN = "flux-clone-canonical-import-mapping-result-v1"
_COMMANDS_DOMAIN = "flux-clone-canonical-import-commands-v1"
_PROVENANCE_SET_DOMAIN = "flux-clone-component-provenance-set-v1"
_TRUSTED_RESOLUTION_DOMAIN = "flux-clone-trusted-component-resolution-v1"
_INSPECTION_RECEIPT_DOMAIN = b"flux-clone-kicad-inspection-receipt-v1\0"
_SOURCE_IMPORT_EVIDENCE_DOMAIN = "flux-clone-kicad-project-import-evidence-v1"
_EMPTY_AUXILIARY_SOURCE_MANIFEST_SHA256 = auxiliary_files_sha256(())


class MappingEvidenceStoreError(RuntimeError):
    """Base failure with a stable application-facing code."""

    code: ClassVar[str] = "mapping_evidence_store_error"


class InvalidMappingEvidence(MappingEvidenceStoreError):
    code = "invalid_mapping_evidence"


class MappingEvidenceNotFound(MappingEvidenceStoreError):
    code = "mapping_evidence_not_found"


class MappingEvidenceConcurrencyConflict(MappingEvidenceStoreError):
    code = "mapping_evidence_revision_conflict"


class IllegalMappingEvidenceTransition(MappingEvidenceStoreError):
    code = "illegal_mapping_evidence_transition"


class MappingEvidenceIntegrityError(MappingEvidenceStoreError):
    code = "mapping_evidence_integrity_error"


class MappingEvidenceStoreUnavailable(MappingEvidenceStoreError):
    code = "mapping_evidence_store_unavailable"


class UnsupportedMappingEvidenceStoreSchema(MappingEvidenceStoreError):
    code = "mapping_evidence_store_schema_unsupported"


class MappingEvidenceState(str, Enum):  # noqa: UP042 - preserve public Enum string behavior
    ACTIVE = "active"
    INVALIDATED = "invalidated"


class MappingEvidenceEventKind(str, Enum):  # noqa: UP042 - preserve public Enum string behavior
    CREATED = "created"
    INVALIDATED = "invalidated"


def _require_public_id(value: object, label: str) -> str:
    if not isinstance(value, str) or _PUBLIC_ID.fullmatch(value) is None:
        raise InvalidMappingEvidence(f"{label} must be a canonical public identifier")
    return value


def _require_artifact_id(value: object) -> str:
    if not isinstance(value, str) or _ARTIFACT_ID.fullmatch(value) is None:
        raise InvalidMappingEvidence("source artifact ID is invalid")
    return value


def _require_import_candidate_id(value: object) -> str:
    if not isinstance(value, str) or _IMPORT_CANDIDATE_ID.fullmatch(value) is None:
        raise InvalidMappingEvidence("import candidate ID is invalid")
    return value


def _require_mapping_evidence_id(value: object) -> str:
    if not isinstance(value, str) or _MAPPING_EVIDENCE_ID.fullmatch(value) is None:
        raise InvalidMappingEvidence("mapping evidence ID is invalid")
    return value


def _require_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise InvalidMappingEvidence(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_nonnegative_int(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise InvalidMappingEvidence(f"{label} must be a non-negative integer")
    return value


def _require_text(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or unicodedata.normalize("NFC", value) != value
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise InvalidMappingEvidence(f"{label} must be non-empty canonical text")
    return value


def _require_time(value: object, label: str) -> datetime:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise InvalidMappingEvidence(f"{label} must be timezone-aware")
    return value


def _encode_time(value: datetime) -> str:
    _require_time(value, "timestamp")
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def _decode_time(value: object) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise MappingEvidenceIntegrityError(
            "persisted mapping evidence timestamp is not canonical UTC text"
        )
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise MappingEvidenceIntegrityError(
            "persisted mapping evidence timestamp is invalid"
        ) from exc
    try:
        canonical = _encode_time(parsed)
    except InvalidMappingEvidence as exc:
        raise MappingEvidenceIntegrityError(
            "persisted mapping evidence timestamp is invalid"
        ) from exc
    if canonical != value:
        raise MappingEvidenceIntegrityError(
            "persisted mapping evidence timestamp is not canonical"
        )
    return parsed


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise MappingEvidenceIntegrityError(
                "persisted mapping evidence JSON has a duplicate object key"
            )
        result[key] = value
    return result


def _reject_float(value: str) -> None:
    raise MappingEvidenceIntegrityError(
        f"floating-point mapping evidence is forbidden: {value}"
    )


def _load_canonical_json(source: object, label: str) -> object:
    if not isinstance(source, str):
        raise MappingEvidenceIntegrityError(f"persisted {label} must be JSON text")
    try:
        value = json.loads(
            source,
            object_pairs_hook=_json_object,
            parse_float=_reject_float,
            parse_constant=_reject_float,
        )
    except MappingEvidenceIntegrityError:
        raise
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise MappingEvidenceIntegrityError(
            f"persisted {label} is not valid JSON"
        ) from exc
    try:
        encoded = canonical_json(value)
    except CandidateRepositoryError as exc:
        raise MappingEvidenceIntegrityError(
            f"persisted {label} is not canonical data"
        ) from exc
    if encoded != source:
        raise MappingEvidenceIntegrityError(
            f"persisted {label} does not use canonical JSON"
        )
    return value


def _source_evidence_from_payload(value: object) -> BundleImportEvidence:
    legacy_fields = {
        "board_ir_sha256",
        "board_source_sha256",
        "bundle_ir_sha256",
        "diagnostics_manifest_sha256",
        "kicad_execution",
        "manufacturing_release_eligible",
        "parser_id",
        "project_ir_sha256",
        "project_source_sha256",
        "schematic_ir_sha256",
        "schematic_source_sha256",
    }
    current_fields = legacy_fields | {"auxiliary_source_manifest_sha256"}
    if not isinstance(value, dict):
        raise MappingEvidenceIntegrityError(
            "persisted source-import evidence fields are not exact"
        )
    source_payload = cast(dict[str, object], value)
    actual_fields = frozenset(source_payload)
    if actual_fields not in {frozenset(legacy_fields), frozenset(current_fields)}:
        raise MappingEvidenceIntegrityError(
            "persisted source-import evidence fields are not exact"
        )
    payload: dict[str, object] = dict(source_payload)
    if actual_fields == frozenset(legacy_fields):
        # BundleImportEvidence predates retained auxiliary project libraries.
        # The only faithful interpretation of that exact legacy body is the
        # canonical empty auxiliary-file manifest; never infer non-empty data.
        payload["auxiliary_source_manifest_sha256"] = (
            _EMPTY_AUXILIARY_SOURCE_MANIFEST_SHA256
        )
    try:
        return BundleImportEvidence(
            project_source_sha256=cast(str, payload["project_source_sha256"]),
            schematic_source_sha256=cast(
                str, payload["schematic_source_sha256"]
            ),
            board_source_sha256=cast(str, payload["board_source_sha256"]),
            project_ir_sha256=cast(str, payload["project_ir_sha256"]),
            schematic_ir_sha256=cast(str, payload["schematic_ir_sha256"]),
            board_ir_sha256=cast(str, payload["board_ir_sha256"]),
            bundle_ir_sha256=cast(str, payload["bundle_ir_sha256"]),
            diagnostics_manifest_sha256=cast(
                str, payload["diagnostics_manifest_sha256"]
            ),
            parser_id=cast(str, payload["parser_id"]),
            kicad_execution=cast(str, payload["kicad_execution"]),
            manufacturing_release_eligible=cast(
                bool, payload["manufacturing_release_eligible"]
            ),
            auxiliary_source_manifest_sha256=cast(
                str, payload["auxiliary_source_manifest_sha256"]
            ),
        )
    except (TypeError, ValueError) as exc:
        raise MappingEvidenceIntegrityError(
            "persisted source-import evidence is malformed"
        ) from exc


def _legacy_source_evidence_sha256(evidence: BundleImportEvidence) -> str | None:
    """Return the pre-auxiliary-field digest only for its one safe meaning."""

    if (
        evidence.auxiliary_source_manifest_sha256
        != _EMPTY_AUXILIARY_SOURCE_MANIFEST_SHA256
    ):
        return None
    return stable_hash(
        {
            "board_ir_sha256": evidence.board_ir_sha256,
            "board_source_sha256": evidence.board_source_sha256,
            "bundle_ir_sha256": evidence.bundle_ir_sha256,
            "diagnostics_manifest_sha256": evidence.diagnostics_manifest_sha256,
            "kicad_execution": evidence.kicad_execution,
            "manufacturing_release_eligible": (
                evidence.manufacturing_release_eligible
            ),
            "parser_id": evidence.parser_id,
            "project_ir_sha256": evidence.project_ir_sha256,
            "project_source_sha256": evidence.project_source_sha256,
            "schematic_ir_sha256": evidence.schematic_ir_sha256,
            "schematic_source_sha256": evidence.schematic_source_sha256,
        },
        domain=_SOURCE_IMPORT_EVIDENCE_DOMAIN,
    )


def _source_evidence_sha256_matches(
    evidence: BundleImportEvidence,
    expected_sha256: str,
) -> bool:
    if evidence.evidence_sha256 == expected_sha256:
        return True
    return _legacy_source_evidence_sha256(evidence) == expected_sha256


def _is_string_object_dict(value: object) -> TypeGuard[dict[str, object]]:
    if type(value) is not dict:
        return False
    raw_mapping = cast(dict[object, object], value)
    return all(isinstance(key, str) for key in raw_mapping)


def _mapping_issues_from_payload(value: object) -> tuple[MappingIssue, ...]:
    if not isinstance(value, list):
        raise MappingEvidenceIntegrityError(
            "persisted mapping advisories must be an array"
        )
    expected = {"code", "detail", "entity_id"}
    issues: list[MappingIssue] = []
    for raw_item in cast(list[object], value):
        if not _is_string_object_dict(raw_item) or set(raw_item) != expected:
            raise MappingEvidenceIntegrityError(
                "persisted mapping advisory fields are not exact"
            )
        code = raw_item["code"]
        entity_id = raw_item["entity_id"]
        detail = raw_item["detail"]
        if (
            not isinstance(code, str)
            or not isinstance(entity_id, str)
            or not isinstance(detail, str)
        ):
            raise MappingEvidenceIntegrityError(
                "persisted mapping advisory is malformed"
            )
        try:
            issues.append(MappingIssue(code, entity_id, detail))
        except (TypeError, ValueError) as exc:
            raise MappingEvidenceIntegrityError(
                "persisted mapping advisory is malformed"
            ) from exc
    return tuple(issues)


def _transaction_command_hashes_from_payload(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise MappingEvidenceIntegrityError(
            "persisted transaction command hashes must be a non-empty array"
        )
    try:
        hashes = tuple(
            _require_sha256(item, "persisted transaction command hash")
            for item in cast(list[object], value)
        )
    except InvalidMappingEvidence as exc:
        raise MappingEvidenceIntegrityError(
            "persisted transaction command hashes are malformed"
        ) from exc
    if len(hashes) != len(set(hashes)):
        raise MappingEvidenceIntegrityError(
            "persisted transaction command hashes must be unique"
        )
    return hashes


def _transaction_command_payload(command: DesignCommand) -> dict[str, Any]:
    return {
        "actor": command.actor,
        "base_revision": command.base_revision,
        "command_hash": command.command_hash,
        "command_id": command.command_id,
        "idempotency_key": command.idempotency_key,
        "kind": command.kind.value,
        "payload_json": command.payload_json,
        "transaction_id": command.transaction_id,
    }


def _transaction_commands_from_payload(value: object) -> tuple[DesignCommand, ...]:
    if not isinstance(value, list) or not value:
        raise MappingEvidenceIntegrityError(
            "persisted transaction commands must be a non-empty array"
        )
    expected = {
        "actor",
        "base_revision",
        "command_hash",
        "command_id",
        "idempotency_key",
        "kind",
        "payload_json",
        "transaction_id",
    }
    commands: list[DesignCommand] = []
    try:
        for raw_item in cast(list[object], value):
            if not _is_string_object_dict(raw_item) or set(raw_item) != expected:
                raise MappingEvidenceIntegrityError(
                    "persisted transaction command fields are not exact"
                )
            item = raw_item
            string_fields: dict[str, str] = {}
            for field_name in expected:
                field_value = item[field_name]
                if not isinstance(field_value, str):
                    raise MappingEvidenceIntegrityError(
                        "persisted transaction command fields must be strings"
                    )
                string_fields[field_name] = field_value
            command = DesignCommand(
                command_id=string_fields["command_id"],
                base_revision=string_fields["base_revision"],
                transaction_id=string_fields["transaction_id"],
                actor=string_fields["actor"],
                kind=CommandKind(string_fields["kind"]),
                payload_json=string_fields["payload_json"],
                idempotency_key=string_fields["idempotency_key"],
            )
            if command.command_hash != string_fields["command_hash"]:
                raise MappingEvidenceIntegrityError(
                    "persisted transaction command hash is inconsistent"
                )
            commands.append(command)
    except MappingEvidenceIntegrityError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise MappingEvidenceIntegrityError(
            "persisted transaction command is malformed"
        ) from exc
    return tuple(commands)


def _provenance_bindings_from_payload(
    value: object,
) -> tuple[ComponentProvenanceBinding, ...]:
    if not isinstance(value, list):
        raise MappingEvidenceIntegrityError(
            "persisted trusted resolver evidence must be an array"
        )
    binding_fields = {
        "component_evidence_id",
        "component_id",
        "datasheet_sha256",
        "evidence_sha256",
        "footprint_id",
        "manufacturer_part_number",
        "pin_map_sha256",
        "request",
        "request_sha256",
        "resolver_id",
        "source_footprint_id",
        "symbol_id",
        "trust_snapshot_sha256",
    }
    request_fields = {
        "footprint_library_id",
        "pins",
        "reference",
        "schematic_library_id",
        "schematic_symbol_instance_id",
        "source_bundle_ir_sha256",
        "source_footprint_id",
        "value",
    }
    pin_fields = {
        "electrical_type",
        "net_name",
        "pad_number",
        "pin_name",
        "pin_number",
    }
    bindings: list[ComponentProvenanceBinding] = []
    try:
        for raw_item in cast(list[object], value):
            if not _is_string_object_dict(raw_item) or set(raw_item) != binding_fields:
                raise MappingEvidenceIntegrityError(
                    "persisted trusted resolver binding fields are not exact"
                )
            item = raw_item
            request_payload = item["request"]
            if (
                not _is_string_object_dict(request_payload)
                or set(request_payload) != request_fields
            ):
                raise MappingEvidenceIntegrityError(
                    "persisted resolver request fields are not exact"
                )
            raw_pins_payload = request_payload["pins"]
            if not isinstance(raw_pins_payload, list):
                raise MappingEvidenceIntegrityError(
                    "persisted resolver request pins are malformed"
                )
            pins: list[SourcePinPadBinding] = []
            for raw_pin in cast(list[object], raw_pins_payload):
                if not _is_string_object_dict(raw_pin) or set(raw_pin) != pin_fields:
                    raise MappingEvidenceIntegrityError(
                        "persisted resolver pin fields are not exact"
                    )
                net_name = raw_pin["net_name"]
                if net_name is not None and not isinstance(net_name, str):
                    raise MappingEvidenceIntegrityError(
                        "persisted resolver pin named net is malformed"
                    )
                pin_values = tuple(
                    raw_pin[field]
                    for field in (
                        "pin_number",
                        "pad_number",
                        "pin_name",
                        "electrical_type",
                    )
                )
                if not all(isinstance(field, str) for field in pin_values):
                    raise MappingEvidenceIntegrityError(
                        "persisted resolver pin facts are malformed"
                    )
                pins.append(
                    SourcePinPadBinding(
                        pin_number=cast(str, pin_values[0]),
                        pad_number=cast(str, pin_values[1]),
                        pin_name=cast(str, pin_values[2]),
                        electrical_type=cast(str, pin_values[3]),
                        net_name=net_name,
                    )
                )
            request_strings = {
                field: request_payload[field]
                for field in request_fields - {"pins"}
            }
            if not all(isinstance(field, str) for field in request_strings.values()):
                raise MappingEvidenceIntegrityError(
                    "persisted resolver request facts are malformed"
                )
            request = ComponentProvenanceRequest(
                source_bundle_ir_sha256=cast(str, request_strings["source_bundle_ir_sha256"]),
                source_footprint_id=cast(str, request_strings["source_footprint_id"]),
                reference=cast(str, request_strings["reference"]),
                value=cast(str, request_strings["value"]),
                footprint_library_id=cast(str, request_strings["footprint_library_id"]),
                schematic_symbol_instance_id=cast(
                    str, request_strings["schematic_symbol_instance_id"]
                ),
                schematic_library_id=cast(str, request_strings["schematic_library_id"]),
                pins=tuple(pins),
            )
            binding_strings = {
                field: item[field]
                for field in binding_fields - {"request"}
            }
            if not all(isinstance(field, str) for field in binding_strings.values()):
                raise MappingEvidenceIntegrityError(
                    "persisted trusted resolver binding facts are malformed"
                )
            bindings.append(
                ComponentProvenanceBinding(
                    source_footprint_id=cast(str, binding_strings["source_footprint_id"]),
                    component_evidence_id=cast(str, binding_strings["component_evidence_id"]),
                    request=request,
                    request_sha256=cast(str, binding_strings["request_sha256"]),
                    component_id=cast(str, binding_strings["component_id"]),
                    manufacturer_part_number=cast(
                        str, binding_strings["manufacturer_part_number"]
                    ),
                    datasheet_sha256=cast(str, binding_strings["datasheet_sha256"]),
                    pin_map_sha256=cast(str, binding_strings["pin_map_sha256"]),
                    symbol_id=cast(str, binding_strings["symbol_id"]),
                    footprint_id=cast(str, binding_strings["footprint_id"]),
                    resolver_id=cast(str, binding_strings["resolver_id"]),
                    trust_snapshot_sha256=cast(
                        str, binding_strings["trust_snapshot_sha256"]
                    ),
                    evidence_sha256=cast(str, binding_strings["evidence_sha256"]),
                )
            )
    except MappingEvidenceIntegrityError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise MappingEvidenceIntegrityError(
            "persisted trusted resolver evidence is malformed"
        ) from exc
    return tuple(bindings)


def _validate_provenance_bindings(
    bindings: object,
    *,
    graph: DesignGraph,
    source_bundle_ir_sha256: str,
    expected_set_sha256: str,
) -> tuple[ComponentProvenanceBinding, ...]:
    if not isinstance(bindings, tuple) or any(
        type(item) is not ComponentProvenanceBinding
        for item in cast(tuple[object, ...], bindings)
    ):
        raise InvalidMappingEvidence(
            "trusted resolver evidence must be an immutable binding tuple"
        )
    typed_bindings = cast(tuple[ComponentProvenanceBinding, ...], bindings)
    ordered = tuple(
        sorted(
            typed_bindings,
            key=lambda item: (
                item.source_footprint_id,
                item.component_evidence_id,
                item.component_id,
            ),
        )
    )
    if typed_bindings != ordered:
        raise InvalidMappingEvidence(
            "trusted resolver evidence must be deterministically sorted"
        )
    for label, values in (
        (
            "source footprint IDs",
            tuple(item.source_footprint_id for item in typed_bindings),
        ),
        (
            "component evidence IDs",
            tuple(item.component_evidence_id for item in typed_bindings),
        ),
        ("component IDs", tuple(item.component_id for item in typed_bindings)),
        (
            "schematic symbol instance IDs",
            tuple(
                item.request.schematic_symbol_instance_id for item in typed_bindings
            ),
        ),
    ):
        if len(values) != len(set(values)):
            raise InvalidMappingEvidence(
                f"trusted resolver {label} must be unique"
            )
    components = {item.component_id: item for item in graph.components}
    if set(components) != {item.component_id for item in typed_bindings}:
        raise InvalidMappingEvidence(
            "trusted resolver evidence must cover every canonical component"
        )
    nets = {item.net_id: item for item in graph.nets}
    for binding in typed_bindings:
        component = components[binding.component_id]
        request = binding.request
        if request.source_bundle_ir_sha256 != source_bundle_ir_sha256:
            raise InvalidMappingEvidence(
                "resolver request does not bind the exact source bundle"
            )
        if request.source_footprint_id != binding.source_footprint_id:
            raise InvalidMappingEvidence(
                "resolver binding source footprint disagrees with its request"
            )
        if (
            request.reference != component.reference
            or request.value != component.value
            or request.footprint_library_id != component.footprint_id
            or request.schematic_library_id != component.symbol_id
            or binding.manufacturer_part_number
            != component.manufacturer_part_number
            or binding.datasheet_sha256 != component.datasheet_sha256
            or binding.pin_map_sha256 != component.pin_map_sha256
            or binding.symbol_id != component.symbol_id
            or binding.footprint_id != component.footprint_id
        ):
            raise InvalidMappingEvidence(
                "resolver binding disagrees with its exact canonical component"
            )
        component_pins = {item.number: item for item in component.pins}
        request_pins = {item.pin_number: item for item in request.pins}
        if set(component_pins) != set(request_pins):
            raise InvalidMappingEvidence(
                "resolver request pin population disagrees with its component"
            )
        graph_pads: dict[str, list[FootprintPad]] = {}
        for graph_pad in graph.pads:
            if graph_pad.component_id == component.component_id:
                graph_pads.setdefault(graph_pad.pad_number, []).append(graph_pad)
        if set(graph_pads) != {item.pad_number for item in request.pins}:
            raise InvalidMappingEvidence(
                "resolver request pad population disagrees with its canonical graph"
            )
        pin_net_names: dict[str, str] = {}
        for net in graph.nets:
            for member in net.members:
                if member.component_id != component.component_id:
                    continue
                if member.pin_number in pin_net_names:
                    raise InvalidMappingEvidence(
                        "canonical component pin belongs to more than one net"
                    )
                pin_net_names[member.pin_number] = net.name
        for pin_number, request_pin in request_pins.items():
            component_pin = component_pins[pin_number]
            if (
                component_pin.pad_number != request_pin.pad_number
                or component_pin.name != request_pin.pin_name
                or component_pin.electrical_type != request_pin.electrical_type
            ):
                raise InvalidMappingEvidence(
                    "resolver request pin facts disagree with its component"
                )
            pad_net_names = {
                None if pad.net_id is None else nets[pad.net_id].name
                for pad in graph_pads[request_pin.pad_number]
            }
            if (
                request_pin.net_name != pin_net_names.get(pin_number)
                or pad_net_names != {request_pin.net_name}
            ):
                raise InvalidMappingEvidence(
                    "resolver request named-net facts disagree with its canonical graph"
                )
        expected_evidence = stable_hash(
            {
                "request_sha256": binding.request_sha256,
                "evidence_id": binding.component_evidence_id,
                "resolver_id": binding.resolver_id,
                "trust_snapshot_sha256": binding.trust_snapshot_sha256,
                "component": component,
            },
            domain=_TRUSTED_RESOLUTION_DOMAIN,
        )
        if binding.evidence_sha256 != expected_evidence:
            raise InvalidMappingEvidence(
                "resolver evidence digest does not bind its exact component"
            )
    if stable_hash(typed_bindings, domain=_PROVENANCE_SET_DOMAIN) != expected_set_sha256:
        raise InvalidMappingEvidence(
            "trusted resolver provenance-set digest is inconsistent"
        )
    return typed_bindings


def _managed_inspection_payload(candidate: ImportCandidate) -> dict[str, Any]:
    try:
        payload = candidate.decoded_inspection_payload()
    except Exception as exc:
        raise InvalidMappingEvidence(
            "import candidate inspection payload cannot be decoded"
        ) from exc
    source = payload.get("source")
    evidence = payload.get("evidence")
    format_payload = payload.get("format")
    if not isinstance(source, dict) or not isinstance(evidence, dict):
        raise InvalidMappingEvidence(
            "import candidate lacks exact managed source evidence"
        )
    if not isinstance(format_payload, dict):
        raise InvalidMappingEvidence("import candidate format evidence is malformed")
    expected_context = (
        payload.get("projectId") == candidate.project_id
        and payload.get("expectedProjectRevision")
        == candidate.expected_project_revision
        and payload.get("projectRevision") == candidate.expected_project_revision
        and payload.get("runId") == candidate.run_id
        and payload.get("runRevision") == candidate.expected_run_revision
    )
    if not expected_context:
        raise InvalidMappingEvidence(
            "import candidate inspection context contradicts its immutable subject"
        )
    coordination_context_digest = payload.get("coordinationContextDigest")
    _require_sha256(coordination_context_digest, "coordination context digest")
    if (
        source.get("artifactId") != candidate.artifact_id
        or source.get("sha256") != candidate.artifact_sha256
        or source.get("kind") != candidate.artifact_kind.value
        or evidence.get("sourceSha256") != candidate.artifact_sha256
        or format_payload.get("kind") != candidate.artifact_kind.value
    ):
        raise InvalidMappingEvidence(
            "import candidate inspection contradicts its source artifact"
        )
    if (
        payload.get("mode") != "inspection-only"
        or payload.get("mutatesDesign") is not False
        or payload.get("stageEligible") is not False
        or payload.get("canonicalImportEligible") is not False
        or payload.get("kicadExecution") != "not-run"
        or payload.get("manufacturingReleaseEligible") is not False
    ):
        raise InvalidMappingEvidence(
            "import candidate inspection exceeds inspection-only authority"
        )
    receipt_material = {
        "artifact_id": candidate.artifact_id,
        "inspection_payload_sha256": candidate.inspection_payload_sha256,
        "project_id": candidate.project_id,
        "project_revision": candidate.expected_project_revision,
        "run_id": candidate.run_id,
        "run_revision": candidate.expected_run_revision,
        "source_sha256": candidate.artifact_sha256,
    }
    expected_receipt = hashlib.sha256(
        _INSPECTION_RECEIPT_DOMAIN + canonical_json(receipt_material).encode("utf-8")
    ).hexdigest()
    if candidate.inspection_receipt_digest != expected_receipt:
        raise InvalidMappingEvidence(
            "import candidate inspection receipt does not bind its exact subject"
        )
    managed_inspection = {
        **payload,
        "inspectionPayloadSha256": candidate.inspection_payload_sha256,
        "inspectionReceiptDigest": candidate.inspection_receipt_digest,
        "inspectionReceiptId": f"inspection_{candidate.inspection_receipt_digest[:32]}",
    }
    try:
        verified = ImportCandidateDraft.from_managed_inspection(
            artifact_id=candidate.artifact_id,
            artifact_sha256=candidate.artifact_sha256,
            artifact_kind=candidate.artifact_kind,
            project_id=candidate.project_id,
            expected_project_revision=candidate.expected_project_revision,
            run_id=candidate.run_id,
            expected_run_revision=candidate.expected_run_revision,
            managed_inspection=managed_inspection,
            created_by=candidate.created_by,
        )
    except Exception as exc:
        raise InvalidMappingEvidence(
            "import candidate inspection does not satisfy the closed evidence schema"
        ) from exc
    if (
        verified.candidate_id != candidate.candidate_id
        or verified.candidate_digest != candidate.candidate_digest
        or verified.diagnostics != candidate.diagnostics
        or verified.blockers != candidate.blockers
    ):
        raise InvalidMappingEvidence(
            "import candidate inspection identity cannot be reproduced"
        )
    return payload


def _validate_inspection_to_mapping(
    payload: Mapping[str, object],
    *,
    source_evidence: BundleImportEvidence,
) -> None:
    evidence = payload.get("evidence")
    if not _is_string_object_dict(evidence):
        raise InvalidMappingEvidence("managed source evidence is malformed")
    pairs = (
        (evidence.get("parserId"), source_evidence.parser_id),
        (
            evidence.get("projectSourceSha256"),
            source_evidence.project_source_sha256,
        ),
        (
            evidence.get("schematicSourceSha256"),
            source_evidence.schematic_source_sha256,
        ),
        (evidence.get("boardSourceSha256"), source_evidence.board_source_sha256),
        (evidence.get("projectImportedIrSha256"), source_evidence.project_ir_sha256),
        (
            evidence.get("schematicImportedIrSha256"),
            source_evidence.schematic_ir_sha256,
        ),
        (evidence.get("boardImportedIrSha256"), source_evidence.board_ir_sha256),
        (evidence.get("bundleImportedIrSha256"), source_evidence.bundle_ir_sha256),
        (
            evidence.get("bundleReparsedIrSha256"),
            source_evidence.bundle_ir_sha256,
        ),
        (
            evidence.get("diagnosticsManifestSha256"),
            source_evidence.diagnostics_manifest_sha256,
        ),
        (evidence.get("kicadExecution"), "not-run"),
        (evidence.get("manufacturingReleaseEligible"), False),
    )
    if any(actual != expected for actual, expected in pairs):
        raise InvalidMappingEvidence(
            "managed inspection evidence does not bind the mapper source"
        )
    if (
        evidence.get("semanticParity") is not True
        or evidence.get("diagnosticsParity") is not True
    ):
        raise InvalidMappingEvidence(
            "managed inspection parity fields must be exact true booleans"
        )


@dataclass(frozen=True, slots=True)
class MappingEvidenceDraft:
    """Immutable identity material for one successful mapper invocation."""

    import_candidate_id: str
    import_candidate_digest: str
    import_candidate_state: CandidateState
    import_candidate_generation: int
    import_candidate_last_event_digest: str
    source_artifact_id: str
    source_artifact_sha256: str
    source_artifact_kind: ArtifactKind
    inspection_receipt_digest: str
    project_id: str
    project_revision: str
    run_id: str
    run_revision: int
    coordination_context_digest: str
    source_import_evidence: BundleImportEvidence
    source_import_evidence_sha256: str
    source_bundle_ir_sha256: str
    diagnostics_manifest_sha256: str
    canonical_base_revision: str
    canonical_graph: DesignGraph
    canonical_graph_sha256: str
    mapper_candidate_sha256: str
    provenance_bindings: tuple[ComponentProvenanceBinding, ...]
    provenance_set_sha256: str
    mapping_advisories: tuple[MappingIssue, ...]
    mapper_result_sha256: str
    transaction_id: str
    transaction_commands: tuple[DesignCommand, ...]
    transaction_command_hashes: tuple[str, ...]
    transaction_commands_sha256: str
    authorized_actor: str
    mapper_issuance_seal: MappingIssuanceSeal = field(repr=False, compare=False)
    kicad_execution: str = "not-run"
    manufacturing_release_eligible: bool = False
    staging_authorized: bool = False

    def __post_init__(self) -> None:
        _require_import_candidate_id(self.import_candidate_id)
        _require_sha256(self.import_candidate_digest, "import candidate digest")
        if self.import_candidate_state is not CandidateState.PENDING:
            raise InvalidMappingEvidence(
                "mapping evidence must bind a pending import candidate snapshot"
            )
        _require_nonnegative_int(
            self.import_candidate_generation, "import candidate generation"
        )
        if self.import_candidate_generation != 0:
            raise InvalidMappingEvidence(
                "a pending import candidate must have its creation generation"
            )
        _require_sha256(
            self.import_candidate_last_event_digest,
            "import candidate last-event digest",
        )
        _require_artifact_id(self.source_artifact_id)
        _require_sha256(self.source_artifact_sha256, "source artifact digest")
        if self.source_artifact_kind is not ArtifactKind.KICAD_PROJECT_BUNDLE:
            raise InvalidMappingEvidence(
                "canonical project mapping requires a managed KiCad project bundle"
            )
        _require_sha256(self.inspection_receipt_digest, "inspection receipt digest")
        _require_public_id(self.project_id, "project ID")
        _require_sha256(self.project_revision, "project revision")
        _require_public_id(self.run_id, "run ID")
        _require_nonnegative_int(self.run_revision, "run revision")
        _require_sha256(
            self.coordination_context_digest, "coordination context digest"
        )
        if type(self.source_import_evidence) is not BundleImportEvidence:
            raise InvalidMappingEvidence(
                "source import evidence must be BundleImportEvidence"
            )
        _require_sha256(
            self.source_import_evidence_sha256, "source import evidence digest"
        )
        if not _source_evidence_sha256_matches(
            self.source_import_evidence,
            self.source_import_evidence_sha256,
        ):
            raise InvalidMappingEvidence(
                "source import evidence digest does not match its exact body"
            )
        _require_sha256(self.source_bundle_ir_sha256, "source bundle IR digest")
        _require_sha256(
            self.diagnostics_manifest_sha256, "source diagnostics manifest digest"
        )
        if (
            self.source_import_evidence.bundle_ir_sha256
            != self.source_bundle_ir_sha256
            or self.source_import_evidence.diagnostics_manifest_sha256
            != self.diagnostics_manifest_sha256
        ):
            raise InvalidMappingEvidence(
                "source evidence does not bind the mapped bundle and diagnostics"
            )
        _require_sha256(self.canonical_base_revision, "canonical base revision")
        if self.canonical_base_revision != self.project_revision:
            raise InvalidMappingEvidence(
                "canonical mapping base does not equal the candidate project revision"
            )
        if type(self.canonical_graph) is not DesignGraph:
            raise InvalidMappingEvidence("canonical graph must be DesignGraph")
        try:
            normalized_graph = self.canonical_graph.normalized()
            validate_graph(normalized_graph)
        except Exception as exc:
            raise InvalidMappingEvidence("canonical graph is invalid") from exc
        if self.canonical_graph != normalized_graph:
            raise InvalidMappingEvidence("canonical graph must be normalized")
        if self.canonical_graph.project_id != self.project_id:
            raise InvalidMappingEvidence(
                "canonical graph project disagrees with the mapping subject"
            )
        _require_sha256(self.canonical_graph_sha256, "canonical graph digest")
        if self.canonical_graph.graph_hash != self.canonical_graph_sha256:
            raise InvalidMappingEvidence(
                "canonical graph digest does not match its exact graph"
            )
        _require_sha256(self.mapper_candidate_sha256, "mapper candidate digest")
        _require_sha256(self.provenance_set_sha256, "provenance-set digest")
        _validate_provenance_bindings(
            self.provenance_bindings,
            graph=self.canonical_graph,
            source_bundle_ir_sha256=self.source_bundle_ir_sha256,
            expected_set_sha256=self.provenance_set_sha256,
        )
        if not isinstance(self.mapping_advisories, tuple) or any(  # pyright: ignore[reportUnnecessaryIsInstance]
            type(item) is not MappingIssue for item in self.mapping_advisories
        ):
            raise InvalidMappingEvidence(
                "mapping advisories must be an immutable MappingIssue tuple"
            )
        if tuple(sorted(set(self.mapping_advisories))) != self.mapping_advisories:
            raise InvalidMappingEvidence(
                "mapping advisories must be sorted and unique"
            )
        _require_sha256(self.mapper_result_sha256, "mapper result digest")
        _require_public_id(self.transaction_id, "mapper transaction ID")
        if (
            not isinstance(self.transaction_commands, tuple)  # pyright: ignore[reportUnnecessaryIsInstance]
            or not self.transaction_commands
            or any(type(item) is not DesignCommand for item in self.transaction_commands)
        ):
            raise InvalidMappingEvidence(
                "mapper transaction commands must be a non-empty exact command tuple"
            )
        if (
            not isinstance(self.transaction_command_hashes, tuple)  # pyright: ignore[reportUnnecessaryIsInstance]
            or not self.transaction_command_hashes
        ):
            raise InvalidMappingEvidence(
                "mapper transaction command hashes must be a non-empty immutable tuple"
            )
        for command_hash in self.transaction_command_hashes:
            _require_sha256(command_hash, "mapper transaction command hash")
        if len(self.transaction_command_hashes) != len(
            set(self.transaction_command_hashes)
        ):
            raise InvalidMappingEvidence(
                "mapper transaction command hashes must be unique"
            )
        if tuple(
            command.command_hash for command in self.transaction_commands
        ) != self.transaction_command_hashes:
            raise InvalidMappingEvidence(
                "mapper transaction hashes do not bind the retained command bodies"
            )
        if any(
            command.transaction_id != self.transaction_id
            or command.base_revision != self.canonical_base_revision
            or command.actor != self.authorized_actor
            for command in self.transaction_commands
        ):
            raise InvalidMappingEvidence(
                "retained transaction commands contradict the mapping authority"
            )
        _require_sha256(
            self.transaction_commands_sha256, "mapper transaction-command digest"
        )
        if (
            stable_hash(
                self.transaction_command_hashes,
                domain=_COMMANDS_DOMAIN,
            )
            != self.transaction_commands_sha256
        ):
            raise InvalidMappingEvidence(
                "mapper transaction-command digest does not bind its ordered hashes"
            )
        _require_public_id(self.authorized_actor, "mapping authorized actor")
        if self.kicad_execution != "not-run":
            raise InvalidMappingEvidence(
                "mapping evidence cannot claim KiCad execution"
            )
        if self.manufacturing_release_eligible is not False:
            raise InvalidMappingEvidence(
                "mapping evidence cannot authorize manufacturing release"
            )
        if self.staging_authorized is not False:
            raise InvalidMappingEvidence(
                "mapping evidence cannot authorize canonical staging"
            )
        expected_mapper_candidate = stable_hash(
            {
                "project_id": self.project_id,
                "base_revision": self.canonical_base_revision,
                "authorized_actor": self.authorized_actor,
                "source_bundle_ir_sha256": self.source_bundle_ir_sha256,
                "source_import_evidence_sha256": self.source_import_evidence_sha256,
                "diagnostics_manifest_sha256": self.diagnostics_manifest_sha256,
                "graph_sha256": self.canonical_graph_sha256,
                "provenance_set_sha256": self.provenance_set_sha256,
                "kicad_execution": self.kicad_execution,
                "manufacturing_release_eligible": self.manufacturing_release_eligible,
            },
            domain=_MAPPER_CANDIDATE_DOMAIN,
        )
        if expected_mapper_candidate != self.mapper_candidate_sha256:
            raise InvalidMappingEvidence(
                "mapper candidate digest does not bind the recorded mapping facts"
            )
        expected_mapper_result = stable_hash(
            {
                "source_bundle_ir_sha256": self.source_bundle_ir_sha256,
                "authorized_actor": self.authorized_actor,
                "candidate_sha256": self.mapper_candidate_sha256,
                "transaction_commands_sha256": self.transaction_commands_sha256,
                "blockers": (),
                "advisories": self.mapping_advisories,
                "kicad_execution": self.kicad_execution,
                "manufacturing_release_eligible": self.manufacturing_release_eligible,
            },
            domain=_MAPPER_RESULT_DOMAIN,
        )
        if expected_mapper_result != self.mapper_result_sha256:
            raise InvalidMappingEvidence(
                "mapper result digest does not bind the recorded mapping result"
            )
        if (
            type(self.mapper_issuance_seal) is not MappingIssuanceSeal
            or self.mapper_issuance_seal.mapping_sha256
            != self.mapper_result_sha256
            or not (
                self.mapper_issuance_seal.is_deterministic_mapper_issuance
                or self.mapper_issuance_seal.is_durable_restore
            )
        ):
            raise InvalidMappingEvidence(
                "mapping evidence lacks a sealed mapper or trusted restore origin"
            )
        empty_graph = DesignGraph(1, self.project_id).normalized()
        expected_base_revision = stable_hash(
            {"parent": None, "sequence": 0, "graph_hash": empty_graph.graph_hash},
            domain="flux-clone-design-revision-v1",
        )
        if self.canonical_base_revision != expected_base_revision:
            raise InvalidMappingEvidence(
                "retained transaction base is not the exact empty genesis revision"
            )
        replay = empty_graph
        for command in self.transaction_commands:
            try:
                next_graph = DesignKernel._apply(  # pyright: ignore[reportPrivateUsage]
                    replay, command
                ).normalized()
                validate_graph(next_graph)
            except Exception as exc:
                raise InvalidMappingEvidence(
                    "retained transaction command replay failed"
                ) from exc
            if next_graph == replay:
                raise InvalidMappingEvidence(
                    "retained transaction contains a command with no semantic effect"
                )
            replay = next_graph
        if replay != self.canonical_graph:
            raise InvalidMappingEvidence(
                "retained transaction commands do not replay to the exact canonical graph"
            )

    @classmethod
    def from_mapping(
        cls,
        import_candidate: ImportCandidate,
        mapping_result: ImportMappingResult,
    ) -> MappingEvidenceDraft:
        """Bind one verified pending candidate to one successful mapper result."""

        if type(import_candidate) is not ImportCandidate:
            raise InvalidMappingEvidence(
                "from_mapping requires an exact ImportCandidate"
            )
        if type(mapping_result) is not ImportMappingResult:
            raise InvalidMappingEvidence(
                "from_mapping requires an exact ImportMappingResult"
            )
        mapped = mapping_result.candidate
        transaction_input = mapping_result.transaction_input
        if (
            mapped is None
            or transaction_input is None
            or mapping_result.blockers
            or not mapping_result.stage_eligible
        ):
            raise InvalidMappingEvidence(
                "only a blocker-free, replay-checked mapping can become evidence"
            )
        if (
            import_candidate.state is not CandidateState.PENDING
            or import_candidate.generation != 0
        ):
            raise InvalidMappingEvidence(
                "mapping evidence must precede candidate resolution"
            )
        if (
            import_candidate.project_id != mapped.project_id
            or import_candidate.expected_project_revision != mapped.base_revision
        ):
            raise InvalidMappingEvidence(
                "mapper project or revision contradicts the import candidate"
            )
        payload = _managed_inspection_payload(import_candidate)
        _validate_inspection_to_mapping(
            payload,
            source_evidence=mapped.source_import_evidence,
        )
        coordination_context_digest = payload["coordinationContextDigest"]
        assert isinstance(coordination_context_digest, str)
        return cls(
            import_candidate_id=import_candidate.candidate_id,
            import_candidate_digest=import_candidate.candidate_digest,
            import_candidate_state=import_candidate.state,
            import_candidate_generation=import_candidate.generation,
            import_candidate_last_event_digest=import_candidate.last_event_digest,
            source_artifact_id=import_candidate.artifact_id,
            source_artifact_sha256=import_candidate.artifact_sha256,
            source_artifact_kind=import_candidate.artifact_kind,
            inspection_receipt_digest=import_candidate.inspection_receipt_digest,
            project_id=import_candidate.project_id,
            project_revision=import_candidate.expected_project_revision,
            run_id=import_candidate.run_id,
            run_revision=import_candidate.expected_run_revision,
            coordination_context_digest=coordination_context_digest,
            source_import_evidence=mapped.source_import_evidence,
            source_import_evidence_sha256=mapped.source_import_evidence_sha256,
            source_bundle_ir_sha256=mapped.source_bundle_ir_sha256,
            diagnostics_manifest_sha256=mapped.diagnostics_manifest_sha256,
            canonical_base_revision=mapped.base_revision,
            canonical_graph=mapped.graph,
            canonical_graph_sha256=mapped.graph_sha256,
            mapper_candidate_sha256=mapped.candidate_sha256,
            provenance_bindings=mapped.provenance_bindings,
            provenance_set_sha256=mapped.provenance_set_sha256,
            mapping_advisories=mapping_result.advisories,
            mapper_result_sha256=mapping_result.mapping_sha256,
            transaction_id=transaction_input.transaction_id,
            transaction_commands=transaction_input.commands,
            transaction_command_hashes=tuple(
                command.command_hash for command in transaction_input.commands
            ),
            transaction_commands_sha256=transaction_input.commands_sha256,
            authorized_actor=mapping_result.authorized_actor,
            mapper_issuance_seal=mapping_result.mapper_issuance_seal,
        )

    def identity_payload(self) -> dict[str, Any]:
        return {
            "authority": {
                "authorized_actor": self.authorized_actor,
                "manufacturing_release_eligible": self.manufacturing_release_eligible,
                "staging_authorized": self.staging_authorized,
            },
            "canonical": {
                "base_revision": self.canonical_base_revision,
                "graph_sha256": self.canonical_graph_sha256,
            },
            "coordination": {
                "coordination_context_digest": self.coordination_context_digest,
                "project_id": self.project_id,
                "project_revision": self.project_revision,
                "run_id": self.run_id,
                "run_revision": self.run_revision,
            },
            "import_candidate": {
                "candidate_digest": self.import_candidate_digest,
                "candidate_id": self.import_candidate_id,
                "generation": self.import_candidate_generation,
                "inspection_receipt_digest": self.inspection_receipt_digest,
                "last_event_digest": self.import_candidate_last_event_digest,
                "state": self.import_candidate_state.value,
            },
            "mapping": {
                "diagnostics_manifest_sha256": self.diagnostics_manifest_sha256,
                "kicad_execution": self.kicad_execution,
                "mapper_candidate_sha256": self.mapper_candidate_sha256,
                "mapper_result_sha256": self.mapper_result_sha256,
                "provenance_set_sha256": self.provenance_set_sha256,
                "source_bundle_ir_sha256": self.source_bundle_ir_sha256,
                "source_import_evidence_sha256": self.source_import_evidence_sha256,
                "transaction_id": self.transaction_id,
                "transaction_commands": tuple(
                    _transaction_command_payload(command)
                    for command in self.transaction_commands
                ),
                "transaction_command_hashes": self.transaction_command_hashes,
                "transaction_commands_sha256": self.transaction_commands_sha256,
            },
            "source_artifact": {
                "artifact_id": self.source_artifact_id,
                "kind": self.source_artifact_kind.value,
                "sha256": self.source_artifact_sha256,
            },
        }

    @property
    def mapping_evidence_digest(self) -> str:
        return stable_hash(self.identity_payload(), domain=_IDENTITY_DOMAIN)

    @property
    def mapping_evidence_id(self) -> str:
        return f"mapping_evidence_{self.mapping_evidence_digest[:32]}"

    @property
    def evidence_sha256(self) -> str:
        """Compatibility spelling for the immutable mapping-evidence digest."""

        return self.mapping_evidence_digest


@dataclass(frozen=True, slots=True)
class CanonicalMappingEvidence:
    mapping_evidence_id: str
    mapping_evidence_digest: str
    import_candidate_id: str
    import_candidate_digest: str
    import_candidate_state: CandidateState
    import_candidate_generation: int
    import_candidate_last_event_digest: str
    source_artifact_id: str
    source_artifact_sha256: str
    source_artifact_kind: ArtifactKind
    inspection_receipt_digest: str
    project_id: str
    project_revision: str
    run_id: str
    run_revision: int
    coordination_context_digest: str
    source_import_evidence: BundleImportEvidence
    source_import_evidence_sha256: str
    source_bundle_ir_sha256: str
    diagnostics_manifest_sha256: str
    canonical_base_revision: str
    canonical_graph: DesignGraph
    canonical_graph_sha256: str
    mapper_candidate_sha256: str
    provenance_bindings: tuple[ComponentProvenanceBinding, ...]
    provenance_set_sha256: str
    mapping_advisories: tuple[MappingIssue, ...]
    mapper_result_sha256: str
    transaction_id: str
    transaction_commands: tuple[DesignCommand, ...]
    transaction_command_hashes: tuple[str, ...]
    transaction_commands_sha256: str
    authorized_actor: str
    kicad_execution: str
    manufacturing_release_eligible: bool
    staging_authorized: bool
    state: MappingEvidenceState
    generation: int
    invalidation_reason: str | None
    created_at: datetime
    updated_at: datetime
    last_event_digest: str

    def __post_init__(self) -> None:
        _require_mapping_evidence_id(self.mapping_evidence_id)
        _require_sha256(self.mapping_evidence_digest, "mapping evidence digest")
        draft = self.draft()
        if self.mapping_evidence_digest != draft.mapping_evidence_digest:
            raise MappingEvidenceIntegrityError(
                "mapping evidence digest does not match its immutable identity"
            )
        if self.mapping_evidence_id != draft.mapping_evidence_id:
            raise MappingEvidenceIntegrityError(
                "mapping evidence ID does not derive from its digest"
            )
        if not isinstance(self.state, MappingEvidenceState):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise MappingEvidenceIntegrityError("mapping evidence state is invalid")
        _require_nonnegative_int(self.generation, "mapping evidence generation")
        _require_time(self.created_at, "mapping evidence creation time")
        _require_time(self.updated_at, "mapping evidence update time")
        if self.updated_at < self.created_at:
            raise MappingEvidenceIntegrityError(
                "mapping evidence update time predates creation"
            )
        _require_sha256(self.last_event_digest, "mapping evidence last-event digest")
        if self.state is MappingEvidenceState.ACTIVE and (
            self.generation != 0 or self.invalidation_reason is not None
        ):
            raise MappingEvidenceIntegrityError(
                "active mapping evidence has transition-only state"
            )
        if self.state is MappingEvidenceState.INVALIDATED and (
            self.generation != 1 or self.invalidation_reason is None
        ):
            raise MappingEvidenceIntegrityError(
                "invalidated mapping evidence lacks its exact terminal reason"
            )
        if self.invalidation_reason is not None:
            _require_text(self.invalidation_reason, "mapping invalidation reason")

    @property
    def evidence_sha256(self) -> str:
        return self.mapping_evidence_digest

    @property
    def is_active(self) -> bool:
        """Return only this record's local lifecycle state.

        Active does not prove that the candidate, project head, run, artifact,
        or coordination context is still current.  Eligibility decisions must
        re-read and compare those independently persisted subjects.
        """

        return self.state is MappingEvidenceState.ACTIVE

    @property
    def is_current(self) -> bool:
        """Compatibility alias for :attr:`is_active`; not an eligibility claim."""

        return self.is_active

    def draft(self) -> MappingEvidenceDraft:
        return MappingEvidenceDraft(
            import_candidate_id=self.import_candidate_id,
            import_candidate_digest=self.import_candidate_digest,
            import_candidate_state=self.import_candidate_state,
            import_candidate_generation=self.import_candidate_generation,
            import_candidate_last_event_digest=self.import_candidate_last_event_digest,
            source_artifact_id=self.source_artifact_id,
            source_artifact_sha256=self.source_artifact_sha256,
            source_artifact_kind=self.source_artifact_kind,
            inspection_receipt_digest=self.inspection_receipt_digest,
            project_id=self.project_id,
            project_revision=self.project_revision,
            run_id=self.run_id,
            run_revision=self.run_revision,
            coordination_context_digest=self.coordination_context_digest,
            source_import_evidence=self.source_import_evidence,
            source_import_evidence_sha256=self.source_import_evidence_sha256,
            source_bundle_ir_sha256=self.source_bundle_ir_sha256,
            diagnostics_manifest_sha256=self.diagnostics_manifest_sha256,
            canonical_base_revision=self.canonical_base_revision,
            canonical_graph=self.canonical_graph,
            canonical_graph_sha256=self.canonical_graph_sha256,
            mapper_candidate_sha256=self.mapper_candidate_sha256,
            provenance_bindings=self.provenance_bindings,
            provenance_set_sha256=self.provenance_set_sha256,
            mapping_advisories=self.mapping_advisories,
            mapper_result_sha256=self.mapper_result_sha256,
            transaction_id=self.transaction_id,
            transaction_commands=self.transaction_commands,
            transaction_command_hashes=self.transaction_command_hashes,
            transaction_commands_sha256=self.transaction_commands_sha256,
            authorized_actor=self.authorized_actor,
            mapper_issuance_seal=mint_restored_mapping_seal(
                self.mapper_result_sha256
            ),
            kicad_execution=self.kicad_execution,
            manufacturing_release_eligible=self.manufacturing_release_eligible,
            staging_authorized=self.staging_authorized,
        )


@dataclass(frozen=True, slots=True)
class MappingEvidenceEvent:
    mapping_evidence_id: str
    mapping_evidence_digest: str
    sequence: int
    kind: MappingEvidenceEventKind
    previous_state: MappingEvidenceState | None
    state: MappingEvidenceState
    actor_id: str
    reason: str | None
    transitioned_at: datetime
    previous_event_digest: str
    event_digest: str

    def __post_init__(self) -> None:
        _require_mapping_evidence_id(self.mapping_evidence_id)
        _require_sha256(self.mapping_evidence_digest, "mapping evidence digest")
        _require_nonnegative_int(self.sequence, "mapping evidence event sequence")
        if not isinstance(self.kind, MappingEvidenceEventKind):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise MappingEvidenceIntegrityError(
                "mapping evidence event kind is invalid"
            )
        if self.previous_state is not None and not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
            self.previous_state, MappingEvidenceState
        ):
            raise MappingEvidenceIntegrityError(
                "mapping evidence event previous state is invalid"
            )
        if not isinstance(self.state, MappingEvidenceState):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise MappingEvidenceIntegrityError(
                "mapping evidence event state is invalid"
            )
        _require_public_id(self.actor_id, "mapping evidence event actor")
        if self.reason is not None:
            _require_text(self.reason, "mapping evidence event reason")
        _require_time(self.transitioned_at, "mapping evidence event time")
        _require_sha256(self.previous_event_digest, "previous event digest")
        _require_sha256(self.event_digest, "mapping evidence event digest")
        if self.kind is MappingEvidenceEventKind.CREATED and (
            self.sequence != 0
            or self.previous_state is not None
            or self.state is not MappingEvidenceState.ACTIVE
            or self.reason is not None
            or self.previous_event_digest != _ZERO_DIGEST
        ):
            raise MappingEvidenceIntegrityError(
                "mapping evidence creation event is malformed"
            )
        if self.kind is MappingEvidenceEventKind.INVALIDATED and (
            self.sequence != 1
            or self.previous_state is not MappingEvidenceState.ACTIVE
            or self.state is not MappingEvidenceState.INVALIDATED
            or self.reason is None
        ):
            raise MappingEvidenceIntegrityError(
                "mapping evidence invalidation event is malformed"
            )
        if self.event_digest != self.computed_digest:
            raise MappingEvidenceIntegrityError(
                "mapping evidence event digest does not match its body"
            )

    @classmethod
    def build(
        cls,
        *,
        mapping_evidence_id: str,
        mapping_evidence_digest: str,
        sequence: int,
        kind: MappingEvidenceEventKind,
        previous_state: MappingEvidenceState | None,
        state: MappingEvidenceState,
        actor_id: str,
        reason: str | None,
        transitioned_at: datetime,
        previous_event_digest: str,
    ) -> MappingEvidenceEvent:
        material = _event_material(
            mapping_evidence_id=mapping_evidence_id,
            mapping_evidence_digest=mapping_evidence_digest,
            sequence=sequence,
            kind=kind,
            previous_state=previous_state,
            state=state,
            actor_id=actor_id,
            reason=reason,
            transitioned_at=transitioned_at,
            previous_event_digest=previous_event_digest,
        )
        return cls(
            mapping_evidence_id=mapping_evidence_id,
            mapping_evidence_digest=mapping_evidence_digest,
            sequence=sequence,
            kind=kind,
            previous_state=previous_state,
            state=state,
            actor_id=actor_id,
            reason=reason,
            transitioned_at=transitioned_at,
            previous_event_digest=previous_event_digest,
            event_digest=stable_hash(material, domain=_EVENT_DOMAIN),
        )

    @property
    def computed_digest(self) -> str:
        return stable_hash(
            _event_material(
                mapping_evidence_id=self.mapping_evidence_id,
                mapping_evidence_digest=self.mapping_evidence_digest,
                sequence=self.sequence,
                kind=self.kind,
                previous_state=self.previous_state,
                state=self.state,
                actor_id=self.actor_id,
                reason=self.reason,
                transitioned_at=self.transitioned_at,
                previous_event_digest=self.previous_event_digest,
            ),
            domain=_EVENT_DOMAIN,
        )


def _event_material(
    *,
    mapping_evidence_id: str,
    mapping_evidence_digest: str,
    sequence: int,
    kind: MappingEvidenceEventKind,
    previous_state: MappingEvidenceState | None,
    state: MappingEvidenceState,
    actor_id: str,
    reason: str | None,
    transitioned_at: datetime,
    previous_event_digest: str,
) -> dict[str, Any]:
    return {
        "actor_id": actor_id,
        "kind": kind.value,
        "mapping_evidence_digest": mapping_evidence_digest,
        "mapping_evidence_id": mapping_evidence_id,
        "previous_event_digest": previous_event_digest,
        "previous_state": previous_state.value if previous_state else None,
        "reason": reason,
        "sequence": sequence,
        "state": state.value,
        "transitioned_at": _encode_time(transitioned_at),
    }


@runtime_checkable
class MappingEvidenceRepository(Protocol):
    """Storage-independent, evidence-only boundary with no staging methods."""

    def create(self, draft: MappingEvidenceDraft) -> CanonicalMappingEvidence: ...

    def get(self, mapping_evidence_id: str) -> CanonicalMappingEvidence: ...

    def list_for_candidate(
        self, import_candidate_id: str
    ) -> tuple[CanonicalMappingEvidence, ...]: ...

    def list_for_project(
        self, project_id: str
    ) -> tuple[CanonicalMappingEvidence, ...]: ...

    def list_events(
        self, mapping_evidence_id: str
    ) -> tuple[MappingEvidenceEvent, ...]: ...

    def invalidate(
        self,
        mapping_evidence_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        reason: str,
    ) -> CanonicalMappingEvidence: ...


_IDENTITY_COLUMNS = (
    "mapping_evidence_id",
    "mapping_evidence_digest",
    "import_candidate_id",
    "import_candidate_digest",
    "import_candidate_state",
    "import_candidate_generation",
    "import_candidate_last_event_digest",
    "source_artifact_id",
    "source_artifact_sha256",
    "source_artifact_kind",
    "inspection_receipt_digest",
    "project_id",
    "project_revision",
    "run_id",
    "run_revision",
    "coordination_context_digest",
    "source_import_evidence_json",
    "source_import_evidence_sha256",
    "source_bundle_ir_sha256",
    "diagnostics_manifest_sha256",
    "canonical_base_revision",
    "canonical_graph_json",
    "canonical_graph_sha256",
    "mapper_candidate_sha256",
    "provenance_bindings_json",
    "provenance_set_sha256",
    "mapping_advisories_json",
    "mapper_result_sha256",
    "transaction_id",
    "transaction_commands_json",
    "transaction_command_hashes_json",
    "transaction_commands_sha256",
    "authorized_actor",
    "kicad_execution",
    "manufacturing_release_eligible",
    "staging_authorized",
    "created_at",
)
_EVIDENCE_COLUMNS = (
    *_IDENTITY_COLUMNS[:-1],
    "state",
    "generation",
    "invalidation_reason",
    "created_at",
    "updated_at",
    "last_event_digest",
)
_EVENT_COLUMNS = (
    "mapping_evidence_id",
    "sequence",
    "mapping_evidence_digest",
    "kind",
    "previous_state",
    "state",
    "actor_id",
    "reason",
    "transitioned_at",
    "previous_event_digest",
    "event_digest",
)


class SQLiteMappingEvidenceRepository:
    """Restart-safe mapping evidence plus an append-only invalidation chain."""

    def __init__(
        self,
        database: str | Path,
        *,
        busy_timeout_ms: int = 5_000,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if (
            not isinstance(busy_timeout_ms, int)  # pyright: ignore[reportUnnecessaryIsInstance]
            or isinstance(busy_timeout_ms, bool)
            or busy_timeout_ms < 0
        ):
            raise ValueError("busy_timeout_ms must be a non-negative integer")
        self._clock = clock or (lambda: datetime.now(UTC))
        self._lock = RLock()
        self._closed = False
        try:
            self._connection = sqlite3.connect(
                str(database),
                isolation_level=None,
                check_same_thread=False,
                timeout=busy_timeout_ms / 1_000,
            )
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
            self._configure_wal(busy_timeout_ms)
            self._connection.execute("PRAGMA synchronous = FULL")
            self._initialize_schema()
        except sqlite3.DatabaseError as exc:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                connection.close()
            raise self._translate_sqlite_error(exc) from exc
        except Exception:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                connection.close()
            raise

    def __enter__(self) -> SQLiteMappingEvidenceRepository:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                try:
                    self._connection.close()
                except sqlite3.DatabaseError as exc:
                    raise self._translate_sqlite_error(exc) from exc
                self._closed = True

    @staticmethod
    def _translate_sqlite_error(
        exc: sqlite3.DatabaseError,
    ) -> MappingEvidenceStoreError:
        message = str(exc).lower()
        corruption_markers = (
            "corrupt",
            "malformed",
            "not a database",
            "file is encrypted",
            "mapping evidence identity is immutable",
            "mapping evidence events are append-only",
            "mapping evidence records cannot be deleted",
        )
        unavailable_markers = (
            "busy",
            "locked",
            "readonly",
            "read-only",
            "unable to open",
            "disk i/o",
            "database or disk is full",
        )
        if isinstance(exc, sqlite3.IntegrityError) or any(
            marker in message for marker in corruption_markers
        ):
            return MappingEvidenceIntegrityError(
                "mapping evidence database failed an integrity check"
            )
        if isinstance(exc, sqlite3.OperationalError) and any(
            marker in message for marker in unavailable_markers
        ):
            return MappingEvidenceStoreUnavailable(
                "mapping evidence database is temporarily unavailable"
            )
        return MappingEvidenceStoreError(
            "mapping evidence database operation failed"
        )

    def _require_open(self) -> None:
        if self._closed:
            raise MappingEvidenceStoreUnavailable(
                "mapping evidence repository is closed"
            )

    def _configure_wal(self, busy_timeout_ms: int) -> None:
        """Set WAL even when two processes first-open the same empty file.

        SQLite's journal-mode PRAGMA may report ``database is locked`` without
        honoring the connection busy handler while another connection is
        changing that mode.  A bounded retry closes that first-open race.
        """

        deadline = monotonic() + busy_timeout_ms / 1_000
        while True:
            try:
                row = self._connection.execute("PRAGMA journal_mode = WAL").fetchone()
                mode = "" if row is None else str(row[0]).casefold()
                if mode != "wal":
                    raise sqlite3.OperationalError(
                        "mapping evidence database could not enable WAL mode"
                    )
                return
            except sqlite3.OperationalError as exc:
                message = str(exc).casefold()
                if (
                    not any(token in message for token in ("busy", "locked"))
                    or monotonic() >= deadline
                ):
                    raise
                sleep(0.01)

    @contextmanager
    def _transaction(self, *, write: bool) -> Generator[None, None, None]:
        with self._lock:
            self._require_open()
            try:
                self._connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield
            except sqlite3.DatabaseError as exc:
                with suppress(sqlite3.DatabaseError):
                    self._connection.execute("ROLLBACK")
                raise self._translate_sqlite_error(exc) from exc
            except Exception:
                try:
                    self._connection.execute("ROLLBACK")
                except sqlite3.DatabaseError as exc:
                    raise self._translate_sqlite_error(exc) from exc
                raise
            else:
                try:
                    self._connection.execute("COMMIT")
                except sqlite3.DatabaseError as exc:
                    with suppress(sqlite3.DatabaseError):
                        self._connection.execute("ROLLBACK")
                    raise self._translate_sqlite_error(exc) from exc

    def _initialize_schema(self) -> None:
        """Serialize first-open initialization and commit the schema atomically."""

        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._initialize_schema_locked()
            self._connection.execute("COMMIT")
        except Exception:
            with suppress(sqlite3.DatabaseError):
                self._connection.execute("ROLLBACK")
            raise

    def _initialize_schema_locked(self) -> None:
        user_version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
        application_id = int(
            self._connection.execute("PRAGMA application_id").fetchone()[0]
        )
        tables = {
            str(row[0])
            for row in self._connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        if user_version == 0:
            if tables:
                raise UnsupportedMappingEvidenceStoreSchema(
                    "database is not an empty mapping-evidence repository"
                )
            if application_id not in {0, _APPLICATION_ID}:
                raise UnsupportedMappingEvidenceStoreSchema(
                    "database belongs to another application"
                )
            self._create_schema()
            # Verify the just-created schema through the same path used after a
            # restart before its transaction can become durable.
            self._initialize_schema_locked()
            return
        if application_id != _APPLICATION_ID:
            raise UnsupportedMappingEvidenceStoreSchema(
                "mapping evidence database application identity is unsupported"
            )
        if user_version == 1:
            self._migrate_empty_v1_schema()
            self._initialize_schema_locked()
            return
        if user_version == 2:
            self._migrate_empty_v2_schema()
            self._initialize_schema_locked()
            return
        if user_version != MAPPING_EVIDENCE_STORE_SCHEMA_VERSION:
            raise UnsupportedMappingEvidenceStoreSchema(
                f"unsupported mapping evidence schema version {user_version}"
            )
        required_tables = {
            "mapping_evidence_repository_meta",
            "canonical_mapping_evidence",
            "canonical_mapping_evidence_events",
        }
        if not required_tables.issubset(tables):
            raise UnsupportedMappingEvidenceStoreSchema(
                "mapping evidence database is missing required tables"
            )
        meta = self._connection.execute(
            "SELECT schema_name, schema_version "
            "FROM mapping_evidence_repository_meta WHERE singleton = 1"
        ).fetchone()
        if (
            meta is None
            or meta["schema_name"] != _SCHEMA_NAME
            or meta["schema_version"] != MAPPING_EVIDENCE_STORE_SCHEMA_VERSION
        ):
            raise UnsupportedMappingEvidenceStoreSchema(
                "mapping evidence schema metadata is inconsistent"
            )
        evidence_columns = tuple(
            str(row["name"])
            for row in self._connection.execute(
                "PRAGMA table_info(canonical_mapping_evidence)"
            ).fetchall()
        )
        event_columns = tuple(
            str(row["name"])
            for row in self._connection.execute(
                "PRAGMA table_info(canonical_mapping_evidence_events)"
            ).fetchall()
        )
        if evidence_columns != _EVIDENCE_COLUMNS or event_columns != _EVENT_COLUMNS:
            raise UnsupportedMappingEvidenceStoreSchema(
                "mapping evidence table structure is unsupported"
            )
        triggers = {
            str(row[0])
            for row in self._connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            )
        }
        required_triggers = {
            "canonical_mapping_evidence_identity_immutable",
            "canonical_mapping_evidence_no_delete",
            "canonical_mapping_evidence_events_no_update",
            "canonical_mapping_evidence_events_no_delete",
        }
        if not required_triggers.issubset(triggers):
            raise UnsupportedMappingEvidenceStoreSchema(
                "mapping evidence database is missing immutable audit triggers"
            )

    def _migrate_empty_v1_schema(self) -> None:
        """Upgrade only an empty v1 store; old rows lack replayable commands.

        A v1 row retained only command hashes, so manufacturing command bodies
        cannot be reconstructed or trusted during migration.  Requiring the old
        store to be empty is the fail-closed upgrade path; populated v1 stores
        must be re-resolved from their quarantined source artifacts.
        """

        try:
            evidence_count = int(
                self._connection.execute(
                    "SELECT COUNT(*) FROM canonical_mapping_evidence"
                ).fetchone()[0]
            )
            event_count = int(
                self._connection.execute(
                    "SELECT COUNT(*) FROM canonical_mapping_evidence_events"
                ).fetchone()[0]
            )
        except sqlite3.DatabaseError as exc:
            raise UnsupportedMappingEvidenceStoreSchema(
                "mapping evidence v1 schema cannot be inspected"
            ) from exc
        if evidence_count or event_count:
            raise UnsupportedMappingEvidenceStoreSchema(
                "populated mapping evidence v1 stores require source re-resolution"
            )
        self._connection.execute("DROP TABLE canonical_mapping_evidence_events")
        self._connection.execute("DROP TABLE canonical_mapping_evidence")
        self._connection.execute("DROP TABLE mapping_evidence_repository_meta")
        self._create_schema()

    def _migrate_empty_v2_schema(self) -> None:
        """Upgrade only an empty v2 store after canonical geometry changed.

        V2 graph JSON and graph/revision digests predate exact slot dimensions,
        drill rotation, repeated physical pads, and shared-land identity.  A
        populated store must therefore be regenerated from its retained source
        artifacts instead of silently rewriting evidence history.
        """

        try:
            evidence_count = int(
                self._connection.execute(
                    "SELECT COUNT(*) FROM canonical_mapping_evidence"
                ).fetchone()[0]
            )
            event_count = int(
                self._connection.execute(
                    "SELECT COUNT(*) FROM canonical_mapping_evidence_events"
                ).fetchone()[0]
            )
        except sqlite3.DatabaseError as exc:
            raise UnsupportedMappingEvidenceStoreSchema(
                "mapping evidence v2 schema cannot be inspected"
            ) from exc
        if evidence_count or event_count:
            raise UnsupportedMappingEvidenceStoreSchema(
                "populated mapping evidence v2 stores require source re-resolution"
            )
        self._connection.execute("DROP TABLE canonical_mapping_evidence_events")
        self._connection.execute("DROP TABLE canonical_mapping_evidence")
        self._connection.execute("DROP TABLE mapping_evidence_repository_meta")
        self._create_schema()

    def _create_schema(self) -> None:
        artifact_kinds = ",".join(f"'{item.value}'" for item in ArtifactKind)
        states = ",".join(f"'{item.value}'" for item in MappingEvidenceState)
        event_kinds = ",".join(
            f"'{item.value}'" for item in MappingEvidenceEventKind
        )
        identity_columns = ", ".join(_IDENTITY_COLUMNS)
        statements = (
            """
            CREATE TABLE mapping_evidence_repository_meta (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                schema_name TEXT NOT NULL,
                schema_version INTEGER NOT NULL
            ) STRICT
            """,
            (
                "INSERT INTO mapping_evidence_repository_meta VALUES "
                f"(1, '{_SCHEMA_NAME}', {MAPPING_EVIDENCE_STORE_SCHEMA_VERSION})"
            ),
            f"""
            CREATE TABLE canonical_mapping_evidence (
                mapping_evidence_id TEXT PRIMARY KEY,
                mapping_evidence_digest TEXT NOT NULL UNIQUE,
                import_candidate_id TEXT NOT NULL,
                import_candidate_digest TEXT NOT NULL,
                import_candidate_state TEXT NOT NULL
                    CHECK (import_candidate_state = 'pending'),
                import_candidate_generation INTEGER NOT NULL
                    CHECK (import_candidate_generation = 0),
                import_candidate_last_event_digest TEXT NOT NULL,
                source_artifact_id TEXT NOT NULL,
                source_artifact_sha256 TEXT NOT NULL,
                source_artifact_kind TEXT NOT NULL
                    CHECK (source_artifact_kind IN ({artifact_kinds})),
                inspection_receipt_digest TEXT NOT NULL,
                project_id TEXT NOT NULL,
                project_revision TEXT NOT NULL,
                run_id TEXT NOT NULL,
                run_revision INTEGER NOT NULL CHECK (run_revision >= 0),
                coordination_context_digest TEXT NOT NULL,
                source_import_evidence_json TEXT NOT NULL,
                source_import_evidence_sha256 TEXT NOT NULL,
                source_bundle_ir_sha256 TEXT NOT NULL,
                diagnostics_manifest_sha256 TEXT NOT NULL,
                canonical_base_revision TEXT NOT NULL,
                canonical_graph_json TEXT NOT NULL,
                canonical_graph_sha256 TEXT NOT NULL,
                mapper_candidate_sha256 TEXT NOT NULL,
                provenance_bindings_json TEXT NOT NULL,
                provenance_set_sha256 TEXT NOT NULL,
                mapping_advisories_json TEXT NOT NULL,
                mapper_result_sha256 TEXT NOT NULL,
                transaction_id TEXT NOT NULL,
                transaction_commands_json TEXT NOT NULL,
                transaction_command_hashes_json TEXT NOT NULL,
                transaction_commands_sha256 TEXT NOT NULL,
                authorized_actor TEXT NOT NULL,
                kicad_execution TEXT NOT NULL CHECK (kicad_execution = 'not-run'),
                manufacturing_release_eligible INTEGER NOT NULL
                    CHECK (manufacturing_release_eligible = 0),
                staging_authorized INTEGER NOT NULL CHECK (staging_authorized = 0),
                state TEXT NOT NULL CHECK (state IN ({states})),
                generation INTEGER NOT NULL CHECK (generation >= 0),
                invalidation_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_event_digest TEXT NOT NULL
            ) STRICT
            """,
            """
            CREATE INDEX canonical_mapping_evidence_candidate_order
                ON canonical_mapping_evidence(
                    import_candidate_id, created_at, mapping_evidence_id
                )
            """,
            """
            CREATE INDEX canonical_mapping_evidence_project_order
                ON canonical_mapping_evidence(
                    project_id, created_at, mapping_evidence_id
                )
            """,
            f"""
            CREATE TABLE canonical_mapping_evidence_events (
                mapping_evidence_id TEXT NOT NULL
                    REFERENCES canonical_mapping_evidence(mapping_evidence_id)
                    ON DELETE RESTRICT,
                sequence INTEGER NOT NULL CHECK (sequence >= 0),
                mapping_evidence_digest TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ({event_kinds})),
                previous_state TEXT CHECK (previous_state IN ({states})),
                state TEXT NOT NULL CHECK (state IN ({states})),
                actor_id TEXT NOT NULL,
                reason TEXT,
                transitioned_at TEXT NOT NULL,
                previous_event_digest TEXT NOT NULL,
                event_digest TEXT NOT NULL UNIQUE,
                PRIMARY KEY (mapping_evidence_id, sequence)
            ) STRICT
            """,
            f"""
            CREATE TRIGGER canonical_mapping_evidence_identity_immutable
            BEFORE UPDATE OF {identity_columns} ON canonical_mapping_evidence
            BEGIN
                SELECT RAISE(ABORT, 'mapping evidence identity is immutable');
            END
            """,
            """
            CREATE TRIGGER canonical_mapping_evidence_no_delete
            BEFORE DELETE ON canonical_mapping_evidence
            BEGIN
                SELECT RAISE(ABORT, 'mapping evidence records cannot be deleted');
            END
            """,
            """
            CREATE TRIGGER canonical_mapping_evidence_events_no_update
            BEFORE UPDATE ON canonical_mapping_evidence_events
            BEGIN
                SELECT RAISE(ABORT, 'mapping evidence events are append-only');
            END
            """,
            """
            CREATE TRIGGER canonical_mapping_evidence_events_no_delete
            BEFORE DELETE ON canonical_mapping_evidence_events
            BEGIN
                SELECT RAISE(ABORT, 'mapping evidence events are append-only');
            END
            """,
        )
        for statement in statements:
            self._connection.execute(statement)
        # Ownership/version markers are deliberately last.  The surrounding
        # BEGIN IMMEDIATE transaction rolls every DDL statement back together.
        self._connection.execute(f"PRAGMA application_id = {_APPLICATION_ID}")
        self._connection.execute(
            f"PRAGMA user_version = {MAPPING_EVIDENCE_STORE_SCHEMA_VERSION}"
        )

    def _now(self) -> datetime:
        value = self._clock()
        try:
            _require_time(value, "repository clock")
        except InvalidMappingEvidence:
            raise
        assert isinstance(value, datetime)
        return value.astimezone(UTC)

    def create(self, draft: MappingEvidenceDraft) -> CanonicalMappingEvidence:
        if type(draft) is not MappingEvidenceDraft:
            raise InvalidMappingEvidence(
                "create requires an exact MappingEvidenceDraft"
            )
        draft.__post_init__()
        if not draft.mapper_issuance_seal.is_deterministic_mapper_issuance:
            raise InvalidMappingEvidence(
                "fresh mapping evidence requires deterministic mapper issuance"
            )
        created_at = self._now()
        event = MappingEvidenceEvent.build(
            mapping_evidence_id=draft.mapping_evidence_id,
            mapping_evidence_digest=draft.mapping_evidence_digest,
            sequence=0,
            kind=MappingEvidenceEventKind.CREATED,
            previous_state=None,
            state=MappingEvidenceState.ACTIVE,
            actor_id=draft.authorized_actor,
            reason=None,
            transitioned_at=created_at,
            previous_event_digest=_ZERO_DIGEST,
        )
        evidence = CanonicalMappingEvidence(
            mapping_evidence_id=draft.mapping_evidence_id,
            mapping_evidence_digest=draft.mapping_evidence_digest,
            import_candidate_id=draft.import_candidate_id,
            import_candidate_digest=draft.import_candidate_digest,
            import_candidate_state=draft.import_candidate_state,
            import_candidate_generation=draft.import_candidate_generation,
            import_candidate_last_event_digest=draft.import_candidate_last_event_digest,
            source_artifact_id=draft.source_artifact_id,
            source_artifact_sha256=draft.source_artifact_sha256,
            source_artifact_kind=draft.source_artifact_kind,
            inspection_receipt_digest=draft.inspection_receipt_digest,
            project_id=draft.project_id,
            project_revision=draft.project_revision,
            run_id=draft.run_id,
            run_revision=draft.run_revision,
            coordination_context_digest=draft.coordination_context_digest,
            source_import_evidence=draft.source_import_evidence,
            source_import_evidence_sha256=draft.source_import_evidence_sha256,
            source_bundle_ir_sha256=draft.source_bundle_ir_sha256,
            diagnostics_manifest_sha256=draft.diagnostics_manifest_sha256,
            canonical_base_revision=draft.canonical_base_revision,
            canonical_graph=draft.canonical_graph,
            canonical_graph_sha256=draft.canonical_graph_sha256,
            mapper_candidate_sha256=draft.mapper_candidate_sha256,
            provenance_bindings=draft.provenance_bindings,
            provenance_set_sha256=draft.provenance_set_sha256,
            mapping_advisories=draft.mapping_advisories,
            mapper_result_sha256=draft.mapper_result_sha256,
            transaction_id=draft.transaction_id,
            transaction_commands=draft.transaction_commands,
            transaction_command_hashes=draft.transaction_command_hashes,
            transaction_commands_sha256=draft.transaction_commands_sha256,
            authorized_actor=draft.authorized_actor,
            kicad_execution=draft.kicad_execution,
            manufacturing_release_eligible=draft.manufacturing_release_eligible,
            staging_authorized=draft.staging_authorized,
            state=MappingEvidenceState.ACTIVE,
            generation=0,
            invalidation_reason=None,
            created_at=created_at,
            updated_at=created_at,
            last_event_digest=event.event_digest,
        )
        with self._transaction(write=True):
            row = self._connection.execute(
                "SELECT * FROM canonical_mapping_evidence "
                "WHERE mapping_evidence_id = ?",
                (evidence.mapping_evidence_id,),
            ).fetchone()
            if row is not None:
                existing = self._evidence_from_row(row)
                self._verify_event_chain(existing)
                if existing.mapping_evidence_digest != evidence.mapping_evidence_digest:
                    raise MappingEvidenceIntegrityError(
                        "mapping evidence ID collision has a different digest"
                    )
                return existing
            self._connection.execute(
                f"INSERT INTO canonical_mapping_evidence "
                f"({', '.join(_EVIDENCE_COLUMNS)}) "
                f"VALUES ({', '.join('?' for _ in _EVIDENCE_COLUMNS)})",
                _evidence_insert_values(evidence),
            )
            self._insert_event(event)
        return evidence

    def get(self, mapping_evidence_id: str) -> CanonicalMappingEvidence:
        _require_mapping_evidence_id(mapping_evidence_id)
        with self._transaction(write=False):
            evidence = self._get_locked(mapping_evidence_id)
            self._verify_event_chain(evidence)
            return evidence

    def list_for_candidate(
        self, import_candidate_id: str
    ) -> tuple[CanonicalMappingEvidence, ...]:
        _require_import_candidate_id(import_candidate_id)
        with self._transaction(write=False):
            rows = self._connection.execute(
                "SELECT * FROM canonical_mapping_evidence "
                "WHERE import_candidate_id = ? "
                "ORDER BY created_at, mapping_evidence_id",
                (import_candidate_id,),
            ).fetchall()
            values = tuple(self._evidence_from_row(row) for row in rows)
            for evidence in values:
                self._verify_event_chain(evidence)
            return values

    def list_for_project(
        self, project_id: str
    ) -> tuple[CanonicalMappingEvidence, ...]:
        _require_public_id(project_id, "project ID")
        with self._transaction(write=False):
            rows = self._connection.execute(
                "SELECT * FROM canonical_mapping_evidence WHERE project_id = ? "
                "ORDER BY created_at, mapping_evidence_id",
                (project_id,),
            ).fetchall()
            values = tuple(self._evidence_from_row(row) for row in rows)
            for evidence in values:
                self._verify_event_chain(evidence)
            return values

    def list_events(
        self, mapping_evidence_id: str
    ) -> tuple[MappingEvidenceEvent, ...]:
        _require_mapping_evidence_id(mapping_evidence_id)
        with self._transaction(write=False):
            evidence = self._get_locked(mapping_evidence_id)
            return self._verify_event_chain(evidence)

    def invalidate(
        self,
        mapping_evidence_id: str,
        *,
        expected_generation: int,
        actor_id: str,
        reason: str,
    ) -> CanonicalMappingEvidence:
        _require_mapping_evidence_id(mapping_evidence_id)
        _require_nonnegative_int(expected_generation, "expected generation")
        _require_public_id(actor_id, "invalidation actor")
        _require_text(reason, "mapping invalidation reason")
        with self._transaction(write=True):
            evidence = self._get_locked(mapping_evidence_id)
            self._verify_event_chain(evidence)
            if evidence.generation != expected_generation:
                raise MappingEvidenceConcurrencyConflict(
                    "mapping evidence generation changed after the caller read it"
                )
            if evidence.state is not MappingEvidenceState.ACTIVE:
                raise IllegalMappingEvidenceTransition(
                    "only active mapping evidence can be invalidated"
                )
            transitioned_at = self._now()
            if transitioned_at < evidence.updated_at:
                raise MappingEvidenceIntegrityError(
                    "repository clock moved backwards during invalidation"
                )
            event = MappingEvidenceEvent.build(
                mapping_evidence_id=evidence.mapping_evidence_id,
                mapping_evidence_digest=evidence.mapping_evidence_digest,
                sequence=1,
                kind=MappingEvidenceEventKind.INVALIDATED,
                previous_state=MappingEvidenceState.ACTIVE,
                state=MappingEvidenceState.INVALIDATED,
                actor_id=actor_id,
                reason=reason,
                transitioned_at=transitioned_at,
                previous_event_digest=evidence.last_event_digest,
            )
            invalidated = replace(
                evidence,
                state=MappingEvidenceState.INVALIDATED,
                generation=1,
                invalidation_reason=reason,
                updated_at=transitioned_at,
                last_event_digest=event.event_digest,
            )
            cursor = self._connection.execute(
                """
                UPDATE canonical_mapping_evidence
                SET state = ?, generation = ?, invalidation_reason = ?,
                    updated_at = ?, last_event_digest = ?
                WHERE mapping_evidence_id = ? AND state = ? AND generation = ?
                    AND last_event_digest = ?
                """,
                (
                    invalidated.state.value,
                    invalidated.generation,
                    invalidated.invalidation_reason,
                    _encode_time(invalidated.updated_at),
                    invalidated.last_event_digest,
                    evidence.mapping_evidence_id,
                    evidence.state.value,
                    expected_generation,
                    evidence.last_event_digest,
                ),
            )
            if cursor.rowcount != 1:
                raise MappingEvidenceConcurrencyConflict(
                    "mapping evidence changed before compare-and-swap could commit"
                )
            self._insert_event(event)
            return invalidated

    def _get_locked(self, mapping_evidence_id: str) -> CanonicalMappingEvidence:
        row = self._connection.execute(
            "SELECT * FROM canonical_mapping_evidence "
            "WHERE mapping_evidence_id = ?",
            (mapping_evidence_id,),
        ).fetchone()
        if row is None:
            raise MappingEvidenceNotFound(
                f"mapping evidence not found: {mapping_evidence_id}"
            )
        return self._evidence_from_row(row)

    def _evidence_from_row(self, row: sqlite3.Row) -> CanonicalMappingEvidence:
        try:
            source_evidence_payload = _load_canonical_json(
                row["source_import_evidence_json"], "source-import evidence"
            )
            source_evidence = _source_evidence_from_payload(source_evidence_payload)
            graph_json = row["canonical_graph_json"]
            graph_value = _load_canonical_json(graph_json, "canonical graph")
            try:
                graph = graph_from_payload(graph_value)
            except Exception as exc:
                raise MappingEvidenceIntegrityError(
                    "persisted canonical graph is malformed"
                ) from exc
            provenance_value = _load_canonical_json(
                row["provenance_bindings_json"], "trusted resolver evidence"
            )
            provenance = _provenance_bindings_from_payload(provenance_value)
            advisories_value = _load_canonical_json(
                row["mapping_advisories_json"], "mapping advisories"
            )
            advisories = _mapping_issues_from_payload(advisories_value)
            transaction_commands_value = _load_canonical_json(
                row["transaction_commands_json"],
                "transaction commands",
            )
            transaction_commands = _transaction_commands_from_payload(
                transaction_commands_value
            )
            transaction_command_hashes_value = _load_canonical_json(
                row["transaction_command_hashes_json"],
                "transaction command hashes",
            )
            transaction_command_hashes = _transaction_command_hashes_from_payload(
                transaction_command_hashes_value
            )
            return CanonicalMappingEvidence(
                mapping_evidence_id=row["mapping_evidence_id"],
                mapping_evidence_digest=row["mapping_evidence_digest"],
                import_candidate_id=row["import_candidate_id"],
                import_candidate_digest=row["import_candidate_digest"],
                import_candidate_state=CandidateState(row["import_candidate_state"]),
                import_candidate_generation=row["import_candidate_generation"],
                import_candidate_last_event_digest=row[
                    "import_candidate_last_event_digest"
                ],
                source_artifact_id=row["source_artifact_id"],
                source_artifact_sha256=row["source_artifact_sha256"],
                source_artifact_kind=ArtifactKind(row["source_artifact_kind"]),
                inspection_receipt_digest=row["inspection_receipt_digest"],
                project_id=row["project_id"],
                project_revision=row["project_revision"],
                run_id=row["run_id"],
                run_revision=row["run_revision"],
                coordination_context_digest=row["coordination_context_digest"],
                source_import_evidence=source_evidence,
                source_import_evidence_sha256=row[
                    "source_import_evidence_sha256"
                ],
                source_bundle_ir_sha256=row["source_bundle_ir_sha256"],
                diagnostics_manifest_sha256=row[
                    "diagnostics_manifest_sha256"
                ],
                canonical_base_revision=row["canonical_base_revision"],
                canonical_graph=graph,
                canonical_graph_sha256=row["canonical_graph_sha256"],
                mapper_candidate_sha256=row["mapper_candidate_sha256"],
                provenance_bindings=provenance,
                provenance_set_sha256=row["provenance_set_sha256"],
                mapping_advisories=advisories,
                mapper_result_sha256=row["mapper_result_sha256"],
                transaction_id=row["transaction_id"],
                transaction_commands=transaction_commands,
                transaction_command_hashes=transaction_command_hashes,
                transaction_commands_sha256=row[
                    "transaction_commands_sha256"
                ],
                authorized_actor=row["authorized_actor"],
                kicad_execution=row["kicad_execution"],
                manufacturing_release_eligible=bool(
                    row["manufacturing_release_eligible"]
                ),
                staging_authorized=bool(row["staging_authorized"]),
                state=MappingEvidenceState(row["state"]),
                generation=row["generation"],
                invalidation_reason=row["invalidation_reason"],
                created_at=_decode_time(row["created_at"]),
                updated_at=_decode_time(row["updated_at"]),
                last_event_digest=row["last_event_digest"],
            )
        except MappingEvidenceIntegrityError:
            raise
        except (InvalidMappingEvidence, KeyError, TypeError, ValueError) as exc:
            raise MappingEvidenceIntegrityError(
                "persisted canonical mapping evidence is malformed"
            ) from exc

    def _insert_event(self, event: MappingEvidenceEvent) -> None:
        self._connection.execute(
            f"INSERT INTO canonical_mapping_evidence_events "
            f"({', '.join(_EVENT_COLUMNS)}) "
            f"VALUES ({', '.join('?' for _ in _EVENT_COLUMNS)})",
            (
                event.mapping_evidence_id,
                event.sequence,
                event.mapping_evidence_digest,
                event.kind.value,
                event.previous_state.value if event.previous_state else None,
                event.state.value,
                event.actor_id,
                event.reason,
                _encode_time(event.transitioned_at),
                event.previous_event_digest,
                event.event_digest,
            ),
        )

    def _event_from_row(self, row: sqlite3.Row) -> MappingEvidenceEvent:
        try:
            return MappingEvidenceEvent(
                mapping_evidence_id=row["mapping_evidence_id"],
                mapping_evidence_digest=row["mapping_evidence_digest"],
                sequence=row["sequence"],
                kind=MappingEvidenceEventKind(row["kind"]),
                previous_state=(
                    MappingEvidenceState(row["previous_state"])
                    if row["previous_state"] is not None
                    else None
                ),
                state=MappingEvidenceState(row["state"]),
                actor_id=row["actor_id"],
                reason=row["reason"],
                transitioned_at=_decode_time(row["transitioned_at"]),
                previous_event_digest=row["previous_event_digest"],
                event_digest=row["event_digest"],
            )
        except MappingEvidenceIntegrityError:
            raise
        except (InvalidMappingEvidence, KeyError, TypeError, ValueError) as exc:
            raise MappingEvidenceIntegrityError(
                "persisted mapping evidence event is malformed"
            ) from exc

    def _verify_event_chain(
        self, evidence: CanonicalMappingEvidence
    ) -> tuple[MappingEvidenceEvent, ...]:
        rows = self._connection.execute(
            "SELECT * FROM canonical_mapping_evidence_events "
            "WHERE mapping_evidence_id = ? ORDER BY sequence",
            (evidence.mapping_evidence_id,),
        ).fetchall()
        events = tuple(self._event_from_row(row) for row in rows)
        if not events:
            raise MappingEvidenceIntegrityError(
                "mapping evidence has no durable lifecycle event"
            )
        root = events[0]
        if (
            root.kind is not MappingEvidenceEventKind.CREATED
            or root.sequence != 0
            or root.previous_event_digest != _ZERO_DIGEST
            or root.mapping_evidence_digest != evidence.mapping_evidence_digest
            or root.actor_id != evidence.authorized_actor
            or root.transitioned_at != evidence.created_at
        ):
            raise MappingEvidenceIntegrityError(
                "mapping evidence creation event does not bind its exact identity"
            )
        previous = root
        replayed_reason: str | None = None
        for event in events[1:]:
            if (
                event.sequence != previous.sequence + 1
                or event.mapping_evidence_digest != evidence.mapping_evidence_digest
                or event.previous_event_digest != previous.event_digest
                or event.previous_state is not previous.state
                or event.transitioned_at < previous.transitioned_at
            ):
                raise MappingEvidenceIntegrityError(
                    "mapping evidence event digest/state chain is broken"
                )
            if event.kind is not MappingEvidenceEventKind.INVALIDATED:
                raise MappingEvidenceIntegrityError(
                    "mapping evidence lifecycle contains an unsupported event"
                )
            replayed_reason = event.reason
            previous = event
        if (
            previous.sequence != evidence.generation
            or previous.state is not evidence.state
            or previous.event_digest != evidence.last_event_digest
            or previous.transitioned_at != evidence.updated_at
            or replayed_reason != evidence.invalidation_reason
        ):
            raise MappingEvidenceIntegrityError(
                "mapping evidence current state does not replay from its event chain"
            )
        return events


def _evidence_insert_values(evidence: CanonicalMappingEvidence) -> tuple[object, ...]:
    return (
        evidence.mapping_evidence_id,
        evidence.mapping_evidence_digest,
        evidence.import_candidate_id,
        evidence.import_candidate_digest,
        evidence.import_candidate_state.value,
        evidence.import_candidate_generation,
        evidence.import_candidate_last_event_digest,
        evidence.source_artifact_id,
        evidence.source_artifact_sha256,
        evidence.source_artifact_kind.value,
        evidence.inspection_receipt_digest,
        evidence.project_id,
        evidence.project_revision,
        evidence.run_id,
        evidence.run_revision,
        evidence.coordination_context_digest,
        canonical_json(evidence.source_import_evidence),
        evidence.source_import_evidence_sha256,
        evidence.source_bundle_ir_sha256,
        evidence.diagnostics_manifest_sha256,
        evidence.canonical_base_revision,
        canonical_json(graph_payload(evidence.canonical_graph)),
        evidence.canonical_graph_sha256,
        evidence.mapper_candidate_sha256,
        canonical_json(evidence.provenance_bindings),
        evidence.provenance_set_sha256,
        canonical_json(evidence.mapping_advisories),
        evidence.mapper_result_sha256,
        evidence.transaction_id,
        canonical_json(
            tuple(
                _transaction_command_payload(command)
                for command in evidence.transaction_commands
            )
        ),
        canonical_json(evidence.transaction_command_hashes),
        evidence.transaction_commands_sha256,
        evidence.authorized_actor,
        evidence.kicad_execution,
        int(evidence.manufacturing_release_eligible),
        int(evidence.staging_authorized),
        evidence.state.value,
        evidence.generation,
        evidence.invalidation_reason,
        _encode_time(evidence.created_at),
        _encode_time(evidence.updated_at),
        evidence.last_event_digest,
    )


# Store spelling is an alias, not a second implementation or contract type.
SQLiteMappingEvidenceStore = SQLiteMappingEvidenceRepository


__all__ = (
    "MAPPING_EVIDENCE_STORE_SCHEMA_VERSION",
    "CanonicalMappingEvidence",
    "IllegalMappingEvidenceTransition",
    "InvalidMappingEvidence",
    "MappingEvidenceConcurrencyConflict",
    "MappingEvidenceDraft",
    "MappingEvidenceEvent",
    "MappingEvidenceEventKind",
    "MappingEvidenceIntegrityError",
    "MappingEvidenceNotFound",
    "MappingEvidenceRepository",
    "MappingEvidenceState",
    "MappingEvidenceStoreError",
    "MappingEvidenceStoreUnavailable",
    "SQLiteMappingEvidenceRepository",
    "SQLiteMappingEvidenceStore",
    "UnsupportedMappingEvidenceStoreSchema",
)

"""Strict host-configured component provenance resolver.

The catalog is accepted only when its exact byte digest is pinned separately by
trusted host configuration.  Request data can select an exact matching record,
but it cannot add catalog facts, change the trust snapshot, or supply evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import re
import unicodedata
from typing import Any

from backend.canonical_import import (
    ComponentProvenanceRequest,
    TrustedComponentResolution,
)
from backend.design_kernel import Component, PinDefinition, stable_hash


_SHA256 = re.compile(r"[0-9a-f]{64}")
_ROOT_FIELDS = frozenset({"schemaVersion", "catalogId", "records"})
_RECORD_FIELDS = frozenset(
    {
        "recordId",
        "value",
        "footprintLibraryId",
        "schematicLibraryId",
        "manufacturerPartNumber",
        "package",
        "datasheetSha256",
        "pinMapSha256",
        "pins",
    }
)
_PIN_FIELDS = frozenset(
    {"number", "padNumber", "name", "electricalType", "required"}
)


class CatalogError(RuntimeError):
    """Base class for closed catalog failures."""


class InvalidCatalog(CatalogError):
    """The pinned bytes do not implement the exact catalog contract."""


class CatalogDigestMismatch(CatalogError):
    """The catalog bytes do not match trusted host configuration."""


class AmbiguousCatalogMatch(CatalogError):
    """More than one trusted record claims the same exact source identity."""


def _require_text(value: object, label: str, *, identifier: bool = False) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or unicodedata.normalize("NFC", value) != value
        or (identifier and unicodedata.normalize("NFKC", value) != value)
        or any(unicodedata.category(character).startswith("C") for character in value)
        or (identifier and any(character.isspace() for character in value))
    ):
        kind = "identifier" if identifier else "text"
        raise InvalidCatalog(f"{label} must be canonical non-empty {kind}")
    return value


def _require_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise InvalidCatalog(f"{label} must be a lowercase SHA-256 digest")
    return value


def _exact_fields(value: object, fields: frozenset[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise InvalidCatalog(f"{label} fields do not match the closed schema")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise InvalidCatalog(f"duplicate JSON field {key!r}")
        value[key] = item
    return value


def _reject_number(value: str) -> object:
    raise InvalidCatalog(f"non-integer JSON number {value!r} is forbidden")


@dataclass(frozen=True, slots=True, order=True)
class CatalogPin:
    number: str
    pad_number: str
    name: str
    electrical_type: str
    required: bool

    def __post_init__(self) -> None:
        _require_text(self.number, "catalog pin number", identifier=True)
        _require_text(self.pad_number, "catalog pad number", identifier=True)
        _require_text(self.name, "catalog pin name")
        _require_text(
            self.electrical_type,
            "catalog pin electrical type",
            identifier=True,
        )
        if not isinstance(self.required, bool):
            raise InvalidCatalog("catalog pin required flag must be boolean")

    @property
    def identity(self) -> tuple[str, str, str, str]:
        return self.number, self.pad_number, self.name, self.electrical_type


def catalog_pin_map_sha256(pins: tuple[CatalogPin, ...]) -> str:
    if not isinstance(pins, tuple) or any(not isinstance(pin, CatalogPin) for pin in pins):
        raise InvalidCatalog("catalog pins must be an immutable CatalogPin tuple")
    return stable_hash(pins, domain="flux-clone-component-catalog-pin-map-v1")


@dataclass(frozen=True, slots=True)
class CatalogRecord:
    record_id: str
    value: str
    footprint_library_id: str
    schematic_library_id: str
    manufacturer_part_number: str
    package: str
    datasheet_sha256: str
    pin_map_sha256: str
    pins: tuple[CatalogPin, ...]

    def __post_init__(self) -> None:
        _require_text(self.record_id, "catalog record ID", identifier=True)
        _require_text(self.value, "catalog value")
        _require_text(
            self.footprint_library_id,
            "catalog footprint library ID",
            identifier=True,
        )
        _require_text(
            self.schematic_library_id,
            "catalog schematic library ID",
            identifier=True,
        )
        _require_text(self.manufacturer_part_number, "catalog exact MPN")
        _require_text(self.package, "catalog package")
        _require_sha256(self.datasheet_sha256, "catalog datasheet digest")
        _require_sha256(self.pin_map_sha256, "catalog pin-map digest")
        if (
            not isinstance(self.pins, tuple)
            or not self.pins
            or any(not isinstance(pin, CatalogPin) for pin in self.pins)
        ):
            raise InvalidCatalog("catalog record pins must be a non-empty immutable tuple")
        if tuple(sorted(self.pins)) != self.pins:
            raise InvalidCatalog("catalog record pins must be deterministically sorted")
        if len({pin.number for pin in self.pins}) != len(self.pins):
            raise InvalidCatalog("catalog pin numbers must be unique")
        if len({pin.pad_number for pin in self.pins}) != len(self.pins):
            raise InvalidCatalog("catalog pad numbers must be unique")
        if self.pin_map_sha256 != catalog_pin_map_sha256(self.pins):
            raise InvalidCatalog("catalog pin-map digest does not bind exact pin facts")

    @property
    def identity(self) -> tuple[object, ...]:
        return (
            self.value,
            self.footprint_library_id,
            self.schematic_library_id,
            tuple(pin.identity for pin in self.pins),
        )

    @property
    def record_sha256(self) -> str:
        return stable_hash(self, domain="flux-clone-component-catalog-record-v1")


@dataclass(frozen=True, slots=True)
class CatalogSnapshot:
    schema_version: int
    catalog_id: str
    records: tuple[CatalogRecord, ...]
    source_sha256: str

    def __post_init__(self) -> None:
        if type(self.schema_version) is not int or self.schema_version != 1:
            raise InvalidCatalog("component catalog schemaVersion must be exactly 1")
        _require_text(self.catalog_id, "catalog ID", identifier=True)
        _require_sha256(self.source_sha256, "catalog source digest")
        if (
            not isinstance(self.records, tuple)
            or not self.records
            or any(not isinstance(record, CatalogRecord) for record in self.records)
        ):
            raise InvalidCatalog("catalog records must be a non-empty immutable tuple")
        if tuple(sorted(self.records, key=lambda item: item.record_id)) != self.records:
            raise InvalidCatalog("catalog records must be sorted by recordId")
        if len({record.record_id for record in self.records}) != len(self.records):
            raise InvalidCatalog("catalog record IDs must be unique")


class PinnedCatalogResolver:
    """Resolve exact component facts from one separately digest-pinned snapshot."""

    def __init__(self, snapshot: CatalogSnapshot) -> None:
        if not isinstance(snapshot, CatalogSnapshot):
            raise TypeError("snapshot must be CatalogSnapshot")
        self._snapshot = snapshot

    @property
    def snapshot(self) -> CatalogSnapshot:
        return self._snapshot

    @classmethod
    def from_json_bytes(
        cls,
        payload: bytes,
        *,
        expected_sha256: str,
    ) -> "PinnedCatalogResolver":
        if not isinstance(payload, bytes) or not payload:
            raise InvalidCatalog("component catalog must be non-empty immutable bytes")
        expected = _require_sha256(expected_sha256, "expected catalog digest")
        actual = hashlib.sha256(payload).hexdigest()
        if actual != expected:
            raise CatalogDigestMismatch("component catalog does not match its pinned digest")
        try:
            text = payload.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise InvalidCatalog("component catalog must be strict UTF-8") from exc
        if text.startswith("\ufeff"):
            raise InvalidCatalog("component catalog cannot contain a byte-order mark")
        try:
            root = json.loads(
                text,
                object_pairs_hook=_unique_object,
                parse_float=_reject_number,
                parse_constant=_reject_number,
            )
        except InvalidCatalog:
            raise
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise InvalidCatalog("component catalog is not strict JSON") from exc
        body = _exact_fields(root, _ROOT_FIELDS, "catalog")
        if type(body["schemaVersion"]) is not int or body["schemaVersion"] != 1:
            raise InvalidCatalog("component catalog schemaVersion must be exactly 1")
        raw_records = body["records"]
        if not isinstance(raw_records, list):
            raise InvalidCatalog("catalog records must be an array")
        records = tuple(cls._record(item) for item in raw_records)
        return cls(CatalogSnapshot(1, body["catalogId"], records, actual))

    @staticmethod
    def _record(value: object) -> CatalogRecord:
        body = _exact_fields(value, _RECORD_FIELDS, "catalog record")
        raw_pins = body["pins"]
        if not isinstance(raw_pins, list):
            raise InvalidCatalog("catalog record pins must be an array")
        pins = tuple(PinnedCatalogResolver._pin(item) for item in raw_pins)
        return CatalogRecord(
            body["recordId"],
            body["value"],
            body["footprintLibraryId"],
            body["schematicLibraryId"],
            body["manufacturerPartNumber"],
            body["package"],
            body["datasheetSha256"],
            body["pinMapSha256"],
            pins,
        )

    @staticmethod
    def _pin(value: object) -> CatalogPin:
        body = _exact_fields(value, _PIN_FIELDS, "catalog pin")
        return CatalogPin(
            body["number"],
            body["padNumber"],
            body["name"],
            body["electricalType"],
            body["required"],
        )

    def resolve(
        self,
        request: ComponentProvenanceRequest,
    ) -> TrustedComponentResolution | None:
        if not isinstance(request, ComponentProvenanceRequest):
            raise TypeError("request must be ComponentProvenanceRequest")
        identity = (
            request.value,
            request.footprint_library_id,
            request.schematic_library_id,
            tuple(
                (
                    pin.pin_number,
                    pin.pad_number,
                    pin.pin_name,
                    pin.electrical_type,
                )
                for pin in request.pins
            ),
        )
        matches = tuple(
            record for record in self._snapshot.records if record.identity == identity
        )
        if not matches:
            return None
        if len(matches) != 1:
            raise AmbiguousCatalogMatch(
                "multiple pinned records match the exact component source identity"
            )
        record = matches[0]
        component_identity = stable_hash(
            {
                "catalog_record_sha256": record.record_sha256,
                "request_sha256": request.request_sha256,
            },
            domain="flux-clone-catalog-component-instance-v1",
        )
        required_by_number = {pin.number: pin.required for pin in record.pins}
        component = Component(
            component_id=f"component-{component_identity}",
            reference=request.reference,
            value=request.value,
            manufacturer_part_number=record.manufacturer_part_number,
            package=record.package,
            symbol_id=request.schematic_library_id,
            footprint_id=request.footprint_library_id,
            datasheet_sha256=record.datasheet_sha256,
            pin_map_sha256=record.pin_map_sha256,
            pins=tuple(
                PinDefinition(
                    pin.pin_number,
                    pin.pin_name,
                    pin.electrical_type,
                    pin.pad_number,
                    required_by_number[pin.pin_number],
                )
                for pin in request.pins
            ),
        )
        return TrustedComponentResolution.create(
            request=request,
            evidence_id=f"catalog-{record.record_id}-{request.request_sha256}",
            resolver_id=self._snapshot.catalog_id,
            trust_snapshot_sha256=self._snapshot.source_sha256,
            component=component,
        )

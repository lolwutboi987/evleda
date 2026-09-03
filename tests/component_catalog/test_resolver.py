from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import unittest

from backend.canonical_import import ComponentProvenanceRequest, SourcePinPadBinding
from backend.component_catalog import (
    AmbiguousCatalogMatch,
    CatalogDigestMismatch,
    CatalogPin,
    InvalidCatalog,
    PinnedCatalogResolver,
    catalog_pin_map_sha256,
)


def request(*, source: str = "1" * 64, reference: str = "U1") -> ComponentProvenanceRequest:
    return ComponentProvenanceRequest(
        source,
        f"footprint-{reference.lower()}",
        reference,
        "SENSOR",
        "Sensor:Deterministic_SMD",
        f"symbol-{reference.lower()}",
        "Sensor:Deterministic",
        (
            SourcePinPadBinding("1", "1", "IN", "input", "SIG"),
            SourcePinPadBinding("2", "2", "GND", "power_in", "GND"),
        ),
    )


def record(*, record_id: str = "sensor-a", mpn: str = "EXACT-SENSOR-001") -> dict[str, object]:
    pins = (
        CatalogPin("1", "1", "IN", "input", True),
        CatalogPin("2", "2", "GND", "power_in", True),
    )
    return {
        "recordId": record_id,
        "value": "SENSOR",
        "footprintLibraryId": "Sensor:Deterministic_SMD",
        "schematicLibraryId": "Sensor:Deterministic",
        "manufacturerPartNumber": mpn,
        "package": "deterministic sensor package",
        "datasheetSha256": "a" * 64,
        "pinMapSha256": catalog_pin_map_sha256(pins),
        "pins": [
            {
                "number": pin.number,
                "padNumber": pin.pad_number,
                "name": pin.name,
                "electricalType": pin.electrical_type,
                "required": pin.required,
            }
            for pin in pins
        ],
    }


def catalog(*, records: list[dict[str, object]] | None = None) -> bytes:
    return json.dumps(
        {
            "schemaVersion": 1,
            "catalogId": "pinned-development-catalog-v1",
            "records": records if records is not None else [record()],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def resolver(payload: bytes | None = None) -> PinnedCatalogResolver:
    body = catalog() if payload is None else payload
    return PinnedCatalogResolver.from_json_bytes(
        body,
        expected_sha256=hashlib.sha256(body).hexdigest(),
    )


class PinnedCatalogResolverTests(unittest.TestCase):
    def test_committed_development_catalog_is_exactly_digest_pinned(self) -> None:
        catalog_path = Path("config/development-component-catalog.json")
        digest_path = Path("config/development-component-catalog.sha256")
        payload = catalog_path.read_bytes()
        expected = digest_path.read_text(encoding="ascii").split()[0]
        self.assertEqual(expected, hashlib.sha256(payload).hexdigest())
        pinned = PinnedCatalogResolver.from_json_bytes(
            payload,
            expected_sha256=expected,
        )
        self.assertEqual("api-resolution-fixture-v1", pinned.snapshot.catalog_id)

    def test_exact_record_resolves_to_source_bound_component_evidence(self) -> None:
        provenance_request = request()
        resolved = resolver().resolve(provenance_request)
        self.assertIsNotNone(resolved)
        assert resolved is not None
        self.assertEqual(provenance_request.request_sha256, resolved.request_sha256)
        self.assertEqual("EXACT-SENSOR-001", resolved.component.manufacturer_part_number)
        self.assertEqual(provenance_request.reference, resolved.component.reference)
        self.assertEqual(provenance_request.value, resolved.component.value)
        self.assertEqual(
            provenance_request.footprint_library_id,
            resolved.component.footprint_id,
        )
        self.assertEqual(
            provenance_request.schematic_library_id,
            resolved.component.symbol_id,
        )
        self.assertEqual(resolved.expected_evidence_sha256, resolved.evidence_sha256)

    def test_each_source_request_gets_distinct_instance_and_evidence_identity(self) -> None:
        first = resolver().resolve(request())
        second = resolver().resolve(request(source="2" * 64, reference="U2"))
        assert first is not None and second is not None
        self.assertNotEqual(first.component.component_id, second.component.component_id)
        self.assertNotEqual(first.evidence_id, second.evidence_id)
        self.assertNotEqual(first.evidence_sha256, second.evidence_sha256)
        self.assertEqual(first.trust_snapshot_sha256, second.trust_snapshot_sha256)

    def test_unknown_or_pin_mismatched_source_never_resolves(self) -> None:
        pinned = resolver()
        self.assertIsNone(pinned.resolve(replace(request(), value="UNKNOWN")))
        changed_pin = replace(
            request(),
            pins=(
                SourcePinPadBinding("1", "1", "DIFFERENT", "input", "SIG"),
                request().pins[1],
            ),
        )
        self.assertIsNone(pinned.resolve(changed_pin))

    def test_ambiguous_trusted_records_fail_closed(self) -> None:
        body = catalog(
            records=[
                record(record_id="sensor-a", mpn="MPN-A"),
                record(record_id="sensor-b", mpn="MPN-B"),
            ]
        )
        with self.assertRaises(AmbiguousCatalogMatch):
            resolver(body).resolve(request())

    def test_exact_catalog_byte_digest_is_mandatory(self) -> None:
        body = catalog()
        with self.assertRaises(CatalogDigestMismatch):
            PinnedCatalogResolver.from_json_bytes(
                body,
                expected_sha256="0" * 64,
            )

    def test_malformed_or_noncanonical_catalogs_are_rejected(self) -> None:
        valid = json.loads(catalog())
        cases: list[bytes] = []
        extra = dict(valid)
        extra["url"] = "file:///host/catalog.json"
        cases.append(json.dumps(extra).encode())
        wrong_version = dict(valid)
        wrong_version["schemaVersion"] = 2
        cases.append(json.dumps(wrong_version).encode())
        boolean_version = dict(valid)
        boolean_version["schemaVersion"] = True
        cases.append(json.dumps(boolean_version).encode())
        unsorted = dict(valid)
        unsorted["records"] = [
            record(record_id="sensor-b"),
            record(record_id="sensor-a"),
        ]
        cases.append(json.dumps(unsorted).encode())
        bad_pin_digest = json.loads(catalog())
        bad_pin_digest["records"][0]["pinMapSha256"] = "b" * 64
        cases.append(json.dumps(bad_pin_digest).encode())
        duplicate = catalog().decode().replace(
            '"catalogId":"pinned-development-catalog-v1"',
            '"catalogId":"pinned-development-catalog-v1","catalogId":"forged"',
        )
        cases.append(duplicate.encode())
        cases.append(b'{"schemaVersion":1,"catalogId":"x","records":[],"x":1.5}')
        cases.append("\ufeff".encode("utf-8") + catalog())
        for body in cases:
            with self.subTest(body=body[:80]):
                with self.assertRaises(InvalidCatalog):
                    resolver(body)


if __name__ == "__main__":
    unittest.main()

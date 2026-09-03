from __future__ import annotations

import json
import os
import tempfile
import unittest
from copy import deepcopy
from http.client import HTTPMessage
from io import BytesIO
from pathlib import Path
from typing import cast
from unittest.mock import patch

import pytest

from backend.evidence import reference_sources
from backend.evidence.reference_sources import (
    ReferenceSourceError,
    fetch_verified_sources,
    resolve_content_root,
    verify_manifest,
    verify_manifest_payload,
)
from backend.reference_design.specification import components, sources

# These assertions intentionally read the restricted vendor-byte cache.  They
# must never make a normal public clone or wheel test run depend on material
# that EvlEDA is not permitted to redistribute.
pytestmark = pytest.mark.restricted_evidence

_MANIFEST_PATH = (
    Path(__file__).resolve().parents[2]
    / "docs"
    / "evidence"
    / "reference_sources"
    / "manifest.json"
)
_STORE_ROOT = _MANIFEST_PATH.parent
_HISTORICAL_AP2112_BLOB = (
    _STORE_ROOT
    / "blobs"
    / "ef8d376f2ec356e29172eb9e053819a0ebdcc576dba7fc9ab0505c568427920f.pdf"
)
_HEADER_EVIDENCE_PATH = _MANIFEST_PATH.parents[1] / "wurth-elektronik-61300211121.json"
_OLD_HEADER_EVIDENCE_PATH = _MANIFEST_PATH.parents[1] / "wurth-elektronik-61300111121.json"


class ReferenceSourceManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_all_source_evidence_inventory_and_retained_blobs_verify(self) -> None:
        self.assertEqual((), verify_manifest())
        expected_ids = {source.evidence_id for source in sources()}
        actual_ids = {entry["evidence_id"] for entry in self.manifest["sources"]}
        self.assertEqual(expected_ids, actual_ids)
        self.assertEqual(len(expected_ids), self.manifest["source_evidence_count"])

    def test_manifest_binds_exact_titles_urls_revisions_hashes_and_component_mpns(self) -> None:
        component_mpns = {
            component.component_id: component.manufacturer_part_number for component in components()
        }
        by_id = {source.evidence_id: source for source in sources()}
        for entry in self.manifest["sources"]:
            source = by_id[entry["evidence_id"]]
            self.assertEqual(source.title, entry["title"])
            self.assertEqual(source.uri, entry["uri"])
            self.assertEqual(source.document_revision, entry["document_revision"])
            self.assertEqual(source.sha256, entry["expected_sha256"])
            bindings = [tuple(binding) for binding in entry["subject"]["component_mpn_bindings"]]
            expected_bindings = [
                (component_id, component_mpns[component_id])
                for component_id in source.component_ids
            ]
            self.assertEqual(
                expected_bindings,
                bindings,
            )
            self.assertTrue(entry["subject"]["source_subject_verified"])

    def test_r2_live_manifest_excludes_ap2112_but_preserves_historical_blob(self) -> None:
        ids = {entry["evidence_id"] for entry in self.manifest["sources"]}
        self.assertEqual(20, len(ids))
        self.assertNotIn("src-ap2112", ids)
        self.assertFalse(
            any("drawing" in evidence_id for evidence_id in ids if "usb4105" in evidence_id)
        )
        self.assertIn("src-kicad-footprint-usb4105", ids)
        self.assertTrue(_HISTORICAL_AP2112_BLOB.is_file())
        self.assertEqual(
            755270,
            _HISTORICAL_AP2112_BLOB.stat().st_size,
        )
        self.assertTrue(
            {
                "src-kemet-c0g-family",
                "src-kemet-c1206c104",
                "src-kemet-t59x",
                "src-ti-lp38692-datasheet",
                "src-ti-lp38692-package-materials",
                "src-ti-lp38692-product",
                "src-vishay-wslp",
                "src-vishay-wslp-product",
            }
            <= ids
        )

    def test_lp38692_revision_matches_the_retained_snvs322m_body(self) -> None:
        entry = next(
            item
            for item in self.manifest["sources"]
            if item["evidence_id"] == "src-ti-lp38692-datasheet"
        )
        self.assertEqual(
            "SNVS322M-December-2004-Revised-December-2015",
            entry["document_revision"],
        )
        self.assertEqual(
            "SNVS322M, December 2004, revised December 2015",
            entry["observed_document_revision"],
        )
        source = next(
            item for item in sources() if item.evidence_id == "src-ti-lp38692-datasheet"
        )
        self.assertEqual(entry["document_revision"], source.document_revision)
        self.assertTrue(any("10/2025 footer is not" in fact for fact in source.facts))

    def test_corrected_wurth_header_is_two_pin_61300211121(self) -> None:
        header = json.loads(_HEADER_EVIDENCE_PATH.read_text(encoding="utf-8"))
        self.assertFalse(_OLD_HEADER_EVIDENCE_PATH.exists())
        self.assertEqual(
            {
                "manufacturer": "Würth Elektronik",
                "manufacturer_part_number": "61300211121",
            },
            header["part"],
        )
        self.assertEqual(
            "https://www.we-online.com/components/products/datasheet/61300211121.pdf",
            header["provenance"]["official_datasheet"]["url"],
        )
        self.assertEqual(
            "a054dde42f94b42e1f34117df97a37071aa9e57febcb8375058a3fb7dbae6dbe",
            header["provenance"]["official_datasheet"]["sha256"],
        )
        self.assertEqual(2, header["official_facts"]["pin_count"])
        self.assertEqual(2540000, header["official_facts"]["pitch_nm"])
        self.assertEqual(
            "61300211121",
            header["official_subject_verification"]["observed_order_code"],
        )
        self.assertEqual(
            "a2a5bafe56b2d0f25e8213f54a95abf500a9089b5c172065bd0beeb6da86d84c",
            header["canonical_pin_map"]["sha256"],
        )

    def test_verifier_rejects_wrong_mpn(self) -> None:
        payload = deepcopy(self.manifest)
        header = next(
            entry for entry in payload["sources"] if entry["evidence_id"] == "src-wurth-header"
        )
        header["subject"]["component_mpn_bindings"][0][1] = "61300111121"
        failures = verify_manifest_payload(payload, _STORE_ROOT)
        self.assertTrue(any("component MPN bindings" in failure for failure in failures))

    def test_verifier_rejects_wrong_hash(self) -> None:
        payload = deepcopy(self.manifest)
        header = next(
            entry for entry in payload["sources"] if entry["evidence_id"] == "src-wurth-header"
        )
        header["expected_sha256"] = "0" * 64
        failures = verify_manifest_payload(payload, _STORE_ROOT)
        self.assertTrue(
            any("does not equal" in failure or "SHA-256" in failure for failure in failures)
        )

    def test_verifier_rejects_missing_retained_bytes(self) -> None:
        payload = deepcopy(self.manifest)
        header = next(
            entry for entry in payload["sources"] if entry["evidence_id"] == "src-wurth-header"
        )
        header["content_path"] = "blobs/does-not-exist.pdf"
        failures = verify_manifest_payload(payload, _STORE_ROOT)
        self.assertTrue(any("missing source bytes" in failure for failure in failures))


class _FakeResponse:
    def __init__(self, body: bytes, content_length: int | None = None, status: int = 200) -> None:
        self._body = body
        self._offset = 0
        self._status = status
        self.headers = {
            "Content-Length": str(len(body) if content_length is None else content_length)
        }
        self.closed = False

    def getcode(self) -> int:
        return self._status

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self._body) - self._offset
        result = self._body[self._offset : self._offset + size]
        self._offset += len(result)
        return result

    def close(self) -> None:
        self.closed = True


class _FakeOpener:
    def __init__(self, response: _FakeResponse) -> None:
        self.response = response
        self.calls = 0

    def open(self, request: object, timeout: float) -> _FakeResponse:
        del request, timeout
        self.calls += 1
        return self.response


class ReferenceSourceFetchTests(unittest.TestCase):
    @staticmethod
    def _single_verified_manifest() -> tuple[dict[str, object], bytes, str]:
        payload_value = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
        payload = cast(dict[str, object], deepcopy(payload_value))
        selected_id = "src-ti-lp38692-product"
        entries = cast(list[dict[str, object]], payload["sources"])
        selected = next(item for item in entries if item["evidence_id"] == selected_id)
        selected_path = _STORE_ROOT / cast(str, selected["content_path"])
        body = selected_path.read_bytes()
        for entry in entries:
            if (
                entry["evidence_id"] != selected_id
                and entry["retention_status"] == "verified"
            ):
                entry["retention_status"] = "manifest-only-unverified"
                entry["content_path"] = None
                entry["unverified_reason"] = "test-only source exclusion"
        return payload, body, selected_id

    def test_fetches_only_verified_entries_and_is_idempotent(self) -> None:
        payload, body, selected_id = self._single_verified_manifest()
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            manifest_path = temp_root / "manifest.json"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            response = _FakeResponse(body)
            opener = _FakeOpener(response)
            with patch.object(
                reference_sources.urllib.request, "build_opener", return_value=opener
            ):
                first = fetch_verified_sources(temp_root / "cache", manifest_path)
                second = fetch_verified_sources(temp_root / "cache", manifest_path)
            self.assertEqual(1, opener.calls)
            self.assertEqual((selected_id,), tuple(result.evidence_id for result in first))
            self.assertEqual("downloaded", first[0].action)
            self.assertEqual("existing", second[0].action)
            entries = cast(list[dict[str, object]], payload["sources"])
            selected_entry = next(
                entry for entry in entries if entry["evidence_id"] == selected_id
            )
            self.assertTrue(
                (
                    temp_root
                    / "cache"
                    / Path(cast(str, selected_entry["content_path"]))
                ).is_file()
            )

    def test_fetch_rejects_non_https_before_network(self) -> None:
        payload, _, _ = self._single_verified_manifest()
        selected = next(
            item
            for item in cast(list[dict[str, object]], payload["sources"])
            if item["retention_status"] == "verified"
        )
        selected["uri"] = cast(str, selected["uri"]).replace("https://", "http://", 1)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaises(ReferenceSourceError):
                fetch_verified_sources(root / "cache", manifest_path)

    def test_fetch_hard_denies_manifest_only_sources_even_when_json_flips_verified(self) -> None:
        payload_value = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
        payload = cast(dict[str, object], deepcopy(payload_value))
        entries = cast(list[dict[str, object]], payload["sources"])
        denied = next(item for item in entries if item["evidence_id"] == "src-usb-type-c-r25")
        denied["retention_status"] = "verified"
        denied["content_path"] = "blobs/not-authorized.pdf"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            opener = _FakeOpener(_FakeResponse(b"unused"))
            with (
                patch.object(
                    reference_sources.urllib.request, "build_opener", return_value=opener
                ),
                self.assertRaisesRegex(ReferenceSourceError, "hard-denied"),
            ):
                fetch_verified_sources(root / "cache", manifest_path)
            self.assertEqual(0, opener.calls)

    def test_public_pinned_usb4105_footprint_is_exact_and_cannot_be_made_fetchable(self) -> None:
        payload_value = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
        payload = cast(dict[str, object], deepcopy(payload_value))
        entries = cast(list[dict[str, object]], payload["sources"])
        external = next(
            item for item in entries if item["evidence_id"] == "src-kicad-footprint-usb4105"
        )
        self.assertEqual("public-pinned-external", external["retention_status"])
        self.assertIsNone(external["content_path"])
        self.assertEqual(6860, external["size_bytes"])
        self.assertEqual(
            "3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8",
            external["expected_sha256"],
        )
        self.assertIn(
            "f6d77c54d79275c888daae4c60e4c9869ffa4aa5",
            cast(str, external["uri"]),
        )

        external["retention_status"] = "verified"
        external["content_path"] = "blobs/not-authorized.kicad_mod"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            opener = _FakeOpener(_FakeResponse(b"unused"))
            with (
                patch.object(
                    reference_sources.urllib.request, "build_opener", return_value=opener
                ),
                self.assertRaisesRegex(ReferenceSourceError, "not authorized"),
            ):
                fetch_verified_sources(root / "cache", manifest_path)
            self.assertEqual(0, opener.calls)

    def test_fetch_rejects_rebinding_a_verified_source_to_a_different_path(self) -> None:
        payload, _, _ = self._single_verified_manifest()
        entries = cast(list[dict[str, object]], payload["sources"])
        selected = next(item for item in entries if item["retention_status"] == "verified")
        selected["content_path"] = "blobs/another-authority.pdf"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ReferenceSourceError, "not authorized"):
                fetch_verified_sources(root / "cache", manifest_path)

    def test_fetch_rejects_length_mismatch_and_leaves_no_blob(self) -> None:
        payload, body, _ = self._single_verified_manifest()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            response = _FakeResponse(body, content_length=len(body) + 1)
            opener = _FakeOpener(response)
            with (
                patch.object(
                    reference_sources.urllib.request, "build_opener", return_value=opener
                ),
                self.assertRaisesRegex(ReferenceSourceError, "Content-Length"),
            ):
                fetch_verified_sources(root / "cache", manifest_path)
            self.assertEqual(1, opener.calls)
            self.assertEqual([], [path for path in (root / "cache").rglob("*") if path.is_file()])

    def test_fetch_rejects_existing_mismatched_blob_without_overwrite(self) -> None:
        payload, _, _ = self._single_verified_manifest()
        selected = next(
            item
            for item in cast(list[dict[str, object]], payload["sources"])
            if item["retention_status"] == "verified"
        )
        relative = Path(cast(str, selected["content_path"]))
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(payload), encoding="utf-8")
            target = root / "cache" / relative
            target.parent.mkdir(parents=True)
            target.write_bytes(b"wrong")
            opener = _FakeOpener(_FakeResponse(b"unused"))
            with (
                patch.object(
                    reference_sources.urllib.request, "build_opener", return_value=opener
                ),
                self.assertRaisesRegex(ReferenceSourceError, "existing source"),
            ):
                fetch_verified_sources(root / "cache", manifest_path)
            self.assertEqual(0, opener.calls)
            self.assertEqual(b"wrong", target.read_bytes())

    def test_redirect_handler_rejects_other_hostname_and_too_many_redirects(self) -> None:
        handler = reference_sources.LimitedRedirectHandler("vendor.example", 1)
        request = reference_sources.urllib.request.Request("https://vendor.example/a")
        with self.assertRaisesRegex(ReferenceSourceError, "different hostname"):
            handler.redirect_request(
                request,
                BytesIO(),
                302,
                "found",
                HTTPMessage(),
                "https://other.example/b",
            )
        with self.assertRaisesRegex(ReferenceSourceError, "redirect limit"):
            handler.redirect_request(
                request,
                BytesIO(),
                302,
                "found",
                HTTPMessage(),
                "https://vendor.example/b",
            )

    def test_content_root_explicit_argument_wins_over_environment(self) -> None:
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            manifest = Path(first) / "manifest.json"
            with patch.dict(os.environ, {reference_sources.REFERENCE_EVIDENCE_ROOT_ENV: second}):
                self.assertEqual(Path(second), resolve_content_root(manifest))
                self.assertEqual(Path(first), resolve_content_root(manifest, Path(first)))


if __name__ == "__main__":
    unittest.main()

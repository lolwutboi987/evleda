from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import cast

from backend.evidence.reference_sources import (
    IMMUTABLE_MANIFEST_SHA256,
    verify_manifest_payload,
)
from backend.reference_design.footprints import KICAD_LIBRARY_PROVENANCE
from backend.reference_design.specification import (
    KICAD_FOOTPRINT_COMMIT,
    KICAD_USB4105_FOOTPRINT_SHA256,
    USB4105_SPEC_SHA256,
    components,
    sources,
)

_ROOT = Path(__file__).resolve().parents[2]
_SOURCE_MANIFEST = _ROOT / "docs" / "evidence" / "reference_sources" / "manifest.json"
_PACKAGED_MANIFEST = _ROOT / "evleda" / "evidence" / "reference_sources" / "manifest.json"


def test_public_usb4105_source_is_commit_and_digest_pinned_without_restricted_dependency() -> None:
    source_by_id = {source.evidence_id: source for source in sources()}
    assert all(
        "drawing" not in evidence_id
        for evidence_id in source_by_id
        if "usb4105" in evidence_id
    )
    source = source_by_id["src-kicad-footprint-usb4105"]
    assert source.sha256 == KICAD_USB4105_FOOTPRINT_SHA256
    assert KICAD_FOOTPRINT_COMMIT in source.uri
    assert KICAD_FOOTPRINT_COMMIT in source.document_revision

    connector = next(component for component in components() if component.component_id == "usb-j1")
    assert connector.datasheet_sha256 == USB4105_SPEC_SHA256
    assert next(
        digest for profile, _, digest in KICAD_LIBRARY_PROVENANCE if profile == "usb4105"
    ) == KICAD_USB4105_FOOTPRINT_SHA256


def test_source_and_packaged_manifests_are_identical_and_close_public_external_record() -> None:
    source_bytes = _SOURCE_MANIFEST.read_bytes()
    assert source_bytes == _PACKAGED_MANIFEST.read_bytes()
    assert hashlib.sha256(source_bytes).hexdigest() == IMMUTABLE_MANIFEST_SHA256
    payload = cast(dict[str, object], json.loads(source_bytes))
    entries = cast(list[dict[str, object]], payload["sources"])
    entry = next(
        candidate
        for candidate in entries
        if candidate["evidence_id"] == "src-kicad-footprint-usb4105"
    )
    assert entry["retention_status"] == "public-pinned-external"
    assert entry["content_path"] is None
    assert entry["size_bytes"] == 6860
    assert entry["expected_sha256"] == KICAD_USB4105_FOOTPRINT_SHA256
    assert entry["retrieved_sha256"] == KICAD_USB4105_FOOTPRINT_SHA256
    assert "CC BY-SA 4.0" in cast(str, entry["license_note"])

    errors = verify_manifest_payload(payload, _SOURCE_MANIFEST.parent)
    assert not any(message.startswith("src-kicad-footprint-usb4105:") for message in errors)

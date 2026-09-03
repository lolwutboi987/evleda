"""Validated legal payloads embedded in standalone EvlEDA hardware archives."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from importlib.resources import files
from typing import cast

_MANIFEST_FILENAME = "manifest.json"
_MANIFEST_KIND = "evleda-standalone-hardware-legal-payloads"
_SHA256 = re.compile(r"[0-9a-f]{64}")
_EXPECTED_MEDIA_TYPES = {
    "CC-BY-SA-4.0.txt": "text/plain",
    "CERN-OHL-P-2.0.txt": "text/plain",
    "KiCad-Libraries-LICENSE.md": "text/markdown",
    "NOTICE.txt": "text/plain",
    "THIRD_PARTY_NOTICES.md": "text/markdown",
}


class LegalPayloadError(RuntimeError):
    """The packaged legal resource set failed its closed integrity contract."""


@dataclass(frozen=True, slots=True, order=True)
class LegalPayload:
    filename: str
    media_type: str
    payload: bytes
    sha256: str

    def __post_init__(self) -> None:
        if type(self) is not LegalPayload:
            raise LegalPayloadError("legal payload must use the exact type")
        expected_media_type = _EXPECTED_MEDIA_TYPES.get(self.filename)
        if expected_media_type is None or self.media_type != expected_media_type:
            raise LegalPayloadError("legal payload filename or media type is invalid")
        if type(self.payload) is not bytes or not self.payload:
            raise LegalPayloadError("legal payload bytes must be nonempty and exact")
        if type(self.sha256) is not str or _SHA256.fullmatch(self.sha256) is None:
            raise LegalPayloadError("legal payload SHA-256 is invalid")
        if hashlib.sha256(self.payload).hexdigest() != self.sha256:
            raise LegalPayloadError("legal payload SHA-256 does not bind its bytes")

    @property
    def archive_filename(self) -> str:
        return f"legal/{self.filename}"


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise LegalPayloadError(f"legal manifest has duplicate key: {key}")
        result[key] = value
    return result


def load_legal_payloads() -> tuple[LegalPayload, ...]:
    """Load the fixed legal inventory and verify every resource before returning it."""

    package_root = files(__package__)
    try:
        raw_manifest = package_root.joinpath(_MANIFEST_FILENAME).read_bytes()
        decoded = json.loads(
            raw_manifest.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise LegalPayloadError("packaged legal manifest is unreadable") from exc
    if type(decoded) is not dict:
        raise LegalPayloadError("packaged legal manifest must be an object")
    manifest = cast(dict[str, object], decoded)
    if (
        set(manifest) != {"schema_version", "kind", "files"}
        or manifest["schema_version"] != 1
        or manifest["kind"] != _MANIFEST_KIND
        or type(manifest["files"]) is not list
    ):
        raise LegalPayloadError("packaged legal manifest subject is invalid")

    entries = cast(list[object], manifest["files"])
    if len(entries) != len(_EXPECTED_MEDIA_TYPES):
        raise LegalPayloadError("packaged legal manifest inventory is incomplete")
    payloads: list[LegalPayload] = []
    seen: set[str] = set()
    for raw_entry in entries:
        if type(raw_entry) is not dict:
            raise LegalPayloadError("packaged legal manifest entry must be an object")
        entry = cast(dict[str, object], raw_entry)
        if set(entry) != {"filename", "media_type", "byte_length", "sha256"}:
            raise LegalPayloadError("packaged legal manifest entry shape is invalid")
        filename = entry["filename"]
        media_type = entry["media_type"]
        byte_length = entry["byte_length"]
        digest = entry["sha256"]
        if (
            type(filename) is not str
            or filename in seen
            or type(media_type) is not str
            or _EXPECTED_MEDIA_TYPES.get(filename) != media_type
            or type(byte_length) is not int
            or byte_length < 1
            or type(digest) is not str
            or _SHA256.fullmatch(digest) is None
        ):
            raise LegalPayloadError("packaged legal manifest entry is invalid")
        resource = package_root.joinpath(filename)
        try:
            if not resource.is_file():
                raise LegalPayloadError(f"packaged legal resource is missing: {filename}")
            payload = resource.read_bytes()
        except OSError as exc:
            raise LegalPayloadError(f"packaged legal resource is unreadable: {filename}") from exc
        if len(payload) != byte_length or hashlib.sha256(payload).hexdigest() != digest:
            raise LegalPayloadError(f"packaged legal resource is not manifest-bound: {filename}")
        payloads.append(LegalPayload(filename, media_type, payload, digest))
        seen.add(filename)
    if seen != set(_EXPECTED_MEDIA_TYPES):
        raise LegalPayloadError("packaged legal filenames differ from the fixed inventory")
    result = tuple(sorted(payloads))
    if tuple(item.filename for item in result) != tuple(sorted(_EXPECTED_MEDIA_TYPES)):
        raise LegalPayloadError("packaged legal inventory is not canonical")
    return result


__all__ = ("LegalPayload", "LegalPayloadError", "load_legal_payloads")

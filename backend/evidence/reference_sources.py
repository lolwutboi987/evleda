"""Fail-closed verification for the reference design's primary-source manifest."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from http.client import HTTPMessage
from importlib import resources
from pathlib import Path
from typing import IO, BinaryIO, cast

from backend.reference_design.specification import components, sources

_SOURCE_MANIFEST_PATH = (
    Path(__file__).resolve().parents[2]
    / "docs"
    / "evidence"
    / "reference_sources"
    / "manifest.json"
)
_INSTALLED_MANIFEST_PATH = Path(
    str(resources.files("evleda").joinpath("evidence/reference_sources/manifest.json"))
)
DEFAULT_MANIFEST_PATH = (
    _SOURCE_MANIFEST_PATH if _SOURCE_MANIFEST_PATH.is_file() else _INSTALLED_MANIFEST_PATH
)

# Public distributions contain the manifest but intentionally do not contain the copyrighted
# source bytes.  A user who has permission to retrieve those bytes can populate a private cache
# and point the verifier at it with this explicit override.
REFERENCE_EVIDENCE_ROOT_ENV = "EVLEDA_REFERENCE_EVIDENCE_ROOT"
FETCH_REFERENCE_SOURCES_COMMAND = "evleda-fetch-reference-sources"
DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
HARD_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_REDIRECTS = 3
DEFAULT_TIMEOUT_SECONDS = 30.0

# Authorization is pinned independently of the caller-provided manifest.  This prevents a
# downloaded or user-edited manifest from turning a non-fetchable or manifest-only record into a
# fetchable record.  Update this tuple and the digest together only as an intentional source-set
# review.  The digest is the SHA-256 of the checked-in/package manifest as of this source release.
IMMUTABLE_MANIFEST_SHA256 = "14fb5c8a7c302f0f951bf7cbb172d83ef2d5b8dd868fff33582cbd277165d6e8"
HARD_DENIED_EVIDENCE_IDS = frozenset(
    {"src-usb-type-c-r25", "src-keystone-testpoint"}
)
_IMMUTABLE_SOURCE_LAYOUT: dict[str, tuple[str, int, str | None, str, str]] = {
    "src-usb-type-c-r25": (
        "manifest-only-unverified", 29756254, None,
        "https://www.usb.org/sites/default/files/USB%20Type-C%202.5%20Release%20202603.zip",
        "603c2cb0ea356d367fea61f8747a21981f0da9abae4d8ec15556e0063edb81b5",
    ),
    "src-kicad-footprint-usb4105": (
        "public-pinned-external", 6860, None,
        "https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/"
        "f6d77c54d79275c888daae4c60e4c9869ffa4aa5/Connector_USB.pretty/"
        "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.kicad_mod",
        "3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8",
    ),
    "src-usb4105-spec": (
        "verified", 358821,
        "blobs/372fe1bc0e0b1b4ce7e18b61514e967c7c2f883f0c7fe1f4586b567785ee9cd2.pdf",
        "https://gct.co/files/specs/usb4105-spec.pdf",
        "372fe1bc0e0b1b4ce7e18b61514e967c7c2f883f0c7fe1f4586b567785ee9cd2",
    ),
    "src-ti-usb-c-guide": (
        "verified", 3104135,
        "blobs/628c876e0a9bc49f3605fded91eaef7f8a7b84914861d3a315fa8e8f61efc892.pdf",
        "https://www.ti.com/lit/pdf/slyy228",
        "628c876e0a9bc49f3605fded91eaef7f8a7b84914861d3a315fa8e8f61efc892",
    ),
    "src-tps2596": (
        "verified", 4249190,
        "blobs/66f6bae4494f7bfe7dfdc314e508f0291d9ca1e87265cca9b6fdfeaa5cb19fe9.pdf",
        "https://www.ti.com/lit/ds/symlink/tps2596.pdf",
        "66f6bae4494f7bfe7dfdc314e508f0291d9ca1e87265cca9b6fdfeaa5cb19fe9",
    ),
    "src-ti-lp38692-datasheet": (
        "verified", 1652696,
        "blobs/37d312bc1c8189f8fe4275ceaf8928d447cb6faaa2796e503d6120a891376352.pdf",
        "https://www.ti.com/lit/ds/symlink/lp38692.pdf",
        "37d312bc1c8189f8fe4275ceaf8928d447cb6faaa2796e503d6120a891376352",
    ),
    "src-ti-lp38692-package-materials": (
        "verified", 60389,
        "blobs/66d625b45fbcf490aadf6a7fc21dff541020bfe54c09f0de5a58ed825cce0799.pdf",
        "https://www.ti.com/ods/sysadd/pm/symlink/lp38690_pm.pdf",
        "66d625b45fbcf490aadf6a7fc21dff541020bfe54c09f0de5a58ed825cce0799",
    ),
    "src-ti-lp38692-product": (
        "verified", 87635,
        "blobs/ffd6ccd9379b910b36798c39ab5297c8bddc47dd31c8ec1ec628923220eb745a.html",
        "https://www.ti.com/product/LP38692/part-details/LP38692MPX-3.3/NOPB",
        "ffd6ccd9379b910b36798c39ab5297c8bddc47dd31c8ec1ec628923220eb745a",
    ),
    "src-kemet-t59x": (
        "verified", 4609530,
        "blobs/64cc7925483d23bc88a92c0dde3bba58e60152765bed5602f859c04c0c5db729.pdf",
        "https://content.kemet.com/datasheets/KEM_T2073_T59X.pdf",
        "64cc7925483d23bc88a92c0dde3bba58e60152765bed5602f859c04c0c5db729",
    ),
    "src-vishay-wslp": (
        "verified", 146445,
        "blobs/5d20b5572767451d6a38e1e37c6f0f3113eb604e72593a6cd97a0a944458455b.pdf",
        "https://www.vishay.com/docs/30122/wslp.pdf",
        "5d20b5572767451d6a38e1e37c6f0f3113eb604e72593a6cd97a0a944458455b",
    ),
    "src-vishay-wslp-product": (
        "verified", 780953,
        "blobs/c82fdb1a9530a67f215e0d29417d0e47d08d86353783242aad4f93476665ca39.html",
        "https://www.vishay.com/en/product/30122/",
        "c82fdb1a9530a67f215e0d29417d0e47d08d86353783242aad4f93476665ca39",
    ),
    "src-kemet-c0g-family": (
        "verified", 824883,
        "blobs/02d179914aeb9585eb2229ba8e18ef9d6b01c77c056de2af295d6950a2a5cc0d.pdf",
        "https://content.kemet.com/datasheets/kem_c1003_c0g_smd.pdf",
        "02d179914aeb9585eb2229ba8e18ef9d6b01c77c056de2af295d6950a2a5cc0d",
    ),
    "src-kemet-c1206c104": (
        "verified", 239358,
        "blobs/dbafe0002fa3f302ec182bbe37f000f47190256b73ee7c10b8066a55df835609.pdf",
        "https://search.kemet.com/component-documentation/download/specsheet/C1206C104J3GACTU",
        "dbafe0002fa3f302ec182bbe37f000f47190256b73ee7c10b8066a55df835609",
    ),
    "src-ptvs": (
        "verified", 239055,
        "blobs/dd54840b481bf99b3a1082dd08cd556e695991a1b36799e98eb43b7e890e00c1.pdf",
        "https://assets.nexperia.com/documents/data-sheet/PTVS5V5Z1UPC.pdf",
        "dd54840b481bf99b3a1082dd08cd556e695991a1b36799e98eb43b7e890e00c1",
    ),
    "src-vishay-resistors": (
        "verified", 150402,
        "blobs/504e687c8ff86ffc367637421ff0035d9999f663c62d9a8e352a0eab3dd5cd84.pdf",
        "https://www.vishay.com/docs/20035/dcrcwe3.pdf",
        "504e687c8ff86ffc367637421ff0035d9999f663c62d9a8e352a0eab3dd5cd84",
    ),
    "src-wurth-cap": (
        "verified", 455408,
        "blobs/eff87bfa4247a47581c55478f6785a150e90385c3d6ac9ccae441ed9a5903f18.pdf",
        "https://www.we-online.com/components/products/datasheet/885012207051.pdf",
        "eff87bfa4247a47581c55478f6785a150e90385c3d6ac9ccae441ed9a5903f18",
    ),
    "src-kemet-cap": (
        "verified", 289634,
        "blobs/cf62230c9eab481767a04c96beb3822aa6328f65277ecd3e59697459c211043c.pdf",
        "https://search.kemet.com/component-documentation/download/specsheet/C0805C475K3RACTU",
        "cf62230c9eab481767a04c96beb3822aa6328f65277ecd3e59697459c211043c",
    ),
    "src-wurth-led": (
        "verified", 899904,
        "blobs/75685f7ae49ae4fa3c05ea3c6ad7a72d53747ca803320a8b96b8fdf38b368da7.pdf",
        "https://www.we-online.com/components/products/datasheet/150060VS75000.pdf",
        "75685f7ae49ae4fa3c05ea3c6ad7a72d53747ca803320a8b96b8fdf38b368da7",
    ),
    "src-wurth-header": (
        "verified", 383644,
        "blobs/a054dde42f94b42e1f34117df97a37071aa9e57febcb8375058a3fb7dbae6dbe.pdf",
        "https://www.we-online.com/components/products/datasheet/61300211121.pdf",
        "a054dde42f94b42e1f34117df97a37071aa9e57febcb8375058a3fb7dbae6dbe",
    ),
    "src-keystone-testpoint": (
        "manifest-only-unverified", 12497120, None,
        "https://www.keystone-europe.com/wp-content/uploads/2025/08/terminal-test-points.pdf",
        "00919bf8da5da41c978fe22717f8b39d443d03bb69bdd0a853ced85479fb237c",
    ),
}


class ReferenceSourceError(RuntimeError):
    """A source cache or source retrieval failed its fail-closed contract."""


@dataclass(frozen=True, slots=True)
class FetchResult:
    """Deterministic outcome for one manifest-selected source retrieval."""

    evidence_id: str
    content_path: str
    sha256: str
    size_bytes: int
    action: str


def resolve_content_root(
    manifest_path: Path = DEFAULT_MANIFEST_PATH,
    content_root: Path | None = None,
) -> Path:
    """Resolve the private source-byte root without guessing across installations.

    ``content_root`` wins over :envvar:`EVLEDA_REFERENCE_EVIDENCE_ROOT`.  With neither
    supplied, the manifest's parent is used.  That preserves the source checkout layout while
    making a wheel's missing private bytes fail with an actionable error.
    """

    if content_root is not None:
        return content_root.expanduser()
    configured = os.environ.get(REFERENCE_EVIDENCE_ROOT_ENV)
    if configured:
        return Path(configured).expanduser()
    return manifest_path.parent


def _dict(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise TypeError("expected a JSON object")
    return cast(dict[str, object], value)


def _list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise TypeError("expected a JSON array")
    return cast(list[object], value)


def _text(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("expected JSON text")
    return value


def _component_mpn_bindings(value: object) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for raw_binding in _list(value):
        binding = _list(raw_binding)
        if len(binding) != 2:
            raise TypeError("component MPN binding must contain two values")
        result.append((_text(binding[0]), _text(binding[1])))
    return result


def verify_manifest_payload(
    payload: object,
    content_root: Path,
) -> tuple[str, ...]:
    """Return all manifest errors; an empty tuple means the manifest is closed.

    ``content_root`` is the directory containing the manifest's ``blobs`` path.
    Keeping it injectable lets tests exercise missing, wrong-hash, and wrong-MPN
    failures against a temporary manifest without touching the checked-in bytes.
    """

    errors: list[str] = []
    try:
        manifest = _dict(payload)
        expected_sources = {source.evidence_id: source for source in sources()}
        expected_components = {component.component_id: component for component in components()}
        raw_entries = _list(manifest["sources"])
        entries = [_dict(entry) for entry in raw_entries]
    except (KeyError, TypeError, ValueError) as error:
        return (f"manifest schema is malformed: {error}",)

    retrieval_value = manifest.get("retrieval")
    if not isinstance(retrieval_value, dict):
        errors.append("manifest retrieval report is missing")
    else:
        retrieval = cast(dict[str, object], retrieval_value)
        if retrieval.get("status_code") != 200:
            errors.append(
                f"manifest retrieval status is not HTTP 200: {retrieval.get('status_code')!r}"
            )
        if retrieval.get("all_urls_available_at_check") is not True:
            errors.append("manifest retrieval report does not confirm URL availability")

    expected_count = manifest.get("source_evidence_count")
    if expected_count != len(expected_sources):
        errors.append(
            f"source_evidence_count={expected_count!r} does not equal {len(expected_sources)}"
        )
    entry_ids = [_text(entry.get("evidence_id")) for entry in entries if "evidence_id" in entry]
    if len(entry_ids) != len(set(entry_ids)):
        errors.append("manifest contains duplicate evidence IDs")
    if set(entry_ids) != set(expected_sources):
        errors.append(
            f"manifest IDs differ from SourceEvidence: actual={sorted(entry_ids)!r} "
            f"expected={sorted(expected_sources)!r}"
        )

    for entry in entries:
        evidence_id = entry.get("evidence_id")
        if not isinstance(evidence_id, str):
            errors.append("manifest entry has no text evidence_id")
            continue
        source = expected_sources.get(evidence_id)
        if source is None:
            errors.append(f"manifest has unknown evidence ID {evidence_id!r}")
            continue
        for field, expected in (
            ("title", source.title),
            ("uri", source.uri),
            ("document_revision", source.document_revision),
            ("expected_sha256", source.sha256),
        ):
            if entry.get(field) != expected:
                errors.append(
                    f"{evidence_id}: {field}={entry.get(field)!r} does not equal {expected!r}"
                )

        try:
            subject = _dict(entry["subject"])
            bindings = _component_mpn_bindings(subject["component_mpn_bindings"])
            expected_bindings = [
                (component_id, expected_components[component_id].manufacturer_part_number)
                for component_id in source.component_ids
            ]
        except (KeyError, TypeError, ValueError) as error:
            errors.append(f"{evidence_id}: malformed subject binding: {error}")
            continue
        if bindings != expected_bindings:
            errors.append(
                f"{evidence_id}: component MPN bindings={bindings!r} expected={expected_bindings!r}"
            )
        if subject.get("source_subject_verified") is not True:
            errors.append(f"{evidence_id}: source subject is not verified")
        tokens = subject.get("source_mpn_tokens")
        token_values = cast(list[object], tokens) if isinstance(tokens, list) else []
        if not token_values or not all(isinstance(token, str) and token for token in token_values):
            errors.append(
                f"{evidence_id}: source_mpn_tokens must be non-empty text where applicable"
            )

        expected_sha256 = entry.get("expected_sha256")
        retrieved_sha256 = entry.get("retrieved_sha256")
        if retrieved_sha256 != expected_sha256:
            errors.append(
                f"{evidence_id}: retrieved_sha256={retrieved_sha256!r} does not equal "
                f"expected_sha256={expected_sha256!r}"
            )
        status = entry.get("retention_status")
        content_path = entry.get("content_path")
        if status == "verified":
            if not isinstance(content_path, str) or not content_path:
                errors.append(f"{evidence_id}: verified source has no content_path")
                continue
            relative_path = Path(content_path)
            if relative_path.is_absolute() or ".." in relative_path.parts:
                errors.append(f"{evidence_id}: content_path escapes the evidence store")
                continue
            blob_path = content_root / relative_path
            try:
                root_resolved = content_root.resolve()
                blob_resolved = blob_path.resolve(strict=False)
            except OSError as error:
                errors.append(f"{evidence_id}: cannot resolve source cache path: {error}")
                continue
            if content_root.is_symlink():
                errors.append(f"{evidence_id}: source cache root must not be a symlink")
                continue
            if not blob_resolved.is_relative_to(root_resolved):
                errors.append(f"{evidence_id}: content_path escapes the evidence store")
                continue
            if blob_path.is_symlink() or blob_path.parent.is_symlink():
                errors.append(f"{evidence_id}: source cache path must not be a symlink")
                continue
            if not blob_path.is_file():
                errors.append(f"{evidence_id}: missing source bytes at {content_path}")
                continue
            actual_hash = hashlib.sha256(blob_path.read_bytes()).hexdigest()
            if actual_hash != expected_sha256:
                errors.append(
                    f"{evidence_id}: blob SHA-256 {actual_hash} does not equal {expected_sha256}"
                )
            expected_size = entry.get("size_bytes")
            if expected_size != blob_path.stat().st_size:
                errors.append(
                    f"{evidence_id}: blob size {blob_path.stat().st_size} does not equal "
                    f"{expected_size}"
                )
            if blob_path.stem != expected_sha256:
                errors.append(
                    f"{evidence_id}: blob filename stem {blob_path.stem!r} is not the SHA-256"
                )
        elif status == "manifest-only-unverified":
            if content_path is not None:
                errors.append(f"{evidence_id}: manifest-only source must not have content_path")
            reason = entry.get("unverified_reason")
            if not isinstance(reason, str) or not reason.strip():
                errors.append(f"{evidence_id}: manifest-only source has no unverified_reason")
        elif status == "public-pinned-external":
            if content_path is not None:
                errors.append(f"{evidence_id}: public external source must not have content_path")
            note = entry.get("external_verification_note")
            if not isinstance(note, str) or not note.strip():
                errors.append(
                    f"{evidence_id}: public external source has no external_verification_note"
                )
        else:
            errors.append(f"{evidence_id}: unsupported retention_status={status!r}")

    return tuple(errors)


def verify_manifest(
    manifest_path: Path = DEFAULT_MANIFEST_PATH,
    content_root: Path | None = None,
) -> tuple[str, ...]:
    """Verify the checked-in manifest, source bindings, and retained blobs."""

    if not manifest_path.is_file():
        return (f"missing evidence manifest: {manifest_path}",)
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return (f"cannot read evidence manifest: {error}",)
    return verify_manifest_payload(payload, resolve_content_root(manifest_path, content_root))


def _safe_relative_content_path(value: object, evidence_id: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ReferenceSourceError(f"{evidence_id}: verified source has no content_path")
    relative_path = Path(value)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ReferenceSourceError(f"{evidence_id}: content_path escapes the evidence store")
    if len(relative_path.parts) == 0:
        raise ReferenceSourceError(f"{evidence_id}: content_path is empty")
    return relative_path


def _read_manifest_for_fetch(manifest_path: Path) -> list[dict[str, object]]:
    if not manifest_path.is_file():
        raise ReferenceSourceError(f"missing evidence manifest: {manifest_path}")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest = _dict(payload)
        raw_entries = _list(manifest["sources"])
        entries = [_dict(entry) for entry in raw_entries]
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise ReferenceSourceError(f"cannot read evidence manifest: {error}") from error

    expected_sources = {source.evidence_id: source for source in sources()}
    seen: set[str] = set()
    for entry in entries:
        evidence_id = entry.get("evidence_id")
        if not isinstance(evidence_id, str) or not evidence_id:
            raise ReferenceSourceError("manifest entry has no text evidence_id")
        if evidence_id in seen:
            raise ReferenceSourceError(f"manifest contains duplicate evidence ID {evidence_id!r}")
        seen.add(evidence_id)
        expected = expected_sources.get(evidence_id)
        if expected is None:
            raise ReferenceSourceError(f"manifest has unknown evidence ID {evidence_id!r}")
        for field, expected_value in (
            ("title", expected.title),
            ("uri", expected.uri),
            ("document_revision", expected.document_revision),
            ("expected_sha256", expected.sha256),
        ):
            if entry.get(field) != expected_value:
                raise ReferenceSourceError(
                    f"{evidence_id}: manifest {field} does not match SourceEvidence"
                )
    if seen != set(expected_sources):
        raise ReferenceSourceError("manifest IDs differ from SourceEvidence inventory")
    return entries


def _authorize_fetch_manifest(entries: list[dict[str, object]]) -> None:
    """Authorize a caller manifest against the immutable distribution source layout.

    A caller may narrow the cache by changing a normally verified entry to
    ``manifest-only-unverified`` and clearing its path.  It may not change identity, size, URL,
    digest, or a path, and the two manifest-only restricted/large records are hard-denied even if
    their JSON says ``verified``.  The public pinned external footprint also cannot be converted
    into a fetch target by editing the manifest.  This check is independent of filesystem bytes
    and network results.
    """

    for entry in entries:
        evidence_id = cast(str, entry["evidence_id"])
        immutable = _IMMUTABLE_SOURCE_LAYOUT.get(evidence_id)
        if immutable is None:
            raise ReferenceSourceError(
                f"{evidence_id}: source is not in the immutable fetch layout"
            )
        immutable_status, immutable_size, immutable_path, immutable_uri, immutable_hash = immutable
        status = entry.get("retention_status")
        content_path = entry.get("content_path")
        if evidence_id in HARD_DENIED_EVIDENCE_IDS:
            if (
                status != immutable_status
                or content_path != immutable_path
                or entry.get("size_bytes") != immutable_size
                or entry.get("uri") != immutable_uri
                or entry.get("expected_sha256") != immutable_hash
                or entry.get("retrieved_sha256") != immutable_hash
            ):
                raise ReferenceSourceError(
                    f"{evidence_id}: source is hard-denied and cannot be made fetchable"
                )
            continue
        if (
            entry.get("size_bytes") != immutable_size
            or entry.get("uri") != immutable_uri
            or entry.get("expected_sha256") != immutable_hash
            or entry.get("retrieved_sha256") != immutable_hash
        ):
            raise ReferenceSourceError(f"{evidence_id}: source tuple is not authorized")
        if status == immutable_status and content_path == immutable_path:
            continue
        # Narrowing is the only permitted caller-side change.  A verified entry can be omitted
        # from a private cache, but cannot be redirected to a different file.
        if (
            immutable_status == "verified"
            and status == "manifest-only-unverified"
            and content_path is None
            and isinstance(entry.get("unverified_reason"), str)
            and bool(cast(str, entry["unverified_reason"]).strip())
        ):
            continue
        raise ReferenceSourceError(f"{evidence_id}: source tuple is not authorized")


def _https_url(value: object, evidence_id: str) -> urllib.parse.SplitResult:
    if not isinstance(value, str):
        raise ReferenceSourceError(f"{evidence_id}: source URI is not text")
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError as error:
        raise ReferenceSourceError(f"{evidence_id}: source URI is malformed") from error
    if parsed.scheme.casefold() != "https":
        raise ReferenceSourceError(f"{evidence_id}: source URI must use HTTPS")
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ReferenceSourceError(f"{evidence_id}: source URI has an unsafe hostname")
    try:
        port = parsed.port
    except ValueError as error:
        raise ReferenceSourceError(f"{evidence_id}: source URI has an invalid port") from error
    if port not in (None, 443):
        raise ReferenceSourceError(f"{evidence_id}: source URI has an unsafe port")
    return parsed


class LimitedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, hostname: str, max_redirects: int) -> None:
        self._hostname = hostname.casefold()
        self._max_redirects = max_redirects
        self.count = 0

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        self.count += 1
        if self.count > self._max_redirects:
            raise ReferenceSourceError("source URL exceeded the redirect limit")
        parsed = _https_url(newurl, "redirect")
        if parsed.hostname is None or parsed.hostname.casefold() != self._hostname:
            raise ReferenceSourceError("source URL redirected to a different hostname")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _download_to(
    entry: dict[str, object],
    destination: BinaryIO,
    *,
    max_bytes: int,
    timeout_seconds: float,
    max_redirects: int,
) -> tuple[str, int]:
    evidence_id = entry["evidence_id"]
    if not isinstance(evidence_id, str):
        raise ReferenceSourceError("manifest entry has no text evidence_id")
    parsed = _https_url(entry.get("uri"), evidence_id)
    expected_hash = entry.get("expected_sha256")
    expected_size = entry.get("size_bytes")
    if (
        not isinstance(expected_hash, str)
        or len(expected_hash) != 64
        or expected_hash != expected_hash.lower()
        or any(character not in "0123456789abcdef" for character in expected_hash)
    ):
        raise ReferenceSourceError(f"{evidence_id}: expected_sha256 is malformed")
    if not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size <= 0:
        raise ReferenceSourceError(f"{evidence_id}: size_bytes is malformed")
    if expected_size > max_bytes:
        raise ReferenceSourceError(
            f"{evidence_id}: expected source size {expected_size} exceeds the {max_bytes}-byte cap"
        )
    handler = LimitedRedirectHandler(parsed.hostname or "", max_redirects)
    opener = urllib.request.build_opener(handler)
    request = urllib.request.Request(
        urllib.parse.urlunsplit(parsed),
        headers={"Accept-Encoding": "identity", "User-Agent": "evleda-source-fetch/1"},
        method="GET",
    )
    digest = hashlib.sha256()
    total = 0
    try:
        response = opener.open(request, timeout=timeout_seconds)
    except ReferenceSourceError:
        raise
    except (TimeoutError, OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise ReferenceSourceError(f"{evidence_id}: HTTPS retrieval failed: {error}") from error
    try:
        status = response.getcode()
        if status != 200:
            raise ReferenceSourceError(
                f"{evidence_id}: HTTPS response status is {status!r}, not 200"
            )
        content_length = response.headers.get("Content-Length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError as error:
                raise ReferenceSourceError(f"{evidence_id}: Content-Length is malformed") from error
            if declared_length != expected_size:
                raise ReferenceSourceError(
                    f"{evidence_id}: Content-Length {declared_length} does not equal "
                    f"{expected_size}"
                )
        while True:
            chunk = response.read(min(1024 * 1024, expected_size + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > expected_size or total > max_bytes:
                raise ReferenceSourceError(f"{evidence_id}: response exceeds the size cap")
            digest.update(chunk)
            destination.write(chunk)
    except ReferenceSourceError:
        raise
    except (TimeoutError, OSError) as error:
        raise ReferenceSourceError(f"{evidence_id}: HTTPS stream failed: {error}") from error
    finally:
        response.close()
    actual_hash = digest.hexdigest()
    if total != expected_size:
        raise ReferenceSourceError(
            f"{evidence_id}: retrieved length {total} does not equal manifest length "
            f"{expected_size}"
        )
    if actual_hash != expected_hash:
        raise ReferenceSourceError(
            f"{evidence_id}: retrieved SHA-256 {actual_hash} does not equal {expected_hash}"
        )
    return actual_hash, total


def _cache_target(root: Path, relative_path: Path, evidence_id: str) -> Path:
    if root.is_symlink():
        raise ReferenceSourceError("source cache root must not be a symlink")
    root.mkdir(parents=True, exist_ok=True)
    parent = root / relative_path.parent
    if parent.is_symlink():
        raise ReferenceSourceError(f"{evidence_id}: source cache directory must not be a symlink")
    parent.mkdir(parents=True, exist_ok=True)
    target = root / relative_path
    try:
        if not target.resolve(strict=False).is_relative_to(root.resolve()):
            raise ReferenceSourceError(f"{evidence_id}: content_path escapes the source cache")
    except OSError as error:
        raise ReferenceSourceError(
            f"{evidence_id}: cannot resolve source cache path: {error}"
        ) from error
    if target.is_symlink():
        raise ReferenceSourceError(f"{evidence_id}: source cache target must not be a symlink")
    return target


def fetch_verified_sources(
    output_root: Path,
    manifest_path: Path = DEFAULT_MANIFEST_PATH,
    *,
    max_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
) -> tuple[FetchResult, ...]:
    """Fetch only verified manifest entries into an exclusive, content-addressed cache.

    Manifest-only and public-pinned-external entries are intentionally ignored, even if a caller
    has modified their ``content_path``.  The function validates the complete source inventory
    before making any network request, and each selected destination is either an exact existing
    blob or created without replacing any existing filesystem entry.
    """

    if type(max_bytes) is not int:
        raise ReferenceSourceError("max_bytes must be an integer")
    if max_bytes <= 0 or max_bytes > HARD_MAX_DOWNLOAD_BYTES:
        raise ReferenceSourceError(
            f"max_bytes must be between 1 and {HARD_MAX_DOWNLOAD_BYTES} bytes"
        )
    if timeout_seconds <= 0:
        raise ReferenceSourceError("timeout_seconds must be positive")
    if type(max_redirects) is not int:
        raise ReferenceSourceError("max_redirects must be an integer")
    if max_redirects < 0 or max_redirects > 10:
        raise ReferenceSourceError("max_redirects must be between 0 and 10")

    try:
        if manifest_path.resolve() == DEFAULT_MANIFEST_PATH.resolve():
            manifest_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            if manifest_digest != IMMUTABLE_MANIFEST_SHA256:
                raise ReferenceSourceError(
                    "checked-in reference source manifest digest differs from the packaged "
                    "immutable manifest"
                )
    except OSError as error:
        raise ReferenceSourceError(f"cannot read evidence manifest: {error}") from error
    entries = _read_manifest_for_fetch(manifest_path)
    _authorize_fetch_manifest(entries)
    selected: list[tuple[dict[str, object], Path]] = []
    for entry in entries:
        # This exact predicate is the distribution boundary: do not resolve or retrieve any
        # manifest-only source, regardless of URL, size, or a caller-supplied path.
        if entry.get("retention_status") != "verified" or entry.get("content_path") is None:
            continue
        evidence_id = entry.get("evidence_id")
        if not isinstance(evidence_id, str):
            raise ReferenceSourceError("manifest entry has no text evidence_id")
        selected.append(
            (entry, _safe_relative_content_path(entry.get("content_path"), evidence_id))
        )

    results: list[FetchResult] = []
    for entry, relative_path in selected:
        evidence_id = cast(str, entry["evidence_id"])
        target = _cache_target(output_root, relative_path, evidence_id)
        expected_hash = cast(str, entry["expected_sha256"])
        expected_size = cast(int, entry["size_bytes"])
        if expected_size > max_bytes:
            raise ReferenceSourceError(
                f"{evidence_id}: expected source size {expected_size} exceeds the "
                f"{max_bytes}-byte cap"
            )
        if target.exists():
            if not target.is_file():
                raise ReferenceSourceError(f"{evidence_id}: source cache target is not a file")
            if target.stat().st_size != expected_size:
                raise ReferenceSourceError(f"{evidence_id}: existing source has the wrong length")
            actual_hash = hashlib.sha256(target.read_bytes()).hexdigest()
            if actual_hash != expected_hash:
                raise ReferenceSourceError(f"{evidence_id}: existing source has the wrong SHA-256")
            results.append(
                FetchResult(
                    evidence_id,
                    str(relative_path).replace("\\", "/"),
                    actual_hash,
                    expected_size,
                    "existing",
                )
            )
            continue

        temporary_path: Path | None = None
        try:
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{expected_hash}.", suffix=".partial", dir=target.parent
            )
            temporary_path = Path(temporary_name)
            with os.fdopen(fd, "wb") as temporary_file:
                actual_hash, actual_size = _download_to(
                    entry,
                    temporary_file,
                    max_bytes=max_bytes,
                    timeout_seconds=timeout_seconds,
                    max_redirects=max_redirects,
                )
            try:
                os.link(temporary_path, target)
            except FileExistsError as error:
                raise ReferenceSourceError(
                    f"{evidence_id}: source cache target appeared during exclusive write"
                ) from error
            results.append(
                FetchResult(
                    evidence_id,
                    str(relative_path).replace("\\", "/"),
                    actual_hash,
                    actual_size,
                    "downloaded",
                )
            )
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
    return tuple(results)


def fetch_main(argv: list[str] | None = None) -> int:
    """CLI entry point used by the installed ``evleda-fetch-reference-sources`` command."""

    import argparse

    parser = argparse.ArgumentParser(
        prog=FETCH_REFERENCE_SOURCES_COMMAND,
        description="Fetch only permitted verified source entries into a private evidence cache.",
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_DOWNLOAD_BYTES)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--max-redirects", type=int, default=DEFAULT_MAX_REDIRECTS)
    parser.add_argument("--json", action="store_true", help="print a machine-readable result")
    args = parser.parse_args(argv)
    try:
        results = fetch_verified_sources(
            args.output_dir,
            args.manifest,
            max_bytes=args.max_bytes,
            timeout_seconds=args.timeout,
            max_redirects=args.max_redirects,
        )
    except ReferenceSourceError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps([asdict(result) for result in results], sort_keys=True))
    else:
        print(f"fetched {sum(result.action == 'downloaded' for result in results)} source blobs")
        print(
            f"verified {sum(result.action == 'existing' for result in results)} "
            "existing source blobs"
        )
        print("manifest-only and public-pinned-external sources were not fetched")
    return 0


if __name__ == "__main__":
    failures = verify_manifest()
    if failures:
        for failure in failures:
            print(failure)
        raise SystemExit(1)
    print("reference source manifest verified")

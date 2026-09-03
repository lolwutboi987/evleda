"""Fail-closed loader for the generated reference project bundled in the wheel.

The package contains generated KiCad project bytes, not vendor source documents.
Nothing is extracted to the filesystem here: ZIP members are validated and read
in memory before they are admitted to ``ManagedKiCadBundle``.
"""

from __future__ import annotations

import hashlib
import json
import re
import stat
import struct
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from importlib import resources
from io import BytesIO
from typing import NoReturn, cast

from backend.kicad_project import ProjectAuxiliaryFile
from backend.kicad_worker import ManagedKiCadBundle

_RESOURCE_PACKAGE = "evleda.reference"
_MANIFEST_FILENAME = "manifest.json"
_ARCHIVE_FILENAME = "reference_usb_c_3v3_r2.zip"

# This is a trust anchor, not metadata loaded from the mutable resource. Release
# tooling must update it deliberately whenever the canonical manifest changes.
PACKAGED_REFERENCE_MANIFEST_SHA256 = (
    "49cdc0cd216359888d1248bf1125e17edda4fade2a6455d6263ada29e3bcc934"
)

_SHA256 = re.compile(r"[0-9a-f]{64}")
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_REVISION = re.compile(r"rev_[0-9a-f]{64}")
_STEM = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_FOOTPRINT = re.compile(
    r"FluxGenerated[.]pretty/fp_[0-9a-f]{32}[.]kicad_mod"
)
_MAX_MANIFEST_BYTES = 64 * 1024
_MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
_MAX_FILE_COUNT = 64
_MAX_MEMBER_BYTES = 2 * 1024 * 1024
_MAX_TOTAL_BYTES = 8 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 200
_LOCAL_FILE_HEADER = struct.Struct("<4s5H3L2H")
_CENTRAL_DIRECTORY_HEADER = struct.Struct("<4s6H3L5H2L")
_END_OF_CENTRAL_DIRECTORY = struct.Struct("<4s4H2LH")
_LOCAL_FILE_SIGNATURE = b"PK\x03\x04"
_CENTRAL_DIRECTORY_SIGNATURE = b"PK\x01\x02"
_END_OF_CENTRAL_DIRECTORY_SIGNATURE = b"PK\x05\x06"

_TOP_LEVEL_KEYS = frozenset({"archive", "files", "reference", "schema_version"})
_ARCHIVE_KEYS = frozenset({"filename", "sha256", "size_bytes"})
_REFERENCE_KEYS = frozenset(
    {
        "authority",
        "component_count",
        "graph_sha256",
        "managed_bundle_sha256",
        "manufacturing_release",
        "net_count",
        "operation_count",
        "private_source_blobs_included",
        "project_id",
        "project_revision",
        "project_stem",
        "source_rebuild",
    }
)
_FILE_KEYS = frozenset({"media_type", "path", "role", "sha256", "size_bytes"})
_PRIMARY_ROLES = frozenset({"board", "project", "schematic"})
_NOTICE_PATH = "NOT_FOR_FABRICATION.txt"
_NOTICE_PAYLOAD = b"""EVLEDA PACKAGED REFERENCE - NOT FOR FABRICATION

This generated USB-C to 3.3 V board is shipped only for immutable inspection
and optional native KiCad ERC/DRC verification. It is not a manufacturing
release. Human design review, manufacturing capability review, assembler
approval, and release approval are not recorded. Do not send this package to a
fabricator or assembler.
"""
_ROLE_MEDIA_TYPES = {
    "board": "application/x-kicad-pcb",
    "project": "application/json",
    "schematic": "application/x-kicad-schematic",
}
_AUXILIARY_MEDIA_TYPES = {
    "FluxGenerated.kicad_sym": "application/x-kicad-symbol-library",
    "fp-lib-table": "application/x-kicad-library-table",
    "sym-lib-table": "application/x-kicad-library-table",
}


class PackagedReferenceError(RuntimeError):
    """A packaged reference resource failed its closed integrity contract."""


@dataclass(frozen=True, slots=True)
class PackagedReference:
    """One authenticated, non-release reference bundle and inspection summary."""

    bundle: ManagedKiCadBundle
    component_count: int
    net_count: int
    operation_count: int
    graph_sha256: str
    manifest_sha256: str
    archive_sha256: str
    source_mode: str = "packaged-generated-reference"
    manufacturing_release: bool = False

    def __post_init__(self) -> None:
        if type(self) is not PackagedReference:
            raise TypeError("packaged reference must use the exact PackagedReference type")
        if type(self.bundle) is not ManagedKiCadBundle:
            raise TypeError("packaged reference must bind an exact managed bundle")
        for value, label in (
            (self.component_count, "component count"),
            (self.net_count, "net count"),
            (self.operation_count, "operation count"),
        ):
            if type(value) is not int or value < 0:
                raise PackagedReferenceError(f"{label} must be a non-negative exact integer")
        for value, label in (
            (self.graph_sha256, "graph digest"),
            (self.manifest_sha256, "manifest digest"),
            (self.archive_sha256, "archive digest"),
        ):
            if type(value) is not str or _SHA256.fullmatch(value) is None:
                raise PackagedReferenceError(f"{label} must be a lowercase SHA-256")
        if self.source_mode != "packaged-generated-reference":
            raise PackagedReferenceError("packaged reference source mode changed")
        if self.manufacturing_release is not False:
            raise PackagedReferenceError("packaged reference cannot grant manufacturing release")


def _fail(message: str) -> NoReturn:
    raise PackagedReferenceError(message)


def _object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail(f"packaged reference manifest repeats JSON key {key!r}")
        result[key] = value
    return result


def _reject_number(_value: str) -> NoReturn:
    _fail("packaged reference manifest forbids floating-point and non-finite numbers")


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("ascii")


def _decode_manifest(payload: bytes, expected_sha256: str) -> dict[str, object]:
    if type(payload) is not bytes or not 1 <= len(payload) <= _MAX_MANIFEST_BYTES:
        _fail("packaged reference manifest violates its byte limit")
    if type(expected_sha256) is not str or _SHA256.fullmatch(expected_sha256) is None:
        _fail("trusted packaged reference manifest digest is invalid")
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        _fail("packaged reference manifest does not match the code-pinned SHA-256")
    try:
        text = payload.decode("ascii", errors="strict")
        decoded = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_float=_reject_number,
            parse_constant=_reject_number,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackagedReferenceError("packaged reference manifest is not canonical JSON") from exc
    if type(decoded) is not dict:
        _fail("packaged reference manifest must be an exact JSON object")
    manifest = cast(dict[str, object], decoded)
    if payload != _canonical_json(manifest):
        _fail("packaged reference manifest is not in canonical JSON encoding")
    return manifest


def _exact_object(value: object, keys: frozenset[str], label: str) -> dict[str, object]:
    if type(value) is not dict:
        _fail(f"{label} must be an exact object")
    result = cast(dict[str, object], value)
    if frozenset(result) != keys or any(type(key) is not str for key in result):
        _fail(f"{label} fields do not match the closed schema")
    return result


def _exact_text(value: object, label: str, pattern: re.Pattern[str] | None = None) -> str:
    if type(value) is not str or not value or any(ord(character) < 32 for character in value):
        _fail(f"{label} must be non-empty control-free text")
    if pattern is not None and pattern.fullmatch(value) is None:
        _fail(f"{label} has invalid syntax")
    return value


def _exact_integer(value: object, label: str, *, maximum: int) -> int:
    if type(value) is not int or not 0 <= value <= maximum:
        _fail(f"{label} must be a bounded non-negative exact integer")
    return value


def _sha256(value: object, label: str) -> str:
    return _exact_text(value, label, _SHA256)


def _portable_member_name(value: object) -> str:
    name = _exact_text(value, "archive member path")
    if (
        "\\" in name
        or name.startswith("/")
        or name.startswith("//")
        or name.endswith("/")
        or ":" in name
        or len(name.encode("utf-8")) > 240
    ):
        _fail("archive member path is not a portable relative path")
    parts = name.split("/")
    if len(parts) > 8 or any(
        part in {"", ".", ".."}
        or part != part.strip()
        or part.endswith((".", " "))
        for part in parts
    ):
        _fail("archive member path contains an empty, dot, or unsafe segment")
    first = parts[0]
    if re.match(r"^[A-Za-z]:", first) is not None:
        _fail("archive member path contains a Windows drive")
    return name


def _expected_media_type(path: str, role: str) -> str:
    if role in _PRIMARY_ROLES:
        return _ROLE_MEDIA_TYPES[role]
    if role != "auxiliary":
        if role == "notice" and path == _NOTICE_PATH:
            return "text/plain"
        _fail("packaged reference file role is not permitted")
    if path in _AUXILIARY_MEDIA_TYPES:
        return _AUXILIARY_MEDIA_TYPES[path]
    if _FOOTPRINT.fullmatch(path) is not None:
        return "application/x-kicad-footprint"
    _fail("packaged reference contains a non-hermetic or vendor-source auxiliary file")


def _validate_manifest(
    manifest: dict[str, object],
) -> tuple[dict[str, object], dict[str, object], tuple[dict[str, object], ...]]:
    top = _exact_object(manifest, _TOP_LEVEL_KEYS, "packaged reference manifest")
    if top["schema_version"] != 1 or type(top["schema_version"]) is not int:
        _fail("packaged reference schema version is not supported")
    archive = _exact_object(top["archive"], _ARCHIVE_KEYS, "archive record")
    if archive["filename"] != _ARCHIVE_FILENAME:
        _fail("packaged reference archive filename changed")
    _sha256(archive["sha256"], "archive digest")
    _exact_integer(archive["size_bytes"], "archive size", maximum=_MAX_ARCHIVE_BYTES)

    reference = _exact_object(top["reference"], _REFERENCE_KEYS, "reference record")
    _exact_text(reference["project_id"], "project ID", _IDENTIFIER)
    _exact_text(reference["project_revision"], "project revision", _REVISION)
    stem = _exact_text(reference["project_stem"], "project stem", _STEM)
    _sha256(reference["graph_sha256"], "graph digest")
    _sha256(reference["managed_bundle_sha256"], "managed bundle digest")
    for field in ("component_count", "net_count", "operation_count"):
        _exact_integer(reference[field], field.replace("_", " "), maximum=1_000_000)
    if reference["manufacturing_release"] is not False:
        _fail("packaged reference must remain explicitly non-release")
    if reference["private_source_blobs_included"] is not False:
        _fail("packaged reference cannot contain private source blobs")
    if reference["authority"] != "immutable-inspection-and-native-verification-only":
        _fail("packaged reference authority changed")
    if reference["source_rebuild"] != "explicit-private-evidence-opt-in-only":
        _fail("packaged reference source-rebuild policy changed")

    raw_files = top["files"]
    if type(raw_files) is not list:
        _fail("packaged reference file manifest must be an exact array")
    raw_file_list = cast(list[object], raw_files)
    if not 1 <= len(raw_file_list) <= _MAX_FILE_COUNT:
        _fail("packaged reference file manifest violates its count limit")
    files: list[dict[str, object]] = []
    names: set[str] = set()
    folded: set[str] = set()
    role_counts = {role: 0 for role in _PRIMARY_ROLES}
    notice_count = 0
    for raw in raw_file_list:
        record = _exact_object(raw, _FILE_KEYS, "packaged reference file record")
        path = _portable_member_name(record["path"])
        lowered = path.casefold()
        if path in names or lowered in folded:
            _fail("packaged reference file paths collide exactly or case-insensitively")
        names.add(path)
        folded.add(lowered)
        role = _exact_text(record["role"], "packaged reference file role")
        expected_media_type = _expected_media_type(path, role)
        if record["media_type"] != expected_media_type:
            _fail("packaged reference file media type contradicts its role and path")
        _sha256(record["sha256"], "packaged reference file digest")
        _exact_integer(
            record["size_bytes"],
            "packaged reference file size",
            maximum=_MAX_MEMBER_BYTES,
        )
        if role in role_counts:
            role_counts[role] += 1
            suffix = {
                "board": ".kicad_pcb",
                "project": ".kicad_pro",
                "schematic": ".kicad_sch",
            }[role]
            if path != f"{stem}{suffix}":
                _fail("primary packaged reference path contradicts its project stem")
        elif role == "notice":
            notice_count += 1
        files.append(record)
    if any(count != 1 for count in role_counts.values()):
        _fail("packaged reference must contain exactly one primary project file of each role")
    if notice_count != 1:
        _fail("packaged reference must contain exactly one non-fabrication notice")
    sorted_files = sorted(
        files,
        key=lambda item: (
            cast(str, item["path"]).casefold(),
            cast(str, item["path"]),
        ),
    )
    if files != sorted_files:
        _fail("packaged reference file records must use portable deterministic order")
    total = sum(cast(int, item["size_bytes"]) for item in files)
    if total > _MAX_TOTAL_BYTES:
        _fail("packaged reference file manifest exceeds its aggregate byte limit")
    return archive, reference, tuple(files)


def _validate_zip_member(info: zipfile.ZipInfo) -> str:
    # ``zipfile`` normalizes the platform separator in ``filename`` on Windows;
    # ``orig_filename`` retains the central-directory spelling we must audit.
    original_name = info.orig_filename
    name = _portable_member_name(original_name)
    if info.filename != original_name:
        _fail("packaged reference ZIP member used a platform-normalized path")
    if info.is_dir() or info.flag_bits & 0x1:
        _fail("packaged reference ZIP contains a directory or encrypted member")
    if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
        _fail("packaged reference ZIP uses an unsupported compression method")
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    kind = stat.S_IFMT(unix_mode)
    if kind not in {0, stat.S_IFREG}:
        _fail("packaged reference ZIP contains a symlink or special member")
    if info.file_size < 1 or info.file_size > _MAX_MEMBER_BYTES:
        _fail("packaged reference ZIP member violates its byte limit")
    if info.compress_size < 1:
        _fail("packaged reference ZIP member has an invalid compressed size")
    if info.file_size > info.compress_size * _MAX_COMPRESSION_RATIO:
        _fail("packaged reference ZIP member exceeds the compression-ratio limit")
    return name


def _decode_raw_zip_name(raw_name: bytes, flags: int) -> str:
    try:
        name = raw_name.decode("utf-8" if flags & 0x800 else "cp437", errors="strict")
    except UnicodeDecodeError as exc:
        raise PackagedReferenceError(
            "packaged reference ZIP member name is not decodable"
        ) from exc
    return _portable_member_name(name)


def _preflight_zip_metadata(payload: bytes) -> tuple[str, ...]:
    """Bound and audit raw ZIP metadata before ``ZipFile`` allocates its index."""

    eocd_offset = payload.rfind(_END_OF_CENTRAL_DIRECTORY_SIGNATURE)
    if eocd_offset < 0 or eocd_offset + _END_OF_CENTRAL_DIRECTORY.size != len(payload):
        _fail("packaged reference ZIP has no exact comment-free end record")
    try:
        (
            signature,
            disk_number,
            central_disk,
            disk_entries,
            total_entries,
            central_size,
            central_offset,
            comment_size,
        ) = _END_OF_CENTRAL_DIRECTORY.unpack_from(payload, eocd_offset)
    except struct.error as exc:
        raise PackagedReferenceError("packaged reference ZIP end record is truncated") from exc
    if (
        signature != _END_OF_CENTRAL_DIRECTORY_SIGNATURE
        or disk_number != 0
        or central_disk != 0
        or disk_entries != total_entries
        or comment_size != 0
        or total_entries in {0, 0xFFFF}
        or total_entries > _MAX_FILE_COUNT
        or central_size == 0xFFFFFFFF
        or central_offset == 0xFFFFFFFF
        or central_offset + central_size != eocd_offset
    ):
        _fail("packaged reference ZIP central-directory bounds are invalid")

    cursor = central_offset
    total_size = 0
    names: list[str] = []
    folded: set[str] = set()
    local_ranges: list[tuple[int, int]] = []
    local_offsets: set[int] = set()
    for _index in range(total_entries):
        if cursor + _CENTRAL_DIRECTORY_HEADER.size > eocd_offset:
            _fail("packaged reference ZIP central-directory entry is truncated")
        try:
            values = _CENTRAL_DIRECTORY_HEADER.unpack_from(payload, cursor)
        except struct.error as exc:
            raise PackagedReferenceError(
                "packaged reference ZIP central-directory entry is truncated"
            ) from exc
        if values[0] != _CENTRAL_DIRECTORY_SIGNATURE:
            _fail("packaged reference ZIP central-directory signature is invalid")
        (
            _signature,
            version_made,
            _version_needed,
            flags,
            compression,
            _modified_time,
            _modified_date,
            crc32,
            compressed_size,
            file_size,
            name_size,
            extra_size,
            member_comment_size,
            start_disk,
            _internal_attributes,
            external_attributes,
            local_offset,
        ) = values
        variable_end = (
            cursor
            + _CENTRAL_DIRECTORY_HEADER.size
            + name_size
            + extra_size
            + member_comment_size
        )
        create_system = version_made >> 8
        unix_kind = stat.S_IFMT((external_attributes >> 16) & 0xFFFF)
        if flags & 0x1:
            _fail("packaged reference ZIP contains an encrypted member")
        if flags & 0x8:
            _fail("packaged reference ZIP data descriptors are not permitted")
        if create_system == 3 and unix_kind not in {0, stat.S_IFREG}:
            _fail("packaged reference ZIP contains a symlink or special member")
        if compressed_size > 0 and file_size > compressed_size * _MAX_COMPRESSION_RATIO:
            _fail("packaged reference ZIP member exceeds the compression-ratio limit")
        if (
            name_size < 1
            or name_size > 240
            or extra_size != 0
            or member_comment_size != 0
            or start_disk != 0
            or variable_end > eocd_offset
            or compression not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
            or file_size < 1
            or file_size > _MAX_MEMBER_BYTES
            or compressed_size < 1
            or local_offset in local_offsets
            or local_offset + _LOCAL_FILE_HEADER.size > central_offset
            or create_system not in {0, 3}
            or (create_system == 0 and bool(external_attributes & 0x10))
        ):
            _fail("packaged reference ZIP member metadata violates the bounded profile")
        raw_name_start = cursor + _CENTRAL_DIRECTORY_HEADER.size
        raw_name = payload[raw_name_start : raw_name_start + name_size]
        name = _decode_raw_zip_name(raw_name, flags)
        if name.casefold() in folded:
            _fail("packaged reference ZIP members collide exactly or case-insensitively")
        folded.add(name.casefold())
        names.append(name)
        local_offsets.add(local_offset)

        try:
            local = _LOCAL_FILE_HEADER.unpack_from(payload, local_offset)
        except struct.error as exc:
            raise PackagedReferenceError(
                "packaged reference ZIP local entry is truncated"
            ) from exc
        local_name_size = local[9]
        local_extra_size = local[10]
        local_name_start = local_offset + _LOCAL_FILE_HEADER.size
        data_start = local_name_start + local_name_size + local_extra_size
        data_end = data_start + compressed_size
        if (
            local[0] != _LOCAL_FILE_SIGNATURE
            or local[2] != flags
            or local[3] != compression
            or local[6] != crc32
            or local[7] != compressed_size
            or local[8] != file_size
            or local_name_size != name_size
            or local_extra_size != 0
            or payload[local_name_start : local_name_start + local_name_size] != raw_name
            or data_end > central_offset
        ):
            _fail("packaged reference ZIP local and central metadata disagree")
        local_ranges.append((local_offset, data_end))
        total_size += file_size
        if total_size > _MAX_TOTAL_BYTES:
            _fail("packaged reference ZIP exceeds its aggregate byte limit")
        cursor = variable_end
    if cursor != eocd_offset:
        _fail("packaged reference ZIP central-directory length is inconsistent")
    expected_start = 0
    for start, end in sorted(local_ranges):
        if start != expected_start or end <= start:
            _fail("packaged reference ZIP local entries overlap or contain hidden gaps")
        expected_start = end
    if expected_start != central_offset:
        _fail("packaged reference ZIP has unindexed local payload bytes")
    return tuple(names)


def _read_archive(
    payload: bytes,
    archive: dict[str, object],
    files: tuple[dict[str, object], ...],
) -> dict[str, bytes]:
    if type(payload) is not bytes or not 1 <= len(payload) <= _MAX_ARCHIVE_BYTES:
        _fail("packaged reference archive violates its byte limit")
    if len(payload) != archive["size_bytes"]:
        _fail("packaged reference archive size does not match its manifest")
    archive_sha256 = hashlib.sha256(payload).hexdigest()
    if archive_sha256 != archive["sha256"]:
        _fail("packaged reference archive does not match its manifest SHA-256")
    expected = {cast(str, item["path"]): item for item in files}
    result: dict[str, bytes] = {}
    folded: set[str] = set()
    raw_names = _preflight_zip_metadata(payload)
    try:
        with zipfile.ZipFile(BytesIO(payload), "r") as bundle:
            if bundle.comment:
                _fail("packaged reference ZIP comments are not permitted")
            infos = bundle.infolist()
            if tuple(info.orig_filename for info in infos) != raw_names:
                _fail("packaged reference ZIP parser inventory differs from raw metadata")
            if not 1 <= len(infos) <= _MAX_FILE_COUNT:
                _fail("packaged reference ZIP violates its member-count limit")
            total = 0
            for info in infos:
                name = _validate_zip_member(info)
                lowered = name.casefold()
                if name in result or lowered in folded:
                    _fail("packaged reference ZIP members collide exactly or case-insensitively")
                folded.add(lowered)
                record = expected.get(name)
                if record is None:
                    _fail("packaged reference ZIP contains an unmanifested member")
                if info.file_size != record["size_bytes"]:
                    _fail("packaged reference ZIP member size contradicts its manifest")
                total += info.file_size
                if total > _MAX_TOTAL_BYTES:
                    _fail("packaged reference ZIP exceeds its aggregate byte limit")
                body = bundle.read(info)
                if len(body) != info.file_size:
                    _fail("packaged reference ZIP member was truncated")
                if hashlib.sha256(body).hexdigest() != record["sha256"]:
                    _fail("packaged reference ZIP member does not match its SHA-256")
                result[name] = body
            if bundle.testzip() is not None:
                _fail("packaged reference ZIP failed its CRC check")
    except PackagedReferenceError:
        raise
    except (OSError, RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
        raise PackagedReferenceError("packaged reference ZIP is malformed or failed CRC") from exc
    if frozenset(result) != frozenset(expected):
        _fail("packaged reference ZIP file set does not match its manifest")
    return result


def validate_packaged_reference_payloads(
    manifest_payload: bytes,
    archive_payload: bytes,
    *,
    expected_manifest_sha256: str,
) -> PackagedReference:
    """Validate exact trusted payloads without extracting them.

    ``expected_manifest_sha256`` is trust material supplied by release tooling;
    normal consumers must call :func:`load_packaged_reference`, which always uses
    the code-pinned digest.
    """

    manifest = _decode_manifest(manifest_payload, expected_manifest_sha256)
    archive, reference, files = _validate_manifest(manifest)
    payloads = _read_archive(archive_payload, archive, files)
    if payloads.get(_NOTICE_PATH) != _NOTICE_PAYLOAD:
        _fail("packaged reference non-fabrication notice changed")
    roles = {cast(str, item["role"]): cast(str, item["path"]) for item in files}
    auxiliary = tuple(
        ProjectAuxiliaryFile(
            cast(str, item["path"]),
            cast(str, item["media_type"]),
            payloads[cast(str, item["path"])],
        )
        for item in files
        if item["role"] == "auxiliary"
    )
    try:
        bundle = ManagedKiCadBundle.create(
            project_id=cast(str, reference["project_id"]),
            project_revision=cast(str, reference["project_revision"]),
            stem=cast(str, reference["project_stem"]),
            project_payload=payloads[roles["project"]],
            schematic_payload=payloads[roles["schematic"]],
            board_payload=payloads[roles["board"]],
            auxiliary_files=auxiliary,
        )
    except (TypeError, ValueError) as exc:
        raise PackagedReferenceError(
            "packaged reference files do not form an exact managed KiCad bundle"
        ) from exc
    if bundle.bundle_sha256 != reference["managed_bundle_sha256"]:
        _fail("packaged reference managed-bundle identity does not match its manifest")
    return PackagedReference(
        bundle=bundle,
        component_count=cast(int, reference["component_count"]),
        net_count=cast(int, reference["net_count"]),
        operation_count=cast(int, reference["operation_count"]),
        graph_sha256=cast(str, reference["graph_sha256"]),
        manifest_sha256=expected_manifest_sha256,
        archive_sha256=cast(str, archive["sha256"]),
    )


def _read_resource(filename: str) -> bytes:
    try:
        resource = resources.files(_RESOURCE_PACKAGE).joinpath(filename)
        return resource.read_bytes()
    except (FileNotFoundError, ModuleNotFoundError, OSError) as exc:
        raise PackagedReferenceError(
            f"installed packaged reference resource {filename!r} is unavailable"
        ) from exc


def load_packaged_reference(
    *,
    resource_reader: Callable[[str], bytes] | None = None,
) -> PackagedReference:
    """Load the code-pinned generated reference shipped with the distribution."""

    read = _read_resource if resource_reader is None else resource_reader
    if not callable(read):
        raise TypeError("resource_reader must be callable")
    manifest_payload = read(_MANIFEST_FILENAME)
    # Decode and validate the filename before asking a resource provider for it.
    manifest = _decode_manifest(
        manifest_payload,
        PACKAGED_REFERENCE_MANIFEST_SHA256,
    )
    archive, _reference, _files = _validate_manifest(manifest)
    archive_filename = cast(str, archive["filename"])
    archive_payload = read(archive_filename)
    return validate_packaged_reference_payloads(
        manifest_payload,
        archive_payload,
        expected_manifest_sha256=PACKAGED_REFERENCE_MANIFEST_SHA256,
    )


__all__ = (
    "PACKAGED_REFERENCE_MANIFEST_SHA256",
    "PackagedReference",
    "PackagedReferenceError",
    "load_packaged_reference",
    "validate_packaged_reference_payloads",
)

"""Fail-closed verification for the public wheel and source distribution.

The verifier deliberately never extracts an archive.  It validates archive
metadata before opening any member, then streams every regular member through
EOF so size, expansion, and CRC failures cannot hide behind a plausible member
list.  Selected nested ZIPs are retained only as bounded in-memory byte strings
and are passed to their existing closed contract validators.
"""

from __future__ import annotations

import argparse
import binascii
import gzip
import hashlib
import importlib
import importlib.util
import json
import re
import stat
import struct
import sys
import tarfile
import tomllib
import unicodedata
import zipfile
import zlib
from collections.abc import Mapping
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath, PureWindowsPath
from types import ModuleType
from typing import BinaryIO, NoReturn, cast

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_DISTRIBUTION = "evleda"

# Direct execution makes ``scripts/`` rather than the repository root the first
# import location.  The packaged-reference validator is trusted source code in
# this checkout, so make that checkout importable explicitly and deterministically.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_MEMBERS = 4_096
MAX_NAME_BYTES = 240
MAX_SEGMENT_BYTES = 120
MAX_PATH_DEPTH = 32
MAX_MEMBER_SIZE = 32 * 1024 * 1024
MAX_TOTAL_SIZE = 256 * 1024 * 1024
MAX_TAR_STREAM_SIZE = MAX_TOTAL_SIZE + MAX_MEMBERS * 4_096
MAX_COMPRESSION_RATIO = 100
MAX_ZIP_CENTRAL_DIRECTORY_SIZE = 16 * 1024 * 1024
READ_CHUNK_SIZE = 1024 * 1024

_ZIP_EOCD = struct.Struct("<4s4H2LH")
_ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP_LOCAL_SIGNATURE = b"PK\x03\x04"
_ZIP_ALLOWED_COMPRESSION = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})
_ZIP_ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000
_ZIP_UNICODE_PATH_EXTRA = 0x7075
_ZIP64_EXTRA = 0x0001
_WINDOWS_RESERVED = re.compile(
    r"(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)"
)
_SEMVER = re.compile(r"(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)")

_FORBIDDEN_COMPONENTS = frozenset(
    {
        ".git",
        ".evleda",
        ".flux-clone",
        "evidence-private",
        "node_modules",
        "outputs",
        "private-evidence",
        "release-assets",
        "runtime-evidence",
        "tmp",
        "work",
        "worker-state",
    }
)
_FORBIDDEN_SUFFIXES = (
    ".db",
    ".key",
    ".kicad_prl",
    ".pem",
    ".pyc",
    ".pyo",
    ".sqlite",
    ".sqlite3",
)
_FORBIDDEN_PREFIXES = ("docs/evidence/reference_sources/blobs",)

# The public product is a local stdio MCP and skill for installed KiCad. These
# paths belong to a superseded local browser/HTTP prototype and must never
# appear in either distribution, even if packaging configuration regresses.
_FORBIDDEN_PRODUCT_PREFIXES = ("backend/api/", "frontend/", "prototypes/", "tests/api/")
_FORBIDDEN_PRODUCT_FILES = frozenset(
    {
        "package.json",
        "pnpm-lock.yaml",
        "docs/CONFIGURATION.md",
        "docs/EVLEDA_COMPARISON_RESEARCH.md",
        "docs/EXACT_PREVIEW_CONTRACT.md",
        "docs/FEATURE_PARITY.md",
        "docs/IMPORT_EXPORT_CONTRACT.md",
        "docs/IMPORT_STAGE_INTEGRATION_PLAN.md",
        "docs/PARITY_ROADMAP.md",
    }
)

_LEGAL_FILES = (
    "CC-BY-SA-4.0.txt",
    "CERN-OHL-P-2.0.txt",
    "KiCad-Libraries-LICENSE.md",
    "NOTICE.txt",
    "THIRD_PARTY_NOTICES.md",
)
_SYMBOL_FILES = (
    "c.kicad_sym",
    "c_polarized.kicad_sym",
    "conn_01x02.kicad_sym",
    "d_tvs.kicad_sym",
    "led.kicad_sym",
    "r.kicad_sym",
    "testpoint.kicad_sym",
    "tps2596xx.kicad_sym",
    "usb_c_receptacle_usb2_16p.kicad_sym",
)
_CLOUD_FILES = (
    "AGENTS.md",
    "docs/CLOUD_RUNBOOK.md",
    "scripts/cloud/maintenance.sh",
    "scripts/cloud/plan.sh",
    "scripts/cloud/reference_workflow.py",
    "scripts/cloud/run.sh",
    "scripts/cloud/setup.sh",
)


@dataclass(frozen=True, slots=True)
class ArchiveMember:
    """Authenticated metadata for one outer archive member."""

    name: str
    is_file: bool
    size: int
    sha256: str | None


@dataclass(frozen=True, slots=True)
class ArchiveInventory:
    """Validated members and explicitly requested bounded payloads."""

    members: dict[str, ArchiveMember]
    payloads: dict[str, bytes]


class _NamedBytesIO(BytesIO):
    """BytesIO carrying the filename expected by the release validators."""

    def __init__(self, payload: bytes, name: str) -> None:
        super().__init__(payload)
        self.name = name


def _reject_superseded_product_surface(
    inventory: ArchiveInventory, label: str
) -> None:
    for name in inventory.members:
        if name in _FORBIDDEN_PRODUCT_FILES or name.startswith(
            _FORBIDDEN_PRODUCT_PREFIXES
        ):
            fail(f"{label} contains superseded browser/HTTP product surface: {name}")


def fail(message: str) -> NoReturn:
    raise SystemExit(f"public distribution verification failed: {message}")


def _regular_file_size(path: Path, label: str) -> int:
    try:
        metadata = path.lstat()
    except OSError as exc:
        fail(f"cannot inspect {label}: {type(exc).__name__}")
    if not stat.S_ISREG(metadata.st_mode):
        fail(f"{label} must be an exact regular file")
    if not 1 <= metadata.st_size <= MAX_ARCHIVE_BYTES:
        fail(f"{label} violates the archive byte limit")
    return metadata.st_size


def _sha256_file(path: Path) -> tuple[int, str]:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            fail(f"trusted contract source {path} is not a regular file")
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as source:
            while block := source.read(READ_CHUNK_SIZE):
                size += len(block)
                digest.update(block)
    except OSError as exc:
        fail(f"cannot read trusted contract source {path}: {type(exc).__name__}")
    return size, digest.hexdigest()


def _canonical_member_name(name: str, *, is_directory: bool, label: str) -> str:
    if type(name) is not str or not name:
        fail(f"{label} contains an empty archive path")
    if "\x00" in name or any(unicodedata.category(char).startswith("C") for char in name):
        fail(f"{label} contains a control character in an archive path")
    if "\\" in name or "//" in name:
        fail(f"{label} contains a backslash or empty archive-path segment")
    if name.endswith("/"):
        if not is_directory:
            fail(f"{label} contains a file path with a directory suffix")
        name = name[:-1]
    if not name:
        fail(f"{label} contains an empty archive path")
    posix = PurePosixPath(name)
    windows = PureWindowsPath(name)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or name.startswith(("/", "\\"))
        or ":" in name
    ):
        fail(f"{label} contains an absolute, drive, or UNC archive path")
    parts = name.split("/")
    if len(parts) > MAX_PATH_DEPTH:
        fail(f"{label} contains an archive path deeper than the portability limit")
    if len(name.encode("utf-8")) > MAX_NAME_BYTES:
        fail(f"{label} contains an overlong archive path")
    for part in parts:
        if (
            part in {"", ".", ".."}
            or part != part.strip()
            or part.endswith((".", " "))
            or len(part.encode("utf-8")) > MAX_SEGMENT_BYTES
            or _WINDOWS_RESERVED.match(part) is not None
        ):
            fail(f"{label} contains a dot, reserved, or nonportable path segment")
    return "/".join(parts)


def _collision_key(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold()


def _reject_forbidden_path(name: str, label: str) -> None:
    folded = _collision_key(name)
    parts = frozenset(folded.split("/"))
    if parts & _FORBIDDEN_COMPONENTS or folded.endswith(_FORBIDDEN_SUFFIXES):
        fail(f"{label} contains excluded private or generated state: {name}")
    if any(folded == prefix or folded.startswith(f"{prefix}/") for prefix in _FORBIDDEN_PREFIXES):
        fail(f"{label} contains excluded private source evidence: {name}")


def _parse_zip_extra(extra: bytes, label: str, name: str) -> None:
    cursor = 0
    while cursor < len(extra):
        if cursor + 4 > len(extra):
            fail(f"{label} has malformed ZIP extra metadata on {name}")
        field_id, field_size = struct.unpack_from("<HH", extra, cursor)
        cursor += 4
        if cursor + field_size > len(extra):
            fail(f"{label} has malformed ZIP extra metadata on {name}")
        if field_id in {_ZIP64_EXTRA, _ZIP_UNICODE_PATH_EXTRA}:
            fail(f"{label} has an unsupported aliased or ZIP64 path record on {name}")
        cursor += field_size


def _preflight_zip(source: BinaryIO, archive_size: int, label: str) -> tuple[int, int]:
    """Bound central-directory allocation before ``zipfile`` parses it."""

    if archive_size < _ZIP_EOCD.size:
        fail(f"{label} is not a complete ZIP archive")
    source.seek(0)
    if source.read(len(_ZIP_LOCAL_SIGNATURE)) != _ZIP_LOCAL_SIGNATURE:
        fail(f"{label} is not a canonical nonempty ZIP archive")
    record_offset = archive_size - _ZIP_EOCD.size
    source.seek(record_offset)
    record_bytes = source.read(_ZIP_EOCD.size)
    if len(record_bytes) != _ZIP_EOCD.size:
        fail(f"{label} has a truncated ZIP end record")
    (
        signature,
        disk_number,
        central_disk,
        disk_entries,
        total_entries,
        central_size,
        central_offset,
        comment_size,
    ) = _ZIP_EOCD.unpack(record_bytes)
    if signature != _ZIP_EOCD_SIGNATURE or comment_size != 0:
        fail(f"{label} has a missing end record or forbidden ZIP comment")
    if disk_number != 0 or central_disk != 0 or disk_entries != total_entries:
        fail(f"{label} is a forbidden multi-disk ZIP archive")
    if total_entries in {0, 0xFFFF} or total_entries > MAX_MEMBERS:
        fail(f"{label} violates the ZIP member-count limit")
    if central_size == 0xFFFFFFFF or central_offset == 0xFFFFFFFF:
        fail(f"{label} uses unsupported ZIP64 metadata")
    if central_size > MAX_ZIP_CENTRAL_DIRECTORY_SIZE:
        fail(f"{label} exceeds the ZIP central-directory byte limit")
    if central_offset + central_size != record_offset:
        fail(f"{label} has prefixed, trailing, or malformed ZIP data")
    return total_entries, central_offset


def _zip_member_kind(info: zipfile.ZipInfo, label: str, name: str) -> bool:
    is_directory = info.is_dir()
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(unix_mode)
    dos_attributes = info.external_attr & 0xFFFF
    if dos_attributes & 0x0400:
        fail(f"{label} contains a reparse-point ZIP member: {name}")
    if is_directory:
        if file_type not in {0, stat.S_IFDIR} or info.file_size != 0:
            fail(f"{label} contains an invalid ZIP directory member: {name}")
    elif file_type not in {0, stat.S_IFREG} or dos_attributes & 0x10:
        fail(f"{label} contains a symlink or special ZIP member: {name}")
    return is_directory


def _inspect_zip_handle(
    source: BinaryIO,
    archive_size: int,
    label: str,
    *,
    capture_names: frozenset[str] = frozenset(),
) -> ArchiveInventory:
    expected_count, central_offset = _preflight_zip(source, archive_size, label)
    members: dict[str, ArchiveMember] = {}
    payloads: dict[str, bytes] = {}
    normalized_names: set[str] = set()
    header_offsets: set[int] = set()
    declared_total = 0
    actual_total = 0
    try:
        source.seek(0)
        with zipfile.ZipFile(source, mode="r", allowZip64=False) as archive:
            if archive.comment:
                fail(f"{label} contains a forbidden ZIP comment")
            infos = archive.infolist()
            if len(infos) != expected_count or len(infos) > MAX_MEMBERS:
                fail(f"{label} violates the ZIP member-count limit")
            if archive.start_dir != central_offset:
                fail(f"{label} has inconsistent central-directory offsets")
            for info in infos:
                original = info.orig_filename
                if info.filename != original:
                    fail(f"{label} contains a platform-normalized ZIP path")
                tentative_directory = info.is_dir() or original.endswith("/")
                name = _canonical_member_name(
                    original,
                    is_directory=tentative_directory,
                    label=label,
                )
                key = _collision_key(name)
                if name in members or key in normalized_names:
                    fail(f"{label} contains duplicate or casefold/NFC-colliding paths")
                normalized_names.add(key)
                _reject_forbidden_path(name, label)
                is_directory = _zip_member_kind(info, label, name)
                if tentative_directory != is_directory:
                    fail(f"{label} contains ambiguous ZIP directory metadata: {name}")
                if info.flag_bits & _ZIP_ENCRYPTION_FLAGS:
                    fail(f"{label} contains an encrypted ZIP member: {name}")
                if info.compress_type not in _ZIP_ALLOWED_COMPRESSION:
                    fail(f"{label} uses an unsupported ZIP compression method: {name}")
                if info.comment:
                    fail(f"{label} contains a forbidden ZIP member comment: {name}")
                _parse_zip_extra(info.extra, label, name)
                if (
                    info.file_size < 0
                    or info.compress_size < 0
                    or info.header_offset < 0
                    or info.header_offset >= central_offset
                ):
                    fail(f"{label} contains invalid ZIP member metadata: {name}")
                if info.header_offset in header_offsets:
                    fail(f"{label} contains ZIP members aliasing one local header")
                header_offsets.add(info.header_offset)
                if info.file_size > MAX_MEMBER_SIZE:
                    fail(f"{label} contains an oversized expanded member: {name}")
                if info.file_size and info.compress_size == 0:
                    fail(f"{label} contains a nonempty member with zero compressed size")
                if info.file_size > info.compress_size * MAX_COMPRESSION_RATIO:
                    fail(f"{label} contains a per-member compression-ratio bomb: {name}")
                declared_total += info.file_size
                if declared_total > MAX_TOTAL_SIZE:
                    fail(f"{label} exceeds the aggregate expanded-size limit")

            if declared_total > archive_size * MAX_COMPRESSION_RATIO:
                fail(f"{label} exceeds the aggregate compression-ratio limit")

            for info in infos:
                name = _canonical_member_name(
                    info.orig_filename,
                    is_directory=info.is_dir(),
                    label=label,
                )
                digest = hashlib.sha256()
                crc = 0
                actual_size = 0
                capture = bytearray() if name in capture_names else None
                with archive.open(info, mode="r") as member:
                    while block := member.read(READ_CHUNK_SIZE):
                        actual_size += len(block)
                        actual_total += len(block)
                        if actual_size > info.file_size or actual_size > MAX_MEMBER_SIZE:
                            fail(f"{label} member expanded past its declared bound: {name}")
                        if actual_total > MAX_TOTAL_SIZE:
                            fail(f"{label} exceeded its aggregate bound while streaming")
                        digest.update(block)
                        crc = binascii.crc32(block, crc)
                        if capture is not None:
                            capture.extend(block)
                if actual_size != info.file_size:
                    fail(f"{label} member length contradicts ZIP metadata: {name}")
                if (crc & 0xFFFFFFFF) != info.CRC:
                    fail(f"{label} member failed its ZIP CRC: {name}")
                is_file = not info.is_dir()
                member_digest = digest.hexdigest() if is_file else None
                members[name] = ArchiveMember(name, is_file, actual_size, member_digest)
                if capture is not None:
                    payloads[name] = bytes(capture)
    except SystemExit:
        raise
    except (
        binascii.Error,
        EOFError,
        NotImplementedError,
        OSError,
        OverflowError,
        RuntimeError,
        ValueError,
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        zlib.error,
    ) as exc:
        fail(f"{label} is corrupt or unsupported: {type(exc).__name__}")
    if actual_total != declared_total:
        fail(f"{label} streamed size differs from its declared aggregate size")
    if set(payloads) != set(capture_names):
        missing = sorted(set(capture_names) - set(payloads))
        fail(f"{label} is missing required captured members: {missing}")
    return ArchiveInventory(members, payloads)


def _inspect_zip_path(
    path: Path,
    *,
    capture_names: frozenset[str] = frozenset(),
) -> ArchiveInventory:
    size = _regular_file_size(path, path.name)
    try:
        with path.open("rb") as source:
            return _inspect_zip_handle(
                source,
                size,
                path.name,
                capture_names=capture_names,
            )
    except SystemExit:
        raise
    except OSError as exc:
        fail(f"cannot read {path.name}: {type(exc).__name__}")


def _inspect_zip_bytes(payload: bytes, label: str) -> ArchiveInventory:
    if type(payload) is not bytes or not 1 <= len(payload) <= MAX_ARCHIVE_BYTES:
        fail(f"{label} violates the nested ZIP byte limit")
    return _inspect_zip_handle(BytesIO(payload), len(payload), label)


def _validate_pax_headers(
    headers: Mapping[str, str],
    *,
    member_name: str | None,
    is_directory: bool,
    member_size: int,
    label: str,
) -> None:
    for key, value in headers.items():
        folded_key = key.casefold()
        if folded_key == "linkpath" or folded_key.startswith("gnu.sparse"):
            fail(f"{label} contains forbidden PAX link or sparse metadata")
        if folded_key == "schily.filetype":
            fail(f"{label} contains forbidden PAX special-file metadata")
        if folded_key == "path":
            if member_name is None:
                fail(f"{label} contains a global PAX path override")
            pax_name = _canonical_member_name(value, is_directory=is_directory, label=label)
            if pax_name != member_name:
                fail(f"{label} contains an inconsistent PAX path override")
        if folded_key == "size":
            try:
                pax_size = int(value, 10)
            except ValueError:
                fail(f"{label} contains an invalid PAX size override")
            if pax_size != member_size:
                fail(f"{label} contains an inconsistent PAX size override")


def _stream_gzip_to_eof(path: Path, archive_size: int, label: str) -> None:
    expanded = 0
    try:
        with gzip.open(path, mode="rb") as source:
            while block := source.read(READ_CHUNK_SIZE):
                expanded += len(block)
                if (
                    expanded > MAX_TAR_STREAM_SIZE
                    or expanded > archive_size * MAX_COMPRESSION_RATIO
                ):
                    fail(f"{label} is a gzip compression-ratio or expanded-size bomb")
    except SystemExit:
        raise
    except (EOFError, gzip.BadGzipFile, OSError, OverflowError, zlib.error) as exc:
        fail(f"{label} has a corrupt gzip stream: {type(exc).__name__}")


def _inspect_sdist(
    path: Path,
    expected_root: str,
    *,
    capture_names: frozenset[str] = frozenset(),
) -> ArchiveInventory:
    archive_size = _regular_file_size(path, path.name)
    try:
        with path.open("rb") as raw:
            if raw.read(2) != b"\x1f\x8b":
                fail(f"{path.name} is not a gzip-compressed source distribution")
    except SystemExit:
        raise
    except OSError as exc:
        fail(f"cannot read {path.name}: {type(exc).__name__}")

    # Validate and bound the complete gzip stream before exposing any expanded
    # PAX or GNU metadata to tarfile's parser.
    _stream_gzip_to_eof(path, archive_size, path.name)

    members: dict[str, ArchiveMember] = {}
    payloads: dict[str, bytes] = {}
    archive_names: set[str] = set()
    archive_keys: set[str] = set()
    relative_keys: set[str] = set()
    offsets: set[int] = set()
    declared_total = 0
    actual_total = 0
    count = 0
    try:
        with tarfile.open(path, mode="r:gz", errorlevel=2) as archive:
            _validate_pax_headers(
                archive.pax_headers,
                member_name=None,
                is_directory=False,
                member_size=0,
                label=path.name,
            )
            for info in archive:
                count += 1
                if count > MAX_MEMBERS:
                    fail(f"{path.name} violates the tar member-count limit")
                is_directory = info.type == tarfile.DIRTYPE
                name = _canonical_member_name(
                    info.name,
                    is_directory=is_directory,
                    label=path.name,
                )
                key = _collision_key(name)
                if name in archive_names or key in archive_keys:
                    fail(f"{path.name} contains duplicate or casefold/NFC-colliding paths")
                archive_names.add(name)
                archive_keys.add(key)
                parts = name.split("/")
                if parts[0] != expected_root:
                    fail(f"{path.name} contains inconsistent or multiple sdist roots")
                if len(parts) == 1:
                    if not is_directory:
                        fail(f"{path.name} has a non-directory project-root member")
                    relative_name = ""
                else:
                    relative_name = "/".join(parts[1:])
                    relative_key = _collision_key(relative_name)
                    if relative_name in members or relative_key in relative_keys:
                        fail(
                            f"{path.name} contains duplicate project-relative or normalized paths"
                        )
                    relative_keys.add(relative_key)
                    _reject_forbidden_path(relative_name, path.name)

                if info.type not in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE}:
                    fail(f"{path.name} contains a link, device, FIFO, or special tar member")
                if info.sparse is not None:
                    fail(f"{path.name} contains a sparse tar member")
                if is_directory and info.size != 0:
                    fail(f"{path.name} contains a nonempty tar directory member")
                if info.size < 0 or info.offset < 0 or info.offset_data < 0:
                    fail(f"{path.name} contains invalid tar member metadata")
                if info.offset in offsets:
                    fail(f"{path.name} contains tar members aliasing one header")
                offsets.add(info.offset)
                if info.size > MAX_MEMBER_SIZE:
                    fail(f"{path.name} contains an oversized expanded member: {name}")
                if info.size > archive_size * MAX_COMPRESSION_RATIO:
                    fail(f"{path.name} contains a per-member compression-ratio bomb: {name}")
                declared_total += info.size
                if declared_total > MAX_TOTAL_SIZE:
                    fail(f"{path.name} exceeds the aggregate expanded-size limit")
                _validate_pax_headers(
                    info.pax_headers,
                    member_name=name,
                    is_directory=is_directory,
                    member_size=info.size,
                    label=path.name,
                )

                digest: str | None = None
                if info.type in {tarfile.REGTYPE, tarfile.AREGTYPE}:
                    extracted = archive.extractfile(info)
                    if extracted is None:
                        fail(f"{path.name} cannot stream regular member {name}")
                    member_digest = hashlib.sha256()
                    actual_size = 0
                    capture = bytearray() if relative_name in capture_names else None
                    with extracted:
                        while block := extracted.read(READ_CHUNK_SIZE):
                            actual_size += len(block)
                            actual_total += len(block)
                            if actual_size > info.size or actual_size > MAX_MEMBER_SIZE:
                                fail(f"{path.name} member expanded past its bound: {name}")
                            if actual_total > MAX_TOTAL_SIZE:
                                fail(f"{path.name} exceeded its aggregate bound while streaming")
                            member_digest.update(block)
                            if capture is not None:
                                capture.extend(block)
                    if actual_size != info.size:
                        fail(f"{path.name} member length contradicts tar metadata: {name}")
                    digest = member_digest.hexdigest()
                    if capture is not None:
                        payloads[relative_name] = bytes(capture)
                if relative_name:
                    members[relative_name] = ArchiveMember(
                        relative_name,
                        info.type in {tarfile.REGTYPE, tarfile.AREGTYPE},
                        info.size,
                        digest,
                    )
    except SystemExit:
        raise
    except (
        EOFError,
        OSError,
        OverflowError,
        tarfile.CompressionError,
        tarfile.HeaderError,
        tarfile.ReadError,
        ValueError,
        zlib.error,
    ) as exc:
        fail(f"{path.name} is corrupt or unsupported: {type(exc).__name__}")
    if count == 0:
        fail(f"{path.name} is an empty source distribution")
    if actual_total != declared_total:
        fail(f"{path.name} streamed size differs from its declared aggregate size")
    if declared_total > archive_size * MAX_COMPRESSION_RATIO:
        fail(f"{path.name} exceeds the aggregate compression-ratio limit")
    if set(payloads) != set(capture_names):
        missing = sorted(set(capture_names) - set(payloads))
        fail(f"{path.name} is missing required captured members: {missing}")
    return ArchiveInventory(members, payloads)


def _require_exact_file(
    inventory: ArchiveInventory,
    archive_name: str,
    source_path: Path,
    label: str,
) -> None:
    member = inventory.members.get(archive_name)
    if member is None or not member.is_file or member.sha256 is None:
        fail(f"{label} requires exact regular file {archive_name}")
    expected_size, expected_digest = _sha256_file(source_path)
    if member.size != expected_size or member.sha256 != expected_digest:
        fail(f"{label} bytes drifted from the contract source: {archive_name}")


def _require_exact_subtree(
    inventory: ArchiveInventory,
    prefix: str,
    expected_files: frozenset[str],
    label: str,
) -> None:
    observed = {
        name[len(prefix) + 1 :]
        for name, member in inventory.members.items()
        if member.is_file and name.startswith(f"{prefix}/")
    }
    if observed != set(expected_files):
        fail(f"{label} {prefix} inventory differs from the exact package contract")


def _parse_json_object(payload: bytes, label: str) -> dict[str, object]:
    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key {key!r}")
            result[key] = value
        return result

    try:
        value = json.loads(
            payload.decode("utf-8", errors="strict"),
            object_pairs_hook=reject_duplicates,
        )
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        fail(f"{label} is not a strict JSON object: {type(exc).__name__}")
    if type(value) is not dict:
        fail(f"{label} must contain an exact JSON object")
    return cast(dict[str, object], value)


def _verify_legal_manifest(
    inventory: ArchiveInventory,
    package_prefix: str,
    label: str,
) -> None:
    manifest_name = f"{package_prefix}/manifest.json"
    manifest = _parse_json_object(inventory.payloads[manifest_name], f"{label} legal manifest")
    raw_files = manifest.get("files")
    if (
        set(manifest) != {"schema_version", "kind", "files"}
        or manifest.get("schema_version") != 1
        or manifest.get("kind") != "evleda-standalone-hardware-legal-payloads"
        or type(raw_files) is not list
    ):
        fail(f"{label} legal manifest subject differs from the closed contract")
    raw_file_list = cast(list[object], raw_files)
    if len(raw_file_list) != len(_LEGAL_FILES):
        fail(f"{label} legal manifest subject differs from the closed contract")
    expected_media_types = {
        "CC-BY-SA-4.0.txt": "text/plain",
        "CERN-OHL-P-2.0.txt": "text/plain",
        "KiCad-Libraries-LICENSE.md": "text/markdown",
        "NOTICE.txt": "text/plain",
        "THIRD_PARTY_NOTICES.md": "text/markdown",
    }
    seen: set[str] = set()
    for raw in raw_file_list:
        if type(raw) is not dict:
            fail(f"{label} legal manifest contains an invalid entry")
        entry = cast(dict[str, object], raw)
        if set(entry) != {
            "filename",
            "media_type",
            "byte_length",
            "sha256",
        }:
            fail(f"{label} legal manifest contains an invalid entry")
        filename = entry["filename"]
        if type(filename) is not str or filename in seen or filename not in _LEGAL_FILES:
            fail(f"{label} legal manifest contains a duplicate or unknown filename")
        member_name = f"{package_prefix}/{filename}"
        member = inventory.members.get(member_name)
        if (
            member is None
            or not member.is_file
            or entry["media_type"] != expected_media_types[filename]
            or type(entry["byte_length"]) is not int
            or entry["byte_length"] != member.size
            or type(entry["sha256"]) is not str
            or entry["sha256"] != member.sha256
        ):
            fail(f"{label} legal manifest does not bind exact bytes for {filename}")
        seen.add(filename)
    if seen != set(_LEGAL_FILES):
        fail(f"{label} legal manifest inventory is incomplete")


def _load_release_verifier(root: Path) -> ModuleType:
    path = root / ".github" / "scripts" / "verify_release_assets.py"
    spec = importlib.util.spec_from_file_location("_evleda_release_asset_verifier", path)
    if spec is None or spec.loader is None:
        fail("cannot load the nested release-asset verifier")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except (ImportError, OSError, RuntimeError, ValueError) as exc:
        fail(f"cannot load the nested release-asset verifier: {type(exc).__name__}")
    return module


def _verify_nested_release_archive(
    payload: bytes,
    filename: str,
    *,
    source_package: bool,
    root: Path,
) -> None:
    _inspect_zip_bytes(payload, filename)
    verifier = _load_release_verifier(root)
    function_name = "verify_source_contract" if source_package else "verify_cam_contract"
    function = getattr(verifier, function_name, None)
    if not callable(function):
        fail(f"nested release verifier does not expose {function_name}")
    try:
        function(_NamedBytesIO(payload, filename))
    except SystemExit:
        raise
    except (OSError, RuntimeError, TypeError, ValueError, zipfile.BadZipFile) as exc:
        fail(f"{filename} failed its nested release contract: {type(exc).__name__}")


def _verify_packaged_reference(inventory: ArchiveInventory, package: str, label: str) -> None:
    prefix = f"{package}/reference"
    manifest_name = f"{prefix}/manifest.json"
    archive_name = f"{prefix}/reference_usb_c_3v3_r2.zip"
    manifest_payload = inventory.payloads[manifest_name]
    archive_payload = inventory.payloads[archive_name]
    _inspect_zip_bytes(archive_payload, archive_name)
    try:
        module = importlib.import_module(f"{package}.reference")
        expected_digest = module.PACKAGED_REFERENCE_MANIFEST_SHA256
        validator = module.validate_packaged_reference_payloads
        validator(
            manifest_payload,
            archive_payload,
            expected_manifest_sha256=expected_digest,
        )
    except (ImportError, OSError, RuntimeError, TypeError, ValueError) as exc:
        fail(f"{label} packaged reference failed its closed contract: {type(exc).__name__}")


def _metadata(root: Path) -> tuple[str, str, str]:
    try:
        document = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        project = document["project"]
        distribution = project["name"]
        version = project["version"]
    except (KeyError, OSError, TypeError, tomllib.TOMLDecodeError) as exc:
        fail(f"cannot read exact project metadata: {type(exc).__name__}")
    if distribution != EXPECTED_DISTRIBUTION:
        fail(f"project distribution must be exactly {EXPECTED_DISTRIBUTION}")
    if type(version) is not str or _SEMVER.fullmatch(version) is None:
        fail("project version must be an exact three-component SemVer")
    package = distribution.replace("-", "_")
    return distribution, version, package


def _distribution_paths(dist: Path, root: Path = ROOT) -> tuple[Path, Path, str, str]:
    distribution, version, package = _metadata(root)
    normalized = distribution.replace("-", "_")
    wheel_name = f"{normalized}-{version}-py3-none-any.whl"
    sdist_name = f"{normalized}-{version}.tar.gz"
    try:
        observed = {entry.name for entry in dist.iterdir()}
    except OSError as exc:
        fail(f"cannot inspect dist directory: {type(exc).__name__}")
    if observed != {wheel_name, sdist_name}:
        fail("dist must contain exactly the expected wheel and sdist names, with no extras")
    wheel = dist / wheel_name
    sdist = dist / sdist_name
    _regular_file_size(wheel, wheel_name)
    _regular_file_size(sdist, sdist_name)
    return wheel, sdist, version, package


def _resource_contract(root: Path, package: str) -> dict[str, Path]:
    legal_mapping = {
        "CC-BY-SA-4.0.txt": root / "LICENSES" / "CC-BY-SA-4.0.txt",
        "CERN-OHL-P-2.0.txt": root / "LICENSES" / "CERN-OHL-P-2.0.txt",
        "KiCad-Libraries-LICENSE.md": root / "LICENSES" / "KiCad-Libraries-LICENSE.md",
        "NOTICE.txt": root / "NOTICE",
        "THIRD_PARTY_NOTICES.md": root / "THIRD_PARTY_NOTICES.md",
    }
    result = {
        f"{package}/legal/{name}": source for name, source in legal_mapping.items()
    }
    result[f"{package}/legal/manifest.json"] = root / package / "legal" / "manifest.json"
    source_prefix = "backend/kicad_compile/human_schematic/sources"
    for name in _SYMBOL_FILES:
        result[f"{source_prefix}/{name}"] = root / source_prefix / name
    result[f"{source_prefix}/lp38692_pinout.receipt.json"] = (
        root / source_prefix / "lp38692_pinout.receipt.json"
    )
    for name in ("README.md", "manifest.json", "reference_usb_c_3v3_r2.zip"):
        result[f"{package}/reference/{name}"] = root / package / "reference" / name
    for name in ("README.md", "manifest.json"):
        result[f"{package}/evidence/reference_sources/{name}"] = (
            root / package / "evidence" / "reference_sources" / name
        )
    return result


def _verify_package_resources(
    inventory: ArchiveInventory,
    root: Path,
    package: str,
    label: str,
) -> None:
    resources = _resource_contract(root, package)
    for archive_name, source_path in resources.items():
        _require_exact_file(inventory, archive_name, source_path, label)

    legal_prefix = f"{package}/legal"
    _require_exact_subtree(
        inventory,
        legal_prefix,
        frozenset({"__init__.py", "manifest.json", *_LEGAL_FILES}),
        label,
    )
    source_prefix = "backend/kicad_compile/human_schematic/sources"
    _require_exact_subtree(
        inventory,
        source_prefix,
        frozenset({"lp38692_pinout.receipt.json", *_SYMBOL_FILES}),
        label,
    )
    _require_exact_subtree(
        inventory,
        f"{package}/reference",
        frozenset(
            {
                "README.md",
                "__init__.py",
                "manifest.json",
                "reference_usb_c_3v3_r2.zip",
                "runtime.py",
            }
        ),
        label,
    )
    _require_exact_subtree(
        inventory,
        f"{package}/evidence/reference_sources",
        frozenset({"README.md", "manifest.json"}),
        label,
    )
    _verify_legal_manifest(inventory, legal_prefix, label)
    _verify_packaged_reference(inventory, package, label)


def verify_wheel(path: Path, version: str, package: str, root: Path = ROOT) -> None:
    legal_prefix = f"{package}/legal"
    capture_names = frozenset(
        {
            f"{legal_prefix}/manifest.json",
            f"{package}/reference/manifest.json",
            f"{package}/reference/reference_usb_c_3v3_r2.zip",
        }
    )
    inventory = _inspect_zip_path(path, capture_names=capture_names)
    _reject_superseded_product_surface(inventory, path.name)
    dist_info = f"{package}-{version}.dist-info"
    allowed_roots = {"backend", package, dist_info}
    observed_roots = {name.split("/", maxsplit=1)[0] for name in inventory.members}
    if not observed_roots <= allowed_roots or dist_info not in observed_roots:
        fail(f"{path.name} contains an unexpected wheel top-level package")

    root_legal = {
        "LICENSE": root / "LICENSE",
        "NOTICE": root / "NOTICE",
        "THIRD_PARTY_NOTICES.md": root / "THIRD_PARTY_NOTICES.md",
        "LICENSES/CC-BY-SA-4.0.txt": root / "LICENSES" / "CC-BY-SA-4.0.txt",
        "LICENSES/CERN-OHL-P-2.0.txt": root / "LICENSES" / "CERN-OHL-P-2.0.txt",
        "LICENSES/KiCad-Libraries-LICENSE.md": (
            root / "LICENSES" / "KiCad-Libraries-LICENSE.md"
        ),
    }
    license_prefix = f"{dist_info}/licenses"
    _require_exact_subtree(inventory, license_prefix, frozenset(root_legal), path.name)
    for relative, source in root_legal.items():
        _require_exact_file(inventory, f"{license_prefix}/{relative}", source, path.name)
    for metadata_name in ("METADATA", "RECORD", "WHEEL", "entry_points.txt", "top_level.txt"):
        member = inventory.members.get(f"{dist_info}/{metadata_name}")
        if member is None or not member.is_file:
            fail(f"{path.name} is missing regular wheel metadata {metadata_name}")
    _verify_package_resources(inventory, root, package, path.name)


def verify_sdist(path: Path, version: str, package: str, root: Path = ROOT) -> None:
    source_zip = f"{package}-reference-usb-c-3v3-r2-source.zip"
    cam_zip = f"{package}-reference-usb-c-3v3-r2-cam-candidate.zip"
    examples_prefix = "examples/reference_usb_c_3v3_r2"
    legal_prefix = f"{package}/legal"
    capture_names = frozenset(
        {
            f"{legal_prefix}/manifest.json",
            f"{package}/reference/manifest.json",
            f"{package}/reference/reference_usb_c_3v3_r2.zip",
            f"{examples_prefix}/{source_zip}",
            f"{examples_prefix}/{cam_zip}",
        }
    )
    expected_root = f"{package}-{version}"
    inventory = _inspect_sdist(
        path,
        expected_root,
        capture_names=capture_names,
    )
    _reject_superseded_product_surface(inventory, path.name)
    root_legal = {
        "LICENSE": root / "LICENSE",
        "NOTICE": root / "NOTICE",
        "THIRD_PARTY_NOTICES.md": root / "THIRD_PARTY_NOTICES.md",
        "LICENSES/CC-BY-SA-4.0.txt": root / "LICENSES" / "CC-BY-SA-4.0.txt",
        "LICENSES/CERN-OHL-P-2.0.txt": root / "LICENSES" / "CERN-OHL-P-2.0.txt",
        "LICENSES/KiCad-Libraries-LICENSE.md": (
            root / "LICENSES" / "KiCad-Libraries-LICENSE.md"
        ),
    }
    _require_exact_subtree(inventory, "LICENSES", frozenset(_LEGAL_FILES[:3]), path.name)
    for archive_name, source in root_legal.items():
        _require_exact_file(inventory, archive_name, source, path.name)
    for cloud_name in _CLOUD_FILES:
        _require_exact_file(inventory, cloud_name, root / cloud_name, path.name)
    _verify_package_resources(inventory, root, package, path.name)

    for filename, source_package in ((source_zip, True), (cam_zip, False)):
        member_name = f"{examples_prefix}/{filename}"
        expected_path = root / member_name
        _require_exact_file(inventory, member_name, expected_path, path.name)
        _verify_nested_release_archive(
            inventory.payloads[member_name],
            filename,
            source_package=source_package,
            root=root,
        )


def verify_distribution(dist: Path, root: Path = ROOT) -> None:
    wheel, sdist, version, package = _distribution_paths(dist, root)
    verify_wheel(wheel, version, package, root)
    verify_sdist(sdist, version, package, root)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify the exact bounded public wheel and source distribution"
    )
    parser.add_argument("--dist", type=Path, required=True)
    arguments = parser.parse_args()
    verify_distribution(arguments.dist.resolve())
    print("public wheel and source distribution verified")


if __name__ == "__main__":
    main()

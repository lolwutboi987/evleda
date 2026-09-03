"""Verify tag release assets are exactly build distributions plus two safe ZIPs."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import struct
import unicodedata
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

EXPECTED = {
    "evleda-reference-usb-c-3v3-r2-source.zip": "deterministic-kicad-source-package",
    "evleda-reference-usb-c-3v3-r2-cam-candidate.zip": "non-release-cam-candidate",
}
PREVIEW = "preview.png"
README = "README.md"
SOURCE_PACKAGE_MANIFEST = "reference_usb_c_3v3_r2.package-manifest.json"
SOURCE_COMPILER_MANIFEST = "reference_usb_c_3v3_r2.flux-compile.json"
CAM_NOTICE = "NOT_FOR_FABRICATION.txt"
CAM_FILE_MANIFEST = "evidence/candidate-files.json"
CAM_RECEIPT = "evidence/candidate-receipt.json"
EXPECTED_CAM_NOTICE = (
    b"NOT FOR FABRICATION OR MANUFACTURING RELEASE\n"
    b"manufacturing_release_eligible=false\n"
    b"\n"
    b"This KiCad CAM candidate is for prototype/reference engineering review only.\n"
    b"Do not send these files to a fabricator, assembler, or contract manufacturer\n"
    b"for production or physical build without explicit qualified physical/CM approval.\n"
    b"\n"
    b"Required before any physical build: fabricator/CM DFM and CAM approval, approved\n"
    b"stackup and process capability review, component/source qualification, and documented\n"
    b"electrical, thermal, functional, and first-article review.\n"
    b"\n"
    b"3V3 is OUTPUT ONLY (100 mA max). DO NOT APPLY POWER TO THE 3V3 OUTPUT.\n"
)
EXPECTED_CAM_NOTICE_SHA256 = hashlib.sha256(EXPECTED_CAM_NOTICE).hexdigest()
EXPECTED_LEGAL_ASSETS = {
    "legal/CC-BY-SA-4.0.txt": {
        "filename": "legal/CC-BY-SA-4.0.txt",
        "media_type": "text/plain",
        "byte_length": 20138,
        "sha256": "28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5",
    },
    "legal/CERN-OHL-P-2.0.txt": {
        "filename": "legal/CERN-OHL-P-2.0.txt",
        "media_type": "text/plain",
        "byte_length": 8855,
        "sha256": "eeecc593866fa1c3b80189c7e3dc0ceb77740557fa92f81771f891cc54c579cb",
    },
    "legal/KiCad-Libraries-LICENSE.md": {
        "filename": "legal/KiCad-Libraries-LICENSE.md",
        "media_type": "text/markdown",
        "byte_length": 2101,
        "sha256": "45d2bce75e5a4208f5afb01b8fb2c406e700371c4fe2b5f5cd5c443d46db4d8f",
    },
    "legal/NOTICE.txt": {
        "filename": "legal/NOTICE.txt",
        "media_type": "text/plain",
        "byte_length": 3069,
        "sha256": "44a717c1b84c625a3db460cf9c165ec3390bafbf0ecce0ae50667d584fb6f4cf",
    },
    "legal/THIRD_PARTY_NOTICES.md": {
        "filename": "legal/THIRD_PARTY_NOTICES.md",
        "media_type": "text/markdown",
        "byte_length": 5055,
        "sha256": "d79393d351d06f7a907254919a67cc811a495a56a9812e61af6157c4493ffb5b",
    },
}
FORBIDDEN_ARCHIVE_PARTS = {
    ".flux-clone",
    "tmp",
    "work",
    "outputs",
    "node_modules",
    "private-evidence",
    "evidence-private",
    "runtime-evidence",
    "worker-state",
}
FORBIDDEN_ARCHIVE_SUFFIXES = (".kicad_prl", ".sqlite", ".sqlite3", ".db", ".pem", ".key")
MAX_MEMBERS = 2_000
MAX_MEMBER_SIZE = 32 * 1024 * 1024
MAX_TOTAL_SIZE = 128 * 1024 * 1024
MAX_COMPRESSION_RATIO = 100
MAX_RELEASE_ASSET_SIZE = 256 * 1024 * 1024
READ_CHUNK_SIZE = 1024 * 1024
MAX_CENTRAL_RECORD_SIZE = 16 * 1024
ZIP_EOCD = struct.Struct("<4s4H2LH")
ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
ZIP_LOCAL_FILE_SIGNATURE = b"PK\x03\x04"
ZIP_CENTRAL_FILE_SIGNATURE = b"PK\x01\x02"


def fail(message: str) -> NoReturn:
    raise SystemExit(f"release asset verification failed: {message}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def bytes_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_json_member(
    archive: zipfile.ZipFile, member_name: str, archive_name: str
) -> dict[str, object]:
    try:
        payload = archive.read(member_name)
        value = json.loads(
            payload.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (KeyError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        fail(f"{archive_name} has an invalid or missing {member_name}: {type(exc).__name__}")
    if type(value) is not dict:
        fail(f"{archive_name} {member_name} must contain a JSON object")
    return value


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _manifest_inventory(value: object, label: str) -> dict[str, dict[str, object]]:
    if type(value) is not list or len(value) > MAX_MEMBERS:
        fail(f"{label} must be a bounded array")
    result: dict[str, dict[str, object]] = {}
    folded: set[str] = set()
    for item in value:
        if type(item) is not dict or set(item) != {
            "filename",
            "media_type",
            "byte_length",
            "sha256",
        }:
            fail(f"{label} has an invalid entry shape")
        filename = item["filename"]
        media_type = item["media_type"]
        size = item["byte_length"]
        digest = item["sha256"]
        if type(filename) is not str or not filename or "\\" in filename:
            fail(f"{label} has an invalid filename")
        pure = PurePosixPath(filename)
        if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
            fail(f"{label} has an unsafe filename")
        if filename in result or filename.casefold() in folded:
            fail(f"{label} has duplicate or case-colliding filenames")
        if type(media_type) is not str or not media_type:
            fail(f"{label} has an invalid media type")
        if type(size) is not int or not 0 < size <= MAX_MEMBER_SIZE:
            fail(f"{label} has an invalid byte length")
        if not _is_sha256(digest):
            fail(f"{label} has an invalid SHA-256")
        result[filename] = item
        folded.add(filename.casefold())
    return result


def _verify_archive_inventory(
    archive: zipfile.ZipFile,
    inventory: dict[str, dict[str, object]],
    expected_names: set[str],
    label: str,
) -> None:
    if set(inventory) != expected_names:
        fail(f"{label} does not bind the exact archive inventory")
    for filename, entry in inventory.items():
        payload = archive.read(filename)
        if len(payload) != entry["byte_length"] or bytes_sha256(payload) != entry["sha256"]:
            fail(f"{label} does not bind exact bytes for {filename}")


def _verify_legal_assets(
    archive: zipfile.ZipFile,
    inventory: dict[str, dict[str, object]],
    label: str,
) -> None:
    observed = {name for name in archive.namelist() if name.startswith("legal/")}
    if observed != set(EXPECTED_LEGAL_ASSETS):
        fail(f"{label} does not contain the exact standalone legal inventory")
    for filename, expected in EXPECTED_LEGAL_ASSETS.items():
        if inventory.get(filename) != expected:
            fail(f"{label} does not manifest-bind {filename}")
        payload = archive.read(filename)
        if len(payload) != expected["byte_length"] or bytes_sha256(payload) != expected["sha256"]:
            fail(f"{label} legal resource bytes drifted: {filename}")


def parse_manifest(directory: Path) -> list[dict[str, Any]]:
    path = directory / "release-assets.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read release asset manifest: {exc}")
    required = {"schema_version", "project", "manufacturing_release_eligible", "assets"}
    if not isinstance(document, dict) or set(document) != required:
        fail("invalid release asset manifest shape")
    if (
        document["schema_version"] != 1
        or document["project"] != "reference-usb-c-3v3-r2"
        or document["manufacturing_release_eligible"] is not False
        or not isinstance(document["assets"], list)
    ):
        fail("invalid release asset manifest schema")
    return document["assets"]


def _preflight_zip_end_record(path: Path) -> tuple[int, int]:
    """Bound central-directory parsing before ``ZipFile`` allocates member objects."""

    archive_size = path.stat().st_size
    if archive_size < ZIP_EOCD.size or archive_size > MAX_RELEASE_ASSET_SIZE:
        fail(f"{path.name} has an invalid archive size")
    tail_size = min(archive_size, ZIP_EOCD.size + 65_535)
    try:
        with path.open("rb") as source:
            if source.read(4) != ZIP_LOCAL_FILE_SIGNATURE:
                fail(f"{path.name} is not a canonical nonempty ZIP")
            source.seek(archive_size - tail_size)
            tail = source.read(tail_size)
    except OSError as exc:
        fail(f"{path.name} cannot be preflighted: {type(exc).__name__}")
    lower_bound = max(0, len(tail) - ZIP_EOCD.size - 65_535)
    cursor = len(tail) - ZIP_EOCD.size
    record: tuple[bytes, int, int, int, int, int, int, int] | None = None
    relative_offset = -1
    while cursor >= lower_bound:
        candidate = tail.rfind(
            ZIP_EOCD_SIGNATURE,
            lower_bound,
            cursor + len(ZIP_EOCD_SIGNATURE),
        )
        if candidate < 0:
            break
        if candidate + ZIP_EOCD.size <= len(tail):
            unpacked = ZIP_EOCD.unpack_from(tail, candidate)
            if candidate + ZIP_EOCD.size + unpacked[-1] == len(tail):
                record = unpacked
                relative_offset = candidate
                break
        cursor = candidate - 1
    if record is None:
        fail(f"{path.name} has no valid ZIP end record")
    (
        _,
        disk_number,
        central_directory_disk,
        disk_entries,
        total_entries,
        central_directory_size,
        central_directory_offset,
        comment_size,
    ) = record
    if (
        disk_number != 0
        or central_directory_disk != 0
        or disk_entries != total_entries
        or comment_size != 0
    ):
        fail(f"{path.name} is multi-disk or carries an unapproved ZIP comment")
    if (
        total_entries in {0, 0xFFFF}
        or total_entries > MAX_MEMBERS
        or central_directory_size == 0xFFFFFFFF
        or central_directory_offset == 0xFFFFFFFF
    ):
        fail(f"{path.name} has an invalid or ZIP64 member count")
    if central_directory_size > total_entries * MAX_CENTRAL_RECORD_SIZE:
        fail(f"{path.name} has an oversized central directory")
    absolute_record_offset = archive_size - tail_size + relative_offset
    if central_directory_offset + central_directory_size != absolute_record_offset:
        fail(f"{path.name} contains prefixed, trailing, or malformed ZIP data")
    try:
        with path.open("rb") as source:
            source.seek(central_directory_offset)
            if source.read(4) != ZIP_CENTRAL_FILE_SIGNATURE:
                fail(f"{path.name} central directory does not start canonically")
    except OSError as exc:
        fail(f"{path.name} central directory is unreadable: {type(exc).__name__}")
    return total_entries, central_directory_offset


def _zip_members(
    archive: zipfile.ZipFile,
    archive_name: str,
    *,
    expected_count: int | None = None,
    central_directory_offset: int | None = None,
) -> list[zipfile.ZipInfo]:
    """Validate central-directory metadata without decompressing a member."""

    members = archive.infolist()
    if len(members) > MAX_MEMBERS or (
        expected_count is not None and len(members) != expected_count
    ):
        fail(f"{archive_name} exceeds the member-count limit")
    seen_names: set[str] = set()
    seen_folded: set[str] = set()
    seen_offsets: set[int] = set()
    total_size = 0
    for info in members:
        if (
            not info.filename
            or "\\" in info.filename
            or "//" in info.filename
            or re.match(r"^[A-Za-z]:", info.filename)
        ):
            fail(f"{archive_name} contains a platform-unsafe archive path")
        member = PurePosixPath(info.filename)
        parts = set(member.parts)
        if member.is_absolute() or ".." in parts or any(not part for part in member.parts):
            fail(f"{archive_name} contains an unsafe archive path")
        if info.orig_filename != info.filename:
            fail(f"{archive_name} contains an ambiguous archive path")
        folded = unicodedata.normalize("NFC", info.filename).casefold()
        if info.filename in seen_names or folded in seen_folded:
            fail(f"{archive_name} contains duplicate or case-colliding archive paths")
        seen_names.add(info.filename)
        seen_folded.add(folded)
        if (
            info.header_offset < 0
            or central_directory_offset is not None
            and info.header_offset >= central_directory_offset
            or info.header_offset in seen_offsets
        ):
            fail(f"{archive_name} contains an invalid local-header offset")
        seen_offsets.add(info.header_offset)
        mode = info.external_attr >> 16
        member_type = stat.S_IFMT(mode)
        is_special = member_type and member_type not in (stat.S_IFREG, stat.S_IFDIR)
        if info.flag_bits & 0x1 or is_special:
            fail(f"{archive_name} contains an encrypted or special archive member")
        if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            fail(f"{archive_name} contains an unsupported compression method")
        if info.file_size < 0 or info.compress_size < 0:
            fail(f"{archive_name} contains an invalid member size")
        if info.is_dir() and (info.file_size != 0 or info.compress_size != 0):
            fail(f"{archive_name} contains a nonempty directory member")
        if info.file_size > MAX_MEMBER_SIZE:
            fail(f"{archive_name} contains an oversized member")
        total_size += info.file_size
        if total_size > MAX_TOTAL_SIZE:
            fail(f"{archive_name} exceeds the uncompressed-size limit")
        if info.file_size and info.compress_size == 0:
            fail(f"{archive_name} contains an invalid zero-size compressed member")
        if (
            info.compress_size
            and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
        ):
            fail(f"{archive_name} contains a suspicious compression ratio")
        is_excluded = parts & FORBIDDEN_ARCHIVE_PARTS or info.filename.lower().endswith(
            FORBIDDEN_ARCHIVE_SUFFIXES
        )
        if is_excluded:
            fail(f"{archive_name} contains excluded internal state: {info.filename}")
    return members


def _verify_member_stream(
    archive: zipfile.ZipFile, info: zipfile.ZipInfo, archive_name: str
) -> None:
    """Reach each member's EOF in bounded reads so zipfile checks its CRC."""

    if info.is_dir():
        return
    actual_size = 0
    with archive.open(info, "r") as source:
        while True:
            block = source.read(READ_CHUNK_SIZE)
            if not block:
                break
            actual_size += len(block)
            if actual_size > info.file_size or actual_size > MAX_MEMBER_SIZE:
                fail(f"{archive_name} member expanded beyond its declared size")
    if actual_size != info.file_size:
        fail(f"{archive_name} member size differs from its central-directory declaration")


def verify_zip(path: Path) -> None:
    if path.is_symlink() or not path.is_file():
        fail(f"{path.name} is not a regular ZIP file")
    try:
        expected_count, central_directory_offset = _preflight_zip_end_record(path)
        with zipfile.ZipFile(path, "r") as archive:
            # Validate every central-directory bound first. No member is opened
            # until the full archive metadata has passed these checks.
            members = _zip_members(
                archive,
                path.name,
                expected_count=expected_count,
                central_directory_offset=central_directory_offset,
            )
            for info in members:
                _verify_member_stream(archive, info, path.name)
    except SystemExit:
        raise
    except (
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
        fail(f"{path.name} is corrupt or unsupported: {type(exc).__name__}")


def verify_source_contract(path: Path) -> dict[str, dict[str, object]]:
    """Verify the deterministic source ZIP's two nested hash inventories."""

    try:
        with zipfile.ZipFile(path, "r") as archive:
            names = set(archive.namelist())
            package = _read_json_member(archive, SOURCE_PACKAGE_MANIFEST, path.name)
            if (
                package.get("schema_version") != 1
                or package.get("kind") != "flux-clone-reference-package-manifest"
                or package.get("project_stem") != "reference_usb_c_3v3_r2"
                or not _is_sha256(package.get("reference_design_artifact_sha256"))
                or not _is_sha256(package.get("compiler_manifest_sha256"))
            ):
                fail(f"{path.name} has an invalid source package subject")
            package_inventory = _manifest_inventory(
                package.get("files"), f"{path.name} source package inventory"
            )
            _verify_archive_inventory(
                archive,
                package_inventory,
                names - {SOURCE_PACKAGE_MANIFEST},
                f"{path.name} source package inventory",
            )
            _verify_legal_assets(archive, package_inventory, path.name)

            compiler = _read_json_member(archive, SOURCE_COMPILER_MANIFEST, path.name)
            if (
                compiler.get("schema_version") != 3
                or compiler.get("compiler_version") != "4.0.0"
                or compiler.get("project_stem") != "reference_usb_c_3v3_r2"
                or compiler.get("manufacturingReleaseEligible") is not False
                or compiler.get("referenceDesignReady") is not True
                or compiler.get("semanticParity") is not True
                or compiler.get("kicadExecution") != "not-run"
            ):
                fail(f"{path.name} has an invalid compiler manifest subject")
            compiler_payload = archive.read(SOURCE_COMPILER_MANIFEST)
            if (
                bytes_sha256(compiler_payload) != package.get("compiler_manifest_sha256")
                or package_inventory[SOURCE_COMPILER_MANIFEST]["sha256"]
                != package.get("compiler_manifest_sha256")
            ):
                fail(f"{path.name} does not bind its compiler manifest hash")
            compiler_inventory = _manifest_inventory(
                compiler.get("files"), f"{path.name} compiler source inventory"
            )
            if len(compiler_inventory) != 29:
                fail(f"{path.name} must bind exactly 29 compiler-owned source files")
            required = {
                "reference_usb_c_3v3_r2.kicad_pro",
                "reference_usb_c_3v3_r2.kicad_sch",
                "reference_usb_c_3v3_r2.kicad_pcb",
                "fp-lib-table",
                "sym-lib-table",
                "FluxGenerated.kicad_sym",
            }
            if not required <= set(compiler_inventory):
                fail(f"{path.name} has an incomplete KiCad project inventory")
            if any(name not in package_inventory for name in compiler_inventory):
                fail(f"{path.name} compiler inventory escapes the package inventory")
            if any(
                package_inventory[name] != entry
                for name, entry in compiler_inventory.items()
            ):
                fail(f"{path.name} package and compiler source inventories disagree")
            _verify_archive_inventory(
                archive,
                compiler_inventory,
                set(compiler_inventory),
                f"{path.name} compiler source inventory",
            )
            readme = archive.read(README)
            if b"not a production release" not in readme:
                fail(f"{path.name} lacks the source non-release statement")
            return compiler_inventory
    except SystemExit:
        raise
    except (
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
        fail(f"{path.name} source contract is corrupt: {type(exc).__name__}")


def _verify_notice_binding(document: dict[str, object], archive_name: str, label: str) -> None:
    notice = document.get("non_fabrication_notice")
    if type(notice) is not dict or notice != {
        "filename": CAM_NOTICE,
        "media_type": "text/plain",
        "byte_length": len(EXPECTED_CAM_NOTICE),
        "sha256": EXPECTED_CAM_NOTICE_SHA256,
    }:
        fail(f"{archive_name} {label} does not bind the canonical non-fabrication notice")


def verify_cam_contract(path: Path) -> None:
    """Verify the top-level warning, file manifest, and receipt bind each other."""

    try:
        with zipfile.ZipFile(path, "r") as archive:
            names = set(archive.namelist())
            for required in (CAM_NOTICE, CAM_FILE_MANIFEST, CAM_RECEIPT):
                if required not in names:
                    fail(f"{path.name} is missing required top-level contract file {required}")
            notice_payload = archive.read(CAM_NOTICE)
            if (
                notice_payload != EXPECTED_CAM_NOTICE
                or bytes_sha256(notice_payload) != EXPECTED_CAM_NOTICE_SHA256
            ):
                fail(f"{path.name} has a noncanonical non-fabrication notice")

            file_manifest = _read_json_member(archive, CAM_FILE_MANIFEST, path.name)
            if (
                file_manifest.get("schema_version") != 1
                or file_manifest.get("kind")
                != "flux-clone-manufacturing-candidate-files"
                or file_manifest.get("manufacturing_release_eligible") is not False
                or not _is_sha256(file_manifest.get("candidate_sha256"))
                or not _is_sha256(file_manifest.get("candidate_receipt_sha256"))
            ):
                fail(f"{path.name} has an invalid CAM file-manifest subject")
            _verify_notice_binding(file_manifest, path.name, "file manifest")
            inventory = _manifest_inventory(
                file_manifest.get("files"), f"{path.name} CAM file inventory"
            )
            _verify_archive_inventory(
                archive,
                inventory,
                names - {CAM_FILE_MANIFEST},
                f"{path.name} CAM file inventory",
            )
            _verify_legal_assets(archive, inventory, path.name)
            notice_entry = inventory.get(CAM_NOTICE)
            if notice_entry != file_manifest.get("non_fabrication_notice"):
                fail(f"{path.name} notice is not identically bound by its file inventory")

            receipt = _read_json_member(archive, CAM_RECEIPT, path.name)
            if (
                receipt.get("schema_version") != 3
                or receipt.get("receipt_kind") != "non-release-kicad-cam-candidate"
                or receipt.get("manufacturing_release_eligible") is not False
                or receipt.get("candidate_sha256") != file_manifest.get("candidate_sha256")
                or receipt.get("receipt_sha256")
                != file_manifest.get("candidate_receipt_sha256")
                or receipt.get("non_fabrication_notice_filename") != CAM_NOTICE
                or receipt.get("non_fabrication_notice_sha256")
                != EXPECTED_CAM_NOTICE_SHA256
            ):
                fail(f"{path.name} CAM receipt is inconsistent with its file manifest")
    except SystemExit:
        raise
    except (
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
        fail(f"{path.name} CAM contract is corrupt: {type(exc).__name__}")


def validate_asset_declaration(asset: object) -> tuple[str, int, str, str]:
    if not isinstance(asset, dict) or set(asset) != {
        "filename",
        "byte_length",
        "sha256",
        "kind",
    }:
        fail("invalid asset declaration shape")
    filename = asset["filename"]
    size = asset["byte_length"]
    digest = asset["sha256"]
    kind = asset["kind"]
    if not isinstance(filename, str):
        fail("asset filename must be a string")
    expected_kind = "review-preview" if filename == PREVIEW else EXPECTED.get(filename)
    if expected_kind is None or kind != expected_kind:
        fail("asset name or kind failed the curated contract")
    if type(size) is not int or not 0 < size <= MAX_RELEASE_ASSET_SIZE:
        fail(f"asset {filename} has an invalid byte_length")
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        fail(f"asset {filename} has an invalid lowercase SHA-256")
    return filename, size, digest, kind


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--dist", type=Path, required=True)
    arguments = parser.parse_args()
    directory = arguments.directory.resolve()
    declared = parse_manifest(directory)
    if len(declared) != 3:
        fail("release manifest must declare two ZIPs and one reviewed preview")
    seen: set[str] = set()
    for asset in declared:
        filename, size, digest, _kind = validate_asset_declaration(asset)
        if filename in seen:
            fail("asset name uniqueness failed the curated contract")
        path = directory / filename
        matches_manifest = (
            not path.is_symlink()
            and path.is_file()
            and path.stat().st_size == size
            and sha256(path) == digest
        )
        if not matches_manifest:
            fail(f"manifest binding mismatch for {filename}")
        if filename in EXPECTED:
            verify_zip(path)
            if filename.endswith("source.zip"):
                verify_source_contract(path)
            else:
                verify_cam_contract(path)
        seen.add(filename)
    if seen != set(EXPECTED) | {PREVIEW}:
        fail("release assets differ from the curated contract")
    files = {path.name for path in directory.iterdir() if path.is_file()}
    if files != seen | {README, "release-assets.json"}:
        fail("release-assets directory contains undeclared files")
    readme = (directory / README).read_text(encoding="utf-8").lower()
    if "manufacturing_release_eligible: false" not in readme or "not affiliated" not in readme:
        fail("release README must carry the non-release and KiCad non-affiliation notices")
    distributions = [path for path in arguments.dist.glob("*") if path.is_file()]
    if len([path for path in distributions if path.suffix == ".whl"]) != 1 or len(
        [path for path in distributions if path.name.endswith(".tar.gz")]
    ) != 1:
        fail("dist must contain exactly one wheel and one source distribution")
    print("release assets verified")


if __name__ == "__main__":
    main()

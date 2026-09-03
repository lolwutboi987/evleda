"""Adversarial coverage for the no-extraction distribution verifier."""

# pyright: reportPrivateUsage=false

from __future__ import annotations

import io
import stat
import struct
import tarfile
import warnings
import zipfile
from pathlib import Path
from typing import Literal
from unittest import mock

import pytest

from scripts import verify_public_distribution as verifier


def _zip_bytes(
    entries: list[tuple[str, bytes, int]],
    *,
    compression: int = zipfile.ZIP_STORED,
) -> bytes:
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w", compression=compression, allowZip64=False) as archive:
            for name, payload, mode in entries:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = mode << 16
                info.compress_type = compression
                archive.writestr(info, payload, compress_type=compression)
    return output.getvalue()


def _regular_zip(*entries: tuple[str, bytes]) -> bytes:
    return _zip_bytes(
        [(name, payload, stat.S_IFREG | 0o644) for name, payload in entries]
    )


def _write_tar(
    path: Path,
    entries: list[tuple[str, bytes, bytes, str]],
    *,
    mode: Literal["w", "w:gz"] = "w:gz",
) -> None:
    with tarfile.open(path, mode=mode, format=tarfile.PAX_FORMAT) as archive:
        root = tarfile.TarInfo("pkg")
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        archive.addfile(root)
        for name, payload, member_type, linkname in entries:
            info = tarfile.TarInfo(name)
            info.type = member_type
            info.mode = 0o644
            info.linkname = linkname
            if member_type in {tarfile.REGTYPE, tarfile.AREGTYPE}:
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            else:
                archive.addfile(info)


def _inspect_tar(path: Path) -> verifier.ArchiveInventory:
    return verifier._inspect_sdist(path, "pkg")


@pytest.mark.parametrize(
    "name",
    [
        "backend/api/server.py",
        "frontend/index.html",
        "prototypes/project_host.py",
        "tests/api/test_server.py",
        "package.json",
        "docs/FEATURE_PARITY.md",
    ],
)
def test_distribution_rejects_superseded_browser_http_surface(name: str) -> None:
    inventory = verifier.ArchiveInventory(
        members={name: verifier.ArchiveMember(name, True, 1, "0" * 64)},
        payloads={},
    )
    with pytest.raises(SystemExit, match="superseded browser/HTTP product surface"):
        verifier._reject_superseded_product_surface(inventory, "candidate")


@pytest.mark.parametrize(
    "name",
    [
        "/absolute.txt",
        "../traversal.txt",
        "safe/./dot.txt",
        "safe/../traversal.txt",
        "C:/drive.txt",
        "C:drive.txt",
        "//server/share.txt",
        "\\\\server\\share.txt",
    ],
)
def test_zip_rejects_nonportable_paths(name: str) -> None:
    payload = _regular_zip((name, b"x"))
    with pytest.raises(SystemExit):
        verifier._inspect_zip_bytes(payload, "hostile.zip")


def test_zip_rejects_raw_backslash_paths() -> None:
    payload = _regular_zip(("safe/backslash.txt", b"x"))
    hostile = payload.replace(b"safe/backslash.txt", b"safe\\backslash.txt")
    assert hostile != payload
    with pytest.raises(SystemExit):
        verifier._inspect_zip_bytes(hostile, "hostile.zip")


@pytest.mark.parametrize(
    "name",
    [
        "/absolute.txt",
        "../traversal.txt",
        "pkg/./dot.txt",
        "pkg/../traversal.txt",
        "C:/drive.txt",
        "C:drive.txt",
        "//server/share.txt",
        "\\\\server\\share.txt",
        "pkg/safe\\backslash.txt",
    ],
)
def test_tar_rejects_nonportable_paths(tmp_path: Path, name: str) -> None:
    path = tmp_path / "hostile.tar.gz"
    _write_tar(path, [(name, b"x", tarfile.REGTYPE, "")])
    with pytest.raises(SystemExit):
        _inspect_tar(path)


@pytest.mark.parametrize(
    "names",
    [
        ("README.md", "README.md"),
        ("README.md", "readme.md"),
        ("caf\u00e9.txt", "cafe\u0301.txt"),
    ],
)
def test_zip_rejects_exact_casefold_and_nfc_collisions(names: tuple[str, str]) -> None:
    payload = _regular_zip((names[0], b"one"), (names[1], b"two"))
    with pytest.raises(SystemExit):
        verifier._inspect_zip_bytes(payload, "collision.zip")


@pytest.mark.parametrize(
    "names",
    [
        ("pkg/README.md", "pkg/README.md"),
        ("pkg/README.md", "pkg/readme.md"),
        ("pkg/caf\u00e9.txt", "pkg/cafe\u0301.txt"),
    ],
)
def test_tar_rejects_exact_casefold_and_nfc_collisions(
    tmp_path: Path, names: tuple[str, str]
) -> None:
    path = tmp_path / "collision.tar.gz"
    _write_tar(
        path,
        [
            (names[0], b"one", tarfile.REGTYPE, ""),
            (names[1], b"two", tarfile.REGTYPE, ""),
        ],
    )
    with pytest.raises(SystemExit):
        _inspect_tar(path)


def test_sdist_rejects_multiple_or_inconsistent_roots(tmp_path: Path) -> None:
    path = tmp_path / "roots.tar.gz"
    _write_tar(path, [("other/NOTICE", b"x", tarfile.REGTYPE, "")])
    with pytest.raises(SystemExit):
        _inspect_tar(path)


@pytest.mark.parametrize(
    "member_type",
    [
        tarfile.SYMTYPE,
        tarfile.LNKTYPE,
        tarfile.FIFOTYPE,
        tarfile.CHRTYPE,
        tarfile.BLKTYPE,
        tarfile.GNUTYPE_SPARSE,
    ],
)
def test_tar_rejects_links_devices_fifos_and_sparse_members(
    tmp_path: Path, member_type: bytes
) -> None:
    path = tmp_path / "special.tar.gz"
    _write_tar(path, [("pkg/member", b"", member_type, "../../outside")])
    with pytest.raises(SystemExit):
        _inspect_tar(path)


@pytest.mark.parametrize(
    "mode",
    [stat.S_IFLNK | 0o777, stat.S_IFCHR | 0o600, stat.S_IFIFO | 0o600],
)
def test_zip_rejects_symlinks_and_special_members(mode: int) -> None:
    payload = _zip_bytes([("member", b"target", mode)])
    with pytest.raises(SystemExit):
        verifier._inspect_zip_bytes(payload, "special.zip")


def test_zip_rejects_encrypted_flags_before_opening_payload() -> None:
    payload = bytearray(_regular_zip(("secret.txt", b"secret")))
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        position = payload.index(signature)
        flags = struct.unpack_from("<H", payload, position + flag_offset)[0]
        struct.pack_into("<H", payload, position + flag_offset, flags | 0x1)
    with pytest.raises(SystemExit, match="encrypted"):
        verifier._inspect_zip_bytes(bytes(payload), "encrypted.zip")


def test_zip_rejects_unsupported_compression() -> None:
    payload = _zip_bytes(
        [("payload.txt", b"payload", stat.S_IFREG | 0o644)],
        compression=zipfile.ZIP_BZIP2,
    )
    with pytest.raises(SystemExit, match="unsupported ZIP compression"):
        verifier._inspect_zip_bytes(payload, "unsupported.zip")


def test_tar_rejects_non_gzip_compression(tmp_path: Path) -> None:
    path = tmp_path / "not-gzip.tar.gz"
    _write_tar(path, [("pkg/file", b"x", tarfile.REGTYPE, "")], mode="w")
    with pytest.raises(SystemExit, match="not a gzip"):
        _inspect_tar(path)


def test_archives_reject_overlong_names(tmp_path: Path) -> None:
    name = "/".join(("a" * 100, "b" * 100, "c" * 100))
    with pytest.raises(SystemExit, match="overlong"):
        verifier._inspect_zip_bytes(_regular_zip((name, b"x")), "long.zip")
    path = tmp_path / "long.tar.gz"
    _write_tar(path, [(f"pkg/{name}", b"x", tarfile.REGTYPE, "")])
    with pytest.raises(SystemExit, match="overlong"):
        _inspect_tar(path)


def test_archives_reject_excessive_members(tmp_path: Path) -> None:
    entries = [(f"{index}.txt", b"x") for index in range(3)]
    with mock.patch.object(verifier, "MAX_MEMBERS", 2):
        with pytest.raises(SystemExit, match="member-count"):
            verifier._inspect_zip_bytes(_regular_zip(*entries), "many.zip")
        path = tmp_path / "many.tar.gz"
        _write_tar(
            path,
            [(f"pkg/{name}", payload, tarfile.REGTYPE, "") for name, payload in entries],
        )
        with pytest.raises(SystemExit, match="member-count"):
            _inspect_tar(path)


def test_archives_reject_member_and_aggregate_size_limits(tmp_path: Path) -> None:
    with mock.patch.object(verifier, "MAX_MEMBER_SIZE", 3):
        with pytest.raises(SystemExit, match="oversized"):
            verifier._inspect_zip_bytes(_regular_zip(("large", b"1234")), "large.zip")
        path = tmp_path / "large.tar.gz"
        _write_tar(path, [("pkg/large", b"1234", tarfile.REGTYPE, "")])
        with pytest.raises(SystemExit, match="oversized"):
            _inspect_tar(path)
    with (
        mock.patch.object(verifier, "MAX_MEMBER_SIZE", 10),
        mock.patch.object(verifier, "MAX_TOTAL_SIZE", 6),
    ):
        with pytest.raises(SystemExit, match="aggregate"):
            verifier._inspect_zip_bytes(
                _regular_zip(("one", b"1234"), ("two", b"5678")), "aggregate.zip"
            )
        path = tmp_path / "aggregate.tar.gz"
        _write_tar(
            path,
            [
                ("pkg/one", b"1234", tarfile.REGTYPE, ""),
                ("pkg/two", b"5678", tarfile.REGTYPE, ""),
            ],
        )
        with pytest.raises(SystemExit, match="aggregate"):
            _inspect_tar(path)


def test_archives_reject_compression_ratio_bombs(tmp_path: Path) -> None:
    zeros = b"0" * (1024 * 1024)
    compressed = _zip_bytes(
        [("zeros", zeros, stat.S_IFREG | 0o644)],
        compression=zipfile.ZIP_DEFLATED,
    )
    with pytest.raises(SystemExit, match="compression-ratio"):
        verifier._inspect_zip_bytes(compressed, "bomb.zip")
    path = tmp_path / "bomb.tar.gz"
    _write_tar(path, [("pkg/zeros", zeros, tarfile.REGTYPE, "")])
    with pytest.raises(SystemExit, match="compression-ratio"):
        _inspect_tar(path)


def test_zip_streams_to_eof_and_rejects_bad_crc() -> None:
    original = _regular_zip(("payload", b"abcdef"))
    corrupted = original.replace(b"abcdef", b"abcxef", 1)
    assert corrupted != original
    with pytest.raises(SystemExit):
        verifier._inspect_zip_bytes(corrupted, "crc.zip")


def test_tar_streams_gzip_to_eof_and_rejects_bad_crc(tmp_path: Path) -> None:
    path = tmp_path / "crc.tar.gz"
    _write_tar(path, [("pkg/payload", b"abcdef", tarfile.REGTYPE, "")])
    payload = bytearray(path.read_bytes())
    payload[-8] ^= 1
    path.write_bytes(payload)
    with pytest.raises(SystemExit):
        _inspect_tar(path)


@pytest.mark.parametrize(
    "headers",
    [{"path": "../outside"}, {"linkpath": "../../outside"}],
)
def test_pax_path_and_link_overrides_are_rejected(
    tmp_path: Path, headers: dict[str, str]
) -> None:
    path = tmp_path / "pax.tar.gz"
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        root = tarfile.TarInfo("pkg")
        root.type = tarfile.DIRTYPE
        archive.addfile(root)
        member = tarfile.TarInfo("pkg/safe")
        member.size = 1
        member.pax_headers = headers
        archive.addfile(member, io.BytesIO(b"x"))
    with pytest.raises(SystemExit):
        _inspect_tar(path)


def test_required_contract_member_must_be_exact_regular_file(tmp_path: Path) -> None:
    expected = tmp_path / "NOTICE"
    expected.write_bytes(b"notice")
    inventory = verifier.ArchiveInventory(
        {"NOTICE": verifier.ArchiveMember("NOTICE", False, 0, None)}, {}
    )
    with pytest.raises(SystemExit, match="exact regular"):
        verifier._require_exact_file(inventory, "NOTICE", expected, "fixture")


def test_dist_requires_exact_names_and_no_extras(tmp_path: Path) -> None:
    (tmp_path / "evleda-0.2.0-py3-none-any.whl").write_bytes(b"wheel")
    (tmp_path / "evleda-0.2.0.tar.gz").write_bytes(b"sdist")
    root = Path(__file__).resolve().parents[1]
    verifier._distribution_paths(tmp_path, root)
    (tmp_path / "unexpected.txt").write_bytes(b"extra")
    with pytest.raises(SystemExit, match="no extras"):
        verifier._distribution_paths(tmp_path, root)


def test_validator_never_calls_archive_extraction(tmp_path: Path) -> None:
    payload = _regular_zip(("safe.txt", b"safe"))
    tar_path = tmp_path / "safe.tar.gz"
    _write_tar(tar_path, [("pkg/safe.txt", b"safe", tarfile.REGTYPE, "")])
    with (
        mock.patch.object(zipfile.ZipFile, "extract", side_effect=AssertionError),
        mock.patch.object(zipfile.ZipFile, "extractall", side_effect=AssertionError),
        mock.patch.object(tarfile.TarFile, "extract", side_effect=AssertionError),
        mock.patch.object(tarfile.TarFile, "extractall", side_effect=AssertionError),
    ):
        verifier._inspect_zip_bytes(payload, "safe.zip")
        _inspect_tar(tar_path)

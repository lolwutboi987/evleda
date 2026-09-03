"""Adversarial ZIP fixtures for public release-asset verification."""

from __future__ import annotations

import hashlib
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import verify_release_assets as release


class ReleaseZipSafetyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "candidate.zip"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def assert_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            release.verify_zip(self.path)

    def _write_placeholder_archive(self, count: int) -> None:
        with zipfile.ZipFile(self.path, "w") as archive:
            for index in range(count):
                archive.writestr(f"placeholder-{index}.txt", b"x")

    @staticmethod
    def _json(value: object) -> bytes:
        return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()

    def _write_cam_contract(self, *, receipt_candidate_sha256: str = "1" * 64) -> None:
        receipt = self._json(
            {
                "schema_version": 3,
                "receipt_kind": "non-release-kicad-cam-candidate",
                "manufacturing_release_eligible": False,
                "candidate_sha256": receipt_candidate_sha256,
                "receipt_sha256": "2" * 64,
                "non_fabrication_notice_filename": release.CAM_NOTICE,
                "non_fabrication_notice_sha256": release.EXPECTED_CAM_NOTICE_SHA256,
            }
        )
        files = {
            release.CAM_NOTICE: release.EXPECTED_CAM_NOTICE,
            release.CAM_RECEIPT: receipt,
        }
        root = Path(__file__).resolve().parents[2]
        for archive_name in release.EXPECTED_LEGAL_ASSETS:
            files[archive_name] = root.joinpath(
                "evleda", *archive_name.split("/")
            ).read_bytes()
        inventory = [
            {
                "filename": name,
                "media_type": (
                    release.EXPECTED_LEGAL_ASSETS[name]["media_type"]
                    if name in release.EXPECTED_LEGAL_ASSETS
                    else "text/plain"
                    if name == release.CAM_NOTICE
                    else "application/json"
                ),
                "byte_length": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
            for name, payload in sorted(files.items())
        ]
        file_manifest = self._json(
            {
                "schema_version": 1,
                "kind": "flux-clone-manufacturing-candidate-files",
                "manufacturing_release_eligible": False,
                "candidate_sha256": "1" * 64,
                "candidate_receipt_sha256": "2" * 64,
                "non_fabrication_notice": {
                    "filename": release.CAM_NOTICE,
                    "media_type": "text/plain",
                    "byte_length": len(release.EXPECTED_CAM_NOTICE),
                    "sha256": release.EXPECTED_CAM_NOTICE_SHA256,
                },
                "files": inventory,
            }
        )
        with zipfile.ZipFile(self.path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, payload in files.items():
                archive.writestr(name, payload)
            archive.writestr(release.CAM_FILE_MANIFEST, file_manifest)

    def test_rejects_traversal_and_windows_paths(self) -> None:
        for name in ("../escape.txt", "C:drive.txt"):
            with self.subTest(name=name):
                with zipfile.ZipFile(self.path, "w") as archive:
                    archive.writestr(name, b"unsafe")
                self.assert_rejected()

    def test_rejects_duplicate_and_case_colliding_paths(self) -> None:
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("README.md", b"one")
            archive.writestr("readme.md", b"two")
        self.assert_rejected()

    def test_rejects_symbolic_link_members(self) -> None:
        member = zipfile.ZipInfo("link")
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr(member, b"target")
        self.assert_rejected()

    def test_rejects_a_suspicious_compression_ratio(self) -> None:
        with zipfile.ZipFile(self.path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("zeros.bin", b"0" * (2 * 1024 * 1024))
        self.assert_rejected()

    def test_rejects_malformed_zip_as_fail_closed_error(self) -> None:
        self.path.write_bytes(b"this is not a zip")
        self.assert_rejected()

    def test_rejects_encryption_metadata_before_opening_a_member(self) -> None:
        info = zipfile.ZipInfo("secret.txt")
        info.file_size = 1
        info.compress_size = 1
        info.flag_bits = 0x1
        info.header_offset = 0
        archive = _MetadataOnlyArchive([info])
        self._write_placeholder_archive(1)
        with mock.patch.object(release.zipfile, "ZipFile", return_value=archive):
            self.assert_rejected()
        self.assertFalse(archive.member_opened)

    def test_rejects_oversized_metadata_before_opening_a_member(self) -> None:
        info = zipfile.ZipInfo("huge.bin")
        info.file_size = release.MAX_MEMBER_SIZE + 1
        info.compress_size = release.MAX_MEMBER_SIZE + 1
        info.header_offset = 0
        archive = _MetadataOnlyArchive([info])
        self._write_placeholder_archive(1)
        with mock.patch.object(release.zipfile, "ZipFile", return_value=archive):
            self.assert_rejected()
        self.assertFalse(archive.member_opened)

    def test_rejects_member_count_before_opening_a_member(self) -> None:
        members = [
            zipfile.ZipInfo(f"member-{index}.txt")
            for index in range(release.MAX_MEMBERS + 1)
        ]
        archive = _MetadataOnlyArchive(members)
        self._write_placeholder_archive(release.MAX_MEMBERS + 1)
        with mock.patch.object(
            release.zipfile, "ZipFile", return_value=archive
        ) as zip_constructor:
            self.assert_rejected()
        zip_constructor.assert_not_called()
        self.assertFalse(archive.member_opened)

    def test_rejects_aggregate_size_before_opening_a_member(self) -> None:
        members = []
        for index in range(release.MAX_TOTAL_SIZE // release.MAX_MEMBER_SIZE + 1):
            info = zipfile.ZipInfo(f"part-{index}.bin")
            info.file_size = release.MAX_MEMBER_SIZE
            info.compress_size = release.MAX_MEMBER_SIZE
            info.header_offset = index
            members.append(info)
        archive = _MetadataOnlyArchive(members)
        self._write_placeholder_archive(len(members))
        with mock.patch.object(release.zipfile, "ZipFile", return_value=archive):
            self.assert_rejected()
        self.assertFalse(archive.member_opened)

    def test_corrupt_member_crc_is_normalized_to_rejection(self) -> None:
        info = zipfile.ZipInfo("corrupt.txt")
        info.file_size = 1
        info.compress_size = 1
        info.header_offset = 0
        archive = _MetadataOnlyArchive([info], open_error=zipfile.BadZipFile("bad CRC"))
        self._write_placeholder_archive(1)
        with mock.patch.object(release.zipfile, "ZipFile", return_value=archive):
            self.assert_rejected()
        self.assertTrue(archive.member_opened)

    def test_cam_contract_binds_top_level_notice_and_receipt(self) -> None:
        self._write_cam_contract()
        release.verify_zip(self.path)
        release.verify_cam_contract(self.path)

    def test_cam_contract_rejects_receipt_identity_drift(self) -> None:
        self._write_cam_contract(receipt_candidate_sha256="3" * 64)
        release.verify_zip(self.path)
        with self.assertRaises(SystemExit):
            release.verify_cam_contract(self.path)


class _MetadataOnlyArchive:
    """Minimal archive double proving metadata gates precede member reads."""

    def __init__(
        self, members: list[zipfile.ZipInfo], *, open_error: Exception | None = None
    ) -> None:
        self.members = members
        self.open_error = open_error or AssertionError("member opened before metadata rejection")
        self.member_opened = False

    def __enter__(self) -> _MetadataOnlyArchive:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def infolist(self) -> list[zipfile.ZipInfo]:
        return self.members

    def open(self, *_args: object, **_kwargs: object) -> object:
        self.member_opened = True
        raise self.open_error


class ReleaseDeclarationSafetyTest(unittest.TestCase):
    def valid(self) -> dict[str, object]:
        return {
            "filename": "preview.png",
            "kind": "review-preview",
            "byte_length": 1,
            "sha256": "0" * 64,
        }

    def assert_rejected(self, asset: object) -> None:
        with self.assertRaises(SystemExit):
            release.validate_asset_declaration(asset)

    def test_byte_length_is_an_exact_bounded_integer(self) -> None:
        for value in (True, 0, -1, release.MAX_RELEASE_ASSET_SIZE + 1, "1"):
            with self.subTest(value=value):
                asset = self.valid()
                asset["byte_length"] = value
                self.assert_rejected(asset)

    def test_sha256_must_be_exact_lowercase_hex(self) -> None:
        for value in ("A" * 64, "0" * 63, "g" * 64, 0):
            with self.subTest(value=value):
                asset = self.valid()
                asset["sha256"] = value
                self.assert_rejected(asset)


if __name__ == "__main__":
    unittest.main()

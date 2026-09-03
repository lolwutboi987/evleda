"""Adversarial tests for the installed, generated reference resource."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import tempfile
import unittest
import warnings
import zipfile
from collections.abc import Mapping
from io import BytesIO
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from backend.kicad_project import ProjectAuxiliaryFile
from backend.kicad_worker import CompletedCommand, ManagedKiCadBundle
from backend.mcp_server.reference_host import (
    ExactReferenceBundleResolver,
    ReferenceHostConfigurationError,
    ReferenceHostSettings,
    build_reference_host,
)
from backend.mcp_server.server import MCPStdioServer
from evleda.reference import (
    PACKAGED_REFERENCE_MANIFEST_SHA256,
    PackagedReferenceError,
    load_packaged_reference,
    validate_packaged_reference_payloads,
)

_STEM = "reference_usb_c_3v3_r2"
_PROJECT_ID = "reference-usb-c-3v3-r2"
_REVISION = "rev_" + "1" * 64
_NOTICE = b"""EVLEDA PACKAGED REFERENCE - NOT FOR FABRICATION

This generated USB-C to 3.3 V board is shipped only for immutable inspection
and optional native KiCad ERC/DRC verification. It is not a manufacturing
release. Human design review, manufacturing capability review, assembler
approval, and release approval are not recorded. Do not send this package to a
fabricator or assembler.
"""


class _ZeroFindingRunner:
    def run(
        self,
        argv: tuple[str, ...],
        *,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: int,
        max_stdout_bytes: int,
        max_stderr_bytes: int,
    ) -> CompletedCommand:
        del cwd, environment, timeout_seconds, max_stdout_bytes, max_stderr_bytes
        if argv[1:] == ("version",):
            return CompletedCommand(argv, 0, b"10.0.6\n", b"")
        check = "erc" if argv[1:3] == ("sch", "erc") else "drc"
        report: dict[str, object] = {
            "$schema": f"https://schemas.kicad.org/{check}.v1.json",
            "coordinate_units": "mm",
            "date": "2026-09-02T00:00:00",
            "ignored_checks": [],
            "included_severities": ["error", "warning", "exclusion"],
            "kicad_version": "10.0.6",
            "source": Path(argv[-1]).name,
        }
        if check == "erc":
            report["sheets"] = []
        else:
            report.update(
                {"schematic_parity": [], "unconnected_items": [], "violations": []}
            )
        Path(argv[argv.index("--output") + 1]).write_text(
            json.dumps(report, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        return CompletedCommand(argv, 0, b"", b"")


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"
    ).encode("ascii")


def _zip(
    entries: list[tuple[str, bytes, int]],
    *,
    compression: int = zipfile.ZIP_STORED,
) -> bytes:
    output = BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w", allowZip64=False) as archive:
            for name, payload, mode in entries:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = compression
                info.create_system = 3
                info.external_attr = mode << 16
                archive.writestr(info, payload, compress_type=compression)
    return output.getvalue()


def _fixture(
    *,
    extra_manifest: list[tuple[str, bytes, str, str]] | None = None,
    extra_archive: list[tuple[str, bytes, int]] | None = None,
    mode_overrides: dict[str, int] | None = None,
    compression: int = zipfile.ZIP_STORED,
) -> tuple[dict[str, object], bytes, bytes]:
    primary: list[tuple[str, bytes, str, str]] = [
        ("NOT_FOR_FABRICATION.txt", _NOTICE, "notice", "text/plain"),
        (f"{_STEM}.kicad_pcb", b"(kicad_pcb)", "board", "application/x-kicad-pcb"),
        (f"{_STEM}.kicad_pro", b"{}", "project", "application/json"),
        (
            f"{_STEM}.kicad_sch",
            b"(kicad_sch)",
            "schematic",
            "application/x-kicad-schematic",
        ),
    ]
    declared = [*primary, *(extra_manifest or [])]
    declared.sort(key=lambda item: (item[0].casefold(), item[0]))
    by_role = {item[2]: item for item in primary}
    auxiliary = tuple(
        ProjectAuxiliaryFile(path, media_type, payload)
        for path, payload, role, media_type in declared
        if role == "auxiliary"
    )
    managed = ManagedKiCadBundle.create(
        project_id=_PROJECT_ID,
        project_revision=_REVISION,
        stem=_STEM,
        project_payload=by_role["project"][1],
        schematic_payload=by_role["schematic"][1],
        board_payload=by_role["board"][1],
        auxiliary_files=auxiliary,
    )
    entries = [
        (
            path,
            payload,
            (mode_overrides or {}).get(path, stat.S_IFREG | 0o644),
        )
        for path, payload, _role, _media_type in declared
    ]
    entries.extend(extra_archive or [])
    archive = _zip(entries, compression=compression)
    manifest: dict[str, object] = {
        "archive": {
            "filename": "reference_usb_c_3v3_r2.zip",
            "sha256": hashlib.sha256(archive).hexdigest(),
            "size_bytes": len(archive),
        },
        "files": [
            {
                "media_type": media_type,
                "path": path,
                "role": role,
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size_bytes": len(payload),
            }
            for path, payload, role, media_type in declared
        ],
        "reference": {
            "authority": "immutable-inspection-and-native-verification-only",
            "component_count": 3,
            "graph_sha256": "2" * 64,
            "managed_bundle_sha256": managed.bundle_sha256,
            "manufacturing_release": False,
            "net_count": 2,
            "operation_count": 1,
            "private_source_blobs_included": False,
            "project_id": _PROJECT_ID,
            "project_revision": _REVISION,
            "project_stem": _STEM,
            "source_rebuild": "explicit-private-evidence-opt-in-only",
        },
        "schema_version": 1,
    }
    return manifest, _canonical_json(manifest), archive


def _validate(manifest: dict[str, object], archive: bytes) -> None:
    archive_record = cast(dict[str, object], manifest["archive"])
    archive_record["sha256"] = hashlib.sha256(archive).hexdigest()
    archive_record["size_bytes"] = len(archive)
    manifest_payload = _canonical_json(manifest)
    validate_packaged_reference_payloads(
        manifest_payload,
        archive,
        expected_manifest_sha256=hashlib.sha256(manifest_payload).hexdigest(),
    )


class PackagedReferenceTests(unittest.TestCase):
    @staticmethod
    def _request(server: MCPStdioServer, message: dict[str, Any]) -> dict[str, Any]:
        response = server.handle_line(
            (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        )
        if not isinstance(response, bytes):
            raise AssertionError("request did not produce a response")
        return cast(dict[str, Any], json.loads(response))

    def test_production_resource_is_code_pinned_non_release_and_inspectable(self) -> None:
        reference = load_packaged_reference()
        self.assertEqual(reference.manifest_sha256, PACKAGED_REFERENCE_MANIFEST_SHA256)
        self.assertEqual(reference.bundle.project_id, _PROJECT_ID)
        self.assertEqual(
            reference.bundle.project_revision,
            "rev_209cc052da07cc27cf79c367547cff5b414b28d30972ca9985e3bed5a4722edd",
        )
        self.assertFalse(reference.manufacturing_release)
        self.assertEqual(len(reference.bundle.all_files), 29)
        self.assertTrue(
            all(
                not item.relative_name.casefold().endswith((".pdf", ".html", ".htm"))
                for item in reference.bundle.all_files
            )
        )

        with tempfile.TemporaryDirectory() as raw:
            state_root = Path(raw) / "unused"
            with patch(
                "backend.mcp_server.reference_host.build_reference_artifact_set",
                side_effect=AssertionError("source rebuild must not run"),
            ):
                runtime = build_reference_host(ReferenceHostSettings(state_root))
            self.assertFalse(state_root.exists())
            initialized = self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {},
                        "clientInfo": {"name": "packaged-test", "version": "1"},
                    },
                },
            )
            self.assertEqual(initialized["result"]["protocolVersion"], "2025-11-25")
            self.assertIsNone(
                runtime.server.handle_line(
                    b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'
                )
            )
            listing = self._request(
                runtime.server,
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            )
            self.assertEqual(
                [item["name"] for item in listing["result"]["tools"]],
                ["inspect_project"],
            )
            inspected = self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "inspect_project",
                        "arguments": {
                            "project_id": runtime.project_id,
                            "expected_project_revision": runtime.project_revision,
                        },
                    },
                },
            )
            payload = json.loads(inspected["result"]["structuredContent"]["payload_json"])
            self.assertEqual(payload["snapshot"]["component_count"], 23)
            self.assertEqual(payload["snapshot"]["net_count"], 13)
            self.assertEqual(payload["snapshot"]["operation_count"], 163)

    def test_source_rebuild_requires_an_exact_explicit_opt_in(self) -> None:
        with self.assertRaisesRegex(ReferenceHostConfigurationError, "explicit_opt_in"):
            ExactReferenceBundleResolver.rebuild_from_private_source_evidence(
                explicit_opt_in=False
            )

    def test_packaged_bundle_is_the_subject_of_native_verification(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            temporary = Path(raw)
            executable = temporary / "kicad-cli.exe"
            executable.write_bytes(b"test-pinned-kicad")
            runtime = build_reference_host(
                ReferenceHostSettings(
                    temporary / "state",
                    kicad_executable=executable,
                    kicad_executable_sha256=hashlib.sha256(
                        executable.read_bytes()
                    ).hexdigest(),
                    kicad_version="10.0.6",
                ),
                runner=_ZeroFindingRunner(),
            )
            self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {},
                        "clientInfo": {"name": "packaged-verify", "version": "1"},
                    },
                },
            )
            runtime.server.handle_line(
                b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'
            )
            tools = self._request(
                runtime.server,
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            )
            self.assertEqual(
                [item["name"] for item in tools["result"]["tools"]],
                ["inspect_project", "kicad_verify"],
            )
            response = self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "kicad_verify",
                        "arguments": {
                            "project_id": runtime.project_id,
                            "expected_project_revision": runtime.project_revision,
                            "checks": ["drc", "erc"],
                        },
                        "_meta": {
                            "com.fluxclone/idempotencyKey": "packaged-native-verify-1"
                        },
                    },
                },
            )
            self.assertFalse(response["result"]["isError"])
            self.assertTrue(response["result"]["structuredContent"]["payload"]["passed"])
            self.assertEqual(
                response["result"]["structuredContent"]["evidence"][
                    "opened_bundle_sha256"
                ],
                runtime.resolver.bundle.bundle_sha256,
            )

    def test_live_kicad_verifies_the_packaged_bundle_when_installed(self) -> None:
        try:
            from backend.mcp_server.distribution import resolve_kicad_installation
        except ModuleNotFoundError:
            self.skipTest("KiCad discovery module is unavailable")
        explicit: Path | None = None
        configured = os.environ.get("EVLEDA_TEST_KICAD_CLI")
        local_app_data = os.environ.get("LOCALAPPDATA")
        candidates = (
            *((Path(configured),) if configured else ()),
            *(
                (
                    Path(local_app_data)
                    / "Programs"
                    / "KiCad"
                    / "10.0"
                    / "bin"
                    / "kicad-cli.exe",
                )
                if local_app_data
                else ()
            ),
        )
        explicit = next((candidate for candidate in candidates if candidate.is_file()), None)
        installation = resolve_kicad_installation(explicit)
        if installation is None:
            self.skipTest("KiCad 10 CLI is unavailable")
        with tempfile.TemporaryDirectory() as raw:
            runtime = build_reference_host(
                ReferenceHostSettings(
                    Path(raw) / "state",
                    kicad_executable=installation.executable,
                    kicad_executable_sha256=installation.sha256,
                    kicad_version=installation.version,
                )
            )
            self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {},
                        "clientInfo": {"name": "packaged-live-kicad", "version": "1"},
                    },
                },
            )
            runtime.server.handle_line(
                b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'
            )
            response = self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "kicad_verify",
                        "arguments": {
                            "project_id": runtime.project_id,
                            "expected_project_revision": runtime.project_revision,
                            "checks": ["drc", "erc"],
                        },
                        "_meta": {
                            "com.fluxclone/idempotencyKey": "packaged-live-kicad-verify-1"
                        },
                    },
                },
            )["result"]
            self.assertFalse(response["isError"])
            self.assertTrue(response["structuredContent"]["payload"]["passed"])
            self.assertEqual(response["structuredContent"]["payload"]["blocking_findings"], 0)
            self.assertEqual(
                response["structuredContent"]["evidence"]["opened_bundle_sha256"],
                runtime.resolver.bundle.bundle_sha256,
            )

    def test_manifest_and_archive_tampering_fail_before_admission(self) -> None:
        reference_bytes: dict[str, bytes] = {}

        def reader(name: str) -> bytes:
            from importlib import resources

            payload = resources.files("evleda.reference").joinpath(name).read_bytes()
            reference_bytes[name] = payload
            return payload

        load_packaged_reference(resource_reader=reader)
        manifest = bytearray(reference_bytes["manifest.json"])
        manifest[-2] ^= 1
        with self.assertRaisesRegex(PackagedReferenceError, "code-pinned SHA-256"):
            load_packaged_reference(
                resource_reader=lambda name: bytes(manifest)
                if name == "manifest.json"
                else reference_bytes[name]
            )
        archive = bytearray(reference_bytes["reference_usb_c_3v3_r2.zip"])
        archive[len(archive) // 2] ^= 1
        with self.assertRaisesRegex(PackagedReferenceError, "manifest SHA-256"):
            load_packaged_reference(
                resource_reader=lambda name: reference_bytes["manifest.json"]
                if name == "manifest.json"
                else bytes(archive)
            )

    def test_rejects_nonportable_archive_paths(self) -> None:
        for path in (
            "../escape.kicad_mod",
            "folder/../../escape.kicad_mod",
            "/absolute.kicad_mod",
            "C:/drive.kicad_mod",
            "//server/share.kicad_mod",
        ):
            with self.subTest(path=path):
                manifest, _payload, archive = _fixture(
                    extra_archive=[(path, b"x", stat.S_IFREG | 0o644)]
                )
                with self.assertRaisesRegex(PackagedReferenceError, "path"):
                    _validate(manifest, archive)

        manifest, _payload, archive = _fixture(
            extra_archive=[("folder/escape.kicad_mod", b"x", stat.S_IFREG | 0o644)]
        )
        # ZipInfo normalizes backslashes while writing on Windows, so mutate the
        # same-length local and central names to model a hostile foreign ZIP.
        hostile = archive.replace(b"folder/escape.kicad_mod", b"folder\\escape.kicad_mod")
        self.assertNotEqual(hostile, archive)
        with self.assertRaisesRegex(PackagedReferenceError, "path"):
            _validate(manifest, hostile)

    def test_rejects_duplicate_and_case_colliding_members(self) -> None:
        cases = (
            [
                (f"{_STEM}.kicad_pcb", b"duplicate", stat.S_IFREG | 0o644),
            ],
            [
                (f"{_STEM.upper()}.KICAD_PCB", b"collision", stat.S_IFREG | 0o644),
            ],
        )
        for extra in cases:
            with self.subTest(member=extra[0][0], mode=extra[0][2]):
                manifest, _payload, archive = _fixture(extra_archive=extra)
                with self.assertRaises(PackagedReferenceError):
                    _validate(manifest, archive)

    def test_rejects_manifested_symlink_and_special_members(self) -> None:
        auxiliary = [
            ("fp-lib-table", b"payload", "auxiliary", "application/x-kicad-library-table")
        ]
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFCHR | 0o600):
            with self.subTest(mode=mode):
                manifest, _payload, archive = _fixture(
                    extra_manifest=auxiliary,
                    mode_overrides={"fp-lib-table": mode},
                )
                with self.assertRaisesRegex(PackagedReferenceError, "symlink or special"):
                    _validate(manifest, archive)

    def test_rejects_encrypted_flag_crc_corruption_and_compression_bomb(self) -> None:
        manifest, _payload, archive = _fixture()
        encrypted = bytearray(archive)
        local = encrypted.find(b"PK\x03\x04")
        central = encrypted.find(b"PK\x01\x02")
        self.assertGreaterEqual(local, 0)
        self.assertGreaterEqual(central, 0)
        encrypted[local + 6] |= 0x01
        encrypted[central + 8] |= 0x01
        with self.assertRaisesRegex(PackagedReferenceError, "encrypted"):
            _validate(manifest, bytes(encrypted))

        manifest, _payload, archive = _fixture()
        corrupt = bytearray(archive)
        local = corrupt.find(b"PK\x03\x04")
        name_length = int.from_bytes(corrupt[local + 26 : local + 28], "little")
        extra_length = int.from_bytes(corrupt[local + 28 : local + 30], "little")
        data_offset = local + 30 + name_length + extra_length
        corrupt[data_offset] ^= 0x01
        with self.assertRaisesRegex(PackagedReferenceError, "CRC"):
            _validate(manifest, bytes(corrupt))

        bomb_body = b"A" * 500_000
        manifest, _payload, archive = _fixture(
            extra_manifest=[
                ("fp-lib-table", bomb_body, "auxiliary", "application/x-kicad-library-table")
            ],
            compression=zipfile.ZIP_DEFLATED,
        )
        with self.assertRaisesRegex(PackagedReferenceError, "compression-ratio"):
            _validate(manifest, archive)

    def test_rejects_metadata_count_before_zipfile_builds_an_index(self) -> None:
        extras = [
            (f"extra-{index}.bin", b"x", stat.S_IFREG | 0o644)
            for index in range(65)
        ]
        manifest, _payload, archive = _fixture(extra_archive=extras)
        with (
            patch(
                "evleda.reference.runtime.zipfile.ZipFile",
                side_effect=AssertionError("ZipFile index must not be built"),
            ),
            self.assertRaisesRegex(PackagedReferenceError, "central-directory bounds"),
        ):
            _validate(manifest, archive)

    def test_rejects_unmanifested_missing_digest_and_case_colliding_manifest_files(self) -> None:
        manifest, _payload, archive = _fixture(
            extra_archive=[("fp-lib-table", b"x", stat.S_IFREG | 0o644)]
        )
        with self.assertRaisesRegex(PackagedReferenceError, "unmanifested"):
            _validate(manifest, archive)

        manifest, _payload, archive = _fixture()
        files = cast(list[dict[str, object]], manifest["files"])
        files[0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(PackagedReferenceError, "SHA-256"):
            _validate(manifest, archive)

        manifest, _payload, archive = _fixture()
        first = cast(dict[str, object], cast(list[object], manifest["files"])[0])
        duplicate = dict(first)
        duplicate["path"] = cast(str, first["path"]).upper()
        cast(list[object], manifest["files"]).append(duplicate)
        with self.assertRaisesRegex(PackagedReferenceError, "case-insensitively"):
            _validate(manifest, archive)


if __name__ == "__main__":
    unittest.main()

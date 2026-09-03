"""Integration and hardening tests for the local reference MCP host."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from collections.abc import Mapping
from contextlib import redirect_stderr
from dataclasses import replace
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any, cast

import pytest

from backend.kicad_compile import CompilationParityError
from backend.kicad_project import ProjectBundleInput
from backend.kicad_worker import (
    BundleResolutionError,
    CompletedCommand,
)
from backend.mcp_server.reference_host import (
    ExactReferenceArtifactPublisher,
    ExactReferenceBundleResolver,
    ReferenceArtifactPublicationError,
    ReferenceHostConfigurationError,
    ReferenceHostSettings,
    build_reference_host,
    load_or_create_local_journal_key,
    main,
)
from backend.mcp_server.server import MCPStdioServer
from backend.reference_design import ReferenceArtifactSet, build_reference_artifact_set
from tests.kicad_cli import discover_kicad_cli

_LIVE_KICAD = discover_kicad_cli()
_LIVE_KICAD_SHA256 = "393525236969434e24bc710334efe244fb285ef6596a1aea8e74353ef4db5477"


class VersionRunner:
    """Closed fake for version probing and zero-finding native JSON reports."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

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
        self.calls.append(argv)
        if argv[1:] != ("version",):
            check = "erc" if argv[1:3] == ("sch", "erc") else "drc"
            source = Path(argv[-1]).name
            report: dict[str, object] = {
                "$schema": f"https://schemas.kicad.org/{check}.v1.json",
                "coordinate_units": "mm",
                "date": "2026-08-31T12:00:00",
                "ignored_checks": [],
                "included_severities": ["error", "warning", "exclusion"],
                "kicad_version": "10.0.6",
                "source": source,
            }
            if check == "erc":
                report["sheets"] = []
            else:
                report.update(
                    {
                        "schematic_parity": [],
                        "unconnected_items": [],
                        "violations": [],
                    }
                )
            report_path = Path(argv[argv.index("--output") + 1])
            report_path.write_text(
                json.dumps(report, separators=(",", ":"), sort_keys=True),
                encoding="utf-8",
            )
            return CompletedCommand(argv, 0, b"", b"")
        return CompletedCommand(argv, 0, b"10.0.6\n", b"")


@pytest.mark.restricted_evidence
class ReferenceHostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.artifact_set = build_reference_artifact_set()

    @staticmethod
    def _request(
        server: MCPStdioServer,
        message: dict[str, Any],
    ) -> dict[str, Any]:
        wire = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        response = server.handle_line(wire)
        if not isinstance(response, bytes):
            raise AssertionError("request did not produce a response")
        decoded = json.loads(response)
        if not isinstance(decoded, dict):
            raise AssertionError("response was not an object")
        return cast(dict[str, Any], decoded)

    @classmethod
    def _initialize(cls, server: MCPStdioServer) -> None:
        cls._request(
            server,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "reference-host-test", "version": "1"},
                },
            },
        )
        notification = server.handle_line(
            b'{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'
        )
        if notification is not None:
            raise AssertionError("initialization notification returned a response")

    @classmethod
    def _tool_names(cls, server: MCPStdioServer) -> list[str]:
        response = cls._request(
            server,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        result = cast(dict[str, Any], response["result"])
        tools = cast(list[dict[str, Any]], result["tools"])
        return [str(tool["name"]) for tool in tools]

    @staticmethod
    def _configured_settings(root: Path) -> ReferenceHostSettings:
        executable = root.parent / "kicad-cli.exe"
        executable.write_bytes(b"pinned-test-kicad-cli")
        return ReferenceHostSettings(
            root,
            kicad_executable=executable,
            kicad_executable_sha256=hashlib.sha256(executable.read_bytes()).hexdigest(),
            kicad_version="10.0.6",
        )

    def test_inspect_only_host_is_side_effect_free_and_least_privilege(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            state_root = Path(raw) / "unused-state"
            runtime = build_reference_host(
                ReferenceHostSettings(state_root),
                artifact_set=self.artifact_set,
            )
            self.assertFalse(state_root.exists())
            self._initialize(runtime.server)
            self.assertEqual(self._tool_names(runtime.server), ["inspect_project"])

            response = self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "create_agent_run", "arguments": {}},
                },
            )
            self.assertEqual(response["error"]["code"], -32602)

            inspect = self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 4,
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
            structured = inspect["result"]["structuredContent"]
            payload = json.loads(structured["payload_json"])
            self.assertEqual(
                payload["snapshot"]["project_revision"],
                runtime.project_revision,
            )

    def test_configured_host_exposes_only_verify_and_detects_key_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            state_root = Path(raw) / "state"
            settings = self._configured_settings(state_root)
            runner = VersionRunner()
            runtime = build_reference_host(
                settings,
                runner=runner,
                artifact_set=self.artifact_set,
            )
            self._initialize(runtime.server)
            self.assertEqual(
                self._tool_names(runtime.server),
                ["inspect_project", "kicad_verify"],
            )
            tools = self._request(
                runtime.server,
                {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {}},
            )["result"]["tools"]
            verify = next(tool for tool in tools if tool["name"] == "kicad_verify")
            self.assertEqual(
                set(verify["inputSchema"]["properties"]),
                {"project_id", "expected_project_revision", "checks"},
            )
            for rpc_id, hidden_name in enumerate(
                ("kicad_import", "kicad_export", "kicad_render"),
                start=10,
            ):
                hidden = self._request(
                    runtime.server,
                    {
                        "jsonrpc": "2.0",
                        "id": rpc_id,
                        "method": "tools/call",
                        "params": {"name": hidden_name, "arguments": {}},
                    },
                )
                self.assertEqual(hidden["error"]["code"], -32602)

            verification_request: dict[str, Any] = {
                "jsonrpc": "2.0",
                "id": 20,
                "method": "tools/call",
                "params": {
                    "name": "kicad_verify",
                    "arguments": {
                        "project_id": runtime.project_id,
                        "expected_project_revision": runtime.project_revision,
                        "checks": ["drc", "erc"],
                    },
                    "_meta": {"com.fluxclone/idempotencyKey": "reference-verify-1"},
                },
            }
            verification = self._request(runtime.server, verification_request)["result"]
            self.assertFalse(verification["isError"])
            self.assertTrue(verification["structuredContent"]["payload"]["passed"])
            self.assertEqual(
                verification["structuredContent"]["evidence"]["opened_bundle_sha256"],
                runtime.resolver.bundle.bundle_sha256,
            )
            self.assertEqual(len(runner.calls), 3)
            retry = self._request(runtime.server, verification_request)["result"]
            self.assertEqual(retry, verification)
            self.assertEqual(len(runner.calls), 3)
            invalid_order = cast(
                dict[str, Any],
                json.loads(json.dumps(verification_request)),
            )
            invalid_order["id"] = 21
            invalid_order["params"]["_meta"][
                "com.fluxclone/idempotencyKey"
            ] = "reference-verify-invalid-order"
            invalid_order["params"]["arguments"]["checks"] = ["erc", "drc"]
            rejected = self._request(runtime.server, invalid_order)["result"]
            self.assertTrue(rejected["isError"])
            self.assertEqual(
                rejected["structuredContent"]["error"]["code"],
                "invalid_request",
            )
            self.assertEqual(len(runner.calls), 3)

            key_path = state_root / "journal-hmac-v1.key"
            key_path.write_bytes(b"x" * 32)
            with self.assertRaisesRegex(
                ReferenceHostConfigurationError,
                "not bound to the active HMAC key",
            ):
                build_reference_host(
                    settings,
                    runner=VersionRunner(),
                    artifact_set=self.artifact_set,
                )

    def test_key_is_stable_redacted_and_never_replaced_for_an_existing_journal(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "state"
            first = load_or_create_local_journal_key(root)
            second = load_or_create_local_journal_key(root)
            self.assertEqual(first, second)
            self.assertNotIn(first.key.hex(), repr(first))
            journal = root / "kicad-worker-v1.sqlite3"
            journal.write_bytes(b"existing")
            first.path.unlink()
            with self.assertRaisesRegex(
                ReferenceHostConfigurationError,
                "HMAC key is missing",
            ):
                load_or_create_local_journal_key(root)

        checkout_state = Path(__file__).resolve().parents[2] / ".forbidden-reference-state"
        with self.assertRaisesRegex(
            ReferenceHostConfigurationError,
            "inside the source checkout",
        ):
            load_or_create_local_journal_key(checkout_state)
        self.assertFalse(checkout_state.exists())

    def test_exact_resolver_reparses_bytes_and_rejects_identity_drift(self) -> None:
        resolver = ExactReferenceBundleResolver(self.artifact_set)
        bundle = resolver.bundle
        self.assertIs(
            resolver.resolve_bundle(bundle.project_id, bundle.project_revision),
            bundle,
        )
        self.assertEqual(
            bundle.project_revision,
            "rev_" + self.artifact_set.result.revision_hash,
        )
        with self.assertRaises(BundleResolutionError):
            resolver.resolve_bundle("another-project", bundle.project_revision)

        original = self.artifact_set.compiled.bundle
        changed_bundle = ProjectBundleInput(
            stem=original.stem,
            project_payload=original.project_payload,
            schematic_payload=original.schematic_payload,
            board_payload=original.board_payload + b" ",
        )
        changed_compiled = replace(self.artifact_set.compiled, bundle=changed_bundle)
        changed_set = ReferenceArtifactSet(self.artifact_set.result, changed_compiled)
        with self.assertRaises(CompilationParityError):
            ExactReferenceBundleResolver(changed_set)

    def test_publisher_has_durable_exact_replay_conflict_and_tamper_checks(self) -> None:
        resolver = ExactReferenceBundleResolver(self.artifact_set)
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "published"
            first = ExactReferenceArtifactPublisher(
                root,
                project_id=resolver.bundle.project_id,
                project_revision=resolver.bundle.project_revision,
            )
            payload = b"deterministic-render-bytes"
            digest = hashlib.sha256(payload).hexdigest()
            published = first.publish_artifact(
                project_id=resolver.bundle.project_id,
                project_revision=resolver.bundle.project_revision,
                media_type="image/png",
                payload=payload,
                expected_sha256=digest,
                idempotency_key="publish-1",
            )
            restarted = ExactReferenceArtifactPublisher(
                root,
                project_id=resolver.bundle.project_id,
                project_revision=resolver.bundle.project_revision,
            )
            self.assertEqual(
                restarted.publish_artifact(
                    project_id=resolver.bundle.project_id,
                    project_revision=resolver.bundle.project_revision,
                    media_type="image/png",
                    payload=payload,
                    expected_sha256=digest,
                    idempotency_key="publish-1",
                ),
                published,
            )
            changed = b"different-render"
            with self.assertRaisesRegex(
                ReferenceArtifactPublicationError,
                "idempotency key",
            ):
                restarted.publish_artifact(
                    project_id=resolver.bundle.project_id,
                    project_revision=resolver.bundle.project_revision,
                    media_type="image/png",
                    payload=changed,
                    expected_sha256=hashlib.sha256(changed).hexdigest(),
                    idempotency_key="publish-1",
                )

            object_path = root / "objects" / digest[:2] / f"{digest}.blob"
            object_path.write_bytes(b"x" * len(payload))
            with self.assertRaisesRegex(
                ReferenceArtifactPublicationError,
                "content identity",
            ):
                restarted.publish_artifact(
                    project_id=resolver.bundle.project_id,
                    project_revision=resolver.bundle.project_revision,
                    media_type="image/png",
                    payload=payload,
                    expected_sha256=digest,
                    idempotency_key="publish-1",
                )

            database = sqlite3.connect(root / "publications-v1.sqlite3")
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    database.execute(
                        "UPDATE reference_publications SET size_bytes = size_bytes + 1"
                    )
            finally:
                database.close()

    def test_partial_pins_fail_before_state_and_module_entrypoint_handles_eof(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw) / "state"
            with self.assertRaisesRegex(
                ReferenceHostConfigurationError,
                "requires executable, SHA-256, and version together",
            ):
                ReferenceHostSettings(root, kicad_executable=Path(raw) / "kicad-cli.exe")
            self.assertFalse(root.exists())

            protocol_output = BytesIO()
            with (
                redirect_stderr(StringIO()) as error_output,
                self.assertRaises(SystemExit) as exited,
            ):
                main(
                    [
                        "--state-root",
                        str(root),
                        "--kicad-cli",
                        str(Path(raw) / "kicad-cli.exe"),
                    ],
                    input_stream=BytesIO(),
                    output_stream=protocol_output,
                )
            self.assertEqual(exited.exception.code, 2)
            self.assertIn("configuration error", error_output.getvalue())
            self.assertEqual(protocol_output.getvalue(), b"")

            output = BytesIO()
            self.assertEqual(
                main(
                    ["--state-root", str(root)],
                    input_stream=BytesIO(),
                    output_stream=output,
                ),
                0,
            )
            self.assertEqual(output.getvalue(), b"")
            self.assertFalse(root.exists())

    def test_real_mcp_to_kicad_reference_bundle_has_zero_findings(self) -> None:
        if (
            _LIVE_KICAD is None
            or hashlib.sha256(_LIVE_KICAD.read_bytes()).hexdigest()
            != _LIVE_KICAD_SHA256
        ):
            self.skipTest("pinned KiCad 10.0.6 executable is unavailable")
        assert _LIVE_KICAD is not None
        with tempfile.TemporaryDirectory() as raw:
            runtime = build_reference_host(
                ReferenceHostSettings(
                    Path(raw) / "state",
                    kicad_executable=_LIVE_KICAD,
                    kicad_executable_sha256=_LIVE_KICAD_SHA256,
                    kicad_version="10.0.6",
                ),
                artifact_set=self.artifact_set,
            )
            self._initialize(runtime.server)
            response = self._request(
                runtime.server,
                {
                    "jsonrpc": "2.0",
                    "id": 50,
                    "method": "tools/call",
                    "params": {
                        "name": "kicad_verify",
                        "arguments": {
                            "project_id": runtime.project_id,
                            "expected_project_revision": runtime.project_revision,
                            "checks": ["drc", "erc"],
                        },
                        "_meta": {
                            "com.fluxclone/idempotencyKey": "live-reference-zero-findings-1"
                        },
                    },
                },
            )["result"]

            self.assertFalse(response["isError"])
            self.assertTrue(response["structuredContent"]["payload"]["passed"])
            self.assertEqual(
                response["structuredContent"]["payload"]["blocking_findings"],
                0,
            )
            self.assertEqual(
                response["structuredContent"]["evidence"]["opened_bundle_sha256"],
                runtime.resolver.bundle.bundle_sha256,
            )
            self.assertIsNotNone(
                response["structuredContent"]["evidence"]["runtime_support_sha256"]
            )


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import unittest
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from backend.mcp_gateway import (
    ActorKind,
    ApprovalRequired,
    CapabilitySafeGateway,
    InMemoryKiCadAdapter,
    Invocation,
    Principal,
    ProfileName,
    stable_digest,
)
from backend.mcp_server import HostConfig, MCPStdioServer
from backend.mcp_server.hooks import (
    KICAD_HOOKS,
    KiCadExecutionEvidence,
    KiCadImportApproval,
    KiCadServiceFailure,
    KiCadServiceResult,
    kicad_import_subject_digest,
)
from backend.mcp_server.server import IDEMPOTENCY_META_KEY


class RecordingKiCadService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Mapping[str, Any], str]] = []
        self.fail_render = False
        self.malformed_result = False
        self.mismatched_evidence = False

    def _success(
        self,
        operation: str,
        arguments: Mapping[str, Any],
        invocation: Invocation,
    ) -> KiCadServiceResult:
        self.calls.append((operation, arguments, invocation.principal.actor_id))
        if self.malformed_result:
            return KiCadServiceResult(  # type: ignore[arg-type]
                "false", [], {"exit_code": 2}  # type: ignore[arg-type]
            )
        if operation == "import":
            payload = {
                "project_id": arguments["project_id"],
                "previous_project_revision": arguments["expected_project_revision"],
                "project_revision": f"rev_{stable_digest(arguments)}",
                "source_artifact_id": arguments["source_artifact_id"],
                "source_sha256": arguments["source_sha256"],
            }
        elif operation == "export":
            payload = {
                "project_id": arguments["project_id"],
                "project_revision": arguments["expected_project_revision"],
                "format": arguments["format"],
                "artifact_id": "artifact-export",
                "artifact_sha256": stable_digest(arguments),
            }
        elif operation == "render":
            payload = {
                "project_id": arguments["project_id"],
                "project_revision": arguments["expected_project_revision"],
                "view": arguments["view"],
                "format": arguments["format"],
                "artifact_id": "artifact-render",
                "artifact_sha256": stable_digest(arguments),
            }
        else:
            payload = {
                "project_id": arguments["project_id"],
                "project_revision": arguments["expected_project_revision"],
                "checks": arguments["checks"],
                "passed": True,
                "blocking_findings": 0,
                "findings_digest": stable_digest([]),
            }
            payload["report_digest"] = stable_digest(payload)
        return KiCadServiceResult(
            True,
            payload,
            KiCadExecutionEvidence(
                worker="recording-test-worker",
                kicad_version="9.0.4-test",
                operation=f"kicad_{operation}",
                project_id=arguments["project_id"],
                expected_project_revision=arguments["expected_project_revision"],
                opened_project_digest=(
                    arguments["expected_project_revision"][4:]
                    if arguments["expected_project_revision"] is not None
                    else None
                ),
                opened_bundle_sha256=("e" * 64 if operation == "verify" else None),
                runtime_support_sha256=("f" * 64 if operation == "verify" else None),
                request_digest=(
                    "0" * 64 if self.mismatched_evidence else stable_digest(arguments)
                ),
                payload_digest=stable_digest(payload),
                policy_digest="c" * 64,
                idempotency_key=invocation.idempotency_key,
                exit_code=0,
            ),
        )

    def import_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        return self._success("import", arguments, invocation)

    def export_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        return self._success("export", arguments, invocation)

    def verify_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        return self._success("verify", arguments, invocation)

    def render_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        if self.fail_render:
            raise KiCadServiceFailure(
                "kicad_render_failed",
                "KiCad renderer returned a non-zero exit status",
                {"exit_code": 2},
            )
        return self._success("render", arguments, invocation)


class RecordingImportApprovalVerifier:
    def __init__(self, approved_receipts: set[str] | None = None) -> None:
        self.approved_receipts = approved_receipts or {"receipt-import-1"}

    def authorize_import(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadImportApproval:
        receipt_id = arguments["approval_receipt_id"]
        if receipt_id not in self.approved_receipts:
            raise ApprovalRequired("import receipt is not approved")
        return KiCadImportApproval(
            receipt_id=receipt_id,
            receipt_digest="d" * 64,
            subject_digest=kicad_import_subject_digest(arguments),
            decided_by="release-user",
        )


class KiCadHookTests(unittest.TestCase):
    def setUp(self) -> None:
        adapter = InMemoryKiCadAdapter()
        self.adapter = adapter
        self.project_id = "project-hooks"
        self.revision = adapter.seed_project(self.project_id)
        self.gateway = CapabilitySafeGateway(adapter)
        self.service = RecordingKiCadService()
        self.approvals = RecordingImportApprovalVerifier()
        self.release = self.server(ProfileName.RELEASE_MANAGER, ActorKind.USER, "release-user")
        self.observer = self.server(ProfileName.OBSERVER, ActorKind.AGENT, "observer-agent")

    def server(
        self,
        profile: ProfileName,
        actor_kind: ActorKind,
        actor_id: str,
        *,
        service: RecordingKiCadService | None = None,
    ) -> MCPStdioServer:
        server = MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal(actor_id, actor_kind, profile),
                kicad_service=self.service if service is None else service,
                allowed_project_ids=frozenset({self.project_id}),
                import_approval_verifier=self.approvals,
                kicad_worker="recording-test-worker",
                kicad_version="9.0.4-test",
                kicad_policy_digest="c" * 64,
                durable_worker_idempotency=True,
            ),
        )
        initialize = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "hook-test", "version": "1"},
            },
        }
        self.assertIn("result", self.send(server, initialize))
        notification = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        }
        self.assertIsNone(server.handle_line(self.encode(notification)))
        return server

    @staticmethod
    def encode(message: Mapping[str, Any]) -> bytes:
        return json.dumps(message, separators=(",", ":")).encode() + b"\n"

    def send(self, server: MCPStdioServer, message: Mapping[str, Any]) -> dict[str, Any]:
        response = server.handle_line(self.encode(message))
        self.assertIsNotNone(response)
        return json.loads(response)

    def call(
        self,
        server: MCPStdioServer,
        rpc_id: int,
        name: str,
        arguments: Mapping[str, Any],
        key: str,
    ) -> dict[str, Any]:
        return self.send(
            server,
            {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments,
                    "_meta": {IDEMPOTENCY_META_KEY: key},
                },
            },
        )

    def test_configured_worker_exposes_all_four_hooks_and_relays_evidence(self) -> None:
        listing = self.send(
            self.release,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        )
        names = {tool["name"] for tool in listing["result"]["tools"]}
        self.assertTrue({hook.name for hook in KICAD_HOOKS}.issubset(names))

        calls = (
            (
                "kicad_import",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "source_artifact_id": "artifact-1",
                    "source_sha256": "a" * 64,
                    "approval_receipt_id": "receipt-import-1",
                },
            ),
            (
                "kicad_export",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "format": "kicad_archive",
                },
            ),
            (
                "kicad_render",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "view": "pcb_2d",
                    "format": "svg",
                },
            ),
            (
                "kicad_verify",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "checks": ["drc", "erc"],
                },
            ),
        )
        for offset, (name, arguments) in enumerate(calls, 10):
            result = self.call(self.release, offset, name, arguments, f"hook-{offset}")["result"]
            self.assertFalse(result["isError"])
            structured = result["structuredContent"]
            self.assertTrue(structured["succeeded"])
            self.assertEqual(structured["evidence"]["exit_code"], 0)
            self.assertEqual(len(structured["result_digest"]), 64)
        self.assertEqual([item[0] for item in self.service.calls], [
            "import", "export", "render", "verify"
        ])

    def test_schema_and_capability_checks_run_before_worker(self) -> None:
        invalid = self.call(
            self.release,
            20,
            "kicad_render",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "view": "invented-view",
                "format": "svg",
            },
            "invalid-render",
        )["result"]
        self.assertTrue(invalid["isError"])
        self.assertEqual(invalid["structuredContent"]["error"]["code"], "invalid_request")

        unsorted_checks = self.call(
            self.release,
            23,
            "kicad_verify",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "checks": ["erc", "drc"],
            },
            "invalid-check-order",
        )["result"]
        self.assertTrue(unsorted_checks["isError"])
        self.assertEqual(
            unsorted_checks["structuredContent"]["error"]["code"],
            "invalid_request",
        )
        self.assertEqual(self.service.calls, [])

        denied = self.call(
            self.observer,
            21,
            "kicad_export",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "format": "kicad_archive",
            },
            "denied-export",
        )["result"]
        self.assertTrue(denied["isError"])
        self.assertEqual(denied["structuredContent"]["error"]["code"], "capability_denied")

        release_agent = self.server(
            ProfileName.RELEASE_MANAGER,
            ActorKind.AGENT,
            "release-agent",
        )
        import_denied = self.call(
            release_agent,
            22,
            "kicad_import",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "source_artifact_id": "artifact-2",
                "source_sha256": "b" * 64,
                "approval_receipt_id": "receipt-import-2",
            },
            "agent-import",
        )["result"]
        self.assertTrue(import_denied["isError"])
        self.assertEqual(
            import_denied["structuredContent"]["error"]["code"],
            "capability_denied",
        )
        self.assertEqual(self.service.calls, [])

        fake_receipt = self.call(
            self.release,
            23,
            "kicad_import",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "source_artifact_id": "artifact-3",
                "source_sha256": "c" * 64,
                "approval_receipt_id": "approval-fake",
            },
            "fake-receipt",
        )["result"]
        self.assertTrue(fake_receipt["isError"])
        self.assertEqual(
            fake_receipt["structuredContent"]["error"]["code"],
            "approval_required",
        )
        self.assertEqual(self.service.calls, [])

    def test_hook_idempotency_and_worker_failure_are_not_fabricated_as_success(self) -> None:
        arguments = {
            "project_id": self.project_id,
            "expected_project_revision": self.revision,
            "checks": ["drc"],
        }
        first = self.call(self.release, 30, "kicad_verify", arguments, "verify-retry")
        second = self.call(self.release, 31, "kicad_verify", arguments, "verify-retry")
        self.assertEqual(first["result"], second["result"])
        self.assertEqual([item[0] for item in self.service.calls], ["verify"])

        self.service.fail_render = True
        failed = self.call(
            self.release,
            32,
            "kicad_render",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "view": "schematic",
                "format": "png",
            },
            "render-failure",
        )["result"]
        self.assertTrue(failed["isError"])
        error = failed["structuredContent"]["error"]
        self.assertEqual(error["code"], "kicad_render_failed")
        self.assertEqual(error["details"]["exit_code"], 2)

    def test_parallel_hook_retries_dispatch_to_worker_exactly_once(self) -> None:
        arguments = {
            "project_id": self.project_id,
            "expected_project_revision": self.revision,
            "checks": ["drc", "erc"],
        }
        with ThreadPoolExecutor(max_workers=16) as pool:
            responses = tuple(
                pool.map(
                    lambda rpc_id: self.call(
                        self.release,
                        rpc_id,
                        "kicad_verify",
                        arguments,
                        "parallel-verify",
                    ),
                    range(100, 132),
                )
            )
        first = responses[0]["result"]["structuredContent"]
        self.assertTrue(
            all(response["result"]["structuredContent"] == first for response in responses)
        )
        self.assertEqual([item[0] for item in self.service.calls], ["verify"])

    def test_malformed_or_unbound_worker_results_can_never_be_success(self) -> None:
        arguments = {
            "project_id": self.project_id,
            "expected_project_revision": self.revision,
            "view": "pcb_2d",
            "format": "svg",
        }
        self.service.malformed_result = True
        malformed = self.call(
            self.release, 200, "kicad_render", arguments, "malformed-worker"
        )["result"]
        self.assertTrue(malformed["isError"])
        self.assertEqual(
            malformed["structuredContent"]["error"]["code"], "invalid_request"
        )

        self.service.malformed_result = False
        self.service.mismatched_evidence = True
        mismatched = self.call(
            self.release, 201, "kicad_render", arguments, "mismatched-worker"
        )["result"]
        self.assertTrue(mismatched["isError"])
        self.assertEqual(
            mismatched["structuredContent"]["error"]["code"], "invalid_request"
        )

    def test_project_scope_is_fail_closed_before_worker_dispatch(self) -> None:
        denied = self.call(
            self.release,
            210,
            "kicad_render",
            {
                "project_id": "project-out-of-scope",
                "expected_project_revision": self.revision,
                "view": "pcb_2d",
                "format": "svg",
            },
            "wrong-project",
        )["result"]
        self.assertTrue(denied["isError"])
        self.assertEqual(
            denied["structuredContent"]["error"]["code"], "capability_denied"
        )
        self.assertEqual(self.service.calls, [])

    def test_hook_requires_the_gateway_current_revision_before_worker(self) -> None:
        stale = self.call(
            self.release,
            220,
            "kicad_export",
            {
                "project_id": self.project_id,
                "expected_project_revision": "rev_" + "f" * 64,
                "format": "kicad_archive",
            },
            "stale-export",
        )["result"]
        self.assertTrue(stale["isError"])
        self.assertEqual(
            stale["structuredContent"]["error"]["code"], "revision_conflict"
        )
        self.assertEqual(self.service.calls, [])

    def test_revision_preflight_is_fresh_across_distinct_hook_calls(self) -> None:
        arguments = {
            "project_id": self.project_id,
            "expected_project_revision": self.revision,
            "checks": ["drc"],
        }
        first = self.call(
            self.release, 230, "kicad_verify", arguments, "first-preflight"
        )["result"]
        self.assertFalse(first["isError"])

        # Simulate another coordinator committing between independent calls.
        self.adapter._projects[self.project_id].project_revision = "rev_" + "e" * 64
        stale = self.call(
            self.release, 231, "kicad_verify", arguments, "second-preflight"
        )["result"]
        self.assertTrue(stale["isError"])
        self.assertEqual(
            stale["structuredContent"]["error"]["code"], "revision_conflict"
        )
        self.assertEqual([item[0] for item in self.service.calls], ["verify"])

    def test_unconfigured_server_does_not_advertise_or_fake_hooks(self) -> None:
        server = MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal("plain", ActorKind.USER, ProfileName.RELEASE_MANAGER),
                allowed_project_ids=frozenset({self.project_id}),
            ),
        )
        initialize = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "plain-test", "version": "1"},
            },
        }
        self.send(server, initialize)
        server.handle_line(
            self.encode({"jsonrpc": "2.0", "method": "notifications/initialized"})
        )
        listing = self.send(
            server,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        )
        names = {tool["name"] for tool in listing["result"]["tools"]}
        self.assertTrue({hook.name for hook in KICAD_HOOKS}.isdisjoint(names))
        guessed = self.call(
            server,
            3,
            "kicad_verify",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "checks": ["drc"],
            },
            "guess-unconfigured",
        )
        self.assertEqual(guessed["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main()

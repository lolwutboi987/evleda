"""Black-box-ish stdio workflow tests for the MCP host boundary.

These tests intentionally use two separately configured server endpoints.  The
agent endpoint cannot turn itself into the human approver by choosing fields in
an MCP request; only the host-selected user endpoint can decide an approval.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
import unittest
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from backend.mcp_gateway import (
    ActorKind,
    CapabilitySafeGateway,
    InMemoryKiCadAdapter,
    Invocation,
    Principal,
    ProfileName,
    stable_digest,
)
from backend.mcp_server import HostConfig, MCPStdioServer, serve_stdio
from backend.mcp_server.hooks import KiCadExecutionEvidence, KiCadServiceResult
from backend.mcp_server.server import IDEMPOTENCY_META_KEY

NOW = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
POLICY_DIGEST = "c" * 64
DATASHEET_DIGEST = "a" * 64
PIN_MAP_DIGEST = "b" * 64


class EvidenceBoundKiCadVerifier:
    """Test worker that returns evidence bound to the exact stdio invocation."""

    def __init__(self) -> None:
        self.calls: list[Mapping[str, Any]] = []

    def verify_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        self.calls.append(arguments)
        payload: dict[str, Any] = {
            "project_id": arguments["project_id"],
            "project_revision": arguments["expected_project_revision"],
            "checks": arguments["checks"],
            "passed": True,
            "blocking_findings": 0,
            "findings_digest": stable_digest([]),
        }
        payload["report_digest"] = stable_digest(payload)
        revision = arguments["expected_project_revision"]
        return KiCadServiceResult(
            True,
            payload,
            KiCadExecutionEvidence(
                worker="e2e-test-worker",
                kicad_version="9.0.4-e2e",
                operation="kicad_verify",
                project_id=arguments["project_id"],
                expected_project_revision=revision,
                opened_project_digest=revision[4:],
                opened_bundle_sha256="e" * 64,
                runtime_support_sha256="f" * 64,
                request_digest=stable_digest(arguments),
                payload_digest=stable_digest(payload),
                policy_digest=POLICY_DIGEST,
                idempotency_key=invocation.idempotency_key,
                exit_code=0,
            ),
        )

    def import_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        raise AssertionError("import is outside this verification-only E2E path")

    def export_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        raise AssertionError("export is outside this verification-only E2E path")

    def render_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        raise AssertionError("render is outside this verification-only E2E path")


class MCPStdioEndToEndTests(unittest.TestCase):
    """Exercise JSON-RPC framing and the dialogue-to-verification authority path."""

    def setUp(self) -> None:
        self.project_id = "dialogue-project"
        adapter = InMemoryKiCadAdapter()
        self.revision = adapter.seed_project(self.project_id)
        self.gateway = CapabilitySafeGateway(adapter, clock=lambda: NOW)
        self.worker = EvidenceBoundKiCadVerifier()
        self.agent = self._server("design-agent", ActorKind.AGENT, ProfileName.DESIGNER)
        self.human = self._server(
            "board-owner", ActorKind.USER, ProfileName.RELEASE_MANAGER
        )
        self._initialize(self.agent)
        self._initialize(self.human)

    def _server(
        self, actor_id: str, kind: ActorKind, profile: ProfileName
    ) -> MCPStdioServer:
        return MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal(actor_id, kind, profile),
                allowed_project_ids=frozenset({self.project_id}),
                kicad_service=self.worker,
                kicad_worker="e2e-test-worker",
                kicad_version="9.0.4-e2e",
                kicad_policy_digest=POLICY_DIGEST,
                durable_worker_idempotency=True,
                # No commit attestation verifier: the host must fail closed.
            ),
        )

    @staticmethod
    def _wire(message: Mapping[str, Any]) -> bytes:
        return json.dumps(message, separators=(",", ":"), allow_nan=False).encode() + b"\n"

    def _round_trip(
        self, server: MCPStdioServer, message: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        stdout = io.BytesIO()
        serve_stdio(server, io.BytesIO(self._wire(message)), stdout)
        lines = stdout.getvalue().splitlines()
        self.assertLessEqual(len(lines), 1)
        return json.loads(lines[0]) if lines else None

    def _initialize(self, server: MCPStdioServer) -> None:
        result = self._round_trip(
            server,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "e2e", "version": "1"},
                },
            },
        )
        assert result is not None
        self.assertEqual(result["result"]["protocolVersion"], "2025-11-25")
        self.assertIsNone(
            self._round_trip(
                server,
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
            )
        )

    def _call(
        self,
        server: MCPStdioServer,
        rpc_id: int,
        name: str,
        arguments: Mapping[str, Any],
        key: str,
    ) -> dict[str, Any]:
        response = self._round_trip(
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
        assert response is not None
        return response["result"]

    @staticmethod
    def _payload(result: Mapping[str, Any]) -> dict[str, Any]:
        assert result["isError"] is False
        return json.loads(result["structuredContent"]["payload_json"])

    def test_demo_process_uses_clean_newline_framing_and_advertises_closed_schemas(self) -> None:
        root = Path(__file__).resolve().parents[2]
        request = b"\n".join(
            (
                self._wire(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-11-25",
                            "capabilities": {},
                            "clientInfo": {"name": "subprocess", "version": "1"},
                        },
                    }
                ).rstrip(),
                self._wire({"jsonrpc": "2.0", "method": "notifications/initialized"}).rstrip(),
                self._wire({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).rstrip(),
            )
        ) + b"\n"
        completed = subprocess.run(
            [sys.executable, "-m", "backend.mcp_server.demo"],
            cwd=root,
            input=request,
            capture_output=True,
            timeout=15,
            check=True,
        )
        self.assertEqual(completed.stderr, b"")
        messages = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["result"]["protocolVersion"], "2025-11-25")
        tools = messages[1]["result"]["tools"]
        self.assertTrue(tools)
        for tool in tools:
            self.assertEqual(tool["inputSchema"].get("additionalProperties"), False)
            self.assertNotIn("path", tool["inputSchema"].get("properties", {}))

    def test_dialogue_question_exact_preview_approval_stage_native_and_kicad_verify(self) -> None:
        listing = self._round_trip(
            self.agent, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
        )
        assert listing is not None
        names = {tool["name"] for tool in listing["result"]["tools"]}
        self.assertIn("kicad_verify", names)

        inspection = {
            "project_id": self.project_id,
            "expected_project_revision": self.revision,
        }
        self.assertEqual(
            self._call(self.agent, 20, "inspect_project", inspection, "repeat-inspect"),
            self._call(self.agent, 21, "inspect_project", inspection, "repeat-inspect"),
        )

        created = self._payload(
            self._call(
                self.agent,
                3,
                "create_agent_run",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "objective": "Build a deterministic controller board",
                    "initial_questions": [
                        {
                            "prompt": "Which connector orientation is required?",
                            "rationale": "It determines enclosure fit.",
                            "blocking": True,
                            "options": ["north", "south"],
                        }
                    ],
                    "max_parallel_agents": None,
                    "token_budget": None,
                },
                "e2e-create",
            )
        )
        run = created["run"]
        question_id = created["questions"][0]["question_id"]
        self.assertEqual(run["state"], "clarifying")

        denied_answer = self._call(
            self.agent,
            4,
            "answer_question",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "run_id": run["run_id"],
                "expected_run_revision": run["run_revision"],
                "question_id": question_id,
                "answer": "north",
            },
            "agent-cannot-answer",
        )
        self.assertTrue(denied_answer["isError"])
        self.assertEqual(denied_answer["structuredContent"]["error"]["code"], "capability_denied")

        answered = self._payload(
            self._call(
                self.human,
                5,
                "answer_question",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "run_id": run["run_id"],
                    "expected_run_revision": run["run_revision"],
                    "question_id": question_id,
                    "answer": "north",
                },
                "human-answer",
            )
        )
        run = answered["run"]
        patch = {
            "patch_id": "patch-controller",
            "base_revision": self.revision,
            "rationale": "Add the approved controller.",
            "operations": [
                {
                    "operation_id": "add-u1",
                    "action": "add_component",
                    "target_id": "U1",
                    "parameters": [
                        {"name": "datasheet_sha256", "value": DATASHEET_DIGEST},
                        {"name": "footprint", "value": "Package_QFN:QFN-32"},
                        {"name": "manufacturer_part_number", "value": "STM32G031K8U6"},
                        {"name": "pin_map_sha256", "value": PIN_MAP_DIGEST},
                        {"name": "symbol", "value": "MCU_ST_STM32G0:STM32G031K8Ux"},
                    ],
                }
            ],
            "evidence_ids": [],
        }
        previewed = self._payload(
            self._call(
                self.agent,
                6,
                "preview_patch",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "run_id": run["run_id"],
                    "expected_run_revision": run["run_revision"],
                    "patch": patch,
                },
                "e2e-preview",
            )
        )
        self.assertEqual(previewed["preview"]["patch_digest"], stable_digest(patch))
        run = previewed["run"]

        self.assertTrue(
            self._call(
                self.agent,
                7,
                "decide_approval",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "run_id": run["run_id"],
                    "expected_run_revision": run["run_revision"],
                    "approval_id": previewed["approval"]["approval_id"],
                    "approve": True,
                    "reason": "Agent cannot provide human approval.",
                },
                "agent-cannot-approve",
            )["isError"]
        )

        stage_approval = self._payload(
            self._call(
                self.human,
                8,
                "decide_approval",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "run_id": run["run_id"],
                    "expected_run_revision": run["run_revision"],
                    "approval_id": previewed["approval"]["approval_id"],
                    "approve": True,
                    "reason": "I approve this exact preview.",
                },
                "human-stage-approval",
            )
        )
        run = stage_approval["run"]
        staged = self._payload(
            self._call(
                self.agent,
                9,
                "stage_design_patch",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "run_id": run["run_id"],
                    "expected_run_revision": run["run_revision"],
                    "patch": patch,
                    "preview_digest": previewed["preview"]["preview_digest"],
                    "approval_receipt_id": stage_approval["receipt"]["receipt_id"],
                },
                "e2e-stage",
            )
        )
        run = staged["run"]
        native = self._payload(
            self._call(
                self.agent,
                10,
                "run_verification",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "expected_staged_revision": staged["stage"]["staged_revision"],
                    "run_id": run["run_id"],
                    "expected_run_revision": run["run_revision"],
                },
                "native-verify",
            )
        )
        self.assertTrue(native["report"]["passed"])
        run = native["run"]

        kicad = self._call(
            self.agent,
            11,
            "kicad_verify",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "checks": ["drc", "erc"],
            },
            "kicad-verify",
        )
        self.assertFalse(kicad["isError"])
        self.assertTrue(kicad["structuredContent"]["succeeded"])
        self.assertEqual(
            kicad["structuredContent"]["evidence"]["request_digest"],
            stable_digest(
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "checks": ["drc", "erc"],
                }
            ),
        )

        release_approval = self._payload(
            self._call(
                self.human,
                12,
                "decide_approval",
                {
                    "project_id": self.project_id,
                    "expected_project_revision": self.revision,
                    "run_id": run["run_id"],
                    "expected_run_revision": run["run_revision"],
                    "approval_id": native["approval"]["approval_id"],
                    "approve": True,
                    "reason": "Native verification passed.",
                },
                "human-release-approval",
            )
        )
        refused_commit = self._call(
            self.human,
            13,
            "commit_transaction",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "expected_staged_revision": staged["stage"]["staged_revision"],
                "run_id": release_approval["run"]["run_id"],
                "expected_run_revision": release_approval["run"]["run_revision"],
                "verification_report_digest": native["report"]["report_digest"],
                "approval_receipt_id": release_approval["receipt"]["receipt_id"],
            },
            "must-have-attestation",
        )
        self.assertTrue(refused_commit["isError"])
        self.assertEqual(
            refused_commit["structuredContent"]["error"]["code"], "capability_denied"
        )

        call_count = len(self.worker.calls)
        unsafe_path = self._call(
            self.agent,
            14,
            "kicad_verify",
            {
                "project_id": self.project_id,
                "expected_project_revision": self.revision,
                "checks": ["drc"],
                "path": "C:\\outside\\untrusted.kicad_pcb",
            },
            "unsafe-path",
        )
        self.assertTrue(unsafe_path["isError"])
        self.assertEqual(unsafe_path["structuredContent"]["error"]["code"], "invalid_request")
        self.assertEqual(len(self.worker.calls), call_count)


if __name__ == "__main__":
    unittest.main()

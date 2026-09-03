from __future__ import annotations

import io
import json
import unittest
from datetime import UTC, datetime
from unittest.mock import patch

from backend.mcp_gateway import (
    ActorKind,
    CapabilitySafeGateway,
    InMemoryKiCadAdapter,
    Principal,
    ProfileName,
    ToolName,
)
from backend.mcp_server import (
    HostConfig,
    KiCadCommitAttestation,
    MCPStdioServer,
    serve_stdio,
)
from backend.mcp_server.server import (
    IDEMPOTENCY_META_KEY,
    MAX_FRAME_BYTES,
    MAX_MESSAGE_BYTES,
    MODERN_VERSION,
    ProtocolFault,
)

NOW = datetime(2026, 8, 29, 20, 0, tzinfo=UTC)
SHA_A = "a" * 64
SHA_B = "b" * 64


def decode(wire: bytes) -> dict:
    return json.loads(wire.decode("utf-8"))


class TestCommitAttestationVerifier:
    """Test-only bridge from the deterministic adapter report to the MCP gate."""

    def attest_commit(self, arguments, invocation) -> KiCadCommitAttestation:
        return KiCadCommitAttestation(
            project_id=arguments["project_id"],
            expected_project_revision=arguments["expected_project_revision"],
            expected_staged_revision=arguments["expected_staged_revision"],
            verification_report_digest=arguments["verification_report_digest"],
            worker="test-verification-bridge",
            kicad_version="9.0.4-test",
            policy_digest="c" * 64,
            passed=True,
        )


class MCPServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = InMemoryKiCadAdapter()
        self.project = "project-1"
        self.revision = self.adapter.seed_project(self.project)
        self.gateway = CapabilitySafeGateway(self.adapter, clock=lambda: NOW)
        self.commit_attestations = TestCommitAttestationVerifier()
        self.agent = MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal("agent-designer", ActorKind.AGENT, ProfileName.DESIGNER),
                allowed_project_ids=frozenset({self.project}),
                canonical_verification_policy_digest="c" * 64,
                commit_attestation_verifier=self.commit_attestations,
                kicad_worker="test-verification-bridge",
                kicad_version="9.0.4-test",
            ),
        )
        self.human = MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal("user-owner", ActorKind.USER, ProfileName.RELEASE_MANAGER),
                allowed_project_ids=frozenset({self.project}),
                canonical_verification_policy_digest="c" * 64,
                commit_attestation_verifier=self.commit_attestations,
                kicad_worker="test-verification-bridge",
                kicad_version="9.0.4-test",
            ),
        )
        self.observer = MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal("agent-observer", ActorKind.AGENT, ProfileName.OBSERVER),
                allowed_project_ids=frozenset({self.project}),
                canonical_verification_policy_digest="c" * 64,
                commit_attestation_verifier=self.commit_attestations,
                kicad_worker="test-verification-bridge",
                kicad_version="9.0.4-test",
            ),
        )
        for server in (self.agent, self.human, self.observer):
            self.initialize(server)

    @staticmethod
    def initialize(server: MCPStdioServer) -> None:
        response = decode(
            server.handle_line(
                b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":'
                b'{"protocolVersion":"2025-11-25","capabilities":{},'
                b'"clientInfo":{"name":"test","version":"1"}}}\n'
            )
        )
        assert response["result"]["protocolVersion"] == "2025-11-25"
        assert server.handle_line(
            b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
        ) is None

    @staticmethod
    def request(server: MCPStdioServer, rpc_id: int, method: str, params: dict) -> dict:
        wire = json.dumps(
            {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params},
            separators=(",", ":"),
        ).encode() + b"\n"
        response = server.handle_line(wire)
        assert response is not None
        return decode(response)

    def call(
        self,
        server: MCPStdioServer,
        rpc_id: int,
        name: str,
        arguments: dict,
        key: str | None = None,
    ) -> dict:
        params: dict = {"name": name, "arguments": arguments}
        if key is not None:
            params["_meta"] = {IDEMPOTENCY_META_KEY: key}
        return self.request(server, rpc_id, "tools/call", params)

    @staticmethod
    def payload(response: dict) -> dict:
        return json.loads(response["result"]["structuredContent"]["payload_json"])

    def test_byte_stream_framing_lifecycle_and_all_ten_tools(self) -> None:
        stdin = io.BytesIO(
            b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":'
            b'{"protocolVersion":"2025-11-25","capabilities":{},'
            b'"clientInfo":{"name":"test","version":"1"}}}\n'
            b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
            b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
            b'{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n'
        )
        stdout = io.BytesIO()
        server = MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal("stream-agent", ActorKind.AGENT, ProfileName.DESIGNER),
                allowed_project_ids=frozenset({self.project}),
            ),
        )
        serve_stdio(server, stdin, stdout)
        messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(len(messages), 3)
        self.assertEqual(messages[1]["result"], {})
        names = {tool["name"] for tool in messages[2]["result"]["tools"]}
        self.assertEqual(names, {item.value for item in ToolName})

    def test_invalid_messages_have_stable_errors_and_notifications_are_silent(self) -> None:
        self.assertEqual(decode(self.agent.handle_line(b"not-json\n"))["error"]["code"], -32700)
        self.assertEqual(decode(self.agent.handle_line(b"[]\n"))["error"]["code"], -32600)
        self.assertEqual(
            decode(self.agent.handle_line(b'{"jsonrpc":"2.0","jsonrpc":"2.0"}\n'))[
                "error"
            ]["code"],
            -32700,
        )
        self.assertEqual(
            decode(self.agent.handle_line(b'{"jsonrpc":"2.0","id":NaN}\n'))[
                "error"
            ]["code"],
            -32700,
        )
        self.assertEqual(
            decode(self.agent.handle_line(b'{"jsonrpc":"2.0"}'))["error"]["code"],
            -32700,
        )
        invalid_request = decode(
            self.agent.handle_line(
                b'{"jsonrpc":"2.0","id":"kept","method":"ping","extra":true}\n'
            )
        )
        self.assertEqual(invalid_request["id"], "kept")
        self.assertEqual(invalid_request["error"]["code"], -32600)
        unknown = self.request(self.agent, 9, "does/not/exist", {})
        self.assertEqual(unknown["error"]["code"], -32601)
        missing_tool = self.call(self.agent, 10, "not_a_tool", {})
        self.assertEqual(missing_tool["error"]["code"], -32602)
        self.assertIsNone(
            self.agent.handle_line(b'{"jsonrpc":"2.0","method":"unknown/notice"}\n')
        )
        self.assertIsNone(
            self.agent.handle_line(
                b'{"jsonrpc":"2.0","method":"unknown/notice","params":[]}\n'
            )
        )
        self.assertIsNone(
            self.agent.handle_line(
                b'{"jsonrpc":"2.0","method":"unknown/notice","extra":true}\n'
            )
        )
        surrogate = decode(
            self.agent.handle_line(
                b'{"jsonrpc":"2.0","id":"\\ud800","method":"ping"}\n'
            )
        )
        self.assertEqual(surrogate["id"], "\ufffd")

    def test_oversized_error_data_preserves_request_id_and_error_code(self) -> None:
        with patch.object(
            self.agent,
            "_request",
            side_effect=ProtocolFault(
                -32017,
                "Upstream failure",
                {"detail": "x" * MAX_MESSAGE_BYTES},
            ),
        ):
            response = self.agent.handle_line(
                b'{"jsonrpc":"2.0","id":99,"method":"ping"}\n'
            )

        self.assertIsNotNone(response)
        assert response is not None
        self.assertLessEqual(len(response) - 1, MAX_MESSAGE_BYTES)
        decoded = decode(response)
        self.assertEqual(decoded["id"], 99)
        self.assertEqual(decoded["error"]["code"], -32017)
        self.assertEqual(decoded["error"]["data"]["reason"], "response too large")

    def test_response_uses_utf8_and_replaces_lone_surrogates(self) -> None:
        response = self.agent.handle_line(
            b'{"jsonrpc":"2.0","id":"\\ud800","method":"ping"}\n'
        )

        self.assertIsNotNone(response)
        assert response is not None
        self.assertIn('"id":"\ufffd"'.encode("utf-8"), response)
        self.assertNotIn(b"\\ud800", response)
        self.assertEqual(decode(response)["id"], "\ufffd")

        utf8_response = self.agent.handle_line(
            '{"jsonrpc":"2.0","id":"caf\u00e9","method":"ping"}\n'.encode("utf-8")
        )
        self.assertIsNotNone(utf8_response)
        assert utf8_response is not None
        self.assertIn(b'"id":"caf\xc3\xa9"', utf8_response)
        self.assertNotIn(b"\\u00e9", utf8_response)

    def test_payload_limit_excludes_the_newline_frame_delimiter(self) -> None:
        payload = b" " * MAX_MESSAGE_BYTES
        response = self.agent.handle_line(payload + b"\n")

        self.assertIsNotNone(response)
        assert response is not None
        self.assertLessEqual(len(response) - 1, MAX_MESSAGE_BYTES)
        self.assertLessEqual(len(response), MAX_FRAME_BYTES)

    def test_oversized_unterminated_prefix_is_rejected_before_another_read(self) -> None:
        stdout = io.BytesIO()

        class PrefixThenEof:
            def __init__(self) -> None:
                self._calls = 0

            def readline(self, _limit: int) -> bytes:
                self._calls += 1
                if self._calls == 1:
                    return b"x" * MAX_FRAME_BYTES
                self.assert_response_was_flushed()
                return b""

            def assert_response_was_flushed(self) -> None:
                self_outer.assertTrue(stdout.getvalue())

        self_outer = self
        serve_stdio(self.agent, PrefixThenEof(), stdout)  # type: ignore[arg-type]

        messages = [decode(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["error"]["code"], -32700)
        self.assertEqual(messages[0]["error"]["data"]["reason"], "message too large")

    def test_oversized_prefix_remainder_is_discarded_through_its_newline(self) -> None:
        stdin = io.BytesIO(
            b"x" * MAX_FRAME_BYTES
            + b"discard this remainder\n"
            + b'{"jsonrpc":"2.0","id":97,"method":"ping"}\n'
        )
        stdout = io.BytesIO()

        serve_stdio(self.agent, stdin, stdout)

        messages = [decode(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([message["id"] for message in messages], [None, 97])
        self.assertEqual(messages[0]["error"]["code"], -32700)
        self.assertEqual(messages[1]["result"], {})

    def test_legacy_metadata_output_schemas_and_reused_rpc_ids(self) -> None:
        ping = self.request(
            self.agent,
            70,
            "ping",
            {"_meta": {"progressToken": "progress-1"}},
        )
        self.assertEqual(ping["result"], {})

        listing = self.request(self.agent, 71, "tools/list", {})["result"]
        self.assertTrue(
            all(tool["outputSchema"].get("type") == "object" for tool in listing["tools"])
        )

        first = self.call(
            self.agent,
            72,
            "inspect_project",
            {"project_id": self.project, "expected_project_revision": None},
        )
        second = self.call(
            self.agent,
            72,
            "inspect_project",
            {
                "project_id": self.project,
                "expected_project_revision": self.revision,
            },
        )
        third = self.call(
            self.agent,
            72,
            "inspect_project",
            {
                "project_id": self.project,
                "expected_project_revision": self.revision,
            },
        )
        self.assertFalse(first["result"]["isError"])
        self.assertFalse(second["result"]["isError"])
        self.assertFalse(third["result"]["isError"])
        self.assertEqual(len(self.gateway.evidence_records()), 3)

    def test_project_scope_and_unattested_commit_are_fail_closed(self) -> None:
        outside = self.call(
            self.agent,
            80,
            "inspect_project",
            {"project_id": "project-outside", "expected_project_revision": None},
            "outside-project",
        )["result"]
        self.assertTrue(outside["isError"])
        self.assertEqual(
            outside["structuredContent"]["error"]["code"], "capability_denied"
        )

        unattested = MCPStdioServer(
            self.gateway,
            HostConfig(
                Principal("unattested-user", ActorKind.USER, ProfileName.RELEASE_MANAGER),
                allowed_project_ids=frozenset({self.project}),
            ),
        )
        self.initialize(unattested)
        denied = self.call(
            unattested,
            81,
            "commit_transaction",
            {
                "project_id": self.project,
                "expected_project_revision": self.revision,
                "expected_staged_revision": self.revision,
                "run_id": "run-placeholder",
                "expected_run_revision": 0,
                "verification_report_digest": "f" * 64,
                "approval_receipt_id": "receipt-placeholder",
            },
            "unattested-commit",
        )["result"]
        self.assertTrue(denied["isError"])
        self.assertEqual(
            denied["structuredContent"]["error"]["code"], "capability_denied"
        )

    def test_modern_discovery_and_per_request_metadata(self) -> None:
        params = {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {},
            }
        }
        result = self.request(self.agent, 20, "server/discover", params)["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertIn(MODERN_VERSION, result["supportedVersions"])

    def test_capability_denial_and_idempotent_replay(self) -> None:
        create = {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "objective": "Build one board",
            "initial_questions": [],
            "max_parallel_agents": None,
            "token_budget": None,
        }
        denied = self.call(self.observer, 30, "create_agent_run", create, "denied-create")
        self.assertTrue(denied["result"]["isError"])
        self.assertEqual(
            denied["result"]["structuredContent"]["error"]["code"], "capability_denied"
        )
        first = self.call(self.agent, 31, "create_agent_run", create, "stable-create")
        second = self.call(self.agent, 32, "create_agent_run", create, "stable-create")
        self.assertEqual(
            first["result"]["structuredContent"],
            second["result"]["structuredContent"],
        )
        self.assertEqual(len(self.gateway.evidence_records()), 1)

        malformed_question = {**create, "initial_questions": [{
            "prompt": "Choose a side",
            "rationale": "Placement depends on it",
            "blocking": "yes",
            "options": ["left", "right"],
        }]}
        invalid = self.call(
            self.agent,
            33,
            "create_agent_run",
            malformed_question,
            "invalid-question",
        )
        self.assertTrue(invalid["result"]["isError"])
        self.assertEqual(
            invalid["result"]["structuredContent"]["error"]["code"],
            "invalid_request",
        )

    def test_question_approval_stage_verify_release_flow(self) -> None:
        create = {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "objective": "Design a deterministic controller board",
            "initial_questions": [{
                "prompt": "Which connector orientation is required?",
                "rationale": "It changes enclosure fit",
                "blocking": True,
                "options": ["north", "south"],
            }],
            "max_parallel_agents": None,
            "token_budget": None,
        }
        created = self.payload(self.call(self.agent, 40, "create_agent_run", create, "create-flow"))
        run = created["run"]
        question_id = created["questions"][0]["question_id"]
        answered = self.payload(self.call(self.human, 41, "answer_question", {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "run_id": run["run_id"],
            "expected_run_revision": run["run_revision"],
            "question_id": question_id,
            "answer": "north",
        }, "answer-flow"))
        run = answered["run"]
        patch = {
            "patch_id": "patch-1",
            "base_revision": self.revision,
            "rationale": "Add a grounded controller",
            "operations": [{
                "operation_id": "op-1",
                "action": "add_component",
                "target_id": "U1",
                "parameters": [
                    {"name": "datasheet_sha256", "value": SHA_A},
                    {"name": "footprint", "value": "Package_QFN:QFN-32"},
                    {"name": "manufacturer_part_number", "value": "STM32G031K8U6"},
                    {"name": "pin_map_sha256", "value": SHA_B},
                    {"name": "symbol", "value": "MCU_ST_STM32G0:STM32G031K8Ux"},
                ],
            }],
            "evidence_ids": [],
        }
        previewed = self.payload(self.call(self.agent, 42, "preview_patch", {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "run_id": run["run_id"],
            "expected_run_revision": run["run_revision"],
            "patch": patch,
        }, "preview-flow"))
        run = previewed["run"]
        stage_approved = self.payload(self.call(self.human, 43, "decide_approval", {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "run_id": run["run_id"],
            "expected_run_revision": run["run_revision"],
            "approval_id": previewed["approval"]["approval_id"],
            "approve": True,
            "reason": "Exact preview accepted",
        }, "approve-stage-flow"))
        run = stage_approved["run"]
        staged = self.payload(self.call(self.agent, 44, "stage_design_patch", {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "run_id": run["run_id"],
            "expected_run_revision": run["run_revision"],
            "patch": patch,
            "preview_digest": previewed["preview"]["preview_digest"],
            "approval_receipt_id": stage_approved["receipt"]["receipt_id"],
        }, "stage-flow"))
        run = staged["run"]
        verified = self.payload(self.call(self.agent, 45, "run_verification", {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "expected_staged_revision": staged["stage"]["staged_revision"],
            "run_id": run["run_id"],
            "expected_run_revision": run["run_revision"],
        }, "verify-flow"))
        self.assertTrue(verified["report"]["passed"])
        run = verified["run"]
        release_approved = self.payload(self.call(self.human, 46, "decide_approval", {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "run_id": run["run_id"],
            "expected_run_revision": run["run_revision"],
            "approval_id": verified["approval"]["approval_id"],
            "approve": True,
            "reason": "Deterministic verification passed",
        }, "approve-release-flow"))
        run = release_approved["run"]
        committed = self.payload(self.call(self.human, 47, "commit_transaction", {
            "project_id": self.project,
            "expected_project_revision": self.revision,
            "expected_staged_revision": staged["stage"]["staged_revision"],
            "run_id": run["run_id"],
            "expected_run_revision": run["run_revision"],
            "verification_report_digest": verified["report"]["report_digest"],
            "approval_receipt_id": release_approved["receipt"]["receipt_id"],
        }, "commit-flow"))
        self.assertEqual(committed["run"]["state"], "complete")
        self.assertEqual(committed["committed_revision"], staged["stage"]["staged_revision"])


if __name__ == "__main__":
    unittest.main()

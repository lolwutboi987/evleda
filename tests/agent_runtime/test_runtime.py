from __future__ import annotations

import json
import os
import unittest
from copy import deepcopy
from unittest.mock import patch

from backend.agent_runtime import (
    AgentTaskContext,
    EvidenceReference,
    ModelProviderError,
    ModelUsage,
    OpenAIResponsesProvider,
    ProposalAction,
    ProposalRole,
    ProposalValidationError,
    RawModelGeneration,
    SchemaBoundAgentRuntime,
)


class CapturingTransport:
    def __init__(self, response: dict[str, object]) -> None:
        self.response = response
        self.calls: list[dict[str, object]] = []

    def post_json(
        self,
        url: str,
        *,
        headers: dict[str, str],
        body: dict[str, object],
        timeout_seconds: int,
    ) -> dict[str, object]:
        self.calls.append(
            {
                "url": url,
                "headers": dict(headers),
                "body": deepcopy(body),
                "timeout_seconds": timeout_seconds,
            }
        )
        return deepcopy(self.response)


class StaticProvider:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def generate(self, context: AgentTaskContext) -> RawModelGeneration:
        return RawModelGeneration(
            provider="test",
            model="schema-fixture",
            response_id="resp_test",
            payload=deepcopy(self.payload),
            output_digest="a" * 64,
            usage=ModelUsage(input_tokens=11, output_tokens=7, total_tokens=18),
        )


def make_context() -> AgentTaskContext:
    return AgentTaskContext(
        run_id="run_power",
        task_id="task_place_u1",
        role=ProposalRole.DOMAIN_DESIGNER,
        objective="Place U1 inside the approved board envelope",
        instructions="Propose a placement; do not stage it.",
        input_revision="rev_" + "1" * 64,
        allowed_actions=(ProposalAction.PLACE_COMPONENT,),
        allowed_capabilities=("pcb_edit",),
        evidence=(
            EvidenceReference(
                evidence_id="evidence_u1",
                kind="component",
                digest="2" * 64,
                summary="Approved U1 footprint and pin-map evidence",
            ),
        ),
    )


def make_payload(context: AgentTaskContext) -> dict[str, object]:
    return {
        "context_digest": context.context_digest,
        "summary": "Place the approved footprint at an integer-nanometre coordinate.",
        "questions": [],
        "tasks": [
            {
                "task_id": "place_u1",
                "role": "domain_designer",
                "objective": "Propose one placement candidate",
                "dependencies": [],
                "required_capabilities": ["pcb_edit"],
                "acceptance_checks": ["native_drc"],
                "risk": "medium",
            }
        ],
        "operations": [
            {
                "operation_id": "op_place_u1",
                "action": "place_component",
                "target_id": "U1",
                "parameters": {"position_nm": [25_000_000, 15_000_000], "side": "front"},
                "evidence_ids": ["evidence_u1"],
            }
        ],
        "residual_risks": ["Native DRC and independent KiCad DRC remain required."],
    }


def response_for(payload: dict[str, object]) -> dict[str, object]:
    return {
        "id": "resp_123",
        "model": "gpt-5.6-sol",
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": []},
            {
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(payload)}],
            },
        ],
        "usage": {"input_tokens": 15, "output_tokens": 7, "total_tokens": 22},
    }


class AgentRuntimeTests(unittest.TestCase):
    def test_openai_request_is_strict_revision_bound_and_has_no_app_token_cap(self) -> None:
        context = make_context()
        transport = CapturingTransport(response_for(make_payload(context)))
        provider = OpenAIResponsesProvider(api_key="test-secret", transport=transport)

        result = SchemaBoundAgentRuntime(provider).execute(context)

        self.assertEqual(result.context_digest, context.context_digest)
        self.assertEqual(result.proposal.operations[0].action, ProposalAction.PLACE_COMPONENT)
        self.assertEqual(result.usage.total_tokens, 22)
        self.assertRegex(result.trace_digest, r"^[0-9a-f]{64}$")
        self.assertEqual(len(transport.calls), 1)
        body = transport.calls[0]["body"]
        self.assertIsInstance(body, dict)
        assert isinstance(body, dict)
        self.assertNotIn("max_output_tokens", body)
        self.assertFalse(body["store"])
        self.assertEqual(body["reasoning"], {"effort": "max"})
        self.assertEqual(body["metadata"]["context_digest"], context.context_digest)
        self.assertTrue(body["text"]["format"]["strict"])
        self.assertEqual(body["text"]["format"]["type"], "json_schema")
        self.assertNotIn("test-secret", json.dumps(body))
        self.assertEqual(
            transport.calls[0]["headers"]["Authorization"], "Bearer test-secret"
        )

    def test_blocking_question_and_operations_fail_closed(self) -> None:
        context = make_context()
        payload = make_payload(context)
        payload["questions"] = [
            {
                "question_id": "q_side",
                "prompt": "Which side should U1 use?",
                "rationale": "The side changes routing and assembly constraints.",
                "options": ["front", "back"],
                "recommendation": "front",
                "blocking": True,
                "affected_artifact_ids": ["U1"],
            }
        ]
        with self.assertRaisesRegex(ProposalValidationError, "blocking questions"):
            SchemaBoundAgentRuntime(StaticProvider(payload)).execute(context)

    def test_context_rebinding_and_unauthorized_capability_are_rejected(self) -> None:
        context = make_context()
        rebound = make_payload(context)
        rebound["context_digest"] = "0" * 64
        with self.assertRaisesRegex(ProposalValidationError, "context_digest"):
            SchemaBoundAgentRuntime(StaticProvider(rebound)).execute(context)

        unauthorized = make_payload(context)
        unauthorized["tasks"][0]["required_capabilities"] = ["pcb_edit", "release"]
        with self.assertRaisesRegex(ProposalValidationError, "unauthorized capabilities"):
            SchemaBoundAgentRuntime(StaticProvider(unauthorized)).execute(context)

    def test_float_unknown_evidence_and_escape_hatch_parameters_are_rejected(self) -> None:
        context = make_context()
        floating = make_payload(context)
        floating["operations"][0]["parameters"]["rotation_deg"] = 90.0
        with self.assertRaisesRegex(ProposalValidationError, "floating-point"):
            SchemaBoundAgentRuntime(StaticProvider(floating)).execute(context)

        unknown_evidence = make_payload(context)
        unknown_evidence["operations"][0]["evidence_ids"] = ["evidence_invented"]
        with self.assertRaisesRegex(ProposalValidationError, "unknown evidence"):
            SchemaBoundAgentRuntime(StaticProvider(unknown_evidence)).execute(context)

        escape = make_payload(context)
        escape["operations"][0]["parameters"]["path"] = "C:/unsafe.kicad_pcb"
        with self.assertRaisesRegex(ProposalValidationError, "escape-hatch"):
            SchemaBoundAgentRuntime(StaticProvider(escape)).execute(context)

    def test_task_dependencies_must_be_known_and_acyclic(self) -> None:
        context = make_context()
        unknown = make_payload(context)
        unknown["tasks"][0]["dependencies"] = ["missing_task"]
        with self.assertRaisesRegex(ProposalValidationError, "unknown dependencies"):
            SchemaBoundAgentRuntime(StaticProvider(unknown)).execute(context)

        cyclic = make_payload(context)
        cyclic["tasks"].append(
            {
                "task_id": "review_u1",
                "role": "critic",
                "objective": "Review placement",
                "dependencies": ["place_u1"],
                "required_capabilities": ["pcb_edit"],
                "acceptance_checks": ["native_drc"],
                "risk": "medium",
            }
        )
        cyclic["tasks"][0]["dependencies"] = ["review_u1"]
        with self.assertRaisesRegex(ProposalValidationError, "acyclic"):
            SchemaBoundAgentRuntime(StaticProvider(cyclic)).execute(context)

    def test_incomplete_refused_and_multi_text_responses_fail_closed(self) -> None:
        context = make_context()
        incomplete = response_for(make_payload(context))
        incomplete["status"] = "incomplete"
        provider = OpenAIResponsesProvider(
            api_key="test", transport=CapturingTransport(incomplete)
        )
        with self.assertRaisesRegex(ModelProviderError, "did not complete"):
            provider.generate(context)

        refused = response_for(make_payload(context))
        refused["output"] = [
            {"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}
        ]
        provider = OpenAIResponsesProvider(api_key="test", transport=CapturingTransport(refused))
        with self.assertRaisesRegex(ModelProviderError, "refused"):
            provider.generate(context)

        multiple = response_for(make_payload(context))
        multiple["output"][1]["content"].append(
            {"type": "output_text", "text": json.dumps(make_payload(context))}
        )
        provider = OpenAIResponsesProvider(api_key="test", transport=CapturingTransport(multiple))
        with self.assertRaisesRegex(ModelProviderError, "exactly one"):
            provider.generate(context)

    def test_missing_environment_key_is_explicit_and_does_not_call_network(self) -> None:
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(
            ModelProviderError, "OPENAI_API_KEY"
        ):
            OpenAIResponsesProvider.from_environment(transport=CapturingTransport({}))


if __name__ == "__main__":
    unittest.main()

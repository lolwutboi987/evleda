"""Host-side executor for one schema-bound, proposal-only model turn."""

from __future__ import annotations

from dataclasses import asdict

from .models import AgentTaskContext, AgentTurnResult, stable_digest
from .provider import ModelProvider
from .schema import validate_proposal


class SchemaBoundAgentRuntime:
    def __init__(self, provider: ModelProvider) -> None:
        self._provider = provider

    def execute(self, context: AgentTaskContext) -> AgentTurnResult:
        generation = self._provider.generate(context)
        proposal = validate_proposal(generation.payload, context)
        trace_material = {
            "context_digest": context.context_digest,
            "proposal_digest": proposal.proposal_digest,
            "provider": generation.provider,
            "model": generation.model,
            "response_id": generation.response_id,
            "output_digest": generation.output_digest,
            "usage": asdict(generation.usage),
        }
        return AgentTurnResult(
            context_digest=context.context_digest,
            proposal=proposal,
            provider=generation.provider,
            model=generation.model,
            response_id=generation.response_id,
            output_digest=generation.output_digest,
            usage=generation.usage,
            trace_digest=stable_digest(trace_material, domain="flux-agent-trace-v1"),
        )

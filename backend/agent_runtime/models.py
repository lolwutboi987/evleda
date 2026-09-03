"""Typed records for schema-bound model turns.

Model output is deliberately a proposal artifact.  It never carries authority to
approve, stage, verify, commit, export, or declare a design safe.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import json
import re
from typing import Any, Mapping


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


class AgentRuntimeError(ValueError):
    """Base class for fail-closed agent-runtime errors."""


class ProposalValidationError(AgentRuntimeError):
    """Raised when a model proposal violates the closed contract."""


class ModelProviderError(AgentRuntimeError):
    """Raised when a model response is absent, incomplete, or malformed."""


class ProposalRole(str, Enum):
    INTERVIEWER = "interviewer"
    RESEARCHER = "researcher"
    DOMAIN_DESIGNER = "domain_designer"
    CRITIC = "critic"
    RELEASE_REVIEWER = "release_reviewer"


class ProposalAction(str, Enum):
    ADD_COMPONENT = "add_component"
    REMOVE_COMPONENT = "remove_component"
    CONNECT_NET = "connect_net"
    DISCONNECT_NET = "disconnect_net"
    SET_PROPERTY = "set_property"
    SET_CONSTRAINT = "set_constraint"
    PLACE_COMPONENT = "place_component"
    ROUTE_NET = "route_net"


class ProposalRisk(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def stable_digest(value: Any, *, domain: str) -> str:
    material = f"{domain}\0{canonical_json(value)}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def require_identifier(value: str, label: str) -> None:
    if not _IDENTIFIER.fullmatch(value):
        raise ProposalValidationError(f"{label} is not a valid identifier")


@dataclass(frozen=True, slots=True)
class EvidenceReference:
    evidence_id: str
    kind: str
    digest: str
    summary: str

    def __post_init__(self) -> None:
        require_identifier(self.evidence_id, "evidence_id")
        require_identifier(self.kind, "evidence.kind")
        if not re.fullmatch(r"[0-9a-f]{64}", self.digest):
            raise ProposalValidationError("evidence.digest must be a sha256 digest")
        if not self.summary.strip():
            raise ProposalValidationError("evidence.summary is required")

    def payload(self) -> dict[str, object]:
        return {
            "evidence_id": self.evidence_id,
            "kind": self.kind,
            "digest": self.digest,
            "summary": self.summary,
        }


@dataclass(frozen=True, slots=True)
class AgentTaskContext:
    run_id: str
    task_id: str
    role: ProposalRole
    objective: str
    instructions: str
    input_revision: str
    allowed_actions: tuple[ProposalAction, ...]
    allowed_capabilities: tuple[str, ...]
    evidence: tuple[EvidenceReference, ...] = ()

    def __post_init__(self) -> None:
        require_identifier(self.run_id, "run_id")
        require_identifier(self.task_id, "task_id")
        if not self.objective.strip() or not self.instructions.strip():
            raise ProposalValidationError("objective and instructions are required")
        if not self.input_revision.strip():
            raise ProposalValidationError("input_revision is required")
        if len(self.allowed_actions) != len(set(self.allowed_actions)):
            raise ProposalValidationError("allowed_actions must be unique")
        if self.allowed_actions != tuple(sorted(self.allowed_actions, key=lambda item: item.value)):
            raise ProposalValidationError("allowed_actions must be sorted")
        if self.allowed_capabilities != tuple(sorted(set(self.allowed_capabilities))):
            raise ProposalValidationError("allowed_capabilities must be sorted and unique")
        evidence_ids = tuple(item.evidence_id for item in self.evidence)
        if evidence_ids != tuple(sorted(set(evidence_ids))):
            raise ProposalValidationError("evidence must be sorted by unique evidence_id")

    def payload(self) -> dict[str, object]:
        return {
            "run_id": self.run_id,
            "task_id": self.task_id,
            "role": self.role.value,
            "objective": self.objective,
            "instructions": self.instructions,
            "input_revision": self.input_revision,
            "allowed_actions": [item.value for item in self.allowed_actions],
            "allowed_capabilities": list(self.allowed_capabilities),
            "evidence": [item.payload() for item in self.evidence],
        }

    @property
    def context_digest(self) -> str:
        return stable_digest(self.payload(), domain="flux-agent-context-v1")


@dataclass(frozen=True, slots=True)
class ProposedQuestion:
    question_id: str
    prompt: str
    rationale: str
    options: tuple[str, ...]
    recommendation: str
    blocking: bool
    affected_artifact_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProposedTask:
    task_id: str
    role: ProposalRole
    objective: str
    dependencies: tuple[str, ...]
    required_capabilities: tuple[str, ...]
    acceptance_checks: tuple[str, ...]
    risk: ProposalRisk


@dataclass(frozen=True, slots=True)
class ProposedOperation:
    operation_id: str
    action: ProposalAction
    target_id: str
    parameters: Mapping[str, Any]
    evidence_ids: tuple[str, ...]

    def payload(self) -> dict[str, object]:
        return {
            "operation_id": self.operation_id,
            "action": self.action.value,
            "target_id": self.target_id,
            "parameters": dict(self.parameters),
            "evidence_ids": list(self.evidence_ids),
        }


@dataclass(frozen=True, slots=True)
class AgentProposal:
    context_digest: str
    summary: str
    questions: tuple[ProposedQuestion, ...]
    tasks: tuple[ProposedTask, ...]
    operations: tuple[ProposedOperation, ...]
    residual_risks: tuple[str, ...]

    def payload(self) -> dict[str, object]:
        return {
            "context_digest": self.context_digest,
            "summary": self.summary,
            "questions": [
                {
                    "question_id": item.question_id,
                    "prompt": item.prompt,
                    "rationale": item.rationale,
                    "options": list(item.options),
                    "recommendation": item.recommendation,
                    "blocking": item.blocking,
                    "affected_artifact_ids": list(item.affected_artifact_ids),
                }
                for item in self.questions
            ],
            "tasks": [
                {
                    "task_id": item.task_id,
                    "role": item.role.value,
                    "objective": item.objective,
                    "dependencies": list(item.dependencies),
                    "required_capabilities": list(item.required_capabilities),
                    "acceptance_checks": list(item.acceptance_checks),
                    "risk": item.risk.value,
                }
                for item in self.tasks
            ],
            "operations": [item.payload() for item in self.operations],
            "residual_risks": list(self.residual_risks),
        }

    @property
    def proposal_digest(self) -> str:
        return stable_digest(self.payload(), domain="flux-agent-proposal-v1")


@dataclass(frozen=True, slots=True)
class ModelUsage:
    input_tokens: int
    output_tokens: int
    total_tokens: int

    def __post_init__(self) -> None:
        if min(self.input_tokens, self.output_tokens, self.total_tokens) < 0:
            raise ModelProviderError("model usage cannot be negative")
        if self.total_tokens < self.input_tokens + self.output_tokens:
            raise ModelProviderError("model total_tokens is internally inconsistent")


@dataclass(frozen=True, slots=True)
class RawModelGeneration:
    provider: str
    model: str
    response_id: str
    payload: Mapping[str, Any]
    output_digest: str
    usage: ModelUsage


@dataclass(frozen=True, slots=True)
class AgentTurnResult:
    context_digest: str
    proposal: AgentProposal
    provider: str
    model: str
    response_id: str
    output_digest: str
    usage: ModelUsage
    trace_digest: str

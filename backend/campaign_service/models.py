"""Exact records for the durable PCB design campaign boundary.

The campaign boundary intentionally accepts descriptions, immutable digests, and
opaque references.  It never accepts shell commands, filesystem paths, generic
tool invocations, or raw MCP payloads.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import TypeAlias

from ..orchestrator import (
    AgentClass,
    ApprovalState,
    CoordinationStage,
    RiskClass,
    RunPhase,
    TaskKind,
    TaskState,
)
from ..orchestrator.models import require_aware


class CampaignError(ValueError):
    """Base error for invalid or unsafe campaign operations."""


class AuthorityError(CampaignError):
    """The caller lacks a required non-model authority."""


class StaleCampaignError(CampaignError):
    """The caller did not operate on the exact current campaign revision."""


class IdempotencyConflict(CampaignError):
    """A request ID was reused for different operation material."""


class ExecutionUnavailable(CampaignError):
    """No concrete host executor can accept campaign work."""


class DocumentKind(str, Enum):
    BRIEF = "brief"
    PLAN = "plan"


class ReferenceKind(str, Enum):
    PROPOSAL = "proposal"
    SCHEMATIC = "schematic"
    PCB = "pcb"
    BOM = "bom"
    PREVIEW = "preview"
    CHECK_REPORT = "check-report"
    CRITIC_REVIEW = "critic-review"


def _exact_text(value: object, label: str, *, allow_empty: bool = False) -> str:
    if type(value) is not str:
        raise CampaignError(f"{label} must be an exact string")
    result = value
    if result != result.strip():
        raise CampaignError(f"{label} cannot contain outer whitespace")
    if not allow_empty and not result:
        raise CampaignError(f"{label} is required")
    return result


def _exact_digest(value: object, label: str) -> str:
    result = _exact_text(value, label)
    if len(result) != 64 or any(character not in "0123456789abcdef" for character in result):
        raise CampaignError(f"{label} must be a lowercase SHA-256 digest")
    return result


def _exact_string_tuple(value: object, label: str, *, nonempty: bool = False) -> tuple[str, ...]:
    if type(value) is not tuple:
        raise CampaignError(f"{label} must be an exact tuple")
    result = value
    if nonempty and not result:
        raise CampaignError(f"{label} cannot be empty")
    if any(type(item) is not str or not item or item != item.strip() for item in result):
        raise CampaignError(f"{label} must contain exact non-empty strings without outer whitespace")
    if len(result) != len(set(result)):
        raise CampaignError(f"{label} must be unique")
    return result


@dataclass(frozen=True, slots=True)
class HumanSession:
    """An application-injected authenticated human authority.

    JSON input can never construct this record.  A CLI host or ChatGPT app host
    must authenticate the user and inject the exact record into its adapter.
    """

    actor_id: str
    session_id: str
    channel: str
    authenticated_at: datetime

    def __post_init__(self) -> None:
        if type(self) is not HumanSession:
            raise AuthorityError("human authority must use the exact HumanSession type")
        _exact_text(self.actor_id, "human actor ID")
        _exact_text(self.session_id, "human session ID")
        if _exact_text(self.channel, "human channel") not in {"cli", "chatgpt"}:
            raise AuthorityError("human channel must be cli or chatgpt")
        if type(self.authenticated_at) is not datetime:
            raise AuthorityError("human authentication time must be an exact datetime")
        require_aware(self.authenticated_at, "human authenticated_at")


@dataclass(frozen=True, slots=True)
class HostExecutor:
    """Concrete host execution authority used to mint real scheduler leases."""

    executor_id: str
    effective_capacity: int
    lease_signing_key: bytes

    def __post_init__(self) -> None:
        if type(self) is not HostExecutor:
            raise AuthorityError("host execution must use the exact HostExecutor type")
        _exact_text(self.executor_id, "executor ID")
        if type(self.effective_capacity) is not int or self.effective_capacity < 1:
            raise CampaignError("effective host capacity must be an exact positive integer")
        if type(self.lease_signing_key) is not bytes or len(self.lease_signing_key) < 32:
            raise CampaignError("lease signing key must be exact bytes with at least 32 bytes")


@dataclass(frozen=True, slots=True)
class CampaignObjective:
    project_id: str
    base_revision: str
    objective: str

    def __post_init__(self) -> None:
        if type(self) is not CampaignObjective:
            raise CampaignError("objective must use the exact CampaignObjective type")
        _exact_text(self.project_id, "project ID")
        _exact_text(self.base_revision, "base revision")
        _exact_text(self.objective, "PCB objective")


@dataclass(frozen=True, slots=True)
class QuestionDraft:
    prompt: str
    rationale: str
    options: tuple[str, ...]
    recommendation: str
    confidence_basis_points: int
    allow_custom_answer: bool = False
    affected_artifact_ids: tuple[str, ...] = ()
    dependent_decision_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if type(self) is not QuestionDraft:
            raise CampaignError("questions must use the exact QuestionDraft type")
        _exact_text(self.prompt, "question prompt")
        _exact_text(self.rationale, "question rationale")
        options = _exact_string_tuple(self.options, "question options", nonempty=True)
        if len(options) < 2:
            raise CampaignError("a blocking question requires at least two options")
        if _exact_text(self.recommendation, "question recommendation") not in options:
            raise CampaignError("question recommendation must be a declared option")
        if type(self.confidence_basis_points) is not int or not (
            0 <= self.confidence_basis_points <= 10_000
        ):
            raise CampaignError("question confidence must be an exact integer from 0 to 10000")
        if type(self.allow_custom_answer) is not bool:
            raise CampaignError("allow_custom_answer must be an exact boolean")
        _exact_string_tuple(self.affected_artifact_ids, "affected artifact IDs")
        _exact_string_tuple(self.dependent_decision_ids, "dependent decision IDs")


@dataclass(frozen=True, slots=True)
class CheckSpec:
    check_id: str
    trusted_source: str
    policy_digest: str

    def __post_init__(self) -> None:
        if type(self) is not CheckSpec:
            raise CampaignError("check specifications must use the exact CheckSpec type")
        _exact_text(self.check_id, "check ID")
        _exact_text(self.trusted_source, "trusted check source")
        _exact_digest(self.policy_digest, "check policy digest")


@dataclass(frozen=True, slots=True)
class TaskSpec:
    key: str
    title: str
    instructions: str
    kind: TaskKind
    wave: int
    dependency_keys: tuple[str, ...] = ()
    required_capabilities: tuple[str, ...] = ()
    required_agent_class: AgentClass | None = None
    risk_class: RiskClass = RiskClass.MEDIUM
    estimated_tokens: int = 0
    reviewed_task_keys: tuple[str, ...] = ()
    required_checks: tuple[CheckSpec, ...] = ()

    def __post_init__(self) -> None:
        if type(self) is not TaskSpec:
            raise CampaignError("task specifications must use the exact TaskSpec type")
        _exact_text(self.key, "task key")
        _exact_text(self.title, "task title")
        _exact_text(self.instructions, "task instructions")
        if type(self.kind) is not TaskKind:
            raise CampaignError("task kind must be the exact TaskKind enum")
        if type(self.wave) is not int or self.wave < 0:
            raise CampaignError("task wave must be an exact non-negative integer")
        _exact_string_tuple(self.dependency_keys, "task dependency keys")
        _exact_string_tuple(self.required_capabilities, "task capabilities")
        if self.required_agent_class is not None and type(self.required_agent_class) is not AgentClass:
            raise CampaignError("required agent class must be an exact enum or null")
        if type(self.risk_class) is not RiskClass:
            raise CampaignError("task risk class must be the exact RiskClass enum")
        if type(self.estimated_tokens) is not int or self.estimated_tokens < 0:
            raise CampaignError("estimated tokens must be an exact non-negative integer")
        reviewed = _exact_string_tuple(self.reviewed_task_keys, "reviewed task keys")
        if reviewed and self.kind is not TaskKind.REVIEW:
            raise CampaignError("only review tasks may declare reviewed task keys")
        if any(key not in self.dependency_keys for key in reviewed):
            raise CampaignError("every reviewed task must also be a dependency")
        if type(self.required_checks) is not tuple or any(
            type(item) is not CheckSpec for item in self.required_checks
        ):
            raise CampaignError("required checks must be an exact tuple of exact CheckSpec records")
        check_ids = tuple(item.check_id for item in self.required_checks)
        if len(check_ids) != len(set(check_ids)):
            raise CampaignError("required check IDs must be unique")


@dataclass(frozen=True, slots=True)
class AgentSpec:
    key: str
    name: str
    agent_class: AgentClass
    capabilities: tuple[str, ...]
    wave: int = 0

    def __post_init__(self) -> None:
        if type(self) is not AgentSpec:
            raise CampaignError("agent specifications must use the exact AgentSpec type")
        _exact_text(self.key, "agent key")
        _exact_text(self.name, "agent name")
        if type(self.agent_class) is not AgentClass:
            raise CampaignError("agent class must be the exact AgentClass enum")
        _exact_string_tuple(self.capabilities, "agent capabilities")
        if type(self.wave) is not int or self.wave < 0:
            raise CampaignError("agent wave must be an exact non-negative integer")


@dataclass(frozen=True, slots=True)
class ProposalReference:
    reference_id: str
    design_revision: str
    content_digest: str
    summary: str

    def __post_init__(self) -> None:
        if type(self) is not ProposalReference:
            raise CampaignError("proposal references must use the exact ProposalReference type")
        _exact_text(self.reference_id, "proposal reference ID")
        _exact_text(self.design_revision, "proposal design revision")
        _exact_digest(self.content_digest, "proposal content digest")
        _exact_text(self.summary, "proposal summary")


@dataclass(frozen=True, slots=True)
class ArtifactReference:
    reference_id: str
    design_revision: str
    content_digest: str
    kind: ReferenceKind
    summary: str

    def __post_init__(self) -> None:
        if type(self) is not ArtifactReference:
            raise CampaignError("artifact references must use the exact ArtifactReference type")
        _exact_text(self.reference_id, "artifact reference ID")
        _exact_text(self.design_revision, "artifact design revision")
        _exact_digest(self.content_digest, "artifact content digest")
        if type(self.kind) is not ReferenceKind or self.kind is ReferenceKind.PROPOSAL:
            raise CampaignError("artifact kind must be an exact non-proposal ReferenceKind")
        _exact_text(self.summary, "artifact summary")


ResultReference: TypeAlias = ProposalReference | ArtifactReference


@dataclass(frozen=True, slots=True)
class DesignCheckResult:
    check_id: str
    source: str
    policy_digest: str
    passed: bool
    result_digest: str
    summary: str

    def __post_init__(self) -> None:
        if type(self) is not DesignCheckResult:
            raise CampaignError("check results must use the exact DesignCheckResult type")
        _exact_text(self.check_id, "check result ID")
        _exact_text(self.source, "check result source")
        _exact_digest(self.policy_digest, "check result policy digest")
        if type(self.passed) is not bool:
            raise CampaignError("check result passed must be an exact boolean")
        _exact_digest(self.result_digest, "check result digest")
        _exact_text(self.summary, "check result summary")


@dataclass(frozen=True, slots=True)
class DocumentRecord:
    evidence_id: str
    kind: DocumentKind
    revision: int
    content: str
    content_digest: str
    summary: str
    created_at: datetime

    def __post_init__(self) -> None:
        if type(self) is not DocumentRecord:
            raise CampaignError("documents must use the exact DocumentRecord type")
        _exact_text(self.evidence_id, "document evidence ID")
        if type(self.kind) is not DocumentKind:
            raise CampaignError("document kind must be the exact DocumentKind enum")
        if type(self.revision) is not int or self.revision < 1:
            raise CampaignError("document revision must be an exact positive integer")
        _exact_text(self.content, "document content")
        _exact_digest(self.content_digest, "document digest")
        _exact_text(self.summary, "document summary")
        if type(self.created_at) is not datetime:
            raise CampaignError("document timestamp must be an exact datetime")
        require_aware(self.created_at, "document created_at")


@dataclass(frozen=True, slots=True)
class QuestionView:
    id: str
    prompt: str
    rationale: str
    options: tuple[str, ...]
    recommendation: str | None
    confidence_basis_points: int | None
    allow_custom_answer: bool
    state: str
    answer: str | None


@dataclass(frozen=True, slots=True)
class ApprovalView:
    id: str
    kind: str
    subject_digest: str
    summary: str
    state: ApprovalState


@dataclass(frozen=True, slots=True)
class TaskView:
    id: str
    title: str
    kind: TaskKind
    state: TaskState
    wave: int
    required_agent_class: AgentClass | None
    result_references: tuple[ResultReference, ...]


@dataclass(frozen=True, slots=True)
class CampaignView:
    campaign_id: str
    project_id: str
    base_revision: str
    objective: str
    objective_digest: str
    generation: int
    parent_campaign_id: str | None
    revision: int
    phase: RunPhase
    coordination_stage: CoordinationStage
    requested_agent_capacity: int
    effective_host_capacity: int | None
    execution_available: bool
    questions: tuple[QuestionView, ...]
    approvals: tuple[ApprovalView, ...]
    brief: DocumentRecord | None
    plan: DocumentRecord | None
    tasks: tuple[TaskView, ...]


@dataclass(frozen=True, slots=True)
class WorkDispatch:
    task_id: str
    agent_id: str
    lease_token: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class WorkRequestOutcome:
    execution_available: bool
    requested_agent_capacity: int
    effective_host_capacity: int | None
    revision: int
    dispatches: tuple[WorkDispatch, ...]
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class SubmissionOutcome:
    campaign_id: str
    revision: int
    task_id: str
    state: TaskState
    references: tuple[ResultReference, ...]


@dataclass(frozen=True, slots=True)
class CampaignEventView:
    sequence: int
    event_type: str
    actor: str
    occurred_at: datetime
    aggregate_id: str
    payload_json: str
    event_hash: str


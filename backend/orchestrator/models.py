"""Typed, immutable domain models for durable multi-agent orchestration.

The models deliberately avoid framework dependencies.  They are safe to use from
an API server, a background worker, or a deterministic replay process.
"""

from __future__ import annotations

import builtins
import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from enum import Enum, IntEnum
from typing import Any, Mapping, NewType, Sequence
from uuid import uuid4

RunId = NewType("RunId", str)
AgentId = NewType("AgentId", str)
TaskId = NewType("TaskId", str)
QuestionId = NewType("QuestionId", str)
ApprovalId = NewType("ApprovalId", str)
EvidenceId = NewType("EvidenceId", str)
EventId = NewType("EventId", str)


class DomainError(ValueError):
    """Raised when an orchestration invariant would be violated."""


class BudgetExceeded(DomainError):
    """Raised before work is dispatched beyond an explicit run budget."""


class RunPhase(str, Enum):
    DRAFT = "draft"
    CLARIFYING = "clarifying"
    AWAITING_PLAN_APPROVAL = "awaiting_plan_approval"
    READY = "ready"
    EXECUTING = "executing"
    AWAITING_CHANGE_APPROVAL = "awaiting_change_approval"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class CoordinationStage(str, Enum):
    """User-visible EvlEDA design workflow checkpoints."""

    QUESTIONING = "questioning"
    AWAITING_BRIEF_APPROVAL = "awaiting_brief_approval"
    RESEARCH = "research"
    AWAITING_ARCHITECTURE_BOM_APPROVAL = "awaiting_architecture_bom_approval"
    SCHEMATIC_STAGE = "schematic_stage"
    AWAITING_SCHEMATIC_APPROVAL = "awaiting_schematic_approval"
    AWAITING_LAYOUT_CONSTRAINT_APPROVAL = "awaiting_layout_constraint_approval"
    PLACEMENT_STAGE = "placement_stage"
    AWAITING_PLACEMENT_APPROVAL = "awaiting_placement_approval"
    ROUTING_STAGE = "routing_stage"
    AWAITING_ROUTING_APPROVAL = "awaiting_routing_approval"
    RELEASE_CHECK = "release_check"
    AWAITING_RELEASE_APPROVAL = "awaiting_release_approval"
    RELEASED = "released"


class AgentState(str, Enum):
    QUEUED = "queued"
    AVAILABLE = "available"
    LEASED = "leased"
    RUNNING = "running"
    OFFLINE = "offline"
    FAILED = "failed"
    RETIRED = "retired"


class AgentClass(str, Enum):
    COORDINATOR = "coordinator"
    INTERVIEWER = "interviewer"
    RESEARCHER = "researcher"
    DOMAIN_DESIGNER = "domain_designer"
    CRITIC = "critic"
    DETERMINISTIC_EXECUTOR = "deterministic_executor"
    VERIFICATION_WORKER = "verification_worker"
    RELEASE_REVIEWER = "release_reviewer"


class RiskClass(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class TaskState(str, Enum):
    QUEUED = "queued"
    BLOCKED = "blocked"
    LEASED = "leased"
    RUNNING = "running"
    RETRY_WAIT = "retry_wait"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskKind(str, Enum):
    RESEARCH = "research"
    DESIGN = "design"
    IMPLEMENT = "implement"
    VERIFY = "verify"
    REVIEW = "review"
    SYNTHESIZE = "synthesize"


class QuestionState(str, Enum):
    OPEN = "open"
    ANSWERED = "answered"
    WITHDRAWN = "withdrawn"


class ApprovalKind(str, Enum):
    BRIEF = "brief"
    ARCHITECTURE_BOM = "architecture_bom"
    SCHEMATIC = "schematic"
    LAYOUT_CONSTRAINTS = "layout_constraints"
    PLACEMENT = "placement"
    ROUTING = "routing"
    RELEASE = "release"
    PLAN = "plan"
    CHANGESET = "changeset"
    EXCEPTION = "exception"


class ApprovalState(str, Enum):
    REQUESTED = "requested"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    REVOKED = "revoked"


class EvidenceKind(str, Enum):
    USER_RESPONSE = "user_response"
    TOOL_OUTPUT = "tool_output"
    ARTIFACT = "artifact"
    DESIGN_CHECK = "design_check"
    TEST_RESULT = "test_result"
    MODEL_TRACE = "model_trace"
    APPROVAL_RECEIPT = "approval_receipt"


class EventType(str, Enum):
    RUN_CREATED = "run.created"
    RUN_PHASE_CHANGED = "run.phase_changed"
    QUESTION_OPENED = "question.opened"
    QUESTION_ANSWERED = "question.answered"
    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_DECIDED = "approval.decided"
    TASK_QUEUED = "task.queued"
    TASK_LEASED = "task.leased"
    TASK_HEARTBEAT = "task.heartbeat"
    TASK_RETRY_SCHEDULED = "task.retry_scheduled"
    TASK_SUCCEEDED = "task.succeeded"
    TASK_FAILED = "task.failed"
    LEASE_EXPIRED = "lease.expired"
    EVIDENCE_CAPTURED = "evidence.captured"
    BUDGET_CHANGED = "budget.changed"


class Priority(IntEnum):
    LOW = 10
    NORMAL = 50
    HIGH = 80
    CRITICAL = 100


TERMINAL_RUN_PHASES = frozenset(
    {RunPhase.COMPLETED, RunPhase.FAILED, RunPhase.CANCELLED}
)
TERMINAL_TASK_STATES = frozenset(
    {TaskState.SUCCEEDED, TaskState.FAILED, TaskState.CANCELLED}
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    if (
        type(prefix) is not str
        or not prefix
        or not prefix.replace("_", "").isalnum()
    ):
        raise DomainError("ID prefixes must be non-empty alphanumeric labels")
    return f"{prefix}_{uuid4().hex}"


def require_aware(value: datetime, label: str = "timestamp") -> None:
    if type(value) is not datetime:
        raise DomainError(f"{label} must be an exact datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        raise DomainError(f"{label} must be timezone-aware")


def canonical_json(value: Any) -> str:
    """Return the single canonical JSON encoding used for hashes and persistence."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class Budget:
    """A run budget; ``None`` limits are intentionally unlimited.

    Reserved quantities prevent concurrent dispatchers from oversubscribing a
    finite budget.  Physical concurrency remains a scheduler concern and is not
    conflated with the total number of agents that may participate over time.
    """

    token_limit: int | None = None
    tool_call_limit: int | None = None
    agent_dispatch_limit: int | None = None
    tokens_used: int = 0
    tokens_reserved: int = 0
    tool_calls_used: int = 0
    tool_calls_reserved: int = 0
    agent_dispatches_used: int = 0
    agent_dispatches_reserved: int = 0

    def __post_init__(self) -> None:
        values = (
            self.token_limit,
            self.tool_call_limit,
            self.agent_dispatch_limit,
            self.tokens_used,
            self.tokens_reserved,
            self.tool_calls_used,
            self.tool_calls_reserved,
            self.agent_dispatches_used,
            self.agent_dispatches_reserved,
        )
        if any(value is not None and type(value) is not int for value in values):
            raise DomainError("budget values must be exact integers or null")
        if any(value is not None and value < 0 for value in values):
            raise DomainError("budget values cannot be negative")
        self._check(self.token_limit, self.tokens_used + self.tokens_reserved, "tokens")
        self._check(
            self.tool_call_limit,
            self.tool_calls_used + self.tool_calls_reserved,
            "tool calls",
        )
        self._check(
            self.agent_dispatch_limit,
            self.agent_dispatches_used + self.agent_dispatches_reserved,
            "agent dispatches",
        )

    @classmethod
    def unlimited(cls) -> "Budget":
        return cls()

    @staticmethod
    def _check(limit: int | None, requested: int, label: str) -> None:
        if limit is not None and requested > limit:
            raise BudgetExceeded(f"{label} budget exceeded: {requested} > {limit}")

    def reserve(
        self, *, tokens: int = 0, tool_calls: int = 0, agent_dispatches: int = 0
    ) -> "Budget":
        quantities = (tokens, tool_calls, agent_dispatches)
        if any(type(value) is not int for value in quantities):
            raise DomainError("reservations must be exact integers")
        if min(quantities) < 0:
            raise DomainError("reservations cannot be negative")
        return replace(
            self,
            tokens_reserved=self.tokens_reserved + tokens,
            tool_calls_reserved=self.tool_calls_reserved + tool_calls,
            agent_dispatches_reserved=self.agent_dispatches_reserved
            + agent_dispatches,
        )

    def settle(
        self,
        *,
        reserved_tokens: int = 0,
        actual_tokens: int = 0,
        reserved_tool_calls: int = 0,
        actual_tool_calls: int = 0,
        reserved_agent_dispatches: int = 0,
        actual_agent_dispatches: int = 0,
    ) -> "Budget":
        quantities = (
            reserved_tokens,
            actual_tokens,
            reserved_tool_calls,
            actual_tool_calls,
            reserved_agent_dispatches,
            actual_agent_dispatches,
        )
        if any(type(value) is not int for value in quantities):
            raise DomainError("settlement quantities must be exact integers")
        if min(quantities) < 0:
            raise DomainError("settlement quantities cannot be negative")
        if reserved_tokens > self.tokens_reserved:
            raise DomainError("cannot settle more reserved tokens than held")
        if reserved_tool_calls > self.tool_calls_reserved:
            raise DomainError("cannot settle more reserved tool calls than held")
        if reserved_agent_dispatches > self.agent_dispatches_reserved:
            raise DomainError("cannot settle more agent dispatches than held")
        return replace(
            self,
            tokens_reserved=self.tokens_reserved - reserved_tokens,
            tokens_used=self.tokens_used + actual_tokens,
            tool_calls_reserved=self.tool_calls_reserved - reserved_tool_calls,
            tool_calls_used=self.tool_calls_used + actual_tool_calls,
            agent_dispatches_reserved=self.agent_dispatches_reserved
            - reserved_agent_dispatches,
            agent_dispatches_used=self.agent_dispatches_used
            + actual_agent_dispatches,
        )


@dataclass(frozen=True, slots=True)
class Run:
    id: RunId
    objective: str
    created_at: datetime
    phase: RunPhase = RunPhase.DRAFT
    coordination_stage: CoordinationStage = CoordinationStage.QUESTIONING
    checkpoint_digest: str | None = None
    coordination_revision: int = 0
    strict_user_coordination: bool = True
    require_plan_approval: bool = True
    require_independent_critic: bool = False
    task_inventory_digest: str | None = None
    plan_digest: str | None = None
    max_concurrency: int = 100
    budget: Budget = field(default_factory=Budget.unlimited)
    revision: int = 0

    def __post_init__(self) -> None:
        if type(self.id) is not str or type(self.objective) is not str:
            raise DomainError("run ID and objective must be exact strings")
        if type(self.created_at) is not datetime:
            raise DomainError("run.created_at must be an exact datetime")
        if type(self.phase) is not RunPhase or type(self.coordination_stage) is not (
            CoordinationStage
        ):
            raise DomainError("run phase and coordination stage must be exact enums")
        if type(self.strict_user_coordination) is not bool or type(
            self.require_plan_approval
        ) is not bool:
            raise DomainError("run coordination gates must be exact booleans")
        if type(self.require_independent_critic) is not bool:
            raise DomainError("run critic gate must be an exact boolean")
        if self.task_inventory_digest is not None and (
            type(self.task_inventory_digest) is not str
            or len(self.task_inventory_digest) != 64
            or any(
                character not in "0123456789abcdef"
                for character in self.task_inventory_digest
            )
        ):
            raise DomainError("run task inventory must be a lowercase SHA-256 digest")
        if (
            type(self.max_concurrency) is not int
            or type(self.revision) is not int
            or type(self.coordination_revision) is not int
        ):
            raise DomainError("run concurrency and revisions must be exact integers")
        if type(self.budget) is not Budget:
            raise DomainError("run budget must be the exact Budget type")
        for value, label in (
            (self.checkpoint_digest, "checkpoint digest"),
            (self.plan_digest, "plan digest"),
        ):
            if value is not None and type(value) is not str:
                raise DomainError(f"run {label} must be an exact string or null")
        require_aware(self.created_at, "run.created_at")
        if not self.id or not self.objective.strip():
            raise DomainError("run ID and objective are required")
        if self.max_concurrency < 1:
            raise DomainError("max_concurrency must be at least one")
        if self.revision < 0 or self.coordination_revision < 0:
            raise DomainError("run revisions cannot be negative")


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 3
    initial_backoff_seconds: int = 5
    multiplier: int = 2
    max_backoff_seconds: int = 300

    def __post_init__(self) -> None:
        if any(
            type(value) is not int
            for value in (
                self.max_attempts,
                self.initial_backoff_seconds,
                self.multiplier,
                self.max_backoff_seconds,
            )
        ):
            raise DomainError("retry policy fields must be exact integers")
        if self.max_attempts < 1:
            raise DomainError("max_attempts must be at least one")
        if self.initial_backoff_seconds < 0 or self.max_backoff_seconds < 0:
            raise DomainError("backoff cannot be negative")
        if self.multiplier < 1:
            raise DomainError("retry multiplier must be at least one")

    def delay_seconds(self, failed_attempt: int) -> int:
        if type(failed_attempt) is not int or failed_attempt < 1:
            raise DomainError("failed_attempt must be at least one")
        delay = self.initial_backoff_seconds * self.multiplier ** (failed_attempt - 1)
        return min(delay, self.max_backoff_seconds)


@dataclass(frozen=True, slots=True)
class CheckRequirement:
    """A deterministic gate bound to one trusted engine and policy revision."""

    check_id: str
    source: str
    policy_digest: str

    def __post_init__(self) -> None:
        if any(
            type(value) is not str
            for value in (self.check_id, self.source, self.policy_digest)
        ):
            raise DomainError("check requirement fields must be exact strings")
        if not self.check_id.strip() or not self.source.strip() or not self.policy_digest:
            raise DomainError(
                "check ID, trusted source, and immutable policy digest are required"
            )


@dataclass(frozen=True, slots=True)
class Lease:
    token: str
    task_id: TaskId
    agent_id: AgentId
    attempt: int
    acquired_at: datetime
    expires_at: datetime
    task_contract_digest: str
    agent_contract_digest: str

    def __post_init__(self) -> None:
        if type(self.task_id) is not str or type(self.agent_id) is not str:
            raise DomainError("lease task and agent IDs must be exact strings")
        if not self.task_id or not self.agent_id:
            raise DomainError("lease task and agent IDs are required")
        if type(self.acquired_at) is not datetime or type(self.expires_at) is not datetime:
            raise DomainError("lease timestamps must be exact datetime values")
        require_aware(self.acquired_at, "lease.acquired_at")
        require_aware(self.expires_at, "lease.expires_at")
        for value, label in (
            (self.token, "lease token"),
            (self.task_contract_digest, "lease task contract digest"),
            (self.agent_contract_digest, "lease agent contract digest"),
        ):
            if (
                type(value) is not str
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise DomainError(f"{label} must be a lowercase SHA-256 digest")
        if type(self.attempt) is not int or self.attempt < 1:
            raise DomainError("lease attempt must be positive")
        if self.expires_at <= self.acquired_at:
            raise DomainError("lease expiry must follow acquisition")


@dataclass(frozen=True, slots=True)
class ReviewedTaskResultBinding:
    task_id: TaskId
    result_digest: str

    def __post_init__(self) -> None:
        if type(self.task_id) is not str or not self.task_id:
            raise DomainError("reviewed result task ID must be an exact string")
        if (
            type(self.result_digest) is not str
            or len(self.result_digest) != 64
            or any(
                character not in "0123456789abcdef"
                for character in self.result_digest
            )
        ):
            raise DomainError("reviewed result must be a lowercase SHA-256 digest")


@dataclass(frozen=True, slots=True)
class Task:
    id: TaskId
    run_id: RunId
    title: str
    instructions: str
    kind: TaskKind
    created_seq: int
    priority: int = int(Priority.NORMAL)
    wave: int = 0
    dependencies: tuple[TaskId, ...] = ()
    required_capabilities: tuple[str, ...] = ()
    required_agent_class: AgentClass | None = None
    excluded_agent_ids: tuple[AgentId, ...] = ()
    risk_class: RiskClass = RiskClass.MEDIUM
    input_revision: str | None = None
    output_schema_digest: str | None = None
    idempotency_key: str | None = None
    required_checks: tuple[CheckRequirement, ...] = ()
    reviewed_task_ids: tuple[TaskId, ...] = ()
    reviewed_result_bindings: tuple[ReviewedTaskResultBinding, ...] = ()
    estimated_tokens: int = 0
    retry_policy: RetryPolicy = field(default_factory=RetryPolicy)
    state: TaskState = TaskState.QUEUED
    attempt: int = 0
    next_eligible_at: datetime | None = None
    lease: Lease | None = None
    result_evidence_ids: tuple[EvidenceId, ...] = ()
    completed_by_agent_id: AgentId | None = None
    failure_code: str | None = None
    failure_message: str | None = None

    def __post_init__(self) -> None:
        if type(self.id) is not str or type(self.run_id) is not str:
            raise DomainError("task and run IDs must be exact strings")
        if type(self.title) is not str or type(self.instructions) is not str:
            raise DomainError("task title and instructions must be exact strings")
        if type(self.kind) is not TaskKind or type(self.state) is not TaskState:
            raise DomainError("task kind and state must be exact enums")
        if type(self.risk_class) is not RiskClass:
            raise DomainError("task risk class must be the exact enum")
        if self.required_agent_class is not None and type(
            self.required_agent_class
        ) is not AgentClass:
            raise DomainError("required agent class must be an exact enum or null")
        if any(
            type(value) is not int
            for value in (
                self.created_seq,
                self.priority,
                self.wave,
                self.estimated_tokens,
                self.attempt,
            )
        ):
            raise DomainError("task numeric fields must be exact integers")
        if type(self.retry_policy) is not RetryPolicy:
            raise DomainError("task retry policy must be the exact RetryPolicy type")
        if self.lease is not None and type(self.lease) is not Lease:
            raise DomainError("task lease must be the exact Lease type or null")
        if any(
            type(value) is not tuple
            for value in (
                self.dependencies,
                self.required_capabilities,
                self.excluded_agent_ids,
                self.required_checks,
                self.reviewed_task_ids,
                self.reviewed_result_bindings,
                self.result_evidence_ids,
            )
        ):
            raise DomainError("task collection fields must be exact tuples")
        for values, label in (
            (self.dependencies, "dependency IDs"),
            (self.required_capabilities, "required capabilities"),
            (self.excluded_agent_ids, "excluded agent IDs"),
            (self.reviewed_task_ids, "reviewed task IDs"),
            (self.result_evidence_ids, "result evidence IDs"),
        ):
            if any(type(value) is not str or not value for value in values):
                raise DomainError(f"task {label} must be exact non-empty strings")
        if any(type(value) is not CheckRequirement for value in self.required_checks):
            raise DomainError("task check requirements must be exact records")
        if any(
            type(value) is not ReviewedTaskResultBinding
            for value in self.reviewed_result_bindings
        ):
            raise DomainError("reviewed result bindings must be exact records")
        binding_task_ids = tuple(
            binding.task_id for binding in self.reviewed_result_bindings
        )
        if len(binding_task_ids) != len(set(binding_task_ids)):
            raise DomainError("reviewed result binding task IDs must be unique")
        if any(task_id not in self.reviewed_task_ids for task_id in binding_task_ids):
            raise DomainError("result binding must name a declared reviewed task")
        if self.completed_by_agent_id is not None and (
            type(self.completed_by_agent_id) is not str
            or not self.completed_by_agent_id
        ):
            raise DomainError("task completing agent ID must be an exact string or null")
        for value, label in (
            (self.input_revision, "input revision"),
            (self.output_schema_digest, "output schema digest"),
            (self.idempotency_key, "idempotency key"),
            (self.failure_code, "failure code"),
            (self.failure_message, "failure message"),
        ):
            if value is not None and type(value) is not str:
                raise DomainError(f"task {label} must be an exact string or null")
        if self.next_eligible_at is not None and type(
            self.next_eligible_at
        ) is not datetime:
            raise DomainError("task next eligibility must be an exact datetime or null")
        if not self.id or not self.run_id or not self.title.strip():
            raise DomainError("task ID, run ID, and title are required")
        if self.created_seq < 0 or self.wave < 0 or self.attempt < 0:
            raise DomainError("task sequence, wave, and attempt cannot be negative")
        if self.estimated_tokens < 0:
            raise DomainError("estimated_tokens cannot be negative")
        if self.id in self.dependencies:
            raise DomainError("a task cannot depend on itself")
        if len(self.dependencies) != len(set(self.dependencies)):
            raise DomainError("task dependencies must be unique")
        if len(self.excluded_agent_ids) != len(set(self.excluded_agent_ids)):
            raise DomainError("excluded agent IDs must be unique")
        if len(self.required_capabilities) != len(set(self.required_capabilities)):
            raise DomainError("required capabilities must be unique")
        if len(self.reviewed_task_ids) != len(set(self.reviewed_task_ids)):
            raise DomainError("reviewed task IDs must be unique")
        if self.id in self.reviewed_task_ids:
            raise DomainError("a review task cannot review itself")
        if self.reviewed_task_ids:
            if self.kind is not TaskKind.REVIEW:
                raise DomainError("only review tasks may name reviewed tasks")
            if not set(self.reviewed_task_ids).issubset(self.dependencies):
                raise DomainError("reviewed tasks must also be dependencies")
        check_ids = tuple(requirement.check_id for requirement in self.required_checks)
        if len(check_ids) != len(set(check_ids)):
            raise DomainError("required checks must be unique")
        if self.next_eligible_at is not None:
            require_aware(self.next_eligible_at, "task.next_eligible_at")
        if self.state in {TaskState.LEASED, TaskState.RUNNING} and self.lease is None:
            raise DomainError("leased/running tasks require an active lease")
        if self.state not in {TaskState.LEASED, TaskState.RUNNING} and self.lease is not None:
            raise DomainError("only leased/running tasks may carry an active lease")
        if self.lease is not None and self.lease.task_id != self.id:
            raise DomainError("task lease references a different task")
        if self.lease is not None and self.lease.attempt != self.attempt:
            raise DomainError("task lease attempt must match the task attempt")
        if (
            self.completed_by_agent_id is not None
            and self.state is not TaskState.SUCCEEDED
        ):
            raise DomainError("only succeeded tasks may name their completing agent")


def task_contract_digest(task: Task) -> str:
    """Hash the immutable scheduling and review contract of one exact task."""

    if type(task) is not Task:
        raise DomainError("task contract hashing requires an exact Task")
    payload = {
        "scope": "flux-clone-orchestrator-task-contract-v1",
        "run_id": str(task.run_id),
        "task_id": str(task.id),
        "title": task.title,
        "instructions": task.instructions,
        "kind": task.kind.value,
        "created_seq": task.created_seq,
        "priority": task.priority,
        "wave": task.wave,
        "dependencies": sorted(str(item) for item in task.dependencies),
        "required_capabilities": sorted(task.required_capabilities),
        "required_agent_class": (
            task.required_agent_class.value
            if task.required_agent_class is not None
            else None
        ),
        "excluded_agent_ids": sorted(str(item) for item in task.excluded_agent_ids),
        "risk_class": task.risk_class.value,
        "input_revision": task.input_revision,
        "output_schema_digest": task.output_schema_digest,
        "idempotency_key": task.idempotency_key,
        "required_checks": [
            {
                "check_id": item.check_id,
                "source": item.source,
                "policy_digest": item.policy_digest,
            }
            for item in sorted(task.required_checks, key=lambda item: item.check_id)
        ],
        "reviewed_task_ids": sorted(str(item) for item in task.reviewed_task_ids),
        "reviewed_result_bindings": [
            {
                "task_id": str(binding.task_id),
                "result_digest": binding.result_digest,
            }
            for binding in sorted(
                task.reviewed_result_bindings,
                key=lambda item: str(item.task_id),
            )
        ],
        "estimated_tokens": task.estimated_tokens,
        "retry_policy": {
            "max_attempts": task.retry_policy.max_attempts,
            "initial_backoff_seconds": task.retry_policy.initial_backoff_seconds,
            "multiplier": task.retry_policy.multiplier,
            "max_backoff_seconds": task.retry_policy.max_backoff_seconds,
        },
    }
    return sha256_text(canonical_json(payload))


def task_inventory_digest(run_id: RunId, tasks: Sequence[Task]) -> str:
    """Bind a run to the complete unique set of immutable task contracts."""

    if type(run_id) is not str or not run_id:
        raise DomainError("task inventory requires an exact run ID")
    exact_tasks = tuple(tasks)
    if any(type(task) is not Task for task in exact_tasks):
        raise DomainError("task inventory requires exact Task records")
    if any(task.run_id != run_id for task in exact_tasks):
        raise DomainError("task inventory contains a task from another run")
    if len({task.id for task in exact_tasks}) != len(exact_tasks):
        raise DomainError("task inventory IDs must be unique")
    payload = {
        "scope": "flux-clone-orchestrator-task-inventory-v1",
        "run_id": str(run_id),
        "tasks": [
            {"task_id": str(task.id), "contract_digest": task_contract_digest(task)}
            for task in sorted(exact_tasks, key=lambda item: str(item.id))
        ],
    }
    return sha256_text(canonical_json(payload))


@dataclass(frozen=True, slots=True)
class Agent:
    id: AgentId
    run_id: RunId
    name: str
    created_seq: int
    agent_class: AgentClass = AgentClass.RESEARCHER
    parent_agent_id: AgentId | None = None
    capabilities: tuple[str, ...] = ()
    state: AgentState = AgentState.QUEUED
    wave: int = 0
    current_task_id: TaskId | None = None
    last_heartbeat_at: datetime | None = None

    def __post_init__(self) -> None:
        if any(
            type(value) is not str
            for value in (self.id, self.run_id, self.name)
        ):
            raise DomainError("agent identity fields must be exact strings")
        if type(self.created_seq) is not int or type(self.wave) is not int:
            raise DomainError("agent sequence and wave must be exact integers")
        if type(self.agent_class) is not AgentClass or type(self.state) is not AgentState:
            raise DomainError("agent class and state must be exact enums")
        if self.parent_agent_id is not None:
            if type(self.parent_agent_id) is not str:
                raise DomainError("parent agent ID must be an exact string or null")
            if self.parent_agent_id == self.id:
                raise DomainError("an agent cannot be its own parent")
        if type(self.capabilities) is not tuple or any(
            type(value) is not str or not value for value in self.capabilities
        ):
            raise DomainError("agent capabilities must be exact non-empty strings")
        if self.current_task_id is not None and type(self.current_task_id) is not str:
            raise DomainError("current task ID must be an exact string or null")
        if self.last_heartbeat_at is not None and type(
            self.last_heartbeat_at
        ) is not datetime:
            raise DomainError("agent heartbeat must be an exact datetime or null")
        if not self.id or not self.run_id or not self.name.strip():
            raise DomainError("agent ID, run ID, and name are required")
        if self.created_seq < 0 or self.wave < 0:
            raise DomainError("agent sequence and wave cannot be negative")
        if len(self.capabilities) != len(set(self.capabilities)):
            raise DomainError("agent capabilities must be unique")
        if self.last_heartbeat_at is not None:
            require_aware(self.last_heartbeat_at, "agent.last_heartbeat_at")
        if self.state in {AgentState.LEASED, AgentState.RUNNING}:
            if self.current_task_id is None:
                raise DomainError("leased/running agents require a current task")
        elif self.current_task_id is not None:
            raise DomainError("only leased/running agents may reference a current task")


@dataclass(frozen=True, slots=True)
class Question:
    id: QuestionId
    run_id: RunId
    prompt: str
    rationale: str
    asked_at: datetime
    blocking: bool = True
    options: tuple[str, ...] = ()
    recommendation: str | None = None
    confidence_basis_points: int | None = None
    allow_custom_answer: bool = False
    bound_revision: str | None = None
    affected_artifact_ids: tuple[str, ...] = ()
    dependent_decision_ids: tuple[str, ...] = ()
    state: QuestionState = QuestionState.OPEN
    answer: str | None = None
    answered_by: str | None = None
    answered_at: datetime | None = None

    def __post_init__(self) -> None:
        if any(
            type(value) is not str
            for value in (self.id, self.run_id, self.prompt, self.rationale)
        ):
            raise DomainError("question identity and text must be exact strings")
        if type(self.asked_at) is not datetime:
            raise DomainError("question asked_at must be an exact datetime")
        if type(self.blocking) is not bool or type(self.allow_custom_answer) is not bool:
            raise DomainError("question boolean fields must be exact booleans")
        for values, label in (
            (self.options, "options"),
            (self.affected_artifact_ids, "affected artifact IDs"),
            (self.dependent_decision_ids, "dependent decision IDs"),
        ):
            if type(values) is not tuple or any(
                type(value) is not str or not value for value in values
            ):
                raise DomainError(f"question {label} must be exact non-empty strings")
        for value, label in (
            (self.recommendation, "recommendation"),
            (self.bound_revision, "bound revision"),
            (self.answer, "answer"),
            (self.answered_by, "answering actor"),
        ):
            if value is not None and type(value) is not str:
                raise DomainError(f"question {label} must be an exact string or null")
        if self.confidence_basis_points is not None and type(
            self.confidence_basis_points
        ) is not int:
            raise DomainError("question confidence must be an exact integer or null")
        if type(self.state) is not QuestionState:
            raise DomainError("question state must be the exact enum")
        if self.answered_at is not None and type(self.answered_at) is not datetime:
            raise DomainError("question answered_at must be an exact datetime or null")
        require_aware(self.asked_at, "question.asked_at")
        if self.answered_at is not None:
            require_aware(self.answered_at, "question.answered_at")
        if not self.id or not self.run_id or not self.prompt.strip():
            raise DomainError("question ID, run ID, and prompt are required")
        if self.blocking:
            if len(self.options) < 2:
                raise DomainError("blocking questions require at least two explicit options")
            if self.recommendation not in self.options:
                raise DomainError("blocking questions require a recommended declared option")
            if self.confidence_basis_points is None:
                raise DomainError("blocking questions require recommendation confidence")
            if not self.bound_revision:
                raise DomainError("blocking questions must bind to an exact revision")
        if self.confidence_basis_points is not None and not (
            0 <= self.confidence_basis_points <= 10_000
        ):
            raise DomainError("question confidence must be from 0 to 10,000 basis points")
        if self.state is QuestionState.ANSWERED and not (self.answer and self.answered_by):
            raise DomainError("answered questions require an answer and actor")


@dataclass(frozen=True, slots=True)
class Approval:
    id: ApprovalId
    run_id: RunId
    kind: ApprovalKind
    subject_digest: str
    summary: str
    requested_at: datetime
    expires_at: datetime | None = None
    state: ApprovalState = ApprovalState.REQUESTED
    decided_by: str | None = None
    decided_at: datetime | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if any(
            type(value) is not str
            for value in (
                self.id,
                self.run_id,
                self.subject_digest,
                self.summary,
            )
        ):
            raise DomainError("approval identity and text must be exact strings")
        if type(self.kind) is not ApprovalKind or type(self.state) is not ApprovalState:
            raise DomainError("approval kind and state must be exact enums")
        if type(self.requested_at) is not datetime:
            raise DomainError("approval requested_at must be an exact datetime")
        for value, label in (
            (self.expires_at, "expiry"),
            (self.decided_at, "decision timestamp"),
        ):
            if value is not None and type(value) is not datetime:
                raise DomainError(f"approval {label} must be an exact datetime or null")
        for value, label in (
            (self.decided_by, "decision actor"),
            (self.reason, "reason"),
        ):
            if value is not None and type(value) is not str:
                raise DomainError(f"approval {label} must be an exact string or null")
        require_aware(self.requested_at, "approval.requested_at")
        if self.expires_at is not None:
            require_aware(self.expires_at, "approval.expires_at")
        if self.decided_at is not None:
            require_aware(self.decided_at, "approval.decided_at")
        if not self.id or not self.run_id or not self.subject_digest:
            raise DomainError("approval ID, run ID, and subject digest are required")
        if self.expires_at is not None and self.expires_at <= self.requested_at:
            raise DomainError("approval expiry must follow its request")
        if self.state is not ApprovalState.REQUESTED and not self.decided_at:
            raise DomainError("decided approvals require a decision timestamp")

    def is_valid_for(self, digest: str, at: datetime) -> bool:
        if type(digest) is not str:
            raise DomainError("approval digest must be an exact string")
        require_aware(at)
        return (
            self.state is ApprovalState.APPROVED
            and self.subject_digest == digest
            and (self.expires_at is None or at < self.expires_at)
        )


@dataclass(frozen=True, slots=True)
class Evidence:
    id: EvidenceId
    run_id: RunId
    kind: EvidenceKind
    source: str
    content_digest: str
    summary: str
    captured_at: datetime
    task_id: TaskId | None = None
    check_id: str | None = None
    policy_digest: str | None = None
    passed: bool | None = None
    metadata_json: str = "{}"

    def __post_init__(self) -> None:
        if any(
            type(value) is not str
            for value in (
                self.id,
                self.run_id,
                self.source,
                self.content_digest,
                self.summary,
                self.metadata_json,
            )
        ):
            raise DomainError("evidence identity and text fields must be exact strings")
        if type(self.kind) is not EvidenceKind or type(self.captured_at) is not datetime:
            raise DomainError("evidence kind and timestamp must be exact types")
        for value, label in (
            (self.task_id, "task ID"),
            (self.check_id, "check ID"),
            (self.policy_digest, "policy digest"),
        ):
            if value is not None and type(value) is not str:
                raise DomainError(f"evidence {label} must be an exact string or null")
        if self.passed is not None and type(self.passed) is not bool:
            raise DomainError("evidence passed must be an exact boolean or null")
        require_aware(self.captured_at, "evidence.captured_at")
        if not self.id or not self.run_id or not self.source or not self.content_digest:
            raise DomainError("evidence ID, run ID, source, and digest are required")
        if self.kind is EvidenceKind.DESIGN_CHECK and (
            not self.check_id or not self.policy_digest or self.passed is None
        ):
            raise DomainError(
                "design-check evidence requires check_id, policy_digest, and passed"
            )
        try:
            decoded = json.loads(self.metadata_json)
        except json.JSONDecodeError as exc:
            raise DomainError("evidence metadata_json must be valid JSON") from exc
        if type(decoded) is not dict:
            raise DomainError("evidence metadata_json must encode an object")
        if canonical_json(decoded) != self.metadata_json:
            raise DomainError("evidence metadata_json must use canonical JSON")

    @classmethod
    def capture(
        cls,
        *,
        evidence_id: EvidenceId,
        run_id: RunId,
        kind: EvidenceKind,
        source: str,
        content: bytes | str,
        summary: str,
        captured_at: datetime,
        task_id: TaskId | None = None,
        check_id: str | None = None,
        policy_digest: str | None = None,
        passed: bool | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> "Evidence":
        if type(content) is not bytes and type(content) is not str:
            raise DomainError("evidence content must be exact bytes or an exact string")
        if metadata is not None and type(metadata) is not dict:
            raise DomainError("evidence metadata must be an exact object or null")
        raw = content if isinstance(content, bytes) else content.encode("utf-8")
        return cls(
            id=evidence_id,
            run_id=run_id,
            kind=kind,
            source=source,
            content_digest=hashlib.sha256(raw).hexdigest(),
            summary=summary,
            captured_at=captured_at,
            task_id=task_id,
            check_id=check_id,
            policy_digest=policy_digest,
            passed=passed,
            metadata_json=canonical_json(metadata or {}),
        )


def task_result_digest(task: Task, evidence: Sequence[Evidence]) -> str:
    """Bind one completed task result to its exact immutable evidence records."""

    if type(task) is not Task or task.state is not TaskState.SUCCEEDED:
        raise DomainError("task result hashing requires an exact succeeded Task")
    if task.completed_by_agent_id is None or not task.result_evidence_ids:
        raise DomainError("task result requires its completing agent and evidence IDs")
    exact_evidence = tuple(evidence)
    if any(type(item) is not Evidence for item in exact_evidence):
        raise DomainError("task result requires exact Evidence records")
    evidence_by_id = {item.id: item for item in exact_evidence}
    if len(evidence_by_id) != len(exact_evidence) or set(evidence_by_id) != set(
        task.result_evidence_ids
    ):
        raise DomainError("task result evidence set does not match its declared IDs")
    if any(
        item.run_id != task.run_id or item.task_id != task.id
        for item in exact_evidence
    ):
        raise DomainError("task result evidence is bound to another run or task")
    payload = {
        "scope": "flux-clone-orchestrator-task-result-v1",
        "task_contract_digest": task_contract_digest(task),
        "completed_by_agent_id": str(task.completed_by_agent_id),
        "evidence": [
            {
                "id": str(item.id),
                "kind": item.kind.value,
                "source": item.source,
                "content_digest": item.content_digest,
                "summary": item.summary,
                "captured_at": item.captured_at.astimezone(timezone.utc).isoformat(),
                "check_id": item.check_id,
                "policy_digest": item.policy_digest,
                "passed": item.passed,
                "metadata_json": item.metadata_json,
            }
            for item in sorted(exact_evidence, key=lambda value: str(value.id))
        ],
    }
    return sha256_text(canonical_json(payload))


@dataclass(frozen=True, slots=True)
class OrchestrationEvent:
    id: EventId
    run_id: RunId
    sequence: int
    type: EventType
    actor: str
    occurred_at: datetime
    aggregate_id: str
    payload_json: str
    evidence_ids: tuple[EvidenceId, ...]
    previous_hash: str
    event_hash: str

    def __post_init__(self) -> None:
        if type(self) is not OrchestrationEvent:
            raise DomainError("event records must use the exact OrchestrationEvent type")
        for value, label in (
            (self.id, "ID"),
            (self.run_id, "run ID"),
            (self.actor, "actor"),
            (self.aggregate_id, "aggregate ID"),
            (self.payload_json, "payload JSON"),
            (self.previous_hash, "previous hash"),
            (self.event_hash, "event hash"),
        ):
            if type(value) is not str:
                raise DomainError(f"event {label} must be an exact string")
        if not self.id or not self.run_id or not self.actor or not self.aggregate_id:
            raise DomainError("event ID, run ID, actor, and aggregate ID are required")
        if type(self.sequence) is not int:
            raise DomainError("event sequence must be an exact integer")
        if type(self.type) is not EventType:
            raise DomainError("event type must be the exact EventType enum")
        if type(self.occurred_at) is not datetime:
            raise DomainError("event occurred_at must be an exact datetime")
        if type(self.evidence_ids) is not tuple or any(
            type(value) is not str or not value for value in self.evidence_ids
        ):
            raise DomainError("event evidence IDs must be exact non-empty strings")
        if len(self.evidence_ids) != len(set(self.evidence_ids)):
            raise DomainError("event evidence IDs must be unique")
        if self.previous_hash and (
            len(self.previous_hash) != 64
            or any(character not in "0123456789abcdef" for character in self.previous_hash)
        ):
            raise DomainError("event previous hash must be empty or a lowercase SHA-256 digest")
        if len(self.event_hash) != 64 or any(
            character not in "0123456789abcdef" for character in self.event_hash
        ):
            raise DomainError("event hash must be a lowercase SHA-256 digest")
        require_aware(self.occurred_at, "event.occurred_at")
        if self.sequence < 1:
            raise DomainError("event sequence must be positive")
        try:
            decoded_payload = json.loads(self.payload_json)
        except (json.JSONDecodeError, ValueError) as exc:
            raise DomainError("event payload_json must be valid JSON") from exc
        if type(decoded_payload) is not dict:
            raise DomainError("event payload_json must encode an object")
        try:
            canonical_payload = canonical_json(decoded_payload)
        except (TypeError, ValueError) as exc:
            raise DomainError("event payload_json must contain canonical JSON values") from exc
        if canonical_payload != self.payload_json:
            raise DomainError("event payload_json must be canonical JSON")
        if not OrchestrationEvent.validate_hash(self):
            raise DomainError("event hash does not match event contents")

    @classmethod
    def create(
        cls,
        *,
        event_id: EventId,
        run_id: RunId,
        sequence: int,
        type: EventType,
        actor: str,
        occurred_at: datetime,
        aggregate_id: str,
        payload: Mapping[str, Any] | None = None,
        evidence_ids: tuple[EvidenceId, ...] = (),
        previous_hash: str = "",
    ) -> "OrchestrationEvent":
        if cls is not OrchestrationEvent:
            raise DomainError("event creation requires the exact OrchestrationEvent type")
        for value, label in (
            (event_id, "ID"),
            (run_id, "run ID"),
            (actor, "actor"),
            (aggregate_id, "aggregate ID"),
            (previous_hash, "previous hash"),
        ):
            if builtins.type(value) is not str:
                raise DomainError(f"event {label} must be an exact string")
        if builtins.type(sequence) is not int:
            raise DomainError("event sequence must be an exact integer")
        if builtins.type(type) is not EventType:
            raise DomainError("event type must be the exact EventType enum")
        if builtins.type(occurred_at) is not datetime:
            raise DomainError("event occurred_at must be an exact datetime")
        require_aware(occurred_at, "event.occurred_at")
        if payload is not None and builtins.type(payload) is not dict:
            raise DomainError("event payload must be an exact object or null")
        if builtins.type(evidence_ids) is not tuple or any(
            builtins.type(value) is not str or not value for value in evidence_ids
        ):
            raise DomainError("event evidence IDs must be exact non-empty strings")
        exact_evidence_ids = evidence_ids
        try:
            payload_json = canonical_json(payload or {})
        except (TypeError, ValueError) as exc:
            raise DomainError("event payload must contain canonical JSON values") from exc
        material = cls._hash_material(
            event_id=event_id,
            run_id=run_id,
            sequence=sequence,
            type=type,
            actor=actor,
            occurred_at=occurred_at,
            aggregate_id=aggregate_id,
            payload_json=payload_json,
            evidence_ids=exact_evidence_ids,
            previous_hash=previous_hash,
        )
        return cls(
            id=event_id,
            run_id=run_id,
            sequence=sequence,
            type=type,
            actor=actor,
            occurred_at=occurred_at,
            aggregate_id=aggregate_id,
            payload_json=payload_json,
            evidence_ids=exact_evidence_ids,
            previous_hash=previous_hash,
            event_hash=sha256_text(material),
        )

    @staticmethod
    def _hash_material(**values: Any) -> str:
        occurred_at = values["occurred_at"]
        require_aware(occurred_at)
        body = {
            "id": str(values["event_id"]),
            "run_id": str(values["run_id"]),
            "sequence": values["sequence"],
            "type": values["type"].value,
            "actor": values["actor"],
            "occurred_at": occurred_at.isoformat(),
            "aggregate_id": values["aggregate_id"],
            "payload_json": values["payload_json"],
            "evidence_ids": [str(item) for item in values["evidence_ids"]],
            "previous_hash": values["previous_hash"],
        }
        return canonical_json(body)

    def validate_hash(self) -> bool:
        if type(self) is not OrchestrationEvent:
            return False
        material = OrchestrationEvent._hash_material(
            event_id=self.id,
            run_id=self.run_id,
            sequence=self.sequence,
            type=self.type,
            actor=self.actor,
            occurred_at=self.occurred_at,
            aggregate_id=self.aggregate_id,
            payload_json=self.payload_json,
            evidence_ids=self.evidence_ids,
            previous_hash=self.previous_hash,
        )
        return self.event_hash == sha256_text(material)


def assert_acyclic(tasks: Sequence[Task]) -> None:
    """Validate the task DAG and reject missing or cross-run dependencies."""

    exact_tasks = tuple(tasks)
    if any(type(task) is not Task for task in exact_tasks):
        raise DomainError("task graph requires exact Task records")
    by_id = {task.id: task for task in exact_tasks}
    if len(by_id) != len(exact_tasks):
        raise DomainError("task IDs must be unique")
    for task in exact_tasks:
        for dependency in task.dependencies:
            if dependency not in by_id:
                raise DomainError(f"task {task.id} has missing dependency {dependency}")
            if by_id[dependency].run_id != task.run_id:
                raise DomainError("task dependencies cannot cross runs")

    visiting: set[TaskId] = set()
    visited: set[TaskId] = set()

    def visit(task_id: TaskId) -> None:
        if task_id in visiting:
            raise DomainError(f"task dependency cycle includes {task_id}")
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in by_id[task_id].dependencies:
            visit(dependency)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in sorted(by_id, key=str):
        visit(task_id)

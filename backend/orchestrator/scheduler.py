"""Deterministic wave scheduler with leases, retries, and hard evidence gates."""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar

from .models import (
    Agent,
    AgentId,
    AgentState,
    Budget,
    BudgetExceeded,
    DomainError,
    Evidence,
    EvidenceKind,
    Lease,
    Run,
    RunPhase,
    Task,
    TaskId,
    TaskState,
    assert_acyclic,
    canonical_json,
    require_aware,
    task_contract_digest,
)


class SchedulingError(DomainError):
    """Raised when a scheduler operation would violate a run invariant."""


class LeaseRejected(SchedulingError):
    """Raised for stale, forged, expired, or mismatched lease operations."""


class EvidenceRejected(SchedulingError):
    """Raised when a task result lacks its deterministic verification evidence."""


@dataclass(frozen=True, slots=True)
class Dispatch:
    task_id: TaskId
    agent_id: AgentId
    lease: Lease
    reserved_tokens: int


@dataclass(frozen=True, slots=True)
class ScheduleResult:
    tasks: tuple[Task, ...]
    agents: tuple[Agent, ...]
    budget: Budget
    dispatches: tuple[Dispatch, ...]
    blocked_task_ids: tuple[TaskId, ...] = ()
    budget_deferred_task_ids: tuple[TaskId, ...] = ()


@dataclass(frozen=True, slots=True)
class CompletionResult:
    task: Task
    agent: Agent
    budget: Budget


@dataclass(frozen=True, slots=True)
class ReapResult:
    tasks: tuple[Task, ...]
    agents: tuple[Agent, ...]
    budget: Budget
    expired_task_ids: tuple[TaskId, ...]


def _task_order(task: Task) -> tuple[int, int, int, str]:
    return (task.wave, -task.priority, task.created_seq, str(task.id))


def _agent_order(agent: Agent) -> tuple[int, int, str]:
    return (agent.wave, agent.created_seq, str(agent.id))


T = TypeVar("T")


def _index_unique(
    items: Sequence[T], id_getter: Callable[[T], Any]
) -> dict[str, T]:
    result: dict[str, T] = {}
    for item in items:
        key = str(id_getter(item))
        if key in result:
            raise SchedulingError(f"duplicate ID {key}")
        result[key] = item
    return result


def _canonical_time(value: datetime) -> str:
    require_aware(value)
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _snapshot_time(value: datetime, label: str) -> datetime:
    """Read caller timezone behavior once and return a fixed UTC value."""

    if type(value) is not datetime:
        raise SchedulingError(f"{label} must be an exact datetime")
    try:
        offset = value.utcoffset()
    except (TypeError, ValueError, OverflowError) as exc:
        raise SchedulingError(f"{label} has an invalid timezone offset") from exc
    if type(offset) is not timedelta:
        raise SchedulingError(f"{label} must be timezone-aware")
    try:
        return (value.replace(tzinfo=None) - offset).replace(tzinfo=UTC)
    except OverflowError as exc:
        raise SchedulingError(f"{label} is outside the UTC datetime range") from exc


def _agent_contract_digest(agent: Agent) -> str:
    """Hash immutable worker identity and capability claims for one lease."""

    if type(agent) is not Agent:
        raise SchedulingError("agent contract hashing requires an exact Agent record")

    payload = {
        "scope": "flux-clone-orchestrator-agent-contract-v1",
        "run_id": str(agent.run_id),
        "agent_id": str(agent.id),
        "name": agent.name,
        "created_seq": agent.created_seq,
        "agent_class": agent.agent_class.value,
        "parent_agent_id": (
            str(agent.parent_agent_id) if agent.parent_agent_id is not None else None
        ),
        "capabilities": sorted(agent.capabilities),
        "wave": agent.wave,
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


class DeterministicScheduler:
    """Pure scheduler suitable for transaction retries and event replay.

    A run may enqueue any number of agents and tasks.  Only ``max_concurrency``
    leases exist at once; higher waves remain dormant behind a deterministic
    barrier.  This gives effectively unbounded total participation while keeping
    resource use and ordering controlled.
    """

    @classmethod
    def schedule(
        cls,
        run: Run,
        tasks: Sequence[Task],
        agents: Sequence[Agent],
        *,
        at: datetime,
        lease_signing_key: bytes,
        lease_seconds: int = 120,
        budget: Budget | None = None,
    ) -> ScheduleResult:
        if cls is not DeterministicScheduler:
            raise SchedulingError("scheduler operations require DeterministicScheduler")
        if type(run) is not Run:
            raise SchedulingError("scheduler requires an exact Run record")
        at = _snapshot_time(at, "scheduler timestamp")
        if type(lease_seconds) is not int:
            raise SchedulingError("lease_seconds must be an exact integer")
        if budget is not None and type(budget) is not Budget:
            raise SchedulingError("scheduler requires an exact Budget record")
        exact_tasks = tuple(tasks)
        exact_agents = tuple(agents)
        cls._validate_membership(run, exact_tasks, exact_agents)
        if run.phase is not RunPhase.EXECUTING:
            raise SchedulingError("tasks may only be dispatched while a run is executing")
        if lease_seconds < 1:
            raise SchedulingError("lease_seconds must be positive")
        if type(lease_signing_key) is not bytes or len(lease_signing_key) < 32:
            raise SchedulingError("lease_signing_key must contain at least 32 bytes")
        assert_acyclic(exact_tasks)

        current_budget = run.budget if budget is None else budget
        reaped = cls.reap_expired_leases(
            exact_tasks,
            exact_agents,
            budget=current_budget,
            at=at,
            lease_signing_key=lease_signing_key,
        )
        mutable_tasks = {task.id: task for task in reaped.tasks}
        mutable_agents = {agent.id: agent for agent in reaped.agents}
        current_budget = reaped.budget

        blocked: list[TaskId] = []
        for task in sorted(mutable_tasks.values(), key=_task_order):
            if task.state not in {TaskState.QUEUED, TaskState.RETRY_WAIT, TaskState.BLOCKED}:
                continue
            dependency_states = [
                mutable_tasks[dependency].state for dependency in task.dependencies
            ]
            if any(
                state in {TaskState.FAILED, TaskState.CANCELLED}
                for state in dependency_states
            ):
                mutable_tasks[task.id] = replace(
                    task,
                    state=TaskState.BLOCKED,
                    failure_code="dependency_failed",
                    failure_message="a required dependency did not succeed",
                )
                blocked.append(task.id)
            elif task.state is TaskState.BLOCKED:
                mutable_tasks[task.id] = replace(
                    task,
                    state=TaskState.QUEUED,
                    failure_code=None,
                    failure_message=None,
                )

        active = sum(
            task.state in {TaskState.LEASED, TaskState.RUNNING}
            for task in mutable_tasks.values()
        )
        slots = max(0, run.max_concurrency - active)
        if slots == 0:
            return cls._result(
                mutable_tasks,
                mutable_agents,
                current_budget,
                (),
                blocked,
                (),
            )

        candidates = [
            task
            for task in mutable_tasks.values()
            if cls._is_eligible(task, mutable_tasks, at)
        ]
        if candidates:
            # Strict barrier: a later wave cannot begin until all earlier waves
            # are terminal-success.  This makes a replay independent of worker timing.
            eligible_wave = min(task.wave for task in candidates)
            candidates = [task for task in candidates if task.wave == eligible_wave]
        candidates.sort(key=_task_order)

        available_agents = [
            agent
            for agent in mutable_agents.values()
            if agent.state in {AgentState.QUEUED, AgentState.AVAILABLE}
            and agent.current_task_id is None
        ]
        dispatches: list[Dispatch] = []
        budget_deferred: list[TaskId] = []

        for task in candidates:
            if len(dispatches) >= slots:
                break
            if task.reviewed_task_ids and {
                binding.task_id for binding in task.reviewed_result_bindings
            } != set(task.reviewed_task_ids):
                continue
            dynamically_excluded: set[AgentId] = set()
            all_reviewed_tasks_have_completers = True
            for reviewed_task_id in task.reviewed_task_ids:
                completing_agent_id = mutable_tasks[
                    reviewed_task_id
                ].completed_by_agent_id
                if completing_agent_id is None:
                    all_reviewed_tasks_have_completers = False
                    break
                dynamically_excluded.add(completing_agent_id)
            if not all_reviewed_tasks_have_completers:
                continue
            agent = cls._best_agent(
                task,
                available_agents,
                dynamically_excluded_agent_ids=dynamically_excluded,
            )
            if agent is None:
                continue
            try:
                reserved = current_budget.reserve(
                    tokens=task.estimated_tokens, agent_dispatches=1
                )
            except BudgetExceeded:
                budget_deferred.append(task.id)
                continue

            attempt = task.attempt + 1
            expires_at = at + timedelta(seconds=lease_seconds)
            immutable_task_digest = task_contract_digest(task)
            agent_contract_digest = _agent_contract_digest(agent)
            lease = Lease(
                token=cls._lease_token(
                    run_id=run.id,
                    task_id=task.id,
                    agent_id=agent.id,
                    attempt=attempt,
                    acquired_at=at,
                    expires_at=expires_at,
                    task_contract_digest=immutable_task_digest,
                    agent_contract_digest=agent_contract_digest,
                    signing_key=lease_signing_key,
                ),
                task_id=task.id,
                agent_id=agent.id,
                attempt=attempt,
                acquired_at=at,
                expires_at=expires_at,
                task_contract_digest=immutable_task_digest,
                agent_contract_digest=agent_contract_digest,
            )
            leased_task = replace(
                task,
                state=TaskState.LEASED,
                attempt=attempt,
                next_eligible_at=None,
                lease=lease,
                failure_code=None,
                failure_message=None,
            )
            leased_agent = replace(
                agent,
                state=AgentState.LEASED,
                current_task_id=task.id,
                last_heartbeat_at=at,
            )
            mutable_tasks[task.id] = leased_task
            mutable_agents[agent.id] = leased_agent
            current_budget = reserved
            available_agents.remove(agent)
            dispatches.append(
                Dispatch(
                    task_id=task.id,
                    agent_id=agent.id,
                    lease=lease,
                    reserved_tokens=task.estimated_tokens,
                )
            )

        return cls._result(
            mutable_tasks,
            mutable_agents,
            current_budget,
            dispatches,
            blocked,
            budget_deferred,
        )

    @classmethod
    def start(
        cls,
        task: Task,
        agent: Agent,
        *,
        lease_token: str,
        lease_signing_key: bytes,
        at: datetime,
    ) -> tuple[Task, Agent]:
        if cls is not DeterministicScheduler:
            raise SchedulingError("scheduler operations require DeterministicScheduler")
        at = _snapshot_time(at, "scheduler timestamp")
        cls._validate_lease(
            task,
            agent,
            lease_token,
            at,
            lease_signing_key=lease_signing_key,
        )
        if task.state is not TaskState.LEASED or agent.state is not AgentState.LEASED:
            raise LeaseRejected("only a newly leased assignment can be started")
        return (
            replace(task, state=TaskState.RUNNING),
            replace(agent, state=AgentState.RUNNING, last_heartbeat_at=at),
        )

    @classmethod
    def heartbeat(
        cls,
        task: Task,
        agent: Agent,
        *,
        lease_token: str,
        lease_signing_key: bytes,
        at: datetime,
        lease_seconds: int = 120,
    ) -> tuple[Task, Agent]:
        if cls is not DeterministicScheduler:
            raise SchedulingError("scheduler operations require DeterministicScheduler")
        at = _snapshot_time(at, "scheduler timestamp")
        lease = cls._validate_lease(
            task,
            agent,
            lease_token,
            at,
            lease_signing_key=lease_signing_key,
        )
        if task.state not in {TaskState.LEASED, TaskState.RUNNING} or agent.state not in {
            AgentState.LEASED,
            AgentState.RUNNING,
        }:
            raise LeaseRejected("only an active assignment may renew its lease")
        if type(lease_seconds) is not int:
            raise SchedulingError("lease_seconds must be an exact integer")
        if lease_seconds < 1:
            raise SchedulingError("lease_seconds must be positive")
        renewed_expiry = at + timedelta(seconds=lease_seconds)
        renewed = replace(
            lease,
            token=cls._lease_token(
                run_id=task.run_id,
                task_id=task.id,
                agent_id=agent.id,
                attempt=lease.attempt,
                acquired_at=lease.acquired_at,
                expires_at=renewed_expiry,
                task_contract_digest=lease.task_contract_digest,
                agent_contract_digest=lease.agent_contract_digest,
                signing_key=lease_signing_key,
            ),
            expires_at=renewed_expiry,
        )
        return (
            replace(task, lease=renewed),
            replace(agent, last_heartbeat_at=at),
        )

    @classmethod
    def succeed(
        cls,
        task: Task,
        agent: Agent,
        *,
        lease_token: str,
        lease_signing_key: bytes,
        evidence: Sequence[Evidence],
        budget: Budget,
        actual_tokens: int,
        actual_tool_calls: int,
        at: datetime,
    ) -> CompletionResult:
        if cls is not DeterministicScheduler:
            raise SchedulingError("scheduler operations require DeterministicScheduler")
        at = _snapshot_time(at, "scheduler timestamp")
        cls._validate_lease(
            task,
            agent,
            lease_token,
            at,
            lease_signing_key=lease_signing_key,
        )
        if task.state not in {TaskState.LEASED, TaskState.RUNNING}:
            raise LeaseRejected("only an active assignment may succeed")
        exact_evidence = cls._validate_evidence(task, evidence)
        cls._validate_settlement_inputs(
            budget,
            actual_tokens=actual_tokens,
            actual_tool_calls=actual_tool_calls,
        )
        settled = budget.settle(
            reserved_tokens=task.estimated_tokens,
            actual_tokens=actual_tokens,
            actual_tool_calls=actual_tool_calls,
            reserved_agent_dispatches=1,
            actual_agent_dispatches=1,
        )
        return CompletionResult(
            task=replace(
                task,
                state=TaskState.SUCCEEDED,
                lease=None,
                result_evidence_ids=tuple(item.id for item in exact_evidence),
                completed_by_agent_id=agent.id,
                failure_code=None,
                failure_message=None,
            ),
            agent=replace(
                agent,
                state=AgentState.AVAILABLE,
                current_task_id=None,
                last_heartbeat_at=at,
            ),
            budget=settled,
        )

    @classmethod
    def fail(
        cls,
        task: Task,
        agent: Agent,
        *,
        lease_token: str,
        lease_signing_key: bytes,
        failure_code: str,
        failure_message: str,
        retryable: bool,
        budget: Budget,
        actual_tokens: int,
        actual_tool_calls: int,
        at: datetime,
    ) -> CompletionResult:
        if cls is not DeterministicScheduler:
            raise SchedulingError("scheduler operations require DeterministicScheduler")
        at = _snapshot_time(at, "scheduler timestamp")
        cls._validate_lease(
            task,
            agent,
            lease_token,
            at,
            lease_signing_key=lease_signing_key,
            allow_expired=True,
        )
        if task.state not in {TaskState.LEASED, TaskState.RUNNING} or agent.state not in {
            AgentState.LEASED,
            AgentState.RUNNING,
        }:
            raise LeaseRejected("only an active assignment may fail")
        return cls._fail_validated(
            task,
            agent,
            failure_code=failure_code,
            failure_message=failure_message,
            retryable=retryable,
            budget=budget,
            actual_tokens=actual_tokens,
            actual_tool_calls=actual_tool_calls,
            at=at,
        )

    @classmethod
    def reap_expired_leases(
        cls,
        tasks: Sequence[Task],
        agents: Sequence[Agent],
        *,
        budget: Budget,
        at: datetime,
        lease_signing_key: bytes,
    ) -> ReapResult:
        if cls is not DeterministicScheduler:
            raise SchedulingError("scheduler operations require DeterministicScheduler")
        at = _snapshot_time(at, "scheduler timestamp")
        if type(budget) is not Budget:
            raise SchedulingError("scheduler requires an exact Budget record")
        if type(lease_signing_key) is not bytes or len(lease_signing_key) < 32:
            raise SchedulingError("lease_signing_key must contain at least 32 bytes")
        exact_tasks = tuple(tasks)
        exact_agents = tuple(agents)
        if any(type(task) is not Task for task in exact_tasks):
            raise SchedulingError("scheduler requires exact Task records")
        if any(type(agent) is not Agent for agent in exact_agents):
            raise SchedulingError("scheduler requires exact Agent records")
        task_map = {
            TaskId(key): value
            for key, value in _index_unique(
                exact_tasks, lambda task: task.id
            ).items()
        }
        agent_map = {
            AgentId(key): value
            for key, value in _index_unique(
                exact_agents, lambda agent: agent.id
            ).items()
        }
        expired_ids: list[TaskId] = []
        current_budget = budget
        for task in sorted(task_map.values(), key=_task_order):
            if task.state not in {TaskState.LEASED, TaskState.RUNNING}:
                continue
            if task.lease is None:
                raise SchedulingError(f"active task {task.id} has no lease")
            agent = agent_map.get(task.lease.agent_id)
            if agent is None:
                raise SchedulingError(
                    f"leased task {task.id} references missing agent {task.lease.agent_id}"
                )
            validated_lease = cls._validate_lease(
                task,
                agent,
                task.lease.token,
                at,
                lease_signing_key=lease_signing_key,
                allow_expired=True,
            )
            if at < validated_lease.expires_at:
                continue
            result = cls._fail_validated(
                task,
                agent,
                failure_code="lease_expired",
                failure_message="worker did not renew its lease before expiry",
                retryable=True,
                budget=current_budget,
                actual_tokens=0,
                actual_tool_calls=0,
                at=at,
            )
            task_map[task.id] = result.task
            agent_map[agent.id] = result.agent
            current_budget = result.budget
            expired_ids.append(task.id)
        return ReapResult(
            tasks=tuple(
                sorted(
                    task_map.values(), key=lambda item: (item.created_seq, str(item.id))
                )
            ),
            agents=tuple(
                sorted(
                    agent_map.values(), key=lambda item: (item.created_seq, str(item.id))
                )
            ),
            budget=current_budget,
            expired_task_ids=tuple(expired_ids),
        )

    @staticmethod
    def _fail_validated(
        task: Task,
        agent: Agent,
        *,
        failure_code: str,
        failure_message: str,
        retryable: bool,
        budget: Budget,
        actual_tokens: int,
        actual_tool_calls: int,
        at: datetime,
    ) -> CompletionResult:
        if type(task) is not Task or type(agent) is not Agent:
            raise SchedulingError("task completion requires exact Task and Agent records")
        if type(failure_code) is not str or type(failure_message) is not str:
            raise SchedulingError("failure code and message must be exact strings")
        if not failure_code or not failure_message:
            raise SchedulingError("failure code and message are required")
        if type(retryable) is not bool:
            raise SchedulingError("retryable must be an exact boolean")
        at = _snapshot_time(at, "scheduler timestamp")
        DeterministicScheduler._validate_settlement_inputs(
            budget,
            actual_tokens=actual_tokens,
            actual_tool_calls=actual_tool_calls,
        )
        can_retry = retryable and task.attempt < task.retry_policy.max_attempts
        next_eligible = (
            at + timedelta(seconds=task.retry_policy.delay_seconds(task.attempt))
            if can_retry
            else None
        )
        settled = budget.settle(
            reserved_tokens=task.estimated_tokens,
            actual_tokens=actual_tokens,
            actual_tool_calls=actual_tool_calls,
            reserved_agent_dispatches=1,
            actual_agent_dispatches=1,
        )
        return CompletionResult(
            task=replace(
                task,
                state=TaskState.RETRY_WAIT if can_retry else TaskState.FAILED,
                next_eligible_at=next_eligible,
                lease=None,
                failure_code=failure_code,
                failure_message=failure_message,
            ),
            agent=replace(
                agent,
                state=AgentState.AVAILABLE,
                current_task_id=None,
                last_heartbeat_at=at,
            ),
            budget=settled,
        )

    @staticmethod
    def _is_eligible(
        task: Task, tasks: Mapping[TaskId, Task], at: datetime
    ) -> bool:
        if task.state not in {TaskState.QUEUED, TaskState.RETRY_WAIT}:
            return False
        next_eligible_at = (
            _snapshot_time(task.next_eligible_at, "task eligibility timestamp")
            if task.next_eligible_at is not None
            else None
        )
        if next_eligible_at is not None and at < next_eligible_at:
            return False
        if any(
            tasks[dependency].state is not TaskState.SUCCEEDED
            for dependency in task.dependencies
        ):
            return False
        for other in tasks.values():
            if other.wave < task.wave and other.state not in {
                TaskState.SUCCEEDED,
                TaskState.CANCELLED,
            }:
                return False
        return True

    @staticmethod
    def _best_agent(
        task: Task,
        agents: Sequence[Agent],
        *,
        dynamically_excluded_agent_ids: set[AgentId] | None = None,
    ) -> Agent | None:
        required = set(task.required_capabilities)
        excluded = set(task.excluded_agent_ids)
        excluded.update(dynamically_excluded_agent_ids or ())
        compatible = [
            agent
            for agent in agents
            if required.issubset(agent.capabilities)
            and (
                task.required_agent_class is None
                or agent.agent_class is task.required_agent_class
            )
            and agent.id not in excluded
        ]
        if not compatible:
            return None
        return min(
            compatible,
            key=lambda agent: (
                len(set(agent.capabilities) - required),
                *_agent_order(agent),
            ),
        )

    @staticmethod
    def _lease_token(
        *,
        run_id: object,
        task_id: object,
        agent_id: object,
        attempt: int,
        acquired_at: datetime,
        expires_at: datetime,
        task_contract_digest: str,
        agent_contract_digest: str,
        signing_key: bytes,
    ) -> str:
        material = canonical_json(
            {
                "scope": "flux-clone-orchestrator-lease-v1",
                "run_id": str(run_id),
                "task_id": str(task_id),
                "agent_id": str(agent_id),
                "attempt": attempt,
                "acquired_at": _canonical_time(acquired_at),
                "expires_at": _canonical_time(expires_at),
                "task_contract_digest": task_contract_digest,
                "agent_contract_digest": agent_contract_digest,
            }
        )
        return hmac.new(
            signing_key, material.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    @staticmethod
    def _validate_lease(
        task: Task,
        agent: Agent,
        lease_token: str,
        at: datetime,
        *,
        lease_signing_key: bytes,
        allow_expired: bool = False,
    ) -> Lease:
        try:
            at = _snapshot_time(at, "lease timestamp")
        except SchedulingError as exc:
            raise LeaseRejected(str(exc)) from exc
        if type(task) is not Task or type(agent) is not Agent:
            raise LeaseRejected("lease validation requires exact Task and Agent records")
        if type(allow_expired) is not bool:
            raise LeaseRejected("allow_expired must be an exact boolean")
        if type(lease_signing_key) is not bytes or len(lease_signing_key) < 32:
            raise LeaseRejected("lease signing key must contain at least 32 bytes")
        lease = task.lease
        if lease is None or type(lease) is not Lease:
            raise LeaseRejected("task has no active lease")
        if type(lease_token) is not str or not hmac.compare_digest(
            lease.token, lease_token
        ):
            raise LeaseRejected("lease token does not match")
        try:
            acquired_at = _snapshot_time(lease.acquired_at, "lease acquisition")
            expires_at = _snapshot_time(lease.expires_at, "lease expiry")
            last_heartbeat_at = (
                _snapshot_time(agent.last_heartbeat_at, "agent heartbeat")
                if agent.last_heartbeat_at is not None
                else None
            )
        except SchedulingError as exc:
            raise LeaseRejected(str(exc)) from exc
        if (
            lease.task_id != task.id
            or lease.agent_id != agent.id
            or agent.current_task_id != task.id
            or lease.attempt != task.attempt
            or task.run_id != agent.run_id
        ):
            raise LeaseRejected("lease is bound to a different task or agent")
        immutable_task_digest = task_contract_digest(task)
        agent_contract_digest = _agent_contract_digest(agent)
        if not hmac.compare_digest(
            lease.task_contract_digest, immutable_task_digest
        ) or not hmac.compare_digest(
            lease.agent_contract_digest, agent_contract_digest
        ):
            raise LeaseRejected("lease assignment contract has changed")
        expected_token = DeterministicScheduler._lease_token(
            run_id=task.run_id,
            task_id=task.id,
            agent_id=agent.id,
            attempt=lease.attempt,
            acquired_at=acquired_at,
            expires_at=expires_at,
            task_contract_digest=immutable_task_digest,
            agent_contract_digest=agent_contract_digest,
            signing_key=lease_signing_key,
        )
        if not hmac.compare_digest(expected_token, lease.token):
            raise LeaseRejected("lease HMAC is invalid")
        if at < acquired_at:
            raise LeaseRejected("scheduler clock moved before lease acquisition")
        if last_heartbeat_at is not None and at < last_heartbeat_at:
            raise LeaseRejected("scheduler clock moved before the last heartbeat")
        if not allow_expired and at >= expires_at:
            raise LeaseRejected("lease has expired")
        # Return a fresh exact record so later code never consumes a subclass or
        # a caller-owned object after authentication.
        return Lease(
            token=str(lease.token),
            task_id=TaskId(str(lease.task_id)),
            agent_id=AgentId(str(lease.agent_id)),
            attempt=int(lease.attempt),
            acquired_at=acquired_at,
            expires_at=expires_at,
            task_contract_digest=str(lease.task_contract_digest),
            agent_contract_digest=str(lease.agent_contract_digest),
        )

    @staticmethod
    def _validate_evidence(
        task: Task, evidence: Sequence[Evidence]
    ) -> tuple[Evidence, ...]:
        if type(task) is not Task:
            raise EvidenceRejected("evidence validation requires an exact Task record")
        exact_evidence = tuple(evidence)
        if not exact_evidence:
            raise EvidenceRejected("successful work requires immutable evidence")
        if any(type(item) is not Evidence for item in exact_evidence):
            raise EvidenceRejected("successful work requires exact Evidence records")
        if len({item.id for item in exact_evidence}) != len(exact_evidence):
            raise EvidenceRejected("evidence IDs must be unique")
        for item in exact_evidence:
            if item.run_id != task.run_id or item.task_id != task.id:
                raise EvidenceRejected("evidence is bound to a different run or task")
        check_results: dict[str, Evidence] = {}
        for item in exact_evidence:
            if item.kind is EvidenceKind.DESIGN_CHECK:
                if item.check_id is None or item.passed is None:
                    raise EvidenceRejected("design-check evidence is incomplete")
                if item.check_id in check_results:
                    raise EvidenceRejected(
                        f"duplicate results for design check {item.check_id}"
                    )
                check_results[item.check_id] = item
        failed = sorted(
            check_id for check_id, result in check_results.items() if not result.passed
        )
        if failed:
            raise EvidenceRejected(f"deterministic checks failed: {', '.join(failed)}")
        required = {item.check_id: item for item in task.required_checks}
        missing = sorted(required.keys() - check_results.keys())
        if missing:
            raise EvidenceRejected(f"required checks missing: {', '.join(missing)}")
        for check_id, requirement in required.items():
            result = check_results[check_id]
            if result.source != requirement.source:
                raise EvidenceRejected(
                    f"check {check_id} came from untrusted source {result.source}"
                )
            if result.policy_digest != requirement.policy_digest:
                raise EvidenceRejected(
                    f"check {check_id} used the wrong deterministic policy revision"
                )
        return exact_evidence

    @staticmethod
    def _validate_settlement_inputs(
        budget: Budget,
        *,
        actual_tokens: int,
        actual_tool_calls: int,
    ) -> None:
        if type(budget) is not Budget:
            raise SchedulingError("scheduler requires an exact Budget record")
        if type(actual_tokens) is not int or type(actual_tool_calls) is not int:
            raise SchedulingError("actual usage values must be exact integers")
        if actual_tokens < 0 or actual_tool_calls < 0:
            raise SchedulingError("actual usage values cannot be negative")

    @staticmethod
    def _validate_membership(
        run: Run, tasks: Sequence[Task], agents: Sequence[Agent]
    ) -> None:
        if type(run) is not Run:
            raise SchedulingError("scheduler requires an exact Run record")
        if any(type(task) is not Task for task in tasks):
            raise SchedulingError("scheduler requires exact Task records")
        if any(type(agent) is not Agent for agent in agents):
            raise SchedulingError("scheduler requires exact Agent records")
        _index_unique(tasks, lambda task: task.id)
        _index_unique(agents, lambda agent: agent.id)
        if any(task.run_id != run.id for task in tasks):
            raise SchedulingError("all tasks must belong to the scheduled run")
        if any(agent.run_id != run.id for agent in agents):
            raise SchedulingError("all agents must belong to the scheduled run")
        task_map = {task.id: task for task in tasks}
        agent_map = {agent.id: agent for agent in agents}
        active_agent_ids: set[AgentId] = set()
        for task in tasks:
            if task.lease is not None and type(task.lease) is not Lease:
                raise SchedulingError("scheduler requires exact Lease records")
            if task.next_eligible_at is not None and type(
                task.next_eligible_at
            ) is not datetime:
                raise SchedulingError("scheduler requires exact task timestamps")
            if task.state not in {TaskState.LEASED, TaskState.RUNNING}:
                continue
            assert task.lease is not None
            if task.lease.agent_id in active_agent_ids:
                raise SchedulingError("one agent cannot hold multiple active task leases")
            active_agent_ids.add(task.lease.agent_id)
            agent = agent_map.get(task.lease.agent_id)
            if (
                agent is None
                or agent.state not in {AgentState.LEASED, AgentState.RUNNING}
                or agent.current_task_id != task.id
            ):
                raise SchedulingError("active task lease has no matching active agent")
        for agent in agents:
            if agent.state not in {AgentState.LEASED, AgentState.RUNNING}:
                continue
            assert agent.current_task_id is not None
            task = task_map.get(agent.current_task_id)
            if (
                task is None
                or task.state not in {TaskState.LEASED, TaskState.RUNNING}
                or task.lease is None
                or task.lease.agent_id != agent.id
            ):
                raise SchedulingError("active agent has no matching active task lease")

    @staticmethod
    def _result(
        tasks: Mapping[TaskId, Task],
        agents: Mapping[AgentId, Agent],
        budget: Budget,
        dispatches: Iterable[Dispatch],
        blocked: Iterable[TaskId],
        budget_deferred: Iterable[TaskId],
    ) -> ScheduleResult:
        return ScheduleResult(
            tasks=tuple(
                sorted(tasks.values(), key=lambda item: (item.created_seq, str(item.id)))
            ),
            agents=tuple(
                sorted(agents.values(), key=lambda item: (item.created_seq, str(item.id)))
            ),
            budget=budget,
            dispatches=tuple(dispatches),
            blocked_task_ids=tuple(blocked),
            budget_deferred_task_ids=tuple(budget_deferred),
        )

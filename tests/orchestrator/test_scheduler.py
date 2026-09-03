from __future__ import annotations

import unittest
from collections.abc import Iterator, Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta, tzinfo
from typing import cast

from backend.orchestrator import (
    Agent,
    AgentClass,
    AgentId,
    AgentState,
    Budget,
    CheckRequirement,
    DeterministicScheduler,
    Evidence,
    EvidenceId,
    EvidenceKind,
    EvidenceRejected,
    LeaseRejected,
    Run,
    RunId,
    RunPhase,
    SchedulingError,
    Task,
    TaskId,
    TaskKind,
    TaskState,
)

NOW = datetime(2026, 8, 29, 21, 0, tzinfo=UTC)
LEASE_SIGNING_KEY = b"test-only-orchestrator-lease-key-32-bytes"


class _SwitchingEvidenceSequence:
    """Yields one validated snapshot, then a different caller-owned view."""

    def __init__(self, first: Evidence, later: Evidence) -> None:
        self._first = first
        self._later = later
        self.iterations = 0

    def __iter__(self) -> Iterator[Evidence]:
        self.iterations += 1
        return iter((self._first if self.iterations == 1 else self._later,))

    def __len__(self) -> int:
        return 1

    def __getitem__(self, index: int) -> Evidence:
        if index in {0, -1}:
            return self._first
        raise IndexError(index)


class SchedulerTests(unittest.TestCase):
    def make_run(self, *, max_concurrency: int = 2) -> Run:
        return Run(
            id=RunId("run_schedule"),
            objective="Create and verify a PCB",
            created_at=NOW,
            phase=RunPhase.EXECUTING,
            require_plan_approval=False,
            max_concurrency=max_concurrency,
        )

    def make_agents(self) -> tuple[Agent, Agent]:
        return (
            Agent(
                id=AgentId("agent_specialist"),
                run_id=RunId("run_schedule"),
                name="Specialist",
                created_seq=1,
                capabilities=("pcb", "rf"),
            ),
            Agent(
                id=AgentId("agent_exact"),
                run_id=RunId("run_schedule"),
                name="Exact fit",
                created_seq=2,
                capabilities=("pcb",),
            ),
        )

    def make_tasks(self) -> tuple[Task, Task, Task]:
        first = Task(
            id=TaskId("task_first"),
            run_id=RunId("run_schedule"),
            title="Power stage",
            instructions="Design power stage",
            kind=TaskKind.DESIGN,
            created_seq=1,
            priority=90,
            required_capabilities=("pcb",),
            required_checks=(
                CheckRequirement(
                    check_id="erc",
                    source="kicad-cli erc",
                    policy_digest="sha256:kicad-10-erc-policy",
                ),
            ),
            estimated_tokens=100,
        )
        second = Task(
            id=TaskId("task_second"),
            run_id=RunId("run_schedule"),
            title="Controller",
            instructions="Design controller",
            kind=TaskKind.DESIGN,
            created_seq=2,
            priority=50,
            required_capabilities=("pcb",),
            estimated_tokens=100,
        )
        later = Task(
            id=TaskId("task_later"),
            run_id=RunId("run_schedule"),
            title="Final review",
            instructions="Review complete design",
            kind=TaskKind.REVIEW,
            created_seq=3,
            wave=1,
            dependencies=(first.id, second.id),
            required_capabilities=("pcb",),
            estimated_tokens=50,
        )
        return first, second, later

    def test_dispatch_is_stable_best_fit_and_wave_barrier(self) -> None:
        tasks = self.make_tasks()
        agents = self.make_agents()
        first = DeterministicScheduler.schedule(
            self.make_run(),
            tuple(reversed(tasks)),
            tuple(reversed(agents)),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        replay = DeterministicScheduler.schedule(
            self.make_run(),
            tasks,
            agents,
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        self.assertEqual(
            [(item.task_id, item.agent_id, item.lease.token) for item in first.dispatches],
            [(item.task_id, item.agent_id, item.lease.token) for item in replay.dispatches],
        )
        self.assertEqual(
            [item.task_id for item in first.dispatches],
            [TaskId("task_first"), TaskId("task_second")],
        )
        self.assertEqual(first.dispatches[0].agent_id, AgentId("agent_exact"))
        self.assertNotIn(TaskId("task_later"), [item.task_id for item in first.dispatches])

        succeeded = tuple(
            replace(task, state=TaskState.SUCCEEDED)
            if task.wave == 0
            else task
            for task in tasks
        )
        next_wave = DeterministicScheduler.schedule(
            self.make_run(),
            succeeded,
            agents,
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        self.assertEqual(
            [item.task_id for item in next_wave.dispatches], [TaskId("task_later")]
        )

    def test_expired_lease_retries_after_deterministic_backoff(self) -> None:
        task = self.make_tasks()[0]
        agent = self.make_agents()[1]
        leased = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (task,),
            (agent,),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
            lease_seconds=10,
        )
        expiry = NOW + timedelta(seconds=10)
        reaped = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            leased.tasks,
            leased.agents,
            budget=leased.budget,
            at=expiry,
            lease_signing_key=LEASE_SIGNING_KEY,
            lease_seconds=10,
        )
        self.assertEqual(reaped.dispatches, ())
        self.assertEqual(reaped.tasks[0].state, TaskState.RETRY_WAIT)
        self.assertEqual(
            reaped.tasks[0].next_eligible_at, expiry + timedelta(seconds=5)
        )
        self.assertEqual(reaped.budget.agent_dispatches_used, 1)
        self.assertEqual(reaped.budget.tokens_reserved, 0)

        retried = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            reaped.tasks,
            reaped.agents,
            budget=reaped.budget,
            at=expiry + timedelta(seconds=5),
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        self.assertEqual(retried.tasks[0].attempt, 2)
        self.assertEqual(len(retried.dispatches), 1)

    def test_forged_or_rebound_lease_claims_fail_hmac_validation(self) -> None:
        scheduled = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (self.make_tasks()[0],),
            (self.make_agents()[1],),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        task, agent = scheduled.tasks[0], scheduled.agents[0]
        assert task.lease is not None

        forged_lease = replace(task.lease, token="0" * 64)
        forged_task = replace(task, lease=forged_lease)
        with self.assertRaisesRegex(LeaseRejected, "HMAC"):
            DeterministicScheduler.start(
                forged_task,
                agent,
                lease_token=forged_lease.token,
                lease_signing_key=LEASE_SIGNING_KEY,
                at=NOW + timedelta(seconds=1),
            )
        with self.assertRaisesRegex(LeaseRejected, "HMAC"):
            DeterministicScheduler.schedule(
                self.make_run(max_concurrency=1),
                (forged_task,),
                (agent,),
                at=NOW + timedelta(seconds=1),
                lease_signing_key=LEASE_SIGNING_KEY,
                budget=scheduled.budget,
            )

        for label, rebound_task, rebound_agent in (
            ("task", replace(task, instructions="Substituted instructions"), agent),
            ("agent", task, replace(agent, name="Substituted worker")),
            (
                "expiry",
                replace(
                    task,
                    lease=replace(
                        task.lease,
                        expires_at=task.lease.expires_at + timedelta(hours=1),
                    ),
                ),
                agent,
            ),
        ):
            with self.subTest(binding=label), self.assertRaises(LeaseRejected):
                DeterministicScheduler.start(
                    rebound_task,
                    rebound_agent,
                    lease_token=task.lease.token,
                    lease_signing_key=LEASE_SIGNING_KEY,
                    at=NOW + timedelta(seconds=1),
                )

        with self.assertRaises(LeaseRejected):
            DeterministicScheduler.start(
                task,
                agent,
                lease_token=task.lease.token,
                lease_signing_key=b"different-orchestrator-lease-key-32-bytes-minimum",
                at=NOW + timedelta(seconds=1),
            )

    def test_heartbeat_resigns_expiry_and_rejects_old_token_and_clock_rollback(self) -> None:
        scheduled = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (self.make_tasks()[0],),
            (self.make_agents()[1],),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        task, agent = scheduled.tasks[0], scheduled.agents[0]
        assert task.lease is not None
        old_token = task.lease.token

        with self.assertRaisesRegex(LeaseRejected, "clock"):
            DeterministicScheduler.start(
                task,
                agent,
                lease_token=old_token,
                lease_signing_key=LEASE_SIGNING_KEY,
                at=NOW - timedelta(microseconds=1),
            )
        with self.assertRaisesRegex(LeaseRejected, "clock"):
            DeterministicScheduler.schedule(
                self.make_run(max_concurrency=1),
                (task,),
                (agent,),
                at=NOW - timedelta(microseconds=1),
                lease_signing_key=LEASE_SIGNING_KEY,
                budget=scheduled.budget,
            )

        renewed_task, renewed_agent = DeterministicScheduler.heartbeat(
            task,
            agent,
            lease_token=old_token,
            lease_signing_key=LEASE_SIGNING_KEY,
            at=NOW + timedelta(seconds=10),
            lease_seconds=300,
        )
        assert renewed_task.lease is not None
        self.assertNotEqual(old_token, renewed_task.lease.token)
        with self.assertRaisesRegex(LeaseRejected, "token"):
            DeterministicScheduler.start(
                renewed_task,
                renewed_agent,
                lease_token=old_token,
                lease_signing_key=LEASE_SIGNING_KEY,
                at=NOW + timedelta(seconds=11),
            )
        running_task, running_agent = DeterministicScheduler.start(
            renewed_task,
            renewed_agent,
            lease_token=renewed_task.lease.token,
            lease_signing_key=LEASE_SIGNING_KEY,
            at=NOW + timedelta(seconds=11),
        )
        self.assertEqual(TaskState.RUNNING, running_task.state)
        self.assertEqual(AgentState.RUNNING, running_agent.state)

    def test_independent_critic_role_and_exclusions_are_enforced(self) -> None:
        designer = replace(
            self.make_agents()[1],
            agent_class=AgentClass.DOMAIN_DESIGNER,
        )
        critic = Agent(
            id=AgentId("agent_critic"),
            run_id=RunId("run_schedule"),
            name="Independent critic",
            created_seq=3,
            agent_class=AgentClass.CRITIC,
            capabilities=("pcb",),
        )
        review = replace(
            self.make_tasks()[0],
            required_agent_class=AgentClass.CRITIC,
            excluded_agent_ids=(designer.id,),
        )
        result = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (review,),
            (designer, critic),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        self.assertEqual(result.dispatches[0].agent_id, critic.id)

        excluded = replace(review, excluded_agent_ids=(designer.id, critic.id))
        none = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (excluded,),
            (designer, critic),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        self.assertEqual(none.dispatches, ())

    def test_success_requires_all_deterministic_checks_to_pass(self) -> None:
        task = self.make_tasks()[0]
        agent = self.make_agents()[1]
        scheduled = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (task,),
            (agent,),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        dispatch = scheduled.dispatches[0]
        leased_task, leased_agent = scheduled.tasks[0], scheduled.agents[0]
        running_task, running_agent = DeterministicScheduler.start(
            leased_task,
            leased_agent,
            lease_token=dispatch.lease.token,
            lease_signing_key=LEASE_SIGNING_KEY,
            at=NOW + timedelta(seconds=1),
        )
        artifact = Evidence.capture(
            evidence_id=EvidenceId("evidence_artifact"),
            run_id=task.run_id,
            kind=EvidenceKind.ARTIFACT,
            source="kicad-worker",
            content=b"board-revision",
            summary="Staged board",
            captured_at=NOW + timedelta(seconds=2),
            task_id=task.id,
        )
        with self.assertRaisesRegex(EvidenceRejected, "required checks missing"):
            DeterministicScheduler.succeed(
                running_task,
                running_agent,
                lease_token=dispatch.lease.token,
                lease_signing_key=LEASE_SIGNING_KEY,
                evidence=(artifact,),
                budget=scheduled.budget,
                actual_tokens=80,
                actual_tool_calls=2,
                at=NOW + timedelta(seconds=3),
            )
        failed_check = Evidence.capture(
            evidence_id=EvidenceId("evidence_erc_failed"),
            run_id=task.run_id,
            kind=EvidenceKind.DESIGN_CHECK,
            source="kicad-cli erc",
            content="1 violation",
            summary="ERC failed",
            captured_at=NOW + timedelta(seconds=2),
            task_id=task.id,
            check_id="erc",
            policy_digest="sha256:kicad-10-erc-policy",
            passed=False,
        )
        with self.assertRaisesRegex(EvidenceRejected, "checks failed"):
            DeterministicScheduler.succeed(
                running_task,
                running_agent,
                lease_token=dispatch.lease.token,
                lease_signing_key=LEASE_SIGNING_KEY,
                evidence=(artifact, failed_check),
                budget=scheduled.budget,
                actual_tokens=80,
                actual_tool_calls=2,
                at=NOW + timedelta(seconds=3),
            )
        untrusted_check = replace(
            failed_check,
            id=EvidenceId("evidence_erc_untrusted"),
            source="agent:self-report",
            passed=True,
        )
        with self.assertRaisesRegex(EvidenceRejected, "untrusted source"):
            DeterministicScheduler.succeed(
                running_task,
                running_agent,
                lease_token=dispatch.lease.token,
                lease_signing_key=LEASE_SIGNING_KEY,
                evidence=(artifact, untrusted_check),
                budget=scheduled.budget,
                actual_tokens=80,
                actual_tool_calls=2,
                at=NOW + timedelta(seconds=3),
            )
        stale_policy_check = replace(
            failed_check,
            id=EvidenceId("evidence_erc_stale_policy"),
            policy_digest="sha256:old-policy",
            passed=True,
        )
        with self.assertRaisesRegex(EvidenceRejected, "wrong deterministic policy"):
            DeterministicScheduler.succeed(
                running_task,
                running_agent,
                lease_token=dispatch.lease.token,
                lease_signing_key=LEASE_SIGNING_KEY,
                evidence=(artifact, stale_policy_check),
                budget=scheduled.budget,
                actual_tokens=80,
                actual_tool_calls=2,
                at=NOW + timedelta(seconds=3),
            )
        passed_check = replace(
            failed_check,
            id=EvidenceId("evidence_erc_passed"),
            content_digest="a" * 64,
            summary="ERC passed",
            passed=True,
        )
        completed = DeterministicScheduler.succeed(
            running_task,
            running_agent,
            lease_token=dispatch.lease.token,
            lease_signing_key=LEASE_SIGNING_KEY,
            evidence=(artifact, passed_check),
            budget=scheduled.budget,
            actual_tokens=80,
            actual_tool_calls=2,
            at=NOW + timedelta(seconds=3),
        )
        self.assertEqual(completed.task.state, TaskState.SUCCEEDED)
        self.assertEqual(completed.agent.state, AgentState.AVAILABLE)
        self.assertEqual(completed.budget.tokens_used, 80)
        self.assertEqual(completed.budget.tokens_reserved, 0)

    def test_finite_budget_defers_without_partial_dispatch(self) -> None:
        task = self.make_tasks()[0]
        result = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (task,),
            (self.make_agents()[1],),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
            budget=Budget(token_limit=99),
        )
        self.assertEqual(result.dispatches, ())
        self.assertEqual(result.budget_deferred_task_ids, (task.id,))
        self.assertEqual(result.tasks[0].state, TaskState.QUEUED)

    def test_budget_subclass_cannot_override_finite_reservation(self) -> None:
        reserve_calls = 0

        class ReserveBypassBudget(Budget):
            def reserve(
                self,
                *,
                tokens: int = 0,
                tool_calls: int = 0,
                agent_dispatches: int = 0,
            ) -> Budget:
                nonlocal reserve_calls
                reserve_calls += 1
                return Budget.unlimited().reserve(
                    tokens=tokens,
                    tool_calls=tool_calls,
                    agent_dispatches=agent_dispatches,
                )

        with self.assertRaisesRegex(SchedulingError, "exact Budget"):
            DeterministicScheduler.schedule(
                self.make_run(max_concurrency=1),
                (self.make_tasks()[0],),
                (self.make_agents()[1],),
                at=NOW,
                lease_signing_key=LEASE_SIGNING_KEY,
                budget=ReserveBypassBudget(token_limit=0),
            )
        self.assertEqual(reserve_calls, 0)

    def test_evidence_subclass_is_rejected_before_stateful_fields_are_read(
        self,
    ) -> None:
        scheduled = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (self.make_tasks()[0],),
            (self.make_agents()[1],),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        task, agent = DeterministicScheduler.start(
            scheduled.tasks[0],
            scheduled.agents[0],
            lease_token=scheduled.dispatches[0].lease.token,
            lease_signing_key=LEASE_SIGNING_KEY,
            at=NOW + timedelta(seconds=1),
        )
        source_reads = 0

        class StatefulEvidence(Evidence):
            def __getattribute__(self, name: str) -> object:
                nonlocal source_reads
                if name == "source":
                    source_reads += 1
                    return (
                        "kicad-cli erc"
                        if source_reads == 1
                        else "agent:self-report"
                    )
                return super().__getattribute__(name)

        stateful = StatefulEvidence(
            id=EvidenceId("evidence_stateful"),
            run_id=task.run_id,
            kind=EvidenceKind.DESIGN_CHECK,
            source="kicad-cli erc",
            content_digest="a" * 64,
            summary="ERC passed",
            captured_at=NOW + timedelta(seconds=2),
            task_id=task.id,
            check_id="erc",
            policy_digest="sha256:kicad-10-erc-policy",
            passed=True,
        )
        source_reads = 0
        with self.assertRaisesRegex(EvidenceRejected, "exact Evidence"):
            DeterministicScheduler.succeed(
                task,
                agent,
                lease_token=scheduled.dispatches[0].lease.token,
                lease_signing_key=LEASE_SIGNING_KEY,
                evidence=(stateful,),
                budget=scheduled.budget,
                actual_tokens=80,
                actual_tool_calls=2,
                at=NOW + timedelta(seconds=3),
            )
        self.assertEqual(source_reads, 0)

    def test_evidence_sequence_is_consumed_once_and_same_snapshot_is_persisted(
        self,
    ) -> None:
        scheduled = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (self.make_tasks()[0],),
            (self.make_agents()[1],),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        task, agent = DeterministicScheduler.start(
            scheduled.tasks[0],
            scheduled.agents[0],
            lease_token=scheduled.dispatches[0].lease.token,
            lease_signing_key=LEASE_SIGNING_KEY,
            at=NOW + timedelta(seconds=1),
        )
        trusted = Evidence.capture(
            evidence_id=EvidenceId("evidence_snapshot_trusted"),
            run_id=task.run_id,
            kind=EvidenceKind.DESIGN_CHECK,
            source="kicad-cli erc",
            content=b"zero violations",
            summary="ERC passed",
            captured_at=NOW + timedelta(seconds=2),
            task_id=task.id,
            check_id="erc",
            policy_digest="sha256:kicad-10-erc-policy",
            passed=True,
        )
        later = replace(
            trusted,
            id=EvidenceId("evidence_snapshot_untrusted"),
            source="agent:self-report",
        )
        switching = _SwitchingEvidenceSequence(trusted, later)

        completed = DeterministicScheduler.succeed(
            task,
            agent,
            lease_token=scheduled.dispatches[0].lease.token,
            lease_signing_key=LEASE_SIGNING_KEY,
            evidence=cast(Sequence[Evidence], switching),
            budget=scheduled.budget,
            actual_tokens=80,
            actual_tool_calls=2,
            at=NOW + timedelta(seconds=3),
        )

        self.assertEqual(switching.iterations, 1)
        self.assertEqual(completed.task.result_evidence_ids, (trusted.id,))

    def test_scheduler_rejects_subclassed_authority_and_bool_as_int_inputs(
        self,
    ) -> None:
        class SchedulerSubclass(DeterministicScheduler):
            pass

        with self.assertRaisesRegex(SchedulingError, "DeterministicScheduler"):
            SchedulerSubclass.schedule(
                self.make_run(max_concurrency=1),
                (self.make_tasks()[0],),
                (self.make_agents()[1],),
                at=NOW,
                lease_signing_key=LEASE_SIGNING_KEY,
            )
        with self.assertRaisesRegex(SchedulingError, "exact integer"):
            DeterministicScheduler.schedule(
                self.make_run(max_concurrency=1),
                (self.make_tasks()[0],),
                (self.make_agents()[1],),
                at=NOW,
                lease_signing_key=LEASE_SIGNING_KEY,
                lease_seconds=True,
            )

    def test_scheduler_snapshots_stateful_timezone_once(self) -> None:
        class StatefulTimezone(tzinfo):
            def __init__(self) -> None:
                self.offset_reads = 0

            def utcoffset(self, value: datetime | None) -> timedelta:
                self.offset_reads += 1
                return (
                    timedelta(hours=-7)
                    if self.offset_reads == 1
                    else timedelta(hours=11)
                )

            def dst(self, value: datetime | None) -> timedelta:
                return timedelta(0)

            def tzname(self, value: datetime | None) -> str:
                return "stateful-test-zone"

        stateful_timezone = StatefulTimezone()
        caller_time = datetime(2026, 8, 29, 14, 0, tzinfo=stateful_timezone)
        result = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (self.make_tasks()[0],),
            (self.make_agents()[1],),
            at=caller_time,
            lease_signing_key=LEASE_SIGNING_KEY,
        )

        self.assertEqual(stateful_timezone.offset_reads, 1)
        self.assertEqual(result.dispatches[0].lease.acquired_at, NOW)

    def test_completion_rejects_subclassed_budget_and_non_exact_usage(self) -> None:
        class SettleBypassBudget(Budget):
            def settle(
                self,
                *,
                reserved_tokens: int = 0,
                actual_tokens: int = 0,
                reserved_tool_calls: int = 0,
                actual_tool_calls: int = 0,
                reserved_agent_dispatches: int = 0,
                actual_agent_dispatches: int = 0,
            ) -> Budget:
                return Budget.unlimited()

        scheduled = DeterministicScheduler.schedule(
            self.make_run(max_concurrency=1),
            (self.make_tasks()[0],),
            (self.make_agents()[1],),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        task, agent = DeterministicScheduler.start(
            scheduled.tasks[0],
            scheduled.agents[0],
            lease_token=scheduled.dispatches[0].lease.token,
            lease_signing_key=LEASE_SIGNING_KEY,
            at=NOW + timedelta(seconds=1),
        )
        evidence = Evidence.capture(
            evidence_id=EvidenceId("evidence_exact_usage"),
            run_id=task.run_id,
            kind=EvidenceKind.DESIGN_CHECK,
            source="kicad-cli erc",
            content=b"zero violations",
            summary="ERC passed",
            captured_at=NOW + timedelta(seconds=2),
            task_id=task.id,
            check_id="erc",
            policy_digest="sha256:kicad-10-erc-policy",
            passed=True,
        )
        for label, budget, tokens, tool_calls, message in (
            (
                "budget subclass",
                SettleBypassBudget(tokens_reserved=100, agent_dispatches_reserved=1),
                80,
                2,
                "exact Budget",
            ),
            ("boolean tokens", scheduled.budget, True, 2, "exact integers"),
            ("boolean tool calls", scheduled.budget, 80, False, "exact integers"),
        ):
            with self.subTest(case=label), self.assertRaisesRegex(
                SchedulingError, message
            ):
                DeterministicScheduler.succeed(
                    task,
                    agent,
                    lease_token=scheduled.dispatches[0].lease.token,
                    lease_signing_key=LEASE_SIGNING_KEY,
                    evidence=(evidence,),
                    budget=budget,
                    actual_tokens=tokens,
                    actual_tool_calls=tool_calls,
                    at=NOW + timedelta(seconds=3),
                )

        with self.assertRaisesRegex(SchedulingError, "exact boolean"):
            DeterministicScheduler.fail(
                task,
                agent,
                lease_token=scheduled.dispatches[0].lease.token,
                lease_signing_key=LEASE_SIGNING_KEY,
                failure_code="worker_failure",
                failure_message="worker failed",
                retryable=cast(bool, 1),
                budget=scheduled.budget,
                actual_tokens=80,
                actual_tool_calls=2,
                at=NOW + timedelta(seconds=3),
            )


if __name__ == "__main__":
    unittest.main()

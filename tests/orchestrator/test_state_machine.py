from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from backend.orchestrator import (
    ApprovalId,
    ApprovalKind,
    CoordinationService,
    CoordinationStage,
    CoordinationStageMachine,
    DomainError,
    Run,
    RunId,
    RunPhase,
    RunStateMachine,
    Task,
    TaskId,
    TaskKind,
    TaskState,
    TransitionContext,
    TransitionRejected,
    task_inventory_digest,
)

NOW = datetime(2026, 8, 29, 20, 0, tzinfo=timezone.utc)


class CoordinationStateMachineTests(unittest.TestCase):
    def make_run(self) -> Run:
        return Run(
            id=RunId("run_coordination"),
            objective="Design a verified motor controller",
            created_at=NOW,
        )

    def test_default_run_has_elastic_agent_capacity_and_no_campaign_budget(self) -> None:
        run = self.make_run()
        self.assertEqual(100, run.max_concurrency)
        self.assertIsNone(run.budget.token_limit)
        self.assertIsNone(run.budget.tool_call_limit)
        self.assertIsNone(run.budget.agent_dispatch_limit)

    def test_blocking_question_and_digest_bound_plan_approval(self) -> None:
        run, question = CoordinationService.open_question(
            self.make_run(),
            question_id=None,
            prompt="What is the maximum motor current?",
            rationale="It determines power-stage sizing.",
            options=("2 A", "5 A"),
            recommendation="5 A",
            confidence_basis_points=8_500,
            bound_revision="sha256:brief-draft-1",
            at=NOW,
        )
        self.assertEqual(run.phase, RunPhase.CLARIFYING)

        run, requested = CoordinationService.request_approval(
            run,
            approval_id=ApprovalId("approval_plan"),
            kind=ApprovalKind.PLAN,
            subject_digest="plan-v1",
            summary="Use a 5 A protected stage",
            at=NOW + timedelta(seconds=1),
        )
        approved = CoordinationService.decide_approval(
            requested,
            approve=True,
            decided_by="user:owner",
            reason="Proceed",
            at=NOW + timedelta(seconds=2),
        )
        with self.assertRaisesRegex(TransitionRejected, "blocking questions"):
            RunStateMachine.transition(
                run,
                RunPhase.READY,
                at=NOW + timedelta(seconds=3),
                context=TransitionContext(
                    questions=(question,), approvals=(approved,)
                ),
            )

        with self.assertRaisesRegex(DomainError, "exactly match"):
            CoordinationService.answer_question(
                question,
                answer="around 5 A",
                answered_by="user:owner",
                at=NOW + timedelta(seconds=3),
            )
        answered = CoordinationService.answer_question(
            question,
            answer="5 A",
            answered_by="user:owner",
            at=NOW + timedelta(seconds=3),
        )
        ready = RunStateMachine.transition(
            run,
            RunPhase.READY,
            at=NOW + timedelta(seconds=4),
            context=TransitionContext(
                questions=(answered,), approvals=(approved,)
            ),
        )
        self.assertEqual(ready.phase, RunPhase.READY)

        mutated = replace(ready, phase=RunPhase.AWAITING_PLAN_APPROVAL, plan_digest="plan-v2")
        with self.assertRaisesRegex(TransitionRejected, "plan-v2"):
            RunStateMachine.transition(
                mutated,
                RunPhase.READY,
                at=NOW + timedelta(seconds=5),
                context=TransitionContext(approvals=(approved,)),
            )

    def test_changeset_gate_requires_exact_approval(self) -> None:
        run = replace(
            self.make_run(),
            phase=RunPhase.EXECUTING,
            require_plan_approval=False,
        )
        gated, requested = CoordinationService.request_approval(
            run,
            approval_id=ApprovalId("approval_change"),
            kind=ApprovalKind.CHANGESET,
            subject_digest="sha256:changes-a",
            summary="Apply routed board changes",
            at=NOW,
        )
        approved = CoordinationService.decide_approval(
            requested,
            approve=True,
            decided_by="user:owner",
            reason="Reviewed preview",
            at=NOW + timedelta(seconds=1),
        )
        with self.assertRaises(TransitionRejected):
            RunStateMachine.transition(
                gated,
                RunPhase.EXECUTING,
                at=NOW + timedelta(seconds=2),
                context=TransitionContext(
                    approvals=(approved,),
                    required_subject_digest="sha256:changes-b",
                ),
            )
        resumed = RunStateMachine.transition(
            gated,
            RunPhase.EXECUTING,
            at=NOW + timedelta(seconds=2),
            context=TransitionContext(
                approvals=(approved,),
                required_subject_digest="sha256:changes-a",
            ),
        )
        self.assertEqual(resumed.phase, RunPhase.EXECUTING)

    def test_flux_style_checkpoint_sequence_cannot_be_skipped(self) -> None:
        run = self.make_run()
        with self.assertRaisesRegex(TransitionRejected, "must advance"):
            CoordinationStageMachine.advance(
                run,
                target=CoordinationStage.SCHEMATIC_STAGE,
                at=NOW,
            )
        waiting, requested = CoordinationService.request_checkpoint_approval(
            run,
            approval_id=ApprovalId("approval_brief"),
            kind=ApprovalKind.BRIEF,
            subject_digest="sha256:brief-v1",
            summary="Power, interfaces, envelope, and constraints",
            at=NOW,
        )
        self.assertEqual(
            waiting.coordination_stage,
            CoordinationStage.AWAITING_BRIEF_APPROVAL,
        )
        with self.assertRaisesRegex(TransitionRejected, "no valid brief approval"):
            CoordinationStageMachine.advance(
                waiting,
                target=CoordinationStage.RESEARCH,
                at=NOW + timedelta(seconds=1),
            )
        approved = CoordinationService.decide_approval(
            requested,
            approve=True,
            decided_by="user:owner",
            reason="Brief is complete",
            at=NOW + timedelta(seconds=1),
        )
        researching = CoordinationStageMachine.advance(
            waiting,
            target=CoordinationStage.RESEARCH,
            at=NOW + timedelta(seconds=2),
            context=TransitionContext(approvals=(approved,)),
        )
        self.assertEqual(researching.coordination_stage, CoordinationStage.RESEARCH)
        self.assertEqual(researching.phase, RunPhase.EXECUTING)
        architecture_wait, _ = CoordinationService.request_checkpoint_approval(
            researching,
            approval_id=ApprovalId("approval_architecture"),
            kind=ApprovalKind.ARCHITECTURE_BOM,
            subject_digest="sha256:architecture-v1",
            summary="Architecture and exact BOM",
            at=NOW + timedelta(seconds=3),
        )
        restarted = CoordinationStageMachine.restart_questioning(architecture_wait)
        self.assertEqual(restarted.coordination_stage, CoordinationStage.QUESTIONING)
        self.assertIsNone(restarted.checkpoint_digest)

    def test_completion_requires_tasks_and_verification(self) -> None:
        run = replace(
            self.make_run(),
            phase=RunPhase.VERIFYING,
            require_plan_approval=False,
        )
        task = Task(
            id=TaskId("task_verify"),
            run_id=run.id,
            title="Run DRC",
            instructions="Run deterministic DRC",
            kind=TaskKind.VERIFY,
            created_seq=1,
            state=TaskState.SUCCEEDED,
        )
        run = replace(
            run,
            task_inventory_digest=task_inventory_digest(run.id, (task,)),
        )
        with self.assertRaisesRegex(TransitionRejected, "passed verification"):
            RunStateMachine.transition(
                run,
                RunPhase.COMPLETED,
                at=NOW,
                context=TransitionContext(tasks=(task,)),
            )
        completed = RunStateMachine.transition(
            run,
            RunPhase.COMPLETED,
            at=NOW,
            context=TransitionContext(tasks=(task,), verification_passed=True),
        )
        self.assertEqual(completed.phase, RunPhase.COMPLETED)
        with self.assertRaisesRegex(TransitionRejected, "terminal run"):
            RunStateMachine.transition(
                completed,
                RunPhase.EXECUTING,
                at=NOW,
            )

    def test_transition_context_subclass_cannot_override_completion_gates(self) -> None:
        run = replace(
            self.make_run(),
            phase=RunPhase.VERIFYING,
            require_plan_approval=False,
            require_independent_critic=True,
            task_inventory_digest=task_inventory_digest(
                RunId("run_coordination"),
                (
                    Task(
                        id=TaskId("task_omitted_from_context"),
                        run_id=RunId("run_coordination"),
                        title="Implement the exact board",
                        instructions="Produce the reviewed canonical change",
                        kind=TaskKind.IMPLEMENT,
                        created_seq=1,
                    ),
                ),
            ),
        )

        class ForgedContext(TransitionContext):
            def __post_init__(self) -> None:
                pass

            def matches_task_inventory(self, run: Run) -> bool:
                return True

            def all_required_tasks_succeeded(self, run: Run) -> bool:
                return True

            def has_required_independent_critic_reviews(self, run: Run) -> bool:
                return True

        with self.assertRaisesRegex(TransitionRejected, "exact TransitionContext"):
            RunStateMachine.transition(
                run,
                RunPhase.COMPLETED,
                at=NOW,
                context=ForgedContext(verification_passed=True),
            )


if __name__ == "__main__":
    unittest.main()

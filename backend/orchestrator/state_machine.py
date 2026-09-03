"""Strict, deterministic user-coordination state machine."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from typing import Sequence, cast

from .models import (
    TERMINAL_RUN_PHASES,
    Agent,
    AgentClass,
    Approval,
    ApprovalId,
    ApprovalKind,
    ApprovalState,
    CoordinationStage,
    DomainError,
    Evidence,
    Question,
    QuestionId,
    QuestionState,
    Run,
    RunPhase,
    Task,
    TaskKind,
    TaskState,
    new_id,
    require_aware,
    task_inventory_digest,
    task_result_digest,
)


class TransitionRejected(DomainError):
    """A requested transition did not satisfy coordination guards."""


def _require_exact_record_tuple(
    values: object,
    expected_type: type[object],
    label: str,
) -> None:
    if type(values) is not tuple or any(
        type(value) is not expected_type
        for value in cast(tuple[object, ...], values)
    ):
        raise DomainError(
            f"transition {label} must be an exact tuple of exact records"
        )


@dataclass(frozen=True, slots=True)
class TransitionContext:
    """Facts used by transition guards.

    Callers must provide the records read in the same transaction as the run.
    A persistence adapter can then use the run revision for optimistic locking.
    """

    questions: Sequence[Question] = ()
    approvals: Sequence[Approval] = ()
    tasks: Sequence[Task] = ()
    agents: Sequence[Agent] = ()
    evidence: Sequence[Evidence] = ()
    required_approval_kind: ApprovalKind | None = None
    required_subject_digest: str | None = None
    verification_passed: bool = False

    def __post_init__(self) -> None:
        if type(self) is not TransitionContext:
            raise DomainError(
                "transition contexts must use the exact TransitionContext type"
            )
        if type(self.verification_passed) is not bool:
            raise DomainError("verification_passed must be an exact boolean")
        if self.required_approval_kind is not None and type(
            self.required_approval_kind
        ) is not ApprovalKind:
            raise DomainError(
                "required_approval_kind must be an exact ApprovalKind or null"
            )
        if self.required_subject_digest is not None and type(
            self.required_subject_digest
        ) is not str:
            raise DomainError(
                "required_subject_digest must be an exact string or null"
            )
        _require_exact_record_tuple(self.questions, Question, "questions")
        _require_exact_record_tuple(self.approvals, Approval, "approvals")
        _require_exact_record_tuple(self.tasks, Task, "tasks")
        _require_exact_record_tuple(self.agents, Agent, "agents")
        _require_exact_record_tuple(self.evidence, Evidence, "evidence")

    def open_blocking_questions(self, run: Run) -> tuple[Question, ...]:
        return tuple(
            question
            for question in self.questions
            if question.run_id == run.id
            and question.blocking
            and question.state is QuestionState.OPEN
        )

    def has_valid_approval(
        self, run: Run, kind: ApprovalKind, subject_digest: str, at: datetime
    ) -> bool:
        return any(
            approval.run_id == run.id
            and approval.kind is kind
            and approval.is_valid_for(subject_digest, at)
            for approval in self.approvals
        )

    def all_required_tasks_succeeded(self, run: Run) -> bool:
        relevant = [task for task in self.tasks if task.run_id == run.id]
        return bool(relevant) and all(
            task.state in {TaskState.SUCCEEDED, TaskState.CANCELLED}
            for task in relevant
        )

    def matches_task_inventory(self, run: Run) -> bool:
        if run.task_inventory_digest is None:
            return False
        if any(task.run_id != run.id for task in self.tasks):
            return False
        try:
            actual = task_inventory_digest(run.id, self.tasks)
        except DomainError:
            return False
        return actual == run.task_inventory_digest

    def has_required_independent_critic_reviews(self, run: Run) -> bool:
        """Check that every design mutation has a distinct critic completion."""

        relevant = tuple(task for task in self.tasks if task.run_id == run.id)
        review_targets = tuple(
            task
            for task in relevant
            if task.kind in {TaskKind.DESIGN, TaskKind.IMPLEMENT}
            and task.state is not TaskState.CANCELLED
        )
        if not review_targets:
            return True
        reviews = tuple(
            task
            for task in relevant
            if task.kind is TaskKind.REVIEW
            and task.required_agent_class is AgentClass.CRITIC
            and task.state is TaskState.SUCCEEDED
            and task.completed_by_agent_id is not None
            and bool(task.result_evidence_ids)
        )
        agent_by_id = {
            agent.id: agent for agent in self.agents if agent.run_id == run.id
        }
        evidence_by_id = {
            item.id: item for item in self.evidence if item.run_id == run.id
        }
        if (
            len(agent_by_id) != len(self.agents)
            or len(evidence_by_id) != len(self.evidence)
        ):
            return False

        def binds_exact_target_result(review: Task, target: Task) -> bool:
            bindings = {
                binding.task_id: binding.result_digest
                for binding in review.reviewed_result_bindings
            }
            if set(bindings) != set(review.reviewed_task_ids):
                return False
            try:
                target_evidence = tuple(
                    evidence_by_id[evidence_id]
                    for evidence_id in target.result_evidence_ids
                )
                actual_result_digest = task_result_digest(target, target_evidence)
            except (DomainError, KeyError):
                return False
            return bindings.get(target.id) == actual_result_digest

        return all(
            target.completed_by_agent_id in agent_by_id
            and any(
                target.id in review.reviewed_task_ids
                and review.completed_by_agent_id != target.completed_by_agent_id
                and (reviewer_id := review.completed_by_agent_id) is not None
                and reviewer_id in agent_by_id
                and agent_by_id[reviewer_id].agent_class
                is AgentClass.CRITIC
                and binds_exact_target_result(review, target)
                and all(
                    evidence_id in evidence_by_id
                    and evidence_by_id[evidence_id].task_id == review.id
                    for evidence_id in review.result_evidence_ids
                )
                for review in reviews
            )
            for target in review_targets
        )


_EMPTY_TRANSITION_CONTEXT = TransitionContext()


_ALLOWED: dict[RunPhase, frozenset[RunPhase]] = {
    RunPhase.DRAFT: frozenset(
        {
            RunPhase.CLARIFYING,
            RunPhase.AWAITING_PLAN_APPROVAL,
            RunPhase.READY,
            RunPhase.CANCELLED,
        }
    ),
    RunPhase.CLARIFYING: frozenset(
        {
            RunPhase.AWAITING_PLAN_APPROVAL,
            RunPhase.READY,
            RunPhase.EXECUTING,
            RunPhase.VERIFYING,
            RunPhase.CANCELLED,
        }
    ),
    RunPhase.AWAITING_PLAN_APPROVAL: frozenset(
        {RunPhase.CLARIFYING, RunPhase.READY, RunPhase.CANCELLED}
    ),
    RunPhase.READY: frozenset(
        {RunPhase.CLARIFYING, RunPhase.EXECUTING, RunPhase.CANCELLED}
    ),
    RunPhase.EXECUTING: frozenset(
        {
            RunPhase.CLARIFYING,
            RunPhase.AWAITING_CHANGE_APPROVAL,
            RunPhase.VERIFYING,
            RunPhase.FAILED,
            RunPhase.CANCELLED,
        }
    ),
    RunPhase.AWAITING_CHANGE_APPROVAL: frozenset(
        {
            RunPhase.CLARIFYING,
            RunPhase.EXECUTING,
            RunPhase.FAILED,
            RunPhase.CANCELLED,
        }
    ),
    RunPhase.VERIFYING: frozenset(
        {
            RunPhase.CLARIFYING,
            RunPhase.AWAITING_CHANGE_APPROVAL,
            RunPhase.EXECUTING,
            RunPhase.COMPLETED,
            RunPhase.FAILED,
            RunPhase.CANCELLED,
        }
    ),
    RunPhase.COMPLETED: frozenset(),
    RunPhase.FAILED: frozenset(),
    RunPhase.CANCELLED: frozenset(),
}


_STAGE_NEXT: dict[CoordinationStage, CoordinationStage] = {
    CoordinationStage.QUESTIONING: CoordinationStage.AWAITING_BRIEF_APPROVAL,
    CoordinationStage.AWAITING_BRIEF_APPROVAL: CoordinationStage.RESEARCH,
    CoordinationStage.RESEARCH: CoordinationStage.AWAITING_ARCHITECTURE_BOM_APPROVAL,
    CoordinationStage.AWAITING_ARCHITECTURE_BOM_APPROVAL: CoordinationStage.SCHEMATIC_STAGE,
    CoordinationStage.SCHEMATIC_STAGE: CoordinationStage.AWAITING_SCHEMATIC_APPROVAL,
    CoordinationStage.AWAITING_SCHEMATIC_APPROVAL: (
        CoordinationStage.AWAITING_LAYOUT_CONSTRAINT_APPROVAL
    ),
    CoordinationStage.AWAITING_LAYOUT_CONSTRAINT_APPROVAL: CoordinationStage.PLACEMENT_STAGE,
    CoordinationStage.PLACEMENT_STAGE: CoordinationStage.AWAITING_PLACEMENT_APPROVAL,
    CoordinationStage.AWAITING_PLACEMENT_APPROVAL: CoordinationStage.ROUTING_STAGE,
    CoordinationStage.ROUTING_STAGE: CoordinationStage.AWAITING_ROUTING_APPROVAL,
    CoordinationStage.AWAITING_ROUTING_APPROVAL: CoordinationStage.RELEASE_CHECK,
    CoordinationStage.RELEASE_CHECK: CoordinationStage.AWAITING_RELEASE_APPROVAL,
    CoordinationStage.AWAITING_RELEASE_APPROVAL: CoordinationStage.RELEASED,
}

_CHECKPOINT_KIND: dict[CoordinationStage, ApprovalKind] = {
    CoordinationStage.AWAITING_BRIEF_APPROVAL: ApprovalKind.BRIEF,
    CoordinationStage.AWAITING_ARCHITECTURE_BOM_APPROVAL: ApprovalKind.ARCHITECTURE_BOM,
    CoordinationStage.AWAITING_SCHEMATIC_APPROVAL: ApprovalKind.SCHEMATIC,
    CoordinationStage.AWAITING_LAYOUT_CONSTRAINT_APPROVAL: ApprovalKind.LAYOUT_CONSTRAINTS,
    CoordinationStage.AWAITING_PLACEMENT_APPROVAL: ApprovalKind.PLACEMENT,
    CoordinationStage.AWAITING_ROUTING_APPROVAL: ApprovalKind.ROUTING,
    CoordinationStage.AWAITING_RELEASE_APPROVAL: ApprovalKind.RELEASE,
}

_STAGE_PHASE: dict[CoordinationStage, RunPhase] = {
    CoordinationStage.QUESTIONING: RunPhase.CLARIFYING,
    CoordinationStage.AWAITING_BRIEF_APPROVAL: RunPhase.AWAITING_PLAN_APPROVAL,
    CoordinationStage.RESEARCH: RunPhase.EXECUTING,
    CoordinationStage.AWAITING_ARCHITECTURE_BOM_APPROVAL: RunPhase.AWAITING_CHANGE_APPROVAL,
    CoordinationStage.SCHEMATIC_STAGE: RunPhase.EXECUTING,
    CoordinationStage.AWAITING_SCHEMATIC_APPROVAL: RunPhase.AWAITING_CHANGE_APPROVAL,
    CoordinationStage.AWAITING_LAYOUT_CONSTRAINT_APPROVAL: RunPhase.AWAITING_CHANGE_APPROVAL,
    CoordinationStage.PLACEMENT_STAGE: RunPhase.EXECUTING,
    CoordinationStage.AWAITING_PLACEMENT_APPROVAL: RunPhase.AWAITING_CHANGE_APPROVAL,
    CoordinationStage.ROUTING_STAGE: RunPhase.EXECUTING,
    CoordinationStage.AWAITING_ROUTING_APPROVAL: RunPhase.AWAITING_CHANGE_APPROVAL,
    CoordinationStage.RELEASE_CHECK: RunPhase.VERIFYING,
    CoordinationStage.AWAITING_RELEASE_APPROVAL: RunPhase.AWAITING_CHANGE_APPROVAL,
    CoordinationStage.RELEASED: RunPhase.COMPLETED,
}


class RunStateMachine:
    """Pure transition logic for a run.

    The machine never silently bypasses a user gate.  Approval receipts are
    bound to the exact plan or changeset digest, preventing a later mutation
    from inheriting approval for older content.
    """

    @classmethod
    def transition(
        cls,
        run: Run,
        target: RunPhase,
        *,
        at: datetime,
        context: TransitionContext = _EMPTY_TRANSITION_CONTEXT,
    ) -> Run:
        if cls is not RunStateMachine:
            raise TransitionRejected("run transitions require RunStateMachine")
        if type(run) is not Run:
            raise TransitionRejected("run transitions require an exact Run record")
        if type(target) is not RunPhase:
            raise TransitionRejected("run transition target must be an exact RunPhase")
        if type(context) is not TransitionContext:
            raise TransitionRejected(
                "run transitions require an exact TransitionContext record"
            )
        require_aware(at)
        if run.phase in TERMINAL_RUN_PHASES:
            raise TransitionRejected(f"terminal run {run.id} cannot transition")
        if target == run.phase:
            raise TransitionRejected("no-op run transitions are not allowed")
        if target not in _ALLOWED[run.phase]:
            raise TransitionRejected(
                f"transition {run.phase.value} -> {target.value} is not allowed"
            )

        if run.strict_user_coordination and target in {
            RunPhase.READY,
            RunPhase.EXECUTING,
            RunPhase.VERIFYING,
            RunPhase.COMPLETED,
        }:
            open_questions = context.open_blocking_questions(run)
            if open_questions:
                ids = ", ".join(str(question.id) for question in open_questions)
                raise TransitionRejected(f"blocking questions remain open: {ids}")

        if target in {RunPhase.READY, RunPhase.EXECUTING}:
            cls._require_plan_approval(run, context, at)

        if run.phase is RunPhase.AWAITING_CHANGE_APPROVAL and target is RunPhase.EXECUTING:
            kind = context.required_approval_kind or ApprovalKind.CHANGESET
            digest = context.required_subject_digest
            if not digest:
                raise TransitionRejected("changeset approval requires an exact digest")
            if not context.has_valid_approval(run, kind, digest, at):
                raise TransitionRejected(
                    f"no valid {kind.value} approval for digest {digest}"
                )

        if target is RunPhase.COMPLETED:
            if not context.verification_passed:
                raise TransitionRejected("run cannot complete without passed verification")
            if not context.matches_task_inventory(run):
                raise TransitionRejected(
                    "run cannot complete without its exact sealed task inventory"
                )
            if not context.all_required_tasks_succeeded(run):
                raise TransitionRejected(
                    "run cannot complete before all tasks are terminal-success"
                )
            if (
                run.require_independent_critic
                and not context.has_required_independent_critic_reviews(run)
            ):
                raise TransitionRejected(
                    "run cannot complete without independent critic review"
                )

        return replace(run, phase=target, revision=run.revision + 1)

    @staticmethod
    def _require_plan_approval(
        run: Run, context: TransitionContext, at: datetime
    ) -> None:
        if not run.require_plan_approval:
            return
        if not run.plan_digest:
            raise TransitionRejected("approved execution requires a plan digest")
        if not context.has_valid_approval(
            run, ApprovalKind.PLAN, run.plan_digest, at
        ):
            raise TransitionRejected(
                f"no valid plan approval for digest {run.plan_digest}"
            )


class CoordinationStageMachine:
    """Exact, user-visible PCB workflow with approval at every risky boundary."""

    @classmethod
    def advance(
        cls,
        run: Run,
        *,
        target: CoordinationStage,
        at: datetime,
        context: TransitionContext = _EMPTY_TRANSITION_CONTEXT,
    ) -> Run:
        if cls is not CoordinationStageMachine:
            raise TransitionRejected(
                "coordination transitions require CoordinationStageMachine"
            )
        if type(run) is not Run:
            raise TransitionRejected(
                "coordination transitions require an exact Run record"
            )
        if type(target) is not CoordinationStage:
            raise TransitionRejected(
                "coordination target must be an exact CoordinationStage"
            )
        if type(context) is not TransitionContext:
            raise TransitionRejected(
                "coordination transitions require an exact TransitionContext record"
            )
        require_aware(at)
        current = run.coordination_stage
        if current is CoordinationStage.RELEASED:
            raise TransitionRejected("released runs cannot advance")
        expected = _STAGE_NEXT[current]
        if target is not expected:
            raise TransitionRejected(
                f"coordination stage {current.value} must advance to {expected.value}"
            )
        if context.open_blocking_questions(run):
            raise TransitionRejected("blocking questions must be answered before stage advance")

        approval_kind = _CHECKPOINT_KIND.get(current)
        if approval_kind is not None:
            if not run.checkpoint_digest:
                raise TransitionRejected(
                    f"{current.value} has no immutable checkpoint digest"
                )
            if not context.has_valid_approval(
                run, approval_kind, run.checkpoint_digest, at
            ):
                raise TransitionRejected(
                    f"no valid {approval_kind.value} approval for checkpoint "
                    f"{run.checkpoint_digest}"
                )

        if target is CoordinationStage.RELEASED:
            if not context.verification_passed:
                raise TransitionRejected("release requires passed deterministic verification")
            if not context.matches_task_inventory(run):
                raise TransitionRejected("release requires the exact sealed task inventory")
            if not context.all_required_tasks_succeeded(run):
                raise TransitionRejected("release requires all workflow tasks to succeed")
            if (
                run.require_independent_critic
                and not context.has_required_independent_critic_reviews(run)
            ):
                raise TransitionRejected("release requires independent critic review")

        return replace(
            run,
            phase=_STAGE_PHASE[target],
            coordination_stage=target,
            checkpoint_digest=None,
            coordination_revision=run.coordination_revision + 1,
            revision=run.revision + 1,
        )

    @staticmethod
    def restart_questioning(run: Run) -> Run:
        """Fail closed when steering invalidates an upstream decision."""

        if type(run) is not Run:
            raise TransitionRejected(
                "questioning restart requires an exact Run record"
            )
        if run.coordination_stage is CoordinationStage.RELEASED:
            raise TransitionRejected("a released run needs a new revision, not silent steering")
        return replace(
            run,
            phase=RunPhase.CLARIFYING,
            coordination_stage=CoordinationStage.QUESTIONING,
            checkpoint_digest=None,
            coordination_revision=run.coordination_revision + 1,
            revision=run.revision + 1,
        )


class CoordinationService:
    """Pure operations for questions and approvals.

    Persistence and event emission are intentionally handled by the application
    layer so the operations can be retried inside a single database transaction.
    """

    @staticmethod
    def open_question(
        run: Run,
        *,
        prompt: str,
        rationale: str,
        at: datetime,
        blocking: bool = True,
        options: Sequence[str] = (),
        recommendation: str | None = None,
        confidence_basis_points: int | None = None,
        allow_custom_answer: bool = False,
        bound_revision: str | None = None,
        affected_artifact_ids: Sequence[str] = (),
        dependent_decision_ids: Sequence[str] = (),
        question_id: QuestionId | None = None,
    ) -> tuple[Run, Question]:
        require_aware(at)
        if run.phase in TERMINAL_RUN_PHASES:
            raise TransitionRejected("cannot ask a question on a terminal run")
        normalized_options = tuple(option.strip() for option in options)
        if any(not option for option in normalized_options):
            raise DomainError("question options cannot be blank")
        if len(set(normalized_options)) != len(normalized_options):
            raise DomainError("question options must be unique")
        question = Question(
            id=question_id or QuestionId(new_id("question")),
            run_id=run.id,
            prompt=prompt,
            rationale=rationale,
            asked_at=at,
            blocking=blocking,
            options=normalized_options,
            recommendation=recommendation,
            confidence_basis_points=confidence_basis_points,
            allow_custom_answer=allow_custom_answer,
            bound_revision=bound_revision,
            affected_artifact_ids=tuple(affected_artifact_ids),
            dependent_decision_ids=tuple(dependent_decision_ids),
        )
        next_run = (
            replace(
                run,
                phase=RunPhase.CLARIFYING,
                coordination_stage=CoordinationStage.QUESTIONING,
                checkpoint_digest=None,
                coordination_revision=run.coordination_revision + 1,
                revision=run.revision + 1,
            )
            if blocking
            and (
                run.phase is not RunPhase.CLARIFYING
                or run.coordination_stage is not CoordinationStage.QUESTIONING
            )
            else run
        )
        return next_run, question

    @staticmethod
    def request_checkpoint_approval(
        run: Run,
        *,
        kind: ApprovalKind,
        subject_digest: str,
        summary: str,
        at: datetime,
        expires_at: datetime | None = None,
        approval_id: ApprovalId | None = None,
    ) -> tuple[Run, Approval]:
        """Enter/populate the next exact product checkpoint and bind its receipt."""

        require_aware(at)
        targets = [stage for stage, expected in _CHECKPOINT_KIND.items() if expected is kind]
        if len(targets) != 1:
            raise DomainError(f"{kind.value} is not a product checkpoint approval kind")
        target = targets[0]
        current = run.coordination_stage
        if current is not target and _STAGE_NEXT.get(current) is not target:
            raise TransitionRejected(
                f"{kind.value} approval is not valid during {current.value}"
            )
        if not subject_digest:
            raise DomainError("checkpoint approval requires an immutable subject digest")
        next_run = replace(
            run,
            phase=_STAGE_PHASE[target],
            coordination_stage=target,
            checkpoint_digest=subject_digest,
            coordination_revision=run.coordination_revision + 1,
            revision=run.revision + 1,
        )
        approval = Approval(
            id=approval_id or ApprovalId(new_id("approval")),
            run_id=run.id,
            kind=kind,
            subject_digest=subject_digest,
            summary=summary,
            requested_at=at,
            expires_at=expires_at,
        )
        return next_run, approval

    @staticmethod
    def answer_question(
        question: Question,
        *,
        answer: str,
        answered_by: str,
        at: datetime,
    ) -> Question:
        require_aware(at)
        if question.state is not QuestionState.OPEN:
            raise DomainError("only open questions can be answered")
        normalized = answer.strip()
        if not normalized or not answered_by.strip():
            raise DomainError("answer and answering user are required")
        if (
            question.options
            and normalized not in question.options
            and not question.allow_custom_answer
        ):
            raise DomainError("answer must exactly match one of the declared options")
        return replace(
            question,
            state=QuestionState.ANSWERED,
            answer=normalized,
            answered_by=answered_by,
            answered_at=at,
        )

    @staticmethod
    def request_approval(
        run: Run,
        *,
        kind: ApprovalKind,
        subject_digest: str,
        summary: str,
        at: datetime,
        expires_at: datetime | None = None,
        approval_id: ApprovalId | None = None,
    ) -> tuple[Run, Approval]:
        require_aware(at)
        if run.phase in TERMINAL_RUN_PHASES:
            raise TransitionRejected("cannot request approval on a terminal run")
        if kind is ApprovalKind.PLAN:
            target = RunPhase.AWAITING_PLAN_APPROVAL
            next_run = replace(
                run,
                phase=target,
                plan_digest=subject_digest,
                revision=run.revision + 1,
            )
        else:
            target = RunPhase.AWAITING_CHANGE_APPROVAL
            if target not in _ALLOWED[run.phase] and run.phase is not target:
                raise TransitionRejected(
                    f"cannot request {kind.value} approval during {run.phase.value}"
                )
            next_run = (
                replace(run, phase=target, revision=run.revision + 1)
                if run.phase is not target
                else run
            )
        approval = Approval(
            id=approval_id or ApprovalId(new_id("approval")),
            run_id=run.id,
            kind=kind,
            subject_digest=subject_digest,
            summary=summary,
            requested_at=at,
            expires_at=expires_at,
        )
        return next_run, approval

    @staticmethod
    def decide_approval(
        approval: Approval,
        *,
        approve: bool,
        decided_by: str,
        reason: str,
        at: datetime,
    ) -> Approval:
        require_aware(at)
        if approval.state is not ApprovalState.REQUESTED:
            raise DomainError("approval has already been decided")
        if not decided_by.strip():
            raise DomainError("approval decision requires a user identity")
        if approval.expires_at is not None and at >= approval.expires_at:
            return replace(
                approval,
                state=ApprovalState.EXPIRED,
                decided_by=decided_by,
                decided_at=at,
                reason=reason or "expired before decision",
            )
        return replace(
            approval,
            state=ApprovalState.APPROVED if approve else ApprovalState.REJECTED,
            decided_by=decided_by,
            decided_at=at,
            reason=reason,
        )

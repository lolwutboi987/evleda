"""Capability enforcement and strict user-coordination application service."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from threading import RLock
from typing import Any

from .adapter import EvidenceBoundCommitAdapter, KiCadAdapter
from .codec import canonical_json, stable_digest
from .errors import (
    ApprovalRequired,
    CapabilityDenied,
    CoordinationRequired,
    IdempotencyConflict,
    InvalidRequest,
    NotFound,
    RevisionConflict,
    VerificationFailed,
)
from .manifest import MANIFEST_BY_NAME, TOOL_MANIFEST_DIGEST, tool_manifest
from .models import (
    ActorKind,
    AgentRun,
    AnswerQuestionRequest,
    ApprovalDecision,
    ApprovalKind,
    ApprovalReceipt,
    ApprovalRequestRecord,
    CommitTransactionRequest,
    CreateAgentRunRequest,
    DecideApprovalRequest,
    EvidenceRecord,
    ExportProjectRequest,
    InspectProjectRequest,
    Invocation,
    PatchPreview,
    PreviewPatchRequest,
    QuestionRecord,
    RollbackTransactionRequest,
    RunState,
    RunVerificationRequest,
    StageDesignPatchRequest,
    ToolManifestRecord,
    ToolName,
    ToolResult,
    VerificationReport,
)
from .persistence import (
    GatewayIdempotencyRecord,
    GatewaySnapshot,
    GatewayStateStore,
)

Clock = Callable[[], datetime]
Action = Callable[[], tuple[dict[str, Any], str]]


class CapabilitySafeGateway:
    """The only public model-to-ECAD boundary.

    Every public operation maps one-to-one to a manifest entry. There is no
    generic dispatcher for commands, source replacements, or paths. A caller
    can inspect/preview, stage in isolation, or release only when its trusted
    principal profile permits that tier.
    """

    def __init__(
        self,
        adapter: KiCadAdapter,
        clock: Clock | None = None,
        *,
        state_store: GatewayStateStore | None = None,
        max_parallel_agents_limit: int | None = None,
        token_budget_limit: int | None = None,
    ) -> None:
        for value, label in (
            (max_parallel_agents_limit, "max_parallel_agents_limit"),
            (token_budget_limit, "token_budget_limit"),
        ):
            if value is not None and (type(value) is not int or value < 1):
                raise ValueError(f"{label} must be a positive integer or None")
        if state_store is not None and not isinstance(state_store, GatewayStateStore):
            raise ValueError("state_store must implement GatewayStateStore")
        self._adapter = adapter
        self._clock = clock or (lambda: datetime.now(UTC))
        self._state_store = state_store
        self._state_generation = 0
        self._max_parallel_agents_limit = max_parallel_agents_limit
        self._token_budget_limit = token_budget_limit
        self._runs: dict[str, AgentRun] = {}
        self._questions: dict[str, QuestionRecord] = {}
        self._approvals: dict[str, ApprovalRequestRecord] = {}
        self._receipts: dict[str, ApprovalReceipt] = {}
        self._previews: dict[str, PatchPreview] = {}
        self._reports: dict[str, VerificationReport] = {}
        self._idempotency: dict[tuple[str, ToolName, str], tuple[str, ToolResult]] = {}
        self._evidence: list[EvidenceRecord] = []
        # One gateway instance is a transaction coordinator. Serializing the
        # check/apply/evidence/idempotency sequence prevents parallel agents
        # from both passing a stale precondition before either write lands.
        self._lock = RLock()
        if state_store is not None:
            stored = state_store.load()
            self._install_snapshot(stored.snapshot)
            self._state_generation = stored.generation

    @property
    def manifest_digest(self) -> str:
        return TOOL_MANIFEST_DIGEST

    def tool_manifest(self) -> tuple[ToolManifestRecord, ...]:
        return tool_manifest()

    def evidence_records(self) -> tuple[EvidenceRecord, ...]:
        with self._lock:
            self._refresh_persisted_locked()
            return tuple(self._evidence)

    # Host-side read methods. They are not registered as model-callable tools.
    def get_run(self, run_id: str) -> AgentRun:
        with self._lock:
            self._refresh_persisted_locked()
            return self._run(run_id)

    def get_receipt(self, receipt_id: str) -> ApprovalReceipt:
        with self._lock:
            self._refresh_persisted_locked()
            try:
                return self._receipts[receipt_id]
            except KeyError as exc:
                raise NotFound(f"approval receipt not found: {receipt_id}") from exc

    def inspect_project(self, invocation: Invocation, request: InspectProjectRequest) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            snapshot = self._adapter.inspect_project(
                request.project_id, request.expected_project_revision
            )
            return {"snapshot": snapshot}, snapshot.project_revision

        return self._invoke(ToolName.INSPECT_PROJECT, invocation, request, action)

    def create_agent_run(
        self, invocation: Invocation, request: CreateAgentRunRequest
    ) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            self._adapter.inspect_project(request.project_id, request.expected_project_revision)
            run_id = self._id("run", ToolName.CREATE_AGENT_RUN, invocation, request.project_id)
            if run_id in self._runs:
                raise InvalidRequest(f"run already exists: {run_id}")
            questions: list[QuestionRecord] = []
            for index, spec in enumerate(request.initial_questions):
                question_id = (
                    f"question_{stable_digest({'run': run_id, 'index': index, 'spec': spec})[:32]}"
                )
                question = QuestionRecord(
                    question_id=question_id,
                    run_id=run_id,
                    prompt=spec.prompt,
                    rationale=spec.rationale,
                    blocking=spec.blocking,
                    options=spec.options,
                )
                self._questions[question_id] = question
                questions.append(question)
            has_blocking = any(question.blocking for question in questions)
            max_parallel_agents = request.max_parallel_agents
            token_budget = request.token_budget
            if self._max_parallel_agents_limit is not None:
                if (
                    max_parallel_agents is not None
                    and max_parallel_agents > self._max_parallel_agents_limit
                ):
                    raise InvalidRequest("max_parallel_agents exceeds the trusted host limit")
                if max_parallel_agents is None:
                    max_parallel_agents = self._max_parallel_agents_limit
            if self._token_budget_limit is not None:
                if token_budget is not None and token_budget > self._token_budget_limit:
                    raise InvalidRequest("token_budget exceeds the trusted host limit")
                if token_budget is None:
                    token_budget = self._token_budget_limit
            run = AgentRun(
                run_id=run_id,
                project_id=request.project_id,
                objective=request.objective,
                project_revision=request.expected_project_revision,
                run_revision=0,
                state=RunState.CLARIFYING if has_blocking else RunState.PLANNING,
                strict_user_coordination=True,
                max_parallel_agents=max_parallel_agents,
                token_budget=token_budget,
                question_ids=tuple(question.question_id for question in questions),
            )
            self._runs[run_id] = run
            return {"run": run, "questions": tuple(questions)}, run.project_revision

        return self._invoke(ToolName.CREATE_AGENT_RUN, invocation, request, action)

    def answer_question(self, invocation: Invocation, request: AnswerQuestionRequest) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            self._require_human(invocation, "coordination questions")
            run = self._require_run_preconditions(
                request.run_id,
                request.project_id,
                request.expected_project_revision,
                request.expected_run_revision,
            )
            try:
                question = self._questions[request.question_id]
            except KeyError as exc:
                raise NotFound(f"question not found: {request.question_id}") from exc
            if question.run_id != run.run_id:
                raise InvalidRequest("question belongs to a different run")
            if question.answer is not None:
                raise CoordinationRequired("question has already been answered")
            if question.options and request.answer not in question.options:
                raise InvalidRequest("answer must exactly match a declared option")
            answered = replace(
                question,
                answer=request.answer,
                answered_by=invocation.principal.actor_id,
                answered_at=self._now(),
            )
            self._questions[question.question_id] = answered
            remaining = self._open_blocking_questions(run)
            updated = replace(
                run,
                run_revision=run.run_revision + 1,
                state=RunState.CLARIFYING if remaining else RunState.PLANNING,
            )
            self._runs[run.run_id] = updated
            return {
                "question": answered,
                "run": updated,
                "open_blocking_question_ids": tuple(item.question_id for item in remaining),
            }, run.project_revision

        return self._invoke(ToolName.ANSWER_QUESTION, invocation, request, action)

    def decide_approval(self, invocation: Invocation, request: DecideApprovalRequest) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            self._require_human(invocation, "approval decisions")
            run = self._require_run_preconditions(
                request.run_id,
                request.project_id,
                request.expected_project_revision,
                request.expected_run_revision,
            )
            try:
                approval = self._approvals[request.approval_id]
            except KeyError as exc:
                raise NotFound(f"approval not found: {request.approval_id}") from exc
            if approval.run_id != run.run_id:
                raise InvalidRequest("approval belongs to a different run")
            if approval.decision is not ApprovalDecision.PENDING:
                raise CoordinationRequired("approval has already been decided")
            decision = ApprovalDecision.APPROVED if request.approve else ApprovalDecision.REJECTED
            decided_at = self._now()
            receipt_id = f"receipt_{stable_digest({'approval': approval.approval_id, 'decision': decision, 'actor': invocation.principal.actor_id, 'key': invocation.idempotency_key})[:32]}"
            receipt_material = {
                "receipt_id": receipt_id,
                "approval_id": approval.approval_id,
                "run_id": run.run_id,
                "kind": approval.kind,
                "subject_digest": approval.subject_digest,
                "decision": decision,
                "decided_by": invocation.principal.actor_id,
                "decided_at": decided_at,
                "reason": request.reason,
            }
            receipt = ApprovalReceipt(
                **receipt_material,
                receipt_digest=stable_digest(receipt_material),
            )
            self._approvals[approval.approval_id] = replace(approval, decision=decision)
            self._receipts[receipt_id] = receipt
            if decision is ApprovalDecision.REJECTED:
                next_state = (
                    RunState.PLANNING if approval.kind is ApprovalKind.STAGE else RunState.STAGED
                )
            else:
                next_state = run.state
            updated = replace(run, run_revision=run.run_revision + 1, state=next_state)
            self._runs[run.run_id] = updated
            return {"receipt": receipt, "run": updated}, run.project_revision

        return self._invoke(ToolName.DECIDE_APPROVAL, invocation, request, action)

    def preview_patch(self, invocation: Invocation, request: PreviewPatchRequest) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            run = self._require_run_preconditions(
                request.run_id,
                request.project_id,
                request.expected_project_revision,
                request.expected_run_revision,
            )
            if self._open_blocking_questions(run):
                raise CoordinationRequired("all blocking questions must be answered before preview")
            if run.state is not RunState.PLANNING:
                raise CoordinationRequired(
                    f"patch preview is not allowed while run is {run.state.value}"
                )
            preview = self._adapter.preview_patch(
                request.project_id, request.expected_project_revision, request.patch
            )
            approval_id = f"approval_{stable_digest({'run': run.run_id, 'kind': 'stage', 'preview': preview.preview_digest})[:32]}"
            existing = self._approvals.get(approval_id)
            if existing is not None and existing.decision is ApprovalDecision.REJECTED:
                raise CoordinationRequired(
                    "this exact preview was rejected; revise the patch before requesting approval again"
                )
            approval = ApprovalRequestRecord(
                approval_id=approval_id,
                run_id=run.run_id,
                kind=ApprovalKind.STAGE,
                subject_digest=preview.preview_digest,
                summary=f"Stage {len(request.patch.operations)} typed design operations",
                decision=ApprovalDecision.PENDING,
                requested_at=self._now(),
            )
            self._previews[preview.preview_digest] = preview
            self._approvals[approval_id] = approval
            updated = replace(
                run,
                run_revision=run.run_revision + 1,
                state=RunState.AWAITING_STAGE_APPROVAL,
                approval_ids=run.approval_ids + (approval_id,),
            )
            self._runs[run.run_id] = updated
            return {"preview": preview, "approval": approval, "run": updated}, run.project_revision

        return self._invoke(ToolName.PREVIEW_PATCH, invocation, request, action)

    def stage_design_patch(
        self, invocation: Invocation, request: StageDesignPatchRequest
    ) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            run = self._require_run_preconditions(
                request.run_id,
                request.project_id,
                request.expected_project_revision,
                request.expected_run_revision,
            )
            if run.state is not RunState.AWAITING_STAGE_APPROVAL:
                raise CoordinationRequired("run is not awaiting an approved stage")
            preview = self._previews.get(request.preview_digest)
            if preview is None or preview.patch_digest != request.patch.digest:
                raise RevisionConflict("preview does not match this exact patch")
            self._require_approved_receipt(
                request.approval_receipt_id,
                run,
                ApprovalKind.STAGE,
                request.preview_digest,
            )
            stage = self._adapter.stage_patch(
                request.project_id,
                request.expected_project_revision,
                request.patch,
                request.preview_digest,
            )
            updated = replace(
                run,
                run_revision=run.run_revision + 1,
                state=RunState.STAGED,
                staged_revision=stage.staged_revision,
            )
            self._runs[run.run_id] = updated
            return {"stage": stage, "run": updated}, run.project_revision

        return self._invoke(ToolName.STAGE_DESIGN_PATCH, invocation, request, action)

    def run_verification(
        self, invocation: Invocation, request: RunVerificationRequest
    ) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            run = self._require_run_preconditions(
                request.run_id,
                request.project_id,
                request.expected_project_revision,
                request.expected_run_revision,
            )
            if run.state is not RunState.STAGED:
                raise CoordinationRequired("run must have an exact staged revision")
            if run.staged_revision != request.expected_staged_revision:
                raise RevisionConflict("run staged revision does not match precondition")
            report = self._adapter.run_verification(
                request.project_id,
                request.expected_project_revision,
                request.expected_staged_revision,
            )
            approval: ApprovalRequestRecord | None = None
            next_state = RunState.STAGED
            approval_ids = run.approval_ids
            if report.passed:
                subject = self._release_subject(
                    run.run_id,
                    request.expected_project_revision,
                    request.expected_staged_revision,
                    report.report_digest,
                )
                approval_id = f"approval_{stable_digest({'run': run.run_id, 'kind': 'release', 'subject': subject})[:32]}"
                existing = self._approvals.get(approval_id)
                if existing is not None and existing.decision is ApprovalDecision.REJECTED:
                    raise CoordinationRequired(
                        "release was rejected for this exact verified stage; revise or roll back the stage"
                    )
                approval = ApprovalRequestRecord(
                    approval_id=approval_id,
                    run_id=run.run_id,
                    kind=ApprovalKind.RELEASE,
                    subject_digest=subject,
                    summary="Commit the exact staged revision after deterministic verification",
                    decision=ApprovalDecision.PENDING,
                    requested_at=self._now(),
                )
                self._approvals[approval_id] = approval
                approval_ids = approval_ids + (approval_id,)
                next_state = RunState.AWAITING_RELEASE_APPROVAL
            self._reports[report.report_digest] = report
            updated = replace(
                run,
                run_revision=run.run_revision + 1,
                state=next_state,
                verification_report_digest=report.report_digest,
                approval_ids=approval_ids,
            )
            self._runs[run.run_id] = updated
            return {"report": report, "approval": approval, "run": updated}, run.project_revision

        return self._invoke(ToolName.RUN_VERIFICATION, invocation, request, action)

    def commit_transaction(
        self, invocation: Invocation, request: CommitTransactionRequest
    ) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            run = self._require_run_preconditions(
                request.run_id,
                request.project_id,
                request.expected_project_revision,
                request.expected_run_revision,
            )
            if run.state is not RunState.AWAITING_RELEASE_APPROVAL:
                raise CoordinationRequired("run is not awaiting release approval")
            if run.staged_revision != request.expected_staged_revision:
                raise RevisionConflict("run staged revision does not match precondition")
            report = self._reports.get(request.verification_report_digest)
            if report is None or not report.passed:
                raise VerificationFailed("a passing deterministic report is required")
            if (
                report.base_revision != request.expected_project_revision
                or report.staged_revision != request.expected_staged_revision
            ):
                raise VerificationFailed("verification report is for another revision")
            subject = self._release_subject(
                run.run_id,
                request.expected_project_revision,
                request.expected_staged_revision,
                request.verification_report_digest,
            )
            receipt = self._require_approved_receipt(
                request.approval_receipt_id,
                run,
                ApprovalKind.RELEASE,
                subject,
            )
            if isinstance(self._adapter, EvidenceBoundCommitAdapter):
                new_revision = self._adapter.commit_with_evidence(
                    request.project_id,
                    request.expected_project_revision,
                    request.expected_staged_revision,
                    run=run,
                    report=report,
                    receipt=receipt,
                )
            else:
                new_revision = self._adapter.commit(
                    request.project_id,
                    request.expected_project_revision,
                    request.expected_staged_revision,
                )
            updated = replace(
                run,
                project_revision=new_revision,
                run_revision=run.run_revision + 1,
                state=RunState.COMPLETE,
            )
            self._runs[run.run_id] = updated
            return {
                "committed_revision": new_revision,
                "approval_receipt_digest": receipt.receipt_digest,
                "verification_report_digest": report.report_digest,
                "run": updated,
            }, new_revision

        return self._invoke(ToolName.COMMIT_TRANSACTION, invocation, request, action)

    def rollback_transaction(
        self, invocation: Invocation, request: RollbackTransactionRequest
    ) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            run = self._require_run_preconditions(
                request.run_id,
                request.project_id,
                request.expected_project_revision,
                request.expected_run_revision,
            )
            if run.staged_revision != request.expected_staged_revision:
                raise RevisionConflict("run staged revision does not match precondition")
            if run.state not in {
                RunState.STAGED,
                RunState.AWAITING_RELEASE_APPROVAL,
            }:
                raise CoordinationRequired("run has no rollback-eligible stage")
            current = self._adapter.rollback(
                request.project_id,
                request.expected_project_revision,
                request.expected_staged_revision,
            )
            updated = replace(
                run,
                run_revision=run.run_revision + 1,
                state=RunState.ROLLED_BACK,
            )
            self._runs[run.run_id] = updated
            return {
                "rolled_back_staged_revision": request.expected_staged_revision,
                "current_project_revision": current,
                "reason": request.reason,
                "run": updated,
            }, current

        return self._invoke(ToolName.ROLLBACK_TRANSACTION, invocation, request, action)

    def export_project(self, invocation: Invocation, request: ExportProjectRequest) -> ToolResult:
        def action() -> tuple[dict[str, Any], str]:
            artifact = self._adapter.export_project(
                request.project_id,
                request.expected_project_revision,
                request.format,
            )
            # Only immutable metadata crosses the tool boundary. Artifact bytes
            # are streamed by the authenticated host, never written to a caller path.
            return {"artifact": artifact}, artifact.project_revision

        return self._invoke(ToolName.EXPORT_PROJECT, invocation, request, action)

    def _invoke(
        self,
        tool_name: ToolName,
        invocation: Invocation,
        request: Any,
        action: Action,
    ) -> ToolResult:
        with self._lock:
            return self._invoke_locked(tool_name, invocation, request, action)

    def _invoke_locked(
        self,
        tool_name: ToolName,
        invocation: Invocation,
        request: Any,
        action: Action,
    ) -> ToolResult:
        self._refresh_persisted_locked()
        manifest = MANIFEST_BY_NAME[tool_name]
        if invocation.principal.profile.maximum_tier < manifest.required_tier:
            raise CapabilityDenied(
                f"{invocation.principal.profile.value} cannot invoke {tool_name.value}; "
                f"{manifest.required_tier.name.lower()} capability is required"
            )
        input_digest = stable_digest(request)
        key = (
            invocation.principal.actor_id,
            tool_name,
            invocation.idempotency_key,
        )
        previous = self._idempotency.get(key)
        if previous is not None:
            previous_digest, result = previous
            if previous_digest != input_digest:
                raise IdempotencyConflict(
                    "idempotency key was already used with different canonical input"
                )
            return result

        captured_at = self._now()
        previous_snapshot = self._snapshot()
        previous_generation = self._state_generation
        try:
            payload, project_revision = action()
            payload_json = canonical_json(payload)
            output_digest = stable_digest(payload)
            evidence_id = f"evidence_{stable_digest({'actor': invocation.principal.actor_id, 'tool': tool_name, 'key': invocation.idempotency_key, 'input': input_digest, 'output': output_digest})[:32]}"
            project_id = getattr(request, "project_id", "unknown")
            evidence = EvidenceRecord(
                evidence_id=evidence_id,
                tool_name=tool_name,
                actor_id=invocation.principal.actor_id,
                project_id=project_id,
                project_revision=project_revision,
                input_digest=input_digest,
                output_digest=output_digest,
                captured_at=captured_at,
                manifest_digest=manifest.manifest_digest,
            )
            result = ToolResult(
                tool_name=tool_name,
                payload_json=payload_json,
                evidence=evidence,
                manifest_digest=manifest.manifest_digest,
            )
            self._idempotency[key] = (input_digest, result)
            self._evidence.append(evidence)
            if self._state_store is not None:
                stored = self._state_store.save(
                    self._snapshot(),
                    expected_generation=self._state_generation,
                )
                self._state_generation = stored.generation
            return result
        except Exception:
            self._install_snapshot(previous_snapshot)
            self._state_generation = previous_generation
            raise

    def _snapshot(self) -> GatewaySnapshot:
        return GatewaySnapshot(
            runs=tuple(self._runs.values()),
            questions=tuple(self._questions.values()),
            approvals=tuple(self._approvals.values()),
            receipts=tuple(self._receipts.values()),
            previews=tuple(self._previews.values()),
            reports=tuple(self._reports.values()),
            idempotency=tuple(
                GatewayIdempotencyRecord(actor, tool, key, input_digest, result)
                for (actor, tool, key), (input_digest, result) in self._idempotency.items()
            ),
            evidence=tuple(self._evidence),
        )

    def _install_snapshot(self, snapshot: GatewaySnapshot) -> None:
        if type(snapshot) is not GatewaySnapshot:
            raise InvalidRequest("durable gateway snapshot has an invalid type")
        for entry in snapshot.idempotency:
            expected_manifest = MANIFEST_BY_NAME[entry.tool_name].manifest_digest
            if (
                entry.result.tool_name is not entry.tool_name
                or entry.result.manifest_digest != expected_manifest
                or entry.result.evidence.manifest_digest != expected_manifest
            ):
                raise InvalidRequest(
                    "durable idempotency evidence does not match this tool manifest"
                )
        self._runs = {item.run_id: item for item in snapshot.runs}
        self._questions = {item.question_id: item for item in snapshot.questions}
        self._approvals = {item.approval_id: item for item in snapshot.approvals}
        self._receipts = {item.receipt_id: item for item in snapshot.receipts}
        self._previews = {item.preview_digest: item for item in snapshot.previews}
        self._reports = {item.report_digest: item for item in snapshot.reports}
        self._idempotency = {
            (item.actor_id, item.tool_name, item.idempotency_key): (
                item.input_digest,
                item.result,
            )
            for item in snapshot.idempotency
        }
        self._evidence = list(snapshot.evidence)
        if any(
            question_id not in self._questions
            for run in self._runs.values()
            for question_id in run.question_ids
        ) or any(
            approval_id not in self._approvals
            for run in self._runs.values()
            for approval_id in run.approval_ids
        ):
            raise InvalidRequest("durable run references missing coordination records")

    def _refresh_persisted_locked(self) -> None:
        store = self._state_store
        if store is None:
            return
        stored = store.load()
        if stored.generation < self._state_generation:
            raise InvalidRequest("durable gateway state moved backwards")
        if stored.generation > self._state_generation:
            self._install_snapshot(stored.snapshot)
            self._state_generation = stored.generation

    def _require_run_preconditions(
        self,
        run_id: str,
        project_id: str,
        expected_project_revision: str,
        expected_run_revision: int,
    ) -> AgentRun:
        self._adapter.inspect_project(project_id, expected_project_revision)
        run = self._run(run_id)
        if run.project_id != project_id:
            raise InvalidRequest("run belongs to a different project")
        if run.project_revision != expected_project_revision:
            raise RevisionConflict("run is pinned to another project revision")
        if run.run_revision != expected_run_revision:
            raise RevisionConflict(
                f"run revision mismatch: expected {expected_run_revision}, current {run.run_revision}"
            )
        return run

    def _run(self, run_id: str) -> AgentRun:
        try:
            return self._runs[run_id]
        except KeyError as exc:
            raise NotFound(f"run not found: {run_id}") from exc

    def _open_blocking_questions(self, run: AgentRun) -> tuple[QuestionRecord, ...]:
        return tuple(
            self._questions[question_id]
            for question_id in run.question_ids
            if self._questions[question_id].blocking and self._questions[question_id].answer is None
        )

    def _require_approved_receipt(
        self,
        receipt_id: str,
        run: AgentRun,
        kind: ApprovalKind,
        subject_digest: str,
    ) -> ApprovalReceipt:
        try:
            receipt = self._receipts[receipt_id]
        except KeyError as exc:
            raise ApprovalRequired(f"approval receipt not found: {receipt_id}") from exc
        if (
            receipt.run_id != run.run_id
            or receipt.kind is not kind
            or receipt.subject_digest != subject_digest
            or receipt.decision is not ApprovalDecision.APPROVED
        ):
            raise ApprovalRequired(
                "approval receipt does not authorize this exact digest and action"
            )
        return receipt

    @staticmethod
    def _require_human(invocation: Invocation, operation: str) -> None:
        if invocation.principal.actor_kind is not ActorKind.USER:
            raise CapabilityDenied(f"only an authenticated user may decide {operation}")

    @staticmethod
    def _release_subject(
        run_id: str,
        project_revision: str,
        staged_revision: str,
        report_digest: str,
    ) -> str:
        return stable_digest(
            {
                "kind": ApprovalKind.RELEASE,
                "run_id": run_id,
                "project_revision": project_revision,
                "staged_revision": staged_revision,
                "verification_report_digest": report_digest,
            }
        )

    @staticmethod
    def _id(
        prefix: str,
        tool_name: ToolName,
        invocation: Invocation,
        discriminator: str,
    ) -> str:
        digest = stable_digest(
            {
                "tool": tool_name,
                "actor": invocation.principal.actor_id,
                "idempotency_key": invocation.idempotency_key,
                "discriminator": discriminator,
            }
        )
        return f"{prefix}_{digest[:32]}"

    def _now(self) -> datetime:
        value = self._clock()
        if value.tzinfo is None or value.utcoffset() is None:
            raise InvalidRequest("gateway clock must return a timezone-aware timestamp")
        return value.astimezone(UTC)

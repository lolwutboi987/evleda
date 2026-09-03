from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import unittest

from backend.mcp_gateway import (
    ActorKind,
    AnswerQuestionRequest,
    ApprovalRequired,
    CapabilityDenied,
    CapabilitySafeGateway,
    CapabilityTier,
    CommitTransactionRequest,
    CoordinationRequired,
    CreateAgentRunRequest,
    DecideApprovalRequest,
    DesignPatch,
    ExportFormat,
    ExportProjectRequest,
    IdempotencyConflict,
    InMemoryKiCadAdapter,
    InspectProjectRequest,
    Invocation,
    InvalidRequest,
    Parameter,
    PatchAction,
    PatchOperation,
    PreviewPatchRequest,
    Principal,
    ProfileName,
    QuestionSpec,
    RevisionConflict,
    RollbackTransactionRequest,
    RunState,
    RunVerificationRequest,
    StageDesignPatchRequest,
    ToolName,
    canonical_json,
    tool_manifest,
)


NOW = datetime(2026, 8, 29, 20, 0, tzinfo=timezone.utc)
SHA_A = "a" * 64
SHA_B = "b" * 64


class GatewayTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = InMemoryKiCadAdapter()
        self.project_id = "project-1"
        self.revision = self.adapter.seed_project(self.project_id)
        self.gateway = CapabilitySafeGateway(self.adapter, clock=lambda: NOW)
        self.observer = Principal(
            "agent-observer", ActorKind.AGENT, ProfileName.OBSERVER
        )
        self.designer = Principal(
            "agent-designer", ActorKind.AGENT, ProfileName.DESIGNER
        )
        self.human = Principal(
            "user-owner", ActorKind.USER, ProfileName.RELEASE_MANAGER
        )

    @staticmethod
    def invocation(principal: Principal, key: str) -> Invocation:
        return Invocation(principal, key)

    def good_patch(self, suffix: str = "1") -> DesignPatch:
        operation = PatchOperation(
            operation_id=f"op-{suffix}",
            action=PatchAction.ADD_COMPONENT,
            target_id=f"U{suffix}",
            parameters=(
                Parameter("datasheet_sha256", SHA_A),
                Parameter("footprint", "Package_QFN:QFN-32"),
                Parameter("manufacturer_part_number", "STM32G031K8U6"),
                Parameter("pin_map_sha256", SHA_B),
                Parameter("symbol", "MCU_ST_STM32G0:STM32G031K8Ux"),
            ),
        )
        return DesignPatch(
            patch_id=f"patch-{suffix}",
            base_revision=self.revision,
            rationale="Add a fully grounded controller",
            operations=(operation,),
        )

    def create_run(self, questions: tuple[QuestionSpec, ...] = ()) -> tuple[str, int]:
        result = self.gateway.create_agent_run(
            self.invocation(self.designer, f"create-{len(self.gateway.evidence_records())}"),
            CreateAgentRunRequest(
                project_id=self.project_id,
                expected_project_revision=self.revision,
                objective="Design a deterministic controller board",
                initial_questions=questions,
                max_parallel_agents=None,
                token_budget=None,
            ),
        )
        run = result.payload()["run"]
        return run["run_id"], run["run_revision"]

    def preview_and_approve(
        self, run_id: str, run_revision: int, patch: DesignPatch
    ) -> tuple[str, str, int]:
        preview_result = self.gateway.preview_patch(
            self.invocation(self.designer, f"preview-{patch.patch_id}"),
            PreviewPatchRequest(
                self.project_id,
                self.revision,
                run_id,
                run_revision,
                patch,
            ),
        )
        preview_payload = preview_result.payload()
        approval_id = preview_payload["approval"]["approval_id"]
        preview_digest = preview_payload["preview"]["preview_digest"]
        decision = self.gateway.decide_approval(
            self.invocation(self.human, f"approve-stage-{patch.patch_id}"),
            DecideApprovalRequest(
                self.project_id,
                self.revision,
                run_id,
                preview_payload["run"]["run_revision"],
                approval_id,
                True,
                "The semantic diff matches the requested circuit change",
            ),
        ).payload()
        return (
            preview_digest,
            decision["receipt"]["receipt_id"],
            decision["run"]["run_revision"],
        )

    def stage_patch(
        self,
        run_id: str,
        run_revision: int,
        patch: DesignPatch,
        preview_digest: str,
        receipt_id: str,
    ) -> tuple[str, int]:
        payload = self.gateway.stage_design_patch(
            self.invocation(self.designer, f"stage-{patch.patch_id}"),
            StageDesignPatchRequest(
                self.project_id,
                self.revision,
                run_id,
                run_revision,
                patch,
                preview_digest,
                receipt_id,
            ),
        ).payload()
        return payload["stage"]["staged_revision"], payload["run"]["run_revision"]


class ContractAndCapabilityTests(GatewayTestCase):
    def test_manifest_is_complete_deterministic_and_has_no_escape_hatches(self) -> None:
        manifest = tool_manifest()
        names = tuple(record.name for record in manifest)
        self.assertEqual(names, tuple(sorted(ToolName, key=lambda item: item.value)))
        self.assertEqual(set(names), set(ToolName))
        self.assertEqual(
            next(item for item in manifest if item.name is ToolName.INSPECT_PROJECT).required_tier,
            CapabilityTier.READ,
        )
        self.assertEqual(
            next(item for item in manifest if item.name is ToolName.STAGE_DESIGN_PATCH).required_tier,
            CapabilityTier.STAGE,
        )
        self.assertEqual(
            next(item for item in manifest if item.name is ToolName.COMMIT_TRANSACTION).required_tier,
            CapabilityTier.RELEASE,
        )
        serialized = canonical_json(manifest).lower()
        for forbidden in ("shell", "file_write", "raw_write", "command_line"):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(canonical_json(manifest), canonical_json(tool_manifest()))

    def test_capabilities_are_host_supplied_and_cannot_be_escalated_in_payload(self) -> None:
        inspect = self.gateway.inspect_project(
            self.invocation(self.observer, "inspect-1"),
            InspectProjectRequest(self.project_id),
        )
        self.assertEqual(inspect.payload()["snapshot"]["project_revision"], self.revision)
        with self.assertRaises(CapabilityDenied):
            self.gateway.create_agent_run(
                self.invocation(self.observer, "create-denied"),
                CreateAgentRunRequest(
                    self.project_id,
                    self.revision,
                    "Try to create a write-capable run",
                ),
            )

    def test_idempotent_replay_returns_identical_result_and_conflicts_on_reuse(self) -> None:
        invocation = self.invocation(self.designer, "create-idempotent")
        request = CreateAgentRunRequest(
            self.project_id,
            self.revision,
            "Create one run only",
        )
        first = self.gateway.create_agent_run(invocation, request)
        evidence_count = len(self.gateway.evidence_records())
        second = self.gateway.create_agent_run(invocation, request)
        self.assertIs(first, second)
        self.assertEqual(len(self.gateway.evidence_records()), evidence_count)
        with self.assertRaises(IdempotencyConflict):
            self.gateway.create_agent_run(
                invocation,
                CreateAgentRunRequest(
                    self.project_id,
                    self.revision,
                    "A different objective under the same retry key",
                ),
            )

    def test_parallel_idempotent_calls_apply_exactly_once(self) -> None:
        invocation = self.invocation(self.designer, "parallel-create")
        request = CreateAgentRunRequest(
            self.project_id,
            self.revision,
            "Create exactly one durable run under concurrent retries",
        )
        with ThreadPoolExecutor(max_workers=16) as pool:
            results = tuple(
                pool.map(
                    lambda _: self.gateway.create_agent_run(invocation, request),
                    range(64),
                )
            )
        self.assertTrue(all(result is results[0] for result in results))
        self.assertEqual(len(self.gateway.evidence_records()), 1)

    def test_canonical_contract_rejects_float_and_unsorted_parameters(self) -> None:
        with self.assertRaises(InvalidRequest):
            Parameter("x_nm", 1.5)
        with self.assertRaises(InvalidRequest):
            PatchOperation(
                "op-order",
                PatchAction.PLACE_COMPONENT,
                "U1",
                (Parameter("y_nm", 2), Parameter("x_nm", 1)),
            )


class StrictCoordinationWorkflowTests(GatewayTestCase):
    def test_stage_requires_human_receipt_for_the_exact_preview(self) -> None:
        run_id, run_revision = self.create_run()
        patch = self.good_patch()
        preview = self.gateway.preview_patch(
            self.invocation(self.designer, "preview-unapproved"),
            PreviewPatchRequest(
                self.project_id, self.revision, run_id, run_revision, patch
            ),
        ).payload()
        with self.assertRaises(ApprovalRequired):
            self.gateway.stage_design_patch(
                self.invocation(self.designer, "stage-unapproved"),
                StageDesignPatchRequest(
                    self.project_id,
                    self.revision,
                    run_id,
                    preview["run"]["run_revision"],
                    patch,
                    preview["preview"]["preview_digest"],
                    "receipt-missing",
                ),
            )

    def test_full_question_preview_stage_verify_release_and_export_workflow(self) -> None:
        question = QuestionSpec(
            "Which connector orientation is required?",
            "Orientation changes the enclosure fit",
            True,
            ("north", "south"),
        )
        run_id, run_revision = self.create_run((question,))
        run = self.gateway.get_run(run_id)
        question_id = run.question_ids[0]
        patch = self.good_patch()

        with self.assertRaises(CoordinationRequired):
            self.gateway.preview_patch(
                self.invocation(self.designer, "preview-too-soon"),
                PreviewPatchRequest(
                    self.project_id, self.revision, run_id, run_revision, patch
                ),
            )
        with self.assertRaises(CapabilityDenied):
            self.gateway.answer_question(
                self.invocation(self.designer, "agent-cannot-answer"),
                AnswerQuestionRequest(
                    self.project_id,
                    self.revision,
                    run_id,
                    run_revision,
                    question_id,
                    "north",
                ),
            )

        answer = self.gateway.answer_question(
            self.invocation(self.human, "answer-orientation"),
            AnswerQuestionRequest(
                self.project_id,
                self.revision,
                run_id,
                run_revision,
                question_id,
                "north",
            ),
        ).payload()
        self.assertEqual(answer["run"]["state"], RunState.PLANNING.value)
        run_revision = answer["run"]["run_revision"]

        preview_digest, stage_receipt_id, run_revision = self.preview_and_approve(
            run_id, run_revision, patch
        )
        staged_revision, run_revision = self.stage_patch(
            run_id,
            run_revision,
            patch,
            preview_digest,
            stage_receipt_id,
        )

        verification = self.gateway.run_verification(
            self.invocation(self.designer, "verify-1"),
            RunVerificationRequest(
                self.project_id,
                self.revision,
                staged_revision,
                run_id,
                run_revision,
            ),
        ).payload()
        self.assertTrue(verification["report"]["passed"])
        self.assertEqual(verification["report"]["findings"], [])
        report_digest = verification["report"]["report_digest"]
        release_approval_id = verification["approval"]["approval_id"]
        run_revision = verification["run"]["run_revision"]

        with self.assertRaises(ApprovalRequired):
            self.gateway.commit_transaction(
                self.invocation(self.human, "commit-without-approval"),
                CommitTransactionRequest(
                    self.project_id,
                    self.revision,
                    staged_revision,
                    run_id,
                    run_revision,
                    report_digest,
                    "receipt-does-not-exist",
                ),
            )

        decision = self.gateway.decide_approval(
            self.invocation(self.human, "approve-release-1"),
            DecideApprovalRequest(
                self.project_id,
                self.revision,
                run_id,
                run_revision,
                release_approval_id,
                True,
                "Verification passed and the exact board diff is accepted",
            ),
        ).payload()
        release_receipt_id = decision["receipt"]["receipt_id"]
        run_revision = decision["run"]["run_revision"]

        commit = self.gateway.commit_transaction(
            self.invocation(self.human, "commit-1"),
            CommitTransactionRequest(
                self.project_id,
                self.revision,
                staged_revision,
                run_id,
                run_revision,
                report_digest,
                release_receipt_id,
            ),
        ).payload()
        self.assertEqual(commit["committed_revision"], staged_revision)
        self.assertEqual(commit["run"]["state"], RunState.COMPLETE.value)

        export = self.gateway.export_project(
            self.invocation(self.human, "export-1"),
            ExportProjectRequest(
                self.project_id, staged_revision, ExportFormat.KICAD_ARCHIVE
            ),
        ).payload()["artifact"]
        self.assertEqual(export["project_revision"], staged_revision)
        self.assertNotIn("path", export)
        self.assertGreater(export["size_bytes"], 0)
        self.assertGreater(
            len(self.adapter.artifact_bytes(export["artifact_id"])), 0
        )

        with self.assertRaises(RevisionConflict):
            self.gateway.inspect_project(
                self.invocation(self.observer, "inspect-stale"),
                InspectProjectRequest(self.project_id, self.revision),
            )

    def test_exact_run_revision_and_digest_bound_stage_approval_are_enforced(self) -> None:
        run_id, run_revision = self.create_run()
        patch = self.good_patch()
        preview_digest, receipt_id, run_revision = self.preview_and_approve(
            run_id, run_revision, patch
        )
        with self.assertRaises(RevisionConflict):
            self.gateway.stage_design_patch(
                self.invocation(self.designer, "stage-wrong-preview"),
                StageDesignPatchRequest(
                    self.project_id,
                    self.revision,
                    run_id,
                    run_revision,
                    patch,
                    "0" * 64,
                    receipt_id,
                ),
            )
        with self.assertRaises(RevisionConflict):
            self.gateway.stage_design_patch(
                self.invocation(self.designer, "stage-stale-run"),
                StageDesignPatchRequest(
                    self.project_id,
                    self.revision,
                    run_id,
                    run_revision - 1,
                    patch,
                    preview_digest,
                    receipt_id,
                ),
            )

    def test_failed_deterministic_rules_never_request_release(self) -> None:
        bad_operation = PatchOperation(
            "op-bad",
            PatchAction.ADD_COMPONENT,
            "Ubad",
            (Parameter("manufacturer_part_number", "UNKNOWN"),),
        )
        patch = DesignPatch(
            "patch-bad",
            self.revision,
            "Exercise the component-grounding hard gate",
            (bad_operation,),
        )
        run_id, run_revision = self.create_run()
        preview_digest, receipt_id, run_revision = self.preview_and_approve(
            run_id, run_revision, patch
        )
        staged_revision, run_revision = self.stage_patch(
            run_id, run_revision, patch, preview_digest, receipt_id
        )
        result = self.gateway.run_verification(
            self.invocation(self.designer, "verify-bad"),
            RunVerificationRequest(
                self.project_id,
                self.revision,
                staged_revision,
                run_id,
                run_revision,
            ),
        ).payload()
        self.assertFalse(result["report"]["passed"])
        self.assertIsNone(result["approval"])
        self.assertEqual(result["run"]["state"], RunState.STAGED.value)
        self.assertEqual(
            result["report"]["findings"][0]["rule_id"], "component_grounding"
        )

    def test_rollback_discards_stage_without_changing_committed_revision(self) -> None:
        run_id, run_revision = self.create_run()
        patch = self.good_patch()
        preview_digest, receipt_id, run_revision = self.preview_and_approve(
            run_id, run_revision, patch
        )
        staged_revision, run_revision = self.stage_patch(
            run_id, run_revision, patch, preview_digest, receipt_id
        )
        rollback = self.gateway.rollback_transaction(
            self.invocation(self.designer, "rollback-1"),
            RollbackTransactionRequest(
                self.project_id,
                self.revision,
                staged_revision,
                run_id,
                run_revision,
                "User requested a different component placement",
            ),
        ).payload()
        self.assertEqual(rollback["current_project_revision"], self.revision)
        self.assertEqual(rollback["run"]["state"], RunState.ROLLED_BACK.value)
        snapshot = self.adapter.inspect_project(self.project_id, self.revision)
        self.assertIsNone(snapshot.active_staged_revision)


if __name__ == "__main__":
    unittest.main()

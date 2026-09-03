from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from backend.orchestrator import (
    Agent,
    AgentClass,
    AgentId,
    DeterministicScheduler,
    DomainError,
    Evidence,
    EvidenceId,
    EvidenceKind,
    ReviewedTaskResultBinding,
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
    task_result_digest,
)
from backend.product_configuration import (
    CoordinationConfiguration,
    ProductConfiguration,
    ProductConfigurationError,
    load_default_product_configuration,
    load_product_configuration,
)

NOW = datetime(2026, 8, 30, tzinfo=UTC)
LEASE_SIGNING_KEY = b"product-config-lease-signing-key-32"


class ProductRuntimeConfigurationTests(unittest.TestCase):
    def test_default_configuration_creates_bounded_critic_gated_run(self) -> None:
        configuration = load_default_product_configuration()
        run = configuration.create_run(
            run_id=RunId("run_product"),
            objective="Design a deterministic PCB",
            created_at=NOW,
        )

        self.assertEqual(run.max_concurrency, 8)
        self.assertTrue(run.strict_user_coordination)
        self.assertTrue(run.require_plan_approval)
        self.assertTrue(run.require_independent_critic)
        self.assertEqual(run.budget.token_limit, 1_000_000)
        self.assertEqual(run.budget.tool_call_limit, 500)
        self.assertEqual(run.budget.agent_dispatch_limit, 48)
        self.assertEqual(configuration.model_runtime.max_output_tokens, 32_768)

    def test_product_configuration_rejects_subclass_records_and_tampering(self) -> None:
        configuration = load_default_product_configuration()

        class ProductConfigurationSubclass(ProductConfiguration):
            pass

        with self.assertRaisesRegex(
            ProductConfigurationError,
            "exact ProductConfiguration type",
        ):
            ProductConfigurationSubclass(
                schema_version=configuration.schema_version,
                coordination=configuration.coordination,
                orchestration=configuration.orchestration,
                model_runtime=configuration.model_runtime,
                verification=configuration.verification,
                backends=configuration.backends,
            )

        class CoordinationConfigurationSubclass(CoordinationConfiguration):
            pass

        coordination = configuration.coordination
        subclass_coordination = CoordinationConfigurationSubclass(
            strict_user_coordination=coordination.strict_user_coordination,
            require_brief_approval=coordination.require_brief_approval,
            require_plan_approval=coordination.require_plan_approval,
            require_exact_patch_approval=coordination.require_exact_patch_approval,
            require_layout_constraint_approval=(
                coordination.require_layout_constraint_approval
            ),
            require_release_approval=coordination.require_release_approval,
            invalidate_dependent_approvals_on_change=(
                coordination.invalidate_dependent_approvals_on_change
            ),
        )
        with self.assertRaisesRegex(
            ProductConfigurationError,
            "coordination must use its exact concrete configuration record",
        ):
            replace(configuration, coordination=subclass_coordination)

        object.__setattr__(
            configuration.coordination,
            "strict_user_coordination",
            False,
        )
        with self.assertRaisesRegex(ProductConfigurationError, "safe product profile"):
            configuration.create_run(
                run_id=RunId("run_tampered_configuration"),
                objective="Reject unsafe post-construction policy changes",
                created_at=NOW,
            )

        mutable_roles = load_default_product_configuration()
        object.__setattr__(
            mutable_roles.backends.kicad,
            "role",
            list(mutable_roles.backends.kicad.role),
        )
        with self.assertRaisesRegex(ProductConfigurationError, "immutable role tuple"):
            mutable_roles.create_run(
                run_id=RunId("run_mutable_backend_roles"),
                objective="Reject mutable authority-bearing configuration fields",
                created_at=NOW,
            )

    def test_product_configuration_revalidates_exact_integer_fields(self) -> None:
        configuration = load_default_product_configuration()
        object.__setattr__(
            configuration.orchestration,
            "max_concurrent_agents",
            True,
        )

        with self.assertRaisesRegex(
            ProductConfigurationError,
            "max_concurrent_agents must be an integer",
        ):
            configuration.create_run(
                run_id=RunId("run_boolean_concurrency"),
                objective="Reject boolean concurrency",
                created_at=NOW,
            )

    def test_loader_rejects_duplicate_unknown_and_unsafe_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            duplicate = Path(directory) / "duplicate.json"
            duplicate.write_text(
                '{"schema_version":1,"schema_version":1}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                ProductConfigurationError, "duplicate configuration key"
            ):
                load_product_configuration(duplicate)

            source = cast(
                dict[str, Any],
                json.loads(Path("config/product.json").read_text(encoding="utf-8")),
            )
            coordination = cast(dict[str, Any], source["coordination"])
            coordination["strict_user_coordination"] = False
            unsafe = Path(directory) / "unsafe.json"
            unsafe.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(
                ProductConfigurationError, "safe product profile"
            ):
                load_product_configuration(unsafe)

            coordination["strict_user_coordination"] = True
            orchestration = cast(dict[str, Any], source["orchestration"])
            orchestration["surprise"] = 1
            unknown = Path(directory) / "unknown.json"
            unknown.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(ProductConfigurationError, "unknown: surprise"):
                load_product_configuration(unknown)

            del orchestration["surprise"]
            orchestration["max_concurrent_agents"] = 1
            orchestration["wave_size"] = 1
            wrong_capacity = Path(directory) / "wrong-capacity.json"
            wrong_capacity.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(ProductConfigurationError, "finite public campaign"):
                load_product_configuration(wrong_capacity)

            orchestration["max_concurrent_agents"] = 8
            orchestration["wave_size"] = 8
            orchestration["token_limit"] = None
            limited = Path(directory) / "limited.json"
            limited.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(ProductConfigurationError, "finite public campaign"):
                load_product_configuration(limited)

            orchestration["token_limit"] = 1_000_000
            verification = cast(dict[str, Any], source["verification"])
            verification["commit_blocks_at"] = "fatal"
            weak_gate = Path(directory) / "weak-gate.json"
            weak_gate.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(ProductConfigurationError, "gate thresholds"):
                load_product_configuration(weak_gate)

    def test_loader_rejects_boolean_integer_confusion(self) -> None:
        cases = (
            (("schema_version",), True, "schema_version must be an integer"),
            (
                ("orchestration", "max_concurrent_agents"),
                True,
                "max_concurrent_agents must be an integer",
            ),
            (
                ("orchestration", "max_repair_cycles_per_candidate"),
                False,
                "max_repair_cycles_per_candidate must be an integer",
            ),
            (
                ("orchestration", "require_independent_critic"),
                1,
                "require_independent_critic must be a boolean",
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            for index, (path, value, message) in enumerate(cases):
                with self.subTest(path=path, value=value):
                    source = cast(
                        dict[str, Any],
                        json.loads(
                            Path("config/product.json").read_text(encoding="utf-8")
                        ),
                    )
                    target = source
                    for key in path[:-1]:
                        target = cast(dict[str, Any], target[key])
                    target[path[-1]] = value
                    candidate = Path(directory) / f"bool-int-{index}.json"
                    candidate.write_text(json.dumps(source), encoding="utf-8")
                    with self.assertRaisesRegex(ProductConfigurationError, message):
                        load_product_configuration(candidate)

    def test_unbounded_example_requires_json_opt_in_and_loader_gate(self) -> None:
        profile = Path("config/product.unbounded.example.json")

        with self.assertRaisesRegex(
            ProductConfigurationError,
            "requires explicit loader authorization",
        ):
            load_product_configuration(profile)

        configuration = load_product_configuration(
            profile,
            allow_unsafe_resource_override=True,
        )
        self.assertTrue(
            configuration.orchestration.unsafe_resource_override_opt_in
        )
        run = configuration.create_run(
            run_id=RunId("run_explicit_unbounded_profile"),
            objective="Use an explicitly authorized private campaign profile",
            created_at=NOW,
        )
        self.assertEqual(100, run.max_concurrency)
        self.assertIsNone(run.budget.token_limit)
        self.assertIsNone(run.budget.tool_call_limit)
        self.assertIsNone(run.budget.agent_dispatch_limit)
        self.assertIsNone(configuration.model_runtime.max_output_tokens)

        with patch.dict(
            "os.environ",
            {"EVLEDA_ALLOW_UNSAFE_RESOURCE_OVERRIDE": "1"},
            clear=False,
        ):
            from_environment = load_product_configuration(profile)
        self.assertEqual(
            configuration.orchestration,
            from_environment.orchestration,
        )

    def test_unbounded_profile_cannot_keep_authorization_after_tampering(self) -> None:
        configuration = load_product_configuration(
            Path("config/product.unbounded.example.json"),
            allow_unsafe_resource_override=True,
        )
        object.__setattr__(
            configuration,
            "_unsafe_resource_override_authorized",
            False,
        )
        with self.assertRaisesRegex(
            ProductConfigurationError,
            "requires explicit loader authorization",
        ):
            configuration.create_run(
                run_id=RunId("run_unbounded_tampered_authorization"),
                objective="Reject unauthorized resource profile activation",
                created_at=NOW,
            )

    def test_schema_v1_profile_without_new_opt_in_is_a_deliberate_migration_error(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = cast(
                dict[str, Any],
                json.loads(Path("config/product.json").read_text(encoding="utf-8")),
            )
            orchestration = cast(dict[str, Any], source["orchestration"])
            del orchestration["unsafe_resource_override_opt_in"]
            legacy = Path(directory) / "legacy-product-v1.json"
            legacy.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(
                ProductConfigurationError,
                "missing: unsafe_resource_override_opt_in",
            ):
                load_product_configuration(legacy)

    def test_product_run_requires_distinct_critic_review_before_completion(self) -> None:
        configuration = load_default_product_configuration()
        run = replace(
            configuration.create_run(
                run_id=RunId("run_critic_gate"),
                objective="Route the board",
                created_at=NOW,
            ),
            phase=RunPhase.VERIFYING,
            require_plan_approval=False,
        )
        design = Task(
            id=TaskId("task_design"),
            run_id=run.id,
            title="Route board",
            instructions="Apply deterministic routing commands",
            kind=TaskKind.DESIGN,
            created_seq=1,
            state=TaskState.SUCCEEDED,
            result_evidence_ids=(EvidenceId("evidence_design"),),
            completed_by_agent_id=AgentId("agent_designer"),
        )
        design_evidence = Evidence.capture(
            evidence_id=EvidenceId("evidence_design"),
            run_id=run.id,
            kind=EvidenceKind.ARTIFACT,
            source="design-worker",
            content="exact design result",
            summary="Design result",
            captured_at=NOW,
            task_id=design.id,
        )
        same_worker_review = Task(
            id=TaskId("task_review"),
            run_id=run.id,
            title="Review routing",
            instructions="Critique the exact routed revision",
            kind=TaskKind.REVIEW,
            created_seq=2,
            dependencies=(design.id,),
            required_agent_class=AgentClass.CRITIC,
            reviewed_task_ids=(design.id,),
            reviewed_result_bindings=(
                ReviewedTaskResultBinding(
                    task_id=design.id,
                    result_digest=task_result_digest(design, (design_evidence,)),
                ),
            ),
            state=TaskState.SUCCEEDED,
            result_evidence_ids=(EvidenceId("evidence_review"),),
            completed_by_agent_id=AgentId("agent_designer"),
        )
        run = replace(
            run,
            task_inventory_digest=task_inventory_digest(
                run.id,
                (design, same_worker_review),
            ),
        )
        designer = Agent(
            id=AgentId("agent_designer"),
            run_id=run.id,
            name="Designer",
            created_seq=1,
            agent_class=AgentClass.DOMAIN_DESIGNER,
        )
        review_evidence = Evidence.capture(
            evidence_id=EvidenceId("evidence_review"),
            run_id=run.id,
            kind=EvidenceKind.ARTIFACT,
            source="critic-worker",
            content="reviewed exact task inventory",
            summary="Independent critic review",
            captured_at=NOW,
            task_id=same_worker_review.id,
        )
        with self.assertRaisesRegex(TransitionRejected, "independent critic"):
            RunStateMachine.transition(
                run,
                RunPhase.COMPLETED,
                at=NOW,
                context=TransitionContext(
                    tasks=(design, same_worker_review),
                    agents=(designer,),
                    evidence=(design_evidence, review_evidence),
                    verification_passed=True,
                ),
            )
        with self.assertRaisesRegex(TransitionRejected, "sealed task inventory"):
            RunStateMachine.transition(
                run,
                RunPhase.COMPLETED,
                at=NOW,
                context=TransitionContext(
                    tasks=(design,),
                    agents=(designer,),
                    evidence=(design_evidence,),
                    verification_passed=True,
                ),
            )

        independent = replace(
            same_worker_review,
            completed_by_agent_id=AgentId("agent_critic"),
        )
        critic = Agent(
            id=AgentId("agent_critic"),
            run_id=run.id,
            name="Critic",
            created_seq=2,
            agent_class=AgentClass.CRITIC,
        )
        completed = RunStateMachine.transition(
            run,
            RunPhase.COMPLETED,
            at=NOW,
            context=TransitionContext(
                tasks=(design, independent),
                agents=(designer, critic),
                evidence=(design_evidence, review_evidence),
                verification_passed=True,
            ),
        )
        self.assertEqual(completed.phase, RunPhase.COMPLETED)

        replacement_evidence = Evidence.capture(
            evidence_id=EvidenceId("evidence_design_replacement"),
            run_id=run.id,
            kind=EvidenceKind.ARTIFACT,
            source="design-worker",
            content="different design result",
            summary="Replacement design result",
            captured_at=NOW,
            task_id=design.id,
        )
        replaced_result = replace(
            design,
            result_evidence_ids=(replacement_evidence.id,),
        )
        self.assertEqual(
            run.task_inventory_digest,
            task_inventory_digest(run.id, (replaced_result, independent)),
        )
        with self.assertRaisesRegex(TransitionRejected, "independent critic"):
            RunStateMachine.transition(
                run,
                RunPhase.COMPLETED,
                at=NOW,
                context=TransitionContext(
                    tasks=(replaced_result, independent),
                    agents=(designer, critic),
                    evidence=(replacement_evidence, review_evidence),
                    verification_passed=True,
                ),
            )

        with self.assertRaisesRegex(DomainError, "exact boolean"):
            TransitionContext(verification_passed=cast(bool, "truthy"))

    def test_scheduler_excludes_completer_from_review_lease(self) -> None:
        configuration = load_default_product_configuration()
        run = replace(
            configuration.create_run(
                run_id=RunId("run_review_schedule"),
                objective="Review the board",
                created_at=NOW,
            ),
            phase=RunPhase.EXECUTING,
            require_plan_approval=False,
        )
        design = Task(
            id=TaskId("task_done"),
            run_id=run.id,
            title="Design",
            instructions="Design",
            kind=TaskKind.DESIGN,
            created_seq=1,
            state=TaskState.SUCCEEDED,
            result_evidence_ids=(EvidenceId("evidence_done"),),
            completed_by_agent_id=AgentId("agent_one"),
        )
        second_design = replace(
            design,
            id=TaskId("task_done_two"),
            title="Second design operation",
            created_seq=2,
            result_evidence_ids=(EvidenceId("evidence_done_two"),),
        )
        first_result = Evidence.capture(
            evidence_id=EvidenceId("evidence_done"),
            run_id=run.id,
            kind=EvidenceKind.ARTIFACT,
            source="design-worker",
            content="first result",
            summary="First result",
            captured_at=NOW,
            task_id=design.id,
        )
        second_result = Evidence.capture(
            evidence_id=EvidenceId("evidence_done_two"),
            run_id=run.id,
            kind=EvidenceKind.ARTIFACT,
            source="design-worker",
            content="second result",
            summary="Second result",
            captured_at=NOW,
            task_id=second_design.id,
        )
        review = Task(
            id=TaskId("task_critic"),
            run_id=run.id,
            title="Independent review",
            instructions="Review exact evidence",
            kind=TaskKind.REVIEW,
            created_seq=3,
            dependencies=(design.id, second_design.id),
            required_agent_class=AgentClass.CRITIC,
            reviewed_task_ids=(design.id, second_design.id),
            reviewed_result_bindings=(
                ReviewedTaskResultBinding(
                    task_id=design.id,
                    result_digest=task_result_digest(design, (first_result,)),
                ),
                ReviewedTaskResultBinding(
                    task_id=second_design.id,
                    result_digest=task_result_digest(
                        second_design,
                        (second_result,),
                    ),
                ),
            ),
        )
        original_worker = Agent(
            id=AgentId("agent_one"),
            run_id=run.id,
            name="Original worker",
            created_seq=1,
            agent_class=AgentClass.CRITIC,
        )
        independent_critic = Agent(
            id=AgentId("agent_two"),
            run_id=run.id,
            name="Independent critic",
            created_seq=2,
            agent_class=AgentClass.CRITIC,
        )

        scheduled = DeterministicScheduler.schedule(
            run,
            (design, second_design, review),
            (original_worker, independent_critic),
            at=NOW,
            lease_signing_key=LEASE_SIGNING_KEY,
        )
        self.assertEqual(len(scheduled.dispatches), 1)
        self.assertEqual(scheduled.dispatches[0].agent_id, independent_critic.id)


if __name__ == "__main__":
    unittest.main()

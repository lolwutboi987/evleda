from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

from backend.orchestrator import (
    Agent,
    AgentId,
    Approval,
    ApprovalId,
    ApprovalKind,
    Budget,
    ConcurrencyConflict,
    DeterministicScheduler,
    DomainError,
    EventChainError,
    EventId,
    EventType,
    Evidence,
    EvidenceId,
    EvidenceKind,
    OrchestrationEvent,
    Question,
    QuestionId,
    RetryPolicy,
    Run,
    RunId,
    RunPhase,
    SnapshotIntegrityError,
    SQLiteOrchestratorStore,
    StoreError,
    Task,
    TaskId,
    TaskKind,
    TaskState,
    task_inventory_digest,
)

NOW = datetime(2026, 8, 29, 22, 0, tzinfo=timezone.utc)


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.store = SQLiteOrchestratorStore(
            Path(self.directory.name) / "orchestrator.sqlite3"
        )
        self.run = Run(
            id=RunId("run_store"),
            objective="Persist every decision",
            created_at=NOW,
            require_plan_approval=False,
        )
        self.store.save_run(self.run, expected_revision=None)

    def tearDown(self) -> None:
        self.store.close()
        self.directory.cleanup()

    def test_atomic_typed_snapshot_and_event_chain_round_trip(self) -> None:
        updated = replace(self.run, phase=RunPhase.CLARIFYING, revision=1)
        task = Task(
            id=TaskId("task_store"),
            run_id=self.run.id,
            title="Inspect constraints",
            instructions="Read design requirements",
            kind=TaskKind.RESEARCH,
            created_seq=1,
        )
        agent = Agent(
            id=AgentId("agent_store"),
            run_id=self.run.id,
            name="Researcher",
            created_seq=1,
            capabilities=("research",),
        )
        question = Question(
            id=QuestionId("question_store"),
            run_id=self.run.id,
            prompt="Which connector?",
            rationale="Footprint is ambiguous",
            asked_at=NOW,
            options=("Connector A", "Connector B"),
            recommendation="Connector A",
            confidence_basis_points=7_500,
            bound_revision="sha256:brief-draft-1",
        )
        approval = Approval(
            id=ApprovalId("approval_store"),
            run_id=self.run.id,
            kind=ApprovalKind.PLAN,
            subject_digest="plan-digest",
            summary="Initial plan",
            requested_at=NOW,
        )
        evidence = Evidence.capture(
            evidence_id=EvidenceId("evidence_store"),
            run_id=self.run.id,
            task_id=task.id,
            kind=EvidenceKind.USER_RESPONSE,
            source="user:owner",
            content="Connector A",
            summary="Connector decision",
            captured_at=NOW,
            metadata={"channel": "coordination"},
        )
        event1 = OrchestrationEvent.create(
            event_id=EventId("event_1"),
            run_id=self.run.id,
            sequence=1,
            type=EventType.QUESTION_OPENED,
            actor="orchestrator",
            occurred_at=NOW,
            aggregate_id=str(question.id),
            payload={"blocking": True},
            evidence_ids=(evidence.id,),
        )
        self.store.commit_snapshot(
            updated,
            expected_revision=0,
            tasks=(task,),
            agents=(agent,),
            questions=(question,),
            approvals=(approval,),
            evidence=(evidence,),
            events=(event1,),
        )

        self.assertEqual(self.store.get_run(self.run.id), updated)
        self.assertEqual(self.store.list_tasks(self.run.id), (task,))
        self.assertEqual(self.store.list_agents(self.run.id), (agent,))
        self.assertEqual(self.store.list_questions(self.run.id), (question,))
        self.assertEqual(self.store.list_approvals(self.run.id), (approval,))
        self.assertEqual(self.store.list_evidence(self.run.id), (evidence,))
        self.assertEqual(self.store.list_events(self.run.id), (event1,))

        event2 = OrchestrationEvent.create(
            event_id=EventId("event_2"),
            run_id=self.run.id,
            sequence=2,
            type=EventType.QUESTION_ANSWERED,
            actor="user:owner",
            occurred_at=NOW,
            aggregate_id=str(question.id),
            payload={"answer_digest": "abc"},
            previous_hash=event1.event_hash,
        )
        self.store.append_event(event2)
        self.assertEqual(self.store.list_events(self.run.id), (event1, event2))

    def test_signed_lease_contract_digests_survive_snapshot_round_trip(self) -> None:
        executing = replace(
            self.run,
            phase=RunPhase.EXECUTING,
            require_plan_approval=False,
            revision=1,
        )
        task = Task(
            id=TaskId("task_signed_lease"),
            run_id=self.run.id,
            title="Verify exact board",
            instructions="Run the pinned deterministic checker",
            kind=TaskKind.VERIFY,
            created_seq=1,
            required_capabilities=("verification",),
        )
        agent = Agent(
            id=AgentId("agent_signed_lease"),
            run_id=self.run.id,
            name="Pinned verification worker",
            created_seq=1,
            capabilities=("verification",),
        )
        scheduled = DeterministicScheduler.schedule(
            executing,
            (task,),
            (agent,),
            at=NOW,
            lease_signing_key=b"orchestrator-store-test-lease-key-32-bytes-minimum",
        )
        executing = replace(executing, budget=scheduled.budget)
        self.store.commit_snapshot(
            executing,
            expected_revision=0,
            tasks=scheduled.tasks,
            agents=scheduled.agents,
        )

        restored_task = self.store.list_tasks(self.run.id)[0]
        restored_agent = self.store.list_agents(self.run.id)[0]
        self.assertEqual(scheduled.tasks[0], restored_task)
        self.assertEqual(scheduled.agents[0], restored_agent)
        assert restored_task.lease is not None
        self.assertEqual(64, len(restored_task.lease.task_contract_digest))
        self.assertEqual(64, len(restored_task.lease.agent_contract_digest))

    def test_optimistic_revision_conflict(self) -> None:
        updated = replace(self.run, phase=RunPhase.CLARIFYING, revision=1)
        self.store.save_run(updated, expected_revision=0)
        stale = replace(self.run, phase=RunPhase.READY, revision=1)
        with self.assertRaises(ConcurrencyConflict):
            self.store.save_run(stale, expected_revision=0)
        self.assertEqual(self.store.get_run(self.run.id), updated)

    def test_failed_snapshot_rolls_back_all_nested_writes(self) -> None:
        updated = replace(self.run, phase=RunPhase.CLARIFYING, revision=1)
        invalid_event = OrchestrationEvent.create(
            event_id=EventId("event_gap"),
            run_id=self.run.id,
            sequence=2,
            type=EventType.RUN_PHASE_CHANGED,
            actor="orchestrator",
            occurred_at=NOW,
            aggregate_id=str(self.run.id),
            payload={"phase": "clarifying"},
        )
        with self.assertRaises(EventChainError):
            self.store.commit_snapshot(
                updated,
                expected_revision=0,
                events=(invalid_event,),
            )
        self.assertEqual(self.store.get_run(self.run.id), self.run)
        self.assertEqual(self.store.list_events(self.run.id), ())

    def test_rejects_wrong_previous_hash_and_detects_body_tampering(self) -> None:
        event1 = OrchestrationEvent.create(
            event_id=EventId("event_root"),
            run_id=self.run.id,
            sequence=1,
            type=EventType.RUN_CREATED,
            actor="orchestrator",
            occurred_at=NOW,
            aggregate_id=str(self.run.id),
        )
        self.store.append_event(event1)
        wrong = OrchestrationEvent.create(
            event_id=EventId("event_wrong"),
            run_id=self.run.id,
            sequence=2,
            type=EventType.RUN_PHASE_CHANGED,
            actor="orchestrator",
            occurred_at=NOW,
            aggregate_id=str(self.run.id),
            previous_hash="0" * 64,
        )
        with self.assertRaisesRegex(EventChainError, "previous_hash"):
            self.store.append_event(wrong)

        row = self.store._connection.execute(
            "SELECT body FROM events WHERE id = ?", (str(event1.id),)
        ).fetchone()
        body = json.loads(row["body"])
        body["actor"] = "intruder"
        self.store._connection.execute(
            "UPDATE events SET body = ? WHERE id = ?",
            (json.dumps(body, sort_keys=True, separators=(",", ":")), str(event1.id)),
        )
        with self.assertRaises(EventChainError):
            self.store.list_events(self.run.id)

    def test_event_constructor_rejects_non_exact_scalar_types(self) -> None:
        class StringSubclass(str):
            pass

        invalid_fields = (
            ("boolean sequence", {"sequence": True}, "sequence.*exact integer"),
            ("integer actor", {"actor": cast(Any, 7)}, "actor.*exact string"),
            (
                "string-subclass actor",
                {"actor": StringSubclass("orchestrator")},
                "actor.*exact string",
            ),
            (
                "string evidence sequence",
                {"evidence_ids": cast(Any, "evidence_1")},
                "evidence IDs.*exact",
            ),
            (
                "string event type",
                {"type": cast(Any, EventType.RUN_CREATED.value)},
                "event type.*exact",
            ),
            (
                "non-finite payload value",
                {"payload": {"not_finite": float("nan")}},
                "canonical JSON values",
            ),
        )
        for label, overrides, expected in invalid_fields:
            with self.subTest(label=label):
                arguments: dict[str, Any] = {
                    "event_id": EventId("event_invalid"),
                    "run_id": self.run.id,
                    "sequence": 1,
                    "type": EventType.RUN_CREATED,
                    "actor": "orchestrator",
                    "occurred_at": NOW,
                    "aggregate_id": str(self.run.id),
                }
                arguments.update(overrides)
                with self.assertRaisesRegex(DomainError, expected):
                    OrchestrationEvent.create(**arguments)

        class EventSubclass(OrchestrationEvent):
            def __post_init__(self) -> None:
                pass

            def validate_hash(self) -> bool:
                return True

        with self.assertRaisesRegex(DomainError, "exact OrchestrationEvent type"):
            EventSubclass.create(
                event_id=EventId("event_subclass"),
                run_id=self.run.id,
                sequence=1,
                type=EventType.RUN_CREATED,
                actor="orchestrator",
                occurred_at=NOW,
                aggregate_id=str(self.run.id),
            )

    def test_event_restore_rejects_bool_int_body_index_aliases(self) -> None:
        event = OrchestrationEvent.create(
            event_id=EventId("event_exact_types"),
            run_id=self.run.id,
            sequence=1,
            type=EventType.RUN_CREATED,
            actor="orchestrator",
            occurred_at=NOW,
            aggregate_id=str(self.run.id),
        )
        self.store.append_event(event)
        row = self.store._connection.execute(
            "SELECT body FROM events WHERE id = ?", (str(event.id),)
        ).fetchone()
        original_body = row["body"]

        def event_hash(body: dict[str, Any]) -> str:
            material = {
                "id": body["id"],
                "run_id": body["run_id"],
                "sequence": body["sequence"],
                "type": body["type"],
                "actor": body["actor"],
                "occurred_at": body["occurred_at"],
                "aggregate_id": body["aggregate_id"],
                "payload_json": body["payload_json"],
                "evidence_ids": body["evidence_ids"],
                "previous_hash": body["previous_hash"],
            }
            canonical = json.dumps(
                material,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
            return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

        mutations = (
            ("boolean sequence aliases indexed integer", "sequence", True),
            ("integer actor remains canonically hashable", "actor", 7),
        )
        for label, field, value in mutations:
            with self.subTest(label=label):
                body = json.loads(original_body)
                body[field] = value
                body["event_hash"] = event_hash(body)
                changed = json.dumps(body, sort_keys=True, separators=(",", ":"))
                self.store._connection.execute(
                    "UPDATE events SET body = ?, event_hash = ? WHERE id = ?",
                    (changed, body["event_hash"], str(event.id)),
                )
                with self.assertRaisesRegex(EventChainError, "malformed.*modified"):
                    self.store.list_events(self.run.id)
                self.store._connection.execute(
                    "UPDATE events SET body = ?, event_hash = ? WHERE id = ?",
                    (original_body, event.event_hash, str(event.id)),
                )

    def test_snapshot_restore_rejects_defaults_types_and_index_body_mismatch(self) -> None:
        row = self.store._connection.execute(
            "SELECT body FROM runs WHERE id = ?", (str(self.run.id),)
        ).fetchone()
        original = row["body"]
        mutations = (
            ("missing budget fields", lambda body: body.__setitem__("budget", {})),
            (
                "integer coordination gate",
                lambda body: body.__setitem__("strict_user_coordination", 0),
            ),
            ("body ID mismatch", lambda body: body.__setitem__("id", "run_other")),
            ("phase index mismatch", lambda body: body.__setitem__("phase", "completed")),
        )
        for label, mutate in mutations:
            with self.subTest(label=label):
                body = json.loads(original)
                mutate(body)
                changed = json.dumps(body, sort_keys=True, separators=(",", ":"))
                self.store._connection.execute(
                    "UPDATE runs SET body = ? WHERE id = ?",
                    (changed, str(self.run.id)),
                )
                with self.assertRaises(SnapshotIntegrityError):
                    self.store.get_run(self.run.id)
                self.store._connection.execute(
                    "UPDATE runs SET body = ? WHERE id = ?",
                    (original, str(self.run.id)),
                )

    def test_budget_and_run_security_fields_require_exact_scalar_types(self) -> None:
        with self.assertRaisesRegex(DomainError, "exact integers"):
            Budget(token_limit=True)
        with self.assertRaisesRegex(DomainError, "exact boolean"):
            replace(self.run, require_independent_critic=0)
        with self.assertRaisesRegex(DomainError, "exact integers"):
            replace(self.run, max_concurrency=True)
        with self.assertRaisesRegex(DomainError, "reservations must be exact integers"):
            Budget.unlimited().reserve(tokens=True)
        with self.assertRaisesRegex(
            DomainError, "settlement quantities must be exact integers"
        ):
            Budget.unlimited().settle(actual_tokens=True)
        with self.assertRaisesRegex(DomainError, "failed_attempt"):
            RetryPolicy().delay_seconds(True)

    def test_store_rejects_run_subclasses_and_bool_revision_aliases(self) -> None:
        class RunSubclass(Run):
            def __post_init__(self) -> None:
                pass

        forged = RunSubclass(
            id=self.run.id,
            objective=self.run.objective,
            created_at=self.run.created_at,
            phase=RunPhase.CLARIFYING,
            revision=1,
            require_plan_approval=False,
        )
        with self.assertRaisesRegex(StoreError, "exact Run"):
            self.store.save_run(forged, expected_revision=0)
        with self.assertRaisesRegex(StoreError, "exact integer"):
            self.store.save_run(
                replace(self.run, phase=RunPhase.CLARIFYING, revision=1),
                expected_revision=True,
            )

    def test_snapshot_requires_exact_tuples_and_records(self) -> None:
        updated = replace(self.run, phase=RunPhase.CLARIFYING, revision=1)
        with self.assertRaisesRegex(StoreError, "exact tuple"):
            self.store.commit_snapshot(
                updated,
                expected_revision=0,
                tasks=cast(Any, []),
            )

    def test_sealed_task_inventory_allows_lifecycle_only_updates(self) -> None:
        first = Task(
            id=TaskId("task_first"),
            run_id=self.run.id,
            title="First task",
            instructions="Complete the first exact task",
            kind=TaskKind.RESEARCH,
            created_seq=1,
        )
        self.store.put_task(first)
        sealed = replace(
            self.run,
            task_inventory_digest=task_inventory_digest(self.run.id, (first,)),
            revision=1,
        )
        self.store.save_run(sealed, expected_revision=0)

        self.store.put_task(replace(first, state=TaskState.SUCCEEDED))
        added = replace(
            first,
            id=TaskId("task_added_after_seal"),
            created_seq=2,
        )
        with self.assertRaisesRegex(StoreError, "sealed task inventory"):
            self.store.put_task(added)
        with self.assertRaisesRegex(StoreError, "inventory digest is immutable"):
            self.store.save_run(
                replace(
                    sealed,
                    task_inventory_digest=task_inventory_digest(
                        self.run.id,
                        (first, added),
                    ),
                    revision=2,
                ),
                expected_revision=1,
            )


if __name__ == "__main__":
    unittest.main()

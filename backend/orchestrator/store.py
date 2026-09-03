"""SQLite persistence for orchestration state and its tamper-evident event log."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import fields, is_dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from threading import RLock
from typing import Any, Callable, Iterator, Sequence, TypeVar, cast

from .models import (
    Agent,
    AgentClass,
    AgentId,
    AgentState,
    Approval,
    ApprovalId,
    ApprovalKind,
    ApprovalState,
    Budget,
    CheckRequirement,
    CoordinationStage,
    DomainError,
    EventId,
    EventType,
    Evidence,
    EvidenceId,
    EvidenceKind,
    Lease,
    OrchestrationEvent,
    Question,
    QuestionId,
    QuestionState,
    RetryPolicy,
    ReviewedTaskResultBinding,
    RiskClass,
    Run,
    RunId,
    RunPhase,
    Task,
    TaskId,
    TaskKind,
    TaskState,
    canonical_json,
    task_inventory_digest,
)


class StoreError(RuntimeError):
    """Base persistence error."""


class NotFound(StoreError):
    """A requested orchestration record does not exist."""


class ConcurrencyConflict(StoreError):
    """Optimistic run revision does not match durable state."""


class EventChainError(StoreError):
    """An event append or replay failed hash-chain validation."""


class SnapshotIntegrityError(StoreError):
    """A durable snapshot body is malformed or disagrees with its index."""


T = TypeVar("T")


def _primitive(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if is_dataclass(value):
        return {item.name: _primitive(getattr(value, item.name)) for item in fields(value)}
    if isinstance(value, tuple):
        return [_primitive(item) for item in value]
    if isinstance(value, list):
        return [_primitive(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _primitive(item) for key, item in value.items()}
    return value


def _body(value: Any) -> str:
    return canonical_json(_primitive(value))


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise SnapshotIntegrityError(f"duplicate snapshot key {key!r}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> object:
    raise SnapshotIntegrityError(f"non-finite snapshot constant {value!r}")


def _decode_record(raw: str, decoder: Callable[[dict[str, Any]], T], label: str) -> T:
    try:
        value = json.loads(
            raw,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
        if type(value) is not dict:
            raise SnapshotIntegrityError(f"{label} body must be an object")
        record = decoder(cast(dict[str, Any], value))
        if _body(record) != raw:
            raise SnapshotIntegrityError(f"{label} body is not the exact canonical record")
        return record
    except SnapshotIntegrityError:
        raise
    except (
        DomainError,
        json.JSONDecodeError,
        KeyError,
        TypeError,
        ValueError,
    ) as exc:
        raise SnapshotIntegrityError(f"{label} body is malformed") from exc


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value is not None else None


def _lease(value: dict[str, Any] | None) -> Lease | None:
    if value is None:
        return None
    return Lease(
        token=value["token"],
        task_id=TaskId(value["task_id"]),
        agent_id=AgentId(value["agent_id"]),
        attempt=value["attempt"],
        acquired_at=datetime.fromisoformat(value["acquired_at"]),
        expires_at=datetime.fromisoformat(value["expires_at"]),
        task_contract_digest=value["task_contract_digest"],
        agent_contract_digest=value["agent_contract_digest"],
    )


def _run(value: dict[str, Any]) -> Run:
    return Run(
        id=RunId(value["id"]),
        objective=value["objective"],
        created_at=datetime.fromisoformat(value["created_at"]),
        phase=RunPhase(value["phase"]),
        coordination_stage=CoordinationStage(value["coordination_stage"]),
        checkpoint_digest=value["checkpoint_digest"],
        coordination_revision=value["coordination_revision"],
        strict_user_coordination=value["strict_user_coordination"],
        require_plan_approval=value["require_plan_approval"],
        require_independent_critic=value["require_independent_critic"],
        task_inventory_digest=value["task_inventory_digest"],
        plan_digest=value["plan_digest"],
        max_concurrency=value["max_concurrency"],
        budget=Budget(**value["budget"]),
        revision=value["revision"],
    )


def _task(value: dict[str, Any]) -> Task:
    return Task(
        id=TaskId(value["id"]),
        run_id=RunId(value["run_id"]),
        title=value["title"],
        instructions=value["instructions"],
        kind=TaskKind(value["kind"]),
        created_seq=value["created_seq"],
        priority=value["priority"],
        wave=value["wave"],
        dependencies=tuple(TaskId(item) for item in value["dependencies"]),
        required_capabilities=tuple(value["required_capabilities"]),
        required_agent_class=(
            AgentClass(value["required_agent_class"])
            if value["required_agent_class"] is not None
            else None
        ),
        excluded_agent_ids=tuple(AgentId(item) for item in value["excluded_agent_ids"]),
        risk_class=RiskClass(value["risk_class"]),
        input_revision=value["input_revision"],
        output_schema_digest=value["output_schema_digest"],
        idempotency_key=value["idempotency_key"],
        required_checks=tuple(
            CheckRequirement(**requirement) for requirement in value["required_checks"]
        ),
        reviewed_task_ids=tuple(TaskId(item) for item in value["reviewed_task_ids"]),
        reviewed_result_bindings=tuple(
            ReviewedTaskResultBinding(
                task_id=TaskId(binding["task_id"]),
                result_digest=binding["result_digest"],
            )
            for binding in value["reviewed_result_bindings"]
        ),
        estimated_tokens=value["estimated_tokens"],
        retry_policy=RetryPolicy(**value["retry_policy"]),
        state=TaskState(value["state"]),
        attempt=value["attempt"],
        next_eligible_at=_dt(value["next_eligible_at"]),
        lease=_lease(value["lease"]),
        result_evidence_ids=tuple(
            EvidenceId(item) for item in value["result_evidence_ids"]
        ),
        completed_by_agent_id=(
            AgentId(value["completed_by_agent_id"])
            if value["completed_by_agent_id"] is not None
            else None
        ),
        failure_code=value["failure_code"],
        failure_message=value["failure_message"],
    )


def _agent(value: dict[str, Any]) -> Agent:
    return Agent(
        id=AgentId(value["id"]),
        run_id=RunId(value["run_id"]),
        name=value["name"],
        created_seq=value["created_seq"],
        agent_class=AgentClass(value["agent_class"]),
        parent_agent_id=(
            AgentId(value["parent_agent_id"])
            if value["parent_agent_id"] is not None
            else None
        ),
        capabilities=tuple(value["capabilities"]),
        state=AgentState(value["state"]),
        wave=value["wave"],
        current_task_id=(
            TaskId(value["current_task_id"])
            if value["current_task_id"] is not None
            else None
        ),
        last_heartbeat_at=_dt(value["last_heartbeat_at"]),
    )


def _question(value: dict[str, Any]) -> Question:
    return Question(
        id=QuestionId(value["id"]),
        run_id=RunId(value["run_id"]),
        prompt=value["prompt"],
        rationale=value["rationale"],
        asked_at=datetime.fromisoformat(value["asked_at"]),
        blocking=value["blocking"],
        options=tuple(value["options"]),
        recommendation=value["recommendation"],
        confidence_basis_points=value["confidence_basis_points"],
        allow_custom_answer=value["allow_custom_answer"],
        bound_revision=value["bound_revision"],
        affected_artifact_ids=tuple(value["affected_artifact_ids"]),
        dependent_decision_ids=tuple(value["dependent_decision_ids"]),
        state=QuestionState(value["state"]),
        answer=value["answer"],
        answered_by=value["answered_by"],
        answered_at=_dt(value["answered_at"]),
    )


def _approval(value: dict[str, Any]) -> Approval:
    return Approval(
        id=ApprovalId(value["id"]),
        run_id=RunId(value["run_id"]),
        kind=ApprovalKind(value["kind"]),
        subject_digest=value["subject_digest"],
        summary=value["summary"],
        requested_at=datetime.fromisoformat(value["requested_at"]),
        expires_at=_dt(value["expires_at"]),
        state=ApprovalState(value["state"]),
        decided_by=value["decided_by"],
        decided_at=_dt(value["decided_at"]),
        reason=value["reason"],
    )


def _evidence(value: dict[str, Any]) -> Evidence:
    return Evidence(
        id=EvidenceId(value["id"]),
        run_id=RunId(value["run_id"]),
        kind=EvidenceKind(value["kind"]),
        source=value["source"],
        content_digest=value["content_digest"],
        summary=value["summary"],
        captured_at=datetime.fromisoformat(value["captured_at"]),
        task_id=TaskId(value["task_id"]) if value["task_id"] is not None else None,
        check_id=value["check_id"],
        policy_digest=value["policy_digest"],
        passed=value["passed"],
        metadata_json=value["metadata_json"],
    )


def _event(value: dict[str, Any]) -> OrchestrationEvent:
    return OrchestrationEvent(
        id=EventId(value["id"]),
        run_id=RunId(value["run_id"]),
        sequence=value["sequence"],
        type=EventType(value["type"]),
        actor=value["actor"],
        occurred_at=datetime.fromisoformat(value["occurred_at"]),
        aggregate_id=value["aggregate_id"],
        payload_json=value["payload_json"],
        evidence_ids=tuple(EvidenceId(item) for item in value["evidence_ids"]),
        previous_hash=value["previous_hash"],
        event_hash=value["event_hash"],
    )


class SQLiteOrchestratorStore:
    """Small durable store with atomic snapshots and an append-only audit chain."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._connection = sqlite3.connect(
            self.path,
            isolation_level=None,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._lock = RLock()
        self._depth = 0
        self._initialize()

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "SQLiteOrchestratorStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Create a nestable, immediate transaction protected by a process lock."""

        with self._lock:
            outer = self._depth == 0
            if outer:
                self._connection.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                yield
            except Exception:
                self._depth -= 1
                if outer:
                    self._connection.execute("ROLLBACK")
                raise
            else:
                self._depth -= 1
                if outer:
                    self._connection.execute("COMMIT")

    def _initialize(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                phase TEXT NOT NULL,
                body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id),
                state TEXT NOT NULL,
                body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id),
                state TEXT NOT NULL,
                wave INTEGER NOT NULL,
                created_seq INTEGER NOT NULL,
                body TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tasks_schedule
                ON tasks(run_id, state, wave, created_seq);
            CREATE TABLE IF NOT EXISTS questions (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id),
                state TEXT NOT NULL,
                body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id),
                state TEXT NOT NULL,
                subject_digest TEXT NOT NULL,
                body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS evidence (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES runs(id),
                task_id TEXT,
                content_digest TEXT NOT NULL,
                body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                run_id TEXT NOT NULL REFERENCES runs(id),
                sequence INTEGER NOT NULL,
                id TEXT NOT NULL UNIQUE,
                previous_hash TEXT NOT NULL,
                event_hash TEXT NOT NULL,
                body TEXT NOT NULL,
                PRIMARY KEY (run_id, sequence)
            );
            """
        )

    def save_run(self, run: Run, *, expected_revision: int | None) -> None:
        if type(run) is not Run:
            raise StoreError("run persistence requires an exact Run record")
        if expected_revision is not None and type(expected_revision) is not int:
            raise StoreError("expected run revision must be an exact integer or null")
        # Serialize once after the exact-type check.  All indexed columns and
        # the body below are derived from the same immutable caller snapshot.
        run_body = _body(run)
        with self.transaction():
            if expected_revision is None:
                if run.revision != 0:
                    raise ConcurrencyConflict("new runs must start at revision zero")
                if run.task_inventory_digest is not None and (
                    run.task_inventory_digest != task_inventory_digest(run.id, ())
                ):
                    raise StoreError(
                        "a new run cannot seal tasks before its durable row exists"
                    )
                try:
                    self._connection.execute(
                        "INSERT INTO runs(id, revision, phase, body) VALUES (?, ?, ?, ?)",
                        (str(run.id), run.revision, run.phase.value, run_body),
                    )
                except sqlite3.IntegrityError as exc:
                    raise ConcurrencyConflict(f"run {run.id} already exists") from exc
                return
            current = self.get_run(run.id)
            if (
                current.task_inventory_digest is not None
                and run.task_inventory_digest != current.task_inventory_digest
            ):
                raise StoreError("a sealed task inventory digest is immutable")
            if run.task_inventory_digest is not None:
                durable_tasks = self.list_tasks(run.id)
                if (
                    task_inventory_digest(run.id, durable_tasks)
                    != run.task_inventory_digest
                ):
                    raise StoreError(
                        "run task inventory does not match all durable task contracts"
                    )
            if run.revision != expected_revision + 1:
                raise ConcurrencyConflict(
                    "updated run revision must be exactly expected_revision + 1"
                )
            cursor = self._connection.execute(
                """
                UPDATE runs SET revision = ?, phase = ?, body = ?
                WHERE id = ? AND revision = ?
                """,
                (
                    run.revision,
                    run.phase.value,
                    run_body,
                    str(run.id),
                    expected_revision,
                ),
            )
            if cursor.rowcount != 1:
                raise ConcurrencyConflict(
                    f"run {run.id} is not at revision {expected_revision}"
                )

    def get_run(self, run_id: RunId) -> Run:
        row = self._connection.execute(
            "SELECT id, revision, phase, body FROM runs WHERE id = ?", (str(run_id),)
        ).fetchone()
        if row is None:
            raise NotFound(f"run {run_id} not found")
        run = _decode_record(row["body"], _run, f"run {run_id}")
        if (
            str(run.id) != row["id"]
            or run.revision != row["revision"]
            or run.phase.value != row["phase"]
        ):
            raise SnapshotIntegrityError(f"run {run_id} index/body mismatch")
        return run

    def put_task(self, task: Task) -> None:
        if type(task) is not Task:
            raise StoreError("task persistence requires an exact Task record")
        with self.transaction():
            run = self.get_run(task.run_id)
            if run.task_inventory_digest is not None:
                tasks_by_id = {item.id: item for item in self.list_tasks(run.id)}
                tasks_by_id[task.id] = task
                if (
                    task_inventory_digest(run.id, tuple(tasks_by_id.values()))
                    != run.task_inventory_digest
                ):
                    raise StoreError(
                        "task write would change the sealed task inventory"
                    )
            self._put_task_unchecked(task)

    def _put_task_unchecked(self, task: Task) -> None:
        if type(task) is not Task:
            raise StoreError("task persistence requires an exact Task record")
        self._put_mutable(
            "tasks",
            task.id,
            task.run_id,
            task.state.value,
            _body(task),
            extras=("wave", task.wave, "created_seq", task.created_seq),
        )

    def put_agent(self, agent: Agent) -> None:
        if type(agent) is not Agent:
            raise StoreError("agent persistence requires an exact Agent record")
        self._put_mutable(
            "agents", agent.id, agent.run_id, agent.state.value, _body(agent)
        )

    def put_question(self, question: Question) -> None:
        if type(question) is not Question:
            raise StoreError("question persistence requires an exact Question record")
        self._put_mutable(
            "questions",
            question.id,
            question.run_id,
            question.state.value,
            _body(question),
        )

    def put_approval(self, approval: Approval) -> None:
        if type(approval) is not Approval:
            raise StoreError("approval persistence requires an exact Approval record")
        self._put_mutable(
            "approvals",
            approval.id,
            approval.run_id,
            approval.state.value,
            _body(approval),
            extras=("subject_digest", approval.subject_digest),
        )

    def capture_evidence(self, evidence: Evidence) -> None:
        """Insert immutable evidence; IDs can never be overwritten."""

        if type(evidence) is not Evidence:
            raise StoreError("evidence persistence requires an exact Evidence record")
        with self.transaction():
            try:
                self._connection.execute(
                    """
                    INSERT INTO evidence(id, run_id, task_id, content_digest, body)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        str(evidence.id),
                        str(evidence.run_id),
                        str(evidence.task_id) if evidence.task_id else None,
                        evidence.content_digest,
                        _body(evidence),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise StoreError(f"evidence {evidence.id} already exists or is invalid") from exc

    def append_event(self, event: OrchestrationEvent) -> None:
        """Append only if sequence, prior hash, evidence, and event hash all agree."""

        if type(event) is not OrchestrationEvent:
            raise EventChainError(
                "event persistence requires an exact OrchestrationEvent record"
            )
        if not OrchestrationEvent.validate_hash(event):
            raise EventChainError("event contents fail their own digest")
        with self.transaction():
            existing = self.list_events(event.run_id, verify=True)
            tail = existing[-1] if existing else None
            expected_sequence = 1 if tail is None else tail.sequence + 1
            expected_previous = "" if tail is None else tail.event_hash
            if event.sequence != expected_sequence:
                raise EventChainError(
                    f"expected event sequence {expected_sequence}, got {event.sequence}"
                )
            if event.previous_hash != expected_previous:
                raise EventChainError("event previous_hash does not match durable tail")
            for evidence_id in event.evidence_ids:
                row = self._connection.execute(
                    "SELECT run_id FROM evidence WHERE id = ?", (str(evidence_id),)
                ).fetchone()
                if row is None or row["run_id"] != str(event.run_id):
                    raise EventChainError(
                        f"event evidence {evidence_id} is missing or belongs to another run"
                    )
            try:
                self._connection.execute(
                    """
                    INSERT INTO events(run_id, sequence, id, previous_hash, event_hash, body)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(event.run_id),
                        event.sequence,
                        str(event.id),
                        event.previous_hash,
                        event.event_hash,
                        _body(event),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise EventChainError(f"event {event.id} conflicts with durable state") from exc

    def list_tasks(self, run_id: RunId) -> tuple[Task, ...]:
        return self._list(
            "tasks",
            run_id,
            _task,
            "ORDER BY wave, created_seq, id",
        )

    def list_agents(self, run_id: RunId) -> tuple[Agent, ...]:
        return self._list("agents", run_id, _agent, "ORDER BY id")

    def list_questions(self, run_id: RunId) -> tuple[Question, ...]:
        return self._list("questions", run_id, _question, "ORDER BY id")

    def list_approvals(self, run_id: RunId) -> tuple[Approval, ...]:
        return self._list("approvals", run_id, _approval, "ORDER BY id")

    def list_evidence(self, run_id: RunId) -> tuple[Evidence, ...]:
        return self._list("evidence", run_id, _evidence, "ORDER BY id")

    def list_events(
        self, run_id: RunId, *, verify: bool = True
    ) -> tuple[OrchestrationEvent, ...]:
        rows = self._connection.execute(
            """
            SELECT run_id, sequence, id, previous_hash, event_hash, body
            FROM events WHERE run_id = ? ORDER BY sequence
            """,
            (str(run_id),),
        ).fetchall()
        decoded: list[OrchestrationEvent] = []
        try:
            for row in rows:
                event = _decode_record(
                    row["body"],
                    _event,
                    f"event sequence {row['sequence']}",
                )
                if (
                    str(event.run_id) != row["run_id"]
                    or event.sequence != row["sequence"]
                    or str(event.id) != row["id"]
                    or event.previous_hash != row["previous_hash"]
                    or event.event_hash != row["event_hash"]
                ):
                    raise EventChainError(
                        f"event index/body mismatch at sequence {row['sequence']}"
                    )
                decoded.append(event)
        except (
            DomainError,
            json.JSONDecodeError,
            KeyError,
            SnapshotIntegrityError,
            TypeError,
        ) as exc:
            raise EventChainError("event body is malformed or has been modified") from exc
        events = tuple(decoded)
        if verify:
            previous = ""
            for expected_sequence, event in enumerate(events, start=1):
                if event.sequence != expected_sequence:
                    raise EventChainError("event chain has a sequence gap")
                if event.previous_hash != previous or not event.validate_hash():
                    raise EventChainError(
                        f"event chain validation failed at sequence {event.sequence}"
                    )
                previous = event.event_hash
        return events

    def commit_snapshot(
        self,
        run: Run,
        *,
        expected_revision: int,
        tasks: Sequence[Task] = (),
        agents: Sequence[Agent] = (),
        questions: Sequence[Question] = (),
        approvals: Sequence[Approval] = (),
        evidence: Sequence[Evidence] = (),
        events: Sequence[OrchestrationEvent] = (),
    ) -> None:
        """Atomically persist a coordination/scheduling decision and its evidence."""

        if type(run) is not Run:
            raise StoreError("snapshot persistence requires an exact Run record")
        if type(expected_revision) is not int:
            raise StoreError("expected run revision must be an exact integer")
        collections = (
            (tasks, Task, "tasks"),
            (agents, Agent, "agents"),
            (questions, Question, "questions"),
            (approvals, Approval, "approvals"),
            (evidence, Evidence, "evidence"),
            (events, OrchestrationEvent, "events"),
        )
        for values, expected_type, label in collections:
            if type(values) is not tuple or any(
                type(item) is not expected_type for item in values
            ):
                raise StoreError(
                    f"snapshot {label} must be an exact tuple of exact records"
                )
        with self.transaction():
            current = self.get_run(run.id)
            sealing_inventory = (
                current.task_inventory_digest is None
                and run.task_inventory_digest is not None
            )
            if sealing_inventory:
                for item in tasks:
                    self.put_task(item)
                self.save_run(run, expected_revision=expected_revision)
            else:
                self.save_run(run, expected_revision=expected_revision)
                for item in tasks:
                    self.put_task(item)
            for item in agents:
                self.put_agent(item)
            for item in questions:
                self.put_question(item)
            for item in approvals:
                self.put_approval(item)
            for item in evidence:
                self.capture_evidence(item)
            for item in events:
                self.append_event(item)

    def _put_mutable(
        self,
        table: str,
        item_id: object,
        run_id: RunId,
        state: str,
        body: str,
        *,
        extras: tuple[Any, ...] = (),
    ) -> None:
        allowed = {"tasks", "agents", "questions", "approvals"}
        if table not in allowed:
            raise StoreError(f"unsupported mutable table {table}")
        columns = ["id", "run_id", "state"]
        values: list[Any] = [str(item_id), str(run_id), state]
        for index in range(0, len(extras), 2):
            columns.append(str(extras[index]))
            values.append(extras[index + 1])
        columns.append("body")
        values.append(body)
        updates = ", ".join(f"{column}=excluded.{column}" for column in columns[1:])
        placeholders = ", ".join("?" for _ in columns)
        with self.transaction():
            try:
                cursor = self._connection.execute(
                    f"INSERT INTO {table} ({', '.join(columns)}) "
                    f"VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates} "
                    f"WHERE {table}.run_id = excluded.run_id",
                    values,
                )
                if cursor.rowcount != 1:
                    raise StoreError(
                        f"cannot move {table} record {item_id} between runs"
                    )
            except sqlite3.IntegrityError as exc:
                raise StoreError(f"cannot persist {table} record {item_id}") from exc

    def _list(
        self,
        table: str,
        run_id: RunId,
        decoder: Callable[[dict[str, Any]], T],
        order: str,
        *,
        key: str = "run_id",
    ) -> tuple[T, ...]:
        allowed = {"tasks", "agents", "questions", "approvals", "evidence", "events"}
        if table not in allowed or key != "run_id":
            raise StoreError("unsupported list query")
        rows = self._connection.execute(
            f"SELECT * FROM {table} WHERE {key} = ? {order}",
            (str(run_id),),
        ).fetchall()
        records: list[T] = []
        for row in rows:
            record = _decode_record(row["body"], decoder, f"{table} record")
            if not self._snapshot_index_matches(table, row, record, run_id):
                raise SnapshotIntegrityError(f"{table} index/body mismatch")
            records.append(record)
        return tuple(records)

    @staticmethod
    def _snapshot_index_matches(
        table: str,
        row: sqlite3.Row,
        record: object,
        requested_run_id: RunId,
    ) -> bool:
        record_id = getattr(record, "id", None)
        record_run_id = getattr(record, "run_id", None)
        if (
            str(record_id) != row["id"]
            or str(record_run_id) != row["run_id"]
            or str(record_run_id) != str(requested_run_id)
        ):
            return False
        if table == "tasks":
            return (
                cast(Task, record).state.value == row["state"]
                and cast(Task, record).wave == row["wave"]
                and cast(Task, record).created_seq == row["created_seq"]
            )
        if table == "agents":
            return cast(Agent, record).state.value == row["state"]
        if table == "questions":
            return cast(Question, record).state.value == row["state"]
        if table == "approvals":
            approval = cast(Approval, record)
            return (
                approval.state.value == row["state"]
                and approval.subject_digest == row["subject_digest"]
            )
        if table == "evidence":
            evidence = cast(Evidence, record)
            return (
                (
                    str(evidence.task_id)
                    if evidence.task_id is not None
                    else None
                )
                == row["task_id"]
                and evidence.content_digest == row["content_digest"]
            )
        return False

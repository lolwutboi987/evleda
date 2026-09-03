"""Durable campaign projections composed over the orchestration store.

Campaign identity and documents deliberately live in the existing append-only
event/evidence model.  There is no second mutable campaign database that could
drift from the scheduler snapshot after a restart.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ..orchestrator import (
    Approval,
    Evidence,
    OrchestrationEvent,
    Question,
    Run,
    RunId,
    SQLiteOrchestratorStore,
    Task,
)
from ..orchestrator.models import Agent
from .models import CampaignError, CampaignEventView, CampaignObjective, DocumentKind, DocumentRecord


@dataclass(frozen=True, slots=True)
class CampaignSnapshot:
    """One coherent, immutable read of every durable campaign aggregate."""

    run: Run
    tasks: tuple[Task, ...]
    agents: tuple[Agent, ...]
    questions: tuple[Question, ...]
    approvals: tuple[Approval, ...]
    evidence: tuple[Evidence, ...]
    events: tuple[OrchestrationEvent, ...]


class CampaignRepository:
    """Campaign-specific projection and integrity checks around SQLite."""

    def __init__(self, path: str | Path) -> None:
        if type(path) is not str and type(path) is not Path:
            raise CampaignError("campaign database path must be an exact string or Path")
        self.store = SQLiteOrchestratorStore(path)

    def close(self) -> None:
        self.store.close()

    def __enter__(self) -> "CampaignRepository":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def snapshot(self, campaign_id: str) -> CampaignSnapshot:
        if type(campaign_id) is not str or not campaign_id or campaign_id != campaign_id.strip():
            raise CampaignError("campaign ID must be an exact non-empty string")
        run_id = RunId(campaign_id)
        # The store lock/transaction prevents a local writer from interleaving
        # with this multi-table read.  Every decoded record also cross-checks its
        # indexed columns and every event hash is verified by the store.
        with self.store.transaction():
            return CampaignSnapshot(
                run=self.store.get_run(run_id),
                tasks=self.store.list_tasks(run_id),
                agents=self.store.list_agents(run_id),
                questions=self.store.list_questions(run_id),
                approvals=self.store.list_approvals(run_id),
                evidence=self.store.list_evidence(run_id),
                events=self.store.list_events(run_id, verify=True),
            )

    @staticmethod
    def objective(snapshot: CampaignSnapshot) -> CampaignObjective:
        if type(snapshot) is not CampaignSnapshot:
            raise CampaignError("campaign projection requires an exact snapshot")
        if not snapshot.events or snapshot.events[0].type.value != "run.created":
            raise CampaignError("campaign is missing its durable creation event")
        try:
            payload = json.loads(snapshot.events[0].payload_json)
        except json.JSONDecodeError as exc:  # pragma: no cover - store validates first
            raise CampaignError("campaign creation event is malformed") from exc
        if type(payload) is not dict:
            raise CampaignError("campaign creation payload must be an object")
        source = cast(dict[str, Any], payload)
        expected = {
            "base_revision",
            "generation",
            "objective",
            "objective_digest",
            "parent_campaign_id",
            "project_id",
            "requested_agent_capacity",
            "scope",
        }
        if set(source) != expected or source.get("scope") != "flux-campaign-created-v1":
            raise CampaignError("campaign creation payload has an invalid schema")
        project_id = source["project_id"]
        base_revision = source["base_revision"]
        objective = source["objective"]
        if any(type(item) is not str for item in (project_id, base_revision, objective)):
            raise CampaignError("campaign creation identity has invalid scalar types")
        result = CampaignObjective(project_id, base_revision, objective)
        if result.objective != snapshot.run.objective:
            raise CampaignError("campaign run objective disagrees with its creation event")
        return result

    @staticmethod
    def documents(snapshot: CampaignSnapshot) -> dict[DocumentKind, DocumentRecord]:
        if type(snapshot) is not CampaignSnapshot:
            raise CampaignError("document projection requires an exact snapshot")
        documents: dict[DocumentKind, DocumentRecord] = {}
        for item in snapshot.evidence:
            if item.source != "campaign-service:document":
                continue
            try:
                metadata = json.loads(item.metadata_json)
            except json.JSONDecodeError as exc:  # pragma: no cover - Evidence validates
                raise CampaignError("campaign document metadata is malformed") from exc
            if type(metadata) is not dict or set(metadata) != {
                "content",
                "document_kind",
                "revision",
            }:
                raise CampaignError("campaign document metadata has an invalid schema")
            source = cast(dict[str, Any], metadata)
            kind_value = source["document_kind"]
            revision = source["revision"]
            content = source["content"]
            if type(kind_value) is not str or type(revision) is not int or type(content) is not str:
                raise CampaignError("campaign document metadata has invalid scalar types")
            try:
                kind = DocumentKind(kind_value)
            except ValueError as exc:
                raise CampaignError("campaign document kind is unsupported") from exc
            document = DocumentRecord(
                evidence_id=str(item.id),
                kind=kind,
                revision=revision,
                content=content,
                content_digest=item.content_digest,
                summary=item.summary,
                created_at=item.captured_at,
            )
            existing = documents.get(kind)
            if existing is None or document.revision > existing.revision:
                documents[kind] = document
            elif document.revision == existing.revision:
                raise CampaignError("campaign has duplicate document revisions")
        return documents

    @staticmethod
    def event_views(snapshot: CampaignSnapshot) -> tuple[CampaignEventView, ...]:
        if type(snapshot) is not CampaignSnapshot:
            raise CampaignError("event projection requires an exact snapshot")
        return tuple(
            CampaignEventView(
                sequence=item.sequence,
                event_type=item.type.value,
                actor=item.actor,
                occurred_at=item.occurred_at,
                aggregate_id=item.aggregate_id,
                payload_json=item.payload_json,
                event_hash=item.event_hash,
            )
            for item in snapshot.events
        )

"""Immutable contracts for the EvlEDA MCP gateway.

The model layer is transport neutral.  An MCP/HTTP host authenticates a
``Principal`` out of band and passes it with the model-supplied typed request.
Consequently an agent cannot grant itself a stronger capability profile by
placing a role name in tool arguments.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, IntEnum
from typing import Any, TypeAlias

from .codec import canonical_json, stable_digest
from .errors import InvalidRequest

JsonScalar: TypeAlias = str | int | bool | None
JsonValue: TypeAlias = JsonScalar | tuple["JsonValue", ...] | Mapping[str, "JsonValue"]


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_REVISION = re.compile(r"^rev_[0-9a-f]{64}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _required_text(value: str, label: str) -> None:
    if not value or value != value.strip():
        raise InvalidRequest(f"{label} must be non-empty and trimmed")


def _identifier(value: str, label: str) -> None:
    if not _IDENTIFIER.fullmatch(value):
        raise InvalidRequest(f"{label} is not a valid stable identifier")


def _revision(value: str, label: str) -> None:
    if not _REVISION.fullmatch(value):
        raise InvalidRequest(f"{label} must be an exact rev_<sha256> revision")


class CapabilityTier(IntEnum):
    READ = 10
    STAGE = 20
    RELEASE = 30


class ProfileName(str, Enum):
    OBSERVER = "observer"
    DESIGNER = "designer"
    RELEASE_MANAGER = "release_manager"

    @property
    def maximum_tier(self) -> CapabilityTier:
        return {
            ProfileName.OBSERVER: CapabilityTier.READ,
            ProfileName.DESIGNER: CapabilityTier.STAGE,
            ProfileName.RELEASE_MANAGER: CapabilityTier.RELEASE,
        }[self]


class ActorKind(str, Enum):
    USER = "user"
    AGENT = "agent"
    SERVICE = "service"


class ToolName(str, Enum):
    INSPECT_PROJECT = "inspect_project"
    CREATE_AGENT_RUN = "create_agent_run"
    ANSWER_QUESTION = "answer_question"
    DECIDE_APPROVAL = "decide_approval"
    PREVIEW_PATCH = "preview_patch"
    STAGE_DESIGN_PATCH = "stage_design_patch"
    RUN_VERIFICATION = "run_verification"
    COMMIT_TRANSACTION = "commit_transaction"
    ROLLBACK_TRANSACTION = "rollback_transaction"
    EXPORT_PROJECT = "export_project"


class PatchAction(str, Enum):
    ADD_COMPONENT = "add_component"
    REMOVE_COMPONENT = "remove_component"
    CONNECT_NET = "connect_net"
    DISCONNECT_NET = "disconnect_net"
    SET_PROPERTY = "set_property"
    SET_CONSTRAINT = "set_constraint"
    PLACE_COMPONENT = "place_component"
    ROUTE_NET = "route_net"


class RunState(str, Enum):
    CLARIFYING = "clarifying"
    PLANNING = "planning"
    AWAITING_STAGE_APPROVAL = "awaiting_stage_approval"
    STAGED = "staged"
    VERIFYING = "verifying"
    AWAITING_RELEASE_APPROVAL = "awaiting_release_approval"
    COMPLETE = "complete"
    ROLLED_BACK = "rolled_back"


class ApprovalKind(str, Enum):
    STAGE = "stage"
    RELEASE = "release"


class ApprovalDecision(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ExportFormat(str, Enum):
    KICAD_ARCHIVE = "kicad_archive"
    GERBER_BUNDLE = "gerber_bundle"
    IPC2581 = "ipc2581"


@dataclass(frozen=True, slots=True)
class Principal:
    actor_id: str
    actor_kind: ActorKind
    profile: ProfileName

    def __post_init__(self) -> None:
        _identifier(self.actor_id, "principal.actor_id")


@dataclass(frozen=True, slots=True)
class Invocation:
    """Trusted transport context plus caller-chosen retry identity."""

    principal: Principal
    idempotency_key: str

    def __post_init__(self) -> None:
        _identifier(self.idempotency_key, "idempotency_key")


@dataclass(frozen=True, slots=True)
class QuestionSpec:
    prompt: str
    rationale: str
    blocking: bool = True
    options: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _required_text(self.prompt, "question.prompt")
        _required_text(self.rationale, "question.rationale")
        if any(not option.strip() or option != option.strip() for option in self.options):
            raise InvalidRequest("question options must be non-empty and trimmed")
        if len(set(self.options)) != len(self.options):
            raise InvalidRequest("question options must be unique")


@dataclass(frozen=True, slots=True)
class Parameter:
    name: str
    value: JsonValue

    def __post_init__(self) -> None:
        _identifier(self.name, "parameter.name")
        # This validates recursive type safety and rejects floats/objects.
        canonical_json(self.value)


@dataclass(frozen=True, slots=True)
class PatchOperation:
    operation_id: str
    action: PatchAction
    target_id: str
    parameters: tuple[Parameter, ...] = ()

    def __post_init__(self) -> None:
        _identifier(self.operation_id, "operation.operation_id")
        _identifier(self.target_id, "operation.target_id")
        names = tuple(parameter.name for parameter in self.parameters)
        if len(names) != len(set(names)):
            raise InvalidRequest("operation parameter names must be unique")
        if names != tuple(sorted(names)):
            raise InvalidRequest("operation parameters must be sorted by name")

    def parameter_map(self) -> dict[str, JsonValue]:
        return {parameter.name: parameter.value for parameter in self.parameters}


@dataclass(frozen=True, slots=True)
class DesignPatch:
    patch_id: str
    base_revision: str
    rationale: str
    operations: tuple[PatchOperation, ...]
    evidence_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _identifier(self.patch_id, "patch.patch_id")
        _revision(self.base_revision, "patch.base_revision")
        _required_text(self.rationale, "patch.rationale")
        if not self.operations:
            raise InvalidRequest("a design patch must contain at least one operation")
        operation_ids = tuple(operation.operation_id for operation in self.operations)
        if len(operation_ids) != len(set(operation_ids)):
            raise InvalidRequest("patch operation IDs must be unique")
        if operation_ids != tuple(sorted(operation_ids)):
            raise InvalidRequest("patch operations must be sorted by operation_id")
        if tuple(sorted(set(self.evidence_ids))) != self.evidence_ids:
            raise InvalidRequest("patch evidence IDs must be sorted and unique")

    @property
    def digest(self) -> str:
        return stable_digest(self)


# ---- Outcome-level tool inputs -------------------------------------------------


@dataclass(frozen=True, slots=True)
class InspectProjectRequest:
    project_id: str
    expected_project_revision: str | None = None

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        if self.expected_project_revision is not None:
            _revision(self.expected_project_revision, "expected_project_revision")


@dataclass(frozen=True, slots=True)
class CreateAgentRunRequest:
    project_id: str
    expected_project_revision: str
    objective: str
    initial_questions: tuple[QuestionSpec, ...] = ()
    max_parallel_agents: int | None = None
    token_budget: int | None = None

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _required_text(self.objective, "objective")
        if self.max_parallel_agents is not None and self.max_parallel_agents < 1:
            raise InvalidRequest("max_parallel_agents must be positive or null/unlimited")
        if self.token_budget is not None and self.token_budget < 1:
            raise InvalidRequest("token_budget must be positive or null/unlimited")


@dataclass(frozen=True, slots=True)
class AnswerQuestionRequest:
    project_id: str
    expected_project_revision: str
    run_id: str
    expected_run_revision: int
    question_id: str
    answer: str

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _identifier(self.run_id, "run_id")
        _identifier(self.question_id, "question_id")
        _required_text(self.answer, "answer")
        if self.expected_run_revision < 0:
            raise InvalidRequest("expected_run_revision cannot be negative")


@dataclass(frozen=True, slots=True)
class DecideApprovalRequest:
    project_id: str
    expected_project_revision: str
    run_id: str
    expected_run_revision: int
    approval_id: str
    approve: bool
    reason: str

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _identifier(self.run_id, "run_id")
        _identifier(self.approval_id, "approval_id")
        _required_text(self.reason, "reason")
        if self.expected_run_revision < 0:
            raise InvalidRequest("expected_run_revision cannot be negative")


@dataclass(frozen=True, slots=True)
class PreviewPatchRequest:
    project_id: str
    expected_project_revision: str
    run_id: str
    expected_run_revision: int
    patch: DesignPatch

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _identifier(self.run_id, "run_id")
        if self.expected_run_revision < 0:
            raise InvalidRequest("expected_run_revision cannot be negative")
        if self.patch.base_revision != self.expected_project_revision:
            raise InvalidRequest("patch base and expected project revisions must match")


@dataclass(frozen=True, slots=True)
class StageDesignPatchRequest:
    project_id: str
    expected_project_revision: str
    run_id: str
    expected_run_revision: int
    patch: DesignPatch
    preview_digest: str
    approval_receipt_id: str

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _identifier(self.run_id, "run_id")
        _identifier(self.approval_receipt_id, "approval_receipt_id")
        _required_text(self.preview_digest, "preview_digest")
        if self.expected_run_revision < 0:
            raise InvalidRequest("expected_run_revision cannot be negative")
        if self.patch.base_revision != self.expected_project_revision:
            raise InvalidRequest("patch base and expected project revisions must match")


@dataclass(frozen=True, slots=True)
class RunVerificationRequest:
    project_id: str
    expected_project_revision: str
    expected_staged_revision: str
    run_id: str
    expected_run_revision: int

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _revision(self.expected_staged_revision, "expected_staged_revision")
        _identifier(self.run_id, "run_id")
        if self.expected_run_revision < 0:
            raise InvalidRequest("expected_run_revision cannot be negative")


@dataclass(frozen=True, slots=True)
class CommitTransactionRequest:
    project_id: str
    expected_project_revision: str
    expected_staged_revision: str
    run_id: str
    expected_run_revision: int
    verification_report_digest: str
    approval_receipt_id: str

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _revision(self.expected_staged_revision, "expected_staged_revision")
        _identifier(self.run_id, "run_id")
        _identifier(self.approval_receipt_id, "approval_receipt_id")
        if not _SHA256.fullmatch(self.verification_report_digest):
            raise InvalidRequest("verification_report_digest must be a sha256 digest")
        if self.expected_run_revision < 0:
            raise InvalidRequest("expected_run_revision cannot be negative")


@dataclass(frozen=True, slots=True)
class RollbackTransactionRequest:
    project_id: str
    expected_project_revision: str
    expected_staged_revision: str
    run_id: str
    expected_run_revision: int
    reason: str

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")
        _revision(self.expected_staged_revision, "expected_staged_revision")
        _identifier(self.run_id, "run_id")
        _required_text(self.reason, "reason")
        if self.expected_run_revision < 0:
            raise InvalidRequest("expected_run_revision cannot be negative")


@dataclass(frozen=True, slots=True)
class ExportProjectRequest:
    project_id: str
    expected_project_revision: str
    format: ExportFormat

    def __post_init__(self) -> None:
        _identifier(self.project_id, "project_id")
        _revision(self.expected_project_revision, "expected_project_revision")


# ---- Adapter and coordination records ----------------------------------------


@dataclass(frozen=True, slots=True)
class ProjectSnapshot:
    project_id: str
    project_revision: str
    component_count: int
    net_count: int
    operation_count: int
    active_staged_revision: str | None


@dataclass(frozen=True, slots=True)
class AgentRun:
    run_id: str
    project_id: str
    objective: str
    project_revision: str
    run_revision: int
    state: RunState
    strict_user_coordination: bool
    max_parallel_agents: int | None
    token_budget: int | None
    question_ids: tuple[str, ...] = ()
    approval_ids: tuple[str, ...] = ()
    staged_revision: str | None = None
    verification_report_digest: str | None = None


@dataclass(frozen=True, slots=True)
class QuestionRecord:
    question_id: str
    run_id: str
    prompt: str
    rationale: str
    blocking: bool
    options: tuple[str, ...]
    answer: str | None = None
    answered_by: str | None = None
    answered_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ApprovalRequestRecord:
    approval_id: str
    run_id: str
    kind: ApprovalKind
    subject_digest: str
    summary: str
    decision: ApprovalDecision
    requested_at: datetime


@dataclass(frozen=True, slots=True)
class ApprovalReceipt:
    receipt_id: str
    approval_id: str
    run_id: str
    kind: ApprovalKind
    subject_digest: str
    decision: ApprovalDecision
    decided_by: str
    decided_at: datetime
    reason: str
    receipt_digest: str


@dataclass(frozen=True, slots=True)
class PatchPreview:
    project_id: str
    base_revision: str
    prospective_revision: str
    patch_digest: str
    preview_digest: str
    operation_summaries: tuple[str, ...]
    added: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    modified: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class StageRecord:
    transaction_id: str
    project_id: str
    base_revision: str
    staged_revision: str
    patch_digest: str
    preview_digest: str


@dataclass(frozen=True, slots=True)
class VerificationFinding:
    finding_id: str
    rule_id: str
    severity: str
    message: str
    operation_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class VerificationReport:
    report_id: str
    project_id: str
    base_revision: str
    staged_revision: str
    engine_version: str
    passed: bool
    findings: tuple[VerificationFinding, ...]
    report_digest: str
    input_hash: str | None = None
    rule_set_hash: str | None = None
    compiler_manifest_digest: str | None = None
    compiler_bundle_digest: str | None = None
    manufacturing_release_eligible: bool = False


@dataclass(frozen=True, slots=True)
class ExportArtifact:
    artifact_id: str
    project_id: str
    project_revision: str
    format: ExportFormat
    media_type: str
    content_digest: str
    size_bytes: int
    managed_path: str | None = None


@dataclass(frozen=True, slots=True)
class EvidenceRecord:
    evidence_id: str
    tool_name: ToolName
    actor_id: str
    project_id: str
    project_revision: str
    input_digest: str
    output_digest: str
    captured_at: datetime
    manifest_digest: str


@dataclass(frozen=True, slots=True)
class ToolManifestRecord:
    name: ToolName
    version: str
    required_tier: CapabilityTier
    mutates_canonical_design: bool
    description: str
    input_schema_json: str
    output_schema_json: str

    @property
    def manifest_digest(self) -> str:
        return stable_digest(self)

    def input_schema(self) -> dict[str, Any]:
        return json.loads(self.input_schema_json)

    def output_schema(self) -> dict[str, Any]:
        return json.loads(self.output_schema_json)


@dataclass(frozen=True, slots=True)
class ToolResult:
    tool_name: ToolName
    payload_json: str
    evidence: EvidenceRecord
    manifest_digest: str

    def __post_init__(self) -> None:
        if canonical_json(json.loads(self.payload_json)) != self.payload_json:
            raise InvalidRequest("tool payload must be canonical JSON")

    def payload(self) -> dict[str, Any]:
        value = json.loads(self.payload_json)
        if not isinstance(value, dict):
            raise InvalidRequest("tool payload must encode an object")
        return value


@dataclass(frozen=True, slots=True)
class CapabilityProfile:
    name: ProfileName
    maximum_tier: CapabilityTier = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "maximum_tier", self.name.maximum_tier)

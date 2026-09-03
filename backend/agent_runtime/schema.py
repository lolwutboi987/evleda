"""Closed JSON Schema plus deterministic validation for agent proposals."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .models import (
    AgentProposal,
    AgentTaskContext,
    ProposalAction,
    ProposalRisk,
    ProposalRole,
    ProposalValidationError,
    ProposedOperation,
    ProposedQuestion,
    ProposedTask,
    canonical_json,
    require_identifier,
)


_ID_SCHEMA: dict[str, object] = {
    "type": "string",
    "pattern": r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
}
_TEXT_SCHEMA: dict[str, object] = {"type": "string", "minLength": 1}


def _closed(properties: dict[str, object], required: tuple[str, ...]) -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(required),
    }


AGENT_PROPOSAL_SCHEMA: dict[str, object] = _closed(
    {
        "context_digest": {"type": "string", "pattern": r"^[0-9a-f]{64}$"},
        "summary": _TEXT_SCHEMA,
        "questions": {
            "type": "array",
            "items": _closed(
                {
                    "question_id": _ID_SCHEMA,
                    "prompt": _TEXT_SCHEMA,
                    "rationale": _TEXT_SCHEMA,
                    "options": {
                        "type": "array",
                        "minItems": 2,
                        "items": _TEXT_SCHEMA,
                    },
                    "recommendation": _TEXT_SCHEMA,
                    "blocking": {"type": "boolean"},
                    "affected_artifact_ids": {
                        "type": "array",
                        "items": _ID_SCHEMA,
                    },
                },
                (
                    "question_id",
                    "prompt",
                    "rationale",
                    "options",
                    "recommendation",
                    "blocking",
                    "affected_artifact_ids",
                ),
            ),
        },
        "tasks": {
            "type": "array",
            "items": _closed(
                {
                    "task_id": _ID_SCHEMA,
                    "role": {"enum": [item.value for item in ProposalRole]},
                    "objective": _TEXT_SCHEMA,
                    "dependencies": {"type": "array", "items": _ID_SCHEMA},
                    "required_capabilities": {"type": "array", "items": _ID_SCHEMA},
                    "acceptance_checks": {"type": "array", "items": _ID_SCHEMA},
                    "risk": {"enum": [item.value for item in ProposalRisk]},
                },
                (
                    "task_id",
                    "role",
                    "objective",
                    "dependencies",
                    "required_capabilities",
                    "acceptance_checks",
                    "risk",
                ),
            ),
        },
        "operations": {
            "type": "array",
            "items": _closed(
                {
                    "operation_id": _ID_SCHEMA,
                    "action": {"enum": [item.value for item in ProposalAction]},
                    "target_id": _ID_SCHEMA,
                    "parameters": {
                        "type": "object",
                        "additionalProperties": True,
                    },
                    "evidence_ids": {"type": "array", "items": _ID_SCHEMA},
                },
                ("operation_id", "action", "target_id", "parameters", "evidence_ids"),
            ),
        },
        "residual_risks": {"type": "array", "items": _TEXT_SCHEMA},
    },
    ("context_digest", "summary", "questions", "tasks", "operations", "residual_risks"),
)


_TOP_LEVEL_KEYS = frozenset(
    {"context_digest", "summary", "questions", "tasks", "operations", "residual_risks"}
)
_QUESTION_KEYS = frozenset(
    {
        "question_id",
        "prompt",
        "rationale",
        "options",
        "recommendation",
        "blocking",
        "affected_artifact_ids",
    }
)
_TASK_KEYS = frozenset(
    {
        "task_id",
        "role",
        "objective",
        "dependencies",
        "required_capabilities",
        "acceptance_checks",
        "risk",
    }
)
_OPERATION_KEYS = frozenset(
    {"operation_id", "action", "target_id", "parameters", "evidence_ids"}
)
_FORBIDDEN_PARAMETER_NAMES = frozenset(
    {"command", "command_line", "file_path", "path", "shell", "source_text"}
)


def _mapping(value: Any, label: str, exact_keys: frozenset[str]) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or any(not isinstance(key, str) for key in value):
        raise ProposalValidationError(f"{label} must be an object with string keys")
    keys = frozenset(value)
    if keys != exact_keys:
        missing = sorted(exact_keys - keys)
        extra = sorted(keys - exact_keys)
        raise ProposalValidationError(
            f"{label} has a closed schema (missing={missing}, extra={extra})"
        )
    return value


def _array(value: Any, label: str) -> Sequence[Any]:
    if isinstance(value, (str, bytes, bytearray)) or not isinstance(value, Sequence):
        raise ProposalValidationError(f"{label} must be an array")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProposalValidationError(f"{label} must be non-empty text")
    if len(value) > 16_384:
        raise ProposalValidationError(f"{label} is too long")
    return value


def _string_array(
    value: Any,
    label: str,
    *,
    identifiers: bool = False,
    min_items: int = 0,
    sorted_unique: bool = False,
) -> tuple[str, ...]:
    items = tuple(_text(item, f"{label}[]") for item in _array(value, label))
    if len(items) < min_items:
        raise ProposalValidationError(f"{label} requires at least {min_items} entries")
    if identifiers:
        for item in items:
            require_identifier(item, f"{label}[]")
    if sorted_unique and items != tuple(sorted(set(items))):
        raise ProposalValidationError(f"{label} must be sorted and unique")
    if not sorted_unique and len(items) != len(set(items)):
        raise ProposalValidationError(f"{label} must be unique")
    return items


def _reject_noncanonical_json(value: Any, label: str = "value") -> None:
    if isinstance(value, float):
        raise ProposalValidationError(f"{label} cannot contain floating-point values")
    if value is None or isinstance(value, (str, bool, int)):
        canonical_json(value)
        return
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ProposalValidationError(f"{label} object keys must be strings")
        for key, child in value.items():
            _reject_noncanonical_json(child, f"{label}.{key}")
        canonical_json(value)
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            _reject_noncanonical_json(child, f"{label}[{index}]")
        canonical_json(value)
        return
    raise ProposalValidationError(f"{label} is not canonical JSON")


def _validate_task_dag(tasks: tuple[ProposedTask, ...]) -> None:
    task_ids = {item.task_id for item in tasks}
    for item in tasks:
        unknown = set(item.dependencies) - task_ids
        if unknown:
            raise ProposalValidationError(
                f"task {item.task_id} has unknown dependencies: {sorted(unknown)}"
            )
        if item.task_id in item.dependencies:
            raise ProposalValidationError(f"task {item.task_id} cannot depend on itself")

    visiting: set[str] = set()
    visited: set[str] = set()
    dependencies = {item.task_id: item.dependencies for item in tasks}

    def visit(task_id: str) -> None:
        if task_id in visiting:
            raise ProposalValidationError("task dependencies must be acyclic")
        if task_id in visited:
            return
        visiting.add(task_id)
        for dependency in dependencies[task_id]:
            visit(dependency)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in sorted(task_ids):
        visit(task_id)


def validate_proposal(
    payload: Mapping[str, Any], context: AgentTaskContext
) -> AgentProposal:
    """Validate model output again host-side even when Structured Outputs was used."""

    root = _mapping(payload, "proposal", _TOP_LEVEL_KEYS)
    context_digest = _text(root["context_digest"], "context_digest")
    if context_digest != context.context_digest:
        raise ProposalValidationError("proposal context_digest does not match exact task context")

    questions: list[ProposedQuestion] = []
    for index, raw in enumerate(_array(root["questions"], "questions")):
        item = _mapping(raw, f"questions[{index}]", _QUESTION_KEYS)
        question_id = _text(item["question_id"], "question_id")
        require_identifier(question_id, "question_id")
        options = _string_array(item["options"], "question.options", min_items=2)
        recommendation = _text(item["recommendation"], "question.recommendation")
        if recommendation not in options:
            raise ProposalValidationError("question recommendation must exactly match an option")
        if not isinstance(item["blocking"], bool):
            raise ProposalValidationError("question.blocking must be boolean")
        questions.append(
            ProposedQuestion(
                question_id=question_id,
                prompt=_text(item["prompt"], "question.prompt"),
                rationale=_text(item["rationale"], "question.rationale"),
                options=options,
                recommendation=recommendation,
                blocking=item["blocking"],
                affected_artifact_ids=_string_array(
                    item["affected_artifact_ids"],
                    "question.affected_artifact_ids",
                    identifiers=True,
                    sorted_unique=True,
                ),
            )
        )
    question_ids = tuple(item.question_id for item in questions)
    if len(question_ids) != len(set(question_ids)):
        raise ProposalValidationError("question IDs must be unique")

    tasks: list[ProposedTask] = []
    for index, raw in enumerate(_array(root["tasks"], "tasks")):
        item = _mapping(raw, f"tasks[{index}]", _TASK_KEYS)
        task_id = _text(item["task_id"], "task_id")
        require_identifier(task_id, "task_id")
        try:
            role = ProposalRole(item["role"])
            risk = ProposalRisk(item["risk"])
        except (TypeError, ValueError) as exc:
            raise ProposalValidationError("task role or risk is unsupported") from exc
        capabilities = _string_array(
            item["required_capabilities"],
            "task.required_capabilities",
            identifiers=True,
            sorted_unique=True,
        )
        unauthorized = set(capabilities) - set(context.allowed_capabilities)
        if unauthorized:
            raise ProposalValidationError(
                f"task requests unauthorized capabilities: {sorted(unauthorized)}"
            )
        tasks.append(
            ProposedTask(
                task_id=task_id,
                role=role,
                objective=_text(item["objective"], "task.objective"),
                dependencies=_string_array(
                    item["dependencies"],
                    "task.dependencies",
                    identifiers=True,
                    sorted_unique=True,
                ),
                required_capabilities=capabilities,
                acceptance_checks=_string_array(
                    item["acceptance_checks"],
                    "task.acceptance_checks",
                    identifiers=True,
                    min_items=1,
                    sorted_unique=True,
                ),
                risk=risk,
            )
        )
    task_ids = tuple(item.task_id for item in tasks)
    if len(task_ids) != len(set(task_ids)):
        raise ProposalValidationError("task IDs must be unique")
    _validate_task_dag(tuple(tasks))

    evidence_ids = {item.evidence_id for item in context.evidence}
    operations: list[ProposedOperation] = []
    for index, raw in enumerate(_array(root["operations"], "operations")):
        item = _mapping(raw, f"operations[{index}]", _OPERATION_KEYS)
        operation_id = _text(item["operation_id"], "operation_id")
        target_id = _text(item["target_id"], "target_id")
        require_identifier(operation_id, "operation_id")
        require_identifier(target_id, "target_id")
        try:
            action = ProposalAction(item["action"])
        except (TypeError, ValueError) as exc:
            raise ProposalValidationError("operation action is unsupported") from exc
        if action not in context.allowed_actions:
            raise ProposalValidationError(f"operation action is not allowed: {action.value}")
        parameters = item["parameters"]
        if not isinstance(parameters, Mapping) or any(
            not isinstance(key, str) for key in parameters
        ):
            raise ProposalValidationError("operation parameters must be an object")
        forbidden = _FORBIDDEN_PARAMETER_NAMES.intersection(parameters)
        if forbidden:
            raise ProposalValidationError(
                f"operation contains forbidden escape-hatch parameters: {sorted(forbidden)}"
            )
        _reject_noncanonical_json(parameters, "operation.parameters")
        cited_evidence = _string_array(
            item["evidence_ids"],
            "operation.evidence_ids",
            identifiers=True,
            sorted_unique=True,
        )
        unknown_evidence = set(cited_evidence) - evidence_ids
        if unknown_evidence:
            raise ProposalValidationError(
                f"operation cites unknown evidence: {sorted(unknown_evidence)}"
            )
        operations.append(
            ProposedOperation(
                operation_id=operation_id,
                action=action,
                target_id=target_id,
                parameters=dict(parameters),
                evidence_ids=cited_evidence,
            )
        )
    operation_ids = tuple(item.operation_id for item in operations)
    if len(operation_ids) != len(set(operation_ids)):
        raise ProposalValidationError("operation IDs must be unique")
    if any(item.blocking for item in questions) and operations:
        raise ProposalValidationError(
            "blocking questions prohibit design operations until the user answers"
        )

    return AgentProposal(
        context_digest=context_digest,
        summary=_text(root["summary"], "summary"),
        questions=tuple(questions),
        tasks=tuple(tasks),
        operations=tuple(operations),
        residual_risks=_string_array(root["residual_risks"], "residual_risks"),
    )

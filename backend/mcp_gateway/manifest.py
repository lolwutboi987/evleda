"""Deterministic public tool manifest for MCP host registration."""

from __future__ import annotations

from typing import Any

from .codec import canonical_json, stable_digest
from .models import CapabilityTier, ToolManifestRecord, ToolName


_REVISION = r"^rev_[0-9a-f]{64}$"
_ID = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"


def _object(
    properties: dict[str, Any], required: tuple[str, ...]
) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(required),
    }


_ID_SCHEMA = {"type": "string", "pattern": _ID}
_REV_SCHEMA = {"type": "string", "pattern": _REVISION}
_RUN_FIELDS = {
    "project_id": _ID_SCHEMA,
    "expected_project_revision": _REV_SCHEMA,
    "run_id": _ID_SCHEMA,
    "expected_run_revision": {"type": "integer", "minimum": 0},
}
_STAGE_FIELDS = {
    **_RUN_FIELDS,
    "expected_staged_revision": _REV_SCHEMA,
}

_PARAMETER_SCHEMA = _object(
    {
        "name": _ID_SCHEMA,
        "value": {
            "description": "Canonical JSON value; floating point is rejected",
        },
    },
    ("name", "value"),
)
_OPERATION_SCHEMA = _object(
    {
        "operation_id": _ID_SCHEMA,
        "action": {
            "enum": [
                "add_component",
                "remove_component",
                "connect_net",
                "disconnect_net",
                "set_property",
                "set_constraint",
                "place_component",
                "route_net",
            ]
        },
        "target_id": _ID_SCHEMA,
        "parameters": {"type": "array", "items": _PARAMETER_SCHEMA},
    },
    ("operation_id", "action", "target_id", "parameters"),
)
_PATCH_SCHEMA = _object(
    {
        "patch_id": _ID_SCHEMA,
        "base_revision": _REV_SCHEMA,
        "rationale": {"type": "string", "minLength": 1},
        "operations": {
            "type": "array",
            "minItems": 1,
            "items": _OPERATION_SCHEMA,
        },
        "evidence_ids": {"type": "array", "items": _ID_SCHEMA},
    },
    ("patch_id", "base_revision", "rationale", "operations", "evidence_ids"),
)


def _response_schema(payload_description: str) -> dict[str, Any]:
    return _object(
        {
            "tool_name": {"type": "string"},
            "payload_json": {
                "type": "string",
                "description": payload_description,
            },
            "evidence": {"type": "object"},
            "manifest_digest": {"type": "string", "pattern": r"^[0-9a-f]{64}$"},
        },
        ("tool_name", "payload_json", "evidence", "manifest_digest"),
    )


def _manifest(
    name: ToolName,
    tier: CapabilityTier,
    mutates_design: bool,
    description: str,
    input_schema: dict[str, Any],
) -> ToolManifestRecord:
    return ToolManifestRecord(
        name=name,
        version="1.0.0",
        required_tier=tier,
        mutates_canonical_design=mutates_design,
        description=description,
        input_schema_json=canonical_json(input_schema),
        output_schema_json=canonical_json(
            _response_schema(f"Canonical result for {name.value}")
        ),
    )


TOOL_MANIFESTS: tuple[ToolManifestRecord, ...] = (
    _manifest(
        ToolName.ANSWER_QUESTION,
        CapabilityTier.STAGE,
        False,
        "Record one exact user answer on an open coordination question.",
        _object(
            {**_RUN_FIELDS, "question_id": _ID_SCHEMA, "answer": {"type": "string"}},
            (*_RUN_FIELDS.keys(), "question_id", "answer"),
        ),
    ),
    _manifest(
        ToolName.COMMIT_TRANSACTION,
        CapabilityTier.RELEASE,
        True,
        "Release a verified staged revision with a matching human approval receipt.",
        _object(
            {
                **_STAGE_FIELDS,
                "verification_report_digest": {
                    "type": "string",
                    "pattern": r"^[0-9a-f]{64}$",
                },
                "approval_receipt_id": _ID_SCHEMA,
            },
            (*_STAGE_FIELDS.keys(), "verification_report_digest", "approval_receipt_id"),
        ),
    ),
    _manifest(
        ToolName.CREATE_AGENT_RUN,
        CapabilityTier.STAGE,
        False,
        "Create a strict-coordination multi-agent design run; null budgets are unlimited.",
        _object(
            {
                "project_id": _ID_SCHEMA,
                "expected_project_revision": _REV_SCHEMA,
                "objective": {"type": "string", "minLength": 1},
                "initial_questions": {"type": "array", "items": {"type": "object"}},
                "max_parallel_agents": {"type": ["integer", "null"], "minimum": 1},
                "token_budget": {"type": ["integer", "null"], "minimum": 1},
            },
            (
                "project_id",
                "expected_project_revision",
                "objective",
                "initial_questions",
                "max_parallel_agents",
                "token_budget",
            ),
        ),
    ),
    _manifest(
        ToolName.DECIDE_APPROVAL,
        CapabilityTier.RELEASE,
        False,
        "Record a human decision bound to an immutable stage or release digest.",
        _object(
            {
                **_RUN_FIELDS,
                "approval_id": _ID_SCHEMA,
                "approve": {"type": "boolean"},
                "reason": {"type": "string", "minLength": 1},
            },
            (*_RUN_FIELDS.keys(), "approval_id", "approve", "reason"),
        ),
    ),
    _manifest(
        ToolName.EXPORT_PROJECT,
        CapabilityTier.RELEASE,
        False,
        "Create an immutable managed artifact from one exact committed revision.",
        _object(
            {
                "project_id": _ID_SCHEMA,
                "expected_project_revision": _REV_SCHEMA,
                "format": {"enum": ["kicad_archive", "gerber_bundle", "ipc2581"]},
            },
            ("project_id", "expected_project_revision", "format"),
        ),
    ),
    _manifest(
        ToolName.INSPECT_PROJECT,
        CapabilityTier.READ,
        False,
        "Inspect normalized project counts and revisions without changing state.",
        _object(
            {
                "project_id": _ID_SCHEMA,
                "expected_project_revision": {
                    "anyOf": [_REV_SCHEMA, {"type": "null"}]
                },
            },
            ("project_id", "expected_project_revision"),
        ),
    ),
    _manifest(
        ToolName.PREVIEW_PATCH,
        CapabilityTier.STAGE,
        False,
        "Preview a typed semantic design patch and request digest-bound stage approval.",
        _object(
            {**_RUN_FIELDS, "patch": _PATCH_SCHEMA},
            (*_RUN_FIELDS.keys(), "patch"),
        ),
    ),
    _manifest(
        ToolName.ROLLBACK_TRANSACTION,
        CapabilityTier.STAGE,
        False,
        "Discard one exact staged revision while preserving the committed project.",
        _object(
            {**_STAGE_FIELDS, "reason": {"type": "string", "minLength": 1}},
            (*_STAGE_FIELDS.keys(), "reason"),
        ),
    ),
    _manifest(
        ToolName.RUN_VERIFICATION,
        CapabilityTier.STAGE,
        False,
        "Run deterministic rule gates against one exact staged revision.",
        _object(_STAGE_FIELDS, tuple(_STAGE_FIELDS)),
    ),
    _manifest(
        ToolName.STAGE_DESIGN_PATCH,
        CapabilityTier.STAGE,
        False,
        "Stage an approved typed design patch in an isolated KiCad transaction.",
        _object(
            {
                **_RUN_FIELDS,
                "patch": _PATCH_SCHEMA,
                "preview_digest": {"type": "string", "pattern": r"^[0-9a-f]{64}$"},
                "approval_receipt_id": _ID_SCHEMA,
            },
            (*_RUN_FIELDS.keys(), "patch", "preview_digest", "approval_receipt_id"),
        ),
    ),
)


if tuple(item.name.value for item in TOOL_MANIFESTS) != tuple(
    sorted(item.name.value for item in TOOL_MANIFESTS)
):
    raise RuntimeError("tool manifests must be sorted by name")


MANIFEST_BY_NAME = {manifest.name: manifest for manifest in TOOL_MANIFESTS}
TOOL_MANIFEST_DIGEST = stable_digest(TOOL_MANIFESTS)


def tool_manifest() -> tuple[ToolManifestRecord, ...]:
    return TOOL_MANIFESTS

"""Explicit host-injected hooks for real KiCad operations.

There is deliberately no default implementation. A host must bind these calls
to a real KiCad worker and return the worker's evidence; the MCP layer never
synthesizes an import, export, verification, or render success.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol, cast

from backend.mcp_gateway import (
    CapabilityTier,
    InvalidRequest,
    Invocation,
    canonical_data,
    stable_digest,
)

_ID = {"type": "string", "pattern": r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"}
_REVISION = {"type": "string", "pattern": r"^rev_[0-9a-f]{64}$"}
_SHA256 = {"type": "string", "pattern": r"^[0-9a-f]{64}$"}
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


def _object(properties: dict[str, Any], required: tuple[str, ...]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(required),
    }


@dataclass(frozen=True, slots=True)
class KiCadExecutionEvidence:
    """Digest-bound proof returned by a configured KiCad worker.

    The MCP boundary verifies every request-derived field.  A host can retain
    the policy digest as the immutable identity of its KiCad config, rule deck,
    libraries, and command wrapper.
    """

    worker: str
    kicad_version: str
    operation: str
    project_id: str
    expected_project_revision: str | None
    opened_project_digest: str | None
    opened_bundle_sha256: str | None
    runtime_support_sha256: str | None
    request_digest: str
    payload_digest: str
    policy_digest: str
    idempotency_key: str
    exit_code: int

    def __post_init__(self) -> None:
        for name in ("worker", "kicad_version"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or value != value.strip():
                raise InvalidRequest(f"KiCad evidence {name} must be non-empty and trimmed")
        for name in ("operation", "project_id", "idempotency_key"):
            value = getattr(self, name)
            if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
                raise InvalidRequest(f"KiCad evidence {name} is not a stable identifier")
        revision = cast(object, self.expected_project_revision)
        if revision is not None and (
            not isinstance(revision, str)
            or re.fullmatch(r"rev_[0-9a-f]{64}", revision) is None
        ):
            raise InvalidRequest("KiCad evidence expected_project_revision is invalid")
        opened_digest = cast(object, self.opened_project_digest)
        if opened_digest is not None and (
            not isinstance(opened_digest, str)
            or _SHA256_PATTERN.fullmatch(opened_digest) is None
        ):
            raise InvalidRequest("KiCad evidence opened_project_digest is invalid")
        opened_bundle = cast(object, self.opened_bundle_sha256)
        if opened_bundle is not None and (
            not isinstance(opened_bundle, str)
            or _SHA256_PATTERN.fullmatch(opened_bundle) is None
        ):
            raise InvalidRequest("KiCad evidence opened_bundle_sha256 is invalid")
        runtime_support = cast(object, self.runtime_support_sha256)
        if runtime_support is not None and (
            not isinstance(runtime_support, str)
            or _SHA256_PATTERN.fullmatch(runtime_support) is None
        ):
            raise InvalidRequest("KiCad evidence runtime_support_sha256 is invalid")
        for name in ("request_digest", "payload_digest", "policy_digest"):
            value = getattr(self, name)
            if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
                raise InvalidRequest(f"KiCad evidence {name} must be a sha256 digest")
        exit_code = cast(object, self.exit_code)
        if isinstance(exit_code, bool) or not isinstance(exit_code, int):
            raise InvalidRequest("KiCad evidence exit_code must be an integer")


@dataclass(frozen=True, slots=True)
class KiCadImportApproval:
    """Trusted host proof authorizing one exact import subject."""

    receipt_id: str
    receipt_digest: str
    subject_digest: str
    decided_by: str

    def __post_init__(self) -> None:
        for name in ("receipt_id", "decided_by"):
            value = getattr(self, name)
            if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
                raise InvalidRequest(f"import approval {name} is not a stable identifier")
        for name in ("receipt_digest", "subject_digest"):
            value = getattr(self, name)
            if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
                raise InvalidRequest(f"import approval {name} must be a sha256 digest")


class KiCadImportApprovalVerifier(Protocol):
    """Host-owned verifier for a durable approval store."""

    def authorize_import(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadImportApproval: ...


@dataclass(frozen=True, slots=True)
class KiCadCommitAttestation:
    """Trusted proof that a gateway report is backed by exact KiCad checks."""

    project_id: str
    expected_project_revision: str
    expected_staged_revision: str
    verification_report_digest: str
    worker: str
    kicad_version: str
    policy_digest: str
    passed: bool

    def __post_init__(self) -> None:
        for name in ("project_id",):
            value = getattr(self, name)
            if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
                raise InvalidRequest(f"commit attestation {name} is invalid")
        for name in ("expected_project_revision", "expected_staged_revision"):
            value = getattr(self, name)
            if not isinstance(value, str) or re.fullmatch(r"rev_[0-9a-f]{64}", value) is None:
                raise InvalidRequest(f"commit attestation {name} is invalid")
        for name in ("verification_report_digest", "policy_digest"):
            value = getattr(self, name)
            if not isinstance(value, str) or _SHA256_PATTERN.fullmatch(value) is None:
                raise InvalidRequest(f"commit attestation {name} must be a sha256 digest")
        for name in ("worker", "kicad_version"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or value != value.strip():
                raise InvalidRequest(f"commit attestation {name} must be non-empty")
        if type(self.passed) is not bool:
            raise InvalidRequest("commit attestation passed must be a boolean")


class KiCadCommitAttestationVerifier(Protocol):
    """Host-owned lookup for durable, digest-bound verification evidence."""

    def attest_commit(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadCommitAttestation: ...


def kicad_import_subject_digest(arguments: Mapping[str, Any]) -> str:
    """Return the approval subject for an exact import request."""

    return stable_digest(
        {
            "operation": "kicad_import",
            "project_id": arguments.get("project_id"),
            "expected_project_revision": arguments.get("expected_project_revision"),
            "source_artifact_id": arguments.get("source_artifact_id"),
            "source_sha256": arguments.get("source_sha256"),
        }
    )


@dataclass(frozen=True, slots=True)
class KiCadServiceResult:
    """A real worker's outcome and deterministic evidence."""

    succeeded: bool
    payload: Mapping[str, Any]
    evidence: KiCadExecutionEvidence

    def __post_init__(self) -> None:
        if type(self.succeeded) is not bool:
            raise InvalidRequest("KiCad service succeeded must be a boolean")
        payload = cast(object, self.payload)
        if not isinstance(payload, Mapping):
            raise InvalidRequest("KiCad service payload must be an object")
        evidence = cast(object, self.evidence)
        if not isinstance(evidence, KiCadExecutionEvidence):
            raise InvalidRequest("KiCad service evidence has an invalid type")
        # Reject floats, non-string keys, and arbitrary objects at construction.
        canonical_data(self.payload)


class KiCadServiceFailure(RuntimeError):
    """Expected worker failure safe to return as a tool execution error."""

    def __init__(
        self,
        code: str,
        message: str,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class KiCadOperationService(Protocol):
    """Production hosts implement these methods with their KiCad worker."""

    def import_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult: ...

    def export_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult: ...

    def verify_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult: ...

    def render_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult: ...


@dataclass(frozen=True, slots=True)
class KiCadHookSpec:
    name: str
    method_name: str
    title: str
    description: str
    required_tier: CapabilityTier
    input_schema: Mapping[str, Any]
    payload_schema: Mapping[str, Any]
    read_only: bool
    destructive: bool
    requires_user: bool = False


_IMPORT_PAYLOAD = _object(
    {
        "project_id": _ID,
        "previous_project_revision": {"anyOf": [_REVISION, {"type": "null"}]},
        "project_revision": _REVISION,
        "source_artifact_id": _ID,
        "source_sha256": _SHA256,
    },
    (
        "project_id",
        "previous_project_revision",
        "project_revision",
        "source_artifact_id",
        "source_sha256",
    ),
)
_EXPORT_PAYLOAD = _object(
    {
        "project_id": _ID,
        "project_revision": _REVISION,
        "format": {"enum": ["kicad_archive", "gerber_bundle", "ipc2581"]},
        "artifact_id": _ID,
        "artifact_sha256": _SHA256,
        "artifact_path": {"type": "string", "minLength": 1},
    },
    ("project_id", "project_revision", "format", "artifact_id", "artifact_sha256"),
)
_RENDER_PAYLOAD = _object(
    {
        "project_id": _ID,
        "project_revision": _REVISION,
        "view": {"enum": ["schematic", "pcb_2d", "pcb_3d"]},
        "format": {"enum": ["png", "svg"]},
        "artifact_id": _ID,
        "artifact_sha256": _SHA256,
        "artifact_path": {"type": "string", "minLength": 1},
    },
    (
        "project_id",
        "project_revision",
        "view",
        "format",
        "artifact_id",
        "artifact_sha256",
    ),
)
_VERIFY_PAYLOAD = _object(
    {
        "project_id": _ID,
        "project_revision": _REVISION,
        "checks": {
            "type": "array",
            "minItems": 1,
            "maxItems": 2,
            "uniqueItems": True,
            "items": {"enum": ["erc", "drc"]},
        },
        "passed": {"type": "boolean"},
        "blocking_findings": {"type": "integer", "minimum": 0},
        "findings_digest": _SHA256,
        "report_digest": _SHA256,
    },
    (
        "project_id",
        "project_revision",
        "checks",
        "passed",
        "blocking_findings",
        "findings_digest",
        "report_digest",
    ),
)


KICAD_HOOKS: tuple[KiCadHookSpec, ...] = (
    KiCadHookSpec(
        "kicad_export",
        "export_project",
        "Export KiCad Project",
        "Ask the configured KiCad worker to export one exact project revision.",
        CapabilityTier.RELEASE,
        _object(
            {
                "project_id": _ID,
                "expected_project_revision": _REVISION,
                "format": {"enum": ["kicad_archive", "gerber_bundle", "ipc2581"]},
            },
            ("project_id", "expected_project_revision", "format"),
        ),
        _EXPORT_PAYLOAD,
        False,
        False,
    ),
    KiCadHookSpec(
        "kicad_import",
        "import_project",
        "Import KiCad Project",
        "Ask the configured KiCad worker to import a digest-pinned managed artifact.",
        CapabilityTier.RELEASE,
        _object(
            {
                "project_id": _ID,
                "expected_project_revision": {
                    "anyOf": [_REVISION, {"type": "null"}]
                },
                "source_artifact_id": _ID,
                "source_sha256": _SHA256,
                "approval_receipt_id": _ID,
            },
            (
                "project_id",
                "expected_project_revision",
                "source_artifact_id",
                "source_sha256",
                "approval_receipt_id",
            ),
        ),
        _IMPORT_PAYLOAD,
        False,
        True,
        True,
    ),
    KiCadHookSpec(
        "kicad_render",
        "render_project",
        "Render KiCad Project",
        "Ask the configured KiCad worker to render one exact project revision.",
        CapabilityTier.READ,
        _object(
            {
                "project_id": _ID,
                "expected_project_revision": _REVISION,
                "view": {"enum": ["schematic", "pcb_2d", "pcb_3d"]},
                "format": {"enum": ["png", "svg"]},
            },
            ("project_id", "expected_project_revision", "view", "format"),
        ),
        _RENDER_PAYLOAD,
        False,
        False,
    ),
    KiCadHookSpec(
        "kicad_verify",
        "verify_project",
        "Verify KiCad Project",
        "Run configured deterministic KiCad ERC/DRC checks for an exact revision.",
        CapabilityTier.STAGE,
        _object(
            {
                "project_id": _ID,
                "expected_project_revision": _REVISION,
                "checks": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 2,
                    "uniqueItems": True,
                    "items": {"enum": ["erc", "drc"]},
                },
            },
            ("project_id", "expected_project_revision", "checks"),
        ),
        _VERIFY_PAYLOAD,
        True,
        False,
    ),
)

KICAD_HOOK_BY_NAME = {hook.name: hook for hook in KICAD_HOOKS}

def kicad_hook_output_schema(hook: KiCadHookSpec) -> Mapping[str, Any]:
    """Return the closed result schema for one operation-specific payload."""

    return _object(
        {
        "tool_name": {"type": "string"},
        "succeeded": {"type": "boolean"},
        "payload": hook.payload_schema,
        "evidence": _object(
            {
                "worker": {"type": "string", "minLength": 1},
                "kicad_version": {"type": "string", "minLength": 1},
                "operation": _ID,
                "project_id": _ID,
                "expected_project_revision": {
                    "anyOf": [_REVISION, {"type": "null"}]
                },
                "opened_project_digest": {
                    "anyOf": [_SHA256, {"type": "null"}]
                },
                "opened_bundle_sha256": {
                    "anyOf": [_SHA256, {"type": "null"}]
                },
                "runtime_support_sha256": {
                    "anyOf": [_SHA256, {"type": "null"}]
                },
                "request_digest": _SHA256,
                "payload_digest": _SHA256,
                "policy_digest": _SHA256,
                "idempotency_key": _ID,
                "exit_code": {"type": "integer"},
            },
            (
                "worker",
                "kicad_version",
                "operation",
                "project_id",
                "expected_project_revision",
                "opened_project_digest",
                "opened_bundle_sha256",
                "runtime_support_sha256",
                "request_digest",
                "payload_digest",
                "policy_digest",
                "idempotency_key",
                "exit_code",
            ),
        ),
        "authorization": {
            "anyOf": [
                {"type": "null"},
                _object(
                    {
                        "receipt_id": _ID,
                        "receipt_digest": _SHA256,
                        "subject_digest": _SHA256,
                        "decided_by": _ID,
                    },
                    ("receipt_id", "receipt_digest", "subject_digest", "decided_by"),
                ),
            ]
        },
        "result_digest": _SHA256,
        },
        (
            "tool_name",
            "succeeded",
            "payload",
            "evidence",
            "authorization",
            "result_digest",
        ),
    )

"""Immutable records for restart-safe KiCad import candidates.

The records deliberately contain managed artifact identities and canonical JSON
only.  Raw artifact bytes, host paths, worker commands, and release claims are
outside this boundary.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from enum import Enum
from typing import Any, ClassVar, Mapping, TypeAlias

from backend.interchange_artifacts import ArtifactKind

_PUBLIC_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")
_ARTIFACT_ID = re.compile(r"artifact_[0-9a-f]{32}")
_CANDIDATE_ID = re.compile(r"import_candidate_[0-9a-f]{32}")
_REVISION = re.compile(r"[0-9a-f]{64}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_ZERO_DIGEST = "0" * 64
_IDENTITY_DOMAIN = "flux-clone.kicad-import-candidate.identity.v1"
_LEGACY_PAYLOAD_DOMAIN = "flux-clone.kicad-import-candidate.inspection-payload.v1"
_DIAGNOSTICS_DOMAIN = "flux-clone.kicad-import-candidate.diagnostics.v1"
_BLOCKERS_DOMAIN = "flux-clone.kicad-import-candidate.blockers.v1"
_EVENT_DOMAIN = "flux-clone.kicad-import-candidate.event.v1"
_MANAGED_DIAGNOSTIC_DOMAIN = (
    "flux-clone.kicad-import-candidate.managed-diagnostic.v1"
)
_MANAGED_BLOCKER_DOMAIN = "flux-clone.kicad-import-candidate.managed-blocker.v1"
_MANAGED_RECEIPT_DOMAIN = b"flux-clone-kicad-inspection-receipt-v1\0"
_FORBIDDEN_CAPABILITY_KEYS = {
    "args",
    "argv",
    "base64",
    "bytes",
    "command",
    "content",
    "cwd",
    "destination",
    "env",
    "executable",
    "filePath",
    "file_path",
    "hostPath",
    "host_path",
    "inputPath",
    "input_path",
    "outputPath",
    "output_path",
    "overwrite",
    "recursive",
    "script",
    "shell",
    "sourceUrl",
    "source_url",
    "uri",
    "url",
}
_PATH_VALUE_KEYS = {"path", "sourcePath", "source_path"}
_URI_LOCATION = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
_FILE_URI_LOCATION = re.compile(r"file:", re.IGNORECASE)
_WINDOWS_DRIVE_LOCATION = re.compile(r"[A-Za-z]:")
_TRAVERSAL_LOCATION = re.compile(r"(?:^|[\\/])\.\.(?:[\\/]|$)")
_LOGICAL_DIAGNOSTIC_PATH = re.compile(
    r"\$?[A-Za-z_][A-Za-z0-9_-]*(?:\[[0-9]+\])?"
    r"(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[[0-9]+\])?)*"
)
_INSPECTION_FALSE_FIELDS = {
    "canonicalImportEligible",
    "canonical_import_eligible",
    "downloadEligible",
    "download_eligible",
    "manufacturingReleaseEligible",
    "manufacturing_release_eligible",
    "mutatesDesign",
    "mutates_design",
    "stageEligible",
    "stage_eligible",
}
_INSPECTION_NOT_RUN_FIELDS = {
    "kicadChecks",
    "kicadExecution",
    "kicad_checks",
    "kicad_execution",
    "nativeChecks",
    "native_checks",
}
_INSPECTION_BLOCKED_FIELDS = {"canonicalMapping", "canonical_mapping"}
_INSPECTION_NOT_EVALUATED_FIELDS = {"engineAgreement", "engine_agreement"}
_MANAGED_INSPECTION_FIELDS = {
    "canonicalImportBlockers",
    "canonicalImportEligible",
    "coordinationContextDigest",
    "counts",
    "diagnostics",
    "evidence",
    "expectedProjectRevision",
    "format",
    "inspectionPayloadSha256",
    "inspectionReceiptDigest",
    "inspectionReceiptId",
    "kicadExecution",
    "manufacturingReleaseEligible",
    "mode",
    "mutatesDesign",
    "outlineVerticesNm",
    "projectId",
    "projectRevision",
    "runId",
    "runRevision",
    "source",
    "stageEligible",
    "truth",
}
_MANAGED_RECEIPT_METADATA_FIELDS = {
    "inspectionPayloadSha256",
    "inspectionReceiptDigest",
    "inspectionReceiptId",
}
_MANAGED_SOURCE_FIELDS = {"artifactId", "kind", "sha256", "sizeBytes"}
_MANAGED_DIAGNOSTIC_FIELDS = {
    "constructSha256",
    "disposition",
    "head",
    "path",
    "reason",
    "scope",
}
_MANAGED_TRUTH_FIELDS = {
    "canonicalMapping",
    "codecParse",
    "diagnosticsRoundTrip",
    "downloadEligible",
    "engineAgreement",
    "kicadChecks",
    "kicadExecution",
    "manufacturingReleaseEligible",
    "nativeChecks",
    "semanticRoundTrip",
}
_PCB_EVIDENCE_FIELDS = {
    "diagnosticsParity",
    "evidenceSha256",
    "exportedSha256",
    "importedIrSha256",
    "importedManifestSha256",
    "reparsedIrSha256",
    "reparsedManifestSha256",
    "semanticParity",
    "sourceSha256",
}
_PROJECT_EVIDENCE_FIELDS = {
    "boardExportSha256",
    "boardImportedIrSha256",
    "boardSemanticParity",
    "boardSourceSha256",
    "bundleImportedIrSha256",
    "bundleReparsedIrSha256",
    "diagnosticsManifestSha256",
    "diagnosticsParity",
    "evidenceSha256",
    "kicadExecution",
    "manufacturingReleaseEligible",
    "parserId",
    "projectExportSha256",
    "projectImportedIrSha256",
    "projectSemanticParity",
    "projectSourceSha256",
    "schematicExportSha256",
    "schematicImportedIrSha256",
    "schematicSemanticParity",
    "schematicSourceSha256",
    "semanticParity",
    "sourceSha256",
}

JsonScalar: TypeAlias = None | bool | int | str
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]


class CandidateRepositoryError(RuntimeError):
    """Base failure with a stable application-facing code."""

    code: ClassVar[str] = "import_candidate_repository_error"


class InvalidCandidate(CandidateRepositoryError):
    code = "invalid_import_candidate"


class CandidateNotFound(CandidateRepositoryError):
    code = "import_candidate_not_found"


class CandidateConcurrencyConflict(CandidateRepositoryError):
    code = "import_candidate_revision_conflict"


class IllegalCandidateTransition(CandidateRepositoryError):
    code = "illegal_import_candidate_transition"


class CandidateIntegrityError(CandidateRepositoryError):
    code = "import_candidate_integrity_error"


class CandidateStoreUnavailable(CandidateRepositoryError):
    code = "import_candidate_store_unavailable"


class UnsupportedCandidateStoreSchema(CandidateRepositoryError):
    code = "import_candidate_store_schema_unsupported"


class CandidateState(str, Enum):
    PENDING = "pending"
    RESOLVED = "resolved"
    STAGED = "staged"
    REJECTED = "rejected"
    INVALIDATED = "invalidated"


class CandidateIdentityScheme(str, Enum):
    LEGACY_V2 = "legacy-v2-domain-payload-digest"
    CURRENT = "v3-plain-payload-sha256"


class DiagnosticSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    BLOCKER = "blocker"


class CandidateEventKind(str, Enum):
    CREATED = "created"
    TRANSITIONED = "transitioned"
    MIGRATED = "migrated"


LEGAL_TRANSITIONS: Mapping[CandidateState, frozenset[CandidateState]] = {
    CandidateState.PENDING: frozenset(
        {
            CandidateState.RESOLVED,
            CandidateState.REJECTED,
            CandidateState.INVALIDATED,
        }
    ),
    CandidateState.RESOLVED: frozenset(
        {
            CandidateState.STAGED,
            CandidateState.REJECTED,
            CandidateState.INVALIDATED,
        }
    ),
    CandidateState.STAGED: frozenset({CandidateState.INVALIDATED}),
    CandidateState.REJECTED: frozenset(),
    CandidateState.INVALIDATED: frozenset(),
}


def _require_public_id(value: object, label: str) -> str:
    if not isinstance(value, str) or _PUBLIC_ID.fullmatch(value) is None:
        raise InvalidCandidate(f"{label} must be a canonical public identifier")
    return value


def _require_artifact_id(value: object) -> str:
    if not isinstance(value, str) or _ARTIFACT_ID.fullmatch(value) is None:
        raise InvalidCandidate("managed artifact ID is invalid")
    return value


def _require_candidate_id(value: object) -> str:
    if not isinstance(value, str) or _CANDIDATE_ID.fullmatch(value) is None:
        raise InvalidCandidate("import candidate ID is invalid")
    return value


def _require_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise InvalidCandidate(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_revision(value: object, label: str) -> str:
    if not isinstance(value, str) or _REVISION.fullmatch(value) is None:
        raise InvalidCandidate(
            f"{label} must be an exact lowercase SHA-256 revision"
        )
    return value


def _require_nonnegative_int(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise InvalidCandidate(f"{label} must be a non-negative integer")
    return value


def _require_text(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or unicodedata.normalize("NFC", value) != value
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise InvalidCandidate(f"{label} must be non-empty canonical text")
    return value


def _require_time(value: object, label: str) -> datetime:
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() is None
    ):
        raise InvalidCandidate(f"{label} must be timezone-aware")
    return value


def canonical_data(value: Any) -> JsonValue:
    """Return JSON-only canonical data and reject floats, bytes, and objects."""

    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        raise InvalidCandidate("inspection payload cannot contain floating-point values")
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise InvalidCandidate("inspection payload object keys must be strings")
        return {key: canonical_data(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [canonical_data(item) for item in value]
    raise InvalidCandidate("inspection payload contains a non-JSON value")


def canonical_json(value: Any) -> str:
    return json.dumps(
        canonical_data(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _canonical_field_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return re.sub(r"[^a-z0-9]", "", normalized)


_FORBIDDEN_CANONICAL_KEYS = {
    _canonical_field_name(key) for key in _FORBIDDEN_CAPABILITY_KEYS
}
_PATH_VALUE_CANONICAL_KEYS = {
    _canonical_field_name(key) for key in _PATH_VALUE_KEYS
} | {
    "destinationlocation",
    "filepath",
    "hostlocation",
    "hostpath",
    "inputlocation",
    "inputpath",
    "location",
    "outputlocation",
    "outputpath",
    "sourcelocation",
}


def _is_unambiguous_host_location(value: str) -> bool:
    return (
        _URI_LOCATION.match(value) is not None
        or _FILE_URI_LOCATION.match(value) is not None
        or _WINDOWS_DRIVE_LOCATION.match(value) is not None
        or _TRAVERSAL_LOCATION.search(value) is not None
        or value.startswith(("/", "\\", "~"))
    )


def _validate_inspection_payload_safety(value: JsonValue) -> None:
    if isinstance(value, list):
        for item in value:
            _validate_inspection_payload_safety(item)
        return
    if not isinstance(value, dict):
        return
    is_managed_diagnostic = set(value) == _MANAGED_DIAGNOSTIC_FIELDS
    forbidden = {
        key
        for key in value
        if _canonical_field_name(key) in _FORBIDDEN_CANONICAL_KEYS
    }
    if forbidden:
        names = ", ".join(sorted(forbidden))
        raise InvalidCandidate(
            f"inspection payload contains forbidden capability field(s): {names}"
        )
    for key in _INSPECTION_FALSE_FIELDS:
        if key in value and value[key] is not False:
            raise InvalidCandidate(
                f"inspection-only field {key} must be exactly false"
            )
    for key in _INSPECTION_NOT_RUN_FIELDS:
        if key in value and value[key] != "not-run":
            raise InvalidCandidate(
                f"inspection-only field {key} must be exactly 'not-run'"
            )
    for key in _INSPECTION_BLOCKED_FIELDS:
        if key in value and value[key] != "blocked":
            raise InvalidCandidate(
                f"inspection-only field {key} must be exactly 'blocked'"
            )
    for key in _INSPECTION_NOT_EVALUATED_FIELDS:
        if key in value and value[key] != "not-evaluated":
            raise InvalidCandidate(
                f"inspection-only field {key} must be exactly 'not-evaluated'"
            )
    for key, item in value.items():
        canonical_key = _canonical_field_name(key)
        location_value = (
            unicodedata.normalize("NFKC", item).strip()
            if isinstance(item, str)
            else None
        )
        logical_diagnostic_path = (
            is_managed_diagnostic
            and key == "path"
            and isinstance(item, str)
            and _LOGICAL_DIAGNOSTIC_PATH.fullmatch(location_value) is not None
        )
        if canonical_key in _PATH_VALUE_CANONICAL_KEYS and not (
            logical_diagnostic_path
        ):
            raise InvalidCandidate(
                "inspection payload path fields are limited to managed diagnostics"
            )
        if (
            isinstance(item, str)
            and _is_unambiguous_host_location(location_value)
        ):
            raise InvalidCandidate(
                "inspection payload cannot contain a host path or URL"
            )
    for item in value.values():
        _validate_inspection_payload_safety(item)


def _managed_receipt_digest(
    *,
    artifact_id: str,
    source_sha256: str,
    project_id: str,
    project_revision: str,
    run_id: str,
    run_revision: int,
    inspection_payload_sha256: str,
) -> str:
    material = canonical_json(
        {
            "artifact_id": artifact_id,
            "inspection_payload_sha256": inspection_payload_sha256,
            "project_id": project_id,
            "project_revision": project_revision,
            "run_id": run_id,
            "run_revision": run_revision,
            "source_sha256": source_sha256,
        }
    )
    return hashlib.sha256(
        _MANAGED_RECEIPT_DOMAIN + material.encode("utf-8")
    ).hexdigest()


def _validate_managed_truth(value: JsonValue) -> None:
    if not isinstance(value, dict) or set(value) != _MANAGED_TRUTH_FIELDS:
        raise InvalidCandidate("managed inspection truth fields are not exact")
    if value["codecParse"] != "passed":
        raise InvalidCandidate("managed inspection codec parse must be passed")
    for key in ("semanticRoundTrip", "diagnosticsRoundTrip"):
        if value[key] not in {"passed", "failed"}:
            raise InvalidCandidate(f"managed inspection truth field {key} is invalid")
    expected: dict[str, JsonScalar] = {
        "canonicalMapping": "blocked",
        "downloadEligible": False,
        "engineAgreement": "not-evaluated",
        "kicadChecks": "not-run",
        "kicadExecution": "not-run",
        "manufacturingReleaseEligible": False,
        "nativeChecks": "not-run",
    }
    for key, expected_value in expected.items():
        actual = value[key]
        if isinstance(expected_value, bool):
            matches = actual is expected_value
        else:
            matches = type(actual) is str and actual == expected_value
        if not matches:
            raise InvalidCandidate(
                "managed inspection truth exceeds inspection-only authority"
            )


def _validate_managed_nested_evidence(
    *,
    artifact_kind: ArtifactKind,
    format_payload: JsonValue,
    counts_payload: JsonValue,
    evidence_payload: JsonValue,
) -> None:
    project_bundle = artifact_kind is ArtifactKind.KICAD_PROJECT_BUNDLE
    evidence_fields = (
        _PROJECT_EVIDENCE_FIELDS if project_bundle else _PCB_EVIDENCE_FIELDS
    )
    if (
        not isinstance(format_payload, dict)
        or format_payload.get("kind") != artifact_kind.value
    ):
        raise InvalidCandidate(
            "managed inspection format contradicts the candidate artifact kind"
        )
    if not isinstance(counts_payload, dict) or not counts_payload:
        raise InvalidCandidate("managed inspection counts are malformed")
    for key, count in counts_payload.items():
        _require_nonnegative_int(
            count, f"managed inspection count {key}"
        )
    if not isinstance(evidence_payload, dict) or set(evidence_payload) != evidence_fields:
        raise InvalidCandidate("managed inspection evidence fields are not exact")
    digest_fields = evidence_fields - {
        "diagnosticsParity",
        "kicadExecution",
        "manufacturingReleaseEligible",
        "parserId",
        "projectSemanticParity",
        "schematicSemanticParity",
        "boardSemanticParity",
        "semanticParity",
    }
    for key in sorted(digest_fields):
        _require_sha256(evidence_payload[key], f"managed inspection evidence {key}")
    parity_fields = {"diagnosticsParity", "semanticParity"}
    if project_bundle:
        parity_fields.update(
            {
                "boardSemanticParity",
                "projectSemanticParity",
                "schematicSemanticParity",
            }
        )
    for key in parity_fields:
        if type(evidence_payload[key]) is not bool:
            raise InvalidCandidate(
                f"managed inspection evidence {key} must be an exact boolean"
            )
    if project_bundle:
        _require_public_id(evidence_payload["parserId"], "managed parser ID")
        if evidence_payload["kicadExecution"] != "not-run":
            raise InvalidCandidate(
                "managed inspection evidence cannot claim KiCad execution"
            )
        if evidence_payload["manufacturingReleaseEligible"] is not False:
            raise InvalidCandidate(
                "managed inspection evidence cannot authorize manufacturing release"
            )


def _digest(value: Any, *, domain: str) -> str:
    material = canonical_json({"domain": domain, "value": canonical_data(value)})
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True, order=True)
class CandidateDiagnostic:
    diagnostic_id: str
    code: str
    severity: DiagnosticSeverity
    scope: str
    message: str
    evidence_digest: str
    entity_id: str | None = None

    def __post_init__(self) -> None:
        _require_public_id(self.diagnostic_id, "diagnostic ID")
        _require_public_id(self.code, "diagnostic code")
        if not isinstance(self.severity, DiagnosticSeverity):
            raise InvalidCandidate("diagnostic severity is invalid")
        _require_text(self.scope, "diagnostic scope")
        _require_text(self.message, "diagnostic message")
        _require_sha256(self.evidence_digest, "diagnostic evidence digest")
        if self.entity_id is not None:
            _require_public_id(self.entity_id, "diagnostic entity ID")

    def payload(self) -> dict[str, JsonValue]:
        return {
            "code": self.code,
            "diagnostic_id": self.diagnostic_id,
            "entity_id": self.entity_id,
            "evidence_digest": self.evidence_digest,
            "message": self.message,
            "scope": self.scope,
            "severity": self.severity.value,
        }


@dataclass(frozen=True, slots=True, order=True)
class CandidateBlocker:
    blocker_id: str
    code: str
    message: str
    evidence_digest: str
    entity_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_public_id(self.blocker_id, "blocker ID")
        _require_public_id(self.code, "blocker code")
        _require_text(self.message, "blocker message")
        _require_sha256(self.evidence_digest, "blocker evidence digest")
        if (
            not isinstance(self.entity_ids, tuple)
            or tuple(sorted(set(self.entity_ids))) != self.entity_ids
        ):
            raise InvalidCandidate("blocker entity IDs must be a sorted unique tuple")
        for entity_id in self.entity_ids:
            _require_public_id(entity_id, "blocker entity ID")

    def payload(self) -> dict[str, JsonValue]:
        return {
            "blocker_id": self.blocker_id,
            "code": self.code,
            "entity_ids": list(self.entity_ids),
            "evidence_digest": self.evidence_digest,
            "message": self.message,
        }


def _diagnostics_from_managed_receipt(
    value: JsonValue,
) -> tuple[CandidateDiagnostic, ...]:
    if not isinstance(value, list):
        raise InvalidCandidate("managed inspection diagnostics must be an array")
    diagnostics: list[CandidateDiagnostic] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != _MANAGED_DIAGNOSTIC_FIELDS:
            raise InvalidCandidate(
                "managed inspection diagnostic fields do not match the closed schema"
            )
        scope = _require_text(item["scope"], "managed diagnostic scope")
        _require_text(item["path"], "managed diagnostic path")
        _require_text(item["head"], "managed diagnostic head")
        reason = _require_text(item["reason"], "managed diagnostic reason")
        disposition = item["disposition"]
        if disposition not in {"preserved", "unsupported"}:
            raise InvalidCandidate("managed diagnostic disposition is invalid")
        construct_sha256 = _require_sha256(
            item["constructSha256"], "managed diagnostic construct digest"
        )
        diagnostic_digest = _digest(item, domain=_MANAGED_DIAGNOSTIC_DOMAIN)
        diagnostics.append(
            CandidateDiagnostic(
                diagnostic_id=f"diagnostic-{diagnostic_digest[:32]}",
                code=f"kicad-construct-{disposition}",
                severity=(
                    DiagnosticSeverity.BLOCKER
                    if disposition == "unsupported"
                    else DiagnosticSeverity.INFO
                ),
                scope=scope,
                message=reason,
                evidence_digest=construct_sha256,
            )
        )
    result = tuple(sorted(diagnostics, key=lambda item: item.diagnostic_id))
    return _validate_diagnostics(result)


def _blockers_from_managed_receipt(
    value: JsonValue,
) -> tuple[CandidateBlocker, ...]:
    if not isinstance(value, list):
        raise InvalidCandidate("canonical import blockers must be an array")
    blockers: list[CandidateBlocker] = []
    for item in value:
        message = _require_text(item, "canonical import blocker")
        blocker_digest = _digest(message, domain=_MANAGED_BLOCKER_DOMAIN)
        blockers.append(
            CandidateBlocker(
                blocker_id=f"blocker-{blocker_digest[:32]}",
                code="canonical-import-blocker",
                message=message,
                evidence_digest=blocker_digest,
            )
        )
    result = tuple(sorted(blockers, key=lambda item: item.blocker_id))
    return _validate_blockers(result)


def _validate_diagnostics(value: object) -> tuple[CandidateDiagnostic, ...]:
    if not isinstance(value, tuple) or any(
        not isinstance(item, CandidateDiagnostic) for item in value
    ):
        raise InvalidCandidate("candidate diagnostics must be an immutable tuple")
    identities = tuple(item.diagnostic_id for item in value)
    if identities != tuple(sorted(set(identities))):
        raise InvalidCandidate("candidate diagnostics must be sorted and unique by ID")
    return value


def _validate_blockers(value: object) -> tuple[CandidateBlocker, ...]:
    if not isinstance(value, tuple) or any(
        not isinstance(item, CandidateBlocker) for item in value
    ):
        raise InvalidCandidate("candidate blockers must be an immutable tuple")
    identities = tuple(item.blocker_id for item in value)
    if identities != tuple(sorted(set(identities))):
        raise InvalidCandidate("candidate blockers must be sorted and unique by ID")
    return value


@dataclass(frozen=True, slots=True)
class ImportCandidateDraft:
    """Complete immutable identity material supplied by an inspection service."""

    artifact_id: str
    artifact_sha256: str
    artifact_kind: ArtifactKind
    project_id: str
    expected_project_revision: str
    run_id: str
    expected_run_revision: int
    inspection_payload_json: str
    inspection_receipt_digest: str
    diagnostics: tuple[CandidateDiagnostic, ...]
    blockers: tuple[CandidateBlocker, ...]
    created_by: str
    identity_scheme: CandidateIdentityScheme = CandidateIdentityScheme.CURRENT

    def __post_init__(self) -> None:
        _require_artifact_id(self.artifact_id)
        _require_sha256(self.artifact_sha256, "managed artifact SHA-256")
        if not isinstance(self.artifact_kind, ArtifactKind):
            raise InvalidCandidate("managed artifact kind is invalid")
        _require_public_id(self.project_id, "project ID")
        _require_revision(self.expected_project_revision, "expected project revision")
        _require_public_id(self.run_id, "run ID")
        _require_nonnegative_int(self.expected_run_revision, "expected run revision")
        if not isinstance(self.inspection_payload_json, str):
            raise InvalidCandidate("inspection payload must be canonical JSON text")
        try:
            decoded = json.loads(self.inspection_payload_json)
        except (TypeError, json.JSONDecodeError) as exc:
            raise InvalidCandidate("inspection payload is not valid JSON") from exc
        if not isinstance(decoded, dict) or not decoded:
            raise InvalidCandidate("inspection payload must be a non-empty JSON object")
        canonical = canonical_data(decoded)
        _validate_inspection_payload_safety(canonical)
        if canonical_json(canonical) != self.inspection_payload_json:
            raise InvalidCandidate("inspection payload must use canonical JSON encoding")
        _require_sha256(self.inspection_receipt_digest, "inspection receipt digest")
        _validate_diagnostics(self.diagnostics)
        _validate_blockers(self.blockers)
        _require_public_id(self.created_by, "candidate creator")
        if not isinstance(self.identity_scheme, CandidateIdentityScheme):
            raise InvalidCandidate("candidate identity scheme is invalid")

    @classmethod
    def from_payload(
        cls,
        *,
        artifact_id: str,
        artifact_sha256: str,
        artifact_kind: ArtifactKind,
        project_id: str,
        expected_project_revision: str,
        run_id: str,
        expected_run_revision: int,
        inspection_payload: Mapping[str, Any],
        inspection_receipt_digest: str,
        diagnostics: tuple[CandidateDiagnostic, ...],
        blockers: tuple[CandidateBlocker, ...],
        created_by: str,
    ) -> ImportCandidateDraft:
        return cls(
            artifact_id,
            artifact_sha256,
            artifact_kind,
            project_id,
            expected_project_revision,
            run_id,
            expected_run_revision,
            canonical_json(inspection_payload),
            inspection_receipt_digest,
            diagnostics,
            blockers,
            created_by,
        )

    @classmethod
    def from_managed_inspection(
        cls,
        *,
        artifact_id: str,
        artifact_sha256: str,
        artifact_kind: ArtifactKind,
        project_id: str,
        expected_project_revision: str,
        run_id: str,
        expected_run_revision: int,
        managed_inspection: Mapping[str, Any],
        created_by: str,
    ) -> ImportCandidateDraft:
        """Decode the closed managed-inspection receipt into a bound draft.

        The application response carries three derived receipt metadata fields.
        They are verified here, while the exact canonical pre-metadata payload is
        persisted as the candidate inspection payload.
        """

        _require_artifact_id(artifact_id)
        _require_sha256(artifact_sha256, "managed artifact SHA-256")
        if not isinstance(artifact_kind, ArtifactKind):
            raise InvalidCandidate("managed artifact kind is invalid")
        _require_public_id(project_id, "project ID")
        _require_revision(expected_project_revision, "expected project revision")
        _require_public_id(run_id, "run ID")
        _require_nonnegative_int(expected_run_revision, "expected run revision")

        canonical = canonical_data(managed_inspection)
        if not isinstance(canonical, dict) or set(canonical) != _MANAGED_INSPECTION_FIELDS:
            raise InvalidCandidate(
                "managed inspection response fields do not match the closed schema"
            )
        _validate_inspection_payload_safety(canonical)
        source = canonical["source"]
        if not isinstance(source, dict) or set(source) != _MANAGED_SOURCE_FIELDS:
            raise InvalidCandidate("managed inspection source fields are not exact")
        source_size = _require_nonnegative_int(
            source["sizeBytes"], "managed artifact size"
        )
        if source_size == 0:
            raise InvalidCandidate("managed artifact size must be positive")
        if (
            source["artifactId"] != artifact_id
            or source["sha256"] != artifact_sha256
            or source["kind"] != artifact_kind.value
        ):
            raise InvalidCandidate(
                "managed inspection source contradicts the candidate artifact"
            )
        if (
            canonical["projectId"] != project_id
            or canonical["expectedProjectRevision"] != expected_project_revision
            or canonical["projectRevision"] != expected_project_revision
        ):
            raise InvalidCandidate(
                "managed inspection context contradicts the candidate project"
            )
        _require_nonnegative_int(canonical["runRevision"], "inspection run revision")
        if (
            canonical["runId"] != run_id
            or canonical["runRevision"] != expected_run_revision
        ):
            raise InvalidCandidate(
                "managed inspection context contradicts the candidate run"
            )
        _require_sha256(
            canonical["coordinationContextDigest"],
            "coordination context digest",
        )
        if canonical["mode"] != "inspection-only":
            raise InvalidCandidate("managed inspection mode must be inspection-only")
        _validate_managed_truth(canonical["truth"])
        blockers_payload = canonical["canonicalImportBlockers"]
        if not isinstance(blockers_payload, list) or not blockers_payload:
            raise InvalidCandidate(
                "managed inspection must contain an explicit canonical blocker"
            )
        counts_payload = canonical["counts"]
        outline = canonical["outlineVerticesNm"]
        if not isinstance(outline, list) or any(
            not isinstance(point, list)
            or len(point) != 2
            or any(
                not isinstance(coordinate, int) or isinstance(coordinate, bool)
                for coordinate in point
            )
            for point in outline
        ):
            raise InvalidCandidate("managed inspection outline vertices are malformed")
        format_payload = canonical["format"]
        evidence_payload = canonical["evidence"]
        _validate_managed_nested_evidence(
            artifact_kind=artifact_kind,
            format_payload=format_payload,
            counts_payload=counts_payload,
            evidence_payload=evidence_payload,
        )
        assert isinstance(evidence_payload, dict)
        if evidence_payload["sourceSha256"] != artifact_sha256:
            raise InvalidCandidate(
                "managed inspection evidence contradicts the candidate artifact"
            )

        inspection_payload_sha256 = _require_sha256(
            canonical["inspectionPayloadSha256"],
            "inspection payload SHA-256",
        )
        inspection_receipt_digest = _require_sha256(
            canonical["inspectionReceiptDigest"],
            "inspection receipt digest",
        )
        receipt_id = canonical["inspectionReceiptId"]
        if receipt_id != f"inspection_{inspection_receipt_digest[:32]}":
            raise InvalidCandidate(
                "inspection receipt ID does not derive from its digest"
            )
        receipt_payload = {
            key: value
            for key, value in canonical.items()
            if key not in _MANAGED_RECEIPT_METADATA_FIELDS
        }
        inspection_payload_json = canonical_json(receipt_payload)
        recomputed_payload_sha256 = hashlib.sha256(
            inspection_payload_json.encode("utf-8")
        ).hexdigest()
        if inspection_payload_sha256 != recomputed_payload_sha256:
            raise InvalidCandidate(
                "inspection payload SHA-256 does not match the canonical receipt body"
            )
        recomputed_receipt_digest = _managed_receipt_digest(
            artifact_id=artifact_id,
            source_sha256=artifact_sha256,
            project_id=project_id,
            project_revision=expected_project_revision,
            run_id=run_id,
            run_revision=expected_run_revision,
            inspection_payload_sha256=inspection_payload_sha256,
        )
        if inspection_receipt_digest != recomputed_receipt_digest:
            raise InvalidCandidate(
                "inspection receipt digest does not match its bound subjects"
            )
        diagnostics = _diagnostics_from_managed_receipt(canonical["diagnostics"])
        blockers = _blockers_from_managed_receipt(blockers_payload)
        return cls(
            artifact_id,
            artifact_sha256,
            artifact_kind,
            project_id,
            expected_project_revision,
            run_id,
            expected_run_revision,
            inspection_payload_json,
            inspection_receipt_digest,
            diagnostics,
            blockers,
            created_by,
        )

    @property
    def inspection_payload_sha256(self) -> str:
        """Plain SHA-256 used by the managed inspection receipt protocol."""

        return hashlib.sha256(self.inspection_payload_json.encode("utf-8")).hexdigest()

    @property
    def inspection_payload_digest(self) -> str:
        """Versioned immutable-identity digest; not always the receipt SHA."""

        if self.identity_scheme is CandidateIdentityScheme.LEGACY_V2:
            return _digest(
                json.loads(self.inspection_payload_json),
                domain=_LEGACY_PAYLOAD_DOMAIN,
            )
        return self.inspection_payload_sha256

    @property
    def diagnostics_digest(self) -> str:
        return _digest(
            [item.payload() for item in self.diagnostics], domain=_DIAGNOSTICS_DOMAIN
        )

    @property
    def blockers_digest(self) -> str:
        return _digest([item.payload() for item in self.blockers], domain=_BLOCKERS_DOMAIN)

    def identity_payload(self) -> dict[str, JsonValue]:
        return {
            "artifact": {
                "artifact_id": self.artifact_id,
                "kind": self.artifact_kind.value,
                "sha256": self.artifact_sha256,
            },
            "blockers": [item.payload() for item in self.blockers],
            "diagnostics": [item.payload() for item in self.diagnostics],
            "inspection_payload_digest": self.inspection_payload_digest,
            "inspection_receipt_digest": self.inspection_receipt_digest,
            "project": {
                "expected_revision": self.expected_project_revision,
                "project_id": self.project_id,
            },
            "run": {
                "expected_revision": self.expected_run_revision,
                "run_id": self.run_id,
            },
        }

    @property
    def candidate_digest(self) -> str:
        return _digest(self.identity_payload(), domain=_IDENTITY_DOMAIN)

    @property
    def candidate_id(self) -> str:
        return f"import_candidate_{self.candidate_digest[:32]}"


@dataclass(frozen=True, slots=True)
class ImportCandidate:
    candidate_id: str
    candidate_digest: str
    identity_scheme: CandidateIdentityScheme
    artifact_id: str
    artifact_sha256: str
    artifact_kind: ArtifactKind
    project_id: str
    expected_project_revision: str
    run_id: str
    expected_run_revision: int
    inspection_payload_json: str
    inspection_payload_digest: str
    inspection_receipt_digest: str
    diagnostics: tuple[CandidateDiagnostic, ...]
    blockers: tuple[CandidateBlocker, ...]
    created_by: str
    state: CandidateState
    generation: int
    resolution_receipt_digest: str | None
    stage_receipt_digest: str | None
    terminal_reason: str | None
    created_at: datetime
    updated_at: datetime
    last_event_digest: str

    def __post_init__(self) -> None:
        _require_candidate_id(self.candidate_id)
        _require_sha256(self.candidate_digest, "candidate digest")
        draft = ImportCandidateDraft(
            self.artifact_id,
            self.artifact_sha256,
            self.artifact_kind,
            self.project_id,
            self.expected_project_revision,
            self.run_id,
            self.expected_run_revision,
            self.inspection_payload_json,
            self.inspection_receipt_digest,
            self.diagnostics,
            self.blockers,
            self.created_by,
            self.identity_scheme,
        )
        if self.inspection_payload_digest != draft.inspection_payload_digest:
            raise CandidateIntegrityError("inspection payload digest does not match its body")
        if self.candidate_digest != draft.candidate_digest:
            raise CandidateIntegrityError("candidate digest does not match immutable identity")
        if self.candidate_id != draft.candidate_id:
            raise CandidateIntegrityError("candidate ID does not derive from candidate digest")
        if not isinstance(self.state, CandidateState):
            raise CandidateIntegrityError("candidate state is invalid")
        _require_nonnegative_int(self.generation, "candidate generation")
        if self.resolution_receipt_digest is not None:
            _require_sha256(self.resolution_receipt_digest, "resolution receipt digest")
        if self.stage_receipt_digest is not None:
            _require_sha256(self.stage_receipt_digest, "stage receipt digest")
        if self.terminal_reason is not None:
            _require_text(self.terminal_reason, "terminal reason")
        _require_time(self.created_at, "candidate creation time")
        _require_time(self.updated_at, "candidate update time")
        if self.updated_at < self.created_at:
            raise CandidateIntegrityError("candidate update time predates creation")
        _require_sha256(self.last_event_digest, "last event digest")
        if self.state is CandidateState.PENDING and any(
            item is not None
            for item in (
                self.resolution_receipt_digest,
                self.stage_receipt_digest,
                self.terminal_reason,
            )
        ):
            raise CandidateIntegrityError("pending candidate has transition-only evidence")
        if self.state is CandidateState.RESOLVED and (
            self.resolution_receipt_digest is None
            or self.stage_receipt_digest is not None
            or self.terminal_reason is not None
        ):
            raise CandidateIntegrityError("resolved candidate evidence is inconsistent")
        if self.state is CandidateState.STAGED and (
            self.resolution_receipt_digest is None
            or self.stage_receipt_digest is None
            or self.terminal_reason is not None
        ):
            raise CandidateIntegrityError("staged candidate evidence is inconsistent")
        if self.state is CandidateState.REJECTED and (
            self.stage_receipt_digest is not None or self.terminal_reason is None
        ):
            raise CandidateIntegrityError("rejected candidate evidence is inconsistent")
        if self.state is CandidateState.INVALIDATED and self.terminal_reason is None:
            raise CandidateIntegrityError("invalidated candidate requires a reason")

    def decoded_inspection_payload(self) -> dict[str, JsonValue]:
        payload = json.loads(self.inspection_payload_json)
        if not isinstance(payload, dict):
            raise CandidateIntegrityError("persisted inspection payload is not an object")
        canonical = canonical_data(payload)
        if not isinstance(canonical, dict):
            raise CandidateIntegrityError("persisted inspection payload is not an object")
        return canonical

    @property
    def inspection_payload_sha256(self) -> str:
        """Plain SHA-256 for reconstructing managed receipt metadata."""

        return hashlib.sha256(self.inspection_payload_json.encode("utf-8")).hexdigest()

    def draft(self) -> ImportCandidateDraft:
        return ImportCandidateDraft(
            self.artifact_id,
            self.artifact_sha256,
            self.artifact_kind,
            self.project_id,
            self.expected_project_revision,
            self.run_id,
            self.expected_run_revision,
            self.inspection_payload_json,
            self.inspection_receipt_digest,
            self.diagnostics,
            self.blockers,
            self.created_by,
            self.identity_scheme,
        )

    def with_transition(
        self,
        *,
        state: CandidateState,
        generation: int,
        updated_at: datetime,
        last_event_digest: str,
        resolution_receipt_digest: str | None = None,
        stage_receipt_digest: str | None = None,
        terminal_reason: str | None = None,
    ) -> ImportCandidate:
        return replace(
            self,
            state=state,
            generation=generation,
            updated_at=updated_at,
            last_event_digest=last_event_digest,
            resolution_receipt_digest=(
                resolution_receipt_digest
                if resolution_receipt_digest is not None
                else self.resolution_receipt_digest
            ),
            stage_receipt_digest=(
                stage_receipt_digest
                if stage_receipt_digest is not None
                else self.stage_receipt_digest
            ),
            terminal_reason=terminal_reason,
        )


@dataclass(frozen=True, slots=True)
class CandidateTransitionEvent:
    candidate_id: str
    sequence: int
    kind: CandidateEventKind
    previous_state: CandidateState | None
    state: CandidateState
    actor_id: str
    receipt_digest: str | None
    reason: str | None
    transitioned_at: datetime
    previous_event_digest: str
    event_digest: str

    def __post_init__(self) -> None:
        _require_candidate_id(self.candidate_id)
        _require_nonnegative_int(self.sequence, "event sequence")
        if not isinstance(self.kind, CandidateEventKind):
            raise CandidateIntegrityError("candidate event kind is invalid")
        if self.previous_state is not None and not isinstance(
            self.previous_state, CandidateState
        ):
            raise CandidateIntegrityError("candidate previous state is invalid")
        if not isinstance(self.state, CandidateState):
            raise CandidateIntegrityError("candidate event state is invalid")
        _require_public_id(self.actor_id, "event actor ID")
        if self.receipt_digest is not None:
            _require_sha256(self.receipt_digest, "event receipt digest")
        if self.reason is not None:
            _require_text(self.reason, "event reason")
        _require_time(self.transitioned_at, "event transition time")
        _require_sha256(self.previous_event_digest, "previous event digest")
        _require_sha256(self.event_digest, "event digest")
        if self.kind is CandidateEventKind.CREATED and (
            self.sequence != 0
            or self.previous_state is not None
            or self.state is not CandidateState.PENDING
            or self.previous_event_digest != _ZERO_DIGEST
            or self.receipt_digest is None
            or self.reason is not None
        ):
            raise CandidateIntegrityError("candidate creation event is malformed")
        if self.kind is CandidateEventKind.TRANSITIONED and (
            self.previous_state is None
            or self.state not in LEGAL_TRANSITIONS[self.previous_state]
        ):
            raise CandidateIntegrityError("candidate transition event is illegal")
        if self.kind is CandidateEventKind.TRANSITIONED:
            if self.state in {CandidateState.RESOLVED, CandidateState.STAGED} and (
                self.receipt_digest is None or self.reason is not None
            ):
                raise CandidateIntegrityError(
                    "resolution/stage event must contain only its receipt digest"
                )
            if self.state in {CandidateState.REJECTED, CandidateState.INVALIDATED} and (
                self.receipt_digest is not None or self.reason is None
            ):
                raise CandidateIntegrityError(
                    "terminal event must contain only its explicit reason"
                )
        if self.kind is CandidateEventKind.MIGRATED and self.previous_state is not None:
            raise CandidateIntegrityError("candidate migration event cannot invent history")
        if self.event_digest != self.computed_digest:
            raise CandidateIntegrityError("candidate event digest does not match event body")

    @classmethod
    def build(
        cls,
        *,
        candidate_id: str,
        sequence: int,
        kind: CandidateEventKind,
        previous_state: CandidateState | None,
        state: CandidateState,
        actor_id: str,
        receipt_digest: str | None,
        reason: str | None,
        transitioned_at: datetime,
        previous_event_digest: str,
    ) -> CandidateTransitionEvent:
        material = _event_material(
            candidate_id=candidate_id,
            sequence=sequence,
            kind=kind,
            previous_state=previous_state,
            state=state,
            actor_id=actor_id,
            receipt_digest=receipt_digest,
            reason=reason,
            transitioned_at=transitioned_at,
            previous_event_digest=previous_event_digest,
        )
        return cls(
            candidate_id=candidate_id,
            sequence=sequence,
            kind=kind,
            previous_state=previous_state,
            state=state,
            actor_id=actor_id,
            receipt_digest=receipt_digest,
            reason=reason,
            transitioned_at=transitioned_at,
            previous_event_digest=previous_event_digest,
            event_digest=_digest(material, domain=_EVENT_DOMAIN),
        )

    @property
    def computed_digest(self) -> str:
        return _digest(
            _event_material(
                candidate_id=self.candidate_id,
                sequence=self.sequence,
                kind=self.kind,
                previous_state=self.previous_state,
                state=self.state,
                actor_id=self.actor_id,
                receipt_digest=self.receipt_digest,
                reason=self.reason,
                transitioned_at=self.transitioned_at,
                previous_event_digest=self.previous_event_digest,
            ),
            domain=_EVENT_DOMAIN,
        )


def _event_material(
    *,
    candidate_id: str,
    sequence: int,
    kind: CandidateEventKind,
    previous_state: CandidateState | None,
    state: CandidateState,
    actor_id: str,
    receipt_digest: str | None,
    reason: str | None,
    transitioned_at: datetime,
    previous_event_digest: str,
) -> dict[str, JsonValue]:
    return {
        "actor_id": actor_id,
        "candidate_id": candidate_id,
        "kind": kind.value,
        "previous_event_digest": previous_event_digest,
        "previous_state": previous_state.value if previous_state is not None else None,
        "reason": reason,
        "receipt_digest": receipt_digest,
        "sequence": sequence,
        "state": state.value,
        "transitioned_at": _encode_time(transitioned_at),
    }


def diagnostics_digest(value: tuple[CandidateDiagnostic, ...]) -> str:
    _validate_diagnostics(value)
    return _digest([item.payload() for item in value], domain=_DIAGNOSTICS_DOMAIN)


def blockers_digest(value: tuple[CandidateBlocker, ...]) -> str:
    _validate_blockers(value)
    return _digest([item.payload() for item in value], domain=_BLOCKERS_DOMAIN)


def _encode_time(value: datetime) -> str:
    _require_time(value, "timestamp")
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def encode_time(value: datetime) -> str:
    return _encode_time(value)


def decode_time(value: object) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise CandidateIntegrityError("persisted timestamp is not canonical UTC text")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise CandidateIntegrityError("persisted timestamp is invalid") from exc
    if _encode_time(parsed) != value:
        raise CandidateIntegrityError("persisted timestamp is not canonical")
    return parsed


ZERO_DIGEST = _ZERO_DIGEST

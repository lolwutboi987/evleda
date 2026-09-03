"""Semantic KiCad boundary and deterministic in-memory reference adapter.

There is intentionally no command execution or general filesystem operation in
this interface. A live implementation may use KiCad IPC and ``kicad-cli``
inside an isolated worker, but the public gateway can only ask for the outcomes
defined by :class:`KiCadAdapter`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .codec import canonical_data, canonical_json, revision_digest, stable_digest
from .errors import NotFound, RevisionConflict, TransactionConflict
from .models import (
    AgentRun,
    ApprovalReceipt,
    DesignPatch,
    ExportArtifact,
    ExportFormat,
    JsonValue,
    PatchAction,
    PatchOperation,
    PatchPreview,
    ProjectSnapshot,
    StageRecord,
    VerificationFinding,
    VerificationReport,
)


class KiCadAdapter(Protocol):
    """The complete capability-safe ECAD surface visible to the gateway."""

    def inspect_project(
        self, project_id: str, expected_revision: str | None = None
    ) -> ProjectSnapshot: ...

    def preview_patch(
        self, project_id: str, expected_revision: str, patch: DesignPatch
    ) -> PatchPreview: ...

    def stage_patch(
        self,
        project_id: str,
        expected_revision: str,
        patch: DesignPatch,
        preview_digest: str,
    ) -> StageRecord: ...

    def run_verification(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> VerificationReport: ...

    def commit(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str: ...

    def rollback(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str: ...

    def export_project(
        self,
        project_id: str,
        expected_project_revision: str,
        format: ExportFormat,
    ) -> ExportArtifact: ...


@runtime_checkable
class EvidenceBoundCommitAdapter(Protocol):
    """Optional stronger commit boundary used by durable canonical adapters.

    The ordinary adapter protocol predates durable approval evidence.  Hosts
    implementing this protocol receive the already-validated gateway records
    so they can bind the canonical commit and its durable attestation to the
    same human receipt and deterministic report.
    """

    def commit_with_evidence(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
        *,
        run: AgentRun,
        report: VerificationReport,
        receipt: ApprovalReceipt,
    ) -> str: ...


VerificationHook = Callable[[str, str, str, DesignPatch], Sequence[VerificationFinding]]


@dataclass(slots=True)
class _ProjectState:
    project_id: str
    committed_design: dict[str, Any]
    project_revision: str
    staged_design: dict[str, Any] | None = None
    staged_patch: DesignPatch | None = None
    stage: StageRecord | None = None


class InMemoryKiCadAdapter:
    """A deterministic mock of the transactional KiCad worker.

    The adapter keeps exports in memory and never accepts a path, command, or
    source-text replacement. Its checks are deliberately small but hard: every
    finding is derived from typed integer geometry and grounding fields.
    """

    ENGINE_VERSION = "mock-kicad-rules/1.0.0"
    MIN_CLEARANCE_NM = 100_000
    _SHA256 = re.compile(r"^[0-9a-f]{64}$")

    def __init__(self, verification_hook: VerificationHook | None = None) -> None:
        self._projects: dict[str, _ProjectState] = {}
        self._exports: dict[str, bytes] = {}
        self._verification_hook = verification_hook

    def seed_project(self, project_id: str, design: Mapping[str, JsonValue] | None = None) -> str:
        if project_id in self._projects:
            raise TransactionConflict(f"project already exists: {project_id}")
        normalized = canonical_data(
            design
            or {
                "components": {},
                "nets": {},
                "applied_operations": [],
            }
        )
        if not isinstance(normalized, dict):
            raise TransactionConflict("seed design must be an object")
        normalized.setdefault("components", {})
        normalized.setdefault("nets", {})
        normalized.setdefault("applied_operations", [])
        revision = revision_digest(normalized)
        self._projects[project_id] = _ProjectState(
            project_id=project_id,
            committed_design=normalized,
            project_revision=revision,
        )
        return revision

    def inspect_project(
        self, project_id: str, expected_revision: str | None = None
    ) -> ProjectSnapshot:
        state = self._state(project_id)
        if expected_revision is not None:
            self._expect_project_revision(state, expected_revision)
        components = state.committed_design.get("components", {})
        nets = state.committed_design.get("nets", {})
        operations = state.committed_design.get("applied_operations", [])
        return ProjectSnapshot(
            project_id=project_id,
            project_revision=state.project_revision,
            component_count=len(components) if isinstance(components, dict) else 0,
            net_count=len(nets) if isinstance(nets, dict) else 0,
            operation_count=len(operations) if isinstance(operations, list) else 0,
            active_staged_revision=(state.stage.staged_revision if state.stage else None),
        )

    def preview_patch(
        self, project_id: str, expected_revision: str, patch: DesignPatch
    ) -> PatchPreview:
        state = self._state(project_id)
        self._expect_project_revision(state, expected_revision)
        if patch.base_revision != state.project_revision:
            raise RevisionConflict("patch base revision is not the committed revision")
        staged_design = self._apply_patch(state.committed_design, patch)
        prospective_revision = revision_digest(staged_design)
        summaries = tuple(
            f"{operation.action.value}:{operation.target_id}" for operation in patch.operations
        )
        material = {
            "project_id": project_id,
            "base_revision": state.project_revision,
            "prospective_revision": prospective_revision,
            "patch_digest": patch.digest,
            "operation_summaries": summaries,
        }
        return PatchPreview(
            project_id=project_id,
            base_revision=state.project_revision,
            prospective_revision=prospective_revision,
            patch_digest=patch.digest,
            preview_digest=stable_digest(material),
            operation_summaries=summaries,
        )

    def stage_patch(
        self,
        project_id: str,
        expected_revision: str,
        patch: DesignPatch,
        preview_digest: str,
    ) -> StageRecord:
        state = self._state(project_id)
        self._expect_project_revision(state, expected_revision)
        if state.stage is not None:
            raise TransactionConflict("project already has an active staged transaction")
        preview = self.preview_patch(project_id, expected_revision, patch)
        if preview.preview_digest != preview_digest:
            raise RevisionConflict("preview digest does not match the exact patch")
        staged_design = self._apply_patch(state.committed_design, patch)
        transaction_id = f"txn_{stable_digest({'project': project_id, 'stage': preview.prospective_revision})[:32]}"
        stage = StageRecord(
            transaction_id=transaction_id,
            project_id=project_id,
            base_revision=state.project_revision,
            staged_revision=preview.prospective_revision,
            patch_digest=patch.digest,
            preview_digest=preview.preview_digest,
        )
        state.staged_design = staged_design
        state.staged_patch = patch
        state.stage = stage
        return stage

    def run_verification(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> VerificationReport:
        state = self._state(project_id)
        stage = self._expect_stage(state, expected_project_revision, expected_staged_revision)
        assert state.staged_patch is not None
        findings = list(self._core_findings(state.staged_patch))
        if self._verification_hook is not None:
            findings.extend(
                self._verification_hook(
                    project_id,
                    stage.base_revision,
                    stage.staged_revision,
                    state.staged_patch,
                )
            )
        findings.sort(key=lambda item: item.finding_id)
        passed = not any(item.severity in {"error", "fatal"} for item in findings)
        report_id = f"verification_{stable_digest({'stage': stage.staged_revision, 'engine': self.ENGINE_VERSION})[:32]}"
        material = {
            "report_id": report_id,
            "project_id": project_id,
            "base_revision": stage.base_revision,
            "staged_revision": stage.staged_revision,
            "engine_version": self.ENGINE_VERSION,
            "passed": passed,
            "findings": tuple(findings),
        }
        return VerificationReport(
            report_id=report_id,
            project_id=project_id,
            base_revision=stage.base_revision,
            staged_revision=stage.staged_revision,
            engine_version=self.ENGINE_VERSION,
            passed=passed,
            findings=tuple(findings),
            report_digest=stable_digest(material),
        )

    def commit(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str:
        state = self._state(project_id)
        stage = self._expect_stage(state, expected_project_revision, expected_staged_revision)
        assert state.staged_design is not None
        state.committed_design = state.staged_design
        state.project_revision = stage.staged_revision
        self._clear_stage(state)
        return state.project_revision

    def rollback(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str:
        state = self._state(project_id)
        self._expect_stage(state, expected_project_revision, expected_staged_revision)
        self._clear_stage(state)
        return state.project_revision

    def export_project(
        self,
        project_id: str,
        expected_project_revision: str,
        format: ExportFormat,
    ) -> ExportArtifact:
        state = self._state(project_id)
        self._expect_project_revision(state, expected_project_revision)
        content = canonical_json(
            {
                "format": format,
                "project_id": project_id,
                "project_revision": state.project_revision,
                "design": state.committed_design,
            }
        ).encode("utf-8")
        digest = stable_digest(json.loads(content.decode("utf-8")))
        artifact_id = f"artifact_{digest[:32]}"
        self._exports[artifact_id] = content
        media_type = {
            ExportFormat.KICAD_ARCHIVE: "application/vnd.kicad.project+zip",
            ExportFormat.GERBER_BUNDLE: "application/vnd.gerber+zip",
            ExportFormat.IPC2581: "application/vnd.ipc2581+xml",
        }[format]
        return ExportArtifact(
            artifact_id=artifact_id,
            project_id=project_id,
            project_revision=state.project_revision,
            format=format,
            media_type=media_type,
            content_digest=digest,
            size_bytes=len(content),
        )

    def artifact_bytes(self, artifact_id: str) -> bytes:
        """Host-only retrieval for tests/streaming; this is not an MCP tool."""

        try:
            return self._exports[artifact_id]
        except KeyError as exc:
            raise NotFound(f"artifact not found: {artifact_id}") from exc

    def _state(self, project_id: str) -> _ProjectState:
        try:
            return self._projects[project_id]
        except KeyError as exc:
            raise NotFound(f"project not found: {project_id}") from exc

    @staticmethod
    def _expect_project_revision(state: _ProjectState, expected: str) -> None:
        if state.project_revision != expected:
            raise RevisionConflict(
                f"project revision mismatch: expected {expected}, current {state.project_revision}"
            )

    def _expect_stage(
        self,
        state: _ProjectState,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> StageRecord:
        self._expect_project_revision(state, expected_project_revision)
        if state.stage is None:
            raise TransactionConflict("project has no active staged transaction")
        if state.stage.staged_revision != expected_staged_revision:
            raise RevisionConflict("staged revision mismatch: the transaction changed or is stale")
        return state.stage

    @staticmethod
    def _clear_stage(state: _ProjectState) -> None:
        state.staged_design = None
        state.staged_patch = None
        state.stage = None

    @staticmethod
    def _apply_patch(design: Mapping[str, Any], patch: DesignPatch) -> dict[str, Any]:
        # JSON round-trip is an intentional deterministic deep copy.
        updated = json.loads(canonical_json(design))
        components = updated.setdefault("components", {})
        nets = updated.setdefault("nets", {})
        applied = updated.setdefault("applied_operations", [])
        for operation in patch.operations:
            params = canonical_data(operation.parameter_map())
            if operation.action is PatchAction.ADD_COMPONENT:
                components[operation.target_id] = params
            elif operation.action is PatchAction.REMOVE_COMPONENT:
                components.pop(operation.target_id, None)
            elif operation.action is PatchAction.CONNECT_NET:
                nets[operation.target_id] = params
            elif operation.action is PatchAction.DISCONNECT_NET:
                nets.pop(operation.target_id, None)
            applied.append(canonical_data(operation))
        return canonical_data(updated)

    def _core_findings(self, patch: DesignPatch) -> tuple[VerificationFinding, ...]:
        findings: list[VerificationFinding] = []
        for operation in patch.operations:
            params = operation.parameter_map()
            if operation.action is PatchAction.ADD_COMPONENT:
                required = (
                    "manufacturer_part_number",
                    "symbol",
                    "footprint",
                    "datasheet_sha256",
                    "pin_map_sha256",
                )
                missing = tuple(name for name in required if not params.get(name))
                bad_hash = any(
                    not isinstance(params.get(name), str)
                    or not self._SHA256.fullmatch(str(params.get(name)))
                    for name in ("datasheet_sha256", "pin_map_sha256")
                )
                if missing or bad_hash:
                    findings.append(
                        self._finding(
                            "component_grounding",
                            operation,
                            "component lacks exact MPN/symbol/footprint/datasheet/pin-map evidence",
                        )
                    )
            elif operation.action is PatchAction.CONNECT_NET:
                pins = params.get("pins")
                if not isinstance(pins, (tuple, list)) or len(pins) < 2:
                    findings.append(
                        self._finding(
                            "net_minimum_connections",
                            operation,
                            "a connected net requires at least two explicit pins",
                        )
                    )
            elif operation.action is PatchAction.PLACE_COMPONENT:
                rotation = params.get("rotation_mdeg")
                valid = (
                    isinstance(params.get("x_nm"), int)
                    and isinstance(params.get("y_nm"), int)
                    and params.get("side") in {"F", "B"}
                    and isinstance(rotation, int)
                    and rotation % 90_000 == 0
                )
                if not valid:
                    findings.append(
                        self._finding(
                            "placement_integer_grid",
                            operation,
                            "placement requires integer nanometres, F/B side, and 90-degree rotation",
                        )
                    )
            elif operation.action is PatchAction.ROUTE_NET:
                points = params.get("path_nm")
                valid_points = (
                    isinstance(points, (tuple, list))
                    and len(points) >= 2
                    and all(
                        isinstance(point, (tuple, list))
                        and len(point) == 2
                        and all(isinstance(value, int) for value in point)
                        for point in points
                    )
                )
                width = params.get("width_nm")
                clearance = params.get("clearance_nm")
                if (
                    not valid_points
                    or not isinstance(width, int)
                    or width <= 0
                    or not isinstance(clearance, int)
                    or clearance < self.MIN_CLEARANCE_NM
                ):
                    findings.append(
                        self._finding(
                            "route_geometry_and_clearance",
                            operation,
                            f"route requires an integer path, positive width, and clearance >= {self.MIN_CLEARANCE_NM} nm",
                        )
                    )
            elif operation.action is PatchAction.SET_CONSTRAINT:
                clearance = params.get("min_clearance_nm")
                if clearance is not None and (
                    not isinstance(clearance, int) or clearance < self.MIN_CLEARANCE_NM
                ):
                    findings.append(
                        self._finding(
                            "minimum_clearance",
                            operation,
                            f"minimum clearance cannot be below {self.MIN_CLEARANCE_NM} nm",
                        )
                    )
        return tuple(findings)

    @staticmethod
    def _finding(rule_id: str, operation: PatchOperation, message: str) -> VerificationFinding:
        digest = stable_digest(
            {
                "rule_id": rule_id,
                "operation_id": operation.operation_id,
                "message": message,
            }
        )
        return VerificationFinding(
            finding_id=f"finding_{digest[:32]}",
            rule_id=rule_id,
            severity="error",
            message=message,
            operation_ids=(operation.operation_id,),
        )

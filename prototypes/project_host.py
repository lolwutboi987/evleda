"""Local stdio MCP host for one launch-configured KiCad 10 workspace.

KiCad files remain authoritative.  This module snapshots a fixed project path
selected by the human who launches the process, derives an immutable revision
from every admitted source byte, and gives the existing isolated KiCad worker
that in-memory snapshot.  MCP callers can never supply a path, executable,
environment, command, or output destination.

This host intentionally exposes no mutation tools.  The repository's typed
canonical writer does not yet round-trip every valid KiCad project, so applying
its patches to an arbitrary native workspace would risk lossy edits.  A future
mutation mode must remain separately feature-gated until exact native reparse,
preview, approval, atomic publication, rollback, and restart tests pass.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, NoReturn, cast
from xml.etree import ElementTree

from backend.kicad_io import UnsupportedPolicy as BoardUnsupportedPolicy
from backend.kicad_io import import_board
from backend.kicad_project import BundleLimits, ProjectAuxiliaryFile
from backend.kicad_worker import (
    BundleResolutionError,
    CommandLaunchError,
    CommandOutputLimitError,
    CommandRunner,
    CommandTimeoutError,
    CompletedCommand,
    JournalError,
    JournalSubject,
    LocalKiCadCliService,
    ManagedKiCadBundle,
    PublishedArtifact,
    WorkerPolicy,
    runtime_support_manifest,
    runtime_support_manifest_sha256,
)
from backend.mcp_gateway import (
    ActorKind,
    CapabilityDenied,
    CapabilitySafeGateway,
    DesignPatch,
    ExportArtifact,
    ExportFormat,
    Invocation,
    NotFound,
    PatchPreview,
    Principal,
    ProfileName,
    ProjectSnapshot,
    RevisionConflict,
    StageRecord,
    ToolName,
    VerificationReport,
    canonical_json,
    stable_digest,
)

from .hooks import KiCadExecutionEvidence, KiCadServiceFailure, KiCadServiceResult
from .reference_host import (
    ExactReferenceArtifactPublisher,
    ReferenceArtifactPublicationError,
    ReferenceHostConfigurationError,
    _bind_journal_to_key,
    _prepare_private_directory,
    load_or_create_local_journal_key,
)
from .server import HostConfig, MCPStdioServer

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_REVISION = re.compile(r"^rev_[0-9a-f]{64}$")
_STEM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_SKIPPED_DIRECTORIES = frozenset({".git", ".hg", ".svn", "__pycache__"})
_TABLE_NAMES = frozenset({"fp-lib-table", "sym-lib-table"})
_SOURCE_SUFFIXES = frozenset(
    {
        ".kicad_dru",
        ".kicad_mod",
        ".kicad_pcb",
        ".kicad_sch",
        ".kicad_sym",
        ".kicad_wks",
    }
)
_RESERVED_RUNTIME_SUFFIXES = frozenset(
    {".kicad_prl", ".kicad_pro-bak", ".kicad_sch-bak", ".kicad_pcb-bak"}
)
_SOURCE_MEDIA_TYPES = {
    ".kicad_dru": "application/x-kicad-design-rules",
    ".kicad_mod": "application/x-kicad-footprint",
    ".kicad_pcb": "application/x-kicad-pcb",
    ".kicad_sch": "application/x-kicad-schematic",
    ".kicad_sym": "application/x-kicad-symbol-library",
    ".kicad_wks": "application/x-kicad-worksheet",
}
_SOURCE_CANDIDATE_MEDIA_TYPE = "application/vnd.kicad.project+zip"
_MAX_RENDER_BYTES = 32 * 1_048_576
_NON_RELEASE_NAME = "EVLEDA_NON_RELEASE_CANDIDATE.json"


class ProjectHostConfigurationError(RuntimeError):
    """A trusted project-host launch setting or source path is unsafe."""


@dataclass(frozen=True, slots=True)
class ProjectHostSettings:
    """Immutable host policy; none of these values come from MCP requests."""

    state_root: Path
    project_file: Path
    project_id: str
    actor_id: str = "local-kicad-agent"
    kicad_executable: Path | None = None
    kicad_executable_sha256: str | None = None
    kicad_version: str | None = None
    worker_id: str = "local-kicad-cli-workspace-v1"
    timeout_seconds: int = 120
    max_stdout_bytes: int = 1_048_576
    max_stderr_bytes: int = 1_048_576
    max_report_bytes: int = 32 * 1_048_576
    max_bundle_bytes: int = 96 * 1_048_576

    def __post_init__(self) -> None:
        if type(self) is not ProjectHostSettings:
            raise TypeError("project host settings must use the exact concrete type")
        for path, label in (
            (self.state_root, "state_root"),
            (self.project_file, "project_file"),
        ):
            if not isinstance(path, Path) or not path.is_absolute():
                raise ProjectHostConfigurationError(f"{label} must be an absolute Path")
        for value, label in (
            (self.project_id, "project_id"),
            (self.actor_id, "actor_id"),
            (self.worker_id, "worker_id"),
        ):
            if type(value) is not str or _IDENTIFIER.fullmatch(value) is None:
                raise ProjectHostConfigurationError(f"{label} must be a stable identifier")
        if self.project_file.suffix.casefold() != ".kicad_pro":
            raise ProjectHostConfigurationError("project_file must name a .kicad_pro file")
        if _STEM.fullmatch(self.project_file.stem) is None:
            raise ProjectHostConfigurationError(
                "KiCad project stem must be portable ASCII identifier syntax"
            )
        pins = (
            self.kicad_executable,
            self.kicad_executable_sha256,
            self.kicad_version,
        )
        if any(value is not None for value in pins) and any(value is None for value in pins):
            raise ProjectHostConfigurationError(
                "project host requires executable, SHA-256, and KiCad version together"
            )
        if self.kicad_executable is None:
            raise ProjectHostConfigurationError(
                "project host requires a pinned local KiCad 10 CLI"
            )
        if not self.kicad_executable.is_absolute():
            raise ProjectHostConfigurationError("kicad_executable must be absolute")
        if (
            type(self.kicad_executable_sha256) is not str
            or _SHA256.fullmatch(self.kicad_executable_sha256) is None
        ):
            raise ProjectHostConfigurationError("kicad_executable_sha256 is invalid")
        if (
            type(self.kicad_version) is not str
            or re.fullmatch(r"10\.[0-9]+\.[0-9]+", self.kicad_version) is None
        ):
            raise ProjectHostConfigurationError("kicad_version must pin exact KiCad 10.x.y")
        for name in (
            "timeout_seconds",
            "max_stdout_bytes",
            "max_stderr_bytes",
            "max_report_bytes",
            "max_bundle_bytes",
        ):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ProjectHostConfigurationError(f"{name} must be a positive integer")


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    mode: int
    size: int
    modified_ns: int
    changed_ns: int
    attributes: int

    @classmethod
    def from_stat(cls, value: os.stat_result) -> _FileIdentity:
        attributes = getattr(value, "st_file_attributes", 0)
        return cls(
            int(value.st_dev),
            int(value.st_ino),
            int(value.st_mode),
            int(value.st_size),
            int(value.st_mtime_ns),
            int(value.st_ctime_ns),
            int(attributes) if isinstance(attributes, int) else 0,
        )


@dataclass(frozen=True, slots=True)
class _SourceRecord:
    relative_name: str
    path: Path
    identity: _FileIdentity


@dataclass(frozen=True, slots=True)
class WorkspaceSnapshot:
    bundle: ManagedKiCadBundle
    component_count: int
    net_count: int
    operation_count: int
    source_manifest_digest: str


def _is_link_or_reparse(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    return stat.S_ISLNK(metadata.st_mode) or (
        isinstance(attributes, int) and bool(attributes & _REPARSE_POINT)
    )


def _same_open_file(left: _FileIdentity, right: _FileIdentity) -> bool:
    """Compare fields represented consistently by path-stat and fd-stat."""

    return (
        left.device,
        left.inode,
        left.mode,
        left.size,
        left.modified_ns,
        left.attributes,
    ) == (
        right.device,
        right.inode,
        right.mode,
        right.size,
        right.modified_ns,
        right.attributes,
    )


def _safe_directory(path: Path, label: str) -> Path:
    try:
        candidate = Path(os.path.abspath(path))
        nodes: list[Path] = []
        current = Path(candidate.parts[0])
        nodes.append(current)
        for part in candidate.parts[1:]:
            current /= part
            nodes.append(current)
        for node in nodes:
            metadata = node.lstat()
            if _is_link_or_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
                raise ProjectHostConfigurationError(
                    f"{label} contains a link, reparse point, or non-directory"
                )
        return candidate
    except ProjectHostConfigurationError:
        raise
    except OSError as exc:
        raise ProjectHostConfigurationError(f"{label} could not be inspected") from exc


def _admitted_source(name: str, *, primary_name: str) -> bool:
    folded = name.casefold()
    if folded == primary_name.casefold() or folded in _TABLE_NAMES:
        return True
    if any(folded.endswith(suffix) for suffix in _RESERVED_RUNTIME_SUFFIXES):
        return False
    return any(folded.endswith(suffix) for suffix in _SOURCE_SUFFIXES)


def _media_type(name: str) -> str:
    folded = name.casefold()
    if folded in _TABLE_NAMES:
        return "text/plain"
    return next(
        media_type
        for suffix, media_type in _SOURCE_MEDIA_TYPES.items()
        if folded.endswith(suffix)
    )


class WorkspaceBundleResolver:
    """Read one fixed workspace as a bounded, immutable in-memory snapshot."""

    def __init__(
        self,
        project_file: Path,
        *,
        project_id: str,
        max_bundle_bytes: int,
    ) -> None:
        self._project_file = Path(os.path.abspath(project_file))
        self._root = _safe_directory(self._project_file.parent, "project workspace")
        self._project_id = project_id
        self._stem = project_file.stem
        self._limits = BundleLimits(maximum_total_bytes=max_bundle_bytes)
        self.snapshot()

    @property
    def project_id(self) -> str:
        return self._project_id

    @property
    def project_file(self) -> Path:
        return self._project_file

    def _scan(self) -> tuple[_SourceRecord, ...]:
        records: list[_SourceRecord] = []
        stack: list[tuple[Path, tuple[str, ...]]] = [(self._root, ())]
        try:
            while stack:
                directory, prefix = stack.pop()
                entries = sorted(
                    os.scandir(directory),
                    key=lambda item: (item.name.casefold(), item.name),
                )
                for entry in entries:
                    if entry.name in _SKIPPED_DIRECTORIES:
                        continue
                    entry_path = Path(entry.path)
                    metadata = entry_path.lstat()
                    if entry.is_symlink() or _is_link_or_reparse(metadata):
                        raise ProjectHostConfigurationError(
                            "project workspace contains a link or reparse point"
                        )
                    parts = (*prefix, entry.name)
                    if stat.S_ISDIR(metadata.st_mode):
                        if len(parts) > 8:
                            raise ProjectHostConfigurationError(
                                "project workspace exceeds the eight-level source limit"
                            )
                        stack.append((entry_path, parts))
                        continue
                    if not stat.S_ISREG(metadata.st_mode):
                        raise ProjectHostConfigurationError(
                            "project workspace contains a special filesystem node"
                        )
                    relative_name = "/".join(parts)
                    if _admitted_source(
                        relative_name,
                        primary_name=self._project_file.name,
                    ):
                        records.append(
                            _SourceRecord(
                                relative_name,
                                entry_path,
                                _FileIdentity.from_stat(metadata),
                            )
                        )
        except ProjectHostConfigurationError:
            raise
        except OSError as exc:
            raise ProjectHostConfigurationError(
                "project workspace could not be inventoried"
            ) from exc
        records.sort(key=lambda item: (item.relative_name.casefold(), item.relative_name))
        folded = tuple(item.relative_name.casefold() for item in records)
        if len(folded) != len(set(folded)):
            raise ProjectHostConfigurationError(
                "project source files contain a portable name collision"
            )
        if len(records) > self._limits.maximum_auxiliary_file_count + 3:
            raise ProjectHostConfigurationError("project source file count exceeds policy")
        return tuple(records)

    @staticmethod
    def _read(record: _SourceRecord, *, maximum: int) -> bytes:
        flags = (
            os.O_RDONLY
            | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor: int | None = None
        try:
            descriptor = os.open(record.path, flags)
            before = _FileIdentity.from_stat(os.fstat(descriptor))
            if not _same_open_file(before, record.identity) or _is_link_or_reparse(
                os.fstat(descriptor)
            ):
                raise ProjectHostConfigurationError(
                    "project source changed before it was opened"
                )
            if before.size > maximum:
                raise ProjectHostConfigurationError("project source file exceeds policy")
            chunks: list[bytes] = []
            remaining = before.size
            while remaining:
                chunk = os.read(descriptor, min(1_048_576, remaining))
                if not chunk:
                    raise ProjectHostConfigurationError(
                        "project source was truncated while being read"
                    )
                chunks.append(chunk)
                remaining -= len(chunk)
            if os.read(descriptor, 1):
                raise ProjectHostConfigurationError(
                    "project source grew while being read"
                )
            payload = b"".join(chunks)
            after = _FileIdentity.from_stat(os.fstat(descriptor))
            path_after = _FileIdentity.from_stat(record.path.lstat())
            if after != before or path_after != record.identity:
                raise ProjectHostConfigurationError(
                    "project source changed while being read"
                )
            return payload
        except ProjectHostConfigurationError:
            raise
        except OSError as exc:
            raise ProjectHostConfigurationError("project source could not be read") from exc
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def snapshot(self, expected_revision: str | None = None) -> WorkspaceSnapshot:
        records = self._scan()
        by_name = {item.relative_name: item for item in records}
        primary_names = (
            f"{self._stem}.kicad_pro",
            f"{self._stem}.kicad_sch",
            f"{self._stem}.kicad_pcb",
        )
        if any(name not in by_name for name in primary_names):
            raise ProjectHostConfigurationError(
                "workspace requires matching .kicad_pro, .kicad_sch, and .kicad_pcb files"
            )
        payloads: dict[str, bytes] = {}
        aggregate = 0
        for record in records:
            maximum = (
                self._limits.maximum_project_bytes
                if record.relative_name == primary_names[0]
                else self._limits.maximum_schematic_bytes
                if record.relative_name.endswith(".kicad_sch")
                else self._limits.maximum_board_bytes
                if record.relative_name.endswith(".kicad_pcb")
                else self._limits.maximum_auxiliary_file_bytes
            )
            payload = self._read(record, maximum=maximum)
            aggregate += len(payload)
            if aggregate > self._limits.maximum_total_bytes:
                raise ProjectHostConfigurationError(
                    "project source bundle exceeds aggregate byte policy"
                )
            payloads[record.relative_name] = payload
        if self._scan() != records:
            raise ProjectHostConfigurationError(
                "project workspace changed during snapshot inventory"
            )
        manifest = tuple(
            {
                "relative_name": name,
                "byte_length": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
            for name, payload in sorted(
                payloads.items(), key=lambda item: (item[0].casefold(), item[0])
            )
        )
        source_manifest_digest = stable_digest(manifest)
        revision = "rev_" + stable_digest(
            {
                "domain": "evleda-kicad-workspace-revision-v1",
                "project_id": self._project_id,
                "source_manifest_digest": source_manifest_digest,
            }
        )
        if expected_revision is not None and revision != expected_revision:
            raise RevisionConflict(
                f"workspace revision mismatch: expected {expected_revision}, current {revision}"
            )
        auxiliary = tuple(
            ProjectAuxiliaryFile(name, _media_type(name), payload)
            for name, payload in sorted(
                payloads.items(), key=lambda item: (item[0].casefold(), item[0])
            )
            if name not in primary_names
        )
        bundle = ManagedKiCadBundle.create(
            project_id=self._project_id,
            project_revision=revision,
            stem=self._stem,
            project_payload=payloads[primary_names[0]],
            schematic_payload=payloads[primary_names[1]],
            board_payload=payloads[primary_names[2]],
            auxiliary_files=auxiliary,
        )
        try:
            board = import_board(
                bundle.board_payload,
                unsupported_policy=BoardUnsupportedPolicy.MANIFEST,
            ).board
        except Exception as exc:
            raise ProjectHostConfigurationError(
                "configured KiCad board cannot be inspected by the bounded parser"
            ) from exc
        return WorkspaceSnapshot(
            bundle=bundle,
            component_count=len(board.footprints),
            net_count=len(board.nets),
            operation_count=(
                len(board.footprints)
                + len(board.segments)
                + len(board.vias)
                + len(board.zones)
            ),
            source_manifest_digest=source_manifest_digest,
        )

    def resolve_bundle(
        self,
        project_id: str,
        expected_project_revision: str,
    ) -> ManagedKiCadBundle:
        if project_id != self._project_id:
            raise BundleResolutionError("project ID is outside the configured workspace")
        if _REVISION.fullmatch(expected_project_revision) is None:
            raise BundleResolutionError("project revision is invalid")
        try:
            return self.snapshot(expected_project_revision).bundle
        except (ProjectHostConfigurationError, RevisionConflict) as exc:
            raise BundleResolutionError(
                "configured workspace no longer matches the requested revision"
            ) from exc


class ReadOnlyWorkspaceAdapter:
    """Gateway inspection adapter with every canonical mutation denied."""

    def __init__(self, resolver: WorkspaceBundleResolver) -> None:
        self._resolver = resolver

    def inspect_project(
        self,
        project_id: str,
        expected_revision: str | None = None,
    ) -> ProjectSnapshot:
        if project_id != self._resolver.project_id:
            raise NotFound("project not found")
        try:
            snapshot = self._resolver.snapshot(expected_revision)
        except ProjectHostConfigurationError as exc:
            raise NotFound(str(exc)) from exc
        return ProjectSnapshot(
            project_id=project_id,
            project_revision=snapshot.bundle.project_revision,
            component_count=snapshot.component_count,
            net_count=snapshot.net_count,
            operation_count=snapshot.operation_count,
            active_staged_revision=None,
        )

    @staticmethod
    def _read_only() -> NoReturn:
        raise CapabilityDenied(
            "arbitrary-workspace mutation is disabled until lossless KiCad-native writes pass"
        )

    def preview_patch(
        self, project_id: str, expected_revision: str, patch: DesignPatch
    ) -> PatchPreview:
        del project_id, expected_revision, patch
        self._read_only()

    def stage_patch(
        self,
        project_id: str,
        expected_revision: str,
        patch: DesignPatch,
        preview_digest: str,
    ) -> StageRecord:
        del project_id, expected_revision, patch, preview_digest
        self._read_only()

    def run_verification(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> VerificationReport:
        del project_id, expected_project_revision, expected_staged_revision
        self._read_only()

    def commit(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str:
        del project_id, expected_project_revision, expected_staged_revision
        self._read_only()

    def rollback(
        self,
        project_id: str,
        expected_project_revision: str,
        expected_staged_revision: str,
    ) -> str:
        del project_id, expected_project_revision, expected_staged_revision
        self._read_only()

    def export_project(
        self,
        project_id: str,
        expected_project_revision: str,
        format: ExportFormat,
    ) -> ExportArtifact:
        del project_id, expected_project_revision, format
        self._read_only()


class WorkspaceArtifactPublisher:
    """Revision-scoped facade over the proven content-addressed publisher."""

    def __init__(self, root: Path, *, maximum_bytes: int) -> None:
        self._root = _prepare_private_directory(root)
        self._maximum_bytes = maximum_bytes

    def _publisher(
        self, project_id: str, project_revision: str
    ) -> ExactReferenceArtifactPublisher:
        return ExactReferenceArtifactPublisher(
            self._root,
            project_id=project_id,
            project_revision=project_revision,
            maximum_bytes=self._maximum_bytes,
        )

    def publish_artifact(
        self,
        *,
        project_id: str,
        project_revision: str,
        media_type: str,
        payload: bytes,
        expected_sha256: str,
        idempotency_key: str,
    ) -> PublishedArtifact:
        try:
            return self._publisher(project_id, project_revision).publish_artifact(
                project_id=project_id,
                project_revision=project_revision,
                media_type=media_type,
                payload=payload,
                expected_sha256=expected_sha256,
                idempotency_key=idempotency_key,
            )
        except ReferenceArtifactPublicationError as exc:
            raise KiCadServiceFailure(
                "artifact_publication_failed",
                "managed artifact publication failed closed",
            ) from exc

    def artifact_path(
        self,
        project_id: str,
        project_revision: str,
        artifact: PublishedArtifact,
    ) -> Path:
        del project_id, project_revision
        digest = artifact.artifact_sha256
        expected_id = f"artifact_{digest}"
        path = self._root / "objects" / digest[:2] / f"{digest}.blob"
        try:
            if artifact.artifact_id != expected_id or path.is_symlink() or not path.is_file():
                raise KiCadServiceFailure(
                    "artifact_integrity_failed", "managed artifact identity is invalid"
                )
            payload = path.read_bytes()
        except OSError as exc:
            raise KiCadServiceFailure(
                "artifact_integrity_failed", "managed artifact is unreadable"
            ) from exc
        if hashlib.sha256(payload).hexdigest() != digest:
            raise KiCadServiceFailure(
                "artifact_integrity_failed", "managed artifact digest verification failed"
            )
        return path.resolve(strict=True)


class WorkspaceKiCadService(LocalKiCadCliService):
    """Native verify/render plus deterministic source-candidate export."""

    def __init__(
        self,
        policy: WorkerPolicy,
        resolver: WorkspaceBundleResolver,
        publisher: WorkspaceArtifactPublisher,
        *,
        runner: CommandRunner | None = None,
    ) -> None:
        super().__init__(policy, resolver, publisher, runner=runner)
        self._workspace_publisher = publisher

    def import_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        del arguments, invocation
        raise KiCadServiceFailure(
            "kicad_import_unconfigured",
            "arbitrary KiCad workspace mutation is not enabled",
        )

    @staticmethod
    def _source_zip(bundle: ManagedKiCadBundle) -> bytes:
        marker = canonical_json(
            {
                "schema_version": 1,
                "kind": "evleda-kicad-source-candidate",
                "project_id": bundle.project_id,
                "project_revision": bundle.project_revision,
                "source_bundle_sha256": bundle.bundle_sha256,
                "manufacturing_release_eligible": False,
                "release_status": "NON-RELEASE ENGINEERING CANDIDATE; NOT FOR FABRICATION",
            }
        ).encode("utf-8") + b"\n"
        if any(
            item.relative_name.casefold() == _NON_RELEASE_NAME.casefold()
            for item in bundle.all_files
        ):
            raise KiCadServiceFailure(
                "kicad_export_reserved_name",
                "workspace source collides with the non-release marker name",
            )
        files = [
            (item.relative_name, item.payload) for item in bundle.all_files
        ] + [(_NON_RELEASE_NAME, marker)]
        output = BytesIO()
        with zipfile.ZipFile(output, mode="w", allowZip64=False) as archive:
            for name, payload in sorted(files, key=lambda item: (item[0].casefold(), item[0])):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, payload)
        return output.getvalue()

    def _artifact_result(
        self,
        *,
        operation: str,
        arguments: Mapping[str, Any],
        invocation: Invocation,
        bundle: ManagedKiCadBundle,
        artifact: PublishedArtifact,
        extra_payload: Mapping[str, object],
        report: Mapping[str, object],
    ) -> KiCadServiceResult:
        path = self._workspace_publisher.artifact_path(
            bundle.project_id,
            bundle.project_revision,
            artifact,
        )
        payload: dict[str, object] = {
            "project_id": bundle.project_id,
            "project_revision": bundle.project_revision,
            "artifact_id": artifact.artifact_id,
            "artifact_sha256": artifact.artifact_sha256,
            "artifact_path": str(path),
            **extra_payload,
        }
        evidence = KiCadExecutionEvidence(
            worker=self.worker_id,
            kicad_version=self.kicad_version,
            operation=operation,
            project_id=bundle.project_id,
            expected_project_revision=bundle.project_revision,
            opened_project_digest=bundle.project_revision[4:],
            opened_bundle_sha256=bundle.bundle_sha256,
            runtime_support_sha256=runtime_support_manifest_sha256(bundle.stem),
            request_digest=stable_digest(arguments),
            payload_digest=stable_digest(payload),
            policy_digest=self.policy_digest,
            idempotency_key=invocation.idempotency_key,
            exit_code=0,
        )
        result = KiCadServiceResult(True, payload, evidence)
        complete_report = {
            "schema_version": 1,
            "worker": self.worker_id,
            "kicad_version": self.kicad_version,
            "policy_digest": self.policy_digest,
            "project_id": bundle.project_id,
            "project_revision": bundle.project_revision,
            "opened_bundle_sha256": bundle.bundle_sha256,
            "runtime_support_sha256": runtime_support_manifest_sha256(bundle.stem),
            "runtime_support_manifest": runtime_support_manifest(bundle.stem),
            "summary_digest": stable_digest(payload),
            "artifact_id": artifact.artifact_id,
            "artifact_sha256": artifact.artifact_sha256,
            "manufacturing_release_eligible": False,
            **report,
        }
        subject = self._subject(arguments, invocation, bundle, operation=operation)
        try:
            self._journal.complete(subject, self._result_material(result), complete_report)
        except JournalError as exc:
            raise KiCadServiceFailure(
                "kicad_journal_finalize_failed",
                "operation finished but its durable result could not be finalized",
            ) from exc
        return result

    def _recover_artifact(
        self,
        subject: JournalSubject,
    ) -> KiCadServiceResult | None:
        recovered = self._claim_or_recover(subject)
        if recovered is None:
            return None
        payload = recovered.payload
        artifact = PublishedArtifact(
            cast(str, payload["artifact_id"]),
            cast(str, payload["artifact_sha256"]),
        )
        path = self._workspace_publisher.artifact_path(
            subject.project_id,
            subject.project_revision,
            artifact,
        )
        if payload.get("artifact_path") != str(path):
            raise KiCadServiceFailure(
                "kicad_journal_tampered", "recovered artifact path binding is invalid"
            )
        return recovered

    def export_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        if type(arguments) is not dict or frozenset(arguments) != {
            "project_id",
            "expected_project_revision",
            "format",
        }:
            raise KiCadServiceFailure(
                "kicad_invalid_request", "export request has an invalid closed shape"
            )
        if arguments["format"] != "kicad_archive":
            raise KiCadServiceFailure(
                "kicad_export_format_unsupported",
                "workspace host exports only a non-release KiCad source archive",
            )
        trusted = self._verify_invocation(invocation)
        bundle = self._resolve_bundle(
            cast(str, arguments["project_id"]),
            cast(str, arguments["expected_project_revision"]),
        )
        subject = self._subject(arguments, trusted, bundle, operation="kicad_export")
        recovered = self._recover_artifact(subject)
        if recovered is not None:
            return recovered
        try:
            self._verify_executable_pin()
            payload = self._source_zip(bundle)
            digest = hashlib.sha256(payload).hexdigest()
            artifact = self._workspace_publisher.publish_artifact(
                project_id=bundle.project_id,
                project_revision=bundle.project_revision,
                media_type=_SOURCE_CANDIDATE_MEDIA_TYPE,
                payload=payload,
                expected_sha256=digest,
                idempotency_key=f"export:{trusted.idempotency_key}",
            )
            return self._artifact_result(
                operation="kicad_export",
                arguments=arguments,
                invocation=trusted,
                bundle=bundle,
                artifact=artifact,
                extra_payload={"format": "kicad_archive"},
                report={"native_execution": False, "source_archive": True},
            )
        except KiCadServiceFailure as failure:
            self._record_failure(subject, failure)
            raise

    @staticmethod
    def _validate_svg(payload: bytes) -> None:
        if b"<!DOCTYPE" in payload.upper():
            raise KiCadServiceFailure(
                "kicad_render_invalid", "rendered SVG cannot contain a document type"
            )
        try:
            root = ElementTree.fromstring(payload)
        except ElementTree.ParseError as exc:
            raise KiCadServiceFailure(
                "kicad_render_invalid", "KiCad render output is not valid SVG"
            ) from exc
        if not root.tag.endswith("svg"):
            raise KiCadServiceFailure(
                "kicad_render_invalid", "KiCad render output root is not SVG"
            )

    def _render_argv(
        self,
        view: str,
        workspace: Path,
        output: Path,
        bundle: ManagedKiCadBundle,
    ) -> tuple[str, ...]:
        if view == "pcb_2d":
            return (
                str(self._executable),
                "pcb",
                "export",
                "svg",
                "--output",
                str(output),
                "--layers",
                "F.Cu,F.Mask,F.Silkscreen,Edge.Cuts",
                "--page-size-mode",
                "2",
                "--exclude-drawing-sheet",
                "--mode-single",
                str(workspace / f"{bundle.stem}.kicad_pcb"),
            )
        if view == "schematic":
            return (
                str(self._executable),
                "sch",
                "export",
                "svg",
                "--output",
                str(output),
                "--exclude-drawing-sheet",
                str(workspace / f"{bundle.stem}.kicad_sch"),
            )
        raise KiCadServiceFailure(
            "kicad_render_view_unsupported",
            "workspace host supports schematic and pcb_2d SVG only",
        )

    def render_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        if type(arguments) is not dict or frozenset(arguments) != {
            "project_id",
            "expected_project_revision",
            "view",
            "format",
        }:
            raise KiCadServiceFailure(
                "kicad_invalid_request", "render request has an invalid closed shape"
            )
        if arguments["format"] != "svg":
            raise KiCadServiceFailure(
                "kicad_render_format_unsupported", "workspace host renders SVG only"
            )
        view = cast(str, arguments["view"])
        trusted = self._verify_invocation(invocation)
        bundle = self._resolve_bundle(
            cast(str, arguments["project_id"]),
            cast(str, arguments["expected_project_revision"]),
        )
        subject = self._subject(arguments, trusted, bundle, operation="kicad_render")
        recovered = self._recover_artifact(subject)
        if recovered is not None:
            return recovered
        try:
            self._verify_executable_pin()
            with self._operation_directory("render-") as root:
                runtime = root / "runtime"
                workspace = root / "project"
                output = root / ("schematic" if view == "schematic" else "render.svg")
                runtime.mkdir()
                workspace.mkdir()
                if view == "schematic":
                    output.mkdir()
                environment = self._environment(runtime)
                before = self._write_bundle(workspace, bundle)
                argv = self._render_argv(view, workspace, output, bundle)
                try:
                    completed = self._runner.run(
                        argv,
                        cwd=runtime,
                        environment=environment,
                        timeout_seconds=self._policy.timeout_seconds,
                        max_stdout_bytes=self._policy.max_stdout_bytes,
                        max_stderr_bytes=self._policy.max_stderr_bytes,
                    )
                except CommandTimeoutError as exc:
                    raise KiCadServiceFailure(
                        "kicad_cli_timeout", "KiCad rendering exceeded its timeout"
                    ) from exc
                except CommandOutputLimitError as exc:
                    raise KiCadServiceFailure(
                        "kicad_cli_output_oversize",
                        "KiCad rendering exceeded its output limit",
                    ) from exc
                except CommandLaunchError as exc:
                    raise KiCadServiceFailure(
                        "kicad_cli_launch_failed", "KiCad renderer could not be launched"
                    ) from exc
                if (
                    type(completed) is not CompletedCommand
                    or completed.argv != argv
                    or completed.exit_code != 0
                ):
                    raise KiCadServiceFailure(
                        "kicad_render_failed", "KiCad renderer returned a non-zero result"
                    )
                after = self._read_bundle_digests(workspace, bundle)
                if before != after:
                    raise KiCadServiceFailure(
                        "kicad_source_mutated",
                        "KiCad changed source bytes while rendering",
                    )
                if view == "schematic":
                    outputs = sorted(output.glob("*.svg"))
                    if len(outputs) != 1:
                        raise KiCadServiceFailure(
                            "kicad_render_output_count",
                            "schematic rendering must produce exactly one SVG",
                        )
                    rendered = outputs[0]
                else:
                    rendered = output
                metadata = rendered.lstat()
                if (
                    _is_link_or_reparse(metadata)
                    or not stat.S_ISREG(metadata.st_mode)
                    or not 1 <= metadata.st_size <= _MAX_RENDER_BYTES
                ):
                    raise KiCadServiceFailure(
                        "kicad_render_invalid", "KiCad render output is not a bounded file"
                    )
                rendered_payload = rendered.read_bytes()
                self._validate_svg(rendered_payload)
                if str(root).encode() in rendered_payload:
                    raise KiCadServiceFailure(
                        "kicad_render_path_leak",
                        "KiCad render output contains the temporary workspace path",
                    )
                digest = hashlib.sha256(rendered_payload).hexdigest()
                artifact = self._workspace_publisher.publish_artifact(
                    project_id=bundle.project_id,
                    project_revision=bundle.project_revision,
                    media_type="image/svg+xml",
                    payload=rendered_payload,
                    expected_sha256=digest,
                    idempotency_key=f"render:{trusted.idempotency_key}",
                )
                command_record = {
                    "argv": self._logical_argv(argv, workspace),
                    "argv_digest": stable_digest(self._logical_argv(argv, workspace)),
                    "stdout_sha256": hashlib.sha256(completed.stdout).hexdigest(),
                    "stderr_sha256": hashlib.sha256(completed.stderr).hexdigest(),
                    "source_file_sha256": before,
                    "source_file_sha256_after": after,
                }
            return self._artifact_result(
                operation="kicad_render",
                arguments=arguments,
                invocation=trusted,
                bundle=bundle,
                artifact=artifact,
                extra_payload={"view": view, "format": "svg"},
                report={"native_execution": True, "command": command_record},
            )
        except KiCadServiceFailure as failure:
            self._record_failure(subject, failure)
            raise


@dataclass(frozen=True, slots=True)
class ProjectHostRuntime:
    server: MCPStdioServer
    resolver: WorkspaceBundleResolver
    publisher: WorkspaceArtifactPublisher
    service: WorkspaceKiCadService
    state_root: Path

    @property
    def project_id(self) -> str:
        return self.resolver.project_id

    @property
    def project_revision(self) -> str:
        return self.resolver.snapshot().bundle.project_revision


def build_project_host(
    settings: ProjectHostSettings,
    *,
    runner: CommandRunner | None = None,
) -> ProjectHostRuntime:
    """Build one local stdio runtime without opening a port or daemon."""

    if type(settings) is not ProjectHostSettings:
        raise TypeError("build_project_host requires exact ProjectHostSettings")
    workspace_root = _safe_directory(settings.project_file.parent, "project workspace")
    state_root_candidate = settings.state_root.resolve(strict=False)
    if (
        state_root_candidate == workspace_root
        or state_root_candidate in workspace_root.parents
        or workspace_root in state_root_candidate.parents
    ):
        raise ProjectHostConfigurationError(
            "state_root and project workspace must be disjoint"
        )
    try:
        state_root = _prepare_private_directory(settings.state_root)
    except ReferenceHostConfigurationError as exc:
        raise ProjectHostConfigurationError(str(exc)) from exc
    resolver = WorkspaceBundleResolver(
        settings.project_file,
        project_id=settings.project_id,
        max_bundle_bytes=settings.max_bundle_bytes,
    )
    publisher = WorkspaceArtifactPublisher(
        state_root / "published-artifacts",
        maximum_bytes=settings.max_bundle_bytes,
    )
    journal_key = load_or_create_local_journal_key(state_root)
    journal_path = state_root / "kicad-worker-v1.sqlite3"
    _bind_journal_to_key(journal_path, journal_key)
    policy = WorkerPolicy(
        executable=cast(Path, settings.kicad_executable),
        executable_sha256=cast(str, settings.kicad_executable_sha256),
        kicad_version=cast(str, settings.kicad_version),
        worker_id=settings.worker_id,
        temp_root=state_root / "operations",
        journal_path=journal_path,
        journal_hmac_key=journal_key.key,
        journal_key_id=journal_key.key_id,
        timeout_seconds=settings.timeout_seconds,
        max_stdout_bytes=settings.max_stdout_bytes,
        max_stderr_bytes=settings.max_stderr_bytes,
        max_report_bytes=settings.max_report_bytes,
        max_bundle_bytes=settings.max_bundle_bytes,
    )
    service = WorkspaceKiCadService(policy, resolver, publisher, runner=runner)
    adapter = ReadOnlyWorkspaceAdapter(resolver)
    gateway = CapabilitySafeGateway(adapter)
    server = MCPStdioServer(
        gateway,
        HostConfig(
            principal=Principal(
                settings.actor_id,
                ActorKind.AGENT,
                ProfileName.RELEASE_MANAGER,
            ),
            kicad_service=service,
            allowed_project_ids=frozenset({settings.project_id}),
            kicad_worker=service.worker_id,
            kicad_version=service.kicad_version,
            kicad_policy_digest=service.policy_digest,
            durable_worker_idempotency=True,
            exposed_gateway_tools=frozenset({ToolName.INSPECT_PROJECT}),
            exposed_kicad_hooks=frozenset(
                {"kicad_export", "kicad_render", "kicad_verify"}
            ),
        ),
    )
    return ProjectHostRuntime(server, resolver, publisher, service, state_root)


__all__ = (
    "ProjectHostConfigurationError",
    "ProjectHostRuntime",
    "ProjectHostSettings",
    "ReadOnlyWorkspaceAdapter",
    "WorkspaceArtifactPublisher",
    "WorkspaceBundleResolver",
    "WorkspaceKiCadService",
    "build_project_host",
)

"""Exact host-side contracts for the pinned local KiCad CLI worker."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from backend.kicad_project import ProjectAuxiliaryFile, ProjectBundleInput
from backend.mcp_gateway import stable_digest

from .runtime_support import (
    RUNTIME_SUPPORT_POLICY_VERSION,
    RUNTIME_SUPPORT_TEMPLATE_SHA256,
)

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_REVISION = re.compile(r"^rev_[0-9a-f]{64}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_STEM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_VERSION = re.compile(r"^10\.[0-9]+\.[0-9]+$")


def _require_absolute_path(value: object, label: str) -> Path:
    if not isinstance(value, Path) or not value.is_absolute():
        raise ValueError(f"{label} must be an absolute pathlib.Path")
    return value


def _require_identifier(value: object, label: str) -> str:
    if type(value) is not str or _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(f"{label} must be a stable identifier")
    return value


def _require_revision(value: object, label: str) -> str:
    if type(value) is not str or _REVISION.fullmatch(value) is None:
        raise ValueError(f"{label} must be an exact rev_<sha256> revision")
    return value


def _require_sha256(value: object, label: str) -> str:
    if type(value) is not str or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _file_digest(file: ProjectAuxiliaryFile) -> dict[str, object]:
    return {
        "filename": file.relative_name,
        "media_type": file.media_type,
        "byte_length": len(file.payload),
        "sha256": hashlib.sha256(file.payload).hexdigest(),
    }


def managed_bundle_digest(
    stem: str,
    project_payload: bytes,
    schematic_payload: bytes,
    board_payload: bytes,
    auxiliary_files: tuple[ProjectAuxiliaryFile, ...] = (),
) -> str:
    """Return the worker's domain-separated identity for all managed project files."""

    if type(stem) is not str or _STEM.fullmatch(stem) is None:
        raise ValueError("managed bundle stem is invalid")
    if any(type(item) is not bytes for item in (project_payload, schematic_payload, board_payload)):
        raise TypeError("managed bundle payloads must be exact bytes")
    project_bundle = ProjectBundleInput(
        stem=stem,
        project_payload=project_payload,
        schematic_payload=schematic_payload,
        board_payload=board_payload,
        auxiliary_files=auxiliary_files,
    )
    return stable_digest(
        {
            "domain": "flux-clone-managed-kicad-bundle-v2",
            "stem": stem,
            "files": tuple(_file_digest(file) for file in project_bundle.all_files),
        }
    )


@dataclass(frozen=True, slots=True)
class ManagedKiCadBundle:
    """Immutable bytes resolved by a host for one exact canonical revision."""

    project_id: str
    project_revision: str
    stem: str
    project_payload: bytes
    schematic_payload: bytes
    board_payload: bytes
    bundle_sha256: str
    auxiliary_files: tuple[ProjectAuxiliaryFile, ...] = ()

    def __post_init__(self) -> None:
        if type(self) is not ManagedKiCadBundle:
            raise TypeError("managed bundle must use the exact ManagedKiCadBundle type")
        _require_identifier(self.project_id, "managed bundle project_id")
        _require_revision(self.project_revision, "managed bundle project_revision")
        if type(self.stem) is not str or _STEM.fullmatch(self.stem) is None:
            raise ValueError("managed bundle stem is invalid")
        payloads = (
            self.project_payload,
            self.schematic_payload,
            self.board_payload,
        )
        if any(type(payload) is not bytes or not payload for payload in payloads):
            raise ValueError("managed bundle files must be non-empty exact bytes")
        project_bundle = ProjectBundleInput(
            stem=self.stem,
            project_payload=self.project_payload,
            schematic_payload=self.schematic_payload,
            board_payload=self.board_payload,
            auxiliary_files=self.auxiliary_files,
        )
        _require_sha256(self.bundle_sha256, "managed bundle digest")
        expected = managed_bundle_digest(
            self.stem,
            *payloads,
            auxiliary_files=self.auxiliary_files,
        )
        if self.bundle_sha256 != expected:
            raise ValueError("managed bundle digest does not bind the supplied files")
        if self.all_files != project_bundle.all_files:
            raise ValueError("managed bundle complete file set is inconsistent")
        if any(
            file.relative_name.casefold().endswith(".kicad_prl")
            for file in self.auxiliary_files
        ):
            raise ValueError(
                "managed source bundle cannot contain worker runtime-support PRL files"
            )
        if any(
            file.relative_name.casefold() in {"erc.json", "drc.json"}
            for file in self.all_files
        ):
            raise ValueError("managed bundle cannot shadow reserved KiCad report outputs")

    @classmethod
    def create(
        cls,
        *,
        project_id: str,
        project_revision: str,
        stem: str,
        project_payload: bytes,
        schematic_payload: bytes,
        board_payload: bytes,
        auxiliary_files: tuple[ProjectAuxiliaryFile, ...] = (),
    ) -> ManagedKiCadBundle:
        return cls(
            project_id=project_id,
            project_revision=project_revision,
            stem=stem,
            project_payload=project_payload,
            schematic_payload=schematic_payload,
            board_payload=board_payload,
            bundle_sha256=managed_bundle_digest(
                stem,
                project_payload,
                schematic_payload,
                board_payload,
                auxiliary_files,
            ),
            auxiliary_files=auxiliary_files,
        )

    @property
    def all_files(self) -> tuple[ProjectAuxiliaryFile, ...]:
        return ProjectBundleInput(
            stem=self.stem,
            project_payload=self.project_payload,
            schematic_payload=self.schematic_payload,
            board_payload=self.board_payload,
            auxiliary_files=self.auxiliary_files,
        ).all_files

    @property
    def total_byte_length(self) -> int:
        return sum(len(file.payload) for file in self.all_files)


class BundleResolutionError(RuntimeError):
    """A trusted host could not resolve the requested managed revision."""


class ManagedBundleResolver(Protocol):
    """Host-owned lookup; tool arguments never contain a filesystem path."""

    def resolve_bundle(
        self,
        project_id: str,
        expected_project_revision: str,
    ) -> ManagedKiCadBundle: ...


@dataclass(frozen=True, slots=True)
class PublishedArtifact:
    artifact_id: str
    artifact_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not PublishedArtifact:
            raise TypeError("publication must use the exact PublishedArtifact type")
        _require_identifier(self.artifact_id, "artifact_id")
        _require_sha256(self.artifact_sha256, "artifact_sha256")


class ManagedArtifactPublisher(Protocol):
    """Host-owned publication boundary reserved for reviewed export/render work."""

    def publish_artifact(
        self,
        *,
        project_id: str,
        project_revision: str,
        media_type: str,
        payload: bytes,
        expected_sha256: str,
        idempotency_key: str,
    ) -> PublishedArtifact: ...


@dataclass(frozen=True, slots=True)
class WorkerPolicy:
    """Pinned executable, containment, resource, and journal policy."""

    executable: Path
    executable_sha256: str
    kicad_version: str
    worker_id: str
    temp_root: Path
    journal_path: Path
    journal_hmac_key: bytes = field(repr=False)
    journal_key_id: str
    timeout_seconds: int = 120
    max_stdout_bytes: int = 1_048_576
    max_stderr_bytes: int = 1_048_576
    max_report_bytes: int = 32 * 1_048_576
    max_bundle_bytes: int = 128 * 1_048_576
    refill_zones_on_temp_copy: bool = False

    def __post_init__(self) -> None:
        if type(self) is not WorkerPolicy:
            raise TypeError("worker policy must use the exact WorkerPolicy type")
        for value, label in (
            (self.executable, "KiCad executable"),
            (self.temp_root, "worker temp_root"),
            (self.journal_path, "worker journal_path"),
        ):
            _require_absolute_path(value, label)
        _require_sha256(self.executable_sha256, "KiCad executable digest")
        if type(self.kicad_version) is not str or _VERSION.fullmatch(self.kicad_version) is None:
            raise ValueError("worker requires an exact KiCad 10 patch version")
        _require_identifier(self.worker_id, "worker_id")
        _require_identifier(self.journal_key_id, "journal_key_id")
        if type(self.journal_hmac_key) is not bytes or len(self.journal_hmac_key) < 32:
            raise ValueError("journal HMAC key must contain at least 32 bytes")
        for name in (
            "timeout_seconds",
            "max_stdout_bytes",
            "max_stderr_bytes",
            "max_report_bytes",
            "max_bundle_bytes",
        ):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be a positive exact integer")
        if type(self.refill_zones_on_temp_copy) is not bool:
            raise ValueError("refill_zones_on_temp_copy must be an exact boolean")

    @property
    def policy_digest(self) -> str:
        return stable_digest(
            {
                "schema_version": 1,
                "worker_id": self.worker_id,
                "kicad_version": self.kicad_version,
                "executable_sha256": self.executable_sha256,
                "journal_key_id": self.journal_key_id,
                "timeout_seconds": self.timeout_seconds,
                "max_stdout_bytes": self.max_stdout_bytes,
                "max_stderr_bytes": self.max_stderr_bytes,
                "max_report_bytes": self.max_report_bytes,
                "max_bundle_bytes": self.max_bundle_bytes,
                "refill_zones_on_temp_copy": self.refill_zones_on_temp_copy,
                "environment_policy": "isolated-kicad-cli-v2-hermetic-project-files",
                "report_parsers": [
                    "https://schemas.kicad.org/drc.v1.json",
                    "https://schemas.kicad.org/erc.v1.json",
                ],
                "commands": {
                    "erc": [
                        "sch",
                        "erc",
                        "--format",
                        "json",
                        "--severity-all",
                        "--exit-code-violations",
                    ],
                    "drc": [
                        "pcb",
                        "drc",
                        "--format",
                        "json",
                        "--severity-all",
                        "--schematic-parity",
                        "--all-track-errors",
                        "--exit-code-violations",
                    ],
                },
                "managed_project_files": "complete-closed-all-files-v2",
                "runtime_support_policy_version": RUNTIME_SUPPORT_POLICY_VERSION,
                "runtime_support_template_sha256": RUNTIME_SUPPORT_TEMPLATE_SHA256,
                "manufacturing_release_authority": False,
            }
        )


__all__ = (
    "BundleResolutionError",
    "ManagedArtifactPublisher",
    "ManagedBundleResolver",
    "ManagedKiCadBundle",
    "PublishedArtifact",
    "WorkerPolicy",
    "managed_bundle_digest",
)

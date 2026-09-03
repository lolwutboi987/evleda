"""Concrete, pinned KiCad 10 CLI implementation of the MCP worker protocol."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

from backend.kicad_project import BundleLimits
from backend.mcp_gateway import Invocation, Principal, canonical_data, stable_digest
from backend.mcp_server.hooks import (
    KiCadExecutionEvidence,
    KiCadServiceFailure,
    KiCadServiceResult,
)

from .journal import (
    ClaimDisposition,
    JournalConflictError,
    JournalError,
    JournalSubject,
    JournalTamperedError,
    SQLiteIdempotencyJournal,
)
from .models import (
    BundleResolutionError,
    ManagedArtifactPublisher,
    ManagedBundleResolver,
    ManagedKiCadBundle,
    WorkerPolicy,
    managed_bundle_digest,
)
from .reports import KiCadReportError, ParsedCheckReport, parse_kicad_report
from .runner import (
    CommandLaunchError,
    CommandOutputLimitError,
    CommandRunner,
    CommandTimeoutError,
    CompletedCommand,
    SubprocessRunner,
)
from .runtime_support import (
    project_preferences_payload,
    runtime_support_manifest,
    runtime_support_manifest_sha256,
)

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_REVISION = re.compile(r"^rev_[0-9a-f]{64}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_VERSION = re.compile(r"^10\.[0-9]+\.[0-9]+$")
_VERIFY_KEYS = frozenset({"project_id", "expected_project_revision", "checks"})
_EXECUTION_ORDER = ("erc", "drc")
_PROJECT_LIMITS = BundleLimits()
_WINDOWS_RESERVED = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.I)
_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class KiCadWorkerConfigurationError(RuntimeError):
    """The host did not provide the worker's pinned runtime prerequisites."""


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _closed_dict(
    value: object,
    *,
    label: str,
    keys: frozenset[str],
) -> dict[str, object]:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an exact object")
    result = cast(dict[str, object], value)
    if frozenset(result) != keys:
        raise ValueError(f"{label} has an invalid closed shape")
    return result


def _safe_text(value: object, label: str) -> str:
    if type(value) is not str or not value or value != value.strip():
        raise ValueError(f"{label} must be non-empty trimmed text")
    if any(ord(character) < 32 for character in value):
        raise ValueError(f"{label} contains a control character")
    return value


class LocalKiCadCliService:
    """Verify exact managed revisions using only a pinned local KiCad executable.

    Import, export, and render deliberately remain unavailable until their
    mutating/publication semantics are separately specified and reviewed.
    """

    def __init__(
        self,
        policy: WorkerPolicy,
        bundle_resolver: ManagedBundleResolver,
        artifact_publisher: ManagedArtifactPublisher,
        *,
        runner: CommandRunner | None = None,
    ) -> None:
        if type(policy) is not WorkerPolicy:
            raise TypeError("LocalKiCadCliService requires an exact WorkerPolicy")
        if not callable(getattr(bundle_resolver, "resolve_bundle", None)):
            raise TypeError("bundle_resolver does not implement resolve_bundle")
        if not callable(getattr(artifact_publisher, "publish_artifact", None)):
            raise TypeError("artifact_publisher does not implement publish_artifact")
        actual_runner: CommandRunner = runner if runner is not None else SubprocessRunner()
        if not callable(getattr(actual_runner, "run", None)):
            raise TypeError("runner does not implement run")
        self._policy = policy
        self._resolver = bundle_resolver
        self._publisher = artifact_publisher
        self._runner = actual_runner
        self._executable = self._prepare_host()
        self._journal = SQLiteIdempotencyJournal(
            self._policy.journal_path,
            self._policy.journal_hmac_key,
        )
        self._kicad_version = self._probe_version()

    @property
    def worker_id(self) -> str:
        return self._policy.worker_id

    @property
    def kicad_version(self) -> str:
        return self._kicad_version

    @property
    def policy_digest(self) -> str:
        return self._policy.policy_digest

    def _prepare_host(self) -> Path:
        executable = self._policy.executable
        if executable.is_symlink():
            raise KiCadWorkerConfigurationError("KiCad executable cannot be a symlink")
        try:
            resolved_executable = executable.resolve(strict=True)
        except OSError as exc:
            raise KiCadWorkerConfigurationError("pinned KiCad executable is unavailable") from exc
        if not resolved_executable.is_file() or resolved_executable.name.lower() not in {
            "kicad-cli",
            "kicad-cli.exe",
        }:
            raise KiCadWorkerConfigurationError("pinned executable is not kicad-cli")
        if _sha256(resolved_executable.read_bytes()) != self._policy.executable_sha256:
            raise KiCadWorkerConfigurationError("KiCad executable digest does not match its pin")

        temp_root = self._policy.temp_root
        temp_root.mkdir(parents=True, exist_ok=True)
        if temp_root.is_symlink():
            raise KiCadWorkerConfigurationError("worker temp root cannot be a symlink")
        resolved_temp_root = temp_root.resolve(strict=True)
        if not resolved_temp_root.is_dir():
            raise KiCadWorkerConfigurationError("worker temp root is not a directory")
        journal_path = self._policy.journal_path
        if journal_path.exists() and journal_path.is_symlink():
            raise KiCadWorkerConfigurationError("worker journal cannot be a symlink")
        self._temp_root = resolved_temp_root
        return resolved_executable

    def _environment(self, operation_root: Path) -> dict[str, str]:
        home = operation_root / "home"
        roaming = operation_root / "appdata"
        local = operation_root / "localappdata"
        config = operation_root / "kicad-config"
        documents = operation_root / "documents"
        temp = operation_root / "tmp"
        for directory in (home, roaming, local, config, documents, temp):
            directory.mkdir(exist_ok=False)
        system_root = os.environ.get("SYSTEMROOT", os.environ.get("WINDIR", r"C:\Windows"))
        return {
            "APPDATA": str(roaming),
            "HOME": str(home),
            "KICAD_CONFIG_HOME": str(config),
            "KICAD_DOCUMENTS_HOME": str(documents),
            "LOCALAPPDATA": str(local),
            "PATH": str(self._executable.parent),
            "SYSTEMROOT": system_root,
            "TEMP": str(temp),
            "TMP": str(temp),
            "USERPROFILE": str(home),
            "WINDIR": system_root,
        }

    @contextmanager
    def _operation_directory(self, prefix: str) -> Generator[Path]:
        with tempfile.TemporaryDirectory(prefix=prefix, dir=self._temp_root) as value:
            root = Path(value).resolve(strict=True)
            if root.parent != self._temp_root:
                raise KiCadServiceFailure(
                    "kicad_temp_containment_failed",
                    "KiCad operation directory escaped the configured root",
                )
            yield root

    def _probe_version(self) -> str:
        with self._operation_directory("bootstrap-") as root:
            environment = self._environment(root)
            argv = (str(self._executable), "version")
            try:
                outcome = self._runner.run(
                    argv,
                    cwd=root,
                    environment=environment,
                    timeout_seconds=min(self._policy.timeout_seconds, 30),
                    max_stdout_bytes=4096,
                    max_stderr_bytes=4096,
                )
            except (CommandLaunchError, CommandOutputLimitError, CommandTimeoutError) as exc:
                raise KiCadWorkerConfigurationError("cannot query pinned KiCad version") from exc
        if type(outcome) is not CompletedCommand or outcome.argv != argv or outcome.exit_code != 0:
            raise KiCadWorkerConfigurationError("pinned KiCad version query failed")
        try:
            version = outcome.stdout.decode("utf-8", errors="strict").strip()
            stderr = outcome.stderr.decode("utf-8", errors="strict").strip()
        except UnicodeError as exc:
            raise KiCadWorkerConfigurationError("KiCad version output is not UTF-8") from exc
        if stderr or _VERSION.fullmatch(version) is None:
            raise KiCadWorkerConfigurationError("KiCad version output has unexpected syntax")
        if version != self._policy.kicad_version:
            raise KiCadWorkerConfigurationError("KiCad runtime version does not match its pin")
        return version

    def import_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        del arguments, invocation
        raise KiCadServiceFailure(
            "kicad_import_unconfigured",
            "Local KiCad import is not configured; canonical store mutation needs "
            "a reviewed adapter",
        )

    def export_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        del arguments, invocation
        raise KiCadServiceFailure(
            "kicad_export_unconfigured",
            "Local KiCad export is not configured; artifact publication needs "
            "a reviewed format adapter",
        )

    def render_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        del arguments, invocation
        raise KiCadServiceFailure(
            "kicad_render_unconfigured",
            "Local KiCad rendering is not configured for the requested closed view/format contract",
        )

    @staticmethod
    def _verify_arguments(arguments: Mapping[str, Any]) -> tuple[str, str, list[str]]:
        if type(arguments) is not dict:
            raise KiCadServiceFailure(
                "kicad_invalid_request",
                "KiCad worker arguments must be an exact object",
            )
        values = cast(dict[str, object], arguments)
        if frozenset(values) != _VERIFY_KEYS:
            raise KiCadServiceFailure(
                "kicad_invalid_request",
                "KiCad verification arguments have an invalid closed shape",
            )
        project_id = values["project_id"]
        revision = values["expected_project_revision"]
        checks: object = values["checks"]
        if type(project_id) is not str or _IDENTIFIER.fullmatch(project_id) is None:
            raise KiCadServiceFailure("kicad_invalid_request", "project_id is invalid")
        if type(revision) is not str or _REVISION.fullmatch(revision) is None:
            raise KiCadServiceFailure(
                "kicad_invalid_request", "expected_project_revision is invalid"
            )
        if type(checks) is not list or any(
            type(item) is not str or item not in {"drc", "erc"}
            for item in cast(list[object], checks)
        ):
            raise KiCadServiceFailure(
                "kicad_invalid_request", "checks must be an exact erc/drc array"
            )
        exact_checks = cast(list[str], checks)
        if not exact_checks or exact_checks != sorted(set(exact_checks)):
            raise KiCadServiceFailure(
                "kicad_invalid_request", "checks must be non-empty, sorted, and unique"
            )
        return project_id, revision, list(exact_checks)

    @staticmethod
    def _verify_invocation(invocation: Invocation) -> Invocation:
        if type(invocation) is not Invocation or type(invocation.principal) is not Principal:
            raise KiCadServiceFailure(
                "kicad_invalid_invocation", "KiCad worker invocation has an invalid type"
            )
        if (
            _IDENTIFIER.fullmatch(invocation.principal.actor_id) is None
            or _IDENTIFIER.fullmatch(invocation.idempotency_key) is None
        ):
            raise KiCadServiceFailure(
                "kicad_invalid_invocation", "KiCad worker invocation identity is invalid"
            )
        return invocation

    def _resolve_bundle(self, project_id: str, revision: str) -> ManagedKiCadBundle:
        try:
            bundle = self._resolver.resolve_bundle(project_id, revision)
        except BundleResolutionError as exc:
            raise KiCadServiceFailure(
                "kicad_bundle_unavailable",
                "Host could not resolve the exact managed KiCad revision",
            ) from exc
        if type(bundle) is not ManagedKiCadBundle:
            raise KiCadServiceFailure(
                "kicad_bundle_invalid", "Host returned an invalid managed bundle type"
            )
        if bundle.project_id != project_id or bundle.project_revision != revision:
            raise KiCadServiceFailure(
                "kicad_bundle_mismatch",
                "Resolved managed bundle does not match the requested project revision",
            )
        expected_digest = managed_bundle_digest(
            bundle.stem,
            bundle.project_payload,
            bundle.schematic_payload,
            bundle.board_payload,
            bundle.auxiliary_files,
        )
        if expected_digest != bundle.bundle_sha256:
            raise KiCadServiceFailure(
                "kicad_bundle_tampered", "Resolved managed bundle digest verification failed"
            )
        if bundle.total_byte_length > self._policy.max_bundle_bytes:
            raise KiCadServiceFailure(
                "kicad_bundle_oversize", "Resolved managed bundle exceeds the configured cap"
            )
        if (
            len(bundle.auxiliary_files) > _PROJECT_LIMITS.maximum_auxiliary_file_count
            or any(
                len(file.payload) > _PROJECT_LIMITS.maximum_auxiliary_file_bytes
                for file in bundle.auxiliary_files
            )
            or sum(len(file.payload) for file in bundle.auxiliary_files)
            > _PROJECT_LIMITS.maximum_auxiliary_total_bytes
        ):
            raise KiCadServiceFailure(
                "kicad_bundle_oversize",
                "Resolved managed auxiliary files exceed the configured project limits",
            )
        return bundle

    def _subject(
        self,
        arguments: Mapping[str, Any],
        invocation: Invocation,
        bundle: ManagedKiCadBundle,
        *,
        operation: str = "kicad_verify",
    ) -> JournalSubject:
        return JournalSubject(
            actor_id=invocation.principal.actor_id,
            operation=operation,
            policy_digest=self.policy_digest,
            idempotency_key=invocation.idempotency_key,
            request_digest=stable_digest(arguments),
            project_id=bundle.project_id,
            project_revision=bundle.project_revision,
            bundle_sha256=bundle.bundle_sha256,
            runtime_support_sha256=runtime_support_manifest_sha256(bundle.stem),
        )

    @staticmethod
    def _failure_material(failure: KiCadServiceFailure) -> dict[str, object]:
        return {
            "code": failure.code,
            "message": failure.message,
            "details": canonical_data(failure.details),
        }

    @staticmethod
    def _failure_from_material(value: dict[str, object]) -> KiCadServiceFailure:
        material = _closed_dict(
            value,
            label="journal failure",
            keys=frozenset({"code", "message", "details"}),
        )
        code = _safe_text(material["code"], "journal failure code")
        message = _safe_text(material["message"], "journal failure message")
        details = material["details"]
        if type(details) is not dict:
            raise ValueError("journal failure details must be an exact object")
        return KiCadServiceFailure(code, message, cast(dict[str, object], details))

    @staticmethod
    def _result_material(result: KiCadServiceResult) -> dict[str, object]:
        value = canonical_data(result)
        if type(value) is not dict:
            raise RuntimeError("canonical KiCad result is not an object")
        return cast(dict[str, object], value)

    @staticmethod
    def _result_from_material(value: dict[str, object]) -> KiCadServiceResult:
        material = _closed_dict(
            value,
            label="journal result",
            keys=frozenset({"succeeded", "payload", "evidence"}),
        )
        succeeded = material["succeeded"]
        payload = material["payload"]
        evidence_value = _closed_dict(
            material["evidence"],
            label="journal evidence",
            keys=frozenset(
                {
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
                }
            ),
        )
        if type(succeeded) is not bool or type(payload) is not dict:
            raise ValueError("journal result has invalid result types")
        evidence = KiCadExecutionEvidence(
            worker=cast(str, evidence_value["worker"]),
            kicad_version=cast(str, evidence_value["kicad_version"]),
            operation=cast(str, evidence_value["operation"]),
            project_id=cast(str, evidence_value["project_id"]),
            expected_project_revision=cast(
                str | None, evidence_value["expected_project_revision"]
            ),
            opened_project_digest=cast(str | None, evidence_value["opened_project_digest"]),
            opened_bundle_sha256=cast(str | None, evidence_value["opened_bundle_sha256"]),
            runtime_support_sha256=cast(str | None, evidence_value["runtime_support_sha256"]),
            request_digest=cast(str, evidence_value["request_digest"]),
            payload_digest=cast(str, evidence_value["payload_digest"]),
            policy_digest=cast(str, evidence_value["policy_digest"]),
            idempotency_key=cast(str, evidence_value["idempotency_key"]),
            exit_code=cast(int, evidence_value["exit_code"]),
        )
        return KiCadServiceResult(succeeded, cast(dict[str, object], payload), evidence)

    def _validate_recovered_result(
        self,
        result: KiCadServiceResult,
        subject: JournalSubject,
    ) -> None:
        evidence = result.evidence
        if (
            evidence.worker != self.worker_id
            or evidence.kicad_version != self.kicad_version
            or evidence.operation != subject.operation
            or evidence.project_id != subject.project_id
            or evidence.expected_project_revision != subject.project_revision
            or evidence.opened_project_digest != subject.project_revision[4:]
            or evidence.opened_bundle_sha256 != subject.bundle_sha256
            or evidence.runtime_support_sha256 != subject.runtime_support_sha256
            or evidence.request_digest != subject.request_digest
            or evidence.payload_digest != stable_digest(result.payload)
            or evidence.policy_digest != subject.policy_digest
            or evidence.idempotency_key != subject.idempotency_key
            or result.succeeded != (evidence.exit_code == 0)
        ):
            raise ValueError("journal result evidence is not bound to its subject")

    def _claim_or_recover(self, subject: JournalSubject) -> KiCadServiceResult | None:
        try:
            claim = self._journal.claim(subject)
        except JournalConflictError as exc:
            raise KiCadServiceFailure(
                "kicad_idempotency_conflict",
                "KiCad idempotency key is bound to different canonical input",
            ) from exc
        except JournalTamperedError as exc:
            raise KiCadServiceFailure(
                "kicad_journal_tampered",
                "KiCad idempotency journal authenticity check failed",
            ) from exc
        except JournalError as exc:
            raise KiCadServiceFailure(
                "kicad_journal_unavailable", "KiCad idempotency journal is unavailable"
            ) from exc
        if claim.disposition is ClaimDisposition.NEW:
            return None
        if claim.disposition is ClaimDisposition.AMBIGUOUS:
            raise KiCadServiceFailure(
                "kicad_prior_attempt_ambiguous",
                "A prior KiCad attempt may have executed; the worker will not run it again",
            )
        if claim.disposition is ClaimDisposition.FAILED:
            if claim.failure is None:
                raise KiCadServiceFailure(
                    "kicad_journal_tampered", "Failed journal claim lacks failure material"
                )
            try:
                raise self._failure_from_material(claim.failure)
            except ValueError as exc:
                raise KiCadServiceFailure(
                    "kicad_journal_tampered", "Stored KiCad failure is invalid"
                ) from exc
        if claim.result is None or claim.report is None:
            raise KiCadServiceFailure(
                "kicad_journal_tampered", "Completed journal claim lacks terminal material"
            )
        try:
            result = self._result_from_material(claim.result)
            self._validate_recovered_result(result, subject)
            report = claim.report
            summary_digest = result.payload.get(
                "report_digest",
                stable_digest(result.payload),
            )
            if report.get("summary_digest") != summary_digest:
                raise ValueError("journal report does not bind the recovered summary")
            if report.get("opened_bundle_sha256") != subject.bundle_sha256:
                raise ValueError("journal report does not bind the opened bundle")
            if report.get("runtime_support_sha256") != subject.runtime_support_sha256:
                raise ValueError("journal report does not bind runtime support")
            if (
                stable_digest(report.get("runtime_support_manifest"))
                != subject.runtime_support_sha256
            ):
                raise ValueError("journal runtime-support manifest digest is invalid")
        except (KeyError, TypeError, ValueError) as exc:
            raise KiCadServiceFailure(
                "kicad_journal_tampered", "Stored KiCad result is invalid"
            ) from exc
        return result

    def _record_failure(
        self,
        subject: JournalSubject,
        failure: KiCadServiceFailure,
    ) -> None:
        try:
            self._journal.fail(subject, self._failure_material(failure))
        except JournalError as exc:
            raise KiCadServiceFailure(
                "kicad_journal_finalize_failed",
                "KiCad attempt ended but its durable failure could not be finalized",
            ) from exc

    def _verify_executable_pin(self) -> None:
        try:
            digest = _sha256(self._executable.read_bytes())
        except OSError as exc:
            raise KiCadServiceFailure(
                "kicad_executable_unavailable", "Pinned KiCad executable is unavailable"
            ) from exc
        if digest != self._policy.executable_sha256:
            raise KiCadServiceFailure(
                "kicad_executable_changed", "Pinned KiCad executable changed after startup"
            )

    @staticmethod
    def _bundle_files(bundle: ManagedKiCadBundle) -> tuple[tuple[str, bytes], ...]:
        return tuple((file.relative_name, file.payload) for file in bundle.all_files)

    @staticmethod
    def _runtime_support_files(bundle: ManagedKiCadBundle) -> tuple[tuple[str, bytes], ...]:
        return (
            (
                f"{bundle.stem}.kicad_prl",
                project_preferences_payload(bundle.stem),
            ),
        )

    @classmethod
    def _runtime_support_digests(cls, bundle: ManagedKiCadBundle) -> dict[str, str]:
        return {
            filename: _sha256(payload)
            for filename, payload in cls._runtime_support_files(bundle)
        }

    @staticmethod
    def _managed_path(root: Path, relative_name: str) -> Path:
        parts = relative_name.split("/")
        if (
            not parts
            or any(
                not part
                or part in {".", ".."}
                or _WINDOWS_RESERVED.fullmatch(part) is not None
                for part in parts
            )
        ):
            raise KiCadServiceFailure(
                "kicad_bundle_invalid",
                "Managed project filename is not portable safe syntax",
            )
        destination = root.joinpath(*parts)
        if destination == root or root not in destination.parents:
            raise KiCadServiceFailure(
                "kicad_materialization_failed",
                "Managed filename failed containment",
            )
        return destination

    @staticmethod
    def _is_reparse(metadata: os.stat_result) -> bool:
        return bool(getattr(metadata, "st_file_attributes", 0) & _REPARSE_POINT)

    @classmethod
    def _ensure_managed_parent(cls, root: Path, destination: Path) -> None:
        current = root
        relative_parent = destination.parent.relative_to(root)
        for part in relative_parent.parts:
            current = current / part
            try:
                current.mkdir(exist_ok=True)
                metadata = current.lstat()
            except OSError as exc:
                raise KiCadServiceFailure(
                    "kicad_materialization_failed",
                    "Managed project directory could not be created",
                ) from exc
            if (
                stat.S_ISLNK(metadata.st_mode)
                or cls._is_reparse(metadata)
                or not stat.S_ISDIR(metadata.st_mode)
            ):
                raise KiCadServiceFailure(
                    "kicad_materialization_failed",
                    "Managed project directory traverses an unsafe node",
                )

    @classmethod
    def _workspace_inventory(cls, root: Path) -> tuple[frozenset[str], frozenset[str]]:
        files: set[str] = set()
        directories: set[str] = set()
        stack: list[tuple[Path, tuple[str, ...]]] = [(root, ())]
        try:
            while stack:
                directory, prefix = stack.pop()
                with os.scandir(directory) as entries:
                    ordered = sorted(entries, key=lambda item: (item.name.casefold(), item.name))
                for entry in ordered:
                    relative_parts = (*prefix, entry.name)
                    relative_name = "/".join(relative_parts)
                    metadata = entry.stat(follow_symlinks=False)
                    if entry.is_symlink() or cls._is_reparse(metadata):
                        raise KiCadServiceFailure(
                            "kicad_workspace_mutated",
                            "KiCad workspace contains an unsafe filesystem node",
                        )
                    if stat.S_ISDIR(metadata.st_mode):
                        directories.add(relative_name)
                        stack.append((Path(entry.path), relative_parts))
                    elif stat.S_ISREG(metadata.st_mode):
                        files.add(relative_name)
                    else:
                        raise KiCadServiceFailure(
                            "kicad_workspace_mutated",
                            "KiCad workspace contains an unsupported filesystem node",
                        )
        except KiCadServiceFailure:
            raise
        except OSError as exc:
            raise KiCadServiceFailure(
                "kicad_workspace_unavailable",
                "KiCad workspace could not be inventoried",
            ) from exc
        folded = [name.casefold() for name in (*files, *directories)]
        if len(folded) != len(set(folded)):
            raise KiCadServiceFailure(
                "kicad_workspace_mutated",
                "KiCad workspace contains a portable name collision",
            )
        return frozenset(files), frozenset(directories)

    @classmethod
    def _expected_directories(cls, bundle: ManagedKiCadBundle) -> frozenset[str]:
        result: set[str] = set()
        for file in bundle.all_files:
            parts = file.relative_name.split("/")[:-1]
            for index in range(1, len(parts) + 1):
                result.add("/".join(parts[:index]))
        return frozenset(result)

    @classmethod
    def _write_bundle(cls, root: Path, bundle: ManagedKiCadBundle) -> dict[str, str]:
        source_files = cls._bundle_files(bundle)
        runtime_support = cls._runtime_support_files(bundle)
        if any(filename.casefold().endswith(".kicad_prl") for filename, _ in source_files):
            raise KiCadServiceFailure(
                "kicad_bundle_invalid",
                "Managed source bundle contains a runtime-support PRL",
            )
        for filename, payload in (*source_files, *runtime_support):
            destination = cls._managed_path(root, filename)
            cls._ensure_managed_parent(root, destination)
            if destination.exists() or destination.is_symlink():
                raise KiCadServiceFailure(
                    "kicad_materialization_failed", "Managed filename failed containment"
                )
            try:
                with destination.open("xb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                persisted = destination.read_bytes()
            except OSError as exc:
                raise KiCadServiceFailure(
                    "kicad_materialization_failed", "Managed KiCad bytes could not be materialized"
                ) from exc
            if persisted != payload or _sha256(persisted) != _sha256(payload):
                raise KiCadServiceFailure(
                    "kicad_materialization_tampered",
                    "Materialized KiCad file does not match managed bytes",
                )
        return cls._read_bundle_digests(root, bundle)

    @classmethod
    def _read_bundle_digests(
        cls,
        root: Path,
        bundle: ManagedKiCadBundle,
        allowed_reports: frozenset[str] = frozenset(),
    ) -> dict[str, str]:
        source_files = cls._bundle_files(bundle)
        runtime_support = cls._runtime_support_files(bundle)
        expected_files = {
            filename for filename, _ in (*source_files, *runtime_support)
        }
        actual_files, actual_directories = cls._workspace_inventory(root)
        missing_runtime_support = {
            filename for filename, _ in runtime_support
        } - actual_files
        if missing_runtime_support:
            raise KiCadServiceFailure(
                "kicad_runtime_support_mutated",
                "KiCad runtime-support file disappeared",
            )
        missing = expected_files - actual_files
        unexpected = actual_files - expected_files - allowed_reports
        expected_directories = cls._expected_directories(bundle)
        if missing or unexpected or actual_directories != expected_directories:
            raise KiCadServiceFailure(
                "kicad_workspace_mutated",
                "KiCad workspace no longer matches the exact managed file set",
                {
                    "missing": sorted(missing),
                    "unexpected": sorted(unexpected),
                    "unexpected_directories": sorted(
                        actual_directories - expected_directories
                    ),
                },
            )
        result: dict[str, str] = {}
        for filename, _ in source_files:
            path = cls._managed_path(root, filename)
            try:
                metadata = path.lstat()
            except OSError as exc:
                raise KiCadServiceFailure(
                    "kicad_source_mutated", "KiCad source file became unreadable"
                ) from exc
            if (
                stat.S_ISLNK(metadata.st_mode)
                or cls._is_reparse(metadata)
                or not stat.S_ISREG(metadata.st_mode)
            ):
                raise KiCadServiceFailure(
                    "kicad_source_mutated", "KiCad source file changed type during verification"
                )
            try:
                result[filename] = _sha256(path.read_bytes())
            except OSError as exc:
                raise KiCadServiceFailure(
                    "kicad_source_mutated", "KiCad source file became unreadable"
                ) from exc
        for filename, expected_payload in runtime_support:
            path = cls._managed_path(root, filename)
            try:
                metadata = path.lstat()
                persisted = path.read_bytes()
            except OSError as exc:
                raise KiCadServiceFailure(
                    "kicad_runtime_support_mutated",
                    "KiCad runtime-support file became unavailable",
                ) from exc
            if (
                stat.S_ISLNK(metadata.st_mode)
                or cls._is_reparse(metadata)
                or not stat.S_ISREG(metadata.st_mode)
                or persisted != expected_payload
            ):
                raise KiCadServiceFailure(
                    "kicad_runtime_support_mutated",
                    "KiCad changed a policy-bound runtime-support file",
                )
        return result

    def _command(self, check: str, root: Path, bundle: ManagedKiCadBundle) -> tuple[str, ...]:
        report = root / f"{check}.json"
        if check == "erc":
            return (
                str(self._executable),
                "sch",
                "erc",
                "--format",
                "json",
                "--severity-all",
                "--exit-code-violations",
                "--output",
                str(report),
                str(root / f"{bundle.stem}.kicad_sch"),
            )
        base = (
            str(self._executable),
            "pcb",
            "drc",
            "--format",
            "json",
            "--severity-all",
            "--schematic-parity",
            "--all-track-errors",
            "--exit-code-violations",
        )
        if self._policy.refill_zones_on_temp_copy:
            base = (*base, "--refill-zones")
        return (
            *base,
            "--output",
            str(report),
            str(root / f"{bundle.stem}.kicad_pcb"),
        )

    @staticmethod
    def _normalize_output(payload: bytes, root: Path) -> str:
        try:
            value = payload.decode("utf-8", errors="strict").replace("\r\n", "\n")
        except UnicodeError as exc:
            raise KiCadServiceFailure(
                "kicad_output_invalid", "KiCad process output is not strict UTF-8"
            ) from exc
        value = value.replace(str(root), "<WORKDIR>").replace(root.as_posix(), "<WORKDIR>")
        if any(ord(character) < 32 and character not in "\n\t" for character in value):
            raise KiCadServiceFailure(
                "kicad_output_invalid", "KiCad process output contains control characters"
            )
        return value.rstrip()

    @staticmethod
    def _logical_argv(argv: tuple[str, ...], root: Path) -> list[str]:
        result: list[str] = []
        for index, item in enumerate(argv):
            if index == 0:
                result.append("kicad-cli")
            else:
                result.append(
                    item.replace(str(root), "<WORKDIR>").replace(
                        root.as_posix(), "<WORKDIR>"
                    )
                )
        return result

    def _run_check(
        self,
        check: str,
        project_root: Path,
        command_cwd: Path,
        environment: dict[str, str],
        bundle: ManagedKiCadBundle,
    ) -> tuple[ParsedCheckReport, dict[str, object], int]:
        argv = self._command(check, project_root, bundle)
        try:
            outcome = self._runner.run(
                argv,
                cwd=command_cwd,
                environment=environment,
                timeout_seconds=self._policy.timeout_seconds,
                max_stdout_bytes=self._policy.max_stdout_bytes,
                max_stderr_bytes=self._policy.max_stderr_bytes,
            )
        except CommandTimeoutError as exc:
            raise KiCadServiceFailure(
                "kicad_cli_timeout", "KiCad verification exceeded its configured timeout"
            ) from exc
        except CommandOutputLimitError as exc:
            raise KiCadServiceFailure(
                "kicad_cli_output_oversize",
                "KiCad verification exceeded its configured output cap",
                {"stream": exc.stream},
            ) from exc
        except CommandLaunchError as exc:
            raise KiCadServiceFailure(
                "kicad_cli_launch_failed", "KiCad verification process could not be launched"
            ) from exc
        if type(outcome) is not CompletedCommand or outcome.argv != argv:
            raise KiCadServiceFailure(
                "kicad_runner_invalid", "KiCad command runner returned an invalid outcome"
            )
        stdout = self._normalize_output(outcome.stdout, project_root)
        stderr = self._normalize_output(outcome.stderr, project_root)
        command_record: dict[str, object] = {
            "argv": self._logical_argv(argv, project_root),
            "argv_digest": stable_digest(self._logical_argv(argv, project_root)),
            "check": check,
            "exit_code": outcome.exit_code,
            "stderr": stderr,
            "stderr_sha256": _sha256(outcome.stderr),
            "stdout": stdout,
            "stdout_sha256": _sha256(outcome.stdout),
        }
        if outcome.exit_code not in {0, 5}:
            raise KiCadServiceFailure(
                "kicad_cli_tool_error",
                "KiCad could not execute the requested verification check",
                {
                    "check": check,
                    "exit_code": outcome.exit_code,
                    "stderr": stderr[-4000:],
                    "stderr_sha256": _sha256(outcome.stderr),
                    "stdout": stdout[-4000:],
                    "stdout_sha256": _sha256(outcome.stdout),
                },
            )
        report_path = project_root / f"{check}.json"
        try:
            report_metadata = report_path.lstat()
        except OSError as exc:
            raise KiCadServiceFailure(
                "kicad_report_missing", "KiCad did not create a regular JSON report"
            ) from exc
        if (
            stat.S_ISLNK(report_metadata.st_mode)
            or self._is_reparse(report_metadata)
            or not stat.S_ISREG(report_metadata.st_mode)
        ):
            raise KiCadServiceFailure(
                "kicad_report_missing", "KiCad did not create a regular JSON report"
            )
        try:
            size = report_path.stat().st_size
            if size < 1 or size > self._policy.max_report_bytes:
                raise KiCadServiceFailure(
                    "kicad_report_oversize", "KiCad report violates the configured byte cap"
                )
            report_payload = report_path.read_bytes()
        except OSError as exc:
            raise KiCadServiceFailure(
                "kicad_report_unreadable", "KiCad JSON report could not be read"
            ) from exc
        source = f"{bundle.stem}.kicad_{'sch' if check == 'erc' else 'pcb'}"
        try:
            parsed = parse_kicad_report(
                check,
                report_payload,
                expected_source=source,
                expected_version=self.kicad_version,
            )
        except KiCadReportError as exc:
            raise KiCadServiceFailure(
                "kicad_report_invalid", "KiCad returned a report outside the pinned JSON contract"
            ) from exc
        expected_exit = 0 if not parsed.findings else 5
        if outcome.exit_code != expected_exit:
            raise KiCadServiceFailure(
                "kicad_report_exit_mismatch",
                "KiCad report findings conflict with the process exit status",
                {
                    "check": check,
                    "exit_code": outcome.exit_code,
                    "finding_count": len(parsed.findings),
                },
            )
        command_record["raw_report_sha256"] = parsed.raw_sha256
        command_record["report"] = parsed.normalized_report
        return parsed, command_record, outcome.exit_code

    def _execute_verification(
        self,
        subject: JournalSubject,
        bundle: ManagedKiCadBundle,
        checks: list[str],
    ) -> tuple[KiCadServiceResult, dict[str, object]]:
        self._verify_executable_pin()
        with self._operation_directory("verify-") as root:
            runtime_root = root / "runtime"
            workspace_root = root / "project"
            try:
                runtime_root.mkdir(exist_ok=False)
                workspace_root.mkdir(exist_ok=False)
                for directory in (runtime_root, workspace_root):
                    metadata = directory.lstat()
                    if (
                        stat.S_ISLNK(metadata.st_mode)
                        or self._is_reparse(metadata)
                        or not stat.S_ISDIR(metadata.st_mode)
                    ):
                        raise KiCadServiceFailure(
                            "kicad_temp_containment_failed",
                            "KiCad operation directory contains an unsafe node",
                        )
            except KiCadServiceFailure:
                raise
            except OSError as exc:
                raise KiCadServiceFailure(
                    "kicad_temp_containment_failed",
                    "KiCad operation directories could not be created",
                ) from exc
            environment = self._environment(runtime_root)
            before = self._write_bundle(workspace_root, bundle)
            reports: list[ParsedCheckReport] = []
            command_records: list[dict[str, object]] = []
            exit_codes: list[int] = []
            allowed_reports: set[str] = set()
            for check in _EXECUTION_ORDER:
                if check not in checks:
                    continue
                preflight = self._read_bundle_digests(
                    workspace_root,
                    bundle,
                    frozenset(allowed_reports),
                )
                if preflight != before:
                    raise KiCadServiceFailure(
                        "kicad_source_mutated",
                        "Managed KiCad source changed before native verification",
                        {"before": before, "after": preflight},
                    )
                try:
                    parsed, command_record, exit_code = self._run_check(
                        check,
                        workspace_root,
                        runtime_root,
                        environment,
                        bundle,
                    )
                except KiCadServiceFailure as failure:
                    allowed_reports.add(f"{check}.json")
                    failure_state = self._read_bundle_digests(
                        workspace_root,
                        bundle,
                        frozenset(allowed_reports),
                    )
                    if failure_state != before:
                        raise KiCadServiceFailure(
                            "kicad_source_mutated",
                            "Managed KiCad source changed during failed verification",
                            {"before": before, "after": failure_state},
                        ) from failure
                    partial = [
                        {
                            "argv_digest": item["argv_digest"],
                            "check": item["check"],
                            "exit_code": item["exit_code"],
                            "normalized_report_digest": stable_digest(item["report"]),
                            "raw_report_sha256": item["raw_report_sha256"],
                            "stderr_sha256": item["stderr_sha256"],
                            "stdout_sha256": item["stdout_sha256"],
                        }
                        for item in command_records
                    ]
                    raise KiCadServiceFailure(
                        failure.code,
                        failure.message,
                        {
                            **cast(dict[str, object], canonical_data(failure.details)),
                            "opened_bundle_sha256": subject.bundle_sha256,
                            "runtime_support_sha256": subject.runtime_support_sha256,
                            "partial_checks": partial,
                        },
                    ) from failure
                reports.append(parsed)
                command_records.append(command_record)
                exit_codes.append(exit_code)
                allowed_reports.add(f"{check}.json")
                interim = self._read_bundle_digests(
                    workspace_root,
                    bundle,
                    frozenset(allowed_reports),
                )
                if interim != before:
                    raise KiCadServiceFailure(
                        "kicad_source_mutated",
                        "KiCad changed a managed source file during read-only verification",
                        {"before": before, "after": interim},
                    )
            after = self._read_bundle_digests(
                workspace_root,
                bundle,
                frozenset(allowed_reports),
            )
            if after != before:
                raise KiCadServiceFailure(
                    "kicad_source_mutated",
                    "KiCad changed a managed source file during read-only verification",
                    {"before": before, "after": after},
                )

        findings = sorted(
            (finding for report in reports for finding in report.findings),
            key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
        )
        passed = not findings
        aggregate_exit = 0 if passed else 5
        if any(code not in {0, 5} for code in exit_codes) or (
            passed and any(code != 0 for code in exit_codes)
        ):
            raise KiCadServiceFailure(
                "kicad_aggregate_exit_invalid", "KiCad aggregate status is inconsistent"
            )
        check_bindings = [
            {
                "argv_digest": item["argv_digest"],
                "check": item["check"],
                "exit_code": item["exit_code"],
                "normalized_report_digest": stable_digest(item["report"]),
                "raw_report_sha256": item["raw_report_sha256"],
                "stderr_sha256": item["stderr_sha256"],
                "stdout_sha256": item["stdout_sha256"],
            }
            for item in command_records
        ]
        runtime_support_file_sha256 = self._runtime_support_digests(bundle)
        findings_manifest: dict[str, object] = {
            "schema_version": 1,
            "project_id": subject.project_id,
            "project_revision": subject.project_revision,
            "opened_bundle_sha256": subject.bundle_sha256,
            "runtime_support_sha256": subject.runtime_support_sha256,
            "runtime_support_file_sha256": runtime_support_file_sha256,
            "worker": self.worker_id,
            "kicad_version": self.kicad_version,
            "policy_digest": subject.policy_digest,
            "checks": check_bindings,
            "source_file_sha256": before,
            "source_file_sha256_after": after,
            "findings": findings,
        }
        findings_digest = stable_digest(findings_manifest)
        payload: dict[str, object] = {
            "project_id": subject.project_id,
            "project_revision": subject.project_revision,
            "checks": checks,
            "passed": passed,
            "blocking_findings": len(findings),
            "findings_digest": findings_digest,
        }
        payload["report_digest"] = stable_digest(payload)
        evidence = KiCadExecutionEvidence(
            worker=self.worker_id,
            kicad_version=self.kicad_version,
            operation="kicad_verify",
            project_id=subject.project_id,
            expected_project_revision=subject.project_revision,
            opened_project_digest=subject.project_revision[4:],
            opened_bundle_sha256=subject.bundle_sha256,
            runtime_support_sha256=subject.runtime_support_sha256,
            request_digest=subject.request_digest,
            payload_digest=stable_digest(payload),
            policy_digest=subject.policy_digest,
            idempotency_key=subject.idempotency_key,
            exit_code=aggregate_exit,
        )
        result = KiCadServiceResult(passed, payload, evidence)
        report_material: dict[str, object] = {
            "schema_version": 1,
            "worker": self.worker_id,
            "kicad_version": self.kicad_version,
            "policy_digest": subject.policy_digest,
            "project_id": subject.project_id,
            "project_revision": subject.project_revision,
            "opened_bundle_sha256": subject.bundle_sha256,
            "runtime_support_sha256": subject.runtime_support_sha256,
            "runtime_support_manifest": runtime_support_manifest(bundle.stem),
            "runtime_support_file_sha256": runtime_support_file_sha256,
            "source_file_sha256": before,
            "source_file_sha256_after": after,
            "commands": command_records,
            "findings": findings,
            "findings_manifest": findings_manifest,
            "findings_digest": findings_digest,
            "summary_digest": payload["report_digest"],
            "payload_digest": evidence.payload_digest,
            "idempotency_key": subject.idempotency_key,
            "manufacturing_release_eligible": False,
        }
        return result, report_material

    def verify_project(
        self, arguments: Mapping[str, Any], invocation: Invocation
    ) -> KiCadServiceResult:
        project_id, revision, checks = self._verify_arguments(arguments)
        trusted_invocation = self._verify_invocation(invocation)
        bundle = self._resolve_bundle(project_id, revision)
        subject = self._subject(arguments, trusted_invocation, bundle)
        recovered = self._claim_or_recover(subject)
        if recovered is not None:
            return recovered
        try:
            result, report = self._execute_verification(subject, bundle, checks)
        except KiCadServiceFailure as failure:
            self._record_failure(subject, failure)
            raise
        try:
            self._journal.complete(subject, self._result_material(result), report)
        except JournalError as exc:
            raise KiCadServiceFailure(
                "kicad_journal_finalize_failed",
                "KiCad verification finished but its durable result could not be finalized",
            ) from exc
        return result


__all__ = ("KiCadWorkerConfigurationError", "LocalKiCadCliService")

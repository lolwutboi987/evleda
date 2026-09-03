from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from collections.abc import Mapping
from pathlib import Path
from typing import NoReturn

import pytest

from backend.kicad_project import ProjectAuxiliaryFile, ProjectInvariantError
from backend.kicad_worker import (
    CommandOutputLimitError,
    CommandTimeoutError,
    CompletedCommand,
    LocalKiCadCliService,
    ManagedKiCadBundle,
    PublishedArtifact,
    WorkerPolicy,
)
from backend.kicad_worker.runtime_support import (
    project_preferences_payload,
    runtime_support_manifest_sha256,
)
from backend.mcp_gateway import (
    ActorKind,
    Invocation,
    Principal,
    ProfileName,
    stable_digest,
)
from backend.mcp_server.hooks import KiCadOperationService, KiCadServiceFailure

VERSION = "10.0.6"
REVISION = "rev_" + "a" * 64
UUID = "11111111-1111-4111-8111-111111111111"


class StaticResolver:
    def __init__(self, bundle: ManagedKiCadBundle) -> None:
        self.bundle = bundle
        self.calls: list[tuple[str, str]] = []

    def resolve_bundle(
        self, project_id: str, expected_project_revision: str
    ) -> ManagedKiCadBundle:
        self.calls.append((project_id, expected_project_revision))
        return self.bundle


class RecordingPublisher:
    def __init__(self) -> None:
        self.calls = 0

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
        del project_id, project_revision, media_type, payload, idempotency_key
        self.calls += 1
        return PublishedArtifact("artifact-test", expected_sha256)


class SimulatedCrash(BaseException):
    pass


class FakeRunner:
    def __init__(
        self,
        *,
        findings: bool = False,
        tool_exit: int | None = None,
        failure: BaseException | None = None,
        extra_report_key: bool = False,
        oversize_report: bool = False,
        mutate_source: bool = False,
        unexpected_path: str | None = None,
        unexpected_directory: str | None = None,
        mutate_auxiliary: str | None = None,
        mutate_runtime_support: bool = False,
        remove_runtime_support: bool = False,
    ) -> None:
        self.findings = findings
        self.tool_exit = tool_exit
        self.failure = failure
        self.extra_report_key = extra_report_key
        self.oversize_report = oversize_report
        self.mutate_source = mutate_source
        self.unexpected_path = unexpected_path
        self.unexpected_directory = unexpected_directory
        self.mutate_auxiliary = mutate_auxiliary
        self.mutate_runtime_support = mutate_runtime_support
        self.remove_runtime_support = remove_runtime_support
        self.calls: list[tuple[tuple[str, ...], Path, dict[str, str]]] = []

    @staticmethod
    def _finding() -> dict[str, object]:
        return {
            "description": "Pins are not connected",
            "items": [
                {
                    "description": "Pin U1.1",
                    "pos": {"x": 1.25, "y": 2},
                    "uuid": UUID,
                }
            ],
            "severity": "error",
            "type": "pin_not_connected",
        }

    def _report(self, check: str, source: str) -> bytes:
        common: dict[str, object] = {
            "$schema": f"https://schemas.kicad.org/{check}.v1.json",
            "coordinate_units": "mm",
            "date": "2026-08-31T12:00:00",
            "ignored_checks": [],
            "included_severities": ["error", "warning", "exclusion"],
            "kicad_version": VERSION,
            "source": source,
        }
        values = [self._finding()] if self.findings else []
        if check == "erc":
            common["sheets"] = [
                {"path": "/", "uuid_path": f"/{UUID}", "violations": values}
            ]
        else:
            common.update(
                {
                    "schematic_parity": [],
                    "unconnected_items": [],
                    "violations": values,
                }
            )
        if self.extra_report_key:
            common["injected"] = "rejected"
        return json.dumps(common, separators=(",", ":"), sort_keys=True).encode()

    def run(
        self,
        argv: tuple[str, ...],
        *,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: int,
        max_stdout_bytes: int,
        max_stderr_bytes: int,
    ) -> CompletedCommand:
        del timeout_seconds, max_stdout_bytes, max_stderr_bytes
        self.calls.append((argv, cwd, dict(environment)))
        if argv[1:] == ("version",):
            return CompletedCommand(argv, 0, f"{VERSION}\n".encode(), b"")
        if self.failure is not None:
            raise self.failure
        project_root = Path(argv[-1]).parent
        check = "erc" if argv[1:3] == ("sch", "erc") else "drc"
        if self.tool_exit is not None:
            return CompletedCommand(argv, self.tool_exit, b"load failed", b"invalid file")
        report_path = Path(argv[argv.index("--output") + 1])
        report = self._report(check, Path(argv[-1]).name)
        if self.oversize_report:
            report += b" " * 10_000
        report_path.write_bytes(report)
        if self.mutate_source:
            Path(argv[-1]).write_bytes(b"mutated")
        if self.mutate_auxiliary is not None:
            auxiliary = project_root.joinpath(*self.mutate_auxiliary.split("/"))
            auxiliary.write_bytes(b"mutated auxiliary bytes")
        runtime_support = project_root / "worker_fixture.kicad_prl"
        if self.mutate_runtime_support:
            runtime_support.write_bytes(b"mutated runtime support")
        if self.remove_runtime_support:
            runtime_support.unlink()
        if self.unexpected_path is not None:
            unexpected = project_root.joinpath(*self.unexpected_path.split("/"))
            unexpected.parent.mkdir(parents=True, exist_ok=True)
            unexpected.write_bytes(b"unexpected")
        if self.unexpected_directory is not None:
            unexpected_directory = project_root.joinpath(
                *self.unexpected_directory.split("/")
            )
            unexpected_directory.mkdir(parents=True, exist_ok=True)
        exit_code = 5 if self.findings else 0
        return CompletedCommand(
            argv,
            exit_code,
            f"Saved report to {report_path}\n".encode(),
            b"",
        )


class DesignRulesRunner(FakeRunner):
    def __init__(self, expected_files: Mapping[str, bytes]) -> None:
        super().__init__()
        self.expected_files = dict(expected_files)
        self.rules_observations = 0

    def run(
        self,
        argv: tuple[str, ...],
        *,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: int,
        max_stdout_bytes: int,
        max_stderr_bytes: int,
    ) -> CompletedCommand:
        if argv[1:] != ("version",):
            project_root = Path(argv[-1]).parent
            for relative_name, expected_payload in self.expected_files.items():
                path = project_root.joinpath(*relative_name.split("/"))
                assert path.read_bytes() == expected_payload
            self.rules_observations += 1
        return super().run(
            argv,
            cwd=cwd,
            environment=environment,
            timeout_seconds=timeout_seconds,
            max_stdout_bytes=max_stdout_bytes,
            max_stderr_bytes=max_stderr_bytes,
        )


class ReparseAuxiliaryRunner(FakeRunner):
    def run(
        self,
        argv: tuple[str, ...],
        *,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: int,
        max_stdout_bytes: int,
        max_stderr_bytes: int,
    ) -> CompletedCommand:
        if argv[1:] != ("version",):
            project_root = Path(argv[-1]).parent
            source = project_root / "Flux.kicad_sym"
            target = project_root.parent / "outside-symbol-library"
            target.write_bytes(source.read_bytes())
            source.unlink()
            try:
                os.symlink(target, source)
            except OSError:
                pytest.skip("file symlink creation is unavailable on this host")
        return super().run(
            argv,
            cwd=cwd,
            environment=environment,
            timeout_seconds=timeout_seconds,
            max_stdout_bytes=max_stdout_bytes,
            max_stderr_bytes=max_stderr_bytes,
        )


def bundle() -> ManagedKiCadBundle:
    return ManagedKiCadBundle.create(
        project_id="project-worker",
        project_revision=REVISION,
        stem="worker_fixture",
        project_payload=b"project-bytes",
        schematic_payload=b"schematic-bytes",
        board_payload=b"board-bytes",
    )


def bundle_with_auxiliary() -> ManagedKiCadBundle:
    auxiliary_files = tuple(
        sorted(
            (
                ProjectAuxiliaryFile(
                    "Flux.kicad_sym",
                    "application/x-kicad-symbol-library",
                    b"symbol-library",
                ),
                ProjectAuxiliaryFile(
                    "Flux.pretty/USB4105.kicad_mod",
                    "application/x-kicad-footprint",
                    b"footprint-module",
                ),
                ProjectAuxiliaryFile(
                    "fp-lib-table",
                    "application/x-kicad-library-table",
                    b"footprint-table",
                ),
                ProjectAuxiliaryFile(
                    "sym-lib-table",
                    "application/x-kicad-library-table",
                    b"symbol-table",
                ),
            ),
            key=lambda item: (item.relative_name.casefold(), item.relative_name),
        )
    )
    return ManagedKiCadBundle.create(
        project_id="project-worker",
        project_revision=REVISION,
        stem="worker_fixture",
        project_payload=b"project-bytes",
        schematic_payload=b"schematic-bytes",
        board_payload=b"board-bytes",
        auxiliary_files=auxiliary_files,
    )


def invocation(key: str = "verify-1") -> Invocation:
    return Invocation(
        Principal("worker-test", ActorKind.SERVICE, ProfileName.DESIGNER),
        key,
    )


def arguments(checks: list[str] | None = None) -> dict[str, object]:
    return {
        "project_id": "project-worker",
        "expected_project_revision": REVISION,
        "checks": checks or ["drc", "erc"],
    }


def policy(tmp_path: Path, *, refill: bool = False, report_cap: int = 1_000_000) -> WorkerPolicy:
    tmp_path.mkdir(parents=True, exist_ok=True)
    executable = tmp_path / "kicad-cli.exe"
    if not executable.exists():
        executable.write_bytes(b"pinned fake executable")
    return WorkerPolicy(
        executable=executable,
        executable_sha256=hashlib.sha256(executable.read_bytes()).hexdigest(),
        kicad_version=VERSION,
        worker_id="local-kicad-10",
        temp_root=tmp_path / "operations",
        journal_path=tmp_path / "journal.sqlite3",
        journal_hmac_key=b"journal-test-key-32-bytes-minimum!",
        journal_key_id="test-key-v1",
        timeout_seconds=10,
        max_stdout_bytes=10_000,
        max_stderr_bytes=10_000,
        max_report_bytes=report_cap,
        max_bundle_bytes=100_000,
        refill_zones_on_temp_copy=refill,
    )


def service(
    tmp_path: Path,
    runner: FakeRunner,
    *,
    refill: bool = False,
    report_cap: int = 1_000_000,
    managed_bundle: ManagedKiCadBundle | None = None,
) -> tuple[LocalKiCadCliService, StaticResolver, RecordingPublisher]:
    resolver = StaticResolver(bundle() if managed_bundle is None else managed_bundle)
    publisher = RecordingPublisher()
    result = LocalKiCadCliService(
        policy(tmp_path, refill=refill, report_cap=report_cap),
        resolver,
        publisher,
        runner=runner,
    )
    protocol_result: KiCadOperationService = result
    assert protocol_result is result
    return result, resolver, publisher


def test_complete_auxiliary_set_is_digest_bound_and_materialized_in_subdirectories(
    tmp_path: Path,
) -> None:
    rules = (
        b'(version 1)\n(rule "USB4105 internal NPTH" '
        b"(constraint hole_clearance (min 0.15mm)))\n"
    )
    auxiliary_payloads = {
        "Flux.kicad_sym": b"(kicad_symbol_lib (version 20231120) (generator flux-clone))\n",
        "Flux.pretty/USB4105.kicad_mod": b"(footprint \"USB4105\" (version 20240108))\n",
        "fp-lib-table": (
            b'(fp_lib_table (lib (name "Flux")(type "KiCad")'
            b'(uri "${KIPRJMOD}/Flux.pretty")))\n'
        ),
        "sym-lib-table": (
            b'(sym_lib_table (lib (name "Flux")(type "KiCad")'
            b'(uri "${KIPRJMOD}/Flux.kicad_sym")))\n'
        ),
        "worker_fixture.kicad_dru": rules,
    }
    auxiliary_files = tuple(
        sorted(
            (
                ProjectAuxiliaryFile(name, "text/plain", payload)
                for name, payload in auxiliary_payloads.items()
            ),
            key=lambda item: (item.relative_name.casefold(), item.relative_name),
        )
    )
    managed = ManagedKiCadBundle.create(
        project_id="project-worker",
        project_revision=REVISION,
        stem="worker_fixture",
        project_payload=b"project-bytes",
        schematic_payload=b"schematic-bytes",
        board_payload=b"board-bytes",
        auxiliary_files=auxiliary_files,
    )
    runner = DesignRulesRunner(auxiliary_payloads)
    worker = LocalKiCadCliService(
        policy(tmp_path),
        StaticResolver(managed),
        RecordingPublisher(),
        runner=runner,
    )

    result = worker.verify_project(arguments(), invocation("rules-verify-1"))

    assert result.succeeded
    assert runner.rules_observations == 2
    assert result.evidence.opened_bundle_sha256 == managed.bundle_sha256
    assert not any((tmp_path / "operations").iterdir())


@pytest.mark.parametrize(
    "runner",
    (
        FakeRunner(mutate_runtime_support=True),
        FakeRunner(remove_runtime_support=True),
    ),
)
def test_runtime_support_is_injected_separately_and_must_remain_exact(
    tmp_path: Path,
    runner: FakeRunner,
) -> None:
    reference_prl = project_preferences_payload("reference_usb_c_3v3")
    assert len(reference_prl) == 2306
    assert hashlib.sha256(reference_prl).hexdigest() == (
        "21f5f814730bd4668286477f0dd098b565b4c9aac5417763909cbba7242095c8"
    )
    expected = project_preferences_payload("worker_fixture")
    assert len(expected) == 2301
    assert expected.count(b"\r\n") == 0
    worker, _, _ = service(tmp_path, runner)

    with pytest.raises(KiCadServiceFailure) as raised:
        worker.verify_project(arguments(), invocation("runtime-support-tamper-1"))

    assert raised.value.code == "kicad_runtime_support_mutated"


def test_source_bundle_cannot_supply_worker_runtime_prl() -> None:
    with pytest.raises(ValueError, match="runtime support"):
        ManagedKiCadBundle.create(
            project_id="project-worker",
            project_revision=REVISION,
            stem="worker_fixture",
            project_payload=b"project-bytes",
            schematic_payload=b"schematic-bytes",
            board_payload=b"board-bytes",
            auxiliary_files=(
                ProjectAuxiliaryFile(
                    "worker_fixture.kicad_prl",
                    "application/json",
                    project_preferences_payload("worker_fixture"),
                ),
            ),
        )


@pytest.mark.parametrize(
    ("unexpected_path", "unexpected_directory"),
    (
        ("worker_fixture.kicad_dru", None),
        ("sym-lib-table", None),
        ("Injected.pretty/Injected.kicad_mod", None),
        ("absent-before-command.txt", None),
        (None, "Unexpected.pretty"),
    ),
)
def test_unexpected_files_and_directories_fail_closed_after_native_command(
    tmp_path: Path,
    unexpected_path: str | None,
    unexpected_directory: str | None,
) -> None:
    runner = FakeRunner(
        unexpected_path=unexpected_path,
        unexpected_directory=unexpected_directory,
    )
    worker, _, _ = service(tmp_path, runner)

    with pytest.raises(KiCadServiceFailure) as raised:
        worker.verify_project(arguments(), invocation("unexpected-workspace-1"))

    assert raised.value.code == "kicad_workspace_mutated"
    assert len(runner.calls) == 2


def test_auxiliary_tamper_and_casefold_shadow_fail_closed(tmp_path: Path) -> None:
    managed = bundle_with_auxiliary()
    runner = FakeRunner(mutate_auxiliary="Flux.kicad_sym")
    worker, _, _ = service(tmp_path, runner, managed_bundle=managed)

    with pytest.raises(KiCadServiceFailure) as tampered:
        worker.verify_project(arguments(), invocation("auxiliary-tamper-1"))

    assert tampered.value.code == "kicad_source_mutated"

    collision = tuple(
        sorted(
            (
                ProjectAuxiliaryFile("Flux.kicad_sym", "text/plain", b"one"),
                ProjectAuxiliaryFile("flux.KICAD_SYM", "text/plain", b"two"),
            ),
            key=lambda item: (item.relative_name.casefold(), item.relative_name),
        )
    )
    with pytest.raises(ProjectInvariantError, match="case-insensitively"):
        ManagedKiCadBundle.create(
            project_id="project-worker",
            project_revision=REVISION,
            stem="worker_fixture",
            project_payload=b"project-bytes",
            schematic_payload=b"schematic-bytes",
            board_payload=b"board-bytes",
            auxiliary_files=collision,
        )
    with pytest.raises(ValueError, match="reserved KiCad report"):
        ManagedKiCadBundle.create(
            project_id="project-worker",
            project_revision=REVISION,
            stem="worker_fixture",
            project_payload=b"project-bytes",
            schematic_payload=b"schematic-bytes",
            board_payload=b"board-bytes",
            auxiliary_files=(
                ProjectAuxiliaryFile("erc.json", "application/json", b"{}"),
            ),
        )


def test_case_collision_appearing_mid_run_is_rejected(tmp_path: Path) -> None:
    managed = bundle_with_auxiliary()
    runner = FakeRunner(unexpected_path="flux.KICAD_SYM")
    worker, _, _ = service(tmp_path, runner, managed_bundle=managed)

    with pytest.raises(KiCadServiceFailure) as raised:
        worker.verify_project(arguments(), invocation("case-collision-1"))

    assert raised.value.code in {"kicad_source_mutated", "kicad_workspace_mutated"}


def test_auxiliary_change_conflicts_with_durable_idempotency_subject(
    tmp_path: Path,
) -> None:
    original = bundle_with_auxiliary()
    first_runner = FakeRunner()
    first, _, _ = service(tmp_path, first_runner, managed_bundle=original)
    first.verify_project(arguments(), invocation("auxiliary-subject-1"))

    changed_auxiliary = tuple(
        ProjectAuxiliaryFile(
            file.relative_name,
            file.media_type,
            file.payload + (b"changed" if file.relative_name == "Flux.kicad_sym" else b""),
        )
        for file in original.auxiliary_files
    )
    changed = ManagedKiCadBundle.create(
        project_id=original.project_id,
        project_revision=original.project_revision,
        stem=original.stem,
        project_payload=original.project_payload,
        schematic_payload=original.schematic_payload,
        board_payload=original.board_payload,
        auxiliary_files=changed_auxiliary,
    )
    retry_runner = FakeRunner()
    retry, _, _ = service(tmp_path, retry_runner, managed_bundle=changed)

    with pytest.raises(KiCadServiceFailure) as raised:
        retry.verify_project(arguments(), invocation("auxiliary-subject-1"))

    assert raised.value.code == "kicad_idempotency_conflict"
    assert len(retry_runner.calls) == 1


def test_reparse_replacement_of_auxiliary_file_is_rejected(tmp_path: Path) -> None:
    managed = bundle_with_auxiliary()
    worker, _, _ = service(
        tmp_path,
        ReparseAuxiliaryRunner(),
        managed_bundle=managed,
    )

    with pytest.raises(KiCadServiceFailure) as raised:
        worker.verify_project(arguments(), invocation("auxiliary-reparse-1"))

    assert raised.value.code == "kicad_workspace_mutated"


def test_success_runs_exact_commands_in_isolated_environment_and_binds_evidence(
    tmp_path: Path,
) -> None:
    runner = FakeRunner()
    worker, resolver, publisher = service(tmp_path, runner)

    outcome = worker.verify_project(arguments(), invocation())

    assert outcome.succeeded
    assert outcome.payload["passed"] is True
    assert outcome.payload["blocking_findings"] == 0
    assert outcome.payload["report_digest"] == stable_digest(
        {
            key: outcome.payload[key]
            for key in (
                "project_id",
                "project_revision",
                "checks",
                "passed",
                "blocking_findings",
                "findings_digest",
            )
        }
    )
    assert outcome.evidence.worker == "local-kicad-10"
    assert outcome.evidence.kicad_version == VERSION
    assert outcome.evidence.opened_project_digest == REVISION[4:]
    assert outcome.evidence.opened_bundle_sha256 == bundle().bundle_sha256
    assert outcome.evidence.runtime_support_sha256 == runtime_support_manifest_sha256(
        bundle().stem
    )
    assert outcome.evidence.request_digest == stable_digest(arguments())
    assert outcome.evidence.payload_digest == stable_digest(outcome.payload)
    assert outcome.evidence.policy_digest == worker.policy_digest
    assert outcome.evidence.exit_code == 0
    assert resolver.calls == [("project-worker", REVISION)]
    assert publisher.calls == 0

    with sqlite3.connect(tmp_path / "journal.sqlite3") as connection:
        stored_report = connection.execute(
            "SELECT report_json FROM kicad_worker_journal WHERE state = 'completed'"
        ).fetchone()
    assert stored_report is not None
    report = json.loads(stored_report[0])
    assert report["opened_bundle_sha256"] == bundle().bundle_sha256
    assert report["runtime_support_sha256"] == outcome.evidence.runtime_support_sha256
    assert report["runtime_support_file_sha256"] == {
        "worker_fixture.kicad_prl": hashlib.sha256(
            project_preferences_payload("worker_fixture")
        ).hexdigest()
    }
    assert report["source_file_sha256"] == report["source_file_sha256_after"]
    assert stable_digest(report["findings_manifest"]) == outcome.payload["findings_digest"]
    assert report["findings_manifest"]["opened_bundle_sha256"] == bundle().bundle_sha256
    assert report["summary_digest"] == outcome.payload["report_digest"]
    assert report["payload_digest"] == outcome.evidence.payload_digest
    assert report["manufacturing_release_eligible"] is False
    assert all("<WORKDIR>" in item["stdout"] for item in report["commands"])
    assert str(tmp_path) not in stored_report[0]

    commands = runner.calls[1:]
    assert [command[0][1:3] for command in commands] == [("sch", "erc"), ("pcb", "drc")]
    assert "--format" in commands[0][0]
    assert "json" in commands[0][0]
    assert "--severity-all" in commands[0][0]
    assert "--exit-code-violations" in commands[0][0]
    assert "--schematic-parity" in commands[1][0]
    assert "--all-track-errors" in commands[1][0]
    assert "--refill-zones" not in commands[1][0]
    assert "--save-board" not in commands[1][0]
    for _, cwd, environment in commands:
        assert set(environment) == {
            "APPDATA",
            "HOME",
            "KICAD_CONFIG_HOME",
            "KICAD_DOCUMENTS_HOME",
            "LOCALAPPDATA",
            "PATH",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "WINDIR",
        }
        assert cwd.name == "runtime"
        assert all(
            cwd == Path(value).parent or cwd in Path(value).parents
            for value in (
                environment["HOME"],
                environment["TEMP"],
                environment["KICAD_CONFIG_HOME"],
                environment["KICAD_DOCUMENTS_HOME"],
            )
        )
    assert not tuple((tmp_path / "operations").iterdir())


def test_violations_are_a_real_failed_verification_not_a_tool_error(tmp_path: Path) -> None:
    worker, _, _ = service(tmp_path, FakeRunner(findings=True))

    outcome = worker.verify_project(arguments(["drc"]), invocation())

    assert not outcome.succeeded
    assert outcome.payload["passed"] is False
    assert outcome.payload["blocking_findings"] == 1
    assert outcome.evidence.exit_code == 5


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (CommandTimeoutError("timeout"), "kicad_cli_timeout"),
        (CommandOutputLimitError("stdout"), "kicad_cli_output_oversize"),
    ],
)
def test_runner_limits_are_terminal_and_retried_from_journal(
    tmp_path: Path,
    failure: BaseException,
    code: str,
) -> None:
    first_runner = FakeRunner(failure=failure)
    worker, _, _ = service(tmp_path, first_runner)
    with pytest.raises(KiCadServiceFailure, match="configured") as first:
        worker.verify_project(arguments(["drc"]), invocation())
    assert first.value.code == code

    retry_runner = FakeRunner()
    retry, _, _ = service(tmp_path, retry_runner)
    with pytest.raises(KiCadServiceFailure) as second:
        retry.verify_project(arguments(["drc"]), invocation())
    assert second.value.code == code
    assert len(retry_runner.calls) == 1  # version probe only; the check never reruns


def test_tool_failure_is_distinct_from_violations_and_is_durable(tmp_path: Path) -> None:
    runner = FakeRunner(tool_exit=3)
    worker, _, _ = service(tmp_path, runner)
    with pytest.raises(KiCadServiceFailure) as raised:
        worker.verify_project(arguments(["erc"]), invocation())
    assert raised.value.code == "kicad_cli_tool_error"
    assert raised.value.details["exit_code"] == 3


def test_closed_report_parser_oversize_and_source_mutation_fail_closed(tmp_path: Path) -> None:
    invalid, _, _ = service(tmp_path / "invalid", FakeRunner(extra_report_key=True))
    with pytest.raises(KiCadServiceFailure) as invalid_report:
        invalid.verify_project(arguments(["drc"]), invocation("invalid-report"))
    assert invalid_report.value.code == "kicad_report_invalid"

    oversize, _, _ = service(
        tmp_path / "oversize",
        FakeRunner(oversize_report=True),
        report_cap=1000,
    )
    with pytest.raises(KiCadServiceFailure) as oversized_report:
        oversize.verify_project(arguments(["drc"]), invocation("oversize-report"))
    assert oversized_report.value.code == "kicad_report_oversize"

    mutating, _, _ = service(tmp_path / "mutation", FakeRunner(mutate_source=True))
    with pytest.raises(KiCadServiceFailure) as source_mutation:
        mutating.verify_project(arguments(["drc"]), invocation("source-mutation"))
    assert source_mutation.value.code == "kicad_source_mutated"


def test_completed_retry_is_byte_equivalent_and_never_reruns_cli(tmp_path: Path) -> None:
    first_runner = FakeRunner()
    worker, _, _ = service(tmp_path, first_runner)
    first = worker.verify_project(arguments(), invocation())

    retry_runner = FakeRunner(findings=True)
    retry, _, _ = service(tmp_path, retry_runner)
    second = retry.verify_project(arguments(), invocation())

    assert second == first
    assert len(retry_runner.calls) == 1


def test_journal_tamper_is_detected_before_any_retry_execution(tmp_path: Path) -> None:
    worker, _, _ = service(tmp_path, FakeRunner())
    worker.verify_project(arguments(["drc"]), invocation())
    with sqlite3.connect(tmp_path / "journal.sqlite3") as connection:
        connection.execute(
            "UPDATE kicad_worker_journal SET result_json = ?",
            ('{"succeeded":false}',),
        )

    retry_runner = FakeRunner()
    retry, _, _ = service(tmp_path, retry_runner)
    with pytest.raises(KiCadServiceFailure) as raised:
        retry.verify_project(arguments(["drc"]), invocation())
    assert raised.value.code == "kicad_journal_tampered"
    assert len(retry_runner.calls) == 1


def test_ambiguous_crash_is_never_reexecuted(tmp_path: Path) -> None:
    crashing, _, _ = service(tmp_path, FakeRunner(failure=SimulatedCrash()))
    with pytest.raises(SimulatedCrash):
        crashing.verify_project(arguments(["drc"]), invocation())

    retry_runner = FakeRunner()
    retry, _, _ = service(tmp_path, retry_runner)
    with pytest.raises(KiCadServiceFailure) as raised:
        retry.verify_project(arguments(["drc"]), invocation())
    assert raised.value.code == "kicad_prior_attempt_ambiguous"
    assert len(retry_runner.calls) == 1


def test_paths_and_environment_cannot_be_supplied_in_arguments(tmp_path: Path) -> None:
    runner = FakeRunner()
    worker, resolver, _ = service(tmp_path, runner)
    malicious = arguments(["drc"])
    malicious["project_id"] = "../escape"
    malicious["cwd"] = "C:\\untrusted"
    with pytest.raises(KiCadServiceFailure) as raised:
        worker.verify_project(malicious, invocation())
    assert raised.value.code == "kicad_invalid_request"
    assert resolver.calls == []
    assert len(runner.calls) == 1

    with pytest.raises(ValueError, match="stem"):
        ManagedKiCadBundle.create(
            project_id="project-worker",
            project_revision=REVISION,
            stem="../escape",
            project_payload=b"project",
            schematic_payload=b"schematic",
            board_payload=b"board",
        )


def test_refill_policy_only_adds_refill_on_the_ephemeral_copy(tmp_path: Path) -> None:
    runner = FakeRunner()
    worker, _, _ = service(tmp_path, runner, refill=True)
    worker.verify_project(arguments(["drc"]), invocation())
    argv = runner.calls[-1][0]
    assert "--refill-zones" in argv
    assert "--save-board" not in argv


def test_import_export_and_render_are_typed_unconfigured_operations(tmp_path: Path) -> None:
    worker, _, publisher = service(tmp_path, FakeRunner())
    calls = (worker.import_project, worker.export_project, worker.render_project)
    expected = (
        "kicad_import_unconfigured",
        "kicad_export_unconfigured",
        "kicad_render_unconfigured",
    )
    for operation, code in zip(calls, expected, strict=True):
        with pytest.raises(KiCadServiceFailure) as raised:
            operation({}, invocation())
        assert raised.value.code == code
    assert publisher.calls == 0


class RaisingPublisher:
    def publish_artifact(self, **_: object) -> NoReturn:
        raise AssertionError("publisher must not be called by verification")

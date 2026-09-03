from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Mapping
from pathlib import Path

import pytest

from backend.kicad_compile import compile_design_graph
from backend.kicad_worker import (
    CommandRunner,
    CompletedCommand,
    LocalKiCadCliService,
    ManagedKiCadBundle,
    PublishedArtifact,
    SubprocessRunner,
    WorkerPolicy,
)
from backend.mcp_gateway import ActorKind, Invocation, Principal, ProfileName
from backend.mcp_server import KiCadServiceFailure
from tests.kicad_cli import discover_kicad_cli, discover_kicad_demo
from tests.kicad_compile.fixtures import reference_graph

CLI = discover_kicad_cli()
DEMO = discover_kicad_demo(CLI)
LIVE = pytest.mark.skipif(
    CLI is None or DEMO is None,
    reason="KiCad CLI or bundled ecc83 demo is not configured or installed",
)


class Resolver:
    def __init__(self, bundle: ManagedKiCadBundle) -> None:
        self.bundle = bundle

    def resolve_bundle(
        self, project_id: str, expected_project_revision: str
    ) -> ManagedKiCadBundle:
        assert (project_id, expected_project_revision) == (
            self.bundle.project_id,
            self.bundle.project_revision,
        )
        return self.bundle


class NoPublish:
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
        raise AssertionError(f"verification attempted publication of {expected_sha256}")


class RealRunnerWithUnexpectedFile:
    def __init__(self) -> None:
        self._runner = SubprocessRunner()

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
        outcome = self._runner.run(
            argv,
            cwd=cwd,
            environment=environment,
            timeout_seconds=timeout_seconds,
            max_stdout_bytes=max_stdout_bytes,
            max_stderr_bytes=max_stderr_bytes,
        )
        if argv[1:] != ("version",):
            (Path(argv[-1]).parent / "unmanaged-after-command.txt").write_bytes(
                b"unmanaged"
            )
        return outcome


def worker(
    tmp_path: Path,
    bundle: ManagedKiCadBundle,
    *,
    runner: CommandRunner | None = None,
) -> LocalKiCadCliService:
    assert CLI is not None
    return LocalKiCadCliService(
        WorkerPolicy(
            executable=CLI,
            executable_sha256=hashlib.sha256(CLI.read_bytes()).hexdigest(),
            kicad_version="10.0.6",
            worker_id="local-kicad-10-live",
            temp_root=tmp_path / "operations",
            journal_path=tmp_path / "journal.sqlite3",
            journal_hmac_key=b"live-smoke-journal-key-32-bytes!",
            journal_key_id="live-smoke-v1",
        ),
        Resolver(bundle),
        NoPublish(),
        runner=runner,
    )


def invoke(key: str) -> Invocation:
    return Invocation(
        Principal("live-smoke", ActorKind.SERVICE, ProfileName.DESIGNER),
        key,
    )


@LIVE
def test_incomplete_installed_demo_fails_on_unmanaged_kicad_side_effect(
    tmp_path: Path,
) -> None:
    assert DEMO is not None
    bundle = ManagedKiCadBundle.create(
        project_id="kicad-demo",
        project_revision="rev_" + "d" * 64,
        stem="ecc83-pp",
        project_payload=(DEMO / "ecc83-pp.kicad_pro").read_bytes(),
        schematic_payload=(DEMO / "ecc83-pp.kicad_sch").read_bytes(),
        board_payload=(DEMO / "ecc83-pp.kicad_pcb").read_bytes(),
    )
    service = worker(tmp_path, bundle, runner=RealRunnerWithUnexpectedFile())
    with pytest.raises(KiCadServiceFailure) as raised:
        service.verify_project(
            {
                "project_id": bundle.project_id,
                "expected_project_revision": bundle.project_revision,
                "checks": ["drc", "erc"],
            },
            invoke("live-demo"),
        )

    assert raised.value.code == "kicad_workspace_mutated"
    with sqlite3.connect(tmp_path / "journal.sqlite3") as connection:
        stored = connection.execute(
            "SELECT failure_json FROM kicad_worker_journal WHERE state = 'failed'"
        ).fetchone()
    assert stored is not None
    failure = json.loads(stored[0])
    assert failure["code"] == "kicad_workspace_mutated"


@LIVE
def test_live_kicad_checks_current_canonical_compiler_bytes(
    tmp_path: Path,
) -> None:
    assert CLI is not None
    compiled = compile_design_graph(reference_graph(), "worker_smoke")
    bundle = ManagedKiCadBundle.create(
        project_id="compiler-smoke",
        project_revision="rev_" + compiled.manifest.output_bundle_sha256,
        stem=compiled.bundle.stem,
        project_payload=compiled.bundle.project_payload,
        schematic_payload=compiled.bundle.schematic_payload,
        board_payload=compiled.bundle.board_payload,
        auxiliary_files=compiled.bundle.auxiliary_files,
    )
    service = worker(tmp_path, bundle)
    outcome = service.verify_project(
        {
            "project_id": bundle.project_id,
            "expected_project_revision": bundle.project_revision,
            "checks": ["drc", "erc"],
        },
        invoke("live-compiler"),
    )

    assert outcome.evidence.kicad_version == "10.0.6"
    assert outcome.evidence.exit_code in {0, 5}
    assert outcome.evidence.opened_project_digest == bundle.project_revision[4:]

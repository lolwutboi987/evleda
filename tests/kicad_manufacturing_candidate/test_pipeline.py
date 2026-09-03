from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path

import pytest

from backend.kicad_compile import (
    CompilationManifest,
    CompiledProject,
    FileDigest,
    compile_design_graph,
)
from backend.kicad_manufacturing_candidate import (
    CandidateContractError,
    CandidateGenerationError,
    CandidateHostConfiguration,
    CandidatePolicy,
    CandidateSource,
    KiCadManufacturingCandidatePipeline,
    ManufacturingCandidate,
)
from backend.kicad_project import ProjectAuxiliaryFile, ProjectBundleInput
from backend.kicad_worker import CompletedCommand
from tests.kicad_cli import discover_kicad_cli
from tests.kicad_compile.fixtures import reference_graph

VERSION = "10.0.6"
REAL_KICAD = discover_kicad_cli()
REAL_BOARD = Path(__file__).parent / "fixtures" / "clean_drill_board.kicad_pcb"
SHARED_IMPORT_BOARD = Path(__file__).parents[1] / "fixtures" / "kicad" / "supported_board.kicad_pcb"
SHARED_IMPORT_BOARD_SHA256 = "1f7236fc3861052040e7913d2a757b9ae20a6c88f585ec4f0e798fcbc5f7c0a4"

_FUNCTIONS = {
    "F_Cu": "Copper,L1,Top",
    "B_Cu": "Copper,L2,Bot",
    "F_Paste": "SolderPaste,Top",
    "B_Paste": "SolderPaste,Bot",
    "F_Silkscreen": "Legend,Top",
    "B_Silkscreen": "Legend,Bot",
    "F_Mask": "SolderMask,Top",
    "B_Mask": "SolderMask,Bot",
    "Edge_Cuts": "Profile",
}
_HEADER_FUNCTIONS = {
    **_FUNCTIONS,
    "F_Paste": "Paste,Top",
    "B_Paste": "Paste,Bot",
    "F_Mask": "Soldermask,Top",
    "B_Mask": "Soldermask,Bot",
    "Edge_Cuts": "Profile,NP",
}


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _compiler_bundle_hash(files: tuple[FileDigest, ...]) -> str:
    body = (
        json.dumps(
            [
                {
                    "filename": item.filename,
                    "byteLength": item.byte_length,
                    "sha256": item.sha256,
                }
                for item in files
            ],
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode()
    return hashlib.sha256(b"flux-clone-compiled-bundle-v1\x00" + body).hexdigest()


def _source(*, board_payload: bytes | None = None) -> CandidateSource:
    auxiliary = (
        ProjectAuxiliaryFile(
            "candidate.pretty/fixture.kicad_mod",
            "application/x-kicad-footprint",
            b"(footprint \"fixture\" (version 20240108) (generator pcbnew))\n",
        ),
        ProjectAuxiliaryFile(
            "fp-lib-table",
            "application/x-kicad-fp-lib-table",
            b"(fp_lib_table)\n",
        ),
        ProjectAuxiliaryFile(
            "sym-lib-table",
            "application/x-kicad-sym-lib-table",
            b"(sym_lib_table)\n",
        ),
    )
    bundle = ProjectBundleInput(
        "candidate",
        b"{}\n",
        (
            b"(kicad_sch (version 20231120) (generator eeschema) "
            b"(uuid 11111111-1111-4111-8111-111111111111) "
            b"(paper \"A4\") (lib_symbols))\n"
        ),
        (
            b"(kicad_pcb (version 20240108) (generator pcbnew))\n"
            if board_payload is None
            else board_payload
        ),
        auxiliary,
    )
    files = tuple(
        sorted(
            FileDigest(
                item.relative_name,
                item.media_type,
                len(item.payload),
                item.sha256,
            )
            for item in bundle.all_files
        )
    )
    manifest = CompilationManifest(
        schema_version=2,
        compiler_id="fixture-compiler",
        compiler_version="1.0.0",
        project_stem=bundle.stem,
        input_graph_sha256="a" * 64,
        files=files,
        output_bundle_sha256=_compiler_bundle_hash(files),
        project_ir_sha256="b" * 64,
        schematic_ir_sha256="c" * 64,
        board_ir_sha256="d" * 64,
        diagnostics_manifest_sha256="e" * 64,
        identity_bindings=(),
    )
    manifest_payload = b'{"fixture":"manifest"}\n'
    compiled = CompiledProject(bundle, manifest, manifest_payload, _sha(manifest_payload))
    return CandidateSource(compiled, manifest.output_bundle_sha256, compiled.manifest_sha256)


def _configuration(tmp_path: Path) -> CandidateHostConfiguration:
    tmp_path.mkdir(parents=True, exist_ok=True)
    executable = tmp_path / "kicad-cli.exe"
    executable.write_bytes(b"fixture-kicad-cli")
    temp_root = tmp_path / "operations"
    return CandidateHostConfiguration(executable, _sha(executable.read_bytes()), VERSION, temp_root)


class FakeRunner:
    def __init__(
        self,
        timestamp: str,
        *,
        finding_type: str | None = None,
        mutate_source: bool = False,
        add_extra_file: bool = False,
        corrupt_positions: bool = False,
    ) -> None:
        self.timestamp = timestamp
        self.finding_type = finding_type
        self.mutate_source = mutate_source
        self.add_extra_file = add_extra_file
        self.corrupt_positions = corrupt_positions
        self.calls: list[tuple[tuple[str, ...], Path, dict[str, str]]] = []

    def _finding(self) -> dict[str, object]:
        assert self.finding_type is not None
        return {
            "description": "Fixture DRC finding",
            "items": [
                {
                    "description": "Fixture item",
                    "pos": {"x": 1, "y": 2},
                    "uuid": "11111111-1111-4111-8111-111111111111",
                }
            ],
            "severity": "warning" if self.finding_type.startswith("lib_") else "error",
            "type": self.finding_type,
        }

    def _drc(self, source: str) -> bytes:
        findings = [] if self.finding_type is None else [self._finding()]
        return json.dumps(
            {
                "$schema": "https://schemas.kicad.org/drc.v1.json",
                "coordinate_units": "mm",
                "date": self.timestamp,
                "ignored_checks": [],
                "included_severities": ["error", "warning", "exclusion"],
                "kicad_version": VERSION,
                "schematic_parity": [],
                "source": source,
                "unconnected_items": [],
                "violations": findings,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()

    def _gerber(self, function: str) -> bytes:
        return (
            f"%TF.GenerationSoftware,KiCad,Pcbnew,{VERSION}*%\n"
            f"%TF.CreationDate,{self.timestamp}-07:00*%\n"
            f"%TF.FileFunction,{function}*%\n"
            "%MOMM*%\nM02*\n"
        ).encode()

    def _gerber_job(self, stem: str) -> bytes:
        return json.dumps(
            {
                "Header": {
                    "GenerationSoftware": {
                        "Vendor": "KiCad",
                        "Application": "Pcbnew",
                        "Version": VERSION,
                    },
                    "CreationDate": f"{self.timestamp}-07:00",
                },
                "FilesAttributes": [
                    {
                        "Path": f"{stem}-{key}.gbr",
                        "FileFunction": function,
                        "FilePolarity": "Positive",
                    }
                    for key, function in _FUNCTIONS.items()
                ],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()

    def _write_gerbers(self, argv: tuple[str, ...], stem: str) -> None:
        output = Path(argv[argv.index("--output") + 1])
        for key, function in _HEADER_FUNCTIONS.items():
            (output / f"{stem}-{key}.gbr").write_bytes(self._gerber(function))
        (output / f"{stem}-job.gbrjob").write_bytes(self._gerber_job(stem))
        if self.add_extra_file:
            (output / "caller-controlled.txt").write_text("rejected", encoding="utf-8")

    def _write_drill(self, argv: tuple[str, ...], stem: str) -> None:
        output = Path(argv[argv.index("--output") + 1])
        for plated, function in (
            ("PTH", "Plated,1,2,PTH"),
            ("NPTH", "NonPlated,1,2,NPTH"),
        ):
            (output / f"{stem}-{plated}.drl").write_text(
                "M48\n"
                f"; #@! TF.CreationDate,{self.timestamp}-07:00\n"
                f"; #@! TF.GenerationSoftware,Kicad,Pcbnew,{VERSION}\n"
                f"; #@! TF.FileFunction,{function}\n"
                "%\nM30\n",
                encoding="utf-8",
            )
            (output / f"{stem}-{plated}-drl_map.gbr").write_bytes(
                self._gerber("Drillmap")
            )
        report = Path(argv[argv.index("--report-path") + 1])
        report.write_text(
            f"Drill report for {stem}.kicad_pcb\n"
            f"Created on {self.timestamp}\n\n"
            "Copper Layer Stackup:\n"
            f"Drill file '{stem}-PTH.drl' contains 1 drill sizes\n"
            f"Drill file '{stem}-NPTH.drl' contains 1 drill sizes\n",
            encoding="utf-8",
        )

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
        board = Path(argv[-1])
        stem = board.stem
        command = argv[1:4]
        if command[:2] == ("pcb", "drc"):
            report = Path(argv[argv.index("--output") + 1])
            report.write_bytes(self._drc(board.name))
            # This fixture has no zone; the fake leaves the valid PCB S-expression unchanged.
            board.write_bytes(board.read_bytes())
            if self.mutate_source:
                (cwd / "source" / f"{stem}.kicad_pcb").write_bytes(b"mutated")
            return CompletedCommand(argv, 5 if self.finding_type else 0, b"drc\n", b"")
        if command == ("pcb", "export", "gerbers"):
            self._write_gerbers(argv, stem)
        elif command == ("pcb", "export", "drill"):
            self._write_drill(argv, stem)
        elif command == ("pcb", "export", "pos"):
            output = Path(argv[argv.index("--output") + 1])
            output.write_text(
                "bad-header\n"
                if self.corrupt_positions
                else "Ref,Val,Package,PosX,PosY,Rot,Side\n"
                '"U1","IC","QFN",1.000000,-2.000000,0.000000,top\n',
                encoding="utf-8",
            )
        elif command == ("pcb", "export", "ipc2581"):
            output = Path(argv[argv.index("--output") + 1])
            output.write_text(
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581"/>\n',
                encoding="utf-8",
            )
        elif command == ("pcb", "export", "ipcd356"):
            output = Path(argv[argv.index("--output") + 1])
            output.write_text(
                "P  CODE 00\nP  UNITS CUST 0\nP  arrayDim   N\n999\n",
                encoding="utf-8",
            )
        else:  # pragma: no cover - rejects accidental command growth
            raise AssertionError(argv)
        return CompletedCommand(argv, 0, b"exported\n", b"")


def _pipeline(
    tmp_path: Path,
    runner: FakeRunner,
    *,
    policy: CandidatePolicy | None = None,
) -> KiCadManufacturingCandidatePipeline:
    return KiCadManufacturingCandidatePipeline(
        _configuration(tmp_path),
        policy=policy,
        runner=runner,
    )


def test_closed_candidate_is_content_addressed_and_never_release_authority(
    tmp_path: Path,
) -> None:
    runner = FakeRunner("2026-08-31T12:00:00")
    source = _source()
    candidate = _pipeline(tmp_path, runner).generate(source)

    assert len(candidate.artifacts) == 18
    assert candidate.receipt.manufacturing_release_eligible is False
    assert candidate.receipt.receipt_kind == "non-release-kicad-cam-candidate"
    assert candidate.receipt.canonical_source_unchanged is True
    assert candidate.receipt.runtime_prl_unchanged is True
    assert candidate.receipt.non_fabrication_notice_filename == "NOT_FOR_FABRICATION.txt"
    assert len(candidate.receipt.non_fabrication_notice_sha256) == 64
    assert len(candidate.receipt.runtime_prl_sha256) == 64
    assert candidate.receipt.cam_output_determinism == "run-specific-content-addressed"
    assert candidate.receipt.source_bundle_sha256 == source.expected_source_bundle_sha256
    assert candidate.receipt.source_manifest_sha256 == source.expected_manifest_sha256
    assert [item.stage for item in candidate.receipt.commands] == [
        "version",
        "drc-fill",
        "gerbers",
        "drill",
        "positions",
        "ipc2581",
        "ipcd356",
    ]
    drc_receipt = next(
        item for item in candidate.receipt.commands if item.stage == "drc-fill"
    )
    assert drc_receipt.logical_argv.count("--schematic-parity") == 1
    assert all(call[0][0].endswith("kicad-cli.exe") for call in runner.calls)
    assert all(call[0][0] == str(_configuration(tmp_path).executable) for call in runner.calls)
    assert all("<WORKDIR>" not in argument for call in runner.calls for argument in call[0])
    assert all(
        receipt.logical_argv[0] == "kicad-cli"
        and not any(str(tmp_path) in argument for argument in receipt.logical_argv)
        for receipt in candidate.receipt.commands
    )
    assert not any(
        item.filename.casefold().endswith(".kicad_prl")
        for item in candidate.receipt.source_file_digests
    )
    assert not any(
        item.filename.casefold().endswith(".kicad_prl")
        for item in candidate.artifacts
    )


def test_two_isolated_runs_prove_filled_board_determinism_but_not_cam_byte_determinism(
    tmp_path: Path,
) -> None:
    source = _source()
    first = _pipeline(tmp_path / "first", FakeRunner("2026-08-31T12:00:01")).generate(source)
    second = _pipeline(tmp_path / "second", FakeRunner("2026-08-31T12:00:02")).generate(source)

    assert first.filled_board_payload == second.filled_board_payload
    assert first.receipt.filled_board_sha256 == second.receipt.filled_board_sha256
    assert first.receipt.normalized_drc_sha256 == second.receipt.normalized_drc_sha256
    assert tuple(item.filename for item in first.artifacts) == tuple(
        item.filename for item in second.artifacts
    )
    assert first.receipt.cam_inventory_sha256 != second.receipt.cam_inventory_sha256
    assert (
        first.receipt.cam_content_validation_sha256
        == second.receipt.cam_content_validation_sha256
    )
    assert tuple(item.sha256 for item in first.artifacts) != tuple(
        item.sha256 for item in second.artifacts
    )
    assert first.receipt.candidate_sha256 != second.receipt.candidate_sha256
    assert first.receipt.cam_output_determinism == "run-specific-content-addressed"
    assert second.receipt.cam_output_determinism == "run-specific-content-addressed"


@pytest.mark.parametrize(
    ("runner", "code"),
    (
        (FakeRunner("2026-08-31T12:00:00", finding_type="clearance"), "drc_blocking_findings"),
        (FakeRunner("2026-08-31T12:00:00", mutate_source=True), "canonical_source_mutated"),
        (FakeRunner("2026-08-31T12:00:00", add_extra_file=True), "cam_inventory_invalid"),
        (FakeRunner("2026-08-31T12:00:00", corrupt_positions=True), "cam_content_invalid"),
    ),
)
def test_fail_closed_boundaries(tmp_path: Path, runner: FakeRunner, code: str) -> None:
    with pytest.raises(CandidateGenerationError) as failure:
        _pipeline(tmp_path, runner).generate(_source())
    assert failure.value.code == code


def test_only_fixed_library_types_can_be_explicitly_classified(tmp_path: Path) -> None:
    with pytest.raises(CandidateContractError, match="non-library"):
        CandidatePolicy(allowed_library_only_types=("clearance",))

    runner = FakeRunner("2026-08-31T12:00:00", finding_type="lib_footprint_mismatch")
    candidate = _pipeline(
        tmp_path,
        runner,
        policy=CandidatePolicy(
            allowed_library_only_types=("lib_footprint_mismatch",),
        ),
    ).generate(_source())
    assert candidate.receipt.library_only_finding_types == ("lib_footprint_mismatch",)
    assert candidate.receipt.manufacturing_release_eligible is False


def test_expected_source_and_manifest_hashes_are_not_advisory(tmp_path: Path) -> None:
    source = _source()
    runner = FakeRunner("2026-08-31T12:00:00")
    with pytest.raises(CandidateGenerationError) as bundle_failure:
        _pipeline(tmp_path / "bundle", runner).generate(
            CandidateSource(source.compiled_project, "f" * 64, source.expected_manifest_sha256)
        )
    assert bundle_failure.value.code == "source_hash_mismatch"

    with pytest.raises(CandidateGenerationError) as manifest_failure:
        _pipeline(tmp_path / "manifest", runner).generate(
            CandidateSource(source.compiled_project, source.expected_source_bundle_sha256, "f" * 64)
        )
    assert manifest_failure.value.code == "manifest_hash_mismatch"


def test_pipeline_never_targets_or_mutates_shared_source_fixture(tmp_path: Path) -> None:
    before = SHARED_IMPORT_BOARD.read_bytes()
    assert _sha(before) == SHARED_IMPORT_BOARD_SHA256
    runner = FakeRunner("2026-08-31T12:00:00")

    _pipeline(tmp_path, runner).generate(_source())

    after = SHARED_IMPORT_BOARD.read_bytes()
    assert after == before
    assert _sha(after) == SHARED_IMPORT_BOARD_SHA256
    assert all(
        str(SHARED_IMPORT_BOARD) not in argument
        for argv, _, _ in runner.calls
        for argument in argv
    )


def test_unexpected_source_prl_is_rejected_before_execution(tmp_path: Path) -> None:
    source = _source()
    injected = ProjectAuxiliaryFile(
        "candidate.kicad_prl",
        "application/json",
        b"{}\n",
    )
    object.__setattr__(
        source.compiled_project.bundle,
        "auxiliary_files",
        (*source.compiled_project.bundle.auxiliary_files, injected),
    )
    runner = FakeRunner("2026-08-31T12:00:00")

    with pytest.raises(CandidateGenerationError) as failure:
        _pipeline(tmp_path, runner).generate(source)

    assert failure.value.code == "source_runtime_state_forbidden"
    assert runner.calls == []


def test_real_compiler_adapter_carries_complete_source_inventory_without_prl(
    tmp_path: Path,
) -> None:
    compiled = compile_design_graph(
        replace(reference_graph(), zones=()),
        "cam_candidate_adapter",
    )
    source = CandidateSource(
        compiled,
        compiled.manifest.output_bundle_sha256,
        compiled.manifest_sha256,
    )

    candidate = _pipeline(
        tmp_path,
        FakeRunner("2026-08-31T12:00:00"),
    ).generate(source)

    expected_names = tuple(
        sorted(f"source/{item.filename}" for item in compiled.manifest.files)
    )
    assert tuple(item.filename for item in candidate.receipt.source_file_digests) == expected_names
    assert len(candidate.receipt.source_file_digests) == len(compiled.manifest.files)
    assert not any(name.casefold().endswith(".kicad_prl") for name in expected_names)


@pytest.mark.skipif(
    REAL_KICAD is None or not REAL_BOARD.is_file(),
    reason="KiCad CLI or the pinned integration fixture is unavailable",
)
def test_real_kicad_two_isolated_runs_have_deterministic_filled_board(
    tmp_path: Path,
) -> None:
    assert REAL_KICAD is not None
    executable = REAL_KICAD
    source_fixture = REAL_BOARD.read_bytes()
    source_fixture_sha256 = _sha(source_fixture)
    assert source_fixture.count(b"(attr through_hole)") == 1
    canonical_fixture = source_fixture.replace(
        b"(attr through_hole)", b"(attr through_hole board_only)"
    )
    canonical_fixture_sha256 = _sha(canonical_fixture)
    assert b"(zone" in canonical_fixture
    assert b"(filled_polygon" not in canonical_fixture
    source = _source(board_payload=canonical_fixture)
    executable_hash = _sha(executable.read_bytes())
    policy = CandidatePolicy(
        allowed_library_only_types=("lib_footprint_issues",),
        acknowledged_ignored_check_keys=(
            "footprint_filters_mismatch",
            "footprint_type_mismatch",
            "missing_courtyard",
            "track_not_centered_on_via",
            "tuning_profile_track_geometries",
        ),
    )

    def run(name: str) -> ManufacturingCandidate:
        configuration = CandidateHostConfiguration(
            executable,
            executable_hash,
            VERSION,
            tmp_path / name,
        )
        return KiCadManufacturingCandidatePipeline(
            configuration,
            policy=policy,
        ).generate(source)

    first = run("first")
    second = run("second")

    assert first.filled_board_payload == second.filled_board_payload
    assert b"(zone" in first.filled_board_payload
    assert b"(filled_polygon" in first.filled_board_payload
    assert first.receipt.filled_board_sha256 == second.receipt.filled_board_sha256
    assert first.receipt.normalized_drc_sha256 == second.receipt.normalized_drc_sha256
    assert tuple(item.filename for item in first.artifacts) == tuple(
        item.filename for item in second.artifacts
    )
    assert (
        first.receipt.cam_content_validation_sha256
        == second.receipt.cam_content_validation_sha256
    )
    assert first.receipt.cam_output_determinism == "run-specific-content-addressed"
    assert second.receipt.cam_output_determinism == "run-specific-content-addressed"
    assert first.receipt.manufacturing_release_eligible is False
    assert second.receipt.manufacturing_release_eligible is False
    for candidate in (first, second):
        drc_receipt = next(
            item for item in candidate.receipt.commands if item.stage == "drc-fill"
        )
        assert drc_receipt.logical_argv.count("--schematic-parity") == 1
    assert source.compiled_project.bundle.board_payload == canonical_fixture
    assert _sha(source.compiled_project.bundle.board_payload) == canonical_fixture_sha256
    assert REAL_BOARD.read_bytes() == source_fixture
    assert _sha(REAL_BOARD.read_bytes()) == source_fixture_sha256

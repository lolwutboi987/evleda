"""Focused sealing contract for the R2 compiler profile sidecar."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from typing import Protocol, cast

import pytest

from backend.evidence import reference_sources
from backend.kicad_compile import compile_design_graph
from backend.kicad_compile.reference_r2 import (
    PROFILE_ID,
    PROFILE_VERSION,
    R2CompilationProfileError,
    build_r2_compilation_profile,
)
from backend.kicad_io import import_board
from backend.kicad_project import (
    BundleLimits,
    LabelKind,
    import_project_bundle,
    parse_hermetic_project_libraries,
    parse_project_manifest,
    parse_schematic,
)
from backend.reference_design.builder import build_reference_board
from tests.kicad_cli import discover_kicad_cli

# This sealed compiler-profile test deliberately asserts private evidence-cache
# integrity in addition to public manifest identity.
pytestmark = pytest.mark.restricted_evidence

_KICAD_10_0_6_CLI = discover_kicad_cli()
_SOURCE_MANIFEST = (
    Path(__file__).resolve().parents[2]
    / "docs"
    / "evidence"
    / "reference_sources"
    / "manifest.json"
)
_SOURCE_STORE = _SOURCE_MANIFEST.parent


class _PayloadFile(Protocol):
    @property
    def relative_name(self) -> str: ...

    @property
    def payload(self) -> bytes: ...


def _stage_private_evidence_cache(destination: Path) -> None:
    payload = cast(
        dict[str, object],
        json.loads(_SOURCE_MANIFEST.read_text(encoding="utf-8")),
    )
    entries = cast(list[dict[str, object]], payload["sources"])
    for entry in entries:
        relative_name = entry["content_path"]
        if relative_name is None:
            continue
        relative_path = Path(cast(str, relative_name))
        source = _SOURCE_STORE / relative_path
        target = destination / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def _stage_bundle(root: Path, *, files: tuple[_PayloadFile, ...]) -> dict[str, str]:
    """Materialize only the compiled package, returning its exact file digests."""

    snapshots: dict[str, str] = {}
    for item in files:
        relative_name = item.relative_name
        payload = item.payload
        destination = root / Path(relative_name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
        snapshots[relative_name] = hashlib.sha256(payload).hexdigest()
    return snapshots


def test_r2_profile_seals_current_sidecars_and_rejects_subject_mutation() -> None:
    graph = build_reference_board().graph
    profile = build_r2_compilation_profile(
        graph,
        human_plan_sha256="1" * 64,
        human_symbol_catalog_sha256="2" * 64,
        human_emission_sha256="3" * 64,
    )

    assert (profile.evidence.profile_id, profile.evidence.profile_version) == (
        PROFILE_ID,
        PROFILE_VERSION,
    )
    assert profile.evidence.subject_graph_sha256 == graph.graph_hash
    assert (
        profile.evidence.human_plan_sha256,
        profile.evidence.human_symbol_catalog_sha256,
        profile.evidence.human_emission_sha256,
    ) == ("1" * 64, "2" * 64, "3" * 64)
    assert len(profile.fab_records) == len(profile.courtyard_records) == 23
    assert len(profile.silkscreen_records) == 46
    assert len(profile.emitted_model_records) == 16
    assert len(profile.omitted_model_records) == 7
    assert profile.overhangs[0].subject_id == "usb-j1"
    assert profile.overhangs[0].permitted
    assert all(
        record.kicad_reference is not None and record.model_sha256 is not None
        for record in profile.emitted_model_records
    )
    assert all(
        record.kicad_reference is None and record.model_sha256 is None
        for record in profile.omitted_model_records
    )

    with pytest.raises(FrozenInstanceError):
        profile.evidence = profile.evidence  # type: ignore[misc]
    with pytest.raises(R2CompilationProfileError, match="project ID"):
        build_r2_compilation_profile(
            replace(graph, project_id="reference-usb-c-3v3-r2-mutated"),
            human_plan_sha256="1" * 64,
            human_symbol_catalog_sha256="2" * 64,
            human_emission_sha256="3" * 64,
        )


def test_r2_profile_accepts_packaged_manifest_with_external_private_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    packaged_manifest = (
        tmp_path
        / "site-packages"
        / "evleda"
        / "evidence"
        / "reference_sources"
        / "manifest.json"
    )
    packaged_manifest.parent.mkdir(parents=True)
    packaged_manifest.write_bytes(_SOURCE_MANIFEST.read_bytes())
    private_cache = tmp_path / "private-evidence"
    _stage_private_evidence_cache(private_cache)
    monkeypatch.setattr(reference_sources, "DEFAULT_MANIFEST_PATH", packaged_manifest)
    monkeypatch.setenv(reference_sources.REFERENCE_EVIDENCE_ROOT_ENV, str(private_cache))

    profile = build_r2_compilation_profile(
        build_reference_board().graph,
        human_plan_sha256="1" * 64,
        human_symbol_catalog_sha256="2" * 64,
        human_emission_sha256="3" * 64,
    )

    assert profile.evidence.source_receipt_manifest_sha256 == (
        "61c4de84fa359101073b4cce6aa020c36d5c7e9ff23257cfa39bd50d3b931361"
    )


def test_r2_profile_rejects_packaged_manifest_byte_tamper(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    packaged_manifest = tmp_path / "package" / "manifest.json"
    packaged_manifest.parent.mkdir(parents=True)
    packaged_manifest.write_bytes(_SOURCE_MANIFEST.read_bytes() + b"\n")
    private_cache = tmp_path / "private-evidence"
    _stage_private_evidence_cache(private_cache)
    monkeypatch.setattr(reference_sources, "DEFAULT_MANIFEST_PATH", packaged_manifest)
    monkeypatch.setenv(reference_sources.REFERENCE_EVIDENCE_ROOT_ENV, str(private_cache))

    with pytest.raises(R2CompilationProfileError, match="manifest bytes changed"):
        build_r2_compilation_profile(
            build_reference_board().graph,
            human_plan_sha256="1" * 64,
            human_symbol_catalog_sha256="2" * 64,
            human_emission_sha256="3" * 64,
        )


def test_r2_profile_rejects_symlinked_manifest_or_private_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    packaged_manifest = tmp_path / "package" / "manifest.json"
    packaged_manifest.parent.mkdir(parents=True)
    packaged_manifest.write_bytes(_SOURCE_MANIFEST.read_bytes())
    private_cache = tmp_path / "private-evidence"
    _stage_private_evidence_cache(private_cache)
    real_is_symlink = Path.is_symlink

    def manifest_is_symlink(path: Path) -> bool:
        return path == packaged_manifest or real_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", manifest_is_symlink)
    monkeypatch.setattr(reference_sources, "DEFAULT_MANIFEST_PATH", packaged_manifest)
    monkeypatch.setenv(reference_sources.REFERENCE_EVIDENCE_ROOT_ENV, str(private_cache))
    with pytest.raises(R2CompilationProfileError, match="manifest path is unsafe"):
        build_r2_compilation_profile(
            build_reference_board().graph,
            human_plan_sha256="1" * 64,
            human_symbol_catalog_sha256="2" * 64,
            human_emission_sha256="3" * 64,
        )

    def cache_is_symlink(path: Path) -> bool:
        return path == private_cache or real_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", cache_is_symlink)
    monkeypatch.setattr(reference_sources, "DEFAULT_MANIFEST_PATH", packaged_manifest)
    monkeypatch.setenv(reference_sources.REFERENCE_EVIDENCE_ROOT_ENV, str(private_cache))
    with pytest.raises(R2CompilationProfileError, match="source manifest changed"):
        build_r2_compilation_profile(
            build_reference_board().graph,
            human_plan_sha256="1" * 64,
            human_symbol_catalog_sha256="2" * 64,
            human_emission_sha256="3" * 64,
        )


def test_installed_kicad_10_0_6_opens_the_complete_r2_package_without_mutation(
    tmp_path: Path,
) -> None:
    """Acceptance gate for a user opening the generated one-sheet R2 package.

    KiCad CLI has no literal ``open`` operation.  Its ERC and DRC commands
    load the schematic and board with their project-local libraries, so a
    clean run is the deterministic non-interactive equivalent.  The test is
    pinned to the reviewed native binary and checks source bytes before and
    after it loads the package.
    """

    if _KICAD_10_0_6_CLI is None:
        pytest.skip("KiCad CLI is not configured with EVLEDA_KICAD_CLI or on PATH")
    version = subprocess.run(
        [str(_KICAD_10_0_6_CLI), "version"],
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    if version.returncode != 0 or version.stdout.strip() != "10.0.6":
        pytest.skip("the installed KiCad CLI is not the reviewed 10.0.6 build")

    graph = build_reference_board().graph
    artifact = compile_design_graph(graph, "reference_usb_c_3v3_r2")
    bundle = artifact.bundle

    # Reparse all three package roots and the project-local library closure
    # before handing the exact same source bytes to native KiCad.
    imported = import_project_bundle(bundle)
    project = parse_project_manifest(
        bundle.project_payload, stem=bundle.stem, limits=BundleLimits()
    )
    schematic = parse_schematic(bundle.schematic_payload, limits=BundleLimits())
    board = import_board(bundle.board_payload).board
    libraries = parse_hermetic_project_libraries(bundle.auxiliary_files)
    assert imported.evidence.project_ir_sha256 == artifact.manifest.project_ir_sha256
    assert imported.evidence.schematic_ir_sha256 == artifact.manifest.schematic_ir_sha256
    assert imported.evidence.board_ir_sha256 == artifact.manifest.board_ir_sha256
    assert project.filename == "reference_usb_c_3v3_r2.kicad_pro"
    assert project.top_level_sheets[0].filename == "reference_usb_c_3v3_r2.kicad_sch"
    assert project.top_level_sheets[0].sheet_id == schematic.schematic_id
    assert not (
        project.diagnostics.unsupported
        or schematic.diagnostics.unsupported
        or board.diagnostics.unsupported
    )

    # The R2 human schematic is deliberately a single sheet: its named
    # connections are project-local labels, never cross-sheet global labels.
    local_labels = {item.name for item in schematic.labels if item.kind is LabelKind.LOCAL}
    global_labels = {item.name for item in schematic.labels if item.kind is LabelKind.GLOBAL}
    board_net_names = {item.name for item in board.nets}
    logical_net_names = {item.name for item in graph.nets}
    assert local_labels == logical_net_names
    assert not global_labels
    assert {f"/{name}" for name in logical_net_names} <= board_net_names

    # Every symbol must have a matching placed footprint and a closed local
    # library definition/module.  ``instances`` is retained in the native
    # schematic source and is parsed by KiCad during ERC.
    expected_references = {item.reference for item in graph.components}
    symbols_by_reference = {item.reference: item for item in schematic.symbols}
    footprints_by_reference = {item.reference: item for item in board.footprints}
    assert set(symbols_by_reference) == set(footprints_by_reference) == expected_references
    assert bundle.schematic_payload.count(b"\n    (instances\n") == len(expected_references)
    assert bundle.schematic_payload.count(b"\n  (sheet_instances\n") == 1
    assert len(libraries.footprint_modules) == len(expected_references)
    assert {
        item.local_id for item in libraries.symbol_library.definitions
    } == {
        item.library_id.removeprefix("FluxGenerated:")
        for item in schematic.symbols
    }
    module_ids = {f"FluxGenerated:{item.local_id}" for item in libraries.footprint_modules}
    for reference, symbol in symbols_by_reference.items():
        footprint = footprints_by_reference[reference]
        assert symbol.footprint == footprint.library_id
        assert symbol.footprint in module_ids

    source_digests = _stage_bundle(tmp_path, files=bundle.all_files)
    schematic_path = tmp_path / artifact.schematic_filename
    board_path = tmp_path / artifact.board_filename
    configuration_root = tmp_path / "configuration"
    configuration_root.mkdir()
    environment = os.environ.copy()
    environment["KICAD_CONFIG_HOME"] = str(configuration_root)
    environment["KICAD_CONFIG_HOME_IS_QA"] = "1"

    erc_report = tmp_path / "erc.json"
    erc = subprocess.run(
        [
            str(_KICAD_10_0_6_CLI),
            "sch",
            "erc",
            "--format",
            "json",
            "--severity-all",
            "--exit-code-violations",
            "--output",
            str(erc_report),
            str(schematic_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=tmp_path,
        env=environment,
    )
    assert erc.returncode == 0, erc.stderr or erc.stdout
    erc_payload = json.loads(erc_report.read_text(encoding="utf-8"))
    assert not [
        violation for sheet in erc_payload["sheets"] for violation in sheet["violations"]
    ]

    drc_report = tmp_path / "drc.json"
    drc = subprocess.run(
        [
            str(_KICAD_10_0_6_CLI),
            "pcb",
            "drc",
            "--format",
            "json",
            "--severity-all",
            "--all-track-errors",
            "--schematic-parity",
            "--exit-code-violations",
            "--output",
            str(drc_report),
            str(board_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=tmp_path,
        env=environment,
    )
    assert drc.returncode == 0, drc.stderr or drc.stdout
    drc_payload = json.loads(drc_report.read_text(encoding="utf-8"))
    assert not drc_payload["schematic_parity"]
    assert not drc_payload["unconnected_items"]
    assert not drc_payload["violations"]

    assert source_digests == {
        relative_name: hashlib.sha256((tmp_path / relative_name).read_bytes()).hexdigest()
        for relative_name in source_digests
    }
    # KiCad 10.0.6 may create per-user UI state beside its private working
    # copy.  That runtime file is allowed only outside the compiler bundle;
    # the source digest equality above proves it did not mutate any source.
    assert not any(
        item.relative_name.casefold().endswith(".kicad_prl") for item in bundle.all_files
    )
    runtime_prl = tmp_path / "reference_usb_c_3v3_r2.kicad_prl"
    assert not runtime_prl.exists() or (runtime_prl.is_file() and runtime_prl.stat().st_size > 0)
    with pytest.raises(R2CompilationProfileError, match="graph"):
        build_r2_compilation_profile(
            replace(
                graph,
                placements=(
                    replace(
                        graph.placements[0],
                        position=replace(graph.placements[0].position, x=1_000_000),
                    ),
                    *graph.placements[1:],
                ),
            ),
            human_plan_sha256="1" * 64,
            human_symbol_catalog_sha256="2" * 64,
            human_emission_sha256="3" * 64,
        )

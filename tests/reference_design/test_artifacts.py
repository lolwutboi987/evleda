"""Native compiler package tests for the reference USB-C board."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from zipfile import ZipFile

import pytest

import backend.reference_design.artifacts as artifacts_module
from backend.kicad_compile import verify_compiled_project
from backend.reference_design.artifacts import (
    PACKAGE_MANIFEST_FILENAME,
    PROJECT_STEM,
    PUBLICATION_MANIFEST_FILENAME,
    _file_inventory,
    _safe_output_path,
    build_reference_artifact_set,
    materialize_reference_artifacts,
    materialize_reference_kicad_working_copy,
)
from backend.reference_design.model import ReferenceDesignViolation

# Artifact regeneration validates the full source-evidence closure; packaged
# runtime tests exercise the public sealed artifact independently.
pytestmark = pytest.mark.restricted_evidence


def _directory_symlink_or_skip(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
    except (NotImplementedError, OSError):
        pytest.skip("the test host does not permit directory symlink creation")


def test_reference_artifact_set_reparses_the_exact_canonical_graph() -> None:
    package = build_reference_artifact_set()
    result = package.result
    verification = verify_compiled_project(result.graph, package.compiled)
    assert verification == result.compilation_verification
    assert result.compiler_manifest == package.compiled.manifest
    assert result.compiler_manifest.kicad_execution == "not-run"
    assert not result.manufacturing_release_passed
    assert result.manufacturing_blockers
    assert (
        "c3-r9-full-temperature-capacitance-esr-and-stability-not-qualified"
        in result.manufacturing_blockers
    )
    assert not any("not-emitted" in item for item in result.manufacturing_blockers)
    # The completion gates must describe the actual R2 state, not superseded
    # compiler or synthetic-schematic work.  The exact source/CAM split remains
    # deliberately fail-closed until a release packet approves the derivative.
    assert "r2-physical-placement-routing-and-compiler-parity-not-complete" not in (
        result.manufacturing_blockers
    )
    assert "human-readable-schematic-and-real-kicad-erc-not-reviewed" not in (
        result.manufacturing_blockers
    )
    assert "kicad-cli-erc-not-run" not in result.manufacturing_blockers
    assert "kicad-cli-drc-not-run" not in result.manufacturing_blockers
    assert (
        "exact-source-board-is-unfilled-and-cam-derivative-is-not-release-approved"
        in result.manufacturing_blockers
    )
    source_files = result.compiler_manifest.files
    bundle_files = package.compiled.bundle.all_files
    assert len(bundle_files) == 29
    assert not any(item.relative_name.endswith(".kicad_prl") for item in bundle_files)
    assert {item.relative_name for item in bundle_files} >= {
        "fp-lib-table",
        "sym-lib-table",
        "FluxGenerated.kicad_sym",
    }
    assert (
        len(tuple(item for item in bundle_files if item.relative_name.endswith(".kicad_mod"))) == 23
    )
    assert len(source_files) == len(bundle_files) == 29
    assert {item.filename for item in source_files} == {item.relative_name for item in bundle_files}


def test_materialized_package_is_deterministic_and_contains_native_files(tmp_path: Path) -> None:
    first = materialize_reference_artifacts(tmp_path / "one")
    second = materialize_reference_artifacts(tmp_path / "one")
    assert first == second
    required = {
        f"{PROJECT_STEM}.kicad_pro",
        f"{PROJECT_STEM}.kicad_sch",
        f"{PROJECT_STEM}.kicad_pcb",
        f"{PROJECT_STEM}.flux-compile.json",
        f"{PROJECT_STEM}.bom.json",
        f"{PROJECT_STEM}.bom.csv",
        f"{PROJECT_STEM}.audit.json",
        f"{PROJECT_STEM}.native-report.json",
        f"{PROJECT_STEM}.result.json",
        PACKAGE_MANIFEST_FILENAME,
        "README.md",
        "legal/CC-BY-SA-4.0.txt",
        "legal/CERN-OHL-P-2.0.txt",
        "legal/KiCad-Libraries-LICENSE.md",
        "legal/NOTICE.txt",
        "legal/THIRD_PARTY_NOTICES.md",
    }
    assert required <= set(first)
    assert len(first["zip_sha256"]) == 64
    assert len(first["publication_manifest_sha256"]) == 64
    with ZipFile(tmp_path / "one" / f"{PROJECT_STEM}.zip") as archive:
        assert required <= set(archive.namelist())
        assert PUBLICATION_MANIFEST_FILENAME not in archive.namelist()
        assert not any(name.endswith(".kicad_prl") for name in archive.namelist())
        assert {
            "legal/CC-BY-SA-4.0.txt",
            "legal/CERN-OHL-P-2.0.txt",
            "legal/KiCad-Libraries-LICENSE.md",
            "legal/NOTICE.txt",
            "legal/THIRD_PARTY_NOTICES.md",
        } <= set(archive.namelist())
    assert (tmp_path / "one" / PUBLICATION_MANIFEST_FILENAME).is_file()
    publication = json.loads(
        (tmp_path / "one" / PUBLICATION_MANIFEST_FILENAME).read_text(encoding="utf-8")
    )
    published_names = {entry["filename"] for entry in publication["files"]}
    assert {
        "fp-lib-table",
        "sym-lib-table",
        "FluxGenerated.kicad_sym",
    } <= published_names
    assert len({name for name in published_names if name.endswith(".kicad_mod")}) == 23
    assert not any(name.endswith(".kicad_prl") for name in published_names)
    assert not any(path.name.endswith(".kicad_prl") for path in (tmp_path / "one").rglob("*"))


def test_exact_reference_materializations_are_read_only_idempotent_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sealed = tmp_path / "sealed"
    first = materialize_reference_artifacts(sealed)
    session = tmp_path / "session"
    copied = materialize_reference_kicad_working_copy(sealed, session)
    publication_snapshot = {
        path.relative_to(sealed).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in sealed.rglob("*")
        if path.is_file()
    }
    session_snapshot = {
        path.relative_to(session).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in session.rglob("*")
        if path.is_file()
    }

    def forbid_rewrite(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an exact retry attempted a filesystem write")

    monkeypatch.setattr(artifacts_module, "_write_exclusive_files", forbid_rewrite)
    assert materialize_reference_artifacts(sealed) == first
    assert materialize_reference_kicad_working_copy(sealed, session) == copied
    assert publication_snapshot == {
        path.relative_to(sealed).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in sealed.rglob("*")
        if path.is_file()
    }
    assert session_snapshot == {
        path.relative_to(session).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
        for path in session.rglob("*")
        if path.is_file()
    }


def test_publication_rejects_unmanaged_kicad_ui_state(tmp_path: Path) -> None:
    target = tmp_path / "published"
    target.mkdir()
    (target / f"{PROJECT_STEM}.kicad_prl").write_text("ui-state", encoding="utf-8")
    with pytest.raises(Exception, match="unmanaged or KiCad UI state"):
        materialize_reference_artifacts(target)


def test_publication_rejects_a_symlink_where_an_expected_directory_would_be(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "published"
    outside = tmp_path / "outside"
    target.mkdir()
    outside.mkdir()
    _directory_symlink_or_skip(target / "legal", outside)

    def forbid_build() -> None:
        raise AssertionError("publication inspected an unsafe destination too late")

    monkeypatch.setattr(artifacts_module, "build_reference_artifact_set", forbid_build)
    with pytest.raises(ReferenceDesignViolation, match="symlink or reparse point"):
        materialize_reference_artifacts(target)
    linked_destination = tmp_path / "linked-publication"
    _directory_symlink_or_skip(linked_destination, outside)
    with pytest.raises(ReferenceDesignViolation, match="symlink or reparse point"):
        materialize_reference_artifacts(linked_destination)
    assert tuple(outside.iterdir()) == ()


def test_materializers_reject_symlinked_parents_and_working_copy_expected_directories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_parent = tmp_path / "real-parent"
    linked_parent = tmp_path / "linked-parent"
    real_parent.mkdir()
    _directory_symlink_or_skip(linked_parent, real_parent)
    original_build = artifacts_module.build_reference_artifact_set

    def forbid_build() -> None:
        raise AssertionError("publication inspected an unsafe parent too late")

    monkeypatch.setattr(artifacts_module, "build_reference_artifact_set", forbid_build)
    with pytest.raises(ReferenceDesignViolation, match="symlink or reparse point"):
        materialize_reference_artifacts(linked_parent / "published")
    assert tuple(real_parent.iterdir()) == ()
    monkeypatch.setattr(artifacts_module, "build_reference_artifact_set", original_build)

    sealed = tmp_path / "sealed"
    materialize_reference_artifacts(sealed)
    session = tmp_path / "session"
    outside = tmp_path / "working-copy-outside"
    session.mkdir()
    outside.mkdir()
    _directory_symlink_or_skip(session / "FluxGenerated.pretty", outside)
    with pytest.raises(ReferenceDesignViolation, match="symlink or reparse point"):
        materialize_reference_kicad_working_copy(sealed, session)
    assert tuple(outside.iterdir()) == ()


def test_publication_rejects_non_directory_and_special_nodes_before_building(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def forbid_build() -> None:
        raise AssertionError("publication inspected an unsafe special node too late")

    monkeypatch.setattr(artifacts_module, "build_reference_artifact_set", forbid_build)
    non_directory = tmp_path / "non-directory"
    non_directory.write_bytes(b"outside-owned")
    with pytest.raises(ReferenceDesignViolation, match="special or non-directory"):
        materialize_reference_artifacts(non_directory)
    assert non_directory.read_bytes() == b"outside-owned"

    if not hasattr(os, "mkfifo"):
        return
    special = tmp_path / "special"
    special.mkdir()
    os.mkfifo(special / "runtime-state")
    with pytest.raises(ReferenceDesignViolation, match="special filesystem node"):
        materialize_reference_artifacts(special)


@pytest.mark.skipif(
    not artifacts_module._SECURE_DIRECTORY_FDS,
    reason="directory-descriptor race hardening is unavailable on this host",
)
def test_descriptor_anchored_write_does_not_follow_a_raced_expected_directory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    probe = tmp_path / "symlink-probe"
    _directory_symlink_or_skip(probe, outside)
    probe.unlink()
    original_open = os.open
    raced = False

    def racing_open(
        path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
        flags: int,
        mode: int = 0o777,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal raced
        if path == "payload.bin" and dir_fd is not None and flags & os.O_CREAT and not raced:
            raced = True
            (root / "expected").rename(root / "held-by-attacker")
            (root / "expected").symlink_to(outside, target_is_directory=True)
        return original_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(artifacts_module.os, "open", racing_open)
    with pytest.raises(ReferenceDesignViolation, match="symlink or reparse point"):
        artifacts_module._write_exclusive_files(
            root,
            (("expected/payload.bin", b"payload"),),
            "raced publication",
        )
    assert raced
    assert not (outside / "payload.bin").exists()


def test_publication_refuses_to_overlay_a_tampered_completed_package(tmp_path: Path) -> None:
    target = tmp_path / "published"
    materialize_reference_artifacts(target)
    (target / "README.md").write_text("tampered", encoding="utf-8")
    with pytest.raises(Exception, match="does not match completion"):
        materialize_reference_artifacts(target)


def test_kicad_working_copy_is_manifest_bound_and_leaves_sealed_publication_unchanged(
    tmp_path: Path,
) -> None:
    sealed = tmp_path / "sealed"
    materialize_reference_artifacts(sealed)
    sealed_hashes_before = {
        path.relative_to(sealed).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sealed.rglob("*")
        if path.is_file()
    }

    session = tmp_path / "session"
    copied = materialize_reference_kicad_working_copy(sealed, session)
    compiler = json.loads(
        (sealed / f"{PROJECT_STEM}.flux-compile.json").read_text(encoding="utf-8")
    )
    expected_names = {entry["filename"] for entry in compiler["files"]}
    assert set(copied) == expected_names
    session_files = {
        path.relative_to(session).as_posix() for path in session.rglob("*") if path.is_file()
    }
    assert session_files == expected_names
    assert copied == materialize_reference_kicad_working_copy(sealed, session)

    # These are representative KiCad runtime side effects.  They belong only to the session.
    (session / f"{PROJECT_STEM}.kicad_prl").write_text("ui-state", encoding="utf-8")
    (session / f"{PROJECT_STEM}.kicad_pcb-bak").write_text("backup", encoding="utf-8")
    (session / "fp-info-cache").write_text("cache", encoding="utf-8")
    with pytest.raises(ReferenceDesignViolation, match="unmanaged files"):
        materialize_reference_kicad_working_copy(sealed, session)

    sealed_hashes_after = {
        path.relative_to(sealed).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sealed.rglob("*")
        if path.is_file()
    }
    assert sealed_hashes_after == sealed_hashes_before


def test_kicad_working_copy_rejects_overlapping_or_mismatched_destinations(tmp_path: Path) -> None:
    sealed = tmp_path / "sealed"
    materialize_reference_artifacts(sealed)
    with pytest.raises(ReferenceDesignViolation, match="must be separate"):
        materialize_reference_kicad_working_copy(sealed, sealed / "session")

    session = tmp_path / "session"
    session.mkdir()
    (session / f"{PROJECT_STEM}.kicad_pro").write_text("tampered", encoding="utf-8")
    with pytest.raises(ReferenceDesignViolation, match="unmanaged files"):
        materialize_reference_kicad_working_copy(sealed, session)

    clean_session = tmp_path / "clean-session"
    materialize_reference_kicad_working_copy(sealed, clean_session)
    (clean_session / f"{PROJECT_STEM}.kicad_pro").write_text("tampered", encoding="utf-8")
    with pytest.raises(ReferenceDesignViolation, match="does not match source"):
        materialize_reference_kicad_working_copy(sealed, clean_session)


def test_kicad_working_copy_rejects_a_symlinked_sealed_package(tmp_path: Path) -> None:
    sealed = tmp_path / "sealed"
    materialize_reference_artifacts(sealed)
    linked_sealed = tmp_path / "sealed-link"
    try:
        linked_sealed.symlink_to(sealed, target_is_directory=True)
    except OSError:
        pytest.skip("the test host does not permit symlink creation")
    with pytest.raises(ReferenceDesignViolation, match="cannot be a symlink"):
        materialize_reference_kicad_working_copy(linked_sealed, tmp_path / "session")


def test_recursive_auxiliary_inventory_and_path_guards_are_deterministic(tmp_path: Path) -> None:
    files = {"libraries/symbols.kicad_sym": b"symbols", "rules/design.kicad_dru": b"rules"}
    media_types = {
        "libraries/symbols.kicad_sym": "application/x-kicad-symbol-library",
        "rules/design.kicad_dru": "application/x-kicad-design-rules",
    }
    inventory = _file_inventory(files, media_types)
    assert tuple(entry["filename"] for entry in inventory) == tuple(sorted(files))
    assert _safe_output_path(tmp_path, "libraries/symbols.kicad_sym") == (
        tmp_path / "libraries" / "symbols.kicad_sym"
    )
    with pytest.raises(ReferenceDesignViolation, match="unsafe package relative path"):
        _safe_output_path(tmp_path, "../escape.kicad_sym")
    with pytest.raises(ReferenceDesignViolation, match="unsafe package relative path"):
        _safe_output_path(tmp_path, "libraries\\state.kicad_prl")


def test_generated_readme_states_current_stackup_and_nonqualification_truth() -> None:
    from backend.reference_design.artifacts import _readme

    package = build_reference_artifact_set()
    readme = _readme(package.result).decode("utf-8")
    assert "design target of at most 100 mA" in readme
    assert "not a production-qualified current guarantee" in readme
    assert "nominal compiler-owned 0.80 mm two-layer stackup" in readme
    assert "35 um copper on each side" in readme
    assert "ENIG finish" in readme
    assert "does not emit a KiCad stackup" not in readme
    assert "default 1.6 mm" not in readme
    assert "Reference design identity" in readme
    assert "copyrighted evidence bytes are not redistributed in this package" in readme
    assert "manifest-bound five-file inventory under `legal/`" in readme
    assert "Seventeen live official primary-source blobs are retained" not in readme
    assert "Package identity" not in readme
    assert "3V3 OUT 100mA MAX / DO NOT APPLY POWER" in readme
    assert "224/247/269 mA" in readme
    assert "103.846533 mA" in readme
    assert "26.7 uF" in readme
    assert "9.73215/11.79072/14.12163 mA" in readme
    assert "117.968163 mA" in readme
    assert "102.381837 mA" in readme
    assert "content-addressed 13-net route" in readme
    assert "content-addressed 13-net route" in readme
    assert "source-backed F.Fab and F.CrtYd geometry" in readme
    assert "human-readable functional-block drawing" in readme
    assert "materialize_reference_kicad_working_copy" in readme
    assert "interactive 3D PDF" in readme
    assert (
        "exact compiler source board intentionally retains unfilled B.Cu GND-zone intent"
        in readme
    )
    assert "synthetic pin-only symbols" not in readme
    assert "26.5 uF nominal downstream" not in readme
    assert "9.659 to 14.016 mA" not in readme

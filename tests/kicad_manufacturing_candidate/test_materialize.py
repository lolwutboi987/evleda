from __future__ import annotations

import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

import pytest

import backend.kicad_manufacturing_candidate.materialize as materialize_module
from backend.kicad_manufacturing_candidate import (
    COMPLETION_MANIFEST_FILENAME,
    FILE_MANIFEST_FILENAME,
    NON_FABRICATION_NOTICE_FILENAME,
    NON_FABRICATION_NOTICE_PAYLOAD,
    NON_FABRICATION_NOTICE_SHA256,
    ZIP_FILENAME,
    CandidateContractError,
    CandidateHostConfiguration,
    CandidatePolicy,
    KiCadManufacturingCandidatePipeline,
    ReferencePublicationBinding,
    candidate_source_from_reference,
    materialize_manufacturing_candidate,
)
from backend.kicad_manufacturing_candidate.model import canonical_bytes
from backend.reference_design import (
    build_reference_artifact_set,
    materialize_reference_artifacts,
)
from backend.reference_design.artifacts import (
    PACKAGE_MANIFEST_FILENAME,
    PUBLICATION_MANIFEST_FILENAME,
)
from tests.kicad_manufacturing_candidate.test_pipeline import (
    REAL_KICAD,
    VERSION,
    FakeRunner,
    _pipeline,
    _source,
)

# Candidate regeneration begins from the raw, source-evidence-bound compiler
# package.  Public CI validates the curated, sealed release assets instead.
pytestmark = pytest.mark.restricted_evidence


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _candidate(tmp_path: Path):  # type: ignore[no-untyped-def]
    return _pipeline(
        tmp_path / "runner",
        FakeRunner("2026-08-31T12:00:00"),
    ).generate(_source())


def _verify_manifest_inventory(root: Path, entries: list[dict[str, object]]) -> None:
    for entry in entries:
        filename = entry["filename"]
        assert isinstance(filename, str)
        payload = root.joinpath(*filename.split("/")).read_bytes()
        assert len(payload) == entry["byte_length"]
        assert _sha(payload) == entry["sha256"]
        assert isinstance(entry["media_type"], str)


def test_manifest_last_materialization_publishes_every_exact_candidate_byte(
    tmp_path: Path,
) -> None:
    source = _source()
    source_snapshot = tuple(
        (item.relative_name, item.payload) for item in source.compiled_project.bundle.all_files
    )
    candidate = _pipeline(
        tmp_path / "runner",
        FakeRunner("2026-08-31T12:00:00"),
    ).generate(source)
    destination = (tmp_path / "published").resolve()

    first = materialize_manufacturing_candidate(candidate, destination)
    second = materialize_manufacturing_candidate(candidate, destination)

    assert first == second
    assert tuple(
        (item.relative_name, item.payload) for item in source.compiled_project.bundle.all_files
    ) == source_snapshot
    assert (destination / "derivative" / "filled.kicad_pcb").read_bytes() == (
        candidate.filled_board_payload
    )
    assert (destination / "evidence" / "drc.raw.json").read_bytes() == (
        candidate.drc_report_payload
    )
    assert (destination / "evidence" / "drc.normalized.json").read_bytes() == (
        candidate.normalized_drc_payload
    )
    assert (destination / "evidence" / "candidate-receipt.json").read_bytes() == (
        canonical_bytes(candidate.receipt) + b"\n"
    )
    assert _sha(
        (destination / "evidence" / "filled-board.semantic.json").read_bytes()
    ) == candidate.receipt.filled_board_semantic_evidence_sha256
    notice = destination / NON_FABRICATION_NOTICE_FILENAME
    assert notice.read_bytes() == NON_FABRICATION_NOTICE_PAYLOAD
    assert candidate.receipt.non_fabrication_notice_filename == NON_FABRICATION_NOTICE_FILENAME
    assert candidate.receipt.non_fabrication_notice_sha256 == NON_FABRICATION_NOTICE_SHA256
    for artifact in candidate.artifacts:
        assert destination.joinpath("cam", *artifact.filename.split("/")).read_bytes() == (
            artifact.payload
        )

    manifest = json.loads(
        destination.joinpath(*FILE_MANIFEST_FILENAME.split("/")).read_text(encoding="utf-8")
    )
    assert manifest["manufacturing_release_eligible"] is False
    assert manifest["candidate_receipt_sha256"] == candidate.receipt.receipt_sha256
    assert manifest["non_fabrication_notice"] == {
        "filename": NON_FABRICATION_NOTICE_FILENAME,
        "media_type": "text/plain",
        "byte_length": len(NON_FABRICATION_NOTICE_PAYLOAD),
        "sha256": NON_FABRICATION_NOTICE_SHA256,
    }
    assert len(manifest["files"]) == 29
    assert {
        "legal/CC-BY-SA-4.0.txt",
        "legal/CERN-OHL-P-2.0.txt",
        "legal/KiCad-Libraries-LICENSE.md",
        "legal/NOTICE.txt",
        "legal/THIRD_PARTY_NOTICES.md",
    } <= {entry["filename"] for entry in manifest["files"]}
    _verify_manifest_inventory(destination, manifest["files"])

    completion_path = destination / COMPLETION_MANIFEST_FILENAME
    assert completion_path.is_file()
    completion = json.loads(completion_path.read_text(encoding="utf-8"))
    assert completion["manufacturing_release_eligible"] is False
    assert completion["file_manifest_sha256"] == first.file_manifest_sha256
    assert completion["non_fabrication_notice"] == manifest["non_fabrication_notice"]
    assert len(completion["files"]) == 30
    _verify_manifest_inventory(destination, completion["files"])
    zip_payload = destination.joinpath(*ZIP_FILENAME.split("/")).read_bytes()
    assert _sha(zip_payload) == completion["zip"]["sha256"] == first.zip_sha256
    with ZipFile(destination.joinpath(*ZIP_FILENAME.split("/"))) as archive:
        assert len(archive.namelist()) == 30
        assert COMPLETION_MANIFEST_FILENAME not in archive.namelist()
        assert archive.read(NON_FABRICATION_NOTICE_FILENAME) == NON_FABRICATION_NOTICE_PAYLOAD
        assert not any(name.casefold().endswith(".kicad_prl") for name in archive.namelist())
        for entry in completion["files"]:
            filename = entry["filename"]
            assert archive.read(filename) == destination.joinpath(*filename.split("/")).read_bytes()
    assert not any(path.name.casefold().endswith(".kicad_prl") for path in destination.rglob("*"))


def test_tamper_unmanaged_case_prl_and_incomplete_reentry_fail_closed(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    destination = (tmp_path / "published").resolve()
    materialize_manufacturing_candidate(candidate, destination)
    target = destination / "cam" / "gerbers" / "candidate-F_Cu.gbr"
    target.write_bytes(b"tampered")
    with pytest.raises(CandidateContractError, match="tampered"):
        materialize_manufacturing_candidate(candidate, destination)

    for name in ("unmanaged.txt", "candidate.kicad_prl", "CAM/duplicate.txt"):
        root = (tmp_path / name.replace("/", "-")).resolve()
        root.mkdir()
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("unmanaged", encoding="utf-8")
        with pytest.raises(CandidateContractError, match="incomplete or unmanaged"):
            materialize_manufacturing_candidate(candidate, root)

    validation_root = (tmp_path / "validation").resolve()
    for unsafe in ("../escape.gbr", "cam\\escape.gbr", "state.kicad_prl"):
        with pytest.raises(CandidateContractError, match="unsafe"):
            materialize_module._safe_path(validation_root, unsafe)
    with pytest.raises(CandidateContractError, match="case-colliding"):
        materialize_module._inventory(
            {
                "cam/layer.gbr": ("application/vnd.gerber", b"one"),
                "CAM/LAYER.GBR": ("application/vnd.gerber", b"two"),
            }
        )


def test_non_fabrication_notice_cannot_be_omitted_or_tampered(tmp_path: Path) -> None:
    candidate = _candidate(tmp_path)
    omitted = (tmp_path / "omitted").resolve()
    materialize_manufacturing_candidate(candidate, omitted)
    (omitted / NON_FABRICATION_NOTICE_FILENAME).unlink()
    with pytest.raises(CandidateContractError, match="inventory drift"):
        materialize_manufacturing_candidate(candidate, omitted)

    tampered = (tmp_path / "tampered").resolve()
    materialize_manufacturing_candidate(candidate, tampered)
    (tampered / NON_FABRICATION_NOTICE_FILENAME).write_bytes(b"safe to fab\n")
    with pytest.raises(CandidateContractError, match="tampered"):
        materialize_manufacturing_candidate(candidate, tampered)


def test_completion_is_last_and_partial_publication_cannot_be_reentered(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate = _candidate(tmp_path)
    destination = (tmp_path / "published").resolve()
    original_link = materialize_module.os.link

    def fail_completion(
        source: Path,
        target: Path,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> None:
        del src_dir_fd, dst_dir_fd
        if target.name == COMPLETION_MANIFEST_FILENAME:
            raise OSError("injected completion failure")
        original_link(source, target, follow_symlinks=follow_symlinks)

    monkeypatch.setattr(materialize_module.os, "link", fail_completion)
    with pytest.raises(OSError, match="injected completion failure"):
        materialize_manufacturing_candidate(candidate, destination)
    assert not (destination / COMPLETION_MANIFEST_FILENAME).exists()
    monkeypatch.setattr(materialize_module.os, "link", original_link)
    with pytest.raises(CandidateContractError, match="incomplete or unmanaged"):
        materialize_manufacturing_candidate(candidate, destination)


@pytest.mark.skipif(
    REAL_KICAD is None or not REAL_KICAD.is_file(),
    reason="pinned KiCad 10 integration executable is unavailable",
)
def test_reference_adapter_binds_current_in_memory_publication_without_paths(
    tmp_path: Path,
) -> None:
    artifact_set = build_reference_artifact_set()
    published = (tmp_path / "reference").resolve()
    materialize_reference_artifacts(published)
    package_payload = (published / PACKAGE_MANIFEST_FILENAME).read_bytes()
    publication_payload = (published / PUBLICATION_MANIFEST_FILENAME).read_bytes()
    published_snapshot = {
        path.relative_to(published).as_posix(): path.read_bytes()
        for path in published.rglob("*")
        if path.is_file()
    }
    source_snapshot = tuple(
        (item.relative_name, item.payload) for item in artifact_set.compiled.bundle.all_files
    )
    source = candidate_source_from_reference(
        artifact_set,
        ReferencePublicationBinding(package_payload, publication_payload),
    )

    assert source.reference_design_artifact_sha256 == artifact_set.result.artifact_hash
    assert source.reference_package_manifest_sha256 == _sha(package_payload)
    assert source.reference_publication_manifest_sha256 == _sha(publication_payload)
    candidate = KiCadManufacturingCandidatePipeline(
        CandidateHostConfiguration(
            REAL_KICAD,
            _sha(REAL_KICAD.read_bytes()),
            VERSION,
            (tmp_path / "candidate-runtime").resolve(),
        ),
        policy=CandidatePolicy(
            acknowledged_ignored_check_keys=(
                "footprint_filters_mismatch",
                "footprint_type_mismatch",
                "missing_courtyard",
                "track_not_centered_on_via",
                "tuning_profile_track_geometries",
            ),
        ),
    ).generate(source)
    candidate_output = (tmp_path / "candidate-output").resolve()
    materialize_manufacturing_candidate(candidate, candidate_output)

    assert candidate.receipt.reference_design_artifact_sha256 == artifact_set.result.artifact_hash
    assert candidate.receipt.reference_package_manifest_sha256 == _sha(package_payload)
    assert candidate.receipt.reference_publication_manifest_sha256 == _sha(publication_payload)
    assert candidate.receipt.bom_component_count == 23
    assert candidate.receipt.bom_evidence_sha256 is not None
    assert candidate.receipt.authored_zone_unchanged is True
    assert candidate.receipt.authored_zone_count == 1
    assert candidate.receipt.authored_zone_evidence_sha256 is not None
    assert candidate.receipt.authored_zone_intent_sha256 is not None
    assert (candidate_output / "assembly" / "reference_usb_c_3v3_r2.bom.csv").is_file()
    assert (candidate_output / "assembly" / "reference_usb_c_3v3_r2.bom.json").is_file()
    assert (candidate_output / "evidence" / "candidate-bom.json").is_file()
    assert (candidate_output / "evidence" / "authored-zone-identity.json").is_file()
    assert tuple(
        (item.relative_name, item.payload) for item in artifact_set.compiled.bundle.all_files
    ) == source_snapshot
    assert {
        path.relative_to(published).as_posix(): path.read_bytes()
        for path in published.rglob("*")
        if path.is_file()
    } == published_snapshot


def test_reference_adapter_rejects_manifest_tampering(tmp_path: Path) -> None:
    artifact_set = build_reference_artifact_set()
    published = (tmp_path / "reference").resolve()
    materialize_reference_artifacts(published)
    package_payload = (published / PACKAGE_MANIFEST_FILENAME).read_bytes()
    publication = json.loads(
        (published / PUBLICATION_MANIFEST_FILENAME).read_text(encoding="utf-8")
    )
    package_entry = next(
        item for item in publication["files"] if item["filename"] == PACKAGE_MANIFEST_FILENAME
    )
    package_entry["sha256"] = "f" * 64
    forged_publication = (
        json.dumps(publication, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()

    with pytest.raises(CandidateContractError, match="package-manifest bytes"):
        candidate_source_from_reference(
            artifact_set,
            ReferencePublicationBinding(package_payload, forged_publication),
        )

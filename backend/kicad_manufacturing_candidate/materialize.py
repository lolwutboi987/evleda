"""Manifest-last publication of exact non-release manufacturing-candidate bytes."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import cast
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from evleda.legal import load_legal_payloads

from .bom import candidate_bom_evidence_payload
from .filled_board_semantics import filled_board_evidence_payload
from .model import (
    NON_FABRICATION_NOTICE_FILENAME,
    NON_FABRICATION_NOTICE_PAYLOAD,
    ArtifactDigest,
    CandidateContractError,
    ManufacturingCandidate,
    canonical_bytes,
)

FILE_MANIFEST_FILENAME = "evidence/candidate-files.json"
ZIP_FILENAME = "bundle/candidate.zip"
COMPLETION_MANIFEST_FILENAME = "candidate.complete.json"


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _safe_path(root: Path, relative_name: str) -> Path:
    pure = PurePosixPath(relative_name)
    if (
        not relative_name
        or "\\" in relative_name
        or pure.is_absolute()
        or any(part in {"", ".", ".."} for part in pure.parts)
        or relative_name.casefold().endswith(".kicad_prl")
    ):
        raise CandidateContractError(f"unsafe materialized candidate path: {relative_name!r}")
    return root.joinpath(*pure.parts)


def _inventory(files: dict[str, tuple[str, bytes]]) -> tuple[dict[str, object], ...]:
    folded: set[str] = set()
    result: list[dict[str, object]] = []
    for filename in sorted(files):
        media_type, payload = files[filename]
        validation_root = (
            Path("C:/candidate-root") if os.name == "nt" else Path("/candidate-root")
        )
        _safe_path(validation_root, filename)
        folded_name = filename.casefold()
        if folded_name in folded:
            raise CandidateContractError("materialized candidate has case-colliding filenames")
        folded.add(folded_name)
        if (
            type(media_type) is not str
            or not media_type
            or type(payload) is not bytes
            or not payload
        ):
            raise CandidateContractError("materialized candidate file shape is invalid")
        result.append(
            {
                "filename": filename,
                "media_type": media_type,
                "byte_length": len(payload),
                "sha256": _sha256(payload),
            }
        )
    return tuple(result)


def _json(value: object) -> bytes:
    return canonical_bytes(value) + b"\n"


def _zip(files: dict[str, tuple[str, bytes]]) -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for filename in sorted(files):
            if filename.casefold().endswith(".kicad_prl"):
                raise CandidateContractError("runtime PRL cannot enter candidate ZIP")
            info = ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[filename][1])
    return output.getvalue()


def _candidate_files(candidate: ManufacturingCandidate) -> dict[str, tuple[str, bytes]]:
    if type(candidate) is not ManufacturingCandidate:
        raise CandidateContractError("materialization requires exact ManufacturingCandidate")
    receipt_payload = _json(candidate.receipt)
    files: dict[str, tuple[str, bytes]] = {
        NON_FABRICATION_NOTICE_FILENAME: ("text/plain", NON_FABRICATION_NOTICE_PAYLOAD),
        "derivative/filled.kicad_pcb": (
            "application/x-kicad-pcb",
            candidate.filled_board_payload,
        ),
        "evidence/drc.raw.json": ("application/json", candidate.drc_report_payload),
        "evidence/drc.normalized.json": (
            "application/json",
            candidate.normalized_drc_payload,
        ),
        "evidence/candidate-receipt.json": ("application/json", receipt_payload),
        "evidence/filled-board.semantic.json": (
            "application/json",
            filled_board_evidence_payload(candidate.filled_board_semantic_evidence),
        ),
    }
    for legal_payload in load_legal_payloads():
        if legal_payload.archive_filename in files:
            raise CandidateContractError("legal payload filename collides during publication")
        files[legal_payload.archive_filename] = (
            legal_payload.media_type,
            legal_payload.payload,
        )
    for artifact in candidate.artifacts:
        filename = f"cam/{artifact.filename}"
        if filename in files:
            raise CandidateContractError("candidate CAM filename collides during publication")
        files[filename] = (artifact.media_type, artifact.payload)
    if candidate.bom_result is not None:
        evidence_payload = candidate_bom_evidence_payload(candidate.bom_result.evidence)
        files["evidence/candidate-bom.json"] = ("application/json", evidence_payload)
        for artifact in candidate.bom_result.artifacts:
            if artifact.filename in files:
                raise CandidateContractError("candidate BOM filename collides during publication")
            files[artifact.filename] = (artifact.media_type, artifact.payload)
    if candidate.authored_zone_evidence is not None:
        files["evidence/authored-zone-identity.json"] = (
            "application/json",
            canonical_bytes(candidate.authored_zone_evidence) + b"\n",
        )
    if any(filename.casefold().endswith(".kicad_prl") for filename in files):
        raise CandidateContractError("runtime PRL cannot enter materialized candidate")
    return files


def _publication_payloads(
    candidate: ManufacturingCandidate,
) -> tuple[
    dict[str, tuple[str, bytes]],
    bytes,
    bytes,
    bytes,
]:
    core_files = _candidate_files(candidate)
    file_manifest = _json(
        {
            "schema_version": 1,
            "kind": "flux-clone-manufacturing-candidate-files",
            "manufacturing_release_eligible": False,
            "candidate_sha256": candidate.receipt.candidate_sha256,
            "candidate_receipt_sha256": candidate.receipt.receipt_sha256,
            "non_fabrication_notice": {
                "filename": candidate.receipt.non_fabrication_notice_filename,
                "media_type": "text/plain",
                "byte_length": len(NON_FABRICATION_NOTICE_PAYLOAD),
                "sha256": candidate.receipt.non_fabrication_notice_sha256,
            },
            "reference_design_artifact_sha256": (
                candidate.receipt.reference_design_artifact_sha256
            ),
            "reference_package_manifest_sha256": (
                candidate.receipt.reference_package_manifest_sha256
            ),
            "reference_publication_manifest_sha256": (
                candidate.receipt.reference_publication_manifest_sha256
            ),
            "files": _inventory(core_files),
        }
    )
    zip_files = {
        **core_files,
        FILE_MANIFEST_FILENAME: ("application/json", file_manifest),
    }
    zip_payload = _zip(zip_files)
    completion = _json(
        {
            "schema_version": 1,
            "kind": "flux-clone-manufacturing-candidate-complete",
            "manufacturing_release_eligible": False,
            "candidate_sha256": candidate.receipt.candidate_sha256,
            "candidate_receipt_sha256": candidate.receipt.receipt_sha256,
            "non_fabrication_notice": {
                "filename": candidate.receipt.non_fabrication_notice_filename,
                "media_type": "text/plain",
                "byte_length": len(NON_FABRICATION_NOTICE_PAYLOAD),
                "sha256": candidate.receipt.non_fabrication_notice_sha256,
            },
            "file_manifest_sha256": _sha256(file_manifest),
            "files": _inventory(zip_files),
            "zip": {
                "filename": ZIP_FILENAME,
                "media_type": "application/zip",
                "byte_length": len(zip_payload),
                "sha256": _sha256(zip_payload),
            },
        }
    )
    return zip_files, file_manifest, zip_payload, completion


def _expected_directories(names: set[str]) -> set[str]:
    return {
        parent.as_posix()
        for name in names
        for parent in PurePosixPath(name).parents
        if parent != PurePosixPath(".")
    }


def _observed(destination: Path) -> tuple[set[str], set[str]]:
    files: set[str] = set()
    directories: set[str] = set()
    if not destination.exists():
        return files, directories
    for path in destination.rglob("*"):
        if path.is_symlink():
            raise CandidateContractError("materialized candidate contains a symlink")
        relative = path.relative_to(destination).as_posix()
        if path.is_file():
            files.add(relative)
        elif path.is_dir():
            directories.add(relative)
        else:
            raise CandidateContractError("materialized candidate contains a special file")
    return files, directories


def _verify_exact_publication(
    destination: Path,
    expected_files: dict[str, tuple[str, bytes]],
    zip_payload: bytes,
    completion: bytes,
) -> None:
    names = {*expected_files, ZIP_FILENAME, COMPLETION_MANIFEST_FILENAME}
    observed_files, observed_directories = _observed(destination)
    if observed_files != names or observed_directories != _expected_directories(names):
        raise CandidateContractError(
            "materialized candidate has missing, unmanaged, or recursive inventory drift"
        )
    for filename, (_, payload) in expected_files.items():
        path = _safe_path(destination, filename)
        if path.read_bytes() != payload:
            raise CandidateContractError(f"materialized candidate file was tampered: {filename}")
    if _safe_path(destination, ZIP_FILENAME).read_bytes() != zip_payload:
        raise CandidateContractError("materialized candidate ZIP was tampered")
    if _safe_path(destination, COMPLETION_MANIFEST_FILENAME).read_bytes() != completion:
        raise CandidateContractError("materialized candidate completion manifest was tampered")
    try:
        decoded = json.loads(completion.decode("utf-8", errors="strict"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CandidateContractError("candidate completion manifest is invalid JSON") from exc
    if type(decoded) is not dict or cast(dict[str, object], decoded).get(
        "manufacturing_release_eligible"
    ) is not False:
        raise CandidateContractError("candidate completion manifest authority is invalid")
    with ZipFile(BytesIO(zip_payload), "r") as archive:
        if tuple(archive.namelist()) != tuple(sorted(expected_files)):
            raise CandidateContractError("candidate ZIP inventory is invalid")
        for filename in sorted(expected_files):
            info = archive.getinfo(filename)
            if (
                info.date_time != (1980, 1, 1, 0, 0, 0)
                or info.external_attr != 0o100644 << 16
                or archive.read(filename) != expected_files[filename][1]
            ):
                raise CandidateContractError("candidate ZIP metadata or bytes drifted")


def _publish_exclusive(source: Path, target: Path) -> None:
    """Atomically publish one staged file without ever replacing an existing target."""

    target.parent.mkdir(parents=True, exist_ok=True)
    if target.parent.is_symlink():
        raise CandidateContractError("candidate publication parent cannot be a symlink")
    os.link(source, target, follow_symlinks=False)
    source.unlink()


@dataclass(frozen=True, slots=True)
class CandidateMaterialization:
    candidate_sha256: str
    candidate_receipt_sha256: str
    file_manifest_sha256: str
    zip_sha256: str
    completion_manifest_sha256: str
    file_digests: tuple[ArtifactDigest, ...]

    def __post_init__(self) -> None:
        if type(self) is not CandidateMaterialization:
            raise CandidateContractError("candidate materialization must use the exact type")
        for value in (
            self.candidate_sha256,
            self.candidate_receipt_sha256,
            self.file_manifest_sha256,
            self.zip_sha256,
            self.completion_manifest_sha256,
        ):
            if (
                type(value) is not str
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise CandidateContractError("materialization digest is invalid")
        if type(self.file_digests) is not tuple or any(
            type(item) is not ArtifactDigest for item in self.file_digests
        ):
            raise CandidateContractError("materialization file digests must be exact")
        if tuple(sorted(self.file_digests)) != self.file_digests:
            raise CandidateContractError("materialization file digests must be sorted")


def materialize_manufacturing_candidate(
    candidate: ManufacturingCandidate,
    destination: Path,
) -> CandidateMaterialization:
    """Publish exact candidate bytes, with the completion manifest moved last."""

    if type(candidate) is not ManufacturingCandidate:
        raise CandidateContractError("materialization requires exact ManufacturingCandidate")
    if type(destination) is not type(Path()) or not destination.is_absolute():
        raise CandidateContractError("candidate destination must be an absolute exact Path")
    if destination.exists() and destination.is_symlink():
        raise CandidateContractError("candidate destination cannot be a symlink")
    zip_files, file_manifest, zip_payload, completion = _publication_payloads(candidate)
    published_files = {
        **zip_files,
        ZIP_FILENAME: ("application/zip", zip_payload),
    }
    completion_path = _safe_path(destination, COMPLETION_MANIFEST_FILENAME)
    if destination.exists():
        observed_files, observed_directories = _observed(destination)
        if completion_path.is_file():
            _verify_exact_publication(destination, zip_files, zip_payload, completion)
            del observed_files, observed_directories
        elif observed_files or observed_directories:
            raise CandidateContractError(
                "candidate destination is an incomplete or unmanaged prior publication"
            )
    if not completion_path.is_file():
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.parent.is_symlink():
            raise CandidateContractError("candidate destination parent cannot be a symlink")
        with TemporaryDirectory(prefix=".cam-candidate-", dir=destination.parent) as value:
            staging = Path(value).resolve(strict=True)
            for filename, (_, payload) in zip_files.items():
                path = _safe_path(staging, filename)
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
            zip_path = _safe_path(staging, ZIP_FILENAME)
            zip_path.parent.mkdir(parents=True, exist_ok=True)
            with zip_path.open("xb") as stream:
                stream.write(zip_payload)
                stream.flush()
                os.fsync(stream.fileno())
            if _zip(zip_files) != zip_payload:
                raise CandidateContractError("candidate ZIP is not deterministic")
            destination.mkdir(parents=True, exist_ok=True)
            observed_files, observed_directories = _observed(destination)
            if observed_files or observed_directories:
                raise CandidateContractError(
                    "candidate destination changed during staged publication"
                )
            for filename in sorted(zip_files):
                source_path = _safe_path(staging, filename)
                target_path = _safe_path(destination, filename)
                _publish_exclusive(source_path, target_path)
            target_zip = _safe_path(destination, ZIP_FILENAME)
            _publish_exclusive(zip_path, target_zip)
            # Presence is the completion proof and is intentionally the final mutation.
            staged_completion = _safe_path(staging, COMPLETION_MANIFEST_FILENAME)
            with staged_completion.open("xb") as stream:
                stream.write(completion)
                stream.flush()
                os.fsync(stream.fileno())
            _publish_exclusive(staged_completion, completion_path)
        _verify_exact_publication(destination, zip_files, zip_payload, completion)
    digests = tuple(
        sorted(
            ArtifactDigest(
                filename,
                media_type,
                len(payload),
                _sha256(payload),
            )
            for filename, (media_type, payload) in published_files.items()
        )
    )
    return CandidateMaterialization(
        candidate_sha256=candidate.receipt.candidate_sha256,
        candidate_receipt_sha256=candidate.receipt.receipt_sha256,
        file_manifest_sha256=_sha256(file_manifest),
        zip_sha256=_sha256(zip_payload),
        completion_manifest_sha256=_sha256(completion),
        file_digests=digests,
    )


__all__ = (
    "COMPLETION_MANIFEST_FILENAME",
    "FILE_MANIFEST_FILENAME",
    "ZIP_FILENAME",
    "CandidateMaterialization",
    "materialize_manufacturing_candidate",
)

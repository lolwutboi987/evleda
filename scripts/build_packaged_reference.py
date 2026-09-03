"""Maintainer-only generator for the installed immutable reference resource."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.kicad_project import ProjectAuxiliaryFile

_ARCHIVE_FILENAME = "reference_usb_c_3v3_r2.zip"
_MANIFEST_FILENAME = "manifest.json"
_NON_RELEASE_NOTICE = b"""EVLEDA PACKAGED REFERENCE - NOT FOR FABRICATION

This generated USB-C to 3.3 V board is shipped only for immutable inspection
and optional native KiCad ERC/DRC verification. It is not a manufacturing
release. Human design review, manufacturing capability review, assembler
approval, and release approval are not recorded. Do not send this package to a
fabricator or assembler.
"""


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("ascii")


def _role(path: str, stem: str) -> str:
    roles = {
        f"{stem}.kicad_pcb": "board",
        f"{stem}.kicad_pro": "project",
        f"{stem}.kicad_sch": "schematic",
    }
    if path == "NOT_FOR_FABRICATION.txt":
        return "notice"
    return roles.get(path, "auxiliary")


def _archive(files: tuple[ProjectAuxiliaryFile, ...]) -> bytes:
    target = BytesIO()
    with zipfile.ZipFile(
        target,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        allowZip64=False,
    ) as archive:
        for item in files:
            path = item.relative_name
            payload = item.payload
            info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, payload, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return target.getvalue()


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return path.is_symlink() or (is_junction is not None and is_junction())


def _safe_resource_directory(root: Path) -> Path:
    output = root / "evleda" / "reference"
    for candidate in (root, output.parent, output):
        if _is_link_or_junction(candidate) or not candidate.is_dir():
            raise RuntimeError(f"resource directory must be an existing non-link: {candidate}")
    resolved_root = root.resolve(strict=True)
    resolved_output = output.resolve(strict=True)
    if resolved_output.parent.parent != resolved_root:
        raise RuntimeError("resource directory resolves outside the source checkout")
    return output


def _stage_exact(path: Path, payload: bytes) -> Path:
    if _is_link_or_junction(path) or (path.exists() and not path.is_file()):
        raise RuntimeError(f"refusing to replace non-regular resource {path}")
    descriptor, raw_temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(raw_temporary)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _replace_pair(output: Path, archive_payload: bytes, manifest_payload: bytes) -> None:
    """Replace both resources with rollback if either commit step fails.

    A power loss can still interrupt the two filesystem renames; the runtime's
    independent code-pinned manifest and archive digests then fail closed.
    """

    archive_path = output / _ARCHIVE_FILENAME
    manifest_path = output / _MANIFEST_FILENAME
    for path in (archive_path, manifest_path):
        if _is_link_or_junction(path) or (path.exists() and not path.is_file()):
            raise RuntimeError(f"refusing to read or replace non-regular resource {path}")
    old_archive = archive_path.read_bytes() if archive_path.is_file() else None
    old_manifest = manifest_path.read_bytes() if manifest_path.is_file() else None
    staged_archive: Path | None = None
    staged_manifest: Path | None = None
    try:
        staged_archive = _stage_exact(archive_path, archive_payload)
        staged_manifest = _stage_exact(manifest_path, manifest_payload)
        os.replace(staged_archive, archive_path)
        staged_archive = None
        os.replace(staged_manifest, manifest_path)
        staged_manifest = None
        if (
            archive_path.read_bytes() != archive_payload
            or manifest_path.read_bytes() != manifest_payload
        ):
            raise RuntimeError("resource pair did not persist byte-for-byte")
    except BaseException:
        if staged_archive is not None:
            staged_archive.unlink(missing_ok=True)
        if staged_manifest is not None:
            staged_manifest.unlink(missing_ok=True)
        rollback_archive: Path | None = None
        rollback_manifest: Path | None = None
        try:
            if old_archive is None:
                archive_path.unlink(missing_ok=True)
            else:
                rollback_archive = _stage_exact(archive_path, old_archive)
                os.replace(rollback_archive, archive_path)
                rollback_archive = None
            if old_manifest is None:
                manifest_path.unlink(missing_ok=True)
            else:
                rollback_manifest = _stage_exact(manifest_path, old_manifest)
                os.replace(rollback_manifest, manifest_path)
                rollback_manifest = None
        except BaseException as rollback_error:
            raise RuntimeError(
                "packaged reference pair update and rollback both failed; runtime will fail closed"
            ) from rollback_error
        finally:
            if rollback_archive is not None:
                rollback_archive.unlink(missing_ok=True)
            if rollback_manifest is not None:
                rollback_manifest.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--acknowledge-private-evidence-rebuild",
        action="store_true",
        help="required explicit opt-in to read the maintainer's verified source-evidence cache",
    )
    arguments = parser.parse_args()
    if not arguments.acknowledge_private_evidence_rebuild:
        parser.error("--acknowledge-private-evidence-rebuild is required")

    root = Path(__file__).resolve().parents[1]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from backend.kicad_project import ProjectAuxiliaryFile
    from backend.kicad_worker import ManagedKiCadBundle
    from backend.reference_design import build_reference_artifact_set
    from evleda.reference import validate_packaged_reference_payloads

    output = _safe_resource_directory(root)
    artifact_set = build_reference_artifact_set()
    if artifact_set.result.manufacturing_release_passed is not False:
        raise RuntimeError("reference resource generation cannot carry release authority")
    compiled = artifact_set.compiled.bundle
    managed_files = compiled.all_files
    notice = ProjectAuxiliaryFile(
        "NOT_FOR_FABRICATION.txt",
        "text/plain",
        _NON_RELEASE_NOTICE,
    )
    files = tuple(
        sorted(
            (*managed_files, notice),
            key=lambda item: (item.relative_name.casefold(), item.relative_name),
        )
    )
    managed = ManagedKiCadBundle.create(
        project_id=artifact_set.result.design_id,
        project_revision="rev_" + artifact_set.result.revision_hash,
        stem=compiled.stem,
        project_payload=compiled.project_payload,
        schematic_payload=compiled.schematic_payload,
        board_payload=compiled.board_payload,
        auxiliary_files=compiled.auxiliary_files,
    )
    archive_payload = _archive(files)
    records = [
        {
            "media_type": item.media_type,
            "path": item.relative_name,
            "role": _role(item.relative_name, compiled.stem),
            "sha256": hashlib.sha256(item.payload).hexdigest(),
            "size_bytes": len(item.payload),
        }
        for item in files
    ]
    manifest = {
        "archive": {
            "filename": _ARCHIVE_FILENAME,
            "sha256": hashlib.sha256(archive_payload).hexdigest(),
            "size_bytes": len(archive_payload),
        },
        "files": records,
        "reference": {
            "authority": "immutable-inspection-and-native-verification-only",
            "component_count": len(artifact_set.result.graph.components),
            "graph_sha256": artifact_set.result.graph_hash,
            "managed_bundle_sha256": managed.bundle_sha256,
            "manufacturing_release": False,
            "net_count": len(artifact_set.result.graph.nets),
            "operation_count": sum(
                len(items)
                for items in (
                    artifact_set.result.graph.placements,
                    artifact_set.result.graph.tracks,
                    artifact_set.result.graph.vias,
                    artifact_set.result.graph.zones,
                    artifact_set.result.graph.schematic_wires,
                    artifact_set.result.graph.schematic_junctions,
                )
            ),
            "private_source_blobs_included": False,
            "project_id": artifact_set.result.design_id,
            "project_revision": "rev_" + artifact_set.result.revision_hash,
            "project_stem": compiled.stem,
            "source_rebuild": "explicit-private-evidence-opt-in-only",
        },
        "schema_version": 1,
    }
    manifest_payload = _canonical_json(manifest)
    manifest_sha256 = hashlib.sha256(manifest_payload).hexdigest()
    validate_packaged_reference_payloads(
        manifest_payload,
        archive_payload,
        expected_manifest_sha256=manifest_sha256,
    )
    _replace_pair(output, archive_payload, manifest_payload)
    sys.stdout.write(f"manifest_sha256={manifest_sha256}\n")
    sys.stdout.write(f"archive_sha256={hashlib.sha256(archive_payload).hexdigest()}\n")
    sys.stdout.write(f"archive_size={len(archive_payload)}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

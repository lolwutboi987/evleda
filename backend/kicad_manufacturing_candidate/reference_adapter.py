"""Path-free adapter from immutable reference/publication evidence to a candidate source."""

from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import asdict, dataclass, replace
from io import StringIO
from pathlib import PurePosixPath
from typing import cast

from backend.reference_design import ReferenceArtifactSet
from backend.reference_design.artifacts import (
    PACKAGE_MANIFEST_FILENAME,
    PROJECT_STEM,
)

from .bom import extract_candidate_bom
from .model import CandidateContractError, CandidateSource


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CandidateContractError(f"reference manifest has duplicate key: {key}")
        result[key] = value
    return result


def _decode(payload: bytes, label: str) -> dict[str, object]:
    if type(payload) is not bytes or not payload:
        raise CandidateContractError(f"{label} must be non-empty exact bytes")
    try:
        decoded = json.loads(
            payload.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_constant=lambda value: (_ for _ in ()).throw(
                CandidateContractError(f"{label} has non-finite value: {value}")
            ),
        )
    except CandidateContractError:
        raise
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CandidateContractError(f"{label} is not strict UTF-8 JSON") from exc
    if type(decoded) is not dict:
        raise CandidateContractError(f"{label} root must be an object")
    result = cast(dict[str, object], decoded)
    canonical = (
        json.dumps(
            result,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")
    if payload != canonical:
        raise CandidateContractError(f"{label} bytes are not canonical JSON")
    return result


def _exact_keys(value: dict[str, object], expected: frozenset[str], label: str) -> None:
    if frozenset(value) != expected:
        raise CandidateContractError(f"{label} does not use the closed manifest schema")


def _sha(value: object, label: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise CandidateContractError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _inventory(value: object, label: str) -> dict[str, dict[str, object]]:
    if type(value) is not list:
        raise CandidateContractError(f"{label} must be an array")
    result: dict[str, dict[str, object]] = {}
    folded: set[str] = set()
    for index, raw in enumerate(cast(list[object], value)):
        if type(raw) is not dict:
            raise CandidateContractError(f"{label}[{index}] must be an object")
        item = cast(dict[str, object], raw)
        _exact_keys(
            item,
            frozenset({"filename", "media_type", "byte_length", "sha256"}),
            f"{label}[{index}]",
        )
        filename = item["filename"]
        media_type = item["media_type"]
        byte_length = item["byte_length"]
        if type(filename) is not str or type(media_type) is not str or not media_type:
            raise CandidateContractError(f"{label}[{index}] filename/media type is invalid")
        path = PurePosixPath(filename)
        if (
            not filename
            or "\\" in filename
            or path.is_absolute()
            or any(part in {"", ".", ".."} for part in path.parts)
            or filename.casefold().endswith(".kicad_prl")
        ):
            raise CandidateContractError(f"{label}[{index}] filename is unsafe")
        if type(byte_length) is not int or byte_length < 1:
            raise CandidateContractError(f"{label}[{index}] byte length is invalid")
        _sha(item["sha256"], f"{label}[{index}].sha256")
        if filename.casefold() in folded:
            raise CandidateContractError(f"{label} has a case-insensitive filename collision")
        folded.add(filename.casefold())
        result[filename] = item
    if tuple(result) != tuple(sorted(result)):
        raise CandidateContractError(f"{label} must be sorted by filename")
    return result


def _reference_bom_payloads(artifact_set: ReferenceArtifactSet) -> tuple[bytes, bytes]:
    """Render the reference authority's immutable BOM into its closed formats.

    The adapter deliberately has no filesystem input.  These are the same
    deterministic CSV/JSON serializations used by the reference package, then
    immediately re-parsed and bound against the compiled PCB/schematic by
    ``extract_candidate_bom`` below.
    """

    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(
        (
            "reference",
            "manufacturer",
            "manufacturer_part_number",
            "value",
            "package",
            "assembly_role",
            "source_evidence_ids",
        )
    )
    for line in artifact_set.result.bom:
        writer.writerow(
            (
                line.reference,
                line.manufacturer,
                line.manufacturer_part_number,
                line.value,
                line.package,
                line.assembly_role,
                ";".join(line.source_evidence_ids),
            )
        )
    csv_payload = output.getvalue().encode("utf-8")
    json_payload = (
        json.dumps(
            [asdict(line) for line in artifact_set.result.bom],
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")
    return csv_payload, json_payload


@dataclass(frozen=True, slots=True)
class ReferencePublicationBinding:
    package_manifest_payload: bytes
    publication_manifest_payload: bytes

    def __post_init__(self) -> None:
        if type(self) is not ReferencePublicationBinding:
            raise CandidateContractError("reference publication binding must use the exact type")
        for value, label in (
            (self.package_manifest_payload, "reference package manifest"),
            (self.publication_manifest_payload, "reference publication manifest"),
        ):
            if type(value) is not bytes or not value:
                raise CandidateContractError(f"{label} must be non-empty exact bytes")

    @property
    def package_manifest_sha256(self) -> str:
        return _sha256(self.package_manifest_payload)

    @property
    def publication_manifest_sha256(self) -> str:
        return _sha256(self.publication_manifest_payload)


def candidate_source_from_reference(
    artifact_set: ReferenceArtifactSet,
    publication: ReferencePublicationBinding | None = None,
) -> CandidateSource:
    """Bind already-loaded host evidence; this adapter has no filesystem input."""

    if type(artifact_set) is not ReferenceArtifactSet:
        raise CandidateContractError("reference artifact set must use the exact type")
    result = artifact_set.result
    compiled = artifact_set.compiled
    if result.compiler_manifest_hash != compiled.manifest_sha256:
        raise CandidateContractError("reference result does not bind compiler manifest bytes")
    if result.compiler_bundle_hash != compiled.manifest.output_bundle_sha256:
        raise CandidateContractError("reference result does not bind compiler bundle bytes")

    package_hash: str | None = None
    publication_hash: str | None = None
    if publication is not None:
        if type(publication) is not ReferencePublicationBinding:
            raise CandidateContractError("publication evidence must use the exact type")
        package = _decode(publication.package_manifest_payload, "reference package manifest")
        _exact_keys(
            package,
            frozenset(
                {
                    "schema_version",
                    "kind",
                    "project_stem",
                    "reference_design_artifact_sha256",
                    "compiler_manifest_sha256",
                    "files",
                }
            ),
            "reference package manifest",
        )
        if (
            package["schema_version"] != 1
            or package["kind"] != "flux-clone-reference-package-manifest"
            or package["project_stem"] != PROJECT_STEM
            or package["reference_design_artifact_sha256"] != result.artifact_hash
            or package["compiler_manifest_sha256"] != compiled.manifest_sha256
        ):
            raise CandidateContractError("reference package manifest subject is inconsistent")
        package_files = _inventory(package["files"], "reference package manifest files")
        for item in compiled.bundle.all_files:
            entry = package_files.get(item.relative_name)
            if (
                entry is None
                or entry["media_type"] != item.media_type
                or entry["byte_length"] != len(item.payload)
                or entry["sha256"] != item.sha256
            ):
                raise CandidateContractError(
                    "reference package manifest does not bind compiler source bytes"
                )
        compiler_manifest_entry = package_files.get(compiled.compiler_manifest_filename)
        if (
            compiler_manifest_entry is None
            or compiler_manifest_entry["byte_length"] != len(compiled.manifest_payload)
            or compiler_manifest_entry["sha256"] != compiled.manifest_sha256
        ):
            raise CandidateContractError(
                "reference package manifest does not bind compiler manifest bytes"
            )

        completion = _decode(
            publication.publication_manifest_payload,
            "reference publication manifest",
        )
        _exact_keys(
            completion,
            frozenset({"schema_version", "kind", "project_stem", "files", "zip"}),
            "reference publication manifest",
        )
        if (
            completion["schema_version"] != 1
            or completion["kind"] != "flux-clone-reference-publication-complete"
            or completion["project_stem"] != PROJECT_STEM
        ):
            raise CandidateContractError("reference publication manifest subject is inconsistent")
        publication_files = _inventory(
            completion["files"],
            "reference publication manifest files",
        )
        if set(publication_files) != {*package_files, PACKAGE_MANIFEST_FILENAME}:
            raise CandidateContractError(
                "reference publication inventory does not extend package inventory exactly"
            )
        package_entry = publication_files[PACKAGE_MANIFEST_FILENAME]
        if (
            package_entry["media_type"] != "application/json"
            or package_entry["byte_length"] != len(publication.package_manifest_payload)
            or package_entry["sha256"] != publication.package_manifest_sha256
        ):
            raise CandidateContractError(
                "reference publication does not bind exact package-manifest bytes"
            )
        zip_entry = completion["zip"]
        if type(zip_entry) is not dict:
            raise CandidateContractError("reference publication ZIP entry must be an object")
        zip_fields = cast(dict[str, object], zip_entry)
        _exact_keys(
            zip_fields,
            frozenset({"filename", "media_type", "byte_length", "sha256"}),
            "reference publication ZIP",
        )
        if (
            zip_fields["filename"] != f"{PROJECT_STEM}.zip"
            or zip_fields["media_type"] != "application/zip"
            or type(zip_fields["byte_length"]) is not int
            or zip_fields["byte_length"] < 1
        ):
            raise CandidateContractError("reference publication ZIP metadata is invalid")
        _sha(zip_fields["sha256"], "reference publication ZIP hash")
        package_hash = publication.package_manifest_sha256
        publication_hash = publication.publication_manifest_sha256

    source = CandidateSource(
        compiled_project=compiled,
        expected_source_bundle_sha256=compiled.manifest.output_bundle_sha256,
        expected_manifest_sha256=compiled.manifest_sha256,
        reference_design_artifact_sha256=result.artifact_hash,
        reference_package_manifest_sha256=package_hash,
        reference_publication_manifest_sha256=publication_hash,
    )
    csv_payload, json_payload = _reference_bom_payloads(artifact_set)
    return replace(
        source,
        bom_result=extract_candidate_bom(
            source,
            source_csv_payload=csv_payload,
            source_json_payload=json_payload,
        ),
    )


__all__ = (
    "ReferencePublicationBinding",
    "candidate_source_from_reference",
)

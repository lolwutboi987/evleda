#!/usr/bin/env python3
"""Digest-gated, headless cloud workflow for EvlEDA's fixed reference PCB.

This is deliberately not a general PCB generator.  It can only materialize and
verify the checked-in, content-addressed USB-C-to-3.3-V reference profile.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from dataclasses import asdict, replace
from pathlib import Path, PurePosixPath
from typing import NoReturn, cast
from xml.etree import ElementTree

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from backend.kicad_compile import CompilationManifest, CompiledProject  # noqa: E402
from backend.kicad_manufacturing_candidate import (  # noqa: E402
    NON_FABRICATION_NOTICE_PAYLOAD,
    NON_FABRICATION_NOTICE_SHA256,
    ZIP_FILENAME,
    CandidateHostConfiguration,
    CandidatePolicy,
    CandidateSource,
    KiCadManufacturingCandidatePipeline,
    materialize_manufacturing_candidate,
)
from backend.kicad_manufacturing_candidate.bom import extract_candidate_bom  # noqa: E402
from backend.kicad_project import (  # noqa: E402
    ProjectAuxiliaryFile,
    ProjectBundleInput,
    UnsupportedPolicy,
    round_trip_project_bundle,
)
from backend.kicad_worker import SubprocessRunner, parse_kicad_report  # noqa: E402
from backend.kicad_worker.runtime_support import project_preferences_payload  # noqa: E402
from backend.mcp_server.reference_host import (  # noqa: E402
    ReferenceHostSettings,
    build_reference_host,
)
from evleda.reference import (  # noqa: E402
    PackagedReferenceError,
    load_packaged_reference,
)

WORKFLOW_VERSION = "1.0.0"
PROFILE_ID = "reference-usb-c-3v3-r2"
STEM = "reference_usb_c_3v3_r2"
EXPECTED_KICAD_VERSION = "10.0.6"
SOURCE_ARCHIVE_NAME = "evleda-reference-usb-c-3v3-r2-source.zip"
COMPILER_MANIFEST_NAME = f"{STEM}.flux-compile.json"
PACKAGE_MANIFEST_NAME = f"{STEM}.package-manifest.json"
RESULT_NAME = f"{STEM}.result.json"
BOM_CSV_NAME = f"{STEM}.bom.csv"
BOM_JSON_NAME = f"{STEM}.bom.json"
APPROVAL_DOMAIN = b"evleda.cloud-reference-approval.v1\x00"
RUN_RECEIPT_DOMAIN = b"evleda.cloud-reference-run-receipt.v1\x00"
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_FILES = 256
MAX_ARCHIVE_TOTAL_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_FILE_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
COMMAND_TIMEOUT_SECONDS = 300
ACKNOWLEDGED_ERC_IGNORED_CHECKS = (
    "footprint_filter",
    "four_way_junction",
    "simulation_model_issue",
    "single_global_label",
)
ACKNOWLEDGED_DRC_IGNORED_CHECKS = (
    "footprint_filters_mismatch",
    "footprint_type_mismatch",
    "missing_courtyard",
    "track_not_centered_on_via",
    "tuning_profile_track_geometries",
)
CANDIDATE_POLICY = CandidatePolicy(
    acknowledged_ignored_check_keys=ACKNOWLEDGED_DRC_IGNORED_CHECKS,
    timeout_seconds=COMMAND_TIMEOUT_SECONDS,
)


class WorkflowError(RuntimeError):
    """A fail-closed cloud workflow invariant was not satisfied."""


def _repo_root() -> Path:
    return REPOSITORY_ROOT


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def _domain_sha256(domain: bytes, value: object) -> str:
    return _sha256(domain + _canonical_bytes(value))


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise WorkflowError(f"JSON document has duplicate key {key!r}")
        result[key] = value
    return result


def _json_object(payload: bytes, label: str, *, canonical: bool = True) -> dict[str, object]:
    try:
        value = json.loads(
            payload.decode("utf-8", errors="strict"),
            object_pairs_hook=_unique_object,
            parse_constant=lambda item: (_ for _ in ()).throw(
                WorkflowError(f"{label} contains non-finite number {item}")
            ),
        )
    except WorkflowError:
        raise
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise WorkflowError(f"{label} is not strict UTF-8 JSON") from exc
    if type(value) is not dict:
        raise WorkflowError(f"{label} root must be an object")
    result = cast(dict[str, object], value)
    if canonical and _canonical_bytes(result) != payload:
        raise WorkflowError(f"{label} is not canonical JSON")
    return result


def _regular_bytes(path: Path, label: str, *, maximum: int) -> bytes:
    try:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise WorkflowError(f"{label} is not a regular file")
        if metadata.st_size < 1 or metadata.st_size > maximum:
            raise WorkflowError(f"{label} violates its byte limit")
        payload = path.read_bytes()
    except OSError as exc:
        raise WorkflowError(f"{label} is unavailable") from exc
    if len(payload) != metadata.st_size:
        raise WorkflowError(f"{label} changed while being read")
    return payload


def _portable_zip_name(info: zipfile.ZipInfo) -> str:
    # On Windows ``zipfile`` normalizes ``filename`` separators.  Audit the
    # central-directory spelling retained in ``orig_filename`` instead.
    name = info.orig_filename
    if info.filename != name:
        raise WorkflowError("reference archive contains an unsafe filename")
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or "\x00" in name
        or ":" in name
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise WorkflowError("reference archive contains an unsafe filename")
    return name


def _zip_entries(payload: bytes, label: str) -> dict[str, bytes]:
    if not payload or len(payload) > MAX_ARCHIVE_BYTES:
        raise WorkflowError(f"{label} violates its archive byte limit")
    entries: dict[str, bytes] = {}
    folded: set[str] = set()
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
            infos = archive.infolist()
            if not infos or len(infos) > MAX_ARCHIVE_FILES:
                raise WorkflowError(f"{label} violates its entry-count limit")
            for info in infos:
                name = _portable_zip_name(info)
                if info.is_dir():
                    raise WorkflowError(f"{label} contains an explicit directory entry")
                if info.flag_bits & 0x1:
                    raise WorkflowError(f"{label} contains an encrypted entry")
                unix_mode = info.external_attr >> 16
                file_type = stat.S_IFMT(unix_mode)
                if file_type not in {0, stat.S_IFREG}:
                    raise WorkflowError(f"{label} contains a non-regular entry")
                if name.casefold() in folded:
                    raise WorkflowError(f"{label} contains a portable filename collision")
                if info.file_size < 1 or info.file_size > MAX_ARCHIVE_FILE_BYTES:
                    raise WorkflowError(f"{label} entry {name!r} violates its byte limit")
                if info.compress_size == 0 or info.file_size > info.compress_size * 200:
                    raise WorkflowError(f"{label} entry {name!r} violates its expansion limit")
                total += info.file_size
                if total > MAX_ARCHIVE_TOTAL_BYTES:
                    raise WorkflowError(f"{label} violates its expanded byte limit")
                item = archive.read(info)
                if len(item) != info.file_size:
                    raise WorkflowError(f"{label} entry {name!r} was truncated")
                entries[name] = item
                folded.add(name.casefold())
            if archive.testzip() is not None:
                raise WorkflowError(f"{label} failed its CRC check")
    except WorkflowError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise WorkflowError(f"{label} is not a valid bounded ZIP") from exc
    return entries


def _release_source() -> tuple[bytes, dict[str, bytes], dict[str, object]]:
    root = _repo_root()
    example = root / "examples" / "reference_usb_c_3v3_r2"
    release_payload = _regular_bytes(
        example / "release-assets.json", "release asset manifest", maximum=256 * 1024
    )
    release = _json_object(release_payload, "release asset manifest", canonical=False)
    if (
        release.get("schema_version") != 1
        or release.get("project") != PROFILE_ID
        or release.get("manufacturing_release_eligible") is not False
        or type(release.get("assets")) is not list
    ):
        raise WorkflowError("release asset manifest does not describe the non-release profile")
    matching: list[dict[str, object]] = []
    for raw_item in cast(list[object], release["assets"]):
        if type(raw_item) is not dict:
            continue
        item = cast(dict[str, object], raw_item)
        if item.get("filename") == SOURCE_ARCHIVE_NAME:
            matching.append(item)
    if len(matching) != 1:
        raise WorkflowError("release asset manifest does not bind one source archive")
    source_entry = matching[0]
    expected_size = source_entry.get("byte_length")
    expected_hash = source_entry.get("sha256")
    if (
        type(expected_size) is not int
        or expected_size < 1
        or type(expected_hash) is not str
        or SHA256_PATTERN.fullmatch(expected_hash) is None
    ):
        raise WorkflowError("source archive release binding is invalid")
    archive_payload = _regular_bytes(
        example / SOURCE_ARCHIVE_NAME, "source archive", maximum=MAX_ARCHIVE_BYTES
    )
    if len(archive_payload) != expected_size or _sha256(archive_payload) != expected_hash:
        raise WorkflowError("source archive does not match release-assets.json")
    return archive_payload, _zip_entries(archive_payload, "source archive"), source_entry


def _compiled_source(entries: dict[str, bytes]) -> tuple[CandidateSource, dict[str, bytes]]:
    required_metadata = {
        COMPILER_MANIFEST_NAME,
        PACKAGE_MANIFEST_NAME,
        RESULT_NAME,
        BOM_CSV_NAME,
        BOM_JSON_NAME,
    }
    if not required_metadata.issubset(entries):
        raise WorkflowError("source archive is missing required deterministic metadata")
    manifest_payload = entries[COMPILER_MANIFEST_NAME]
    manifest_object = _json_object(manifest_payload, "compiler manifest")
    try:
        manifest = CompilationManifest.from_primitive(manifest_object)
    except (TypeError, ValueError) as exc:
        raise WorkflowError("compiler manifest violates its closed schema") from exc
    if (
        manifest.project_stem != STEM
        or not manifest.semantic_parity
        or not manifest.reference_design_ready
        or manifest.manufacturing_release_eligible
    ):
        raise WorkflowError("compiler manifest is not the fixed non-release reference profile")
    file_map: dict[str, bytes] = {}
    for digest in manifest.files:
        payload = entries.get(digest.filename)
        if payload is None:
            raise WorkflowError(f"source archive is missing compiler file {digest.filename!r}")
        if len(payload) != digest.byte_length or _sha256(payload) != digest.sha256:
            raise WorkflowError(f"compiler file {digest.filename!r} failed its digest binding")
        file_map[digest.filename] = payload
    inventory_material = [
        {
            "filename": item.filename,
            "byteLength": item.byte_length,
            "sha256": item.sha256,
        }
        for item in manifest.files
    ]
    bundle_digest = _sha256(
        b"flux-clone-compiled-bundle-v1\x00" + _canonical_bytes(inventory_material)
    )
    if bundle_digest != manifest.output_bundle_sha256:
        raise WorkflowError("compiler bundle digest does not match the exact file inventory")
    primary_names = {
        f"{STEM}.kicad_pro",
        f"{STEM}.kicad_sch",
        f"{STEM}.kicad_pcb",
    }
    if not primary_names.issubset(file_map):
        raise WorkflowError("compiler bundle is missing a primary KiCad file")
    by_name = {item.filename: item for item in manifest.files}
    auxiliary = tuple(
        ProjectAuxiliaryFile(name, by_name[name].media_type, file_map[name])
        for name in sorted(file_map, key=lambda item: (item.casefold(), item))
        if name not in primary_names
    )
    bundle = ProjectBundleInput(
        STEM,
        file_map[f"{STEM}.kicad_pro"],
        file_map[f"{STEM}.kicad_sch"],
        file_map[f"{STEM}.kicad_pcb"],
        auxiliary,
    )
    compiled = CompiledProject(bundle, manifest, manifest_payload, _sha256(manifest_payload))

    package = _json_object(entries[PACKAGE_MANIFEST_NAME], "reference package manifest")
    artifact_hash = package.get("reference_design_artifact_sha256")
    if (
        package.get("schema_version") != 1
        or package.get("project_stem") != STEM
        or package.get("compiler_manifest_sha256") != compiled.manifest_sha256
        or type(artifact_hash) is not str
        or SHA256_PATTERN.fullmatch(artifact_hash) is None
    ):
        raise WorkflowError("reference package manifest does not bind the compiled source")
    result = _json_object(entries[RESULT_NAME], "reference result")
    if (
        result.get("artifact_hash") != artifact_hash
        or result.get("compiler_manifest_hash") != compiled.manifest_sha256
        or result.get("compiler_bundle_hash") != manifest.output_bundle_sha256
        or result.get("manufacturing_release_passed") is not False
    ):
        raise WorkflowError("reference result contradicts the non-release compiled source")

    source = CandidateSource(
        compiled_project=compiled,
        expected_source_bundle_sha256=manifest.output_bundle_sha256,
        expected_manifest_sha256=compiled.manifest_sha256,
        reference_design_artifact_sha256=artifact_hash,
    )
    try:
        bom = extract_candidate_bom(
            source,
            source_csv_payload=entries[BOM_CSV_NAME],
            source_json_payload=entries[BOM_JSON_NAME],
        )
    except (TypeError, ValueError) as exc:
        raise WorkflowError("reference BOM does not bind the exact compiled source") from exc
    return replace(source, bom_result=bom), file_map


def _packaged_runtime_files(
    compiler_files: dict[str, bytes],
) -> tuple[dict[str, bytes], dict[str, object]]:
    """Prefer and verify the wheel's packaged immutable project when present."""

    resource_root = _repo_root() / "evleda" / "reference"
    if not resource_root.exists():
        return compiler_files, {
            "available": False,
            "materialization_source": "release-source-archive",
        }
    try:
        packaged = load_packaged_reference()
    except PackagedReferenceError as exc:
        raise WorkflowError("packaged reference runtime failed its trust contract") from exc
    if packaged.manufacturing_release is not False or packaged.bundle.stem != STEM:
        raise WorkflowError("packaged reference is not the fixed non-release profile")
    runtime_files = {
        item.relative_name: item.payload for item in packaged.bundle.all_files
    }
    if set(runtime_files) != set(compiler_files):
        raise WorkflowError("packaged reference inventory differs from the compiler inventory")
    if any(runtime_files[name] != compiler_files[name] for name in compiler_files):
        raise WorkflowError("packaged reference bytes differ from the compiler-bound source")
    return runtime_files, {
        "available": True,
        "materialization_source": "evleda-packaged-reference-runtime",
        "manifest_sha256": packaged.manifest_sha256,
        "archive_sha256": packaged.archive_sha256,
        "managed_bundle_sha256": packaged.bundle.bundle_sha256,
        "project_id": packaged.bundle.project_id,
        "project_revision": packaged.bundle.project_revision,
        "graph_sha256": packaged.graph_sha256,
        "component_count": packaged.component_count,
        "net_count": packaged.net_count,
        "operation_count": packaged.operation_count,
        "private_source_blobs_included": False,
    }


def _mcp_inspection(runtime_binding: dict[str, object]) -> dict[str, object]:
    """Exercise the real least-privilege MCP host without native mutation."""

    with tempfile.TemporaryDirectory(prefix="evleda-cloud-mcp-") as raw_root:
        state_root = Path(raw_root) / "inspect-only-state"
        runtime = build_reference_host(ReferenceHostSettings(state_root))

        def request(message: dict[str, object]) -> dict[str, object]:
            response = runtime.server.handle_line(_canonical_bytes(message))
            if type(response) is not bytes:
                raise WorkflowError("MCP request did not return one JSON-RPC response")
            return _json_object(response, "MCP response", canonical=False)

        initialized = request(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "evleda-cloud-reference",
                        "version": WORKFLOW_VERSION,
                    },
                },
            }
        )
        if initialized.get("id") != 1 or type(initialized.get("result")) is not dict:
            raise WorkflowError("MCP initialize response is invalid")
        notification = runtime.server.handle_line(
            _canonical_bytes(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                    "params": {},
                }
            )
        )
        if notification is not None:
            raise WorkflowError("MCP initialized notification returned a response")
        listed = request(
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        )
        listed_result = listed.get("result")
        if type(listed_result) is not dict:
            raise WorkflowError("MCP tools/list result is invalid")
        raw_tools = cast(dict[str, object], listed_result).get("tools")
        if type(raw_tools) is not list:
            raise WorkflowError("MCP tools/list omitted its tool array")
        tool_names = [
            cast(dict[str, object], item).get("name")
            for item in cast(list[object], raw_tools)
            if type(item) is dict
        ]
        if tool_names != ["inspect_project"]:
            raise WorkflowError("inspect-only MCP host exposed an unexpected capability set")
        inspected = request(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "inspect_project",
                    "arguments": {
                        "project_id": runtime.project_id,
                        "expected_project_revision": runtime.project_revision,
                    },
                },
            }
        )
        inspect_result = inspected.get("result")
        if type(inspect_result) is not dict:
            raise WorkflowError("MCP inspect_project result is invalid")
        structured = cast(dict[str, object], inspect_result).get("structuredContent")
        if type(structured) is not dict:
            raise WorkflowError("MCP inspect_project omitted structured content")
        payload_json = cast(dict[str, object], structured).get("payload_json")
        if type(payload_json) is not str:
            raise WorkflowError("MCP inspect_project payload is invalid")
        payload = _json_object(
            payload_json.encode("utf-8"), "MCP inspect_project payload", canonical=False
        )
        snapshot = payload.get("snapshot")
        if type(snapshot) is not dict:
            raise WorkflowError("MCP inspect_project omitted its snapshot")
        exact_snapshot = cast(dict[str, object], snapshot)
        if frozenset(exact_snapshot) != frozenset(
            {
                "active_staged_revision",
                "component_count",
                "net_count",
                "operation_count",
                "project_id",
                "project_revision",
            }
        ):
            raise WorkflowError("MCP inspect_project snapshot schema changed")
        if (
            exact_snapshot["active_staged_revision"] is not None
            or exact_snapshot["project_id"] != runtime_binding.get("project_id")
            or exact_snapshot["project_revision"]
            != runtime_binding.get("project_revision")
            or exact_snapshot["component_count"]
            != runtime_binding.get("component_count")
            or exact_snapshot["net_count"] != runtime_binding.get("net_count")
            or exact_snapshot["operation_count"]
            != runtime_binding.get("operation_count")
            or runtime.project_id != exact_snapshot["project_id"]
            or runtime.project_revision != exact_snapshot["project_revision"]
        ):
            raise WorkflowError("MCP snapshot contradicts the packaged runtime identity")
        if state_root.exists():
            raise WorkflowError("inspect-only MCP preflight unexpectedly created state")
        return {
            "protocol_version": cast(dict[str, object], initialized["result"]).get(
                "protocolVersion"
            ),
            "tools": tool_names,
            "snapshot": exact_snapshot,
            "side_effect_free": True,
        }


def _round_trip_evidence(source: CandidateSource) -> dict[str, object]:
    first = round_trip_project_bundle(
        source.compiled_project.bundle,
        unsupported_policy=UnsupportedPolicy.REJECT,
    )
    second = round_trip_project_bundle(
        source.compiled_project.bundle,
        unsupported_policy=UnsupportedPolicy.REJECT,
    )
    first_value = asdict(first.evidence)
    second_value = asdict(second.evidence)
    if (
        first_value != second_value
        or not first.evidence.semantic_parity
        or not first.evidence.diagnostics_parity
        or not first.evidence.auxiliary_files_parity
        or first.evidence.imported_bundle_sha256
        != first.evidence.reparsed_bundle_sha256
    ):
        raise WorkflowError("deterministic project codec parity/replay failed")
    return {
        **first_value,
        "semantic_parity": True,
        "diagnostics_parity": True,
        "auxiliary_files_parity": True,
        "deterministic_replay": True,
        "evidence_sha256": first.evidence.evidence_sha256,
    }


def _plan_material() -> tuple[dict[str, object], CandidateSource, dict[str, bytes]]:
    archive_payload, entries, release_binding = _release_source()
    source, compiler_files = _compiled_source(entries)
    runtime_files, runtime_binding = _packaged_runtime_files(compiler_files)
    parity = _round_trip_evidence(source)
    mcp_inspection = _mcp_inspection(runtime_binding)
    manifest = source.compiled_project.manifest
    body: dict[str, object] = {
        "schema_version": 1,
        "workflow": "evleda-cloud-reference",
        "workflow_version": WORKFLOW_VERSION,
        "profile_id": PROFILE_ID,
        "scope": {
            "kind": "fixed-verified-reference-only",
            "arbitrary_board_generation_supported": False,
            "input": "USB-C 5 V sink",
            "output": "3.3 V output only, 100 mA maximum",
            "project_stem": STEM,
        },
        "requirements_to_confirm": [
            "Use the exact packaged reference design; do not reinterpret or edit its circuit.",
            "Treat 3V3 as output-only and never apply power to the 3V3 output.",
            "Produce engineering-review artifacts only, never fabrication authority.",
        ],
        "source": {
            "release_archive": SOURCE_ARCHIVE_NAME,
            "release_archive_sha256": _sha256(archive_payload),
            "release_archive_byte_length": len(archive_payload),
            "release_binding_kind": release_binding.get("kind"),
            "compiler_manifest_sha256": source.expected_manifest_sha256,
            "compiler_bundle_sha256": source.expected_source_bundle_sha256,
            "input_graph_sha256": manifest.input_graph_sha256,
            "reference_design_artifact_sha256": source.reference_design_artifact_sha256,
            "board_sha256": _sha256(runtime_files[f"{STEM}.kicad_pcb"]),
            "file_count": len(runtime_files),
            "packaged_runtime": runtime_binding,
        },
        "verification_plan": [
            "materialize exact packaged reference bytes",
            "deterministic project codec semantic parity and replay",
            "native KiCad ERC with zero findings",
            "native KiCad unfilled/no-save DRC with zero findings",
            "native KiCad refill/no-save DRC with zero findings",
            "headless schematic and PCB SVG rendering",
            "content-addressed non-release CAM candidate generation",
        ],
        "native_tool": {
            "name": "kicad-cli",
            "required_exact_version": EXPECTED_KICAD_VERSION,
            "headless": True,
        },
        "output_policy": {
            "manufacturing_release_eligible": False,
            "not_for_fabrication_notice_sha256": NON_FABRICATION_NOTICE_SHA256,
            "physical_qualification_performed": False,
            "cam_candidate_policy_sha256": CANDIDATE_POLICY.policy_sha256,
            "acknowledged_drc_ignored_checks": list(
                ACKNOWLEDGED_DRC_IGNORED_CHECKS
            ),
            "acknowledged_erc_ignored_checks": list(
                ACKNOWLEDGED_ERC_IGNORED_CHECKS
            ),
        },
    }
    body["codec_preflight"] = parity
    body["mcp_preflight"] = mcp_inspection
    return body, source, runtime_files


def _plan_document() -> tuple[dict[str, object], CandidateSource, dict[str, bytes]]:
    body, source, runtime_files = _plan_material()
    digest = _domain_sha256(APPROVAL_DOMAIN, body)
    document = {
        **body,
        "approval": {
            "subject_sha256": digest,
            "exact_phrase": f"APPROVE EVLEDA REFERENCE PLAN {digest}",
            "must_be_received_in_later_user_turn": True,
            "execution_started": False,
        },
    }
    return document, source, runtime_files


def _write_exclusive(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or path.exists():
        raise WorkflowError(f"refusing to overwrite {path}")
    try:
        with path.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as exc:
        raise WorkflowError(f"could not write {path}") from exc
    if path.read_bytes() != payload:
        raise WorkflowError(f"persisted bytes changed for {path}")


def _safe_output_root(requested: Path) -> Path:
    allowed = _repo_root() / "outputs"
    if allowed.is_symlink():
        raise WorkflowError("repository outputs directory cannot be a symlink")
    try:
        allowed.mkdir(mode=0o700, exist_ok=True)
        allowed_metadata = allowed.lstat()
    except OSError as exc:
        raise WorkflowError("repository outputs directory is unavailable") from exc
    if not stat.S_ISDIR(allowed_metadata.st_mode):
        raise WorkflowError("repository outputs path is not a directory")
    allowed = allowed.resolve(strict=True)
    if not requested.is_absolute():
        requested = (_repo_root() / requested).resolve(strict=False)
    try:
        parent = requested.parent.resolve(strict=True)
    except OSError as exc:
        raise WorkflowError(
            "output must be a direct child of the repository outputs directory"
        ) from exc
    candidate = parent / requested.name
    if parent != allowed:
        raise WorkflowError("output must be a direct child of the repository outputs directory")
    if not candidate.name or candidate.exists() or candidate.is_symlink():
        raise WorkflowError("output directory must be a new, narrow, non-symlink path")
    try:
        candidate.mkdir(mode=0o700)
        metadata = candidate.lstat()
    except OSError as exc:
        raise WorkflowError("output directory could not be created exclusively") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise WorkflowError("output directory is not a regular directory")
    return candidate.resolve(strict=True)


def _materialize_files(root: Path, files: dict[str, bytes]) -> dict[str, str]:
    result: dict[str, str] = {}
    for name in sorted(files, key=lambda item: (item.casefold(), item)):
        path = PurePosixPath(name)
        destination = root.joinpath(*path.parts)
        resolved_parent = destination.parent.resolve(strict=False)
        if root != resolved_parent and root not in resolved_parent.parents:
            raise WorkflowError("materialization path escaped its output root")
        _write_exclusive(destination, files[name])
        result[name] = _sha256(files[name])
    return result


def _resolve_kicad(explicit: Path | None) -> tuple[Path, str]:
    if explicit is None:
        raise WorkflowError("an explicit reviewed --kicad-cli path is required")
    try:
        executable = explicit.expanduser().resolve(strict=True)
        metadata = executable.lstat()
    except OSError as exc:
        raise WorkflowError("kicad-cli path is unavailable") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise WorkflowError("resolved kicad-cli is not a regular file")
    executable_hash = _sha256(executable.read_bytes())
    runner = SubprocessRunner()
    with tempfile.TemporaryDirectory(prefix="evleda-version-") as value_root:
        result = runner.run(
            (str(executable), "version"),
            cwd=Path(value_root),
            environment=_command_environment(Path(value_root), executable),
            timeout_seconds=30,
            max_stdout_bytes=4096,
            max_stderr_bytes=4096,
        )
    try:
        version = result.stdout.decode("utf-8", errors="strict").strip()
        stderr = result.stderr.decode("utf-8", errors="strict").strip()
    except UnicodeError as exc:
        raise WorkflowError("kicad-cli version output is not UTF-8") from exc
    if result.exit_code != 0 or stderr or VERSION_PATTERN.fullmatch(version) is None:
        raise WorkflowError("kicad-cli version output is outside the pinned contract")
    if version != EXPECTED_KICAD_VERSION:
        raise WorkflowError(
            f"kicad-cli {version} is installed; this profile requires {EXPECTED_KICAD_VERSION}"
        )
    if _sha256(executable.read_bytes()) != executable_hash:
        raise WorkflowError("kicad-cli changed during its version probe")
    return executable, executable_hash


def _command_environment(root: Path, executable: Path) -> dict[str, str]:
    home = root / "home"
    config = root / "config"
    temporary = root / "tmp"
    for path in (home, config, temporary):
        path.mkdir(parents=True, exist_ok=True)
    search = [str(executable.parent)]
    for candidate in ("/usr/local/bin", "/usr/bin", "/bin"):
        if Path(candidate).is_dir():
            search.append(candidate)
    result = {
        "HOME": str(home),
        "KICAD_CONFIG_HOME": str(config),
        "XDG_CONFIG_HOME": str(config),
        "TMPDIR": str(temporary),
        "TEMP": str(temporary),
        "TMP": str(temporary),
        "PATH": os.pathsep.join(search),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    for name in ("SYSTEMROOT", "WINDIR"):
        if name in os.environ:
            result[name] = os.environ[name]
    return result


def _copy_project(root: Path, files: dict[str, bytes]) -> dict[str, str]:
    root.mkdir(mode=0o700, parents=True)
    digests = _materialize_files(root, files)
    runtime = project_preferences_payload(STEM)
    runtime_name = f"{STEM}.kicad_prl"
    _write_exclusive(root / runtime_name, runtime)
    digests[runtime_name] = _sha256(runtime)
    return digests


def _logical_argv(argv: tuple[str, ...], root: Path) -> list[str]:
    rendered: list[str] = []
    for index, item in enumerate(argv):
        if index == 0:
            rendered.append("kicad-cli")
        else:
            rendered.append(
                item.replace(str(root), "<RUNROOT>").replace(root.as_posix(), "<RUNROOT>")
            )
    return rendered


def _run_native(
    *,
    stage: str,
    argv: tuple[str, ...],
    cwd: Path,
    environment: dict[str, str],
    run_root: Path,
    expected_executable_sha256: str,
    allowed_exit_codes: frozenset[int] = frozenset({0}),
) -> tuple[bytes, bytes, dict[str, object]]:
    executable = Path(argv[0])
    if _sha256(_regular_bytes(executable, "pinned kicad-cli", maximum=256 * 1024 * 1024)) != (
        expected_executable_sha256
    ):
        raise WorkflowError(f"pinned kicad-cli changed before native stage {stage}")
    result = SubprocessRunner().run(
        argv,
        cwd=cwd,
        environment=environment,
        timeout_seconds=COMMAND_TIMEOUT_SECONDS,
        max_stdout_bytes=MAX_COMMAND_OUTPUT_BYTES,
        max_stderr_bytes=MAX_COMMAND_OUTPUT_BYTES,
    )
    if result.exit_code not in allowed_exit_codes:
        raise WorkflowError(f"native stage {stage} returned exit code {result.exit_code}")
    if _sha256(_regular_bytes(executable, "pinned kicad-cli", maximum=256 * 1024 * 1024)) != (
        expected_executable_sha256
    ):
        raise WorkflowError(f"pinned kicad-cli changed during native stage {stage}")
    logical = _logical_argv(argv, run_root)
    return result.stdout, result.stderr, {
        "stage": stage,
        "logical_argv": logical,
        "argv_sha256": _domain_sha256(b"evleda.cloud-command.v1\x00", logical),
        "exit_code": result.exit_code,
        "stdout_sha256": _sha256(result.stdout),
        "stderr_sha256": _sha256(result.stderr),
    }


def _check_source_digests(root: Path, expected: dict[str, str]) -> None:
    for name, digest in expected.items():
        path = root.joinpath(*PurePosixPath(name).parts)
        payload = _regular_bytes(path, f"managed source {name}", maximum=MAX_OUTPUT_BYTES)
        if _sha256(payload) != digest:
            raise WorkflowError(f"native operation mutated managed source {name!r}")


def _native_check(
    *,
    check: str,
    refill: bool,
    operation_root: Path,
    executable: Path,
    executable_sha256: str,
    files: dict[str, bytes],
    run_root: Path,
) -> dict[str, object]:
    workspace = operation_root / "project"
    environment_root = operation_root / "runtime"
    expected = _copy_project(workspace, files)
    report = operation_root / f"{check}{'-refill' if refill else ''}.json"
    if check == "erc":
        argv = (
            str(executable),
            "sch",
            "erc",
            "--format",
            "json",
            "--severity-all",
            "--exit-code-violations",
            "--output",
            str(report),
            str(workspace / f"{STEM}.kicad_sch"),
        )
        source_name = f"{STEM}.kicad_sch"
        stage = "erc-no-save"
    else:
        values = [
            str(executable),
            "pcb",
            "drc",
            "--format",
            "json",
            "--units",
            "mm",
            "--severity-all",
            "--schematic-parity",
            "--all-track-errors",
            "--exit-code-violations",
        ]
        if refill:
            values.append("--refill-zones")
        values.extend(("--output", str(report), str(workspace / f"{STEM}.kicad_pcb")))
        argv = tuple(values)
        source_name = f"{STEM}.kicad_pcb"
        stage = "drc-refill-no-save" if refill else "drc-unfilled-no-save"
    _, _, command = _run_native(
        stage=stage,
        argv=argv,
        cwd=environment_root,
        environment=_command_environment(environment_root, executable),
        run_root=run_root,
        expected_executable_sha256=executable_sha256,
        allowed_exit_codes=frozenset({0, 5}),
    )
    payload = _regular_bytes(report, f"{stage} report", maximum=MAX_OUTPUT_BYTES)
    parsed = parse_kicad_report(
        check,
        payload,
        expected_source=source_name,
        expected_version=EXPECTED_KICAD_VERSION,
    )
    expected_exit = 0 if not parsed.findings else 5
    if command["exit_code"] != expected_exit or parsed.findings:
        raise WorkflowError(f"{stage} did not produce an exact zero-finding pass")
    ignored_keys = tuple(
        sorted(cast(str, item["key"]) for item in parsed.ignored_checks)
    )
    expected_ignored = (
        ACKNOWLEDGED_DRC_IGNORED_CHECKS
        if check == "drc"
        else ACKNOWLEDGED_ERC_IGNORED_CHECKS
    )
    if ignored_keys != expected_ignored:
        raise WorkflowError(f"{stage} ignored-check set differs from the approved policy")
    _check_source_digests(workspace, expected)
    return {
        **command,
        "finding_count": 0,
        "acknowledged_ignored_checks": list(ignored_keys),
        "raw_report_sha256": parsed.raw_sha256,
        "normalized_report": parsed.normalized_report,
        "source_bytes_unchanged": True,
    }


def _validate_svg(path: Path, label: str) -> dict[str, object]:
    payload = _regular_bytes(path, label, maximum=MAX_OUTPUT_BYTES)
    try:
        root = ElementTree.fromstring(payload)
    except ElementTree.ParseError as exc:
        raise WorkflowError(f"{label} is not XML") from exc
    if not root.tag.endswith("svg"):
        raise WorkflowError(f"{label} root is not SVG")
    return {
        "filename": path.name,
        "byte_length": len(payload),
        "sha256": _sha256(payload),
        "root": root.tag,
    }


def _render(
    *,
    operation_root: Path,
    executable: Path,
    executable_sha256: str,
    files: dict[str, bytes],
    run_root: Path,
) -> dict[str, object]:
    workspace = operation_root / "project"
    runtime = operation_root / "runtime"
    expected = _copy_project(workspace, files)
    output = run_root / "renders"
    schematic_output = output / "schematic"
    schematic_output.mkdir(parents=True)
    pcb_output = output / f"{STEM}-pcb-top.svg"
    environment = _command_environment(runtime, executable)
    commands: list[dict[str, object]] = []
    _, _, schematic_command = _run_native(
        stage="render-schematic-svg",
        argv=(
            str(executable),
            "sch",
            "export",
            "svg",
            "--output",
            str(schematic_output),
            "--exclude-drawing-sheet",
            str(workspace / f"{STEM}.kicad_sch"),
        ),
        cwd=runtime,
        environment=environment,
        run_root=run_root,
        expected_executable_sha256=executable_sha256,
    )
    commands.append(schematic_command)
    _, _, pcb_command = _run_native(
        stage="render-pcb-svg",
        argv=(
            str(executable),
            "pcb",
            "export",
            "svg",
            "--output",
            str(pcb_output),
            "--layers",
            "F.Cu,F.Mask,F.Silkscreen,Edge.Cuts",
            "--page-size-mode",
            "2",
            "--exclude-drawing-sheet",
            "--mode-single",
            str(workspace / f"{STEM}.kicad_pcb"),
        ),
        cwd=runtime,
        environment=environment,
        run_root=run_root,
        expected_executable_sha256=executable_sha256,
    )
    commands.append(pcb_command)
    schematic_svgs = sorted(schematic_output.glob("*.svg"))
    if len(schematic_svgs) != 1:
        raise WorkflowError("schematic render did not produce exactly one SVG")
    _check_source_digests(workspace, expected)
    return {
        "commands": commands,
        "artifacts": [
            _validate_svg(schematic_svgs[0], "schematic SVG"),
            _validate_svg(pcb_output, "PCB SVG"),
        ],
        "source_bytes_unchanged": True,
    }


def _run(approval: str, output: Path, explicit_kicad: Path | None) -> dict[str, object]:
    plan, source, runtime_files = _plan_document()
    expected_approval = cast(dict[str, object], plan["approval"])["subject_sha256"]
    if SHA256_PATTERN.fullmatch(approval) is None or approval != expected_approval:
        raise WorkflowError(
            "approval digest is absent, stale, or does not bind the exact current plan"
        )
    executable, executable_hash = _resolve_kicad(explicit_kicad)
    run_root = _safe_output_root(output)
    source_root = run_root / "source"
    source_root.mkdir(mode=0o700)
    source_inventory = _materialize_files(source_root, runtime_files)
    _write_exclusive(run_root / "NOT_FOR_FABRICATION.txt", NON_FABRICATION_NOTICE_PAYLOAD)

    operations = run_root / "operations"
    operations.mkdir(mode=0o700)
    parity_first = _round_trip_evidence(source)
    parity_second = _round_trip_evidence(source)
    if parity_first != parity_second:
        raise WorkflowError("semantic parity evidence failed deterministic replay")
    checks = [
        _native_check(
            check="erc",
            refill=False,
            operation_root=operations / "erc",
            executable=executable,
            executable_sha256=executable_hash,
            files=runtime_files,
            run_root=run_root,
        ),
        _native_check(
            check="drc",
            refill=False,
            operation_root=operations / "drc-unfilled",
            executable=executable,
            executable_sha256=executable_hash,
            files=runtime_files,
            run_root=run_root,
        ),
        _native_check(
            check="drc",
            refill=True,
            operation_root=operations / "drc-refill-no-save",
            executable=executable,
            executable_sha256=executable_hash,
            files=runtime_files,
            run_root=run_root,
        ),
    ]
    render = _render(
        operation_root=operations / "render",
        executable=executable,
        executable_sha256=executable_hash,
        files=runtime_files,
        run_root=run_root,
    )

    candidate_temp = operations / "candidate-temp"
    candidate_temp.mkdir(mode=0o700)
    candidate = KiCadManufacturingCandidatePipeline(
        CandidateHostConfiguration(
            executable=executable,
            executable_sha256=executable_hash,
            kicad_version=EXPECTED_KICAD_VERSION,
            temp_root=candidate_temp,
        ),
        policy=CANDIDATE_POLICY,
    ).generate(source)
    candidate_output = materialize_manufacturing_candidate(
        candidate, run_root / "cam-candidate"
    )
    if candidate.receipt.manufacturing_release_eligible:
        raise WorkflowError("CAM candidate unexpectedly claimed manufacturing authority")
    if (
        candidate_output.candidate_sha256 != candidate.receipt.candidate_sha256
        or candidate_output.candidate_receipt_sha256 != candidate.receipt.receipt_sha256
    ):
        raise WorkflowError("CAM materialization digests do not bind the generated candidate")
    cam_zip_payload = _regular_bytes(
        run_root / "cam-candidate" / ZIP_FILENAME,
        "CAM candidate ZIP",
        maximum=MAX_ARCHIVE_BYTES,
    )
    if _sha256(cam_zip_payload) != candidate_output.zip_sha256:
        raise WorkflowError("CAM candidate ZIP does not match its publication digest")
    cam_zip_entries = _zip_entries(cam_zip_payload, "CAM candidate ZIP")
    if cam_zip_entries.get("NOT_FOR_FABRICATION.txt") != NON_FABRICATION_NOTICE_PAYLOAD:
        raise WorkflowError("CAM candidate ZIP is missing its exact non-fabrication notice")
    _check_source_digests(source_root, source_inventory)

    receipt_body: dict[str, object] = {
        "schema_version": 1,
        "workflow": "evleda-cloud-reference",
        "workflow_version": WORKFLOW_VERSION,
        "approval_subject_sha256": approval,
        "profile_id": PROFILE_ID,
        "project_stem": STEM,
        "source_file_sha256": source_inventory,
        "source_bytes_unchanged": True,
        "codec_parity_replay": parity_first,
        "native": {
            "kicad_version": EXPECTED_KICAD_VERSION,
            "kicad_executable_sha256": executable_hash,
            "checks": checks,
        },
        "render": render,
        "cam_candidate": {
            "candidate_sha256": candidate.receipt.candidate_sha256,
            "receipt_sha256": candidate.receipt.receipt_sha256,
            "publication_manifest_sha256": candidate_output.completion_manifest_sha256,
            "zip_sha256": candidate_output.zip_sha256,
            "manufacturing_release_eligible": False,
            "not_for_fabrication_notice_sha256": NON_FABRICATION_NOTICE_SHA256,
        },
        "manufacturing_release_eligible": False,
        "physical_qualification_performed": False,
    }
    receipt_body["receipt_subject_sha256"] = _domain_sha256(
        RUN_RECEIPT_DOMAIN, receipt_body
    )
    receipt_payload = _canonical_bytes(receipt_body)
    receipt_file_sha256 = _sha256(receipt_payload)
    _write_exclusive(run_root / "run-receipt.json", receipt_payload)
    completion = {
        "schema_version": 1,
        "kind": "evleda-cloud-reference-run-complete",
        "run_receipt_sha256": receipt_file_sha256,
        "approval_subject_sha256": approval,
        "manufacturing_release_eligible": False,
    }
    _write_exclusive(run_root / "RUN_COMPLETE.json", _canonical_bytes(completion))
    return {
        "status": "complete",
        "output_directory": str(run_root),
        "run_receipt_sha256": receipt_file_sha256,
        "receipt_subject_sha256": receipt_body["receipt_subject_sha256"],
        "cam_zip_sha256": candidate_output.zip_sha256,
        "manufacturing_release_eligible": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Digest-gated cloud workflow for EvlEDA's fixed reference PCB"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan", help="emit the deterministic preview and stop")
    run = commands.add_parser("run", help="execute only an exact previously approved preview")
    run.add_argument("--approve-digest", required=True)
    run.add_argument("--output-dir", required=True, type=Path)
    run.add_argument("--kicad-cli", required=True, type=Path)
    commands.add_parser("smoke", help="prove deterministic planning without native mutation")
    return parser


def _fail(parser: argparse.ArgumentParser, message: str) -> NoReturn:
    parser.exit(2, f"evleda cloud workflow error: {message}\n")


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "plan":
            plan, _, _ = _plan_document()
            sys.stdout.buffer.write(_canonical_bytes(plan))
            return 0
        if arguments.command == "smoke":
            first, _, _ = _plan_document()
            second, _, _ = _plan_document()
            if _canonical_bytes(first) != _canonical_bytes(second):
                raise WorkflowError("plan output is not deterministic")
            approval = cast(dict[str, object], first["approval"])
            print(f"evleda cloud smoke: passed ({approval['subject_sha256']})")
            return 0
        result = _run(arguments.approve_digest, arguments.output_dir, arguments.kicad_cli)
        sys.stdout.buffer.write(_canonical_bytes(result))
        return 0
    except WorkflowError as exc:
        _fail(parser, str(exc))
    except Exception as exc:
        _fail(parser, f"closed failure: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())

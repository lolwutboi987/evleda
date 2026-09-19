"""Host-private WRITE plane stage with a full hash-bound artifact receipt.

The frozen stage never saves/reverts. This adapter observes it synchronously;
there is no cancellable background native worker or duplicated large MCP payload.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import threading
import uuid
from functools import wraps
from typing import Any, Literal

from jsonschema import Draft202012Validator
from kicad_mcp.config import get_config
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.utilities.func_metadata import ArgModelBase, FuncMetadata
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, StrictStr, model_validator

from .native_ports import canonical_directory, identity, read_source
from .plane_stage import bind_plane_stage
from .typed_zone import TypedNativePlanePorts

PACKAGE_ROOT = Path(__file__).resolve().parent
PROTOCOL = json.loads((PACKAGE_ROOT / "protocol.json").read_text(encoding="utf-8"))
TOOL_NAME = PROTOCOL["toolName"]
INPUT_SCHEMA = PROTOCOL["inputSchema"]
OUTPUT_SCHEMA = PROTOCOL["outputSchema"]
ANNOTATIONS = PROTOCOL["annotations"]
MAX_ARTIFACT_BYTES = PROTOCOL["maxArtifactBytes"]
ARTIFACT_SCHEMA = "evleda.native-plane-stage-artifact.v1"
_input_validator = Draft202012Validator(INPUT_SCHEMA)
_output_validator = Draft202012Validator(OUTPUT_SCHEMA)
_operation_lock = threading.Lock()


def _validate_input(value: Any) -> dict[str, Any]:
    if type(value) is not dict:
        raise ValueError("Plane stage input must be an exact object")
    _input_validator.validate(value)
    # Snapshot caller-owned collections before any native request.
    captured = json.loads(json.dumps(value, allow_nan=False))
    if len(set(captured["zone_ids"])) != len(captured["zone_ids"]):
        raise ValueError("Duplicate zone inventory")
    ids = [pad["primitiveId"] for pad in captured["reference_pads"]]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate physical reference pad")
    return captured


class _Arguments(ArgModelBase):
    model_config = ConfigDict(extra="forbid", strict=True)
    board_file: StrictStr
    zone_ids: list[StrictStr]
    reference_pads: list[dict[str, Any]]
    request: dict[str, Any]

    @model_validator(mode="before")
    @classmethod
    def exact(cls, value: Any) -> dict[str, Any]:
        return _validate_input(value)


class _Identity(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    algorithm: Literal["sha256"]
    digest: str
    size: int


class _Artifact(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: Literal["evleda.native-plane-stage-artifact.v1"]
    filename: str
    identity: _Identity


class _ExactMetadata(FuncMetadata):
    def pre_parse_json(self, data: dict[str, Any]) -> dict[str, Any]:
        return dict(data)


def _absolute(value: Any, label: str) -> str:
    path = os.fspath(value) if isinstance(value, os.PathLike) else value
    if type(path) is not str or not path or not os.path.isabs(path) or "\0" in path:
        raise ValueError(f"Missing exact configured {label}")
    absolute = os.path.abspath(path)
    if os.path.normcase(os.path.normpath(path)) != os.path.normcase(absolute):
        raise ValueError(f"Noncanonical configured {label}")
    return absolute


def _ordinary_file(path: str) -> tuple[int, int, int]:
    info = os.lstat(path)
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1
            or getattr(info, "st_file_attributes", 0) & 0x400
            or os.path.normcase(os.path.realpath(path, strict=True)) != os.path.normcase(path)):
        raise ValueError("Configured project/board is not an ordinary single-link file")
    return info.st_dev, info.st_ino, info.st_mode


def _binding(board_file: str) -> dict[str, Any]:
    cfg = get_config()
    if cfg.operating_mode != "write":
        raise ValueError("Plane staging requires write mode")
    workspace = _absolute(cfg.workspace_root, "workspace root")
    project = _absolute(cfg.project_dir, "project root")
    project_file = _absolute(cfg.project_file, "project file")
    board = _absolute(cfg.pcb_file, "PCB file")
    output = _absolute(cfg.output_dir, "output root")
    requested = _absolute(board_file, "requested PCB")
    same = lambda a, b: os.path.normcase(a) == os.path.normcase(b)
    if (not same(requested, board) or not same(os.path.dirname(board), project)
            or not same(os.path.dirname(project_file), project)
            or not board.casefold().endswith(".kicad_pcb") or not project_file.casefold().endswith(".kicad_pro")
            or not same(os.path.commonpath([workspace, project]), workspace) or same(workspace, project)
            or not same(os.path.commonpath([workspace, output]), workspace) or same(workspace, output)):
        raise ValueError("Plane stage paths differ from the exact configured project/workspace")
    roots = {name: canonical_directory(path) for name, path in (("workspace", workspace), ("project", project), ("output", output))}
    return {"workspace": workspace, "project": project, "projectFile": project_file,
            "board": board, "output": output, "rootWitnesses": roots,
            "boardWitness": _ordinary_file(board), "projectWitness": _ordinary_file(project_file)}


def _pad_bindings():
    # Launcher loads this exact manifested sibling first. Do not discover an
    # import path from input, ambient sys.path, .env or configured project data.
    module = sys.modules.get("evleda_live_pcb_pad_snapshot")
    expected = PACKAGE_ROOT.parent / "evleda_live_pcb_pad_snapshot.py"
    if module is None or Path(getattr(module, "__file__", "")).resolve() != expected:
        raise RuntimeError("Existing pinned PAD collector was not loaded from this runtime")
    return module._owned_client, module.read_live_pcb_pad_snapshot


def _artifact_witness(info: os.stat_result) -> tuple:
    return info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns


def _publish(fd: int, filename: str, binding: dict[str, Any], arguments: dict[str, Any], receipt: Any) -> dict[str, Any]:
    if type(receipt) is not dict or receipt.get("schemaVersion") != "evleda.native-plane-stage.v2":
        raise ValueError("Fixed stage did not return a complete receipt object")
    if receipt.get("request") != arguments["request"] or type(receipt.get("complete")) is not bool or receipt.get("nativeSaveCalled") is not False:
        raise ValueError("Fixed stage receipt contradicts the exact request/no-save boundary")
    dispatched, recovery = receipt.get("mutationDispatched"), receipt.get("recoveryRequired")
    if type(dispatched) is not bool or type(recovery) is not bool or receipt["complete"] and (not dispatched or recovery) or not receipt["complete"] and dispatched and not recovery:
        raise ValueError("Fixed stage receipt has inconsistent completion/recovery flags")
    data = json.dumps(receipt, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if not 0 < len(data) <= MAX_ARTIFACT_BYTES:
        raise ValueError("Full stage receipt exceeds the artifact bound; never truncate")
    if _binding(arguments["board_file"]) != binding:
        raise ValueError("Configured roots/files changed before artifact publication")
    target = os.path.join(binding["output"], filename)
    opened = os.fstat(fd)
    if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or opened.st_size != 0
            or _artifact_witness(opened) != _artifact_witness(os.lstat(target))):
        raise ValueError("Reserved artifact no longer has its exclusive ordinary identity")
    written = 0
    while written < len(data):
        count = os.write(fd, data[written:])
        if count <= 0:
            raise OSError("Incomplete stage receipt write")
        written += count
    os.fsync(fd)
    saved = os.fstat(fd)
    if saved.st_size != len(data) or saved.st_nlink != 1 or saved.st_dev != opened.st_dev or saved.st_ino != opened.st_ino:
        raise ValueError("Artifact physical identity changed during write")
    if _artifact_witness(os.lstat(target)) != _artifact_witness(saved) or _binding(arguments["board_file"]) != binding:
        raise ValueError("Artifact/path binding changed during publication")
    with open(target, "rb") as handle:
        before = os.fstat(handle.fileno())
        if _artifact_witness(before) != _artifact_witness(saved):
            raise ValueError("Artifact changed before exact readback")
        observed = handle.read(MAX_ARTIFACT_BYTES + 1)
        if observed != data or _artifact_witness(os.fstat(handle.fileno())) != _artifact_witness(before):
            raise ValueError("Full artifact readback differs")
    if _artifact_witness(os.lstat(target)) != _artifact_witness(saved):
        raise ValueError("Artifact path changed after exact readback")
    result = {"schemaVersion": ARTIFACT_SCHEMA, "filename": filename, "identity": identity(data)}
    _output_validator.validate(result)
    return result


def stage_plane(arguments: Any) -> CallToolResult:
    arguments = _validate_input(arguments)
    if not _operation_lock.acquire(blocking=False):
        raise ToolError("PLANE_STAGE_BUSY: another observed plane operation is in progress")
    fd = None
    stage_entered = False
    filename = None
    try:
        binding = _binding(arguments["board_file"])
        # Verify readability before any native work; source identity itself is
        # checked again by the fixed stage against the host's exact observation.
        read_source(binding["board"])
        filename = f"evleda-plane-stage-{uuid.uuid4()}.json"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(os.path.join(binding["output"], filename), flags, 0o600)
        if _binding(arguments["board_file"]) != binding:
            raise ValueError("Configured binding changed while reserving artifact")
        client_getter, pad_capture = _pad_bindings()
        ports = TypedNativePlanePorts(client_getter, pad_capture)
        stage = bind_plane_stage({"outputRoot": binding["workspace"], "projectRoot": binding["project"],
            "boardPath": binding["board"], "zoneIds": arguments["zone_ids"], "referencePads": arguments["reference_pads"]}, ports)
        stage_entered = True
        # Synchronous and fully observed: no wait_for/to_thread cancellation.
        receipt = stage(arguments["request"])
        reference = _publish(fd, filename, binding, arguments, receipt)
        os.close(fd); fd = None
        text = json.dumps(reference, ensure_ascii=False, separators=(",", ":"))
        return CallToolResult(content=[TextContent(type="text", text=text)], structuredContent=reference, isError=False)
    except Exception as error:
        phase = "UNCERTAIN_RECOVERY_REQUIRED" if stage_entered else "REJECTED_BEFORE_STAGE"
        # Once the stage was entered, even artifact failure must never claim
        # no mutation. Keep any exclusive partial artifact as diagnostic evidence.
        raise ToolError(f"PLANE_STAGE_{phase}: {str(error)[:1000]}; reservedArtifact={filename or 'none'}") from error
    finally:
        try:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    # The explicit publication close above is classified. A
                    # secondary close failure must not replace that primary
                    # uncertain-stage error with an unclassified exception.
                    pass
        finally:
            _operation_lock.release()


def register(server: Any) -> None:
    if get_config().operating_mode != "write":
        return
    from kicad_mcp.capabilities import AccessTier, CapabilityRecord, RuntimeRequirement, ToolMaturity
    from kicad_mcp.capabilities import get as get_capability, register as register_capability
    record = CapabilityRecord(name=TOOL_NAME, profiles=frozenset({"full"}), tier=AccessTier.WRITE,
        category="pcb", runtime=RuntimeRequirement.KICAD_IPC, writes_files=True,
        writes_kicad_gui_state=True, supports_dry_run=False, supports_rollback=False,
        description="Host-private bounded unsaved native plane stage; returns only a full-receipt artifact reference, never saves or reverts.",
        verification_level="fixed-stage-source-and-offline-artifact-adapter-regressions",
        maturity=ToolMaturity.EXPERIMENTAL, tested_kicad_versions=())
    existing = get_capability(TOOL_NAME)
    if existing is not None and existing != record:
        raise RuntimeError("Private plane stage capability differs from its fixed definition")
    register_capability(record)
    def evleda_stage_plane(board_file: str, zone_ids: list[str], reference_pads: list[dict[str, Any]], request: dict[str, Any]) -> CallToolResult:
        return stage_plane({"board_file": board_file, "zone_ids": zone_ids, "reference_pads": reference_pads, "request": request})
    server.add_tool(evleda_stage_plane, name=TOOL_NAME, description=record.description,
        annotations=ToolAnnotations(**ANNOTATIONS), structured_output=False)
    tool = server._tool_manager.get_tool(TOOL_NAME)
    if tool is None or tool.fn is not evleda_stage_plane:
        raise RuntimeError("Private plane stage did not register exactly")
    tool.parameters = copy.deepcopy(INPUT_SCHEMA)
    tool.fn_metadata = _ExactMetadata(arg_model=_Arguments, output_model=_Artifact,
        output_schema=copy.deepcopy(OUTPUT_SCHEMA), wrap_output=False)
    if getattr(server, "allowed_tool_names", None) is not None:
        server.allowed_tool_names.add(TOOL_NAME)


def install(server_module: Any) -> None:
    original = server_module.build_server
    if getattr(original, "_evleda_plane_stage_installed", False):
        raise RuntimeError("Private plane stage addon already installed")
    @wraps(original)
    def build_server(*args: Any, **kwargs: Any) -> Any:
        server = original(*args, **kwargs); register(server); return server
    build_server._evleda_plane_stage_installed = True
    server_module.build_server = build_server

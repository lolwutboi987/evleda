"""Private DOC2 complete-plan append. Disk receipt only; no native/GUI claim."""

from __future__ import annotations

import hashlib
import json
import math
import os
from functools import wraps
from pathlib import Path
import stat
from typing import Annotated, Any, Literal

from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.utilities.func_metadata import ArgModelBase, FuncMetadata
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from kicad_mcp.config import get_config
from kicad_mcp.tools import schematic as doc2
from kicad_mcp.utils.field_layout import child_spans, children, tag, child, at, quoted_head

TOOL_NAME = "sch_apply_connectivity_batch_v1"
SCHEMA_VERSION = "evleda.kicad-schematic-connectivity-batch.v1"
NORMALIZATION_VERSION = "doc2-complete-plan-v1"
MAX_PRIMITIVES = 4096
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024 - 4096
ANNOTATIONS = {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": False}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


Coord = Annotated[float, Field(ge=-2000, le=2000)]
Justify = Literal["left", "right", "top", "bottom", "left top", "left bottom", "right top", "right bottom", "none"]


class Point(_Strict):
    x_mm: Coord
    y_mm: Coord

    @field_validator("x_mm", "y_mm", mode="before")
    @classmethod
    def coordinate(cls, value: Any) -> float:
        return _coordinate(value)


class Wire(_Strict):
    x1_mm: Coord
    y1_mm: Coord
    x2_mm: Coord
    y2_mm: Coord

    @field_validator("x1_mm", "y1_mm", "x2_mm", "y2_mm", mode="before")
    @classmethod
    def coordinate(cls, value: Any) -> float:
        return _coordinate(value)


class GlobalLabel(Point):
    name: Annotated[str, Field(min_length=1, max_length=240)]
    rotation: Literal[0, 90, 180, 270]
    shape: Literal["passive"]
    justify: Justify

    @field_validator("name")
    @classmethod
    def exact_name(cls, value: str) -> str:
        if value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("Label names must be nonempty exact text without control characters or outer whitespace")
        return value

    @field_validator("rotation", mode="before")
    @classmethod
    def exact_rotation(cls, value: Any) -> int:
        if type(value) is not int:
            raise ValueError("Rotation must be an integer cardinal angle")
        return value


class Arguments(ArgModelBase):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    normalization_version: Literal["doc2-complete-plan-v1"]
    project_file: Annotated[str, Field(min_length=1, max_length=32768)]
    schematic_file: Annotated[str, Field(min_length=1, max_length=32768)]
    expected_before_sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    expected_before_size_bytes: Annotated[int, Field(ge=1, le=MAX_SOURCE_BYTES)]
    wires: Annotated[list[Wire], Field(max_length=MAX_PRIMITIVES)]
    global_labels: Annotated[list[GlobalLabel], Field(max_length=MAX_PRIMITIVES)]
    no_connects: Annotated[list[Point], Field(max_length=MAX_PRIMITIVES)]
    junctions: Annotated[list[Point], Field(max_length=MAX_PRIMITIVES)]

    @model_validator(mode="after")
    def bounded_plan(self) -> Arguments:
        total = sum(len(getattr(self, key)) for key in _KINDS)
        if not 1 <= total <= MAX_PRIMITIVES:
            raise ValueError("A complete plan must contain 1..4096 submitted primitives")
        return self


class Identity(_Strict):
    algorithm: Literal["sha256"]
    digest: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
    size: Annotated[int, Field(ge=1, le=MAX_SOURCE_BYTES)]


class Counts(_Strict):
    wires: Annotated[int, Field(ge=0, le=MAX_PRIMITIVES)]
    global_labels: Annotated[int, Field(ge=0, le=MAX_PRIMITIVES)]
    no_connects: Annotated[int, Field(ge=0, le=MAX_PRIMITIVES)]
    junctions: Annotated[int, Field(ge=0, le=MAX_PRIMITIVES)]


class WrittenWire(Wire):
    uuid: Annotated[str, Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")]


class WrittenPoint(Point):
    uuid: Annotated[str, Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")]


class WrittenLabel(GlobalLabel):
    uuid: Annotated[str, Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")]


class Inventory(_Strict):
    wires: list[WrittenWire]
    global_labels: list[WrittenLabel]
    no_connects: list[WrittenPoint]
    junctions: list[WrittenPoint]


class Operation(_Strict):
    kind: Literal["wires", "global_labels", "no_connects", "junctions"]
    index: Annotated[int, Field(ge=0, lt=MAX_PRIMITIVES)]
    status: Literal["applied"]
    resultingPrimitiveIndices: Annotated[list[int], Field(min_length=1, max_length=MAX_PRIMITIVES)]


class Reload(_Strict):
    status: Literal["not_requested"]
    confirmed: Literal[False]


class Receipt(_Strict):
    schemaVersion: Literal["evleda.kicad-schematic-connectivity-batch.v1"]
    normalizationVersion: Literal["doc2-complete-plan-v1"]
    applied: Literal[True]
    projectFile: str
    schematicFile: str
    before: Identity
    after: Identity
    submittedCounts: Counts
    appliedCounts: Counts
    inventory: Inventory
    operationReceipt: list[Operation]
    reload: Reload


class _ExactMetadata(FuncMetadata):
    def pre_parse_json(self, data: dict[str, Any]) -> dict[str, Any]:
        return dict(data)


_KINDS = ("wires", "global_labels", "no_connects", "junctions")
_PRIMITIVE_TAGS = {"wire", "global_label", "label", "hierarchical_label", "no_connect", "junction", "bus", "bus_entry", "sheet", "netclass_flag"}
INPUT_SCHEMA = Arguments.model_json_schema()
OUTPUT_SCHEMA = Receipt.model_json_schema()


def _coordinate(value: Any) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or round(value, 4) != value:
        raise ValueError("Coordinates must be exact finite numbers representable at 0.0001 mm; no rounding or snapping")
    return float(value)


def _identity(data: bytes) -> dict[str, Any]:
    return {"algorithm": "sha256", "digest": hashlib.sha256(data).hexdigest(), "size": len(data)}


def _point(item: Point) -> tuple[float, float]:
    return item.x_mm, item.y_mm


def _segment(item: Wire) -> tuple[float, float, float, float]:
    return item.x1_mm, item.y1_mm, item.x2_mm, item.y2_mm


def _on(point: tuple[float, float], wire: tuple[float, float, float, float]) -> bool:
    x, y = point
    x1, y1, x2, y2 = wire
    return ((x1 == x2 == x and min(y1, y2) <= y <= max(y1, y2))
            or (y1 == y2 == y and min(x1, x2) <= x <= max(x1, x2)))


def _canonical_plan(request: Arguments) -> list[tuple[float, float, float, float]]:
    raw = [_segment(item) for item in request.wires]
    signatures: set[tuple[tuple[float, float], tuple[float, float]]] = set()
    for wire in raw:
        x1, y1, x2, y2 = wire
        if (x1 == x2 and y1 == y2) or (x1 != x2 and y1 != y2):
            raise ValueError("Every wire must be a nonzero orthogonal segment")
        signature = doc2._wire_signature(*wire)
        if signature in signatures:
            raise ValueError("Duplicate or reversed-duplicate wire")
        signatures.add(signature)
    normalized = sorted(doc2._deduplicate_segments(raw))
    supplied_junctions = [_point(item) for item in request.junctions]
    if len(set(supplied_junctions)) != len(supplied_junctions):
        raise ValueError("Duplicate junction")
    required = set(doc2._detect_t_intersections(normalized))
    if not required <= set(supplied_junctions):
        raise ValueError("The complete plan omitted a required T junction")
    for point in supplied_junctions:
        touching = [wire for wire in normalized if _on(point, wire)]
        if not any(wire[0] == wire[2] for wire in touching) or not any(wire[1] == wire[3] for wire in touching):
            raise ValueError("Explicit junction must lie at a perpendicular wire intersection")
    label_points = [_point(item) for item in request.global_labels]
    if len(set(label_points)) != len(label_points):
        raise ValueError("Multiple labels at one anchor are unsupported")
    if any(not any(_on(point, wire) for wire in normalized) for point in label_points):
        raise ValueError("Every global label must anchor exactly to a resulting wire")
    no_connects = [_point(item) for item in request.no_connects]
    if len(set(no_connects)) != len(no_connects):
        raise ValueError("Duplicate no-connect")
    for point in no_connects:
        if point in label_points or point in supplied_junctions or any(_on(point, wire) for wire in normalized):
            raise ValueError("A no-connect marker overlaps connected geometry")
    # Coordinate-only preflight, not a native pin/netlist oracle: reject two
    # different explicit global names joined by the submitted wire geometry.
    parents = list(range(len(normalized)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for index, wire in enumerate(normalized):
        for other_index in range(index):
            other = normalized[other_index]
            touching = (any(_on(point, other) for point in [(wire[0], wire[1]), (wire[2], wire[3])])
                        or any(_on(point, wire) for point in [(other[0], other[1]), (other[2], other[3])]))
            if touching:
                parents[find(index)] = find(other_index)
    for point in supplied_junctions:
        incident = [index for index, wire in enumerate(normalized) if _on(point, wire)]
        for index in incident[1:]:
            parents[find(index)] = find(incident[0])
    names: dict[int, str] = {}
    for label in request.global_labels:
        matching = [index for index, wire in enumerate(normalized) if _on(_point(label), wire)]
        for index in matching:
            root = find(index)
            if root in names and names[root] != label.name:
                raise ValueError("Submitted geometry joins different global net names")
            names[root] = label.name
    return normalized


def _exact_path(value: str, suffix: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.suffix != suffix or any(char in value for char in "\0\r\n"):
        raise ValueError("Exact absolute project and schematic filenames are required")
    canonical = candidate.resolve(strict=True)
    if os.path.normcase(str(candidate)) != os.path.normcase(str(canonical)):
        raise ValueError("Project/schematic path aliases are unsupported")
    for current in [canonical, *canonical.parents]:
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
            raise ValueError("Project/schematic path contains a link or reparse point")
    metadata = canonical.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Project/schematic must be ordinary files with one filesystem link")
    return canonical


def _bound_paths(request: Arguments) -> tuple[Path, Path]:
    config = get_config()
    if config.operating_mode != "write":
        raise ValueError("Private schematic batch requires write operating mode")
    project = _exact_path(request.project_file, ".kicad_pro")
    sheet = _exact_path(request.schematic_file, ".kicad_sch")
    if project.parent != sheet.parent or project.stem != sheet.stem:
        raise ValueError("Only the exact root sheet beside its same-stem project is supported")
    if config.project_file is None or config.sch_file is None or config.project_dir is None:
        raise ValueError("No exact active project/schematic binding")
    if (project != Path(config.project_file).resolve(strict=True)
            or sheet != Path(config.sch_file).resolve(strict=True)
            or project.parent != Path(config.project_dir).resolve(strict=True)):
        raise ValueError("Request does not match the exact active project/schematic")
    return project, sheet


def _source_parts(source: str) -> list[str]:
    if tag(source.lstrip()) != "kicad_sch":
        raise ValueError("Source is not one KiCad schematic")
    return children(source)


def _uuid(block: str) -> str:
    node = child(block, "uuid")
    if node is None:
        raise ValueError("Generated primitive has no exact UUID")
    return quoted_head(node, "uuid")[0]


def _inventory(source: str) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {key: [] for key in _KINDS}
    for block in _source_parts(source):
        kind = tag(block)
        if kind == "wire":
            records = doc2._extract_wires(block)
            if len(records) != 1:
                raise ValueError("Generated wire did not parse exactly")
            value = records[0]
            result["wires"].append({"x1_mm": value["x1"], "y1_mm": value["y1"], "x2_mm": value["x2"], "y2_mm": value["y2"], "uuid": _uuid(block)})
        elif kind in {"global_label", "no_connect", "junction"}:
            x, y, rotation = at(block)
            value = {"x_mm": x, "y_mm": y, "uuid": _uuid(block)}
            if kind == "global_label":
                shape_node = child(block, "shape")
                effects = child(block, "effects")
                justify_node = child(effects, "justify") if effects else None
                if shape_node != "(shape passive)":
                    raise ValueError("Generated label lost its passive shape")
                value.update(name=quoted_head(block, "global_label")[0], rotation=int(rotation), shape="passive",
                             justify=justify_node[len("(justify "):-1] if justify_node else "none")
                result["global_labels"].append(value)
            else:
                result["no_connects" if kind == "no_connect" else "junctions"].append(value)
    for key in _KINDS:
        result[key].sort(key=lambda item: json.dumps({name: value for name, value in item.items() if name != "uuid"}, sort_keys=True, ensure_ascii=False))
    return result


def _expected_inventory(request: Arguments, normalized: list[tuple[float, float, float, float]]) -> dict[str, list[dict[str, Any]]]:
    result = {"wires": [dict(zip(("x1_mm", "y1_mm", "x2_mm", "y2_mm"), wire, strict=True)) for wire in normalized],
              "global_labels": [item.model_dump() for item in request.global_labels],
              "no_connects": [item.model_dump() for item in request.no_connects],
              "junctions": [item.model_dump() for item in request.junctions]}
    for values in result.values():
        values.sort(key=lambda item: json.dumps(item, sort_keys=True, ensure_ascii=False))
    return result


def _without_uuids(inventory: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    return {key: [{name: value for name, value in item.items() if name != "uuid"} for item in values] for key, values in inventory.items()}


def _output_bytes(source: str) -> bytes:
    # The pinned atomic writer uses a text-mode UTF-8 temporary with newline=None.
    return source.replace("\n", os.linesep).encode("utf-8")


def _prepare(source: str, request: Arguments, normalized: list[tuple[float, float, float, float]]) -> tuple[str, str, dict[str, list[dict[str, Any]]]]:
    original_parts = _source_parts(source)
    if any(tag(block) in _PRIMITIVE_TAGS for block in original_parts):
        raise ValueError("Complete connectivity append requires a pristine single-sheet connectivity baseline")
    if len([block for block in original_parts if tag(block) == "uuid"]) != 1:
        raise ValueError("Source has no unique root identity")
    if len([block for block in original_parts if tag(block) == "lib_symbols"]) != 1:
        raise ValueError("Source has no unique embedded-library block")
    blocks = [doc2.wire_block(*wire) for wire in normalized]
    blocks += [doc2.label_block(item.name, item.x_mm, item.y_mm, item.rotation, kind="global_label", shape=item.shape, justify=item.justify) for item in request.global_labels]
    blocks += [doc2.no_connect_block(item.x_mm, item.y_mm) for item in request.no_connects]
    blocks += [doc2._junction_block(item.x_mm, item.y_mm) for item in request.junctions]
    spans = child_spans(source)
    sheet_instances = [start for start, end in spans if tag(source[start:end]) == "sheet_instances"]
    if len(sheet_instances) != 1:
        raise ValueError("Source has no unique sheet_instances insertion boundary")
    insertion = sheet_instances[0]
    candidate = source[:insertion] + "\n".join(blocks) + "\n" + source[insertion:]
    # Exercise the *same* complete-plan normalizer before entering its writer.
    # Its legacy text helpers are not quote-safe for every possible string; any
    # such unsupported source is rejected here, before a disk effect.
    prepared = doc2._normalize_schematic_wire_connectivity(candidate)
    doc2._validate_schematic_text(prepared)
    prepared_parts = _source_parts(prepared)
    if any(tag(block) in _PRIMITIVE_TAGS - {"wire", "global_label", "no_connect", "junction"} for block in prepared_parts):
        raise ValueError("DOC2 writer produced an unsupported connectivity primitive")
    protected = [block for block in prepared_parts if tag(block) not in _PRIMITIVE_TAGS]
    if protected != original_parts:
        raise ValueError("DOC2 normalization changed unrelated source; this source is unsupported")
    inventory = _inventory(prepared)
    if _without_uuids(inventory) != _expected_inventory(request, normalized):
        raise ValueError("DOC2 normalization changed the exact complete primitive plan")
    # Return the unnormalized candidate to the existing writer, which performs
    # this exact one normalization. Its whitespace is not prefix-idempotent.
    return candidate, prepared, inventory


def _operations(request: Arguments, inventory: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    result = []
    resulting_wires = [tuple(item[key] for key in ("x1_mm", "y1_mm", "x2_mm", "y2_mm")) for item in inventory["wires"]]
    for kind in _KINDS:
        for index, item in enumerate(getattr(request, kind)):
            if kind == "wires":
                wire = _segment(item)
                matches = [i for i, output in enumerate(resulting_wires) if _on((wire[0], wire[1]), output) and _on((wire[2], wire[3]), output)]
            else:
                matches = [i for i, output in enumerate(inventory[kind]) if {k: v for k, v in output.items() if k != "uuid"} == item.model_dump()]
            if len(matches) != 1:
                raise ValueError("A submitted primitive has no unique resulting operation receipt")
            result.append({"kind": kind, "index": index, "status": "applied", "resultingPrimitiveIndices": matches})
    return result


def apply_connectivity_batch(arguments: Any) -> CallToolResult:
    """Validate everything, perform one DOC2 atomic write, return exact disk proof.

    Validation failures throw ToolError with no write. Any writer/readback failure
    is terminal/uncertain: the host must restore its captured preimage and close.
    No worker, timer, or best-effort GUI mutation is launched by this producer.
    """
    write_entered = False
    try:
        request = Arguments.model_validate(arguments)
        normalized = _canonical_plan(request)
        with doc2._SCHEMATIC_WRITE_LOCK:
            project, sheet = _bound_paths(request)
            before_bytes = sheet.read_bytes()
            if len(before_bytes) > MAX_SOURCE_BYTES or _identity(before_bytes) != {
                "algorithm": "sha256", "digest": request.expected_before_sha256, "size": request.expected_before_size_bytes,
            }:
                raise ValueError("Expected before-source identity does not match")
            source = before_bytes.decode("utf-8", errors="strict").replace("\r\n", "\n")
            if _output_bytes(source) != before_bytes:
                raise ValueError("Source newline encoding is not the pinned DOC2 writer encoding")
            candidate, prepared, inventory = _prepare(source, request, normalized)
            after_bytes = _output_bytes(prepared)
            if len(after_bytes) > MAX_SOURCE_BYTES:
                raise ValueError("Resulting schematic exceeds the source byte bound")
            payload = {
                "schemaVersion": SCHEMA_VERSION, "normalizationVersion": NORMALIZATION_VERSION, "applied": True,
                "projectFile": str(project), "schematicFile": str(sheet), "before": _identity(before_bytes), "after": _identity(after_bytes),
                "submittedCounts": {key: len(getattr(request, key)) for key in _KINDS},
                "appliedCounts": {key: len(inventory[key]) for key in _KINDS}, "inventory": inventory,
                "operationReceipt": _operations(request, inventory), "reload": {"status": "not_requested", "confirmed": False},
            }
            Receipt.model_validate(payload)
            result = CallToolResult(content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, separators=(",", ":")))], structuredContent=payload, isError=False)
            if len(result.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8")) > MAX_RESULT_BYTES:
                raise ValueError("Complete receipt exceeds the bounded MCP result size")

            def mutate(current: str) -> str:
                if _bound_paths(request) != (project, sheet) or sheet.read_bytes() != before_bytes or current != source:
                    raise ValueError("Source/project binding changed before the atomic write")
                return candidate

            write_entered = True
            doc2.transactional_write(mutate, sheet)
            if _bound_paths(request) != (project, sheet) or sheet.read_bytes() != after_bytes:
                raise RuntimeError("Exact after-source readback differs; host rollback and session close required")
            return result
    except Exception as error:
        phase = "WRITE_UNCERTAIN_TERMINAL" if write_entered else "REJECTED_NO_WRITE"
        raise ToolError(f"CONNECTIVITY_BATCH_{phase}: {str(error)[:1200]}") from error


def register(server: Any) -> None:
    # Addons run after upstream build-time filtering. Do not reintroduce this
    # mutation into a readonly server after that filter has already completed.
    if get_config().operating_mode != "write":
        return
    from kicad_mcp.capabilities import AccessTier, CapabilityRecord, RuntimeRequirement, ToolMaturity
    from kicad_mcp.capabilities import get as get_capability, register as register_capability
    record = CapabilityRecord(name=TOOL_NAME, profiles=frozenset({"full"}), tier=AccessTier.WRITE,
                              category="schematic", runtime=RuntimeRequirement.NONE, writes_files=True,
                              writes_kicad_gui_state=False, supports_dry_run=False, supports_rollback=False,
                              description="Host-private exact complete connectivity append to a source-bound pristine root schematic; disk receipt only.",
                              verification_level="staged-offline-doc2-writer-regressions", maturity=ToolMaturity.EXPERIMENTAL, tested_kicad_versions=())
    existing = get_capability(TOOL_NAME)
    if existing is not None and existing != record:
        raise RuntimeError("Private schematic batch capability has a different definition")
    register_capability(record)

    def sch_apply_connectivity_batch_v1(normalization_version: str, project_file: str, schematic_file: str,
                                      expected_before_sha256: str, expected_before_size_bytes: int,
                                      wires: list[Wire], global_labels: list[GlobalLabel], no_connects: list[Point], junctions: list[Point]) -> CallToolResult:
        return apply_connectivity_batch(locals())

    server.add_tool(sch_apply_connectivity_batch_v1, name=TOOL_NAME, description=record.description,
                    annotations=ToolAnnotations(**ANNOTATIONS), structured_output=False)
    tool = server._tool_manager.get_tool(TOOL_NAME)
    if tool is None or tool.fn is not sch_apply_connectivity_batch_v1:
        raise RuntimeError("Private schematic batch did not register exactly")
    tool.parameters = INPUT_SCHEMA
    tool.fn_metadata = _ExactMetadata(arg_model=Arguments, output_model=Receipt, output_schema=OUTPUT_SCHEMA, wrap_output=False)
    if getattr(server, "allowed_tool_names", None) is not None:
        server.allowed_tool_names.add(TOOL_NAME)


def install(server_module: Any) -> None:
    original = server_module.build_server
    if getattr(original, "_evleda_connectivity_batch_installed", False):
        raise RuntimeError("Private schematic batch addon already installed")

    @wraps(original)
    def build_server(*args: Any, **kwargs: Any) -> Any:
        server = original(*args, **kwargs)
        register(server)
        return server

    build_server._evleda_connectivity_batch_installed = True
    server_module.build_server = build_server

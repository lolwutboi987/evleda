"""Host-private native physical PAD snapshot. No disk/config board fallback."""
from __future__ import annotations

import asyncio
import json
import ntpath
import re
import threading
import time
from functools import wraps
from typing import Any, Callable, Literal

from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message
from kipy.board import Board
from kipy.proto.board import board_commands_pb2, board_types_pb2
from kipy.proto.common.commands import GetItemsResponse
from kipy.proto.common.types import DocumentSpecifier, DocumentType, KiCadObjectType
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.utilities.func_metadata import ArgModelBase, FuncMetadata
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, StrictStr, field_validator

from evleda_live_pcb_document import _owned_client

TOOL_NAME = "evleda_get_live_pcb_pad_snapshot"
SCHEMA_VERSION = "evleda.kicad-live-pcb-pad-snapshot.v1"
UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
MAX_REQUESTED = 512
MAX_PADS = 4096
MAX_FOOTPRINTS = 1024
TIMEOUT_SECONDS = 10.0
MAX_BOARD_SOURCE_BYTES = 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024 - 4096
ANNOTATIONS = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
INPUT_SCHEMA = {"type": "object", "properties": {"requested_primitive_ids": {
    "type": "array", "items": {"type": "string", "pattern": UUID_PATTERN},
    "minItems": 0, "maxItems": MAX_REQUESTED, "uniqueItems": True}},
    "required": ["requested_primitive_ids"], "additionalProperties": False}

def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}

_RAW = {"type": "object"}
_STRING = {"type": "string"}
_UUID = {"type": "string", "pattern": UUID_PATTERN}
_INDEXES = {"type": "array", "items": {"type": "integer", "minimum": 0}, "maxItems": MAX_PADS}
_RPC = _object({"requestType": _STRING, "request": _RAW, "responseType": _STRING, "response": _RAW})
OUTPUT_SCHEMA = _object({
    "schemaVersion": {"type": "string", "const": SCHEMA_VERSION},
    "documentBefore": _RAW, "documentAfter": _RAW,
    "boardSourceBefore": {"type": "string", "minLength": 1},
    "boardSourceAfter": {"type": "string", "minLength": 1},
    "enabledCopperLayers": {"type": "array", "items": _STRING, "minItems": 1, "maxItems": 32, "uniqueItems": True},
    "enabledLayers": _RPC,
    "padRecords": {"type": "array", "items": _RAW, "maxItems": MAX_PADS},
    "boardPadRecordIndexes": _INDEXES,
    "footprintInventory": _object({"requestType": _STRING, "request": _RAW, "responseType": _STRING,
        "responseMetadata": _RAW, "footprints": {"type": "array", "maxItems": MAX_FOOTPRINTS,
            "items": _object({"footprintId": _UUID, "reference": _STRING, "padRecordIndexes": _INDEXES})}}),
    "padstackPresence": _RPC,
    "connectivity": {"type": "array", "maxItems": MAX_REQUESTED, "items": _object({
        "sourcePrimitiveId": _UUID, "requestType": _STRING, "request": _RAW, "responseType": _STRING,
        "responseMetadata": _RAW, "padRecordIndexes": _INDEXES})},
})
_capture_lock = threading.Lock()

class _PadSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: Literal["evleda.kicad-live-pcb-pad-snapshot.v1"]
    documentBefore: dict[str, Any]
    documentAfter: dict[str, Any]
    boardSourceBefore: str
    boardSourceAfter: str
    enabledCopperLayers: list[str]
    enabledLayers: dict[str, Any]
    padRecords: list[dict[str, Any]]
    boardPadRecordIndexes: list[int]
    footprintInventory: dict[str, Any]
    padstackPresence: dict[str, Any]
    connectivity: list[dict[str, Any]]

class _Arguments(ArgModelBase):
    model_config = ConfigDict(extra="forbid", strict=True)
    requested_primitive_ids: list[StrictStr]

    @field_validator("requested_primitive_ids")
    @classmethod
    def validate_ids(cls, value: list[str]) -> list[str]:
        _validate_selection(value)
        return list(value)

class _ExactMetadata(FuncMetadata):
    def pre_parse_json(self, data: dict[str, Any]) -> dict[str, Any]:
        # This private wire contract accepts an array, never a JSON string that
        # the SDK's compatibility pre-parser would silently convert to an array.
        return dict(data)

def _validate_selection(value: Any) -> list[str]:
    if type(value) is not list or len(value) > MAX_REQUESTED or any(
        type(item) is not str or re.fullmatch(UUID_PATTERN, item) is None for item in value
    ) or len(set(value)) != len(value):
        raise ToolError("Requested primitive IDs must be a bounded unique canonical UUID list.")
    return list(value)

def _deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise ToolError("Live PCB pad snapshot exceeded its deadline.")

def _copy(message: Message) -> Message:
    result = type(message)()
    result.CopyFrom(message)
    return result

def _raw(message: Message, *, explicit_defaults: bool = False) -> dict[str, Any]:
    clean = _copy(message)
    clean.DiscardUnknownFields()
    if clean.SerializeToString(deterministic=True) != message.SerializeToString(deterministic=True):
        raise ToolError("Unknown native protobuf fields cannot be retained by this snapshot schema.")
    return MessageToDict(message, preserving_proto_field_name=True,
                         always_print_fields_with_no_presence=explicit_defaults)

def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

def _document(client: Any, deadline: float) -> DocumentSpecifier:
    _deadline(deadline)
    docs = list(client.get_open_documents(DocumentType.DOCTYPE_PCB))
    _deadline(deadline)
    if len(docs) != 1 or docs[0].type != DocumentType.DOCTYPE_PCB:
        raise ToolError("Expected exactly one live PCB document.")
    document = DocumentSpecifier(); document.CopyFrom(docs[0])
    project_path, name = document.project.path, document.board_filename
    if not project_path or not ntpath.isabs(project_path) or not name or any(c in name for c in ("/", "\\")) or not name.casefold().endswith(".kicad_pcb"):
        raise ToolError("Live PCB document path fields are invalid.")
    for value in (project_path, name):
        if any(c in value for c in ("\0", "\r", "\n")) or len(value.encode("utf-8")) > 32768:
            raise ToolError("Live PCB document path fields are invalid.")
    return document

def _source(board: Board, deadline: float) -> str:
    _deadline(deadline)
    request, response = board.client.capture("kiapi.common.commands.SaveDocumentToString", board.get_as_string)
    if request.document != board.document or response.document != board.document:
        raise ToolError("Native board-source response belongs to a different document.")
    value = response.contents
    _deadline(deadline)
    if type(value) is not str or not value or "\0" in value or len(value.encode("utf-8")) > MAX_BOARD_SOURCE_BYTES:
        raise ToolError("Native PCB source is invalid or exceeds the existing bound.")
    return value

class _Recorder:
    """Per-snapshot transport composition; never replaces the shared client."""
    def __init__(self, client: Any, deadline: float):
        self.client, self.deadline, self.calls = client, deadline, []

    def send(self, command: Message, response_type: Any) -> Message:
        _deadline(self.deadline)
        request = _copy(command)
        response = self.client.send(command, response_type)
        _deadline(self.deadline)
        self.calls.append((request, _copy(response)))
        return response

    def capture(self, expected: str, invoke: Callable[[], Any]) -> tuple[Message, Message]:
        self.calls.clear()
        invoke()
        if len(self.calls) != 1 or self.calls[0][0].DESCRIPTOR.full_name != expected:
            raise ToolError("Native snapshot method emitted an unexpected request sequence.")
        return self.calls.pop()

def _rpc(pair: tuple[Message, Message], *, explicit_defaults: bool = False) -> dict[str, Any]:
    request, response = pair
    return {"requestType": request.DESCRIPTOR.full_name, "request": _raw(request),
            "responseType": response.DESCRIPTOR.full_name,
            "response": _raw(response, explicit_defaults=explicit_defaults)}

def _items_metadata(response: GetItemsResponse, document: DocumentSpecifier) -> dict[str, Any]:
    if response.DESCRIPTOR.full_name != "kiapi.common.commands.GetItemsResponse" or response.status != 1:
        raise ToolError("Native item response did not report complete IRS_OK status.")
    if response.HasField("header"):
        header = response.header
        if header.HasField("document") and header.document != document:
            raise ToolError("Native item response belongs to a different document.")
        if header.container.value or header.field_mask.paths:
            raise ToolError("Native item response carries an unexpected partial/container filter.")
    metadata = _copy(response); metadata.ClearField("items")
    return _raw(metadata)

def _unpack(item: Any, message_type: Any) -> Message:
    message = message_type()
    if not item.Is(message.DESCRIPTOR) or not item.Unpack(message):
        raise ToolError("Native response contains an unexpected item type.")
    _raw(message)
    return message

def read_live_pcb_pad_snapshot(requested_primitive_ids: list[str], client_getter: Callable[[], Any] = _owned_client) -> CallToolResult:
    requested = _validate_selection(requested_primitive_ids)
    if not _capture_lock.acquire(blocking=False):
        raise ToolError("A live PCB pad snapshot is already in progress.")
    try:
        deadline = time.monotonic() + TIMEOUT_SECONDS
        client = client_getter(); _deadline(deadline)
        document = _document(client, deadline)
        observed_board = client.get_board(); _deadline(deadline)
        if observed_board.document != document or _document(client, deadline) != document:
            raise ToolError("Live PCB document changed before pad capture.")
        # New Board wrapper uses the existing owned transport and copied native
        # document, with a local recording proxy. No global client monkeypatch.
        recorder = _Recorder(observed_board.client, deadline)
        board_document = DocumentSpecifier(); board_document.CopyFrom(document)
        board = Board(recorder, board_document)
        source_before = _source(board, deadline)
        enabled_pair = recorder.capture("kiapi.board.commands.GetBoardEnabledLayers", board.get_enabled_layers)
        layers_response = enabled_pair[1]
        enabled = list(layers_response.layers)
        if len(enabled) != len(set(enabled)):
            raise ToolError("Native enabled-layer inventory contains duplicates.")
        copper = [value for value in enabled if board_types_pb2.BoardLayer.Name(value).endswith("_Cu")]
        if not copper or len(copper) > 32 or len(copper) != layers_response.copper_layer_count:
            raise ToolError("Native enabled copper-layer inventory is incomplete.")
        pad_pair = recorder.capture("kiapi.common.commands.GetItems", board.get_pads)
        if list(pad_pair[0].types) != [KiCadObjectType.KOT_PCB_PAD] or pad_pair[0].header.document != document:
            raise ToolError("Native PAD inventory request is not exact and document-bound.")
        _items_metadata(pad_pair[1], document)
        if len(pad_pair[1].items) > MAX_PADS:
            raise ToolError("Native PAD inventory exceeds the bounded snapshot size.")
        pad_records: list[dict[str, Any]] = []
        pad_indexes: dict[str, int] = {}
        native_pads = {}
        def intern(pad: Message) -> int:
            uuid = pad.id.value
            if re.fullmatch(UUID_PATTERN, uuid) is None:
                raise ToolError("Native PAD has invalid physical identity.")
            raw = _raw(pad)
            if uuid in pad_indexes:
                index = pad_indexes[uuid]
                if _canonical(raw) != _canonical(pad_records[index]):
                    raise ToolError("Repeated native PAD identity has changed raw metadata.")
                return index
            if len(pad_records) >= MAX_PADS:
                raise ToolError("Native PAD table exceeds its bounded size.")
            index = len(pad_records); pad_indexes[uuid] = index; pad_records.append(raw)
            return index
        board_indexes = []
        for item in pad_pair[1].items:
            pad = _unpack(item, board_types_pb2.Pad)
            if pad.id.value in native_pads:
                raise ToolError("Native board PAD inventory contains a duplicate identity.")
            native_pads[pad.id.value] = pad
            board_indexes.append(intern(pad))
        if any(uuid not in native_pads for uuid in requested):
            raise ToolError("Requested source is not a native physical PAD in this board.")
        footprint_pair = recorder.capture("kiapi.common.commands.GetItems", board.get_footprints)
        if list(footprint_pair[0].types) != [KiCadObjectType.KOT_PCB_FOOTPRINT] or footprint_pair[0].header.document != document:
            raise ToolError("Native footprint inventory request is not exact and document-bound.")
        footprint_metadata = _items_metadata(footprint_pair[1], document)
        if len(footprint_pair[1].items) > MAX_FOOTPRINTS:
            raise ToolError("Native footprint inventory exceeds its bounded size.")
        footprints = []; owners = set(); fp_ids = set()
        for item in footprint_pair[1].items:
            fp = _unpack(item, board_types_pb2.FootprintInstance)
            if re.fullmatch(UUID_PATTERN, fp.id.value) is None or fp.id.value in fp_ids:
                raise ToolError("Native footprint identity is invalid or duplicated.")
            fp_ids.add(fp.id.value); owned = []
            for child in fp.definition.items:
                if not child.Is(board_types_pb2.Pad.DESCRIPTOR):
                    continue
                pad = _unpack(child, board_types_pb2.Pad)
                if pad.id.value not in native_pads or pad.id.value in owners:
                    raise ToolError("Native PAD ownership is missing, duplicated, or inconsistent.")
                owners.add(pad.id.value); owned.append(intern(pad))
            footprints.append({"footprintId": fp.id.value,
                               "reference": fp.reference_field.text.text.text,
                               "padRecordIndexes": owned})
        if owners != set(native_pads):
            raise ToolError("Native footprint ownership does not cover the complete board PAD inventory.")
        from kipy.board_types import Pad
        wrapped_pads = [Pad(pad) for pad in native_pads.values()]
        presence_pair = recorder.capture("kiapi.board.commands.CheckPadstackPresenceOnLayers",
            lambda: board.check_padstack_presence_on_layers(wrapped_pads, copper))
        seen_presence = set()
        for entry in presence_pair[1].entries:
            key = (entry.item.value, entry.layer)
            if entry.item.value not in native_pads or entry.layer not in copper or key in seen_presence:
                raise ToolError("Native per-pad/layer presence coverage is invalid.")
            seen_presence.add(key)
        if len(seen_presence) != len(native_pads) * len(copper):
            raise ToolError("Native per-pad/layer presence response is incomplete.")
        connectivity = []
        for uuid in requested:
            pair = recorder.capture("kiapi.board.commands.GetConnectedItems",
                lambda uuid=uuid: board.get_connected_items(Pad(native_pads[uuid]), types=[KiCadObjectType.KOT_PCB_PAD]))
            request, response = pair
            if [item.value for item in request.items] != [uuid] or list(request.types) != [KiCadObjectType.KOT_PCB_PAD] or request.header.document != document:
                raise ToolError("Native connectivity query is not the exact single-source PAD request.")
            metadata = _items_metadata(response, document)
            if len(response.items) > MAX_PADS:
                raise ToolError("Native connectivity response exceeds the complete bounded size.")
            indexes = []
            for item in response.items:
                pad = _unpack(item, board_types_pb2.Pad)
                if pad.id.value not in native_pads:
                    raise ToolError("Native connectivity response contains an unbound physical PAD.")
                indexes.append(intern(pad))
            connectivity.append({"sourcePrimitiveId": uuid, "requestType": request.DESCRIPTOR.full_name,
                "request": _raw(request), "responseType": response.DESCRIPTOR.full_name,
                "responseMetadata": metadata, "padRecordIndexes": indexes})
        source_after = _source(board, deadline)
        document_after = _document(client, deadline)
        if source_before != source_after or document_after != document or board.document != document or observed_board.document != document:
            raise ToolError("Native document/source changed during PAD snapshot.")
        payload = {"schemaVersion": SCHEMA_VERSION, "documentBefore": _raw(document), "documentAfter": _raw(document_after),
            "boardSourceBefore": source_before, "boardSourceAfter": source_after,
            "enabledCopperLayers": [board_types_pb2.BoardLayer.Name(value) for value in copper],
            "enabledLayers": _rpc(enabled_pair), "padRecords": pad_records, "boardPadRecordIndexes": board_indexes,
            "footprintInventory": {"requestType": footprint_pair[0].DESCRIPTOR.full_name, "request": _raw(footprint_pair[0]),
                "responseType": footprint_pair[1].DESCRIPTOR.full_name, "responseMetadata": footprint_metadata, "footprints": footprints},
            "padstackPresence": _rpc(presence_pair, explicit_defaults=True), "connectivity": connectivity}
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        result = CallToolResult(content=[TextContent(type="text", text=text)], structuredContent=payload, isError=False)
        if len(result.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8")) > MAX_RESULT_BYTES:
            raise ToolError("Complete native PAD snapshot exceeds the existing message bound; nothing was truncated.")
        _deadline(deadline)
        return result
    except ToolError:
        raise
    except Exception as error:
        raise ToolError("Native PCB PAD snapshot failed without fallback.") from error
    finally:
        _capture_lock.release()

def register(server: Any, client_getter: Callable[[], Any] = _owned_client) -> None:
    from kicad_mcp.capabilities import AccessTier, CapabilityRecord, RuntimeRequirement, ToolMaturity
    from kicad_mcp.capabilities import get as get_capability, register as register_capability
    record = CapabilityRecord(name=TOOL_NAME, profiles=frozenset({"full"}), tier=AccessTier.READ,
        runtime=RuntimeRequirement.KICAD_IPC, description="Read complete source-bound native physical PAD inventory, layer presence, and requested single-source PAD responses without fallback.",
        verification_level="native-protocol-source-and-offline-native-shaped-regressions", maturity=ToolMaturity.BETA, tested_kicad_versions=())
    existing = get_capability(TOOL_NAME)
    if existing is not None and existing != record:
        raise RuntimeError("Private PAD snapshot capability already has a different definition.")
    register_capability(record)
    async def evleda_get_live_pcb_pad_snapshot(requested_primitive_ids: list[str]) -> CallToolResult:
        requested = _validate_selection(requested_primitive_ids)
        try:
            return await asyncio.wait_for(asyncio.to_thread(read_live_pcb_pad_snapshot, requested, client_getter), TIMEOUT_SECONDS)
        except TimeoutError as error:
            raise ToolError("Live PCB pad snapshot exceeded its deadline.") from error
    server.add_tool(evleda_get_live_pcb_pad_snapshot, name=TOOL_NAME, description=record.description,
                    annotations=ToolAnnotations(**ANNOTATIONS), structured_output=False)
    tool = server._tool_manager.get_tool(TOOL_NAME)
    if tool is None or tool.fn is not evleda_get_live_pcb_pad_snapshot:
        raise RuntimeError("Private PAD snapshot did not register exactly.")
    tool.parameters = INPUT_SCHEMA
    tool.fn_metadata = _ExactMetadata(arg_model=_Arguments, output_model=_PadSnapshot,
                                     output_schema=OUTPUT_SCHEMA, wrap_output=False)
    if getattr(server, "allowed_tool_names", None) is not None:
        server.allowed_tool_names.add(TOOL_NAME)

def install(server_module: Any) -> None:
    original = server_module.build_server
    if getattr(original, "_evleda_pad_snapshot_installed", False):
        raise RuntimeError("Private PAD snapshot addon already installed.")
    @wraps(original)
    def build_server(*args: Any, **kwargs: Any) -> Any:
        server = original(*args, **kwargs); register(server); return server
    build_server._evleda_pad_snapshot_installed = True
    server_module.build_server = build_server

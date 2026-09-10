"""Host-private live KiCad document/source proof; no disk or config fallback."""

from __future__ import annotations

import asyncio
import json
import ntpath
import threading
import time
from collections.abc import Callable
from typing import Any, Literal

from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.utilities.func_metadata import ArgModelBase
from kipy.proto.common.types import DocumentSpecifier, DocumentType
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict

TOOL_NAME = "evleda_get_live_pcb_document"
SCHEMA_VERSION = "evleda.kicad-live-pcb-document.v1"
TIMEOUT_SECONDS = 10.0
# Leave room for the JSON-RPC envelope within the existing 2 MiB host bound.
MAX_RESULT_BYTES = 2 * 1024 * 1024 - 4096
MAX_BOARD_SOURCE_BYTES = 1024 * 1024
MAX_PATH_BYTES = 32768
OUTPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["schemaVersion", "documentType", "projectPath", "boardFilename", "boardSource"],
    "properties": {
        "schemaVersion": {"type": "string", "const": SCHEMA_VERSION},
        "documentType": {"type": "string", "const": "pcb"},
        "projectPath": {"type": "string", "minLength": 1},
        "boardFilename": {"type": "string", "minLength": 1},
        "boardSource": {"type": "string", "minLength": 1},
    },
}
_snapshot_lock = threading.Lock()


class _NoArguments(ArgModelBase):
    model_config = ConfigDict(extra="forbid")


class _LivePcbDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: Literal["evleda.kicad-live-pcb-document.v1"]
    documentType: Literal["pcb"]
    projectPath: str
    boardFilename: str
    boardSource: str


def _owned_client() -> Any:
    # Uses the already configured, process-owned KiCadSession client. This
    # getter has no board-file/config-document fallback.
    from kicad_mcp.connection import get_kicad

    return get_kicad()


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise ToolError("Live PCB document verification exceeded its deadline.")


def _document(client: Any, deadline: float) -> DocumentSpecifier:
    _check_deadline(deadline)
    documents = client.get_open_documents(DocumentType.DOCTYPE_PCB)
    _check_deadline(deadline)
    if len(documents) != 1:
        raise ToolError("Expected exactly one live PCB document.")
    document = DocumentSpecifier()
    document.CopyFrom(documents[0])
    if document.type != DocumentType.DOCTYPE_PCB:
        raise ToolError("The live document is not a PCB.")
    return document


def _same_document(client: Any, expected: DocumentSpecifier, deadline: float) -> None:
    if _document(client, deadline) != expected:
        raise ToolError("The live PCB document changed during verification.")


def read_live_pcb_document(client_getter: Callable[[], Any] = _owned_client) -> CallToolResult:
    """Return only raw native fields observed on one unchanged live document."""
    if not _snapshot_lock.acquire(blocking=False):
        raise ToolError("A live PCB document verification is already in progress.")
    try:
        deadline = time.monotonic() + TIMEOUT_SECONDS
        client = client_getter()
        _check_deadline(deadline)
        document = _document(client, deadline)
        board = client.get_board()
        _check_deadline(deadline)
        if board.document != document:
            raise ToolError("The active board differs from the observed live document.")
        _same_document(client, document, deadline)
        board_source = board.get_as_string()
        _check_deadline(deadline)
        if board.document != document:
            raise ToolError("The board document changed during native source capture.")
        _same_document(client, document, deadline)

        project_path = document.project.path
        board_filename = document.board_filename
        if (
            not project_path
            or not ntpath.isabs(project_path)
            or any(character in project_path for character in ("\0", "\r", "\n"))
            or len(project_path.encode("utf-8")) > MAX_PATH_BYTES
            or not board_filename
            or any(character in board_filename for character in ("\0", "\r", "\n", "/", "\\"))
            or not board_filename.casefold().endswith(".kicad_pcb")
            or len(board_filename.encode("utf-8")) > MAX_PATH_BYTES
        ):
            raise ToolError("The live PCB document has invalid native path fields.")
        if not isinstance(board_source, str) or not board_source or "\0" in board_source:
            raise ToolError("The native PCB source is unavailable or invalid.")
        if len(board_source.encode("utf-8")) > MAX_BOARD_SOURCE_BYTES:
            raise ToolError("The native PCB source exceeds the bounded result size.")

        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "documentType": "pcb",
            "projectPath": project_path,
            "boardFilename": board_filename,
            "boardSource": board_source,
        }
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        result = CallToolResult(content=[TextContent(type="text", text=text)], structuredContent=payload, isError=False)
        if len(result.model_dump_json(by_alias=True, exclude_none=True).encode("utf-8")) > MAX_RESULT_BYTES:
            raise ToolError("The live PCB document result exceeds the bounded message size.")
        return result
    except ToolError:
        raise
    except Exception as error:
        # Do not translate IPC failure into configured project data or files.
        raise ToolError("Live PCB document verification failed.") from error
    finally:
        _snapshot_lock.release()


def register(server: Any, client_getter: Callable[[], Any] = _owned_client) -> None:
    """Register one closed read-only capability without changing upstream files."""
    from kicad_mcp.capabilities import AccessTier, CapabilityRecord, RuntimeRequirement, ToolMaturity
    from kicad_mcp.capabilities import get as get_capability
    from kicad_mcp.capabilities import register as register_capability

    record = CapabilityRecord(
        name=TOOL_NAME,
        profiles=frozenset({"full"}),
        tier=AccessTier.READ,
        runtime=RuntimeRequirement.KICAD_IPC,
        description="Read native identity and raw source of the exact live PCB document without fallback.",
        verification_level="native-protocol-source-and-fake-client-regressions",
        maturity=ToolMaturity.BETA,
        tested_kicad_versions=(),
    )
    existing = get_capability(TOOL_NAME)
    if existing is not None and existing != record:
        raise RuntimeError("The host-private live document capability already has a different definition.")
    register_capability(record)

    async def evleda_get_live_pcb_document() -> CallToolResult:
        try:
            return await asyncio.wait_for(asyncio.to_thread(read_live_pcb_document, client_getter), TIMEOUT_SECONDS)
        except TimeoutError as error:
            raise ToolError("Live PCB document verification exceeded its deadline.") from error

    server.add_tool(
        evleda_get_live_pcb_document,
        name=TOOL_NAME,
        description=record.description,
        annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False),
        structured_output=False,
    )
    # The pinned upstream uses the MCP SDK FastMCP, not the separate fastmcp
    # package. Bind its exact input/output metadata without changing any other
    # tool or applying the SDK's generic result-to-text serialization.
    tool = server._tool_manager.get_tool(TOOL_NAME)
    if tool is None or tool.fn is not evleda_get_live_pcb_document:
        raise RuntimeError("The host-private live document tool did not register exactly.")
    tool.parameters = {"type": "object", "properties": {}, "additionalProperties": False}
    tool.fn_metadata.arg_model = _NoArguments
    tool.fn_metadata.output_model = _LivePcbDocument
    tool.fn_metadata.output_schema = OUTPUT_SCHEMA
    tool.fn_metadata.wrap_output = False
    if getattr(server, "allowed_tool_names", None) is not None:
        server.allowed_tool_names.add(TOOL_NAME)


def install(server_module: Any) -> None:
    """Attach the addon to this launcher's server build, before stdio starts."""
    original = server_module.build_server
    if getattr(original, "_evleda_live_document_installed", False):
        raise RuntimeError("The host-private live document addon was already installed.")

    def build_server(*args: Any, **kwargs: Any) -> Any:
        server = original(*args, **kwargs)
        register(server)
        return server

    build_server._evleda_live_document_installed = True
    server_module.build_server = build_server

"""Isolated fixed native adapter; extracted from verified attempt3. No launch or CLI."""
import copy
import hashlib
import json
import os
import re
import stat
import time

SCHEMA = "evleda.native-plane-fill-capture.v1"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_SOURCE = 1024 * 1024  # Matches the existing DOC3 PAD collector.
MAX_PAYLOAD = 8 * 1024 * 1024
MAX_ZONES = 32
MAX_REFERENCES = 128
TOTAL_SECONDS = 60.0

def rpc_timeout_ms(request, remaining):
    if remaining <= 0: raise PlaneCaptureError('Plane RPC aggregate deadline exhausted')
    cap=1000
    if request.DESCRIPTOR.full_name=='kiapi.common.commands.RunAction':
        if request.action not in ('pcbnew.ZoneFiller.zoneUnfillAll','pcbnew.ZoneFiller.zoneFillAll'):
            raise PlaneCaptureError('Only fixed plane actions permitted')
        cap=25000
    # kipy applies one timeout to send and receive; reserve both under deadline.
    return max(1,min(cap,int(remaining*1000/2)))


class PlaneCaptureError(RuntimeError):
    def __init__(self, message, refill_dispatched=False):
        super().__init__(message)
        self.refill_dispatched = refill_dispatched
        self.recovery_required = refill_dispatched


def identity(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return {"algorithm": "sha256", "digest": hashlib.sha256(data).hexdigest(), "size": len(data)}


def canonical_directory(directory):
    absolute = os.path.abspath(directory)
    if os.path.normcase(os.path.realpath(absolute, strict=True)) != os.path.normcase(absolute):
        raise PlaneCaptureError("Plane project contains an alias")
    cursor = absolute
    while True:
        metadata = os.lstat(cursor)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
            raise PlaneCaptureError("Plane project contains a link/reparse point")
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent
    metadata = os.stat(absolute)
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode)


def read_source(filename):
    before = os.lstat(filename)
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_SOURCE:
        raise PlaneCaptureError("Saved plane source is not an ordinary bounded single-link file")
    witness = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    # Python on Windows can expose creation/change time differently through
    # path lstat and descriptor fstat. Keep each channel's full witness stable;
    # compare their common physical/file fields across channels, not ctime.
    common = lambda value: witness(value)[:-1]
    with open(filename, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if common(opened) != common(before):
            raise PlaneCaptureError("Saved plane source changed while opening")
        data = handle.read(MAX_SOURCE + 1)
        if witness(os.fstat(handle.fileno())) != witness(opened):
            raise PlaneCaptureError("Saved plane source changed while reading")
    if len(data) != before.st_size or witness(os.lstat(filename)) != witness(before):
        raise PlaneCaptureError("Saved plane source changed during capture")
    return data.decode("utf-8", errors="strict")


class NativePlanePorts:
    """Fixed adapter for later DOC4 composition; imports no paths from requests.

    Pass DOC3's read_live_pcb_pad_snapshot as pad_capture. That existing helper
    validates complete raw item metadata, ownership, per-pad requests and caps.
    """
    def __init__(self, client_getter, pad_capture):
        self.client = client_getter()
        self.board = self.client.get_board()
        self.pad_capture = pad_capture
        self.calls = []

    def begin(self, deadline):
        from google.protobuf.json_format import MessageToDict
        self.original_send = self.client._client.send
        self.original_timeout = self.client._client._timeout_ms
        self.calls = []
        def send(request, response_type):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or len(self.calls) >= 1024:
                raise PlaneCaptureError("Plane RPC deadline/count bound exceeded", True)
            # Bound each send+receive pair by remaining aggregate time.
            timeout = rpc_timeout_ms(request,remaining)
            transport = self.client._client
            transport._timeout_ms = timeout
            if transport.connected:
                transport._conn.send_timeout = timeout
                transport._conn.recv_timeout = timeout
            item = {"requestType": request.DESCRIPTOR.full_name, "request": MessageToDict(request, preserving_proto_field_name=True)}
            self.calls.append(item)
            try:
                response = self.original_send(request, response_type)
            except Exception as error:
                item["error"] = {"type": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)}
                raise
            item.update(responseType=response.DESCRIPTOR.full_name, response=MessageToDict(response, preserving_proto_field_name=True))
            return response
        self.client._client.send = send

    def end(self):
        if hasattr(self, "original_send"):
            self.client._client.send = self.original_send
            self.client._client._timeout_ms = self.original_timeout
            if self.client._client.connected:
                self.client._client._conn.send_timeout = self.original_timeout
                self.client._client._conn.recv_timeout = self.original_timeout

    def document(self):
        from google.protobuf.json_format import MessageToDict
        from kipy.proto.common.types import DocumentType
        docs = list(self.client.get_open_documents(DocumentType.DOCTYPE_PCB))
        if len(docs) != 1 or self.board.document != docs[0]:
            raise PlaneCaptureError("Expected one unchanged native PCB document")
        return MessageToDict(docs[0], preserving_proto_field_name=True)

    def source(self):
        source = self.board.get_as_string()
        if not source or len(source.encode("utf-8")) > MAX_SOURCE:
            raise PlaneCaptureError("Complete native source exceeds bounded PAD capture support", True)
        return source

    def zones(self):
        from google.protobuf.json_format import MessageToDict
        from kipy.proto.board.board_types_pb2 import BoardLayer
        start = len(self.calls)
        zones = list(self.board.get_zones())
        if len(zones) > MAX_ZONES:
            raise PlaneCaptureError("Too many native zones; no truncated capture", True)
        calls = self.calls[start:]
        if len(calls) != 1:
            raise PlaneCaptureError("Unexpected native zone request sequence", True)
        call = calls[0]
        response = call.get("response", {})
        header = response.get("header", {})
        document = MessageToDict(self.board.document, preserving_proto_field_name=True)
        if call["requestType"] != "kiapi.common.commands.GetItems" or call["request"].get("types") != ["KOT_PCB_ZONE"] or call["request"].get("header", {}).get("document") != document:
            raise PlaneCaptureError("Zone inventory request is not exact and document-bound", True)
        if call.get("responseType") != "kiapi.common.commands.GetItemsResponse" or response.get("status") != "IRS_OK" or len(response.get("items", [])) != len(zones):
            raise PlaneCaptureError("Native zone response is not a complete successful inventory", True)
        if header.get("document", document) != document or header.get("container", {}).get("value") or header.get("field_mask"):
            raise PlaneCaptureError("Native zone inventory is partial or belongs to another document", True)
        result = []
        for zone in zones:
            raw_layers = [entry.layer for entry in zone.proto.filled_polygons]
            if len(raw_layers) != len(set(raw_layers)):
                raise PlaneCaptureError("Native zone repeats a fill layer; no overwritten capture", True)
            polygons = {BoardLayer.Name(layer): [MessageToDict(p.proto, preserving_proto_field_name=True) for p in values]
                        for layer, values in zone.filled_polygons.items()}
            all_polygons = [polygon for values in polygons.values() for polygon in values]
            result.append({"uuid": zone.id.value, "filled": zone.filled,
                "raw": MessageToDict(zone.proto, preserving_proto_field_name=True), "filledPolygons": polygons,
                "fillCounts": {"layerCount": len(polygons), "polygonCount": len(all_polygons),
                    "typedHoleCount": sum(len(p.get("holes", [])) for p in all_polygons),
                    "outlineNodeCount": sum(len(p.get("outline", {}).get("nodes", [])) for p in all_polygons)}})
        return result

    def unfill_immediate(self):
        from kipy.proto.common.commands.editor_commands_pb2 import RunActionStatus
        response = self.client.run_action("pcbnew.ZoneFiller.zoneUnfillAll")
        if response.status != RunActionStatus.RAS_OK:
            raise PlaneCaptureError("Fixed native unfill action was not acknowledged", True)
    def refill_immediate(self):
        from kipy.proto.common.commands.editor_commands_pb2 import RunActionStatus
        response = self.client.run_action("pcbnew.ZoneFiller.zoneFillAll")
        if response.status != RunActionStatus.RAS_OK:
            raise PlaneCaptureError("Fixed native fill action was not acknowledged", True)
    def save(self): self.board.save()
    def receipts(self): return copy.deepcopy(self.calls)
    def pad_snapshot(self, ids):
        result = self.pad_capture(ids, client_getter=lambda: self.client)
        if result.isError or result.structuredContent is None:
            raise PlaneCaptureError("Existing complete native PAD capture failed", True)
        return result.structuredContent
    @staticmethod
    def is_busy(error):
        from kipy.errors import ApiError
        from kipy.proto.common import ApiStatusCode
        return isinstance(error, ApiError) and error.code == ApiStatusCode.AS_BUSY



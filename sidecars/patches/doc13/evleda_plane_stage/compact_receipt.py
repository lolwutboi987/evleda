"""Lossless V2 storage for the complete native plane-stage transcript.

Only repeated PCB text and top-level RPC PAD Any records are interned. Native
calls, order, failures and all other fields are unchanged. This is storage,
not evidence approval, and does not change the 8 MiB artifact bound.
"""
import copy
import json

SCHEMA = "evleda.native-plane-stage.v2"
PAD_TYPE = "type.googleapis.com/kiapi.board.types.Pad"
MAX_BYTES = 8 * 1024 * 1024
MAX_SOURCE = 1024 * 1024


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def compact_plane_stage(receipt):
    if type(receipt) is not dict or receipt.get("schemaVersion") != "evleda.native-plane-stage.v1":
        raise ValueError("Expected native V1 stage for compaction")
    if "sourcePool" in receipt or "rpcPadPool" in receipt:
        raise ValueError("Unexpected pools on V1 stage")
    # Retain the host's logical traversal bound, even though wire nodes shrink.
    nodes = 0
    def bounded(value, depth=0):
        nonlocal nodes
        nodes += 1
        if nodes > 500_000 or depth > 64:
            raise ValueError("Logical stage traversal budget exceeded")
        if type(value) is dict:
            for child in value.values():
                bounded(child, depth + 1)
        elif type(value) is list:
            for child in value:
                bounded(child, depth + 1)
    bounded(receipt)
    result = copy.deepcopy(receipt)
    sources, pads, source_index, pad_index = [], [], {}, {}
    source_count = 0
    def source(owner, key):
        nonlocal source_count
        if key not in owner:
            return
        source_count += 1
        value = owner[key]
        if source_count > 32 or type(value) is not str or not 0 < len(value.encode("utf-8")) <= MAX_SOURCE:
            raise ValueError("Source is not complete bounded text")
        if value not in source_index:
            source_index[value] = len(sources)
            sources.append(value)
        owner[key] = {"sourceIndex": source_index[value]}
    for key in ("savedSourceBefore", "nativeSourceBefore", "nativeSourceUnfilled", "nativeSourceStaged",
                "savedSourceStaged", "currentSavedSource", "currentNativeSource"):
        source(result, key)
    snapshot = result.get("padSnapshot")
    if snapshot is not None:
        source(snapshot, "boardSourceBefore")
        source(snapshot, "boardSourceAfter")
    for call in result["rpc"]:
        response = call.get("response")
        if call.get("requestType") == "kiapi.common.commands.SaveDocumentToString" and response is not None:
            source(response, "contents")
        if call.get("responseType") != "kiapi.common.commands.GetItemsResponse" or response is None:
            continue
        for index, item in enumerate(response.get("items", [])):
            if type(item) is not dict or item.get("@type") != PAD_TYPE:
                continue
            encoded = canonical(item)
            if encoded not in pad_index:
                pad_index[encoded] = len(pads)
                pads.append(item)
            response["items"][index] = {"padIndex": pad_index[encoded]}
    if len(sources) > 16 or len(pads) > 4096:
        raise ValueError("Stage pool exceeds count bound")
    result.update(schemaVersion=SCHEMA, sourcePool=sources, rpcPadPool=pads)
    if len(canonical(result).encode("utf-8")) > MAX_BYTES:
        raise ValueError("Complete compact stage exceeds artifact cap; never truncate")
    return result

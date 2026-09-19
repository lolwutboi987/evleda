# DOC12 complete PAD snapshot envelope

DOC11 could exceed its 2 MiB transport limit after an ordinary routing batch:
the complete native PAD payload was serialized in both text and structured
content. DOC12 sends that payload once, in `structuredContent`, and puts an
exact versioned encoding selector in the text block. No physical records,
source observations, document observations, or connectivity responses are omitted.

The payload schema and tool descriptor are unchanged. The host accepts only
the exact new selector or the original equal text/structured encoding. Every
existing payload, physical-library, saved-source, native identity, completeness,
size, and host-currentness check still applies. The selector grants no authority.
Old hosts reject the new encoding; activation requires a separately qualified
host and runtime. Historical runtimes and the DOC3 baseline remain unchanged.

Install this one replacement file only into a new, separately pinned runtime:
`evleda_live_pcb_pad_snapshot.py`. Its baseline is
`../doc3/evleda_live_pcb_pad_snapshot.py`, SHA256
`706d682a368449dd8a0423d7c4a4cb56d5458a440e3641caabe4b6251ab917cc`.
The delta adds the selector and `_snapshot_result`, then calls that helper
at the existing serialization boundary. Collection and validation are unchanged.

Run `test_pad_snapshot_envelope.py` with the qualified DOC11 environment's
Python using `-I -s -E -B`. These offline tests exercise retained native-shaped
observations, the real MCP in-memory transport, and unchanged byte limits.
They do not establish live native routing or recovery acceptance.

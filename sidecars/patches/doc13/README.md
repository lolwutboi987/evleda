# DOC13 lossless plane-stage receipt storage

**Historical failed producer:** the first live stage left native `OrderedDict`
PADs inline. The host rejected the result before save. Use the separately pinned
[DOC14 correction](../doc14/README.md); DOC13 has no live plane qualification.

The V1 plane receipt repeats complete PCB strings and native PAD Any records
through its ordered RPC transcript. On a larger routed board this duplication
can exceed the existing 8 MiB artifact cap after the native mutation.

DOC13 emits `evleda.native-plane-stage.v2`. It interns exact source strings in
`sourcePool` (maximum 16) and complete top-level RPC PAD records in `rpcPadPool`
(maximum 4096). Explicit source/PAD indices replace only the defined slots.
All native calls, responses, order, failures, geometries and physical members
remain represented. Same-UUID PAD records with different content stay distinct.
Source strings remain limited to 1 MiB. Source references are limited to 32;
both encoded and logical traversal retain 500,000 nodes and depth 64. The
artifact cap remains 8 MiB. Over-limit results fail; records are never truncated.

The host resolves immutable pool references without copying each PAD or
serializing an expanded receipt. It rejects malformed, duplicate or unused pool
members and feeds the resulting view through the existing complete native
source/geometry/RPC/PAD validation. The receipt identity explicitly records the
compact encoding. Legacy V1 receipts keep their original identity encoding.
The host-private artifact reference, public plane tool arguments, native calls,
mandatory Save/readback and recovery behavior are unchanged.

Install the three files under `evleda_plane_stage/` only into a new pinned
runtime. Preserve the predecessor runtime. The baseline `__init__.py` and
`plane_stage.py` are DOC4, respectively SHA-256
`64214fb427349f76340bec667783f0a7de59d62d97ef11532f5443d1f6a493a7` and
`96d14de0befe74b5fe4a26664a3580ab824de82b0cf48a515073ef1f22c699d1`.
`native_ports.py`, `typed_zone.py` and `protocol.json` remain unchanged.
Old hosts reject V2; installation alone is not live native qualification.

Run `test_compact_receipt.py` with isolated Python (`-I -s -E -B -X utf8`).
Host coverage includes malformed references and amplification bounds, and runs
the source-bound stage adapter's success and adversarial cases against both
encodings. Recorded native-receipt replay additionally checks the Python
producer against the independent test encoder and the complete host validator.
These offline checks do not establish fresh fill or board acceptance.

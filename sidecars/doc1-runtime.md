# Private native document/source snapshot

The separate `inspection-runtime-3.33.3-doc1` copy adds
`evleda_get_live_pcb_document()` for the host's private MCP port. The original
runtime, launcher, manifest, and profile09 dependencies remain unchanged.

The new runtime uses the versioned source launcher
`kicad-inspection-launcher-doc1.py`, installed under the original relative
launcher filename, and the sibling `evleda_live_pcb_document.py` addon.
The copied `environment/pyvenv.cfg` points to the new runtime's Python root.
No upstream package file is modified by this addon.

The addon registers one no-argument READ/KICAD_IPC capability using the pinned
MCP SDK FastMCP implementation. It uses `connection.get_kicad()` and requires
exactly one native `DOCTYPE_PCB` document. The returned board's document and
repeated document inventories must match a copied initial protobuf. Raw
`Board.get_as_string()` runs between those native identity observations.
This is a repeated observation, not an atomic document lock or proof against
an undetected change-and-return between observations.

Success is one text JSON block plus a matching `structuredContent` root and
`isError:false`, with no result nesting, metadata, or annotations:

```json
{
  "schemaVersion": "evleda.kicad-live-pcb-document.v1",
  "documentType": "pcb",
  "projectPath": "D:\\owned\\project",
  "boardFilename": "candidate.kicad_pcb",
  "boardSource": "(kicad_pcb\r\n)\r\n"
}
```

`projectPath` is the native project directory and `boardFilename` its native
basename. Neither comes from configured project data. Native board text is
returned unchanged, including CRLF, bare CR, escaped text, and embedded paths.
The addon rejects missing/ambiguous/switched documents, IPC failures, malformed
native fields, NUL/invalid Unicode, source over 1 MiB UTF-8, and a serialized
result over 2 MiB minus a 4096-byte JSON-RPC allowance. It has a ten-second
request timeout and rejects concurrent snapshot requests. Timed-out worker
reads cannot produce a successful late result; deadline checks stop further
reads once an in-flight native call returns. There is no disk/config fallback.

The host port owns canonical path matching and keeps this capability, raw
paths, and source outside public tool lists and the public result sanitizer.

KiCad10.0.3 is the inspected target, not a claimed completed live test. The
capability's tested-version metadata is empty. Primary source facts:

- KiCad10.0.3 `api/proto/common/types/base_types.proto`: project path is the
  project directory; board filename is a filename.
- KiCad10.0.3 `pcbnew/api/api_handler_pcb.cpp`: native document inventory uses
  `Prj().GetProjectDirectory()` and the board file's `GetFullName()`.
- Pinned `kipy.kicad`: `get_open_documents` sends `GetOpenDocuments`, and
  `get_board` reissues the inventory then wraps its first document.
- Pinned `kipy.board`: `get_as_string` sends `SaveDocumentToString`.

`tests/test_live_pcb_document.py` uses fake native clients and in-memory SDK
sessions only. It covers absent/multiple/switched/mutated documents, IPC
errors, exact schema and wrappers, raw source preservation, size limits,
read-only/write catalog policy, argument rejection, and launcher registration.
It explicitly forbids constructing a real KiCad client in framework tests.
No GUI or native compatibility run is implied by these tests.

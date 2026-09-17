# DOC8: preserve intentional no-connect pads during initial PCB sync

The retained native04 KiCad 10.0.3 export contains a singleton net named
`unconnected-(U1-NC-Pad5)` with `U1:5` typed `no_connect`. DOC7 copied every
exported endpoint into its PCB pad-net map. The footprint renderer consequently
assigned that synthetic name to the regulator's NC copper pad, and the host's
strict contract check correctly rejected and rolled back sync.

DOC8 changes only the producer's `_parse_netlist_text` behavior. It omits an
endpoint from the assignment map only when all three conditions hold:

- The whole net name matches `unconnected-(...)`, with nonempty content.
- The net has exactly one direct `node` form.
- That node has one unambiguous `pintype` field containing the exact
  `no_connect` token, delimited by `+` where combined with another type.

This matches the existing native parity check, including the native
`passive+no_connect` representation. A small direct-child reader keeps quoted
text, nested metadata, and similarly prefixed field names out of structural
classification. A duplicate or malformed second node prevents singleton
classification. Noncanonical names, ordinary pin types, ambiguous duplicate type
fields, and multi-node nets remain subject to the existing assignment behavior
and strict host checks.

`_assign_pad_nets`, qualified footprint identities, tool descriptors, graph
qualification, native transactions, deadlines and host pad validation are
unchanged. No capability marker was added. Omission fixes initial import of the
netless stock footprint. It does not clear an existing pad net or rewrite an
already matching footprint; preexisting contaminated boards still require
separate host-reviewed recovery.

## Reproduction and offline qualification

The retained fixtures are exact bytes from native04's exported `pcb_sync.net`
and the installed stock
`Package_SON:WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm` footprint. `provenance.json`
records the original and retained paths, sizes and hashes. The native export
includes 17 endpoint records; the DOC8 map retains exactly the 16 functional
GND, VIN_5V and VOUT_3V3 assignments and omits only `U1:5`.

`test_no_connect_net_transfer.py` imports the actual runtime PCB module and
feeds the actual parser's output into the actual footprint renderer. Its 16
tests cover the retained export, both NC type forms, misleading names and type
tokens, multi-node and malformed cases, quoted/nested fields, the qualified
footprint identity and all nine original physical pad primitives. Seven numbered
copper pads remain present; pad 5 stays netless and the two unnumbered paste
apertures remain byte-identical. Descriptor qualification uses the real
`KiCadFastMCP` registration adapter in memory; no server loop starts.

```powershell
C:\EvlEDA-DOC8-20260916\environment\Scripts\python.exe -I -s -E -B -X utf8 `
  sidecars/patches/doc8/test_no_connect_net_transfer.py
```

The same final driver fails against DOC7 and records the erroneous U1:5 mapping.
DOC8 also runs the unchanged 12-test DOC6 footprint-identity driver and 13-test
DOC7 power-flag driver. Both existing normalized Tool descriptors must match
their existing host fixtures exactly.

`build-runtime.mjs` refuses existing output targets. It authenticates the pinned
DOC7 manifest, verifies all 8,467 source files, applies the reviewed patch to a
separate source copy and checks byte-for-byte reproduction, then copies the full
runtime closure. Only the reviewed `pcb.py` and `pyvenv.cfg` home change. It runs
Python with `-I -s -E -B -X utf8` and a restricted process environment, builds
and verifies the full new manifest, and verifies the complete old DOC7 closure
again. Package metadata, RECORD, directories and all other runtime leaves must
remain exact. Existing runtime trees and profiles are preserved.

The authoritative reports are the transfer's `working-profiles/doc8-*` files,
with their pins bound by `provenance.json`. The patch applies with
`git -c core.autocrlf=false apply` to a copied DOC7 source tree.

This is offline producer qualification using retained native-format evidence.
It does not establish fresh native sync success, placement, routing, board
acceptance, or electrical/manufacturing suitability. Native integration and
selection of a separately pinned host profile belong to the parent workflow.

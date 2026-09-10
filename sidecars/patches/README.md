# Recorded runtime patches

These are local EvlEDA overlays to the manifested runtime, not a new upstream
release or a relabeling of the published wheel. The distribution lock retains
the original PyPI archive and metadata identities. The runtime manifest and
production profile separately bind the bytes actually executed.

## 0001: explicit junction connectivity

`0001-explicit-junction-connectivity.patch` changes only
`kicad_mcp/tools/schematic.py::_build_connectivity_groups` in the recorded
3.33.3 base file. It reads explicit junctions from the same text used for
no-connects, then joins each junction to every incident containing wire before
forming groups or attaching pins and labels. Endpoint unions, undotted
crossings, pin/label attachment, no-connect markers, and name collapse keep
their prior behavior. Writer and geometry-normalization helpers are unchanged.

The existing containment predicate supports horizontal and vertical wires
using the upstream tolerance; this patch does not add diagonal-wire semantics.
Apply only to the exact original file identity in `runtime-patches.json`, then
verify the patched identity and regenerate the complete runtime manifest.

The captured regression fixture is the exact LF-normalized attempt11 final
schematic authenticated by retained SHA-256
`b5253e3df46a0e0e59ab24e0791da781c399470dbed760e87720482cdbe68d06`.
The original reader produced VOUT = J1:2, R1:2 and a separate unnamed R2:1;
the patched reader produces VOUT = J1:2, R1:2, R2:1. GND and VIN remain exact.
Pinned native KiCad independently confirmed the three endpoint sets. Native
ERC also reported separate off-grid warnings; this patch does not qualify the
board, remove those warnings, or weaken host/native acceptance checks.

Tests call the actual module, schematic parser, and installed stock pin
resolution. They cover the captured T junction, dotted/undotted crossings,
an explicit T branch, interior pin/label attachment, shared endpoints,
name collapse, and no-connect preservation. No group results are fabricated.

Upstream license and published provenance are retained in
`../../third_party/kicad-mcp-pro/NOTICE.md`.

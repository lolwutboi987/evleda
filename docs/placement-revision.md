# Revising placement on an authored V2 board

`evleda_revise_placement` creates a separate workspace project with revised
component placement constraints. It carries forward the source schematic,
functional footprints, tracks, vias and plane geometry. Component movement and
rerouting then use the existing native authoring operations.

The source must be fully materialized and must have closed successfully in the
current workspace connection. Its exact profile, libraries, source files,
checkpoint and physical file identities are checked while its lease is held.
The original project is preserved.

Only `placementConstraints` and original-prompt metadata may differ in the new
ready draft. Circuit, component inventory, values, board dimensions, stackup,
electrical requirements, routing limits, netclasses, planes and interface limits
remain exact. The project stem stays the same; the workspace allocates a new ID
and directory.

## Workflow

1. Resume the source project and close it normally with `evleda_close_project`.
2. Submit the complete revised draft with `evleda_submit_design`.
3. Call `evleda_revise_placement` with the returned `draftId` and the source's
   `sourceProjectId`. The operation creates and opens the new project.
4. Refresh the tool list and design context. Plan component movement together
   with affected routing, then use the normal placement and route operations.
5. Reapply the bound plane and complete mandatory save/readback. Collect current
   endpoint, native-check, interface, plane and rendered-view evidence.
6. Close the revised project normally. Subsequent resume loads its immutable
   revision lineage from the workspace allocation.

The creation operation preserves existing component poses and routes. It does
not automatically move components, resolve existing violations or carry over
fresh-fill or acceptance authority. Stored fill polygons remain a cache until a
new qualified refill. Repeating the same draft/source request returns the
existing allocation without overwriting it.

## Source preservation and ownership

The new bundle has its own owned netclass and plane names. Mounting-feature
UUIDs are also derived from the bundle, so they are deterministically rebound.
Functional footprint and electrical pad UUIDs stay unchanged. Tracks, vias,
schematic bytes and the contents of unrelated PCB source forms stay unchanged.
The complete footprint forms are reordered by UUID after rebinding, matching
the pinned KiCad 10.0.3
[board serializer](https://gitlab.com/kicad/code/kicad/-/raw/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp)
and [item comparator](https://gitlab.com/kicad/code/kicad/-/raw/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/pcbnew/board_item.cpp).
Coordinates, geometry and footprint contents are preserved by that ordering.

Project JSON preserves existing settings while rebinding only owned class names
and their exact net assignments. The native initial save must preserve the
qualified PCB and project settings exactly. Canonical rules and library tables
are generated for the new bundle through ordinary project preparation.
Netclass preparation leaves already-correct settings byte-for-byte intact,
including native JSON member order. A native source mismatch retains a complete
private prepared/live snapshot before startup cleanup; it never authorizes Save.
Initial-save history admits only a newly created ordinary leaf containing either
the exact observed live bytes or the exact LF form of the prepared PCB. This
matches the observed native history writer while keeping the primary files
byte-exact. Other native history files remain covered by source-inventory checks.

An external reference to a remapped mounting-feature UUID is unsupported and
rejects before project creation. Ambiguous class assignments, foreign or
duplicate planes, changed circuit/route policy, stale sources, forged handles,
mixed import lineage and reused seed capabilities also reject. Interrupted
allocations and uncertain native state remain available for review.

## Verification status

Software tests cover source rebinding, exclusion of non-placement changes,
currentness and ownership checks, project creation, replay and resume over MCP.
An offline replay of the saved RP2350 60-12 source preserves 829 tracks, 104 vias
and all functional footprints while rebinding its owned identifiers.

Native qualification now passes on the real RP2350 60-12 source: public revision creation, mandatory native save/readback, fresh plane UPDATE, native connectivity/checks, inspected previews, normal close and a new read-only connection reopening from stored lineage. The [complete proof](../proofs/native-placement-revision-20260919/README.md) preserves the three rejected trials and the resulting fixes.

No component moved during qualification. The resistor-placement and remaining routing work is still open; design acceptance remains false.

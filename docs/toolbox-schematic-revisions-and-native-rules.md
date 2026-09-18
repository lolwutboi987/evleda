# Schematic revisions and contract-derived native rules

Protocol and evidence snapshot: 2026-09-18. Use the tools and schemas advertised
by the active workspace. New source capabilities do not change an existing
project's bound contract, runtime or evidence.

## Move existing schematic fields

`fresh_set_schematic_field_positions` accepts an atomic `updates` list of 1–128
unique reference/field pairs. Each entry has exactly `reference`, `field`,
`x_mm` and `y_mm`; `field` is `Reference` or `Value`. The reference must belong
to the contract and select an existing, unambiguous source field. A partial
component inventory and a schematic without authored connectivity are allowed.

For example, a position-only proposal for the Q1 value is:

```json
{
  "updates": [
    {"reference": "Q1", "field": "Value", "x_mm": 139.7, "y_mm": 177.8}
  ]
}
```

Coordinates use stored sheet coordinates, not a rotated symbol's local frame.
They must lie within ±2000 mm and exactly represent 0.0001 mm schematic units;
the host rejects finer values instead of rounding them. Only the existing X/Y
tokens are replaced. Field strings, angles, font, stroke, justification,
visibility, all other fields, symbol poses, pins, electrical content, library
definitions and UUIDs remain byte-exact. Hidden fields remain hidden.

This differs from `fresh_autoplace_schematic_fields`, which has an empty request
and requires the exact already-authored connectivity/label inventory. Use the
position-only operation for a deliberate partial-state adjustment; it does not
run whole-sheet autoplace or certify legibility.

## Move or rotate an unwired symbol

`fresh_set_schematic_symbol_poses` accepts 1–64 unique references with exactly
`reference`, `x_mm`, `y_mm` and `rotation`. Coordinates have the same bounds and
native unit requirement as field positions; rotation is 0, 90, 180 or 270.
The checked outward-header request is:

```json
{
  "updates": [
    {"reference": "J2", "x_mm": 242.57, "y_mm": 64.77, "rotation": 180},
    {"reference": "J3", "x_mm": 242.57, "y_mm": 123.19, "rotation": 180}
  ]
}
```

Only the selected root instances' existing X/Y/angle tokens change. Every field
keeps its original text, coordinates, angle, font, visibility and justification.
For these headers, preserving the existing left justification is intentional;
subsequent field positions are a separate operation, for example:

```json
{
  "updates": [
    {"reference": "J2", "field": "Reference", "x_mm": 238.76, "y_mm": 62.484},
    {"reference": "J2", "field": "Value", "x_mm": 238.76, "y_mm": 64.516},
    {"reference": "J3", "field": "Reference", "x_mm": 238.76, "y_mm": 120.904},
    {"reference": "J3", "field": "Value", "x_mm": 238.76, "y_mm": 122.936}
  ]
}
```

The entire placed inventory must be a subset of the contract references, with
unique instance identities and supported unit-1/cardinal instance metadata.
The source restrictions apply to unselected instances too. Wires, local/global/
hierarchical labels, NC markers, junctions, flags/power symbols, buses, child
sheets, mirrors, alternate instance overrides and unknown forms reject. Embedded
library graphics and pins are retained, so a library arc does not itself prevent
this operation. It is not a transform engine for connected schematics.

Both operations validate the complete batch before staging. They require current
qualified write authority, the marker-bound source and file identity, an unchanged
saved/live PCB, and otherwise exact native netlist exports with only the export
timestamp ignored. Pose edits that create or break coincident-pin connectivity
therefore reject. Exact source checks surround native captures and the mandatory
save, including an idempotent request. The public toolbox performs save and
schematic readback before returning success; direct harness users must complete
the pending save before another call.

Native glyph results are source-bound literal-text candidates, not inferred field
ownership or a whole-sheet readability pass. The operations establish native
file consumption through export/render checks, not a GUI schematic reload. On
failure, the host restores only its owned preimage; unknown source bytes or a
replaced/shared file are preserved and further edits require session recovery.

## Place existing PCB footprints in one batch

`fresh_set_footprint_poses` accepts the closed object
`{placements: [{reference, x_mm, y_mm, rotation_deg}]}`. Supply 1–64 unique
existing electrical component references. All four fields are required;
`rotation_deg` is 0, 90, 180 or 270. Coordinates must be finite, within ±2000 mm,
and exact integer nanometres. Each target must also satisfy its bound front-side
placement region and allowed rotations. Board-only mounting features retain
their immutable contract poses and cannot be selected through this list.

The host validates the whole batch, complete physical library/pad inventory and
matching saved/live preimage before writing. It composes the existing preserving
footprint transforms in memory, retaining UUIDs, qualified library IDs, values,
pad properties, models, board features and unrelated source. A changed batch
uses one owned source staging and one native reload, followed by the mandatory
native save and full readback. An unchanged batch skips reload but retains its
save/readback requirement. Public toolbox callers receive the completed save
workflow; direct harness callers must finish the pending save before another
operation. Failed or unknown state follows the existing guarded recovery path.

This operation applies reviewed poses; it does not solve placement or establish
clearance. Previous plane-fill evidence becomes stale after placement changes.
See the [batch schema and planner](../src/harness/fresh-footprint-pose-batch.ts).

## Schematic pin geometry and label frames

Schematic library coordinates have upward-positive Y. Rotate them in library
space, then invert Y for the sheet: offsets are `(x,-y)`, `(-y,-x)`, `(-x,y)` and
`(y,x)` at 0, 90, 180 and 270 degrees. The pin's inward angle is its local angle
plus the symbol rotation, modulo 360. PCB transforms are separate.

Frozen DOC9 applied the quarter turns in the opposite order in pin lookup,
aliases, connectivity and visual geometry. Corrected host geometry rejects those
old observations. Independent KiCad CLI spatial-label netlists and SVG pin
strokes qualify all four rotations, including actual Q1 and crystal pin stacks;
agreement between source-derived helpers alone is insufficient. See
[DOC10 qualification and its current limits](../sidecars/doc10-runtime.md).

Terminal label planning uses the full native frame and stroke envelope around
the label anchor. It preserves the frame behind the connection port and admits
only the intended straight incoming lead at that port. Other wire/label/body
collisions still reject; legacy tree branches stop before the port rather than
crossing its frame. Cardinal label justification is explicit, and current native
glyph evidence remains separate from approximate planning bounds.

## Seed a new V2 candidate from a healthy close

When advertised, `evleda_create_project` accepts optional `sourceProjectId`:

```json
{
  "draftId": "<ready-target-draft UUID>",
  "sourceProjectId": "<closed-source-project UUID>"
}
```

Use real opaque IDs returned by this workspace. The target must be a new ready
`plane-v2` draft. The source must have closed successfully through the same
workspace connection, under the same native profile, with a current checkpoint
and unchanged source/library identities. No path, raw schematic, copied marker
or caller-provided receipt can substitute for that close authority. After a
restart, resume and successfully close an otherwise eligible source in the new
connection before selecting it for a seed.

The source must contain a supported single-root A4 unwired schematic with a
nonempty subset of the declared physical components. References, values,
footprints, unit/body selection and complete selected pin inventories must match
the contract. Only the required source-qualified embedded library definitions and
supported native field metadata are admitted. Connected primitives, power
annotations, hierarchical content, extra components/definitions and unsupported
source forms reject. The source PCB must equal its authenticated unmaterialized
baseline, with no authored footprints, tracks, vias or zones. A schematic that
passes the pose tool's envelope is not automatically eligible for this narrower
seed envelope.

The source and target keep the same project name and circuit. The permitted
target draft changes are deliberately limited:

| May change | Must remain exact |
| --- | --- |
| PCB `placementConstraints` | Component references, values, symbol/footprint IDs and pin inventory |
| `netClasses` and each net's `netClassId` | Electrical net names, roles and endpoint membership |
| `routingConstraints`, including hole spacing when admitted | Board shape/layers and construction/interface requirements |
| Board `widthMm` and `heightMm` | Every other board/scope field |
| Existing board-feature pose `xMm`, `yMm`, `rotationDeg` | Feature inventory, reference, kind, library ID, value, side, bore diameter and clearance requirements |
| `nativeRuleMode` | Source selection policy and symbol/footprint library authority |
| Plane rectangle `minXmm`, `maxXmm`, `minYmm`, `maxYmm` | Plane identity, net, layer, boundary kind, fill/thermal/island settings and every other plane field |
| Original-prompt metadata | External/derived power declarations and all other draft/contract content |

The target still passes ordinary compilation and relationship checks; this list
does not waive them. The host copies exact schematic bytes, records immutable
source/checkpoint/bundle/profile lineage, and generates the target PCB, project
settings and canonical rules from the new bundle. It does not copy authored
copper or overwrite the source project.

Dimension and mechanical-pose revisions retain target bounds, bore separation,
edge-clearance and approved-footprint checks. They do not imply that connector
pitch or enclosure compatibility is preserved; verify those design relationships
explicitly. Mechanical feature UUIDs are generated from the new bundle when the
new PCB is synchronized. There are no source feature UUIDs to migrate from the
required empty PCB. Actual 21-to-22 mm seed creation/open and normal close are
now proven in the scoped lifecycle evidence below; target reopen remains pending.

Submit the revised complete draft normally, close the source while retaining the
workspace connection, then create with the target `draftId` and source ID. Retry
an observation timeout with those same IDs. An existing allocation returns
`already_created`; changing its source selection rejects instead of replacing
it. Resume that allocation when appropriate. Failed or uncertain startup/close
still requires host review rather than editing checkpoints or lease files.

## Opt in to contract-derived numeric rules

The V2 draft/contract extension is `nativeRuleMode: "contract-derived-v1"`.
Omitting it retains legacy native settings and rule generation. Select the mode
in the draft before creation; it is not an operation that changes an active
project's contract. A fragment illustrating the two new fields is:

```json
{
  "nativeRuleMode": "contract-derived-v1",
  "routingConstraints": {
    "minimumHoleToHoleMm": 0.25
  }
}
```

This fragment is not a complete draft. Retain all required routing fields and
choose the spacing from the intended construction and fabrication basis.

The host derives native global floors plus exact per-net track-width and
copper-to-edge minima from the existing class/channel requirements. Channel
minima include the relevant declared terminal escape intervals; the numeric
projection does not establish that a narrow segment lies inside an allowed
escape. The route writer and saved geometry checks retain those location,
interval, layer, turn and completeness requirements. Declared routed vias retain
their exact writer dimensions and native diameter, drill and annular minima.
Unmatched copper and footprint pad drills keep the existing native fallback
constraints. Required numeric checks cannot be disabled to establish acceptance.

`routingConstraints.minimumHoleToHoleMm` is optional, requires the explicit
numeric mode, and accepts 0.05–10 mm in exact integer nanometres. It binds native
global edge-to-edge hole spacing for both plated and non-plated holes, including
same-net holes. When omitted in numeric mode, the existing 0.25 mm value remains.
It is distinct from copper clearance, copper-to-hole clearance and annular ring.
A draft may retain an unresolved null where its advertised schema permits it;
that does not provide a closed value or authorize creation.

The generated project settings and canonical `.kicad_dru` remain source-bound
through materialization, native assessment, save and resume. Drift is rejected,
not repaired by changing the contract after the fact. To revise those settings,
submit a new candidate and use the eligible seed path above when its strict
conditions hold. Numerical agreement and native DRC do not establish fabrication
capability, ampacity, impedance, thermal performance or whole-board completion.

## Host-only DOC9 to DOC10 unwired import

The separately qualified runtime transition uses a trusted administration path,
[not a model-callable tool](../src/mcp/toolbox-runtime-source-import.ts). It
requires a normally closed source with current allocation, lease, checkpoint,
report, bundle and library custody; the exact supported unwired schematic; and
an authenticated empty PCB baseline. Old and new profiles/runtime closures must
match the narrow published correction. This transition retains the same bundle
and circuit; ordinary same-profile design revision remains the separate seed
path above.

The importer copies source bytes into a distinct allocation and records pinned
lineage with `nativeEvidenceTransferred: false`. The target must complete its own
normal new-project open, save, checkpoint and close before success is recorded.
It retains no DOC9 pin/graph/readability/acceptance claims and does not repair or
overwrite the source project. Provider paths, copied markers or replacement
receipts cannot establish this host authority.

## Qualification status at this documentation snapshot

The earlier same-profile native07→native08 unwired seed and normal close/reopen
passed; evidence remains in `destination-verification/rp2350-native-seed-01`
under the transfer root. Native08 has since reached **62 unwired symbols with an
empty PCB**. It has no completed connectivity, placement, routing or acceptance
claim.

The first DOC10 `-01` administrative import failed profile admission before
allocation because its relocated launcher retained DOC9's argument hash. The
original evidence is preserved. Corrected profile `-02` passes the real native
and design readers; its runtime geometry qualification remains scoped to the
recorded fixtures. An independent full-design diagnostic also matches all 262
pin identities at 248 terminal anchors against a native CLI netlist. These facts
establish scoped geometry evidence; full-sheet label readability remains separate.

**Actual DOC9→DOC10 unwired import passed on `integration-doc10-build-02`.**
The driver exited 0 at 2026-09-18 09:14:28 UTC. New target
`3fa025b9-b9fe-4c74-9773-a6d8e15416b3` completed its normal native save,
checkpoint and close with the exact 62-symbol source. All ten pinned source
artifacts stayed unchanged, seven target artifacts matched custody, and source/target
leases, unsafe markers and locks were absent at import completion.
`nativeEvidenceTransferred` remains `false`.

The import retained the exact **21 mm bundle and empty PCB**. Public resume on
build03/session13 observed
62 symbols, 248 unwired groups and corrected Q1 pin positions, then closed
normally. All seven source/bundle artifacts remained byte-identical and the
lease was released; the operator client confirmed an idle workspace and exited.
Evidence is in
`destination-verification/rp2350-doc10-import-02/driver-exit.json` and
`post-import-verification.json`, with custody SHA-256
`d84e1242b52da82f74a21b405a952cccfd2271dd97ccabdc444c730564461da8`.
The same directory's `public-reopen-read-verification.json` and
`public-reopen-close-verification.json` record the separate public lifecycle.

The separate same-profile **21-to-22 mm seed creation/open and normal close
passed** on build03/session15 for target
`6af3e9dd-2be7-41f7-8e00-ac06cde791c6`. The
[creation snapshot](../../destination-verification/rp2350-native-22-seed-02/REPORT.md)
and [post-close verification](../../destination-verification/rp2350-native-22-seed-02/post-close-verification.json)
retain all seven project/bundle files unchanged; the lease, unsafe markers and
locks were absent after close. The exact 62-symbol unwired schematic is retained.
Its PCB remains unmaterialized, with no outline, footprints or copper; target
reopen and design acceptance are not established.

[Explicit mixed-layer plane access](toolbox-plane-access-layers.md) has software
coverage. Its actual-board qualification remains pending; the closed seed does
not establish routed access, layer transitions or plane contact.

Implementation references: [pose helper](../src/harness/fresh-schematic-symbol-pose.ts),
[field helper](../src/harness/fresh-schematic-field-position.ts),
[owned lifecycle](../src/harness/kicad-tools.ts),
[workspace seed qualification](../src/mcp/toolbox-schematic-seed.ts),
[runtime source import](../src/mcp/toolbox-runtime-source-import.ts),
[seed source envelope](../src/harness/fresh-plane-schematic-seed.ts),
[V2 schema](../src/harness/pcb-design-plane-contract.ts), and
[numeric rule projection](../src/harness/pcb-native-numeric-rules.ts).

## Bounded terminal-label retry

Larger terminal-label plans retain the existing successful greedy search. When
its immediate-predecessor retry fails, a bounded fallback may reconsider up to
three previous functional groups together with the failed group. Earlier
placements stay fixed, candidate indices advance without repetition, and the
same native frame, field, stroke and port checks apply. The remaining suffix and
all power flags must still pass. Plans with at most eight groups keep their
existing behavior.

All attempts share the existing 20-million work budget, including rollback and
retry work. Exhaustion returns no executable partial geometry. The independently
reviewed implementation clears the observed MCU QSPI label dead end in the
RP2350 diagnostic; that does not imply that its full label/flag plan or native
board is complete.

When a power-flag retry rebuilds a previously successful suffix, the same
planning session can try its prior distance indices first. Each choice still
runs every geometry check; a failed hinted branch can try the earlier default
choices. Hints stay private to the session, preserve flag minima and consume the
same work budget. This avoids repeatedly solving the same suffix without
reusing clearance results or increasing the search limit.

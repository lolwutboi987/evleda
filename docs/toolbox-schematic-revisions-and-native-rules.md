# Schematic revisions and contract-derived native rules

This page describes the source and public schemas frozen in
`integration-doc9-build-12`. Use the tools and schemas advertised by the active
workspace; these additions do not change an existing project's bound contract.

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
| `routingConstraints`, including hole spacing when admitted | Board geometry/layers, board features and construction/interface requirements |
| `nativeRuleMode` | Source selection policy and symbol/footprint library authority |
| Plane rectangle `minXmm`, `maxXmm`, `minYmm`, `maxYmm` | Plane identity, net, layer, boundary kind, fill/thermal/island settings and every other plane field |
| Original-prompt metadata | External/derived power declarations and all other draft/contract content |

The target still passes ordinary compilation and relationship checks; this list
does not waive them. The host copies exact schematic bytes, records immutable
source/checkpoint/bundle/profile lineage, and generates the target PCB, project
settings and canonical rules from the new bundle. It does not copy authored
copper or overwrite the source project.

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

## Qualification status at this documentation snapshot

The build12 implementation includes reviewed source-preservation, source
restriction, native-equivalence, save/rollback and schema regression coverage.
The actual native07 session has saved the two header poses with unchanged field
tokens, then saved the seven-field update. Native netlists remained equivalent,
all 90 unwired terminal groups were retained, and five non-schematic sources
remained byte-identical. The resulting 12-symbol schematic was exported and
visually reviewed: header poses and Q1 fields are correct. U2 at X=72.39 mm is
still provisional; the planned X=69.85 mm revision precedes final connectivity.

Evidence is retained in
`destination-verification/rp2350-schematic-field-pose-native-01` under the
transfer root. The resulting schematic is 46,513 bytes with SHA-256
`78dcbcd386be29976380459e8ce0f00d9c01233d56145089d8f047ce6f0e97dc`.
Actual seeded-project creation and its normal close/edit-reopen cycle also passed.
Candidate08 (`2d2cd5b0-5fda-488d-8424-fe0a4e708c8a`) retained that exact schematic,
including UUIDs, from candidate07. The original six sources remained unchanged.
The new project received its own contract-derived native settings and rules,
including 0.50 mm copper-edge and hole spacing, 0.15 mm QSPI track allowance,
and via-only 0.60 mm diameter / 0.25 mm drill / 0.15 mm annular minima. All six
new source files remained byte-identical through normal close and edit reopen.
The bound context matched the compiled candidate before further authoring.
Evidence is retained in `destination-verification/rp2350-native-seed-01` under
the transfer root. This proves the unwired revision lifecycle; no full-sheet
clearance, completed routing, accepted plane, whole-board clearance or
manufacturing claim follows from it.

Implementation references: [pose helper](../src/harness/fresh-schematic-symbol-pose.ts),
[field helper](../src/harness/fresh-schematic-field-position.ts),
[owned lifecycle](../src/harness/kicad-tools.ts),
[workspace seed qualification](../src/mcp/toolbox-schematic-seed.ts),
[seed source envelope](../src/harness/fresh-plane-schematic-seed.ts),
[V2 schema](../src/harness/pcb-design-plane-contract.ts), and
[numeric rule projection](../src/harness/pcb-native-numeric-rules.ts).

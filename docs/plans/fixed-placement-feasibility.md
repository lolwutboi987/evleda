# Fixed-placement feasibility and V1 coordinates

Assessed 2026-09-09. The divider is an agent-authored diagnostic integration fixture for the reusable suite, not a user PCB. This note records an explicit proposed fixture revision and the missing early geometry check. It does not change an existing board, prompt, bundle, contract, or approval.

## Current convention and interpretation guidance

Contract/draft V1 use a rectangle from `(0,0)` to `(widthMm,heightMm)`, with placement anchors and regions in that same coordinate frame. [Coordinates are nonnegative](../../src/harness/pcb-design-contract.ts#L84), and [region validation](../../src/harness/pcb-design-contract.ts#L656) compares positions directly with zero, width, and height. The [strict board schema](../../src/harness/pcb-design-contract.ts#L143) has no origin field.

The [supported placement evaluator](../../src/harness/fresh-design-acceptance.ts#L794) uses transformed courtyard-to-board-edge clearances. `edgePreference` must name the nearest courtyard edge within the existing `0.0001 mm` comparison tolerance. It is not anchor distance, and this geometric proxy alone does not establish connector mating access. Existing compiler wording about physical access did not explicitly define this geometric meaning; the guidance now does.

The [interpretation model guide](../../src/harness/pcb-design-intent-model-guide.ts) advances to `evleda.pcb-design-intent-model-guide.v2` while the contract/draft remain V1. The [interpreter](../../src/harness/pcb-design-interpreter.ts#L390) embeds the guide text in its system prompt. No separately stored content identity for that interpretation guide was found in the inspected compilation-bundle producer; its later authoring execution prompt is a different artifact. A new guide version therefore identifies the changed instructions explicitly. Existing bundles and their captured inputs are unchanged; no old guide content is relabeled.

Contradictory fixed placements must remain unresolved rather than causing the agent to shift the outline, move an anchor, change rotation, drop edge preference, or widen tolerance. Missing exact footprint geometry is not evidence of feasibility.

## Source-bound fixture arithmetic

The original attempt13 prompt is retained at `D:/EvlEDA-live-proof-v8-attempt13-preparation-20260909/prompt.txt`. Line 1 fixes the four outline corners `(0,0)`, `(30,0)`, `(30,20)`, `(0,20)` and J1 anchor `(5,10)`; line 22 fixes rotation `0`, minimum edge clearance `1 mm`, and `edgePreference="left"`. Its captured contract identity is `d14b249d018e1e192df621e472d6e6287754b5596831f412ad4610680a61540c`.

Exact stock asset: `D:/Codex-Recovery/KiCad/10.0/share/kicad/footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x03_P2.54mm_Vertical.kicad_mod`, 3,129 bytes, SHA-256 `6a7dba97d6e733fd9d5f12d2d57f2cde29e8393e15b08d8b3e41bf2b430d83ed`. Its `F.CrtYd` rectangle at lines 94-102 runs from `(-1.77,-1.77)` to `(1.77,6.85)` in footprint coordinates.

| Fixture | Transformed courtyard at rotation 0 | Left | Right | Top | Bottom | Nearest-left result |
| --- | --- | --- | --- | --- | --- | --- |
| Original J1 `(5,10)` | `(3.23,8.23)` to `(6.77,16.85)` | 3.23 mm | 23.23 mm | 8.23 mm | 3.15 mm | Fails by 0.08 mm, greater than 0.0001 mm tolerance. |
| Proposed J1 `(4,10)` | `(2.23,8.23)` to `(5.77,16.85)` | 2.23 mm | 24.23 mm | 8.23 mm | 3.15 mm | Left is nearest by 0.92 mm; all edge clearances exceed 1 mm. |

Keep the original as a negative fixture. The candidate `(4,10)` is an explicitly revised agent-authored diagnostic specification, with new prompt/contract/bundle/approval identities when prepared. Retain rotation, outline origin/dimensions, other anchors, electrical intent, widths, clearances, routing style, and zero-via policy. These calculations establish only this placement condition; they are not a native test or a complete placement/routing pass. The copied prompt's self-label of user authorization is not independent evidence that the user chose those coordinates.

## Smallest early feasibility insertion

Use the existing [KiCad10StockLibraryResolver.inspectFootprint](../../src/harness/kicad-library-resolver.ts#L1013), backed by its exact-ID, bounded [asset reader](../../src/harness/kicad-library-resolver.ts#L402), parsed source, and source identity. [Footprint inspection](../../src/harness/kicad-library-resolver.ts#L143) currently exposes only courtyard-presence booleans, not bounds. Extend that inspection with bounded local courtyard geometry from its already parsed footprint; do not add another filesystem discovery path or general geometry framework.

The earliest useful check is immediately after exact library resolution and contract closure, before [the compiler returns ready](../../src/harness/pcb-design-compiler.ts#L1508). The production composition already creates the concrete [stock reader](../../src/flux/production-composition.ts#L2544). Pass only its identity-bound geometry projection to a small shared placement evaluator. Reuse the supported rectangle/line courtyard and rotation/translation rules from the [fresh PCB parser](../../src/harness/fresh-kicad-parser.ts), plus the current placement clearance arithmetic, so preflight and terminal acceptance use the same semantics.

Start with fixed anchors and explicit allowed rotations. Reject a proven contradiction before preparation/model authoring; preserve unknown or unsupported geometry as an unresolved feasibility result. Do not reject a non-fixed region merely because a single sample position fails, and do not claim general placement/routability search. This insertion is proposed, not implemented by the guidance change.

## Acceptance follow-up and meaningful checks

The inspected rectangle acceptance checked dimensions/topology without absolute origin. The separately owned acceptance fix should require `bounds.minX` and `bounds.minY` approximately zero using the existing coordinate tolerance, while retaining dimensions, axis alignment, closure, and all placement checks. It must not shift outlines or relax courtyard-nearest semantics.

- Retain the ordinary origin-zero positive fixture.
- Reject the same-size outline translated beyond tolerance in X or Y at `board:outline`.
- Reject a jointly translated board and placement anchors under the zero-origin V1 convention.
- Preserve original `(5,10)` as a fixed-placement infeasibility negative; verify the explicit `(4,10)` revision's nearest-left calculation from the exact stock asset.
- Reject or retain unknown when the bound footprint source changes, the courtyard is missing, or its geometry is outside the supported subset.

Model-guide tests pin the new guide version, bytes, and hash, preserve the parser-valid example, and assert the clarified origin, courtyard-distance, and conflict behavior. A guide test does not prove that early feasibility or the separately owned origin acceptance fix has been implemented or passed.

Verification on 2026-09-09: Node 24.19.0 / Vitest 4.1.11 ran `tests/unit/pcb-design-intent-model-guide.test.ts`, with 4/4 tests passing. Guide v2 is 7,368 UTF-8 bytes, SHA-256 `0704be1e93772544484740a3182a8cac3871d0cc683624b8a083cd5a7f1604a4`. The parser-valid example is unchanged. No native/model/GUI operations were used for this change.

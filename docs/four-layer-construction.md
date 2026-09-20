# Four-layer construction foundation

The construction writer can now generate a native blank board with **F.Cu, In1.Cu, In2.Cu and B.Cu**, four separate copper thicknesses and three separate dielectric gaps. KiCad 10.0.3 loaded, saved and reopened the synthetic fixture with identical bytes. The existing two-layer creation path retains its authenticated-bundle requirement and its captured native output.

This is the first implementation step after the [RP2350 feasibility study](../designs/rp2350-pico/four-layer-feasibility-20260919/README.md). **The public compiler and managed authoring workflow still support two layers only.** No existing project, bundle, runtime or canonical rule file was changed by this work.

## Representation

[`pcbFourLayerConstructionSchema`](../src/harness/pcb-four-layer-construction.ts) declares the fixed copper order and one homogeneous material record for each of:

- `frontDielectric`: F.Cu to In1.Cu, prepreg;
- `coreDielectric`: In1.Cu to In2.Cu, core;
- `backDielectric`: In2.Cu to B.Cu, prepreg.

Each record retains its own material, relative permittivity, loss tangent, frequency, permeability and source assertion. The four copper thicknesses and front/back masks are explicit. Heterogeneous sublayers and nonuniform mask profiles are outside this bounded representation; no averaging or property inference is performed.

`boardThicknessMm` is the exact native sum of all declared copper, dielectric and mask thicknesses, compared in integer nanometres. `nominalFinishedBoardThicknessMm` records the supplier's nominal finished thickness separately. Changing that nominal does not resize the native stack. Missing material data cannot be replaced with a native “Not specified” sentinel or an invented default.

[`createFourLayerConstructionBoardSeed`](../src/harness/interface-construction-seed.ts) is a pure source generator for new blank-board construction qualification. It performs no file or CAD operation and provides no managed-project authority. It must not replace an existing PCB. Its output enables the actual inner layers and describes the same order in the physical stackup; all three dielectric thicknesses are locked. Frequency, conductor metadata and source citations remain declaration metadata because the native file does not encode those assertions.

## Verification

The [synthetic fixture](../tests/fixtures/fresh-project/native-four-layer-construction.kicad_pcb) deliberately has asymmetric 0.1/0.6/0.2 mm dielectric gaps, different material constants, and 0.01/0.02 mm masks. Its modeled native thickness is 1.0304 mm and its nominal declaration is 1.0 mm. These are software test values, not a supplier recommendation.

The [native capture provenance](../tests/fixtures/fresh-project/native-four-layer-construction.provenance.json) records two native load/save cycles, four enabled copper layers, exact native thickness, unchanged input and checked runtime-file identities. The existing saved-stackup reader returns all three adjacent separations individually and keeps impedance validation unperformed.

The focused construction/interface/stackup run reported **99 passed and one failed**. The failure is the existing absent `reference-designs/robotics-controller-v0/robotics-controller-v0.kicad_pcb` six-layer fixture; it was not replaced or skipped. New four-layer tests and existing two-layer construction/interface tests passed. Rejection cases include a one-nanometre total mismatch, substituted nominal thickness, fractional-nanometre copper, missing core, unknown layer-order override, nonfinite/negative-zero values and unresolved/unrepresentable material fields. Full source/UI type checking and an isolated backend TypeScript build also passed. This is not a full-suite or complete four-layer authoring claim.

## Next integration boundaries

1. Extend the plane-family board/net-class and construction declarations coherently, preserving old canonical two-layer bundles. Keep the legacy routed family bounded unless separately implemented.
2. Support the intended two ground planes. `PCB_PLANE_CONTRACT_LIMITS.maxPlanes`, draft/closed plane counts and the native checks' single-plane assumption currently restrict this to one plane; changing layer enums alone is insufficient.
3. Qualify inner-layer route/zone operations, enabled-layer checks, via participation, save/readback and source preservation in a new runtime. Footprints and silkscreen still belong on outer faces.
4. Integrate saved construction and adjacent-reference assessment with a new authenticated project/revision path. The placement-revision operation cannot change construction or interface requirements.

Only then can the four-layer RP2350 candidate be authored and its remaining placement, routing and electrical work verified.

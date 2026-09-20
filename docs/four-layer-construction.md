# Four-layer construction and compilation

The construction writer can now generate a native blank board with **F.Cu, In1.Cu, In2.Cu and B.Cu**, four separate copper thicknesses and three separate dielectric gaps. KiCad 10.0.3 loaded, saved and reopened the synthetic fixture with identical bytes. The existing two-layer creation path retains its authenticated-bundle requirement and its captured native output.

Following the [RP2350 feasibility study](../designs/rp2350-pico/four-layer-feasibility-20260919/README.md), the public plane-family compiler accepts four-layer construction and one or two named ground planes. Managed creation, internal tracks, ordinary through-vias and both internal ground planes were exercised on a separate native fixture. The original two-layer RP2350 remains preserved. A [complete four-layer native review target](../designs/rp2350-pico/four-layer-review-117/README.md) is now available with all functional nets connected and configured ERC/DRC zero; its managed public-tool adoption and final acceptance checks remain in progress.

## Public declarations and saved assessment

Four-layer scope enables exactly F.Cu/In1.Cu/In2.Cu/B.Cu. Each net class may use only enabled layers. One ground routing owner names its primary `planeId` and optionally one `additionalPlaneIds` entry on the same net; planes occupy distinct layers. `any` permits that net class's declared layers on four-layer boards. Existing `either` semantics remain the two outer layers. References must be on an adjacent enabled layer, and differential interfaces retain one exact outer signal layer with no transitions.

The authenticated construction seed uses the compiled declaration. Saved-interface assessment compares both inner copper thicknesses and each dielectric's thickness, type and material separately. The public report retains all three gaps, including missing/unsupported observations. Front and back numerical model requests select their own adjacent dielectric; neither the core nor total thickness is substituted. Mask, finish and other existing model restrictions remain enforced. Nominal finished thickness remains an unverified supplier assertion.

Old two-layer contract, compilation, bundle and canonical-rule golden identities remain unchanged; the legacy routed family remains two-layer-only. Model guide v2 documents the new branches. Its combined guide budget is 22 KiB, accommodating the additional construction and ownership instructions; the measured complete guide is 21,264 bytes.

## Representation

[`pcbFourLayerConstructionSchema`](../src/harness/pcb-four-layer-construction.ts) declares the fixed copper order and one homogeneous material record for each of:

- `frontDielectric`: F.Cu to In1.Cu, prepreg;
- `coreDielectric`: In1.Cu to In2.Cu, core;
- `backDielectric`: In2.Cu to B.Cu, prepreg.

Each record retains its own material, relative permittivity, loss tangent, frequency, permeability and source assertion. The four copper thicknesses and front/back masks are explicit. Heterogeneous sublayers and nonuniform mask profiles are outside this bounded representation; no averaging or property inference is performed.

`boardThicknessMm` is the exact native sum of all declared copper, dielectric and mask thicknesses, compared in integer nanometres. `nominalFinishedBoardThicknessMm` records the supplier's nominal finished thickness separately. Changing that nominal does not resize the native stack. Missing material data cannot be replaced with a native “Not specified” sentinel or an invented default.

[`createFourLayerConstructionBoardSeed`](../src/harness/interface-construction-seed.ts) remains a pure source generator with no file/CAD operation or managed-project authority. The authenticated `createInterfaceConstructionBoardSeed` entry now selects the same renderer for compiled four-layer bundles. Neither entry can replace an existing PCB. Output enables the actual inner layers and describes the same order in the physical stackup; all three dielectric thicknesses are locked. Frequency, conductor metadata and source citations remain declaration metadata because the native file does not encode those assertions.

## Verification

The [synthetic fixture](../tests/fixtures/fresh-project/native-four-layer-construction.kicad_pcb) deliberately has asymmetric 0.1/0.6/0.2 mm dielectric gaps, different material constants, and 0.01/0.02 mm masks. Its modeled native thickness is 1.0304 mm and its nominal declaration is 1.0 mm. These are software test values, not a supplier recommendation.

The [native capture provenance](../tests/fixtures/fresh-project/native-four-layer-construction.provenance.json) records two native load/save cycles, four enabled copper layers, exact native thickness, unchanged input and checked runtime-file identities. The existing saved-stackup reader returns all three adjacent separations individually and keeps impedance validation unperformed.

The original construction/stackup run reported 99 passed and one failure for the absent historical six-layer fixture; that file remains missing. Construction rejection cases cover one-nanometre mismatches, substituted nominal thickness, fractional-nanometre copper and unresolved/unrepresentable material fields.

The integration checks cover four-layer compilation and portable bundle round trips, two-plane ownership, disabled layers, adjacent references, unresolved-construction questions, all saved dielectric/material comparisons and independent front/back calculator inputs. The broader 310-test run found a preparation regression: an added capability check read a bundle getter twice. Moving the check after the single capture fixed it. The final affected project/workspace run passed **46 tests**, and the final construction/public-report/MCP-interface run passed **63 tests**; these overlapping scopes are not added into a total. Existing two-layer golden artifacts passed in the broader run. Source/UI type checking and the isolated backend build passed after the final source changes. No full-suite or complete four-layer authoring claim is made.

## Native authoring and verification

The [native four-layer fixture](../proofs/native-four-layer-20260919/README.md) records the saved project, independent plane assessments, configured native checks, previews, closure and remaining failures. Host37 passed 471 focused tests plus source/UI type checks and backend build. The separate DOC16 runtime closure and negative-manifest checks passed. No full-suite pass is claimed.

Source scope requires the exact enabled layer order and canonical KiCad 10 copper ordinals. Internal footprint faces, copper text/graphics and hidden copper aliases remain rejected. Tracks may use enabled contract layers; `any` is resolved through the shared layer-preference check. Vias remain ordinary F.Cu-to-B.Cu through-vias, with native membership checked on every enabled copper layer. Blind/buried vias are unsupported. The existing 45-degree turn rule is unchanged.

Multiple planes require an explicit `planeId`. Source zones are bound by unique generated name, UUID, net and layer. Each plane's settings, thermal rule, saved/native geometry and drill topology use its own zone. A current fill witness covers the complete board epoch; selecting the last modified plane never substitutes its geometry for another plane. Closing and reopening requires fresh fill authority before acceptance assessment.

DOC16 advertises the bounded four-layer stage descriptor and includes DOC15's typed enabled-layer adapter. The host retains exact legacy two-layer descriptor support and rejects an internal-layer request before dispatch to an older runtime. Runtime closure verification recognizes the exact DOC15/DOC16 leaves and requires their full predecessor lineage. Frozen older runtimes and hosts remain unchanged.

Inner-layer NPTH physical-hole rules were exercised independently in KiCad: 0.4 mm clearance failed the declared 0.5 mm rule on both In1.Cu and In2.Cu; 0.7 mm cleared that rule. This is rule applicability evidence, not whole-board acceptance.

The placement-revision operation still cannot change construction or interface requirements. A four-layer RP2350 candidate needs a supported new-project or construction-revision workflow, followed by actual placement, routing and electrical checks. Native-clean synthetic fixtures do not establish that result.

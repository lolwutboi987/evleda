# Four-layer feasibility study

**Four layers are worth developing for the approved 22 × 60 mm outline. This is a geometry/DC study, not an adopted four-layer PCB.** The user authorized considering four layers on 2026-09-19. The managed candidate remains [two-layer revision 60-13](../native-ground-bridge-60-13/README.md).

The working layout direction is **signal/power — ground — ground — signal/power**. Two inner ground layers would let both outer routing layers have adjacent ground references and free the back face from its current ground-plane routing restrictions. This is an engineering proposal; complete signal routing and return-path suitability are still unproved. A third signal layer is not assumed. GPIO pitch, row spacing, 45-degree routing and the protected header service strips remain requirements.

## Native geometry comparison

KiCad 10.0.3 loaded, refilled, saved and reloaded separate disposable copies. All 831 existing tracks, 106 vias, 66 footprint poses and 281 pads were retained. Configured DRC included schematic parity; copied project settings and rules were unchanged. The two-layer control reproduced the original findings and ground connectivity.

| Geometry case | GND pad groups; largest group | Unconnected DRC findings | Stored plane regions |
| --- | --- | ---: | --- |
| Two-layer control | 8; 52/64 | 23 | Back: 13 |
| Add L2 ground, retain back ground | 6; 58/64 | 21 | L2: 1; back: 13 |
| Move ground to L2 | 10; 54/64 | 25 | L2: 1 |
| Ground on L2 and L3 | 10; 54/64 | 25 | L2: 1; L3: 1 |
| L2/L3 ground plus eight own-header leads on L2 | **2; 63/64** | **17** | L2: 1; L3: 1 |

Moving the back plane alone disconnects header stubs that previously landed in it. The final study explicitly connects each of the eight plated ground header pads inward on In1.Cu: straight 0.3 mm tracks, from x=2.11 to 3.61 mm or x=19.89 to 18.39 mm at the pad's own y coordinate. It adds **no vias** and changes no exposed routing. The remaining isolated ground pad is **SW1.1**.

That final geometry has no reported clearance, shorting, hole-clearance or parity findings. It retains **19 dangling-track and two dangling-via warnings**, including back-layer stubs left after the plane move. The native connection result is DC evidence, not proof of high-frequency return quality or globally drill-clipped plane continuity.

Both inner plane outlines and every retained filled-contour vertex stay within x=3.46..18.54 mm and y=0.5..59.5 mm. The only added tracks entering the header service strips are the exact same-pad inward ground connections. No unrelated between-pad copper is added.

## A rejected proposal caught real clearance failures

The earlier access proposal extended header leads farther inward and added a switch-ground via. Native DRC found one 0.125 mm clearance against a 0.15 mm requirement, four shorting findings and three hole-clearance findings. The switch via and its front trace collided with existing GPIO routes. That proposal was rejected even though its GND-only graph showed all 64 pads connected. The clean study shortens the inner header leads and omits the colliding switch connection. See [rejected findings](rejected-ground-access-drc.json).

## Construction under consideration

The [JLCPCB stackup selector](https://jlcpcb.com/impedance), observed with **1.0 mm, outer 1 oz, inner 0.5 oz**, lists **JLC04101H-3313**:

| Layer/material | Published thickness |
| --- | ---: |
| Top copper | 0.035 mm |
| 3313 prepreg | 0.09940 mm |
| L2 copper | 0.0152 mm |
| Core | 0.700 mm |
| L3 copper | 0.0152 mm |
| 3313 prepreg | 0.09940 mm |
| Bottom copper | 0.035 mm |

Those copper/dielectric numbers total **0.9992 mm**, excluding mask. Keep that sum separate from nominal finished thickness. The page lists relative permittivity 4.1 for 3313 and 4.6 for core, and different mask heights over substrate and traces. It does not establish material frequency, loss tangent, process tolerances or a uniform-mask model. No supplier order or material qualification was made.

## Required toolbox work

The diagnostic copies enable four copper layers but deliberately retain the old two-layer physical-stackup declaration. **The existing stackup reader correctly rejects that mismatch. These files are not valid four-layer construction candidates and must not be used for fabrication or impedance calculation.** They isolate copper geometry and native DC connectivity only.

The implementation needs a coherent update across these boundaries before native adoption:

| Boundary | Current limitation / required change |
| --- | --- |
| [Board/net-class contract](../../../src/harness/pcb-design-contract.ts) | F.Cu/B.Cu enums; add explicitly ordered enabled layers and validate each net's allowed layers. Preserve existing two-layer bundle behavior. |
| [Construction declaration](../../../src/harness/pcb-interface-requirements.ts), [new-board seed](../../../src/harness/interface-construction-seed.ts) | One dielectric and two copper thicknesses only. Represent three distinct dielectrics and four copper layers; keep nominal fabrication thickness separate from the modeled layer sum. Do not invent missing material data. |
| [Plane/reference contract](../../../src/harness/pcb-design-plane-contract.ts) | Outer-only plane layers and access routing. Select each actual adjacent reference layer and retain protected service regions. |
| [Route mutation](../../../src/harness/fresh-plane-route-mutation.ts), [plane mutation](../../../src/harness/fresh-plane-mutation.ts) | Outer-only authoring/validation and native enum mapping. Check enabled layers and through-via participation on all four layers. Footprints and silkscreen remain on the outer faces. |
| [Native plane stage](../../../sidecars/patches/doc4/evleda_plane_stage/typed_zone.py) | Explicitly rejects internal layers. Qualify updated native capture, write, refill and save/readback in a new runtime; do not modify frozen host30/DOC14. |
| [Interface assessment](../../../src/harness/saved-interface-assessment.ts), compiler and acceptance | Two-layer construction assumptions. Compare all saved layers and use adjacent dielectric spacing; retain unsupported material/model findings. |
| Workspace revision | The qualified placement-revision tool cannot change construction, interfaces or routing requirements. A separate authenticated design/revision path is required; never rewrite the old bundle or canonical rules. |

After that support is qualified, reroute signals with the new reference layers, finish SW1 ground, remove obsolete ground stubs, revisit USB resistor/regulator placement, and repeat native DRC, connectivity, return-path and visual checks. This study does not establish complete routability or finish the component-placement work.

## Evidence and preservation

- [Source audit](source-audit.json): original geometry and all twelve published/managed source hashes unchanged; eight exact added inner leads; bounded inner-plane contours; explicit unsupported stackup status.
- [Four controlled comparisons](comparison.json), [final header-access result](ground-access-result.json), [final configured DRC](ground-access-drc.json).
- Initial failed API probes, the rejected proposal, scripts and all disposable native boards remain in `destination-verification/rp2350-four-layer-study-01` beside the repository. No managed session was opened, resumed or changed.

The current reference-geometry projection retains all 106 vias as unsupported straight-segment items; the audit separately compares their complete saved inventory. It does not convert that projection into full-board verification. DRC exclusions remain recorded in the reports. No production source changes or new authoring capability are claimed by this study.

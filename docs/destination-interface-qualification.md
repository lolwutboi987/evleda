# Destination interface qualification

The toolbox now has a completed native differential-interface fixture: authoring, saved-source checks, conditional section-impedance calculation, normal checkpoint/close and read-only reopen. Native attempt04 passed 46 recorded public operations. The earlier startup, planner and driver-assertion failures remain preserved; this result does not complete board/interface acceptance or the broader product goal.

## Native attempt04: authored pair and read-only reopen

The [original passing result](../../destination-interface-native-04/evidence/result.json), SHA-256 `b22f62194f86368117ad9d4e9084ff8c3906b425b3f073a1f78663bd3097891a`, used **scripted public MCP calls over linked InMemoryTransport with a real native STDIO sidecar**. It exercised 46 public operations, with 42 tools exposed during the fresh phase and 28 during read-only reopen. Both phases reported normal native close, checkpoint publication and no recovery requirement. This is a scripted capability demonstration, not global app installation or a fully autonomous prompt-to-board result.

The [native project](../../destination-interface-native-04/output/project/interface-pair-software-fixture.kicad_pro) has two footprints, six SMD pads, 12 tracks, two GND vias and one B.Cu plane. Its [PCB](../../destination-interface-native-04/output/project/interface-pair-software-fixture.kicad_pcb) is **18,516 bytes**, SHA-256 `565048e57bd021d1b05cc54b8bfeb6b6d865d5ee4dbb2356f94880e9ee8c3151`.

| Saved-source measurement | Result |
| --- | --- |
| Pair width / central edge gap | 0.4 mm / 0.3 mm |
| Central paired interval | 13.7 mm |
| Each complete route | `19.7 + 0.3√2` mm, approximately 20.1242640687 mm |
| Etch-length skew | Exactly zero; no delay-skew claim |
| Uncoupled length per member | `6 + 0.3√2` mm, approximately 6.4242640687 mm, within the declared 7 mm budget |
| Paired-interval model | 89.54317399767152 Ω at 100 MHz, within the synthetic 90 ± 10 Ω target |

Overall impedance remains **unassessed**: the section model does not cover bends, launches, uncoupled portions, physical reference continuity or the finite-thickness applicability condition. Material and termination assertions remain unverified physical inputs. `boardAccepted`, `interfaceAccepted` and `fabricationAuthorized` remain false.

Native endpoint checks reported DP, DN and GND connected. Configured native ERC/DRC collections were clean and DRC parity had zero findings; the reports retain their ignored-check lists. Complete ERC coverage remains unsupported because four default checks were ignored, and the plane check reported no direct thermal-pad witness. The fresh plane/interface assessment retained **12 passed / 27 unknown rows**; read-only reopen retained **3 passed / 36 unknown**, with no reconstructed fresh-fill witness.

The six saved source files, PCB identity, requirements, bundle, canonical DRU, profile, implementation and IPC inventory matched across reopen; interface geometry/results were retained. This does not claim that `.history`, checkpoints or all output files were unchanged. The [fresh top preview](../../destination-interface-native-04/evidence/fresh-top.png) and [assembly preview](../../destination-interface-native-04/evidence/fresh-assembly.png) were inspected. The top view does not display the B.Cu plane.

The [corrected independent artifact audit](../../destination-interface-native-04/evidence/audit.corrected.md) passes **68/68 required checks**; its [JSON record](../../destination-interface-native-04/evidence/audit.corrected.json) is SHA-256 `954469a9020b543d025fc81720c00f15fa6c696128bdc90a55f9ba6d10b2ea70`. The original 68/70 audit is preserved: two extra SVG byte-equality checks differed only in generated title timestamps. Both PNG pairs and every other SVG byte matched. The raw unequal SVG hashes remain recorded; no artifact was normalized or original native result rewritten.

A separate post-close, read-only CLI [schematic export](../../destination-interface-native-04/evidence/schematic-review/interface-pair-software-fixture.svg) shows three distinct labeled connections and separated reference/value text, with no obvious crossing or text collision in the recorded visual review. Its [source-preservation record](../../destination-interface-native-04/evidence/visual-review.json) is separate from the 46 MCP operations and grants no additional acceptance.

## Completed software milestone

The [combined focused suite](../../destination-verification/interface-product-01.json) passed **739 tests across 19 files, zero failed and zero skipped**. [Source/UI typechecking](../../destination-verification/interface-product-typecheck-01.log) and the [full product build](../../destination-verification/interface-product-build-01.log) passed separately. This is not a full-suite pass; the earlier failed full-suite record is preserved.

The build verified the unchanged DOC6 runtime: **8,467 files, 1,159 directories, 150,421,299 bytes**, tree identity `8ecf10a0781a7c5f8c31f690da917f6a162435602e4afbd443963f0025c340a9`. The existing Vite warning about chunks above 500 kB remained non-failing. Earlier native-helper and construction-serialization qualifications retain their separate scopes.

## Native attempt01: startup failure

The [original result](../../destination-interface-native-01/evidence/result.json), SHA-256 `85c18663966247c1960b510f5b85026f1c795bcb0d2cc6dc8a6c21d9d13f5ff6`, remains failed with **zero public operations**. Internal readiness, catalog discovery and `kicad_set_project` binding completed, but `bridge-revalidation` hit `kicad-verification-deadline`. Initial native Save and public session exposure did not complete. No pair authoring, public interface assessment or resumed native proof followed.

Bridge and host cleanup were recorded **unconfirmed**. The failed allocation, prepared marker/checkpoint, diagnostics and IPC allocation `e-Ohccr9` remain retained. The [post-exit audit](../../destination-interface-native-01/evidence/post-exit-audit.json), SHA-256 `e77804689a1df9b3f4866fe9c643b4e24bbc5b12e262e4310052a364620affeb`, observed no `pcbnew.exe`, `python.exe` or `pythonw.exe` at that instant. Process absence does not convert the recorded cleanup into confirmed cleanup or authorize reuse of the retained allocation.

The [source audit](../../destination-interface-native-01/evidence/source-audit.json) found `.pro` changed from **2,527 to 11,396 bytes** relative to preparation; the other five tracked sources were unchanged. The PCB remained **2,373 bytes**, SHA-256 `d269d2395b7cdcec2868f7bb32ec424d2d286bee2d4ec3ffd87222a3de564f61`, and the canonical DRU remained **329 bytes**, SHA-256 `ced868d3f65dc2a8dca55d1724ee4bac13fd017832f0d02436016a782cef132f`. Profile, intent and implementation checks were unchanged. This post-exit observation is not a successful initialization or checkpoint/resume validation.

## Bounded directory scheduling

The runtime walker now validates at most four directories concurrently before the existing four file readers start. Both complete scans still bracket native connection/project binding within the original 30-second budget. Ancestor, mode, directory inventory, file hash, physical witness and aggregate identity checks remain intact.

The [runtime-only comparison](../../destination-verification/runtime-directory-scheduler-01/comparison.json) observed factory time 8.884 to 7.306 seconds and revalidation 8.417 to 6.858 seconds. Every pass retained 20,861 directory operations and 192,705 file operations with the same bridge identity. These sequential, instrumented measurements can include cache effects; they are not native workflow qualification. The [complete runtime integration file](../../destination-verification/interface-runtime-integration-02.json) passed 115 tests. [Source/UI typechecking](../../destination-verification/interface-product-typecheck-02.log) and the [full rebuild](../../destination-verification/interface-product-build-02.log) also passed after this change.

## Preserved attempts02/03 and planner/driver repairs

Native attempt02 passed startup and initial native Save, then authored both connector symbols. Its [original result](../../destination-interface-native-02/evidence/result.json), SHA-256 `90a150a6bfb5da86fbc6d8aa532727d10c10263bff73cd2c4e0f7cd3233d25ed`, remains failed: the connectivity planner returned a nonmutating refusal and exhausted its existing placement-search budget. No pair routing or interface assessment followed. The six recorded public operations include normal failure finalization: editor close and checkpoint publication succeeded, recovery was not required, and the pre/post IPC inventory matched.

Pure replay isolated an interaction between outward global-label reservations and the wire planner's exterior-only detour channels. Facing pins alone and all six net-order permutations did not solve it with labels enabled. The implemented bounded fallback preserves successful legacy plans, then tries individual obstacle-edge channels and one physical ordering of label reservations. Future terminal stubs remain reserved; the wired-tree authority, collision checks and total work limit are unchanged. All authoring, placement, idempotency, field-cleanup and saved-state replay paths select the same complete label/wire plan. The [combined schematic/authoring regression run](../../destination-verification/interface-schematic-planner-03.json) passed 227 tests across seven files, with [source/UI typechecking](../../destination-verification/interface-product-typecheck-03.log) passing separately.

[Profile03 qualification](../../working-profiles/doc6-interface-profile-verification-20260910-03/report.md) admits the actual right-facing `Connector:Conn_01x03_Pin` source symbol against the unchanged three-pad SMD footprint. This changes schematic presentation, not PCB pin assignments or routing requirements. Its profile is 7,505 bytes, SHA-256 `19733a1995b09cc788b2138031d834199d2193a1dffa47ac8366c38149be5bd3`. The [full rebuild](../../destination-verification/interface-product-build-03.log) passed before attempt03; attempts01/02 remain preserved.

Native attempt03 completed connectivity authoring, native save, field repair and qualified synchronization of both footprints. Its [original result](../../destination-interface-native-03/evidence/result.json), SHA-256 `5ea7b7c32bd4cb10cf694a39ff429a2659c98f8da50e51fb9ed137a83ef2a831`, remains failed at a driver assertion: `fresh_get_contract_pad_positions` correctly exposes usable copper layers (`F.Cu`), while the driver expected technical mask/paste layers in that field. The ten recorded operations include normal failure finalization with checkpoint publication, no recovery requirement, and unchanged IPC inventory. It did not reach PCB placement or routing.

The script now checks `F.Cu` on the public authoring projection and separately verifies `F.Cu/F.Mask/F.Paste` in complete saved pad definitions. The [captured native projection](../tests/fixtures/native-interface-pad-positions-20260910-03.json) is regression-tested; [27 driver tests](../../destination-verification/interface-driver-copper-layers-04.json) and the script-specific TypeScript check passed. This correction changes no production tool or board requirement. The separate attempt04 above completes the native workflow without relabeling attempt03.

This is a local software milestone, not completion of the chat PCB-toolbox goal, GitHub publication or the requested RP2350 board. Physical material/termination evidence, return-path/model applicability and whole-board acceptance remain separate.

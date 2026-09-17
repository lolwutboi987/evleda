# Explicit external power inputs

Plane V2 can declare an off-board supply at existing connector pins through optional `externalPowerInputs`. The host binds and authors stock `power:PWR_FLAG` schematic annotations for those nets without adding physical components. This is a caller assertion of intended supply and return, not evidence that power is attached or that voltage, current, polarity or the circuit is suitable.

Native attempt10 now completes V2 external-power authoring, NC-correct import, preserving placement, routing, strict public DRC/parity checking, normal close and fresh read-only reopen on frozen DOC7. The edit-session plane report is **incomplete: 9 passed, 38 unknown, 0 failed**. Reopen correctly returns **47 unknown rows** without a current-session fill witness; both results retain `accepted: false`. Named-NC netclass/checkpoint support is V2 only; legacy V1 readers remain fail-closed for generated NC names. [DOC7 profile02 and the exact updated skill are now installed](destination-client-installation.md), with 15-tool preflight/fresh-CLI verification. Activation of the new profile in the running desktop remains unverified.

## Native attempt10 and remaining limits

The checked-in [WSON regulator proof](../examples/wson-regulator-toolbox-proof/README.md) includes the six native files, preview images and a portable qualification summary. Private session authority and machine-specific evidence remain outside that example.

The [saved candidate](../../destination-ic-design-10/authored-source-01/manifest.json) retains six footprints, nineteen physical primitives/seventeen logical terminals, eighteen tracks, six vias and one B.Cu GND zone. All three functional nets are connected. All six preserving placements passed, generic validation reported zero findings in its configured scope, and ten measured straight/45-degree junctions have no violations or unresolved cases. Final top/assembly views were reviewed as readable.

The [public plane report](../../destination-ic-design-10/mcp-session-01/workspace-client-02115c17-6d65-4100-b250-c535293fe441/000133-response-ee3586ae6e2292ede84b00cc16afbf81fdd53394597ad1d7997a01dacadde2b9.json) records zero strict DRC and schematic-parity findings, verified scoped thermal/clearance checks and a complete ten-bore inventory. Two GND connector bore/cached-hole relationships remain uncertain, alongside actual physical copper/thermal widths, complete contact continuity, ignored ERC categories and other mandatory rows. The result remains incomplete and fabrication is unauthorized; verified thermal-policy applicability is not measured thermal performance.

Project close and operator client exit 0 passed. The [06:00:38 UTC post-close observation](../../destination-ic-design-10/post-close-observation.json) records all six sources unchanged and no lease, unsafe marker, locks or native processes. The retained PCB is 37,173 bytes.

Fresh read-only reopen passed with the same bundle, all three functional nets connected and every eligible physical member reachable, and a byte-identical top PNG. Its [read-only plane report](../../destination-ic-design-10/mcp-readonly-01/workspace-client-62ecf522-a110-4e2b-ac04-6cf2470206f4/000044-response-7ceb102eb8b70282d83b1d993c9985e15170b59dd56f954274517dce81435845.json) is correctly incomplete with 47 unknown rows and `accepted: false`, because no new session fill witness exists. This does not reinstate the prior edit-session passes. Project/client close passed normally with operator exit 0; the [06:09:20 UTC observation](../../destination-ic-design-10/post-readonly-close-observation.json) confirms all six sources unchanged and no lease, unsafe marker, locks or native processes.

## Declare intent before creating the project

Read `evleda_design_schema` with `{"family":"plane-v2"}`. Add the following fragment to a complete `evleda.pcb-design-intent-draft.v2` draft only when the user specifies an external supply:

```json
{
  "externalPowerInputs": [
    {
      "id": "INPUT",
      "supplyEndpoint": { "reference": "J1", "pin": "1" },
      "returnEndpoint": { "reference": "J1", "pin": "2" }
    }
  ]
}
```

This fragment assumes the physical connector already exists: `J1:1` belongs to a net with role `power_input`, and `J1:2` belongs to a different net with role `ground`. Preserve those exact assignments in the component pins and net endpoints. The declaration does not create the connector or either net.

The [schema and binding implementation](../src/harness/pcb-external-power.ts) and [model guide](../src/harness/pcb-design-plane-model-guide.ts) require:

- One to eight entries with unique IDs. Each endpoint is exactly `{reference,pin}` and resolves to an approved physical connector pin.
- Distinct supply/return endpoints and nets, exact existing net assignments, and no no-connect endpoints. A supply net has one declaration; multiple supplies may share a return net.
- Explicit unresolved values: the whole requested extension or either endpoint may be `null` in a draft, but all unknowns must resolve before closure. A keyed clarification path can be `/externalPowerInputs/INPUT/supplyEndpoint`.
- Omission when external power was not requested. Do not replace an omitted field with `null` or `[]`; an empty array is invalid. Voltage or other extra properties are not accepted in this extension.

Submit the complete draft through the ordinary workspace flow, inspect clarification or ready results, then create using the returned `draftId`. Inspect `evleda_design_context` after attachment. See [toolbox workflow](toolbox.md) and the [PCB skill](../skills/evleda-pcb/SKILL.md) for the surrounding lifecycle.

## What the host adds and preserves

The compilation bundle carries a separate `externalPowerBinding` with the approved stock symbol's source, definition, inspection and policy identities. The host derives one canonical `#FLG` annotation per unique declared supply or return net, including only one annotation for a shared return. `fresh_apply_contract_connectivity` authors these annotations and their wiring within the bound project.

The flags have no footprint. They add no physical BOM items, netlist terminals, PCB pads or routing endpoints; the physical component/library inventory and connectivity contract remain intact. Do not put flags or fake power drivers in `components`, assign them footprints, or add their pins to physical nets. The [saved-source verifier](../src/harness/fresh-external-power.ts) validates the complete approved flag inventory, embedded source, placement and exact native flag-pin groups before excluding those annotations from physical comparisons. Unexpected auxiliary symbols, missing or altered flags and source drift remain errors.

Support is limited to this explicit V2 connector declaration and the qualified stock flag form. It does not infer a source from names such as `VIN`, support arbitrary driver symbols or nonconnector anchors, retrofit intent by editing a saved bundle, or validate an off-board source's electrical characteristics. Native ERC remains required. A power-pin error must be investigated, never suppressed or hidden behind an invented declaration.

## Qualified native graph and import

DOC6's graph reader could merge distinct supply and ground nets through the flag Value while omitting the flag pins. DOC7 keeps those groups separate and retains their actual `#FLG...:1` membership. Its [runtime note](../sidecars/doc7-runtime.md) and [patch qualification](../sidecars/patches/doc7/README.md) describe the exact supported source form and retained evidence.

The [native session](../src/integrations/kicad-mcp-session.ts) requires the exact qualified `sch_get_connectivity_graph` descriptor and metadata, graph-read authority, and an open, bound, healthy session. This capability is separate from write permission. Old readers remain available for ordinary unannotated reads; they do not gain annotated connectivity authority. `EXTERNAL_POWER_CONNECTIVITY_CAPABILITY_UNAVAILABLE` requires an appropriate host runtime/profile, not model-supplied evidence or a bypass. Source checks, saved readback, complete connectivity checks and independent native ERC still apply.

DOC8 retained that graph qualification but stripped KiCad's generated singleton NC net during PCB import. This satisfied the earlier host's netless-NC contract, then failed strict schematic parity in attempt07. The [DOC8 runtime note](../sidecars/doc8-runtime.md) and [historical producer contract](../sidecars/patches/doc8/README.md) preserve that failed approach and its narrower offline tests. A successful frozen-runtime integrity check does not establish functional parity.

### Current intentional-NC handling

The [native-terminal binding](../src/harness/fresh-native-terminal-binding.ts) qualifies NC identity from complete typed native-netlist parity and current source/library scope, including exact component identities, functional nets and declared NC terminals. It retains the actual generated name; an `unconnected-...` prefix alone grants no authority. In `fresh_get_contract_pad_positions`, NC selection reports semantic `net: null`, `disposition: "no_connect"` and the preserved `nativeNetName`, with no routing candidates. Never route the generated NC net, strip its name or add it as a functional contract net.

Select `plane-v2` for designs requiring named-NC netclass/checkpoint support when the host advertises that family. The current V2 [netclass reader](../src/harness/fresh-plane-netclasses.ts) carries the qualified semantic distinction into saved-state checks. Legacy V1 readers still reject generated NC names; report that unsupported lifecycle rather than assuming the same capability there.

Raw named/netless physical counts are separate from functional/NC counts: a native-named NC pad is still semantically no-connect. Repeated physical pads belonging to the same logical NC terminal are allowed only on its exact qualified native name. The host rejects NC tracks, vias, zones, other logical terminals and foreign native PAD reachability, and keeps complete physical inventory and isolation checks. The [387-case focused report](../../destination-verification/native-nc-compatibility-01/focused-20260916-implementation-final-01.json) passed; its [completion record](../../destination-verification/native-nc-compatibility-01/focused-20260916-implementation-final-01-completion.json) confirms exit 0 and stable source hashes. The [retained WSON comparison](../../destination-verification/native-nc-compatibility-01/actual-wson07-comparison.json) is offline evidence. Neither is a new native board pass.

The current stock-pad correction preserves `pad_prop_heatsink`, validates supported `zone_connect` values, and retains complete bore inventories. Thermal applicability first requires verified copper on the selected plane layer: an F.Cu-only exposed-pad override is not applicable to a B.Cu plane. Applicable overrides remain limited, and malformed/unknown fields still reject. The separate [native-check](../tests/unit/fresh-plane-native-checks.test.ts) and [drill-topology](../tests/unit/fresh-plane-drill-topology.test.ts) run passed 180 tests; its result was retained in tool output, not a JSON receipt. The earlier [source/UI typecheck](../../destination-verification/native-nc-compatibility-01/integrated-typecheck-01.log) and [integrated build](../../destination-verification/native-nc-compatibility-01/integrated-build-01.log) passed, but did not catch attempt08's later mutation-stage failure.

### Attempt08 phase failure and correction

[Attempt08](../../destination-ic-design-08/assessment.md) imported nineteen physical primitives and seventeen logical terminals: raw native naming was 17 named/0 netless, while semantic disposition remained sixteen functional terminals and one NC. U1.5 retained its exact native name, semantic `net: null`, `no_connect` and zero routing candidates. All six placements and post-placement inventory passed. The first VIN route failed at post-Push source readback with the combined NC source/marker guard error. History autosave is a reproduced candidate cause; the original failing operand was not recorded, so exact causation remains unproved.

Normal close failed. Two exact-project captures through the deployed checked reader retained identical live PCB snapshots with seven VIN tracks; the saved board remains at zero tracks/vias/zones. Only verified owned processes were then stopped. Saved files are unchanged, and the lease, unsafe marker and locks remain. The snapshots and process stop establish neither accepted route persistence nor normal cleanup. Final native parity, NC isolation, plane checks and reopen were not reached.

The host now carries a qualified NC binding through unsaved route and plane stages while separately guarding exact non-PCB sources, marker, library identities and the saved PCB preimage. Derived history-PCB autosaves do not authorize schematic assignments. Fresh native qualification after Save remains mandatory. All 17 new regressions passed, followed by [81 tests across the two affected files](../../destination-verification/native-nc-compatibility-01/staged-nc-full-files-01.json). A separate [two-literal encoding repair](../../destination-verification/native-nc-compatibility-01/encoding-repair-01.json) restored corrupted truncation text, followed by [219 harness/text/public-contract passes](../../destination-verification/native-nc-compatibility-01/bounded-text-and-harness-01.json). Full [source/UI typechecking](../../destination-verification/native-nc-compatibility-01/integrated-typecheck-02.log) and [build](../../destination-verification/native-nc-compatibility-01/integrated-build-02.log) passed. These scopes overlap and are not summed.

### Attempt09 reader failure and V2 correction

[Attempt09](../../destination-ic-design-09/assessment.md) subsequently routed/saved the candidate and verified NC isolation and independent strict CLI parity, but its public plane assessment and checkpoint close rejected the generated NC name in a shared grammar reader. No plane result or normal cleanup is inferred; its lease and unsafe marker remain retained. The V2 reader correction passed [95 lifecycle tests](../../destination-verification/native-nc-compatibility-01/reader-nc-lifecycle-recheck-20260916-02.json), a separate [46-case final netclass scope](../../destination-verification/native-nc-compatibility-01/reader-nc-partial-inventory-20260916-03.json), and the [actual09 offline semantic replay03](../../destination-verification/native-nc-compatibility-01/native09-semantic-reader-offline-03.json). Full [source/UI typecheck03](../../destination-verification/native-nc-compatibility-01/integrated-typecheck-03.log) and [build03](../../destination-verification/native-nc-compatibility-01/integrated-build-03.log) passed. These scopes are distinct and do not extend the named-NC lifecycle to V1. Native attempt10 above uses unchanged [DOC7 profile02](../../working-profiles/toolbox-native-doc7-stock-catalog-destination-02.json); earlier failures remain unchanged.

### Earlier qualification

The retained [307-test software report](../../destination-verification/external-power-integration-01.json) covers the selected compilation, workspace, preparation and diagnostic suites. The [251-test contract report](../../destination-verification/external-power-native-contracts-01.json) covers parser/planning and native-session contracts, including actual DOC7 closure checks and controlled host fixtures. The [build log](../../destination-verification/external-power-build-02.log) records a completed build. These are scoped results; their counts do not establish overall coverage or a passed annotated native board workflow.

The subsequent [mutation-result regression record](../../destination-verification/external-power-result-contract-20260916.json) reports 287 passing tests across seven focused files, including 30 public MCP cases, with a source typecheck and [rebuilt DOC7 host](../../destination-verification/external-power-build-03.log). This repairs the response boundary exposed by [attempt03](../../destination-ic-design-03/assessment.md). [Attempt04](../../destination-ic-design-04/assessment.md) subsequently passed public connectivity and native save/readback, then failed because the earlier host rejected KiCad's native NC assignment. DOC8 removed that assignment to satisfy the old host, but attempt07 showed that this breaks strict parity. These failed records and their recovery boundaries remain preserved.

[Attempt05](../../destination-ic-design-05/assessment.md) passed DOC8 import and normal close, but ordinary footprint movement lost the heatsink property and 3D-model data; routing did not proceed. [Attempt06](../../destination-ic-design-06/assessment.md) used preserving placement and retained that metadata, but its first capacitor rotation failed solely on the native ordering of two complete `F.SilkS` line forms. The final planner reproduces that ordering without a comparator exception or numerical-tolerance change; its [72-case manifest](../../footprint-placement-order-qualification-20260916/run-02/manifest.json) qualifies disposable native file load/save, not a completed live board workflow.

## Routed native candidate and remaining limits

[Attempt07](../../destination-ic-design-07/assessment.md) completed all six preserving placements, including C1, C3 and C2 at 270 degrees. Exact pad observation retained seventeen logical copper terminals: sixteen net-bound and one intentional NC, plus both paste apertures for nineteen physical primitives. All three declared nets report connected with every eligible physical member reachable. Native top/assembly views were visually reviewed as readable. The final saved board has eighteen tracks, six vias and one B.Cu GND zone.

The [configured validation](../../destination-ic-design-07/mcp-session-01/workspace-client-2a62eb43-e272-4294-861e-5f0186c87eba/000152-response-0461affded4c6ea0ea6684091d5845ace7113b482a2ca65fc51d17c808a5a7ed.json) reports zero ERC/DRC violations, unconnected items and courtyard issues within its configured scope; generic `run_drc` did not establish strict schematic parity. Ten measured straight/45-degree junctions have zero violations and zero unresolved findings. An earlier three-way C3 input branch was unresolved by the turn checker; changing the board route to a sequential C3-IN-EN chain resolved that finding. The first validation remains intermediate evidence. These ignored categories remain explicit:

- ERC: `single_global_label`, `four_way_junction`, `simulation_model_issue`, `footprint_filter`.
- DRC: `missing_courtyard`, `track_not_centered_on_via`, `tuning_profile_track_geometries`, `footprint_filters_mismatch`, `footprint_type_mismatch`.

The authoring session closed normally with client exit 0 and no retained lease, unsafe marker or native process. A [fresh read-only session](../../destination-ic-design-07/mcp-readonly-01/) exposed 37 read-only tools, reopened the same bundle, repeated the exact pad inventory and all-net endpoint results, and reproduced the exact top PNG. It also closed normally with exit 0. All six [authored source identities](../../destination-ic-design-07/authored-source-01/manifest.json) stayed unchanged.

The first public plane-acceptance call failed on two stale exact Windows WinSxS dependency paths. That failure remains preserved. A [separate dependency repin and production-reader qualification](../../destination-verification/plane-system-dependency-repin-20260916/README.md) accepted two exact current Microsoft-signed paths while preserving the 117-file runtime closure and 44 other system paths. A separately pinned DOC8 profile changes only that manifest pin. A third session resumed the same project without checkpoint editing and reapplied/saved GROUND with the same PCB source.

The subsequent [public plane assessment](../../destination-ic-design-07/mcp-reassessment-01/workspace-client-c5c7c303-3165-45fa-9966-45c57bacafde/000055-response-4a0703135aafd025cc4a073f179145204542a592e1ee18ce61b3f2abb88b0746.json) executed successfully but returned **failed: 8 passed, 3 failed and 36 unknown rows**. `plane-clearance:GROUND`, `plane-policy:GROUND` and `drc` failed. Strict native CLI checking found one `net_conflict` schematic-parity warning on U1 pad 5: the PCB pad is netless while KiCad exports a generated NC net. Ordinary copper violations and unconnected items remain zero. The stock U1 exposed pad 7 retains `pad_prop_heatsink` and `zone_connect 2`; these produce unsupported source-field and thermal-override findings in the current plane assessor. Its zero-bore inventory is incomplete after that parser rejection, not evidence of a board without drills.

All three attempt07 sessions closed normally with client exit 0, unchanged six-file sources and no retained lease or unsafe marker. The public result keeps `accepted: false` and `fabricationAuthorized: false`. The subsequent host corrections above have not been applied to or requalified on this retained candidate. Do not remove stock metadata, suppress parity or promote connected native endpoints into full plane acceptance. DOC8 is not recommended for intentional NCs; attempt08's route/cleanup failure, attempt09's reader/close failure and attempt10's incomplete assessment retain their separate scopes. Global migration has not occurred.

## Keep the first CLI failure

If the pinned KiCad CLI version or commit probe fails its exact transcript policy, inspect the first failure before retrying startup. The [probe capture](../src/flux/pcb-editor-launcher.ts) retains the failed arguments, expected stdout, exit code, stdout and stderr. The [private diagnostic writer](../src/mcp/toolbox-cli-probe-diagnostics.ts) writes an exclusive `startup-diagnostic-cli-probe-<uuid>.json` in the owned output directory; the public error exposes its filename and content hash. It does not copy the runner environment, executable path or input into that diagnostic.

Diagnostic publication failure preserves the original error. A runner timeout or uncertain process termination is not converted into a fabricated transcript. Keep uncertain project/startup state for host review; do not erase evidence or relax the identity policy to continue. [Focused tests](../tests/unit/toolbox-cli-probe-diagnostics.test.ts) cover these boundaries.

## Interactive local client

The optional [workspace client](../scripts/toolbox-workspace-client.ts) sends operator-selected JSON-line commands to the already-built workspace host. It requires an approved profile's exact pin, an existing workspace root and an evidence directory:

```powershell
node --import tsx scripts/toolbox-workspace-client.ts --profile <file> --profile-sha256 <sha256> --profile-bytes <bytes> --workspace-root <existing-dir> --evidence-dir <dir> --edit
```

Omit `--edit` for read-only access. Keep stdin open and send one complete line per action, with a unique ID:

```json
{"id":"tools-1","operation":"tools"}
{"id":"status-1","operation":"call","name":"evleda_workspace_status","arguments":{}}
{"id":"schema-1","operation":"call","name":"evleda_design_schema","arguments":{"family":"plane-v2"}}
```

The client does not build, retry, refresh tools or execute a board workflow automatically. It retains full responses and raw received MCP messages; when stdout says `payloadOmitted`, read the referenced evidence file. Refresh tools explicitly after attachment. Call `evleda_close_project` for the active ID and inspect its result before `{"id":"close-1","operation":"close"}`; client close refuses a non-idle workspace. EOF or signals request SDK shutdown without proving native cleanup.

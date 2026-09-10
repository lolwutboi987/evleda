# Evidence dossier: BGA PCB layout and escape routing

**Research date:** 2026-09-06  
**Required article:** JLCPCB, *BGA PCB Design Complete Guide: Layout and Routing Guidelines* (published and updated 2026-07-15)  
**Audience:** PCB layout engineers, reviewers, and engineering agents deciding whether a particular BGA can be escaped, fabricated, assembled, inspected, tested, and reworked.  
**Decision:** Determine the evidence and inputs required to turn a specific package ball map into a released layout.  
**Scope:** Rigid PCB land patterns, BGA fanout, PTH/blind/microvia/VIPPO structures, stackup and breakout planning, SI/PI, assembly, inspection, rework, and DFT. This is not a land pattern for an unnamed component, a quotation from a fabricator, or permission to use minimum features.  
**Evidence key:** **High** = current first-party component documentation, an official standard scope/status page, or a current fabricator capability page directly supports the claim. **Medium** = a first-party application note limited to its packages, a vendor engineering article, or a transparent calculation. **Low** = a useful heuristic that still requires project evidence.  
**Mandatory boundary:** Every numerical rule in this dossier is source-scoped. A component maker's example is not a fabricator capability; a fabricator minimum is not a yield recommendation; an IPC document is not a component datasheet; and DRC completion is not proof of assembly or field reliability.

## Direct conclusion

A BGA cannot be routed safely from pitch alone. Release requires, in order:

1. the exact orderable part and package revision, mechanical drawing, ball map, and device layout/assembly guidance;
2. a classified ball map showing every signal, power/ground domain, no-connect, reserved ball, differential pair, timing group, current path, test function, and allowed pin swap;
3. the fabricator's quoted stackup and **written** capability for the exact trace/space, finished hole, pad, annular ring, registration, mask web, fill/cap/planarity, sequential-lamination, backdrill, impedance, material, copper weight, and quality class;
4. the assembler's approval of land/mask/paste geometry, stencil, via protection, component clearances, reflow/warpage plan, X-ray coverage, rework access, and acceptance criteria;
5. an escape proof that accounts for copper lands, via pads and antipads, clearances, number of channels, plane continuity, decoupling, test access, and the interface timing/impedance budgets; and
6. fabrication, assembly, electrical, SI/PI, thermal, and DFT checks appropriate to product risk.

The JLCPCB article is a useful planning survey: decide NSMD/SMD before routing, select a pitch-appropriate fanout, co-design underside decoupling with escape vias, preserve return paths, use interface-specific timing rules, and perform fab-specific DFM. It is not a release specification. In particular, its pitch table and layer-count ranges are heuristics, its “match within mils” statement supplies no interface budget, and its current HDI advice conflicts with JLCPCB's own capability page, which says blind/buried vias are not supported. The article also overstates IPC-7095 as an acceptance source: the [IPC-7095E table of contents](https://www.ipc.org/TOC/IPC-7095E_toc.pdf) says it is BGA implementation guidance and directs assembly accept/reject decisions to IPC J-STD-001 and IPC-A-610.

## 1. What the required JLCPCB article contributes

The [required JLCPCB article](https://jlcpcb.com/blog/bga-pcb-design-complete-guide-layout-and-routing-guidelines) contributes the following useful ideas, retained with their proper limits:

- Decide whether lands are solder-mask-defined (SMD) or non-solder-mask-defined (NSMD) before fanout. The choice changes copper diameter, mask registration, wetting, mask-web feasibility, routing space, and assembly behavior.
- Treat pitch as an early process discriminator: the article proposes ordinary dog-bone/PTH escape for many 0.8 mm packages; tighter rules or selective via-in-pad at 0.65 mm; via-in-pad or HDI at 0.5 mm; and microvia/HDI planning at 0.4 mm. These are **screening heuristics**, not permissions.
- Estimate routing channels and stackup before placement. The article suggests 4 or 6 layers as candidates for 0.8 mm and 6, 8, or HDI for 0.5 mm, but the ball-map depth, depopulation, P/G population, routing directions, reference planes, and actual via field decide the result.
- Orient the BGA so dense interfaces face their destinations and expensive layer changes are minimized. This is sound placement practice, but mechanical, thermal, pin-swap, memory-topology, and connector constraints can override it.
- Co-design fanout and bottom-side decoupling. A via field that is “finished” before capacitors are placed can make low-inductance connections impossible.
- Keep high-speed traces over continuous reference planes; minimize transitions; provide a nearby return path at signal-layer changes; and tune timing outside the dense escape region.
- Reserve minimum trace/space for the BGA field instead of applying it to the whole board.
- DFM-check trace/space, pad-to-trace clearance, mask openings/webs, via hole/pad and annular ring, via fill/cap notes, silkscreen, and controlled impedance using the selected manufacturer's rules.
- Plan X-ray, rework, and respin risk because the joints are hidden.

### Claims that must not be generalized

- The article's 0.8/0.65/0.5/0.4 mm table is a JLCPCB-oriented heuristic. The package may have an irregular pitch, mixed ball sizes, partial matrix, land-side components, escape corridors, or device-specific restrictions.
- “0.5 mm typically needs via-in-pad” is not universal. NXP published a particular 0.5 mm LFBGA320 through-via escape, while many other 0.5 mm full arrays cannot use that geometry. Conversely, electrical or assembly constraints can justify VIPPO even at larger pitch.
- “ENIG is better” is not a universal finish selection. JLCPCB currently requires ENIG for its 0.20–0.25 mm BGA-pad service case; NXP lists OSP, HASL, nickel/gold, and immersion silver as compatible with the particular FCPBGA family, while warning that HASL can be uneven. Component, fab, assembler, storage, reliability, and finish-thickness requirements decide.
- “Place the largest capacitors under the BGA” is not a universal ordering rule. Mounting-loop inductance, capacitor package, capacitance/ESR/ESL, anti-resonance, target impedance, on-package/on-die capacitance, and the device vendor's PDN model decide. Use the device's current hardware guide or a validated PI model.
- “Match within mils” has no engineering meaning without a time/skew budget and propagation model. Match only the nets and reference points required by the exact interface specification.
- A current web page saying “supported” is not a lot-specific quotation. Obtain a stackup and DFM approval tied to the job.

## 2. Pre-layout input contract

Do not make a footprint, choose layers, or select a via architecture until the following inputs are resolved.

### 2.1 Exact component and package inputs

| Required input | Required evidence | Why escape depends on it | Stop if missing |
|---|---|---|---|
| Orderable manufacturer part number, silicon/package revision, temperature/quality grade | Current datasheet/orderable-parts table | Similar names can use different packages, ball maps, or electrical limits. | Yes |
| Package designator and JEDEC outline, body X/Y/Z, pitch in X/Y, row/column naming, A1 marker and bottom-view/top-view convention | Mechanical/package drawing | Prevents mirrored maps, wrong origin, wrong courtyard, and wrong land pitch. NXP notes that A1 may be shown by a top marker and/or a depopulated bottom corner. | Yes |
| Ball-map file/table for the exact package | Datasheet/package pinout, preferably machine-readable plus human-reviewed drawing | Supplies actual row depth, depopulation, escape corridors, P/G distribution, and pin-swap candidates. | Yes |
| Ball diameter, package-side SMD land opening, coplanarity and package substrate details when supplied | Package drawing/assembly guide | Board copper diameter must be related to package land geometry and solder-joint target, not pitch alone. | Yes for footprint release |
| Manufacturer PCB land, mask, paste, finish, stencil, via, keepout, warpage, underfill, and reflow recommendations | Package application note and device hardware guide | Package-specific guidance overrides generic family guidance. NXP explicitly gives package information precedence over its family application note. | Yes if the maker publishes it |
| Solder alloy, MSL/peak-package-temperature classification, storage/bake rules | Label/material declaration, J-STD-020 classification, package guide | Drives handling and reflow/rework limits. | Yes for assembly release |
| Land-side capacitors or exposed structures | Mechanical drawing | May forbid traces or require solder mask under the package. AMD documents package-specific land-side-capacitor mask/clearance rules. | Yes where present |

### 2.2 Electrical classification of every ball

Transform the raw ball map into a reviewed table. No ball may remain merely “unrouted.” Record:

- net name and function;
- I/O bank and voltage domain;
- power rail or ground type and estimated DC/transient current responsibility;
- `NC`, `DNC`, `RESERVED`, boot strap, analog reference, thermal/ground, or mechanical function exactly as the manufacturer defines it;
- differential mate, polarity, target impedance, intra-pair skew, pair-to-pair or group matching class;
- memory byte lane, DQS group, clock/address/control group, source/sink and topology;
- edge rate/data rate, loss budget, maximum vias/stubs, termination and AC-coupling requirements;
- package-internal delay/length data when the vendor supplies it;
- legal pin swaps and the tool flow that will back-annotate them;
- test mode/JTAG/boundary-scan coverage and required external access;
- decoupling quantity/value/rail and any sense/remote-feedback connection; and
- routing priority and “must not share via” constraints.

**Rule:** `NC` and `DNC` are not synonyms, and an unconnected schematic pin is not permission to attach copper. Reserved and analog/thermal balls require the exact datasheet treatment.

### 2.3 Board, fabrication, and assembly inputs

Obtain a written fabrication proposal containing:

- board outline, finished thickness/tolerance, layer count, copper weights, laminate and glass styles, finished dielectric thicknesses and material properties;
- controlled-impedance layers, target/tolerance, coupon method, and whether the fab will adjust artwork;
- minimum **recommended and absolute** outer/inner trace/space for the selected copper, plus local BGA exceptions;
- mechanical drill, laser drill, finished-hole and tolerance; pad/capture-pad and antipad; hole-to-copper; registration; breakout allowance; plating thickness; maximum qualified aspect ratio;
- PTH, blind, buried, skip, core, stacked, and staggered via structures actually offered for that stackup, including sequential-lamination count;
- via-fill material, IPC protection type or equivalent construction, cap copper, dimple/protrusion and planarity limits, finish, and which data layers/notes invoke the process;
- solder-mask registration, expansion, minimum web by color/copper/finish, LDI limits, and mask clearance to traces;
- backdrill start/stop layers, stub tolerance, drill oversize, and residual dielectric/copper clearances;
- quality/performance class, acceptance standard/revision, coupons, lot sampling, electrical test, microsections, and reflow/IST-style qualification where risk requires it; and
- panelization, bow/twist, surface finish, impedance and HDI price/lead-time consequences.

Obtain assembler approval for:

- paste alloy/type, stencil thickness and BGA apertures, step stencil conflicts, paste inspection and cleaning;
- placement accuracy/force, bottom-side component height and nozzle clearance;
- thermal profile developed on the real assembly, package/top and joint thermocouple locations, MSL controls, maximum reflow excursions, and board/package warpage risk;
- pad/mask style consistency, via-in-pad fill/cap/planarity, solder-wicking and void criteria;
- AOI/SPI/2-D or 3-D X-ray/CT coverage, defect definitions, sampling, electrical test, and acceptance criteria;
- underfill/edge-bond/coating access if required;
- rework keepout, bottom heater/thermocouple/vision access, adjacent-component exposure, allowed rework count, and disposition of removed parts; and
- test-point, fixture, boundary-scan, programming, and functional-test access.

## 3. Geometry model and feasibility equations

These equations are preflight checks, not substitutes for fab DFM.

### 3.1 Straight channel between adjacent circular lands

For pitch `P` and copper-land diameter `D`, the nominal edge-to-edge corridor is:

```text
G_land = P - D
```

For `N` traces of width `W` with uniform clearance/spacing `C`, a simple straight corridor requires:

```text
N*W + (N+1)*C <= G_land
```

Thus one trace requires `W + 2C`; two require `2W + 3C`. This does **not** include etch/registration tolerances, mask clearance, teardrops, pad exits, differential coupling, trace-angle effects, or the obstruction created by escape-via pads.

On an inner layer, repeat the check between via pads or plane antipads using the actual diameter on that layer:

```text
G_via = via_pitch - D_obstruction
```

`D_obstruction` may be the capture pad, antipad, or a larger keepout. Use the largest geometry that constrains the proposed layer.

### 3.2 Nominal annular ring and aspect ratio

```text
Nominal radial annular ring = (land diameter - hole diameter) / 2
Via aspect ratio = drilled depth / drill diameter
```

Both terms need supplier definitions. Some suppliers quote drill diameter; others emphasize finished hole. Finished minimum annular ring must include drill wander, image registration, plating, etch, and the applicable acceptance rule. A CAD nominal ring that passes the formula can still break out after tolerance. A minimum drill diameter on a capability table does not establish that diameter through every board thickness.

### 3.3 Pad-exit and neck-down rule

Neck down only where the pad field mathematically requires it:

1. start with a centered, symmetric exit that preserves the copper land;
2. maintain the required pad-to-trace and trace-to-adjacent-pad clearances;
3. use the shortest manufacturable neck-down, then return to the impedance-qualified width after clearing the obstruction;
4. keep differential exits geometrically symmetric and include the pad/neck/via transition in the SI model when edge rate warrants it;
5. avoid acute copper slivers and mask dams that the fab cannot register; and
6. never “shave” a library pad or via locally without revising the controlled footprint/constraint record and obtaining component/fab/assembler approval.

The article is right to keep minimum features local. NXP likewise advises using a small-feature rule area around the BGA and larger rules elsewhere in [AN10778](https://www.nxp.com/docs/en/application-note/AN10778.pdf).

## 4. Land pattern: NSMD versus SMD

### 4.1 Physical distinction

- **NSMD (copper-defined):** the mask opening is larger than the copper land, exposing the top and edge of the land. It usually offers predictable copper geometry, sidewall wetting, and more copper-to-copper routing space.
- **SMD (mask-defined):** solder mask overlaps a larger copper feature so the mask aperture defines the solderable area. It can mechanically anchor very small copper features or support particular drop/strain behavior, but it is more dependent on mask registration and the assembler's stencil/process.

NXP's MCU-specific [AN10778](https://www.nxp.com/docs/en/application-note/AN10778.pdf) recommends NSMD PCB lands, reports typical mask-to-land clearance of 0.060–0.075 mm depending on PCB maker alignment, and for its listed packages recommends PCB NSMD lands about 10–15% smaller than the package's SMD land to balance joint stress. Those percentages are **not universal library rules**. NXP's newer [flip-chip BGA assembly guide AN13656](https://www.nxp.com/docs/en/application-note/AN13656.pdf) generally recommends matching PCB solderable diameter to the package pad, permits up to a 10% board-pad reduction when routing requires it, recommends NSMD for most applications, and says package-specific information takes precedence.

AMD's current [Versal BGA rules](https://docs.amd.com/r/en-US/am013-versal-pkg-pinout/Recommended-PCB-Design-Rules-for-BGA) suggest NSMD lands and publish package-specific copper/mask values. AMD and NXP both warn against casually mixing SMD and NSMD on one BGA because assembly defects can result. NXP notes NSMD is commonly selected for thermomechanical fatigue and SMD for improved drop performance; therefore “NSMD is stronger” is too broad.

### 4.2 Footprint release checklist

- Compare the exact manufacturer land table/drawing to the library, ball by ball.
- Verify A1, view convention, row-letter omissions, depopulated sites, non-square pitch, mixed ball sizes, and body-to-array offsets.
- Record copper land diameter, mask opening, paste aperture, finish, courtyard, body and height, orientation marks, land-side-component keepout, assembly and rework keepouts.
- Use a package-specific paste rule. Do not assume paste is always 1:1. NXP AN10778 lists cases where paste diameter equals the land and fine-pitch cases where it is 0.02 mm larger; AN13656 discusses equal/slightly reduced apertures for other FCPBGA cases. These examples prove that paste design is package/process-specific.
- Do not mix pad styles or VIPPO/non-VIPPO lands unless the component maker explicitly calls for it and the assembler has validated stencil/reflow. AMD warns that mixed isolated VIPPO/non-VIPPO structures can produce hot-tear defects due to local Z-expansion differences.
- Require library peer review and a 1:1 plot or independent coordinate comparison before release.

## 5. Escape architecture

### 5.1 Dog-bone/adjacent-via fanout

Use a short trace from the BGA land to an interstitial via when pitch and fab rules allow it. Benefits are lower cost, process maturity, no solder ball sitting on a via, and easier separation of the assembly land from the drilled structure. Costs are top-layer real estate, a pad/trace discontinuity, via stub, reduced mask-web area, and possible obstruction of routing channels or underside capacitors.

For the particular 0.5 mm package-on-package study in [TI SPRABB3](https://www.ti.com/lit/an/sprabb3/sprabb3.pdf), TI calls an adjacent dog-bone preferable when space permits because it avoids via-in-pad voiding mechanisms. It gives a source-specific recommendation that the connecting segment be at least 0.005 in (0.127 mm) to impede solder flow and permit a mask dam, and says below 0.003 in (0.0762 mm) mask coverage risks encroaching on the solder land. These are **not global dog-bone dimensions**; modern mask registration, the selected land, and assembler process control.

Dog-bone rules:

- point fanouts outward in a repeatable pattern that creates orthogonal routing channels;
- keep P/N exits and transition-via geometry symmetric;
- tent/cover vias on the component side when approved so paste/flux does not migrate;
- avoid thermal-relief spokes on short BGA P/G fanouts unless a package/assembly analysis requires them;
- account for via antipads and nonfunctional pads on every routing/reference layer; and
- reserve underside capacitor sites before filling the entire array with through vias.

### 5.2 Via-in-pad and VIPPO

An open through via in a BGA land can wick solder, trap/release gas, create a depression, and produce inconsistent solder volume. For ordinary PTH via-in-pad, require a documented filled, planarized, and copper-capped construction, commonly called VIPPO. [AMD UG1099](https://docs.amd.com/r/en-US/ug1099-bga-device-design-rules/Fabrication-Technologies) describes via-in-pad as a density/SI/thermal tool but explicitly requires specialized fill/plating to create a flat solderable pad. [NXP AN13656](https://www.nxp.com/docs/en/application-note/AN13656.pdf) says fully or partially open via-in-pad can produce voids and inconsistent joints and recommends filled, copper-plated, planar lands.

Via-in-pad rules:

- specify the hole, pad, fill material, fill acceptance, planarization, cap copper, final finish, dimple/protrusion, and electrical/thermal role;
- distinguish solder-mask plugging from structural fill and copper cap; they are not interchangeable;
- transmit unambiguous fab data and notes; verify the CAM output includes the intended holes and padstack layers;
- make all same-class lands geometrically consistent unless the component maker and assembler approve a controlled exception;
- include cap/antipad/void geometry in high-speed via models;
- qualify thermal expansion and solder-joint behavior, not merely continuity; and
- preserve rework planarity after thermal cycles.

The historical IPC-4761 vocabulary calls filled-and-capped protection “Type VII,” and its [official table of contents](https://www.ipc.org/TOC/IPC-4761.pdf) includes planarity, metallization, voids, long-term reliability, and BGA clearance. IPC's current revision table labels IPC-4761 no longer maintained, so use the term to communicate a construction only when the procurement drawing also states current, measurable requirements.

### 5.3 Blind laser microvias, stacked and staggered structures

A microvia usually spans one thin dielectric layer; multiple layers require sequential structures. Staggered microvias land on intermediate pads at offset positions. Stacked microvias place successive vias over the same target/fill structure. Both require an approved build sequence and consume fabrication cycles; neither is authorized just because CAD can draw it.

Reliability requirements:

- prefer the fewest laser-via levels and the simplest qualified structure that escapes the ball map;
- obtain the fab's qualified diameter, dielectric thickness, aspect ratio, capture/target pad, registration and plating/fill window;
- do not infer that a nominally low aspect ratio guarantees a sound target-pad interface;
- for stacked structures, require evidence for the exact stack height, materials, lamination count, pad geometry and reflow/environment profile;
- for high-reliability use, define representative coupons and performance-based thermal/reflow continuity testing, plus microsection/acceptance sampling agreed with the supplier;
- avoid placing a stack on a buried mechanical via unless the supplier has qualified that exact construction; and
- include yield, lead time, alternative suppliers, repairability, and lot surveillance in the architecture decision.

The official [IPC microvia reliability warning](https://www.electronics.org/news-release/ipc-issues-electronics-industry-warning-printed-board-microvia-reliability-high) reports high-performance product failures that passed traditional bare-board acceptance and says thermally stressed microsections/light microscopy alone may miss weak microvia-to-target interfaces. It specifically cites stacked-microvia evidence in IPC-WP-023. This is not a claim that every stacked structure fails or that every staggered structure is safe; it is a warning to qualify the actual structure with performance-based evidence.

TI's older, package-specific [SPRABB3](https://www.ti.com/lit/an/sprabb3/sprabb3.pdf) reports that, for its 0.5–0.8 mm PoP context, blind via-in-pad with drilled diameter no more than 0.004 in (0.1016 mm) and aspect ratio no more than 0.75:1 did not require fill/overplate and did not significantly increase voiding. NXP's newer family guide recommends filled/plated via-in-pad. The apparent difference is resolved by scope: a shallow blind laser microvia is not an open full-depth PTH, packages differ, and the assembler/fab must approve the exact process. An agent must never transfer TI's numbers to an unrelated device.

### 5.4 Through vias, buried vias, backdrill, and stubs

- PTH is usually the least expensive and most widely available transition, but its land/antipad field blocks channels on every layer and the unused barrel is an electrical stub.
- Blind vias preserve deeper-layer routing area but require depth/diameter/process qualification.
- Buried vias can connect inner layers without occupying the surfaces, but add lamination complexity and make inspection/repair less direct.
- Backdrilling removes an unused PTH barrel section; specify start side, signal layer, drill diameter, residual stub and drill-depth tolerance. It does not remove launch-pad/antipad discontinuities.
- Remove nonfunctional pads only with fabricator approval and after checking structural, registration, plane-clearance, thermal and reliability rules.

## 6. Breakout channels, rows, and layers

### 6.1 Planning method

1. Draw the true populated array and mark no-connect/reserved/power/ground/land-side-component regions.
2. Mark direct top-layer escapes and legal corridors. Do not count a channel that a mask rule, via pad, keepout, or decoupler consumes.
3. Select a tentative fanout for each population region, not merely one pattern for the whole package.
4. On every signal layer, draw via pads/antipads and calculate available corridors.
5. Assign the most constrained interfaces first: high-speed serial, clocks, memory strobes/data groups, analog references, then general I/O.
6. Keep each routing layer adjacent to an appropriate reference plane and include those planes in layer count.
7. Allocate P/G connection layers, plane islands, capacitor vias and stitching vias before declaring signal-layer capacity.
8. Prove all balls escape with DRC-clean geometry. A count estimate is not proof.

### 6.2 Row-depth heuristic and its limits

NXP's [AN10778](https://www.nxp.com/docs/en/application-note/AN10778.pdf) gives a useful example heuristic for its through-via patterns: two outer rows route on the component layer, the next two can route on the next signal layer if a trace passes between vias, and each additional row consumes another layer. It reports that its seven-row-deep TFBGA296 takes five breakout layers including power and ground, leading to a minimum six-layer PCB because conventional boards use an even layer count in that example.

Do **not** encode that result as `layers = rows - 2`. It changes with:

- whether one or two traces fit between lands/vias;
- full versus partial matrix and dedicated empty escape lanes;
- orthogonal routing on alternate layers;
- via type, antipad and layer span;
- power/ground ball density and plane connection method;
- interface grouping, differential geometry and reference planes;
- underside capacitor/test-point occupation; and
- stackup symmetry and manufacturability.

### 6.3 Assignment principles

- Route adjacent row rings in a predictable direction and avoid weaving that closes downstream channels.
- Use sparse/depopulated regions deliberately for clocks, differential pairs, sensitive analog, power entry or test access.
- Keep memory lanes together and honor the device's byte-lane/clock topology; legal swaps require schematic and constraint back-annotation.
- Spread traces after leaving the minimum-rule field to reduce crosstalk.
- Keep tuning structures outside the fanout. Serpentines between balls/vias consume scarce channels and couple strongly.
- A lower layer count is not automatically lower risk. Extra layers can preserve reference planes and normal fabrication rules; HDI can reduce PTH blockage but add sequential-lamination reliability risk.

## 7. High-speed escape, impedance, and reference transitions

### 7.1 Impedance is a quoted stackup result

Characteristic impedance depends on finished trace width/thickness, dielectric height and Dk/loss, reference geometry, neighboring copper, solder mask, differential spacing, copper roughness and fabrication tolerances. Configure ECAD rules from the fabricator's stackup/field-solver result, not a generic width table.

JLCPCB's current [capability page](https://jlcpcb.com/capabilities/pcb-capabilities/) advertises controlled impedance on selected multilayer counts with a standard ±10% tolerance. That is a **JLCPCB capability claim**, not the required tolerance for PCIe, DDR, USB, MIPI, LVDS, Ethernet, or any other interface. A tighter design need must be agreed and verified separately.

Neck-downs, BGA lands, via pads/antipads, reference-plane voids, connectors and AC-coupling pads are discontinuities. At modest edge rates they may be tolerable; at fast edges model the complete launch and transition with a field solver/3-D EM tool and the device/channel compliance model. Do not force the ordinary trace width through a corridor if it violates clearance; either qualify a short neck-down or change land/via/stackup architecture.

### 7.2 Reference continuity

- Give every critical routing layer an adjacent, continuous reference plane.
- Do not cross plane splits, voids, antipad moats or broken copper without an analyzed return path.
- When a signal changes layers but both layers reference the same ground system, put ground transition via(s) close to the signal via and keep differential-via/return geometry symmetric.
- When reference changes between unlike planes, provide a nearby low-inductance stitching-capacitor path only if the rail/noise architecture permits it; avoiding the change is safer.
- Minimize signal-via count and unused stub. Backdrill or use shorter vias when channel analysis requires it.
- Optimize via antipads for both impedance and plane integrity; larger is not universally better.

Intel's current Agilex 5 [source-specific guidance](https://www.intel.com/content/www/us/en/docs/programmable/821801/current/other-considerations.html) calls for a return ground via within 50 mil of a transition via and says that is especially important for single-ended signals. AMD's [differential-via guidance](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Differential-Vias) explains that a ground-signal-signal-ground transition gives return current a nearby ground via and reduces excess inductance. Use these as topology evidence, not a universal 50 mil rule.

### 7.3 Crosstalk and breakout

- Minimize parallelism at minimum spacing and spread routes once outside the ball field.
- Preserve P/N symmetry but do not assume tight coupling eliminates common-mode return requirements.
- Keep high-speed escapes away from switch nodes, inductors, oscillators and noisy power vias.
- For extreme serial rates, analyze package launch, land/pad capacitance, via field, crosstalk and breakout layer together. AMD's [112 Gb/s C4072 example](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/PCB-Stackup-and-Via-Construction-for-Example-PCB-Breakout-Design) uses a 28-layer, 131.9 mil stackup with eight inner signal layers and via-in-pad. It is evidence that a validated extreme-speed example can be elaborate, not a recommended general stackup.

## 8. Length, delay, and skew

### 8.1 Required budget

For every timing class, capture:

- measurement endpoints and whether package internal delay is included;
- maximum route delay/length, intra-pair skew, group skew and clock-to-data relation;
- layer-dependent propagation velocity and via/package/connector delay;
- allowed topology, branch/stub and termination location;
- whether transmitter/receiver calibration or training changes the board requirement; and
- margin allocation for fabrication tolerance, temperature, connector/cable and model error.

Length equality is only a proxy for delay equality. Two geometrically equal traces on different layers or with different via launches need not have equal delay. Use the exact interface/device guide, not the article's phrase “within mils.”

### 8.2 Routing rules

- match P/N geometry and transition count first where the interface requires it;
- route and constrain each memory byte lane/clock group according to the controller and memory documents;
- include package delay compensation only when the vendor supplies a trustworthy value and the ECAD constraint understands its sign/reference;
- place any necessary tuning in open, consistently referenced areas after the escape;
- avoid tightly packed trombones, excessive bend density and long coupled meanders; and
- verify post-layout delay with the actual stackup and extracted topology.

**Stop condition:** no numeric timing/skew rule for a critical interface means the AI may propose placement and an unrouted corridor, but it may not release or claim compliance.

## 9. Power, ground, and decoupling

### 9.1 Power/ground balls

- Connect every required P/G ball according to the device guide; do not assume nearby same-name balls may share one via.
- Group by rail and ground type. Preserve analog/PLL/reference isolation and remote-sense/Kelvin paths exactly as specified.
- Estimate DC current per via/neck/plane and transient-loop inductance. Use thermal/current analysis and the selected supplier's plated-hole capability.
- Prefer short, direct connections to low-impedance planes. NXP AN10778 recommends solid 360-degree via-to-plane connections rather than thermal spokes for the listed MCU BGA P/G vias.
- Do not let power-plane splits cut high-speed return paths.
- Account for the thermal effect of large copper close to a solder land; NXP's package-specific example necks the first 1 mm of a long P/G fanout to no more than 0.15 mm before widening, to avoid creating a solder-joint heat sink. Do not universalize that dimension.

### 9.2 Decoupling workflow

1. Import the device vendor's rail-by-rail capacitor table, package sizes, allowed mounting inductance, placement priorities, power-up/down and regulator-stability requirements.
2. Create reserved bottom-side sites and P/G via pairs while fanout is still fluid.
3. Minimize the complete loop: BGA power ball → plane/via → capacitor → ground via/plane → BGA ground ball.
4. Prefer short/wide pad-to-via connections and multiple ground vias where the source guide and space allow.
5. Validate target impedance and anti-resonance across frequency using vendor models and actual mounted geometry.
6. Check that underside components do not violate assembly, inspection, rework, heat-sink/backer or mechanical keepouts.

[AMD UG583](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Capacitor-Placement-Background) ties capacitor distance and loop area to power-path inductance. [TI's BGA decoupling report SPRABV2](https://www.ti.com/lit/an/sprabv2/sprabv2.pdf) emphasizes short capacitor connection length and presents sharing at most two nearby same-rail P/G balls per via as a layout tradeoff for its processor context; it discourages sharing more than two. The report's generic 0.1–0.2 µF/small-package suggestion is explicitly subordinate to the device datasheet. Neither source authorizes arbitrary ball sharing or a universal capacitor bill.

## 10. Fabrication release and DFM

### 10.1 Current JLCPCB numbers are vendor-specific

As accessed 2026-09-06, JLCPCB's [rigid PCB capability page](https://jlcpcb.com/capabilities/pcb-capabilities/) states:

| Item | Current JLCPCB web claim | Correct use |
|---|---:|---|
| Layers | 1–32 | Selection range only; submit stackup for review, especially high layer counts. |
| Controlled impedance | selected 4–32 layer constructions; standard ±10% | Not an interface requirement or lot result. |
| 1 oz trace/space | 0.10/0.10 mm on 1–2 layer; 0.09/0.09 mm multilayer; 3 mil accepted in BGA fanout | Local minimum, not preferred global geometry. Confirm copper and layer. |
| Minimum via hole/diameter | 0.15/0.25 mm; 0.20 mm hole preferred | Capability floor; confirm board thickness, padstack, cost and yield. |
| Via diameter over hole | +0.10 mm allowed, +0.15 mm preferred | This implies only nominal geometry; do not confuse it with the separate PTH annular-ring row. Ask CAM. |
| Blind/buried vias | “Not supported”; through holes only | **Hard conflict** with the article's 0.4 mm microvia/HDI advice. Do not order blind microvias without a written exception/updated quote. |
| Backdrill | 4–32 layer FR-4 ≥0.8 mm; source page gives hole, oversize and residual-clearance ranges | Quote exact start/stop layer and stub. |
| BGA pad | 0.20–0.25 mm diameter requires ENIG | JLC service rule only. |
| BGA pad-to-trace clearance | ≥0.10 mm; 0.09 mm local multilayer minimum | Configure a BGA region rule; confirm current CAM result. |
| Mask expansion | 1:1 possible after LDI upgrade; ≥0.09 mm opening-to-neighboring-trace clearance | Does not itself make a pad SMD/NSMD-safe. |
| Mask bridge | 0.10 mm for listed colors at 1 oz, 0.13 mm black/white, 0.20 mm at 2 oz | Color/copper/process-specific. Verify actual pad pitch and reorder behavior. |
| Via-in-pad | epoxy- or copper-paste-filled and capped, 0.15–0.55 mm via diameters; page says default on 6+ layers | This appears to describe filled/capped **through vias**, not a blind laser-microvia capability. Obtain a job quote. |
| PTH annular ring | page separately lists recommended/minimum values by copper/layer | The terminology appears inconsistent with the minimum via pad/hole pair. Ask JLCPCB to identify the rule applied to vias versus component PTHs. |

These web values can change and contain internal ambiguities. Save the accepted quotation/engineering response with the release package.

### 10.2 Fabrication outputs and notes

Release at least:

- IPC-2581 or ODB++ where supported, plus agreed Gerber/drill fallbacks;
- layer stackup and impedance table/coupons;
- separate plated/nonplated, PTH/blind/buried/laser/backdrill drill definitions with spans;
- controlled padstack definitions for all copper, mask, paste, antipad and nonfunctional-pad layers;
- VIPPO fill/cap/planarity notes and a map of affected holes;
- material, copper, finish, mask, bow/twist, thickness and controlled-depth requirements;
- fabrication class/acceptance document and revision, plus explicit exceptions/AABUS items;
- netlist for bare-board electrical test; and
- fab drawing with dimensions, datum, panel constraints, coupons and special-process callouts.

Run ECAD DRC, independent CAM/DFM, netlist comparison and visual layer review. Verify no pad was clipped to create clearance, no mask opening exposes a neighboring trace, and no automatically removed nonfunctional pad breaks the intended via connection.

## 11. Assembly, inspection, rework, and test limitations

### 11.1 Assembly

- Hidden balls prevent post-placement optical confirmation of every joint; process capability must be designed in.
- Validate stencil aperture and thickness with the assembler. A BGA rule can conflict with paste requirements for adjacent components and require a step stencil or layout change.
- Profile the real assembly with thermocouples at package/body and relevant joint locations; respect the exact device's MSL peak-package-temperature classification.
- Check copper balance, package/board warpage, paste volume, placement force and soak/reflow window for head-on-pillow, nonwet opens, shorts and voiding.
- Keep BGAs away from mounting holes, clamps, connectors, panel-separation lanes and high-flex areas unless mechanically analyzed. NXP AN13656 identifies these as bending/handling risks.
- Reserve underfill nozzle and inspection access if underfill/edge bond is required.

For thin FCCSP trial assembly, NXP's [AN13656](https://www.nxp.com/docs/en/application-note/AN13656.pdf) gives a **package-family-specific** example: at least 30 trial parts, verified top/joint temperatures, and 100% X-ray plus sample cross-section. This is evidence that process validation may need destructive sampling; it is not a universal sample plan.

### 11.2 Inspection

- SPI can measure paste before placement but not the final buried joint.
- AOI can inspect orientation, placement and visible perimeter/nearby components but cannot fully inspect balls under the body.
- 2-D X-ray can reveal many shorts, missing/abnormal solder, void patterns and alignment problems, but overlapping structures and some nonwet/head-on-pillow conditions can remain ambiguous. 3-D AXI/CT, oblique views, cross-section, dye-and-pull or electrical diagnostics may be needed.
- X-ray is not an electrical continuity or performance test. Conversely, continuity does not prove adequate solder shape, fatigue life or microvia interface integrity.
- Define defect thresholds and disposition using the contractually applicable assembly standard, device requirements and product class.

**IPC correction:** [IPC-7095E](https://www.ipc.org/TOC/IPC-7095E_toc.pdf) is guidance covering BGA design/assembly/inspection/repair/reliability and anomaly troubleshooting. Its scope directs accept/reject criteria to IPC J-STD-001 and IPC-A-610. Do not write “IPC-7095 compliant” as a complete acceptance criterion.

### 11.3 Rework

BGA rework requires controlled bottom preheat, localized top heat, temperature profiling, site cleaning, alignment vision, moisture controls and adjacent-component protection. Underside capacitors directly below the package may be excellent electrically yet interfere with support, heating or rework tooling; the assembler must approve their position and height.

NXP AN13656's FCPBGA-specific process calls for a board bake (12 h at 125 °C or the highest assembly-safe temperature), full-board preheat, vision alignment, and the original process's careful temperature profiling; it advises against re-balled BGAs in products due to long-term reliability concerns. Those temperatures and times are **NXP FCPBGA examples**, not instructions for another board. Use the exact component/assembly moisture and rework specification.

Plan:

- a rework keepout on both sides;
- thermocouple and nozzle/vision access;
- maximum thermal excursions/rework cycles;
- protection/removal of adjacent heat-sensitive parts;
- pad-repair and laminate-damage disposition;
- post-rework X-ray/electrical/functional criteria; and
- whether underfill, heat sinks, backers or conformal coating make rework uneconomic.

### 11.4 Design for test

- Bare-board electrical test validates fabricated net continuity/isolation, not BGA solder joints.
- Provide accessible test points for rails, resets, clocks, configuration, buses and analog nodes where loading permits. Do not add stubs to high-speed nets merely for probing.
- Preserve JTAG/IEEE 1149.1 or device-specific boundary-scan access when the device supports it; build a coverage report rather than assuming all balls/circuits are observable.
- Use memory BIST, loopback, programming and functional diagnostics for buried nets; document what remains structurally untestable.
- Add current-limited first-power-up, rail sequencing/voltage checks and thermal observation.
- Correlate failures among X-ray, boundary scan, functional logs and destructive analysis. No single method closes every hidden-joint failure mode.
- Ensure fixtures do not flex the BGA region and test pads do not block underside decoupling or rework.

## 12. Worked examples with source-scoped values

### Example A: one straight trace between 0.8 mm lands

Assume a 0.8 mm pitch and 0.35 mm PCB copper land from NXP AN10778's listed 0.8 mm family case. Nominal corridor:

```text
G = 0.800 - 0.350 = 0.450 mm
```

At a hypothetical 0.105 mm trace and 0.105 mm clearance, one trace requires:

```text
0.105 + 2(0.105) = 0.315 mm <= 0.450 mm
```

The straight copper check passes. It does **not** prove mask-web registration, via placement, pad-exit shape, impedance, or assembly. NXP's table for this source case lists a 0.25/0.10 mm via drill/finished-hole pair and other pad/antipad details; the intended supplier must accept the complete padstack.

### Example B: two traces between 0.8 mm lands

Using NXP's smaller 0.30 mm land and 0.10 mm trace/space source example:

```text
G = 0.800 - 0.300 = 0.500 mm
Need for two = 2(0.100) + 3(0.100) = 0.500 mm
```

This is a zero-nominal-margin equality under the simplified model. NXP published it for a particular TFBGA296 layout and explicitly tied the smaller land to two-trace routing. It must not be transferred to an unrelated package or fabricator without tolerance, mask, land-pattern, SI and assembly approval.

### Example C: NXP 0.65 mm staggered PTH fanout

For the TFBGA208 example in AN10778, NXP places interstitial vias on a 1.3 mm cadence by skipping alternate sites and staggering adjacent rows. The source table uses a 0.25 mm BGA land, 0.20/0.05 mm drill/finished hole, 0.425 mm via pad, 0.60 mm inner antipad, and 0.125/0.125 mm trace/space for the stated route. This is evidence that ball-map-specific staggering can make a PTH escape feasible at 0.65 mm; the 0.05 mm finished-hole figure is unusually aggressive and needs current fab confirmation.

### Example D: NXP 0.5 mm PTH escape is not a universal permission

AN10778 says an interstitial via between four lands does not fit its 0.5 mm package. It routes the two outer rows directly, takes two inner rows toward vias in the central depopulated area, and reports 0.25 mm lands, 0.40 mm via pads, 0.20/0.05 mm drill/finished hole, 0.60 mm inner antipads, 0.10/0.10 mm between-via trace/space, and 0.08 mm trace with 0.10 mm space between lands. The feasibility depends on the LFBGA320 partial matrix and central region. A full matrix or different no-connect map may force HDI.

### Example E: AMD 0.8 mm land pattern

AMD's current Versal table gives, for its 0.8 mm flip-chip BGA class, a 0.40 mm package SMD opening, maximum 0.40 mm PCB NSMD land, and 0.50 mm PCB mask opening. This leaves 0.10 mm diametral mask clearance, or 0.05 mm radial, for that AMD class. It does not prove the selected fab's mask-registration/web capability or apply to every 0.8 mm BGA.

### Example F: aspect-ratio precheck

For a **hypothetical** 1.60 mm drilled depth and 0.15 mm mechanical drill:

```text
AR = 1.60 / 0.15 = 10.67:1
```

JLCPCB's page listing a 0.15 mm minimum drill does not say that every 1.6 mm stack is qualified at 10.67:1. Stop and obtain the supplier's maximum qualified aspect ratio, definition (drill or finished hole), plating/registration capability, performance class and lot acceptance. A larger drill, thinner board, blind structure, extra escape layer, or different supplier may be required.

### Example G: current JLCPCB via-in-pad versus microvia conflict

The JLC article recommends microvia/HDI planning at 0.4 mm. Its current capability page simultaneously says blind/buried vias are unsupported and describes 0.15–0.55 mm filled/capped via-in-pad. The conservative interpretation is filled/capped through-via VIPPO, not blind laser microvia. An AI must issue `STOP_FAB_PROCESS_CONFLICT` until JLCPCB provides a written, job-specific process approval or the design changes fab/architecture.

## 13. AI implementation specification

### 13.1 Mandatory inputs

An AI may begin feasibility analysis only when it has:

```text
COMPONENT
  manufacturer, full_mpn, package_code, revision
  package_drawing_url/revision, datasheet_url/revision
  ball_map with coordinates and view convention
  pitch_x/y, body_x/y/z, ball/land data, A1 marker
  package land/mask/paste guidance, MSL/reflow limits

ELECTRICAL
  net per ball, NC/DNC/reserved disposition
  power/ground domains and current estimates
  differential/timing groups and numeric constraints
  impedance/loss/via/stub limits, topology and termination
  decoupling/PDN requirements, test/programming requirements

BOARD
  outline/placement/height/keepouts, reliability class/environment
  proposed stackup and copper/material
  mechanical/thermal/warpage constraints

FAB_QUOTE
  trace/space by layer and copper, hole/pad/antipad
  annular ring/registration/aspect ratio
  mask opening/web/registration and finish
  supported via spans/stacking, fill/cap/planarity, lamination count
  impedance/backdrill/coupon/acceptance requirements

ASSEMBLER_APPROVAL
  land/mask/paste/stencil acceptance
  reflow/MSL/warpage/process limits
  X-ray/electrical/rework/test plan and keepouts
```

### 13.2 Deterministic rules

The AI shall:

1. lock the exact package revision and verify coordinate orientation;
2. account for every ball and reject silent NC/reserved assumptions;
3. rank sources: exact device/package rule > current device-family guide > contracted fab/assembler rule for their process > current standards > vendor article > heuristic;
4. compute land and via channel inequalities with tolerance margin;
5. construct a per-layer obstruction map including pads, antipads, planes, masks, keepouts, capacitors and test features;
6. assign references and return transitions before completing high-speed routes;
7. keep critical pair/group topology and transitions symmetric where required;
8. reserve P/G and decoupling paths before general I/O escape;
9. use region-specific minimum rules and widen/spread outside the BGA field;
10. maintain provenance on every numeric constraint (`value`, `units`, `source`, `revision/date`, `scope`, `confidence`);
11. emit assumptions and unresolved conflicts explicitly; and
12. produce a release matrix covering footprint, fab, assembly, SI, PI, thermal, DFT, inspection and rework.

### 13.3 Prohibited inferences

The AI shall not:

- choose land diameter from pitch alone;
- mirror or rotate a ball map based on an image without confirming view convention;
- treat `NC`, `DNC`, `RESERVED`, ground and thermal balls interchangeably;
- copy a via/land table from another package family;
- infer microvia support from “via-in-pad” support;
- equate a fabricator absolute minimum with a recommended production rule;
- infer aspect-ratio permission from minimum drill diameter;
- reduce a package land to make a route fit without component and assembly evidence;
- mix SMD/NSMD or VIPPO/non-VIPPO lands casually;
- leave an open PTH in a solder land;
- invent impedance, skew, length, current, via-count, capacitor or reflow requirements;
- route a critical signal over a split reference plane because differential signaling is assumed to be self-returning;
- declare X-ray, DRC, DFM or continuity alone sufficient; or
- declare IPC compliance without standard number, revision, class, applicable clauses and supplier agreement.

### 13.4 Hard stop conditions

| Code | Condition | Required resolution |
|---|---|---|
| `STOP_PART_AMBIGUOUS` | Exact MPN/package/revision missing or conflicts | Obtain current manufacturer documentation. |
| `STOP_BALLMAP_ORIENTATION` | A1/view/row-column convention unverified | Independent coordinate check. |
| `STOP_BALL_DISPOSITION` | Any populated coordinate lacks an approved electrical role | Resolve with device owner/vendor. |
| `STOP_FOOTPRINT_CONFLICT` | Library differs from current package drawing/guide | Correct and peer-review footprint. |
| `STOP_CHANNEL_NEGATIVE` | Required trace/space plus margin does not fit land/via corridor | Change land only with approval, via architecture, stackup, orientation, pin swap, or fab. |
| `STOP_FAB_PROCESS_CONFLICT` | Proposed blind/buried/microvia/VIPPO/backdrill not explicitly offered for stackup | Written fab approval or redesign. |
| `STOP_VIA_QUALIFICATION` | Aspect ratio, annular ring, stack height, target pad or fill/planarity unqualified | Obtain qualified limits/coupons or simplify. |
| `STOP_MASK_PROCESS` | Mask web/opening/registration cannot be shown producible | Change mask/land/finish/process with assembler approval. |
| `STOP_ASSEMBLY_APPROVAL` | Stencil/reflow/warpage/X-ray/rework plan absent | Assembler DFM and process plan. |
| `STOP_TIMING_BUDGET` | Critical interface lacks numeric topology/impedance/skew rules | Obtain device/interface constraints. |
| `STOP_REFERENCE_PATH` | Critical route crosses a reference discontinuity or changes reference without a return structure | Reroute/restack/analyze transition. |
| `STOP_PDN` | Required P/G balls, current capacity or decoupling loop cannot be met | Rework fanout/planes/cap placement and validate PI. |
| `STOP_DFT_COVERAGE` | Buried nets/rails cannot be meaningfully tested and no risk acceptance exists | Add access/boundary scan/BIST/functional coverage. |
| `STOP_STANDARD_SCOPE` | Standard cited without current status/revision or wrong role | Correct procurement/acceptance reference. |

### 13.5 Required outputs

An AI-generated proposal is incomplete unless it outputs:

- verified package/ball-map provenance and orientation proof;
- footprint table with copper/mask/paste and package-source comparison;
- per-ball fanout assignment and per-layer escape map;
- channel calculations and margins for every minimum geometry;
- stackup, impedance classes, reference planes and transition-return structures;
- via construction table with spans, drills, pads, antipads, fill/cap, aspect ratio, stub and qualification;
- P/G/decoupling map and current/PI assumptions;
- timing/skew constraint table and post-route results;
- fab and assembly DFM exception list;
- inspection, rework and DFT coverage plan;
- unresolved risks with named owner; and
- source ledger and a clear `NOT RELEASED` status until all hard stops close.

## 14. Release checklist

### Package and footprint

- [ ] Exact MPN/package/revision and current drawings locked.
- [ ] Ball map independently checked against A1/view convention.
- [ ] Every ball classified; NC/DNC/reserved treatment reviewed.
- [ ] Copper/mask/paste/finish and land-side keepouts match package guidance.
- [ ] SMD/NSMD and VIPPO consistency approved.

### Escape and stackup

- [ ] Channel equations pass with manufacturing tolerance margin.
- [ ] Every ball has a DRC-clean escape and legal layer/reference assignment.
- [ ] Via spans, pads, antipads, annular ring, aspect ratio and stubs are fab-approved.
- [ ] Minimum rules are local; routing widens/spreads outside the field.
- [ ] Stackup remains symmetric/manufacturable and includes required reference/P/G layers.

### SI, timing, and PI

- [ ] Numeric interface rules come from exact current sources.
- [ ] Neck-down/pad/via/reference transitions are modeled where warranted.
- [ ] No unapproved split/void crossings; return vias/capacitors are present.
- [ ] Package and via delay included correctly in skew reports.
- [ ] Every required P/G ball connects with adequate current/thermal capacity.
- [ ] Decoupling placement and mounted loop meet device/PI requirements.

### Fabrication and assembly

- [ ] Job-specific fab quote/DFM, stackup and impedance plan accepted.
- [ ] VIPPO/HDI/backdrill notes and data are unambiguous.
- [ ] Fab standard/revision/class, coupons and electrical test agreed.
- [ ] Assembler approved pad/mask/paste/stencil, reflow/MSL/warpage and bottom-side placement.
- [ ] Inspection method, coverage, thresholds and acceptance documents agreed.

### Rework and test

- [ ] Two-sided rework keepout, thermal access and cycle limits reviewed.
- [ ] Test access/boundary scan/BIST/programming/functional coverage documented.
- [ ] High-speed test structures do not create unmodeled stubs.
- [ ] Prototype bring-up and failure-analysis plan exists.
- [ ] All AI hard-stop codes are closed by named human evidence.

## 15. Gap matrix and reconciled disagreements

| Claim/gap | Best evidence | Reconciliation | Residual requirement |
|---|---|---|---|
| 0.5 mm requires VIP/HDI | JLC says “typically”; NXP shows one PTH partial-matrix escape | Pitch is only a screen; ball map plus process geometry decide. | Prove exact map/layers. |
| 0.4 mm microvia at JLCPCB | JLC article recommends it; current capability page says blind/buried unsupported | Current public sources conflict; likely the VIP service is through-hole fill/cap. | Written job-specific confirmation. |
| NSMD always stronger/better | NXP/AMD often recommend NSMD, but NXP distinguishes fatigue vs drop behavior | Pad selection is package/use/process-specific. | Exact package + assembler approval. |
| Via-in-pad can remain open | TI allows a very shallow blind-via case; NXP warns open VIP causes void/inconsistent joints | Via type and package/process differ; open PTH is not equivalent to qualified laser microvia. | Exact fab/assembler qualification. |
| Stacked microvia is reliable after ordinary inspection | IPC warning reports latent target-interface failures after traditional acceptance | Visual/microsection alone can miss failure. | Performance coupons/testing for high-risk stacks. |
| IPC-7095 supplies BGA acceptance | IPC-7095E scope calls itself guidance and points to J-STD-001/A-610 | Article wording is too broad. | Cite contractual acceptance documents/revisions. |
| IPC-7351 is the current land standard | IPC revision table marks IPC-7351 no longer maintained and lists IPC-7352 (2023) | Historical package notes may still cite 7351; current projects must check governing docs. | Standards owner chooses current contractual set. |
| “Match within mils” | No interface or propagation scope in article | Not actionable. | Numeric device/interface timing budget. |
| JLC minimum via proves annular ring/aspect ratio | Capability rows use different terminology and no universal AR | Minimum drill/pad is not a stackup qualification. | CAM clarification and written max AR/min finished ring. |

## 16. Standards warning and hierarchy

The JLC article cites IPC-7351, IPC-2221, IPC-2152 and IPC-7095 as if names alone establish alignment. They do not.

- The official [IPC revision table](https://www.ipc.org/ipc-document-revision-table) marks IPC-7351B “no longer maintained” and lists IPC-7352, *Generic Guideline for Land Pattern Design*, originally published 2023. Historical device notes may still correctly cite IPC-7351 for their release era; do not silently substitute geometry.
- The revision table identifies IPC-7095E (2024) as the current BGA implementation guidance revision at research time. Its scope distinguishes guidance from accept/reject criteria.
- IPC-2221/2222 address generic/rigid-board design, IPC-2152 current-carrying methodology, and IPC-6012F rigid-board qualification/performance. A product procurement drawing must identify the chosen revision, class and exceptions.
- IPC-4761's via-protection vocabulary remains widely recognizable but IPC lists it as no longer maintained. State measurable construction/acceptance requirements rather than only “Type VII.”
- IPC's microvia warning shows that passing legacy acceptance can still miss a latent interface defect in high-performance structures.

Use this authority order when requirements conflict:

1. laws/regulatory/safety and the product's approved qualification plan;
2. exact current component/package requirements;
3. contractual fab and assembly specifications for the actual process;
4. contractually selected current standards and class;
5. validated reference design/model for the exact device/interface;
6. vendor application notes within their stated package scope;
7. educational articles and heuristics.

Escalate rather than averaging incompatible values.

## 17. Source ledger

| Source | Publisher/date | Use in this dossier | Scope and access note |
|---|---|---|---|
| [BGA PCB Design Complete Guide: Layout and Routing Guidelines](https://jlcpcb.com/blog/bga-pcb-design-complete-guide-layout-and-routing-guidelines) | JLCPCB; published/updated 2026-07-15 | Required article; pitch heuristics, planning, fanout, DFM, SI/PI, inspection themes | Fabricator marketing/engineering article; not a job quote or component rule. Accessed 2026-09-06. |
| [PCB Manufacturing & Assembly Capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/) | JLCPCB; live page, accessed 2026-09-06 | Current JLC-specific layer, trace, drill, BGA, mask, VIPPO, impedance, backdrill claims | Dynamic vendor page. Contains terminology ambiguities and conflicts with article's microvia advice; written confirmation required. |
| [AN10778: PCB layout guidelines for NXP MCUs in BGA packages](https://www.nxp.com/docs/en/application-note/AN10778.pdf) | NXP Semiconductors; Rev. 2, 2011-04-15 | NSMD rationale/values; 1.0/0.8/0.65/0.5 mm PTH worked examples; local rule areas; layer heuristic; P/G fanout | Applies only to listed LPC MCU packages; old dimensions require current fab confirmation. |
| [AN13656: Assembly guidelines for Flip Chip plastic ball grid array and chip scale package](https://www.nxp.com/docs/en/application-note/AN13656.pdf) | NXP Semiconductors; Rev. 1, 2022-09-01 | Package precedence, SMD/NSMD tradeoffs, VIP fill/planarity, stencil/trial assembly, X-ray, reflow, rework and reliability | FCPBGA/FCCSP family guidance; exact product document overrides. |
| [SPRABB3: PCB Design Guidelines for 0.5 mm Package-on-Package Applications Processor, Part I](https://www.ti.com/lit/an/sprabb3/sprabb3.pdf) | Texas Instruments; June 2010 | Source-specific adjacent-via length/mask rule and shallow blind-via aspect-ratio/voiding example | Historical PoP context; never a general fab rule. |
| [SPRABV2: General hardware design/BGA PCB design/BGA decoupling](https://www.ti.com/lit/an/sprabv2/sprabv2.pdf) | Texas Instruments; February 2019 | Mounted inductance, underside placement and limited ball/via-sharing tradeoff | General TI processor guidance; exact device datasheet overrides capacitor values. |
| [AM013: Recommended PCB Design Rules for BGA](https://docs.amd.com/r/en-US/am013-versal-pkg-pinout/Recommended-PCB-Design-Rules-for-BGA) | AMD; Rev. 1.10, 2026-07-31 | Current AMD NSMD dimensions, mixed pad/VIPPO warnings, land-side-component rule | Applies to named AMD Versal packages/classes. |
| [UG1099: Fabrication Technologies](https://docs.amd.com/r/en-US/ug1099-bga-device-design-rules/Fabrication-Technologies) | AMD; Rev. 2.1, 2025-10-24 | Definitions and tradeoffs for blind, buried and via-in-pad structures | AMD BGA design guide; fab must qualify construction. |
| [UG583: Differential Vias](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Differential-Vias) and [Capacitor Placement Background](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Capacitor-Placement-Background) | AMD; Rev. 1.29, 2025-12-23 | Return-via topology and PDN loop-area rationale | UltraScale family guidance; topology lessons need project modeling. |
| [XAPP1392 C4072 example stackup](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/PCB-Stackup-and-Via-Construction-for-Example-PCB-Breakout-Design) | AMD; Rev. 1.0, 2023-05-23 | Source-scoped extreme-speed breakout example | 112 Gb/s GTM/C4072 worked analysis, not a generic layer recommendation. |
| [Agilex 5 PCB Design Guidelines: Other Considerations](https://www.intel.com/content/www/us/en/docs/programmable/821801/current/other-considerations.html) | Intel; current page dated 2025-08-29 | Source-specific 50 mil return-via guidance and high-speed keepouts | Agilex 5 context; not universal. |
| [IPC document revision table](https://www.ipc.org/ipc-document-revision-table) | IPC; live status page, accessed 2026-09-06 | Current/no-longer-maintained status for IPC-7351/7352, 7095, 4761 and other documents | Status metadata, not the standards' paid technical content. |
| [IPC-7095E table of contents and scope](https://www.ipc.org/TOC/IPC-7095E_toc.pdf) | IPC; Rev. E, September 2024 | Correct scope: BGA implementation guidance; J-STD-001/A-610 for accept/reject | Public scope/TOC only; no claim of reviewing the full paid standard. |
| [IPC-7351B public scope](https://www.ipc.org/TOC/IPC-7351B.pdf) | IPC; Rev. B, June 2010 | Historical land-pattern purpose and need to use component dimensions/process tolerances | Historical/no-longer-maintained according to IPC revision table. |
| [IPC-4761 public table of contents](https://www.ipc.org/TOC/IPC-4761.pdf) | IPC; original 2006 | Type VII vocabulary and via-fill/planarity/reliability issue categories | Historical/no-longer-maintained; public TOC only. |
| [IPC warning on printed-board microvia reliability](https://www.electronics.org/news-release/ipc-issues-electronics-industry-warning-printed-board-microvia-reliability-high) | IPC/electronics.org; 2019-03-06 | Latent weak-interface risk and limitations of traditional acceptance | Official industry warning; not a quantitative qualification plan. |
| [IPC standards overview: IPC-A-600K and IPC-6012F](https://www.ipc.org/meet-your-standards) | IPC; live page, accessed 2026-09-06 | Current bare-board acceptability/performance roles and microvia/copper-filled-via coverage | Summary page, not full paid requirements. |

## 18. Research coverage and stopping rationale

Discovery covered the required article, its linked/current capability page, official NXP/TI/AMD/Intel package and layout guidance, official IPC standard status/scope pages, and IPC's microvia warning. Follow-up searches targeted conflicts in pad style, 0.5 mm escape, blind/open via-in-pad, stacked microvia reliability, reference transitions, decoupling, inspection, rework and standards scope.

Research stopped because every requested decision slot has either (a) direct first-party evidence, (b) a transparent source-scoped calculation/example, or (c) an explicit stop/confirmation requirement. More generic BGA articles would repeat lower-authority guidance and would not resolve the remaining project-specific unknowns: exact part, ball map, interface constraints, stackup, fab quote and assembler process. Those unknowns must be supplied for a real layout; they cannot be researched generically or invented.

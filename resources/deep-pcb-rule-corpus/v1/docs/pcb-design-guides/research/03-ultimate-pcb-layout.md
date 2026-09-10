# Evidence dossier: The Ultimate Guide to PCB Layout Design

**Article under review:** [JLCPCB, *The Ultimate Guide to PCB Layout Design*](https://jlcpcb.com/blog/guide-to-pcb-layout-design) (JLC-specific blog, accessed 2026-09-06).  The URL supplied for this review (`/the-ultimate-guide-to-pcb-layout-design`) returned JLCPCB's 404 page; the current article was located from JLCPCB's own layout index.  This dossier therefore treats the current `guide-to-pcb-layout-design` page as the intended article, while preserving that URL-resolution limitation.

**Audience and use.** This is a design-review and execution guide for a PCB designer or an AI-assisted layout workflow. It expands the article's high-level sequence into verifiable engineering gates. It is not a substitute for the chosen component's datasheet, reference layout, safety standard, fabricator drawing, or SI/PI/thermal analysis.

**Evidence key.** **[JLC]** means a statement about JLCPCB's service or a recommendation from the reviewed JLC article, not an industry guarantee. **[General]** means a portable workflow practice. **[Vendor]** means a recommendation shown for a particular vendor/device family and must be checked against the actual part. **[Open]** means an input the project must supply before release.

## Direct reading of the article: useful frame, limits, and corrections

The JLC article gives a sensible beginner sequence: prepare the schematic and board dimensions, transfer the netlist, place components, route traces, address power/ground, and test. It correctly calls out mechanical constraints, grouping and prioritising components, thermal space, internal planes, short/direct routing, impedance concerns, and checking manufacturer rules. Those are useful prompts, not sufficient release criteria.

Three cautions make the guide safer to apply:

1. **A board is a constrained electromagnetic and manufacturing object, not merely a connected drawing.** “Short and direct” is usually good, but an intentional longer controlled-impedance route, a matched pair, a Kelvin sense trace, a creepage path, or a thermal copper area can be correct.
2. **The article's current-width examples are not universal ampacity rules.** Its approximate 10-mil/1-A and 250-mil/15-A statements omit copper thickness, internal/external layer, permitted temperature rise, ambient, length, plane spreading, connector rating, and transient current. Use an approved calculation method and thermal/current validation for each power net; do not encode those examples as release limits.
3. **“Separate analog and digital grounds” is conditional, not a default mandate.** TI documents both split-ground cases and a better solution in many mixed-signal boards: a continuous plane plus functional placement and routing that keeps each region's currents local. A high-speed trace crossing a plane split creates a large return loop. See [TI High-Speed Layout Guidelines](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), pp. 10–16, and [TI TMS570 ADC layout note](https://www.ti.com/lit/pdf/spna129a), pp. 3–4.

The rest of this dossier turns those cautions into actions.

## 1. Requirements capture: layout starts before the PCB editor

**Gate 0 — inputs are complete enough to constrain layout.** Freeze neither the schematic nor the board yet; instead make a one-page constraint register and mark each row `known`, `assumed`, or `owner/date`. An AI agent must not invent values for `assumed` rows.

| Requirement family | Capture before placement | Verification/evidence | Status in a new project |
|---|---|---|---|
| Function | Interfaces, operating modes, clocks/edge rates, analogue resolution/bandwidth, RF bands, regulatory environment | System specification, schematic, interface standard | **[Open]** |
| Electrical | Supply range, maximum steady and transient current, rail ripple/noise budgets, voltage ratings, impedance/length/skew targets, isolation | Datasheets, PDN/SI budget, connector pinout | **[Open]** |
| Mechanical | Outline, keepouts, mounting datum, enclosure height, connector mating direction, display/button access, cable bend radius | Mechanical drawing/CAD and 3-D collision check | **[Open]** |
| Thermal | Ambient, component dissipation, airflow, allowed junction/case/board temperature, heat-sinking/contact surfaces | Datasheet thermal model and system test plan | **[Open]** |
| Manufacturing | Fabricator, material, layer count, copper weight, finish, min feature, drill/slot, impedance coupon need, panelization | Fabricator's current capability and quotation | **[Open]** |
| Assembly and service | Assembler, package availability, stencil rules, fiducials, component spacing, test strategy, rework access, polarity/readability | Assembly drawing and test fixture concept | **[Open]** |
| Compliance and safety | Creepage/clearance, isolation barrier, fusing, ESD/EMC approach, grounding/chassis strategy | Applicable standard and safety review | **[Open]** |

**Schematic handoff.** Run ERC before import; resolve every power-input, pin-type, unconnected, and variant exception deliberately. Annotate reference designators, values, MPNs, polarity, footprint, no-fit/DNP state, test requirements, and net names. Compare the imported PCB netlist to the released schematic revision and BOM checksum. JLC's article describes the schematic-to-PCB transfer; that transfer is not proof that the symbol, footprint, pin-one, pad stack, or 3-D body is correct.

**Constraint hierarchy.** The order is: law/safety and component absolute limits; interface-standard requirements; board-specific electrical/thermal/mechanical requirements; current fabricator and assembler capability; then style preferences. A preferred 45-degree routing style never overrides a creepage, impedance, or return-path requirement.

## 2. Stack-up and fabrication constraints: make the physical board real first

Select the fabricator and provisional stack-up before critical routing. A trace impedance is set by actual width, copper thickness, dielectric thickness/permittivity, solder mask, adjacent copper, and reference geometry—not by a generic “50-ohm width” copied from another board. JLC's current impedance calculator explicitly asks for layers, finished thickness, copper weights, target impedance, pair spacing, and conductor-to-ground gap; its accepted ranges are 20–90 ohm single-ended and 50–150 ohm differential [JLC calculator guide](https://jlcpcb.com/help/article/user-guide-to-the-jlcpcb-impedance-calculator). Use its quoted stack-up/field-solver result for a JLC order, then put the resulting width, spacing, layer, reference plane, and tolerance into the controlled-impedance rule.

For a dense or fast board, prefer a stack-up that puts a signal layer adjacent to an uninterrupted ground reference plane. A common four-layer starting point is signal / ground / power / signal, but it is not a universal answer: the approved fabricator stack-up and routing density decide it. Analog Devices notes the value of a complete ground layer; TI also notes that nearby power/ground planes contribute high-frequency capacitance [ADI MT-031](https://www.analog.com/media/en/training-seminars/tutorials/MT-031.pdf), pp. 4–5; [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), p. 13.

**JLC-specific capability snapshot, not a design target.** JLCPCB currently lists 1-oz minimum trace/space as 0.10/0.10 mm for 1–2 layers and 0.09/0.09 mm for multilayer, with a stated ±20% trace-width tolerance; heavier copper has larger listed minima. Its page also gives annular-ring, drill/copper-clearance, solder-mask, and via-in-pad constraints [JLC: PCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/). These are a starting boundary, not permission to place every feature at the minimum. Margin should be chosen for yield, impedance tolerance, assembly, reliability, and cost. Recheck the live quotation/capability page at order time.

### Board outline and floorplan

1. Import or draw the verified outline; lock mounting holes, edge cuts, panel rails/tab routes if applicable, connector envelopes, antenna/edge keepouts, displays, switches, LEDs, heat-sink/clamp regions, and height limits. Add courtyard/assembly keepouts, not only copper keepouts.
2. Place external interfaces by the enclosure datum and mating direction. Check screw heads, cable exit and bend, tool access, and whether a human can reach service/test points after assembly.
3. Divide the board into functional regions—power entry/conversion, noisy switching/high-current, digital processing, clocks/high-speed I/O, analogue/reference/sensing, RF, and connectors. The division is a **current-loop and coupling map**, not automatically a split-plane map.
4. Reserve routing channels and return-plane continuity before packing the board. Critical escape paths for fine-pitch devices, connector pin ordering, and differential-pair exits can determine placement.
5. Put hot components where heat can leave and where they cannot bake temperature-sensitive parts. Include copper area, thermal vias, airflow, enclosure contact, and neighbour derating in the thermal path.

This expands the JLC article's recommendations to group related parts, place critical devices first, and leave heat-dissipation room [JLC: current guide](https://jlcpcb.com/blog/guide-to-pcb-layout-design). It also creates an auditable reason for every placement.

## 3. Placement: route the physics before the convenience

**Placement order.** Lock mechanical parts; then power-entry/protection, regulators and their mandatory capacitors/inductors; clock/RF/analogue reference parts; processors/FPGAs and memory; high-speed connectors; local decoupling; remaining passives; then test points, fiducials, labels, and optional parts. The exact order changes when a vendor reference layout says otherwise.

**Decoupling is a loop, not a nearby symbol.** For each IC rail, identify the current loop from power pin through the capacitor to ground/reference and back. Put the required capacitor at the power pin with a short, wide, low-inductance connection and an appropriate ground-via path. TI's high-speed note recommends the smallest-value capacitor closest to the device and direct/multiple low-impedance ground vias; its details are device-context guidance, not a universal component count [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), pp. 12–13. Do not substitute a generic capacitor value for a datasheet's required network.

**Power-converter exception.** Copy the relevant approved reference/EVM layout as closely as the device datasheet permits. For the TI buck example, the input capacitor is placed and routed first because parasitic inductance in the VIN/PGND loop causes voltage spikes; the switch node is minimized; the output capacitor and feedback sense path receive priority; then quiet small-signal and system connections follow [TI buck layout example](https://www.ti.com/lit/an/slyt614/slyt614.pdf), pp. 1–4. This is strong evidence for a switcher, not a license to blindly apply its single-point-ground topology to an unrelated circuit.

**Placement review questions.** Can every critical net leave a pin without stubs or detours? Does each decoupler actually connect to its intended pin/plane? Are sensitive references, crystal networks, sensor inputs, and feedback dividers outside switch-node/clock/high-current fields? Can a contract manufacturer place, inspect, and rework every part? Are polarities and pin-one indicators visible after assembly? Does the 3-D board fit the product?

## 4. Power, ground, return paths, and partitions

Treat every trace as a complete outgoing-and-returning current loop. At high frequency the return current concentrates near the signal's reference plane beneath/above the trace, rather than using the geometrically shortest DC path [TI SPNA129A](https://www.ti.com/lit/pdf/spna129a), pp. 2–3. Therefore:

- Keep a continuous reference plane under controlled-impedance, clock, fast-edge, and sensitive analogue routes. Do not cross a split, slot, void, anti-pad bottleneck, board cutout, or unrelated-plane boundary without an explicitly designed return transition.
- When a signal changes reference layers, provide a nearby stitching path that connects the old and new reference conductors as appropriate. TI shows that ground vias near a signal via reduce the return-loop area; a layer change can also introduce impedance discontinuity [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), pp. 14–16.
- Inspect every ground pour for islands, narrow necks, and accidentally disconnected ground pins. ADI specifically warns that an isolated ground island has no return path [ADI MT-031](https://www.analog.com/media/en/training-seminars/tutorials/MT-031.pdf), p. 4.
- Size power copper from current, allowed temperature rise, copper weight, voltage drop, fuse/connector ratings, and thermal path. Use planes/pours when appropriate, but verify neck-downs at pads, vias, connectors, fuses, and plane voids.

### Analogue, digital, and power regions

Start with one continuous ground plane when it supports all required return paths. Place and route functions so digital/switching return currents do not run through sensitive analogue areas. TI explicitly presents functional placement on a complete plane as the preferred solution when possible [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), pp. 10–11.

Split planes are an **exception requiring a current-flow drawing**: isolation or a known high-current/DC-drop problem may justify them. If split, define the one intended bridge/common point, make every crossing signal traverse it with its return, and prohibit any other crossing. TI warns that crossing a split creates SI/EMI risk even for nominally slow signals carrying high-frequency noise [TI SPNA129A](https://www.ti.com/lit/pdf/spna129a), p. 3. For a mixed-signal IC, follow its pin-specific ground/decoupling instructions; package substrate connections can invalidate simplistic “AGND versus DGND” labels.

Power-stage loops are separate from quiet-signal grounding. Keep the high `di/dt` input loop, switch node, catch path, inductor/output loop, and gate drive compact; keep feedback/Kelvin sensing away from the switch node. Give thermal pads and high-current return paths enough copper/vias without accidentally coupling their noise into the reference/sense network.

## 5. Routing plan, net classes, geometry, and vias

### Establish net classes before routing

Net classes turn requirements into machine-checkable constraints. KiCad supports routing and clearance rules per net class, including an aggregate effective class when a net has more than one assignment [KiCad PCB Editor, Net Classes](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.pdf). The exact syntax differs by EDA tool; the intent does not.

| Class | Typical constraints to enter | Release evidence |
|---|---|---|
| Default low-speed | Fabrication width/space, nominal via, clearance | DRC clean |
| Power/high current | Minimum copper and via count, neck-down review, clearance, thermal/current calculation reference | Current/temperature and connector/fuse review |
| High voltage/isolation | Creepage/clearance, keepouts, slots/barriers, no copper crossing | Applicable-standard and mechanical review |
| Controlled single-ended | Approved layer, width, reference plane, impedance target/tolerance, stub limit | Stack-up/field-solver result and return-path review |
| Differential pair | Pair width/gap, layer, target Zdiff, length/skew, pair-via symmetry, coupling keepout | Pair report and impedance evidence |
| Clock/RF/sensitive analogue | Reference continuity, spacing/guard policy, maximum via/stub policy, topology | Datasheet/reference-design and SI/EMI review |
| Switch node / noisy power | Copper-area maximum or keepout, no sensitive adjacency | Power-loop visual review |

Do not use “high speed” as a class without a measurable condition. Classify by edge rate, topology, interface specification, analogue sensitivity, and the actual interconnect length versus rise time. The signal owner must supply targets and allowed exceptions.

### Route in an intentional order

1. **Locked power/return geometry:** power entry, protection, switcher hot loops, regulator feedback/Kelvin paths, and required decoupling connections.
2. **Timing and impedance critical:** clocks, memory, RF, differential interfaces, controlled single-ended links, and sensitive references. Preserve reference continuity before consuming routing channels.
3. **Sensitive analogue:** inputs, references, sense/feedback, and low-level measurement paths, isolated from aggressors according to the device guidance.
4. **Other digital/control nets**, then general low-speed signals.
5. **Copper fills, stitching, thermal reliefs, labels, and cleanup**, followed by another full rule check; a fill can create a neck, island, slot, or changed impedance environment.

Use the actual topology: daisy-chain, fly-by, point-to-point, star/Kelvin, termination placement, AC-coupling position, and pair polarity must come from the interface/device documentation. “Route shortest first” loses to a topology or timing rule.

### Trace geometry: 45 degrees, reversals, and exceptions

Use 45-degree or smooth/arc corners as the default layout style for ordinary routing. It is easy to inspect, avoids sharp-angle fabrication concerns, and TI identifies the corner-capacitance/impedance discontinuity concern for right-angle fast traces; it recommends two 45-degree corners or a round bend [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), p. 14. This is **general good practice, not a universal electromagnetic law**: a short 90-degree bend on a slow net is not automatically a functional failure, while a meandered 45-degree route with a plane gap can be much worse.

Forbid gratuitous reversals, zig-zags, acute slivers, and ornamental meanders because they add length, discontinuities, crosstalk exposure, and inspection ambiguity. A reversal is justified only when it performs a named function—length/skew tuning, a required delay, an escape, creepage maintenance, a current/thermal route, or a mechanical keepout—and must carry an annotation or rule-report evidence. When tuning, include the pair's actual field coupling, reference-plane continuity, and via asymmetry; do not tune by geometric length alone.

### Vias and transitions

A via is a designed discontinuity, not merely a routing shortcut. It adds inductance, capacitance, length, and potentially a stub. TI specifically cautions about these effects and asks that differential pairs transition symmetrically when transitions cannot be avoided [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), pp. 14–16.

- Minimize vias in impedance-critical, RF, and very-fast paths unless the stack-up and transition were analysed.
- When a pair changes layers, use matched geometry and return-path stitching; document the allowable skew.
- Give high-current vias enough parallel barrel area and margin, but check the actual drill, plating, current, thermal cycling, and bottleneck model. “One via per amp” is only a rule of thumb in one TI buck example, not a portable requirement.
- Keep via-in-pad, microvia, backdrill, filled/capped via, and blind/buried via choices tied to an approved fabrication capability and assembly process. JLC's via-in-pad availability/cost/process is **JLC-specific** and must be rechecked on the selected stack-up [JLC capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/).
- Do not put return/via fences blindly around every net; use them where the frequency, field containment, edge/radiation, or reference transition analysis warrants them.

## 6. Design for manufacture, assembly, test, and service

Fabrication DRC is necessary but does not validate assembly. Apply the selected assembler's component spacing, stencil, paste, orientation, panel, fiducial, tooling-hole, and bottom-side restrictions. JLC's current SMD-spacing guide says its recommendations account for paste printing, placement accuracy, AOI, and manual rework accessibility [JLC: SMD spacing](https://jlcpcb.com/help/article/minimum-spacing-for-smd-components). That is useful when JLC is the assembler; another assembler's limits control another build.

**Testability plan before route completion.** For every production/debug requirement, identify the net, intended stimulus/measurement, test-point style, fixture access direction, ground reference, and what condition makes the measurement valid. Provide safe access to rails, reset/programming, key buses where reasonable, critical control/sense nodes, and a nearby ground. Keep test pads away from high-voltage/fast-switch nodes unless a guarded, rated procedure exists. Avoid using tiny component pads as assumed test points; they may be inaccessible, thermally fragile, or invalid due to probe/lead inductance.

Perform a 3-D/assembly visual pass: polarity and pin-one marks, connector keys, no component under an enclosure boss, no blocked screw/test point, readable labels, consistent diode/LED/electrolytic orientation, courtyard collisions, panel breakaway damage risk, and rework-tool access. Export manufacturing data only from the reviewed revision: Gerbers or IPC-2581 as agreed, drill/route, fab drawing/stack-up, pick-and-place, BOM with approved alternates, assembly drawing, paste/stencil outputs, centroid/orientation convention, and test document.

## 7. Verification gates: ERC, DRC, visual review, and sign-off

No single green check means “works.” Use gates that each answer a different question.

| Gate | What it proves | Required reviewer evidence | Typical blockers |
|---|---|---|---|
| Schematic/ERC | Logical connections and declared electrical exceptions are reviewed | ERC report; approved exception list; BOM/footprint cross-check | Unpowered pins, wrong pin types, accidental NCs, missing required parts |
| Constraint/stack-up | Routing rules correspond to a real build | Constraint register; fabricator stack-up/capability snapshot; impedance calculation | Generic stack-up, undefined copper/finish, unassigned critical nets |
| Placement/physics | Critical loops and mechanical zones have a plausible layout | Annotated placement/return-current screenshots; 3-D check | Decoupler remote from pin, switcher loop large, no test/rework access |
| DRC/DFM | Geometric rules and chosen fabrication limits pass | Clean DRC; deliberate waivers; independent fabricator preflight if available | Clearance/width/drill/mask/courtyard/plane-island violations |
| Electrical review | SI/PI/thermal/EMI risks are addressed at intended use | Datasheet/EVM comparison; calculations/simulation or rationale; net reports | Split crossing, wrong impedance layer, unmatched pair transition, undersized bottleneck |
| Manufacturing/test | The board can be built, inspected, programmed, and tested | Gerber/drill/BOM/PnP review; assembly/test drawings | Missing fiducial/test access, ambiguous rotations, unavailable part/finish |
| Release | Outputs are internally consistent and traceable | Revision/tag, checksum, review sign-off, waiver list | Output mismatch, unresolved `Open` input, unowned exception |

**Visual review is a first-class gate.** Turn off nonessential layers and inspect each copper layer, then inspect all layers together. Highlight each critical net class; follow its outgoing and return path; view all plane voids and pours; inspect every layer change, connector escape, high-current neck, differential transition, and programmed/analogue test point. Run a final `ratsnest/unrouted = 0` check, then re-run DRC after refills and after fabrication-output export. For every waived violation, record net/object, rule, reason, risk, reviewer, and expiry/revisit condition; never simply suppress it.

## 8. Three concrete review examples

### A. 12 V to 3.3 V buck region

Place input connector/protection, regulator IC, input ceramic, inductor, output capacitor, and feedback parts as one local functional block. First verify the manufacturer reference layout and IC pinout. Keep the input-capacitor/IC power-ground loop tight; keep the switch-node copper compact and away from feedback/analogue/connector paths; place the output capacitor and feedback sense according to the datasheet. Route the hot loop before every general signal. Add thermal/ground vias as required by the package while preserving quiet feedback routing. The evidence here is the actual regulator datasheet/EVM plus a loop-area screenshot; TI's TPS62130 example explains the reason and sequence but does not validate another regulator [TI buck layout example](https://www.ti.com/lit/an/slyt614/slyt614.pdf).

### B. MCU plus ADC/sensor board

Use functional placement: noisy clock/MCU/IO in one region, sensor/front-end/reference in another, with a continuous ground plane if the intended return currents can remain local. Put reference and local decoupling components at their pins, protect sensor routing from clock/switcher aggressors, and do not route digital lines across an analogue-plane split. If a split is proposed, draw the bridge and every crossing return path; otherwise reject it. Validate with the ADC's own datasheet/reference layout. This is the precise correction to a blanket “always split AGND/DGND” rule.

### C. Controlled-impedance differential interface

Before placement, obtain the fabricator stack-up and calculate the pair width/gap on its chosen layer. Assign a differential net class with pair gap, width, target impedance, length/skew, and via symmetry. Keep its reference plane uninterrupted; avoid stubs and unrelated copper changes; route the pair together through the connector and IC escape. If layer change is unavoidable, make the pair's transitions symmetric and provide the correct return reference stitching. Tune only after the true route exists, and record final length/skew from the EDA report. A generic 90-degree-or-45-degree rule is secondary to impedance, pair symmetry, and return continuity.

## 9. AI-agent operating procedure

An AI layout agent may accelerate clerical inspection and proposal generation, but it must not silently turn missing engineering inputs into fabricated constraints.

1. **Ingest and fingerprint:** read schematic, BOM, footprints, board file, revision, datasheets, stack-up, enclosure drawing, fabricator/assembler selection, and prior waiver list. Emit a file/revision manifest.
2. **Build a constraint ledger:** extract every explicit voltage, current, interface, component layout note, package/thermal constraint, impedance target, and mechanical limit. Mark each `source`, `confidence`, and `Open`. Ask for or block on consequential missing values (for example, selected fabricator or maximum current), rather than guessing.
3. **Classify nets:** create a table of power, high voltage, high-current, controlled impedance, differential, clock, RF, analogue-sensitive, switch node, programming, and test nets. Propose net classes but do not apply a numerical width/clearance without its source.
4. **Place with explanations:** lock mechanics first, then propose functional zones and critical loops. For every move, state the electrical/mechanical reason and the source/datasheet page. Never alter a component footprint, polarity, pin mapping, net name, or safety keepout without a traceable request and review.
5. **Route by priority:** reserve return paths and critical routes; use the routing order in this dossier; flag each plane crossing, via transition, unconnected net, acute/sliver shape, gratuitous reversal, and high-current neck. An agent may suggest a 45-degree cleanup but must preserve named constraints first.
6. **Run independent checks:** invoke ERC/DRC and fabrication preflight; parse all violations; inspect generated Gerbers/IPC output separately from the editable board; compare BOM/PnP/reference designators. A tool's “pass” must be reported as a pass against *configured rules*, not a certification of electrical performance.
7. **Produce a review packet:** constraint ledger, unresolved inputs, net-class table, DRC/ERC reports, waiver list, screenshots of stack-up/critical loops/return paths/plane continuity, manufacturing outputs, and a diff from the prior revision. A human owner signs off safety, compliance, component-specific layouts, SI/PI/thermal judgments, and every waiver.

**Agent stop conditions.** Halt and escalate for unknown selected fabricator/stack-up, missing device layout guidance for a critical IC, unknown max current/voltage or isolation requirement, an impedance/length target without a reference plane, unresolved ERC/DRC, a plane-split crossing, mismatched BOM/footprint, or any discrepancy between editable data and manufacturing output.

## 10. Unresolved-input checklist for this dossier's application

This article review has no target board attached. The following must be supplied to turn it into board-specific rules: board stack-up and vendor quote; copper/finish/material; max current and temperature rise by net; voltage/isolation standard; interface speed/rise time/topology and impedance/skew; full component datasheets/reference layouts; enclosure CAD and operating ambient; assembly/test method; regulatory/ESD/EMC requirements; and release authority. Until then, all numerical widths, clearances, via counts, capacitor choices, thermal-via patterns, and ground-split decisions remain proposals, not requirements.

## Source ledger and claim boundaries

| ID | Source, publisher, date/status | What it supports | Boundary/limitations |
|---|---|---|---|
| S1 | [The Ultimate Guide to PCB Layout Design](https://jlcpcb.com/blog/guide-to-pcb-layout-design), JLCPCB, current article accessed 2026-09-06 | Reviewed article's workflow, placement prompts, planes/tracks/testing discussion | Vendor blog; broad guidance; supplied old URL redirected to a 404 page |
| S2 | [PCB Manufacturing & Assembly Capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/), JLCPCB, live page accessed 2026-09-06 | JLC current trace/space, annular ring, mask, via-in-pad capability snapshot | JLC-only, live data may change; capability is not yield target or electrical validation |
| S3 | [JLCPCB Impedance Calculator guide](https://jlcpcb.com/help/article/user-guide-to-the-jlcpcb-impedance-calculator), JLCPCB, updated 2026-06-15 | Inputs needed for JLC impedance/stack-up calculation | JLC calculator scope; confirm quoted stack-up/order settings |
| S4 | [Minimum Spacing Requirements for SMD Components](https://jlcpcb.com/help/article/minimum-spacing-for-smd-components), JLCPCB, updated 2026-06-12 | Assembly, inspection, and rework rationale for spacing | JLC-specific assembly guidance; use selected assembler rules |
| S5 | [High-Speed Layout Guidelines, SCAA082A Rev. A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), Texas Instruments, revised 2017 | Return paths, continuous planes, decoupling placement, 45-degree guidance, via/differential transition risks | Generalized TI application note; device/interface-specific datasheets prevail |
| S6 | [Five steps to a great PCB layout for a step-down converter, SLYT614](https://www.ti.com/lit/an/slyt614/slyt614.pdf), Texas Instruments, 2015 | Buck hot-loop, switch-node, output/feedback and quiet-ground placement sequence | Example TPS62130A/TI topology; do not transplant blindly |
| S7 | [Interfacing the Embedded 12-Bit ADC in a TMS570, SPNA129A Rev. A](https://www.ti.com/lit/pdf/spna129a), Texas Instruments, 2011 | High-frequency return concentration; hazards of split-plane crossings; ADC decoupling specifics | TMS570 context; split-plane conclusion depends on current flow/system |
| S8 | [MT-031: Grounding Data Converters](https://www.analog.com/media/en/training-seminars/tutorials/MT-031.pdf), Analog Devices, 2009 | Complete ground plane, island/neck inspection, mixed-signal grounding context | Tutorial/reference-design context; newer part guidance may be more specific |
| S9 | [PCB Editor documentation 9.0](https://docs.kicad.org/9.0/en/pcbnew/pcbnew.pdf), KiCad Project, current documentation accessed 2026-09-06 | Net classes, pair routing and length-tuning capabilities | Tool documentation, not a physical-design standard; other EDA tools differ |

**Research stop rationale.** The reviewed article's material claims were cross-checked against current JLC service documentation, an EDA primary manual, and component-vendor application notes for the high-consequence areas: stack-up/DFM, return paths/grounding, decoupling, switcher loops, geometry, and vias. Further generic “PCB tips” sources would be redundant. Board-specific conclusions are intentionally withheld pending the unresolved inputs above.

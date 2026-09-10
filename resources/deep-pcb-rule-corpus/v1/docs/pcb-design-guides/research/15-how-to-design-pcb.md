# Evidence dossier: how to design a PCB from requirements to reviewed release

**Research date:** 2026-09-06  
**Audience:** PCB designers, reviewers, and AI-assisted engineering teams.  
**Scope and provenance:** As of the research date, the user-supplied URL, [*How to Design a PCB? PCB Layout Engineer Must Know!*](https://jlcpcb.com/blog/how-to-design-a-pcb-pcb-layout-engineer-must-know), redirects to JLCPCB's 404 page. It is recorded as the requested reference only; no technical text is attributed to it. The technical discussion in this dossier uses JLCPCB's live canonical article, [*How to Design a Complete PCB Layout? PCB Layout Engineer Must Know!*](https://jlcpcb.com/blog/complete-pcb-layout-guide), and attributes JLCPCB technical guidance only to that canonical page. This dossier expands that live article into an evidence-backed, tool-neutral workflow. It covers ordinary electronic rigid-PCB work. It is not a substitute for the current datasheet/reference layout of a chosen component, a fabricator's ordered stackup/capability statement, an EMC/safety/compliance program, or a production-quality system.

**Evidence key:** **High** means an official EDA document, component-maker document, or a specific released manufacturing capability supports the claim. **Medium** means sensible process guidance from the article or an engineering inference that must be checked for the project. **Project-specific** means no general guide can establish it. “Pass” always means pass against documented, version-controlled rules, not merely a green tool icon.

## Direct conclusion

A PCB is ready to route only after its requirements, exact parts, interfaces, stackup, fabrication/assembly constraints, and verification plan have been turned into **reviewable constraints**. A PCB is ready to fabricate only after the routed design, export set, and manufacturing assumptions have been independently checked. A fabricated prototype that powers up is evidence of **proof-of-concept usability**, not evidence of release qualification.

The live canonical JLCPCB guide has the right backbone: verify the schematic; set rules from the manufacturer; place by function; route deliberately; use ground copper for low-impedance return paths; run DRC; inspect in 3D; and inspect exported manufacturing files. Its useful message is process order, not universal numeric rules. Trace/space, via geometry, impedance, solder-mask behavior, stackup, assembly process, part layout, and safety distances must come from the **actual ordered service and actual components**, not copied from a blog or another board.

## The decisive boundary: a working prototype is not a released design

| State | What it can honestly establish | What it does **not** establish | Minimum next gate |
|---|---|---|---|
| Paper/design concept | The functions and interfaces seem plausible. | Correct circuit, parts, layout, or manufacturability. | Requirements and architecture review. |
| Schematic/ERC-clean | Declared schematic connectivity and electrical-pin rules contain no unresolved in-scope tool findings. | Correct values, pin mapping, power integrity, layout, safety, or behavior. | Datasheet/part/library review and PCB constraint release. |
| DRC-clean layout | Geometry and connectivity meet the configured DRC rules. | That the rules match the fab, that a board will assemble, or that it meets SI/PI/thermal/EMC needs. | Fabricator/assembly DFM, output review, and independent layout review. |
| Board powers up / one demo works | One specimen performed one observed task in one setup. | Yield, lifetime, tolerance, temperature, ESD/EMC, all use cases, serviceability, or production conformance. | Instrumented bring-up and a requirements-based validation plan. |
| Qualified release | Evidence covers stated requirements, process capability, configuration control, exceptions, and acceptance criteria. | Future revisions or substitutes. | Controlled release; requalify affected scope on change. |

Do not relabel “prototype works” as “manufacturing-ready,” “reliable,” “compliant,” or “safe.” Those claims need defined acceptance criteria and evidence. Conversely, a failure in a first spin is useful information when the design, build record, and test conditions let the team isolate it.

## 1. Turn requirements into a design contract

Before capture or placement, write a concise requirements-and-constraints record. It is the source against which reviewers decide whether the board is complete.

| Requirement family | Record before layout | Design evidence / owner |
|---|---|---|
| Function and interfaces | Modes, data rates, direction, pinouts, logic levels, cable/mating assumptions, firmware pins, startup and fault states. | Block diagram, interface-control table, schematic review. |
| Electrical | Input range/transients, rails, peak/steady current, load profiles, accuracy, timing, isolation, protection, current paths. | Calculations, datasheets, simulation where applicable, test plan. |
| Physical | Envelope, board outline, thickness, mounting holes, connector access, keepouts, enclosure, service access, mass restrictions. | Mechanical drawing/3D review. |
| Environment and lifecycle | Temperature, vibration, moisture, voltage category, duty cycle, maintenance, expected lifetime, sourcing policy. | Part ratings, derating policy, qualification plan. |
| Performance | Noise, impedance, bandwidth, latency, emission/immunity, thermal limits, analog accuracy. | Stackup/constraint table, analysis, measurement plan. |
| Build and test | Fab/assembly service, quantity, panelization, finish, stencil, test coverage, programming, calibration, traceability. | Fab/CM capability confirmation, test fixture/coverage plan. |
| Governance | Revision scheme, approved libraries, required standards/customer rules, reviewers, waiver authority, release artifacts. | Release checklist and change log. |

**Gate R0 — requirements complete:** every requirement has an acceptance method, owner, and source; unknowns are explicitly risk items. “Use standard values” and “make it small” are not requirements. For high voltage, medical, automotive, aviation, RF, or regulated work, identify the controlling standard/customer specification before selecting clearances, materials, or test scope.

## 2. Architecture before schematic capture

Partition the system into electrical and physical zones: power entry/protection, conversion, digital/control, analog/RF, high-current load, connectors, programming/debug, and test. Draw energy flow, signal flow, clock/reference paths, fault paths, return-current paths, and mechanical boundaries. Decide early whether an interface needs isolation, level translation, filtering, termination, ESD protection, shielding/chassis treatment, or a test point.

Architecture should answer questions a routed board cannot safely answer late:

- Where do current and heat originate and return?
- What turns on first, and what happens at brownout, reset, unplug, reversed power, and fault?
- Which net classes are high current, sensitive analog, fast edge, controlled impedance, differential, high voltage, or safety-critical?
- What can cross a connector, and what is allowed to touch an enclosure or user?
- What must be measured, programmed, calibrated, or reworked after assembly?

The JLCPCB article's functional-zone placement recommendation is **Medium** evidence for a broadly useful workflow. The zone boundaries themselves are project-specific. Do not decide that “analog and digital grounds must always be split.” TI's mixed-signal guidance shows a specific converter-centered split/connection topology; it also explains that its suitability changes for more complex systems. Follow the exact IC/application guidance and the system's return paths, rather than a slogan ([TI, *Grounding in Mixed-Signal Systems Demystified, Part 2*](https://www.ti.com/lit/an/slyt512/slyt512.pdf)).

**Gate A1 — architecture accepted:** block interfaces, critical paths, domains, protection boundaries, and verification approach are reviewed before a library or layout commitment locks them in.

## 3. Schematic: the logical source of truth, not a sketch

Capture a readable schematic in functional blocks. Give every net an intentional name, every component an identity, and every non-obvious requirement a note or linked constraint. The supplied article correctly says an error in a schematic propagates into layout; that makes schematic organization and review an engineering control, not cosmetic work.

### Schematic discipline

1. Use the exact orderable part's current datasheet and recommended application circuit. Capture mandatory capacitors, pulls, straps, sequencing, exposed-pad, unused-pin, and protection requirements.
2. Use scoped, meaningful labels (`VIN_RAW`, `3V3_A`, `USB_D_P`, `MOTOR_A_FAULT_N`) rather than generic labels. Establish an active-low convention and do not reuse a global label for unrelated domains.
3. Make every connector unambiguous: pin number, mating orientation, voltage/domain, direction, protection/termination ownership, and chassis/shield relationship where applicable.
4. Make configuration deterministic. Every enable, reset, boot, address, mode, and unused pin is tied, pulled, strapped, marked NC, or documented according to the datasheet.
5. Capture power intent: source, protection, conversion, decoupling, return-domain names, sense/Kelvin connections, and high-current paths. The schematic must state *what* belongs together; the PCB later proves *how closely and with what impedance*.
6. Avoid implicit behavior. Hidden power pins, power symbols, library aliases, bus syntax, and global labels require inspection of the generated netlist in the selected EDA tool.

KiCad documents the preferred model of updating a PCB from its schematic rather than importing an old netlist, and explicitly states the board contains footprints, nets, tracks, vias, zones, and graphical layers ([KiCad PCB Editor 8.0](https://docs.kicad.org/8.0/en/pcbnew/pcbnew.html)). That is **High** evidence for KiCad 8 behavior; other EDA tools must be verified in their own versioned documentation.

### Libraries are controlled engineering data

For each unique component, independently check:

- symbol pin numbers/names/electrical types, multi-unit partitions, polarity, NCs, hidden pins, and exposed/thermal pad;
- footprint land pattern, pin 1, package variant, paste/mask design, courtyard, body/height, connector mating orientation, and 3D model as a visual aid only;
- manufacturer part number, package suffix, rating/tolerance/dielectric, lifecycle/source status, datasheet revision, and permitted alternate;
- footprint-to-symbol association and PCB pad mapping.

An internally consistent wrong symbol/footprint pair can pass ERC and DRC and still make an unusable board. Lock a reviewed library revision for the release. A community library, a vendor download, or AI-generated footprint is input to review, never proof of correctness.

**Gate S2 — schematic release candidate:** ERC findings are resolved or locally waived with rationale; netlist, connector table, power tree, pin mapping, BOM fields, and PCB associations have human review. “No errors” is insufficient if the ERC rule set or symbols are wrong.

## 4. Constraint system and stackup: make physical promises explicit

Set layout rules before placement/routing, based on the fab's selected service, layer stackup, copper weights, finish, drilling/laser-via capability, assembly method, and device requirements. The JLCPCB article identifies width, clearance, via size, and stackup as fundamental pre-routing choices; retain that sequence, but consult the current order-specific capability page/quote rather than publishing a universal number.

Create named net classes/rules for at least: default signals; power/high current; high voltage/creepage; analog sensitive; clocks/fast edges; differential pairs; controlled impedance; RF; test; and no-copper/mechanical areas. Record each rule's source, exact value, layer scope, and owner.

| Constraint | Must define | Typical evidence required |
|---|---|---|
| Fab geometry | Minimum width/space, annular ring, drill, via type/aspect limit, copper-to-edge, mask sliver/expansion, route/score limits. | Selected fab capability and DFM response. |
| Stackup/impedance | Layer order, dielectric thickness/material, copper thickness, reference planes, target impedance, pair geometry/tolerance. | Fabricator stackup/impedance calculation, not a generic calculator alone. |
| Electrical spacing | Clearance, creepage, isolation slots, voltage domains, pollution/material/environment assumptions. | Applicable standard/customer requirement and project calculation. |
| Component geometry | Courtyard, body height, keepouts, connector insertion, tool access, fiducials, panel rails. | Datasheet/package and assembler rules. |
| Performance | Max length/skew, pair coupling, via/return-via rules, sensitive-net keepouts, current capacity/temperature rise. | IC/vendor guide, analysis, and test plan. |

KiCad supports custom constraints such as fixed RF width, BGA neck-down, differential-pair gap, differential-pair clearance, and copper keepouts ([KiCad custom-rule examples](https://docs.kicad.org/8.0/en/pcbnew/pcbnew.html)). This proves that a modern EDA tool can encode project rules; it does **not** determine the values for any specific board.

**Gate C3 — constraints approved:** every critical net/category maps to explicit electrical, physical, and manufacturing constraints. A default-rule board is not assumed qualified.

## 5. Placement: solve the board's physics before routing prettiness

Placement dominates routing. Start with the mechanical outline, mounting, connectors, displays, switches, antennas, edge clearances, and enclosure keepouts. Then place large/critical ICs and functional blocks, power entry/conversion, high-current loops, local decoupling, clocks, analog references, and supporting passives. Only then compact for manufacturability and routability.

Placement review questions:

- Can the board be installed, plugged, programmed, tested, and serviced in the intended enclosure?
- Does every decoupler have a short, direct power-to-device/return loop on the intended reference structure?
- Are switching loops compact; are noisy/high-current regions away from sensitive analog/RF inputs?
- Are thermal pads, heat sources, planes, airflow/contact areas, and heat-sensitive parts accounted for?
- Are polarization/orientation, labels, pin 1, connector keying, and optical/physical access clear for assembly and inspection?
- Is there room for soldering, rework, fixtures, panel breakaway, fiducials, and test probes?

For high-speed guidance, TI explains why capacitance alone is not enough: parasitic inductance/resistance and trace geometry affect real decoupling. It recommends the lowest-value decoupler as close as possible to the device/power pin and a direct ground-via connection appropriate to the application ([TI, *High-Speed Layout Guidelines*, SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf)). Treat component-specific datasheet layout as the higher-priority source.

**Gate P4 — placement freeze:** independent review has checked mechanical fit, device-specific reference-layout requirements, critical current/return loops, test access, and thermal approach. Do not route around a placement failure; move the parts or revise the architecture.

## 6. Routing, return paths, power, and ground

Route in an intentional order: critical impedance/differential/RF and timing nets; power/high-current paths; sensitive analog; clocks; remaining signals; then ground pours and stitching consistent with the return-path plan. Keep layer transitions and discontinuities deliberate. A trace has a return path; routing a fast trace over a gap/split in its reference plane forces a larger loop and can create SI/EMI problems.

### Power and ground

- Size copper, vias, connectors, fuses, and thermal reliefs for actual current, temperature rise, fault current, and assembly needs; do not use a trace-width anecdote as proof.
- Place input/output/boot/compensation components exactly as the regulator or driver documentation requires. Keep high-di/dt loops short and contained.
- Prefer a continuous reference plane below critical signals where the stackup permits. Add return stitching near a signal layer change when it preserves the intended return path.
- Use pours/planes only after verifying they connect to the intended net, do not create isolated islands, do not violate clearance, and do not obstruct thermal or test requirements.
- Consider ground partitions only as an explicitly reviewed solution. The relevant device application guide governs where analog/digital/power/chassis returns meet.

TI's motor-driver layout note illustrates the general thermal/return principle: a thermal pad needs a continuous copper exit path and several thermal vias to connect to broader copper/ground area, but the exact geometry belongs to the device/package layout guidance ([TI, *Best Practices for Board Layout of Motor Drivers*, SLVA959B](https://www.ti.com/lit/an/slva959b/slva959b.pdf)). Its two-layer discussion also cautions that noisy high-current circuitry should be kept away from sensitive signals when an unbroken plane is difficult ([same source](https://www.ti.com/lit/an/slva959b/slva959b.pdf)). These are **High** for their physical mechanisms, **Project-specific** for board decisions.

### Signal routing

- Match differential pair polarity at both ends before length matching. Match only to a documented skew budget, using the selected stackup and real topology.
- Keep controlled-impedance geometry and reference plane continuous; use the fab's stackup/field solver/service, not a generic width rule.
- Separate aggressors and victims by topology, plane reference, geometry, and edge rate. Parallel proximity, not just clock frequency, drives coupling risk.
- Keep crystals, references, sense lines, and analog inputs within the relevant IC's recommended layout envelope. Route Kelvin sense separately from load current.
- Avoid “fixing” a constraint failure with arbitrary meanders, narrow necks, or via detours unless the rule/analysis says the tradeoff is acceptable.

**Gate R5 — routing complete:** all net classes are routed to their defined rules; no unrouted/hidden connections remain; critical nets have targeted review rather than a visual glance at the whole board.

## 7. Mechanical, thermal, design-for-assembly, and test

### Mechanical and 3D

The outline must be a continuous, unambiguous manufacturing contour. Validate dimension origin, board thickness, holes as plated/non-plated, slots/cutouts, connector overhang, mounting hardware, keepouts, and enclosure clearance. A 3D viewer can catch obvious collisions and orientation mistakes, but a missing/wrong model can produce false confidence. KiCad describes its 3D viewer as useful for inspection; use it as a visual check alongside the actual mechanical drawing ([KiCad Getting Started 8.0](https://docs.kicad.org/8.0/en/getting_started_in_kicad/getting_started_in_kicad.html)).

### Thermal

Calculate or model dissipation, then design and measure the whole thermal path: silicon/package, solder, thermal pad, vias, copper area, planes, board material, enclosure, airflow, and ambient. A component's junction-temperature rating does not validate its neighboring connectors, capacitors, polymer materials, or the assembled system. Use thermal vias/pour only as the datasheet/package and assembly process allow; confirm solder-wicking/paste treatment for exposed pads.

### Assembly readiness

Define the assembler, process, BOM alternatives, solder paste/stencil needs, fiducials, polarity markings, reference visibility, component-to-component clearance, panel strategy, and rework access. Check that DNP parts, hand-assembly parts, press-fit/through-hole operations, selective solder, adhesives, and unusual finishes are represented in the output set.

### Testability

Design test in at architecture/placement time. Provide accessible, identified test points for power/ground, reset/boot, programming, critical interfaces, calibration signals, and production test boundaries. State probe style, keepout, fixture-side access, safe voltage, and expected readings. Design-for-test is not merely “add pads somewhere”: an unprobeable board or a probe that shorts adjacent pads fails the purpose.

**Gate M6 — mechanical/assembly/test review:** enclosure/connector fit, thermal strategy, assembly constraints, polarity/marking, fixture/probe access, programming, and service access are approved with the chosen manufacturer or explicit prototype-only exceptions.

## 8. ERC, DRC, DFM, review, and output verification are different checks

| Check | Detects well | Does not prove |
|---|---|---|
| ERC | Declared pin-type conflicts, some unconnected/illegal schematic connections. | Correct circuit values, library pin mapping, real behavior, layout or manufacturing. |
| DRC | Configured copper/geometry/connectivity rule violations. | Correct rules, fab yield, assembly, SI/PI, thermal, safety, or EMC. |
| DFM/DFA | Fab/assembly process risks such as geometry, mask, drill, panel, component/process compatibility. | Circuit functionality or system qualification. |
| Netlist/BOM diff | Drift between controlled electrical/component data sets. | Correctness of those sets. |
| 3D/mechanical review | Obvious collision/access/orientation problems. | Fit without accurate models/drawings or tolerance analysis. |
| Prototype test | Observed behavior under recorded conditions. | Unexercised requirement space, yield, lifetime, or compliance. |

KiCad's ERC documentation says the check can find common issues such as unconnected pins, unconnected hierarchy, and illegal output connections, while explicitly warning that ERC cannot detect all errors and depends on correct symbols ([KiCad Schematic Editor 8.0](https://docs.kicad.org/8.0/en/eeschema/eeschema.html)). That limitation should be carried into every tool workflow.

For DRC, use zero unresolved errors as a normal release baseline. Warnings may be accepted only with a local waiver containing: item/location, affected rule, rationale, risk, owner, reviewer, and change/retest trigger. Never globally suppress a rule only to make a report green.

JLCPCB distinguishes DRC from DFM in its verification guide: DRC checks baseline geometry/constraints, while DFM considers real fabrication/assembly risks such as slivers and solder-mask issues ([JLCPCB, *PCB Design Verification Guide*](https://jlcpcb.com/blog/pcb-design-verification-guide)). This distinction is useful **Medium** vendor guidance; the actual fab report and contract capability govern the build.

## 9. Documentation and release package

Release a self-consistent, versioned package rather than a loose Gerber ZIP. At minimum preserve:

- native schematic and PCB project, frozen library snapshot/lockfile, and human-readable PDFs;
- BOM with exact manufacturer/orderable part, alternates, DNP/population state, package, quantity, and lifecycle/source policy;
- fabrication files: Gerbers (or agreed intelligent format), drill/route/slot data, board outline, stackup/material/copper/finish notes, fab drawing, panel requirements; 
- assembly files: centroid/CPL, assembly drawing, BOM, paste/stencil data, polarity/fiducial notes, approved substitution/assembly instructions;
- test/bring-up procedure, programming/calibration data, test-point map, acceptance limits, and revision/serial traceability as applicable;
- DRC/ERC/DFM reports, waiver log, review approvals, known risks, and change log.

KiCad's documented fabrication workflow calls for the required copper, outline, mask, silkscreen, and drill outputs, with paste layers when a stencil is needed ([KiCad Getting Started 8.0](https://docs.kicad.org/8.0/en/getting_started_in_kicad/getting_started_in_kicad.html)). Treat that as an output checklist, then tailor it to the fab/assembler. Generate outputs into a clean release directory, inspect them in an independent viewer or the fabricator's viewer, and compare them to the native board: layers, polarity, paste, drill maps, outline, slot/NPTH, copper pours, text, and origin/orientation.

**Gate D7 — fabrication release:** two reviewers can reconstruct what to build from the package; output inspection agrees with native design; the selected fab/assembler has no unresolved DFM/DFA questions; and every exception is recorded.

## 10. Prototype iteration and qualification loop

1. Record as-built facts: board revision, fab/stackup, assembly/BOM substitutions, rework, firmware, test equipment/calibration, configuration, ambient/load, and anomalies.
2. Bring up safely: inspect for assembly faults; use current-limited power; validate rails and sequencing before enabling loads; then test interfaces and full function. The exact safety sequence is project-specific.
3. Test the requirements matrix, not only the happy path: min/max supply, intended loads, temperature/environment where relevant, startup/reset/fault/recovery, interfaces, margin, thermal steady state, and service/test points.
4. Perform targeted measurement for risks: ripple/transients, return-path noise, timing/eye/overshoot, EMI pre-scan, temperature rise, connector retention, or calibration. Name measurement bandwidth, probe method, setup, and uncertainty.
5. Classify each issue: specification/architecture, schematic, library/footprint, placement/routing, fab/assembly, BOM/source, firmware, test setup, or unknown. Fix the root cause and update the requirements/constraint/review record.
6. Re-run the affected gates after any change. A copper edit can require DRC/DFM/thermal/SI review; a component substitution can require footprint, assembly, performance, and reliability review.

A suitable prototype decision can be: “demonstrates the target firmware and function at 25 °C with bench supply X; thermal, tolerance, ESD/EMC, production assembly, and long-duration tests remain open.” That is stronger engineering than pretending a demo establishes release readiness.

## Frequent mistakes and controls

| Mistake | Why it survives casual checking | Control |
|---|---|---|
| Starting layout before constraints/stackup | Routing creates sunk cost and forces arbitrary exceptions. | Gate C3 before placement. |
| Library footprint assumed correct | A wrong pin 1/exposed pad can remain electrically consistent in EDA. | Datasheet/package drawing-to-library review. |
| Using fab minimums as design targets | Marginal geometry can pass a nominal rule yet hurt yield/cost. | Use margin justified by selected process; tighten only where necessary. |
| “Ground pour” treated as a magic fix | Islands, splits, and discontinuous returns can worsen performance. | Review current loops/reference planes/net connectivity. |
| Decoupler placed after routing | Electrical loop inductance becomes poor even with correct value. | Place from datasheet/reference layout before ordinary routing. |
| Split grounds by habit | A split can force signal return detours. | Follow device/system return-current analysis; document connection point. |
| DRC clean treated as DFM/qualification | DRC only knows its configured rules. | DFM/DFA/output review plus requirements test evidence. |
| Component silhouette/3D model trusted | Model can be missing, stale, or not tolerance-accurate. | Use package drawing and enclosure dimensions. |
| No test points or inaccessible programming | Board cannot be diagnosed or production-tested. | Test coverage/fixture review during placement. |
| Gerbers generated once and never viewed | Export setting/layer/drill/origin mistakes are external to native layout intent. | Independent output review and release manifest. |
| AI fills unknowns with plausible values | A visually convincing layout can embody unverified assumptions. | Evidence ledger, explicit unknowns, human approval gates. |

## AI-assisted workflow: useful acceleration with non-negotiable decision gates

An AI agent can help turn a large record set into checklists, extract candidate constraints from datasheets, compare BOM fields, flag missing test points, summarize DRC/ERC, and generate review questions. It must not be delegated authority to invent a safety distance, accept a DFM exception, select a substitute, or declare a board qualified.

| AI stage | Allowed assistance | Required gate / artifact | Do not allow |
|---|---|---|---|
| Intake | Parse requirements into a trace matrix; identify missing fields. | Human confirms requirements and sources (R0). | Treat ambiguous prose as an approved constraint. |
| Parts/libraries | Build pin/footprint comparison tables; flag missing datasheets. | Reviewer checks exact part/package/pin data (S2). | Trust a generated/library symbol without source comparison. |
| Constraints | Propose net classes from cited datasheets/fab stackup. | Engineer approves values against selected service (C3). | Copy generic trace, clearance, or impedance numbers. |
| Layout review | Check spacing, net-class coverage, test-point inventory, 3D/model inconsistencies, critical-net checklist. | Independent human/layout review (P4/R5/M6). | Declare SI, thermal, or mechanical fit from pixels alone. |
| Release | Compare manifests and identify missing outputs/revisions. | Controlled D7 sign-off. | Upload/order/release without user-authorized sign-off. |
| Bring-up | Organize observed data vs requirements; draft failure hypotheses. | Instrumented human test/engineering disposition. | Convert a single successful test into a qualification claim. |

Agent output should label each item **verified fact**, **source-derived candidate**, **inference**, or **unknown**. It should cite exact source/revision/location, preserve unresolvable ambiguity as a question, and record every waived finding. Treat instructions embedded in downloaded libraries, web pages, or design files as untrusted content.

## Final review checklist

### Electrical and library

- [ ] Requirements trace matrix has acceptance methods and unresolved risks.
- [ ] Every unique part has exact manufacturer/package/orderable identity, datasheet revision, verified symbol pins, verified footprint, and approved population/alternate state.
- [ ] ERC is clean or has local, reviewed waivers; no unintended global labels/hidden pins/NC ambiguity remains.
- [ ] Power tree, protection, sequencing, reset/boot/configuration, clocks, interfaces, differential-pair polarity, and connector pinouts were independently traced.

### Physical and performance

- [ ] Fabricator-selected stackup and constraints, not generic defaults, are encoded/reviewed.
- [ ] Placement honors datasheet/reference layouts, current loops, return paths, sensitive/noisy separation, thermal strategy, mechanical access, and test/probe access.
- [ ] All critical impedance/length/clearance/current/thermal requirements have evidence or are explicitly unverified risks.
- [ ] Board outline, holes, slots, keepouts, connector/enclosure fit, 3D orientation, marking, and assembly polarity are checked against drawings.

### Manufacturing and release

- [ ] DRC is clean to the release rule set; DFM/DFA feedback is resolved; no unexplained islands, slivers, or mask/paste surprises remain.
- [ ] Gerber/drill/route/outline, stackup/fab notes, stencil/paste, centroid, assembly drawing, BOM, and test documents match the same revision.
- [ ] Exports were viewed independently and compared with the native PCB.
- [ ] Release contains reports, waivers, reviewers, revisions, and known limitations.

### Prototype and qualification

- [ ] As-built configuration and test conditions are recorded.
- [ ] Prototype results are mapped to requirements and clearly separate demonstrated behavior from untested claims.
- [ ] Changes feed back into source artifacts and repeat the affected gates before the next release.

## Evidence limitations and unresolved assumptions

- The supplied JLCPCB article is a manufacturer educational article, not a universal design standard. Its recommendations are retained as workflow prompts and checked against first-party EDA/component sources.
- JLCPCB pages and capabilities can change; no current numeric manufacturing limit from a blog should be transferred to an order without checking the selected service, stackup, and quote.
- TI application notes explain mechanisms and device-family examples. They do not define a universal ground split, via count, capacitor value, trace width, or safety clearance.
- This dossier had no actual schematic, CAD files, datasheets, enclosure, fab order, safety standard, or test data. It therefore cannot approve a board, release, or qualification.

## Primary-source ledger

| ID | Claim family | Primary source | Publisher/date | Evidence status and use |
|---|---|---|---|---|
| L1 | Baseline PCB workflow: verified schematic, manufacturer-aligned rules, functional placement, ground/DRC/3D/export review; high-level layer/routing cautions. | [*How to Design a Complete PCB Layout? PCB Layout Engineer Must Know!*](https://jlcpcb.com/blog/complete-pcb-layout-guide) | JLCPCB; article indexed 2025, updated 2026-08-22 | **Medium.** Live canonical source used for all JLCPCB technical content. The user-supplied URL is a separate 404 redirect and is not an evidence source. |
| L2 | PCB object model, schematic-to-PCB update workflow, stackup/configuration, custom design rules. | [*PCB Editor 8.0*](https://docs.kicad.org/8.0/en/pcbnew/pcbnew.html) | KiCad Project; 2024 documentation, accessed 2026-09-06 | **High for KiCad 8 only.** Supports tool capability/process examples, not universal tool behavior. |
| L3 | ERC detects common declared connectivity/pin-rule problems but cannot detect all errors; correctness depends on symbol data. | [*Schematic Editor 8.0*](https://docs.kicad.org/8.0/en/eeschema/eeschema.html) | KiCad Project; 2024 documentation, accessed 2026-09-06 | **High for KiCad 8 only.** Supports the ERC boundary. |
| L4 | 3D inspection role and typical copper/outline/mask/silkscreen/drill fabrication outputs. | [*Getting Started in KiCad 8.0*](https://docs.kicad.org/8.0/en/getting_started_in_kicad/getting_started_in_kicad.html) | KiCad Project; 2024 documentation, accessed 2026-09-06 | **High for KiCad 8 workflow.** Output set must still be tailored to selected fab/assembly. |
| L5 | Decoupling parasitics, close placement, direct ground connection, and reference-plane considerations. | [*High-Speed Layout Guidelines*, SCAA082A Rev. A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) | Texas Instruments; revised 2017-08 | **High for stated mechanism/guidance.** Exact implementation is component and stackup specific. |
| L6 | Thermal-pad copper/thermal-via path, continuous copper heat exit, 2-layer/noisy-path cautions. | [*Best Practices for Board Layout of Motor Drivers*, SLVA959B](https://www.ti.com/lit/an/slva959b/slva959b.pdf) | Texas Instruments; revised 2021-10 | **High for the example mechanisms.** Apply the actual device datasheet first. |
| L7 | Mixed-signal grounding examples and their scope/limitations. | [*Grounding in Mixed-Signal Systems Demystified, Part 2*](https://www.ti.com/lit/an/slyt512/slyt512.pdf) | Texas Instruments; 2013 | **High for described topology, not a universal split-ground rule.** |
| L8 | DRC versus DFM distinction; export/DFM review context. | [*PCB Design Verification Guide*](https://jlcpcb.com/blog/pcb-design-verification-guide) | JLCPCB; 2026 | **Medium.** Useful manufacturer explanation; verify actual DFM with selected build service. |
| L9 | Gerber/output completeness and independent review rationale. | [*How to Prepare Perfect Gerber Files for Flawless PCB Production*](https://jlcpcb.com/blog/prepare-perfect-gerber-files) | JLCPCB; 2026-06-27 | **Medium.** Good handoff checklist; actual output requirements are fab/CM specific. |

## Search boundary and stop rationale

Research reviewed the supplied JLCPCB guide and related JLCPCB verification/output guidance, official KiCad 8 documentation, and official TI layout/grounding notes. The sources cover the required article, tool-check limitations, physical layout mechanisms, and manufacturing handoff boundary. Further generic “PCB design tips” sources would add repetition rather than resolve the remaining consequential questions, which are necessarily project-specific: chosen component datasheets, actual stackup/fab service, enclosure, safety/EMC standard, assembly process, and test evidence.

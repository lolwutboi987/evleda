# Evidence dossier: PCB component placement for clean, routable layouts

**Research date:** 2026-09-06  
**Audience:** PCB designers, reviewers, and engineering agents turning a completed schematic into a layout that can be routed, assembled, tested, and serviced.  
**Scope:** This dossier extracts the useful workflow from JLCPCB's live successor guide, *PCB Component Placement: Practical Guide to Clean Layout*, and tests it against manufacturer layout guidance. The supplied earlier JLCPCB URL was verified as HTTP 404 on 2026-09-06, so it is recorded only as unavailable provenance rather than used for technical attribution. This dossier covers physical placement before and during early routing: mechanical constraints, functional zoning, power, signal/return paths, thermal behavior, test/manufacturing access, and repeatable review. It does **not** approve a specific board, choose clearance distances, or replace the exact component datasheet, package drawing, fabrication capability, or safety standard.  
**Evidence key:** **High** means the claim is directly supported by official component-maker documentation or an identified standard. **Medium** means it is sound, useful layout practice requiring project-specific confirmation. **Low** means convention, heuristic, or vendor marketing claim. “Device-specific” is deliberately not generalized to unrelated packages or circuits.

## Direct conclusion

Good component placement is not the act of making footprints look tidy. It is the early physical implementation of the circuit's **current loops, return paths, heat paths, interfaces, assembly process, and service plan**. Establish the board's mechanical envelope and fixed interfaces first; partition the schematic into real functional blocks; place the active devices and their mandatory nearby circuitry as complete local assemblies; reserve corridors and a continuous reference plane before filling empty space; then validate the placement with ratsnest, current-flow, return-path, thermal, DFM, and test-access reviews.

The live JLCPCB successor guide's ordering is a strong starting point: functional zoning, fixed mechanical items, key ICs/high-power devices, supporting passives, then secondary parts and a sanity check before routing. Its broad statements about keeping related parts together and decouplers near pins are correct in intent. They are not a substitute for the exact IC reference layout. For example, a regulator's hot loop, a clock oscillator, a Kelvin sense connection, and an exposed-pad footprint have geometries whose priority can override visual symmetry or generic “short trace” rules.

The release standard is therefore: **every critical connection has a feasible, short, intentional route and return; every part has assembly and rework clearance; no sensitive circuit sits in the field of a noisy/hot/mechanically stressed circuit; and all unresolved placement compromises are recorded and reviewed before routing makes them expensive.**

## JLCPCB guide provenance, contribution, and limits

The user-supplied URL, `https://jlcpcb.com/blog/pcb-component-placement-a-practical-guide-to-clean-routable-layout`, was checked on 2026-09-06 and returned **HTTP 404**. It is not cited as accessible technical evidence. Technical claims attributed to JLCPCB in this dossier instead come from the live successor, [*PCB Component Placement: Practical Guide to Clean Layout* (JLCPCB; accessed 2026-09-06)](https://jlcpcb.com/blog/pcb-component-placement-guide-2026). That page presents five “golden rules”: functional planning, mechanical/connector placement first, close placement of related circuits, decouplers beside power pins, and a placement validation before routing. It recommends zones for power, digital, analog, communications, and RF; lists connectors, holes, displays, buttons, and antennas as fixed constraints; and calls for a review of zones, signal flow, spacing, thermal behavior, and connector access before routing. These are **Medium**-confidence workflow principles from a PCB manufacturer's educational article.

Useful retained ideas:

- **Zone first.** Divide the board by function before arranging individual parts, so power and information have a natural direction and unrelated circuits do not consume each other's routing area.
- **Freeze true anchors first.** Enclosure-controlled connectors, mounting holes, displays, buttons, antennas, edge-clearance features, and heat sinks cannot be “optimized later” without changing the product.
- **Place a circuit, not isolated symbols.** An IC must arrive with the capacitors, resistors, feedback, crystal, protection, and package escape it requires; delaying those parts commonly destroys the intended topology.
- **Review placement before committing routes.** A routed board can hide a poor floor plan beneath a mass of copper. The ratsnest is the cheap moment to move a block.
- **Treat thermal, access, and production as first-order concerns.** Hot devices need a heat path and airflow context; connectors need usable insertion/tool access; orientation and spacing affect inspection, reflow/wave behavior, and repair.

The article does **not** establish a universal 10 mm decoupling limit, a universal separation distance, an IPC clearance table, a component-spacing number, or its unsourced statistic about EMI problems. It correctly points to IPC-2152 and IPC-2221 as relevant standards, but this dossier does not treat a web article as the licensed normative content of either standard. Use the board's applicable edition, voltage, pollution degree, material group, altitude, fabricator rules, and safety jurisdiction for actual spacing.

## Definitions and placement model

| Term | Working definition | Review implication |
|---|---|---|
| Mechanical anchor | Footprint/location fixed by enclosure, user interaction, cable entry, antenna geometry, mounting, heat sink, or safety boundary. | Lock it before electrical optimization; document its datum and forbidden movement. |
| Functional block | Components that together create one electrical function, such as power entry, buck regulator, ADC front end, or USB interface. | Place its members as a local system with an entry, exit, return, heat path, and escape plan. |
| Hot loop | The high-`di/dt` current loop in a switching converter or power stage. | Keep its physical loop area and interlayer transitions small; do not route quiet signals through it. |
| Return path | The actual current path back to its source/reference, often concentrated below a high-frequency trace on its reference plane. | A short forward trace is insufficient if a slot, split, or connector forces a long return detour. |
| Routing channel | An intentionally unoccupied strip/area that lets critical traces, buses, power, or escape fanouts pass without violating clearance or reference continuity. | Preserve it during placement; do not fill it with “spare” passives. |
| Keepout | A constrained region where particular copper, parts, solder mask, tools, or components are prohibited. | It may arise from antenna/RF, high voltage, mounting hardware, optics, heat, nozzle access, or enclosure clearance. |
| Courtyard | The assembly clearance envelope defined by the footprint/library. | Courtyard collision is a manufacturing/rework risk even when copper pads do not overlap. |
| Ratsnest | The unrouted net indicators between placed pads. | It reveals topological stress before routing disguises it; it is not proof of SI, PI, thermal, or DFM correctness. |

The most useful mental model is four overlapping maps:

```text
mechanical map:  enclosure, holes, edges, ports, antennas, airflow, heat sink
functional map:  power -> processing -> sensing/control -> external interfaces
current map:     high-di/dt loops, high-current paths, local return paths, quiet references
process map:     assembly side/orientation, courtyards, fiducials, probe/tool access, rework
```

A placement is healthy only where all four maps agree. A compact placement that destroys a rework corridor is not good placement; nor is an easily assembled placement that forces a switch node through an ADC zone.

## Evidence-backed placement principles

### 1. Mechanical anchors and board architecture

Start from the immutable geometry, not the schematic's center. Import or draw the final board outline, enclosure walls, mounting-hole keepouts, display/window locations, connector mating directions, cable bend envelopes, switch/button reach, battery/heat-sink volume, antenna keepout, chassis contacts, and required edge clearance. Set the mechanical origin/datum and identify which dimensions are controlled by another team. Mark each constraint as fixed, bounded, or negotiable.

Place external connectors on the appropriate edge or face so that mating, strain relief, keying, fingers, and test equipment work with the enclosure. Analog Devices similarly advises placing connectors at board edges while nearby decouplers/crystals remain close to the mixed-signal device [*What Are the Basic Guidelines for Layout Design of Mixed-Signal PCBs?*](https://www.analog.com/en/resources/analog-dialogue/articles/what-are-the-basic-guidelines-for-layout-design-of-mixed-signal-pcbs.html). This is **Medium** as a general policy: a board-to-board mezzanine, flex tail, or internal service connector may intentionally live away from an edge.

Rules that prevent expensive late changes:

1. Put mounting holes and their screw/head/washer/chassis keepouts on the first placement pass. Do not count copper annulus clearance alone as mechanical clearance.
2. Keep fragile, stress-sensitive, tall, or hand-adjusted components clear of fasteners, board flex regions, cable pull paths, and enclosure ribs. A crystal, strain-gauge interface, precision reference, MEMS sensor, and ceramic capacitor can each have a project-specific stress sensitivity.
3. Model both sides of the PCB. A bottom-side component can collide with standoffs, battery, heat sink, or a mating board even if the top view looks clear.
4. Put serviceable parts where a person can reach them after assembly: fuse, connector latch, programming header, reset control, test points, trim, and replaceable module.
5. Do not move an antenna, high-voltage boundary, optical path, or connector merely to improve a ratsnest. Its mechanical/RF/safety constraint may be stronger than net length.

### 2. Functional zoning, flow, and block boundaries

Build a floor plan from the schematic's energy and information flow. A common board has a boundary/interface zone, input protection and power-entry zone, power-conversion zone, digital/control zone, analog/sense or RF zone, then output/load zones. These names are not mandatory; the important result is that each zone has a clear reason for its location, nearby dependencies, and planned exits.

JLCPCB correctly identifies power, digital, analog, communications, and RF as typical zones and warns that unsegregated boards produce crosstalk, congestion, return-path trouble, EMI, and debugging difficulty. Analog Devices gives the underlying mixed-signal reason: separate sensitive analog components from noisy logic/timing blocks and follow the schematic's signal path when making the floor plan [Analog Devices mixed-signal placement guidance](https://www.analog.com/en/resources/analog-dialogue/articles/what-are-the-basic-guidelines-for-layout-design-of-mixed-signal-pcbs.html). **High** for the return-current/noise mechanisms in the cited application context; **Medium** for a particular board's exact zone shape or distance.

For each block, annotate:

- what enters and leaves: rails, current, data, clocks, heat, and user/cable interfaces;
- which nets are noisy, high energy, impedance controlled, high impedance, precision, or safety critical;
- which components are inseparable (IC plus support/feedback/decoupling); and
- the preferred layer/plane and escape direction for each important interface.

Do not confuse visual islands with split ground planes. Partition **components and signal paths** first. A solid, continuous reference plane is often preferable because it gives signal return current a direct low-impedance route. Analog Devices explains that high-frequency return current tends to follow the outgoing trace because that minimizes loop impedance; a split should be used only when the actual device/system guidance supports it and no signal needs to cross the split [mixed-signal grounding discussion](https://www.analog.com/en/resources/analog-dialogue/articles/what-are-the-basic-guidelines-for-layout-design-of-mixed-signal-pcbs.html). A “separate analog ground” label is not permission to create a return-path slot.

### 3. Connectors, entry boundaries, and protection progression

Treat each external connector as an electrical boundary and a physical fixture. Its placement determines cable path, ESD entry, common-mode path, surge/fault propagation, shield/chassis relation, controlled-impedance launch, and test access. Lay out its mating-side pin numbering and orientation visibly; then trace every pin from the connector inward in the order the disturbance or signal meets it.

For a powered external interface, a typical placement progression is:

```text
connector -> chassis/shield/ESD or surge element -> fuse/current limit or reverse protection
          -> bulk energy storage -> regulator/load -> local decoupling at the IC
```

This is topology, not a universal mandatory sequence. The exact protection type, reference point, clearance, and component order come from the interface standard and part datasheets. Keep the protection element physically near the entry so a fast transient does not traverse the board before finding it; provide a short intentional return to the selected chassis/ground node; keep vulnerable internal traces away from the connector edge and its noisy current path.

For USB, Ethernet, HDMI, LVDS, RF, or other high-speed connectors, place the connector, ESD/common-mode/termination components, and receiving/transmitting IC so that the required topology has a direct continuous-reference route. JLCPCB's general advice to keep those connectors near their controller is **Medium**; connector vendor launch geometry, common-mode choke placement, cable EMC, and the protocol's exact reference design take precedence. Never put an ESD part “nearby” on a stub that leaves the main differential path exposed.

### 4. Power entry, regulator topology, and hot loops

Power placement begins by drawing the physical current loop, not by packing parts around a regulator IC. Identify: input source/connector, transient protection, bulk capacitor, input ceramic, switching IC or FETs, inductor/transformer, catch diode or synchronous FET, output capacitor, feedback divider/compensation, sense/Kelvin point, load, and their ground/return nodes. Follow the exact reference layout of the selected regulator first.

For a buck converter, the high-`di/dt` input loop generally includes the input ceramic, the switching device, and the return; the switch-node copper is a fast-changing noisy region. Keep the input ceramic immediately across the appropriate VIN/PGND pins, minimize loop perimeter and vias, keep the SW node compact, keep feedback/sense away from SW/inductor, and locate the output network in the intended current path. For a boost, flyback, H bridge, or multiphase design, redraw the actual switching loops; do not copy a buck arrangement blindly.

TI's motor-driver layout note documents the mechanism in a demanding power-stage case: high-current-loop inductance falls when component distances and layer transitions are reduced, while correct trace width and adequate vias matter; it also calls out the switch node and Kelvin sensing as special cases [*Best Practices for Board Layout of Motor Drivers*, SLVA959B](https://www.ti.com/lit/an/slva959b/slva959b.pdf). This is **High** for loop-inductance and sensing principles; its dimensions and specific motor topology are not generic regulator rules.

Place bulk capacitance where the system needs low-frequency energy and where the entry/current path demands it, not as a substitute for local ceramic decoupling. In the cited motor-drive example, TI places bulk capacitors near the supply/power entry and uses low-ESR parts and multiple plane vias. Place charge-pump/bootstrap capacitors by their driver pins and the specified return; their physical loop often matters more than making the board aesthetically symmetric.

Power-entry checklist:

- [ ] Connector, fuse/current limit, reverse/surge element, bulk cap, and rails have a defined current direction and return route.
- [ ] Each switching converter has its datasheet/reference-layout hot loop, SW/noisy field, feedback/sense path, inductor, input/output caps, and thermal pad represented as a placement group.
- [ ] Sensitive analog/reference/clock circuits are outside the hot-loop and switch-node field, not merely on another schematic page.
- [ ] High-current layer changes use a verified via count/size and fabricator capability; a single generic via is not assumed sufficient.
- [ ] Protection and sense returns do not silently share a high-current copper neck with quiet circuitry.

### 5. Decoupling: local loops, not decorative capacitors

Every bypass capacitor belongs to a particular power pin/domain and must form a small loop: IC supply pin -> capacitor -> ground/reference connection -> IC ground pin/plane. Place it so that its connection to both relevant pads/planes is short, wide enough, and low inductance. A capacitance value printed on the schematic does not make a distant capacitor effective at high frequency.

TI explains that real capacitors have parasitic inductance/resistance and become inductive above self-resonance; its high-speed guide recommends locating the smallest/high-frequency capacitor closest to the power pin [*High-Speed Layout Guidelines*, SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf). Its motor-driver note further warns against vias between bypass caps and the active-device supply/ground pins when possible because added trace inductance increases ringing and EMI. **High** for the cited physical mechanism, but values, count, placement side, and via policy must follow the selected IC/package/stackup.

Placement rules:

- Place mandatory decouplers at the IC first, before noncritical passives. Rotate the package or cap so the local loop is genuinely short rather than merely geographically close.
- Prefer a direct connection to the intended reference plane. If a via is unavoidable, position it according to the device reference design and keep the complete loop compact.
- Distinguish input bulk, regulator input/output capacitors, domain bulk, local IC bypass, reference bypass, bootstrap/charge-pump capacitors, and EMI filter capacitors. They solve different problems and cannot simply exchange positions.
- Do not sprinkle arbitrary value decades across a board. Analog Devices notes that capacitor choice and placement can create unwanted resonances; the PDN target and actual capacitor impedance matter [*AN-1142: Techniques for High Speed ADC PCB Layout*](https://www.analog.com/en/resources/app-notes/an-1142.html).
- For BGA/QFN parts, reserve room for the manufacturer-recommended capacitor escape/plane-via pattern before routing fanout. A perfectly placed cap that cannot connect to the proper ball/pin is not a solution.

### 6. Clocks, reset, references, analog inputs, and sense paths

Clocks and analog/sense components must be placed according to the signal's coupling and reference needs, not simply closest Euclidean distance.

**Crystal/oscillator:** Place the crystal/resonator and its load components next to the oscillator pins; keep the XIN/XOUT loop short and, where the device guidance requires it, symmetric. Keep fast digital routes, switching nodes, and aggressive copper/planes away from that region. TI's MSP430 oscillator guidance calls for short crystal/pin/capacitor traces and a ground area under the oscillator; it describes a ground guard ring as a device/package-specific option when neighboring pins permit it [*MSP430 32-kHz Crystal Oscillators*, SLAA322D](https://www.ti.com/lit/pdf/slaa322). Do not copy its guard-island detail to another MCU without that MCU's datasheet.

**Precision reference and ADC front end:** Put the reference bypass at its pin; place the amplifier/filter/anti-alias network so the analog path has no excursion through digital or switching areas; keep differential paths geometrically and electrically balanced where the converter requires it. Analog Devices reports that an exposed paddle can be electrically and thermally essential, and that plane coupling/noisy adjacent layers can disturb a sensitive converter [AN-1142](https://www.analog.com/en/resources/app-notes/an-1142.html). Use the exact converter evaluation-board layout as a constraint source, not generic analog folklore.

**Current/voltage sensing:** Keep Kelvin sense traces separate from high-current copper until their prescribed pickup points. A sense lead must not inherit the voltage drop/noise of a shared load path. TI's motor-driver document uses a direct Kelvin connection to the MOSFET drain to avoid false over-current readings caused by plane inductance and drop. Apply that principle only after identifying the actual sensor/driver's required sense topology.

**Reset, boot, programming, and configuration:** Place pull-ups, filters, buttons, programming header, level translation, and protection so their route does not cross noisy zones or become inaccessible after enclosure assembly. Make boot straps probeable. A microcontroller in the center of its support circuitry may be electrically sensible, but a programming connector that cannot be plugged in is a product failure.

### 7. Thermal placement, airflow, and package heat paths

Heat has a source, a conduction path, an airflow/radiation environment, and temperature-sensitive victims. Place regulators, power FETs, motor drivers, LEDs, processors, and resistive loads where they can spread heat into copper and layers, meet heat-sink/enclosure interfaces, and receive realistic airflow. Keep thermistors, references, oscillators, precision analog, batteries, electrolytics, plastic connectors, and displays outside their thermal influence unless the thermal model shows otherwise.

An exposed/thermal pad is not optional filler copper. For the devices in TI's motor-driver guidance, the pad creates a comparatively low-resistance die-to-board heat path and should connect to continuous copper/planes with a suitable via array; broken pours constrict the heat path. Analog Devices likewise warns that an EPAD can be fundamental to both electrical grounding and thermal performance [TI thermal discussion](https://www.ti.com/lit/an/slva959b/slva959b.pdf), [ADI EPAD discussion](https://www.analog.com/en/resources/app-notes/an-1142.html). **High** for the necessity of following package layout/paste/via guidance; **not** evidence for universal via diameters, copper weight, or pad segmentation.

Thermal placement review:

1. Identify each hot part's estimated loss, maximum ambient, package thermal path, copper area/layer availability, heat sink/contact, and airflow direction.
2. Keep a continuous thermal-copper escape from a thermal pad where permitted; do not neck it down with unrelated traces or surround it with no-copper keepouts without analysis.
3. Place tall upstream parts so they do not shade downstream hot parts from airflow, and do not exhaust hot air onto a precision/reference block.
4. Check both sides: bottom-side thermal copper may require clearance from enclosure insulation, standoffs, or adhesive.
5. Validate by analysis and hot-soak measurement. A thermal-via array is not a temperature rating.

### 8. Return paths, plane continuity, and routing channels

Placement must reserve the reference plane and the routes that will use it. On a multilayer board, locate sensitive/high-speed traces over their intended uninterrupted reference layer; avoid placing connector rows, vias, cutouts, copper islands, or split boundaries so that they force a return current detour. On a two-layer board, placement is even more decisive because every trace can fragment the available ground copper.

TI states that a continuous ground plane gives signals a short return path and reduces coupling/interference; it also notes that connectors, headers, vias, and plane breaks can enlarge current loops [SLVA959B](https://www.ti.com/lit/an/slva959b/slva959b.pdf). Analog Devices explains the same result in a mixed-signal context. This supports a **High**-confidence review question: “Where does this signal's current return?” It does not support an absolute rule that every ground must use one named copper region or that every layout must be four layers.

Reserve channels deliberately:

- one or more wide corridors from high-pin-count ICs to their interfaces/memory/PHYs;
- uninterrupted paths for controlled-impedance pairs and their reference plane;
- a power trunk and its return, wide enough for verified current/via capacity;
- a low-noise analog corridor from connector/sensor to conditioning/ADC;
- a service/probe corridor to test points, jumpers, and programming pads; and
- vias/escape fields around BGA/QFN/thermal-pad packages before filling the rest of the board.

The channel must include clearance, solder-mask/process rules, and return-plane continuity, not just a visible gap between silkscreen outlines. Passive “clutter” is often the reason a theoretically routeable board becomes a via-heavy, split-plane board.

### 9. Keepouts, high voltage, RF, mechanics, and density limits

Every keepout needs a named owner and reason. Common categories are: board edge/panel tooling, screw/washer, enclosure/rib, antenna/RF no-copper, high-voltage creepage/clearance, isolation barrier, optical/light pipe, heat sink, test probe, assembly nozzle, keepaway from tall components, and rework tool access. Translate each into the EDA's appropriate mechanical/copper/component/route/plane rule rather than leaving a comment that the router can ignore.

For high voltage or reinforced isolation, do not use an internet “mil per volt” shortcut. Determine the governing standard, working/peak voltage, pollution degree, material group, altitude, coating, slots, manufacturing tolerances, and end-product certification intent. The required JLCPCB article's IPC-2221 reference is a discovery pointer, not evidence that a particular clearance satisfies a safety requirement.

Density is a constraint budget, not a virtue. Set a placement density only after accounting for fabrication/assembly capability, package courtyard, escape routing, power/ground copper, thermal spreading, test/rework, component height, and production volume. A dense wearable or BGA board may require microvias, via-in-pad, HDI stackup, X-ray inspection, or expensive rework; it should not be judged by the same spacing heuristic as a hand-assembled two-layer board.

### 10. Test access, assembly, rework, orientation, and side selection

Design for manufacturing begins during placement, not after routing. Use the fabricator/assembler's current rules for minimum component spacing, panel rails, fiducials, paste apertures, wave orientation, double-sided reflow, through-hole process, selective solder, AOI/X-ray, and test fixture clearance. JLCPCB's advice to keep orientation consistent and to leave space for pick-and-place/reflow/rework is **Medium** and directionally correct, but its article does not define production limits for another assembler or revision.

**Test access:** Place test points where a fixture/pogo probe or bench probe can physically reach them without shorting nearby nets. Include the relevant reference ground near a signal test point; make power rails, resets, enables, program/debug, current-sense nodes, communications, and important analog references observable as the test strategy requires. Mark test-only pads so they are not mistaken for unpopulated parts. Do not place a test point in a high-impedance or controlled-impedance path unless the circuit allows its added capacitance/stub.

**Rework:** Give thermal pads, fine-pitch ICs, connectors, and large capacitors enough tool/nozzle visibility and clearance. Avoid trapping a small resistor/capacitor between tall parts if it is likely to be tuned or replaced. Make polarity markings readable after placement. Keep heat-sensitive parts clear of parts likely to receive repeated hand-solder heat.

**Orientation:** Align similar polarized components and pin-1 directions where this does not harm routing/topology. Consistency improves visual inspection, programming/test setup, and repair; it is subordinate to electrical geometry. For wave solder, orient leads and tall parts according to the actual conveyor/solder-flow process; a generic “all parts same direction” rule cannot replace the assembler's wave analysis.

**Side selection:** One-sided SMT is usually simpler and cheaper, but a board may need the other side for density, RF, thermal, or connector geometry. If using the second side, reserve its mechanical clearance and determine the assembler's reflow/adhesive/through-hole sequence. Do not claim “two reflow passes” or a specific price effect without the chosen assembly house's current process quote.

## Practical placement sequence and exit criteria

### Phase 0 — Inputs and constraints

1. Freeze the latest schematic, board outline, stackup intent, enclosure CAD/drawing, connector/mating specification, assembly capability, safety/EMC constraints, and the exact device datasheets/reference layouts.
2. Make a placement-constraint table for every nontrivial part: package/courtyard, height, pin 1, thermal pad, minimum copper, keepout, nearby required passives, polarity, test access, and special routing/return rules.
3. Classify nets/components: high current, high voltage, high `dv/dt`, high `di/dt`, clock, differential/controlled impedance, high impedance/precision, RF, temperature sensitive, user/service accessible, and DNP/option.
4. Confirm the board layer count/reference-plane strategy before densely placing parts. Placement cannot promise an uninterrupted reference plane that the stackup cannot supply.

### Phase 1 — Mechanical anchors and forbidden zones

1. Place board outline, holes, slots, cutouts, edge tabs, panel/tooling features, fiducials, chassis points, displays, buttons, antennas, and all user-facing/mating connectors.
2. Import/define all 3D heights and keepouts on both sides; check enclosure and mating geometry.
3. Draw regions for safety isolation, antenna/RF, heat sinks, airflow, high-voltage boundaries, and rework/test access.
4. Lock only truly fixed objects. Leave a documented adjustment range for constrained-but-negotiable connectors or displays.

**Exit:** no footprint violates the enclosure/mating/height/fastener model; every mechanical keepout has an owner and rule.

### Phase 2 — Floor plan and major devices

1. Place functional-block bounding regions and directional arrows for power/signal flow.
2. Place central controllers/processors, power ICs/FETs, ADCs/AFEs, RF devices, memory/PHYs, and high-power loads in their zones with their main interfaces facing intended routing channels.
3. Rotate devices to make critical pin groups face their dependencies. Do not rotate merely to make reference text horizontal if it makes the power or memory escape cross the board.
4. Reserve fanout, differential-pair, power, analog, and connector corridors; reserve reference-plane continuity beneath those corridors.

**Exit:** critical ratsnest lines are mostly intra-zone and short; no central IC requires unrelated blocks to be crossed to reach its primary partner.

### Phase 3 — Complete critical local assemblies

1. Place each regulator with its exact input/output/feedback/compensation/bootstrap/sense components and thermal copper plan.
2. Place every IC's mandatory decouplers, reference capacitors, crystals, pull/strap/reset/programming parts, terminations, ESD, and filters.
3. Place analog signal chain parts in signal order; place Kelvin/sense components at their real pickup points; place RF matching parts in the mandated launch geometry.
4. Place bulk capacitors, high-current connectors, FETs/inductors, and power-plane entry/exit vias as one current-flow structure.

**Exit:** every critical datasheet placement note has a mapped physical implementation or a documented exception; hot loops, clock loops, and sensitive analog paths can be traced on the placement view.

### Phase 4 — Secondary parts and production/test completion

1. Add LEDs, jumpers, optional/DNP parts, indicators, secondary connectors, local filters, and mechanical hardware without invading reserved corridors.
2. Add fixture/bench test points, programming/debug access, fiducials, tooling, polarity/pin-1 markings, readable references, and required labels.
3. Check courtyards, component heights, paste/thermal-pad process notes, pick-and-place rotation, wave/selective-solder constraints, and rework visibility.
4. Use the second side only with a deliberate assembly/thermal/mechanical decision.

**Exit:** all required test and service actions are physically reachable; no placement relies on an unverified assembler exception.

### Phase 5 — Pre-route placement gate

1. Perform the reviews below, then move blocks while ratsnest changes are inexpensive.
2. Route only a few critical exemplars: a regulator hot loop, a clock, a high-speed pair/connector launch, a power trunk, a sensitive analog path, and a test point. This proves the assumed channels and layers.
3. Re-run congestion/length/via metrics. If a critical route requires a detour, plane split, extra layer jump, or compromised clearance, repair the placement before general routing.
4. Freeze a placement revision with screenshots/notes and an exception list, then route systematically.

## Ratsnest metrics and iterative placement checks

Ratsnest aesthetics are not an acceptance test, but they are a useful early quantitative signal. Record a baseline after each major placement pass rather than relying on memory. Do not optimize a global length number at the expense of a local critical loop.

| Metric | What to inspect | Healthy trend | False assurance / action if poor |
|---|---|---|---|
| Unrouted count by class | Separate power, clock, differential, analog, external, and ordinary nets. | Critical classes become locally connected without crossing zones. | A low total can hide one impossible regulator or connector route; inspect classes. |
| Sum/median/max ratsnest length | Measure per net class, not only board total. | Large reductions after zone/device rotation. | Short direct lines do not prove return paths or clearance; use as a prompt, not proof. |
| Cross-zone net count | Count nets that must pass through an unrelated zone. | Reduce to intentional interfaces. | Some crossings are required; reserve a controlled corridor and reference plane. |
| Estimated layer transitions | Count expected vias on high-current, differential, clock, and analog paths. | Critical paths need fewer/unavoidable transitions. | A zero-via target can force bad geometry; use the device and stackup requirements. |
| Channel occupancy | Inspect escape gaps, BGA neckdowns, connector launches, and power trunks at realistic rules. | At least one feasible route plan remains before fillers are placed. | Empty visual space may still be unusable due to clearance/courtyard/return-plane gaps. |
| Decoupler loop proxy | Trace physical pad-to-pin-to-reference loop, including vias. | Each required capacitor has a compact, direct loop. | Straight-line distance alone misses via/plane path; inspect real connectivity. |
| Thermal spacing | Estimate heat-source to sensitive-part distance and copper/air path. | Hot parts have spreading/airflow, sensitive parts are out of the plume. | Distance alone ignores actual dissipation/enclosure; require thermal analysis/test. |
| Test/rework reach | Check probe, connector, nozzle, and screwdriver approach in 3D. | Required access works after all tall parts are present. | A top-view clearance can fail in height/tool angle. |

A productive iteration is: (1) cluster by function, (2) lock mechanics, (3) rotate/translate major blocks to shorten critical nets and preserve channels, (4) add local assemblies, (5) route one representative path per constraint family, (6) measure, then (7) adjust the block rather than route around an avoidable topology problem.

## Examples and tradeoffs

### Example A — USB-powered mixed-signal sensor node

```text
USB connector / shield edge
  -> ESD/common-mode/termination as required by interface
  -> USB controller/MCU, with short continuous-reference pair launch
  -> local digital zone

Power entry -> protection -> buck/LDO block -> digital and analog rails
                                      |             |
                            keep SW/inductor away   ADC/ref/AFE near sensor connector
```

Place the USB connector at the enclosure edge and route its protection/current return locally as specified by the transceiver/interface design. Put the MCU/controller close enough that the pair can retain its continuous reference and planned impedance. Put the switching regulator in a power zone whose hot loop and inductor field do not cross the sensor/ADC corridor. Place the sensor connector near the AFE if cable/noise/sensitivity demands it, but retain the mechanical accessibility requirement. A single solid reference plane may be better than a decorative analog/digital split, provided high-current digital returns do not traverse the analog area and the converter datasheet supports it.

**Tradeoff:** moving the ADC close to the sensor connector can lengthen its digital route to the MCU. That is often preferable if it preserves the high-impedance analog path and a quiet reference; validate the digital interface and return plane rather than optimizing the ratsnest visually.

### Example B — Synchronous buck near an FPGA/processor

```text
VIN entry/bulk -> input ceramic -> regulator IC + PGND -> inductor -> output capacitor -> load plane
                             \___ tight switching loop ___/
feedback/sense: quiet pickup at output, routed away from SW/inductor
```

First place the regulator and exact required capacitors, inductor, feedback, and thermal pad from its reference layout. Orient it so VIN/PGND/input-cap pins can make the smallest loop and the SW node faces only the inductor, not the memory/clock escape. Place output caps and the load plane where load transients occur; do not route a long output rail back across the hot loop. If the processor's many decouplers need the same area, reserve their BGA escape/decap pattern first and decide whether the regulator should sit at the load edge rather than directly beside it.

**Tradeoff:** the smallest regulator loop can conflict with the shortest load rail. Protect the hot loop first, then minimize the power-delivery impedance using appropriate planes, bulk/local caps, and verified routing; do not run a switch node under the processor to save board area.

### Example C — Three-phase motor driver with shunt sensing

Place the bulk/input ceramics at the power-stage entry, driver/charge-pump caps at driver pins, FETs in a geometry that minimizes each switching/high-current loop, and motor connector near the power stage. Keep MCU/control logic and current-sense amplifier outside the switch-node area. Bring sense traces as a Kelvin pair from the shunt or specified FET pickup to the amplifier/driver, not as branches off high-current copper. TI's motor-driver note specifically identifies direct Kelvin pickup as a way to avoid measurement error from plane voltage drop/inductance [SLVA959B](https://www.ti.com/lit/an/slva959b/slva959b.pdf).

**Tradeoff:** centralizing the FETs may reduce phase trace length but worsen heat concentration or motor-connector access. Compare the full current loop, thermal spreading, heat sink/airflow, and cable geometry, not a single net length.

### Example D — Crystal next to a crowded MCU

The oscillator pins may sit on an inconvenient package side. Rotate the MCU only if it improves more critical interfaces overall; otherwise reserve a small protected crystal region at those pins, keep its load capacitors and return compact, and route no high-speed or switching nets through it. TI's documented 32-kHz example prefers short paths, a ground region under the oscillator, and symmetric external-capacitor interconnect where used [SLAA322D](https://www.ti.com/lit/pdf/slaa322). 

**Tradeoff:** forcing the crystal on the same side and at minimum distance may conflict with BGA fanout. The exact MCU reference design determines whether a short via transition is acceptable; treat the oscillator as a verified local exception, not an invitation to route arbitrary signals under it.

## Package-specific placement constraints

| Package / part class | Placement constraints | Do not assume |
|---|---|---|
| BGA / LGA | Plan escape layers, via style, decoupler access, probe/X-ray strategy, warpage/assembly rules, and nearby component height before placement. | That a nearby capacitor can reach the correct ball with no via, or that all BGA balls need equal trace lengths. |
| QFN / DFN / exposed-pad IC | Follow exact land, paste-window, EPAD/ground, via-in-pad or tenting, and thermal guidance; reserve the thermal/electrical via array and inspect solder accessibility. | That the exposed pad is only thermal, or that one generic paste pattern works for all packages. |
| Fine-pitch QFP / TQFP | Preserve fanout channels, pin-1 visibility, stencil/inspection space, and decoupler/clock locations at the relevant pin sides. | That rotating for text orientation is harmless to bus/power escape. |
| Power MOSFET / driver | Place according to the complete high-current/switch-node/gate-drive/sense/thermal topology; provide copper, vias, and heat path. | That package current rating alone validates a narrow neck or one via. |
| Inductor / transformer | Respect magnetic-field, height, heat, polarity, creepage, and manufacturer keepout guidance; keep sensitive inputs and feedback outside the coupling field. | That all inductors are interchangeable or that a shielded marking eliminates all coupling. |
| Crystal / resonator / TCXO | Use exact oscillator pin, load, grounding/guard, mechanical-stress, and no-route guidance. | That a “short trace” alone ensures startup/frequency accuracy. |
| Precision reference / MEMS / sensor | Protect from heat gradient, board flex, vibration, contamination/light as relevant; keep quiet local decoupling and signal path. | That analog placement rules are sufficient without the sensor datasheet/environmental constraints. |
| RF module / antenna | Obey module and antenna ground/no-copper/edge/clearance rules, ground-via fence and feed geometry as specified; preserve enclosure proximity model. | That an antenna can be moved or copper-filled around like a normal connector. |
| Connector / through-hole part | Check mating side, pin-1, cable bend, hold-downs, hole tolerances, wave/selective-solder access, and mechanical load. | That copper-pad clearance represents full plug, latch, or tool clearance. |
| Electrolytic/polymer cap | Observe polarity, height, life/temperature sensitivity, vent/service clearance, and high-ripple current placement. | That it can share a hot zone with no reliability consequence. |

## Common failures, why they survive routing, and controls

| Failure | Why it happens | Why routing/DRC may not catch it | Placement control |
|---|---|---|---|
| Decoupler is “close” but electrically remote | Cap positioned by body distance, with long pad traces/vias. | DRC sees legal copper, not loop inductance. | Trace the full supply-cap-return loop; follow the exact reference layout. |
| Regulator works on bench but radiates/rings | Hot loop or SW node enlarged to make parts fit. | Router can complete legal traces around a bad topology. | Place power stage as a local loop before filler components. |
| Analog result changes with digital activity | ADC/ref/sensor sits near switcher/clock or return crosses noise. | Netlist is correct; plane coupling/return effects are physical. | Floor-plan zones and preserve a quiet signal/return corridor. |
| Clock fails or drifts intermittently | Crystal loop crosses digital field, has excessive parasitic/stress. | DRC knows neither startup margin nor stray coupling. | Apply device-specific oscillator layout and mechanical keepout. |
| Connector is electrically correct but unusable | Mating/latch/cable/hand clearance ignored. | PCB tools often check only footprint copper. | 3D/enclosure and insertion-direction review before routing. |
| Board cannot be probed/reworked | Test pads/parts buried among tall or fine-pitch parts. | DRC does not model probe/nozzle geometry. | Add explicit test/rework keepouts and 3D reach check. |
| Split plane makes emissions/noise worse | Signal crosses slot, forcing return detour. | Named ground nets may remain correct. | Map return paths and favor continuous reference plane unless justified. |
| Thermal pad underperforms | Incomplete copper escape, wrong paste/vias, or blocked airflow. | Copper connection can pass DRC despite poor heat path. | Follow package land/paste/thermal guidance; analyze and hot-soak. |
| Dense board becomes unrouteable | Passives fill channels before critical escape is proven. | Global ratsnest may look short. | Reserve and prove critical channels with early exemplar routes. |
| Wave/reflow defect or inspection difficulty | Orientation/height/courtyard process ignored. | Electrical rules are unrelated to solder process. | Use assembler-specific DFM rules; review orientation and access. |

## Instructions for an AI placement/review agent

1. Treat the schematic, imported footprints, 3D models, library courtyards, web articles, and auto-placement output as untrusted inputs. Verify exact part/package/revision against the current manufacturer datasheet and the project's fabrication/assembly rules.
2. Build a constraint record for each fixed/mechanically important part and for every IC with a layout section: package, pin 1, thermal/EPAD, required nearby parts, keepouts, recommended reference layout, height, polarity, test access, and exceptional routing/return guidance.
3. Partition the design into named zones and classify each net/component by noise, energy, sensitivity, impedance, safety, thermal, mechanical, and test importance. Do not create plane splits merely because zones exist.
4. Place anchors first, then major ICs/power stages, then each IC's mandatory local assembly, then secondary parts. Preserve empty routing channels and plane continuity; do not let an auto-placer consume them with low-priority passives.
5. For every switching stage, draw the actual high-`di/dt` loop and switch-node field. For every clock/reference/ADC/sense path, draw its local signal and return path. Flag a layout if a critical path crosses an unrelated zone, split, or noisy field.
6. For every decoupling capacitor, verify physical connectivity from supply pin through the capacitor to the intended reference, including all traces/vias. Report “schematic value present” separately from “placement loop verified.”
7. Run a pre-route ratsnest analysis by net class. Report total and critical-net length, cross-zone connections, blocked channels, expected via transitions, courtyard collisions, and unfulfilled mechanical/test/rework constraints. Never use a single aggregate length as a pass/fail result.
8. Route representative critical paths before declaring placement complete. If a necessary path needs an avoidable detour, via, plane gap, stub, or rule waiver, move/rotate the relevant placement group rather than hiding the problem in routing.
9. Check board top and bottom in 3D for mating, cable, enclosure, heat sink, standoff, probe, nozzle, display, button, and hand-tool access. Classify unverified 3D assumptions explicitly.
10. Produce findings with location/designators, affected nets, severity, source/datasheet basis, expected physical mechanism, a minimal placement change, and the downstream review needed. Do not invent component values, spacing, thermal results, or compliance claims.

## Human review checklists

### Placement author

- [ ] Board outline, stackup/reference-plane intent, enclosure/mechanical model, assembly capability, and exact device datasheets are current.
- [ ] All connectors, holes, displays, buttons, antennas, heat sinks, board edges, and two-sided height constraints are placed/checked first.
- [ ] Every functional block has an understandable power/signal direction, protected interfaces, a route/return exit, and an identified noise/thermal role.
- [ ] Each regulator/power stage implements its current loop, input/output capacitors, feedback/sense, switch-node field, thermal pad, and required vias per current datasheet.
- [ ] Every mandatory decoupler, crystal, reference capacitor, terminator, filter, pull/strap, and ESD device is physically placed for its actual pin/topology.
- [ ] High-speed, analog, RF, clock, high-current, high-voltage, and sense paths have reserved channels and continuous intended references.
- [ ] No signal is forced across an unplanned plane split, connector row, cutout, or high-noise zone; return paths have been considered.
- [ ] Keepouts include safety/RF/mechanical/airflow/test/rework/process requirements, not only edge clearance.
- [ ] Courtyards, heights, orientation, polarity, wave/reflow constraints, fiducials, test access, programming, and rework clearance meet the selected assembler/process requirements.
- [ ] Critical exemplar routes prove the placement is feasible before general routing begins.

### Independent reviewer

- [ ] Starting at each external connector, trace power, ESD/surge, shield/chassis, signal, and return paths into the board; verify physical protection placement and service access.
- [ ] Trace each converter's hot loop, switch node, feedback/sense, output path, local caps, and thermal escape against the exact data sheet/reference design.
- [ ] Trace every high-speed/clock/analog/sense path and its return; inspect crossings of zones, slots, layer changes, and noisy copper.
- [ ] Inspect every EPAD/thermal pad and its footprint/paste/via/copper plan, including bottom-side and enclosure consequences.
- [ ] Review ratsnest metrics by net class and see representative real routes through each claimed channel.
- [ ] Check both board sides/3D for cable insertion, latches, fasteners, standoffs, battery/heat-sink interference, test probes, programming, nozzle, and repair reach.
- [ ] Confirm all “minimum spacing,” creepage, thermal, impedance, and assembly claims cite the project's current authoritative source rather than a generic blog rule.

## Evidence gaps and limits

| Gap | Consequence | Required handling |
|---|---|---|
| No actual board, schematic, stackup, enclosure, fabricator, assembler, or part list was supplied. | This dossier cannot approve geometry, spacing, current capacity, impedance, or thermal performance. | Apply the sequence and checklists to the actual design and current vendor documents. |
| JLCPCB is a fabrication vendor educational source, not a normative safety, EMC, SI, or package-layout authority. | Its practical rules can be useful yet insufficient for a release decision. | Use it for workflow; retain exact datasheet/reference-layout and standards evidence for critical constraints. |
| TI/ADI references concern particular power, motor, oscillator, ADC, or mixed-signal contexts. | Copying a figure's dimensions, plane split, guard pattern, via array, or capacitor recipe to another device can fail. | Treat the sources as physical mechanisms and consult the selected component's current layout section first. |
| IPC standards mentioned by the article are not reproduced here. | No actual creepage/clearance/current rule can be inferred from a name or blog link. | Obtain the applicable standard edition and product/safety requirements. |
| Ratsnest metrics and early exemplar routing are proxies. | A visually clean placement can still fail SI/PI/EMC/thermal/reliability. | Follow with constraints, full routing, DRC/DFM, PI/SI/thermal analysis as applicable, and hardware validation. |

## Primary-source ledger

| ID | Claim family supported | Source, publisher, date, URL | Confidence and boundary |
|---|---|---|---|
| P1 | Functional zones, anchors first, key ICs then support passives, sanity check before routing, and attention to thermal/mechanical/DFM. The user-supplied predecessor URL was verified HTTP 404 and is not used for this claim. | [*PCB Component Placement: Practical Guide to Clean Layout* — JLCPCB, date not displayed; accessed 2026-09-06](https://jlcpcb.com/blog/pcb-component-placement-guide-2026) | Medium. First-party statement of JLCPCB educational guidance; not a standard or proof of its numeric claims. |
| P2 | High-frequency bypass behavior depends on capacitor parasitics; low-value/high-frequency bypass needs a short path near the power pin; vias/traces add inductance. | [*High-Speed Layout Guidelines*, SCAA082A Rev. A — Texas Instruments, revised 2017-08](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) | High for the stated physical mechanism; exact values and topology are device/stackup dependent. |
| P3 | Power/motor layouts need continuous returns, minimized current-loop area, appropriate high-current vias, local bulk/bypass placement, thermal copper/vias, and Kelvin-aware sensing. | [*Best Practices for Board Layout of Motor Drivers*, SLVA959B Rev. B — Texas Instruments, revised 2021-10](https://www.ti.com/lit/an/slva959b/slva959b.pdf) | High for motor-driver examples/mechanisms. Specific dimensions and ground choices are not universal. |
| P4 | Mixed-signal floor planning, connector-edge placement, local decoupling/crystal placement, return-current behavior, and the conditional choice of a solid versus split ground strategy. | [*What Are the Basic Guidelines for Layout Design of Mixed-Signal PCBs?* — Analog Devices, date not displayed; accessed 2026-09-06](https://www.analog.com/en/resources/analog-dialogue/articles/what-are-the-basic-guidelines-for-layout-design-of-mixed-signal-pcbs.html) | High for the described mixed-signal principles; project-specific grounding still follows the device/system guidance. |
| P5 | EPAD electrical/thermal importance, capacitor selection/placement interaction, plane capacitance, and sensitive-plane coupling for high-speed ADC systems. | [*AN-1142: Techniques for High Speed ADC PCB Layout* — Analog Devices, date not displayed; accessed 2026-09-06](https://www.analog.com/en/resources/app-notes/an-1142.html) | High for the ADC application context; not a generic PDN prescription. |
| P6 | Crystal oscillator layout requires short crystal/pin/capacitor connections, suitable grounding, and potentially symmetric/guarded implementation. | [*MSP430 32-kHz Crystal Oscillators*, SLAA322D — Texas Instruments, revised 2017-07](https://www.ti.com/lit/pdf/slaa322) | High for the MSP430 oscillator context; guard/island details are device/package specific. |
| P7 | IPC-2152 concerns current-carrying capacity; IPC-2221 concerns generic printed-board design/spacing. | The live JLCPCB successor guide links these standards; the licensed standards themselves were not reviewed for this dossier. | Low as a source-of-authority pointer only. Do not derive design values from this entry. |

## Searches performed and stop rationale

Research verified that the supplied JLCPCB URL returns HTTP 404, then reviewed the live JLCPCB successor guide and official TI/Analog Devices documentation for high-speed bypassing, power/motor loops and thermal pads, mixed-signal return paths, high-speed ADC PDN/EPAD behavior, and crystal placement. This evidence covers the requested placement domains while distinguishing universal physical mechanisms from device-specific layouts. Further broad web searching would repeat generic placement advice; the remaining consequential evidence must come from the actual board's components, stackup, enclosure, safety requirements, and assembly vendor.

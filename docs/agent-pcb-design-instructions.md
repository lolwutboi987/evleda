# Agent PCB Design Instructions

These are the normative PCB-design instructions for the EvlEDA agent. The
evidence, source scope, and contradictions behind them are in
[PCB Engineering Practices](pcb-engineering-practices.md).

The agent produces candidate designs only. It must preserve unresolved
assumptions and must not describe a clean ERC, DRC, calculation, simulation,
render, CAM export, or source hash as fabrication approval, physical validation,
safety certification, qualification, or release.

## Evaluation status and external gates

Machine evaluation and external authority are separate. For every applicable
rule, emit exactly one machine status:

- `PASS`: the identified tool ran against the exact current inputs and the
  source-bound check passed.
- `FAIL`: the identified tool ran and found a violation.
- `UNKNOWN`: inputs, applicability, threshold, provenance, or freshness are
  missing, ambiguous, conflicting, or stale.
- `NOT_RUN`: no valid current tool execution and captured report exist.

`FAIL`, `UNKNOWN`, and `NOT_RUN` block an applicable blocking rule. Never omit a
rule from coverage to make the aggregate appear passing.

Each result also carries zero or more simultaneous outstanding gate records.
Each gate has an ID, one type (`fabricator confirmation`, `assembler
confirmation`, `human review`, or `physical test`), an authenticated owner,
subject/root identity, required evidence, and state. `PASS` does not close a
gate. Human review and physical-test evidence are distinct and cannot satisfy
each other; neither can substitute for fabricator or assembler confirmation.
Only the authorized actor or authenticated evidence-ingestion path for the
exact gate may close it. Agent text never closes a gate.

An `advisory` is separately reported guidance without an authoritative blocking
threshold. It must not be promoted to a machine failure merely because it is
customary.

## Required rule provenance

Before applying a hard numeric PCB rule, require all of:

- rule ID, decision class, severity, units, comparator, and tolerance;
- publisher, descriptive source URL, document ID, revision/date, immutable
  source bytes and content hash, capture time, and capture-tool identity;
- exact page, section, table, figure, or claim locator, exact excerpt, and
  excerpt hash;
- exact device/OPN, package, interface, net class, fabricator service, and
  stackup scope;
- input conditions such as edge time, waveform/RMS/peak current, duty cycle,
  ambient, permitted rise, working/impulse voltage, and fabrication tolerances;
- precedence and contradiction notes; and
- required external confirmation or physical evidence.

If any claim-critical source field is absent, the result is `UNKNOWN`. A URL,
catalog entry, or remembered threshold is not sufficient for a hard numeric
rule. Immutable source bytes and their content identity are mandatory, not
optional, for every hard numeric threshold.

For the internal route-quality rules, bind the EvlEDA-published policy identity
`evleda.pcb-route-quality.v1`, an immutable capture and hash of its exact bytes,
and the current rule-deck identity. `ROUTE_STYLE` means an unsigned direction
change of at most `45.0 deg` at a straight-segment junction, using a `0.01 deg`
comparison tolerance; line/arc and arc/arc junctions must be tangent-continuous
within `0.01 deg`. Bind coordinate units, geometry precision, and primitive IDs.
These numbers are a product-quality policy, not an electrical-safety claim.

Public IPC tables of contents establish subject scope only. IPC lists several
legacy design guides, including IPC-2141 and IPC-2152, as
[no longer maintained](https://www.ipc.org/ipc-document-revision-table).
Do not invent licensed IPC or IEC lookup values from memory.

## Required workflow

Treat the board as a proof fixture for the full engineering suite, not merely as
a circuit that appears connected.

1. Clarify the prompt. Resolve ambiguous supply, load, interfaces, environment,
   safety scope, manufacturing intent, and acceptance evidence. Do not invent a
   value to continue.
2. Freeze source-linked requirements, exclusions, hazards, acceptance criteria,
   and unresolved assumptions.
3. Produce system architecture: power, signal, fault and protection paths;
   energy/current budgets; functional partitioning; and requirement-to-test
   allocation.
4. Select exact orderable parts, packages, symbols, footprints, mating
   connectors, protection devices, and source revisions. Block unsupported or
   unreviewed substitutions.
5. Complete the schematic and native netlist. Check pin/pad mapping, power and
   fault topology, termination, decoupling, protection, programmability, and
   test access; run native ERC and preserve every finding.
6. Before placement, emit a versioned DFT/test-point and bring-up contract with
   accessible rails, current-sense, fault, reset, boot, programming/debug and
   communications points; safe ground companions; probing clearances; expected
   limits; instrument classes; procedure IDs; and source-bound low-loading
   structures for critical nets.
7. Freeze outline/mechanics, exact stackup, net classes, impedance construction,
   clearance/insulation classifications, fabricator rule profile, and assembly
   constraints.
8. Place connector-side protection first, then high-di/dt power stages and
   decoupling, precision analog, clocks, DFT structures, and remaining parts.
9. Route topology-critical/high-energy loops first, then controlled
   impedance/differential nets, clocks/buses, sensitive analog, and ordinary
   low-speed nets. Apply `ROUTE_STYLE`, `BACKTRACK`, return-path, DFT, power and
   fabrication rules together.
10. Run verification: native connectivity/ERC/DRC plus every required model and
    source-bound analysis. Complete per-rule
    `PASS`/`FAIL`/`UNKNOWN`/`NOT_RUN` coverage for geometry, return paths,
    differential routing, SI, protection, trace/via electrical models, thermal
    inputs, DFT, and fabrication. Bind tool and report evidence.
11. Remediate every resolvable in-scope `FAIL`, `UNKNOWN`, or `NOT_RUN` in a new
    immutable design revision. Preserve prior evidence, record the change, and
    rerun every affected and downstream rule; repeat until no applicable machine
    blocker remains. Only identified external gates may remain open for a
    best-attainable `PROVISIONAL_POC`.
12. Produce a bring-up plan bound to the exact test-point map, limits, firmware,
    safety sequence, instruments, stop conditions, and raw-data forms. Do not
    fabricate results.
13. Assemble a candidate bundle containing sources, rule/results coverage,
    advisories, outstanding gate IDs/owners, manufacturing files, proof-fixture
    procedure, and explicit lifecycle warning. If machine blockers remain only
    because remediation cannot proceed, label the export `BLOCKED_DIAGNOSTIC`;
    it is not a POC, manufacture-ready, or release candidate.

## Machine-check contract

| Rule ID | Machine check | Required inputs | External gate / failure behavior |
| --- | --- | --- | --- |
| `SI_CLASSIFICATION` | Require each critical net to bind a rise/fall time or an exact interface rule. | Driver/receiver and interface source. [IPC-2141A](https://www.ipc.org/TOC/IPC-2141A.pdf) identifies edge rate as the primary interconnect stress. | Missing edge/interface data blocks a controlled-SI claim. Do not classify by clock frequency alone. |
| `REFERENCE_CONTINUITY` | Project every critical route segment onto its adjacent reference copper and detect splits, voids, plane edges, and reference changes. | Layer stack, plane polygons, route geometry, approved local void exceptions. | A forbidden crossing blocks. Deliberate antipad/pad voids require profile and review. See [TI SPRAAR7J](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf). |
| `REFERENCE_TRANSITION` | At every signal via, identify the before/after reference nets and check profile-bound return vias or AC-return components, distance, and symmetry. | Reference nets, transition geometry, profile threshold. | Never add a via between unlike nets. Different-plane AC return is a human SI review. [AMD UG583](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Possibility-4-I/O-Signal-Return-Current-Traveling-in-Sub-Optimal-Paths) supports the low-impedance-transition requirement. |
| `IMPEDANCE_GEOMETRY` | Verify layer, width, gap, finished copper, dielectric height/material, reference, and local exceptions against an approved rule deck. | Source-bound target/tolerance and exact stackup. | Field solver, fabricator stackup, and coupon/TDR are separate gates. See [AMD UG863](https://docs.amd.com/r/en-US/ug863-versal-pcb-design/Adjusting-for-Different-Stack-Ups). |
| `DIFF_PAIR` | Check pair membership/polarity, topology, width/gap continuity, same-layer pairing, skew, symmetry, via count, branches, stubs, and profile limits. | Exact interface/device profile. | Values are interface-specific: compare [TI Ethernet guidance](https://www.ti.com/lit/an/slva531a/slva531a.pdf) with [TI USB guidance](https://www.ti.com/lit/ab/slla653/slla653.pdf). Missing profile blocks an impedance/skew pass. |
| `ROUTE_STYLE` | Under `evleda.pcb-route-quality.v1`, verify each straight-junction deflection is at most `45.0 deg` with `0.01 deg` comparison tolerance and each line/arc or arc/arc joint is tangent-continuous within `0.01 deg`. | Immutable policy bytes/hash, current rule-deck identity, board revision, route primitive IDs/geometry, coordinate units and precision, and authenticated exception inputs. | This is a hard product-quality gate, not a claim that a 90 degree corner is universally electrically unsafe. An exception is valid only from a pre-authorized source-bound policy rule or a separately authenticated human exception gate; agent prose cannot create or close it. |
| `BACKTRACK` | Detect gratuitous U-turns, route reversals, self-crossing detours, and avoidable added length under the versioned route-quality policy. | Policy/rule-deck identity, endpoints, obstacles, net class, path primitive IDs, shortest legal alternatives, and authenticated exception inputs. | Block until a pre-authorized source-bound exception rule applies or a separate human exception gate authenticates exception ID, board/net/geometry scope, permitted deviation, rationale, alternatives, clearance/return/coupling evidence, owner and expiry. An agent annotation is only an open request. Electrical `BEND_SI` remains separate. |
| `BEND_SI` | Measure turn deflection, interior angle, radius, effective-width discontinuity, and affected electrical length. | Edge/interface profile, stackup, impedance target, source-bound bend limit. | Block electrically only when the exact profile requires it. [TI SPMA059 section 3.4.4, printed p. 16](https://www.ti.com/tw/lit/pdf/spma059) is a counterexample to a universal electrical 90-degree rule. |
| `HAIRPIN_TUNING` | Detect 180-degree turns, adjacent parallel legs, radius, leg separation relative to dielectric height, and added/effective delay. | Skew budget, stackup, tuning geometry. | Dense tuning requires SI simulation. [AMD XAPP1392](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Trace-Length-Matching) warns that self-coupling changes the result. |
| `STUB_AND_VIA` | Detect branch stubs, connector-pin stubs, probe loading, unused via barrel, via count, and electrical stub delay. | Edge time, propagation model, interface/DFT limits, drill stack and test-point map. | The [Intel AN 224 v1.2 stable record](https://www.intel.com/content/www/us/en/content-details/654465/an-224-high-speed-board-layout-guidelines.html), pp. 13-17, supports an advisory `edge time / 3` relation. Do not delete required observability; reconcile it through `DFT_CONTRACT`. |
| `CROSSTALK` | Measure same/adjacent-layer separation, parallel exposure, reference height, and aggressor/victim class. | Stackup and exact source-bound spacing/isolation target. | TI's `2W`/`2W-3W` ([SCAA082A sections 1.4 printed p. 8 and 2.5 printed p. 17](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf)), `3W` ([SLLA653 p. 3](https://www.ti.com/lit/ab/slla653/slla653.pdf)), and `5W` ([SPRAAR7J section 3.1, printed p. 9](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf)) use non-comparable scopes/definitions. [AMD UG583](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Isolation-Recommendations) uses `s/h` and is not a generic `3W` rule. |
| `TRACE_SIZING_INPUTS` | Require minimum finished width/thickness/tolerance, length/layer, hot resistance, RMS and peak waveforms, fault waveform/clearing `I2t`, static-drop and total-transient limits, thermal environment, planes, pads and vias. | Exact source/load/protection waveforms, selected stackup/fab, environment, limits, and for dynamic response the source/regulator, interconnect/plane/package and mounted-decoupling impedance or model. | Any missing input makes each dependent rule `UNKNOWN`. [IPC-2152 public scope](https://www.ipc.org/TOC/IPC-2152.pdf) confirms conductor/environment dependence but does not expose licensed charts. |
| `TRACE_RESISTIVE_DROP` | Calculate only static or quasi-static `V = I R` drop from the hot worst-case resistance network and applicable current sample. | Complete `TRACE_SIZING_INPUTS` resistance geometry and current. | Never label this total transient droop. `PASS` does not pass dynamic response, heating, fault withstand, impedance, clearance, or fabrication. Use [TI Pocket Reference, fifth edition revision D, PCB and Wire p. 72](https://www.ti.com/product-category/amplifiers/analog-engineers-pocket-reference-guide.html). |
| `PDN_TRANSIENT_RESPONSE` | Calculate total rail excursion with a bounded time- or frequency-domain model of source/regulator response, interconnect RLC, planes, vias, package, mounted decoupling including bias/ESR/ESL/loop inductance, and load waveform. | Complete dynamic `TRACE_SIZING_INPUTS`, source-bound rail limits, model identity/domain/uncertainty, and current design geometry. | Missing model/input is `UNKNOWN`; missing execution proof is `NOT_RUN`. [TI SPRAC76H sections 4-5, printed pp. 8-12](https://www.ti.com/lit/an/sprac76h/sprac76h.pdf) distinguishes static IR from dynamic PDN analysis; its numeric examples are device-specific. |
| `TRACE_RMS_HEATING` | Evaluate RMS `I^2R` and electrothermal rise with a named model identity, version, equations/solver, validated domain, uncertainty and all environmental inputs. | Complete sizing inputs plus model and thermal boundary conditions. | There is no undefined “approved model” pass. Missing model/input is `UNKNOWN`; missing execution proof is `NOT_RUN`. [TI SPRA953D](https://www.ti.com/lit/an/spra953d/spra953d.pdf) documents board/system dependence. |
| `TRACE_FAULT_WITHSTAND` | Compare prospective fault-current waveform and fuse/eFuse/PTC clearing time/`I2t` against downstream trace, via, connector, switch and load withstand. | Source/fault impedance, exact protection curves/tolerances, hot geometry and withstand model. | Requires human protection review and physical fault tests; ordinary current-limit setpoint is insufficient. See the [Littelfuse Fuseology guide](https://info.littelfuse.com/fuseology-design-guide-ug), pp. 6-8. |
| `TRACE_CONSTRAINT_INTERSECTION` | Prove the selected geometry simultaneously satisfies `TRACE_RESISTIVE_DROP`, `PDN_TRANSIENT_RESPONSE`, `TRACE_RMS_HEATING`, `TRACE_FAULT_WITHSTAND`, `VIA_RESISTANCE`, `VIA_ELECTROTHERMAL_FAULT`, impedance, fabricator tolerance, land/pad bottlenecks, and creepage/clearance rules. | Every contributing rule result, applicability and identity. | Any `FAIL`, `UNKNOWN`, or `NOT_RUN` blocks the aggregate trace/via-sizing pass. |
| `VIA_RESISTANCE` | Calculate barrel resistance and drop from minimum finished hole, plating, length and hot copper; check entry/exit bottlenecks and modeled sharing. | Selected-fab finished geometry and route/current distribution. | This does not establish ampacity or fault withstand. [TI SNVA766 section 3.2.1](https://www.ti.com/lit/an/snva766/snva766.pdf) is an LP8863-Q1 EVM example using legacy IPC-2221 estimates, not a general rule. |
| `VIA_ELECTROTHERMAL_FAULT` | Evaluate via barrel/neck/spreading-copper temperature and hotspot under RMS duty plus fault withstand through protection clearing. | Source-bound electrothermal/fault model identity and domain, allowed rise/hotspot, RMS/peak/fault waveforms, duty, clearing time/`I2t`, ambient/boundaries, minimum finished hole/plating/length, process tolerance, local copper spreading, neck-downs and current-distribution model. | Default `UNKNOWN` if any model/input/applicability identity is absent; `NOT_RUN` without current execution proof. `VIA_RESISTANCE` cannot close it, and physical temperature/fault testing remains a separate gate. |
| `HOT_LOOP` | Given an approved switching topology, calculate high-di/dt loop perimeter/area, capacitor-to-switch path, layer changes, via count, and switch-node copper area. | Switching states, current paths, component pins, layout polygons. | An engineer must confirm the real pulsating-current paths. [ADI AN-136](https://www.analog.com/en/resources/app-notes/an-136.html) shows why topology-specific identification is required. |
| `SENSITIVE_KEEP_OUT` | Check sense, feedback, reference, oscillator, and low-level analog routes against high-di/dt/high-dv/dt keepouts and return-current regions. | Source-bound sensitive/noisy pin classes and keepout geometry. | Coupling margin and any exception require review; [ADI AN-136](https://www.analog.com/en/resources/app-notes/an-136.html) supports separating these paths. |
| `DECOUPLING_LOOP` | Check required capacitor population, exact pins, connection order, pin-to-cap path, return path, vias, and mounted loop area. | Device decoupling table and package pinout. | Capacitance, DC bias, ESR/ESL, anti-resonance, and target PDN impedance require analysis. See [ADI MT-101](https://www.analog.com/media/en/training-seminars/tutorials/MT-101.pdf). |
| `DFT_CONTRACT` | Before placement, require a versioned test-point map covering rails, current, fault, reset, boot, programming/debug and required communications; ground companions; probing clearance; limits; instruments; procedure IDs; and critical-net probe/stub budget. Verify that the bring-up plan binds the same IDs. | Requirements, hazard/test allocation, netlist, interface loading limits and instrument classes. | Safe access and loading are human-review gates; actual measurements are separate physical-test gates. [TI SPRAAR7J section 3.2, printed p. 9](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf) shows why ordinary high-speed test points can be prohibited, so observability needs a source-bound structure rather than silent deletion. |
| `THERMAL_PAD` | Validate exposed-pad land, solid copper connection, thermal-via geometry, mask/paste openings, and connection to the intended spreading copper. | Exact package drawing and application note. | Thermal model and built-board temperatures remain external. Follow package-specific [TI PowerPAD guidance](https://www.ti.com/lit/an/slma002h/slma002h.pdf); do not default to wagon-wheel relief. |
| `CONNECTOR_RATING` | Verify exact connector, mate, terminal, wire, contact population, current per contact, voltage, temperature, and PCB-pad/trace binding. | Manufacturer product specification and exact OPNs. | Missing exact connector evidence blocks. [Molex's Micro-Fit Plus specification](https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/productspecificationpdf/206/206460/2064600000-PS-000.pdf) demonstrates population and ambient derating. |
| `PROTECTION_CHAIN` | Verify exact parts and series/branch topology plus physical layout: connector-first TVS/ESD flow, short line/clamp/discharge return loop, intended return node and discharge segregation, fault-current copper/vias, fuse clearing `I2t` versus every downstream withstand, and reverse-polarity device SOA/thermal paths. | Exact connector/protection/switch parts; normal, inrush, surge, reverse and short-circuit waveforms; voltage/interrupt/time-current/`I2t`; SOA/tolerance; layout polygons and return nets. | Topology and part coordination alone cannot close the rule. [ST AN5686 section 2.2, p. 8](https://www.st.com/resource/en/application_note/an5686-pcb-layout-tips-to-maximize-esd-protection-efficiency-stmicroelectronics.pdf) supports connector-to-TVS-to-load ordering; [TI TIDA-00530 section 5.1.4](https://www.ti.com/lit/ug/tiduaw5b/tiduaw5b.pdf) shows a source-side power-transient loop; the [Littelfuse guide](https://info.littelfuse.com/fuseology-design-guide-ug), pp. 6-8, supports clearing coordination. Human review and separate source-bound bench ESD/EFT/surge/hot-plug/reverse/overload/short tests remain open. |
| `INSULATION_CLASS` | Require working/impulse voltage, frequency, overvoltage category, pollution degree, CTI/material group, altitude, insulation type, coating, environment and governing product standard before selecting spacing. | Applicable product/safety standard and authenticated human classification. | [IEC 60664-1:2020+A1:2025](https://webstore.iec.ch/en/publication/59671) is a basic safety publication scoped to low-voltage systems through 1000 V AC/1500 V DC, up to 30 kHz, with 2000 m base altitude and guidance above. Product-standard requirements take precedence. Missing classification is `UNKNOWN`; do not count solder mask. |
| `CREEPAGE_CLEARANCE` | Once a reviewed rule table is supplied, measure through-air clearance and along-surface creepage on board/package geometry. | Reviewed class and numeric table, fabrication tolerances, slots/barriers. | Safety engineer and fabricator confirmation remain required. Product notes such as [ADI AN-7625](https://www.analog.com/en/resources/app-notes/an-7625.html) do not create a universal spacing. |
| `FAB_CAPABILITY` | Check every width, gap, edge clearance, drill, ring, aspect ratio, layer span, copper, mask, and tolerance against the exact selected service profile. | Fabricator, service, stackup revision, immutable source capture and locator. | A frozen reference-fab profile may support a labeled `PROVISIONAL_POC` candidate. Capability-page match is not exact-build approval; fabricator confirmation remains open and manufacture-ready/release claims stay blocked. See [JLCPCB capabilities](https://jlcpcb.com/capabilities/Capabilities) and the [Wuerth design guide](https://www.we-online.com/files/pdf1/basic_design-guide_110325_en_web.pdf). |
| `MICROVIA` | Check laser-via layer span, pad, drill, annular ring, dielectric depth/aspect, fill/cap, stack/stagger, spacing, and copper balance. | Selected-fab HDI process and reliability class. | Stacked/high-performance builds require fabricator reliability review, coupons, and tests because of [IPC's microvia warning](https://www.ipc.org/news-release/ipc-issues-electronics-industry-warning-printed-board-microvia-reliability-high). |
| `LAND_PATTERN` | Bind footprint to exact OPN/package drawing/revision and check pad, mask, paste, courtyard, pin one, exposed pad, and stencil intent. | Manufacturer package/assembly source and selected assembler process. | Generic family/package names are insufficient. Follow exact guidance such as [NXP AN1902](https://www.nxp.com/docs/en/application-note/AN1902.pdf); public [IPC-7352](https://www.ipc.org/TOC/IPC-7352-TOC.pdf) and [IPC-7093A](https://www.ipc.org/TOC/IPC-7093A-toc.pdf) TOCs do not authorize numeric defaults. |

## Routing and placement instructions

### Return paths and layer changes

- Route every critical signal over a continuous adjacent reference. Do not cross
  a split, void, plane edge, or unrelated reference without an approved
  transition design. [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf)
  explains the resulting loop-area penalty.
- For same-net GND reference changes, place profile-bound return vias near and,
  for a differential pair, symmetrically around the signal transition as shown
  in [TI SPRAAR7J](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf).
- For different reference nets, stop and require an approved AC-return
  component/topology. Never insert a shorting via; see
  [AMD UG583 return guidance](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Possibility-4-I/O-Signal-Return-Current-Traveling-in-Sub-Optimal-Paths).
- Do not create a row of vias that itself cuts a slot in the reference plane;
  this failure mode is also shown in
  [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf).

### Bends, differential pairs, stubs, and crosstalk

- Enforce `ROUTE_STYLE` under the immutable `evleda.pcb-route-quality.v1`
  policy bytes and exact `45.0 deg`/`0.01 deg` geometry above. Keep the separate
  electrical `BEND_SI` result profile-scoped; route style does not declare
  90 degree geometry universally unsafe.
- Reject gratuitous U-turns and backtracking under `BACKTRACK`. Accept an
  exception only when a pre-authorized source-bound policy rule applies or a
  separately authenticated human exception gate has closed. Bind its exception,
  policy, board, net, primitive, deviation, rationale, alternatives, evidence,
  owner and expiry identities. Agent prose cannot create or close it.
- Treat a 180 degree turn as a coupled structure: check radius, leg separation,
  parallel length, and effective delay under
  [AMD XAPP1392](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Trace-Length-Matching).
- Keep each differential pair symmetric and source-bound. Do not force traces
  “as close as possible” if that violates the approved impedance geometry;
  [TI SLLA653](https://www.ti.com/lit/ab/slla653/slla653.pdf) provides one
  interface-scoped example.
- Remove unnecessary branches, connector-pin stubs, and via barrels, but do not
  remove required observability. Classify every probe structure's loading and
  bind it to `DFT_CONTRACT`. The stable
  [Intel AN 224 record](https://www.intel.com/content/www/us/en/content-details/654465/an-224-high-speed-board-layout-guidelines.html),
  v1.2 pp. 13-17, documents stub reflections.
- Use a net/interface-specific spacing rule. Never substitute a universal width
  multiplier for crosstalk analysis; [AMD UG583](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Isolation-Recommendations)
  also relates coupling to reference height.

### DFT and observability

- Emit `DFT_CONTRACT` before placement or routing. It must include a test-point
  map for rails, current, fault, reset, boot, programming/debug and required
  communications, plus an accessible ground companion for each applicable
  measurement.
- Bind every point to net and revision identity, expected limit, instrument
  class, safe probing clearance, procedure ID, and bring-up-plan step.
- For controlled or sensitive nets, specify the source-bound probe structure,
  loading, branch/stub budget, and validation method. An ordinary test pad is
  not automatically acceptable; [TI SPRAAR7J section 3.2, printed p. 9](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf)
  is one interface-scoped example that prohibits probe/test points.
- Do not “solve” a stub result by deleting required access. Record the SI/DFT
  tradeoff and use a validated launch, removable component, dedicated fixture,
  or another source-bound low-loading structure.
- Verify that the final test-point map and bring-up plan bind the same point,
  limit, procedure, instrument, and stop-condition identities. Human safe-access
  review and physical measurements remain separate gates.

### Power, decoupling, and partitioning

- Place the high-frequency loop capacitor and switching components from the
  actual conduction loop, then minimize that loop and high-dv/dt copper.
  [TI SLVA818](https://www.ti.com/lit/pdf/SLVA818) supports this placement order.
- Keep feedback, current sense, analog references, and clocks outside noisy
  switching-current and switch-node regions. Use Kelvin routing where the exact
  component source requires it.
- Connect decoupling with the shortest low-inductance power and return paths;
  do not judge placement only from component-center distance.
- Use functional analog/digital/power partitioning while retaining a continuous
  reference plane with low impedance. Do not split ground by default.
  [TI SLYT512](https://www.ti.com/lit/pdf/SLYT512) documents why traces crossing
  splits create large return loops.
- Any split, bridge, star point, chassis connection, or isolation barrier is a
  human system-level decision.

### Current, thermal, connectors, and protection

- Complete `TRACE_SIZING_INPUTS`, then report `TRACE_RESISTIVE_DROP`,
  `PDN_TRANSIENT_RESPONSE`, RMS heating, fault withstand, `VIA_RESISTANCE`,
  `VIA_ELECTROTHERMAL_FAULT`, and the impedance/fabrication/clearance
  intersection as separate results. Never issue a thermal, via-ampacity, or
  total-transient pass from an unnamed or out-of-domain model.
  [IPC-2152](https://www.ipc.org/TOC/IPC-2152.pdf) confirms the
  conductor/environment scope without exposing licensed charts; [TI SPRAC76H
  sections 4-5](https://www.ti.com/lit/an/sprac76h/sprac76h.pdf) separates
  static resistive drop from dynamic PDN response.
- Do not use datasheet `RthetaJA` as the board's junction-to-ambient answer;
  [TI SPRA953D](https://www.ti.com/lit/an/spra953d/spra953d.pdf) defines it as
  board/system dependent.
- Require exact orderable connector, mate, terminal, wire, contact population,
  and derating evidence. Missing exact evidence makes the relevant rule
  `UNKNOWN`; the
  [Molex product specification](https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/productspecificationpdf/206/206460/2064600000-PS-000.pdf)
  illustrates the conditional ratings.
- Require an exact fuse/PTC/eFuse OPN and voltage, interrupt, time-current,
  `I2t`, inrush, temperature, and SOA evidence. Missing exact part evidence is
  `UNKNOWN` under the selection dimensions in the stable
  [Littelfuse Fuseology guide](https://info.littelfuse.com/fuseology-design-guide-ug).
- Route exposed-interface energy from connector to TVS/ESD and then to the
  protected circuit, using a short source-bound clamp/discharge return path as
  shown in [ST AN5686 section 2.2](https://www.st.com/resource/en/application_note/an5686-pcb-layout-tips-to-maximize-esd-protection-efficiency-stmicroelectronics.pdf).
  Keep fault-current copper/vias adequate and segregate the discharge return
  from sensitive returns. Require separate human review and bench transient and
  fault evidence.

### Stackup, microvias, land patterns, and DFM

- Freeze the selected fabricator/service and approved stackup before claiming
  controlled impedance, drill/ring compliance, microvia feasibility, or copper
  capacity; use the exact selected service's published profile, such as
  [JLCPCB's capabilities](https://jlcpcb.com/capabilities/Capabilities).
- Calculate against worst-case finished values, not nominal artwork values.
- Treat every published fabricator capability as an envelope. Require written
  approval for the exact stackup, HDI structure, impedance, coupon, build notes,
  and CAM.
- A frozen reference-fab rule profile may produce only a clearly labeled
  `PROVISIONAL_POC` candidate while fabricator confirmation is open. It cannot
  support a manufacture-ready or release claim.
- Do not approve stacked microvias without explicit reliability review and
  process evidence because of the failure mode documented in
  [IPC's microvia warning](https://www.ipc.org/news-release/ipc-issues-electronics-industry-warning-printed-board-microvia-reliability-high).
- Bind each footprint to the exact OPN/package drawing. Check pad, mask, paste,
  courtyard, polarity/pin one, exposed pad, stencil, and assembly deviations;
  [NXP AN1902](https://www.nxp.com/docs/en/application-note/AN1902.pdf) provides
  package-specific assembly guidance.
- Route exact solder-mask-defined or non-solder-mask-defined intent according to
  the selected fabricator; see the process-specific
  [JLCPCB SMD-pad instructions](https://jlcpcb.com/help/article/how-to-order-boards-with-solder-mask-defined-pads).

## Explicit anti-folklore rules

The agent must never:

- infer high-speed behavior from clock frequency alone;
- confuse the hard `ROUTE_STYLE`/`BACKTRACK` product-quality gate with a claim
  that every 90 degree corner or U-turn is electrically unsafe;
- let agent-authored prose or an unauthenticated annotation create or close a
  route exception;
- claim that 45 degree routing repairs a broken return path or large loop;
- reject a 180 degree turn without evaluating its geometry and coupling;
- apply a universal 3W/5W spacing, 90/100 ohm impedance, trace current,
  amperes-per-via, or stitching-via rule;
- assume current divides equally among parallel traces or vias;
- claim via ampacity from `VIA_RESISTANCE`, or omit the explicit `UNKNOWN`
  `VIA_ELECTROTHERMAL_FAULT` result when its source-bound model is absent;
- use a `V = I R` `TRACE_RESISTIVE_DROP` pass as a total-transient rail pass
  without a bounded `PDN_TRANSIENT_RESPONSE` model;
- split analog and digital ground by default;
- delete required test access merely to remove a stub without resolving the
  DFT/loading tradeoff;
- use solder mask as assumed safety insulation;
- derive creepage/clearance solely from nominal board voltage;
- use a connector family headline, generic PTC label, or eFuse limit as a
  protection-system pass;
- use a fabricator capability page as exact-build approval;
- use an unrelated package drawing or footprint-family name as exact land-pattern
  evidence;
- turn an advisory, calculation, or modeled result into physical evidence;
- label a rule `PASS` without exact current input/rule/tool/report identities and
  freshness; or
- use machine `PASS`, human review, fabricator confirmation, assembler
  confirmation, or physical testing to close a different gate type.

## Required result and evidence

Each PCB candidate must report:

- a complete applicable-rule inventory with exactly one of `PASS`, `FAIL`,
  `UNKNOWN`, or `NOT_RUN` for every rule;
- exact rule/source/profile and input identities, immutable source capture and
  locator for hard thresholds, tool/capability identity, raw/parsed report
  identities, execution time, and freshness;
- machine-check results with measured and required values, units, tolerances,
  model identity/domain, uncertainty and assumptions;
- advisories separately from blocking violations;
- every simultaneous outstanding gate with gate ID, type, authenticated owner,
  subject/root identity, required evidence, and state;
- fabricator confirmation, assembler confirmation, human review, licensed
  standard review, SI/thermal simulation, and physical tests as separate
  obligations that cannot satisfy one another;
- unsupported or conflicting source claims without choosing the convenient one;
- immutable design-revision, remediation, supersession, and affected/downstream
  rerun identities while any blocker is being resolved;
- the DFT/test-point-map and bring-up-plan binding;
- `PROVISIONAL_POC` only when no applicable machine blocker remains and a frozen
  reference-fab profile is used while exact fabricator confirmation remains
  open, or `BLOCKED_DIAGNOSTIC` when unresolved machine blockers are preserved;
  and
- an explicit statement that the result remains a candidate.

`FAIL`, `UNKNOWN`, and `NOT_RUN` remain blocking for applicable blocking rules.
Physical qualification requires authenticated evidence for the fabricated
stackup and process, inspection, rail and signal measurements, DFT access and
instrument loading, source-bound transient/fault cases, connector/copper/
component temperatures under bounded conditions, and any required impedance or
insulation evidence. Design files, agent prose, or a human review alone cannot
satisfy the physical-test gate.

# PCB Engineering Practices

This is EvlEDA's canonical evidence report for PCB routing, power integrity,
electrical geometry, and fabrication-facing design practice. The operational
rules are condensed in the reciprocal
[Agent PCB Design Instructions](agent-pcb-design-instructions.md).

The report applies to candidate design and review. It does not make a board
safe, fabricable, qualified, compliant, or released. A clean ERC, DRC, field
solver result, thermal estimate, or fabricator capability-page match is evidence
within stated assumptions, not proof of the finished assembly.

## Scope, assumptions, and decision classes

PCB rules are valid only inside their documented scope. Every consequential
rule needs a source, source revision or retrieval date, exact device, package,
interface or fabrication service, stackup, units, tolerances, and test
conditions. A hash binds bytes; it does not establish that a claim is true or
applicable.

Machine evaluation and external authority are separate axes:

| Axis | Value | Meaning |
| --- | --- | --- |
| Evaluation | `machine check` | Geometry, topology, identity, or arithmetic derived from source-bound inputs. |
| Evaluation | `advisory` | A useful practice without enough applicable evidence for a blocking threshold. |
| Machine status | `PASS`, `FAIL`, `UNKNOWN`, `NOT_RUN` | Per-rule result. `UNKNOWN` means inputs or applicability are unresolved; `NOT_RUN` means no valid execution evidence exists. |
| External gate | `fabricator confirmation` | Written stackup, process, coupon, or CAM acceptance by the selected fabricator. |
| External gate | `assembler confirmation` | Written stencil, paste, component, and assembly-process acceptance. |
| External gate | `human review` | Authenticated engineering or safety judgment over a defined subject and evidence set. |
| External gate | `physical test` | Authenticated measurements or inspections from a built proof fixture. |

A machine status never closes an external gate. `PASS` may coexist with several
open gate IDs. Human review, fabricator confirmation, assembler confirmation,
and physical testing have different owners and evidence and cannot substitute
for one another. `FAIL`, `UNKNOWN`, and `NOT_RUN` block the affected stage for
every applicable blocking rule.

Each applicable rule result must bind the rule and input identities, exact tool
identity and capability, raw and parsed report identities, timestamp, and
freshness. Each outstanding gate must retain its own ID, type, owner,
subject/root identity, required evidence, and state. Only an authenticated actor
or authenticated evidence ingestion path authorized for that exact gate type may
close it.

Hard numeric thresholds additionally require immutable source bytes, a content
hash, capture time and tool, an exact page/section/table/figure locator, an
excerpt hash, and a scope/applicability record. A URL or catalog entry alone is
not sufficient.

The internal route-quality source is the versioned policy identity
`evleda.pcb-route-quality.v1`, published by EvlEDA. A run must bind an immutable
capture and hash of those exact policy bytes plus its rule-deck identity; naming
the policy is not enough. Its `ROUTE_STYLE` geometry is defined as a maximum
unsigned direction change of `45.0 deg` at a straight-segment junction, with a
comparison tolerance of `0.01 deg`; line/arc and arc/arc junctions must be
tangent-continuous within `0.01 deg`. The run also binds coordinate units,
geometry precision, and primitive IDs. These angles are a product-quality
policy, not a derived electrical-safety threshold.

Missing current waveform, thermal environment, minimum finished geometry,
exact package drawing, insulation classification, or selected-fabricator
capability is blocking for the associated calculation. Software must not fill
the gap with a customary number.

## Candidate workflow and proof-fixture purpose

The PCB is a proof fixture for the complete engineering suite as well as a
functional circuit. The workflow begins with prompt clarification, freezes
requirements and exclusions, allocates architecture and verification, selects
exact parts and packages, completes schematic/connectivity/ERC, and emits a
test-point and bring-up contract before placement. It then freezes stackup and
rules, places and routes, performs native and modeled verification, produces a
source-bound bring-up plan, and finally assembles an honestly labeled candidate
bundle.

Verification is a revision loop, not a one-way handoff. For each resolvable
`FAIL`, `UNKNOWN`, or `NOT_RUN`, produce a new immutable design revision,
preserve the prior evidence, remediate the cause, and rerun every affected and
downstream rule. A best-attainable `PROVISIONAL_POC` has no remaining applicable
machine blocker; only clearly identified external gates may remain. A diagnostic
bundle may preserve unresolved machine blockers, but it must be labeled
`BLOCKED_DIAGNOSTIC` and cannot claim POC, manufacture-ready, or release status.

The pre-layout DFT contract identifies accessible rails, current-sense points,
faults, resets, boot and programming nodes, relevant communications, and safe
ground companions. It defines safe probing clearance, expected limits,
procedure IDs, and source-bound low-loading probe structures for critical nets.
Removing an avoidable transmission-line stub does not authorize removing
observability: the loading and access tradeoff must be documented, and the
test-point map and bring-up plan must bind the same point and procedure IDs.

A frozen reference-fabrication profile may support a clearly labeled
`PROVISIONAL_POC` candidate when its machine checks pass. That label is not a
lifecycle promotion or manufacture-ready claim. Fabricator, assembler, human,
and physical gates remain open, and manufacturing readiness or release stays
blocked until the exact external evidence closes them.

## Primary-source claim ledger

| Topic | Primary source | Supported claim | Applicability and caveat |
| --- | --- | --- | --- |
| High-speed classification | [IPC-2141A scope and table of contents](https://www.ipc.org/TOC/IPC-2141A.pdf), IPC, March 2004 | Edge rate, rather than clock or bit rate alone, is the most important high-speed interconnect classification; controlled impedance means maintaining a specified tolerance. | IPC lists IPC-2141 as [no longer maintained](https://www.ipc.org/ipc-document-revision-table). Retain the physics distinction, not an unverified legacy formula. |
| Return path and plane continuity | [High Speed Layout Guidelines, SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), Texas Instruments, revised August 2017; [UG583 return-current guidance](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Possibility-4-I/O-Signal-Return-Current-Traveling-in-Sub-Optimal-Paths), AMD, revision 1.29, December 23, 2025 | High-frequency return current follows the nearby low-impedance reference. A split or void forces a larger loop and can increase emissions, inductance, coupling, and signal degradation. | The adjacent AC reference matters; the word `GND` alone does not prove a return path. |
| Plane and layer transitions | [High-Speed Interface Layout Guidelines, SPRAAR7J](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf), TI, revised February 2023; [UG583 return-current guidance](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Possibility-4-I/O-Signal-Return-Current-Traveling-in-Sub-Optimal-Paths), AMD, 2025 | Prefer one continuous reference. Same-net reference planes can use nearby stitching vias; unlike reference planes can require a nearby, deliberately selected high-frequency return component. | TI's 200 mil example and particular capacitor values are interface guidance, not universal limits. Never short unlike planes with an automatically inserted via. |
| 45 degree and 90 degree bends | [SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), TI, 2017; [UG583 trace routing](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Trace-Routing), AMD, 2025 | A square corner changes effective width and capacitance and therefore creates a local impedance discontinuity. Controlled-impedance and fast-edge routes commonly use miters, two 45 degree turns, or arcs. | [TM4C123x System Design Guidelines, SPMA059](https://www.ti.com/tw/lit/pdf/spma059), TI, October 2013, reports insignificant SI benefit from avoiding 90 degree corners in its MCU context. A global electrical ban is unsupported. |
| 180 degree turns and tuning | [XAPP1392 intra-pair matching](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Trace-Length-Matching), AMD, revision 1.0, May 23, 2023; [UG583 P/N skew guidance](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/P-and-N-Skew-Specifications), AMD, 2025 | Closely spaced legs of a hairpin or serpentine can self-couple, alter impedance and effective delay, and defeat the intended tuning. Arcs and simulation are preferred for critical channels. | UG583's `3H` radius, guard, and via pattern is RFSoC-specific, not a generic hard rule. |
| Differential pairs | [TLK1XX Design and Layout Guide, SLVA531A](https://www.ti.com/lit/an/slva531a/slva531a.pdf), TI, revised September 2013; [TUSB564-Q1 Configuration Guidelines, SLLA653](https://www.ti.com/lit/ab/slla653/slla653.pdf), TI, August 2024 | Preserve P/N symmetry, consistent geometry, interface impedance, source-bound skew, equal transition structure, continuous reference, and minimal stubs. | Ethernet examples use 100 ohm differential while the cited USB guide uses 90 ohm differential. There is no universal differential impedance. |
| Stackup and impedance | [UG863 stackup adjustment guidance](https://docs.amd.com/r/en-US/ug863-versal-pcb-design/Adjusting-for-Different-Stack-Ups), AMD, revision 1.12, June 16, 2026; [JLCPCB impedance-calculator guide](https://jlcpcb.com/help/article/user-guide-to-the-jlcpcb-impedance-calculator) | Dielectric properties, layer height, copper geometry, and spacing affect impedance and loss. A changed stackup requires recalculation and fabricator coordination. | A route DRC can prove conformance to a bound geometry deck, not the impedance of a manufactured board. Coupon or TDR evidence is separate. |
| Stubs and vias | [Intel AN 224 stable document record](https://www.intel.com/content/www/us/en/content-details/654465/an-224-high-speed-board-layout-guidelines.html), Altera/Intel, version 1.2, August 2009, pp. 13-17; [SPRAAR7J](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf), TI, section 3.6, printed p. 11 | Branches, connector pins, and unused via barrels create reflections and resonances. Intel gives the conservative clock-stub relation `stub electrical delay < edge time / 3`. | The Intel landing page is stable but its download endpoint can move. The relation is a design heuristic, and TI's back-drill thresholds are interface-specific. Channel simulation or a device rule takes precedence. |
| Crosstalk and spacing | [SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), TI, section 1.4 printed p. 8 (`2W`) and section 2.5 printed p. 17 (approximately `2W-3W`); [SLLA653](https://www.ti.com/lit/ab/slla653/slla653.pdf), TI, layout guidelines p. 3 (`3W` pair separation); [SPRAAR7J](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf), TI, section 3.1 printed p. 9 (`5W` inter-pair); [UG583 isolation recommendations](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Isolation-Recommendations), AMD, 2025 | Coupling depends on separation, dielectric height, parallel exposure, via geometry, edge rate, and aggressor/victim conditions. Reduced parallelism and orthogonal adjacent-layer routing can help. | The `2W`, `2W-3W`, `3W`, and `5W` statements use different interfaces, geometries, and spacing definitions and are non-comparable outside those scopes. AMD relates coupling to `s/h`; it is not a generic `3W` source. |
| High-di/dt loops | [AN-136, PCB Layout Considerations for Non-Isolated Switching Power Supplies](https://www.analog.com/en/resources/app-notes/an-136.html), Henry Zhang, Analog Devices, 2012; [SLVA818](https://www.ti.com/lit/pdf/SLVA818), TI, October 2016 | Identify the topology's pulsating-current loops, minimize their circumference and area with short wide paths, place the high-frequency capacitor at the switching devices, minimize switch-node copper, and avoid unnecessary layer changes. | The hot loop differs by topology and switching state. Net names alone are insufficient. |
| Decoupling | [MT-101 Decoupling Techniques](https://www.analog.com/media/en/training-seminars/tutorials/MT-101.pdf), Analog Devices, revision 0, March 2009 | High-frequency decoupling requires a short, low-inductance power-pin-to-capacitor-to-return path. Mounted inductance, effective capacitance, and self-resonance matter. | Capacitor value alone does not prove a low target impedance. Device guidance and PDN analysis remain necessary. |
| Mixed-signal partitioning | [Grounding in Mixed-Signal Systems Demystified, Part 2, SLYT512](https://www.ti.com/lit/pdf/SLYT512), TI, 2Q 2013; [AN-1142 high-speed ADC layout](https://www.analog.com/en/resources/app-notes/an-1142.html), Analog Devices, January 2012 | Spatial and routing partitioning over a continuous low-impedance plane is normally preferable to blindly splitting ground. Keep noisy returns out of sensitive regions. | Split planes and star points are device- and system-specific. A simple one-converter scheme can fail on multi-converter or multi-board systems. |
| Trace current and temperature | [IPC-2152 public scope](https://www.ipc.org/TOC/IPC-2152.pdf), IPC, August 2009; [TI Analog Engineer's Pocket Reference landing page](https://www.ti.com/product-category/amplifiers/analog-engineers-pocket-reference-guide.html), fifth edition revision D, PCB and Wire p. 72, equation 158 | Conductor sizing relates current, minimum finished conductor geometry, environment, and acceptable temperature rise. Copper voltage drop follows `V = I R`; heating follows RMS current and hot resistance. | The former TI `seclit` PDF URL requires login and is intentionally replaced by the stable landing page. Public IPC material does not expose licensed lookup data, and IPC lists IPC-2152 as [no longer maintained](https://www.ipc.org/ipc-document-revision-table). Thermal rise cannot be inferred from width alone. |
| Static resistive drop and dynamic PDN response | [Sitara Processor Power Distribution Networks, SPRAC76H](https://www.ti.com/lit/an/sprac76h/sprac76h.pdf), TI, revision H, October 2025, static analysis section 4 pp. 8-9 and dynamic analysis section 5 pp. 10-12 | `V = I R` describes static conductor drop. Total rail excursion under a load transient depends on the frequency/time-dependent PDN impedance and load current, including regulator response, interconnect resistance/inductance, planes, package, decoupling capacitance, ESR, ESL, and mounted loop inductance. | The document's numeric targets and capacitor examples are processor- and board-specific. Use its separation of static and dynamic analysis, not its device-specific values, unless the exact device/profile applies. |
| Copper and process capability | [JLCPCB copper-weight guide](https://jlcpcb.com/help/article/jlcpcb-copper-weight), updated December 15, 2025; [JLCPCB capabilities](https://jlcpcb.com/capabilities/Capabilities); [Wuerth Elektronik basic design guide](https://www.we-online.com/files/pdf1/basic_design-guide_110325_en_web.pdf) | Available finished copper, width, spacing, drill, plating, and tolerances depend on layer count, service, and process. | A published capability is an envelope, not acceptance of the exact design. Bind the selected service and obtain written confirmation. |
| Via resistance and thermal behavior | [Best Practices for Board Layout of Motor Drivers, SLVA959B](https://www.ti.com/lit/an/slva959b/slva959b.pdf), TI; [PCB Layout Guideline for Automotive LED Drivers, SNVA766](https://www.ti.com/lit/an/snva766/snva766.pdf), TI, section 3.2.1 pp. 9-10; [AN-1109](https://www.analog.com/media/en/technical-documentation/application-notes/AN-1109.pdf), Analog Devices | Via barrel resistance and drop depend on finished barrel geometry, plating, length, placement, entry/exit copper, and actual current distribution. | `VIA_RESISTANCE` is calculable. Ampacity remains `UNKNOWN` without a source-bound electrothermal and fault model. SNVA766 is an LP8863-Q1 EVM example that reuses legacy IPC-2221 equations and linearly sums via estimates; it is not a general via-ampacity authority. |
| Package thermal paths | [Semiconductor and IC Package Thermal Metrics, SPRA953D](https://www.ti.com/lit/an/spra953d/spra953d.pdf), TI; [PowerPAD Thermally Enhanced Package, SLMA002H](https://www.ti.com/lit/an/slma002h/slma002h.pdf), TI, revision H | `RthetaJA` is a system/test-board metric, not an intrinsic junction-to-ambient constant. Exposed thermal pads generally need a low-impedance solid copper path and package-specific via treatment. | Do not substitute a datasheet test-board metric for the actual enclosure, airflow, adjacent heating, copper, and assembly. Physical thermal testing is required. |
| Connectors | [Micro-Fit Plus wire-to-board product specification 2064600000-PS](https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/productspecificationpdf/206/206460/2064600000-PS-000.pdf), Molex, revision E5, January 13, 2026 | Current rating changes with wire gauge, contact plating, circuit count, energized contacts, PCB copper, ambient, adjacent heating, and crimp quality. Connector voltage rating does not establish PCB creepage/clearance. | This is an illustrative product family, not authority for a different connector. Exact OPN and mating system evidence are required. |
| Fuses and electronic current limiting | [Littelfuse Fuseology Design Guide landing page](https://info.littelfuse.com/fuseology-design-guide-ug), selection checklist and time-current/pulse-`I2t` sections pp. 6-8; [TI eFuse selection guidance](https://www.ti.com/document-viewer/lit/html/SSZTB96/GUID-D18B50A7-22CC-4A4E-8B48-5F2605B5C1B9) | Selection must coordinate normal and inrush current, ambient derating, voltage rating, interrupting rating, time-current behavior, `I2t`, downstream energy, eFuse tolerance, and safe operating area. | The older Littelfuse asset URL is intentionally replaced by its stable guide landing page. A current limit or resettable PTC is not automatically a certified protective device. Exact part and fault tests remain necessary. |
| Protection placement and proof | [ST AN5686 section 2.2, p. 8](https://www.st.com/resource/en/application_note/an5686-pcb-layout-tips-to-maximize-esd-protection-efficiency-stmicroelectronics.pdf); [TI TIDA-00530 section 5.1.4](https://www.ti.com/lit/ug/tiduaw5b/tiduaw5b.pdf) | Exposed-port protection effectiveness depends on connector-first TVS/ESD ordering, short line and discharge-return inductance, and a tight transient loop. Protection must be tested with the applicable transient and fault cases. | These are source/device examples, not universal component selections or test levels. The exact interface, discharge reference, surge waveform, and protected-device limits govern. |
| Creepage and clearance | [IEC 60664-1:2020 with amendment 1:2025](https://webstore.iec.ch/en/publication/59671), scope and clauses 4-5; [TI isolation-layout guidance, SDAA268](https://www.ti.com/lit/an/sdaa268/sdaa268.pdf); [ADI AN-7625](https://www.analog.com/en/resources/app-notes/an-7625.html), isolation-barrier section | IEC 60664-1 is a basic safety publication for equipment connected to low-voltage supply systems up to 1000 V AC or 1500 V DC and frequencies up to 30 kHz. Its base scope is use up to 2000 m, with guidance/correction above that altitude. Required spacing also depends on working/impulse voltage, overvoltage category, pollution degree, material group/CTI, insulation type, and environment. | The applicable product standard and responsible safety authority take precedence over this generic classification. Low nominal voltage alone does not select a spacing. Solder mask and silkscreen are not reliable solid insulation under ADI AN-7625. Licensed lookup and safety review are external gates. |
| Drill, annular ring, aspect ratio, and microvias | [JLCPCB capabilities](https://jlcpcb.com/capabilities/Capabilities), [Wuerth design guide](https://www.we-online.com/files/pdf1/basic_design-guide_110325_en_web.pdf), and [PCBWay advanced capabilities](https://www.pcbway.com/advanced-pcb-capabilities.html) | Minimum drill, finished hole, annular ring, aspect ratio, layer span, fill/cap, and spacing are fabrication-process constraints. | Values differ by service and may change. [IPC's microvia reliability warning](https://www.ipc.org/news-release/ipc-issues-electronics-industry-warning-printed-board-microvia-reliability-high) requires extra caution for stacked structures and high-performance products. |
| Land patterns and DFM | [IPC-7352 public table of contents](https://www.ipc.org/TOC/IPC-7352-TOC.pdf), [IPC-7093A public table of contents](https://www.ipc.org/TOC/IPC-7093A-toc.pdf), [NXP AN1902 QFN/SON assembly guidance](https://www.nxp.com/docs/en/application-note/AN1902.pdf), and [IPC-2231 public table of contents](https://www.ipc.org/TOC/IPC-2231-toc.pdf) | Land pattern review includes exact package dimensions, pads, mask, paste, courtyard, pin one, thermal pad, stencil, and assembly process. | Public IPC TOCs establish scope, not licensed numerical requirements. Solder-mask-defined exceptions require the exact fabricator process, such as [JLCPCB's SMD-pad instructions](https://jlcpcb.com/help/article/how-to-order-boards-with-solder-mask-defined-pads). |

## Routing and signal-integrity practice

Classify critical nets from their source-bound edge rate or interface profile,
not clock frequency alone. [IPC-2141A](https://www.ipc.org/TOC/IPC-2141A.pdf)
explicitly distinguishes edge rate from bit rate. A controlled route must bind
the target impedance and tolerance, stackup, dielectric, finished copper,
width/gap, reference layer, and permitted local discontinuities. The
[AMD stackup guide](https://docs.amd.com/r/en-US/ug863-versal-pcb-design/Adjusting-for-Different-Stack-Ups)
supports recalculation whenever those inputs change.

For a critical trace, machine analysis should identify the adjacent reference
throughout the complete route. Crossing a split or reference edge is blocking
when a source-bound rule forbids it. Deliberate pad voids, antipads, connector
launches, and reference transitions are reviewed exceptions, not permission to
ignore the return path. [TI's reference-plane discussion](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf)
explains the emissions and signal penalties from a displaced return.

EvlEDA applies the hard `evleda.pcb-route-quality.v1` `ROUTE_STYLE` gate
independently of electrical SI. Candidate routing uses the exact geometry and
tolerances defined above. `BACKTRACK` rejects gratuitous U-turns, route
reversals, and avoidable detours. An exception becomes an evaluation input only
when it is issued by a pre-authorized, source-bound policy rule or closed through
a separately authenticated human exception gate. It must bind exception ID,
policy/rule identity, board revision, net and primitive IDs, permitted geometry,
reason, alternatives, clearance/return/coupling evidence, owner, and scope or
expiry. Agent-authored prose or an open exception request cannot authorize a
bypass. This is a consistency and reviewability requirement; it does not claim
that every 90 degree corner is electrically unsafe.

The separate `BEND_SI` check becomes a blocking electrical rule only for a net
profile backed by applicable source evidence. The conflict between
[TI SCAA082A section 2.5, Figure 13, printed p. 14](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf)
and [TI TM4C guidance section 3.4.4, printed p. 16](https://www.ti.com/tw/lit/pdf/spma059)
is direct evidence that a universal electrical 90 degree failure is folklore.
Acid-trap concerns belong to the current selected-fabricator DFM review.

For 180 degree turns and length tuning, measure bend radius, spacing between
parallel legs, parallel exposure, and effective skew. Dense serpentines require
simulation because self-coupling changes effective delay, as described by
[AMD XAPP1392](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Trace-Length-Matching).

Differential-pair checks must cover pair membership, polarity, topology,
width/gap continuity, layer pairing, skew, transition symmetry, via count,
branches, and stubs. Numerical impedance and skew come from the exact interface
or component guide, illustrated by the differing [TI Ethernet](https://www.ti.com/lit/an/slva531a/slva531a.pdf)
and [TI USB](https://www.ti.com/lit/ab/slla653/slla653.pdf) requirements.

Flag branch stubs, unused via barrels, through-hole connector pin stubs, and
unreviewed probe loading. A machine may calculate electrical stub delay and
report the [Intel AN 224 v1.2, pp. 13-17 heuristic](https://www.intel.com/content/www/us/en/content-details/654465/an-224-high-speed-board-layout-guidelines.html),
but only a source-bound interface limit can turn it into a blocking result.
Do not delete required observability: use a source-bound low-loading structure
or record the SI/DFT tradeoff and external validation gate.

Crosstalk checking must include aggressor and victim classes, same- and
adjacent-layer parallel exposure, separation relative to dielectric height,
and via/connector coupling. TI's `2W` and approximate `2W-3W` statements in
[SCAA082A sections 1.4 and 2.5](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf),
the `3W` pair-separation statement in
[SLLA653 p. 3](https://www.ti.com/lit/ab/slla653/slla653.pdf), and the `5W`
inter-pair statement in
[SPRAAR7J section 3.1](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf) are
non-comparable interface-scoped examples. AMD's
[separation/height treatment](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Isolation-Recommendations)
is not a generic `3W` rule.

## Design for test and bring-up

Before placement and routing, emit a versioned DFT contract and test-point map.
It must cover accessible supply rails, current-sense nodes, faults, reset, boot,
programming/debug, required communications, and a safe nearby ground companion
for each measurement. Each point binds a net, expected limit, instrument class,
safe probing clearance, procedure ID, and bring-up-plan step.

For critical or controlled-impedance nets, the contract must state the allowed
probe structure, loading, branch/stub budget, and validation method. Some device
guides forbid ordinary test points on high-speed pairs, such as
[TI SPRAAR7J section 3.2, printed p. 9](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf),
so observability may require a dedicated launch, source-bound pad, removable
component, or validated fixture. `STUB_AND_VIA` and DFT are simultaneous
constraints; neither silently overrides the other.

The finished candidate must prove that the test-point map and bring-up plan bind
the same point, limit, and procedure identities. Safe-access and loading review
is a `human review` gate; actual instrument loading and measurements close only
the separate `physical test` gate.

## Power routing, thermal paths, and decoupling

`TRACE_SIZING_INPUTS` establishes trace sizing as an intersection of
independent constraints, not one ampacity lookup. Inputs must include minimum
finished width/thickness after etch tolerance, length and layer, hot copper
resistance, continuous and RMS waveform, peak magnitude/duration/duty,
prospective fault waveform and clearing `I2t`, allowed static resistive drop and
total rail transient excursion, allowed temperature rise/hotspot, ambient,
airflow, enclosure, neighboring heat, planes, terminal/pad bottlenecks, and via
transitions. Dynamic rail analysis additionally requires source/regulator
response or impedance, interconnect/plane/package parasitics, decoupling with
bias/ESR/ESL and mounted loop, and a bounded load-current waveform.
Controlled-impedance geometry, fabricator minima/tolerances, and electrical
clearance can impose additional and sometimes conflicting bounds.
[IPC-2152's public scope](https://www.ipc.org/TOC/IPC-2152.pdf) confirms the
conductor/environment dependencies without exposing its licensed charts.

`TRACE_RESISTIVE_DROP` may report only static or quasi-static `V = I R` drop
from a hot resistance network and the applicable current sample. It must not be
labeled total transient droop. `PDN_TRANSIENT_RESPONSE` separately evaluates
the full rail excursion with a bounded time- or frequency-domain model of the
source/regulator, interconnect RLC, planes, package, mounted decoupling, and load
waveform, following the static/dynamic distinction in
[TI SPRAC76H sections 4-5, printed pp. 8-12](https://www.ti.com/lit/an/sprac76h/sprac76h.pdf).
Missing dynamic inputs or model makes that rule `UNKNOWN`; absent execution
proof makes it `NOT_RUN`.

The machine also separately reports RMS `I^2R` heating, electrothermal margin,
and fault-energy/clearing coordination. A thermal pass requires a named model
identity, version, equations or solver, validated domain, complete inputs, and
uncertainty/margin. There is no undefined “approved model” pass: missing model
or input makes the rule `UNKNOWN`, and absent execution proof makes it
`NOT_RUN`.

`VIA_RESISTANCE` may calculate barrel resistance and voltage drop from minimum
finished hole, plating, and length, while checking entry/exit bottlenecks and
current-sharing geometry. The separate `VIA_ELECTROTHERMAL_FAULT` rule evaluates
RMS temperature/hotspot and fault withstand from a source-bound model, allowed
rise, ambient/boundaries, waveform/duty, fault clearing, plating/process
geometry, local copper spreading, neck-downs, and modeled current distribution.
Without every required identity and execution, its explicit status is
`UNKNOWN` or `NOT_RUN`; a `VIA_RESISTANCE` pass cannot hide it. Do not assume a
universal current per via, perfect sharing, or a linear `N`-via multiplier.
[TI SLVA959B](https://www.ti.com/lit/an/slva959b/slva959b.pdf)
provides placement guidance; [TI SNVA766 section 3.2.1](https://www.ti.com/lit/an/snva766/snva766.pdf)
is only an LP8863-Q1 EVM example and its legacy IPC-2221 estimate is not a
general ampacity rule.

`TRACE_CONSTRAINT_INTERSECTION` may pass only when the applicable
`TRACE_RESISTIVE_DROP`, `PDN_TRANSIENT_RESPONSE`, `TRACE_RMS_HEATING`,
`TRACE_FAULT_WITHSTAND`, `VIA_RESISTANCE`, and
`VIA_ELECTROTHERMAL_FAULT` results all pass together with impedance,
fabrication, land/pad bottleneck, and creepage/clearance constraints. Any
`FAIL`, `UNKNOWN`, or `NOT_RUN` remains visible and blocks the aggregate.

Identify each topology's high-di/dt loop from its switching states. Place its
high-frequency capacitor at the devices carrying the pulsating current, minimize
loop area and switch-node area, and keep sensitive sense/feedback routes away.
[ADI AN-136](https://www.analog.com/en/resources/app-notes/an-136.html) provides
topology-specific current-path examples; these cannot be replaced by a generic
`power` net label.

Decoupling checks should measure the entire mounted loop, not component-center
distance alone. [ADI MT-101](https://www.analog.com/media/en/training-seminars/tutorials/MT-101.pdf)
ties effectiveness to short low-inductance power and return connections and
capacitor frequency behavior. Values, package sizes, bias derating, and target
PDN impedance remain device/system decisions.

Do not treat datasheet `RthetaJA` as an intrinsic component constant.
[TI's thermal-metrics report](https://www.ti.com/lit/an/spra953d/spra953d.pdf)
describes its board/system dependence. Exposed pads and thermal-via arrays must
follow the exact package guidance; final junction margin requires a bounded
model and physical steady-state measurements.

## Protection, spacing, and manufacturing

Each power connector needs an exact orderable part, mating part, terminal,
wire/contact population, current waveform, ambient, and derating source.
[Molex's Micro-Fit Plus specification](https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/productspecificationpdf/206/206460/2064600000-PS-000.pdf)
shows why a family headline rating is insufficient. Missing exact connector or
mating-system evidence blocks the relevant current, thermal, and protection
claims.

The `PROTECTION_CHAIN` review must bind source connector, fuse or eFuse, reverse-polarity
stage, transient suppressor, downstream conductor/vias, return node, and load
energy. It must also bind their physical placement and copper. Route an exposed
port from connector to TVS/ESD device and then to the protected circuit, with a
short low-inductance surge loop to the intended discharge return; this ordering
and layout effect are shown in
[ST AN5686 section 2.2, p. 8](https://www.st.com/resource/en/application_note/an5686-pcb-layout-tips-to-maximize-esd-protection-efficiency-stmicroelectronics.pdf).
Keep the discharge path out of sensitive analog/digital returns unless the
source-bound protection topology requires otherwise.

The fuse's clearing `I2t`, time-current curve, voltage and interrupt rating must
coordinate with downstream connector, copper, vias, switches, and load
withstand. Use the stable
[Littelfuse Fuseology guide landing page](https://info.littelfuse.com/fuseology-design-guide-ug),
selection checklist and time-current/pulse sections pp. 6-8, rather than a
rotating asset URL. Reverse-polarity FET or controller analysis must include
transient and steady-state SOA, dissipation, surge, hot-plug and reverse-event
behavior from the exact device sources. Current limiting alone is not
certification.

Machine topology and geometry checks cannot close protection. Bench evidence
must exercise the applicable source-bound ESD, EFT/burst, surge, hot-plug,
reverse-polarity, overload, and short-circuit cases while recording clamp
voltage/current, clearing time/energy, temperatures, reset/latch behavior, and
post-test function. [TI TIDA-00530 section 5.1.4](https://www.ti.com/lit/ug/tiduaw5b/tiduaw5b.pdf)
illustrates connector-side placement and a tight transient return loop, but its
automotive battery conditions are not universal.

Creepage and clearance are classification results, not a single low-voltage
constant. Working and impulse voltage, overvoltage category, pollution degree,
CTI/material group, altitude, insulation type, coating, and environment must be
selected under an applicable standard such as
[IEC 60664-1:2020+A1:2025](https://webstore.iec.ch/en/publication/59671). That
basic safety publication covers equipment connected to low-voltage supply
systems up to 1000 V AC or 1500 V DC, at frequencies up to 30 kHz, and uses
2000 m as its base altitude while providing guidance above it. The applicable
product standard and responsible safety authority take precedence. The licensed
lookup and interpretation are a human gate; [ADI AN-7625](https://www.analog.com/en/resources/app-notes/an-7625.html)
states that solder mask and silkscreen are not reliable insulation.

Bind the exact fabricator, service level, stackup identifier, laminate,
dielectric thickness and Dk, finished copper, tolerances, impedance construction,
drill/plating, surface finish, mask, and panel constraints. Published
[JLCPCB capabilities](https://jlcpcb.com/capabilities/Capabilities) and the
[Wuerth design guide](https://www.we-online.com/files/pdf1/basic_design-guide_110325_en_web.pdf)
are capability envelopes only. Written engineering confirmation and accepted
CAM are still required.

Microvia checks must bind layer span, laser drill, pad, annular ring, dielectric
depth, aspect ratio, fill/cap, stacking/staggering, copper balance, and selected
fabricator. [IPC's microvia warning](https://www.ipc.org/news-release/ipc-issues-electronics-industry-warning-printed-board-microvia-reliability-high)
is a reason to require reliability review and coupons for stacked or
high-performance constructions, not a numerical design recipe.

Every footprint must bind the exact OPN/package drawing and revision. Validate
pad, mask, paste, courtyard, pin one, exposed pad, and stencil intent against
package guidance such as [NXP AN1902](https://www.nxp.com/docs/en/application-note/AN1902.pdf).
The public [IPC-7352](https://www.ipc.org/TOC/IPC-7352-TOC.pdf),
[IPC-7093A](https://www.ipc.org/TOC/IPC-7093A-toc.pdf), and
[IPC-2231](https://www.ipc.org/TOC/IPC-2231-toc.pdf) pages establish scope but
do not expose licensed numerical rules. Deviations require fabricator and
assembler review.

## Explicit anti-folklore rules

- Never infer high-speed criticality from clock frequency alone; use edge rate
  or a source-bound interface profile, consistent with
  [IPC-2141A's scope](https://www.ipc.org/TOC/IPC-2141A.pdf).
- Never make every 90 degree corner a hard SI failure. Enforce EvlEDA's hard
  45-degree-or-arc `ROUTE_STYLE` product-quality default independently, and
  apply hard electrical `BEND_SI` limits only by profile; the differing
  [TI MCU guidance](https://www.ti.com/tw/lit/pdf/spma059) is an explicit
  counterexample to a universal rule.
- Never treat 45 degree routing as a repair for a broken return path or large
  current loop; [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf)
  treats those as separate mechanisms.
- Never let agent-authored route prose waive `ROUTE_STYLE` or `BACKTRACK`; only
  a pre-authorized, source-bound policy rule or a separately authenticated
  human exception gate can supply a scoped exception input.
- Never reject a 180 degree turn merely because it reverses direction; evaluate
  radius, skew, adjacent-leg coupling, and loop geometry as required by
  [AMD XAPP1392](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Trace-Length-Matching).
- Never hardcode a universal 3W/5W spacing, 90/100 ohm impedance, stitching-via
  count/distance, trace ampacity, via ampacity, or thermal-via recipe; compare
  the incompatible application-specific values in
  [TI SPRAAR7J](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf) and
  [AMD UG583](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Isolation-Recommendations).
- Never use a `V = I R` resistive-drop pass as a total transient-rail pass;
  [TI SPRAC76H](https://www.ti.com/lit/an/sprac76h/sprac76h.pdf) separates static
  IR analysis from dynamic PDN analysis.
- Never split analog and digital ground by default. Prefer functional
  partitioning while retaining a continuous reference plane unless the exact
  system evidence says otherwise, following
  [TI SLYT512](https://www.ti.com/lit/pdf/SLYT512).
- Never treat a capability page as acceptance of an exact stackup, HDI build,
  land pattern, impedance, or CAM package; the selected service still controls
  the exact [fabrication capability](https://jlcpcb.com/capabilities/Capabilities).
- Never use solder mask as assumed safety insulation; spacing begins with the
  [IEC 60664-1 classification](https://webstore.iec.ch/en/publication/59671).
- Never equate a fuse label, PTC current, eFuse limit, connector family rating,
  clean DRC, calculation, or simulation with physical protection performance.
  The [Littelfuse Fuseology guide](https://info.littelfuse.com/fuseology-design-guide-ug)
  shows the additional fault and application parameters.

## Required external gates

Before fabrication or qualification, an authenticated selected-fabricator actor
must confirm the
exact stackup, finished copper, geometry tolerances, impedance construction and
coupon, drills/plating, via and microvia structure, mask/paste constraints,
surface finish, panelization, and CAM interpretation. The assembler must confirm
stencil, paste, thermal-pad, polarity, and special-process requirements.

An authenticated human-review gate must confirm source applicability, current
and fault waveforms, hot-loop identification, connector and protection
coordination, insulation classification, thermal model, exceptions, and
residual risk. A separate physical-test gate must cover rail behavior, signal
quality where material, fault response, connector and conductor temperature,
component/junction proxy temperature, and inspection of the built process.
Neither gate closes the other, even when both have the same human owner.

## Source limitations and implementation boundary

Full licensed IPC and IEC tables were not available in the public source set.
This report cites their public scope/currentness and never invents or reproduces
licensed lookup values. A licensed review is required whenever those standards
govern a numeric decision.

Any project with conflicting or incompletely derived trace widths, no
source-bound electrothermal/fault model, missing exact connector or protection
part evidence, or only a published HDI capability envelope must retain those
gaps as visible blockers. Generic engineering instructions do not name or
silently resolve project-specific parts.

Source-catalog metadata records URLs and revisions but is not itself an
immutable capture of source bytes or proof that the cited claim was extracted
correctly. Every hard numeric rule requires captured source bytes and identity,
capture-tool identity and time, a precise page/section/table/figure locator,
excerpt hash, and an applicability statement. Without them, its status is
`UNKNOWN` and it cannot become a blocking numeric rule except by a separately
authenticated conservative product-quality policy.

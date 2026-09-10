# PCB design guide index

> **This document is an index, not a substitute summary.** The 17 research dossiers are the canonical evidence records. Follow the dossier links for equations, units, exceptions, worked examples, evidence grading, and the complete source ledger. The derivative [agent rule library](./agent-rule-library.md) and [JSON catalog](./rule-catalog.json) support retrieval; neither replaces the dossiers or authorizes fabrication/release.

## How to navigate the collection

1. Start with **15** for lifecycle gates and **13** for the layout state machine.
2. Use **01** and **14** before trusting schematic or firmware pin intent.
3. Select physics-specific dossiers (**02**, **04–10**, **17**) only when their required inputs are available.
4. Use **16** before routing, then **11–12** against the selected supplier/process.
5. Treat every PASS as scoped to its named check. Missing consequential inputs remain UNKNOWN/BLOCKED, and humans/suppliers retain approval authority.

## Exact article and dossier map

### 01. High-quality schematic diagrams

- **Exact article/topic:** [Creating High-Quality Schematic Diagram: A Professional and Simplified Workflow](https://jlcpcb.com/blog/creating-high-quality-schematic-diagram)
- **Canonical dossier:** [research/01-high-quality-schematic.md](research/01-high-quality-schematic.md)
- **Scope:** Schematic capture as an electrically complete, reviewable design contract: controlled symbols and libraries, hierarchy, net naming, power intent, ERC, BOM/PCB synchronization, and peer review.
- **Major decision inputs:** Exact parts, packages, and current datasheets; Schematic, netlist, BOM, and footprint associations; EDA tool/version and label/power/ERC semantics; Interface, power, safety, and layout-driving requirements.
- **Cross-topic dependencies:** `gpio-pinouts`, `layout-process`, `component-placement`, `pcb-design-lifecycle`.
- **Catalog coverage:** 72 operational rules; SHA-256 `cf1d8f19a4415a581374634839096c28c695b12d72a39359c720c52d640a093a`.

### 02. Trace width versus current capacity

- **Exact article/topic:** [Track Width v/s Current Capacity: PCB Layout Tips for Power Routing](https://jlcpcb.com/blog/track-width-vs-current-capacity-pcb-layout-tips)
- **Canonical dossier:** [research/02-trace-width-current.md](research/02-trace-width-current.md)
- **Scope:** Power-path sizing from finished copper geometry, RMS/peak/fault current, voltage drop, temperature rise, transient response, vias, interconnects, tolerances, and validation.
- **Major decision inputs:** Complete source and return path; DC/RMS/peak/pulse/inrush/fault waveform; Voltage-drop, self-rise, and absolute-temperature limits; Minimum finished copper/via geometry and environment; Protection clearing and I-squared-t data.
- **Cross-topic dependencies:** `power-integrity`, `dfm`, `assembly`, `layout-process`.
- **Catalog coverage:** 111 operational rules; SHA-256 `5404c95dfdd17a075ce7736a245b8ca7254da5a4525c9f98fc86fc47bffbe54e`.

### 03. Ultimate PCB layout design guide

- **Exact article/topic:** [The Ultimate Guide to PCB Layout Design](https://jlcpcb.com/blog/guide-to-pcb-layout-design)
- **Canonical dossier:** [research/03-ultimate-pcb-layout.md](research/03-ultimate-pcb-layout.md)
- **Scope:** End-to-end layout requirements, stackup, floorplanning, placement, routing priority, return paths, DFM/DFA/DFT, verification gates, and AI escalation.
- **Major decision inputs:** Verified schematic, BOM, footprints, and datasheets; Board outline, enclosure, and mechanical constraints; Selected fabricator/assembler and stackup; Current, voltage, SI, PI, thermal, safety, and test constraints.
- **Cross-topic dependencies:** `schematic-quality`, `stackup-impedance`, `signal-integrity`, `power-integrity`, `dfm`, `assembly`, `component-placement`.
- **Catalog coverage:** 44 operational rules; SHA-256 `7b1a87d795a6a726ffe46333c112e27f774f39cfca7e9b073092722ed2d6a86a`.

### 04. Layer stackup and controlled impedance

- **Exact article/topic:** [Comprehensive Layer Stack-Up Design for High-Speed Controlled Impedance PCBs](https://jlcpcb.com/blog/layer-stackup-design-high-speed-pcbs)
- **Canonical dossier:** [research/04-layer-stackup-controlled-impedance.md](research/04-layer-stackup-controlled-impedance.md)
- **Scope:** Controlled-impedance stackup contracts, transmission-line structures, Dk/Df and copper metadata, field solving, tolerance analysis, return continuity, coupons, TDR, and fabricator authority.
- **Major decision inputs:** Interface impedance definition, tolerance, edge/band, and channel limits; Exact stack ID, materials, pressed dielectrics, copper profile, and mask; Line structure, layer, references, width/gap, neighboring copper, and transitions; Fabricator process center/tolerances and coupon acceptance method.
- **Cross-topic dependencies:** `signal-integrity`, `impedance-matching`, `differential-pairs`, `hf-emc-si`, `bga`.
- **Catalog coverage:** 177 operational rules; SHA-256 `3694f904d80a8442379001bf5be93b7e0c10619063ae6581524b84d4f67cf312`.

### 05. Signal integrity

- **Exact article/topic:** [Signal Integrity (SI) in PCB Layout](https://jlcpcb.com/blog/signal-integrity-si-in-pcb-layout)
- **Canonical dossier:** [research/05-signal-integrity.md](research/05-signal-integrity.md)
- **Scope:** Edge-rate and flight-time screening, reflections, crosstalk, return paths, discontinuities, termination, loss, skew/jitter/eyes, model QA, simulation, measurement, and sign-off boundaries.
- **Major decision inputs:** Exact interface, topology, directions, and receiver acceptance limits; Fastest/slowest edge and driver/load/package models; Released stackup, impedance, via, connector, and material data; Aggressors, routed geometry, simulation corners, and measurement reference planes.
- **Cross-topic dependencies:** `stackup-impedance`, `impedance-matching`, `differential-pairs`, `hf-emc-si`, `bga`.
- **Catalog coverage:** 104 operational rules; SHA-256 `02f357a2d508a55f2c7bffad5da6ebb5e8a16eb9c77251c94ebd2d672071dfa1`.

### 06. Impedance matching

- **Exact article/topic:** [Understanding Impedance Matching for High-Speed PCB Designs](https://jlcpcb.com/blog/understanding-impedance-matching-for-high-speed-pcb-designs)
- **Canonical dossier:** [research/06-impedance-matching.md](research/06-impedance-matching.md)
- **Scope:** Digital termination, RF matching, impedance vocabulary, reflection metrics, discontinuity and reference design, model fidelity, corner simulation, fabrication control, and measurement.
- **Major decision inputs:** Exact interface/objective, topology, direction, and idle states; Target impedance/mode/tolerance and edge or RF band; Driver/receiver/channel models and electrical acceptance limits; Finished stackup, route geometry, return path, and verification plan.
- **Cross-topic dependencies:** `stackup-impedance`, `signal-integrity`, `differential-pairs`, `hf-emc-si`.
- **Catalog coverage:** 146 operational rules; SHA-256 `6057afc381db0a5f95d3f995a08232d89b341ed1ea35a9012026a002b191a805`.

### 07. Differential pairs

- **Exact article/topic:** [Differential Pairs on PCBs: Best Practices for Routing, Impedance Control, and Signal Integrity](https://jlcpcb.com/blog/differential-pairs-pcb-practices)
- **Canonical dossier:** [research/07-differential-pairs.md](research/07-differential-pairs.md)
- **Scope:** Differential/common-mode behavior, coupled geometry, return paths, delay/skew, transitions, breakouts, components, glass weave, channel modeling, measurement, automation severities, and waivers.
- **Major decision inputs:** Protocol/device revision, lane role, polarity, topology, and BER/mask target; Differential/leg/common impedance and delay/skew/loss limits; Package, connector, cable, ESD/choke, and termination models; Released stackup, via construction, geometry tolerances, and evidence owners.
- **Cross-topic dependencies:** `stackup-impedance`, `signal-integrity`, `impedance-matching`, `bga`, `hf-emc-si`.
- **Catalog coverage:** 82 operational rules; SHA-256 `0df7fa768224fc64806e395f3692446470d595426e1b0227dc39b8d0b4b28d97`.

### 08. Power integrity

- **Exact article/topic:** [Power Integrity (PI) in PCB Layout](https://jlcpcb.com/blog/power-integrity-pi-in-pcb-layout)
- **Canonical dossier:** [research/08-power-integrity.md](research/08-power-integrity.md)
- **Scope:** Rail voltage budgeting, target impedance, load transients, VRM stability, mounted capacitor behavior, anti-resonance, planes, DC/AC analysis, package/die boundaries, probing, and correlation.
- **Major decision inputs:** Rail limits, observation point, bandwidth, and DC/AC budgets; Load currents, delta-I, edge/pulse/spectrum, and concurrent modes; Exact VRM and capacitor models under bias/temperature; Finished PCB/package/die models, ports, fixtures, environment, and acceptance cases.
- **Cross-topic dependencies:** `trace-current`, `stackup-impedance`, `component-placement`, `bga`, `hf-emc-si`.
- **Catalog coverage:** 115 operational rules; SHA-256 `3d0f50c927873451bf84fea014d772f49742c9aee76c21902cae8c2284a56e34`.

### 09. EMI versus EMC

- **Exact article/topic:** [EMI vs EMC: A Full Guide to Detailed Comparison](https://jlcpcb.com/blog/emivsemc)
- **Canonical dossier:** [research/09-emi-vs-emc.md](research/09-emi-vs-emc.md)
- **Scope:** Terminology, source-path-victim analysis, differential/common-mode coupling, PCB/enclosure/cable controls, pre-compliance, debugging, jurisdiction-specific standards, documentation, and prohibited compliance claims.
- **Major decision inputs:** Destination markets, product classification, standards, editions, and environment; Worst-case functional modes, sources, victims, and recovery criteria; Stackup, PDN, interfaces, cables, enclosure, safety, and manufacturing constraints; Raw test setup/data, limits, detector/bandwidth/distance, and configuration.
- **Cross-topic dependencies:** `hf-emc-si`, `signal-integrity`, `power-integrity`, `component-placement`, `pcb-design-lifecycle`.
- **Catalog coverage:** 78 operational rules; SHA-256 `8752edb560b459c7e1ea529cc6cd376e5727acf384f9297bf481c51357ce3323`.

### 10. High-frequency EMI, EMC, and SI

- **Exact article/topic:** [How to Tackle EMI/EMC and Signal Integrity Issues in HF PCB Design](https://jlcpcb.com/blog/emi-emc-and-signal-integrity-issues-in-hf-pcb)
- **Canonical dossier:** [research/10-hf-emi-emc-si.md](research/10-hf-emi-emc-si.md)
- **Scope:** Field/current-path analysis for fast digital and switch-mode circuits: edge spectra, return loops, transitions, common-mode conversion, partitioning, stackup, filtering, shielding, simulation, and test.
- **Major decision inputs:** Fastest edge, topology, source/load, and interface constraints; Complete signal/return loops, stackup, transitions, and fabrication tolerances; Converter modes/loads, enclosure/cables/shields, and isolation/PE architecture; Destination standards and pre-compliance/final-test plan.
- **Cross-topic dependencies:** `emi-emc`, `signal-integrity`, `power-integrity`, `stackup-impedance`, `impedance-matching`.
- **Catalog coverage:** 142 operational rules; SHA-256 `3e467f12118545c8da582f1091f9d82b69d5644db37f4e48dfe6439bb3aa9394`.

### 11. Design for manufacturability

- **Exact article/topic:** [DFM (Design for Manufacturability) Guidelines](https://jlcpcb.com/blog/dfm-design-for-manufacturability-guidelines)
- **Canonical dossier:** [research/11-dfm-guidelines.md](research/11-dfm-guidelines.md)
- **Scope:** Named fabrication profiles, copper/drill/mask/edge/stackup/special-process constraints, panel and data package, CAD DRC, export inspection, supplier review, change discipline, and AI authority limits.
- **Major decision inputs:** Board revision/archive hash and intended fabricator/service; Quoted stackup, thickness, copper, finish, holes, panel, and special processes; Assembly scope, controlled-impedance scope, DRC profile, and supplier DFM; Source URLs/dates, process conditions, owners, and dispositions.
- **Cross-topic dependencies:** `assembly`, `layout-process`, `stackup-impedance`, `trace-current`, `bga`.
- **Catalog coverage:** 77 operational rules; SHA-256 `da7b6c74dc311120f54cd13ec33bc44c5923d61badeecc257cf46df0158929af`.

### 12. PCB assembly guidelines

- **Exact article/topic:** [PCB Assembly Guidelines](https://jlcpcb.com/blog/pcb-assembly-guidelines)
- **Canonical dossier:** [research/12-pcb-assembly-guidelines.md](research/12-pcb-assembly-guidelines.md)
- **Scope:** Exact-package land patterns, courtyards, polarity, mask/paste/stencil, thermal pads/via-in-pad, placement/access, assembly data, process controls, inspection, rework, MSL, ESD, and first article.
- **Major decision inputs:** Exact fitted MPNs, package drawings, footprint provenance, and population states; Assembler process/capability, spacing/access, panel, stencil, and inspection rules; Reconciled BOM/CPL/fab/assembly/paste data and rotations; MSL, ESD, cleaning, reflow/wave/manual/rework/test requirements.
- **Cross-topic dependencies:** `dfm`, `component-placement`, `bga`, `schematic-quality`, `pcb-design-lifecycle`.
- **Catalog coverage:** 62 operational rules; SHA-256 `a2d0bf4f65db6fd9b2695266d86c53136955d39cb921f45f40922079455d5420`.

### 13. PCB layout process

- **Exact article/topic:** [Mastering PCB Design: A Step-by-Step PCB Layout Process Guide](https://jlcpcb.com/blog/pcb-layout-process-guide-2026-mastering-pcb-design)
- **Canonical dossier:** [research/13-layout-process.md](research/13-layout-process.md)
- **Scope:** A controlled state machine from verified inputs through constraints, stackup, floorplan, placement, critical routing, zones, verification, release, change control, and reuse.
- **Major decision inputs:** Requirements, board class, safety scope, exact parts, and tool revisions; Schematic/netlist/library identity and current device guidance; Fabricator/assembler, stackup, mechanical envelope, and constraint sources; Verification matrix, waivers, change baseline, and release authority.
- **Cross-topic dependencies:** `schematic-quality`, `layout-guide`, `component-placement`, `dfm`, `assembly`, `pcb-design-lifecycle`.
- **Catalog coverage:** 102 operational rules; SHA-256 `42c285dfce78167eb797937c78e5a0bc620fb18c632d3a962910dc6b16feb189`.

### 14. GPIO pinout basics

- **Exact article/topic:** [GPIO Pinout Basics: A Guide for Beginners](https://jlcpcb.com/blog/critical-role-of-gpio-pinouts-selection-in-embedded-systems)
- **Canonical dossier:** [research/14-gpio-pinout-basics.md](research/14-gpio-pinout-basics.md)
- **Scope:** Package/header/firmware mapping, mux and reset states, logic thresholds, drive/current, pulls, voltage compatibility, boot/debug/power domains, protection, connector boundaries, and hardware/firmware validation.
- **Major decision inputs:** Exact MCU/package/silicon revision, datasheet, manual, and errata; Per-pad package/net/firmware/mux/domain/reset/electrical matrix; Connected-device data, ICD, power-state table, and protection path; Firmware build/configuration and electrical/bring-up/boundary test plan.
- **Cross-topic dependencies:** `schematic-quality`, `signal-integrity`, `emi-emc`, `component-placement`, `pcb-design-lifecycle`.
- **Catalog coverage:** 59 operational rules; SHA-256 `040520400f407cec8b21d600dc21772cdf3b737384316bfc2e05ce02ed09ec06`.

### 15. How to design a PCB

- **Exact article/topic:** [How to Design a PCB? PCB Layout Engineer Must Know!](https://jlcpcb.com/blog/how-to-design-a-pcb-pcb-layout-engineer-must-know)
- **Canonical dossier:** [research/15-how-to-design-pcb.md](research/15-how-to-design-pcb.md)
- **Scope:** Requirements-to-release lifecycle: architecture, schematic/library control, constraints, placement/routing, mechanical/thermal/assembly/test readiness, distinct verification gates, output review, prototype iteration, and qualification boundaries.
- **Major decision inputs:** Requirements and acceptance matrix with owners; Exact architecture, parts, interfaces, sources, and constraints; Ordered fabrication/assembly process and complete release package; Independent reviews, waivers, as-built record, and qualification evidence.
- **Cross-topic dependencies:** `schematic-quality`, `layout-guide`, `layout-process`, `dfm`, `assembly`, `emi-emc`.
- **Catalog coverage:** 94 operational rules; SHA-256 `5880001df77cd95652f1eeee3bb3442d6043cb8b32047f2f354da0303d9ba6a4`.

### 16. Component placement

- **Exact article/topic:** [PCB Component Placement: A Practical Guide to Clean, Routable Layout](https://jlcpcb.com/blog/pcb-component-placement-a-practical-guide-to-clean-routable-layout)
- **Canonical dossier:** [research/16-component-placement.md](research/16-component-placement.md)
- **Scope:** Mechanical anchors, functional zoning, interfaces, power hot loops, decoupling, sensitive paths, thermal/return planning, keepouts, DFM/test access, ratsnest metrics, critical-route proofs, and 3D review.
- **Major decision inputs:** Board/enclosure/height/keepout and connector constraints; Exact parts, package/layout/thermal guidance, and assembly process; Net/component noise, energy, sensitivity, impedance, safety, and test classifications; Stackup/reference intent, critical routes, return/current/thermal paths, and 3D access.
- **Cross-topic dependencies:** `layout-process`, `power-integrity`, `signal-integrity`, `assembly`, `bga`.
- **Catalog coverage:** 96 operational rules; SHA-256 `0daad653e8c48eac2ffc3a9f08b96520212145db7bdd5efc88516b73b17475a4`.

### 17. BGA layout and escape routing

- **Exact article/topic:** [BGA PCB Design Complete Guide: Layout and Routing Guidelines](https://jlcpcb.com/blog/bga-pcb-design-complete-guide-layout-and-routing-guidelines)
- **Canonical dossier:** [research/17-bga-layout-routing.md](research/17-bga-layout-routing.md)
- **Scope:** Exact package/ball-map control, land/mask/paste, escape feasibility equations, dogbone/VIPPO/HDI/backdrill structures, layer/channel planning, SI/PI/timing, assembly/inspection/rework/DFT, and hard-stop release logic.
- **Major decision inputs:** Exact MPN/package revision, drawing, ball map, view convention, and every ball disposition; Numeric electrical groups, impedance/skew/loss/current/PDN/test constraints; Quoted stackup and job-specific trace/via/mask/HDI/VIPPO/backdrill capability; Assembler approval for land/paste/reflow/warpage/X-ray/rework/test.
- **Cross-topic dependencies:** `stackup-impedance`, `differential-pairs`, `power-integrity`, `dfm`, `assembly`, `component-placement`.
- **Catalog coverage:** 212 operational rules; SHA-256 `3a507c13244c23a5fd6e7e24610e34ebd336d47b157e15ffcd53c78ded58d9c9`.

## Cross-topic dependency routes

| Design question | Start here | Then cross-check |
|---|---|---|
| Can the schematic/netlist be trusted? | 01 schematic quality; 14 GPIO | 15 lifecycle; 13 layout process |
| Can a power path carry its waveform? | 02 trace/current | 08 PI; 16 placement; 11 DFM; 12 assembly |
| Is a fast channel routable and verifiable? | 05 SI or 06 matching | 04 stackup; 07 differential; 10 HF; 17 BGA |
| Is the board likely to meet emissions/immunity obligations? | 09 EMI/EMC | 10 HF; 05 SI; 08 PI; enclosure/cable/system evidence |
| Is placement ready for routing? | 16 placement | 13 process; device-specific 02/05/08/17 rules |
| Can the selected supplier build and assemble it? | 11 DFM; 12 assembly | 04 stackup; 17 BGA; current written quote/DFM |
| Can the design be released? | 15 lifecycle; 13 process | All selected risk dossiers, independent artifact inspection, accountable sign-off |

## Source inconsistencies intentionally preserved

These are not silently resolved in the catalog:

- **03:** The originally supplied `/the-ultimate-guide-to-pcb-layout-design` URL returned 404; the dossier uses JLCPCB's indexed `guide-to-pcb-layout-design` page and preserves that substitution.
- **04:** The article's ±10%/optional ±5% impedance-test language conflicts with JLCPCB's current ±20% standard-test help text; no tighter guarantee is inferred without job confirmation.
- **05:** The supplied SI article returned 404; a related accessible JLCPCB summary is used only for bounded introductory claims.
- **06:** The supplied impedance-matching URL returned 404; the current same-topic successor is not assumed byte-identical.
- **07:** The supplied differential-pairs URL returned 404; a current closely matching JLCPCB article is treated as the seed.
- **08:** The supplied PI article returned 404; its full text and metadata remain unverified, and only a later indexed summary is used.
- **10:** The requested HF article URL returned 404 while a shorter canonical URL was available; the source also has conflicting publication-date metadata and internally contradictory guidance.
- **11:** The requested DFM article returned 404. JLCPCB's live capability page is used, but that page itself conflicts on blind/buried-via support.
- **12:** The supplied assembly article returned 404; current JLCPCB help pages and primary package/process sources replace it for technical evidence.
- **17:** The BGA article recommends microvia/HDI planning at 0.4 mm while JLCPCB's current capability page says blind/buried vias are unsupported; STOP_FAB_PROCESS_CONFLICT remains mandatory until written job-specific approval.
- **17:** The BGA article overstates IPC-7095 as an acceptance source; the dossier preserves IPC-7095 as implementation guidance and points assembly acceptance to J-STD-001/IPC-A-610.
- **10:** The 20H rule has conflicting simulation and measurement evidence; the dossier intentionally retains it as geometry-dependent rather than averaging the sources.

## Integrity snapshot

- Canonical dossier count: **17**
- Extracted operational rule count: **1773**
- Per-topic counts: 01=72, 02=111, 03=44, 04=177, 05=104, 06=146, 07=82, 08=115, 09=78, 10=142, 11=77, 12=62, 13=102, 14=59, 15=94, 16=96, 17=212
- Catalog-generation policy: only operational rule-bearing structures and explicit modal conditions are extracted; metadata and research/source-ledger narrative are excluded. Exact dossier path, heading anchor, line span, joined source text, article URL, and dossier hash are retained.

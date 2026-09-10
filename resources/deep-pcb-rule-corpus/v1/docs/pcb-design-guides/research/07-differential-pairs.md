# Evidence dossier: Differential pairs

**Article under review:** the supplied JLCPCB URL, `https://jlcpcb.com/blog/differential-pairs`, returned HTTP 404 when checked on 2026-09-06. JLCPCB's current, closely matching article is [*Differential Pairs on PCBs: Best Practices for Routing, Impedance Control, and Signal Integrity*](https://jlcpcb.com/blog/differential-pairs-pcb-practices), published 2026-02-09 and updated 2026-02-26. This dossier treats that current page as the intended seed article. [C01]

**Audience and decision.** This is an implementation and review guide for PCB designers and AI-assisted PCB workflows. It explains what can be checked geometrically, what requires a stackup field solve, what requires a full-channel model, and what must come from the exact interface specification and silicon vendor. It is not a substitute for a licensed protocol specification, the transmitter/receiver datasheets, the package model, the connector model, or the fabricator's released stackup.

**Evidence labels.** **[Article]** is a claim made by the reviewed JLCPCB article. **[Primary/vendor]** is first-party instrument, EDA, semiconductor, connector, or fabricator guidance. **[Derived]** is a calculation or engineering inference stated with its assumptions. **[Project input]** means no safe value can be supplied until the actual design provides it.

## Executive answer

A differential pair is a coupled, multi-conductor transmission structure, not simply two equal-length traces. The intended signal is the voltage difference between the conductors; any average voltage is common mode. A successful PCB implementation must preserve:

1. the required differential (odd-mode) impedance and acceptable common-mode behavior;
2. low imbalance in impedance, insertion loss, and delay between P and N;
3. a continuous high-frequency return path and symmetric transitions;
4. the protocol's actual intra-pair skew, channel-loss, return-loss, crosstalk, and termination budgets; and
5. manufacturable geometry based on the fabricator's real dielectric construction.

The JLCPCB article is useful as an introductory checklist, but its fixed values are not portable design rules. Its generic 90–100 Ω range, 5–15 ps matching target, `<0.1 mm for >5 Gbps`, `5H` spacing tied to `-40 dB`, four-to-six ground vias, 5–10 mm stitching pitch, and preference for inner layers all need protocol-, stackup-, and topology-specific qualification. Current TI guidance explicitly says its own protocol table contains guidelines that are “not always exact values,” and different first-party documents recommend different layer choices and spacing rules. [C02]

## 1. Signal and impedance model

### Differential and common voltages

For conductor voltages `Vp` and `Vn` measured to the local reference:

```text
Vdiff = Vp - Vn
Vcm   = (Vp + Vn) / 2
```

An ideal differential excitation has equal amplitudes and opposite polarity, so `Vcm = 0`. An ideal common-mode excitation drives both conductors equally, so `Vdiff = 0`. Real transmitters, packages, vias, connectors, and routes are never perfectly balanced; the receiver's common-mode range and common-mode rejection still matter. Differential signaling rejects only the portion of interference that reaches both conductors sufficiently equally and remains inside the receiver's common-mode limits. It does not make reference planes, shielding, or balance optional. [C03]

### The five useful impedance views

For a symmetric pair, keep the definitions and measurement convention explicit:

| Quantity | Meaning | Symmetric-pair relationship |
|---|---|---|
| `Z0,se` | Characteristic impedance of one conductor in its actual environment under the stated excitation/termination convention | Not generally equal to `Zodd` once coupling is material |
| `Zodd` | Impedance seen by one conductor when P and N are driven with equal, opposite signals | `Zdiff = 2 × Zodd` |
| `Zeven` | Impedance seen by one conductor when P and N are driven equally in phase | `Zcm,port = Zeven / 2` when the two conductors are treated as one common-mode port |
| `Zdiff` | Voltage between P and N divided by differential current, using the chosen current convention | Twice per-conductor odd-mode impedance |
| `Zcm,port` | Common voltage divided by the total current in both conductors | Half per-conductor even-mode impedance |

The factor-of-two and factor-of-one-half statements assume a symmetric pair and the conventional balanced-port definitions above. Some tools report per-conductor modal impedance while others report balanced-port impedance; an AI or reviewer must record the tool's port definition before comparing numbers. Keysight defines odd mode as the impedance of one line under differential excitation and even mode as the impedance of one line under common excitation; Ansys demonstrates the corresponding `Zdiff = 2 Zodd` and `Zcm = Zeven/2` relationships. [C04]

### Coupling is a trade, not a universal objective

Bringing the pair closer increases mutual capacitance and inductance. At fixed trace width and plane geometry, stronger coupling normally lowers `Zodd` and therefore `Zdiff`, while raising `Zeven`; the field solver must quantify the result. Tight coupling can improve equal exposure to some external fields and reduce differential loop area, but it also makes impedance more sensitive to spacing error, constrains escape/tuning, and can increase odd/even velocity differences in inhomogeneous microstrip. TI's Jacinto guidance says closely coupled PCB pairs are often harder to manufacture accurately and recommends loosely coupled, wider traces for many boards; this is a platform design recommendation, not a universal command. [C05]

Do not optimize only `Zdiff`. A pair can have the requested differential impedance while the two legs have unequal single-ended impedance or loss, producing mode conversion. Preserve symmetry and, for demanding channels, inspect odd/even impedance, propagation constants, and mixed-mode S-parameters. [C06]

## 2. Geometry and controlled impedance

### Required stackup inputs

No defensible width/gap can be generated from “FR-4, 100 Ω.” A 2-D field solver or the fabricator's solver needs, at minimum:

- target `Zdiff` and tolerance, and any required single-ended/common-mode target;
- exact routing layer and whether it is surface microstrip, embedded microstrip, symmetric/asymmetric stripline, or broadside coupled;
- finished copper thickness including plating, conductor width and trapezoidal etch shape;
- edge-to-edge P/N gap and clearance to adjacent copper;
- dielectric thickness to every relevant reference plane;
- frequency-dependent dielectric constant and loss tangent for the actual resin/glass construction, not merely a laminate family name;
- solder-mask thickness and dielectric properties for outer layers;
- copper roughness model for loss-sensitive work; and
- fabricator minimum features, etch/registration tolerances, impedance-control process, and coupon construction.

The JLCPCB article correctly lists width, spacing, height, and dielectric constant as major inputs, but its sample 4–6 mil widths and 5–8 mil gaps are examples, not reusable geometry. The same nominal impedance can require materially different dimensions on another stackup. [C07]

### Geometry controls and direction of effect

For otherwise fixed geometry, wider copper usually lowers impedance; a smaller distance to the reference plane lowers impedance; and a smaller P/N gap increases coupling and usually lowers differential impedance. Copper thickness, mask, neighboring copper, and a second reference plane perturb both impedance and loss. At pads, neck-downs, anti-pads, and vias, the structure is three-dimensional and simple trace formulas stop being adequate. [C08]

Use the fabricator's proposed production stackup before final routing. Ask whether the quoted tolerance is a design target, a coupon acceptance tolerance, or a guarantee on every feature of the actual routed channel. A coupon validates its own construction and process correlation; it does not by itself prove the impedance of a connector launch, BGA breakout, via field, or local copper-pour interaction. [C09]

### Maintain the environment, not merely the width

Hold pair gap, trace width, reference-plane distance, copper adjacency, and solder-mask state constant through open-field routing. If the environment must change, treat it as a transition: keep it short and symmetric, calculate or simulate it, and account for its reflection and loss. Do not route one leg closer to a plane edge, void, unrelated via field, copper pour, component pad, or board edge than the other. [C10]

## 3. Return paths and reference planes

Every signal current completes a loop. At high frequency, return current follows the lowest-impedance path, normally the adjacent reference conductor. Even if ideal differential currents partially cancel net plane current at a distance, each conductor's fields and displacement current still involve the reference structure, and any common-mode content depends on it strongly. A differential pair therefore must not be treated as self-returning immunity from reference-plane discontinuities. TI explicitly requires a nearby solid reference and documents the detour, increased loop inductance, jitter, amplitude degradation, interference, and radiation created by a split or void. [C11]

Routing rules:

- Keep the entire pair over an uninterrupted reference plane. Check plane edges, slots, anti-pad chains, split-power boundaries, connector cutouts, mounting holes, and voided pad fields.
- Prefer a ground reference when the device guide does. A power plane can be a high-frequency reference only if its return transfer to ground is intentionally provided and its impedance is acceptable over the signal spectrum.
- When both signal vias change between layers referenced to ground, place ground stitching via(s) close to the transition so return current can move between reference surfaces with small loop area. Preserve symmetry relative to P and N.
- If the old and new references are different nets, do not short them with a via. Avoid the transition where possible; otherwise use the device/platform-approved stitching capacitor or reference-transfer structure and verify it over frequency.
- Do not apply an arbitrary “stitching via every 5–10 mm” rule. Via placement must follow the actual transition, field containment, enclosure/EMI need, and highest relevant frequency.

TI SLLA414A recommends ground-plane continuity, nearby symmetric stitching vias for reference changes, and warns against power-plane references; those distances and capacitor suggestions are guidance for the covered signal conditioners and hubs, not universal protocol limits. [C12]

## 4. Skew: delay is the controlled quantity

### Intra-pair versus inter-pair

**Intra-pair skew** is the P-to-N arrival-time difference within one pair. It reduces differential eye opening and converts differential energy to common mode. **Inter-pair skew** is the arrival-time difference between separate pairs in a defined group. Some source-synchronous or bonded-lane interfaces budget it; many independent serial lanes, and unrelated TX and RX pairs, do not require physical matching. TI explicitly notes that USB SuperSpeed TX and RX pairs need not match each other and that some standards have no inter-pair requirement. [C13]

An EDA “pair length mismatch” report is only a proxy for skew. The delay budget must include:

- transmitter and receiver package/pin delay;
- actual per-layer propagation delay and anisotropy;
- via barrel and pad/anti-pad delay;
- connector contact and cable skew;
- series components, ESD devices, common-mode chokes, and AC-coupling structures;
- local glass-weave exposure; and
- any intentional polarity swap or package breakout asymmetry.

Two equal physical lengths on different layers can have different delays. Conversely, different physical lengths can be delay matched if the materials or structures differ. Use electrical delay from field/channel models when the budget is tight. [C14]

### Match locally and segment-by-segment

Do not let one leg run alone for a long distance and “fix” total length at the receiver. During the unmatched region the pair is asymmetric and can generate common mode. Keep escape, vias, components, and corners symmetric; where a local obstacle introduces skew, compensate shortly after that source. Altera and TI both advise deskew close to where skew occurs, and an Intel platform checklist gives a device-specific example of matching each same-layer PCIe segment rather than only total end-to-end etch. [C15]

### Time, unit interval, and phase

The portable calculation is:

```text
UI = 1 / symbol_rate
skew_fraction_of_UI = Δt / UI
phase_error_degrees(f) = 360 × f × Δt
```

For NRZ data, using the Nyquist frequency `f = bit_rate/2` gives `phase error = 180 × Δt/UI`. For PAM3 or PAM4, use symbol rate, not raw bit rate. For edge fidelity and mode conversion, also examine the harmonics supported by the actual transmitter rise/fall time; a phase value at Nyquist is not a complete SI acceptance criterion. [C16]

Interface-specific examples below show why no universal “5–15 ps” rule is valid:

| Interface example | First-party figure | Correct interpretation, not a universalization |
|---|---|---|
| USB 2.0 | TI SLLA414A summarizes 90 Ω ±15% differential and forbids AC-coupling capacitors | Applies to the USB mode and covered devices; obtain actual PCB skew/length guidance from the selected USB PHY/hub and its revision |
| USB 3.2 / USB4 | TI summarizes 90 Ω ±15%, `15 ps/m` maximum intra-pair skew, no TX-to-RX inter-pair match, and TX AC coupling | TI labels the whole table approximate; the per-metre number must not be converted blindly into a board-length rule, and each generation/PHY may allocate the channel differently |
| HDMI | TI summarizes 100 Ω ±15%, source intra-pair skew `0.15 × Tbit`, and source inter-pair skew `0.20 × Tcharacter` | `0.15 UI` corresponds to 27° at NRZ Nyquist by the formula above, but it is a source allocation, not automatically the PCB allowance; `Tcharacter` is not interchangeable with `Tbit` |
| DisplayPort | TI summarizes 100 Ω ±10% and a 20 ps maximum source intra-pair skew | 20 ps is 16.2% UI at 8.1 Gb/s NRZ but 40% UI at 20 Gb/s; that contrast proves the number must be read in the source/spec context and not used as a generic routing target |
| PCIe platform example | Intel's 82577 checklist targets 85 Ω differential for PCIe data, 100 Ω for PCIe reference clock, and 5 mil P/N matching per same-layer segment | It is an older, product-specific CRB rule, not a PCIe-wide rule. The current CPU/PCH/endpoint platform guide and PCI-SIG revision govern |
| 10/100 Ethernet device example | A current Microchip device guide calls for 100 Ω ±5% and P/N matching within 120 mil for its named Ethernet interface | The much looser length number than multi-Gb/s examples demonstrates device/rate dependence; it is not a rule for every Ethernet PHY or for SGMII |
| LVDS | TI shows a typical 100 Ω receiver-side differential termination | LVDS skew tolerance depends on clocking, data rate, source/receiver timing, topology, and channel; “LVDS” alone does not define a board-skew limit |

[C17]

### Meanders and trombones

Length tuning is a discontinuity to use only when the delay budget requires it.

- Add delay to the shorter leg near the mismatch source; preserve the pair's average path and reference.
- Avoid dense accordion patterns whose adjacent parallel runs couple to each other. Their added electrical delay can differ from the CAD-added centerline length and can create resonances/crosstalk.
- Use generous pitch, smooth arcs or 45° bends, and the smallest practical tuning region. Do not borrow a fixed amplitude or pitch from the seed article.
- Loosely coupled pairs tolerate brief separation for a trombone more readily; separating a tightly coupled pair changes impedance and modal behavior, so tightly coupled tuning often needs a pin-level/symmetric structure or 3-D validation.
- Include bends and any local neck-down in the delay and impedance model. Do not add decorative tuning after the pair already meets its delay budget.

Altera's current guidance says to minimize serpentine routing, avoid parallel self-coupling, and keep compensation close to the skew source; its sample dimensions are device guidance, not universal geometry. [C18]

## 5. Breakout, vias, components, and connectors

### Package and BGA breakout

Start the pair definition at the package balls/pins, not where open-field routing begins. Confirm pin polarity, whether polarity inversion is allowed, package trace delays, pin-field reference copper, and the vendor's escape topology. Keep P/N fanout geometry, neck-down length, via count, via orientation, and anti-pad environment symmetric. Breakout usually uses narrower traces and tighter pair-to-pair clearance; keep that non-ideal region short. Do not route another high-speed trace through the electromagnetic gap of a differential via pair without analysis. [C19]

### Via transitions

A via transition contains barrel inductance, pad/anti-pad capacitance, return-via coupling, and possibly a resonant unused stub. Apply these gates:

1. P and N use the same via type, drill, pad stack, start/end layers, and stub treatment.
2. Place them in a symmetric field with equal clearance to reference and neighboring vias.
3. Provide a nearby symmetric return transition; more ground vias are not automatically better if their placement is asymmetric or their anti-pads choke the plane.
4. Minimize unused barrel. Use blind/buried vias or backdrilling when the full-channel or 3-D model shows the stub threatens the band; do not encode TI's `<15 mil` stub recommendation as universal.
5. Tune pad/anti-pad dimensions only with fabrication clearance and a 3-D solver. A larger anti-pad can reduce via capacitance but can also damage return-plane continuity and crosstalk isolation.
6. Include connector pins, test vias, and component pads in the same discontinuity budget.

TI describes vias as capacitive and/or inductive discontinuities and recommends stub reduction/backdrilling for the covered high-speed devices; NXP likewise recommends routing on a layer that shortens a through-via stub and placing ground-return vias beside signal vias. [C20]

### AC-coupling capacitors, ESD, and common-mode chokes

Add AC coupling only when the interface/device requires or permits it. Place the pair of capacitors symmetrically, with identical package, orientation, pad geometry, and reference-plane treatment. Small packages often reduce pad discontinuity. A local plane void under a broad pad can compensate excess capacitance, but it must be field-solved; NXP measured/simulated a specific 0402 DisplayPort structure in which a designed cutout improved local differential impedance, which is evidence for that geometry, not a universal void size. Capacitor arrays can add pair-to-pair crosstalk. [C21]

Route ESD suppressors and common-mode chokes as pass-through elements without stubs. Obtain differential insertion/return loss, mode-conversion, capacitance balance, and power/ESD ratings over the interface band. A part advertised for the protocol is not proof that its footprint and placement meet the channel budget. [C22]

### Connectors and cables

Choose and review the connector as a multiport structure. Required evidence can include differential and common impedance, insertion/return loss, intra-pair skew, pair-to-pair crosstalk, differential-to-common conversion, current/shield grounding, mating-cycle variants, and the exact footprint model. Right-angle contacts can have unequal electrical length; pin assignment/orientation matters. TI documents skew and crosstalk mechanisms in right-angle connectors and recommends balanced pin fields. [C23]

Minimize stubs at through-hole receptacles by routing into the active end of the pin/barrel when the connector topology permits. Surface-mount pads can be capacitively low impedance because of their broad area over a plane; optimize local neck-down and plane relief with the connector vendor model. Keep shield/ground pins tied to the intended chassis or signal reference with a low-inductance strategy defined by the product EMC plan. Evaluate the PCB, connector, cable, and remote connector as one channel rather than signing off each nominal impedance in isolation. [C24]

## 6. Termination is interface-specific

Termination must match the transmitter/receiver architecture and the modal impedance, not a generic “add 100 Ω.” Possible schemes include a differential shunt at the receiver, per-leg source series resistors, Thevenin/bias networks, split termination with a common-mode center node, double termination, and integrated on-die termination. The protocol/device decides topology, location, value, bias, tolerance, and whether AC coupling is present. [C25]

For conventional DC-coupled LVDS, TI gives the familiar example of a differential resistor, typically 100 Ω, at the receiver and as close to the input pins as possible. This example cannot be copied to USB, HDMI, PCIe, or a receiver that already integrates termination; an extra shunt can double-terminate and collapse amplitude. A split termination may control common mode differently from a single resistor even when both present the same differential resistance. Verify `Zdiff`, `Zcm`, receiver bias/common-mode range, and DC power. [C26]

For multidrop or bidirectional buses, terminate the actual transmission-line ends and analyze stubs/topology. For point-to-point source termination, size each leg against the correct per-leg/odd-mode environment and include driver output impedance. Never place a termination halfway along a bus merely because it is physically close to a receiver symbol. [C27]

## 7. Common-mode conversion, emissions, and crosstalk

Any asymmetry can convert differential energy to common mode: P/N skew, unequal loss, unequal via or connector geometry, one-sided pad/plane voids, reference changes, package imbalance, glass weave, or asymmetric aggressor coupling. The reverse conversion also occurs: common noise can become differential noise. Converted common mode can radiate on cables/shields and can also remove energy from or distort the differential waveform. Keysight identifies interconnect asymmetry as the fundamental cause and uses mixed-mode measurement to locate it. [C28]

### Crosstalk controls

- Maximize pair-to-pair and pair-to-aggressor spacing after escape, especially for long parallel overlap.
- Use distance to the reference plane (`H`), parallel-run length, layer orientation, edge rate, direction, and aggressor amplitude in the coupling assessment; trace width alone is insufficient.
- Separate transmit and receive groups more strongly when near-end/far-end coupling threatens the receiver. Altera gives 5H and 9H stripline examples for specific transceiver contexts; TI gives 5W/30 mil and larger clock clearances for its covered devices; NXP gives 4H for a named bridge. These are different design contexts, not competing universal laws.
- On adjacent signal layers, route nearly orthogonally where possible; broadside parallel overlap can couple strongly.
- A grounded guard trace changes impedance and helps only when it has a low-inductance stitching design and adequate clearance. Do not insert one between P and N.
- Keep pairs away from crystals, switching nodes, oscillators, periodic clocks, magnetics, and board/plane edges unless analysis demonstrates margin.

No spacing rule alone guarantees a crosstalk level such as `-40 dB`; use a field/channel simulation or measurement when a numeric limit matters. [C29]

## 8. Glass weave and material-induced skew

PCB laminate is locally inhomogeneous: glass bundles and resin have different dielectric constants. If one leg rides over glass while the other rides through a resin-rich window, they can have different impedance and propagation delay despite identical CAD length. The resulting fiber-weave effect can create intra-pair skew and AC common mode. Altera recommends dense/spread glass and, for some very-high-rate applications, two-ply constructions around critical layers. [C30]

Mitigations, chosen with the fabricator:

- specify dense or mechanically spread glass around high-speed layers;
- use two plies or constructions that reduce resin windows when supported;
- rotate critical routes or the artwork relative to the weave, or use a gentle zig-zag to average exposure;
- widen traces relative to weave features when the stackup allows; and
- include statistical glass-weave skew in the channel budget rather than assuming nominal `Dk` is spatially uniform.

Samtec's measured test vehicle found angle- and fabric-dependent skew even on spread 1035/1078 constructions; those measured ps/in values belong only to that material, geometry, orientation, and sample. They are evidence that the mechanism is real, not a lookup table for another board. [C31]

## 9. Simulation and measurement ladder

Use the least expensive tool that can answer the pending question, but do not ask a 2-D calculator to validate a 3-D launch.

### Before layout

1. Obtain transmitter/receiver/package IBIS, AMI, SPICE, or S-parameter models as appropriate.
2. Obtain the fabricator stackup and use a 2-D quasi-static/full-wave field solver for open-field `Zodd`, `Zeven`, `Zdiff`, `Zcm`, delay, and loss versus manufacturing corners.
3. Allocate channel budgets to package, PCB, vias, components, connectors, and cable. Define acceptance metrics and frequency range before routing. [C32]

### During and after layout

1. Extract or 3-D EM-simulate BGA escapes, via transitions, plane-reference changes, connector launches, and broad component pads.
2. Cascade package/PCB/component/connector/cable models. Check differential insertion loss `Sdd21`, differential return loss `Sdd11`, common-mode behavior `Scc`, differential-to-common conversion `Scd21`, common-to-differential conversion `Sdc21`, crosstalk, and impedance/delay profiles.
3. Run time-domain or statistical channel analysis using the actual signaling/encoding, transmitter equalization, receiver model, jitter/noise, and BER target. An open eye screenshot without calibrated models and an acceptance mask is not release evidence.
4. Sweep fabrication corners: trace width/gap, dielectric thickness/Dk/Df, copper roughness, via registration, component/termination tolerance, and temperature when material data supports it. [C33]

### Lab verification

- Use a differential TDR/TDT for localized impedance, delay, and reflection diagnosis; deskew and calibrate the two stimulus/receive paths.
- Use a calibrated four-port VNA or four-channel TDR for complete balanced characterization. Convert single-ended measurements to mixed-mode S-parameters with correct port mapping and reference impedances.
- In mixed-mode notation, the first mode letter is the response and the second is the stimulus: `Sdd21` is differential transmission, `Scd21` is common response to differential stimulus, and `Sdc21` is differential response to common stimulus.
- De-embed fixtures only with a validated method and preserve both raw and de-embedded data. Inspect passivity/causality and the usable frequency range of supplied models.
- Correlate coupon TDR with actual-channel measurements or test structures. Then run the protocol's compliance tests, eye/mask or BER tests, and system EMC tests where required.

Keysight states that complete differential-pair characterization requires four ports and can recover differential/common return and insertion loss plus all mode-conversion terms. [C34]

## 10. AI routing and review contract

### Inputs the AI must require

An AI must mark the pair `BLOCKED_INPUT` rather than invent a constraint if any governing item is missing:

| Input group | Required fields |
|---|---|
| Identity | Protocol and revision, lane name, TX/RX/clock/MDI role, symbol pins and polarity, allowed polarity inversion |
| Signaling | Symbol/data rate, encoding/modulation, transmitter rise/fall time, voltage/common-mode range, equalization, receiver topology and BER/mask target |
| Limits | `Zdiff` target/tolerance, any single-ended/common target, intra-pair delay/skew, applicable inter-pair group/skew, maximum route/channel loss, return loss, crosstalk, mode conversion, via/stub and total-length limits |
| Channel | Package delay/model, on-board topology, termination and bias, AC-coupling requirement/location, ESD/choke models, connector/cable/remote-board models |
| Stackup | Fabricator/revision, layer/reference assignment, finished copper, dielectric thickness and frequency-dependent Dk/Df, glass style, solder mask, copper roughness, construction tolerances |
| Vias/fabrication | Drill/pad/anti-pad, start/end layers, stub/backdrill rules, registration/clearance, minimum width/gap, controlled-impedance and coupon process |
| Placement | Fixed package/connector positions, escape constraints, plane splits/voids, keepouts, aggressor classes, chassis/shield strategy |
| Evidence | Source document/revision/page for every hard limit, model filenames/checksums, solver setup, exception owner, and acceptance-test plan |

[C35]

### Rule severity and automation

Encode each rule with `source`, `scope`, `revision`, `units`, `severity`, `verification_method`, and `exception_owner`:

- `MUST`: explicit requirement from the governing protocol/device/fabricator document.
- `BLOCK`: missing input or a violation that prevents release.
- `WARN`: portable best practice with context-dependent exceptions.
- `NEEDS_FIELD_SOLVE`: open-field geometry or manufacturing-corner question.
- `NEEDS_3D_EM`: via, pad, connector, neck-down, or plane-transition question.
- `NEEDS_CHANNEL_SIM`: combined loss/reflection/jitter/crosstalk/BER question.
- `MEASURE`: coupon, TDR/VNA, protocol compliance, or EMC evidence required.

Minimum automated checks should cover P/N net association and polarity; allowed layer set; width/gap and uncoupled-length windows; physical and estimated delay mismatch; same segment/layer/component/via count; symmetric via/pad/anti-pad geometry; reference-plane continuity; distance to plane edges/voids and aggressors; stub/test-point prohibition; AC-cap and termination placement; pair-to-pair group rules; connector-pin mapping; glass-weave mitigation flag; and existence of simulation/measurement artifacts. [C36]

### Exceptions

An exception is acceptable only when it records the exact violated rule, affected geometry, reason, governing source, analysis or measurement showing margin, approver, and expiry/review trigger. Examples include a vendor-approved polarity swap, short asymmetric package escape included in the package/channel model, a field-solved connector plane void, a longer via stub proven outside the channel band, or inter-pair mismatch on independently recovered serial lanes. “The router could not fit it” is not an engineering exception. [C37]

## 11. Review and release checklist

- [ ] Exact protocol/device revisions and pair roles are recorded.
- [ ] Target impedance and tolerance come from the governing source, not a generic table.
- [ ] Production stackup is released and open-field geometry is solved at corners.
- [ ] P/N package delay, via count, component count, connector path, and reference environment are symmetric or explicitly modeled.
- [ ] Intra-pair delay, not only CAD length, meets its allocated budget.
- [ ] Inter-pair matching is applied only to the defined group that requires it.
- [ ] All reference planes are continuous; every layer/reference transition has an intentional return path.
- [ ] Breakout, component pads, plane voids, vias/stubs, and connector launches have the required 3-D evidence.
- [ ] Meanders are necessary, local to the skew source, and free of excessive self-coupling.
- [ ] Crosstalk spacing is source-scoped or numerically verified; there is no claimed dB result from a spacing heuristic alone.
- [ ] Termination, bias, and AC coupling match the actual transmitter/receiver architecture.
- [ ] Glass-weave risk is addressed for tight-skew/high-rate pairs.
- [ ] Channel simulation covers differential loss/return loss, mode conversion, crosstalk, jitter/noise, and manufacturing corners as applicable.
- [ ] Coupon and actual-channel measurement plans are distinct; fixtures and port mapping are documented.
- [ ] Every waiver has evidence and an owner.

## Article claim audit

| Seed-article statement | Assessment | Safe replacement |
|---|---|---|
| Differential receivers cancel common noise | Directionally correct but conditional | Cancellation depends on amplitude/time balance and receiver common-mode range/CMRR; asymmetry converts modes. [C03, C28] |
| Differential impedance is typically 90–100 Ω | Useful examples, not an allowed default | Read the exact protocol revision and silicon/platform guide; values such as 85, 90, 95, 100, or others occur. [C17] |
| 4–6 mil width, 5–8 mil gap, 4–6 mil prepreg “work well” for 100 Ω FR-4 | Not portable | Solve the released stackup including copper, mask, Dk/Df, roughness, and tolerances. [C07] |
| Keep skew to 5–15 ps or `<0.1 mm for >5 Gbps` | Overgeneralized | Allocate delay from the interface/device channel budget; convert physical mismatch using the actual propagation model. [C14–C17] |
| Prefer inner layers | Context dependent | Choose microstrip/stripline from loss, shielding, via, routing-density, and vendor guidance; TI and Altera examples differ. [C02] |
| Tight coupling maximizes common-mode rejection | Incomplete | Balance, modal impedance, external-field exposure, manufacturing sensitivity, and return structure all matter; tight is not always better. [C05] |
| Four-to-six ground vias per pair; stitching every 5–10 mm | Unsupported as universal counts | Put symmetric return transitions where the current changes reference and design the field/EMC containment for the band. [C12, C20] |
| 5H spacing keeps FEXT below −40 dB | Unsupported as a universal performance guarantee | Crosstalk depends on stackup, overlap, direction, edge rate, and aggressor; simulate or measure a numeric dB limit. [C29] |
| Bends/connectors/layer changes create impedance drops | Directionally useful but sign is not fixed | Discontinuities can look capacitive or inductive; optimize their 3-D geometry and measure/simulate. [C20, C24] |
| TDR verifies impedance | Correct but incomplete | Calibrated differential TDR localizes impedance; full balanced characterization needs four-port mixed-mode data and channel/compliance tests. [C34] |

## Claim-to-source ledger

This ledger covers every consequential claim identifier used above. “Derived” means the stated conclusion follows from the cited definitions or values but is not quoted as a rule by the source.

| Claim | Claim summary | Supporting source(s) | Evidence status / limitation |
|---|---|---|---|
| C01 | Supplied URL was unavailable; current JLC article used as seed | S1, S18 | HTTP 404 was independently observed 2026-09-06; S1 is the discoverable current page |
| C02 | Seed fixed rules are not portable; vendor rules conflict by context | S1, S2, S3, S8 | S2 explicitly labels protocol values approximate; S2 and S8 differ on preferred routing layer |
| C03 | Differential/common definitions and conditional common-noise rejection | S4, S11 | Established balanced-line definition; receiver behavior still device-specific |
| C04 | Odd/even/differential/common impedance and factor conventions | S4, S5 | Valid for symmetric pairs and stated balanced-port convention |
| C05 | Coupling changes modal impedance; close coupling is a trade | S3, S5 | Directional behavior; exact sensitivity requires solver |
| C06 | Differential target alone does not prove balance | S6, S7 | Supported by mixed-mode characterization; acceptance limit is project-specific |
| C07 | Stackup and material inputs determine geometry | S1, S2, S3 | Source lists main variables; expanded input list is engineering synthesis |
| C08 | Geometry changes impedance; 3-D structures exceed trace formulas | S5, S10, S20 | Directional claim; solve exact construction |
| C09 | Coupon is not proof of every local channel structure | S6, S20 | Engineering inference from local/4-port characterization scope |
| C10 | Preserve symmetric geometry and environment | S8, S19 | First-party high-speed routing guidance |
| C11 | High-frequency return follows adjacent reference; splits degrade SI/EMI | S2 | Device-family guidance grounded in return-current physics |
| C12 | Reference transitions need nearby intentional return; no universal pitch | S2, S10 | Source distances/parts remain platform-specific |
| C13 | Intra- vs inter-pair distinction; many pairs need no mutual match | S2, S3 | TI examples; verify actual protocol |
| C14 | Delay matching includes package/layer/via/connector/material | S8, S9, S11 | Engineering synthesis from documented delay/asymmetry sources |
| C15 | Compensate locally and, where required, per segment | S3, S8, S14 | Intel 5-mil segment rule is platform-specific |
| C16 | UI and phase equations | Derived | Arithmetic definitions; not a compliance criterion by themselves |
| C17 | Protocol examples differ materially | S2, S12, S13, S14 | Values scoped to cited document/device/revision; not universal standards table |
| C18 | Meander self-coupling and local deskew guidance | S8, S15 | Sample dimensions in sources are not exported as rules |
| C19 | Breakout should be short and symmetric | S2, S8 | Device-family guidance |
| C20 | Via discontinuity/stub/return-via rules | S2, S10 | Backdrill threshold is channel/platform dependent |
| C21 | Symmetric AC capacitors; local plane void can compensate pads | S10 | NXP geometry-specific evidence |
| C22 | Protection/filter parts need broadband balanced models | S6, S10, S20 | Engineering synthesis; limits come from protocol/channel |
| C23 | Connector pin fields can create skew/crosstalk | S11 | Older but mechanism remains applicable; use current connector data |
| C24 | Connector launch/stub and full-channel treatment | S2, S6, S10 | Full-channel acceptance is protocol-specific |
| C25 | Termination topology is interface-specific | S12, S16 | General termination principle |
| C26 | Conventional LVDS uses typical 100 Ω far-end termination; do not copy blindly | S12 | Applies to conventional LVDS example |
| C27 | Bus/source termination depends on topology and per-leg impedance | S16 | General transmission-line practice; device guide governs |
| C28 | Asymmetry creates mode conversion and can worsen EMI/eye | S6, S7, S11 | Numeric limit must come from channel spec |
| C29 | Crosstalk needs contextual spacing or simulation, not one heuristic | S2, S8, S10 | Three first-party rule sets demonstrate scope dependence |
| C30 | Glass/resin inhomogeneity creates impedance and delay skew | S9 | Current first-party FPGA stackup guidance |
| C31 | Dense/spread glass and route angle mitigate; measured values are construction-specific | S9, S17 | Samtec measurement corroborates mechanism but is not universal |
| C32 | Prelayout model/field-solve/budget ladder | S5, S6, S8 | Workflow synthesis |
| C33 | 3-D/channel simulation and corner analysis | S6, S8, S20 | Metrics supported; exact corners/limits are project inputs |
| C34 | TDR and complete four-port mixed-mode measurement roles | S4, S6, S7 | Instrument setup/calibration still required |
| C35 | Required AI input contract | S2, S3, S6, S8 | Synthesis designed to prevent invented constraints |
| C36 | Severity model and automated checks | S2, S8, S19 | Workflow proposal; source each hard value before enforcement |
| C37 | Evidence-backed exception process | Derived | Governance recommendation |

## Source register

| ID | Source | Publisher / date | Use and access notes |
|---|---|---|---|
| S1 | [*Differential Pairs on PCBs: Best Practices for Routing, Impedance Control, and Signal Integrity*](https://jlcpcb.com/blog/differential-pairs-pcb-practices) | JLCPCB, published 2026-02-09, updated 2026-02-26 | Seed article; marketing/tutorial source, not a protocol specification. Accessed 2026-09-06. |
| S2 | [*High-Speed Layout Guidelines for Signal Conditioners and USB Hubs*, SLLA414A](https://www.ti.com/lit/pdf/slla414) | Texas Instruments, Aug. 2025, rev. Jan. 2026 | Protocol summary, return paths, spacing, breakout, connector and via guidance. It expressly says table values are guidelines and not always exact. |
| S3 | [*Jacinto7 AM6x, TDA4x, and DRA8x High-Speed Interface Design Guidelines*, SPRACP4A](https://www.ti.com/lit/pdf/spracp4) | Texas Instruments, Dec. 2019, rev. June 2024 | Tight/loose coupling, intra/inter-pair skew, local compensation. Device-family scope. |
| S4 | [*Channel Step Setup: General Information on Differential Measurements*](https://helpfiles.keysight.com/scopes/FlexDCA-UG/Content/Topics/TDR-TDT-Mode/Toolbar-Setup/Channel_Step_Setup.htm) | Keysight Technologies, current online help, accessed 2026-09-06 | Odd/even excitation and per-line impedance definitions. |
| S5 | [*Coupled microstrip transmission line*](https://optics.ansys.com/hc/en-us/articles/360042050934-Coupled-microstrip-transmission-line) | Ansys, current technical example, accessed 2026-09-06 | Solver-backed even/odd modes and `Zdiff`/`Zcm` factor conventions. |
| S6 | [*Signal Integrity Analysis Series: 4-Port TDR/VNA/PLTS*](https://www.keysight.com/my/en/assets/7018-01462/application-notes/5989-5764.pdf) | Keysight Technologies, application note, accessed 2026-09-06 | Four-port differential/common impedance, loss, crosstalk, and mode-conversion characterization. |
| S7 | [*InfiniiSim Waveform Transformation Toolset Software User's Guide*](https://www.keysight.com/us/en/assets/9018-06785/user-manuals/9018-06785.pdf) | Keysight Technologies, current guide, accessed 2026-09-06 | Mixed-mode matrices and `Sdd`, `Scc`, `Sdc`, `Scd` nomenclature. |
| S8 | [*PCB Traces*, Agilex 5 PCB Design Guidelines](https://docs.altera.com/r/docs/821801/current/pcb-design-guidelines-hssi-emif-mipi-true-differential-pdn-user-guide-agilextm-5-fpgas-and-socs/pcb-traces) | Altera, current documentation, accessed 2026-09-06 | Symmetry, breakout, TX/RX spacing, deskew location, meanders, and fiber-weave mitigation. |
| S9 | [*Fiberglass Weave Composition*, AN 613](https://docs.altera.com/r/docs/683883/current/an-613-pcb-stackup-design-considerations-for-altera-fpgas/fiberglass-weave-composition) | Altera, current documentation, accessed 2026-09-06 | Glass-weave mechanism and dense/spread-glass mitigations. |
| S10 | [*PTN3363/65/66 PCB Layout Guidelines*, AN11397 rev. 3](https://www.nxp.com/docs/en/application-note/AN11397.pdf) | NXP Semiconductors, 2017-04-25 | Via stubs/returns, 4H spacing example, HDMI/DisplayPort pad and capacitor discontinuities. Product-specific and older. |
| S11 | [*Suggestions for High-Speed Differential Connections*, SLLA104A](https://www.ti.com/lit/pdf/slla104) | Texas Instruments, Aug. 2001, rev. Sept. 2004 | Connector skew/crosstalk and differential/common-mode EMI mechanisms. Older source used for stable physics, not current protocol limits. |
| S12 | [*Termination Guidelines for Differential and Single-Ended Signals*, SNAA377](https://www.ti.com/lit/an/snaa377/snaa377.pdf) | Texas Instruments, Dec. 2025 | Conventional LVDS termination and location; also illustrates interface-specific termination families. |
| S13 | [*Ethernet Design Layout Recommendations*](https://onlinedocs.microchip.com/oxy/GUID-D6349AB0-E94B-4B05-AF38-27CC9603908D-en-US-3/GUID-A6CA9F9E-49ED-46DE-9928-9B489BD48EAE.html) | Microchip Technology, online device documentation, accessed 2026-09-06 | Named Ethernet design example: 100 Ω ±5% and 120 mil intra-pair length matching. Device scope only. |
| S14 | [*82577 Schematic/Layout Checklist*, version 2.1](https://www.intel.com/content/dam/doc/reference-guide/82577-gbe-controller-schematic-checklist-ver-2-1.pdf) | Intel, 2010 | Product-specific PCIe example: 85 Ω data, 100 Ω reference clock, 5 mil per-segment match. Historical/platform evidence, not a current PCIe-wide rule. |
| S15 | [*Skew Minimization*, AN 958 Board Design Guidelines](https://docs.altera.com/r/docs/683073/current/an-958-board-design-guidelines/skew-minimization) | Altera, current documentation, accessed 2026-09-06 | Loose/tight-pair serpentine cautions and self-coupling. |
| S16 | [*AN-1177: LVDS and M-LVDS Circuit Implementation Guide*](https://www.analog.com/en/resources/app-notes/an-1177.html) | Analog Devices, current web edition, accessed 2026-09-06 | Termination/topology, connector and routing discontinuity context. |
| S17 | [*A Vehicle for In-situ Glass Fabric Characterization*](https://blog.samtec.com/post/vehicle-for-insitu-glass-fabric-characterization-edi-con-2017/) | Samtec / Danny Boesing, 2017-09-15 | Report of measured glass-weave test vehicle; secondary company summary of named experimental work. |
| S18 | [Supplied JLCPCB article URL](https://jlcpcb.com/blog/differential-pairs) | JLCPCB, checked 2026-09-06 | Returned HTTP 404; retained only to document URL resolution, not as technical evidence. |
| S19 | [*AN 958: Board Design Guidelines*](https://cdrdv2-public.intel.com/677286/an958-683073-677286.pdf) | Intel/Altera, 2023-06-26 edition | Differential routing, constant spacing, skew, via minimization. Device-family guidance. |
| S20 | [*Signal Integrity Analysis Series Part 1: TDR/TDT and 2-Port TDR*](https://www.keysight.com/us/en/assets/7018-01461/application-notes/5989-5763.pdf) | Keysight Technologies, application note, accessed 2026-09-06 | TDR impedance/mode-conversion diagnosis and asymmetry effects. |

## Research coverage, limitations, and stop condition

Research covered the supplied/current JLCPCB article; first-party semiconductor layout guides; modal impedance definitions from instrument and field-solver vendors; protocol-specific examples; connector, via, termination, crosstalk, glass-weave, simulation, and mixed-mode measurement guidance. The licensed USB, HDMI, DisplayPort, PCI-SIG, IEEE 802.3, and TIA/EIA standards were not all publicly accessible in full, so this dossier deliberately labels vendor protocol summaries and product examples rather than presenting them as definitive current compliance limits. For a real board, obtain the applicable specification and silicon/platform documentation before releasing constraints.

The search stopped after the requested topics had primary or clearly bounded specialist evidence, the central contradictions were reconciled as scope differences, and further generic layout articles were unlikely to change the decision rules. The unresolved items are necessarily project-specific: exact protocol revision, device, signaling mode, channel allocation, stackup, topology, and models.

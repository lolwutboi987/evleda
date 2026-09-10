# Research dossier: EMI vs EMC in PCB design

**Anchor article:** JLCPCB, “EMI vs EMC: A Full Guide to Detailed Comparison” (published and updated 2025-12-08)  
**Research date:** 2026-09-06  
**Audience:** PCB designers, reviewers, and AI systems that generate or audit layouts  
**Decision supported:** distinguish electrical-design risk from market-access obligations, then turn the distinction into reviewable layout and test requirements

## Executive determination

The article has a useful teaching frame: an electronic product is both a possible source and a possible victim; EMC therefore requires controlling emissions and providing adequate immunity. Its source-path-victim explanation, warnings about return-path discontinuities, and emphasis on physical layout are directionally sound.

It is not a sufficient compliance or layout specification. Four corrections are consequential:

1. In standardized vocabulary, an **electromagnetic disturbance** is the phenomenon that may degrade performance; **EMI** is the degradation caused by that disturbance. Calling EMI itself “unwanted energy” is common informal usage, but it collapses cause and effect. The distinction matters when recording a failure: field/current/voltage is the stimulus, coupling is the path, and reset/data corruption/noise is the interference effect. [ITU-T K.114 reproduces the IEC 60050-161 definitions](https://www.itu.int/epublications/en/publication/itu-t-k-114-2022-08-electromagnetic-compatibility-requirements-and-measurement-methods-for-digital-cellular-mobile-communication-base-station-equipmen).
2. “Conducted below 30 MHz, radiated above 30 MHz” is a common **test-band convention**, not a physical boundary. Conducted common-mode current on a cable can radiate well below or above 30 MHz; a radiated field can induce terminal current. Capacitive and inductive coupling are near-field mechanisms, not two additional mutually exclusive channels beside “radiated.”
3. The article says both emissions and immunity are tested for FCC certification. That is not generally true for a Part 15 Subpart B unintentional radiator. The current US rule establishes authorization and emission limits; it does not create a general product-immunity test. The EU EMC Directive, by contrast, has both emission and immunity essential requirements. [47 CFR Part 15 Subpart B](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-B) and [Directive 2014/30/EU, Annex I](https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1591611078730&uri=CELEX%3A32014L0030) are different legal regimes.
4. Rules such as “four layers are intrinsically superior,” “use 0.1 µF at every IC,” “all filters must be immediately at a connector,” and “a trace over a split guarantees failure” are heuristics, not universal truths. A design must identify the actual high-frequency current loop, reference path, common-mode conversion mechanism, port, enclosure, cable, operating state, and applicable test.

**Bottom line:** emissions and immunity are engineering properties of the complete configured product, not of an isolated PCB file. A layout can reduce risk, but neither an AI review, simulation, near-field scan, nor pre-compliance sweep proves legal conformity. Compliance requires the applicable jurisdictional route, product/environment standard, prescribed configuration and methods, records, and any required authorization or declaration.

## 1. Terminology that a design or review system must preserve

| Term | Operational meaning | What to record |
|---|---|---|
| Electromagnetic emission | Electromagnetic energy emanating from a source, intentionally or unintentionally. | Source, spectrum/time behavior, mode, port, operating state. |
| Electromagnetic disturbance | An electromagnetic phenomenon that may degrade performance. | Voltage, current, field, waveform, frequency, modulation, repetition, path. |
| Electromagnetic interference (EMI) | Performance degradation caused by a disturbance. | Victim, observable failure, threshold, recovery, safety or data consequence. |
| Electromagnetic compatibility (EMC) | Ability to function satisfactorily in the intended EM environment without introducing intolerable disturbance into it. | Emission margin plus immunity performance for the intended environment and configuration. |
| Immunity | Ability to perform without unacceptable degradation in the presence of a specified disturbance. | Applied phenomenon, level, ports, configuration, performance criterion and monitoring. |
| Susceptibility | Tendency or inability to withstand a disturbance. It is the inverse design concern of immunity; “EMS” is used inconsistently in industry. | Lowest repeatable disturbance that causes a defined failure, with uncertainty. |
| Conducted disturbance | Energy represented as voltage/current on a conductor or port. | Differential/common mode, impedance network, terminal, cable arrangement. |
| Radiated disturbance | Energy assessed as an electromagnetic field. | E- or H-field, distance, antenna/probe, polarization, chamber/site, correction factors. |

The article’s “EMI is the problem, EMC is the solution” is acceptable as a mnemonic, but not as formal terminology. EMC is not one pass/fail standard. It is a system property assessed against requirements chosen for a product, use environment, port set, jurisdiction, and sector.

### Emissions and immunity are not mirror-image tests

- **Emission testing** observes energy leaving the equipment. It normally searches for the maximum over specified operating modes, cable arrangements, azimuths, antenna polarizations/heights, detectors, bandwidths and frequency ranges.
- **Immunity testing** applies a controlled disturbance and observes functional behavior. Passing depends on a declared performance criterion: uninterrupted operation, self-recovery, operator recovery, no unsafe state, no data loss, or another product-specific threshold.
- Reciprocity is a useful diagnostic idea—a structure that radiates efficiently can often receive efficiently—but a product’s nonlinearities, protection devices, software state and internal thresholds mean emission and immunity results are not numerically reciprocal.

## 2. Audit of the anchor article

| Article proposition | Assessment | Engineering correction |
|---|---|---|
| Every circuit can behave as source and receiver. | Sound model. | Add the required third element: a coupling path. No interference occurs without source, path and susceptible victim. |
| EMI is unwanted electromagnetic energy. | Informal, terminologically imprecise. | Call the energy a disturbance or emission; reserve EMI for performance degradation when using IEC/ITU vocabulary. |
| Fast `dV/dt` and `dI/dt` create broadband problems. | Sound but incomplete. | Edge spectrum, repetition, ringing, resonance, loop geometry and common-mode conversion determine what reaches a port or antenna. Clock rate alone is not the highest relevant frequency. |
| Conducted coupling dominates from kHz to tens of MHz; radiated above 30 MHz. | Useful test intuition, not physics. | Treat 30 MHz as a frequent regulatory crossover. Diagnose both current and fields on either side of it. |
| Conducted, radiated, capacitive and inductive are four paths. | Taxonomy overlaps. | Conducted and field coupling are broad descriptions; capacitive (`i = C·dV/dt`) and inductive (`v = M·dI/dt`) describe near-field coupling. Common-impedance coupling is also essential. |
| EMC always has emissions and immunity. | Correct as an engineering concept. | A particular legal regime may regulate only part of that concept. US FCC Part 15 B and Australia’s ACMA EMC arrangement principally address emissions; the EU EMC Directive expressly covers both. |
| FCC and CE certification test both pillars. | Incorrect as a general statement. | “CE certification” is also misleading: under the EMC Directive the manufacturer performs conformity assessment and issues an EU declaration; harmonized standards can provide presumption of conformity. FCC authorization is a separate process, and Part 15 B does not impose general immunity tests. |
| A trace over a split is a guaranteed radiated-emissions failure. | Overstated. | It is a high-risk return discontinuity. Outcome depends on edge current, geometry, alternative return path, cable/common-mode conversion, resonances and limit margin. Flag it; do not declare failure without measurement. |
| A four-layer `SIG-GND-PWR-SIG` stack is intrinsically superior. | Often helpful, not universal. | Plane adjacency and dielectric spacing, routing layer references, return transitions, power islands and connector strategy matter more than layer count alone. A disciplined two-layer product can pass; a poor multilayer board can fail. |
| Closely coupled power/ground planes form useful HF capacitance. | Conditional. | “Closely” is the key. A conventional thick core between planes may provide little useful plane capacitance. Quantify geometry and PDN impedance; do not infer decoupling from layer names. |
| Via fences cage noise. | Conditional. | Stitching can control surface current and slot/aperture behavior only when tied into a coherent reference/chassis strategy with frequency-appropriate spacing. Sparse vias around floating copper do not form a Faraday cage. |
| All filters belong immediately at connectors. | Usually right for boundary control, too absolute. | A port filter should prevent an unfiltered inside trace from crossing the clean/dirty boundary. Source filters may instead belong at the source. Placement must follow the intended return path and safety isolation. |
| Tightly coupled, length-matched differential pairs solve EMI. | Incomplete. | Preserve impedance and symmetry through pins, pads, vias, reference changes and connector launch. Pair skew and imbalance convert differential energy to common mode, but gratuitous meanders can add discontinuities. Follow the interface budget. |
| Put a 0.1 µF capacitor at every IC. | A familiar starting heuristic, not a design rule. | Select capacitance, package, mounting and count from the IC’s current spectrum and vendor guidance plus PDN target impedance. Loop inductance and anti-resonance can dominate nominal capacitance. |
| A Faraday cage must be grounded. | Overgeneralized. | A closed conductor can shield without an earth connection. Low-impedance bonding, seam continuity, cable-entry treatment and intentional chassis/reference connections govern current paths. Protective earth is a safety function and must not be improvised for EMC. |

## 3. Mechanisms: source, path, victim

### 3.1 Source characterization

Inventory energy by **edge and loop**, not just net name or clock frequency:

- switching-converter commutation loops, rectifier recovery, switch-node voltage slew and ringing;
- processor/FPGA simultaneous switching, clocks, strobes and memory buses;
- motor commutation, relay/contactor arcs, solenoids and cable inductance;
- intentional transmitters, local oscillators and RF power amplifiers;
- hot-plug, ESD, EFT, surge and load-step transients;
- external transmitters, power-network disturbances and magnetic fields for immunity.

For each source record waveform amplitude, rise/fall time, repetition rate, duty cycle, ringing frequency and decay, source impedance, maximum-current operating mode, and the physical forward/return path. A nominally low-rate GPIO with a sub-nanosecond edge may excite far higher-frequency structures than its toggle rate suggests.

### 3.2 Differential-mode and common-mode current

**Differential mode (DM)** is equal and opposite current on the intended forward and return conductors. Its dominant small-structure radiation model is a current loop. The magnetic dipole moment scales with current times loop area. For an electrically small loop in the far-field approximation, TI reproduces Ott’s estimate

`E ≈ 263 × 10⁻¹⁶ · f² · A · I / r` V/m,

where `f` is Hz, `A` is m², `I` is A and `r` is m. The estimate shows sensitivity to harmonic frequency and loop area; it is not a compliance calculator because the assumptions, waveform spectrum, orientation, site and cable system are simplified. [TI AN-2052](https://www.ti.com/lit/pdf/snva436).

**Common mode (CM)** is in-phase current on multiple conductors relative to some external return such as chassis, earth, another cable, a person or parasitic capacitance. Even a small CM conversion can dominate radiation because the resulting cable or enclosure structure is much larger than a PCB loop. Causes include:

- unequal return impedances or shared ground inductance;
- asymmetry in a differential channel, connector or filter;
- capacitance from a high-`dV/dt` node to chassis, heatsink, shield or another isolated domain;
- reference-plane discontinuities and poorly placed return transitions;
- isolated converters driving displacement current through barrier capacitance;
- shield termination impedance or a cable shield bonded at the wrong electromagnetic boundary.

TI gives a cable estimate at a particular 10 m chamber setup of `E ≈ 1.26 × 10⁻⁴ · f · l_cable · I_CM`; use it only as the cited application note defines it. Its durable lesson is that measured radiation depends on CM current and the installed cable length/configuration. [TI SLVA790A](https://www.ti.com/jp/lit/an/slva790a/slva790a.pdf).

For conducted-emission debugging, do not assume a peak is DM or CM from frequency alone. A separator/network or paired current measurements can distinguish them; the remedy differs. [Analog Devices’ CM/DM separation method](https://www.analog.com/en/resources/analog-dialogue/articles/separating-common-mode-and-differential-mode-emissions-in-conducted-emissions-testing.html) makes this explicit.

### 3.3 Coupling equations and paths

- **Capacitive coupling:** displacement current is approximately `i = C_m · dV/dt`. Reduce mutual capacitance, voltage slew, victim impedance or exposed high-`dV/dt` area; interpose a well-referenced shield where appropriate.
- **Inductive coupling:** induced voltage is approximately `v = M · dI/dt`. Reduce mutual inductance, source and victim loop areas, current slew, and loop overlap; use close forward/return geometry or twisting.
- **Common-impedance coupling:** `v_noise = Z_shared · i_noise`. Separate or lower the shared impedance, not merely the DC resistance. A narrow “ground” trace, via, connector pin, chassis joint or cable return can have low ohms at DC yet harmful inductance at RF.
- **Field-to-conductor conversion:** a trace, plane pair, heatsink, shield seam or cable becomes an antenna when geometry and current distribution permit. Radiation need not wait until a quarter wavelength; inefficient antennas can still exceed a stringent limit.
- **Nonlinear demodulation:** RF at an input, ESD clamp or semiconductor junction can rectify or mix down into the signal band. A victim can fail at a frequency not present in its intended signal.

### 3.4 Near field, far field, and why probe data are relative

Close to a source, E and H fields can behave independently and are strongly geometry-dependent. Small E/H probes are excellent for locating and comparing sources but generally do not yield a legal far-field result. Keysight describes `R > 2D²/λ` as a common antenna far-field criterion; EMC product standards may prescribe a measurement distance and site validation rather than letting the designer choose from that formula. [Keysight near/far-field guide](https://www.keysight.com/ua/en/assets/9018-06267/reference-guides/9018-06267.pdf).

Use a near-field scan as a repeatable A/B diagnostic: same probe, orientation, height, cable routing, analyzer settings, board state and fixture. A 10 dB local reduction is valuable evidence about the source, but it is not automatically a 10 dB reduction at 3 m or 10 m because the dominant radiator may be a cable or enclosure mode.

## 4. Design controls, including failure modes and exceptions

### 4.1 Ground, reference and return-path architecture

“Ground” must be qualified:

- **signal reference/return** closes functional current loops;
- **power return** carries converter/load current;
- **chassis or shield** carries surface, ESD and cable-boundary currents;
- **protective earth (PE)** is a safety conductor governed by safety requirements;
- **functional earth** is an intentional performance connection.

Rules:

1. Give every high-edge-rate signal an adjacent, continuous reference from driver to receiver. Avoid plane slots, voids and island boundaries beneath it.
2. When a signal changes layers, place a nearby return via to the same reference. If its reference changes between two planes that are meant to be AC-coupled, provide an intentional low-inductance return transition appropriate to the interface. Never bridge a mandated safety-isolation barrier casually.
3. Partition noisy and sensitive circuits by placement so their return currents do not share an avoidable impedance. A solid plane plus good partitioning is often safer than a blindly split analog/digital plane; ADI warns that splitting can raise return inductance and gives constrained cases where deliberate splits may help. [ADI AN-1142](https://www.analog.com/en/resources/app-notes/an-1142.html).
4. Map current across connector pins and board-to-board connections. One thin ground pin beside many fast signals can turn intended DM current into CM current.
5. Treat unused or poorly stitched copper as a possible resonator/coupling plate. Do not add ground pours or fences without showing their return connection.

**Exception:** galvanic isolation, hazardous voltage, patient protection, intrinsically safe design and other safety architectures can require separated references and clearance/creepage. EMC remedies must preserve those barriers, leakage limits and certified component constraints.

### 4.2 Power delivery and switching converters

- Identify the discontinuous high-`dI/dt` “hot loop” for each switch state. Place the commutating capacitor and switching devices so the complete loop is compact; do not minimize only the visible switch trace.
- Minimize switch-node copper consistent with thermal and voltage-clearance needs. Large high-`dV/dt` copper raises capacitive coupling; too little copper can violate thermal limits.
- Put decoupling where it minimizes the pin-to-capacitor-to-return loop. Vias closest to pads tend to matter more than remote extra vias; ADI’s modeled and measured examples show that via-count benefit is not linear. [ADI hot-loop study](https://www.analog.com/en/resources/analog-dialogue/raqs/raq-issue-207.html).
- Select capacitance and package by impedance over frequency, including DC-bias derating, ESR, ESL and anti-resonance. The article’s “typically 0.1 µF” is not a universal acceptance criterion.
- Keep the input/output filter physically and electromagnetically separated: a trace or plane that couples around the filter defeats it. Add damping when high-Q LC interaction can amplify a band.
- Use gate resistance, spread-spectrum modes or snubbers only after checking switching loss, control stability, timing and functional specifications.

### 4.3 Differential interfaces

- Preserve pair symmetry in route length, dielectric environment, bends, via count, pads, stubs, reference plane and common-mode components.
- Meet both differential impedance and the interface’s single-ended/common-mode constraints. A pair can have the right differential impedance yet convert modes at an asymmetric launch.
- Match within the protocol/vendor skew budget; do not add long serpentine tuning solely to reach an arbitrary geometric equality.
- Keep both conductors together through protection and filtering. A common-mode choke must be selected for CM impedance **and** differential insertion loss, mode conversion, current/saturation and ESD/transient behavior.
- Provide a defined return for common-mode energy at the connector/chassis boundary. “Differential” does not eliminate common-mode current; ADI shows that length, twist or dielectric asymmetry converts differential energy to common mode. [ADI on unbalanced pairs](https://www.analog.com/en/resources/technical-articles/unbalanced-twisted-pairs-can-give-you-the-jitters.html).

### 4.4 Filtering and transient protection

Choose the network by mode and threat:

| Problem | Typical control | Frequent mistake |
|---|---|---|
| DM continuous noise | Series impedance plus line-to-line/bypass capacitance, damping, source slew control | Choosing from a 50 Ω insertion-loss graph without source/load impedance or bias conditions. |
| CM continuous noise | Common-mode choke/ferrite plus a deliberate return to chassis/reference through approved capacitors | Shunting CM current into a noisy digital ground or bypassing the choke with plane capacitance. |
| ESD/EFT/surge | Low-inductance diversion at entry, TVS/GDT/series impedance/filter appropriate to waveform | Long protection stub, protected and unprotected traces coupled together, or no discharge return. |
| Sensitive analog input | Balanced RC/LC filtering, shielding, CMRR preservation | Component tolerance/layout imbalance converts CM stimulus into differential error. |

Place a boundary filter so the “dirty” external conductor cannot couple around it into the protected region. Place a source filter so the source-to-filter loop is short. A capacitor is effective only if its return reaches the intended sink with low impedance. Murata’s guidance notes that an inappropriate/high-impedance filter ground reduces CM-filter effectiveness and can create common-impedance coupling. [Murata filter/ground guidance](https://www.murata.com/en-us/products/emc/emifil/library/knowhow/basic/chapter01-p1).

Safety-rated line-to-earth or line-to-chassis capacitors are constrained by insulation class, leakage/touch current, surge rating and applicable safety standard. An AI must never recommend changing such a capacitor solely for EMC.

### 4.5 Cables, connectors and enclosure boundaries

- Treat every external cable as a possible antenna and every port as an EMC boundary. Test the actual permitted cable types, lengths, shields, loads and accessories.
- For DM links, pair each signal with its intended return or use twisted/balanced geometry. A clamp-on ferrite around the **whole cable** primarily impedes CM current; putting only one conductor through it changes the circuit differently.
- Bond a cable shield circumferentially to chassis at entry when the interface/standard calls for it. A long pigtail adds inductance and leaves a high-frequency discontinuity. Board signal ground, connector shell, chassis and PE are not automatically the same net.
- Keep connector filtering/protection at the boundary and prevent interior routing from running parallel to unfiltered exterior-side traces.
- A metal enclosure’s shielding depends on surface-current continuity. Seams, display windows, ventilation, fasteners, coating at bonds and cable penetrations often dominate. Many small apertures are not always equivalent to one slot; the longest dimension and current crossing the seam matter.
- Earth connection is not a prerequisite for a conductor to attenuate a field. Earth/bonding may still be required for safety, ESD current control or a specified installation.

TI’s enclosure guidance identifies cables, holes and slots as the residual paths once fields are contained by a metal chassis and emphasizes an RF-current view of the shield. [TI SZZA009](https://www.ti.com/lit/an/szza009/szza009.pdf). Treat its component values and dimensional rules as application-note examples, not universal requirements.

## 5. Measurement and pre-compliance

### 5.1 Formal compliance versus engineering measurements

| Activity | Purpose | Can it establish legal conformity? |
|---|---|---|
| Oscilloscope probing | Observe switching edges, ringing, rail noise and victim response. | No. Probe loop/ground can create or hide RF behavior. |
| Near-field E/H scan | Localize board structures and compare revisions. | No. It is a relative diagnostic unless a specific standardized method says otherwise. |
| Cable current probe | Find CM current and correlate cable radiation. | Usually diagnostic; only formal if the applicable method defines it. |
| Bench/parking-lot antenna sweep | Rank peaks and modifications. | No. Ambient signals, reflections, distance and antenna factors limit correlation. |
| LISN plus spectrum analyzer | Pre-scan terminal noise using defined source impedance. | Pre-compliance only unless the entire prescribed method, receiver, setup and records are satisfied. |
| Accredited/recognized laboratory test | Execute the selected standard and authorization route. | Evidence of conformity within that route; legal responsibility still rests with the defined responsible economic operator. |

Tektronix explicitly distinguishes pre-compliance from formal testing: pre-compliance may use noncompliant equipment/sites with adequate margin, whereas compliance requires prescribed methods, equipment and sites. [Tektronix low-cost pre-compliance note](https://www.tek.com/en/documents/application-note/low-cost-emi-pre-compliance-testing-using-spectrum-analyzer).

### 5.2 Conducted-emission setup

A defensible mains-port pre-scan generally includes:

1. the EUT in worst-case normal modes with representative peripherals and load;
2. the correct artificial network—often a LISN/AMN—for the port and standard, bonded/configured as prescribed;
3. measurement of each required conductor/port with a calibrated receiver or analyzer, transient protection, attenuation and correction factors;
4. the required reference ground plane, EUT-network spacing, cable arrangement and termination;
5. a peak scan to find candidates, followed by the specified quasi-peak/average or other detector measurements;
6. ambient/noise-floor checks with the EUT off and a record of overload/compression checks;
7. CM/DM separation when debugging, without substituting that diagnostic for the mandated terminal measurement.

The FCC example is tightly scoped: for covered AC-powered Class B digital devices, 47 CFR 15.107 specifies 150 kHz–30 MHz terminal measurements with a 50 µH/50 Ω LISN and both quasi-peak and average limits. Battery-only equipment that cannot operate while connected to AC does not require that conducted test under §15.107(d), but radiated requirements may remain. [Current 47 CFR Part 15 Subpart B](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-B).

**Safety:** a mains LISN exposes hazardous voltage and can deliver damaging transients to an analyzer. Use rated equipment, bonding, protective devices and a trained operator; follow the LISN/analyzer manufacturer’s connection and discharge procedure. A research dossier is not a mains-test work instruction.

### 5.3 Radiated-emission setup

A formal setup is standard-specific, but typically controls:

- validated OATS, semi-anechoic or fully anechoic site and its usable frequency range;
- EUT support/table, ground plane and representative auxiliary equipment;
- antenna family and calibration/antenna factor, cable loss, preamplifier gain and receiver bandwidth/detector;
- prescribed distance, azimuth search, antenna polarization and height scan where required;
- exact cable arrangement, excess-cable treatment, I/O activity and software mode;
- below/above-1 GHz differences, including site absorbers and peak/average treatment where applicable;
- ambient identification and substitution/retest when a broadcast or cellular signal masks the EUT.

CISPR 16-2-3 defines radiated-disturbance methods over 9 kHz–18 GHz as a basic standard; a product standard selects the applicable subset and limits. [IEC CISPR 16-2-3](https://webstore.iec.ch/en/publication/25877). For US Part 15 unintentional radiators, the FCC KDB points to ANSI C63.4-2014, with specified exclusions, rather than allowing an arbitrary CISPR setup. [FCC KDB 300643](https://apps.fcc.gov/oetcf/kdb/forms/FTSSearchResultPage.cfm?id=21079&switch=P).

### 5.4 Immunity setups and monitoring

The IEC 61000-4 series contains **basic methods**, not an automatic test plan for every product. The applicable product/product-family or generic standard chooses ports, levels, dwell, modulation, performance criteria and configuration.

- **Radiated RF immunity (IEC 61000-4-3):** calibrated field, defined uniform area, antenna/chamber, frequency sweep and modulation; monitor EUT functions without introducing a new coupling path. The IEC says product committees choose whether it applies and choose levels/criteria. [IEC 61000-4-3:2020](https://webstore.iec.ch/en/publication/59849).
- **Conducted RF immunity (IEC 61000-4-6):** coupling/decoupling network, EM clamp or current-injection device applies RF common-mode disturbance to selected cables/ports. The current base edition covers 150 kHz–80 MHz and permits product committees to extend the methods to 230 MHz. [IEC 61000-4-6:2023](https://webstore.iec.ch/en/publication/65586).
- **ESD (IEC 61000-4-2):** direct/indirect, contact/air discharge with specified generator, points, setup and calibration. The current IEC 61000-4-2:2025 is a basic publication; an older edition may still be the legally harmonized/adopted edition in a given scheme. [IEC 61000-4-2:2025](https://webstore.iec.ch/en/publication/68954).
- **EFT/burst (IEC 61000-4-4):** repetitive fast transients on supply, signal, control and earth ports through the prescribed coupling. [IEC 61000-4-4:2012](https://webstore.iec.ch/en/publication/4222).
- **Surge (IEC 61000-4-5):** unidirectional switching/lightning-related surges; it is not a direct-lightning or insulation-withstand test. [IEC 61000-4-5:2014](https://webstore.iec.ch/en/publication/4223).

Define monitors before testing: error counters, link retries, ADC error, motor state, display corruption, watchdog/reset cause, stored-data integrity, output safety state, thermal protection and recovery. “It did not visibly crash” is not an immunity criterion.

## 6. Source-scoped numeric facts

Numbers below are examples whose scope is explicit. They must not be copied into a generic rule deck.

| Number | Exact source scope | Use and limitation |
|---|---|---|
| 150 kHz–30 MHz, 50 µH/50 Ω LISN | US 47 CFR 15.107, covered AC-line conducted emissions for digital devices | Not a universal definition of conducted EMI; exceptions and other port methods exist. |
| Class B AC mains limits: 66→56/56→46 dBµV at 0.15–0.5 MHz; 56/46 at 0.5–5 MHz; 60/50 at 5–30 MHz (QP/average) | US 47 CFR 15.107(a) | Verify current rule, device class, band-edge rule and prescribed measurement method. |
| 100, 150, 200, 500 µV/m at 3 m for 30–88, 88–216, 216–960, and >960 MHz | US 47 CFR 15.109(a), Class B unintentional radiators | Sections 15.33/15.35 and the accepted procedure determine highest frequency, detector and details. |
| 0.15–30 MHz mains conducted and 30 MHz–1 GHz radiated tables | Canada ICES-003 Issue 7 for covered ITE/digital apparatus | ICES-003 allows either its specified CISPR or ANSI method, but requires all measurements to use one selected specification. Do not mix tables/methods. |
| 9 kHz–30 MHz | CISPR 16-2-1’s special scope for conducted disturbance methods | A methods-standard scope, not a product limit or proof that conduction stops at 30 MHz. |
| 9 kHz–18 GHz | CISPR 16-2-3 radiated-method scope | Product standards select required bands and limits. |
| `R > 2D²/λ` | Common far-field antenna-range criterion cited by Keysight | Not a replacement for a prescribed EMC site or distance. |
| `E ≈ 263×10⁻¹⁶ f²AI/r` | TI/Ott electrically small-loop estimate | Trend model only; use units and assumptions stated above. |
| “0.1 µF at every IC” | Anchor article heuristic | No universal validity. Replace with device/PDN requirements and impedance validation. |

Canada’s exact tables and scope are available in [ISED ICES-003 Issue 7](https://ised-isde.canada.ca/site/spectrum-management-telecommunications/en/devices-and-equipment/interference-causing-equipment-standards-ices/ices-003-information-technology-equipment-including-digital-apparatus).

## 7. Debugging workflow

### Phase A — freeze the evidence

1. Record product revision, BOM substitutions, enclosure state, cable types/lengths, loads, power source, firmware, ambient conditions and test setup.
2. Reproduce the required worst-case modes. Exercise every relevant port; include maximum switching load, radio transmit/receive states, display/data patterns, motor states and sleep/wake transitions.
3. Save raw traces and receiver settings. Record limit, detector, bandwidth, transducer factors and margin separately from the observed amplitude.
4. Correlate suspect peaks with fundamentals, harmonics, beat products and ringing frequencies. A peak disappearing when a block is disabled is evidence, not yet proof of its radiation path.

### Phase B — classify the path and mode

1. Compare radiated antenna, near-field E/H probe and cable-current spectra.
2. Disconnect or replace one external cable at a time only when safe and functionally representative. If a clamp ferrite around the entire cable changes the distant antenna peak, CM cable current is implicated.
3. Rotate/reposition the cable and enclosure. Large movement sensitivity suggests a cable/enclosure antenna; a fixed local H-field hotspot suggests a current loop.
4. For conducted failures, separate CM and DM components using an appropriate network or current-probe method.
5. For immunity, reduce the stimulus to find a repeatable threshold and identify the exact affected port/function. Check whether RF is being demodulated into a low-frequency analog/control path.

### Phase C — perform reversible A/B experiments

- temporary series resistance or slower slew at the suspected source;
- a correctly sized snubber after waveform measurement;
- a short low-inductance temporary chassis bond or shield bridge;
- copper tape over a seam with safe bonding;
- a clamp ferrite on a whole cable for CM diagnosis;
- temporary balanced input capacitance or feedthrough filtering at the boundary;
- alternate cable shield termination;
- local decoupling/commutation capacitor position change;
- controlled return-path bridge where safety isolation is not involved.

Change one variable at a time and record the delta at the failing frequency plus adjacent bands. A fix that moves the peak or breaks signal integrity is not a completed fix.

### Phase D — implement the root-cause correction

Prefer, in order:

1. reduce energy at the source (slew/ringing/current loop);
2. remove mode conversion and close the intended return path;
3. block/divert energy at the port boundary with a mode-correct filter;
4. improve cable/shield/enclosure current continuity;
5. add bulk shielding only after penetrations and seams have a defined treatment.

Then repeat all operating modes and tests, not only the failed point. Re-check thermal behavior, timing, SI/PI, safety isolation, leakage, ESD discharge path and other jurisdictions. Maintain design margin for production, cable and environmental variation; the target margin is a project risk decision, not a universal dB number.

## 8. Legal and standards context — separate from design guidance

This section is informational, not legal advice. A PCB manufacturer’s blog, a successful pre-scan, or conformity of a radio module does not determine the finished product’s legal route.

### 8.1 Jurisdiction matrix

| Market | What the cited regime establishes | What must not be inferred |
|---|---|---|
| United States | 47 CFR Part 15 Subpart B covers unintentional radiators, with SDoC or certification categories, exemptions, conducted/radiated emission limits and user information. FCC KDB 300643 identifies ANSI C63.4-2014 for unintentional-radiator measurements. | No general Part 15 B immunity requirement. A certified radio module does not automatically authorize the host’s digital circuitry, enclosure/cables, RF exposure or all transmitter conditions. |
| EU/EEA | Directive 2014/30/EU requires both controlled disturbance and adequate immunity, an EMC assessment over representative configurations, technical documentation, EU declaration and CE marking. Radio equipment is generally handled under Directive 2014/53/EU, whose Article 3(1)(b) incorporates an EMC objective. | CE is not a test-house “certificate” in the usual self-declaration route. Passing one generic standard is not automatically enough; applicable Union legislation and product standards must be selected. |
| Great Britain | The Electromagnetic Compatibility Regulations 2016 have corresponding emission/immunity essential requirements and documentation/declaration duties. Current UK guidance says certain products meeting EU requirements and CE marked may be placed on the GB market indefinitely; NI follows separate rules. | Do not use stale “CE ends on date X” statements or assume GB, NI and EU marking routes are identical. Check current guidance when placing product. |
| Canada | ICES-003 Issue 7 sets emission limits, methods and administrative requirements for covered ITE/digital apparatus. It permits the specified Canadian CISPR 32 adoption or ANSI C63.4 route, used consistently. | ICES-003 is not a general immunity certification. Radio functions and other product sectors can invoke RSS or other requirements. |
| Australia | ACMA’s Radiocommunications (EMC) arrangement mandates applicable **emission** standards, compliance evidence/records and RCM-related supplier obligations by compliance level. ACMA explicitly says it mandates only performance requirements related to emissions within its EMC standards list. | “EMC” in the arrangement does not mean ACMA imposes generic immunity tests. Electrical safety, radio, EME exposure and telecom rules are separate possible overlays. |
| New Zealand | RSM’s EMC Standards Notice assigns product classes/conformity levels; suppliers keep evidence and, where required, an SDoC and labeling. | Do not transplant Australian paperwork without checking the mutual-recognition conditions and current NZ notices. |
| Japan, VCCI route | VCCI is a **voluntary-control** scheme for member-supplied multimedia equipment, based on VCCI-CISPR 32 emissions, registered facilities, conformity reporting and marking. | A VCCI mark is not a universal Japanese legal approval, not an immunity claim, and not the route for every radio, ISM, automotive or regulated product. |

Primary/current references: [FCC Part 15 B](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-B), [EU EMC Directive](https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1591611078730&uri=CELEX%3A32014L0030), [EU RED](https://eur-lex.europa.eu/eli/dir/2014/53/oj/eng), [UK government EMC guidance](https://www.gov.uk/government/publications/electromagnetic-compatibility-regulations-2016/electromagnetic-compatibility-regulations-2016-great-britain), [ISED ICES-003](https://ised-isde.canada.ca/site/spectrum-management-telecommunications/en/devices-and-equipment/interference-causing-equipment-standards-ices/ices-003-information-technology-equipment-including-digital-apparatus), [ACMA technical standards](https://www.acma.gov.au/technical-standards), [NZ RSM standards step](https://www.rsm.govt.nz/business-individuals/supplier-compliance/steps/step1-meet-standards), and [VCCI conformity flow](https://www.vcci.jp/english/general/flow.html).

### 8.2 Selecting standards without creating false compliance

Use this precedence:

1. identify every function and legal instrument: unintentional digital, intentional radio, mains appliance, medical, automotive, machinery, lighting, measurement/control, etc.;
2. choose a dedicated product or product-family standard when its scope applies;
3. use a generic environmental standard only when no applicable dedicated standard exists;
4. select the edition accepted by the target jurisdiction—not automatically the latest IEC edition;
5. map each enclosure, AC/DC power, signal/control, wired-network and antenna port to tests;
6. define intended environment and performance criteria;
7. verify documentation, responsible party, marking, laboratory and surveillance requirements.

Common families, with scope caveats:

- [CISPR 32](https://webstore.iec.ch/en/publication/30056) is an emission standard for multimedia equipment; it excludes intentional transmitter emissions and equipment covered more specifically elsewhere.
- [CISPR 35](https://webstore.iec.ch/en/publication/25667) addresses multimedia-equipment immunity.
- [IEC 61000-6-1](https://webstore.iec.ch/en/publication/25631) and [IEC 61000-6-2](https://webstore.iec.ch/en/publication/25630) are generic immunity standards for residential/commercial/light-industrial and industrial environments when no dedicated standard exists.
- [IEC 61000-6-3:2026](https://webstore.iec.ch/en/publication/71262) and [IEC 61000-6-4:2018](https://webstore.iec.ch/en/publication/26622) are generic residential and industrial emission standards with the same “only if no dedicated standard” principle. The 2026 edition’s existence does not prove it is already harmonized or accepted in every market.
- [IEC 60601-1-2:2014+A1:2020](https://webstore.iec.ch/en/publication/59644) ties medical EMC to basic safety and essential performance. Consumer-style pass criteria are inadequate for a medical function.
- [UN Regulation No. 10](https://unece.org/transport/vehicle-regulations-wp29/standards/addenda-1958-agreement-regulations-0-20) and the [ISO 11452 component-immunity family](https://www.iso.org/ics/43.040.10/x/) illustrate automotive-specific routes; vehicle/OEM requirements can exceed generic consumer tests.
- [MIL-STD-461](https://quicksearch.dla.mil/qsDocDetails.aspx?ident_number=35789) is for DoD equipment/subsystem interface and verification requirements in its stated procurement scope, not a general commercial certification shortcut.

### 8.3 Documentation package

At minimum, retain:

- product and variant definitions, intended use/environment and responsible party;
- standards/applicability rationale with edition and jurisdiction;
- schematics, PCB/stackup, BOM, enclosure/cables/accessories and production-critical EMC parts;
- firmware/software test version and mode-control procedure;
- risk assessment, performance criteria and failure classifications;
- accredited/formal reports plus raw pre-compliance evidence and deviations;
- change-control triggers for retest: clock/slew, silicon/package, filter/protection parts, stackup, cable, enclosure/coating/seams, PSU, radio/antenna and firmware mode.

## 9. Worked failure patterns

### 9.1 Buck converter passes on bench, fails radiated with a cable attached

**Mechanism:** hot-loop ringing capacitively couples into a reference plane or cable port; CM current then flows on the external cable, which is the efficient radiator.  
**Evidence sequence:** scope switch-node ringing with a low-inductance probe; H-probe hot loop; cable current probe; distant antenna; whole-cable clamp ferrite A/B.  
**Fix candidates:** reduce commutation-loop ESL, shrink switch-node coupling area, damp ringing, correct connector return/filter.  
**Wrong fix:** enlarge random ground pour or add a differential inductor without verifying CM current.

### 9.2 Fast clock crosses a plane split

**Mechanism:** return current detours or uses stray interplane capacitance; shared impedance creates CM voltage that drives an I/O cable.  
**Fix:** reroute over continuous reference, relocate split, or provide a deliberate return transition when the two references are allowed to couple.  
**Exception:** crossing a mandated isolation gap is not repaired with a normal stitching capacitor; use an approved isolation/EMC architecture.

### 9.3 USB/Ethernet pair is length matched but radiates

**Mechanism:** asymmetric pads/vias, reference void, connector launch or protection/filter components convert DM into CM. Geometric length equality alone does not preserve balance.  
**Evidence:** mixed-mode TDR/S-parameters when available, pair skew, CM cable current, A/B with choke/protection population.  
**Fix:** restore symmetry and reference continuity; choose a choke with compatible differential channel performance; control shell/chassis bond.  
**Wrong fix:** add long meanders to one conductor without measuring the channel.

### 9.4 Metal enclosure still fails

**Mechanism:** slot-like seam, display opening, poorly bonded coating, connector shell pigtail or unfiltered cable penetration interrupts shield current.  
**Evidence:** close-spaced antenna and current probe; copper-tape seam test; rotate antenna polarization and cable.  
**Fix:** improve conductive seam/bond/fasteners/gasket and entry treatment.  
**Wrong inference:** “the enclosure is grounded, therefore shielding is complete.”

### 9.5 Isolated RS-485 system

**Mechanism:** converter barrier capacitance drives CM current between isolated domains; the two planes and cable form a dipole.  
**Fix space:** minimize domain antenna area, add mode-correct ferrites, or provide safety-approved stitching capacitance/transformer strategy while preserving creepage, clearance and leakage. TI and ADI show this system-level mechanism in isolated products. [TI SLLA561](https://www.ti.com/document-viewer/lit/html/SLLA561) and [ADI AN-1349](https://www.analog.com/en/resources/app-notes/an-1349.html).  
**Wrong fix:** connect grounds directly and defeat isolation.

### 9.6 Battery-only digital product

**Legal nuance:** under FCC §15.107(d), a device that only uses battery power and cannot operate from AC while connected may avoid the AC conducted-emission measurement. It can still be an unintentional radiator subject to radiated limits and authorization. Adding “operate while charging” can change the test obligation.  
**Design nuance:** absence of a mains cable does not remove CM paths through USB, sensors, a user, chassis or test equipment.

## 10. AI layout and review contract

### 10.1 Required inputs

An AI must request or mark missing:

1. **Market and product classification:** countries, user environment, intentional radios, medical/automotive/safety function, applicable standards and editions.
2. **Functional configuration:** worst-case modes, firmware, clocks, edge-rate settings, converters, motors/relays, loads, peripherals and recovery criteria.
3. **Schematic/net intent:** source and load pins, termination, protection/filter topology, isolation barriers, chassis/PE/functional-earth strategy, no-connect intent.
4. **Stackup:** material, finished copper, dielectric thickness/`Dk`/loss, plane assignments, impedance requirements and fabrication tolerances.
5. **Placement/routing geometry:** board outline, layer shapes/voids, pad/via geometry, return vias, high-current paths, switch nodes and copper zones.
6. **PDN data:** rail transients or current spectrum, target impedance/ripple, capacitor model/derating, mounting inductance and regulator stability constraints.
7. **Interfaces:** protocol, impedance/skew/loss budget, connector pinout/footprint, ESD/CMC models, cable length/type/shield/termination and external ground paths.
8. **Mechanical system:** enclosure material/coating, seams/fasteners/apertures, heatsinks, displays, shield cans, cable entry and bond points.
9. **Test evidence:** spectra/raw data, detector/RBW/VBW, correction factors, site/distance, cable arrangement, operating state, limits/margin and known failures.
10. **Safety/manufacturing constraints:** creepage/clearance, insulation class, PE, leakage/touch-current limit, safety capacitors, thermal limits and permitted BOM changes.

Without these inputs, report **risk and unknowns**, not compliance.

### 10.2 Mandatory review rules

The AI shall:

- construct a source-path-victim table for every consequential net/block;
- trace each high-`dI/dt` loop for every switch state, including capacitor return;
- trace each high-edge-rate signal’s reference continuously and flag every void/split crossing;
- require a local return transition at signal-layer changes and explain the reference relationship;
- distinguish signal return, chassis, PE and functional earth; never merge them from labels alone;
- inventory external ports and verify clean/dirty boundary placement, return and no coupling around filter/protection;
- inspect differential pairs for **symmetry**, reference, launch and mode conversion, not only length/spacing;
- inspect isolated domains as CM-driven antenna structures while preserving safety barriers;
- evaluate PDN parts by impedance/loop/derating, not nominal `0.1 µF` counts;
- flag large high-`dV/dt` copper and large high-`dI/dt` loop area with thermal/clearance tradeoffs;
- check shield seams, apertures, connector shells and cable termination as a current-continuity system;
- distinguish DM and CM countermeasures and state when the mode is unverified;
- attach every numeric threshold to source, scope, edition, units and measurement conditions;
- rank findings by likely severity and evidence, and state a falsifiable A/B test;
- propagate any fix through SI, PI, thermal, isolation, leakage, ESD and regulatory checks;
- refuse to declare “FCC/CE/EMC compliant” from PCB geometry or simulation alone.

### 10.3 Prohibited shortcuts

Do not:

- use 30 MHz as a hard physics boundary;
- infer spectrum from clock frequency without edge/ringing information;
- call a via fence a shield without reference, spacing and enclosure context;
- require four layers categorically or approve two layers categorically;
- split analog and digital ground by label alone;
- equate nominal capacitance with high-frequency decoupling;
- use a ferrite bead/choke without bias, saturation, differential loss and impedance-over-frequency data;
- recommend a Y capacitor or ground bridge across isolation without safety authority;
- treat module approval, vendor evaluation-board results or a passed pre-scan as finished-product conformity;
- mix limits, detectors, distances or methods from different standards to manufacture a pass.

### 10.4 Finding format

Each AI finding should contain:

`Observed geometry/evidence → inferred source/path/victim → applicable requirement or heuristic → confidence → consequence → minimal A/B test → candidate fix → cross-domain risks → verification required`

Use these evidence labels:

- **Requirement:** literal law, adopted standard, interface specification or safety rule.
- **Verified design fact:** derived from the actual schematic/layout/BOM/measurement.
- **Heuristic:** generally useful but configuration dependent.
- **Inference:** plausible mechanism needing an A/B test.
- **Unknown/blocker:** missing input prevents a defensible conclusion.

## 11. Claim-to-source ledger

Accessed 2026-09-06. Standards pages often expose scope and edition metadata but not the purchased normative text; exact setups/limits must be checked in the adopted standard. “Current” below means current at access within the cited page, not universal legal adoption.

| ID | Source; publisher/author; date | Claims supported and access note |
|---|---|---|
| S01 | [EMI vs EMC: A Full Guide to Detailed Comparison](https://jlcpcb.com/blog/emivsemc); JLCPCB; 2025-12-08 | Anchor article claims, examples, layout heuristics and publication metadata. Commercial blog, not a regulator or normative standard. |
| S02 | [Recommendation ITU-T K.114](https://www.itu.int/epublications/en/publication/itu-t-k-114-2022-08-electromagnetic-compatibility-requirements-and-measurement-methods-for-digital-cellular-mobile-communication-base-station-equipmen); ITU; 2022-08 | IEC-derived definitions of emission, disturbance, interference and immunity. Primary intergovernmental recommendation. |
| S03 | [Directive 2014/30/EU](https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1591611078730&uri=CELEX%3A32014L0030); European Parliament/Council; 2014-02-26, current consolidated view available | EU scope, essential emission/immunity requirements, EMC assessment, technical documentation, declaration and CE marking. Official legal text. |
| S04 | [47 CFR Part 15 Subpart B](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-15/subpart-B); FCC/eCFR; current through 2026-09-03 at access | US authorization categories, exemptions, user notices, §15.107 conducted and §15.109 radiated limits. eCFR is authoritative but officially described as unofficial continuously updated edition. |
| S05 | [FCC KDB 300643](https://apps.fcc.gov/oetcf/kdb/forms/FTSSearchResultPage.cfm?id=21079&switch=P); FCC OET; 2018-07-12 | Accepted Part 15 measurement procedures, ANSI C63.4-2014 for unintentional radiators. KDB is guidance, not itself a rule. |
| S06 | [ICES-003 Issue 7](https://ised-isde.canada.ca/site/spectrum-management-telecommunications/en/devices-and-equipment/interference-causing-equipment-standards-ices/ices-003-information-technology-equipment-including-digital-apparatus); ISED Canada; 2020-10-15 | Canadian ITE/digital apparatus emission scope, Class A/B limits, test-method alternatives and no-mixing condition. Official regulator publication. |
| S07 | [EU harmonised EMC standards page](https://single-market-economy.ec.europa.eu/single-market/goods/european-standards/harmonised-standards/electromagnetic-compatibility-emc_en); European Commission; live page | OJEU publication gives standards harmonized status; summary list is informational and later decisions can modify it. Official Commission guidance. |
| S08 | [EMC Regulations 2016: Great Britain](https://www.gov.uk/government/publications/electromagnetic-compatibility-regulations-2016/electromagnetic-compatibility-regulations-2016-great-britain); UK OPSS/DBT; updated 2025-03-24 | GB essential requirements, economic-operator duties, documentation retention and current CE/UKCA policy. Official guidance; legislation remains controlling. |
| S09 | [ACMA technical standards](https://www.acma.gov.au/technical-standards); ACMA; updated 2025 | Australian applicable EMC standards architecture and emissions-only focus. Official regulator guidance. |
| S10 | [ACMA step 2: show compliance](https://www.acma.gov.au/step-2-show-your-product-complies); ACMA; live page | Compliance levels, testing/evidence and accredited-body distinctions. Official regulator guidance. |
| S11 | [RSM step 1: meet standards](https://www.rsm.govt.nz/business-individuals/supplier-compliance/steps/step1-meet-standards) and [step 4: SDoC](https://www.rsm.govt.nz/business-individuals/supplier-compliance/steps/step-4); New Zealand RSM; live pages | NZ notices, conformity levels, SDoC and Australia mutual-recognition caveat. Official regulator guidance. |
| S12 | [How to Practice Voluntary Control](https://www.vcci.jp/english/general/flow.html); VCCI Council; date not shown | Voluntary member scheme, CISPR 32-based emissions, registered facilities, report/marking process and exclusions. Scheme owner. |
| S13 | [CISPR 32:2015+A1:2019](https://webstore.iec.ch/en/publication/30056); IEC; 2015/2019 | Multimedia-equipment emission scope and exclusion of intentional transmission. Official standards catalog metadata. |
| S14 | [CISPR 35:2016](https://webstore.iec.ch/en/publication/25667); IEC; 2016-08-16 | Multimedia-equipment immunity scope. Official standards catalog metadata. |
| S15 | [IEC 61000-6-1:2016](https://webstore.iec.ch/en/publication/25631); IEC; 2016-08-10 | Generic residential/commercial/light-industrial immunity, only absent a dedicated standard. |
| S16 | [IEC 61000-6-2:2016](https://webstore.iec.ch/en/publication/25630); IEC; 2016-08-10 | Generic industrial immunity and precedence caveat. |
| S17 | [IEC 61000-6-3:2026](https://webstore.iec.ch/en/publication/71262); IEC; 2026-04-07 | Current generic residential emission scope and “no dedicated standard” rule. Does not establish adoption in any jurisdiction. |
| S18 | [IEC 61000-6-4:2018](https://webstore.iec.ch/en/publication/26622); IEC; 2018-02-07 | Generic industrial emission scope and frequency coverage. |
| S19 | [IEC 61000-4-2:2025](https://webstore.iec.ch/en/publication/68954); IEC; 2025-03-07 | ESD method scope, setup/calibration content and product-committee selection caveat. |
| S20 | [IEC 61000-4-3:2020](https://webstore.iec.ch/en/publication/59849); IEC; 2020-09-08 | Radiated RF immunity method, uniform method intent and product-committee responsibility. |
| S21 | [IEC 61000-4-4:2012](https://webstore.iec.ch/en/publication/4222); IEC; 2012-04-30 | EFT/burst purpose, ports and method elements. |
| S22 | [IEC 61000-4-5:2014](https://webstore.iec.ch/en/publication/4223); IEC; 2014-05-15 | Surge purpose and explicit exclusions of direct lightning/insulation withstand. |
| S23 | [IEC 61000-4-6:2023](https://webstore.iec.ch/en/publication/65586); IEC; 2023-06-06 | Conducted RF immunity method family, 150 kHz–80 MHz base scope and optional method extension to 230 MHz by product committees. Jurisdiction/product standard still selects the adopted edition. |
| S24 | [CISPR 16-2-1:2014+A1:2017](https://webstore.iec.ch/en/publication/60987); IEC; consolidated 2017-06-30 | Conducted disturbance methods, especially 9 kHz–30 MHz, and basic-standard status. |
| S25 | [CISPR 16-2-3:2016+A1:2019+A2:2023](https://webstore.iec.ch/en/publication/25877); IEC; consolidated edition metadata | Radiated disturbance methods from 9 kHz–18 GHz and measurement-uncertainty references. |
| S26 | [ANSI C63.4-2014](https://standards.ieee.org/ieee/C63.4/5841/); IEEE/ASC C63; 2014, reaffirmed 2025 | Standard title/scope, active status and covered conducted/radiated concepts. Purchased text contains normative method. |
| S27 | [Low-cost EMI pre-compliance testing](https://www.tek.com/en/documents/application-note/low-cost-emi-pre-compliance-testing-using-spectrum-analyzer); Tektronix; date not shown in accessible page | Formal versus pre-compliance distinction, typical radiated/conducted equipment, LISN function and diagnostic workflow. Vendor application note. |
| S28 | [AN-2052 Power Modules and EMI](https://www.ti.com/lit/pdf/snva436); Texas Instruments; 2010, rev. 2013 | Small-loop field estimate and loop-area dependence; formula attributed there to Henry Ott. Vendor application report with assumptions. |
| S29 | [PCB Design Guidelines for Reduced EMI](https://www.ti.com/lit/an/szza009/szza009.pdf); Texas Instruments; revision metadata in PDF | DM/CM illustrations, return/cable/enclosure/shield current guidance. Values are application guidance, not universal limits. |
| S30 | [AN-2020 EMC-Robust PCB Design](https://www.analog.com/en/resources/app-notes/an-2020.html); Analog Devices; date on source page | CM immunity current path and split-ground failure mechanism in an AD7606B system. Device-specific evidence. |
| S31 | [AN-1142 High Speed ADC PCB Layout](https://www.analog.com/en/resources/app-notes/an-1142.html); Analog Devices; date on source page | Why indiscriminate ground splitting raises return inductance and examples of exceptions. Device-family application guidance. |
| S32 | [Separating CM and DM Conducted Emissions](https://www.analog.com/en/resources/analog-dialogue/articles/separating-common-mode-and-differential-mode-emissions-in-conducted-emissions-testing.html); Analog Devices; date on source page | Need to identify conducted mode because mitigation differs; practical separation concept. |
| S33 | [Optimizing a Switching Power Supply Hot Loop](https://www.analog.com/en/resources/analog-dialogue/raqs/raq-issue-207.html); Analog Devices, Sun/Jiang/Zhang; date on source page | Hot-loop ESR/ESL, placement/via studies and diminishing via-count benefit. Device/test-specific measured and simulated examples. |
| S34 | [Unbalanced Twisted Pairs Can Give You the Jitters](https://www.analog.com/en/resources/technical-articles/unbalanced-twisted-pairs-can-give-you-the-jitters.html); Analog Devices; date on source page | Differential/common-mode conversion from asymmetry and skew. Technical article, not a protocol specification. |
| S35 | [Guidelines for EMI Suppression: filters and ground](https://www.murata.com/en-us/products/emc/emifil/library/knowhow/basic/chapter01-p1); Murata; date not shown | Filter placement, low-impedance return and common-impedance coupling. Component-vendor design guidance. |
| S36 | [IEC 60601-1-2:2014+A1:2020](https://webstore.iec.ch/en/publication/59644); IEC; amendment 2020-09-01 | Medical electrical emissions/immunity tied to basic safety and essential performance. |
| S37 | [UN Regulation No. 10](https://unece.org/transport/vehicle-regulations-wp29/standards/addenda-1958-agreement-regulations-0-20); UNECE WP.29; Rev.6 plus amendments listed | Automotive EMC type-approval family and current official document access. |
| S38 | [ISO 11452 catalog](https://www.iso.org/ics/43.040.10/x/); ISO; live catalog | Automotive component narrowband immunity method family and current/withdrawn editions. |
| S39 | [MIL-STD-461 document record](https://quicksearch.dla.mil/qsDocDetails.aspx?ident_number=35789); US DoD ASSIST; current record | DoD subsystem/equipment emission/susceptibility interface and verification scope. Not a commercial market-access regime. |

## 12. Research limitations and stop condition

- The dossier relies on public regulator text, official catalog scope pages and first-party engineering notes. Full normative IEC/CISPR/ANSI/ISO texts are paywalled; it does not reconstruct their copyrighted procedures.
- Jurisdiction coverage is representative, not worldwide. China, South Korea, Taiwan, India, Brazil, Gulf states and sector regulators require product-specific follow-up before market placement.
- Standards and harmonized/designated lists change. Re-check accepted editions, transition dates and amendments at project freeze and before shipment.
- No product, schematic, PCB, enclosure, cables or test data were supplied, so no design-specific compliance conclusion is possible.

Research stopped after the article’s central claims, physics, layout controls, major measurement families, six jurisdictional routes, sector exceptions, worked mechanisms and AI review requirements had primary or first-party support. Further generic application notes would add repetition rather than materially change the conclusions; the remaining gaps are product- and market-specific inputs.

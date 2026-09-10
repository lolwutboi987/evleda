# Signal Integrity (SI) in PCB Layout: Engineering Dossier

**Audience:** PCB-layout engineers and an AI system that must turn schematics, interface requirements, and fabrication data into defensible routing constraints  
**Research date:** 2026-09-06  
**Source under review:** JLCPCB, “Signal Integrity (SI) in PCB Layout,” supplied URL: <https://jlcpcb.com/blog/signal-integrity-si-in-pcb-layout>  
**Evidence status:** The supplied page returned HTTP 404 during this research. A related, currently accessible JLCPCB article retains the short SI guidance—short traces, an unbroken reference plane, and “3W” spacing—but the unavailable page was not treated as evidence for any technical detail. See [source assessment](#1-source-assessment).

## Executive answer

Signal integrity is not a checklist of “short traces,” 45-degree corners, and a universal spacing rule. It is the preservation of enough **voltage margin, timing margin, and receiver decision confidence** at the actual sampling point over process, voltage, temperature, pattern, manufacturing, and measurement variation.

The correct engineering sequence is:

1. Start with the transmitter’s fastest relevant **rise or fall time**, not merely clock or data rate.
2. Compare edge duration with one-way and round-trip interconnect flight time. Transmission-line behavior exists at every length; a threshold is only a tolerated-error heuristic.
3. Define the entire channel—package, pads, traces, vias, connectors, stubs, terminations, reference transitions, and receiver—not just a nominal trace impedance.
4. Preserve a nearby return path and control discontinuities. A “50 Ω trace” does not repair a broken return path, a resonant via stub, a capacitive connector launch, or an unsuitable topology.
5. Select termination from driver impedance, line impedance, receiver behavior, topology, DC loading, and timing—not from a generic resistor value.
6. Treat crosstalk, attenuation, dispersion, skew, and jitter as coupled budget items. More spacing or tighter length matching is not automatically better if it adds vias, serpentine self-coupling, loss, or mode conversion.
7. Validate at the fidelity the risk requires: a transmission-line/IBIS model for ordinary digital nets, extracted and 3-D electromagnetic models for important discontinuities, and protocol-specific channel/eye/BER compliance for serial links.

The practical design objective is therefore not “make the waveform look perfect.” It is “meet the receiver and protocol limits with quantified margin at the required corners.”

## 1. Source assessment

The supplied JLCPCB article was unavailable at the research date. JLCPCB’s accessible [PCB Design Rules and Guidelines](https://jlcpcb.com/blog/pcb-design-rules-best-practices) summarizes SI as avoiding degradation, ringing, overshoot, and errors, then recommends short traces, an unbroken ground reference, and 3W spacing. Those are useful prompts, but they are not self-sufficient design criteria:

- “Short” is undefined until edge rate, propagation delay, topology, and allowed error are known.
- An unbroken reference plane is usually good, but a layer transition still needs a local return-current transition, and intentional isolation barriers are a legitimate exception.
- “3W” is ambiguous unless spacing is defined as edge-to-edge or center-to-center; it also ignores dielectric height, coupled length, layer geometry, victim termination, edge rate, and the required noise margin.
- “Impedance matching” does not normally mean making a high-impedance CMOS receiver equal to the line. A source-series or far-end termination can control reflections while the receiver itself remains high impedance.
- 45-degree bends are not a substitute for channel analysis. A bend is one local discontinuity among packages, pads, vias, connectors, and return-path transitions.

This dossier retains the directionally correct ideas but replaces universal rules with calculations, applicability conditions, exceptions, and verification gates.

## 2. What “signal integrity” means

At a receiver, a digital signal is acceptable when all applicable limits are met:

- **Voltage:** logic-high/logic-low, differential amplitude, common-mode range, overshoot/undershoot, absolute maximum, and noise margin.
- **Time:** setup, hold, pulse width, duty cycle, data-to-clock skew, intra-pair skew, unit-interval opening, and jitter.
- **Link behavior:** bit-error rate (BER), eye mask, channel operating margin, return loss, insertion loss, mode conversion, or other interface-specific metrics.
- **Robustness:** all relevant transmitter/receiver silicon corners, voltage and temperature, stackup and etch tolerances, data patterns, simultaneous aggressors, and component variation.

SI is related to but distinct from power integrity and EMC. Power-distribution impedance can modulate driver timing and thresholds; return-path discontinuities can both corrupt a signal and radiate. A complete design may therefore require co-simulation or at least compatible SI, PI, and EMC assumptions.

## 3. Transmission-line threshold: edge rate versus flight time

### 3.1 The line is always distributed

A PCB trace has per-unit-length resistance, inductance, conductance, and capacitance. The exact transmission-line quantities are

\[
\gamma(\omega)=\alpha+j\beta=\sqrt{(R+j\omega L)(G+j\omega C)}
\]

and

\[
Z_0(\omega)=\sqrt{\frac{R+j\omega L}{G+j\omega C}}.
\]

For a low-loss line over a limited band,

\[
Z_0\approx\sqrt{L/C}, \qquad v_p\approx\frac{1}{\sqrt{LC}}, \qquad t_f=\ell/v_p.
\]

Here, \(t_f\) is one-way flight time and \(\ell\) is physical length. No discontinuous change occurs at a particular length; the question is when a lumped approximation creates unacceptable error.

TI’s [IBIS model, Part 3](https://www.ti.com/lit/an/slyt413/slyt413.pdf) gives a lumped-system heuristic equivalent to

\[
\ell < \frac{v_p t_r}{6}.
\]

Other engineering guidance uses \(v_p t_r/10\), which is more conservative. A weaker round-trip screen asks whether \(2t_f\) is small relative to \(t_r\). These rules answer different questions and must not be presented as a law:

- **1/10 edge length:** conservative “model as a transmission line” trigger.
- **1/6 edge length:** common lumped-versus-distributed approximation boundary.
- **\(2t_f < t_r\):** says a reflected wave returns while the incident transition is still changing; it does **not** prove the reflection amplitude is harmless.

Use the fastest 10–90% rise or fall time that can occur at the selected drive-strength and PVT corner. If only an oscilloscope bandwidth or model ramp is known, document the conversion and its assumptions. Clock frequency alone is unsuitable: a 1 MHz clock with a 300 ps edge can have more severe local reflection behavior than a much faster clock with slower edges.

### 3.2 Edge-rate example

Assume a board delay of 170 ps/in and a 1.0 ns edge:

- Distance traveled during the edge: \(1.0\text{ ns}/170\text{ ps/in}=5.88\text{ in}\).
- 1/10 criterion: 0.588 in (14.9 mm).
- 1/6 criterion: 0.980 in (24.9 mm).
- \(2t_f=t_r\) criterion: 2.94 in (74.7 mm).

A 2 in net therefore fails the conservative 1/10 and 1/6 screens even though its 680 ps round trip is shorter than the 1 ns edge. The right conclusion is **distributed analysis required**, not “safe because the reflection returns before the edge ends.”

Board delay is stackup-dependent. TI gives representative FR-4 values of roughly 140–180 ps/in in [SLYT413](https://www.ti.com/lit/an/slyt413/slyt413.pdf); Intel’s [855PM platform guide](https://www.intel.com/content/dam/doc/design-guide/855pm-chipset-platform-guide.pdf) gives 162 ps/in microstrip and 180 ps/in stripline for its specific stackup and warns that stackup tolerances and coupling require new extraction. Use the fabricator-approved stackup or extracted delay, not a universal FR-4 number.

### 3.3 When a lumped model is still acceptable

A lumped RC or RLC model can be adequate when all electrically significant branches are well below the selected fraction of edge length and the expected error is below the voltage/timing budget. It may also be adequate for a deliberately slew-limited control line even at a high repetition rate. Conversely, a physically short net can require distributed or 3-D analysis if it contains a severe pad/via/connector discontinuity, a resonant stub, or a very fast edge.

## 4. Reflections, overshoot, and ringing

### 4.1 Reflection equations

At a load discontinuity,

\[
\Gamma_L=\frac{Z_L-Z_0}{Z_L+Z_0};
\qquad
\Gamma_S=\frac{Z_S-Z_0}{Z_S+Z_0}
\]

at the source. For a launched step \(V_S\), the first incident-wave amplitude is

\[
V^+=V_S\frac{Z_0}{Z_S+Z_0}.
\]

The first voltage at the load is \(V^+(1+\Gamma_L)\). An ideal open has \(\Gamma=+1\), a short \(-1\), and a matched load 0. The waves continue reflecting between discontinuities, attenuated and reshaped by loss and constrained by real driver/clamp nonlinearities. TI’s [high-speed layout guide](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) and [IBIS-model article](https://www.ti.com/lit/an/slyt413/slyt413.pdf) show this distributed behavior and identify driver impedance, edge rate, receiver impedance/capacitance, line impedance, and delay as required inputs.

### 4.2 Worked lossless example

For a simplified 3.3 V driver with \(Z_S=20\ \Omega\), a 50 Ω line, and a high-impedance load:

- \(V^+=3.3\times 50/(20+50)=2.36\text{ V}\).
- The open load initially doubles the incident wave to 4.71 V.
- \(\Gamma_S=(20-50)/(20+50)=-0.429\), so the returning wave is partially inverted at the source.

This is a teaching model, not a safe prediction of pin voltage. Package inductance, receiver capacitance, ESD clamps, and nonlinear output I/V behavior alter the waveform. Use an IBIS model for a real device.

Adding about 30 Ω at the source makes total source impedance approximately 50 Ω. The launched wave becomes 1.65 V; it doubles to 3.3 V at the high-impedance receiver; and the reflected wave is absorbed when it returns to the matched source. This explains both the benefit and the topology restriction of source-series termination: intermediate taps see the half-amplitude incident plateau before the reflection returns.

### 4.3 Ringing and false switching

“Ringing” is repeated time-domain variation caused by multiple reflections and/or resonant parasitic L-C structures. The interval between repeated features often maps to a round trip between discontinuities, but a measured oscillation can also be package resonance, probe-ground inductance, power/ground bounce, or an unstable active circuit. Ringing matters when it:

- crosses a receiver threshold more than once (double clocking),
- violates minimum high/low pulse width,
- reduces setup or hold time through threshold-crossing shift,
- forward-biases protection structures or exceeds absolute maximum ratings,
- creates pattern-dependent timing or amplitude errors.

Do not diagnose ringing from a single probing setup. Reduce probe loop inductance, check bandwidth and loading, measure at the receiver reference plane when possible, and compare feature timing against channel flight times.

## 5. Crosstalk

Crosstalk is coupled energy from one or more aggressors into a victim through mutual capacitance and mutual inductance. It can appear as near-end crosstalk (NEXT), far-end crosstalk (FEXT), mode conversion, or simultaneous-switching noise coupled through shared return structures.

Magnitude depends on more than trace width:

- edge slew and swing,
- edge-to-edge spacing and dielectric height to the reference plane,
- broadside versus edge coupling,
- parallel coupled length,
- microstrip/stripline and homogeneous/inhomogeneous geometry,
- victim/source/load impedances and termination state,
- same-direction or opposite-direction travel,
- number and timing correlation of aggressors,
- via-field, connector, package, and reference-plane coupling,
- the signal level remaining at the victim receiver.

AMD’s [112 Gbps channel guide](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Crosstalk) emphasizes relative aggressor/victim strength: a strong transmitter-side aggressor next to a heavily attenuated receive path is worse than raw geometric isolation alone suggests. Its protocol-specific 20 dB NRZ and 30 dB PAM4 signal-to-power-sum examples are **not universal PCB rules**; they illustrate why the complete channel and signaling format set the requirement.

### 5.1 Layout controls

- Reduce parallel coupled length, especially near quiet receiver inputs and clocks.
- Increase spacing based on field-solver extraction or a validated stackup-specific rule.
- Keep the trace close to its reference plane when manufacturable; stronger trace-to-plane coupling generally reduces lateral field spread, though it may require a narrower trace and increase conductor loss.
- Avoid routing sensitive receive lanes beside high-swing transmit lanes; pin assignment and layer assignment can matter more than local spacing.
- On adjacent signal layers, use reference planes between them when possible. Orthogonal routing reduces parallel broadside coupling but does not make coupling zero.
- Model BGA breakouts, via fields, AC-coupling footprints, and connectors; trace-only checks can miss the dominant crosstalk source.
- If a guard trace is used, give it a defined reference and dense enough stitching that it does not become a floating or resonant aggressor. Validate it; “add a ground guard” is not a universal cure.

### 5.2 Why 3W is not a specification

The accessible JLCPCB summary recommends 3W spacing, while other sources define W and spacing differently. Even a perfectly defined 3W geometry gives different coupling when dielectric height changes. A better constraint is one of:

- a maximum permitted coupled-noise voltage at the victim,
- a maximum NEXT/FEXT or power-sum crosstalk over the interface band,
- a stackup-specific spacing-versus-coupled-length rule derived from a field solver,
- a protocol/device rule whose exact applicability is documented.

Use a coarse spacing heuristic only for early placement. Convert it to an extracted electrical criterion before release when margin is important.

## 6. Return current and reference continuity

Every signal is a loop. At high frequency, return current follows the path of lowest impedance, usually concentrated on the adjacent reference conductor near the signal because that minimizes loop inductance—not simply the DC-resistance shortest path. A gap, split, void, connector-pin discontinuity, or poorly supported layer change forces the return current to spread or detour, increasing loop area, common-mode conversion, crosstalk, reflection, and radiation.

TI’s [High-Speed Interface Layout Guidelines](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf) instructs designers to avoid plane-split crossings and, when unavoidable, provide a nearby high-frequency stitching path. Analog Devices’ [AN-1142](https://www.analog.com/en/resources/app-notes/an-1142.html) likewise warns that blindly splitting ground increases return inductance. These principles lead to the following rules:

- Route a critical signal over/under a continuous reference plane for its whole path.
- Do not cross a plane void or split unless the reference transition is intentional, modeled, and given a nearby return path.
- When a signal via changes layers but retains the same ground reference, place ground stitching via(s) nearby without violating the signal-via antipad.
- When the reference changes between ground and a power plane, the return transition may require a nearby low-inductance decoupling path between those references. The capacitor value alone is insufficient; mounting inductance and location determine high-frequency effectiveness.
- Through connectors, assign adjacent return pins appropriately and include their inductance/coupling in the channel. Intel’s [Agilex 7 SI guide](https://www.intel.com/programmable/technical-pdfs/683864.pdf) specifically calls for short local connector-ground connections and nearby ground vias in its connector example.
- Keep differential pairs referenced to a plane. Differential current is not guaranteed to remain entirely inside the pair, particularly when the pair is weakly coupled, geometrically asymmetric, or carrying common-mode energy.

**Exceptions:** galvanic-isolation barriers, antenna/RF structures, and deliberate mixed-domain boundaries can require a discontinuity. Do not bridge a safety isolation barrier with an ordinary stitching capacitor. Use the approved safety-rated or embedded structure and preserve creepage/clearance; Analog Devices [AN-1349](https://www.analog.com/en/resources/app-notes/an-1349.html) is an application-specific example.

## 7. Discontinuities: traces, pads, vias, stubs, and connectors

Any local change in the electromagnetic field geometry changes impedance. Important discontinuities include:

- trace neck-downs and width changes,
- bends and meanders,
- solder-mask openings or thickness changes on microstrip,
- component pads and anti-pads,
- test pads and probe points,
- AC-coupling capacitor footprints,
- signal vias, unused pads, and return vias,
- via stubs and branches,
- BGA breakouts and connector launches,
- reference-plane apertures and layer transitions,
- cables, flex transitions, sockets, and mezzanine connectors.

The magnitude of a local reflection is set by the impedance excursion **and its electrical duration**, not impedance tolerance alone. A very short 40 Ω feature in a 50 Ω line may have negligible system impact at one edge rate; a longer or resonant feature may be unacceptable. TDR impedance plots should therefore be read with spatial resolution, system rise time, and channel/eye results—not only peak impedance.

### 7.1 Bends

A right-angle bend adds a small local capacitive/width discontinuity and can concentrate etch geometry. It is not automatically a serious SI or EMI failure. Prefer two 45-degree bends or an arc when routing convenience and fabrication allow, but prioritize reference continuity, topology, and via/connector quality. Simulate bends only when their electrical size or the interface’s return-loss budget makes them material.

### 7.2 Signal vias

A via transition contains barrel inductance, pad/antipad capacitance, coupling to return vias and neighboring signals, and possibly an open stub. A via is not inherently “bad”; it can be engineered as a controlled transition. Optimize:

- drill/barrel and finished-hole geometry,
- pad and unused-pad removal permitted by fabrication rules,
- antipad size and shape by reference layer,
- signal-to-return-via spacing,
- differential-via pitch and symmetry,
- entry/exit trace geometry,
- residual stub length,
- coupling to neighboring vias in a dense field.

AMD’s [via optimization guidance](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Via-Impedance-Optimization) warns that an open via stub creates a quarter-wave insertion-loss notch, approximately

\[
f_{res}\approx\frac{c}{4\ell_{stub}\sqrt{Dk_{eff}}}.
\]

It recommends moving the resonance well above the signal band and evaluating return loss and crosstalk together. Backdrilling, blind/microvias, or routing on a layer near the far end can shorten the stub. Backdrill tolerance and residual stub must be specified with the fabricator.

Example with \(Dk_{eff}=4\): a 1 mm stub gives a first-order resonance near 37.5 GHz; a 5 mm stub gives about 7.5 GHz. Pad capacitance and 3-D geometry shift the real result, so the equation is a screening tool, not sign-off.

### 7.3 Component footprints and connectors

Large surface-mount pads often create excess capacitance. A local reference-plane cutout can compensate, but an unvalidated void can instead create excess inductance or impair return current. AMD’s [SMD footprint optimization](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/SMD-Footprint-Optimization) requires optimizing cutout depth and dimensions rather than applying a fixed void.

For a connector, obtain the manufacturer’s correct pin-mapped S-parameter model across the required band and include launches on both boards when relevant. Verify reference impedance, mixed-mode port order, differential/common-mode conversion, mating configuration, and whether the model includes pads/vias. Ground-pin placement and connector pinout can dominate performance; “controlled-impedance traces up to the connector” is not an end-to-end analysis.

## 8. Termination methods and selection

Termination controls reflections by making a discontinuity look closer to the line impedance over the necessary frequency interval. The correct scheme depends on topology and logic family. TI’s [Design Considerations for Logic Products](https://www.ti.com/lit/an/sdya002/sdya002.pdf), TI’s [AN-903 differential termination comparison](https://www.ti.com/lit/an/snla034b/snla034b.pdf), and Analog Devices’ [AN-1177 LVDS/M-LVDS guide](https://www.analog.com/en/resources/app-notes/an-1177.html) provide first-party examples.

| Method | First-order design | Strength | Main limitations / correct use |
|---|---|---|---|
| Source-series | \(R_s+Z_{driver}\approx Z_0\); place at the driver pin | Low DC power; absorbs returning reflection | Receiver end remains mismatched; waveform settles after a round trip. Poor for intermediate loads, branched clocks, or receivers that must switch on the first incident wave. Driver impedance is nonlinear and PVT-dependent, so tune with IBIS. |
| Far-end parallel | \(R_T\approx Z_0\) to the appropriate reference; place at the line end | Clean first arrival at the receiver; useful for point-to-point and buses terminated at the physical end | DC power and driver-current demand; can alter logic levels. The reference must be quiet. Differential termination is normally across the pair for LVDS-like links. |
| Thevenin / split parallel | \(R_{up}\parallel R_{down}\approx Z_0\), with divider voltage at required bias | Matches and establishes a bias/idle level | Static current, two parts, bias noise, and loading. Use logic-family/protocol values rather than generic 50 Ω. |
| AC (series RC shunt) | \(R_T\approx Z_0\); choose C so termination is effective during transitions | Reduces DC current | Baseline wander, pattern/duty-cycle dependence, RC distortion, extra capacitance. Not automatically suitable for arbitrary data. Intel’s [AN 958 section](https://www.intel.com/content/www/us/en/docs/programmable/683073/current/series-rc-parallel-termination.html) explicitly notes capacitance tradeoffs. |
| Double termination | Source and load both matched | Suppresses both-end reflections and supports RF-style sources | Approximately halves a Thevenin source’s delivered voltage unless the driver amplitude accounts for it; high power. |
| On-die termination | Device-controlled source/load termination | Lower stub and package impact; selectable values in many interfaces | Values, calibration, modes, and PVT behavior are device-specific. Include the exact enabled setting in simulation. |
| Diode/clamp | Limits voltage excursion | Can protect or reduce extreme overshoot | Does not match the line; diode capacitance, inductance, recovery, and injected clamp current may create other failures. Never use as a generic substitute for termination. |

Topology rules:

- Point-to-point LVDS normally uses a differential termination at the receiver equal to the differential channel impedance; [AN-1177](https://www.analog.com/en/resources/app-notes/an-1177.html) uses the usual 100 Ω example.
- A source-series terminated point-to-point CMOS net should have no electrically long branch and generally no intermediate receiver that requires full amplitude on first arrival.
- Multi-drop buses require the interface-prescribed fly-by/daisy-chain or bus termination. A star is not fixed by placing one resistor at the source; every branch creates a junction and stub.
- Place a terminator where the wave must be absorbed. A physically remote resistor connected through a stub is a terminated stub network, not an ideal termination.
- Populate tuning footprints near the intended source/load during prototype design when model uncertainty is meaningful, but do not let the unpopulated pad become a damaging stub on very fast links.

## 9. Loss, dispersion, and intersymbol interference

### 9.1 Metrics

For a 2-port network with matched reference ports:

\[
IL_{dB}=-20\log_{10}|S_{21}|,
\qquad
RL_{dB}=-20\log_{10}|S_{11}|.
\]

This positive return-loss convention means “larger is better.” Some device guides plot \(20\log_{10}|S_{11}|\) as a negative number and say it must be below, for example, −12 dB. Always record the convention; do not compare +12 dB RL with −12 dB S11 as if they were different limits.

### 9.2 Physical loss mechanisms

- **Conductor loss:** DC resistance plus frequency-dependent skin and proximity effects. For a good conductor, first-order skin depth is \(\delta=\sqrt{2\rho/(\omega\mu)}\), about 2.1 µm for copper at 1 GHz under ideal assumptions.
- **Copper roughness:** lengthens and perturbs the current path at high frequency and changes both loss and phase. Rogers’ [copper-properties paper](https://www.rogerscorp.com/-/media/project/rogerscorp/documents/articles/english/advanced-connectivity-solutions/how-copper-properties-impact-pcb-rf-and-high-speed-digital-performance.pdf) reports increased insertion loss and propagation delay and reduced eye opening with rougher copper.
- **Dielectric loss:** increases with frequency and depends on dissipation factor, resin system/content, glass weave, moisture, and the electric-field distribution.
- **Radiation/leakage and discontinuity loss:** normally secondary in a well-referenced PCB trace but important at launches, connectors, gaps, and mode-converting structures.

AMD’s [channel-insertion-loss guidance](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Channel-Insertion-Loss) explicitly decomposes smooth-copper skin loss, roughness loss, and dielectric loss and links their frequency dependence to attenuation and dispersion. Intel’s [Agilex 7 SI guide](https://www.intel.com/programmable/technical-pdfs/683864.pdf) recommends low-loss dielectric and low-profile copper for demanding serial links, but instructs designers to test the design with a VNA.

### 9.3 Dispersion and ISI

If attenuation and phase velocity vary across the signal spectrum, frequency components arrive with different amplitude and phase. The edge broadens; energy from earlier bits extends into later unit intervals; and deterministic, data-dependent jitter appears. This is intersymbol interference (ISI). Tektronix’s [gigabit-interconnect methodology](https://download.tek.com/document/SIGI1203.pdf) connects skin/dielectric loss with rise-time and amplitude degradation and with crosstalk-related pattern-dependent jitter.

For NRZ at bit rate \(R_b\), the Nyquist frequency is \(R_b/2\). For PAM4 carrying two uncoded bits per symbol, symbol rate is approximately half the bit rate and Nyquist is one quarter of the bit rate. This does **not** mean all required channel bandwidth ends at Nyquist: edge shape, equalizer operation, compliance methodology, and discontinuity resonances can require analysis above it. Follow the protocol’s specified frequency range.

Do not select laminate from a single catalog “Dk” and “Df” without frequency, test method, resin content, and construction. Obtain the fabricator’s actual stackup and impedance model, copper profile, finished dimensions, and controlled-impedance tolerance. Use wideband material models for long/high-rate channels.

## 10. Timing, skew, jitter, and eye diagrams

### 10.1 Flight time and skew

One-way delay is \(t_f=D\ell\), where D is extracted delay per unit length. Length mismatch becomes delay mismatch only after accounting for layer-dependent velocity, coupling, vias, package routing, connectors, and glass weave:

\[
\Delta t \approx D\Delta\ell
\]

for otherwise identical routes. At 170 ps/in, 100 mil mismatch is about 17 ps. That is only 1.7% of a 1 ns budget but 17% of a 100 ps UI (10 GBd). Thus “match to 5 mil” and “5% clock period” are not universal requirements.

For a parallel/source-synchronous interface, calculate actual arrival windows:

- data latest = transmitter \(t_{co,max}\) + maximum data-channel delay + data jitter/noise-induced crossing shift;
- data earliest = transmitter \(t_{co,min}\) + minimum data-channel delay − applicable variation;
- sampling-clock earliest/latest = clock launch plus its min/max channel delay and clock jitter;
- compare those windows with receiver setup, hold, duty-cycle, and uncertainty requirements.

Some device vendors have already converted these budgets to validated topology/length rules. Use those exact rules when all stated assumptions match; TI’s [DDR routing-rule report](https://www.ti.com/lit/an/spraav0a/spraav0a.pdf) explains why such vendor constraints can replace customer timing simulation only within their intended design envelope.

### 10.2 Differential intra-pair skew

Skew between P and N reduces differential amplitude and converts differential energy to common mode. Sources include route-length mismatch, asymmetric pads/vias/returns, package mismatch, bends, and glass weave. AMD’s [intra-pair skew guidance](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Skew) identifies these mechanisms; its <1 ps target belongs to its 112 Gbps Versal example and must not be copied to unrelated interfaces.

Intel’s [AN 528 fiber-weave guide](https://cdrdv2-public.intel.com/654621/an528.pdf) explains that one pair member over glass and the other over resin can see different effective permittivity. Mitigations include spread glass, routing at an angle, suitable weave/pair pitch, or panel rotation. AMD also warns that large or tight serpentines can self-couple, so compensation should occur near and on the layer where skew is introduced and should be validated.

### 10.3 Jitter

Jitter is edge-time deviation from the ideal/reference timing. Relevant categories include random jitter, periodic jitter, duty-cycle distortion, data-dependent jitter/ISI, bounded uncorrelated jitter such as crosstalk, and wander. Voltage noise becomes timing jitter through the local slew rate:

\[
\Delta t \approx \frac{\Delta V}{dV/dt}
\]

near the receiver threshold. A slower edge therefore turns the same voltage noise into more time error. Jitter components cannot all be arithmetically added or extrapolated identically; use the protocol’s specified decomposition and BER model. Tektronix’s [jitter characterization note](https://www.tek.com/en/documents/application-note/characterizing-and-troubleshooting-jitter-your-oscilloscope) shows time-interval-error, histogram, spectrum, and decomposition methods and cautions that an apparently open eye can hide a dominant jitter mechanism.

### 10.4 Eye diagrams

An eye diagram overlays waveform segments aligned to a unit interval. It summarizes:

- vertical eye height: amplitude/noise margin,
- horizontal eye width: timing/jitter margin,
- crossing distribution and duty-cycle distortion,
- ISI as pattern-dependent trajectories,
- overshoot, undershoot, and mask violations.

An eye is not a BER guarantee unless the acquisition, clock-recovery model, pattern length, equalization, reference plane, sample count, and statistical extrapolation match the requirement. A scope eye may omit rare events; a simulated eye may omit power noise, crosstalk, or inaccurate models. [Tektronix’s jitter/eye primer](https://www.tek.com/de/documents/application-note/jitter-timing-fundamentals) explains the overlay and eye opening; protocol compliance must still use the protocol’s defined mask and receiver behavior.

## 11. Inputs required before an AI may assign SI rules

An AI should mark missing consequential inputs as **UNKNOWN** and choose a conservative analysis action; it must not invent a target impedance, edge rate, or length-match tolerance.

### 11.1 Interface and acceptance inputs

- Interface/protocol and exact device part numbers/revisions.
- Topology: point-to-point, multi-drop, fly-by, daisy-chain, star, connector/cable path, and all branch lengths.
- Signaling: single-ended/differential, I/O standard, swing, common-mode, encoding, data/symbol/clock rate, direction, half/full duplex.
- Receiver thresholds, hysteresis, setup/hold, mask/BER/channel-compliance limits, allowed overshoot/undershoot, and absolute maximum ratings.
- Required operating PVT, lifetime/reliability conditions, and aggressor activity.

### 11.2 Driver and load inputs

- Fastest and slowest 10–90% rise/fall time at actual drive setting and load.
- Driver output I/V or impedance versus state and PVT; package R/L/C or model.
- Receiver input capacitance, resistance, clamps, thresholds, package model, and on-die termination settings.
- Vendor IBIS model and model selector/corner. The [IBIS Open Forum](https://www.ibis.org/specs/) defines the standard source for behavioral I/O data; model presence is not proof of model quality.
- All discrete terminators, bias networks, AC capacitors, ESD devices, common-mode chokes, sockets, and test structures, including tolerances and parasitics.

### 11.3 Stackup and fabrication inputs

- Fabricator-approved finished stackup: copper layers, reference planes, dielectric thicknesses after lamination, finished copper thickness, trace etch geometry, solder mask, and allowable width/spacing.
- Target single-ended/differential impedance and tolerance **from the interface/device specification or analysis**, not from habit.
- Dk/Df versus frequency and construction/resin content; copper foil type/roughness and surface finish.
- Propagation delay versus layer/mode or data sufficient for a field solver.
- Via drill, finished hole, pad, antipad by layer, unused-pad policy, backdrill side/target/residual-stub tolerance, and aspect-ratio/registration limits.
- Impedance-coupon and TDR test method, test frequency/rise time, acceptance tolerance, and whether coupon geometry truly represents the routed layer.

### 11.4 Interconnect model inputs

- Extracted routed length and coupled length, spacing, neckdowns, bends, reference transitions, and plane voids.
- Package, connector, cable, flex, and socket S-parameters with port map, reference impedance, frequency range, and included geometry.
- Neighboring aggressor nets and switching correlation.
- Simulation corner set, model bandwidth, extrapolation rules, and compliance reference plane.

**Hard stop:** If the AI lacks the actual stackup, fastest edge, topology, or receiver acceptance requirement, it may propose a provisional placement/routing envelope, but it must label the result **not sign-off capable**.

## 12. Simulation and measurement workflow

### 12.1 Model-fidelity ladder

1. **Screening:** calculate flight time/edge ratio, branch electrical lengths, first-order reflection coefficients, delay/skew, and stub resonance.
2. **Pre-layout topology simulation:** use driver/load IBIS plus lossless or wideband transmission lines to compare topology, drive strength, and termination values across corners.
3. **2-D field extraction:** derive impedance, delay, loss, and coupling for uniform trace cross sections from the approved stackup.
4. **Post-layout extraction:** include actual routes, coupled segments, vias, pads, reference changes, and components.
5. **3-D EM extraction:** use for BGA/via fields, connector launches, unusual cutouts, large pads, dense transitions, and any discontinuity that dominates the budget.
6. **End-to-end analysis:** cascade package/interconnect models with IBIS or IBIS-AMI transmitter/receiver behavior, equalization, jitter/noise, and protocol compliance. AMD’s [system-level guidance](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/System-Level-SI-Analysis) calls for both standards-defined channel checks and IBIS-AMI system-margin simulation in its 112 Gbps use case.

### 12.2 Model QA

For every model, verify:

- correct device, pin, drive/ODT setting, voltage, and corner;
- units, reference impedance, differential/common-mode port order, and polarity;
- frequency range high enough for the required edge/compliance band and appropriate low-frequency/DC behavior;
- causality, passivity, reciprocity only where physically expected, and no nonphysical extrapolation;
- no double-counted pad, launch, package, or trace section when cascading;
- correct termination and receiver reference plane;
- correlation to vendor plots, a test coupon, or measured hardware when available.

IBIS provides behavioral buffer I/V, switching, and package information; Touchstone stores n-port network data. The [IBIS specifications page](https://www.ibis.org/specs/) and official [Touchstone 2.1 specification](https://ibis.org/touchstone_ver2.1/touchstone_ver2_1.pdf) are format authorities, not guarantees that a particular vendor model is accurate.

### 12.3 Measurements

| Tool | Best use | Major traps |
|---|---|---|
| TDR/DTDR | Impedance profile, discontinuity location, delay, odd/even/differential/common impedance | Finite rise time limits spatial resolution; launch and fixture obscure the DUT; loss can masquerade as impedance change. |
| TDT | Transmitted step, rise-time degradation, delay, crosstalk | Same fixture/reference-plane issues; a single edge does not exercise all patterns. |
| VNA | S-parameters, insertion/return loss, crosstalk, mode conversion, group delay | Calibration, port mapping, cables/fixtures, dynamic range, and de-embedding quality. |
| Oscilloscope | Receiver-pin waveform, overshoot, threshold crossings, eye and jitter | Probe loading/ground inductance, inadequate bandwidth/sample rate, clock recovery, limited record/pattern, and wrong reference plane. |
| BERT / protocol tester | BER, bathtub, stress tolerance, compliance | Passing one pattern/corner does not prove all system states; setup must match the standard. |

Keysight’s [TDR/TDT application note](https://go.keysight.com/us/en/assets/7018-01461/application-notes/5989-5763.pdf) lists impedance, delay, loss, crosstalk, differential/common impedance, and mode conversion as measurable interconnect properties. Keysight’s [de-embedding guide](https://www.keysight.com/zz/en/assets/7018-08491/application-notes/5989-5765.pdf) explains that calibration moves the instrument reference plane only to the calibration plane; fixture removal requires a valid fixture model or measurement. Never call a measured waveform “at the receiver” if probe/launch/fixture effects have not been bounded.

### 12.4 Correlation loop

1. Put representative coupons and, where practical, calibration/de-embedding structures on the panel.
2. Measure stackup-dependent impedance and delay before blaming the silicon.
3. Compare TDR feature times to physical discontinuities; compare VNA loss and resonance to extracted models.
4. Update material/roughness/via/connector models only with traceable measured evidence.
5. Re-run receiver-waveform/eye/timing analysis with measured interconnect data.
6. Preserve model versions, solver settings, fixture definitions, board revision, serial number, temperature, and instrument calibration metadata.

## 13. Layout rules—with applicability and exceptions

| Rule | Engineering reason | Exception / verification gate |
|---|---|---|
| Use the slowest transmitter slew that still meets timing and protocol limits. | Reduces high-frequency energy, reflection sensitivity, crosstalk, EMI, and voltage-to-time conversion stress. | Some links require fast edges or specified transmitter presets. Verify setup/hold, eye, and BER across PVT. |
| Route critical signals with a continuous adjacent reference. | Keeps return loop small and impedance predictable. | Intentional isolation/RF structures require their own field/safety design. |
| Add a local return transition beside a critical signal via. | Prevents a large return-current detour at a layer change. | Exact via count/location is geometry-dependent; do not intrude into signal antipads. |
| Keep topology simple; shorten branches/stubs first. | Junctions and open stubs cause delayed reflections/resonances. | Multi-drop/fly-by may be prescribed by the interface; simulate the specified topology. |
| Control impedance from the released fabrication stackup. | Width alone does not set impedance; dielectric height, Dk, copper thickness/profile, mask, and coupling matter. | Short electrically lumped nets may not need controlled impedance, but still need acceptable loading/return paths. |
| Keep P/N geometry and reference environment symmetric. | Minimizes skew and differential/common-mode conversion. | Intentional local compensation can be asymmetric; validate in 3-D/channel analysis. |
| Match length only to the derived timing/skew budget. | Excess meander adds loss, discontinuities, and self-coupling. | Vendor routing rules can be used directly when all assumptions match. |
| Separate aggressors based on extracted coupling and coupled length. | Crosstalk is geometry- and topology-dependent. | A documented stackup/protocol rule may replace extraction within its validated range. |
| Avoid unnecessary vias, but optimize required vias. | Each transition can add discontinuity, coupling, and stub. | A well-designed via can be lower risk than a long detour or dense serpentine. |
| Remove or shorten stubs whose resonance/echo enters the analysis band. | Quarter-wave notches and delayed echoes create loss and ISI. | Low-rate/slow-edge nets may tolerate long physical stubs; screen electrically. |
| Place terminations at the electrical source/load/end defined by the scheme. | Placement determines whether the wave sees the intended impedance. | On-die termination or package routing changes the effective location; model it. |
| Keep sensitive RX lanes away from strong TX lanes and clock/switching nodes. | Relative signal strength can make receiver-side crosstalk dominant. | Dense packages may force proximity; use pin/layer assignment and extracted power-sum analysis. |
| Reserve probe/test access without creating a damaging stub. | Validation access is necessary, but a pad/branch is a discontinuity. | Use inline, high-bandwidth fixtures or removable/very short structures for the fastest lanes. |
| Review fabrication tolerances and coupons with the board shop before routing freeze. | Finished geometry, not nominal CAD width, sets impedance and delay. | None for controlled-impedance production; generic calculator output is provisional. |

## 14. Additional worked examples

### 14.1 Length mismatch to timing budget

A source-synchronous group allows 120 ps total PCB skew. Extracted delays are 165 ps/in on the clock layer and 178 ps/in on the data layer. Converting 120 ps to one generic “length match” is invalid because the velocities differ. If both were on the 178 ps/in layer and otherwise identical, 120 ps would correspond to 0.674 in. But vias, package skew, clock/data launch timing, receiver setup/hold, and other uncertainties consume part of that budget. The permitted PCB mismatch must be the **remaining** timing budget, not the whole 120 ps.

### 14.2 Reflection at a local impedance change

A 50 Ω line enters an idealized 40 Ω section. The single-interface reflection coefficient is

\[
\Gamma=(40-50)/(40+50)=-0.111.
\]

That is an 11.1% reflected voltage wave at the interface. It does not by itself predict receiver overshoot or failure: the 40 Ω section length, second interface, loss, edge rate, and phase determine whether the two reflections mostly cancel or reinforce. The correct next step is to model the finite section or inspect its TDR/S-parameters—not to reject the board solely because its instantaneous TDR reaches 40 Ω.

### 14.3 Stub echo timing

A 0.75 in branch on a layer with 170 ps/in delay returns its open-end reflection to the junction after

\[
2(0.75)(170\text{ ps})=255\text{ ps}.
\]

At 2.5 GBd (400 ps UI), that echo lands 0.64 UI later and can create strong data-dependent interference. At a 10 µs control-bit interval with a 10 ns edge, it may fully settle long before sampling. Physical length alone cannot label the stub acceptable or unacceptable.

### 14.4 Voltage noise to timing jitter

If a receiver crossing slew is 0.5 V/ns and coupled noise at the threshold is 50 mV, the first-order crossing shift is

\[
\Delta t\approx 0.05/0.5=0.10\text{ ns}=100\text{ ps}.
\]

If loss slows the edge to 0.25 V/ns, the same noise produces about 200 ps. This shows why attenuation, crosstalk, and jitter cannot be budgeted independently.

## 15. Invalid or incomplete folklore

| Folklore | Corrected statement |
|---|---|
| “Only high-frequency clocks need SI.” | Edge rate and channel electrical length govern reflection/crosstalk sensitivity; low-repetition signals can have fast edges. |
| “A trace becomes a transmission line at 1/6 (or 1/10) edge length.” | It is always distributed. Fractions are tolerated-error heuristics; use the criterion and margin appropriate to the decision. |
| “If round-trip delay is shorter than rise time, ignore reflections.” | Reflections overlap the edge but can still shift thresholds or create overshoot. Their amplitude and receiver margin must be checked. |
| “Match source, trace, and receiver impedance.” | Many digital receivers are intentionally high impedance. Use a termination topology that absorbs waves while meeting voltage, timing, and power constraints. |
| “50 Ω single-ended and 100 Ω differential are always correct.” | Target impedance comes from the I/O standard, device, connector/channel architecture, and system analysis. AMD even documents a 92–93 Ω package/channel optimization example in [XAPP1392](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Optimal-Channel-Nominal-Impedance). |
| “3W spacing prevents crosstalk.” | Coupling also depends on dielectric height, geometry, coupled length, edge, terminations, and aggressor/victim strength. 3W is at most an early heuristic. |
| “Stripline has zero crosstalk.” | Stripline confines fields better than comparable microstrip, but coupled striplines, vias, packages, and connectors still have crosstalk. |
| “Differential signals do not need a ground/reference.” | Real pairs have common-mode current and imperfect coupling; reference continuity and symmetric return transitions remain important. |
| “Route differential traces as close as possible.” | Spacing sets differential impedance, coupling, loss, manufacturability, and breakout feasibility. Use the specified geometry; excessively tight spacing is not automatically best. |
| “Exact length match guarantees zero skew.” | Layer velocity, glass weave, package, via and return asymmetry, and coupling create skew even at equal CAD length. |
| “Add serpentines until lengths match.” | Tight meanders self-couple and add loss/discontinuities. Match only to the timing budget and validate compensation geometry. |
| “Never use 90-degree bends.” | A bend is a local discontinuity whose importance depends on electrical size. Fix severe topology, returns, vias, and connectors first. |
| “Never use vias on high-speed traces.” | Required vias can be impedance-engineered. Stubs, returns, antipads, symmetry, and via-field coupling are the actual concerns. |
| “More ground vias are always better.” | Poor placement can enlarge voids or interfere with signal antipads; current may concentrate in the nearest path. Optimize geometry and return continuity. |
| “A plane is ground only.” | A low-impedance power plane can be an AC reference, but changing references requires a local high-frequency return path and PI verification. |
| “An open eye proves the BER.” | Eye validity depends on acquisition/model statistics, pattern, clock recovery, equalization, noise, and required BER extrapolation. |
| “A TDR impedance coupon proves the channel.” | It checks a representative geometry under a defined rise time; it does not prove connectors, packages, crosstalk, loss, skew, or BER. |
| “Simulation proves the board.” | Simulation is conditional on model fidelity and corners. Correlate critical assumptions with coupons and hardware measurements. |

## 16. AI decision flow

The AI should emit both a decision and its evidence state.

```text
START
  |
  +-- 1. Identify exact interface, devices, direction, topology, acceptance limits.
  |      Missing? -> UNKNOWN / NOT SIGN-OFF CAPABLE; request data.
  |
  +-- 2. Acquire fastest edge, driver/load/package models, enabled drive/ODT.
  |      Only clock/data rate known? -> Do not infer edge from rate.
  |
  +-- 3. Acquire released stackup, delay, Dk/Df, copper, via and connector data.
  |      Generic FR-4 only? -> provisional geometry and tolerance warning.
  |
  +-- 4. Compute one-way/round-trip delay, edge-length ratios, branch echoes,
  |      first-order reflections, delay/skew, and stub resonances.
  |
  +-- 5. Select model fidelity:
  |      electrically tiny + ample margin -> lumped screen;
  |      ordinary fast net -> distributed line + IBIS;
  |      via/connector/dense breakout -> extracted/3-D EM;
  |      high-rate serial -> S-parameter + IBIS-AMI/compliance flow.
  |
  +-- 6. Choose topology and termination from first-arrival requirement,
  |      taps/branches, DC power, bias, and receiver thresholds.
  |
  +-- 7. Generate stackup-specific constraints for impedance, reference,
  |      spacing/coupled length, via/stub, symmetry, and timing/skew.
  |      Never generate universal 3W/5-mil/50-ohm rules without provenance.
  |
  +-- 8. Simulate min/typ/max PVT and fabrication corners with aggressors,
  |      data patterns, jitter/noise, and receiver compliance.
  |      Fail -> change placement/topology first, then geometry/termination.
  |
  +-- 9. Post-layout extract and rerun; check model QA and no double counting.
  |
  +-- 10. Define coupon, TDR/VNA/scope/BERT plan and reference planes.
  |
  +-- 11. Release only if voltage, timing, eye/BER/channel, absolute-max,
         manufacturing, and measurement margins all pass with traceable inputs.
```

### Required AI output schema

For each critical net or interface, record:

- net group and topology;
- source and load pins/models/settings;
- fastest edge and provenance;
- stackup/referenced layer and impedance target/tolerance provenance;
- one-way delay, edge ratio, and model-fidelity decision;
- termination type/value/location and corner sweep;
- maximum branch/stub and resonance/echo screen;
- spacing/coupled-length rule and aggressor set;
- delay/skew budget with unit conversion;
- simulation models, corners, pass/fail metric, and remaining margin;
- post-fabrication measurement plan;
- assumptions, unknowns, confidence, and sign-off status.

## 17. Claim-to-source ledger

All sources below are first-party specifications, semiconductor/vendor application material, laminate-vendor characterization, or instrument-vendor measurement documentation, except JLCPCB’s article under review, which is included only to audit its general rules.

| ID | Consequential claim supported | Primary source and date | Evidence fit / limitation | Confidence |
|---|---|---|---|---|
| C1 | Driver edge rate, line impedance/delay, output impedance, receiver resistance/capacitance, and IBIS data are needed; 1/6 edge-length is a lumped heuristic. | Bonnie Baker, Texas Instruments, [The IBIS model, Part 3](https://www.ti.com/lit/an/slyt413/slyt413.pdf), 2Q 2011. | Direct equations and parameter list; single-ended worked context. | High |
| C2 | Return-current layer transitions, via stubs, and coupled routing require explicit layout treatment. | Texas Instruments, [High-Speed Layout Guidelines, SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf), Nov. 2006, rev. Aug. 2017. | First-party general guide; some statements such as “stripline zero crosstalk” are overbroad and are rejected here. | High for mechanisms; low for universal spacing claims |
| C3 | Plane-split crossings interrupt high-frequency return current; a local stitching path is required if crossing is unavoidable. | Texas Instruments, [High-Speed Interface Layout Guidelines, SPRAAR7J](https://www.ti.com/lit/an/spraar7j/spraar7j.pdf), Nov. 2018, rev. Feb. 2023. | Direct layout guidance; capacitor selection remains application-specific. | High |
| C4 | Blindly split grounds increase return inductance; partitioning and one continuous plane are usually safer. | Rob Reeder, Analog Devices, [AN-1142](https://www.analog.com/en/resources/app-notes/an-1142.html), accessed 2026-09-06. | High-speed ADC context; intentional domain/safety exceptions remain. | High |
| C5 | Source-series, parallel, Thevenin, AC, double, and diode termination have topology/power/timing tradeoffs. | Texas Instruments, [Design Considerations for Logic Products, SDYA002](https://www.ti.com/lit/an/sdya002/sdya002.pdf), and [AN-903](https://www.ti.com/lit/an/snla034b/snla034b.pdf), Aug. 1993, rev. Apr. 2013. | Logic/differential examples; exact values are device-specific. | High |
| C6 | LVDS point-to-point links normally terminate at the far receiver with the differential line impedance. | Analog Devices, [AN-1177](https://www.analog.com/en/resources/app-notes/an-1177.html), accessed 2026-09-06. | LVDS/M-LVDS scope only. | High |
| C7 | Via stub quarter-wave resonance, antipad/ground-via tradeoff, and simultaneous return-loss/crosstalk optimization matter at very high rate. | AMD, [XAPP1392 Via Impedance Optimization](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Via-Impedance-Optimization), 2023-05-23. | 112 Gbps Versal context; mechanism general, numerical limits not universal. | High |
| C8 | Frequency-dependent conductor, roughness, and dielectric loss cause attenuation and dispersion; channel budget is protocol/device-specific. | AMD, [XAPP1392 Channel Insertion Loss](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Channel-Insertion-Loss), 2023-05-23. | Very-high-rate serial channel. | High |
| C9 | Crosstalk must be evaluated relative to aggressor/victim strength and whole-channel loss. | AMD, [XAPP1392 Crosstalk](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Crosstalk), 2023-05-23. | 20/30 dB examples are application-specific and labeled as such. | High |
| C10 | Intra-pair skew produces mode conversion; asymmetry and glass weave contribute; meander compensation can self-couple. | AMD, [XAPP1392 Intra-pair Skew](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Skew) and [Trace Length Matching](https://docs.amd.com/r/en-US/xapp1392-pcb-chan-design-guidelines/Intra-pair-Trace-Length-Matching), 2023-05-23. | 112 Gbps context; general mechanism strong, <1 ps target not generalized. | High |
| C11 | Glass weave can create pair skew; angled routing or tighter/spread weave mitigates it. | Intel/Altera, [AN 528](https://cdrdv2-public.intel.com/654621/an528.pdf), Jan. 2011. | First-party channel/material guide; exact benefit is construction-dependent. | High |
| C12 | Board delay differs by stackup/layer and coupling/tolerance; convert time to length only with the actual extraction. | Intel, [855PM Chipset Platform Design Guide](https://www.intel.com/content/dam/doc/design-guide/855pm-chipset-platform-guide.pdf), 2003. | Older platform but the propagation principle is stable; numerical delays apply only to that stackup. | High |
| C13 | Low-loss dielectric, smoother copper, and VNA verification are required for demanding serial links; connector return grounding matters. | Intel, [Agilex 7 High-Speed Serial Interface SI Design Guidelines](https://www.intel.com/programmable/technical-pdfs/683864.pdf), 2024-11-20. | Device-family context; use its numerical budgets only for covered devices. | High |
| C14 | Rougher copper increases insertion loss/delay and reduces eye opening. | John Coonrod, Rogers Corporation, [How Copper Properties Impact PCB RF and High-speed Digital Performance](https://www.rogerscorp.com/-/media/project/rogerscorp/documents/articles/english/advanced-connectivity-solutions/how-copper-properties-impact-pcb-rf-and-high-speed-digital-performance.pdf), 2020. | Laminate-vendor technical characterization; precise effects depend on model and process. | High |
| C15 | Loss degrades rise time/amplitude; crosstalk contributes pattern-dependent jitter and eye closure. | Tektronix, [Complete Methodology for Signal Integrity Analysis of Gigabit Interconnects](https://download.tek.com/document/SIGI1203.pdf), c. 2005. | Instrument-vendor methodology; physical claims are stable. | High |
| C16 | Eye diagrams and jitter decomposition require defined time reference, statistics, and mechanisms. | Tektronix, [Characterizing and Troubleshooting Jitter](https://www.tek.com/en/documents/application-note/characterizing-and-troubleshooting-jitter-your-oscilloscope) and [Jitter Timing Fundamentals](https://www.tek.com/de/documents/application-note/jitter-timing-fundamentals), accessed 2026-09-06. | Measurement guidance, not a protocol BER specification. | High |
| C17 | TDR/TDT/VNA can characterize impedance, delay, loss, crosstalk, mode conversion; fixture effects require calibration/de-embedding. | Keysight, [Signal Integrity Analysis Series Part 1](https://go.keysight.com/us/en/assets/7018-01461/application-notes/5989-5763.pdf) and [Part 3: De-Embedding](https://www.keysight.com/zz/en/assets/7018-08491/application-notes/5989-5765.pdf), accessed 2026-09-06. | Instrument-vendor methodology; implementation accuracy depends on standards/fixtures. | High |
| C18 | IBIS and Touchstone are official behavioral/model-exchange formats; their existence does not validate an individual model. | IBIS Open Forum, [Specifications](https://www.ibis.org/specs/) and [Touchstone 2.1](https://ibis.org/touchstone_ver2.1/touchstone_ver2_1.pdf), ratified 2025-12-05 and 2024-01-26 respectively. | Format authority; model QA is still required. | High |
| C19 | Safety/isolation return paths require approved stitching-capacitor structures, not casual ground bridging. | Analog Devices, [AN-1349](https://www.analog.com/en/resources/app-notes/an-1349.html), accessed 2026-09-06. | ADM2582E/ADM2587E example; safety standard and barrier rating remain product-specific. | High |
| C20 | The accessible JLCPCB summary promotes short traces, continuous reference, and 3W spacing. | JLCPCB, [PCB Design Rules and Guidelines](https://jlcpcb.com/blog/pcb-design-rules-best-practices), accessed 2026-09-06. | Secondary subject source; general heuristics only. Supplied article URL was unavailable. | Medium for accurately representing JLCPCB’s summary; not used for sign-off rules |

## 18. Evidence gaps, disagreements, and stop condition

### Gap matrix

| Question | Best-supported resolution | Residual gap / required project evidence |
|---|---|---|
| Which transmission-line threshold is “correct”? | None is universal. 1/10 is conservative, 1/6 is a common lumped approximation, and round-trip comparison addresses overlap rather than amplitude. | Select an error budget or simulate the actual net. |
| Is 3W enough? | Not provable without geometry, coupled length, edge, topology, and noise budget. | Stackup-specific field extraction and aggressor analysis. |
| Is a target 50/90/100 Ω? | Only if the exact interface/device/channel specification says so or analysis selects it. | Exact protocol, devices, connector, ODT, and stackup. |
| Is a via or bend acceptable? | Acceptability depends on its electrical duration, reflection/loss/mode conversion, and total margin. | Actual 3-D geometry or measured/extracted model. |
| Can an open eye prove compliance? | No; it is conditional on pattern, recovery, statistics, reference plane, equalization, and BER method. | Protocol compliance definition and sufficient measurement/simulation depth. |
| Did the supplied article itself support a detailed claim? | Not verifiable; it returned 404. | Archived copy or restored page would be needed for a line-by-line audit. |

### Search and stopping record

Research covered the supplied JLCPCB URL and accessible related JLCPCB guidance; TI edge-rate, transmission-line, return-path, and termination notes; AMD 112 Gbps loss/crosstalk/via/skew/system analysis; Intel stackup, material, weave, connector, and high-speed channel guidance; official IBIS/Touchstone specifications; Keysight TDR/VNA/de-embedding workflows; Tektronix eye/jitter/loss measurement; Analog Devices grounding/isolation/LVDS guidance; and Rogers copper-roughness characterization.

The search stopped because every requested section has direct first-party support, competing threshold/spacing interpretations are reconciled rather than hidden, protocol-specific numerical limits are bounded to their source context, and the remaining gaps can only be closed with the target project’s devices, stackup, topology, and acceptance requirements. Additional generic layout articles would be redundant and lower authority.

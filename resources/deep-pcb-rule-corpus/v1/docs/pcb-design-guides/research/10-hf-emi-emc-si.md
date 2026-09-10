# How to Tackle EMI/EMC and Signal Integrity Issues in HF PCB Design

## Research dossier and engineering rules

**Target reviewed:** JLCPCB, “How to Tackle EMI/EMC and Signal Integrity Issues in HF PCB Design”  
**Canonical page:** <https://jlcpcb.com/blog/emi-emc-and-signal-integrity-issues-in-hf-pcb>  
**Requested URL:** <https://jlcpcb.com/blog/how-to-tackle-emi-emc-and-signal-integrity-issues-in-hf-pcb-design> (returned 404 during research)  
**Research date:** 2026-09-06  
**Audience:** PCB designers and an AI system generating or reviewing schematics, placement, stackups, routing constraints, and bring-up plans  
**Scope:** board- and enclosure-level high-speed digital, mixed-signal, and switch-mode-power EMC/SI practice. Product-specific safety, radio, automotive, medical, aerospace, and interface rules still govern.

## Executive answer

The article is directionally right that layout, stackup, return paths, impedance control, termination, filtering, and simulation must be considered early. It is not reliable as a standalone design standard. Its largest weakness is that it alternates between good field-based advice and universal rules that are either oversimplified or mutually contradictory.

The safe engineering model is:

1. A digital net is “high frequency” when its **edge spectrum and interconnect delay** make the physical geometry electrically significant, not when its clock merely crosses 50 or 100 MHz.
2. Every signal is a loop. Preserve the intended return path, minimize loop inductance and area, and keep a continuous reference plane under the entire route.
3. Most serious radiated-emissions failures are created when differential energy becomes **common-mode current** on a large structure such as a cable, heatsink, shield, chassis, or plane edge.
4. Place and route by fields and current paths: clocks, oscillator loops, fast I/O, high-`dv/dt` switch nodes, high-`di/dt` hot loops, connectors, and cables deserve priority.
5. Termination and filtering are frequency-dependent networks, not decorative components. Select them from the driver, receiver, channel, noise mode, and measured spectrum; place them at the correct electrical boundary.
6. Partition functions by placement and routing over one continuous ground reference. Do not create ground moats and then route signals across them.
7. Via fences, shielding cans, ferrite beads, 45-degree corners, “3W,” and “20H” are conditional techniques. None substitutes for a controlled return path or measured verification.
8. Simulation reduces risk; pre-compliance finds defects; only the applicable, correctly configured compliance test establishes compliance.

## Assessment of the source article

| Article proposition | Engineering verdict | Required correction or boundary |
|---|---|---|
| Keep high-frequency traces short. | Useful but incomplete. | Length matters relative to propagation delay and rise/fall time. A short route across a plane slot can be worse than a longer route over a continuous reference. |
| Match trace impedance to source and load. | Oversimplified. | Maintain the interface-specified characteristic impedance and use a topology-appropriate source, load, parallel, Thevenin, or AC termination. A high-impedance CMOS receiver is not normally “matched” directly. |
| Minimize vias. | Generally useful. | A signal via is acceptable when its antipads, stub, and nearby return transition are engineered. The absence of a return via can matter more than the signal via count. |
| Route tightly coupled differential pairs. | Conditional. | Pair geometry must meet the target differential and common-mode impedances and loss/skew budget. Symmetry and reference continuity matter more than an arbitrary minimum gap. |
| Use blind/buried vias to reduce crosstalk. | Not a general EMC rule. | They may reduce stubs or improve escape density, but add cost and fabrication risk. Use only after channel and manufacturing analysis. |
| Use continuous, unbroken ground planes. | Strong rule. | Preserve this. A plane is primarily a low-inductance return/reference structure; it is not automatically an enclosure-grade shield. |
| Use split ground planes to contain high-frequency noise. | Usually harmful and contradicts the preceding advice. | Prefer one continuous ground plane with functional placement partitioning. If isolation or a converter topology requires separated domains, treat the boundary as an intentional interface and never route an ordinary high-speed net across the split. [NXP AN10897](https://www.nxp.com/docs/en/application-note/AN10897.pdf) explicitly recommends one ground plane and partitioned routing. |
| Internal stripline reduces radiation. | Often true, not universal. | Stripline confines fields better, but adds dielectric loss and vias and reduces probe access. A short outer-layer route closely referenced to solid ground can be excellent. |
| Use slower slew rate. | Strong when timing permits. | Verify receiver input transition requirements, setup/hold, eye margin, protocol jitter, and switching loss. |
| Ferrite bead is a low-pass filter. | Shorthand only. | Its impedance is complex, peaked, current- and temperature-dependent, and ultimately rolls off because of parasitic capacitance. It can resonate with capacitors or distort data. Use measured impedance/S-parameters under bias. |
| Use 45-degree or curved corners to reduce EMI. | Low priority for ordinary digital traces. | Controlled impedance, reference continuity, via stubs, connectors, and termination dominate. Measured work found the tested 90-, 45-degree, and rounded bends nearly identical; microwave-width bends can still require a miter or EM model. [Montrose, 1998](https://doi.org/10.1109/ISEMC.1998.750154). |
| “Above 100 MHz” requires short high-speed routing. | Wrong threshold model. | A 1 MHz net with a 500 ps edge contains hundreds of MHz of useful spectrum and may be a transmission line. A sinusoidal RF net is governed by its operating band and harmonics. |
| Return current takes the shortest ground/power path. | Incorrect wording. | Current distributes over all available paths according to impedance. At high frequency it concentrates near the outgoing conductor because that minimizes loop inductance/field energy; discontinuities force spreading and detours. |
| FCC and CE are EMI/EMC standards. | Incorrect taxonomy. | The FCC is a US regulator; 47 CFR Part 15 contains rules. “CE” is a conformity marking under applicable EU legislation, not one EMC test standard. EMC is a property/discipline, not a single standard and not synonymous with product safety. |
| Multiple boards generally must share one ground. | Unsafe universal rule. | The answer depends on isolation, signaling standard, safety insulation, chassis, cable shield, and common-mode strategy. Galvanically isolated boards intentionally do not share DC ground. |
| A tree ground is preferable and ground should not form a loop. | Context-dependent and misleading for HF PCBs. | Tree/star wiring can help some low-frequency shared-impedance problems. For high-frequency digital return, a continuous low-inductance plane with many connections is usually preferable. |
| Simulation software usually cannot model route discontinuities. | Outdated. | 2-D and 3-D field solvers explicitly model traces, bends, vias, antipads, reference transitions, connectors, and plane structures. Model fidelity, boundary conditions, and compute cost are the limits. |

## 1. The field-and-current-path mental model

### 1.1 Separate SI, PI, EMI, and EMC

- **Signal integrity (SI):** whether the receiver sees the required voltage, timing, monotonicity, jitter, and bit-error performance after reflections, loss, dispersion, crosstalk, and noise.
- **Power integrity (PI):** whether every load sees supply voltage within its allowed impedance/noise envelope over frequency and time.
- **Electromagnetic interference (EMI):** unwanted electromagnetic energy and its conducted or radiated coupling.
- **Electromagnetic compatibility (EMC):** the system operates acceptably in its environment without emitting unacceptable disturbance. It includes emissions and immunity/susceptibility.

These are coupled. A reference discontinuity can cause SI ringing, inject plane noise, and convert balanced signal current to common mode. A termination may improve SI yet increase DC power. A shield may reduce emissions while changing antenna detuning or thermal behavior.

### 1.2 Analyze every risk as source, path, and victim

For each critical frequency or transient, identify:

- **source:** clock edge, I/O buffer, oscillator, SerDes, switching FET, diode recovery, motor commutation, relay, ESD strike;
- **coupling path:** shared impedance, capacitive E-field coupling, inductive H-field coupling, radiation, cable conduction, or mode conversion;
- **victim/radiator:** reset pin, ADC reference, high-impedance sensor node, radio input, cable, shield, heatsink, chassis seam, or another trace;
- **return path:** adjacent reference plane, paired conductor, decoupling capacitor, chassis bond, cable shield, or an unintended parasitic path.

Breaking any one part of that chain can solve a problem. The best fix is usually at the source or the first coupling boundary, where currents and loops are still small.

## 2. “High frequency” is set by edge spectrum, not clock alone

A periodic trapezoid contains harmonics determined strongly by rise/fall time. Two common engineering estimates for the significant edge bandwidth are:

```text
f_edge ≈ 0.35 / tr       (10–90% bandwidth convention)
f_knee ≈ 0.5 / tr       (conservative digital-harmonic envelope)
```

Neither is a regulatory cutoff. They are different approximations, so the AI must state which convention it uses. [TI’s High-Speed Layout Guidelines](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) shows the clock spectrum breaking near terms proportional to pulse width and rise time, not merely the fundamental.

**Example:** a GPIO toggling at only 1 MHz but rising in 500 ps has an estimated edge bandwidth of 700 MHz to 1 GHz. Treating it as “low speed” because its toggle rate is 1 MHz is a category error.

The second dimension is interconnect delay:

```text
tflight = length / vp
vp ≈ c / sqrt(εeff)
electrical length θ = 2π f length / vp
```

For common FR-4 geometries, delay is often roughly 150–180 ps/in (about 6–7 ps/mm), but the actual stackup must be calculated. A net becomes a transmission-line concern when the one-way delay is a meaningful fraction of the transition time. Rules such as `tflight > tr/6` or `tr/10` are screening heuristics, not laws. Simulate when the receiver margin is important or the topology has stubs and multiple loads.

**Example:** a 50 mm route at 170 ps/in has about 335 ps one-way delay. With a 1 ns edge, the route is already one-third of the rise time; reflections cannot be assumed to settle instantaneously.

For clocks, analyze at least:

- the fundamental and harmonics within the edge envelope;
- phase noise/jitter and receiver aperture;
- package and via resonances;
- any repetition-rate sidebands or spread-spectrum profile.

For switch-mode power, the nominal switching frequency predicts harmonic spacing, but the fast switch-node edges and parasitic ringing set the high-frequency EMI. A 400 kHz converter can produce failures in the 30–300 MHz band.

## 3. Return path and loop area

### 3.1 Every signal is a loop

The outgoing trace alone is not the circuit. The return current completes the loop through a plane, paired trace, decoupling structure, shield, or parasitic capacitance. At high frequency, return current on a continuous reference plane concentrates under the signal because that path has the lowest inductance. [NXP AN10897](https://www.nxp.com/docs/en/application-note/AN10897.pdf) distinguishes low-frequency least-resistance behavior from high-frequency least-inductance behavior, and [NXP AN12298](https://www.nxp.com/docs/en/application-note/AN12298.pdf) requires continuity for the full trace.

The fundamental relationship is:

```text
Vnoise = Lpath · di/dt
XL = 2πfL
```

**Example:** 10 nH in a return path carrying a 1 A/ns edge produces 10 V of inductive voltage in the idealized lumped calculation. Even when real bandwidth and current spreading reduce that peak, the example shows why millimeters, via placement, and package inductance matter.

Magnetic coupling and small-loop radiation increase with current, frequency, and loop area. The exact far-field equation depends on geometry and distance; “minimize loop area” is robust, while a universal dB prediction from layout distance is not.

### 3.2 Return-path rules

1. Route each fast single-ended net adjacent to a continuous reference plane for its whole path.
2. Do not cross plane splits, voids, antipad channels, connector keepouts, or the edge of the reference plane.
3. Keep signal and return close at connectors, flex transitions, test headers, and cables.
4. Put decoupling so the high-frequency supply loop—power pin, capacitor, ground pin—is geometrically small. “Close” means low loop inductance, not merely small center-to-center distance.
5. Do not route through the decoupling capacitor with long shared necks. Minimize pad-to-via and pin-to-pad inductance; use multiple vias when current and geometry justify them.
6. Treat vias, packages, and connectors as part of the loop, not ideal nodes.

### 3.3 Plane slots and voids

A signal crossing a reference-plane slot forces its return current around the slot or through a remote interplane capacitance. The enlarged loop raises inductance, creates an impedance discontinuity, increases crosstalk, and can launch plane/common-mode energy. The preferred fix is to reroute the signal or remove the slot. [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) and [NXP AN12298](https://www.nxp.com/docs/en/application-note/AN12298.pdf) both document this mechanism.

A stitching capacitor across a power-plane boundary is a last-resort return bridge, not permission to cross arbitrary ground splits. Its effectiveness is limited by mounting inductance, voltage-domain compatibility, capacitor impedance, and safety/isolation requirements.

## 4. Layer transitions and stitching

When a signal changes layers, ask whether its **reference conductor also changes**.

### 4.1 Ground-to-ground reference change

If a route changes from a layer referenced to GND plane A to one referenced to GND plane B, place one or more ground stitching vias close to the signal via. This gives the return current a short vertical path and reduces common-mode launch. Device-specific guidance may specify a maximum distance—for one TI high-speed USB device, symmetric ground stitching within 200 mil is specified—but that number is not universal. The general rule from [NXP AN12298](https://www.nxp.com/docs/en/application-note/AN12298.pdf) is “as close as possible” consistent with anti-pad and fabrication constraints.

Differential pairs are not exempt. Their fields do not cancel perfectly, especially through unequal antipads, bends, packages, connectors, or skew. A nearby return via controls the pair’s common-mode return and helps preserve symmetry.

### 4.2 Ground-to-power reference change

If one segment references ground and the next references a power plane, the return path must cross through a low-impedance decoupling capacitor between those references. At high frequency the capacitor mounting inductance may make this path poor. Prefer stackups and layer choices that let the net reference ground on both layers. If a reference change is unavoidable, place the correct capacitor adjacent to the signal transition and model the full loop.

### 4.3 Via discontinuity controls

- Minimize unused through-via stub; consider backdrill, blind via, or layer selection when the stub resonance falls in-band.
- Co-design signal-via drill, pad, antipad, return vias, and pair symmetry using a 3-D solver for demanding links.
- Avoid large, asymmetrical antipads and return-via placement that converts differential to common mode.
- Do not add test-point stubs to critical nets without modeling them.

An approximate open-stub quarter-wave resonance is:

```text
fstub ≈ vp / (4 · lstub)
```

Use this only for screening. Pads, barrels, loss, capacitive loading, and boundary conditions shift the real resonance.

## 5. Plane edges, board edges, and plane cavities

Do not route a fast trace at or beyond the edge of its reference plane. The field loses symmetry and fringes outward, increasing radiation and coupling; [NXP AN12298](https://www.nxp.com/docs/en/application-note/AN12298.pdf) illustrates this explicitly.

Power/ground plane pairs can also resonate as cavities. A first estimate for a rectangular plane pair is:

```text
fmn ≈ vp/2 · sqrt((m/a)^2 + (n/b)^2)
```

where `a` and `b` are plane dimensions and the boundary conditions determine the allowed modes. **Example:** a 100 mm plane dimension with effective relative permittivity near 4 has a half-wave scale near 750 MHz. Real planes have irregular shapes, decouplers, losses, vias, and cutouts, so field solving or measurement is needed for consequential designs.

### 5.1 Do not encode “20H” as a universal rule

The 20H rule recesses a power plane from the ground-plane edge by 20 times the interplane separation. Its claimed benefit is not general. Measurements by Shim and Hubing found more-contained near fields but slightly higher radiation on their 20H test board ([IEEE EMC 2001 paper](https://doi.org/10.1109/ISEMC.2001.950514)). Other full-wave analysis found benefit only in certain applications ([Montrose et al., 2005](https://doi.org/10.1109/TEMC.2005.847383)).

AI rule: do not demand 20H or credit it with a compliance margin. Keep noisy planes and traces away from edges where practical, minimize plane-pair excitation, use close plane spacing and decoupling, and simulate or measure the actual structure.

## 6. Common-mode conversion: the dominant system risk

### 6.1 Differential balance is finite

For a nominal pair, define a useful bookkeeping convention:

```text
Icm = (I1 + I2) / 2
Idm = (I1 - I2) / 2
```

Perfectly equal and opposite currents have zero common mode. Real systems have amplitude imbalance, skew, unequal loss, unequal termination, asymmetric antipads, connector pin fields, reference changes, and parasitic capacitance to chassis. [TI AN-1862](https://www.ti.com/lit/an/snla107a/snla107a.pdf) identifies pair imbalance, chassis/power coupling, and cable coupling as common-mode sources in Ethernet.

**Example:** if the forward conductor carries +20.0 mA and the return conductor carries −19.8 mA at a harmonic, the uncancelled net current is 0.2 mA. That seems small, but on a one-meter cable it can dominate the radiation from millimeter-scale PCB loops.

### 6.2 Connectors and cables

Cables are efficient common-mode radiators and receptors. A one-meter conductor has a free-space quarter-wave frequency near 75 MHz; with velocity factor 0.67, it is near 50 MHz:

```text
fλ/4 ≈ vp / (4 · length)
```

Therefore:

- place I/O filtering and protection at the connector boundary, before noise can traverse the board or cable;
- preserve pair symmetry through connector pinout, ESD parts, common-mode choke, and termination;
- keep noisy single-ended nets and switch nodes away from connector and magnetics regions;
- route the pair over its intended reference without a plane discontinuity;
- provide a controlled high-frequency path for cable common-mode current to chassis when the system architecture permits;
- test with the production cable type, length, shield termination, peripherals, and operating modes.

Avoid a long shield “pigtail.” At 100 MHz, even 10 nH has `XL ≈ 6.3 Ω`; a circumferential/360-degree bond is usually much lower inductance. TE’s shielded backshell guidance describes full-circumference termination, while also emphasizing that no one termination meets every application ([TE Connectivity](https://www.te.com/en/industries/aerospace/insights/space-grade-backshells.html)).

## 7. Partitioning without harmful split planes

Functional partitioning is a placement and routing strategy, not automatically a copper-splitting strategy.

### 7.1 Recommended partitioning

1. Mark noisy energy sources: clocks, FPGA/CPU banks, memory buses, oscillators, switch nodes, gate drives, motors, relays.
2. Mark sensitive victims: crystal inputs, ADC drivers/references, PLL supplies, RF inputs, high-impedance sensors, resets, interrupts.
3. Mark boundary structures: power entry, external I/O, antenna feeds, cable shields, chassis bonds.
4. Place each function compactly so its currents close locally.
5. Route digital signals only through the digital placement region and analog signals only through the analog placement region, while both use the same continuous ground plane.
6. Arrange boundary components so current must pass through them; do not allow copper, planes, or parallel traces to bypass a filter.

This approach lets high-frequency return current remain under its signal rather than flowing through an unrelated region. It matches [NXP AN10897](https://www.nxp.com/docs/en/application-note/AN10897.pdf) and modern mixed-signal guidance.

### 7.2 When separated grounds are legitimate

Isolation barriers, high-energy power stages, safety insulation, shunt measurement, or a specific converter/reference architecture can require distinct conductive domains. In that case:

- name the domains by function, not vague “quiet/noisy ground” labels;
- define every signal, power, ESD, and common-mode path across the boundary;
- maintain required creepage/clearance and do not bridge safety isolation with an unapproved capacitor;
- use the interface’s intended isolator, transformer, common-mode capacitor/Y-capacitor, or differential path;
- do not route an ordinary referenced high-speed trace across the moat.

## 8. Stackup engineering

Choose the stackup before detailed placement/routing and confirm it with the fabricator. The objectives are controlled impedance, close reference coupling, practical escape routing, manufacturability, low plane impedance, and acceptable loss/cost.

### 8.1 General stackup rules

- Every high-speed signal layer should be adjacent to a solid reference plane, preferably ground.
- Keep critical signal-to-reference dielectric thin enough to control fields and impedance without impractical trace widths.
- Keep a power/ground plane pair close where interplane capacitance and low spreading inductance are useful.
- Avoid two adjacent signal layers unless their routes are separated, short, or orthogonal as an additional—not primary—coupling control. Plane separation is stronger.
- Preserve stackup symmetry enough to control warpage and fabrication yield.
- Use the fabricator’s actual dielectric thickness, copper thickness after plating, resin content, roughness model, and frequency-dependent `Dk/Df`; do not design from generic “FR-4 = 4.2.”
- Obtain impedance coupons/TDR data when controlled impedance is a requirement.

### 8.2 Example six-layer concept, not a universal prescription

```text
L1  Components + short critical signals   -> reference L2 GND
L2  Solid GND
L3  Signals                               -> reference L2 GND
L4  Power regions/plane
L5  Solid GND                             -> close pair with L4 where feasible
L6  Short/low-risk signals                -> reference L5 GND
```

The dielectric distances determine which plane actually carries return current. If L3 is closer to L4 than L2, it may reference the power plane instead; the drawing alone is insufficient. A four-layer board can work very well, but designers should consciously allocate the best referenced layer to the fastest/quietest-required routes rather than spreading critical nets across both outer layers by habit.

## 9. Clocks, oscillators, and switch nodes

### 9.1 Clocks and fast digital outputs

- Select the slowest output-drive/slew setting that still meets timing and receiver input-transition specifications.
- Place source-series termination at the driver pin, not halfway down the line.
- Keep clocks away from connectors, board edges, antennas, high-impedance analog, and cable paths.
- Minimize oscillator/crystal loop area and keep unrelated copper and signals away according to the IC vendor’s layout.
- Do not add test stubs to clocks; use low-capacitance probing provisions at intentional points.
- Gate or disable unused clocks when the device architecture permits.

Spread-spectrum clocking reduces peak energy by distributing it over frequency; it does not eliminate energy. It adds deterministic modulation/jitter and may broaden the affected band. Verify every downstream device’s tolerance and the regulatory detector/bandwidth. [TI SPRABY0A](https://www.ti.com/lit/an/spraby0a/spraby0a.pdf) describes the peak-reduction principle and required device tolerance.

### 9.2 Switch-mode power

Identify two different structures:

- **hot loop:** the loop whose current commutates rapidly, producing high `di/dt` and magnetic-field/ringing problems;
- **switch node:** copper with large, fast voltage swing, producing high `dv/dt` capacitive coupling.

Use the regulator/controller datasheet and reference layout. In a buck converter, place the input high-frequency capacitor tight to the switching FET/IC loop. Keep the switch-node copper as small as possible while meeting current and thermal needs, and keep it away from feedback, connectors, shields, and sensitive planes. [TI’s measured layout guidance](https://www.ti.com/lit/an/slyt618/slyt618.pdf) explains that switch-node copper is a parasitic-capacitor plate and documents the EMI-versus-switching-loss tradeoff of an RC snubber.

Controls and tradeoffs:

- gate resistor or programmable slew: lower emissions/ringing versus higher switching loss and heat;
- RC/RCD snubber: damp resonance versus dissipation and possibly altered device stress;
- compact loop and low-ESL capacitor: usually improves efficiency, overshoot, and EMI together;
- shielded inductor/orientation: can reduce coupling, but verify the winding/start-node recommendation;
- ground under the power stage: may reduce loop inductance, yet ground directly under a high-`dv/dt` switch node can increase capacitive common-mode current. Follow the device-specific layout or compare variants by EM model/measurement;
- frequency dithering: lower peaks versus a wider spectrum and possible output ripple/control implications.

## 10. Termination and reflection control

At a load discontinuity:

```text
ΓL = (ZL - Z0) / (ZL + Z0)
```

An open load has `Γ = +1`, a short has `Γ = −1`, and a matched load has `Γ = 0`. Pads, packages, vias, branch points, connectors, and receiver capacitance all create frequency-dependent discontinuities.

### 10.1 Common strategies

| Strategy | Placement | Strength | Cost/tradeoff |
|---|---|---|---|
| Source series | At driver | Low DC power; excellent for point-to-point load at line end | Intermediate points see a half-step until reflection returns; not ideal for distributed loads |
| Parallel/load | At far end | Absorbs incident wave; good for bidirectional/multidrop rules where specified | DC power and driver-current cost |
| Thevenin | At far end | Biases and terminates | DC power, two components, rail noise |
| AC termination | At far end | Lower DC loss for repetitive signals | Pattern-dependent baseline/waveform behavior; tune RC |
| Differential end | At far end of pair | Standard for many current-mode differential links | Value, placement, and symmetry must match interface |

For source-series termination:

```text
Rseries ≈ Z0 - Rdriver
```

**Example:** a 50 Ω line driven by an approximately 15 Ω output starts with about a 35 Ω series resistor. This is a starting value; package impedance, driver state/voltage/process, receiver load, and stackup must be simulated or measured. [TI’s logic design guide](https://www.ti.com/lit/an/sdya002/sdya002.pdf) gives the same matching condition and explains the half-amplitude traveling step. [TI AN-807](https://www.ti.com/lit/an/snla027b/snla027b.pdf) documents the power and distributed-load tradeoff.

Do not terminate by habit. Establish the topology, directionality, driver model, receiver thresholds, `Z0`, flight time, bit time, and sample point. Then simulate min/typ/max PVT and fabrication corners.

## 11. Filtering and decoupling

### 11.1 Select by noise mode and impedance

First determine whether the offending current is differential mode (DM), common mode (CM), or both. A common-mode choke can impede CM while passing balanced DM, but leakage inductance and parasitic capacitance affect the wanted signal. A single series ferrite does not distinguish modes.

Ideal first estimates are:

```text
fRC = 1 / (2πRC)
fLC = 1 / (2π√(LC))
XC = 1 / (2πfC)
```

Real filters also contain source/load impedance, ESR, ESL, DC bias, component self-resonance, layout coupling, and control-loop interactions.

**Example:** 33 Ω and 100 pF gives an ideal pole near 48 MHz. On a control output this may reduce a 300 MHz harmonic, but the resulting rise time and logic threshold timing must be verified. It would be inappropriate on many high-speed data links.

### 11.2 Placement rules

- Put the filter at the source when preventing noise from spreading internally.
- Put an I/O filter at the connector/chassis boundary when preventing cable conduction/radiation or external RF ingress.
- Arrange “dirty” and “clean” copper so field or plane coupling cannot jump around the component.
- Give shunt capacitors a very short, low-inductance path to the intended reference/chassis.
- Use feedthrough/three-terminal capacitors when the geometry needs enforced series current flow and lower ESL.
- Add pads for optional damping/terminations during prototype design, but do not populate them without analysis.

### 11.3 Ferrite-bead cautions

Murata’s measured explanation shows a ferrite transitioning from mainly reactive to mainly resistive impedance and then rolling off at high frequency because of parasitic coupling ([Murata, “Chip ferrite beads”](https://article.murata.com/en-global/article/basics-of-noise-countermeasures-lesson-4)). Therefore an AI must request the full impedance curve, rated current, DC resistance, temperature rise, and bias behavior—not just “600 Ω at 100 MHz.” A bead plus low-ESR capacitors can create an underdamped resonance.

### 11.4 Input-filter stability

Switching converters behave as negative incremental input impedance over relevant ranges. An undamped LC/π input filter can interact with the converter control loop. Check filter output impedance against converter input impedance and include the real source/cable. [TI SLUA929A](https://www.ti.com/lit/an/slua929a/slua929a.pdf) demonstrates that an EMI filter that attenuates harmonics can also create oscillation and shows damping methods.

### 11.5 Decoupling is a loop-inductance problem

A nominal capacitor value is useful only over the band where its mounted impedance is low. At 500 MHz, 1 nH alone has about 3.1 Ω reactance. Minimize pad/via loop inductance, use a value/package mix only where impedance analysis supports it, and verify anti-resonances in the PDN. “One 0.1 µF at every pin” is a starting convention, not a broadband proof.

## 12. Shielding and chassis

Shielding works only as a current-control system. A conductive can or enclosure must have a low-impedance bond around the relevant perimeter, small/controlled apertures, and intentional treatment of every cable penetration.

### 12.1 Board-level shields

- Place the can wall over a continuous grounded land pattern.
- Stitch that land to the reference plane frequently enough for the highest relevant frequency and geometry.
- Avoid traces crossing under the shield wall unless their return and filtering are explicitly designed.
- Model or measure cavity resonances, seam leakage, and coupling through apertures.
- Confirm thermal, assembly, rework, antenna, and creepage impacts.

### 12.2 Chassis and cable shields

- Bond a cable shield to chassis at entry with low inductance, ideally 360 degrees.
- Divert ESD/surge current to chassis at the connector rather than through logic ground when the product architecture permits.
- Decide the DC and RF relationship between chassis and circuit ground from safety, corrosion, low-frequency ground-loop, ESD, and EMC requirements. Options include direct bond, capacitor, RC, or separated domains; none is universal.
- A shield connected at one end may avoid some low-frequency loop current but is often ineffective as an RF shield at the unbonded end. A both-end bond can be superior at RF but may create unwanted low-frequency current. State the frequency and system context whenever recommending either.
- Include the final enclosure, bonds, cables, and protective-earth connections in test. TI’s isolated-system test guidance explicitly warns that planned shield/PE connections must be present during emissions testing ([TI SLLA561](https://www.ti.com/document-viewer/lit/html/SLLA561)).

Shielding after common-mode current is already on a cable is usually harder than preventing the conversion at the connector or reference discontinuity.

## 13. Via fences: useful, conditional, and limited

A grounded via fence can reduce parallel-plate leakage at a board edge, improve the wall of a grounded coplanar structure, bond shield-can lands, or isolate specific RF structures. It is not a magic Faraday cage:

- fields above an open PCB surface can pass over the fence;
- gaps, connector openings, plane cutouts, and unbonded copper can dominate;
- spacing must relate to wavelength **in the relevant dielectric/mode**, not only free-space wavelength;
- via inductance and the connection to real ground limit performance;
- a fence placed too close changes transmission-line impedance; too far can permit unwanted modes;
- dense vias cost area, can complicate routing/fabrication, and may create reliability constraints.

Rules such as spacing ≤ `λg/10`, `λg/20`, or `λg/8` are screening heuristics. An experimental 1–8.5 GHz study found via fences beneficial by as much as 21 dB at some frequencies but found spacing only **loosely** followed the one-eighth-wavelength rule ([Lindseth and Braaten, 2016](https://www.ndsu.edu/pubweb/~braaten/EMC_2016_1.pdf)). Do not transfer that dB result to a different board.

**Example:** at 5 GHz with `εeff ≈ 4`, `λg ≈ 30 mm`; `λg/10 ≈ 3 mm`. That is a starting maximum spacing for a specific mode, not proof. Use a field solver or coupon measurement for a critical RF boundary.

Ground guard traces without frequent ground stitching can float, resonate, or merely add capacitive coupling. A guard should have a defined return purpose and via connection.

## 14. Simulation strategy

The article’s claim that most simulation cannot model discontinuities should not be propagated. The correct question is which abstraction is adequate.

### 14.1 Before layout

- Use interface timing budgets and transmission-line estimates to classify nets.
- Simulate driver/receiver with vendor IBIS or transistor-level models and candidate topology/termination.
- Explore min/typ/max process, voltage, temperature, edge rate, load, and stackup impedance.
- Build a PDN target-impedance model and include package/plane/via/capacitor parasitics.
- For converters, simulate control-loop interaction with the proposed EMI filter and source impedance.

The [IBIS Open Forum](https://www.ibis.org/specs/) maintains standardized buffer, interconnect, and Touchstone formats. A model is still only as good as its extraction, corner definitions, and package/interconnect coverage.

### 14.2 During and after layout

- Use a 2-D field solver for controlled-impedance geometry and coupling.
- Use 3-D EM extraction for via fields, connectors, BGA escapes, shield transitions, complex coplanar structures, and mode conversion.
- Export broadband S-parameters with a clear reference impedance and port definition; check causality/passivity before channel use.
- Run post-layout SI with extracted interconnect plus driver/receiver models.
- Simulate plane/cavity and chassis/cable structures only when the model includes credible excitations, bonds, loss, and boundaries.

[Intel’s board-SI flow](https://www.intel.com/content/www/us/en/docs/programmable/683768/24-3/fpga-to-board-signal-integrity-analysis-flow.html) distinguishes flexible generic pre-layout exploration from defined post-layout verification. Simulation predicts behavior; it does not certify emissions or immunity.

## 15. Measurement, pre-compliance, and debugging

### 15.1 Build a compliance map first

Identify product family, markets, ports, cable configuration, operating modes, class/environment, emissions limits, immunity tests, safety/isolation constraints, and software modes. CISPR 32, for example, covers multimedia-equipment emissions and defines Class A and B categories; it is not a generic PCB layout guide ([IEC CISPR 32 scope](https://webstore.iec.ch/en/publication/86)). IEC 61000-4-6 defines a conducted-RF immunity method, while product committees select applicability, levels, and criteria ([IEC 61000-4-6:2023](https://webstore.iec.ch/en/publication/65586)).

For US Part 15 measurements, use the measurement procedure incorporated by the current rule/KDB guidance; the FCC’s [KDB 300643](https://apps.fcc.gov/oetcf/kdb/forms/FTSSearchResultPage.cfm?id=21079&switch=P) identifies ANSI C63.4-2014 for unintentional radiators in its 2018 publication. Recheck current rules before a program because incorporated editions and authorization procedures can change.

### 15.2 Bench and pre-compliance toolchain

| Tool/method | What it answers | Limitation |
|---|---|---|
| Oscilloscope with correct probing | Edge rate, overshoot, ringing, timing, switch-node behavior | Long probe ground creates false ringing; bandwidth/loading matter |
| TDR/TDT | Location and magnitude of impedance discontinuities, delay, differential/common impedance | Requires calibration/de-embedding and suitable launch |
| VNA/S-parameters | Insertion/return loss, coupling, mixed-mode conversion, resonances | Fixture and reference-plane errors can dominate |
| Near-field H probe | Local high-current loops and magnetic coupling | Relative localization, not compliance field strength |
| Near-field E probe | High-`dv/dt` nodes, seams, electric coupling | Relative and probe-dependent |
| Cable current probe | Common-mode current on I/O/power cable | Transfer impedance/calibration and cable position matter |
| LISN/artificial network + receiver | Repeatable conducted-emissions port impedance and noise voltage | Must match applicable standard/setup |
| TEM/GTEM cell or small chamber | Comparative radiated behavior and design screening | Correlation to final OATS/SAC/FAR is setup-dependent |
| Full pre-compliance antenna setup | Margin and frequency list in product configuration | Ambient, site validation, detector/RBW, distance, and turntable height may differ from certified lab |

Keysight’s [TDR application note](https://go.keysight.com/us/en/assets/7018-01461/application-notes/5989-5763.pdf) describes extracting impedance, crosstalk, differential/common impedance, and mode conversion. Rohde & Schwarz’s [pre-compliance debugging note](https://cdn.rohde-schwarz.com/pws/campaigns/rsa/Rohde_Schwarz_Precompliance_EMI_Debug_AppNote_V1.pdf) shows scanning with H- and E-field probes; its related guidance stresses that near-field probes are relative diagnostics, not limit measurements.

### 15.3 Debug sequence

1. Reproduce the failure with the same mode, load, clock settings, enclosure, cable routing, and peripherals.
2. Record frequency, amplitude, detector, bandwidth, antenna polarization, cable configuration, and margin.
3. Map peaks to clock harmonics, switching frequency/ringing, memory activity, SerDes reference clocks, or software events.
4. Use a cable current probe. A peak that tracks cable common-mode current points toward connector/reference/chassis conversion.
5. Scan H-field for current loops and E-field for switch nodes, oscillator pins, seams, and high-impedance/high-voltage structures.
6. Correlate in time: enable/disable blocks, change GPIO slew, gate clocks, alter converter mode/frequency, or run controlled firmware patterns.
7. Perform reversible substitutions: clamp ferrite on cable, copper-tape a seam to chassis, add a local return stitch, fit an optional source resistor/snubber/filter, shorten a cable, or use absorber. Treat improvement as localization evidence, not necessarily the production fix.
8. Implement the fix at the earliest source/path boundary, then recheck SI, thermals, efficiency, immunity, ESD, and all operating modes.
9. Repeat pre-compliance with margin; then run the formal applicable test.

Do not claim compliance from a near-field scan, FFT scope, unvalidated chamber, simulation, or one cable orientation. A formal result belongs to the tested equipment configuration and procedure.

## 16. Worked engineering examples

### Example A: slow clock, fast edge

An MCU produces a 2 MHz clock with `tr = 0.8 ns` on an 80 mm route.

```text
fedge ≈ 0.35/0.8 ns = 438 MHz
tflight ≈ 80 mm · 6.7 ps/mm = 536 ps
tflight/tr ≈ 0.67
```

Conclusion: despite the 2 MHz fundamental, this is a transmission-line net. Give it a continuous ground reference, avoid stubs, reserve source termination, and simulate the actual driver/receiver.

### Example B: source termination

The extracted line is 48 Ω and the driver output resistance is 18 Ω at the relevant transition/corner.

```text
Rseries,start ≈ 48 - 18 = 30 Ω
```

Place 27–33 Ω options at the source and validate min/max driver impedance and receiver waveform. Do not place the resistor near the receiver and still call it source termination.

### Example C: layer transition

A 100 Ω differential pair changes from L1 referenced to L2 ground to L6 referenced to L5 ground. Route both signal vias symmetrically, add ground return vias close to the pair, coordinate antipads, and extract the transition. Pair cancellation does not remove the need for a common-mode return.

### Example D: cable conversion

A USB-like pair is balanced on the PCB but the ESD array presents 0.25 pF more capacitance on one conductor. The connector shield is attached through a 25 mm pigtail. The remedy hierarchy is to restore symmetry, provide a low-inductance shield/chassis bond, and confirm common-mode choke necessity from mixed-mode S-parameters and cable current—not simply to add a larger choke.

### Example E: converter EMI

A 2 MHz buck has a 180 MHz emissions peak. Scope probing shows switch-node ringing near 180 MHz and an H-probe locates the input hot loop. Shorten the input-capacitor commutation loop, shrink switch-node copper consistent with thermal needs, and tune an optional snubber from the measured resonance. Then verify FET loss/temperature and conducted plus radiated emissions.

## 17. Tradeoffs and contradictions that must remain explicit

| Decision | Benefit | Cost/risk | Verification gate |
|---|---|---|---|
| Slower digital slew | Less harmonic energy, crosstalk, and ringing | Setup/hold or input-transition failure | SI simulation and worst-case timing/eye test |
| Slower MOSFET edge/snubber | Less ringing/EMI/device overshoot | Switching loss, heat, snubber dissipation | Efficiency, thermal, stress, and EMI sweep |
| Tightly coupled pair | Better pair symmetry and field cancellation in some geometries | Changes differential impedance; stronger intra-pair coupling; routing constraints | Field solver and interface impedance/loss limits |
| Stripline | Field confinement and isolation | More dielectric loss, vias, difficult probing | Loss/eye budget and via extraction |
| Ground under switch node | Can reduce hot-loop inductance/shield fields | Adds parasitic capacitance and CM current | Device-specific guidance plus A/B measurement/model |
| Split ground | Can enforce galvanic/safety/domain separation | Return discontinuity, common-mode launch, ESD stress | Explicit isolation/current-path architecture; no crossed nets |
| Common-mode choke | CM attenuation | DM degradation from leakage/parasitics, cost, saturation | Mixed-mode S-parameters, eye test, bias/temp |
| Ferrite bead | Lossy HF impedance | Resonance, DC drop, saturation, signal distortion | Biased impedance curve, PDN/loop analysis |
| Shield can | Local E/H attenuation | Cavity/seam leakage, cost, heat/rework | Near/far-field A/B test and thermal validation |
| Dense via fence | Better plane bonding/barrier in some modes | Impedance perturbation, space, cost, false confidence | 3-D EM or representative coupon |
| Source termination | Low DC power and good end-load waveform | Bad intermediate-node waveform; bidirectional limits | Topology-aware time-domain simulation |
| Parallel termination | Absorbs end reflection | Static power and driver current | DC power/current plus eye/timing |
| Spread spectrum | Lower spectral peaks | Wider occupied spectrum, added modulation/jitter | Receiver tolerance and compliance detector test |
| Extra PCB layers | Better references/partitioning/routing | Cost, lead time, via complexity | Stackup review with fabricator and SI/EMC budget |

## 18. Rules for an AI PCB design/review agent

### MUST

- Determine fastest rise/fall time, not only clock/data rate, for every candidate critical net.
- Identify the entire signal and return-current loop across package, PCB, connector, cable, and decoupling.
- Require a continuous adjacent reference for every fast route and flag every split, slot, void, plane edge, and reference change.
- Add a nearby return transition when a signal via changes reference planes; preserve differential symmetry.
- Identify all high-`dv/dt` nodes, high-`di/dt` loops, clocks, oscillators, external connectors, shields, and sensitive victims before placement approval.
- Keep switch-node copper and commutation loops compact subject to current and thermal constraints.
- Put filters, ESD parts, and chassis/shield transitions at the boundary they protect, with no bypass path.
- Use interface/vendor-specific impedance, termination, stackup, and layout requirements over generic web rules.
- State assumptions, units, frequency range, noise mode, and confidence for every quantitative recommendation.
- Require post-layout extraction/simulation for consequential channels and a pre-compliance/final-test plan for EMC claims.

### MUST NOT

- Use a fixed 50 or 100 MHz threshold to classify digital nets.
- recommend a split ground merely to separate analog and digital functions;
- route any fast signal across a reference split and “fix” it later with a generic capacitor;
- assert that differential pairs have no return current or cannot radiate;
- choose a ferrite bead only from its impedance at 100 MHz;
- claim a via fence, shield can, ground pour, 45-degree corner, 3W spacing, or 20H setback guarantees EMI reduction;
- call FCC, CE, EMC, and safety interchangeable standards;
- claim compliance from simulation, visual inspection, or informal bench measurements;
- copy a reference design without reconciling stackup, load, enclosure, cable, and operating-mode differences.

### SHOULD

- Prefer one continuous ground plane and partition placement/routing by function.
- Prefer ground-referenced routing on both sides of a layer transition.
- Reserve optional source resistors, snubbers, common-mode parts, and chassis coupling footprints at first prototype, where their parasitics are controlled.
- Request IBIS/S-parameter/package models and actual fabricator stackup data.
- Measure cable common-mode current whenever radiated emissions involve an external cable.
- preserve at least one practical probe/measurement path without adding a harmful stub;
- use multiple evidence classes: device datasheet/reference design, solver, coupon/bench measurement, pre-compliance, then formal lab.

### ASK OR VERIFY BEFORE DECIDING

- destination markets and exact product standard;
- Class A/B or environment category;
- isolation and protective-earth architecture;
- cable type, length, shield, and termination at both ends;
- driver edge rate and selectable slew/drive strength;
- receiver thresholds, timing, and permitted termination;
- actual layer buildup and fabrication tolerances;
- converter operating modes, loads, switching transitions, and thermal limit;
- enclosure material, seams, apertures, coatings, and chassis bonds;
- antenna location and intentional-radiator constraints.

## 19. Design-review checklist

### Schematic

- [ ] Critical net table includes frequency/data rate, 10–90% rise/fall time, topology, direction, load, interface impedance, and termination.
- [ ] Connector table includes cable construction/length/shield and chassis/circuit-ground treatment.
- [ ] ESD, surge, and EMI filter parts have a defined current path to the correct reference.
- [ ] Optional damping/termination footprints exist where uncertainty justifies them.
- [ ] PDN targets and capacitor models include ESL/ESR/mounting.
- [ ] Converter input filter stability and damping are analyzed.

### Placement

- [ ] Clocks/oscillators/switch nodes are away from connectors, antennas, edges, and sensitive analog.
- [ ] Hot-loop components are placed as a geometric loop before other power routing.
- [ ] External-port filtering is at the boundary with separated dirty/clean regions.
- [ ] Functional zones do not require a split ground.
- [ ] Shield-can land, chassis contacts, and thermal path are co-designed.

### Stackup and routing

- [ ] Fabricator-approved stackup and impedance calculations are present.
- [ ] Every fast net has a continuous adjacent reference for its whole route.
- [ ] No critical net crosses a split, void, antipad corridor, or plane edge.
- [ ] Every reference-changing signal via has a nearby return transition.
- [ ] Differential transitions are symmetric and common-mode conversion is considered.
- [ ] Stubs, test points, via barrels, connector launches, and BGA escapes are modeled when material.
- [ ] Switch-node and hot-loop copper are compact but thermally adequate.
- [ ] Guard traces and via fences have explicit grounded connections and a modeled/measured purpose.

### Verification

- [ ] Pre-layout SI/PI/EMI risks were modeled.
- [ ] Post-layout extraction uses actual geometry and stackup corners.
- [ ] TDR/VNA/oscilloscope validation points are defined.
- [ ] Pre-compliance setup reproduces final cables, enclosure, loads, and software modes.
- [ ] Debug results distinguish near-field localization from formal limit measurement.
- [ ] Applicable formal standards and current editions have been confirmed.

## 20. Evidence reconciliation and remaining limits

| Claim family | Evidence status | Reconciliation |
|---|---|---|
| Edge rate sets high-frequency behavior | High confidence; first-party theory/application guidance | Exact bandwidth constant varies by waveform and convention; use it as screening, not a hard cutoff. |
| Continuous return reference reduces loop/radiation | High confidence; consistent across NXP/TI guidance and field theory | Exceptions exist for intentional isolation and device-specific RF/power keepouts. |
| Split ground separates analog/digital noise | Rejected as a general rule | Partition over one plane; use separated domains only with an explicit boundary architecture. |
| Differential pairs eliminate EMI | Rejected | Balance suppresses fields, but asymmetry converts DM to CM; connectors/cables often dominate. |
| 20H improves EMI | Conflicted/geometry-dependent | Experiments and simulations disagree by setup; never treat as a universal DRC. |
| Via fences improve shielding | Conditional, experimentally supported | Frequency, spacing, plane bonding, field path, and geometry control the result; reported dB values do not generalize. |
| 45-degree corners materially reduce digital EMI | Low-value generalization | Measured ordinary digital structures show negligible difference; microwave bends may still need miter/model. |
| Ferrite bead “blocks HF” | Conditional | It provides frequency-dependent complex impedance and can resonate or distort signals. |
| Simulation establishes compliance | Rejected | Models guide design; only applicable measurements on the configured EUT support compliance. |

Limitations: this dossier does not supply product-specific emission limits, immunity levels, creepage/clearance, medical risk controls, automotive test harnesses, radio coexistence requirements, or interface compliance masks. Those require the exact product, market, and current standard. Several standards are paywalled; only publisher-provided scopes were used here. Numerical examples are illustrative and must not be copied into a layout without recalculation.

## 21. Primary-source and authoritative-source ledger

“Primary” here means the target itself, an original experiment/specification, an official regulator/standards publisher, or first-party silicon/instrument/component guidance with identifiable scope. Vendor application notes are strong implementation evidence but are not universal standards.

| ID | Source | Publisher/author | Date/version | Evidence used | Scope/caveat |
|---|---|---|---|---|---|
| S1 | [How to Tackle EMI/EMC and Signal Integrity Issues in HF PCB Design](https://jlcpcb.com/blog/emi-emc-and-signal-integrity-issues-in-hf-pcb) | JLCPCB / “Sam” | Page metadata says 2025-12-26; category listing showed 2025-10-28 | Target propositions on layout, impedance, vias, pairs, filters, planes, termination, EMI/EMC, simulation, FAQ | Target under review; internally inconsistent and commercially hosted. Publication-date metadata conflict preserved. |
| S2 | [High-Speed Layout Guidelines, SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) | Texas Instruments | Nov. 2006, rev. Aug. 2017 | Edge spectrum, transmission lines, reflections, reference slots, termination | General application report; examples do not replace interface datasheet. |
| S3 | [High frequency design considerations, AN12298](https://www.nxp.com/docs/en/application-note/AN12298.pdf) | NXP Semiconductors | Rev. 0, Dec. 2018 | Reference continuity, plane edge/void fields, layer transitions, stitching | General HF interconnect guidance. |
| S4 | [A guide to designing for ESD and EMC, AN10897](https://www.nxp.com/docs/en/application-note/AN10897.pdf) | NXP Semiconductors | Rev. 02, 2010-01-19 | Least-impedance return, one ground plane, functional partitioning | Some numeric layer/grid heuristics are technology/context specific. |
| S5 | [PCB Design Guidelines for Reduced EMI, SZZA009](https://www.ti.com/lit/an/szza009/szza009.pdf) | Texas Instruments | Nov. 1999 | Source/path/loop concepts, board zoning, connector filtering, shielding | Older CMOS/two-layer-oriented note; use principles, not every numeric heuristic. |
| S6 | [Reducing Radiated Emissions in Ethernet 10/100 LAN Applications, SNLA107A](https://www.ti.com/lit/an/snla107a/snla107a.pdf) | Texas Instruments | June 2008, rev. Apr. 2013 | Differential imbalance, common mode, cable/connector/chassis coupling | Ethernet-specific topology and component values. |
| S7 | [Design Considerations for Logic Products, SDYA002](https://www.ti.com/lit/an/sdya002/sdya002.pdf) | Texas Instruments | Application book, accessed 2026-09-06 | Series-termination matching and traveling-step behavior | Logic-family examples are illustrative. |
| S8 | [AN-807 Reflections: Computations and Waveforms, SNLA027B](https://www.ti.com/lit/an/snla027b/snla027b.pdf) | Texas Instruments / National Semiconductor | May 2004 | Reflection and source/parallel termination tradeoffs | Classical transmission-line cases; real packages and losses add complexity. |
| S9 | [AN-1177 LVDS and M-LVDS Circuit Implementation Guide](https://www.analog.com/en/resources/app-notes/an-1177.html) | Analog Devices | Accessed 2026-09-06 | Differential line termination and topology | LVDS/M-LVDS-specific. |
| S10 | [DRA7xx/AM57xx/TDAx Spread Spectrum Clocking Configuration, SPRABY0A](https://www.ti.com/lit/an/spraby0a/spraby0a.pdf) | Texas Instruments | Sept. 2015, rev. Nov. 2017 | SSC lowers peaks by spreading frequency; receiver tolerance required | Device-family-specific implementation. |
| S11 | [Five steps to a great PCB layout for a step-down converter, SLYT618](https://www.ti.com/lit/an/slyt618/slyt618.pdf) | Texas Instruments | 1Q 2015 | Switch-node area, snubber placement, EMI/efficiency tradeoff | Specific converter example; topology-dependent. |
| S12 | [Simple Solution for Input Filter Stability Issue in DC/DC Converters, SLUA929A](https://www.ti.com/lit/an/slua929a/slua929a.pdf) | Texas Instruments / Hao Zhang | Apr. 2019 | π-filter attenuation, negative input interaction, damping | Converter example; recalculate for actual control loop/source. |
| S13 | [Basics of Noise Countermeasures, Lesson 4: Chip ferrite beads](https://article.murata.com/en-global/article/basics-of-noise-countermeasures-lesson-4) | Murata Manufacturing | Published 2010s; accessed 2026-09-06 | Complex impedance, resistive loss region, high-frequency rolloff | Manufacturer education; obtain actual part curves under bias. |
| S14 | [IBIS specifications](https://www.ibis.org/specs/) | IBIS Open Forum | IBIS 8.0 ratified 2025-12-05; Touchstone 2.1 ratified 2024-01-26 | Standard behavioral/interconnect formats | Format compliance does not guarantee model accuracy. |
| S15 | [FPGA-to-board SI analysis flow](https://www.intel.com/content/www/us/en/docs/programmable/683768/24-3/fpga-to-board-signal-integrity-analysis-flow.html) | Intel | Quartus Prime Pro guide 24.3, 2024-09-30 | Pre-layout what-if versus post-layout verification | FPGA flow, but the abstraction distinction generalizes. |
| S16 | [Signal Integrity Analysis Series Part 1: TDR](https://go.keysight.com/us/en/assets/7018-01461/application-notes/5989-5763.pdf) | Keysight Technologies | App note 5989-5763EN; accessed 2026-09-06 | TDR/TDT characterization, differential/common impedance and mode conversion | Instrument/fixture calibration required. |
| S17 | [Precompliance EMI Debug](https://cdn.rohde-schwarz.com/pws/campaigns/rsa/Rohde_Schwarz_Precompliance_EMI_Debug_AppNote_V1.pdf) | Rohde & Schwarz | Version 1, circa 2020 | H/E near-field scans, time-frequency correlation | Diagnostic workflow, not certification. |
| S18 | [FCC KDB 300643: Part 15 measurement procedures](https://apps.fcc.gov/oetcf/kdb/forms/FTSSearchResultPage.cfm?id=21079&switch=P) | US Federal Communications Commission | 2018-07-12 | Official Part 15 measurement-procedure reference | Recheck current rule and KDB before testing. |
| S19 | [CISPR 32 scope](https://webstore.iec.ch/en/publication/86) | International Electrotechnical Commission | 2012 page notes superseding 2015+A1:2019 version | Multimedia-equipment emissions scope and classes | Publisher scope only; use purchased/current adopted standard for tests and limits. |
| S20 | [IEC 61000-4-6:2023](https://webstore.iec.ch/en/publication/65586) | International Electrotechnical Commission | Edition 5.0, 2023-06-06 | Conducted RF immunity method scope and product-committee boundary | Basic EMC publication; not itself every product’s required level. |
| S21 | [20-H Rule Modeling and Measurements](https://doi.org/10.1109/ISEMC.2001.950514) | H. W. Shim and T. H. Hubing, IEEE EMC Symposium | 2001 | Measured 20H near-field containment but slightly higher radiation | Specific unpopulated test boards; conflicts with some simulations. |
| S22 | [Analysis on the Effectiveness of the 20-H Rule](https://doi.org/10.1109/TEMC.2005.847383) | M. I. Montrose et al., IEEE Transactions on EMC | Vol. 47 no. 2, May 2005 | Full-wave result: benefits only under certain applications | Numerical model/configuration dependent. |
| S23 | [Effectiveness of PCB Perimeter Via Fencing](https://www.ndsu.edu/pubweb/~braaten/EMC_2016_1.pdf) | W. Lindseth and B. Braaten | IEEE EMC Symposium, 2016 | VNA/antenna experiment, frequency-dependent benefit and loose λ/8 relationship | 1–8.5 GHz test vehicle; reported dB cannot be generalized. |
| S24 | [Time and Frequency Domain Analysis for Right Angle Corners](https://doi.org/10.1109/ISEMC.1998.750154) | Mark I. Montrose, IEEE EMC Symposium | 1998 | Measured/simulated corner-shape comparison | Ordinary digital test geometries; microwave and very wide traces may differ. |
| S25 | [Space-Grade Backshells](https://www.te.com/en/industries/aerospace/insights/space-grade-backshells.html) | TE Connectivity | Accessed 2026-09-06 | Full-circumference cable-shield termination, application dependency | Product/application guidance, not a universal grounding standard. |
| S26 | [Radiated Emissions Testing Guidelines for Digital Isolators, SLLA561](https://www.ti.com/document-viewer/lit/html/SLLA561) | Texas Instruments | Accessed 2026-09-06 | Include final cables, shields, PE/chassis connections in test | Isolated-device evaluation guidance. |

## 22. Research method and stop condition

Research proceeded in two waves: first, extraction and claim decomposition of the target article; second, targeted primary-source checks for edge spectrum, return paths, reference changes, common-mode conversion, converter hot loops, termination, filters, shields/cables, via fences, simulation, and official EMC testing. Disconfirming evidence was sought specifically for split-ground, 20H, via-spacing, and 45-degree-corner folklore.

The search stopped when every requested claim family had at least one authoritative source, the consequential contradictions were preserved rather than averaged away, quantitative examples were bounded as estimates, and additional results were repeating vendor guidance rather than changing conclusions. The unresolved items are necessarily product-specific: applicable standard/edition, exact stackup, interfaces, enclosure, cable set, and measured spectra.

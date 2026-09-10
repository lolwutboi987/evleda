# Evidence dossier: impedance matching in PCB layout

**Research date:** 2026-09-06  
**Audience:** PCB designers, signal-integrity reviewers, RF engineers, and engineering agents that must turn an interface requirement into a routable, simulatable, and testable interconnect.  
**Scope:** This dossier audits the JLCPCB article supplied as *Impedance Matching in PCB Layout*, follows its current replacement page, and expands it into a design procedure for digital and RF PCB interconnects. It covers characteristic, source, load, input, differential, and reference impedance; reflection and measurement metrics; digital termination; RF impedance transformation; discontinuities; models; tolerances; simulation; and verification. It does not replace an interface specification, device datasheet, stackup drawing, field solver, or laboratory compliance test.  
**Evidence key:** **High** = official standard/specification or first-party device/instrument/fabrication documentation directly supports the statement; **Medium** = a sound engineering deduction or broadly applicable vendor guidance that still needs project-specific validation; **Low** = a heuristic or source claim that must not be promoted to a release rule without corroboration.

## Direct conclusion

An impedance-matched PCB is not simply a board with “50-ohm traces.” It is a channel in which the **driver, package, launches, routed transmission line, reference path, vias, connectors, receiver, and termination network behave acceptably over the signal’s occupied bandwidth and operating corners**. Uniform trace geometry establishes a characteristic impedance, but the useful design objective is normally one of these:

1. **Digital signal integrity:** prevent reflected edges from violating receiver thresholds, timing, absolute-maximum limits, jitter, or eye-mask requirements. Source or load termination may deliberately dissipate edge energy; maximum steady-state power transfer is usually not the goal.
2. **RF/microwave power or gain:** transform a complex source/device/load impedance to the impedance required for power, gain, noise, efficiency, stability, or linearity over a stated band. A conjugate match maximizes available power only under its stated linear-network assumptions; it is not automatically the best amplifier design point.
3. **Measurement/interoperability:** make the DUT present the specified reference impedance, commonly but not universally 50 ohms single-ended, so S-parameters, cables, fixtures, and instruments have a consistent reference plane.

The design therefore begins with the interface/device specification and the fastest edge or highest material frequency, not with a generic impedance value. It ends only after stackup-specific calculation, model-based channel analysis, and proportionate post-fabrication measurement.

## Status and audit of the required JLCPCB article

The supplied URL, `https://jlcpcb.com/blog/impedance-matching-in-pcb-layout`, returned HTTP 404 when checked on 2026-09-06. JLCPCB's blog index links the same topic to [*Understanding Impedance Matching for High-Speed PCB Designs*](https://jlcpcb.com/blog/understanding-impedance-matching-for-high-speed-pcb-designs), published 2023-08-23 and updated 2026-09-04. This dossier treats that current page as the recoverable successor, not as proof that its text is byte-for-byte identical to the unavailable page.

### Useful claims retained

The current article correctly emphasizes these high-level ideas (**Medium**, vendor educational guidance):

- Impedance is frequency-dependent and may contain resistance and reactance.
- A sufficiently long interconnect must be treated as a transmission line; impedance changes can produce reflections and waveform distortion.
- Controlled traces require a defined reference conductor and stackup.
- Trace width, copper thickness, dielectric thickness/properties, solder mask, pair spacing, and nearby copper affect impedance.
- Critical impedance targets come from the product/interface and device requirements, not from a universal PCB value.
- The fabricator's actual stackup and calculator should be used before ordering. The [JLCPCB impedance calculator](https://jlcpcb.com/pcb-impedance-calculator/) takes board construction, copper, target impedance, layer, pair spacing, and coplanar clearance as inputs.
- Impedance requirements should be communicated with the fabrication data rather than left implicit.

### Claims that need correction or qualification

| Article-level statement | Engineering correction |
|---|---|
| Match source, line, and load for “optimal transmission.” | Define the objective. A digital CMOS receiver is often intentionally high impedance; a source-series resistor can launch a matched half-amplitude wave that reaches full level after the open-load reflection. An RF conjugate match and a reflectionless line termination solve different problems. |
| Impedance is inversely proportional to dielectric constant. | For a simple lossless uniform line, `Z0 = sqrt(L'/C')`; common microstrip approximations have an approximate inverse-square-root dependence on effective permittivity, with geometry coupled into the result. It is not a universal inverse proportionality. |
| Impedance is directly or inversely proportional to width, spacing, mask thickness, copper thickness, or dielectric height. | These are useful local trends, not linear laws. Their sensitivities depend on structure, coupling, frequency, conductor shape/roughness, anisotropy, solder-mask Dk/thickness, and nearby copper. Use the fabricator's field solver and run a sensitivity sweep. |
| A solid ground or power reference is sufficient. | A reference conductor must also provide a continuous, low-impedance return path through launches and layer changes. A power plane is an AC reference only over the band in which its connection to the source/ground system is suitably low impedance. Plane changes require explicit return-path design. |
| Example values such as SDIO 50 ohms or USB 90 ohms can be used generically. | A number is valid only for the exact interface revision, mode, device implementation, and measurement definition. Differential and single-ended targets, fixture/reference plane, tolerance, and frequency band must come from the governing current specification and component documentation. |
| JLCPCB can “ensure” width and spacing within +/-20%. | The page states a width/spacing manufacturing tolerance, not a delivered characteristic-impedance tolerance. Obtain the order-specific impedance tolerance, coupon/report option, permitted trace adjustment, and finished stackup in writing. Do not relabel +/-20% geometry as +/-20% impedance. |

The article's short form does not distinguish input impedance from characteristic impedance, define a reflection coefficient, discuss source re-reflection, quantify electrical length, compare termination topologies, include packages/vias, or define simulation and measurement gates. The rest of this dossier fills those gaps.

## Impedance vocabulary: do not collapse these terms

| Term | Working definition | Design consequence |
|---|---|---|
| **Impedance, `Z(f)`** | Complex voltage/current ratio `R + jX` at a stated port, operating point, and frequency. | A single ohmic value without frequency and reference plane may be incomplete. |
| **Characteristic impedance, `Z0(f)`** | Ratio of forward-traveling voltage to current for one propagation mode of a uniform transmission line. In general, `Z0 = sqrt((R' + jωL')/(G' + jωC'))`; for a lossless line, `Z0 = sqrt(L'/C')`. | It is a distributed property of geometry/material/mode, not the trace's DC resistance and not the receiver input impedance. |
| **Source/output impedance, `ZS(f)`** | Small-signal impedance looking back into the source at the selected operating state and reference plane. | CMOS pull-up and pull-down impedances differ and vary with voltage, process, supply, temperature, drive setting, package, and frequency. Use an IBIS/SPICE/vendor model rather than one guessed resistor. |
| **Load impedance, `ZL(f)`** | Impedance presented at the line end: receiver input, termination, ESD network, pad/package, connector, antenna, filter, or another network. | A nominally “high-impedance” digital input still has capacitance and clamp/package parasitics that can dominate an edge. |
| **Input impedance, `Zin(f)`** | Impedance looking into a complete line/network from a specified reference plane. For a lossless line, `Zin = Z0 (ZL + j Z0 tan βl)/(Z0 + j ZL tan βl)`. | `Zin` depends on `ZL`, electrical length `βl`, frequency, and loss. It equals `Z0` for every length only when the line is terminated in `Z0`; it is not another name for `Z0`. |
| **Reference impedance, `Zref`** | Impedance used to normalize waves/S-parameters or define an instrument port, often 50 ohms. | An S-parameter file is meaningful only with its port order, mode, and reference impedances. Renormalization changes reported reflection values, not the physical DUT. |
| **Differential characteristic impedance, `Zdiff`** | Ratio of differential voltage to differential current for the odd/differential propagation mode. For a symmetric pair, `Zdiff = 2 Zodd`. | Two isolated “50-ohm traces” do not necessarily make a 100-ohm pair once coupling is present. Pair gap and surrounding geometry matter. |
| **Common-mode/even-mode impedance** | Impedance under same-polarity excitation; for a symmetric pair, common-mode impedance is half the even-mode impedance under the common convention. | A channel can meet `Zdiff` while having poor balance or common-mode conversion. Check the individual legs and mixed-mode behavior. |
| **Target impedance** | The impedance and tolerance called out by an interface, device, antenna, fixture, or system design. | Record whether the target is single-ended, differential, odd-mode, common-mode, or a complex device impedance, and over what band. |

[Tektronix's differential TDR guidance](https://download.tek.com/document/85W_16644_0.pdf) formally distinguishes differential, common-mode, odd-mode, and even-mode impedances and notes that the averaged differential result can hide leg imbalance. [IBIS 8.0](https://ibis.org/ver8.0/ver8_0.pdf) supports progressively richer package descriptions rather than assuming the package is an ideal pin (**High**).

### Reflectionless matching versus conjugate matching

- **Reflectionless load match:** `ZL = Z0` gives `ΓL = 0` at the load boundary. If `Z0` is real, a resistive termination equal to `Z0` absorbs the incident wave. Source matching `ZS = Z0` makes a wave returning to the source see `ΓS = 0`.
- **Conjugate power match:** for a linear Thévenin source `ZS = RS + jXS`, maximum available real power is delivered when `ZL = ZS* = RS - jXS`. This cancels reactance and matches the resistive parts at one frequency or over the modelled band.
- **They coincide only in special cases:** if the system impedance is purely real and source, line, and load all equal that value, it is both reflectionless and power matched. With complex impedances, lossy networks, active bilateral devices, stability constraints, nonlinear power amplifiers, or noise optimization, the best system termination may not be the simple conjugate.
- **RF two-port caveat:** an LNA's input and output impedances can depend on the opposite termination through reverse transmission. [Analog Devices' LNA treatment](https://www.analog.com/en/resources/technical-articles/lownoise-amplifier-stability-concept-to-practical-considerations-part-2.html) warns that simultaneous conjugate matching optimizes available gain, not necessarily noise figure, bandwidth, or stability. A PA's specified optimum load or load-pull contour may likewise differ from the conjugate of a small-signal output impedance.

## Transmission-line behavior and reflection metrics

For a uniform line with per-unit-length `R'`, `L'`, `G'`, and `C'`:

```text
Z0(f) = sqrt((R' + jωL') / (G' + jωC'))
γ(f)  = α + jβ = sqrt((R' + jωL')(G' + jωC'))
vp    = ω/β                  (phase velocity)
td    = length / vp          (one-way propagation delay)
```

At an impedance step from `Z0` to `ZL`, the load voltage reflection coefficient is:

```text
ΓL = Vreflected / Vincident = (ZL - Z0) / (ZL + Z0)
```

For passive loads referenced to a real positive `Z0`, `0 <= |Γ| <= 1`; an open gives `Γ = +1`, a short gives `Γ = -1`, and a matched load gives zero. Complex/active cases require care and can fall outside that simplified passive interpretation. The reflected power fraction for the same real reference is `|Γ|^2`. [Analog Devices' wave-reflection note](https://www.analog.com/en/resources/analog-dialogue/raqs/raq-issue-197.html) gives the wave and load-boundary interpretation (**High**).

Common scalar metrics are:

```text
VSWR = (1 + |Γ|) / (1 - |Γ|)
return loss, RL = -20 log10(|Γ|) dB
|Γ| = 10^(-RL/20)
```

Higher positive return loss and VSWR nearer 1 indicate a better match. Always state the sign convention: some software plots `20 log10|S11|`, which is a negative “S11 in dB,” while positive return loss is its negative. [Rohde & Schwarz's RF Fundamentals Part 3](https://cdn.rohde-schwarz.com/ymkt/na/content/RF_fundamentals_seminar_materials/3_RF_Fun_-_Standing_Waves_Unc-Mismatch_VNA.pdf) documents these conversions (**High**).

For a two-port with all other ports terminated in their reference impedances:

- `S11`: input reflection coefficient;
- `S22`: output reflection coefficient;
- `S21`: forward transmission, containing insertion loss/gain and phase;
- `S12`: reverse transmission/isolation.

Differential channels should use mixed-mode quantities such as `Sdd11` (differential return), `Sdd21` (differential insertion), and mode-conversion terms such as `Sdc21` when the port mapping and instrument/software support them. `S11` alone cannot identify where a discontinuity is, and a flat TDR impedance alone cannot prove low insertion loss.

### Reflections are time- and topology-dependent

Each discontinuity produces a local reflection; returning waves can reflect again at the source or at other discontinuities. Their amplitudes and arrival times superimpose. A load may momentarily see a value different from both its final DC voltage and the first launched voltage. This is why a single local impedance number does not predict overshoot, settling, double-clocking, or eye closure in a branched channel.

The source reflection coefficient uses the impedance seen by the returning wave:

```text
ΓS = (ZS - Z0) / (ZS + Z0)
```

A source-series termination aims for `ZS,total = Zdriver + Rseries approximately Z0`, so `ΓS approximately 0`. A far-end parallel termination aims for `ZL,total approximately Z0`, so `ΓL approximately 0`. Their waveform, power, and topology consequences are different.

## When matching and controlled impedance matter

### Use edge rate and occupied bandwidth, not only clock/data rate

A nominal 10 MHz clock with a 500 ps edge contains much higher-frequency energy than its repetition frequency suggests. First obtain the **fastest actual or specified 10%-90% rise/fall time at the driver pin across PVT and drive settings**, including any slew-rate control. If only a bandwidth is known, `tr approximately 0.35/BW` is a single-pole estimate, not a guarantee about a real waveform.

Compare one-way delay `td` with the fastest transition time `tr`. Rules such as `td >= tr/2`, or treating lines longer than roughly `tr/(6 td_per_length)` as distributed, are screening heuristics with different conservatism. [TI SCAA045](https://www.ti.com/lit/an/scaa045a/scaa045a.pdf) uses round-trip delay greater than or equal to transition time; [TI's high-speed seminar](https://www.ti.com/lit/ml/slyp172/slyp172.pdf) describes one-quarter and one-sixth edge-length screens. They are not interface specifications. Use channel simulation whenever a threshold/timing margin is consequential.

### Matching is normally required or explicitly evaluated when

- an interface specification mandates controlled single-ended or differential impedance;
- the line/cable/connector is electrically long at the relevant edge/frequency;
- overshoot, undershoot, monotonicity, settling, aperture jitter, or double-threshold crossing matters;
- an RF device, filter, antenna, mixer, ADC/DAC input, or instrumentation port specifies a complex or real source/load environment;
- high-Q stubs, resonances, via stubs, connector launches, or package discontinuities fall within the occupied band;
- the interconnect carries clocks, strobes, high-speed serial data, memory buses, or fast asynchronous controls whose failures have high consequence;
- a long off-board cable can return energy or expose the circuit to EMI/ESD;
- loss, crosstalk, or mode conversion makes a nominal impedance target insufficient by itself.

### Full termination may be unnecessary when

- round-trip delay is a small fraction of transition time and a lumped RC/L model meets margins;
- the driver intentionally limits slew so reflections settle inside the edge and before sampling;
- the net is short, point-to-point, low consequence, and a worst-case model demonstrates threshold/absolute-maximum compliance;
- the topology or interface already contains documented on-die termination;
- a resistor would violate DC level, current, noise, gain, stability, or bandwidth requirements.

“Unnecessary” must mean demonstrated unnecessary, not merely low clock frequency. Conversely, controlled impedance does not rescue a poor topology, excessive insertion loss, broken return path, or wrong termination.

## Digital termination networks

[TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) identifies series, parallel, Thévenin, and AC termination as common methods, and [Intel AN 224](https://cdrdv2-public.intel.com/654465/an224.pdf) recommends pre-layout simulation with device models before committing to a termination (**High**). Choose with the actual driver/receiver I/O standard.

| Network | First-order sizing and placement | Best fit | Main costs and traps |
|---|---|---|---|
| **Series/source termination** | Place at the driver; choose `Rseries + Zdriver approximately Z0` separately for rise/fall if the model requires it. | Unidirectional point-to-point net with receiver at the far end; low DC power. | First wave is reduced and reaches final value after reflection; intermediate loads see a staircase; added RC slows edge; output impedance is nonlinear/PVT-dependent; poor for bidirectional or distributed loads. |
| **Parallel/shunt termination** | Place `Rterm approximately Z0` at the physical line end, to the correct termination voltage. | Fast edge, distributed line, or receiver that needs the first incident wave to be valid. | Continuous/static current for some logic states, driver loading, reduced VOH/increased VOL if terminated to a rail, duty-cycle distortion, resistor/package/via parasitics. |
| **Thévenin/split termination** | At the far end, choose `Rtop || Rbottom approximately Z0` and `Vbias = VDD Rbottom/(Rtop + Rbottom)` to meet the interface bias/common-mode requirement. | Bias-sensitive single-ended buses; balanced pull-up/pull-down load. | Constant rail-to-rail current, tolerance and supply-noise coupling, high-Z idle state may sit near a threshold, extra components and capacitance. Do not choose `VDD/2` without checking input thresholds. |
| **AC termination** | Series `Rterm-Cterm` shunt at the far end, usually `Rterm approximately Z0`; choose `Rterm Cterm` against round-trip delay and allowed droop/pattern response. | Clocks or transition-rich signals where DC termination power is unacceptable. | No DC path after the capacitor charges, but transition energy is still dissipated. Baseline wander, pattern dependence, edge asymmetry, component parasitics, and added low-pass/high-pass behavior can make it unsuitable for arbitrary data or long runs. |
| **Differential parallel termination** | Place a resistor across the pair at the receiver, normally equal to the specified differential impedance, or use the interface's split/common-mode network. | LVDS/CML and other differential standards when required by the device/specification. | On-die termination may already exist; common-mode bias and AC coupling order matter; a resistor across the pair does not terminate common-mode energy. |
| **Double/source-and-load termination** | Match both ends when the interface/topology calls for it. | RF-like digital links, bidirectional lines, some backplanes. | Divides voltage and dissipates more power; driver amplitude must be designed for the doubly terminated load. |
| **Diode/clamp damping** | Fast external Schottky or specified clamp network at the vulnerable node. | Limiting residual over/undershoot where a full resistive termination is impractical. | It clips rather than impedance-matches, injects current into rails, has capacitance/inductance/recovery limits, and may violate injection-current ratings. Internal ESD diodes are not a termination. |

### Topology rules

- Put a **load termination after the last electrically significant load**, not at a visually convenient midpoint.
- Put a **source resistor next to the driver pin/ball**. Trace between the driver and resistor is an unterminated stub.
- A T-branch sees the parallel combination of outgoing line impedances at the junction; a source intended to drive two equal 50-ohm branches initially sees about 25 ohms. Size and simulate the actual branch topology.
- Daisy-chain/fly-by routing usually provides a more controllable main line than a star with unequal branches. Minimize receiver stubs. Intel's AN 224 uses `TDstub < tr/3` as one device-specific screening condition and shows that shorter stubs improve the eye; simulation is still the gate.
- With source termination, loads between source and far end can see only the first partial step until the reflection returns. Do not use it on a distributed-load clock without checking every receiver.
- Bidirectional buses need each drive direction analyzed. A resistor correctly located for one source may become an end discontinuity for the other.
- Do not stack an external terminator on enabled on-die termination. Verify reset/boot states, ODT modes, calibration range, and power sequencing.

## RF and microwave impedance transformation

Digital termination usually damps a broadband edge. RF matching usually transforms a complex impedance around one or more frequency bands. [NXP AN721](https://www.nxp.com/docs/en/application-note/AN721.pdf) documents reactive L-, three-reactance, transformer, and transmission-line approaches and shows the bandwidth/transformation-ratio trade (**High for its network theory; device examples are dated/application-specific**).

### Common RF networks

- **L-section:** one series and one shunt reactance; two low-pass/high-pass solutions for two positive real terminations. Its loaded Q is constrained by the resistance transformation, so a large ratio is inherently narrower band.
- **Pi or T network:** three reactances; adds a degree of freedom for loaded Q, harmonic filtering, bias feed, or practical values. More parts add finite-Q loss, tolerance, self-resonance, and layout sensitivity.
- **Transformer/balun:** transforms impedance by turns ratio (`Zin approximately n^2 ZL` ideally), and may perform balanced/unbalanced conversion or provide DC isolation. Real magnetics have leakage inductance, interwinding capacitance, loss, saturation, and a limited band.
- **Quarter-wave transformer:** at the design frequency, a lossless `λ/4` line with `Zt = sqrt(R1 R2)` matches two real resistances. It is distributed, frequency-selective, and physical electrical length depends on effective permittivity and dispersion.
- **Open/shorted stub:** supplies a frequency-dependent susceptance/reactance at a chosen location. Stubs are narrowband and extremely sensitive to electrical length, open-end fringing, via inductance, fabrication, and nearby coupling.
- **Taper/multisection transformer:** exchanges area/length and synthesis complexity for wider bandwidth and smaller local reflection steps.
- **Resistive pad/attenuator:** broadens match and improves isolation/stability at the direct cost of insertion loss, noise figure, output power, and efficiency.

### RF workflow

1. Obtain calibrated S-parameters or large-signal/load-pull/noise parameters at the actual bias, temperature, frequency, package, and power level.
2. Define the optimization objective: input return loss, output power, PAE, gain flatness, noise figure, stability margin, linearity, harmonic termination, or antenna efficiency. Do not optimize only `S11` unless that is truly the system objective.
3. Choose a realizable topology and include pad, via, package, component, bias-network, and enclosure effects.
4. Check unconditional/conditional stability over a frequency range wider than the intended band and over source/load mismatch. A beautiful conjugate match can create an oscillator.
5. Sweep component tolerances, component Q/SRF, substrate Dk/thickness, copper/etch, temperature, bias, and assembly parasitics. Leave tuning pads only if their added discontinuity is modelled.
6. Verify with a calibrated/de-embedded VNA and the intended operating power; small-signal S-parameters do not prove large-signal performance.

## Discontinuities and reference-path design

An interconnect is the signal conductor **plus its electromagnetic return path**. [TI SCAA082A](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) explains that high-frequency return current follows the lowest-impedance path near the signal and that a plane slot enlarges loop area; [TI's transparent-via article](https://www.ti.com/document-viewer/lit/html/SSZTCM4/GUID-17532CA9-A0AF-4401-8383-D3F4AE36A744) models a via as cascaded C-L-C sections and recommends 3-D EM optimization when bandwidth matters (**High**).

### Uniform routing rules

- Fix the manufacturer-approved stackup before solving widths. Record finished dielectric thickness, material family/resin/glass construction, copper base and finished thickness, plating, conductor profile, solder mask, and applicable tolerance.
- Keep width, pair gap, distance to reference, coplanar clearance, and surrounding copper environment constant through the routed region.
- Do not route a critical line across a split, void, antipad field, plane edge, connector cutout, or reference-plane neck.
- Keep unrelated copper/pours far enough away or include them in the solver. A late ground pour can turn a microstrip into a partly coplanar structure.
- For a differential pair, preserve symmetry. Match via count, pad/antipad, layer path, component placement, and exposure to neighboring copper. Length matching alone cannot repair impedance or mode-conversion asymmetry.
- Avoid unnecessary neck-downs. When a breakout requires one, minimize length and model the pad/neck/via as a discontinuity rather than pretending the entire route has the nominal width.
- Use bends that avoid abrupt excess capacitance; miters/arcs can help at microwave frequencies, but a bend style is not a substitute for field simulation.

### Layer and reference changes

- Prefer no layer change on the most sensitive links.
- If a signal changes layers while both layers reference ground planes, place ground-return stitching vias adjacent to the signal via so the return field can transfer locally.
- If the reference changes between different nets, provide a deliberately located low-impedance AC return connection appropriate to the occupied band, commonly a stitching capacitor between reference planes where the system architecture permits it. Its mounting inductance and anti-resonances matter. The safer design is often to choose layers with a common reference.
- Put symmetric return vias around a differential-via pair. Differential signalling reduces external field only to the extent the pair is balanced; common-mode current still requires a return path.
- Treat via barrel, unused stub, pad, antipad, plane cavity, and return-via location as one 3-D structure. Shorten or backdrill unused stubs only when the bandwidth/resonance analysis and fabrication capability justify it.

### Discontinuity inventory

Model or explicitly screen every item in the channel:

```text
die buffer -> on-die termination -> package/bond/BGA -> escape via/pad
-> trace/reference structure -> layer transition/return transfer -> AC-coupling or
termination component pads -> connector launch/contact/cable -> receiving launch
-> package -> receiver/termination
```

Also include probes/test pads, ESD protectors, common-mode chokes, filters, tees, stubs, zero-ohm options, series resistor pads, solder-mask openings, connector shields, and plane/cutout geometry. A component's schematic value omits package ESL/ESR and mounting inductance; a via's “inductance” omits the interacting antipad and return path.

## Material, fabrication, tolerance, bandwidth, and loss

### Material inputs are not single constants

Relative permittivity varies with test method, frequency, axis, resin content, glass weave, and temperature. “FR-4 = 4.2” is not a manufacturing specification. Rogers notes that published Dk is tied to a test method/frequency and that the value changes with conditions in [*Digging Deeper into Dielectric Constant for PCB Materials*](https://www.rogerscorp.com/blog/2020/digging-deeper-into-dielectric-constant-for-pcb-materials) (**High for its material guidance**). Use the laminate maker's design Dk/model appropriate to the solver and the board fabricator's actual construction.

Loss and phase are affected by:

- dielectric loss tangent and its frequency dependence;
- skin effect and conductor thickness;
- copper surface roughness/profile and plating/finish;
- dielectric anisotropy and glass weave;
- radiation, leakage, and connector/component losses;
- return-path resistance/inductance;
- frequency-dependent current crowding at discontinuities.

A low `S11` can coexist with poor `S21`: a matched attenuator looks well matched because it absorbs energy. Specify return loss **and** insertion loss/phase/group delay/eye requirements.

### Tolerance policy

1. Get the fabricator's nominal and tolerance distributions for dielectric thickness, Dk, copper, etch/trace width, plating, registration, and mask.
2. Ask whether the shop will modify impedance-trace width, by how much, and which files/notes govern. Preserve sufficient clearance for the permitted adjustment.
3. Specify impedance by net class, layer, structure, target, tolerance, and coupon/test method. Do not merely put “50 ohm” in a README.
4. Simulate corners and correlated process shifts; do not add each worst-case percentage arithmetically if the variables are not independent.
5. Set the impedance tolerance from system margin, not from the cheapest default. A tighter coupon number cannot compensate for unmodelled launches or packages.
6. Decide whether the acceptance criterion applies to a coupon, production route, or both. A panel coupon validates process/stackup locally but not every board discontinuity.

### Bandwidth and loss tradeoffs

- A lower-Q resistive termination is broadband but dissipative.
- A lossless two-reactance RF transformation is exact at a design frequency and narrows as transformation ratio/Q rises.
- Additional matching sections can broaden response but add size, component loss, tolerance sensitivity, and resonances.
- Series damping reduces ringing and EMI but increases rise time and may consume timing margin.
- Parallel termination gives immediate wave absorption but increases driver current and possibly DC power.
- AC termination reduces quiescent power but creates pattern-dependent response.
- Tighter coupling in a differential pair changes odd/even impedances and can improve field confinement, but may increase sensitivity to gap variation and intra-pair asymmetry.
- Wider traces often reduce conductor loss but require stackup/spacing changes to maintain impedance and may increase capacitive loading at pads.

## Worked calculations

These calculations establish intuition. They are not substitutes for the actual device and field-solver models.

### A. Derive characteristic impedance and delay from distributed parameters

Suppose an approximately lossless line has `L' = 300 nH/m` and `C' = 120 pF/m`:

```text
Z0 = sqrt(L'/C')
   = sqrt(300e-9 / 120e-12)
   = 50.0 ohms

vp = 1/sqrt(L'C')
   = 1/sqrt(300e-9 * 120e-12)
   = 1.667e8 m/s

delay = 1/vp = 6.00 ns/m = 152.4 ps/in
```

A 100 mm trace has about 0.60 ns one-way and 1.20 ns round-trip delay. A 500 ps edge therefore sees a distributed channel; a 10 ns edge may not require full termination, though lumped capacitance and EMI still matter.

### B. Reflection, reflected power, VSWR, and return loss

For a 50-ohm line terminated in 75 ohms:

```text
Γ = (75 - 50)/(75 + 50) = 0.20
reflected power fraction = |Γ|^2 = 0.04 = 4%
VSWR = 1.20/0.80 = 1.5:1
RL = -20 log10(0.20) = 13.98 dB
```

If the source is matched, the first load voltage is `1 + Γ = 1.2` times the incident-wave voltage. That does not mean the final DC output is permanently 20% high; timing and subsequent reflections determine the waveform.

### C. Input impedance can differ from line impedance

A lossless 50-ohm quarter-wave line terminated in 100 ohms has:

```text
Zin at βl = π/2 = Z0^2/ZL = 50^2/100 = 25 ohms
```

The trace remains a 50-ohm line. Its **input impedance** is 25 ohms at that frequency because the line transforms the load. Half a wavelength later the transformation repeats. This is why an ohmmeter or a single-frequency port measurement is not a direct measurement of `Z0`.

### D. Source-series termination

A 3.3 V driver has an estimated 18-ohm output impedance and drives a 50-ohm point-to-point line into a high-impedance receiver:

```text
Rseries,ideal = 50 - 18 = 32 ohms -> candidate standard value 33 ohms
Vincident = 3.3 * 50/(18 + 32 + 50) = 1.65 V
Γload approximately +1 for a high-impedance load
first far-end level approximately 1.65 * (1 + 1) = 3.30 V
Γsource approximately (50 - 50)/(50 + 50) = 0
```

This elegant two-step result assumes a linear 18-ohm driver and ideal open load. In practice, sweep pull-up/pull-down IBIS corners, receiver capacitance, package, resistor tolerance, and placement. An intermediate receiver can see 1.65 V until the reflected wave returns and may cross its threshold incorrectly.

### E. Parallel termination current and level

The same 3.3 V driver, now approximated as 20 ohms high-state resistance, drives a 50-ohm shunt to ground at the receiver:

```text
Ihigh = 3.3/(20 + 50) = 47.1 mA
Vhigh,load = 3.3 * 50/(20 + 50) = 2.36 V
Ptermination,high = Vhigh^2/50 = 111 mW
```

The line end is matched, but the logic-high level and current may be unacceptable. A current-mode driver designed for a terminated line is a different case. Verify VOH/IOL, duty cycle, resistor rating, thermal density, and simultaneous switching.

### F. Thévenin termination

For a 3.3 V single-ended net needing 50 ohms to a 1.65 V bias:

```text
choose Rtop = Rbottom = 100 ohms
Rth = 100 || 100 = 50 ohms
Vth = 3.3 * 100/(100 + 100) = 1.65 V
rail-to-rail divider current = 3.3/(100 + 100) = 16.5 mA per net
```

The bias may sit near a CMOS switching threshold when the driver is high-Z. The interface may instead require a different VTT or resistor pair. Include supply-noise coupling and the aggregate current of every terminated net.

### G. First-pass AC termination

For a 50-ohm line with 1.0 ns one-way delay, TI's clock-driver rule `RC > round-trip delay` gives:

```text
round trip = 2.0 ns
C > 2.0 ns / 50 ohms = 40 pF
candidate: R = 49.9 ohms, C = 47 pF
RC = 2.35 ns
```

This is only a seed value. Simulate worst-case run lengths, duty cycle, edge density, receiver thresholds, capacitor tolerance/voltage coefficient, and mounting parasitics. “No DC current” does not mean zero dissipation during switching.

### H. Narrowband L-match, 50 to 200 ohms at 100 MHz

Match a real 50-ohm source to a real 200-ohm load with a low-pass L-network. With the shunt element across the larger resistance:

```text
Q = sqrt(200/50 - 1) = sqrt(3) = 1.732
Xseries = Q * 50 = +86.60 ohms
Xshunt  = -200/Q = -115.47 ohms

Lseries = 86.60/(2π * 100e6) = 137.8 nH
Cshunt  = 1/(2π * 100e6 * 115.47) = 13.78 pF
```

At 100 MHz, `200 || (-j115.47) = 50 - j86.60 ohms`; the series inductor cancels the reactance, leaving 50 ohms. Real component SRF/Q, pad capacitance, inductor self-capacitance, source/load reactance, and PCB geometry can move the match substantially. Optimize with vendor S-parameters and a tolerance sweep.

### I. What a nominal +/-10% line alone means

If a 50-ohm load meets a line segment that is 45 or 55 ohms:

```text
Γ(45 -> 50) = (50 - 45)/(50 + 45) = +0.0526; RL = 25.6 dB
Γ(55 -> 50) = (50 - 55)/(50 + 55) = -0.0476; RL = 26.4 dB
```

This does **not** prove that a +/-10% production channel has 25 dB return loss. Multiple line sections, package/via/connector discontinuities, loss, phase, and reference changes combine vectorially.

## Models: required fidelity by design stage

| Element | Minimum useful model | Upgrade when |
|---|---|---|
| Digital driver/receiver | Vendor IBIS with correct I/O model, package, corner, supply, slew/drive/ODT setting. | Use transistor-level/SPICE only when authorized and needed; use IBIS-AMI/statistical models for serial links where the specification and tool flow require them. |
| Uniform PCB trace | Stackup-specific 2-D field-solver RLGC or broadband transmission-line model. | Include frequency-dependent conductor/dielectric loss, roughness, dispersion, and weave for long/high-rate channels. |
| Via/pad/antipad/launch | Lumped C-L-C only for a screened low-bandwidth case. | Use a 3-D EM extracted multiport for high-speed serial, RF, large antipad fields, stubs, or reference transitions. |
| Package | IBIS package RLC as a floor. | Use pin-specific/coupled package model, IBIS Interconnect, or vendor S-parameters where coupling/distributed effects matter. IBIS 8.0 defines a precedence from component RLC through more detailed interconnect models. |
| Passive component | Nominal ideal R/L/C for topology exploration. | Use manufacturer broadband S-parameter or equivalent circuit including ESR, ESL, SRF, DC bias, temperature, and mounting geometry. |
| Connector/cable | Vendor multiport S-parameters with correct pin map/reference. | Measure the actual mated connector/launch/cable or run full 3-D EM if the vendor model excludes the board launch. |
| RF active device | Bias-specific S-parameters for small signal. | Use noise parameters, nonlinear model, X-parameters/load-pull/harmonic-balance data for noise, compression, efficiency, or linearity. |

The [IBIS 8.0 specification](https://ibis.org/ver8.0/ver8_0.pdf) defines package and interconnect model choices; [Touchstone 2.1](https://ibis.org/touchstone_ver2.1/) defines an official exchange format for N-port network data, including mixed-mode and selectable reference impedances. Validate every imported file's version, port order, units, reference impedance, frequency span, passivity, causality, and DC/low-frequency behavior. Do not connect an S-parameter block by filename alone.

## Simulation and verification workflow

### 1. Before placement/routing

1. Record interface revision, topology, directionality, voltage/common mode, termination ownership, target impedance/tolerance, fastest edge or RF band, allowable loss/return loss, timing/eye/jitter limits, and absolute-maximum limits.
2. Obtain exact driver and receiver models. Map package/ball/pin names and I/O configuration.
3. Sketch every load, branch, connector, cable, terminator, and option/DNP state.
4. Build a pre-layout transmission-line simulation. Sweep terminator topology/value/placement, driver and receiver corners, line impedance/delay/loss, load capacitance, supply/temperature, and branch length.
5. Check every receiver, not only the far end. Measure threshold crossings, monotonicity, overshoot/undershoot duration, settling before sample, setup/hold or eye mask, current, and power.

### 2. During stackup and routing

1. Use the fabricator's proposed finished stackup in a field solver. Solve single-ended, differential/odd, and common/even modes as applicable.
2. Run sensitivities for etch width, dielectric thickness/Dk, copper, pair gap, mask, coplanar clearance, and nearby copper. Convert results into routable width/gap and clearance rules.
3. Add impedance net classes, layer restrictions, reference-plane rules, max via/stub/branch limits, termination placement, and tuning constraints to the EDA rule system.
4. Route critical nets first. Inspect the return path in every region and at every layer/reference transition.
5. Preserve the stackup/calculator/solver revision and fabrication assumptions with the design.

### 3. Post-layout extraction

1. Extract the routed geometry rather than resimulating ideal schematic lines.
2. Use 2-D models for long uniform sections and 3-D EM for vias, pads, connectors, tight bends, neck-downs, plane transitions, and coupled discontinuities.
3. Cascade package, board, connector, cable, and receiver models at consistent reference planes. Avoid double-counting a package or launch included in two different files.
4. Check S-parameter passivity/causality and sufficient high-frequency span before time-domain conversion. Poor extrapolation can create nonphysical ringing.
5. Re-run PVT/process/tolerance cases and compare to the original margin budget. A nominal eye is not release evidence.

### 4. Fabrication and laboratory verification

**TDR:** A TDR launches a fast step and converts returning voltage versus round-trip time into an impedance profile. Use it to locate opens/shorts and impedance discontinuities and to measure controlled-impedance coupons. [Tektronix's TDR primer](https://www.tek.com/en/documents/primer/tdr-test) explains that all displayed distance is derived from round-trip delay, that multiple reflections can corrupt a naive impedance readout in multi-section structures, and that differential measurements require deskew (**High**).

TDR procedure:

1. Define reference plane, step rise time, amplitude, source impedance, and time/distance conversion.
2. Calibrate or characterize cables/probes/launches; use a short, repeatable ground contact. Deskew differential sources.
3. Measure a same-panel coupon for process impedance, then a representative assembled/unassembled channel where accessible.
4. Apply rise-time filtering comparable to the application when deciding whether a narrow discontinuity is consequential, while retaining the fastest view for fault localization.
5. Gate/interpret connector and launch responses carefully; use deconvolution only with a validated method.
6. Report mean/variation over the defined coupon window, not a hand-picked cursor point.

**VNA/S-parameters:** A VNA measures magnitude and phase of reflection/transmission versus frequency. Calibrate to the desired reference plane with an appropriate method such as SOLT or TRL; then de-embed fixtures/launches only with validated standards/models. [Keysight's de-embedding note](https://www.keysight.com/nl/en/assets/7018-06806/application-notes/5980-2784.pdf) distinguishes the coaxial measurement plane from the device plane and explains fixture removal with network models (**High**).

VNA procedure:

1. Define port impedance, port order, frequency span, IF bandwidth, power, calibration method, and DUT state/bias.
2. Use a fixture/coupon designed for calibration or de-embedding; avoid long probe grounds.
3. Measure `S11/S22` and `S21/S12`; use mixed-mode conversion for differential channels with correct pair mapping and deskew.
4. Time-domain transform/gating can locate discontinuities, but gate choices trade spatial and frequency resolution and can create artifacts.
5. Compare measured and simulated data at the same reference planes and normalization. Investigate phase/delay as well as magnitude.

**Oscilloscope/functional test:** Probe both source and receiver with loading controlled. Verify actual edge rate, levels, ringing, monotonicity, settling, eye/jitter, and data error rate over supply, temperature, cable, and traffic patterns. A 10x passive probe with a long ground lead can manufacture the ringing being “debugged.”

## Required inputs and rules for an engineering agent

### Minimum input contract

An agent must obtain or explicitly mark missing:

```yaml
interface:
  name: exact interface and revision
  mode: single-ended | differential | RF one-port/two-port | mixed
  topology: point-to-point | fly-by | multidrop | star | bidirectional
  direction_and_idle_states: including reset, boot, tri-state, ODT
electrical:
  target_impedance: value, tolerance, mode, and reference plane
  rise_fall_time_or_band: fastest edge/corner or frequency/power band
  voltage_common_mode_thresholds: VOH/VOL/VIH/VIL or RF bias/power
  limits: overshoot, undershoot, current, settling, eye, jitter, BER, RL/IL
models:
  driver_receiver: vendor model, revision, package, corner, settings
  connector_cable_passives: model/revision/port map where relevant
pcb:
  fabricator_and_process: rigid/flex/HDI, finish, controlled-Z service
  finished_stackup: materials, thicknesses, copper/plating/mask
  route_geometry: layers, width/gap/clearance, length, vias, branches
  return_path: reference plane(s), transitions, stitching structures
verification:
  simulation_tool_and_model_scope: solver, extraction, corners
  measurement_plan: coupon, TDR/VNA/oscilloscope, reference planes
```

If the governing interface spec, exact device configuration, or finished stackup is absent, the agent may propose a study value but must label it **provisional** and must not claim the route is compliant or fabrication-ready.

### Machine-actionable rules

| Rule ID | Requirement | Severity / allowed exception |
|---|---|---|
| `IMP-001` | Every controlled-impedance net class shall identify the governing source, target value, mode, tolerance, layer/structure, and reference conductor. | **Error.** No exception for release; provisional values allowed only in exploration. |
| `IMP-002` | Determine electrical length from the fastest edge or occupied RF band, not nominal clock alone. | **Error** if omitted for a candidate high-speed/RF net. |
| `IMP-003` | Use the fabricator-approved finished stackup and field-solver result for production width/gap. | **Error.** Hand equations may seed, never approve. |
| `IMP-004` | Preserve continuous return path under/around every critical route; flag plane gaps, voids, edges, necks, and reference changes. | **Error.** Exception requires extracted/simulated evidence and system review. |
| `IMP-005` | Place source termination at the source and load termination at the physical load/end; calculate pin-to-component stub. | **Error** when placement exceeds the validated stub allowance. |
| `IMP-006` | Include package, receiver capacitance, terminator pads, vias, and branch/stub topology in consequential simulations. | **Error** above the model's screened lumped bandwidth. |
| `IMP-007` | For differential nets, check `Zdiff`, each leg/odd mode, skew, symmetry, common-mode return, and mode conversion as applicable. | **Error** to approve from differential impedance alone when asymmetry exists. |
| `IMP-008` | Validate imported IBIS/SPICE/S-parameter models: exact part/package/configuration, revision, port map, reference impedance, units, and frequency/condition range. | **Error.** Unknown provenance is not acceptable release evidence. |
| `IMP-009` | Sweep driver/receiver PVT, line/process tolerance, component tolerance/parasitics, and all population/ODT states. | **Error** for release-critical nets; scope may be risk-tailored and documented. |
| `IMP-010` | Evaluate DC current, logic levels, and resistor power for parallel/Thévenin/double termination; evaluate pattern droop for AC termination. | **Error.** |
| `IMP-011` | RF matching shall state the optimized objective and verify stability, bandwidth, loss, tolerance, and operating power; `S11` alone is insufficient. | **Error.** |
| `IMP-012` | Simulation and measurement shall use declared, consistent reference planes; avoid package/launch double counting. | **Error.** |
| `IMP-013` | Fabrication notes shall distinguish geometry tolerance, impedance tolerance, coupon acceptance, and fabricator trace-adjustment authority. | **Error.** |
| `IMP-014` | Do not infer compliance from a calculator result, nominal impedance, clean TDR coupon, or clean ERC/DRC alone. | **Release blocker** until system-level evidence exists. |

### Agent decision sequence

1. **Classify the objective:** digital edge integrity, RF power/gain/noise, or measurement reference.
2. **Identify the governing evidence:** current interface specification and exact component datasheets/models outrank the JLCPCB article and generic rules.
3. **Inventory the entire channel and return path.** Mark every reference plane and discontinuity.
4. **Screen electrical length**, then model any uncertain/consequential net.
5. **Select termination/matching topology** from direction, topology, DC bias, power, bandwidth, and objective.
6. **Solve with the real stackup and models.** Sweep corners and alternative populations.
7. **Convert results into layout and fabrication constraints.** Include allowed exceptions with evidence.
8. **Extract post-layout** and compare against pre-layout margin.
9. **Measure at defined reference planes** and reconcile discrepancies with the model.
10. **Report evidence status:** verified source text, calculation, simulation result, measured result, inference, and unresolved assumption must remain distinct.

### Exceptions and stop conditions

- **No exact device model:** use a bounded Thevenin/capacitance model only for exploration; request the vendor model or measure the output. Do not release on a guessed output resistance.
- **No fixed stackup:** create geometry ranges, reserve routing area, and block production width selection.
- **On-die termination:** verify enabled value/range, calibration, mode, and state sequencing; do not duplicate externally.
- **Very short breakout:** a non-nominal neck may be acceptable when 3-D/post-layout simulation shows margin; document length and geometry rather than silently waiving width.
- **Mixed reference planes:** prefer rerouting. If unavoidable, require an explicit return-transfer structure and broadband model.
- **Tuning network:** unpopulated pads are part of the RF/digital channel. Model the default and all permitted populations.
- **Coupon passes, channel fails:** accept that the coupon only validated the process section. Investigate launches, vias, packages, assembly, and reference transitions.
- **Good return loss, poor system result:** inspect insertion loss, group delay, mode conversion, crosstalk, receiver equalization, bias, and active-device stability.
- **Conflicting sources:** follow the current interface specification and exact device vendor requirement; record the conflict and do not average incompatible targets.

## Release checklists

### Design author

- [ ] Exact interface/device revision and impedance definition are recorded.
- [ ] Fastest edge or RF operating band/power is known; electrical length was evaluated.
- [ ] Driver, receiver, package, connector, cable, and passive models match the actual parts/configuration.
- [ ] The topology, all loads/branches/stubs, and both drive directions are represented.
- [ ] Termination ownership, value, bias, placement, DC power, and reset/ODT state are verified.
- [ ] Finished stackup and fabricator solver/calculator revision are archived.
- [ ] Width/gap/clearance rules include tolerance and nearby-copper assumptions.
- [ ] Every signal/reference layer change has a local return-transfer strategy.
- [ ] Post-layout extraction includes consequential discontinuities and corners.
- [ ] Threshold, timing/eye, overshoot, current/power, return loss, insertion loss, and stability criteria are met as applicable.
- [ ] Fabrication notes state impedance, mode, tolerance, coupon/report, and trace-adjustment authority.
- [ ] The measurement plan defines reference planes, calibration/de-embedding, and pass/fail limits.

### Independent reviewer

- [ ] Confirm that characteristic, source, load, input, and reference impedance are not conflated.
- [ ] Recalculate at least one reflection/termination and one power/current case.
- [ ] Compare the net-class target with the governing current spec/datasheet.
- [ ] Inspect the physical return path, not just the routed signal trace.
- [ ] Check source/load resistor placement and pad/via stubs at actual scale.
- [ ] Check pair symmetry, individual leg impedance, via/return-via symmetry, and mode conversion.
- [ ] Verify S-parameter port map/reference and IBIS package/corner/settings.
- [ ] Review corner sweeps and worst cases rather than the nominal eye/Smith chart only.
- [ ] Confirm the fab statement does not confuse geometry tolerance with impedance tolerance.
- [ ] Ensure coupon, TDR/VNA, and functional tests together cover process and complete-channel risks.

## Evidence gaps and limitations

| Gap | Impact | Required handling |
|---|---|---|
| The originally supplied JLCPCB URL is unavailable; the current blog page may be a rewritten successor. | Exact historical wording/images cannot be verified. | Cite the current title/date and preserve this limitation; do not attribute unseen text to the old page. |
| No project interface, device, stackup, route, model, or acceptance limits were supplied. | This dossier cannot select a production width, terminator, RF network, or claim compliance. | Apply the input contract to the actual design and current governing documents. |
| Many interface standards are revision-controlled or membership/licensing documents. | Generic blog example values may be stale or wrongly scoped. | Obtain the applicable authorized specification; do not copy the examples as rules. |
| Vendor application notes use specific devices and sometimes old processes. | Mechanisms remain useful, but numeric recommendations may not transfer. | Prefer the exact current component datasheet/model/reference design. |
| TDR coupons and VNA fixtures sample different structures/reference planes. | Results can disagree without either instrument being “wrong.” | Create a reference-plane map and correlate measurement with the same extracted geometry. |
| Hand calculations omit dispersive loss and 3-D fields. | They can underpredict mismatch, loss, and resonance. | Use them for sanity checks only; verify with field solver/extraction and measurement. |

## Primary-source ledger and claim map

“Primary” here means the current article/fabricator tool under review, an official industry specification, or first-party semiconductor/material/instrument documentation. These sources support mechanisms and tool/spec behavior; none approves a project that was not supplied.

| ID | Source, publisher/date | Material claims used | Scope / access note |
|---|---|---|---|
| P1 | [*Understanding Impedance Matching for High-Speed PCB Designs* — JLCPCB; published 2023-08-23, updated 2026-09-04](https://jlcpcb.com/blog/understanding-impedance-matching-for-high-speed-pcb-designs) | Article's definition, geometry factors, reference-layer and ordering guidance, and stated +/-20% width/spacing tolerance. | Vendor educational article; current replacement located from JLCPCB's index on 2026-09-06. Not normative. |
| P2 | [Original supplied article URL — JLCPCB](https://jlcpcb.com/blog/impedance-matching-in-pcb-layout) | Availability status only. | Returned HTTP 404 on 2026-09-06; no content attributed to it. |
| P3 | [*JLCPCB Impedance Calculator* — JLCPCB; accessed 2026-09-06](https://jlcpcb.com/pcb-impedance-calculator/) | Calculator inputs include layer/build, copper, target impedance, pair spacing, and coplanar clearance. | Fabricator-specific planning tool; output is not a channel-compliance certificate. |
| P4 | [*High-Speed Layout Guidelines*, SCAA082A Rev. A — Texas Instruments; 2006-11, revised 2017-08](https://www.ti.com/lit/an/scaa082a/scaa082a.pdf) | Propagation delay depends on dielectric/geometry; impedance discontinuities through source/trace/vias/connectors/sink reflect; termination classes; return-current continuity. | High confidence for mechanisms; layouts/values remain application-specific. |
| P5 | [*Design and Layout Guidelines for the CDCVF2505 Clock Driver*, SCAA045 — Texas Instruments/Kal Mustafa; 2000-11](https://www.ti.com/lit/an/scaa045a/scaa045a.pdf) | Round-trip/edge screening rule; series, parallel, Thévenin, and AC termination behavior; source placement; `RC` versus round-trip guidance. | First-party device application note. Its “no power” AC wording is interpreted as no steady DC path, not zero switching loss. |
| P6 | [*High-Speed Board Layout Guidelines*, AN 224 v1.2 — Altera/Intel; 2009-08](https://cdrdv2-public.intel.com/654465/an224.pdf) | Termination and routing topologies, stub-delay screen, series termination equation, differential termination, need for IBIS pre-layout simulation. | First-party FPGA guidance; device examples are old, mechanisms remain applicable. |
| P7 | [*RF Demystified—Understanding Wave Reflections* — Analog Devices/Anton Patyuchenko; date not displayed, accessed 2026-09-06](https://www.analog.com/en/resources/analog-dialogue/raqs/raq-issue-197.html) | Complex wave reflection coefficient, `ZL`/`Z0` boundary match, return loss, SWR, electrical-size distinction. | First-party RF tutorial; assumes a matched source in its introductory case. |
| P8 | [*Impedance Matching* glossary — Analog Devices; accessed 2026-09-06](https://www.analog.com/en/resources/glossary/impedance-matching.html) | Difference between reflectionless and conjugate matching; complex impedance notation. | First-party glossary; simplified definition expanded in this dossier. |
| P9 | [*Low-Noise Amplifier Stability—Concept to Practical Considerations, Part 2* — Analog Devices; accessed 2026-09-06](https://www.analog.com/en/resources/technical-articles/lownoise-amplifier-stability-concept-to-practical-considerations-part-2.html) | Simultaneous conjugate match, reverse-gain dependence, and tradeoff against noise/bandwidth/stability objectives. | First-party RF two-port analysis. |
| P10 | [*Impedance Matching and Smith Chart Impedance* — Analog Devices/Maxim; 2002, accessed 2026-09-06](https://www.analog.com/en/resources/technical-articles/impedance-matching-and-smith-chart-impedance-maxim-integrated.html) | Line input transformation, Smith chart, reactive/stub matching, frequency selectivity. | First-party tutorial; calculations remain idealized. |
| P11 | [*Impedance Matching Networks Applied to RF Power Transistors*, AN721 Rev. 1.1 — Freescale/NXP; 2005-10](https://www.nxp.com/docs/en/application-note/AN721.pdf) | L-section formulas, transformation Q/bandwidth, multi-reactance and quarter-wave options, warning that desired PA load is not simply device output resistance. | First-party RF application note; named products may be obsolete, as the document itself notes. |
| P12 | [*TDR Test* — Tektronix; accessed 2026-09-06](https://www.tek.com/en/documents/primer/tdr-test) | TDR reflection/impedance method, round-trip time, multiple-reflection limits, rise-time resolution, differential deskew and probe/ground effects. | First-party instrument primer; product capabilities vary. |
| P13 | [*Differential Impedance Measurements with the Tektronix 8000B Series Instruments* — Tektronix; 2003](https://download.tek.com/document/85W_16644_0.pdf) | Odd/even and differential/common definitions and relationships; averaged result can hide imbalance. | First-party application note; instrument is legacy, definitions/mechanisms remain useful. |
| P14 | [*De-Embedding and Embedding S-Parameter Networks Using a Vector Network Analyzer*, 5980-2784 — Keysight; publication date not displayed, accessed 2026-09-06](https://www.keysight.com/nl/en/assets/7018-06806/application-notes/5980-2784.pdf) | S-parameter wave ratios, coaxial measurement plane versus device plane, fixture effects, de-embedding. | First-party VNA application note. |
| P15 | [*RF Fundamentals, Part 3: RF Components and Measurements* — Rohde & Schwarz; accessed 2026-09-06](https://cdn.rohde-schwarz.com/ymkt/na/content/RF_fundamentals_seminar_materials/3_RF_Fun_-_Standing_Waves_Unc-Mismatch_VNA.pdf) | Conversion among `Γ`, positive return loss, VSWR, and impedance. | First-party instrument training material. |
| P16 | [*IBIS Version 8.0* — IBIS Open Forum; ratified 2025-12-05](https://ibis.org/ver8.0/ver8_0.pdf) | Official buffer/package/interconnect model structures and package-model precedence. | Current official specification located 2026-09-06. Tool support for optional constructs must be checked. |
| P17 | [*Touchstone File Format Specification Version 2.1* — IBIS Open Forum; ratified 2024-01-26](https://ibis.org/touchstone_ver2.1/) | Official N-port model exchange, mixed-mode formatting, selectable reference impedances. | Official specification landing page; file provenance and quality remain the model provider's responsibility. |
| P18 | [*How to Design a High-Speed, Transparent Differential Via* — Texas Instruments/T. K. Chin; 2015-06](https://www.ti.com/document-viewer/lit/html/SSZTCM4/GUID-17532CA9-A0AF-4401-8383-D3F4AE36A744) | Via as distributed/cascaded C-L-C structure; balance inductance/capacitance; use 3-D EM for impedance/bandwidth. | First-party technical article; no universal via dimensions. |
| P19 | [*Digging Deeper into Dielectric Constant for PCB Materials* — Rogers Corporation/John Coonrod; 2020](https://www.rogerscorp.com/blog/2020/digging-deeper-into-dielectric-constant-for-pcb-materials) | Dk depends on test method/frequency/conditions; material choice affects physical/electrical design. | First-party laminate-maker guidance; use the exact selected material datasheet. |

## Searches performed and stopping rationale

Research covered the supplied and replacement JLCPCB URLs, JLCPCB's current calculator, transmission-line and termination notes from TI/Intel, RF matching and reflection material from Analog Devices/NXP, current IBIS/Touchstone specifications, material guidance from Rogers, and TDR/VNA documentation from Tektronix/Keysight/Rohde & Schwarz. Follow-up searches specifically resolved electrical-length heuristics, termination placement/power, differential-mode definitions, via/package model fidelity, S-parameter reference planes, and the distinction between conjugate and reflectionless matching.

Research stopped because every requested claim family has primary support or a stated limit, the unavailable original URL is bounded by a verified 404 and a current same-topic JLCPCB successor, and further generic PCB-blog results repeated lower-authority advice. The remaining unknowns are necessarily design-specific: exact interface revision, device models, stackup, routing, fabrication process, and acceptance criteria.

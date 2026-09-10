# Evidence dossier: power integrity in PCB layout

**Research date:** 2026-09-06  
**Audience:** PCB designers, reviewers, and engineering agents responsible for delivering DC power from a source or regulator to the pins and die of analog, digital, RF, and power devices.  
**Scope:** Board-level power-distribution-network (PDN) design from the voltage-regulator module (VRM) through bulk and ceramic capacitors, copper, vias, package, and available die models. It covers DC loss, frequency-domain impedance, time-domain transients, layout, simulation, and measurement. It is not a regulator-design tutorial, thermal sign-off, EMC certification, or a substitute for current device and capacitor data.  
**Evidence key:** **High** = current standard, official device guide, component-manufacturer characterization, or instrument-maker measurement documentation directly supports the claim; **Medium** = defensible engineering synthesis that must be checked against the actual stackup, models, and load; **Low** = heuristic or missing-input estimate. **UNKNOWN** means a required project fact is absent; it never means zero or “typical.”

## Direct conclusion

Power integrity is not achieved by adding a habitual `100 nF` at every pin or by drawing a wide power polygon. A defensible design must satisfy three related but different requirements:

1. **DC:** every load sees an acceptable minimum/maximum voltage after source tolerance, copper/via/contact drop, remote-sense error, and load regulation are included; conductors and interconnects also remain within their temperature and current-density limits.
2. **AC/transient:** the impedance seen by each load remains low enough over the load-current spectrum that droop, overshoot, ripple, and ground/power bounce remain inside the device's rail budget.
3. **Control and stability:** the regulator, its output network, remote-sense route, and downstream filters/capacitance form a stable system over line, load, temperature, tolerance, and operating-mode corners.

The practical workflow is therefore: allocate the voltage budget; obtain a real current step and edge rate; calculate a first target impedance; model the VRM, mounted capacitors, board, package, and die as far as models permit; suppress rather than merely move resonances; verify DC and AC at the load; then correlate the model to the assembled board. The target-impedance line is a useful first-order constraint, not a guarantee that every time-domain waveform or silicon mode will pass.

## Status of the required JLCPCB article

The assigned URL, [*Power Integrity (PI) in PCB Layout*](https://jlcpcb.com/blog/power-integrity-pi-in-pcb-layout), returned HTTP 404 during this research, so its publication metadata and full text could not be verified. An indexed passage in JLCPCB's later [*PCB Design Rules and Guidelines*](https://jlcpcb.com/blog/pcb-design-rules-best-practices) preserves the apparent core message: modern ICs demand current quickly; poor PI causes droop/noise/failure; use low-inductance distribution, a solid plane on multilayer boards, bulk capacitance for slower variation, and smaller capacitors close to IC power pins for higher frequencies. Those are useful introductory ideas (**Medium**, fabrication-vendor summary), but the fixed `1–10 µF`, `0.1 µF`, and `0.01 µF` categories are not universal design requirements.

Retain from that baseline:

- Provide a short, low-inductance current path and a continuous return path.
- Put local energy storage at the load, and provide slower bulk energy storage near the regulator or entry point.
- Treat rail noise and droop as layout-dependent, not just schematic-dependent.
- Use planes where their continuity, geometry, and stackup actually lower impedance.

Do **not** infer from the baseline that every IC needs the same capacitor values or count, that the smallest nominal capacitor is always the highest-frequency solution, that a power plane is automatically low impedance at all frequencies, or that passing a generic checklist replaces device-specific analysis.

## 1. Definitions and system boundary

| Term | Working definition | Boundary or common mistake |
|---|---|---|
| Power integrity (PI) | Delivering voltage/current to every load pin within its static and dynamic limits for all required operating states. | “Clean at the regulator” is not “clean at the die.” |
| PDN/PDS | Source/VRM, output network, connectors, traces/planes, vias, discrete capacitors, package, and on-die distribution/capacitance. | Excluding package/die can hide the highest-frequency resonance. |
| Point of load (POL) | The electrical observation point at the load pins or a vendor-defined sense/probe location. | A remote board test point may not represent BGA pin voltage. |
| Target impedance | First-order maximum allowable rail-voltage disturbance divided by the associated current change, usually considered versus frequency. | It depends on the **AC** budget and a defined transient, not nominal current alone. |
| Transfer impedance | Voltage at one port divided by current injected at another. | Self-impedance alone cannot expose noise coupling between distant loads/rails. |
| Mounting/loop inductance | Inductance of pads, traces, vias, plane spreading, and return path added around a component. | Capacitor datasheet ESL alone omits it. |
| Anti-resonance | Parallel-like high-impedance peak created by interacting capacitive and inductive stages. | More or more-varied capacitors can make a peak worse. |
| SSN/SSO | Simultaneous-switching noise/output behavior, including power/ground bounce through shared die/package/board impedance. | Clock frequency alone does not predict it; I/O count, slew, drive, pattern, package, and loading matter. |

The [AMD Versal target-impedance guidance](https://docs.amd.com/r/en-US/ug863-versal-pcb-design/Target-Impedance) explicitly separates the rail's DC/VRM allocation from its AC ripple allocation and recommends full board-level PDN simulation. The [IBIS 7.1 specification](https://ibis.org/ver7.1/ver7_1.pdf) provides formal constructs for pin/package and on-die PDN information, but model availability and fidelity remain supplier-specific. Consequently, the board boundary should be explicit in every analysis plot: for example, `VRM output pads → BGA balls`, `BGA balls → die load port`, or `complete source → die probe`.

## 2. Turn voltage requirements into a budget

Start from the current datasheet's allowable voltage at the specified observation point. For each rail and operating mode, record:

```text
Vnom
Vmin, Vmax and whether they apply at VRM, package balls, or die
source set-point accuracy and temperature drift
load/line regulation allocation
DC distribution-drop allocation
AC ripple/noise allocation, including regulator ripple if specified separately
measurement bandwidth and any vendor-defined filter
load-current states, delta-I, rise/fall time, repetition/pattern, and concurrency
startup, shutdown, sequencing, pre-bias, discharge, and fault limits
```

One useful budget is

```math
\Delta V_{total} = \Delta V_{set} + \Delta V_{line/load} + \Delta V_{DC\ path}
                 + \Delta V_{ripple} + \Delta V_{transient} + \Delta V_{coupled}
```

Worst-case signs matter: add contributors that can align in the same direction; do not root-sum-square deterministic tolerances merely to create margin. Also check the upper rail limit during load release, startup, and mode change.

For a defined current change, the first-order target is

```math
Z_{target} = \frac{\Delta V_{AC,allow}}{\Delta I_{step}}
```

or, when only a justified ripple fraction is available,

```math
Z_{target} = \frac{V_{nom}\,p_{AC}}{\Delta I_{step}}.
```

This relationship is documented in [TI's OMAP/AM37xx PDN design report SPRABJ7](https://www.ti.com/lit/an/sprabj7/sprabj7.pdf), [Intel AN 958](https://docs.altera.com/r/docs/683073/current/an-958-board-design-guidelines/target-impedance-decoupling-method), and [AMD UG863](https://docs.amd.com/r/en-US/ug863-versal-pcb-design/Target-Impedance). Those device guides do **not** license inventing a percentage for a different IC. Use the rail's actual specification and the IC vendor's current-step assumptions where available.

### Worked target-impedance example

A 0.80 V core rail allows ±3% total variation. The design allocates ±1% (8 mV) to source accuracy/DC effects and ±2% (16 mV) to dynamic disturbance. The credible worst concurrent step is 32 A, not the 48 A absolute steady-state maximum.

```math
Z_{target}=16\text{ mV}/32\text{ A}=0.5\text{ m}\Omega.
```

If the 32 A figure is unavailable, the target is **UNKNOWN**. Substituting 48 A produces a conservative `0.333 mΩ` only if 48 A can actually switch together; substituting an average current can be dangerously optimistic. State which interpretation was used.

### Why a horizontal target is incomplete

For a linear time-invariant representation,

```math
V(f)=Z(f)I(f), \qquad v(t)=z(t)*i(t).
```

Holding `|Z(f)|` under a scalar target over the relevant band is a strong screening condition, but phase, current spectrum, multiple ports, nonlinear regulator limits, control-mode changes, package/die observation point, and time-varying activity still affect the time waveform. A flat or intentionally damped impedance profile reduces the risk of a narrow resonant “rogue wave”; [Keysight's flat-impedance note](https://www.keysight.com/us/en/assets/3119-1097/application-notes/5992-4272.pdf) emphasizes avoiding high-Q peaks rather than maximizing capacitor count.

## 3. Load transients: define the excitation before choosing capacitors

A current step is characterized by at least `Ibefore`, `Iafter`, rise time, fall time, pulse width, repetition rate, duty cycle, and which loads switch concurrently. A fast edge contains energy well above the application clock. A bandwidth estimate such as `0.35/tr` is only an edge-model convention, not an automatic PDN sign-off frequency. Use the vendor's current waveform or a measured workload spectrum when available.

The leading disturbance can be decomposed approximately as

```math
\Delta V_{ESR}=\Delta I\,R_{path},
\qquad
\Delta V_L=L_{path}\frac{dI}{dt},
\qquad
\Delta V_C\approx\frac{\Delta I\,\Delta t}{C_{effective}}.
```

[Analog Devices AN66](https://www.analog.com/media/en/technical-documentation/application-notes/an66f.pdf) shows the ESR and inductive contributions at the leading edge of a measured load transient, including trace parasitics. These terms are not independent forever; the complete RLC/control network determines ringing and recovery.

### Worked edge example

A load rises by 3 A in 2 ns. The effective path from local capacitors to load has 180 pH and 3 mΩ:

```math
\Delta V_L=180\text{ pH}\times(3\text{ A}/2\text{ ns})=270\text{ mV}
```

```math
\Delta V_{ESR}=3\text{ A}\times3\text{ m}\Omega=9\text{ mV}.
```

The result is intentionally sobering: board capacitors alone may not serve a nanosecond die edge through package inductance. On-package/on-die capacitance and package current sharing are part of the solution. If the actual edge at the package pins is slower because the die/package supplies charge, use that vendor model; do not apply the external-pin step directly to every PDN stage.

### Charge-hold-up example

If a local network must supply 4 A for 8 µs before the regulator substantially responds and only 40 mV of additional droop is allowed:

```math
C_{min}=\frac{4\text{ A}\times8\ \mu\text{s}}{40\text{ mV}}=800\ \mu\text{F}.
```

That is effective, in-circuit capacitance. Add tolerance, DC-bias, temperature, aging, and ESR/ripple-current derating; then verify that the regulator permits it and remains stable. The result does not say `800 µF` should sit at every IC pin.

## 4. Frequency ownership: VRM, bulk, midband, board, package, die

No universal frequency boundary exists, but responsibility usually transitions as follows:

| Region | Dominant source of low impedance | Design focus |
|---|---|---|
| DC to low frequency | VRM/source and feedback | Set point, current rating, loop gain, remote sense, DC copper/contact loss |
| Low to mid frequency | VRM output network and bulk capacitance | Charge reserve, ESR/damping, ripple current, regulator stability |
| Mid to high frequency | Mounted MLCC array and tightly coupled planes | Effective C, ESL, mounting/spreading inductance, anti-resonance |
| Higher frequency | Board planes, package, on-package/on-die capacitance | Distributed modes, package-pin sharing, die model, observation point |

This is a continuum, not a prescription to place one capacitor value per decade. AMD's current [Power Design Manager guidance](https://docs.amd.com/r/en-US/ug1556-power-design-manager/Power-Delivery-Design) supplies device- and utilization-dependent values and still recommends simulation of quantity and placement. Intel's [device-specific PDN tool guide](https://cdrdv2-public.intel.com/654614/ug_pdn_other_device.pdf) includes capacitor ESR/ESL, custom mounting inductance, bulk capacitors, and spreading R/L. Use the corresponding current tool or guide for the exact device.

## 5. VRM and control-loop behavior

The VRM is not an ideal voltage source plus a current rating. Required checks are:

- input-voltage range, output set point, DC tolerance, current limit, thermal limit, efficiency, and transient load;
- control mode across light/heavy load, pulse-skipping or discontinuous modes, switching frequency, minimum on/off time, and duty-cycle saturation;
- loop crossover/phase margin and output impedance across line, load, temperature, and component tolerance;
- permitted output-capacitance range, ESR range, capacitor chemistry, and minimum/maximum effective capacitance;
- remote-sense topology, stability limits, sense-current/bias error, and routing/connection at the intended load;
- startup into the full capacitor bank, inrush, pre-bias, soft-start, sequencing, tracking, discharge, and load-release overshoot.

In the linear region,

```math
Z_{out,closed}(s)\approx\frac{Z_{out,open}(s)}{1+T(s)},
```

where `T(s)` is loop gain. Below crossover, feedback can reduce output impedance; above it, local capacitance and interconnect dominate. [TI's load-transient discussion](https://www.ti.com/document-viewer/lit/html/SSZTCQ4) relates closed-loop output impedance, bandwidth, and effective biased capacitance. [Analog Devices AN76](https://www.analog.com/media/en/technical-documentation/application-notes/an76.pdf) explains that large/fast steps can rail or slew-limit the error amplifier, temporarily invalidating small-signal loop reasoning.

Therefore:

- Do not claim a higher bandwidth automatically cures the transient; stability margin, switching frequency, delays, noise gain, duty-cycle/inductor slew, and large-signal limits constrain it.
- Do not add arbitrary low-ESR ceramics to an older LDO or converter. Some regulators require a particular C/ESR window; others tolerate ceramics. Follow the exact datasheet and validate the assembled network.
- Treat a ferrite bead plus downstream capacitor bank as an additional filter with DC drop, current/temperature derating, saturation/nonlinearity, and possible resonance. Simulate with the bead's bias-dependent impedance and provide damping if required.
- Route positive and negative remote-sense lines as a quiet Kelvin pair to the defined load node, away from switch nodes/inductors; do not let load current share their copper. Obey vendor RC-filter and maximum sense-offset rules.

## 6. Real capacitors, mounting inductance, and anti-resonance

The first-order series model is

```math
Z_C(j\omega)=R_{ESR}+j\left(\omega L_{ESL}-\frac{1}{\omega C}\right)
```

with self-resonance

```math
f_{SRF}=\frac{1}{2\pi\sqrt{L_{ESL}C}}.
```

Below SRF the element is mainly capacitive, near SRF its impedance floor is governed by ESR/loss, and above SRF it is mainly inductive. [Murata's capacitor impedance guide](https://article.murata.com/en-eu/article/impedance-esr-frequency-characteristics-in-capacitors) documents this behavior and shows that smaller or reverse-geometry parts can reduce ESL. Real wideband models may require frequency-dependent loss and distributed elements; prefer manufacturer S-parameter or SPICE models over a single catalog ESR number.

### Effective capacitance, not label value

For every candidate capacitor, evaluate:

- tolerance and lot distribution;
- DC-bias derating at the actual rail voltage;
- temperature coefficient and operating range;
- aging for Class II ceramics;
- ripple-current/self-heating limit;
- voltage rating and transient margin;
- ESR/ESL versus frequency;
- package, land pattern, orientation, and mounting inductance;
- flex-crack/short-failure and reliability requirements where consequential.

[TDK's dynamic DC-bias model note](https://www.tdk-electronics.tdk.com/en/373812/tech-library/articles/tools-services/tools-services/dynamic-dc-bias-model-for-accurate-circuit-simulation/1035570) states that high-permittivity Class II MLCC capacitance changes with applied DC voltage and provides bias-aware models. Nominal `22 µF` is not analysis data.

### Parallel parts

For `N` identical capacitors with independent, equal paths and negligible common inductance, the idealized bank has:

```math
C_{eq}=NC,\quad R_{eq}=R/N,\quad L_{eq}=L/N.
```

Common via/neck/plane inductance does not divide by `N`; it can set the high-frequency floor. Unequal paths cause unequal current sharing. Parallel placement should therefore minimize both each local loop and the bank's shared bottleneck.

### Anti-resonance

Combining capacitor values and interconnect inductances can create a high-Q impedance peak between their self-resonances. AMD's [capacitor anti-resonance guidance](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Capacitor-Anti-Resonance) explicitly notes interaction between discrete capacitors, intrinsic capacitance, parasitic inductance, and plane capacitance. Avoid the folklore “one each of 10 µF, 1 µF, 100 nF, and 10 nF makes broadband decoupling.” It can produce a worse peak than repeated, well-damped values.

Mitigations, verified by impedance simulation/measurement, include:

- reduce mounting and common inductance;
- use multiple identical optimized parts where that creates a flatter profile;
- choose values/ESR to overlap without a high-Q crossover;
- introduce controlled damping (appropriate ESR, damping branch, or lossy component) without violating loss/transient requirements;
- improve plane pair geometry or move/segment the relevant resonance only after transfer-impedance consequences are understood;
- change capacitor placement/count based on port response, not only total capacitance.

Never “fix” a peak by random capacitor addition. Re-run the complete impedance matrix and transient cases.

## 7. Layout: minimize the complete current loop

The relevant path is load power pin → load/package/die → ground pin → ground path → capacitor ground terminal → capacitor → capacitor power terminal → power path → load power pin. “Close” means electrically low loop inductance, not merely small center-to-center distance.

Placement and routing rules:

1. **Start with the device guide and pin field.** Assign required capacitors to rail/pin groups, account for embedded/package capacitors, and use the vendor's preferred BGA-side/topology when specified.
2. **Place the highest-frequency board capacitors at the smallest achievable loop.** Prefer direct pad-to-via connections, short/wide necks, power and ground vias adjacent to the respective terminals, and paired vias that minimize enclosed area.
3. **Use via-in-pad or reverse-geometry capacitors only when fabrication/assembly capability and reliability rules support them.** Filled/capped requirements, solder wicking, inspection, and cost are manufacturing facts, not PI details to ignore.
4. **Avoid thermal reliefs in critical high-current/high-frequency capacitor and regulator paths unless assembly constraints require them.** Spokes add resistance and inductance. Confirm solderability and heat spreading with manufacturing/thermal reviewers.
5. **Do not share a narrow neck or single via among several capacitors.** Independent short connections generally preserve parallel benefit. Add vias near pads; [Analog Devices' hot-loop study](https://www.analog.com/en/resources/analog-dialogue/raqs/raq-issue-207.html) found vias nearest key terminals most effective and notes that benefit is not linear with via count.
6. **Minimize switching-converter hot loops separately.** Keep the input high-frequency capacitor directly across the commutating switch loop; keep switch-node copper only as large as electrical/thermal needs require and away from feedback/sense/quiet rails.
7. **Place bulk for its job.** Bulk near the VRM/load cluster or connector controls slower energy delivery and cable/source inductance; it need not displace the lowest-inductance capacitors from BGA escape space.
8. **Preserve continuous return paths.** High-frequency signal return current concentrates near its trace/reference. Do not route a high-speed signal over a plane gap; when a reference-plane change is unavoidable, provide a nearby return transition appropriate to the two reference conductors. [TI's AFE79xx layout guide](https://www.ti.com/kr/lit/pdf/sbaa405) documents the detour/EMI/SI risk and nearby stitching-capacitor case.
9. **Separate high-current DC paths from precision references by topology.** A solid plane has finite impedance; direct motor/LED/PA return current away from ADC references and sense grounds without creating an uncontrolled high-frequency return discontinuity.
10. **Make testability part of layout.** Reserve paired power/ground pads, miniature coax connectors, load-step access, Kelvin DC points, and optional capacitor footprints at electrically meaningful ports.

AMD's [capacitor-placement explanation](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Capacitor-Placement-Background) relates greater separation and loop area to inductance while also warning that distributed propagation/phase matters. Distance-only ranking is insufficient on large or high-frequency plane structures.

## 8. Planes are distributed structures

For a simple overlapping power-ground pair,

```math
C_{plane}\approx\epsilon_0\epsilon_r\frac{A}{h}.
```

Reducing dielectric separation `h`, increasing overlap area `A`, and using the actual frequency-dependent dielectric properties increases plane capacitance. A tightly coupled plane pair can provide low-inductance local field storage, but it is not an equipotential “infinite capacitor.” Feed location, load location, antipads, slots, necks, voids, edge shape, dielectric loss, and mounting ports create spreading impedance and cavity modes.

For an ideal rectangular uniform cavity with sides `a`,`b`, a rough modal estimate is

```math
f_{mn}\approx\frac{c}{2\sqrt{\epsilon_r}}
\sqrt{\left(\frac{m}{a}\right)^2+\left(\frac{n}{b}\right)^2},
```

but real boundaries, losses, ports, cutouts, and dispersive material shift and damp the modes. Use a 2.5D/3D field solver or measurement for consequential designs.

Plane-layout checks:

- specify finished dielectric thickness, Dk/loss model, copper thickness, roughness if relevant, and fabrication tolerance;
- include all voids, splits, antipads, via fields, narrow bridges, connector launches, and regulator/load/capacitor ports;
- evaluate self-impedance at each critical load and transfer impedance between loads/aggressors;
- avoid long slotted return paths made by dense antipad rows; add ground stitching paths where electrically/manufacturing feasible;
- keep power and its associated return plane adjacent when using them as a pair; a distant “power plane” may contribute substantial spreading inductance;
- do not use a plane split as a universal analog/digital cure. Partition placement and current paths first; maintain intentional high-frequency returns.

TI's [Power Delivery Network Analysis report SWPA222A](https://www.ti.com/lit/pdf/swpa222) and [SPRABJ7](https://www.ti.com/lit/an/sprabj7/sprabj7.pdf) show EM extraction of capacitor loop inductance and impedance-based iteration. Use the actual post-layout geometry, not a plane-area capacitance calculation alone.

## 9. DC drop, current density, and temperature

For a uniform rectangular copper segment,

```math
R=\rho\frac{\ell}{wt},\qquad \Delta V=IR,\qquad P=I^2R,
\qquad J=\frac{I}{wt}.
```

These are screening equations. Current crowds at neck-downs, via entries, pad corners, thermal spokes, plane slots, and connector pins; copper resistivity rises with temperature; plating and finished thickness vary; nearby copper and dielectric change heat spreading.

### Worked DC example

A 50 mm long, 5 mm wide, 35 µm thick copper path at 20 °C, using `ρ≈1.724×10⁻⁸ Ω·m`, has

```math
R\approx1.724\times10^{-8}\frac{0.05}{0.005\times35\times10^{-6}}
 \approx4.93\text{ m}\Omega.
```

At 8 A this is about `39.4 mV` drop and `0.315 W`. That calculation excludes necks, vias, connector/contact resistance, copper-thickness tolerance, and hot resistance. On a 1.0 V rail it already consumes nearly 4%.

[IPC-2152](https://www.ipc.org/TOC/IPC-2152.pdf) is an empirical guide relating current, finished conductor size, and acceptable temperature rise. IPC's current revision table marks IPC-2152 “No Longer Maintained,” so document the selected standard/revision and do not apply a web trace-width calculator as a certification. For high current or tight voltage budgets, run DC electrothermal analysis with actual geometry and boundary conditions, then correlate temperature and drop on hardware.

Minimum DC sign-off includes:

- source-to-load and return-path drop at worst simultaneous steady current;
- every plane neck, trace, via array, fuse, connector, shunt, bead, and protection FET;
- current sharing among parallel vias/pins/connectors and loss of a path if required by reliability goals;
- copper temperature coefficient and maximum board/ambient temperature;
- local current density and temperature at constrictions, not just average trace width;
- remote-sense location and maximum compensable drop;
- minimum rail at load and maximum rail at low load after sense compensation.

## 10. Return paths, shared impedance, and simultaneous switching

Current always forms a loop. At low frequency it tends toward least resistance; at higher frequency mutual inductance concentrates return current close to the outgoing signal/reference geometry. A plane cut or reference change increases loop area and shared inductance, converting current change into voltage noise and radiation.

SSN/SSO is especially sensitive to package inductance and shared rail paths. [AMD UG861](https://docs.amd.com/r/en-US/ug861-ultrascale-selectio/Simultaneous-Switching-Outputs) explains that many same-direction switching outputs create cumulative current transients across bump/die/package/ball inductance and that socket inductance invalidates its normal soldered-board assumption. Inputs required for credible analysis include I/O standard, bank, pin placement, number and direction switching, drive strength, slew, termination, loading, activity pattern, package, socket, and board PDN. Reduce avoidable slew/drive, spread outputs per device guidance, select suitable pins/banks, terminate correctly, and use the vendor's SSN tool. Vendor SSN estimates identify risk; AMD explicitly says they are not final system sign-off.

Shared impedance also couples unrelated loads:

```math
V_{victim}(f)=Z_{transfer,aggressor\rightarrow victim}(f)I_{aggressor}(f).
```

Thus a rail can pass its own self-impedance target yet fail because a converter switch node, memory bank, radio PA, motor driver, or neighboring rail injects through shared return/package/plane structures. Evaluate the impedance matrix and representative concurrent workloads.

## 11. Package and die models

At high frequency, the load does not see the board capacitor directly. The path includes BGA balls, vias, package planes/traces, bumps, on-die grid, and on-die/on-package capacitance. A single package `R-L-C` may be adequate for scoping but cannot represent all pin coupling, distributed behavior, or per-region die loads.

Preferred model hierarchy:

1. device-vendor PDN S-parameter or validated multiport model, with pin grouping and reference definition;
2. package model plus explicit on-die capacitance/load-current model;
3. IBIS package/power-aware data where applicable;
4. vendor-stated lumped R/L/C bounds;
5. a clearly labeled estimate used only for sensitivity analysis.

The [IBIS 7.1 specification](https://ibis.org/ver7.1/ver7_1.pdf) permits package and PDN-related constructs, including on-die capacitance use in PI analysis. A model still needs correct port mapping, rail domains, current source locations, probe nodes, DC behavior, frequency range, and causality/passivity. Confirm whether grouped pins hide spatial effects, whether the model includes the board/package capacitor, and whether its reference is an ideal ground or explicit VSS network.

Do not double count package/on-die capacitance. Do not extrapolate an S-parameter model far beyond its validated range without a documented causal/passive extension. If the supplier does not release a package/die model, preserve that as a sign-off limitation and sweep plausible bounds; do not manufacture “typical” pH/nF values.

## 12. Simulation workflow

### Pre-layout

- Create a rail table and budget; identify required self- and transfer-impedance ports.
- Model VRM output impedance/control behavior, bulk and candidate MLCCs with bias-aware models, estimated mounting paths, connector/cable/source inductance, package/die model, and load current.
- Sweep capacitor technology/count/value/ESR and path inductance. Seek a low, damped impedance profile rather than deep notches.
- Run time-domain startup, load increase/release, repetitive burst, mode transition, and fault cases.
- Check VRM loop stability separately with the exact output/filter network and vendor-recommended method.

### Post-layout

- Import the actual stackup, material properties, copper, antipads, cutouts, pours, via barrels, pads, capacitor/VRM/load ports, and package interface into a field solver.
- Extract DC resistance/current density and AC multiport Z/S parameters. Preserve enough ports to find spatial sensitivity; indiscriminate pin grouping can hide it.
- Combine extracted board data with measured/vendor capacitor models, VRM model, and package/die/load models.
- Sweep component, fabrication, voltage, temperature, and activity corners. Include DC-bias loss and plausible mounting/plane variation.
- Inspect magnitude **and phase**, resonant mode/current-density/field plots, and self/transfer impedance at every critical port.
- Transform to time domain only with models that have adequate bandwidth, sensible DC extrapolation, causality, and passivity.

### Minimum acceptance plots

For each critical rail retain:

- DC voltage/drop/current-density/temperature results at min/max operating conditions;
- `|Zself(f)|` at VRM, major capacitor groups, package balls, and vendor-defined die/load port;
- worst relevant transfer impedances;
- VRM loop gain or vendor stability evidence with the realized C/ESR/filter;
- transient waveforms at load increase and release, including startup/mode change if applicable;
- tolerance/corner envelope and explicit model-boundary diagram;
- correlation overlay against board measurement.

## 13. Measurement and probing

### DC and thermal

- Use four-wire/Kelvin resistance or voltage-drop measurement for milliohm paths; ordinary probe-lead/contact resistance can dominate.
- Force the defined current through the real connector/pin/via path and sense at the specified load point.
- Measure after thermal equilibrium at worst ambient/cooling state; map hot spots with calibrated thermocouples/IR methods and account for emissivity.
- Compare cold and hot resistance and reconcile discrepancies with copper/contact/connector models.

### Time-domain rail waveform

Measure across power and ground at the load with the smallest practical loop. Long passive-probe ground leads add inductance, ring, and pick up fields. [Tektronix's probing note](https://www.tek.com/en/documents/application-note/probing-techniques-accurate-voltage-measurements-power-converters-oscillos) recommends short ground paths; its [power-rail measurement note](https://www.tek.com/ru/documents/application-note/getting-started-power-rail-measurements-application-note) emphasizes low-inductance solder-in/coax connections, low noise, DC offset, bandwidth, and loading.

Record:

- exact probe, tip, attenuation, input mode, termination, offset, bandwidth limit, sample rate, acquisition mode, and calibration;
- the point and orientation of power/ground connection;
- DC-coupled full rail plus high-sensitivity view when instrument range permits;
- both increase and release transients, enough records to catch asynchronous worst cases, and correlation to current;
- scope/probe noise floor and a shorted-input baseline.

Bandwidth limiting can remove real spikes; unlimited bandwidth can include unrelated pickup. Report both when needed and compare only under the device vendor's specified measurement bandwidth/filter.

### Frequency-domain impedance

A one-port 50 Ω reflection measurement loses sensitivity as a PDN approaches milliohms. [Keysight's ultra-low PDN measurement note](https://www.keysight.com/sg/en/assets/7018-08474/application-notes/5989-5935.pdf) describes a two-port method capable of resolving well below 1 Ω and explains the 1-port mismatch limitation. In an ideal 50 Ω two-port shunt-through setup,

```math
Z_{DUT}=\frac{Z_0S_{21}}{2(1-S_{21})}
       =25\ \Omega\frac{S_{21}}{1-S_{21}}
```

for complex `S21` and `Z0=50 Ω`. Use the instrument/method's exact conversion and fixture definition.

Practical requirements:

- calibrate/de-embed to the paired DUT pads or connector reference plane;
- use separate source/sense contacts at the same rail port to reduce shared contact/lead error;
- protect the analyzer from rail DC with properly rated DC blocks and address port-to-port/common-mode ground loops with the validated isolation/common-mode fixture;
- set source power/IF bandwidth/averaging so the response is above the noise floor but does not drive the active VRM nonlinear;
- measure the unpowered passive network and, where safe/required, the biased active VRM/PDN under specified load;
- include low enough frequency to overlap VRM control behavior and high enough frequency to capture package/plane resonances, using compatible instruments/fixtures across bands;
- validate the setup on known standards, measure fixture residual, and repeat after moving/reconnecting cables;
- compare the same ports and boundary as simulation.

### Load-step test

Place the dynamic load physically at the intended load port or characterize its fixture inductance. Measure current and voltage with matched timing. Sweep amplitude, slew, pulse width, repetition, input voltage, base load, temperature, and regulator mode. [Analog Devices AN133](https://www.analog.com/media/en/technical-documentation/application-notes/an133f.pdf) is a primary example of a controlled wideband active-load implementation; it also illustrates why a generic bench electronic load may be too slow.

## 14. Release checklist and decision rules

### Required release evidence

- [ ] Every rail has `Vnom`, limits, observation point, DC allocation, AC allocation, and measurement bandwidth.
- [ ] Every critical rail has defined steady current, credible `ΔI`, rise/fall time, pulse/burst, and concurrency assumptions.
- [ ] Regulator current/thermal/startup and C/ESR/stability limits pass with effective components.
- [ ] DC IR/current-density/electrothermal analysis covers forward and return paths, vias, connectors, protection, and temperature.
- [ ] Mounted capacitor models include bias, tolerance, ESR/ESL, land/vias, spreading, and shared inductance.
- [ ] Post-layout self-impedance meets the justified target over the justified band, or exceptions are tied to time-domain/current-spectrum evidence.
- [ ] Anti-resonance peaks and plane/package modes are below budget or demonstrably unexcited with margin.
- [ ] Transfer impedance and concurrent aggressor cases have been evaluated.
- [ ] Package/die model source, revision, ports, grouping, and missing physics are recorded.
- [ ] SSN/SSO analysis uses actual bank/pin/slew/drive/termination/pattern data.
- [ ] Remote sense, return continuity, switching hot loops, and test ports pass layout review.
- [ ] Hardware DC, transient, impedance, and temperature measurements correlate to analysis at the same ports.
- [ ] Residual UNKNOWNs and their release authority/waiver are explicit.

### Fail or stop conditions

Stop release rather than auto-approving when any of these is true:

- no rail limit or no definition of where/how it is measured;
- transient current/rise time is unknown for a low-voltage/high-current programmable device;
- regulator output network violates the datasheet's allowed capacitance/ESR or lacks stability evidence;
- a resonance above target is dismissed because “there are many capacitors”;
- capacitor selection uses nominal value only despite meaningful DC bias;
- DC drop/current-density result omits a connector, via bottleneck, return path, or hot resistance;
- simulation omits available package/die models or silently substitutes invented parasitics;
- measurement uses a long ground lead or unspecified bandwidth to claim a millivolt result;
- simulation and measurement ports/boundaries differ and no de-embedding/correlation is supplied.

## 15. AI/automation contract: required inputs and UNKNOWN behavior

An agent may calculate, compare, flag, and propose experiments; it must not invent device activity or approve a rail from a generic capacitor recipe.

### Minimum machine-readable input

```yaml
rail:
  name: REQUIRED
  v_nom_V: REQUIRED
  v_min_V: REQUIRED
  v_max_V: REQUIRED
  limit_observation_point: REQUIRED   # die, package balls, PCB pads, regulator
  limit_measurement_bandwidth_Hz: UNKNOWN_ALLOWED
  dc_budget_V: REQUIRED_OR_UNKNOWN
  ac_budget_V: REQUIRED_OR_UNKNOWN
load:
  i_min_A: REQUIRED_OR_UNKNOWN
  i_max_A: REQUIRED_OR_UNKNOWN
  delta_i_A: REQUIRED_OR_UNKNOWN
  rise_time_s: REQUIRED_OR_UNKNOWN
  fall_time_s: REQUIRED_OR_UNKNOWN
  pulse_width_s: REQUIRED_OR_UNKNOWN
  repetition_or_spectrum: REQUIRED_OR_UNKNOWN
  simultaneous_modes: REQUIRED_OR_UNKNOWN
vrm:
  exact_part_and_revision: REQUIRED
  control_modes: REQUIRED_OR_UNKNOWN
  switching_frequency_range_Hz: REQUIRED_OR_UNKNOWN
  allowed_cout_and_esr: REQUIRED_OR_UNKNOWN
  loop_model_or_measurement: REQUIRED_OR_UNKNOWN
  remote_sense_rules: REQUIRED_OR_UNKNOWN
capacitors:
  manufacturer_part_number: REQUIRED
  quantity_and_location: REQUIRED
  effective_C_vs_bias_temp_age: REQUIRED_OR_UNKNOWN
  impedance_or_spice_sparameter_model: REQUIRED_OR_UNKNOWN
  mounting_geometry: REQUIRED
pcb:
  finished_stackup_and_tolerances: REQUIRED
  copper_geometry_and_thickness: REQUIRED
  material_Dk_Df_vs_frequency: REQUIRED_OR_UNKNOWN
  via_pad_antipad_plating_geometry: REQUIRED
device_model:
  package_die_model_and_revision: REQUIRED_OR_UNKNOWN
  port_pin_group_mapping: REQUIRED_OR_UNKNOWN
environment:
  input_voltage_range_V: REQUIRED
  ambient_board_temperature_range_C: REQUIRED
  airflow_or_thermal_boundary: REQUIRED_OR_UNKNOWN
verification:
  analysis_ports: REQUIRED
  test_ports_and_fixtures: REQUIRED_OR_UNKNOWN
  acceptance_cases: REQUIRED
```

### Deterministic behavior

1. If `ac_budget_V` or `delta_i_A` is unknown, output `Z_target = UNKNOWN`; do not silently use 5% or maximum steady current.
2. If rise time/spectrum is unknown, the required upper analysis frequency is `UNKNOWN`; provide a sensitivity sweep only, labeled hypothetical.
3. If a capacitor lacks biased capacitance or impedance data, do not count nominal capacitance as verified effective capacitance. Mark the result provisional and request the manufacturer's model/data.
4. If package/die model is missing, keep board-only and package-inclusive conclusions separate. Report the excluded boundary prominently.
5. If regulator stability information is missing, capacitor/filter optimization is a proposal, not approval.
6. If stackup/material/via geometry is preliminary, label extracted impedance and plane modes pre-layout or provisional; do not claim post-layout sign-off.
7. Preserve source, revision, units, temperature, bias, frequency range, port reference, and solver/measurement settings with every imported model.
8. Run dimensional and sanity checks: positive voltage/current, `Vmin < Vnom < Vmax`, consistent peak/RMS/average definitions, and no unit-prefix ambiguity.
9. Never interpret missing as `0`, `false`, “not applicable,” or a generic default. Ask for the fact, bound it explicitly, or stop the affected conclusion.
10. Produce separate statuses: `DC_PASS/FAIL/UNKNOWN`, `AC_IMPEDANCE_PASS/FAIL/UNKNOWN`, `TRANSIENT_PASS/FAIL/UNKNOWN`, `STABILITY_PASS/FAIL/UNKNOWN`, `THERMAL_PASS/FAIL/UNKNOWN`, and `MEASUREMENT_CORRELATED/NOT_CORRELATED/UNKNOWN`.

### Safe agent output example

```text
AC_IMPEDANCE: UNKNOWN
Reason: rail AC budget is 18 mV, but concurrent load delta-I and rise time are absent.
Known: board-only simulated peak is 7.4 mΩ at 11.8 MHz at the BGA-ball port.
Not proven: whether that peak violates die voltage limits or is excited by the workload.
Required next data: vendor workload step/current spectrum and package-die PDN model.
Suggested bounded study: evaluate 1 A, 3 A, and 6 A steps at 1 ns, 10 ns, and 100 ns;
label all results hypothetical and do not use them for release.
```

## 16. Limitations and unresolved evidence

- The required JLCPCB article was inaccessible at its supplied URL; only its later indexed summary could be evaluated. No unique rule from the missing page is represented as verified.
- Device-vendor capacitor tables are validated for named families, packages, utilization assumptions, and stackups. They are examples, not universal recipes.
- IPC-2152 remains useful empirical guidance but is listed by IPC as no longer maintained. A project may mandate another revision/method; confirm contractual requirements.
- Target impedance assumes a chosen voltage/current budget and a sufficiently representative linear model. Nonlinear VRM behavior, time-varying activity, and multiport coupling require additional analysis.
- A field solver result is only as good as stackup/material, geometry, port, and boundary data. A visually accurate board import can still have wrong plating, dielectric, pin grouping, or component models.
- Public package/die current models are often incomplete or unavailable. Board-only PI can be verified as board-only, but die-voltage sign-off may remain impossible without supplier data.
- Instrument-vendor notes describe capable methods, not automatic accuracy. Calibration, de-embedding, common-mode management, dynamic range, probe loading, and operator setup determine the real uncertainty.

## 17. Claim-to-source ledger

The ledger prioritizes original standards, official device documentation, component-manufacturer characterization, and instrument-maker methods. JLCPCB is retained as the required secondary starting source and is not used as the authority for device-specific values.

| ID | Source and publisher/author | Date/revision | Claims supported here | Access/limitations |
|---|---|---|---|---|
| S1 | [*Power Integrity (PI) in PCB Layout*](https://jlcpcb.com/blog/power-integrity-pi-in-pcb-layout), JLCPCB | Metadata unverified | Assigned article identity only | Live URL returned 404 on 2026-09-06; full text unavailable. |
| S2 | [*PCB Design Rules and Guidelines: A Complete Best Practices Guide*](https://jlcpcb.com/blog/pcb-design-rules-best-practices), JLCPCB | Published 2025-10-28; updated 2026-07-20 | Recoverable summary of JLCPCB's PI introduction: low-inductance distribution, planes, bulk/local capacitors | Secondary fabrication-vendor guidance; fixed capacitor values are not universal. |
| S3 | [UG863, *Versal Adaptive SoC PCB Design User Guide — Target Impedance*](https://docs.amd.com/r/en-US/ug863-versal-pcb-design/Target-Impedance), AMD | Rev. 1.12, 2026-06-16 | AC/DC budget separation, target-impedance method, board simulation recommendation | Device-family-specific example and assumptions. |
| S4 | [UG583, *UltraScale Architecture PCB Design User Guide — Basic PDS/placement/parasitics/anti-resonance*](https://docs.amd.com/r/en-US/ug583-ultrascale-pcb-design/Basic-PDS-Principles), AMD | Rev. 1.29, 2025-12-23 | PDS principles, capacitor placement/loop area, package-size ESL, anti-resonance and plane interaction | Device-family-specific; linked subsections form one controlled guide. |
| S5 | [UG1556, *Power Design Manager User Guide — Power Delivery Design*](https://docs.amd.com/r/en-US/ug1556-power-design-manager/Power-Delivery-Design), AMD | 2026.1 | Utilization/step-dependent capacitor recommendations and need for post-layout simulation | Tool recommendations vary by device and tool revision. |
| S6 | [AN 958, *Board Design Guidelines — Target Impedance Decoupling Method*](https://docs.altera.com/r/docs/683073/current/an-958-board-design-guidelines/target-impedance-decoupling-method), Intel | Current page dated 2023-06-26 | Target-impedance workflow, VRM selection context | Intel FPGA scope; confirm current device guide. |
| S7 | [*Device-Specific PDN Tool User Guide*](https://cdrdv2-public.intel.com/654614/ug_pdn_other_device.pdf), Intel | Public guide; 2013-era document | Capacitor ESR/ESL, custom mounting inductance, bulk and spreading R/L modeling | Older tool guide; concepts remain useful, values/tool status require current verification. |
| S8 | [SPRABJ7, *PCB Design Requirements for VDD_MPU_IVA PDN*](https://www.ti.com/lit/an/sprabj7/sprabj7.pdf), Texas Instruments | 2011-06 | `V=ZI`, target impedance, VRM/bulk/ceramic/plane hierarchy, EM extraction of loop inductance | Specific to OMAP3630/AM37xx/DM37xx; numerical recipe must not migrate. |
| S9 | [SWPA222A, *Power Delivery Network Analysis*](https://www.ti.com/lit/pdf/swpa222), Texas Instruments | Hosted revision A; date not verified from landing metadata | Impedance analysis, resonance inspection, placement/loop-inductance optimization | Use current PDF revision; examples are not generic sign-off limits. |
| S10 | [IPC-2152, *Standard for Determining Current Carrying Capacity in Printed Board Design*](https://www.ipc.org/TOC/IPC-2152.pdf), IPC | 2009-08 | Empirical relationship among current, finished conductor size, and temperature rise | IPC revision table says no longer maintained; public file may be TOC/excerpt depending access. |
| S11 | [*What are impedance/ESR frequency characteristics in capacitors?*](https://article.murata.com/en-eu/article/impedance-esr-frequency-characteristics-in-capacitors), Murata Manufacturing | 2013-02-14 | Real capacitor ESR/ESL, SRF behavior, package/reverse-geometry effects, downloadable models | General component physics; use exact part data. |
| S12 | [*Dynamic DC Bias Model for Accurate Circuit Simulation*](https://www.tdk-electronics.tdk.com/en/373812/tech-library/articles/tools-services/tools-services/dynamic-dc-bias-model-for-accurate-circuit-simulation/1035570), TDK Electronics | 2014-07-08 | Class II MLCC effective capacitance varies with DC bias; bias-aware models | Exact derating remains part-number-specific. |
| S13 | [*Power Tips: Calculating Capacitance for Load Transients*](https://www.ti.com/document-viewer/lit/html/SSZTCQ4), John Betten, Texas Instruments | 2015-05; current TI hosting | Closed/open-loop output impedance, bandwidth, biased effective capacitance, transient sizing | Approximation; verify topology, ESR, inductance, and large-signal limits. |
| S14 | [AN76, *OPTI-LOOP Architecture Reduces Output Capacitance and Improves Transient Response*](https://www.analog.com/media/en/technical-documentation/application-notes/an76.pdf), Linear Technology/Analog Devices | 1998-09 | Small- versus large-signal response, error-amplifier slew/rail limits, bandwidth role | Controller-family context; principles require exact regulator validation. |
| S15 | [AN66, *Linear Technology Magazine Circuit Collection, Volume II*](https://www.analog.com/media/en/technical-documentation/application-notes/an66f.pdf), Linear Technology/Analog Devices | 1996 | Measured load-transient decomposition into ESR and ESL/path contributions | Historical but directly measured; not a universal numeric model. |
| S16 | [*How to Optimize Switching Power Supply Layout by Minimizing Hot Loop PCB ESRs and ESLs*](https://www.analog.com/en/resources/analog-dialogue/raqs/raq-issue-207.html), Sun, Jiang, and Zhang, Analog Devices | Current article; access 2026-09-06 | Hot-loop definition, path/via parasitics, closest-via effectiveness, non-linear benefit of via count | Converter layouts still require exact datasheet/reference design. |
| S17 | [UG861, *UltraScale I/O User Guide — Simultaneous Switching Outputs*](https://docs.amd.com/r/en-US/ug861-ultrascale-selectio/Simultaneous-Switching-Outputs), AMD | Rev. 1.1, 2026-04-28 | Package-inductance mechanism of SSO bounce, required pin/I/O factors, socket limitation | Family-specific and not final system sign-off. |
| S18 | [SBAA405B, *AFE79xx Layout Guide*](https://www.ti.com/kr/lit/pdf/sbaa405), Texas Instruments | 2019-12; revised 2021-04 | Return-path detours over splits and nearby stitching-capacitor guidance when crossing is unavoidable | Device-oriented layout guide; reference transitions must be analyzed in context. |
| S19 | [IBIS Version 7.1](https://ibis.org/ver7.1/ver7_1.pdf), IBIS Open Forum | 2021 | Standard model constructs for packages, rails, and PDN/on-die-capacitance analysis | A format does not guarantee that a supplier model exists or is accurate. |
| S20 | [*Optimize Power Distribution Networks for Flat Impedance*](https://www.keysight.com/us/en/assets/3119-1097/application-notes/5992-4272.pdf), Keysight Technologies | Doc. 5992-4272; 2019-era | Target impedance, flat/damped impedance objective, risk of high-Q resonances | EDA/instrument vendor note; optimization must use correct models. |
| S21 | [*Ultra-Low PDN Impedance Measurements Using 2-Port VNAs*](https://www.keysight.com/sg/en/assets/7018-08474/application-notes/5989-5935.pdf), Keysight Technologies | Doc. 5989-5935; date not verified | One-port low-Z limitation, two-port milliohm/picohenry technique, PDN measurement boundary | Exact fixture/calibration and active-rail protection remain setup-specific. |
| S22 | [*Getting Started with Power Rail Measurements*](https://www.tek.com/ru/documents/application-note/getting-started-power-rail-measurements-application-note), Tektronix | 2019-era application note | Rail-probe DC offset/loading/noise/bandwidth and low-inductance solder/coax connections | Product examples are vendor-specific; measurement principles are general. |
| S23 | [*Probing Techniques for Accurate Voltage Measurements on Power Supplies*](https://www.tek.com/en/documents/application-note/probing-techniques-accurate-voltage-measurements-power-converters-oscillos), Tektronix | Current hosted application note | Ground-lead inductance, probe ringing/pickup, shortest-ground guidance | Does not replace uncertainty characterization for the exact setup. |
| S24 | [AN133, *A Closed-Loop, Wideband, 100A Active Load*](https://www.analog.com/media/en/technical-documentation/application-notes/an133f.pdf), Jim Williams, Linear Technology/Analog Devices | 2011-10 | Controlled, high-bandwidth load-step generation and measurement | Example hardware is not automatically appropriate for every voltage/current rail. |

## 18. Search and stopping record

Research covered the assigned JLCPCB URL and indexed recovery; current AMD and Intel PDN/device guidance; TI and Analog Devices transient/layout reports; IPC conductor-current guidance; Murata/TDK capacitor characterization; IBIS package/die modeling; and Keysight/Tektronix low-impedance and rail probing methods. Focused follow-up addressed anti-resonance, plane spreading/distributed behavior, SSN, DC current density, VRM loop limits, package/die boundaries, and two-port measurement. Research stopped when every requested answer slot had primary support or an explicit limitation, and further search was returning duplicative vendor explanations rather than changing a conclusion. The principal unresolved gap is the removed required article itself and device-specific package/load data that can exist only for a future concrete design.

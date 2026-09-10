# Trace Width vs. Current Capacity: Engineering Dossier for PCB Power Routing

**Research date:** 2026-09-06  
**Primary article under review:** JLCPCB, “Track Width v/s Current Capacity: PCB Layout Tips for Power Routing,” published 2025-01-03 and updated 2025-12-26  
**Audience:** PCB designers and an AI system that must choose, audit, or explain power-routing geometry  
**Decision to support:** Select a manufacturable conductor system that meets temperature-rise, voltage-drop, transient, interconnect, and fault-safety requirements under worst-case finished-board and operating conditions.

## Direct answer

There is no context-free “amps per millimetre” or “amps per via” rating. A defensible current path is selected by solving two different normal-operation constraints, then checking several separate failure constraints:

1. **Steady-state or mission-profile heating:** Joule loss, driven by RMS current and hot resistance, must not raise any trace, plane, via, pad, neck-down, connector, or nearby material above its allowed temperature.
2. **Voltage drop:** the path's hot resistance and instantaneous current must not consume more of the power-distribution budget than the load can tolerate.
3. **Transient survival:** pulses must be evaluated against thermal time constants or a conservative adiabatic-energy model, not automatically treated as either DC or harmless.
4. **Fault coordination:** the upstream fuse, breaker, current limit, or electronic protection must clear before the PCB path or connector is damaged. A trace-width chart is not a fault-protection design.
5. **Manufacturing reality:** calculations must use minimum finished copper cross-section, minimum plated-hole wall, etch tolerance, actual stack-up, and worst local constrictions—not nominal “oz copper” alone.

IPC-2152 is the correct public standard family to start with for conductor temperature rise. IPC itself describes the standard as guidance for relating current, finished conductor size, and acceptable temperature rise; it is not a universal ampacity table or a certification that every geometry is safe ([IPC-2152 official preview](https://www.ipc.org/TOC/IPC-2152.pdf)). Michael Jouppi, chair of the IPC task group, explains that the baseline charts came from test boards without copper planes, suspended in still air or vacuum, and that planes, mounting, environment, thickness, material, width, and copper thickness alter the result ([IPC technical paper](https://www.ipc.org/system/files/technical_resource/E7%26S22_03.pdf)).

## Scope and evidence status

This dossier expands and audits the JLCPCB article. It covers copper conductors on rigid PCBs, with notes applicable to flex only where explicitly identified. It does not reproduce proprietary IPC chart data. The official IPC preview supplies scope, definitions, and table of contents; an IPC-hosted Jouppi paper supplies methodology and baseline context. Exact chart lookup still requires a licensed copy of IPC-2152 or a tool whose implementation and domain are known.

Evidence labels used below:

- **Official/primary:** IPC, NIST, a fabricator's current capability page, a component manufacturer's specification, or original research.
- **Vendor guidance:** useful but scoped to the vendor's process or implementation; not a general standard.
- **Derived:** arithmetic shown here from sourced constants and stated assumptions.
- **Engineering inference:** physically motivated conclusion requiring validation for consequential designs.
- **UNKNOWN:** an input or behavior that cannot safely be invented. The AI must stop, request data, choose an explicitly conservative bounded assumption, or require test evidence.

## 1. What “current capacity” means

IPC-2152 defines current-carrying capacity as the maximum current carried continuously without objectionable degradation of the product's electrical or mechanical properties. That definition contains three design choices that must be made explicitly:

- **Continuous:** enough time for the relevant assembly to approach thermal equilibrium. The duration depends on copper area, dielectric, planes, components, enclosure, mounting, airflow, and heat sinks.
- **Objectionable:** not necessarily copper melting. Excessive voltage drop, laminate or solder-mask aging, connector temperature, component derating, delamination, discoloration, loss of calibration, and reduced lifetime can become limiting first.
- **Product:** the complete current path and its environment, not an isolated rectangle of ideal copper.

Therefore, “the trace can carry 5 A” is incomplete. A reviewable statement is: “This finished external conductor carries 5 A DC continuously at 60 °C maximum local ambient with no forced airflow, while limiting self-heating to 20 °C and end-to-end drop to 100 mV; the complete path, vias, connector, and fuse coordination are separately verified.”

### Temperature rise is not absolute temperature

Let

\[
T_{conductor,max}=T_{local,ambient,max}+\Delta T_{self}+\Delta T_{other}
\]

where `local ambient` means the environment actually exchanging heat with the board, and `other` includes nearby component heating, preheated coolant/air, solar load, battery heat, or enclosure gradients. A 20 °C trace rise in a 25 °C open bench test gives roughly 45 °C; the same self-rise inside a 70 °C enclosure gives roughly 90 °C before other heat sources. “Ambient” is not automatically room temperature.

The maximum permitted conductor temperature is the lowest applicable limit among laminate system, solder mask, surface finish, solder joint, adhesive, component, connector, cable, safety standard, touch temperature, calibration, and reliability requirements. Tg is not by itself a recommended continuous operating temperature.

## 2. Governing electrical equations

### 2.1 Finished cross-section and resistance

For a uniform rectangular copper segment:

\[
A=w\,t
\]

\[
R(T)=\rho_{20}\frac{L}{A}\left[1+\alpha_{20}(T-20\,^{\circ}\mathrm C)\right]
\]

where:

- \(A\) is finished copper cross-section in m²;
- \(w\) is minimum finished width, not CAD nominal width;
- \(t\) is minimum finished copper thickness;
- \(L\) is electrical path length;
- \(\rho_{20}\) is the applicable copper volume resistivity at 20 °C;
- \(\alpha_{20}\) is the resistance temperature coefficient near 20 °C.

NIST's *Copper Wire Tables*, NBS Handbook 100, gives 1.7241 µΩ·cm (1.7241×10⁻⁸ Ω·m) for 100% IACS copper and cites the IEC standard temperature coefficient 0.00393/°C at 20 °C for a freely expanding conductor ([NIST Handbook 100](https://nvlpubs.nist.gov/nistpubs/Legacy/hb/nbshandbook100.pdf)). NIST also cautions that temperature coefficient varies with conductivity. Electrodeposited PCB copper, plated copper, foil roughness, alloying, grain structure, and real geometry can differ from ideal annealed copper. IPC's Jouppi paper explicitly notes that measured-conductor resistivity can differ from handbook values. Treat the NIST number as a transparent calculation basis, not guaranteed board resistance.

For a nonuniform path, sum segments:

\[
R_{path}=\sum_i \rho_i(T_i)\frac{L_i}{A_i}+R_{vias}+R_{contacts}+R_{joints}
\]

Current crowding near pads, corners, plane apertures, via entries, and neck-downs makes a single average width optimistic when the narrow region governs temperature.

### 2.2 Voltage drop and dissipation

For DC:

\[
V_{drop}=IR,\qquad P=I^2R=IV_{drop}
\]

For a periodic or sampled waveform and approximately constant resistance:

\[
I_{RMS}=\sqrt{\frac{1}{\tau}\int_0^\tau i^2(t)\,dt},\qquad P_{avg}=I_{RMS}^{2}R
\]

RMS, not arithmetic-average current, sets resistive heating. Analog Devices describes RMS as the DC-equivalent heating value of a time-varying waveform ([ADI RMS explanation](https://www.analog.com/en/resources/technical-articles/simple-circuit-measures-the-rms-value-of-an-ac-power-line.html)). Voltage-drop evaluation must also consider instantaneous or peak current because the load experiences \(i(t)R\), and fast edges add \(L\,di/dt\) and power-distribution-network effects not captured by a DC trace calculator.

For rectangular unipolar pulses of peak current \(I_p\) and duty ratio \(D\):

\[
I_{avg}=I_pD,\qquad I_{RMS}=I_p\sqrt D
\]

Do not use average current in the \(I^2R\) term.

### 2.3 High-frequency resistance

At sufficiently high frequency, skin and proximity effects make current distribution nonuniform. For a good conductor, first-order skin depth is

\[
\delta=\sqrt{\frac{2\rho}{\omega\mu}}
\]

but this alone does not solve a PCB geometry. Copper thickness, width, return-plane spacing, surface roughness, magnetic field from adjacent conductors, harmonics, and current crowding alter AC resistance. IPC's official technical paper identifies skin thickness, effective resistance, and resulting power dissipation as a separate high-speed analysis topic. Use field solving or measured impedance when switching harmonics make \(R_{AC}\) materially exceed \(R_{DC}\).

## 3. Thermal behavior: steady state and transient are different problems

### 3.1 Steady state

A conceptual lumped relation is

\[
\Delta T=P\,\theta_{effective}
\]

but \(\theta_{effective}\) is not a universal “trace thermal resistance.” It is an outcome of three-dimensional conduction, convection, and radiation and can vary with temperature. The heat spreads longitudinally into pads and planes, laterally and through dielectric, into components and terminals, and from board surfaces to the environment. Multiple heat sources interact.

IPC-2152 baseline charts are empirical guidance under defined test configurations. Jouppi reports a 0.07-inch-thick polyimide board suspended in free air or vacuum as the baseline, with no copper planes. The standard includes still-air and vacuum/space chart families; Jouppi's presentation says forced air was not included at that time. Applying a still-air chart to a sealed potted assembly, clamped metal chassis, forced-air product, flex circuit, or metal-core board without adjustment is an out-of-domain use.

### 3.2 First-order transient model

If one thermal node is a reasonable approximation:

\[
\Delta T(t)=P\theta\left(1-e^{-t/(\theta C_{th})}\right)
\]

where \(C_{th}\) is effective thermal capacitance. This model is useful for reasoning but usually insufficient to sign off a complex board: copper, laminate, planes, pads, and enclosure have multiple time constants.

For a pulse much shorter than meaningful heat diffusion, a conservative adiabatic estimate is

\[
E=\int i^2(t)R(T)\,dt\approx m c_p\Delta T
\]

If constant cold resistance is assumed,

\[
\Delta T\approx\frac{I^2R_{20}t_p}{m c_p}
\]

This approximation must be labeled: it ignores heat escape, temperature-dependent resistance, phase changes, nonuniform current density, solder mask, and damage to the substrate. It can be conservative for early temperature rise because it ignores cooling, but cold resistance can make it nonconservative at high temperature.

Original research by Gras and Ida states that short fusing times can neglect conduction and radiation, while arbitrary PCB-trace geometry requires nonlinear electrothermal treatment when those effects matter ([IEEE paper record, University of Akron](https://ideaexchange.uakron.edu/ece_ideas/32/)).

### 3.3 Thermal time-scale decision

For each waveform:

1. Obtain or bound repetition, pulse width, peak, RMS, and total event duration.
2. If pulses repeat much faster than the thermal response, use cycle RMS for average heating and separately check peak electrical drop/current density.
3. If a single pulse is very short relative to heat diffusion, use an adiabatic energy check with conservative material data.
4. If pulse width is comparable to thermal time constants, use a validated transient model or test; neither DC chart nor adiabatic endpoint alone is sufficient.
5. If duration or thermal time constant is UNKNOWN, do not label the pulse safe. Bound both extremes or request the waveform and construction.

## 4. IPC-2152 and the legacy IPC-2221 equation

### 4.1 What IPC-2152 provides

The official preview says IPC-2152 is a general guide for copper conductors and sizes finished-board conductors from required current and acceptable temperature rise. Its contents include parallel conductors, vias and microvias, board thickness, copper weight, material, environments, planes and plane distance, power dissipation, voltage-drop analysis, HDI, high speed, and still-air/vacuum charts. This breadth is evidence that a one-line formula is not the standard's complete method.

Jouppi states that IPC-2152 begins with a conservative baseline and supplies methods to tune product-specific guidelines. “Conservative” is configuration-relative: adding a nearby plane can spread heat, but external heat sources, reduced convection, a hotter enclosure, or smaller board may reverse an assumed margin.

### 4.2 Legacy curve-fit equation

Many online calculators implement a curve fit to the older IPC-2221 charts:

\[
I=k\Delta T^{b}A^{c}
\]

or

\[
A=\left(\frac{I}{k\Delta T^b}\right)^{1/c}
\]

with \(A\) in square mils. DigiKey discloses \(b=0.44\), \(c=0.725\), \(k=0.048\) for external layers and \(k=0.024\) for internal layers, and explicitly calls its results estimates that can vary with application conditions ([DigiKey calculator](https://www.digikey.com/en/resources/conversion-calculators/conversion-calculator-pcb-trace-width)). These constants are **vendor-reported curve-fit parameters**, not an IPC-2152 equation.

Do not mix units: width and thickness must produce square mils for this implementation. Do not extrapolate beyond the chart domain. Do not infer voltage drop from the equation; length is absent. Do not treat its internal/external split as a universal law. Jouppi reports that the old data came from 1950s National Bureau of Standards work and that IPC-2152 replaced the earlier conductor-sizing charts ([Jouppi overview](https://pcdandf.com/pcdesign/index.php/2009-archive-articles/5305-the-new-ipc-2152)).

### 4.3 Worked comparison with the article's 2 A example

The JLCPCB article calls about 1 mm (40 mil) external width on 1 oz copper “typical” for 2 A, without specifying ambient, permitted rise, length, plane coupling, or finished thickness.

Using the DigiKey legacy equation solely as an auditable comparison:

- current = 2 A;
- external \(k=0.048\);
- permitted self-rise = 10 °C;
- thickness = 1.378 mil (35 µm);
- computed cross-section = 42.39 mil²;
- computed width = 30.76 mil = 0.781 mm.

Thus 1 mm is wider than this particular legacy 10 °C curve-fit result, but that does **not** validate the JLC claim for every board. IPC-2152 lookup, hot-resistance drop, finished tolerance, local geometry, ambient, enclosure, and test still govern. The example also illustrates why a number without assumptions is not reusable.

## 5. Copper thickness, weight, and finished geometry

### 5.1 “1 oz” is a procurement shorthand

The ideal mass conversion is approximately 34.8–35 µm per oz/ft²; JLCPCB currently states 1 oz = 35 µm and lists its available outer and inner finished weights ([JLCPCB copper-weight guide](https://jlcpcb.com/help/article/jlcpcb-copper-weight)). A design must nevertheless distinguish:

- starting foil thickness;
- base copper versus plated copper;
- inner-layer finished copper;
- outer-layer finished copper after plating;
- minimum versus nominal versus average thickness;
- copper in via walls versus surface traces;
- local etch profile and undercut;
- surface finish, which is not equivalent to adding the same thickness of copper.

JLCPCB's article simplifies 1/2/3 oz to 35/70/105 µm and recommends thicker copper. That is directionally sound. It is not permission to assume an exact rectangular 35 µm finished cross-section. Request the fabricator's minimum finished copper and width tolerances for the selected stack-up.

### 5.2 Width and thickness tolerances

JLCPCB's current capability page states ±20% track-width tolerance and gives a 0.10 mm nominal example ranging from 0.08 to 0.12 mm. It lists average PTH plating thickness as 18 µm, not a minimum guarantee, and lists different finished copper options for outer and inner layers ([JLCPCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/)). These are **JLCPCB-specific, currently published capability values**, not IPC allowances and not universal fab data.

For resistance and hotspot calculations, use the minimum credible local cross-section. If nominal width is 1.00 mm and fab tolerance is ±20%, a simple worst-width bound is 0.80 mm before accounting for thickness tolerance or trapezoidal etch. If minimum finished thickness is UNKNOWN, cross-section and resistance are UNKNOWN.

### 5.3 Heavy copper trade-offs

Thicker copper reduces DC resistance at a given width, but it can force larger minimum trace/space, larger annular rings, altered impedance geometry, more difficult etching, and higher cost. JLCPCB currently lists minimum trace/space of 0.10/0.10 mm for 1 oz on 1–2 layers, 0.16/0.16 mm for 2 oz, 0.20 mm for 2.5 oz two-layer, 0.25 mm for 3.5 oz two-layer, and 0.30 mm for 4.5 oz two-layer. These are manufacturability minima, not recommended power widths or current ratings.

## 6. External traces, internal traces, and planes

### 6.1 No universal external/internal multiplier

An external trace can exchange heat directly with surrounding air and radiate from a board surface; an internal trace conducts through dielectric and copper. However, an internal trace close to a large plane may run cooler than an isolated external trace, and an external trace in stagnant hot air beneath a component or thick coating may run hotter. IPC-2152 treats plane count, plane proximity, board material, thickness, mounting, and environment as variables. Never apply an unexplained “internal = 50% current” multiplier as a final design rule.

### 6.2 Planes and pours

Planes can:

- reduce electrical resistance by increasing current-spreading area;
- spread heat laterally;
- couple heat into other layers through dielectric and vias;
- create large terminal regions that cool a narrow trace;
- also receive heat from devices, raising local ambient.

Plane current does not occupy the entire polygon uniformly. It crowds between source and sink attachment regions and around antipads, slots, voids, thermal spokes, necks, cutouts, and mounting features. The minimum cross-section normal to the dominant current flow is an initial electrical check; a 2-D or 3-D field solve is preferable for irregular high-current planes.

Jouppi's IPC paper shows that plane area, copper weight, and distance from the trace affect conductor rise. Therefore, “use a power plane” is sound as a layout direction but does not itself establish ampacity.

### 6.3 Thermal spreading is not free capacity

Adding nearby copper generally reduces a local hotspot only if there is a temperature gradient and a path to a cooler reservoir. Copper that is already heated by MOSFETs, inductors, shunts, or another trace may not be a useful sink. Closely spaced parallel traces also heat one another; their individual isolated-trace ratings cannot automatically be summed.

### 6.4 Thermal reliefs

The article recommends “thermal reliefs or vias to spread heat.” These must be separated:

- **Thermal vias** may spread heat or carry current when their barrel, pads, land connections, and receiving copper are adequate.
- **Thermal-relief spokes** intentionally reduce heat conduction for solderability. On a high-current pad they may become the narrowest electrical and thermal bottleneck.

Use solid plane connections for high-current terminals when assembly permits, or size/count relief spokes from their combined minimum finished cross-section and validate solderability separately.

## 7. Vias and layer transitions

### 7.1 Barrel geometry and resistance

For a plated through-hole with finished hole diameter \(d\), plating thickness \(t_p\), and board traversal length \(L_v\), the exact annular barrel cross-section is

\[
A_v=\pi\left[\left(\frac d2+t_p\right)^2-\left(\frac d2\right)^2\right]
\]

and, when \(t_p\ll d\),

\[
A_v\approx\pi d t_p,\qquad R_v\approx\rho\frac{L_v}{A_v}
\]

This is an electrical-resistance calculation, not a complete temperature-rise rating. Via temperature depends strongly on connected pads/planes, antipads, fill, board thickness, nearby vias, current crowding, copper thickness, and heat sources.

### 7.2 Worked via illustration—and why 500 mA is unsupported

Assume, only for illustration:

- 0.30 mm finished hole;
- 18 µm uniform barrel plating;
- 1.60 mm barrel length;
- ideal copper at 20 °C;
- no contact, spreading, or crowding resistance.

Then \(A_v\approx0.01696\text{ mm}^2\), \(R_v\approx1.63\text{ m}\Omega\), and at 5 A the ideal barrel loss is about 40.7 mW. That arithmetic does not say the via is safe at 5 A; it only shows that a current rating cannot be inferred without thermal boundary conditions. The JLCPCB article's “around 500 mA” per via is unscoped and should not be encoded as a design rule. JLCPCB publishes 18 µm as **average** hole plating, so even the illustration lacks a sourced minimum wall thickness.

### 7.3 Via-array checks

- Use minimum finished plating and finished hole, not drill nominal or surface copper.
- Count only vias electrically connected by adequate copper at both ends and along the intended transition.
- Check pad and plane necks; antipads can remove more plane copper than barrels add.
- Do not assume \(I/N\). Unequal path lengths, asymmetric entry geometry, and temperature coefficients cause unequal sharing.
- Place transitions so current can spread before and after the array; a dense cluster connected through one narrow throat remains throat-limited.
- Check annular ring, registration, aspect ratio, resin fill/cap process, and current path through any stacked or microvia construction.
- Treat via fill as process-specific. Conductive or copper fill can change heat flow; it does not erase plating-quality or interconnect-reliability requirements.
- For critical paths, specify coupons or resistance acceptance and validate a worst-case board thermally.

IPC lists current breakdown of plated through-holes as TM-650 2.5.3B and conductor temperature rise due to current changes as TM-650 2.5.4.1A ([IPC TM-650 index](https://www.ipc.org/test-methods)). Use the relevant controlled test method when generic calculation is insufficient.

## 8. Connectors, terminals, pads, and solder joints

The conductor is only one series element. A connector's advertised current is conditional on contact, wire gauge, circuit loading density, ambient, housing, mating half, PCB design, aging, and allowed temperature rise.

For example, TE Connectivity's POWER TRIPLE LOCK header specification limits current by housing temperature and a 30 °C contact rise; it explicitly lists wire size, connector size, contact material, ambient, and PCB design as application variables. Its test stabilizes until three readings five minutes apart are within 1 °C. The same document expects PCB traces to be large enough not to contribute materially to the connector test ([TE product specification 108-32090](https://www.te.com/content/dam/te-com/documents/appliances/global/ptl-pcb-headers-product-specification.pdf)). This is an example of rating methodology, not a rating transferable to another connector.

For every high-current interface, check:

- maximum continuous and transient current under the vendor's loading-density curve;
- hot contact resistance, including after environmental/durability tests;
- number of simultaneously loaded contacts and allowed current sharing;
- contact-to-pad and pad-to-plane neck-down;
- thermal relief spokes;
- solder volume, voiding, copper balance, and assembly process;
- terminal screw, press-fit, crimp, wire gauge, and cable temperature;
- conductor and connector voltage-drop budget at end of life.

## 9. Parallel traces, parallel layers, and current sharing

For ideal parallel branches at one temperature:

\[
I_i=I_{total}\frac{1/R_i}{\sum_j1/R_j}
\]

Equal sharing requires equal total branch resistance, including vias, pads, contacts, and terminal spreading. The following prevent simple linear capacity addition:

- unequal geometry or copper thickness;
- asymmetric source/load entry;
- different via counts or via resistance;
- different layer temperatures;
- mutual heating between branches;
- plane slots or local constrictions;
- frequency-dependent inductance and current distribution;
- manufacturing tolerance.

Copper's positive temperature coefficient tends to add some DC balancing, but hotspot and connection geometry can still dominate. For AC or switching currents, equal DC resistance does not imply equal impedance. Use a current-density solve or measure branch current when sharing is consequential.

The article's advice to divide high current across traces/layers is a useful option, not a guarantee. An AI must not multiply a single-trace or single-via “rating” by the branch count without a conservative sharing model.

## 10. Voltage drop can govern before temperature rise

A conductor may be thermally acceptable but electrically unacceptable. Low-voltage rails, remote sensing, motor startup, FPGA core supplies, and precision current measurement can have tight budgets.

### Worked DC example

Assumptions:

- external rectangular copper trace;
- 5 A DC continuous;
- length 50 mm;
- width 2.00 mm finished;
- thickness 35 µm finished;
- conductor temperature 80 °C;
- ideal 100% IACS copper;
- no via, pad, contact, or spreading resistance.

Derived values:

- \(R_{20}=12.315\text{ m}\Omega\);
- \(R_{80}=R_{20}[1+0.00393(80-20)]=15.219\text{ m}\Omega\);
- \(V_{drop}=76.1\text{ mV}\);
- \(P=0.380\text{ W}\).

This example does **not** predict the trace's temperature. It assumes 80 °C to compute hot drop and loss. IPC-2152 analysis or test must determine whether the geometry and environment actually remain at or below 80 °C. Finished-width/thickness tolerance and interconnect resistance must then be added.

### Worked pulse example

A 10 A rectangular pulse train at 25% duty has:

- \(I_{avg}=2.5\text{ A}\);
- \(I_{RMS}=5.0\text{ A}\).

For a fixed resistance, heating is equivalent to 5 A DC, not 2.5 A DC. Using 2.5 A in \(I^2R\) would understate average copper loss by a factor of four. During each on-time, resistive drop is \(10R\), so the peak droop is twice the 5 A DC drop even though average heating matches 5 A DC. If pulse period is not short relative to thermal response, perform transient analysis.

## 11. Fault current, I²t, and trace fusing

### 11.1 Normal ampacity is not fusing behavior

IPC-2152's normal-purpose conductor sizing prevents objectionable degradation; a fault study asks when damage begins, whether an arc is sustained, whether the board carbonizes, and whether protection clears first. These are not the same endpoint.

Fault energy is commonly compared through

\[
I^2t=\int i^2(t)\,dt
\]

but a protective device's published pre-arcing/melting and total-clearing I²t are device- and condition-specific. Current limiting, source impedance, inductance, voltage, ambient, and arc behavior matter. Do not compare a fuse's nominal ampere rating with a trace's continuous current alone.

### 11.2 Fusing equations are screening tools

Codreanu, Bunea, and Svasta report Preece-, Brooks-, and Onderdonk-type fusing equations, then warn that these theoretical limits did not by themselves match specific demo-board conditions; their experiments and finite-element models showed strong dependence on PCB structure. They conclude that reliable fusing conclusions require experiments for the particular board ([“New Methods of Testing PCB Traces Capacity and Fusing”](https://smtnet.com/library/files/upload/New_Methods_of_Testing_PCB_Traces_Capacity_and_Fusing.pdf)).

The often-repeated simplified Onderdonk form

\[
I_{fuse}\approx0.188\frac{A_{mil^2}}{\sqrt{t_s}}
\]

is reported in that paper as a wire-derived theoretical relation. It is not an IPC-2152 ampacity equation, and it omits PCB heat sinking, geometry, mask, substrate damage, arcs, and manufacturing tolerance. It may screen an adiabatic short-duration case; it must not certify a PCB trace as a safety fuse.

### 11.3 Required coordination procedure

1. Obtain maximum prospective fault current versus time at minimum and maximum source impedance.
2. Obtain the protection device's time-current curve and let-through/total-clearing I²t at the relevant voltage, ambient, and interrupting condition.
3. Model or test the PCB path's time-temperature and damage threshold using minimum finished geometry.
4. Include vias, connector, solder joints, and narrow copper features.
5. Ensure the protection clears with documented margin before the earliest unacceptable board or connector damage, not merely before theoretical copper melting.
6. Check that arcing or carbonization cannot sustain current after copper opens.
7. For a deliberately fusible PCB link, control geometry, coating, spacing, substrate, arc containment, production variation, and agency requirements, and validate across lots and environmental extremes.
8. If any curve or prospective fault is UNKNOWN, fault coordination is UNKNOWN and the AI must not call the path protected.

## 12. Enclosure, ambient, mounting, and neighboring heat

The thermal boundary condition must document:

- minimum/maximum local air or fluid temperature;
- still air, forced air, vacuum, potting, conformal coating, immersion, or contact cooling;
- airflow speed/direction and whether a fan failure case applies;
- board orientation;
- enclosure material, volume, vents, emissivity, and nearby walls;
- mounting points, card guides, standoffs, wedge locks, chassis contact, and thermal interface material;
- altitude/pressure;
- heat from components on both sides and adjacent boards;
- duty cycle and simultaneous worst-case loads;
- warm-up duration and mission profile.

A bench board in open 25 °C air is not evidence for a sealed, sun-loaded, 70 °C enclosure. Conversely, a board clamped to a cold metal chassis may outperform a free-air baseline, but only if the interface and chassis temperatures are bounded.

## 13. Solder mask, solder buildup, busbars, and reinforcement

The article says removing solder mask allows greater current and can permit solder buildup. Separate those actions:

- **Removing mask alone:** does not add copper cross-section. It changes the surface boundary and exposes copper; any thermal benefit is configuration-dependent and should not be assumed.
- **Adding solder:** reduces resistance only by the effective solder cross-section and conductivity. Geometry is process-variable; common solder is substantially more resistive than copper. Hand-applied solder is not a precise or production-stable substitute for specified copper.
- **Adding copper wire, braid, coin, or busbar:** can provide a controlled low-resistance path if cross-section, attachment, current transfer, creepage/clearance, assembly, and mechanical stress are engineered.
- **Busbar attachment:** pads and joints must transfer current without becoming the bottleneck. Differential expansion and solder fatigue may govern.

The article's statement that busbars may be appropriate above 100 A is an application example, not a threshold. Busbars may be appropriate well below 100 A when voltage drop, board area, fault energy, or connector architecture demands them; some carefully engineered PCB systems may operate above 100 A.

## 14. Corners, neck-downs, and path geometry

The article recommends 45° or curved bends to avoid hotspots and inductance. A sharp corner can cause local current crowding, especially at high frequency, but bend style is rarely a substitute for adequate cross-section. More important checks are:

- preserve minimum width through the inside corner;
- avoid acute notches and slivers;
- flare into pads, vias, shunts, terminals, and busbars;
- inspect plane voids and thermal spokes;
- minimize high-di/dt loop area rather than optimizing one trace in isolation;
- use smooth, symmetric transitions when parallel sharing or current sensing matters.

For low-frequency DC, a correctly dimensioned bend is not automatically a thermal failure. Treat “no 90° bends” as geometry/EMI guidance, not an ampacity equation.

## 15. Solver and calculator limits

### 15.1 A calculator is acceptable only when its model is known

Record:

- standard/revision or empirical dataset;
- equation and units;
- chart domain and extrapolation behavior;
- internal/external and environmental assumptions;
- whether copper planes and board size are represented;
- whether width/thickness are finished minima;
- resistivity and temperature dependence;
- DC/RMS/AC resistance treatment;
- whether length affects only drop or also predicted temperature;
- treatment of vias, pads, necks, planes, components, and contacts.

If the tool returns a number but these are UNKNOWN, label the result a preliminary estimate.

### 15.2 Electrothermal finite-element limits

A credible coupled model needs geometry, anisotropic material properties, temperature-dependent electrical conductivity, contact resistance, heat sources, convection, radiation, mounting contacts, and mesh refinement at current-crowding features. Common failure modes include:

- applying a guessed uniform convection coefficient;
- fixing an unrealistically large boundary at ambient temperature;
- treating FR-4 as isotropic;
- omitting components, planes, solder, or enclosure heat;
- using nominal geometry and perfect contacts;
- modeling uniform current injection at a pad that actually crowds through a terminal;
- inadequate mesh at via walls, necks, and corners;
- solving steady state for a transient or vice versa;
- reporting contour colors without energy balance, mesh convergence, or validation.

Codreanu et al. describe coupled electric-thermal analysis as generally nonlinear when fields depend on each other and show that boundary conditions and temperature-dependent resistivity matter. A solver is not automatically more accurate than an IPC baseline; it is only as good as inputs, domain, numerical convergence, and correlation.

### 15.3 Validation hierarchy

1. Hand-check resistance, voltage drop, current density, and energy conservation.
2. Compare a simple model case with IPC-2152 or controlled coupon data within the same domain.
3. Perform mesh and boundary-condition sensitivity.
4. Measure assembled-board voltage drop with Kelvin sensing.
5. Measure temperatures after worst-case heat soak using calibrated thermocouples, resistance thermometry, or emissivity-corrected IR.
6. Test process corners or coupons representing minimum copper and plating.
7. Validate protection clearing under credible fault conditions using safe, approved procedures.

## 16. Fabrication data package required for sign-off

Ask the selected fabricator for the exact ordered stack-up and these minimum/maximum finished values:

- conductor width tolerance by nominal width and copper weight;
- minimum finished inner- and outer-layer copper thickness;
- etch profile/undercut assumptions for critical features;
- minimum PTH and microvia wall/capture-pad copper, not only average;
- finished-hole tolerance and board-thickness tolerance;
- plating distribution limits for large panels or dense copper;
- applicable IPC-6012 class/performance specification and coupon evidence;
- resin, laminate family, glass style, and through-plane/in-plane thermal data when modeling;
- solder-mask type/thickness and whether exposed copper is permitted;
- via fill/cap material and process;
- heavy-copper design rules, annular rings, and spacing;
- controlled copper balance or thieving requirements;
- whether quoted “finished copper” includes plating and how it is measured;
- lot/coupon resistance or microsection acceptance for critical production.

JLCPCB presently lists finished outer and inner copper options, trace minima, ±20% width tolerance, average 18 µm hole plating, and mechanical tolerances on its capability page. Recheck the order page and engineering review at order time; the vendor's separate copper guide explicitly says availability and pricing should be confirmed online.

## 17. AI decision procedure

The following procedure is normative for an AI using this dossier.

### Stage A — collect required inputs

1. Enumerate the complete source-to-load and return path.
2. Obtain current waveform: DC, RMS, peak, duty, repetition, pulse width, startup/inrush, overload, and prospective fault.
3. Obtain voltage-drop limits at continuous, peak, startup, and end-of-life conditions.
4. Obtain maximum local ambient and external heating for normal and single-fault cases.
5. Obtain allowed self-rise and the actual component/material temperature limits.
6. Obtain board layer, length, minimum finished width/thickness, planes, dielectric distances, board outline, mounting, airflow, coating, and enclosure.
7. Obtain via construction and connector/terminal ratings under the actual loading configuration.
8. Obtain protection-device time-current and I²t data.

### Stage B — handle UNKNOWN inputs

- Never silently substitute 25 °C ambient, 1 oz = exact 35 µm, 0.5 A/via, equal layer sharing, or a 10/20 °C rise.
- For an early feasibility estimate, state every bounded assumption and calculate a range using pessimistic geometry, highest ambient, highest RMS current, and highest plausible resistance.
- If an unknown can reverse pass/fail—finished plating, enclosure temperature, current waveform, connector derating, or fault clearing—return **UNKNOWN / NEEDS INPUT OR TEST**, not PASS.
- Do not turn a fabricator's manufacturability minimum into a recommended power geometry.

### Stage C — compute independent constraints

1. Calculate cold and hot resistance of each segment from minimum finished geometry.
2. Calculate continuous/RMS loss and instantaneous voltage drop.
3. Select an applicable IPC-2152 chart/configuration or a validated thermal model; document all modifiers.
4. Calculate via/barrel and connector losses separately.
5. Analyze sharing across parallel paths with conservative imbalance.
6. Check transient energy/time response.
7. Check fault coordination and arc/substrate consequences.
8. Check DFM, clearance, creepage, annular rings, assembly, and mechanical constraints.

### Stage D — choose geometry

Choose the widest/shortest practical route, copper weight, layer allocation, via array, and interconnect that satisfy **all** constraints at worst case. When thermal and voltage results disagree, the stricter geometry governs. Prefer planes/busbars when routing width becomes impractical, but re-evaluate their attachment bottlenecks.

### Stage E — classify the result

- **PASS — verified:** calculation domain is applicable, all inputs are controlled, margins are documented, and required prototype/production validation passed.
- **PASS — preliminary:** calculations pass with explicit margin, but build/test or final fab data remain pending.
- **FAIL:** at least one temperature, drop, interconnect, manufacturing, or fault constraint fails.
- **UNKNOWN:** a consequential input/model is absent or outside validated domain.

An AI must never collapse “PASS — preliminary” or “UNKNOWN” into “safe.”

## 18. Design and review checklists

### Schematic and requirements

- [ ] Maximum normal, startup, regenerative, pulsed, overload, and fault currents documented.
- [ ] RMS and peak current both documented where waveform varies.
- [ ] Source and return paths both in scope.
- [ ] Voltage-drop budget allocated across trace, via, connector, shunt, fuse, switch, and cable.
- [ ] Maximum local ambient and heat-soak state documented.
- [ ] Allowed self-rise and absolute temperature limits documented.
- [ ] Protection time-current and total-clearing data available.

### Layout

- [ ] Minimum finished width/thickness used, including neck-downs.
- [ ] Pad entry, via array, relief spokes, slots, antipads, and plane throats checked.
- [ ] High-current source and return loop is compact.
- [ ] Parallel paths have controlled and analyzed sharing.
- [ ] Current-sense Kelvin routes do not carry load current.
- [ ] Copper near hot components is not assumed to be an infinite heat sink.
- [ ] External/internal model matches actual stack-up and environment.
- [ ] Creepage, clearance, and edge clearances remain valid after widening copper.
- [ ] Busbar/wire reinforcement has a controlled current-transfer joint.

### Fabrication and assembly

- [ ] Fab confirms minimum finished copper and minimum via plating.
- [ ] Width, hole, registration, and board-thickness tolerances included.
- [ ] Heavy-copper trace/space and annular-ring rules met.
- [ ] Solder-mask openings and surface finish are intentional.
- [ ] Connector footprint and copper connection follow vendor application requirements.
- [ ] Thermal relief versus solid connection is justified by both current and solderability.
- [ ] Coupon/microsection/resistance acceptance specified where risk warrants.

### Verification

- [ ] Four-wire path resistance matches the predicted range.
- [ ] Test reaches thermal equilibrium or covers the full mission profile.
- [ ] Worst local ambient, enclosure, mounting, airflow, and neighboring loads reproduced.
- [ ] Temperature sensors do not materially cool or misread the feature.
- [ ] IR emissivity and reflected-temperature errors addressed.
- [ ] Peak droop and switching transients measured at the load.
- [ ] Via/connector/pad hotspots inspected, not only mid-trace temperature.
- [ ] Fault-clearing validation uses an approved safe test plan.
- [ ] Production tolerances and end-of-life contact resistance addressed.

## 19. Audit of the JLCPCB article

| Article claim | Assessment | Required correction or scope |
|---|---|---|
| Width, thickness, length, ambient, and layer location affect current capacity | Supported directionally | Add permitted rise, planes, board size/material, enclosure, mounting, waveform, finished tolerances, and complete-path bottlenecks. |
| 1 oz = 35 µm; 2 oz = 70 µm | Acceptable nominal conversion | Do not assume exact minimum finished thickness; use fab data. |
| About 1 mm external 1 oz for 2 A is typical | Plausible example, not a rating | Missing rise, ambient, length, finished geometry, and boundary conditions. Legacy 10 °C curve fit gives about 0.78 mm under stated assumptions, but IPC-2152/test governs. |
| More layers and vias increase capacity | Often true | Sharing is not necessarily equal; vias, pads, and plane necks may govern; thermal coupling prevents simple summation. |
| One via is around 500 mA | Unsupported as a general rule | Via current depends on finished hole/plating, length, pads/planes, temperature rise, environment, and reliability. Mark UNKNOWN until specified. |
| Thermal reliefs spread heat | Misleading | Thermal vias may spread heat; thermal-relief spokes intentionally impede heat and may be a high-current bottleneck. |
| Remove solder mask to increase current capacity | Incomplete | Mask removal alone adds no copper. Added solder/copper may reduce resistance but must be quantified and process-controlled. |
| Wider/shorter traces reduce resistance and drop | Supported | Still verify thermal spreading, hot resistance, DFM, and interconnects. |
| Use planes for high current | Supported as a strategy | Analyze current crowding, cutouts, source/sink placement, thermal state, and attachment bottlenecks. |
| Avoid sharp bends | Reasonable geometry/EMI guidance | Not a substitute for cross-section analysis; significance depends on frequency and corner geometry. |
| Busbars are used above 100 A | Example, not threshold | Selection depends on allowed drop, heat, board area, fault energy, assembly, and cost at any current. |

## 20. Claim-to-source ledger

| ID | Claim family supported | Source, publisher/author, date | Scope and access note |
|---|---|---|---|
| S1 | Article claims audited: 2 A/1 mm example, copper weights, planes, vias, 500 mA/via, mask removal, bends, busbars | [“Track Width v/s Current Capacity: PCB Layout Tips for Power Routing”](https://jlcpcb.com/blog/track-width-vs-current-capacity-pcb-layout-tips), JLCPCB, published 2025-01-03; updated 2025-12-26 | First-party vendor blog; qualitative guide, not a standard or complete rating method. Accessed 2026-09-06. |
| S2 | IPC-2152 scope, finished-board sizing purpose, definitions, topics and chart families | [IPC-2152 official preview and table of contents](https://www.ipc.org/TOC/IPC-2152.pdf), IPC, August 2009 | Official five-page preview; full standard/chart values not publicly visible here. Accessed 2026-09-06. |
| S3 | IPC-2152 baseline, variables, no-plane suspended-board tests, still air/vacuum, planes and high-speed topics | [“The Value of IPC-2152”](https://www.ipc.org/system/files/technical_resource/E7%26S22_03.pdf), Michael R. Jouppi, Thermal Management Inc., IPC-hosted technical paper/presentation, publication date not shown in retrieved copy | Official-hosted technical explanation by task-group chair; not a substitute for licensed standard. Accessed 2026-09-06. |
| S4 | IPC-2152 replaced earlier chart method; ten-year test/model development | [“The New IPC-2152”](https://pcdandf.com/pcdesign/index.php/2009-archive-articles/5305-the-new-ipc-2152), Michael Jouppi, *Printed Circuit Design & Fab*, 2009-07-01 | Author is identified as task-group chair; specialist trade publication. Accessed 2026-09-06. |
| S5 | Legacy IPC-2221 curve-fit constants and calculator limitations | [PCB Trace Width Calculator](https://www.digikey.com/en/resources/conversion-calculators/conversion-calculator-pcb-trace-width), DigiKey, current webpage, date not stated | Vendor implementation states results are estimates; equation images were not text-extracted, constants were. Accessed 2026-09-06. |
| S6 | 100% IACS copper resistivity and temperature coefficient | [*Copper Wire Tables*, NBS Handbook 100](https://nvlpubs.nist.gov/nistpubs/Legacy/hb/nbshandbook100.pdf), National Bureau of Standards, 1966 | Primary government reference for bulk wire; PCB copper may differ. Accessed 2026-09-06. |
| S7 | RMS is DC-equivalent heating value | [“Simple Circuit Measures the RMS Value of an AC Power Line”](https://www.analog.com/en/resources/technical-articles/simple-circuit-measures-the-rms-value-of-an-ac-power-line.html), Chau Tran and David Karpaty, Analog Devices, 2012-12-01 | First-party technical explanation of RMS heating equivalence. Accessed 2026-09-06. |
| S8 | Current JLC finished copper options, trace minima, ±20% width tolerance, 18 µm average PTH plating, hole/board tolerances | [PCB Manufacturing & Assembly Capabilities](https://jlcpcb.com/capabilities/pcb-capabilities/), JLCPCB, continuously updated; page date not stated | Fabricator-specific capabilities; “average” plating is not a minimum. Accessed 2026-09-06. |
| S9 | JLC copper-weight definition, current weight availability, weight-dependent trace/space rules, order-page recheck warning | [JLCPCB Copper Weight (Thickness) Guide](https://jlcpcb.com/help/article/jlcpcb-copper-weight), JLCPCB, updated 2025-12-15 | Fabricator-specific and subject to order configuration. Accessed 2026-09-06. |
| S10 | IPC test-method identifiers for PTH current breakdown and conductor temperature rise | [IPC TM-650 Test Methods Manual index](https://www.ipc.org/test-methods), IPC, continuously updated | Official index; test method details require following the applicable document. Accessed 2026-09-06. |
| S11 | Connector rating depends on rise, housing temperature, loading, wire/contact/ambient/PCB design; stabilization method | [POWER TRIPLE LOCK PCB Headers Product Specification 108-32090 Rev E](https://www.te.com/content/dam/te-com/documents/appliances/global/ptl-pcb-headers-product-specification.pdf), TE Connectivity, revision date not visible in retrieved text | Product-specific example; values must not be transferred to other connectors. Accessed 2026-09-06. |
| S12 | Nonlinear electrothermal fusing, short-time adiabatic simplification, arbitrary trace geometry | [“Computation of Fusing Currents in Composite Conductors”](https://ideaexchange.uakron.edu/ece_ideas/32/), Courtney A. Gras and Nathan Ida, *IEEE Transactions on Magnetics* 51(3), March 2015 | Original peer-reviewed article metadata/abstract; full paper linked through DOI. Accessed 2026-09-06. |
| S13 | PCB fusing equations need board-specific experiment/model correlation; coupled-field inputs and nonlinearity | [“New Methods of Testing PCB Traces Capacity and Fusing”](https://smtnet.com/library/files/upload/New_Methods_of_Testing_PCB_Traces_Capacity_and_Fusing.pdf), Norocel Codreanu, Radu Bunea, Paul Svasta, based on SIITME 2010 work | Original experimental/FEA technical paper; limited test structures and materials, not a universal rating dataset. Accessed 2026-09-06. |

## 21. Contradictions, unresolved gaps, and research stop condition

### Reconciled contradictions

- **Old calculator versus IPC-2152:** the disclosed IPC-2221 curve fit is useful for screening but comes from older chart data; IPC-2152 adds configuration-specific empirical guidance. Report both only with labels; prefer IPC-2152 for thermal sizing.
- **Internal always worse versus plane-assisted cooling:** external/internal location alone does not determine temperature. Plane proximity and environment can reverse a simplistic rule.
- **Thermal relief as cooling feature:** the article conflates via heat spreading with relief spokes. Relief spokes reduce heat flow and can restrict current.
- **Mask removal increases ampacity:** exposure alone does not increase copper section; added conductive material is a separate, variable modification.
- **Fixed via current:** no credible universal per-via amp rating exists without geometry and thermal constraints.

### Remaining gaps that must stay UNKNOWN for a real design

- Licensed IPC-2152 chart value and modifiers for the exact construction.
- Minimum, not average, finished JLCPCB via plating for a specific order.
- Minimum finished copper thickness and local etch profile for the selected lot/process.
- Board-specific thermal boundary conditions and material conductivity.
- Current-sharing imbalance in a specific parallel layout.
- Damage threshold and arc behavior for a specific trace-fuse geometry.
- Protection let-through for a specific source/fuse combination.

### Search coverage and stopping reason

Research covered the named JLCPCB article, IPC's official IPC-2152 preview and IPC-hosted task-group explanation, an author overview of the standard's development, IPC's test-method index, NIST copper properties, a disclosed vendor implementation of the legacy curve fit, current JLCPCB manufacturing capabilities, a connector manufacturer's rating method, and original electrothermal/fusing research. Targeted follow-up addressed the article's highest-risk claims: via current, mask removal, thermal reliefs, parallel layers, transient/RMS heating, and fusing.

Research stopped because every requested decision slot has either primary/official support, a transparent derivation, or an explicit UNKNOWN branch. Further generic web sources would be redundant. A real-board answer requires project inputs, licensed IPC chart access or a validated implementation, fabricator confirmation, and test data rather than more unspecific articles.


# Comprehensive layer stack-up design for high-speed controlled-impedance PCBs

**Research date:** 2026-09-06  
**Audience:** PCB designers, signal-integrity engineers, fabricator-facing CAM/release engineers, and AI systems proposing stack-ups  
**Anchor article:** JLCPCB, “Comprehensive Layer Stack-Up Design for High-Speed Controlled Impedance PCBs,” published 2023-07-28 and updated 2026-04-07 [S1]  
**Decision supported:** how to turn an interface impedance requirement into a manufacturable, testable PCB cross-section without mistaking a blog example or nominal material property for a production guarantee

## Direct engineering answer

Controlled impedance is not a trace-width setting. It is a contract among the electrical requirement, the entire transmission-line cross-section, the fabricator's material and process capability, and a defined acceptance test.

A release-ready design therefore needs all of the following:

1. the required single-ended, odd-mode, even-mode, common-mode, or differential impedance and tolerance, taken from the applicable interface or system analysis;
2. the exact line structure and layer: exposed or solder-mask-coated microstrip, embedded microstrip, symmetric or offset stripline, coplanar waveguide (CPW), grounded coplanar waveguide (GCPW/CPWG), or a coupled version of one of those structures;
3. a fabricator-approved stack-up that states pressed dielectric thicknesses, exact laminate/resin/glass construction, frequency-appropriate design Dk and Df, copper foil and finished copper thicknesses, and solder-mask assumptions;
4. a solver model that includes the real conductor shape, coupled conductors and nearby copper, all relevant reference planes, coating, frequency dependence, and loss/roughness when those effects matter;
5. a tolerance analysis for dielectric height, Dk, trace top/base width, copper thickness, registration, and pair spacing, rather than a nominal-only result;
6. continuous high-frequency return paths through every routing and layer transition;
7. explicit authority for any CAM width adjustment; and
8. a coupon and measurement agreement, normally TDR for characteristic impedance and frequency-domain methods when insertion loss is also an acceptance criterion.

The JLCPCB article is a useful checklist of topics, but its numeric examples are not reproducible specifications. Its differential example omits pair spacing, both examples omit a complete named stack-up and conductor profile, and its use of RO4350B Dk = 3.48 uses the datasheet's **process** Dk rather than its 3.66 average **design** Dk. Its stated JLCPCB test tolerances also conflict with JLCPCB's current help page. Treat all JLCPCB capabilities in this document as **vendor-specific snapshots**, verify them in the actual quote flow, and obtain written job confirmation before release [S1][S2][S3][S13].

## Scope, assumptions, and evidence status

This guide covers rigid multilayer PCBs carrying fast digital or RF signals through approximately the microwave range. It emphasizes cross-section design and production control. It does not replace an interface specification, a fabricator's controlled-impedance agreement, 3-D channel simulation, PDN analysis, EMI analysis, or product qualification.

Evidence labels used below:

- **Primary model/standard:** original IEEE work, IPC test methods, or first-party material data.
- **Official implementation/guidance:** source code or guidance from the tool, component, laminate, instrument, or fabricator provider.
- **Vendor-specific capability:** a capability asserted by one fabricator; it is not an industry-wide limit or a guarantee for a particular order.
- **Engineering inference:** a conclusion derived from the cited model/data. It must be checked against the real design.

No closed-form equation in this guide is an acceptance method. Equations are for insight and preliminary synthesis; the production geometry is the fabricator-confirmed, solver-checked geometry, and the delivered result is established by the agreed measurement.

## 1. The article: useful scope, unsafe shortcuts

The anchor article correctly identifies layer count, material, trace width/spacing/thickness, planes, and vias as coupled decisions. It also correctly says that changing the stack-up changes impedance [S1]. The problems are precision and completeness:

| Article statement or example | Assessment | Release-safe interpretation |
|---|---|---|
| “FR-4” at about Dk 4.5, Df 0.02 | Too generic for synthesis. FR-4 is a performance class, not a unique dielectric recipe. Dk depends on resin system/content, glass style, test method, frequency, axis, temperature, and the fab's pressed construction. | Use the fabricator's effective/design Dk for each exact core and prepreg construction, with method and frequency recorded. |
| RO4350B Dk 3.48, Df 0.0037 | 3.48 ± 0.05 and 0.0037 are process Dk and Df at 10 GHz in the Rogers table. Rogers separately publishes average design Dk 3.66 from 8–40 GHz. | Ask which value the field solver and fabricator use. Do not substitute process Dk for design Dk without correlation [S13]. |
| 10 Gb/s, 8-layer, 50 Ω trace about 6–8 mil and 100 Ω differential trace about 5–7 mil | Underdetermined. The article gives only broad dielectric thickness and width ranges; a differential result cannot be reproduced without pair gap and precise geometry. | Treat as an illustration only, not a routing rule. Edge rate, channel loss budget, stack ID, layer, pair spacing, mask, top/base widths, and actual Dk remain required. |
| 5 GHz RO4350B microstrip about 18–22 mil and stripline about 6–8 mil | Underdetermined. Layer height, copper profile, coating, exact material construction, reference geometry, and solver convention are missing. | Re-synthesize from a fabricator-approved stack-up using design Dk and a frequency-aware solver. |
| JLCPCB standard ±10%, optional ±5% | Conflicts with JLCPCB's current multilayer help page, which says standard free testing is ±20% and “precision” testing is chargeable but does not assign it a public numeric tolerance [S3]. | The order-page option and written job confirmation control. Record target, tolerance, test method, and whether the tolerance applies to average, min/max, or every coupon trace. |
| More layers improve impedance control | Directionally true only when those layers create useful adjacent reference planes and manufacturable dielectric spacing. | Layer count alone has no magic. A poor eight-layer order can have worse return paths than a deliberate four-layer order. |
| Low and stable Dk/Df minimize distortion | Incomplete. Dk primarily controls field distribution and velocity; Df contributes dielectric loss. Copper roughness, weave, geometry, discontinuities, and frequency dispersion also matter. | Allocate impedance, skew, and loss budgets separately; solve and test the metrics that the channel specification actually limits. |

## 2. When a trace must be treated as a transmission line

The important variable for fast digital signals is edge rate, not merely bit rate or clock frequency. IPC-2141A calls edge rate the most consequential meaning of “high speed” [S8]. A practical first screen compares one-way propagation delay, `t_pd`, with the fastest source rise/fall time. Analog Devices recommends transmission-line treatment and termination when `t_pd >= t_r/2`; more conservative design rules act earlier [S23]. This is a screening rule, not a waiver from return-path discipline.

For a uniform line with per-unit-length series resistance `R`, inductance `L`, shunt conductance `G`, and capacitance `C`:

```text
               R + jωL
Z0(ω) = sqrt( --------- )
               G + jωC

γ(ω) = α + jβ = sqrt[(R + jωL)(G + jωC)]
```

For an ideal lossless TEM line, `R = G = 0`, so:

```text
Z0 = sqrt(L/C)
v_p = 1/sqrt(LC)
```

For a wave reaching a load `ZL`, the load reflection coefficient is:

```text
ΓL = (ZL - Z0) / (ZL + Z0)
```

These relations explain why a local change in line geometry, nearby copper, reference plane, or dielectric becomes a reflection even when DC connectivity remains perfect. They also show why “capacitance, inductance, and resistance” should not be managed independently: the distributed line and its frequency dependence are the object being designed [S8][S29].

## 3. Canonical PCB transmission-line structures

### 3.1 Surface microstrip

```text
 air or solder mask
       ┌──── signal copper ────┐       width w, thickness t
───────┴───────────────────────┴─────── dielectric surface
              dielectric h             effective Dk mixes dielectric and air/mask
════════════ continuous reference ════
```

Fields occupy both the dielectric and the material above it. Solder mask therefore changes effective permittivity and impedance; the effect is stronger for narrow traces and tightly spaced pairs. Surface microstrip is accessible and often lower in dielectric loss than stripline because part of its field is in air, but it radiates/couples more readily and is sensitive to coating, local copper, and the external plated/etched trace profile.

### 3.2 Embedded microstrip

An outer or near-surface conductor is covered by dielectric while still having one dominant plane reference. It is not the same model as exposed microstrip. The overlay thickness and Dk are required, and a second nearby plane can make the structure asymmetric stripline rather than microstrip.

### 3.3 Symmetric and offset stripline

```text
════════════ upper reference plane ════
              dielectric h1
             ┌── signal ──┐
─────────────┴─────────────┴──────────
              dielectric h2
════════════ lower reference plane ════
```

`h1 = h2` is symmetric stripline; unequal distances form offset/asymmetric stripline. Nearly all of the field is in dielectric, so propagation is close to TEM and external solder mask is irrelevant. Stripline normally contains radiation and crosstalk better than microstrip, but it usually has greater dielectric loss and depends on both reference planes, their continuity, and their AC relationship.

### 3.4 CPW and grounded CPW

```text
same layer:     GND  gap s  SIGNAL w  gap s  GND
                ───          ──────          ───

optional/typical for GCPW:
════════════════ backside reference plane ════════════════
     via fences connect same-side grounds to the plane
```

Wen's original CPW places the return conductors beside the signal on the same surface [S12]. PCB “coplanar” calculators often mean **grounded** CPW, where a backside plane also participates. Width, slot/gap, substrate height, ground width, backside plane, conductor thickness, solder mask, and via-fence geometry all affect the result. A ground pour beside a trace is not automatically a controlled CPW: it must have the modeled gap, adequate lateral extent, and a low-inductance connection to the reference network.

### 3.5 Coupled lines

Edge-coupled microstrip, stripline, and GCPW support even and odd modes. With conventional definitions:

```text
Zdiff = 2 Zodd
Zcommon = Zeven / 2
```

`Zdiff` is not twice the isolated single-ended impedance unless coupling is negligible. Pair gap, copper thickness/profile, reference distances, mask, pair-to-copper clearance, and asymmetry are mandatory inputs. Broadside-coupled pairs require registration tolerance and a different solver model. The two legs must also be individually balanced; meeting only differential impedance can hide common-mode conversion.

## 4. Equations and models: what they do and do not prove

### 4.1 Hammerstad–Jensen microstrip model

Hammerstad and Jensen's 1980 model remains a useful quasi-static baseline [S9]. The following zero-thickness core is reproduced in the Qucs/scikit-rf implementations [S10][S29]. Let `u = w/h`, `η0 ≈ 376.7303137 Ω`, and:

```text
a(u) = 1 + (1/49) ln[(u^4 + (u/52)^2)/(u^4 + 0.432)]
         + (1/18.7) ln[1 + (u/18.1)^3]

b(εr) = 0.564 [(εr - 0.9)/(εr + 3)]^0.053

εeff = (εr + 1)/2 + (εr - 1)/2 · (1 + 10/u)^[-a(u)b(εr)]

F(u) = 6 + (2π - 6) exp[-(30.666/u)^0.7528]

Zair(u) = η0/(2π) ln[F(u)/u + sqrt(1 + (2/u)^2)]

Z0 ≈ Zair(u)/sqrt(εeff)
```

Finite thickness can be approximated by an effective-width correction. With normalized `τ = t/h`:

```text
Δu1 = (τ/π) ln{1 + [4e/τ] tanh²[sqrt(6.517u)]}

Δur = (Δu1/2){1 + sech[sqrt(εr - 1)]}
```

The corrected widths are then used as specified by the model. This is already more defensible than a one-line IPC-era estimate, but it still assumes a homogeneous isotropic substrate, an infinitely wide/thick reference conductor, a uniform straight line, and an idealized trace. It does not inherently include solder mask, trapezoidal etch, finite coplanar grounds, weave, nearby traces, plane voids, surface roughness, vias, or connector launches. Frequency-dispersion corrections are separate.

### 4.2 A simple symmetric-stripline estimate

Wheeler's conformal-mapping work is foundational for stripline and microstrip approximations [S11]. A common preliminary expression for a centered strip between planes is:

```text
            60          4b
Z0 ≈ ------------- ln[ ------------------ ]
         sqrt(εr)       0.67π(0.8w + t)
```

Here `b` is the total separation between reference-plane copper surfaces, while `w` and `t` are conductor width and thickness in the same units. This formula is useful for intuition and the worked example below, not for an offset line, trapezoid, very thick/narrow conductor, coupled pair, anisotropic composite, or release geometry. A 2-D field solver should use the actual `h1`, `h2`, top width, base width, and material stack.

### 4.3 CPW conformal-mapping baseline

For an ideal, infinitely thin, unbacked CPW on a sufficiently thick substrate, one common quasi-static form is:

```text
k  = w/(w + 2s)
k' = sqrt(1 - k²)

Z0 ≈ [30π/sqrt(εeff)] · K(k')/K(k)
```

`K` is the complete elliptic integral of the first kind. This form is valuable because it makes the width-to-slot ratio explicit. It is not the correct final model for a PCB GCPW with a nearby backside plane, finite ground strips, solder mask, finite copper thickness, via fences, or multilayer dielectrics. Those features change the capacitance and current distribution; use the corresponding solver geometry [S12][S30].

### 4.4 Loss and roughness models

The copper skin depth and smooth-conductor surface resistance are:

```text
δ = sqrt[ρ/(π f μ)]
Rs = sqrt(π f μ ρ)
```

Using annealed-copper resistivity `ρ = 1.724×10^-8 Ω·m` and `μ ≈ μ0`, skin depth is about 2.09 µm at 1 GHz, 0.93 µm at 5 GHz, and 0.66 µm at 10 GHz. Foil nodules with comparable scale can therefore materially raise conductor loss and phase delay.

The Hammerstad roughness correction used in many line models is:

```text
Kr = 1 + (2/π) atan[1.4(Δ/δ)²]
```

where `Δ` is an RMS roughness parameter. The Huray “snowball” model instead represents the conductor surface with populations of nodules and is often better suited to measured foil morphology [S19]. Neither model is meaningful if the roughness statistic supplied by the foil vendor does not match the model parameter. `Ra`, `Rq/RMS`, `Rz`, and nodule radius/surface ratio are not interchangeable.

For a TEM stripline, a useful first-order dielectric attenuation estimate is:

```text
αd ≈ (π f/c) sqrt(εr) tanδ       [Np/m]
```

For microstrip, field filling requires an effective-permittivity factor; the scikit-rf Hammerstad implementation provides one such model [S29]. These equations reinforce two rules: Df is primarily a loss input rather than a stand-alone impedance target, and both dielectric and conductor loss grow with frequency. For a production SerDes or RF channel, use a broadband complex-permittivity model and correlate insertion loss with an appropriate test vehicle.

### 4.5 Sensitivity and tolerance combination

For independent inputs `xi`, calculate local normalized sensitivities from the chosen solver:

```text
Si = ∂ln(Z0)/∂ln(xi)
```

A conservative first-order worst-case estimate is:

```text
|ΔZ0/Z0|worst ≈ Σ |Si| |Δxi/xi|
```

Root-sum-square combination is only justified for statistically independent, approximately centered variations with known distributions. Lamination thickness, resin content, copper density, etch, and plating can be correlated, so blindly applying RSS understates risk. Monte Carlo is useful only when its distributions and correlations come from the fabricator's actual process data.

## 5. Material system: Dk, Df, thickness, weave, and environmental variation

### 5.1 “Dk” must carry metadata

Every Dk value used for controlled impedance should be tagged with:

- material family and exact construction;
- core or prepreg, glass style(s), resin content, and cured thickness;
- test method and field orientation;
- frequency or fitted frequency range;
- temperature and conditioning/moisture state when relevant;
- “process/specification,” “typical,” or “design/effective” status; and
- source revision/date.

IPC publishes multiple Dk/Df methods because they excite materials differently, including clamped stripline, split-cylinder, and split-post resonator methods [S36]. Values from different methods are not automatically interchangeable. A PCB trace sees an effective composite and an in-plane field distribution, not merely the bulk number printed at 1 MHz.

Rogers provides a concrete warning. Its RO4350B table gives process Dk `3.48 ± 0.05` at 10 GHz by IPC clamped stripline, but average design Dk `3.66` over 8–40 GHz by a differential phase-length method. The same datasheet notes a different process Dk for 4 mil material and thickness dependence of the design value [S13]. The correct input depends on the solver purpose and the fabricator's correlation.

### 5.2 Prepreg is a process result, not a fixed spacer

A core is already cured and its thickness is comparatively well controlled. Prepreg flows during lamination. Final dielectric height depends on glass style, resin content, copper pattern/coverage, number of plies, press cycle, resin flow into etched clearances, and the fabricator's process. Nominal supplier sheet thickness is therefore not the pressed dielectric thickness.

JLCPCB explicitly says its published prepreg thickness is **after lamination** and its Dk is deduced from actual production rather than copied from raw supplier data [S3]. That is the right category of value for its own solver, but it remains vendor-specific and subject to change. JLCPCB's current calculator guide says 4–8 layer calculations assume Nan Ya NP-155F and 10+ layer calculations assume Shengyi S1000-2M, with construction-specific Dk values rather than one universal FR-4 number [S2].

### 5.3 Resin content and glass weave

Woven-glass laminate is spatially inhomogeneous: glass-rich regions have higher permittivity than resin-rich regions. Changing resin content or glass style changes both thickness and effective Dk/Df. IPC-published material research demonstrates that measured laminate Dk/Df changes with glass-to-resin ratio and frequency [S15].

The weave can also create local impedance variation and differential skew. Intel describes how one pair member can ride a glass bundle while the other rides resin, producing different velocities; tighter or spread weave, rotating routing relative to the weave, or using an appropriate zig-zag angle can reduce systematic alignment [S16][S17]. These are mitigations, not guarantees. For a low-skew channel, obtain the actual glass styles adjacent to the routed layer and model or bound the effect.

### 5.4 Df, dispersion, temperature, and moisture

`Df = tanδ` represents dielectric loss under a stated test condition. It is frequency-dependent and can vary with resin system, cure, temperature, and moisture. A low Df does not by itself ensure stable impedance, and a stable Dk does not by itself ensure low loss. Use a broadband causal material model when time-domain simulation spans a wide band.

Temperature changes Dk and physical dimensions. Moisture usually raises loss and can shift permittivity. If operation, qualification, or storage is extreme, ask the laminate supplier for temperature coefficient, moisture conditioning, and lot limits; solve at corners and validate the assembled channel. Rogers, for example, publishes a thermal coefficient of Dk and cautions that prolonged high-temperature oxidative exposure can change hydrocarbon material properties [S13].

## 6. Copper: thickness, plating, etch profile, and roughness

### 6.1 “One ounce” is not one universal finished thickness

The geometric conversion is approximately 35 µm for 1 oz/ft² of copper, but finished construction depends on process. Outer conductors begin with foil and receive panel/pattern plating associated with through-hole fabrication; inner conductors are imaged and etched before lamination and do not receive the same external build-up. Finished outer copper can therefore be thicker than the nominal starting foil and may vary across a panel.

**JLCPCB-specific snapshot:** its calculator currently uses 1.6 mil for finished 1 oz external copper, 0.6 mil for 0.5 oz internal copper, and 1.2 mil for 1 oz internal copper. It explains that internal foil loses a small amount during processing; for example, 0.5 oz becomes approximately 15.2 µm rather than the nominal 17.5 µm [S2]. Those values are inputs for JLCPCB's named constructions, not universal ounce conversions.

### 6.2 Etch makes a trapezoid

Subtractive etching removes copper laterally as well as vertically. The resulting conductor usually has different top and base widths. Therefore a manufacturing drawing and solver should distinguish:

```text
Wdesign  = CAD/artwork width before CAM compensation
Wbase    = finished width at the dielectric interface
Wtop     = finished width at the top of the copper
t        = finished copper thickness
```

JLCPCB's current calculator assumes `Wtop = Wbase - 0.7 mil` for the supported construction [S2]. Its etch-factor article defines etch factor as etch depth divided by one-side undercut and says it adds controlled-impedance coupons to production panels [S26]. Both are **vendor claims**, not a reason to bake 0.7 mil into a design sent to another fabricator.

Thicker copper needs more etch time and generally larger feature/space allowances. **JLCPCB-specific snapshot:** its calculator supports 0.5 oz and 1 oz inner copper; for outer layers it calculates only 1 oz even though 2 oz fabrication is offered, citing the wider tolerance of heavy-copper traces [S2]. Its copper guide lists larger minimum trace/space for 2 oz than 1 oz [S5]. Verify live capabilities.

### 6.3 Artwork compensation and authority

Fabricators commonly modify artwork to compensate for etch and to tune impedance. The purchase data must say whether:

- the supplied width is nominal CAD width or required finished width;
- CAM may change controlled-impedance widths and by how much;
- pair gap may be changed, or only width;
- changes require customer approval;
- the fabricator is responsible for meeting impedance from a target (“controlled impedance”) or only for building supplied geometry (“impedance controlled by design”); and
- revised Gerbers/ODB++ and final as-built stack-up will be returned.

Do not pre-compensate unless the fabricator asks. Double compensation can miss the target. Preserve net-class identity so CAM can distinguish controlled structures from coincidentally equal-width traces.

### 6.4 Copper roughness is a loss and phase variable

The dielectric-facing foil treatment can be electrically more important than the visible side because high-frequency current flows on all conductor surfaces according to field distribution. Ask for foil type (standard, VLP, HVLP/LoPro or supplier-specific equivalent) and roughness statistics on the relevant side. At multi-gigahertz frequencies, roughness comparable to skin depth can increase attenuation and effective electrical length [S19][S20]. Use the model requested by the solver and populate its matching parameters; do not convert `Rz` to RMS with an undocumented constant.

## 7. Reference planes and return-current continuity

### 7.1 A reference plane is part of the signal path

At high frequency, return current concentrates where it minimizes loop inductance, usually directly adjacent to the outbound trace. A nearby uninterrupted plane lowers loop area and makes impedance predictable. Intel explicitly states that the physical return path is as important as the signal path and recommends adjacent planes for high-frequency power current and routed signals [S18].

Hard rules:

- Do not route a controlled line across a split, slot, antipad field, connector keepout, or plane edge in its reference plane.
- Keep plane voids and unrelated cutouts far enough away that the field solver shows negligible impact; a “3W” spacing slogan is not proof for every stack.
- Keep reference-plane copper continuous under bends, tuning, connectors, AC-coupling components, and test structures.
- Treat a plane neck-down as a return-path neck-down.
- A differential pair still needs a coherent plane. Its differential field may reduce net return current, but imbalance and common-mode current require a return path.

### 7.2 Layer transitions

When a signal via changes layers, the return current must also change reference surfaces locally:

- **Ground plane to ground plane:** place one or more ground stitching vias close to the signal transition, with quantity and distance based on bandwidth and geometry.
- **Ground plane to power plane:** provide a nearby low-inductance decoupling path between those reference nets, or change the layer assignment so both traces reference ground. A ground via alone does not connect return current to an isolated power plane.
- **Power plane to power plane of the same net:** use appropriate stitching/decoupling based on the plane network and common-mode path.
- **Differential transition:** use symmetric signal vias and return-via geometry. Symmetry reduces mode conversion but does not remove the common-mode return requirement.

Intel's current high-speed guidance for one device family calls for return ground vias within 50 mil of high-speed signal transition vias; that is a **device/vendor guideline**, not a universal electromagnetic threshold [S25]. Optimize the actual launch with a 3-D solver for stringent channels.

### 7.3 Can a power plane be a reference?

Yes, electromagnetically, if it is a continuous conductor and has low AC impedance to the ground/reference network over the signal spectrum. But a power-referenced route complicates layer transitions and can couple signal return current into the PDN. Do not assume two planes bearing different net names are AC-short everywhere. Model their spreading inductance, decoupling placement, and cavity behavior.

## 8. Layer pairing and practical stack-up architectures

There is no universal “best 4/6/8-layer stack.” The dielectric distances, material constructions, copper weights, routing density, power domains, and channel types determine the answer. The following are architectures to negotiate with the fabricator, not dimensions to copy.

### 8.1 Four layers

```text
L1  components + controlled surface signals
     thin prepreg
L2  solid GND reference
     core (often the mechanically thick center)
L3  plane: preferably solid; power only if L4 may reference it safely
     thin prepreg
L4  signals / low-speed / power pours as allowed
```

Advantages: low cost, good L1 reference, simple assembly. Limitations: L4 references L3, so a split power plane makes L4 controlled routing risky; L2–L3 may be too far apart for useful plane-pair capacitance; the two surface structures can differ because plating/mask/copper distribution differ. If both surfaces carry demanding channels, a signal/GND/GND/signal construction with power distributed by pours may be electrically cleaner, but power routing and current capacity must still work.

### 8.2 Six layers

```text
L1  signal
L2  solid GND
L3  signal or plane
L4  signal or plane
L5  solid GND
L6  signal
```

This symmetric functional outline can provide surface microstrip and inner stripline, but L3/L4 must not become two adjacent high-speed signal layers without careful broadside-coupling analysis. Common choices make one of them power and keep high-speed routes against L2/L5; another choice uses both for signals with their nearest ground plane and routes them orthogonally. “Orthogonal” reduces broadside coupling but does not eliminate it. Negotiate exact plane assignments and spacings.

### 8.3 Eight layers

An eight-layer design can give each signal layer a nearby plane and place a power/ground pair close together. One candidate is:

```text
L1  signal        ↔ L2 GND
L2  GND
L3  signal        ↔ L2 or L4, whichever is deliberately closest/continuous
L4  GND or power plane
L5  power or GND plane, tightly paired with L4 when useful
L6  signal        ↔ L5 or L7, deliberately selected
L7  GND
L8  signal        ↔ L7 GND
```

Net names need not be mirror images for mechanical symmetry, but copper thickness, dielectric construction, and copper distribution should be balanced. If L6 references a power plane, its return and layer transitions need explicit treatment. Never infer the reference merely from the nearest layer number; record it per impedance structure.

### 8.4 Pairing rules

1. Put a continuous plane directly adjacent to every high-speed signal layer.
2. Prefer ground as the reference for routes that transition layers or leave the board, unless the power-reference return path is deliberately engineered.
3. Avoid adjacent signal layers. If unavoidable, increase spacing, route orthogonally where applicable, and quantify broadside coupling.
4. Pair power and ground planes closely when PDN analysis benefits, but do not sacrifice all signal references merely to create plane capacitance.
5. Use thin, fabricator-standard dielectrics near controlled routes to obtain practical line widths and tight field confinement; do not push below reliable lamination limits.
6. Preserve room for manufacturable traces. An extremely thin dielectric can force traces narrower than robust etch capability; a thick dielectric can force very wide traces or tight CPW gaps.
7. Lock the construction before detailed routing. Moving a route one layer invalidates its impedance geometry.

## 9. Power-plane resonance and plane-pair design

A power/ground plane pair is a distributed parallel-plate structure, not an ideal capacitor. Its low-frequency capacitance is approximately:

```text
Cplane ≈ ε0 εr A/d
```

where `A` is overlapping area and `d` is separation. Smaller `d` increases capacitance and reduces spreading inductance. At higher frequency, edges and discontinuities allow standing-wave cavity modes. For an ideal thin rectangular plane pair of dimensions `a × b`, a useful first estimate is:

```text
               c
fmn ≈ ----------------- sqrt[(m/a)² + (n/b)²]
          2 sqrt(εr)
```

for nonzero integer mode indices `m,n`. Published cavity-model work validates the plane-pair treatment against measurement and numerical analysis under its assumptions [S24]. Real resonance frequency and Q shift with plane shape, apertures, loss, decoupling, ports, via fields, components, and edge conditions.

Design implications:

- Thin power/ground spacing improves high-frequency PDN behavior but does not guarantee damping. A very low-loss pair can have high-Q resonances.
- Place and select decoupling from a target-impedance/anti-resonance analysis, including mounting inductance and package/on-die capacitance.
- Avoid plane shapes and splits that create narrow cavities or force return current around long slots.
- A high-speed line referenced to a power plane can excite PDN modes through transitions and imbalance.
- Use a 2-D/3-D PDN solver or VNA test vehicle for consequential designs; the rectangle equation is only a screening calculation.

## 10. Symmetry, copper balance, and warpage

A mechanically symmetric build mirrors, about the midplane:

- dielectric type and nominal/pressed thickness;
- copper foil/finished thickness;
- number and type of prepreg plies;
- where possible, copper coverage and pattern density; and
- lamination sequence.

Symmetry reduces differential shrinkage and thermal stress, but it does not guarantee flatness. Copper pattern imbalance, local resin flow, board outline, cutouts, component copper, material CTE, multiple lamination cycles, and assembly thermal history also contribute. IPC design standards explicitly cover bow/twist and balanced conductors, and JLCPCB advises adding copper in very low-coverage inner areas to reduce thickness and plating/trace nonuniformity [S27][S6].

Do not add arbitrary balancing copper near controlled lines. Copper fill can change impedance and coupling. Define a keepaway around controlled structures or include the fill in the solver. Let the fabricator apply thieving according to an agreed rule, and review CAM data for high-risk RF geometry.

## 11. Manufacturability and tolerance budgeting

### 11.1 Variables that belong in the budget

For each impedance structure, request nominal, minimum, and maximum where available:

| Variable | Mechanism | Typical electrical direction, all else equal |
|---|---|---|
| Pressed dielectric height to reference plane | prepreg flow, glass, copper density, press cycle | larger height usually raises microstrip impedance |
| Dk/effective Dk | material lot, resin/glass, method, frequency, environment | larger Dk usually lowers impedance and velocity |
| Finished base and top width | imaging, etch, CAM compensation | narrower width usually raises impedance |
| Finished copper thickness | foil, plating, processing loss | thicker/effectively wider conductor usually lowers impedance |
| Differential pair gap | imaging/etch/registration | larger gap weakens coupling and generally raises `Zdiff` for fixed width |
| Coplanar ground gap | imaging/etch, copper pullback | smaller gap adds capacitance and generally lowers impedance |
| Solder-mask thickness/Dk | coating process and registration | added dielectric generally lowers outer-layer impedance |
| Nearby copper/void distance | layout and CAM fill | closer copper usually adds capacitance and changes mode balance |
| Plane registration/antipads | lamination registration | asymmetry and local discontinuity; direction is geometry-specific |
| Roughness and conductivity | foil/process/frequency/temp | primarily increases loss and delay; may perturb impedance |

Directions are not substitutes for a solver. Interactions matter, especially in coupled and coplanar structures.

### 11.2 Design for process center, not the drawing limit

Avoid choosing width, gap, and dielectric at the fabricator's minimum unless density forces it. Minimum features often carry larger relative variation. Heavy copper and very narrow spaces are especially difficult. Prefer a standard, frequently built stack-up with a robust line width, even if it adds layers or changes board thickness.

**JLCPCB-specific snapshot:** its 2025 copper guide lists 3.5 mil minimum trace/space for many ≥4-layer 0.5/1 oz builds, with 3 mil at extra cost, and 6.5 mil for 2 oz [S5]. These are published design limits, not promised impedance tolerances and not portable to another supplier.

### 11.3 Prototype-to-production transfer

A prototype from one stack/material/process does not validate another. If volume production changes fabricator, laminate, foil, copper weight, panel size, solder mask, surface finish, layer count, or stack ID, re-solve and requalify. Ask for:

- final as-built stack-up and material certificates;
- CAM-adjusted controlled widths/gaps;
- coupon serial linkage to panels/lots;
- TDR raw plots and summarized min/average/max;
- microsections for trace profile and dielectric thickness when risk warrants; and
- frequency-domain insertion/return-loss data when the channel budget requires it.

## 12. Impedance coupons and TDR acceptance

### 12.1 What a good coupon represents

A coupon should be fabricated on the same production panel, with the same material lot/process, layer, reference planes, copper weight, trace aperture/geometry, solder mask, and relevant surrounding copper as the product structure. Polar recommends same-panel coupons, commonly at both panel ends, using the same aperture code to sample across-panel process variation [S21].

Each controlled structure needs representation: outer microstrip with/without mask as delivered, each unique stripline construction, and each unique differential/coplanar geometry. The coupon should have the probe footprint the test house actually uses and a straight uniform measurement region. Polar cites approximately 150 mm (6 in) as an advantageous coupon trace length for a stable measurement window [S22]. Final coupon design must follow the agreed IPC/fabricator/test-system method.

A coupon verifies a **process proxy**. It does not verify connector launches, vias, serpentine coupling, plane splits, component pads, or every local product trace. Those require design simulation and, when necessary, on-board TDR/VNA structures.

### 12.2 TDR equations and limitations

A TDR launches a step through a calibrated reference impedance and observes reflection. IPC-TM-650 2.5.5.7A gives:

```text
ρ = Vr / Vi

Zx = Zstd (1 + ρ)/(1 - ρ)
```

where `Vi` is incident step amplitude, `Vr` is reflected amplitude in the defined measurement zone, and `Zstd` is the calibrated standard/reference impedance [S7]. Differential TDR excites the two lines with opposite polarity and extracts odd-mode/differential behavior.

The report should identify instrument, calibration/airline or transfer standard, probe, system rise time or applied filter, test direction, coupon and panel serial, temperature, measurement window, nominal limits, and average/min/max result. Keep the same waveform region and filtering for comparisons.

IPC warns that measured impedance is derived, measurement systems differ, accuracy degrades as the test impedance moves far from the typical 50 Ω system, sample geometry matters, and multiple reflections can make position profiling unreliable [S7]. Faster rise time improves spatial resolution but makes launches and small defects more visible; different rise-time filtering can therefore produce different reported values [S20][S31].

### 12.3 Acceptance language

Write acceptance notes so they cannot be interpreted three ways. Example:

```text
CI-01: L1 microstrip, 50.0 Ω single-ended ±10%.
CI-02: L3 edge-coupled stripline, 100.0 Ω differential ±10%;
       nominal finished pair geometry Wbase/Wtop/S = ___/___/___ mm.

Fabricator shall synthesize from approved stack-up REV __ and may adjust
controlled line widths only within ___ after written approval. Test one coupon
per represented structure at both panel locations using IPC-TM-650 2.5.5.7A
(or agreed successor/method). Acceptance applies to [average / min-max over
defined zone] for every coupon. Supply as-built stack-up, CAM dimensions,
calibration/method metadata, plots, and panel/coupon serial linkage.
```

Do not state only “50 Ω controlled” or “90 Ω diff.” Define tolerance, geometry class, layers, method, statistic, and deliverables.

## 13. Worked examples

These examples teach method and sensitivity. They are **not fabrication recipes**.

### Example A: preliminary 50 Ω surface microstrip

Assume:

```text
h  = 0.180 mm       dielectric from trace base to plane surface
t  = 0.035 mm       rectangular copper approximation
εr = 4.10           isotropic, nondispersive preliminary value
target = 50.0 Ω
```

Numerically solving the finite-thickness Hammerstad–Jensen model above gives:

```text
w ≈ 0.3330 mm (13.11 mil)
εeff ≈ 3.141
effective corrected width ≈ 0.3630 mm
Z0 = 50.00 Ω in this model
```

One-factor sensitivity checks while holding the solved CAD width fixed:

| Case | Model result |
|---|---:|
| `h = 0.162 mm` (-10%) | 46.91 Ω |
| `h = 0.198 mm` (+10%) | 52.89 Ω |
| `εr = 3.90` | 51.09 Ω |
| `εr = 4.30` | 48.98 Ω |
| `w = 0.2997 mm` (-10%) | 52.97 Ω |
| `w = 0.3663 mm` (+10%) | 47.36 Ω |

This already consumes several ohms before tolerances are combined. A real coated external trace would require top/base widths, plating thickness, solder-mask thickness/Dk, nearby copper, and a frequency-aware material model. Adding solder mask generally lowers impedance; recovering 50 Ω would generally require a narrower line, but only the correct coated-microstrip solver should determine it.

### Example B: preliminary centered 50 Ω stripline

Assume the simple stripline equation, `b = 0.300 mm` between plane copper surfaces, `t = 0.018 mm`, and `εr = 4.00`. Solving:

```text
50 = (60/sqrt(4.00)) ln{4(0.300)/[0.67π(0.8w + 0.018)]}

w ≈ 0.1121 mm (4.41 mil)
```

This narrow result is a manufacturability warning: a different plane separation may yield a more robust line. It must be re-solved with the real offset, trace trapezoid, material construction, and fab minimums. If it is a pair, spacing must be solved simultaneously; doubling 50 Ω does not create a 100 Ω differential design.

### Example C: rectangular plane-pair resonance screen

For ideal planes `100 mm × 80 mm` filled with `εr = 4.2`:

```text
f10 ≈ 731 MHz
f01 ≈ 914 MHz
f11 ≈ 1.171 GHz
```

These numbers are flags for PDN simulation, not predicted peaks on an assembled board. Ports, decouplers, cutouts, loss, mounting inductance, and irregular outline shift and damp the modes. A signal edge with spectral energy in this range can still excite the structure even if its clock or fundamental is lower.

### Example D: why the article's differential table cannot be reproduced

Suppose a table states “100 Ω differential, 5–7 mil width, 6–8 mil dielectric.” Missing pair gap alone creates an infinite family of answers: a tight gap increases coupling and lowers `Zdiff` for fixed width, while a wide gap approaches twice the isolated line impedance. Missing mask, layer, Dk method, copper thickness/profile, and nearby ground make the family broader. The correct action is not to choose the midpoint; it is to request the missing cross-section and solve `w` and `s` together.

## 14. Solver selection and caveats

### 14.1 Choose the solver to match the question

- **Closed-form calculator:** rapid feasibility, trends, and initial width. Appropriate only when its named geometry and assumptions match.
- **2-D quasi-static field solver:** production line synthesis for uniform cross-sections, coupled modes, trapezoids, mask, multilayer dielectrics, finite grounds, and local copper.
- **2-D full-wave or broadband RLGC solver:** dispersion and loss over frequency for uniform lines.
- **3-D full-wave solver:** vias, launches, bends, pads, plane transitions, connectors, cavities, finite via fences, and mode conversion.
- **PDN/cavity solver:** distributed plane impedance, anti-resonance, spreading inductance, and decoupling.

### 14.2 Solver settings that must be recorded

Record solver/version, geometry template, units, reference-plane selection, frequency/frequency sweep, mesh/convergence, port definition, boundary distance/type, conductor conductivity, plating, top/base width, thickness, roughness model and parameters, dielectric model/Dk/Df/source, anisotropy, solder mask, surrounding copper, and whether reported width is synthesized at top, base, or nominal center.

### 14.3 Common failure modes

- Selecting “microstrip” for a trace with close coplanar ground or a second plane.
- Selecting “coplanar” without modeling via-fence pitch or ground connectivity.
- Entering nominal 1 oz as 35 µm when finished external copper is plated thicker.
- Entering total board thickness as dielectric height.
- Using supplier process Dk where design Dk is required, or mixing methods/frequencies.
- Treating Dk and Df as constants across a wide band.
- Ignoring solder mask or assuming mask over trace equals mask over bare laminate.
- Modeling a rectangle when the fab controls a trapezoid.
- Ignoring finite reference-plane width, nearby pours, voids, and antipads.
- Solving a pair from single-ended lines or omitting common-mode/even-mode analysis.
- Trusting a synthesized width below the fabricator's stable process center.
- Assuming two solvers should match when their geometry conventions differ.
- Declaring success because nominal impedance is correct while tolerance corners fail.

Cross-check at least one representative structure with a second method, then correlate to a coupon. Disagreement is diagnostic: first align geometry definitions and material inputs before deciding one solver is wrong.

## 15. Fabricator communication package

Send a controlled document, not an email fragment. Minimum package:

### A. Board and stack identity

- board part number/revision, layer count, finished thickness and tolerance;
- selected fabricator, plant if relevant, standard/custom stack ID and revision;
- exact laminate/core/prepreg family, glass styles, ply count, resin content, pressed thicknesses;
- copper foil types and base/finished thickness per layer;
- solder-mask family, thickness model, Dk/Df where modeled;
- surface finish and sequential-lamination/backdrill requirements.

### B. Impedance table

For each structure: structure ID, net class/protocol, target/tolerance, single-ended or differential/mode definition, layer, reference plane(s)/net(s), nominal CAD width, required finished top/base width, pair gap or CPW gap, copper-to-other-copper clearance, mask state, and maximum length affected by neck-downs.

### C. Process authority

- whether the fab owns impedance synthesis or only geometry;
- permitted CAM changes and approval threshold;
- whether width, gap, or dielectric may be adjusted;
- requirement to return proposed/final values and updated fabrication data;
- substitution policy for laminate, glass style, foil, solder mask, and stack.

### D. Verification

- coupon ownership/design, panel locations, represented structures;
- test standard/method, rise time/filter, measurement statistic, acceptance limits;
- lot/panel sampling versus every panel;
- required TDR plots/data, microsections, material certificates, and as-built stack;
- insertion-loss/VNA method and limits if applicable;
- disposition and approval path for out-of-tolerance results.

Resolve contradictions before purchase order. In particular, do not accept simultaneous notes saying both “do not modify artwork” and “fabricator to adjust width to meet impedance.”

## 16. JLCPCB-specific capability snapshot — not portable

The following is included because the anchor article is from JLCPCB. It must not be generalized to other suppliers or assumed valid for a future JLCPCB order.

As of the cited pages accessed 2026-09-06:

- The JLCPCB calculator accepts 20–90 Ω single-ended and 50–150 Ω differential targets and supports coplanar/non-coplanar single-ended and differential choices [S2].
- It supports 0.5 oz and 1 oz inner copper in the calculator; 2 oz inner requires support contact. It supports only 1 oz external in the calculator despite some 2 oz fabrication offerings [S2].
- It uses finished thicknesses 1.6 mil external 1 oz, 0.6 mil internal 0.5 oz, and 1.2 mil internal 1 oz; solder-mask Dk 3.8 with separate coating thicknesses; and a 0.7 mil top-to-base trace-width reduction [S2].
- It currently assumes Nan Ya NP-155F for 4–8 layers and Shengyi S1000-2M for 10+ layers. Its published Dk varies by core thickness and prepreg construction and may be revised from test correlation [S2].
- JLCPCB says it offers more than 200 standard/proprietary laminate structures and 4–32 layer fabrication, but actual availability must be checked in the order interface [S3].
- The current multilayer help page says standard free impedance testing is ±20% and precision testing is chargeable. This conflicts with the anchor article's ±10%/±5% language [S1][S3]. No tighter numeric guarantee should be inferred from “precision.”
- The first calculator-recommended stack is described as normally the lowest-cost/fastest option, which is a commercial optimization, not evidence that it is electrically best [S2].

Before ordering, save the selected stack-up output/PDF or screenshot, date, order-page options, and support confirmation. A calculator result does not by itself prove that the exact material, tolerance, coupon, or testing option has been attached to the order.

## 17. Required inputs and hard rules for an AI stack-up assistant

### 17.1 Required input schema

The AI must refuse to label a geometry “production-ready” until these fields are supplied or explicitly delegated to the fabricator:

```yaml
project:
  board_revision:
  fabricator_and_plant:
  order_stack_id_and_revision:
  layer_count:
  finished_board_thickness_and_tolerance:

electrical_requirement:
  interface_or_net_class:
  source_spec_revision:
  target_ohms:
  definition: single_ended | differential | odd_mode | even_mode | common_mode
  tolerance_percent_or_ohms:
  fastest_10_90_or_20_80_edge:
  data_rate_and_encoding:
  frequency_or_bandwidth_of_interest:
  max_channel_length:
  insertion_loss_return_loss_skew_limits:

line_structure:
  layer:
  type: microstrip | embedded_microstrip | stripline | offset_stripline | cpw | gcpw
  reference_layers_and_nets:
  width_cad:
  width_finished_base:
  width_finished_top:
  copper_finished_thickness:
  differential_edge_gap:
  coplanar_ground_gap_and_width:
  nearby_copper_clearance:
  solder_mask_or_coverlay_state:
  mask_thicknesses_and_dk:

dielectric_for_every_relevant_region:
  exact_material_family:
  core_or_prepreg:
  glass_style_and_ply_count:
  resin_content:
  pressed_thickness_nominal_min_max:
  dk_value_method_frequency_axis_temperature_status:
  df_value_method_frequency_temperature:
  anisotropy_or_dispersion_model:

copper_and_process:
  foil_type_and_roughness_metrics:
  base_versus_finished_copper:
  plating_range:
  etch_profile_or_top_base_rule:
  trace_space_process_center_and_absolute_minimum:
  registration_tolerance:
  cam_adjustment_authority:
  copper_balance_and_thieving_rules:

layout_context:
  plane_voids_splits_edges:
  via_and_antipad_geometry:
  return_vias_or_reference_transition:
  connector_and_component_launches:
  pair_tuning_and_neighbor_coupling:

verification:
  coupon_structures_and_panel_locations:
  tdr_method_rise_time_filter_statistic:
  acceptance_sampling_and_limits:
  frequency_domain_test_if_required:
  required_as_built_and_raw_data:
```

### 17.2 Non-negotiable AI rules

1. **Never invent a stack-up dimension or material value.** Unknown is a result, not a prompt to use “typical FR-4.”
2. **Never use finished board thickness as signal-to-plane height.** Sum the actual copper and dielectric construction.
3. **Never quote impedance without naming the structure, layer, references, and geometry convention.**
4. **Never infer the target from a protocol nickname when a source specification is available.** PCIe, USB, DDR, Ethernet, RF, and memory generations/topologies can use different definitions and tolerances.
5. **Use edge rate for transmission-line relevance.** Data rate alone is insufficient.
6. **Distinguish process Dk, specification Dk, typical Dk, and design/effective Dk.** Preserve method and frequency.
7. **Solve differential pairs as coupled structures.** Pair gap is required; report `Zdiff`, and when risk warrants, odd/even/common and leg imbalance.
8. **Include every nearby conductor that materially intersects the field.** Coplanar pour, second plane, shields, mask, and finite grounds cannot be silently omitted.
9. **Use finished top/base width and copper thickness for fabrication prediction.** State when only CAD nominal is known.
10. **Run tolerance/sensitivity analysis.** A nominal hit is insufficient.
11. **Check geometry against the fabricator's stable capability, not only its absolute minimum.**
12. **Lock the reference path.** Flag plane splits, voids, layer transitions without return vias/decoupling, and power-referenced transitions.
13. **Do not claim that symmetry eliminates warpage.** It mitigates one set of drivers.
14. **Do not claim a coupon verifies the complete channel.** It validates the represented uniform process cross-section.
15. **Do not equate impedance tolerance with trace-width tolerance.** The former is the measured electrical result of all interacting process variables.
16. **Do not transfer a vendor-specific calculator value to another fabricator or stack.**
17. **When sources conflict, expose the conflict and use the current order/job confirmation.** Never average policy numbers.
18. **Require human/fabricator approval for material substitution, CAM adjustment, stack revision, or an out-of-tolerance disposition.**
19. **Report units and width semantics on every result.** Mil/mm and top/base/CAD ambiguity are common failure sources.
20. **Label model scope.** Preliminary closed-form, 2-D production cross-section, 3-D discontinuity, and measured result are different evidence levels.

### 17.3 Required AI outputs

The AI should return, in order:

1. completeness gate: missing/blocking inputs;
2. assumptions register with source and expiration/revalidation trigger;
3. candidate stack architectures and tradeoffs;
4. per-structure solver-ready cross-section table;
5. nominal synthesis plus tolerance/sensitivity corners;
6. return-path and transition audit;
7. manufacturability violations and process-center margins;
8. vendor questions and contradiction list;
9. fabrication note/impedance table draft;
10. coupon and measurement plan; and
11. evidence label for each conclusion: calculated, vendor-asserted, fabricator-confirmed, or measured.

## 18. Exceptions and boundary cases

- **Two-layer boards:** controlled microstrip is possible with the opposite side as a continuous plane, but the full board thickness often forces impractically wide traces. GCPW can reduce width, but its gaps, ground width, and via stitching become critical. Ground pours fragmented by routing do not equal a plane.
- **Very short traces:** a route may be electrically short enough that exact impedance has little system impact, but continuity of the return path still matters for crosstalk and EMI. Document why the requirement is waived.
- **Loosely coupled differential pairs:** they approach two independent single-ended lines; return-plane quality and leg balance become more important, not less.
- **Tightly coupled pairs:** coupling can improve rejection of some external fields but forces narrow gap tolerance and can increase etch sensitivity. Solve common-mode conversion and loss.
- **Broadside pairs:** layer registration and dielectric thickness enter directly; do not use an edge-coupled formula.
- **Power-referenced lines:** valid only with a designed AC return to ground and controlled PDN impedance. Split power islands are especially hazardous.
- **RF antennas and intentional radiators:** removal or shaping of reference copper is part of the antenna, so ordinary controlled-line rules stop at the designed feed/reference transition.
- **RF/mmWave structures:** launches, mask openings, copper roughness, finite ground, via fences, radiation, dispersion, and connector models can dominate. Use calibrated VNA/de-embedding structures in addition to TDR coupons.
- **Rigid-flex/flex:** polyimide, adhesive, coverlay, rolled-annealed copper, bend regions, and local thickness change the model; JLCPCB rigid-board values do not apply.
- **HDI/sequential lamination:** laser-via pads, capture lands, stacked/staggered microvias, resin-coated copper, and multiple press cycles require a sequential build model and reliability qualification.
- **Heavy copper:** greater undercut and process variation can conflict with narrow controlled geometry. Separate current-carrying copper from high-speed layers when practical.
- **Very low impedance:** wide traces may interact with finite planes and neighboring copper; a nominal calculator range does not prove the plane can support the mode.
- **Very high impedance:** narrow traces raise conductor loss and etch sensitivity and may exceed reliable minimums.
- **Serpentines:** same-net parallel segments couple. A uniform cross-section impedance calculation does not predict the local even/odd modes or timing error.
- **Plane necks and perforations:** a plane can be nominally one net yet be electromagnetically discontinuous. Review actual copper, not only the net name.
- **High voltage/safety isolation:** creepage, clearance, insulation thickness, and regulatory constraints override impedance-optimal geometry.
- **High-temperature or humid service:** solve material and dimensional corners and qualify after environmental conditioning; room-temperature coupon acceptance alone is insufficient.
- **Multiple fabricators:** either define an electrical requirement and let each fab synthesize its own stack/geometry, or qualify an exact portable material/process. Do not mix one fab's width with another fab's stack.

## 19. Release checklist

- [ ] Interface target, definition, tolerance, edge rate, and channel limits are sourced.
- [ ] Fabricator and exact stack ID/revision are selected.
- [ ] Every controlled layer has an intentional continuous reference plane.
- [ ] Core/prepreg/glass/resin/pressed thickness and Dk/Df metadata are recorded.
- [ ] External and internal finished copper, top/base width, and mask are modeled.
- [ ] Pair/CPW gaps and nearby copper are included.
- [ ] Solver scope, settings, and frequency are recorded.
- [ ] Nominal, worst-case/sensitivity, and manufacturability margins pass.
- [ ] Vias, antipads, launches, tuning, and reference transitions are audited in 3-D when needed.
- [ ] Power-plane resonances and decoupling are analyzed where consequential.
- [ ] Stack and copper distribution are mechanically balanced; fill is kept out of the field or modeled.
- [ ] CAM change authority and substitution rules are unambiguous.
- [ ] Coupon structures, locations, test method, statistic, and acceptance limits are agreed.
- [ ] As-built stack, CAM geometry, coupon plots/data, and lot linkage are required deliverables.
- [ ] Any vendor capability claim was reverified in the live order/job context.

## 20. Full claim/source ledger

| ID | Claim used in this guide | Evidence and source | Status / confidence / limitation |
|---|---|---|---|
| C01 | Controlled impedance depends on stack, material, trace geometry, planes, and vias. | JLCPCB anchor article [S1]; IPC-2141A scope [S8]. | High for principle. Article supplies only a checklist, not a complete model. |
| C02 | Edge rate, not merely bit/clock rate, determines when interconnect properties matter. | IPC-2141A [S8]; Analog Devices MT-097 [S23]. | High. The `t_pd >= t_r/2` threshold is a design guideline, not a physical discontinuity. |
| C03 | `Z0=sqrt[(R+jωL)/(G+jωC)]`, reducing to `sqrt(L/C)` for a lossless line. | IPC-2141A transmission-line basis [S8]; open technical implementation/context [S29]. | High, foundational transmission-line theory. |
| C04 | Hammerstad–Jensen is a high-accuracy quasi-static microstrip approximation with separate thickness/dispersion corrections. | Original IEEE paper DOI [S9]; Qucs equations [S10]; scikit-rf implementation [S29]. | High within stated geometry. Not a universal PCB solver. |
| C05 | Wheeler conformal mapping underlies practical strip/microstrip approximations. | Original IEEE paper DOI [S11]. | High historically/model-wise. The simplified stripline equation here is preliminary. |
| C06 | CPW has same-plane flanking returns; grounded PCB CPW is a different, more constrained geometry. | Wen original IEEE paper [S12]; Sonnet modeling guidance [S30]. | High. Ideal elliptic-integral formula omits PCB GCPW details. |
| C07 | Differential impedance is a coupled-mode property and requires pair spacing. | Coupled-line Hammerstad/Jensen implementation [S32]; IPC differential TDR method [S7]. | High. Exact modal definitions must match solver/test conventions. |
| C08 | Dk/Df values depend on method; IPC maintains several distinct test methods. | IPC TM-650 method register [S36]. | High. A method-specific number may not predict a routed field without correlation. |
| C09 | RO4350B process Dk 3.48 ±0.05 differs from average design Dk 3.66; Df 0.0037 is at 10 GHz. | Rogers RO4000 datasheet [S13]. | High for that datasheet revision. Material thickness/foil option and later revisions must be checked. |
| C10 | Resin content and glass style change laminate Dk/Df and thickness. | IPC-published material study [S15]; Isola construction tables [S14]. | High for mechanism; magnitude is construction-specific. |
| C11 | Fiber weave can produce local impedance/velocity difference and pair skew; spread/tighter weave or angled routing can mitigate it. | Intel stack-up white paper and current FPGA material guidance [S16][S17]. | High for risk and mitigations. No universal safe angle/length. |
| C12 | Prepreg thickness must be treated as pressed/as-built, not supplier sheet nominal. | JLCPCB multilayer help [S3]. | High for principle; JLC numeric values are vendor-specific. |
| C13 | JLC calculator currently assumes NP-155F for 4–8 layers and S1000-2M for 10+ with construction-specific Dk. | JLC calculator guide [S2]. | Vendor-specific snapshot, medium-high; page says values can change. |
| C14 | Outer and inner “1 oz” do not imply the same finished thickness in JLC's process. | JLC calculator guide [S2]. | Vendor-specific snapshot. Do not generalize to another fab. |
| C15 | Etch produces top/base width differences; JLC calculator assumes 0.7 mil difference. | JLC calculator guide [S2]; JLC etch-factor article [S26]. | Physical mechanism high; 0.7 mil is vendor/model-specific, not universal. |
| C16 | Heavy copper drives larger feature limits and is not fully supported by JLC's online impedance calculator. | JLC calculator guide and copper guide [S2][S5]. | Vendor-specific snapshot; live quote controls. |
| C17 | Copper roughness comparable to skin depth increases high-frequency conductor loss; Hammerstad and Huray are different parameterizations. | Huray original paper DOI/abstract [S19]; Rogers technical discussion [S20]; scikit-rf implementation [S29]. | High for mechanism. Quantitative result requires matching roughness data/model. |
| C18 | A continuous adjacent plane controls high-frequency return loop and impedance. | Intel SSN/high-speed guidance [S18]; Analog Devices line guidance [S23]. | High. “Adjacent” still requires quantified spacing and actual plane geometry. |
| C19 | Reference transitions need a local return path; a differential transition benefits from return vias too. | Intel current device-family guidance [S25]. | High for principle; 50 mil is device/vendor guidance, not universal. |
| C20 | Closely paired power/ground planes reduce loop inductance and provide distributed capacitance. | Intel SSN guidance [S18]. | High for principle. Does not imply resonance damping or replace decouplers. |
| C21 | Rectangular power/ground pairs exhibit cavity modes approximated by `fmn`. | Published IEEE cavity-model paper [S24]. | High under ideal thin rectangular assumptions; real board requires PDN/full-wave analysis. |
| C22 | Balanced/symmetric construction mitigates bow/twist, while copper coverage affects lamination uniformity. | IPC-2228/2221 topic coverage [S27][S33]; JLC copper-coverage guidance [S6]. | High for mechanism; exact bow/twist acceptance comes from contract/class/current standard. |
| C23 | Same-panel coupons using the same layer/material/geometry provide a production-process proxy. | Polar AP124 [S21]. | High, instrument-industry guidance. Coupon does not verify product discontinuities. |
| C24 | Approximately 150 mm coupon traces improve the stable TDR measurement region. | Polar AP132 [S22]. | Medium-high practical guidance; final length depends on method and TDR rise time. |
| C25 | TDR computes impedance from reflection coefficient and a calibrated reference. | IPC-TM-650 2.5.5.7A [S7]; Keysight TDR note [S20]. | High. Calibration, probe, rise time, and measurement window affect uncertainty. |
| C26 | TDR impedance is derived; values can differ by equipment/method and degrade away from a 50 Ω system. | IPC-TM-650 2.5.5.7A [S7]. | High. Follow the contractually named method. |
| C27 | A coupon does not establish full-channel launch/via/connector performance. | Polar AP124/AP8502 [S21][S31]; Tektronix TDR primer [S34]. | High. Use 3-D simulation and on-board/VNA structures where needed. |
| C28 | JLC's article examples are underdetermined and its RO4350B Dk label mixes process/design use. | Article fields [S1] compared with Rogers datasheet [S13]. | High as an audit: required geometry is absent and published Dk categories differ. |
| C29 | JLC's article tolerance statement conflicts with JLC's current multilayer help. | Article [S1] versus help page [S3]. | High that conflict exists; actual current order/job terms remain unresolved until quote confirmation. |
| C30 | JLC calculator ranges, copper support, mask inputs, and first-result cost preference are current vendor features. | JLC calculator guide [S2]. | Vendor-specific snapshot; not a guarantee of order acceptance. |
| C31 | JLC advertises 4–32 layers and >200 structures. | JLC multilayer help [S3]. | Vendor assertion; actual material/thickness combination must be checked live. |
| C32 | A 2-D field solver is appropriate for uniform cross-sections; complex CPW/launch geometry must match the model. | Sonnet CPW guidance [S30]; Qucs/scikit-rf model scope [S10][S29]. | High as solver-selection guidance; vendor tools differ. |
| C33 | JLC's minimum trace/space values are not impedance-tolerance guarantees. | JLC copper guide [S5] compared with impedance help [S3]. | High logical distinction. Values are vendor-specific. |
| C34 | Copper fill can improve manufacturing balance but can alter controlled-line fields. | JLC copper-coverage guidance [S6] plus transmission-line dependence on nearby capacitance [S3][S4]. | High for mechanism; keepaway must be solved, not guessed. |
| C35 | Rogers material properties can vary with thickness and temperature/exposure. | Rogers datasheet notes and coefficient [S13]. | High for listed material/revision; operational fitness remains application-specific. |
| C36 | Low Df reduces dielectric attenuation but is not equivalent to impedance control. | Intel substrate/loss guidance [S35]; transmission-line/loss models [S29]. | High. Total loss also includes conductor, roughness, radiation, and discontinuities. |
| C37 | The article's “more layers” conclusion is conditional on creating useful reference and routing structures. | Article [S1] reconciled with Intel layer/return guidance [S18]. | High engineering inference. Layer count alone is not a physical variable in `Z0`. |
| C38 | Fabricator-controlled artwork compensation must be contractually distinguished from designer pre-compensation. | JLC etch guidance [S26]; Polar same-aperture coupon practice [S21]. | High process inference; exact authority is job-specific. |
| C39 | Current JLC free-test ±20% language cannot be converted into an assumed ±10% production guarantee. | JLC multilayer help [S3]. | High. “Precision” is numerically unspecified on that page. |
| C40 | AI outputs must distinguish calculated, vendor-asserted, fabricator-confirmed, and measured evidence. | Synthesis of conflicts and method limits in [S1][S3][S7][S13]. | High governance recommendation; not a sourced industry standard. |

## 21. Source register

Accessed 2026-09-06 unless otherwise stated. DOI links identify original publications even when full text is paywalled.

- **[S1]** JLCPCB, “Comprehensive Layer Stack-Up Design for High-Speed Controlled Impedance PCBs,” published 2023-07-28, updated 2026-04-07. Anchor vendor article. https://jlcpcb.com/blog/layer-stackup-design-high-speed-pcbs
- **[S2]** JLCPCB, “User Guide to the JLCPCB Impedance Calculator,” updated 2026-06-15. Vendor-specific current calculator inputs, materials, copper/mask/profile assumptions, and ranges. https://jlcpcb.com/help/article/user-guide-to-the-jlcpcb-impedance-calculator
- **[S3]** JLCPCB, “Multi-Layer PCB Standard Laminated Structures,” updated 2025-04-24. Vendor-specific structures, pressed-thickness note, inferred Dk note, and current test-tolerance language. https://jlcpcb.com/help/article/multi-layer-pcb-standard-laminated-structures
- **[S4]** JLCPCB, “Controlled Impedance PCB Layer Stackup.” Vendor-specific stack examples and parameters. https://jlcpcb.com/impedance
- **[S5]** JLCPCB, “JLCPCB Copper Weight (Thickness) Guide,” updated 2025-12-15. Vendor-specific copper and feature capabilities. https://jlcpcb.com/help/article/jlcpcb-copper-weight
- **[S6]** JLCPCB, “Inner Layer Copper Coverage & PCB Thickness Control,” 2026. Vendor-specific copper-balance guidance. https://jlcpcb.com/help/article/inner-layer-copper-coverage-pcb
- **[S7]** IPC, *IPC-TM-650 2.5.5.7A, Characteristic Impedance of Lines on Printed Boards by TDR*, revision A, 2004-03. Primary industry test method and equations; IPC notes it is advisory. https://www.ipc.org/sites/default/files/test_methods_docs/2-5-5-7a.pdf
- **[S8]** IPC, *IPC-2141A, Design Guide for High-Speed Controlled Impedance Circuit Boards*, 2004; official scope/contents and design-standards listing. https://www.ipc.org/TOC/IPC-2141A.pdf
- **[S9]** E. Hammerstad and O. Jensen, “Accurate Models for Microstrip Computer-Aided Design,” IEEE MTT-S International Microwave Symposium, 1980, pp. 407–409. Original model. https://doi.org/10.1109/MWSYM.1980.1124303
- **[S10]** Qucs Project, “Single microstrip line,” Technical Guide, equations and implementation notes for Wheeler and Hammerstad–Jensen models. https://qucs.sourceforge.net/tech/node75.html
- **[S11]** H. A. Wheeler, “Transmission-Line Properties of Parallel Wide Strips by a Conformal-Mapping Approximation,” *IEEE Transactions on Microwave Theory and Techniques*, vol. 12, no. 3, 1964, pp. 280–289. https://doi.org/10.1109/TMTT.1964.1125810
- **[S12]** C. P. Wen, “Coplanar Waveguide: A Surface Strip Transmission Line Suitable for Nonreciprocal Gyromagnetic Device Applications,” *IEEE Transactions on Microwave Theory and Techniques*, vol. 17, no. 12, 1969, pp. 1087–1090. https://doi.org/10.1109/TMTT.1969.1127105
- **[S13]** Rogers Corporation, *RO4000 Series High Frequency Circuit Materials Data Sheet: RO4003C and RO4350B*, 2022-era revision surfaced by the current product site. First-party process/design Dk, Df, temperature coefficient, and notes. https://www.rogerscorp.com/-/media/project/rogerscorp/documents/advanced-electronics-solutions/english/data-sheets/ro4000-laminates-ro4003c-and-ro4350b---data-sheet.pdf
- **[S14]** Isola Group, “I-Speed Laminate and Prepreg,” current product/construction data. First-party glass style, resin content, thickness, Dk/Df tables. https://www.isola-group.com/pcb-laminates-prepreg/i-speed-laminate-and-prepreg/
- **[S15]** Jyoti Sharma, Marty Choate, and Steve Peters, “Laminate Materials with Low Dielectric Properties,” presented at IPC Printed Circuits Expo 2002. Primary industry research on construction-dependent Dk/Df and glass-to-resin ratio. https://www.ipc.org/system/files/technical_resource/E24%2600032.pdf
- **[S16]** Intel, *PCB Stack-up Overview for Intel Architecture Platforms*, white paper 321077, 2008. First-party system guidance and fiber-weave analysis. https://www.thailand.intel.com/content/dam/www/public/us/en/documents/white-papers/ia-pcb-stack-up-overview.pdf
- **[S17]** Intel, “Fiberglass Weave Composition,” Intel FPGA PCB design guidance, current page. First-party mitigation guidance. https://www.intel.com/content/www/us/en/docs/programmable/683883/current/fiberglass-weave-composition.html
- **[S18]** Intel, *AN 508: Cyclone III Simultaneous Switching Noise Design Guidelines*, return-path and power/ground pairing sections. First-party component/system guidance. https://cdrdv2-public.intel.com/654794/an508.pdf
- **[S19]** P. G. Huray et al., “Fundamentals of a 3-D ‘Snowball’ Model for Surface Roughness Power Losses,” IEEE Workshop on Signal Propagation on Interconnects, 2007. Original roughness model. https://doi.org/10.1109/SPI.2007.4512227
- **[S20]** Keysight Technologies, *High Precision Time Domain Reflectometry*, application note 5988-9826. First-party instrument guidance on TDR and uncertainty. https://www.keysight.com/zz/en/assets/7018-01179/application-notes-archived/5988-9826.pdf
- **[S21]** Polar Instruments, “Testing Controlled Impedance Boards with Test Coupons,” AP124. First-party test-system guidance on same-panel coupon representation and locations. https://www.polarinstruments.com/support/cits/AP124.html
- **[S22]** Polar Instruments, “Controlled Impedance — Design for Test,” AP132. First-party coupon length and probe/test-design guidance. https://www.polarinstruments.com/support/cits/AP132.html
- **[S23]** Analog Devices, *MT-097: Dealing with High Speed Logic*, rev. 0, 2009. First-party design tutorial on edge time, propagation delay, and termination screening. https://www.analog.com/media/en/training-seminars/tutorials/mt-097.pdf
- **[S24]** M. Xu, Y. Ji, T. H. Hubing, T. P. Van Doren, and J. L. Drewniak, “Development of a Closed-Form Expression for the Input Impedance of Power-Ground Plane Structures,” *Proceedings of the 2000 IEEE International Symposium on Electromagnetic Compatibility*, vol. 1, pp. 77–82. Primary cavity-model research. https://doi.org/10.1109/ISEMC.2000.875541
- **[S25]** Intel, “Other Considerations,” *Agilex 5 FPGAs and SoCs PCB Design Guidelines*, current 2025 edition. First-party, device-specific return-via and layout guidance. https://www.intel.com/content/www/us/en/docs/programmable/821801/current/other-considerations.html
- **[S26]** JLCPCB, “Etch Factor Control for Precise PCB Trace Width,” 2026. Vendor explanation of etch factor, compensation, and coupon offering. https://jlcpcb.com/blog/how-etch-factor-controls-pcb-trace-width
- **[S27]** IPC, *IPC-2228, Sectional Design Standard for High Frequency Printed Boards*, official table of contents, 2024-era release. Identifies controlled impedance, balanced conductors, surface roughness, and bow/twist as design topics. https://www.ipc.org/TOC/IPC-2228_TOC.pdf
- **[S28]** Würth Elektronik, example BASIC6 multilayer stack-up drawing. First-party fabricator example distinguishing core/prepreg, Dk/Df, starting/finished copper, mask, and board-thickness tolerance. https://www.we-online.com/files/pdf1/basic6_ml6_230_17_v2.12.pdf
- **[S29]** scikit-rf project, `MLine` source and documentation, current open-source implementation of Hammerstad–Jensen, dispersion, conductor/dielectric loss, and roughness correction. https://github.com/scikit-rf/scikit-rf/blob/master/skrf/media/mline.py
- **[S30]** Sonnet Software, “Modeling Co-planar Waveguide (CPW) in Sonnet.” First-party EM-solver guidance that distinct CPW structures require distinct models. https://www.sonnetsoftware.com/support/help-18/Sonnet_Suites/ModelingCoplanarWaveguideCPWinSo.html
- **[S31]** Polar Instruments, “Testing Controlled Impedance Boards — Test Coupons or Test Traces?” AP8502. First-party measurement guidance on coupons versus complex product traces. https://www.polarinstruments.com/support/cits/AP8502.html
- **[S32]** Qucs Project, “Parallel Coupled Microstrip Lines,” Technical Guide; coupled-line model and finite-thickness discussion. https://qucs.sourceforge.net/tech/node77.html
- **[S33]** IPC, *IPC-2221B, Generic Standard on Printed Board Design*, official table of contents, including bow/twist. https://www.ipc.org/TOC/IPC-2221B.pdf
- **[S34]** Tektronix, “TDR Test,” primer. First-party instrument explanation of multiple reflections and impedance readout limits. https://www.tek.com/en/documents/primer/tdr-test
- **[S35]** Intel (Altera), *AN 224: High-Speed Board Layout Guidelines*, substrate Dk/Df, transmission line, grounding, and layer-stack sections. https://cdrdv2-public.intel.com/654465/an224.pdf
- **[S36]** IPC, “IPC-TM-650 Test Methods Manual,” current official method register. Lists distinct permittivity/loss methods including clamped stripline, split-cylinder, and split-post resonators. https://www.ipc.org/test-methods

## 22. Research limitations, contradictions, and stop rationale

- The paid body of IPC-2141A/IPC-2228 was not treated as freely reproducible. This guide cites official scopes/tables of contents and the freely published IPC-TM-650 TDR method, then uses original IEEE models and first-party implementation documentation for equations.
- JLCPCB's capability pages are dynamic and internally inconsistent on tolerance. The conflict is intentionally unresolved here; only a live quote and written job confirmation can resolve it for a specific order.
- No JLCPCB process-distribution data were available for dielectric height, trace top/base width, plating, or Dk. Therefore no statistically valid Monte Carlo yield claim is made.
- The worked examples were independently calculated from the stated equations. They deliberately exclude coating, trapezoid, dispersion, roughness, and process distributions and are labeled preliminary.
- This research stopped after the requested topic families had primary or first-party support, the anchor article's consequential claims were audited, the vendor conflict was bounded, equations and worked examples were independently checked, and further generic blog sources were unlikely to change a design decision.

[S1]: https://jlcpcb.com/blog/layer-stackup-design-high-speed-pcbs
[S2]: https://jlcpcb.com/help/article/user-guide-to-the-jlcpcb-impedance-calculator
[S3]: https://jlcpcb.com/help/article/multi-layer-pcb-standard-laminated-structures
[S4]: https://jlcpcb.com/impedance
[S5]: https://jlcpcb.com/help/article/jlcpcb-copper-weight
[S6]: https://jlcpcb.com/help/article/inner-layer-copper-coverage-pcb
[S7]: https://www.ipc.org/sites/default/files/test_methods_docs/2-5-5-7a.pdf
[S8]: https://www.ipc.org/TOC/IPC-2141A.pdf
[S9]: https://doi.org/10.1109/MWSYM.1980.1124303
[S10]: https://qucs.sourceforge.net/tech/node75.html
[S11]: https://doi.org/10.1109/TMTT.1964.1125810
[S12]: https://doi.org/10.1109/TMTT.1969.1127105
[S13]: https://www.rogerscorp.com/-/media/project/rogerscorp/documents/advanced-electronics-solutions/english/data-sheets/ro4000-laminates-ro4003c-and-ro4350b---data-sheet.pdf
[S14]: https://www.isola-group.com/pcb-laminates-prepreg/i-speed-laminate-and-prepreg/
[S15]: https://www.ipc.org/system/files/technical_resource/E24%2600032.pdf
[S16]: https://www.thailand.intel.com/content/dam/www/public/us/en/documents/white-papers/ia-pcb-stack-up-overview.pdf
[S17]: https://www.intel.com/content/www/us/en/docs/programmable/683883/current/fiberglass-weave-composition.html
[S18]: https://cdrdv2-public.intel.com/654794/an508.pdf
[S19]: https://doi.org/10.1109/SPI.2007.4512227
[S20]: https://www.keysight.com/zz/en/assets/7018-01179/application-notes-archived/5988-9826.pdf
[S21]: https://www.polarinstruments.com/support/cits/AP124.html
[S22]: https://www.polarinstruments.com/support/cits/AP132.html
[S23]: https://www.analog.com/media/en/training-seminars/tutorials/mt-097.pdf
[S24]: https://doi.org/10.1109/ISEMC.2000.875541
[S25]: https://www.intel.com/content/www/us/en/docs/programmable/821801/current/other-considerations.html
[S26]: https://jlcpcb.com/blog/how-etch-factor-controls-pcb-trace-width
[S27]: https://www.ipc.org/TOC/IPC-2228_TOC.pdf
[S28]: https://www.we-online.com/files/pdf1/basic6_ml6_230_17_v2.12.pdf
[S29]: https://github.com/scikit-rf/scikit-rf/blob/master/skrf/media/mline.py
[S30]: https://www.sonnetsoftware.com/support/help-18/Sonnet_Suites/ModelingCoplanarWaveguideCPWinSo.html
[S31]: https://www.polarinstruments.com/support/cits/AP8502.html
[S32]: https://qucs.sourceforge.net/tech/node77.html
[S33]: https://www.ipc.org/TOC/IPC-2221B.pdf
[S34]: https://www.tek.com/en/documents/primer/tdr-test
[S35]: https://cdrdv2-public.intel.com/654465/an224.pdf
[S36]: https://www.ipc.org/test-methods

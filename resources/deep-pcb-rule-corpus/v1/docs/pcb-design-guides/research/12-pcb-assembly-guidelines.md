# PCB Assembly Guidelines: Evidence Dossier

**Research date:** 2026-09-06  
**Audience:** PCB designers preparing a design for contract SMT assembly, prototype
builds, or a controlled in-house build.  
**Scope:** assembly-oriented PCB design: footprints through release data, including
SMT, through-hole, rework, inspection, and production exceptions. This is not a
substitute for the component manufacturer's package drawing, the assembler's current
capability sheet, or a contractual IPC acceptance class.

## Executive conclusion

Assembly success is mostly decided before the PCB is quoted: the *exact component
package drawing* defines the land pattern, the intended soldering process defines the
paste/mask/stencil and thermal-pad details, and the selected assembler defines
clearances, panel handling, and deliverable format. A generic footprint that merely
“looks right” is not a production rule.

For an ordinary reflow-built board, use the manufacturer's recommended footprint and
reflow profile as the first authority; use the current IPC land-pattern family as the
generic fallback; explicitly design paste apertures; make polarity and Pin 1 visible;
provide unambiguous BOM and placement data; and leave physical access for placement,
inspection, test, and rework. For QFN/DFN/BGA or high-power exposed-pad parts, add
package-specific paste, via, X-ray, and thermal validation rather than relying on
visible solder fillets.

The supplied article URL, [JLCPCB, “PCB Assembly Guidelines”](https://jlcpcb.com/blog/pcb-assembly-guidelines), returned JLCPCB's 404 page when checked on the
research date. It is therefore listed as **unavailable**, not used as evidence for a
technical claim. Current JLCPCB Help Center articles are used only for JLC-specific
process rules; they must not be generalized to every assembler.

## Evidence status and precedence

Use this order when a rule conflicts:

1. **Exact part/package documentation and errata.** Its pad geometry, exposed-pad
   connection, MSL, peak-temperature limit, and soldering profile control that part.
2. **The agreed assembler capability and DFM response.** It controls what that factory
   will accept, panelize, stencil, place, inspect, and rework for the order.
3. **Contractual standard and product acceptance plan.** IPC-7351/7352 address land
   patterns; IPC lists IPC-7093 and IPC-7095 for bottom-termination and BGA process
   implementation respectively [IPC design standards](https://www.ipc.org/ipc-design-standards). A paid standard or customer workmanship specification may impose
   acceptance criteria not visible in public material.
4. **Application notes and generic guidance.** These are useful engineering defaults,
   but their dimensions and void targets can be package-, stencil-, alloy-, and
   application-specific.

Do not silently replace a package drawing with a library name, an LCSC/JLC part number,
or a distributor “equivalent.” A part can share an electrical value and still differ in
termination dimensions, exposed-pad layout, height, MSL, polarity mark, reel
orientation, or reflow limit.

## 1. Land patterns, courtyards, and component identity

### 1.1 Land patterns

**Rule.** Start each footprint from the exact manufacturer package drawing and its
recommended PCB land pattern. Preserve the source document and revision in the library
record. Generic IPC construction is a fallback where the manufacturer gives no
recommendation or where a controlled corporate library derives the pattern.

IPC's current public catalogue identifies IPC-7351 as *Generic Requirements for Surface
Mount Design and Land Patterns*, and the 2023 IPC-7352 table of contents explicitly
covers component/land tolerancing, solder-joint analysis, courtyard determination,
thermal relief, thermal-tab paste mask, and validation [IPC-7352 contents](https://www.ipc.org/TOC/IPC-7352-TOC.pdf). That establishes scope; it does **not** publish a
universal pad size for every package in the free contents file.

For a QFN/SON example, TI states that its peripheral stencil aperture is normally 1:1
with the PCB pad, while the exposed center pad is treated differently; at 0.5 mm pitch
and below it may need aperture reduction to prevent shorts [TI, *QFN and SON PCB
Attachment*, rev. Dec. 2023](https://www.ti.com/lit/an/slua271c/slua271c.pdf). That is a
good illustration of why “same paste rule for all pads” is unsafe.

Library review should confirm all of the following:

- package code and drawing revision, pitch, lead/ball/termination dimensions and
  tolerances;
- copper land dimensions, shape, solder-mask definition, paste aperture and exposed-pad
  segmentation as separate objects;
- pin numbering and a visible Pin-1/polarity indicator that agrees with the schematic;
- body outline, maximum height, rotation-zero convention, courtyard, keepouts, and the
  intended assembly side; and
- a link to the datasheet/package drawing plus a verification state such as
  `manufacturer-verified`, `IPC-derived`, or `needs-build-validation`.

**Common failed shortcut:** swapping a vendor-recommended NSMD/SMD treatment or a
thermal pad for an EDA-library default. Mask-defined versus non-mask-defined pads are
not cosmetic choices: they change copper/mask registration assumptions and joint
geometry. Use the package recommendation or the project land-pattern policy, then
obtain assembler approval for a process deviation.

### 1.2 Courtyard and courtyard overlap

A courtyard is the placement/assembly envelope, not the copper footprint. IPC-7352 has
a specific courtyard-determination section, and IPC's library-management guidance lists
“courtyard/placement boundaries,” component height, orientation/Pin-1 indication and
assembly outline as library information that must be defined for fabrication,
assembly, and inspection needs [IPC, *Library Management for an Ever-Evolving Diverse
EDA Tool Industry*](https://www.ipc.org/system/files/technical_resource/E41%26S25_03%20-%20Michelle%20Gleason.pdf).

**Default decision:** flag all courtyard overlap, then deliberately disposition each
flag. A zero-overlap checker is a useful release gate, but it is not an absolute physical
law. The correct clearance varies with package height, placement tolerance, stencil
printing, board flex, nozzle access, AOI line of sight, hot-air rework, depanelization,
and whether a component is hand-installed later. A tall connector's body/plug envelope
and a heat sink's keepout are normally larger than the component's copper lands.

**Approved exceptions must be explicit.** Examples include a manufacturer-approved
component pair, a low-profile capacitor placed under a shield with measured height
clearance, or an intentional board-to-board mechanical overlap. Record the owning
mechanical drawing, minimum Z clearance, assembly sequence, and rework consequence. Do
not waive a courtyard collision merely because the 2D silkscreen does not overlap.

### 1.3 Orientation, polarity, and rotations

All polarized or direction-sensitive parts need two independent controls:

1. a human-readable board marking (Pin 1 dot/notch, diode cathode bar, capacitor `+`,
   LED cathode, connector/key orientation); and
2. validated placement-data rotation and side.

These controls catch different failures. A correct silkscreen cannot rescue an inverted
CPL rotation; a correct machine placement file does not make field/debug/rework polarity
obvious. Keep the mark outside solderable copper and inspectable after assembly. Avoid
ambiguous use of a circular dot where the package itself uses multiple dots.

Do not assume an EDA rotation of 0 degrees means a PnP machine's 0 degrees. The JLC
CPL convention requires the component's X/Y center, rotation, and layer, and its example
expects the designator to match the BOM [JLCPCB, *Files Needed for PCB Assembly*](https://jlcpcb.com/blog/files-needed-for-pcb-assembly). Validate a representative part from
each footprint/orientation family in the assembler's rendered placement preview and on
the first article. This is especially important for bottom-side parts, diode/LED
orientation, connectors, BGAs, and libraries imported from another CAD tool.

## 2. Solder mask, paste, stencil, and thermal pads

### 2.1 Keep copper, mask, and paste distinct

Copper defines the electrical land. Solder mask exposes or constrains it. Paste defines
where the stencil deposits solder paste. Treat each as an intentional fabrication output;
do not derive paste by habit from copper or mask. Check both sides in the Gerber/ODB++
viewer and confirm no component is accidentally mask-only or paste-only.

JLCPCB specifically says a paste layer is highly recommended for stencil production, and
warns that a solder-mask/paste difference can trigger an engineering question unless the
order directs it to follow paste only [JLCPCB, *Instructions for Stencil Order*](https://jlcpcb.com/help/article/instructions-for-stencil-order). This is a **JLC order-flow
rule**, but the underlying practice applies generally: the release needs an explicit
stencil intent.

For a new design, review at minimum:

- paste apertures at fine-pitch leads, BTC periphery, thermal pads, large pads, and
  connector anchors;
- mask dams/slivers and whether a pad is SMD or NSMD;
- paste bridges across pins, vias, test pads, and solder thieves;
- aperture-to-pad registration tolerance and stencil alignment fiducials; and
- the smallest aperture's printability, not just the largest pad's paste volume.

TI's QFN/SON note describes why these variables interact: thickness and aperture geometry
set deposited volume, uniform release and alignment matter to repeatable reflow, and
typical production stencil thickness is 0.100–0.150 mm with 0.125 mm presented as a
guide for 0.5-mm-pitch QFN/SON [TI QFN/SON attachment](https://www.ti.com/lit/an/slua271c/slua271c.pdf).
Those numbers are a package-family example, **not** a board-wide prescription.

### 2.2 Stencil release and mixed technology

Small apertures may not release paste consistently even when the CAD geometry is legal.
The TI note cites IPC-7525's common screening thresholds of aspect ratio greater than
1.5 and area ratio at least 0.66; it notes that nickel-formed stencils can be considered
for very challenging apertures [TI QFN/SON attachment](https://www.ti.com/lit/an/slua271c/slua271c.pdf).
Ask the stencil supplier to review the actual aperture, foil thickness, paste type, and
manufacturing method rather than treating those values as guaranteed yield limits.

One thickness rarely optimizes both a tiny fine-pitch device and a large high-current
connector or shield pad. Possible controlled solutions are stepped stencils, selected
aperture reductions/enlargements, selective printing, or a split assembly process. The
choice must be validated by paste-inspection and reflow results, because reducing paste
to cure bridging can create insufficient joints elsewhere.

### 2.3 Exposed thermal pads and via-in-pad

The exposed pad on QFN/DFN/SON and power packages is often electrical *and* thermal. Its
net connection, copper area, plane connection, via strategy, paste segmentation, solder
coverage target, and inspection method belong in the footprint/release notes.

**Do not use a solid 1:1 exposed-pad aperture by default.** TI states that an aperture
printing 1:1 with the center pad can put in excessive solder, float the package, and
produce opens; its QFN/SON example uses roughly 50–70% paste coverage and calls for
voiding control appropriate to the power application [TI QFN/SON attachment](https://www.ti.com/lit/an/slua271c/slua271c.pdf). Its PowerPAD guidance also advises against
cross-hatching a thermal-pad opening because it reduces paste and can increase voiding
[TI, *PowerPAD Layout Guidelines*](https://www.ti.com/lit/an/sloa120/sloa120.pdf).
These are TI package/process examples. Follow the exact part's documentation if it
differs.

Vias in the exposed pad can conduct heat to inner/bottom copper but can also wick solder
away, create bottom-side solder protrusions, and change voiding. TI's QFN guidance says
vias may be plugged to prevent solder loss/protrusions; for thin boards or larger vias,
external vias may avoid those defects at a thermal-performance cost. It gives 0.3 mm as
the relevant diameter limit in that application note [TI, *QFN Layout Guidelines*](https://www.ti.com/lit/an/sloa122/sloa122.pdf). This is not a fabrication capability number.

Select the via treatment deliberately:

- **filled and capped (VIPPO):** most controlled flat surface for true via-in-pad, but
  has cost and supplier-process implications;
- **plugged/tented:** may prevent paste drainage when compatible with the stackup and
  solder-mask process; inspect the supplier's definition and allowable geometry;
- **open/untented:** normally unsuitable in a paste-covered thermal pad because solder
  can wick down it; and
- **external via array:** avoids via-in-pad wicking but consumes copper area and may
  weaken thermal performance.

JLCPCB's current via-covering page distinguishes tented, plugged, epoxy/copper-filled and
capped options and explicitly calls out a risk of flowing tin into untented vias during
assembly [JLCPCB, *Via Covering*](https://jlcpcb.com/help/article/pcb-via-covering). That
is useful process vocabulary, not a substitute for package-specific thermal simulation
and X-ray validation.

## 3. Reflow defects: tombstones, skew, bridges, voids, and opens

### 3.1 Tombstoning and skew

Tombstoning is a chip part lifting at one end as unequal wetting forces act during
reflow; skew is lateral/rotational movement. They are not fixed solely by changing the
profile. The layout can create the imbalance through unequal pad size, copper/plane heat
sinking, paste volume, mask definition, or asymmetric component placement.

Coilcraft's assembly application note states the practical root rule: to avoid
tombstoning or movement, make solder quantity, component positioning, and heating even
at all joints [Coilcraft, *Soldering and Rework Recommendations*](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/196/3010.MSS7348_2D00_153MEC_5F00_APP-REV01.pdf).
Apply that to a layout review:

- make paired chip lands geometrically and thermally symmetric where possible;
- do not connect only one chip pad directly to a large copper pour/plane while the other
  is isolated; use a balanced connection strategy compatible with current/thermal needs;
- keep paste apertures and mask openings balanced at the two ends;
- verify component centroid and rotation; and
- if an asymmetry is inherent (for example, power-path copper), prototype and tune it
  with the actual paste/profile rather than guessing.

### 3.2 Bridges, insufficient solder, and opens

Bridges arise from excessive/merged paste, mask or pad geometry, placement offset,
stencil registration, reflow behavior, or contamination. Insufficient solder/opens can
come from poor aperture release, via wicking, inadequate wetting, component lift, or too
little paste after an aggressive anti-bridge reduction. Correct the causal combination,
not only the visibly failed pad.

Use solder-paste inspection (SPI) before placement where the process supports it, and
inspect the print before committing a new high-risk board. TI calls a repeatable solder
deposit the most important factor for robust downstream reflow yield [TI QFN/SON
attachment](https://www.ti.com/lit/an/slua271c/slua271c.pdf). That does not mean SPI
alone proves good solder joints; it distinguishes printing problems from placement/reflow
problems.

### 3.3 Voiding

Some voiding is normal; acceptable void area depends on the package, thermal/electrical
role, reliability class, and agreed acceptance criterion. Do not copy a void percentage
from a power QFN into an RF, BGA, or ordinary chip-capacitor requirement.

For example, TI's 2023 QFN/SON note says center-pad voiding should be minimized, gives a
50% upper limit for high-power applications in that context, and says to verify it by
X-ray; it also notes diminishing thermal returns around 25% on a referenced JEDEC High-K
board [TI QFN/SON attachment](https://www.ti.com/lit/an/slua271c/slua271c.pdf). Treat
this as a design-validation starting point. The production drawing should say which pads
need X-ray, what measurement/denominator applies, sampling, and accept/rework action.

## 4. Spacing, edge access, panel handling, fiducials, and tooling

### 4.1 Component spacing and access

Electrical clearance, copper-to-edge clearance, component-body spacing, nozzle access,
AOI visibility, and hot-air/rework access are separate constraints. A design that clears
the electrical DRC can still be impossible to assemble or repair economically.

JLCPCB publishes a current package-pair spacing table explicitly for reliable SMT
assembly, inspection, and rework. It recommends, for example, 0.15 mm between two 0201
or 0402 chips, 1.0 mm between QFNs, 1.25 mm between QFPs, and 2.0 mm between BGAs
[JLCPCB, *Minimum Spacing Requirements for SMD Components*](https://jlcpcb.com/help/article/minimum-spacing-for-smd-components). These are **JLC recommendations**, not
universal IPC limits. The table itself should be rechecked at quote time and superseded
by an approved assembler DFM response.

Reserve more than the nominal table minimum where a part needs probing, hand access,
selective soldering, a connector mating envelope, heat-sink hardware, conformal-coating
clearance, or expected rework. Put large/tall parts, test points, programming headers,
and mechanically stressed connectors where fixtures can reach them without shadowing
other parts.

### 4.2 Fiducials

Global fiducials locate the board/panel; local fiducials help placement of high-accuracy
areas when the assembler requests them. They must be unambiguous, bare copper with the
correct mask clearance, and not look like ordinary pads or test points.

For JLC standard assembly, edge rails and fiducials are described as required. Its
published implementation asks for 1 mm exposed-copper fiducials, a mask opening twice
that diameter, three to four marks along edges, and at least 3.35 mm from the board edge
including the keepout [JLCPCB, *Edge Rails and Fiducials*](https://jlcpcb.com/help/article/how-to-add-edge-rails-fiducials-for-pcb-assembly-order). These exact dimensions
and the “required” statement are **JLC-specific**. The general rule is to ask the chosen
assembler whether it wants global/local fiducials, panel fiducials, and stencil
fiducials, then include them in the correct layers.

JLC's stencil guidance likewise says fiducials support paste-print/placement alignment
and that need varies by automatic, semi-automatic, and manual printing
[JLCPCB, *How to Include Fiducial Marks on an SMT Stencil*](https://jlcpcb.com/help/article/how-to-include-fiducial-marks-on-an-smt-stencil).

### 4.3 Rails, tabs, breakaways, and tooling holes

Panel rails provide handling area for conveyors, stencil printing, and placement; they
also move components away from a fragile board edge. JLC's current page calls for edge
rails at least 5 mm wide and says boards are normally delivered with rails attached
unless removal is requested, potentially with a post-processing fee [JLCPCB, *Edge
Rails and Fiducials*](https://jlcpcb.com/help/article/how-to-add-edge-rails-fiducials-for-pcb-assembly-order).

That does not make 5 mm a universal rule. Panel construction must additionally account
for board stiffness, component overhang, the depanelization method (tab-route,
V-score, saw), breakaway stress, copper/trace distance from break lines, and whether
nearby MLCCs, BGAs, connectors, or tall parts can crack or snag during separation.
Provide the panel drawing or instruct the assembler who owns panelization; do not leave
an ambiguous mix of designer panelization and “panelize as needed.”

JLC's tooling-hole advice for its Economic PCBA route specifies two or three widely
separated 1.152-mm round NPTHs with 0.148-mm solder-mask expansion and notes it may add
holes by default [JLCPCB, *Tooling Holes*](https://jlcpcb.com/help/article/how-to-add-tooling-holes-for-pcb-assembly-order). Again, this is a supplier-specific datum.
Tooling holes are not general-purpose mounting holes: keep them clear of copper,
mechanical features, and the usable product outline unless their final function is
defined.

## 5. Assembly data: BOM, CPL, substitutions, and release discipline

### 5.1 Minimum machine-readable data

The data package must be internally consistent across schematic, layout, BOM, CPL,
Gerbers/ODB++, drawings, and assembler portal selections. Before release, compare the
sets of reference designators: placed, DNP, hand-install, and test-only items must each
have a deliberate status.

For JLC, the current BOM guide requires at least **Comment**, **Designator**, and
**Footprint**, and explains that description/specification, reference designator, package
and manufacturer part number are relevant details [JLCPCB, *BOM File for PCB Assembly*](https://jlcpcb.com/help/article/bill-of-materials-for-pcb-assembly). Its newer KiCad guide
also shows **JLCPCB/LCSC part number** as a required practical matching field and defines
CPL fields as Designator, Mid X, Mid Y, Rotation, and Layer in millimeters
[JLCPCB, *KiCad BOM and Pick-and-Place Export*](https://jlcpcb.com/help/article/how-to-generate-the-bom-and-centroid-file-from-kicad).

For a robust assembler-neutral BOM, include at least:

| Field | Why it matters |
|---|---|
| Reference designator(s), quantity, fitted/DNP state | Reconciles schematic, placement, and inspection scope. |
| Internal part number and manufacturer part number | Prevents value-only or package-only substitutions. |
| Manufacturer and approved alternates | Makes supply approval auditable. |
| Value, tolerance, voltage/current, dielectric/material, temperature or other critical attributes | Separates electrically different “10 uF” or “10 k” parts. |
| Exact package/footprint and height where needed | Detects geometry/reflow/keepout incompatibility. |
| Assembly method/side and special handling | Flags hand install, moisture, orientation, adhesive, or special profile needs. |
| Supplier part number (for the selected assembler) | Enables supplier matching, but never replaces MPN verification. |

The CPL/PnP file should have one row for every machine-placed fitted component, with
designator, board-relative X/Y, rotation, side/layer, units, origin convention, and
rotation convention. Include a readme/drawing that identifies the origin and the top-view
reference direction. JLC cautions that only designators common to BOM and CPL are
recognized, and asks users to use its standard headers [JLCPCB, *BOM/CPL Preparation
Recommendations*](https://jlcpcb.com/help/article/advice-for-bom-and-cpl-files-preparation).

### 5.2 Package substitutions and supply changes

There are two separate questions:

- **Can the factory procure/place the proposed alternate?** Stock and an exact supplier
  number answer this only.
- **Is the alternate qualified for this design?** This requires engineering review of
  function, ratings, package/land fit, standoff/height, polarity/Pin 1, MSL, finish,
  reflow, thermal behavior, safety approvals, and any timing/RF/EMI effect.

Never approve an alternate merely because an automated matcher found a similar value.
JLC says it assembles only parts selected in the customer's PCBA component-matching list
and warns matching can fail from stock or incomplete/nonstandard BOM data
[JLCPCB, *Component Matching Guidelines*](https://jlcpcb.com/help/article/component-matching-guidelines-for-pcba-orders). This is a useful operational boundary: a factory
selection is not an implicit engineering change order.

Require a written approved-vendor-list/alternate policy. For any alternate, attach the
old/new datasheets and a delta review. Disallow silent substitutions for safety parts,
crystals/oscillators, precision analog components, RF parts, high-voltage parts,
connectors, thermal-interface components, and packages whose footprint/reflow behavior
changes.

## 6. Process constraints: reflow, wave, selective, through-hole, and manual work

### 6.1 Reflow SMT

Reflow is appropriate only when all fitted parts, board materials, paste/flux, finish,
and profile are compatible. Use the paste supplier's recommended profile, constrained by
the most temperature-sensitive fitted part and its MSL condition; TI expressly recommends
using the paste manufacturer's profile within the MSL guideline of the most thermally
sensitive component [TI QFN/SON attachment](https://www.ti.com/lit/an/slua271c/slua271c.pdf).

Mixed masses, large copper planes, metal-core boards, heavy connectors, and thick boards
can create local temperature differences. Instrument a representative loaded board with
thermocouples; a generic oven profile is not evidence that every joint met time-above-
liquidus and peak limits.

### 6.2 Wave and selective solder

Wave and selective soldering add direction, shadowing, underside clearance, solder-thief,
and component-side constraints. Do not assume a reflow-rated SMD package is wave-safe or
that an underside thermal pad will form a usable joint in a wave. ST's PowerFLAT
application note says wave soldering is not advisable for those SMD power packages because
the package slug cannot be contacted across its full area [ST, *PowerFLAT PCB Assembly
Recommendations*](https://www.st.com/resource/en/application_note/an5046-printed-circuit-board-assembly-recommendations-for-stmicroelectronics-powerflat-packages-stmicroelectronics.pdf).

For through-hole or mixed technology, define which pins are wave, selective, intrusive
reflow, hand-soldered, press-fit, or left for final assembly. Give the assembler a
component-side drawing and keepout/sequence notes. Check connector plastics, switches,
electrolytics, batteries, sensors, and other parts for the intended method, not merely
for a generic “solderable” rating.

### 6.3 Manual solder and rework

Manual soldering is a controlled process, not a universal fallback. Some packages cannot
be adequately inspected or reworked with an iron alone; heat can damage nearby components
or exceed MSL/rework limits. Coilcraft recommends hot-air reflow as a more controlled
method than a soldering iron for rework [Coilcraft soldering/rework recommendations](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/196/3010.MSS7348_2D00_153MEC_5F00_APP-REV01.pdf).

Design for the expected rework equipment: leave nozzle and tweezer access, protect
plastic connectors/sensors, avoid trapping flux under low-standoff parts, and provide a
post-rework inspection/test step. Define whether a package has a maximum number of heat
cycles and whether a removed BGA/QFN/thermal-interface part may be reused. The answer is
usually component- and quality-plan-specific.

## 7. Inspection, test, repair, moisture, ESD, and cleanliness

### 7.1 Inspection is layered, not a single pass

Visual/AOI can catch presence, polarity, skew, tombstones, bridges, and many visible
fillet defects. It cannot prove a hidden BGA/QFN/LGA joint. X-ray can reveal hidden
alignment, solder distribution, bridging, and voids, but it cannot prove functional
behavior. Electrical tests need accessible nodes and a product-level specification.

JLC describes 2D/3D AOI for visible placement/soldering defects and X-ray for hidden
joint integrity/voiding; it separately describes flying probe and customer-specified FCT
as electrical/functional verification [JLCPCB, *SMT Inspection and Testing
Capabilities*](https://jlcpcb.com/help/article/smt-inspection-and-testing-capabilities).
Those are current supplier claims/capabilities, not a promise that every option is
included in every quotation. Confirm the purchased service and inspection report format.

Plan inspection before layout release:

- put accessible test pads on power rails, reset/program/debug, key buses and important
  analog nodes; specify test-pad diameter, probe side, keepout, and fixture clearance;
- mark critical hidden-joint parts for X-ray and state the agreed void/coverage criterion;
- use SPI/AOI for early process feedback, and record what their programs check;
- include boundary scan, flying probe, ICT, or functional test as appropriate to volume
  and test coverage; and
- define acceptance, rework, retest, traceability, and disposition of a failed board.

### 7.2 Rework and first-article learning

Do not let a good-looking rework conceal an uncorrected footprint/process problem.
Log defect location, package, board side, lot, paste/stencil/profile, inspection image,
rework method, and electrical result. Group failures by mechanism: print, placement,
reflow, component, PCB fabrication, panelization, or test. Revise the footprint or
process control only after the causal evidence is clear.

NASA's historical SMT workmanship standard is useful as an example of explicit
accept/reject visual criteria: it calls for good wetting to chip and land and identifies
excessive chip tilt, inadequate fillet, negative wetting angle, and lack of solder flow
under ends as reject conditions [NASA-STD-8739.2 PDF](https://s3vi.ndc.nasa.gov/ssri-kb/static/resources/NASA-STD-8739-2.pdf).
However, NASA lists that standard as inactive, and JPL says its SMT course has been
superseded by IPC J-STD-001 [NASA standard status](https://standards.nasa.gov/node/281),
[JPL MTTC course note](https://mttc.jpl.nasa.gov/catalog/surface-mount-technology/).
Use the current contract standard, not an old public illustration, for acceptance.

### 7.3 Moisture sensitivity and storage

Plastic packages absorb moisture. Reflow can rapidly vaporize it, causing cracking,
delamination, or the “popcorn” effect. JPL's current supplier requirement directs
handling, packing, shipping, and use of moisture/reflow-sensitive plastic SMDs to
IPC/JEDEC J-STD-033 and requires MSL-above-1 parts to be dry packed with moisture-barrier
bag, desiccant, humidity indicator, identification, and caution label
[JPL QC115a](https://supplierportal.jpl.nasa.gov/qcprint.php?clause=QC115a).

For a release/build plan, capture each sensitive part's MSL, peak-temperature rating,
bag seal/date, floor-life start/stop, humidity-indicator condition, dry storage, and
bake rule from the current part/standard documentation. Do not invent a bake schedule:
time/temperature depend on package, thickness, carrier/reel state, and the governing
standard. A MSL label is a process-control input, not merely a warehouse label.

### 7.4 ESD and cleanliness

ESD control belongs to receiving, kitting, placement, rework, test, and packaging; a
PCB layout cannot compensate for uncontrolled handling. NASA's production workmanship
document likewise calls for ESD-sensitive parts/assemblies to be controlled to EOS/ESD
S20.20 [NASA JSC 27301F](https://standards.nasa.gov/sites/default/files/standards/JSC/F/0/JSC-27301F.pdf).
Verify the assembler's ESD process for sensitive devices, but define any stricter
customer requirements in the build package.

Cleanliness depends on flux chemistry, component standoff, operating environment,
coating, voltage, leakage sensitivity, and the selected workmanship standard. “No-clean”
does not mean “all residues are harmless in every use.” TI warns that aggressive fluxes
under low-standoff CSP/QFN parts are unsuitable unless residue can be adequately cleaned
[TI QFN/SON attachment](https://www.ti.com/lit/an/slua271c/slua271c.pdf). State whether
cleaning is prohibited, required, or validated; specify the solvent/wash process,
drying, ionic/residue test where relevant, and post-clean inspection. Avoid trapping
wash fluid under low-standoff packages or inside connectors.

## 8. Practical review examples

### Example A: 0402 decoupler beside a power plane

**Risk:** one pad ties directly into a large pour while the other uses a narrow trace;
the thermal imbalance and unequal paste/land geometry can promote tombstoning.

**Review:** verify the exact 0402 footprint and paste; balance pad-to-copper thermal paths
as current/impedance allow; preserve local decoupling placement; and run a first-article
reflow with AOI/SPI evidence. Do not add arbitrary copper relief if it compromises the
power/return path. This is the application of the unequal-wetting mechanism, not a claim
that every plane-connected 0402 will tombstone.

### Example B: QFN regulator with a ground thermal pad

**Risk:** a solid center-paste opening and unfilled via-in-pad may float the component,
wick paste, increase voiding, or produce bottom-side protrusions.

**Review:** use the regulator's exact footprint and thermal network; choose tiled center
paste per its documentation; select filled/capped, plugged/tented, or external vias with
the fabricator; order X-ray for the first build; correlate void/copper changes with
thermal measurements. TI's package guidance supports the need for this validation, but
does not qualify a different supplier's QFN automatically.

### Example C: Dense mixed assembly around a USB connector

**Risk:** electrical DRC passes but nearby components block nozzle, AOI, connector
hardware, fixture probes, and hot-air rework.

**Review:** use body courtyards and a 3D mating model, not copper pads alone; apply the
assembler's spacing table as a floor; reserve a rework/test corridor; document any
connector hand-solder/selective-solder step. If JLC is selected, compare the actual
pairings to its current spacing table rather than treating generic clearance as proof.

### Example D: BGA prototype with an alternate supply part

**Risk:** an alternate has the same ball count but different ball map, body size, MSL,
or height; AOI will not see the hidden joint.

**Review:** reject automatic substitution; compare full package drawing, pin map,
electrical datasheet, land pattern, MSL and reflow limits; require engineering approval;
use X-ray and functional test on first articles. Keep the original MPN and the approved
alternate separately traceable.

## 9. Assembly DFM gates, including AI-assisted checks

An AI or rule engine can accelerate review, but must not invent package dimensions,
approve alternates, infer a factory's unpublished process, or waive a collision. Use it
to create a review queue with evidence links, then require a designer/manufacturing
engineer disposition.

### Deterministic checks (safe to automate)

| Gate | Machine-checkable rule | Human disposition needed |
|---|---|---|
| Footprint provenance | Every fitted footprint has drawing URL/revision and verification state. | Validate the source actually matches the ordered MPN. |
| Courtyard | Flag overlap and missing height/keepout data. | Approve only documented mechanical/assembly exceptions. |
| Polarity | Require Pin-1/polarity property and visible mark on sensitive parts. | Compare symbol, package, silkscreen, and placement preview. |
| Paste/mask | Flag missing paste, apertures over vias, paste bridges, tiny mask slivers, and center-pad 1:1 paste. | Decide package-specific aperture/via treatment with datasheet/assembler. |
| Thermal pad | Require net, via treatment, paste strategy, and X-ray requirement field. | Validate thermal/void target against the exact part/application. |
| Placement | Reconcile BOM, CPL, schematic, and placed reference-designator sets; validate units, side, and rotation range. | Inspect rendered preview/first article for each footprint family. |
| Spacing/access | Apply selected assembler matrix; flag board-edge, nozzle, fixture, and hot-air keepouts. | Confirm 3D/mating/depanel and rework access. |
| Supply | Flag unapproved or out-of-stock MPNs, and alternates without a delta review. | Approve/reject electrical, mechanical, thermal, MSL, and regulatory impact. |
| Test | Flag nets marked critical with no accessible test point or stated exception. | Approve coverage, probe forces, fixture, and test limits. |
| MSL/cleanliness | Flag missing MSL, bake, ESD, or cleaning disposition for sensitive parts. | Confirm current component/standard requirements and process ownership. |

### AI use protocol

1. Feed the checker authoritative inputs: netlist, PCB, BOM, CPL, library provenance,
   datasheets, assembler rules, stackup, panel drawing, and process class.
2. Ask it to produce *claim → source → confidence → needed human decision*, not a bare
   “pass.” Treat missing sources as failures to investigate.
3. Run deterministic DRC/ERC and fabrication checks independently. AI text generation is
   not geometry verification.
4. Require a named human owner for every warning waiver and preserve the waiver with the
   released manufacturing revision.
5. Compare AI-generated BOM/CPL mappings and rotations to the assembler's visual
   placement preview and first-article inspection. Never transmit an AI-inferred
   substitution as an approved production change.

## 10. Release checklist

Before ordering the first build, answer “yes” to each applicable item:

- [ ] Every fitted footprint is tied to the ordered MPN's package drawing/revision.
- [ ] Land, mask, paste, center-pad, and via strategy are reviewed separately.
- [ ] Courtyard, height, board edge, mating, fixture, and rework access conflicts are
      either clear or have written exceptions.
- [ ] Polarity/Pin 1 is correct in schematic, footprint, silkscreen, 3D model, BOM, and
      CPL preview.
- [ ] BOM, CPL, Gerber/ODB++, fab drawing, assembly drawing, panel drawing, and DNP list
      have identical revision identifiers and reconciled designators.
- [ ] Chosen assembler has reviewed its current spacing, fiducial, rail, tooling,
      stencil, component, and panel requirements.
- [ ] All alternates are engineering-approved and traceable; no portal match is treated
      as automatic authorization.
- [ ] MSL, storage, ESD, cleaning, reflow, wave/selective/manual, and rework requirements
      are identified per applicable part/process.
- [ ] Inspection/test plan states SPI/AOI/X-ray/test scope, limits, samples, reports,
      functional criteria, and rework/retest action.
- [ ] First article includes high-risk packages and validates the actual assembly
      process, not only CAD DRC.

## 11. What is JLC-specific versus general

| Topic | General engineering conclusion | Current JLCPCB-specific information in this dossier |
|---|---|---|
| Land patterns | Exact package document first; IPC method is a fallback. | No JLC generic land-pattern dimension is substituted for the datasheet. |
| Spacing | Needs placement, inspection, rework, and component-body access. | Published pairwise recommendations, such as QFN/QFN 1.0 mm and BGA/BGA 2.0 mm, are JLC recommendations. |
| Fiducials/rails | Required form and count depend on the assembler/process. | Standard assembly page says rails/fiducials required; 5-mm rail, 1-mm fiducial, 2x mask opening, 3–4 marks, 3.35-mm edge clearance. |
| Tooling | Tooling depends on equipment/panel plan. | Economic PCBA article gives 1.152-mm NPTH and 0.148-mm mask expansion guidance. |
| BOM/CPL | Every assembler needs unambiguous part/placement data. | Current JLC fields, headers, matching behavior, selected-components boundary, and LCSC/JLC part numbers are supplier workflow details. |
| Stencil | Explicit paste intent and printability review are universal. | JLC says paste layer is highly recommended and offers listed standard stencil thickness choices; confirm quote-time defaults. |
| Inspection | AOI/X-ray/test have distinct coverage and must be planned. | JLC describes available inspection/testing modes; availability and reports must be confirmed per order. |
| Moisture | Follow package MSL/J-STD-033 controls. | JLC discusses baking of certain global-sourcing parts, but it is not a replacement for the part's MSL procedure. |

## 12. Limitations and stop point

Public sources expose the scope of IPC documents but not their complete licensed
requirements. This dossier therefore does not claim an IPC class, universal numeric
courtyard margin, universal void limit, or a supplier-independent stencil recipe. The
target JLC blog page was unavailable on 2026-09-06; current JLC Help Center pages were
used as a time-sensitive operational substitute. Technical sources converged on the
same core controls—exact package data, explicit paste/mask, balanced reflow geometry,
controlled thermal-pad vias, verified placement data, and layered inspection—so further
general web searching was unlikely to improve a design release without the actual board,
part list, and assembler quote.

## Primary-source ledger

The ledger lists the sources actually used. “Primary” means the organization is reporting
its own standard, capability, contract rule, component/package guidance, or process.
Application notes are primary for the author's package/process example, not universal
standards. Access dates are 2026-09-06 unless stated otherwise.

| ID | Source and publisher | Date / status | Evidence used and limits | URL |
|---|---|---|---|---|
| P1 | *PCB Assembly Guidelines*, JLCPCB | URL returned 404 at access | Target article is unavailable; no technical claim taken from it. | [JLC URL](https://jlcpcb.com/blog/pcb-assembly-guidelines) |
| P2 | *IPC-7352 Generic Guideline for Land Pattern Design* table of contents, IPC | May 2023 | Scope for land tolerance, courtyards, thermal-tab paste and validation; full requirements are licensed. | [IPC-7352 TOC](https://www.ipc.org/TOC/IPC-7352-TOC.pdf) |
| P3 | *IPC Design Standards*, IPC | current web page | Names current land-pattern/BTC/BGA standard families. | [IPC catalogue](https://www.ipc.org/ipc-design-standards) |
| P4 | *Library Management for an Ever-Evolving Diverse EDA Tool Industry*, IPC | presentation, web-hosted | Courtyard/placement boundary, height and Pin-1 library fields; guidance, not a factory capability. | [IPC presentation](https://www.ipc.org/system/files/technical_resource/E41%26S25_03%20-%20Michelle%20Gleason.pdf) |
| P5 | *QFN and SON PCB Attachment* (SLUA271C), Texas Instruments | rev. Dec. 2023 | QFN/SON paste, stencil, area/aspect guidance, thermal-pad coverage/voiding, profile/MSL notes; package-family example. | [TI PDF](https://www.ti.com/lit/an/slua271c/slua271c.pdf) |
| P6 | *QFN Layout Guidelines* (SLOA122), Texas Instruments | 2006 | Thermal via/solder loss/protrusion and X-ray examples; older package-specific guidance. | [TI PDF](https://www.ti.com/lit/an/sloa122/sloa122.pdf) |
| P7 | *PowerPAD Layout Guidelines* (SLOA120), Texas Instruments | 2006 | Thermal-pad stencil and voiding example; PowerPAD-specific. | [TI PDF](https://www.ti.com/lit/an/sloa120/sloa120.pdf) |
| P8 | *Soldering and Rework Recommendations*, Coilcraft | revision/date not confirmed from public copy | Even-solder/position/heating tombstone mechanism and hot-air rework preference; manufacturer guidance. | [PDF](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/196/3010.MSS7348_2D00_153MEC_5F00_APP-REV01.pdf) |
| P9 | *PowerFLAT PCB Assembly Recommendations* (AN5046), STMicroelectronics | web-hosted application note | Wave limitation for PowerFLAT slug; package-specific. | [ST PDF](https://www.st.com/resource/en/application_note/an5046-printed-circuit-board-assembly-recommendations-for-stmicroelectronics-powerflat-packages-stmicroelectronics.pdf) |
| P10 | *Minimum Spacing Requirements for SMD Components*, JLCPCB | updated 2026-06-12 | JLC pairwise spacing recommendations and stated inspection/rework rationale; recheck on quote. | [JLC help](https://jlcpcb.com/help/article/minimum-spacing-for-smd-components) |
| P11 | *How to Add Edge Rails and Fiducials for PCB Assembly Orders*, JLCPCB | updated 2026-05-20 | JLC rail/fiducial dimensions and delivery practice; supplier-specific. | [JLC help](https://jlcpcb.com/help/article/how-to-add-edge-rails-fiducials-for-pcb-assembly-order) |
| P12 | *How to Include Fiducial Marks on an SMT Stencil*, JLCPCB | updated 2026-09-01 | Purpose of stencil fiducials and process-dependent need; supplier guidance. | [JLC help](https://jlcpcb.com/help/article/how-to-include-fiducial-marks-on-an-smt-stencil) |
| P13 | *How to Add Tooling Holes for PCB Assembly Order*, JLCPCB | updated 2024-02-23 | Economic PCBA tooling-hole implementation; supplier-specific and potentially changed. | [JLC help](https://jlcpcb.com/help/article/how-to-add-tooling-holes-for-pcb-assembly-order) |
| P14 | *Instructions for Stencil Order*, JLCPCB | updated 2026-07-13 | Paste-layer expectations and stencil options; order-flow guidance. | [JLC help](https://jlcpcb.com/help/article/instructions-for-stencil-order) |
| P15 | *Via Covering: Tented, Untented, Plugged, Epoxy-Filled and Copper-Epoxy Options*, JLCPCB | updated 2026-08-18 | JLC terminology and untented-via solder-flow risk; not thermal-pad qualification. | [JLC help](https://jlcpcb.com/help/article/pcb-via-covering) |
| P16 | *BOM File for PCB Assembly*, JLCPCB | updated 2025-04-24 | BOM fields and format guidance; current supplier requirements should be checked at upload. | [JLC help](https://jlcpcb.com/help/article/bill-of-materials-for-pcb-assembly) |
| P17 | *KiCad BOM and Pick-and-Place Export*, JLCPCB | updated 2026-08-27 | JLC BOM/CPL fields and units; KiCad-version-specific instructions are incidental. | [JLC help](https://jlcpcb.com/help/article/how-to-generate-the-bom-and-centroid-file-from-kicad) |
| P18 | *Recommendations for BOM/CPL File Preparation*, JLCPCB | updated 2026-01-19 | Matching/header and designator consistency behavior. | [JLC help](https://jlcpcb.com/help/article/advice-for-bom-and-cpl-files-preparation) |
| P19 | *Component Matching Guidelines for PCBA Orders*, JLCPCB | updated 2026-05-20 | Customer-selected components and matching limitations; does not approve engineering substitutes. | [JLC help](https://jlcpcb.com/help/article/component-matching-guidelines-for-pcba-orders) |
| P20 | *SMT Inspection and Testing Capabilities*, JLCPCB | current help page | Described AOI/X-ray/flying-probe/FCT roles; availability is order-specific. | [JLC help](https://jlcpcb.com/help/article/smt-inspection-and-testing-capabilities) |
| P21 | QC115a, *Moisture Sensitive Plastic Surface Mount Device Requirements*, JPL | current supplier portal page | J-STD-033 reference and dry-pack elements; a JPL contract requirement, not universal law. | [JPL QC115a](https://supplierportal.jpl.nasa.gov/qcprint.php?clause=QC115a) |
| P22 | JSC 27301F, NASA | 2008 PDF | ESD-control reference to EOS/ESD S20.20; NASA workmanship context. | [NASA PDF](https://standards.nasa.gov/sites/default/files/standards/JSC/F/0/JSC-27301F.pdf) |
| P23 | NASA-STD-8739.2, NASA | inactive, change 2 dated 2011 | Historical visual workmanship examples only; not selected as current acceptance standard. | [NASA status](https://standards.nasa.gov/node/281), [public PDF](https://s3vi.ndc.nasa.gov/ssri-kb/static/resources/NASA-STD-8739-2.pdf) |
| P24 | *Surface Mount Technology Course*, JPL MTTC | current catalogue page | States NASA STD 8739.2 course superseded by IPC J-STD-001; status context. | [JPL MTTC](https://mttc.jpl.nasa.gov/catalog/surface-mount-technology/) |


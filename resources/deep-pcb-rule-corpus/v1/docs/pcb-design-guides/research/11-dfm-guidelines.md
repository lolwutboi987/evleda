# DFM (Design for Manufacturability) Guidelines

**Research date:** 2026-09-06  
**Audience:** PCB designers preparing a bare-board or assembled-board package for a named fabricator.  
**Purpose:** Turn DFM from a late upload check into a documented engineering review. This is not an automated release procedure and does not authorize fabrication.

## Executive guidance

DFM is the evidence that the **specific design, stackup, package, and order options** can be made and assembled with adequate margin. A CAD DRC is necessary but not sufficient: it checks the rules loaded into CAD, while fab CAM and assembly DFM check the received fabrication and assembly data against the chosen process.

Use the fabricator's current capability table as the source of numeric production constraints; configure those constraints in CAD before routing; generate a complete, revision-identified data package; independently inspect the exported files; then resolve every fabricator/assembler finding. Do not equate a published *minimum* with a robust target, and do not apply one vendor's number to another vendor or process.

The requested JLCPCB article URL, `https://jlcpcb.com/blog/dfm-design-for-manufacturability-guidelines`, returned HTTP 404 when checked on 2026-09-06. It is therefore not cited for technical claims. The live JLCPCB capability page is the JLC-specific source used here. Its table is detailed, but it also contains an internal conflict on blind/buried vias; that conflict is called out below rather than silently resolved.

## Evidence boundary and terminology

| Label used here | Meaning | How to use it |
|---|---|---|
| **JLCPCB-published** | A capability, tolerance, or limitation stated on JLCPCB's live capability page, accessed 2026-09-06. | Valid only for the selected JLCPCB service and current order configuration; re-check at quote/order time. |
| **Standards/general practice** | A workflow or terminology supported by IPC, KiCad, or the official Gerber documentation, without claiming a universal numeric fab limit. | Adapt it to the chosen fabricator and product class. |
| **Engineering target** | A deliberately more conservative project rule. | Record its rationale and owner; do not present it as a vendor requirement. |
| **Open item / exception** | A deliberate departure, ambiguity, or unverified assumption. | Put it in the review output and obtain an explicit disposition from the responsible engineer/fabricator. |

`Minimum`, `recommended`, and `guaranteed` are different statements. A capability table defines what a supplier says it can process under stated conditions; the board's actual stackup, copper weight, finish, drill pattern, material, and panel can make a nominally allowed feature expensive, lower-yield, or subject to engineering review.

## 1. Start with the manufacturing definition, not generic rules

Freeze a short fabrication profile before layout starts or before a redesign pass:

- fabricator, service tier, bare-board versus PCBA scope, target quantity, intended application, and the governing quality/acceptance requirement;
- layer count, finished thickness, copper weights, laminate family, finish, solder-mask colour, controlled-impedance requirement, and any material/UL/thermal requirements;
- board outline, panel ownership (designer or fabricator), depanelization method, rails, fiducials, tooling holes, test points, and assembly-side restrictions;
- all special processes: impedance control, via fill/cap, press-fit, castellations, plated edge, backdrill, blind slots, RF material, heavy copper, flex/rigid-flex, or HDI; and
- each required deliverable, its coordinate origin, units, revision, and a single point of contact for engineering questions.

IPC-2221 is a generic printed-board design standard, not a substitute for the fabricator's process capability sheet. IPC's design-standard catalogue also distinguishes subjects such as surface-mount land patterns (IPC-7351/7352), board fabrication documentation (IPC-2614), and dimensions/tolerances (IPC-2615). Select the applicable documents and customer requirements explicitly rather than asserting that an unspecified board is "IPC compliant." [IPC-2221B table of contents](https://www.ipc.org/TOC/IPC-2221B.pdf); [IPC design standards catalogue](https://www.ipc.org/ipc-design-standards)

## 2. Fabrication geometry: make the constraints explicit

### 2.1 Trace width, spacing, copper weight, and copper balance

Widths and clearances must be checked in the context of finished copper weight and the layer on which they occur. Etch compensation, plating, and registration make outer and inner layers different manufacturing cases. Separate electrical clearance rules (voltage, creepage, impedance) from fabrication spacing rules, then use the larger requirement at each location.

As a **JLCPCB-published example**, the capability table lists 0.10/0.10 mm (4/4 mil) for 1 oz on one- and two-layer boards, 0.09/0.09 mm for multilayer boards, and larger minima for heavier finished outer copper; it lists finished outer copper options separately from inner copper and states a ±20% track-width tolerance. Those are boundaries, not a recommendation to route a whole design at the smallest value. [JLCPCB rigid PCB capabilities, traces and copper](https://jlcpcb.com/capabilities/pcb-capabilities)

Review copper distribution and thermal reliefs with the fabricator/assembler. This is general DFM practice: extensive one-sided copper imbalance, isolated copper, acute slivers, or large abrupt changes in copper density can affect etch uniformity, lamination, and warpage. Treat any numeric copper-balance target as a project/fabricator-specific rule unless the selected supplier publishes one.

### 2.2 Drills, plated holes, aspect ratio, and annular rings

For every drilled feature, declare its intent: PTH/via, press-fit, NPTH, plated slot, routed slot, counterbore/countersink, or tooling. A drill drawing/table should distinguish **finished hole** from **drill tool diameter** and state whether the tolerance applies before or after plating. Do not infer plating intent from a drawing shape alone.

The through-hole aspect ratio is commonly calculated as board thickness divided by drilled hole diameter. It is a plating-risk indicator, not a universal pass/fail value. Increasing board thickness or reducing drill size makes solution exchange and uniform barrel plating more difficult. Ask the chosen fabricator to approve the ratio for the actual stackup and via distribution, especially for thick multilayers, dense via fields, or high-reliability service. Do not calculate it using a different source's definition of finished versus drill diameter without reconciling the distinction.

JLCPCB publishes 0.15–6.3 mm drill diameter for two-layer and multilayer boards, ±0.05 mm hole-position tolerance, average 18 µm hole plating, and through-hole finished-size tolerance of +0.13/-0.08 mm. It lists 0.15 mm hole / 0.25 mm via diameter as its minimum for two-layer and multilayer boards, calls 0.20 mm drill preferred, and marks some small-hole combinations as extra cost. These are **JLCPCB-specific** and must be revalidated against the order configuration. [JLCPCB rigid PCB capabilities, drilling](https://jlcpcb.com/capabilities/pcb-capabilities)

Annular ring is the copper remaining between the hole edge and pad edge after drilling and registration variation. Size pads from the chosen finished-hole requirement, drill/plating allowance, fabrication registration tolerance, and the relevant fabricator annular-ring rule; do not merely reuse a convenient library pad. JLCPCB lists PTH annular-ring recommendations/minima by layer count and copper weight (for example, a 0.20 mm general PTH ring entry and lower absolute minima in some multilayer cases) and separately lists a 0.45 mm NPTH pad annular-ring recommendation. Those values cannot be generalized to another supplier or technology. [JLCPCB rigid PCB capabilities, annular rings](https://jlcpcb.com/capabilities/pcb-capabilities)

### 2.3 Copper to edge, routed features, and cutouts

Treat the board profile and all internal cutouts as manufacturing features, not artwork. Put one unambiguous, closed outline on the designated mechanical/profile layer; eliminate duplicate or overlapping outlines; check every layer for copper, mask, silk, via, and component overhang relative to the final edge. Maintain a named edge-clearance rule for routed edge, V-score, plated edge, and cutout because they need not have the same clearance.

JLCPCB lists at least 0.2 mm copper clearance to routed board edges and routed slots, but 0.4 mm to a V-cut edge. It lists routed-edge tolerance as ±0.2 mm regular or ±0.1 mm high precision, while V-scoring is ±0.4 mm. These values show why a single generic "edge clearance" is insufficient. [JLCPCB rigid PCB capabilities, outline](https://jlcpcb.com/capabilities/pcb-capabilities)

For cutouts and slots, state plated versus non-plated intent and nominate the mechanical source of truth. JLCPCB lists minimum plated-slot widths of 0.5 mm (two layer) and 0.35 mm (multilayer), a 1.0 mm minimum non-plated slot, and says rectangular holes/slots without rounded corners are unsupported. Its table also distinguishes the tolerances and the way plated slots versus CNC non-plated slots are made. [JLCPCB rigid PCB capabilities, drilling and slots](https://jlcpcb.com/capabilities/pcb-capabilities)

### 2.4 Solder mask, paste, and silkscreen

Mask opening, mask expansion, solder-mask dam (mask web), via tenting/filling, and paste aperture are separate properties. A solder-mask dam is not guaranteed merely because CAD draws a narrow strip: the fabricator may remove a too-small web or merge openings. State design intent for exposed copper, tented vias, plugged vias, via-in-pad, and any gold fingers/edge contacts.

JLCPCB says its LDI upgrade permits 1:1 pad-to-mask opening, but also requires at least 0.09 mm clearance from a solder-mask opening to neighbouring traces. It lists a 0.10 mm solder-mask bridge for 1 oz in most listed colours, 0.13 mm for black/white, and 0.20 mm for 2 oz. It also gives restrictions for mask-filled vias and special via-in-pad processes. These are supplier/process/color/copper-specific constraints; model them as conditional rules, not a universal mask rule. [JLCPCB rigid PCB capabilities, solder mask](https://jlcpcb.com/capabilities/pcb-capabilities)

Paste layers are assembly data. Validate them against the component manufacturer's recommended land pattern, assembly process, stencil thickness, and aperture-reduction strategy; never copy solder-mask openings into paste by default. For fine-pitch/BTC/BGA parts, put the paste decision and any thermal-pad windowing rule in the assembly documentation.

For legend, make reference designators readable but keep them off solderable pads and exposed test contacts. JLCPCB lists a 0.15 mm minimum legend line width, 1.0 mm minimum text height, and 0.15 mm pad-to-silkscreen clearance. Use those only for a JLCPCB-targeted profile; legibility demands may call for larger project targets. [JLCPCB rigid PCB capabilities, legend](https://jlcpcb.com/capabilities/pcb-capabilities)

### 2.5 Plating, finish, and special edge features

Surface finish is a product decision with assembly, coplanarity, storage, RF, contact, and cost implications. Identify it in both the order configuration and fabrication notes, and verify that it is compatible with material, layer count, board thickness, and assembly requirements. JLCPCB lists HASL, ENIG, and OSP with limitations by board type; for example, its current page says HASL is not supported for several product categories including 6+ layer FR-4/HDI and thin/high-frequency boards. [JLCPCB rigid PCB capabilities, finishes](https://jlcpcb.com/capabilities/pcb-capabilities)

Castellations, plated edges, press-fit holes, via-in-pad, and backdrill are not ordinary vias. Put their dimensions, plating/finish intent, and acceptance concern into the fabrication notes and ask for explicit engineering confirmation. JLCPCB's table gives separate restrictions for castellations and plated edges, including minimum board size/thickness and support-tab requirements for edge plating. [JLCPCB rigid PCB capabilities, special features](https://jlcpcb.com/capabilities/pcb-capabilities)

### 2.6 Stackup and controlled impedance

Controlled impedance is a **stackup-controlled system requirement**, not a trace-width decoration. Before routing, obtain the fabricator's proposed or standard stackup for the exact layer count, material family, copper weights, and finished thickness. Route each controlled net using the calculated geometry for its reference plane; avoid reference-plane discontinuities, unintended stubs, layer transitions without return paths, and undocumented copper/mask assumptions. Supply an impedance table identifying net/net class, layer, topology, target impedance, tolerance, reference plane, and critical connector/launch constraints.

JLCPCB publishes controlled impedance for selected multilayer counts and a standard ±10% tolerance, with a page FAQ saying ±5% is available by special request. It also publishes FR-4 dielectric constants and links an impedance calculator. This is a **JLCPCB service statement**, not a substitute for a signed stackup or coupon/test agreement. [JLCPCB rigid PCB capabilities, controlled impedance](https://jlcpcb.com/capabilities/pcb-capabilities)

For designs above ordinary complexity, do not extrapolate a two-layer rule to multilayer, RF, flex, high-frequency laminate, heavy copper, or HDI. IPC-2228 is a sectional high-frequency printed-board design standard; use the current applicable requirements and supplier material data for RF work. [IPC-2228 table of contents](https://www.ipc.org/TOC/IPC-2228_TOC.pdf)

### 2.7 HDI and technology exceptions

An exception needs its own mini-capability review: proposed construction, via type, laser/mechanical drill spans, fill/cap requirements, stackup, yield/cost impact, and verification method. Do not label a board HDI simply because its CAD rules are tight.

There is a material JLCPCB source conflict: its detailed drilling table says blind/buried vias are "Not supported" and only through holes are made, while a FAQ lower on the same page describes blind/buried vias and HDI laser vias as advanced options. Treat this as **unresolved**. Do not claim that the service supports blind/buried vias from this page alone; submit the exact stackup and feature set for written engineering confirmation before designing or ordering it. [JLCPCB rigid PCB capabilities, drilling and FAQ](https://jlcpcb.com/capabilities/pcb-capabilities)

## 3. Panelization, assembly access, fiducials, and tooling

Panel ownership must be explicit. If the fabricator panels the board, provide a depanelization and handling requirement, not a guessed tab pattern. If the designer supplies a panel, include the panel drawing and validate rail width, breakaway tabs, rout/score geometry, coupon space, component keepouts, and downstream assembly/depanelization stresses.

JLCPCB lists distinct conditions for V-cut and mouse-bite panels: 0.4 mm copper clearance from a V-cut edge, 0.2 mm clearance from non-mouse-bite routed edges, a 2 mm panel spacing guideline, and separate panel size/rail/tab details. For its SMT assembly it specifies 5 mm tooling edges, 2 mm tooling holes, and 1 mm fiducials centred 3.85 mm from panel edges. These are JLCPCB assembly rules, not generic bare-board rules. [JLCPCB rigid PCB capabilities, panelization](https://jlcpcb.com/capabilities/pcb-capabilities)

General practice is to provide global fiducials accessible to the placement system and local fiducials where the assembler requires them for fine-pitch parts. Keep fiducials free of copper, silk, mask irregularities, clamps, and component overhang as required by the assembler; mark the exact datum and component-side usage. Also review tooling holes, edge-rail stiffness, connector overhang, and test-probe access with the assembly house, because a bare-board panel can pass fabrication DFM yet fail assembly handling.

## 4. Data package and fabrication notes

### 4.1 Package contents

Deliver a clean, revisioned archive with a human-readable manifest. At minimum, include the files the chosen supplier requests, typically:

- Gerber image layers for each copper, solder mask, legend, paste, and profile/mechanical layer as applicable;
- separate drill/rout data with plated versus non-plated intent unambiguous, plus drill map/table when requested;
- fabrication drawing/notes: finished thickness, material, copper weight, finish, mask colour, controlled-impedance table/stackup, critical dimensions/tolerances, special features, panel/datum, and revision;
- assembly drawing, centroid/pick-and-place file, BOM with manufacturer part numbers and approved substitutions, paste layer, and assembly-specific notes for PCBA;
- electrical test/netlist data when required by the fabricator or contract; and
- the native design sources, exported PDF review views, and a manifest containing file hashes, units, origin, revision, and intended supplier profile.

Gerber describes image layers, but fabrication needs more than images. The official Gerber Job specification describes machine-readable fabrication information such as finish, overall thickness, and material, while Gerber X2 attributes identify layer functions and other objects. Use a Gerber job file where the toolchain and fabricator support it; otherwise make the equivalent fabrication intent explicit in controlled notes/drawings. [Official Gerber Job documentation](https://www.ucamco.com/en/gerber/gerber-job-file)

The IPC-2581C scope describes an XML product-manufacturing data format containing information sufficient for tooling, manufacturing, assembly, and inspection. It can reduce ambiguity when both toolchain and supplier accept it, but it does not replace confirming the supplier's required upload format. [IPC-2581C scope](https://www.ipc.org/TOC/IPC-2581C-toc.pdf)

For KiCad projects, the official documentation says drill files can be generated in Excellon or Gerber X2; it also notes that custom design rules live in a separate `kicad_dru` file and must travel with the project. Include the native board/project/rule files under source control, while treating the released fabrication archive as a separately reviewed export. [KiCad PCB Editor: drill files](https://docs.kicad.org/master/ca/pcbnew/pcbnew.html); [KiCad PCB Editor: custom rules](https://docs.kicad.org/10.0/id/pcbnew/pcbnew.html)

### 4.2 Fabrication notes: say what CAD geometry cannot say

Notes should be short, testable, and non-conflicting. Avoid "manufacture per standard" without naming the standard revision, class, scope, and precedence. Do not use a note to override a feature that CAD has not unambiguously represented.

Useful notes include:

- revision, units, drawing scale, datum/origin, layer naming, and precedence if sources conflict;
- finished board thickness and tolerance; material/laminate requirement; finished copper weights; finish; solder mask/legend requirements;
- PTH/NPTH/slot/rout definitions, controlled hole sizes/tolerances, and special feature callouts;
- approved stackup plus impedance targets and coupon/test requirements where contracted;
- profiling/panel/depanelization requirements, critical dimensions, edge plating/castellations, and cosmetic requirements;
- electrical test requirements, acceptance class/standard, serialization/marking, and packaging; and
- a list of approved deviations. Everything else should be raised as an engineering question, not silently changed.

## 5. Configure CAD DRC as a traceable fab profile

Create a named rule profile for each fabrication technology, e.g., `JLC-rigid-4L-1oz-2026-09` rather than `default`. Record the source URL, access date, order assumptions, and every adopted value. Configure global minima for the selected fab, then use net classes/custom rules for stricter power, HV, RF, differential-pair, BGA, edge, and special-feature regions. Never configure a global value looser than the strictest feature that CAD cannot scope reliably.

KiCad documents that design rules control routing, zone fill, and DRC; its global Constraints are absolute minima that cannot be overridden by a more specific custom rule, while net classes/custom rules can impose larger local requirements. Its getting-started documentation specifically says real projects should set stackup and constraints according to the board fab's capabilities. [KiCad PCB Editor 7: constraints](https://docs.kicad.org/7.0/en/pcbnew/pcbnew.html); [KiCad manufacturing setup](https://docs.kicad.org/10.0/en/getting_started_in_kicad/getting_started_in_kicad.html)

Minimum rule categories to record:

| Rule family | Configuration/check | Evidence to retain |
|---|---|---|
| Copper | width, clearance, neck-downs, same-net spacing, zone min-width/slivers, plane clearances, copper-to-edge/cutout/V-score | profile version and DRC report |
| Holes | PTH/NPTH drill, finished-hole tolerance, via pad/ring, drill-to-drill, drill-to-copper, aspect-ratio review | drill table and stackup calculation |
| Mask/paste/legend | mask expansion/opening, mask dam by colour/copper, via tenting/fill, paste aperture strategy, silk-to-pad | layer render and assembly notes |
| Stackup/SI | layer pairs, dielectric/copper assumptions, impedance geometry, differential-pair/length rules, return-path constraints | approved stackup and impedance table |
| Mechanical | outline integrity, route/score clearance, panel tabs, rails, fiducials, tooling holes, component/edge clearance | panel drawing and assembly review |
| Exceptions | BGA fanout, via-in-pad, press-fit, castellation, edge plating, HDI/RF/flex/heavy copper | written fab/assembler disposition |

Run DRC after every material rule or geometry change and again immediately before export. A clean report is evidence of the selected rules, not evidence that the selected rules are complete or that the fab accepted the data.

## 6. Review gates and DFM output

Use a review that produces decisions, not a binary "DFM passed" label.

1. **Input integrity:** schematic/PCB synchronization, footprint and 3D/mechanical fit review, correct variant/BOM, revision identity, and all zones refilled.
2. **Electrical/layout review:** DRC/ERC, return paths, current/thermal constraints, creepage/clearance, impedance/length constraints, and component datasheet land-pattern requirements.
3. **Bare-board DFM:** rules versus the named fab profile; drill/annular-ring/aspect-ratio checks; mask/legend; edge/cutout/slot; finish/material/stackup; panelization; special features.
4. **Assembly DFA/DFM:** component orientation/polarity, package/body clearance, keepouts, fiducials/tooling/rails, paste/stencil constraints, BGA/BTC/thermal pad handling, testability, and supplied BOM/centroid/paste data.
5. **Export inspection:** open the final archive in an independent Gerber/CAM viewer. Verify all layers align; only intentional copper/mask/silk/paste content is present; drills, slots, profile, origin, units, board count, and panel are correct; then compare the viewer result with the native board.
6. **Supplier review:** upload/request CAM/DFM analysis for the exact archive and options. Resolve findings with a documented disposition; do not assume that a warning was corrected by the supplier.

The DFM result should be a revisioned table with: ID, check, affected feature/location, source/profile and revision, severity, evidence/screenshot, risk, proposed correction, owner, disposition, approver, and closure date. Preserve original vendor output with the exact archive hash. When a vendor auto-corrects or requests a clarification, require a redline/confirmation of the changed data before accepting it.

## 7. Version control and change discipline

Keep native sources, stackup/profile files, DRC rules, library/footprint provenance, BOM/centroid sources, drawings, and released archives under identifiable revision control. Do not use an old Gerber archive as the editable source of truth. Tag or otherwise immutably identify the native commit used to create every reviewed fabrication archive, store its hash in the manifest, and invalidate affected DFM findings whenever copper, holes, outline, stackup, finish, panel, or assembly data changes.

For KiCad, include `kicad_pcb`, `kicad_pro`, and `kicad_dru` together; KiCad explicitly warns that custom rules are stored separately and should be saved with the project. [KiCad custom-rules documentation](https://docs.kicad.org/10.0/id/pcbnew/pcbnew.html)

This discipline is deliberately review-oriented. It does **not** define unattended release, automatic ordering, or automatic acceptance of CAM changes.

## 8. AI-assisted validation: permitted role and hard limits

AI can organize evidence, identify missing deliverables, parse a declared rule profile, flag visible contradictions, compare stated geometry to sourced constraints, and draft a review matrix. It cannot inspect an unstated stackup, infer plating performance, certify impedance, substitute for an IPC acceptance decision, or claim that a fabricator will build the board.

### Required AI validation rules

1. **Identify the source scope on every numeric claim.** Output `JLCPCB-published`, `other vendor`, `standard/general`, `engineering target`, or `unknown`; include URL, access date, and applicable conditions. Never emit an unsourced number as a manufacturing rule.
2. **Do not transfer vendor minima.** A JLCPCB number may be used only for a JLCPCB-targeted profile and only after the service, layer count, copper weight, finish, mask colour, panel method, and special process are checked.
3. **Treat missing inputs as blockers, not assumptions.** No conformance conclusion without the board revision/archive hash, intended fabricator/service, stackup, finished thickness, copper weights, finish, hole intent, and required controlled-impedance/assembly scope.
4. **Keep feasibility and margin separate.** Report `below published minimum`, `at minimum`, `above minimum with unknown margin`, or `project target met`; do not call an at-minimum feature robust.
5. **Calculate transparently.** For aspect ratio, show formula, units, and whether hole diameter is drill or finished. For annular ring, show pad, hole basis, and assumed tolerance. Mark calculations `unverified` until a fab confirms the manufacturing interpretation.
6. **Detect source conflicts.** If a source contradicts itself (as the cited JLCPCB page does for blind/buried vias), emit `UNRESOLVED—vendor confirmation required`, not a synthesized capability claim.
7. **Do not silently repair outputs.** If Gerbers, drills, BOM, centroid, drawings, or vendor DFM disagree, report the conflict and request a controlled source change/re-export. Preserve the original archive and review evidence.
8. **Require human/supplier closure.** An AI finding may be closed only with a linked design change plus recheck, or explicit written disposition by the responsible engineer/fabricator/assembler. AI output is review support, not authorization.
9. **Respect data boundaries.** Do not upload proprietary design files, customer identifiers, or export-controlled material to an AI service without authorization. Redact review excerpts where possible.
10. **Use deterministic tools for deterministic checks.** CAD DRC, Gerber/CAM viewers, netlist comparisons, rule parsers, and fab DFM reports are the evidence for geometry/file correctness; AI may summarize their results but must quote the source report/version and preserve its limitations.

### Suggested AI output schema

| Field | Required content |
|---|---|
| Finding ID / revision | Stable identifier and archive hash or native commit |
| Claim and location | Exact feature, layer, coordinate/reference, and measured value |
| Rule | Rule text/value, units, status label, source URL/date, conditions |
| Computation | Formula and input values where derived |
| Confidence / limitation | What was directly verified; missing data; source conflicts |
| Disposition | Open, design change required, fab confirmation required, waived with approver, or verified closed |

## 9. Compact pre-submission checklist

- [ ] Named fabrication profile and order assumptions match the current supplier capability source.
- [ ] Stackup, thickness, copper, material, finish, mask colour, and impedance intent are selected and documented.
- [ ] CAD DRC has zero unreviewed errors; all warnings/exceptions have owners and dispositions.
- [ ] Drill table distinguishes PTH, NPTH, slots, and special holes; aspect ratio and annular-ring risks were reviewed.
- [ ] Copper-to-route, copper-to-score, cutout, mask dam, mask opening, legend, and panel rules were checked.
- [ ] HDI/special processes have written supplier confirmation; no capability was inferred from a conflicting/marketing claim.
- [ ] Assembly package has verified BOM, centroid, paste, orientation/polarity, fiducial/rail/tooling, and test-access information.
- [ ] Final archive is revisioned, hash-listed, independently viewed, and matches the intended board/panel.
- [ ] Vendor CAM/DFM results are attached to that exact archive; all findings are explicitly resolved or accepted by an accountable human.

## Source ledger

| ID | Source and publisher | Date / access | Scope used | Reliability and limitation |
|---|---|---|---|---|
| S1 | [PCB Manufacturing & Assembly Capabilities](https://jlcpcb.com/capabilities/pcb-capabilities), JLCPCB | Accessed 2026-09-06 | JLCPCB rigid-board capability table: layers, thickness, copper, trace/space, drilling, plating, annular rings, mask, legend, outline, panel, impedance, special features | First-party current capability page. Supplier- and configuration-specific; page requires recheck at order time and contains the blind/buried-via conflict noted above. |
| S2 | [DFM (Design for Manufacturability) Guidelines](https://jlcpcb.com/blog/dfm-design-for-manufacturability-guidelines), JLCPCB | Checked 2026-09-06 | Topic seed only | Returned HTTP 404; no technical claim in this guide relies on it. |
| S3 | [IPC-2221B: Generic Standard on Printed Board Design](https://www.ipc.org/TOC/IPC-2221B.pdf), IPC | Publication date not established from retrieved TOC; accessed 2026-09-06 | Existence and scope of generic printed-board design standard | Primary standards-body source, but retrieved item is a table of contents rather than the paid/full normative text; no numeric rule was extracted. |
| S4 | [IPC Design Standards](https://www.ipc.org/ipc-design-standards), IPC | Accessed 2026-09-06 | Relevant standard families: land patterns, fabrication documentation, dimensions/tolerances | Standards catalogue; selection of a standard does not establish conformance. |
| S5 | [IPC-2581C: Generic Requirements for Printed Board Assembly Products Manufacturing Description Data and Transfer Methodology](https://www.ipc.org/TOC/IPC-2581C-toc.pdf), IPC | November 2020; accessed 2026-09-06 | XML manufacturing data scope, including tooling/manufacturing/assembly/inspection data | Primary standards-body scope text; use depends on tool and supplier support. |
| S6 | [Gerber Job](https://www.ucamco.com/en/gerber/gerber-job-file), Ucamco / official Gerber format site | Accessed 2026-09-06 | Need for fabrication information beyond image layers; X2 attributes and job-file purpose | Format-authority documentation, not a statement that a particular fabricator accepts every Gerber job feature. |
| S7 | [KiCad PCB Editor: drill files](https://docs.kicad.org/master/ca/pcbnew/pcbnew.html), KiCad | Accessed 2026-09-06 | Excellon/Gerber X2 drill generation | Official EDA documentation; master documentation can change by release. |
| S8 | [KiCad PCB Editor: constraints](https://docs.kicad.org/7.0/en/pcbnew/pcbnew.html) and [custom rules](https://docs.kicad.org/10.0/id/pcbnew/pcbnew.html), KiCad | Accessed 2026-09-06 | Rule configuration, absolute global minima, custom-rule file handling | Official EDA documentation; version-specific UI/behavior should be matched to the installed KiCad version. |
| S9 | [KiCad manufacturing setup](https://docs.kicad.org/10.0/en/getting_started_in_kicad/getting_started_in_kicad.html), KiCad | Accessed 2026-09-06 | Configure stackup and fab-based design rules | Official onboarding documentation; not a substitute for a fab capability profile. |
| S10 | [IPC-2228: Sectional Design Standard for High Frequency Printed Boards](https://www.ipc.org/TOC/IPC-2228_TOC.pdf), IPC | Publication date not established from retrieved TOC; accessed 2026-09-06 | High-frequency design standard scope | Primary standards-body index/TOC only; no hidden requirements inferred. |

### Search and stopping note

Research reviewed the requested URL, JLCPCB's live capability page, IPC's standards/catalogue material, the official Gerber documentation, and KiCad's official documentation. A second pass checked data-transfer, design-rule, drilling, and aspect-ratio sources. The work stopped after every requested topic had a grounded treatment or an explicit supplier-confirmation limitation; further vendor blog repetition would not resolve the only material contradiction (blind/buried vias) or replace an order-specific CAM review.

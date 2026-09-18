# 22×51mm placement macro assessment

**Macro B is the more useful routing-study starting point; neither macro is a completed or adopted PCB.** Both remove the newly introduced component/courtyard/service-band conflicts and all seven earlier component blockers from the centred short header-entry hardware checks. Macro A preserves the external converter cell more conservatively. Macro B creates a wider right-side MCU landing corridor and gives the converter a more compact position near the input, with an explicit local bypass-length tradeoff.

The unchanged22×51mm outline,2.54mm header pitch,17.78mm row spacing,40 original header lands/barrels,J1/J4 poses and H1–H4 mounting bores are retained. Full x0–3.46 and18.54–22 service bands remain free of all non-header candidate pad copper and component courtyards on this placement screen. No old tracks,ordinary vias or pours were retained as routing constraints or presented as new copper.

| Macro | External power anchor | MCU anchor | Raw right pad-to-cap gap | F short entries clear |
|---|---|---|---:|---:|
| A | U2(11,19.2),180° | U1(10.8,34),0° | 0.89mm | 36/40 |
| B | U2(10.5,16.45),90° | U1(10.4,32.5),0° | 1.49mm | 36/40 |

The corresponding B.Cu short-entry screen clears36/40 for both. The remaining four are the same mounting-hole corner conflicts from the corrected header notes. These are hardware-only starts, not complete connections or reference-plane proof. The separate mechanical owner's longer-outline/hole alternatives were not imported into these macros.

## Electrical grouping achieved

Macro A rigidly rotates U2,L2,C20,C21,C22,R9,R10 by180°. C20 faces USB/VSYS; C21 faces the MCU. The actual U2-to-input/output-cap centre separations stay2.51mm and its C22 bypass stays1.24mm. R9 andR10 are grouped by their actual VSYS/3V3_EN and SMPS_PS/GND functions. No separate feedback network is invented.

Macro B rotates U2,L2,C20,C21 by90°, preserving those same high-current cell separations. It repacks C22 and the EN/PS resistors around that cell; C22's geometric pin-to-cap span changes1.24→1.42mm. Both candidates retain the relative geometry of the MCU core-regulator group, flash with its local bypasses/pullups, and crystal with its series/load parts. The clock/load-cap subgroup is kept internally rigid; MCU escape paths still need rerouting.

Macro B holds the right decouplers farther out relative to the left-shifted MCU. The raw U1.40-to-C17.1 facing-pad gap grows from.89 to1.49mm; this is space reserved for a fresh launch allocation, not proof that four analog routes fit. Local ADC bypass centre distance grows1.59→2.18mm; DVDD39 grows1.64→2.22mm; IOVDD30 grows2.08→2.59mm. Dedicated local connections and returns must be rebuilt and reviewed. Caps were not detached from their functional groups, and no width/via/paste rule was relaxed. The ESD's C26 span improves3.94→1.45mm in both floorplans.

These centreline distance metrics show input grouping improvement, not routed lengths:

| Pair | Historical baseline mm | A mm | B mm |
|---|---:|---:|---:|
| ExternalVSYS header toinputcap | 42.17 | 15.05 | 15.99 |
| DiodeVSYS toinputcap | 32.91 | 5.35 | 4.08 |
| Outputcap toMCUcoreVIN | 17.51 | 8.01 | 13.66 |
| USBVBUS todiode | 4.46 | 4.80 | 4.80 |

## Actual checks and remaining findings

Source bindings for all62 footprints are hash checked.265 copper pad primitives,62 courtyards and230 actual F.Paste apertures replay the current stock-derived model at1nm precision. Both full62-pose maps are included. The candidate checks include all foreign pads, actual NPTH/PTH envelopes,.50mm drill-edge spacing,.25mm bore-to-copper floor,.50mm copper-to-board-edge floor, component courtyards and the complete proposed service strips. Neither introduces a new pad/courtyard/service-band/edge conflict.

**Four unchanged stock USB findings remain:** J1.A1/A12/B1/B12 are0.194403mm from J1's internal NPTH bore envelopes under the universal.25mm pad-to-hole screen. Placement owner confirms no explicit intrinsic-connector exception is known. They are reported separately as pre-existing library geometry, not silently waived by prior native category passes.

**Four header corners remain unresolved:** J2.1,J2.20,J3.1,J3.20 still meet the unchanged mounting-hole keepouts. The other36 centred short approaches clear both faces against candidate component pads/holes. Full inward routing, the no-unrelated-copper rule beyond each start, manufacturing tolerances, fastener head access, ground spokes/fill, finite return corridors and physical rework resistance are not established.

The pad-centre octilinear diagnostics do not exceed current per-net maximum lengths in either final macro. This ignores obstacles and is not a routing guarantee. USB_PORT/ESD lengths, pair skew and return paths need a new matched-channel plan; the longer ESD-to-MCU region now passes the new power stage. The old QFN source-fanout and multilayer obstacle problems cannot be declared solved by a macro move.

## Required future input and routing work

Each macro changes58 current component placement region/rotation contracts; exact old rules and proposed poses are in its JSON. No current draft/contract was edited. Selecting a macro requires a new complete pose/region input, the separate header/mechanical decision, and fresh connectivity/routing plans. Existing local copper may only be reused after an exact moved-pad/loop/return replay. Global VSYS/3V3, sense/control trunks, GPIO buses and ordinary vias must stay in the interior. Copper pours must exclude the service bands, including GND, with explicit inward header-ground spokes and a new connected return assessment.

Files: macro-A.json/macro-B.json contain exact poses and complete checks; macro-A.svg/macro-B.svg show the stock pad/courtyard layouts; base-physical.json and manifest.json pin every input. No canonical,managed-project,native,runtime or build files were changed. The workspace is bounded to2MiB and reserves at least150MiB free disk.

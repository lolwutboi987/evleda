# Pico-like RP2350A power selection

Reviewed 2026-09-16. Recommendation: retain **RT6150B-33GQW** and the Pico 2 power/control architecture. A missing stock CAD symbol is a library task, not an electrical reason to substitute a regulator. This review supports a native candidate design; it does not assign a qualified output-current, thermal, EMI, or battery-safety rating to a new PCB.

## Primary evidence

| ID | Source | Identity / relevant pages |
| --- | --- | --- |
| R | [Richtek RT6150A/B datasheet](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf) | DS6150A/B-06, July 2018; current manufacturer's product-page link; pp.2,4-7,9-13 |
| P | [Raspberry Pi Pico 2 datasheet](https://pip-assets.raspberrypi.com/categories/1005-raspberry-pi-pico-2/documents/RP-008299-DS-3-pico-2-datasheet.pdf) | Release 5, 2026-07-03; printed pp.9,14-18,20 |
| K | [RP2350A Minimal native KiCad](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-010328-CA-1-RP2350A%20Minimal%20KiCAD.zip) | R4-S1, dated 2026-07-03; schematic pin-type/text inspection only |
| T | [TI TPS63030/TPS63031 datasheet](https://www.ti.com/lit/ds/symlink/tps63031.pdf) | SLVS696D, revised April 2020; pp.1,3-5,9-12,17 |
| Q | [Diodes DMG1012T datasheet](https://www.diodes.com/datasheet/download/DMG1012T.pdf) | DS31783 Rev.8-2, February 2022; pp.1-2 |
| E | [KiCad 10 Schematic Editor manual](https://docs.kicad.org/10.0/en/eeschema/eeschema.html) | Power pins/power flags and pin electrical types |

R and T are archived outside the repository under `../rp2350-reference-inputs-01/power/`; SHA-256:

```text
RT6150AB-06.pdf       6a211238810773979ca1ccc577f9184f07c48ceb77bdf3707c4d469253f4045e
TPS63031-SLVS696D.pdf 7332b6b39605281419571ff4564e6bda5217dbaa2458b77b130bb81956d20a54
```

## Selected topology and pin mapping

Power path: USB VBUS -> Schottky D1 -> VSYS -> RT6150B-33 -> 3V3 -> RP2350 supplies, flash and 3V3 header output. The RP2350's separate internal buck generates 1V1 from 3V3. Keep the two converters' inductors, switch nodes and feedback nets distinct.

| RT6150B-33GQW pin | Connection |
| --- | --- |
| 1 VOUT | 3V3; local output capacitor |
| 2 LX2 and 4 LX1 | Opposite ends of the external 2.2 uH inductor |
| 3 GND, 9 GND, 11 exposed pad | GND with short power return and solid exposed-pad connection |
| 5 VIN, 8 VINA | VSYS; local input decoupling |
| 6 EN | Pico header pin 37, `3V3_EN`; 100 kohm pullup to VSYS |
| 7 PS | GPIO23; 100 kohm pulldown to GND |
| 10 FB | Direct quiet sense connection to VOUT/output capacitor; **no divider for the -33 fixed-output part** |

Package is WDFN-10L 2.5 x 2.5 mm with exposed pad. The RT6150A 3 x 3 mm footprint is different. Manufacturer pin map and dimensions must govern the new library entry. [R pp.1-2,13]

EN high enables; EN low shuts down switching and disconnects the load from the input. EN/PS logic limits are high >=1.2 V, low <=0.4 V. PS low permits power-save/PFM at light loads; PS high forces fixed-frequency PWM. Preserve the default pulldown, not a floating mode pin. Header 37 is pulled to **VSYS**, which can exceed 3.3 V; it is an open-drain/short-to-ground disable interface, not an ordinary 3.3 V GPIO net. [R pp.5,9; P p.15]

## Passives and current/thermal bounds

Pico 2 reference components: D1 **PMEG6010ELR**, L1 **2.2 uH**, C1/C2 **47 uF, 6.3 V, X5R, +/-20%, 0805**. The inspected Pico schematic does not name the inductor or capacitor MPNs, so these are not a complete orderable passive BOM. [P p.20]

Richtek recommends an inductor between 1.5 and 4.7 uH; its 2.2 uH example uses 3.3 V output and 1.8-4.2 V input. Calculate ripple at the actual extremes using the minimum 0.8 MHz switching frequency and the minimum effective inductance. Its input recommendation is at least 10 uF near VIN/GND; output guidance recommends at least 10 uF X7R/1206 and its example uses 20 uF. Pico's 47 uF X5R/0805 selection is a separate reference implementation, not a waiver of effective-capacitance and transient checks. [R pp.4,6,10]

Two concrete **candidate** passive MPNs illustrate choices if more area is acceptable; neither is claimed to be Pico 2's actual BOM:

- [Coilcraft XFL4020-222MEC](https://www.coilcraft.com/en-us/products/power/shielded-inductors/molded-inductor/xfl/xfl4020/xfl4020-222/): 2.2 uH +/-20%, DCR <=23.5 milliohm at 25 C; inductance-drop currents 3.1/3.5/3.7 A at 10/20/30% drop. It is larger than a compact Pico inductor. Temperature, ripple losses and actual peak current still govern selection. The smaller [XFL3012-222MEC](https://www.coilcraft.com/en-us/products/power/shielded-inductors/molded-inductor/xfl/xfl3012/xfl3012-222/) reaches 20% inductance loss at 1.3 A and 30% at 1.6 A; do not choose it just because its nominal current label appears adequate.
- [TDK C3225X5R1A476M250AC](https://product.tdk.com/en/search/capacitor/ceramic/mlcc/info?part_no=C3225X5R1A476M250AC): 47 uF +/-20%, 10 V, X5R, 1210, production status on the manufacturer page. It gives more voltage-rating headroom than the reference's 6.3 V 0805 part, at a size cost. **Effective capacitance remains unresolved:** the manufacturer [characteristic sheet](https://product.tdk.com/info/en/documents/chara_sheet/C3225X5R1A476M250AC_200213.pdf) was blocked by the server during retrieval, so no numeric DC-bias retention is asserted. Before freezing the BOM, establish effective capacitance at 5.5 V input and 3.3 V output including tolerance, temperature and aging; a nominal 47 uF label is not that evidence.

The operating input range is 1.8-5.5 V. The advertised 800 mA is **not a guaranteed all-input-range board load**. R p.7's typical maximum-output graph reads approximately 350 mA total near 1.8 V, using 3.3 V output, 20 uF and forced PWM; this is a graph estimate, not a guaranteed limit. P p.9 recommends external 3V3 load below 300 mA and explicitly makes available current depend on RP2350 load and VSYS. Therefore retain 300 mA only as the reference recommendation, with an input/load-dependent new-board budget:

`I_3V3,total = I_external + I_RP2350_IO/analog + I_flash + I_LED/other + P_core/(3.3 V * eta_core)`.

Do not promise 300 mA external at 1.8 V. Even at higher VSYS, that budget remains a design target until electrical evidence exists. R's switch-current limit is specified as minimum 1.6 A at VIN=3.6 V, with no maximum in that row; it cannot be used as a guaranteed upper bound for inductor fault-current sizing. The 40.9 C/W thermal number is measured on a JEDEC **four-layer** test board; do not use it as a measured thermal resistance of this candidate two-layer board. Normal junction range ends at 125 C. [R pp.4-5,10-11]

Place CIN/COUT close to the respective IC pins, keep high-current paths short/wide, minimize both LX nodes, and take FB from COUT through quiet copper. Connect ground pins and exposed pad to the ground plane. These are regulator requirements in addition to the RP2350 core-buck geometry. [R p.11]

## Multiple supplies, VBUS sensing and ADC isolation

- D1 permits external VSYS to supply the board without feeding USB VBUS backward through that diode. D1 **does not isolate a directly attached external VSYS supply from USB-derived VSYS**. Simultaneous USB plus an external source needs a second blocking diode, a suitable power-path circuit, or the P-channel MOSFET arrangement in P pp.16-17. A raw cell directly tied to VSYS can be driven by USB through D1; this is not a battery charger.
- Keep VBUS and VSYS separate. P p.15 permits shorting them only when USB is the sole supply. USB-host mode needs a deliberate 5 V VBUS source; the 3V3 converter does not provide USB host power. For this USB-device board, make host power an unsupported configuration unless separately designed.
- Do not assume shutdown load-disconnect means arbitrary 3V3 backfeeding or parallel regulated outputs is qualified. Preserve 3V3 as an output by default. External 3V3 injection needs a separate operating-state review, including regulator EN and other attached supplies.
- GPIO24 VBUS sense: **5.6 kohm from VBUS to GP24**, **10 kohm GP24 to GND**. At 5.5 V this divider is about 3.53 V (calculation). RP2350 GP24 is a fault-tolerant digital pin; do not move this function to an ADC pin. These resistors also discharge the VBUS sense node when USB is absent. [P p.20; RP2350 datasheet FT limits]
- GPIO29 VSYS sense: **R5=100 kohm VSYS-to-node**, **R6=100 kohm node-to-GND**, **C3=1 nF node-to-GND**, **DMG1012T** drain pin 3 at that node, source pin 2 at GP29, gate pin 1 at 3V3, and **R16=100 kohm GP29-to-GND**. When enabled, R6 and R16 are effectively parallel, giving VSYS/3. When 3V3 is off, the FET isolates the ADC pin; its body-diode orientation blocks the divider-to-ADC path. Omitting R16 changes the division ratio; reversing source/drain defeats the intended off-state isolation. [P p.20; Q pp.1-2]
- ADC_VREF/header 35: the **actual schematic** is **3V3 -> R7 200 ohm -> ADC_VREF/header35 -> R9 1 ohm -> ADC_AVDD/pin44**, with **C13 4.7 uF, 6.3 V, X5R, +/-20%, 0402** from ADC_AVDD to GND. The nearby C6 100 nF decouples the unfiltered IOVDD rail, not ADC_AVDD. **Source inconsistency:** P p.14's prose says 201 ohm into 2.2 uF, but the same PDF's schematic p.20 says 4.7 uF. Prefer the explicitly inspected schematic value for this candidate and record the discrepancy. The prose also calls out approximately 30 mV current-dependent offset from the simple reference filter; it is not a precision reference. External-reference use must not create an uncontrolled supply fight.

## Why not TPS63030/TPS63031 by default?

| Choice | Real tradeoff |
| --- | --- |
| RT6150B-33GQW | Matches Pico 2's documented hardware behavior, fixed 3.3 V, 1 MHz nominal, 60 uA typical power-save quiescent current. Selected baseline |
| TPS63031 | Credible alternative if lower standby current or a sourcing constraint warrants revalidation: 25 uA typical, 2.4 MHz nominal; 800 mA headline at VIN 3.6-5.5 V, up to 500 mA for VIN >2.4 V. It does not establish 300 mA external at minimum VIN automatically |
| TPS63030 | Adjustable output requires feedback resistors; no electrical benefit for this fixed-3.3 V Pico-compatible baseline has been established |

TI's reference uses 1.5 uH, 10 uF input, two 10 uF output and 100 nF VINA decoupling. TPS63031 FB also directly senses VOUT, with similar numbered signals, but package land pattern, loop behavior, start-up and passives still need their own review; it is not an approved drop-in. TI's startup threshold has a 2.0 V maximum over the full temperature range in its electrical table, despite the 1.8 V operating-range headline. Do not use an availability/library match as evidence of equivalence. [T pp.3-5,10-12]

## Native reference ERC annotations

These are facts from **K's embedded symbols**, not results of an ERC run:

| Native item | Electrical type / significance |
| --- | --- |
| RP2350 U1 pin48 VREG_LX | `power_out`, supplying the switch node |
| U1 pin49 VIN, pin46 AVDD, pins6/23/39 DVDD, pin47 PGND and pin61 GND | `power_in` |
| U1 pin50 FB | `passive` |
| U2 NCP1117 pin3 IN, pin1 GND | `power_in` |
| U2 pins2/4 OUT | `power_out` on +3V3 |
| USB J1 pin1 VCC and pin5 GND | `power_out` in this reference, explicitly modeling external supply/return |
| L1 ends and R3 ends | `passive`; LX -> L1 -> 1V1, and 3V3 -> R3 -> AVDD remain separate nets |
| `RPI - Power:PWR_NET` | Global power symbol with a **power_in** pin: names/connects rails, does not declare a source |
| Independent PWR_FLAGs | None present in this reference schematic |

Source recognition does not pass through an inductor, diode or resistor merely because its DC circuit can deliver power. A legitimate `PWR_FLAG` asserts a separately reviewed source path; it does not generate power or establish correct electrical operation. For the new board:

1. With ordinary passive connector symbols, assert known external VBUS supply and its GND return. VSYS after D1 may need its own justified source assertion because the diode interrupts ERC source recognition.
2. RT6150 VOUT should be modeled as the actual `power_out` for 3V3. Do not add unnecessary competing flags there.
3. A post-core-inductor 1V1 assertion is justified by the reviewed RP2350 LX/inductor/COUT/FB circuit. Post-filter VREG_AVDD and ADC_AVDD assertions are justified by their actual 3V3 resistor paths. Keep filters and inductors passive and all nets distinct.
4. Record the upstream source, intervening components and operating assumptions with each derived-rail assertion. **Do not describe internally generated rails as external power inputs** just to satisfy a tool schema; an external-only assertion mechanism would need explicit derived-rail support.
5. Preserve strict ERC. The official reference's missing downstream flags do not establish that default ERC passes, and no ERC was run here. A flag must never hide an unconnected upstream net, reversed diode, absent ground, or incorrect regulator pin/feedback connection.

Outstanding before a final electrical rating: exact RT6150 footprint verification, passive MPN/bias evidence, permitted supply combinations and the worst-case current/thermal budget. These are bounded design decisions; no firmware, manufacturing or physical qualification campaign was started.

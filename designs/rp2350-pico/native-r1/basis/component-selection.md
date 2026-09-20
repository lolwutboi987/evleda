# RP2350 Pico-like component selection

Reviewed 2026-09-17. This selection overlay covers **49 existing refs**: C1-C26, R1-R20, L1/L2 and D2. The source inventory remains **62 entities, 65 nets and two NC terminals**. No circuit, native CAD, configuration or library files were changed. Machine-readable candidates, source URLs, conditions and observed stock-footprint fingerprints are in [component-selection.json](component-selection.json).

These are concrete engineering candidates, **not a qualified or procurement-ready BOM**. The reference parts below retain exact MPNs recovered from Raspberry Pi's official Minimal native schematic. Its manufacturer fields are stronger provenance than a generic value/package match, but do not guarantee electrical behavior under every operating condition.

## Selected capacitors, inductors and LED

| Refs | Selected candidate MPN | Ratings/package | Stock footprint candidate / disposition |
| --- | --- | --- | --- |
| C1-C4, C17, C19 | Murata **GRM155R60J475ME47D** | 4.7 uF, 20%, 6.3 V, X5R, 0402 | `Capacitor_SMD:C_0402_1005Metric`; exact reference MPN; effective C/ESR/ESL open |
| C5-C16, C18, C22, C26 | Murata **GRM155R71E104KE14D** | 100 nF, 10%, 25 V, X7R, 0402 | `Capacitor_SMD:C_0402_1005Metric`; reference MPN extended to every existing local bypass |
| C20, C21 | TDK **C3225X5R1A476M250AC** | 47 uF, 20%, 10 V, X5R, 1210 | `Capacitor_SMD:C_1210_3225Metric`; conditional, with land-pattern discrepancy below |
| C23 | TDK **C1005X7R1H102K050BA** | 1 nF, 10%, 50 V, X7R, 0402 | `Capacitor_SMD:C_0402_1005Metric`; same capacitance, increased voltage rating |
| C24, C25 | Murata **GRM1555C1H150JA01D** | 15 pF, 5%, 50 V, C0G, 0402 | `Capacitor_SMD:C_0402_1005Metric`; exact reference MPN |
| L1 | Abracon **AOTA-B201610S3R3-101-T** | 3.3 uH, reference marked inductor | Carry existing `EvlEDA_Pico2350:AOTA-B201610S3R3-101-T_RaspberryPi_Minimal`; pad1=1V1 marked end, pad2=CORE_LX |
| L2 | Coilcraft **XFL4020-222MEC** | 2.2 uH, 20%, 4.0 +/-0.3 mm square, 2.10 mm maximum height | `Inductor_SMD:L_Coilcraft_XxL4020`; pad1=RT_LX1, pad2=RT_LX2 |
| D2 | Kingbright **APT1608CGCK** | Green, 570 nm typical, 0603, 0.75 mm nominal height | `LED_SMD:LED_0603_1608Metric`; pad1=K/GND, pad2=A/LED_A; preserve assembly polarity |

The [official native reference](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-010328-CA-1-RP2350A%20Minimal%20KiCAD.zip) provides the three Murata MPNs and four resistor values' exact MPNs. The [Murata 100 nF page](https://www.murata.com/ja-jp/products/productdetail?partno=GRM155R71E104KE14%23) confirms its electrical/package specifications. Current direct Murata 4.7 uF and 15 pF pages did not expose usable detailed characteristic data here; their reference selection is retained, not substituted with invented vendor limits. [TDK's 1 nF page](https://product.tdk.com/en/search/capacitor/ceramic/mlcc/info?part_no=C1005X7R1H102K050BA) reports the selected 50 V part in production; the initially considered 25 V version is NRND.

## Resistors

All candidates use `Resistor_SMD:R_0402_1005Metric`, 1% tolerance and a 50 V working-voltage **ceiling**. The manufacturer sheets list 0.063 W at 70 C; use **0.0625 W conservatively** because this family is conventionally 1/16 W. This rounds to the source inventory's proposed 63 mW; if that requirement means strictly at least 63.000 mW, the rounding does not establish compliance. All except R17 specify +/-100 ppm/C; the 1 ohm R17 specifies +/-200 ppm/C.

| Refs | Value | Exact Yageo MPN / manufacturer sheet |
| --- | --- | --- |
| R1, R2 | 27 ohm | [RC0402FR-0727RL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-0727RL) |
| R3, R4 | 5.1 kohm | [RC0402FR-075K1L](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-075K1L) |
| R5, R7 | 1 kohm | [RC0402FR-071KL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-071KL) |
| R6, R12 | 10 kohm | [RC0402FR-0710KL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-0710KL) |
| R8 | 33 ohm | [RC0402FR-0733RL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-0733RL) |
| R9, R10, R13-R15 | 100 kohm | [RC0402FR-07100KL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-07100KL) |
| R11 | 5.6 kohm | [RC0402FR-075K6L](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-075K6L) |
| R16 | 200 ohm | [RC0402FR-07200RL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-07200RL) |
| R17 | 1 ohm | [RC0402FR-071RL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-071RL) |
| R18 | 470 ohm | [RC0402FR-07470RL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-07470RL) |
| R19, R20 | 100 ohm | [RC0402FR-07100RL](https://www.yageogroup.com/component-documentation/download/specsheet/RC0402FR-07100RL) |

Apply actual hot-power derating and the lower of 50 V and `sqrt(P_allowed * R)`. A 1 ohm resistor cannot dissipate 50 V continuously. The 3.6 V rail with a shorted LED gives a screening R18 load of 27.9 mW at its 1%-low resistance, before TCR; ordinary LED loading is lower. R16's 200 ohm filter is not a protected power output: an ADC_VREF short at 3.6 V can exceed 1/16 W. Existing externally accessible debug/ADC paths still need permissible-load and contention conditions; these parts are not selected as fault-proof fuses.

## L2 current and inductance margin

The [Coilcraft datasheet](https://www.coilcraft.com/getmedia/50632d43-da1b-4cdb-8ab4-3029cab51df3/xfl4020.pdf) specifies DCR <=23.5 milliohm at 25 C and publishes 3.1/3.5/3.7 A for 10/20/30% inductance drop at 25 C. Its 6/8 A thermal-rise currents are reference data, not absolute maximum operating ratings. Maximum part temperature is 165 C. These distinctions are preserved in JSON rather than collapsed into one misleading current rating.

For **screening**, assume `L_eff = 2.2 uH * 0.8 * 0.9 = 1.584 uH` and Richtek's minimum 0.8 MHz. Ideal steady-state ripple is approximately 0.646 A peak-to-peak at 1.8 V boost input and 1.042 A at 5.5 V buck input. A deliberately explicit example of **300 mA total** output at 1.8 V and assumed 80% efficiency gives 0.688 A average and 1.01 A peak inductor current. This is a load example, not a promise of 300 mA external output. The 10% rolloff assumption is not a guaranteed hot inductance bound; at 20% rolloff the same tolerance stack gives 1.408 uH, below the 1.5 uH recommended nominal-range floor.

The [RT6150 datasheet](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf) gives **minimum** current limit 1.6 A at VIN=3.6 V with no maximum. Thus no guaranteed fault-current margin follows from that row. Resolve startup, shorts, mode transitions, low-input efficiency, peak current and hot rolloff before assigning a board current rating. The selected L2 has comfortable published 25 C margin for the example, and its stock pads (0.98 x 3.4 mm at x=+/-1.185 mm) match Coilcraft's listed land dimensions. The winding mark indicates the short lead; both terminals switch in this buck-boost circuit, so the generic stock pad number alone does not establish an EMI-optimal winding orientation.

## Bulk capacitance, voltage and fit

[TDK's 47 uF part](https://product.tdk.com/en/search/capacitor/ceramic/mlcc/info?part_no=C3225X5R1A476M250AC) is a conditional 1210 selection for C20/C21, retaining the Pico value while increasing rating from 6.3 V to 10 V. At 5.5 V DC it uses 55% of rated voltage, versus 87.3% for 6.3 V. Output screening uses 3.6 V, the shared-rail ceiling, as well as nominal 3.3 V. This headroom does not establish effective capacitance or clamp hot-plug overshoot.

Richtek recommends at least 10 uF input and 10 uF X7R/1206 output; Pico instead uses 47 uF X5R/0805. The proposed X5R part follows the Pico dielectric/value family, with separate stability/transient acceptance required. A preliminary multiplicative screen is `47 * 0.8 * 0.85 * k_bias * k_aging >= 10 uF`, requiring combined bias/aging retention >=0.313. This equation is an acceptance target, **not evidence that the part meets it**: the coupled bias/temperature behavior need not factor independently. The [characterization sheet](https://product.tdk.com/en/system/files/dam/doc/product/capacitor/ceramic/mlcc/charasheet/c3225x5r1a476m250ac_200213.pdf) could not be retrieved for numeric curve inspection; the manufacturer explicitly says characteristic graphs do not guarantee product performance. Guaranteed effective capacitances remain null.

The 1210 trade costs space and height on a 21 x 51 mm board. Maximum body size is 3.65 x 2.85 x 2.85 mm. **Do not admit the generic footprint automatically:** stock C_1210 has 1.80 mm inner gap and 2.70 mm pad width; TDK recommends PA=2.00-2.40 mm and PC=1.90-2.50 mm (PB=1.00-1.20 mm). Review land interpretation, solder/paste and assembly tolerance, or author a separately reviewed local footprint. No footprint edit is made here.

10 V capacitors do not relax RT6150 VIN's 5.5 V operating and 6 V absolute maximum limits. USB input inrush, permitted source combinations and rail overshoot remain open conditions from the circuit inputs.

## Core capacitors, crystal and indicator

Preserve the exact reference 4.7 uF 0402 group and core layout. C1's >=4.7 uF/ESR<=50 milliohm and C2's 4.7 uF +/-20%/ESR<=250 milliohm/ESL<=6 nH requirements are not independently discharged by the nominal BOM. Determine how the regulator requirements apply under bias and obtain suitable manufacturer/design evidence; do not increase C2 arbitrarily to compensate. C4 stays near DVDD23, C3 retains its quiet return, and C17/C19 retain their ADC/flash roles. X5R also constrains the candidate capacitor temperature envelope to 85 C; the MCU's wider range does not override it.

Two 15 pF C0G capacitors contribute nominally 7.5 pF in series, leaving about 2.5 pF of parasitics for the crystal's 10 pF load. That is a reference-layout target; final startup, drive and parasitics remain unverified.

The [green LED datasheet](https://www.kingbrightusa.com/images/catalog/SPEC/APT1608CGCK.pdf) specifies 2.1 V typical/2.5 V maximum VF and 20 mcd minimum brightness at **20 mA**. Using 2.1 V with 470 ohm gives a rough 2.55 mA example at 3.3 V, not a solved operating point. GPIO VOH, LED VF, temperature and drive strength affect actual current; brightness at this lower current has no established minimum here. The 3.6 V/1%-low-R bound is 7.74 mA even if D2 shorts; apply temperature effects and GPIO limits separately. Keep the existing 470 ohm value and check visual usability on a prototype.

## Verification boundary

JSON reference/value coverage and the source inventory hashes were checked. Installed stock footprints were inspected as text and fingerprinted; L1's existing reviewed local candidate was carried unchanged. These observations do not supply EvlEDA catalog admission or native acceptance. No build, native CAD generation, physical testing, firmware work or manufacturing output was performed.

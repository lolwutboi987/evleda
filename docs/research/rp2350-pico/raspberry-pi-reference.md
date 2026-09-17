# Raspberry Pi RP2350 / Pico 2 hardware reference

Research date: 2026-09-16. Scope: circuit and native-layout design inputs for an RP2350A Pico-like board. This is a source review, not a fabricated-board, firmware, signal-integrity, or manufacturing qualification. Page numbers below are printed page numbers; PDF viewer page numbers are one greater for the three main PDFs.

## Source identities

| ID | Primary source | Inspected identity |
| --- | --- | --- |
| H | [Hardware design with RP2350](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008280-DS-2-hardware-design-with-rp2350.pdf) | Release 3; build 2026-08-20, `06a7f75e58a1`; release history 2026-08-24; 25 PDF pages |
| D | [RP2350 datasheet](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008373-DS-2-rp2350-datasheet.pdf) | Build 2025-07-29, `d126e9e-clean`; 1380 PDF pages; includes A4 and errata |
| P | [Pico 2 datasheet](https://pip-assets.raspberrypi.com/categories/1005-raspberry-pi-pico-2/documents/RP-008299-DS-3-pico-2-datasheet.pdf) | Release 5; build 2026-07-03, `d4e0f1799616`; 24 PDF pages; schematic Appendix B p.20, component locations Appendix C p.21 |
| K | [RP2350A Minimal KiCad ZIP](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-010328-CA-1-RP2350A%20Minimal%20KiCAD.zip) | `RPI-RP2350A-MINIMAL_R4-S1_public`; native PCB title date 2026-07-03; KiCad 10 format; MIT license copyright Raspberry Pi 2026 |
| C28 | [RP235x A4 stepping PCN 28](https://pip-assets.raspberrypi.com/categories/1263-pcn/documents/RP-008771-CC/RP235x-A4-stepping-PCN) | Release 2, 2025-07-29; notification 2025-06-01; printed pp.2-4 |
| C32 | [Pico 2 products moving to A4 PCN 32](https://pip-assets.raspberrypi.com/categories/1262-pcn/documents/RP-008978-PC-1-Pico%202%20Products%20Moving%20to%20RP2350%20A4%20Silicon%20Stepping.pdf) | Release 1, 2025-07-21; notification 2025-07-01; printed pp.2-3 |

Live document discovery used the official [RP2350 portal](https://pip.raspberrypi.com/categories/1214-rp2350) and [Pico 2 portal](https://pip.raspberrypi.com/categories/1005-raspberry-pi-pico-2). Their upload dates differ from document build dates. H, D, P, and K were downloaded outside the repository to `../rp2350-reference-inputs-01/raspberry-pi/`. SHA-256 identities:

```text
H  cef88bc7d87e67b4262ee15f2b94b03566667143f4e8daf6931828bef6408059
D  2877d0f270fb6d6a57943bee58aaad536aa027bea1e5b1c4ce2541a3230d4be8
P  cbcfaf881018c686495a2e53c7bd281e7e0a8217d79447d73eda7c8f74b7f675
K  c0b858d78f56fa271a827064198e8ee81e4ec246234ce6659be8a1fcd877d06b
```

In the following sections, **required** means a datasheet limit or explicit circuit/layout requirement; **reference** means Raspberry Pi's chosen implementation; **proposal** is a project choice requiring acceptance in the board requirements.

## Package and electrical connections

RP2350A has 30 GPIO, of which GPIO26-29 have ADC capability, and no internal flash. Its 7 x 7 mm QFN-60 has 0.4 mm pitch and a central ground exposed pad. It is not pin-compatible with RP2040. The schematic/footprint must model 60 perimeter pins plus GND pad 61. [H pp.3-4; D §§1.2, 14.8; K U1]

| Function | RP2350A pins | Intended connection at 3.3 V I/O |
| --- | --- | --- |
| IOVDD | 1, 11, 20, 30, 38, 45 | 3V3, local decoupling |
| DVDD | 6, 23, 39 | Core regulator output, nominal 1V1 |
| QSPI_IOVDD | 54 | 3V3 for selected 3.3 V flash |
| USB_OTP_VDD | 53 | 3V3; this supply must always be provided, including when USB is unused [D p.442] |
| ADC_AVDD | 44 | ADC supply/reference, preferably filtered 3V3 |
| VREG_AVDD / PGND / LX / VIN / FB | 46 / 47 / 48 / 49 / 50 | Filtered 3V3 / GND / inductor switch node / 3V3 / output-capacitor sense |
| QSPI_SD3 / SCLK / SD0 / SD2 / SD1 / SS | 55 / 56 / 57 / 58 / 59 / 60 | Flash IO3 / CLK / IO0 / IO2 / IO1 / CS |
| USB_DM / USB_DP | 51 / 52 | Connector D- / D+ through separate 27 ohm resistors |
| XIN / XOUT | 21 / 22 | Crystal network |
| SWCLK / SWDIO / RUN | 24 / 25 / 26 | Debug / debug / active-low reset |
| Exposed pad | 61 in native design | GND plane; do not leave floating |

Pin map cross-checked against H full schematic p.20 and K U1. **Source inconsistency:** D Table 1432 p.1338 lists IOVDD as including 54 and omits 1, while separately naming 54 QSPI_IOVDD. The pinout drawing, H schematic, and K native pads distinguish pin 1 IOVDD from pin 54 QSPI_IOVDD; use that distinction, not the inconsistent summary-table row.

Required supply ranges from D Table 1441, pp.1343-1344: DVDD 1.05-1.16 V (nominal 1.1 V), IOVDD and RP2350 QSPI_IOVDD 1.62-3.63 V, USB_OTP_VDD and VREG_AVDD 3.135-3.63 V, VREG_VIN 2.7-5.5 V, ADC_AVDD 1.62-3.63 V with degraded ADC performance below 2.97 V. These ranges do not authorize using a 1.8 V crystal network copied from the 3.3 V reference. VREG_VIN and VREG_AVDD should power up together; other rails permit independent sequencing, with ADC transient-current caveats. [D §6.1.8 p.443]

K's ground-pad implementation is a reference choice: 3.4 x 3.4 mm top copper plus nine 0.25 mm drilled / 0.6 mm diameter GND vias on a 1.2 mm grid. All share pad number 61. Its explicit via implementation differs from a footprint containing only the exposed copper/paste pads; connectivity and ground return must be designed, not assumed from the footprint name.

## Core regulator: preserve the circuit and local geometry

The internal regulator starts at nominal 1.1 V and supports up to 200 mA in normal mode. It is a switching regulator requiring external components, not an RP2040-style two-capacitor LDO. Place this circuit first. [D §§6.3, 6.3.8 pp.448-456; H pp.5-7]

| Element | Required constraint / reference selection |
| --- | --- |
| L, VREG_LX to 1V1 | Fully shielded 3.3 uH +/-20%; DCR <=250 milliohm; saturation current >=1.5 A; polarity marked. Recommended MPN **Abracon AOTA-B201610S3R3-101-T**, 2.0 x 1.6 mm |
| CIN, VIN to GND | >=4.7 uF, ESR <=50 milliohm; reference 4.7 uF, 0402, 6.3 V, X5R, +/-20% |
| COUT, 1V1 to GND | 4.7 uF +/-20%, ESR <=250 milliohm, ESL <=6 nH; reference same capacitor size/rating |
| VREG_AVDD filter | 3V3 -> 33 ohm -> AVDD, with 4.7 uF AVDD-to-GND; separate quiet return |
| Additional core bulk | D p.455 recommends another 4.7 uF at DVDD pin 23, away from L/COUT; retain this even though the Minimal guide's decoupling discussion emphasizes 100 nF |

Do not infer interchangeable inductor orientation from a symmetric two-pad footprint. In H Figure 4 p.6 and K, marked **pad 1 goes to 1V1**, pad 2 to VREG_LX. Preserve the mark's orientation relative to COUT as well as the net assignment.

Required layout points from D pp.454-455: CIN/L/COUT remain on the RP2350 side; keep switching-current loops short, low impedance, and locally contained; return high-current GND to the exposed-pad ground at one local connection using adjacent vias; give the AVDD filter capacitor a separate quiet ground return; sense FB at COUT, avoiding the inductor underside; place COUT between VREG_VIN and VREG_PGND as close to the pins as possible; minimize LX copper and remove extra top copper under the inductor. On four-or-more-layer boards, also clear copper immediately under the LX/inductor switch node on the adjacent layer. Four layers do not remove these constraints.

Exact **reference coordinates**, obtained by text inspection of K without running KiCad, are useful for transferring the buck group. U1 is at (100, 100) mm, rotation 0; offsets below are relative to its center and use KiCad screen axes (+Y downward). They apply to K's actual footprints, not arbitrary replacement pad geometries.

| K reference | Offset X, Y (mm) | Rotation | Pad assignment |
| --- | --- | --- | --- |
| L1 | +2.00, -7.20 | 0 | 1:1V1, 2:LX |
| C7 / COUT | +2.00, -5.55 | 0 | 1:1V1, 2:GND |
| C6 / CIN | +2.00, -4.61 | 0 | 1:3V3, 2:GND |
| R3 / RFILT | +4.20, -6.90 | -90 | 1:3V3, 2:AVDD |
| C9 / CFILT | +4.20, -5.05 | -90 | 1:AVDD, 2:GND |
| Two switching GND vias | (+3.10,-5.50), (+3.10,-4.90) | n/a | GND, each drill 0.25 / diameter 0.60 mm |
| Quiet-filter GND via | +3.85, -3.85 | n/a | GND, drill 0.25 / diameter 0.60 mm |

C6/C7 use K's `generic_capc1005x50_wide` pad centers +/-0.515 mm; C9/R3 use +/-0.475 mm; L1 uses +/-0.7 mm. Coordinates alone omit the copper shapes and ground connections: transfer/review the whole circuit geometry. Keep K's MIT notice if copying substantial native design portions.

For other rails, the ordinary recommendation is 100 nF per supply pin placed close to the pin. H pp.8-9 explicitly shares one capacitor between pins 53/54 to fit the two-layer layout, and admits longer decoupling paths may limit performance. This is a reference compromise, not a rule requiring shared decoupling.

## Flash, clock, USB, boot and debug

| Block | Required / reference facts |
| --- | --- |
| Flash capacity and MPN | Pico 2 reference: **W25Q32RVXHJQ**, 32 Mbit / 4 MiB, with 100 nF + 4.7 uF local supply decoupling; inspected P p.20 schematic. Minimal K/H reference: **W25Q128JVSIQ**, 128 Mbit / 16 MiB; different package/capacity, not an automatic substitution |
| Flash wiring | Use short direct QSPI traces; do not interchange IO numbers. For the 8-pin reference flash: CS1, IO1=2, IO2=3, GND4, IO0=5, CLK6, IO3=7, VCC8. Pico's exposed flash pad9 is GND. Confirm against selected manufacturer's package before library acceptance |
| BOOTSEL | QSPI_SS -> 1 kohm -> normally open button -> GND. Keep current-limiting resistor. Provide a 10 kohm CS pullup footprint; reference leaves it unpopulated for demonstrated flash, but other flash power-up requirements may require it. Place associated branches near flash. [H pp.10-11] |
| Crystal | **Abracon ABM8-272-T3**, 12 MHz, 10 pF load, 50 ohm max ESR, +/-30 ppm; reference uses two 15 pF C0G capacitors and 1 kohm series damping on XOUT. Short local paths, grounded crystal case pads. This network is tuned for 3.3 V IOVDD. [H pp.13-14] |
| USB data | Required separate **27 ohm** series resistors near MCU. Internal USB pullups/pulldowns already exist; no extra speed-selection resistors. 12 Mbit/s FS. Target approximately **90 ohm differential** over uninterrupted GND. [H p.15; D Table1431] |
| USB protection | The inspected Raspberry Pi reference does not establish a required external TVS part or USB-C circuit. On-chip ESD ratings do not establish connector-level system ESD compliance. USB-C CC resistors, connector pin mapping, TVS choice/capacitance, and VBUS protection need separate primary-source selection if used |
| Reset | RUN is active-low with internal pullup (~50 kohm per P p.9); reset button to GND is a useful optional reference feature. Expose RUN even if omitting button. [H p.18] |
| SWD | Expose SWCLK, GND, SWDIO. Minimal's optional probe connector: **JST SM03B-SRSS-TB(LF)(SN)**. Pico's three-pin debug port has no power pin; debugger target voltage handling must be addressed separately. [H pp.17-18; P p.20] |

The minimal board's external input regulator is **NCP1117ST33T3G** with 10 uF input/output capacitors, powered from USB VBUS. This is a simplicity choice, not a Pico-compatible VSYS power architecture. Pico 2 uses **RT6150B-33GQW** buck-boost, 2.2 uH inductor, 47 uF input/output capacitors, and **PMEG6010ELR** VBUS-to-VSYS Schottky diode. These values/MPNs were read from P p.20; copying them still requires the regulator/inductor manufacturer's checks for the actual load and chosen parts.

Pico 2's inspected ADC schematic connects **3V3 -> R7 200 ohm -> ADC_VREF/header 35 -> R9 1 ohm -> ADC_AVDD/pin 44**, with **C13 4.7 uF** from ADC_AVDD to GND. **Source inconsistency:** P p.14's prose says 201 ohm into 2.2 uF, while the schematic on p.20 specifies C13 as 4.7 uF. Use the schematic's 4.7 uF value for this candidate and preserve the intermediate header-35 connection. The nearby C6 100 nF belongs to unfiltered IOVDD, not ADC_AVDD. Its GPIO29 VSYS divider includes a FET arrangement to prevent ADC-pin backpowering when 3V3 is disabled; preserve equivalent isolation for the same external-power behavior. [P pp.14-17, schematic p.20] The resolved power-netlist facts, including this discrepancy, are maintained in [power-selection.md](power-selection.md).

## Pico 2 mechanical and header compatibility

Reference outline: **51 x 21 mm, 1 mm PCB**, single-sided components; 40 main contacts at 2.54 mm pitch with 1 mm holes, two rows separated by **17.78 mm** (0.7 inch); four 2.1 mm mounting holes. Micro-USB overhang and castellations are reference choices. A USB-C connector may change overhang, keepouts and carrier fit even with an identical header map. [P p.7, Figure3]

| Left row: physical pin -> signal | Right row: physical pin -> signal |
| --- | --- |
| 1 GP0; 2 GP1; 3 GND; 4 GP2; 5 GP3 | 40 VBUS; 39 VSYS; 38 GND; 37 3V3_EN; 36 3V3 |
| 6 GP4; 7 GP5; 8 GND; 9 GP6; 10 GP7 | 35 ADC_VREF; 34 GP28/ADC2; 33 AGND; 32 GP27/ADC1; 31 GP26/ADC0 |
| 11 GP8; 12 GP9; 13 GND; 14 GP10; 15 GP11 | 30 RUN; 29 GP22; 28 GND; 27 GP21; 26 GP20 |
| 16 GP12; 17 GP13; 18 GND; 19 GP14; 20 GP15 | 25 GP19; 24 GP18; 23 GND; 22 GP17; 21 GP16 |

Pico reserves GP23 for SMPS mode, GP24 for VBUS detection, GP25 for LED, GP29/ADC3 for VSYS/3. GP0-22 and GP26-28 comprise the 26 external GPIO. P permits VSYS 1.8-5.5 V, VBUS nominal 5 V (+/-10%), and recommends external 3V3 load below 300 mA; those board-level limits only apply if the powerchain is preserved, not merely the connector names. 3V3_EN has a 100 kohm pullup to VSYS. [P pp.8-9,12,14]

## Layers and unresolved reference discrepancy

H p.4 explicitly implements the Minimal designs on two copper layers. K confirms only F.Cu and B.Cu. Thus four layers are **not universally required** for RP2350A. A two-layer Pico-like board is an engineering candidate if the buck group, exposed-pad ground, close decoupling, QSPI routing and continuous USB return can actually fit; that is a design inference, not qualification.

**Do not copy K's declared stackup as a validated USB solution:** H p.15 uses 1 mm PCB, 0.8 mm USB trace width and 0.15 mm pair gap for approximately 90 ohm. K instead declares 1.6 mm total, 1.51 mm FR4 core, epsilon_r 4.5, 35 um copper each side and 10 um masks. This mismatch is unresolved. P confirms Pico 2's 1 mm thickness; its full native layout/stackup was not obtained from the current public portal (the guessed historical Pico 2 design ZIP URL returned 404). Available Pico layout evidence here is its component-location drawing and D's local buck layout, not a full copper-layer audit.

Choose the stackup on routing/return-path needs. Four layers may simplify dense connector, protection and decoupling placement, but require the documented LX copper cutout and stackup-specific USB geometry. Tool support for two layers is not evidence that two layers meet these electrical conditions.

## Silicon, voltage policy and outstanding decisions

- **Proposal:** specify RP2350A **A4** and preserve stepping/marking traceability. C28 reports E9 fixed from A3. A2 E9 input leakage may defeat internal pulldowns; D pp.1366-1368 gives a <=8.2 kohm low-source-impedance workaround at 3.3 V. Do not apply that workaround indiscriminately to all A4 GPIO.
- A4 still has relevant errata. E12 requires active-USB `clk_sys` at least 10% faster than `clk_usb`; boot-ROM mitigation does not discharge application obligations. No firmware campaign is performed here. [D pp.1375-1376]
- Fault-tolerant digital GPIO0-25 and applicable debug/reset pins tolerate up to 5.5 V only with IOVDD at 3.3 V; the unpowered FT limit is 3.63 V. ADC-capable GPIO26-29 and QSPI are excluded. ADC inputs must stay within 0 to ADC_AVDD and must also not exceed IOVDD (even if ADC_AVDD is higher), or backpower an unpowered IOVDD rail. Do not label all board pins "5 V tolerant." [D p.442, pp.1335-1341; P p.14]
- Confirm whether "Pico-like" means exact 40-pin function compatibility including VSYS, 3V3_EN, GPIO reservations, ADC_VREF and carrier mechanics, or only the outline/header arrangement.
- Decide 4 MiB Pico-reference flash versus 16 MiB Minimal-reference flash; lock full MPN, package, footprint and supply behavior. Decide USB connector/protection and permitted external-power combinations before freezing the netlist.
- Lock exact core-inductor MPN/orientation and capacitor electrical parameters. Native ERC/DRC can establish connectivity/geometry rules but cannot establish buck transient stability, crystal startup, impedance or system ESD performance.

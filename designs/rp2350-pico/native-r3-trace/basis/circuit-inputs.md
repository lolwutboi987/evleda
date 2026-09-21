# RP2350 Pico-like circuit inputs

Engineering input reviewed 2026-09-17. This is an original component-reference and connection inventory, **not a compiler bundle or completed native board**. [circuit-inputs.json](circuit-inputs.json) contains every terminal, net endpoint, source reference and open decision.

**62 component/connector entities, 65 nets, 2 intentionally NC terminals.** The current 64-component limit leaves two entities. The count includes both 20-contact header footprints, all proposed passives, separate MCU supply decouplers, additional DVDD23 bulk capacitance, and the ESD VBUS capacitor. No required decoupling was omitted to fit. Ground vias/mounting holes are board features; ERC source assertions are not physical BOM parts. Actual compiler accounting still needs checking.

## Circuit and numbering

Use RP2350A with A4 procurement traceability, W25Q32RVXHJQ 4 MiB flash, RT6150B-33GQW, USB4105-GF-A as a USB device/sink, USBLC6-2SC6 protection, BOOT and RUN buttons, three-pin SWD and a GPIO25 green LED. There is no radio, RGB LED or touch circuitry.

J2 local pins 1-20 map to Pico pins 1-20 from top-left to bottom-left. J3 local pins 1-20 map to Pico pins 21-40 from bottom-right to top-right. The native footprints must respect this reversal. AGND/Pico33 is electrically GND with quiet ADC return placement, not an isolated ground rail.

| Ref | Part / function | Package or unresolved choice | Sources |
| --- | --- | --- | --- |
| U1 | RP2350A | QFN-60 plus EP, 7 x 7 mm, 0.4 mm pitch | D, H, P |
| U2 | RT6150B-33GQW | WDFN-10L 2.5 x 2.5 mm plus EP11 | R, P |
| U3 | W25Q32RVXHJQ | XH XSON-8, 2 x 3 x 0.4 mm plus center metal | W, P |
| U4 | USBLC6-2SC6 | SOT23-6L | ST |
| J1 | USB4105-GF-A | Horizontal top mount, 16 contacts, four shell stakes, two NPTH locators | G, CC |
| J2 | 20 Pico-compatible contacts | 1 x 20, 2.54 mm pitch; exact edge/header footprint unresolved | P |
| J3 | 20 Pico-compatible contacts | 1 x 20, 2.54 mm pitch; exact edge/header footprint unresolved | P |
| J4 | SWCLK / GND / SWDIO | 1 x 3, 2.54 mm pitch candidate | P |
| L1 | AOTA-B201610S3R3-101-T | 2016 metric, marked polarity | D, H, A, K |
| L2 | 2.2 uH | MPN/package unresolved | R, P |
| Q1 | DMG1012T-7 | SOT523 | Q, P |
| D1 | PMEG6010ELR | SOD123W / CFP3 | N, P |
| D2 | Green status LED | 0603 candidate | P |
| SW1 | 434133025816 | 4.2 x 3.2 mm J-bend SMT | H, SW |
| SW2 | 434133025816 | 4.2 x 3.2 mm J-bend SMT | H, SW |
| Y1 | ABM8-272-T3 | 3.2 x 2.5 x 0.8 mm four pad | H, X |

## MCU pin map

This follows the supplied current stock inspection. Several duplicate supply pins have a `passive` symbol type; every physical supply terminal is nevertheless explicitly connected and locally decoupled. JSON retains the observed types and source identities.

| U1 pin | Function | Net |
| --- | --- | --- |
| 1 | IOVDD | 3V3 |
| 2 | GPIO0 | GPIO0 |
| 3 | GPIO1 | GPIO1 |
| 4 | GPIO2 | GPIO2 |
| 5 | GPIO3 | GPIO3 |
| 6 | DVDD | 1V1 |
| 7 | GPIO4 | GPIO4 |
| 8 | GPIO5 | GPIO5 |
| 9 | GPIO6 | GPIO6 |
| 10 | GPIO7 | GPIO7 |
| 11 | IOVDD | 3V3 |
| 12 | GPIO8 | GPIO8 |
| 13 | GPIO9 | GPIO9 |
| 14 | GPIO10 | GPIO10 |
| 15 | GPIO11 | GPIO11 |
| 16 | GPIO12 | GPIO12 |
| 17 | GPIO13 | GPIO13 |
| 18 | GPIO14 | GPIO14 |
| 19 | GPIO15 | GPIO15 |
| 20 | IOVDD | 3V3 |
| 21 | XIN | XIN |
| 22 | XOUT | XOUT_MCU |
| 23 | DVDD | 1V1 |
| 24 | SWCLK | SWCLK_MCU |
| 25 | SWDIO | SWDIO_MCU |
| 26 | RUN | RUN |
| 27 | GPIO16 | GPIO16 |
| 28 | GPIO17 | GPIO17 |
| 29 | GPIO18 | GPIO18 |
| 30 | IOVDD | 3V3 |
| 31 | GPIO19 | GPIO19 |
| 32 | GPIO20 | GPIO20 |
| 33 | GPIO21 | GPIO21 |
| 34 | GPIO22 | GPIO22 |
| 35 | GPIO23 | GPIO23_SMPS_PS |
| 36 | GPIO24 | GPIO24_VBUS_SENSE |
| 37 | GPIO25 | GPIO25_LED |
| 38 | IOVDD | 3V3 |
| 39 | DVDD | 1V1 |
| 40 | GPIO26/ADC0 | GPIO26 |
| 41 | GPIO27/ADC1 | GPIO27 |
| 42 | GPIO28/ADC2 | GPIO28 |
| 43 | GPIO29/ADC3 | GPIO29_VSYS_SENSE |
| 44 | ADC_AVDD | ADC_AVDD |
| 45 | IOVDD | 3V3 |
| 46 | VREG_AVDD | VREG_AVDD |
| 47 | VREG_PGND | GND |
| 48 | VREG_LX | CORE_LX |
| 49 | VREG_VIN | 3V3 |
| 50 | VREG_FB | 1V1 |
| 51 | USB_DM | USB_DM_MCU |
| 52 | USB_DP | USB_DP_MCU |
| 53 | USB_OTP_VDD | 3V3 |
| 54 | QSPI_IOVDD | 3V3 |
| 55 | QSPI_SD3 | QSPI_SD3 |
| 56 | QSPI_SCLK | QSPI_SCLK |
| 57 | QSPI_SD0 | QSPI_SD0 |
| 58 | QSPI_SD2 | QSPI_SD2 |
| 59 | QSPI_SD1 | QSPI_SD1 |
| 60 | ~{QSPI_SS} | QSPI_CS |
| 61 | GND | GND |

## Other multi-terminal connections

| Ref | Pin-to-net mapping |
| --- | --- |
| U2 | 1 (VOUT) = 3V3; 2 (LX2) = RT_LX2; 3 (GND) = GND; 4 (LX1) = RT_LX1; 5 (VIN) = VSYS; 6 (EN) = 3V3_EN; 7 (PS) = GPIO23_SMPS_PS; 8 (VINA) = VSYS; 9 (GND) = GND; 10 (FB) = 3V3; 11 (GND_EP) = GND |
| U3 | 1 (/CS) = QSPI_CS; 2 (IO1) = QSPI_SD1; 3 (IO2 (QE fixed 1)) = QSPI_SD2; 4 (VSS) = GND; 5 (IO0) = QSPI_SD0; 6 (CLK) = QSPI_SCLK; 7 (IO3 (QE fixed 1)) = QSPI_SD3; 8 (VCC) = 3V3; 9 (Center metal (CAD pad9 convention)) = GND |
| U4 | 1 (IO1) = USB_DP_PORT; 2 (GND) = GND; 3 (IO2) = USB_DM_PORT; 4 (IO2) = USB_DM_PORT; 5 (VBUS) = VBUS; 6 (IO1) = USB_DP_PORT |
| J1 | A1 (GND) = GND; A4 (VBUS) = VBUS; A5 (CC1) = USB_CC1; A6 (D+) = USB_DP_PORT; A7 (D-) = USB_DM_PORT; A8 (SBU1) = NC: unused USB 2.0 SBU; A9 (VBUS) = VBUS; A12 (GND) = GND; B1 (GND) = GND; B4 (VBUS) = VBUS; B5 (CC2) = USB_CC2; B6 (D+) = USB_DP_PORT; B7 (D-) = USB_DM_PORT; B8 (SBU2) = NC: unused USB 2.0 SBU; B9 (VBUS) = VBUS; B12 (GND) = GND; SH (SHIELD) = GND |
| J2 | 1 (GPIO0) = GPIO0; 2 (GPIO1) = GPIO1; 3 (GND) = GND; 4 (GPIO2) = GPIO2; 5 (GPIO3) = GPIO3; 6 (GPIO4) = GPIO4; 7 (GPIO5) = GPIO5; 8 (GND) = GND; 9 (GPIO6) = GPIO6; 10 (GPIO7) = GPIO7; 11 (GPIO8) = GPIO8; 12 (GPIO9) = GPIO9; 13 (GND) = GND; 14 (GPIO10) = GPIO10; 15 (GPIO11) = GPIO11; 16 (GPIO12) = GPIO12; 17 (GPIO13) = GPIO13; 18 (GND) = GND; 19 (GPIO14) = GPIO14; 20 (GPIO15) = GPIO15 |
| J3 | 1 (GPIO16) = GPIO16; 2 (GPIO17) = GPIO17; 3 (GND) = GND; 4 (GPIO18) = GPIO18; 5 (GPIO19) = GPIO19; 6 (GPIO20) = GPIO20; 7 (GPIO21) = GPIO21; 8 (GND) = GND; 9 (GPIO22) = GPIO22; 10 (RUN) = RUN; 11 (GPIO26) = GPIO26; 12 (GPIO27) = GPIO27; 13 (AGND) = GND; 14 (GPIO28) = GPIO28; 15 (ADC_VREF) = ADC_VREF; 16 (3V3) = 3V3; 17 (3V3_EN) = 3V3_EN; 18 (GND) = GND; 19 (VSYS) = VSYS; 20 (VBUS) = VBUS |
| J4 | 1 (SWCLK) = SWCLK_HDR; 2 (GND) = GND; 3 (SWDIO) = SWDIO_HDR |
| L1 | 1 (Marked end) = 1V1; 2 (Switch end) = CORE_LX |
| L2 | 1 (End1) = RT_LX1; 2 (End2) = RT_LX2 |
| Q1 | 1 (G) = 3V3; 2 (S) = GPIO29_VSYS_SENSE; 3 (D) = VSYS_DIV |
| D1 | 1 (K) = VSYS; 2 (A) = VBUS |
| D2 | 1 (K) = GND; 2 (A) = LED_A |
| SW1 | 1 (ContactA) = GND; 2 (ContactA) = GND; 3 (ContactB) = BOOT_SW; 4 (ContactB) = BOOT_SW |
| SW2 | 1 (ContactA) = GND; 2 (ContactA) = GND; 3 (ContactB) = RUN; 4 (ContactB) = RUN |
| Y1 | 1 (Crystal1) = XIN; 2 (Case GND) = GND; 3 (Crystal2) = XTAL_OUT; 4 (Case GND) = GND |

**Flash package distinction:** Winbond Rev. E specifies eight numbered terminals in the XH XSON 2 x 3 x 0.4 mm package. The center metal is internally unconnected and may float or connect to GND. This board deliberately grounds it using CAD pad9; that number is a library convention, not a manufacturer pin9 designation. The Q suffix fixes QE=1, so pins3/7 are IO2/IO3, not independent WP/HOLD/RESET. Exact procurement and footprint acceptance remain open. [W pp.5-6,77,80-81]

**USB endpoint coverage:** U4 pins1/6 attach to USB_DP_PORT and pins3/4 to USB_DM_PORT. All four remain actual copper-network endpoints; an omitted pad or imagined segment through the protection package is unacceptable. Preserve both Type-C data contacts per polarity, every VBUS/GND contact, all four shell stakes and both locating holes.

## Resistor inventory

Proposed selection requirements are 1%, at least 63 mW, with 0402 as a package candidate. Full MPNs, working-voltage ratings and accepted footprints remain unresolved. Two-terminal numbering is an explicit passive CAD convention.

| Ref | Value | Pin1 -> pin2 | Function | Sources |
| --- | --- | --- | --- | --- |
| R1 | 27 ohm | USB_DP_MCU -> USB_DP_PORT | USB DP source termination | D, H |
| R2 | 27 ohm | USB_DM_MCU -> USB_DM_PORT | USB DM source termination | D, H |
| R3 | 5100 ohm | USB_CC1 -> GND | CC1 Rd | CC |
| R4 | 5100 ohm | USB_CC2 -> GND | CC2 Rd | CC |
| R5 | 1000 ohm | QSPI_CS -> BOOT_SW | BOOT current limit | H, P |
| R6 | 10000 ohm | 3V3 -> QSPI_CS | Normal-start flash CS pullup | H, W |
| R7 | 1000 ohm | XOUT_MCU -> XTAL_OUT | Crystal damping | H, P |
| R8 | 33 ohm | 3V3 -> VREG_AVDD | Core AVDD filter | D, H |
| R9 | 100000 ohm | VSYS -> 3V3_EN | Enable pullup | P |
| R10 | 100000 ohm | GPIO23_SMPS_PS -> GND | Default PFM pulldown | P |
| R11 | 5600 ohm | VBUS -> GPIO24_VBUS_SENSE | VBUS sense upper | P |
| R12 | 10000 ohm | GPIO24_VBUS_SENSE -> GND | VBUS sense lower/discharge | P |
| R13 | 100000 ohm | VSYS -> VSYS_DIV | VSYS sense upper | P |
| R14 | 100000 ohm | VSYS_DIV -> GND | VSYS sense lower1 | P |
| R15 | 100000 ohm | GPIO29_VSYS_SENSE -> GND | VSYS sense lower2 | P |
| R16 | 200 ohm | 3V3 -> ADC_VREF | ADC filter before header35 | P |
| R17 | 1 ohm | ADC_VREF -> ADC_AVDD | ADC filter after header35 | P |
| R18 | 470 ohm | GPIO25_LED -> LED_A | LED current limit | P |
| R19 | 100 ohm | SWCLK_MCU -> SWCLK_HDR | SWCLK series | P |
| R20 | 100 ohm | SWDIO_MCU -> SWDIO_HDR | SWDIO series | P |

R6 is populated at 10 kohm as the normal-power-up CS pullup. This is an explicit choice from the reference provision, not a claim that Pico populated it. Holding BOOT during cold power-up still conflicts with Winbond's literal CS-tracks-VCC instruction; a stable-powered BOOT + RUN reset avoids deliberate cold-start CS loading. Keep this integration question open rather than claiming a resistor settles it. [H pp.10-11; W pp.11,68]

## Capacitors and placement association

Every capacitor maps pin1 to the listed node and pin2 to GND. Values and rating families are reference choices or selection requirements, **not verified orderable MPNs**. Effective capacitance at bias/temperature/aging and native lands remain open.

| Ref | Value / rating family | Pin1 net | Associated pins / purpose | Sources |
| --- | --- | --- | --- | --- |
| C1 | 4.7 uF, 6.3 V, X5R, 20%, 0402 reference | 3V3 | U1.49; Core CIN | D, H |
| C2 | 4.7 uF, 6.3 V, X5R, 20%, 0402 reference | 1V1 | U1.50, U1.47; Core COUT / FB sense | D, H |
| C3 | 4.7 uF, 6.3 V, X5R, 20%, 0402 reference | VREG_AVDD | U1.46; Quiet core AVDD filter | D, H |
| C4 | 4.7 uF, 6.3 V, X5R, 20%, 0402 candidate | 1V1 | U1.23; Additional bulk at DVDD23 | D |
| C5 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.1; IOVDD1 decoupling | D, H |
| C6 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.11; IOVDD11 decoupling | D, H |
| C7 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.20; IOVDD20 decoupling | D, H |
| C8 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.30; IOVDD30 decoupling | D, H |
| C9 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.38; IOVDD38 decoupling | D, H |
| C10 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.45; IOVDD45 decoupling | D, H |
| C11 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 1V1 | U1.6; DVDD6 decoupling | D, H |
| C12 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 1V1 | U1.23; DVDD23 decoupling | D, H |
| C13 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 1V1 | U1.39; DVDD39 decoupling | D, H |
| C14 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.53; USB_OTP_VDD53 decoupling | D |
| C15 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U1.54; QSPI_IOVDD54 decoupling | D |
| C16 | 100 nF, 25 V, X7R, 10%, 0402 candidate | ADC_AVDD | U1.44; ADC44 local HF decoupling | D |
| C17 | 4.7 uF, 6.3 V, X5R, 20%, 0402 reference | ADC_AVDD | U1.44; ADC bulk; Pico schematic C13 | P |
| C18 | 100 nF, 25 V, X7R, 10%, 0402 candidate | 3V3 | U3.8; Flash VCC local HF | P, W |
| C19 | 4.7 uF, 6.3 V, X5R, 20%, 0402 reference | 3V3 | U3.8; Flash VCC bulk | P |
| C20 | 47 uF, 6.3 V, X5R, 20%, 0805 reference | VSYS | U2.5; RT input bulk | P, R |
| C21 | 47 uF, 6.3 V, X5R, 20%, 0805 reference | 3V3 | U2.1, U2.10; RT output bulk / FB sense | P, R |
| C22 | 100 nF, 25 V, X7R, 10%, 0402 candidate | VSYS | U2.8; RT VINA bypass (project choice) | R |
| C23 | 1 nF, 25 V, X7R, 10%, 0402 candidate | VSYS_DIV | Q1.3; VSYS sense filter | P |
| C24 | 15 pF, 50 V, C0G, 5%, 0402 reference | XIN | Y1.1, U1.21; Crystal input load | H, P |
| C25 | 15 pF, 50 V, C0G, 5%, 0402 reference | XTAL_OUT | Y1.3; Crystal output load | H, P |
| C26 | 100 nF, 25 V, X7R, 10%, 0402 candidate | VBUS | U4.5; USBLC6 VBUS bypass | ST |

C1/C2/C3/L1/R8 preserve the documented RP2350 core group, including marked inductor pad1=1V1 and pad2=CORE_LX. C1 requires ESR <=50 milliohm; C2 requires 4.7 uF +/-20%, ESR <=250 milliohm and ESL <=6 nH. C3 has its own quiet return. C4 stays by DVDD23 away from the switching group. The reference geometry is in [raspberry-pi-reference.md](../../../../docs/research/rp2350-pico/raspberry-pi-reference.md); center coordinates alone do not establish the copper/return topology.

C14 and C15 separately decouple USB_OTP_VDD53 and QSPI_IOVDD54 rather than relying on the Minimal shared-capacitor compromise. C16 follows the datasheet's local 100 nF ADC recommendation in addition to C17 bulk. C22 is an explicit additional local VINA bypass choice, not a Richtek requirement for exactly 100 nF. C26 follows ST Figure17.

## Forty header functions

| Pico pin | Local terminal | Function / net |
| --- | --- | --- |
| 1 | J2.1 | GPIO0 |
| 2 | J2.2 | GPIO1 |
| 3 | J2.3 | GND |
| 4 | J2.4 | GPIO2 |
| 5 | J2.5 | GPIO3 |
| 6 | J2.6 | GPIO4 |
| 7 | J2.7 | GPIO5 |
| 8 | J2.8 | GND |
| 9 | J2.9 | GPIO6 |
| 10 | J2.10 | GPIO7 |
| 11 | J2.11 | GPIO8 |
| 12 | J2.12 | GPIO9 |
| 13 | J2.13 | GND |
| 14 | J2.14 | GPIO10 |
| 15 | J2.15 | GPIO11 |
| 16 | J2.16 | GPIO12 |
| 17 | J2.17 | GPIO13 |
| 18 | J2.18 | GND |
| 19 | J2.19 | GPIO14 |
| 20 | J2.20 | GPIO15 |
| 21 | J3.1 | GPIO16 |
| 22 | J3.2 | GPIO17 |
| 23 | J3.3 | GND |
| 24 | J3.4 | GPIO18 |
| 25 | J3.5 | GPIO19 |
| 26 | J3.6 | GPIO20 |
| 27 | J3.7 | GPIO21 |
| 28 | J3.8 | GND |
| 29 | J3.9 | GPIO22 |
| 30 | J3.10 | RUN |
| 31 | J3.11 | GPIO26 |
| 32 | J3.12 | GPIO27 |
| 33 | J3.13 | AGND / GND |
| 34 | J3.14 | GPIO28 |
| 35 | J3.15 | ADC_VREF |
| 36 | J3.16 | 3V3 |
| 37 | J3.17 | 3V3_EN |
| 38 | J3.18 | GND |
| 39 | J3.19 | VSYS |
| 40 | J3.20 | VBUS |

## Power behavior and limits

- VBUS -> D1 -> VSYS -> U2 -> 3V3; U1/L1 then generate 1V1. The shared 3V3 rail must satisfy the combined 3.135-3.6 V range from RP2350 analog/USB and Winbond flash limits; nominal 3.3 V alone is not proof across loads/transients. EN/header37 pulls to VSYS through R9; ground disables. GPIO23 drives PS with a default pulldown. GPIO24 senses VBUS through R11/R12.
- GPIO29 senses VSYS through R13/R14/Q1/R15/C23. Q1 gate1=3V3, drain3=VSYS_DIV and source2=ADC input. The two 100 kohm lower legs combine when enabled to produce VSYS/3. Source/drain orientation provides off-state ADC isolation.
- ADC reference is **3V3 -> R16 200 ohm -> ADC_VREF/header35 -> R17 1 ohm -> ADC_AVDD44**, with C17=4.7 uF at pin44. Pico prose says 2.2 uF, but its schematic specifies 4.7 uF.
- VSYS 1.8-5.5 V is the reference range, not a new-board current guarantee. External 3V3 current is input/load-dependent. Pico recommends below 300 mA; Richtek's approximately 350 mA total near 1.8 V is only a typical graph estimate before onboard consumption.
- D1 blocks VSYS backfeeding VBUS. It does not block USB-derived VSYS from driving an attached external VSYS source. Simultaneous sources require external blocking/power-path circuitry; a directly attached raw cell is not an accepted combination. External 3V3 injection is unsupported by default.
- USB current entitlement, hot-plug/inrush and total input capacitance remain unqualified. Independent 5.1 kohm CC pulldowns configure attachment; they do not implement PD or authorize 3 A. There is no host VBUS source.

Legitimate derived-rail source assertions belong to later schematic authoring, not this BOM: VSYS after D1, 1V1 after L1, VREG_AVDD after R8, and ADC_AVDD after its filter. Keep physical passive components passive, preserve distinct nets, and never call an internal rail an external input. [power-selection.md](../../../../docs/research/rp2350-pico/power-selection.md) records the physical paths and ERC limits.

## Unresolved before native circuit acceptance

1. Exact passive MPNs and effective capacitor/inductor ratings; LED MPN/current/brightness and L2 package/current/rolloff. No material properties or current limits were filled from tool defaults.
2. Exact flash XH footprint/procurement, center-pad convention, and cold-BOOT sequencing. Winbond requires at least 20 us after minimum VCC before selection and at least 5 ms before write-related operations; firmware execution is outside this inventory task.
3. Remaining admitted symbols/footprints for flash, ESD, buttons, crystal, headers, Q1 and passives. Candidate IDs do not assert a successful native qualification.
4. Actual stackup, USB body/launch/branch geometry, full-channel connectivity and returns; both regulator loops; exposed-pad/via connections; connector edge fit and header mechanics.
5. USB source-current/inrush limits, connector protection and clamp compatibility, permitted power combinations, worst-case board current and thermal budget.

## Sources

Page references use printed pages unless explicitly labeled PDF pages.
- **D**: [RP2350 datasheet](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008373-DS-2-rp2350-datasheet.pdf). 2025-07-29 d126e9e-clean; 442-443, 448-456, 1335-1344.
- **H**: [Hardware design with RP2350](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008280-DS-2-hardware-design-with-rp2350.pdf). Release 3, 2026-08-20, 06a7f75e58a1; 5-8, 10-18, 20.
- **P**: [Pico 2 datasheet](https://pip-assets.raspberrypi.com/categories/1005-raspberry-pi-pico-2/documents/RP-008299-DS-3-pico-2-datasheet.pdf). Release 5, 2026-07-03, d4e0f1799616; 7-9, 14-18, 20.
- **R**: [Richtek RT6150A/B](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf). DS6150A/B-06, July 2018; 2, 4-7, 9-13.
- **W**: [Winbond W25Q32RV](https://www.winbond.com/resource-files/W25Q32RV_SPI_QPI%20RevE%2011132025%20Plus.pdf). Rev. E, 2025-11-13; 5-6 pinout/QE; 11 CS sequencing; 68 timing; 77 XH center pad; 80-81 ordering.
- **G**: [GCT USB4105](https://gct.co/files/drawings/usb4105.pdf). B4; Sheet 1.
- **ST**: [ST USBLC6-2](https://www.st.com/resource/en/datasheet/usblc6-2.pdf). DS4260 Rev. 7, December 2021; 1-2 pinout/specifications; 6 placement; 11 Figure 17 100 nF VBUS; 12-13 SOT23-6L.
- **CC**: [USB Type-C device hardware guidance](https://docs.espressif.com/projects/esp-iot-solution/en/latest/usb/usb_overview/usb_typec_hardware_guide.html). Current vendor guidance; Device configuration, independent CC pulldowns and USB 2.0 data contacts.
- **A**: [Abracon core inductor](https://abracon.com/datasheets/AOTA-B201610S3R3-101-T.pdf). Rev. A, 2024-09-13; 1, 4.
- **X**: [Abracon ABM8-272-T3](https://abracon.com/datasheets/ABM8-272-T3.pdf). Drawing 456603 Rev. B, 2024-09-16; Current 3-page PDF: PDF 1 electrical specifications (printed 2/9), PDF 2 mechanical pin map.
- **SW**: [Wurth 434133025816](https://www.we-online.com/components/products/datasheet/434133025816.pdf). 001.001, 2021-01-25; 1 contact pairs 1-2 and 3-4; 2 ratings.
- **Q**: [Diodes DMG1012T](https://www.diodes.com/datasheet/download/DMG1012T.pdf). DS31783 Rev. 8-2, February 2022; 1-2, compared with Pico schematic p.20.
- **N**: [Nexperia PMEG6010ELR](https://assets.nexperia.com/documents/data-sheet/PMEG6010ELR.pdf). 2023-01-01; 1 pin 1 K / pin 2 A; 2-4 rating conditions.
- **K**: [Raspberry Pi Minimal native design](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-010328-CA-1-RP2350A%20Minimal%20KiCAD.zip). R4-S1, 2026-07-03; Native schematic and core-regulator PCB group.

Verified here: structural/count checks, complete U1 coverage against the supplied stock snapshot, U2 pin functions against the custom v1 source, bijective 40-pin header mapping, named-net endpoint counts and the two deliberate NCs. No native KiCad process, build, firmware or physical qualification ran.

# RP2350 schematic placement plan

Candidate05 **guided-04, best of five** contains 62 individual sch_add_symbol calls. Seven tested local changes are applied relative to coherent-01. **U1/J2/J3 are unchanged.** Saved native U1 field positions, text, font, angle and justification exactly match the expected field model; no native SVG authority is claimed.

## Published local changes

| Ref | x mm | y mm | Rotation |
|---|---:|---:|---:|
| C18 | 86.36 | 88.90 | 0 |
| C19 | 106.68 | 88.90 | 0 |
| C23 | 118.11 | 179.07 | 0 |
| Q1 | 140.97 | 177.80 | 180 |
| R15 | 148.59 | 165.10 | 0 |
| R8 | 140.97 | 116.84 | 0 |
| D2 | 266.70 | 140.97 | 270 |

These clear the previously observed flash-capacitor, VSYS/SWD and core-filter label corridors. D2 is vertical with its expected fields away from the pin ray. All values, units, library IDs, footprints and pin/net assignments remain candidate05-exact. No PCB poses changed.

## Five bounded checks

| Iteration | First remaining terminal-label block | Work units | Joint source-body/field overlaps |
|---|---|---:|---:|
| 1 | C23:1 / VSYS_DIV | 22944 | 0 |
| 2 | C3:2 / GND | 29145 | 0 |
| 3 | D2:1 / GND | 38677 | 0 |
| 4 | D2:1 / GND | 38789 | 0 |
| 5, original-D2 control | D2:1 / GND | 38677 | 0 |

The published iteration4 source-body/full-pin-stroke plus expected-field screen has **zero overlaps**, minimum intercomponent clearance **1.142 mm**, and **zero nearest-stub page-margin failures**. All 262 selected source pins are plain lines; 248 complete terminal groups contain 246 functional groups and two NCs. Anchors/pin tips remain on the 1.27 mm grid.

The older DOC9 presentation corridor is retained solely to reproduce initial field placement. It overestimates some symbol bodies and is not the precise source-body obstacle used for these checks. Actual glyph ink is still unobserved.

## Concrete remaining blocker

The current helper cannot complete because the combined Device:LED source-body AABB extends **0.9154 mm beyond the cathode pin**. At published D2, pin1=(266.70,144.78), pointing down; the aggregate body extends to y=145.6954. All four cardinal orientations have the same relative obstruction, so more pose moves cannot solve it.

The selected-source primitive diagnostic shows that the minimum 1.27 mm outward ray intersects **zero individual stroke-expanded graphic AABBs**, despite intersecting their combined envelope. Qualified primitive-aware first-escape support is required; actual graphics, native glyphs, other components and foreign pins must remain obstacles. Iteration5 restored the old D2 pose as a control and reproduced the aggregate block; iteration4 is retained because its own fields are clear of the escape ray.

The helper discards partial plans: **zero complete wires/labels are published**. This is a geometry/coverage limitation, not budget exhaustion. No 246-group connectivity pass is claimed.

## Authority and evidence

All five per-iteration geometry/helper results, the pre-iteration plan, native-u1-field-confirmation.json and led-cathode-source-primitive-diagnostic.json are preserved in ../destination-verification/rp2350-schematic-preflight-01. The JSON binds their hashes and the exact selected-source identities.

Two explicit helper modes were retained. Full pin-stroke boxes without a branded native style witness stop at C10:1 as expected from the strict pin-exit authority check. The centerline-pin diagnostic retains source graphic stroke but openly omits pin stroke padding and uses separate synthetic expected Ref/Value envelopes. No native witness was fabricated and no obstacles were silently changed. Actual native glyph/pin-text coverage, power flags, complete connectivity authoring, persistence/parity and independent ERC remain required.

## Individual placements

| Ref | Block | x mm | y mm | Rotation | Exact value |
|---|---|---:|---:|---:|---|
| U1 | mcu | 172.72 | 85.09 | 0 | RP2350A |
| J2 | gpio_headers | 250.19 | 64.77 | 0 | PICO_1-20 |
| J3 | gpio_headers | 250.19 | 123.19 | 0 | PICO_21-40 |
| J1 | usb | 31.75 | 49.53 | 0 | USB-C |
| U4 | usb | 99.06 | 52.07 | 0 | USBLC6-2SC6 |
| R1 | usb | 130.81 | 72.39 | 270 | 27R |
| R2 | usb | 130.81 | 67.31 | 270 | 27R |
| R3 | usb | 66.04 | 73.66 | 0 | 5.1k |
| R4 | usb | 81.28 | 73.66 | 0 | 5.1k |
| C26 | usb | 76.20 | 31.75 | 0 | 100nF |
| D1 | usb_power_entry | 35.56 | 24.13 | 0 | PMEG6010ELR |
| U3 | qspi_boot | 50.80 | 107.95 | 0 | W25Q32RV |
| C10 | 3v3_decoupling | 69.85 | 91.44 | 0 | 100nF |
| C18 | qspi_boot | 86.36 | 88.90 | 0 | 100nF |
| C19 | qspi_boot | 106.68 | 88.90 | 0 | 4.7uF |
| R5 | qspi_boot | 63.50 | 128.27 | 90 | 1k |
| R6 | qspi_boot | 111.76 | 81.28 | 0 | 10k |
| SW1 | qspi_boot | 96.52 | 101.60 | 0 | BOOTSEL |
| SW2 | run_reset | 121.92 | 97.79 | 0 | RUN |
| R8 | core_regulator | 140.97 | 116.84 | 0 | 33R |
| C3 | core_regulator | 118.11 | 109.22 | 270 | 4.7uF |
| L1 | core_regulator | 140.97 | 34.29 | 270 | 3.3uH |
| C11 | 1v1_decoupling | 127.00 | 40.64 | 0 | 100nF |
| Y1 | crystal | 107.95 | 127.00 | 0 | 12MHz |
| C24 | crystal | 91.44 | 132.08 | 0 | 15pF |
| C25 | crystal | 125.73 | 132.08 | 0 | 15pF |
| R7 | crystal | 137.16 | 139.70 | 270 | 1k |
| J4 | swd | 128.27 | 151.13 | 0 | SWD |
| R19 | swd | 106.68 | 143.51 | 270 | 100R |
| R20 | swd | 106.68 | 163.83 | 270 | 100R |
| U2 | buck_boost | 46.99 | 160.02 | 0 | RT6150B-33 |
| L2 | buck_boost | 54.61 | 135.89 | 270 | 2.2uH |
| R9 | buck_boost | 31.75 | 128.27 | 0 | 100k |
| R10 | buck_boost | 74.93 | 144.78 | 270 | 100k |
| C20 | buck_boost | 24.13 | 153.67 | 0 | 47uF |
| C21 | buck_boost | 67.31 | 182.88 | 0 | 47uF |
| C22 | buck_boost | 24.13 | 177.80 | 0 | 100nF |
| R11 | vbus_sense | 19.05 | 91.44 | 0 | 5.6k |
| R12 | vbus_sense | 24.13 | 110.49 | 0 | 10k |
| R13 | vsys_sense | 96.52 | 168.91 | 0 | 100k |
| R14 | vsys_sense | 96.52 | 181.61 | 0 | 100k |
| R15 | vsys_sense | 148.59 | 165.10 | 0 | 100k |
| C23 | vsys_sense | 118.11 | 179.07 | 0 | 1nF |
| Q1 | vsys_sense | 140.97 | 177.80 | 180 | DMG1012T |
| R16 | adc_reference | 166.37 | 153.67 | 90 | 200R |
| R17 | adc_reference | 189.23 | 153.67 | 90 | 1R |
| C16 | adc_reference | 209.55 | 154.94 | 0 | 100nF |
| C17 | adc_reference | 222.25 | 154.94 | 0 | 4.7uF |
| R18 | status_led | 252.73 | 156.21 | 90 | 470R |
| D2 | status_led | 266.70 | 140.97 | 270 | GREEN |
| C1 | 3v3_decoupling | 149.86 | 26.67 | 0 | 4.7uF |
| C5 | 3v3_decoupling | 161.29 | 26.67 | 0 | 100nF |
| C6 | 3v3_decoupling | 173.99 | 26.67 | 0 | 100nF |
| C7 | 3v3_decoupling | 186.69 | 26.67 | 0 | 100nF |
| C8 | 3v3_decoupling | 199.39 | 26.67 | 0 | 100nF |
| C9 | 3v3_decoupling | 212.09 | 26.67 | 0 | 100nF |
| C14 | 3v3_decoupling | 224.79 | 26.67 | 0 | 100nF |
| C15 | 3v3_decoupling | 237.49 | 26.67 | 0 | 100nF |
| C2 | 1v1_decoupling | 95.25 | 26.67 | 0 | 4.7uF |
| C4 | 1v1_decoupling | 107.95 | 26.67 | 0 | 4.7uF |
| C12 | 1v1_decoupling | 120.65 | 26.67 | 0 | 100nF |
| C13 | 1v1_decoupling | 133.35 | 26.67 | 0 | 100nF |

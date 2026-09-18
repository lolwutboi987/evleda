# RP2350 Pico-like operating constraints

Reviewed 2026-09-17. [operating-constraints.json](operating-constraints.json) closes the electrical-input choices for **all 65 existing nets**. It preserves **62 references, 260 connected endpoints and two NC terminals**. These are source-backed requirements, calculations and explicitly selected **design targets for a candidate**, not measured board performance. No draft, circuit, application, native CAD, configuration or manufacturing file is changed by this overlay.

## Operating profile

Keep the intended Pico-like functions: RP2350A A4 silicon intent, normal **150 MHz**, default **1.1 V** core, both CPU cores within the power budget, 4 MiB QSPI flash, USB full-speed device/sink, SWD, BOOT/RUN, GPIO25 LED and **1.8–5.5 V VSYS** at the actual regulator input under load. The conservative initial ambient target is **0–50 °C**, with later acceptance targets of IC junctions below 100 °C and passive bodies below 85 °C. Neither target is a calculated or measured temperature rating.

The selected operating budgets are:

| Item | Candidate design target | Basis and interpretation |
| --- | --- | --- |
| Shared 3V3 rail | 250 mA continuous; 300 mA for 1 ms | Includes every on-board allocation and allowed external loads; not 250 mA available at the header |
| External 3V3 header load | 50 mA maximum | Included in the total, including at low VSYS; output only |
| Core 1V1 load | 150 mA continuous; 200 mA for 1 ms | Below/at the RP2350 normal regulator's 200 mA capability |
| External GPIO loading | 2 mA static per pin; 24 mA aggregate sourcing and 24 mA aggregate sinking | Shared limit overrides independent per-net rows; bank including LED/control/debug has an 80 mA transient target below the vendor's 100 mA bank limit |
| QSPI bank | 20 mA maximum aggregate sourcing or sinking | Separate vendor bank limit; no external QSPI load |
| GPIO interface speed | 25 MHz maximum external clock/toggling; ≤10 pF external load per pin | Selected useful interface envelope, not the silicon's absolute performance limit |
| QSPI | 75 MHz fast/quad-read target; ordinary 03h reads ≤50 MHz | 150 MHz clock divided by two; selected flash allows 104 MHz unaligned fast reads, with instruction-specific timing conditions |
| SWD | 10 MHz; start recovery at 1 MHz | Manufacturer's typical debug clock; short shared-ground probe connection, ≤100 mm cable and ≤15 pF external load target |
| USB | 12 Mbit/s full-speed, 4–20 ns edges | Device/sink only; preserve launch resistors and all channel anchors |
| ADC | ≤500 ksample/s aggregate; 100 kHz analog bandwidth target | ADC inputs stay within the actual reference and I/O supplies; settling and accuracy remain unverified |

The [RP2350 datasheet](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008373-DS-2-rp2350-datasheet.pdf), Tables 1436 and 1440–1446, distinguishes GPIO bank limits, QSPI bank limits, normal core-regulator capability and typical application currents. Its 2/4/8/12 mA drive-strength settings are **not current limiters**. The [Winbond W25Q32RV datasheet](https://www.winbond.com/resource-files/W25Q32RV_SPI_QPI%20RevE%2011132025%20Plus.pdf), pp.67–73, supplies the flash voltage/current/timing conditions. Its read-current characterization is not a worst-case complete-board current measurement.

## Rail and power arithmetic

The outer combined 3V3 envelope is **3.135–3.6 V**: the RP2350 USB/VREG analog supply minimum and the flash maximum. The **steady loaded design target is narrower, 3.20–3.45 V**. This is necessary because R8 drops voltage before VREG_AVDD; a 3.135 V upstream rail does not itself establish a 3.135 V downstream analog supply. With R8 at 33.66 Ω and 1 mA, 3.20 V leaves **3.16634 V**. Likewise, the ADC filter at 201 Ω +2% and 1.01 mA total draw leaves **2.992928 V**, above the 2.97 V ADC performance floor. These are chosen acceptance targets, not a claim that RT6150 output accuracy is already demonstrated across load and temperature.

The machine-readable budget retains every term:

`I_3V3 = I_core * V_core / (V_3V3 * eta_core) + flash + other_MCU + QSPI_bank + external_GPIO + LED + filters/pulls + external_3V3`.

| Check | Computed input | Selected limit |
| --- | --- | --- |
| Continuous 3V3 | `0.150 × 1.16 / (3.135 × 0.60) + 0.144 = 236.504 mA` | 250 mA |
| 1 ms 3V3 peak | `0.200 × 1.16 / (3.135 × 0.60) + 0.144 = 267.339 mA` | 300 mA |
| VSYS at 1.8 V | `3.6 × 0.250 / (1.8 × 0.70) + 0.001 = 715.286 mA` | 750 mA |
| USB normal, conservative diode margin | `3.6 × 0.250 / ((4.4 − 0.8) × 0.70) + 0.001 = 358.143 mA` | 400 mA, with host permission |
| USB preconfiguration workload | `3.6 × 0.060 / ((4.4 − 0.8) × 0.70) + 0.001 = 86.714 mA` | 100 mA; inrush excluded |

The 144 mA of non-core allocations is flash including output loading 25 mA, other MCU circuitry 15 mA, QSPI bank 20 mA, external GPIO 24 mA, LED 8 mA, filters/pulls 2 mA and external 3V3 50 mA. This deliberately accounts for shared I/O loading rather than summing independent per-pin maxima. The **60% core and 70% RT6150 efficiencies are explicit conservative screening assumptions**, informed by the datasheets' typical data. They are not guaranteed minima; actual consumption and regulation remain later acceptance checks.

The [RT6150 datasheet](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf), pp.4, 7 and 10, supports the 1.8–5.5 V input and 0.8–1.2 MHz oscillator range. Its low-input typical current curve motivates a 250 mA **total** output target; the 800 mA headline is not an all-input board guarantee. L2 screening uses 2.2 µH ×0.8 tolerance ×0.9 rolloff and 0.8 MHz. The 1.5 A switch-loop pulse target has margin over the ideal full-load average plus ripple; startup, mode transitions and hot inductance remain separate. The minimum 1.6 A current-limit specification does not bound maximum fault current. No JEDEC four-layer thermal resistance is represented as this candidate board's thermal resistance.

## USB and external power rules

There are two honest external-source declarations: J1.A4/J1.A1 for USB, and J3.19/J3.18 for external VSYS. VSYS uses the V2 `power_input` role because an actual off-board supply is explicitly allowed at its header. It also remains the downstream rail of the USB diode. Internally generated 1V1, ADC_AVDD and VREG_AVDD are not labeled external supplies.

Before USB configuration, require **≤100 mA VBUS**, no external 3V3/GPIO loads, LED off and **≤60 mA total 3V3 workload**. After the host grants the declared load, the normal input target is ≤400 mA continuous, with a ≤500 mA, 10 ms transient target. Fixed CC pull-downs do not detect or authorize 1.5 A, 3 A, PD voltage, USB host power or BC1.2 charging. Firmware must also implement appropriate suspend behavior and VBUS-aware pullup control. The conservative project suspend target is 500 µA, explicitly not a statement of the current normative limit or a measured value.

**USB inrush is a real acceptance gap.** C20 is 47 µF behind D1. Its nominal charge at 5 V is 235 µC, compared with the legacy 50 µC/10 µF screening explanation in [TI's USB power guidance](https://www.ti.com/lit/an/slyt118/slyt118.pdf), p.28. U2 soft-start does not limit the charging of its input capacitor. The per-net 500 mA/10 ms target does not prove that the existing circuit meets it. The candidate can be created and evaluated; unrestricted host hotplug/compliance requires an applicable USB-IF inrush assessment or input limiting. Descriptor settings, assumed capacitor DC bias and software cannot silently discharge this issue.

The diode allowance is **0–0.8 V at ≤0.5 A** for the selected 0–50 °C ambient target. [Nexperia's PMEG6010ELR datasheet](https://assets.nexperia.com/documents/data-sheet/PMEG6010ELR.pdf), Table 7, specifies a 605 mV maximum at 0.5 A and 25 °C junction; its temperature graph is typical. The extra allowance is a design choice, not a guaranteed full-temperature limit. It leaves at least 3.6 V USB-derived VSYS from 4.4 V VBUS under the stated assumption.

For external VSYS alone, provide 1.8–5.5 V **under load** and capacity for 750 mA continuous/1 A for 10 ms. For simultaneous USB and external VSYS, require an **external reverse-blocking diode, FET or suitable power path** protecting the external source. D1 only blocks VSYS from feeding USB; it does not stop USB from feeding an unprotected source at VSYS. A raw cell directly attached while USB is connected is not an accepted mode. Keep 3V3 as an output and do not add VBUS/VSYS header loads to this budget. These choices preserve the documented [Pico power architecture](https://pip-assets.raspberrypi.com/categories/1005-raspberry-pi-pico-2/documents/RP-008299-DS-3-pico-2-datasheet.pdf), pp.15–17, without claiming arbitrary supply combinations are safe.

## Signal, analog and transient interpretation

Every electrical scalar has a profile-level source or explicit design-assumption explanation. Digital `nominalV` means a nominal high level, not waveform average. Analog crystal midpoints are analysis conventions, not predicted bias or amplitude. Except for USB's documented 4 ns minimum, edge-time values are selected **fastest-edge analysis bounds**. They do not assert that a driver cannot produce a faster edge. Compare actual source models/waveforms before assigning performance.

The schema's shortest pulse duration is 1 µs, so sub-microsecond edge pulses use a conservative 1 µs analysis envelope. Currents remain subject to bank sums and power-mode constraints; the schema cannot encode every coupled constraint in one scalar. Especially, a 50 mA USB launch-copper pulse target is not a PHY output-current entitlement.

GPIO26–28 in ADC mode must stay between ground and `min(actual ADC_AVDD, actual IOVDD)`; they are not 5 V tolerant. GPIO24's divided VBUS can reach 3.58 V with the declared resistor screen, below its 3.63 V unpowered fault-tolerant limit. The VSYS divider can reach 2.81 V **on Q1's drain when isolated**, while the powered ADC node has a 1.89 V envelope. Preserve the FET's reference orientation. EN is pulled to VSYS and accepts open-drain disable, not a normal 3.3 V push-pull signal.

R8 and the ADC filter have decaying capacitor-charging envelopes. Their listed peak amplitudes are not rectangular resistor loads for the full duration. The JSON records RC energy screens and retains resistor pulse/startup-ramp acceptance. For the crystal, the separate 0.5 mA RMS motional-current target implies at most 12.5 µW at 50 Ω ESR, below the [ABM8-272-T3](https://abracon.com/datasheets/ABM8-272-T3.pdf) 200 µW drive maximum. Per-net current also includes shunt-capacitor current. Actual motional current, startup and load capacitance remain unverified.

## Integration and verification

Merge only each overlay net's exact `name`, `role` and `electrical` into V2. `profileId`, source explanations, operating modes and calculations are companion metadata that must remain available to reviewers. Copy the two exact `externalPowerInputs` and four exact `derivedPowerSources`; keep all physical paths and return endpoints unchanged. The stable ID `VSYS_DIODE_PENDING` is retained for identity continuity even though its operating-input text is now resolved.

Read-only validation imported the **actual TypeScript source parser** with `node --import tsx`, merged the overlay into an in-memory draft and passed V2 parsing. It checked all 65 net names one-to-one, exact endpoint parity, 62 reference names, 260 unique connected pin assignments, two NCs, all electrical shapes, both external declarations, all four derived declarations and all five numeric current-budget inequalities. No native authoring, library binding, ERC/DRC, full application build or physical test was performed.

There are **no unresolved electrical-input placeholders** in this overlay. The named later checks remain necessary before an electrical/compliance/manufacturing rating; they do not masquerade as measurements and do not prevent creation of the constrained candidate.

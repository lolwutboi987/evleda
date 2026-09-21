# Supply-route review of the saved RP2350 candidate

The external VSYS supply needs allowance for the board's input-route drop. The
existing **1.8 V minimum remains a requirement at U2 under load**, not a rating
for 1.8 V applied at J3.19. The ADC filter also has a small remaining voltage
margin if the regulator output is only 3.20 V. These findings do not justify a
layout change by themselves, but they matter to the board's operating limits.

This review reads the actual 1,099-track, 118-via PCB, its saved four-layer
stackup and the published load declarations. PCB SHA-256:
`1409f3775ebec294987b2b9fdcd984b8cf4ab7e8884700fa1c91250847ff62da`.
No board, managed session, installed toolbox, rules or acceptance result changed.

## Results

Values below apply the **entire rail current envelope to each path separately**.
They are conditional resistance screens, not predicted current sharing. In
particular, VINA is the regulator's control supply and U1.50 is a feedback input;
neither is asserted to consume the whole rail current. Capacitor branches are
also not asserted to draw the continuous rail current.

| Saved path | Applied current | Nominal geometry, 25 °C | Nominal geometry, 85 °C | 85 °C sensitivity case |
| --- | ---: | ---: | ---: | ---: |
| J3.19 → U2.5, external VSYS to VIN | 750 mA | 32.552 mV | 40.169 mV | 59.723 mV |
| J3.19 → U2.8, external VSYS to VINA | 750 mA | 40.312 mV | 49.745 mV | 72.464 mV |
| D1.1 → U2.5, diode cathode to VIN | 750 mA | 24.173 mV | 29.830 mV | 43.846 mV |
| J1.A4 → D1.2, VBUS to diode anode | 400 mA | 5.975 mV | 7.374 mV | 10.276 mV |
| U2.1 → R16.1, ADC filter input | 250 mA | 8.607 mV | 10.620 mV | 15.655 mV |
| L1.1 → U1.23, core output to DVDD | 150 mA | 4.903 mV | 6.050 mV | 7.949 mV |
| R8.2 → U1.46, VREG_AVDD after resistor | 1 mA | 0.01365 mV | 0.01684 mV | 0.02586 mV |

The sensitivity case uses **80% of every track/corridor width and 35 µm outer
copper**, keeping the saved 35 µm inner copper. It is an explicitly chosen
perturbation, not a guaranteed fabrication minimum. All cases assume a 15 µm
barrel wall and the full 1.016 mm board thickness per via transition. An assumed
85 °C copper temperature is not a temperature-rise prediction or operating rating.

The J3.19 → U2.5 path contains 48.790 mm of tracks and two via transitions. Its
85 °C nominal-dimension loss at 750 mA is approximately 30.1 mW; its 1 A pulse
drop is 53.6 mV. Ground return, header contacts, source/cable loss, input ripple
and transient regulation must be added before setting a usable header minimum.
**Do not turn these figures into a new 1.85 V or 1.90 V board rating.** The
[RT6150 datasheet](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf),
pp.2 and 4, identifies VIN/VINA and the 1.8–5.5 V recommended input range.

For the ADC path, retain the existing 201 Ω filter, +2% resistor screen and
1.01 mA budget. Starting with 3.20 V **at U2.1**, subtract the modeled 3V3 feed,
ADC_VREF link and ADC_AVDD link in addition to the resistor drop. The resulting
conditional U1.44 values are 2.984309 V at 25 °C, 2.982291 V at 85 °C, and
2.977247 V in the sensitivity case. That leaves respectively 14.309, 12.291 and
7.247 mV above the existing 2.97 V performance target, before ground difference,
ripple, additional losses or unqualified tolerances. **ADC supply acceptance is
still open.** A 3.20 V requirement at the local filter input and one at the
regulator output are not interchangeable.

The full upstream VREG_AVDD screen remains incomplete: the source-only graph
does not resolve U2.1 → R8.1. A small R8.2 → U1.46 result cannot close that gap.
Likewise, no whole-3V3 conclusion follows from the modeled ADC feed alone.

## Method and limits

[analyze.mjs](analyze.mjs) reuses EvlEDA's saved PCB/stackup parser, existing TI
copper material model, voltage-drop and I²R functions. It does not feed nominal
dimensions into the separate worst-case fabrication-evidence calculator.
The existing material model uses 17 µΩ·mm at 25 °C and a linear coefficient of
0.0039/°C, from [TI's Analog Engineer's Pocket Reference, Rev. C](https://www.ti.com/seclit/eb/slyw038c/slyw038c.pdf).
This differs slightly from the earlier 58 MS/m at 20 °C neck-only screen; the
model and reference temperature are retained explicitly in the report.

The graph splits each real straight track at exact integer-nanometre centerline
junctions. Via links use the actual saved drill diameter. Where a track lands
off-center in a rectangular or roundrect SMD pad, a nonzero-resistance strip is
modeled only when its complete capsule fits strictly inside a conservative
central rectangle of that same pad. There are no invented zero-resistance
bridges between nearby traces or between distinct pads. Header through-hole
barrel/contact resistance is excluded, and source/sink attachment uses the
actual selected copper layer at the pad center.

Via resistance uses `rho * length / [pi * wall * (drill - wall)]`, treating the
CAD drill as the **outer, pre-plating cylinder diameter** for this explicit
scenario. A finished inner-hole diameter would instead require the plus-wall
formula. Neither the CAD drill interpretation nor its physical tolerance has
been qualified with the fabricator. Wall plating is separate from layer copper.

Each route is the minimum-resistance path in this restricted graph. This is
not an effective-resistance solution, a complete finite-width copper model or
a proof of an upper bound for the manufactured assembly. Missing centerline or
supported pad-corridor connections remain `unassessed`, even when earlier
native checks established electrical connectivity. J1.B9 shares a source-pad
center; it gets an explicit unassessed contact result, not a zero-ohm claim.

Across eight source/net selections and three scenarios, 126 terminal paths are
calculated and 72 are unassessed (counts repeat the same endpoints by scenario).
The report preserves every endpoint, every modeled edge, and every unknown.
Ground return, pad spreading/constriction, component/package losses, thermal
rise, ampacity, switching inductance, ripple and USB startup remain outside this
screen. There is no new acceptance pass or manufacturing authorization.

## Reproduce and verify

From the repository root:

```powershell
node --import tsx designs/rp2350-pico/power-path-review-20260921/verify.mjs
```

[report.json](report.json) is deterministic and contains the exact PCB, intent,
construction and material identities. [verify.mjs](verify.mjs) reruns the screen
and requires byte-identical output, then independently checks every reported
path's continuity, source/sink positions, source-object identity, geometry and
arithmetic. It checks 2,271 path-edge occurrences, temperature scaling and
sensitivity monotonicity, and retains unresolved upstream/contact results.
Both scripts also pass `node --check`. This is a saved-source engineering review;
no new native DRC, full application build or physical test was required or run.

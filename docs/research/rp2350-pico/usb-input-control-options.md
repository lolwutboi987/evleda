# USB input control: bounded component screen, 20 September 2026

The subsequent [startup-sequencing review](../../../designs/rp2350-pico/usb-sequencing-review-20260920/README.md)
evaluates a concrete two-range TPS2141/TPS2151 proposal. Direct PG-to-RT6150-EN
wiring lacks a guaranteed low-level interface, startup load support and handover
ordering; it is not an adopted circuit. The existing board remains unchanged.

The published RP2350 board is unchanged. This follow-up narrows the active
options; it does not select a new component or resolve startup current.
The [existing startup screen](../../../designs/rp2350-pico/usb-startup-screen-20260920/README.md)
and complete load/power-mode requirements still apply.

## A fixed 100 mA clamp is not a drop-in solution

The existing conservative preconfiguration load screen is 86.714 mA at VBUS.
Even before extra switch current or resistor tolerance, a symmetric limiter
tolerance must fit the interval between that load and 100 mA. For nominal limit
`I0` and fractional tolerance `e`, both `(1-e) I0 >= 86.714 mA` and
`(1+e) I0 <= 100 mA` require `e <= 7.116%`. Extra bias current narrows this
window. This is a screening inequality, not a startup waveform calculation.

| Candidate | Manufacturer limits used | Result for this narrow strategy |
| --- | --- | --- |
| MAX4995C | Current-limit factor 0.9 to 1.1, specified at VIN=3.3 V and VIN-VOUT=1 V | Supporting 86.714 mA requires nominal limit at least 96.349 mA; its upper corner is then at least 105.984 mA, before extra bias. The table also does not establish the same bound throughout USB startup. |
| LTC4210-1/-2 | Sense threshold 44 to 56 mV and maximum supply current 3.5 mA | Ignoring other losses, load support requires Rsense <=0.5074 ohm, while total current <=100 mA requires Rsense >=0.5803 ohm. No resistor meets both. |

The MAX4995 family needs local input/output bypass; its C variant limits
continuously, while other variants can time out and retry or latch off. Those
behaviors must not be conflated. [ADI MAX4995 datasheet, pp.3 and 10-12](https://www.analog.com/MAX4995A/datasheet).
LTC4210 also needs an external MOSFET and a reviewed timing/compensation network;
the threshold is not a guaranteed +/-5% limit.
[ADI LTC4210 datasheet, pp.1 and 3](https://www.analog.com/media/en/technical-documentation/data-sheets/421012fa.pdf).

These results do **not** reject every current-controlled architecture. USB's
inrush analysis permits above-100 mA regions and evaluates their excess charge;
it does not require an ideal 100 mA clamp. The normal configured operating
profile also allows substantially more than 100 mA, so a persistent low clamp
would require a deliberate second mode. A resistor change alone cannot supply
that mode. [USB-IF electrical update 45](https://compliance.usb.org/index.asp?UpdateFile=Electrical#45).

## Slew control still requires the downstream startup design

TPS22917 remains a plausible input-ramp element in the retained-diode path
`VBUS -> switch -> D1 -> VSYS`. Its adjustable slew does not regulate load
current, and its published slew constants are typical. Keep raw VBUS sensing
and ESD bypass before the switch, bulk input decoupling at U2, external VSYS
operation, and no output discharge into an externally powered rail.
[TI TPS22917 datasheet, switching table and application sections](https://www.ti.com/lit/ds/symlink/tps22917.pdf).

A complete proposal must specify when U2 starts, how C21 and the downstream
rails charge, the startup load, and recovery on partial ramps or reattachment.
The 86.714 mA settled-rail estimate cannot simply be added to a typical input
capacitor charging current during a rising VSYS. Keep this coordinated design
as the next power-circuit task; do not adopt another isolated capacitor or
limiter substitution and label inrush solved.

Richtek's current design-tools page says its former third-party Designer
service has ceased operation. Its old startup-simulation guide is therefore
not evidence that an executable RT6150 model is available here. No RT6150
startup model was obtained in this review, and no synthetic model is presented
as manufacturer-qualified. [Richtek design tools](https://www.richtek.com/Design%20Support/Design%20Tools?Keyword=1).

# RP2350 USB startup: nominal charging screen

The missing nominal capacitor curve is now available from the rendered TDK
product page. It does **not** close USB startup qualification. The saved PCB,
component choices, power modes and operating limits remain unchanged.

## What the manufacturer data establishes

The selected C20/C21 part is TDK C3225X5R1A476M250AC, 47 uF, 10 V, X5R. Its
visible reference curve is approximately 47 uF at zero bias, 35 uF at 4 V and
30 uF at 5 V. Thus the selected larger capacitor cannot be treated as a 10 uF
input load merely by citing DC-bias loss. TDK explicitly does not guarantee its
graph data. [TDK product page and DC-bias graph](https://product.tdk.com/en/search/capacitor/ceramic/mlcc/info?part_no=C3225X5R1A476M250AC).

The points in [inputs.json](inputs.json) were read visually, with approximately
1 uF reading uncertainty. They are not a downloaded manufacturer CSV or a
guaranteed production envelope. Integration assumes the plotted incremental
capacitance describes one charging branch; frequency, hysteresis and combined
temperature/bias effects remain unqualified.

## Calculation and result

For this limited screen, capacitor charge is `Q = integral(C(V) dV)`. At 5 V the
approximate curve gives **204 uC**, with about 5 uC graph-reading uncertainty.
Using only the final capacitance would give about 148 uC and miss the higher
capacitance earlier in charging. At 3.6/4.4/4.7 V, the corresponding curve
integrals are approximately 158/186/195 uC.

The following imposes a linear VSYS ramp and computes only C20's charge above
100 mA. These are illustrative waveforms, not waveforms produced or guaranteed
by the current diode-fed circuit.

| Assumed 0-to-5 V ramp | Peak C20 current | C20 charge above 100 mA |
| --- | ---: | ---: |
| 0.1 ms | 2,375 mA | 194 uC |
| 0.5 ms | 475 mA | 154 uC |
| 1 ms | 238 mA | 104 uC |
| 2 ms | 119 mA | 15 uC |
| 5 ms | 48 mA | 0 uC |

Within this model, roughly 1.54 ms is needed to bring C20 alone below the 50 uC
comparison screen; roughly 2.38 ms keeps its entire ramp below 100 mA. Scaling
the curve by 1.38 gives roughly 2.35/3.28 ms instead, but that multiplication is
only a tolerance/temperature sensitivity example, not a joint production bound.

The USB-IF evaluates the largest above-100 mA charge region during at least
100 ms after attach, with a 100 us below-threshold separation between regions.
This capacitor-only calculation is not that complete board test. The 50 uC
comparison is the established 10 uF/5 V screening explanation, not a new
compliance verdict. [USB-IF update 45](https://compliance.usb.org/index.asp?UpdateFile=Electrical#45),
[TI USB power guidance, p.28](https://www.ti.com/lit/an/slyt118/slyt118.pdf).

## Why C20 alone is insufficient

Richtek specifies output soft-start at 0.65 ms typical and 1 ms maximum under
its listed no-load test condition, with no minimum in that table. This timing
does not limit the direct charging of C20 ahead of the converter. Its input
capacitor recommendation is at least 10 uF; neither 4.7 uF nor an arbitrary
10 uF replacement is qualified by this screen.
[RT6150A/B datasheet, electrical table and capacitor guidance](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf).

The same approximate curve gives C21 about 234 uJ of stored energy at 3.3 V.
That alone corresponds to approximately 65 uC of lossless input charge at 3.6 V,
or 93 uC using the existing 70% efficiency screening assumption. These are energy
calculations, not above-threshold charge or a regulator waveform. Other rail
capacitors and startup loads add to the problem. A C20 substitution alone cannot
therefore be declared a complete fix.

## Active-path screening decision

TPS2553 was checked as one concrete current-limited alternative. Its special
ILIM-to-IN setting spans 50/75/100 mA minimum/typical/maximum; the ordinary 210 kΩ
setting spans 110/130/150 mA. The former cannot guarantee the existing 86.7 mA
preconfiguration load screen, while the latter does not clamp below 100 mA.
It is therefore **not an accepted drop-in change**. A coordinated startup/load
and normal-power-mode design would still be necessary.
[TPS2553 datasheet, current-limit table and programming section](https://www.ti.com/lit/ds/symlink/tps2553.pdf).

Keep the present board as a candidate with USB startup unresolved. The next
electrical decision requires a defensible complete waveform envelope, or a
reviewed controlled input path that includes converter enable sequencing,
reverse-power behavior, input bypass and the existing normal-load requirement.
The self-powered-only variant is not substituted for the requested USB-powered
Pico behavior. No component, native source, contract or power entitlement was
changed by this analysis.

## Reproduction

Run `node calculate.mjs <fresh-output.json>` from this directory. The script
checks the unchanged native R1 PCB hash, integrates the explicit piecewise-linear
inputs and tests six independent constant-capacitance/threshold-crossing cases.
[results.json](results.json) retains all scenarios, assumptions and input hash.
There is no `accepted` or whole-startup pass hidden in the model:
`completeStartupAssessed` and `actualWaveformKnown` remain false.

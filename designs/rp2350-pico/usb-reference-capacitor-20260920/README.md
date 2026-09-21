# Smaller reference-class capacitor: nominal comparison

TDK C2012X5R0J476M125AC matches the Pico 2 schematic's nominal 47 uF, 6.3 V,
X5R, 0805 class. It is a candidate, not an identified Raspberry Pi production
MPN. The official reference does not specify that ordering code.
[Pico 2 schematic, Appendix B](https://pip-assets.raspberrypi.com/categories/1005-raspberry-pi-pico-2/documents/RP-008299-DS-3-pico-2-datasheet.pdf).

The TDK page's visible DC-bias graph gives approximately 47 uF at zero bias,
22 uF at 3 V and 13 uF at 5 V. These are visually read reference data, with
1.5 uF reading uncertainty; no guaranteed joint tolerance/temperature envelope
or downloadable CSV was obtained. [TDK product and graph](https://product.tdk.com/en/search/capacitor/ceramic/mlcc/info?part_no=C2012X5R0J476M125AC).

| Nominal calculation | Existing 10 V / 1210 part | Candidate 6.3 V / 0805 part |
| --- | ---: | ---: |
| Charge from 0 to 5 V, integral C(V) dV | 204 uC | 137 uC |
| C21 stored energy at 3.3 V, integral V C(V) dV | 234 uJ | 156 uJ |

The candidate's charge reading uncertainty at 5 V is about 7.5 uC, excluding
curve-model and production uncertainty. Its nominal input charging demand is
about 33% lower. C21 alone still corresponds to about 62 uC of input charge at
3.6 V using the existing 70% efficiency sensitivity assumption. That conversion
does not establish regulator startup efficiency or the charging waveform.

This does not settle USB inrush. Total capacitor charge is different from the
charge above the 100 mA threshold over a complete startup region. Input bypass,
distributed output capacitance, converter timing and startup load remain part
of the same unresolved circuit review. A smaller 47 uF package alone has not
been qualified as the fix. No component, footprint, circuit or native file changed.

[Inputs](inputs.json) retain the observations and assumptions;
[results](results.json) retain the comparison. Run
`node calculate.mjs <fresh-output.json>` to reproduce it against the unchanged
native candidate and the earlier larger-capacitor curve. The result contains no
whole-startup acceptance claim. See the [prior startup screen](../usb-startup-screen-20260920/README.md)
and [sequencing review](../usb-sequencing-review-20260920/README.md).

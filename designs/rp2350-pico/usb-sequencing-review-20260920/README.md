# USB startup sequencing: reject the direct PG-to-EN proposal

The proposed `VBUS -> TPS2141/TPS2151 -> D1 -> VSYS` path with
`SW_PG -> RT6150 EN` is not ready to adopt. The unchanged RP2350 board remains
the baseline. This screen identifies missing guarantees, not a measured failure.

The switch's two current ranges address capacitive startup, but introduce a
handover that must be coordinated with the converter:

| Check | Documented limits | Implication for this proposal |
| --- | --- | --- |
| Initial current | 50–99 mA | The existing 86.714 mA settled-load screen exceeds the guaranteed minimum by 36.714 mA. |
| Direct enable interface | PG low can be 0.5 V; RT6150 guarantees low only through 0.4 V | Converter shutdown is not guaranteed by directly wiring these pins. |
| Handover | Low limit releases at 91–96% of input; PG sense is 85–90%, with hysteresis | Thresholds alone do not guarantee the desired ordering. |
| PG delay | 1 ms typical, 2.5 ms maximum; no listed minimum | Do not use the typical delay as a lower bound. |
| After handover | High-limit maximum 1.8 A | C21 and downstream rail charging still need an input-current envelope. |

Sources: [TI SLVS399A, pp.4, 8, 10](https://www.ti.com/lit/gpn/tps2141),
[Richtek DS6150AB-06, pp.4–5](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf).
The TI PG prose and table describe its voltage reference differently; the
calculation uses the table's ratios and retains that ambiguity.

TI's application note demonstrates stalled startup with excessive load and
successful typical sequencing using PG. That demonstration supports coordinating
the load; it does not supply missing worst-case timing for this board.
[TI SLVA129, pp.4–7](https://www.ti.com/lit/an/slva129/slva129.pdf?ts=1780289205942).

The PG output is push-pull. It also cannot replace the existing externally
pullable `3V3_EN` function or establish external-VSYS-only operation. Retaining
D1 keeps its reverse-isolation role; bypassing it is a separate change.

The next complete circuit proposal must control input charging, converter/output
charging, and workload release separately; preserve external VSYS and the enable
header; and review partial ramps and reattachment. A power-good pin by itself
does not settle those decisions. Keep the existing configured normal-load target.

[Inputs](inputs.json) retain the exact source limits; [results](results.json)
retain each comparison. Run `node check-proposal.mjs <fresh-output.json>` to
reproduce them. The script binds both current native PCB and schematic hashes
before and after calculation. It is a range check, not a regulator simulation,
USB waveform test, or circuit revision.

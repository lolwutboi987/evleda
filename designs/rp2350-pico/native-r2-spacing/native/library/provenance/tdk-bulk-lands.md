# TDK C3225X5R1A476M250AC selected PCB lands

Reviewed 2026-09-17 against the [manufacturer part page](https://product.tdk.com/en/search/capacitor/ceramic/mlcc/info?part_no=C3225X5R1A476M250AC). The exact part lists recommended PA = 2.00-2.40 mm (inner gap), PB = 1.00-1.20 mm (each land length), and PC = 1.90-2.50 mm (land width).

This design selects the interval midpoints: PA = 2.20, PB = 1.10, PC = 2.20 mm. Two rectangular 1.10 x 2.20 mm lands have centers x = +/-1.65 mm, giving 2.20 mm inner gap and 4.40 mm outer span. This is an engineering selection within manufacturer ranges, not a manufacturer certification of this exact footprint.

The part page gives body L = 3.20 +0.45/-0.40, W = 2.50 +0.35/-0.30, T = 2.50 +0.35/-0.30 mm. Fabrication graphics show nominal 3.2 x 2.5 mm; the courtyard x = +/-2.45, y = +/-1.70 mm includes the maximum body and copper with at least 0.25 mm margin. Stock C_1210_3225Metric has 1.80 mm gap and 2.70 mm land width, outside PA/PC, so only C20/C21 receive the new footprint. Nonpolarized pad 1 left / pad 2 right is a CAD convention and preserves the circuit assignments.

No clearance override is added. Paste follows copper and mask uses board defaults. Stencil, process tolerances and solder-mask checks remain assembly work. Land closure does not establish effective capacitance under bias, transient stability or thermal performance.

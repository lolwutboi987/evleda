# Richtek RT6150B-33GQW source notes

Reviewed 2026-09-16. Primary sources and SHA-256 identities are in `source-identities.json`; manufacturer PDFs remain outside the repository. The current product page links DS6150A/B-06 (July 2018) and the WDFN2.5x2.5-10 land drawing. No stock footprint was substituted.

- [Datasheet](https://www.richtek.com/assets/product_file/RT6150A=RT6150B/DS6150AB-06.pdf), pp.2,9,13: fixed 3.3 V B part; FB must directly sense VOUT. PS low enables power-save operation; PS high forces PWM. Page 2 top-view numbering runs 1-5 down the left and 10-6 down the right. Exposed pad 11 is GND.
- [Land drawing](https://www.richtek.com/assets/podfiles/Footprint-%28V%29%28W%29%28U%29XDFN2.5x2.5-10-R-B.pdf), p.1: P=0.50, A=3.30, B=1.60, C=0.85, D=0.30, Sx=2.00, Sy=1.20, M=2.30 mm; drawing tolerance +/-0.05 mm. Rotating the drawing 90 degrees gives left/right pad rows: 0.85 x 0.30 mm pads, x=+/-1.225, y=-1,-0.5,0,0.5,1; central pad 1.20 x 2.00 mm. B is the inner gap, not row spacing. Package body is nominally 2.5 x 2.5 mm; package terminal dimensions differ from copper lands.

| Pin | Function | KiCad electrical type |
| --- | --- | --- |
| 1 | VOUT | power_out |
| 2 | LX2 | power_out |
| 3 | GND | power_in |
| 4 | LX1 | power_out |
| 5 | VIN | power_in |
| 6 | EN | input |
| 7 | PS | input |
| 8 | VINA | power_in |
| 9 | GND | power_in |
| 10 | FB | input |
| 11 | GND (exposed pad) | power_in |

Electrical types are explicit EvlEDA ERC modelling decisions derived from the manufacturer functions, not KiCad types assigned by Richtek. LX pins are switched power outputs; they are not DC supplies. All ground/supply terminals remain visible power inputs. Pins are separate, unstacked, and single-unit; no inherited symbol or hidden electrical pins.

Copper lands reproduce the manufacturer's nominal drawing. Silk, courtyard, reference text and body graphics are local documentation choices. F.Paste currently follows each copper land, including the exposed pad; the source does not specify a stencil. Paste segmentation, mask expansion, thermal vias, solder process and assembly clearance require separate process review. No thermal-performance or manufacturability claim is made.

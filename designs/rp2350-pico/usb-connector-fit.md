# USB-C mechanical fit review

Reviewed 2026-09-17. **Two conditional horizontal options are available; neither is a released fit.** No schematic, footprint, board, component-selection or placement-intent file was changed by this review. The accompanying JSON contains exact source hashes and all native pad observations.

The layout owner selected the existing **GCT USB4105-GF-A with its mouth set back 1.30 mm** as the preferred layout candidate. This clears the nominal fixed mounting bores without changing the holes, shell lands or contact map. It departs from the manufacturer's illustrated PCB edge, so the cable, body and assembly tolerance review remains necessary.

| Rank / case | Native footprint pose, mm / degrees | Mouth Y | Minimum copper-to-bore gap | Minimum drill-to-bore gap |
|---|---|---:|---:|---:|
| 1 — USB4105, 1.30 mm setback | (10.500, 4.975), 180 | 1.300 | 0.488235 mm | 0.688235 mm |
| 2 — USB4085, mouth flush | (13.475, 8.610), 180 | 0.000 | 0.805022 mm | 0.955022 mm |
| Rejected — existing USB4105 pose | (10.500, 3.675), 180 | 0.000 | **−0.155583 mm** | 0.044417 mm |
| Rejected — USB4085 illustrated edge pose | (13.475, 6.100), 180 | −2.510 | **−0.125000 mm** | 0.025000 mm |

Coordinates use the northwest board corner as (0,0), with +Y south. These are geometric gaps to nominal 2.10 mm bare bores, not a native DRC result or a passed manufacturing rule. Using only the maximum 2.15 mm bore diameter reduces every tabulated gap by 0.025 mm. Hole-position tolerance, drill wander, copper etch and assembly tolerances are additional.

The fixed inputs are a 21 × 51 mm outline; mounting centres (4.8,2), (16.2,2), (4.8,49), (16.2,49); and forty 1.7 mm header-land envelopes on x=1.61/19.39, y=1.37…49.63 at 2.54 mm pitch. A downstream clarification of the bottom-hole datum does not affect the top connector minimum, but must be synchronized before this becomes design authority.

## 1. Retain USB4105-GF-A, with a small setback

Use stock `Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal` unchanged. The front SH lands become (6.18,3.90) and (14.82,3.90), with 1.00 × 1.80 mm copper ovals and 0.60 × 1.40 mm slots. Both shapes have a 0.80 mm straight centre segment. The independent nearest-gap calculation is `hypot(1.38,1.50) − 0.50 − 1.05 = 0.488234530 mm`.

The nominal shell occupies x=6.03…14.97 and y=1.30…8.65. Copper stays at least 3.22 mm horizontally from the header-land envelopes. All contact lands remain within the board.

[GCT's USB4105 drawing](https://gct.co/files/drawings/usb4105.pdf), visually inspected as [revision B3, sheet 1](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/5492/USB4105.pdf), shows a minimum 1.85 mm mated plug-shoulder distance ahead of the receptacle mouth. Subtracting the proposed setback leaves **0.55 mm longitudinal clearance** to the board edge. This is an inference from the sectional drawing, not approval of the changed edge position or every cable overmold.

The default Reference anchor becomes (10.5,10.475); the long Value field lands at (10.5,−0.025) on F.Fab and requires deliberate relocation or hiding. Check actual rendered text and nearby parts after placement.

Tolerance sensitivity for this pose is auditable: the 2.15 mm maximum bore alone leaves 0.463235 mm copper gap. A hypothetical additional adverse relative shift of 0.05 mm in each axis leaves 0.392587 mm; 0.10 mm in each axis leaves 0.321945 mm. Those shift values are examples, **not selected fabrication tolerances**. The shell's nominal 0.155 mm body-to-maximum-bore margin is much tighter than the copper gap: applying only the B3 default ±0.15 mm width tolerance reduces that margin to 0.080 mm at nominal assembly position. Establish the actual shell/locating-peg/placement/hole-position stack before a body-fit pass.

For cable acceptance, verify that the total adverse mouth-position, board-edge and assembly allowance plus the required cable gap stays below the derived 0.55 mm longitudinal budget; inspect the plug's full Z envelope as well. For fabrication acceptance, compare the complete copper/hole tolerance stack with the selected fabricator and design minimum. These conditions remain open; the setback is not a clearance waiver.

## 2. USB4085-GF-A, mouth flush

Use stock `Connector_USB:USB_C_Receptacle_GCT_USB4085` unchanged. Its origin is contact A1, so the centred pose is x=13.475, not x=10.5. Front SH centres are (6.175,4.25) and (14.825,4.25); copper is 0.90 × 1.70 mm and slots are 0.60 × 1.40 mm. The nominal shell is x=6.025…14.975, y=0…9.17. The header-land horizontal separation is at least 3.265 mm.

[GCT's drawing](https://gct.co/Files/Drawings/USB4085.pdf), inspected as [revision B, sheets 1–2](https://www.farnell.com/cad/4376797.pdf), places its illustrated board edge 2.51 mm behind the mouth. Moving the mouth to the board edge therefore extends the PCB under that region. The mating section labels a 2.10 mm shoulder-to-mouth separation. Confirm the complete mating envelope before selecting this pose. The [revision B PCN](https://gct.co/files/pcns/gct%20usb4085%20b%20pcn%2020230426.pdf) states the PCB footprint is unchanged.

All sixteen contacts have separate through-hole lands; stock uses 0.70 mm copper / 0.40 mm drill versus the drawing's 0.65 mm copper / 0.40 mm drill. Preserve the larger stock lands. This option adds through-hole assembly, has a deeper body, and also needs its default Value field moved from y=−1.315.

## Electrical mapping remains complete

| Physical contacts | Intent |
|---|---|
| A1, A12, B1, B12 | GND |
| A4, A9, B4, B9 | VBUS |
| A5 / B5 | Separate CC1 / CC2, each with its own 5.1 kΩ pull-down |
| A6, B6 / A7, B7 | DP / DM respectively, joined intentionally on the board and routed through the existing ESD arrangement |
| A8 / B8 | Explicit separate SBU1 / SBU2 no-connects |
| SH | All four shell pads retained on the existing GND intent |

USB4105 has manufacturer-labelled shared solder tails for A1/B12, A4/B9, A9/B4 and A12/B1. The stock footprint expresses these as coincident numbered pads. Keep all sixteen symbol contacts; no implicit DP/DM or CC connection is introduced. USB4085 has no coincident contact pads. Six-pin power-only receptacles are excluded.

## Separate hardware-access limits

The USB4105 nominal shell is only 1.23 mm horizontally from either top hole centre. Thus a top-side head/washer disk above 2.46 mm diameter overlaps the nominal shell projection if the Z envelopes overlap. This is a geometric upper bound, not an M2-head guarantee or a reason to reject bare bores. The selected screw head, washer, installation direction and cable are unknown. The nominal shell-to-maximum-bore gap is 0.155 mm before body and position tolerances.

USB4110's wider SMD wings do not fix the original conflict. The Amphenol 12401948 stock footprint includes a board-edge cutout and is not a rectangular-outline drop-in. No unconditional horizontal option at its illustrated manufacturer edge was established in this bounded review. If edge-position deviations are unacceptable, the explicit alternatives are a reviewed vertical receptacle, changing cable entry, or relocating the top holes, changing Pico carrier fit. Neither was selected.

Verification used KiCad 10.0's native footprint loader and in-memory transforms, with exact circle/oval/rounded-rectangle distances against all four bores. It reproduced the original overlap and retained all 17 electrical pad names. No native board, DRC, mating test, fabrication or assembly acceptance is claimed.

# QSPI and clock route planning

This is a source-based work in progress. The [JSON](qspi-clock-route-plan.json) preserves exact input and footprint identities, a strict QSPI obstruction certificate, explicit already-clear route geometry, and unadopted placement studies. It does not authorize native changes or establish reference-plane, impedance or physical performance acceptance.

## Candidate05 obstruction

At the unchanged C14/C15 targets, a closed polygon inside foreign copper clearance expansions encloses U1.55–58 and excludes their U3 targets. Its owners run through U1 pads1–54, R1.1, C14.1, C15.1, U1.59 and U1.60. Each polygon edge lies in one convex expanded rounded pad; the minimum strict overlap margin is **0.004670 mm**. The JSON contains every overlap witness and polygon point.

Consequently the required 0.20 mm F.Cu routes for QSPI_SD3, QSPI_SCLK, QSPI_SD0 and QSPI_SD2 cannot leave that enclosure. This includes inward routes under the MCU body. The proof uses actual copper and required net-class clearances, with no component-body or courtyard copper keepout assumption.

## Placement studies remain proposals

Moving both capacitors north to y=16.700 mm, preserving x and 90-degree rotation, breaks the original enclosure. All62 courtyard pairs and the historical frozen38 USB segments pass the source screen. Each affected QSPI net has an individually clear example path. Those individual paths share space and do **not** establish a simultaneously routed bus.

A broader unadopted north-group study also preserves placement and USB clearance and supports three upper QSPI paths together. The JSON retains it solely for review. Its remaining QSPI paths and actual 3V3/ground loops are not solved, so those positions must not be promoted to an accepted input revision.

## Ongoing work

The oscillator study retains two explicit source-checked alternatives. Fixed poses produce a 1.582 mm XOUT_MCU launch, a 10.011 mm XIN tree and a 15.694 mm XTAL_OUT tree. The long output loop meets its literal16 mm cap but is not preferred engineering placement; its historical direct capacitor branches also create right-angle centreline joins at crystal pads, so it is not a turn-compliant plan.

A separate unadopted proposal rotates Y1 at its existing centre from180 to0 degrees and exchanges the target locations/rotations of identical15 pF C24/C25. Logical net assignments remain intact. It leaves occupied copper/courtyard envelopes and the spatial GND pad set unchanged. After preserving45-degree joins across the crystal-pad polyline boundaries, its XIN tree is11.743 mm and XTAL_OUT tree is4.505 mm, with the same1.582 mm source damping-resistor launch. SWCLK_MCU is2.826 mm and SWCLK_HDR is26.577 mm. All five nets are connected acyclic source graphs with every physical endpoint reached, no duplicate edges, and lengths inside their unchanged bounds. The actual pure turn analyzer reports zero findings, zero turns above45 degrees and zero short pre-turn legs for these46 clock segments. These paths and a complete SWCLK path pass the shared source copper/drill checker against the historical USB38 proposal. Actual supply/return coexistence and native/reference evidence remain open.

SWDIO data nets remain in the endpoint/obstacle inventory but are explicitly unplanned here; their shared south-region passage requires coordination with SWCLK and the general data routing. No missing SWDIO endpoint is claimed connected.

The preferred clock paths also have zero conflicts with the17 power polylines and four proposed GND vias in the source-bound power-plan snapshot. Later power/distribution/return copper must be checked again. No ground fill or continuous-reference acceptance is claimed: SWCLK_HDR ends at THT signal pin J4.1, whose barrel and B.Cu pad interrupt a literal GND-under-centreline guard near the endpoint. J4.2 remains its required ground reference; actual terminal-launch coverage needs the saved-board assessment.

Complete the six-net bus, both CS passive branches, BOOT contacts, oscillator and debug paths against the power planner's revised USB, supply and return copper. Preserve width, clearance, 45-degree turns, zero-via signal restrictions and all endpoint mappings. Final checking must use one coherent source state and retain unknown native/reference/performance results.

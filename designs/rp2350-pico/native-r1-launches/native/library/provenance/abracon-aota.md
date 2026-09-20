# Abracon core inductor source notes

Reviewed 2026-09-16. [Abracon AOTA-B201610S3R3-101-T datasheet](https://abracon.com/datasheets/AOTA-B201610S3R3-101-T.pdf), Revision A (2024-09-13), pp.1,4; SHA-256 in `source-identities.json`. This is the exact polarity-marked 3.3 uH +/-20% part with nominal 2.0 x 1.6 mm body and maximum 1.0 mm height.

Page 4 calls the white dot a polarity mark and illustrates winding direction. Its current arrow enters the marked terminal; the mark does not mean that terminal is universally a fixed positive supply. Abracon does not number the two terminals. This library adopts Raspberry Pi's numbering: marked terminal 1 -> 1V1; terminal 2 -> VREG_LX in the RP2350 core converter. The lower-left fabrication dot is the vendor top view rotated 180 degrees, matching Minimal L1.

| Footprint suffix | Each copper pad mm | Centers mm | Inner gap mm | Overall span mm |
| --- | --- | --- | --- | --- |
| Abracon_Recommended | 1.00 x 1.60 | (+/-1.00, 0) | 1.00 | 3.00 |
| RaspberryPi_Minimal | 0.70 x 1.70 | (+/-0.70, 0) | 0.70 | 2.10 |

The first reproduces Abracon's page-4 recommended nominal copper lands. The second reproduces the official Minimal R4-S1 L1 lands, body, courtyard and polarity marks; it is **not** the manufacturer's recommended land pattern. No dimensional averaging or silent substitution was applied. Both use pad 1 on the left, but their pad coordinates are not interchangeable in an existing layout. Mask/stencil processing and manufacturing acceptance remain outside this review.

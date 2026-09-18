# QSPI terminal neckdown basis

Reviewed 2026-09-17. A **nominal 0.15 mm signal neck, at most 1 mm long per explicitly declared terminal escape**, is a credible input choice for this candidate. Retain **0.20 mm main traces, 0.15 mm clearance, F.Cu routing, continuous B.Cu ground reference, 75 MHz fast/quad-read intent and the existing 1 ns fastest-edge screening assumption**. This note supports an engineering choice now; it does not claim measured signal performance, controlled impedance or a thermal rating. It does not authorize changing whole nets to 0.15 mm.

## Primary fabrication and reference evidence

- [JetPCB Manufacturing Standards](https://us.jetpcb.com/Public/en-US/docs/Specifications.pdf), PDF page 2 and sections 3.6/3.7 on page 8, specify standard minimum trace width and conductor spacing of **5 mil = 0.127 mm**. The proposed 0.15 mm width and spacing are approximately **5.91 mil**, above those nominal design minima. The separate 4/4 mil option is limited to finished copper below 35 micrometres and is **not** the basis for the selected 43 micrometre construction.
- The same document, section 3.5 on PDF page 4, lists the nominal 1 mm two-layer build with **18 micrometres foil plus 25 micrometres plating per side**, a **0.900 mm core**, and 10 micrometre masks. This is the existing nominal 1.006 mm layer sum. Its general copper table also lists 35 micrometres; retain the documented nominal-stack distinction rather than silently replacing 43 micrometres.
- [JetPCB's capabilities page](https://us.jetpcb.com/rule/capability.aspx) lists **±20% trace-width tolerance**. Therefore 0.15 mm means authored CAD width, not guaranteed finished width. A 20% negative-width sensitivity gives 0.12 mm. The 35 micrometre calculation below is a thickness sensitivity, **not a claimed guaranteed fabrication minimum**. Exact production tolerances remain fabrication inputs, not a prerequisite to making this candidate.
- [Hardware design with RP2350](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008280-DS-2-hardware-design-with-rp2350.pdf), section 3.1, printed pages 10–11, calls for short direct flash connections and keeping the CS pull-up/BOOT isolation resistors close to the flash. It does not impose a 0.20 mm minimum signal width.
- The [official Raspberry Pi Minimal R4-S1 native design](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-010328-CA-1-RP2350A%20Minimal%20KiCAD.zip) provides direct geometric precedent: all **37 saved QSPI segments** are **0.15 mm** wide, across SD0–SD3, SCLK and SS. The retained PCB SHA-256 is `cde2b7e54bf25b443972b8b31214f7880428c40be70d9df9dbd3d0a41fc50b86`; local artifact is `../rp2350-reference-inputs-01/raspberry-pi/RPI-RP2350A-MINIMAL_R4-S1.kicad_pcb`. Its different stackup is not substituted for this board's construction, and its full-net width choice does not broaden this bounded neckdown proposal.

The JetPCB PDF was reopened through the manufacturer's fabrication-page link. Its previously retained identity is 141,386 bytes, SHA-256 `292022cf8c97dc79aa638b97c2f7b30ce5fbf8a082bb3665ab6325bfb6534f9b`; that hash is historical retained evidence, not a new byte-for-byte download assertion in this review.

## Resistance and timing scale

For a straight 1 mm section, use `R = length / (conductivity × width × thickness)` with the existing smooth-copper analysis assumption **58 MS/m**. These are DC geometric estimates, excluding temperature, etch profile and high-frequency effects.

| Copper thickness | R at 0.15 mm width | R at 0.20 mm width | Added R | Extra drop at the existing 4 mA per-net peak target |
| --- | ---: | ---: | ---: | ---: |
| 43 micrometres, nominal stack | 2.673 mΩ | 2.005 mΩ | 0.668 mΩ | 2.673 µV |
| 35 micrometres, sensitivity | 3.284 mΩ | 2.463 mΩ | 0.821 mΩ | 3.284 µV |

At an illustrative finished width of 0.12 mm and 35 micrometre thickness, the same 1 mm section is **4.105 mΩ**. This exposes the tolerance sensitivity rather than asserting a finished-width guarantee. For the existing 10 pF receiving-load target, the added resistance contributes only **0.00668 ps / 0.00821 ps** to a lumped `ΔR × C` time constant at 43/35 micrometres. Even using Winbond's 30 pF AC test load gives **0.02005 ps / 0.02463 ps**. This RC comparison is not a transmission-line or complete edge-response model.

A transparent propagation scale comes from `delay = length × sqrt(effective relative permittivity) / c`. Under the existing idealized homogeneous air/FR4 assumption, taking effective permittivity between 1 and the assumed bulk value 4.5 gives **3.336–7.076 ps for either 1 mm section**. The envelope applies to both widths and both copper-thickness sensitivities; it does not resolve the width-specific effective permittivity. Within that idealized envelope the difference between equal-length sections is bounded by **3.740 ps**, but this is **not** a measured or full electromagnetic delay bound for the real masked structure. No exact zero-delay difference is asserted.

The 75 MHz period is 13.333 ns, and the retained fastest-edge screening input is 1 ns. Thus the local geometric flight-time scale is small relative to both. Width steps still create a local impedance discontinuity; its reflection amplitude and the complete clock/data sampling margin are not established by the DC or timing-scale calculations. Keep the neck short and return copper intact. If multiple terminal necks are needed, record and sum their actual lengths; this table is per 1 mm section.

## Relevant implementation limits

1. Bind each narrow section to its exact terminal and a maximum **routed** length of 1 mm; do not authorize distant narrow segments by planar proximity. Keep 0.20 mm elsewhere and report any required longer neck explicitly.
2. Preserve 0.15 mm clearance to actual pads, traces and other copper. A narrower width does not automatically permit routing between adjacent QFN pads: for example, a 0.15 mm trace between two foreign features needs a 0.45 mm gap when both clearances are 0.15 mm. Check actual rounded-pad and diagonal geometry.
3. Keep uninterrupted B.Cu under the signal, avoid power-switch loops, minimize unnecessary bends and stubs, and keep the CS pull-up/BOOT-resistor junction local. Preserve existing decoupling and ground-access requirements.
4. Retain the [W25Q32RV Rev. E](https://www.winbond.com/resource-files/W25Q32RV_SPI_QPI%20RevE%2011132025%20Plus.pdf) instruction and AC conditions, printed pages 71–73: unaligned fast/quad operation up to 104 MHz, ordinary 03h reads up to 50 MHz, 30 pF AC test load and input rise/fall at most 5 ns. The existing 75 MHz target is for the supported fast/quad mode; correct clock duty, sample delay, setup/hold and dummy cycles still matter. The board's 1 ns value is an explicit screening assumption, not a guaranteed RP2350 edge specification.
5. The route representation and authoring path must explicitly support this bounded width choice. A current software floor of 0.20 mm is not a manufacturer requirement, but it must be changed through the normal reviewed implementation rather than bypassed.

Verification here consists of primary-source review, read-only inspection of the retained Raspberry Pi segment widths and reproducible arithmetic. Only this note was added. No production code, bound draft, native CAD, build, configuration or ordering action was performed.

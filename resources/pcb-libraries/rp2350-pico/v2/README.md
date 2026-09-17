# RP2350 Pico library package v2

Supersedes v1 by adding standalone W25Q32RVXHJQ and USBLC6-2SC6 symbols plus the selected-part XH flash footprint. The RT6150B symbol and all three v1 footprints remain represented. v1 stays immutable. Every admitted file is SHA-256/length pinned; this package grants no global library installation or host configuration authority.

- Flash: 32Mbit /4MiB, JQ QE fixed1; nine visible CAD terminals including passive center metal9. The board chooses GND for9; it is not internally connected to vendor VSS4. In the footprint's left/right pin orientation body X/Y is3x2mm. KiCad-derived PCB lands are distinguished from manufacturer package-contact dimensions in provenance. Procurement, tolerance/assembly and stencil review remain open.
- USB protection: six explicit pins, no inheritance. Pair with separately admitted stock SOT-23-6. Preserve both physical contacts on each data channel.
- RT6150B: fixed3.3V WDFN2.5x2.5mm; FB to VOUT. Do not use the RT6150A3x3mm package.
- Core inductor: choose the exact AOTA MPN and either explicitly named land variant; marked pad1 is1V1, pad2 isLX. Variants have different land coordinates.

No bare Pico header footprint is added. The reference fixes pitch/rows/holes, but exact bare-contact/castellation CAD and the optional fitted header are not qualified. Stock 1x20 courtyard extends beyond the nominal Pico outline; changing a courtyard cannot establish physical fit. See the external qualification record for measured bounds.

Read provenance and NOTICE. Library parsing and native exports establish limited source/geometry checks; they do not establish ERC/DRC, completed board connectivity, assembly, electrical behavior or manufacturing acceptance.

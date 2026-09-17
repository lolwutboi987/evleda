# RP2350 Pico library package v1

One self-contained RT6150B-33GQW symbol and three exact native footprints in `EvlEDA_Pico2350`. The manifest binds every asset and provenance document by SHA-256 and byte length. It grants no installation or global-library authority.

Use the RT6150B footprint for the WDFN-10L **2.5 x 2.5 mm** B part. The 3 x 3 mm A part is incompatible. The symbol shows all 11 physical terminals and explicitly models power/control pin functions. Fixed-output FB must connect to VOUT.

For the separate RP2350 core inductor, select the exact `AOTA-B201610S3R3-101-T` and an explicitly named land variant. `RaspberryPi_Minimal` preserves the reference circuit's compact geometry; `Abracon_Recommended` preserves the larger vendor lands. Both use the marked side as pad1/1V1 and pad2/LX. The inductor is not a symmetric interchangeable placement.

Read `provenance/` and `NOTICE.md`. Copper drawing comparison and native parsing support library review; they do not qualify electrical performance, assembly process or manufacture. EP paste coverage, thermal vias, board-level clearances and routing remain review items. No native board, board revision, DRC/ERC acceptance, fabrication bundle or firmware is produced by this package.

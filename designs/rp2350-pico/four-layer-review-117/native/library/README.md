# RP2350 Pico library package v4

Immutable successor to v3, preserving every existing symbol and footprint byte. Adds one board-only mechanical footprint, EvlEDA_Pico2350:MountingHole_D2.1_Pico, for the official Pico 2 drawing's nominal 2.1 mm (+/-0.05 mm) bare drilled mounting bore.

The new footprint has one centered, netless circular NPTH with an empty pad number and no electrical symbol or BOM part. Attributes exclude it from electrical BOM and placement exports. Its fabrication circle depicts the bore only; no screw-head/washer courtyard is invented. The board-feature contract supplies actual positions and the 0.25 mm minimum hole-to-copper clearance. The host assigns instance UUIDs.

Read provenance/pico-mounting-bore.md and NOTICE. All v3 component selections and qualifications remain. Package/source inspection and isolated native export do not establish completed-board clearance, fabrication tolerance or hardware fit. The v3 electrical selection overlay retains its historical inspection identities; integration must recapture the complete v4 package binding.

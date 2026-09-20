# Bounded complete plane receipts

DOC17 overlays only `evleda_plane_stage/compact_receipt.py` on the complete DOC16
runtime lineage. It permits at most **1,000,000 logical nodes** in the complete
transcript while retaining **500,000 compact nodes**, depth64, the 8 MiB artifact
limit, the 1 MiB individual-source limit and all pool/count limits. No geometry,
clearance, fill, source, ownership or electrical acceptance requirement changes.

The final RP2350 refill exposed this resource gap. A modeled reproduction built
from preserved native stage data and read-only current observations contains
507,408 logical nodes. The earlier encoder rejects it; DOC17 retains it as a
7,180,564-byte compact artifact. The fixture is explicitly a **software resource
study**, not an accepted native stage or recovery record.

The TypeScript decoder uses the corresponding finite 1M logical bound and keeps
the existing wire limits. Regression tests retain exact source/PAD content and
ordering, reject reference amplification above the new bound, and keep legacy
wire/depth/identity rules.

Actual native qualification subsequently completed on the full RP2350 board:
GND_PLANE produced 507,323 logical nodes in 6,774,765 bytes and BACK_GND produced
509,255 logical nodes in 6,118,484 bytes. Both complete stages passed the separate
mandatory save/readback and normal close. See the [source-bound proof](../../../proofs/native-plane-receipt-doc17-20260920/README.md).
The original missing-stage failure remains preserved; this later success does
not recover its lost first cause or establish engineering acceptance.

Install into a new copied runtime and regenerate/verify its complete manifest.
Do not modify a previously pinned runtime. The runtime verifier reconstructs and
checks the full DOC16 predecessor before applying the exact DOC17 source pin.

Overlay SHA-256: `1217cf8a69fcad2c9ee84a857d9faa19f4db25771844dd67ea7645f9c1b185e8`;
size: 3,759 bytes.

# Four-layer native plane stage

DOC16 combines the unchanged DOC14 runtime lineage, DOC15's
`evleda_plane_stage/typed_zone.py`, and this directory's `protocol.json`.
The adapter accepts F.Cu/In1.Cu/In2.Cu/B.Cu, resolves their typed KiCad enum
values, and rejects a disabled layer before mutation. The descriptor publishes
that same bounded set. DOC15 alone still advertises the older outer-layer-only
descriptor and is not the four-layer authoring runtime.

Published source pins:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| DOC15 typed_zone.py | 9946 | c31a98f88eb3e447af99b9738524f0f58f04506d8a349dfa55719d852f70b10e |
| DOC16 protocol.json | 13368 | 1ad0f84fbcc646a5412513c97500ff7daf936e2d48fac622b5b76b8a44102079 |

Install these overlays into a new copied runtime, regenerate its complete
manifest, and bind the resulting closure in the host profile. Do not modify an
existing pinned runtime. `scripts/verify-kicad-inspection-runtime.mjs` checks
the complete lineage and all installed files; it does not grant CAD access or
establish native board acceptance.

See [four-layer construction](../../../docs/four-layer-construction.md) for
the host behavior, native qualification scope and remaining RP2350 work.

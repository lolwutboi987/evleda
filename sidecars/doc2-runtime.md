# Doc2: reviewed schematic-field presentation overlay

`inspection-runtime-3.33.3-doc2` is a separate copy of the still-unchanged doc1
runtime. Its new manifest is `kicad-inspection-runtime-manifest-doc2.json`; older
runtime roots, manifests, profiles and application defaults remain untouched.

The only runtime-file differences from doc1 are:

- the independently reviewed `kicad_mcp/tools/schematic.py` field-layout revision3;
- new pure `kicad_mcp/utils/field_layout.py`;
- the required `environment/pyvenv.cfg` home relocation to doc2's Python directory.

The Python executable, launcher, private live-PCB addon, process terminator,
distribution metadata and all other runtime bytes remain identical to doc1.
Published `kicad-mcp-pro` 3.33.3 wheel provenance is not rewritten or relabeled.
The prior explicit-junction reader patch remains intact.

Patch source and content provenance:
`patches/0002-schematic-field-layout-revision3.patch` and adjacent `.provenance.json`.
These bind the original doc1 source hash and exact resulting bytes; do not apply
the patch to an arbitrary upstream file or install it into an older runtime.

The field planner reuses upstream clearance/text geometry, now reserving own and
neighbour bodies/fields, labels and wires. New presentation setters and parity
checks use quote-aware immediate-child spans: property text resembling `(at ...)`,
`(effects ...)` or `(justify ...)` cannot become a mutation target. Initial symbol
creation adopts a separate candidate only after exact presentation parity; on
unsupported geometry or failure it retains the untouched legacy baseline and
emits an explicit layout-unknown warning. Explicit field repair refuses unsupported
coverage or non-presentation changes before write.

Public constructor/tool signatures and result schemas remain unchanged. The
private field-only transaction branch skips wire normalization and preserves all
non-presentation tokens, node order, UUIDs, values, fonts, visibility and metadata.
All default authoring transactions still use the unchanged original normalizer.

The 0.66 text model and padded geometry are planning estimates, not native glyph
metrics. There is no new native readability PASS. Unsupported arcs/library text,
mirrors, ambiguous units/references, noncardinal rotations, anisotropic fonts and
unquoted comments are not silently treated as clear. Pin-name/number glyphs are
not modeled. A separately source-bound native SVG readability gate remains
necessary; estimated zero overlaps do not substitute for native evidence.

Independent revision3 source review passed. All 26 offline tests also pass against
the installed doc2 modules, including the registered field-tool callback, actual
atomic writer, independent `sexpdata` parity oracle, adversarial quoted values and
partial-setter fallback. Native reload and visual-diff recording are stubbed;
subprocess and KiCad-client construction are forbidden. No GUI/model/native call
was performed during this runtime creation.

Retained stage/review history and rejected revision2 value-corruption reproduction:
`D:\EvlEDA-field-layout-stage-20260909`. Installed-runtime tests and full three-tree
verification evidence: `D:\EvlEDA-doc2-runtime-build-20260909`.

This closure does not change the default check script, active profile or app.
Profile selection and any native validation require their separate authorized steps.

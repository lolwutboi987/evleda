# DOC9 bounded ARC field-layout runtime

Runtime: `C:\EvlEDA-DOC9-20260917`, derived directly from preserved DOC7.
Status: **offline runtime/profile qualified; native field placement passed in
attempt04 and connector import/physical PAD observation/preserving movement passed
in attempt05. Successful checkpoint finalization remains pending**.

| Binding | SHA-256 |
| --- | --- |
| Manifest, 1,574,798 bytes | `28be8d5a44cf635fbb0e50609b8a0ae72e2051f68b7cd9897e78b676cb036738` |
| Manifest identity | `21cdd9a8f3949f5ac2e7ed143932cf2153da140d12959773b34554d980bb1d73` |
| Runtime tree identity | `7f5120eca970b135eb52aa49a9f4936e7bc6871f68184b127425414bd004addf` |
| Source `field_layout.py`, 25,847 bytes | `543f36faf8747907c4044906b6a24cb48cf43bf399bc8986cd4d2192a748c93e` |
| Patch, 7,159 bytes | `798c369c022018d4fe88d6c93979995f0aa5c9992193db689b34d23c471b034e` |
| Provenance, 12,670 bytes | `5bcc8899c65fa4fdf9a2da6737d2fc6d63c64df819493cc9120c87972cccbcdf` |
| New profile, 16,267 bytes | `185503139548f25fd4fd7a90b0ccd928a4754cf098b2ecafeacf740b475f7e85` |

The manifest is transfer
`working-profiles/kicad-inspection-runtime-manifest-doc9.json`; the new profile is
`working-profiles/toolbox-native-doc9-stock-catalog-destination-02.json`.
DOC9 contains 8,467 files and 1,159 directories totaling 150,429,066 bytes. The
only changed runtime leaves are field layout and the relocated Python home.
DOC7's complete closure and manifest were verified before and after; DOC8's
incorrect intentional-NC filtering is excluded.

The retained USB-C native03 schematic embeds six stock ARC primitives that DOC7
rejects during field presentation planning. A pure-memory replay reproduces that
rejection; no original native MCP error text was recovered. DOC9 evaluates bounded
start/mid/end circle sweeps, cardinal extrema and explicit positive stroke width
to supply conservative symbol boxes to the existing field planner. Full source
arcs remain intact. Ambiguous or degenerate arcs, nonfinite/unsupported forms,
default-width arcs, Beziers and library text still reject.

The [patch README](patches/doc9/README.md) states supported syntax and numeric
bounds. [Provenance](patches/doc9/provenance.json) binds the preserved input,
source/patch reproduction, actual closure and qualification reports.

Qualification passed **42 offline Python regressions**: 17 new ARC/planner tests,
12 unchanged footprint-identity tests and 13 unchanged power-flag graph tests.
It includes all six actual USB arcs, both directions/major sweeps, stroke extents,
rejection cases and the existing J1/J2 field mutator on retained input. That
mutator moves J1 in memory while J2 already matches its clear plan; libraries,
presentation signature and source-file bytes remain preserved. Production
registration-only capture retains the exact qualified sync/graph descriptors.

All **40 destination-runtime policy tests** pass, including new source, patch,
provenance, missing/partial DOC7, DOC8-mixing and closure-failure rejection cases.
The actual native and design profile parsers accept the new profile after a full
closure check. Root/manifest, terminator path and launcher-argument identity were
rebound from actual DOC9 paths; argument SHA-256 is
`2fce01c238b141567c1b52ea90bc2bc0eea58c1db202800d04e2011d6ba2fe14`.
The source DOC7 profile, stock catalog, unrelated settings and exact existing
117-file plane-helper manifest/Windows dependency repin remain unchanged. This
does not requalify host DLLs or install/activate the new profile.

The closure builder resumed after the generic `FastMCP` descriptor emitted by the
old DOC6 test differed from production `KiCadFastMCP` normalization. A separate
production registration probe resolved that distinction with exact comparisons;
the copied closure was fully authenticated before resuming. Prior passing test
reports remain retained. No old evidence was rewritten.

No editor, native API operation, MCP server loop, application build, global
configuration change or saved-project mutation occurred in the offline qualification.
The later [attempt04](../docs/rp2350-progress.md) passed native field placement
and saved connectivity, then failed an older host NPTH guard during PCB import.
Attempt05 passed that import and physical-feature/movement checks after the host
guard repair, then failed checkpoint preparation on its retained `Dwgs.User`
technical drawing. The subsequent host reader fix passes offline against the
exact saved source through checkpoint preparation, without publishing a checkpoint
or resuming the failed project. Both failure states remain preserved; no global DOC9
installation or complete successful connector lifecycle is claimed.
Text and pin glyph geometry remain approximate. Passing planner boxes do not
establish native-rendered clearance/readability, ERC, board acceptance or
manufacturing readiness; those require separate native integration and review.

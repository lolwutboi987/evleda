# DOC9 bounded ARC field layout

DOC9 derives directly from frozen `C:\EvlEDA-DOC7-20260910`. It changes only
`kicad_mcp/utils/field_layout.py` and the relocated `environment/pyvenv.cfg` home.
It does **not** contain DOC8's no-connect net filtering. DOC7's PCB writer,
qualified footprint identity, power-flag graph, tool descriptors, mutation fence,
session transaction behavior, deadlines and library source remain unchanged.

## Retained failure and supported geometry

The retained native03 schematic has SHA-256
`55e2d56e6d65e5bab705a891f8d7360ad21f84a47d26b6a7d1bb933f2a93d68d` (22,705 bytes).
It embeds six ARC primitives in `Connector:USB_C_Receptacle_USB2.0_16P` for J1.
The DOC7 pure-memory replay rejects those primitives while building the field
presentation model. This is a replay of the exact retained input, **not recovered
original native MCP error text**. The original project and the fixture copy are
read-only inputs during qualification.

The existing planner uses one conservative axis-aligned obstacle box per symbol,
transformed from library space through its existing cardinal placement rotation
and y-axis inversion. DOC9 adds validated local ARC bounds to the point inventory
that already supplies that box; it does not replace arcs with polylines or remove
any source graphics.

Supported ARC syntax is exactly one each of `start`, `mid`, `end`, `stroke`, and
`fill`, with no extra bare tokens or nested children. Points must be finite decimal
pairs. Stroke requires positive explicit width and `default` or `solid` style;
fill supports `none`, `outline`, and `background`. This follows KiCad's documented
[symbol ARC representation](https://dev-docs.kicad.org/en/file-formats/sexpr-intro/index.html#_symbol_arc)
within a deliberately smaller supported subset. Width zero is rejected because
it depends on native default stroke settings. Dashed strokes, color overrides,
legacy centre/radius forms and unknown forms also reject.

The circle is computed from normalized start-relative vectors. The directed
sweep must pass through the middle point, including clockwise and major sweeps.
Endpoints and every included cardinal extremum contribute to the box. Filled
arcs also include the circle centre, conservatively covering either chord or
sector fill. Half the explicit stroke width and a bounded floating-point guard
expand the result.

Coordinates, centre, radius, and stroke width are bounded to 10,000 mm. Point
separations must exceed 0.000001 mm, normalized determinant magnitude must exceed
0.00000001, and endpoints/middle must resolve the sweep with more than 0.00000001
radians of separation. Coincident/full-circle, collinear, ill-conditioned,
nonfinite, ambiguous, duplicate and unsupported forms fail closed. Beziers,
library text, mirrored/alternate symbols and unsupported sheet obstacles remain
unsupported. No global comparator, mutation fence or obstacle clearance changes.

## Offline qualification

`test_arc_field_layout.py` runs 17 regressions, including 55 analytic sweep cases
with 1,001 sampled points each and four stroke offsets at each point. It checks
all quadrants, both directions, major arcs, cardinal transforms, explicit stroke
extents, filled bounds, rejection cases and all six actual retained USB arcs.

The test also invokes the **existing** schematic tool's
`_build_autoplace_fields_mutator` against the retained fixture, with targets J1 and
J2. It plans and mutates strings in memory only, moves J1's fields and retains J2's
already-clear plan. It checks the final approximate obstacle clearance, unchanged
embedded library text, the complete presentation signature, stale-source rejection,
duplicate-reference rejection and source-file byte preservation. As the native
mutator does, it reads UTF-8 text with universal newline conversion; the original
CRLF fixture's separate byte identity stays exact.

The unchanged DOC6 footprint-identity suite contributes 12 passing tests; the
unchanged DOC7 power-flag graph suite contributes 13. Total: **42 regressions**.
Python is launched with `-I -s -E -B -X utf8`, no mutable ambient import paths and
no bytecode-cache writes. No editor, native API call or MCP server loop runs.
The old suites use owned temporary file fixtures. The ARC suite preserves both
original schematic and retained fixture bytes.

`capture_sync_descriptor.py` separately captures production `KiCadFastMCP`'s
synchronous registration result. The DOC6 test intentionally uses generic
`FastMCP`, whose raw description/annotation differs from the production subclass;
it is not used as the production descriptor proof. The exact production sync and
graph descriptors still equal the existing published fixtures. The first builder
pass stopped at that distinction after all 42 tests passed; authenticated resume
verified the full copied closure before collecting the production registration.

## Closure and profile

`build-runtime.mjs` verifies every frozen DOC7 leaf, reproduces the patch, copies
the complete 8,467-file / 1,159-directory closure, changes exactly the approved
module and Python home, tests the clone, computes the real manifest, independently
verifies it and verifies DOC7 again. It refuses pre-existing output artifacts.
The explicit `--resume-offline` path only resumes retained qualification after a
full comparison of the copied runtime to the exact two-leaf delta; it does not
rewrite prior test reports. Runtime/package metadata and directory closure stay
exact. Published hashes and reports are bound by `provenance.json`.

`prepare-profile.ts` uses the authenticated DOC9 closure and clones exact DOC7
profile02. It rebinds root/manifest identities, total bytes, terminator path and the
domain-separated launcher argument hash. Both actual native and design profile
parsers must accept it. Catalog, all unrelated fields, and the existing 117-file
plane-helper manifest including its Windows dependency repin remain exact. The
script creates a new profile only; it does not install or activate it and does not
requalify host DLLs.

## Limits

This is approximate presentation planning. Existing text width uses the 0.66
model; pin-name/number glyph bounds are not modeled. Conservative ARC AABBs can
reserve more space than the rendered shape. Offline clear boxes are **not** a
native-rendered clearance or schematic-readability verdict. Native field tool
execution, SVG inspection, electrical checks and board/manufacturing acceptance
remain separate. Native integration is parent-owned and pending at publication.

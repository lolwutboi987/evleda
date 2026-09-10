# Source-bound reference coverage helper

This source-only candidate checks geometric coverage for explicit straight signal-route segments against explicitly eligible reference-copper polygon groups. It makes no DC-connectivity, high-frequency electrical-validity, impedance or manufacturing claim. No native editor is required or operated. The host must establish document identity, fresh native fill, net/layer eligibility, route identity and current native connectivity separately.

## Provenance and dependencies

KiCad 10.0.3 commit `146a4f2a7585c65bc580427a19b6fe2ec4a3f622` vendors Clipper2 **1.3.0**. This package includes its unmodified headers and engine implementation, with Boost Software License 1.0. The wrapper also uses BSL-1.0. Preserve the included license and source notices when distributing source. It does not copy KiCad's GPL SHAPE_POLY_SET wrapper.

- Pinned source: https://github.com/KiCad/kicad-source-mirror/tree/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/thirdparty/clipper2
- `source-hashes.json` inventories all included upstream files; build verifies them.
- `fixtures/native-fill.json` exactly preserves native saved-fill interpretation evidence from `D:/EvlEDA-native-plane-probe-20260909/saved-fill-interpretation.json`, SHA256 `8C94690083F6C872EBF39F1681066376A642782ECC1FA203136C2675D1A6F4F3`. It includes raw fractured contours and a native Unfracture oracle, not synthetic replacements.
- Main source SHA256: `496673F8418EBADE4186369A58A098F5BAD5383691455A7EBFBCCE2546F956D5`.
- Demonstrated host executable: `D:/EvlEDA-reference-coverage-helper-20260909/reference-coverage.exe`, SHA256 `8140D71004FB800DA885BC91337E11EFFBDA1B50BA6530741252DCFDA85ED8D7`. No binary/compiler/archive is included in this package.

Build requires a C++17 compiler with signed `__int128` (demonstrated with previously verified portable Zig0.16.0; GCC/Clang convention supported, MSVC is not). There are no downloads, installs, PATH modifications or native runtime changes in the build script. The compiler may use its configured cache.

```powershell
pwsh -NoProfile -File ./build.ps1 -Compiler 'D:/EvlEDA-transmission-line-core-20260909/compiler/zig-x86_64-windows-0.16.0/zig.exe' -Driver zig -OutputDirectory 'D:/EvlEDA-reference-coverage-helper-build'
pwsh -NoProfile -File ./verify.ps1 -Helper 'D:/EvlEDA-reference-coverage-helper-20260909/reference-coverage.exe' -OutputDirectory 'D:/EvlEDA-reference-coverage-helper-tests'
```

Different toolchains/build paths need not reproduce identical binary hashes. Pin the actual built executable selected by the host.

## Input protocol

Invocation is exactly `reference-coverage.exe --input <request-file-path>`. There are no model names, commands or output paths within the request. The helper reads the file once, at most 8 MiB, and echoes those exact bytes as base64. Host verification must compare that echo with its bound request bytes; merely reproducing an equivalent parsed request is not sufficient.

Input is ASCII, with spaces/tabs/CR/LF as whitespace. Integers use decimal signed notation supported by `from_chars`; fractional/exponential tokens are rejected. Grammar:

```text
EVLEDA_REFERENCE_COVERAGE 1
GROUPS <group-count>
GROUP <ring-count>
RING <vertex-count>
<x-nm> <y-nm>
... exactly vertex-count pairs ...
... exactly ring-count RING records ...
... exactly group-count GROUP records ...
ROUTES <route-count>
ROUTE <x1-nm> <y1-nm> <x2-nm> <y2-nm> <width-nm> <margin-nm>
... exactly route-count ROUTE records ...
END
```

Each group's first ring is its outline; following rings are explicit subtractive holes. The outline may be a native fractured contour containing a void connected by reverse bridge edges. Its fill semantics are NonZero winding. Each explicit hole is independently NonZero-filled and subtracted; overlapping holes remain holes. Independent groups combine by union, irrespective of their original orientations. The helper does not infer a void inventory from the typed holes count.

Bounds are ±2,000,000,000 nm for every input coordinate and the constructed outer envelope; at most 128 groups, 512 total rings, 8192 total vertices and 64 routes. Groups can be absent, but at least one route is required. Every ring has at least three vertices, no consecutive duplicate/zero-length edge, no repeated closing vertex and nonzero signed area. Routes must have distinct endpoints, positive width <=2e9 nm, and margin in [0,2e9] nm. Margin is explicitly beyond the copper trace edge, so the Euclidean reference ribbon radius is width/2 + margin. No 3h or other electrical margin is inserted.

## Sound conservative classification

The geometric target is the **closed Euclidean capsule** for each straight route segment with that radius. The helper uses exact integer envelopes: the convex hull of endpoint-translated L1 diamonds at floor(radius) is inside the capsule; the convex hull of endpoint-translated axis-aligned squares at ceil(radius) contains it. The coarse envelopes can produce uncertainty. Their diagonal radial factors approach 1/sqrt(2) and sqrt(2); they are not intended as tight approximations to a circle.

`covered` requires an exact certificate against the **original input rings**, not Clipper's rounded output: one outer-envelope vertex is strictly inside the union; no retained original boundary edge enters, intersects or touches the outer envelope; and no retained boundary endpoint lies inside/on it. The connected convex envelope then remains inside one arrangement face. Exact reverse directed edges cancel only within the same ring, allowing tested native fracture bridges to disappear from boundary obstacles. Winding membership still uses the original ring, so some bridge-related contacts can conservatively remain uncertain.

`uncovered` requires an explicit doubled-nanometer witness strictly inside the inner envelope and strictly outside every original group. Clipper missing-polygon vertices and bounding-box midpoints are only witness candidates; exact original-ring predicates revalidate them. The dyadic point is recorded as `outsideWitnessDoubledNm`. For example [10000,-1] means (5000,-0.5) nm, not rounded (5000,0).

Everything else is `boundary_uncertain`, including some genuine covered cases with overlapping groups' internal boundaries, exact tangency, narrow bands between the envelopes, and width=1 nm where the inner envelope can degenerate. This is deliberate: no rounded Boolean emptiness becomes an unqualified pass. Exact predicates use signed 128-bit orientation arithmetic and an aggregate 20-million-predicate work limit. Independent mathematical/code review approved these certificate semantics under the declared bounds.

Clipper64 provides normalized copper and outer-envelope difference polygons only as inspectable, integer-quantized diagnostic geometry. Polygon rounding or tiny-feature collapse cannot authorize a covered status. Arcs, curved routes, via/layer transitions and electrical return-current decisions are outside this input model. Host policy may require H/V/45 routing separately; the helper supports arbitrary straight angles geometrically.

## Output protocol and resource handling

Every output object identifies `schemaVersion:1`, `implementationRevision:"evleda-reference-coverage-v1"`, `sourceCommit` and `clipperVersion:"1.3.0"`.

Success (exit 0) includes `inputBase64`, `coordinateUnit:"nm"`, `normalizedCopper` paths, and `routes`. Each route result includes its zero-based `routeIndex`, `status`, `certificate`, `innerEnvelope`, `outerEnvelope`, `uncoveredOuterEnvelope`, and an outside witness when certified uncovered. Paths are arrays of [x,y] integer vertices; normalized exterior/hole orientation follows Clipper output conventions. Diagnostic model strings and `dcConnectivityClaimed:false`, `hfElectricalValidityClaimed:false` are included.

All three geometric statuses are successful computations; the host must not interpret exit 0 as coverage acceptance. Errors (exit 1) contain an `error` code and input echo if bounded reading succeeded. Input over the byte limit is rejected before echo; errors must never become passes. There is no stderr dependence or partial successful stdout.

Output is bounded to 16 MiB and 65536 total emitted polygon vertices, with per-operation vertex checks and exact-predicate work limits. This does not replace the host's deadline, process-memory/output bounds or request identity checks; a pathological Boolean operation may be expensive before its output is inspected. The host should cap the process and reject truncated/non-JSON output. Arithmetic bounds refer to coordinates and predicates, not a guarantee of arbitrary-input performance.

## Verification evidence

The demonstrated executable passed **34 arbitrary-input cases plus two native-oracle normalized-geometry comparisons**, recorded in `D:/EvlEDA-reference-coverage-helper-20260909/checks-v3/results.json`, SHA256 `9E6C1B245154AFF322D5E64D2CB2562446A3050830B5D7BB3D9F20D568FF435B`.

Coverage includes native fractured holes/bridges and two-island geometry, duplicate and reversed groups, overlapping explicit holes, hole enclosed inside the route envelope, diagonal/edge/margin cases, empty copper, exact input-byte echo, invalid grammar/ranges/zero-length routes/zero width/count limits, 8 MiB rejection, and a 500-hole/64-route output-limit case. Canonical normalized contour comparisons against native Unfracture ignore only collinear vertices and cyclic starting position.

Independent boundary cases show exact tangent -> uncertain, 1 nm clearance -> covered, and 1 nm penetration -> uncovered with a verified half-nanometer witness. An earlier test expectation permitted only uncertainty for the last case; it was corrected after the helper supplied that valid stronger certificate. The earlier isolated inputs remain in checks-v2. No formula or predicate was changed to satisfy the test.

The previous fixed Clipper prototype's 18 checks remain separate historical evidence. The arbitrary-input suite reuses its essential geometry cases and native oracles; it does not relabel old results as execution of this helper. These are closed fixtures, not full source-bound native signal-route capture or electrical qualification. No native editor or DOC3 state was changed.

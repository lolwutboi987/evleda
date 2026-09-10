# Stock-library discovery and selected-source binding

The toolbox can now search host-approved KiCad 10 stock namespaces, inspect selected IDs and compile a draft against their exact source identities. This broadens discovery beyond a small exact-ID fixture profile. **Search results are candidates, not qualified components.** The installed global client still uses exact profile03; catalog installation, desktop activation and a native catalog-backed project remain unverified.

## Search, inspect, then submit

When the host supplies a stock catalog, `evleda_search_library` appears as an optional workspace tool. For example:

```json
{"kind":"symbol","query":"capacitor","library":"Device","limit":20}
```

Use `kind: "footprint"` to search footprints, then call `evleda_inspect_library` with each selected `kind` and exact `libraryId` before drafting. Search metadata, a default footprint or a datasheet URL does not establish supported physical geometry, pin/pad compatibility or electrical suitability. Inspection can refuse unsupported native forms; do not replace them with guessed geometry.

Queries use literal ASCII letters, digits, spaces and `_ . : + @ ~ -`, up to 128 characters and eight tokens; `..` is rejected. Tokens match case-insensitively against source metadata. An empty query browses. Optional `library` selects one approved namespace; `limit` is 1–100, default 20. Filesystem paths, wildcard expansion and arbitrary namespaces are not search inputs.

Follow `nextCursor` with the same request until `exhausted`. Each 32-character cursor is single-use and connection-local; at most 16 states are retained. Restart after a lost cursor response, expired cursor or changed source. Each page scans at most eight source reads, 16 libraries and 2,048 candidates, so fewer than the requested results can still require another page.

The response schema is `evleda.kicad-stock-catalog-search.v1`. `exhausted` means no search work remains; `complete` additionally requires no unsupported source coverage. Inspect `unsupported`, per-candidate status and scan counts. A fully scanned source can still contain explicitly unsupported derived symbols. The reported snapshot is `per-source-read-not-atomic`: separate reads are not a frozen installation-wide snapshot. See the [catalog implementation](../src/harness/kicad-stock-catalog.ts) and [public tool schema](../src/mcp/toolbox-workspace.ts).

## Host policy and persisted source selection

The toolbox-only `libraries` profile section accepts strict schema `evleda.kicad-stock-catalog-policy.v1`, `mode: "stock_catalog"`, `kicadMajorVersion: 10`, canonical `symbolRoot`/`footprintRoot`, and sorted, unique approved `stockSymbolNicknames`/`stockFootprintNicknames` arrays. The host supplies and pins these values; MCP callers cannot change roots or policy. Existing exact-ID profiles and the Flux profile path retain their earlier behavior.

The compiler captures selected source bytes, inspection identities and catalog-policy identity in optional `libraryBinding.sourceSelection`. It checks them before and after resolution/rebuild, before native allocation/open and during resume/current-source guards. Catalog-backed bundles missing those pins are rejected; the host does not manufacture historical pins from IDs. Legacy exact-profile bundles retain their omitted-field shape. The [source-binding implementation](../src/harness/pcb-library-source-binding.ts) preserves the exact selected set and canonical identity without exposing source paths in the public selection.

## Current evidence and remaining scope

The prepared [catalog profile01](../../working-profiles/toolbox-native-doc6-stock-catalog-destination-01.json) approves **222 symbol and 155 footprint namespaces** from the installed stock libraries. It is 16,205 bytes, SHA-256 `6bfd1117c94746b05b2fc8f25b35a187d1b225d1b28e76f8f0a54e777b28d61f`. Approval of namespaces is not inspection or qualification of every entry.

The primary [public03 report](../../destination-verification/stock-catalog-01/public-03/report.json), SHA-256 `b41f35f0b6db675d188cdf6669e95e40c8e41c1f5c67e548e0c1e5b6c54709f9`, passed **18 public MCP calls through InMemoryTransport against the real installed stock files**, with 15 initial tools. It discovered and inspected `Device:C` and `Capacitor_SMD:C_0603_1608Metric` beyond the old profile, and produced a ready V2 RC software draft with six selected IDs pinned. It opened no CAD session, created no project and closed normally. RP2350A/B were discovered but remained uninspected; derived RP2354A/B were explicitly unsupported.

Public03 corrects the RC output DC-voltage assertion to match its input while retaining the same six selected-source pins. [Public02](../../destination-verification/stock-catalog-01/public-02/report.json) remains preserved with the earlier divider's 1.65 V software assertion; its discovery result is not electrical validation. The [original public01 report](../../destination-verification/stock-catalog-01/public-01/report.json) remains failed because its probe expected R2 in the deliberately unresolved schema example. The corrected probe used an existing fixture.

The [integrated02 suite](../../destination-verification/stock-catalog-integration-02.json) passed **538 tests / zero failures / five skips**. Two skips require Windows symlink permissions; three retain legacy `D:` installation dependencies. [Integrated01](../../destination-verification/stock-catalog-integration-01.json) remains failed at **496 passed / two failed / three skipped**; source-drift error preservation was repaired before the later run. The earlier [128-test profile/workspace suite](../../destination-verification/stock-catalog-profile-workspace-01.json) remains separate. These are focused suites, not a new full-suite pass.

[Source/UI typecheck03](../../destination-verification/stock-catalog-typecheck-03.log) and the [DOC6-verified build02](../../destination-verification/stock-catalog-build-02.log) passed; the existing 579.71 kB UI-chunk warning remained non-failing. The built command then passed [four read-only calls over actual STDIO](../../destination-verification/stock-catalog-01/preflight/workspace-preflight.json), with 15 tools and a 703.386 ms connection. That preflight opened no native project or model session; its SHA-256 is `b5ecb2b925bc15bc73446eb8b08ec3c903362130171b06bf47ced7045018acad`.

The first [native catalog attempt](../../destination-catalog-native-01/native-run-result.json), SHA-256 `bdfb253c7914619b6d115a037b6be65eee0fdc655bc48fad5566f131520a8ed1`, **failed at operation007, `evleda_create_project`**, during `bridge-revalidation` with `kicad-verification-deadline`. The [original workspace report](../../destination-catalog-native-01/evidence/workspace-proof-ac0ba55d-ece0-4280-a750-eb4704b883e2/report.json) is retained at SHA-256 `71dd93d1acb1a2169b194d87c0e79e3702ff87802c630cc2fbe61b7422a5d1de`. The 92.554-second create-call duration includes cleanup; it is not the verification deadline. No authoring, previews or resume followed. Toolbox-session cleanup was confirmed, but bridge/host cleanup was unconfirmed. Observed process absence does not release the retained allocation/lease.

Source inspection places the new catalog checks outside the native connect deadline. The existing 30-second connect budget spans preverification, MCP connection, deferred project binding and post-bind full-runtime verification; no per-phase native timing establishes a more specific cause. A separate [runtime-only probe](../../destination-verification/stock-catalog-01/runtime-probe/after-catalog-native01.json) passed factory verification in 8.315 seconds and current-runtime assertion in 9.069 seconds, each retaining 20,861 directory and 192,705 file operations. That probe is not native qualification. A separately versioned, opt-in post-bind verification window is planned, not implemented in this evidence snapshot; existing profiles and checks remain unchanged.

The [installed client](destination-client-installation.md) still uses profile03's three-symbol/three-footprint allowlist and 14-tool initial catalog. Next work is a catalog-backed native/client workflow and representative QFN/source coverage, followed by the unresolved chosen GitHub destination and requested RP2350 board in their existing order. Discovery and a ready draft do not approve a board.

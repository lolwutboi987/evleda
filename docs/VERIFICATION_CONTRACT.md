# Deterministic verification contract

AI output is never authoritative for electrical safety, design-rule compliance, connectivity, manufacturability, or algorithm success.

## Result algebra

Every check produces exactly one state:

- `PASS`
- `FAIL`
- `NOT_RUN`
- `NOT_APPLICABLE`
- `WAIVED`

Unknown, timed out, crashed, unsupported, stale, and missing-evidence states never collapse to `PASS`.

A check result binds its stable rule ID, rule version, severity, exact design revision, input artifact hashes, tool manifest, parameters, deterministic evidence, duration, and worker signature.

## Mutation gate

Every staged mutation runs, in order:

1. Schema, units, UUID, referential-integrity, and command-precondition checks.
2. Design-graph invariants and schematic/PCB/BOM/simulation identity parity.
3. Pin type, pin-to-pad, package, and exact-MPN provenance checks.
4. Electrical topology, power-domain, interface, and unconnected-pin checks.
5. Incremental native ERC and PCB geometry DRC.
6. Compile to a staged KiCad project, reopen it, and compare semantic hashes.
7. KiCad ERC and DRC under a pinned toolchain.
8. Datasheet and design-intent calculations: ratings, current and rail budgets, pull networks, decoupling, thermal, interface, creepage, and timing constraints.
9. Simulation assertions when qualified models and test benches exist.
10. Semantic diff, visual diff, and expected-change coverage.
11. Independent manufacturing-export inspection for a release candidate.

If native and KiCad engines disagree, the gate emits `FAIL_ENGINE_DISAGREEMENT`. It never chooses the convenient answer.

## Severity policy

Stable rule IDs use namespaced identifiers such as:

- `SCHEMA.UUID.UNIQUE`
- `GRAPH.CROSS_VIEW.NET_PARITY`
- `ELEC.POWER.UNDRIVEN_INPUT`
- `ELEC.RATING.VOLTAGE_MARGIN`
- `PART.PIN_PAD.PARITY`
- `PCB.CLEARANCE.VOLTAGE_CLASS`
- `PCB.CONNECTIVITY.REQUIRED_NET`
- `MFG.ANNULAR_RING.MINIMUM`
- `ALG.PLACEMENT.REPLAY_HASH`
- `ALG.ROUTE.CONSTRAINT_SATISFACTION`
- `ENGINE.KICAD.PARITY`

`BLOCKER` and `ERROR` failures prevent commit. `WARNING` findings require explicit disposition. A waiver is a separate, signed artifact with a reason, scope, owner, expiry, and bound revision; it does not alter the original finding.

### Copper-zone truthfulness

A zone definition is not assumed to be poured copper. Canonical and
verification graphs distinguish exactly two states:

- `UNFILLED_INTENT` is the default accepted by product commands and KiCad
  definition imports. Its zone ID, net, layer, simple outline, and non-negative
  clearance are validated, but its polygon is excluded from copper-clearance,
  board-edge-clearance, via-attachment, and routed-connectivity calculations.
  Verification emits the stable warning `GEO.ZONE.FILL_UNVERIFIED`.
- `VERIFIED_FILLED` requires exact `ZoneFillEvidence` binding a source graph
  hash, source revision, fill-engine ID and revision, exact filled-geometry
  hash, and a domain-separated evidence hash. The state without this evidence,
  stale/tampered evidence, booleans, and subclasses fail closed. Only then does
  the simple polygon participate in exact copper checks.

Under the strict gates, the warning permits preview and commit because those
gates block at fatal and error respectively. Manufacturing blocks at warning,
and still independently requires trusted KiCad DRC evidence. Thus an unfilled
zone can never silently become a release claim. The rule is mandatory: policy
overrides cannot disable it or lower it below warning. Durable graph documents use
codec version 5; version-4 zone documents require an explicit reviewed
migration rather than receiving an inferred fill state.

## Placement and routing

Every candidate records:

- solver name and semantic version;
- code and configuration hashes;
- random seed;
- source revision;
- full constraint-set hash;
- objective vector and score components;
- runtime and resource budget;
- candidate artifact hash.

Acceptance requires:

- 100% hard-constraint satisfaction;
- zero hard DRC violations;
- zero unrouted required nets;
- all locked objects and protected critical routes unchanged;
- differential-pair spacing, skew, and length targets satisfied;
- width, via, clearance, edge, thermal, and fabrication limits satisfied;
- deterministic replay produces the same candidate hash.

Native routing verification also applies the stable
`ALG.ROUTING.REDUNDANT_COPPER` rule (version `1.0.0`). On one net and copper
layer, two tracks may meet at exactly one endpoint but may not share any
positive-length collinear interval. This rejects orientation-reversed exact
duplicates, contained segments, and partial overlaps using integer cross
products and original integer endpoints only. Two vias on the same net may not
share both an exact center and an identical normalized layer span. Findings bind
the sorted entity IDs and the exact overlap endpoints (or via center/layers) as
deterministic evidence. Pads remain outside this rule, and different-net contact
continues to be governed by `GEO.COPPER.MIN_CLEARANCE`. Same-net track-to-via
contact is an intended layer-transition attachment and is therefore not treated
as duplicate copper.

The language model may author intent and candidate constraints. It cannot assert that a candidate meets them.

## Release gate

A release requires two independent artifact paths:

1. native graph → deterministic checks → KiCad compilation → KiCad checks;
2. manufacturing exports → independent Gerber/drill/net/BOM/PnP readers.

The paths must agree on board outline, layer count, drill inventory, component population, reference designators, net connectivity, and release revision. Release bundles are content-addressed and reproducible from the immutable revision plus pinned tool manifest.

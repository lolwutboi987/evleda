# Canonical copper-zone fill contract

The design kernel stores zone *intent* separately from authoritative copper.
This prevents a board-sized GND polygon from being treated as a solid short
before KiCad or another pinned fill engine has actually resolved clearances,
islands, thermal behavior, and obstacles.

## State transition

`zone.add` always creates `UNFILLED_INTENT`. Its payload deliberately has no
fill-state or fill-evidence field, so an agent, CLI caller, or chat/MCP client
cannot self-assert completion. The kernel validates the intent's identifier,
net, layer, simple polygon, clearance, thickness, priority, and locked flag.

`bind_verified_zone_fill` is the typed worker-boundary operation. It accepts an
exact normalized source `DesignGraph` containing the exact unfilled zone and a
source revision plus fill-engine identity. It derives the source graph hash and
filled-geometry hash itself, then returns a `VERIFIED_FILLED` zone carrying
deterministic `ZoneFillEvidence`. The operation currently represents only a
simple filled polygon; a real KiCad result with holes, thermal spokes, or
multiple islands must not be flattened into it. Such a result needs a richer
future filled-copper model before it can be authoritative.

## Verification behavior

Both states undergo reference and outline validation. Only
`VERIFIED_FILLED` zones enter inter-net clearance, board-edge clearance,
via-attachment, and connectivity calculations. Every `UNFILLED_INTENT` emits
`GEO.ZONE.FILL_UNVERIFIED` at warning severity. Strict preview and commit gates
can therefore proceed while manufacturing release remains blocked. The rule is
mandatory and cannot be disabled or severity-downgraded below warning by a
policy override.

## Persistence and replay

Fill state and all evidence fields are canonical JSON and participate in graph,
revision, verification-input, rule-set, finding, and report hashes. Project
documents use codec version 5. Older version-4 documents are rejected for an
explicit migration because their zone records do not prove whether a real fill
engine ran. Decoder paths accept neither missing fields nor implicit defaults,
and verified-state restoration repeats geometry/provenance hash validation.

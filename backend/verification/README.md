# Deterministic PCB verification core

This package is the authoritative verification boundary for EvlEDA. It is
intentionally standard-library-only and does not import the
agent runtime, MCP clients, network clients, clocks, random sources, shells, or
language models.

## Invariants

- Geometry uses integer nanometres and exact rational squared-distance tests.
- The board graph, policy, rule registry, findings, gates, and reports use
  canonical JSON and domain-separated SHA-256 evidence hashes.
- Stable rule IDs are versioned independently. Rule output is sorted by
  severity, rule ID, entity references, and finding ID.
- Mandatory fatal coverage and integrity rules cannot be disabled,
  severity-downgraded, exempted from, or scoped out of a required gate.
- Every configured rule records `pass`, `fail`, or `not_run`. A required gate
  blocks when any selected rule is `not_run`; absence of findings is never
  treated as proof that a disabled evaluator passed.
- The rule-set hash binds the verification package code bundle, each evaluator
  module and collaborator state, and canonical fingerprints of the live
  evaluator, algorithm, and geometry method bytecode. Identity is checked
  before and after execution so a mid-run implementation change fails closed.
- An evaluator exception fails the entire run closed; a partial report is never
  authoritative.
- An LLM may propose a versioned policy for explicit user approval, but only
  this engine computes findings and gate decisions.

## Modeled copper envelope

- Schema 2 separates logical pins from exact `PhysicalPad` copper and exact
  plated/NPTH drill records. Quadrant circle, rect, oval, and slot geometry is
  checked with rational point/segment/box primitives; see
  `docs/REALISTIC_PAD_GEOMETRY.md` for the versioned contract and blockers.
- Vias are circular plated copper spanning their declared layer tuple and must
  touch copper on their declared net.
- Zones are simple filled polygons on one copper layer. Their outline and
  clearance are authoritative; keepouts, thermal spokes, curved edges,
  and unpoured zone definitions must remain explicit unsupported features at
  an adapter boundary rather than being flattened into this model.
- Pad/via annular rings, drill containment, layer membership, pad/track/via/
  zone clearance, zone-to-edge clearance, and copper connectivity use only
  integer or exact rational comparisons.

## Default gates

`strict_policy()` exposes three deterministic decisions:

- `preview` blocks fatal findings.
- `commit` blocks error or fatal findings.
- `manufacturing-release` blocks warning, error, or fatal findings and remains
  unavailable until a separately trusted KiCad DRC attestation is integrated.

Every supplied policy must retain all three standard gate IDs. A threshold may
be stricter than the strict-policy value, but never weaker; required gates also
cannot scope or exempt rules, and manufacturing must retain the trusted KiCad
evidence requirement.

Call `VerificationEngine().verify(board)` to use the strict policy. The report
contains the normalized input hash, resolved rule-set hash, evidence hash for
every finding and gate, plus a whole-report hash.

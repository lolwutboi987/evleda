# Durable orchestration core

This package is the dependency-free reference implementation for coordinating
an elastic AI hardware team. It separates the user-visible PCB workflow from
worker execution mechanics and fails closed at both boundaries.

## Invariants

- The exact workflow is questioning → brief approval → research → architecture
  and BOM approval → schematic approval → layout-constraint approval → placement
  approval → routing approval → release verification and approval.
- A blocking question contains at least two options, an explicit recommendation
  and integer confidence, affected/dependent IDs, and the exact revision it binds.
- Every approval binds an immutable subject digest. A receipt for one plan,
  changeset, checkpoint, or release cannot authorize another.
- A run can enqueue any number of tasks and agents. The scheduler leases only the
  configured physical concurrency and holds later task waves behind a barrier.
- Scheduling is stable under input reordering. Priority, wave, creation sequence,
  capability fit, role, exclusion, and ID are deterministic tie-breakers.
- A task lease is bound to the exact immutable task contract, worker identity,
  capabilities, run/task/agent/attempt, acquisition time, and expiry. Every
  start, heartbeat, completion, failure, and reap recomputes its HMAC using a
  deployment secret of at least 32 bytes. Heartbeats re-sign the new expiry;
  an old token cannot extend or finish the renewed lease. Stale, rebound, or
  forged workers fail closed. Expiration uses bounded deterministic backoff.
- Product runs seal the complete immutable task-contract inventory into the run.
  Completion and release recompute that digest from the full supplied context;
  omitted tasks, duplicates, contract substitutions, or post-seal durable task
  additions fail closed.
- Critical reviews require an actual `critic` agent distinct from every reviewed
  task's completing agent. Each review contract binds the exact reviewed result
  digest, including the target contract, completing agent, and complete evidence
  records. Rebinding a review to different output or evidence is rejected.
- Success requires immutable evidence. Design checks must come from the exact
  trusted source and policy digest declared by `CheckRequirement`; missing,
  duplicate, failed, untrusted, or stale-policy evidence is rejected.
- `None` budget limits mean intentionally unlimited total work. Reservations keep
  finite budgets from being oversubscribed by concurrent dispatches.
- SQLite snapshots use canonical JSON, exact scalar/record types, index/body
  cross-checks, sealed task inventories, and optimistic run revisions. Missing
  fields cannot inherit dataclass defaults during restore. Events are append-only,
  monotonically sequenced, evidence-linked, and SHA-256 chained. A coordination
  decision, its records, evidence, and events can commit atomically.

## Integration boundary

The API/application layer should load the run plus its questions, approvals,
tasks, agents, and evidence in one store transaction; invoke the pure state machine or
scheduler; create evidence/events; then persist with `commit_snapshot` using the
previous run revision. A revision conflict causes the entire command to retry.

The deterministic verification engine should convert a pinned report/gate into
`Evidence(kind=DESIGN_CHECK)` using:

- `check_id`: stable gate or rule ID;
- `source`: trusted worker/tool identity;
- `policy_digest`: exact resolved rule-set/tool policy hash;
- `content_digest`: report or gate evidence hash;
- `passed`: authoritative deterministic decision.

Agent-authored prose and self-reported tool results must never be labeled as
design-check evidence.

`Evidence` is currently an immutable value record, not a cryptographic worker
attestation. The scheduler checks its task/run/source/policy bindings, but a
caller that can construct arbitrary `Evidence` can also copy a trusted source
name. Until a mandatory verifier/keyring and rollback-resistant orchestration
anchor are wired in, the scheduler and SQLite store are a trusted in-process
boundary and must not accept records directly from untrusted workers. This is a
known release blocker, not a manufacturing or commit authority.

## Tests

From the repository root:

```powershell
python -m unittest discover -s tests -v
```

The orchestration suite covers digest-bound approvals, question gates, the full
checkpoint sequence, stable scheduling, best-fit roles, exact-result independent
critics, sealed task inventories, wave barriers, budgets, lease expiry/retry,
strict evidence, canonical snapshot restore, atomic rollback, optimistic locking,
and event-chain tampering.

# Canonical-import stage operation journal

This package is the durable, stage-only orchestration boundary for one exact
`AuthorizedImportStagingInput`. It closes both crash windows around creating an
OPEN project transaction and staging its candidate. It grants no commit,
verification-release, manufacturing, or export authority.

## Mandatory trust adapters

Construction fails unless the host injects all four server-owned adapters and
a stable, secret `receipt_mac_key` of at least 32 exact bytes:

1. `StageAuthorizationVerifier` authenticates the approval issuer seal, exact
   staging-service principal, current approval authority, and an independently
   durable one-use consumption fence. `verify_and_consume` must be exactly
   idempotent; `verify_live` must re-read the approval ledger and fence.
2. `TrustedStageEvidenceProvider` queries the real project/transaction,
   candidate, mapping-evidence, run, coordination, target-store, and principal
   stores. It must never turn request JSON or caller-provided hashes into an
   attestation.
3. `ExclusiveStageExecutionCoordinator` supplies a cross-process exclusive
   lease with a monotonic fencing token. The lease is validated immediately
   before and after callbacks and is held until their journal projections are
   durable. `FileStageExecutionCoordinator` is the included local-filesystem
   implementation: an OS byte-range lock releases on process death and SQLite
   durably increments the per-operation fencing token.
4. `MonotonicStageJournalAnchor` is independently durable and
   rollback-resistant. Its CAS atomically advances both the exact operation
   head and a journal-wide catalog head while retaining the complete canonical
   transition envelope. It prevents old-file restore, clean database
   replacement, row removal, authorization reuse, and rebinding.

The receipt MAC key must survive journal restarts and must not be exposed to
callers. Replacing it intentionally invalidates every previously issued
verified capability.

These protocols are strict integration boundaries. If a deployment cannot
query or attest one of them, the safe behavior is to leave staging disabled.

## Required integration order

No caller may invoke `ProjectStore.save_transaction`, a `DesignKernel` staging
method, or candidate CAS directly after `prepare`. The safe order is:

1. Call `journal.prepare(authorization, service_actor=...)`. The trusted
   verifier authenticates and consumes the seal; the journal claims its
   external anchor and durably commits PREPARED.
2. Enter `journal.execution_guard(operation_id, expected_generation=0, ...)`.
   After its exclusive lease, the journal re-reads SQLite and external heads,
   checks session/expiry, calls `verify_live`, and attests exact current
   project/run/candidate/mapping/principal authority.
3. Call `guard.execute_transaction_open(callback)`. The trusted provider first
   preflights the exact transaction. If the exact OPEN effect already exists,
   the callback is skipped. If it is ABSENT, the journal externally anchors and
   commits TRANSACTION_OPEN_STARTED, including live authorization, authority,
   preflight, lease, and fencing evidence, before calling the callback. Under
   the same lease, the journal revalidates the fence and authority after the
   callback and asks the provider to inspect the real durable OPEN transaction.
   Only that evidence appends TRANSACTION_OPEN.
4. Call `guard.execute_candidate_stage(callback)`. Candidate preflight likewise
   skips a callback only for the exact already-STAGED CAS successor and exact
   correlation receipt. Otherwise CANDIDATE_STAGE_STARTED is anchored and
   committed before the callback receives the binding and correlation digest.
   The journal checks expiry and its fencing token before and after the
   callback, reauthenticates approval/principal authority, and requires the
   provider to inspect the exact STAGED candidate and transaction snapshot
   before CANDIDATE_STAGED is appended.
5. Exit only after both calls. A callback `BaseException` first attempts to
   append SIDE_EFFECT_UNCERTAIN without replacing the original exception.
   Normal or exceptional incomplete exit then records provider-attested
   RECOVERY_REQUIRED when that provider is available. If evidence or projection
   is unavailable, the already durable `*_STARTED`/SIDE_EFFECT_UNCERTAIN state
   itself blocks every same-session and restarted forward retry. A crash
   releases the external lease; a later process may acquire only recovery.

Callers supply callbacks, not transaction generations, snapshot hashes,
candidate event heads, recovery observations, or rollback receipt hashes. The
old raw `mark_*` transition APIs intentionally do not exist.

## Recovery order

After restart, PREPARED, TRANSACTION_OPEN_STARTED, TRANSACTION_OPEN,
CANDIDATE_STAGE_STARTED, SIDE_EFFECT_UNCERTAIN, and ROLLBACK_STARTED are
rollback-only. There is no forward recovery proof in this package.

1. Enter `journal.recovery_guard(...)`. The same exclusive coordinator first
   proves no live execution owner holds the operation.
2. The trusted provider queries transaction and candidate stores. Its
   attestation drives RECOVERY_REQUIRED; caller hashes and reasons do not.
3. Call `guard.execute_rollback(callback)`. A recovery preflight skips the
   callback when rollback/absence is already exact. Otherwise ROLLBACK_STARTED
   is durably anchored before the callback. Post-callback lease validation and
   provider proof that the transaction is ABSENT/ROLLED_BACK and candidate is
   RESOLVED/INVALIDATED are required before ROLLED_BACK can be appended.

A future forward-recovery design would need a separate proof of the exact
kernel transaction and exact candidate receipt. That authority is absent here.

## Outcome versus correlation receipt

`binding.candidate_stage_receipt_sha256` is only a target-bound correlation
digest safe to pass to the candidate callback. It is not an outcome receipt.

`operation.completed_stage_receipt` is only an unauthenticated audit record and
exists only while the current state is CANDIDATE_STAGED. A manually constructed
`StageOperation`, `StageOperationEvent`, or `CompletedStageReceipt` never
constitutes authority. Entering RECOVERY_REQUIRED or ROLLED_BACK makes the
property return `None`.

Downstream acceptance has exactly two journal calls:

1. `journal.verify_completed_stage_receipt(raw_receipt)` exact-type checks the
   receipt, re-reads the hash-chained operation and both anchors, queries live
   exact transaction/candidate effects through the trusted provider, and
   returns an opaque journal-MACed `VerifiedStageCapability`.
2. `journal.require_verified_stage_capability(capability)` must be called again
   immediately at the acceptance boundary. It exact-type checks and verifies
   the MAC/issuer, rejects any journal successor or revocation, and re-reads both
   live effects. Raw receipts are rejected by this method.

Even the verified capability grants neither internal commit nor manufacturing
authority; it only authenticates that this exact stage outcome is still live.

## Persisted binding and state machine

PREPARED binds the full authorization and digest, issuer seal, approval
consumption fence, source snapshot, and principal-authority snapshot,
project/run/coordination heads and
incarnations, target store, exact candidate and ACTIVE mapping versions,
transaction ID, ordered commands, graph/state and preview digests, review
manifest, separated human/service principals, issue/expiry clocks, all trust
adapter identities, journal key/incarnation, and original random process
session.

```text
PREPARED -> TRANSACTION_OPEN_STARTED -> TRANSACTION_OPEN
                                                |
                                                v
                          CANDIDATE_STAGE_STARTED -> CANDIDATE_STAGED

any incomplete/start state -> SIDE_EFFECT_UNCERTAIN -> RECOVERY_REQUIRED
                                                    -> ROLLBACK_STARTED
                                                    -> ROLLED_BACK
```

Transitions use operation and journal-wide generation CAS, deterministic IDs,
canonical JSON, append-only hash chains, exact builtins/record types, and exact
external anchor CAS. Exact in-session retries inspect the real store and return
the original result event without rerunning a callback. Restored forward
operations never acquire a new owner.

## SQLite and rollback integrity

The schema bootstraps only when SQLite is truly empty and no external journal
anchor exists. A recognized application ID/version with pre-existing objects
is never repaired or fingerprinted. Every table, explicit index, trigger, and
view, plus every SQLite constraint auto-index, must have the exact compiled DDL
catalog entry; weak same-named tables, no-op
triggers, missing metadata, and extra objects fail closed.

SQLite uses `BEGIN IMMEDIATE`, full synchronization, WAL for file databases,
foreign keys, immutable identity/metadata triggers, append-only events,
canonical JSON, exact schema checking, and complete restore validation. The
external catalog anchor makes SQLite a rollback-detecting projection rather
than the sole one-use authority. Every anchor CAS stores the complete, already
validated transition envelope before SQLite projection. If projection fails,
the call returns no success; on restart the journal may deterministically apply
exactly one authenticated successor envelope. An anchor more than one
generation ahead, behind, rebound, malformed, or contradictory still fails
closed. No envelope invents forward recovery or reruns a side effect.

`FileStageExecutionCoordinator` is intended for cooperating processes on one
host and one filesystem with reliable OS record locks. Distributed workers or
filesystems without those semantics must inject an equivalently strong
coordinator. The monotonic anchor remains a separate required trust service;
the coordinator database is not a substitute for rollback-resistant one-use
authorization anchoring. This package is deliberately not wired into the API;
canonical staging must remain disabled until all production adapters and the
downstream verified-capability acceptance boundary are integrated.

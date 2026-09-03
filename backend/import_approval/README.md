# Import approval boundary

This package turns one durable, resolved KiCad project candidate and one exact,
blocker-free canonical mapping into a human-approved **staging input**. It never
receives or mutates a `DesignKernel`.

The contract binds all of the following into a domain-separated subject digest:

- durable candidate identity, generation, event-chain head, inspection receipt,
  and mapping-resolution receipt;
- durable canonical-mapping evidence ID, digest, ACTIVE generation, event-chain
  head, plus the separately named mapper-result and canonical-candidate digests;
- current base revision, prospective graph identity, ordered command hashes,
  command-set digest, and the exact DesignKernel-compatible preview digest;
- a canonical review-manifest digest covering the exact semantic diff,
  provenance, advisories, limitations, questions, answers, and challenge;
- project/run revisions and incarnations, their event-chain heads, coordination
  context and incarnation, target-store identity and incarnation, and the exact
  authenticated uploader, reviewer, mapper, and staging-service principals;
- request/decision time, expiry, and approval lifecycle generation.

The durable candidate's resolution receipt must equal the durable mapping-evidence
digest, while that evidence's `mapper_result_sha256` must equal the mapper result
digest. That two-step bridge proves that the reviewed candidate was resolved by a
current, persisted mapping record rather than by a reconstructed result or an
unrelated receipt. The contract re-reads both repositories at request,
decision, authorization, validation, and invalidation boundaries as
applicable. It also requires server-owned current-authority and principal
providers and rejects a changed project/run/coordination/target-store snapshot,
stale authentication event, clock rollback, or expiry crossed during those
reads.

Principal claims are not bearer data. `AuthenticatedPrincipal` deliberately has
identity semantics: the principal provider must attest and return the exact
opaque object it issued. Reconstructing an equal-looking ID, role, authority,
and authentication-event tuple does not authenticate a caller. The provider
also supplies a version token for its principal-authority state.

Candidate, mapping, authority, and principal-authority versions form one
`ApprovalSourceSnapshot`. Each authority-bearing operation double-collects those
tokens around its independent repository reads and then invokes a required
trusted source compare-and-swap fence immediately before appending or returning.
The source-CAS integration must provide a real atomic linearization point over
those version domains; a check-then-act adapter is not sufficient.
Invalidation follows the same rule: principal rotation after attestation or a
failed final source CAS leaves the approval ledger and external anchor
unchanged.

`HumanMappingApproval` has only the `mapping-to-canonical-stage` scope.
`AuthorizedImportStagingInput` always carries
`authorizes_internal_commit=False` and
`authorizes_manufacturing_release=False`; deterministic verification, kernel
commit approval, and manufacturing release remain separate internal workflows.

Every lifecycle transition is an append-only SQLite ledger event containing the
exact canonical record snapshot. Events form one sequence-numbered hash chain;
each event and the chain head are domain-separated HMAC-sealed with an
issuer-owned key. Requests, negative decisions, invalidations, authorizations,
operation-key ownership, and generation rejection fences therefore survive a
normal process restart. WAL mode, `synchronous=FULL`, and one transaction for the
event plus sealed head provide crash recovery at the SQLite boundary.

Bootstrap occurs only when SQLite is truly empty. An initialized database is
never repaired: a missing row, table, trigger, or index fails closed. The file's
fixed `application_id`, `user_version`, and fingerprint of the exact schema
compiled by SQLite must all match before any record is read. Ledger and record
decoders accept only exact concrete builtins/types and canonical UTC timestamps
of the form `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Public request identifiers and sealed
record JSON sources must likewise be exact strings, not string subclasses.

Lifecycle snapshots are validated as a single semantic record, not merely as a
set of individually valid objects. State and generation must match the exact
decision/authorization evidence shape; request, decision, and authorization
IDs, digests, scope, principals, expiry, and timestamps must agree. Restart
replay repeats those cross-record checks and also requires each ledger event
timestamp to match its lifecycle event and the global monotonic time order. A
valid decision or authorization from another request therefore cannot be
spliced into a canonically encoded, correctly HMAC-sealed record.

An independently durable monotonic `(sequence, digest)` anchor is mandatory,
including for a new empty issuer where it must be pre-provisioned at `(0,
zero-digest)`. A security event is never returned before the SQLite commit and
external anchor CAS both succeed. If a crash occurs after the database commit
but before the CAS, restart may advance a behind anchor only after verifying the
entire HMAC-sealed chain, completing cross-record semantic lifecycle replay, and
proving that the anchor names an exact prefix. Semantic replay happens before
the recovery CAS, so an invalid successor cannot be blessed into the external
anchor. An anchor ahead of the database or contradictory at any sequence is
rollback or fork evidence and always fails closed. An unavailable anchor also
fails closed. This protocol detects whole-file rollback; protecting
availability, the anchor store, database path, and sealing key remains a
deployment responsibility. Losing or rotating the key without an explicit
migration makes the existing ledger unreadable by design.

Every public operation reloads and verifies the ledger and external anchor
before sampling time. The ledger's last event timestamp is the locked clock
high-water mark, so a stale concurrent process or restart cannot sample a time
behind a newly persisted security event.

`request_mapping_approval` requires an explicit operation/idempotency key. An
exact retry returns the original request, while key rebinding fails closed. An
exact retry of `authorize_staging` returns the already-issued object; it never
mints a second token. A rejection fences the candidate/mapping generation even
when a parallel review was opened first, so another attempt requires new durable
candidate or mapping evidence. Any changed principal, command, mapping,
revision, generation, authority head, incarnation, or target store is rejected.

An authorization is evidence-only and is never proof that staging occurred.
Its `stage_receipt_digest` property and `reconcile_staged` are deliberately
disabled. The durable stage-operation journal must consume the exact
authorization, record pre-side-effect intent, and issue the eventual outcome
receipt; callers must not synthesize a receipt from the authorization digest or
candidate state.

There is intentionally no claim of atomicity across this approval ledger, the
durable project store, and candidate repository. The stage-operation journal (or
an atomic shared store) owns that recovery window. An orphan design transaction
must be quarantined or rollback-only after restart; it must never be reconciled
from approval evidence alone. Deterministic verification and a separately typed
commit approval are still required after staging, and manufacturing release
remains a separate authority domain.

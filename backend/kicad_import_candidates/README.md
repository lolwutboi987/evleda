# Durable KiCad import candidates

This package persists inspection results and their review lifecycle without
changing the canonical ECAD graph.

An `ImportCandidateDraft` binds a managed artifact ID, SHA-256, and kind; a
non-null exact canonical project revision and exact run precondition; the
complete canonical inspection receipt body and its verified receipt digest;
sorted diagnostics; and explicit blockers. Its digest and ID are derived from
that immutable identity. New-project imports bind the deterministic empty
genesis revision rather than using a null precondition.

Application integration uses
`ImportCandidateDraft.from_managed_inspection(...)`. This closed-schema decoder
binds the embedded artifact, project, and run subjects to the draft, recomputes
the canonical inspection-payload SHA-256 and domain-separated receipt digest,
requires the frozen coordination-context digest, deterministically derives all
diagnostics and blockers from the signed receipt, and rejects unknown envelope
fields. The lower-level `from_payload(...)`
constructor remains useful for repository fixtures and migrations, but it does
not establish managed-receipt provenance; both paths recursively reject raw
capabilities, URL/location escape hatches, false KiCad execution/check claims,
and manufacturing-release claims.

`SQLiteImportCandidateRepository` stores the candidate plus an append-only,
digest-chained event log. State changes use an exact integer generation as a
compare-and-swap precondition. The legal lifecycle is:

```text
pending → resolved → staged → invalidated
    │          ├──→ rejected
    │          └──→ invalidated
    ├─────────────→ rejected
    └─────────────→ invalidated
```

Rejected and invalidated candidates are terminal. Resolution and staging each
require their own digest receipt; rejection and invalidation require a reason.
The repository has no graph/kernel dependency, artifact byte method, worker
command, filesystem destination, approval fabrication, or manufacturing
eligibility property. A host application must independently re-check the
artifact and project/run preconditions before using a resolved candidate to
construct an isolated canonical transaction.

Store schema v3 makes the project revision non-null. Its transactional v2
migration labels each non-null row with the exact identity algorithm that
reproduces the existing inspection digest, candidate digest, and candidate ID.
Legacy IDs are never rewritten. A legacy null-revision row cannot establish a
canonical subject and therefore aborts the migration with the v2 database left
unchanged. `inspection_payload_sha256` always exposes the plain canonical-body
SHA used by the managed receipt protocol; `inspection_payload_digest` remains
the versioned identity value and is domain-hashed for legacy-v2 records.

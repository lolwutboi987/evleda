# Canonical project-store commit evidence

The project store persists immutable revisions, terminal transaction snapshots,
exact human approval evidence, and one mandatory signed attestation per
non-genesis revision. `append_revision` accepts none of these records
optionally: the transaction, approval, and attestation must reproduce the exact
project, base/head, ordered commands, preview, prospective graph, verification
report and inputs, passing gate, release subject, approval decision, and
consumed live authorization.

## External trust boundaries

`SQLiteProjectStore` requires two injected dependencies:

- an `Ed25519CommitAttestationKeyring` containing public verification keys only;
- a monotonic `ProjectHeadAnchor` CAS containing project ID, sequence, revision
  hash, and canonical attestation-document digest.

The application alone receives `Ed25519CommitAttestationSigner` and signs only
after the live kernel consumed its exact capability and post-commit verification
reproduced the approved report and gate. Private signing keys are never passed
to restore and are never stored in SQLite. Historical public keys remain in the
external keyring during rotation; removing one makes revisions signed by that
key unrestorable.

The anchor is outside the project database and prevents a valid older database
snapshot from becoming current. Genesis creation initializes the anchor first,
then inserts SQLite state; an exact anchored genesis is idempotent across
failure and concurrent creation. Restore never creates a missing anchor or
blesses an existing unanchored database. Append commits the fully signed SQLite
records, then advances the external CAS, and does not report success before the
CAS. Restore may recover a stale anchor only after verifying every exact signed
successor from the anchored revision. It retries one fresh SQLite snapshot when
an anchor is transiently ahead because of a concurrent writer; a persistently
ahead anchor, contradictory revision, or another branch fails closed.

`DirectoryProjectHeadAnchor` provides atomic replace, file/directory fsync where
the platform supports it, restrictive permissions, and cross-process locking.
It is a local deployment adapter, not a substitute for a production monotonic
service or KMS-backed ledger. If its directory is rolled back together with the
SQLite file, that common-mode rollback cannot be detected; production must back
the anchor independently.

## Restore behavior

Restore uses pure deterministic transaction replay and verifies the Ed25519
attestation with the external public keyring. It never calls the live commit API,
never obtains a signer, consumes no capability, and cannot authorize a new
commit. The process-local HMAC issuer and nonce registry deliberately disappear
on restart; durable signed evidence and the external head anchor are the
restart truth.

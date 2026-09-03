# Design kernel trust boundary

`DesignKernel` is the only live canonical graph mutation boundary. Agents and
import tooling may construct typed commands, but they cannot commit a staged
transaction with an approval ID, an import-stage authorization, or a preview
digest.

## Commit capability

Live commit requires a frozen `CommitAuthorization` issued by a
`HmacCommitAuthority`. The application retains the issuer and its immutable
release-approval registry; the kernel receives only the paired
`HmacCommitVerifier`. The authority requires a minimum 32-byte secret and uses
a domain-separated HMAC-SHA-256 seal checked with constant-time comparison.
The sealed claims bind:

- capability scope, version, key ID, ID, digest, issue/expiry times, and a
  single-use nonce;
- project, base revision, pre-commit head, target transaction, ordered command
  hashes and their domain-separated digest;
- preview, prospective graph, verification report, and verified preview;
- the passing commit gate and release subject plus the exact human approval ID,
  run ID, release kind, full-record digest, authenticated principal, decision
  time, and optional expiry.

Issuance is by registered approval ID. Report, gate, verified preview, subject,
and every human-decision claim are derived from that server-owned immutable
record and rechecked during verification and atomic consumption. Registration
copies the caller record into an issuer-private snapshot; neither the input nor
any returned evidence object is retained. Every approval ID is permanently
one-shot within the issuer incarnation: identical or conflicting
re-registration is rejected, and revocation (including before registration)
leaves a terminal tombstone. Verification first copies exact concrete/builtin
values into a private, non-virtual claims snapshot; caller methods, missing
fields, and later mutation are never consulted. The kernel then independently
matches every transaction-derived and approval-derived claim and consumes the
nonce before publishing a head. A consumed capability is rejected everywhere
except an exact idempotent retry of the already committed transaction in the
same kernel instance.

All authority time comes from its injected UTC clock. A high-water mark rejects
future issue times and expiry, and any observed clock rollback permanently
poisons that authority incarnation. Recovery requires creating a new issuer and
fresh coordination; silently resuming the poisoned issuer is forbidden.

## Current key-lifetime limitation

`WorkspaceApplication` creates a random process-local HMAC capability key. This is
intentional while coordination and approvals are also process-local: restart
invalidates every outstanding live commit capability and starts fresh
coordination. This live key is distinct from the externally supplied Ed25519
durable-attestation key. It is not a distributed authorization service;
multi-process live approvals would require a shared issuer plus a durable,
transactional approval and nonce ledger.

# Capability-safe MCP/KiCad gateway

This package is the model-facing boundary for PCB work. It exposes ten
outcome-level operations and no general command, path, source-replacement, or
filesystem-write primitive.

## Capability profiles

Profiles are resolved by the authenticated host and are never accepted from
model tool arguments.

| Profile | Maximum tier | Intended use |
| --- | --- | --- |
| `observer` | read | project inspection |
| `designer` | stage | runs, questions, previews, isolated staging, checks, rollback |
| `release_manager` | release | human approvals, canonical commit, managed export |

`decide_approval` additionally requires an authenticated user actor. A service
may execute a previously approved commit, but an agent cannot manufacture the
human receipt.

## Strict lifecycle

```text
inspect -> create run -> answer blocking questions -> preview
        -> human stage approval -> isolated stage -> deterministic verification
        -> human release approval -> canonical commit (or rollback)
```

The stage approval is bound to `preview_digest`. The release approval is bound
to `(run_id, committed base revision, staged revision, verification report
digest)`. Every state-changing request also carries the exact project, stage,
and/or run revision it observed. Stale work fails closed.

All requests and results use canonical JSON and SHA-256 evidence records.
Caller-selected idempotency keys are scoped by actor and tool. The gateway holds
one re-entrant transaction lock around precondition checking, mutation,
evidence capture, and idempotency publication, so concurrent retries apply once.

## Live KiCad implementation

Implement `KiCadAdapter` in an isolated local worker using semantic KiCad IPC
and controlled `kicad-cli` checks. Do not extend the protocol with a generic
shell executor or caller-selected output path. External rule engines can be
adapted through the mock's `VerificationHook`; the gateway itself deliberately
does not import the concurrently evolving orchestration or verification
packages.

`InMemoryKiCadAdapter` is the executable reference. It maintains a committed
revision and one isolated stage, applies typed operations, runs deterministic
component-grounding/placement/routing checks, and produces managed in-memory
export artifacts.

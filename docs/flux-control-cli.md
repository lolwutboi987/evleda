# Flux control CLI

`evleda-fluxctl` is a local, JSON-only control surface for ChatGPT or another
noninteractive caller. It uses the existing candidate-only Flux REST API and
does not depend on a browser, React, or UI automation.

Run from source with `pnpm --silent fluxctl <command> ...` (the `--silent`
keeps pnpm's own script banner out of the JSON stream), or use the packaged
`evleda-fluxctl` binary after `pnpm build`.

The default authority is `http://127.0.0.1:8765`. Other loopback addresses are
accepted. A non-loopback origin is rejected unless both `--allow-remote-https`
and an HTTPS origin-only `--base-url` are supplied. Credentials, URL paths,
queries, and fragments are never accepted in the base URL.

All output, including errors and help, is one JSON object. Prompt text is never
accepted in argv, persisted in the intent journal, or returned in command
output. Supply it through exactly one of:

```powershell
pnpm --silent fluxctl create-run --project-id project_x --thread-id thread_x --prompt-file C:\private\prompt.txt
Get-Content C:\private\prompt.txt -Raw | pnpm --silent fluxctl create-run --project-id project_x --thread-id thread_x --prompt-stdin
```

For a new fresh run, `policy` reports an iteration minimum of 1, maximum of 24,
and recommendation of 12. Omitting `--iterations` uses 12. To request the
ceiling explicitly:

```powershell
pnpm --silent fluxctl create-run --project-id project_x --thread-id thread_x --prompt-file C:\private\prompt.txt --iterations 24
```

The selected `iterationCap` is bound into the run and the new approval subject.
24 is an upper bound, not a promise of success or 24 completed attempts:
message, byte, tool, timeout, or acceptance failures can stop execution earlier.
Fresh caps above 12 select `maxMessages=256` and, for Codex/Claude CLI execution,
the existing 1 MiB byte ceiling. Caps through 12 keep 64 messages and the default
256 KiB CLI limit. These are execution resource guards, not extended HTTP
deadlines. [Budget details and standalone defaults](flux-local.md#iteration-budgets-and-approval).

Historical 12-iteration values describe those runs and stay unchanged. The
already-consumed attempt13 run cannot resume under the new ceiling. Create a
new run and complete the normal prepare/Open/checkpoint/approval sequence;
same-key replay or a new resume key cannot replenish a consumed approval.

The phase-aware generic workflow remains deliberately explicit:

1. `readiness`, `policy`, and `sources`
2. `create-project`, `create-thread`, and `create-run`
3. `interpret`; when needed, `contract` then `answer`
4. `prepare`
5. `open`
6. `checkpoint`
7. `approval-subject`
8. Read the complete subject and copy its exact `digest` into a separate
   `approve --subject-digest <digest>` command
9. `resume`
10. `poll`, `status`, `contract`, `previews`, `reports`, and run-bound
    `inspection-status`
11. Use the separate idempotent `inspect --run-id <id>` command only when an
    active six-tool inspection is intended

No command auto-approves, opens, checkpoints, or resumes another phase. The
server remains authoritative and rejects races or illegal transitions.

Every POST is represented by a durable, identity-checked local intent written
before the request. Its idempotency key survives lost responses and process
restarts. The journal binds the normalized base URL, active server policy,
source fingerprint, project/thread/run identities, logical request digest, and
exact HTTP request digest. It is consumed only after an exact success envelope
or a terminal interpret, clarification, or checkpoint failure receipt
independently authenticated against the current blocked run. Raw prompts and
request bodies are absent.

A checkpoint failure receipt must bind the exact checkpoint request,
idempotency key, project/thread/run identities, and supported failure identity.
The client independently reads the run and requires matching blocked state,
`checkpointRequired: true`, completion time, blocked reason, and unchanged run
and compilation authority, with no approval or execution reports. Only then
does it persist the failed outcome with local intent status `terminal` and emit
the nonretryable `OPERATION_UNCERTAIN` failure. Repeating the exact command with
the same intent journal, including after a process restart, reuses the original
key and retrieves the same failure receipt. This replay does not start a new
checkpoint attempt. A mismatched or unverifiable receipt leaves a pending
intent unsettled.

Generic interpretation has one deliberately narrow identity transition. A
draft or exact `needs_clarification` result retains the policy placeholders;
the first authenticated `contract_ready` bundle may replace the harness-rule
and acceptance-profile values. Acceptance is independently rederived from the
public bundle identities. The harness value is accepted once as a canonical
SHA-256 server-issued pin only after the complete contract/bundle/rule closure;
the localhost runtime independently recomputes it before use. The public
receipt omits the execution-prompt content needed for client-side
recomputation. Every replay and later lifecycle transition requires the pinned
value unchanged. The interpreter receipt must also name the current interpreter
schema and bind the exact normalized clarification array in its submitted
order. `compiledAt` is identity-bound metadata only; it is not operation-time
proof. The adapter schema and compiler, practice, and bundle identities
(including exact bundle-reference equality) are accepted as one-time public
server pins, while the localhost runtime revalidates their underlying objects
before use. A success envelope may never use phase `blocked`.

Response bodies are read as bounded raw chunks, decoded with fatal UTF-8,
scanned for duplicate JSON keys, structurally bounded, and checked against the
exact operation envelope and the requestId from that response only.
Ordinary HTTP requests have an exact 30-second deadline. `open` uses a separate
120-second observation deadline for `flux_open`, including response-body
parsing and same-intent replay. This allows the observed roughly 33-second Open
operation plus headroom; it does not change any server deadline or lifecycle
authority. Only `interpret`, `answer`, and `checkpoint` use an exact
300-second deadline, including same-intent replay. The first two map to the
`flux_interpret` and `flux_clarify` interpretation budget; checkpoint uses its distinct
`flux_checkpoint_open` observation budget.
The checkpoint observation deadline remains 300 seconds. A transport failure,
lost response, or observation timeout without an authenticated terminal receipt
leaves a pending intent `pending`; it does not establish whether the server
completed or failed the checkpoint. Repeating the exact command with the same
journal reuses the original key to recover the server's recorded outcome.
The same pending-intent and same-key recovery behavior applies when an Open
response is lost or its 120-second observation deadline expires. A timeout
does not authorize another editor launch.

Prompt, clarification, and intent-manifest files are opened through a retained
descriptor (with no-follow where the host supports it). The client binds the
descriptor's device, inode, mode, link count, size, and modification/change
times before and after the bounded read, then rechecks the pathname and
canonical resolution. Replacement, reparse/symlink, hard-link, and in-place
mutation races fail closed. Intent writes use a single-link sibling temporary,
file fsync, atomic rename, descriptor-bound byte-for-byte readback, and
directory fsync when the platform supports it.

`inspection-status` is a run-bound GET and never opens or reconnects a sidecar.
`inspect` is the distinct POST that may consume the shared connection budget.
Its intent completes only after a `ready` result contains all six fixed read
tools and advances the immediate status budget by exactly one connection;
`idle`, `busy`, stale-budget, or incomplete results leave the intent pending.
Before settlement, the complete POST result must also equal a newly fetched,
run-bound inspection status response.
Both require current Open/checkpoint and v6 approval-subject authority,
including generic fresh-netclass semantic-v1, prepared-source-authority-v1,
and preparation-evidence-v1 bindings, and emit
the exact run, inspection bridge, execution bridge, IPC socket, write-session,
and `{used,remaining,limit}` budget bindings. Global/unbound inspection is not
exposed. Preview commands expose metadata only; there is no generic file or
report-body download.

Generic `completed` report metadata must carry clearance binding v2 whose
semantic-v1 identity matches the current v6 approval subject. Legacy binding
v1 or missing bindings remain readable only after the server downgrades the run
to a non-completed review state; they cannot authorize `resume`.

There are no manufacturing, fabrication, qualification, or release commands.

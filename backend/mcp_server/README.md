# EvlEDA MCP stdio server

This package is a dependency-free Python 3.12 MCP binding around
`CapabilitySafeGateway`. It is dual-era: modern requests use MCP `2026-07-28`
per-request metadata and `server/discover`; legacy clients use the requested
`initialize` → `notifications/initialized` lifecycle at revision `2025-11-25`.

That distinction is intentional. The current specification made MCP stateless
and retired the initialization handshake, while defining dual-era servers as
the compatibility path. See the official [versioning and compatibility
rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[current stdio binding](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
[current tools contract](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
and [legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

The stdio implementation follows the official framing rule: one UTF-8 JSON-RPC
message per newline, no embedded newlines, protocol messages only on stdout.
EOF is graceful shutdown. Tool successes and execution failures both return
text `content` plus matching `structuredContent`; malformed JSON-RPC and unknown
tools use stable protocol errors.

Every gateway call is checked against the exact JSON Schema published by its
manifest before a typed request is built. The local validator implements the
closed subset used by these manifests (`type`, `required`,
`additionalProperties`, `properties`, `items`, `anyOf`, `enum`, `pattern`, and
the emitted size/range constraints), so the server remains offline and
dependency-free.

## Security boundary

`HostConfig` receives one trusted `Principal` and an explicit
`allowed_project_ids` set when the host launches the server. An empty set is
fail-closed. Tool arguments and client `_meta` cannot change actor kind,
profile, project scope, worker identity, KiCad version, or rule policy.

Hosts may additionally set exact `exposed_gateway_tools` and
`exposed_kicad_hooks` frozensets. Listing and dispatch use the same filtered
maps, so guessing a hidden tool name cannot bypass the advertised surface. The
generic `None` setting preserves the complete compatibility surface; security-
sensitive hosts should always pass explicit sets.

`com.fluxclone/idempotencyKey` is a retry identity, not a capability. An
explicit key receives exact-input replay semantics. When it is absent, the
server generates a fresh per-dispatch nonce; JSON-RPC request IDs are never
misused as durable idempotency identities. Run separate authenticated
endpoints for agent and human principals while sharing durable gateway,
approval, attestation, and worker-outcome stores in production.

Canonical `commit_transaction` calls fail closed unless the host provides a
`KiCadCommitAttestationVerifier`. Its attestation must bind the exact project,
base revision, staged revision, gateway report digest, passing decision,
worker, KiCad version, and host-pinned verification-policy digest. Merely
calling the parallel `kicad_verify` tool or setting a digest string does not
enable commit.

## Real KiCad worker hooks

`HostConfig.kicad_service` may bind a production worker implementing
`KiCadOperationService`. The host must also pin `kicad_worker`,
`kicad_version`, and `kicad_policy_digest`, and explicitly attest that the
worker has durable idempotency. When—and only when—that configuration is
complete, the read/export/verify hooks are advertised. Import is advertised
only when a separate host-owned `KiCadImportApprovalVerifier` is also present.

| Tool | Minimum profile tier | Worker operation |
| --- | --- | --- |
| `kicad_import` | release + user actor | revision-pinned, approved managed-artifact import |
| `kicad_export` | release | exact-revision export |
| `kicad_verify` | stage | exact-revision ERC/DRC |
| `kicad_render` | read | exact-revision schematic/PCB render |

Before dispatch, the server validates closed input schemas, capability tier,
authenticated-user requirements, project scope, and the current canonical
project revision through the gateway. Worker results use operation-specific
closed payload schemas. Typed evidence must match the exact canonical request,
actual opened-project digest, output digest, idempotency key, worker, KiCad
version, policy digest, and exit status. Verification additionally requires
sorted unique checks, a digest-valid report, and zero blocking findings for a
passing result.

The server never interprets an in-memory operation as proof that KiCad ran.
With no worker the hooks are absent. Worker failures and malformed or unbound
evidence return `isError: true`; unexpected exceptions become JSON-RPC
internal errors rather than fabricated success. The in-process replay map is
only a single-flight optimization. A production worker must durably journal
the idempotency key and terminal outcome before changing files, so reconnects,
process restarts, and ambiguous failures cannot repeat destructive work.

Import additionally requires an exact current revision (or explicit `null`,
which the gateway confirms is a new project), a digest-pinned source artifact,
an authenticated user actor, and durable approval evidence whose subject
digest binds every import field. The caller's receipt string alone is never
accepted as authorization.

## Demo

From the project root:

```powershell
python -m backend.mcp_server.demo
```

The demo seeds `project-demo` in the gateway's `InMemoryKiCadAdapter`, scopes
the principal to that project, and defaults to an agent `designer`. It
intentionally configures neither real KiCad hooks nor a commit-attestation
verifier, so it cannot claim a KiCad execution or canonical release. Trusted
launch-time environment settings are
`EVLEDA_MCP_ACTOR_ID`, `EVLEDA_MCP_ACTOR_KIND`, `EVLEDA_MCP_PROFILE`,
and `EVLEDA_MCP_PROJECT_ID`. The demo writes no banner or logs to stdout.

For the immutable real reference PCB, use
`python -m backend.mcp_server.reference_host`. That composition exposes only
`inspect_project`, plus `kicad_verify` when all native runtime pins are present.
See `docs/REFERENCE_MCP_HOST.md` for exact launch, state, and key semantics.

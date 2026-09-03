# EvlEDA architecture

EvlEDA is a local adapter and guardrail layer around KiCad. It is not an editor,
renderer, hosted control plane, or alternate CAD runtime.

## Process boundary

```text
Codex or Claude Code
        │  local MCP JSON-RPC over stdin/stdout
        ▼
evleda-mcp child process
        │
        ├── project/capability allowlist
        ├── typed request + exact revision checks
        ├── canonical/parity/approval/evidence guardrails
        │
        ▼
isolated working copy ─────► installed, identity-pinned KiCad
        │                         │
        │                         ├── native ERC/DRC
        │                         ├── native render/export
        │                         └── supported native operations
        ▼
bound reports/artifacts ───► local client response
```

The process opens no listening socket. There is no HTTP or browser adapter,
remote MCP transport, hosted runtime, account service, or multi-user database
in the public product. The word “server” refers only to the local MCP child
process that serves its parent over standard streams.

## KiCad is authoritative

The user's `.kicad_pro`, `.kicad_sch`, and `.kicad_pcb` files are the native
design artifacts. Users view and edit them in KiCad. KiCad is authoritative for
its native file semantics and for results labeled KiCad ERC, DRC, rendering, or
export.

EvlEDA may parse a supported subset into an internal canonical representation,
run additional deterministic checks, or compile a typed approved candidate back
to KiCad files. Those layers are guardrails:

- they do not create another interactive editor;
- they do not make an EvlEDA check a KiCad result;
- they do not silently drop unsupported KiCad constructs;
- they do not make the internal graph a new user-facing CAD format;
- they do not authorize writes merely because a model proposed them.

The compiler reparses its output and checks reference, value, footprint,
pin/pad, named-net, no-connect, geometry, and project identity parity. A lossy or
unsupported mapping blocks the operation.

## Project scope and authority

The host owns project selection, executable identity, allowed operations,
state, and output policy. An MCP caller cannot choose an arbitrary shell,
worker, executable, or unrestricted filesystem path. Tool listing and dispatch
use the same capability allowlist, so guessing an unadvertised tool name does
not bypass configuration.

Typed mutation, where a profile supports it, is separate from read and native
verification. Exact base identities, preview digests, approval receipts, and
stale-state checks prevent a general instruction such as “make it work” from
authorizing a different later change. Outputs default to non-release.

## Isolated native execution

Native checks run on a disposable, inventory-bound copy. EvlEDA verifies source
hashes before and after execution and keeps KiCad runtime state, lock files,
backups, caches, and zone-filled derivatives from silently changing the sealed
input. Worker subprocesses use fixed argv without a shell, bounded time/output,
and a reviewed KiCad 10 executable whose version and SHA-256 are recorded.

Native reports are retained separately from normalized EvlEDA findings. A
missing, skipped, stale, crashed, or unparsable report is not a pass.

## Content-addressed evidence

Meaningful boundaries produce domain-separated identities over canonical
representations: source files, normalized graph, proposal, approval, compiler
manifest, working copy, native reports, publication, and CAM candidate.
Downstream claims bind exact bytes and exact semantics rather than a filename or
an agent statement.

Some frozen evidence strings retain `flux-clone-*` and some generated KiCad
libraries retain `FluxGenerated`. They are compatibility identifiers, not a web
application or branding dependency.

## Verification layers

EvlEDA keeps these claims distinct:

1. EvlEDA canonical/electrical/geometry/connectivity checks passed.
2. A supported compile/reparse mapping preserved its modeled semantics.
3. The pinned local KiCad executable checked the exact isolated project copy.
4. Render/export artifacts bind to that checked source and policy.
5. Qualified humans completed physical and manufacturing release review.

Passing an earlier layer never implies a later one. Model confidence is not a
verification layer.

## Reference fixture

The packaged `reference-usb-c-3v3-r2` board exercises the deterministic
compiler, native KiCad worker, evidence, render, and non-release CAM paths. It is
a demo/acceptance fixture. It is not a built-in editor, an arbitrary-board
generator, or a replacement for the user's selected KiCad project.

## Cloud development workflow

The cloud runbook reproduces acceptance evidence for the fixed reference
fixture in a clean development environment. It does not deploy EvlEDA, keep a
process alive, expose a URL, or change the local-only stdio architecture.

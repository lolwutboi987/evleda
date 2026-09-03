# Why EvlEDA is different from a typical KiCad MCP

This is an architecture comparison, not a benchmark or ranking. Other projects
change over time; consult each project's current documentation before choosing
one.

## The short version

A typical KiCad MCP emphasizes giving an AI client a broad set of KiCad
operations. EvlEDA emphasizes a narrower local stdio boundary with exact project
scope, typed operations, revision-bound approvals, deterministic parity checks,
content-addressed evidence, isolated native execution, and an explicit
non-release manufacturing boundary.

EvlEDA does **not** compete by building another CAD editor. There is no EvlEDA
canvas, browser studio, HTTP service, or hosted project database. Users edit
ordinary KiCad files in KiCad; KiCad remains the authoritative native editor and
checker. EvlEDA's canonical model and compiler are internal guardrails around
supported MCP work.

## Compared surfaces

| Project | Publicly documented emphasis | EvlEDA distinction |
| --- | --- | --- |
| [Konnect](https://github.com/mixelpixx/Konnect) | Native KiCad 10 plugin with broad schematic, PCB, routing, review, manufacturing, IPC, and undo/redo integration. | EvlEDA is a separate local stdio MCP with a smaller surface and stronger emphasis on exact identities, isolated checks, and evidence/approval separation. |
| [KiCAD-MCP-Server](https://github.com/mixelpixx/KiCAD-MCP-Server) | Broad project setup, schematic editing, placement, routing, ERC/DRC, export, libraries, parts data, and routing integrations. | EvlEDA routes supported outcomes through typed canonical/parity gates and exposes correspondingly less raw breadth. |
| [KiCad MCP Pro](https://github.com/oaslananka/kicad-mcp-pro) | Multiple profiles/transports and broad design, ERC/DRC, DFM, BOM, review, and dashboard workflows. | EvlEDA is local stdio only and focuses on immutable source packages, domain-separated identities, and stage-specific human authority. |
| [Seeed Studio KiCad MCP Server](https://github.com/Seeed-Studio/kicad-mcp-server) | Schematic/PCB analysis, tracing, ERC/DRC, project templates, embedded-code generation, and parts data. | EvlEDA trades analysis breadth for deterministic mapping, source-preserving native runs, and evidence-bound results. |

These descriptions summarize public project documentation. They do not imply
equivalent maturity, quality, or safety, and no cross-project conformance suite
was run.

## Architectural differences

### Local stdio only

Codex or Claude Code launches `evleda-mcp` as a child process and communicates
over stdin/stdout. EvlEDA opens no port and offers no remote or hosted mode.
This reduces the advertised security boundary; it does not make untrusted local
code safe, because the process still inherits the user's permissions.

### KiCad remains the product editor

KiCad project files are the user-facing source artifacts. EvlEDA never asks a
user to migrate into a proprietary EvlEDA document or UI. Results labeled
KiCad ERC/DRC/render/export come from the identity-pinned local KiCad
installation, not from model prose or a look-alike engine.

### Canonical/parity guardrails

For supported operations, EvlEDA normalizes design intent into typed integer
units and stable entity identities. A compiler or adapter must reparse output
and prove the supported schematic/PCB/net/pin/pad/geometry mapping. Unsupported
or lossy constructs block instead of silently disappearing. This representation
exists to protect interaction with KiCad, not to replace it.

### Evidence is content-addressed

Inputs, revisions, proposals, approvals, output files, tool identities, native
reports, and CAM candidates can be bound by domain-separated SHA-256 identities.
A result refers to exact bytes and semantics rather than “the latest board” or
an agent assertion.

### Approval and capability are separate

An agent proposal is not authority to stage, verify, commit, export, or release.
Feature-gated mutation requires its typed contract and exact current-state
bindings. Tool listing and dispatch share the same allowlist, so a client cannot
invoke a hidden capability by guessing its name.

### Native checks preserve source

KiCad runs against an isolated inventory-bound copy using fixed argv, bounded
resources, and a pinned executable identity. EvlEDA verifies the sealed source
before and after execution and reports missing, skipped, stale, or unparsable
evidence as non-passing.

### CAM is non-release by default

Gerbers and drill files can be well formed while the hardware remains unsafe or
unqualified. EvlEDA separates digital evidence from electrical, thermal, EMC,
compliance, assembly, first-article, fabricator, and human release review.

## Where broader KiCad MCPs are ahead

The compared projects advertise more general live editing, project types,
analysis, GUI integration, library/part workflows, routing, and export features.
EvlEDA should not claim parity based on its internal modules or its fixed
reference fixture. The active local `tools/list` response defines what this
version can actually do.

Choose a broader MCP when immediate command coverage matters most. Evaluate
EvlEDA when exact authority, deterministic mapping, source preservation, and
auditable evidence matter enough to accept a narrower operation surface.

## Reference fixture, not product scope

The bundled `reference-usb-c-3v3-r2` project demonstrates the evidence pipeline
on one deeply checked design. It is a demo and acceptance fixture—not a CAD
application, an arbitrary-board generator, or a template silently substituted
for the user's existing KiCad project.

## Names and affiliation

EvlEDA is independent of all projects named above and is not endorsed by KiCad,
the KiCad project, LF Projects, or the Linux Foundation. “KiCad” is used only to
describe interoperability. Project names and other marks belong to their
respective owners.

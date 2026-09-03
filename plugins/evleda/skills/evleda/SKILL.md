---
name: evleda
description: Inspect, verify, and perform supported typed work on native KiCad projects through EvlEDA's local stdio MCP. Use when Codex or Claude Code should interface with KiCad already installed on the user's computer; do not use it as a replacement CAD editor, hosted service, or authority for manufacturing release.
---

# EvlEDA

Use EvlEDA as a guardrailed local bridge to the user's installed KiCad. KiCad
project files remain native artifacts and KiCad remains the authoritative editor
and native checker. EvlEDA has no canvas, browser application, HTTP endpoint,
remote account, or hosted runtime.

## Start from the active local boundary

1. Inspect the MCP `tools/list` result and the selected project identity. Never
   invent a missing operation or infer authority from an internal module.
2. Confirm the intended native KiCad project and requested outcome. Do not
   replace it with the bundled reference fixture.
3. Prefer read/inspect operations before native verification, rendering,
   export, or any supported mutation.
4. Keep EvlEDA deterministic findings separate from results produced by the
   identity-pinned KiCad executable.
5. Treat missing, stale, skipped, crashed, timed-out, or unparsable evidence as
   non-passing.

For installation and connection diagnostics, read
[client setup](references/client-setup.md).

## Existing-project workflow

- Inventory the project and bind the exact source/revision before work.
- Ask only the requirements questions needed for the requested change. For a
  material electrical or board change, read
  [interview and requirements](references/interview-and-requirements.md).
- For supported placement or routing work, preserve locked objects, existing
  constraints, and KiCad-native semantics; read
  [design, placement, and routing](references/design-placement-routing.md).
- Before a write, require the typed feature-gated tool, exact preview/diff, base
  identity, and approval contract advertised by the server. If the tool is
  absent, stop; do not fall back to shell commands or direct raw-file writes.
- Run native checks only on an isolated, digest-bound working copy and verify
  the canonical source is unchanged. For evidence/export rules, read
  [verification, evidence, and CAM](references/verification-evidence-cam.md).
- Return native KiCad files and bound reports/artifacts. Tell the user what they
  should open or review in KiCad and list every unresolved limitation.

## Authority rules

- The model may propose and explain; it cannot declare that ERC, DRC, parity,
  source preservation, or manufacturing release passed.
- The internal canonical model/compiler is a guardrail, not a second editor or
  user-facing CAD format. Unsupported or lossy mappings block.
- KiCad results must come from the configured local KiCad executable and bind
  to the exact checked project copy.
- Never expose arbitrary filesystem paths, a shell, caller-selected executable,
  or an unadvertised capability through PCB operations.
- Any approval applies only to its exact project revision and preview digest.
  Re-preview after any material input or source change.
- Label exports **NON-RELEASE CANDIDATE** unless a separate qualified release
  process for the exact artifact has actually completed.

## Reference fixture

`reference-usb-c-3v3-r2` is an installation/acceptance demo with frozen
verification evidence. Use it only when the user asks for the demo or when a
documented smoke/acceptance procedure requires it. It is not EvlEDA's CAD
software, not an arbitrary-board generator, and not a substitute for the user's
project.

## Transport boundary

The supported MCP transport is the local child process's stdin/stdout. Do not
start a web server, open a port, create a tunnel, or describe a cloud development
task as the user's runtime. If remote access is requested, explain that it is
outside this package's security and product boundary.

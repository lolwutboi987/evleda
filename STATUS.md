# EvlEDA status

Status snapshot: 2026-09-03. EvlEDA is an engineering-preview local MCP and
skill package for Codex and Claude Code users who already have KiCad installed.
It is not standalone CAD software and is not a production PCB release system.

## Public product boundary

- `evleda-mcp` is a local stdio subprocess launched by the AI client.
- There is no browser/editor UI, HTTP API, network listener, hosted runtime,
  account system, or multi-tenant service in the public repository or wheel.
- Native KiCad project files are the user-facing design artifacts. KiCad is the
  authoritative native editor and native ERC/DRC/render/export implementation.
- EvlEDA's canonical graph, compiler, approval, and verification packages are
  internal guardrails around supported MCP operations, not another editor.
- The server advertises only operations enabled by the active local profile.
  A client must not infer missing operations or replace them with shell access.

## Usable now

- Installable Python 3.12 package and `evleda-mcp` stdio entry point.
- Codex and Claude Code plugin metadata bundling the same stdio configuration
  and the `evleda` workflow skill.
- Protected-platform KiCad 10 discovery or an explicit reviewed executable
  path, with exact version/hash reporting through `doctor`.
- Protocol-level `smoke` covering initialize, tool discovery, ping, and strict
  newline-delimited JSON-RPC without opening a network port.
- Outcome-level project inspection and KiCad-backed operations exposed only
  when their project, worker, and policy dependencies are configured.
- Deterministic canonicalization, integer-unit geometry, typed commands,
  compiler/reparse parity, electrical/geometry/connectivity checks, source
  preservation, and content-addressed evidence behind the MCP boundary.
- Isolated KiCad CLI execution with fixed argv, bounded output/time, executable
  identity pinning, and fail-closed report parsing.

Typed write operations are feature-gated. Their presence in internal modules or
documentation is not authority to call them; `tools/list` for the running local
server is authoritative.

## Reference demo fixture

`reference-usb-c-3v3-r2` is a 23-component, 13-net USB-C 5 V to 3.3 V reference
PCB with a 100 mA output design target. It exists to demonstrate and test the
package's deterministic path; it is not the EvlEDA product and is never a
silent substitute for a user's KiCad project.

Frozen evidence records:

- KiCad 10.0.6 ERC: 0 violations;
- unfilled and refilled DRC: 0 violations and 0 unconnected items;
- all 29 compiler-owned files unchanged by native verification;
- strict project reparse and schematic/PCB semantic parity passed;
- visual review of schematic, PCB plots, and top/isometric renders passed;
- 18 CAM artifacts and 23 BOM lines in a non-release candidate.

The authoritative identities and limitations are in the
[final verification receipt](examples/reference_usb_c_3v3_r2/FINAL_VERIFICATION.md).

## Deliberate limitations

- No replacement schematic editor, PCB editor, browser studio, or custom CAD
  file format is offered.
- No remote MCP transport, HTTP wrapper, login, collaboration server, or hosted
  deployment is supported.
- A broad raw KiCad command surface, arbitrary filesystem paths, and arbitrary
  shell execution are intentionally absent.
- Unsupported KiCad constructs fail closed; coverage is not equivalent to all
  KiCad features and plugins.
- General placement/routing is not treated as solved merely because an LLM
  proposed geometry.
- Production sourcing, qualified simulation, SI/PI/EMC/thermal sign-off,
  compliance, physical bring-up, and manufacturing release remain outside a
  clean digital verification result.

## Release boundary

The reference fixture demonstrates canonical checks, exact KiCad bytes, native
ERC/DRC evidence, renders, BOM, and non-release CAM. It does not prove that all
requirements were correct, parts are procurable, or assembled hardware is safe.
See [docs/RELEASE_STATUS.md](docs/RELEASE_STATUS.md) for open qualification
items.

## Cloud boundary

The repository's cloud runbook is for reproducible development and acceptance
testing of the fixed reference fixture. It does not deploy EvlEDA as a service
and does not create a runtime endpoint. End users run the MCP beside their local
Codex or Claude Code client and local KiCad installation.

## Next milestone

Broaden safe coverage for user-selected existing KiCad projects while keeping
KiCad authoritative, mutations typed and approval-bound, unsupported constructs
explicit, and every native claim tied to exact source and executable identities.

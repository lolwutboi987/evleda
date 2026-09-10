# PCB agent harness proof of concept

The local CLI makes a bounded KiCad edit-and-check pass in either an isolated
copy or a bundle-bound fresh project. It is a proof of concept only: it does
not produce manufacturing, release, safety, qualification, or electrical
sign-off claims.

```powershell
pnpm pcb-agent --workflow copied_project --prompt "Move J1 to the left edge and reroute its signals" --provider openai --model <model> --project-dir C:\boards\source --output-dir C:\boards\run-001 --iterations 3
```

Use `--prompt-file C:\request.txt` instead of `--prompt` for a UTF-8 request.
`--model` is always required. The available providers are `openai`,
`anthropic`, `codex`, and `claude-cli`. The HTTP providers use API keys:
OpenAI reads `OPENAI_API_KEY` and Anthropic reads `ANTHROPIC_API_KEY`. OpenAI
uses the Responses `priority` service tier for fast mode by default; pass
`--standard` to send the Responses `default` tier. `codex` uses the existing
local `codex login` session in a read-only, isolated structured-output mode;
it does not require `OPENAI_API_KEY`. `claude-cli` requires an existing local
`claude auth login` session and does not require `ANTHROPIC_API_KEY`.

Every run has an explicit workflow discriminator. `copied_project` retains the
isolated-copy prompt workflow. `led_compatibility_fixture` retains the closed
LED proof fixture and is never the generic default. `generic` is fresh-project
only and forbids both `--prompt` and `--project-dir`; it requires a canonical
`--bundle-file` plus its exact `--bundle-ref-file`. Trusted library/catalog
dependencies verify both files before executable CLI options are constructed.
The deep-rule dependency comes from the identity-bound, module-relative
[packaged corpus](deep-rule-resources.md), never an ambient workspace catalog.
The harness sends the bundle's `executionPrompt.text` as the provider user
frame byte-for-byte, with no appended contract, rendering, or truncation.

The output directory must be empty and disjoint from the source project. The
CLI copies the source to `<output-dir>\project`, connects the write-enabled
sidecar only to that copy, and writes `<output-dir>\pcb-agent-report.json` on
both completed and handled failed runs. It prints both paths at the end.

For the required manual KiCad IPC step, first run the normal command with
`--prepare`. This creates the isolated copy and its path-bound marker, then
prints the exact `pcbnew.exe`/IPC setup instruction without attempting a
sidecar connection. Open the copied board, enable the IPC API Server, clear
modal dialogs, and rerun the same command with `--resume`. Resume rejects a
marker whose source or output path does not match the requested paths.

For example, prepare and then resume a Codex-backed run with the same source
and output paths:

```powershell
pnpm pcb-agent --workflow copied_project --prompt "Move J1 to the left edge and reroute its signals" --provider codex --model gpt-5.6-sol --project-dir C:\boards\source --output-dir C:\boards\run-codex --prepare
# Complete the manual KiCad IPC step, then:
pnpm pcb-agent --workflow copied_project --prompt "Move J1 to the left edge and reroute its signals" --provider codex --model gpt-5.6-sol --project-dir C:\boards\source --output-dir C:\boards\run-codex --resume
```

## Fresh-project checkpoint-open

For `--new-project` runs, the immutable preparation marker is separate from
the current checkpoint. A resume requires the current schematic, PCB, and
project-local library-table hashes to match that checkpoint. If KiCad 10 only
expanded the blank project's `.kicad_pro` while opening/saving it, use the
provider-free review phase below before resuming:

```powershell
pnpm pcb-agent --new-project fresh-canary-3 --output-dir C:\boards\fresh-canary-3 --checkpoint-open
```

This command never invokes a provider, MCP tool, or KiCad edit. It accepts
only the audited KiCad 10 default/empty-project normalization, rejects any
schematic, PCB, symbol-table, or footprint-table drift, and records the new
project-file hash with reason `kicad_open_normalization`. Custom net classes,
widths, vias, differential settings, DRC exclusions, paths, pinned libraries,
text variables, and added sheets/boards are rejected.

Generic fresh projects use V2 markers and checkpoints. They bind the complete
bundle reference, contract/library/deep-rule/practice/acceptance/prompt
identities, and the exact generated symbol/footprint table byte identities.
A V1 LED marker cannot be upgraded in place to generic execution. Before a
generic native run, the host materializes bundle-owned net classes into the
marker-owned project; completion then requires an independently re-read and
verified effective-clearance receipt. Native validation is bracketed by hashes
of the schematic, PCB, project settings, custom rules, both library tables, and
fresh marker. Any drift, missing netlist, or unavailable clearance/rules
evidence produces `needs_review`, never a synthetic pass.
Injected clearance ports return the full receipt; the CLI independently
re-derives it with the exact project, bundle, and KiCad identity. If any source
changes afterward, both the receipt and its acceptance projection are removed
from the terminal report and the clearance row returns to `unknown`.

Each edit iteration saves the copied board, then automatically invokes the
locked sidecar's actual `run_erc`, `run_drc`, `pcb_get_board_summary`, and
`pcb_visual_qa` tools. A run is completed only when those checks explicitly
report no error-level findings. It is otherwise `needs_review`, `blocked`, or
`failed`. Exit codes are 0 for completed, 2 for needs review, and 1 for
blocked or failed.

## KiCad capability matrix

The CLI never launches KiCad. Before a live run, open
`D:\Codex-Recovery\KiCad\10.0\bin\pcbnew.exe <output-dir>\project\<board>.kicad_pcb`,
enable **Preferences -> Scripting -> IPC API Server**, and clear modal dialogs.
Then retry. A custom socket or token is used only when its environment setting
is explicitly configured.

| Capability | Result |
| --- | --- |
| IPC with edit and `pcb_save` | The isolated copy may be saved and checked. |
| IPC edit but no `pcb_save` | The harness must verify a changed isolated file; otherwise it blocks with a user-save instruction. |
| IPC unavailable | The run reports the IPC requirement and does not claim an edit persisted. |
| Missing MCP ERC/DRC/summary operation | With `--kicad-cli` (which overrides `EVLEDA_KICAD_CLI`), the CLI uses a deterministic, source-preserving `KicadCliAdapter` fallback. Without either setting it probes known KiCad 10 paths, including the recovery runtime, before PATH. The selected executable identity is retained in the validation result. |
| Missing MCP visual QA | Returns `needs_review` with `visual_unavailable`; it does not export BOM, Gerber, drill, placement, or render artifacts as a substitute. |

Provider calls retain their native tool history on later turns. Incomplete
OpenAI Responses or Anthropic `max_tokens` responses are rejected before any
requested tool call runs. Read-only inspections never satisfy the required edit
condition. Provider-visible tools exclude save and all final validation tools;
the host reruns final checks internally after each verified persisted mutation.

The production CLI reads `sidecars/kicad-mcp-pro.lock.json`, hashes the locked
`uv`, `uvx`, Python, and `kicad-mcp-pro` wheel before launch, and binds the
session to the locked `uvx` identity. The lock currently freezes the
`uv.exe` SHA-256
`f9984f1375c819a42f59de73abc468eb76abef0a9a4097167b0a770ede81dc18`,
`uvx.exe` SHA-256
`27de9e9f6a5089bead9fcbbeff46bf4da34862430b8f949b5d9b1e4b0c916911`,
the managed Python SHA-256
`264a93517ecc069ee57dff451b66ed1c7b8d8543911f3d86e494ac44e96d6a10`, and
the `kicad-mcp-pro` 3.33.3 wheel SHA-256
`c26f4dc6e2360375330056864490aab96f30f1d3f1c7d51bc57e42d4f9e4c26f`, the
the audited source commit `817969d7e302ad470c2cac3d7c20961419400c47`.

Live limitations remain: a local locked runtime, a working KiCad installation,
and the selected provider credential (an HTTP API key or local CLI sign-in)
are required. Offline tests exercise fake provider responses and a fake KiCad
session only; they do not demonstrate a live model call or validate a physical
board.

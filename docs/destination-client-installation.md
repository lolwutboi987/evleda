# Destination client installation

The global EvlEDA workspace entry now uses catalog profile02 and the updated local skill. The installed Codex CLI discovers **15 initial tools, including `evleda_search_library`**. **The running desktop's activation and dynamic tool refresh remain unverified.** No CAD project or model turn was created during these installation probes.

## Current catalog profile02 installation

The [catalog installation record](../../destination-verification/stock-catalog-01/client/installation.json) records changes only to the existing entry's profile path, SHA-256 and byte-count arguments. Unrelated raw configuration and parsed settings were preserved, with private configuration/skill backups retained. The [installation audit](../../destination-verification/stock-catalog-01/client/installation-audit.json) passed all 12 scoped checks.

- Profile: `toolbox-native-doc6-stock-catalog-destination-02.json`, 16,260 bytes, SHA-256 `b723a4f5a2a8b2aa5eee9131df22a9e5c2fc1c13eb2e70718ae29ff4acd7cfcc`; 222 approved symbol and 155 footprint namespaces, with the bounded connection policy.
- Installed skill: validated exact local copy at `C:\Users\kidch\.codex\skills\evleda-pcb\SKILL.md`, SHA-256 `540440fc8d9c32c842f6178a4f419368bd961ebe00e5e21b3cf38149b15ef906`.
- Workspace: `C:\Users\kidch\Documents\EvlEDA-Workspace`, with no allocations at the audit. Edit access, 30-second MCP startup and 180-second tool timeout remain unchanged.

The [exact installed STDIO command](../../destination-verification/stock-catalog-01/client/workspace-preflight.json) passed four read-only discovery calls with 15 tools and a 660.4752 ms connection. A [fresh installed Codex CLI app-server](../../destination-verification/stock-catalog-01/client/codex-client-catalog-v2.json) independently read the actual global entry, found the same 15 tools and exited with code 0. Other servers/plugins were disabled only within that probe; no task, model turn or native project was created. The current desktop tool catalog still returned no EvlEDA tools. These passes do not establish desktop readiness or notification handling.

The separate [33-call native catalog lifecycle](toolbox-stock-catalog.md#passing-native02-lifecycle) passed authoring, placement, previews, two closes and same-connection resume in an isolated proof workspace. That intentionally unrouted fixture is separate from installation and does not qualify every catalog part.

## Initial profile03 installation (preserved)

The [installation record](../../destination-verification/client-installation-01/installation.json) records the appended `mcp_servers.evleda_workspace` entry in `C:\Users\kidch\.codex\config.toml`, its before/after identities and a private backup path. All preceding configuration bytes and unrelated semantic settings were preserved; the record does not include the backup's contents. The [entry-only TOML](../../destination-verification/client-installation-01/installed-entry.toml) contains the exact installed Node/compiled-STDIO command.

- Workspace: `C:\Users\kidch\Documents\EvlEDA-Workspace`.
- Profile03: 7,505 bytes, SHA-256 `19733a1995b09cc788b2138031d834199d2193a1dffa47ac8366c38149be5bd3`; its allowlist contains three symbols and three footprints for the software fixtures.
- Skill: exact local copy at `C:\Users\kidch\.codex\skills\evleda-pcb\SKILL.md`, byte-verified and validated; SHA-256 `3dabfef65c332af26c86a1c3db6e4831a86e7e25ee84c3f33abc8023466753f6`. No network skill installation was used.
- Entry policy: edit-capable workspace, 30-second startup and 180-second tool timeout. No fixed `enabled_tools` list, `required: true`, global startup-grace change or HTTP listener was introduced. Existing security settings and disabled repository examples remain unchanged.

That initial profile controlled available parts and native authority. The initial installation did not expand its exact allowlist or qualify additional board families.

The [post-installation audit](../../destination-verification/client-installation-01/installation-audit.json) passed all 12 scoped checks: exact backup/current hashes, original configuration byte prefix, unrelated settings, installed entry, exact skill copy, canonical backup path, CLI catalog, and the doctor's configuration checks. Desktop activation remains explicitly unverified.

### Initial verification results

| Evidence | Recorded outcome |
| --- | --- |
| [Exact-command workspace preflight](../../destination-verification/client-installation-01/workspace-preflight.json) | Passed; connected in 1,100.9318 ms with 14 tools. Called only `evleda_workspace_status`, `evleda_design_schema` and `evleda_inspect_library`; no CAD or model session. |
| [Installed Codex client catalog v2](../../destination-verification/client-installation-01/codex-client-catalog-v2.json) | Codex CLI 0.147.0 app-server loaded all 14 EvlEDA tools from the real global entry and exited with code 0. Other MCPs/plugins were disabled only through probe-local overrides; no task, model turn or native project was created. |
| [Original client catalog probe](../../destination-verification/client-installation-01/codex-client-catalog.json) | Remains failed: incorrectly quoted override keys caused a configuration error. Only the probe was corrected for v2. |
| [Codex doctor](../../destination-verification/client-installation-01/codex-doctor.json) | Overall failed because `TERM=dumb`; rollout/database parity also warned. `config.load` and `mcp.config` passed. This is not a clean doctor result. |

`codex mcp get evleda_workspace` also read the installed entry successfully. Direct execution of the running desktop AppX 26.901.5280.0 bundled executable returned Access Denied; no ACL was changed. A fresh subagent catalog found the installed skill but no EvlEDA MCP tools. These observations do not establish desktop readiness or attach/detach notification handling.

## Remaining activation step

Restart the desktop, load a new task context, and verify the actual connected server and EvlEDA tool catalog. Then verify CAD-tool appearance/removal after the intended workspace attach/detach workflow, preserving normal project close/checkpoint requirements. Official documentation describes shared local Codex-host MCP configuration and desktop restart; `/mcp` displays connected servers, rather than supplying an undocumented refresh command. [Official MCP setup](https://learn.chatgpt.com/docs/extend/mcp).

The app-server documents `mcpServerStatus/list` and `config/mcpServer/reload`; the latter queues refresh for loaded tasks. The CLI status probe is separate from observing the running desktop consume those changes. [Official app-server API](https://learn.chatgpt.com/docs/app-server).

Client activation, broader engineering and library choices, the chosen GitHub publication and the requested RP2350 board remain open. The [native interface qualification](destination-interface-qualification.md) keeps its earlier scripted workflow scope; installing the client does not add board acceptance.

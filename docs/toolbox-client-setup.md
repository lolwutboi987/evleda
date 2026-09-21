# Connect a local client to the EvlEDA toolbox

The recommended [workspace configuration example](../examples/toolbox-workspace.config.toml) connects once and lets the client submit drafts, answer clarifications, create and resume projects over MCP. The older [explicit-project example](../examples/toolbox-mcp.config.toml) remains available. Both are disabled examples, not installed client settings. Replace placeholders with host-approved values before enabling the intended configuration.

The global `evleda_workspace` entry now uses **frozen host54, DOC17 and the v4
approved library profile**, plus an exact copy of the current PCB skill.
[Native and client qualification](../proofs/plane-exterior-bores-20260920/README.md)
verifies **19 initial tools in a fresh actual Codex client**, including the
explicit supplemental-plane and terminal-launch revision operations. The stock catalog is retained.
The client wait is 1,800 seconds; native bounds, edit policy, workspace and
unrelated settings are preserved. Already-running desktop connections are not
claimed to have reloaded. See [installation details](destination-client-installation.md)
for the current entry and preserved earlier evidence. Repository configuration
examples remain disabled.

The installed [stock-catalog mode](toolbox-stock-catalog.md) searches 222 approved symbol and 155 footprint namespaces, followed by exact inspection and selected-source pins in compiled bundles. Native02 passed 33 calls for C1/R1/J1 authoring, placement, previews, normal close and same-connection resume. Its seven-pad RC fixture remains intentionally unrouted; no full ERC/DRC, routing or design acceptance follows. Discovery does not qualify every part, and earlier exact-ID profiles retain their behavior.

Local STDIO MCP is supported by the ChatGPT desktop app, Codex CLI, and Codex IDE extension. These clients can start the toolbox process on the same host as its approved KiCad installation. ChatGPT web uses remote MCP tools supplied through plugins and does not read this local configuration; this repository example does not deploy a remote service. See the [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The optional V2 [external-power declaration](toolbox-external-power.md) uses the qualified graph semantics in installed frozen DOC7 [profile02](../../working-profiles/toolbox-native-doc7-stock-catalog-destination-02.json), with the qualified Windows helper manifest. Native10 completes NC-correct authoring/routing, strict public DRC/parity zero, normal close and fresh read-only reopen with unchanged sources; inspect the checked-in [regulator proof](../examples/wson-regulator-toolbox-proof/README.md). The edit-session plane result is incomplete at 9 passed/38 unknown/0 failed; read-only correctly has 47 unknown rows without a current-session fill witness. Named-NC netclass/checkpoint support is V2 only: select advertised `plane-v2` or report unsupported scope; legacy V1 readers remain fail-closed. Use only the approved host profile/pin, and keep installation, native lifecycle and design acceptance distinct.

## Workspace startup and in-chat design

Build the repository using its existing build process. Workspace mode starts `dist/src/mcp/toolbox-workspace-main.js` with the host's Node executable, exact profile pin, one existing approved `--workspace-root`, and optionally `--edit`. The workspace must be separate from the profile, installed runtime, libraries, research corpus and calculator directory. Model requests cannot replace those installation choices.

The server initially provides guidance, design schema, approved-library inspection, draft compilation and the configured analytical calculator. It does **not** launch KiCad during connection. A real local STDIO test connected in approximately 1.0 seconds; a later restarted connection took approximately 1.2 seconds. These are observations, not guaranteed startup bounds.

The client workflow is:

1. Read `evleda_workspace_status`, `evleda_design_schema` and appropriate `evleda_inspect_library` results. The schema tool returns `supportedFamilies`, a model guide and an example. Select `family: "plane-v2"` for supported plane designs; omitting `family` retains the `routed-v1` default.
2. Submit a complete structured draft, design name and original request with `evleda_submit_design`. Missing requirements and unsupported capabilities return in-band questions/issues. No project is allocated for a clarification result. The connected client model performs interpretation; no nested model/provider is started.
3. Review the ready result, then call `evleda_create_project` with its `draftId`. The host persists the draft internally, creates disjoint input/output directories and uses the existing pinned native preparation. The expected compilation identity is rechecked before native project creation. Reuse the same ID after a timeout; a repeated call never allocates a second project.
4. Refresh the tool list after attachment. Read `evleda_design_context`, then use the existing authoring, save/readback, check, preview and stackup tools. An open project and a ready contract are not a completed design.
5. Call `evleda_close_project` with the active project ID before disconnecting. It uses the existing finish/checkpoint mechanism and releases the workspace lease only after confirmed clean finalization. `evleda_finish_session` also invokes the lease callback, but the workspace close operation additionally detaches CAD tools.
6. Later, use `evleda_list_projects` and `evleda_resume_project` with the opaque project ID. The installation arguments remain unchanged; no new draft or prompt is accepted as resume authority. Both same-connection and fresh-process resume were exercised on the native fixture.

One native project may be active per connection. Uncertain startup/finalization retains its allocation and lease for host review; it is not a signal to remove `.toolbox-lease.json` or `.toolbox-admission.json`. Pending, uncreated drafts are in memory and can be removed with `evleda_discard_draft`; this does not delete files. After a server restart, resubmit an uncreated draft. Created projects are persisted and listed separately.

Startup failure artifacts retain the first stage and cause separately from cleanup. In builds with guard diagnostics, `failure.cause.guards` optionally identifies the checks that rejected startup, ordered from the innermost failure to its surrounding operation. For example, `["directory-binding-changed", "ipc-listener"]` identifies replacement of the bound listener directory, while `["runtime-file-manifest", "runtime-tree"]` identifies a runtime file that differs from its manifest. These are fixed host identifiers, capped at four; messages, paths, stacks, native tokens and arbitrary error properties are never copied into this field. Untagged failures keep the existing category/code report. Guard identifiers locate a rejected check; they do not establish why the external state changed or authorize recovery. Older diagnostic files cannot recover identifiers that were never recorded.

The SDK client rediscovered tools over actual STDIO after attachment/detachment. A particular application's handling of tool-list changes still needs to be checked during installation; do not claim app deployment merely from these protocol tests. Existing project-copy startup continues to use the explicit-project command below.

## Existing explicit-project native startup

The older example starts `dist/src/mcp/toolbox-native-main.js` directly. The build packages `toolbox-editor-supervisor.py` beside the native launcher for both modes. Use a Node version supported by `package.json`.

The host must supply an approved native profile and its exact SHA-256 and byte count. Fresh designs additionally need that profile's approved library and deep-rule resources. Placeholder paths, arbitrary hashes, or a draft's contents do not supply runtime authority. The ordinary `toolbox-main` entrypoint is guidance-only; it cannot open CAD by itself.

For a new fresh project, the native command requires:

- `--profile`, `--profile-sha256`, and `--profile-bytes`: the host's exact profile pin.
- `--project-dir`: a separate existing input folder containing the draft.
- `--output-dir`: a new, empty output folder, separate from protected input/runtime resources.
- `--new-project`: the native project name.
- `--intent`: an ordinary draft JSON file inside the input folder.
- `--prompt`: the original design request.
- `--edit`: explicitly enables the host's edit access. Omit it for read-only CAD tools.

The structured draft must compile successfully; unresolved requirements produce clarification output rather than invented design values. Existing-project copies instead use `--board <filename.kicad_pcb>` and omit `--new-project`, `--intent`, and `--prompt`. The source project is supplied through `--project-dir`; edits operate on the isolated output copy.

## Optional plane-acceptance dependencies

The host can add `kicadPlaneContacts` to its existing pinned native profile. It has exactly these fields:

| Field | Host-supplied value |
| --- | --- |
| `runtimeRoot` | Absolute path to the isolated native contacts runtime with a closed, verified runtime manifest. |
| `manifest` | Exactly `{path, sha256, sizeBytes}` for that manifest. |
| `helper` | Exactly `{path, sha256, sizeBytes}` for the reviewed contacts helper. |

Use measured SHA-256/byte counts for the actual files, then regenerate the enclosing profile pin. The isolated runtime binds its Python, native KiCad modules and dependency closure; an executable found on PATH or ambient import search does not supply that authority. Keep the runtime, manifest/helper and their protected directories disjoint from editable project/output roots. No global settings or original frozen profile are changed automatically.

The owning native-profile factory creates the reader for the bound saved PCB and current source identity, with its private output directory and process controls. These are host configuration fields, not MCP arguments. The separate optional `kicadReferenceCoverage` helper remains necessary for dependent geometric reference-coverage facts; the transmission-line calculator does not substitute for it. Missing optional evidence remains unknown.

After V2 attachment, refresh the tool list. When available, call `evleda_check_plane_acceptance` with `{}` only after `fresh_apply_contract_plane` has established a current-session native fill witness and completed mandatory save/readback. Reapply after relevant edits or reopening; saved caches, checkpoints and old diagnostic files cannot renew the witness. A read-only resumed session can inspect endpoints/previews, but cannot establish a new fill witness through this read tool. Its host must enable the appropriate edit workflow if fresh plane assessment is needed; a model cannot promote its access.

The tool returns every verification row and scoped component/area/contact/native-rule/reference fact, with unresolved physical minimum copper and thermal-spoke widths. `acceptanceEvaluated: true` is scoped evaluation; `accepted` and `fabricationAuthorized` remain false. Public reports omit private paths/raw captures, retaining a separate diagnostic filename/hash. See [tool behavior](toolbox.md#source-bound-plane-acceptance-facts) and [destination verification](destination-plane-acceptance.md). The native reader passed, and proof02 completed its 49-operation public workflow while preserving three footprint namespace warnings and uncovered VIN reference copper. Earlier attempt01 and DOC6 attempt03 failed at startup before authoring; DOC6's full-ID repair is offline qualified, while the later startup-only probe04 also failed at bridge revalidation before public authoring. Startup05 subsequently reached connected native status and 40 public tools, but blank-project checkpointing failed with `Live PCB differs from saved source`. The later [proof07](../../destination-startup-doc6-07/result.json) qualifies repaired blank initialization, close/checkpoint and read-only reopen. The host's initial Save may normalize project defaults and create one exactly checked native history snapshot before public tools appear; seven observed sources remain unchanged afterward, and resumed sessions do not repeat that Save. The later [routed05 evidence](destination-plane-acceptance.md#doc6-routed-authoring05-and-separate-read-only-qualification) verifies full saved footprint IDs and strict DRC/parity cleanliness. Preserve its failed driver assertion separately from the successful read-only reopen; missing fresh fill, drill/contact gaps and ignored ERC checks still block whole acceptance. A later same-board reassessment confirms 9 passed/1 failed/27 unknown rows; the driver still failed a raw periodic-angle comparison, with cleanup and current-checkpoint consistency audited separately. These results do not establish whole acceptance.

## Client configuration and timing

The example uses the documented `mcp_servers` table with `command`, `args`, and `cwd`. Select the intended client configuration scope; the file in `examples/` is not automatically loaded. The desktop's documented setup also offers Settings → MCP servers → Add server → STDIO, followed by a restart. Check the client's connected-server view after setup. See [official MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For the installed destination entry, restart the desktop and verify `evleda_workspace` in its connected-server view and a newly loaded task's actual tool catalog before claiming activation. Skill discovery alone is insufficient. The separate CLI app-server catalog check did not exercise desktop `notifications/tools/list_changed` behavior; attach/detach refresh still needs that client's own observation. The documented app-server `config/mcpServer/reload` API queues a refresh for loaded tasks, but it was not verified against the running desktop here. See the [official app-server API](https://learn.chatgpt.com/docs/app-server).

The workspace example allows 30 seconds for connection and 180 seconds for tools: the long native startup now occurs inside create/resume, not the initial handshake. The older explicit-project example still allows 180 seconds for both. Official defaults are 10 seconds for startup and 60 seconds for tools. Optional servers share a 1,000 ms initial-catalog grace period; changing the server startup timeout does not change it. The documented top-level `mcp_optional_startup_grace_ms = 0` instead waits according to server timeouts. It affects optional servers generally and is deliberately not changed here. See the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The installed catalog profile02 opts into [`bounded-phases-v1`](toolbox-stock-catalog.md#opt-in-connection-deadline-policy): at most 30 seconds through deferred binding and 30 seconds afterward, with a fixed 60-second admission cap and earlier caller limits preserved. This is distinct from MCP startup/tool timeouts and excludes cleanup and other host startup work. Omitted-policy profiles, including the preserved exact profile03, retain the old behavior. Loader/typecheck/build verification and the bounded native02 lifecycle passed separately.

## Explicit-project finish and resume

After connecting, call `evleda_toolbox_status` to confirm native access and advertised tools. A configured server entry alone is not evidence of a working CAD session. Use the applicable native checks and review their individual outcomes; successful startup does not approve the engineering design.

Before disconnecting, call `evleda_finish_session` and inspect its result. It drains pending operations, closes the owned native session, and publishes a saved-candidate checkpoint when supported and certain. For a fresh session intended for resume, require `nativeSessionClosed: true`, `checkpointPublished: true`, and no recovery-required condition. The tool ends CAD work in that connection. Finalization errors or uncertain recovery must be resolved by the host; do not edit checkpoint files to force a resume.

Fresh preparation saves `toolbox-design-bundle.json` in the output folder, alongside the report, marker, checkpoint, and native project. Keep that output folder intact. To reopen it, retain the same name, output folder, input folder, and approved profile arguments; add `--resume`, and remove `--intent` and `--prompt` with their values. The persisted canonical bundle remains authoritative. Resume checks its binding, checkpointed source bytes, native toolchain, and net-class evidence. A changed draft is not silently substituted for the saved design.

Use one native connection per output project at a time. After the first successful preparation, update the client's startup arguments to the resume form before reconnecting to that output; repeating fresh creation against a populated output is rejected.

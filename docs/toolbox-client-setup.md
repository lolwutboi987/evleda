# Connect a local client to the EvlEDA toolbox

The recommended [workspace configuration example](../examples/toolbox-workspace.config.toml) connects once and lets the client submit drafts, answer clarifications, create and resume projects over MCP. The older [explicit-project example](../examples/toolbox-mcp.config.toml) remains available. Both are disabled examples, not installed client settings. Replace placeholders with host-approved values before enabling the intended configuration.

Local STDIO MCP is supported by the ChatGPT desktop app, Codex CLI, and Codex IDE extension. These clients can start the toolbox process on the same host as its approved KiCad installation. ChatGPT web uses remote MCP tools supplied through plugins and does not read this local configuration; this repository example does not deploy a remote service. See the [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Workspace startup and in-chat design

Build the repository using its existing build process. Workspace mode starts `dist/src/mcp/toolbox-workspace-main.js` with the host's Node executable, exact profile pin, one existing approved `--workspace-root`, and optionally `--edit`. The workspace must be separate from the profile, installed runtime, libraries, research corpus and calculator directory. Model requests cannot replace those installation choices.

The server initially provides guidance, design schema, approved-library inspection, draft compilation and the configured analytical calculator. It does **not** launch KiCad during connection. A real local STDIO test connected in approximately 1.0 seconds; a later restarted connection took approximately 1.2 seconds. These are observations, not guaranteed startup bounds.

The client workflow is:

1. Read `evleda_workspace_status`, `evleda_design_schema` and appropriate `evleda_inspect_library` results. The schema tool includes the existing model guide and valid example.
2. Submit a complete structured draft, design name and original request with `evleda_submit_design`. Missing requirements and unsupported capabilities return in-band questions/issues. No project is allocated for a clarification result. The connected client model performs interpretation; no nested model/provider is started.
3. Review the ready result, then call `evleda_create_project` with its `draftId`. The host persists the draft internally, creates disjoint input/output directories and uses the existing pinned native preparation. The expected compilation identity is rechecked before native project creation. Reuse the same ID after a timeout; a repeated call never allocates a second project.
4. Refresh the tool list after attachment. Read `evleda_design_context`, then use the existing authoring, save/readback, check, preview and stackup tools. An open project and a ready contract are not a completed design.
5. Call `evleda_close_project` with the active project ID before disconnecting. It uses the existing finish/checkpoint mechanism and releases the workspace lease only after confirmed clean finalization. `evleda_finish_session` also invokes the lease callback, but the workspace close operation additionally detaches CAD tools.
6. Later, use `evleda_list_projects` and `evleda_resume_project` with the opaque project ID. The installation arguments remain unchanged; no new draft or prompt is accepted as resume authority. Both same-connection and fresh-process resume were exercised on the native fixture.

One native project may be active per connection. Uncertain startup/finalization retains its allocation and lease for host review; it is not a signal to remove `.toolbox-lease.json` or `.toolbox-admission.json`. Pending, uncreated drafts are in memory and can be removed with `evleda_discard_draft`; this does not delete files. After a server restart, resubmit an uncreated draft. Created projects are persisted and listed separately.

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

## Client configuration and timing

The example uses the documented `mcp_servers` table with `command`, `args`, and `cwd`. Select the intended client configuration scope; the file in `examples/` is not automatically loaded. The desktop's documented setup also offers Settings → MCP servers → Add server → STDIO, followed by a restart. Check the client's connected-server view after setup. See [official MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The workspace example allows 30 seconds for connection and 180 seconds for tools: the long native startup now occurs inside create/resume, not the initial handshake. The older explicit-project example still allows 180 seconds for both. Official defaults are 10 seconds for startup and 60 seconds for tools. Optional servers share a 1,000 ms initial-catalog grace period; changing the server startup timeout does not change it. The documented top-level `mcp_optional_startup_grace_ms = 0` instead waits according to server timeouts. It affects optional servers generally and is deliberately not changed here. See the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Explicit-project finish and resume

After connecting, call `evleda_toolbox_status` to confirm native access and advertised tools. A configured server entry alone is not evidence of a working CAD session. Use the applicable native checks and review their individual outcomes; successful startup does not approve the engineering design.

Before disconnecting, call `evleda_finish_session` and inspect its result. It drains pending operations, closes the owned native session, and publishes a saved-candidate checkpoint when supported and certain. For a fresh session intended for resume, require `nativeSessionClosed: true`, `checkpointPublished: true`, and no recovery-required condition. The tool ends CAD work in that connection. Finalization errors or uncertain recovery must be resolved by the host; do not edit checkpoint files to force a resume.

Fresh preparation saves `toolbox-design-bundle.json` in the output folder, alongside the report, marker, checkpoint, and native project. Keep that output folder intact. To reopen it, retain the same name, output folder, input folder, and approved profile arguments; add `--resume`, and remove `--intent` and `--prompt` with their values. The persisted canonical bundle remains authoritative. Resume checks its binding, checkpointed source bytes, native toolchain, and net-class evidence. A changed draft is not silently substituted for the saved design.

Use one native connection per output project at a time. After the first successful preparation, update the client's startup arguments to the resume form before reconnecting to that output; repeating fresh creation against a populated output is rejected.

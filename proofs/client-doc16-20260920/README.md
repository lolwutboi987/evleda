# DOC16 client delivery — 20 September 2026

The existing local `evleda_workspace` entry now selects the frozen host41 server,
DOC16 runtime profile and v4 approved RP2350 library package. It retains the same
222 stock symbol and 155 stock footprint namespaces, global workspace path,
edit policy and SYSTEMROOT/WINDIR environment allowlist. The repository PCB
skill is installed byte-exactly. Unrelated configuration bytes are unchanged;
private backups are retained without publishing their contents.

The client tool wait changes from 180 to 1,800 seconds because actual native
operations on this board exceeded the earlier client limit. Host operation,
integrity, geometry and recovery bounds are unchanged. The supported per-server
setting is documented in [OpenAI's MCP reference](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Verification

- [Intended-command preflight](intended-command-preflight.json): **17 initial
  tools**, seven successful read-only calls, four-layer/channel schema, stock
  part inspection/search and approved RT6150 symbol/footprint inspection. No
  workspace project or native editor was created.
- [Installation receipt](installation.json): exact profile, skill and frozen
  host release identities; parsed entry readback matches the intended change;
  unrelated raw bytes and entry fields are preserved. The workspace has zero
  saved projects, so no existing project was repinned.
- [Fresh actual Codex client](installed-codex-client-v2.json): all 17 expected
  tools discovered through the real installed entry; normal exit code 0. No
  task, model turn or native project was created. Other servers/plugins were
  disabled only through that probe's command-line overrides.
- [Existing conversation observation](existing-desktop-observation.json): the
  vendor lookup still returns `found:false`. The updated profile is verified in
  the fresh client, but activation in the already-running chat connection is
  **not established**. Reconnect or use a fresh client before relying on the new
  capabilities there.

The [initial fresh-client probe](installed-codex-client.json) failed before MCP
startup because its override generator quoted key segments in a format the CLI
treated literally. The second probe used validated plain key segments and
passed. This was a probe-only error; it did not rewrite the installed entry or
create native state. The failed record remains preserved.

This qualifies configuration, discovery and part-source inspection. Native
authoring is separately demonstrated by the host41/DOC16 runs; neither this
client check nor the [routed review board](../../designs/rp2350-pico/four-layer-review-117/README.md)
establishes completed managed RP2350 finalization or manufacturing approval.

Profile: `d5014bcc72773d18e88e40b39bc5afb64e1ea4eecc99bc395c95191eeecf634d`,
16,672 bytes. Skill: `9f8734a64ff56711e5764b23997c0067e238f3c1c3debac65a91731fab465c50`,
39,593 bytes. [Evidence identities](evidence-identities.json).

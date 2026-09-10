# DOC6: qualified footprint identities during PCB sync

DOC6 is a recorded overlay on the preserved DOC5 runtime. The writer now places
the schematic's full `Library:Footprint` assignment in each new PCB footprint
root. The sync comparator compares that full identity, and the board reader uses
the existing paired S-expression decoder for quoted names.

The source patch changes only `kicad_mcp/tools/pcb.py`. It preserves DOC5's native
commit lifecycle, all existing addons, package metadata and upstream `RECORD`.
The shared renderer also supplies newly added footprints during explicit
auto-placement with `sync_missing=True`; those additions receive qualified IDs
as well. It does not migrate or repair existing board files. Bare historical
names remain readable and are reported as mismatches when appropriate; the
offline tests verify that existing routed fixtures remain unchanged when
replacement is disabled.

Only the `pcb_sync_from_schematic` descriptor receives this `_meta` entry:

```json
{
  "evledaQualifiedFootprintIdentitySync": "evleda.kicad-qualified-footprint-identity-sync.v1"
}
```

The owning host must check that marker before dispatch and check exact qualified
IDs in new sync output. The marker is captured from actual `FastMCP.list_tools()`
registration. The upstream CLI listing omits `_meta` and cannot establish it.

`test_qualified_footprint_identity.py` imports the actual selected PCB module and
runs 12 offline tests. They cover stock identities, quoted/backslash/Unicode/LF
encoding, full-ID comparison, distinct libraries sharing a leaf name, unchanged
child geometry/pads/UUIDs, invalid inputs, and registered metadata. Native board,
CLI, reload and mutation entry points are replaced with failing sentinels. The
existing shared string encoder's CR/CRLF-to-LF normalization is unchanged; raw
control characters are not valid literal Windows library file components.

Run the driver with the selected runtime interpreter and an absolute module path:

```powershell
& C:\EvlEDA-DOC6-20260910\environment\Scripts\python.exe -I -s -E -B `
  sidecars/patches/doc6/test_qualified_footprint_identity.py `
  C:\EvlEDA-DOC6-20260910\environment\Lib\site-packages\kicad_mcp\tools\pcb.py
```

The one-shot `scripts/build-doc6-qualified-footprint-runtime.mjs` pins the
reviewed DOC5 manifest, source patch and test driver; refuses existing outputs;
verifies DOC5; copies a separate `C:\EvlEDA-DOC6-20260910` runtime; and changes
only the writer and `environment/pyvenv.cfg` home. It uses the existing manifest
builder and verifier, then requires the complete file inventory to match DOC5
except for those two exact leaves. It creates no active profile or `dist` output.

Publication evidence is in `provenance.json` and the transfer's
`working-profiles/doc6-qualified-footprint-identity.json`. Installed DOC6 passed
all 12 tests and manifest reproduction: 8,467 files, 1,159 directories,
150,421,299 bytes. The same driver rejects DOC5, and applying the recorded patch
to an isolated DOC5 source copy reproduces the patched source exactly.

This is offline writer/runtime qualification. Native sync, qualified-ID
save/readback, and strict `--schematic-parity` proof remain with the owning host's
integration run. The runtime build did not start an MCP server loop, open KiCad,
invoke native APIs, or change an existing board.

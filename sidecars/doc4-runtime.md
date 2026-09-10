# DOC4: private unsaved plane stage and bounded receipt artifacts

DOC4 is a new immutable runtime copy of DOC3, not an in-place upgrade. Its fixed
package source is in `patches/doc4/evleda_plane_stage/`; the versioned launcher is
`kicad-inspection-launcher-doc4.py`, installed under the ordinary runtime launcher
name. Copy that package to runtime `evleda_plane_stage/` without adding sys.path
entries. The manifest independently pins every inherited and new byte.

The only DOC3→DOC4 runtime differences are five new package files, the launcher
package-install block, and pyvenv home relocation. Native stage03 logic has only
package-relative import changes. Stage03 itself differs from preserved stage02
only by reading the native proto3 omitted pad-number default with
`p.get('number','')`. Raw paste apertures remain present and number-omitted;
selected numbered reference-pad ownership stays exact. The original failing
candidate and failing-before/passing-after regression evidence are preserved.

`evleda_stage_plane` is a host-private WRITE/KICAD_IPC capability, absent readonly.
It uses trusted configured workspace/project/PCB/output paths and the existing
owned native client/PAD collector. It applies the fixed unsaved stage; neither the
adapter nor that stage saves or reverts. The host retains its operation queue,
source/contract checks and mandatory save/readback/recovery authority.

The exact input/output JSON schemas and annotations are generated from the host
`src/integrations/kicad-plane-stage.ts` exports into manifested `protocol.json`.
Full complete or complete:false stage receipts are written to an exclusive,
ordinary output file named `evleda-plane-stage-<uuid>.json`, bounded at8 MiB,
fsynced and read back exactly. MCP returns only one small JSON text plus identical
structuredContent artifact reference with filename/content identity. It does not
duplicate the full receipt into the ordinary MCP message budget.

The stage is synchronous and observed, with its own60-second deadline and host
90-second transport allowance. No cancellable native worker is detached. Proven
pre-stage initialization rejection is distinct from any fatal stage/publication
error after entry, which is uncertain and requires host recovery. Partial file
reservations are retained as diagnostics, not advertised as valid receipts.

Verification:28 fixed-stage tests,13 adapter tests, actual installed launcher and
FastMCP readonly/write metadata checks, and the actual host reader accepting a
3.27 MiB offline artifact through a tiny reference. Native logic/test-body AST
checks pass, with no ambient module/sys.path use. Original/DOC1/DOC2/DOC3 trees
remain unchanged. No tests/caches/bytecode are shipped inside DOC4.

This packaging made no native/GUI/model calls or package/profile-default changes.
The existing numbered CREATE/UPDATE unsaved qualification remains historical;
it is not a live qualification of the new artifact transport or final contract
acceptance. Minimum-spoke enforcement, complete plane semantics, source ownership,
save/reopen and final acceptance remain host gates. No HF/manufacturing claim.

Portable restore mapping and all source/runtime identities are in
`patches/doc4/provenance.json`. Detailed retained review history:
`D:\EvlEDA-doc4-plane-runtime-build-20260909` and new source revision
`D:\EvlEDA-plane-runtime-stage-20260909-03`; older stage02/proofs are untouched.

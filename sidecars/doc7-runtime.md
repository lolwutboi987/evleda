# DOC7 connectivity runtime

Runtime: `C:\EvlEDA-DOC7-20260910`.

Manifest: transfer `working-profiles/kicad-inspection-runtime-manifest-doc7.json`.

| Binding | SHA-256 |
| --- | --- |
| Manifest file, 1,574,798 bytes | `87de3535155cdfcf9650f19409ca4f203b8bba373ce8021ea646f982258b80f7` |
| Manifest identity | `94d05e96729f2fc62b8e74cdc5e6733cbaf3f24117ad6d645dcea3c97a2c4d30` |
| Runtime tree identity | `7654f6c1cafab4e9f2f30f33ecff2325bb8993e2023b059945f6a4c966a3df99` |
| Qualified graph Tool descriptor | `eddb2180b77bf4aa528bc9f007c5ab07cdd54dbc310d661e79c4a8fb368ad54d` |

DOC7 preserves DOC6's complete 8,467-file closure and qualified footprint writer.
It fixes `power:PWR_FLAG` graph membership and prevents flag Values from naming or
merging nets. Three reader modules and the relocated Python home are the only
changed runtime leaves. The prior DOC6 manifest/tree remain unchanged.

The native session's `supportsExternalPowerFlagConnectivity()` requires the exact
qualified graph descriptor, graph read authority, and an open, bound, healthy
session in either readonly or write mode. The harness uses this capability for
annotated graph reads and before external-power authoring. Unmarked old readers
remain usable for ordinary unannotated reads. Mutation permission checks remain
separate; the capability grants neither writes nor native transaction authority
and does not alter verification deadlines.

The [patch README](patches/doc7/README.md) describes the source contract and
qualification, and [provenance](patches/doc7/provenance.json) binds the actual
artifacts. Offline qualification passed 13 Python and 16 host capability tests.
Those historical results qualify that runtime patch, not later host changes.

## Current intentional-NC host status

The current host fix uses this existing frozen DOC7 producer. KiCad's generated
NC net name remains exact in native source; the public selection records `net: null`,
`disposition: "no_connect"`, and the bound `nativeNetName`. Intentional NC is not
routable. Complete typed native netlist parity and current source binding are
required; a generated-name prefix alone supplies no authority. Repeated physical
pads may share one NC logical terminal, but no NC tracks, vias, zones, other
logical terminal, or foreign-pad reachability are permitted.
Named-NC netclass and checkpoint support is qualified for V2 only; legacy V1
continues to reject generated NC names.

Transfer profile `working-profiles/toolbox-native-doc7-stock-catalog-destination-02.json`
is 16,267 bytes, SHA-256
`489b93bf39814c1459d19636d54959c55e58efd8f23418fedd1c7ceeb587d512`.
It retains this DOC7 runtime and binds the qualified current Windows plane-reader
helper manifest. No new producer runtime or DOC9 clone is required.

The initial NC host fix passed [387 focused tests](../../destination-verification/native-nc-compatibility-01/focused-20260916-implementation-final-01.json),
with a separate 180-test stock-pad run retained in tool output.
[Attempt 08](../../destination-ic-design-08/assessment.md) then passed native NC
import/selection and all six placements, but its first VIN route failed after
push. Normal close failed. Two authenticated live PCB captures preceded the stop
of verified owned processes; saved sources remain unchanged, and the lease,
unsafe marker and locks remain. History/autosave is a reproduced candidate for
the combined guard failure; the original changed operand remains unknown.

The later host phase fix reuses qualified NC binding through unsaved route/plane
stages under exact non-PCB source, marker, library and saved-preimage guards.
Fresh validation after save remains mandatory. Software checks passed: 17 new
regressions, [81 tests across the full affected files](../../destination-verification/native-nc-compatibility-01/staged-nc-full-files-01.json)
(overlapping runs, not additive), and [219 harness/text/public-contract tests](../../destination-verification/native-nc-compatibility-01/bounded-text-and-harness-01.json)
after [two encoding-corrupted truncation literals were restored](../../destination-verification/native-nc-compatibility-01/encoding-repair-01.json).
Full [source/UI typechecks](../../destination-verification/native-nc-compatibility-01/integrated-typecheck-02.log)
and the [integrated build](../../destination-verification/native-nc-compatibility-01/integrated-build-02.log) passed.

[Attempt 09](../../destination-ic-design-09/assessment.md) completed routing,
native NC isolation and independent strict parity, but public plane assessment
and checkpoint close failed the shared net-name reader. Its lease/unsafe evidence
and attempt 08's separate failure remain retained. The reader repair passed
[95 lifecycle tests](../../destination-verification/native-nc-compatibility-01/reader-nc-lifecycle-recheck-20260916-02.json),
[46 netclass tests](../../destination-verification/native-nc-compatibility-01/reader-nc-partial-inventory-20260916-03.json),
an [offline replay of actual attempt 09](../../destination-verification/native-nc-compatibility-01/native09-semantic-reader-offline-03.json),
and full [source/UI typechecks](../../destination-verification/native-nc-compatibility-01/integrated-typecheck-03.log)
and [build](../../destination-verification/native-nc-compatibility-01/integrated-build-03.log).

The [attempt 10 saved candidate](../../destination-ic-design-10/authored-source-01/manifest.json)
uses the same circuit/bundle and unchanged DOC7 profile02. External-power schematic,
NC-correct import (19 physical pads / 17 logical terminals), all six placements,
18 tracks, six vias and one B.Cu zone completed; all three functional nets connect.
Public strict DRC/parity reported zero findings, configured native clearance/short
and thermal-policy checks verified, and all 10 bores were inventoried. Generic
checks reported zero findings; 10 measured turns had no violations or unresolved
findings, and native top/assembly previews were readable.

The [edit-session public plane result](../../destination-ic-design-10/mcp-session-01/workspace-client-02115c17-6d65-4100-b250-c535293fe441/000133-response-ee3586ae6e2292ede84b00cc16afbf81fdd53394597ad1d7997a01dacadde2b9.json)
is **incomplete: 9 passed, 38 unknown, 0 failed; accepted=false**. Two GND connector
bore/cached-hole relationships, physical copper/thermal widths and contact
continuity, ignored ERC checks and other mandatory rows remain unresolved.
Normal project close and client exit 0 completed. The
[06:00:38 UTC post-close observation](../../destination-ic-design-10/post-close-observation.json)
records all six sources unchanged and no lease, unsafe marker, locks or native
processes.

Fresh read-only reopen passed: all three functional nets remained connected and
the top PNG repeated exactly. Normal project close, operator-idle terminal and
client exit 0 completed. The
[06:09:20 UTC read-only post-close observation](../../destination-ic-design-10/post-readonly-close-observation.json)
records all six sources unchanged and no markers or native processes. The
read-only plane report remains **incomplete: 47 unknown, accepted=false** because
that session has no current-fill witness; it is separate from the earlier
edit-session 9-pass/38-unknown result.

The [global installation receipt](../../destination-verification/doc7-client-installation-02/installation.json)
at 2026-09-17 06:10:17.663 UTC verifies DOC7 profile02 above and the exact repository
skill copy: 26,528 bytes, SHA-256
`4da48ceffd622100c5f01a1ec44345e69784f5634bf883a41b7b69abd9924b0a`.
Unrelated configuration was preserved, a private backup retained, and workspace
allocations remained zero. The [read-only preflight](../../destination-verification/doc7-client-installation-02/workspace-preflight.json)
passed four calls with 15 tools; a [fresh actual CLI discovery](../../destination-verification/doc7-client-installation-02/codex-client-catalog-v2.json)
also found 15 tools and exited 0. Activation of the new profile in the running
desktop remains unverified; earlier DOC6 desktop discovery is historical. See
[client installation scope](../docs/destination-client-installation.md).
The retained [attempt 07 assessment](../../destination-ic-design-07/assessment.md)
records DOC8's strict parity failure. Runtime integrity verification alone does
not qualify functional parity.

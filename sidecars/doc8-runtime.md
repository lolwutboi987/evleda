# DOC8 no-connect transfer runtime

**Historical runtime; not recommended for intentional-NC workflows.** DOC8 strips
KiCad's generated NC net names. Its import passed the historical host contract,
but [attempt 07](../../destination-ic-design-07/assessment.md) failed strict native
schematic parity on the resulting netless U1.5. The current host fix retains the
exact native NC name with the existing frozen [DOC7 producer](doc7-runtime.md).
Runtime integrity verification is not functional-parity qualification.

Runtime: `C:\EvlEDA-DOC8-20260916`.

Manifest: transfer `working-profiles/kicad-inspection-runtime-manifest-doc8.json`.

| Binding | SHA-256 |
| --- | --- |
| Manifest file, 1,574,798 bytes | `595f3bd082f7eb485da29fb25015a8375227b01cc66876e04559023d59ae66b5` |
| Manifest identity | `5c14e569a1eb0dfee478006d2621d00a3141ca6d0692e3e9d7f39f4b71599532` |
| Runtime tree identity | `6798cf89460922b6f82aa22cd55719c7a93ec580b438ff8cd124d725429b4b06` |
| Source `pcb.py`, 189,117 bytes | `8e5810bc7879b636c42c8d6e0d561875b3d16bd2222272a2ea58bd5f7aeefddf` |
| Patch, 2,387 bytes | `ddef949dfe12f2291451fa912fe3c1b9e11965185c5f507cd7172d67fef0330d` |
| Provenance, 11,420 bytes | `74ce175cad4efbbc9f6e6571ae6962c71f88bde861049c7215dda9eb963e1795` |
| Preserved qualified sync Tool descriptor | `4cd5981b622b80ff90341b67ebe08fea9c8e317d41530fe496583eed2d38a2b3` |
| Preserved qualified graph Tool descriptor | `eddb2180b77bf4aa528bc9f007c5ab07cdd54dbc310d661e79c4a8fb368ad54d` |

DOC8 preserves DOC7's complete 8,467-file and 1,159-directory closure. Its total
size is 150,425,255 bytes. The only changed leaves are the PCB tool's narrowly
scoped netlist normalization and the relocated Python home. DOC7's full tree and
manifest were verified before and after; original netlist and footprint inputs
also retain their exact hashes.

This producer keeps a stock NC pad netless when KiCad exports it as a
singleton `unconnected-(...)` net with an exact `no_connect` pin-type token,
including `passive+no_connect`. It preserves real nets and all footprint pad
primitives. The historical host required `null` for a contract NC pad and rejected
synthetic assignments. That representation proved incompatible with strict
native parity; the current host separates semantic NC from its exact bound
native net name. Existing DOC8 transaction behavior, deadlines, qualified
footprint IDs and DOC7 graph qualification are unchanged. This historical patch
adds no tool capability or descriptor marker.

The [patch README](patches/doc8/README.md) describes the supported representation
and limits. The [provenance](patches/doc8/provenance.json) binds the source,
reproduced patch, original native04 netlist, installed stock WSON footprint,
complete manifests, and qualification reports. All 41 offline tests passed:
16 parser-to-renderer regressions, 12 unchanged footprint-identity tests, and
13 unchanged power-flag graph tests. The same historical NC regression driver
fails against DOC7 because DOC7 retains the native `U1:5` assignment; that driver's
netless expectation does not establish strict native parity correctness.

This qualification did not launch an editor or server loop, perform native CAD
operations, modify a saved project, change profiles, or build application output.
It does not repair an already contaminated board. The later attempt 07 evidence
remains a failed strict assessment, despite successful import and generic checks.
The replacement DOC7 host behavior passed native NC import/selection and all
placements in [attempt 08](../../destination-ic-design-08/assessment.md), then failed
its first VIN route after push. Normal close failed; saved sources and retained
lease/unsafe/lock evidence remain preserved after verified owned processes were
stopped. The later guarded unsaved-phase host fix passed software checks and full
typecheck/build; [DOC7's status](doc7-runtime.md) records the evidence and limits.
[Attempt 09](../../destination-ic-design-09/assessment.md) completed routing, NC
isolation and independent strict parity, but its shared net-name reader blocked
public plane assessment and checkpoint close. Those failures remain retained.

After the V2 reader repair, attempt 10 under unchanged DOC7 profile02 completed
construction, public strict DRC/parity with zero findings, and normal close.
Its edit-session plane result remains **incomplete: 9 passed, 38 unknown, 0 failed;
accepted=false**. Physical widths/contact continuity, two connector bore/cached-hole
relationships, ignored ERC checks and other mandatory rows remain unresolved.
Fresh read-only reopen passed with all three functional nets connected and an
identical top PNG. Its separate plane report remains **incomplete: 47 unknown,
accepted=false**, with no current-fill witness. Normal close/client exit 0 and
[unchanged sources with no remaining markers or native processes](../../destination-ic-design-10/post-readonly-close-observation.json)
were recorded. Named-NC netclass/checkpoint support is V2 only; legacy V1 still
rejects generated NC names. [Global DOC7 profile02 and the exact updated skill](../docs/destination-client-installation.md)
are installed; read-only preflight and fresh actual CLI discovery passed with
15 tools, and the CLI exited 0. Activation in the running desktop remains
unverified; earlier DOC6 desktop discovery is historical. These milestones do
not qualify DOC8 or establish board/manufacturing acceptance.

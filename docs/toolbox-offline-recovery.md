# Offline recovery of the recorded PCB checkpoint failures

`scripts/recover-toolbox-project.ts` handles three bounded recovery families through
separate strict request and plan schemas: the zero-byte PCB after disk exhaustion,
the outlined pre-sync board rejected before native electrical synchronization,
and explicit abandonment of current PCB changes in favor of an authenticated
earlier closed checkpoint.
It is an operator-reviewed offline exception, not an MCP operation, general crash
repair, or automatic stale-lock reclamation. Other failure shapes are unsupported.
Normal workspace resume and ownership checks remain unchanged.

The zero-byte mode's evidence includes a successful prior close, unchanged checkpoint
and governed sources except for a zero-byte PCB, the failed session's successful
resume and save error, and an exact independent PCB backup matching the prior
checkpoint. The corrected process observation and exact owned-editor exit
receipt are retained with the original erroneous observation. Process absence
does not establish ownership of an arbitrary lease.

The outlined pre-sync mode additionally requires the successful outline/save,
exact sync rejection and canonical private diagnostic, failed close and workspace
state, shutdown observation, and the precise terminal marker bound to the unchanged
report. The saved board may differ from the older checkpoint only by the exact
contract outline. This mode intentionally rolls that outline back; it does not
misrepresent the outlined board as the older checkpoint. Both editor locks must
already be absent, and no other unsafe marker is admitted.

The PCB-only checkpoint rollback mode has its own request/plan schemas and an
explicit `discardAllCurrentPcbChanges: true` plan decision. Its authority comes
from the authenticated prior checkpoint, an exact independent backup, unchanged
non-PCB governed sources/report/bindings, current pinned failure state, confirmed
shutdown, and the operator's exact-plan approval. A primary diagnostic or an
error message claiming rollback does not establish native rollback completion.
Current PCB bytes and available failed output are archived before replacement;
only the exact typed terminal marker and lease may be retired. This mode has a
5 MiB cumulative write bound and a 150 MiB reserve plus calculated work space.

PCB rollback v1 requires editor locks to be absent. The separate v2 request and
plan admit an exact pair of retained locks only with pinned orphan-editor and
owned-termination evidence: matching process ID, executable, board arguments,
both creation-time observations, parent association, successful exit and unchanged
failed PCB. Fresh shutdown evidence must show no native editor or owned host.
Lock contents, physical identities and creation times are checked; neither a
hostname nor a dead process ID alone establishes ownership. The original locks
are archived before restoration. Only after the PCB is restored and verified may
the board lock, project lock, terminal marker and finally lease be retired.
Older schemas retain their original conditions.

Inspection writes only a plan to stdout:

```powershell
$env:TSX_DISABLE_CACHE='1'
node --import tsx scripts/recover-toolbox-project.ts --request REQUEST.json --request-sha256 SHA256 --request-bytes BYTES
```

The request schema in the script lists the required pinned evidence and exact
lease/lock files. Review the emitted plan before applying it. The operator must
exclude competing CAD, workspace and recovery activity for the operation:

```powershell
node --import tsx scripts/recover-toolbox-project.ts --apply --plan PLAN.json --plan-sha256 SHA256 --plan-bytes BYTES --maintenance-confirmed
```

Apply rechecks the plan against current files, directory identities and process
state. It rejects native editors, target or ambiguous hosts, changed evidence,
unsupported markers, links, insufficient disk space and a prior attempt's
archive. Explicitly scoped hosts for a proven disjoint workspace need not be
stopped. Disk headroom includes the bounded archive/restore work and a 100 MiB
reserve; this cannot prevent another application from consuming the disk.

Original sources, damaged records and retained locks are copied into an
exclusive recovery archive and verified before replacement. Only the exact
checkpoint PCB is restored. Checkpoints, history, rules and the schematic are
not rewritten. Only the orphan artifacts explicitly covered by the selected
mode are retired: the pinned editor locks in the zero-byte case, or the pinned
terminal marker in the two checkpoint-rollback cases. The workspace lease is released
last. Durable receipts distinguish an intended release from an observed release.

On any interruption, preserve the partial archive and remaining orphan artifacts for
review. Do not blindly retry, delete the archive, recreate locks, or change the
checkpoint. A successful offline restore still requires the normal toolbox
resume and fresh native verification; it does not establish a completed design.

The implementation received 101 focused tests, TypeScript checking and an
independent source review. All five actual V9 recoveries restored the PCB's exact
2,614 checkpoint bytes; separate readbacks confirmed all eight prior normal-close
hashes and preservation of the other captured files. Evidence is retained under
`destination-verification/rp2350-native-disk-full-01/` and
`destination-verification/rp2350-native-sync-failure-01/` and
`destination-verification/rp2350-native-sync-failure-02/` and
`destination-verification/rp2350-native-sync-failure-03/` and
`destination-verification/rp2350-native-sync-failure-04/` outside the repository.

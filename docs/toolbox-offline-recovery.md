# Offline recovery of the recorded zero-byte PCB failure

`scripts/recover-toolbox-project.ts` handles the recorded disk-full outline
incident. It is an operator-reviewed offline exception, not an MCP operation,
general crash repair, or automatic stale-lock reclamation. Other failure shapes
are unsupported. Normal workspace resume and ownership checks remain unchanged.

The supported evidence includes a successful prior close, unchanged checkpoint
and governed sources except for a zero-byte PCB, the failed session's successful
resume and save error, and an exact independent PCB backup matching the prior
checkpoint. The corrected process observation and exact owned-editor exit
receipt are retained with the original erroneous observation. Process absence
does not establish ownership of an arbitrary lease.

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
not rewritten. After further verification, the reviewed editor locks are
released and the workspace lease is released last. Durable receipts distinguish
an intended release from an observed completed release.

On any interruption, preserve the partial archive and remaining locks for
review. Do not blindly retry, delete the archive, recreate locks, or change the
checkpoint. A successful offline restore still requires the normal toolbox
resume and fresh native verification; it does not establish a completed design.

The implementation received 30 focused tests, TypeScript checking and an
independent source review. The actual V9 recovery restored the PCB's exact
2,614 bytes; a separate readback confirmed all eight prior normal-close hashes
and preservation of the other captured files. Its retained evidence is under
`destination-verification/rp2350-native-disk-full-01/` outside the repository.

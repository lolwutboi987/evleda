# Saved-board recovery into a separate candidate

The operator workflow in `scripts/recover-saved-plane-candidate.ts` creates a
separate candidate from the **last verified native save**. It never edits the
failed project's checkpoint, lease, unsafe marker or native sources. The failed
unsaved plane state remains evidence and is not imported as saved work.

This is a narrow recovery case. It requires pinned evidence of a successful
native plane save matching the current PCB, a subsequent complete unsaved plane
stage above the former 500,000-byte limit and within 1 MiB, the corresponding
readback-size failure, the failed close, and the protocol terminal. The source's
stale checkpoint and quarantine must still exist. Native processes must be
quiescent before inspection and application; all captured source and evidence
files are checked again during the operation.

The target is a complete ready draft with the same name. Its only permitted
engineering change is the separately supported per-net via-budget reallocation.
Electrical, placement, interface, dimensional and global-budget requirements
stay exact. Native source planning preserves schematic bytes, routing and
functional footprints while rebinding owned namespaces for the new bundle.

Inspection requires an exact request path, SHA-256 and byte count, plus an
existing external evidence directory. It prints a plan identity and starts no
CAD process. Application requires that same plan identity with
`--maintenance-confirmed`. The request selects a new, unused target ID; a failed
or existing target must be inspected rather than automatically recreated.

The target must complete its own native open/save/readback and normal
checkpoint/close. Source comparison runs again before custody is published.
Its `evleda.plane-saved-recovery-lineage.v1` record explicitly states that the
original checkpoint was stale, its normal close was not confirmed, and its
quarantine was retained. This is distinct from ordinary placement or via-budget
revision lineage. No plane-fill freshness, electrical acceptance or
manufacturing authorization transfers with the copied source.

The readback-size case was exercised on the RP2350 board: the saved routing was
copied into a new allocation and completed native open/save/readback and normal
checkpoint/close. That result does not qualify other failure cases.

A second, separately typed `evleda.saved-field-recovery-request.v1` case handles
a field-bounds rejection after a verified footprint-pose save. It requires that
exact save to match the current PCB, the original field request to reproduce
the bounds rejection, a retained live snapshot equal to the saved source, a
failed close retaining the lease, and a terminal protocol record. All native
processes must be gone. This case uses the **same authenticated engineering
bundle**; it cannot change routing budgets or other requirements. Source
quarantine and the stale checkpoint remain untouched. This second case also
completed native open/save/readback and normal checkpoint/close on the RP2350
saved board; see `proofs/native-saved-board-recovery-20260920/README.md`.

For new sessions, the toolbox distinguishes errors from its pure field/pose
planner using an internal, one-use error-object receipt bound to the exact
host and call. It returns `rejectedBeforeMutation: true` without quarantining
the session. A matching message, error properties, unchanged source hash,
another call, or a native staging/save error cannot supply that receipt.
Existing quarantined sessions are not cleared by this change.

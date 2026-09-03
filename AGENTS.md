# EvlEDA agent contract

## Product boundary

EvlEDA currently exposes one immutable, verified reference design: the
`reference-usb-c-3v3-r2` USB-C 5 V sink to 3.3 V / 100 mA output-only board.  It
does **not** currently generate arbitrary PCBs.  Never imply otherwise, never
silently reinterpret the fixed circuit, and never claim that an output is ready
for fabrication or manufacturing release.

The checked-in generated KiCad library names and legacy digest domains may
contain `FluxGenerated`, `.flux-compile.json`, or `flux-clone-*`.  They are
frozen compatibility/evidence identifiers, not public product branding.  Do
not rename them or recompute their identities casually.

## Codex cloud reference workflow

Use `docs/CLOUD_RUNBOOK.md` and the commands in `scripts/cloud/`.  Cloud work is
strictly a two-turn approval protocol:

1. In the requirements/preview turn, confirm that the user wants the exact
   fixed reference design, understands that 3V3 is output-only, and accepts
   non-release engineering-review artifacts.  If any point is unclear or the
   request asks for a different circuit, ask questions and do not execute.
2. When the fixed scope is clear, run `bash scripts/cloud/plan.sh`.  Report the
   immutable source identities, planned native gates, limitations, exact
   `subject_sha256`, and exact approval phrase.  Then stop.  Do not invoke
   `run.sh` in that same turn, even if the opening prompt included generic
   permission to proceed.
3. A later user message must contain the exact phrase printed by `plan.sh`:
   `APPROVE EVLEDA REFERENCE PLAN <subject_sha256>`.  Mere assent such as
   "looks good" is not digest-bound approval.
4. Re-run `plan.sh` immediately before execution.  If its digest differs, the
   earlier approval is stale: show the new preview and stop for approval again.
5. Only after an exact later-turn approval, run
   `bash scripts/cloud/run.sh <subject_sha256> <new-output-directory>`.

Never hand-edit a plan digest, bypass the runner, reuse a partial output
directory, fetch private evidence, or pass secrets to KiCad.  The runner must
finish ERC, unfilled/no-save DRC, refill/no-save DRC, codec parity/replay,
headless render, and non-release CAM packaging.  Treat a missing
`RUN_COMPLETE.json`, any nonzero command, any finding, any changed source byte,
or any receipt mismatch as failure.

## Verification and reporting

Set up a clean Linux cloud checkout with `bash scripts/cloud/setup.sh`; the
script installs the official KiCad 10 PPA build only when needed and requires
exact `kicad-cli 10.0.6`.  Do not fetch the private source-evidence cache: the
public packaged reference runtime and public release source package are the
only allowed inputs for this workflow.

In the completion response, link the new output directory, `run-receipt.json`,
both SVG renders, and the CAM candidate ZIP.  State explicitly that
`manufacturing_release_eligible=false`, physical qualification was not
performed, and the CAM ZIP is **not for fabrication**.

For ordinary repository changes, run the narrow tests relevant to the edited
area.  Never weaken a deterministic gate merely to make a test pass.

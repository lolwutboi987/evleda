# Running the EvlEDA reference workflow in Codex cloud

This profile lets a Codex cloud task inspect, materialize, and verify the
public EvlEDA reference board in a clean Linux checkout.  It is intentionally
narrow: the current public release can reproduce the exact
`reference-usb-c-3v3-r2` design, but it cannot synthesize an arbitrary circuit
or route a new board from prose.

The workflow is headless and fail-closed.  Passing it produces a source project,
native verification reports, two SVG renders, and a content-addressed CAM
**candidate** containing `NOT_FOR_FABRICATION.txt`.  It never produces
manufacturing authority.

## Cloud environment

Configure the repository's Codex cloud setup command as:

```sh
bash scripts/cloud/setup.sh
```

In the cloud environment's package-version settings, select Python 3.12.  The
script also accepts 3.13 or 3.14 when deliberately configured, but it rejects
an older default interpreter instead of silently changing the runtime.

The script:

- requires Linux and Python 3.12–3.14;
- installs KiCad from the official `ppa:kicad/kicad-10.0-releases` PPA on
  Ubuntu when `/usr/bin/kicad-cli` is absent;
- selects an exact 10.0.6 package candidate and verifies
  `/usr/bin/kicad-cli version` is exactly `10.0.6`;
- installs this checkout into a repository-scoped `.venv`;
- runs the MCP transport smoke test and the deterministic cloud-plan smoke
  test; and
- downloads no private reference evidence and needs no secret.

Set `EVLEDA_CLOUD_INSTALL_KICAD=0` only when the base image already provides
the exact KiCad version at `/usr/bin/kicad-cli`. The cloud runner always passes
that reviewed path explicitly and never selects a `PATH` or environment
candidate.

An optional maintenance command for resumed cached containers is:

```sh
bash scripts/cloud/maintenance.sh
```

It performs an offline editable-install refresh and re-runs both smoke tests.
This arrangement matters because Codex cloud runs setup in a separate Bash
session, and setup-time shell exports do not persist into the agent phase.
Codex cloud checks out the selected repository revision, runs setup, then uses
`AGENTS.md` for project commands; setup has internet access while agent-phase
internet is off by default.  See the official [Codex cloud environment
documentation](https://learn.chatgpt.com/docs/environments/cloud-environment).

KiCad's official Ubuntu instructions publish the 10.0 stable PPA used here.
See [Install KiCad on Ubuntu](https://www.kicad.org/download/details/ubuntu/).

## Required two-turn interaction

### Turn 1: requirements and immutable preview

The agent must first establish all three facts with the user:

1. The requested circuit is the exact fixed USB-C 5 V sink to 3.3 V / 100 mA
   reference profile, with no component, placement, routing, or rule changes.
2. The 3V3 connector is output-only; external power must never be applied to
   it.
3. The result is for engineering review only and will remain explicitly not
   fabrication-ready.

If the request differs, the agent must explain the current capability boundary
and stop.  It must not force a different design into the reference profile.

Once the scope is clear, run:

```sh
bash scripts/cloud/plan.sh
```

The command validates the public release archive, compiler file inventory,
packaged runtime (when present), and two deterministic semantic round trips.
It prints canonical JSON containing the exact source hashes, fixed checks,
limitations, `subject_sha256`, and an approval phrase.  It writes no PCB or CAM
output.

The agent must show the preview and then end the turn.  It may not execute on
the strength of approval contained in the original request.

### Turn 2: exact digest approval and execution

The user must send the phrase emitted by the plan, exactly:

```text
APPROVE EVLEDA REFERENCE PLAN <64-lowercase-hex-subject_sha256>
```

The agent re-runs `plan.sh`.  If the digest changed—for example because the
checked-out release assets changed—the prior approval is invalid and another
approval turn is required.

For a matching later-turn approval, select a new output directory and run:

```sh
bash scripts/cloud/run.sh \
  <64-lowercase-hex-subject_sha256> \
  outputs/cloud-reference-<short-digest>
```

The runner permits only a new direct child of this repository's ignored
`outputs/` directory and refuses every existing destination.  It recomputes
the complete approval subject before creating output; a missing, malformed,
stale, or mismatched digest fails before any materialization.

## Deterministic execution gates

After approval, the runner performs these gates in order:

1. Initialize the real inspect-only EvlEDA MCP host, require that its sole
   tool is `inspect_project`, and bind the returned immutable snapshot without
   creating host state.
2. Cross-check the packaged runtime bytes against the compiler-bound public
   source archive and materialize the exact managed KiCad project.
3. Parse, export, and reparse the project twice with the strict project codec;
   require project, schematic, board, diagnostics, and auxiliary-file parity,
   plus identical replay evidence.
4. Hash and version-pin the explicit `/usr/bin/kicad-cli` executable.
5. Run ERC on a disposable copy; require valid KiCad 10.0.6 JSON, exit/report
   agreement, zero findings, and unchanged managed source bytes.
6. Run DRC without zone refill or save on a separate copy with the same gates.
7. Run DRC with zone refill but **without** save on a third copy with the same
   gates.
8. Render one schematic SVG and one top-layer PCB SVG headlessly, validate both
   as bounded SVG documents, and prove source bytes remained unchanged.
9. Generate the policy-validated non-release CAM candidate on another
   disposable copy, validate its closed inventory and formats, and materialize
   its run-specific, content-addressed ZIP and warning.
10. Write `run-receipt.json` and then `RUN_COMPLETE.json` last.

No partial directory is complete.  `RUN_COMPLETE.json` is necessary but not a
fabrication sign-off; its contents still fix
`manufacturing_release_eligible=false`.

## Output layout

The chosen directory contains:

```text
NOT_FOR_FABRICATION.txt
RUN_COMPLETE.json
run-receipt.json
source/                  exact immutable KiCad project
renders/                 validated schematic and PCB SVGs
cam-candidate/           non-release CAM files, receipts, warning, and ZIP
operations/              disposable verification evidence and isolated state
```

The final task response should report the receipt and ZIP hashes and link the
output directory and review renders.  It must also repeat:

- `manufacturing_release_eligible=false`;
- the CAM package is not for fabrication;
- no physical electrical, thermal, assembly, first-article, or fabricator DFM
  qualification occurred; and
- EvlEDA's public workflow currently reproduces only this reference design.

## Suggested cloud task prompt

```text
Use the repository AGENTS.md and docs/CLOUD_RUNBOOK.md. I want the exact
EvlEDA reference-usb-c-3v3-r2 board. Treat 3V3 as output-only and produce
non-release engineering-review artifacts only. In this turn, run only the
deterministic plan, show me its exact digest and approval phrase, and stop.
Do not materialize, invoke native KiCad checks, render, or generate CAM until I
send the exact digest-bound approval phrase in a later turn.
```

## Limitations of the cloud profile

- It is not a general EDA agent and cannot yet design a different PCB.
- It has no KiCad desktop GUI, interactive 3D inspection, connected lab
  instruments, prototype, component lot, or contract-manufacturer context.
- Native ERC/DRC and deterministic codec checks find important classes of
  error but cannot prove real-world electrical, thermal, EMC, mechanical, or
  manufacturing suitability.
- Ubuntu PPA package builds are pinned by semantic version here and the exact
  installed executable is hashed into each run receipt; the executable hash can
  differ across supported Ubuntu builds.
- Cloud container caches can be reused for a limited period, so every run still
  revalidates project bytes, plan identity, KiCad version, and executable hash.

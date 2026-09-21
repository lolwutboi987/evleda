# Current-source component and net-class checks

**Host62 is installed and verified on the actual RP2350 board.** The existing
plane assessment now resolves 270 original artifact requirements using current
library, schematic, PCB, net-class and native clearance evidence. The board's
six source files are unchanged.

## Actual results

| Requirement | Verified rows |
| --- | ---: |
| Approved symbol/footprint sources and physical library inventory | 62 |
| Saved/native electrical footprints and physical terminals | 62 |
| Saved schematic components, embedded definitions and native pin dispositions | 62 |
| Exact native schematic net endpoint sets | 67 |
| Complete declared source/driver/passive/flag paths | 4 |
| Exclusive net-class assignments, width preferences and configured clearances | 9 |
| Board-only mounting features, including qualified native hole/clearance checks | 4 |

The [read-only run](read-only-report.json) reports **330 pass, 244 unknown,
0 fail**. Independent artifact and placement facts remain verified without
fresh plane fill. The four mounting-feature rows correctly remain unknown
until their native clearance dependency is satisfied.

The separate [fresh-refill run](fresh-fill-report.json) reports **495 pass,
79 unknown, 0 fail; accepted=false**. It retains all 62 placement checks,
all 19 geometric reference checks and nominal copper paths from all 64 GND
pads. Native DRC is clean, all 67 functional nets connect, and all four
mounting-feature rows now pass. Both sessions close normally, with all six
source files byte-identical before and after. No layout or rule is changed.

## Scope and provenance

Every group binds the complete six-file source inventory, native scope, approved
library selection and original V2 verification plan. It rejects copied claims,
stale schematic/table evidence, missing rows and inconsistent current sources.
The embedded-symbol comparison uses exact selected pins and graphics; it does
not fabricate native live-pin positions or claim rendered readability. Actual
native netlist and physical-pad collection remain separate prerequisites.

Net-class evidence rechecks current canonical rules and the pinned native
semantic model. Board-feature source checks retain their separate native
clearance requirement. The public projection distinguishes source status from
the complete row result and excludes arbitrary private metadata. See the
[scope guide](../../docs/toolbox-artifact-checks.md) and [delivery record](delivery.json).

[590 tests in 13 files](verification.json), full source/UI typechecks and frozen
backend compilation pass. Tests cover source/identity drift, missing authority,
native-port lifecycle, explicit PCB-value failure, original row inventory and
public projection. The saved RP2350 schematic additionally matches all 62
approved symbol-definition/source identities. No full-suite claim is made.
A fresh actual Codex client sees 19 initial tools. Host62 and the updated PCB
skill are installed with the unchanged DOC17/v4 profile; D: must remain mounted.
Already-connected desktop activation is not established.

The [remaining requirements](remaining-requirements.json) include trace-topology
integration and material electrical/physical checks. Artifact passes do not
establish component suitability, USB startup, current/thermal performance,
signal integrity, readable rendering or manufacturing readiness. The
[RP2350 R2 candidate](../../designs/rp2350-pico/native-r2-spacing/README.md)
remains an engineering review candidate; no firmware, physical qualification
or manufacturing release is claimed.

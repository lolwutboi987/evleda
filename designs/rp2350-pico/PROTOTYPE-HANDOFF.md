# RP2350 prototype handoff

**R3 is the selected prototype deliverable.** On 21 September 2026, the owner
chose to hand off the routed prototype and leave USB inrush for hardware
validation. No further USB circuit revision is included in this handoff.

[Download the complete KiCad ZIP](downloads/RP2350-R3-KiCad-review-candidate.zip)
(3,165,775 bytes), or open the [native project](native-r3-trace/native/rp2350-pico-4layer.kicad_pro).
Extract the complete archive first. Use KiCad 10.0.3 with its stock libraries;
the custom library and portable tables are included. Read `START-HERE.txt`.

ZIP SHA-256: `5653fbd039e0bdc4903d5d9ab7c582351d86e205916aadce70eb3d11076cd402`.
The archive contains 63 source/package files plus its start note; every archived
file was read back and checked against its source bytes.

## What is delivered

- 22 × 60 mm, four layers; 2.54 mm GPIO pitch and 17.78 mm row spacing.
- 62 electrical components, four mounting bores, 1,089 tracks and 118 vias.
- Schematic, native board/project/rules, custom libraries, top/assembly/schematic
  previews, [pinout](native-r3-trace/pinout.md) and [candidate BOM](native-r3-trace/bom-candidates.csv).
- All 67 functional nets connected; configured local ERC/DRC and portable
  schematic parity clean. Checker exclusions remain in the package.
- All 62 placement checks pass. The source audit records 876 straight/45° turns
  without violations and retains six pad/via junction notices. GPIO service
  strips stay clear of unrelated copper, retaining 42 own-pad inward leads.
- Native save, normal close and fresh read-only reopening verified, with the
  final six source files unchanged and a byte-identical top preview.

R3 removes a redundant inner-layer 3V3 loop. It preserves the other tracks,
all vias and all component placements. The physical silkscreen still reads R1;
R3 is the delivery label. Earlier packages and failure evidence remain preserved.

## USB inrush and remaining engineering limits

**USB hot-plug/inrush has not been validated.** C20 is a 47 µF capacitor behind
the USB diode; the regulator's soft start does not limit its direct charging.
Do not treat clean ERC/DRC, a USB descriptor or the board's current budget as
proof of acceptable attach current. The retained [startup review](usb-startup-screen-20260920/README.md)
and [operating constraints](native-r3-trace/basis/operating-constraints.md)
describe the issue and the supported power modes. No proposed switch, capacitor
substitution or sense-divider change has been adopted.

The [full native assessment](../../proofs/trace-topology-20260921/fresh-fill-report.json)
remains 559 pass, 15 unknown, 0 fail, **accepted=false**. The two crystal-net pad
shapes exceed the new topology checker's coverage. Physical copper widths,
current/voltage/thermal behavior and interface performance also retain their
documented limits. Prototype handoff does not change these results or authorize
manufacture. Firmware, ordering and physical qualification were outside this task.

## Toolbox handoff

Host63, the matching PCB skill and the DOC17/v4 profile are installed on this
computer. D: must stay mounted. A fresh actual Codex client discovered 19 initial
tools; an already-connected client's reload is not established. See
[client setup](../../docs/toolbox-client-setup.md) and [the toolbox guide](../../docs/toolbox.md).

The toolbox supports chat drafts, approved component discovery, native project
creation/resume, authoring, routing, plane work and bounded engineering checks.
Placement/routing revisions are supported; general circuit changes on an
already-authored managed board are not an in-place operation. A one-day turnaround
has not been benchmarked or demonstrated by this long development run.

GitHub's portable typechecks/backend compilation pass for the source revision.
The separate native-dependent job fails because its runner lacks the pinned
KiCad runtime and manifest. Local native verification is retained independently;
remote CI is not described as all green.

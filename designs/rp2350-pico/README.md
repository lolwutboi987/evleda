# RP2350 Pico-like board

This is the first real board task after publication of the reviewed EvlEDA toolbox
baseline. Work is on `codex/rp2350-pico`; the published baseline is commit
[`8fa1203`](https://github.com/lolwutboi987/evleda/commit/8fa120343111107763433c7204bdbdbc240fc609)
on `codex/destination-resume`. The existing Python implementation on `main` was
preserved. This directory contains the saved native candidate and its retained
design history. Managed-workflow verification is complete; engineering acceptance
remains incomplete.

## Current candidate

**R3 is the selected prototype handoff.** [Download and handoff notes](PROTOTYPE-HANDOFF.md)
record the owner's decision to defer USB inrush to hardware validation. The native
files and engineering results remain unchanged; electrical acceptance is not implied.

The [R3 candidate](native-r3-trace/README.md) removes a redundant 3V3 trace loop
without moving parts or vias. All 67 functional nets connect, all 62 placement
checks pass, and 64 of 66 declared trace topologies pass; two crystal-pad shapes
remain unsupported. Configured ERC/DRC and portable parity are clean. The complete
assessment has 559 pass, 15 unknown, 0 fail; accepted=false. USB startup and
other material electrical requirements remain open. Native save, normal close
and fresh read-only reopening are verified.

The [R2 package](native-r2-spacing/README.md) remains the historical spacing revision.
The same managed project now holds R3; use its current sources for continuation.

## Preserved launch-aware candidate

The [launch-aware R1 candidate](native-r1-launches/README.md) preserves the physical
layout and native rules while explicitly separating the two through-hole debug
approaches from the continuous-reference body. Both local launch rows are now
native-verified at unchanged body margins. Native save/close and fresh read-only
reopen are complete; all 67 nets connect and configured checks are clean.
The full assessment remains incomplete: 163 pass, 411 unknown, 0 fail; accepted=false.
[Host58](../../proofs/plane-terminal-copper-20260921/README.md) also verifies nominal drilled-copper paths from all 64 physical GND pads to the primary plane. [Host59](../../proofs/reference-terminal-geometry-20260921/README.md) completes all 19 declared geometric reference rows at unchanged margins. USB startup and broader electrical review remain open.

## Preserved regional-policy candidate

The [regional-policy R1 candidate](native-r1-regional/README.md) preserves the
completed placement, routing and previews while explicitly treating In2 as
supplemental fill. All ten regions have verified via contacts and retained-area
bounds to the unchanged primary plane. Its native save/close/read-only-reopen
workflow is complete: 67 connected nets and configured ERC/DRC clean. The full
assessment has 141 pass, 431 unknown and zero failed rows; accepted=false.
USB startup, debug-header launches and other electrical review remain open.
See the [toolbox qualification](../../proofs/native-plane-policy-revision-20260920/README.md).

## Preserved original R1 and design history

The [native R1 candidate](native-r1/README.md) is
**22 × 60 mm**, retaining 2.54 mm GPIO pitch and 17.78 mm row spacing. Its native
physical-pad review connects all 67 functional nets, and configured ERC/DRC have
zero findings. It includes 1,099 tracks, 118 vias, functional labels, portable
custom libraries, previews, a pinout and a candidate BOM. All 887 measured turns
meet the straight/45-degree policy; both GPIO service strips are clear.

The public-tool project saved both fills, closed normally, reopened read-only
with the same six sources and passed repeated connectivity/native checks before
another normal close. The [latest host44 reassessment](../../proofs/native-pad-policy-20260920/README.md)
has 141 pass, 430 unknown and one failed row on the same PCB; the original report
is preserved. Main In1 local thermal policy and intended connectivity are verified.
Header reference launches, supplemental In2 plane policy and electrical/construction
qualification remain unresolved. The earlier unmanaged
[review117 target](four-layer-review-117/README.md) is preserved separately.

The subsequent [host46 region-contact observation](../../proofs/native-plane-regions-20260920/README.md)
verifies a bore-clear via contact from every supplemental In2 region to the
primary plane. It preserves the original single-component failure and all
native source bytes; it is evidence for reviewing a separate policy revision.

The earlier two-layer [ground bridge 60-13](native-ground-bridge-60-13/README.md),
[ground and USB revision 60-12](native-ground-usb-60-12/README.md),
[ground-connections snapshot 60-11](native-ground-links-60-11/README.md),
[ground-plane snapshot 60-10](native-ground-plane-60-10/README.md),
[route-plan snapshot 60-09](native-route-plan-60-09/README.md),
[signal snapshot 60-08](native-signal-routing-60-08/README.md),
[GPIO snapshot 60-07](native-gpio-routing-60-07/README.md),
[power snapshot 60-06](native-power-routing-60-06/README.md) and
[ground snapshot 60-05](native-ground-routing-60-05/README.md) are preserved.

The earlier [placement 60-03](native-placement-60-03/README.md) has a
[placement-intent map](placement-intent-60-03.md) and
[native validation results](native-validation-60-03/README.md).
It contains 66 footprints but no routed copper: ERC has zero findings and DRC
reports 192 unconnected errors. It is not a finished board.

Routing reserves the GPIO service strips on every copper layer for each header
pad's own inward connection; unrelated traces, vias and plane copper stay out.
The current review verifies that geometry and configured native clearances;
complete electrical/return-path acceptance remains distinct. An earlier attempt saved
32 ground vias, then rolled back the next batch after a native snapshot exceeded
its message limit. The [snapshot fix and verification scope](../../docs/rp2350-native-pad-envelope-fix.md)
now include successful native execution of that batch in 60-05. The earlier
failed allocation remains preserved and is not a delivery checkpoint.

## Working brief

Develop an original RP2350A board with the familiar 21 x 51 mm Pico header
arrangement. Use Raspberry Pi's current RP2350 hardware guidance for the MCU,
power domains, internal buck regulator, flash, clock and USB circuit. Use
Orpheus Pico as a reference for useful USB-C, BOOT/reset and debugging features;
its RP2040 circuit is not an RP2350 design.

The initial direction is a non-wireless board with external QSPI flash, USB 2.0
full-speed device connectivity, BOOT and RUN buttons, SWD access and a GPIO25
status LED. Preserve Pico header functions where practical; every departure,
especially power and ADC pins, must be explicit. Exact supply operating range,
flash and regulator ordering codes are still being selected from primary sources.
Do not inherit Orpheus's unconnected 3V3_EN/ADC_VREF positions or incomplete
regulator ordering code without an explicit design decision.

Raspberry Pi's current Minimal reference demonstrates a two-layer, top-component
implementation, so two layers are a credible starting point. Board thickness,
material and USB geometry remain engineering decisions. The current guide's
1 mm USB example and downloaded Minimal CAD's 1.6 mm stackup disagree; neither
combination is automatically a verified 90-ohm channel. Do not invent material
properties or qualify a complete interface from one uniform calculated section.

## Selected-library inspection

The installed public toolbox has inspected these candidate stock definitions:

- `MCU_RaspberryPi:RP2350A`: one unit, 61 logical pins including exposed GND.
- `Package_DFN_QFN:QFN-60-1EP_7x7mm_P0.4mm_EP3.4x3.4mm`: 61 numbered copper
  features and nine paste apertures; exposed-pad properties retained.
- `Connector:USB_C_Receptacle_USB2.0_16P` with
  `Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal`:
  distinct A/B data contacts, four physical shield stakes and two non-plated
  locating holes. These are inspected candidates, not approved board components.

Raw source-bound inspection responses are retained outside the repository under
`rp2350-reference-inputs-01/catalog-inspection/`. Manufacturer pin and land-pattern
comparison is required in addition to library inspection.

## Work needed before native authoring

The existing numerical limits already cover this scale: 64 components, 128 nets
and 128 pins per component. The concrete capability work is geometric and
electrical: retain USB-C non-plated locating holes and oval shield pads in the
complete native inventory, then represent the USB channel's series resistors,
duplicated connector contacts and any protection taps without dropping terminals
or inventing package-internal copper. Any launch neckdowns must be explicit and
checked against the same saved geometry as the main pair.

Finish the source-backed component and pin map, circuit/placement constraints,
power budget and stackup decision before creating the bound native project.
The native result must be authored through the reusable toolbox and inspected
with source-bound ERC/DRC, connectivity and previews. Unknown engineering facts
remain unknown. Firmware, board ordering and physical qualification are outside
this task's immediate scope.

## References

- [Raspberry Pi requirements](../../docs/research/rp2350-pico/raspberry-pi-reference.md)
- [Orpheus source review](../../docs/research/rp2350-pico/orpheus-reference.md)
- [RP2350 hardware documentation](https://www.raspberrypi.com/documentation/microcontrollers/rp2350.html)
- [GCT USB4105 drawing](https://gct.co/files/drawings/usb4105.pdf)
- [ST USBLC6-2 protection-device datasheet](https://www.st.com/resource/en/datasheet/usblc6-2.pdf)

Reference choices are being evaluated; listing a protection device does not yet
select its exact placement, connection topology or performance for this board.

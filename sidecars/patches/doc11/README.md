# DOC11 footprint template rotation correction

This is a source overlay and bounded qualification evidence. No DOC11 runtime
has been copied, installed, published or activated by this work.

DOC10's inherited DOC6 PCB writer inserts a rotated footprint root into an
otherwise unrotated stock template. KiCad pad, property and user-text angles
are absolute, while their XY coordinates are footprint-local. The retained
session23 sync therefore contained all 66 footprints and all 281 physical pad
members but had wrong relative pad angles for C10, R17, R18, Q1, L2, J2 and J3.
The strict physical library comparator correctly rejected that board. It and
all source/native rollback and observation guards remain unchanged.

The sole production hook is in `_render_board_footprint_block`, after literal
reference/value/net assignment and before new root placement/UUID insertion.
The helper reads an unplaced front-side library template and splices only the
absolute angle tokens of existing pads, properties and `fp_text user` forms.
It adds root rotation to each original local angle modulo 360. Native zero pad
angles omit the token; text angles remain explicit. All local XY, physical pad
dimensions, drills, layers, paste properties, UUIDs, models, graphics, and other
bytes remain unchanged. Existing board instances are refused by the helper.
Matching existing footprints never reach this renderer during resync; the
mixed-existing/new test also proves the existing block remains byte-identical.
Explicit mismatched-footprint replacement still renders the replacement from
its stock template at the pre-existing footprint's pose, as before.

Admission is deliberately narrow: cardinal root/local angles, F.Cu templates,
bounded ASCII decimal coordinates with exact integer-nanometre divisibility,
known root forms, and no mirrors. Unknown or malformed source rejects. Models
remain opaque and unchanged. This does not repair malformed existing boards,
normalize stock dimensions, or authorize geometry tolerance.

## Runtime delta and capability

The source baseline is the unchanged historical
`../doc6/kicad_mcp/tools/pcb.py`, SHA256
`cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0`.
It is also the pinned DOC10 runtime PCB module. Install only these two files
into a separately qualified new runtime:

- `kicad_mcp/tools/pcb.py` replaces the corresponding site-packages file.
- `kicad_mcp/utils/footprint_pose.py` is one new site-packages file.

The existing full-library-identity marker remains present. The production sync
descriptor additionally requires:

```json
{"evledaQualifiedFootprintPoseSync":"evleda.kicad-qualified-footprint-pose-sync.v1"}
```

`registered-production-descriptor.json` was captured through actual
`KiCadFastMCP` registration with subprocess/socket calls forbidden. It equals
the previous production descriptor except for this additional metadata key.
The host gate is separately owned and must require the new marker and exact
descriptor. `registered-descriptor*.json` came from the plain FastMCP unit-test
server and are retained as non-production test artifacts; do not pin them.
New runtime closure, profile migration, and real project sync remain root-owned
work and have not been certified by this overlay.

## Evidence and checks

- `oracle-final/manifest.json`: 20 actual KiCad 10.0.3 `FootprintLoad` →
  `SetPosition` → `SetOrientationDegrees` → `SaveBoard` cases, in private config
  and output directories. Five sources cover stock C0402, SOT523 with local
  pad angles, QFN paste apertures, USB-C oval PTH/NPTH, and synthetic mixed local
  pad/property/user-text angles plus legacy unlocked text. Loaded Python,
  pcbnew wrapper and native module hashes are checked before/after the run.
- Six offline test methods replay all 20 oracle cases and compare native pad
  position/size/drill integers exactly. They exercise the real renderer,
  descriptor, matching-existing resync, mixed-new/existing dispatch, unchanged
  models/UUIDs, and malformed/mirrored/sub-nanometre input rejection.
- `template-replay-final.json`: all 66 currently selected templates at four
  cardinal rotations (264 cases), preserving all 281 physical members per
  complete rotation and every byte outside angle-token edits.
- The final byte check reverses only permitted angle token insertion/deletion/
  replacement, then requires exact original source equality. It does not mask
  an entire pose form or allow coordinate/whitespace changes.

The initial offline test run omitted a mock library resolver and attempted a
read-only discovery connection that was refused. No editor/write occurred;
the mock was fixed and all six final methods pass without native calls.
An initial source-replay path used v3 for the mounting-hole file; the correct
approved v4 source was then used and the complete replay passed. Earlier
oracle/descriptor receipts are retained separately from final evidence.

From the repository directory, rerun existing offline tests without native use:

```powershell
& C:\EvlEDA-DOC10-20260918\environment\Scripts\python.exe -I -s -E -B sidecars/patches/doc11/test_sync_footprint_pose.py
```

Oracle and capture scripts refuse to overwrite evidence. The full overlay is
below 5 MB; runtime copying must separately preserve the 150 MiB disk reserve.

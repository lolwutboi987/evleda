# Explicit terminal-launch requirements

A point-to-point continuous-plane route can distinguish its terminal transition
from the trace body with optional `referencePath.terminalLaunches`:

```json
{
  "signalEndpoint": {"reference": "J4", "pin": "1"},
  "referenceEndpoint": {"reference": "J4", "pin": "2"},
  "maximumLengthMm": 1.9,
  "maximumReturnSpacingMm": 2.54,
  "engineeringBasis": "Reviewed through-hole connector transition; preserve the body margin and require a direct local ground return"
}
```

This is one entry in an array, not a replacement reference path. All existing
plane/layer selections, margin, terminal-reference assignments, route lengths,
widths, via limits and native rules remain in force. Omitting the extension
preserves existing bundle identities and full-ribbon behavior. An explicit
declaration is part of a new authenticated bundle; a diagnostic study is not.

Each entry must match an existing `terminalReferences` pair, with distinct pins
on one footprint. Only point-to-point routes outside declared differential or
channel interfaces are supported. Length and return spacing are positive exact
integer nanometres expressed in mm, bounded at 3 mm and 5 mm respectively.
Those ceilings are capabilities, not electrical defaults. Up to two launches
may be declared. Bounds and rationale may remain null in an unresolved draft.

## Source-preserving revisions

For an existing materialized project, submit the explicit revised draft and use
`evleda_revise_terminal_launches` with its ready `draftId` and a source project
normally closed in the same connection/profile. The operation creates a separate
allocation and preserves the original project and its findings. It permits only
substantive launch-declaration changes and their rationale; mixed body margins,
terminal assignments, circuit, placement, stackup, plane policy, numeric/native
constraints or libraries reject. No-op and rationale-only changes reject.

Before allocation, saved geometry must support each declared approach: ordinary
centred through-hole terminals on a front-side cardinal footprint, one incident
straight/cardinal/45-degree segment, a bounded local return, and a nonzero body
remainder. Copper and schematic remain exact. The normal constructor rebinds
owned identifiers; thermal-rule owner names may change, but their numerical
constraints do not. No live fill or acceptance evidence transfers.

## Native evaluation

After refill/save, each launch gets a separate `reference-launch` row. It needs
matching current native/source pad centres, nets, layers and ownership; a direct
eligible native return-pad contact on the intended plane; complete foreign-bore
separation; and current authenticated native clearance/short checks. Its own
signal-terminal bore is accounted for explicitly. Exact foreign-bore overlap
fails; conservative enclosure overlap or incomplete evidence remains unknown.

Only the declared terminal approach is removed from the body projection. Every
other segment and the complete body margin remain. Missing launch geometry
cannot invent an executable partial projection, and unsupported cases do not
pass. The public result exposes exact cut points, limits and local conditions.

A verified local launch row and covered body do not establish complete
drill-clipped return continuity, impedance, cable behavior or EMC. Those existing
obligations remain separate. The read-only [launch study](reference-terminal-launch-study.md)
still changes no requirement; it supplies prospective geometry for the engineer's
decision before this explicit revision path is used.

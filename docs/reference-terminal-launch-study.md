# Study a connector launch without changing its requirements

`evleda_check_reference_coverage` accepts an optional `terminalLaunchStudy`.
It retains the ordinary full-ribbon result, then separately evaluates the
remainder after a proposed short terminal approach is omitted. It helps inspect
a continuous-reference requirement that reaches a signal pad's clearance hole.

```json
{
  "signalNets": ["SWCLK_HDR"],
  "signalLayer": "F.Cu",
  "referenceNet": "GND",
  "referenceLayer": "In1.Cu",
  "marginNm": 250000,
  "marginBasis": "Preserve the existing 0.25 mm beyond-trace-edge requirement",
  "terminalLaunchStudy": [{
    "signalEndpoint": {"reference": "J4", "pin": "1"},
    "referenceEndpoint": {"reference": "J4", "pin": "2"},
    "maximumLengthNm": 1900000,
    "maximumReturnSpacingNm": 2540000,
    "engineeringBasis": "Prospective review of this through-hole connector approach"
  }]
}
```

The host derives centres, nets and incident traces from the saved footprint;
callers cannot supply replacement geometry. Supported terminals are single
ordinary centred through-hole circle/rectangle pads on one front-side footprint
at a cardinal rotation. One selected straight/cardinal/45-degree segment must
end at the signal-pad centre. The proposal must leave a nonzero remainder, and
the nominated return pin must be on the reference net within the explicit
spacing bound. Ambiguous, overlapping or unsupported proposals stay unassessed.

Up to four proposals are supported, with lengths up to 3 mm and return spacing
up to 5 mm. These are bounded capabilities, **not recommended electrical limits**.
Integer diagonal cut points never exceed the declared length. All other
segments, widths, plane selections and margins remain exact.

`geometricStatus` still describes the complete original selection. The separate
`terminalLaunchStudy.remainderGeometricStatus` describes the hypothetical
remainder. Both diagnostic resources and derived cut points are returned.
Source/project drift invalidates the result. Covered remainders do not qualify
the omitted launch, return contact, impedance or signal integrity;
`acceptanceChanged` stays false. No design source or requirement is edited, and
the full plane-acceptance checker does not consume this study as an exception.

The [RP2350 review](../proofs/terminal-launch-study-20260920/README.md) retains both
header failures while finding covered remainders after 1.9 mm clock and 1.5 mm
data approaches. An explicit future launch requirement still needs its
engineering decision and source-preserving revision.

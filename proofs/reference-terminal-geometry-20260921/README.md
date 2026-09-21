# Reference coverage joined to physical ground-terminal paths

**Native-qualified and installed in host59 on D:.** All **19 declared geometric
reference rows** now pass on the unchanged RP2350 candidate. This covers the
QSPI, USB, debug and crystal routes with their existing margins and explicit
debug-header launch requirements. The full result is **163 pass, 411 unknown,
0 fail; accepted=false**.

Fresh native refill/save, complete public-report retrieval and normal close
passed. Both the protected board and isolated qualification copy retain all
six source files unchanged. All 67 functional nets remain connected and
configured DRC is clean. DOC17, the v4 profile and PCB skill are unchanged;
a fresh actual Codex client discovers 19 initial tools. Existing desktop
connections are not claimed to have reloaded.

See [native summary](native-summary.json), [complete public report](public-report.json),
[assessment](native-assessment.json), [delivery](delivery.json),
[installation](installation.json) and [fresh client discovery](fresh-client.json).

The plane assessment now requires the verified ground-pad copper paths when
completing a declared reference-path row. Interface geometry also requires its
complete reference rows to pass. Native pad reachability or a covered ribbon
alone cannot satisfy that combined requirement.

For the saved RP2350 candidate, host58 already verified all 64 physical GND
pads, and its existing reference helper reported covered copper for 18 of 19
constrained signal nets. The remaining SWDIO_MCU result was geometrically
uncertain. [The exact saved-data check](static-replay.json) proves strict
containment of all six SWDIO_MCU segments at the original **0.25 mm margin**.
No track, pad, via, plane, margin or launch requirement was changed.

## Result meaning

`referenceCopperConnectivity` identifies the explicit reference-pad UUIDs and
requires their current positive-width drilled-copper witnesses to reach the
same intended plane. Every signal and reference terminal must retain its complete
eligible physical membership. This reuses the host58 terminal-path evaluator.

`geometricStatus` and the original helper's individual route observations remain
unchanged. When that helper reports uncertainty, a separate `capsuleRefinement`
can prove strict containment using exact integer segment-to-boundary distance
tests against every outer and hole edge of the validated stored component.
`resolvedGeometricStatus` reports the combined geometric conclusion.

A round-ended capsule whose start is inside the component and whose entire
centerline stays more than its radius from every boundary is strictly contained.
Twice-nanometre coordinates preserve half-nanometre radii from odd track widths.
The check has a four-million-operation bound and retains every segment result.
Tangency, missing evidence and unsupported cases remain unproved. A definite
uncovered result is never replaced by the refinement. Drill exclusion, fresh
fill, plane topology, declared launches and physical terminal paths remain
separate required conditions.

These are nominal geometric reference checks. They do not prove impedance,
EMC, high-frequency return performance, ampacity, temperature or manufacturing
suitability. Overall acceptance remains false. USB startup and other material
electrical-review items remain open.

## Verification

[133 affected tests](verification.json) pass, including complete reference and
interface paths, missing ground paths, exact tangency, unchanged negative
findings, half-nanometre radii, holes, concave boundaries and malformed public
refinements. Full source and UI typechecks pass with a 2 GiB heap cap. The exact
historical host58 public projection still reproduces unchanged. This is not a
full-suite claim, and the replay does not recreate native fill authority.

The frozen backend build passed on D: with the same 2 GiB heap cap. The
[GitHub typecheck/backend job](https://github.com/lolwutboi987/evleda/actions/runs/35582742651/job/106279080984)
also passed for source commit `a3cb7daeb069a85ee80962d3b976b16b14df1cfd`.
The [complete CI workflow](github-verification.json) still fails because the
separate native-dependent job lacks its pinned KiCad runtime; that check was
not skipped or relabeled as passing. User applications stayed open.

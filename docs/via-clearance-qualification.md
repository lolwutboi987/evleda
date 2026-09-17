# Via-clearance verification: 17 September 2026

Real KiCad 10.0.3 DRC was exercised on isolated copies of the native10 regulator
proof with its original project settings and canonical DRU unchanged. Two clean
baselines and nine targeted negative/control comparisons passed. Each required
finding was tied to the exact involved UUIDs; corrected controls removed the
targeted finding without hiding unrelated dangling/unconnected warnings.

| Deliberate defect | Native finding |
| --- | --- |
| Via against another-net pad, track or ordinary routed via | 0.1400 mm gap fails the effective 0.1500 mm class rule |
| Drill against another-net copper | 0.2400 mm fails 0.2500 mm |
| Same-net hole spacing | 0.2400 mm fails reported 0.2495 mm; saved setting is 0.25 mm |
| Via copper near board edge | 0.3900 mm fails 0.5000 mm |
| Via annular ring | 0.0750 mm fails the project's 0.1000 mm rule |
| Ordinary routed via moved into stale zone fill | 0.0656 mm copper and 0.2156 mm drill gaps fail; refill creates the required clearance |

Full measured reports, controls, native copies, exact commands, invalid early
probes and original-source comparisons are retained in
[the native qualification report](../../destination-verification/via-clearance-native-01/REPORT.md).
Five pre-existing unrelated ignored categories remain disclosed. No tested via
category was ignored, and warning findings returned the failure exit code.

The toolbox independently enforces exact authored via dimensions/net/layers,
contract annular ring and board-edge margin at write/readback boundaries.
Native10's contract ring minimum is 0.15 mm, stricter than the native project's
0.10 mm setting. Incremental route creation does not itself establish all
cross-net spacing; current native DRC remains required.

The result validator now explicitly requires enabled `hole_to_hole`,
`holes_co_located`, `annular_width` and `drill_out_of_range` categories alongside
the existing clearance/short checks. These four may have error or warning
severity because the qualified invocation checks all severities. Missing,
ignored or unrecognized settings cannot produce a verified result. Existing
clearance/short requirements are unchanged. Two focused unit suites passed
206 tests, including disabled-category and hole-warning regressions.

An ordinary unattached via placed over another-net fill can have its net
reassigned by KiCad while loading. The initial floating foreign-net probes were
therefore invalidated, not called missed clearances. Connected ordinary test
vias retained their requested net and produced the intended findings. The
writer's live and saved comparisons include each via's net; source text alone
does not establish the net KiCad evaluated.
Two additional net-only fault tests at post-push and mandatory-save readback
verify quarantine, blocked retries and no successful persistence; the complete
authoring suite passed 46 tests. The native contact reader also compares loaded
route nets to saved source and detects the observed load-time reassignment.
Independent source review found no actionable defect in the added category guard.

This establishes scoped native DRC sensitivity and software enforcement. It is
not a routed RP2350 board, full plane acceptance, same-net physical-copper rule,
current/thermal assessment or manufacturing qualification. Actual placement and
routing still require their own saved-state checks.

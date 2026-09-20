# Native pad-policy qualification on unchanged RP2350 R1

The GPIO ground pads sit outside the deliberately inset ground planes and connect
through inward access tracks. Treating every ground pad on an enabled copper
layer as requiring direct zone contact incorrectly reported those pads as failed.
Host44 separates local zone-setting applicability from electrical connectivity.

The new classifier requires complete qualified source/native pad geometry and a
strict geometric separation proof. A conservative disc encloses all pad copper,
including offsets at any rotation. Exact integer squared distances must place
that disc strictly outside the declared plane rectangle. Tangency or overlap
does not qualify. Native direct contact contradicting the proof rejects.

For the GPIO pads, the centre is 1.35 mm outside the plane boundary and the pad
radius is 0.85 mm: the entire pad is separated by 0.50 mm. The eight pads receive
`pad-copper-outside-declared-plane-boundary` on each of In1 and In2, with local
thermal/contact applicability marked `not-applicable`. This does **not** assert
their inward tracks or endpoint connectivity. Those remain independent checks;
an outside pad with a reported unconnected error still fails.

The earlier oval/mechanical shield-pad correction is also included. Local
thermal/connection overrides, uncharacterized geometry, required native
clearance checks and complete physical inventories retain their guards. Each
plane now has its own thermal-policy finding, so an ambiguous In2 contact scope
does not contaminate In1's result. The aggregate remains conservative.

## Actual native result

Public tools resumed the saved R1 project under host44/DOC17, refilled both
planes, performed mandatory save/readback, collected a fresh acceptance report
and closed normally. **All six source files remained byte-identical**, including
the PCB and canonical rules. No trace, via, footprint, plane setting or contract
was changed to obtain this result.

- Native DRC remains clean and endpoint connectivity remains connected.
- In1 local thermal policy and scoped intended-plane connectivity are verified.
- All sixteen outside-pad observations are retained in the report.
- In2 local thermal policy remains unknown because native aggregate contacts
  cannot be attributed to one stored subpolygon in the existing evaluator.
- In2's ten-component/single-component contract mismatch still fails.
- Overall assessment: **141 passed, 430 unknown, one failed; accepted=false**.

[Summary](summary.json), [complete public assessment](assessment.json),
[pad/plane comparison](result-comparison.json) and [saved lifecycle](lifecycle.json)
retain the actual results. The original two-failure assessment in native-r1 is
preserved as historical evidence, not silently relabelled. Physical copper
width, complete drill-clipped continuity, header reference launches and electrical
qualification remain separate. In particular, the candidate's documented USB
startup/inrush gap is not resolved by these geometry and software checks.

## Software and installed client

The frozen build passes **295 focused tests in five files**, source/UI
typechecks, backend build and native helper packaging. Cases cover outside versus
touching/overlapping copper, contradictory native contact, retained unconnected
errors, per-plane uncertainty, oval/mechanical pads and forbidden overrides.
[Software evidence](software-verification.json) and [test output](focused-tests.log)
do not claim a full-suite result.

The existing workspace entry now points to host44 with the same DOC17 profile.
Workspace path, edit policy, timeout, environment and unrelated configuration
are unchanged. The current PCB skill includes applicability guidance. A fresh
actual Codex client discovers all 17 tools; cached desktop activation is not
claimed. [Client evidence](client-verification.json).

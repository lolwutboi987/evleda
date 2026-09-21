# Placement checks and the C12–R7 spacing correction

The new source checker found a real mismatch in the previous candidate:
**C12–R7 courtyard separation is 0.02 mm; the declared requirement is 0.10 mm.**
Configured native DRC was clean because a non-overlapping courtyard does not
establish that additional declared gap. The [baseline result](baseline-source-placement.json)
retains failures for both components and passes the other 60 placements.

Managed correction and native qualification are in progress. Installed host59
and the original board remain the current delivered baseline at this checkpoint.

## Reviewed correction

The [review proposal](proposal.json) moves R7 0.10 mm left, preserving its
orientation and the existing signal tracks. A nearby ground via moves 0.15 mm
down to its existing diagonal lead endpoint; the redundant 0.15 mm vertical
ground stub is removed. Via diameter, drill and all clearance requirements stay
unchanged. Only R7's placement-region minimum X extends from 9.35 to 9.25 mm.

This preserves the crystal block's placement intent while giving C12–R7 a
**0.12 mm** courtyard gap and avoiding the adjacent clock trace and ground via.
The [unmanaged review copy](proposal-source-placement.json) passes all 62
placement checks; its [native DRC](proposal-native-drc.json) has zero violations,
unconnected items and schematic-parity issues with the existing exclusions.
That review copy is not a substitute for managed authoring and verification.

## Reusable check

The existing plane assessment now evaluates the original placement rows using
the actual saved source and current approved footprint sources. It checks side,
cardinal rotation, anchor region, exact board-edge bounds, preferred edge and
every pairwise courtyard clearance. Complete footprint inventory is required.
The original authenticated V2 bundle remains the authority; no V1 substitute or
replacement rule is used.

Rectangular courtyards have exact integer distance checks. Complete simple
orthogonal courtyards are matched to their approved boundary geometry and use
conservative rectangular enclosures: sufficient enclosure separation proves a
pass, but an inconclusive enclosure cannot invent a failure. Unsupported or
missing geometry remains unknown. Known pose and rectangular-gap failures are
preserved even when other geometry is unavailable. Clearances are compared in
integer nanometres without a tolerance that hides a one-nanometre violation.

Placement evidence is independent of fresh plane fill, so it remains useful on
read-only reopening. It does not prove housing, fastener, height or physical
assembly tolerances. The closed public projection retains every pair record and
rejects inconsistent distances, missing pairs and unsupported success claims.

[160 affected tests](verification.json), full source/UI typechecks and the
frozen backend build pass. This is not a full-suite or manufacturing claim.
The three unsuccessful initial move studies remain preserved privately on D:;
their copper violations were not waived. USB startup and other electrical
review remain open.

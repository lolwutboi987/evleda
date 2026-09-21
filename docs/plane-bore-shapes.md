# Plane checks with non-plated holes and slots

The drill-topology reader now includes qualified non-plated holes and centred
cardinal oblong drills. Previously, the RP2350 assessment stopped before inventory
completion on these shapes. This change does not alter the PCB or its rules.

The reader requires matching source/native type, dimensions, centre and span.
Slots also require an exact matching cardinal angle. Non-plated holes retain
their mechanical role and null net; they cannot become electrical terminals.
Unknown fields, extra machining, offsets, source drift and unsupported projection
remain unverified.

A circular bore retains its existing report. A slot adds
`slot: { majorDiameterNm, axis }`; its `diameterNm` is the minor diameter, and its
centre-line endpoints plus circular end caps define the complete void. Exact
twice-nanometre coordinates preserve half-nanometre endpoints. Reports retain
this geometry instead of presenting a slot as one approximate circular hole.

A capsule wholly inside an existing cached hole receives the separate
`exact_capsule_inside_cached_hole` basis. Tangency is permitted only inside an
already excluded hole. Otherwise, conservative outward rectangles must remain
strictly separated from existing boundaries and other new holes before the
single plane interior can be certified. Ambiguous intersections remain unknown.

Reference ribbons use exact capsule-to-capsule distance: a route near a slot end
can expose missing copper even when the centre circle is clear. An oversized
enclosing disk is not used to declare a false gap. Exact tangency remains unknown.

This is a geometric observation. Complete terminal/barrel contact continuity,
minimum copper width, thermal/current suitability, whole electrical acceptance
and manufacturing qualification remain separate. Source tests do not replace a
fresh native observation under the installed host.

Large assessments keep the complete sanitized public projection in a separate
immutable resource. The ordinary tool result then uses the distinct
`evleda.toolbox-plane-acceptance-resource-summary.v1` schema, retaining status,
row counts, unresolved requirement IDs and source identities. Read
`fullReportResource` for every finding; `fullReportIdentity` binds its exact bytes.
No array or finding is truncated. Small results retain the existing inline schema.
The last 32 resources remain available in the same MCP connection after normal project close, subject to
unchanged file identity/content; they represent historical snapshots. Private
native evidence remains a separate artifact and is not served by that resource.

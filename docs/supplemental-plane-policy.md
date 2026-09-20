# Explicit supplemental ground-region policy

Four-layer designs can distinguish the continuous primary ground plane from
supplemental fill between routing. The original single-component policy is
unchanged and remains the default form. A separate ready draft can explicitly
select this alternative for an additional plane:

```json
{
  "removeUnconnected": true,
  "minimumAreaMm2": 1,
  "requireSingleConnectedComponent": false,
  "referencePlaneId": "GND_PLANE",
  "engineeringBasis": "Supplemental routing-layer fill; every stored region requires qualified via contact and retained-area evidence to the primary plane."
}
```

The reference must be the routing owner's primary plane on the same ground net.
That primary must retain its single-component policy. A plane used as a required
continuous signal or interface reference cannot select the alternative. Missing
reference or rationale stays unresolved; the compiler does not invent either.
Existing single-policy bundles retain their exact identities.

For an existing board, use `evleda_revise_plane_regions` with the new ready
`draftId` and a materialized `sourceProjectId` closed normally in the same
connection/profile. The new allocation preserves geometry and schematic, with
separate lineage and regenerated owned names/rules. The old allocation and its
old requirement are preserved. Mixed placement, circuit, routing, clearance,
native setting or area-floor changes reject. Rationale-only and no-op revisions
reject. This operation transfers no acceptance or live fill authority.

After refill/save, each native region needs a qualified positive-area via contact
to the primary plane. Its minimum-area condition uses a conservative retained-area
lower bound: complete source/native bore enclosures are checked against every
component. Enclosures proved outside its filled area remove nothing; all remaining
possibly intersecting enclosures contribute their entire circumscribed square.
Overlapping or partly cached bores can be subtracted more than once, making the
result conservative. An insufficient lower bound is unknown, not proof of failure;
stored area already below the floor remains a failure.

`regionalPolicyConditions` reports these scoped conditions separately. Positive
contacts and retained area do not establish complete drilled-copper continuity,
minimum physical copper width, current capacity, impedance or manufacturing
acceptance. The complete island/contact row remains unknown where those
independent obligations are not established. A policy revision is an explicit
engineering decision; it does not turn missing evidence into a pass.

Software verification and native qualification have distinct scopes. Do not claim
native adoption of a particular candidate from compiler or synthetic adapter
tests alone; follow that candidate's saved lifecycle and source-bound assessment.

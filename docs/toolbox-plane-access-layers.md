# Explicit mixed-layer plane access

A V2 plane route may declare `accessRouting.preferredLayer` as `F.Cu`, `B.Cu`, or
`either`. A draft may keep it `null` until resolved. `either` requires the net's
class to allow both `F.Cu` and `B.Cu`. The plane's own `layer` remains exactly one
of those layers.

For example, one GND plane on `B.Cu` can have existing front access tracks and an
explicit 0.60 mm back-layer return strap when GND access declares `either` and
the width satisfies its existing class minimum. Both tracks remain on the same
GND net. Every requested track still selects one exact physical layer; neither
`either` nor an inner layer is valid as a track layer.

This declaration does not add vias or connect coincident points across layers.
Explicit vias or inspected through-hole copper must establish transitions.
Track width, turn, edge, combined route-length, per-net/global via budgets,
retained geometry, source identity and mandatory native save/readback checks are
unchanged. Plane contact, clearance and completed connectivity remain separate
native acceptance checks.

An existing F-only access contract continues to reject back-layer tracks. Use a
newly compiled project or the ordinary qualified unwired schematic revision path
to change routing intent; do not patch an existing bound contract. Software tests
cover mixed-layer admission and exact saved-source preservation. Qualification
on the actual board remains required once its PCB exists.

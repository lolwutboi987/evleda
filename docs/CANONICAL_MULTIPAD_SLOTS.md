# Canonical multipad, shared-land, and slot contract

This contract keeps manufacturer pin and pad identifiers unchanged while
representing physical connector geometry without last-write-wins maps.

## Multiplicity

- `FootprintPad.pad_id` is the unique physical-record identity.
- More than one physical pad may use the same `(component_id, pad_number)`.
  Every member must resolve to one existing logical component pin and carry the
  same `net_id`, including `None` for an intentionally unconnected pin.
- The mapper, graph normalizer, graph hash, project-store codec, and retained
  mapping evidence keep every physical `pad_id`; manufacturer pad numbers are
  never rewritten to manufacture uniqueness.
- The inverse case uses `shared_land_group_id`. Distinct logical
  `pad_number`/`pad_id` records in one group preserve every contact while
  declaring one intentional coincident copper land. A group is valid only when
  it has at least two members on one component, all logical pad numbers are
  distinct, and center, copper size, shape, copper rotation, layers, exact
  drill geometry, and net are identical. An exact coincident member cannot be
  omitted from the group.
- Shared lands are added with one atomic `footprint.pad_group.add` command so a
  singleton/partial group can never cross the validated graph boundary.

## Exact drill geometry

`FootprintPad` and `FootprintHole` expose these authoritative fields:

- `drill_x_nm`
- `drill_y_nm`
- `drill_rotation_udeg`

Equal X/Y values are a circle and normalize to zero rotation. Unequal values
are an oval/slot and normalize rotation modulo 180 degrees. The legacy
`pad_drill_nm` and `diameter_nm` fields remain canonical minor-dimension aliases
for circular callers and must equal `min(drill_x_nm, drill_y_nm)` when exact
geometry is supplied.

A plated hole binds exactly one physical `pad_id`. Its center, X/Y dimensions,
and normalized rotation must match that pad's drill geometry; one pad cannot
bind multiple plated-hole records. Non-plated circular and slotted mechanical
holes carry the same exact dimensions and rotation but cannot claim a pad.

The durable project document version is 4. Version-3 documents fail closed and
need an explicit history migration because adding exact drill and shared-land
fields changes canonical graph and revision hashes. New version-4 documents
round-trip and restart without geometry loss.

The canonical mapping-evidence repository schema is version 3 for the same
reason. Empty v2 repositories migrate automatically; populated v2 repositories
fail closed and require deterministic source re-resolution so historical graph,
command, candidate, and evidence digests are never rewritten in place.

## Current integration boundary

Canonical acceptance does not by itself prove board safety. Downstream
verification must consume a collection keyed by physical `pad_id`, not a map
keyed only by `(component_id, pad_number)`, and must include every physical pad
and slot in clearance, edge, connectivity, and drill checks. Geometry should
deduplicate intentional shared-land copper by `shared_land_group_id` while
retaining every logical contact for connectivity. Until those checks pass,
multi-pad/shared-land graphs are not manufacturing-release evidence.

The capability is connector-agnostic. A specific connector such as USB4105
still requires trusted catalog/source evidence for its exact contact pairing,
shell stakes, locating features, and recommended land geometry; this contract
does not hard-code or independently certify any connector footprint.

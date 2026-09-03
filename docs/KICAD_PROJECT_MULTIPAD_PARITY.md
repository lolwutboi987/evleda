# KiCad project multipad parity contract

The strict three-file project importer accepts a footprint only when its
schematic symbol and PCB representation prove the same component reference,
value, footprint library identity, logical pin population, and named-net
connectivity. Physical pad identity is never reduced to pad number.

## Electrical pad grouping

For each matched schematic-symbol/PCB-footprint pair, the importer applies the
following rules:

1. A PCB `np_thru_hole` record is mechanical. The KiCad board model already
   requires its number to be empty and forbids net and pin metadata, so it is
   excluded from the logical pin-number population.
2. Every other PCB pad is retained and grouped by logical pad number. The group
   keys must equal the schematic pin-number population exactly.
3. A group may contain more than one physical pad. Every member must carry the
   same canonical PCB net ID (including a consistently unconnected `None`
   claim), and that net must match the one resolved for the schematic pin.
4. When `pinfunction` or `pintype` metadata is present, every physical pad must
   agree with the unique schematic pin name and electrical type. A contradictory
   metadata claim is an ambiguous mapping and fails import.
5. Distinct pad numbers may describe one exact coincident land. Their physical
   records, UUIDs, and logical numbers remain distinct, but exact coincident land
   geometry cannot claim more than one net.

The coincident-land key binds pad kind, shape, local position, rotation, size,
drill dimensions, layer tuple, and round-rectangle ratio. It deliberately omits
UUID, number, net, and pin metadata because those are the identities and claims
being audited.

These rules support connector footprints that use repeated VBUS or GND lands,
multiple plated shell slots with one logical `S1` number, and two explicitly
distinct contacts such as `A1` and `B12` on one shared copper land. They reject
last-write-wins interpretations, mixed-net duplicate numbers, and mixed-net
coincident lands.

## Compiler-produced regression fixture

`tests/kicad_project/test_multipad_compiler_bundle.py` constructs a typed
USB-C-class canonical graph and feeds it through the production deterministic
compiler. Its emitted `.kicad_pro`, `.kicad_sch`, and `.kicad_pcb` bytes are then
imported, exported, and reopened through the project-bundle codec.

The proof checks all of the following in both the first import and reopened
bundle:

- the component reference, value, and footprint identity;
- the exact logical pin population `A1`, `B12`, `GND`, `S1`, and `VBUS`;
- four distinct physical `VBUS` pads, four distinct `GND` pads, and four
  distinct plated oval-slot `S1` pads;
- two distinct coincident `A1`/`B12` records on one net;
- two numberless, netless NPTH locator holes;
- all 16 unique board pad UUIDs and exact slot copper/drill dimensions; and
- compiler verification plus whole-bundle semantic round-trip parity.

Malformed variants independently change one repeated pad's net, one repeated
pad's pin-function metadata, and one coincident contact's net. Strict import
rejects each variant.

## Deliberate limits

This remains a bounded, single-root-sheet codec:

- The project manifest permits exactly one root sheet and one top-level-sheet
  record. Hierarchical sheet instances, hierarchical labels and pins, and
  cross-sheet connectivity are not flattened or inferred.
- Schematic `sheet`, bus, bus-entry, implicit power-symbol, inherited-symbol,
  mirrored-symbol, and legacy instance constructs remain explicit unsupported
  diagnostics. With any unsupported electrical construct, cross-artifact parity
  is recorded as not proven rather than guessed.
- The three KiCad files do not encode the canonical `shared_land_group_id`.
  Exact coincident pads and their separate identities are preserved and checked,
  while provenance for an explicitly named canonical group remains in the
  compiler identity manifest.
- This boundary does not run KiCad and cannot claim GUI load, ERC, DRC, or
  manufacturing-release eligibility. Those require the separately pinned KiCad
  worker and release gates.


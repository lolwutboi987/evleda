# Canonical DesignGraph → KiCad 10 compiler

`backend.kicad_compile.compile_design_graph(graph, project_stem)` is the
product-owned, deterministic boundary that turns an exact canonical
`DesignGraph` into a closed set of managed in-memory project bytes:

- `<stem>.kicad_pro`
- `<stem>.kicad_sch`
- `<stem>.kicad_pcb`
- `sym-lib-table` and `fp-lib-table`
- `FluxGenerated.kicad_sym`
- one component-unique `FluxGenerated.pretty/*.kicad_mod` per placement

It accepts no path, directory, process, shell command, filename, or model
output. The stem is validated by `ProjectBundleInput`: it is a 1–64 character
ASCII basename containing only letters, digits, `_`, and `-`. The function does
not write a file or invoke KiCad. Auxiliary names are bounded POSIX-relative
names and reject traversal, drives, backslashes, Windows device aliases,
dot/space suffixes, case-insensitive collisions, and shadows of primary or
compiler-manifest names.

## Return contract

The immutable `CompiledProject` contains the complete source file set, a
canonical JSON compiler manifest, and its SHA-256 digest. Compiler v4 emits
profile-evidence manifest schema 3 for the exact R2 subject; generic projects
retain hermetic schema 2 behavior. The manifest binds:

- compiler ID and semantic version;
- normalized input graph SHA-256;
- exact filename, byte length, media type, and SHA-256 for each output;
- a domain-separated aggregate output-bundle SHA-256;
- reparsed project, schematic, and board IR SHA-256 values;
- a combined diagnostics-manifest SHA-256;
- every source identity to its deterministic KiCad UUID or canonical net ID;
- source-backed assembly, silkscreen, 3D-model, source-receipt, and human-
  schematic profile digests for schema 3;
- `semanticParity: true`, `referenceDesignReady: true`, and
  `kicadExecution: "not-run"`.

`referenceDesignReady` has a deliberately narrow meaning: the project artifacts
are cross-artifact complete, deterministic, hermetically library-linked, and accepted by the reviewed
KiCad-10 codecs. It does **not** mean that KiCad ERC/DRC, zone filling, 3D
clearance, fabrication plotting, or a manufacturing review ran. Consequently
`manufacturingReleaseEligible` is permanently `false` at this boundary.

## Deterministic lowering

The compiler normalizes and validates the graph before inspecting the supported
subset. UUIDv5 identities use a compiler-owned namespace plus an entity-kind
domain and canonical source identity. Input collection order cannot affect the
bytes or evidence.

PCB lowering preserves:

- named net identity through an explicit source-net → KiCad canonical-net map;
- component reference, value, footprint library ID, placement, lock, and pin
  metadata;
- every physical pad identity, number, board-space centre, size, shape,
  rotation, copper layers, net, lock, and drill geometry;
- multiple physical pads carrying one logical pad number;
- coincident shared lands for distinct logical contacts, including a reversible
  shared-land-group → emitted-pad UUID binding;
- circular and oval plated drills, with perpendicular slots represented by the
  equivalent swapped-axis KiCad form;
- circular or oval unplated locating holes as numberless, netless, pinless
  `np_thru_hole` pads with no copper annulus;
- closed polygon Edge.Cuts, straight tracks, through vias, and polygon zones.

Every placed PCB footprint links to a component-unique portable ID under the
project-local `FluxGenerated` nickname. Its exact local `.kicad_mod` is derived
from that placed subject, with root placement/UUID and pad nets removed and all
pad angles transformed back into zero-orientation module coordinates. The
schematic `Footprint` property uses the identical fully qualified ID. Original
canonical footprint-library IDs remain present in content-addressed identity
bindings; they are never resolved from the host.

The KiCad-10 finalizer emits the modern layer ordinals, redundant pad net names,
and the native clockwise screen transform. Footprint-relative pad centres use
the inverse footprint rotation, while pad angles remain absolute/global as
KiCad 10 requires. A 90-degree asymmetric-pad regression is checked both by the
integer transform suite and by the installed KiCad executable.

For the pinned two-layer reference subject, the project and board bytes also
bind a nominal 0.80 mm stackup: 35 um copper on each side, 0.71 mm FR-4 core,
0.01 mm green mask on each side, and ENIG finish. The thickness is a
conservative project choice, not a connector-vendor requirement. Project rules
retain 0.20 mm general clearance and use a 0.15 mm project-local native hole
rule only to preserve the exact pinned public USB4105 footprint; the separate
graph audit records the approximately 0.1751 mm connector-pad/locator gap and
enforces 0.20 mm for authored routing. Neither value is a manufacturer-
authorized clearance, connector-fit proof, or fabricator approval. Mechanical
mating remains unqualified.

The reference U1 and D1 apertures are layer-separated rather than inheriting
copper geometry. U1 pad 9 is 2.95 x 4.90 mm on `F.Cu`, with anonymous 2.40 x
3.10 mm `F.Mask` and `F.Paste` pads. Each D1 terminal is 0.70 x 1.20 mm copper,
with a 0.60 x 1.10 mm mask opening and 0.35 x 1.00 mm paste aperture. Their
datasheet SHA-256 values, aperture dimensions, and example stencil thicknesses
are bound as compiler source receipts. Stencil process and assembler approval
remain fabrication blockers.

### Exact R2 presentation profile

The schema-3 path is allowed only for `reference-usb-c-3v3-r2` graph
`4b4e91e04078276aecd6e9d4f084871c49377c59d5c7a53edb714a96c6c228ee`.
Any graph mutation fails before presentation data is applied. Its sealed profile
binds 23 component placements to 12 source-backed assembly profiles, all source
receipts, transformed artwork, the one explicitly permitted USB connector
overhang, and zero ordinary courtyard collisions.

Every one of the 23 component-unique modules contains its exact local `F.Fab`
body and `F.CrtYd` outline. Direct versus source-derived dimensions and their
derivations remain manifest-bound; a derived occupied-area courtyard is not
misrepresented as assembler approval. The PCB and its module also carry the
nine schematic fields, including canonical component and pin-map identities,
so KiCad schematic/footprint field parity remains exact.

The R2 root board carries a sealed 43-primitive `F.SilkS` plan: 35 text records
and eight pin-one/polarity lines. It includes all 23 references, `REV 2`, USB,
rail and test-point labels, polarity cues, and the two output warnings. The
planner uses source/body/courtyard/pad evidence and conservative native-safe
text bounds; any missing geometry or unsafe placement blocks compilation.

The 23 model decisions are also explicit. Fifteen digest-pinned, portable
`${KICAD10_3DMODEL_DIR}` references are emitted with identity transforms. Eight
components whose exact bodies are unavailable have no model node and carry
digest-bound omission reasons; no lookalike substitution is permitted. Model
files are not bundled, so a trusted render still requires the worker to resolve
and hash the installed model root.

The present KiCad exchange IR deliberately models electrical and copper
constructs only. These review graphics are carried as canonical, digest-bound
**preserved** KiCad S-expressions in the diagnostics manifest. The strict
parser/re-emitter retains them byte-for-byte; it does not flatten them into the
electrical IR or silently drop them. This remains codec-only evidence:
`kicadExecution` stays `"not-run"`, and
`manufacturingReleaseEligible` stays `false`. No claim is made that KiCad
rendering, ERC/DRC, clearance checking, mask opening review, plotting, or
fabrication validation ran.

The R2 schematic is emitted from a transport-neutral, digest-bound human plan:
A4 landscape on the exact 1.27 mm connection grid, ten source-verified symbol
templates, four titled functional blocks, 23 explicit placements, nine fields
per symbol, 39 orthogonal wires, 29 collision-free local labels, one degree-3
junction, eight no-connect markers, and zero global labels. Every canonical net
has a local canonical-name label, and the R2 PCB uses the corresponding KiCad
hierarchical `/NAME` spelling so native schematic parity remains exact. Logical
pin numbers, physical pad numbers, names, types and required/NC semantics are
independently rebound through the plan and emitter identity manifests.

The emitter reparses and rebuilds its complete schematic, flattened symbol
library and 389 semantic identity bindings before returning. Compiler
verification repeats that operation and compares exact AST, source payload,
plan, catalog, emission and parser-IR digests. Generic non-R2 graphs retain the
v3 deterministic single-sheet lowering path.

### Hermetic library closure

`sym-lib-table` and `fp-lib-table` contain exactly one case-sensitive
`FluxGenerated` row each, both at table version 7. Their URIs are exactly
`${KIPRJMOD}/FluxGenerated.kicad_sym` and
`${KIPRJMOD}/FluxGenerated.pretty`. The external symbol library is generated
from the same embedded symbol AST: after removing only the outer
`FluxGenerated:` qualifier, every definition—including common `_0_1` and
placed-pin `_1_1` bodies—is structurally identical and ordered identically.
This closes a KiCad false-negative where missing placed-pin bodies can otherwise
escape link-warning checks.

`ProjectBundleInput.auxiliary_files` is immutable and sorted by portable
case-folded name. `all_files` returns typed `ProjectAuxiliaryFile` objects for
the three primary artifacts and every library artifact. Count, per-file,
auxiliary-total, and complete-bundle byte limits are enforced before parsing.
All source files bind name, media type, byte length, and SHA-256 in the compiler
manifest; import/export evidence additionally binds the auxiliary source-set
digest and round trips it byte-for-byte.

Active `<stem>.kicad_prl` UI state is deliberately **not** source content and is
rejected from every auxiliary bundle. The execution worker injects a separately
policy-bound canonical runtime PRL only inside its disposable run directory,
checks its hash before and after each KiCad command, and discards it with the
temporary state.

## Fail-closed subset

The compiler returns all detected issues as sorted, entity-addressed
`CompilationBlocker` records. It does not silently omit or approximate an
unsupported construct. Current stable blocker codes include:

- `board-outline-required`
- `outer-copper-layers-required`
- `copper-layer-name-unsupported`
- `copper-layer-count-unsupported`
- `schematic-symbol-capacity-exceeded`
- `schematic-pin-capacity-exceeded`
- `component-placement-required`
- `back-side-transform-unsupported`
- `non-quarter-placement-unsupported`
- `non-quarter-pad-rotation-unsupported`
- `pin-electrical-type-unsupported`
- `logical-pin-pad-missing`
- `required-pin-unconnected`
- `plated-hole-binding-required`
- `independent-slot-angle-unsupported`
- `partial-span-plated-pad-unsupported`
- `front-smd-layer-unsupported`
- `zone-priority-unsupported`
- `zone-lock-unsupported`
- `schematic-hierarchy-unsupported`
- `schematic-wire-lock-unsupported`
- `schematic-junction-lock-unsupported`
- `schematic-wire-intersection-unsupported`
- `schematic-net-contact-conflict`
- `schematic-junction-required`
- `net-schematic-anchor-required`
- `symbol-library-definition-conflict`
- `unconnected-net-name-collision`
- `reference-review-source-hash-required`
- `reference-review-clearance-required`
- `reference-r2-source-hash-required`
- `reference-r2-profile-required`
- the exact propagated `human-*` source, topology, placement, routing and
  emission parity blocker codes

Front-side quarter-turn placement is intentional: it gives an exact inverse
integer-nanometre transform under KiCad's clockwise screen convention.
Back-side mirroring and non-quarter-turn component
placement require a separately reviewed transform contract and remain blocked.
The fixed 0.25 round-rectangle ratio, 50 µm Edge.Cuts stroke, 0.5 mm zone hatch
pitch, generated presentation properties, paste/mask layers, and schematic
symbol layout are versioned compiler policy rather than inferred source facts.

## Parity verification

Compilation does not return immediately after serialization. It reparses the
project JSON, schematic, PCB, both library tables, packed symbol library, and
every footprint module with bounded typed parsers. It then checks:

1. exact compiler/version, graph, file, bundle, manifest, IR, and diagnostic
   hashes;
2. exact deterministic bytes regenerated from the supplied canonical graph;
3. identity maps for components, symbols, pins, pads, holes, nets, outline
   edges, tracks, vias, zones, wires, and junctions;
4. board layer, outline, placement, copper, drill, routing, via, and zone parity;
5. schematic reference/value/footprint/pin populations, named-net pin
   membership, wire geometry/net assignment, and junction geometry.
6. exact embedded↔external symbol AST equivalence, component-unique
   schematic↔board↔module links, module/file coverage, and closed auxiliary
   inventory.

`verify_compiled_project(graph, artifact)` repeats the checks for stored or
transported artifacts. Any mutated byte, manifest field, digest, identity map,
or supported semantic becomes `CompilationParityError`; no partially verified
artifact is returned.

## Verification evidence

The focused compiler suite covers deterministic round trips, ordering
independence, path-safe stems, output/manifest mutation, explicit blockers, a
routed two-layer reference project, a plated oval slot, coincident shared-land
contacts, an oval NPTH locating hole, source-specific mask/paste apertures, and
actual-reference review graphics: SilkS text population, Fab assembly-map
population, deterministic re-emission,
mask-domain clearance/bounds checks against emitted pads, holes, and vias, policy-derived
connector/diode labels, and review-graphic mutation rejection. The broader
regression command is:

```powershell
python -m pytest -q tests\kicad_compile tests\kicad_io tests\kicad_project tests\verification
```

These checks remain mandatory for every CLI or ChatGPT/MCP artifact-delivery
surface. The suite is gated on the exact installed
`kicad-cli` path and version 10.0.6. It writes managed bytes to a temporary
directory, injects policy-bound runtime preferences outside the immutable
source inventory, runs native ERC and refill-enabled
`pcb drc --schematic-parity --all-track-errors` without `--save-board`, parses
the JSON reports through the closed report parser, and fails on any finding or
ignored library check.

The exact R2 compiler test emits 29 source files: three primary artifacts, two
tables, one packed library, and 23 component-unique modules. Its typed checks
prove ten embedded/external symbol definitions, 23 instances/modules, exact
F.Fab/F.CrtYd artwork, 43 root-silkscreen primitives, 15 model references and
eight explicit omissions. KiCad 10.0.6 ERC, unfilled DRC, and refill/no-save DRC
all exit zero with zero findings, unconnected items, parity findings, or link
warnings; the board source hash is unchanged. This native run is test evidence,
not a claim added to the codec artifact: compiler output continues to state
`kicadExecution: "not-run"` and can never authorize manufacturing release.

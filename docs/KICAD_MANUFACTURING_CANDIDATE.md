# KiCad manufacturing-candidate contract

This package creates a **non-release derivative** from an exact host-owned
`CompiledProject`. It is an engineering-review artifact, not manufacturing
authorization. Every receipt fixes `manufacturing_release_eligible` to `false`.

## Adapter surface

The host constructs:

```python
CandidateSource(
    compiled_project=compiled,
    expected_source_bundle_sha256=compiled.manifest.output_bundle_sha256,
    expected_manifest_sha256=compiled.manifest_sha256,
)
```

It also owns `CandidateHostConfiguration` (absolute pinned `kicad-cli` path,
executable SHA-256, exact `10.0.x` version, and private temp root) and the closed
`CandidatePolicy`. Request, CLI, chat, agent, and MCP callers supply no paths,
filenames, shell strings, layers, export flags, or arbitrary KiCad options.
`KiCadManufacturingCandidatePipeline.generate(source)` is the only operation.
For a reference-derived source, the path-free adapter also deterministically
renders the authority-owned BOM as canonical CSV and JSON, re-parses both
formats, and proves every row against the compiler's PCB/schematic component
identities before attaching it to `CandidateSource`.

For the reference board, `candidate_source_from_reference` accepts an exact
already-loaded `ReferenceArtifactSet` plus optional in-memory package and
publication manifest bytes. It has no path parameter. The adapter validates the
closed manifest schemas, the reference artifact/compiler identities, all 29
compiler source-file entries, the compiler-manifest entry, the package-to-
publication inventory extension, and the publication ZIP metadata. It then
places only the exact artifact, package-manifest, and publication-manifest
SHA-256 values in `CandidateSource` and the final candidate receipt. A stale
public package fails before KiCad runs.

The pipeline verifies the compiler manifest/file hashes, materializes the
complete project plus hermetic auxiliary libraries twice inside a fresh
operation directory, and never gives KiCad the canonical-copy path. DRC runs on
the derivative only:

```text
kicad-cli pcb drc --format json --units mm --severity-all --schematic-parity
  --all-track-errors --exit-code-violations
  --refill-zones --save-board --output <DERIVATIVE>/drc.json
  <DERIVATIVE>/<stem>.kicad_pcb
```

KiCad documents that `--refill-zones` refills before DRC and that the board is
saved only when `--save-board` is also present. Exit code 5 means violations
were found. See the official [KiCad 10 PCB DRC CLI
documentation](https://docs.kicad.org/10.0/en/cli/cli.html#pcb-drc).

After DRC, the pipeline byte-compares the isolated canonical copy with every
host-owned input byte and repeats all in-memory hash checks. A source mutation,
symlink, extra filename/directory, changed executable, malformed report,
report/exit mismatch, timeout, oversized output, or runner substitution fails
closed.

Active `.kicad_prl` UI/preferences state is never compiler source or packaged
output. The source boundary rejects any PRL before execution. For the derivative
only, the pipeline injects the exact policy-owned PRL from
`backend.kicad_worker.runtime_support`, binds its policy/template/manifest/file
hashes, and byte-verifies that KiCad preserved it. The file is excluded from
both source and CAM inventories and disappears with the operation temp tree.

## Closed CAM inventory

Only the filled derivative is used for six shell-free export argv calls. The
flags are derived from KiCad 10's documented [Gerber, drill, IPC-2581,
IPC-D-356, and position-file commands](https://docs.kicad.org/10.0/en/cli/cli.html#pcb-commands).
KiCad's own CLI source registers these independent export commands in the
[official KiCad source tree](https://gitlab.com/kicad/code/kicad/-/tree/10.0.4/kicad/cli).

The exact two-layer candidate inventory is:

- Gerber X2: `F.Cu`, `B.Cu`, `F.Mask`, `B.Mask`, `F.Paste`, `B.Paste`,
  `F.SilkS`, `B.SilkS`, and `Edge.Cuts`, plus the Gerber job manifest;
- split PTH and NPTH Excellon files, one Gerber X2 drill map for each, and the
  drill report;
- both-side millimetre CSV component positions;
- IPC-2581 revision C XML and IPC-D-356 netlist.

The output directory may contain no other file. Each artifact has an exact size
cap and total candidate cap. Validation does not stop at extensions: Gerber and
drill generator/FileFunction headers and terminators are checked, the Gerber
job inventory is parsed and cross-checked, CSV rows and finite coordinates are
parsed, IPC-2581 XML is parsed with DTDs forbidden, and IPC-D-356 headers and
terminator are checked. Receipt hashes bind both raw file hashes and the
timestamp-free content-validation facts.

## DRC classifications

Default policy accepts no DRC finding and no ignored check. A host policy may
explicitly classify only the closed library-resolution types
`lib_footprint_issues` and `lib_footprint_mismatch`; geometric/electrical types
such as clearance can never enter that tuple. KiCad's known ignored-check keys
must also be explicitly acknowledged and are bound into the receipt. These
acknowledgements do not change the original DRC report and never authorize a
release.

## Determinism statement

Every saved filled board retains its exact raw SHA-256. KiCad 10.0.6 can assign
fresh UUIDs to hidden `Datasheet` and `Description` footprint properties when
it saves a board, so raw board bytes can legitimately differ across isolated
runs. This is not silently erased or rewritten.

`kicad10-filled-board-semantics/1.0.0` parses the complete S-expression and
normalizes only the UUID in that exact, format-aware hidden Datasheet or
Description property, under an exact footprint UUID and containing exactly one
valid UUID. Empty values remain non-semantic; bounded canonical nonempty values
(including compiler provenance such as `urn:sha256:…`) are retained exactly in
the normalized semantic form. Visible properties, duplicate/missing UUIDs,
other metadata UUIDs, malformed values, and any unknown pattern fail or remain
semantic.

The evidence records both raw and normalized hashes, normalizer identity,
every normalized property identity hash/count, and the full exact copper fill:
zone UUID, net, zone/fill layer, island flag, normalized integer-nanometre
vertices, per-polygon doubled area/hash, aggregate vertex/area counts, and
aggregate filled-copper geometry hash. `fill_segments` is rejected rather than
flattened. Two-run acceptance requires normalized board semantics and all exact
filled polygon records to match, while preserving both differing raw hashes.

Tests include the exact KiCad 10 hidden-property rewrite and prove that moving
a copper vertex or changing a non-volatile identity changes semantic evidence.
The installed-KiCad reference forensics retained one zone/one polygon with 686
vertices; both runs reproduced exact doubled area
`2,741,203,697,423,857 nm²` and filled-copper hash
`d4b059612c2851d0f79d9703daf6c96d6dd742abb25490079e3c103abd075314`.

CAM bytes are **not claimed deterministic across runs**. KiCad 10 embeds
creation times in Gerber, Gerber-job, Excellon, and drill-report outputs. The
pipeline retains those exact bytes, hashes them, and labels every receipt
`run-specific-content-addressed`. It does not silently strip timestamps or
re-emit fabrication files. Across runs, it instead requires identical filename
inventory, parsed content roles, generator/version bindings, normalized DRC,
and filled-board bytes.

## Receipt authority

The immutable receipt binds:

- compiler bundle and manifest hashes plus every canonical source-file hash;
- the exact top-level `NOT_FOR_FABRICATION.txt` filename and SHA-256. Its
  byte-bound notice fixes `manufacturing_release_eligible=false`, prototype/
  reference-only status, the required physical/CM approvals, and the 3V3
  output-only / do-not-apply-power warning;
- the exact source PCB hash; deterministic BOM CSV/JSON artifact hashes,
  component count, and cross-format/compiler-parity evidence hash;
- proof that canonical source bytes were unchanged;
- runtime PRL policy/template/manifest/file hashes and proof KiCad left the
  derivative-only PRL unchanged;
- KiCad executable hash and exact version;
- policy hash, DRC raw/normalized hashes, finding count, library-only types,
  and acknowledged ignored checks;
- filled derivative hash and size;
- source-to-filled authored-zone proof: exact source/derivative board hashes,
  every authored zone UUID/net/layer/normalized outline and intent hash, and
  the generated-fill-node count. Any authored UUID, net, layer, outline, or
  non-fill board mutation rejects the candidate; only generated fill nodes and
  the narrow documented volatile hidden-property UUID pattern may differ. The
  KiCad root layer registry is also serialization metadata (numeric IDs and
  redundant aliases drift on save), so it is excluded while every object's
  explicit layer name—including each zone layer—remains identity-bound. The
  exact default two-sided tenting spelling (`front back` versus explicit
  `front/back yes`) is likewise normalized; all non-default tenting remains
  semantic;
- exact logical argv/exit/output hashes for version, schematic-parity DRC, and
  every export;
- every CAM filename/media type/size/hash, inventory hash, parsed-content hash,
  candidate hash, and receipt hash.

It deliberately carries no approval, signing principal, release capability,
publication handle, manufacturing eligibility, or write-back into canonical
zone state.

## Manifest-last materialization

`materialize_manufacturing_candidate(candidate, destination)` is a separate
publication boundary. It writes only:

- top-level `NOT_FOR_FABRICATION.txt`, included in the file manifest and ZIP;
- `derivative/filled.kicad_pcb`;
- raw and normalized DRC JSON, full filled-board semantic/copper evidence, and
  the immutable candidate-receipt JSON;
- all 18 CAM artifacts under `cam/`;
- deterministic BOM CSV/JSON under `assembly/`, when source-bound;
- source-bound BOM and authored-zone evidence under `evidence/`, when present;
- `evidence/candidate-files.json`;
- `bundle/candidate.zip`; and
- root `candidate.complete.json`, moved into place last.

The file manifest hashes every preceding candidate payload. The deterministic
ZIP contains those exact run-specific bytes plus the file manifest, using
sorted entries, a fixed 1980 timestamp, regular-file permissions, and fixed
deflate settings. It intentionally excludes the completion marker. The
completion manifest binds the file manifest, every published file, and the ZIP,
while fixing manufacturing eligibility to false.

Existing completed output is accepted only when every byte exactly reproduces
the requested candidate. Tamper, unmanaged files, recursive inventory drift,
case collisions, symlinks, special files, unsafe paths, PRL files, or a partial
prior publication without its completion marker fail closed. A crash before
the final marker leaves an intentionally non-reenterable partial directory;
the publisher never silently overlays it.

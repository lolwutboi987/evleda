# Verification, evidence, and CAM

Read this reference before claiming a design gate passed or producing fabrication outputs.

KiCad-native claims must come from the configured local KiCad installation.
EvlEDA's deterministic checks are additional guardrails and must remain labeled
separately; neither is a substitute for qualified release review.

## Evidence rules

Every check must resolve to `PASS`, `FAIL`, `NOT_RUN`, `NOT_APPLICABLE`, or `WAIVED`. Bind the result to its rule/version, severity, exact design revision, input hashes, tool identity/version, parameters, deterministic output, and worker identity. Never convert an unknown or missing result to PASS.

Keep canonical source immutable during verification:

1. inventory and hash every required project file;
2. materialize an isolated work copy from that inventory;
3. run tools only against the work copy with a pinned executable/version and controlled settings;
4. verify hashes before, between, and after checks;
5. preserve raw reports and normalized findings separately;
6. re-open generated KiCad files and compare semantic identities;
7. re-hash the canonical source and prove it did not change.

## Minimum digital gate

Run the checks relevant to the design, including:

- schema, units, identifiers, references, and design-graph invariants;
- schematic/PCB/BOM/net and pin-to-pad parity;
- power domains, electrical ratings, unconnected pins, polarity, and interface constraints;
- exact copper, clearance, edge, drill, annular-ring, courtyard, keepout, and connectivity rules;
- placement/routing hard constraints and deterministic algorithm replay;
- KiCad ERC and DRC under the pinned toolchain;
- zone-fill verification on an isolated copy, followed by DRC and source-preservation checks;
- visual review of schematic, copper, silkscreen, fabrication, assembly, and 3D outputs;
- independent export inspection when creating a CAM candidate.

If native and KiCad results disagree, fail with engine disagreement. A zero-count summary without the raw bound report is insufficient evidence.

## CAM candidate

Generate Gerber, drill, netlist/connectivity, BOM, and pick-and-place outputs only from an exact verified revision. Independently parse the exports and compare board outline, layers, drill inventory, population, reference designators, nets, and revision identity with the source. Content-address the files and write the manifest last.

Label the bundle `NON-RELEASE CANDIDATE` by default. Clean digital gates do not close fabricator/assembler review, stackup confirmation, impedance signoff, stencil review, first-article bring-up, thermal/stability/EMC/compliance testing, component substitutions, or human release approval. List those items explicitly instead of implying completion.

## Approval separation

Stage approval authorizes only the exact preview. Commit approval authorizes only the exact verified staged revision. Manufacturing release is a further decision and must never be inferred from either approval or from the user's request to export files.

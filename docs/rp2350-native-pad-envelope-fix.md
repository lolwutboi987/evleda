# Native PAD snapshot message limit

The 22 × 60 mm routing candidate `b57f5f25-f57f-4b31-b34e-96c8629875f3`
completed schematic authoring, synchronization, placement, field cleanup and the
first route batch of 32 GND vias. The next batch, 92 GND tracks and six GND vias,
failed during mandatory Save/readback because the complete PAD snapshot exceeded
the existing 2 MiB message bound. The native transaction had been pushed;
automatic `pcb_revert` then verified the exact saved preimage.

The retained PCB is 258,009 bytes, SHA-256
`20a796e45612952c20d6de22fc7272e4c153e929e0eb8a310d050b7825cbb609`,
with zero tracks and 32 vias. Normal public close subsequently failed. The
owned editor was stopped after checking its PID, start time, executable and
exact project scope; the saved PCB stayed unchanged. The remaining client was
interrupted. Recovery markers, lease and locks were preserved. None of this
establishes a normal-close checkpoint or completed routing.

## Correction and limits

DOC11 serialized the full payload twice, in text and structured content. The
[DOC12 producer](../sidecars/patches/doc12/README.md) retains it once in
`structuredContent`, with an exact versioned text selector. The host still
supports the old equal text/structured encoding. Both paths undergo the same
source, document, physical-library, raw-pad, layer-presence and connectivity
validation. The selector grants no observation authority.

The 2 MiB message bound, 1 MiB board-source bound, item limits, collection
deadline and native source checks are unchanged. Old runtimes and profiles were
not modified. DOC12 differs from DOC11 only in the reviewed producer and the
Python-home relocation. Host20 derives from frozen host19 with seven scoped
source/test/document files; existing UI output was retained unchanged.

## Verification

- 71 pad/connector observation tests passed, including complete physical-record
  equivalence and rejection of missing or contradictory compact observations.
- Five Python tests passed, including real in-memory MCP transport, exact UTF-8
  byte limits and rejection of non-finite values.
- Six focused private native snapshot transport tests passed; 171 unrelated
  tests in that file were not run.
- All 90 runtime-policy tests passed, including DOC12 source drift, partial
  lineage and unrelated-file rejection.
- All 16 isolated host build checks passed, including backend/UI type checks,
  backend emission, packaging and preserved-runtime checks.
- The installed Python producer's retained 357-pad, 34-query fixture was decoded
  by the compiled host with complete raw payload, inventory and connectivity
  equivalence. Its JSON wire size fell from 1,392,252 to 642,437 bytes.
- DOC12's 8,468-file closure and profile passed production readers and the
  before/after runtime verifier. The original DOC11 closure remained unchanged.

The installed Python module's incidental KiCad discovery attempted a connection
and reported connection refused. No live PAD capture was performed in that
offline qualification; fixture replay must not be described as live evidence.

Frozen host20 release SHA-256:
`bd22100be3616508be04cd75be8ba5a056fdfcbb71ea9a7d834563f38120aa96`.
DOC12 profile SHA-256:
`31b610c7dea012c429b03931ef4fcdf5ed2e87dac98d0f877493b6eff220f15f`.
Compiled decoder SHA-256:
`d6977cc026afb30a2b27264254f491ab4434457b41c75baac6c6dacb05c08a26`.

The live failure boundary now passes in the
[60-05 native snapshot](../designs/rp2350-pico/native-ground-routing-60-05/README.md).
Its 92 ground segments and 38 vias completed mandatory Save and exact fresh
readback, followed by native checks and normal close. The failed allocation was
not reopened or rewritten. Project `767f74fa-73dd-4d81-bb19-da5f8d138379` became a
normally closed 62-symbol unwired source; child
`b2e1adba-cf6c-4ccf-a51f-00f63320d6eb` holds the routed snapshot under the same
design contract. This verifies the snapshot fix on the real routed prefix;
full routing, plane/reference continuity and board acceptance remain unfinished.

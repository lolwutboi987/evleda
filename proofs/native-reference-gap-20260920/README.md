# Native reference-gap reporting and client delivery

The corrected checker now runs in **frozen host48 with DOC17**. The saved
[regional RP2350 candidate](../../designs/rp2350-pico/native-r1-regional/README.md)
was resumed through the public workspace, both planes refilled and saved, and
the complete acceptance report collected before normal close. All six native
sources stayed byte-identical; no placement, routing, margin or policy changed.

The [native assessment](assessment.json) is **failed/incomplete: 141 pass, 429 unknown, 2 fail;
accepted=false**. Both failed rows are the existing SWCLK_HDR and SWDIO_HDR
approaches to the debug header. Their exact stored-fill coverage gaps are now
reported even though complete plane continuity remains unproved. Other unknown
rows remain unknown. Regional contacts/area conditions remain verified, all
67 functional nets connect and configured DRC is clean.

[Qualification details](native-qualification.json) preserve every reference
result, source identity and failed row. The prior host47 assessment is historical;
its zero failed rows did not erase the separate geometric evidence.
[Software verification](software-verification.json) reuses the exact previously
qualified 110-test/source-typecheck result and records fresh frozen compilation
and helper packaging. [Client verification](client-verification.json) confirms
the installed host48 entry and 18 tools in a fresh actual Codex client. Existing
desktop connections are not claimed to have reloaded.

The physical board, earlier read-only reopen proof and its previews remain
unchanged. USB startup, reviewed connector launches, complete drilled-copper
continuity and other electrical suitability remain unresolved. This delivery
improves reporting; it does not grant fabrication or electrical acceptance.

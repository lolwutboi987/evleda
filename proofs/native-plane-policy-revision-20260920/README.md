# Native supplemental-plane policy revision

The [RP2350 candidate](../../designs/rp2350-pico/native-r1-regional/README.md)
keeps the completed R1 placement and routing while explicitly distinguishing
the continuous primary ground plane from supplemental routing-layer fill.
The new public operation, `evleda_revise_plane_regions`, creates a separate
allocation from a normally closed source and an explicit ready draft.
It preserves the old project and rejects accompanying circuit, geometry,
clearance, area-floor or routing-limit changes.

The actual native workflow created the revision, refilled and saved both planes,
collected its assessment and previews, and closed normally. A fresh read-only
reopen repeated all-net connectivity and configured ERC/DRC with all six sources
unchanged. The physical layout and both board PNGs remain identical to R1.
Every one of the ten supplemental regions has a qualified via contact to the
primary plane and a conservative retained-area bound meeting 1 mm2; the smallest
is approximately 1.024 mm2. The full assessment remains **incomplete: 141 pass,
431 unknown, zero fail; accepted=false**. Complete drill-clipped continuity,
current/width suitability, debug-header launches and USB startup remain open.

[Software verification](software-verification.json) records **320 passed,
2 skipped across 13 focused files**, source/UI typechecks, backend compilation
and helper packaging. The [test log](focused-tests.log) is from the frozen host47
build. These are scoped tests, not a new full-suite claim.
[Client verification](client-verification.json) records host47/DOC17 installation
and **18 tools in a fresh actual Codex client**, including the new operation.
Existing desktop connections are not claimed to have reloaded.

[Delivery verification](delivery-verification.json) rechecks the tested code,
original and revised native files, portable package and installed skill.
The [policy documentation](../../docs/supplemental-plane-policy.md) explains the
new intent and evidence limits. Historical R1 failures remain preserved.

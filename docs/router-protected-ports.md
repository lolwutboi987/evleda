# Router attachment at protected connector regions

An offline router can reject a connection even when the fixed lead belongs to the correct pad and its endpoint lies on the intended clearance boundary. In the [saved regression](../proofs/router-protected-ports-20260919/README.md), a 0.2 mm lead ending at x=3.56 mm stayed disconnected; extending it inward by 0.15 or 0.30 mm allowed routing. Saved/reloaded native KiCad connectivity confirmed the result.

For an exported board with protected header service strips, give each routable connector net a usable endpoint inside the board. Keep the original protected region. Treat an inward extension as proposed copper: preserve its own-pad/net/layer identity, check it against all retained copper, vias, drills, paste and applicable reference corridors, include it in route-length accounting, then perform a complete service-strip audit and native verification before adoption. A successful extension length on one fixture is not a universal value.

The RP2350 source study found that three uniform 0.30 mm extensions collided with retained geometry. Shorter, independently screened extensions were used at those ports. This does not authorize a generic net exemption, routing between header pads, or shrinking the protected strips.

Router incomplete counts remain search diagnostics. Reject an incomplete or nonconforming whole proposal; any later use of selected routes requires a new, explicit full-scene check against the actual retained board. Native save/readback, connectivity, DRC, turns and reference/plane evidence remain separate requirements.

## Reference keepout geometry

The first offline capsule export multiplied all radial samples by a circumscribing factor. That safely enclosed the requested circle, but also enlarged every straight side. With a 0.35 mm radius, the unnecessary side offset was approximately 6.857 micrometres. Comparing the current RP2350 GPIO routes against that export found 17 extra obstructions on GPIO0, GPIO14 and GPIO25_LED, despite those routes meeting the exact source reference-margin check.

[buildRouterReferenceCapsule](../src/harness/router-reference-capsule.ts) constructs vertices from adjacent circle tangents instead. After grid rounding, it proves that the entire requested capsule lies inside the convex polygon using integer half-plane calculations and squared distances. Invalid or unprovable output rejects. The caller's radius is never reduced; any construction expansion is reported. The helper neither chooses the electrical margin nor authenticates correspondence with a saved board.

The repository exporter accepts integer-nanometre capsule inputs and creates a new JSON output file without overwriting an existing file:

```sh
node --import tsx scripts/export-router-reference-capsules.ts capsules.json polygons.json
```

An input contains `gridNm` (optional, default 100) and `capsules`, each with a unique `id`, `start` and `end` objects containing `xNm`/`yNm`, and a positive `radiusNm`. Derive those values from the reviewed source and declared margin; a self-consistent JSON file alone is not source authority. Account separately for any clearance added by the target router. In this RP2350 case, the exported radius is the signal half-width plus its declared reference margin; the router retains the separate 0.15 mm plane-clearance term. Those values are case-specific. Translate the resulting vertices to the chosen router format, verify the imported representation, and retain the exact source/reference checks on all returned copper.

The [source-bound capsule proof](../proofs/router-reference-capsules-20260919/README.md) retains the input, certificates and replay. For the RP2350 study, all 129 exported regions conservatively contained their complete requested capsules. The corrected export eliminated the 17 additional obstructions without reducing a reference radius. All 129 vertex sets were independently replayed through the repository implementation and matched the actual trial input. This correction does not imply that the whole board is routable or accepted.

# Protected header-port regression

A fixed own-pad lead ending exactly on the effective router keepout boundary could not be connected by the local Freerouting adapter. Extending that same straight lead farther inward made it routable. The protected service region, pad, net, copper width and clearance were unchanged.

| Fixture | Fixed lead endpoint x | Router incompletes | Saved/reloaded KiCad pad groups |
| --- | ---: | ---: | ---: |
| Boundary port | 3.56 mm | 1 → 1 | 2 |
| Inward extension | 3.86 mm | 1 → 0 | 1 |
| Short inward extension | 3.71 mm | 1 → 0 | 1 |

The two-header fixture is 22 × 20 mm. Its left pad is at (2.11,10) mm and the other pad at (11,10) mm. The F.Cu fixed lead is 0.2 mm wide. The exported keepout ends at x=3.31 mm, with 0.15 mm router obstacle clearance; the intended protected copper band ends at x=3.46 mm. The boundary lead's inner endpoint is therefore tangent to the expanded routing obstacle. Both F.Cu and B.Cu service-band keepouts are identical across cases. Routing of the fixture net is restricted to F.Cu. Each successful case adds one straight track, confirmed connected after saving and reloading the disposable board in KiCad.

The reproduction uses Freerouting 2.4.1, the scoped Java adapter with a 100-pass ceiling and a five-second fixture time bound, and KiCad 10.0.3. These are local diagnostic fixtures; no managed project was loaded or changed. They prove this boundary-port behavior, not a completed RP2350 layout, general router completeness, DRC cleanliness or manufacturing suitability. The scripts and execution receipts retain local dependency paths and are not a standalone installer. The root router-invocation.json supplies a local toolchain template; each case execution.json records the actual five-second fixture invocation.

The [complete input comparison](header-port-input-comparison.json) verifies that all parsed DSN data are identical after excluding only the root board-name metadata and the one changed lead endpoint.

See [native results](header-port-native-control.json), [two-case control](header-port-control.json) and [short-extension control](header-port-short-control.json). Exact DSN inputs, SES outputs and saved native geometry are retained per case.

# Conservative reference-capsule export

The previous radial-sample polygon expanded straight keepout sides unnecessarily. On the current RP2350 source, that approximation added **17 obstructions** to GPIO0, GPIO14 and GPIO25_LED routes that passed the exact declared reference-clearance test. The tangent-intersection exporter reduces those extra obstructions to **zero** while retaining the entire required capsule in every case.

The input is derived from the unchanged 60-13 PCB, SHA-256 f98f02607e3af0939df8a6c6f6d3bb543a123d41c8e2937b812698e94c096f60. All **129** reference regions have an exact integer containment certificate. The repository implementation reproduces the exact vertex set used by the routing trial for each region; the CLI produces the same polygons. No declared reference radius was reduced, and no managed PCB was changed.

- [Input capsules](capsules-request.json) and [CLI output](capsules-export.json).
- [Integer containment certificate](integer-containment-certificate.json) and [repository replay](library-replay.json).
- [Previous extra obstructions](previous-export-obstructions.json) and [corrected comparison](corrected-export-obstructions.json).
- [CLI overwrite and invalid-input checks](cli-checks.json).

The helper's source and tests are [router-reference-capsule.ts](../../src/harness/router-reference-capsule.ts) and [its focused tests](../../tests/unit/router-reference-capsule.test.ts). See [workflow guidance](../../docs/router-protected-ports.md) for the command and source-authority limits.

This proves containment of caller-supplied geometric capsules. It does not authenticate the electrical margin, establish saved ground-plane continuity, repair the whole PCB, or authorize manufacturing. The corrected routing trial still left nets incomplete; its board output was not adopted. The authoritative native board remains 60-13 with 23 unconnected DRC errors.

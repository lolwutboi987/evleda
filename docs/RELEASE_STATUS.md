# Release status

EvlEDA 0.2.0 is an engineering preview. The software demonstrates a complete,
evidence-bound reference workflow; the included PCB and CAM outputs are **not
approved for production**.

## Software distribution

| Surface | Status |
| --- | --- |
| Python package / `evleda-mcp` | Source-installable preview |
| Stdio MCP protocol smoke | Passing |
| Codex plugin packaging | Included for local/repository marketplace testing |
| Claude Code plugin packaging | Included for local/repository marketplace testing |
| Published package registry | Not claimed |
| Universal/public plugin directory | Not claimed |
| General arbitrary-project MCP editing | Not implemented |

## Reference PCB

The frozen `reference-usb-c-3v3-r2` package is suitable for software and design
review. Its recorded gates include KiCad 10.0.6 ERC 0, unfilled/refilled DRC 0,
source preservation, semantic parity, visual review, 519 passing tests, and a
validated 18-file CAM candidate. See the
[exact verification receipt](../examples/reference_usb_c_3v3_r2/FINAL_VERIFICATION.md).

These results establish that the supported design is internally consistent and
that the named KiCad version accepted the checked copy. They do not establish
production fitness, regulatory compliance, assembly yield, or safe operation in
an end product.

## Open hardware qualification

Before any production order, a qualified reviewer must close at least:

- board-specific regulator/protection-device thermal measurements;
- full-temperature output-capacitor ESR/capacitance and LDO stability/transient
  testing;
- loaded startup, brownout, repeated-enable, and connector-bounce tests;
- the J2 output-only/reverse-drive policy and physical marking;
- USB Type-C, ESD, EMC, and end-product compliance requirements;
- fabricator stackup, drill tolerance, finish, and capability approval;
- stencil apertures, exposed-pad voiding, USB shell stake process, and assembly
  house approval;
- exact procurement/lifecycle evidence for the intended build quantity;
- assembled first-article inspection and functional test;
- explicit human design, manufacturing, and release approvals bound to the
  exact released artifact.

The detailed source-package blockers remain authoritative and are intentionally
not converted into warnings merely because ERC/DRC passed.

## Handling outputs

- Treat `examples/reference_usb_c_3v3_r2/` as a reviewable working example.
- Treat `evleda-reference-usb-c-3v3-r2-source.zip` in that directory as the
  sealed source package.
- Open a disposable copy in KiCad; do not let `.kicad_prl`, backups, or filled
  zones modify the sealed archive.
- Treat `evleda-reference-usb-c-3v3-r2-cam-candidate.zip` in that directory as
  a non-release manufacturing candidate only.
- Preserve manifests and hashes when moving evidence between systems.

## Promotion rule

No model, MCP tool, test suite, compiler, KiCad ERC/DRC result, or CAM generator
may promote the board to released by itself. Promotion requires the complete
qualification evidence and an explicit authorized human/contract-manufacturer
decision over the exact candidate digest.

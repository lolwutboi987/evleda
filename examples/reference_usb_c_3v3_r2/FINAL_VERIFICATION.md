# USB-C 5 V to 3.3 V R2 final verification

This receipt covers the current deterministic EvlEDA reference/prototype package. It does not
authorize a manufacturing release.

## Frozen source identity

- Design: `reference-usb-c-3v3-r2`
- Graph: `4b4e91e04078276aecd6e9d4f084871c49377c59d5c7a53edb714a96c6c228ee`
- Revision: `209cc052da07cc27cf79c367547cff5b414b28d30972ca9985e3bed5a4722edd`
- Artifact: `919d4d87471e1d419e57d891c8c15f17edc0797b77cde668d7427fa39752a3ec`
- Audit: `62b2da003195e305bf384bdbb66bf109985fb3fec84c7333383f5a2f87d6a948`
- Compiler manifest: `83fdb345267fc1b1d08d5e207545916b53091b7eada859e63c89bce88b424bad`
- Compiler bundle: `97bbfcdfff2ba7fc08100f104209a0f3041a81ce0248f1970686f9b0314764d4`
- Compiler reparse: `da52117c1b07271d0e866320aa2aaa07a1cc2af6b375f1dbb685c409cf962b4e`
- PCB: `2b411e429a4807f8f5cd9e5e5900365505017e03e2f14bfd0135f9ea61c7a19e`
- Schematic: `d66c3d3fab64d97da7b08581a03ed7e33d9dab86ea0115e8434bf914cf599990`
- Package manifest: `67297e17d5ba5f4049b2b64c0f3742f1dcc59c2e330931d73f8ce2e6d06d42b2`
- Publication manifest: `6b91847389b197d9e3cd9bc5ffd13f1cee829bb8ef7c6ae1fb1286c8f57c2c17`
- Source ZIP: `d5173c8229d5f8e2a98c415b8f126a4cd4c03758f9100322c516703716b3397b`
- Packaged legal manifest: `6cfffbbbebb692689f99303239b1fa0f31c76db52673f47022424a7ace3f7db5`

The source ZIP contains 42 regular, CRC-verified members. Its nested package and compiler
manifests bind exactly 29 compiler-owned KiCad source files. Five additional, exact legal
resources are present under `legal/`.

## Native KiCad gates

- KiCad CLI: 10.0.6.
- ERC: 0 violations; raw report `erc.json`, SHA-256
  `6c4e0a279c24d4a0b15a033ba798d93414f0b16368a8c312827abcb90edc91c9`.
- Unfilled/no-save DRC: 0 violations, 0 unconnected items, 0 schematic-parity issues; raw report
  `drc_unfilled.json`, SHA-256
  `4ff1484ad1e65f11bef426b38d79edbe531b279b1de0c343815cc5c95fe30f59`.
- Refill/no-save DRC: 0 violations, 0 unconnected items, 0 schematic-parity issues; raw report
  `drc_refill_no_save.json`, SHA-256
  `5d829d056717ba3e3fcb67d3a8555dc93a2e32dfe27d5d2b283425b1fdb6929c`.
- All 29 compiler-owned source files retained their exact manifest hashes after native execution.

KiCad reported its standard ignored ERC keys `single_global_label`, `four_way_junction`,
`simulation_model_issue`, and `footprint_filter`. Both DRC runs reported the standard ignored
keys `missing_courtyard`, `track_not_centered_on_via`, `tuning_profile_track_geometries`,
`footprint_filters_mismatch`, and `footprint_type_mismatch`. These ignored-key inventories are
disclosed rather than represented as executed checks.

## CAM candidate

- Candidate: `97e015d6468b9259581b83bf582b39987b632ba3fd4c657bfc64a4f48545c34f`
- Candidate receipt: `632a278de5c1e183766978978385aa2e0e5b2c9b55a637385afd2a934ebd30fd`
- Candidate file manifest: `4ccd6de49658539a929408f05b16b3ac9e6f5249820779f28e919b678f9422a6`
- Generation completion manifest: `0559ea8d26df7e6dc426f9b0bb3772a6c47ed60a0d898a8f18bf08996e87de02`
- Candidate ZIP: `511b0b1f752239b7bfd63cdf9b2f790fd933269aaf695521c5164d2178fd79c0`
- Top-level `NOT_FOR_FABRICATION.txt`: 618 bytes, SHA-256
  `f9b0f5fbbcd28b3620197d4abbfdd930dcecd9f4ea42581d2145c422f1a86958`.
- 18 validated CAM artifacts and 23 BOM lines.
- Filled-board raw hash: `b6abb00dfd111f53c6ecfe8c471e32d6527555278c5243dee043ee9015cd60db`.
- Filled-board semantic hash: `3ad80030018fd948b80b36da29aa99a52d8ce49e518da0386db38a6417e0cb18`.
- Filled-copper geometry hash: `caded21d9c9fca8c844f9054b8b43155b16d53ce406218741a8d3302030070f1`.
- One authored B.Cu GND zone remained identity-equal through fill; CAM DRC findings: 0.
- The 34-member candidate ZIP binds its warning, receipt, complete file inventory, and five legal
  resources. `manufacturing_release_eligible` remains `false` everywhere.

## Qualification still required

Before ordering production quantities, close the detailed blockers in the source package README.
They include board-specific U1/U2 thermal evidence, full-temperature C2/C3 and LDO-stability
testing, a single approved stencil/assembly process, output reverse-drive policy, fabricator
stackup/drill approval, USB/ESD/end-product testing, retained source/procurement evidence, and
explicit human/CM release approval.

J2 is output-only: `3V3 OUT 100mA MAX / DO NOT APPLY POWER`.

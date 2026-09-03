# EvlEDA USB-C 3.3 V reference board

This is the byte-exact, validated R2 reference output used by EvlEDA's end-to-end tests.

- `evleda-reference-usb-c-3v3-r2-source.zip` contains the deterministic KiCad source package.
- `evleda-reference-usb-c-3v3-r2-cam-candidate.zip` contains a filled-board derivative, Gerbers, drill files, positions, IPC-2581, IPC-D-356, BOM, DRC, and evidence receipts.
- `preview.png` is the reviewed KiCad 10.0.6 top render.
- `release-assets.json` binds the exact filenames, sizes, and SHA-256 digests.
- Both standalone archives contain an exact, manifest-bound `legal/` inventory with the applicable CERN-OHL-P-2.0 licence, NOTICE, third-party notices, CC-BY-SA-4.0 text, and the upstream KiCad Libraries notice/exception/warranty text.
- `erc.json`, `drc_unfilled.json`, and `drc_refill_no_save.json` are the raw KiCad reports bound by `FINAL_VERIFICATION.md`.

The design passed KiCad ERC and DRC with zero findings, but it is deliberately marked `manufacturing_release_eligible: false`. Physical thermal, stability, ESD, assembly-process, fabricator, and release-approval work remains.

J2 is output-only: `3V3 OUT 100mA MAX / DO NOT APPLY POWER`.

The frozen source and CAM archives contain legacy evidence namespaces including `FluxGenerated`, `FluxHuman`, `.flux-compile.json`, and `flux-clone-*` schema/hash-domain identifiers. They are compatibility IDs from compiler v4, not the public product name; changing them would invalidate the published hashes. EvlEDA is not affiliated with or endorsed by the KiCad project.

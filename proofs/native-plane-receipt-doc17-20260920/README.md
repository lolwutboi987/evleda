# Complete native RP2350 refill receipts

DOC17 fixes a bounded reporting-capacity problem encountered after the full
RP2350 routing and labels were saved. The complete transcript now permits one
million logical nodes while retaining the 500,000-node compact-wire limit,
8 MiB artifact limit, depth 64, source/pool bounds and all native/source checks.

Two actual native fills now exceed the old logical limit and succeed:

| Plane | Logical nodes | Compact bytes | Mandatory save/readback |
| --- | ---: | ---: | --- |
| GND_PLANE, In1.Cu | 507,323 | 6,774,765 | Verified |
| BACK_GND, In2.Cu | 509,255 | 6,118,484 | Verified |

[Native qualification](native-qualification.json) retains complete-stage hashes,
receipt identities and separate save results. The original failed stage,
quarantine and source remain preserved. A qualified recovery copied the saved
candidate into a new allocation under the exact DOC16-to-DOC17 runtime-only
upgrade. It did not edit the old checkpoint, adopt the uncertain unsaved fill,
or change the authenticated design bundle. The original failure's most specific
cause had been lost; the modeled resource fixture is not a reconstruction of it.

The host now captures a bounded private first-failure diagnostic before recovery
reads. Failure to publish that diagnostic does not replace the primary fault or
clear edit quarantine. Recovery verification rejects changed design policy,
wrong runtime overlay, non-fill live edits, source/text mismatches and unproven
discard/exit evidence.

[Software verification](software-verification.json) covers 250 passed and two
skipped tests in ten focused files, source/UI typechecks, backend build and native
helper packaging. Current implementation/test source pins matched the frozen
host43 release. This is not a new full-suite result. The separate Python encoder
tests and modeled fixture remain software evidence, distinct from the actual
native records above.

[Client verification](client-verification.json) records the existing Codex
workspace entry advanced to host43/DOC17 with other configuration and the skill
unchanged. A fresh actual Codex client discovers 17 tools; cached desktop
connections are not claimed to have refreshed.

The resulting [native R1 candidate](../../designs/rp2350-pico/native-r1/README.md)
has all 67 nets connected and completes close/reopen with unchanged sources.
Its engineering assessment still has two failed and 429 unknown rows. Receipt
capacity and persistence fixes do not waive plane, thermal, reference, impedance
or other electrical requirements.

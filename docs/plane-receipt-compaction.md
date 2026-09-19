# Lossless native plane receipts

The subsequent RP2350 trial exposed a second duplication point inside the host
PAD adapter. The host24 fix and source-preserving recovery are documented in
[unchanged plane-session recovery](unchanged-plane-session-recovery.md). The
small DOC14 fixture proof below retains its original scope.

Large routed boards repeat substantial data in a plane-stage receipt: several
complete PCB serializations, a full physical-pad inventory, and each individual
PAD-connectivity response. The RP2350 capacity estimate exceeded the existing
8 MiB artifact limit before a plane operation was attempted.

The V2 receipt stores each exact PCB string once and interns complete native PAD
Any records from the ordered RPC transcript. References replace only defined
source and PAD slots. Different versions of the same PAD UUID remain distinct.
The host rejects malformed, duplicate and unused pool entries, resolves immutable
references, then runs the same source, geometry, native-call order and complete
physical-pad checks used for legacy V1. Canonical receipt identities distinguish
the two encodings.

The artifact limit remains 8 MiB; each source remains limited to 1 MiB. Both
encoded and logical traversal retain 500,000 nodes and depth 64. Source pools
contain at most 16 entries, source references at most 32, and PAD pools at most
4096 entries. This is lossless storage, not record truncation or a larger cap.
All native operations, source fences, mandatory Save/readback and recovery
requirements remain in force. A compact receipt does not itself prove a valid
plane, return path, ampacity or manufactured board.

## Native mapping correction

The first DOC13 live fixture failed before save. Native protobuf PAD Any records
were `OrderedDict` instances; an exact-`dict` test skipped them. The host rejected
the inline PADs and quarantined the session. The saved eight-track/one-via board
remained unchanged. Its unsaved plane source and complete failed receipt were
retained. Native close waited at a Save Changes dialog; the isolated unsaved
stage was discarded after preservation, and the editor closed. Its lease and
unsafe marker remain, and it is not a normal resumable checkpoint.

[DOC14](../sidecars/patches/doc14/README.md) corrects mapping-subclass handling
for both interning and logical work counting. It replaces one file in a new
pinned runtime. DOC13 and the failed fixture remain preserved. The host decoder
required no relaxation or repair: rejecting that malformed receipt was correct.

## Verification scope

- Four focused host suites: 124 passed, two historical external-native replays
  skipped because their old-machine paths are absent.
- Runtime lineage and CI diagnostic suites: 104 passed, including partial/mixed
  runtime rejection and the requirement to verify the actual runtime tree.
- Python DOC14 suite: nine passed, including native ordered mappings and their
  logical work budget.
- Source/UI typechecks and the isolated host23 backend build passed. UI output
  was reused unchanged; the full repository suite was not rerun.
- The reconstructed complete failed native stage round-trips exactly through
  the corrected producer and validates through the full host adapter. Its
  compact representation is 178,961 bytes versus 377,013 expanded bytes. This
  offline replay grants no live mutation or saved-fill authority.

The [live DOC14 proof](../proofs/native-compact-plane-20260919/README.md) now
passes native CREATE and UPDATE, mandatory save/readback and normal close.
UPDATE saves with identical resulting PCB bytes. All three fixture nets are
connected; configured ERC/DRC and visual QA report zero findings, and five
measured turns have no flags. The separate VIN reference-ribbon check fails at
a round drill bore and other mandatory rows remain unknown; fixture acceptance
is false. The first failed DOC13 allocation remains quarantined.

A synthetic production-encoder exercise with 64 individual 64-PAD replies,
51 SMD / 13 PTH samples and four distinct source strings shrinks 10,940,135 bytes
to 1,977,594 bytes while retaining the logical work bound. Its source geometry
and ownership are deliberately not a valid native board. The RP2350 remains
the published 60-09 checkpoint with no ground fill; its routing, USB placement,
junction, electrical and DFM findings remain open.

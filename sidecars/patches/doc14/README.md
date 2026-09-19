# DOC14 native protobuf mapping correction

The first live DOC13 plane stage returned native protobuf PAD Any values as
`collections.OrderedDict`. Its encoder recognized only exact `dict` instances,
so it left the PADs inline. The host rejected the receipt, entered recovery and
did not save the staged plane. The failed allocation and runtime are preserved.

DOC14 replaces only `evleda_plane_stage/compact_receipt.py` on the complete
DOC13 runtime. Mapping/list subclasses participate in logical work counting,
and native ordered PAD mappings participate in exact-content interning. All
other collection, stage, artifact, host validation and size policies remain
unchanged. The receipt schema stays V2; this repairs its producer.

The isolated Python regression includes all seven DOC13 tests, native-shaped
ordered PAD records and an ordered-mapping work-amplification case. JSON-only
replay was insufficient to expose this type distinction. Live qualification
must use a new allocation; never retry the quarantined DOC13 editing session.

The [new native fixture](../../../proofs/native-compact-plane-20260919/README.md)
passes creation, refill, mandatory save/readback and normal close. That scoped
result preserves the fixture's failed reference-ribbon row and unknown physical
acceptance rows. It does not establish RP2350 plane behavior.

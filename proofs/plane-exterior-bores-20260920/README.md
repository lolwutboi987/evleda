# Exterior bore classification: source qualified, native check pending

The reader can prove a circular or cardinal slotted bore wholly outside a
plane's simple outer boundary even when its conservative rectangular enclosure
overlaps the boundary. Exact whole-shape separation is required; exterior
tangency and intrusion remain unknown. No clearance or layout rule changes.

[229 tests across five affected files](verification.json), source typecheck and
backend compilation pass. [Static replay](static-replay.json) against the prior
hash-verified native geometry finds all four RP2350 mounting-hole circles outside
the primary plane with strict boundary separation. Replay does not renew native
fill authority or establish a new board acceptance result.

Frozen host54 reached a [catalog-loading verification deadline](failed-native-startup.json)
before the checker ran. Cleanup was unconfirmed, and its allocation/lease is
preserved. Host54 was not installed. A subsequent
[restoration client ended before normal target close](interrupted-restoration.json);
that allocation is also preserved. Neither is a passing native qualification.

The installed host53 workflow has now [restored a normally closed managed copy](managed-restoration.json),
project **7e129f34-8a45-454c-b8dd-cf06b770ba74**, with all six native files byte-identical to the
published candidate. Existing failed allocations, leases and sources are unchanged.
This uses the existing public source-preserving revision; no old acceptance or
live fill authority transfers. The portable KiCad board remains unchanged.

The exterior-bore change remains source-qualified and pending fresh native
assessment. USB startup/inrush and complete electrical review remain unresolved.
The installed build is still host53/DOC17.

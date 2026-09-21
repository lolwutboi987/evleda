# Startup guard diagnostics

Some startup failures reached the saved diagnostic with a stage and error category
but no identifier for the rejecting check. Future reports can now retain a bounded
chain of host-selected guard identifiers, such as `runtime-file-manifest` followed
by `runtime-tree`, or `directory-binding-changed` followed by `ipc-listener`.

The chain is process-private until captured into the existing diagnostic. It holds
at most four distinct identifiers, innermost first. The implementation does not
read error messages, stacks, cause graphs or arbitrary guard properties. It keeps
the original thrown value and preserves separately recorded primary and cleanup
failures. Untagged reports retain their previous shape. No runtime check, deadline,
ownership requirement, four-reader limit or recovery rule is relaxed.

[Verification](verification.json): 217 tests passed across the complete KiCad MCP
integration file and the two startup/host unit files. They include real filesystem
tampering, directory replacement and socket collision; guarded failure publication;
privacy against spoofed properties, getters and proxies; bounded artifact readback;
and the existing cancellation, deadline and cleanup cases. The actual configured
DOC17 runtime was verified without a new KiCad board session. Source typecheck,
backend TypeScript compilation and the source-adjacent emit guard also passed.

This is source-level qualification. The installed host50/DOC17 release is unchanged;
no new frozen host or real-editor qualification was performed. The earlier host51
failure remains unresolved evidence: these identifiers cannot recover information
that its old diagnostic never recorded. RP2350 native files and electrical-review
status are unchanged. This is not a full-suite or whole-product completion claim.

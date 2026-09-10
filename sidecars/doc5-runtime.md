# DOC5: native Commit-handle lifecycle repair

DOC5 is a separate immutable copy of DOC4. The exact runtime delta is the
transaction lifecycle service, its three existing tools' qualification marker,
and pyvenv home relocation. Launcher, native writers, plane/PAD addons, Python and
prior runtimes/manifests are unchanged. Portable source/patch/provenance lives in
`patches/doc5/`; apply only to the recorded DOC4 base and verify the manifest.

The old installed service discarded `Board.begin_commit()`'s Commit and called
push/drop without it. An actual-service/actual-KiPy offline reproduction confirms
the missing-argument defect, but does not establish the lost primary add-track
versus push error from the public proof.

The service now retains the same Commit object/ID plus copied DocumentSpecifier
and native socket/client-name/token identity. Expected five-second client-wrapper
refreshes are supported, including first-reply token learning; genuine identity
or document changes reject. All operations remain in the existing mutation queue.
Unknown Begin/End outcomes are not automatically retried. Failed/pending handles
remain for checked recovery; only acknowledged push/drop clears group state.
Caller-guarded revert does not invent an End acknowledgement. Known tokens are
redacted before bounded error output, with generic detail before verified binding.

Existing begin/push/drop signatures, output contracts, annotations and positive
ACK text remain unchanged. The added qualification marker is
`_meta.evledaNativeCommitLifecycle = evleda.kicad-native-commit-lifecycle.v1`.
Host qualification requires all three markers; DOC4 names alone do not qualify.

21 typed offline tests and independent review pass, using actual KiPy Board,
Commit, protobuf, mutation queue, KiCadSession TTL and in-memory native envelopes.
The candidate's installed suite passes the same test bodies. No native/editor/
model test or default-profile change is implied by publication. Sticky host
quarantine, checked recovery and mandatory save/readback remain separate gates.

Evidence: `D:\EvlEDA-doc5-transaction-runtime-build-20260909`. Native identity basis:
[pinned API_HANDLER_EDITOR](https://raw.githubusercontent.com/KiCad/kicad-source-mirror/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/common/api/api_handler_editor.cpp),
whose commit ownership uses ClientName and validates the commit ID.

# Recovering the unchanged checkpoint after a plane-envelope rejection

The first RP2350 DOC14 trial exposed an additional host-adapter error: the plane
validator reconstructed a legacy full-text PAD envelope from an otherwise valid
compact stage. Its 1,365,308-byte text field exceeded the existing 1 MiB string
bound; the duplicated envelope was 2,956,816 bytes. The existing compact PAD
selector reduces that envelope to 1,365,563 bytes with all 281 physical pads and
64 individual ground queries. The corrected adapter passes complete replay of
the captured stage. No size or work cap was increased.

The failed stage was not saved. Its full 426,939-byte staged PCB source and
3,645,999-byte receipt were preserved. The owned Save Changes dialog was closed
by discarding that retained unsaved stage. All six saved KiCad files and the
prior normal-close checkpoint remained byte-identical. The failure's lease and
unsafe marker still prevented ordinary resume.

`scripts/recover-unchanged-plane-session.ts` handles only this recorded failure
class. Inspection writes nothing and produces an identity-bound plan. Apply:

- Requires the exact reviewed plan and explicit maintenance exclusion.
- Rechecks process quiescence, the prior normal-close chain, request/response
  lineage, complete native stage, current source/checkpoint bytes and physical
  file identities.
- Refuses changed PCB/schematic/rules/tables, another failure class, an
  unreviewed lock, insufficient disk reserve, stale evidence or an active host.
- Durably archives all bound evidence before moving the exact unsafe marker
  and lease into that exclusive archive. The lease moves last.
- Never rewrites a native source, baseline, checkpoint or report, and never
  claims a normal native close, saved plane, electrical approval or fabrication
  authorization. Partial failure retains the archive and remaining quarantine;
  it must be reviewed before any further recovery action.

This is a separate offline operation. It is not a general marker clearer,
PID-based lease takeover, repair of changed geometry, or permission to use a
failed editing session again. The previous rollback utility remains restricted
to its existing failure classes.

The CLI accepts a pinned JSON request for inspection:

```text
node --import tsx scripts/recover-unchanged-plane-session.ts --input REQUEST.json --sha256 SHA256 --bytes N
```

Apply accepts the resulting pinned plan instead of the request and additionally
requires `--apply --maintenance-confirmed`. Maintenance means all activity in
the target workspace and competing recovery attempts are excluded throughout
the operation. Never use apply while the owning host or editor is alive.

Thirteen focused filesystem tests cover successful preservation, changed
sources/checkpoints, native-save contradictions, another error, missing prior
close, foreign locks, hard links, stale plans, missing maintenance confirmation,
mid-archive changes, a new quarantine artifact before lease retirement, active
processes and disk reserve. Source typechecking passed. The host24 plane/PAD
build passed 165 tests with two old-machine replay skips.

The RP2350 operation archived the exact failed-session metadata and released the
unchanged checkpoint. Its PCB remains SHA-256
`549e054104125fc48c5d1417e9d6ea948c81f1a3bcfda1e4e2b04bc9161afa8b`;
the checkpoint remains
`f1405017b10462b2cdeca52a80fa847a1f3ada0483301c7df818b792dc59b077`.
The subsequent [60-10 native session](../designs/rp2350-pico/native-ground-plane-60-10/README.md)
resumed those unchanged sources, applied and saved the plane through host24,
collected native checks/previews and closed normally. Recovery itself did not
save or accept the plane. Ground connectivity and other design findings remain
open in that later snapshot.

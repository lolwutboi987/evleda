# DOC3: combined private native-read and schematic-batch addons

The new `inspection-runtime-3.33.3-doc3` is a separate copy of immutable DOC2.
Its manifest is `kicad-inspection-runtime-manifest-doc3.json`. Original, DOC1 and
DOC2 runtimes/manifests, production profiles and package defaults are preserved.

Exact runtime delta from DOC2:

- add reviewed `evleda_live_pcb_pad_snapshot.py` unchanged;
- add reviewed `evleda_schematic_connectivity_batch.py` unchanged;
- extend only the launcher import/install sequence: existing live-document addon,
  then PAD snapshot, then connectivity batch;
- relocate `environment/pyvenv.cfg` home to DOC3's Python directory.

No upstream package file, interpreter, private document addon, process terminator,
published wheel metadata, pad-net writer or schematic normalization helper changes.
Versioned addon source/protocol copies and the mechanical delta/provenance are in
`patches/doc3/`; the versioned launcher source is `kicad-inspection-launcher-doc3.py`.

## Private PAD snapshot

`evleda_get_live_pcb_pad_snapshot` is READ/KICAD_IPC. It requires exact native PCB
document/source observations and retains the complete raw physical PAD table,
independent footprint ownership, native enabled-copper/presence data, and original
single-source PAD-filtered requests with complete ordered response indexes. Unknown
presence is explicit, never false; duplicate response indexes remain visible.
Metadata drift, partial status/filters, missing coverage, source drift and result
overflow fail closed without truncation or file/config fallback. Empty selection
is inventory-only, not connectivity proof. Repeated observations are not an atomic
lock and do not prove high-frequency behavior or logical terminal correctness.

Its existing 10-second/2-MiB-minus-envelope bound and 1-MiB source bound remain.
Physical numbered thermal counts remain71/91; no metric or writer is redefined.

## Private complete connectivity append

`sch_apply_connectivity_batch_v1` is WRITE/files only and is advertised only in
write mode. It validates the exact project/schematic, before-source identity,
complete primitive arrays and normalization version, builds with unchanged DOC2
helpers, predicts and checks their one normalization, enters the existing atomic
writer once, and verifies exact post-write bytes. It preserves unrelated source.
Unsupported inputs reject before writing. A write/readback failure is terminal
and requires host rollback/session close; no misleading success receipt is issued.
It makes no GUI reload request and returns reload not_requested/confirmed:false.
This is not a manufacturing or interactive editor operation.

Both tools retain the reviewed exact private schemas and annotations. The MCP
compatibility pre-parser cannot coerce JSON strings into their array inputs. The
batch's `doc2-complete-plan-v1` normalization version names the unchanged writer
contract, not the filesystem directory of its import. No public tool/default
profile or package script is changed by this runtime creation.

## Verification and qualification boundary

Both modules passed independent staging reviews. Installed-runtime offline suites
pass21 snapshot and33 batch tests. Reviewed test bodies are AST-identical; only
the scratch/import bootstrap points at DOC3. The combined installed launcher
validation/import/install and actual FastMCP registrations were exercised in
readonly/write mode, comparing both input/output schemas and annotations with
the host session protocol fixtures. Base server factory, mode configuration and
stdio callback are test fixtures; no stdio server or native client is started.

All runtime metadata truthfully keeps tested_kicad_versions empty. Existing closed
native feasibility evidence is not relabeled as a live test of these new modules.
No GUI, native KiCad, model, or manufacturing operation occurs during packaging.
Native enablement and host semantic integration/review are separate future gates.

Full physical closure verification and exact DOC2→DOC3 delta evidence are retained
at `D:\EvlEDA-doc3-runtime-build-20260909`. No test fixtures, caches or bytecode are
shipped inside DOC3. All task subprocesses are reaped before the final handoff.

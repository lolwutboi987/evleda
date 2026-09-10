# KiCad reuse architecture

## Recommendation and evidence boundary

Build the design toolbox around native KiCad documents, KiCad's existing checking and export engines, the installed MCP implementation, and a curated set of design skills. The custom layer should bind the correct document, record engineering intent, orchestrate bounded edits, and verify the resulting artifacts. It should not become another schematic model, PCB geometry engine, DRC implementation, or general autorouter.

This is an architectural recommendation based on primary documentation and source inspection on September 9, 2026. It is not a report of locally successful design operations. No board editing, downloaded installation instructions, runtime changes, or native UI operations were performed for this memo. Existing files and tools should be preserved while reuse candidates are qualified.

There are three different evidence levels throughout this report: native capability documented by KiCad; implementation observed in a specified source version; and operational capability proven on the intended local runtime. The first two support a reuse decision. They do not substitute for the third.

## Version baseline

| Component | Evidence inspected | Consequence |
|---|---|---|
| KiCad target | 10.0.3 source tag resolves to commit `146a4f2a7585c65bc580427a19b6fe2ec4a3f622` | Use this target for compatibility claims; do not assume later APIs. |
| KiCad `/10.0` CLI manual | Identifies 10.0.5, documentation revision `a77c36a3` at access | Its URL denotes a moving release series, not an exact 10.0.3 contract. |
| Official Python package | Locally installed `kicad-python` 0.7.1, imported as `kipy` | Binding availability does not prove the connected KiCad implements every method. |
| MCP | Local distribution metadata says `kicad-mcp-pro` 3.33.3; upstream tag `mcp-server-v3.33.3` resolves to `601d1831c6e5991805021147128c2c969f6fd7ce` | Pin both upstream package and local patches. |
| Local MCP variant | `inspection-runtime-3.33.3-doc3`; schematic source differs from upstream | Do not describe this as an unmodified distribution. |
| MCP current upstream | Repository README identified 3.34.1 at access | Current README behavior and profiles cannot automatically be assigned to 3.33.3. |
| KiStack | Commit `5a11d7d0779a014876ed4e3175654750fad360fa` | Review and pin individual skill files and their references. |

The installed `tools/pcb.py`, `tools/routing.py`, and `utils/field_solver.py` matched the pinned 3.33.3 upstream source after normalizing line endings. `tools/schematic.py` did not: the local copy contains field-layout and connectivity changes. Its local behavior is cited separately below. This comparison covers these four files, not the entire installation.[1–5]

KiCad 9 and 10 IPC requires a running GUI instance. Official add-on documentation assigns headless IPC and IPC exports to KiCad 11. Use CLI for headless checks and export on 10.0.3; do not design a 10.0.3 server around `kicad-cli api-server`. The Python documentation also marks design-rule IPC getters/setters as KiCad 11 features. A method existing in Python 0.7.1 is therefore insufficient evidence that it can run on 10.0.3.[6–7]

## What KiStack actually contributes

KiStack is primarily a collection of human-authored agent instructions. Its inspected tree includes schematic, layout, PCB review, footprint, symbol, BOM, export, Gerber review, panelization, and product-render skills. It is not itself an MCP server or a replacement EDA engine. The export skill also supplies executable support: a CSV position converter. Its references are CLI command documentation, and several skills refer to separately installed tools.[5,8–12]

The strongest reusable ideas are datasheet-backed symbol and pin checking; checking logical connectivity through exported netlists; visually reviewing schematic and PCB crops; checking existing footprints before generating new ones; using the official library tooling where a generator exists; and keeping fabrication exports reproducible. These practices belong in the design workflow, while executable tools supply the actual reads and edits.[8–12]

Do not import every instruction as a product requirement. The layout skill permits broad placement revisions and schematic pin swaps; those are engineering decisions that need a preserved functional contract and pin-function evidence. They do not authorize mass deletion. Its claims about named models are author guidance, not comparative benchmark evidence. Presentation preferences such as default single-sheet layout and label-heavy wiring should become project defaults that can be overridden, rather than universal correctness rules.[8–9]

The footprint skill points to the official KiCad Library Tools project; that project's current README explains that older library utilities are being merged and identifies separate generators and checking scripts. A skill that says to generate a footprint still requires those programs, supported package definitions, and manufacturer dimensional evidence. It does not create a general footprint generator merely by being installed.[10,13]

The position converter is a concrete, small adapter worth evaluating. It reads KiCad CSV fields `Ref`, `PosX`, `PosY`, `Rot`, `Side` and writes five assembly fields. It maps any side other than `top` or `front` to bottom, so qualification should include unexpected values. Its source does not establish manufacturer-specific rotation correctness for every footprint. Treat format conversion and assembly orientation validation as separate checks; verify the selected manufacturer's current upload contract before reuse.[12]

## Function allocation

| Required function | Reusable native/MCP mechanism | Skill or model responsibility | Small adapter or genuine gap |
|---|---|---|---|
| Requirements and topology | Native project plus MCP design-intent facilities | Derive topology, constraints and choices from requested function and component documentation | Small intent record with units, provenance, and unresolved choices; no alternate circuit engine. |
| Schematic symbols, wires, labels, fields | Installed MCP uses `kicad-sch-api` and file mutation; separate connectivity and symbol tools exist | Pin assignments, reference circuits, symbol readability, power domains | Document-bound transaction and reload/readback adapter; native schematic IPC is incomplete on target. |
| Schematic connectivity | KiCad netlist export and ERC; installed connectivity helpers | Compare intended node membership against actual netlist and datasheets | Small invariant comparison around exported native connectivity. |
| Schematic-to-PCB transfer | Native KiCad update workflow; MCP `pcb_sync_from_schematic` | Footprint assignment and pin-to-pad agreement | Existing MCP sync is initial file-based bring-up, not evidence of full native ECO parity. |
| Footprint placement and rotation | IPC footprint item updates; MCP placement, move, alignment and grouping tools | Board interfaces, placement order, decoupling, return paths, mechanical constraints | Snapshot/readback and keepout-aware bounded operations; native tool presence is not placement quality. |
| Ordinary tracks | MCP `pcb_add_track`, `pcb_route_trace`, bulk track creation through IPC | Select corridors and connection order | Segment primitives exist; automatic obstacle-aware routing is a separate capability. |
| 45-degree routing | KiCad interactive router supports H/V/45; IPC permits track geometry | Route strategy and local visual review | A small waypoint converter/checker can create H/V/45 segments; this does not reproduce native shove routing. |
| Vias and widths | Native tracks/vias and net classes; MCP via constructors and rule writers | Choose fabrication-compatible dimensions and current/thermal constraints | Verify actual copper dimensions, layer span and named-net assignment after edit. |
| Copper planes and pours | Native zone objects and refill; MCP polygon zone creation sets net, clearance and thermal settings | Reference-plane continuity, return current, stitching, island review | Native fill and DRC should remain authoritative; a filled zone is not proof of a good return path. |
| USB and differential pairs | Native interactive pair router/tuners; MCP rule writers and length reports | Interface generation, reference design, stackup, skew and coupling requirements | MCP pair/tuning names do not imply automatic coupled geometry or serpentine creation. |
| Controlled impedance | KiCad stackup/routing constraints; MCP closed-form calculations | Provide fabrication stackup and justified target/tolerance | Real field-solver integration is absent in inspected MCP; use separate validated analysis when needed. |
| ERC and DRC | Native CLI checks and MCP wrappers | Interpret intentional exceptions and missing functional checks | Small artifact/status wrapper; do not rebuild the checking engines. |
| Renders and exports | Native CLI schematic/PCB plots, 3D renders, Gerber, drill, placement and BOM exports | Review cropped images and assembly/fabrication outputs | Reproducible export manifest and optional format conversion. |
| Footprints and 3D models | Existing libraries, native editors and official generators; MCP library tools | Datasheet land pattern, pin-one orientation, body/courtyard and fit | Small package-specific generator input when supported; unusual geometry may require an additional generator. |

This allocation is supported by the actual MCP implementation and official KiCad interfaces, not by aggregate tool counts.[2–3,6–16]

## Schematic editing and document identity

The 10.0.3 schematic command protobuf is empty. Its C++ schematic handler registers document enumeration, contains partial item handling, and leaves deletion and document-item retrieval as TODOs. This is evidence of an incomplete schematic API, not evidence that KiCad can never support schematic automation. It explains why the installed MCP's default schematic backend is a separate file-manipulation library rather than a complete native schematic IPC editor.[14]

The local `_reload_schematic_via_ipc` function in `tools/schematic.py:5642` selects the first enumerated schematic, attempts a `RevertDocument` command, and explicitly says that GUI reload is not confirmed. Error paths report a file update with a manual reload needed. Thus a successful file edit cannot be represented as a verified live-editor edit. This exact wording belongs to the locally inspected variant.[4]

The adapter should resolve the requested project and exact document before mutation, distinguish saved disk state from unsaved GUI state, group edits into recoverable units, and validate the saved result by reopening or native export. If live schematic reload cannot be established, return that state distinctly from logical edit success. Reusing these primitives with clear state handling is much smaller than creating another schematic editor.

Similarly, `pcb_sync_from_schematic` describes itself as file-based initial bring-up. It adds missing footprints using assigned library names, can optionally replace mismatches, and refuses file synchronization while a board is open unless explicitly allowed. Its source is not evidence that every net change, hierarchical path, reference rename, or existing routed-board ECO is faithfully synchronized. Qualify initial creation separately from later schematic changes, retaining native KiCad transfer as the reference behavior.[2]

## Routing: the most consequential naming mismatch

`pcb_route_trace` delegates directly to `pcb_add_track`. That function creates a straight `Track`, sets endpoints, width, layer and optionally the net, then calls `board.create_items`. It does not call the native interactive router or perform obstacle-aware path search. A successful result proves segment creation, not collision-free connectivity.[2]

Likewise, `route_differential_pair` writes custom rules for width, gap and skew. The `layer` input is reported as intent; the inspected rule body does not constrain a layer. `route_tune_length` writes a length rule and reports a delta; its meander amplitude is a suggestion in the output. `tune_diff_pair_length` writes length/skew rules and reports lengths. None of these bodies creates the promised-looking coupled or serpentine geometry.[3]

KiCad itself has interactive H/V/45 routing and differential-pair routing/tuning. That is native GUI functionality; the inspected 10.0.3 board command surface does not expose a equivalent complete route-planning RPC. For a simple board, model-selected paths can be applied as native track/via objects and then checked. A bounded adapter can enforce units, endpoint snapping, permitted angles and net identity. General shove, obstacle avoidance, tuned coupled geometry and optimization should remain an explicit gap unless an existing router is qualified.[7,15–16]

The installed MCP already contains a FreeRouting path: DSN export, external router execution, SES parsing and application, plus manual fallback branches. Its existence is a reuse candidate, not evidence that a local route completed. The adapter uses its own SES-to-board conversion and has default via geometry when padstack parsing lacks dimensions. Qualification must cover units, flipped coordinate conventions, layer mapping, padstack geometry, repeated import and preservation of pre-existing copper. Where the task favors model-guided routing, this can remain optional.[3,17]

For differential pairs, success should require observed copper geometry and native rule results. A rule file alone is not completion. The current KiCad manual also distinguishes an optimal router gap from a checked minimum/maximum gap: configure enforceable constraints when a gap requirement must be validated. Do not report USB compliance merely from pair naming, length equality or DRC.[15]

## Planes, impedance and checks

The inspected zone tool creates a native polygon zone, assigns its net and copper layer, sets clearances and thermal-relief dimensions, and calls native zone refill. This is a strong reuse boundary: keep the native fill engine. Add skills that inspect interruptions to return paths, island behavior and the relationship between signal layers and reference copper.[2]

The inspected `field_solver_available()` returns `False` unconditionally. The impedance path explicitly labels its result as a closed-form estimate. Upstream's rough accuracy statement should not become a validated bound for this board. Supply actual stackup parameters; record calculation method and assumptions; and introduce a separately qualified solver or fabricator analysis when the design needs it. A custom electromagnetic engine is unnecessary for the initial toolbox.[18]

For ERC/DRC and manufacturing outputs, invoke KiCad's engines. The exact 10.0.3 DRC source already contains JSON output, schematic parity, violation exit status, zone refill, and save-after-refill options. Therefore these important checks need not await a newer release or a replacement checker. Preserve the reports and the artifact revision they checked.[1,19]

Zone refill during DRC and persistent saved fill are different operations. The documented CLI can refill without saving; `--save-board` accompanies `--refill-zones`. A release workflow should ensure that the board exported is the same saved state that was validated. Rendering should also inspect the native output artifacts: an attractive view of the source board cannot establish that drill, copper or placement exports are correct.[1,19]

## Integration contract

Expose a small set of stable task operations through the toolbox, with implementation delegated to pinned existing tools. Each result should identify the exact project/document, tool/runtime version, operation class, changed objects or files, and verification artifacts. Distinguish at least: planned, applied to disk, applied live, persisted, and checked. Keep raw upstream results available for diagnosis.

Use one writer per active KiCad document. KiCad's IPC design is synchronous and its official guidance says multiple connections provide no advantage because operations are ordered. Parallel work is useful for reference research and independent artifact review; it should not create competing mutations of the same open board. Busy or uncertain responses should trigger state inspection before repeating a mutation, to avoid duplicate objects.[20]

A sensible qualification sequence is: document identity and readback; one schematic edit with netlist/ERC evidence; one footprint transformation with pad-coordinate verification; one trace and via with DRC; a polygon zone with fill and saved-state verification; differential-pair rule creation clearly separated from routed geometry; and reproducible exports from the checked revision. Then assess a representative board end to end. These are proposed checks, not tests reported as passed here.

No broad deletion or migration is necessary to adopt this architecture. Preserve existing custom adapters and mark which contract each satisfies. Retire an implementation only after the proposed replacement has demonstrated the same needed behavior and the retirement is specifically authorized.

## Licensing and packaging

KiStack's pinned license grants broad reuse with retained notices but adds an express restriction on reproducing the American Embedded logo. Describe it as its actual license text, not simply unqualified MIT. Reuse the instructional material with its notices; omit the logo unless separately authorized.[21]

The installed MCP license is MIT, as is the installed official Python binding's metadata and the schematic library's license expression. KiCad's main program is predominantly GPL-3.0-or-later; the official library tooling identifies GPL-3.0-or-later with file-specific exceptions. Calling an installed program, copying its implementation, bundling a modified binary, and redistributing a library collection are different integration choices. Preserve component-level notices and review the actual distribution plan before asserting that the combined product has a single permissive license.[4,13,22]

KiCad's library license is CC-BY-SA 4.0 with a design-output exception. The official explanation distinguishes use in proprietary or commercial designs from redistribution of library collections, which retains licensing and attribution obligations. Other vendors' downloaded footprints and 3D models need their own provenance and terms; the KiCad exception does not automatically cover them.[23]

These are source-based packaging observations, not a legal determination about a future distribution.

## Sources

All sources accessed September 9, 2026. Linked branches and documentation series are mutable unless an exact commit is included. Local files below were inspected read-only and are not public source URLs.

1. KiCad Documentation Contributors. [KiCad CLI reference](https://docs.kicad.org/10.0/en/cli/cli.html). Identifies 10.0.5, revision `a77c36a3`; relevant DRC, render and export sections inspected.
2. Osman Aslan. [MCP PCB implementation, pinned 3.33.3](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/src/kicad_mcp/tools/pcb.py). Actual track, via, zone, placement and synchronization bodies inspected; matched local file ignoring line endings.
3. Osman Aslan. [MCP routing implementation, pinned 3.33.3](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/src/kicad_mcp/tools/routing.py). Pair and tuning rule writers, FreeRouting workflow; matched local file ignoring line endings.
4. Local distribution: `D:/Codex-Recovery/tools/kicad-mcp-pro/inspection-runtime-3.33.3-doc3/environment/Lib/site-packages/`. Files: `kicad_mcp_pro-3.33.3.dist-info/METADATA` and `licenses/LICENSE`; `kicad_python-0.7.1.dist-info/METADATA`; `kicad_sch_api-0.5.6.dist-info/METADATA`; `kicad_mcp/tools/schematic.py`, especially backend selection and lines 5642–5670; `kicad_mcp/ipc/capabilities.py`. The schematic file differs from pinned upstream.
5. American Embedded. [KiStack pinned tree](https://github.com/American-Embedded/kistack/tree/5a11d7d0779a014876ed4e3175654750fad360fa). Commit resolved through GitHub repository tree API; README and selected full skills read.
6. KiCad Development Team. [For Add-on Developers](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/). Last modified April 4, 2026; explicit KiCad 9/10 versus 11 IPC boundaries.
7. KiCad Development Team. [Official Python Board API](https://docs.kicad.org/kicad-python-main/board.html). Moving main documentation; item operations, commits and per-method KiCad requirements.
8. American Embedded. [Layout skill](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/skills/layout/SKILL.md). Human-written engineering workflow, not executable router.
9. American Embedded. [Schematic skill](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/skills/schematic/SKILL.md). Netlists, datasheets, image review and presentation preferences.
10. American Embedded. [Footprint skill](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/skills/footprint/SKILL.md). Delegation to official generator tooling and dimensional checks.
11. American Embedded. [PCB review skill](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/skills/pcb/SKILL.md) and [Gerber skill](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/skills/gerbers/SKILL.md). Native checks plus visual output inspection.
12. American Embedded. [Export skill](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/skills/export/SKILL.md) and [position converter](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/skills/export/scripts/convert_position.py). Both read in full; manufacturer contract not independently qualified.
13. KiCad Libraries. [Library Tools README](https://gitlab.com/kicad/libraries/kicad-library-tools/-/blob/main/README.md). Current main, read through raw source; identifies generators, utilities migration and file-specific licensing. `master` path was unavailable; `main` succeeded. No generators installed or executed.
14. KiCad Development Team. [10.0.3 schematic command schema](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/api/proto/schematic/schematic_commands.proto) and [schematic handler](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/eeschema/api/api_handler_sch.cpp). Both read in full; incomplete native schematic implementation.
15. KiCad Documentation Contributors. [PCB Editor manual](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html). Moving 10.0 series; interactive router, pair routing, tuning and rule sections inspected. GUI capability is not a tested MCP capability.
16. KiCad Development Team. [10.0.3 PCB command schema](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/api/proto/board/board_commands.proto) and [PCB handler](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/pcbnew/api/api_handler_pcb.cpp). Command declarations and registered handler surface inspected.
17. Osman Aslan. [SES application implementation](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/src/kicad_mcp/utils/router_core.py). Coordinate convention and fallback geometry source; no routing run performed.
18. Osman Aslan. [Field-solver boundary](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/src/kicad_mcp/utils/field_solver.py). Full source read; actual solver availability is false; matched local copy ignoring line endings.
19. KiCad Development Team. [10.0.3 DRC CLI implementation](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/kicad/cli/command_pcb_drc.cpp). Full source read; exact target option confirmation.
20. KiCad Development Team. [IPC API design](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/). Last modified January 4, 2025; synchronous event and connection guidance, not current complete API inventory.
21. American Embedded. [Pinned KiStack license](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/LICENSE). Full text inspected; logo exception retained.
22. KiCad. [Program and documentation licenses](https://www.kicad.org/about/licenses/). Official licensing categories; see individual source headers for exceptions.
23. KiCad. [Library license and design exception](https://www.kicad.org/libraries/license/). Full official explanatory page inspected.
24. Osman Aslan. [Pinned compatibility manifest](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/compatibility.yaml). Dated July 26, 2026, baseline 10.0.5; upstream declares GUI routing boundary and partial IPC state consistency. These are upstream classifications, not local qualification results.


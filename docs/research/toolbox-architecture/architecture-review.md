# EvlEDA toolbox architecture

## Recommendation

Make EvlEDA a model-driven KiCad toolbox with a reusable CAD service, curated engineering skills, native validation, and selected custom checks. Keep the existing strict runner, compiler, durable workflow, and interfaces as optional clients of that service. Preserve the existing implementation and historical evidence. This is a change in composition and delivery priorities, not a proposal to delete the project or reduce the required quality of PCB designs.

Use an Astra main agent that can implement and integrate directly. Delegate independent investigations, isolated implementation, and focused review when those activities improve valid-result throughput. A permanent rule that the main agent may only delegate is not justified by the available evidence. Neither is a universal target for the number of active agents. Monetary cost is excluded from the optimization objective; elapsed time, correctness, integration capacity, and correction burden remain constraints.

The most immediate product issue is concrete: the public MCP entrypoint exposes the older application lifecycle, while the useful generic CAD tools are composed inside the CLI/harness. A stronger toolbox needs a direct, documented route to those capabilities. Completing every layer of the older hardware-development application is not a prerequisite for that route.[^1]

The recommended architecture is therefore a hybrid: a practical interactive toolbox first, with the strict runner retained for unattended workflows, exact contract checking, regression evaluation, and users who need its additional lifecycle. Native KiCad remains the authority for its documents, checking engines, rendering, and exports. Models and skills perform design reasoning; small adapters supply missing reliable operations and observations. No broad refactoring or removal should precede an additive end-to-end experiment.

Detailed supporting material is preserved in three companion reports:

- [Local architecture and disposition inventory](local-inventory.md).
- [KiCad, MCP, and KiStack reuse analysis](kicad-reuse.md).
- [Agent organization, empirical evidence, and evaluation design](agent-organization.md).

## Scope and evidence boundaries

The intended product turns prompts into native PCB projects that are close to practical use and manufacture, with explicit unresolved issues. The PCB designs are demonstrations of the reusable tools, not the primary product. The interaction surface is ChatGPT/Codex or another compatible model host; a separate operator UI, firmware platform, manufacturing-release campaign, and physical qualification system are not current delivery requirements.

This does not remove electrical engineering from the product. Correct pin assignments, sensible placement, appropriate widths and vias, the required 45-degree PCB routing practice, reference-plane decisions, and readable schematics remain requirements. It changes which layer is expected to satisfy them. A source-backed skill plus native CAD tools and a targeted checker can be a complete implementation of a workflow requirement; a new general-purpose compiler or solver is not always necessary.

Evidence reflects the local source and primary documentation available on September 9, 2026. The operational target is KiCad 10.0.3. Its installed MCP distribution is 3.33.3 with documented local overlays; current upstream and moving documentation can describe later versions. Source implementation, focused tests, a native fixture, and a complete end-to-end design are different levels of evidence and are not interchangeable.[^2]

| Evidence category | What it establishes | What it does not establish |
| --- | --- | --- |
| Current source inspection | Which entrypoints, functions, and dependencies exist and are wired | That a native operation succeeds on this installation |
| Focused tests | Behavior covered by those fixtures and assertions | General CAD capability, professional design quality, or a full current-source regression pass |
| Closed native fixture | Observed behavior for its exact files, runtime, and conditions | Arbitrary-board correctness or model superiority |
| Research and vendor documentation | Supported methods, requirements, and documented limitations | Local qualification or fulfillment of a particular board's electrical requirements |
| Independent design review | Findings against a stated brief and actual artifacts | Fabrication, physical qualification, or an unlimited safety guarantee |

The earlier roadmap was not a measured percentage. Equal-sized boxes do not represent equal amounts of work, and several boxes mixed existing native capabilities, implemented helpers, integration tasks, and genuinely missing behavior. Neither 25% nor a replacement percentage is supported. Readiness should instead be reported against specific user workflows and their remaining evidence.

## What already has value

There is substantial reusable work. The native session boundary, project/source ownership checks, library resolution, saved-state verification, reversible mutation support, and native ERC/DRC adapters protect real design data. The physical-pad work corrects a genuine semantic issue: a logical terminal can have multiple copper primitives and additional non-electrical paste apertures. Dropping those records or treating every record as another pin would be incorrect.

The schematic work also addresses genuine deficiencies. Stacked supply pins need complete logical-member preservation, and the inspected MCP bounding-box helper is based on constants and pin tips rather than complete graphic bodies. The source/render work makes that limitation explicit. Batch editing addresses repeated writes and repeated parsing; it is not merely additional bookkeeping. These mechanisms should remain available even if the surrounding runner becomes optional.[^1]

The existing research corpus contains 17 dossiers and 1,773 guidance records. It should be preserved with applicability, source links, assumptions, exceptions, and missing-input behavior. It is not equivalent to 1,773 executable validators. Packaging those references into useful design workflows is a different task from converting every statement into mandatory code.[^3]

The closed divider demonstration passed 44 configured checks with zero native ERC, DRC, and unconnected counts. Its independent review found readable annotations and the intended PCB trace style, while retaining a long schematic loop and missing connector-function silkscreen. That is useful proof of a bounded workflow, not proof that the entire toolbox is ready. Later source and focused-test results must not inherit that native result automatically.[^4]

## The composition mismatch

Three compositions coexist. The public MCP server constructs the older ApplicationService and registers lifecycle operations. The CAD CLI composes the generic tools and runner. The optional Flux application adds another run, approval, checkpoint, and execution lifecycle around that CLI. The older README and product contract also describe firmware, bring-up, and qualification concerns beyond the clarified toolbox scope.[^1]

This creates an avoidable product boundary: useful CAD capabilities are present, but the normal MCP entrypoint does not expose them as a practical design toolbox. Calling the Flux CLI from a model host does not by itself remove the additional lifecycle. A new name for the same route would not fix the mismatch.

The strongest initial architectural move is to extract or adapt the existing CAD service behind an additional MCP entrypoint. Keep the original entrypoint operational and clearly named. A model should be able to inspect a project, retrieve relevant guidance, perform an authorized bounded edit, save, validate, inspect the actual result, and revise it without first entering unrelated firmware or commissioning stages.

The strict contract path can remain available for operations that claim exact fulfillment of a compiled specification. Exploratory reads and incremental editing need not pretend that a complete design specification already exists. Missing information should trigger a relevant question or an explicit limitation, not force every valid KiCad construct through a narrow all-or-nothing design language.

## Proposed product layers

| Layer | Responsibility | Important boundary |
| --- | --- | --- |
| Model host and Astra | Understand the brief, research components, make engineering choices, coordinate work, and explain unresolved decisions | A model statement is not native validation or evidence of electrical suitability |
| Skills and references | Reusable design workflows, source-backed guidance, review checklists, examples, and exceptions | Instructions guide behavior; they do not manufacture missing CAD capabilities |
| Shared CAD service | Project binding, reliable reads, bounded mutations, batches, save/readback, recovery, renders, and checks | Native state and tool outcomes remain explicit; failed or uncertain operations are not reported as success |
| KiCad and qualified backends | Native documents, item editing, connectivity/checking, zone filling, rendering, and exports | Availability depends on the exact version and accessible interface |
| Optional strict runner | Compiled intent, exact acceptance plans, unattended execution, reproducible fixtures, and durable workflow | An additional client of the service, not a mandatory replacement for an interactive model host |

MCP already provides composable tools, resources, and prompts. Its design guidance favors building use cases from those primitives rather than adding unnecessary protocol machinery.[^5] In this architecture, tools act, resources supply evidence and references, and skills describe when and how to use them. An optional runner coordinates the same capabilities when a stronger unattended lifecycle is useful.

Results should retain a small set of meaningful distinctions: requested, planned, applied to disk, reflected in live state, saved, checked, and unresolved. These are not interchangeable. The implementation may retain its richer internal records, but ordinary model feedback should expose the facts needed for the next decision instead of every internal artifact or raw native table.

## Allocation of design responsibilities

### Native behavior to reuse

Use KiCad's existing ERC, DRC, rendering, netlist/export, and zone-filling behavior. The target's DRC CLI already supports the relevant refill and save-after-refill options. A validated board and an exported board must refer to the same saved state; refilling transiently without saving cannot establish that exported copper is current.[^6]

Use existing native item operations and the working MCP adapters for placement, tracks, vias, zones, and library lookup. Preserve exact project and object selection. A reusable wrapper should make these operations dependable and easy to invoke, not recreate their CAD engines.

KiCad 9/10 IPC requires a running GUI instance; headless IPC and IPC exports are documented for KiCad 11. On 10.0.3, native CLI exports complement IPC. A method appearing in current Python documentation does not prove that the connected target implements it.[^7]

### Model and skill responsibilities

Topology choice, component selection, decoupling strategy, power-domain reasoning, connector usability, and routing priorities belong primarily to the design assistant, informed by datasheets and reference designs. The workflow should record the evidence and unresolved assumptions that materially affect correctness. It should ask for missing operating conditions rather than invent them.

The required 45-degree PCB routing policy remains explicit. Orthogonal schematic wires are a separate convention. Width and via decisions should use current, copper construction, layer span, voltage drop, heating, and fabrication constraints as appropriate. Merely matching a geometric minimum is not evidence of ampacity or impedance.

These responsibilities do not require implementing a new general electrical solver. Where an existing calculator, field solver, manufacturer stackup, reference design, or native interface supplies the needed analysis, qualify and reuse it. Where the necessary evidence is unavailable, expose the remaining uncertainty and do not label the design ready on that basis.

### Small custom mechanisms that remain justified

Retain reliable pin/physical-pad observations, safe compound edits, current-source comparisons, selected geometric checks, and targeted result normalization. These address measured shortcomings in the tool surface. The criterion is the missing behavior each mechanism supplies, not its line count.

A checker should remain callable independently of the strict runner where practical. Measurable requirements such as connector pin mapping, exact net membership, trace width, via dimensions, and the selected angle policy can be checked after edits. Broader engineering judgments should remain separate, with their source evidence and review outcomes visible. Making a check optional during exploration must never turn an unchecked final requirement into a pass.

## Reuse caveats that prevent false shortcuts

The inspected MCP's route-trace tool delegates to straight track creation. Its pair-routing and tuning tools write constraints or report lengths; they do not create coupled copper or meanders. The field-solver availability function returns false. These are implementation findings for the pinned distribution, not conclusions inferred from tool names.[^8]

Consequently, simply exposing every existing tool does not complete automated routing or controlled-impedance support. For straightforward geometry, the model can choose paths and apply track/via primitives, with post-edit checks. More demanding routing can use a qualified existing router or native interactive capability when actually accessible. A narrow helper is appropriate for a specific missing operation; a new general autorouter is not the default project requirement.

The native interactive router is not equivalent to an IPC route-planning endpoint. Computer use can be an option only when the current host exposes working native-app control; a visible KiCad window or an advertised model capability is insufficient. The current conversation's tool surface lists native computer APIs as disabled, so GUI routing is a conditional integration route, not a presently proven replacement.[^9]

Schematic editing is another real boundary. The inspected target lacks a complete native schematic editing API; the local MCP uses file operations and a best-effort reload that does not confirm the GUI state. This justifies a document-bound file transaction and native readback/export path. It does not justify reporting file success as confirmed live-editor synchronization.[^10]

The reuse principle is therefore behavioral: a replacement is accepted only after it demonstrates the required behavior on the intended version. Renaming a rule writer as a router, assuming a solver exists, or removing checks to make a workflow appear complete would not be simplification.

## Skills and research packaging

Preserve the full dossiers as references and organize the front-door skills around actual work: define the brief, select and verify components, create/revise the schematic, place and route, inspect power/return paths, validate, and prepare reviewable outputs. This is a proposed information architecture, not a new requirement to build a separate application.

OpenAI skills load through progressive disclosure: concise discovery metadata first, then the selected instructions and supporting resources. That favors focused workflow entrypoints over permanently injecting the entire corpus into every design turn.[^11] Full relevant references should remain available; efficient context selection is not a reason to discard engineering detail.

Each workflow should identify its required inputs, tool capabilities, applicable source material, checks, stopping conditions, and escalation questions. Separate universal tool-use requirements from project-specific engineering policies. For example, preserving pin identity is a tool correctness requirement; choosing a trace width is a design decision that needs operating conditions; a particular 45-degree policy is an explicit project requirement.

KiStack supplies useful human-written workflows and supporting scripts. It is not an EDA engine. Its guidance can inform the skill layer, but preferences such as broad relayout or pin swapping must not become unconditional permission. Its license also includes a specific logo restriction; retain notices and assess each reused component rather than treating the entire ecosystem as one unqualified permissive package.[^12]

A skill should not conceal a backend limitation. If a named tool only creates rules, the skill must say so and route the task to actual geometry creation and validation. If live schematic reload is unconfirmed, the workflow must distinguish that from saved-file success. Clear tool descriptions and references can eliminate repeated discovery without adding another controller.

## Keep, consolidate, make optional, and defer

| Disposition | Existing area | Recommended treatment | Evidence required before changing behavior |
| --- | --- | --- | --- |
| Keep | Native session, document/source binding, save/readback, rollback, partial-failure handling | Extract behind a reusable service; preserve data protection | Wrong-document, stale-source, interrupted mutation, and saved-result checks |
| Keep | Physical pads, logical terminals, library mapping, selected geometry and native parity | Reuse the implemented capability; qualify its actual native path | Complete physical inventory and library preservation, positive and negative connectivity cases |
| Keep | Research corpus, engineering checks, native render evidence, examples and historical proofs | Make accessible through skills/resources and standalone checks | Applicable sources and explicit distinction between guidance, measurements, and review |
| Consolidate | Public MCP composition versus harness tools | Add a direct toolbox entrypoint over shared mechanisms | Direct-host discovery, a useful read/edit/save/check cycle, and clear capability reporting |
| Consolidate selectively | Repeated parser mechanics and identity helpers | Share only after semantic equivalence is demonstrated | Source spans, duplicates, quoting, unsupported cases, budgets, and legacy fixtures |
| Optional | Compiler, exact acceptance plans, strict agent runner, Flux lifecycle/UI | Keep as clients for bounded unattended or exact-contract work | Existing records remain readable; strict mode retains its guarantees |
| Optional | Older application, commissioning bench, firmware and physical-evidence modules | Preserve separately from the default toolbox path | Dependency/build separation; no loss of current data or proof history |
| Defer | Integrating dormant agent scaffolding or manufacturing/qualification product features | Do not expand them for this delivery | A new explicit product need |
| Defer | General autorouter, electromagnetic solver, exhaustive new CAD engine | Qualify existing tools first; add only demonstrated missing operations | A measured gap that blocks a required workflow and cannot be solved by qualified reuse |

This is a disposition proposal. No item is labeled useless merely because it is large, duplicated in name, or not on the immediate critical path. The detailed inventory identifies functions and dependency boundaries for each category.[^1]

## Development organization

The default should be a coding integrator, not a main agent prohibited from coding. The main Astra agent owns the goal, shared interfaces, integration, and the next end-to-end checkpoint. It implements a coupled critical-path change directly when that is the most efficient use of its context. Specialists handle bounded work with a clear input baseline, owned output, and acceptance criterion.

Official OpenAI orchestration guidance distinguishes handoffs from bounded specialists behind a manager and recommends adding specialists when their separation has a concrete benefit. It does not require the manager to avoid implementation.[^13] Astra guidance likewise supports explicit delegation and proportionate verification rather than a universal staffing formula.[^14]

Empirical evidence is mixed and task-dependent. The CAID study supports testing isolated asynchronous delegation, while also finding nonmonotonic effects from additional engineers. The scaling study includes small coding subsets and no Astra models. These findings support disciplined experiments, not transplanting a published team size or benchmark gain into this project. The detailed organization memo preserves paper versions, sample limitations, and counterevidence.[^15][^16]

Use one active owner for a coupled source change and one mutation owner for each native CAD document. Substantial independent code work can use isolated workspaces when practical, but worktrees do not isolate native editors, ports, caches, or installed runtimes. The current repository is uncommitted; ordinary worktree-based integration needs a valid baseline first. Do not fabricate commits or authorship just to enable a preferred workflow.

Shared-file ownership must not become a long-lived queue. When several features repeatedly need the same file, the integrator should own that file and integrate the agreed changes, or perform a justified extraction that creates a stable boundary. Splitting one evolving interface across many workers is not useful parallelism merely because more agents are active.

Every task should have a small, concrete handoff: changed files, validation result, unresolved issues, and the next integration condition. A new schema or dependency that affects other workers should be resolved promptly by the integrator. Reviews should be specific and bounded; independent reviewers should not become uncoordinated second implementers.

Track real handles and states using the available collaboration tools. A message sent to a completed worker does not restart it in this environment; resuming its work requires the corresponding follow-up action. A capacity error is terminal for that attempted turn, not evidence of an ongoing wait. Preserve the work and inspect any real process before retrying. The selected policy is to retry Astra for substantive work, not silently substitute another model.

## Validation without verification sprawl

Retain strong checks, but attach them to the behavior they establish. Mocked protocol tests are appropriate for argument validation and state/error handling. Native fixtures are needed for actual KiCad behavior. A representative design requires electrical, geometric, and visual review against its brief. None of these replaces the others.

Run focused tests for a substantive local change. After integration, run the tests needed to catch composition failures and the required native checkpoint. Repeat or broaden testing when a changed dependency, discovered defect, or unresolved risk warrants it. Avoid treating every documentation edit or internal handoff as a reason to rerun the full suite.

Keep a concise association between the design revision and its validation artifacts. Preserve detailed historical records for investigation, but do not introduce another ledger or receipt family unless an existing record cannot answer a necessary question. Distinct facts must remain distinct: a save receipt is not a connectivity result; a native DRC report is not a current-capacity analysis; an image is not evidence of correct pin semantics.

Review has an exit condition: the required behavior is demonstrated, concrete findings are corrected, and residual limitations are recorded. Agreement among several agents is not a substitute for a native or deterministic oracle. Conversely, inventing more speculative checks after the applicable criteria are satisfied can delay valid delivery without improving the demonstrated result.

## Non-destructive delivery sequence

| Step | Concrete result | Exit evidence |
| --- | --- | --- |
| Preserve | Keep current source, partial handoffs, tests, native records, and old entrypoints | Existing files remain available; current implemented/unfinished status is explicit |
| Expose | Add a separate toolbox MCP composition over reusable CAD mechanisms and guidance retrieval | The actual model host discovers useful tools/resources without entering unrelated lifecycle stages |
| Exercise | Complete a narrow read, authorized reversible edit, save, native check, render, and revision through that public surface | Actual resulting files agree with reported state; failure and retry behavior are tested |
| Extend by need | Cover larger footprints, planes, pair routing, and electrical evidence through qualified native/tool/skill combinations | Required behavior works; unsupported backend features are not renamed into success |
| Review together | Exercise a representative design and a subsequent change, with applicable electrical/visual checks | Integrated current-source results, not a sum of unrelated helper test counts |
| Handoff | Save and push the reviewed baseline once repository/authorship/sign-in are available | Exact remote commit verified; no invented GitHub destination |
| Demonstrate | Use the tools for the requested RP2350 Pico-like/Orpheus-inspired proof | Board-specific sources, native project, corrections, and remaining issues retained |

This sequence is not a schedule or a completion percentage. It preserves the requested order of GitHub handoff before the actual RP2350 board task. Earlier isolated native fixtures can test tools, but they must not be presented as that finished board or as proof of the whole product.

The first implementation experiment should be additive and small enough to compare with the existing runner. Do not begin with a broad parser rewrite, delete the old UI, or migrate all stored runs. A successful experiment establishes which pieces should become the default front door and which remain optional.

## Performance evaluation with cost excluded

Measure time to a valid, reviewable result, not agent count, lines written, or the number of green unit tests. Include integration waits, retries, corrections, native execution, and human interventions. Record backend-capacity failures separately while retaining their effect on practical delivery time. There is no existing matched evidence that EvlEDA outperforms Astra using KiCad directly.

For product architecture, compare Astra with the qualified stock tool/skill baseline, Astra with the proposed toolbox, and the existing strict runner where it applies. Give each the same brief, starting artifacts, sources, native checks, relevant tool access, and acceptance criteria. Do not handicap the baseline by hiding ERC/DRC or insisting that it operate only from screenshots.

For development organization, compare a main coding integrator with specialists against orchestration-only delegation on representative independent and tightly coupled changes. Keep model differences separate from organization differences. Use Astra for the substantive comparison; routine Terra/Luna assistance can be evaluated independently when appropriate. Monetary cost is not a selection criterion.

Useful observations include valid completion, elapsed and tail time, first-pass acceptance, correction burden, duplicate work, integration backlog, unsupported requirements, and native state/report agreement. Retain failed and unfinished attempts rather than reporting only the fastest success. Small task samples can guide the next decision but cannot establish a universal optimal architecture.

Do not make a large benchmark campaign a new prerequisite for shipping a useful toolbox. Start with meaningful comparisons during the first additive end-to-end slice, then expand only where uncertainty affects a real decision.

## Decision and remaining uncertainty

Adopt the hybrid toolbox direction and main-integrator working policy. Preserve the existing strict infrastructure as an asset. Put the next implementation effort into the actual public tool/skill path and the smallest complete native-backed workflow that exercises it. Keep required engineering outcomes intact; choose the smallest qualified mechanism that achieves each one.

No defensible full-project ETA follows from this research. The analysis changes the critical path, so an estimate based on finishing every previously listed subsystem would be misleading. A useful next forecast needs measured implementation and native results for the additive toolbox path, plus an explicit list of remaining required behaviors.

Open questions are concrete: which existing tool methods can be exposed without a compiled fresh contract; what minimum session/context adapter those methods need; how much of the current generic integration should be finished versus used as an optional strict path; which routing route is actually available on this host; and how the required RP2350 electrical/USB/plane work will be demonstrated. These questions should drive implementation, not an assumption that more infrastructure or more agents is inherently better.

## Sources

Sources were accessed September 9, 2026 unless otherwise stated. Moving documentation is not treated as an exact-version implementation contract. Local artifacts are workstation evidence, not public release records.

[^1]: EvlEDA current source: [MCP main](../../../src/mcp/main.ts), [MCP server](../../../src/mcp/server.ts), [CAD CLI](../../../src/cli/pcb-agent.ts), [CAD harness tools](../../../src/harness/kicad-tools.ts), [application factory](../../../src/application/factory.ts), and [local inventory](local-inventory.md). Source inspection; no new native execution implied.
[^2]: [KiCad/MCP reuse memo](kicad-reuse.md), including exact KiCad 10.0.3 commit 146a4f2a7585c65bc580427a19b6fe2ec4a3f622, MCP 3.33.3 commit 601d1831c6e5991805021147128c2c969f6fd7ce, local DOC3 differences, and moving documentation limits.
[^3]: EvlEDA [rule catalog](../../../resources/deep-pcb-rule-corpus/v1/docs/pcb-design-guides/rule-catalog.json) and [resource guide](../../deep-rule-resources.md). Direct catalog inventory: 1,773 rules and 17 dossiers; guidance, not that many executable checks.
[^4]: EvlEDA [attempt-15 terminal summary](D:/EvlEDA-live-proof-v8-attempt15-20260909-043024233/evidence/terminal-result-summary.json) and [independent visual review](D:/EvlEDA-attempt15-visual-review-20260909/visual-review.md). Exact closed fixture; later work is separate.
[^5]: Model Context Protocol maintainers. [Design principles](https://modelcontextprotocol.io/community/design-principles). Current official guidance; composable tools, resources, prompts, and capability negotiation.
[^6]: KiCad Development Team. [KiCad 10.0.3 DRC CLI source](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/kicad/cli/command_pcb_drc.cpp). Exact target implementation; see also the moving [10.0 CLI manual](https://docs.kicad.org/10.0/en/cli/cli.html).
[^7]: KiCad Development Team. [For add-on developers](https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/). Official KiCad 9/10 versus 11 IPC and export boundaries.
[^8]: Osman Aslan. Pinned MCP 3.33.3 [PCB tools](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/src/kicad_mcp/tools/pcb.py), [routing tools](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/src/kicad_mcp/tools/routing.py), and [field-solver boundary](https://github.com/oaslananka/kicad-mcp-pro/blob/601d1831c6e5991805021147128c2c969f6fd7ce/src/kicad_mcp/utils/field_solver.py). Actual implementation inspection, not advertised tool names.
[^9]: KiCad [PCB Editor manual](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html), interactive routing sections; [10.0.3 PCB command schema](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/api/proto/board/board_commands.proto). Current conversation tool documentation explicitly disables native computer APIs; that is a session limitation, not an Astra capability judgment.
[^10]: KiCad [10.0.3 schematic command schema](https://github.com/KiCad/kicad-source-mirror/blob/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/api/proto/schematic/schematic_commands.proto), plus local DOC3 schematic implementation documented in [reuse analysis](kicad-reuse.md). Local schematic patches are distinguished from upstream.
[^11]: OpenAI. [Build skills](https://learn.chatgpt.com/docs/build-skills). Current official documentation; progressive disclosure and optional scripts/references/assets.
[^12]: American Embedded. [Pinned KiStack tree](https://github.com/American-Embedded/kistack/tree/5a11d7d0779a014876ed4e3175654750fad360fa) and [license](https://github.com/American-Embedded/kistack/blob/5a11d7d0779a014876ed4e3175654750fad360fa/LICENSE). See [reuse memo](kicad-reuse.md) for selected full skills, script behavior, and component-level licensing caveats. No legal conclusion about an unreviewed distribution is asserted.
[^13]: OpenAI. [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration) and [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Current official guidance; ownership patterns and coordination cautions, not an Astra-specific benchmark.
[^14]: OpenAI. [Model guidance: GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model). Current official guidance; delegation and proportionate testing. No comparative latency claim is derived.
[^15]: Jiayi Geng and Graham Neubig. [Effective Strategies for Asynchronous Software Engineering Agents](https://arxiv.org/html/2603.21489v2), v2, July 8, 2026. Original CAID study; isolation and concurrency results have task/model/budget limitations.
[^16]: Yubin Kim et al. [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3), v3, April 8, 2026. Original empirical study; coding subsets contain 20 instances each and models predate Astra. [Organization memo](agent-organization.md) also preserves original Anthropic engineering reports and Agyn evidence with their limitations.

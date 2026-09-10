# Agent organization for the KiCad toolbox

## Decision

Use an Astra main agent that can implement and integrate directly, with Astra specialists assigned bounded, independent work when that work can shorten delivery or improve verification. Keep one owner for cross-cutting interfaces and one active mutation owner for each native CAD session. Expand concurrency according to the dependency graph and measured integration capacity. This is the recommended working policy, not a demonstrated Astra-specific optimum.

Optimize for valid results, elapsed time to acceptance, and human correction burden. Monetary cost is excluded from the objective. Terra or Luna can assist with routine, objectively checkable support when allowed, but neither should be presumed faster end to end after correction and review. Sol is outside the selected policy unless explicitly requested. The main agent remains permitted to code; there is no requirement to route every edit through a worker.

The available evidence supports selective parallelism and disciplined ownership. It does not establish that an orchestrator prohibited from coding is superior, that maximizing active agents maximizes throughput, or that a large local concurrency setting guarantees service capacity. No runtime, model, or native CAD benchmark is claimed here.

## Evidence and its limits

### Official Astra and Codex guidance

OpenAI's current Astra guidance says delegation behavior responds to explicit instructions and recommends calibrating testing to the change. It describes asynchronous tool execution, while retaining the application's responsibility for executing tools and tracking pending work. These are supported capabilities and prompting recommendations; they are not measurements comparing coding integrators, pure orchestrators, or different team sizes.[^1]

Codex documentation identifies parallel exploration, tests, triage, and summarization as suitable starting points, and warns that simultaneous code edits can introduce conflicts and coordination overhead. Unconfigured children inherit the parent's model and reasoning effort. The page's generic model examples still emphasize GPT-5.6; they do not override an explicit Astra selection or establish a current comparative result.[^2]

OpenAI's orchestration documentation distinguishes specialists that take ownership through handoffs from specialists used as bounded tools while a manager retains the reply. This is a control-flow distinction. It does not require the manager to abstain from implementation or prove one topology wins on a repository.[^3]

**Inference for this project:** retain global requirements, interface decisions, and integration ownership in the main Astra context. Delegate work that can return a useful artifact without requiring the worker to continuously synchronize its entire understanding of the project. Native Codex collaboration, an Agents SDK workflow, and hosted API orchestration are separate execution mechanisms; documentation about one is not evidence of the other's exact handles, isolation, or limits.

### Anthropic's original engineering reports

The December 2024 effective-agents report recommends starting with simple composable patterns, describes sectioning and independent evaluation as uses of parallelism, and identifies orchestrator-workers as useful when subtasks emerge dynamically. Its page now explicitly notes that parts of the tooling landscape have changed. Treat it as architectural guidance rather than a current product specification or a controlled coding experiment.[^4]

Anthropic's June 2025 research system reports a 90.2% improvement over single-agent Opus 4 on an internal research evaluation using an Opus 4 lead and Sonnet 4 workers. This is not a coding benchmark, Astra result, percentage-point gain, or equal-resource comparison. The same report says tightly dependent tasks and shared-context domains can fit poorly; it specifically cautions that coding often has less parallelizable work. It recommends precise worker objectives, output formats, and boundaries, and persistent artifact references to reduce information loss. Its observations about stateful failures and synchronization bottlenecks motivate lifecycle tracking, not a universal staffing ratio.[^5]

The February 2026 C-compiler report supplies directly relevant counterbalance: a team without a dedicated orchestrator achieved substantial software construction using isolated clones, task claiming, and strong automated feedback. Yet when workers encountered the same kernel-compilation blocker, sixteen agents duplicated fixes and overwrote changes. Progress required a better decomposition and a known-good compiler oracle. This is a first-person engineering case, not a controlled team-size comparison; it demonstrates feasibility and a concrete failure mechanism, not that decentralized teams generally win.[^6]

**Inference for this project:** extra implementation capacity is useful only after independent work and a trustworthy verifier exist. A better tool contract or test oracle may improve throughput more than another worker.

### Empirical multi-agent scaling

The latest inspected version of *Towards a Science of Scaling Agent Systems* is v3, April 8, 2026: 260 configurations and six benchmarks. The frequently repeated 180-configuration/four-benchmark description belongs to earlier versions. V3 adds SWE-bench Verified and Terminal-Bench, but evaluates only twenty instances of each, with broad confidence intervals. Its GPT-5 SWE results are 65% single-agent, 60% centralized, 70% decentralized, and 55% each hybrid/independent; this small sample does not establish a reliable coding winner. Models predate Astra. The matched-compute design also differs from optimizing quality without monetary constraints. Some regression effects lose significance under cluster-robust analysis. Use the study's task-dependence finding as evidence against universal scaling claims; do not transplant its fitted thresholds, coefficients, or architecture-selection accuracy into a KiCad staffing rule.[^7]

### Direct software engineering coordination studies

*Effective Strategies for Asynchronous Software Engineering Agents* studies centralized asynchronous isolated delegation (CAID) using OpenHands, Claude Sonnet 4.5, GLM 4.7, and MiniMax 2.5. Its July 2026 v2 evaluates Commit0-Lite and PaperBench **Code-Dev**, not full experimental paper reproduction. The abstract reports gains of up to 14.7 and 25.6 percentage points respectively; these are not Astra predictions. Its isolation ablation is especially relevant: on PaperBench, soft shared-workspace separation scores 55.5%, versus 57.2% single-agent and 63.3% with worktrees. Increasing engineers from four to eight lowers Commit0 performance in its configuration. Doubling the single-agent iteration limit produces limited improvements, strengthening the evidence beyond simply comparing different iteration allocations. The results still bundle delegation, isolation, and integration; they do not isolate the effect of a manager writing code. They support testing isolation and bounded concurrency, without proving a universal agent count.[^8]

*Agyn* v2 reports 72.2% on text-only SWE-bench 500 with GPT-5 managers/researchers and GPT-5-Codex engineers/reviewers. Its comparison includes 65.0% for mini-SWE-agent with GPT-5 and 71.8% for OpenHands with GPT-5. Tools, role configuration, and models differ across systems, so the 7.2-point comparison is not an isolated causal effect of adding agents. The study provides evidence that manager-coordinated implementation and review can be competitive, and emphasizes explicit completion signals separate from status messages. It does not evaluate native CAD state or Astra.[^9]

**Synthesis:** both beneficial and harmful multi-agent outcomes exist in software work. Isolation, decomposition, verification, and baseline quality vary across studies. There is no sound basis for choosing a universal team size or forbidding root implementation from these results.

## Comparison of working modes

The following assessment is a project-specific engineering judgment, not a benchmark result.

| Mode | Useful conditions | Principal risk | Proposed use |
|---|---|---|---|
| Main integrator codes and delegates scoped work | Interfaces are evolving; some investigations or modules are independent; final state must remain coherent | Main becomes a bottleneck if every trivial decision requires approval | Default; root owns dependencies and works on the critical path |
| Main only orchestrates; all implementation goes to workers | Large stable work packages; integration and scheduling alone fully occupy the main agent | A small coupled edit becomes a handoff, summary, wait, and reinspection cycle | Optional phase mode when coordination demonstrably consumes the main agent's capacity |
| Many independently working agents | Many isolated tasks and strong automated acceptance checks; outputs can integrate independently | Duplicated work, stale interfaces, merge backlog, shared-resource collisions | Use for suitable batches, with explicit artifact ownership and completion tracking |
| Single Astra implementation | Short fix or one tightly coupled chain; native session must evolve sequentially | Less independent scrutiny and less parallel investigation | Use when delegation adds no useful parallel work; add focused review when risk warrants |

An integrator can temporarily become orchestration-only during a busy integration wave. This should be a response to actual workload, not a permanent rule that prevents the most informed agent from fixing a small cross-cutting issue.

## Delegation criteria and work contracts

Delegate when the proposed worker can answer a distinct question or deliver a verifiable artifact while the main agent has useful independent work. Suitable examples include checking an official KiCad API behavior, auditing one module's assumptions, developing a fixture set against an agreed schema, implementing an isolated adapter, or reviewing an integrated diff for a particular failure class.

Keep work local when the next action depends on the main agent's evolving reasoning, crosses an unstable shared interface, or controls the same live CAD document. Also keep it local when explaining the task and checking the result would plausibly take longer than doing it, unless independent review has meaningful quality value. A worker's long runtime alone is not a reason to duplicate its assignment; first determine whether it is blocked, still making progress, or investigating a different hypothesis.

Each delegation should carry this compact contract:

| Field | Required content |
|---|---|
| Outcome | A concrete result, acceptance criterion, and explicit non-goals |
| Inputs | Exact paths, relevant versions, baseline identifier, accepted requirements, and source links |
| Ownership | Files or artifact directory the worker may edit; shared resources it may only read |
| Interfaces | Inputs/outputs and behavior already agreed; who resolves contract changes |
| Validation | Checks appropriate to the change, expected evidence, and known baseline failures |
| Completion | Changed paths, result summary, exact validation outcome, unresolved issues, artifact references |
| Escalation | Report dependency changes, ownership overlap, inaccessible tools, or failed assumptions before expanding scope |

Do not delegate broad labels such as “improve quality” to simultaneous writers. Convert them into bounded questions or owned changes. A review worker should report actionable defects with evidence, not become an uncoordinated second implementer.

## Ownership of files and native CAD state

These are proposed operating rules for a shared-file CAD toolbox; they are not claims that the present runtime already enforces locks or transactions.

1. The main integrator owns public contracts, orchestration behavior, shared configuration, and final integration decisions. An implementation specialist can propose contract changes, but dependent writers need the same accepted version before proceeding.
2. Give each mutable file or coherent change unit one active owner. Shared schemas, registry files, dependency manifests, and generated outputs deserve explicit ownership because apparently separate features can touch them indirectly.
3. Isolate substantial parallel coding in workspaces when available and within scope. Preserve the baseline and identify the exact output to integrate. Worktrees isolate file edits; they do not automatically isolate installed dependencies, ports, native application processes, device state, or shared project caches.
4. Give each native KiCad session/document one mutation owner. Other agents can analyze immutable exports or a versioned snapshot. A reader using live state must account for that state's revision; an observation during someone else's write can become stale immediately.
5. Keep related schematic, board, project settings, and generated evidence associated with one baseline. Disjoint filenames alone do not guarantee independent semantics. A changed symbol mapping can invalidate a board-side assumption without producing a text merge conflict.
6. After a mutation, collect authoritative resulting state and validation evidence before handing ownership to another agent. If the mutation response is lost, inspect the state before retrying; duplicate successful operations must not be mistaken for failed first attempts.
7. Treat ownership as a lease with explicit release, not a permanent assignment. On interruption or failure, establish whether the worker has stopped and what it changed before reassigning. Do not infer safe ownership transfer from silence.

For the early toolbox build, a practical division is: main Astra owns the end-to-end contract and integration; one scoped specialist may investigate a backend or implement its isolated adapter; another may develop independent fixtures or review the accepted interface. These are examples of responsibilities, not a prescribed simultaneous headcount. Once a contract changes, reconsider which tasks remain independent.

## Actual status and handle tracking

Use the collaboration mechanism's returned identifiers and observed states. A planned role is not a running agent; a successful spawn request is not a delivered result; a status message is not completion; a worker's final response is not proof its implementation passed integration.

Maintain a small task ledger with: task identifier, actual agent handle, parent, scope, owned paths/resources, input baseline, dependencies, state, latest evidence, output reference, and integration status. Recommended states are proposed, dispatched, running, waiting on dependency, returned, verified, integrated, failed, and canceled. Distinguish task state from agent process state: an idle agent can have delivered an unverified task.

Collect results as they arrive and release newly unblocked work. Avoid an unnecessary global barrier when one completed artifact can already be inspected or integrated. Use the runtime's wait/status facilities with returned handles; track errors and handle disappearance explicitly. Do not create nested delegation by default: another layer is justified only if its coordination and reporting remain bounded and it has a real independent task.

When service or runtime capacity prevents spawning, continue useful in-scope work and retry through the supported mechanism only when appropriate. Local concurrency settings, theoretical context capacity, and advertised parallelism are distinct from measured account/service throughput. The plan must remain executable with fewer workers, including the root implementing directly.

## Test and review strategy

Validate the resulting behavior at the layer where it matters. A tool returning valid JSON does not establish that its native operation succeeded, and a plausible CAD screenshot does not establish semantic connectivity or preservation of unrelated state.

For a substantive toolbox change, select the relevant checks from these layers:

| Layer | Evidence sought |
|---|---|
| Contract | Argument validation, units, IDs, error shape, capability reporting, unsupported-operation behavior |
| Deterministic logic | Conversion and parsing correctness, identity preservation, fixture round trips, expected failure cases |
| Adapter integration | Correct native calls and resulting state on a disposable fixture; response/state agreement |
| Shared-state behavior | Stale handles, interrupted operations, lost response, repeated invocation, clean ownership transfer |
| User workflow | A representative task reaches its stated final state and can be reopened or independently inspected |
| Regression | Relevant existing behavior still passes after all worker changes are integrated |

Workers should run focused checks for their own substantive change and return logs or artifact references. The integrator runs checks needed to detect composition failures after integration. An Astra reviewer should examine the integrated result and the acceptance criteria; independent review matters most for cross-cutting changes, state mutation, identity mapping, and recovery logic.

Avoid repeated broad suites with no new reason. A wording-only change does not need a newly invented mirrored test. Conversely, do not treat a successful unit test of a mock as native KiCad validation. When native verification is unavailable, state that limitation and preserve the exact remaining check. Do not count a mock-only result as completing a native workflow.

Review should have a specific stop condition: required acceptance checks pass, actionable defects have been addressed, and residual limitations are identified. Multiple reviewers agreeing is not a replacement for an executable oracle, especially when they share the same assumptions.

## Benchmarking for performance with monetary cost excluded

The recommendation should be revisited using representative tasks from this toolbox. Compare at least the three organizational alternatives in the decision question: coding integrator with specialists, orchestration-only main with workers, and a broader team with isolated ownership. Include a single-Astra baseline for tightly coupled tasks. These are experimental arms, not a request to run them now.

Use the same task specification, starting artifact, acceptance criteria, tools, environment, model family, and effective reasoning settings wherever possible. Begin with homogeneous Astra to isolate organizational differences. Evaluate routine Terra/Luna support separately; otherwise a model change is confounded with an architecture change. Document unavoidable differences such as total reasoning allowance and parallel execution capacity.

Choose tasks spanning: a narrow deterministic fix; an independent adapter addition; a schema change with multiple consumers; a long investigation; a native mutation/recovery workflow; and an integration-heavy feature. Include tasks with known defects and held-out acceptance checks to discourage implementations that simply satisfy visible tests. A task set should resemble the expected workload rather than favor the proposed architecture.

Record the following without converting them to money:

| Metric | Definition and interpretation |
|---|---|
| Valid completion rate | Fraction meeting independent acceptance criteria, including semantic/native requirements |
| Time to valid completion | Wall time from dispatch to accepted integrated artifact, including waits, merges, review, and corrections |
| Tail time | Slow or stalled tasks as well as median; failed/unfinished tasks remain visible |
| Human correction burden | Number and duration of interventions; distinguish requirement changes from avoidable corrections |
| First acceptance | Whether the first integrated candidate passes; separately count regressions discovered later |
| Integration overhead | Time reconciling changes, merge conflicts, incompatible assumptions, and stale results |
| Coordination overhead | Time preparing assignments, status handling, summaries, repeated investigation, and reorientation |
| Native validity | Final CAD state correct, reopenable, and consistent with tool reports; no unaccounted side effects |
| Capacity behavior | Queueing, tool contention, rate-limit events, failed spawns, and active worker utilization |

Repeat tasks with controlled fresh starting states and alternate execution order to reduce warm-cache and temporal effects. Report sample size, per-task outcomes, variability, and confidence intervals where justified. Do not report only the fastest successful run; retain failures and unfinished runs. Separate infra failures from reasoning failures while including both in practical time-to-delivery statistics.

Select the fastest policy meeting the required validity and human-intervention thresholds, or present a quality/time frontier when no single mode dominates. Increase concurrency only while enough independent work exists and completed output can be integrated promptly. Reduce it when review backlog, duplicated work, stale assumptions, or resource contention increases. “Ignore cost” removes price optimization; it does not remove finite elapsed time, context limits, coordination delays, or the need for correct artifacts.

## Recommended operating policy

Keep the main Astra agent accountable for the result and able to implement directly. Delegate independent investigation, isolated implementation, and focused review when they contribute useful parallel work. Set ownership and acceptance criteria before dispatch. Give native mutation authority to one owner per session/document, integrate from identifiable baselines, and verify the final state at the appropriate layer. Track real handles and completion evidence. Adapt concurrency to the dependency graph and observed integration capacity, and evaluate the policy using valid-delivery time and human corrections rather than agent count or token economy.

## Sources

Sources were accessed September 9, 2026. Official documentation is mutable; undated pages are identified as such. Paper versions are pinned where findings are version-dependent.

[^1]: OpenAI. [Model guidance: Using GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model). Undated current documentation. Used for Astra delegation, asynchronous-tool responsibility, and proportional verification guidance.
[^2]: OpenAI, ChatGPT Learn. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Undated current documentation; redirected from the Codex multi-agent page. Used for context isolation, parallel-work cautions, inheritance, and lifecycle concepts.
[^3]: OpenAI. [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration). Undated current documentation. Used for manager versus handoff semantics.
[^4]: Anthropic. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents). December 19, 2024; current page carries a tooling-change notice. Original engineering guidance.
[^5]: Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, and Daniel Ford, Anthropic. [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system). June 13, 2025. Original product engineering report and internal research evaluation.
[^6]: Anthropic. [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler). February 5, 2026. Original engineering case report.
[^7]: Yubin Kim et al. [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v3). arXiv:2512.08296v3, April 8, 2026; first version December 9, 2025. Original empirical paper. Relevant sections: experimental setup, robustness and sensitivity analysis, limitations, Appendix E.4, and Table 16.
[^8]: Jiayi Geng and Graham Neubig, Carnegie Mellon University. [Effective Strategies for Asynchronous Software Engineering Agents](https://arxiv.org/html/2603.21489v2). Original author manuscript, arXiv:2603.21489v2, July 8, 2026; first version March 23, 2026. Relevant sections: evaluation protocol, experimental setup, iteration-budget comparison, isolation ablation, degree of parallel execution. Publication record: [arXiv abstract](https://arxiv.org/abs/2603.21489).
[^9]: Nikita Benkovich and Vitalii Valkov. [Agyn: A Multi-Agent System for Team-Based Autonomous Software Engineering](https://arxiv.org/html/2602.01465v2). Original author manuscript, arXiv:2602.01465v2, February 7, 2026; first version February 1, 2026. Relevant sections: system configuration, evaluation protocol, Table 1. Publication record: [arXiv abstract](https://arxiv.org/abs/2602.01465).

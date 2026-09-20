import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { compilePcbDesignIntentDraft, type PcbDesignCompilerOptions } from "../harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, type PcbDesignCompilationBundleDependencies } from "../harness/pcb-design-compilation-bundle.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../harness/pcb-design-contract.js";
import { PCB_DESIGN_INTENT_TOOL } from "../harness/pcb-design-interpreter.js";
import { PCB_DESIGN_INTENT_MODEL_GUIDE, PCB_DESIGN_INTENT_VALID_EXAMPLE } from "../harness/pcb-design-intent-model-guide.js";
import { PCB_PLANE_DRAFT_SCHEMA_VERSION } from "../harness/pcb-design-plane-contract.js";
import { compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy } from "../harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, isAuthenticatedPcbPlaneCompilationBundle } from "../harness/pcb-design-plane-bundle.js";
import { PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA, getPcbPlaneDesignIntentModelGuide,
  PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES, PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE } from "../harness/pcb-design-plane-model-guide.js";
import { PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION } from "../harness/pcb-interface-requirements.js";
import { validateFreshProjectName, assertCurrentPlaneNativeAuthoringScope } from "../harness/fresh-project.js";
import type { createKiCad10StockCatalog } from "../harness/kicad-stock-catalog.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import type { KicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";
import type { KiCadApprovedPackageDescription } from "../harness/kicad-approved-package.js";
import { openFreshNativeToolboxBinding } from "./toolbox-fresh-main.js";
import { createKicadToolboxMcpServer } from "./toolbox-server.js";
import type { ToolboxWorkspaceStore } from "./toolbox-workspace-store.js";
import type { FreshPlaneSchematicSeed } from "../harness/fresh-plane-schematic-seed.js";
import { assertClosedPlaneSchematicSeedSourceCurrent, qualifyClosedPlaneSchematicSeed, type ClosedPlaneSchematicSeedSource } from "./toolbox-schematic-seed.js";
import type { FreshPlanePlacementSeed } from "../harness/fresh-plane-placement-seed.js";
import { assertClosedPlanePlacementRevisionSourceCurrent, qualifyClosedPlanePlacementRevision, type ClosedPlanePlacementRevisionSource } from "./toolbox-placement-revision.js";

export interface KicadToolboxWorkspaceOptions {
  readonly profile: KicadMcpPinnedFileInput;
  readonly store: ToolboxWorkspaceStore;
  readonly dependencies: PcbDesignCompilationBundleDependencies;
  readonly deepRuleSelectionOptions?: PcbDesignCompilerOptions["deepRuleSelectionOptions"];
  readonly access: "read-only" | "edit";
  readonly transmissionLine?: KicadTransmissionLineCalculator;
  readonly inspectLibrary?: (kind: "symbol" | "footprint", libraryId: string) => unknown;
  readonly searchLibrary?: ReturnType<typeof createKiCad10StockCatalog>["search"];
  readonly describeApprovedPackage?: () => KiCadApprovedPackageDescription;
  /** Host/test dependency; never part of the model's tool arguments. */
  readonly openBinding?: typeof openFreshNativeToolboxBinding;
}

const EMPTY = z.object({}).strict();
const DESIGN_FAMILIES = ["routed-v1", "plane-v2"] as const;
const ID = z.string().uuid();
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { ...READ, readOnlyHint: false } as const;
const LIMITS = { maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 100_000, maxArrayLength: 1024,
  maxOwnKeys: 1024, maxKeyBytes: 512, maxStringBytes: 64 * 1024 } as const;
interface PendingDraft {
  readonly projectId: string; readonly name: string; readonly originalPrompt: string; readonly draft: unknown;
  readonly draftIdentity: ContentIdentity; readonly submissionIdentity: string; readonly bundleIdentity: CanonicalIdentity;
}
function result(value: Record<string, unknown>, isError = false) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Workspace result exceeds its response bound.");
  return { content: [{ type: "text" as const, text }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

/** One configured workspace, one active native project; no nested model or MCP server. */
export function createKicadToolboxWorkspace(options: KicadToolboxWorkspaceOptions) {
  const profile = structuredClone(options.profile);
  const store = options.store;
  const dependencies = Object.freeze({ ...options.dependencies });
  const selection = options.deepRuleSelectionOptions === undefined ? undefined : structuredClone(options.deepRuleSelectionOptions);
  const openBinding = options.openBinding ?? openFreshNativeToolboxBinding;
  const access = options.access;
  const toolbox = createKicadToolboxMcpServer({ access,
    ...(options.transmissionLine === undefined ? {} : { transmissionLine: options.transmissionLine }) });
  const pending = new Map<string, PendingDraft>();
  const closedSeedSources = new Map<string, ClosedPlaneSchematicSeedSource>();
  const closedPlacementSources = new Map<string, ClosedPlanePlacementRevisionSource>();
  let active: { projectId: string; phase: "opening" | "active" | "needs-review"; error: string | undefined;
    lease: { release(): Promise<void> } } | undefined;
  let lifecycle: Promise<void> = Promise.resolve();
  let stopping = false;
  let closing: Promise<void> | undefined;
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const job = lifecycle.then(async () => {
      if (stopping) throw new Error("Workspace connection is closing.");
      return await operation();
    });
    lifecycle = job.then(() => undefined, () => undefined);
    return job;
  };
  const respond = async (operation: () => Promise<Record<string, unknown>> | Record<string, unknown>) => {
    try { return result(await operation()); }
    catch (error) { return result({ error: error instanceof Error ? error.message : String(error) }, true); }
  };
  /** Preview and pre-allocation recheck must reproduce the same exact draft family. */
  function compileDraft(draft: unknown, originalPrompt: string) {
    const schemaVersion = draft !== null && typeof draft === "object" && !Array.isArray(draft)
      ? (draft as Record<string, unknown>).schemaVersion : undefined;
    switch (schemaVersion) {
      case PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION: {
        const compilation = compilePcbDesignIntentDraft(draft, { libraryResolver: dependencies.libraryResolver,
          deepRuleCatalog: dependencies.deepRuleCatalog, ...(selection === undefined ? {} : { deepRuleSelectionOptions: selection }) });
        if (compilation.disposition !== "ready") return { status: compilation.disposition, compilation };
        const bundle = createPcbDesignCompilationBundle({ originalPrompt, compilation }, dependencies);
        return { status: "ready" as const, compilation, bundleIdentity: bundle.identity, bundle };
      }
      case PCB_PLANE_DRAFT_SCHEMA_VERSION: {
        // V2 has its own bounded selection policy and no V1 compiler profile.
        const planeDependencies = { libraryResolver: dependencies.libraryResolver, deepRuleCatalog: dependencies.deepRuleCatalog,
          deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(selection) };
        const compilation = compilePcbPlaneDesignIntentDraft(draft, planeDependencies);
        if (compilation.disposition !== "ready") return { status: compilation.disposition, compilation };
        const bundle = createPcbPlaneCompilationBundle({ originalPrompt, compilation }, planeDependencies);
        return { status: "ready" as const, compilation, bundleIdentity: bundle.identity, bundle };
      }
      default: throw new Error(`Unsupported or missing draft schemaVersion; use ${PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION} or ${PCB_PLANE_DRAFT_SCHEMA_VERSION}.`);
    }
  }
  function reconcileNativeState() {
    if (active?.phase === "active" && ["uncertain", "closed", "absent"].includes(toolbox.getCadState())) {
      active.phase = "needs-review";
      active.error = "Native finalization did not release this project's lease; inspect the prior native result before recovery.";
    }
  }
  function ensureIdle() {
    reconcileNativeState();
    if (active !== undefined) throw new Error(`Project ${active.projectId} is ${active.phase}; finish it before opening another.`);
    const state = toolbox.getCadState();
    if (state === "closed") toolbox.detachCad();
    else if (state !== "absent") throw new Error(`Native binding is ${state}; host review or confirmed finish is required.`);
  }
  async function openProject(projectId: string, resume: boolean, expectedBundleIdentity?: CanonicalIdentity, schematicSeed?: FreshPlaneSchematicSeed,
    beforeAttach?: () => Promise<void>, placementSeed?: FreshPlanePlacementSeed) {
    ensureIdle();
    const record = await store.lookup(projectId);
    if (record === undefined) throw new Error("Unknown workspace project.");
    if (record.runtimeSourceImportLineage !== undefined && canonicalJson(record.runtimeSourceImportLineage.targetProfile) !== canonicalJson(profile)) {
      throw new Error("Runtime-imported projects require their exact qualified target profile; ordinary resume cannot change it.");
    }
    closedSeedSources.delete(projectId);
    closedPlacementSources.delete(projectId);
    const owned = { projectId, phase: "opening" as "opening" | "active" | "needs-review", lease: await store.acquireLease(projectId), error: undefined as string | undefined };
    active = owned;
    try {
      const binding = await openBinding({ profile, projectDir: record.inputDir, outputDir: record.outputDir,
        edit: access === "edit", resume,
        fresh: { ...(resume ? { name: record.name } : { name: record.name, draft: record.draft,
          originalPrompt: record.originalPrompt, ...(expectedBundleIdentity === undefined ? {} : { expectedBundleIdentity }),
          ...(schematicSeed === undefined ? {} : { schematicSeed }), ...(placementSeed === undefined ? {} : { placementSeed }) }),
          ...(record.placementRevisionLineage === undefined ? {} : { placementRevisionLineage: record.placementRevisionLineage }) } });
      try {
        await beforeAttach?.();
        if (binding.cad.prepareCheckpoint === undefined) throw new Error("Workspace projects require a checkpoint-capable native binding.");
        toolbox.attachCad({ cad: binding.cad, access: binding.access, compoundContractIdentity: binding.compoundContractIdentity,
          designContext: () => ({ ...binding.designContext(), ...(record.schematicSeedLineage === undefined ? {} : { schematicSeedLineage: record.schematicSeedLineage }),
            ...(record.placementRevisionLineage === undefined ? {} : { placementRevisionLineage: record.placementRevisionLineage }),
            ...(record.runtimeSourceImportLineage === undefined ? {} : { runtimeSourceImportLineage: record.runtimeSourceImportLineage }) }), onFinished: async outcome => {
            if (!outcome.nativeSessionClosed || !outcome.checkpointPublished || outcome.recoveryRequired) throw new Error("Project lease retained because native finalization/checkpoint requires review.");
            const seedSource = await binding.captureClosedSchematicSeedSource?.();
            const placementSource = await binding.captureClosedPlacementRevisionSource?.();
            try { await owned.lease.release(); }
            catch (error) { owned.phase = "needs-review"; throw error; }
            if (seedSource !== undefined) {
              while (closedSeedSources.size >= 16) closedSeedSources.delete(closedSeedSources.keys().next().value!);
              closedSeedSources.set(projectId, seedSource);
            }
            if (placementSource !== undefined) {
              while (closedPlacementSources.size >= 16) closedPlacementSources.delete(closedPlacementSources.keys().next().value!);
              closedPlacementSources.set(projectId, placementSource);
            }
            if (active === owned) active = undefined;
          } });
      } catch (error) {
        // If attachment accepted ownership, let its guarded finalizer own close.
        // Otherwise close the unused binding without pretending it checkpointed.
        try {
          if (toolbox.getCadState() !== "absent") await toolbox.finishCad();
          else {
            const failures: unknown[] = [];
            try { await binding.cad.recordRecoveryRequired?.("Workspace attachment failed before a checkpointed session was established."); }
            catch (failure) { failures.push(failure); }
            try { await binding.cad.close(); } catch (failure) { failures.push(failure); }
            if (failures.length) throw new AggregateError(failures, "Unused workspace binding recovery/close requires review.");
          }
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Workspace CAD attachment failed and guarded cleanup was not confirmed.");
        }
        throw error;
      }
      owned.phase = "active";
      return { status: "opened", projectId, name: record.name, resumed: resume, access,
        ...(record.placementRevisionLineage === undefined ? {} : { placementRevisionLineage: record.placementRevisionLineage }),
        ...(record.schematicSeedLineage === undefined ? {} : { schematicSeedLineage: record.schematicSeedLineage }),
        ...(record.runtimeSourceImportLineage === undefined ? {} : { runtimeSourceImportLineage: record.runtimeSourceImportLineage }),
        outputPath: record.outputDir, projectPath: path.join(record.outputDir, "project"),
        instruction: "Refresh the tool list, read evleda_design_context, then author and verify the native project. Opening is not design completion." };
    } catch (error) {
      owned.phase = "needs-review"; owned.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Project ${projectId} did not open cleanly; its allocation/lease is retained for host review. ${owned.error}`, { cause: error });
    }
  }

  toolbox.server.registerTool("evleda_workspace_status", { description: "Inspect this connection's project lifecycle and pending drafts without starting KiCad.", inputSchema: EMPTY, annotations: READ },
    async () => respond(() => { reconcileNativeState(); return { access, nativeState: toolbox.getCadState(), activeProject: active === undefined ? null
      : { projectId: active.projectId, phase: active.phase, error: active.error ?? null },
      pendingDrafts: [...pending.values()].map(draft => ({ draftId: draft.projectId, name: draft.name })), stopping }; }));
  toolbox.server.registerTool("evleda_design_schema", { description: "Get a complete design-intent schema, model guide and valid example. routed-v1 is the default; plane-v2 supports one bounded rectangular ground plane, optional differential-pair interfaceRequirements, externalPowerInputs at connector pins and source-bound derivedPowerSources through declared L/R or explicit external-input forward Schottky paths. Discover supportedFamilies here. Unknown requirements remain null for clarification.",
    inputSchema: z.object({ family: z.enum(DESIGN_FAMILIES).optional(), includeChannel: z.boolean().optional(), includeFeedThrough: z.boolean().optional() }).strict(), annotations: READ },
    async args => respond(() => {
      const family = args.family ?? "routed-v1";
      return { family, supportedFamilies: [...DESIGN_FAMILIES],
        ...(options.describeApprovedPackage === undefined ? {} : { approvedPackage: options.describeApprovedPackage() }),
        schema: structuredClone(family === "plane-v2" ? PCB_PLANE_DESIGN_INTENT_JSON_SCHEMA : PCB_DESIGN_INTENT_TOOL.inputSchema),
        guide: family === "plane-v2" ? getPcbPlaneDesignIntentModelGuide(true, true, args.includeChannel === true || args.includeFeedThrough === true, true, args.includeFeedThrough === true) : PCB_DESIGN_INTENT_MODEL_GUIDE,
        ...(family === "plane-v2" ? {
          guideMaxUtf8Bytes: PCB_PLANE_DESIGN_INTENT_EXTENDED_MODEL_GUIDE_MAX_UTF8_BYTES,
          optionalRequirements: { boardFeatures: { kinds: ["npth_mounting_hole"], schematicComponentsAdded: false,
            electricalTerminalsAdded: false, boardOnlyFootprints: true,
            instruction: "Declare the exact approved footprint ID, unique H reference, front cardinal pose, bore diameter and hole-to-copper/edge bounds. Only source-inspected centered circular NPTH features without pad numbers or nets are supported. The first successful schematic sync materializes these board-only footprints; do not add schematic symbols, electrical pins or BOM parts. Complete source, geometry, disposition and native clearance checks remain required." },
            interfaceRequirements: { schemaVersion: PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION,
            kinds: ["differential_pair"], sourceAuthority: "caller_asserted_intent", physicalVerification: "not_performed" },
            externalPowerInputs: { sourceAuthority: "caller_asserted_external_supply", physicalComponentsAdded: false,
              instruction: "Declare supplyEndpoint and returnEndpoint on existing connector pins; the host binds schematic-only PWR_FLAG annotations. Do not add flag components or physical endpoints." },
            derivedPowerSources: { sourceAuthority: "source_inspected_driver_and_caller_reviewed_path", physicalComponentsAdded: false,
              instruction: "Declare source citation and operatingAssumptions. Without externalPowerInput, use an inspected power_out driver, stock Device:L/Device:R path and source GND return. The optional externalPowerInput={id,diodeForwardDropAssumption,operatingModes} instead requires the exact bound external connector supply, one stock Device:D_Schottky step 2/A to 1/K, an inspected power_in consumer and its GND/PGND return on the same external ground. Keep downstream rails internal. The host verifies complete saved pins and upstream/path/return nets; assertions are not electrical qualification." } },
        } : {}),
        example: structuredClone(family === "plane-v2" ? PCB_PLANE_DESIGN_INTENT_VALID_EXAMPLE : PCB_DESIGN_INTENT_VALID_EXAMPLE),
        instruction: "Use evleda_submit_design with the complete draft, name and original request; no local draft file is needed." };
    }));
  toolbox.server.registerTool("evleda_submit_design", { description: "Compile a routed-v1 or plane-v2 structured design draft using approved libraries and guidance. The exact draft schemaVersion selects its compiler. Return clarification/unsupported issues in chat, or a ready draft ID. Does not create project files or open KiCad.",
    inputSchema: z.object({ name: z.string().min(1).max(64), originalPrompt: z.string().trim().min(1).max(32_768), draft: z.unknown() }).strict(), annotations: READ },
    async args => respond(() => {
      if (stopping) throw new Error("Workspace connection is closing.");
      const name = validateFreshProjectName(args.name);
      const draft = hardenPortableValue(args.draft, LIMITS);
      const draftIdentity = contentIdentity(Buffer.from(canonicalJson(draft)));
      const preview = compileDraft(draft, args.originalPrompt);
      const compilation = preview.compilation;
      if (preview.status !== "ready") return { status: preview.status, compilation, projectCreated: false };
      const submissionIdentity = contentIdentity(Buffer.from(canonicalJson({ name, originalPrompt: args.originalPrompt, draftIdentity, bundleIdentity: preview.bundleIdentity }))).digest;
      const existing = [...pending.values()].find(value => value.submissionIdentity === submissionIdentity);
      if (existing !== undefined) return { status: "ready", draftId: existing.projectId, compilation, bundleIdentity: existing.bundleIdentity, projectCreated: false };
      if (pending.size >= 16) throw new Error("Sixteen ready drafts are already retained; create or discard one before adding another.");
      const projectId = randomUUID();
      pending.set(projectId, { projectId, name, originalPrompt: args.originalPrompt, draft, draftIdentity, submissionIdentity, bundleIdentity: preview.bundleIdentity });
      return { status: "ready", draftId: projectId, compilation, bundleIdentity: preview.bundleIdentity, projectCreated: false };
    }));
  toolbox.server.registerTool("evleda_discard_draft", { description: "Forget one uncreated in-memory draft. Does not remove native projects or files.",
    inputSchema: z.object({ draftId: ID }).strict(), annotations: WRITE }, async args => respond(() => ({ discarded: pending.delete(args.draftId) })));
  toolbox.server.registerTool("evleda_create_project", { description: "Create and open a ready draft in this host-approved workspace. Optional sourceProjectId copies exact unwired V2 schematic bytes after a healthy close in this connection/profile. The same project name and circuit are required; only PCB width/height, component placement, board-feature pose coordinates/rotation, plane rectangle coordinates, net-class settings/assignments, routing constraints, native numeric mode and prompt metadata may differ. Board shape/layers, board-feature inventory/definitions/side, plane identity/settings, interface/construction, components, values, electrical nets and libraries remain exact. Source PCB must be its authenticated unmaterialized baseline. New PCB/rules are generated normally. Retry with the same draft/source IDs; no allocation is overwritten. Requires edit access; native startup may take over a minute.",
    inputSchema: z.object({ draftId: ID, sourceProjectId: ID.optional() }).strict(), annotations: WRITE }, async args => respond(() => serialize(async () => {
      reconcileNativeState();
      const existing = await store.lookup(args.draftId);
      if (existing !== undefined) {
        if (existing.placementRevisionLineage !== undefined) throw new Error("Existing allocation was created through placement revision; use that operation or resume it.");
        if (existing.schematicSeedLineage?.sourceProjectId !== args.sourceProjectId) throw new Error("Existing allocation has a conflicting schematic source selection; nothing was overwritten.");
        return { status: "already_created", projectId: existing.projectId,
          active: active?.projectId === existing.projectId && active.phase === "active" && toolbox.getCadState() === "active", instruction: "Resume this project if it is not already active; do not recreate it." };
      }
      if (access !== "edit") throw new Error("Project creation requires host-configured edit access.");
      ensureIdle();
      const draft = pending.get(args.draftId);
      if (draft === undefined) throw new Error("Unknown ready draft; submit it again before creating a project.");
      const preview = compileDraft(draft.draft, draft.originalPrompt);
      if (preview.status !== "ready") return { status: preview.status, compilation: preview.compilation, projectCreated: false };
      if (canonicalJson(preview.bundleIdentity) !== canonicalJson(draft.bundleIdentity)) throw new Error("Compilation changed since preview; resubmit and review the new result before creation.");
      if (isAuthenticatedPcbPlaneCompilationBundle(preview.bundle)) assertCurrentPlaneNativeAuthoringScope(preview.bundle);
      if (args.sourceProjectId === undefined) {
        const allocation = await store.allocate(draft);
        pending.delete(args.draftId);
        if (!allocation.created) return { status: "already_created", projectId: allocation.projectId, active: false };
        return await openProject(allocation.projectId, false, draft.bundleIdentity);
      }
      if (!isAuthenticatedPcbPlaneCompilationBundle(preview.bundle)) throw new Error("Schematic seeding is limited to the V2 plane family.");
      const receipt = closedSeedSources.get(args.sourceProjectId), source = await store.lookup(args.sourceProjectId);
      if (receipt === undefined || source === undefined) throw new Error("Source needs a genuine successful close in this current workspace connection/profile.");
      const lease = await store.acquireLease(args.sourceProjectId);
      let primary: unknown;
      let sourceReleased = false;
      const releaseSource = async () => {
        await assertClosedPlaneSchematicSeedSourceCurrent(receipt); await lease.assertCurrent?.(); await lease.release(); sourceReleased = true;
      };
      try {
        if (lease.assertCurrent === undefined) throw new Error("Schematic seeding requires a source lease with current ownership verification.");
        const qualified = await qualifyClosedPlaneSchematicSeed({ receipt, sourceProjectId: source.projectId, sourceOutputDir: source.outputDir,
          targetProjectId: draft.projectId, name: draft.name, targetBundle: preview.bundle, profile, assertLeaseCurrent: lease.assertCurrent });
        const allocation = await store.allocate({ ...draft, schematicSeedLineage: qualified.lineage });
        pending.delete(args.draftId);
        if (!allocation.created) return { status: "already_created", projectId: allocation.projectId, active: false };
        return await openProject(allocation.projectId, false, draft.bundleIdentity, qualified.seed, releaseSource);
      } catch (error) { primary = error; throw error; }
      finally {
        try { if (!sourceReleased) await releaseSource(); }
        catch (error) { closedSeedSources.delete(args.sourceProjectId); throw new AggregateError(primary === undefined ? [error] : [primary, error], "Source currentness could not be confirmed; its lease and any new allocation were retained for review."); }
      }
    })));
  for (const revisionKind of ["placement", "via-budgets", "plane-regions", "terminal-launches"] as const) toolbox.server.registerTool(
    revisionKind === "placement" ? "evleda_revise_placement" : revisionKind === "via-budgets" ? "evleda_revise_via_budgets"
      : revisionKind === "plane-regions" ? "evleda_revise_plane_regions" : "evleda_revise_terminal_launches", {
    description: revisionKind === "placement"
      ? "Create and open a separate V2 project from a ready placement-only revision draft and a fully materialized source closed successfully in this connection/profile. The same name is required. Only placement constraints and original-prompt metadata may change; circuit, components, board, stackup, routing limits, planes, interfaces and libraries stay exact. Preserve schematic, functional footprints and existing tracks/vias; rebind owned mounting-feature UUIDs, plane names and netclass names. No component moves occur automatically. Refilling and all affected native checks remain required; no fill freshness or acceptance is copied. Repeating the same draft/source IDs never overwrites an allocation."
      : revisionKind === "via-budgets" ? "Create and open a separate V2 project from a ready draft that explicitly reallocates per-net via-count budgets, and a materialized source successfully closed in this connection/profile. Same project name required. Only bounded per-net maxVias changes on nets without continuous-reference requirements and original-prompt metadata may differ. A new count cannot be lower than that net's existing native via count. Global via limits, via dimensions, clearances, widths, lengths, turn rules, reference requirements, placement, interfaces, circuit, libraries and stackup stay exact. Existing native geometry and schematic are preserved. Original allocation is retained. Refill and fresh affected checks are required; no acceptance or fill freshness is transferred."
      : revisionKind === "plane-regions" ? "Create and open a separate V2 project from an explicit ready supplemental-region policy revision and a materialized source successfully closed in this connection/profile. Same project name required. Only a supplemental plane's single-component versus primary-anchored-region policy and its explicit reference/rationale may change. Area floors, island removal, primary/reference-plane requirements, native settings, circuit, placement, stackup, routing, interfaces and libraries stay exact. Geometry and schematic are preserved; the old allocation and its failed policy are retained. No acceptance or fresh fill is transferred. Refill, verify every region's native/source via contact and retained-area bound, and retain independent global continuity requirements."
      : "Create and open a separate V2 project from explicit ready terminal-launch declarations and a materialized source normally closed in this connection/profile. Same name required. Only bounded launch declarations and rationale may differ; full body margins, reference terminal assignments, circuit, placement, copper, via/route limits, native settings, planes, interfaces and libraries stay exact. Source geometry must support the declared through-hole approaches before allocation. Preserve the original project and its findings. No fill freshness or acceptance transfers. Refill and verify native terminal geometry, local direct return anchors, foreign-bore separation, native clearances and body coverage; complete electrical acceptance remains separate.",
    inputSchema: z.object({ draftId: ID, sourceProjectId: ID }).strict(), annotations: WRITE,
  }, async args => respond(() => serialize(async () => {
    reconcileNativeState();
    const existing = await store.lookup(args.draftId);
    if (existing !== undefined) {
      const expectedLineage = revisionKind === "placement" ? "evleda.plane-placement-revision-lineage.v1"
        : revisionKind === "via-budgets" ? "evleda.plane-via-budget-revision-lineage.v1"
          : revisionKind === "plane-regions" ? "evleda.plane-region-policy-revision-lineage.v1" : "evleda.plane-terminal-launch-revision-lineage.v1";
      if (existing.placementRevisionLineage?.sourceProjectId !== args.sourceProjectId
        || existing.placementRevisionLineage.schemaVersion !== expectedLineage) throw new Error("Existing allocation has a conflicting revision kind or source; nothing was overwritten.");
      return { status: "already_created", projectId: existing.projectId,
        active: active?.projectId === existing.projectId && active.phase === "active" && toolbox.getCadState() === "active",
        instruction: "Resume this project if it is not active; do not recreate it." };
    }
    if (access !== "edit") throw new Error("Placement revision requires host-configured edit access.");
    ensureIdle();
    const draft = pending.get(args.draftId);
    if (draft === undefined) throw new Error("Unknown ready draft; submit the complete revised intent first.");
    const preview = compileDraft(draft.draft, draft.originalPrompt);
    if (preview.status !== "ready") return { status: preview.status, compilation: preview.compilation, projectCreated: false };
    if (!isAuthenticatedPcbPlaneCompilationBundle(preview.bundle)) throw new Error("Placement revision requires the V2 plane family.");
    if (canonicalJson(preview.bundleIdentity) !== canonicalJson(draft.bundleIdentity)) throw new Error("Compilation changed since preview; resubmit and review the new result.");
    const receipt = closedPlacementSources.get(args.sourceProjectId), source = await store.lookup(args.sourceProjectId);
    if (receipt === undefined || source === undefined) throw new Error("Source needs a genuine successful materialized close in this current workspace connection/profile.");
    const lease = await store.acquireLease(source.projectId);
    let primary: unknown; let sourceReleased = false;
    const releaseSource = async () => {
      await assertClosedPlanePlacementRevisionSourceCurrent(receipt); await lease.assertCurrent?.(); await lease.release(); sourceReleased = true;
    };
    try {
      if (lease.assertCurrent === undefined) throw new Error("Placement revision requires current source-lease ownership checks.");
      const qualified = await qualifyClosedPlanePlacementRevision({ receipt, sourceProjectId: source.projectId, sourceOutputDir: source.outputDir,
        targetProjectId: draft.projectId, name: draft.name, targetBundle: preview.bundle, profile, assertLeaseCurrent: lease.assertCurrent, revisionKind });
      const allocation = await store.allocate({ ...draft, placementRevisionLineage: qualified.lineage });
      pending.delete(args.draftId);
      if (!allocation.created) return { status: "already_created", projectId: allocation.projectId, active: false };
      return await openProject(allocation.projectId, false, draft.bundleIdentity, undefined, releaseSource, qualified.seed);
    } catch (error) { primary = error; throw error; }
    finally {
      try { if (!sourceReleased) await releaseSource(); }
      catch (error) { closedPlacementSources.delete(args.sourceProjectId); throw new AggregateError(primary === undefined ? [error] : [primary, error],
        "Placement source currentness could not be confirmed; its lease and any target allocation were retained for review."); }
    }
  })));
  toolbox.server.registerTool("evleda_list_projects", { description: "List immutable allocations in this approved workspace. A listed project is not proof of a valid checkpoint or a completed design.",
    inputSchema: z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), annotations: READ },
    async args => respond(async () => ({ ...(await store.list({ ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args.limit === undefined ? {} : { limit: args.limit }) })), checkpointValidity: "verified only when resuming" })));
  toolbox.server.registerTool("evleda_resume_project", { description: "Open an existing workspace project by its opaque ID using its saved bundle and native checkpoint. Accepts no replacement draft or runtime paths.",
    inputSchema: z.object({ projectId: ID }).strict(), annotations: WRITE }, async args => respond(() => serialize(async () => {
      reconcileNativeState();
      if (active?.projectId === args.projectId && active.phase === "active" && toolbox.getCadState() === "active") return { status: "already_active", projectId: args.projectId };
      return await openProject(args.projectId, true);
    })));
  toolbox.server.registerTool("evleda_close_project", { description: "Finish the active project's existing guarded native lifecycle and release its workspace lease after confirmed close. Does not approve the design or delete files.",
    inputSchema: z.object({ projectId: ID }).strict(), annotations: WRITE }, async args => respond(() => serialize(async () => {
      reconcileNativeState();
      if (active === undefined) return { status: "not_active_in_this_connection", projectId: args.projectId };
      if (active.projectId !== args.projectId || active.phase !== "active") throw new Error("Requested project is not a clean active binding in this connection.");
      await toolbox.finishCad(); toolbox.detachCad();
      return { status: "closed", projectId: args.projectId, designAcceptance: "not_implied" };
    })));
  if (options.inspectLibrary !== undefined) toolbox.server.registerTool("evleda_inspect_library", {
    description: "Inspect an exact symbol or footprint ID through the host-approved stock and optional package resolver. Package IDs are discoverable in evleda_design_schema when configured. Reports current source identity and supported native geometry; does not qualify a component electrically. Unknown or unsupported items are not replaced with guesses.",
    inputSchema: z.object({ kind: z.enum(["symbol", "footprint"]), libraryId: z.string().min(1).max(192) }).strict(), annotations: READ,
  }, async args => respond(() => { const inspection = options.inspectLibrary!(args.kind, args.libraryId); return { found: inspection !== null, inspection }; }));
  if (options.searchLibrary !== undefined) toolbox.server.registerTool("evleda_search_library", {
    description: "Search host-approved KiCad 10 stock namespaces without opening CAD. Results are discovery candidates, not inspected or electrically qualified parts. Follow single-use nextCursor until exhausted; restart the search after a lost cursor response. complete also requires no unsupported source coverage. Inspect selected IDs with evleda_inspect_library before drafting. Sources are read separately, not as an atomic installation snapshot.",
    inputSchema: z.object({ kind: z.enum(["symbol", "footprint"]), query: z.string().trim().max(128).regex(/^[A-Za-z0-9 _.:+@~-]*$/u),
      library: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.+@~-]{0,127}$/u).optional(),
      limit: z.number().int().min(1).max(100).optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{32}$/u).optional() }).strict(), annotations: { ...READ, idempotentHint: false },
  }, async args => respond(() => ({ ...options.searchLibrary!({ kind: args.kind, query: args.query,
    ...(args.library === undefined ? {} : { library: args.library }), ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }) }) })));

  return Object.freeze({ server: toolbox.server,
    close: () => closing ??= (async () => {
      stopping = true; await lifecycle; await toolbox.close();
      if (active !== undefined) throw new Error(`Project ${active.projectId} still requires host review; its lease was retained.`);
    })() });
}

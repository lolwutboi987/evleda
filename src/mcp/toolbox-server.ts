import { McpServer, ResourceTemplate, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { CallToolResult, JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { sha256 } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { harnessToolDefinitionSchema, harnessToolResultSchema, type HarnessToolCall } from "../harness/contracts.js";
import { kicadHarnessToolEffect, type KicadHarnessToolName } from "../harness/kicad-tools.js";
import { compoundMutationState, mutationBatchDispositionSchema } from "../harness/pcb-agent-harness.js";
import { parsePcbExternalPowerBinding } from "../harness/pcb-external-power.js";
import { parsePcbDerivedPowerBinding } from "../harness/pcb-derived-power.js";
import { loadDeepRuleResource, selectDeepRules, type DeepRuleSelector } from "../harness/deep-rule-catalog.js";
import type { ConnectedKicadToolbox } from "./toolbox-session.js";
import { kicadTransmissionLineRequestSchema, type KicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";
import { toolboxReferenceCoverageQuerySchema } from "./toolbox-reference-coverage.js";
import { snapshotToolboxSavedMicrostripRequest, toolboxSavedMicrostripErrorMessage, toolboxSavedMicrostripQuerySchema } from "./toolbox-saved-microstrip.js";
import { snapshotToolboxInterfaceQuery, TOOLBOX_INTERFACE_ERROR, toolboxInterfaceQuerySchema } from "./toolbox-interface.js";
import { readToolboxReferenceArtifact, type ToolboxReferenceArtifact } from "./toolbox-reference-resource.js";
import { planeCompoundMutationState } from "./toolbox-plane-results.js";

const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_GUIDANCE_BYTES = 1024 * 1024;
const EMPTY = z.object({}).strict();
const TEXT_SELECTOR = z.array(z.string().trim().min(1).max(128)).min(1).max(32).optional();
const RULE_QUERY = z.object({
  topics: TEXT_SELECTOR, tags: TEXT_SELECTOR, ids: TEXT_SELECTOR, categories: TEXT_SELECTOR,
  severities: z.array(z.enum(["advisory", "warning", "error", "critical"])).min(1).max(4).optional(),
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();
const GUIDE_QUERY = z.object({ topic: z.string().trim().min(1).max(128) }).strict();
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const PLANE_APPLY = "fresh_apply_contract_plane";
const COMPOUNDS = new Set(["fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement", "fresh_autoplace_schematic_fields", "fresh_replace_route_items", "fresh_sync_from_schematic", PLANE_APPLY]);
const SCHEMATIC_MUTATIONS = new Set(["sch_apply_plan", "sch_add_symbol", "sch_modify_property", "lib_assign_footprint", "sch_move_symbol", "fresh_apply_contract_connectivity", "fresh_apply_recommended_schematic_placement", "fresh_autoplace_schematic_fields"]);

export interface KicadToolboxServerOptions {
  /** Already-bound host capability; never constructed from a model tool argument. */
  readonly cad?: ConnectedKicadToolbox;
  /** Explicit host policy. A client cannot enable editing through a tool call. */
  readonly access?: "read-only" | "edit";
  /** Required when exposing an existing contract-bound compound mutation. */
  readonly compoundContractIdentity?: CanonicalIdentity;
  /** Host-bound design context for fresh authoring; no model input is evaluated. */
  readonly designContext?: () => Readonly<Record<string, unknown>>;
  /** Optional host-pinned analytical calculator, independent of CAD edit access. */
  readonly transmissionLine?: KicadTransmissionLineCalculator;
}

export type KicadToolboxCadAttachment = Pick<KicadToolboxServerOptions, "access" | "compoundContractIdentity" | "designContext"> & {
  readonly cad: ConnectedKicadToolbox;
  readonly onFinished?: (outcome: { nativeSessionClosed: boolean; checkpointPublished: boolean; recoveryRequired: boolean }) => Promise<void>;
};
export type KicadToolboxCadState = "absent" | "active" | "finishing" | "closed" | "uncertain";

export interface KicadToolboxMcpServer {
  /** Host-owned already-open capability; rejects active or uncertain bindings. */
  attachCad(options: KicadToolboxCadAttachment): void;
  /** Drain, close, checkpoint and notify the owning host without closing MCP. */
  finishCad(): Promise<void>;
  /** Remove project tools only after finishCad has confirmed teardown. */
  detachCad(): void;
  getCadState(): KicadToolboxCadState;
  readonly server: McpServer;
  /** Hosts must await this, rather than closing only the protocol transport. */
  close(): Promise<void>;
}

function jsonResult(value: Record<string, unknown>, isError = false): CallToolResult {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_GUIDANCE_BYTES) throw new Error("Toolbox result is too large; request a smaller selection.");
  return { content: [{ type: "text", text }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): CallToolResult {
  return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true);
}

/** Keep advertised schemas and runtime validation aligned without coercing tool input. */
function nativeInputSchema(schema: Record<string, unknown>): StandardSchemaWithJSON {
  const detached = structuredClone(schema);
  const validate = new AjvJsonSchemaValidator().getValidator(detached as JsonSchemaType);
  return {
    "~standard": {
      version: 1, vendor: "evleda-toolbox",
      validate(value: unknown) {
        let bytes: string | undefined;
        try { bytes = JSON.stringify(value); } catch { /* reported below */ }
        if (bytes === undefined || Buffer.byteLength(bytes, "utf8") > MAX_ARGUMENT_BYTES) {
          return { issues: [{ message: "Tool arguments exceed their JSON boundary." }] };
        }
        const result = validate(value);
        return result.valid ? { value } : { issues: [{ message: "Tool arguments do not match the advertised schema." }] };
      },
      jsonSchema: { input: () => structuredClone(detached), output: () => structuredClone(detached) },
    },
  };
}

/**
 * Direct MCP composition over existing host-bound CAD tools. It does not create
 * a provider, application lifecycle, native session, or fresh-project authority.
 */
export function createKicadToolboxMcpServer(options: KicadToolboxServerOptions = {}): KicadToolboxMcpServer {
  const transmissionLine = options.transmissionLine;
  let tail: Promise<void> = Promise.resolve();
  let connectionClosed = false;
  let closing: Promise<void> | undefined;
  type Binding = { finish(): Promise<void>; state(): Exclude<KicadToolboxCadState, "absent">;
    status(): Promise<Record<string, unknown>>; remove(): void };
  let binding: Binding | undefined;
  const server = new McpServer({ name: "evleda-toolbox", version: "0.1.0" }, {
    instructions: "KiCad tools and source-backed design guidance. Only advertised tools are available. CAD access is supplied by the owning host; tool calls cannot select a runtime or authorize another project. Mutations are followed by the existing save/readback boundary. Native check results and research guidance do not certify engineering suitability or manufacturing readiness.",
  });
  const previewResources = new Map<string, { path: string; sha256: string; size: number }>();
  const referenceResources = new Map<string, ToolboxReferenceArtifact>();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(async () => {
      if (connectionClosed) throw new Error("Toolbox connection is closed.");
      return await work();
    });
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  server.registerTool("evleda_toolbox_status", {
    description: "Report host-bound CAD access and recovery state. Guidance-only mode does not imply an active KiCad session.",
    inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
  }, async () => {
    const current = binding;
    return jsonResult({ ...(current === undefined
    ? { cadBound: false, cadConnected: false, connectionProblem: null, access: "guidance-only", recoveryRequired: false, closed: connectionClosed, cadTools: [] }
    : await current.status()), cadState: current?.state() ?? "absent",
    calculationTools: options.transmissionLine === undefined ? [] : ["evleda_transmission_line"],
    assurance: "Capability availability only; not a design acceptance result." });
  });

  if (options.transmissionLine !== undefined) server.registerTool("evleda_transmission_line", {
    description: "Analyze or synthesize uniform microstrip/stripline and coupled pairs using the host-pinned KiCad calculation core. Supply explicit SI cross-section/material/frequency inputs. Returns model results and limitations, not saved-board impedance verification or manufacturing approval. Coupled targetOhm is differential impedance.",
    inputSchema: nativeInputSchema({ type: "object", ...z.toJSONSchema(kicadTransmissionLineRequestSchema) }),
    annotations: READ_ANNOTATIONS,
  }, async args => {
    try {
      const result = await enqueue(async () => await options.transmissionLine!.calculate(args));
      return jsonResult({ ...result, boardVerificationPerformed: false }, result.status !== "calculated");
    } catch (error) { return failure(error); }
  });

  // One connection-wide immutable preview registry survives finished bindings.
  let previewResourceRegistered = false;
  const ensurePreviewResource = () => {
    if (previewResourceRegistered) return;
    server.registerResource("pcb-preview", new ResourceTemplate("evleda://pcb-preview/{digest}/{view}", { list: undefined }),
      { mimeType: "image/svg+xml", description: "Immutable native SVG from a recent source-bound preview; this snapshot may precede later edits." },
      async (uri, variables) => {
        if (typeof variables.digest !== "string" || !/^[a-f0-9]{64}$/u.test(variables.digest)
          || !["top", "assembly"].includes(String(variables.view))) throw new Error("Invalid native preview resource.");
        const resource = previewResources.get(uri.href);
        if (resource === undefined) throw new Error("Native preview is unavailable or expired; render it again.");
        const file = await lstat(resource.path);
        if (!file.isFile() || file.isSymbolicLink() || file.size !== resource.size || file.size > 8 * 1024 * 1024) throw new Error("Native preview artifact changed.");
        const bytes = await readFile(resource.path);
        if (bytes.length !== resource.size || sha256(bytes) !== resource.sha256) throw new Error("Native preview artifact changed.");
        return { contents: [{ uri: uri.href, mimeType: "image/svg+xml", text: bytes.toString("utf8") }] };
      });
    previewResourceRegistered = true;
  };

  let referenceResourceRegistered = false;
  const ensureReferenceResource = () => {
    if (referenceResourceRegistered) return;
    server.registerResource("reference-coverage", new ResourceTemplate("evleda://reference-coverage/{digest}", { list: undefined }),
      { mimeType: "application/json", description: "Immutable selected-fill geometry diagnostics, including exact input echo. Historical snapshot only, not current electrical or impedance approval." },
      async (uri, variables) => {
        if (typeof variables.digest !== "string" || !/^[a-f0-9]{64}$/u.test(variables.digest)) throw new Error("Invalid reference-coverage resource.");
        const artifact = referenceResources.get(uri.href);
        if (artifact === undefined) throw new Error("Reference-coverage resource is unavailable or expired; inspect the board again.");
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: await readToolboxReferenceArtifact(artifact) }] };
      });
    referenceResourceRegistered = true;
  };

  server.registerTool("evleda_rule_topics", {
    description: "List the research topics and source dossiers available to guide PCB design. These are guidance, not completed checks.",
    inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
  }, async () => {
    const resource = loadDeepRuleResource();
    return jsonResult({ resourceIdentity: resource.resourceIdentity, ruleCount: resource.catalog.rules.length,
      topics: resource.catalog.sourceDossiers, assurance: "Research guidance only." });
  });
  server.registerTool("evleda_find_rules", {
    description: "Read complete source-backed rules selected by topic, tag, ID, category or severity, with explicit pagination. Supply at least one selector.",
    inputSchema: RULE_QUERY, annotations: READ_ANNOTATIONS,
  }, async (args) => {
    const { offset, limit, ...selector } = RULE_QUERY.parse(args);
    const resource = loadDeepRuleResource();
    const matches = [];
    // Keep the existing selector semantics and its per-call limit. Each chunk
    // is small enough that matching records are never lost before pagination.
    for (let index = 0; index < resource.catalog.rules.length; index += 250) {
      matches.push(...selectDeepRules({ ...resource.catalog, rules: resource.catalog.rules.slice(index, index + 250) }, selector as DeepRuleSelector));
    }
    const rules = matches.slice(offset, offset + limit);
    return jsonResult({ resourceIdentity: resource.resourceIdentity, matchingRuleCount: matches.length, offset,
      returnedRuleCount: rules.length, nextOffset: offset + rules.length < matches.length ? offset + rules.length : null,
      rules, assurance: "Research guidance, not executable validation or design approval." });
  });

  const readGuide = async (topic: string) => {
    const resource = loadDeepRuleResource();
    const dossier = resource.catalog.sourceDossiers.find(entry => [entry.slug, entry.number, entry.topic].includes(topic));
    if (dossier === undefined) throw new Error("Unknown research topic; use evleda_rule_topics for exact names.");
    const bytes = await readFile(path.join(resource.profile.resourceDirectory, dossier.dossierPath));
    if (bytes.length > MAX_GUIDANCE_BYTES || sha256(bytes) !== dossier.sha256) throw new Error("Research dossier differs from its verified resource identity or exceeds its size boundary.");
    return { dossier, text: bytes.toString("utf8"), resourceIdentity: resource.resourceIdentity };
  };
  server.registerTool("evleda_read_guide", {
    description: "Read one complete researched PCB design guide by its exact topic, slug or dossier number.",
    inputSchema: GUIDE_QUERY, annotations: READ_ANNOTATIONS,
  }, async ({ topic }) => jsonResult(await readGuide(topic)));
  for (const dossier of loadDeepRuleResource().catalog.sourceDossiers) {
    server.registerResource(dossier.slug, `evleda://guides/${encodeURIComponent(dossier.slug)}`, {
      title: dossier.topic, mimeType: "text/markdown", description: "Source-backed PCB design guidance; not a completed design check.",
    }, async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: (await readGuide(dossier.slug)).text }] }));
  }

  let standaloneContext: { remove(): void } | undefined;
  const attachCad = (attachment: KicadToolboxCadAttachment): void => {
    if (connectionClosed) throw new Error("Toolbox connection is closed.");
    if (binding !== undefined && binding.state() !== "closed") throw new Error("Existing CAD binding must finish with confirmed teardown before attachment.");
    const cad = attachment.cad;
    const planeContext = cad.planeAuthoringContext === undefined ? undefined : structuredClone(cad.planeAuthoringContext);
    const externalPowerBinding = planeContext?.externalPowerBinding === undefined ? undefined
      : parsePcbExternalPowerBinding(planeContext.externalPowerBinding, planeContext.sourceContractIdentity);
    const derivedPowerBinding = planeContext?.derivedPowerBinding === undefined ? undefined
      : parsePcbDerivedPowerBinding(planeContext.derivedPowerBinding, planeContext.sourceContractIdentity, externalPowerBinding);
    const options = { ...attachment };
    const access = options.access ?? "read-only";
    const contractIdentity = options.compoundContractIdentity === undefined ? undefined : structuredClone(options.compoundContractIdentity);
    let closed = false;
    let recoveryRequired = false;
    let finishing: Promise<void> | undefined;
    let cadState: Exclude<KicadToolboxCadState, "absent"> = "active";
    const registrations: Array<{ remove(): void }> = [];
    const registerTool = ((...args: unknown[]) => {
      const registered = Reflect.apply(server.registerTool, server, args) as { remove(): void };
      registrations.push(registered);
      return registered;
    }) as McpServer["registerTool"];
    const enqueueCad = <T>(work: () => Promise<T>): Promise<T> => enqueue(async () => {
      if (closed) throw new Error("Toolbox session is closed.");
      return await work();
    });
    const definitions = (cad?.tools.tools ?? []).map(definition => harnessToolDefinitionSchema.parse(definition)).filter(definition => {
      const effect = kicadHarnessToolEffect(definition.name);
      return effect !== undefined && (effect !== "mutation" || access === "edit")
        && (definition.name !== PLANE_APPLY || planeContext !== undefined)
        && (!COMPOUNDS.has(definition.name) || contractIdentity !== undefined);
    });
    if (new Set(definitions.map(definition => definition.name)).size !== definitions.length) throw new Error("Toolbox CAD descriptors contain duplicate names.");


    // Validate all descriptors before replacing an already-finished binding.
    for (const definition of definitions) nativeInputSchema(definition.inputSchema);
    standaloneContext?.remove(); standaloneContext = undefined;
    binding?.remove();
    const finishCad = (): Promise<void> => finishing ??= (async () => {
      closed = true;
      cadState = "finishing";
      await tail;
      const failures: unknown[] = [];
      let publishCheckpoint: (() => Promise<void>) | undefined;
      try {
        if (recoveryRequired) await cad?.recordRecoveryRequired?.("Toolbox mutation state was uncertain at close; explicit recovery is required.");
        else publishCheckpoint = await cad?.prepareCheckpoint?.();
      } catch (error) { failures.push(error); }
      try { await cad?.close(); } catch (error) { failures.push(error); }
      if (failures.length === 0 && publishCheckpoint !== undefined) {
        try { await publishCheckpoint(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 0) {
        try { await options.onFinished?.({ nativeSessionClosed: true, checkpointPublished: publishCheckpoint !== undefined, recoveryRequired }); }
        catch (error) { failures.push(error); }
      }
      if (failures.length > 0) {
        recoveryRequired = true;
        cadState = "uncertain";
        try { await cad?.recordRecoveryRequired?.("Toolbox checkpoint or owned teardown was not confirmed; explicit recovery is required."); }
        catch (error) { failures.push(error); }
      }
      if (failures.length === 0) cadState = "closed";
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Toolbox close/checkpoint was not confirmed.");
    })();

    const own: Binding = {
      finish: () => finishCad(),
      state: () => cadState,
      remove: () => { for (const registered of registrations) registered.remove(); },
      status: async () => {
        let cadConnected = false;
        let connectionProblem: string | null = null;
        if (!closed) {
          try { await enqueueCad(async () => { await cad.assertCurrent(); cadConnected = true; }); }
          catch (error) { connectionProblem = error instanceof Error ? error.message : String(error); }
        }
        return { cadBound: true, cadConnected, connectionProblem, access, recoveryRequired, closed, cadTools: definitions.map(definition => definition.name) };
      },
    };
    binding = own;
    try {
      if (cad.checkReferenceCoverage !== undefined) {
        ensureReferenceResource();
        registerTool("evleda_check_reference_coverage", {
          description: "Inspect projected straight-trace ribbons against selected saved copper-zone fills on the host-bound PCB. Supply nets/layers and an explicit margin beyond the trace edge plus its basis. Reports covered, uncovered, uncertain or not assessed. Saved fill freshness, DC connection, reference eligibility and impedance remain separate, unverified requirements. No model-provided geometry or file paths.",
          inputSchema: nativeInputSchema({ type: "object", ...z.toJSONSchema(toolboxReferenceCoverageQuerySchema) }), annotations: READ_ANNOTATIONS,
        }, async args => {
          try {
            const query = toolboxReferenceCoverageQuerySchema.parse(args);
            return await enqueueCad(async () => {
              await cad.assertCurrent(); const before = await cad.captureSources();
              const report = await cad.checkReferenceCoverage!(query);
              await cad.assertCurrent(); const after = await cad.captureSources();
              if (before !== after) throw new Error("Project changed during reference coverage inspection; discard this observation.");
              const snapshot = { sourceBefore: before, sourceAfter: after, sourceUnchanged: true, recoveryRequired };
              if (report.status !== "computed") return jsonResult({ ...report, ...snapshot });
              const artifact = report.calculation.artifacts.rawOutput;
              const uri = `evleda://reference-coverage/${artifact.identity.digest}`;
              // Keep complete diagnostic polygons in a hash-bound resource, never
              // truncate routes/findings or turn response-size limits into a pass.
              const result = jsonResult({ ...report, ...snapshot, diagnosticResource: uri,
                routeResults: report.routeResults.map(({ innerEnvelope, outerEnvelope, uncoveredOuterEnvelope, ...route }) => ({
                  ...route, diagnosticPolygonCounts: { inner: innerEnvelope.length, outer: outerEnvelope.length, uncoveredOuter: uncoveredOuterEnvelope.length },
                })) });
              referenceResources.set(uri, structuredClone(artifact));
              while (referenceResources.size > 32) referenceResources.delete(referenceResources.keys().next().value!);
              return { ...result, content: [...result.content, { type: "resource_link" as const, uri,
                name: "Selected-fill reference geometry diagnostics", mimeType: "application/json" }] };
            });
          } catch (error) { return failure(error); }
        });
      }
      if (cad.checkEndpointConnectivity !== undefined) registerTool("evleda_check_endpoint_connectivity", {
        description: "Check individually queried native physical-pad copper reachability for every net of the saved, host-bound V2 contract. Reports disconnected nets and split physical terminal members. Does not establish intended-plane contact, fresh fill, absence of shorts, thermal behavior or HF/impedance acceptance. No paths or PAD requests are accepted from the model.",
        inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
      }, async () => {
        try {
          return await enqueueCad(async () => {
            await cad.assertCurrent(); const before = await cad.captureSources();
            const result = await cad.checkEndpointConnectivity!();
            await cad.assertCurrent(); const after = await cad.captureSources();
            if (before !== after) throw new Error("Project changed during endpoint connectivity inspection; discard this observation.");
            return jsonResult({ ...result, sourceBefore: before, sourceAfter: after, sourceUnchanged: true, recoveryRequired });
          });
        } catch (error) { return failure(error); }
      });
      if (cad.checkPlaneAcceptance !== undefined) registerTool("evleda_check_plane_acceptance", {
        description: "Assess the saved host-bound V2 plane against its actual verification rows: current-session fill, intended component contact, island area, native thermal/clearance evidence and complete routed reference coverage. Reports unresolved physical width and other mandatory requirements explicitly. Reapply/save the contract plane after edits or resume to establish a fresh fill witness. This read does not authorize fabrication. No paths, selectors or evidence are accepted from the model.",
        inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
      }, async () => {
        try {
          return await enqueueCad(async () => {
            await cad.assertCurrent(); const before = await cad.captureSources();
            const result = transmissionLine === undefined ? await cad.checkPlaneAcceptance!() : await cad.checkPlaneAcceptance!(transmissionLine);
            await cad.assertCurrent(); const after = await cad.captureSources();
            if (before !== after) throw new Error("Project changed during plane acceptance inspection; discard this observation.");
            return jsonResult({ ...result, sourceBefore: before, sourceAfter: after, sourceUnchanged: true, recoveryRequired });
          });
        } catch (error) { return failure(error); }
      });
      if (cad.readStackup !== undefined) registerTool("evleda_read_stackup", {
        description: "Read physical stackup records from the current saved PCB, retaining dielectric sublayers, explicit/missing fields and unsupported forms. Does not choose a reference plane, substitute board thickness, average dielectric constants, or validate impedance.",
        inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
      }, async () => {
        try {
          return await enqueueCad(async () => {
            await cad.assertCurrent(); const before = await cad.captureSources();
            const observation = await cad.readStackup!();
            await cad.assertCurrent(); const after = await cad.captureSources();
            if (before !== after) throw new Error("Project changed during stackup inspection; discard this observation.");
            return jsonResult({ ...observation, sourceBefore: before, sourceAfter: after, sourceUnchanged: true });
          });
        } catch (error) { return failure(error); }
      });
      if (cad.checkMicrostripRoute !== undefined) registerTool("evleda_check_microstrip_route", {
        description: "Check one selected saved single-ended microstrip route against an explicit numerical target using its actual saved widths, terminals and stackup. Supply the current sourceIdentity from evleda_read_stackup plus net/reference selectors and caller-stated construction evidence. Returns separate route, construction, model and numerical assessments. Reference fill freshness and electrical eligibility remain unverified; board/interface acceptance is always false. No paths, raw PCB, runtime or requirement changes are accepted.",
        inputSchema: toolboxSavedMicrostripQuerySchema, annotations: READ_ANNOTATIONS,
      }, async args => {
        try {
          const request = snapshotToolboxSavedMicrostripRequest(args);
          return await enqueueCad(async () => {
            await cad.assertCurrent(); const before = await cad.captureSources();
            const result = await cad.checkMicrostripRoute!(request, transmissionLine);
            await cad.assertCurrent(); const after = await cad.captureSources();
            if (before !== after) throw new Error("Project changed during microstrip inspection.");
            return jsonResult({ ...result, sourceBefore: before, sourceAfter: after, sourceUnchanged: true, recoveryRequired });
          });
        } catch (error) { return jsonResult({ error: toolboxSavedMicrostripErrorMessage(error) }, true); }
      });
      if (cad.checkInterface !== undefined) registerTool("evleda_check_interface", {
        description: "Assess one declared differential interface in the current saved native project. Select its interfaceId from evleda_design_context. All endpoint roles, geometry limits, construction, terminations and impedance targets come from the authenticated V2 contract. Reports complete saved route geometry and conditional analytical impedance separately from reference-path and physical qualifications. This read cannot change requirements or authorize fabrication.",
        inputSchema: toolboxInterfaceQuerySchema, annotations: READ_ANNOTATIONS,
      }, async args => {
        try {
          const request = snapshotToolboxInterfaceQuery(args);
          return await enqueueCad(async () => {
            await cad.assertCurrent(); const before = await cad.captureSources();
            const result = await cad.checkInterface!(request.interfaceId, transmissionLine);
            await cad.assertCurrent(); const after = await cad.captureSources();
            if (before !== after) throw new Error("Project changed during interface assessment.");
            if (result.report.interfaceId !== request.interfaceId) throw new Error("Assessment selected a different interface.");
            return jsonResult({ ...result, sourceBefore: before, sourceAfter: after, sourceUnchanged: true, recoveryRequired });
          });
        } catch { return jsonResult({ error: TOOLBOX_INTERFACE_ERROR }, true); }
      });
      if (options.designContext !== undefined) registerTool("evleda_design_context", {
        description: "Read this project's approved design contract, execution guidance and required acceptance rows. These describe requirements, not completed work.",
        inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
      }, async () => {
        try { return await enqueueCad(async () => jsonResult(structuredClone(options.designContext!()))); }
        catch (error) { return failure(error); }
      });

      for (const definition of definitions) {
        const mutation = kicadHarnessToolEffect(definition.name) === "mutation";
        registerTool(definition.name, {
          description: definition.description,
          inputSchema: nativeInputSchema(definition.inputSchema),
          annotations: { readOnlyHint: !mutation, destructiveHint: mutation, idempotentHint: !mutation, openWorldHint: false },
        }, async (args) => {
          try {
            return await enqueueCad(async () => {
              if (mutation && recoveryRequired) throw new Error("A previous mutation has uncertain state. The owning host must inspect/recover and establish a new session before more edits.");
              const call: HarnessToolCall<KicadHarnessToolName> = { id: `toolbox:${randomUUID()}`, name: definition.name as KicadHarnessToolName,
                arguments: structuredClone(args as HarnessToolCall["arguments"]) };
              let dispatched = false;
              try {
                await cad!.assertCurrent();
                dispatched = true;
                const result = harnessToolResultSchema.parse(await cad!.tools.execute(call));
                if (result.toolCallId !== call.id) throw new Error("CAD result does not match the dispatched operation.");
                if (result.isError) {
                  if (mutation) recoveryRequired = true;
                  return jsonResult({ operation: call.name, result, recoveryRequired }, true);
                }
                if (!mutation) return jsonResult({ operation: call.name, result });
                // A native plane unfill/refill dirties the editor even when its
                // serialized source is unchanged. Do not let a source-only
                // no-effect classifier clear that pending native save.
                const disposition = call.name === PLANE_APPLY && planeContext !== undefined
                  ? undefined : await cad!.tools.internal.classifyPendingMutationBatch?.();
                const noEffect = disposition === undefined ? false : (() => {
                  const parsed = mutationBatchDispositionSchema.parse(disposition);
                  if (parsed.baselineSha256 !== parsed.observedSha256) throw new Error("No-effect source disposition contains different source hashes.");
                  return true;
                })();
                const mutated = (planeContext === undefined || contractIdentity === undefined ? undefined
                  : planeCompoundMutationState(call, result, { ...planeContext, connectivityIdentity: contractIdentity }))
                  ?? compoundMutationState(call, result, contractIdentity, externalPowerBinding, derivedPowerBinding) ?? true;
                let saved: unknown;
                if (mutated && !noEffect) {
                  const saveCall = { id: `${call.id}:save`, name: "pcb_save", arguments: {} };
                  await cad!.assertCurrent();
                  const saveResult = harnessToolResultSchema.parse(await cad!.tools.internal.saveAfterMutation(saveCall));
                  if (saveResult.toolCallId !== saveCall.id || saveResult.isError) throw new Error("The existing CAD save/readback boundary failed.");
                  saved = saveResult;
                }
                let readback: unknown;
                if (SCHEMATIC_MUTATIONS.has(call.name)) {
                  const readCall = { id: `${call.id}:readback`, name: "sch_get_connectivity_graph", arguments: {} };
                  await cad!.assertCurrent();
                  const readResult = harnessToolResultSchema.parse(await cad!.tools.internal.execute(readCall));
                  if (readResult.toolCallId !== readCall.id || readResult.isError) throw new Error("Post-edit schematic readback failed.");
                  readback = readResult;
                }
                await cad!.assertCurrent();
                return jsonResult({ operation: call.name, result, persistence: saved ?? null, readback: readback ?? null,
                  noGovernedEffect: noEffect, assurance: "Operation and persistence results only; run applicable design checks before declaring the design complete." });
              } catch (error) {
                if (mutation && dispatched) recoveryRequired = true;
                throw error;
              }
            });
          } catch (error) { return failure(error); }
        });
      }

      if (cad !== undefined) registerTool("evleda_validate_design", {
        description: "Collect native ERC, DRC, board summary, visual QA and available PCB-practice analysis from the bound project, with source fingerprints before/after. Inspect findings and missing inputs; this is not manufacturing or electrical-suitability certification.",
        inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
      }, async () => {
        try {
          return await enqueueCad(async () => {
            await cad.assertCurrent();
            const before = await cad.captureSources();
            const checks = [];
            for (const name of ["run_erc", "run_drc", "pcb_get_board_summary", "pcb_visual_qa"] as const) {
              await cad.assertCurrent();
              const call = { id: `toolbox-check:${randomUUID()}`, name, arguments: {} };
              const result = harnessToolResultSchema.parse(await cad.tools.internal.execute(call));
              if (result.toolCallId !== call.id) throw new Error("Native check result does not match its operation.");
              checks.push({ name, result });
            }
            await cad.assertCurrent();
            const practices = cad.analyzePractices === undefined
              ? { available: false, reason: "Owning host did not supply source-bound practice analysis." }
              : { available: true, result: await cad.analyzePractices() };
            const after = await cad.captureSources();
            await cad.assertCurrent();
            return jsonResult({ checks, practices, sourceBefore: before, sourceAfter: after, sourceUnchanged: before === after,
              recoveryRequired, assurance: "Native result collection only; individual findings and applicable engineering requirements remain authoritative." },
              before !== after || checks.some(check => check.result.isError === true));
          });
        } catch (error) { return failure(error); }
      });

      if (cad?.analyzePractices !== undefined) registerTool("evleda_check_board_practices", {
        description: "Inspect saved PCB turn geometry against the required 45-degree policy and any host-bound width/via profile. Unsupported geometry and missing electrical inputs remain unverified. No model-selectable files or policy overrides.",
        inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
      }, async () => {
        try {
          return await enqueueCad(async () => {
            await cad.assertCurrent();
            const before = await cad.captureSources();
            const report = await cad.analyzePractices!();
            const after = await cad.captureSources();
            await cad.assertCurrent();
            return jsonResult({ report, sourceBefore: before, sourceAfter: after, sourceUnchanged: before === after,
              assurance: "Findings and coverage only; missing engineering inputs are not a pass." }, before !== after);
          });
        } catch (error) { return failure(error); }
      });

      if (cad?.renderPreview !== undefined) {
        ensurePreviewResource();
        registerTool("evleda_render_board", {
          description: "Render the saved bound PCB using native KiCad SVG, returning a PNG for visual review and its source SVG resource. Choose top copper/silkscreen or assembly; no model-selected file paths. This is a source-bound snapshot, not design acceptance.",
          inputSchema: z.object({ view: z.enum(["top", "assembly"]).default("top") }).strict(), annotations: READ_ANNOTATIONS,
        }, async ({ view }) => {
          try {
            return await enqueueCad(async () => {
              await cad.assertCurrent();
              const before = await cad.captureSources();
              const preview = await cad.renderPreview!(view);
              const after = await cad.captureSources();
              await cad.assertCurrent();
              if (before !== after) throw new Error("Project changed during preview; discard this image and render again.");
              const { source: _source, png, ...metadata } = preview;
              const { data, ...pngMetadata } = png;
              previewResources.set(preview.resourceUri, { path: preview.pcbSvg.path, sha256: preview.pcbSvg.sha256, size: preview.pcbSvg.sizeBytes });
              while (previewResources.size > 32) previewResources.delete(previewResources.keys().next().value!);
              const result = jsonResult({ ...metadata, png: pngMetadata, sourceBefore: before, sourceAfter: after, sourceUnchanged: true });
              return { ...result, content: [...result.content,
                { type: "image" as const, data, mimeType: "image/png" },
                { type: "resource_link" as const, uri: preview.resourceUri, name: `Native PCB ${view} SVG`, mimeType: "image/svg+xml" }] };
            });
          } catch (error) { return failure(error); }
        });

      }



      if (cad !== undefined) registerTool("evleda_finish_session", {
        description: "Finish this native session before disconnecting: drain operations, close the owned editor/session, and publish a saved-candidate checkpoint when supported and certain. This is not design acceptance. No further CAD edits are allowed afterward; reopen through the host to resume.",
        inputSchema: EMPTY, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async () => {
        try {
          await finishCad();
          return jsonResult({ nativeSessionClosed: true, checkpointPublished: cad.prepareCheckpoint !== undefined && !recoveryRequired,
            recoveryRequired, assurance: "Session finalization only; outstanding engineering requirements remain authoritative." }, recoveryRequired);
        } catch (error) { return failure(error); }
      });


    } catch (error) {
      // Registration failed after accepting ownership. Keep the binding locked
      // until its host closes it; never silently replace uncertain native state.
      closed = true;
      recoveryRequired = true;
      cadState = "uncertain";
      own.remove();
      throw error;
    }
  };

  if (options.cad !== undefined) attachCad({ cad: options.cad,
    ...(options.access === undefined ? {} : { access: options.access }),
    ...(options.compoundContractIdentity === undefined ? {} : { compoundContractIdentity: options.compoundContractIdentity }),
    ...(options.designContext === undefined ? {} : { designContext: options.designContext }) });
  else if (options.designContext !== undefined) standaloneContext = server.registerTool("evleda_design_context", {
    description: "Read host-supplied design requirements, not completed work.", inputSchema: EMPTY, annotations: READ_ANNOTATIONS,
  }, async () => { try { return jsonResult(structuredClone(options.designContext!())); } catch (error) { return failure(error); } });

  return Object.freeze({ server, attachCad,
    getCadState: () => binding?.state() ?? "absent",
    finishCad: async () => { await binding?.finish(); },
    detachCad: () => {
      if (binding === undefined) return;
      if (binding.state() !== "closed") throw new Error("CAD detach requires confirmed native close.");
      binding.remove(); binding = undefined;
    },
    close: () => closing ??= (async () => {
      connectionClosed = true;
      const failures: unknown[] = [];
      try { await binding?.finish(); await tail; } catch (error) { failures.push(error); }
      try { await server.close(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Toolbox native/protocol close was not confirmed.");
    })(),
  });
}

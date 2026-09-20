import { createPcbExternalPowerBinding, assertPcbExternalPowerBindingCurrent, type PcbExternalPowerBinding } from "./pcb-external-power.js";
import { createPcbDerivedPowerBinding, assertPcbDerivedPowerBindingCurrent, type PcbDerivedPowerBinding } from "./pcb-derived-power.js";
import { assertPcbChannelFeedThroughSources } from "./pcb-channel-feed-through.js";
import { z } from "zod";
import { derivePcbNativeNumericRules, pcbNativeNumericRuleLines } from "./pcb-native-numeric-rules.js";
import { resolvePcbBoardFeatureLibraries } from "./pcb-board-feature-libraries.js";
import type { PcbBoardFeatureLibrarySource } from "./pcb-board-features.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { validateDeepRuleCatalog, type DeepRuleCatalog } from "./deep-rule-catalog.js";
import { selectDeepRulesForDesign, type DeepRuleSelectionOptions } from "./deep-rule-selector.js";
import { unsupportedPcbInterfaceRequirements } from "./pcb-interface-requirements.js";
import {
  deriveDeepRuleFeaturesFromContract, resolvePcbDesignCommonLibraries,
  PCB_LIBRARY_BINDING_SCHEMA_VERSION, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
  type PcbReadOnlyLibraryResolver, type PcbLibraryBinding, type PcbDeepRuleBinding,
} from "./pcb-design-compiler.js";
import {
  PCB_PLANE_CONTRACT_SCHEMA_VERSION,
  closePcbPlaneDesignIntentDraft, parsePcbPlaneDesignIntentDraft, pcbPlaneDesignContractPayloadSchema,
  normalizePcbPlaneUnresolvedPath, snapshotPcbPlaneValue, freezePcbPlaneArtifact,
  type PcbPlaneDesignContract, type PcbPlaneDesignIntentDraft,
} from "./pcb-design-plane-contract.js";

export const PCB_PLANE_COMPILATION_SCHEMA_VERSION = "evleda.pcb-design-compilation.v2" as const;
export const PCB_PLANE_VERIFICATION_PLAN_SCHEMA_VERSION = "evleda.pcb-plane-verification-plan.v1" as const;
export const PCB_PLANE_COMPILER_ID = "evleda.pcb-plane-compiler.v1" as const;
const selectionPolicySchema = z.object({ maxRules: z.number().int().min(1).max(40),
  maxPromptBytes: z.number().int().min(1).max(16_384), maxPromptTokens: z.number().int().min(1).max(16_384),
  featureCoveragePolicy: z.literal("require-all") }).strict();
export type PcbPlaneSelectionPolicy = z.infer<typeof selectionPolicySchema>;
export interface PcbPlaneCompilerOptions {
  readonly libraryResolver: PcbReadOnlyLibraryResolver;
  readonly deepRuleCatalog: DeepRuleCatalog;
  readonly deepRuleSelectionOptions?: Omit<DeepRuleSelectionOptions, "tokenCounter">;
}
export interface PcbPlaneClarification { readonly id: string; readonly path: string; readonly question: string }
export interface PcbPlaneIssue { readonly code: string; readonly path: string; readonly message: string }
export interface PcbPlaneVerificationRequirement {
  readonly id: string;
  readonly kind: "contract" | "library" | "schematic" | "pcb_component" | "placement" | "outline" | "netclass_configuration"
    | "trace_connectivity" | "trace_geometry" | "via_policy" | "plane_configuration" | "plane_fill"
    | "plane_connectivity" | "plane_access" | "plane_clearance" | "plane_thermal_islands" | "reference_path"
    | "interface_topology" | "interface_pair_geometry" | "interface_termination" | "interface_impedance" | "interface_construction"
    | "erc" | "drc" | "schematic_ink" | "visual";
  readonly contractPath: string;
  readonly mandatory: true;
  readonly description: string;
}
export interface PcbPlaneVerificationPlan {
  readonly schemaVersion: typeof PCB_PLANE_VERIFICATION_PLAN_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly libraryBindingIdentity: CanonicalIdentity;
  readonly deepRuleBindingIdentity: CanonicalIdentity;
  readonly requirements: readonly PcbPlaneVerificationRequirement[];
  readonly acceptanceEvaluated: false;
  readonly identity: CanonicalIdentity;
}
interface CompilationCommon {
  readonly schemaVersion: typeof PCB_PLANE_COMPILATION_SCHEMA_VERSION;
  readonly foundationOnly: true;
  readonly nativeAuthoringPerformed: false;
  readonly acceptanceEvaluated: false;
  readonly questions: readonly PcbPlaneClarification[];
  readonly issues: readonly PcbPlaneIssue[];
}
export interface PcbPlaneReadyCompilation extends CompilationCommon {
  readonly disposition: "ready";
  readonly draft: PcbPlaneDesignIntentDraft;
  readonly draftIdentity: ContentIdentity;
  readonly selectionPolicy: PcbPlaneSelectionPolicy;
  readonly contract: PcbPlaneDesignContract;
  readonly libraryBinding: PcbLibraryBinding;
  readonly boardFeatureLibrarySources?: readonly PcbBoardFeatureLibrarySource[];
  readonly externalPowerBinding?: PcbExternalPowerBinding;
  readonly derivedPowerBinding?: PcbDerivedPowerBinding;
  readonly deepRuleBinding: PcbDeepRuleBinding;
  readonly verificationPlan: PcbPlaneVerificationPlan;
}
export type PcbPlaneDesignCompilation = PcbPlaneReadyCompilation | (CompilationCommon & {
  readonly disposition: "needs_clarification" | "unsupported";
  readonly draft: PcbPlaneDesignIntentDraft | null;
  readonly draftIdentity: null;
  readonly selectionPolicy: null;
  readonly contract: null;
  readonly libraryBinding: null;
  readonly deepRuleBinding: null;
  readonly verificationPlan: null;
});

export function normalizePcbPlaneSelectionPolicy(value: unknown = {}): PcbPlaneSelectionPolicy {
  const input = snapshotPcbPlaneValue(value);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Plane compiler policy must be a closed object");
  return freezePcbPlaneArtifact(selectionPolicySchema.parse({ maxRules: 40, maxPromptBytes: 16_384,
    maxPromptTokens: 16_384, featureCoveragePolicy: "require-all", ...input }));
}
const base = { schemaVersion: PCB_PLANE_COMPILATION_SCHEMA_VERSION, foundationOnly: true,
  nativeAuthoringPerformed: false, acceptanceEvaluated: false } as const;
const token = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

function diagnostics(disposition: "needs_clarification" | "unsupported", draft: PcbPlaneDesignIntentDraft | null,
  issues: readonly PcbPlaneIssue[], questions?: readonly PcbPlaneClarification[]): PcbPlaneDesignCompilation {
  const unique = new Map<string, PcbPlaneClarification>();
  for (const question of questions ?? issues.map(issue => ({ id: issue.path, path: issue.path, question: issue.message }))) {
    const old = unique.get(question.path);
    unique.set(question.path, old === undefined ? question : { ...old, question: [...new Set([old.question, question.question])].sort().join(" ") });
  }
  return freezePcbPlaneArtifact({ ...base, disposition, draft, draftIdentity: null, selectionPolicy: null,
    questions: [...unique.values()].sort((a, b) => a.path.localeCompare(b.path, "en-US")), issues: [...issues],
    contract: null, libraryBinding: null, deepRuleBinding: null, verificationPlan: null });
}
function validationIssues(error: unknown, document: unknown): PcbPlaneIssue[] {
  if (!(error instanceof z.ZodError)) return [{ code: "INVALID_DRAFT", path: "/", message: error instanceof Error ? error.message : "Submit bounded plain V2 JSON" }];
  return error.issues.slice(0, 1024).map(issue => {
    const pointer = `/${issue.path.map(String).map(token).join("/")}`;
    return { code: "INVALID_DRAFT", path: normalizePcbPlaneUnresolvedPath(document, pointer) ?? pointer,
      message: `${issue.message}. Provide the explicit value required at ${pointer}.` };
  });
}

function verificationPlan(contract: PcbPlaneDesignContract, library: PcbLibraryBinding, deep: PcbDeepRuleBinding): PcbPlaneVerificationPlan {
  const requirements: PcbPlaneVerificationRequirement[] = [];
  const add = (id: string, kind: PcbPlaneVerificationRequirement["kind"], contractPath: string, description: string) =>
    requirements.push({ id, kind, contractPath, mandatory: true, description });
  add("contract:integrity", "contract", "/", "Reproduce the complete V2 contract and all exact child identities.");
  if (contract.nativeRuleMode !== undefined) add("native-numeric-rules", "netclass_configuration", "/nativeRuleMode",
    "Verify exact contract-derived global minima and canonical per-net/via native rules, preserved unmatched-copper/pad defaults and enabled DRC checks; source route/escape/corner checks remain independent.");
  for (const component of contract.components) {
    const path = `/components/${token(component.reference)}`;
    add(`library:${component.reference}`, "library", path, "Verify exact stock symbol, footprint, pin/pad inventory and physical geometry.");
    add(`schematic:${component.reference}`, "schematic", path, "Verify exact component, values, pin dispositions and source-bound schematic connectivity.");
    add(`pcb:${component.reference}`, "pcb_component", path, "Verify the exact PCB footprint and physical pads.");
    add(`placement:${component.reference}`, "placement", `/placementConstraints/${token(component.reference)}`, "Verify all side, rotation, region, edge and courtyard constraints.");
  }
  for (const feature of contract.boardFeatures ?? []) add(`board-feature:${feature.reference}`, "pcb_component", `/boardFeatures/${feature.reference}`,
    "Verify exact source-bound NPTH footprint, full physical inventory, zero electrical terminals, board-only/BOM/position exclusions, immutable pose, bore and native hole clearances.");
  for (const net of contract.nets) add(`schematic-net:${net.name}`, "schematic", `/nets/${token(net.name)}`, "Verify every exact net endpoint and no unintended endpoints; plane routing changes no schematic assignments.");
  for (const source of contract.derivedPowerSources ?? []) add(`derived-power:${source.id}`, "schematic", `/derivedPowerSources/${token(source.id)}`,
    "Verify source-pinned complete driver/passive pin facts, every upstream/path/ground native group and the complete schematic-only flag inventory. A reviewed source path is not current, thermal, feedback or electrical qualification; native ERC remains independent.");
  add("board:outline", "outline", "/scope/board", contract.scope.board.layerCount === 2
    ? "Verify the exact rectangular outline and two-layer board." : "Verify the exact rectangular outline and four-layer board with its complete ordered copper inventory.");
  for (const netClass of contract.netClasses) add(`netclass:${netClass.id}`, "netclass_configuration", `/netClasses/${token(netClass.id)}`, "Verify exact authored class assignment, trace-width preference and effective configured clearance; no ampacity claim.");
  for (const route of contract.routingConstraints.nets) {
    const path = `/routingConstraints/nets/${token(route.net)}`;
    add(`vias:${route.net}`, "via_policy", path, "Verify this net's actual vias and the combined trace/plane-access budget and physical via geometry.");
    if (route.topology === "plane") {
      add(`plane-net:${route.net}`, "plane_connectivity", path, "Verify every exact physical terminal reaches the declared filled plane component, without unintended terminals. A trace tree is not plane evidence.");
      add(`plane-access:${route.net}`, "plane_access", `${path}/accessRouting`, "Verify access-track width, turns, length, layer and actual pad/via-to-plane contacts independently of plane interior geometry.");
    } else {
      add(`trace-net:${route.net}`, "trace_connectivity", path, `Verify exact physical ${route.topology} trace connectivity independently of plane copper.`);
      add(`trace-geometry:${route.net}`, "trace_geometry", path, "Verify trace widths, mitered turns, lengths, layers, no duplicates, self-intersections or backtracking.");
      if (route.referencePath.mode === "continuous_plane") {
        add(`reference:${route.net}`, "reference_path", `${path}/referencePath`, route.referencePath.terminalLaunches === undefined
          ? "Bind fresh plane fill and exact signal copper sweep plus margin; verify void-free geometric coverage and explicit reference terminals. No impedance or EMC qualification is established."
          : "Bind fresh plane fill and exact route-body ribbons plus the unchanged margin after only the separately declared bounded terminal launches. Require each launch's current native/source geometry, local return anchor, foreign-bore separation and native clearance evidence. No impedance or EMC qualification is established.");
        for (const launch of route.referencePath.terminalLaunches ?? []) add(`reference-launch:${route.net}:${launch.signalEndpoint.reference}:${launch.signalEndpoint.pin}`,
          "reference_path", `${path}/referencePath/terminalLaunches`, "Verify the explicit approach length and return-pin spacing on current source/native through-hole geometry, a direct eligible return-pad contact to the intended plane, separation from every other bore and current native clearance checks. This scoped launch condition is not electrical/impedance approval.");
      }
    }
  }
  for (const plane of contract.planes) {
    const path = `/planes/${token(plane.id)}`;
    add(`plane-config:${plane.id}`, "plane_configuration", path, "Verify exactly one authored zone with this plane's exact net, layer, boundary and all declared settings; reject unbound zones or rule areas.");
    add(`plane-fill:${plane.id}`, "plane_fill", path, "Verify current-source native fill freshness, complete filled contours including holes, and actual minimum copper width.");
    add(`plane-clearance:${plane.id}`, "plane_clearance", path, "Verify the explicit zone clearance and its native effective rule interaction, copper separation and edge clearance.");
    add(`plane-policy:${plane.id}`, "plane_thermal_islands", path, plane.islandPolicy.requireSingleConnectedComponent
      ? "Verify pad thermal/solid contacts, required spokes, island removal and one connected plane component."
      : "Verify pad thermal/solid contacts, required spokes, native island removal, each stored region's retained-area lower bound and a source/native through-via contact to the declared primary plane. Complete drill-clipped connectivity remains independently required.");
  }
  if (contract.interfaceRequirements !== undefined) {
    if (contract.interfaceRequirements.construction.mode === "two_layer") add("interface-construction", "interface_construction", "/interfaceRequirements/construction",
      "Verify saved native two-layer construction against all explicit thickness, material, mask, exterior and finish declarations. Caller sources are intent, not verified physical authority; no fabricated-material qualification is established.");
    if (contract.interfaceRequirements.construction.mode === "four_layer") add("interface-construction", "interface_construction", "/interfaceRequirements/construction",
      "Verify all four saved copper layers and three separate dielectric gaps, masks, finish and modeled total against the declaration; preserve nominal thickness and unverified physical material assertions separately.");
    for (const pair of contract.interfaceRequirements.interfaces) {
      const path = `/interfaceRequirements/interfaces/${token(pair.id)}`;
      add(`interface-topology:${pair.id}`, "interface_topology", path,
        pair.channel?.feedThrough ? "Verify all six native copper nets independently: launch, resistor-to-protection input and protection-output-to-contact sections. Retain every resistor, transfer IO, connector and ground/supply anchor. Internal transfers are explicitly source-asserted component paths, never fabricated copper. Reject undeclared taps, cycles, transitions, disconnected sections and ambiguous anchors."
          : pair.channel ? "Verify exactly four channel nets, both resistor pin mappings, every connector and protection signal anchor, exact protection returns, and complete launch and every receiver path. Require declared pad-center branch attachments and leaves; reject undeclared taps, cycles, transitions, disconnected copper and ambiguous anchors."
          : "Verify exactly two member nets, all four source/receiver roles and explicit polarity mapping, complete unique source-to-receiver paths and all declared termination anchors; reject undeclared taps, stubs, transitions or ambiguous branches.");
      add(`interface-geometry:${pair.id}`, "interface_pair_geometry", `${path}/geometry`,
        pair.channel?.feedThrough ? "Verify all six-net opposing gaps, widths, routed escapes, vias and continuous reference coverage. Pair geometry budgets cover the combined input/output PCB sections; channel etch/skew covers all three PCB sections including launch, per receiver. Count unique branch copper once. Package electrical delay/skew remains not assessed. A qualified transfer-output pad may source distinct outgoing paths; ordinary serial bends retain all turn constraints."
          : pair.channel ? "Verify every channel path and branch, all four-net opposing copper gaps, body widths, exact terminal-bound routed escapes, launch bounds and full copper-only channel etch/skew budgets, with continuous reference coverage on every member net. No device-internal segment is fabricated; complete electromagnetic coverage remains unverified."
          : "Verify both complete routes including bends, launches and termination access: width/gap intervals, etch length, etch skew, uncoupled length and reference coverage. An isolated straight segment cannot satisfy this requirement.");
      add(`interface-termination:${pair.id}`, "interface_termination", `${path}/terminations`,
        "Verify exact source/receiver termination component pins, member-net polarity, declared resistance and external endpoint-distance bounds. Device internals and source citations remain caller-asserted intent, not device qualification.");
      if (pair.impedance.mode === "differential") add(`interface-impedance:${pair.id}`, "interface_impedance", `${path}/impedance`,
        "Assess declared differential impedance target/tolerance at its explicit frequency using source-bound saved construction and complete supported pair geometry. Analytical model evidence is not measured impedance or physical material qualification; unsupported sections remain unknown.");
    }
  }
  for (const kind of ["erc", "drc", "schematic_ink", "visual"] as const) add(kind, kind, "/", `Require independent current-source ${kind} evidence; compilation is not a passed check.`);
  const payload = { schemaVersion: PCB_PLANE_VERIFICATION_PLAN_SCHEMA_VERSION, contractIdentity: contract.identity,
    libraryBindingIdentity: library.identity, deepRuleBindingIdentity: deep.identity, requirements, acceptanceEvaluated: false as const };
  return freezePcbPlaneArtifact({ ...payload, identity: canonicalIdentity(payload, PCB_PLANE_VERIFICATION_PLAN_SCHEMA_VERSION) });
}

/** Compile V2 directly. Common validators/resolvers never receive a manufactured V1 routing contract. */
export function compilePcbPlaneDesignIntentDraft(input: unknown, options: PcbPlaneCompilerOptions): PcbPlaneDesignCompilation {
  let draft: PcbPlaneDesignIntentDraft;
  let snapshot: unknown;
  try { snapshot = snapshotPcbPlaneValue(input); draft = parsePcbPlaneDesignIntentDraft(snapshot); }
  catch (error) { return diagnostics("needs_clarification", null, validationIssues(error, snapshot)); }
  const unsupportedInterfaces = unsupportedPcbInterfaceRequirements(draft.interfaceRequirements);
  if (unsupportedInterfaces.length > 0) return diagnostics("unsupported", draft,
    unsupportedInterfaces.map(issue => ({ code: "UNSUPPORTED_INTERFACE_TOPOLOGY", ...issue })));
  const { unresolved: _unresolved, ...common } = draft;
  const candidate = { ...common, schemaVersion: PCB_PLANE_CONTRACT_SCHEMA_VERSION, kind: "pcb_design_contract" };
  const closure = pcbPlaneDesignContractPayloadSchema.safeParse(candidate);
  const unresolvedIssues: PcbPlaneIssue[] = draft.unresolved.map(entry => ({ code: "UNRESOLVED_FIELD", path: entry.path, message: entry.question }));
  if (!closure.success) unresolvedIssues.push(...validationIssues(closure.error, draft));
  if (unresolvedIssues.length > 0) return diagnostics("needs_clarification", draft, unresolvedIssues);
  const libraries = resolvePcbDesignCommonLibraries(draft, options.libraryResolver);
  if (libraries.disposition !== "ready") return diagnostics(libraries.disposition, draft, libraries.issues, libraries.questions);
  try {
    const contract = closePcbPlaneDesignIntentDraft(draft);
    derivePcbNativeNumericRules(contract); pcbNativeNumericRuleLines(contract);
    const physicalLibraries = resolvePcbBoardFeatureLibraries(contract.boardFeatures, libraries, options.libraryResolver);
    const libraryPayload = { schemaVersion: PCB_LIBRARY_BINDING_SCHEMA_VERSION, contractIdentity: contract.identity,
      symbols: libraries.symbols, footprints: physicalLibraries.footprints,
      ...(physicalLibraries.sourceSelection === undefined ? {} : { sourceSelection: physicalLibraries.sourceSelection }) };
    const libraryBinding: PcbLibraryBinding = freezePcbPlaneArtifact({ ...libraryPayload, identity: canonicalIdentity(libraryPayload, PCB_LIBRARY_BINDING_SCHEMA_VERSION) });
    assertPcbChannelFeedThroughSources(contract, libraryBinding, options.libraryResolver);
    const externalPowerBinding = createPcbExternalPowerBinding(contract, libraryBinding, options.libraryResolver);
    const derivedPowerBinding = createPcbDerivedPowerBinding(contract, libraryBinding, options.libraryResolver, externalPowerBinding);
    const selectionPolicy = normalizePcbPlaneSelectionPolicy(options.deepRuleSelectionOptions);
    const catalog = validateDeepRuleCatalog(hardenPortableValue(options.deepRuleCatalog, {
      maxBytes: 8 * 1024 * 1024, maxDepth: 64, maxNodes: 500_000, maxArrayLength: 100_000,
      maxOwnKeys: 1024, maxStringBytes: 256 * 1024,
    }));
    const features = { ...deriveDeepRuleFeaturesFromContract(contract, libraryBinding),
      ...(contract.interfaceRequirements !== undefined ? { differentialPairs: true as const, signalSpeedInterfaces: true as const,
        ...(contract.interfaceRequirements.interfaces.some(pair => pair.impedance.mode === "differential") ? { stackupImpedance: true as const } : {}) } : {}),
      ...(contract.routingConstraints.nets.some(route => route.topology !== "plane" && route.referencePath.mode === "continuous_plane") ? { emi: true as const } : {}) };
    const selection = selectDeepRulesForDesign(catalog, features, selectionPolicy);
    if (selection.disposition !== "ready-for-prompt") throw new Error("Plane compiler requires complete deterministic guidance coverage");
    const deepPayload = { schemaVersion: PCB_DEEP_RULE_BINDING_SCHEMA_VERSION, contractIdentity: contract.identity,
      catalogIdentity: canonicalIdentity(catalog, "evleda.deep-rule-catalog.v1"), features, selection };
    const deepRuleBinding: PcbDeepRuleBinding = freezePcbPlaneArtifact({ ...deepPayload, identity: canonicalIdentity(deepPayload, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION) });
    if (externalPowerBinding !== undefined) assertPcbExternalPowerBindingCurrent(externalPowerBinding, options.libraryResolver);
    if (derivedPowerBinding !== undefined) assertPcbDerivedPowerBindingCurrent(derivedPowerBinding, libraryBinding, options.libraryResolver);
    assertPcbChannelFeedThroughSources(contract, libraryBinding, options.libraryResolver);
    return freezePcbPlaneArtifact({ ...base, disposition: "ready", draft, draftIdentity: contentIdentity(canonicalJson(draft)),
      selectionPolicy, questions: [], issues: [], contract, libraryBinding, deepRuleBinding,
      ...(physicalLibraries.boardFeatureLibrarySources === undefined ? {} : { boardFeatureLibrarySources: physicalLibraries.boardFeatureLibrarySources }),
      ...(externalPowerBinding === undefined ? {} : { externalPowerBinding }),
      ...(derivedPowerBinding === undefined ? {} : { derivedPowerBinding }),
      verificationPlan: verificationPlan(contract, libraryBinding, deepRuleBinding) });
  } catch (error) {
    return diagnostics("needs_clarification", draft, [{ code: "COMPILER_DEPENDENCY", path: "/", message: error instanceof Error ? error.message : "Compiler dependency is unavailable" }]);
  }
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { isVerifiedFreshProject } from "../harness/fresh-project.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import type { FreshSchematicApprovedGeometryResolver } from "../harness/fresh-schematic-source-adapter.js";
import { assertFreshSchematicStrokeStyleEvidence, type FreshSchematicStrokeStyleEvidence } from "../harness/fresh-schematic-stroke-style.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  createKicadHarnessTools,
  createFreshConnectivityContract,
  KICAD_HARNESS_TOOL_NAMES,
  KICAD_FRESH_HARNESS_TOOL_NAMES,
  KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  DEFAULT_PCB_HARNESS_MUTATION_TOOL_NAMES,
  prepareFreshProject,
  checkpointFreshProjectOpenNormalization,
  captureFreshProjectOpenPreparedSourceAuthority,
  parseFreshProjectOpenPreparedSourceAuthority,
  FRESH_PROJECT_PROMPT_CONTEXT,
  FRESH_LED_INDICATOR_PROVIDER_CONTRACT,
  FRESH_LED_DEEP_RULE_POLICY,
  FRESH_LED_DESIGNER_PROMPT_MAX_CHARS,
  LED_INDICATOR_EXAMPLE,
  evaluateLedIndicatorAcceptance,
  evaluateFreshDesignAcceptance,
  createFreshNetClassPreparationEvidence,
  parseFreshNetClassPreparationEvidence,
  readFreshNetClassSemanticAuthority,
  verifyFreshNetClassSemanticAuthority,
  verifyFreshClearanceEvidenceReceipt,
  createPcbDesignCompilationBundleRef,
  parsePcbDesignCompilationBundleRef,
  verifyPcbDesignCompilationBundleRef,
  PCB_DESIGN_COMPILATION_BUNDLE_LIMITS,
  type FreshAcceptanceResult,
  type FreshDesignAcceptanceResult,
  type FreshDesignClearanceEvidence,
  type FreshNetClassMaterialization,
  type FreshNetClassPreparationEvidence,
  type FreshNetClassSemanticAuthority,
  type FreshClearanceEvidenceReceipt,
  type LedIndicatorAcceptanceEvidence,
  type FreshProject,
  type FreshProjectNetClassSemanticProjection,
  type FreshProjectOpenPreparedSourceAuthority,
  type FreshDeepRuleReportMetadata,
  type PcbDesignCompilationBundle,
  type PcbDesignCompilationBundleDependencies,
  type PcbDesignCompilationBundleRef,
  createAnthropicHarnessProvider,
  createClaudeCliHarnessProvider,
  createCodexCliHarnessProvider,
  createOpenAIHarnessProvider,
  runPcbAgentHarness,
  type HarnessProvider,
  type HarnessInternalToolPort,
  type HarnessToolCall,
  type HarnessToolResult,
  type KicadHarnessSession,
  type ProviderFetch,
  type PcbAgentHarnessEvent,
  type PcbAgentHarnessRunReport,
  type PcbHarnessValidationSourceBinding,
  type PcbHarnessValidationSourceSnapshot,
  PCB_HARNESS_VALIDATION_SOURCE_BINDING_SCHEMA_VERSION,
  PCB_AGENT_MIN_ITERATIONS,
  PCB_AGENT_MAX_FRESH_ITERATIONS,
  PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS,
  MAXIMUM_CLI_PROVIDER_OUTPUT_BYTES,
} from "../harness/index.js";
import {
  KicadMcpTerminationUncertainError,
  createKicadMcpExpectedExecutableIdentity,
  type KicadMcpExpectedExecutableIdentity,
  type KicadMcpSessionOptions,
} from "../integrations/kicad-mcp-session.js";
import { runBoundedProcess, type BoundedProcessRunner } from "../integrations/bounded-process.js";
import { createSchematicRenderClearanceEvidence, verifyHostSchematicRenderClearanceEvidence, type SchematicRenderClearanceEvidence, type SchematicRenderClearanceExpected } from "../integrations/schematic-render-clearance.js";
import { verifyHostKicadNativePadObservation, type KicadNativePadObservation, type KicadNativePadObservationExpected } from "../integrations/kicad-native-pad-observation.js";
import { PCB_DESIGN_COMPILER_PROFILE_SCHEMA_VERSION } from "../harness/pcb-design-compilation-bundle.js";
import { PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION } from "../harness/pcb-design-compiler.js";
import { KicadCliAdapter, type KicadExecutableIdentity, type KicadSchematicSvgResult, type KicadSchematicSvgStrokeStyleResult } from "../integrations/kicad-cli.js";
import { isPathWithin } from "../integrations/path-boundary.js";

const REPORT_NAME = "pcb-agent-report.json";
const WORKING_PROJECT_NAME = "project";
const PREPARE_MARKER_NAME = ".evleda-pcb-agent-prepared.json";
export const PCB_AGENT_PROOF_OF_CONCEPT_RULE = "This is a local proof-of-concept layout pass only. Do not make manufacturing, release, safety, or qualification claims.";
/** Stable identity for the exact conditional fixed-rule profile used below. */
export function computePcbAgentHarnessRuleIdentity(
  freshTaskContract = FRESH_LED_INDICATOR_PROVIDER_CONTRACT,
  freshDeepRules: FreshDeepRuleReportMetadata = FRESH_LED_DEEP_RULE_POLICY.reportMetadata,
): string {
  return createHash("sha256").update(JSON.stringify({
    copyFixedRules: [PCB_AGENT_PROOF_OF_CONCEPT_RULE],
    freshFixedRules: [PCB_AGENT_PROOF_OF_CONCEPT_RULE, FRESH_PROJECT_PROMPT_CONTEXT],
    freshTaskContract,
    freshDeepRules,
    freshDeepRuleSelector: FRESH_LED_DEEP_RULE_POLICY.selection.deepRuleSelection,
    freshDesignerPromptMaxChars: FRESH_LED_DESIGNER_PROMPT_MAX_CHARS,
    mutationToolNames: DEFAULT_PCB_HARNESS_MUTATION_TOOL_NAMES,
  })).digest("hex");
}
export const PCB_AGENT_HARNESS_RULE_IDENTITY = computePcbAgentHarnessRuleIdentity();
const FRESH_LED_CONNECTIVITY_CONTRACT_IDENTITY = createFreshConnectivityContract(LED_INDICATOR_EXAMPLE).identity;
/** Exact mutation tool allowlist used by runPcbAgentHarness when no override is supplied. */
export const PCB_AGENT_MUTATION_ALLOWLIST = DEFAULT_PCB_HARNESS_MUTATION_TOOL_NAMES;

/** Exact harness policy identity for one authenticated generic bundle. */
export function computeGenericPcbAgentHarnessRuleIdentity(bundle: PcbDesignCompilationBundle): string {
  const reference = createPcbDesignCompilationBundleRef(bundle);
  return createHash("sha256").update(canonicalJson({
    workflowKind: "generic",
    proofRule: PCB_AGENT_PROOF_OF_CONCEPT_RULE,
    mutationToolNames: DEFAULT_PCB_HARNESS_MUTATION_TOOL_NAMES,
    bundleIdentity: reference.bundleIdentity,
    deepRuleBindingIdentity: bundle.deepRuleBinding.identity,
    executionPromptContentIdentity: bundle.executionPrompt.textContentIdentity,
  })).digest("hex");
}

export const KICAD_IPC_REQUIREMENT = "KiCad IPC unavailable: open the isolated output board in the supported KiCad app, enable Preferences -> Scripting -> IPC API Server, clear modal dialogs, then retry. This CLI never auto-launches KiCad.";
const IPC_PREPARE_INSTRUCTION = "Prepared isolated project. Open D:\\Codex-Recovery\\KiCad\\10.0\\bin\\pcbnew.exe <isolated-output>\\<board>.kicad_pcb, enable Preferences -> Scripting -> IPC API Server, clear modal dialogs, then run the same command with --resume.";

export function isUnsafeFreshConnectivityTerminal(value: unknown): boolean {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  return /FRESH_(?:CONNECTIVITY|ROUTE_REPLACEMENT|SYNC|BOARD_COMPOUND)_[A-Z_]*TERMINAL/u.test(text);
}

export function freshConnectivityParityOutputDirectory(outputRoot: string, nonce: string = randomUUID()): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce)) {
    throw new Error("Fresh connectivity parity nonce must be a UUID.");
  }
  const candidate = path.join(outputRoot, `.evleda-cli-connectivity-parity-${nonce.toLowerCase()}`);
  if (!isPathWithin(outputRoot, candidate, false)) throw new Error("Native connectivity parity output escaped the isolated run root.");
  return candidate;
}

function isCapabilityAllowlistMismatch(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth += 1) {
    if (/Required KiCad MCP capability\/allowlist mismatch/iu.test(current.message)) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

export const PCB_AGENT_EXIT_CODES = Object.freeze({ completed: 0, failed: 1, blocked: 1, needs_review: 2 });
export const PCB_AGENT_CLI_REPORT_SCHEMA_VERSION = "evleda.pcb-agent-cli-report.v2" as const;
export const PCB_AGENT_CLI_LEGACY_REPORT_SCHEMA_VERSION = "evleda.pcb-agent-cli-report.v1" as const;
export const PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION = "evleda.pcb-agent-workflow-binding.v2" as const;

interface PcbAgentCliCommonOptions {
  readonly provider: "openai" | "anthropic" | "codex" | "claude-cli";
  readonly model: string;
  readonly outputDir: string;
  readonly iterations: number;
  readonly openAiServiceTier: "fast" | "standard";
  readonly mode: "run" | "prepare" | "resume";
  readonly kicadCliPath?: string;
}

export interface PcbAgentCopiedProjectCliOptions extends PcbAgentCliCommonOptions {
  readonly workflowKind: "copied_project";
  readonly prompt: string;
  readonly projectDir: string;
  readonly newProjectName?: never;
  readonly compilationBundle?: never;
  readonly compilationBundleRef?: never;
}

export interface PcbAgentLedCompatibilityCliOptions extends PcbAgentCliCommonOptions {
  readonly workflowKind: "led_compatibility_fixture";
  readonly prompt: string;
  readonly newProjectName: string;
  readonly projectDir?: never;
  readonly compilationBundle?: never;
  readonly compilationBundleRef?: never;
}

export interface PcbAgentGenericFreshCliOptions extends PcbAgentCliCommonOptions {
  readonly workflowKind: "generic";
  readonly mode: "prepare" | "resume";
  readonly newProjectName: string;
  readonly projectDir?: never;
  readonly prompt?: never;
  /** Must be returned by the strict create/parse bundle boundary. */
  readonly compilationBundle: PcbDesignCompilationBundle;
  readonly compilationBundleRef: PcbDesignCompilationBundleRef;
}

/** Every executable workflow is explicitly discriminated and mutually exclusive. */
export type PcbAgentCliOptions =
  | PcbAgentCopiedProjectCliOptions
  | PcbAgentLedCompatibilityCliOptions
  | PcbAgentGenericFreshCliOptions;

/** Exact, mode-bound KiCad-MCP capability set used by runtime approval and execution. */
export function pcbAgentRequiredSessionTools(options: PcbAgentCliOptions): readonly string[] {
  const tools = options.workflowKind === "copied_project"
    ? KICAD_HARNESS_TOOL_NAMES
    : options.workflowKind === "generic"
      ? KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES
      : KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES;
  return Object.freeze([...tools].sort());
}

export interface PcbAgentCheckpointOpenOptions {
  readonly mode: "checkpoint-open";
  readonly newProjectName: string;
  readonly outputDir: string;
  readonly expectedNetClassProjection?: FreshProjectNetClassSemanticProjection;
  readonly expectedPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority;
}

export async function runPcbAgentCheckpointOpen(options: Omit<PcbAgentCheckpointOpenOptions, "mode">) {
  return checkpointFreshProjectOpenNormalization({
    outputDir: options.outputDir,
    name: options.newProjectName,
    ...(options.expectedNetClassProjection === undefined
      ? {}
      : { expectedNetClassProjection: options.expectedNetClassProjection }),
    ...(options.expectedPreparedSourceAuthority === undefined
      ? {}
      : { expectedPreparedSourceAuthority: options.expectedPreparedSourceAuthority }),
  });
}

interface PcbAgentCliReportBase {
  readonly status: "completed" | "needs_review" | "blocked" | "failed";
  readonly provider: "openai" | "anthropic" | "codex" | "claude-cli";
  readonly model: string;
  readonly projectPaths: {
    readonly sourceProjectPath: string;
    readonly isolatedProjectPath: string;
    readonly outputPath: string;
    readonly reportPath: string;
  };
  readonly summary: string;
  readonly ruleProfile: {
    readonly harnessRuleIdentity: string;
    readonly deepRules?: FreshDeepRuleReportMetadata;
  };
  readonly harness?: PcbAgentHarnessRunReport;
  readonly freshAcceptance?: FreshAcceptanceResult | FreshDesignAcceptanceResult;
  /** Host-only durable-save audit for marker-bound fresh projects. */
  readonly freshBoardSaveAudits?: readonly import("../harness/fresh-board-persistence.js").FreshBoardSaveAudit[];
  /** Path-free host materialization/readback records for generic net classes. */
  readonly freshNetClassMaterialization?: FreshNetClassMaterialization;
  readonly freshNetClassSemanticAuthority?: FreshNetClassSemanticAuthority;
  readonly freshNetClassPreparationEvidence?: FreshNetClassPreparationEvidence;
  /** Private lifecycle authority for exact post-prepare, pre-Open project sources. */
  readonly freshProjectOpenPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority;
  readonly freshClearanceEvidenceReceipt?: FreshClearanceEvidenceReceipt;
  readonly freshClearanceEvidenceProblem?: string;
  /** Separate path-free native ink-clearance receipt; not electrical or layout-quality proof. */
  readonly freshSchematicRenderClearanceEvidence?: SchematicRenderClearanceEvidence;
  readonly sidecar?: unknown;
  readonly writeSessionReceiptIdentity?: CanonicalIdentity;
}

export interface PcbAgentCliReportV1 extends PcbAgentCliReportBase {
  readonly schemaVersion: typeof PCB_AGENT_CLI_LEGACY_REPORT_SCHEMA_VERSION;
}

export type PcbAgentWorkflowReportBinding = Readonly<({
  readonly schemaVersion: typeof PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION;
  readonly identity: CanonicalIdentity;
} & (
  | { readonly kind: "copied_project" }
  | { readonly kind: "led_compatibility_fixture"; readonly connectivityContractIdentity: CanonicalIdentity }
  | {
      readonly kind: "generic";
      readonly bundleRef: PcbDesignCompilationBundleRef;
      readonly contractIdentity: CanonicalIdentity;
      readonly libraryBindingIdentity: CanonicalIdentity;
      readonly deepRuleBindingIdentity: CanonicalIdentity;
      readonly practiceProfileBindingIdentity: CanonicalIdentity;
      readonly acceptancePlanIdentity: CanonicalIdentity;
      readonly executionPromptContentIdentity: ContentIdentity;
    }
))>;

export interface PcbAgentCliReportV2 extends PcbAgentCliReportBase {
  readonly schemaVersion: typeof PCB_AGENT_CLI_REPORT_SCHEMA_VERSION;
  readonly workflow: PcbAgentWorkflowReportBinding;
}

/** Stored V1 reports remain readable while new executions emit V2. */
export type PcbAgentCliReport = PcbAgentCliReportV1 | PcbAgentCliReportV2;

const ruleProfileFor = (options: PcbAgentCliOptions, freshProject: FreshProject | undefined): PcbAgentCliReport["ruleProfile"] => {
  if (options.workflowKind === "generic") {
    return {
      harnessRuleIdentity: computeGenericPcbAgentHarnessRuleIdentity(options.compilationBundle),
    };
  }
  return {
    harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY,
    ...(freshProject === undefined ? {} : { deepRules: FRESH_LED_DEEP_RULE_POLICY.reportMetadata }),
  };
};

function assertCliWorkflowShape(options: PcbAgentCliOptions): void {
  if (options.workflowKind === "generic") {
    if (Object.hasOwn(options, "prompt") || Object.hasOwn(options, "projectDir")
        || (options.mode !== "prepare" && options.mode !== "resume")
        || typeof options.newProjectName !== "string"
        || options.compilationBundle === undefined || options.compilationBundleRef === undefined) {
      throw new Error("Generic CLI workflow accepts only a fresh project plus an authenticated compilation bundle and reference; copied-project and prompt fields are forbidden.");
    }
    return;
  }
  if (options.workflowKind === "led_compatibility_fixture") {
    if (Object.hasOwn(options, "projectDir") || Object.hasOwn(options, "compilationBundle") || Object.hasOwn(options, "compilationBundleRef")
        || typeof options.newProjectName !== "string" || typeof options.prompt !== "string") {
      throw new Error("LED compatibility workflow requires only its explicit fresh-project prompt mode.");
    }
    return;
  }
  if (options.workflowKind !== "copied_project" || Object.hasOwn(options, "newProjectName")
      || Object.hasOwn(options, "compilationBundle") || Object.hasOwn(options, "compilationBundleRef")
      || typeof options.projectDir !== "string" || typeof options.prompt !== "string") {
    throw new Error("Copied-project workflow has an invalid or ambiguous execution shape.");
  }
}

function bindGenericCliBundle(
  options: PcbAgentGenericFreshCliOptions,
  dependencies: PcbDesignCompilationBundleDependencies | undefined,
): PcbDesignCompilationBundle {
  const reference = parsePcbDesignCompilationBundleRef(options.compilationBundleRef);
  // createPcbDesignCompilationBundleRef rejects a shape-compatible value that
  // did not cross the authenticated bundle create/parse boundary.
  const authenticatedReference = createPcbDesignCompilationBundleRef(options.compilationBundle);
  if (canonicalJson(reference) !== canonicalJson(authenticatedReference)) {
    throw new Error("Generic CLI bundle reference does not match the authenticated compilation bundle.");
  }
  if (dependencies === undefined) {
    throw new Error("Generic fresh execution requires trusted compilation-bundle dependencies for independent acceptance regeneration.");
  }
  const bundle = verifyPcbDesignCompilationBundleRef(reference, options.compilationBundle, dependencies);
  if (bundle.compilerProfile.schemaVersion !== PCB_DESIGN_COMPILER_PROFILE_SCHEMA_VERSION || bundle.acceptancePlan.schemaVersion !== PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION) throw new Error("Generic prepare/resume requires a newly compiled current ink-clearance acceptance profile; historical V1 bundles cannot authorize execution.");
  // Admission uses the independently verified contract envelope. Mutation still
  // crosses the geometry, native stroke, batch capability and aggregate-work gates.
  return bundle;
}

function workflowReportBinding(options: PcbAgentCliOptions): PcbAgentWorkflowReportBinding {
  const payload = options.workflowKind === "copied_project"
    ? { schemaVersion: PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION, kind: options.workflowKind }
    : options.workflowKind === "led_compatibility_fixture"
      ? {
          schemaVersion: PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION,
          kind: options.workflowKind,
          connectivityContractIdentity: FRESH_LED_CONNECTIVITY_CONTRACT_IDENTITY,
        }
      : {
          schemaVersion: PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION,
          kind: options.workflowKind,
          bundleRef: options.compilationBundleRef,
          contractIdentity: options.compilationBundle.contract.identity,
          libraryBindingIdentity: options.compilationBundle.libraryBinding.identity,
          deepRuleBindingIdentity: options.compilationBundle.deepRuleBinding.identity,
          practiceProfileBindingIdentity: options.compilationBundle.practiceProfileBinding.identity,
          acceptancePlanIdentity: options.compilationBundle.acceptancePlan.identity,
          executionPromptContentIdentity: options.compilationBundle.executionPrompt.textContentIdentity,
        };
  return Object.freeze({
    ...payload,
    identity: canonicalIdentity(payload, PCB_AGENT_WORKFLOW_BINDING_SCHEMA_VERSION),
  }) as PcbAgentWorkflowReportBinding;
}

const captureFreshSources = async (fresh: FreshProject): Promise<Readonly<{
  schematicSource: string;
  pcbSource: string;
  snapshot: PcbHarnessValidationSourceSnapshot;
}>> => {
  const readOptional = async (filePath: string, maximumBytes: number): Promise<Buffer | null> => {
    try { return await readBoundedOrdinaryFile(filePath, maximumBytes, "Fresh optional source"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const [schematicSource, pcbSource, projectSettings, symbolLibraryTable, footprintLibraryTable, freshMarker, customRules] = await Promise.all([
    readBoundedOrdinaryFile(fresh.schematicPath, 64 * 1024 * 1024, "Fresh schematic source"),
    readBoundedOrdinaryFile(fresh.pcbPath, 64 * 1024 * 1024, "Fresh PCB source"),
    readBoundedOrdinaryFile(path.join(fresh.projectPath, `${fresh.name}.kicad_pro`), 16 * 1024 * 1024, "Fresh project settings"),
    readBoundedOrdinaryFile(path.join(fresh.projectPath, "sym-lib-table"), 2 * 1024 * 1024, "Fresh symbol library table"),
    readBoundedOrdinaryFile(path.join(fresh.projectPath, "fp-lib-table"), 2 * 1024 * 1024, "Fresh footprint library table"),
    readBoundedOrdinaryFile(fresh.markerPath, 2 * 1024 * 1024, "Fresh project marker"),
    readOptional(path.join(fresh.projectPath, `${fresh.name}.kicad_dru`), 4 * 1024 * 1024),
  ]);
  const schematicText = schematicSource.toString("utf8");
  const pcbText = pcbSource.toString("utf8");
  return Object.freeze({
    schematicSource: schematicText,
    pcbSource: pcbText,
    snapshot: Object.freeze({
      schematic: contentIdentity(schematicSource),
      pcb: contentIdentity(pcbSource),
      projectSettings: contentIdentity(projectSettings),
      symbolLibraryTable: contentIdentity(symbolLibraryTable),
      footprintLibraryTable: contentIdentity(footprintLibraryTable),
      freshMarker: contentIdentity(freshMarker),
      customRules: customRules === null ? null : contentIdentity(customRules),
    }),
  });
};

export interface PcbAgentCliExecution {
  readonly report: PcbAgentCliReport;
  readonly reportPath: string;
  readonly isolatedProjectPath: string;
  readonly exitCode: number;
}

/** Keeps the terminal CLI disposition consistent with the exact acceptance evidence persisted beside it. */
export function reconcileFreshTerminalHarness(
  harness: PcbAgentHarnessRunReport,
  acceptance: FreshAcceptanceResult | FreshDesignAcceptanceResult,
): PcbAgentHarnessRunReport {
  if (harness.status !== "completed" || acceptance.passed) return harness;
  return {
    ...harness,
    status: "needs_review",
    summary: `Terminal fresh acceptance recheck did not pass: ${acceptance.missing.join(" ") || "acceptance evidence unavailable."}`,
    validation: {
      ...harness.validation,
      status: harness.validation.runs === 0 ? "not_run" : "unresolved",
      unresolvedItems: [...new Set([...harness.validation.unresolvedItems, ...acceptance.missing])],
    },
  };
}

/** Best-effort local progress stream; it never changes CLI stdout, reports, or exit status. */
export type PcbAgentCliEvent = PcbAgentHarnessEvent | Readonly<{
  readonly type: "report";
  readonly report: PcbAgentCliReport;
}>;

export type PcbAgentCliObserver = (event: PcbAgentCliEvent) => void | Promise<void>;

interface SessionLike extends KicadHarnessSession {
  close?(): Promise<void>;
  readonly identity?: unknown;
}

export interface PcbAgentCliDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: ProviderFetch;
  readonly repositoryRoot?: string;
  readonly sessionFactory?: (options: KicadMcpSessionOptions) => Promise<SessionLike>;
  /** Host-owned, executable-pinned KiCad CLI adapter factory for production fallback/readback. */
  readonly createKicadCliAdapter?: typeof KicadCliAdapter.create;
  /** Expected path-free mode/socket/run authority for the injected production session. */
  readonly sessionAuthorityIdentity?: CanonicalIdentity;
  readonly observer?: PcbAgentCliObserver;
  /** Deterministic test seam; production always uses the closed evaluator. */
  readonly freshAcceptanceEvaluator?: (evidence: LedIndicatorAcceptanceEvidence) => FreshAcceptanceResult;
  /** Trusted dependencies used to parse/reverify and independently accept a generic bundle. */
  readonly compilationBundleDependencies?: PcbDesignCompilationBundleDependencies;
  /**
   * Narrow host seam for prepare-time materialization, stable semantic
   * readback, and final clearance readback. It receives only capability-bound
   * project/bundle objects, never arbitrary paths or caller-provided sources.
   */
  readonly freshDesignClearanceEvidencePort?: Readonly<{
    /** Exact probed identity used again by the CLI's independent receipt verifier. */
    readonly kicad: KicadExecutableIdentity;
    materialize: (input: Readonly<{ bundle: PcbDesignCompilationBundle; project: FreshProject }>) => Promise<FreshNetClassMaterialization>;
    readSemanticAuthority: (input: Readonly<{ bundle: PcbDesignCompilationBundle; project: FreshProject }>) => Promise<FreshNetClassSemanticAuthority>;
    read: (input: Readonly<{ bundle: PcbDesignCompilationBundle; project: FreshProject }>) => Promise<FreshClearanceEvidenceReceipt>;
  }>;
  /** Host/test native SVG exporter seam; receipt generation and source/tool binding remain host verified. */
  readonly freshSchematicRenderCollector?: (input: Readonly<{ bundle: PcbDesignCompilationBundle; project: FreshProject; validationSourceBinding: PcbHarnessValidationSourceBinding }>) => Promise<KicadSchematicSvgResult>;
  /** Lifecycle-owned authority expected on generic resume; it must match the persisted prepare report exactly. */
  readonly expectedFreshNetClassPreparationEvidence?: FreshNetClassPreparationEvidence;
  /** Lifecycle-owned pre-Open source authority; generic resume never trusts a reminted local report/checkpoint. */
  readonly expectedFreshProjectOpenPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority;
  /** Test/host seam when the normal pinned KiCad CLI netlist export is unavailable. */
  readonly freshDesignNetlistCollector?: (input: Readonly<{
    bundle: PcbDesignCompilationBundle;
    project: FreshProject;
    schematicSource: string;
    pcbSource: string;
  }>) => Promise<string>;
}

export interface PreparedProject {
  readonly sourceProjectPath: string;
  readonly outputPath: string;
  readonly isolatedProjectPath: string;
  readonly reportPath: string;
  readonly freshProject?: FreshProject;
}

export const DIRECT_KICAD_MCP_VERSION_PROBE_TIMEOUT_MS = 30_000;
export const DIRECT_KICAD_MCP_VERSION_PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

export type DirectKicadMcpFallbackDiagnostic = Readonly<{
  label: string;
  status: "unavailable" | "not a file" | "rejected";
  error?: unknown;
}>;

/** Path-free diagnostic label retained only for compatibility with private callers. */
export function directKicadMcpCandidateLabel(candidate: string): string {
  return `direct-candidate-${createHash("sha256").update(path.resolve(candidate).toLocaleLowerCase("en-US")).digest("hex").slice(0, 16)}`;
}

/** Raw launch errors are deliberately collapsed before they can reach a report/runtime surface. */
export function directKicadMcpFallbackFailure(
  _uvxError: unknown,
  diagnostics: readonly DirectKicadMcpFallbackDiagnostic[],
): Error {
  return new Error(
    `Pinned KiCad MCP launch failed closed; direct fallback is unavailable (${diagnostics.length} categorical candidate result(s)).`,
  );
}

const sameExecutableIdentity = (
  left: KicadMcpExpectedExecutableIdentity,
  right: KicadMcpExpectedExecutableIdentity,
): boolean => canonicalJson(left) === canonicalJson(right);

const minimalKicadProbeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME"]) {
    const value = environment[key];
    if (value === undefined || value === "") continue;
    if (/[\0\r\n]/u.test(value)) throw new Error("Direct KiCad MCP probe environment contains controls.");
    result[key] = value;
  }
  return Object.freeze({ ...result, NO_COLOR: "1", LANG: "C", LANGUAGE: "C", LC_ALL: "C" });
};

/** A direct entry point is admitted only under an exact caller-supplied physical/byte pin. */
export async function verifyDirectKicadMcpExecutable(
  command: string,
  cwd: string,
  expectedIdentity: KicadMcpExpectedExecutableIdentity,
  environment: Readonly<Record<string, string | undefined>>,
  runner: BoundedProcessRunner = runBoundedProcess,
): Promise<string> {
  const before = await createKicadMcpExpectedExecutableIdentity(command);
  if (!sameExecutableIdentity(before, expectedIdentity)) throw new Error("Direct KiCad MCP executable does not match its pinned identity.");
  let result;
  try {
    result = await runner({
      command: before.path,
      args: ["version", "--json"],
      cwd,
      env: minimalKicadProbeEnvironment(environment),
      timeoutMs: DIRECT_KICAD_MCP_VERSION_PROBE_TIMEOUT_MS,
      maxOutputBytes: DIRECT_KICAD_MCP_VERSION_PROBE_MAX_OUTPUT_BYTES,
    });
  } catch {
    throw new Error("Direct KiCad MCP executable probe failed closed.");
  }
  const after = await createKicadMcpExpectedExecutableIdentity(command);
  if (!sameExecutableIdentity(after, expectedIdentity)) throw new Error("Direct KiCad MCP executable identity changed during its probe.");
  if (result.exitCode !== 0) throw new Error("Configured direct KiCad MCP executable rejected its bounded version check.");
  let identity: { package?: { name?: unknown; version?: unknown } };
  try { identity = JSON.parse(result.stdout) as { package?: { name?: unknown; version?: unknown } }; }
  catch { throw new Error("Configured direct KiCad MCP executable returned invalid version JSON."); }
  if (identity.package?.name !== "kicad-mcp-pro" || identity.package.version !== "3.33.3") {
    throw new Error("Configured direct KiCad MCP executable is not kicad-mcp-pro 3.33.3.");
  }
  return before.path;
}

export const pcbAgentUsage = `Usage: pnpm pcb-agent --workflow <kind> --model <model> (--project-dir <source-dir> | --new-project <safe-name>) --output-dir <empty-dir> [options]

Options:
  --workflow copied_project|led_compatibility_fixture|generic
                              Explicit execution contract. Generic is fresh-project only.
  --prompt-file <path>          Read the prompt from UTF-8 (copied/LED only; instead of --prompt)
  --bundle-file <path>          Canonical generic PcbDesignCompilationBundle JSON
  --bundle-ref-file <path>      Exact PcbDesignCompilationBundleRef JSON paired with --bundle-file
  --provider openai|anthropic|codex|claude-cli
                              Provider (default: openai). Codex and Claude Code use their local authenticated CLIs.
  --model <model>               Required provider model identifier
  --project-dir <source-dir>    Source KiCad project directory; never edited directly
  --new-project <safe-name>     Create a hash-marked empty KiCad 10 project; use with --prepare, then --resume
  --output-dir <empty-dir>      Empty destination for the isolated project and JSON report
  --iterations ${PCB_AGENT_MIN_ITERATIONS}..5 (${PCB_AGENT_MIN_ITERATIONS}..${PCB_AGENT_MAX_FRESH_ITERATIONS} fresh) Bounded edit/validation attempts (default: 3)
  --standard                    Use OpenAI HTTP standard tier instead of the default fast tier (ignored by local CLI providers)
  --prepare                     Copy and mark the isolated project, then stop for KiCad IPC setup
  --resume                      Continue an existing marked isolated project
  --checkpoint-open             Provider-free: accept only audited KiCad 10 blank-project .kicad_pro normalization
  --kicad-cli <path>            Explicit KiCad CLI fallback executable
  --help                        Show this help

Exit status: 0 completed, 1 blocked or failed, 2 needs review. This is a proof of concept, not a manufacturing or release workflow.`;

const nonBlank = (value: string | undefined, label: string): string => {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
};

function absolute(value: string, cwd: string): string {
  return path.resolve(cwd, value);
}

async function readBoundedOrdinaryFile(filePath: string, maximumBytes: number, label: string): Promise<Buffer> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be an ordinary non-link file.`);
  if (metadata.size > maximumBytes) throw new Error(`${label} exceeds its ${maximumBytes}-byte limit.`);
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeded its ${maximumBytes}-byte limit while being read.`);
  return bytes;
}

interface NativeSchematicStyleSeedManifest {
  readonly schemaVersion: "evleda.native-schematic-style-seed-manifest.v1";
  readonly configDirectories: readonly string[];
  readonly cacheDirectories: readonly string[];
  readonly files: readonly Readonly<{ relativePath: string; sizeBytes: number; sha256: string }>[];
  readonly materialization: {
    readonly schemaVersion: "evleda.native-schematic-style-seed-materialization.v1";
    readonly relativePath: "10.0/kicad_common.json";
    readonly substitutions: readonly Readonly<Record<string, unknown>>[];
    readonly timing: "before-owned-instance-capture";
    readonly preserveOtherBytes: true;
  };
}

/** Pure, closed template transform: only the two native-verified context strings may change. */
export function materializeNativeSchematicStyleContext(source: string, approvedCliPath: string, ownedExportCwd: string): string {
  if (!path.isAbsolute(approvedCliPath) || !path.isAbsolute(ownedExportCwd) || !source.isWellFormed()) throw new Error("Native style materialization needs absolute approved paths and exact UTF-8 template text.");
  const parsed = parsePortableJsonBytes(Buffer.from(source, "utf8"), { maxBytes: 1024 * 1024, maxDepth: 32, maxNodes: 100000 }) as { api?: { interpreter_path?: unknown }; system?: { working_dir?: unknown } };
  if (parsed.api?.interpreter_path !== "" || parsed.system?.working_dir !== "") throw new Error("Native style template context fields are not the expected two empty strings.");
  let result = source;
  for (const [key, value] of [["interpreter_path", path.join(path.dirname(approvedCliPath), "pythonw.exe")], ["working_dir", ownedExportCwd]] as const) {
    const expression = new RegExp(`("${key}"\\s*:\\s*)""`, "gu");
    if ([...result.matchAll(expression)].length !== 1) throw new Error(`Native style template does not expose exactly one known ${key} token.`);
    result = result.replace(expression, (_match, prefix: string) => `${prefix}${JSON.stringify(value)}`);
  }
  return result;
}

async function prepareOwnedNativeSchematicStyleSeed(outputRoot: string, exportCwd: string, executable: KicadExecutableIdentity) {
  const resourceRoot = fileURLToPath(new URL("../../resources/native-schematic-style-seed/v1/", import.meta.url));
  // candidate-manifest.json is deliberately never accepted. A missing published
  // manifest means this capability is not installed/verified, not a fallback.
  const bytes = await readBoundedOrdinaryFile(path.join(resourceRoot, "manifest.json"), 256 * 1024, "Verified native schematic style seed manifest");
  const value = parsePortableJsonBytes(bytes, { maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 10000 }) as Partial<NativeSchematicStyleSeedManifest>;
  const safeRelative = (entry: unknown): entry is string => typeof entry === "string" && entry.length <= 200
    && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(entry) && entry.split("/").every((part) => part !== "." && part !== "..");
  if (value.schemaVersion !== "evleda.native-schematic-style-seed-manifest.v1"
      || !Array.isArray(value.configDirectories) || !Array.isArray(value.cacheDirectories) || !Array.isArray(value.files)
      || value.configDirectories.length > 32 || value.cacheDirectories.length > 32 || value.files.length !== 8
      || !value.configDirectories.every(safeRelative) || !value.cacheDirectories.every(safeRelative)
      || new Set(value.configDirectories.map((entry) => entry.toLowerCase())).size !== value.configDirectories.length
      || new Set(value.cacheDirectories.map((entry) => entry.toLowerCase())).size !== value.cacheDirectories.length
      || !value.configDirectories.includes("10.0/colors") || !value.cacheDirectories.includes("KiCad/10.0")) throw new Error("Verified native style seed manifest has an invalid directory/file envelope.");
  const expectedMaterialization = { schemaVersion: "evleda.native-schematic-style-seed-materialization.v1", relativePath: "10.0/kicad_common.json",
    substitutions: [{ jsonPointer: "/api/interpreter_path", expectedValue: "", valueSource: "approved-kicad-cli-sibling", siblingName: "pythonw.exe" },
      { jsonPointer: "/system/working_dir", expectedValue: "", valueSource: "owned-native-export-cwd" }], timing: "before-owned-instance-capture", preserveOtherBytes: true };
  if (canonicalJson(value.materialization ?? null) !== canonicalJson(expectedMaterialization)) throw new Error("Native style seed requires the exact reviewed two-field context materialization recipe.");
  const records: { relativePath: string; bytes: Buffer }[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  for (const record of value.files) {
    if (record === null || !safeRelative(record.relativePath) || !record.relativePath.startsWith("10.0/") || !record.relativePath.endsWith(".json")
        || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1 || record.sizeBytes > 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(record.sha256)
        || names.has(record.relativePath.toLowerCase())) throw new Error("Native style seed contains an invalid or duplicate file record.");
    names.add(record.relativePath.toLowerCase());
    const sourcePath = path.join(resourceRoot, "config", ...record.relativePath.split("/"));
    const source = await readBoundedOrdinaryFile(sourcePath, 1024 * 1024, "Native style seed file");
    const identity = contentIdentity(source);
    if (identity.size !== record.sizeBytes || identity.digest !== record.sha256) throw new Error(`Native style seed file changed: ${record.relativePath}.`);
    totalBytes += source.length;
    if (totalBytes > 2 * 1024 * 1024) throw new Error("Native style seed exceeds its total bounded byte envelope.");
    records.push({ relativePath: record.relativePath, bytes: source });
  }
  const expectedTemplates = ["3d_viewer", "cvpcb", "eeschema", "fpedit", "kicad", "kicad_common", "pcbnew", "symbol_editor"]
    .map((name) => `10.0/${name}.json`);
  if (!expectedTemplates.every((name) => names.has(name))) throw new Error("Native style seed must contain exactly the eight reviewed application/common templates.");
  const canonicalOutput = await realpath(outputRoot);
  const canonicalCwd = await realpath(exportCwd);
  if (!isPathWithin(canonicalOutput, canonicalCwd, false)) throw new Error("Native style export project is outside its owned output root.");
  const ownedRoot = path.join(canonicalOutput, `schematic-style-${randomUUID()}`);
  await mkdir(ownedRoot);
  const configHome = path.join(ownedRoot, "config"), cacheHome = path.join(ownedRoot, "cache");
  await mkdir(configHome); await mkdir(cacheHome);
  for (const [base, directories] of [[configHome, value.configDirectories], [cacheHome, value.cacheDirectories]] as const) {
    for (const relativePath of [...directories].sort()) await mkdir(path.join(base, ...relativePath.split("/")), { recursive: true });
  }
  for (const record of records) {
    const materialized = record.relativePath === "10.0/kicad_common.json"
      ? Buffer.from(materializeNativeSchematicStyleContext(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(record.bytes), executable.path, canonicalCwd), "utf8")
      : record.bytes;
    await writeFile(path.join(configHome, ...record.relativePath.split("/")), materialized, { flag: "wx" });
  }
  return Object.freeze({ configHome, cacheHome, templateManifestIdentity: contentIdentity(bytes) });
}

interface PersistedFreshNetClassPreparation {
  readonly materialization: FreshNetClassMaterialization;
  readonly semanticAuthority: FreshNetClassSemanticAuthority;
  readonly evidence: FreshNetClassPreparationEvidence;
  readonly preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
}

async function readPersistedFreshNetClassPreparation(reportPath: string): Promise<PersistedFreshNetClassPreparation> {
  let value: unknown;
  try {
    value = parsePortableJsonBytes(
      await readBoundedOrdinaryFile(reportPath, 16 * 1024 * 1024, "Generic prepare report"),
      {
        maxBytes: 16 * 1024 * 1024,
        maxDepth: 96,
        maxNodes: 500_000,
        maxArrayLength: 100_000,
        maxOwnKeys: 8_192,
        maxKeyBytes: 1_024,
        maxStringBytes: 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error("Generic resume requires a bounded duplicate-free prepare report.", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Generic resume prepare report must be a JSON object.");
  }
  const report = value as Readonly<Record<string, unknown>>;
  const workflow = report.workflow;
  if (report.schemaVersion !== PCB_AGENT_CLI_REPORT_SCHEMA_VERSION
      || workflow === null || typeof workflow !== "object" || Array.isArray(workflow)
      || (workflow as Readonly<Record<string, unknown>>).kind !== "generic") {
    throw new Error("Generic resume requires the current generic prepare report schema.");
  }
  const materialization = report.freshNetClassMaterialization as FreshNetClassMaterialization;
  const semanticAuthority = report.freshNetClassSemanticAuthority as FreshNetClassSemanticAuthority;
  let evidence: FreshNetClassPreparationEvidence;
  let preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
  try {
    evidence = parseFreshNetClassPreparationEvidence(report.freshNetClassPreparationEvidence);
    const reconstructed = createFreshNetClassPreparationEvidence(materialization, semanticAuthority);
    if (canonicalJson(reconstructed) !== canonicalJson(evidence)) {
      throw new Error("reconstructed preparation evidence differs");
    }
    preparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(report.freshProjectOpenPreparedSourceAuthority);
    if (canonicalJson(preparedSourceAuthority.pro) !== canonicalJson(materialization.projectSettingsIdentity)
        || canonicalJson(preparedSourceAuthority.pcb) !== canonicalJson(materialization.pcbIdentityAtMaterialization)
        || canonicalJson(preparedSourceAuthority.marker) !== canonicalJson(materialization.freshMarkerContentIdentity)) {
      throw new Error("prepared-source authority differs from materialization sources");
    }
  } catch (error) {
    throw new Error("Generic resume prepare report lacks valid closed preparation authority.", { cause: error });
  }
  return Object.freeze({ materialization, semanticAuthority, evidence, preparedSourceAuthority });
}

async function assertCurrentFreshProjectPreparedSources(
  freshProject: FreshProject,
  authority: FreshProjectOpenPreparedSourceAuthority,
): Promise<void> {
  if (canonicalJson(freshProject.projectIdentity) !== canonicalJson(authority.projectIdentity)) {
    throw new Error("Generic fresh-project root differs from lifecycle-owned prepared-source authority.");
  }
  const current = (await captureFreshSources(freshProject)).snapshot;
  const expected = {
    schematic: authority.sch,
    pcb: authority.pcb,
    symbolLibraryTable: authority.sym,
    footprintLibraryTable: authority.fp,
    freshMarker: authority.marker,
  } as const;
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (canonicalJson(current[key]) !== canonicalJson(expected[key])) {
      throw new Error(`Generic ${key} differs from lifecycle-owned prepared-source authority.`);
    }
  }
}

/** Parses only the small documented CLI surface; unknown switches fail closed. */
export async function parsePcbAgentCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
  compilationBundleDependencies?: PcbDesignCompilationBundleDependencies,
): Promise<PcbAgentCliOptions | PcbAgentCheckpointOpenOptions | { readonly help: true }> {
  const values = new Map<string, string>();
  let standard = false;
  let mode: PcbAgentCliOptions["mode"] | PcbAgentCheckpointOpenOptions["mode"] = "run";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--standard") {
      if (standard) throw new Error("--standard may be specified once.");
      standard = true;
      continue;
    }
    if (argument === "--prepare" || argument === "--resume" || argument === "--checkpoint-open") {
      if (mode !== "run") throw new Error("Choose at most one of --prepare, --resume, or --checkpoint-open.");
      mode = argument === "--prepare" ? "prepare" : argument === "--resume" ? "resume" : "checkpoint-open";
      continue;
    }
    if (!argument?.startsWith("--") || !["--workflow", "--prompt", "--prompt-file", "--bundle-file", "--bundle-ref-file", "--provider", "--model", "--project-dir", "--new-project", "--output-dir", "--iterations", "--kicad-cli"].includes(argument)) {
      throw new Error(`Unsupported argument: ${argument ?? ""}.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (values.has(argument)) throw new Error(`${argument} may be specified once.`);
    values.set(argument, value);
    index += 1;
  }

  const inlinePrompt = values.get("--prompt");
  const promptFile = values.get("--prompt-file");
  const bundleFile = values.get("--bundle-file");
  const bundleRefFile = values.get("--bundle-ref-file");
  const projectDir = values.get("--project-dir");
  const newProjectName = values.get("--new-project");
  if (mode === "checkpoint-open") {
    if (projectDir !== undefined || newProjectName === undefined) throw new Error("--checkpoint-open requires --new-project and forbids --project-dir.");
    return { mode, newProjectName: nonBlank(newProjectName, "--new-project"), outputDir: absolute(nonBlank(values.get("--output-dir"), "--output-dir"), cwd) };
  }
  const workflowValue = nonBlank(values.get("--workflow"), "--workflow");
  if (!["copied_project", "led_compatibility_fixture", "generic"].includes(workflowValue)) {
    throw new Error("--workflow must be copied_project, led_compatibility_fixture, or generic.");
  }
  const workflowKind = workflowValue as PcbAgentCliOptions["workflowKind"];
  if (workflowKind === "generic") {
    if (inlinePrompt !== undefined || promptFile !== undefined) throw new Error("Generic workflow takes its exact prompt only from --bundle-file; --prompt and --prompt-file are forbidden.");
    if (bundleFile === undefined || bundleRefFile === undefined) throw new Error("Generic workflow requires both --bundle-file and --bundle-ref-file.");
    if (compilationBundleDependencies === undefined) throw new Error("Generic workflow requires trusted compilation-bundle dependencies before CLI options can be constructed.");
  } else {
    if ((inlinePrompt === undefined) === (promptFile === undefined)) throw new Error("Provide exactly one of --prompt or --prompt-file.");
    if (bundleFile !== undefined || bundleRefFile !== undefined) throw new Error("Compilation-bundle files are available only to the generic workflow.");
  }
  const prompt = workflowKind === "generic"
    ? undefined
    : inlinePrompt === undefined
      ? await readFile(absolute(nonBlank(promptFile, "--prompt-file"), cwd), "utf8")
      : inlinePrompt;
  const providerValue = values.get("--provider") ?? "openai";
  if (providerValue !== "openai" && providerValue !== "anthropic" && providerValue !== "codex" && providerValue !== "claude-cli") {
    throw new Error("--provider must be openai, anthropic, codex, or claude-cli.");
  }
  const provider: PcbAgentCliOptions["provider"] = providerValue;
  if (standard && provider !== "openai") throw new Error("--standard is only available with --provider openai.");
  if ((projectDir === undefined) === (newProjectName === undefined)) throw new Error("Provide exactly one of --project-dir or --new-project.");
  if (workflowKind === "copied_project" && projectDir === undefined) throw new Error("copied_project requires --project-dir and forbids --new-project.");
  if (workflowKind !== "copied_project" && newProjectName === undefined) throw new Error(`${workflowKind} requires --new-project and forbids --project-dir.`);
  if (newProjectName !== undefined && mode === "run") throw new Error("--new-project requires --prepare first, then --resume.");
  const rawIterations = values.get("--iterations") ?? "3";
  const iterationMaximum = newProjectName === undefined ? 5 : PCB_AGENT_MAX_FRESH_ITERATIONS;
  if (!/^\d+$/u.test(rawIterations) || Number(rawIterations) < PCB_AGENT_MIN_ITERATIONS || Number(rawIterations) > iterationMaximum) {
    throw new Error(`--iterations must be an integer from ${PCB_AGENT_MIN_ITERATIONS} through ${iterationMaximum}${newProjectName === undefined ? " for copied projects" : " for fresh projects"}.`);
  }
  const common = {
    provider,
    model: nonBlank(values.get("--model"), "--model"),
    outputDir: absolute(nonBlank(values.get("--output-dir"), "--output-dir"), cwd),
    iterations: Number(rawIterations),
    openAiServiceTier: standard ? "standard" as const : "fast" as const,
    mode,
    ...(values.get("--kicad-cli") === undefined ? {} : { kicadCliPath: absolute(values.get("--kicad-cli")!, cwd) }),
  };
  if (workflowKind === "copied_project") return {
    ...common, workflowKind, prompt: nonBlank(prompt, "Prompt"),
    projectDir: absolute(nonBlank(projectDir, "--project-dir"), cwd),
  };
  if (workflowKind === "led_compatibility_fixture") return {
    ...common, workflowKind, prompt: nonBlank(prompt, "Prompt"),
    newProjectName: nonBlank(newProjectName, "--new-project"),
  };
  const referenceBytes = await readBoundedOrdinaryFile(
    absolute(nonBlank(bundleRefFile, "--bundle-ref-file"), cwd), 16 * 1024, "Generic compilation-bundle reference file",
  );
  let referenceInput: unknown;
  try { referenceInput = JSON.parse(referenceBytes.toString("utf8")); }
  catch (error) { throw new Error("Generic compilation-bundle reference file is not valid JSON.", { cause: error }); }
  const reference = parsePcbDesignCompilationBundleRef(referenceInput);
  const bundleBytes = await readBoundedOrdinaryFile(
    absolute(nonBlank(bundleFile, "--bundle-file"), cwd),
    PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes,
    "Generic compilation-bundle file",
  );
  const compilationBundle = verifyPcbDesignCompilationBundleRef(reference, bundleBytes, compilationBundleDependencies!);
  return {
    ...common, mode: mode as "prepare" | "resume", workflowKind,
    newProjectName: nonBlank(newProjectName, "--new-project"),
    compilationBundle,
    compilationBundleRef: reference,
  };
}

async function rejectSymbolicLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source project contains a symbolic link: ${candidate}`);
    if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") await rejectSymbolicLinks(candidate);
  }
}

async function prepareIsolatedProject(options: PcbAgentCliOptions): Promise<PreparedProject> {
  if (options.workflowKind !== "copied_project") {
    const freshProject = await prepareFreshProject(options.workflowKind === "generic"
      ? {
          outputDir: options.outputDir,
          name: options.newProjectName,
          resume: options.mode === "resume",
          workflowKind: "generic",
          compilationBundle: options.compilationBundle,
          compilationBundleRef: options.compilationBundleRef,
        }
      : {
          outputDir: options.outputDir,
          name: options.newProjectName,
          resume: options.mode === "resume",
          workflowKind: "led_compatibility_fixture",
        });
    return { sourceProjectPath: freshProject.projectPath, outputPath: freshProject.outputPath, isolatedProjectPath: freshProject.projectPath, reportPath: path.join(freshProject.outputPath, REPORT_NAME), freshProject };
  }
  return prepareCopiedKicadProject(options);
}

/** Reuse copied-project preparation without supplying a model or provider. */
export async function prepareCopiedKicadProject(options: Readonly<{
  projectDir: string;
  outputDir: string;
  mode?: "run" | "prepare" | "resume";
}>): Promise<PreparedProject> {
  const sourceProjectPath = await realpath(options.projectDir);
  if (!(await stat(sourceProjectPath)).isDirectory()) throw new Error("--project-dir must identify a directory.");
  await rejectSymbolicLinks(sourceProjectPath);

  const requestedOutput = path.resolve(options.outputDir);
  if (isPathWithin(sourceProjectPath, requestedOutput, true) || isPathWithin(requestedOutput, sourceProjectPath, true)) {
    throw new Error("--output-dir must be distinct from and not contain --project-dir.");
  }
  try {
    const outputMetadata = await lstat(requestedOutput);
    if (outputMetadata.isSymbolicLink() || !outputMetadata.isDirectory()) throw new Error("--output-dir must be an ordinary directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(requestedOutput, { recursive: true });
  }
  const outputPath = await realpath(requestedOutput);
  if (isPathWithin(sourceProjectPath, outputPath, true) || isPathWithin(outputPath, sourceProjectPath, true)) {
    throw new Error("--output-dir must be distinct from and not contain --project-dir.");
  }
  const isolatedProjectPath = path.join(outputPath, WORKING_PROJECT_NAME);
  const markerPath = path.join(outputPath, PREPARE_MARKER_NAME);
  if (options.mode === "resume") {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { sourceProjectPath?: unknown; outputPath?: unknown; isolatedProjectPath?: unknown };
    if (marker.sourceProjectPath !== sourceProjectPath || marker.outputPath !== outputPath || marker.isolatedProjectPath !== isolatedProjectPath) {
      throw new Error("Prepared-project marker does not match the requested source/output paths.");
    }
    if (!(await stat(isolatedProjectPath)).isDirectory()) throw new Error("Prepared isolated project is missing.");
    return { sourceProjectPath, outputPath, isolatedProjectPath, reportPath: path.join(outputPath, REPORT_NAME) };
  }
  if ((await readdir(outputPath)).length !== 0) throw new Error("--output-dir must be empty before invocation.");
  await cp(sourceProjectPath, isolatedProjectPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (candidate) => ![".git", "node_modules"].includes(path.basename(candidate)),
  });
  await writeFile(markerPath, `${JSON.stringify({ sourceProjectPath, outputPath, isolatedProjectPath }, null, 2)}\n`, "utf8");
  return { sourceProjectPath, outputPath, isolatedProjectPath, reportPath: path.join(outputPath, REPORT_NAME) };
}

function createProvider(options: PcbAgentCliOptions, environment: NodeJS.ProcessEnv, fetch: ProviderFetch | undefined): HarnessProvider {
  const extendedFresh = options.workflowKind !== "copied_project" && options.iterations > PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS;
  const cliLimits = extendedFresh ? { maxOutputBytes: MAXIMUM_CLI_PROVIDER_OUTPUT_BYTES } : {};
  if (options.provider === "codex") return createCodexCliHarnessProvider({ model: options.model, environment, ...cliLimits });
  if (options.provider === "claude-cli") return createClaudeCliHarnessProvider({ model: options.model, environment, ...cliLimits });
  return options.provider === "openai"
    ? createOpenAIHarnessProvider({
      model: options.model,
      serviceTier: options.openAiServiceTier,
      ...(environment.OPENAI_API_KEY === undefined ? {} : { apiKey: environment.OPENAI_API_KEY }),
      ...(fetch === undefined ? {} : { fetch }),
    })
    : createAnthropicHarnessProvider({
      model: options.model,
      ...(environment.ANTHROPIC_API_KEY === undefined ? {} : { apiKey: environment.ANTHROPIC_API_KEY }),
      ...(fetch === undefined ? {} : { fetch }),
    });
}

async function writeReport(reportPath: string, report: PcbAgentCliReport): Promise<void> {
  const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, reportPath);
}

const detachedObserverValue = <Value>(value: Value): Value => {
  const copy = structuredClone(value);
  const visit = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item as Record<string, unknown>)) visit(child);
    Object.freeze(item);
  };
  visit(copy);
  return copy;
};

async function writeAndObserveReport(
  reportPath: string,
  report: PcbAgentCliReport,
  observer: PcbAgentCliObserver | undefined,
  freshProject?: FreshProject,
  expectedFreshSources?: PcbHarnessValidationSourceSnapshot,
  expectedPreparedSourceAuthority?: FreshProjectOpenPreparedSourceAuthority,
  assertFinalEvidenceCurrent?: () => Promise<void>,
): Promise<void> {
  if (freshProject !== undefined && expectedFreshSources !== undefined && canonicalJson((await captureFreshSources(freshProject)).snapshot) !== canonicalJson(expectedFreshSources)) throw new Error("Fresh project sources changed before terminal report publication.");
  await assertFinalEvidenceCurrent?.();
  await writeReport(reportPath, report);
  await assertFinalEvidenceCurrent?.();
  if (freshProject !== undefined && expectedFreshSources !== undefined) {
    const current = await captureFreshSources(freshProject);
    if (canonicalJson(current.snapshot) !== canonicalJson(expectedFreshSources)) {
      throw new Error("Fresh project sources changed after terminal acceptance and before checkpoint publication.");
    }
  }
  const assertPreparedSourceAuthorityCurrent = async (): Promise<void> => {
    if (freshProject === undefined || expectedPreparedSourceAuthority === undefined) return;
    const current = await captureFreshProjectOpenPreparedSourceAuthority(freshProject);
    if (canonicalJson(current) !== canonicalJson(expectedPreparedSourceAuthority)) {
      throw new Error("Fresh project sources changed after prepared-source authority capture.");
    }
  };
  await assertPreparedSourceAuthorityCurrent();
  const unsafeFreshTerminal = isUnsafeFreshConnectivityTerminal(report);
  if (freshProject !== undefined) {
    if (unsafeFreshTerminal) await freshProject.recordUnsafeTerminal(reportPath, report.summary);
    else await freshProject.checkpointAfterReport(reportPath, report.status);
  }
  await assertPreparedSourceAuthorityCurrent();
  try {
    await observer?.(detachedObserverValue({ type: "report", report }));
  } catch {
    // An optional UI observer must not change an established CLI outcome.
  }
}

async function closeOwnedSession(session: SessionLike | undefined): Promise<void> {
  if (session?.close === undefined) return;
  // The manifest-bound session owns the exact process tree and its runtime
  // cleanup.  Await its typed outcome fully: no timeout race, swallowed
  // rejection, terminate seam, or stale numeric PID fallback is permitted.
  await session.close();
}

async function findProjectInput(projectRoot: string, extension: ".kicad_sch" | ".kicad_pcb"): Promise<string> {
  const pending = [projectRoot];
  const matches: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      // KiCad/MCP snapshots and tool output are never design inputs. This also
      // excludes hidden work directories before their contents are considered.
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") pending.push(candidate);
      else if (entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(extension)) matches.push(candidate);
    }
  }
  if (matches.length !== 1) throw new Error(`KiCad CLI fallback requires exactly one ${extension} file in the isolated project.`);
  return matches[0]!;
}

async function findOptionalProjectInput(projectRoot: string, extension: ".kicad_sch" | ".kicad_pcb"): Promise<string | undefined> {
  try { return await findProjectInput(projectRoot, extension); } catch (error) {
    if ((error as Error).message.includes("exactly one")) return undefined;
    throw error;
  }
}

export async function initializeIsolatedKicadProject(
  session: SessionLike,
  prepared: PreparedProject,
  outputDirectory: string,
): Promise<void> {
  const advertised = new Set(session.listTools().map((tool) => tool.name));
  if (prepared.freshProject === undefined) {
    if (!advertised.has("kicad_set_project")) throw new Error("KiCad sidecar did not advertise required host initialization tool kicad_set_project.");
  } else {
    const required = prepared.freshProject.workflowKind === "plane" ? KICAD_PLANE_FRESH_SIDECAR_REQUIRED_TOOL_NAMES
      : prepared.freshProject.workflowKind === "generic" ? KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES
      : KICAD_FRESH_SIDECAR_REQUIRED_TOOL_NAMES;
    // The bound session authenticates these private native verbs during actual
    // discovery; they are deliberately absent from the public tool catalog.
    const missing = required.filter((name) => name !== "evleda_get_live_pcb_document"
      && name !== "evleda_get_live_pcb_pad_snapshot" && !advertised.has(name));
    if (missing.length > 0) throw new Error(`KiCad sidecar did not advertise required fresh tools: ${missing.join(", ")}.`);
    if (typeof session.assertActivePcb !== "function" || typeof session.readActivePcbSource !== "function") {
      throw new Error("Fresh initialization requires private active-PCB identity and raw-source ports.");
    }
    if ((prepared.freshProject.workflowKind === "generic" || prepared.freshProject.workflowKind === "plane") && typeof session.readLivePcbPadSnapshot !== "function") {
      throw new Error("Generic fresh initialization requires the private native PCB pad-snapshot port.");
    }
  }
  await mkdir(outputDirectory, { recursive: true });
  const [pcbFile, schFile] = prepared.freshProject === undefined
    ? await Promise.all([
      findOptionalProjectInput(prepared.isolatedProjectPath, ".kicad_pcb"),
      findOptionalProjectInput(prepared.isolatedProjectPath, ".kicad_sch"),
    ])
    : [prepared.freshProject.pcbPath, prepared.freshProject.schematicPath] as const;
  const argumentsValue = {
    project_dir: prepared.isolatedProjectPath,
    output_dir: outputDirectory,
    ...(pcbFile === undefined ? {} : { pcb_file: pcbFile }),
    ...(schFile === undefined ? {} : { sch_file: schFile }),
  };
  const result = await session.callTool("kicad_set_project", argumentsValue);
  if (result.isError === true) throw new Error("KiCad sidecar rejected isolated project initialization.");
}

export async function nativeProjectFingerprint(projectRoot: string): Promise<string> {
  const pending = [projectRoot];
  const entries: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && /\.kicad_(?:pro|sch|pcb|dru|wks|sym|mod|jobset|dbl)$/iu.test(entry.name)) entries.push(candidate);
    }
  }
  entries.sort((left, right) => left.localeCompare(right, "en-US"));
  const hash = createHash("sha256");
  for (const filePath of entries) {
    hash.update(path.relative(projectRoot, filePath));
    hash.update(await readFile(filePath));
  }
  return hash.digest("hex");
}

/** Retains counts and a small location/rule sample without forwarding native reports. */
export function compactNativeValidationEvidence(report: Readonly<Record<string, unknown>>, limit = 12): readonly string[] {
  const summaries: string[] = [];
  const visit = (value: unknown): void => {
    if (summaries.length >= limit || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const record = value as Record<string, unknown>;
    const message = [record.rule, record.code, record.message, record.description, record.location]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(" | ");
    if (message) summaries.push(message.replace(/\s+/gu, " ").slice(0, 240));
    for (const child of Object.values(record)) visit(child);
  };
  visit(report);
  return summaries;
}

function resolveKicadCliExecutable(environment: NodeJS.ProcessEnv, explicitPath: string | undefined): string | undefined {
  if (explicitPath !== undefined && !existsSync(explicitPath)) {
    throw new Error(`--kicad-cli does not identify an existing executable: ${explicitPath}`);
  }
  const candidates = [
    explicitPath,
    environment.EVLEDA_KICAD_CLI?.trim(),
    "D:\\Codex-Recovery\\KiCad\\10.0\\bin\\kicad-cli.exe",
    "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
    ...(environment.PATH ?? "").split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, "kicad-cli.exe")),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

function createLazyKicadCliFallback(
  prepared: PreparedProject,
  environment: NodeJS.ProcessEnv,
  explicitPath: string | undefined,
  createAdapter: typeof KicadCliAdapter.create,
): HarnessInternalToolPort | undefined {
  const executablePath = resolveKicadCliExecutable(environment, explicitPath);
  if (!executablePath) return undefined;
  let schematic: Promise<string> | undefined;
  let board: Promise<string> | undefined;
  let invocation = 0;
  const getAdapter = async (): Promise<KicadCliAdapter> => await createAdapter({
    workspaceRoot: prepared.outputPath,
    projectRoot: prepared.isolatedProjectPath,
    executablePath,
  });
  const inputs = async (): Promise<{ schematicPath: string; pcbPath: string }> => prepared.freshProject === undefined
    ? {
      schematicPath: await (schematic ??= findProjectInput(prepared.isolatedProjectPath, ".kicad_sch")),
      pcbPath: await (board ??= findProjectInput(prepared.isolatedProjectPath, ".kicad_pcb")),
    }
    : { schematicPath: prepared.freshProject.schematicPath, pcbPath: prepared.freshProject.pcbPath };
  const json = (call: HarnessToolCall, value: unknown) => ({ toolCallId: call.id, content: JSON.stringify(value) });
  return {
    async saveAfterMutation(call) {
      return json(call, { status: "not-applicable" });
    },
    async execute(call) {
      const design = await inputs();
      if (call.name === "run_erc" || call.name === "run_drc") {
        const checks = await (await getAdapter()).runChecks({
          ...design,
          outputDirectory: path.join(prepared.outputPath, `.evleda-cli-fallback-checks-${++invocation}`),
        });
        const check = checks[call.name === "run_erc" ? "erc" : "drc"];
        return json(call, {
          status: check.status,
          findings: check.violationCount === 0 ? [] : [{ severity: "error", message: `${check.kind.toUpperCase()} found ${check.violationCount} violation(s).` }],
          result: {
            executable: { path: checks.executable.path, version: checks.executable.version, commit: checks.executable.commit },
            reportPath: check.reportPath,
            violationCount: check.violationCount,
            schematicParityCount: check.schematicParityCount,
            findingSummary: compactNativeValidationEvidence(check.report),
          },
        });
      }
      if (call.name === "pcb_get_board_summary") {
        const inspection = await (await getAdapter()).inspectNativeDesign({
          ...design,
          outputDirectory: path.join(prepared.outputPath, `.evleda-cli-fallback-inspection-${++invocation}`),
        });
        return json(call, {
          status: "clean",
          result: {
            executable: { path: inspection.executable.path, version: inspection.executable.version, commit: inspection.executable.commit },
            outputDirectory: inspection.outputDirectory,
            artifacts: [inspection.schematicNetlist, inspection.boardStatistics, inspection.boardNetlist]
              .map((artifact) => ({ path: artifact.path, relativePath: artifact.relativePath, sizeBytes: artifact.sizeBytes })),
          },
        });
      }
      if (call.name === "pcb_visual_qa") {
        return { toolCallId: call.id, isError: true, content: JSON.stringify({ code: "visual_unavailable", message: "KiCad CLI fallback cannot establish visual QA without the MCP visual capability." }) };
      }
      return { toolCallId: call.id, isError: true, content: `No deterministic KiCad CLI fallback exists for ${call.name}.` };
    },
  };
}

/** Runs the real composition root while allowing fully offline provider/session fakes in tests. */
/** Host-only source-bound native collectors; the supplied adapter factory owns executable pinning. */
export function createFreshNativeCaptures(input: Readonly<{
  project: FreshProject;
  executablePath: string;
  createAdapter: typeof KicadCliAdapter.create;
}>) {
  const { project, executablePath, createAdapter } = input;
  if (!isVerifiedFreshProject(project) || !path.isAbsolute(executablePath) || typeof createAdapter !== "function") {
    throw new Error("Native captures require a verified fresh project and host-owned pinned adapter factory.");
  }
  let captureNativeSchematicRender: (() => Promise<KicadSchematicSvgResult>) | undefined;
  let captureNativeSchematicStrokeStyle: ((expected: ContentIdentity) => Promise<FreshSchematicStrokeStyleEvidence>) | undefined;
  let captureNativeNetlist: (() => Promise<string>) | undefined;
  if (project.workflowKind === "generic" || project.workflowKind === "plane") {
    let configuration: Readonly<{ configHome: string; cacheHome: string; expectedTreeIdentity: CanonicalIdentity }> | undefined;
    let reusableAdapter: { sourceKey: string; adapter: KicadCliAdapter } | undefined;
    let cachedRender: { sourceKey: string; result: KicadSchematicSvgStrokeStyleResult } | undefined;
    const captureStyleRender = async (): Promise<KicadSchematicSvgStrokeStyleResult> => {
      const before = await captureFreshSources(project);
      const sourceKey = canonicalJson(before.snapshot);
      if (cachedRender?.sourceKey === sourceKey) {
        if (configuration === undefined || reusableAdapter === undefined) throw new Error("Cached schematic style lacks its owned configuration authority.");
        const currentConfiguration = await reusableAdapter.adapter.captureSchematicConfiguration(configuration.configHome);
        if (canonicalJson(currentConfiguration.identity) !== canonicalJson(configuration.expectedTreeIdentity)) throw new Error("Owned schematic configuration changed before cached style reuse.");
        const svg = await readBoundedOrdinaryFile(cachedRender.result.schematicSvg.path, 8 * 1024 * 1024, "Cached source-bound schematic SVG");
        if (contentIdentity(svg).digest !== cachedRender.result.schematicSvg.sha256 || svg.length !== cachedRender.result.schematicSvg.sizeBytes) throw new Error("Cached native schematic SVG changed before reuse.");
        assertFreshSchematicStrokeStyleEvidence(cachedRender.result.strokeStyleEvidence, before.snapshot.schematic);
        return cachedRender.result;
      }
      if (reusableAdapter?.sourceKey !== sourceKey) reusableAdapter = { sourceKey,
        adapter: await createAdapter({ workspaceRoot: project.outputPath, projectRoot: project.projectPath, executablePath }) };
      const adapter = reusableAdapter.adapter;
      if (configuration === undefined) {
        const seed = await prepareOwnedNativeSchematicStyleSeed(project.outputPath, project.projectPath, adapter.identity);
        const snapshot = await adapter.captureSchematicConfiguration(seed.configHome);
        configuration = Object.freeze({ configHome: seed.configHome, cacheHome: seed.cacheHome, expectedTreeIdentity: snapshot.identity });
      }
      const render = await adapter.exportSchematicSvgWithStrokeStyle({ schematicPath: project.schematicPath, pcbPath: project.pcbPath,
        outputDirectory: path.join(project.outputPath, "schematic-render-clearance", randomUUID()), configuration });
      const after = await captureFreshSources(project);
      if (canonicalJson(after.snapshot) !== sourceKey || before.snapshot.projectSettings === undefined
          || canonicalJson(render.sourceIdentities) !== canonicalJson({ schematic: before.snapshot.schematic, pcb: before.snapshot.pcb, projectSettings: before.snapshot.projectSettings })) {
        throw new Error("Native schematic style capture does not preserve the exact current design-source triple.");
      }
      assertFreshSchematicStrokeStyleEvidence(render.strokeStyleEvidence, before.snapshot.schematic);
      cachedRender = { sourceKey, result: render };
      return render;
    };
    captureNativeSchematicRender = captureStyleRender;
    captureNativeSchematicStrokeStyle = async (expectedSchematicIdentity) => {
      const before = await captureFreshSources(project);
      if (canonicalJson(before.snapshot.schematic) !== canonicalJson(expectedSchematicIdentity)) throw new Error("Schematic changed before source-bound native style collection.");
      const render = await captureStyleRender();
      assertFreshSchematicStrokeStyleEvidence(render.strokeStyleEvidence, expectedSchematicIdentity);
      return render.strokeStyleEvidence;
    };
  } else {
    captureNativeSchematicRender = async () => {
      const adapter = await createAdapter({ workspaceRoot: project.outputPath, projectRoot: project.projectPath, executablePath });
      return await adapter.exportSchematicSvg({ schematicPath: project.schematicPath, pcbPath: project.pcbPath,
        outputDirectory: path.join(project.outputPath, "schematic-render-clearance", randomUUID()) });
    };
  }
  captureNativeNetlist = async () => {
    const outputDirectory = freshConnectivityParityOutputDirectory(project.outputPath);
    try {
      // Construct per collection attempt. The adapter's preservation
      // baseline must be the exact post-authoring source revision.
      const adapter = await createAdapter({
        workspaceRoot: project.outputPath,
        projectRoot: project.projectPath,
        executablePath,
      });
      return (await adapter.exportSchematicNetlist({
        schematicPath: project.schematicPath,
        pcbPath: project.pcbPath,
        outputDirectory,
      })).source;
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  };
  return Object.freeze({
    captureNativeSchematicRender: captureNativeSchematicRender!,
    captureNativeSchematicStrokeStyle,
    captureNativeNetlist: captureNativeNetlist!,
  });
}

export async function runPcbAgentCli(options: PcbAgentCliOptions, dependencies: PcbAgentCliDependencies = {}): Promise<PcbAgentCliExecution> {
  assertCliWorkflowShape(options);
  if (dependencies.expectedFreshNetClassPreparationEvidence !== undefined
      && (options.workflowKind !== "generic" || options.mode !== "resume")) {
    throw new Error("Expected net-class preparation evidence is accepted only by generic resume.");
  }
  if (dependencies.expectedFreshProjectOpenPreparedSourceAuthority !== undefined
      && (options.workflowKind !== "generic" || options.mode !== "resume")) {
    throw new Error("Expected prepared-source authority is accepted only by generic resume.");
  }
  const sessionAuthorityIdentity = dependencies.sessionAuthorityIdentity;
  const injectedKicadCliAdapterFactory = dependencies.createKicadCliAdapter;
  if (injectedKicadCliAdapterFactory !== undefined && typeof injectedKicadCliAdapterFactory !== "function") {
    throw new Error("Host-owned KiCad CLI adapter factory must be callable.");
  }
  if (sessionAuthorityIdentity !== undefined && injectedKicadCliAdapterFactory === undefined) {
    throw new Error("Production session authority requires a host-owned pinned KiCad CLI adapter factory before project, session, or provider work.");
  }
  const createKicadCliAdapter: typeof KicadCliAdapter.create = injectedKicadCliAdapterFactory
    ?? (async (adapterOptions) => await KicadCliAdapter.create(adapterOptions));
  const environment = dependencies.environment ?? process.env;
  const genericBundle = options.workflowKind === "generic"
    ? bindGenericCliBundle(options, dependencies.compilationBundleDependencies)
    : undefined;
  const prepared = await prepareIsolatedProject(options);
  const acceptanceEvaluator = dependencies.freshAcceptanceEvaluator ?? evaluateLedIndicatorAcceptance;
  let captureNativeNetlist: (() => Promise<string>) | undefined;
  let captureNativeSchematicRender: (() => Promise<KicadSchematicSvgResult>) | undefined;
  let captureNativeSchematicStrokeStyle: ((schematicIdentity: ContentIdentity) => Promise<FreshSchematicStrokeStyleEvidence>) | undefined;
  let freshSchematicRenderClearanceEvidence: SchematicRenderClearanceEvidence | undefined;
  let freshSchematicRenderExpected: SchematicRenderClearanceExpected | undefined;
  let lastSchematicRenderCapture: KicadSchematicSvgResult | undefined;
  let freshNetClassMaterialization: FreshNetClassMaterialization | undefined;
  let freshNetClassSemanticAuthority: FreshNetClassSemanticAuthority | undefined;
  let freshNetClassPreparationEvidence: FreshNetClassPreparationEvidence | undefined;
  let freshProjectOpenPreparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority | undefined;
  let freshClearanceEvidenceReceipt: FreshClearanceEvidenceReceipt | undefined;
  let freshClearanceEvidenceProblem = "";
  let lastGenericEvidenceSources: PcbHarnessValidationSourceSnapshot | undefined;
  // Private host observations never enter the serialized CLI report or provider feedback.
  let captureNativePads: (() => Promise<Readonly<{ observation: KicadNativePadObservation; expected: KicadNativePadObservationExpected }> | undefined>) | undefined;
  let freshNativePads: KicadNativePadObservation | undefined;
  let freshNativePadExpected: KicadNativePadObservationExpected | undefined;
  let freshNativePadSessionIdentity: string | undefined;
  const invalidateNativePads = (): void => {
    freshNativePads = undefined; freshNativePadExpected = undefined; freshNativePadSessionIdentity = undefined;
  };
  type FreshNativeEvidence = Readonly<{
    erc?: string | HarnessToolResult | undefined;
    drc?: string | HarnessToolResult | undefined;
    visualInspection?: string | HarnessToolResult | undefined;
    sourceBinding?: PcbHarnessValidationSourceBinding | undefined;
  }>;
  const finalizeFreshAcceptance = async (
    internal?: HarnessInternalToolPort,
    native: FreshNativeEvidence = {},
  ): Promise<FreshAcceptanceResult | FreshDesignAcceptanceResult | undefined> => {
    if (prepared.freshProject === undefined) return undefined;
    const sourceRead = await Promise.allSettled([captureFreshSources(prepared.freshProject)]);
    if (genericBundle !== undefined && sourceRead[0]?.status === "rejected") throw sourceRead[0].reason;
    const sources = sourceRead[0]?.status === "fulfilled" ? sourceRead[0].value : {
      schematicSource: "", pcbSource: "",
      snapshot: { schematic: contentIdentity(""), pcb: contentIdentity("") },
    };
    if (genericBundle === undefined) {
      const connectivityRead = await Promise.allSettled([
        internal === undefined
          ? Promise.resolve("")
          : internal.execute({ id: "fresh-terminal-connectivity", name: "sch_get_connectivity_graph", arguments: {} }),
      ]);
      return acceptanceEvaluator({
        schematicSource: sources.schematicSource,
        pcbSource: sources.pcbSource,
        schematicPath: prepared.freshProject.schematicPath,
        pcbPath: prepared.freshProject.pcbPath,
        connectivity: connectivityRead[0]?.status === "fulfilled" ? connectivityRead[0].value : "",
        erc: native.erc ?? "",
        drc: native.drc ?? "",
        visualInspection: native.visualInspection ?? "",
      });
    }

    // A later terminal recheck may observe drift. Never retain a receipt from
    // an earlier source revision merely because that earlier gate ran first.
    freshClearanceEvidenceReceipt = undefined;
    invalidateNativePads();
    freshSchematicRenderClearanceEvidence = undefined; freshSchematicRenderExpected = undefined; lastSchematicRenderCapture = undefined;
    lastGenericEvidenceSources = undefined;
    const binding = native.sourceBinding;
    const acceptanceSources = sources;
    let sourceBound = false;
    if (binding?.unchanged === true && binding.schemaVersion === PCB_HARNESS_VALIDATION_SOURCE_BINDING_SCHEMA_VERSION) {
      const { identity, ...payload } = binding;
      sourceBound = canonicalJson(identity) === canonicalJson(canonicalIdentity(payload, PCB_HARNESS_VALIDATION_SOURCE_BINDING_SCHEMA_VERSION))
        && canonicalJson(binding.before) === canonicalJson(binding.after)
        && canonicalJson(binding.after) === canonicalJson(sources.snapshot);
    }
    if ((binding !== undefined || native.erc !== undefined || native.drc !== undefined || native.visualInspection !== undefined) && !sourceBound) throw new Error("Current native-validation source authority is missing, invalid, or changed before acceptance collection.");
    let netlistSource = "";
    let clearance: FreshDesignClearanceEvidence | undefined;
    if (sourceBound) {
      try {
        const receipt = await dependencies.freshDesignClearanceEvidencePort!.read({ bundle: genericBundle, project: prepared.freshProject });
        freshClearanceEvidenceReceipt = await verifyFreshClearanceEvidenceReceipt(receipt, {
          project: prepared.freshProject, compilationBundle: genericBundle, kicad: dependencies.freshDesignClearanceEvidencePort!.kicad,
        });
        clearance = freshClearanceEvidenceReceipt.acceptanceEvidence;
        freshClearanceEvidenceProblem = "";
      } catch (error) {
        freshClearanceEvidenceProblem = "Fresh clearance receipt verification returned terminal failure evidence.";
        throw error;
      }
      netlistSource = await (dependencies.freshDesignNetlistCollector !== undefined
        ? dependencies.freshDesignNetlistCollector({ bundle: genericBundle, project: prepared.freshProject, schematicSource: sources.schematicSource, pcbSource: sources.pcbSource })
        : captureNativeNetlist?.() ?? Promise.resolve(""));
      if (sources.snapshot.projectSettings === undefined || binding === undefined) throw new Error("Current native SVG collection lacks its project-settings or validation-source authority.");
      // Rejected collector operations are terminal, including preservation, cancellation and timeout faults.
      const render = await (dependencies.freshSchematicRenderCollector !== undefined
        ? dependencies.freshSchematicRenderCollector({ bundle: genericBundle, project: prepared.freshProject, validationSourceBinding: binding })
        : captureNativeSchematicRender?.() ?? Promise.reject(new Error("Pinned native SVG exporter is unavailable.")));
      const expected: SchematicRenderClearanceExpected = { sources: { schematic: sources.snapshot.schematic, pcb: sources.snapshot.pcb, projectSettings: sources.snapshot.projectSettings },
        executable: dependencies.freshDesignClearanceEvidencePort!.kicad, validationSourceBindingIdentity: binding.identity };
      if (!isPathWithin(prepared.outputPath, render.schematicSvg.path)) throw new Error("Native SVG artifact escaped its private output root.");
      const renderReceipt = createSchematicRenderClearanceEvidence(render, expected);
      if (renderReceipt.bindingProblems.length !== 0) throw new Error(`Native SVG collection returned invalid source/tool/artifact authority: ${renderReceipt.bindingProblems.join(", ")}.`);
      verifyHostSchematicRenderClearanceEvidence(renderReceipt, expected);
      freshSchematicRenderClearanceEvidence = renderReceipt;
      freshSchematicRenderExpected = expected; lastSchematicRenderCapture = render;
      if (canonicalJson((await captureFreshSources(prepared.freshProject)).snapshot) !== canonicalJson(sources.snapshot)) {
        freshClearanceEvidenceProblem = "Fresh sources changed after collection; the receipt and acceptance projection were discarded and the candidate terminated.";
        throw new Error(freshClearanceEvidenceProblem);
      }
      if (session === undefined || captureNativePads === undefined) throw new Error("Current generic acceptance requires the private native physical-pad capability before session closure.");
      const padSessionIdentity = canonicalJson(session.identity ?? null);
      // The harness host hook calls collectKicadNativePadObservation on this exact
      // session, deriving all ordered named-net physical UUIDs from saved source.
      const pads = await captureNativePads();
      if (pads === undefined || pads.expected.pcbPath !== prepared.freshProject.pcbPath || pads.expected.pcbSource !== sources.pcbSource) {
        throw new Error("Current generic acceptance lacks exact saved-source native physical-pad evidence.");
      }
      verifyHostKicadNativePadObservation(pads.observation, pads.expected);
      if (canonicalJson(session.identity ?? null) !== padSessionIdentity) throw new Error("Native physical-pad session/tool identity changed during collection.");
      freshNativePads = pads.observation; freshNativePadExpected = pads.expected; freshNativePadSessionIdentity = padSessionIdentity;
      const afterCollection = await captureFreshSources(prepared.freshProject);
      if (canonicalJson(afterCollection.snapshot) !== canonicalJson(sources.snapshot)) {
        invalidateNativePads();
        freshClearanceEvidenceReceipt = undefined;
        freshSchematicRenderClearanceEvidence = undefined; freshSchematicRenderExpected = undefined; lastSchematicRenderCapture = undefined;
        freshClearanceEvidenceProblem = "Fresh sources changed after collection; the receipt and acceptance projection were discarded and the candidate terminated.";
        throw new Error(freshClearanceEvidenceProblem);
      }
    }
    const selection = genericBundle.compilerProfile.deepRuleSelectionOptions;
    lastGenericEvidenceSources = sourceBound ? sources.snapshot : undefined;
    return evaluateFreshDesignAcceptance({
      schematicSource: acceptanceSources.schematicSource,
      netlistSource: sourceBound ? netlistSource : "",
      pcbSource: acceptanceSources.pcbSource,
      // Runtime absence is intentional: the evaluator's strict root check
      // returns unknown and completion remains needs_review.
      clearance: clearance as FreshDesignClearanceEvidence,
      erc: { origin: "host", result: sourceBound ? native.erc ?? "" : "" },
      drc: { origin: "host", result: sourceBound ? native.drc ?? "" : "" },
      visualInspection: { origin: "host", result: sourceBound ? native.visualInspection ?? "" : "" },
      ...(freshSchematicRenderClearanceEvidence === undefined ? {} : { schematicRenderClearance: freshSchematicRenderClearanceEvidence }),
      ...(freshNativePads === undefined ? {} : { nativePads: freshNativePads }),
    }, {
      contract: genericBundle.contract,
      libraryResolver: dependencies.compilationBundleDependencies!.libraryResolver,
      libraryBinding: genericBundle.libraryBinding,
      deepRuleCatalog: dependencies.compilationBundleDependencies!.deepRuleCatalog,
      deepRuleSelectionOptions: {
        maxRules: selection.maxRules,
        maxPromptBytes: selection.maxPromptBytes,
        maxPromptTokens: selection.maxPromptTokens,
        featureCoveragePolicy: selection.featureCoveragePolicy,
      },
      deepRuleBinding: genericBundle.deepRuleBinding,
      acceptancePlan: genericBundle.acceptancePlan,
      practiceProfile: genericBundle.practiceProfileBinding.profile,
      ...(freshSchematicRenderExpected === undefined ? {} : { schematicRenderExpected: freshSchematicRenderExpected }),
      ...(freshNativePadExpected === undefined ? {} : { nativePadExpected: freshNativePadExpected }),
    });
  };
  if (genericBundle !== undefined && prepared.freshProject !== undefined) {
    const port = dependencies.freshDesignClearanceEvidencePort;
    if (port === undefined) {
      throw new Error("Generic prepare/resume requires the exact server-owned net-class evidence port before checkpoint or sidecar connection.");
    }
    const operation = { bundle: genericBundle, project: prepared.freshProject } as const;
    if (options.mode === "prepare") {
      try {
        freshNetClassMaterialization = await port.materialize(operation);
        const observedAuthority = await port.readSemanticAuthority(operation);
        freshNetClassSemanticAuthority = await verifyFreshNetClassSemanticAuthority(observedAuthority, {
          project: prepared.freshProject,
          compilationBundle: genericBundle,
          kicad: port.kicad,
        });
        freshNetClassPreparationEvidence = createFreshNetClassPreparationEvidence(
          freshNetClassMaterialization,
          freshNetClassSemanticAuthority,
        );
      } catch {
        throw new Error("Generic net-class materialization and semantic readback did not complete before checkpoint publication.");
      }
    } else {
      if (dependencies.expectedFreshNetClassPreparationEvidence === undefined) {
        throw new Error("Generic resume requires lifecycle-owned expected net-class preparation evidence.");
      }
      if (dependencies.expectedFreshProjectOpenPreparedSourceAuthority === undefined) {
        throw new Error("Generic resume requires lifecycle-owned expected prepared-source authority.");
      }
      let expectedPreparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
      try {
        expectedPreparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(
          dependencies.expectedFreshProjectOpenPreparedSourceAuthority,
        );
      } catch {
        throw new Error("Generic resume expected prepared-source authority is invalid.");
      }
      const persisted = await readPersistedFreshNetClassPreparation(prepared.reportPath);
      freshNetClassMaterialization = persisted.materialization;
      freshNetClassSemanticAuthority = persisted.semanticAuthority;
      freshNetClassPreparationEvidence = persisted.evidence;
      freshProjectOpenPreparedSourceAuthority = expectedPreparedSourceAuthority;
      let expected: FreshNetClassPreparationEvidence;
      try {
        expected = parseFreshNetClassPreparationEvidence(dependencies.expectedFreshNetClassPreparationEvidence);
      } catch {
        throw new Error("Generic resume expected net-class preparation evidence is invalid.");
      }
      if (canonicalJson(expected) !== canonicalJson(persisted.evidence)) {
        throw new Error("Generic resume preparation evidence does not match the persisted prepare report.");
      }
      if (canonicalJson(expectedPreparedSourceAuthority) !== canonicalJson(persisted.preparedSourceAuthority)) {
        throw new Error("Generic resume prepared-source authority does not match the persisted prepare report.");
      }
      await assertCurrentFreshProjectPreparedSources(prepared.freshProject, expectedPreparedSourceAuthority);
      try {
        const observedAuthority = await port.readSemanticAuthority(operation);
        const currentAuthority = await verifyFreshNetClassSemanticAuthority(observedAuthority, {
          project: prepared.freshProject,
          compilationBundle: genericBundle,
          kicad: port.kicad,
        });
        const currentEvidence = createFreshNetClassPreparationEvidence(
          persisted.materialization,
          currentAuthority,
        );
        if (canonicalJson(currentEvidence) !== canonicalJson(expected)) {
          throw new Error("semantic authority differs");
        }
        await assertCurrentFreshProjectPreparedSources(prepared.freshProject, expectedPreparedSourceAuthority);
        freshNetClassSemanticAuthority = currentAuthority;
        freshNetClassPreparationEvidence = expected;
      } catch {
        throw new Error("Generic net-class semantic authority changed after prepare; refusing sidecar and provider connection.");
      }
    }
  }
  if (options.mode === "prepare") {
    const freshAcceptance = await finalizeFreshAcceptance();
    if (genericBundle !== undefined && prepared.freshProject !== undefined) {
      try {
        freshProjectOpenPreparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(prepared.freshProject);
        if (freshNetClassMaterialization === undefined
            || canonicalJson(freshProjectOpenPreparedSourceAuthority.pro) !== canonicalJson(freshNetClassMaterialization.projectSettingsIdentity)
            || canonicalJson(freshProjectOpenPreparedSourceAuthority.pcb) !== canonicalJson(freshNetClassMaterialization.pcbIdentityAtMaterialization)
            || canonicalJson(freshProjectOpenPreparedSourceAuthority.marker) !== canonicalJson(freshNetClassMaterialization.freshMarkerContentIdentity)) {
          throw new Error("prepared source identities differ");
        }
      } catch {
        throw new Error("Generic prepared-source authority could not be captured before checkpoint publication.");
      }
    }
    const report: PcbAgentCliReport = {
      schemaVersion: PCB_AGENT_CLI_REPORT_SCHEMA_VERSION, status: "needs_review", provider: options.provider, model: options.model,
      projectPaths: { sourceProjectPath: prepared.sourceProjectPath, isolatedProjectPath: prepared.isolatedProjectPath, outputPath: prepared.outputPath, reportPath: prepared.reportPath },
      summary: IPC_PREPARE_INSTRUCTION,
      ruleProfile: ruleProfileFor(options, prepared.freshProject),
      workflow: workflowReportBinding(options),
      ...(freshAcceptance === undefined ? {} : { freshAcceptance }),
      ...(freshNetClassMaterialization === undefined ? {} : { freshNetClassMaterialization }),
      ...(freshNetClassSemanticAuthority === undefined ? {} : { freshNetClassSemanticAuthority }),
      ...(freshNetClassPreparationEvidence === undefined ? {} : { freshNetClassPreparationEvidence }),
      ...(freshProjectOpenPreparedSourceAuthority === undefined ? {} : { freshProjectOpenPreparedSourceAuthority }),
    };
    await writeAndObserveReport(
      prepared.reportPath,
      report,
      dependencies.observer,
      prepared.freshProject,
      lastGenericEvidenceSources,
      freshProjectOpenPreparedSourceAuthority,
    );
    return { report, reportPath: prepared.reportPath, isolatedProjectPath: prepared.isolatedProjectPath, exitCode: 0 };
  }
  let session: SessionLike | undefined;
  let lockSummary: unknown;
  let attemptedIpcConnection = false;
  let acceptanceInternal: HarnessInternalToolPort | undefined;
  let freshAcceptance: FreshAcceptanceResult | FreshDesignAcceptanceResult | undefined;
  try {
    if (dependencies.sessionFactory === undefined) {
      throw new Error("Production KiCad MCP execution requires a manifest-bound, run/socket-authorized session factory.");
    }
    const approvedFreshLibraryResolver = genericBundle === undefined ? undefined : dependencies.compilationBundleDependencies!.libraryResolver;
    const freshPhysicalFootprintResolver = approvedFreshLibraryResolver !== undefined
      && "inspectFootprint" in approvedFreshLibraryResolver && typeof approvedFreshLibraryResolver.inspectFootprint === "function"
      ? approvedFreshLibraryResolver as typeof approvedFreshLibraryResolver & NonNullable<KicadNativePadObservationExpected["physicalFootprintResolver"]>
      : undefined;
    if (genericBundle !== undefined && freshPhysicalFootprintResolver === undefined) {
      throw new Error("Current generic execution requires the approved physical-footprint resolver and private native physical-pad runtime capability.");
    }
    const freshPhysicalFootprintSourcePins = genericBundle === undefined ? undefined : Object.freeze(genericBundle.contract.components.map(component => {
      const inspected = freshPhysicalFootprintResolver!.inspectFootprint(component.footprintLibId);
      if (inspected === null || inspected.libraryId !== component.footprintLibId) throw new Error("Approved physical footprint source is absent or differs from the contract.");
      return Object.freeze({ reference: component.reference, libraryId: component.footprintLibId, sourceIdentity: Object.freeze({ ...inspected.sourceIdentity }) });
    }));
    const sessionOptions: KicadMcpSessionOptions = {
      workspaceRoot: prepared.outputPath,
      projectRoot: prepared.isolatedProjectPath,
      outputRoot: path.join(prepared.outputPath, ".evleda-mcp-output"),
      mode: "write",
      ...(prepared.freshProject === undefined ? { isolatedWorkingCopy: { canonicalProjectRoot: prepared.sourceProjectPath } } : { freshProject: true }),
      requiredTools: pcbAgentRequiredSessionTools(options),
    };
    attemptedIpcConnection = true;
    session = await dependencies.sessionFactory(sessionOptions);
    if (genericBundle !== undefined && typeof session.readLivePcbPadSnapshot !== "function") {
      throw new Error("Current generic execution requires the private native physical-pad runtime capability.");
    }
    if (sessionAuthorityIdentity !== undefined) {
      const launchIdentity = (session.identity as { readonly launch?: { readonly sessionAuthorityIdentity?: unknown } } | undefined)?.launch?.sessionAuthorityIdentity;
      if (canonicalJson(launchIdentity) !== canonicalJson(sessionAuthorityIdentity)) {
        throw new Error("KiCad MCP session does not match its approved mode/socket/run authority identity.");
      }
    }
    const parityExecutable = prepared.freshProject === undefined
      ? undefined
      : resolveKicadCliExecutable(environment, options.kicadCliPath);
    await initializeIsolatedKicadProject(
      session,
      prepared,
      sessionOptions.outputRoot ?? path.join(prepared.outputPath, ".evleda-mcp-output"),
    );
    const fallback = createLazyKicadCliFallback(prepared, environment, options.kicadCliPath, createKicadCliAdapter);
    if (prepared.freshProject !== undefined && parityExecutable !== undefined) {
      const captures = createFreshNativeCaptures({
        project: prepared.freshProject, executablePath: parityExecutable, createAdapter: createKicadCliAdapter,
      });
      captureNativeSchematicRender = captures.captureNativeSchematicRender;
      captureNativeSchematicStrokeStyle = captures.captureNativeSchematicStrokeStyle;
      captureNativeNetlist = captures.captureNativeNetlist;
    }
    const freshConnectivityContract = prepared.freshProject === undefined
      ? undefined
      : options.workflowKind === "generic"
        ? genericBundle!.contract
        : LED_INDICATOR_EXAMPLE;
    // Reuse only the exact stock resolver that verified this compilation bundle.
    // A legacy resolver without this capability cannot authorize source stacks
    // or the larger-schematic path; no model-supplied substitute is constructed.
    const freshSchematicGeometryResolver = approvedFreshLibraryResolver !== undefined
      && "inspectSymbolTerminalGeometry" in approvedFreshLibraryResolver
      && typeof approvedFreshLibraryResolver.inspectSymbolTerminalGeometry === "function"
      ? approvedFreshLibraryResolver as typeof approvedFreshLibraryResolver & FreshSchematicApprovedGeometryResolver
      : undefined;
    const tools = createKicadHarnessTools(session, {
      ...(fallback === undefined ? {} : { fallback }),
      capturePersistedMutationBaseline: async () => await nativeProjectFingerprint(prepared.isolatedProjectPath),
      verifyPersistedMutation: async (baseline) => baseline !== undefined && await nativeProjectFingerprint(prepared.isolatedProjectPath) !== baseline,
      ...(prepared.freshProject === undefined ? {} : {
        freshProject: prepared.freshProject,
        freshConnectivityContract: freshConnectivityContract!,
        ...(genericBundle === undefined ? {} : { freshCompilationBundle: genericBundle }),
        ...(freshPhysicalFootprintResolver === undefined ? {} : { freshPhysicalFootprintResolver, freshPhysicalFootprintSourcePins: freshPhysicalFootprintSourcePins! }),
        ...(freshSchematicGeometryResolver === undefined ? {} : { freshSchematicGeometryResolver }),
        ...(freshSchematicGeometryResolver === undefined || captureNativeSchematicStrokeStyle === undefined ? {} : { captureFreshSchematicStrokeStyle: captureNativeSchematicStrokeStyle }),
        ...(captureNativeNetlist === undefined ? {} : { captureFreshNativeNetlist: captureNativeNetlist }),
      }),
    });
    acceptanceInternal = tools.internal;
    captureNativePads = () => tools.captureFreshPcbPadEvidence();
    if (tools.tools.length === 0) {
      throw new Error("KiCad sidecar advertised no controller-allowed provider-callable PCB tools after isolated project initialization.");
    }
    const provider = createProvider(options, environment, dependencies.fetch);
    let harness = await runPcbAgentHarness({
      userPrompt: options.workflowKind === "generic" ? genericBundle!.executionPrompt.originalPrompt : options.prompt,
      fixedRules: options.workflowKind === "generic"
        ? [PCB_AGENT_PROOF_OF_CONCEPT_RULE]
        : [PCB_AGENT_PROOF_OF_CONCEPT_RULE, ...(prepared.freshProject === undefined ? [] : [FRESH_PROJECT_PROMPT_CONTEXT])],
      projectPath: prepared.isolatedProjectPath,
      reportPath: prepared.reportPath,
      editsRequired: true,
      allowedToolNames: tools.tools,
      maxIterations: options.iterations,
      ...(prepared.freshProject !== undefined && options.iterations > PCB_AGENT_RECOMMENDED_FRESH_ITERATIONS ? { maxMessages: 256 } : {}),
      ...(options.workflowKind === "generic" ? { maxPayloadBytes: 4 * 1024 * 1024 } : {}),
    }, provider, tools, {
      ...(dependencies.observer === undefined ? {} : { observer: dependencies.observer }),
      ...(prepared.freshProject === undefined
        ? { maxIterations: 5 }
        : options.workflowKind === "generic"
          ? {
            maxIterations: PCB_AGENT_MAX_FRESH_ITERATIONS,
            postSchematicReadbackTool: "sch_get_connectivity_graph",
            deferFullValidationUntilPhaseBoundary: true,
            exactProviderPrompt: {
              text: genericBundle!.executionPrompt.text,
              textContentIdentity: genericBundle!.executionPrompt.textContentIdentity,
            },
            compoundMutationContractIdentity: createFreshConnectivityContract(genericBundle!.contract).identity,
            captureValidationSource: async () => (await captureFreshSources(prepared.freshProject!)).snapshot,
            repairCompletionGateFailures: true,
            invalidateCompletionEvidence: () => { invalidateNativePads(); freshClearanceEvidenceReceipt = undefined; freshSchematicRenderClearanceEvidence = undefined; freshSchematicRenderExpected = undefined; lastSchematicRenderCapture = undefined; lastGenericEvidenceSources = undefined; },
            completionGate: async (native) => {
              const acceptance = await finalizeFreshAcceptance(tools.internal, {
                ...native,
                sourceBinding: native.sourceBinding,
              });
              if (acceptance === undefined) throw new Error("Generic fresh completion gate was invoked without a fresh project.");
              return { passed: acceptance.passed, missing: [...acceptance.missing.filter((item) => item.startsWith("schematic-render-clearance ")), ...acceptance.missing.filter((item) => !item.startsWith("schematic-render-clearance "))] };
            },
          }
        : {
          maxIterations: PCB_AGENT_MAX_FRESH_ITERATIONS, postSchematicReadbackTool: "sch_get_connectivity_graph", deferFullValidationUntilPhaseBoundary: true,
          taskContract: FRESH_LED_INDICATOR_PROVIDER_CONTRACT,
          compoundMutationContractIdentity: FRESH_LED_CONNECTIVITY_CONTRACT_IDENTITY,
          designerPrompt: {
            boardPurpose: LED_INDICATOR_EXAMPLE.purpose,
            maxChars: FRESH_LED_DESIGNER_PROMPT_MAX_CHARS,
            deepRuleSelection: FRESH_LED_DEEP_RULE_POLICY.selection.deepRuleSelection,
            exactDeepRulePrompt: FRESH_LED_DEEP_RULE_POLICY.providerPrompt,
            deepRuleMaxChars: FRESH_LED_DEEP_RULE_POLICY.selection.budget.maxPromptBytes,
            deepRuleMaxRules: FRESH_LED_DEEP_RULE_POLICY.selection.budget.maxRules,
          },
          completionGate: async (native) => {
            const acceptance = await finalizeFreshAcceptance(tools.internal, native);
            if (acceptance === undefined) throw new Error("Fresh completion gate was invoked without a fresh project.");
            return { passed: acceptance.passed, missing: acceptance.missing };
          },
        }),
    });
    if (prepared.freshProject !== undefined && !isUnsafeFreshConnectivityTerminal(harness)) {
      const latestValidationResult = (name: string): HarnessToolResult | undefined =>
        [...harness.operations].reverse().find((operation) => operation.phase === "validation" && operation.name === name)?.result;
      freshAcceptance = await finalizeFreshAcceptance(acceptanceInternal, {
        erc: latestValidationResult("run_erc"),
        drc: latestValidationResult("run_drc"),
        visualInspection: latestValidationResult("pcb_visual_qa"),
        sourceBinding: harness.validation.sourceBinding,
      });
      if (freshAcceptance !== undefined) harness = reconcileFreshTerminalHarness(harness, freshAcceptance);
    }
    const sidecarIdentity = session.identity ?? null;
    if (freshNativePads !== undefined && canonicalJson(sidecarIdentity) !== freshNativePadSessionIdentity) throw new Error("Native physical-pad session/tool authority changed before closure.");
    const writeSessionReceiptIdentity = (sidecarIdentity as { readonly sessionReceiptIdentity?: CanonicalIdentity } | null)?.sessionReceiptIdentity;
    if (sessionAuthorityIdentity !== undefined && writeSessionReceiptIdentity === undefined) {
      throw new Error("Manifest-bound KiCad MCP execution did not return a session receipt identity.");
    }
    const closingSession = session;
    session = undefined;
    await closeOwnedSession(closingSession);
    const report: PcbAgentCliReport = {
      schemaVersion: PCB_AGENT_CLI_REPORT_SCHEMA_VERSION,
      status: harness.status,
      provider: options.provider,
      model: options.model,
      projectPaths: { sourceProjectPath: prepared.sourceProjectPath, isolatedProjectPath: prepared.isolatedProjectPath, outputPath: prepared.outputPath, reportPath: prepared.reportPath },
      summary: harness.summary,
      ruleProfile: ruleProfileFor(options, prepared.freshProject),
      workflow: workflowReportBinding(options),
      harness,
      ...(freshAcceptance === undefined ? {} : { freshAcceptance }),
      ...(tools.freshBoardSaveAudits.length === 0 ? {} : { freshBoardSaveAudits: tools.freshBoardSaveAudits }),
      ...(freshNetClassMaterialization === undefined ? {} : { freshNetClassMaterialization }),
      ...(freshNetClassSemanticAuthority === undefined ? {} : { freshNetClassSemanticAuthority }),
      ...(freshNetClassPreparationEvidence === undefined ? {} : { freshNetClassPreparationEvidence }),
      ...(freshProjectOpenPreparedSourceAuthority === undefined ? {} : { freshProjectOpenPreparedSourceAuthority }),
      ...(freshClearanceEvidenceReceipt === undefined ? {} : { freshClearanceEvidenceReceipt }),
      ...(freshSchematicRenderClearanceEvidence === undefined ? {} : { freshSchematicRenderClearanceEvidence }),
      ...(freshClearanceEvidenceProblem.length === 0 ? {} : { freshClearanceEvidenceProblem }),
      sidecar: { ...(lockSummary === undefined ? {} : { lock: lockSummary }), identity: sidecarIdentity },
      ...(writeSessionReceiptIdentity === undefined ? {} : { writeSessionReceiptIdentity }),
    };
    await writeAndObserveReport(prepared.reportPath, report, dependencies.observer, prepared.freshProject, lastGenericEvidenceSources, undefined, async () => {
      if (freshNativePads !== undefined) {
        if (freshNativePadExpected === undefined) throw new Error("Terminal native physical-pad evidence lost its expected authority.");
        verifyHostKicadNativePadObservation(freshNativePads, freshNativePadExpected);
        if (canonicalJson(closingSession.identity ?? null) !== freshNativePadSessionIdentity) throw new Error("Native physical-pad session/tool authority changed during closure.");
      }
      if (genericBundle === undefined || freshSchematicRenderClearanceEvidence === undefined) return;
      if (freshSchematicRenderExpected === undefined || lastSchematicRenderCapture === undefined) throw new Error("Terminal schematic render receipt lost its source authority.");
      verifyHostSchematicRenderClearanceEvidence(freshSchematicRenderClearanceEvidence, freshSchematicRenderExpected);
      const svg = await readBoundedOrdinaryFile(lastSchematicRenderCapture.schematicSvg.path, 2 * 1024 * 1024, "Terminal native schematic SVG");
      if (canonicalJson(contentIdentity(svg)) !== canonicalJson(freshSchematicRenderClearanceEvidence.nativeSvgIdentity)) throw new Error("Native schematic SVG changed before terminal report publication.");
    });
    return { report, reportPath: prepared.reportPath, isolatedProjectPath: prepared.isolatedProjectPath, exitCode: PCB_AGENT_EXIT_CODES[report.status] };
  } catch (error) {
    let terminalError = error;
    let teardownError: unknown = error instanceof KicadMcpTerminationUncertainError ? error : undefined;
    freshAcceptance = undefined; freshClearanceEvidenceReceipt = undefined;
    invalidateNativePads();
    freshSchematicRenderClearanceEvidence = undefined; freshSchematicRenderExpected = undefined; lastSchematicRenderCapture = undefined; lastGenericEvidenceSources = undefined;
    if (prepared.freshProject !== undefined && !isUnsafeFreshConnectivityTerminal(error)) {
      try { freshAcceptance = await finalizeFreshAcceptance(acceptanceInternal); }
      catch { /* Best-effort failure evidence must not replace the primary fault or skip owned-session cleanup. */ }
    }
    const closingSession = session;
    session = undefined;
    try { await closeOwnedSession(closingSession); }
    catch (closeError) { terminalError = closeError; teardownError = closeError; }
    const report: PcbAgentCliReport = {
      schemaVersion: PCB_AGENT_CLI_REPORT_SCHEMA_VERSION,
      status: "failed",
      provider: options.provider,
      model: options.model,
      projectPaths: { sourceProjectPath: prepared.sourceProjectPath, isolatedProjectPath: prepared.isolatedProjectPath, outputPath: prepared.outputPath, reportPath: prepared.reportPath },
      summary: `${terminalError instanceof Error ? terminalError.message : String(terminalError)}${attemptedIpcConnection && !isCapabilityAllowlistMismatch(terminalError) ? ` ${KICAD_IPC_REQUIREMENT}` : ""}`,
      ruleProfile: ruleProfileFor(options, prepared.freshProject),
      workflow: workflowReportBinding(options),
      ...(freshAcceptance === undefined ? {} : { freshAcceptance }),
      ...(freshNetClassMaterialization === undefined ? {} : { freshNetClassMaterialization }),
      ...(freshNetClassSemanticAuthority === undefined ? {} : { freshNetClassSemanticAuthority }),
      ...(freshNetClassPreparationEvidence === undefined ? {} : { freshNetClassPreparationEvidence }),
      ...(freshProjectOpenPreparedSourceAuthority === undefined ? {} : { freshProjectOpenPreparedSourceAuthority }),
      ...(freshClearanceEvidenceReceipt === undefined ? {} : { freshClearanceEvidenceReceipt }),
      ...(freshSchematicRenderClearanceEvidence === undefined ? {} : { freshSchematicRenderClearanceEvidence }),
      ...(freshClearanceEvidenceProblem.length === 0 ? {} : { freshClearanceEvidenceProblem }),
      ...(lockSummary === undefined ? {} : { sidecar: { lock: lockSummary } }),
    };
    await writeAndObserveReport(prepared.reportPath, report, dependencies.observer, prepared.freshProject);
    if (teardownError !== undefined) throw teardownError;
    return { report, reportPath: prepared.reportPath, isolatedProjectPath: prepared.isolatedProjectPath, exitCode: PCB_AGENT_EXIT_CODES.failed };
  }
}

export async function main(argv = process.argv.slice(2), dependencies: PcbAgentCliDependencies = {}): Promise<number> {
  let parsed: PcbAgentCliOptions | PcbAgentCheckpointOpenOptions | { readonly help: true };
  try {
    parsed = await parsePcbAgentCliArgs(argv, dependencies.cwd, dependencies.compilationBundleDependencies);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${pcbAgentUsage}\n`);
    return 1;
  }
  if ("help" in parsed) {
    process.stdout.write(`${pcbAgentUsage}\n`);
    return 0;
  }
  if (parsed.mode === "checkpoint-open") {
    try {
      const checkpoint = await runPcbAgentCheckpointOpen(parsed);
      process.stdout.write(`Fresh checkpoint-open: ${checkpoint.changed ? "accepted KiCad open/save normalization" : "already current"}\nCheckpoint: ${checkpoint.checkpointPath}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  try {
    const execution = await runPcbAgentCli(parsed, dependencies);
    if (parsed.mode === "prepare") process.stdout.write(`${execution.report.summary}\n`);
    process.stdout.write(`PCB agent status: ${execution.report.status}\nIsolated project: ${execution.isolatedProjectPath}\nJSON report: ${execution.reportPath}\n`);
    return execution.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => { process.exitCode = code; });
}

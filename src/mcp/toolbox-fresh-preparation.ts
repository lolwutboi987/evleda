import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes, validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { FluxKicadCliBinding } from "../flux/kicad-toolchain-binding.js";
import { compilePcbDesignIntentDraft, type PcbDesignCompilation, type PcbDesignCompilerOptions } from "../harness/pcb-design-compiler.js";
import {
  createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef, serializePcbDesignCompilationBundle,
  parsePcbDesignCompilationBundle, parsePcbDesignCompilationBundleRef, PCB_DESIGN_COMPILATION_BUNDLE_LIMITS,
  type PcbDesignCompilationBundle, type PcbDesignCompilationBundleRef, type PcbDesignCompilationBundleDependencies,
} from "../harness/pcb-design-compilation-bundle.js";
import {
  prepareFreshProject, captureFreshProjectOpenPreparedSourceAuthority, parseFreshProjectOpenPreparedSourceAuthority,
  FRESH_PROJECT_CHECKPOINT_NAME,
  type FreshProject, type FreshProjectOpenPreparedSourceAuthority,
} from "../harness/fresh-project.js";
import {
  materializeFreshNetClasses, readFreshNetClassSemanticAuthority, verifyFreshNetClassSemanticAuthority,
  createFreshNetClassPreparationEvidence, parseFreshNetClassPreparationEvidence, parseFreshNetClassSemanticAuthority, type FreshNetClassMaterialization,
  type FreshNetClassSemanticAuthority, type FreshNetClassPreparationEvidence,
} from "../harness/fresh-clearance-evidence.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../integrations/kicad-cli.js";
import { assertPcbLibrarySourcesCurrent } from "../harness/pcb-library-source-binding.js";

/** All capabilities and paths are supplied by the owning host, never an MCP argument. */
export interface KicadToolboxFreshPreparationInput {
  readonly draft: unknown;
  readonly originalPrompt: string;
  readonly outputDir: string;
  readonly name: string;
  readonly dependencies: PcbDesignCompilationBundleDependencies;
  readonly deepRuleSelectionOptions?: PcbDesignCompilerOptions["deepRuleSelectionOptions"];
  /** Host preview pin; must match recompilation before any project is created. */
  readonly expectedBundleIdentity?: CanonicalIdentity;
  readonly expectedKicadCli: FluxKicadCliBinding;
  readonly createKicadCliAdapter: typeof KicadCliAdapter.create;
}

export interface KicadToolboxFreshPreparation {
  readonly mode: "fresh" | "resumed";
  readonly project: FreshProject;
  readonly bundle: PcbDesignCompilationBundle;
  readonly bundleRef: PcbDesignCompilationBundleRef;
  readonly bundlePath: string;
  readonly dependencies: PcbDesignCompilationBundleDependencies;
  readonly adapter: KicadCliAdapter;
  readonly kicadIdentity: KicadExecutableIdentity;
  readonly preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
  readonly netClassMaterialization: FreshNetClassMaterialization;
  readonly netClassSemanticAuthority: FreshNetClassSemanticAuthority;
  readonly netClassPreparationEvidence: FreshNetClassPreparationEvidence;
  readonly reportPath: string;
}

const preparations = new WeakSet<object>();

export function assertKicadToolboxFreshPreparation(value: unknown): asserts value is KicadToolboxFreshPreparation {
  if (value === null || typeof value !== "object" || !preparations.has(value)) {
    throw new Error("Fresh toolbox connection requires an original host preparation capability.");
  }
  const preparation = value as KicadToolboxFreshPreparation;
  assertPcbLibrarySourcesCurrent(preparation.bundle.libraryBinding, preparation.dependencies.libraryResolver);
}

export type KicadToolboxFreshPreparationResult =
  | Readonly<{ status: "needs_clarification"; compilation: PcbDesignCompilation }>
  | Readonly<{ status: "prepared"; preparation: KicadToolboxFreshPreparation }>;

/** Provider-free preparation only. Does not open KiCad or claim a completed design. */
export async function prepareKicadToolboxFreshProject(input: KicadToolboxFreshPreparationInput): Promise<KicadToolboxFreshPreparationResult> {
  const expectedBundleIdentity = input.expectedBundleIdentity === undefined ? undefined
    : validateCanonicalIdentity(hardenPortableValue(input.expectedBundleIdentity), "Previewed compilation identity");
  const dependencies = Object.freeze({ ...input.dependencies });
  const compilation = compilePcbDesignIntentDraft(input.draft, {
    libraryResolver: dependencies.libraryResolver,
    deepRuleCatalog: dependencies.deepRuleCatalog,
    ...(input.deepRuleSelectionOptions === undefined ? {} : { deepRuleSelectionOptions: input.deepRuleSelectionOptions }),
  });
  if (compilation.disposition !== "ready") return Object.freeze({ status: "needs_clarification", compilation });
  const bundle = createPcbDesignCompilationBundle({ originalPrompt: input.originalPrompt, compilation }, dependencies);
  if (expectedBundleIdentity !== undefined && canonicalJson(expectedBundleIdentity) !== canonicalJson(bundle.identity)) {
    throw new Error("Fresh compilation changed since preview; review the new compilation before creating a project.");
  }
  const bundleRef = createPcbDesignCompilationBundleRef(bundle);
  const expectedIdentity = structuredClone(input.expectedKicadCli);
  if (!path.isAbsolute(expectedIdentity.path) || expectedIdentity.contentIdentity.algorithm !== "sha256"
      || !/^[0-9a-f]{64}$/u.test(expectedIdentity.contentIdentity.digest)
      || !Number.isSafeInteger(expectedIdentity.contentIdentity.size) || expectedIdentity.contentIdentity.size < 1
      || !expectedIdentity.operationalVersion || !expectedIdentity.operationalCommit) {
    throw new Error("Fresh toolbox preparation requires an exact host-owned KiCad executable identity.");
  }
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, dependencies.libraryResolver);
  const project = await prepareFreshProject({ outputDir: input.outputDir, name: input.name, resume: false,
    workflowKind: "generic", compilationBundle: bundle, compilationBundleRef: bundleRef });
  const adapter = await input.createKicadCliAdapter({ workspaceRoot: project.outputPath, projectRoot: project.projectPath,
    outputRoot: project.outputPath, executablePath: expectedIdentity.path,
    expectedExecutableIdentity: { sha256: expectedIdentity.contentIdentity.digest, sizeBytes: expectedIdentity.contentIdentity.size } });
  const kicadIdentity = adapter.identity;
  if (kicadIdentity.kind !== "kicad-cli" || kicadIdentity.sha256 !== expectedIdentity.contentIdentity.digest
      || kicadIdentity.sizeBytes !== expectedIdentity.contentIdentity.size
      || kicadIdentity.version !== expectedIdentity.operationalVersion || kicadIdentity.commit !== expectedIdentity.operationalCommit) {
    throw new Error("Fresh toolbox KiCad adapter differs from the exact host-owned toolchain identity.");
  }
  const operation = { project, compilationBundle: bundle, kicad: kicadIdentity };
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, dependencies.libraryResolver);
  const netClassMaterialization = await materializeFreshNetClasses(operation);
  const observed = await readFreshNetClassSemanticAuthority(operation);
  const netClassSemanticAuthority = await verifyFreshNetClassSemanticAuthority(observed, operation);
  const netClassPreparationEvidence = createFreshNetClassPreparationEvidence(netClassMaterialization, netClassSemanticAuthority);
  const preparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(project);
  const bundlePath = path.join(project.outputPath, "toolbox-design-bundle.json");
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, dependencies.libraryResolver);
  await writeFile(bundlePath, serializePcbDesignCompilationBundle(bundle), { flag: "wx" });
  const reportPath = path.join(project.outputPath, "pcb-agent-report.json");
  const report = { schemaVersion: "evleda.toolbox-fresh-preparation-report.v1", status: "needs_review",
    workflow: { kind: "generic", bundleRef, bundlePath }, projectPath: project.projectPath,
    native: { kicad: kicadIdentity },
    preparation: { netClassMaterialization, netClassSemanticAuthority, netClassPreparationEvidence, preparedSourceAuthority },
    assurance: "Fresh project and net-class preparation only. Native authoring, ERC, DRC, and visual review remain pending." };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await project.checkpointAfterReport(reportPath, "needs_review");
  const preparation = Object.freeze({ mode: "fresh" as const, project, bundle, bundleRef, bundlePath, dependencies, adapter, kicadIdentity,
    preparedSourceAuthority, netClassMaterialization, netClassSemanticAuthority, netClassPreparationEvidence, reportPath });
  preparations.add(preparation);
  return Object.freeze({ status: "prepared", preparation });
}

export type KicadToolboxFreshResumeInput = Pick<KicadToolboxFreshPreparationInput,
  "outputDir" | "name" | "dependencies" | "expectedKicadCli" | "createKicadCliAdapter">;

const savedReportSchema = z.object({
  schemaVersion: z.literal("evleda.toolbox-fresh-preparation-report.v1"), status: z.literal("needs_review"),
  workflow: z.object({ kind: z.literal("generic"), bundleRef: z.unknown(), bundlePath: z.string() }).strict(),
  projectPath: z.string(), native: z.object({ kicad: z.unknown() }).strict(),
  preparation: z.object({ netClassMaterialization: z.unknown(), netClassSemanticAuthority: z.unknown(),
    netClassPreparationEvidence: z.unknown(), preparedSourceAuthority: z.unknown() }).strict(),
  assurance: z.string(),
}).strict();

export async function readResumeFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new Error("Resume artifact must be a bounded ordinary file.");
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size
      || bytes.length > maximumBytes) throw new Error("Resume artifact changed while being read.");
  return bytes;
}

/** Restore only checkpoint-bound host artifacts; never repair or rewrite a checkpoint. */
export async function resumeKicadToolboxFreshProject(input: KicadToolboxFreshResumeInput): Promise<KicadToolboxFreshPreparation> {
  if (Object.hasOwn(input, "expectedBundleIdentity")) throw new Error("Fresh resume cannot accept a previewed compilation identity; it uses the saved bundle.");
  const outputPath = path.resolve(input.outputDir);
  const bundlePath = path.join(outputPath, "toolbox-design-bundle.json");
  const reportPath = path.join(outputPath, "pcb-agent-report.json");
  const checkpointPath = path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME);
  const dependencies = Object.freeze({ ...input.dependencies });
  const [bundleBytes, reportBytes, checkpointBytes] = await Promise.all([
    readResumeFile(bundlePath, PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes),
    readResumeFile(reportPath, 16 * 1024 * 1024), readResumeFile(checkpointPath, 2 * 1024 * 1024),
  ]);
  const parse = (bytes: Buffer) => parsePortableJsonBytes(bytes, { maxBytes: 16 * 1024 * 1024,
    maxDepth: 96, maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 8192, maxKeyBytes: 1024, maxStringBytes: 1024 * 1024 });
  const report = savedReportSchema.parse(parse(reportBytes));
  const checkpoint = z.object({ schemaVersion: z.literal("evleda.pcb-agent-fresh-project-checkpoint.v2"),
    reportPath: z.literal(reportPath), reportSha256: z.literal(contentIdentity(reportBytes).digest),
    reportStatus: z.literal(report.status) }).passthrough().parse(parse(checkpointBytes));
  // Check the report before the engine's metadata reconciliation, which otherwise
  // deliberately tolerates changed diagnostic reports. The engine validates all
  // remaining checkpoint fields and exact current project bytes below.
  void checkpoint;
  const bundle = parsePcbDesignCompilationBundle(bundleBytes, dependencies);
  const bundleRef = createPcbDesignCompilationBundleRef(bundle);
  if (report.workflow.bundlePath !== bundlePath
      || canonicalJson(parsePcbDesignCompilationBundleRef(report.workflow.bundleRef)) !== canonicalJson(bundleRef)) {
    throw new Error("Saved toolbox report does not bind the canonical design bundle.");
  }
  const netClassMaterialization = report.preparation.netClassMaterialization as FreshNetClassMaterialization;
  const netClassSemanticAuthority = parseFreshNetClassSemanticAuthority(report.preparation.netClassSemanticAuthority);
  const netClassPreparationEvidence = parseFreshNetClassPreparationEvidence(report.preparation.netClassPreparationEvidence);
  const reconstructed = createFreshNetClassPreparationEvidence(netClassMaterialization, netClassSemanticAuthority);
  const preparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(report.preparation.preparedSourceAuthority);
  if (canonicalJson(reconstructed) !== canonicalJson(netClassPreparationEvidence)
      || canonicalJson(preparedSourceAuthority.pro) !== canonicalJson(netClassMaterialization.projectSettingsIdentity)
      || canonicalJson(preparedSourceAuthority.pcb) !== canonicalJson(netClassMaterialization.pcbIdentityAtMaterialization)
      || canonicalJson(preparedSourceAuthority.marker) !== canonicalJson(netClassMaterialization.freshMarkerContentIdentity)) {
    throw new Error("Saved toolbox report preparation authorities disagree.");
  }
  const projectOptions = { outputDir: outputPath, name: input.name, resume: true as const,
    workflowKind: "generic" as const, compilationBundle: bundle, compilationBundleRef: bundleRef };
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, dependencies.libraryResolver);
  const project = await prepareFreshProject(projectOptions);
  if (report.projectPath !== project.projectPath
      || canonicalJson(preparedSourceAuthority.projectIdentity) !== canonicalJson(project.projectIdentity)) {
    throw new Error("Saved toolbox preparation belongs to another native project.");
  }
  const expected = structuredClone(input.expectedKicadCli);
  const adapter = await input.createKicadCliAdapter({ workspaceRoot: project.outputPath, projectRoot: project.projectPath,
    outputRoot: project.outputPath, executablePath: expected.path,
    expectedExecutableIdentity: { sha256: expected.contentIdentity.digest, sizeBytes: expected.contentIdentity.size } });
  const kicadIdentity = adapter.identity;
  if (kicadIdentity.kind !== "kicad-cli" || kicadIdentity.sha256 !== expected.contentIdentity.digest
      || kicadIdentity.sizeBytes !== expected.contentIdentity.size || kicadIdentity.version !== expected.operationalVersion
      || kicadIdentity.commit !== expected.operationalCommit || canonicalJson(report.native.kicad) !== canonicalJson(kicadIdentity)) {
    throw new Error("Resumed toolbox KiCad adapter differs from the saved or host-owned toolchain identity.");
  }
  await verifyFreshNetClassSemanticAuthority(netClassSemanticAuthority, { project, compilationBundle: bundle, kicad: kicadIdentity });
  const currentArtifacts = await Promise.all([readResumeFile(bundlePath, bundleBytes.length),
    readResumeFile(reportPath, reportBytes.length), readResumeFile(checkpointPath, checkpointBytes.length)]);
  if (currentArtifacts.some((bytes, index) => !bytes.equals([bundleBytes, reportBytes, checkpointBytes][index]!))) {
    throw new Error("Saved toolbox artifacts changed during resume.");
  }
  assertPcbLibrarySourcesCurrent(bundle.libraryBinding, dependencies.libraryResolver);
  await prepareFreshProject(projectOptions);
  const preparation = Object.freeze({ mode: "resumed" as const, project, bundle, bundleRef, bundlePath, dependencies, adapter, kicadIdentity,
    preparedSourceAuthority, netClassMaterialization, netClassSemanticAuthority, netClassPreparationEvidence, reportPath });
  preparations.add(preparation);
  return preparation;
}

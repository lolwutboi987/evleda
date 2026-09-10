import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes, validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "../domain/types.js";
import type { FluxKicadCliBinding } from "../flux/kicad-toolchain-binding.js";
import { compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy, type PcbPlaneCompilerOptions, type PcbPlaneDesignCompilation } from "../harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef, parsePcbPlaneCompilationBundle,
  parsePcbPlaneCompilationBundleRef, serializePcbPlaneCompilationBundle, PCB_PLANE_BUNDLE_MAX_BYTES,
  type PcbPlaneCompilationBundle, type PcbPlaneCompilationBundleRef } from "../harness/pcb-design-plane-bundle.js";
import { preparePlaneFreshProject, captureFreshProjectOpenPreparedSourceAuthority, parseFreshProjectOpenPreparedSourceAuthority,
  FRESH_PROJECT_CHECKPOINT_NAME, type PlaneFreshProject, type FreshProjectOpenPreparedSourceAuthority } from "../harness/fresh-project.js";
import { materializeFreshPlaneNetClasses, readFreshPlaneNetClassSemanticAuthority, verifyFreshPlaneNetClassSemanticAuthority,
  parseFreshPlaneNetClassMaterialization, parseFreshPlaneNetClassSemanticAuthority, createFreshPlaneNetClassPreparationEvidence, parseFreshPlaneNetClassPreparationEvidence } from "../harness/fresh-plane-netclasses.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../integrations/kicad-cli.js";
import { readResumeFile } from "./toolbox-fresh-preparation.js";

export interface KicadToolboxPlanePreparationInput {
  readonly draft: unknown;
  readonly originalPrompt: string;
  readonly outputDir: string;
  readonly name: string;
  readonly dependencies: PcbPlaneCompilerOptions;
  readonly deepRuleSelectionOptions?: PcbPlaneCompilerOptions["deepRuleSelectionOptions"];
  readonly expectedBundleIdentity?: CanonicalIdentity;
  readonly expectedKicadCli: FluxKicadCliBinding;
  readonly createKicadCliAdapter: typeof KicadCliAdapter.create;
}
export interface KicadToolboxPlanePreparation {
  readonly family: "plane-v2";
  readonly mode: "fresh" | "resumed";
  readonly project: PlaneFreshProject;
  readonly bundle: PcbPlaneCompilationBundle;
  readonly bundleRef: PcbPlaneCompilationBundleRef;
  readonly bundlePath: string;
  readonly dependencies: PcbPlaneCompilerOptions;
  readonly adapter: KicadCliAdapter;
  readonly kicadIdentity: KicadExecutableIdentity;
  readonly preparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
  readonly netClassMaterialization: Awaited<ReturnType<typeof materializeFreshPlaneNetClasses>>;
  readonly netClassSemanticAuthority: ReturnType<typeof parseFreshPlaneNetClassSemanticAuthority>;
  readonly netClassPreparationEvidence: ReturnType<typeof parseFreshPlaneNetClassPreparationEvidence>;
  readonly reportPath: string;
}
const preparations = new WeakSet<object>();
export function assertKicadToolboxPlanePreparation(value: unknown): asserts value is KicadToolboxPlanePreparation {
  if (value === null || typeof value !== "object" || !preparations.has(value)) throw new Error("Plane toolbox requires an original authenticated V2 preparation capability.");
}

function expectedExecutable(value: FluxKicadCliBinding): FluxKicadCliBinding {
  const expected = structuredClone(value);
  if (!path.isAbsolute(expected.path) || expected.contentIdentity.algorithm !== "sha256"
      || !/^[a-f0-9]{64}$/u.test(expected.contentIdentity.digest) || !Number.isSafeInteger(expected.contentIdentity.size)
      || expected.contentIdentity.size < 1 || !expected.operationalVersion || !expected.operationalCommit) {
    throw new Error("Plane preparation requires an exact host-owned KiCad executable identity.");
  }
  return expected;
}
async function openAdapter(project: PlaneFreshProject, expected: FluxKicadCliBinding, create: typeof KicadCliAdapter.create) {
  const adapter = await create({ workspaceRoot: project.outputPath, projectRoot: project.projectPath, outputRoot: project.outputPath,
    executablePath: expected.path, expectedExecutableIdentity: { sha256: expected.contentIdentity.digest, sizeBytes: expected.contentIdentity.size } });
  const actual = adapter.identity;
  if (actual.kind !== "kicad-cli" || actual.sha256 !== expected.contentIdentity.digest || actual.sizeBytes !== expected.contentIdentity.size
      || actual.version !== expected.operationalVersion || actual.commit !== expected.operationalCommit) throw new Error("Plane preparation KiCad adapter differs from its approved executable/version/commit.");
  return adapter;
}
export function planePreparationReportBody(preparation: Omit<KicadToolboxPlanePreparation, "family" | "mode" | "adapter" | "dependencies">) {
  return { schemaVersion: "evleda.toolbox-plane-preparation-report.v1", status: "needs_review",
    workflow: { kind: "plane", bundleRef: preparation.bundleRef, bundlePath: preparation.bundlePath }, projectPath: preparation.project.projectPath,
    native: { kicad: preparation.kicadIdentity }, preparation: { netClassMaterialization: preparation.netClassMaterialization,
      netClassSemanticAuthority: preparation.netClassSemanticAuthority, netClassPreparationEvidence: preparation.netClassPreparationEvidence,
      preparedSourceAuthority: preparation.preparedSourceAuthority } };
}

export type KicadToolboxPlanePreparationResult =
  | Readonly<{ status: "needs_clarification" | "unsupported"; compilation: Exclude<PcbPlaneDesignCompilation, { disposition: "ready" }>; projectCreated: false }>
  | Readonly<{ status: "prepared"; preparation: KicadToolboxPlanePreparation }>;

/** Prepare the real V2 bundle/project family. No native authoring or acceptance is claimed. */
export async function prepareKicadToolboxPlaneProject(input: KicadToolboxPlanePreparationInput): Promise<KicadToolboxPlanePreparationResult> {
  const preview = input.expectedBundleIdentity === undefined ? undefined
    : validateCanonicalIdentity(hardenPortableValue(input.expectedBundleIdentity), "Previewed plane compilation identity");
  const expected = expectedExecutable(input.expectedKicadCli);
  const dependencies = Object.freeze({ ...input.dependencies,
    deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(input.deepRuleSelectionOptions ?? input.dependencies.deepRuleSelectionOptions) });
  const compilation = compilePcbPlaneDesignIntentDraft(input.draft, dependencies);
  if (compilation.disposition !== "ready") return Object.freeze({ status: compilation.disposition, compilation, projectCreated: false });
  const bundle = createPcbPlaneCompilationBundle({ originalPrompt: input.originalPrompt, compilation }, dependencies);
  if (preview !== undefined && canonicalJson(preview) !== canonicalJson(bundle.identity)) throw new Error("Plane compilation changed since preview; review it before project creation.");
  const bundleRef = createPcbPlaneCompilationBundleRef(bundle);
  const project = await preparePlaneFreshProject({ outputDir: input.outputDir, name: input.name, resume: false, compilationBundle: bundle, compilationBundleRef: bundleRef });
  const adapter = await openAdapter(project, expected, input.createKicadCliAdapter);
  const kicadIdentity = adapter.identity;
  const operation = { project, compilationBundle: bundle, kicad: kicadIdentity };
  const netClassMaterialization = await materializeFreshPlaneNetClasses(operation);
  const netClassSemanticAuthority = await verifyFreshPlaneNetClassSemanticAuthority(await readFreshPlaneNetClassSemanticAuthority(operation), operation);
  const netClassPreparationEvidence = createFreshPlaneNetClassPreparationEvidence(netClassMaterialization, netClassSemanticAuthority);
  const preparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(project);
  const bundlePath = path.join(project.outputPath, "toolbox-design-bundle.json");
  const reportPath = path.join(project.outputPath, "pcb-agent-report.json");
  await writeFile(bundlePath, serializePcbPlaneCompilationBundle(bundle), { flag: "wx" });
  const fields = { project, bundle, bundleRef, bundlePath, reportPath, kicadIdentity, preparedSourceAuthority,
    netClassMaterialization, netClassSemanticAuthority, netClassPreparationEvidence };
  await writeFile(reportPath, `${JSON.stringify({ ...planePreparationReportBody(fields),
    assurance: "V2 plane project and netclass configuration only. Schematic/PCB authoring, fresh copper, connectivity, clearance, reference coverage and design acceptance remain pending." }, null, 2)}\n`, { flag: "wx" });
  await project.checkpointAfterReport(reportPath, "needs_review");
  const preparation: KicadToolboxPlanePreparation = Object.freeze({ ...fields, family: "plane-v2", mode: "fresh", adapter, dependencies });
  preparations.add(preparation);
  return Object.freeze({ status: "prepared" as const, preparation });
}

export type KicadToolboxPlaneResumeInput = Pick<KicadToolboxPlanePreparationInput, "outputDir" | "name" | "dependencies" | "expectedKicadCli" | "createKicadCliAdapter">;
const savedReport = z.object({ schemaVersion: z.literal("evleda.toolbox-plane-preparation-report.v1"), status: z.literal("needs_review"),
  workflow: z.object({ kind: z.literal("plane"), bundleRef: z.unknown(), bundlePath: z.string() }).strict(), projectPath: z.string(),
  native: z.object({ kicad: z.unknown() }).strict(), preparation: z.object({ netClassMaterialization: z.unknown(), netClassSemanticAuthority: z.unknown(),
    netClassPreparationEvidence: z.unknown(), preparedSourceAuthority: z.unknown() }).strict(), assurance: z.string() }).strict();

export async function resumeKicadToolboxPlaneProject(input: KicadToolboxPlaneResumeInput): Promise<KicadToolboxPlanePreparation> {
  if (Object.hasOwn(input, "expectedBundleIdentity")) throw new Error("Plane resume uses its saved V2 bundle, not a replacement preview.");
  const expected = expectedExecutable(input.expectedKicadCli);
  const dependencies = Object.freeze({ ...input.dependencies,
    deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(input.dependencies.deepRuleSelectionOptions) });
  const outputPath = path.resolve(input.outputDir), bundlePath = path.join(outputPath, "toolbox-design-bundle.json"), reportPath = path.join(outputPath, "pcb-agent-report.json");
  const checkpointPath = path.join(outputPath, FRESH_PROJECT_CHECKPOINT_NAME);
  const [bundleBytes, reportBytes, checkpointBytes] = await Promise.all([readResumeFile(bundlePath, PCB_PLANE_BUNDLE_MAX_BYTES),
    readResumeFile(reportPath, 16 * 1024 * 1024), readResumeFile(checkpointPath, 2 * 1024 * 1024)]);
  const parse = (bytes: Buffer) => parsePortableJsonBytes(bytes, { maxBytes: 16 * 1024 * 1024, maxDepth: 96, maxNodes: 500_000,
    maxArrayLength: 100_000, maxOwnKeys: 8192, maxKeyBytes: 1024, maxStringBytes: 1024 * 1024 });
  const report = savedReport.parse(parse(reportBytes));
  z.object({ schemaVersion: z.literal("evleda.pcb-agent-fresh-project-checkpoint.v3"), reportPath: z.literal(reportPath),
    reportSha256: z.literal(contentIdentity(reportBytes).digest), reportStatus: z.literal("needs_review") }).passthrough().parse(parse(checkpointBytes));
  const bundle = parsePcbPlaneCompilationBundle(bundleBytes, dependencies), bundleRef = createPcbPlaneCompilationBundleRef(bundle);
  if (report.workflow.bundlePath !== bundlePath || canonicalJson(parsePcbPlaneCompilationBundleRef(report.workflow.bundleRef)) !== canonicalJson(bundleRef)) throw new Error("Plane report does not bind the exact saved V2 bundle.");
  const netClassMaterialization = parseFreshPlaneNetClassMaterialization(report.preparation.netClassMaterialization);
  const netClassSemanticAuthority = parseFreshPlaneNetClassSemanticAuthority(report.preparation.netClassSemanticAuthority);
  const netClassPreparationEvidence = parseFreshPlaneNetClassPreparationEvidence(report.preparation.netClassPreparationEvidence);
  const preparedSourceAuthority = parseFreshProjectOpenPreparedSourceAuthority(report.preparation.preparedSourceAuthority);
  if (canonicalJson(createFreshPlaneNetClassPreparationEvidence(netClassMaterialization, netClassSemanticAuthority)) !== canonicalJson(netClassPreparationEvidence)
      || canonicalJson(preparedSourceAuthority.pro) !== canonicalJson(netClassMaterialization.projectSettingsIdentity)
      || canonicalJson(preparedSourceAuthority.pcb) !== canonicalJson(netClassMaterialization.pcbIdentityAtMaterialization)
      || canonicalJson(preparedSourceAuthority.marker) !== canonicalJson(netClassMaterialization.freshMarkerContentIdentity)) throw new Error("Plane preparation authorities disagree.");
  const projectOptions = { outputDir: outputPath, name: input.name, resume: true, compilationBundle: bundle, compilationBundleRef: bundleRef };
  const project = await preparePlaneFreshProject(projectOptions);
  if (report.projectPath !== project.projectPath || canonicalJson(preparedSourceAuthority.projectIdentity) !== canonicalJson(project.projectIdentity)) throw new Error("Plane preparation belongs to another project.");
  const adapter = await openAdapter(project, expected, input.createKicadCliAdapter), kicadIdentity = adapter.identity;
  if (canonicalJson(kicadIdentity) !== canonicalJson(report.native.kicad)) throw new Error("Plane resume KiCad identity differs from its recorded toolchain.");
  await verifyFreshPlaneNetClassSemanticAuthority(netClassSemanticAuthority, { project, compilationBundle: bundle, kicad: kicadIdentity });
  const after = await Promise.all([readResumeFile(bundlePath, bundleBytes.length), readResumeFile(reportPath, reportBytes.length), readResumeFile(checkpointPath, checkpointBytes.length)]);
  if (after.some((bytes, index) => !bytes.equals([bundleBytes, reportBytes, checkpointBytes][index]!))) throw new Error("Saved plane artifacts changed during resume.");
  await preparePlaneFreshProject(projectOptions);
  const preparation: KicadToolboxPlanePreparation = Object.freeze({ family: "plane-v2", mode: "resumed", project, bundle, bundleRef, bundlePath,
    reportPath, dependencies, adapter, kicadIdentity, preparedSourceAuthority, netClassMaterialization, netClassSemanticAuthority, netClassPreparationEvidence });
  preparations.add(preparation);
  return preparation;
}

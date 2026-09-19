import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentIdentity } from "../core/canonical.js";
import { hardenPortableValue, parsePortableJsonBytes, validateCanonicalIdentity } from "../core/portable-artifact.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { loadKicadToolboxFreshProfile } from "./toolbox-fresh-profile.js";
import { loadKicadToolboxNativeProfile } from "./toolbox-native-profile.js";
import { prepareKicadToolboxFreshProject, resumeKicadToolboxFreshProject, readResumeFile } from "./toolbox-fresh-preparation.js";
import { prepareKicadToolboxPlaneProject, resumeKicadToolboxPlaneProject } from "./toolbox-plane-preparation.js";
import { openKicadToolboxNativeHost } from "./toolbox-native-host.js";
import { createKicadToolboxMcpServer, type KicadToolboxMcpServer, type KicadToolboxServerOptions } from "./toolbox-server.js";
import type { KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import { createFreshConnectivityContract } from "../harness/fresh-connectivity-contract.js";
import { normalizePcbPlaneSelectionPolicy } from "../harness/pcb-design-plane-compiler.js";
import { assertPcbLibrarySourcesCurrent } from "../harness/pcb-library-source-binding.js";
import { assertPcbExternalPowerBindingCurrent } from "../harness/pcb-external-power.js";
import { assertPcbDerivedPowerBindingCurrent } from "../harness/pcb-derived-power.js";
import { assertFreshPlaneSchematicSeedProfile, type FreshPlaneSchematicSeed } from "../harness/fresh-plane-schematic-seed.js";
import { captureClosedPlaneSchematicSeedSource, type ClosedPlaneSchematicSeedSource } from "./toolbox-schematic-seed.js";
import { assertFreshPlanePlacementSeedProfile, type FreshPlanePlacementSeed } from "../harness/fresh-plane-placement-seed.js";
import { captureClosedPlanePlacementRevisionSource, type ClosedPlanePlacementRevisionSource, type PlacementRevisionLineage } from "./toolbox-placement-revision.js";

export interface FreshNativeToolboxOptions {
  readonly profile: KicadMcpPinnedFileInput;
  readonly projectDir: string;
  readonly outputDir: string;
  readonly edit?: boolean;
  readonly resume?: boolean;
  /** Host-selected input data; never a source of native paths or executable authority. */
  readonly fresh: Readonly<{ name: string; intentPath?: string; originalPrompt?: string; draft?: unknown;
    expectedBundleIdentity?: CanonicalIdentity; schematicSeed?: FreshPlaneSchematicSeed;
    placementSeed?: FreshPlanePlacementSeed; placementRevisionLineage?: PlacementRevisionLineage }>;
}

export type FreshNativeToolboxBinding = Required<Pick<KicadToolboxServerOptions,
  "cad" | "access" | "compoundContractIdentity" | "designContext">>
  & Pick<KicadToolboxServerOptions, "transmissionLine">
  & { readonly captureClosedSchematicSeedSource?: () => Promise<ClosedPlaneSchematicSeedSource | undefined>;
      readonly captureClosedPlacementRevisionSource?: () => Promise<ClosedPlanePlacementRevisionSource | undefined> };

const INTENT_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 100_000,
  maxArrayLength: 1024, maxOwnKeys: 1024, maxKeyBytes: 512, maxStringBytes: 64 * 1024 });

/** Host-only preparation/opening, suitable for attaching CAD to an existing MCP server. */
export async function openFreshNativeToolboxBinding(options: FreshNativeToolboxOptions): Promise<FreshNativeToolboxBinding> {
  const nativeSourceProfile = Object.freeze({ path: options.profile.path, contentIdentity: Object.freeze({ ...options.profile.contentIdentity }) });
  const seed = options.fresh.schematicSeed;
  const placementSeed = options.fresh.placementSeed;
  if (placementSeed !== undefined) {
    if (options.resume || seed !== undefined) throw new Error("Placement seeding requires a distinct new plane allocation.");
    assertFreshPlanePlacementSeedProfile(placementSeed, nativeSourceProfile);
  }
  if (seed !== undefined) {
    if (options.resume) throw new Error("A seeded allocation cannot replace an existing project during resume.");
    assertFreshPlaneSchematicSeedProfile(seed, nativeSourceProfile);
  }
  if (options.resume && options.fresh.expectedBundleIdentity !== undefined) throw new Error("Fresh resume cannot accept a previewed compilation identity; it uses the saved bundle.");
  const expectedBundleIdentity = options.fresh.expectedBundleIdentity === undefined ? undefined
    : validateCanonicalIdentity(hardenPortableValue(options.fresh.expectedBundleIdentity), "Previewed compilation identity");
  // Detach structured data before the first asynchronous operation. The same
  // JSON limits apply as the file route; accessors, proxies and functions fail.
  const hasDraft = options.fresh.draft !== undefined;
  if (hasDraft && (options.resume || options.fresh.intentPath !== undefined)) {
    throw new Error("Structured fresh drafts cannot be combined with a file intent or saved-bundle resume.");
  }
  let bytes = hasDraft ? Buffer.from(JSON.stringify(hardenPortableValue(options.fresh.draft, INTENT_LIMITS)), "utf8") : undefined;
  let draft: unknown = bytes === undefined ? undefined : parsePortableJsonBytes(bytes, INTENT_LIMITS);
  const sourceRoot = await realpath(options.projectDir);
  if (options.resume) {
    if (options.fresh.intentPath !== undefined || options.fresh.originalPrompt !== undefined) throw new Error("Fresh resume must use the saved bundle, not new intent or prompt data.");
  } else {
    if ((!hasDraft && options.fresh.intentPath === undefined) || !options.fresh.originalPrompt?.trim()) throw new Error("Fresh intent and original prompt are required.");
    if (!hasDraft) {
      const intentPath = await realpath(options.fresh.intentPath!);
      const relative = path.relative(sourceRoot, intentPath);
      const metadata = await lstat(options.fresh.intentPath!);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 256 * 1024) throw new Error("Fresh intent must be a bounded ordinary JSON file within the host's separate input folder.");
      bytes = await readFile(intentPath);
      draft = parsePortableJsonBytes(bytes, INTENT_LIMITS);
    }
  }
  const design = await loadKicadToolboxFreshProfile(nativeSourceProfile);
  if (!options.resume) await mkdir(options.outputDir, { recursive: true });
  const outputMetadata = await lstat(options.outputDir);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink() || !options.resume && (await readdir(options.outputDir)).length !== 0) {
    throw new Error("Fresh toolbox output must be an ordinary directory, empty for a new design.");
  }
  const native = await loadKicadToolboxNativeProfile({ profile: nativeSourceProfile, sourceRoot, outputRoot: options.outputDir,
    additionalProtectedRoots: design.protectedRoots });
  const stock = path.resolve(native.editorSuite.profile.binRoot, "..", "share", "kicad");
  for (const [configured, expected] of [
    [design.libraryEnvironment.KICAD10_SYMBOL_DIR, path.join(stock, "symbols")],
    [design.libraryEnvironment.KICAD10_FOOTPRINT_DIR, path.join(stock, "footprints")],
  ]) {
    if ((await realpath(configured!)).toLowerCase() !== (await realpath(expected!)).toLowerCase()) {
      throw new Error("Fresh toolbox libraries must match the pinned KiCad installation used by native authoring.");
    }
  }
  const nativePreparationInput = {
    outputDir: options.outputDir, name: options.fresh.name, dependencies: design.dependencies,
    expectedKicadCli: native.editorSuite.profile.kicadCli, createKicadCliAdapter: native.createCliAdapter };
  const familyRecord = options.resume
    ? parsePortableJsonBytes(await readResumeFile(path.join(options.outputDir, "toolbox-design-bundle.json"), 8 * 1024 * 1024),
      { maxBytes: 8 * 1024 * 1024, maxDepth: 96, maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 8192, maxKeyBytes: 1024, maxStringBytes: 1024 * 1024 })
    : draft;
  const schema = familyRecord !== null && typeof familyRecord === "object" ? (familyRecord as Record<string, unknown>).schemaVersion : undefined;
  if (options.resume && schema !== "evleda.pcb-design-compilation-bundle.v1" && schema !== "evleda.pcb-design-compilation-bundle.v2") {
    throw new Error("Saved fresh bundle family is unsupported; resume cannot replace its contract.");
  }
  const plane = schema === (options.resume ? "evleda.pcb-design-compilation-bundle.v2" : "evleda.pcb-design-intent-draft.v2");
  if (seed !== undefined && !plane) throw new Error("Unwired schematic seeds require the V2 plane family.");
  if ((placementSeed !== undefined || options.fresh.placementRevisionLineage !== undefined) && !plane) throw new Error("Placement revision sources require the V2 plane family.");
  const planePreparationInput = () => ({ ...nativePreparationInput,
    ...(options.fresh.placementRevisionLineage === undefined ? {} : { placementRevisionLineage: options.fresh.placementRevisionLineage }),
    dependencies: { ...design.dependencies, deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(design.deepRuleSelectionOptions) } });
  const newInput = { ...nativePreparationInput, draft, originalPrompt: options.fresh.originalPrompt!,
    ...(expectedBundleIdentity === undefined ? {} : { expectedBundleIdentity }), deepRuleSelectionOptions: design.deepRuleSelectionOptions };
  const outcome = plane
    ? options.resume ? { status: "prepared" as const, preparation: await resumeKicadToolboxPlaneProject(planePreparationInput()) }
      : await prepareKicadToolboxPlaneProject({ ...newInput, dependencies: planePreparationInput().dependencies, ...(seed === undefined ? {} : { schematicSeed: seed }),
        ...(placementSeed === undefined ? {} : { placementSeed }),
        ...(options.fresh.placementRevisionLineage === undefined ? {} : { placementRevisionLineage: options.fresh.placementRevisionLineage }) })
    : options.resume ? { status: "prepared" as const, preparation: await resumeKicadToolboxFreshProject(nativePreparationInput) }
      : await prepareKicadToolboxFreshProject(newInput);
  if (outcome.status !== "prepared") {
    const reportPath = path.join(options.outputDir, "toolbox-clarifications.json");
    await writeFile(reportPath, `${JSON.stringify(outcome, null, 2)}\n`, { flag: "wx" });
    throw new Error(`Fresh design is not ready to create. Inspect required clarifications/issues in ${reportPath}.`);
  }
  const preparation = outcome.preparation;
  const project = preparation.project;
  const prepared = { sourceProjectPath: project.projectPath, isolatedProjectPath: project.projectPath,
    outputPath: project.outputPath, reportPath: preparation.reportPath, freshProject: project };
  assertPcbLibrarySourcesCurrent(preparation.bundle.libraryBinding, preparation.dependencies.libraryResolver);
  if ("family" in preparation && preparation.bundle.externalPowerBinding !== undefined) assertPcbExternalPowerBindingCurrent(preparation.bundle.externalPowerBinding, preparation.dependencies.libraryResolver);
  if ("family" in preparation && preparation.bundle.derivedPowerBinding !== undefined) assertPcbDerivedPowerBindingCurrent(preparation.bundle.derivedPowerBinding, preparation.bundle.libraryBinding, preparation.dependencies.libraryResolver);
  const cad = await openKicadToolboxNativeHost({ runtime: native.bridge, suite: native.editorSuite, prepared,
    pcbPath: project.pcbPath, termination: native.termination, launcher: native.editorLauncher, environment: { ...native.environment, ...design.libraryEnvironment },
    ...("family" in preparation
      ? { planeFresh: { preparation, createCliAdapter: native.createCliAdapter,
        ...(native.createPlaneContactsReader===undefined?{}:{createPlaneContactsReader:native.createPlaneContactsReader}),
        ...(native.referenceCoverage===undefined?{}:{referenceCoverage:native.referenceCoverage}) } }
      : { fresh: { preparation, createCliAdapter: native.createCliAdapter } }),
    ...(native.referenceCoverage === undefined ? {} : { referenceCoverage: native.referenceCoverage }) });
  try {
    const context = "family" in preparation ? {
      originalPrompt: preparation.bundle.originalPrompt, contract: preparation.bundle.contract,
      executionGuidance: preparation.bundle.executionGuidance, verificationPlan: preparation.bundle.verificationPlan,
      bundleIdentity: preparation.bundle.identity, family: preparation.family,
      ...(preparation.bundle.externalPowerBinding === undefined ? {} : { externalPowerBinding: preparation.bundle.externalPowerBinding }),
      ...(preparation.bundle.derivedPowerBinding === undefined ? {} : { derivedPowerBinding: preparation.bundle.derivedPowerBinding }),
      copperAuthoring: {
        incrementalRoutes: options.edit === true && ["fresh_get_route_items", "fresh_replace_route_items"]
          .every(name => cad.tools.tools.some(tool => tool.name === name)),
        contractPlane: options.edit === true && cad.tools.tools.some(tool => tool.name === "fresh_apply_contract_plane"),
      }, acceptanceEvaluated: false,
    } : { originalPrompt: preparation.bundle.executionPrompt.originalPrompt, contract: preparation.bundle.contract,
      executionGuidance: preparation.bundle.executionPrompt.text, acceptancePlan: preparation.bundle.acceptancePlan, bundleIdentity: preparation.bundle.identity };
    return Object.freeze({ cad, access: options.edit ? "edit" : "read-only",
      ...("family" in preparation ? { captureClosedPlacementRevisionSource: () => captureClosedPlanePlacementRevisionSource({
        project: preparation.project, bundle: preparation.bundle, profile: nativeSourceProfile, dependencies: preparation.dependencies,
        symbolRoot: design.libraryEnvironment.KICAD10_SYMBOL_DIR!,
      }), captureClosedSchematicSeedSource: () => captureClosedPlaneSchematicSeedSource({
        project: preparation.project, bundle: preparation.bundle, profile: nativeSourceProfile, dependencies: preparation.dependencies,
        symbolRoot: design.libraryEnvironment.KICAD10_SYMBOL_DIR!,
      }) } : {}),
      ...(native.transmissionLine === undefined ? {} : { transmissionLine: native.transmissionLine }),
      compoundContractIdentity: createFreshConnectivityContract(preparation.bundle.contract,
        "family" in preparation && preparation.family === "plane-v2" ? preparation.bundle.externalPowerBinding : undefined,
        "family" in preparation && preparation.family === "plane-v2" ? preparation.bundle.derivedPowerBinding : undefined).identity,
      designContext: () => ({ ...context,
        intentSourceIdentity: bytes === undefined ? null : contentIdentity(bytes), resumedFromSavedBundle: options.resume === true,
        intentSourceKind: options.resume ? "saved-bundle" : hasDraft ? "structured" : "file",
        status: "requirements-only; authoring and verification remain pending" }) });
  } catch (error) {
    try { await cad.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fresh toolbox creation failed and cleanup was not confirmed."); }
    throw error;
  }
}

/** Existing CLI-compatible wrapper; ownership transfers to the created server. */
export async function createFreshNativeToolbox(options: FreshNativeToolboxOptions): Promise<KicadToolboxMcpServer> {
  const binding = await openFreshNativeToolboxBinding(options);
  try { return createKicadToolboxMcpServer(binding); }
  catch (error) {
    try { await binding.cad.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fresh toolbox creation failed and cleanup was not confirmed."); }
    throw error;
  }
}

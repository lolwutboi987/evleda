import path from "node:path";
import { lstat, open, writeFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import { readKicadNativeProfile } from "../flux/production-composition.js";
import { createKicadMcpRuntimeBridge, KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
  parseKicadMcpInspectionRuntimeManifestSummary, type KicadMcpPinnedFileInput } from "../integrations/kicad-mcp-session.js";
import { captureFreshRuntimeImportFile, captureReadonlyPlaneRuntimeImportSource, assertReadonlyPlaneRuntimeImportSourceCurrent,
  readReadonlyPlaneRuntimeImportSource, FRESH_RUNTIME_IMPORT_SOURCE_KEYS } from "../harness/fresh-project.js";
import { readFreshDirectoryIdentity } from "../harness/fresh-project.js";
import { issueFreshPlaneSchematicSeed } from "../harness/fresh-plane-schematic-seed.js";
import { parsePcbPlaneCompilationBundle, createPcbPlaneCompilationBundle, serializePcbPlaneCompilationBundle } from "../harness/pcb-design-plane-bundle.js";
import { compilePcbPlaneDesignIntentDraft, normalizePcbPlaneSelectionPolicy } from "../harness/pcb-design-plane-compiler.js";
import { freezePcbPlaneArtifact } from "../harness/pcb-design-plane-contract.js";
import { createInterfaceConstructionBoardSeed } from "../harness/interface-construction-seed.js";
import { parseFreshPcbSourceDocument, parseFreshSchematicSourceDocument } from "../harness/fresh-kicad-parser.js";
import { loadKicadToolboxFreshProfile } from "./toolbox-fresh-profile.js";
import { openFreshNativeToolboxBinding } from "./toolbox-fresh-main.js";
import { createKicadToolboxMcpServer } from "./toolbox-server.js";
import type { ToolboxWorkspaceStore } from "./toolbox-workspace-store.js";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function need(value: unknown, message: string): asserts value { if (!value) throw new Error(`Runtime source import: ${message}`); }
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const content = z.object({ algorithm: z.literal("sha256"), digest, size: z.number().int().positive().max(64 * 1024 * 1024) }).strict();
const canonical = z.object({ algorithm: z.literal("sha256"), digest, schemaVersion: z.string().min(1).max(128), canonicalizationVersion: z.literal("evleda-c14n-json-v1") }).strict();
const pinned = z.object({ path: z.string().min(1).max(4096), contentIdentity: content }).strict();
const publishedPin = z.object({ path: z.string().min(1).max(4096), sha256: digest, sizeBytes: z.number().int().positive().max(64 * 1024 * 1024) }).strict();
const sources = z.object(Object.fromEntries(FRESH_RUNTIME_IMPORT_SOURCE_KEYS.map(key => [key, content])) as Record<typeof FRESH_RUNTIME_IMPORT_SOURCE_KEYS[number], typeof content>).strict();
const runtime = z.object({ root: z.string(), manifest: publishedPin, manifestIdentity: canonical, treeIdentity: canonical,
  fileCount: z.number().int().positive().max(20000), totalBytes: z.number().int().positive().max(1024 * 1024 * 1024) }).strict();
const RUNTIME_CHANGES = Object.freeze(["environment/Lib/site-packages/kicad_mcp/tools/schematic.py", "environment/Lib/site-packages/kicad_mcp/models/visual_qa.py", "environment/pyvenv.cfg"]);
const PROFILE_CHANGES = Object.freeze(["kicadMcpRuntime.runtimeBundle", "kicadMcpRuntime.processTreeSupervision.terminator.path",
  "kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256"]);
const qualificationSchema = z.object({ schemaVersion: z.literal("evleda.schematic-cardinal-runtime-qualification.v1"),
  sourceProfile: publishedPin, targetProfile: publishedPin, sourceRuntime: runtime, targetRuntime: runtime,
  allowedRuntimeChanges: z.array(z.object({ path: z.string(), before: publishedPin.omit({ path: true }), after: publishedPin.omit({ path: true }), reason: z.string().min(1).max(2000) }).strict()).length(3),
  oracle: publishedPin.extend({ cliIdentity: z.unknown() }).strict(),
  qualification: z.object({ report: publishedPin, passed: z.literal(true), publicPinPositions: z.literal(true), exactPinAliases: z.literal(true),
    publicConnectivityGraph: z.literal(true), visualBounds: z.literal(true), oldNegativeControl: z.literal(true) }).strict(),
  sourceRuntimeUnchanged: z.literal(true), profilePolicyComparison: z.object({ allowedPaths: z.array(z.string()).length(3), othersEqual: z.literal(true) }).strict(),
  noNativeAcceptanceTransferred: z.literal(true) }).strict();
export const runtimeSourceImportRequestSchema = z.object({ schemaVersion: z.literal("evleda.plane-runtime-source-import-request.v1"),
  workspaceRoot: z.string(), sourceProjectId: z.string().uuid(), targetProjectId: z.string().uuid(),
  sourceProfile: pinned, targetProfile: pinned, sourcePins: sources,
  normalClose: z.object({ session: pinned, response: pinned }).strict(), runtimeQualification: pinned }).strict();
export type RuntimeSourceImportRequest = z.infer<typeof runtimeSourceImportRequestSchema>;
export const runtimeSourceImportLineageSchema = z.object({ schemaVersion: z.literal("evleda.plane-runtime-source-import-lineage.v1"),
  requestIdentity: canonical, sourceProjectId: z.string().uuid(), targetProjectId: z.string().uuid(), sourceProfile: pinned, targetProfile: pinned,
  bundleIdentity: canonical, sourceSnapshotIdentity: canonical, sourcePins: sources,
  normalClose: z.object({ session: pinned, request: pinned, response: pinned }).strict(), runtimeQualification: pinned,
  nativeEvidenceTransferred: z.literal(false), identity: canonical }).strict();
export type RuntimeSourceImportLineage = z.infer<typeof runtimeSourceImportLineageSchema>;
export function parseRuntimeSourceImportLineage(value: unknown): RuntimeSourceImportLineage {
  const result = runtimeSourceImportLineageSchema.parse(value), { identity, ...payload } = result;
  need(same(identity, canonicalIdentity(payload, result.schemaVersion)), "lineage identity does not reproduce");
  return freezePcbPlaneArtifact(result);
}
const pinOf = (value: z.infer<typeof publishedPin>): KicadMcpPinnedFileInput => ({ path: value.path,
  contentIdentity: { algorithm: "sha256", digest: value.sha256, size: value.sizeBytes } });
const json = (bytes: Uint8Array) => parsePortableJsonBytes(bytes, { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 500000,
  maxArrayLength: 20000, maxOwnKeys: 4096, maxKeyBytes: 4096, maxStringBytes: 1024 * 1024 });
const object = (value: unknown): Record<string, any> => { need(value !== null && typeof value === "object" && !Array.isArray(value), "expected bounded object"); return value as Record<string, any>; };
const exactBytes = (bytes: Buffer) => { const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  need(Buffer.from(text).equals(bytes), "nonexact UTF-8 source"); return text; };
async function captureTargetSettings(file: string) {
  const parents = [];
  for (let directory = path.dirname(file);; directory = path.dirname(directory)) {
    const physical = await readFreshDirectoryIdentity(directory); need(physical.dev !== null && physical.ino !== null, "target ancestry lacks physical identity");
    parents.push(physical); if (path.dirname(directory) === directory) break;
  }
  const pathBefore = await lstat(file, { bigint: true });
  need(pathBefore.isFile() && !pathBefore.isSymbolicLink() && pathBefore.nlink === 1n, "target settings are not an ordinary unshared source");
  const handle = await open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const atPath = await lstat(file, { bigint: true });
    need(["dev", "ino", "size", "mtimeNs", "ctimeNs", "birthtimeNs", "nlink"].every(key => pathBefore[key as keyof typeof before] === before[key as keyof typeof before]
      && atPath[key as keyof typeof before] === before[key as keyof typeof before]) && !atPath.isSymbolicLink(), "target settings changed while opening");
    for (const parent of parents) need(same(parent, await readFreshDirectoryIdentity(parent.canonicalPath)), "target ancestry changed before reading");
    need(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= 2n * 1024n * 1024n, "target settings exceed their ordinary-file bound");
    const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < buffer.length) { const result = await handle.read(buffer, count, buffer.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
    const after = await handle.stat({ bigint: true });
    need(["dev", "ino", "size", "mtimeNs", "ctimeNs", "birthtimeNs", "nlink"].every(key => before[key as keyof typeof before] === after[key as keyof typeof after])
      && BigInt(count) === before.size, "target settings changed during capture");
    return await captureFreshRuntimeImportFile({ path: file, contentIdentity: contentIdentity(buffer.subarray(0, count)) }, 2 * 1024 * 1024);
  } finally { await handle.close(); }
}

/** No process launch: bridge construction and assertCurrent hash the full runtime
 * closure and pinned binaries. Only target opening later may start native CAD. */
async function runtimeAuthority(profile: Awaited<ReturnType<typeof readKicadNativeProfile>>, protectedRoots: readonly string[]) {
  const r = profile.kicadMcpRuntime, c = r.runtimeBundle.expectedClosure;
  return createKicadMcpRuntimeBridge({ lockFile: { path: r.lock.path, contentIdentity: r.lock.identity },
    runtimeBundle: { root: r.runtimeBundle.root, manifestFile: { path: r.runtimeBundle.manifest.path, contentIdentity: r.runtimeBundle.manifest.identity },
      expectedClosure: { fileCount: c.fileCount, manifestIdentity: c.manifestIdentity, treeIdentity: c.treeIdentity, protocol: c.protocol,
        python: { relativePath: c.python.relativePath, contentIdentity: c.python.identity }, entrypoint: { relativePath: c.entrypoint.relativePath, contentIdentity: c.entrypoint.identity } } },
    runtimeParentRoot: r.runtimeParentRoot, ipcSocketParentRoot: r.ipcSocketParentRoot,
    verificationTimeoutMs: KICAD_MCP_INSPECTION_VERIFICATION_TIMEOUT_MS,
    ...(r.runtimePolicy.connectionDeadlinePolicy === undefined ? {} : { connectionDeadlinePolicy: r.runtimePolicy.connectionDeadlinePolicy }),
    kicadCli: { path: profile.kicadToolchain.kicadCli.path, contentIdentity: profile.kicadToolchain.kicadCli.identity },
    processTreeSupervision: { strategy: r.processTreeSupervision.strategy, timeoutMs: r.processTreeSupervision.terminationTimeoutMs,
      terminator: { path: r.processTreeSupervision.terminator.path, contentIdentity: r.processTreeSupervision.terminator.identity } },
    environment: { SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot, WINDIR: process.env.WINDIR ?? process.env.windir }, protectedRoots });
}

/** Trusted dependency seams; the administration JSON/CLI accepts none of them. */
export interface RuntimeSourceImportDependencies {
  readonly loadDesignProfile?: typeof loadKicadToolboxFreshProfile;
  readonly readNativeProfile?: typeof readKicadNativeProfile;
  readonly runtimeAuthority?: typeof runtimeAuthority;
  readonly openBinding?: typeof openFreshNativeToolboxBinding;
}
export interface QualifiedRuntimeSourceImport { readonly kind: "qualified-plane-runtime-source-import"; readonly lineage: RuntimeSourceImportLineage }
const imports = new WeakMap<object, { consumed: boolean; execute: () => Promise<Readonly<Record<string, unknown>>>; release: () => Promise<void> }>();

export async function qualifyRuntimeSourceImport(rawRequest: unknown, store: ToolboxWorkspaceStore,
  dependencies: RuntimeSourceImportDependencies = {}): Promise<QualifiedRuntimeSourceImport> {
  const request = freezePcbPlaneArtifact(runtimeSourceImportRequestSchema.parse(structuredClone(rawRequest)));
  dependencies = Object.freeze({ ...dependencies });
  need(request.sourceProjectId !== request.targetProjectId && path.resolve(request.workspaceRoot) === request.workspaceRoot, "source and new target allocation must be distinct and canonical");
  const foundSource = await store.lookup(request.sourceProjectId); need(foundSource !== undefined, "source allocation is unknown");
  const sourceRecord = freezePcbPlaneArtifact(structuredClone(foundSource));
  need(sourceRecord.outputDir === path.join(request.workspaceRoot, "projects", request.sourceProjectId, "output"), "source store is not the pinned workspace");
  const sourceLease = await store.acquireLease(request.sourceProjectId); need(sourceLease.assertCurrent !== undefined, "source lease lacks currentness authority");
  const assertSourceAllocation = async () => {
    await sourceLease.assertCurrent!(); need(same(await store.lookup(request.sourceProjectId), sourceRecord), "source allocation or exact input draft changed");
    await sourceLease.assertCurrent!();
  };
  let sourceReleased = false, currentSource: Awaited<ReturnType<typeof captureReadonlyPlaneRuntimeImportSource>> | undefined;
  const releaseSource = async () => {
    await assertSourceAllocation();
    if (currentSource !== undefined) await assertReadonlyPlaneRuntimeImportSourceCurrent(currentSource);
    await sourceLease.assertCurrent!(); await sourceLease.release(); sourceReleased = true;
  };
  try {
    const evidence = new Map<string, Awaited<ReturnType<typeof captureFreshRuntimeImportFile>>>();
    const capture = async (pin: KicadMcpPinnedFileInput, limit = 16 * 1024 * 1024) => {
      const value = await captureFreshRuntimeImportFile(pin, limit), previous = evidence.get(pin.path);
      if (previous !== undefined) need(previous.physical === value.physical && same(previous.contentIdentity, value.contentIdentity), "proof identity changed during capture");
      evidence.set(pin.path, value); return value;
    };
    const oldRaw = object(json((await capture(request.sourceProfile, 2 * 1024 * 1024)).bytes));
    const newRaw = object(json((await capture(request.targetProfile, 2 * 1024 * 1024)).bytes));
    const proof = qualificationSchema.parse(json((await capture(request.runtimeQualification)).bytes));
    need(same(pinOf(proof.sourceProfile), request.sourceProfile) && same(pinOf(proof.targetProfile), request.targetProfile), "runtime qualification names different profiles");
    need(same([...proof.profilePolicyComparison.allowedPaths].sort(), [...PROFILE_CHANGES].sort())
      && same(proof.allowedRuntimeChanges.map(change => change.path).sort(), [...RUNTIME_CHANGES].sort()), "runtime qualification has broader change authority");
    const projectProfile = (input: Record<string, any>) => {
      const result = structuredClone(input); delete result.kicadMcpRuntime.runtimeBundle; delete result.kicadMcpRuntime.processTreeSupervision.terminator.path;
      // This is derived from the fixed four isolation flags plus the relocated
      // launcher. The real native readers below independently reproduce it;
      // flags, argument count, bytecode and all other security policy stay exact.
      delete result.kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256;
      return result;
    };
    need(same(projectProfile(oldRaw), projectProfile(newRaw)), "profile policy, libraries, KiCad or non-runtime requirements changed");
    const readNative = dependencies.readNativeProfile ?? readKicadNativeProfile, loadDesign = dependencies.loadDesignProfile ?? loadKicadToolboxFreshProfile;
    const [oldNative, newNative, oldDesign, newDesign] = await Promise.all([readNative(request.sourceProfile), readNative(request.targetProfile), loadDesign(request.sourceProfile), loadDesign(request.targetProfile)]);
    const oldDependencies = { ...oldDesign.dependencies, deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(oldDesign.deepRuleSelectionOptions) };
    const newDependencies = { ...newDesign.dependencies, deepRuleSelectionOptions: normalizePcbPlaneSelectionPolicy(newDesign.deepRuleSelectionOptions) };
    const oldRuntime = oldNative.kicadMcpRuntime.runtimeBundle, newRuntime = newNative.kicadMcpRuntime.runtimeBundle;
    const runtimeRecord = (r: typeof oldRuntime) => ({ root: r.root, manifest: { path: r.manifest.path, sha256: r.manifest.identity.digest, sizeBytes: r.manifest.identity.size },
      manifestIdentity: r.expectedClosure.manifestIdentity, treeIdentity: r.expectedClosure.treeIdentity, fileCount: r.expectedClosure.fileCount, totalBytes: r.expectedClosure.totalBytes });
    need(same(proof.sourceRuntime, runtimeRecord(oldRuntime)) && same(proof.targetRuntime, runtimeRecord(newRuntime)) && oldRuntime.root !== newRuntime.root, "runtime closure receipt differs from pinned profiles");
    const invariantClosure = ({ manifestIdentity: _manifest, treeIdentity: _tree, totalBytes: _bytes, ...rest }: typeof oldRuntime.expectedClosure) => rest;
    need(same(invariantClosure(oldRuntime.expectedClosure), invariantClosure(newRuntime.expectedClosure)), "runtime Python, entrypoint or protocol selection changed");
    const manifests = await Promise.all([oldRuntime, newRuntime].map(async r => {
      const bytes = (await capture({ path: r.manifest.path, contentIdentity: r.manifest.identity }, 8 * 1024 * 1024)).bytes;
      const summary = parseKicadMcpInspectionRuntimeManifestSummary(bytes);
      need(same(summary.manifestIdentity, r.expectedClosure.manifestIdentity) && same(summary.treeIdentity, r.expectedClosure.treeIdentity), "manifest canonical identity changed");
      return object(json(bytes));
    }));
    const [oldManifest, newManifest] = manifests as [Record<string, any>, Record<string, any>];
    const invariantManifest = ({ identity: _identity, treeIdentity: _tree, totalBytes: _bytes, files: _files, ...rest }: Record<string, any>) => rest;
    need(same(invariantManifest(oldManifest), invariantManifest(newManifest)), "runtime directory inventory or immutable manifest policy changed");
    const changes = new Map(proof.allowedRuntimeChanges.map(change => [change.path, change]));
    need(proof.allowedRuntimeChanges.every(change => !same(change.before, change.after)
      && oldManifest.files.some((file: Record<string, unknown>) => file.path === change.path)
      && newManifest.files.some((file: Record<string, unknown>) => file.path === change.path)), "qualified runtime correction does not identify three actual changed leaves");
    const expectedFiles = (oldManifest.files as Record<string, any>[]).map(file => {
      const change = changes.get(file.path); if (change === undefined) return file;
      need(file.sha256 === change.before.sha256 && file.sizeBytes === change.before.sizeBytes, "runtime correction source leaf differs");
      return { ...file, ...change.after };
    });
    need(same(expectedFiles, newManifest.files) && newManifest.totalBytes === oldManifest.totalBytes + proof.allowedRuntimeChanges.reduce((sum, change) => sum + change.after.sizeBytes - change.before.sizeBytes, 0), "runtime differs beyond the three qualified leaf contents");
    const oldTerminator = oldNative.kicadMcpRuntime.processTreeSupervision.terminator, newTerminator = newNative.kicadMcpRuntime.processTreeSupervision.terminator;
    const relativeTerminator = path.relative(oldRuntime.root, oldTerminator.path);
    need(relativeTerminator !== "" && !relativeTerminator.startsWith("..") && !path.isAbsolute(relativeTerminator)
      && newTerminator.path === path.join(newRuntime.root, relativeTerminator) && same(oldTerminator.identity, newTerminator.identity), "terminator relocation changed executable authority");
    const cfg = proof.allowedRuntimeChanges.find(change => change.path === "environment/pyvenv.cfg")!;
    const cfgOld = exactBytes((await capture({ path: path.join(oldRuntime.root, cfg.path), contentIdentity: pinOf({ path: "unused", ...cfg.before }).contentIdentity })).bytes);
    const cfgNew = exactBytes((await capture({ path: path.join(newRuntime.root, cfg.path), contentIdentity: pinOf({ path: "unused", ...cfg.after }).contentIdentity })).bytes);
    need(cfgOld.startsWith(`home = ${path.join(oldRuntime.root, "python")}\n`)
      && cfgNew === cfgOld.replace(`home = ${path.join(oldRuntime.root, "python")}\n`, `home = ${path.join(newRuntime.root, "python")}\n`), "pyvenv changes exceed exact home relocation");
    const oracle = object(json((await capture(pinOf(proof.oracle))).bytes)), qualificationReport = object(json((await capture(pinOf(proof.qualification.report))).bytes));
    const { report: _reportPin, ...checks } = proof.qualification, expectedCli = oldNative.kicadToolchain.kicadCli;
    need(qualificationReport.schemaVersion === "evleda.schematic-cardinal-runtime-qualification-report.v1"
      && ["sourceProfile", "targetProfile", "sourceRuntime", "targetRuntime", "oracle"].every(key => same(qualificationReport[key], proof[key as keyof typeof proof]))
      && same(qualificationReport.checks, checks), "qualification report contradicts its pinned receipt");
    need(oracle.schemaVersion === "evleda.native-schematic-cardinal-oracle.v1" && oracle.nativeExecution === true && oracle.sourcesUnchanged === true
      && oracle.version === expectedCli.operationalVersion && same(oracle.cliIdentity, expectedCli.identity) && same(proof.oracle.cliIdentity, expectedCli.identity)
      && Array.isArray(oracle.inputs) && oracle.inputs.length === 3 && Array.isArray(oracle.cases) && oracle.cases.length === 12
      && Array.isArray(oracle.observations) && oracle.observations.length === 36, "oracle contents contradict the qualified native cardinal evidence");
    const summaryChecks = ["publicPinPositions", "exactPinAliases", "publicConnectivityGraph", "visualBounds"];
    const mismatchCounts = ["pinMismatches", "aliasMismatches", "graphMismatches", "visualPinMismatches", "visualStrokeMismatches", "visualBoxFailures"];
    need(summaryChecks.every(key => qualificationReport.targetSummary?.[key] === true && qualificationReport.sourceSummary?.[key] === false)
      && mismatchCounts.every(key => qualificationReport.targetSummary?.[key] === 0 && Number.isSafeInteger(qualificationReport.sourceSummary?.[key])
        && qualificationReport.sourceSummary[key] > 0), "qualification summaries contradict corrected runtime or negative control");
    for (const side of ["source", "target"] as const) {
      const observation = object(json((await capture(pinOf(publishedPin.parse(qualificationReport[`${side}Observations`])))).bytes));
      need(observation.schemaVersion === "evleda.schematic-cardinal-runtime-observation.v1" && observation.runtimeRoot === proof[`${side}Runtime`].root
        && same(observation.oracle, { path: proof.oracle.path, sha256: proof.oracle.sha256, sizeBytes: proof.oracle.sizeBytes })
        && same(observation.summary, qualificationReport[`${side}Summary`]) && observation.fixtureUnchanged === true
        && same(observation.pythonFlags, { isolated: true, noUserSite: true, ignoreEnvironment: true, noBytecode: true, utf8: true }), "runtime observation contradicts its qualification report");
      await capture(pinOf(publishedPin.parse(qualificationReport.closureChecks?.[side])));
    }
    const recapture = object(json((await capture(pinOf(publishedPin.parse(qualificationReport.nativeStrictRecapture)))).bytes));
    need(recapture.observationsEqual === true && recapture.casesEqual === true && recapture.sourceBytesEqual === true && recapture.sourcesUnchanged === true
      && recapture.logicalPins === 36 && same(recapture.pythonFlags, { isolated: 1, ignoreEnvironment: 1, noUserSite: 1, dontWriteBytecode: 1, utf8Mode: 1 }), "strict native oracle recapture is not equivalent");
    const session = object(json((await capture(request.normalClose.session)).bytes));
    const response = object(json((await capture(request.normalClose.response)).bytes));
    need(path.dirname(request.normalClose.session.path) === path.dirname(request.normalClose.response.path), "close custody evidence roots differ");
    const linked = object(response.request), closeRequest = pinned.parse({ path: linked.path, contentIdentity: linked.identity });
    need(path.dirname(closeRequest.path) === path.dirname(request.normalClose.response.path), "linked close request escaped its evidence root");
    const command = object(json((await capture(closeRequest)).bytes));
    need(Object.keys(command).sort().join("\0") === "arguments\0id\0name\0operation" && command.operation === "call"
      && command.name === "evleda_close_project" && same(command.arguments, { projectId: request.sourceProjectId }), "normal close custody selects a different operation/project");
    need(response.disposition === "response" && response.isError === false && [undefined, false].includes(response.result?.isError)
      && same(response.result?.structuredContent, { status: "closed", projectId: request.sourceProjectId, designAcceptance: "not_implied" }), "source lacks an exact successful normal workspace close response");
    need(same(session.serverArgs, ["--profile", request.sourceProfile.path, "--profile-sha256", request.sourceProfile.contentIdentity.digest,
      "--profile-bytes", String(request.sourceProfile.contentIdentity.size), "--workspace-root", request.workspaceRoot, "--edit"]), "normal close session used another profile/workspace/policy");
    const bundleBytes = (await capture({ path: path.join(sourceRecord.outputDir, "toolbox-design-bundle.json"), contentIdentity: request.sourcePins.bundle }, 8 * 1024 * 1024)).bytes;
    const oldBundle = parsePcbPlaneCompilationBundle(bundleBytes, oldDependencies), newBundle = parsePcbPlaneCompilationBundle(bundleBytes, newDependencies);
    need(same(oldBundle, newBundle) && Buffer.from(serializePcbPlaneCompilationBundle(oldBundle)).equals(bundleBytes), "old/new complete bundle or library authority differs");
    const compilation = compilePcbPlaneDesignIntentDraft(sourceRecord.draft, newDependencies);
    need(compilation.disposition === "ready" && same(createPcbPlaneCompilationBundle({ compilation, originalPrompt: sourceRecord.originalPrompt }, newDependencies).identity, oldBundle.identity), "allocation draft/prompt does not reproduce the identical bundle");
    currentSource = await captureReadonlyPlaneRuntimeImportSource({ outputDir: sourceRecord.outputDir, name: sourceRecord.name, compilationBundle: oldBundle, pins: request.sourcePins });
    const report = object(json(Buffer.from(readReadonlyPlaneRuntimeImportSource(currentSource, "report"))));
    need(report.assurance === "Saved candidate checkpoint after confirmed native teardown. Pending design requirements and findings remain unverified; this is not design acceptance.", "source report is not the normal closed checkpoint report");
    const closeTime = Date.parse(response.recordedAt), sessionTime = Date.parse(session.startedAt);
    need(Number.isFinite(closeTime) && Number.isFinite(sessionTime) && sessionTime <= closeTime, "close custody timestamps are invalid");
    for (const key of ["checkpoint", "report"] as const) {
      const captured = await capture(currentSource.files[key]);
      need(BigInt(captured.mtimeNs) <= BigInt(closeTime) * 1_000_000n + 999_999n, "source checkpoint/report is newer than its successful close custody");
    }
    const pcb = readReadonlyPlaneRuntimeImportSource(currentSource, "pcb"), schematic = readReadonlyPlaneRuntimeImportSource(currentSource, "sch");
    need(pcb === createInterfaceConstructionBoardSeed(oldBundle) && !parseFreshPcbSourceDocument(pcb).children.some(n => ["footprint", "segment", "via", "zone"].includes(n.name)), "source PCB is materialized or not its exact unmaterialized baseline");
    const root = parseFreshSchematicSourceDocument(schematic), librarySources = new Map<string, { source: string; identity: ReturnType<typeof contentIdentity> }>();
    let libraryBytes = 0;
    for (const id of new Set(root.children.filter(n => n.name === "symbol").map(n => n.children.find(c => c.name === "lib_id")?.values[0]?.value))) {
      const pin = oldBundle.libraryBinding.sourceSelection?.records.find(record => record.kind === "symbol" && record.libraryId === id);
      need(pin !== undefined && typeof id === "string", "source symbol lacks an exact inspected library binding");
      const file = path.resolve(pin.approvedPackage?.tableUri ?? path.join(oldDesign.libraryEnvironment.KICAD10_SYMBOL_DIR, `${id.split(":")[0]}.kicad_sym`));
      if (!evidence.has(file)) { libraryBytes += pin.sourceIdentity.size; need(libraryBytes <= 64 * 1024 * 1024, "library source aggregate exceeds its bound"); }
      const bytes = (await capture({ path: file, contentIdentity: pin.sourceIdentity }, 24 * 1024 * 1024)).bytes;
      librarySources.set(id, { source: exactBytes(bytes), identity: pin.sourceIdentity });
    }
    const authority = dependencies.runtimeAuthority ?? runtimeAuthority;
    const protectedRoots = [...new Set([request.workspaceRoot, path.dirname(request.sourceProfile.path), path.dirname(request.targetProfile.path),
      oldNative.kicadToolchain.binRoot, ...oldDesign.protectedRoots, ...newDesign.protectedRoots])];
    const oldRuntimeAuthority = await authority(oldNative, protectedRoots), newRuntimeAuthority = await authority(newNative, protectedRoots);
    const assertCurrent = async () => {
      await assertSourceAllocation(); await assertReadonlyPlaneRuntimeImportSourceCurrent(currentSource!);
      for (const previous of evidence.values()) {
        const next = await captureFreshRuntimeImportFile(previous, Math.max(previous.bytes.length, 1));
        need(previous.physical === next.physical && same(previous.parents, next.parents), "profile, library or qualification custody changed");
      }
      parsePcbPlaneCompilationBundle(bundleBytes, oldDependencies); parsePcbPlaneCompilationBundle(bundleBytes, newDependencies);
      await oldRuntimeAuthority.assertCurrent(); await newRuntimeAuthority.assertCurrent(); await sourceLease.assertCurrent!();
    };
    await assertCurrent();
    const seed = issueFreshPlaneSchematicSeed({ source: schematic, name: sourceRecord.name, bundle: newBundle, profile: request.targetProfile, librarySources, assertCurrent });
    const payload = { schemaVersion: "evleda.plane-runtime-source-import-lineage.v1" as const,
      requestIdentity: canonicalIdentity(request, request.schemaVersion), sourceProjectId: request.sourceProjectId, targetProjectId: request.targetProjectId,
      sourceProfile: request.sourceProfile, targetProfile: request.targetProfile, bundleIdentity: newBundle.identity,
      sourceSnapshotIdentity: currentSource.identity, sourcePins: request.sourcePins,
      normalClose: { ...request.normalClose, request: closeRequest }, runtimeQualification: request.runtimeQualification, nativeEvidenceTransferred: false as const };
    const lineage = parseRuntimeSourceImportLineage({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
    const capability: QualifiedRuntimeSourceImport = Object.freeze({ kind: "qualified-plane-runtime-source-import", lineage });
    imports.set(capability, { consumed: false, release: releaseSource, execute: async () => {
      let binding: Awaited<ReturnType<typeof openFreshNativeToolboxBinding>> | undefined, targetLease: Awaited<ReturnType<ToolboxWorkspaceStore["acquireLease"]>> | undefined;
      let completed = false, primary: unknown;
      const toolbox = createKicadToolboxMcpServer({ access: "edit" });
      try {
        await assertCurrent();
        const allocation = await store.allocate({ projectId: request.targetProjectId, name: sourceRecord.name, draft: sourceRecord.draft,
          draftIdentity: sourceRecord.draftIdentity, originalPrompt: sourceRecord.originalPrompt, runtimeSourceImportLineage: lineage });
        if (!allocation.created) { await releaseSource(); return Object.freeze({ status: "already_created", projectId: allocation.projectId, lineage }); }
        targetLease = await store.acquireLease(allocation.projectId); need(targetLease.assertCurrent !== undefined, "target lease lacks currentness authority");
        binding = await (dependencies.openBinding ?? openFreshNativeToolboxBinding)({ profile: request.targetProfile, projectDir: allocation.inputDir,
          outputDir: allocation.outputDir, edit: true, resume: false,
          fresh: { name: sourceRecord.name, draft: sourceRecord.draft, originalPrompt: sourceRecord.originalPrompt, expectedBundleIdentity: newBundle.identity, schematicSeed: seed } });
        await assertCurrent(); await targetLease.assertCurrent(); await releaseSource();
        toolbox.attachCad({ ...binding, onFinished: async outcome => {
          need(outcome.nativeSessionClosed && outcome.checkpointPublished && !outcome.recoveryRequired, "new target native finish is uncertain"); completed = true;
        } });
        await toolbox.finishCad(); need(completed, "new target lacks successful normal finish");
        await targetLease.assertCurrent();
        const targetProject = path.join(allocation.outputDir, "project");
        const targetFiles = { sch: `${sourceRecord.name}.kicad_sch`, pcb: `${sourceRecord.name}.kicad_pcb`, dru: `${sourceRecord.name}.kicad_dru`,
          symLibTable: "sym-lib-table", fpLibTable: "fp-lib-table" } as const;
        const targetCaptures = [];
        for (const [key, filename] of Object.entries(targetFiles) as [keyof typeof targetFiles, string][]) {
          targetCaptures.push(await captureFreshRuntimeImportFile({ path: path.join(targetProject, filename), contentIdentity: request.sourcePins[key] }, 2 * 1024 * 1024));
        }
        targetCaptures.push(await captureFreshRuntimeImportFile({ path: path.join(allocation.outputDir, "toolbox-design-bundle.json"), contentIdentity: request.sourcePins.bundle }, 8 * 1024 * 1024));
        const targetSettings = await captureTargetSettings(path.join(targetProject, `${sourceRecord.name}.kicad_pro`));
        need(same(json(targetSettings.bytes), json(Buffer.from(readReadonlyPlaneRuntimeImportSource(currentSource!, "pro")))), "new target project settings differ from the unchanged source policies");
        targetCaptures.push(targetSettings);
        for (const before of targetCaptures) { const after = await captureFreshRuntimeImportFile(before, Math.max(before.bytes.length, 1));
          need(before.physical === after.physical && same(before.parents, after.parents), "new target changed before custody publication"); }
        await targetLease.assertCurrent();
        const custody = { schemaVersion: "evleda.plane-runtime-source-import-custody.v1", status: "new-target-normally-closed", lineage,
          nativeEvidenceTransferred: false, targetNativeLifecycle: "normal-new-project-open-save-checkpoint-close",
          targetFiles: targetCaptures.map(file => ({ path: file.path, contentIdentity: file.contentIdentity })) };
        await writeFile(path.join(allocation.outputDir, "runtime-source-import-custody.json"), `${JSON.stringify(custody, null, 2)}\n`, { flag: "wx" });
        await targetLease.release();
        return Object.freeze({ status: "imported", projectId: allocation.projectId, lineage, nativeEvidenceTransferred: false });
      } catch (error) {
        primary = error;
        const faults: unknown[] = [error];
        if (binding !== undefined && toolbox.getCadState() === "absent") {
          try { await binding.cad.recordRecoveryRequired?.("Runtime source import failed before target attachment; allocation retained."); } catch (failure) { faults.push(failure); }
          try { await binding.cad.close(); } catch (failure) { faults.push(failure); }
        }
        primary = new AggregateError(faults, "Runtime import did not complete; target allocation and any uncertain lease were retained for review.");
        throw primary;
      } finally {
        const faults: unknown[] = [];
        try { await toolbox.close(); } catch (error) { faults.push(error); }
        try { if (!sourceReleased) await releaseSource(); } catch (error) { faults.push(error); }
        if (faults.length) throw new AggregateError(primary === undefined ? faults : [primary, ...faults], "Runtime import cleanup is uncertain; owned leases retained where currentness could not be proven.");
      }
    } });
    return capability;
  } catch (error) {
    try { await releaseSource(); } catch (releaseError) { throw new AggregateError([error, releaseError], "Runtime import source drift; owned source lease retained for review."); }
    throw error;
  }
}
export async function executeQualifiedRuntimeSourceImport(capability: QualifiedRuntimeSourceImport): Promise<Readonly<Record<string, unknown>>> {
  const state = imports.get(capability); need(state !== undefined && !state.consumed, "forged or already consumed import authority"); state.consumed = true;
  return state.execute();
}
export async function releaseQualifiedRuntimeSourceImport(capability: QualifiedRuntimeSourceImport): Promise<void> {
  const state = imports.get(capability); need(state !== undefined && !state.consumed, "forged or already consumed import authority"); state.consumed = true;
  await state.release();
}

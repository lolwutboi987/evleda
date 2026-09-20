import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { parsePortableJsonBytes } from "../core/portable-artifact.js";
import { captureFreshRuntimeImportFile } from "../harness/fresh-project.js";
import { freshBoardSerializationsEqual } from "../harness/fresh-board-serialization.js";
import { compareFreshPlaneRefillPreservation, parseFreshPcbReferenceGeometry, parseFreshPcbTextItems } from "../harness/fresh-kicad-parser.js";
import { assertOnlyRequestedPcbTextAdded, parsePcbSilkscreenText } from "../harness/pcb-silkscreen-text.js";
import { createFreshConnectivityContract } from "../harness/fresh-connectivity-contract.js";
import { parseFreshFootprintFieldUpdates, planFreshFootprintFields } from "../harness/fresh-footprint-field.js";
import { decodePlaneStageReceipt } from "../integrations/kicad-plane-stage-receipt.js";
import { compilePcbPlaneDesignIntentDraft } from "../harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle, parsePcbPlaneCompilationBundle } from "../harness/pcb-design-plane-bundle.js";
import { issueFreshPlanePlacementSeed, freshPlanePlacementSeedPlan } from "../harness/fresh-plane-placement-seed.js";
import { parsePlacementRevisionLineage } from "./toolbox-placement-revision.js";
import { loadKicadToolboxFreshProfile } from "./toolbox-fresh-profile.js";
import { openFreshNativeToolboxBinding } from "./toolbox-fresh-main.js";
import { createKicadToolboxMcpServer } from "./toolbox-server.js";
import type { ToolboxWorkspaceStore } from "./toolbox-workspace-store.js";
import { freezePcbPlaneArtifact } from "../harness/pcb-design-plane-contract.js";
import { readFile } from "node:fs/promises";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function need(value: unknown, message: string): asserts value { if (!value) throw new Error(`Saved-plane recovery: ${message}`); }
const identity = z.object({ algorithm: z.literal("sha256"), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive().max(8 * 1024 * 1024) }).strict();
const pin = z.object({ path: z.string().min(1).max(4096), contentIdentity: identity }).strict();
const nativePins = z.object({ pcb: identity, sch: identity, pro: identity, dru: identity, fpLibTable: identity, symLibTable: identity }).strict();
const legacySavedPlaneRecoveryRequestSchema = z.object({ schemaVersion: z.literal("evleda.saved-plane-recovery-request.v1"),
  workspaceRoot: z.string().min(1), sourceProjectId: z.string().uuid(), targetProjectId: z.string().uuid(), profile: pin,
  targetIntent: pin, sourceNativePins: nativePins, session: pin, savedPlaneResponse: pin, failedPlaneResponse: pin,
  failedCloseResponse: pin, clientTerminal: pin, planeStage: pin, archivedLivePcb: pin }).strict();
export const savedFieldRecoveryRequestSchema = legacySavedPlaneRecoveryRequestSchema.omit({ savedPlaneResponse: true,
  failedPlaneResponse: true, planeStage: true }).extend({ schemaVersion: z.literal("evleda.saved-field-recovery-request.v1"),
  savedPoseResponse: pin, failedFieldResponse: pin }).strict();
export const savedPlaneArtifactRecoveryRequestSchema = legacySavedPlaneRecoveryRequestSchema.omit({ savedPlaneResponse: true,
  planeStage: true }).extend({ schemaVersion: z.literal("evleda.saved-plane-artifact-recovery-request.v1"),
  sourceProfile: pin, openedProjectResponse: pin, savedTextResponse: pin, liveObservation: pin, checkedDiscardClose: pin }).strict();
export const savedPlaneRecoveryRequestSchema = z.union([legacySavedPlaneRecoveryRequestSchema, savedFieldRecoveryRequestSchema,
  savedPlaneArtifactRecoveryRequestSchema]);
export type SavedPlaneRecoveryRequest = z.infer<typeof savedPlaneRecoveryRequestSchema>;
const json = (bytes: Uint8Array): Record<string, any> => {
  const value = parsePortableJsonBytes(bytes, { maxBytes: 8 * 1024 * 1024, maxStringBytes: 1024 * 1024,
    maxDepth: 64, maxNodes: 500_000, maxArrayLength: 100_000, maxOwnKeys: 4096, maxKeyBytes: 2048 });
  need(value !== null && typeof value === "object" && !Array.isArray(value), "expected a bounded object"); return value as Record<string, any>;
};
const exactText = (bytes: Buffer) => { const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  need(Buffer.from(value).equals(bytes), "source is not exact scalar UTF-8"); return value; };
const details = (reply: Record<string, any>) => reply.result?.structuredContent;
const decoded = (value: any) => { need(value && typeof value.content === "string", "missing structured operation body"); return json(Buffer.from(value.content)); };
const normalized = (value: string) => path.resolve(value).toLowerCase();

/** This case admits only the published DOC16 -> DOC17 receipt-budget overlay.
 * Native startup independently verifies the complete selected runtime closure. */
async function verifyReceiptRuntimeUpgrade(sourcePin: z.infer<typeof pin>, targetPin: z.infer<typeof pin>,
  capture: (value: z.infer<typeof pin>, maximum?: number) => Promise<Awaited<ReturnType<typeof captureFreshRuntimeImportFile>>>): Promise<void> {
  const before = json((await capture(sourcePin)).bytes), after = json((await capture(targetPin)).bytes);
  const policy = (value: Record<string, any>) => {
    const copy = structuredClone(value);
    need(copy.kicadMcpRuntime?.runtimeBundle && copy.kicadMcpRuntime?.processTreeSupervision?.terminator
      && copy.kicadMcpRuntime?.runtimePolicy?.pythonLaunch, "runtime upgrade profile is incomplete");
    delete copy.kicadMcpRuntime.runtimeBundle;
    delete copy.kicadMcpRuntime.processTreeSupervision.terminator.path;
    delete copy.kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256;
    return copy;
  };
  need(same(policy(before), policy(after)), "runtime upgrade changed non-runtime policy or libraries");
  const oldRuntime = before.kicadMcpRuntime.runtimeBundle, newRuntime = after.kicadMcpRuntime.runtimeBundle;
  need(path.isAbsolute(oldRuntime.root) && path.isAbsolute(newRuntime.root) && oldRuntime.root !== newRuntime.root,
    "runtime upgrade requires distinct absolute roots");
  const invariantClosure = ({ manifestIdentity: _manifest, treeIdentity: _tree, totalBytes: _bytes, ...rest }: Record<string, unknown>) => rest;
  need(same(invariantClosure(oldRuntime.expectedClosure), invariantClosure(newRuntime.expectedClosure)),
    "runtime upgrade changed Python, entrypoint, file count or protocol selection");
  const manifest = async (runtime: Record<string, any>) => json((await capture({ path: runtime.manifest.path,
    contentIdentity: { algorithm: "sha256", digest: runtime.manifest.sha256, size: runtime.manifest.sizeBytes } })).bytes);
  const oldManifest = await manifest(oldRuntime), newManifest = await manifest(newRuntime);
  need(Array.isArray(oldManifest.files) && Array.isArray(newManifest.files) && same(oldManifest.directories, newManifest.directories)
    && oldManifest.files.length === newManifest.files.length, "runtime file/directory inventory changed");
  for (const [declared, runtime] of [[oldManifest, oldRuntime], [newManifest, newRuntime]])
    need(declared.fileCount === declared.files.length && declared.fileCount === runtime.expectedClosure.fileCount
      && declared.totalBytes === declared.files.reduce((sum: number, file: Record<string, any>) => sum + file.sizeBytes, 0)
      && declared.totalBytes === runtime.expectedClosure.totalBytes
      && same(declared.identity, runtime.expectedClosure.manifestIdentity) && same(declared.treeIdentity, runtime.expectedClosure.treeIdentity),
      "runtime manifest summary differs from its profile closure");
  const index = (files: Record<string, any>[]) => {
    const result = new Map<string, Record<string, any>>();
    for (const f of files) {
      need(typeof f.path === "string" && !/[\\:]/u.test(f.path) && f.path.split("/").every(p => p && p !== "." && p !== "..")
        && !result.has(f.path), "runtime manifest has an unsafe or duplicate path"); result.set(f.path, f);
    }
    return result;
  };
  const oldFiles = index(oldManifest.files), newFiles = index(newManifest.files), changed: string[] = [];
  for (const [name, prior] of oldFiles) {
    const next = newFiles.get(name); need(next !== undefined, "runtime file inventory differs");
    if (!same(prior, next)) { need(prior.mode === next.mode, "runtime file mode changed"); changed.push(name); }
  }
  need(same(changed.sort(), ["environment/pyvenv.cfg", "evleda_plane_stage/compact_receipt.py"]), "runtime delta is not the exact receipt-budget overlay");
  const codec = "evleda_plane_stage/compact_receipt.py";
  need(oldFiles.get(codec)?.sha256 === "716dd527f827b3b7e0c715d60944cd02693f704878b19f8f1e391b401d1e9d74"
    && oldFiles.get(codec)?.sizeBytes === 3550
    && newFiles.get(codec)?.sha256 === "1217cf8a69fcad2c9ee84a857d9faa19f4db25771844dd67ea7645f9c1b185e8"
    && newFiles.get(codec)?.sizeBytes === 3759, "runtime codec is not the exact qualified predecessor/successor");
  const readLeaf = async (runtime: Record<string, any>, files: Map<string, Record<string, any>>, name: string) => {
    const record = files.get(name)!; return exactText((await capture({ path: path.join(runtime.root, ...name.split("/")),
      contentIdentity: { algorithm: "sha256", digest: record.sha256, size: record.sizeBytes } })).bytes);
  };
  await readLeaf(oldRuntime, oldFiles, codec); await readLeaf(newRuntime, newFiles, codec);
  const oldConfig = await readLeaf(oldRuntime, oldFiles, "environment/pyvenv.cfg"), newConfig = await readLeaf(newRuntime, newFiles, "environment/pyvenv.cfg");
  need(oldConfig.split(oldRuntime.root).length === 2 && newConfig === oldConfig.replace(oldRuntime.root, newRuntime.root),
    "runtime venv change exceeds exact home relocation");
}

/** Initial maintenance exclusion only. Subsequent source-pin checks remain live
 * while the new, independently leased target is opened. */
export async function assertSavedPlaneRecoveryQuiescent(workspaceRoot: string): Promise<void> {
  need(process.platform === "win32", "production recovery requires the characterized Windows process observer");
  const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(pcbnew|eeschema|node|python|pythonw)(\\.exe)?$' } | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress";
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(stdout.trim() || "[]"), rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const value of rows) {
    const row = value as { ProcessId?: number; Name?: string; CommandLine?: string | null };
    if (row.ProcessId === process.pid) continue;
    need(!/^(pcbnew|eeschema)(\.exe)?$/iu.test(row.Name ?? ""), "native editor remains; preserve it until checked closure");
    const text = row.CommandLine ?? "";
    need(!(text.toLowerCase().includes(workspaceRoot.toLowerCase()) && /toolbox-workspace-(main|client)/iu.test(text)), "workspace owner remains");
    need(!/\bkicad_mcp\b|toolbox-editor-supervisor/iu.test(text), "native sidecar or editor supervisor remains");
  }
}

export interface SavedPlaneRecoveryDependencies {
  readonly loadProfile?: typeof loadKicadToolboxFreshProfile;
  readonly assertQuiescent?: typeof assertSavedPlaneRecoveryQuiescent;
  readonly openBinding?: typeof openFreshNativeToolboxBinding;
}
export interface QualifiedSavedPlaneRecovery { readonly kind: "qualified-saved-plane-recovery";
  readonly plan: Readonly<Record<string, unknown>>; readonly identity: ReturnType<typeof canonicalIdentity> }
const qualified = new WeakMap<object, { consumed: boolean; execute: () => Promise<Readonly<Record<string, unknown>>> }>();

/** Operator-only, narrowly qualified copy of the LAST VERIFIED SAVED state.
 * No original file, checkpoint, quarantine marker, lease or staged state is edited. */
export async function qualifySavedPlaneRecovery(raw: unknown, store: ToolboxWorkspaceStore,
  dependencies: SavedPlaneRecoveryDependencies = {}): Promise<QualifiedSavedPlaneRecovery> {
  const request = freezePcbPlaneArtifact(savedPlaneRecoveryRequestSchema.parse(structuredClone(raw)));
  dependencies = Object.freeze({ ...dependencies });
  need(path.resolve(request.workspaceRoot) === request.workspaceRoot && request.sourceProjectId !== request.targetProjectId,
    "canonical workspace and distinct allocations are required");
  await (dependencies.assertQuiescent ?? assertSavedPlaneRecoveryQuiescent)(request.workspaceRoot);
  const source = await store.lookup(request.sourceProjectId); need(source !== undefined, "unknown source allocation");
  need(source.outputDir === path.join(request.workspaceRoot, "projects", source.projectId, "output"), "source allocation escaped workspace");
  need(await store.lookup(request.targetProjectId) === undefined, "target already exists; inspect its outcome instead of retrying recovery");
  const captured = new Map<string, Awaited<ReturnType<typeof captureFreshRuntimeImportFile>>>();
  const capture = async (value: z.infer<typeof pin>, maximum = 8 * 1024 * 1024) => {
    const file = await captureFreshRuntimeImportFile(value, maximum); const prior = captured.get(file.path);
    need(prior === undefined || prior.physical === file.physical, "evidence changed during inspection"); captured.set(file.path, file); return file;
  };
  const captureCurrent = async (file: string, maximum = 2 * 1024 * 1024) => {
    const stat = await lstat(file); need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximum, "unsupported source file");
    const bytes = await readFile(file);
    return capture({ path: file, contentIdentity: contentIdentity(bytes) }, maximum);
  };
  const profile = await (dependencies.loadProfile ?? loadKicadToolboxFreshProfile)(request.profile);
  const compiler = { ...profile.dependencies, deepRuleSelectionOptions: profile.deepRuleSelectionOptions };
  await capture(request.profile);
  const sourceProfilePin = request.schemaVersion === "evleda.saved-plane-artifact-recovery-request.v1" ? request.sourceProfile : request.profile;
  const sourceProfile = request.schemaVersion === "evleda.saved-plane-artifact-recovery-request.v1"
    ? await (dependencies.loadProfile ?? loadKicadToolboxFreshProfile)(sourceProfilePin) : profile;
  const sourceCompiler = { ...sourceProfile.dependencies, deepRuleSelectionOptions: sourceProfile.deepRuleSelectionOptions };
  if (request.schemaVersion === "evleda.saved-plane-artifact-recovery-request.v1")
    await verifyReceiptRuntimeUpgrade(request.sourceProfile, request.profile, capture);
  const bundleFile = await captureCurrent(path.join(source.outputDir, "toolbox-design-bundle.json"), 8 * 1024 * 1024);
  const sourceBundle = parsePcbPlaneCompilationBundle(bundleFile.bytes, sourceCompiler);
  const sourceCompilation = compilePcbPlaneDesignIntentDraft(source.draft, sourceCompiler);
  need(sourceCompilation.disposition === "ready" && same(createPcbPlaneCompilationBundle({ compilation: sourceCompilation,
    originalPrompt: source.originalPrompt }, sourceCompiler).identity, sourceBundle.identity), "allocation does not reproduce its bundle");
  const projectRoot = path.join(source.outputDir, "project"), names = { pcb: `${source.name}.kicad_pcb`, sch: `${source.name}.kicad_sch`,
    pro: `${source.name}.kicad_pro`, dru: `${source.name}.kicad_dru`, fpLibTable: "fp-lib-table", symLibTable: "sym-lib-table" } as const;
  const sources: Record<string, string> = {};
  for (const [key, name] of Object.entries(names) as [keyof typeof names, string][]) sources[key] = exactText((await capture({
    path: path.join(projectRoot, name), contentIdentity: request.sourceNativePins[key] }, 2 * 1024 * 1024)).bytes);
  need(!(await readdir(projectRoot)).some(name => /\.lck$|\.lock$/iu.test(name)), "native document lock remains");
  const markerFile = await captureCurrent(path.join(source.outputDir, ".evleda-pcb-agent-fresh.json"));
  const checkpointFile = await captureCurrent(path.join(source.outputDir, ".evleda-pcb-agent-checkpoint.json"));
  const unsafeFile = await captureCurrent(path.join(source.outputDir, ".evleda-pcb-agent-unsafe-terminal.json"));
  await captureCurrent(path.join(source.outputDir, "../.toolbox-lease.json"));
  const checkpoint = json(checkpointFile.bytes), unsafe = json(unsafeFile.bytes);
  need(checkpoint.baselineMarkerSha256 === markerFile.contentIdentity.digest
    && checkpoint.files?.pcb?.sha256 !== request.sourceNativePins.pcb.digest, "this recovery requires the recorded stale checkpoint");
  need(unsafe.schemaVersion === "evleda.pcb-agent-unsafe-terminal.v1" && normalized(unsafe.projectPath) === normalized(projectRoot)
    && normalized(unsafe.reportPath) === normalized(path.join(source.outputDir, "pcb-agent-report.json")), "quarantine is not source-bound");
  need((await captureCurrent(unsafe.reportPath, 16 * 1024 * 1024)).contentIdentity.digest === unsafe.reportSha256, "quarantine report changed");
  const session = json((await capture(request.session)).bytes);
  need(same(session.serverArgs, ["--profile", sourceProfilePin.path, "--profile-sha256", sourceProfilePin.contentIdentity.digest,
    "--profile-bytes", String(sourceProfilePin.contentIdentity.size), "--workspace-root", request.workspaceRoot, "--edit"]), "session profile/workspace differs");
  const response = async (input: z.infer<typeof pin>, name: string) => {
    need(path.dirname(input.path) === path.dirname(request.session.path), "response escaped the failed session");
    const record = json((await capture(input)).bytes), linked = pin.parse({ path: record.request?.path, contentIdentity: record.request?.identity });
    need(path.dirname(linked.path) === path.dirname(input.path), "request escaped response custody");
    const command = json((await capture(linked)).bytes);
    need(command.operation === "call" && command.name === name && record.disposition === "response", "wrong linked operation");
    return { record, command, data: details(record) };
  };
  let savedAt: string, failedAt: string, openedAt: string | undefined, rejectedUnsavedPcb: unknown = null;
  if (request.schemaVersion === "evleda.saved-plane-recovery-request.v1") {
  const saved = await response(request.savedPlaneResponse, "fresh_apply_contract_plane"), savedBody = decoded(saved.data?.result), persistence = decoded(saved.data?.persistence);
  need(saved.record.isError === false && saved.record.result?.isError !== true && savedBody.applied === true
    && same(savedBody.sourceContractIdentity, sourceBundle.contract.identity)
    && same(savedBody.freshMarkerContentIdentity, markerFile.contentIdentity)
    && persistence.status === "plane-native-saved-and-source-verified" && persistence.nativeSaveCalled === true
    && same(persistence.savedPcbContentIdentity, request.sourceNativePins.pcb), "no verified native save for current PCB");
  const failed = await response(request.failedPlaneResponse, "fresh_apply_contract_plane"), failure = decoded(failed.data?.result);
  need(failed.record.isError === true && failed.data?.recoveryRequired === true
    && failure.schemaVersion === "evleda.fresh-plane-apply-failure.v1" && failure.stage === "stage-validation"
    && failure.code === "PLANE_APPLY_TERMINAL" && failure.recoveryRequired === true && failure.editingSessionMustClose === true
    && failure.rollback === "not-attempted-unknown-or-external-state"
    && failure.message === "KiCad live board readback is absent, truncated, or over its host bound."
    && same(failure.beforePcbContentIdentity, request.sourceNativePins.pcb), "failure is outside the readback-size recovery case");
  const { identity: failureIdentity, ...failurePayload } = failure;
  need(same(failureIdentity, canonicalIdentity(failurePayload, failure.schemaVersion)), "failure identity differs");
  const stage = decodePlaneStageReceipt(json((await capture(request.planeStage)).bytes)).receipt;
  const stageDocument = stage.document as Record<string, any> | undefined;
  const stageRequest = stage.request as Record<string, any> | undefined;
  const failedPlane = sourceBundle.contract.planes.find(plane => plane.id === failed.command.arguments?.planeId);
  need(failedPlane !== undefined && stageDocument?.type === "DOCTYPE_PCB"
    && stageDocument.board_filename === names.pcb && typeof stageDocument.project?.path === "string"
    && normalized(stageDocument.project.path) === normalized(projectRoot)
    && same(stageRequest?.expectedSavedIdentity, request.sourceNativePins.pcb)
    && stageRequest?.mutation?.netName === failedPlane.net && stageRequest?.mutation?.layer === failedPlane.layer,
  "stage document, saved preimage or requested plane differs");
  need(stage.complete === true && stage.nativeSaveCalled === false && stage.mutationDispatched === true && stage.recoveryRequired === false
    && stage.savedSourceBefore === sources.pcb && stage.savedSourceStaged === sources.pcb
    && typeof stage.nativeSourceBefore === "string" && freshBoardSerializationsEqual(stage.nativeSourceBefore, sources.pcb!)
    && typeof stage.nativeSourceStaged === "string" && same(contentIdentity(stage.nativeSourceStaged), failure.acceptedStagedPcbContentIdentity)
    && Buffer.byteLength(stage.nativeSourceStaged) > 500_000 && Buffer.byteLength(stage.nativeSourceStaged) <= 1024 * 1024,
  "stage is not the complete retained oversize observation of this preimage");
  need(exactText((await capture(request.archivedLivePcb)).bytes) === stage.nativeSourceStaged, "retained live snapshot differs from stage");
  savedAt = saved.record.recordedAt; failedAt = failed.record.recordedAt; rejectedUnsavedPcb = failure.acceptedStagedPcbContentIdentity;
  } else if (request.schemaVersion === "evleda.saved-field-recovery-request.v1") {
    const saved = await response(request.savedPoseResponse, "fresh_set_footprint_poses"), savedBody = decoded(saved.data?.result), persistence = decoded(saved.data?.persistence);
    const { identity: savedIdentity, ...savedPayload } = savedBody;
    need(saved.record.isError === false && saved.record.result?.isError !== true && savedBody.applied === true
      && savedBody.schemaVersion === "evleda.fresh-footprint-poses-result.v1"
      && same(savedIdentity, canonicalIdentity(savedPayload, savedBody.schemaVersion))
      && same(savedBody.contractIdentity, createFreshConnectivityContract(sourceBundle.contract, sourceBundle.externalPowerBinding, sourceBundle.derivedPowerBinding).identity)
      && same(savedBody.freshMarkerContentIdentity, markerFile.contentIdentity)
      && persistence.status === "saved-and-native-footprint-poses-verified"
      && persistence.placementCount === savedBody.placementCount
      && same(persistence.pcbContentIdentity, request.sourceNativePins.pcb), "no verified pose save for current PCB");
    const failed = await response(request.failedFieldResponse, "fresh_set_footprint_fields");
    need(failed.record.isError === true && failed.data?.error === "Visible footprint field anchors must remain within the declared board.",
      "failure is outside the saved-field recovery case");
    const updates = parseFreshFootprintFieldUpdates(failed.command.arguments);
    need(updates.every(update => sourceBundle.contract.components.some(component => component.reference === update.reference)), "field request selected a foreign component");
    const proposed = planFreshFootprintFields(sources.pcb!, { updates }), board = sourceBundle.contract.scope.board;
    need(proposed.updates.some(update => update.afterField.visible && (update.afterField.xMm < 0 || update.afterField.yMm < 0
      || update.afterField.xMm > board.widthMm || update.afterField.yMm > board.heightMm)), "saved source does not reproduce the field rejection");
    need(freshBoardSerializationsEqual(exactText((await capture(request.archivedLivePcb)).bytes), sources.pcb!),
      "retained live snapshot differs from the verified saved pose state");
    savedAt = saved.record.recordedAt; failedAt = failed.record.recordedAt;
  } else {
    const opened = await response(request.openedProjectResponse, "evleda_resume_project");
    need(opened.record.isError === false && opened.record.result?.isError !== true
      && same(opened.command.arguments, { projectId: source.projectId }) && opened.data?.status === "opened"
      && opened.data?.projectId === source.projectId && opened.data?.resumed === true && opened.data?.access === "edit"
      && normalized(opened.data?.projectPath) === normalized(projectRoot), "successful source-project resume is not bound");
    openedAt = opened.record.recordedAt;
    const saved = await response(request.savedTextResponse, "pcb_add_text");
    need(saved.record.isError === false && saved.record.result?.isError !== true && saved.data?.operation === "pcb_add_text"
      && decoded(saved.data?.result).result === "Board text added successfully."
      && decoded(saved.data?.persistence).result === "Board saved." && saved.data?.noGovernedEffect === false,
      "missing successful preceding native text/save operation");
    const text = parsePcbSilkscreenText(saved.command.arguments), matches = parseFreshPcbTextItems(sources.pcb!).filter(item =>
      item.text === text.text && item.presentation.at?.x === text.x_mm && item.presentation.at?.y === text.y_mm);
    need(matches.length === 1, "saved source lacks the unique acknowledged final text");
    const item = matches[0]!;
    assertOnlyRequestedPcbTextAdded(sources.pcb!.slice(0, item.start) + sources.pcb!.slice(item.end), sources.pcb!, text);
    const failed = await response(request.failedPlaneResponse, "fresh_apply_contract_plane"), failure = decoded(failed.data?.result);
    const plane = sourceBundle.contract.planes.find(p => p.id === failed.command.arguments?.planeId);
    need(plane !== undefined && same(failed.command.arguments, { planeId: plane.id }) && failed.record.isError === true
      && failed.data?.recoveryRequired === true && failure.schemaVersion === "evleda.fresh-plane-apply-failure.v1"
      && failure.stage === "stage-validation" && failure.code === "PLANE_APPLY_TERMINAL" && failure.recoveryRequired === true
      && failure.editingSessionMustClose === true && failure.rollback === "not-attempted-unknown-or-external-state"
      && failure.acceptedStagedPcbContentIdentity === null
      && failure.message === "PLANE_STAGE_MAY_HAVE_MUTATED: Plane staging did not yield a complete bounded host-readable receipt. Further writes are quarantined; reads, host PCB revert, and explicit close remain available for recovery."
      && same(failure.beforePcbContentIdentity, request.sourceNativePins.pcb), "failure is outside the missing-stage-receipt recovery case");
    const { identity: failureIdentity, ...failurePayload } = failure;
    need(same(failureIdentity, canonicalIdentity(failurePayload, failure.schemaVersion)), "failure identity differs");
    const live = exactText((await capture(request.archivedLivePcb)).bytes), observation = json((await capture(request.liveObservation)).bytes);
    need(observation.documentMatches === true && observation.twoReadsMatch === true
      && observation.sha256 === request.archivedLivePcb.contentIdentity.digest && observation.bytes === request.archivedLivePcb.contentIdentity.size,
      "read-only live capture does not match its complete pinned observation");
    const zones = parseFreshPcbReferenceGeometry(sources.pcb!).zones;
    need(zones.length === sourceBundle.contract.planes.length && zones.every(z => z.uuid !== null && z.kind === "copper"), "saved plane inventory differs");
    const preservation = compareFreshPlaneRefillPreservation({ beforePcbSource: sources.pcb!, afterPcbSource: live,
      zoneUuids: zones.map(z => z.uuid!) });
    need(preservation.equal, "live state has changes outside the complete stored fill caches");
    const discarded = json((await capture(request.checkedDiscardClose)).bytes);
    need(discarded.nativeExitObserved === true && discarded.nativeExitCode === 0 && discarded.savedSourcesUnchanged === true
      && discarded.normalCheckpointPublished === false && discarded.originalQuarantineRetained === true
      && Number.isSafeInteger(discarded.nativePid) && discarded.nativePid > 0
      && same(Object.keys(discarded.savedSourcePins ?? {}).sort(), Object.values(names).sort()), "checked discard/exit evidence is incomplete");
    for (const [key, name] of Object.entries(names) as [keyof typeof names, string][])
      need(same(discarded.savedSourcePins[name], { sha256: request.sourceNativePins[key].digest, size: request.sourceNativePins[key].size }),
        "checked discard source pins differ");
    savedAt = saved.record.recordedAt; failedAt = failed.record.recordedAt; rejectedUnsavedPcb = request.archivedLivePcb.contentIdentity;
  }
  const close = await response(request.failedCloseResponse, "evleda_close_project");
  need(same(close.command.arguments, { projectId: source.projectId }) && close.record.isError === true
    && close.data?.error === (request.schemaVersion === "evleda.saved-field-recovery-request.v1"
      ? "Project lease retained because native finalization/checkpoint requires review."
      : "Native toolbox cleanup was not confirmed; owned state was retained."), "failed close does not match source");
  const terminal = json((await capture(request.clientTerminal)).bytes);
  need(path.dirname(request.clientTerminal.path) === path.dirname(request.session.path)
    && terminal.nativeCleanup === "not_verified", "protocol terminal must retain its unconfirmed native close");
  const times = [session.startedAt, ...(openedAt === undefined ? [] : [openedAt]), savedAt, failedAt, close.record.recordedAt, terminal.endedAt].map(Date.parse);
  need(times.every(Number.isFinite) && times.every((value, i) => i === 0 || value >= times[i - 1]!), "operation order is unproven");
  const intent = json((await capture(request.targetIntent)).bytes);
  need(intent.name === source.name && typeof intent.originalPrompt === "string" && intent.originalPrompt.length > 0, "target stem/prompt differs");
  const compilation = compilePcbPlaneDesignIntentDraft(intent.draft, compiler);
  need(compilation.disposition === "ready", "target draft is not ready");
  const targetBundle = createPcbPlaneCompilationBundle({ compilation, originalPrompt: intent.originalPrompt }, compiler);
  if (request.schemaVersion === "evleda.saved-plane-artifact-recovery-request.v1")
    need(same(sourceBundle.identity, targetBundle.identity), "artifact recovery cannot revise the authenticated design bundle");
  const assertCurrent = async () => {
    need(same(await store.lookup(source.projectId), source), "source allocation changed");
    for (const file of captured.values()) { const next = await captureFreshRuntimeImportFile(file, Math.max(file.bytes.length, 1));
      need(next.physical === file.physical && same(next.parents, file.parents), "source/evidence custody changed"); }
    parsePcbPlaneCompilationBundle(bundleFile.bytes, sourceCompiler);
    const freshTarget = compilePcbPlaneDesignIntentDraft(intent.draft, compiler);
    need(freshTarget.disposition === "ready" && same(createPcbPlaneCompilationBundle({ compilation: freshTarget,
      originalPrompt: intent.originalPrompt }, compiler).identity, targetBundle.identity), "target library or guidance binding changed");
  };
  await assertCurrent();
  const seed = issueFreshPlanePlacementSeed({ name: source.name, sourceBundle, targetBundle, sources: {
    pcb: sources.pcb!, sch: sources.sch!, pro: sources.pro!, dru: sources.dru! }, profile: request.profile, assertCurrent,
    revisionKind: request.schemaVersion === "evleda.saved-plane-recovery-request.v1" ? "via-budgets" : "saved-copy" });
  const sourcePlan = freshPlanePlacementSeedPlan(seed);
  const evidence = { schemaVersion: "evleda.saved-plane-recovery-evidence.v1", request,
    sourceFiles: [...captured.values()].map(f => ({ path: f.path, contentIdentity: f.contentIdentity })),
    currentSavedPcb: request.sourceNativePins.pcb, rejectedUnsavedPcb,
    sourceNormalCloseConfirmed: false, originalQuarantineRetained: true };
  const evidenceIdentity = canonicalIdentity(evidence, evidence.schemaVersion);
  const payload = { schemaVersion: "evleda.plane-saved-recovery-lineage.v1" as const, name: source.name,
    sourceProjectId: source.projectId, targetProjectId: request.targetProjectId,
    sourceBundleIdentity: sourceBundle.identity, targetBundleIdentity: targetBundle.identity,
    sourceSnapshotIdentity: evidenceIdentity, sourceCheckpointIdentity: checkpointFile.contentIdentity,
    sourceNativeIdentities: sourcePlan.receipt.sourceIdentities, targetNativeIdentities: sourcePlan.receipt.targetIdentities,
    sourcePlanIdentity: sourcePlan.receipt.identity, nativeProfileIdentity: request.profile.contentIdentity,
    recovery: { evidenceIdentity, sourceCheckpointCurrent: false as const, sourceNormalCloseConfirmed: false as const, sourceQuarantineRetained: true as const } };
  const lineage = parsePlacementRevisionLineage({ ...payload, identity: canonicalIdentity(payload, payload.schemaVersion) });
  const plan = freezePcbPlaneArtifact({ schemaVersion: "evleda.saved-plane-recovery-plan.v1", evidence, lineage,
    originalFilesModified: false, originalCheckpointRewritten: false, originalQuarantineRetired: false, nativeOpenPending: true });
  const planIdentity = canonicalIdentity(plan, plan.schemaVersion);
  const capability: QualifiedSavedPlaneRecovery = Object.freeze({ kind: "qualified-saved-plane-recovery", plan, identity: planIdentity });
  qualified.set(capability, { consumed: false, execute: async () => {
    await (dependencies.assertQuiescent ?? assertSavedPlaneRecoveryQuiescent)(request.workspaceRoot); await assertCurrent();
    const allocation = await store.allocate({ projectId: request.targetProjectId, name: source.name, draft: intent.draft,
      originalPrompt: intent.originalPrompt, draftIdentity: contentIdentity(canonicalJson(intent.draft)), placementRevisionLineage: lineage });
    need(allocation.created, "target was already allocated; inspect it instead of retrying");
    const lease = await store.acquireLease(allocation.projectId); need(lease.assertCurrent !== undefined, "target lease has no ownership check");
    const toolbox = createKicadToolboxMcpServer({ access: "edit" });
    let binding: Awaited<ReturnType<typeof openFreshNativeToolboxBinding>> | undefined, completed = false, primary: unknown;
    try {
      binding = await (dependencies.openBinding ?? openFreshNativeToolboxBinding)({ profile: request.profile,
        projectDir: allocation.inputDir, outputDir: allocation.outputDir, edit: true, resume: false,
        fresh: { name: source.name, draft: intent.draft, originalPrompt: intent.originalPrompt, expectedBundleIdentity: targetBundle.identity,
          placementSeed: seed, placementRevisionLineage: lineage } });
      await assertCurrent(); await lease.assertCurrent();
      toolbox.attachCad({ ...binding, onFinished: async result => {
        need(result.nativeSessionClosed && result.checkpointPublished && !result.recoveryRequired, "new target did not finish normally"); completed = true;
      } });
      await toolbox.finishCad(); need(completed, "new target lacks a normal checkpoint");
      await assertCurrent(); await lease.assertCurrent();
      const targetRoot = path.join(allocation.outputDir, "project"), verifiedFiles = [];
      for (const [key, name] of Object.entries(names) as [keyof typeof names, string][]) {
        const file = path.join(targetRoot, name), bytes = await readFile(file), value = exactText(bytes);
        const expected = key === "fpLibTable" || key === "symLibTable" ? sources[key]! : sourcePlan.sources[key];
        need(key === "pcb" ? freshBoardSerializationsEqual(value, expected) : key === "pro" ? same(json(bytes), json(Buffer.from(expected)))
          : value === expected, `new target ${key} differs from the qualified source plan`);
        const current = await captureFreshRuntimeImportFile({ path: file, contentIdentity: contentIdentity(bytes) }, 2 * 1024 * 1024);
        verifiedFiles.push({ path: file, contentIdentity: current.contentIdentity });
      }
      const custody = { schemaVersion: "evleda.saved-plane-recovery-custody.v1", status: "new-target-normally-closed", lineage,
        planIdentity, originalQuarantineRetained: true, sourceNormalCloseClaim: false, nativeEvidenceTransferred: false, verifiedFiles };
      await writeFile(path.join(allocation.outputDir, "saved-plane-recovery-custody.json"), JSON.stringify(custody, null, 2) + "\n", { flag: "wx" });
      await lease.release(); return Object.freeze({ status: "recovered-to-new-allocation", projectId: allocation.projectId, lineage, custody });
    } catch (error) {
      primary = error;
      const failures: unknown[] = [error];
      if (binding !== undefined) {
        try { await binding.cad.recordRecoveryRequired?.("Saved-plane recovery target was not fully verified; keep allocation and lease for review."); }
        catch (failure) { failures.push(failure); }
        if (toolbox.getCadState() === "absent") {
          try { await binding.cad.close(); } catch (failure) { failures.push(failure); }
        }
      }
      primary = failures.length === 1 ? error : new AggregateError(failures, "Recovery failed and target cleanup is uncertain; source quarantine remains intact.");
      throw primary;
    } finally {
      try { await toolbox.close(); }
      catch (error) { throw new AggregateError(primary === undefined ? [error] : [primary, error], "Recovery protocol close was not confirmed; target lease retained."); }
    }
  } });
  return capability;
}

export async function executeQualifiedSavedPlaneRecovery(capability: QualifiedSavedPlaneRecovery,
  approval: { readonly planIdentity: string; readonly maintenanceConfirmed: true }) {
  const state = qualified.get(capability);
  need(state !== undefined && !state.consumed && approval.maintenanceConfirmed === true
    && approval.planIdentity === capability.identity.digest, "unissued, consumed or unconfirmed recovery plan");
  state.consumed = true; return state.execute();
}

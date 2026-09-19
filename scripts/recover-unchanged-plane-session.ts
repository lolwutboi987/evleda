/** Offline recovery of the recorded plane-adapter envelope rejection only.
 * No PCB, checkpoint, baseline, rules or report is rewritten. The exact unsafe
 * marker and lease move to an exclusive archive after complete reinspection.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, statfs } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { parsePortableJsonBytes } from "../src/core/portable-artifact.js";
import { decodePlaneStageReceipt } from "../src/integrations/kicad-plane-stage-receipt.js";
import { validateFreshPlaneLiteralStageObservation } from "../src/harness/fresh-plane-stage-observation.js";
import type { KicadPlaneStageInput } from "../src/integrations/kicad-plane-stage.js";

const MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024, RESERVE = 150 * 1024 * 1024;
const VERSION = "evleda.unchanged-plane-session-recovery.v1";
const pinSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u), bytes: z.number().int().positive().max(MAX_FILE) }).strict();
const requestSchema = z.object({ schemaVersion: z.literal("evleda.unchanged-plane-session-recovery-request.v1"),
  projectRoot: z.string().min(1), projectId: z.string().uuid(), archiveRoot: z.string().min(1),
  checkpoint: pinSchema, normalCloseProof: pinSchema, normalCloseResponse: pinSchema,
  failedSession: pinSchema, resumeResponse: pinSchema, planeResponse: pinSchema, closeResponse: pinSchema,
  stageArtifact: pinSchema, expectedLease: pinSchema, expectedUnsafeMarker: pinSchema }).strict();
export type UnchangedPlaneRecoveryRequest = z.infer<typeof requestSchema>;
type Pin = z.infer<typeof pinSchema>;
type Physical = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; birthtimeNs: string; mode: string; nlink: string };
type Captured = Pin & { physical: Physical; data: Buffer };
type Witness = Omit<Captured, "data">;
export interface UnchangedPlaneRecoveryPlan {
  schemaVersion: typeof VERSION; request: UnchangedPlaneRecoveryRequest; files: Witness[];
  directories: { path: string; dev: string; ino: string }[];
  requiredFreeBytes: number; sourceFilesRewritten: false; checkpointRewritten: false;
  stageObservationIdentity: ReturnType<typeof canonicalIdentity>;
  identity: ReturnType<typeof canonicalIdentity>;
}
/** Test seams are never accepted by the CLI. */
export interface UnchangedPlaneRecoveryHooks { assertQuiescent?: () => Promise<void>; availableBytes?: () => Promise<bigint>; beforeStep?: (step: string) => Promise<void> }
const need = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Unchanged plane recovery refused: ${message}`); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const equalPath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, file: string) => { const p = path.relative(root, file); return p !== "" && !p.startsWith("..") && !path.isAbsolute(p); };
const physical = (s: Awaited<ReturnType<typeof lstat>> | any): Physical => Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs", "birthtimeNs", "mode", "nlink"].map(key => [key, String(s[key])])) as Physical;
const witness = ({ data: _data, ...rest }: Captured): Witness => rest;
async function directory(file: string) {
  need(path.isAbsolute(file) && path.resolve(file) === file, "directory is not normalized absolute path");
  const s = await lstat(file, { bigint: true });
  need(s.isDirectory() && !s.isSymbolicLink() && equalPath(await realpath(file), file), "directory is linked or noncanonical");
  return { path: file, dev: String(s.dev), ino: String(s.ino) };
}
async function capture(file: string): Promise<Captured> {
  need(path.isAbsolute(file) && path.resolve(file) === file, "file is not normalized absolute path");
  await directory(path.dirname(file));
  const before = await lstat(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(MAX_FILE)
    && equalPath(await realpath(file), file), "file must be bounded, ordinary and single-link");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    need(same(physical(before), physical(await handle.stat({ bigint: true }))), "file changed before open");
    const data = await handle.readFile();
    need(data.length === Number(before.size) && same(physical(before), physical(await handle.stat({ bigint: true })))
      && same(physical(before), physical(await lstat(file, { bigint: true }))), "file changed during capture");
    return { path: file, sha256: contentIdentity(data).digest, bytes: data.length, physical: physical(before), data };
  } finally { await handle.close(); }
}
const json = (data: Buffer): any => parsePortableJsonBytes(data, { maxBytes: MAX_FILE, maxStringBytes: 1024 * 1024, maxNodes: 500_000, maxDepth: 64, maxArrayLength: 100_000, maxOwnKeys: 256, maxKeyBytes: 1024 });
async function pinned(pin: Pin) { const f = await capture(pin.path); need(f.sha256 === pin.sha256 && f.bytes === pin.bytes, "evidence pin differs"); return f; }
async function absent(file: string) { try { await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; } throw new Error(`Unchanged plane recovery refused: expected absence: ${file}`); }
async function quiescent(workspace: string, hooks: UnchangedPlaneRecoveryHooks) {
  if (hooks.assertQuiescent) return hooks.assertQuiescent();
  need(process.platform === "win32", "production process inspection is Windows-only");
  const helper = fileURLToPath(new URL("./recover-toolbox-project.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", helper, "--check-quiescence", "--workspace-root", workspace],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
  const observed = JSON.parse(result.stdout); need(observed.quiescent === true && Array.isArray(observed.blocking) && observed.blocking.length === 0, "native/target workspace processes remain or scope is unproven");
}
async function inspect(input: unknown, hooks: UnchangedPlaneRecoveryHooks = {}) {
  const request = requestSchema.parse(input), root = request.projectRoot, output = path.join(root, "output"), project = path.join(output, "project"), workspace = path.dirname(path.dirname(root)), evidenceRoot = path.dirname(workspace);
  need(path.basename(root) === request.projectId && path.basename(path.dirname(root)) === "projects", "allocation path differs from project ID");
  need(inside(evidenceRoot, request.archiveRoot) && !inside(root, request.archiveRoot) && !inside(request.archiveRoot, root), "archive must be disjoint inside the task directory");
  const directories = [];
  for (const p of [evidenceRoot, workspace, path.dirname(root), root, output, project, path.join(root, "input"), request.archiveRoot]) directories.push(await directory(p));
  need(directories.at(-1)!.dev === directories[3]!.dev, "metadata retirement requires the same volume");
  await quiescent(workspace, hooks);
  const files = new Map<string, Captured>();
  async function take(file: string, pin?: Pin) { need(inside(evidenceRoot, file), "evidence outside task scope"); const f = pin ? await pinned(pin) : await capture(file); files.set(file, f); need([...files.values()].reduce((n, p) => n + p.bytes, 0) <= MAX_TOTAL, "evidence inventory exceeds bound"); return f; }
  for (const p of Object.values(request)) if (typeof p === "object") await take(p.path, p);
  const allocation = json((await take(path.join(root, "allocation.json"))).data), markerFile = await take(path.join(output, ".evleda-pcb-agent-fresh.json")), marker = json(markerFile.data);
  const checkpoint = json(files.get(request.checkpoint.path)!.data);
  need(request.checkpoint.path === path.join(output, ".evleda-pcb-agent-checkpoint.json") && allocation.projectId === request.projectId
    && marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3" && marker.workflowKind === "plane" && marker.projectPath === project && marker.outputPath === output
    && checkpoint.schemaVersion === "evleda.pcb-agent-fresh-project-checkpoint.v3" && checkpoint.reason === "run_exit"
    && checkpoint.projectPath === project && checkpoint.baselineMarkerSha256 === markerFile.sha256
    && same(checkpoint.planeBindingIdentity, marker.planeBinding.identity), "checkpoint/baseline/allocation binding differs");
  const keys = ["pro", "pcb", "sch", "dru", "symLibTable", "fpLibTable"].sort();
  need(same(Object.keys(checkpoint.files).sort(), keys), "checkpoint must contain exactly six sources");
  const expectedNames: Record<string, string> = { pro: `${allocation.name}.kicad_pro`, pcb: `${allocation.name}.kicad_pcb`, sch: `${allocation.name}.kicad_sch`, dru: `${allocation.name}.kicad_dru`, symLibTable: "sym-lib-table", fpLibTable: "fp-lib-table" };
  for (const key of keys) { const record = checkpoint.files[key]; need(record.path === path.join(project, expectedNames[key]!), "source path differs from exact allocation"); const f = await take(record.path); need(f.sha256 === record.sha256, "current source differs from healthy checkpoint; no rollback is authorized"); }
  const closeProof = json(files.get(request.normalCloseProof.path)!.data), closed = json(files.get(request.normalCloseResponse.path)!.data);
  need(closeProof.projectId === request.projectId && closeProof.normalCloseConfirmed === true && closeProof.checkpoint.path === request.checkpoint.path && closeProof.checkpoint.sha256 === request.checkpoint.sha256
    && same(closeProof.files, checkpoint.files) && closeProof.closeResponse.path === request.normalCloseResponse.path && closeProof.closeResponse.sha256 === request.normalCloseResponse.sha256
    && closed.result?.structuredContent?.status === "closed" && closed.result.structuredContent.projectId === request.projectId, "prior normal-close chain differs");
  const session = json(files.get(request.failedSession.path)!.data), sessionDir = path.dirname(request.failedSession.path);
  need(inside(evidenceRoot, sessionDir) && Array.isArray(session.serverArgs) && session.serverArgs.every((v: unknown) => typeof v === "string")
    && session.serverArgs.filter((v: string) => v === "--edit").length === 1 && session.serverArgs.filter((v: string) => v === "--workspace-root").length === 1
    && session.serverArgs[session.serverArgs.indexOf("--workspace-root") + 1] === workspace, "failed session is not an edit session in this workspace");
  async function response(pin: Pin, name: string, args: unknown) {
    need(path.dirname(pin.path) === sessionDir, "response is outside failed session"); const r = json(files.get(pin.path)!.data);
    need(r.disposition === "response" && r.request && path.dirname(r.request.path) === sessionDir, "response/request lineage missing");
    const bytes = (await take(r.request.path)).data; need(same(contentIdentity(bytes), r.request.identity), "request identity differs");
    const command = JSON.parse(bytes.toString("utf8")); need(command.operation === "call" && command.name === name && same(command.arguments, args), "request operation/arguments differ"); return r;
  }
  const resumed = await response(request.resumeResponse, "evleda_resume_project", { projectId: request.projectId });
  need(resumed.result?.structuredContent?.status === "opened" && resumed.result.structuredContent.resumed === true && resumed.result.structuredContent.projectId === request.projectId, "failed session did not resume this saved project");
  const failedRaw = json(files.get(request.planeResponse.path)!.data), planeCommand = JSON.parse((await take(failedRaw.request.path)).data.toString("utf8"));
  need(typeof planeCommand.arguments?.planeId === "string" && Object.keys(planeCommand.arguments).length === 1, "plane ID selection must be explicit");
  const failed = await response(request.planeResponse, "fresh_apply_contract_plane", planeCommand.arguments), failure = JSON.parse(failed.result.structuredContent.result.content);
  need(failed.result.isError === true && failed.result.structuredContent.recoveryRequired === true && failure.schemaVersion === "evleda.fresh-plane-apply-failure.v1"
    && failure.stage === "stage-validation" && failure.code === "PLANE_APPLY_TERMINAL" && failure.recoveryRequired === true && failure.editingSessionMustClose === true
    && failure.rollback === "not-attempted-unknown-or-external-state" && failure.acceptedStagedPcbContentIdentity === null
    && failure.message === "Portable value string budget exceeded", "not the supported rejected PAD-envelope stage");
  const closeFailed = await response(request.closeResponse, "evleda_close_project", { projectId: request.projectId });
  need(closeFailed.result.isError === true && closeFailed.result.structuredContent.error === "Native toolbox cleanup was not confirmed; owned state was retained.", "close outcome differs");
  const times = [closed.recordedAt, session.startedAt, resumed.recordedAt, failed.recordedAt, closeFailed.recordedAt].map(Date.parse);
  need(times.every(Number.isFinite) && times.every((t, i) => i === 0 || t >= times[i - 1]!), "session chronology is missing or reordered");
  need(request.expectedLease.path === path.join(root, ".toolbox-lease.json") && request.expectedUnsafeMarker.path === path.join(output, ".evleda-pcb-agent-unsafe-terminal.json"), "quarantine paths differ");
  const lease = json(files.get(request.expectedLease.path)!.data), unsafe = json(files.get(request.expectedUnsafeMarker.path)!.data);
  need(lease.schemaVersion === "evleda.toolbox-owned-lock.v1" && typeof lease.nonce === "string" && lease.nonce.length > 0 && Object.keys(lease).length === 2
    && unsafe.schemaVersion === "evleda.pcb-agent-unsafe-terminal.v1" && unsafe.projectPath === project && unsafe.reportPath === path.join(output, "pcb-agent-report.json"), "lease/unsafe binding differs");
  const report = await take(unsafe.reportPath); need(report.sha256 === unsafe.reportSha256, "unsafe report identity differs");
  need(path.dirname(request.stageArtifact.path) === path.join(output, ".evleda-mcp-output") && /^evleda-plane-stage-[a-f0-9-]{36}\.json$/u.test(path.basename(request.stageArtifact.path)), "stage artifact is outside native output");
  const raw = json(files.get(request.stageArtifact.path)!.data), receipt = decodePlaneStageReceipt(raw).receipt as Record<string, any>, snapshot = receipt.padSnapshot;
  const pcb = files.get(checkpoint.files.pcb.path)!;
  need(same(failure.beforePcbContentIdentity, contentIdentity(pcb.data)) && receipt.savedSourceBefore === pcb.data.toString("utf8") && receipt.savedSourceStaged === receipt.savedSourceBefore, "saved preimage differs or native stage saved");
  const references = snapshot.connectivity.map((query: any) => { const index = snapshot.padRecords.findIndex((p: any) => p.id.value === query.sourcePrimitiveId), owner = snapshot.footprintInventory.footprints.find((f: any) => f.padRecordIndexes.includes(index)); need(index >= 0 && owner, "stage PAD ownership missing"); return { reference: owner.reference, pad: snapshot.padRecords[index].number ?? "", primitiveId: query.sourcePrimitiveId }; });
  const nativeRequest: KicadPlaneStageInput = { board_file: checkpoint.files.pcb.path, zone_ids: receipt.zonesBefore.map((zone: any) => zone.uuid), reference_pads: references, request: receipt.request };
  const observation = validateFreshPlaneLiteralStageObservation(raw, { request: nativeRequest, padExpected: { pcbPath: nativeRequest.board_file, pcbSource: receipt.savedSourceBefore,
    requestedPrimitiveIds: references.map((r: any) => r.primitiveId), enabledCopperLayers: ["F.Cu", "B.Cu"], scopeIdentity: canonicalIdentity({ purpose: "offline unchanged-checkpoint recovery only", projectId: request.projectId }, "evleda.plane-recovery-observation.v1") } });
  need(observation.comparison.valid && observation.savedAuthorityMinted === false, "complete retained stage does not validate");
  for (const dir of [root, output, project]) for (const name of await readdir(dir)) need(!/\.lck$|\.lock$|unsafe|lease/iu.test(name)
    || [request.expectedLease.path, request.expectedUnsafeMarker.path].includes(path.join(dir, name)), "unreviewed lock/quarantine artifact remains");
  for (const file of files.values()) need(same(witness(await capture(file.path)), witness(file)), "inspection input changed");
  await quiescent(workspace, hooks);
  return { request, files: [...files.values()], directories, stageObservationIdentity: observation.identity };
}
export async function inspectUnchangedPlaneRecovery(input: unknown, hooks: UnchangedPlaneRecoveryHooks = {}): Promise<UnchangedPlaneRecoveryPlan> {
  const state = await inspect(input, hooks), payload = { schemaVersion: VERSION as typeof VERSION, request: state.request, files: state.files.map(witness).sort((a, b) => a.path.localeCompare(b.path)), directories: state.directories,
    requiredFreeBytes: RESERVE + state.files.reduce((n, f) => n + f.bytes, 0) + 1024 * 1024, sourceFilesRewritten: false as const, checkpointRewritten: false as const, stageObservationIdentity: state.stageObservationIdentity };
  return { ...payload, identity: canonicalIdentity(payload, VERSION) };
}
export async function applyUnchangedPlaneRecovery(plan: UnchangedPlaneRecoveryPlan, approval: { planIdentity: string; maintenanceConfirmed: true }, hooks: UnchangedPlaneRecoveryHooks = {}) {
  const { identity, ...payload } = plan; need(plan.schemaVersion === VERSION && same(identity, canonicalIdentity(payload, VERSION)) && approval.planIdentity === identity.digest && approval.maintenanceConfirmed === true, "exact reviewed plan and maintenance exclusion required");
  need(same(await inspectUnchangedPlaneRecovery(plan.request, hooks), plan), "reviewed plan is stale");
  const free = hooks.availableBytes ? await hooks.availableBytes() : await statfs(plan.request.archiveRoot, { bigint: true }).then(s => s.bavail * s.bsize); need(free >= BigInt(plan.requiredFreeBytes), "insufficient archive reserve");
  const archive = path.join(plan.request.archiveRoot, `plane-recovery-${plan.request.projectId}-${identity.digest}`); await mkdir(archive);
  const archiveDirectory = await directory(archive);
  const archived: Witness[] = [];
  async function write(file: string, data: Buffer) { const h = await open(file, "wx", 0o600); try { await h.writeFile(data); await h.sync(); } finally { await h.close(); } const copy = await capture(file); need(copy.sha256 === contentIdentity(data).digest, "archive readback differs"); archived.push(witness(copy)); }
  let step = "archive";
  try {
    await write(path.join(archive, "plan.json"), Buffer.from(canonicalJson(plan)));
    for (const [i, file] of plan.files.entries()) { const current = await capture(file.path); need(same(witness(current), file), "source changed during archive"); await write(path.join(archive, `${String(i).padStart(3, "0")}.bin`), current.data); }
    await write(path.join(archive, "archive-complete.json"), Buffer.from(canonicalJson({ planIdentity: identity, originals: plan.files, sourceFilesRewritten: false, checkpointRewritten: false })));
    await hooks.beforeStep?.("archived"); need(same(await inspectUnchangedPlaneRecovery(plan.request, hooks), plan), "plan changed during archival");
    const retired = new Set<string>(), workspace = path.dirname(path.dirname(plan.request.projectRoot));
    for (const [index, artifact] of [plan.request.expectedUnsafeMarker, plan.request.expectedLease].entries()) {
      step = index === 0 ? "retire-unsafe" : "retire-lease"; await hooks.beforeStep?.(step); await quiescent(workspace, hooks);
      need(same(await directory(archive), archiveDirectory), "archive directory identity changed");
      for (const d of plan.directories) need(same(await directory(d.path), d), "directory identity changed");
      for (const f of archived) need(same(witness(await capture(f.path)), f), "archive changed before retirement");
      for (const f of plan.files) { if (retired.has(f.path)) await absent(f.path); else need(same(witness(await capture(f.path)), f), "bound source/evidence changed before retirement"); }
      for (const dir of [plan.request.projectRoot, path.join(plan.request.projectRoot, "output"), path.join(plan.request.projectRoot, "output/project")]) for (const name of await readdir(dir)) need(!/\.lck$|\.lock$|unsafe|lease/iu.test(name)
        || [plan.request.expectedLease.path, plan.request.expectedUnsafeMarker.path].includes(path.join(dir, name)), "new quarantine/lock blocks retirement");
      const destination = path.join(archive, index === 0 ? "original-unsafe-terminal.json" : "original-lease.json"); await absent(destination); await rename(artifact.path, destination); retired.add(artifact.path);
      if (index === 1) return { status: "unchanged-checkpoint-released" as const, archive, sourceFilesRewritten: false, checkpointRewritten: false, normalCloseClaim: false, designAccepted: false };
    }
    throw new Error("Unreachable retirement state");
  } catch (error) { throw new Error(`Unchanged plane recovery stopped at ${step}; preserve ${archive} and inspect before any retry. ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: { input: { type: "string" }, sha256: { type: "string" }, bytes: { type: "string" }, apply: { type: "boolean", default: false }, "maintenance-confirmed": { type: "boolean", default: false } } });
  need(values.input && values.sha256 && values.bytes && /^[1-9][0-9]*$/u.test(values.bytes), "supply pinned --input, --sha256 and --bytes");
  const input = json((await pinned(pinSchema.parse({ path: path.resolve(values.input!), sha256: values.sha256, bytes: Number(values.bytes) }))).data);
  const result = values.apply ? await applyUnchangedPlaneRecovery(input, { planIdentity: input.identity.digest, maintenanceConfirmed: values["maintenance-confirmed"] as true }) : await inspectUnchangedPlaneRecovery(input);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(e => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });

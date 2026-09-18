/** Offline, separately typed operator exceptions for the recorded zero-byte
 * disk-full failure, exact outlined pre-native-sync rejection, or explicitly
 * approved abandonment of all PCB changes back to a prior closed checkpoint.
 * The latter authority never comes from native rollback/error prose. These are NOT
 * generic unsafe-marker clearing, stale-lock reclamation or normal resume.
 * Inspection prints a plan and writes nothing. Apply requires that exact plan's
 * SHA-256, explicit maintenance exclusion, and fresh process/source checks.
 * Never invoke apply against a live host. Partial failures require review of
 * the exclusive archive; they are not retried or silently rolled back.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { parsePortableJsonBytes } from "../src/core/portable-artifact.js";
import { createFreshConnectivityContract } from "../src/harness/fresh-connectivity-contract.js";
import { parseFreshPcbSourceDocument } from "../src/harness/fresh-kicad-parser.js";
import { freshBoardSerializationsEqual } from "../src/harness/fresh-board-serialization.js";

const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 8 * 1024 * 1024, RESERVE = 100 * 1024 * 1024;
const VERSION = "evleda.offline-zero-pcb-recovery-plan.v1";
const SYNC_VERSION = "evleda.offline-outlined-pre-sync-recovery-plan.v1";
const ROLLBACK_VERSION = "evleda.offline-pcb-checkpoint-rollback-plan.v1";
const ORPHAN_ROLLBACK_VERSION = "evleda.offline-pcb-checkpoint-rollback-plan.v2";
const ROLLBACK_WORK_LIMIT = 5 * 1024 * 1024, ROLLBACK_RESERVE = 150 * 1024 * 1024;
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/u);
const pin = z.object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().min(0).max(MAX_FILE) }).strict();
const requestSchema = z.object({ schemaVersion: z.literal("evleda.offline-zero-pcb-recovery-request.v1"),
  projectRoot: z.string().min(1), projectId: uuid, archiveRoot: z.string().min(1), backup: pin,
  normalCloseVerification: pin, normalCloseResponse: pin, failureObservation: pin, processAmendment: pin,
  failedSession: pin, resumeRequest: pin, resumeResponse: pin, outlineRequest: pin, failureWire: pin, failedResponse: pin, failedTerminal: pin,
  expectedLease: pin, expectedBoardLock: pin, expectedProjectLock: pin }).strict();
export type RecoveryRequest = z.infer<typeof requestSchema>;
const absentPin = z.object({ path: z.string().min(1), absent: z.literal(true) }).strict();
const syncRequestSchema = requestSchema.pick({ projectRoot: true, projectId: true, archiveRoot: true, backup: true,
  normalCloseVerification: true, normalCloseResponse: true, failureObservation: true, failedSession: true, resumeRequest: true,
  resumeResponse: true, outlineRequest: true, expectedLease: true }).extend({
  schemaVersion: z.literal("evleda.offline-outlined-pre-sync-recovery-request.v1"), outlineResponse: pin,
  syncRequest: pin, syncResponse: pin, syncDiagnostic: pin, closeRequest: pin, closeResponse: pin,
  statusRequest: pin, statusResponse: pin, shutdownObservation: pin, expectedUnsafeMarker: pin,
  expectedBoardLock: absentPin, expectedProjectLock: absentPin }).strict();
export type OutlinedSyncRecoveryRequest = z.infer<typeof syncRequestSchema>;
const rollbackRequestSchema = syncRequestSchema.omit({ outlineRequest: true, outlineResponse: true }).extend({
  schemaVersion: z.literal("evleda.offline-pcb-checkpoint-rollback-request.v1"), currentPcb: pin, observedFailurePcb: pin.optional() }).strict();
export type PcbCheckpointRollbackRequest = z.infer<typeof rollbackRequestSchema>;
const orphanRollbackRequestSchema = rollbackRequestSchema.extend({ schemaVersion: z.literal("evleda.offline-pcb-checkpoint-rollback-request.v2"),
  expectedBoardLock: pin, expectedProjectLock: pin, orphanEditorObservation: pin, ownedEditorTermination: pin }).strict();
export type OrphanPcbCheckpointRollbackRequest = z.infer<typeof orphanRollbackRequestSchema>;
const anyRequestSchema = z.discriminatedUnion("schemaVersion", [requestSchema, syncRequestSchema, rollbackRequestSchema, orphanRollbackRequestSchema]);
type AnyRequest = RecoveryRequest | OutlinedSyncRecoveryRequest | PcbCheckpointRollbackRequest | OrphanPcbCheckpointRollbackRequest;
const isSyncRequest = (request: AnyRequest): request is OutlinedSyncRecoveryRequest => request.schemaVersion === "evleda.offline-outlined-pre-sync-recovery-request.v1";
const isOrphanRollbackRequest = (request: AnyRequest): request is OrphanPcbCheckpointRollbackRequest => request.schemaVersion === "evleda.offline-pcb-checkpoint-rollback-request.v2";
const isRollbackRequest = (request: AnyRequest): request is PcbCheckpointRollbackRequest | OrphanPcbCheckpointRollbackRequest => request.schemaVersion === "evleda.offline-pcb-checkpoint-rollback-request.v1" || isOrphanRollbackRequest(request);
const isSyncFailureRequest = (request: AnyRequest): request is OutlinedSyncRecoveryRequest | PcbCheckpointRollbackRequest | OrphanPcbCheckpointRollbackRequest => isSyncRequest(request) || isRollbackRequest(request);
type Pin = z.infer<typeof pin>;
type Physical = { dev: string; ino: string; size: string; mode: string; mtimeNs: string; ctimeNs: string; birthtimeNs: string };
type Capture = { path: string; sha256: string; bytes: number; physical: Physical; data: Buffer };
type Witness = Omit<Capture, "data">;
type Directory = { path: string; dev: string; ino: string };
export interface RecoveryPlan {
  schemaVersion: typeof VERSION | typeof SYNC_VERSION | typeof ROLLBACK_VERSION | typeof ORPHAN_ROLLBACK_VERSION; request: AnyRequest; pcbPath: string;
  files: Witness[]; directories: Directory[]; requiredFreeBytes: number;
  absentPaths?: string[];
  discardAllCurrentPcbChanges?: true;
  archiveAndTemporaryBytes?: number;
  ownershipBasis: "operator-approved exact orphan artifacts; not original nonce ownership";
  identity: ReturnType<typeof canonicalIdentity>;
}
/** In-process test seams only; the CLI never accepts executable callbacks. */
export interface RecoveryHooks {
  assertQuiescent?: () => Promise<void>;
  availableBytes?: (directory: string) => Promise<bigint>;
  beforeStep?: (step: string) => Promise<void>;
}
const need = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Offline recovery refused: ${message}`); };
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const equalPath = (a: string, b: string) => comparable(a) === comparable(b);
const contains = (root: string, target: string) => { const relative = path.relative(comparable(root), comparable(target)); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const json = (bytes: Buffer): Record<string, any> => {
  const value = parsePortableJsonBytes(bytes, { maxBytes: MAX_FILE, maxDepth: 100, maxNodes: 500_000,
    maxArrayLength: 100_000, maxOwnKeys: 8192, maxKeyBytes: 2048, maxStringBytes: 1024 * 1024 });
  need(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as Record<string, any>;
};
const witness = ({ data: _data, ...value }: Capture): Witness => value;
function identityOf(value: { dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint; birthtimeNs: bigint }): Physical {
  return Object.fromEntries(["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs", "birthtimeNs"].map(key => [key, String(value[key as keyof typeof value])])) as Physical;
}
async function directoryChain(target: string): Promise<Directory[]> {
  need(path.isAbsolute(target) && path.resolve(target) === target, "paths must be explicit normalized absolute paths");
  const result: Directory[] = [];
  for (let current = target;; current = path.dirname(current)) {
    const before = await lstat(current, { bigint: true });
    need(before.isDirectory() && !before.isSymbolicLink() && equalPath(await realpath(current), current), "directory link, alias or unsupported entry");
    const after = await lstat(current, { bigint: true });
    need(before.dev === after.dev && before.ino === after.ino, "directory changed during inspection");
    result.push({ path: current, dev: String(after.dev), ino: String(after.ino) });
    if (path.dirname(current) === current) return result;
  }
}
async function capture(file: string): Promise<Capture> {
  need(path.isAbsolute(file) && path.resolve(file) === file, "file path is not normalized and absolute");
  await directoryChain(path.dirname(file));
  const before = await lstat(file, { bigint: true });
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(MAX_FILE)
    && equalPath(await realpath(file), file), "file link, alias, shared file or byte bound");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    need(same(identityOf(before), identityOf(opened)), "file changed while opening");
    const data = Buffer.alloc(Number(opened.size) + 1); let length = 0;
    while (length < data.length) { const part = await handle.read(data, length, data.length - length, length); if (part.bytesRead === 0) break; length += part.bytesRead; }
    const after = await handle.stat({ bigint: true }), atPath = await lstat(file, { bigint: true });
    need(length === Number(opened.size) && atPath.nlink === 1n && !atPath.isSymbolicLink()
      && same(identityOf(opened), identityOf(after)) && same(identityOf(opened), identityOf(atPath)), "file changed during capture");
    const bytes = data.subarray(0, length), id = contentIdentity(bytes);
    return { path: file, sha256: id.digest, bytes: id.size, physical: identityOf(atPath), data: bytes };
  } finally { await handle.close(); }
}
async function pinned(value: Pin): Promise<Capture> {
  const parsed = pin.parse(value), current = await capture(parsed.path);
  need(current.sha256 === parsed.sha256 && current.bytes === parsed.bytes, "supplied evidence pin differs from current bytes");
  return current;
}
async function assertAbsent(file: string): Promise<void> {
  need(path.isAbsolute(file) && path.resolve(file) === file, "absence path must be normalized and absolute");
  await directoryChain(path.dirname(file));
  try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`Offline recovery refused: expected absent artifact reappeared: ${file}`);
}
function checkIdentity(value: Record<string, any>): void {
  const { identity, ...payload } = value;
  need(identity !== undefined && same(identity, canonicalIdentity(payload, payload.schemaVersion)), "canonical artifact identity does not reproduce");
}
/** Narrow Windows argv reader; ambiguous/unbalanced input cannot prove disjoint scope. */
function commandArguments(command: string): string[] {
  const result: string[] = []; let at = 0;
  while (at < command.length) {
    while (/\s/u.test(command[at] ?? "") && at < command.length) at++;
    if (at === command.length) break;
    let value = "", quoted = false;
    while (at < command.length && (quoted || !/\s/u.test(command[at]!))) {
      let slashes = 0; while (command[at] === "\\") { slashes++; at++; }
      if (command[at] === '"') { value += "\\".repeat(Math.floor(slashes / 2)); if (slashes % 2) value += '"'; else quoted = !quoted; at++; }
      else { value += "\\".repeat(slashes); if (at < command.length) value += command[at++]!; }
    }
    need(!quoted, "ambiguous process command line"); result.push(value);
  }
  return result;
}
type ProcessRow = { ProcessId: number; Name: string; CommandLine: string | null };
export async function classifyRecoveryProcesses(rows: ProcessRow[], inspectorPid: number, workspaceRoot?: string,
  canonicalize: (directory: string) => Promise<string> = async directory => (await directoryChain(path.resolve(directory)))[0]!.path) {
  const blocking: Array<{ ProcessId: number; Name: string; reason: string }> = [], disjointHosts: Array<{ ProcessId: number; Name: string }> = [];
  for (const row of rows) {
    if (row.ProcessId === inspectorPid) continue;
    const brief = { ProcessId: row.ProcessId, Name: row.Name };
    if (/^(pcbnew|eeschema|kicad-cli)(\.exe)?$/iu.test(row.Name)) { blocking.push({ ...brief, reason: "native process remains" }); continue; }
    if (row.CommandLine === null || row.CommandLine.length === 0) { blocking.push({ ...brief, reason: "process scope is unavailable" }); continue; }
    if (!/toolbox-workspace-(main|client)|toolbox-native-main|kicad_mcp/iu.test(row.CommandLine)) continue;
    try {
      const args = commandArguments(row.CommandLine);
      // Only direct workspace-main invocation has the known workspace-root
      // semantics. Node eval/loaders/wrappers, clients and native-main do not.
      need(/^node(?:\.exe)?$/iu.test(row.Name) && /^node(?:\.exe)?$/iu.test(path.basename(args[0] ?? ""))
        && typeof args[1] === "string" && path.isAbsolute(args[1]) && path.basename(args[1]) === "toolbox-workspace-main.js", "unrecognized executed host entrypoint");
      const flags = new Map<string, string>();
      for (let index = 2; index < args.length; index++) {
        const [key, inline, ...extra] = args[index]!.split("=");
        need(extra.length === 0 && key !== undefined && ["--profile", "--profile-sha256", "--profile-bytes", "--workspace-root", "--edit"].includes(key)
          && !flags.has(key), "ambiguous or unsupported workspace host arguments");
        if (key === "--edit") { need(inline === undefined, "nonboolean edit flag"); flags.set(key, "true"); }
        else { const value = inline ?? args[++index]; need(typeof value === "string" && !value.startsWith("--"), "missing workspace host argument"); flags.set(key!, value!); }
      }
      const declaredRoot = flags.get("--workspace-root"), profile = flags.get("--profile");
      need(workspaceRoot !== undefined && declaredRoot !== undefined && path.isAbsolute(declaredRoot) && !/[\0\r\n"]/u.test(declaredRoot)
        && profile !== undefined && path.isAbsolute(profile) && /^[a-f0-9]{64}$/u.test(flags.get("--profile-sha256") ?? "")
        && /^[1-9][0-9]*$/u.test(flags.get("--profile-bytes") ?? ""), "host has no unique qualified workspace CLI");
      const scope = await canonicalize(declaredRoot!);
      need(!contains(workspaceRoot!, scope) && !contains(scope, workspaceRoot!), "target or overlapping workspace host remains");
      disjointHosts.push(brief);
    } catch { blocking.push({ ...brief, reason: "target, overlapping or unproven host scope" }); }
  }
  return { quiescent: blocking.length === 0, inspectorPid, blocking, disjointHosts };
}
async function observeProcesses(workspaceRoot?: string) {
  need(process.platform === "win32", "production process inspection is Windows-only");
  const command = "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and $_.Name -match '^(node|python|pythonw|pcbnew|eeschema|kicad-cli)(\\.exe)?$'} | Select-Object ProcessId,Name,CommandLine); [pscustomobject]@{inspectorPid=$PID;processes=$p}|ConvertTo-Json -Compress";
  const executable = path.join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await promisify(execFile)(executable, ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  const row = z.object({ ProcessId: z.number().int().positive(), Name: z.string().min(1).max(128), CommandLine: z.string().max(32768).nullable() }).strict();
  const observed = z.object({ inspectorPid: z.number().int().positive(), processes: z.array(row).max(512) }).strict().parse(JSON.parse(result.stdout));
  need(!observed.processes.some(row => row.ProcessId === observed.inspectorPid), "process inspector did not exclude its own identity");
  return classifyRecoveryProcesses(observed.processes, observed.inspectorPid, workspaceRoot);
}
async function defaultQuiescent(workspaceRoot: string): Promise<void> {
  const observed = await observeProcesses(workspaceRoot);
  need(observed.quiescent, `native/target workspace processes or unproven scope: ${JSON.stringify(observed.blocking)}`);
}
const quiescent = (hooks: RecoveryHooks, workspaceRoot: string) => hooks.assertQuiescent === undefined ? defaultQuiescent(workspaceRoot) : hooks.assertQuiescent();
async function diskRoom(directory: string, required: number, hooks: RecoveryHooks): Promise<void> {
  const available = hooks.availableBytes === undefined ? await statfs(directory, { bigint: true }).then(s => s.bavail * s.bsize) : await hooks.availableBytes(directory);
  need(available >= BigInt(required), "insufficient disk headroom for this plan's bounded archive, restore and explicit reserve");
}
async function inspect(requestValue: unknown): Promise<{ request: AnyRequest; captures: Capture[]; directories: Directory[]; pcbPath: string; absentPaths?: string[] }> {
  const request = anyRequestSchema.parse(requestValue), root = request.projectRoot, output = path.join(root, "output"), project = path.join(output, "project");
  const sync = isSyncFailureRequest(request), rollback = isRollbackRequest(request), orphanLocks = isOrphanRollbackRequest(request);
  need(path.basename(root) === request.projectId && path.basename(path.dirname(root)) === "projects", "project allocation path differs from its exact ID");
  need(!contains(root, request.archiveRoot) && !contains(request.archiveRoot, root), "recovery archive must be disjoint from the allocation");
  await directoryChain(request.archiveRoot);
  const captures = new Map<string, Capture>();
  const remember = (value: Capture) => { const prior = captures.get(value.path); need(prior === undefined || same(witness(prior), witness(value)), "previously authenticated source changed during inspection"); captures.set(value.path, value); return value; };
  const artifacts: Record<string, Capture> = {};
  for (const [key, value] of Object.entries(request)) if (typeof value === "object" && !("absent" in value)) artifacts[key] = remember(await pinned(value as Pin));
  const close = json(artifacts.normalCloseVerification!.data), closed = json(artifacts.normalCloseResponse!.data);
  const failure = json(artifacts.failureObservation!.data), session = json(artifacts.failedSession!.data);
  const resumeRequest = json(artifacts.resumeRequest!.data), resumed = json(artifacts.resumeResponse!.data);
  const outline = rollback ? undefined : json(artifacts.outlineRequest!.data);
  need(close.projectId === request.projectId && close.checkpointExists === true && Array.isArray(close.remainingLeaseUnsafeLocks)
    && close.remainingLeaseUnsafeLocks.length === 0 && (rollback || close.nativeBoardMaterialized === false), "prior normal-close evidence does not establish its required clean PCB state");
  need(closed.isError === false && closed.result?.structuredContent?.status === "closed" && closed.result.structuredContent.projectId === request.projectId, "normal-close response is not successful for this project");
  const evidenceBase = path.dirname(path.dirname(path.dirname(root)));
  need(typeof close.normalWorkspaceCloseResponse === "string" && path.resolve(evidenceBase, close.normalWorkspaceCloseResponse) === artifacts.normalCloseResponse!.path, "normal-close evidence names a different response");
  need(resumeRequest.name === "evleda_resume_project" && resumeRequest.arguments?.projectId === request.projectId
    && resumed.isError === false && resumed.result?.structuredContent?.status === "opened" && resumed.result.structuredContent.resumed === true
    && resumed.result.structuredContent.projectId === request.projectId && resumed.result.structuredContent.projectPath === project
    && resumed.result.structuredContent.outputPath === output, "failed session has no exact successful project resume");
  need(resumed.request?.path === artifacts.resumeRequest!.path && resumed.request.identity?.digest === artifacts.resumeRequest!.sha256
    && resumed.request.identity?.size === artifacts.resumeRequest!.bytes, "resume response does not bind its request bytes");
  const sessionDir = path.dirname(artifacts.failedSession!.path);
  const sessionRoles = sync ? ["resumeRequest", "resumeResponse", ...(!rollback ? ["outlineRequest", "outlineResponse"] : []), "syncRequest", "syncResponse", "closeRequest", "closeResponse", "statusRequest", "statusResponse"]
    : ["resumeRequest", "resumeResponse", "outlineRequest", "failureWire", "failedResponse", "failedTerminal"];
  need(sessionRoles.every(key => path.dirname(artifacts[key]!.path) === sessionDir)
    && Array.isArray(session.serverArgs) && session.serverArgs.includes("--edit")
    && session.serverArgs[session.serverArgs.indexOf("--workspace-root") + 1] === path.dirname(path.dirname(root)), "session/project authority paths differ");
  let times: number[];
  if (!sync) {
  const wire = json(artifacts.failureWire!.data);
  need(outline!.operation === "call" && outline!.name === "pcb_set_board_outline" && failure.projectId === request.projectId
    && failure.operation === outline!.name && failure.requestId === outline!.id && failure.mutationsRetried === false
    && failure.leaseOrLocksRemoved === false && failure.sourceOrCheckpointManuallyRestored === false
    && typeof failure.clientTerminalObservation === "string" && failure.clientTerminalObservation.includes("ENOSPC"), "evidence is not the supported preserved disk-full outline failure");
  need(typeof failure.sessionEvidence === "string" && path.resolve(path.dirname(evidenceBase), failure.sessionEvidence) === sessionDir
    && typeof failure.hostBuild === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(failure.hostBuild)
    && typeof session.host === "string" && session.host.replaceAll("\\", "/").endsWith(`/${failure.hostBuild}/dist/src/mcp/toolbox-workspace-main.js`)
    && failure.responseAndTerminalEvidenceFilesEmpty === true && artifacts.failedResponse!.bytes === 0 && artifacts.failedTerminal!.bytes === 0,
  "failed host/session or damaged response artifacts differ");
  need(wire.message?.result?.isError === true && wire.message.result.structuredContent?.error === "The existing CAD save/readback boundary failed.", "missing exact native save/readback failure receipt");
  times = [closed.recordedAt, close.recordedAt, session.startedAt, resumed.recordedAt, wire.receivedAt, failure.recordedAt].map(value => Date.parse(value));
  } else {
    const roles = [...(!rollback ? [["outlineRequest", "outlineResponse", "pcb_set_board_outline"] as const] : []), ["syncRequest", "syncResponse", "fresh_sync_from_schematic"],
      ["closeRequest", "closeResponse", "evleda_close_project"], ["statusRequest", "statusResponse", "evleda_workspace_status"]] as const;
    for (const [input, response, name] of roles) {
      const requested = json(artifacts[input]!.data), returned = json(artifacts[response]!.data);
      need(requested.operation === "call" && requested.name === name && returned.disposition === "response"
        && returned.request?.path === artifacts[input]!.path && returned.request.identity?.digest === artifacts[input]!.sha256
        && returned.request.identity?.size === artifacts[input]!.bytes, "pre-sync response does not bind its exact public request");
      if (name === "evleda_close_project") need(requested.arguments?.projectId === request.projectId, "failed close names another project");
      if (["fresh_sync_from_schematic", "evleda_workspace_status"].includes(name)) need(same(requested.arguments, {}), "unexpected pre-sync/status arguments");
    }
    const outlined = rollback ? undefined : json(artifacts.outlineResponse!.data), failed = json(artifacts.syncResponse!.data), closeFailed = json(artifacts.closeResponse!.data);
    const status = json(artifacts.statusResponse!.data), shutdown = json(artifacts.shutdownObservation!.data);
    const body = outlined?.result?.structuredContent;
    if (!rollback) need(outlined!.isError === false && body?.operation === "pcb_set_board_outline" && body.noGovernedEffect === false
      && body.result?.isError !== true && body.persistence?.isError !== true
      && same(json(Buffer.from(body.result.content)), { result: "Board outline added successfully." })
      && same(json(Buffer.from(body.persistence.content)), { result: "Board saved." }), "outline has no exact positive native save receipt");
    need(failed.isError === true && closeFailed.isError === true
      && (rollback ? typeof closeFailed.result?.structuredContent?.error === "string" && closeFailed.result.structuredContent.error.length > 0
        : closeFailed.result?.structuredContent?.error === "Project lease retained because native finalization/checkpoint requires review.")
      && status.isError === false && status.result?.structuredContent?.nativeState === "uncertain"
      && status.result.structuredContent.activeProject?.projectId === request.projectId && status.result.structuredContent.activeProject.phase === "needs-review",
    "pre-sync failure has no failed-close/needs-review chain");
    need(shutdown.projectId === request.projectId && shutdown.ownedHostObservedAbsent === true && Number.isSafeInteger(shutdown.ownedHostPid)
      && Array.isArray(shutdown.nativeEditors) && shutdown.nativeEditors.length === 0 && shutdown.clientInterruptedAfterFailedNormalClose === true
      && shutdown.normalNativeCheckpointClose === false && shutdown.leaseAndUnsafeMarkerRetained === true
      && (orphanLocks ? shutdown.editorLocksObservedAbsentAfterClose === false && shutdown.ownedEditorForciblyTerminated === true
        && shutdown.ownedSidecarObservedAbsent === true && Number.isSafeInteger(shutdown.ownedSidecarPid) && shutdown.ownedSidecarPid > 0
        : shutdown.editorLocksObservedAbsentAfterClose === true),
    "pre-sync operator shutdown evidence is incomplete or claims normal checkpoint closure");
    if (rollback) need(failure.projectId === request.projectId && failure.failedOperation === "fresh_sync_from_schematic"
      && failure.normalCloseFailed === true && failure.mutationsRetried === false && failure.recoveryApplied === false
      && same(failure.currentPcb, request.currentPcb), "checkpoint rollback has no pinned failed-sync/current-PCB provenance");
    else need(failure.projectId === request.projectId && failure.failedOperation === "fresh_sync_from_schematic" && failure.failureStage === "contract-board-feature-staging"
      && failure.nativeElectricalSyncCalled === false && failure.noMutationRetried === true && failure.noRecoveryApplied === true
      && failure.publicResult === failed.result?.structuredContent?.error && failure.normalCloseResult === closeFailed.result.structuredContent.error,
    "unsupported pre-native-sync failure observation");
    times = [closed.recordedAt, close.recordedAt, session.startedAt, resumed.recordedAt, ...(!rollback ? [outlined!.recordedAt] : []), failed.recordedAt,
      closeFailed.recordedAt, status.recordedAt, failure.recordedAt, shutdown.recordedAt].map(value => Date.parse(value));
  }
  need(times.every(Number.isFinite) && times.every((value, index) => index === 0 || value >= times[index - 1]!), "ownership evidence chronology differs");
  const take = async (file: string) => remember(await capture(file));
  const marker = json((await take(path.join(output, ".evleda-pcb-agent-fresh.json"))).data);
  const checkpointPath = path.join(output, ".evleda-pcb-agent-checkpoint.json"), bundlePath = path.join(output, "toolbox-design-bundle.json");
  need(marker.schemaVersion === "evleda.pcb-agent-fresh-project.v3" && marker.workflowKind === "plane" && marker.projectPath === project
    && marker.outputPath === output && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(marker.name), "unsupported project marker or path");
  const projectDirectory = (await directoryChain(project))[0]!;
  need(same(marker.projectIdentity, { canonicalPath: project, dev: projectDirectory.dev, ino: projectDirectory.ino }) && resumed.result.structuredContent.name === marker.name, "marker directory identity or resumed project name differs");
  const pcbPath = path.join(project, `${marker.name}.kicad_pcb`);
  if (!sync) {
  const amendment = json(artifacts.processAmendment!.data), editor = amendment.editor;
  need(amendment.schemaVersion === "evleda.offline-recovery-process-amendment.v1" && amendment.projectId === request.projectId
    && same(amendment.originalFailureObservation, request.failureObservation) && amendment.correctedAssertion === "nativeEditorsObservedAbsent"
    && amendment.originalAssertionWasIncorrect === true && editor?.boardPath === pcbPath && Number.isSafeInteger(editor.pid) && editor.pid > 0
    && typeof editor.executablePath === "string" && path.isAbsolute(editor.executablePath) && /^pcbnew\.exe$/iu.test(path.basename(editor.executablePath))
    && Date.parse(editor.createdAt) >= times[2]! && Date.parse(editor.createdAt) <= times[3]!, "missing exact correction of the erroneous historical editor-absence observation");
  const exitFile = remember(await pinned(pin.parse(amendment.exitReceipt))), exited = json(exitFile.data);
  need(exited.schemaVersion === "evleda.offline-recovery-editor-exit.v1" && exited.projectId === request.projectId && same(exited.editor, editor)
    && exited.observedExited === true && exited.normalNativeClose === false && exited.checkpointChangedByOperator === false
    && exited.leaseOrLocksRemoved === false && exited.sourceRestored === false
    && Date.parse(exited.recordedAt) >= times[5]! && Date.parse(amendment.recordedAt) >= Date.parse(exited.recordedAt), "exact owned-editor exit receipt is absent or inconsistent");
  }
  const sourcePaths = ["fp-lib-table", `${marker.name}.kicad_dru`, `${marker.name}.kicad_pcb`, `${marker.name}.kicad_pro`, `${marker.name}.kicad_sch`, "sym-lib-table"].map(file => path.join(project, file));
  const expectedFiles = [...sourcePaths, bundlePath, checkpointPath].sort();
  need(Array.isArray(close.files) && Array.isArray(failure.files) && same(close.files.map((f: any) => f.path).sort(), expectedFiles)
    && same(failure.files.map((f: any) => f.path).sort(), expectedFiles), "normal-close/failure source inventory is incomplete or unexpected");
  for (const row of close.files) {
    const failed = failure.files.find((f: any) => f.path === row.path), current = await take(row.path);
    if (sync) {
      need(failed.lastNormalCloseSha256 === row.sha256 && failed.sha256 === current.sha256 && failed.bytes === current.bytes, "pre-sync failure source differs from its pinned observation");
      if (rollback && row.path === pcbPath) need(request.currentPcb.path === pcbPath && request.currentPcb.sha256 === current.sha256 && request.currentPcb.bytes === current.bytes
        && failed.matchesLastNormalClose === (current.sha256 === row.sha256 && current.bytes === row.bytes), "current PCB pin or prior-checkpoint comparison differs");
      else need(row.path === pcbPath ? current.bytes > 0 && current.sha256 !== row.sha256 && failed.matchesLastNormalClose === false : current.sha256 === row.sha256 && current.bytes === row.bytes && failed.matchesLastNormalClose === true, "another governed file changed or outlined preimage is missing");
    } else {
      need(failed.sha256 === row.sha256 && failed.bytes === row.bytes && failed.observedSha256 === current.sha256 && failed.observedBytes === current.bytes, "failure observation or baseline source differs");
      need(row.path === pcbPath ? current.bytes === 0 && failed.matchesLastNormalClose === false : current.sha256 === row.sha256 && current.bytes === row.bytes && failed.matchesLastNormalClose === true, "another governed file changed or PCB is not the supported zero-byte failure");
    }
  }
  const checkpoint = json(captures.get(checkpointPath)!.data), bundle = json(captures.get(bundlePath)!.data);
  need(checkpoint.schemaVersion === "evleda.pcb-agent-fresh-project-checkpoint.v3" && checkpoint.reason === "run_exit"
    && checkpoint.projectPath === project && checkpoint.baselineMarkerSha256 === captures.get(path.join(output, ".evleda-pcb-agent-fresh.json"))!.sha256, "checkpoint does not authenticate the unchanged baseline marker");
  need(checkpoint.reportPath === path.join(output, "pcb-agent-report.json"), "checkpoint report path differs");
  const reportFile = await take(checkpoint.reportPath), report = json(reportFile.data);
  need(reportFile.sha256 === checkpoint.reportSha256 && report.status === checkpoint.reportStatus && report.projectPath === project, "checkpoint report differs");
  checkIdentity(bundle); checkIdentity(marker.planeBinding); checkIdentity(marker.planeBinding.bundleRef);
  need(bundle.schemaVersion === "evleda.pcb-design-compilation-bundle.v2" && same(marker.planeBinding.identity, checkpoint.planeBindingIdentity)
    && same(marker.planeBinding.bundleRef, report.workflow?.bundleRef) && report.workflow?.bundlePath === bundlePath
    && same(marker.planeBinding.bundleRef.bundleIdentity, bundle.identity)
    && same(marker.planeBinding.bundleRef.contentIdentity, contentIdentity(captures.get(bundlePath)!.data)), "bundle, checkpoint and project authority disagree");
  need(same(Object.values(checkpoint.files).map((f: any) => f.path).sort(), sourcePaths.slice().sort()), "checkpoint source inventory differs");
  for (const entry of Object.values(checkpoint.files) as Array<{ path: string; sha256: string }>) {
    const prior = close.files.find((f: any) => f.path === entry.path);
    need(prior?.sha256 === entry.sha256, "normal-close sources disagree with checkpoint");
  }
  need(artifacts.backup!.sha256 === checkpoint.files.pcb.sha256 && artifacts.backup!.bytes === close.files.find((f: any) => f.path === pcbPath).bytes
    && artifacts.backup!.bytes > 0 && !contains(root, artifacts.backup!.path), "backup is not the exact independent checkpoint PCB");
  const lockPaths = [path.join(project, `~${marker.name}.kicad_pcb.lck`), path.join(project, `~${marker.name}.kicad_pro.lck`), path.join(root, ".toolbox-lease.json")];
  need(same([request.expectedBoardLock.path, request.expectedProjectLock.path, request.expectedLease.path], lockPaths), "reviewed lease/lock paths differ");
  const lease = json(artifacts.expectedLease!.data);
  need(same(Object.keys(lease).sort(), ["nonce", "schemaVersion"]) && lease.schemaVersion === "evleda.toolbox-owned-lock.v1" && uuid.safeParse(lease.nonce).success, "unsupported lease contents");
  for (const file of sync && !orphanLocks ? [lockPaths[2]!] : lockPaths) {
    const owned = captures.get(file)!;
    const born = Number(BigInt(owned.physical.birthtimeNs) / 1_000_000n);
    need(owned.bytes > 0 && owned.bytes <= 16_384 && born >= times[sync ? 2 : 1]! && born <= times[sync ? 3 : 5]!, "retained lock is outside the reviewed ownership interval");
  }
  if (orphanLocks) {
    const observed = json(artifacts.orphanEditorObservation!.data), terminated = json(artifacts.ownedEditorTermination!.data);
    const shutdown = json(artifacts.shutdownObservation!.data), editor = observed.native;
    const stamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,7}Z$/u.test(value) && Number.isFinite(Date.parse(value));
    need(observed.hostPresent === false && Number.isSafeInteger(observed.clientTerminalExitCode) && observed.clientTerminalExitCode === shutdown.clientExecExitCode
      && Number.isSafeInteger(editor?.pid) && editor.pid > 0 && Number.isSafeInteger(editor.parentPid) && editor.parentPid > 0
      && [shutdown.ownedHostPid, shutdown.ownedSidecarPid].includes(editor.parentPid), "orphan observation lacks the exact stopped-client/owned-parent relationship");
    need(stamp(editor.creationUtc) && stamp(editor.kernelStartUtc) && stamp(terminated.verifiedCreationUtc)
      && stamp(terminated.verifiedKernelStartUtc ?? terminated.verifiedCreationUtc)
      && editor.pid === terminated.pid && editor.creationUtc === terminated.verifiedCreationUtc
      && editor.kernelStartUtc === (terminated.verifiedKernelStartUtc ?? terminated.verifiedCreationUtc), "orphan/termination PID or exact CIM/kernel start identities differ");
    const expectedEditor = typeof report.native?.kicad?.path === "string" && path.isAbsolute(report.native.kicad.path)
      ? path.join(path.dirname(report.native.kicad.path), "pcbnew.exe") : undefined;
    need(expectedEditor !== undefined && editor.executable === expectedEditor && terminated.executable === editor.executable
      && typeof editor.commandLine === "string" && editor.commandLine.length <= 32768 && !/[\0\r\n]/u.test(editor.commandLine)
      && terminated.commandLine === editor.commandLine, "orphan/termination executable or command line differs from the checkpoint toolchain");
    const argv = commandArguments(editor.commandLine);
    need(argv.length === 2 && argv[0] === expectedEditor && argv[1] === pcbPath, "orphan argv is not the exact editor and target PCB pair");
    need(terminated.normalClosePreviouslyFailed === true && terminated.failedBoardPreviouslyArchived === true && terminated.forcedOwnedShutdown === true
      && terminated.waitForExitReturned === true && terminated.leaseOrMarkerRemoved === false && terminated.pcbSha256After === request.currentPcb.sha256,
    "owned termination lacks confirmed exit, unchanged PCB or retained bookkeeping proof");
    const observedAt = Date.parse(observed.recordedAt), terminatedAt = Date.parse(terminated.recordedAt), closeAt = Date.parse(json(artifacts.closeResponse!.data).recordedAt);
    need(Number.isFinite(observedAt) && Number.isFinite(terminatedAt) && Date.parse(editor.creationUtc) >= times[2]! && Date.parse(editor.creationUtc) <= times[3]!
      && closeAt <= observedAt && observedAt <= terminatedAt && terminatedAt <= Date.parse(shutdown.recordedAt), "orphan launch/failed-close/termination/shutdown chronology differs");
    need(Array.isArray(observed.locks) && observed.locks.length === 2 && same(observed.locks.map((lock: any) => ({ path: lock.FullName, bytes: lock.Length })).sort((a: any, b: any) => a.path.localeCompare(b.path)),
      [request.expectedBoardLock, request.expectedProjectLock].map(lock => ({ path: lock.path, bytes: lock.bytes })).sort((a, b) => a.path.localeCompare(b.path))), "orphan observation does not bind the exact retained editor-lock pair");
    for (const file of lockPaths.slice(0, 2)) need(Number(BigInt(captures.get(file)!.physical.birthtimeNs) / 1_000_000n) >= Date.parse(editor.creationUtc), "editor lock predates the verified owned editor");
  }
  let allowedUnsafe: string | undefined;
  if (sync) {
    const diagnostic = json(artifacts.syncDiagnostic!.data); checkIdentity(diagnostic);
    need(artifacts.syncDiagnostic!.path === path.join(output, ".evleda-mcp-output", path.basename(artifacts.syncDiagnostic!.path))
      && /^sync-diagnostic-primary-failure-[a-f0-9-]{36}\.json$/u.test(path.basename(artifacts.syncDiagnostic!.path))
      && same(failure.privateDiagnostic, request.syncDiagnostic), "private sync diagnostic is not its exact retained artifact");
    need(diagnostic.schemaVersion === "evleda.fresh-sync-failure-diagnostic.v1" && diagnostic.phase === "primary-failure"
      && (rollback ? typeof diagnostic.stage === "string" && diagnostic.stage.length > 0 && diagnostic.stage.length <= 256 : diagnostic.stage === "contract-board-feature-staging")
      && same(diagnostic.projectBindingIdentity, marker.planeBinding.identity)
      && same(diagnostic.freshMarkerContentIdentity, contentIdentity(captures.get(path.join(output, ".evleda-pcb-agent-fresh.json"))!.data))
      && same(diagnostic.contractIdentity, createFreshConnectivityContract(bundle.contract, bundle.externalPowerBinding, bundle.derivedPowerBinding).identity),
    "diagnostic stage or complete project/contract authority differs");
    const capturedSlot = z.object({ status: z.literal("captured"), text: z.string().refine(text => text.isWellFormed()),
      contentIdentity: z.object({ algorithm: z.literal("sha256"), digest, size: z.number().int().min(0).max(MAX_FILE) }).strict() }).strict();
    const unavailableSlot = z.object({ status: z.literal("unavailable"), reason: z.string().min(1).max(4096) }).strict();
    const capturedText = (role: string): Buffer => { const value = capturedSlot.parse(diagnostic[role]);
      need(same(contentIdentity(value.text), value.contentIdentity), `diagnostic ${role} has no exact complete capture`); return Buffer.from(value.text); };
    if (rollback) {
      // Provenance is archived and checked for internal/source association only.
      // No stage, primary text, or returned native result authorizes restoration.
      for (const role of ["beforePcb", "savedPcbAtFailure", "schematicInput", "primary", "nativeNetlistBefore", "nativeResponseJson", "nativeNetlistAfter", "savedPcb", "livePcb"]) {
        if (diagnostic[role]?.status === "captured") capturedText(role);
        else need(unavailableSlot.safeParse(diagnostic[role]).success, "diagnostic slot contradicts its capture status");
      }
      const born = Number(BigInt(artifacts.syncDiagnostic!.physical.birthtimeNs) / 1_000_000n);
      const requested = Number(BigInt(artifacts.syncRequest!.physical.birthtimeNs) / 1_000_000n);
      need(born >= requested && born <= times[times.length - 1]!, "failure diagnostic is outside the reviewed sync/shutdown interval");
      if (request.observedFailurePcb !== undefined) {
        const observed = artifacts.observedFailurePcb!;
        need(!contains(root, observed.path) && observed.path !== request.backup.path
          && ["savedPcbAtFailure", "savedPcb", "livePcb"].some(role => diagnostic[role]?.status === "captured" && capturedText(role).equals(observed.data)),
        "optional observed failed PCB is not an independent exact diagnostic capture");
      }
    } else {
    const before = capturedText("beforePcb"), failedPcb = capturedText("savedPcbAtFailure"), primary = json(capturedText("primary"));
    need(before.equals(failedPcb) && before.equals(captures.get(pcbPath)!.data)
      && capturedText("schematicInput").equals(captures.get(path.join(project, `${marker.name}.kicad_sch`))!.data), "diagnostic preimage/current PCB or schematic differs");
    capturedText("nativeNetlistBefore");
    need(["nativeResponseJson", "nativeNetlistAfter", "savedPcb", "livePcb"].every(role => unavailableSlot.safeParse(diagnostic[role]).success)
      && primary.name === "Error" && primary.message === "Board features: missing board feature H1"
      && bundle.contract.boardFeatures?.some((feature: any) => feature.reference === "H1")
      && failure.publicResult === `FRESH_SYNC_ROLLED_BACK_TERMINAL: ${primary.message} Exact disk and live board preimage restored; close this editing session.`,
    "failure is not the supported pre-native-sync rejection with explicit restored-preimage result");
    const source = before.toString("utf8"), rectangles = parseFreshPcbSourceDocument(source).children.filter(node => node.name === "gr_rect");
    need(rectangles.length === 1, "pre-sync preimage must contain one exact added outline");
    const rectangle = rectangles[0]!, ids = rectangle.children.filter(node => node.name === "uuid"), id = ids[0]?.values[0]?.value;
    need(ids.length === 1 && id !== undefined && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id), "outline has no exact native identity");
    const board = bundle.contract.scope.board, expected = `(gr_rect (start 0 0) (end ${board.widthMm} ${board.heightMm}) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "${id}"))`;
    need(same(outline!.arguments, { width_mm: board.widthMm, height_mm: board.heightMm, origin_x_mm: 0, origin_y_mm: 0 })
      && freshBoardSerializationsEqual(`(kicad_pcb ${source.slice(rectangle.start, rectangle.end)})`, `(kicad_pcb ${expected})`)
      && freshBoardSerializationsEqual(source.slice(0, rectangle.start) + source.slice(rectangle.end), artifacts.backup!.data.toString("utf8")),
    "outlined preimage differs from checkpoint by more than its one exact contract rectangle");
    }
    allowedUnsafe = path.join(output, ".evleda-pcb-agent-unsafe-terminal.json");
    need(request.expectedUnsafeMarker.path === allowedUnsafe, "unsafe marker is not the exact reviewed project marker");
    z.object({ schemaVersion: z.literal("evleda.pcb-agent-unsafe-terminal.v1"), projectPath: z.literal(project), reportPath: z.literal(checkpoint.reportPath),
      reportSha256: z.literal(checkpoint.reportSha256), reason: z.literal("Toolbox checkpoint or owned teardown was not confirmed; explicit recovery is required.") }).strict().parse(json(artifacts.expectedUnsafeMarker!.data));
    const unsafeBorn = Number(BigInt(artifacts.expectedUnsafeMarker!.physical.birthtimeNs) / 1_000_000n);
    const closeRequested = Number(BigInt(artifacts.closeRequest!.physical.birthtimeNs) / 1_000_000n);
    need(unsafeBorn >= closeRequested && unsafeBorn <= times[times.length - 1]! && same(failure.retainedArtifacts,
      [request.expectedLease, request.expectedUnsafeMarker, request.expectedBoardLock, request.expectedProjectLock]), "retained marker/lease/absence evidence or close interval differs");
    if (!orphanLocks) for (const file of lockPaths.slice(0, 2)) await assertAbsent(file);
  }
  const allocation = json((await take(path.join(root, "allocation.json"))).data);
  need(allocation.schemaVersion === "evleda.toolbox-workspace-allocation.v1" && allocation.projectId === request.projectId && allocation.name === marker.name, "workspace allocation differs");
  const inputDraft = await take(path.join(root, "input", "draft.json"));
  need(inputDraft.data.toString("utf8") === canonicalJson(json(inputDraft.data)) && same(contentIdentity(inputDraft.data), allocation.draftIdentity)
    && typeof allocation.originalPrompt === "string" && same(contentIdentity(allocation.originalPrompt), bundle.originalPromptContentIdentity), "allocation draft/prompt identity differs");
  const directories: Directory[] = await directoryChain(request.archiveRoot);
  let scanned = 0;
  const scan = async (folder: string, depth = 0): Promise<void> => {
    need(++scanned <= 512 && depth <= 16, "directory inventory exceeds bounded recovery scope");
    directories.push((await directoryChain(folder))[0]!);
    for (const item of await readdir(folder, { withFileTypes: true })) {
      need(++scanned <= 512, "entry inventory exceeds bounded recovery scope");
      need(!item.isSymbolicLink() && !/unsafe|recovery/iu.test(item.name), "unsupported link or unsafe/recovery marker");
      const target = path.join(folder, item.name);
      if (item.isDirectory()) await scan(target, depth + 1); else { need(item.isFile(), "unsupported filesystem entry"); await take(target); }
      need(captures.size <= 512 && [...captures.values()].reduce((sum, f) => sum + f.bytes, 0) <= MAX_TOTAL, "inspection inventory exceeds bounded recovery scope");
    }
  };
  for (const folder of [root, output]) for (const item of await readdir(folder)) need(!/unsafe|recovery/iu.test(item) || path.join(folder, item) === allowedUnsafe, "unsafe/recovery marker blocks offline recovery");
  await scan(project); await scan(path.join(root, "input"));
  for (const file of captures.values()) for (const dir of await directoryChain(path.dirname(file.path))) if (!directories.some(old => old.path === dir.path)) directories.push(dir);
  return { request, pcbPath, captures: [...captures.values()].sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort((a, b) => a.path.localeCompare(b.path)),
    ...(sync && !orphanLocks ? { absentPaths: lockPaths.slice(0, 2) } : {}) };
}
/** Pure size arithmetic; no filesystem or recovery authority is conferred. */
export function pcbCheckpointRollbackBudget(capturedBytes: number, backupBytes: number, metadataBytes: number) {
  need([capturedBytes, backupBytes, metadataBytes].every(value => Number.isSafeInteger(value) && value >= 0), "invalid checkpoint rollback size accounting");
  const archiveAndTemporaryBytes = capturedBytes + backupBytes + 2 * metadataBytes + 1024 * 1024;
  need(Number.isSafeInteger(archiveAndTemporaryBytes) && archiveAndTemporaryBytes <= ROLLBACK_WORK_LIMIT, "checkpoint rollback archive/temp exceeds its 5 MiB scope");
  return { archiveAndTemporaryBytes, requiredFreeBytes: ROLLBACK_RESERVE + archiveAndTemporaryBytes };
}
export async function inspectRecovery(request: unknown, hooks: RecoveryHooks = {}): Promise<RecoveryPlan> {
  const parsed = anyRequestSchema.parse(request), workspaceRoot = path.dirname(path.dirname(parsed.projectRoot));
  await quiescent(hooks, workspaceRoot); const state = await inspect(parsed); await quiescent(hooks, workspaceRoot);
  const capturedBytes = state.captures.reduce((sum, f) => sum + f.bytes, 0), backupBytes = state.captures.find(f => f.path === state.request.backup.path)!.bytes;
  const version = isOrphanRollbackRequest(parsed) ? ORPHAN_ROLLBACK_VERSION : isRollbackRequest(parsed) ? ROLLBACK_VERSION : isSyncRequest(parsed) ? SYNC_VERSION : VERSION;
  const base = { schemaVersion: version as RecoveryPlan["schemaVersion"], request: state.request, pcbPath: state.pcbPath, files: state.captures.map(witness), directories: state.directories,
    ...(state.absentPaths === undefined ? {} : { absentPaths: state.absentPaths }), ownershipBasis: "operator-approved exact orphan artifacts; not original nonce ownership" as const };
  const payload = isRollbackRequest(parsed)
    ? { ...base, discardAllCurrentPcbChanges: true as const, ...pcbCheckpointRollbackBudget(capturedBytes, backupBytes, Buffer.byteLength(canonicalJson(base))) }
    : { ...base, requiredFreeBytes: RESERVE + 3 * capturedBytes + 2 * backupBytes + 1024 * 1024 };
  return { ...payload, identity: canonicalIdentity(payload, version) };
}
async function writeExclusive(file: string, bytes: Buffer): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const copied = await capture(file); need(copied.sha256 === contentIdentity(bytes).digest && copied.bytes === bytes.length, "archive/write readback differs");
}
export async function applyRecovery(plan: RecoveryPlan, approval: { planIdentity: string; maintenanceConfirmed: true }, hooks: RecoveryHooks = {}): Promise<{ status: "restored-exact-checkpoint-pcb"; archive: string }> {
  checkIdentity(plan); need([VERSION, SYNC_VERSION, ROLLBACK_VERSION, ORPHAN_ROLLBACK_VERSION].includes(plan.schemaVersion) && approval.maintenanceConfirmed === true && approval.planIdentity === plan.identity.digest, "exact reviewed plan and exclusive maintenance confirmation are required");
  const rollback = isRollbackRequest(plan.request), orphanRequest = isOrphanRollbackRequest(plan.request) ? plan.request : undefined;
  const syncRequest = isSyncFailureRequest(plan.request) ? plan.request : undefined;
  if (rollback) need(plan.schemaVersion === (orphanRequest === undefined ? ROLLBACK_VERSION : ORPHAN_ROLLBACK_VERSION) && plan.discardAllCurrentPcbChanges === true,
    "the reviewed checkpoint rollback plan must explicitly discard ALL current PCB changes");
  const fresh = await inspectRecovery(plan.request, hooks); need(same(fresh, plan), "plan no longer matches every source, evidence, lock or physical identity");
  await diskRoom(plan.request.archiveRoot, plan.requiredFreeBytes, hooks); await diskRoom(path.dirname(plan.pcbPath), plan.requiredFreeBytes, hooks);
  const archive = path.join(plan.request.archiveRoot, `recovery-${plan.request.projectId}-${plan.identity.digest}`);
  await mkdir(archive); // Exclusive: a partial attempt is never silently retried.
  const archiveDirectory = (await directoryChain(archive))[0]!;
  let writtenWorkBytes = 0;
  const write = async (file: string, bytes: Buffer) => {
    if (rollback) {
      writtenWorkBytes += bytes.length;
      need(plan.archiveAndTemporaryBytes !== undefined && writtenWorkBytes <= plan.archiveAndTemporaryBytes && writtenWorkBytes <= ROLLBACK_WORK_LIMIT, "checkpoint rollback writes exceed the reviewed archive/temp bound");
    }
    await writeExclusive(file, bytes);
  };
  const archived: Witness[] = [];
  const assertArchiveAndDirectories = async () => {
    need(same((await directoryChain(archive))[0], archiveDirectory), "recovery archive directory identity changed");
    for (const file of archived) need(same(witness(await capture(file.path)), file), "recovery archive changed after durable capture");
    for (const dir of plan.directories) need(same((await directoryChain(dir.path))[0], dir), "bound directory identity changed");
  };
  let stage = "archive", temporary: string | undefined;
  const removed = new Set<string>();
  const assertInventory = async () => {
    for (const file of plan.absentPaths ?? []) await assertAbsent(file);
    for (const file of removed) await assertAbsent(file);
    for (const folder of [plan.request.projectRoot, path.join(plan.request.projectRoot, "output")]) for (const name of await readdir(folder)) need(!/unsafe|recovery/iu.test(name)
      || syncRequest !== undefined && path.join(folder, name) === syncRequest.expectedUnsafeMarker.path && !removed.has(path.join(folder, name)), "new unsafe/recovery marker blocks recovery");
    const roots = [path.dirname(plan.pcbPath), path.join(plan.request.projectRoot, "input")];
    const files: string[] = [], dirs: string[] = []; let entries = 0;
    const walk = async (folder: string, depth = 0): Promise<void> => {
      need(++entries <= 512 && depth <= 16, "current inventory exceeds recovery bounds"); dirs.push(folder);
      for (const item of await readdir(folder, { withFileTypes: true })) {
        need(++entries <= 512 && !item.isSymbolicLink(), "current inventory has links or exceeds recovery bounds");
        const file = path.join(folder, item.name);
        if (file === temporary) continue;
        need(!/unsafe|recovery/iu.test(item.name), "new recovery marker in project");
        if (item.isDirectory()) await walk(file, depth + 1); else { need(item.isFile(), "unsupported current entry"); files.push(file); }
      }
    };
    for (const folder of roots) await walk(folder);
    const selected = (file: string) => roots.some(root => contains(root, file));
    need(same(files.sort(), plan.files.filter(file => selected(file.path) && !removed.has(file.path)).map(file => file.path).sort())
      && same(dirs.sort(), [...new Set(plan.directories.filter(dir => selected(dir.path)).map(dir => dir.path))].sort()), "project/input inventory changed since review");
  };
  try {
    await write(path.join(archive, "plan.json"), Buffer.from(canonicalJson(plan)));
    archived.push(witness(await capture(path.join(archive, "plan.json"))));
    for (const [index, file] of plan.files.entries()) {
      const current = await capture(file.path); need(same(witness(current), file), "source changed before immutable archival");
      await write(path.join(archive, `${String(index).padStart(4, "0")}.bin`), current.data);
      archived.push(witness(await capture(path.join(archive, `${String(index).padStart(4, "0")}.bin`))));
    }
    await write(path.join(archive, "archive-complete.json"), Buffer.from(canonicalJson({ planIdentity: plan.identity, files: plan.files, state: "originals-durable-before-restore" })));
    archived.push(witness(await capture(path.join(archive, "archive-complete.json"))));
    await hooks.beforeStep?.("archived");
    need(same(await inspectRecovery(plan.request, hooks), plan), "plan changed during archive publication");
    stage = "restore"; const backup = await pinned(plan.request.backup);
    temporary = path.join(path.dirname(plan.pcbPath), `.${path.basename(plan.pcbPath)}.${plan.identity.digest}.recovery.tmp`);
    await write(temporary, backup.data);
    const temporaryWitness = witness(await capture(temporary));
    await hooks.beforeStep?.("temporary-ready");
    // No inspection helper is allowed to treat this utility's temporary file as a new authority.
    await quiescent(hooks, path.dirname(path.dirname(plan.request.projectRoot)));
    await assertArchiveAndDirectories();
    await assertInventory();
    for (const file of plan.files) need(same(witness(await capture(file.path)), file), "source changed before atomic PCB restoration");
    need(same(witness(await capture(temporary)), temporaryWitness), "temporary restore source changed before atomic replacement");
    await rename(temporary, plan.pcbPath); temporary = undefined;
    need((await capture(plan.pcbPath)).sha256 === plan.request.backup.sha256, "restored PCB differs from checkpoint bytes");
    await hooks.beforeStep?.("restored");
    stage = "release-reviewed-orphans";
    const receipt = async (name: string, state: string) => {
      const file = path.join(archive, name);
      await hooks.beforeStep?.(`before-${name}`);
      await write(file, Buffer.from(canonicalJson({ state, planIdentity: plan.identity, pcbIdentity: contentIdentity(backup.data),
        ...(syncRequest === undefined ? { removedEditorLocks: [...removed] } : { retiredArtifacts: [...removed],
          ...(orphanRequest === undefined ? { editorLocksRemainAbsent: true } : { reviewedOrphanEditorLocksRetired: [orphanRequest.expectedBoardLock.path, orphanRequest.expectedProjectLock.path].filter(file => removed.has(file)) }) }),
        checkpointUnchanged: true, normalResumeRequired: true, restoredSchematic: false })));
      archived.push(witness(await capture(file)));
    };
    await receipt("restore-verified.json", rollback ? "ALL archived current PCB changes discarded by operator decision; exact prior closed-checkpoint PCB restored and verified; reviewed marker and lease retained; no native rollback or normal close claimed"
      : syncRequest === undefined ? "PCB restored and verified; original orphan locks retained"
      : "Old checkpoint PCB restored and verified, discarding the archived saved outline; reviewed unsafe marker and lease retained; editor locks remain absent");
    const retirements: Pin[] = orphanRequest !== undefined ? [orphanRequest.expectedBoardLock, orphanRequest.expectedProjectLock, orphanRequest.expectedUnsafeMarker, orphanRequest.expectedLease] : syncRequest === undefined
      ? [(plan.request as RecoveryRequest).expectedBoardLock, (plan.request as RecoveryRequest).expectedProjectLock, plan.request.expectedLease]
      : [syncRequest.expectedUnsafeMarker, syncRequest.expectedLease];
    for (const [index, lock] of retirements.entries()) {
      const last = index === retirements.length - 1;
      if (last) {
        stage = "release-lease-last";
        await receipt("lease-release-intent.json", orphanRequest !== undefined ? "Exact earlier closed-checkpoint PCB and unchanged non-PCB sources verified; only reviewed orphan editor locks and terminal marker retired; lease removal intended, not yet observed; no native rollback or normal close claimed"
          : rollback ? "Exact earlier closed-checkpoint PCB and unchanged non-PCB sources verified; reviewed marker retired and locks remained absent; lease removal intended, not yet observed; no native rollback or normal close claimed"
          : syncRequest === undefined ? "PCB verified and editor locks released; exact original lease removal intended, not yet observed"
          : "Old checkpoint PCB verified; only reviewed unsafe marker retired; editor locks remained absent; exact lease removal intended, not yet observed; no normal close claimed");
      }
      const markerRetirement = syncRequest !== undefined && lock.path === syncRequest.expectedUnsafeMarker.path;
      if (markerRetirement) await receipt("unsafe-marker-retirement-intent.json", rollback
        ? "Exact earlier closed-checkpoint PCB verified; only this reviewed failed-sync terminal marker is scheduled for retirement under the explicit operator rollback decision"
        : "Exact checkpoint PCB verified; only the archived pre-sync unsafe marker is scheduled for retirement");
      await hooks.beforeStep?.(last ? "before-lease-release" : markerRetirement ? "before-unsafe-marker-retirement" : `before-editor-lock-${index + 1}-release`);
      await quiescent(hooks, path.dirname(path.dirname(plan.request.projectRoot)));
      await assertArchiveAndDirectories();
      await assertInventory();
      for (const file of plan.files) {
        if (removed.has(file.path)) continue;
        const current = await capture(file.path);
        need(file.path === plan.pcbPath ? current.sha256 === plan.request.backup.sha256 && current.bytes === plan.request.backup.bytes : same(witness(current), file), "source or reviewed orphan changed before release");
      }
      await unlink(lock.path);
      if (last) return { status: "restored-exact-checkpoint-pcb", archive }; // Last fallible operation; no later receipt/callback.
      removed.add(lock.path);
      await receipt(markerRetirement ? "unsafe-marker-retired.json" : `editor-lock-${index + 1}-released.json`,
        orphanRequest !== undefined && !markerRetirement ? "One exact reviewed orphan editor lock retired after checkpoint restore; terminal marker and original lease remain retained"
          : rollback ? "Only the reviewed failed-sync terminal marker retired after exact checkpoint rollback; original lease retained; no native rollback or normal close claimed"
          : syncRequest === undefined ? "One reviewed editor lock released; exact original lease retained" : "Only the archived pre-sync unsafe marker retired; exact original lease retained; no normal close is claimed");
    }
    throw new Error("Unreachable recovery release state");
  } catch (error) {
    // Retain partial archive/temp and all not-yet-released locks. The original
    // checkpoint and history are never rewritten to manufacture acceptance.
    throw new Error(`Offline recovery stopped at ${stage}: ${error instanceof Error ? error.message : String(error)}; preserve ${archive}${temporary === undefined ? "" : ` and ${temporary}`} and review before any retry.`, { cause: error });
  }
}
async function main(): Promise<void> {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: { request: { type: "string" }, "request-sha256": { type: "string" }, "request-bytes": { type: "string" },
    plan: { type: "string" }, "plan-sha256": { type: "string" }, "plan-bytes": { type: "string" }, apply: { type: "boolean", default: false }, "maintenance-confirmed": { type: "boolean", default: false }, "check-quiescence": { type: "boolean", default: false }, "workspace-root": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { process.stdout.write("Inspect (read-only): --request FILE --request-sha256 SHA256 --request-bytes N\nApply reviewed plan: --apply --plan FILE --plan-sha256 SHA256 --plan-bytes N --maintenance-confirmed\nMaintenance confirmation means all CAD/workspace activity and competing recovery attempts are excluded for the whole operation. This is an offline operator exception, never PID-based lease reclamation. No automatic retries or native launch.\n"); return; }
  if (values["check-quiescence"]) { need(!values.apply && values.request === undefined && values.plan === undefined, "quiescence check is an independent read-only mode"); const workspace = values["workspace-root"] === undefined ? undefined : (await directoryChain(path.resolve(values["workspace-root"])))[0]!.path; process.stdout.write(`${JSON.stringify(await observeProcesses(workspace))}\n`); return; }
  const prefix = values.apply ? "plan" : "request", filename = values[prefix], sha = values[`${prefix}-sha256`], size = values[`${prefix}-bytes`];
  need(typeof filename === "string" && typeof sha === "string" && typeof size === "string" && /^[1-9][0-9]*$/u.test(size), "supply exact input path, SHA-256 and byte count");
  const input = json((await pinned({ path: path.resolve(filename!), sha256: sha!, bytes: Number(size) })).data);
  if (!values.apply) process.stdout.write(`${JSON.stringify(await inspectRecovery(input), null, 2)}\n`);
  else {
    need(values["maintenance-confirmed"] === true, "exclusive maintenance confirmation is required");
    process.stdout.write(`${JSON.stringify(await applyRecovery(input as RecoveryPlan, { planIdentity: input.identity.digest, maintenanceConfirmed: true }))}\n`);
  }
}
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });

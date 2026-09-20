/** Trusted operator administration. Inspection writes evidence only; applying
 * an exact inspected plan creates a new allocation and never repairs the old
 * checkpoint/lease/quarantine files in place. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { parsePortableJsonBytes } from "../src/core/portable-artifact.js";
import { captureFreshRuntimeImportFile, readFreshDirectoryIdentity } from "../src/harness/fresh-project.js";
import { loadKicadToolboxFreshProfile } from "../src/mcp/toolbox-fresh-profile.js";
import { readKicadNativeProfile } from "../src/flux/production-composition.js";
import { createToolboxWorkspaceStore } from "../src/mcp/toolbox-workspace-store.js";
import { savedPlaneRecoveryRequestSchema, qualifySavedPlaneRecovery, executeQualifiedSavedPlaneRecovery } from "../src/mcp/toolbox-saved-plane-recovery.js";

function contains(root: string, value: string) {
  const relative = path.relative(path.resolve(root).toLowerCase(), path.resolve(value).toLowerCase());
  return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
function safeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 5) return { name: "UnclassifiedError" };
  const message = /token|authorization|password|secret|credential/iu.test(error.message) ? "Sensitive error text omitted" : error.message.slice(0, 2000);
  return { name: error.name, message, ...(error.cause === undefined ? {} : { cause: safeError(error.cause, depth + 1) }),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 16).map(value => safeError(value, depth + 1)) } : {}) };
}
async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    request: { type: "string" }, "request-sha256": { type: "string" }, "request-bytes": { type: "string" },
    "evidence-dir": { type: "string" }, apply: { type: "string" }, "maintenance-confirmed": { type: "boolean", default: false }, help: { type: "boolean" },
  } });
  if (values.help) {
    process.stdout.write("Usage: node --import tsx scripts/recover-saved-plane-candidate.ts --request <json> --request-sha256 <sha256> --request-bytes <size> --evidence-dir <existing-external-directory> [--apply <inspected-plan-digest> --maintenance-confirmed]\nInspection never starts CAD or alters a source allocation. Apply creates a separate native candidate from the verified saved state; original quarantine remains.\n"); return;
  }
  if (!values.request || !values["evidence-dir"] || !/^[a-f0-9]{64}$/u.test(values["request-sha256"] ?? "")
    || !/^[1-9][0-9]*$/u.test(values["request-bytes"] ?? "")) throw new Error("Pinned request and existing external evidence directory are required.");
  if (values.apply !== undefined && (!/^[a-f0-9]{64}$/u.test(values.apply) || !values["maintenance-confirmed"]))
    throw new Error("Apply requires the inspected plan digest and explicit maintenance exclusion.");
  const file = await captureFreshRuntimeImportFile({ path: path.resolve(values.request), contentIdentity: {
    algorithm: "sha256", digest: values["request-sha256"]!, size: Number(values["request-bytes"]) } }, 256 * 1024);
  const request = savedPlaneRecoveryRequestSchema.parse(parsePortableJsonBytes(file.bytes, { maxBytes: 256 * 1024, maxDepth: 32,
    maxNodes: 20000, maxArrayLength: 256, maxOwnKeys: 128, maxStringBytes: 4096, maxKeyBytes: 256 }));
  const profile = await loadKicadToolboxFreshProfile(request.profile), native = await readKicadNativeProfile(request.profile);
  const runtime = native.kicadMcpRuntime;
  const nativeFiles = [request.profile.path, runtime.runtimeBundle.manifest.path, runtime.lock.path,
    runtime.processTreeSupervision.terminator.path,
    ...(native.kicadTransmissionLine ? [native.kicadTransmissionLine.path] : []),
    ...(native.kicadReferenceCoverage ? [native.kicadReferenceCoverage.path] : []),
    ...(native.kicadPlaneContacts ? [native.kicadPlaneContacts.manifest.path, native.kicadPlaneContacts.helper.path] : [])];
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const nativeRoots = [repository, native.kicadToolchain.binRoot, runtime.runtimeBundle.root, runtime.runtimeParentRoot,
    runtime.ipcSocketParentRoot, ...nativeFiles, ...nativeFiles.map(file => path.dirname(file)),
    ...(native.kicadPlaneContacts ? [native.kicadPlaneContacts.runtimeRoot] : [])];
  const sourceProfile = request.schemaVersion === "evleda.saved-plane-artifact-recovery-request.v1"
    ? await loadKicadToolboxFreshProfile(request.sourceProfile) : undefined;
  if (request.schemaVersion === "evleda.saved-plane-artifact-recovery-request.v1") {
    const sourceNative = await readKicadNativeProfile(request.sourceProfile), sourceRuntime = sourceNative.kicadMcpRuntime;
    const files = [request.sourceProfile.path, sourceRuntime.runtimeBundle.manifest.path, sourceRuntime.lock.path,
      sourceRuntime.processTreeSupervision.terminator.path];
    nativeRoots.push(sourceNative.kicadToolchain.binRoot, sourceRuntime.runtimeBundle.root, sourceRuntime.runtimeParentRoot,
      sourceRuntime.ipcSocketParentRoot, ...files, ...files.map(value => path.dirname(value)), ...sourceProfile!.protectedRoots);
  }
  const protectedRoots = [...profile.protectedRoots, ...nativeRoots, file.path, request.targetIntent.path,
    request.session.path, ...(request.schemaVersion === "evleda.saved-plane-recovery-request.v1"
      ? [request.savedPlaneResponse.path, request.failedPlaneResponse.path, request.planeStage.path]
      : request.schemaVersion === "evleda.saved-field-recovery-request.v1"
        ? [request.savedPoseResponse.path, request.failedFieldResponse.path]
        : [request.sourceProfile.path, request.openedProjectResponse.path, request.savedTextResponse.path,
          request.failedPlaneResponse.path, request.liveObservation.path, request.checkedDiscardClose.path]), request.failedCloseResponse.path,
    request.clientTerminal.path, request.archivedLivePcb.path];
  if (protectedRoots.some(root => contains(root, request.workspaceRoot) || contains(request.workspaceRoot, root)))
    throw new Error("Workspace overlaps a protected native/profile/external-evidence root.");
  const allocation = await lstat(path.join(request.workspaceRoot, "projects", request.sourceProjectId, "allocation.json"));
  if (!allocation.isFile() || allocation.isSymbolicLink() || allocation.nlink !== 1) throw new Error("Source allocation is not an ordinary existing file.");
  const directory = path.resolve(values["evidence-dir"]);
  const directories = [];
  for (let at = directory;; at = path.dirname(at)) { directories.push(await readFreshDirectoryIdentity(at)); if (path.dirname(at) === at) break; }
  if ([request.workspaceRoot, ...nativeRoots, ...profile.protectedRoots].some(root => contains(root, directory)))
    throw new Error("Recovery evidence must be outside managed, source, runtime and profile roots.");
  const publish = async (label: string, value: unknown) => {
    for (const previous of directories) if (canonicalJson(previous) !== canonicalJson(await readFreshDirectoryIdentity(previous.canonicalPath)))
      throw new Error("Evidence directory changed");
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n"), target = path.join(directory, `${label}-${randomUUID()}.json`);
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); return { path: target, contentIdentity: contentIdentity(bytes) };
  };
  try {
    const store = await createToolboxWorkspaceStore({ workspaceRoot: request.workspaceRoot, protectedRoots });
    const capability = await qualifySavedPlaneRecovery(request, store, { loadProfile: async selected => {
      if (canonicalJson(selected) === canonicalJson(request.profile)) return profile;
      if (request.schemaVersion === "evleda.saved-plane-artifact-recovery-request.v1"
        && canonicalJson(selected) === canonicalJson(request.sourceProfile)) return sourceProfile!;
      throw new Error("Recovery requested an unreviewed profile.");
    } });
    const plan = await publish("saved-plane-recovery-plan", { requestPin: { path: file.path, contentIdentity: file.contentIdentity }, ...capability });
    if (values.apply === undefined) {
      process.stdout.write(JSON.stringify({ status: "inspected", planIdentity: capability.identity, evidence: plan, nativeStarted: false }) + "\n"); return;
    }
    const outcome = await executeQualifiedSavedPlaneRecovery(capability, { planIdentity: values.apply, maintenanceConfirmed: true });
    const evidence = await publish("saved-plane-recovery-result", outcome);
    process.stdout.write(JSON.stringify({ status: outcome.status, projectId: outcome.projectId, evidence }) + "\n");
  } catch (error) {
    const diagnostic = await publish("saved-plane-recovery-failure", { error: safeError(error), sourceNormalCloseClaim: false,
      originalQuarantineRetained: true, instruction: "Inspect any allocated target before retrying; no source quarantine was cleared." });
    process.stderr.write(JSON.stringify({ status: "failed", diagnostic }) + "\n"); process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { process.stderr.write(JSON.stringify({ status: "failed-before-inspection", error: safeError(error) }) + "\n"); process.exitCode = 1; });
}

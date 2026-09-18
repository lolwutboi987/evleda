/** Trusted host administration only. This script is never exposed as an MCP tool.
 * It opens only the newly allocated target after source/proof qualification. */
import { inspect, parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { captureFreshRuntimeImportFile, readFreshDirectoryIdentity } from "../src/harness/fresh-project.js";
import { canonicalJson, contentIdentity } from "../src/core/canonical.js";
import { parsePortableJsonBytes } from "../src/core/portable-artifact.js";
import { createToolboxWorkspaceStore } from "../src/mcp/toolbox-workspace-store.js";
import { runtimeSourceImportRequestSchema, qualifyRuntimeSourceImport, executeQualifiedRuntimeSourceImport, type RuntimeSourceImportRequest } from "../src/mcp/toolbox-runtime-source-import.js";
import { loadKicadToolboxFreshProfile } from "../src/mcp/toolbox-fresh-profile.js";
import { readKicadNativeProfile } from "../src/flux/production-composition.js";
import type { KicadMcpPinnedFileInput } from "../src/integrations/kicad-mcp-session.js";

/** Private means host-file-only, never original details in MCP/stderr replies.
 * Windows access follows the operator-selected directory's inherited ACL; the
 * POSIX 0600 mode is not a Windows DACL claim.
 * If fixed roots cannot be established from the pinned profiles, fail without
 * writing. An existing external evidence directory is required. */
export async function retainRuntimeImportAdminFailure(input: { directory: string; requestPin: KicadMcpPinnedFileInput;
  request: RuntimeSourceImportRequest; error: unknown }) {
  const request = runtimeSourceImportRequestSchema.parse(structuredClone(input.request)), directory = path.resolve(input.directory);
  const requestPin = structuredClone(input.requestPin);
  const requestCapture = await captureFreshRuntimeImportFile(requestPin, 256 * 1024);
  if (canonicalJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestCapture.bytes))) !== canonicalJson(request)) throw new Error("Private diagnostic request does not match its exact pin.");
  const protectedRoots: { path: string; kind: "directory" | "file" }[] = [request.workspaceRoot, fileURLToPath(new URL("../", import.meta.url)),
    path.dirname(request.sourceProfile.path), path.dirname(request.targetProfile.path), path.dirname(request.normalClose.session.path),
    path.dirname(request.normalClose.response.path)].map(directory => ({ path: path.resolve(directory), kind: "directory" }));
  const protect = (value: unknown, kind: "directory" | "file") => {
    if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) throw new Error("Incomplete or noncanonical protected root in pinned diagnostic profile.");
    protectedRoots.push({ path: value, kind });
    if (kind === "file") protectedRoots.push({ path: path.dirname(value), kind: "directory" });
  };
  const launches = [];
  for (const [side, pin] of [["source", request.sourceProfile], ["target", request.targetProfile]] as const) {
    const captured = await captureFreshRuntimeImportFile(pin, 2 * 1024 * 1024);
    const raw = parsePortableJsonBytes(captured.bytes, { maxBytes: 2 * 1024 * 1024, maxDepth: 32, maxNodes: 20000,
      maxArrayLength: 4096, maxOwnKeys: 256, maxKeyBytes: 256, maxStringBytes: 4096 }) as Record<string, any>;
    const runtime = raw.kicadMcpRuntime, bundle = runtime?.runtimeBundle, launch = runtime?.runtimePolicy?.pythonLaunch;
    for (const fixed of [bundle?.root, raw.kicadToolchain?.binRoot, runtime?.runtimeParentRoot, runtime?.ipcSocketParentRoot,
      raw.libraries?.symbolRoot, raw.libraries?.footprintRoot, raw.deepRules?.resourceRoot]) protect(fixed, "directory");
    for (const fixed of [bundle?.manifest?.path, runtime?.lock?.path, runtime?.processTreeSupervision?.terminator?.path]) protect(fixed, "file");
    if (raw.libraries?.approvedPackage !== undefined) protect(raw.libraries.approvedPackage?.root, "directory");
    if (raw.kicadPlaneContacts !== undefined) {
      protect(raw.kicadPlaneContacts?.runtimeRoot, "directory"); protect(raw.kicadPlaneContacts?.manifest?.path, "file"); protect(raw.kicadPlaneContacts?.helper?.path, "file");
    }
    if (raw.kicadTransmissionLine !== undefined) protect(raw.kicadTransmissionLine?.path, "file");
    if (raw.kicadReferenceCoverage !== undefined) protect(raw.kicadReferenceCoverage?.path, "file");
    const relative = bundle.expectedClosure?.entrypoint?.relativePath;
    const relativeSupported = typeof relative === "string" && relative.length > 0 && relative.length <= 1024 && !/[\\:\x00-\x1f\x7f]/u.test(relative)
      && !path.win32.isAbsolute(relative) && !path.posix.isAbsolute(relative)
      && relative.split("/").every((part: string) => part.length > 0 && part !== "." && part !== "..");
    const projectedPath = relativeSupported ? path.resolve(bundle.root, ...relative.split("/")) : undefined;
    const relativeResult = projectedPath === undefined ? undefined : path.relative(bundle.root, projectedPath);
    const supported = relativeResult !== undefined && relativeResult !== "" && relativeResult !== ".." && !relativeResult.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeResult);
    const arguments_ = supported ? ["-I", "-s", "-E", "-B", path.resolve(bundle.root, ...relative.split("/"))] : undefined;
    const expected = arguments_ === undefined ? undefined : createHash("sha256").update("evleda.kicad-mcp-arguments.v1\0").update(JSON.stringify(arguments_)).digest("hex");
    launches.push({ side, profile: pin, flags: Array.isArray(launch?.flags) ? launch.flags.slice(0, 8).map((value: unknown) => typeof value === "string" ? value.slice(0, 64) : typeof value) : null,
      argumentCount: typeof launch?.argumentCount === "number" && Number.isFinite(launch.argumentCount) ? launch.argumentCount : null,
      declaredArgumentsSha256: typeof launch?.argumentsSha256 === "string" ? launch.argumentsSha256.slice(0, 128) : null, expectedArgumentsSha256: expected,
      entrypointProjectionSupported: supported,
      argumentsHashMatches: expected !== undefined && launch?.argumentsSha256 === expected,
      explanation: "Diagnostic projection only; the real native profile reader decides admission." });
  }
  const contains = (root: string, candidate: string) => { const relative = path.relative(path.resolve(root).toLowerCase(), candidate.toLowerCase());
    return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
  for (const fixed of protectedRoots) {
    const metadata = await lstat(fixed.path);
    if (metadata.isSymbolicLink() || (fixed.kind === "directory" ? !metadata.isDirectory() : !metadata.isFile())
        || path.resolve(await realpath(fixed.path)).toLowerCase() !== fixed.path.toLowerCase()) throw new Error("Protected diagnostic root is missing, aliased or has the wrong type.");
    for (let cursor = path.dirname(fixed.path);; cursor = path.dirname(cursor)) {
      await readFreshDirectoryIdentity(cursor); if (path.dirname(cursor) === cursor) break;
    }
  }
  if (protectedRoots.some(root => contains(root.path, directory))) throw new Error("Private import diagnostics cannot write inside managed, source, runtime, profile or session roots.");
  const ancestry = [];
  for (let cursor = directory;; cursor = path.dirname(cursor)) {
    try { await lstat(path.join(cursor, ".git")); throw new Error("Private import diagnostics require an external non-checkout evidence directory."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ancestry.push(await readFreshDirectoryIdentity(cursor)); if (path.dirname(cursor) === cursor) break;
  }
  const detail = inspect(input.error, { depth: 6, maxArrayLength: 16, maxStringLength: 8192, getters: false, customInspect: false });
  const boundedDetail = Buffer.from(detail).subarray(0, 64 * 1024).toString("utf8");
  const body = { schemaVersion: "evleda.private-runtime-import-failure.v1", classification: "private-host-administration-diagnostic",
    visibility: "Host artifact only; original details are not returned over MCP or stderr. Windows access follows the selected directory's inherited ACL.",
    requestPin, sourceProjectId: request.sourceProjectId, targetProjectId: request.targetProjectId, launches,
    error: { detail: boundedDetail, truncated: Buffer.byteLength(detail) > 64 * 1024 }, nativeAcceptance: false };
  const bytes = Buffer.from(JSON.stringify(body, null, 2) + "\n"), file = path.join(directory, `runtime-import-failure-${randomUUID()}.json`);
  for (const expected of ancestry) if (canonicalJson(expected) !== canonicalJson(await readFreshDirectoryIdentity(expected.canonicalPath))) throw new Error("Private diagnostic directory changed before publication.");
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  for (const expected of ancestry) if (canonicalJson(expected) !== canonicalJson(await readFreshDirectoryIdentity(expected.canonicalPath))) throw new Error("Private diagnostic directory changed during publication; retained for review.");
  return Object.freeze({ path: file, contentIdentity: contentIdentity(bytes) });
}

/** Reject all fixed/native-root overlap before the store can create anything. */
export async function prepareRuntimeSourceImportStore(request: RuntimeSourceImportRequest, adminRequest: KicadMcpPinnedFileInput,
  readers: { loadDesign?: typeof loadKicadToolboxFreshProfile; readNative?: typeof readKicadNativeProfile } = {}) {
  request = runtimeSourceImportRequestSchema.parse(structuredClone(request));
  adminRequest = structuredClone(adminRequest);
  const load = readers.loadDesign ?? loadKicadToolboxFreshProfile, native = readers.readNative ?? readKicadNativeProfile;
  const [oldDesign, newDesign, oldNative, newNative] = await Promise.all([load(request.sourceProfile), load(request.targetProfile), native(request.sourceProfile), native(request.targetProfile)]);
  const nativeRoots = [oldNative, newNative].flatMap(profile => {
    const r = profile.kicadMcpRuntime;
    return [profile.path, profile.kicadToolchain.binRoot, r.runtimeBundle.root, r.runtimeBundle.manifest.path, r.lock.path,
      r.processTreeSupervision.terminator.path, r.runtimeParentRoot, r.ipcSocketParentRoot,
      ...(profile.kicadTransmissionLine === undefined ? [] : [profile.kicadTransmissionLine.path]),
      ...(profile.kicadReferenceCoverage === undefined ? [] : [profile.kicadReferenceCoverage.path]),
      ...(profile.kicadPlaneContacts === undefined ? [] : [profile.kicadPlaneContacts.runtimeRoot, profile.kicadPlaneContacts.manifest.path, profile.kicadPlaneContacts.helper.path])];
  });
  const protectedRoots = [...new Set([...oldDesign.protectedRoots, ...newDesign.protectedRoots, ...nativeRoots,
    adminRequest.path, request.runtimeQualification.path, request.normalClose.session.path, request.normalClose.response.path])];
  const contains = (left: string, right: string) => { const relative = path.relative(path.resolve(left).toLowerCase(), path.resolve(right).toLowerCase());
    return relative === "" || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };
  for (const fixed of protectedRoots) if (contains(fixed, request.workspaceRoot) || contains(request.workspaceRoot, fixed)) throw new Error("Runtime import workspace overlaps a protected native/profile/evidence root.");
  // An import must start from an existing allocation; never initialize an empty
  // or mistaken root merely to discover that the source does not exist there.
  const source = await lstat(path.join(request.workspaceRoot, "projects", request.sourceProjectId, "allocation.json"));
  if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1) throw new Error("Runtime import source allocation must already be an ordinary unshared file.");
  return await createToolboxWorkspaceStore({ workspaceRoot: request.workspaceRoot, protectedRoots });
}

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    request: { type: "string" }, "request-sha256": { type: "string" }, "request-bytes": { type: "string" }, "private-diagnostics-dir": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { process.stdout.write("Usage: node --import tsx scripts/import-toolbox-runtime-source.ts --request <host-approved-json> --request-sha256 <sha256> --request-bytes <bytes> [--private-diagnostics-dir <existing-external-evidence-dir>]\nImports only an exactly pinned, normally closed, unwired V2 source to a newly issued project under a qualified runtime correction. Private failure evidence defaults to the request directory when safely outside protected roots. No model tool surface.\n"); return; }
  if (!values.request || !/^[a-f0-9]{64}$/u.test(values["request-sha256"] ?? "") || !/^[1-9][0-9]*$/u.test(values["request-bytes"] ?? "")) throw new Error("Exact host-approved request path/SHA256/byte count are required.");
  const captured = await captureFreshRuntimeImportFile({ path: path.resolve(values.request), contentIdentity: {
    algorithm: "sha256", digest: values["request-sha256"]!, size: Number(values["request-bytes"]) } }, 256 * 1024);
  const request = runtimeSourceImportRequestSchema.parse(parsePortableJsonBytes(captured.bytes, { maxBytes: 256 * 1024, maxDepth: 32,
    maxNodes: 10000, maxArrayLength: 128, maxOwnKeys: 128, maxKeyBytes: 256, maxStringBytes: 4096 }));
  const requestPin = { path: captured.path, contentIdentity: captured.contentIdentity };
  try {
    const store = await prepareRuntimeSourceImportStore(request, requestPin);
    const qualified = await qualifyRuntimeSourceImport(request, store);
    const result = await executeQualifiedRuntimeSourceImport(qualified);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    try {
      const diagnostic = await retainRuntimeImportAdminFailure({ directory: values["private-diagnostics-dir"] ?? path.dirname(captured.path), requestPin, request, error });
      process.stderr.write(`Private administration diagnostic: ${diagnostic.path} (sha256:${diagnostic.contentIdentity.digest})\n`);
    } catch { /* Never replace the original sanitized error or write into uncertain roots. */ }
    throw error;
  }
}
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Runtime source import failed."}\n`); process.exitCode = 1; });
}

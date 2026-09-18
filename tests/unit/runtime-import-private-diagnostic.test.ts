import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { FluxProductionCompositionError } from "../../src/flux/production-composition.js";
import { retainRuntimeImportAdminFailure } from "../../scripts/import-toolbox-runtime-source.js";
import type { RuntimeSourceImportRequest } from "../../src/mcp/toolbox-runtime-source-import.js";
import { FRESH_RUNTIME_IMPORT_SOURCE_KEYS } from "../../src/harness/fresh-project.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("evleda-private-import-")) throw new Error("Unsafe private diagnostic test cleanup");
  await rm(root, { recursive: true, force: true });
} });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-private-import-")); roots.push(root);
  for (const directory of ["profiles", "evidence", "managed", "old-runtime", "new-runtime", "close", "kicad-bin", "private-runtime", "private-ipc", "symbols", "footprints", "rules", "fixed", "optional-helper"]) await mkdir(path.join(root, directory));
  const pin = async (file: string, data: unknown) => { const bytes = JSON.stringify(data) + "\n"; await writeFile(file, bytes); return { path: file, contentIdentity: contentIdentity(bytes) }; };
  const hash = (runtime: string) => createHash("sha256").update("evleda.kicad-mcp-arguments.v1\0").update(JSON.stringify(["-I", "-s", "-E", "-B", path.join(runtime, "entry.py")])).digest("hex");
  const oldRoot = path.join(root, "old-runtime"), newRoot = path.join(root, "new-runtime");
  for (const file of ["fixed/manifest.json", "fixed/lock.json", "old-runtime/terminate.exe", "new-runtime/terminate.exe", "optional-helper/helper.exe"]) await writeFile(path.join(root, file), "fixture");
  const profile = (runtimeRoot: string) => ({ kicadToolchain: { binRoot: path.join(root, "kicad-bin") },
    libraries: { symbolRoot: path.join(root, "symbols"), footprintRoot: path.join(root, "footprints") }, deepRules: { resourceRoot: path.join(root, "rules") },
    kicadMcpRuntime: { runtimeBundle: { root: runtimeRoot, manifest: { path: path.join(root, "fixed/manifest.json") }, expectedClosure: { entrypoint: { relativePath: "entry.py" } } },
      lock: { path: path.join(root, "fixed/lock.json") }, processTreeSupervision: { terminator: { path: path.join(runtimeRoot, "terminate.exe") } },
      runtimeParentRoot: path.join(root, "private-runtime"), ipcSocketParentRoot: path.join(root, "private-ipc"),
      runtimePolicy: { pythonLaunch: { flags: ["-I", "-s", "-E", "-B"], argumentCount: 5, argumentsSha256: hash(oldRoot) } } } });
  const sourceProfile = await pin(path.join(root, "profiles/old.json"), profile(oldRoot)), targetProfile = await pin(path.join(root, "profiles/new.json"), profile(newRoot));
  const empty = await pin(path.join(root, "close/empty.json"), {});
  const request: RuntimeSourceImportRequest = { schemaVersion: "evleda.plane-runtime-source-import-request.v1", workspaceRoot: path.join(root, "managed"),
    sourceProjectId: randomUUID(), targetProjectId: randomUUID(), sourceProfile, targetProfile,
    sourcePins: Object.fromEntries(FRESH_RUNTIME_IMPORT_SOURCE_KEYS.map(key => [key, contentIdentity(key)])) as RuntimeSourceImportRequest["sourcePins"],
    runtimeQualification: empty, normalClose: { session: empty, response: empty } };
  const requestPin = await pin(path.join(root, "evidence/request.json"), request);
  return { root, request, requestPin, directory: path.join(root, "evidence"), expectedNewHash: hash(newRoot),
    rewriteTarget: async (change: (profile: Record<string, any>) => void) => {
      const value = JSON.parse(await readFile(request.targetProfile.path, "utf8")); change(value);
      request.targetProfile = await pin(request.targetProfile.path, value);
      const nextPin = await pin(requestPin.path, request); Object.assign(requestPin, nextPin);
    } };
}
describe("private runtime import administration diagnostics", () => {
  it("retains original reason/cause/evidence privately and identifies stale path-derived launch hashes", async () => {
    const f = await fixture(), native = new FluxProductionCompositionError("KICAD_MCP_RUNTIME_UNAVAILABLE");
    const error = new AggregateError([native, new Error("private original native reason", { cause: new Error("first inner failure") })], "unchanged sanitized administration error");
    const originalMessage = error.message;
    const artifact = await retainRuntimeImportAdminFailure({ ...f, error });
    const bytes = await readFile(artifact.path), body = JSON.parse(bytes.toString("utf8"));
    expect(contentIdentity(bytes)).toEqual(artifact.contentIdentity);
    expect(body).toMatchObject({ classification: "private-host-administration-diagnostic", nativeAcceptance: false });
    expect(body.error.detail).toContain("private original native reason"); expect(body.error.detail).toContain("first inner failure");
    expect(body.error.detail).toContain("KICAD_MCP_RUNTIME_UNAVAILABLE");
    expect(body.launches).toEqual(expect.arrayContaining([expect.objectContaining({ side: "source", argumentsHashMatches: true }),
      expect.objectContaining({ side: "target", expectedArgumentsSha256: f.expectedNewHash, argumentsHashMatches: false })]));
    expect(error.message).toBe(originalMessage); expect(native.message).toBe("Pinned KiCad MCP runtime authority is unavailable or incompatible.");
  });
  it.each(["managed", "old-runtime", "profiles", "close"])("never writes diagnostic evidence under protected %s", async location => {
    const f = await fixture(), directory = path.join(f.root, location), before = await readdir(directory);
    await expect(retainRuntimeImportAdminFailure({ ...f, directory, error: new Error("private") })).rejects.toThrow(/cannot write/);
    expect(await readdir(directory)).toEqual(before);
  });
  it("rejects a linked evidence directory before writing", async () => {
    const f = await fixture(), linked = path.join(f.root, "linked"); await symlink(f.directory, linked, "junction");
    const before = await readdir(f.directory);
    await expect(retainRuntimeImportAdminFailure({ ...f, directory: linked, error: new Error("private") })).rejects.toThrow(/physical|canonical/);
    expect(await readdir(f.directory)).toEqual(before);
  });
  it.each(["file", "directory"])("rejects another checkout identified by a .git %s without invoking git", async kind => {
    const f = await fixture(), repo = path.join(f.root, "another-checkout"), directory = path.join(repo, "evidence");
    await mkdir(directory, { recursive: true });
    if (kind === "file") await writeFile(path.join(repo, ".git"), "gitdir: not-followed\n"); else await mkdir(path.join(repo, ".git"));
    await expect(retainRuntimeImportAdminFailure({ ...f, directory, error: new Error("private") })).rejects.toThrow(/non-checkout/);
    expect(await readdir(directory)).toEqual([]);
  });
  it("bounds original private error details without invoking custom inspectors", async () => {
    const f = await fixture(); let inspected = false;
    const error = new Error("large".repeat(40000)); Object.assign(error, { [Symbol.for("nodejs.util.inspect.custom")]: () => { inspected = true; throw new Error("must not execute"); } });
    const artifact = await retainRuntimeImportAdminFailure({ ...f, error }), bytes = await readFile(artifact.path), body = JSON.parse(bytes.toString("utf8"));
    expect(inspected).toBe(false); expect(body.error.truncated).toBe(true); expect(bytes.length).toBeLessThan(80 * 1024);
  });
  it.each(["missing-mandatory", "relative-bin", "malformed-optional", "aliased-fixed-root"])("refuses uncertain root coverage: %s", async kind => {
    const f = await fixture();
    if (kind === "aliased-fixed-root") await symlink(path.join(f.root, "symbols"), path.join(f.root, "symbol-alias"), "junction");
    await f.rewriteTarget(profile => {
      if (kind === "missing-mandatory") delete profile.kicadMcpRuntime.runtimeParentRoot;
      else if (kind === "relative-bin") profile.kicadToolchain.binRoot = "relative-bin";
      else if (kind === "malformed-optional") profile.kicadPlaneContacts = {};
      else profile.libraries.symbolRoot = path.join(f.root, "symbol-alias");
    });
    const before = await readdir(f.directory);
    await expect(retainRuntimeImportAdminFailure({ ...f, error: new Error("private") })).rejects.toThrow(/protected root|Protected diagnostic root/);
    expect(await readdir(f.directory)).toEqual(before);
  });
  it("protects an optional helper directory", async () => {
    const f = await fixture(); await f.rewriteTarget(profile => { profile.kicadReferenceCoverage = { path: path.join(f.root, "optional-helper/helper.exe") }; });
    const directory = path.join(f.root, "optional-helper"), before = await readdir(directory);
    await expect(retainRuntimeImportAdminFailure({ ...f, directory, error: new Error("private") })).rejects.toThrow(/cannot write/);
    expect(await readdir(directory)).toEqual(before);
  });
  it("does not derive an argument hash for a drive-qualified or escaping entrypoint", async () => {
    const f = await fixture();
    for (const relativePath of ["D:/outside/entry.py", "../entry.py", "entry\u0000.py"]) {
      await f.rewriteTarget(profile => { profile.kicadMcpRuntime.runtimeBundle.expectedClosure.entrypoint.relativePath = relativePath; });
      const artifact = await retainRuntimeImportAdminFailure({ ...f, error: new Error("invalid entrypoint") });
      const target = JSON.parse(await readFile(artifact.path, "utf8")).launches.find((row: { side: string }) => row.side === "target");
      expect(target).toMatchObject({ entrypointProjectionSupported: false, argumentsHashMatches: false });
      expect(target).not.toHaveProperty("expectedArgumentsSha256");
    }
  });
});

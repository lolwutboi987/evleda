import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readKicadNativeProfile, readKicadToolboxDesignProfile } from "../../../src/flux/production-composition.js";
import { repositoryRoot, sha256, verifyRuntime } from "../../../scripts/verify-kicad-inspection-runtime.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.argv.length, 2, "DOC9 profile preparation accepts no overrides.");
const profiles = path.resolve(repositoryRoot, "..", "working-profiles");
const sourcePath = path.join(profiles, "toolbox-native-doc7-stock-catalog-destination-02.json");
const profilePath = path.join(profiles, "toolbox-native-doc9-stock-catalog-destination-02.json");
const reportPath = path.join(profiles, "doc9-profile-qualification.json");
const runtimeRoot = "C:\\EvlEDA-DOC9-20260917";
const manifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc9.json");
const pin = async (file: string) => {
  const bytes = await readFile(file);
  return { path: await realpath(file), sha256: sha256(bytes), sizeBytes: bytes.length };
};
for (const target of [profilePath, reportPath]) {
  try { await lstat(target); throw new Error(`Refusing existing profile artifact: ${target}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const sourceBytes = await readFile(sourcePath);
assert.equal(sha256(sourceBytes), "489b93bf39814c1459d19636d54959c55e58efd8f23418fedd1c7ceeb587d512");
const source = JSON.parse(sourceBytes.toString("utf8"));
const verified = await verifyRuntime({ root: runtimeRoot, manifest: manifestPath });
assert.equal((verified as { generation: string }).generation, "DOC9");
const manifestPin = await pin(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const profile = structuredClone(source);
const runtime = profile.kicadMcpRuntime;
runtime.runtimeBundle.root = runtimeRoot;
runtime.runtimeBundle.manifest = manifestPin;
runtime.runtimeBundle.expectedClosure = {
  ...runtime.runtimeBundle.expectedClosure,
  fileCount: manifest.fileCount, totalBytes: manifest.totalBytes,
  manifestIdentity: manifest.identity, treeIdentity: manifest.treeIdentity,
};
const entrypointRelative = runtime.runtimeBundle.expectedClosure.entrypoint.relativePath;
const pythonArguments = ["-I", "-s", "-E", "-B", path.resolve(runtimeRoot, ...entrypointRelative.split("/"))];
runtime.runtimePolicy.pythonLaunch.argumentsSha256 = createHash("sha256")
  .update("evleda.kicad-mcp-arguments.v1\0", "utf8").update(JSON.stringify(pythonArguments), "utf8").digest("hex");
runtime.processTreeSupervision.terminator.path = path.join(runtimeRoot,
  ...runtime.processTreeSupervision.terminator.relativePath.split("/"));
for (const leaf of [runtime.runtimeBundle.expectedClosure.python, runtime.runtimeBundle.expectedClosure.entrypoint,
  runtime.processTreeSupervision.terminator]) {
  const actual = await pin(path.join(runtimeRoot, ...leaf.relativePath.split("/")));
  assert.equal(actual.sha256, leaf.sha256); assert.equal(actual.sizeBytes, leaf.sizeBytes);
}
// Preserve source policy/catalog/helper objects exactly, including the 117-file
// Windows dependency repin. No new helper or host dependency approval is implied.
const sourcePlaneManifest = source.kicadPlaneContacts.manifest;
const planeManifestPin = await pin(sourcePlaneManifest.path);
assert.deepEqual(planeManifestPin, sourcePlaneManifest);
const planeManifest = JSON.parse(await readFile(sourcePlaneManifest.path, "utf8"));
assert.equal(planeManifest.fileCount, 117);
for (const key of Object.keys(source).filter(key => key !== "kicadMcpRuntime")) assert.deepEqual(profile[key], source[key]);
const restored = structuredClone(profile);
restored.kicadMcpRuntime.runtimeBundle = source.kicadMcpRuntime.runtimeBundle;
restored.kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256 = source.kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256;
restored.kicadMcpRuntime.processTreeSupervision.terminator.path = source.kicadMcpRuntime.processTreeSupervision.terminator.path;
assert.deepEqual(restored, source, "Profile changed beyond approved DOC9 runtime bindings");
assert.deepEqual(await readFile(sourcePath), sourceBytes);
await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx" });
const profilePin = await pin(profilePath);
const input = { path: profilePath, contentIdentity: { algorithm: "sha256" as const, digest: profilePin.sha256, size: profilePin.sizeBytes } };
const native = await readKicadNativeProfile(input);
const design = await readKicadToolboxDesignProfile(input);
assert.equal(native.kicadMcpRuntime.runtimeBundle.root, runtimeRoot);
assert.deepEqual(design.contentIdentity, input.contentIdentity);
assert.deepEqual(await readFile(sourcePath), sourceBytes);
assert.deepEqual(await pin(sourcePlaneManifest.path), planeManifestPin);
const report = {
  schemaVersion: "evleda.doc9-native-profile-qualification.v1", completedAt: new Date().toISOString(),
  status: "OFFLINE_PROFILE_AND_CLOSURE_VERIFIED_NATIVE_PENDING", sourceProfile: await pin(sourcePath), profile: profilePin,
  verification: verified, manifest: manifestPin, pythonArguments,
  argumentsSha256: runtime.runtimePolicy.pythonLaunch.argumentsSha256,
  terminator: runtime.processTreeSupervision.terminator,
  planeHelperManifestPreserved: planeManifestPin, planeHelperFileCount: planeManifest.fileCount,
  profileParser: await pin(path.join(repositoryRoot, "src/flux/production-composition.ts")),
  preparationScript: await pin(fileURLToPath(import.meta.url)),
  validation: { nativeProfileParser: true, designProfileParser: true, exactUnrelatedFieldPreservation: true,
    frozenDoc7ProfileUnchanged: true, nativeApiCalls: 0, sessionAllocations: 0, globalConfigurationChanged: false,
    noHostDllRequalificationClaim: true },
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ profile: profilePin, report: await pin(reportPath), argumentsSha256: report.argumentsSha256 }, null, 2));

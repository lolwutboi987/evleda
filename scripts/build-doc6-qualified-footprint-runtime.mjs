import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repositoryRoot, pyvenvText, runManifestHelper, sha256, verifyRuntime } from "./verify-kicad-inspection-runtime.mjs";

// One reviewed overlay on the existing DOC5 closure; no profile activation.
assert.equal(process.platform, "win32", "DOC6 requires the approved Windows runtime.");
assert.equal(process.argv.length, 2, "This bounded publication takes no runtime/path overrides.");
const sourceRoot = "C:\\EvlEDA-DOC5-20260910";
const runtimeRoot = "C:\\EvlEDA-DOC6-20260910";
const profiles = path.resolve(repositoryRoot, "..", "working-profiles");
const overlay = path.join(repositoryRoot, "sidecars", "patches", "doc6");
const sourceManifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc5-short.json");
const sourceProfilePath = path.join(profiles, "toolbox-native-doc5-destination-short.json");
const manifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc6.json");
const evidencePath = path.join(profiles, "doc6-qualified-footprint-identity.json");
const testsPath = path.join(profiles, "doc6-qualified-footprint-identity-tests.json");
const descriptorPath = path.join(profiles, "doc6-qualified-footprint-identity-registration.json");
const sourceProvenancePath = path.join(overlay, "provenance.json");
const relativeModule = "environment/Lib/site-packages/kicad_mcp/tools/pcb.py";
const sourceModulePath = path.join(overlay, "kicad_mcp", "tools", "pcb.py");
const patchPath = path.join(overlay, "qualified-footprint-identity-sync.patch");
const testDriverPath = path.join(overlay, "test_qualified_footprint_identity.py");
const marker = { evledaQualifiedFootprintIdentitySync: "evleda.kicad-qualified-footprint-identity-sync.v1" };
const startedAt = new Date().toISOString(), startedMs = Date.now(), timings = {};

const pin = async file => {
  const bytes = await readFile(file);
  return { path: await realpath(file), sha256: sha256(bytes), sizeBytes: bytes.length };
};
const ordinaryAncestors = async target => {
  const resolved = path.resolve(target);
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let metadata;
    try { metadata = await lstat(cursor); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    assert.ok(!metadata.isSymbolicLink(), "DOC6 ancestor is a link or junction.");
    assert.equal(path.resolve(await realpath(cursor)).toLowerCase(), cursor.toLowerCase(), "DOC6 ancestor is an alias.");
  }
};
for (const target of [sourceRoot, runtimeRoot, profiles, overlay]) await ordinaryAncestors(target);
for (const target of [runtimeRoot, manifestPath, evidencePath, testsPath, descriptorPath, sourceProvenancePath]) {
  try { await lstat(target); throw new Error(`Refusing to replace existing DOC6 artifact: ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const sourceManifestPin = await pin(sourceManifestPath), sourceProfilePin = await pin(sourceProfilePath);
assert.equal(sourceManifestPin.sha256, "448a28d816ad6273476988c2f5c9ffb3d0e6634ecd8c885233332d4e944d4b4b");
assert.equal(sourceManifestPin.sizeBytes, 1_574_798);
assert.equal(sourceProfilePin.sha256, "d3a5576455655f563bce4539ccf3779cf9f0ce13e75c158b9af2047895488f09");
assert.equal(sourceProfilePin.sizeBytes, 5294);
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
const sourceModulePin = await pin(sourceModulePath), patchPin = await pin(patchPath), testDriverPin = await pin(testDriverPath);
assert.equal(sourceModulePin.sha256, "cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0", "Unreviewed DOC6 source bytes.");
assert.equal(sourceModulePin.sizeBytes, 187502);
assert.equal(patchPin.sha256, "7a0a9f2ce1909f4691517c2b9b741b66ae07bb6392a4d33e3f8457fb43562614", "Unreviewed DOC6 patch bytes.");
assert.equal(patchPin.sizeBytes, 2401);
assert.equal(testDriverPin.sha256, "588ac7826945dd02581d6e96dc72be39c0af9ec6de4f89da9ee64e1b49c0b74d", "Unreviewed DOC6 regression driver bytes.");
assert.equal(testDriverPin.sizeBytes, 16143);
const beforeModulePin = await pin(path.join(sourceRoot, relativeModule));
assert.equal(beforeModulePin.sha256, "411c47974851c8291c0485e89416f5ecd72472c4ddb77377db3d594173c27f74");
assert.equal(beforeModulePin.sizeBytes, 186975);
const beforeCfg = await readFile(path.join(sourceRoot, "environment", "pyvenv.cfg"));
assert.equal(beforeCfg.toString("utf8"), pyvenvText(sourceRoot));

console.log("Verifying the pinned DOC5 source before creating the separate DOC6 runtime.");
let phaseStart = Date.now();
const sourceVerification = await verifyRuntime({ root: sourceRoot, manifest: sourceManifestPath });
timings.sourceVerificationMs = Date.now() - phaseStart;
phaseStart = Date.now();
await cp(sourceRoot, runtimeRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
for (const target of [path.join(runtimeRoot, relativeModule), path.join(runtimeRoot, "environment", "pyvenv.cfg")]) await ordinaryAncestors(target);
assert.deepEqual(await readFile(path.join(runtimeRoot, relativeModule)), await readFile(path.join(sourceRoot, relativeModule)));
assert.deepEqual(await readFile(path.join(runtimeRoot, "environment", "pyvenv.cfg")), beforeCfg);
await writeFile(path.join(runtimeRoot, relativeModule), await readFile(sourceModulePath));
await writeFile(path.join(runtimeRoot, "environment", "pyvenv.cfg"), pyvenvText(runtimeRoot), "utf8");
timings.copyAndPatchMs = Date.now() - phaseStart;

console.log("Running the real Python writer and registration tests against installed DOC6 bytes.");
phaseStart = Date.now();
const temporaryRoot = path.resolve(tmpdir()), scratch = await mkdtemp(path.join(temporaryRoot, "evleda-doc6-offline-"));
let testResult;
try {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(path.join(runtimeRoot, "environment", "Scripts", "python.exe"),
      ["-I", "-s", "-E", "-B", testDriverPath, path.join(runtimeRoot, relativeModule)], {
        cwd: scratch, shell: false, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: "",
          HOME: scratch, USERPROFILE: scratch, TEMP: scratch, TMP: scratch,
          APPDATA: path.join(scratch, "AppData", "Roaming"), LOCALAPPDATA: path.join(scratch, "AppData", "Local"),
          KICAD_MCP_WORKSPACE_ROOT: scratch, KICAD_MCP_OPERATING_MODE: "readonly", KICAD_MCP_TELEMETRY_ENABLED: "false",
          PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHON_DOTENV_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
      });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      let report;
      try { report = JSON.parse(stdout.trim()); }
      catch { reject(new Error(`DOC6 writer test returned invalid JSON (${code}): ${stderr}`)); return; }
      resolve({ code, report, stderr });
    });
  });
  testResult = { ...output, elapsedMs: Date.now() - phaseStart };
  await writeFile(testsPath, `${JSON.stringify(testResult, null, 2)}\n`, { flag: "wx" });
  assert.equal(output.code, 0, "DOC6 writer tests failed; failure report was preserved.");
  assert.equal(output.report.success, true);
  assert.equal(output.report.testsRun, 12);
  assert.equal(output.report.module.sha256, sourceModulePin.sha256);
  assert.equal(output.report.module.sizeBytes, sourceModulePin.sizeBytes);
  assert.equal(output.report.registeredDescriptor.name, "pcb_sync_from_schematic");
  assert.deepEqual(output.report.registeredDescriptor._meta, marker);
  await writeFile(descriptorPath, `${JSON.stringify(output.report.registeredDescriptor, null, 2)}\n`, { flag: "wx" });
} finally {
  const relative = path.relative(temporaryRoot, scratch);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "DOC6 test cleanup escaped its owned temporary root.");
  await rm(scratch, { recursive: true, force: true });
}
timings.installedOfflineTestsMs = Date.now() - phaseStart;

console.log("Building DOC6 with the existing manifest helper and checking its exact two-file delta.");
phaseStart = Date.now();
await runManifestHelper("build", runtimeRoot, manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const replacement = new Map([
  [relativeModule, await readFile(sourceModulePath)],
  ["environment/pyvenv.cfg", Buffer.from(pyvenvText(runtimeRoot), "utf8")],
]);
const expectedFiles = sourceManifest.files.map(file => replacement.has(file.path)
  ? { ...file, sha256: sha256(replacement.get(file.path)), sizeBytes: replacement.get(file.path).length } : file);
assert.deepEqual(manifest.files, expectedFiles, "DOC6 changed files beyond the reviewed writer and Python home.");
assert.deepEqual(manifest.directories, sourceManifest.directories, "DOC6 changed the directory inventory.");
for (const field of ["schemaVersion", "classification", "platform", "distribution", "protocol", "python", "entrypoint", "packageMetadata", "pthPolicy", "nativeDependencyPolicy", "fileCount", "directoryCount"]) {
  assert.deepEqual(manifest[field], sourceManifest[field], `DOC6 changed protected ${field}.`);
}
assert.equal(manifest.totalBytes, expectedFiles.reduce((total, file) => total + file.sizeBytes, 0));
const runtimeDelta = manifest.files.filter(file => replacement.has(file.path)).map(after => ({ path: after.path,
  before: sourceManifest.files.find(file => file.path === after.path), after }));
assert.equal(runtimeDelta.length, 2);
timings.manifestBuildMs = Date.now() - phaseStart;
phaseStart = Date.now();
const verification = await runManifestHelper("verify", runtimeRoot, manifestPath);
timings.manifestVerifyMs = Date.now() - phaseStart;
assert.deepEqual(await pin(sourceManifestPath), sourceManifestPin, "DOC5 manifest changed.");
assert.deepEqual(await pin(sourceProfilePath), sourceProfilePin, "Prior profile changed.");
assert.deepEqual(await pin(path.join(sourceRoot, relativeModule)), beforeModulePin, "DOC5 writer changed.");
assert.deepEqual(await readFile(path.join(sourceRoot, "environment", "pyvenv.cfg")), beforeCfg, "DOC5 Python home changed.");
assert.deepEqual(await pin(sourceModulePath), sourceModulePin, "Reviewed DOC6 source changed during publication.");
assert.deepEqual(await pin(patchPath), patchPin); assert.deepEqual(await pin(testDriverPath), testDriverPin);
const report = {
  schemaVersion: "evleda.doc6-qualified-footprint-runtime.v1", status: "OFFLINE_VERIFIED_NATIVE_PENDING",
  startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs, timings,
  sourceRuntimeRoot: sourceRoot, sourceManifest: sourceManifestPin, sourceProfile: sourceProfilePin, sourceVerification,
  runtimeRoot, manifest: await pin(manifestPath), manifestIdentity: manifest.identity, treeIdentity: manifest.treeIdentity,
  fileCount: manifest.fileCount, directoryCount: manifest.directoryCount, totalBytes: manifest.totalBytes,
  runtimeDelta, sourceRestoreMapping: [{ source: sourceModulePin, runtimeRelativePath: relativeModule }], patch: patchPin,
  testDriver: testDriverPin, installedOfflineTests: { report: await pin(testsPath), testsRun: testResult.report.testsRun, success: true },
  registeredDescriptor: await pin(descriptorPath), qualificationMarker: marker, verification,
  preserved: { frozenDoc5: true, doc5CommitLifecycleAndAddons: true, packageMetadataAndRecord: true, activeProfiles: true, dist: true, existingBoards: true },
  scope: { editorLaunched: false, mcpServerLoopStarted: false, nativeApiCalls: 0, existingBoardRepairPerformed: false,
    nativeSchematicParityRecheck: "parent-owned, pending" },
};
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
await writeFile(sourceProvenancePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ runtimeRoot, manifest: report.manifest, evidence: evidencePath, testsRun: report.installedOfflineTests.testsRun,
  qualificationMarker: marker, fileCount: report.fileCount, totalBytes: report.totalBytes, elapsedMs: report.elapsedMs }, null, 2));

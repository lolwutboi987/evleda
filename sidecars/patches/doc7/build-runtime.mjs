import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { specTypeSchemas } from "@modelcontextprotocol/client";
import { repositoryRoot, runManifestHelper, sha256 } from "../../../scripts/verify-kicad-inspection-runtime.mjs";

export async function buildDoc7Runtime(preparedCopy = false) {
assert.equal(process.platform, "win32");
assert.equal(process.argv.length, 2, "DOC7 builder accepts no overrides.");
const sourceRoot = "C:\\EvlEDA-DOC6-20260910", runtimeRoot = "C:\\EvlEDA-DOC7-20260910";
const profiles = path.resolve(repositoryRoot, "..", "working-profiles");
const overlay = path.join(repositoryRoot, "sidecars", "patches", "doc7");
const sourceManifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc6.json");
const manifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc7.json");
const evidencePath = path.join(profiles, "doc7-power-flag-connectivity.json");
const testsPath = path.join(profiles, "doc7-power-flag-connectivity-tests-02.json");
const registrationPath = path.join(profiles, "doc7-power-flag-connectivity-registration.json");
const provenancePath = path.join(overlay, "provenance.json");
const descriptorFixturePath = path.join(repositoryRoot, "tests", "fixtures", "kicad-mcp-external-power-flag-connectivity-tool.json");
const baselinePath = path.join(profiles, "doc7-power-flag-baseline-doc6-04.json");
const modules = ["tools/schematic.py", "tools/schematic_topology.py", "schematic/topology.py"];
const approvedModuleHashes = ["2611e416652e458325110301c206f77ff6080f627efa31a2328bf1aad22c68b1",
  "9de824872e29b771d2dda7df510103a419fb8e3944b9cdda6bf0e37c8fec7261",
  "7c4b94a4519abd558bd45ab4fbad55a9f832a11d421fb413e03287442f8aad9c"];
const marker = { evledaExternalPowerFlagConnectivity: "evleda.kicad-external-power-flag-connectivity.v1" };
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const pin = async file => {
  const bytes = await readFile(file);
  return { path: await realpath(file), sha256: sha256(bytes), sizeBytes: bytes.length };
};
const ordinaryAncestors = async target => {
  const resolved = path.resolve(target);
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stats;
    try { stats = await lstat(cursor); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    assert.ok(!stats.isSymbolicLink(), "DOC7 ancestor is a link or junction.");
    assert.equal(path.resolve(await realpath(cursor)).toLowerCase(), cursor.toLowerCase(), "DOC7 ancestor is an alias.");
  }
};
for (const target of [sourceRoot, runtimeRoot, profiles, overlay]) await ordinaryAncestors(target);
for (const target of [...(preparedCopy ? [] : [runtimeRoot]), manifestPath, evidencePath, testsPath, registrationPath, provenancePath, descriptorFixturePath]) {
  try { await lstat(target); throw new Error(`Refusing existing DOC7 artifact: ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const startedAt = new Date().toISOString(), startedMs = Date.now(), timings = {};
const sourceManifestPin = await pin(sourceManifestPath);
assert.equal(sourceManifestPin.sha256, "f7c1d16a8c964a8f5ff55b281baf678c00e88e9b9fd19eb77c6aa5881eedc296");
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
assert.equal(sourceManifest.treeIdentity.digest, "8ecf10a0781a7c5f8c31f690da917f6a162435602e4afbd443963f0025c340a9");
assert.equal(sourceManifest.fileCount, 8467);
const patchPin = await pin(path.join(overlay, "power-flag-connectivity.patch"));
assert.equal(patchPin.sha256, "9d73713cfa47ebffeada3cca64af53990f04716589b705b603435b4c0a61bcb4");
const testDriverPath = path.join(overlay, "test_power_flag_connectivity.py");
const driverPin = await pin(testDriverPath);
assert.equal(driverPin.sha256, "4aac2239b1034316ab6975e083daf23714fcf85e3a4551a66cf92a3eaf1aefad");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
assert.equal(baseline.success, false);
assert.equal(baseline.testsRun, 13);
assert.ok(baseline.publicGraph.includes("GND, PWR_FLAG, VIN"));
const replacements = new Map();
const sourceRestoreMapping = [];
for (const suffix of modules) {
  const source = path.join(overlay, "kicad_mcp", suffix), relative = `environment/Lib/site-packages/kicad_mcp/${suffix}`;
  replacements.set(relative, await readFile(source));
  assert.equal(sha256(replacements.get(relative)), approvedModuleHashes[modules.indexOf(suffix)]);
  sourceRestoreMapping.push({ source: await pin(source), runtimeRelativePath: relative });
}
const beforeCfg = await readFile(path.join(sourceRoot, "environment/pyvenv.cfg"));
const beforeText = beforeCfg.toString("utf8");
assert.equal(beforeText.split("home = ").length, 2);
assert.ok(beforeText.includes(`home = ${sourceRoot}\\python\n`));
const afterCfg = Buffer.from(beforeText.replace(`home = ${sourceRoot}\\python\n`, `home = ${runtimeRoot}\\python\n`), "utf8");
replacements.set("environment/pyvenv.cfg", afterCfg);
let phase = Date.now();
console.log("Verifying the complete frozen DOC6 source closure.");
const sourceVerification = await runManifestHelper("verify", sourceRoot, sourceManifestPath);
timings.sourceVerificationMs = Date.now() - phase;
phase = Date.now();
const expectedFiles = sourceManifest.files.map(file => replacements.has(file.path)
  ? { ...file, sha256: sha256(replacements.get(file.path)), sizeBytes: replacements.get(file.path).length } : file);
if (preparedCopy) {
  // The first run stopped before publication on two incorrect test expectations.
  // Never reuse an arbitrary tree: verify every byte of the owned prepared copy
  // against the same frozen DOC6 closure and the exact four approved leaves.
  const failurePath = path.join(profiles, "doc7-power-flag-connectivity-tests.json");
  const failure = JSON.parse(await readFile(failurePath, "utf8"));
  assert.equal(failure.code, 1); assert.equal(failure.report.runtimeRoot, runtimeRoot);
  const preparedManifest = path.join(profiles, "doc7-prepared-copy-manifest.json");
  await runManifestHelper("build", runtimeRoot, preparedManifest);
  const actual = JSON.parse(await readFile(preparedManifest, "utf8"));
  assert.deepEqual(actual.files, expectedFiles, "Prepared DOC7 copy has an unexpected file delta.");
  assert.deepEqual(actual.directories, sourceManifest.directories);
} else {
console.log("Copying the complete closure into the absent DOC7 directory.");
await cp(sourceRoot, runtimeRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
for (const [relative, replacement] of replacements) {
  const target = path.join(runtimeRoot, relative);
  await ordinaryAncestors(target);
  assert.deepEqual(await readFile(target), await readFile(path.join(sourceRoot, relative)));
  await writeFile(target, replacement);
}
}
timings.copyAndPatchMs = Date.now() - phase;
phase = Date.now();
console.log("Running pure-file qualification on actual DOC7 modules.");
const execution = await new Promise((resolve, reject) => {
  const command = path.join(runtimeRoot, "environment/Scripts/python.exe");
  const args = ["-I", "-s", "-E", "-B", "-X", "utf8", testDriverPath];
  const child = spawn(command, args, { cwd: profiles, shell: false, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: "",
      USERPROFILE: profiles, HOME: profiles, TEMP: process.env.TEMP, TMP: process.env.TMP,
      APPDATA: path.join(profiles, "unused-doc7-appdata"), LOCALAPPDATA: path.join(profiles, "unused-doc7-localappdata"),
      KICAD_MCP_OPERATING_MODE: "readonly", KICAD_MCP_TELEMETRY_ENABLED: "false", PYTHON_DOTENV_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  child.once("error", reject);
  child.once("close", code => {
    try { resolve({ command, args, code, report: JSON.parse(stdout.trim()), stderr }); }
    catch { reject(new Error(`DOC7 qualification did not return JSON: ${code}; ${stderr}`)); }
  });
});
await writeFile(testsPath, `${JSON.stringify(execution, null, 2)}\n`, { flag: "wx" });
assert.equal(execution.code, 0, "DOC7 tests failed; report retained, no manifest published.");
assert.equal(execution.report.success, true);
assert.equal(execution.report.testsRun, 13);
assert.deepEqual(execution.report.pythonFlags, { isolated: 1, no_user_site: 1, ignore_environment: 1, dont_write_bytecode: 1, utf8_mode: 1 });
assert.deepEqual(execution.report.fixturePins, baseline.fixturePins);
for (const suffix of modules) {
  assert.equal(path.resolve(execution.report.importedModules[suffix]), path.join(runtimeRoot, "environment/Lib/site-packages/kicad_mcp", suffix));
  assert.deepEqual(execution.report.modulePins[suffix], { sha256: sha256(replacements.get(`environment/Lib/site-packages/kicad_mcp/${suffix}`)),
    sizeBytes: replacements.get(`environment/Lib/site-packages/kicad_mcp/${suffix}`).length });
}
const descriptor = specTypeSchemas.Tool.parse(execution.report.registeredDescriptor);
assert.deepEqual(descriptor._meta, marker);
const descriptorSha256 = sha256(Buffer.from(canonical(descriptor), "utf8"));
await writeFile(registrationPath, `${JSON.stringify({ rawDescriptor: execution.report.registeredDescriptor, normalizedDescriptor: descriptor,
  normalizedDescriptorSha256: descriptorSha256, normalization: "@modelcontextprotocol/client@2.0.0 specTypeSchemas.Tool.parse" }, null, 2)}\n`, { flag: "wx" });
await writeFile(descriptorFixturePath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
timings.installedTestsMs = Date.now() - phase;
phase = Date.now();
console.log("Building and reproducing the exact DOC7 manifest with the existing helper.");
const built = await runManifestHelper("build", runtimeRoot, manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.deepEqual(manifest.files, expectedFiles, "Unexpected DOC7 file delta.");
assert.deepEqual(manifest.directories, sourceManifest.directories);
for (const field of ["schemaVersion", "classification", "platform", "distribution", "protocol", "python", "entrypoint", "packageMetadata", "pthPolicy", "nativeDependencyPolicy", "fileCount", "directoryCount"]) {
  assert.deepEqual(manifest[field], sourceManifest[field], `Changed protected field ${field}.`);
}
const verification = await runManifestHelper("verify", runtimeRoot, manifestPath);
timings.manifestMs = Date.now() - phase;
phase = Date.now();
const finalSourceVerification = await runManifestHelper("verify", sourceRoot, sourceManifestPath);
assert.deepEqual(await pin(sourceManifestPath), sourceManifestPin);
assert.deepEqual(await readFile(path.join(sourceRoot, "environment/pyvenv.cfg")), beforeCfg);
assert.deepEqual(await pin(testDriverPath), driverPin);
assert.deepEqual(await pin(path.join(overlay, "power-flag-connectivity.patch")), patchPin);
for (const mapping of sourceRestoreMapping) assert.deepEqual(await pin(mapping.source.path), mapping.source);
timings.finalSourceVerificationMs = Date.now() - phase;
const report = { schemaVersion: "evleda.doc7-power-flag-connectivity-runtime.v1", status: "OFFLINE_VERIFIED_NATIVE_PENDING",
  startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs, timings, preparedCopy,
  sourceRuntimeRoot: sourceRoot, sourceManifest: sourceManifestPin, sourceVerification, finalSourceVerification,
  runtimeRoot, manifest: await pin(manifestPath), manifestIdentity: manifest.identity, treeIdentity: manifest.treeIdentity,
  fileCount: manifest.fileCount, directoryCount: manifest.directoryCount, totalBytes: manifest.totalBytes,
  runtimeDelta: manifest.files.filter(file => replacements.has(file.path)).map(after => ({ path: after.path,
    before: sourceManifest.files.find(file => file.path === after.path), after })),
  sourceRestoreMapping, patch: patchPin, testDriver: driverPin, baseline: await pin(baselinePath),
  installedOfflineTests: { report: await pin(testsPath), testsRun: execution.report.testsRun, success: true },
  registeredDescriptor: await pin(registrationPath), descriptorFixture: await pin(descriptorFixturePath),
  normalizedDescriptorSha256: descriptorSha256, qualificationMarker: marker, built, verification,
  preserved: { frozenDoc6: true, full8467FileClosure: true, packageMetadataAndRecord: true, existingProfiles: true, dist: true },
  scope: { editorLaunched: false, mcpServerLoopStarted: false, nativeIntegration: "parent-owned, pending",
    nativeXmlEvidence: "Retained prior CLI export; no fresh CLI export performed here.",
    flagDefinition: "Exact power:PWR_FLAG, unit 1, one source pin 1 power_out at origin; unsupported geometry rejects." } };
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
await writeFile(provenancePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ runtimeRoot, manifest: report.manifest, normalizedDescriptorSha256: descriptorSha256,
  fileCount: report.fileCount, totalBytes: report.totalBytes, treeIdentity: report.treeIdentity, testsRun: 13, elapsedMs: report.elapsedMs }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDoc7Runtime();

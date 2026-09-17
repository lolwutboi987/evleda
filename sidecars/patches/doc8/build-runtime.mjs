import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { specTypeSchemas } from "@modelcontextprotocol/client";
import { repositoryRoot, runManifestHelper, sha256 } from "../../../scripts/verify-kicad-inspection-runtime.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.argv.length, 2, "DOC8 builder accepts no overrides.");
const sourceRoot = "C:\\EvlEDA-DOC7-20260910", runtimeRoot = "C:\\EvlEDA-DOC8-20260916";
const profiles = path.resolve(repositoryRoot, "..", "working-profiles");
const overlay = path.join(repositoryRoot, "sidecars", "patches", "doc8");
const sourceManifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc7.json");
const manifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc8.json");
const evidencePath = path.join(profiles, "doc8-no-connect-net-transfer.json");
const provenancePath = path.join(overlay, "provenance.json");
const baselinePath = path.join(profiles, "doc8-no-connect-baseline-doc7.json");
const testsPath = path.join(profiles, "doc8-no-connect-net-transfer-tests.json");
const identityTestsPath = path.join(profiles, "doc8-qualified-footprint-identity-tests.json");
const graphTestsPath = path.join(profiles, "doc8-power-flag-connectivity-tests.json");
const registrationPath = path.join(profiles, "doc8-preserved-tool-descriptors.json");
const reproductionRoot = path.join(profiles, "doc8-patch-reproduction");
const patchPath = path.join(overlay, "no-connect-net-transfer.patch");
const driverPath = path.join(overlay, "test_no_connect_net_transfer.py");
const moduleRelative = "environment/Lib/site-packages/kicad_mcp/tools/pcb.py";
const moduleSource = path.join(overlay, "kicad_mcp", "tools", "pcb.py");
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
    assert.ok(!stats.isSymbolicLink(), "DOC8 ancestor is a link or junction.");
    assert.equal(path.resolve(await realpath(cursor)).toLowerCase(), cursor.toLowerCase(), "DOC8 ancestor is an alias.");
  }
};
for (const target of [sourceRoot, runtimeRoot, profiles, overlay]) await ordinaryAncestors(target);
for (const target of [runtimeRoot, manifestPath, evidencePath, provenancePath, baselinePath, testsPath,
  identityTestsPath, graphTestsPath, registrationPath, reproductionRoot]) {
  try { await lstat(target); throw new Error(`Refusing existing DOC8 artifact: ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const startedAt = new Date().toISOString(), startedMs = Date.now(), timings = {};
const sourceManifestPin = await pin(sourceManifestPath);
assert.equal(sourceManifestPin.sha256, "87de3535155cdfcf9650f19409ca4f203b8bba373ce8021ea646f982258b80f7");
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
assert.equal(sourceManifest.treeIdentity.digest, "7654f6c1cafab4e9f2f30f33ecff2325bb8993e2023b059945f6a4c966a3df99");
assert.equal(sourceManifest.fileCount, 8467);
const patchPin = await pin(patchPath), driverPin = await pin(driverPath), modulePin = await pin(moduleSource);
assert.equal(patchPin.sha256, "ddef949dfe12f2291451fa912fe3c1b9e11965185c5f507cd7172d67fef0330d");
assert.equal(driverPin.sha256, "eda693d3f6a92658d8bcd64112e53236221df228afcf7d9aec4292febb59d523");
assert.equal(modulePin.sha256, "8e5810bc7879b636c42c8d6e0d561875b3d16bd2222272a2ea58bd5f7aeefddf");
const nativeNetlist = path.resolve(repositoryRoot, "..", "destination-ic-design-04/workspace/projects/d2bfe961-d86b-4bd4-87e0-039f2926f953/output/.evleda-mcp-output/pcb_sync.net");
const stockFootprint = "C:\\Program Files\\KiCad\\10.0\\share\\kicad\\footprints\\Package_SON.pretty\\WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm.kicad_mod";
const fixtureSources = [];
for (const [original, name, expected] of [
  [nativeNetlist, "pcb_sync.net", "e4113bd9d035610e446b8cba7fc586e2e1a042d74988d18f01c6ead3087b6c85"],
  [stockFootprint, path.basename(stockFootprint), "d1e2fc3516c96e3c858b32e79dc4d47fd9d15783c0320ed08aeec9ffbbae0937"],
]) {
  const source = await pin(original), retained = await pin(path.join(overlay, "fixtures", name));
  assert.equal(source.sha256, expected); assert.equal(retained.sha256, expected);
  assert.equal(source.sizeBytes, retained.sizeBytes);
  fixtureSources.push({ source, retained });
}
const execute = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: profiles, shell: false, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, ...options });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  child.once("error", reject);
  child.once("close", code => resolve({ command, args, code, stdout, stderr }));
});
const runPython = async (root, driver, arguments_ = []) => {
  const execution = await execute(path.join(root, "environment/Scripts/python.exe"),
    ["-I", "-s", "-E", "-B", "-X", "utf8", driver, ...arguments_], {
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: "",
        USERPROFILE: profiles, HOME: profiles, TEMP: process.env.TEMP, TMP: process.env.TMP,
        APPDATA: path.join(profiles, "unused-doc8-appdata"), LOCALAPPDATA: path.join(profiles, "unused-doc8-localappdata"),
        KICAD_MCP_OPERATING_MODE: "readonly", KICAD_MCP_TELEMETRY_ENABLED: "false", PYTHON_DOTENV_DISABLED: "1",
        KICAD_MCP_KICAD_CLI: "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe" },
    });
  const { stdout, ...rest } = execution;
  return { ...rest, report: JSON.parse(stdout.trim()) };
};
const writeJson = (target, value) => writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
let phase = Date.now();
console.log("Verifying the complete frozen DOC7 source closure.");
const sourceVerification = await runManifestHelper("verify", sourceRoot, sourceManifestPath);
timings.sourceVerificationMs = Date.now() - phase;
console.log("Reproducing the retained bug against DOC7 and reproducing the exact source patch.");
const baseline = await runPython(sourceRoot, driverPath);
await writeJson(baselinePath, baseline);
assert.equal(baseline.code, 1); assert.equal(baseline.report.success, false); assert.equal(baseline.report.testsRun, 16);
assert.equal(baseline.report.retainedExportPadMap["U1:5"], "unconnected-(U1-NC-Pad5)");
assert.equal(baseline.report.module.sha256, "cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0");
await mkdir(path.join(reproductionRoot, "kicad_mcp", "tools"), { recursive: true });
const reproducedFile = path.join(reproductionRoot, "kicad_mcp", "tools", "pcb.py");
await cp(path.join(sourceRoot, moduleRelative), reproducedFile, { errorOnExist: true, force: false });
const reproduction = await execute("C:\\Program Files\\Git\\cmd\\git.exe",
  ["-c", "core.autocrlf=false", "apply", patchPath], { cwd: reproductionRoot });
assert.equal(reproduction.code, 0, reproduction.stderr);
assert.deepEqual(await readFile(reproducedFile), await readFile(moduleSource));
const replacements = new Map([[moduleRelative, await readFile(moduleSource)]]);
const beforeCfg = await readFile(path.join(sourceRoot, "environment/pyvenv.cfg"));
const beforeText = beforeCfg.toString("utf8");
assert.equal(beforeText.split("home = ").length, 2);
assert.ok(beforeText.includes(`home = ${sourceRoot}\\python\n`));
replacements.set("environment/pyvenv.cfg", Buffer.from(beforeText.replace(`home = ${sourceRoot}\\python\n`, `home = ${runtimeRoot}\\python\n`)));
const expectedFiles = sourceManifest.files.map(file => replacements.has(file.path)
  ? { ...file, sha256: sha256(replacements.get(file.path)), sizeBytes: replacements.get(file.path).length } : file);
phase = Date.now();
console.log("Copying all 8,467 leaves and changing only pcb.py plus the Python home.");
await cp(sourceRoot, runtimeRoot, { recursive: true, errorOnExist: true, force: false, dereference: false });
for (const [relative, replacement] of replacements) {
  const target = path.join(runtimeRoot, relative);
  await ordinaryAncestors(target);
  assert.deepEqual(await readFile(target), await readFile(path.join(sourceRoot, relative)));
  await writeFile(target, replacement);
}
timings.copyAndPatchMs = Date.now() - phase;
phase = Date.now();
console.log("Running DOC8 NC, DOC6 identity and DOC7 graph pure-file regressions.");
const execution = await runPython(runtimeRoot, driverPath);
await writeJson(testsPath, execution);
assert.equal(execution.code, 0, "DOC8 NC regression failed; report retained, no manifest published.");
assert.equal(execution.report.success, true); assert.equal(execution.report.testsRun, 16);
assert.deepEqual(execution.report.pythonFlags, { isolated: 1, no_user_site: 1, ignore_environment: 1, dont_write_bytecode: 1, utf8_mode: 1 });
assert.equal(path.resolve(execution.report.module.path), path.join(runtimeRoot, moduleRelative));
assert.equal(execution.report.module.sha256, modulePin.sha256);
assert.deepEqual(execution.report.fixturePins, baseline.report.fixturePins);
assert.deepEqual(execution.report.registeredDescriptor, baseline.report.registeredDescriptor);
const expectedMap = { ...baseline.report.retainedExportPadMap }; delete expectedMap["U1:5"];
assert.deepEqual(execution.report.retainedExportPadMap, expectedMap);
const identityDriver = path.join(repositoryRoot, "sidecars/patches/doc6/test_qualified_footprint_identity.py");
const graphDriver = path.join(repositoryRoot, "sidecars/patches/doc7/test_power_flag_connectivity.py");
const identityExecution = await runPython(runtimeRoot, identityDriver, [path.join(runtimeRoot, moduleRelative)]);
await writeJson(identityTestsPath, identityExecution);
assert.equal(identityExecution.code, 0); assert.equal(identityExecution.report.success, true); assert.equal(identityExecution.report.testsRun, 12);
const graphExecution = await runPython(runtimeRoot, graphDriver);
await writeJson(graphTestsPath, graphExecution);
assert.equal(graphExecution.code, 0); assert.equal(graphExecution.report.success, true); assert.equal(graphExecution.report.testsRun, 13);
const descriptors = [];
for (const [raw, fixture] of [[execution.report.registeredDescriptor, "kicad-mcp-qualified-footprint-sync-tool.json"],
  [graphExecution.report.registeredDescriptor, "kicad-mcp-external-power-flag-connectivity-tool.json"]]) {
  const normalized = specTypeSchemas.Tool.parse(raw);
  assert.deepEqual(normalized, JSON.parse(await readFile(path.join(repositoryRoot, "tests/fixtures", fixture), "utf8")));
  descriptors.push({ rawDescriptor: raw, normalizedDescriptor: normalized,
    normalizedDescriptorSha256: sha256(Buffer.from(canonical(normalized))), fixture });
}
await writeJson(registrationPath, { normalization: "@modelcontextprotocol/client@2.0.0 specTypeSchemas.Tool.parse", descriptors });
timings.installedOfflineTestsMs = Date.now() - phase;
phase = Date.now();
console.log("Building and independently verifying the DOC8 manifest and exact two-leaf delta.");
const built = await runManifestHelper("build", runtimeRoot, manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.deepEqual(manifest.files, expectedFiles, "Unexpected DOC8 file delta.");
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
for (const previous of [patchPin, driverPin, modulePin, ...fixtureSources.flatMap(item => [item.source, item.retained])]) {
  assert.deepEqual(await pin(previous.path), previous);
}
timings.finalSourceVerificationMs = Date.now() - phase;
const report = { schemaVersion: "evleda.doc8-no-connect-net-transfer-runtime.v1", status: "OFFLINE_VERIFIED_NATIVE_PENDING",
  startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs, timings,
  sourceRuntimeRoot: sourceRoot, sourceManifest: sourceManifestPin, sourceVerification, finalSourceVerification,
  runtimeRoot, manifest: await pin(manifestPath), manifestIdentity: manifest.identity, treeIdentity: manifest.treeIdentity,
  fileCount: manifest.fileCount, directoryCount: manifest.directoryCount, totalBytes: manifest.totalBytes,
  runtimeDelta: manifest.files.filter(file => replacements.has(file.path)).map(after => ({ path: after.path,
    before: sourceManifest.files.find(file => file.path === after.path), after })),
  sourceRestoreMapping: [{ source: modulePin, runtimeRelativePath: moduleRelative }], patch: patchPin, testDriver: driverPin,
  builder: await pin(path.join(overlay, "build-runtime.mjs")), baseline: await pin(baselinePath), fixtureSources,
  patchReproduction: { ...reproduction, reproducedFile: await pin(reproducedFile), matchesPublishedSource: true },
  installedOfflineTests: { report: await pin(testsPath), testsRun: 16, success: true },
  preservedIdentityTests: { driver: await pin(identityDriver), report: await pin(identityTestsPath), testsRun: 12, success: true },
  preservedGraphTests: { driver: await pin(graphDriver), report: await pin(graphTestsPath), testsRun: 13, success: true },
  registeredDescriptors: await pin(registrationPath), normalizedDescriptorSha256: Object.fromEntries(descriptors.map(item => [item.normalizedDescriptor.name, item.normalizedDescriptorSha256])),
  built, verification, preserved: { frozenDoc7: true, full8467FileClosure: true, packageMetadataAndRecord: true,
    existingProfiles: true, dist: true, existingNativeProject: true, toolDescriptors: true },
  scope: { editorLaunched: false, mcpServerLoopStarted: false, nativeApiCalls: 0, nativeIntegration: "parent-owned, pending",
    nativeEvidence: "Unchanged retained native04 netlist export and installed stock footprint; no fresh native export.",
    change: "Normalize singleton unconnected-(...) plus exact no_connect type token to an omitted pad-net mapping at fresh footprint import.",
    limitations: "No repair of already-netted existing footprints; no host validation relaxation; no placement, routing, board acceptance or manufacturing claim." } };
await writeJson(evidencePath, report);
await writeJson(provenancePath, report);
console.log(JSON.stringify({ runtimeRoot, manifest: report.manifest, provenance: await pin(provenancePath),
  module: modulePin, patch: patchPin, fileCount: report.fileCount, treeIdentity: report.treeIdentity,
  manifestIdentity: report.manifestIdentity, testsRun: 41, elapsedMs: report.elapsedMs }, null, 2));

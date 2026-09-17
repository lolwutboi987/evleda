import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { specTypeSchemas } from "@modelcontextprotocol/client";
import { repositoryRoot, runManifestHelper, sha256 } from "../../../scripts/verify-kicad-inspection-runtime.mjs";

assert.equal(process.platform, "win32");
const resume = process.argv.length === 3 && process.argv[2] === "--resume-offline";
assert.ok(process.argv.length === 2 || resume, "DOC9 builder accepts only authenticated --resume-offline.");
const sourceRoot = "C:\\EvlEDA-DOC7-20260910", runtimeRoot = "C:\\EvlEDA-DOC9-20260917";
const profiles = path.resolve(repositoryRoot, "..", "working-profiles");
const overlay = path.join(repositoryRoot, "sidecars", "patches", "doc9");
const sourceManifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc7.json");
const manifestPath = path.join(profiles, "kicad-inspection-runtime-manifest-doc9.json");
const evidencePath = path.join(profiles, "doc9-bounded-arc-field-layout.json");
const provenancePath = path.join(overlay, "provenance.json");
const baselinePath = path.join(profiles, "doc9-arc-baseline-doc7.json");
const testsPath = path.join(profiles, "doc9-bounded-arc-field-layout-tests.json");
const identityTestsPath = path.join(profiles, "doc9-qualified-footprint-identity-tests.json");
const graphTestsPath = path.join(profiles, "doc9-power-flag-connectivity-tests.json");
const registrationPath = path.join(profiles, "doc9-preserved-tool-descriptors.json");
const reproductionRoot = path.join(profiles, resume ? "doc9-arc-patch-reproduction-final" : "doc9-arc-patch-reproduction");
const resumeManifestPath = path.join(profiles, "doc9-resume-runtime-manifest.json");
const syncRegistrationPath = path.join(profiles, "doc9-sync-registration.json");
const syncDriver = path.join(overlay, "capture_sync_descriptor.py");
const patchPath = path.join(overlay, "bounded-arc-field-layout.patch");
const driverPath = path.join(overlay, "test_arc_field_layout.py");
const moduleRelative = "environment/Lib/site-packages/kicad_mcp/utils/field_layout.py";
const moduleSource = path.join(overlay, "kicad_mcp", "utils", "field_layout.py");
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
    assert.ok(!stats.isSymbolicLink(), "DOC9 ancestor is a link or junction.");
    assert.equal(path.resolve(await realpath(cursor)).toLowerCase(), cursor.toLowerCase(), "DOC9 ancestor is an alias.");
  }
};
for (const target of [sourceRoot, runtimeRoot, profiles, overlay]) await ordinaryAncestors(target);
for (const target of [manifestPath, evidencePath, provenancePath, registrationPath, syncRegistrationPath,
  ...(resume ? [] : [runtimeRoot, baselinePath, testsPath, identityTestsPath, graphTestsPath, reproductionRoot])]) {
  try { await lstat(target); throw new Error(`Refusing existing DOC9 artifact: ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const startedAt = new Date().toISOString(), startedMs = Date.now(), timings = {};
const sourceManifestPin = await pin(sourceManifestPath);
assert.equal(sourceManifestPin.sha256, "87de3535155cdfcf9650f19409ca4f203b8bba373ce8021ea646f982258b80f7");
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
assert.equal(sourceManifest.treeIdentity.digest, "7654f6c1cafab4e9f2f30f33ecff2325bb8993e2023b059945f6a4c966a3df99");
assert.equal(sourceManifest.fileCount, 8467);
assert.equal(sourceManifest.files.find(file => file.path.endsWith("kicad_mcp/tools/pcb.py")).sha256,
  "cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0", "DOC9 must retain DOC7 PCB behavior, never DOC8 NC stripping.");
const patchPin = await pin(patchPath), driverPin = await pin(driverPath), modulePin = await pin(moduleSource);
assert.equal(patchPin.sha256, "798c369c022018d4fe88d6c93979995f0aa5c9992193db689b34d23c471b034e");
assert.equal(driverPin.sha256, "f60b1a1d720eafa4ed3563d000706ac3c73b76b870dcb26de49cd749fb350939");
assert.equal(modulePin.sha256, "543f36faf8747907c4044906b6a24cb48cf43bf399bc8986cd4d2192a748c93e");
const retainedSource = path.resolve(repositoryRoot, "../destination-usb-c-native-03/workspace/projects/7ff60924-86a8-4b10-93d7-8c3c4e291439/output/project/usb-c-mechanical-probe.kicad_sch");
const fixtureSource = { source: await pin(retainedSource), retained: await pin(path.join(overlay, "fixtures", "usb-c-mechanical-probe.kicad_sch")) };
for (const item of Object.values(fixtureSource)) assert.equal(item.sha256, "55e2d56e6d65e5bab705a891f8d7360ad21f84a47d26b6a7d1bb933f2a93d68d");
assert.equal(fixtureSource.source.sizeBytes, fixtureSource.retained.sizeBytes);
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
        APPDATA: path.join(profiles, "unused-doc9-appdata"), LOCALAPPDATA: path.join(profiles, "unused-doc9-localappdata"),
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
let resumeVerification;
if (resume) {
  // Authenticate the complete previously copied closure before any import.
  const cfg = Buffer.from((await readFile(path.join(sourceRoot, "environment/pyvenv.cfg"), "utf8"))
    .replace(`home = ${sourceRoot}\\python\n`, `home = ${runtimeRoot}\\python\n`));
  let resumeManifestExists = false;
  try { await lstat(resumeManifestPath); resumeManifestExists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  resumeVerification = await runManifestHelper(resumeManifestExists ? "verify" : "build", runtimeRoot, resumeManifestPath);
  const closed = JSON.parse(await readFile(resumeManifestPath, "utf8"));
  const expected = sourceManifest.files.map(file => file.path === moduleRelative
    ? { ...file, sha256: modulePin.sha256, sizeBytes: modulePin.sizeBytes }
    : file.path === "environment/pyvenv.cfg" ? { ...file, sha256: sha256(cfg), sizeBytes: cfg.length } : file);
  assert.deepEqual(closed.files, expected, "Resume runtime is not the exact two-leaf DOC7-derived closure");
  assert.deepEqual(closed.directories, sourceManifest.directories);
}
timings.sourceVerificationMs = Date.now() - phase;
console.log("Replaying retained ARC rejection against DOC7 and reproducing the exact source patch.");
const baseline = resume ? JSON.parse(await readFile(baselinePath, "utf8")) : await runPython(sourceRoot, driverPath, ["--baseline"]);
if (!resume) await writeJson(baselinePath, baseline);
assert.equal(baseline.code, 0); assert.equal(baseline.report.success, true); assert.equal(baseline.report.baselineRejected, true);
assert.equal(baseline.report.module.sha256, sourceManifest.files.find(file => file.path === moduleRelative).sha256);
const reproducedFile = path.join(reproductionRoot, "kicad_mcp", "utils", "field_layout.py");
let reproduction;
let reproductionExists = false;
try { await lstat(reproducedFile); reproductionExists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
if (resume && reproductionExists) {
  await ordinaryAncestors(reproducedFile);
  reproduction = await execute("C:\\Program Files\\Git\\cmd\\git.exe", ["-c", "core.autocrlf=false", "apply", "--reverse", "--check", patchPath], { cwd: reproductionRoot });
} else {
  await mkdir(path.join(reproductionRoot, "kicad_mcp", "utils"), { recursive: true });
  await cp(path.join(sourceRoot, moduleRelative), reproducedFile, { errorOnExist: true, force: false });
  reproduction = await execute("C:\\Program Files\\Git\\cmd\\git.exe", ["-c", "core.autocrlf=false", "apply", patchPath], { cwd: reproductionRoot });
}
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
console.log("Copying all 8,467 leaves and changing only field_layout.py plus the Python home.");
if (!resume) {
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
console.log("Running DOC9 ARC, DOC6 identity and DOC7 graph offline regressions.");
const execution = resume ? JSON.parse(await readFile(testsPath, "utf8")) : await runPython(runtimeRoot, driverPath);
if (!resume) await writeJson(testsPath, execution);
assert.equal(execution.code, 0, "DOC9 ARC regression failed; report retained, no manifest published.");
assert.equal(execution.report.success, true); assert.equal(execution.report.testsRun, 17);
assert.deepEqual(execution.report.pythonFlags, { isolated: 1, no_user_site: 1, ignore_environment: 1, dont_write_bytecode: 1, utf8_mode: 1 });
assert.equal(path.resolve(execution.report.module.path), path.join(runtimeRoot, moduleRelative));
assert.equal(execution.report.module.sha256, modulePin.sha256);
assert.deepEqual(execution.report.fixture, baseline.report.fixture);
const identityDriver = path.join(repositoryRoot, "sidecars/patches/doc6/test_qualified_footprint_identity.py");
const graphDriver = path.join(repositoryRoot, "sidecars/patches/doc7/test_power_flag_connectivity.py");
const identityExecution = resume ? JSON.parse(await readFile(identityTestsPath, "utf8")) : await runPython(runtimeRoot, identityDriver, [path.join(runtimeRoot, "environment/Lib/site-packages/kicad_mcp/tools/pcb.py")]);
if (!resume) await writeJson(identityTestsPath, identityExecution);
assert.equal(identityExecution.code, 0); assert.equal(identityExecution.report.success, true); assert.equal(identityExecution.report.testsRun, 12);
const graphExecution = resume ? JSON.parse(await readFile(graphTestsPath, "utf8")) : await runPython(runtimeRoot, graphDriver);
if (!resume) await writeJson(graphTestsPath, graphExecution);
assert.equal(graphExecution.code, 0); assert.equal(graphExecution.report.success, true); assert.equal(graphExecution.report.testsRun, 13);
const descriptors = [];
const syncExecution = await runPython(runtimeRoot, syncDriver);
await writeJson(syncRegistrationPath, syncExecution);
assert.equal(syncExecution.code, 0); assert.equal(syncExecution.report.success, true);
assert.equal(syncExecution.report.module.sha256, "cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0");
for (const [raw, fixture] of [[syncExecution.report.registeredDescriptor, "kicad-mcp-qualified-footprint-sync-tool.json"],
  [graphExecution.report.registeredDescriptor, "kicad-mcp-external-power-flag-connectivity-tool.json"]]) {
  const normalized = specTypeSchemas.Tool.parse(raw);
  assert.deepEqual(normalized, JSON.parse(await readFile(path.join(repositoryRoot, "tests/fixtures", fixture), "utf8")));
  descriptors.push({ rawDescriptor: raw, normalizedDescriptor: normalized,
    normalizedDescriptorSha256: sha256(Buffer.from(canonical(normalized))), fixture });
}
await writeJson(registrationPath, { normalization: "@modelcontextprotocol/client@2.0.0 specTypeSchemas.Tool.parse", descriptors });
timings.installedOfflineTestsMs = Date.now() - phase;
phase = Date.now();
console.log("Building and independently verifying DOC9 manifest and its exact two-leaf delta.");
const built = await runManifestHelper("build", runtimeRoot, manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.deepEqual(manifest.files, expectedFiles, "Unexpected DOC9 file delta.");
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
for (const previous of [patchPin, driverPin, modulePin, ...Object.values(fixtureSource)]) assert.deepEqual(await pin(previous.path), previous);
timings.finalSourceVerificationMs = Date.now() - phase;
const report = { schemaVersion: "evleda.doc9-bounded-arc-field-layout-runtime.v1", status: "OFFLINE_VERIFIED_NATIVE_PENDING",
  startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedMs, timings,
  sourceRuntimeRoot: sourceRoot, sourceManifest: sourceManifestPin, sourceVerification, finalSourceVerification,
  runtimeRoot, manifest: await pin(manifestPath), manifestIdentity: manifest.identity, treeIdentity: manifest.treeIdentity,
  fileCount: manifest.fileCount, directoryCount: manifest.directoryCount, totalBytes: manifest.totalBytes,
  runtimeDelta: manifest.files.filter(file => replacements.has(file.path)).map(after => ({ path: after.path,
    before: sourceManifest.files.find(file => file.path === after.path), after })),
  sourceRestoreMapping: [{ source: modulePin, runtimeRelativePath: moduleRelative }], patch: patchPin, testDriver: driverPin,
  builder: await pin(path.join(overlay, "build-runtime.mjs")), baseline: await pin(baselinePath), fixtureSource,
  patchReproduction: { ...reproduction, reproducedFile: await pin(reproducedFile), matchesPublishedSource: true },
  installedOfflineTests: { report: await pin(testsPath), testsRun: 17, success: true },
  preservedIdentityTests: { driver: await pin(identityDriver), report: await pin(identityTestsPath), testsRun: 12, success: true },
  preservedGraphTests: { driver: await pin(graphDriver), report: await pin(graphTestsPath), testsRun: 13, success: true },
  registeredDescriptors: await pin(registrationPath), normalizedDescriptorSha256: Object.fromEntries(descriptors.map(item => [item.normalizedDescriptor.name, item.normalizedDescriptorSha256])),
  syncRegistration: { driver: await pin(syncDriver), report: await pin(syncRegistrationPath) },
  ...(resume ? { resumedAfter: "Generic FastMCP in DOC6 regression driver does not apply production KiCadFastMCP descriptor normalization. Exact production registration captured separately; no comparator weakened.",
    resumeClosure: { manifest: await pin(resumeManifestPath), verification: resumeVerification } } : {}),
  built, verification, preserved: { frozenDoc7: true, full8467FileClosure: true, packageMetadataAndRecord: true,
    existingProfiles: true, dist: true, existingNativeProject: true, toolDescriptors: true, doc7PcbNoConnectBehavior: true },
  scope: { editorLaunched: false, mcpServerLoopStarted: false, nativeApiCalls: 0, nativeIntegration: "parent-owned, pending",
    baselineEvidence: "Pure-memory replay on retained native03 source, not original MCP error text.",
    change: "Bound explicit three-point ARC sweeps with stroke-aware conservative AABBs in the existing field planner; retain complete arc source.",
    limitations: "No native glyph/pin-text accuracy, readability, electrical or manufacturing verdict. Bezier, library text, default-width arcs and ambiguous geometry remain rejected. No DOC8 NC filter." } };
await writeJson(evidencePath, report);
await writeJson(provenancePath, report);
console.log(JSON.stringify({ runtimeRoot, manifest: report.manifest, provenance: await pin(provenancePath),
  module: modulePin, patch: patchPin, fileCount: report.fileCount, treeIdentity: report.treeIdentity,
  manifestIdentity: report.manifestIdentity, testsRun: 42, elapsedMs: report.elapsedMs }, null, 2));

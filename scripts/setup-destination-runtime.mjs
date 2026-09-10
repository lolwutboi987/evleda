import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repositoryRoot, readDoc5Source, originalRuntimeRoot, pyvenvText, sha256, runManifestHelper, verifyRuntime } from "./verify-kicad-inspection-runtime.mjs";

if (process.platform !== "win32") throw new Error("This transferred DOC5 runtime requires Windows x64.");
if (process.argv.length > 4) throw new Error("Usage: node scripts/setup-destination-runtime.mjs [transfer-root] [kicad-bin]");
const transfer = path.resolve(process.argv[2] ?? path.join(repositoryRoot, ".."));
assert.equal(path.resolve(transfer, "evleda").toLowerCase(), path.resolve(repositoryRoot).toLowerCase(), "Transfer root must contain this repository");
const bin = path.resolve(process.argv[3] ?? "C:/Program Files/KiCad/10.0/bin");
const source = path.join(transfer, "runtime", "inspection-runtime-3.33.3-doc5");
const working = path.join(transfer, "working-runtime");
const root = path.join(working, "inspection-runtime-3.33.3-doc5");
const profiles = path.join(transfer, "working-profiles");
const manifest = path.join(profiles, "kicad-inspection-runtime-manifest-doc5.json");
const profilePath = path.join(profiles, "toolbox-native-doc5-destination.json");
const originalProfilePath = path.join(transfer, "profiles", "toolbox-native-doc5-transactions-profile-20260909-07.json");
const originalProfileBytes = await readFile(originalProfilePath);
assert.equal(sha256(originalProfileBytes), "f3707e553a860b1a4ec54ca4b82fa3a7bc9329b9a33afc0cabde5ea3e6127e93", "Transferred native profile differs from the handoff pin");
const profile = JSON.parse(originalProfileBytes);
await readDoc5Source();
const pin = async file => { const bytes = await readFile(file); return { path: file, sha256: sha256(bytes), sizeBytes: bytes.length }; };
const lockPin = await pin(path.join(repositoryRoot, "sidecars", "kicad-mcp-pro.lock.json"));
assert.equal(lockPin.sha256, profile.kicadMcpRuntime.lock.sha256, "Transferred sidecar lock differs from the approved profile pin");
assert.equal(lockPin.sizeBytes, profile.kicadMcpRuntime.lock.sizeBytes);
const ordinaryAncestors = async target => {
  const resolved = path.resolve(target);
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let metadata;
    try { metadata = await lstat(cursor); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    assert.ok(!metadata.isSymbolicLink() && path.resolve(await realpath(cursor)).toLowerCase() === cursor.toLowerCase(), "Destination ancestor is an alias or reparse point");
  }
};
for (const destination of [working, profiles]) await ordinaryAncestors(destination);
assert.ok(Buffer.byteLength(`ipc://${path.join(working, "ipc", "e-XXXXXX", "kicad", "api.sock")}`, "utf8") <= 128, "Transfer directory is too long for the native IPC endpoint; use a shorter ordinary local directory");
for (const field of ["kicadCli", "pcbnew"]) {
  const actual = await pin(path.join(bin, path.basename(profile.kicadToolchain[field].path)));
  assert.equal(actual.sha256, profile.kicadToolchain[field].sha256, `Installed ${field} differs from approved KiCad 10.0.3 bytes`);
  assert.equal(actual.sizeBytes, profile.kicadToolchain[field].sizeBytes);
  profile.kicadToolchain[field] = { ...profile.kicadToolchain[field], ...actual };
}
profile.kicadToolchain.binRoot = bin;
const probe = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true, timeout: 15_000 });
  if (result.error || result.status !== 0) throw new Error(`Destination tool probe failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
};
assert.equal(probe(profile.kicadToolchain.kicadCli.path, ["version"]), profile.kicadToolchain.kicadCli.operationalVersion);
assert.equal(probe(profile.kicadToolchain.kicadCli.path, ["version", "--format", "commit"]), profile.kicadToolchain.kicadCli.operationalCommit);
for (const target of [root, manifest, profilePath, path.join(profiles, "destination-setup.json")]) {
  try { await lstat(target); throw new Error(`Refusing to overwrite destination artifact: ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
console.log("Verifying the original DOC5 closure before copying.");
await runManifestHelper("verify", source, path.join(repositoryRoot, "sidecars", "kicad-inspection-runtime-manifest-doc5.json"), originalRuntimeRoot);
await mkdir(working, { recursive: true });
await mkdir(profiles, { recursive: true });
await cp(source, root, { recursive: true, errorOnExist: true, force: false });
await writeFile(path.join(root, "environment", "pyvenv.cfg"), pyvenvText(root), "utf8");
await runManifestHelper("build", root, manifest);
const closureVerification = await verifyRuntime({ root, manifest });
const runtimeManifest = JSON.parse(await readFile(manifest, "utf8"));
const pythonVersion = probe(path.join(root, "environment", "Scripts", "python.exe"), ["-I", "-s", "-E", "-B", "-X", "utf8", "-c", "import sys, importlib.metadata as m; print(sys.version.split()[0]); print(m.version('kicad-mcp-pro')); print(m.version('kicad-python'))"]);
assert.equal(pythonVersion.replace(/\r\n/gu, "\n"), "3.13.12\n3.33.3\n0.7.1");
const runtime = profile.kicadMcpRuntime;
runtime.lock = lockPin;
runtime.runtimeBundle.root = root;
runtime.runtimeBundle.manifest = await pin(manifest);
Object.assign(runtime.runtimeBundle.expectedClosure, { fileCount: runtimeManifest.fileCount, totalBytes: runtimeManifest.totalBytes, manifestIdentity: runtimeManifest.identity, treeIdentity: runtimeManifest.treeIdentity });
runtime.processTreeSupervision.terminator = { ...runtime.processTreeSupervision.terminator, ...await pin(path.join(root, "process-tree-terminator.exe")) };
runtime.runtimePolicy.pythonLaunch.argumentsSha256 = createHash("sha256").update("evleda.kicad-mcp-arguments.v1\0", "utf8").update(JSON.stringify(["-I", "-s", "-E", "-B", path.join(root, "kicad-inspection-launcher.py")]), "utf8").digest("hex");
runtime.runtimeParentRoot = path.join(working, "sessions");
runtime.ipcSocketParentRoot = path.join(working, "ipc");
for (const directory of [runtime.runtimeParentRoot, runtime.ipcSocketParentRoot]) await mkdir(directory, { recursive: true });
profile.libraries.symbolRoot = path.resolve(bin, "..", "share", "kicad", "symbols");
profile.libraries.footprintRoot = path.resolve(bin, "..", "share", "kicad", "footprints");
for (const directory of [profile.libraries.symbolRoot, profile.libraries.footprintRoot]) assert.ok((await lstat(directory)).isDirectory());
profile.deepRules.resourceRoot = path.join(repositoryRoot, "dist", "resources", "deep-pcb-rule-corpus", "v1");
// Optional executables were not included in this transfer; never retain dead pins.
delete profile.kicadTransmissionLine;
delete profile.kicadReferenceCoverage;
await writeFile(profilePath, `${JSON.stringify(profile)}\n`, { flag: "wx" });
const result = { schemaVersion: "evleda.destination-runtime-setup.v1", createdAt: new Date().toISOString(), originalProfile: await pin(originalProfilePath), profile: await pin(profilePath), closureVerification, pythonVersion: "3.13.12", optionalHelpers: { transmissionLine: "not configured; rebuild separately from third_party/kicad-transline-core", referenceCoverage: "not configured; requires a compiler supporting __int128" }, readiness: "Runtime closure verified. Full native and fresh profile loaders must pass after pnpm build; no editor was launched." };
await writeFile(path.join(profiles, "destination-setup.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(result, null, 2));

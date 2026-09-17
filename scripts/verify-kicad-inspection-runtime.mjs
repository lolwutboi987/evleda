import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const doc5ManifestSha256 = "9912ec88f42d4a4fe57692eb95b1653c8b8fbb3df391688a4647b8d56efa8425";
export const doc5ProvenanceSha256 = "188fb348db06f88c6723a8e6cbf3f616914b9795477a5798e13509dffe0cd4d1";
const DOC6 = Object.freeze({
  provenanceSha256: "fc41d63217b04bcd2bd70bf3b6311abe3970bcc331629ea6c0f5f1983a9f585d",
  path: "environment/Lib/site-packages/kicad_mcp/tools/pcb.py",
  sha256: "cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0", sizeBytes: 187502,
  patch: "qualified-footprint-identity-sync.patch", patchSha256: "7a0a9f2ce1909f4691517c2b9b741b66ae07bb6392a4d33e3f8457fb43562614", patchBytes: 2401,
});
const DOC7 = Object.freeze({
  provenanceSha256: "544905cf360b0bd47bc9eeaed3eadaeec774eac20f87b7f325469952108cdf82",
  patchSha256: "9d73713cfa47ebffeada3cca64af53990f04716589b705b603435b4c0a61bcb4", patchBytes: 4494,
  sources: Object.freeze([
    { path: "environment/Lib/site-packages/kicad_mcp/tools/schematic.py", sha256: "2611e416652e458325110301c206f77ff6080f627efa31a2328bf1aad22c68b1", sizeBytes: 238532 },
    { path: "environment/Lib/site-packages/kicad_mcp/tools/schematic_topology.py", sha256: "9de824872e29b771d2dda7df510103a419fb8e3944b9cdda6bf0e37c8fec7261", sizeBytes: 2348 },
    { path: "environment/Lib/site-packages/kicad_mcp/schematic/topology.py", sha256: "7c4b94a4519abd558bd45ab4fbad55a9f832a11d421fb413e03287442f8aad9c", sizeBytes: 8483 },
  ]),
});
const DOC8 = Object.freeze({
  provenanceSha256: "74ce175cad4efbbc9f6e6571ae6962c71f88bde861049c7215dda9eb963e1795",
  path: DOC6.path, sha256: "8e5810bc7879b636c42c8d6e0d561875b3d16bd2222272a2ea58bd5f7aeefddf", sizeBytes: 189117,
  patch: "no-connect-net-transfer.patch", patchSha256: "ddef949dfe12f2291451fa912fe3c1b9e11965185c5f507cd7172d67fef0330d", patchBytes: 2387,
});
const DOC9 = Object.freeze({
  provenanceSha256: "5bcc8899c65fa4fdf9a2da6737d2fc6d63c64df819493cc9120c87972cccbcdf",
  path: "environment/Lib/site-packages/kicad_mcp/utils/field_layout.py",
  sha256: "543f36faf8747907c4044906b6a24cb48cf43bf399bc8986cd4d2192a748c93e", sizeBytes: 25847,
  patch: "bounded-arc-field-layout.patch", patchSha256: "798c369c022018d4fe88d6c93979995f0aa5c9992193db689b34d23c471b034e", patchBytes: 7159,
});
export const originalRuntimeRoot = String.raw`D:\Codex-Recovery\tools\kicad-mcp-pro\inspection-runtime-3.33.3-doc5`;
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const pyvenvText = root => `home = ${path.join(root, "python")}\nimplementation = CPython\nuv = 0.11.31\nversion_info = 3.13.12\ninclude-system-site-packages = false\nrelocatable = true\n`;

export function resolveRuntimeCheckPaths(args = [], env = process.env, repo = repositoryRoot) {
  const root = env.EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT;
  const manifest = env.EVLEDA_KICAD_INSPECTION_RUNTIME_MANIFEST;
  if (args.length !== 0 && args.length !== 2) throw new Error("Provide <runtime-root> <manifest-path>, or use both EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT and EVLEDA_KICAD_INSPECTION_RUNTIME_MANIFEST.");
  if (args.length === 0 && Boolean(root) !== Boolean(manifest)) throw new Error("Both runtime environment overrides are required; partial configuration is rejected.");
  return {
    root: path.resolve(args[0] ?? root ?? path.join(repo, "..", "working-runtime", "inspection-runtime-3.33.3-doc5")),
    manifest: path.resolve(args[1] ?? manifest ?? path.join(repo, "..", "working-profiles", "kicad-inspection-runtime-manifest-doc5.json")),
  };
}

export async function readDoc5Source() {
  const manifestBytes = await readFile(path.join(repositoryRoot, "sidecars", "kicad-inspection-runtime-manifest-doc5.json"));
  const provenanceBytes = await readFile(path.join(repositoryRoot, "sidecars", "patches", "doc5", "provenance.json"));
  assert.equal(sha256(manifestBytes), doc5ManifestSha256, "Historical DOC5 manifest differs from its published pin");
  assert.equal(sha256(provenanceBytes), doc5ProvenanceSha256, "DOC5 source provenance differs from its published pin");
  const manifest = JSON.parse(manifestBytes);
  const provenance = JSON.parse(provenanceBytes);
  for (const mapping of provenance.sourceRestoreMapping) {
    const suffix = mapping.runtimeRelativePath.replace(/^environment\/Lib\/site-packages\//u, "");
    assert.ok(suffix.startsWith("kicad_mcp/") && !suffix.includes(".."), "Unsupported DOC5 source mapping");
    const source = await readFile(path.join(repositoryRoot, "sidecars", "patches", "doc5", ...suffix.split("/")));
    assert.equal(sha256(source), mapping.source.sha256, "DOC5 transaction source differs from its published pin");
    assert.equal(source.length, mapping.source.sizeBytes);
    const leaf = manifest.files.find(file => file.path === mapping.runtimeRelativePath);
    assert.equal(leaf?.sha256, mapping.source.sha256, "DOC5 manifest is not bound to its transaction repair");
    assert.equal(leaf?.sizeBytes, mapping.source.sizeBytes);
  }
  return manifest;
}

/** Relocation may change exactly pyvenv home; every other DOC5 leaf stays pinned. */
export function assertDoc5Relocation(original, candidate, root) {
  const oldCfg = original.files.find(file => file.path === "environment/pyvenv.cfg");
  // The historical path is a Windows path even when unit tests run elsewhere.
  const originalCfg = `home = ${originalRuntimeRoot}\\python\nimplementation = CPython\nuv = 0.11.31\nversion_info = 3.13.12\ninclude-system-site-packages = false\nrelocatable = true\n`;
  assert.equal(oldCfg?.sha256, sha256(originalCfg), "Unrecognized original Python environment binding");
  assert.equal(oldCfg?.sizeBytes, Buffer.byteLength(originalCfg));
  const newCfg = Buffer.from(pyvenvText(root), "utf8");
  const expectedFiles = original.files.map(file => file.path === "environment/pyvenv.cfg"
    ? { ...file, sha256: sha256(newCfg), sizeBytes: newCfg.length } : file);
  assert.deepEqual(candidate.files, expectedFiles, "Runtime differs from DOC5 beyond the approved pyvenv home relocation");
  assert.deepEqual(candidate.directories, original.directories, "Runtime directory closure differs from DOC5");
  for (const field of ["schemaVersion", "classification", "platform", "distribution", "protocol", "python", "entrypoint", "packageMetadata", "pthPolicy", "nativeDependencyPolicy", "fileCount", "directoryCount"]) {
    assert.deepEqual(candidate[field], original[field], `Runtime ${field} differs from DOC5`);
  }
  assert.equal(candidate.totalBytes, original.totalBytes - oldCfg.sizeBytes + newCfg.length);
}

/** Authenticate the one published DOC6 overlay; provenance paths are never executed/resolved. */
async function doc6Reference(original) {
  const directory = path.join(repositoryRoot, "sidecars", "patches", "doc6");
  const provenanceBytes = await readFile(path.join(directory, "provenance.json"));
  assert.equal(sha256(provenanceBytes), DOC6.provenanceSha256, "DOC6 provenance differs from its published pin");
  const provenance = JSON.parse(provenanceBytes);
  assert.equal(provenance.schemaVersion, "evleda.doc6-qualified-footprint-runtime.v1");
  assert.deepEqual(provenance.qualificationMarker, { evledaQualifiedFootprintIdentitySync: "evleda.kicad-qualified-footprint-identity-sync.v1" });
  assert.deepEqual(provenance.runtimeDelta.map(delta => delta.path), [DOC6.path, "environment/pyvenv.cfg"], "DOC6 publication contains an unapproved runtime delta");
  const before = original.files.find(file => file.path === DOC6.path);
  assert.ok(before, "Historical DOC5 PCB tool source is missing");
  const after = { ...before, sha256: DOC6.sha256, sizeBytes: DOC6.sizeBytes };
  assert.deepEqual(provenance.runtimeDelta[0], { path: DOC6.path, before, after }, "DOC6 PCB source delta is not bound to DOC5");
  assert.equal(provenance.sourceRestoreMapping.length, 1, "DOC6 source mapping is not the single approved overlay");
  const mapping = provenance.sourceRestoreMapping[0];
  assert.equal(mapping.runtimeRelativePath, DOC6.path);
  assert.equal(mapping.source.sha256, DOC6.sha256); assert.equal(mapping.source.sizeBytes, DOC6.sizeBytes);
  const source = await readFile(path.join(directory, "kicad_mcp", "tools", "pcb.py"));
  assert.equal(sha256(source), DOC6.sha256, "DOC6 PCB overlay source differs from its published pin");
  assert.equal(source.length, DOC6.sizeBytes);
  assert.equal(provenance.patch.sha256, DOC6.patchSha256); assert.equal(provenance.patch.sizeBytes, DOC6.patchBytes);
  const patch = await readFile(path.join(directory, DOC6.patch));
  assert.equal(sha256(patch), DOC6.patchSha256, "DOC6 patch differs from its published pin");
  assert.equal(patch.length, DOC6.patchBytes);
  // Keep original DOC5 pyvenv bytes for the existing exact-home relocation check.
  return { ...original, totalBytes: original.totalBytes - before.sizeBytes + after.sizeBytes,
    files: original.files.map(file => file.path === DOC6.path ? after : file) };
}

/** Authenticate the published DOC7 graph overlay without trusting provenance paths. */
async function doc7Reference(doc6) {
  const directory = path.join(repositoryRoot, "sidecars", "patches", "doc7");
  const bytes = await readFile(path.join(directory, "provenance.json"));
  assert.equal(sha256(bytes), DOC7.provenanceSha256, "DOC7 provenance differs from its published pin");
  const provenance = JSON.parse(bytes);
  assert.equal(provenance.schemaVersion, "evleda.doc7-power-flag-connectivity-runtime.v1");
  assert.deepEqual(provenance.qualificationMarker, { evledaExternalPowerFlagConnectivity: "evleda.kicad-external-power-flag-connectivity.v1" });
  assert.deepEqual(provenance.runtimeDelta.map(delta => delta.path).sort(),
    [...DOC7.sources.map(source => source.path), "environment/pyvenv.cfg"].sort(), "DOC7 contains an unapproved runtime delta");
  assert.deepEqual(provenance.sourceRestoreMapping.map(mapping => mapping.runtimeRelativePath).sort(),
    DOC7.sources.map(source => source.path).sort(), "DOC7 mappings differ from the approved graph overlay");
  const replacements = new Map();
  let totalBytes = doc6.totalBytes;
  for (const source of DOC7.sources) {
    const before = doc6.files.find(file => file.path === source.path);
    assert.ok(before, "DOC7 source has no published DOC6 predecessor");
    const after = { ...before, sha256: source.sha256, sizeBytes: source.sizeBytes };
    assert.deepEqual(provenance.runtimeDelta.find(delta => delta.path === source.path),
      { path: source.path, before, after }, "DOC7 source delta differs from its published predecessor");
    const mapping = provenance.sourceRestoreMapping.find(mapping => mapping.runtimeRelativePath === source.path);
    assert.equal(mapping.source.sha256, source.sha256); assert.equal(mapping.source.sizeBytes, source.sizeBytes);
    const relative = source.path.slice("environment/Lib/site-packages/".length);
    const payload = await readFile(path.join(directory, ...relative.split("/")));
    assert.equal(sha256(payload), source.sha256, "DOC7 graph source differs from its published pin");
    assert.equal(payload.length, source.sizeBytes);
    replacements.set(source.path, after); totalBytes += after.sizeBytes - before.sizeBytes;
  }
  assert.equal(provenance.patch.sha256, DOC7.patchSha256); assert.equal(provenance.patch.sizeBytes, DOC7.patchBytes);
  const patch = await readFile(path.join(directory, "power-flag-connectivity.patch"));
  assert.equal(sha256(patch), DOC7.patchSha256, "DOC7 patch differs from its published pin");
  assert.equal(patch.length, DOC7.patchBytes);
  return { ...doc6, totalBytes, files: doc6.files.map(file => replacements.get(file.path) ?? file) };
}

/** Authenticate the DOC8 singleton no-connect transfer correction on DOC7. */
async function doc8Reference(doc7) {
  const directory = path.join(repositoryRoot, "sidecars", "patches", "doc8");
  const bytes = await readFile(path.join(directory, "provenance.json"));
  assert.equal(sha256(bytes), DOC8.provenanceSha256, "DOC8 provenance differs from its published pin");
  const provenance = JSON.parse(bytes);
  assert.equal(provenance.schemaVersion, "evleda.doc8-no-connect-net-transfer-runtime.v1");
  assert.deepEqual(provenance.runtimeDelta.map(delta => delta.path), [DOC8.path, "environment/pyvenv.cfg"], "DOC8 contains an unapproved runtime delta");
  const before = doc7.files.find(file => file.path === DOC8.path);
  assert.ok(before, "DOC8 source has no published DOC7 predecessor");
  const after = { ...before, sha256: DOC8.sha256, sizeBytes: DOC8.sizeBytes };
  assert.deepEqual(provenance.runtimeDelta[0], { path: DOC8.path, before, after }, "DOC8 source delta differs from its published predecessor");
  assert.equal(provenance.sourceRestoreMapping.length, 1, "DOC8 must contain only the published PCB source overlay");
  const mapping = provenance.sourceRestoreMapping[0];
  assert.equal(mapping.runtimeRelativePath, DOC8.path);
  assert.equal(mapping.source.sha256, DOC8.sha256); assert.equal(mapping.source.sizeBytes, DOC8.sizeBytes);
  const source = await readFile(path.join(directory, "kicad_mcp", "tools", "pcb.py"));
  assert.equal(sha256(source), DOC8.sha256, "DOC8 PCB source differs from its published pin");
  assert.equal(source.length, DOC8.sizeBytes);
  assert.equal(provenance.patch.sha256, DOC8.patchSha256); assert.equal(provenance.patch.sizeBytes, DOC8.patchBytes);
  const patch = await readFile(path.join(directory, DOC8.patch));
  assert.equal(sha256(patch), DOC8.patchSha256, "DOC8 patch differs from its published pin");
  assert.equal(patch.length, DOC8.patchBytes);
  return { ...doc7, totalBytes: doc7.totalBytes - before.sizeBytes + after.sizeBytes,
    files: doc7.files.map(file => file.path === DOC8.path ? after : file) };
}

/** Authenticate ARC planning on DOC7 directly; DOC8 is never a predecessor. */
async function doc9Reference(doc7) {
  const directory = path.join(repositoryRoot, "sidecars", "patches", "doc9");
  const bytes = await readFile(path.join(directory, "provenance.json"));
  assert.equal(sha256(bytes), DOC9.provenanceSha256, "DOC9 provenance differs from its published pin");
  const provenance = JSON.parse(bytes);
  assert.equal(provenance.schemaVersion, "evleda.doc9-bounded-arc-field-layout-runtime.v1");
  assert.equal(provenance.sourceManifest.sha256, "87de3535155cdfcf9650f19409ca4f203b8bba373ce8021ea646f982258b80f7", "DOC9 must derive from frozen DOC7");
  assert.equal(doc7.files.find(file => file.path === DOC6.path)?.sha256, DOC6.sha256, "DOC9 must retain DOC7 PCB behavior");
  assert.deepEqual(provenance.runtimeDelta.map(delta => delta.path), [DOC9.path, "environment/pyvenv.cfg"], "DOC9 contains an unapproved runtime delta");
  const before = doc7.files.find(file => file.path === DOC9.path);
  assert.ok(before, "DOC9 source has no published DOC7 predecessor");
  const after = { ...before, sha256: DOC9.sha256, sizeBytes: DOC9.sizeBytes };
  assert.deepEqual(provenance.runtimeDelta[0], { path: DOC9.path, before, after }, "DOC9 source delta differs from its published predecessor");
  assert.equal(provenance.sourceRestoreMapping.length, 1, "DOC9 must contain only the published field-layout overlay");
  const mapping = provenance.sourceRestoreMapping[0];
  assert.equal(mapping.runtimeRelativePath, DOC9.path);
  assert.equal(mapping.source.sha256, DOC9.sha256); assert.equal(mapping.source.sizeBytes, DOC9.sizeBytes);
  const source = await readFile(path.join(directory, "kicad_mcp", "utils", "field_layout.py"));
  assert.equal(sha256(source), DOC9.sha256, "DOC9 field-layout source differs from its published pin");
  assert.equal(source.length, DOC9.sizeBytes);
  assert.equal(provenance.patch.sha256, DOC9.patchSha256); assert.equal(provenance.patch.sizeBytes, DOC9.patchBytes);
  const patch = await readFile(path.join(directory, DOC9.patch));
  assert.equal(sha256(patch), DOC9.patchSha256, "DOC9 patch differs from its published pin");
  assert.equal(patch.length, DOC9.patchBytes);
  return { ...doc7, totalBytes: doc7.totalBytes - before.sizeBytes + after.sizeBytes,
    files: doc7.files.map(file => file.path === DOC9.path ? after : file) };
}

export function runManifestHelper(mode, root, manifest, finalRoot = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repositoryRoot, "scripts", "build-kicad-inspection-runtime-manifest.mjs"), mode, root, manifest, finalRoot], {
      cwd: repositoryRoot, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(`Runtime ${mode} failed (${code}): ${stderr.trim()}`)));
  });
}

export async function verifyRuntime(paths) {
  const original = await readDoc5Source();
  let candidate;
  try { candidate = JSON.parse(await readFile(paths.manifest, "utf8")); }
  catch (cause) { throw new Error("Destination runtime manifest is unavailable. Run pnpm setup:destination for DOC5, or set both documented runtime environment overrides. Verification was not skipped.", { cause }); }
  const pcb = candidate.files?.find(file => file.path === DOC6.path);
  const isDoc8 = pcb?.sha256 === DOC8.sha256 && pcb?.sizeBytes === DOC8.sizeBytes;
  const isDoc6 = isDoc8 || pcb?.sha256 === DOC6.sha256 && pcb?.sizeBytes === DOC6.sizeBytes;
  const graph = candidate.files?.find(file => file.path === DOC7.sources[0].path);
  const isDoc7 = isDoc6 && graph?.sha256 === DOC7.sources[0].sha256 && graph?.sizeBytes === DOC7.sources[0].sizeBytes;
  const fieldLayout = candidate.files?.find(file => file.path === DOC9.path);
  const isDoc9 = fieldLayout?.sha256 === DOC9.sha256 && fieldLayout?.sizeBytes === DOC9.sizeBytes;
  assert.ok(!isDoc9 || (isDoc7 && !isDoc8), "DOC9 requires the DOC7 graph and PCB behavior; DOC8 cannot be its predecessor");
  const doc6 = isDoc6 ? await doc6Reference(original) : original;
  const doc7 = isDoc7 ? await doc7Reference(doc6) : doc6;
  const reference = isDoc9 ? await doc9Reference(doc7) : isDoc8 && isDoc7 ? await doc8Reference(doc7) : doc7;
  assertDoc5Relocation(reference, candidate, paths.root);
  const result = await runManifestHelper("verify", paths.root, paths.manifest);
  return { ...result, runtimeRoot: paths.root, manifest: paths.manifest, generation: isDoc9 ? "DOC9" : isDoc8 ? "DOC8" : isDoc7 ? "DOC7" : isDoc6 ? "DOC6" : "DOC5",
    doc5SourcePinsVerified: true, ...(isDoc6 ? { doc6SourcePinsVerified: true, doc6ProvenanceSha256: DOC6.provenanceSha256 } : {}),
    ...(isDoc7 ? { doc7SourcePinsVerified: true, doc7ProvenanceSha256: DOC7.provenanceSha256 } : {}),
    ...(isDoc8 ? { doc8SourcePinsVerified: true, doc8ProvenanceSha256: DOC8.provenanceSha256 } : {}),
    ...(isDoc9 ? { doc9SourcePinsVerified: true, doc9ProvenanceSha256: DOC9.provenanceSha256 } : {}),
    allowedRuntimeDelta: ["environment/pyvenv.cfg: home relocation only",
      ...(isDoc6 ? [`${DOC6.path}: published DOC6 qualified-footprint-identity overlay only`] : []),
      ...(isDoc7 ? DOC7.sources.map(source => `${source.path}: published DOC7 power-flag graph overlay only`) : []),
      ...(isDoc8 ? [`${DOC8.path}: published DOC8 singleton no-connect transfer overlay only`] : []),
      ...(isDoc9 ? [`${DOC9.path}: published DOC9 bounded ARC field-layout overlay only`] : [])] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyRuntime(resolveRuntimeCheckPaths(process.argv.slice(2))), null, 2));
}

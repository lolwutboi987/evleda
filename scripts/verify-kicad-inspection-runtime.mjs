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
  const isDoc6 = pcb?.sha256 === DOC6.sha256 && pcb?.sizeBytes === DOC6.sizeBytes;
  const reference = isDoc6 ? await doc6Reference(original) : original;
  assertDoc5Relocation(reference, candidate, paths.root);
  const result = await runManifestHelper("verify", paths.root, paths.manifest);
  return { ...result, runtimeRoot: paths.root, manifest: paths.manifest, generation: isDoc6 ? "DOC6" : "DOC5",
    doc5SourcePinsVerified: true, ...(isDoc6 ? { doc6SourcePinsVerified: true, doc6ProvenanceSha256: DOC6.provenanceSha256 } : {}),
    allowedRuntimeDelta: ["environment/pyvenv.cfg: home relocation only",
      ...(isDoc6 ? [`${DOC6.path}: published DOC6 qualified-footprint-identity overlay only`] : [])] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyRuntime(resolveRuntimeCheckPaths(process.argv.slice(2))), null, 2));
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const doc5ManifestSha256 = "9912ec88f42d4a4fe57692eb95b1653c8b8fbb3df391688a4647b8d56efa8425";
export const doc5ProvenanceSha256 = "188fb348db06f88c6723a8e6cbf3f616914b9795477a5798e13509dffe0cd4d1";
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
  catch (cause) { throw new Error("Destination DOC5 manifest is unavailable. Run pnpm setup:destination, or set both documented runtime environment overrides. Verification was not skipped.", { cause }); }
  assertDoc5Relocation(original, candidate, paths.root);
  const result = await runManifestHelper("verify", paths.root, paths.manifest);
  return { ...result, runtimeRoot: paths.root, manifest: paths.manifest, doc5SourcePinsVerified: true, allowedRuntimeDelta: ["environment/pyvenv.cfg: home relocation only"] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyRuntime(resolveRuntimeCheckPaths(process.argv.slice(2))), null, 2));
}

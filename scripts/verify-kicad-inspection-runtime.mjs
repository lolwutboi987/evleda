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
const DOC10 = Object.freeze({
  provenanceSha256: "01a9f1887849a58605643fc8391793cb7554ce7491189f48731ed8ddb3583c27",
  predecessorManifestSha256: "28be8d5a44cf635fbb0e50609b8a0ae72e2051f68b7cd9897e78b676cb036738",
  patchSha256: "f2a4c28b88c9d1dc5d4197908d0f08e1e81e2d57ffe1e82f430578b5ed241290", patchBytes: 2151,
  receiptSha256: "f13c753aa20aa19f411f67f0ab23563ba085a41028878d5c7bbd00eace7a5b42", receiptBytes: 5030,
  reportSha256: "baff5dcd0e29a95f71409cca152d459a6fea05f0a76578a6f59a22d1e9c4cc05", reportBytes: 8105,
  sources: Object.freeze([
    { path: "environment/Lib/site-packages/kicad_mcp/tools/schematic.py", sha256: "8b0d3707777314fdcc5aff3e47f9e9343a89cbf13171c99b8490f1ae8beb24a1", sizeBytes: 238727 },
    { path: "environment/Lib/site-packages/kicad_mcp/models/visual_qa.py", sha256: "38090b29e1b5ccc7302c72e82f9960e4c163fc4f9b9be2eaa120abf748354cf7", sizeBytes: 41563 },
  ]),
});
const DOC10_ADMISSION_02 = Object.freeze({
  provenanceSha256: "e0e6906e4d4aba182b2f513f598a353b7e703750d3e5e9ffd638181f763cf3a8",
  receiptSha256: "87b10d6a85a6c8dbd8072be608be015b5ef0df92e87a2f911c500f9f1ac6998d", receiptBytes: 5099,
  reportSha256: "5c333161933082327b0ea62ec0a46f5b26374b7751086170d9857056870b78af", reportBytes: 12366,
  admissionSha256: "3273370050019aef03d37e6d33e9a6ed2f9f3834153c819266c8e72d738589dd", admissionBytes: 9122,
  allowedProfileDelta: Object.freeze(["kicadMcpRuntime.runtimeBundle", "kicadMcpRuntime.processTreeSupervision.terminator.path", "kicadMcpRuntime.runtimePolicy.pythonLaunch.argumentsSha256"]),
});
const DOC11 = Object.freeze({
  provenanceSha256: "a7fdc3b43879524d958ce90b71037856cdd36fd7754dfbbdc4e381a6916de1c8",
  sources: Object.freeze([
    { path: DOC6.path, sha256: "f5526ff03f2ca1cda4a155758071c7de98249538b9328b8a5bfe5b1b78b7ecc3", sizeBytes: 187729 },
    { path: "environment/Lib/site-packages/kicad_mcp/utils/footprint_pose.py", sha256: "bd325a508d32f185f2c6cf4275beb40018c461c997f92f141a8df9515283c9b1", sizeBytes: 9168 },
  ]),
});
const DOC12 = Object.freeze({
  path: "evleda_live_pcb_pad_snapshot.py",
  predecessorSha256: "706d682a368449dd8a0423d7c4a4cb56d5458a440e3641caabe4b6251ab917cc",
  sha256: "80abe9675ff5cd81d9fb15ff18b05e7be3fa433a12bfcf9eb3445ccdb7f1f754", sizeBytes: 21804,
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

/** Exactly the independently reviewed cardinal-coordinate correction on DOC9.
 * Published custody paths are data only; no provenance-selected code executes. */
async function doc10Reference(doc9) {
  const directory = path.join(repositoryRoot, "sidecars", "patches", "doc10");
  const bytes = await readFile(path.join(directory, "provenance.json"));
  assert.equal(sha256(bytes), DOC10.provenanceSha256, "DOC10 provenance differs from its published pin");
  const provenance = JSON.parse(bytes);
  assert.equal(provenance.schemaVersion, "evleda.doc10-schematic-cardinal-runtime.v1");
  assert.equal(provenance.predecessor, "DOC9");
  assert.equal(provenance.sourceManifest.sha256, DOC10.predecessorManifestSha256, "DOC10 must derive from frozen DOC9");
  assert.equal(provenance.nativeEvidenceTransferred, false);
  assert.deepEqual(provenance.runtimeDelta.map(delta => delta.path), [...DOC10.sources.map(source => source.path), "environment/pyvenv.cfg"], "DOC10 contains an unapproved runtime delta");
  assert.deepEqual(provenance.sourceRestoreMapping, DOC10.sources.map(source => ({ runtimeRelativePath: source.path,
    source: { sha256: source.sha256, sizeBytes: source.sizeBytes } })), "DOC10 source restoration exceeds its two qualified Python leaves");
  const replacements = new Map(); let totalBytes = doc9.totalBytes;
  for (const [index, source] of DOC10.sources.entries()) {
    const before = doc9.files.find(file => file.path === source.path);
    assert.ok(before, "DOC10 source has no published DOC9 predecessor");
    assert.deepEqual(provenance.runtimeDelta[index].before, { sha256: before.sha256, sizeBytes: before.sizeBytes }, "DOC10 source delta differs from DOC9");
    assert.deepEqual(provenance.runtimeDelta[index].after, { sha256: source.sha256, sizeBytes: source.sizeBytes });
    const restored = await readFile(path.join(directory, ...source.path.replace(/^environment\/Lib\/site-packages\//u, "").split("/")));
    assert.equal(sha256(restored), source.sha256, "DOC10 source differs from its published pin");
    assert.equal(restored.length, source.sizeBytes);
    replacements.set(source.path, { ...before, sha256: source.sha256, sizeBytes: source.sizeBytes });
    totalBytes += source.sizeBytes - before.sizeBytes;
  }
  const publication = [
    ["schematic-cardinal.patch", DOC10.patchSha256, DOC10.patchBytes, provenance.patch],
    ["qualification-receipt.json", DOC10.receiptSha256, DOC10.receiptBytes, provenance.qualificationReceipt],
    ["qualification-report.json", DOC10.reportSha256, DOC10.reportBytes, provenance.qualificationReport],
  ];
  for (const [file, expectedSha256, expectedBytes, pin] of publication) {
    assert.deepEqual(pin, { path: file, sha256: expectedSha256, sizeBytes: expectedBytes });
    const published = await readFile(path.join(directory, file));
    assert.equal(sha256(published), expectedSha256, "DOC10 qualification/patch differs from its published pin");
    assert.equal(published.length, expectedBytes);
  }
  await doc10ProfileAdmissionPublication(doc9, provenance);
  return { ...doc9, totalBytes, files: doc9.files.map(file => replacements.get(file.path) ?? file) };
}

/** Revision02 adds real profile-reader admission; it does not change runtime
 * geometry or claim that the failed -01 profile was ever admitted. */
async function doc10ProfileAdmissionPublication(reference, geometryProvenance) {
  const directory = path.join(repositoryRoot, "sidecars", "patches", "doc10", "profile-admission-02");
  const bytes = await readFile(path.join(directory, "provenance.json"));
  assert.equal(sha256(bytes), DOC10_ADMISSION_02.provenanceSha256, "DOC10 admission provenance differs from its published pin");
  const provenance = JSON.parse(bytes), artifacts = [
    { path: "qualification-receipt.json", sha256: DOC10_ADMISSION_02.receiptSha256, sizeBytes: DOC10_ADMISSION_02.receiptBytes },
    { path: "qualification-report.json", sha256: DOC10_ADMISSION_02.reportSha256, sizeBytes: DOC10_ADMISSION_02.reportBytes },
    { path: "profile-admission.json", sha256: DOC10_ADMISSION_02.admissionSha256, sizeBytes: DOC10_ADMISSION_02.admissionBytes },
  ];
  assert.equal(provenance.schemaVersion, "evleda.doc10-profile-admission-publication.v1");
  assert.equal(provenance.supersedesQualificationReceiptSha256, DOC10.receiptSha256);
  assert.equal(provenance.runtimeUnchanged, true); assert.equal(provenance.nativeImportQualified, false);
  assert.deepEqual(provenance.allowedProfileDelta, DOC10_ADMISSION_02.allowedProfileDelta);
  assert.deepEqual(provenance.artifacts, artifacts);
  const documents = [];
  for (const artifact of artifacts) {
    const source = await readFile(path.join(directory, artifact.path));
    assert.equal(sha256(source), artifact.sha256, "DOC10 admission artifact differs from its published pin"); assert.equal(source.length, artifact.sizeBytes);
    documents.push(JSON.parse(source));
  }
  const [receipt, report, admission] = documents;
  assert.equal(receipt.schemaVersion, "evleda.schematic-cardinal-runtime-qualification.v1");
  assert.deepEqual(receipt.allowedRuntimeChanges, geometryProvenance.runtimeDelta);
  assert.deepEqual(receipt.profilePolicyComparison, { allowedPaths: DOC10_ADMISSION_02.allowedProfileDelta, othersEqual: true });
  assert.equal(receipt.noNativeAcceptanceTransferred, true);
  assert.equal(report.profileAdmission.passed, true); assert.equal(report.profileAdmission.evidence.sha256, DOC10_ADMISSION_02.admissionSha256);
  assert.equal(report.supersedes.receipt.sha256, DOC10.receiptSha256);
  assert.equal(admission.schemaVersion, "evleda.doc10-profile-admission.v1");
  assert.equal(admission.realReadersUsed, true); assert.equal(admission.dependencySeamsInjected, false);
  assert.equal(admission.storeCreated, false); assert.equal(admission.nativeImportRetried, false);
  assert.equal(admission.onlyChangedFromPreviousProfile, DOC10_ADMISSION_02.allowedProfileDelta[2]);
  for (const [name, profile, runtime] of [["DOC9", receipt.sourceProfile, receipt.sourceRuntime], ["DOC10-02", receipt.targetProfile, receipt.targetRuntime]]) {
    const row = admission.results.find(row => row.name === name);
    assert.deepEqual(row.profile, profile); assert.equal(row.readKicadNativeProfile.passed, true); assert.equal(row.loadKicadToolboxFreshProfile.passed, true);
    const launch = row.readKicadNativeProfile.pythonLaunch, arguments_ = ["-I", "-s", "-E", "-B", path.win32.resolve(runtime.root, reference.entrypoint.relativePath)];
    assert.deepEqual(launch.flags, arguments_.slice(0, 4)); assert.equal(launch.argumentCount, 5); assert.equal(launch.bytecodeWrites, "disabled");
    assert.equal(launch.argumentsSha256, sha256(`evleda.kicad-mcp-arguments.v1\0${JSON.stringify(arguments_)}`));
    if (name === "DOC10-02") assert.deepEqual(admission.derivation.arguments, arguments_);
  }
  const rejected = admission.results.find(row => row.name === "DOC10-01");
  assert.equal(rejected.readKicadNativeProfile.passed, false); assert.equal(rejected.loadKicadToolboxFreshProfile.passed, true);
}

/** DOC11 replaces the inherited DOC6 PCB writer and adds one helper to the
 * complete DOC10 reference. Source/oracle publication is not public sync proof. */
async function doc11Reference(doc10) {
  const directory = path.join(repositoryRoot, "sidecars", "patches", "doc11");
  const bytes = await readFile(path.join(directory, "provenance.json"));
  assert.equal(sha256(bytes), DOC11.provenanceSha256, "DOC11 provenance differs from its published pin");
  const provenance = JSON.parse(bytes);
  assert.equal(provenance.schemaVersion, "evleda.doc11-footprint-pose-source-overlay.v1");
  assert.equal(provenance.status, "source-and-isolated-oracle-qualified-runtime-not-published");
  assert.equal(provenance.predecessorModuleSha256, DOC6.sha256);
  assert.deepEqual(provenance.runtimeDelta, DOC11.sources.map(source => source.path), "DOC11 contains an unapproved runtime delta");
  assert.deepEqual(provenance.checks, { offlineTestMethodsPassed: 6, nativeOracleCasesPassed: 20,
    currentTemplateCardinalCasesPassed: 264, completePhysicalMembersPerRotation: 281,
    physicalComparatorChanged: false, nativeProjectChanged: false, runtimePublished: false });
  // The pinned publication contains source, descriptor, patch and isolated
  // oracle/replay evidence. Read only these safe relative artifacts; execute none.
  const artifacts = Object.entries(provenance.artifacts);
  assert.equal(artifacts.length, 138, "DOC11 publication artifact inventory differs");
  let publishedBytes = 0;
  for (const [relative, pin] of artifacts) {
    assert.ok(/^[A-Za-z0-9_.\/-]+$/u.test(relative) && !relative.startsWith("/")
      && relative.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Unsupported DOC11 publication path");
    const payload = await readFile(path.join(directory, ...relative.split("/")));
    assert.equal(sha256(payload), pin.sha256, "DOC11 source/oracle artifact differs from its published pin");
    assert.equal(payload.length, pin.sizeBytes);
    publishedBytes += payload.length;
  }
  assert.equal(publishedBytes, provenance.bytesBeforeManifest);
  const [pcbSource, helperSource] = DOC11.sources;
  const before = doc10.files.find(file => file.path === pcbSource.path);
  assert.ok(before && before.sha256 === DOC6.sha256 && before.sizeBytes === DOC6.sizeBytes, "DOC11 requires the complete DOC10 predecessor PCB source");
  assert.ok(!doc10.files.some(file => file.path === helperSource.path), "DOC11 helper must be the single added runtime leaf");
  assert.ok(doc10.directories.some(entry => entry.path === path.posix.dirname(helperSource.path)), "DOC11 helper parent must already exist in DOC10");
  for (const source of DOC11.sources) {
    assert.deepEqual(provenance.artifacts[source.path.slice("environment/Lib/site-packages/".length)],
      { sha256: source.sha256, sizeBytes: source.sizeBytes }, "DOC11 runtime source mapping differs from its approved overlay");
  }
  const files = doc10.files.map(file => file.path === pcbSource.path ? { ...file, sha256: pcbSource.sha256, sizeBytes: pcbSource.sizeBytes } : file);
  files.push({ ...helperSource, mode: 0o666 });
  files.sort((a, b) => a.path.localeCompare(b.path, "en-US"));
  return { ...doc10, files, fileCount: doc10.fileCount + 1,
    totalBytes: doc10.totalBytes - before.sizeBytes + pcbSource.sizeBytes + helperSource.sizeBytes };
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

async function doc12Reference(doc11) {
  const before = doc11.files.find(file => file.path === DOC12.path);
  assert.ok(before?.sha256 === DOC12.predecessorSha256, "DOC12 requires the unchanged DOC11 PAD producer");
  const source = await readFile(path.join(repositoryRoot, "sidecars/patches/doc12", DOC12.path));
  assert.equal(sha256(source), DOC12.sha256, "DOC12 source differs from its published pin");
  assert.equal(source.length, DOC12.sizeBytes, "DOC12 source size differs from its published pin");
  return { ...doc11, files: doc11.files.map(file => file.path === DOC12.path
    ? { ...file, sha256: DOC12.sha256, sizeBytes: DOC12.sizeBytes } : file),
    totalBytes: doc11.totalBytes - before.sizeBytes + DOC12.sizeBytes };
}

export async function verifyRuntime(paths) {
  const original = await readDoc5Source();
  let candidate;
  try { candidate = JSON.parse(await readFile(paths.manifest, "utf8")); }
  catch (cause) { throw new Error("Destination runtime manifest is unavailable. Run pnpm setup:destination for DOC5, or set both documented runtime environment overrides. Verification was not skipped.", { cause }); }
  const pcb = candidate.files?.find(file => file.path === DOC6.path);
  const doc11Matches = DOC11.sources.map(source => candidate.files?.some(file => file.path === source.path && file.sha256 === source.sha256 && file.sizeBytes === source.sizeBytes) === true);
  const isDoc11 = doc11Matches.every(Boolean);
  const padSnapshot = candidate.files?.find(file => file.path === DOC12.path);
  const isDoc12 = padSnapshot?.sha256 === DOC12.sha256 && padSnapshot?.sizeBytes === DOC12.sizeBytes;
  const hasDoc11Leaf = doc11Matches.some(Boolean) || candidate.files?.some(file => file.path === DOC11.sources[1].path);
  const isDoc8 = pcb?.sha256 === DOC8.sha256 && pcb?.sizeBytes === DOC8.sizeBytes;
  const isDoc6 = isDoc11 || isDoc8 || pcb?.sha256 === DOC6.sha256 && pcb?.sizeBytes === DOC6.sizeBytes;
  const graph = candidate.files?.find(file => file.path === DOC7.sources[0].path);
  const doc10Matches = DOC10.sources.map(source => candidate.files?.some(file => file.path === source.path && file.sha256 === source.sha256 && file.sizeBytes === source.sizeBytes) === true);
  const isDoc10 = doc10Matches.every(Boolean);
  const isDoc7 = isDoc6 && (isDoc10 || graph?.sha256 === DOC7.sources[0].sha256 && graph?.sizeBytes === DOC7.sources[0].sizeBytes);
  const fieldLayout = candidate.files?.find(file => file.path === DOC9.path);
  const isDoc9 = fieldLayout?.sha256 === DOC9.sha256 && fieldLayout?.sizeBytes === DOC9.sizeBytes;
  assert.ok(!hasDoc11Leaf || (isDoc11 && isDoc10 && isDoc9 && !isDoc8), "DOC11 requires both qualified pose leaves on the complete DOC10 lineage; partial or mixed overlays are forbidden");
  assert.ok(!isDoc12 || isDoc11, "DOC12 requires the complete DOC11 lineage");
  assert.ok(!doc10Matches.some(Boolean) || (isDoc10 && isDoc9 && isDoc6 && !isDoc8), "DOC10 requires both qualified cardinal leaves on the complete DOC9/DOC7 lineage; DOC8 cannot be its predecessor");
  assert.ok(!isDoc9 || (isDoc7 && !isDoc8), "DOC9 requires the DOC7 graph and PCB behavior; DOC8 cannot be its predecessor");
  const doc6 = isDoc6 ? await doc6Reference(original) : original;
  const doc7 = isDoc7 ? await doc7Reference(doc6) : doc6;
  const doc9 = isDoc9 ? await doc9Reference(doc7) : isDoc8 && isDoc7 ? await doc8Reference(doc7) : doc7;
  const doc10 = isDoc10 ? await doc10Reference(doc9) : doc9;
  const doc11 = isDoc11 ? await doc11Reference(doc10) : doc10;
  const reference = isDoc12 ? await doc12Reference(doc11) : doc11;
  assertDoc5Relocation(reference, candidate, paths.root);
  const result = await runManifestHelper("verify", paths.root, paths.manifest);
  return { ...result, runtimeRoot: paths.root, manifest: paths.manifest, generation: isDoc12 ? "DOC12" : isDoc11 ? "DOC11" : isDoc10 ? "DOC10" : isDoc9 ? "DOC9" : isDoc8 ? "DOC8" : isDoc7 ? "DOC7" : isDoc6 ? "DOC6" : "DOC5",
    doc5SourcePinsVerified: true, ...(isDoc6 ? { doc6SourcePinsVerified: true, doc6ProvenanceSha256: DOC6.provenanceSha256 } : {}),
    ...(isDoc7 ? { doc7SourcePinsVerified: true, doc7ProvenanceSha256: DOC7.provenanceSha256 } : {}),
    ...(isDoc8 ? { doc8SourcePinsVerified: true, doc8ProvenanceSha256: DOC8.provenanceSha256 } : {}),
    ...(isDoc9 ? { doc9SourcePinsVerified: true, doc9ProvenanceSha256: DOC9.provenanceSha256 } : {}),
    ...(isDoc10 ? { doc10SourcePinsVerified: true, doc10ProvenanceSha256: DOC10.provenanceSha256,
      doc10GeometryQualificationReceiptSha256: DOC10.receiptSha256, doc10QualificationReceiptSha256: DOC10_ADMISSION_02.receiptSha256,
      doc10ProfileAdmissionPublicationSha256: DOC10_ADMISSION_02.provenanceSha256 } : {}),
    ...(isDoc11 ? { doc11SourcePinsVerified: true, doc11ProvenanceSha256: DOC11.provenanceSha256,
      doc11QualificationScope: "published-source-and-isolated-footprint-oracle-only", doc11NativePublicSyncQualified: false } : {}),
    ...(isDoc12 ? { doc12SourcePinsVerified: true, doc12ProducerSha256: DOC12.sha256,
      doc12QualificationScope: "source-and-offline-envelope-only", doc12NativeRoutingQualified: false } : {}),
    allowedRuntimeDelta: ["environment/pyvenv.cfg: home relocation only",
      ...(isDoc6 ? [`${DOC6.path}: published DOC6 qualified-footprint-identity overlay only`] : []),
      ...(isDoc7 ? DOC7.sources.map(source => `${source.path}: published DOC7 power-flag graph overlay only`) : []),
      ...(isDoc8 ? [`${DOC8.path}: published DOC8 singleton no-connect transfer overlay only`] : []),
      ...(isDoc9 ? [`${DOC9.path}: published DOC9 bounded ARC field-layout overlay only`] : []),
      ...(isDoc10 ? DOC10.sources.map(source => `${source.path}: published DOC10 schematic-cardinal correction only`) : []),
      ...(isDoc11 ? DOC11.sources.map(source => `${source.path}: published DOC11 footprint-pose overlay only`) : []),
      ...(isDoc12 ? [`${DOC12.path}: published DOC12 compact complete PAD envelope only`] : [])] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await verifyRuntime(resolveRuntimeCheckPaths(process.argv.slice(2))), null, 2));
  } catch (error) {
    if (process.env.GITHUB_ACTIONS === "true") {
      // Publish fixed, nonsensitive diagnostics in the job annotations. Keep
      // the original exception and every native integrity check unchanged.
      const missingManifest = error instanceof Error
        && error.message.startsWith("Destination runtime manifest is unavailable.")
        && error.cause?.code === "ENOENT";
      console.error(missingManifest
        ? "::error title=Native KiCad runtime not provisioned::This verification requires the separately installed, pinned KiCad runtime and its matching manifest. The checkout alone is insufficient. See docs/destination-setup.md for setup and both runtime environment overrides. Verification was not skipped."
        : "::error title=Native KiCad runtime verification failed::The pinned native runtime did not pass verification. Inspect the original failure in this job log; no integrity check was disabled.");
    }
    throw error;
  }
}

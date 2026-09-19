import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertDoc5Relocation, pyvenvText, readDoc5Source, resolveRuntimeCheckPaths, sha256, verifyRuntime } from "../../scripts/verify-kicad-inspection-runtime.mjs";
import type { Doc5Manifest } from "../../scripts/verify-kicad-inspection-runtime.mjs";

// Unit tests exercise publication/delta policy. A separate real helper invocation
// verifies the installed closure; these tests never alter published source files.
const control = vi.hoisted(() => ({ tamper: "", helperExitCode: 0, spawn: vi.fn(), manifests: new Map<string, string>() }));
vi.mock("node:child_process", () => ({ spawn: control.spawn }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const supplied = control.manifests.get(String(args[0]));
    const bytes = supplied === undefined ? await actual.readFile(...args) : args[1] === "utf8" ? supplied : Buffer.from(supplied);
    return control.tamper !== "" && String(args[0]).replaceAll("\\", "/").endsWith(control.tamper)
      ? Buffer.from("modified publication bytes") : bytes;
  } };
});
let fixtureSequence = 0;
afterEach(() => {
  control.tamper = ""; control.helperExitCode = 0; control.spawn.mockReset();
  control.manifests.clear();
});

describe("destination DOC5 runtime verification", () => {
  let original: Doc5Manifest;
  const root = path.resolve("runtime-fixture-doc5");
  const relocated = () => {
    const value = structuredClone(original);
    const leaf = value.files.find(file => file.path === "environment/pyvenv.cfg")!;
    const bytes = Buffer.from(pyvenvText(root));
    value.totalBytes += bytes.length - leaf.sizeBytes;
    Object.assign(leaf, { sha256: sha256(bytes), sizeBytes: bytes.length });
    return value;
  };
  beforeAll(async () => { original = await readDoc5Source(); });

  it("uses destination-relative defaults without machine-specific DOC2 paths", () => {
    const repo = path.resolve("transfer", "evleda");
    expect(resolveRuntimeCheckPaths([], {}, repo)).toEqual({
      root: path.resolve(repo, "..", "working-runtime", "inspection-runtime-3.33.3-doc5"),
      manifest: path.resolve(repo, "..", "working-profiles", "kicad-inspection-runtime-manifest-doc5.json"),
    });
  });
  it("requires paired explicit environment overrides", () => {
    expect(() => resolveRuntimeCheckPaths([], { EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT: root })).toThrow(/Both runtime/);
    expect(() => resolveRuntimeCheckPaths([], { EVLEDA_KICAD_INSPECTION_RUNTIME_MANIFEST: "manifest.json" })).toThrow(/Both runtime/);
    expect(() => resolveRuntimeCheckPaths([root])).toThrow(/Provide/);
    expect(resolveRuntimeCheckPaths([root, "manifest.json"], {})).toEqual({ root, manifest: path.resolve("manifest.json") });
  });
  it("accepts exactly the pyvenv home relocation against published DOC5 source", () => {
    expect(() => assertDoc5Relocation(original, relocated(), root)).not.toThrow();
  });
  it("rejects the historical home and further Python configuration changes", () => {
    expect(() => assertDoc5Relocation(original, original, root)).toThrow(/approved pyvenv/);
    const value = relocated();
    value.files.find(file => file.path === "environment/pyvenv.cfg")!.sha256 = sha256("include-system-site-packages = true");
    expect(() => assertDoc5Relocation(original, value, root)).toThrow(/approved pyvenv/);
  });
  it("rejects changed transaction code even if a new tree hash was generated", () => {
    const value = relocated();
    value.files.find(file => file.path.endsWith("kicad_mcp/pcb/transaction_lifecycle.py"))!.sha256 = "a".repeat(64);
    value.treeIdentity.digest = "b".repeat(64);
    expect(() => assertDoc5Relocation(original, value, root)).toThrow(/approved pyvenv/);
  });
  it("rejects additional runtime files and altered directory closure", () => {
    const extra = relocated(); extra.files.push({ path: "extra.py", sha256: sha256(""), sizeBytes: 0, mode: 438 });
    expect(() => assertDoc5Relocation(original, extra, root)).toThrow(/approved pyvenv/);
    const directory = relocated(); directory.directories[0]!.mode = 0;
    expect(() => assertDoc5Relocation(original, directory, root)).toThrow(/directory closure/);
  });
  it("rejects rewritten protocol and Python identities", () => {
    const value = relocated(); value.protocol.serverVersion = "fake";
    expect(() => assertDoc5Relocation(original, value, root)).toThrow(/protocol differs/);
    const python = relocated(); python.python.version = "3.14";
    expect(() => assertDoc5Relocation(original, python, root)).toThrow(/python differs/);
  });
});

describe("published DOC6 runtime verification", () => {
  let original: Doc5Manifest;
  const pcbPath = "environment/Lib/site-packages/kicad_mcp/tools/pcb.py";
  beforeAll(async () => { original = await readDoc5Source(); });
  async function fixture(doc6 = true, doc7 = false, doc8 = false, doc9 = false, doc10 = false, doc11 = false, doc12 = false) {
    // Manifests stay in memory: zero test temp bytes and no copied runtime tree.
    const directory = path.join(tmpdir(), `evleda-runtime-policy-${process.pid}-${++fixtureSequence}`);
    const root = path.join(directory, "runtime"), manifest = path.join(directory, "manifest.json");
    const candidate = structuredClone(original);
    const cfg = candidate.files.find(file => file.path === "environment/pyvenv.cfg")!, cfgBytes = Buffer.from(pyvenvText(root));
    candidate.totalBytes += cfgBytes.length - cfg.sizeBytes;
    Object.assign(cfg, { sha256: sha256(cfgBytes), sizeBytes: cfgBytes.length });
    if (doc6) {
      const pcb = candidate.files.find(file => file.path === pcbPath)!;
      candidate.totalBytes += 187502 - pcb.sizeBytes;
      Object.assign(pcb, { sha256: "cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0", sizeBytes: 187502 });
    }
    if (doc7) {
      const publication = JSON.parse(await readFile(path.resolve("sidecars/patches/doc7/provenance.json"), "utf8"));
      for (const mapping of publication.sourceRestoreMapping) {
        const leaf = candidate.files.find(file => file.path === mapping.runtimeRelativePath)!;
        candidate.totalBytes += mapping.source.sizeBytes - leaf.sizeBytes;
        Object.assign(leaf, { sha256: mapping.source.sha256, sizeBytes: mapping.source.sizeBytes });
      }
    }
    if (doc8) {
      const publication = JSON.parse(await readFile(path.resolve("sidecars/patches/doc8/provenance.json"), "utf8"));
      for (const mapping of publication.sourceRestoreMapping) {
        const leaf = candidate.files.find(file => file.path === mapping.runtimeRelativePath)!;
        candidate.totalBytes += mapping.source.sizeBytes - leaf.sizeBytes;
        Object.assign(leaf, { sha256: mapping.source.sha256, sizeBytes: mapping.source.sizeBytes });
      }
    }
    if (doc9) {
      const publication = JSON.parse(await readFile(path.resolve("sidecars/patches/doc9/provenance.json"), "utf8"));
      for (const mapping of publication.sourceRestoreMapping) {
        const leaf = candidate.files.find(file => file.path === mapping.runtimeRelativePath)!;
        candidate.totalBytes += mapping.source.sizeBytes - leaf.sizeBytes;
        Object.assign(leaf, { sha256: mapping.source.sha256, sizeBytes: mapping.source.sizeBytes });
      }
    }
    if (doc10) {
      const publication = JSON.parse(await readFile(path.resolve("sidecars/patches/doc10/provenance.json"), "utf8"));
      for (const mapping of publication.sourceRestoreMapping) {
        const leaf = candidate.files.find(file => file.path === mapping.runtimeRelativePath)!;
        candidate.totalBytes += mapping.source.sizeBytes - leaf.sizeBytes;
        Object.assign(leaf, { sha256: mapping.source.sha256, sizeBytes: mapping.source.sizeBytes });
      }
    }
    if (doc11) {
      const pcb = candidate.files.find(file => file.path === pcbPath)!;
      candidate.totalBytes += 187729 - pcb.sizeBytes + 9168;
      Object.assign(pcb, { sha256: "f5526ff03f2ca1cda4a155758071c7de98249538b9328b8a5bfe5b1b78b7ecc3", sizeBytes: 187729 });
      candidate.files.push({ path: "environment/Lib/site-packages/kicad_mcp/utils/footprint_pose.py",
        sha256: "bd325a508d32f185f2c6cf4275beb40018c461c997f92f141a8df9515283c9b1", sizeBytes: 9168, mode: 438 });
      candidate.fileCount = candidate.files.length;
      candidate.files.sort((a, b) => a.path.localeCompare(b.path, "en-US"));
    }
    if (doc12) {
      const leaf = candidate.files.find(file => file.path === "evleda_live_pcb_pad_snapshot.py")!;
      candidate.totalBytes += 21804 - leaf.sizeBytes;
      Object.assign(leaf, { sha256: "80abe9675ff5cd81d9fb15ff18b05e7be3fa433a12bfcf9eb3445ccdb7f1f754", sizeBytes: 21804 });
    }
    control.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        if (control.helperExitCode === 0) child.stdout.emit("data", JSON.stringify({ fileCount: candidate.files.length, totalBytes: candidate.totalBytes }));
        else child.stderr.emit("data", "Runtime tree does not reproduce the pinned manifest");
        child.emit("close", control.helperExitCode);
      });
      return child;
    });
    const save = async () => { control.manifests.set(manifest, JSON.stringify(candidate)); };
    await save();
    return { root, manifest, candidate, save };
  }
  it("authenticates the DOC6 source/patch publication and reports only its two allowed changes", async () => {
    const f = await fixture();
    await expect(verifyRuntime(f)).resolves.toMatchObject({ generation: "DOC6", doc5SourcePinsVerified: true, doc6SourcePinsVerified: true,
      doc6ProvenanceSha256: "fc41d63217b04bcd2bd70bf3b6311abe3970bcc331629ea6c0f5f1983a9f585d",
      allowedRuntimeDelta: ["environment/pyvenv.cfg: home relocation only", `${pcbPath}: published DOC6 qualified-footprint-identity overlay only`] });
    expect(control.spawn).toHaveBeenCalledOnce();
    expect(control.spawn.mock.calls[0]![1]).toEqual([expect.stringContaining("build-kicad-inspection-runtime-manifest.mjs"), "verify", f.root, f.manifest, f.root]);
  });
  it("keeps DOC5 generation and default policy unchanged", async () => {
    const f = await fixture(false);
    await expect(verifyRuntime(f)).resolves.toMatchObject({ generation: "DOC5", doc5SourcePinsVerified: true, allowedRuntimeDelta: ["environment/pyvenv.cfg: home relocation only"] });
  });
  it("authenticates DOC7 on top of DOC6 without accepting unrelated runtime changes", async () => {
    const f = await fixture(true, true);
    await expect(verifyRuntime(f)).resolves.toMatchObject({ generation: "DOC7", doc5SourcePinsVerified: true,
      doc6SourcePinsVerified: true, doc7SourcePinsVerified: true,
      doc7ProvenanceSha256: "544905cf360b0bd47bc9eeaed3eadaeec774eac20f87b7f325469952108cdf82" });
    expect(control.spawn).toHaveBeenCalledOnce(); control.spawn.mockClear();
    f.candidate.files.find(file => file.path.endsWith("pcb/transaction_lifecycle.py"))!.sha256 = "a".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/);
    expect(control.spawn).not.toHaveBeenCalled();
  });
  it("authenticates DOC8 on the complete DOC7 source and rejects further edits", async () => {
    const f = await fixture(true, true, true);
    await expect(verifyRuntime(f)).resolves.toMatchObject({ generation: "DOC8", doc5SourcePinsVerified: true,
      doc6SourcePinsVerified: true, doc7SourcePinsVerified: true, doc8SourcePinsVerified: true,
      doc8ProvenanceSha256: "74ce175cad4efbbc9f6e6571ae6962c71f88bde861049c7215dda9eb963e1795" });
    expect(control.spawn).toHaveBeenCalledOnce(); control.spawn.mockClear();
    f.candidate.files.find(file => file.path.endsWith("pcb/transaction_lifecycle.py"))!.sha256 = "a".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/);
    expect(control.spawn).not.toHaveBeenCalled();
  });
  it("authenticates DOC9 directly on DOC7 with the bounded ARC overlay", async () => {
    const f = await fixture(true, true, false, true);
    const result = await verifyRuntime(f);
    expect(result).toMatchObject({ generation: "DOC9", doc5SourcePinsVerified: true,
      doc6SourcePinsVerified: true, doc7SourcePinsVerified: true, doc9SourcePinsVerified: true,
      doc9ProvenanceSha256: "5bcc8899c65fa4fdf9a2da6737d2fc6d63c64df819493cc9120c87972cccbcdf" });
    expect(result).not.toHaveProperty("doc8SourcePinsVerified");
    expect(control.spawn).toHaveBeenCalledOnce();
    control.spawn.mockClear();
    f.candidate.files.find(file => file.path.endsWith("pcb/transaction_lifecycle.py"))!.sha256 = "a".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/);
    expect(control.spawn).not.toHaveBeenCalled();
  });
  it("authenticates exactly the DOC10 cardinal correction on DOC9 and still requires full tree verification", async () => {
    const f = await fixture(true, true, false, true, true);
    await expect(verifyRuntime(f)).resolves.toMatchObject({ generation: "DOC10", doc5SourcePinsVerified: true, doc6SourcePinsVerified: true,
      doc7SourcePinsVerified: true, doc9SourcePinsVerified: true, doc10SourcePinsVerified: true,
      doc10ProvenanceSha256: "01a9f1887849a58605643fc8391793cb7554ce7491189f48731ed8ddb3583c27",
      doc10GeometryQualificationReceiptSha256: "f13c753aa20aa19f411f67f0ab23563ba085a41028878d5c7bbd00eace7a5b42",
      doc10QualificationReceiptSha256: "87b10d6a85a6c8dbd8072be608be015b5ef0df92e87a2f911c500f9f1ac6998d",
      doc10ProfileAdmissionPublicationSha256: "e0e6906e4d4aba182b2f513f598a353b7e703750d3e5e9ffd638181f763cf3a8" });
    expect(control.spawn).toHaveBeenCalledOnce(); control.helperExitCode = 1;
    await expect(verifyRuntime(f)).rejects.toThrow(/Runtime verify failed.*pinned manifest/);
  });
  it("authenticates the complete DOC11 overlay without requiring the replaced DOC6 PCB leaf or claiming public sync qualification", async () => {
    const f = await fixture(true, true, false, true, true, true);
    expect(f.candidate.files).toHaveLength(original.files.length + 1);
    expect(f.candidate.directories).toEqual(original.directories);
    const result = await verifyRuntime(f);
    expect(result).toMatchObject({ generation: "DOC11", doc5SourcePinsVerified: true, doc6SourcePinsVerified: true,
      doc7SourcePinsVerified: true, doc9SourcePinsVerified: true, doc10SourcePinsVerified: true, doc11SourcePinsVerified: true,
      doc11ProvenanceSha256: "a7fdc3b43879524d958ce90b71037856cdd36fd7754dfbbdc4e381a6916de1c8",
      doc11QualificationScope: "published-source-and-isolated-footprint-oracle-only", doc11NativePublicSyncQualified: false });
    expect(result).not.toHaveProperty("doc8SourcePinsVerified");
    expect(control.spawn).toHaveBeenCalledOnce();
    expect(control.spawn.mock.calls[0]![1]).toEqual([expect.stringContaining("build-kicad-inspection-runtime-manifest.mjs"), "verify", f.root, f.manifest, f.root]);
    control.helperExitCode = 1;
    await expect(verifyRuntime(f)).rejects.toThrow(/Runtime verify failed.*pinned manifest/);
  });
  it("authenticates DOC12 on complete DOC11 and still requires the native runtime tree check", async () => {
    const f = await fixture(true, true, false, true, true, true, true);
    await expect(verifyRuntime(f)).resolves.toMatchObject({ generation: "DOC12", doc11SourcePinsVerified: true,
      doc12SourcePinsVerified: true, doc12NativeRoutingQualified: false });
    expect(control.spawn).toHaveBeenCalledOnce();
    control.helperExitCode = 1;
    await expect(verifyRuntime(f)).rejects.toThrow(/Runtime verify failed.*pinned manifest/);
  });
  it.each(["source", "producer", "missing-DOC11", "unrelated-leaf"])("rejects DOC12 %s drift before executing the tree checker", async kind => {
    const f = await fixture(true, true, false, true, true, kind !== "missing-DOC11", true);
    if (kind === "source") control.tamper = "sidecars/patches/doc12/evleda_live_pcb_pad_snapshot.py";
    if (kind === "producer") f.candidate.files.find(file => file.path === "evleda_live_pcb_pad_snapshot.py")!.sha256 = "a".repeat(64);
    if (kind === "unrelated-leaf") f.candidate.files.find(file => file.path.endsWith("pcb/transaction_lifecycle.py"))!.sha256 = "a".repeat(64);
    await f.save();
    await expect(verifyRuntime(f)).rejects.toThrow();
    expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["provenance.json", "sync-footprint-pose.patch", "kicad_mcp/tools/pcb.py", "kicad_mcp/utils/footprint_pose.py",
    "registered-production-descriptor.json", "oracle-final/manifest.json", "oracle-final/qfn-270.kicad_pcb", "template-replay-final.json"])("rejects DOC11 publication drift in %s", async leaf => {
    const f = await fixture(true, true, false, true, true, true); control.tamper = `sidecars/patches/doc11/${leaf}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC11.*published pin/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["missing-helper", "unknown-helper", "old-PCB", "DOC8-PCB", "unknown-PCB", "missing-cardinal", "missing-field-layout",
    "topology", "extra-file", "duplicate-helper", "helper-mode", "file-count", "directory", "Python", "python-home"])("rejects DOC11 partial/mixed/unapproved %s", async kind => {
    const f = await fixture(true, true, false, true, true, true), files = f.candidate.files;
    const helper = files.find(file => file.path.endsWith("utils/footprint_pose.py"))!;
    if (kind === "missing-helper") f.candidate.files = files.filter(file => file !== helper);
    else if (kind === "unknown-helper") helper.sha256 = "a".repeat(64);
    else if (kind === "old-PCB") Object.assign(files.find(file => file.path === pcbPath)!, { sha256: "cebed5c9e87abd799c4c6baab9ddb60224c9dface1e0e44b0eea91f56fb6a2e0", sizeBytes: 187502 });
    else if (kind === "DOC8-PCB") Object.assign(files.find(file => file.path === pcbPath)!, { sha256: "8e5810bc7879b636c42c8d6e0d561875b3d16bd2222272a2ea58bd5f7aeefddf", sizeBytes: 189117 });
    else if (kind === "unknown-PCB") files.find(file => file.path === pcbPath)!.sha256 = "a".repeat(64);
    else if (kind === "missing-cardinal") files.find(file => file.path.endsWith("models/visual_qa.py"))!.sha256 = "a".repeat(64);
    else if (kind === "missing-field-layout") files.find(file => file.path.endsWith("utils/field_layout.py"))!.sha256 = "a".repeat(64);
    else if (kind === "topology") files.find(file => file.path.endsWith("schematic/topology.py"))!.sha256 = "a".repeat(64);
    else if (kind === "extra-file") files.push({ path: "extra.pyc", sha256: "a".repeat(64), sizeBytes: 1, mode: 438 });
    else if (kind === "duplicate-helper") files.push({ ...helper });
    else if (kind === "helper-mode") helper.mode = 0;
    else if (kind === "file-count") f.candidate.fileCount = original.files.length;
    else if (kind === "directory") f.candidate.directories[0]!.mode = 0;
    else if (kind === "Python") f.candidate.python.version = "3.14";
    else files.find(file => file.path === "environment/pyvenv.cfg")!.sha256 = "a".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(); expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["doc7/power-flag-connectivity.patch", "doc9/bounded-arc-field-layout.patch", "doc10/profile-admission-02/profile-admission.json"])("retains predecessor publication verification for DOC11: %s", async relative => {
    const f = await fixture(true, true, false, true, true, true); control.tamper = `sidecars/patches/${relative}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/published pin/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["provenance.json", "schematic-cardinal.patch", "qualification-receipt.json", "qualification-report.json", "kicad_mcp/tools/schematic.py", "kicad_mcp/models/visual_qa.py"])("rejects DOC10 publication drift in %s", async leaf => {
    const f = await fixture(true, true, false, true, true); control.tamper = `sidecars/patches/doc10/${leaf}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC10.*published pin/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["provenance.json", "qualification-receipt.json", "qualification-report.json", "profile-admission.json"])("rejects DOC10 revision02 admission drift in %s", async leaf => {
    const f = await fixture(true, true, false, true, true); control.tamper = `sidecars/patches/doc10/profile-admission-02/${leaf}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC10 admission.*published pin/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["partial-cardinal", "field-layout", "DOC8", "topology", "extra-file", "directory", "Python"])("rejects DOC10 adjacent or partial %s drift", async kind => {
    const f = await fixture(true, true, kind === "DOC8", true, true);
    if (kind === "partial-cardinal") f.candidate.files.find(file => file.path.endsWith("models/visual_qa.py"))!.sha256 = "a".repeat(64);
    else if (kind === "field-layout") f.candidate.files.find(file => file.path.endsWith("utils/field_layout.py"))!.sha256 = "a".repeat(64);
    else if (kind === "topology") f.candidate.files.find(file => file.path.endsWith("schematic/topology.py"))!.sha256 = "a".repeat(64);
    else if (kind === "extra-file") f.candidate.files.push({ path: "extra.pyc", sha256: "a".repeat(64), sizeBytes: 1, mode: 438 });
    else if (kind === "directory") f.candidate.directories[0]!.mode = 0;
    else if (kind === "Python") f.candidate.python.version = "3.14";
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(); expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["provenance.json", "bounded-arc-field-layout.patch", "kicad_mcp/utils/field_layout.py"])("rejects DOC9 publication drift in %s", async leaf => {
    const f = await fixture(true, true, false, true); control.tamper = `sidecars/patches/doc9/${leaf}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC9.*published pin/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("rejects DOC9 mixed with the DOC8 no-connect filter", async () => {
    const f = await fixture(true, true, true, true);
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC9 requires.*DOC7.*DOC8/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("rejects DOC9 without the DOC7 graph overlay", async () => {
    const f = await fixture(true, false, false, true);
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC9 requires.*DOC7/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("rejects a partial DOC7 graph overlay beneath DOC9", async () => {
    const f = await fixture(true, true, false, true);
    f.candidate.files.find(file => file.path.endsWith("kicad_mcp/schematic/topology.py"))!.sha256 = "b".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("rejects an unrecognized ARC source even with new manifest identities", async () => {
    const f = await fixture(true, true, false, true);
    f.candidate.files.find(file => file.path.endsWith("utils/field_layout.py"))!.sha256 = "b".repeat(64);
    f.candidate.treeIdentity.digest = "c".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("requires actual complete DOC9 closure verification after publication checks", async () => {
    const f = await fixture(true, true, false, true); control.helperExitCode = 1;
    await expect(verifyRuntime(f)).rejects.toThrow(/Runtime verify failed.*pinned manifest/);
    expect(control.spawn).toHaveBeenCalledOnce();
  });
  it.each(["provenance.json", "no-connect-net-transfer.patch", "kicad_mcp/tools/pcb.py"])("rejects DOC8 publication drift in %s", async leaf => {
    const f = await fixture(true, true, true); control.tamper = `sidecars/patches/doc8/${leaf}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC8.*published pin/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("rejects DOC8 without its required DOC7 graph overlay", async () => {
    const f = await fixture(true, false, true);
    await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("rejects a partial DOC7 graph overlay beneath DOC8", async () => {
    const f = await fixture(true, true, true);
    f.candidate.files.find(file => file.path.endsWith("kicad_mcp/schematic/topology.py"))!.sha256 = "b".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["provenance.json", "power-flag-connectivity.patch", "kicad_mcp/tools/schematic.py",
    "kicad_mcp/tools/schematic_topology.py", "kicad_mcp/schematic/topology.py"])("rejects DOC7 publication drift in %s", async leaf => {
    const f = await fixture(true, true); control.tamper = `sidecars/patches/doc7/${leaf}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC7.*published pin/); expect(control.spawn).not.toHaveBeenCalled();
  });
  it("rejects a partial DOC7 overlay", async () => {
    const f = await fixture(true, true);
    f.candidate.files.find(file => file.path.endsWith("kicad_mcp/schematic/topology.py"))!.sha256 = "b".repeat(64);
    await f.save(); await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/);
    expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["provenance.json", "kicad_mcp/tools/pcb.py", "qualified-footprint-identity-sync.patch"])("rejects DOC6 publication drift in %s before tree verification", async leaf => {
    const f = await fixture(); control.tamper = `sidecars/patches/doc6/${leaf}`;
    await expect(verifyRuntime(f)).rejects.toThrow(/DOC6.*published pin/);
    expect(control.spawn).not.toHaveBeenCalled();
  });
  it.each(["extra-edit", "unknown-pcb", "protocol", "directory", "python-home"])("rejects an additional DOC6 %s change even with new manifest identities", async kind => {
    const f = await fixture();
    if (kind === "extra-edit") f.candidate.files.find(file => file.path.endsWith("pcb/transaction_lifecycle.py"))!.sha256 = "a".repeat(64);
    if (kind === "unknown-pcb") f.candidate.files.find(file => file.path === pcbPath)!.sha256 = "b".repeat(64);
    if (kind === "protocol") f.candidate.protocol.serverVersion = "changed";
    if (kind === "directory") f.candidate.directories[0]!.mode = 0;
    if (kind === "python-home") f.candidate.files.find(file => file.path === "environment/pyvenv.cfg")!.sha256 = "c".repeat(64);
    f.candidate.treeIdentity.digest = "d".repeat(64); await f.save();
    await expect(verifyRuntime(f)).rejects.toThrow(/Runtime/);
    expect(control.spawn).not.toHaveBeenCalled();
  });
  it("requires the full existing closure verifier to pass after publication checks", async () => {
    const f = await fixture(); control.helperExitCode = 1;
    await expect(verifyRuntime(f)).rejects.toThrow(/Runtime verify failed.*pinned manifest/);
    expect(control.spawn).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(f.manifest, "utf8"))).toEqual(f.candidate);
  });
});

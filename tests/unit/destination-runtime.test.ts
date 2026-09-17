import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertDoc5Relocation, pyvenvText, readDoc5Source, resolveRuntimeCheckPaths, sha256, verifyRuntime } from "../../scripts/verify-kicad-inspection-runtime.mjs";
import type { Doc5Manifest } from "../../scripts/verify-kicad-inspection-runtime.mjs";

// Unit tests exercise publication/delta policy. A separate real helper invocation
// verifies the installed closure; these tests never alter published source files.
const control = vi.hoisted(() => ({ tamper: "", helperExitCode: 0, spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: control.spawn }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const bytes = await actual.readFile(...args);
    return control.tamper !== "" && String(args[0]).replaceAll("\\", "/").endsWith(control.tamper)
      ? Buffer.from("modified publication bytes") : bytes;
  } };
});
const temporaryRoots: string[] = [];
afterEach(async () => {
  control.tamper = ""; control.helperExitCode = 0; control.spawn.mockReset();
  for (const root of temporaryRoots.splice(0)) {
    const target = await realpath(root), parent = await realpath(tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith("evleda-runtime-policy-")) throw new Error("Runtime policy test cleanup escaped its owned temporary root");
    await rm(target, { recursive: true, force: true });
  }
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
  async function fixture(doc6 = true, doc7 = false, doc8 = false, doc9 = false) {
    const directory = await mkdtemp(path.join(tmpdir(), "evleda-runtime-policy-")); temporaryRoots.push(directory);
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
    control.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      queueMicrotask(() => {
        if (control.helperExitCode === 0) child.stdout.emit("data", JSON.stringify({ fileCount: candidate.files.length, totalBytes: candidate.totalBytes }));
        else child.stderr.emit("data", "Runtime tree does not reproduce the pinned manifest");
        child.emit("close", control.helperExitCode);
      });
      return child;
    });
    await writeFile(manifest, JSON.stringify(candidate));
    return { root, manifest, candidate, save: () => writeFile(manifest, JSON.stringify(candidate)) };
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

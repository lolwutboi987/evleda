import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { assertDoc5Relocation, pyvenvText, readDoc5Source, resolveRuntimeCheckPaths, sha256 } from "../../scripts/verify-kicad-inspection-runtime.mjs";
import type { Doc5Manifest } from "../../scripts/verify-kicad-inspection-runtime.mjs";

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

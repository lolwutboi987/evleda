import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import { captureFreshProjectOpenPreparedSourceAuthority, preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createPcbPlaneCompilationBundle, createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { captureKicadNativeSourceHashes } from "../../src/integrations/kicad-cli.js";
import { saveInitialFreshProjectSettings } from "../../src/mcp/toolbox-fresh-initial-save.js";
import capturedNative06 from "../fixtures/fresh-project/native06-initial-save-history.json" with { type: "json" };
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";

// Literal pins come from the retained native06 files, independently of the seed producer.
const pins = {
  savedPcb: { algorithm: "sha256", digest: "5f482a9458a6c5710ec5df740495991198d31009be38bce9c823abf0e83b4a85", size: 1814 },
  historyPcb: { algorithm: "sha256", digest: "8be439fee8716117c4da47e1e947c749ff4889df564d25a51f2640dec48f4a09", size: 1733 },
  savedProjectSettings: { algorithm: "sha256", digest: "88a574d490e8634f269ea05cd8dee5517bc1ded63f217e9fbe426a3f9e697354", size: 11310 },
  inputDraft: { algorithm: "sha256", digest: "c62dd3623861079a8679ae597454c2634bede001652bf442979a1ba64d9931b3", size: 8185 },
} as const;
const bytes = (key: keyof typeof pins): Buffer => Buffer.from(capturedNative06.artifacts[key].base64, "base64");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) throw new Error("Unsafe native06 replay cleanup target.");
    await rm(resolved, { recursive: true, force: true });
  }
});

describe("captured native06 initial-save history replay", () => {
  it("preserves the independently captured bytes, line endings, and source provenance", () => {
    expect(capturedNative06.schemaVersion).toBe("evleda.captured-native06-initial-save-history.v1");
    expect(capturedNative06.provenance.sourceRun).toBe("destination-startup-doc6-06");
    expect(capturedNative06.provenance.nativeRunPassed).toBe(false);
    for (const key of Object.keys(pins) as (keyof typeof pins)[]) {
      const artifact = capturedNative06.artifacts[key];
      expect(contentIdentity(bytes(key))).toEqual(pins[key]);
      expect({ algorithm: artifact.algorithm, digest: artifact.digest, size: artifact.size }).toEqual(pins[key]);
      expect(Buffer.from(bytes(key).toString("utf8"), "utf8")).toEqual(bytes(key));
      expect(artifact.sourcePath).toBe(key === "inputDraft" ? "input/plane-divider.json"
        : `output/project/${key === "historyPcb" ? ".history/" : ""}plane-divider.${key === "savedProjectSettings" ? "kicad_pro" : "kicad_pcb"}`);
      const source = bytes(key).toString("utf8");
      if (artifact.lineEndings === "CRLF") expect(source).not.toMatch(/(?<!\r)\n/);
      else expect(source).not.toContain("\r");
    }
    expect(bytes("savedPcb").equals(bytes("historyPcb"))).toBe(false);
    expect(bytes("savedPcb").toString("utf8").replaceAll("\r\n", "\n")).toBe(bytes("historyPcb").toString("utf8"));
  });

  // This replay requires the genuine Windows preparation bytes. Other platforms
  // emit LF; forcing the producer to return fixture bytes would hide a regression.
  it.skipIf(process.platform !== "win32")("accepts the exact native06 save with only one new history leaf beyond the primary project settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-native06-replay-")); roots.push(root);
    const dependencies = createGenericDividerBundleFixture().dependencies;
    const compilation = compilePcbPlaneDesignIntentDraft(JSON.parse(bytes("inputDraft").toString("utf8")), dependencies);
    if (compilation.disposition !== "ready") throw new Error(`Captured native06 draft failed preparation: ${JSON.stringify(compilation.issues)}`);
    const compilationBundle = createPcbPlaneCompilationBundle({ originalPrompt: capturedNative06.provenance.originalPrompt, compilation }, dependencies);
    const project = await preparePlaneFreshProject({ outputDir: root, name: capturedNative06.projectName, resume: false,
      compilationBundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(compilationBundle) });
    // Both the capability and accepted source authority come from real preparation.
    const expectedPreparedSourceAuthority = await captureFreshProjectOpenPreparedSourceAuthority(project);
    const before = await captureKicadNativeSourceHashes(project.projectPath);
    const primaryPro = `${project.name}.kicad_pro`, historyLeaf = `.history/${project.name}.kicad_pcb`;
    const proPath = path.join(project.projectPath, primaryPro), historyPath = path.join(project.projectPath, historyLeaf);
    const withoutPro = (inventory: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(inventory).filter(([name]) => name !== primaryPro));
    expect(await readFile(project.pcbPath)).toEqual(bytes("savedPcb"));
    expect(expectedPreparedSourceAuthority.pcb).toEqual(pins.savedPcb);
    expect(before[historyLeaf]).toBeUndefined();
    expect(before[primaryPro]).toBe(expectedPreparedSourceAuthority.pro.digest);
    // Native history serializes the BOARD during Save. It supplies both live
    // observations only for this checked no-PCB-change replay, not as a preimage guarantee.
    const liveBefore = bytes("historyPcb").toString("utf8");
    const session = {
      assertActivePcb: vi.fn(async (expected: string) => { expect(expected).toBe(project.pcbPath); }),
      readActivePcbSource: vi.fn(async (expected: string) => { expect(expected).toBe(project.pcbPath); return liveBefore; }),
      callTool: vi.fn(async (name: string, args?: Readonly<Record<string, unknown>>): Promise<CallToolResult> => {
        expect(name).toBe("pcb_save"); expect(args).toEqual({});
        expect(await captureKicadNativeSourceHashes(project.projectPath)).toEqual(before);
        // Replay captured source effects only; no process, adapter, or native tool runs.
        // The family's subsequent Open normalizer owns .pro semantic validation.
        await writeFile(proPath, bytes("savedProjectSettings"));
        await writeFile(project.pcbPath, bytes("savedPcb"));
        await mkdir(path.dirname(historyPath));
        await writeFile(historyPath, bytes("historyPcb"));
        return { content: [], structuredContent: { result: "Board saved." } };
      }),
    };

    await expect(saveInitialFreshProjectSettings({ project, expectedPreparedSourceAuthority, session })).resolves.toBeUndefined();

    expect(session.callTool).toHaveBeenCalledExactlyOnceWith("pcb_save", {});
    const savedAt = session.callTool.mock.invocationCallOrder[0]!;
    for (const observations of [session.assertActivePcb.mock.invocationCallOrder, session.readActivePcbSource.mock.invocationCallOrder]) {
      expect(observations.some(observedAt => observedAt < savedAt)).toBe(true);
      expect(observations.some(observedAt => observedAt > savedAt)).toBe(true);
    }
    const after = await captureKicadNativeSourceHashes(project.projectPath);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]).sort();
    expect(changed).toEqual([historyLeaf, primaryPro].sort());
    expect(after[primaryPro]).toBe(pins.savedProjectSettings.digest);
    expect(after[historyLeaf]).toBe(pins.historyPcb.digest);
    // The previous strict comparison rejected this sole non-.pro addition.
    // The ordinary inventory must still include it; there is no global history ignore.
    expect(withoutPro(after)).not.toEqual(withoutPro(before));
    expect(withoutPro(after)).toEqual({ ...withoutPro(before), [historyLeaf]: pins.historyPcb.digest });
    expect(await readFile(historyPath)).toEqual(Buffer.from(liveBefore, "utf8"));
    expect(await readFile(project.pcbPath)).toEqual(bytes("savedPcb"));
    expect(await readFile(proPath)).toEqual(bytes("savedProjectSettings"));
    const currentAuthority = await captureFreshProjectOpenPreparedSourceAuthority(project);
    expect(currentAuthority.pcb).toEqual(expectedPreparedSourceAuthority.pcb);
    expect(currentAuthority.marker).toEqual(expectedPreparedSourceAuthority.marker);
    expect(currentAuthority.pro).toEqual(pins.savedProjectSettings);
  });
});

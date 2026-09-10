import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compilePcbDesignIntentDraft } from "../../src/harness/pcb-design-compiler.js";
import { createPcbDesignCompilationBundle, createPcbDesignCompilationBundleRef } from "../../src/harness/pcb-design-compilation-bundle.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES, type KicadHarnessSession } from "../../src/harness/kicad-tools.js";
import { genericDividerDraft, genericDividerLibraryResolver } from "../helpers/generic-divider-bundle.js";
import { sourceAwareLibraryFixture } from "../helpers/pcb-library-source-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-harness-library-sources-")); roots.push(root);
  const sources = sourceAwareLibraryFixture(genericDividerLibraryResolver);
  const dependencies = { libraryResolver: sources.resolver, deepRuleCatalog: loadDeepRuleCatalog() };
  const compilation = compilePcbDesignIntentDraft(genericDividerDraft(), dependencies);
  const bundle = createPcbDesignCompilationBundle({ originalPrompt: "Source-bound divider fixture", compilation }, dependencies);
  const project = await prepareFreshProject({ outputDir: root, name: "board", resume: false, workflowKind: "generic",
    compilationBundle: bundle, compilationBundleRef: createPcbDesignCompilationBundleRef(bundle) });
  const callTool = vi.fn<KicadHarnessSession["callTool"]>().mockResolvedValue({ content: [], structuredContent: { symbols: [] } });
  const session: KicadHarnessSession = {
    callTool, supportsQualifiedFootprintIdentitySync: () => true,
    assertActivePcb: async () => undefined, readActivePcbSource: file => readFile(file, "utf8"),
    listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, description: name,
      permission: "write", inputSchema: { type: "object", additionalProperties: true } })),
  };
  const options = { freshProject: project, freshConnectivityContract: bundle.contract,
    freshCompilationBundle: bundle, freshLibraryResolver: sources.resolver };
  return { sources, bundle, project, session, callTool, options };
}

describe("persisted library authority at native harness boundaries", () => {
  it("refuses a source-pinned bundle when its resolver capability is omitted", async () => {
    const f = await fixture(); const { freshLibraryResolver: _resolver, ...options } = f.options;
    expect(() => createKicadHarnessTools(f.session, options)).toThrow(/source pins require/);
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it.each(["symbol", "footprint"] as const)("rejects existing %s drift before harness creation", async kind => {
    const f = await fixture(); f.sources.changeSource(kind);
    expect(() => createKicadHarnessTools(f.session, f.options)).toThrow(/library sources|catalog policy/);
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it.each(["symbol", "footprint"] as const)("blocks reads and writes after %s drift without calling native tools", async kind => {
    const f = await fixture(); const tools = createKicadHarnessTools(f.session, f.options);
    f.sources.changeSource(kind);
    await expect(tools.execute({ id: "read", name: "sch_get_symbols", arguments: {} })).rejects.toThrow(/library sources|catalog policy/);
    await expect(tools.execute({ id: "write", name: "sch_modify_property", arguments: { reference: "R1", property: "Value", value: "20k" } })).rejects.toThrow(/library sources|catalog policy/);
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("refuses a successful native read when symbol sources changed during its await", async () => {
    const f = await fixture(); const tools = createKicadHarnessTools(f.session, f.options);
    f.callTool.mockImplementation(async () => { f.sources.changeSource("symbol"); return { content: [], structuredContent: { symbols: [] } }; });
    await expect(tools.execute({ id: "read", name: "sch_get_symbols", arguments: {} })).rejects.toThrow(/library sources|catalog policy/);
    expect(f.callTool).toHaveBeenCalledOnce();
  });

  it.each(["read", "save"] as const)("retains a native %s error when symbol sources drift during the same call", async operation => {
    const f = await fixture(); const tools = createKicadHarnessTools(f.session, f.options);
    f.callTool.mockImplementation(async () => {
      f.sources.changeSource("symbol");
      return { isError: true, content: [{ type: "text", text: "Native first-cause fixture failure" }] };
    });
    const result = operation === "read"
      ? await tools.execute({ id: "read", name: "sch_get_symbols", arguments: {} })
      : await tools.internal.saveAfterMutation({ id: "save", name: "pcb_save", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Native first-cause fixture failure");
    expect(result.content).not.toMatch(/library sources|catalog policy/);
    expect(f.callTool).toHaveBeenCalledOnce();
    await expect(tools.execute({ id: "later", name: "sch_get_symbols", arguments: {} })).rejects.toThrow(/library sources|catalog policy/);
    expect(f.callTool).toHaveBeenCalledOnce();
  });
});

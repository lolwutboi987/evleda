import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKicadHarnessTools, KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES,
  type KicadHarnessSession, type KicadHarnessToolsOptions } from "../../src/harness/kicad-tools.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { createPcbPlaneCompilationBundleRef } from "../../src/harness/pcb-design-plane-bundle.js";
import { cleanupDerivedPowerFixtures, derivedPowerDraft, derivedPowerFixture } from "../helpers/derived-power-bundle.js";

afterEach(cleanupDerivedPowerFixtures);
type Mode = "derived" | "mixed" | "external" | "plain";
async function fixture(mode: Mode = "derived") {
  const draft = derivedPowerDraft();
  if (mode === "derived" || mode === "plain") delete draft.externalPowerInputs;
  if (mode === "external" || mode === "plain") delete draft.derivedPowerSources;
  const f = derivedPowerFixture(draft), bundle = f.bundle;
  const project = await preparePlaneFreshProject({ outputDir: path.join(f.root, "output"), name: "guard", resume: false,
    compilationBundle: bundle, compilationBundleRef: createPcbPlaneCompilationBundleRef(bundle) });
  let captures = 0, flags = 0, onGeometry: (() => void) | undefined;
  let onRead: (() => Promise<void>) | undefined; const calls: string[] = [];
  const resolver = {
    resolveSymbol: f.resolver.resolveSymbol.bind(f.resolver), resolveFootprint: f.resolver.resolveFootprint.bind(f.resolver),
    inspectSymbol: f.resolver.inspectSymbol.bind(f.resolver), inspectFootprint: f.resolver.inspectFootprint.bind(f.resolver),
    inspectSymbolTerminalGeometry(libraryId: string) { const result = f.resolver.inspectSymbolTerminalGeometry(libraryId); onGeometry?.(); return result; },
    inspectExternalPowerFlag() { flags++; return f.resolver.inspectExternalPowerFlag(); },
    captureSourceSelection(request: Parameters<typeof f.resolver.captureSourceSelection>[0]) { captures++; return f.resolver.captureSourceSelection(request); },
  };
  const session: KicadHarnessSession = {
    supportsExternalPowerFlagConnectivity: () => true,
    supportsQualifiedFootprintIdentitySync: () => true,
    listTools: () => KICAD_GENERIC_FRESH_SIDECAR_REQUIRED_TOOL_NAMES.map(name => ({ name, permission: "write" as const,
      description: name, inputSchema: { type: "object", additionalProperties: true } })),
    assertActivePcb: async expected => { expect(expected).toBe(project.pcbPath); },
    readActivePcbSource: async () => readFile(project.pcbPath, "utf8"),
    readLivePcbPadSnapshot: async () => { throw new Error("Unexpected physical native read"); },
    callTool: async name => { calls.push(name); await onRead?.(); return { content: [], structuredContent: { result: "Symbols (0 total):" } }; },
  };
  const options: KicadHarnessToolsOptions = { freshProject: project, freshPlaneCompilationBundle: bundle, freshConnectivityContract: bundle.contract,
    freshLibraryResolver: resolver, freshPhysicalFootprintResolver: f.resolver,
    freshPhysicalFootprintSourcePins: bundle.contract.components.map(component => ({ reference: component.reference, libraryId: component.footprintLibId,
      sourceIdentity: f.resolver.inspectFootprint(component.footprintLibId)!.sourceIdentity })),
    captureFreshNativeNetlist: async () => { throw new Error("Unexpected native netlist export"); },
  };
  const tools = createKicadHarnessTools(session, options);
  const read = () => tools.execute({ id: "read", name: "sch_get_symbols", arguments: {} });
  const unrelated = { symbol: f.symbolFiles.Connector_Generic!, footprint: path.join(f.footprintRoot, "Connector_PinHeader_2.54mm.pretty", "PinHeader_1x04_P2.54mm_Vertical.kicad_mod") };
  return { ...f, project, tools, session, options, calls, unrelated, read,
    counts: () => ({ captures, flags }), reset: () => { captures = 0; flags = 0; calls.length = 0; },
    onGeometry: (hook: typeof onGeometry) => { onGeometry = hook; }, onRead: (hook: typeof onRead) => { onRead = hook; } };
}
const drift = (file: string) => writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("\n")]));

describe("derived library guard capture reuse without cached authority", () => {
  it.each([['derived', 2, 1], ['mixed', 2, 2], ['external', 1, 1], ['plain', 1, 0]] as const)("keeps the exact constructor guard for %s", async (mode, captures, flags) => {
    const f = await fixture(mode);
    expect(f.counts()).toEqual({ captures, flags });
  });

  it.each([['derived', 14], ['mixed', 14], ['external', 7], ['plain', 6]] as const)("retains every independent read boundary for %s", async (mode, capturesPerRead) => {
    const f = await fixture(mode); f.reset();
    expect((await f.read()).isError).not.toBe(true);
    expect(f.counts().captures).toBe(capturesPerRead);
    expect((await f.read()).isError).not.toBe(true);
    expect(f.counts().captures).toBe(capturesPerRead * 2);
    expect(f.calls).toEqual(["sch_get_symbols", "sch_get_symbols"]);
  });

  it.each(["symbol", "footprint"] as const)("rejects unrelated selected %s drift before native dispatch", async kind => {
    const f = await fixture();
    expect(f.bundle.derivedPowerBinding!.symbols.some(symbol => symbol.reference === "J1")).toBe(false);
    drift(f.unrelated[kind]); f.reset();
    await expect(f.read()).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(f.counts().captures).toBe(1);
  });

  it.each(["symbol", "footprint"] as const)("the derived final fence catches unrelated %s drift during driver inspection", async kind => {
    const f = await fixture(); f.reset(); let changed = false;
    f.onGeometry(() => { if (!changed) { changed = true; drift(f.unrelated[kind]); } });
    await expect(f.tools.assertExternalPowerAnnotationsCurrent!()).rejects.toThrow();
    expect(changed).toBe(true); expect(f.counts().captures).toBe(2); expect(f.calls).toEqual([]);
  });

  it.each(["symbol", "footprint"] as const)("the outer post-read guard catches %s drift across awaited native IO", async kind => {
    const f = await fixture(); f.reset();
    let enter!: () => void, complete!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), wait = new Promise<void>(resolve => { complete = resolve; });
    f.onRead(async () => { enter(); await wait; });
    const result = f.read(); await entered;
    expect(f.counts().captures).toBe(6); // two compound guards plus the immediate native pre-guard
    drift(f.unrelated[kind]); complete();
    await expect(result).rejects.toThrow();
    expect(f.calls).toEqual(["sch_get_symbols"]); expect(f.counts().captures).toBe(7);
  });

  it.each(["external", "plain"] as const)("retains direct selected-source drift rejection without derived validation: %s", async mode => {
    const f = await fixture(mode); f.reset(); drift(f.unrelated.footprint);
    await expect(f.read()).rejects.toThrow(); expect(f.calls).toEqual([]); expect(f.counts().captures).toBe(1);
  });

  it.each(["derived", "mixed", "external", "plain"] as const)("still requires the bound resolver for %s", async mode => {
    const f = await fixture(mode), { freshLibraryResolver: _resolver, ...missing } = f.options;
    expect(() => createKicadHarnessTools(f.session, missing)).toThrow(/resolver/i);
  });

  it.each(["derived", "mixed", "external"] as const)("retains fresh flag-source inspection for %s", async mode => {
    const f = await fixture(mode); f.reset(); drift(f.symbolFiles.power!);
    await expect(f.read()).rejects.toThrow(); expect(f.calls).toEqual([]); expect(f.counts().flags).toBe(1);
  });
});

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { createPlaneToolboxCheckpointLifecycle } from "../../src/mcp/toolbox-plane-checkpoint.js";
import { prepareKicadToolboxPlaneProject, resumeKicadToolboxPlaneProject } from "../../src/mcp/toolbox-plane-preparation.js";
import { preparePlaneFreshProject } from "../../src/harness/fresh-project.js";
import { planeDividerDraft } from "../helpers/plane-divider-draft.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import type { KicadCliAdapter, KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import type { KicadMcpSession } from "../../src/integrations/kicad-mcp-session.js";
import type { PcbReadOnlyLibraryResolver } from "../../src/harness/pcb-design-compiler.js";
import { parseFreshPcbSource } from "../../src/harness/fresh-kicad-parser.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const nativeNoConnectName = "unconnected-(J1-Pin_4-Pad4)";
const uuid = (index: number) => `bbbbbbbb-1111-4111-8111-${String(index).padStart(12, "0")}`;
async function fixture(noConnect = false) {
  const root = await mkdtemp(path.join(tmpdir(), "toolbox-checkpoint-")); roots.push(root);
  const identity: KicadExecutableIdentity = { kind: "kicad-cli", path: path.join(root, "kicad-cli.exe"), version: "10.0.3",
    commit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622", sha256: "a".repeat(64), sizeBytes: 100,
    capabilityHelpSha256: "b".repeat(64), confirmedCapabilities: ["pcb drc"] };
  const expectedKicadCli = { path: identity.path, contentIdentity: { algorithm: "sha256" as const, digest: identity.sha256, size: identity.sizeBytes },
    operationalVersion: identity.version, operationalCommit: identity.commit, peFileVersion: "10.0.3", peProductVersion: "10.0.3",
    identity: canonicalIdentity({ fixture: true }, "evleda.flux-kicad-cli-binding.v1") };
  let nativeNetlistSource: string | undefined;
  // Only the native export result is offline; preparation, source guards,
  // checkpoint publication and resumed preparation use their real host code.
  const exportSchematicNetlist = vi.fn<KicadCliAdapter["exportSchematicNetlist"]>().mockImplementation(async () => {
    if (nativeNetlistSource === undefined) throw new Error("Offline NC netlist fixture is not installed.");
    return { source: nativeNetlistSource } as Awaited<ReturnType<KicadCliAdapter["exportSchematicNetlist"]>>;
  });
  const createKicadCliAdapter = vi.fn<typeof KicadCliAdapter.create>().mockResolvedValue({ identity, exportSchematicNetlist } as unknown as KicadCliAdapter);
  const originalDependencies = createGenericDividerBundleFixture().dependencies, draft = planeDividerDraft();
  let libraryResolver = originalDependencies.libraryResolver;
  if (noConnect) {
    const connector = draft.components.find(component => component.reference === "J1")!;
    connector.symbolLibId = "Connector_Generic:Conn_01x04";
    connector.footprintLibId = "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical";
    connector.pins.push({ pin: "4", assignment: { kind: "no_connect" } });
    const resolver: PcbReadOnlyLibraryResolver = {
      resolveSymbol(libraryId) {
        return libraryId === connector.symbolLibId ? { ...originalDependencies.libraryResolver.resolveSymbol("Connector_Generic:Conn_01x03")!, libraryId,
          pins: ["1", "2", "3", "4"].map(number => ({ number, function: `Pin ${number}` })) } : originalDependencies.libraryResolver.resolveSymbol(libraryId);
      },
      resolveFootprint(libraryId) {
        return libraryId === connector.footprintLibId ? { ...originalDependencies.libraryResolver.resolveFootprint("Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical")!, libraryId,
          pads: ["1", "2", "3", "4"] } : originalDependencies.libraryResolver.resolveFootprint(libraryId);
      },
    };
    libraryResolver = resolver;
  }
  const dependencies = { ...originalDependencies, libraryResolver };
  const input = { draft, originalPrompt: "Build divider", outputDir: path.join(root, "output"), name: "divider",
    dependencies, expectedKicadCli, createKicadCliAdapter };
  const prepared = await prepareKicadToolboxPlaneProject(input);
  if (prepared.status !== "prepared") throw new Error("Fixture preparation failed");
  const preparation = prepared.preparation;
  let authoredPcbSource: string | undefined;
  if (noConnect) {
    const contract = preparation.bundle.contract, blank = await readFile(preparation.project.pcbPath, "utf8");
    const footprints = contract.components.map((component, index) => `(footprint ${JSON.stringify(component.footprintLibId)} (uuid "${uuid(index + 1)}") (layer "F.Cu") (at ${4 + index * 8} 8)
      (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)})
      ${component.pins.map((pin, ordinal) => `(pad ${JSON.stringify(pin.pin)} smd rect (uuid "${uuid(100 + index * 10 + ordinal)}") (at ${ordinal * 2} 0) (size 1 1) (layers "F.Cu") (net ${JSON.stringify(pin.assignment.kind === "net" ? pin.assignment.net : nativeNoConnectName)}))`).join(" ")})`).join("\n");
    authoredPcbSource = blank.replace(/\)\s*$/u, `${footprints}\n)\n`);
    const schematic = `(kicad_sch (version 20250316) (generator "fixture") ${contract.nets.map(net => `(global_label ${JSON.stringify(net.name)} (shape passive) (at 10 10 0))`).join(" ")}
      ${contract.components.map(component => `(symbol (lib_id ${JSON.stringify(component.symbolLibId)}) (at 20 20 0) (unit 1) (property "Reference" ${JSON.stringify(component.reference)}) (property "Value" ${JSON.stringify(component.value)}) (property "Footprint" ${JSON.stringify(component.footprintLibId)}))`).join(" ")} (no_connect (at 40 30)))`;
    const node = (reference: string, pin: string, pinType: string) => `(node (ref ${JSON.stringify(reference)}) (pin ${JSON.stringify(pin)}) (pintype ${JSON.stringify(pinType)}))`;
    nativeNetlistSource = `(export (design (source "divider.kicad_sch") (date "2026-09-16T12:00:00")) (components ${contract.components.map(component => {
      const [lib, part] = component.symbolLibId.split(":");
      return `(comp (ref ${JSON.stringify(component.reference)}) (value ${JSON.stringify(component.value)}) (footprint ${JSON.stringify(component.footprintLibId)}) (libsource (lib ${JSON.stringify(lib)}) (part ${JSON.stringify(part)})))`;
    }).join(" ")}) (nets ${contract.nets.map(net => `(net (name ${JSON.stringify(net.name)}) ${net.endpoints.map(endpoint => node(endpoint.reference, endpoint.pin, "passive")).join(" ")})`).join(" ")}
      (net (name ${JSON.stringify(nativeNoConnectName)}) ${node("J1", "4", "passive+no_connect")})))`;
    await writeFile(preparation.project.pcbPath, authoredPcbSource, "utf8");
    await writeFile(preparation.project.schematicPath, schematic, "utf8");
  }
  const readActivePcbSource = vi.fn().mockImplementation(async () => readFile(preparation.project.pcbPath, "utf8"));
  const session = { readActivePcbSource } as unknown as KicadMcpSession;
  const lifecycle = createPlaneToolboxCheckpointLifecycle({ project: preparation.project, preparation, session });
  return { preparation, lifecycle, readActivePcbSource, session, input, authoredPcbSource, exportSchematicNetlist };
}

describe("plane toolbox saved-candidate checkpoint lifecycle", () => {
  it("closes, checkpoints and resumes an authored NC board through freshly captured native parity", async () => {
    const f = await fixture(true), order: string[] = [];
    const previousCheckpoint = await readFile(f.preparation.project.checkpointPath), previous = JSON.parse(previousCheckpoint.toString("utf8"));
    const initialAuthority = f.preparation.netClassSemanticAuthority, originalBundle = await readFile(f.preparation.bundlePath);
    const capturesBeforeClose = f.exportSchematicNetlist.mock.calls.length;
    let closed = false;
    const cad = { tools: { tools: [] }, assertCurrent: async () => {}, captureSources: async () => "saved",
      ...f.lifecycle, prepareCheckpoint: async () => {
        const publish = await f.lifecycle.prepareCheckpoint(); order.push("guard");
        expect(await readFile(f.preparation.project.checkpointPath)).toEqual(previousCheckpoint);
        expect(f.exportSchematicNetlist.mock.calls.length).toBeGreaterThan(capturesBeforeClose);
        return async () => { expect(closed).toBe(true); order.push("publish"); await publish(); };
      }, close: async () => {
        // Simulate the owning-host close acknowledgement only. No process or
        // source mutation is hidden in this callback, and all real guards run.
        expect(await readFile(f.preparation.project.checkpointPath)).toEqual(previousCheckpoint);
        closed = true; order.push("closed");
      } } as unknown as ConnectedKicadToolbox;
    const toolbox = createKicadToolboxMcpServer({ cad });
    await toolbox.close();
    expect(order).toEqual(["guard", "closed", "publish"]);
    const checkpoint = JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8"));
    expect(checkpoint).toMatchObject({ schemaVersion: "evleda.pcb-agent-fresh-project-checkpoint.v3", reportStatus: "needs_review", attempt: previous.attempt + 1 });
    expect(Object.keys(checkpoint.files)).toHaveLength(6);
    expect(await readFile(f.preparation.project.pcbPath, "utf8")).toBe(f.authoredPcbSource);
    expect(await readFile(f.preparation.bundlePath)).toEqual(originalBundle);
    const capturesAfterClose = f.exportSchematicNetlist.mock.calls.length;
    const resumed = await resumeKicadToolboxPlaneProject({ outputDir: f.input.outputDir, name: f.input.name, dependencies: f.input.dependencies,
      expectedKicadCli: f.input.expectedKicadCli, createKicadCliAdapter: f.input.createKicadCliAdapter });
    expect(resumed.mode).toBe("resumed"); expect(resumed.bundleRef).toEqual(f.preparation.bundleRef);
    expect(f.exportSchematicNetlist.mock.calls.length).toBeGreaterThan(capturesAfterClose);
    expect(resumed.netClassSemanticAuthority).toEqual(initialAuthority);
    expect(resumed.netClassSemanticAuthority.contractNetAssignments.map(assignment => assignment.netName).sort()).toEqual(["GND", "VIN", "VOUT"]);
    const saved = await readFile(resumed.project.pcbPath, "utf8");
    expect(saved).toBe(f.authoredPcbSource);
    expect(parseFreshPcbSource(saved).footprints.find(fp => fp.reference === "J1")!.pads.find(pad => pad.number === "4")!.netName).toBe(nativeNoConnectName);
    const report = JSON.parse(await readFile(resumed.reportPath, "utf8"));
    expect(report.status).toBe("needs_review"); expect(report.assurance).toContain("not design acceptance");
    for (const [request] of f.exportSchematicNetlist.mock.calls) {
      expect(request.schematicPath).toBe(f.preparation.project.schematicPath);
      expect(request.pcbPath).toBe(f.preparation.project.pcbPath);
    }
  });
  it("publishes only after confirmed owning-host close while retaining the V2 bundle", async () => {
    const f = await fixture(); const order: string[] = [];
    const previousCheckpoint = await readFile(f.preparation.project.checkpointPath);
    const originalBundle = await readFile(f.preparation.bundlePath);
    const cad = { tools: { tools: [] }, assertCurrent: async () => {}, captureSources: async () => "saved",
      ...f.lifecycle, prepareCheckpoint: async () => {
        const publish = await f.lifecycle.prepareCheckpoint(); order.push("guard");
        return async () => { order.push("publish"); await publish(); };
      }, close: async () => {
        expect(await readFile(f.preparation.project.checkpointPath)).toEqual(previousCheckpoint);
        order.push("closed");
      } } as unknown as ConnectedKicadToolbox;
    const toolbox = createKicadToolboxMcpServer({ cad }); await toolbox.close();
    expect(order).toEqual(["guard", "closed", "publish"]);
    expect(await readFile(f.preparation.bundlePath)).toEqual(originalBundle);
    expect(JSON.parse(await readFile(f.preparation.reportPath, "utf8")).status).toBe("needs_review");
  });
  it("does not publish after uncertain close and poisons plane resume", async () => {
    const f = await fixture(); const previous = await readFile(f.preparation.project.checkpointPath);
    const cad = { tools: { tools: [] }, assertCurrent: async () => {}, captureSources: async () => "saved",
      ...f.lifecycle, close: async () => { throw new Error("owned exit unconfirmed"); } } as unknown as ConnectedKicadToolbox;
    const toolbox = createKicadToolboxMcpServer({ cad });
    await expect(toolbox.close()).rejects.toThrow("owned exit unconfirmed");
    expect(await readFile(f.preparation.project.checkpointPath)).toEqual(previous);
    expect(JSON.parse(await readFile(f.preparation.project.unsafeTerminalPath, "utf8")).reason).toContain("not confirmed");
  });
  it("rejects copied plane preparation shapes before creating a checkpoint lifecycle", async () => {
    const f = await fixture();
    expect(() => createPlaneToolboxCheckpointLifecycle({ project: f.preparation.project,
      preparation: { ...f.preparation }, session: f.session })).toThrow("authenticated V2");
  });
  it("publishes a guarded needs-review checkpoint once and permits exact source resume", async () => {
    const f = await fixture();
    const before = JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8"));
    const originalBundle = await readFile(f.preparation.bundlePath);
    const publish = await f.lifecycle.prepareCheckpoint();
    expect(JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8")).attempt).toBe(before.attempt);
    await publish();
    const report = JSON.parse(await readFile(f.preparation.reportPath, "utf8"));
    expect(report.status).toBe("needs_review"); expect(report.assurance).toContain("not design acceptance");
    const after = JSON.parse(await readFile(f.preparation.project.checkpointPath, "utf8"));
    expect(after.attempt).toBe(before.attempt + 1);
    expect(after.schemaVersion).toBe("evleda.pcb-agent-fresh-project-checkpoint.v3");
    expect(Object.keys(after.files)).toHaveLength(6);
    expect(await readFile(f.preparation.bundlePath)).toEqual(originalBundle);
    expect(report.workflow).toMatchObject({ kind: "plane", bundleRef: f.preparation.bundleRef });
    await expect(publish()).rejects.toThrow("already consumed");
    await expect(preparePlaneFreshProject({ outputDir: f.input.outputDir, name: f.input.name, resume: true,
      compilationBundle: f.preparation.bundle, compilationBundleRef: f.preparation.bundleRef })).resolves.toMatchObject({ pcbPath: f.preparation.project.pcbPath });
  });

  it("refuses divergent live PCB before exposing publication", async () => {
    const f = await fixture(); f.readActivePcbSource.mockResolvedValue("(kicad_pcb (version 20260206) (different yes))");
    await expect(f.lifecycle.prepareCheckpoint()).rejects.toThrow("Live PCB differs");
  });

  it.each(["board", "report", "bundle", "rules"])("refuses %s drift during teardown and preserves previous checkpoint", async kind => {
    const f = await fixture(); const publish = await f.lifecycle.prepareCheckpoint();
    const prior = await readFile(f.preparation.project.checkpointPath);
    const target = kind === "board" ? f.preparation.project.pcbPath : kind === "report" ? f.preparation.reportPath : kind === "rules" ? f.preparation.project.rulesPath : f.preparation.bundlePath;
    await writeFile(target, `${await readFile(target, "utf8")}\n`);
    await expect(publish()).rejects.toThrow();
    expect(await readFile(f.preparation.project.checkpointPath)).toEqual(prior);
  });

  it("rejects altered report semantics before preparing a checkpoint", async () => {
    const f = await fixture(); const report = JSON.parse(await readFile(f.preparation.reportPath, "utf8"));
    report.status = "completed"; await writeFile(f.preparation.reportPath, JSON.stringify(report));
    await expect(f.lifecycle.prepareCheckpoint()).rejects.toThrow("Preparation report changed");
  });

  it("records uncertainty as an unsafe terminal that prevents resume", async () => {
    const f = await fixture(); await f.lifecycle.recordRecoveryRequired("native teardown uncertain");
    expect(JSON.parse(await readFile(f.preparation.project.unsafeTerminalPath, "utf8")).reason).toBe("native teardown uncertain");
    await expect(preparePlaneFreshProject({ outputDir: f.input.outputDir, name: f.input.name, resume: true,
      compilationBundle: f.preparation.bundle, compilationBundleRef: f.preparation.bundleRef })).rejects.toThrow("unsafe");
  });
});

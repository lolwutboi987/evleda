import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentIdentity } from "../../src/core/canonical.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "../../src/integrations/bounded-process.js";
import {
  createKicadTransmissionLineCalculator,
  KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION,
  KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION,
  KICAD_TRANSMISSION_LINE_SOURCE_COMMIT,
} from "../../src/integrations/kicad-transmission-line.js";
import { createToolboxSavedMicrostrip } from "../../src/mcp/toolbox-saved-microstrip.js";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { ConnectedKicadToolbox } from "../../src/mcp/toolbox-session.js";

const TOOL = "evleda_check_microstrip_route";
const PRIVATE_SOURCE_MARKER = "SOURCE_ONLY_µ_MICROSTRIP";
const ownedDirectories: string[] = [];
afterEach(async () => {
  for (const directory of ownedDirectories.splice(0)) {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) throw new Error("Unsafe fixture cleanup");
    await rm(resolved, { recursive: true, force: true });
  }
});

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const referenceZoneUuid = id(101);
const source = `(kicad_pcb (version 20260206)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user)
    (3 "B.Mask" user) (13 "F.Paste" user) (15 "B.Paste" user))
  (property "PrivateNote" "${PRIVATE_SOURCE_MARKER}")
  (setup (stackup
    (layer "F.Mask" (type "Top Solder Mask") (thickness 0))
    (layer "F.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 1" (type "core") (thickness 0.2)
      (material "FR4") (epsilon_r 4.2) (loss_tangent 0.02))
    (layer "B.Cu" (type "copper") (thickness 0.035))))
  (footprint "Fixture:Terminal" (layer "F.Cu") (at 0 0) (uuid "${id(11)}")
    (property "Reference" "J1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")
      (net "SIG") (uuid "${id(12)}")))
  (footprint "Fixture:Terminal" (layer "F.Cu") (at 10 0) (uuid "${id(21)}")
    (property "Reference" "J2")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")
      (net "SIG") (uuid "${id(22)}")))
  (segment (start 0 0) (end 4 0) (width 0.3) (layer "F.Cu") (net "SIG") (uuid "${id(1)}"))
  (segment (start 4 0) (end 10 0) (width 0.3) (layer "F.Cu") (net "SIG") (uuid "${id(2)}"))
  (zone (net "GND") (layer "B.Cu") (uuid "${referenceZoneUuid}")
    (connect_pads yes (clearance 0.3)) (min_thickness 0.25)
    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy -2 -2) (xy 12 -2) (xy 12 2) (xy -2 2)))))`;

function requestFor(bytes: string | Uint8Array) {
  return {
    expectedSourceIdentity: { ...contentIdentity(bytes) }, net: "SIG", signalLayer: "F.Cu" as const,
    reference: { net: "GND", layer: "B.Cu", zoneUuid: referenceZoneUuid },
    terminals: [{ reference: "J1", pad: "1" }, { reference: "J2", pad: "1" }],
    targetOhm: 56.5, absoluteToleranceOhm: 0.25, frequencyHz: 1e9,
    construction: {
      topCover: "absent" as const, surface: "bare" as const,
      dielectric: { material: "FR4", epsilonR: 4.2, lossTangent: 0.02, frequencyHz: 1e9,
        evidence: "Caller supplied test material declaration at the analysis frequency" },
      conductor: { conductivitySiemensPerMetre: 5.8e7, relativePermeability: 1, roughnessNm: 0,
        evidence: "Caller supplied test copper declaration" },
      substrateRelativePermeability: 1,
      evidence: "Fixture construction declaration; no manufacturing qualification",
    },
  };
}

function parameterUnit(name: string) {
  if (["H", "T", "PHYS_WIDTH", "PHYS_LEN", "H_T", "ROUGH"].includes(name)) return "m";
  return name === "FREQUENCY" ? "Hz" : name === "SIGMA" ? "S/m" : "1";
}

/** Real factory provenance and file pinning; this runner never launches a process. */
async function calculatorFixture(directory: string, onDispatch?: () => void | Promise<void>) {
  const executablePath = path.join(directory, "fixture-helper.exe");
  const bytes = Buffer.from("Pinned MCP fixture only; this is not executable code");
  await writeFile(executablePath, bytes);
  const runner = vi.fn(async (options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    await onDispatch?.();
    const inputs = Object.fromEntries(options.args.filter(arg => arg.includes("=")).map(arg => {
      const [name, value] = arg.split("=");
      return [name!, value === "absent" ? { value: "absent", unit: "1" }
        : { value: Number(value), unit: parameterUnit(name!) }];
    }));
    return { command: options.command, args: options.args, cwd: options.cwd, exitCode: 0,
      stdout: JSON.stringify({ schemaVersion: KICAD_TRANSMISSION_LINE_PROTOCOL_VERSION,
        implementationRevision: KICAD_TRANSMISSION_LINE_IMPLEMENTATION_REVISION,
        sourceCommit: KICAD_TRANSMISSION_LINE_SOURCE_COMMIT, model: "microstrip", operation: "analyze",
        converged: true, valid: true, inputs, results: {
          PHYS_WIDTH: { ...inputs.PHYS_WIDTH, status: "ok" },
          PHYS_LEN: { ...inputs.PHYS_LEN, status: "ok" },
          Z0: { value: 56.5, unit: "ohm", status: "ok" },
        } }), stderr: "", durationMs: 1, startedAt: "2026-09-10T00:00:00Z" };
  });
  const calculator = await createKicadTransmissionLineCalculator({ executablePath, cwd: directory,
    environment: {}, expectedExecutableIdentity: { sha256: contentIdentity(bytes).digest, sizeBytes: bytes.length }, runner });
  return { calculator, executablePath, runner };
}

interface FixtureOptions {
  readonly bytes?: Uint8Array;
  readonly cad?: "bound" | "absent" | "without-port";
  readonly helper?: boolean;
  readonly onDispatch?: (pcbPath: string) => void | Promise<void>;
}
async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "evleda-microstrip-mcp-"));
  ownedDirectories.push(directory);
  const pcbPath = path.join(directory, "bound-board.kicad_pcb");
  const bytes = Buffer.from(options.bytes ?? Buffer.from(source));
  await writeFile(pcbPath, bytes);
  const helper = options.helper ? await calculatorFixture(directory, () => options.onDispatch?.(pcbPath)) : undefined;
  const assess = await createToolboxSavedMicrostrip({ pcbPath });
  const checkMicrostripRoute = vi.fn(assess);
  const assertCurrent = vi.fn(async () => {});
  const captureSources = vi.fn(async () => "stable-project");
  const nativeClose = vi.fn(async () => {});
  const cad = { tools: { tools: [], execute: vi.fn(), internal: {} }, assertCurrent, captureSources, close: nativeClose,
    ...(options.cad === "without-port" ? {} : { checkMicrostripRoute }) } as unknown as ConnectedKicadToolbox;
  const toolbox = createKicadToolboxMcpServer({ access: "read-only",
    ...(options.cad === "absent" ? {} : { cad }), ...(helper === undefined ? {} : { transmissionLine: helper.calculator }) });
  const client = new Client({ name: "saved-microstrip-mcp-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(right); await client.connect(left);
  return { client, toolbox, directory, pcbPath, bytes, helper, assess, checkMicrostripRoute, assertCurrent,
    captureSources, nativeClose, request: requestFor(bytes),
    close: async () => { await client.close(); await toolbox.close(); } };
}

function expectPrivate(value: unknown, f: Awaited<ReturnType<typeof fixture>>) {
  const serialized = JSON.stringify(value);
  for (const hidden of [f.directory, f.pcbPath, f.helper?.executablePath, PRIVATE_SOURCE_MARKER,
    "(kicad_pcb", "--model", "H=0.0002", "PRIVATE_HOST_FAILURE"]) {
    if (hidden !== undefined) {
      expect(serialized).not.toContain(hidden);
      expect(serialized).not.toContain(JSON.stringify(hidden).slice(1, -1));
    }
  }
  expect(serialized).not.toMatch(/"(?:executablePath|pcbPath|cwd|command|args|stdout|stderr|savedPcbBytes)"/u);
}

function expectSuppressed(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).toBe(true);
  const assessmentFields = ["sourceIdentity", "requestIdentity", "request", "routeCompleteness", "construction",
    "constructionProvenance", "modelApplicability", "modelWarnings", "numericalTarget", "referenceRequirements",
    "boardAccepted", "interfaceAccepted", "sourceBefore", "sourceAfter", "sourceUnchanged"];
  const payloads: unknown[] = [result.structuredContent];
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue;
    try { payloads.push(JSON.parse(block.text)); }
    catch { expect(block.text).not.toMatch(/"(?:routeCompleteness|numericalTarget|boardAccepted|interfaceAccepted)"\s*:/u); }
  }
  for (const payload of payloads) {
    if (payload === undefined) continue;
    for (const field of assessmentFields) expect(payload).not.toHaveProperty(field);
  }
}

describe("public saved-board single-microstrip assessment", () => {
  it("works read-only without a helper and binds exact UTF-8 CRLF bytes", async () => {
    const bytes = Buffer.from(`${source.replaceAll("\n", "\r\n")}\r\n`);
    const f = await fixture({ bytes });
    try {
      const descriptor = (await f.client.listTools()).tools.find(tool => tool.name === TOOL);
      expect(descriptor?.inputSchema.type).toBe("object");
      expect(descriptor?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expect(output.isError).not.toBe(true);
      expect(output.structuredContent).toMatchObject({ sourceIdentity: contentIdentity(bytes), request: f.request,
        sourceBefore: "stable-project", sourceAfter: "stable-project", sourceUnchanged: true,
        routeCompleteness: { status: "complete_source_chain", widthNm: 300000, totalLengthNm: 10000000 },
        construction: { status: "supported_source_declaration", dielectricThicknessNm: 200000 },
        numericalTarget: { status: "unassessed" }, referenceRequirements: { status: "unassessed" },
        boardAccepted: false, interfaceAccepted: false });
      expect(f.checkMicrostripRoute).toHaveBeenCalledWith(f.request, undefined);
      expect(f.assertCurrent).toHaveBeenCalledTimes(2);
      expect(f.captureSources).toHaveBeenCalledTimes(2);
      expect(await readFile(f.pcbPath)).toEqual(bytes);
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("retains exact BOM/CRLF identity while preserving the unsupported route-serialization boundary", async () => {
    const bytes = Buffer.from(`\uFEFF${source.replaceAll("\n", "\r\n")}\r\n`);
    const f = await fixture({ bytes, helper: true });
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expect(output.isError).not.toBe(true);
      expect(output.structuredContent).toMatchObject({ sourceIdentity: contentIdentity(bytes), request: f.request,
        sourceBefore: "stable-project", sourceAfter: "stable-project", sourceUnchanged: true,
        routeCompleteness: { status: "unassessed", widthNm: null, totalLengthNm: null,
          reasons: [{ code: "ROUTE_UNSUPPORTED" }] },
        construction: { status: "supported_source_declaration" },
        numericalTarget: { status: "unassessed", calculatedOhm: null },
        modelApplicability: { status: "unassessed" }, boardAccepted: false, interfaceAccepted: false });
      expect(f.helper!.runner).not.toHaveBeenCalled();
      expect(await readFile(f.pcbPath)).toEqual(bytes);
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("uses only the host-pinned helper while keeping model and reference qualifications separate", async () => {
    const f = await fixture({ helper: true });
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expect(output.isError).not.toBe(true);
      expect(output.structuredContent).toMatchObject({ sourceIdentity: contentIdentity(f.bytes),
        numericalTarget: { status: "within_tolerance", calculatedOhm: 56.5 },
        constructionProvenance: { authority: "caller_asserted_metadata" },
        modelApplicability: { status: "conditional_model_only" },
        referenceRequirements: { status: "unassessed", declarationStatus: "matched_saved_zone" },
        boardAccepted: false, interfaceAccepted: false, sourceUnchanged: true });
      expect(f.checkMicrostripRoute).toHaveBeenCalledWith(f.request, f.helper!.calculator);
      expect(f.helper!.runner).toHaveBeenCalledTimes(1);
      expect(f.helper!.runner.mock.calls[0]![0].args).toEqual(expect.arrayContaining([
        "--model", "microstrip", "--operation", "analyze", "H_T=absent", "H=0.0002",
        "PHYS_WIDTH=0.0003", "PHYS_LEN=0.01",
      ]));
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("rejects an identity for normalized text when the saved bytes contain BOM/CRLF", async () => {
    const f = await fixture({ bytes: Buffer.from(`\uFEFF${source.replaceAll("\n", "\r\n")}`), helper: true });
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: { ...f.request, expectedSourceIdentity: contentIdentity(source) } });
      expectSuppressed(output);
      expect(f.helper!.runner).not.toHaveBeenCalled();
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it.each([
    { name: "PCB path", change: { pcbPath: "other.kicad_pcb" } },
    { name: "runtime profile path", change: { runtimeProfilePath: "other-profile.json" } },
    { name: "runtime configuration", change: { runtime: { executablePath: "other.exe" } } },
    { name: "raw PCB", change: { savedPcbBytes: "(kicad_pcb)" } },
    { name: "raw PCB text", change: { pcbText: "(kicad_pcb)" } },
    { name: "calculator", change: { calculator: { verified: true } } },
    { name: "requirements", change: { referenceRequirements: { status: "passed" } } },
    { name: "reference coverage", change: { referenceCoveragePassed: true } },
    { name: "board acceptance", change: { boardAccepted: true } },
    { name: "interface acceptance", change: { interfaceAccepted: true } },
    { name: "derived geometry", change: { geometry: { widthNm: 300000, totalLengthNm: 10000000 } } },
  ])("rejects caller-injected $name before CAD or helper dispatch", async ({ change }) => {
    const f = await fixture({ helper: true });
    try {
      expect((await f.client.callTool({ name: TOOL, arguments: { ...f.request, ...change } })).isError).toBe(true);
      expect(f.checkMicrostripRoute).not.toHaveBeenCalled();
      expect(f.assertCurrent).not.toHaveBeenCalled();
      expect(f.captureSources).not.toHaveBeenCalled();
      expect(f.helper!.runner).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("rejects nested evidence and requirement setters before dispatch", async () => {
    const f = await fixture();
    try {
      for (const request of [
        { ...f.request, expectedSourceIdentity: { ...f.request.expectedSourceIdentity, approved: true } },
        { ...f.request, reference: { ...f.request.reference, freshFill: true } },
        { ...f.request, terminals: [{ ...f.request.terminals[0], connected: true }, f.request.terminals[1]] },
        { ...f.request, construction: { ...f.request.construction, authority: "qualified_fabricator" } },
        { ...f.request, construction: { ...f.request.construction,
          dielectric: { ...f.request.construction.dielectric, verified: true } } },
      ]) expect((await f.client.callTool({ name: TOOL, arguments: request })).isError).toBe(true);
      expect(f.checkMicrostripRoute).not.toHaveBeenCalled();
      expect(f.assertCurrent).not.toHaveBeenCalled();
      expect(f.captureSources).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["absent", "without-port"] as const)("does not advertise saved assessment when CAD is %s", async cad => {
    const f = await fixture({ cad, helper: true });
    try {
      const tools = (await f.client.listTools()).tools.map(tool => tool.name);
      expect(tools).not.toContain(TOOL);
      expect(tools).toContain("evleda_transmission_line");
      const attempted = await f.client.callTool({ name: TOOL, arguments: f.request }).then(
        result => ({ rejected: result.isError === true }), () => ({ rejected: true }));
      expect(attempted.rejected).toBe(true);
      expect(f.checkMicrostripRoute).not.toHaveBeenCalled();
      expect(f.assertCurrent).not.toHaveBeenCalled();
      expect(f.captureSources).not.toHaveBeenCalled();
      expect(f.helper!.runner).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["before", "after"] as const)("suppresses results if the current-session guard fails %s assessment", async when => {
    const f = await fixture();
    const error = new Error(`PRIVATE_HOST_FAILURE ${f.pcbPath} ${source}`);
    if (when === "after") f.assertCurrent.mockResolvedValueOnce(undefined);
    f.assertCurrent.mockRejectedValueOnce(error);
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expectSuppressed(output);
      expect(f.checkMicrostripRoute).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("suppresses a completed assessment if surrounding project sources drift", async () => {
    const f = await fixture({ helper: true });
    f.captureSources.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expectSuppressed(output);
      expect(f.checkMicrostripRoute).toHaveBeenCalledTimes(1);
      expect(f.helper!.runner).toHaveBeenCalledTimes(1);
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("suppresses a completed calculation if exact saved PCB bytes change during helper dispatch", async () => {
    const f = await fixture({ helper: true, onDispatch: async pcbPath => { await writeFile(pcbPath, `${source}\n`); } });
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expectSuppressed(output);
      expect(f.helper!.runner).toHaveBeenCalledTimes(1);
      expect(contentIdentity(await readFile(f.pcbPath))).not.toEqual(f.request.expectedSourceIdentity);
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("captures direct-caller request fields before its first asynchronous read", async () => {
    const f = await fixture();
    try {
      const expectedRequest = structuredClone(f.request);
      const pending = f.assess(f.request);
      f.request.expectedSourceIdentity.digest = "0".repeat(64);
      f.request.net = "OTHER";
      f.request.targetOhm = 500;
      f.request.reference.net = "OTHER";
      f.request.terminals[0]!.reference = "OTHER";
      f.request.construction.dielectric.epsilonR = 99;
      const output = await pending;
      expect(output).toMatchObject({ sourceIdentity: contentIdentity(f.bytes), request: expectedRequest,
        routeCompleteness: { status: "complete_source_chain", totalLengthNm: 10000000 },
        numericalTarget: { status: "unassessed" } });
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("does not disclose filesystem errors through the saved-board tool", async () => {
    const f = await fixture();
    await rm(f.pcbPath);
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expectSuppressed(output);
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("does not disclose helper errors or invent a numerical success", async () => {
    const f = await fixture({ helper: true });
    f.helper!.runner.mockRejectedValueOnce(new Error(`PRIVATE_HOST_FAILURE ${f.helper!.executablePath} --model ${source}`));
    try {
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expect(f.helper!.runner).toHaveBeenCalledTimes(1);
      expect(output.isError).not.toBe(true);
      expect(output.structuredContent).toMatchObject({ numericalTarget: { status: "unassessed",
        reasons: [{ code: "CALCULATION_UNAVAILABLE" }] }, boardAccepted: false, interfaceAccepted: false });
      expectPrivate(output, f);
    } finally { await f.close(); }
  });

  it("denies further saved-board calls after session finalization", async () => {
    const f = await fixture({ helper: true });
    try {
      const finished = await f.client.callTool({ name: "evleda_finish_session", arguments: {} });
      expect(finished.isError).not.toBe(true);
      const output = await f.client.callTool({ name: TOOL, arguments: f.request });
      expectSuppressed(output);
      expect(f.checkMicrostripRoute).not.toHaveBeenCalled();
      expect(f.assertCurrent).not.toHaveBeenCalled();
      expect(f.helper!.runner).not.toHaveBeenCalled();
      expect(f.nativeClose).toHaveBeenCalledTimes(1);
      expectPrivate(output, f);
    } finally { await f.close(); }
  });
});

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createKicadToolboxMcpServer } from "../../src/mcp/toolbox-server.js";
import type { KicadTransmissionLineCalculator, KicadTransmissionLineResult } from "../../src/integrations/kicad-transmission-line.js";

const request = { model: "coupled_microstrip", operation: "synthesize", fixed: "width", targetOhm: 90,
  parameters: { EPSILONR: 4.2, H: 0.0002, T: 0.000035, PHYS_WIDTH: 0.0003, PHYS_S: 0.0002,
    PHYS_LEN: 0.01, FREQUENCY: 1e9, SIGMA: 5.8e7, MURC: 1, H_T: 1, ROUGH: 0, TAND: 0.02 } };
async function fixture(calculator?: KicadTransmissionLineCalculator) {
  const toolbox = createKicadToolboxMcpServer(calculator === undefined ? {} : { transmissionLine: calculator });
  const client = new Client({ name: "transline-mcp-test", version: "1" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverWire); await client.connect(clientWire);
  return { client, close: async () => { await client.close(); await toolbox.close(); } };
}
const result = (status: KicadTransmissionLineResult["status"]) => ({ status, request,
  scope: "Analytical fixture, not a saved-board impedance result", targetResidualOhm: 0,
  impedance: { differentialAtFrequencyOhm: 90, nativeDifferentialOhm: 90.08 } }) as unknown as KicadTransmissionLineResult;

describe("host-bound MCP transmission-line calculation", () => {
  it("does not advertise a calculator without a host capability", async () => {
    const f = await fixture();
    try { expect((await f.client.listTools()).tools.some(tool => tool.name === "evleda_transmission_line")).toBe(false); }
    finally { await f.close(); }
  });
  it("advertises a usable object schema and forwards exact explicit inputs without requiring CAD edits", async () => {
    const calculate = vi.fn(async () => result("calculated")); const f = await fixture({ calculate });
    try {
      const tool = (await f.client.listTools()).tools.find(tool => tool.name === "evleda_transmission_line")!;
      expect(tool.inputSchema.type).toBe("object"); expect(tool.annotations?.readOnlyHint).toBe(true);
      const output = await f.client.callTool({ name: tool.name, arguments: request });
      expect(output.isError).not.toBe(true); expect(calculate).toHaveBeenCalledWith(request);
      expect(output.structuredContent).toMatchObject({ status: "calculated", boardVerificationPerformed: false,
        impedance: { differentialAtFrequencyOhm: 90, nativeDifferentialOhm: 90.08 } });
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent)
        .toMatchObject({ access: "guidance-only", recoveryRequired: false, calculationTools: [tool.name] });
    } finally { await f.close(); }
  });
  it.each(["not_converged", "target_not_reached", "invalid_model_result"] as const)("retains %s as a calculation failure, not CAD recovery", async status => {
    const f = await fixture({ calculate: async () => result(status) });
    try {
      const output = await f.client.callTool({ name: "evleda_transmission_line", arguments: request });
      expect(output.isError).toBe(true); expect(output.structuredContent).toMatchObject({ status, boardVerificationPerformed: false });
      expect((await f.client.callTool({ name: "evleda_toolbox_status", arguments: {} })).structuredContent).toMatchObject({ recoveryRequired: false });
    } finally { await f.close(); }
  });
  it.each(["analyze", "synthesize"] as const)("forwards explicit uncovered single-microstrip %s through the public schema", async operation => {
    const { PHYS_S, ...singleParameters } = request.parameters; void PHYS_S;
    const uncovered = { model: "microstrip", operation,
      parameters: { ...singleParameters, H_T: "absent", MUR: 1, ...(operation === "synthesize" ? { ANG_L: 0.4 } : {}) },
      ...(operation === "synthesize" ? { targetOhm: 50 } : {}) };
    const calculate = vi.fn(async () => ({ ...result("calculated"), request: uncovered }) as KicadTransmissionLineResult);
    const f = await fixture({ calculate });
    try {
      const output = await f.client.callTool({ name: "evleda_transmission_line", arguments: uncovered });
      expect(output.isError).not.toBe(true);
      expect(calculate).toHaveBeenCalledWith(uncovered);
      expect(output.structuredContent).toMatchObject({ status: "calculated", boardVerificationPerformed: false,
        request: { parameters: { H_T: "absent" } } });
    } finally { await f.close(); }
  });
  it.each(["analyze", "synthesize"] as const)("forwards explicit uncovered coupled-microstrip %s through the public schema", async operation => {
    const uncovered = { model: "coupled_microstrip", operation,
      parameters: { ...request.parameters, H_T: "absent" },
      ...(operation === "synthesize" ? { targetOhm: 90, fixed: "width" } : {}) };
    const calculate = vi.fn(async () => ({ ...result("calculated"), request: uncovered }) as KicadTransmissionLineResult);
    const f = await fixture({ calculate });
    try {
      const output = await f.client.callTool({ name: "evleda_transmission_line", arguments: uncovered });
      expect(output.isError).not.toBe(true);
      expect(calculate).toHaveBeenCalledWith(uncovered);
      expect(output.structuredContent).toMatchObject({ status: "calculated", boardVerificationPerformed: false,
        request: { parameters: { H_T: "absent" } } });
    } finally { await f.close(); }
  });
  it("rejects missing physical inputs and executable injection before calculator dispatch", async () => {
    const calculate = vi.fn(async () => result("calculated")); const f = await fixture({ calculate });
    try {
      for (const argumentsValue of [{ ...request, executablePath: "other.exe" }, { ...request, parameters: { H: 0.0002 } },
        { ...request, parameters: { ...request.parameters, H_T: "none" } }]) {
        const output = await f.client.callTool({ name: "evleda_transmission_line", arguments: argumentsValue });
        expect(output.isError).toBe(true);
      }
      expect(calculate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});

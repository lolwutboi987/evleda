/** Actual helper through the public MCP calculator; no CAD or board acceptance. */
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { parseArgs } from "node:util";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { readKicadNativeProfile } from "../src/flux/production-composition.js";
import { createKicadTransmissionLineCalculator } from "../src/integrations/kicad-transmission-line.js";
import { createKicadToolboxMcpServer } from "../src/mcp/toolbox-server.js";
import { BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION } from "../src/integrations/bounded-process.js";

const { values } = parseArgs({ strict: true, options: { profile: { type: "string" }, "profile-sha256": { type: "string" },
  "profile-bytes": { type: "string" }, report: { type: "string" } } });
for (const key of ["profile", "profile-sha256", "profile-bytes", "report"] as const) if (!values[key]) throw new Error(`Missing --${key}`);
const profile = await readKicadNativeProfile({ path: path.resolve(values.profile!),
  contentIdentity: { algorithm: "sha256", digest: values["profile-sha256"]!, size: Number(values["profile-bytes"]) } });
const helper = profile.kicadTransmissionLine;
if (helper === undefined) throw new Error("Host profile does not bind a transmission-line helper.");
const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot, windir = process.env.WINDIR ?? process.env.windir;
if (!systemRoot || !windir || systemRoot.toLowerCase() !== windir.toLowerCase()) throw new Error("Expected matching Windows roots.");
const environment = { SYSTEMROOT: systemRoot, WINDIR: windir };
const calculator = await createKicadTransmissionLineCalculator({ executablePath: helper.path,
  expectedExecutableIdentity: { sha256: helper.identity.digest, sizeBytes: helper.identity.size }, cwd: path.dirname(helper.path), environment,
  windowsProcessTreeTermination: { schemaVersion: BOUNDED_WINDOWS_PROCESS_TREE_TERMINATION_SCHEMA_VERSION,
    executablePath: profile.kicadMcpRuntime.processTreeSupervision.terminator.path,
    executableIdentity: profile.kicadMcpRuntime.processTreeSupervision.terminator.identity,
    cwd: path.dirname(helper.path), env: environment } });
const toolbox = createKicadToolboxMcpServer({ transmissionLine: calculator });
const client = new Client({ name: "evleda-calculator-native-proof", version: "1" });
const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), operations: [],
  scope: "Host-pinned native analytical calculator through public MCP dispatch. Explicit synthetic cross-sections, not a fabrication stackup or saved-board impedance qualification." };
const base = { EPSILONR: 4.2, H: 0.0005, T: 0.000035, PHYS_WIDTH: 0.0003, PHYS_LEN: 0.01,
  FREQUENCY: 1e9, SIGMA: 5.8e7, MURC: 1 };
const micro = { ...base, H: 0.0002, H_T: 1, ROUGH: 0, TAND: 0.02 };
const cases = [
  { model: "microstrip", operation: "analyze", parameters: { ...micro, MUR: 1 } },
  { model: "coupled_microstrip", operation: "analyze", parameters: { ...micro, PHYS_S: 0.0002 } },
  { model: "stripline", operation: "analyze", parameters: { ...base, STRIPLINE_A: (base.H - base.T) / 2, TAND: 0.02 } },
  { model: "coupled_stripline", operation: "analyze", parameters: { ...base, PHYS_S: 0.0002 } },
  { model: "coupled_microstrip", operation: "synthesize", parameters: { ...micro, PHYS_S: 0.0002 }, fixed: "width", targetOhm: 90 },
  { model: "coupled_stripline", operation: "synthesize", parameters: { ...base, PHYS_S: 0.0002 }, fixed: "spacing", targetOhm: 90 },
];
try {
  await toolbox.server.connect(serverWire); await client.connect(clientWire);
  report.tools = await client.listTools();
  for (const request of cases) {
    const start = performance.now();
    const result = await client.callTool({ name: "evleda_transmission_line", arguments: request }, { timeout: 30_000 });
    (report.operations as unknown[]).push({ request, durationMs: performance.now() - start, result });
    const data = result.structuredContent as { status?: string; boardVerificationPerformed?: boolean; modelWarnings?: unknown[]; targetResidualOhm?: number | null } | undefined;
    if (result.isError || data?.status !== "calculated" || data.boardVerificationPerformed !== false || !Array.isArray(data.modelWarnings)
      || request.operation === "synthesize" && (typeof data.targetResidualOhm !== "number" || Math.abs(data.targetResidualOhm) > 0.0002)) {
      throw new Error(`MCP calculator did not return the expected scoped result for ${request.model}/${request.operation}`);
    }
  }
  report.completed = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  await client.close(); await toolbox.close(); report.finishedAt = new Date().toISOString();
  await writeFile(path.resolve(values.report!), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ completed: report.completed ?? false, error: report.error, report: values.report })}\n`);
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { contentIdentity } from "../src/core/canonical.js";
import { loadKicadToolboxWorkspace } from "../src/mcp/toolbox-workspace-main.js";
import { planeDividerDraft } from "../tests/helpers/plane-divider-draft.js";

// Read-only public-tool qualification of discovery -> inspection -> ready draft.
// No CAD session, model, project creation, native acceptance, or physical qualification.
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  profile: { type: "string" }, "profile-sha256": { type: "string" }, "profile-bytes": { type: "string" },
  output: { type: "string" },
} });
if (!values.profile || !values.output || !/^[a-f0-9]{64}$/u.test(values["profile-sha256"] ?? "")
  || !/^[1-9][0-9]*$/u.test(values["profile-bytes"] ?? "")) throw new Error("Supply exact --profile/--profile-sha256/--profile-bytes and a new --output directory.");
const output = path.resolve(values.output), workspaceRoot = path.join(output, "workspace");
await mkdir(output); await mkdir(workspaceRoot);
const profile = { path: path.resolve(values.profile), contentIdentity: { algorithm: "sha256" as const,
  digest: values["profile-sha256"]!, size: Number(values["profile-bytes"]) } };
const report: Record<string, unknown> = { schemaVersion: "evleda.stock-catalog-public-proof.v1", startedAt: new Date().toISOString(),
  profile, nativeOpened: false, projectCreated: false, engineeringQualification: false, operations: [] };
const operations = report.operations as unknown[];
let client: Client | undefined;
let workspace: Awaited<ReturnType<typeof loadKicadToolboxWorkspace>> | undefined;
try {
  workspace = await loadKicadToolboxWorkspace({ profile, workspaceRoot, access: "read-only" });
  client = new Client({ name: "evleda-stock-catalog-public-proof", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await workspace.server.connect(right); await client.connect(left);
  report.tools = (await client.listTools()).tools.map(tool => tool.name);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client!.callTool({ name, arguments: args });
    const bytes = Buffer.from(JSON.stringify(response, null, 2) + "\n");
    const filename = `${String(operations.length + 1).padStart(3, "0")}-${name}.json`;
    await writeFile(path.join(output, filename), bytes, { flag: "wx" });
    operations.push({ name, arguments: args, filename, identity: contentIdentity(bytes), isError: response.isError === true });
    if (response.isError) throw new Error(`Public tool ${name} failed; inspect ${filename}.`);
    return response.structuredContent as Record<string, any>;
  }
  async function find(kind: "symbol" | "footprint", library: string, query: string, libraryId: string) {
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const response = await call("evleda_search_library", { kind, library, query, limit: 20, ...(cursor === undefined ? {} : { cursor }) });
      const candidate = response.candidates.find((item: Record<string, unknown>) => item.libraryId === libraryId);
      if (candidate) return candidate;
      if (response.nextCursor === null) throw new Error(`Required candidate ${libraryId} was not found; complete=${response.complete}.`);
      cursor = response.nextCursor;
    }
    throw new Error("Required candidate search exceeded the probe's page bound.");
  }
  report.initialStatus = await call("evleda_workspace_status");
  report.capacitorCandidate = await find("symbol", "Device", "capacitor", "Device:C");
  report.capacitorFootprintCandidate = await find("footprint", "Capacitor_SMD", "C_0603_1608Metric", "Capacitor_SMD:C_0603_1608Metric");
  report.rp2350Discovery = await call("evleda_search_library", { kind: "symbol", library: "MCU_RaspberryPi", query: "RP2350", limit: 20 });
  for (const [kind, libraryId] of [["symbol", "Device:C"], ["footprint", "Capacitor_SMD:C_0603_1608Metric"]] as const) {
    const response = await call("evleda_inspect_library", { kind, libraryId });
    if (!response.found) throw new Error("Selected stock candidate cannot be inspected.");
  }
  const schema = await call("evleda_design_schema", { family: "plane-v2" });
  if (schema.family !== "plane-v2") throw new Error("Plane V2 schema is unavailable.");
  const rename = (value: any): any => Array.isArray(value) ? value.map(rename) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rename(child)])) : value === "R2" ? "C1" : value;
  // Reuse explicit software-fixture geometry/electrical assertions. The published
  // schema example deliberately contains unknowns and is not a completed circuit.
  const draft = rename(planeDividerDraft());
  const capacitor = draft.components.find((component: { reference: string }) => component.reference === "C1");
  if (!capacitor) throw new Error("Probe expects the software fixture's R2 to replace with a capacitor.");
  capacitor.symbolLibId = "Device:C"; capacitor.footprintLibId = "Capacitor_SMD:C_0603_1608Metric"; capacitor.value = "100n";
  draft.components.find((component: { reference: string }) => component.reference === "R1").value = "1k";
  // The unloaded RC output approaches the input at DC; do not retain the
  // divider fixture's half-supply assertion after replacing its shunt resistor.
  draft.nets.find((net: { name: string }) => net.name === "VOUT").electrical.voltage =
    structuredClone(draft.nets.find((net: { name: string }) => net.name === "VIN").electrical.voltage);
  await writeFile(path.join(output, "rc-filter-draft.json"), JSON.stringify(draft, null, 2) + "\n", { flag: "wx" });
  report.ready = await call("evleda_submit_design", { name: "catalog-rc-filter", draft,
    originalPrompt: "Prepare a software fixture of a 1k / 100n RC low-pass filter with input, output and ground header. Exercise stock catalog selection and source-bound V2 draft compilation. No native layout or electrical qualification is claimed by this probe." });
  const ready = report.ready as Record<string, any>;
  if (ready.status !== "ready" || !ready.compilation.libraryBinding.sourceSelection) throw new Error("Catalog design did not reach source-bound readiness.");
  await call("evleda_discard_draft", { draftId: ready.draftId });
  report.finalStatus = await call("evleda_workspace_status"); report.projects = await call("evleda_list_projects");
  if ((report.projects as Record<string, any>).total !== 0) throw new Error("Read-only probe unexpectedly allocated a project.");
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  try { await client?.close(); await workspace?.close(); report.closed = true; }
  catch (error) { report.status = "failed"; report.closeError = String(error); process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.profileUnchanged = contentIdentity(await readFile(profile.path)).digest === profile.contentIdentity.digest;
  if (!report.profileUnchanged) { report.status = "failed"; process.exitCode = 1; }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ status: report.status, operations: operations.length, output })}\n`);
}

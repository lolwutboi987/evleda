/** Real public MCP over in-memory transport; synthetic geometry, not circuit acceptance. */
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentIdentity } from "../src/core/canonical.js";
import { nativeProjectFingerprint } from "../src/cli/pcb-agent.js";
import { createNativeToolbox, parseNativeToolboxArgs } from "../src/mcp/toolbox-native-main.js";

const options = parseNativeToolboxArgs(process.argv.slice(2));
if (!options || options.edit || options.resume || options.fresh) throw new Error("Requires new copied, read-only native host arguments.");
const original = await nativeProjectFingerprint(options.projectDir);
const inputIdentity = contentIdentity(await readFile(path.join(options.projectDir, options.board)));
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), transport: "Actual public MCP using linked InMemoryTransport",
  scope: "Synthetic saved-fill geometry only; freshness/DC/reference eligibility/stackup/impedance/HF remain unverified.", inputIdentity, cases: [] };
let toolbox: Awaited<ReturnType<typeof createNativeToolbox>> | undefined;
let client: Client | undefined;
try {
  console.log("Opening owned copied native board...");
  toolbox = await createNativeToolbox(options);
  client = new Client({ name: "evleda-reference-native-smoke", version: "1.0.0" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverWire); await client.connect(clientWire);
  const pcbPath = path.join(options.outputDir, "project", options.board);
  const savedBefore = await readFile(pcbPath);
  assert.deepEqual(contentIdentity(savedBefore), inputIdentity);
  for (const [net, expected] of [["SIG_CLEAR", "covered"], ["SIG_VOID", "uncovered"], ["SIG_TANGENT", "boundary_uncertain"]] as const) {
    console.log(`Querying ${net}...`);
    const result = await client.callTool({ name: "evleda_check_reference_coverage", arguments: {
      signalNets: [net], signalLayer: "F.Cu", referenceNet: "GND", referenceLayer: "B.Cu",
      marginNm: 100_000, marginBasis: "Synthetic geometry test: explicit 0.1 mm beyond each trace edge; not an approved electrical margin.",
      expectedSourceSha256: inputIdentity.digest,
    } });
    await writeFile(path.join(options.outputDir, `${net}-mcp.json`), JSON.stringify(result, null, 2), { flag: "wx" });
    assert.ok(!result.isError, `${net} public tool returned error`);
    const text = result.content.find(item => item.type === "text");
    assert.ok(text && text.type === "text");
    const value = JSON.parse(text.text);
    (report.cases as unknown[]).push(value);
    assert.equal(value.status, "computed");
    assert.equal(value.sourceUnchanged, true);
    assert.deepEqual(value.sourceIdentity, inputIdentity);
    const resource = await client.readResource({ uri: value.diagnosticResource });
    assert.equal(resource.contents.length, 1);
    const body = resource.contents[0];
    assert.ok(body && "text" in body && typeof body.text === "string");
    const identity = contentIdentity(body.text);
    assert.deepEqual(identity, value.calculation.artifacts.rawOutput.identity);
    assert.equal(value.diagnosticResource, `evleda://reference-coverage/${identity.digest}`);
    assert.deepEqual(contentIdentity(await readFile(value.calculation.artifacts.rawOutput.path)), identity);
    assert.deepEqual(contentIdentity(await readFile(value.calculation.artifacts.input.path)), value.calculation.artifacts.input.identity);
    await writeFile(path.join(options.outputDir, `${net}-resource.json`), body.text, { flag: "wx" });
    value.resourceVerified = identity;
    assert.equal(value.geometricStatus, expected, `${net}: unexpected geometry; do not change margin to force pass`);
    assert.equal(value.routeResults.length, 1);
    assert.equal(value.routeResults[0].status, expected);
    assert.deepEqual(await readFile(pcbPath), savedBefore);
  }
  report.operationCycleCompleted = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  console.log("Closing exact owned native host...");
  try { await toolbox?.close(); report.nativeCleanupConfirmed = toolbox ? true : null; }
  catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  await client?.close().catch(() => undefined);
  report.sourceUnchanged = original === await nativeProjectFingerprint(options.projectDir);
  if (!report.sourceUnchanged) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(options.outputDir, "reference-coverage-smoke.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ completed: report.operationCycleCompleted, closed: report.nativeCleanupConfirmed,
    sourceUnchanged: report.sourceUnchanged, error: report.error, cleanupError: report.cleanupError }));
}

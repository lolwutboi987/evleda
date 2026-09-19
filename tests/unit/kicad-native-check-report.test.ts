import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, link, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNativeCheckReport, projectNativeCheckReport } from "../../src/harness/kicad-native-check-report.js";
import { actualNativeDrc, nativeCheckReply, nativeErcReport } from "../helpers/native-check-verdict.js";

vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => "12345678-1234-4234-8234-123456789abc" }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { expect(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)).toBe(true); await rm(root, { recursive: true, force: true }); } });
async function directory() { const root = await mkdtemp(path.join(tmpdir(), "evleda-check-report-")); roots.push(root); return root; }
const input = (outputPath: string, response = nativeCheckReply()) => ({ outputPath, operation: "run_drc" as const, toolCallId: "host-check-1", response,
  expectedSource: "rp2350-pico.kicad_pcb", sourceHashes: { "rp2350-pico.kicad_pcb": "a".repeat(64) }, assertCurrent: async () => {} });

describe("bounded host native-check reports", () => {
  it("retains all 192 actual unconnected errors despite repeated finding IDs", async () => {
    const bytes = await readFile(new URL("../fixtures/fresh-project/native60-03-unrouted-drc.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("2a93afdab1100cdc37d0b8846df91db28fc9439a2e5d2e6571668181699435de");
    const response = nativeCheckReply(); expect(new Set(response.structuredContent.findings.map((f: any) => f.id)).size).toBe(1);
    const report = projectNativeCheckReport("run_drc", response, "rp2350-pico.kicad_pcb");
    expect(report.summary).toMatchObject({ verdict: "FAIL", status: "failed", metadata: { violations: 0, unconnected_items: 192 },
      findingEvidence: { total: 192, returned: 8, omitted: 184, partial: true, counts: { error: 192, warning: 0 } },
      coverage: { includedSeverities: ["error", "warning", "exclusion"], ignoredCheckCount: 5 } });
    expect(report.full).toEqual(response); expect(Buffer.byteLength(JSON.stringify(report.summary))).toBeLessThan(32_000);
  });

  it("publishes the complete private response before returning only its filename/hash and bounded sample", async () => {
    const root = await directory(), response = nativeCheckReply(); response.structuredContent.remediation = "sk-private-test C:/private/report.json";
    let fences = 0;
    const report = await captureNativeCheckReport({ ...input(root, response), assertCurrent: async () => {
      if (++fences === 2) expect((await readdir(path.join(root, ".evleda-mcp-output"))).length).toBe(1);
    } });
    const bytes = await readFile(path.join(root, ".evleda-mcp-output", report.diagnostic.filename));
    expect(report.diagnostic.identity).toMatchObject({ digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
    const privateRecord = JSON.parse(bytes.toString()); expect(privateRecord.response).toEqual(response);
    expect(privateRecord.response.structuredContent.findings).toHaveLength(192);
    expect(privateRecord.response.structuredContent.evidence[0].violations.unconnected_items).toHaveLength(192);
    expect(privateRecord.sourceHashes).toEqual(input(root).sourceHashes);
    expect(JSON.stringify(report)).not.toMatch(/sk-private|C:[\\/]|report_path/);
    await expect(captureNativeCheckReport(input(root))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(root, ".evleda-mcp-output", report.diagnostic.filename))).toEqual(bytes);
  });

  it.each([
    ["wrong count", (r: any) => { r.metadata.unconnected_items--; }],
    ["missing final finding", (r: any) => { r.findings.pop(); }],
    ["wrong final evidence", (r: any) => { r.findings.at(-1).evidence[0].entry.items[0].pos.x += 1; }],
    ["false pass", (r: any) => { r.verdict = "PASS"; r.severity = "info"; r.failure_mode = "none"; }],
    ["wrong report status", (r: any) => { r.metadata.report_status = "clean"; }],
    ["false text count", (r: any) => { r.text = r.text.replace("Unconnected items: 192", "Unconnected items: 0"); }],
    ["prefix-lookalike text count", (r: any) => { r.text = r.text.replace("Unconnected items: 192", "Unconnected items: 1920"); }],
    ["false summary", (r: any) => { r.summary = "DRC is clean."; }],
    ["wrong source", (r: any) => { r.evidence[0].violations.source = "other.kicad_pcb"; }],
    ["missing error coverage", (r: any) => { r.evidence[0].violations.included_severities = ["warning"]; }],
    ["duplicate coverage", (r: any) => { r.evidence[0].violations.included_severities.push("error"); }],
    ["unknown native form", (r: any) => { r.evidence[0].violations.future_violations = []; }],
    ["unprojected parity", (r: any) => { r.evidence[0].violations.schematic_parity = [structuredClone(actualNativeDrc.unconnected_items[0])]; }],
    ["unavailable report", (r: any) => { r.metadata.available = false; }],
  ] as const)("rejects %s without publishing a partial substitute", async (_name, mutate) => {
    const root = await directory(), response = structuredClone(nativeCheckReply()); mutate(response.structuredContent);
    await expect(captureNativeCheckReport(input(root, response))).rejects.toThrow(); expect(await readdir(root)).toEqual([]);
  });

  it("keeps an error beyond the inline sample blocking and covers current courtyard rows", () => {
    const native = structuredClone(actualNativeDrc); native.unconnected_items = native.unconnected_items.slice(0, 9);
    native.unconnected_items.slice(0, 8).forEach((e: any) => { e.severity = "warning"; });
    native.violations = [{ ...structuredClone(native.unconnected_items[0]), type: "courtyards_overlap" }];
    const report = projectNativeCheckReport("run_drc", nativeCheckReply("run_drc", native), native.source).summary;
    expect(report.findings.every(f => f.severity === "warning")).toBe(true);
    expect(report.verdict).toBe("FAIL"); expect(report.metadata).toMatchObject({ violations: 1, unconnected_items: 9, courtyard_issues: 1 });
    expect(report.findingEvidence.counts).toEqual({ error: 1, warning: 9 });
  });

  it("reconciles complete ERC sheets and the exact host-redacted error counter", () => {
    const response = nativeCheckReply("run_erc", nativeErcReport());
    expect(response.structuredContent.metadata.summary.error).toBe("[redacted sidecar diagnostic]");
    const report = projectNativeCheckReport("run_erc", response, "rp2350-pico.kicad_sch").summary;
    expect(report.metadata).toEqual({ available: true, violation_count: 192, violations: 192, summary: { error: 192 } });
    expect(report.findingEvidence.total).toBe(192); expect(report.verdict).toBe("FAIL");
    response.structuredContent.metadata.violation_count = 0;
    expect(() => projectNativeCheckReport("run_erc", response, "rp2350-pico.kicad_sch")).toThrow();
  });

  it("fails private directory/file writes and changed source fences without returning a summary", async () => {
    const root = await directory(); await writeFile(path.join(root, ".evleda-mcp-output"), "blocked");
    await expect(captureNativeCheckReport(input(root))).rejects.toThrow();
    const second = await directory(); let calls = 0;
    await expect(captureNativeCheckReport({ ...input(second), assertCurrent: async () => { if (++calls === 2) throw new Error("source drift"); } })).rejects.toThrow("source drift");
    const [name] = await readdir(path.join(second, ".evleda-mcp-output"));
    expect(JSON.parse(await readFile(path.join(second, ".evleda-mcp-output", name!), "utf8")).response.structuredContent.findings).toHaveLength(192);
  });

  it("refuses a linked private directory", async () => {
    const root = await directory(), elsewhere = await directory();
    await symlink(elsewhere, path.join(root, ".evleda-mcp-output"), process.platform === "win32" ? "junction" : "dir");
    await expect(captureNativeCheckReport(input(root))).rejects.toThrow(/private directory/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it.each(["replacement", "hardlink"] as const)("refuses artifact %s during the final awaited source guard", async kind => {
    const root = await directory(); let calls = 0;
    await expect(captureNativeCheckReport({ ...input(root), assertCurrent: async () => {
      if (++calls !== 2) return;
      const dir = path.join(root, ".evleda-mcp-output"), [name] = await readdir(dir), file = path.join(dir, name!);
      if (kind === "hardlink") await link(file, path.join(dir, "additional-link.json"));
      else { const bytes = await readFile(file); await rename(file, path.join(dir, "original-artifact.json")); await writeFile(file, bytes); }
    } })).rejects.toThrow(/artifact changed during final source guard/);
  });

  it("keeps the fixed full-response byte bound and rejects contradictory envelopes", () => {
    const tooLarge = nativeCheckReply(); tooLarge.structuredContent.text = "x".repeat(2 * 1024 * 1024);
    expect(() => projectNativeCheckReport("run_drc", tooLarge, "rp2350-pico.kicad_pcb")).toThrow();
    const contradictory = nativeCheckReply(); contradictory.content = [{ type: "text", text: "PASS" }];
    expect(() => projectNativeCheckReport("run_drc", contradictory, "rp2350-pico.kicad_pcb")).toThrow();
    expect(() => projectNativeCheckReport("run_drc", { ...nativeCheckReply(), isError: true }, "rp2350-pico.kicad_pcb")).toThrow();
  });
});

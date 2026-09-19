import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/client";

// Exact native60-03 DRC bytes: 192 unconnected ERROR rows, no other violations.
// Original capture SHA256 2a93afdab1100cdc37d0b8846df91db28fc9439a2e5d2e6571668181699435de.
export const actualNativeDrc: Record<string, any> = JSON.parse(readFileSync(new URL("../fixtures/fresh-project/native60-03-unrouted-drc.json", import.meta.url), "utf8"));

/** Pinned validation.py/models.verdict projection, followed by its real host marker/path redaction shape. */
export function nativeCheckReply(operation: "run_drc" | "run_erc" = "run_drc", report = structuredClone(actualNativeDrc)): CallToolResult & { structuredContent: Record<string, any> } {
  const kind = operation === "run_drc" ? "drc" : "erc";
  const rows = operation === "run_drc"
    ? [...report.violations.map((entry: any) => ({ source: "drc", tool: "run_drc", entry })),
      ...report.unconnected_items.map((entry: any) => ({ source: "drc.unconnected", tool: "get_unconnected_nets", entry }))]
    : [...(report.violations ?? []), ...report.sheets.flatMap((s: any) => s.violations.map((entry: any) => ({ ...entry, sheet_path: s.path })))].map((entry: any) => ({ source: "erc", tool: "run_erc", entry }));
  const findings = rows.map(({ source, tool, entry }: any) => ({
    id: createHash("sha256").update([source, entry.type, source, entry.description].join("|")).digest("hex").slice(0, 12),
    severity: entry.severity === "warning" ? "warning" : "error", location: source, description: entry.description,
    evidence: [{ source, entry }], remediation: `Fix the ${source} finding and rerun ${tool}(save_report=True).`, retryable: false,
    failure_mode: "design", suggested_fix: { tool, args: { save_report: true } },
    metadata: { ...(entry.items?.length ? { uuids: entry.items.map((i: any) => i.uuid) } : {}), ...(entry.sheet_path ? { sheet_path: entry.sheet_path } : {}) },
  }));
  const verdict = findings.some((f: any) => f.severity === "error") ? "FAIL" : findings.length ? "WARN" : "PASS";
  const severitySummary: Record<string, number | string> = {};
  for (const { entry } of rows) severitySummary[entry.severity] = Number(severitySummary[entry.severity] ?? 0) + 1;
  if (Object.hasOwn(severitySummary, "error")) severitySummary.error = "[redacted sidecar diagnostic]";
  const result = { content: [{ type: "text", text: '{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"validated_structured_evidence"}' }],
    structuredContent: { schema_version: "verdict.v1", text: operation === "run_drc"
      ? `DRC summary:\n- Violations: ${report.violations.length}\n- Unconnected items: ${report.unconnected_items.length}\n- Courtyard issues: ${new Set(report.violations.filter((e: any) => ["courtyards_overlap", "pth_inside_courtyard", "npth_inside_courtyard"].includes(e.type)).map((e: any) => JSON.stringify(e))).size}`
      : `ERC summary:\n- Violations: ${rows.length}`,
      summary: verdict === "PASS" ? `${kind.toUpperCase()} is clean.` : `${kind.toUpperCase()} reported ${findings.length} actionable finding(s).`, verdict,
      severity: verdict === "FAIL" ? "error" : verdict === "WARN" ? "warning" : "info", failure_mode: verdict === "PASS" ? "none" : "design", retryable: false,
      evidence: [{ report_path: "[redacted path]", violations: report }], remediation: "Repair findings.", findings, next_action: "Inspect complete report.",
      metadata: operation === "run_drc" ? { report_path: "[redacted path]", available: true, violations: report.violations.length,
        unconnected_items: report.unconnected_items.length, courtyard_issues: new Set(report.violations.filter((e: any) => ["courtyards_overlap", "pth_inside_courtyard", "npth_inside_courtyard"].includes(e.type)).map((e: any) => JSON.stringify(e))).size,
        report_status: findings.length ? "findings" : "clean" }
        : { report_path: "[redacted path]", available: true, violation_count: rows.length, violations: rows.map((r: any) => r.entry), summary: severitySummary },
    } };
  // JSON transport does not preserve aliases between the report and findings.
  return JSON.parse(JSON.stringify(result));
}

export function nativeErcReport(rows = actualNativeDrc.unconnected_items) {
  const { violations: _v, unconnected_items: _u, schematic_parity: _s, ...base } = structuredClone(actualNativeDrc);
  return { ...base, $schema: "https://schemas.kicad.org/erc.v1.json", source: "rp2350-pico.kicad_sch",
    sheets: [{ path: "[redacted path]", uuid_path: "[redacted path]", violations: structuredClone(rows) }] };
}

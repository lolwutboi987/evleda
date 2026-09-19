import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MARKER = '{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"validated_structured_evidence"}';
const text = z.string().max(16_384);
const identifier = z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const count = z.number().int().nonnegative().max(100_000);
const item = z.object({ description: text, pos: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(), uuid: z.string().max(128) }).strict();
const entry = z.object({ description: text, severity: z.enum(["error", "warning", "exclusion", "info"]), type: identifier,
  items: z.array(item).max(10_000).optional(), sheet_path: text.optional() }).strict();
const common = { $schema: text, coordinate_units: z.literal("mm"), date: text, kicad_version: z.literal("10.0.3"), source: text,
  ignored_checks: z.array(z.object({ key: identifier, description: text }).strict()).max(256),
  included_severities: z.array(z.enum(["error", "warning", "exclusion"])).max(3) };
const drc = z.object({ ...common, $schema: z.literal("https://schemas.kicad.org/drc.v1.json"),
  violations: z.array(entry).max(10_000), unconnected_items: z.array(entry).max(10_000), schematic_parity: z.array(entry).max(10_000) }).strict();
const erc = z.object({ ...common, $schema: z.literal("https://schemas.kicad.org/erc.v1.json"),
  sheets: z.array(z.object({ path: text, uuid_path: text, violations: z.array(entry).max(10_000) }).strict()).max(128),
  violations: z.array(entry).max(10_000).optional() }).strict();
const finding = z.object({ id: z.string().regex(/^[a-f0-9]{12}$/u), severity: z.enum(["error", "warning"]), location: text,
  description: text, evidence: z.array(z.object({ source: identifier, entry }).strict()).length(1), remediation: text,
  retryable: z.literal(false), failure_mode: z.literal("design"),
  suggested_fix: z.object({ tool: identifier, args: z.object({ save_report: z.literal(true) }).strict() }).strict(),
  metadata: z.object({ uuids: z.array(z.string().max(128)).max(10_000).optional(), sheet_path: text.optional() }).strict() }).strict();
const envelope = z.object({ schema_version: z.literal("verdict.v1"), text, summary: text, verdict: z.enum(["PASS", "WARN", "FAIL"]),
  severity: z.enum(["info", "warning", "error"]), failure_mode: z.enum(["none", "design"]), retryable: z.literal(false),
  evidence: z.array(z.object({ report_path: text, violations: z.unknown() }).strict()).length(1),
  remediation: text, findings: z.array(finding).max(10_000), next_action: text, metadata: z.unknown() }).strict();
type Entry = z.infer<typeof entry>;
type Operation = "run_erc" | "run_drc";
const requireValue = (value: unknown, message: string): void => { if (!value) throw new Error(`Native check report: ${message}`); };
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Full rows are compared in producer order. Stable finding IDs are NOT unique. */
export function projectNativeCheckReport(operation: Operation, response: unknown, expectedSource: string) {
  requireValue(operation === "run_erc" || operation === "run_drc", "unsupported internal operation");
  const full = hardenPortableValue(response, { maxBytes: MAX_BYTES, maxStringBytes: 1024 * 1024, maxDepth: 24,
    maxNodes: 100_000, maxArrayLength: 10_000, maxOwnKeys: 64, maxKeyBytes: 256 });
  const result = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.literal(MARKER) }).strict()).length(1),
    structuredContent: envelope, isError: z.literal(false).optional() }).strict().parse(full);
  const value = result.structuredContent;
  const native = operation === "run_drc" ? drc.parse(value.evidence[0]!.violations) : erc.parse(value.evidence[0]!.violations);
  requireValue(native.source === expectedSource, "native report belongs to another source");
  requireValue(new Set(native.included_severities).size === native.included_severities.length
    && native.included_severities.length === 3, "incomplete or duplicate severity coverage");
  requireValue(new Set(native.ignored_checks.map(v => v.key)).size === native.ignored_checks.length, "duplicate ignored-check coverage");
  let rows: Array<{ source: string; tool: string; entry: Entry }>;
  let metadata: Record<string, unknown>;
  if (operation === "run_drc") {
    const report = drc.parse(native);
    // This producer does not project schematic-parity rows into its verdict.
    // Do not silently turn unsupported coverage into a bounded clean result.
    requireValue(report.schematic_parity.length === 0, "unprojected schematic-parity findings");
    const courtyards = new Set(report.violations.filter(v => ["courtyards_overlap", "pth_inside_courtyard", "npth_inside_courtyard"].includes(v.type)).map(v => canonicalJson(v))).size;
    const observed = z.object({ report_path: text, available: z.literal(true), violations: count, unconnected_items: count,
      courtyard_issues: count, report_status: z.enum(["clean", "findings"]) }).strict().parse(value.metadata);
    requireValue(observed.report_path === value.evidence[0]!.report_path && observed.violations === report.violations.length
      && observed.unconnected_items === report.unconnected_items.length && observed.courtyard_issues === courtyards
      && observed.report_status === (report.violations.length + report.unconnected_items.length > 0 ? "findings" : "clean"), "DRC counts/report status disagree with complete native rows");
    requireValue(value.text.split(/\r?\n/u).slice(0, 4).join("\n") === `DRC summary:\n- Violations: ${observed.violations}\n- Unconnected items: ${observed.unconnected_items}\n- Courtyard issues: ${courtyards}`, "DRC text counts disagree");
    rows = [...report.violations.map(entry => ({ source: "drc", tool: "run_drc", entry })),
      ...report.unconnected_items.map(entry => ({ source: "drc.unconnected", tool: "get_unconnected_nets", entry }))];
    metadata = { available: true, report_status: observed.report_status, violations: observed.violations,
      unconnected_items: observed.unconnected_items, courtyard_issues: observed.courtyard_issues, schematic_parity: 0 };
  } else {
    const report = erc.parse(native);
    const all = [...(report.violations ?? []), ...report.sheets.flatMap(sheet => sheet.violations.map(v => sheet.path ? { ...v, sheet_path: sheet.path } : v))];
    const observed = z.object({ report_path: text, available: z.literal(true), violation_count: count,
      violations: z.array(entry).max(10_000), summary: z.object({ error: z.union([count, z.literal("[redacted sidecar diagnostic]")]).optional(),
        warning: count.optional(), exclusion: count.optional(), info: count.optional() }).strict() }).strict().parse(value.metadata);
    requireValue(observed.report_path === value.evidence[0]!.report_path && observed.violation_count === all.length && same(observed.violations, all), "ERC counts/rows disagree with complete native sheets");
    requireValue(value.text.split(/\r?\n/u).slice(0, 2).join("\n") === `ERC summary:\n- Violations: ${all.length}`, "ERC text count disagrees");
    const severityCounts: Record<string, number> = {};
    for (const row of all) severityCounts[row.severity] = (severityCounts[row.severity] ?? 0) + 1;
    requireValue(same(Object.keys(observed.summary).sort(), Object.keys(severityCounts).sort()), "ERC severity coverage disagrees");
    for (const [key, total] of Object.entries(severityCounts)) requireValue(observed.summary[key as keyof typeof observed.summary] === total
      || key === "error" && observed.summary.error === "[redacted sidecar diagnostic]", "ERC severity count disagrees");
    rows = all.map(entry => ({ source: "erc", tool: "run_erc", entry }));
    metadata = { available: true, violation_count: all.length, violations: all.length, summary: severityCounts };
  }
  requireValue(value.findings.length === rows.length, "expanded finding count disagrees");
  const counts = { error: 0, warning: 0 }, byType: Record<string, number> = Object.create(null);
  for (const [index, row] of rows.entries()) {
    const f = value.findings[index]!, severity = row.entry.severity === "warning" ? "warning" : "error";
    requireValue(f.severity === severity && f.description === row.entry.description && f.location === row.source
      && f.evidence[0]!.source === row.source && same(f.evidence[0]!.entry, row.entry) && f.suggested_fix.tool === row.tool,
    "expanded finding differs from its ordered native evidence");
    const expectedMetadata = { ...(row.entry.items?.length ? { uuids: row.entry.items.map(i => i.uuid).filter(Boolean) } : {}),
      ...(row.entry.sheet_path ? { sheet_path: row.entry.sheet_path } : {}) };
    // Producer omits empty UUID arrays.
    if (expectedMetadata.uuids?.length === 0) delete expectedMetadata.uuids;
    requireValue(same(f.metadata, expectedMetadata), "finding metadata differs from native witnesses");
    counts[severity]++; byType[row.entry.type] = (byType[row.entry.type] ?? 0) + 1;
  }
  requireValue(Object.keys(byType).length <= 128, "type breakdown exceeds public bound");
  const verdict = counts.error ? "FAIL" : counts.warning ? "WARN" : "PASS";
  requireValue(value.verdict === verdict && value.severity === (verdict === "FAIL" ? "error" : verdict === "WARN" ? "warning" : "info")
    && value.failure_mode === (verdict === "PASS" ? "none" : "design"), "verdict contradicts complete findings");
  const name = operation === "run_drc" ? "DRC" : "ERC";
  requireValue(value.summary === (verdict === "PASS" ? `${name} is clean.` : `${name} reported ${rows.length} actionable finding(s).`), "summary contradicts complete findings");
  const findings = rows.slice(0, 8).map((row, index) => ({ id: value.findings[index]!.id, severity: value.findings[index]!.severity,
    type: row.entry.type, description: `${row.entry.type}: ${value.findings[index]!.severity}; ${row.entry.items?.length ?? 0} native item witnesses.` }));
  const summary = { schemaVersion: "evleda.native-check-summary.v1" as const, operation, verdict: value.verdict,
    status: verdict === "PASS" ? "clean" : "failed", severity: value.severity, failure_mode: value.failure_mode, retryable: value.retryable,
    summary: `${operation === "run_drc" ? "DRC" : "ERC"}: ${rows.length} findings (${counts.error} error, ${counts.warning} warning).`, metadata,
    findings, findingEvidence: { total: rows.length, returned: findings.length, omitted: rows.length - findings.length,
      partial: findings.length < rows.length, counts, byType, orderedRowsPreserved: true, stableIdsMayRepeat: true },
    coverage: { includedSeverities: native.included_severities, ignoredChecks: native.ignored_checks.map(v => v.key),
      ignoredCheckCount: native.ignored_checks.length, nativeReportIdentity: contentIdentity(canonicalJson(native)) } };
  requireValue(Buffer.byteLength(JSON.stringify(summary), "utf8") < 30_000, "summary exceeds its bounded projection");
  return { full, summary };
}

interface NativeCheckCaptureInput {
  outputPath: string; operation: Operation; toolCallId: string; response: unknown; expectedSource: string;
  sourceHashes: Readonly<Record<string, string>>; assertCurrent: () => Promise<void>;
}

function rejectedError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return { thrown: error };
  const result: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack ?? null };
  for (const key of ["code", "errno", "syscall", "path", "dest", "issues", "details", "cause"] as const) {
    const value = Object.getOwnPropertyDescriptor(error, key)?.value as unknown;
    if (value !== undefined) {
      requireValue(depth < 8 || key !== "cause", "private cause chain exceeds its bound");
      result[key] = key === "cause" ? rejectedError(value, depth + 1) : value;
    }
  }
  return result;
}

/** Existing private-artifact pattern: immutable exclusive write and exact readback. */
async function writeNativeCheckArtifact(input: Pick<NativeCheckCaptureInput, "outputPath" | "operation" | "assertCurrent">,
  bytes: Buffer, rejected = false) {
  requireValue(input.operation === "run_erc" || input.operation === "run_drc", "unsupported private artifact operation");
  requireValue(bytes.length <= MAX_BYTES, "complete private response exceeds its fixed artifact bound");
  const base = path.resolve(input.outputPath), initial = await lstat(base, { bigint: true });
  requireValue(path.isAbsolute(input.outputPath) && base === input.outputPath && initial.isDirectory() && !initial.isSymbolicLink()
    && await realpath(base) === base, "output root is not the exact host directory");
  const root = path.join(base, ".evleda-mcp-output");
  try { await mkdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const first = await lstat(root, { bigint: true });
  const assertRoot = async () => {
    const current = await lstat(root, { bigint: true }), parent = await lstat(base, { bigint: true });
    requireValue(current.isDirectory() && !current.isSymbolicLink() && current.dev === first.dev && current.ino === first.ino && await realpath(root) === root
      && parent.isDirectory() && !parent.isSymbolicLink() && parent.dev === initial.dev && parent.ino === initial.ino && await realpath(base) === base,
    "private directory changed or is linked");
  };
  await assertRoot(); await input.assertCurrent();
  const filename = `native-check-${rejected ? "rejected-" : ""}${input.operation}-${randomUUID()}.json`, target = path.join(root, filename), handle = await open(target, "wx+", 0o600);
  try {
    const reserved = await handle.stat({ bigint: true });
    requireValue(reserved.isFile() && reserved.nlink === 1n && reserved.size === 0n, "artifact reservation is not exclusive");
    await assertRoot(); await handle.writeFile(bytes); await handle.sync();
    const written = await handle.stat({ bigint: true }), physical = await lstat(target, { bigint: true });
    requireValue(written.dev === reserved.dev && written.ino === reserved.ino && written.size === BigInt(bytes.length) && written.nlink === 1n
      && physical.isFile() && !physical.isSymbolicLink() && physical.dev === written.dev && physical.ino === written.ino && physical.nlink === 1n
      && physical.size === written.size && await realpath(target) === target, "artifact identity changed");
    const readback = Buffer.alloc(bytes.length + 1); let offset = 0;
    while (offset < readback.length) { const part = await handle.read(readback, offset, readback.length - offset, offset); if (!part.bytesRead) break; offset += part.bytesRead; }
    const settled = await lstat(target, { bigint: true });
    requireValue(readback.subarray(0, offset).equals(bytes) && settled.dev === written.dev && settled.ino === written.ino && settled.nlink === 1n
      && settled.size === written.size && settled.mtimeNs === physical.mtimeNs && settled.ctimeNs === physical.ctimeNs, "artifact readback changed");
    await assertRoot(); await input.assertCurrent();
    await assertRoot();
    const final = await lstat(target, { bigint: true });
    requireValue(final.isFile() && !final.isSymbolicLink() && final.dev === written.dev && final.ino === written.ino && final.nlink === 1n
      && final.size === written.size && final.mtimeNs === physical.mtimeNs && final.ctimeNs === physical.ctimeNs && await realpath(target) === target,
    "artifact changed during final source guard");
    return { filename, identity: contentIdentity(bytes) };
  } finally { await handle.close(); }
}

export async function captureNativeCheckReport(input: NativeCheckCaptureInput) {
  let phase: "qualification" | "publication" = "qualification";
  try {
    const projected = projectNativeCheckReport(input.operation, input.response, input.expectedSource);
    const bytes = Buffer.from(`${canonicalJson({ schemaVersion: "evleda.native-check-private.v1", operation: input.operation,
      toolCallId: input.toolCallId, sourceHashes: input.sourceHashes, response: projected.full })}\n`, "utf8");
    phase = "publication";
    const diagnostic = await writeNativeCheckArtifact(input, bytes);
    return { ...projected.summary, diagnostic };
  } catch (error) {
    // This is the already-received, host-sanitized response, not a replay or a
    // qualified report. Do not issue more native/source reads after rejection.
    try {
      const rejected = hardenPortableValue({ schemaVersion: "evleda.native-check-rejected.v1", qualification: "REJECTED",
        reportQualified: false, replay: false, phase, operation: input.operation, toolCallId: input.toolCallId,
        sourceHashesBefore: input.sourceHashes, expectedSource: input.expectedSource,
        response: input.response, rejection: rejectedError(error) }, { maxBytes: MAX_BYTES, maxStringBytes: 1024 * 1024,
        maxDepth: 32, maxNodes: 100_000, maxArrayLength: 10_000, maxOwnKeys: 64, maxKeyBytes: 256 });
      const bytes = Buffer.from(`${canonicalJson(rejected)}\n`, "utf8");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([writeNativeCheckArtifact({ ...input, assertCurrent: async () => {} }, bytes, true),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    } catch { /* A secondary capture failure cannot replace the exact primary rejection. */ }
    throw error;
  }
}

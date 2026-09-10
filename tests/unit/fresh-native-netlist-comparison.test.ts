import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/core/canonical.js";
import {
  compareFreshNativeNetlists,
  freshNativeNetlistComparisonEntry,
  FreshNativeNetlistComparisonError,
  FRESH_NATIVE_NETLIST_COMPARISON_SCHEMA_VERSION,
} from "../../src/harness/fresh-native-netlist-comparison.js";

const fixture = JSON.parse(await readFile(new URL("../fixtures/fresh-project/authored-netclass-native-timestamp.json", import.meta.url), "utf8")) as {
  beforeUtf8Base64: string; beforeRawSha256: string; afterRawSha256: string;
  beforeDate: string; afterDate: string; rawBytes: number; sourceHashesEqual: boolean; schematicSha256: string;
};
const capturedBefore = Buffer.from(fixture.beforeUtf8Base64, "base64").toString("utf8");
const capturedAfter = capturedBefore.replace(`(date "${fixture.beforeDate}")`, `(date "${fixture.afterDate}")`);
const dateForm = `(date "${fixture.beforeDate}")`;
const minimal = `(export (version "E") (design (source "candidate.kicad_sch") ${dateForm} (tool "Eeschema 10.0.3") (sheet (title_block (date "nested-date")))) (date "root-date") (components) (nets))`;
const replaceRequired = (source: string, search: string, replacement: string): string => {
  if (!source.includes(search)) throw new Error(`Test mutation target missing: ${search}`);
  return source.replace(search, replacement);
};

describe("source-bound native netlist timestamp comparison", () => {
  it("accepts the captured two-second timestamp change while preserving both exact raw identities", () => {
    expect(Buffer.byteLength(capturedBefore)).toBe(fixture.rawBytes);
    expect(sha256(capturedBefore)).toBe(fixture.beforeRawSha256);
    // This reconstructs the second *captured* file, not merely a synthetic date variant.
    expect(sha256(capturedAfter)).toBe(fixture.afterRawSha256);
    expect(fixture.sourceHashesEqual).toBe(true);
    expect(fixture.schematicSha256).toBe("dc34ed88381bd9259341021b6f4f5f9aa2bfc591d89bbde7c5fb7ea5bf70c451");
    const compared = compareFreshNativeNetlists(capturedBefore, capturedAfter);
    expect(compared.equal).toBe(true);
    expect(compared.before.rawIdentity).toEqual({ algorithm: "sha256", digest: fixture.beforeRawSha256, size: fixture.rawBytes });
    expect(compared.after.rawIdentity).toEqual({ algorithm: "sha256", digest: fixture.afterRawSha256, size: fixture.rawBytes });
    expect(compared.before.exportDate).toBe(fixture.beforeDate);
    expect(compared.after.exportDate).toBe(fixture.afterDate);
    expect(compared.before.comparisonIdentity).toEqual(compared.after.comparisonIdentity);
    expect(compared.before.comparisonIdentity.schemaVersion).toBe(FRESH_NATIVE_NETLIST_COMPARISON_SCHEMA_VERSION);
    expect(compared.before.comparisonIdentity.digest).not.toBe(compared.before.rawIdentity.digest);
    expect(compareFreshNativeNetlists(capturedBefore, capturedBefore).equal).toBe(true);
    expect(Object.isFrozen(compared.before.rawIdentity)).toBe(true);
  });

  it.each([
    ["net name", '(name "VIN")', '(name "VOTHER")'],
    ["managed net class", "EVLEDA_97cfc26f5aab_C01", "EVLEDA_97cfc26f5aab_C99"],
    ["net code", '(code "1")', '(code "9")'],
    ["component reference", '(ref "R1")', '(ref "R9")'],
    ["component value", '(value "10k")', '(value "20k")'],
    ["component footprint", "R_0603_1608Metric", "R_0805_2012Metric"],
    ["symbol part", '(part "R")', '(part "C")'],
    ["symbol library", '(lib "Device")', '(lib "Other")'],
    ["pin number", '(pin "2")', '(pin "9")'],
    ["pin electrical type", '(pintype "passive")', '(pintype "input")'],
    ["pin function", '(pinfunction "Pin_1_1")', '(pinfunction "Changed_1")'],
    ["library URI", "${KICAD10_SYMBOL_DIR}/Device.kicad_sym", "${KICAD10_SYMBOL_DIR}/Other.kicad_sym"],
    ["sheet identity", '(tstamps "/")', '(tstamps "/changed")'],
    ["native tool", "Eeschema 10.0.3", "Eeschema 10.0.4"],
    ["source path", "EvlEDA-authored-netclass-sync-probe-20260908-02", "EvlEDA-other-source"],
    ["export version", '(version "E")', '(version "F")'],
    ["unknown added field", "(groups)", '(groups) (unknown_field "must remain bound")'],
    ["quoted versus atom identity", '(code "1")', "(code 1)"],
  ])("rejects changed %s even alongside the permitted timestamp change", (_name, search, replacement) => {
    expect(compareFreshNativeNetlists(capturedBefore, replaceRequired(capturedAfter, search, replacement)).equal).toBe(false);
  });

  it.each([
    ["root date", '(date "root-date")', '(date "changed-root-date")'],
    ["nested title date", '(date "nested-date")', '(date "changed-nested-date")'],
    ["date-looking text", '(source "candidate.kicad_sch")', '(source "2026-09-08T21:26:06")'],
  ])("preserves %s rather than treating it as generated metadata", (_name, search, replacement) => {
    const later = minimal.replace(dateForm, `(date "${fixture.afterDate}")`);
    expect(compareFreshNativeNetlists(minimal, replaceRequired(later, search, replacement)).equal).toBe(false);
  });

  it("recognizes date-like text inside escaped strings without changing its scope", () => {
    const source = minimal.replace('(components)', '(components (note "escaped \\\"(date foo)\\\" and (design)"))');
    expect(compareFreshNativeNetlists(source, source.replace(dateForm, `(date "${fixture.afterDate}")`)).equal).toBe(true);
  });

  it.each([
    ["missing direct date", ""],
    ["duplicate direct date", `${dateForm} ${dateForm}`],
    ["unquoted date", `(date ${fixture.beforeDate})`],
    ["empty date", '(date "")'],
    ["extra date value", `${dateForm.slice(0, -1)} "extra")`],
    ["nested date content", `(date "${fixture.beforeDate}" (extra))`],
    ["nested-only date", `(wrapper ${dateForm})`],
    ["unsupported date format", '(date "09/08/2026 21:26:04")'],
    ["unsupported time zone suffix", `(date "${fixture.beforeDate}Z")`],
    ["escaped date spelling", '(date "2026\\x2d09-08T21:26:04")'],
    ["invalid calendar day", '(date "2026-02-30T21:26:04")'],
    ["invalid hour", '(date "2026-09-08T25:26:04")'],
    ["unterminated date string", '(date "2026-09-08T21:26:04)'],
  ])("fails closed for %s", (_name, replacement) => {
    expect(() => compareFreshNativeNetlists(minimal, minimal.replace(dateForm, replacement))).toThrow(FreshNativeNetlistComparisonError);
  });

  it.each([
    ["multiple exports", `${minimal} ${minimal}`],
    ["wrong root", minimal.replace("(export", "(other")],
    ["missing direct design", minimal.replace("(design", "(sheet")],
    ["duplicate direct design", minimal.replace("(export", `(export (design ${dateForm})`)],
    ["nested-only design", `(export (wrapper (design ${dateForm})))`],
    ["scalar design value", minimal.replace("(design", '(design "extra"')],
    ["quoted form head", minimal.replace("(date", '("date"')],
    ["trailing input", `${minimal} garbage`],
    ["invalid UTF-8 text", minimal.replace("candidate", "\ud800")],
  ])("fails closed for %s", (_name, source) => {
    expect(() => freshNativeNetlistComparisonEntry(source)).toThrow(FreshNativeNetlistComparisonError);
  });

  it.each([
    ["line endings", () => capturedAfter.replaceAll("\r\n", "\n")],
    ["trailing newline", () => `${capturedAfter}\n`],
    ["non-date whitespace", () => capturedAfter.replace("(nets", "(nets ")],
    ["date form whitespace", () => capturedAfter.replace(`(date "${fixture.afterDate}")`, `(date  "${fixture.afterDate}")`)],
  ])("preserves %s byte-for-byte", (_name, change) => {
    expect(compareFreshNativeNetlists(capturedBefore, change()).equal).toBe(false);
  });

  it("bounds source, token, and nesting work", () => {
    expect(() => freshNativeNetlistComparisonEntry(" ".repeat(16 * 1024 * 1024 + 1))).toThrow(/size/iu);
    expect(() => freshNativeNetlistComparisonEntry(minimal.replace("candidate", "x".repeat(262_145)))).toThrow(/token budget/iu);
    const deep = minimal.replace("(components)", `${"(nested ".repeat(65)}${")".repeat(65)}`);
    expect(() => freshNativeNetlistComparisonEntry(deep)).toThrow(/structural budget/iu);
  });
});

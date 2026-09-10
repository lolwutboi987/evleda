import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEEP_RULE_RELEASE_BOUNDARY,
  PACKAGED_DEEP_RULE_CATALOG_SHA256,
  PACKAGED_DEEP_RULE_RESOURCE_IDENTITY,
  loadDeepRuleResource,
  renderDeepRulePrompt,
  selectDeepRules,
  validateDeepRuleCatalog,
  type DeepPcbRule
} from "../../src/harness/deep-rule-catalog.js";

const resource = loadDeepRuleResource();
const resourceRoot = resource.profile.resourceDirectory;
const readmePath = resolve(resourceRoot, "docs", "pcb-design-guides", "README.md");
const libraryPath = resolve(resourceRoot, "docs", "pcb-design-guides", "agent-rule-library.md");
const catalog = resource.catalog;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const expectNonBlankArray = (values: readonly string[]): void => {
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) expect(value.trim().length).toBeGreaterThan(0);
};
const stripHeadingMarkdown = (value: string): string => value
  .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/gu, "$1 ($2)")
  .replace(/\*\*([^*]+)\*\*/gu, "$1")
  .replace(/\s+/gu, " ").trim();
const gfmAnchorBase = (heading: string): string => stripHeadingMarkdown(heading)
  .toLocaleLowerCase()
  .replace(/<[^>]*>/gu, "")
  .replace(/[^\p{L}\p{N}\s_-]/gu, "")
  .replace(/\s/gu, "-");
const headingsFor = (source: string): ReadonlyMap<string, string> => {
  const anchors = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^#{1,6}\s+(.+)$/u);
    if (!match) continue;
    const rawHeading = match[1];
    if (rawHeading === undefined) continue;
    const text = stripHeadingMarkdown(rawHeading);
    const base = gfmAnchorBase(rawHeading);
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    anchors.set(duplicate === 0 ? base : `${base}-${duplicate}`, text);
  }
  return anchors;
};
const semanticTokens = (value: string): readonly string[] => {
  const ignored = new Set(["the", "and", "for", "with", "from", "that", "this", "provide", "required", "input", "rule", "source", "https", "www"]);
  return [...new Set((value.toLocaleLowerCase().match(/[a-z0-9_]{3,}/gu) ?? []).filter((token) => !ignored.has(token)))];
};

describe("deep PCB rule catalog", () => {
  it("loads the complete identity-bound packaged resource", () => {
    expect(resource.resourceIdentity).toBe(PACKAGED_DEEP_RULE_RESOURCE_IDENTITY);
    expect(resource.catalogSha256).toBe(PACKAGED_DEEP_RULE_CATALOG_SHA256);
    expect(resource.catalogPath).toBe(resolve(resourceRoot, "docs", "pcb-design-guides", "rule-catalog.json"));
    expect(catalog.rules).toHaveLength(1_773);
  });

  it("covers all 17 current canonical dossiers and represents their hashes and links", () => {
    const readme = readFileSync(readmePath, "utf8");
    expect(catalog.sourceDossiers).toHaveLength(17);
    expect(new Set(catalog.sourceDossiers.map((dossier) => dossier.number)).size).toBe(17);
    expect(new Set(catalog.sourceDossiers.map((dossier) => dossier.slug)).size).toBe(17);
    for (const dossier of catalog.sourceDossiers) {
      const source = readFileSync(resolve(resourceRoot, dossier.dossierPath), "utf8");
      expect(sha256(source), dossier.dossierPath).toBe(dossier.sha256);
      expect(source.split(/\r?\n/u).length, dossier.dossierPath).toBe(dossier.lineCount);
      expect(catalog.rules.filter((rule) => rule.topic === dossier.slug)).toHaveLength(dossier.ruleCount);
      expect(dossier.ruleCount, dossier.slug).toBeGreaterThanOrEqual(10);
      expect(readme).toContain(dossier.dossierPath.replace("docs/pcb-design-guides/", ""));
      expect(readme).toContain(dossier.articleUrl);
      expect(readme).toContain(dossier.sha256);
    }
    for (const corrected of ["08", "09", "15", "16"]) {
      const dossier = catalog.sourceDossiers.find((candidate) => candidate.number === corrected);
      expect(dossier, `corrected dossier ${corrected}`).toBeDefined();
      expect(readme).toContain(dossier?.sha256);
    }
  });

  it("stores an exact supporting source span and a resolvable real heading for every rule", () => {
    const sources = new Map(catalog.sourceDossiers.map((dossier) => {
      const source = readFileSync(resolve(resourceRoot, dossier.dossierPath), "utf8");
      return [dossier.dossierPath, { lines: source.split(/\r?\n/u), headings: headingsFor(source) }] as const;
    }));
    for (const rule of catalog.rules) {
      const source = sources.get(rule.dossierPath);
      expect(source, rule.id).toBeDefined();
      const exactSpan = source?.lines.slice(rule.dossierLineStart - 1, rule.dossierLineEnd).join("\n");
      expect(rule.sourceText, rule.id).toBe(exactSpan);
      expect(rule.dossierLineEnd, rule.id).toBeGreaterThanOrEqual(rule.dossierLineStart);
      expect(source?.headings.get(rule.headingAnchor), rule.id).toBe(rule.dossierHeading);
    }
  });

  it("extracts no metadata, titles, research/source-ledger narrative, or fake line anchors", () => {
    const forbiddenHeading = /claim-to-source|source ledger|source register|search(?:es)? performed|research (?:coverage|limitations|method)|stop rationale|stopping rationale|evidence gaps?|article claim audit/iu;
    const forbiddenMetadata = /^(?:#|\*\*(?:research date|audience|scope|evidence key|article under review|primary article under review|required article|anchor article|source under review))/iu;
    for (const rule of catalog.rules) {
      expect(rule.dossierHeading, rule.id).not.toMatch(forbiddenHeading);
      expect(rule.sourceText.trimStart(), rule.id).not.toMatch(forbiddenMetadata);
      expect(rule.instruction, rule.id).not.toMatch(/^Research date:|^Audience:|^Evidence key:/iu);
    }
    expect(readFileSync(libraryPath, "utf8")).not.toMatch(/research\/\d{2}-[^)]+\.md#L\d+/u);
  });

  it("has unique IDs, strict nonblank fields, nonempty checks, and HTTPS sources", () => {
    const ids = catalog.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of catalog.rules) {
      const strings = [rule.id, rule.category, rule.topic, rule.instruction, rule.rationale, rule.applicability,
        rule.missingInputAction, rule.vendorScope, rule.dossierPath, rule.dossierHeading, rule.headingAnchor,
        rule.sourceText, rule.articleUrl];
      for (const value of strings) expect(value.trim().length, rule.id).toBeGreaterThan(0);
      expectNonBlankArray(rule.tags);
      expectNonBlankArray(rule.requiredInputs);
      expectNonBlankArray(rule.checks);
      expectNonBlankArray(rule.exceptions);
      expectNonBlankArray(rule.primarySourceUrls);
      for (const source of [rule.articleUrl, ...rule.primarySourceUrls]) {
        expect(new URL(source).protocol, `${rule.id}: ${source}`).toBe("https:");
      }
      expect(rule.missingInputAction, rule.id).toMatch(/return UNKNOWN|blocked\/stop/iu);
      expect(rule.missingInputAction, rule.id).toMatch(/do not imply manufacturing.*release approval/iu);
    }
  });

  it("semantically spot-checks at least ten deterministic rules per dossier", () => {
    for (const dossier of catalog.sourceDossiers) {
      const topicRules = catalog.rules.filter((rule) => rule.topic === dossier.slug);
      const sample = topicRules.filter((_, index) => index % Math.max(1, Math.floor(topicRules.length / 10)) === 0).slice(0, 10);
      expect(sample, dossier.slug).toHaveLength(10);
      for (const rule of sample) {
        const instructionTokens = semanticTokens(rule.instruction);
        const sourceTokens = new Set(semanticTokens(rule.sourceText));
        const overlap = instructionTokens.filter((token) => sourceTokens.has(token));
        expect(overlap.length, `${rule.id}: ${instructionTokens.join(",")}`).toBeGreaterThanOrEqual(Math.min(3, instructionTokens.length));
      }
    }
  });

  it("rejects malformed catalogs instead of partially accepting them", () => {
    expect(() => validateDeepRuleCatalog({ schemaVersion: 1, sourceDossiers: [], rules: [] })).toThrow(/17 source dossiers/iu);
  });

  it("requires explicit scope and selects by topic aliases, tags, and IDs", () => {
    expect(() => selectDeepRules(catalog, {})).toThrow(/explicit topic, tag, ID/iu);
    const differential = selectDeepRules(catalog, { topics: ["07"] });
    expect(differential.length).toBeGreaterThan(0);
    expect(differential.every((rule) => rule.topic === "differential-pairs")).toBe(true);
    const pdn = selectDeepRules(catalog, { tags: ["pdn"], limit: 250 });
    expect(pdn.length).toBeGreaterThan(0);
    expect(pdn.every((rule) => rule.tags.includes("pdn"))).toBe(true);
    const picked = selectDeepRules(catalog, { ids: [catalog.rules[0]?.id ?? "missing"] });
    expect(picked.map((rule) => rule.id)).toEqual([catalog.rules[0]?.id]);
  });

  it("renders bounded excerpts while retaining every included rule ID and valid heading link", () => {
    const shortest = [...catalog.rules].sort((left, right) => left.instruction.length - right.instruction.length).slice(0, 2) as DeepPcbRule[];
    const prompt = renderDeepRulePrompt(catalog, { selector: { ids: shortest.map((rule) => rule.id) }, maxChars: 3_000, maxRules: 2 });
    expect(prompt.length).toBeLessThanOrEqual(3_000);
    expect(prompt).toContain(DEEP_RULE_RELEASE_BOUNDARY);
    for (const rule of shortest) {
      expect(prompt).toContain(`[${rule.id}]`);
      expect(prompt).toContain(rule.articleUrl);
      expect(prompt).toContain(`${rule.dossierPath}#${rule.headingAnchor}`);
      expect(prompt).toContain(`lines ${rule.dossierLineStart}-${rule.dossierLineEnd}`);
    }
  });

  it("states that selection is not manufacturing or release authorization", () => {
    expect(catalog.disclaimer).toMatch(/does not authorize fabrication, manufacturing, ordering, compliance, safety, qualification, or release/iu);
    const prompt = renderDeepRulePrompt(catalog, { selector: { topics: ["dfm"] }, maxChars: 1_200 });
    expect(prompt).toContain(DEEP_RULE_RELEASE_BOUNDARY);
    expect(prompt).not.toMatch(/this (?:board|design) is (?:manufacturing-ready|released|compliant)/iu);
  });
});

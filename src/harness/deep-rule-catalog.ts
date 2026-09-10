import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type DeepRuleSeverity = "advisory" | "warning" | "error" | "critical";

export interface DeepRuleSourceDossier {
  readonly number: string;
  readonly slug: string;
  readonly topic: string;
  readonly dossierPath: string;
  readonly articleTitle: string;
  readonly articleUrl: string;
  readonly scope: string;
  readonly majorDecisionInputs: readonly string[];
  readonly dependencies: readonly string[];
  readonly tags: readonly string[];
  readonly sha256: string;
  readonly lineCount: number;
  readonly ruleCount: number;
}

export interface DeepPcbRule {
  readonly id: string;
  readonly category: string;
  readonly topic: string;
  readonly tags: readonly string[];
  readonly instruction: string;
  readonly rationale: string;
  readonly applicability: string;
  readonly requiredInputs: readonly string[];
  readonly checks: readonly string[];
  readonly missingInputAction: string;
  readonly exceptions: readonly string[];
  readonly severity: DeepRuleSeverity;
  readonly vendorScope: string;
  readonly dossierPath: string;
  readonly dossierHeading: string;
  readonly headingAnchor: string;
  readonly dossierLineStart: number;
  readonly dossierLineEnd: number;
  readonly sourceText: string;
  readonly articleUrl: string;
  readonly primarySourceUrls: readonly string[];
}

export interface DeepRuleCatalog {
  readonly schemaVersion: 1;
  readonly generatedFrom: string;
  readonly disclaimer: string;
  readonly sourceDossiers: readonly DeepRuleSourceDossier[];
  readonly rules: readonly DeepPcbRule[];
}

export interface DeepRuleSelector {
  /** Exact topic slug, human topic name, or dossier number. */
  readonly topics?: readonly string[];
  /** At least one requested tag must match. */
  readonly tags?: readonly string[];
  /** Exact stable rule IDs. */
  readonly ids?: readonly string[];
  readonly categories?: readonly string[];
  readonly severities?: readonly DeepRuleSeverity[];
  /** Selection cap before prompt rendering. Hard-capped at 250. */
  readonly limit?: number;
}

export interface DeepRulePromptOptions {
  readonly selector: DeepRuleSelector;
  readonly maxChars?: number;
  /** Prompt cap after selection. Hard-capped at 40; defaults to 12. */
  readonly maxRules?: number;
}

export const DEEP_RULE_RESOURCE_MANIFEST_SCHEMA_VERSION =
  "evleda.deep-pcb-rule-resource-manifest.v1" as const;
export const PACKAGED_DEEP_RULE_RESOURCE_IDENTITY =
  "sha256:e3c7e2b0653c61d56125ce2d8aa7967a77a9446c941a86c8ca4b87d0d9c6698b" as const;
export const PACKAGED_DEEP_RULE_RESOURCE_MANIFEST_SHA256 =
  "5cab3b1dcca8eaa284bf21dd0d4007aafbecf8c162de723608ef5a8cfc1e2cd9" as const;
export const PACKAGED_DEEP_RULE_CATALOG_SHA256 =
  "351a484ddd0914dc1cc7672a9804ad18c1402ec81345df7cab308822ba3b76b9" as const;
export const DEEP_RULE_RESOURCE_RELATIVE_DIRECTORY = "resources/deep-pcb-rule-corpus/v1" as const;

const RESOURCE_MANIFEST_FILENAME = "resource-manifest.json";
const CATALOG_RELATIVE_PATH = "docs/pcb-design-guides/rule-catalog.json";
const SOURCE_INDEX_RELATIVE_PATH = "docs/pcb-design-guides/README.md";
const RESOURCE_IDENTITY_ALGORITHM =
  "sha256 of RFC-8785-compatible canonical JSON for {catalog,corpusId,files,schemaVersion}";
const EXPECTED_CORPUS_ID = "evleda.deep-pcb-rule-corpus.2026-09-06";
const EXPECTED_RULE_COUNT = 1_773;
const EXPECTED_DOSSIER_COUNT = 17;
const MAX_SELECTED_RULES = 250;
const MAX_RENDERED_RULES = 40;
const DEFAULT_RENDERED_RULES = 12;
const MAX_PROMPT_CHARS = 8_000;
const MIN_PROMPT_CHARS = 320;
const RELEASE_BOUNDARY =
  "Deep-rule excerpts are review guidance only; they do not authorize fabrication, manufacturing, ordering, compliance, safety, qualification, or release.";

export interface DeepRuleResourceProfile {
  readonly schemaVersion: "evleda.deep-pcb-rule-resource-profile.v1";
  /** Absolute or caller-resolved root containing resource-manifest.json. */
  readonly resourceDirectory: string;
  /** Immutable corpus identity selected by application composition. */
  readonly expectedResourceIdentity: string;
}

export interface VerifiedDeepRuleResource {
  readonly catalog: DeepRuleCatalog;
  readonly profile: DeepRuleResourceProfile;
  readonly resourceIdentity: string;
  readonly catalogSha256: string;
  readonly manifestPath: string;
  readonly catalogPath: string;
}

type DeepRuleResourceFileRole =
  | "resource-notice"
  | "source-index"
  | "retrieval-library"
  | "source-dossier"
  | "rule-catalog"
  | "catalog-generator";

interface DeepRuleResourceFile {
  readonly path: string;
  readonly role: DeepRuleResourceFileRole;
  readonly sha256: string;
  readonly byteLength: number;
}

interface DeepRuleResourceManifestCatalog {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly schemaVersion: 1;
  readonly ruleCount: number;
  readonly sourceDossierCount: number;
}

interface DeepRuleResourceManifest {
  readonly schemaVersion: typeof DEEP_RULE_RESOURCE_MANIFEST_SCHEMA_VERSION;
  readonly corpusId: string;
  readonly catalog: DeepRuleResourceManifestCatalog;
  readonly files: readonly DeepRuleResourceFile[];
  readonly identityAlgorithm: string;
  readonly resourceIdentity: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const sha256Bytes = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const ordinalCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const canonicalPathKey = (value: string): string => {
  const normalized = resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const sameCanonicalPath = (left: string, right: string): boolean =>
  canonicalPathKey(left) === canonicalPathKey(right);

const safeResourceRelativePath = (value: unknown, path: string): string => {
  const text = nonBlank(value, path);
  if (
    text.includes("\\")
    || text.startsWith("/")
    || /^[A-Za-z]:/u.test(text)
    || text.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${path} must be a normalized relative POSIX path`);
  }
  return text;
};

const sha256Hex = (value: unknown, path: string): string => {
  const text = nonBlank(value, path);
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(`${path} must be lowercase SHA-256 hex`);
  return text;
};

const nonNegativeInteger = (value: unknown, path: string): number => {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${path} must be a non-negative integer`);
  return value as number;
};

const nonBlank = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-blank string`);
  return value;
};

const positiveInteger = (value: unknown, path: string): number => {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${path} must be a positive integer`);
  return value as number;
};

const stringArray = (value: unknown, path: string, allowEmpty = false): readonly string[] => {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${path} must be a non-empty array`);
  return value.map((item, index) => nonBlank(item, `${path}[${index}]`));
};

const httpsUrl = (value: unknown, path: string): string => {
  const text = nonBlank(value, path);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new Error(`${path} must be an absolute URL`, { cause: error });
  }
  if (parsed.protocol !== "https:") throw new Error(`${path} must use https`);
  return text;
};

const validateDossier = (value: unknown, index: number): DeepRuleSourceDossier => {
  const path = `sourceDossiers[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const sha256 = nonBlank(value.sha256, `${path}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`${path}.sha256 must be lowercase SHA-256 hex`);
  return {
    number: nonBlank(value.number, `${path}.number`),
    slug: nonBlank(value.slug, `${path}.slug`),
    topic: nonBlank(value.topic, `${path}.topic`),
    dossierPath: nonBlank(value.dossierPath, `${path}.dossierPath`),
    articleTitle: nonBlank(value.articleTitle, `${path}.articleTitle`),
    articleUrl: httpsUrl(value.articleUrl, `${path}.articleUrl`),
    scope: nonBlank(value.scope, `${path}.scope`),
    majorDecisionInputs: stringArray(value.majorDecisionInputs, `${path}.majorDecisionInputs`),
    dependencies: stringArray(value.dependencies, `${path}.dependencies`, true),
    tags: stringArray(value.tags, `${path}.tags`),
    sha256,
    lineCount: positiveInteger(value.lineCount, `${path}.lineCount`),
    ruleCount: positiveInteger(value.ruleCount, `${path}.ruleCount`)
  };
};

const validateRule = (value: unknown, index: number): DeepPcbRule => {
  const path = `rules[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const severity = nonBlank(value.severity, `${path}.severity`);
  if (!(severity === "advisory" || severity === "warning" || severity === "error" || severity === "critical")) {
    throw new Error(`${path}.severity is invalid`);
  }
  return {
    id: nonBlank(value.id, `${path}.id`),
    category: nonBlank(value.category, `${path}.category`),
    topic: nonBlank(value.topic, `${path}.topic`),
    tags: stringArray(value.tags, `${path}.tags`),
    instruction: nonBlank(value.instruction, `${path}.instruction`),
    rationale: nonBlank(value.rationale, `${path}.rationale`),
    applicability: nonBlank(value.applicability, `${path}.applicability`),
    requiredInputs: stringArray(value.requiredInputs, `${path}.requiredInputs`),
    checks: stringArray(value.checks, `${path}.checks`),
    missingInputAction: nonBlank(value.missingInputAction, `${path}.missingInputAction`),
    exceptions: stringArray(value.exceptions, `${path}.exceptions`),
    severity,
    vendorScope: nonBlank(value.vendorScope, `${path}.vendorScope`),
    dossierPath: nonBlank(value.dossierPath, `${path}.dossierPath`),
    dossierHeading: nonBlank(value.dossierHeading, `${path}.dossierHeading`),
    headingAnchor: nonBlank(value.headingAnchor, `${path}.headingAnchor`),
    dossierLineStart: positiveInteger(value.dossierLineStart, `${path}.dossierLineStart`),
    dossierLineEnd: positiveInteger(value.dossierLineEnd, `${path}.dossierLineEnd`),
    sourceText: nonBlank(value.sourceText, `${path}.sourceText`),
    articleUrl: httpsUrl(value.articleUrl, `${path}.articleUrl`),
    primarySourceUrls: stringArray(value.primarySourceUrls, `${path}.primarySourceUrls`).map((url, urlIndex) =>
      httpsUrl(url, `${path}.primarySourceUrls[${urlIndex}]`)
    )
  };
};

/** Strictly validates the checked-in JSON before any rule is used. */
export function validateDeepRuleCatalog(value: unknown): DeepRuleCatalog {
  if (!isRecord(value)) throw new Error("Deep rule catalog must be an object");
  if (value.schemaVersion !== 1) throw new Error("Deep rule catalog schemaVersion must be 1");
  if (!Array.isArray(value.sourceDossiers) || value.sourceDossiers.length !== 17) {
    throw new Error("Deep rule catalog must contain exactly 17 source dossiers");
  }
  if (!Array.isArray(value.rules) || value.rules.length === 0) throw new Error("Deep rule catalog rules must be non-empty");

  const sourceDossiers = value.sourceDossiers.map(validateDossier);
  const rules = value.rules.map(validateRule);
  const ids = new Set<string>();
  const dossiersBySlug = new Map(sourceDossiers.map((dossier) => [dossier.slug, dossier]));
  const actualCounts = new Map<string, number>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate deep rule ID: ${rule.id}`);
    ids.add(rule.id);
    const dossier = dossiersBySlug.get(rule.topic);
    if (!dossier) throw new Error(`${rule.id} references unknown topic ${rule.topic}`);
    if (rule.dossierPath !== dossier.dossierPath) throw new Error(`${rule.id} dossierPath does not match its topic manifest`);
    if (rule.articleUrl !== dossier.articleUrl) throw new Error(`${rule.id} articleUrl does not match its topic manifest`);
    if (rule.dossierLineEnd < rule.dossierLineStart) throw new Error(`${rule.id} has an inverted dossier line span`);
    if (rule.dossierLineEnd > dossier.lineCount) throw new Error(`${rule.id} dossier line span exceeds the source line count`);
    actualCounts.set(rule.topic, (actualCounts.get(rule.topic) ?? 0) + 1);
  }
  for (const dossier of sourceDossiers) {
    if ((actualCounts.get(dossier.slug) ?? 0) !== dossier.ruleCount) {
      throw new Error(`${dossier.slug} declared ruleCount does not match catalog rules`);
    }
  }

  return {
    schemaVersion: 1,
    generatedFrom: nonBlank(value.generatedFrom, "generatedFrom"),
    disclaimer: nonBlank(value.disclaimer, "disclaimer"),
    sourceDossiers,
    rules
  };
}

const validateResourceFile = (value: unknown, index: number): DeepRuleResourceFile => {
  const path = `files[${index}]`;
  if (!isRecord(value) || !hasExactKeys(value, ["path", "role", "sha256", "byteLength"])) {
    throw new Error(`${path} must contain exactly path, role, sha256, and byteLength`);
  }
  const role = nonBlank(value.role, `${path}.role`);
  if (![
    "resource-notice",
    "source-index",
    "retrieval-library",
    "source-dossier",
    "rule-catalog",
    "catalog-generator"
  ].includes(role)) {
    throw new Error(`${path}.role is invalid`);
  }
  return {
    path: safeResourceRelativePath(value.path, `${path}.path`),
    role: role as DeepRuleResourceFileRole,
    sha256: sha256Hex(value.sha256, `${path}.sha256`),
    byteLength: nonNegativeInteger(value.byteLength, `${path}.byteLength`)
  };
};

const validateResourceManifest = (value: unknown): DeepRuleResourceManifest => {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "corpusId",
    "catalog",
    "files",
    "identityAlgorithm",
    "resourceIdentity"
  ])) {
    throw new Error("Deep-rule resource manifest has unexpected or missing fields");
  }
  if (value.schemaVersion !== DEEP_RULE_RESOURCE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Deep-rule resource manifest schemaVersion must be ${DEEP_RULE_RESOURCE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (value.corpusId !== EXPECTED_CORPUS_ID) throw new Error(`Deep-rule resource corpusId must be ${EXPECTED_CORPUS_ID}`);
  if (!isRecord(value.catalog) || !hasExactKeys(value.catalog, [
    "path",
    "sha256",
    "byteLength",
    "schemaVersion",
    "ruleCount",
    "sourceDossierCount"
  ])) {
    throw new Error("Deep-rule resource manifest catalog record is invalid");
  }
  const catalog: DeepRuleResourceManifestCatalog = {
    path: safeResourceRelativePath(value.catalog.path, "catalog.path"),
    sha256: sha256Hex(value.catalog.sha256, "catalog.sha256"),
    byteLength: nonNegativeInteger(value.catalog.byteLength, "catalog.byteLength"),
    schemaVersion: value.catalog.schemaVersion === 1 ? 1 : (() => { throw new Error("catalog.schemaVersion must be 1"); })(),
    ruleCount: positiveInteger(value.catalog.ruleCount, "catalog.ruleCount"),
    sourceDossierCount: positiveInteger(value.catalog.sourceDossierCount, "catalog.sourceDossierCount")
  };
  if (catalog.path !== CATALOG_RELATIVE_PATH) throw new Error(`Deep-rule catalog path must be ${CATALOG_RELATIVE_PATH}`);
  if (catalog.sha256 !== PACKAGED_DEEP_RULE_CATALOG_SHA256) throw new Error("Deep-rule catalog SHA-256 is not the packaged catalog identity");
  if (catalog.ruleCount !== EXPECTED_RULE_COUNT || catalog.sourceDossierCount !== EXPECTED_DOSSIER_COUNT) {
    throw new Error(`Deep-rule resource manifest must bind ${EXPECTED_RULE_COUNT} rules and ${EXPECTED_DOSSIER_COUNT} dossiers`);
  }
  if (!Array.isArray(value.files)) throw new Error("Deep-rule resource manifest files must be an array");
  const files = value.files.map(validateResourceFile);
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new Error("Deep-rule resource manifest contains duplicate paths");
  if (paths.some((path, index) => index > 0 && ordinalCompare(paths[index - 1]!, path) >= 0)) {
    throw new Error("Deep-rule resource manifest files must be strictly path-sorted");
  }
  const roleCounts = new Map<DeepRuleResourceFileRole, number>();
  for (const file of files) roleCounts.set(file.role, (roleCounts.get(file.role) ?? 0) + 1);
  const expectedRoleCounts = new Map<DeepRuleResourceFileRole, number>([
    ["resource-notice", 1],
    ["source-index", 1],
    ["retrieval-library", 1],
    ["source-dossier", EXPECTED_DOSSIER_COUNT],
    ["rule-catalog", 1],
    ["catalog-generator", 1]
  ]);
  for (const [role, count] of expectedRoleCounts) {
    if ((roleCounts.get(role) ?? 0) !== count) throw new Error(`Deep-rule resource manifest must contain ${count} ${role} file(s)`);
  }
  if (roleCounts.size !== expectedRoleCounts.size) throw new Error("Deep-rule resource manifest contains unexpected file roles");
  const catalogFile = files.find((file) => file.role === "rule-catalog");
  if (
    catalogFile === undefined
    || catalogFile.path !== catalog.path
    || catalogFile.sha256 !== catalog.sha256
    || catalogFile.byteLength !== catalog.byteLength
  ) {
    throw new Error("Deep-rule resource manifest catalog metadata does not match its file record");
  }
  const identityAlgorithm = nonBlank(value.identityAlgorithm, "identityAlgorithm");
  if (identityAlgorithm !== RESOURCE_IDENTITY_ALGORITHM) throw new Error("Deep-rule resource identity algorithm is unsupported");
  const resourceIdentity = nonBlank(value.resourceIdentity, "resourceIdentity");
  if (!/^sha256:[a-f0-9]{64}$/u.test(resourceIdentity)) throw new Error("Deep-rule resource identity is invalid");
  const identityPayload = {
    schemaVersion: DEEP_RULE_RESOURCE_MANIFEST_SCHEMA_VERSION,
    corpusId: EXPECTED_CORPUS_ID,
    catalog,
    files
  };
  const computedIdentity = `sha256:${sha256Bytes(canonicalJson(identityPayload))}`;
  if (resourceIdentity !== computedIdentity) throw new Error("Deep-rule resource manifest identity does not match its contents");
  return {
    schemaVersion: DEEP_RULE_RESOURCE_MANIFEST_SCHEMA_VERSION,
    corpusId: EXPECTED_CORPUS_ID,
    catalog,
    files,
    identityAlgorithm,
    resourceIdentity
  };
};

const resourcePath = (resourceDirectory: string, relativePath: string): string => {
  const candidate = resolve(resourceDirectory, ...relativePath.split("/"));
  const back = relative(resourceDirectory, candidate);
  if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`Deep-rule resource path escapes its profile root: ${relativePath}`);
  }
  return candidate;
};

const assertCanonicalOrdinaryEntry = (
  absolutePath: string,
  relativePath: string,
  kind: "directory" | "file"
): void => {
  let before;
  let canonical;
  try {
    before = lstatSync(absolutePath);
    canonical = realpathSync.native(absolutePath);
  } catch (error) {
    throw new Error(`Unable to inspect required deep-rule resource ${relativePath} at ${absolutePath}`, { cause: error });
  }
  const expectedKind = kind === "directory" ? before.isDirectory() : before.isFile();
  if (!expectedKind || before.isSymbolicLink() || !sameCanonicalPath(canonical, absolutePath)) {
    throw new Error(`Deep-rule resource ${relativePath} must be a canonical ordinary ${kind}, not a link, junction, or reparse path`);
  }
  const after = lstatSync(canonical);
  const sameKind = kind === "directory" ? after.isDirectory() : after.isFile();
  if (
    !sameKind
    || after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
  ) {
    throw new Error(`Deep-rule resource ${relativePath} changed while its canonical ${kind} binding was checked`);
  }
};

const assertCanonicalResourceRoot = (resourceDirectory: string): void =>
  assertCanonicalOrdinaryEntry(resourceDirectory, "root", "directory");

const readResourceFile = (resourceDirectory: string, relativePath: string): Buffer => {
  const absolutePath = resourcePath(resourceDirectory, relativePath);
  try {
    assertCanonicalOrdinaryEntry(absolutePath, relativePath, "file");
    return readFileSync(absolutePath);
  } catch (error) {
    throw new Error(`Unable to read required deep-rule resource ${relativePath} at ${absolutePath}`, { cause: error });
  }
};

interface DeepRuleResourceTree {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

const enumerateResourceTree = (resourceDirectory: string): DeepRuleResourceTree => {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to enumerate deep-rule resource directory ${resourceDirectory}`, { cause: error });
    }
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Deep-rule resource must not contain links, junctions, or reparse paths: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        assertCanonicalOrdinaryEntry(absolutePath, relativePath, "directory");
        directories.push(relativePath);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        assertCanonicalOrdinaryEntry(absolutePath, relativePath, "file");
        files.push(relativePath);
      } else throw new Error(`Deep-rule resource contains a non-regular entry: ${relativePath}`);
    }
  };
  visit(resourceDirectory, "");
  return {
    files: files.sort(ordinalCompare),
    directories: directories.sort(ordinalCompare)
  };
};

const directoryClosure = (paths: readonly string[]): readonly string[] => {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    while (segments.length > 0) {
      directories.add(segments.join("/"));
      segments.pop();
    }
  }
  return [...directories].sort(ordinalCompare);
};

const exactPathSet = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((path, index) => path === expected[index]);

const stripHeadingMarkdown = (value: string): string => value
  .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/gu, "$1 ($2)")
  .replace(/\*\*([^*]+)\*\*/gu, "$1")
  .replace(/\s+/gu, " ").trim();

const gfmAnchorBase = (heading: string): string => stripHeadingMarkdown(heading)
  .toLowerCase()
  .replace(/<[^>]*>/gu, "")
  .replace(/[^\p{L}\p{N}\s_-]/gu, "")
  .replace(/\s/gu, "-");

const headingsFor = (source: string): ReadonlyMap<string, string> => {
  const anchors = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^#{1,6}\s+(.+)$/u);
    if (match?.[1] === undefined) continue;
    const text = stripHeadingMarkdown(match[1]);
    const base = gfmAnchorBase(match[1]);
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    anchors.set(duplicate === 0 ? base : `${base}-${duplicate}`, text);
  }
  return anchors;
};

const validateResourceProvenance = (
  catalog: DeepRuleCatalog,
  manifest: DeepRuleResourceManifest,
  contents: ReadonlyMap<string, Buffer>
): void => {
  if (catalog.rules.length !== manifest.catalog.ruleCount) {
    throw new Error("Deep-rule catalog rule count does not match the resource manifest");
  }
  if (catalog.sourceDossiers.length !== manifest.catalog.sourceDossierCount) {
    throw new Error("Deep-rule catalog dossier count does not match the resource manifest");
  }
  const dossierFiles = new Map(manifest.files.filter((file) => file.role === "source-dossier").map((file) => [file.path, file]));
  const sources = new Map<string, { readonly lines: readonly string[]; readonly headings: ReadonlyMap<string, string> }>();
  for (const dossier of catalog.sourceDossiers) {
    const file = dossierFiles.get(dossier.dossierPath);
    if (file === undefined) throw new Error(`Deep-rule dossier is not bound by the resource manifest: ${dossier.dossierPath}`);
    if (file.sha256 !== dossier.sha256) throw new Error(`Deep-rule dossier manifest hash differs from catalog: ${dossier.dossierPath}`);
    const bytes = contents.get(dossier.dossierPath);
    if (bytes === undefined) throw new Error(`Deep-rule dossier bytes are unavailable: ${dossier.dossierPath}`);
    const source = bytes.toString("utf8");
    const lines = source.split(/\r?\n/u);
    if (lines.length !== dossier.lineCount) throw new Error(`Deep-rule dossier line count drifted: ${dossier.dossierPath}`);
    sources.set(dossier.dossierPath, { lines, headings: headingsFor(source) });
  }
  for (const rule of catalog.rules) {
    const source = sources.get(rule.dossierPath);
    if (source === undefined) throw new Error(`${rule.id} has no verified dossier source`);
    const exactSpan = source.lines.slice(rule.dossierLineStart - 1, rule.dossierLineEnd).join("\n");
    if (rule.sourceText !== exactSpan) throw new Error(`${rule.id} source span does not match its verified dossier bytes`);
    if (source.headings.get(rule.headingAnchor) !== rule.dossierHeading) {
      throw new Error(`${rule.id} heading anchor does not resolve to its declared dossier heading`);
    }
  }
  const readme = contents.get(SOURCE_INDEX_RELATIVE_PATH)?.toString("utf8");
  if (readme === undefined) throw new Error("Deep-rule source index is unavailable");
  for (const dossier of catalog.sourceDossiers) {
    const indexPath = dossier.dossierPath.replace("docs/pcb-design-guides/", "");
    if (!readme.includes(indexPath) || !readme.includes(dossier.articleUrl) || !readme.includes(dossier.sha256)) {
      throw new Error(`Deep-rule source index does not retain provenance for ${dossier.slug}`);
    }
  }
};

/** Resolves only from the installed source/dist module tree, never process.cwd(). */
export function resolvePackagedDeepRuleResourceDirectory(moduleUrl: string | URL = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  return resolve(moduleDirectory, "..", "..", ...DEEP_RULE_RESOURCE_RELATIVE_DIRECTORY.split("/"));
}

/** Creates the explicit path + immutable identity binding used by application composition. */
export function createDeepRuleResourceProfile(
  resourceDirectory: string,
  expectedResourceIdentity: string = PACKAGED_DEEP_RULE_RESOURCE_IDENTITY
): DeepRuleResourceProfile {
  const directory = nonBlank(resourceDirectory, "resourceDirectory");
  const identity = nonBlank(expectedResourceIdentity, "expectedResourceIdentity");
  if (!isAbsolute(directory)) throw new Error("Deep-rule resourceDirectory must be an absolute profile-bound path");
  if (!/^sha256:[a-f0-9]{64}$/u.test(identity)) throw new Error("Deep-rule expectedResourceIdentity must be sha256:<lowercase hex>");
  return Object.freeze({
    schemaVersion: "evleda.deep-pcb-rule-resource-profile.v1",
    resourceDirectory: resolve(directory),
    expectedResourceIdentity: identity
  });
}

/** Returns the deterministic resource profile adjacent to this source or installed dist module. */
export function createPackagedDeepRuleResourceProfile(moduleUrl: string | URL = import.meta.url): DeepRuleResourceProfile {
  return createDeepRuleResourceProfile(resolvePackagedDeepRuleResourceDirectory(moduleUrl));
}

const validateResourceProfile = (value: DeepRuleResourceProfile): DeepRuleResourceProfile => {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "resourceDirectory", "expectedResourceIdentity"])) {
    throw new Error("Deep-rule resource profile has unexpected or missing fields");
  }
  if (value.schemaVersion !== "evleda.deep-pcb-rule-resource-profile.v1") {
    throw new Error("Deep-rule resource profile schemaVersion is invalid");
  }
  return createDeepRuleResourceProfile(value.resourceDirectory, value.expectedResourceIdentity);
};

/** Loads and fully provenance-verifies one identity-bound resource tree. */
export function loadDeepRuleResource(
  profileInput: DeepRuleResourceProfile = createPackagedDeepRuleResourceProfile()
): VerifiedDeepRuleResource {
  const profile = validateResourceProfile(profileInput);
  assertCanonicalResourceRoot(profile.resourceDirectory);
  let manifestValue: unknown;
  const manifestBytes = readResourceFile(profile.resourceDirectory, RESOURCE_MANIFEST_FILENAME);
  if (sha256Bytes(manifestBytes) !== PACKAGED_DEEP_RULE_RESOURCE_MANIFEST_SHA256) {
    throw new Error("Deep-rule resource manifest SHA-256 drifted");
  }
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse deep-rule resource manifest at ${profile.resourceDirectory}`, { cause: error });
  }
  const manifest = validateResourceManifest(manifestValue);
  if (manifest.resourceIdentity !== profile.expectedResourceIdentity) {
    throw new Error(`Deep-rule resource identity mismatch: expected ${profile.expectedResourceIdentity}, received ${manifest.resourceIdentity}`);
  }
  const expectedFiles = [...manifest.files.map((file) => file.path), RESOURCE_MANIFEST_FILENAME].sort(ordinalCompare);
  const expectedDirectories = directoryClosure(expectedFiles);
  const actualTree = enumerateResourceTree(profile.resourceDirectory);
  if (!exactPathSet(actualTree.files, expectedFiles) || !exactPathSet(actualTree.directories, expectedDirectories)) {
    throw new Error("Deep-rule resource tree contains missing, unexpected, or shadow files or directories");
  }
  const contents = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const bytes = readResourceFile(profile.resourceDirectory, file.path);
    if (bytes.byteLength !== file.byteLength) throw new Error(`Deep-rule resource byte length drifted: ${file.path}`);
    if (sha256Bytes(bytes) !== file.sha256) throw new Error(`Deep-rule resource SHA-256 drifted: ${file.path}`);
    contents.set(file.path, bytes);
  }
  const catalogBytes = contents.get(manifest.catalog.path);
  if (catalogBytes === undefined) throw new Error("Deep-rule catalog bytes are unavailable");
  let catalogValue: unknown;
  try {
    catalogValue = JSON.parse(catalogBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse verified deep-rule catalog at ${manifest.catalog.path}`, { cause: error });
  }
  const catalog = validateDeepRuleCatalog(catalogValue);
  validateResourceProvenance(catalog, manifest, contents);
  return Object.freeze({
    catalog,
    profile,
    resourceIdentity: manifest.resourceIdentity,
    catalogSha256: manifest.catalog.sha256,
    manifestPath: resourcePath(profile.resourceDirectory, RESOURCE_MANIFEST_FILENAME),
    catalogPath: resourcePath(profile.resourceDirectory, manifest.catalog.path)
  });
}

/** Convenience API for callers that need only the verified catalog value. */
export function loadDeepRuleCatalog(profile?: DeepRuleResourceProfile): DeepRuleCatalog {
  return profile === undefined ? loadDeepRuleResource().catalog : loadDeepRuleResource(profile).catalog;
}

const normalizedSet = (values: readonly string[] | undefined): ReadonlySet<string> =>
  new Set((values ?? []).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean));

const requireExplicitSelector = (selector: DeepRuleSelector): void => {
  const hasSelector = [selector.topics, selector.tags, selector.ids, selector.categories, selector.severities]
    .some((values) => (values?.length ?? 0) > 0);
  if (!hasSelector) throw new Error("Deep rules require an explicit topic, tag, ID, category, or severity selector");
};

/** Selects only explicitly scoped rules; an empty selector is rejected. */
export function selectDeepRules(catalog: DeepRuleCatalog, selector: DeepRuleSelector): readonly DeepPcbRule[] {
  requireExplicitSelector(selector);
  const topics = normalizedSet(selector.topics);
  const tags = normalizedSet(selector.tags);
  const ids = normalizedSet(selector.ids);
  const categories = normalizedSet(selector.categories);
  const severities = normalizedSet(selector.severities);
  const dossierAliases = new Map<string, string>();
  for (const dossier of catalog.sourceDossiers) {
    dossierAliases.set(dossier.slug.toLocaleLowerCase(), dossier.slug);
    dossierAliases.set(dossier.topic.toLocaleLowerCase(), dossier.slug);
    dossierAliases.set(dossier.number.toLocaleLowerCase(), dossier.slug);
  }
  const topicSlugs = new Set([...topics].map((topic) => dossierAliases.get(topic) ?? topic));
  const requestedLimit = selector.limit ?? MAX_SELECTED_RULES;
  const limit = Math.min(MAX_SELECTED_RULES, Math.max(1, Math.floor(requestedLimit)));

  return catalog.rules.filter((rule) => {
    if (topicSlugs.size > 0 && !topicSlugs.has(rule.topic)) return false;
    if (ids.size > 0 && !ids.has(rule.id.toLocaleLowerCase())) return false;
    if (categories.size > 0 && !categories.has(rule.category.toLocaleLowerCase())) return false;
    if (severities.size > 0 && !severities.has(rule.severity.toLocaleLowerCase())) return false;
    if (tags.size > 0 && !rule.tags.some((tag) => tags.has(tag.toLocaleLowerCase()))) return false;
    return true;
  }).slice(0, limit);
}

const compact = (value: string): string => value.replace(/\s+/gu, " ").trim();

/** Renders whole rule records only; instructions may be shortened, but IDs and links are retained. */
export function renderDeepRulePrompt(catalog: DeepRuleCatalog, options: DeepRulePromptOptions): string {
  const selected = selectDeepRules(catalog, options.selector);
  const requestedMax = options.maxChars ?? 4_000;
  const maxChars = Math.min(MAX_PROMPT_CHARS, Math.max(MIN_PROMPT_CHARS, Math.floor(requestedMax)));
  const requestedRuleCount = options.maxRules ?? DEFAULT_RENDERED_RULES;
  const maxRules = Math.min(MAX_RENDERED_RULES, Math.max(1, Math.floor(requestedRuleCount)));
  const candidates = selected.slice(0, maxRules);
  const header = `${RELEASE_BOUNDARY}\nSelected deep PCB rules (${selected.length} matched; at most ${maxRules} rendered):`;
  const footerFor = (included: number): string => {
    const omitted = selected.length - included;
    return omitted > 0 ? `\n${omitted} matched rules omitted by the bounded prompt; narrow the selector or request them separately.` : "";
  };
  const lines: string[] = [];
  for (const rule of candidates) {
    const source = `${rule.articleUrl} | ${rule.dossierPath}#${rule.headingAnchor} (lines ${rule.dossierLineStart}-${rule.dossierLineEnd})`;
    const fixed = `- [${rule.id}]  — source: ${source}`;
    const available = maxChars - header.length - footerFor(lines.length + 1).length - lines.join("\n").length - fixed.length - 2;
    if (available < 24) break;
    const instruction = compact(rule.instruction);
    const renderedInstruction = instruction.length <= available
      ? instruction
      : `${instruction.slice(0, Math.max(1, available - 12)).trimEnd()} [shortened]`;
    const candidate = `- [${rule.id}] ${renderedInstruction} — source: ${source}`;
    const body = [...lines, candidate].join("\n");
    if (`${header}\n${body}${footerFor(lines.length + 1)}`.length > maxChars) break;
    lines.push(candidate);
  }
  const footer = footerFor(lines.length);
  const empty = lines.length === 0 ? "\nNo complete rule record fit the requested bound; increase maxChars." : "";
  return `${header}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}${footer}${empty}`.slice(0, maxChars);
}

export const DEEP_RULE_RELEASE_BOUNDARY = RELEASE_BOUNDARY;

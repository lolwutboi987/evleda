#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEEP_RULE_RESOURCE_RELATIVE_DIRECTORY = "resources/deep-pcb-rule-corpus/v1";
export const DEEP_RULE_RESOURCE_IDENTITY =
  "sha256:e3c7e2b0653c61d56125ce2d8aa7967a77a9446c941a86c8ca4b87d0d9c6698b";
export const DEEP_RULE_RESOURCE_MANIFEST_SHA256 =
  "5cab3b1dcca8eaa284bf21dd0d4007aafbecf8c162de723608ef5a8cfc1e2cd9";
export const DEEP_RULE_CATALOG_SHA256 =
  "351a484ddd0914dc1cc7672a9804ad18c1402ec81345df7cab308822ba3b76b9";

const MANIFEST_SCHEMA = "evleda.deep-pcb-rule-resource-manifest.v1";
const CORPUS_ID = "evleda.deep-pcb-rule-corpus.2026-09-06";
const MANIFEST_NAME = "resource-manifest.json";
const CATALOG_PATH = "docs/pcb-design-guides/rule-catalog.json";
const INDEX_PATH = "docs/pcb-design-guides/README.md";
const IDENTITY_ALGORITHM =
  "sha256 of RFC-8785-compatible canonical JSON for {catalog,corpusId,files,schemaVersion}";
const EXPECTED_RULE_COUNT = 1_773;
const EXPECTED_DOSSIER_COUNT = 17;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const nodeVersion = process.versions.node.split(".").map(Number);
if ((nodeVersion[0] ?? 0) < 24 || ((nodeVersion[0] ?? 0) === 24 && (nodeVersion[1] ?? 0) < 19)) {
  throw new Error(`Node.js >=24.19.0 is required; received ${process.version}`);
}

const fail = (message) => { throw new Error(message); };
const record = (value, name) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
};
const exactKeys = (value, keys, name) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} has unexpected or missing fields`);
  }
};
const string = (value, name) => {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} must be a non-blank string`);
  return value;
};
const integer = (value, name, minimum = 0) => {
  if (!Number.isInteger(value) || value < minimum) fail(`${name} must be an integer >= ${minimum}`);
  return value;
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha256 = (value, name) => {
  const text = string(value, name);
  if (!/^[a-f0-9]{64}$/u.test(text)) fail(`${name} must be lowercase SHA-256 hex`);
  return text;
};
const ordinalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonicalPathKey = (value) => {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const sameCanonicalPath = (left, right) => canonicalPathKey(left) === canonicalPathKey(right);
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const relativeResourcePath = (value, name) => {
  const text = string(value, name);
  if (
    text.includes("\\")
    || text.startsWith("/")
    || /^[A-Za-z]:/u.test(text)
    || text.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${name} must be a normalized relative POSIX path`);
  }
  return text;
};
const inside = (directory, relativePath) => {
  const resolved = path.resolve(directory, ...relativePath.split("/"));
  const back = path.relative(directory, resolved);
  if (back === "" || back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    fail(`Resource path escapes its root: ${relativePath}`);
  }
  return resolved;
};

const assertCanonicalOrdinaryEntry = async (absolutePath, relativePath, kind) => {
  let before;
  let canonical;
  try {
    before = await lstat(absolutePath);
    canonical = await realpath(absolutePath);
  } catch (error) {
    throw new Error(`Unable to inspect required deep-rule resource ${relativePath} at ${absolutePath}`, { cause: error });
  }
  const expectedKind = kind === "directory" ? before.isDirectory() : before.isFile();
  if (!expectedKind || before.isSymbolicLink() || !sameCanonicalPath(canonical, absolutePath)) {
    fail(`Deep-rule resource ${relativePath} must be a canonical ordinary ${kind}, not a link, junction, or reparse path`);
  }
  const after = await lstat(canonical);
  const sameKind = kind === "directory" ? after.isDirectory() : after.isFile();
  if (!sameKind || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    fail(`Deep-rule resource ${relativePath} changed while its canonical ${kind} binding was checked`);
  }
};

const regularFile = async (directory, relativePath) => {
  const absolutePath = inside(directory, relativePath);
  try {
    await assertCanonicalOrdinaryEntry(absolutePath, relativePath, "file");
  } catch (error) {
    throw new Error(`Unable to read required deep-rule resource ${relativePath}`, { cause: error });
  }
  return readFile(absolutePath);
};

const enumerate = async (directory) => {
  const files = [];
  const directories = [];
  const visit = async (current, prefix) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to enumerate deep-rule resource directory ${directory}`, { cause: error });
    }
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = path.resolve(current, entry.name);
      if (entry.isSymbolicLink()) fail(`Deep-rule resource must not contain links, junctions, or reparse paths: ${relativePath}`);
      if (entry.isDirectory()) {
        await assertCanonicalOrdinaryEntry(absolutePath, relativePath, "directory");
        directories.push(relativePath);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        await assertCanonicalOrdinaryEntry(absolutePath, relativePath, "file");
        files.push(relativePath);
      } else fail(`Deep-rule resource contains a non-regular entry: ${relativePath}`);
    }
  };
  await visit(directory, "");
  return { files: files.sort(ordinalCompare), directories: directories.sort(ordinalCompare) };
};

const directoryClosure = (paths) => {
  const directories = new Set();
  for (const filePath of paths) {
    const segments = filePath.split("/");
    segments.pop();
    while (segments.length > 0) {
      directories.add(segments.join("/"));
      segments.pop();
    }
  }
  return [...directories].sort(ordinalCompare);
};
const exactPathSet = (actual, expected) =>
  actual.length === expected.length && actual.every((filePath, index) => filePath === expected[index]);

const parseManifest = (value) => {
  const manifest = record(value, "resource manifest");
  exactKeys(manifest, ["schemaVersion", "corpusId", "catalog", "files", "identityAlgorithm", "resourceIdentity"], "resource manifest");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) fail(`resource manifest schemaVersion must be ${MANIFEST_SCHEMA}`);
  if (manifest.corpusId !== CORPUS_ID) fail(`resource manifest corpusId must be ${CORPUS_ID}`);
  if (manifest.identityAlgorithm !== IDENTITY_ALGORITHM) fail("resource manifest identity algorithm is unsupported");

  const catalogInput = record(manifest.catalog, "resource manifest catalog");
  exactKeys(catalogInput, ["path", "sha256", "byteLength", "schemaVersion", "ruleCount", "sourceDossierCount"], "resource manifest catalog");
  const catalog = {
    path: relativeResourcePath(catalogInput.path, "catalog.path"),
    sha256: sha256(catalogInput.sha256, "catalog.sha256"),
    byteLength: integer(catalogInput.byteLength, "catalog.byteLength"),
    schemaVersion: integer(catalogInput.schemaVersion, "catalog.schemaVersion", 1),
    ruleCount: integer(catalogInput.ruleCount, "catalog.ruleCount", 1),
    sourceDossierCount: integer(catalogInput.sourceDossierCount, "catalog.sourceDossierCount", 1)
  };
  if (catalog.path !== CATALOG_PATH || catalog.schemaVersion !== 1) fail("resource manifest catalog binding is invalid");
  if (catalog.sha256 !== DEEP_RULE_CATALOG_SHA256) fail("resource manifest catalog SHA-256 is not the packaged catalog identity");
  if (catalog.ruleCount !== EXPECTED_RULE_COUNT || catalog.sourceDossierCount !== EXPECTED_DOSSIER_COUNT) {
    fail(`resource manifest must bind ${EXPECTED_RULE_COUNT} rules and ${EXPECTED_DOSSIER_COUNT} dossiers`);
  }

  if (!Array.isArray(manifest.files)) fail("resource manifest files must be an array");
  const roles = new Set(["resource-notice", "source-index", "retrieval-library", "source-dossier", "rule-catalog", "catalog-generator"]);
  const files = manifest.files.map((input, index) => {
    const file = record(input, `files[${index}]`);
    exactKeys(file, ["path", "role", "sha256", "byteLength"], `files[${index}]`);
    const role = string(file.role, `files[${index}].role`);
    if (!roles.has(role)) fail(`files[${index}].role is invalid`);
    return {
      path: relativeResourcePath(file.path, `files[${index}].path`),
      role,
      sha256: sha256(file.sha256, `files[${index}].sha256`),
      byteLength: integer(file.byteLength, `files[${index}].byteLength`)
    };
  });
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) fail("resource manifest contains duplicate file paths");
  if (paths.some((filePath, index) => index > 0 && ordinalCompare(paths[index - 1], filePath) >= 0)) {
    fail("resource manifest files must be strictly path-sorted");
  }
  const expectedRoleCounts = new Map([
    ["resource-notice", 1],
    ["source-index", 1],
    ["retrieval-library", 1],
    ["source-dossier", EXPECTED_DOSSIER_COUNT],
    ["rule-catalog", 1],
    ["catalog-generator", 1]
  ]);
  for (const [role, count] of expectedRoleCounts) {
    if (files.filter((file) => file.role === role).length !== count) fail(`resource manifest must contain ${count} ${role} file(s)`);
  }
  const catalogFile = files.find((file) => file.role === "rule-catalog");
  if (
    catalogFile?.path !== catalog.path
    || catalogFile?.sha256 !== catalog.sha256
    || catalogFile?.byteLength !== catalog.byteLength
  ) {
    fail("resource manifest catalog metadata differs from its file record");
  }
  const identityPayload = { schemaVersion: MANIFEST_SCHEMA, corpusId: CORPUS_ID, catalog, files };
  const computedIdentity = `sha256:${hash(canonicalJson(identityPayload))}`;
  if (manifest.resourceIdentity !== computedIdentity) fail("resource manifest identity does not match its contents");
  if (manifest.resourceIdentity !== DEEP_RULE_RESOURCE_IDENTITY) {
    fail(`resource identity drifted: expected ${DEEP_RULE_RESOURCE_IDENTITY}, received ${String(manifest.resourceIdentity)}`);
  }
  return { ...manifest, catalog, files };
};

const stripHeadingMarkdown = (value) => value
  .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/gu, "$1 ($2)")
  .replace(/\*\*([^*]+)\*\*/gu, "$1")
  .replace(/\s+/gu, " ").trim();
const gfmAnchorBase = (heading) => stripHeadingMarkdown(heading)
  .toLowerCase()
  .replace(/<[^>]*>/gu, "")
  .replace(/[^\p{L}\p{N}\s_-]/gu, "")
  .replace(/\s/gu, "-");
const headingsFor = (source) => {
  const anchors = new Map();
  const counts = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/u)?.[1];
    if (heading === undefined) continue;
    const base = gfmAnchorBase(heading);
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    anchors.set(duplicate === 0 ? base : `${base}-${duplicate}`, stripHeadingMarkdown(heading));
  }
  return anchors;
};

const verifyCatalogProvenance = (catalog, manifest, contents) => {
  const catalogRecord = record(catalog, "rule catalog");
  if (catalogRecord.schemaVersion !== 1) fail("rule catalog schemaVersion must be 1");
  if (!Array.isArray(catalogRecord.sourceDossiers) || catalogRecord.sourceDossiers.length !== EXPECTED_DOSSIER_COUNT) {
    fail(`rule catalog must contain exactly ${EXPECTED_DOSSIER_COUNT} source dossiers`);
  }
  if (!Array.isArray(catalogRecord.rules) || catalogRecord.rules.length !== EXPECTED_RULE_COUNT) {
    fail(`rule catalog must contain exactly ${EXPECTED_RULE_COUNT} rules`);
  }
  const dossierFiles = new Map(manifest.files.filter((file) => file.role === "source-dossier").map((file) => [file.path, file]));
  const dossierBySlug = new Map();
  const sources = new Map();
  const index = contents.get(INDEX_PATH)?.toString("utf8");
  if (index === undefined) fail("source index is missing");
  for (const [indexNumber, dossierInput] of catalogRecord.sourceDossiers.entries()) {
    const dossier = record(dossierInput, `sourceDossiers[${indexNumber}]`);
    const slug = string(dossier.slug, `sourceDossiers[${indexNumber}].slug`);
    const dossierPath = relativeResourcePath(dossier.dossierPath, `sourceDossiers[${indexNumber}].dossierPath`);
    const dossierHash = sha256(dossier.sha256, `sourceDossiers[${indexNumber}].sha256`);
    const lineCount = integer(dossier.lineCount, `sourceDossiers[${indexNumber}].lineCount`, 1);
    const ruleCount = integer(dossier.ruleCount, `sourceDossiers[${indexNumber}].ruleCount`, 1);
    const articleUrl = string(dossier.articleUrl, `sourceDossiers[${indexNumber}].articleUrl`);
    if (dossierBySlug.has(slug)) fail(`duplicate source dossier slug: ${slug}`);
    const file = dossierFiles.get(dossierPath);
    if (file === undefined || file.sha256 !== dossierHash) fail(`dossier hash is not exactly manifest-bound: ${dossierPath}`);
    const source = contents.get(dossierPath)?.toString("utf8");
    if (source === undefined) fail(`dossier bytes are missing: ${dossierPath}`);
    const lines = source.split(/\r?\n/u);
    if (lines.length !== lineCount) fail(`dossier line count drifted: ${dossierPath}`);
    if (!index.includes(dossierPath.replace("docs/pcb-design-guides/", "")) || !index.includes(articleUrl) || !index.includes(dossierHash)) {
      fail(`source index does not retain provenance for ${slug}`);
    }
    dossierBySlug.set(slug, { dossierPath, ruleCount });
    sources.set(dossierPath, { lines, headings: headingsFor(source) });
  }
  const ids = new Set();
  const actualRuleCounts = new Map();
  for (const [ruleIndex, ruleInput] of catalogRecord.rules.entries()) {
    const rule = record(ruleInput, `rules[${ruleIndex}]`);
    const id = string(rule.id, `rules[${ruleIndex}].id`);
    const topic = string(rule.topic, `${id}.topic`);
    const dossierPath = relativeResourcePath(rule.dossierPath, `${id}.dossierPath`);
    const source = sources.get(dossierPath);
    if (ids.has(id)) fail(`duplicate rule ID: ${id}`);
    ids.add(id);
    if (dossierBySlug.get(topic)?.dossierPath !== dossierPath || source === undefined) fail(`${id} references an unbound dossier`);
    const lineStart = integer(rule.dossierLineStart, `${id}.dossierLineStart`, 1);
    const lineEnd = integer(rule.dossierLineEnd, `${id}.dossierLineEnd`, 1);
    if (lineEnd < lineStart || lineEnd > source.lines.length) fail(`${id} has an invalid dossier line span`);
    const exactSpan = source.lines.slice(lineStart - 1, lineEnd).join("\n");
    if (rule.sourceText !== exactSpan) fail(`${id} sourceText differs from its exact dossier span`);
    const headingAnchor = string(rule.headingAnchor, `${id}.headingAnchor`);
    if (source.headings.get(headingAnchor) !== rule.dossierHeading) fail(`${id} heading anchor does not resolve exactly`);
    actualRuleCounts.set(topic, (actualRuleCounts.get(topic) ?? 0) + 1);
  }
  for (const [slug, dossier] of dossierBySlug) {
    if ((actualRuleCounts.get(slug) ?? 0) !== dossier.ruleCount) fail(`${slug} rule count differs from its dossier record`);
  }
};

export const sourceDeepRuleResourceDirectory = () =>
  path.resolve(root, ...DEEP_RULE_RESOURCE_RELATIVE_DIRECTORY.split("/"));
export const distDeepRuleResourceDirectory = () =>
  path.resolve(root, "dist", ...DEEP_RULE_RESOURCE_RELATIVE_DIRECTORY.split("/"));

export async function verifyDeepRuleResourceDirectory(resourceDirectory = sourceDeepRuleResourceDirectory()) {
  const directory = path.resolve(resourceDirectory);
  await assertCanonicalOrdinaryEntry(directory, "root", "directory");
  const manifestBytes = await regularFile(directory, MANIFEST_NAME);
  if (hash(manifestBytes) !== DEEP_RULE_RESOURCE_MANIFEST_SHA256) fail("deep-rule resource manifest SHA-256 drifted");
  let manifestValue;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to parse deep-rule resource manifest in ${directory}`, { cause: error });
  }
  const manifest = parseManifest(manifestValue);
  const expectedFiles = [...manifest.files.map((file) => file.path), MANIFEST_NAME].sort(ordinalCompare);
  const expectedDirectories = directoryClosure(expectedFiles);
  const actualTree = await enumerate(directory);
  if (!exactPathSet(actualTree.files, expectedFiles) || !exactPathSet(actualTree.directories, expectedDirectories)) {
    fail("deep-rule resource tree contains missing, unexpected, or shadow files or directories");
  }
  const contents = new Map();
  for (const file of manifest.files) {
    const bytes = await regularFile(directory, file.path);
    if (bytes.byteLength !== file.byteLength) fail(`deep-rule resource byte length drifted: ${file.path}`);
    if (hash(bytes) !== file.sha256) fail(`deep-rule resource SHA-256 drifted: ${file.path}`);
    contents.set(file.path, bytes);
  }
  const catalogBytes = contents.get(manifest.catalog.path);
  if (catalogBytes === undefined || hash(catalogBytes) !== manifest.catalog.sha256) fail("catalog bytes are not manifest-bound");
  let catalog;
  try {
    catalog = JSON.parse(catalogBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Unable to parse manifest-bound deep-rule catalog", { cause: error });
  }
  verifyCatalogProvenance(catalog, manifest, contents);
  return Object.freeze({
    resourceDirectory: directory,
    resourceIdentity: manifest.resourceIdentity,
    catalogSha256: manifest.catalog.sha256,
    ruleCount: catalog.rules.length,
    dossierCount: catalog.sourceDossiers.length,
    fileCount: manifest.files.length
  });
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const requested = process.argv.slice(2);
  let directory = sourceDeepRuleResourceDirectory();
  if (requested.length === 1 && requested[0] === "--dist") directory = distDeepRuleResourceDirectory();
  else if (requested.length !== 0) fail("Usage: node scripts/verify-deep-rule-resources.mjs [--dist]");
  try {
    const result = await verifyDeepRuleResourceDirectory(directory);
    console.log(`Verified deep-rule resource ${result.resourceIdentity}: ${result.ruleCount} rules, ${result.dossierCount} dossiers, ${result.fileCount} bound files.`);
  } catch (error) {
    console.error(`Deep-rule resource verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

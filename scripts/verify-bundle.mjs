#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_NAME = "bundle-manifest.json";
const MANIFEST_SCHEMA_V1 = "evleda.bundle-manifest.v1";
const MANIFEST_SCHEMA_V2 = "evleda.bundle-manifest.v2";
const MANIFEST_SCHEMA_V3 = "evleda.bundle-manifest.v3";
const CANONICALIZATION = "evleda-c14n-json-v1";
const LIVE_REGENERATION_POLICY_SCHEMA = "evleda.live-regeneration-policy.v1";
const REVISION_SCHEMA = "evleda.design-revision.v1";
const REVISION_RECORD_SCHEMA = "evleda.bundle-revision-record.v1";
const EVIDENCE_ROOT_SCHEMA = "evleda.evidence-root.v1";
const EVIDENCE_INVENTORY_SCHEMA = "evleda.bundle-evidence.v2";
const REVISION_RECORD_PATH = "provenance/revision.json";
const EVIDENCE_INVENTORY_PATH = "evidence/evidence.json";
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACTS = 10_000;
const MAX_EVIDENCE = 10_000;
const DIGEST = /^[0-9a-f]{64}$/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const ILLEGAL_WINDOWS_CHARS = /[<>:"|?*\u0000-\u001f]/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const STAGES = new Set([
  "requirements",
  "system_architecture",
  "component_selection",
  "schematic",
  "firmware_contract",
  "simulation_checks",
  "pcb_placement_routing",
  "manufacturing_package",
  "bringup_package"
]);
const VALIDATION_STATUSES = new Set([
  "pass",
  "fail",
  "error",
  "not_run",
  "unsupported",
  "stale",
  "revoked",
  "waived"
]);
const LIFECYCLES = new Set(["candidate", "qualified", "release_authorized"]);
const ADAPTERS = new Set(["evleda", "kicad_cli", "kicad_mcp", "external", "human"]);
const EVIDENCE_CLASSES = new Set(["agent_claim", "evleda_check", "kicad_native", "human_physical"]);
const GENERATED_ROLES = new Map([
  ["cover", { path: "COVER.svg", logicalName: "bundle/COVER.svg", mediaType: "image/svg+xml; charset=utf-8" }],
  ["readme", { path: "README.md", logicalName: "bundle/README.md", mediaType: "text/markdown; charset=utf-8" }],
  ["warning", { path: "WARNING.txt", logicalName: "bundle/WARNING.txt", mediaType: "text/plain; charset=utf-8" }],
  ["evidence_inventory", { path: EVIDENCE_INVENTORY_PATH, logicalName: "bundle/evidence/evidence.json", mediaType: "application/json" }],
  ["revision_record", { path: REVISION_RECORD_PATH, logicalName: "bundle/provenance/revision.json", mediaType: "application/json" }]
]);
const BUNDLE_TOOL_V2 = {
  name: "evleda-deterministic-bundler",
  version: "0.1.0",
  adapter: "evleda",
  capabilityProfile: "deterministic-zip-v2"
};
const BUNDLE_TOOL_V3 = {
  name: "evleda-deterministic-bundler",
  version: "0.1.0",
  adapter: "evleda",
  capabilityProfile: "deterministic-zip-v3"
};

const lifecycleCoverBytes = (warning, lifecycle) => {
  const policy = lifecycle === "candidate"
    ? {
        accent: "#8a2400",
        label: "REVIEW CANDIDATE ONLY",
        detail: "Not qualified or authorized for fabrication or manufacturing."
      }
    : {
        accent: "#6b4b00",
        label: "CONTROLLED PROTOTYPE ONLY",
        detail: "Qualified only for the bound prototype scope. Production is not released."
      };
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-labelledby="title description">\n` +
      `  <title id="title">${warning}</title>\n` +
      `  <desc id="description">${policy.label}. Lifecycle: ${lifecycle}.</desc>\n` +
      `  <rect width="1600" height="900" fill="#15171a"/>\n` +
      `  <rect x="48" y="48" width="1504" height="804" rx="28" fill="${policy.accent}" stroke="#ffffff" stroke-width="8"/>\n` +
      `  <text x="800" y="300" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="60" font-weight="700">${warning}</text>\n` +
      `  <text x="800" y="455" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="700">${policy.label}</text>\n` +
      `  <text x="800" y="565" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="42">Lifecycle: ${lifecycle}</text>\n` +
      `  <text x="800" y="670" text-anchor="middle" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="30">${policy.detail}</text>\n` +
      `</svg>\n`,
    "utf8"
  );
};

class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
}

const fail = (message) => {
  throw new VerificationError(message);
};

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectAt = (value, at) => {
  if (!isRecord(value)) fail(at + " must be an object");
  return value;
};

const arrayAt = (value, at) => {
  if (!Array.isArray(value)) fail(at + " must be an array");
  return value;
};

const stringAt = (value, at, { max = 4096, pattern } = {}) => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(at + " must be a non-empty string no longer than " + String(max) + " characters");
  }
  if (pattern !== undefined && !pattern.test(value)) fail(at + " has an invalid format");
  return value;
};

const safeIntegerAt = (value, at, { positive = false } = {}) => {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
    fail(at + " must be a " + (positive ? "positive" : "non-negative") + " safe integer");
  }
  return value;
};

const nullableTimestampAt = (value, at, { required = false } = {}) => {
  if (value === null && !required) return null;
  const timestamp = stringAt(value, at, { max: 64, pattern: RFC3339_UTC });
  if (!Number.isFinite(Date.parse(timestamp))) fail(at + " is not a valid UTC timestamp");
  return timestamp;
};

const exactKeys = (value, required, optional, at, schemaName = MANIFEST_SCHEMA_V3) => {
  const record = objectAt(value, at);
  const present = new Set(Object.keys(record));
  for (const key of required) {
    if (!present.has(key)) fail(at + "." + key + " is required");
  }
  const permitted = new Set([...required, ...optional]);
  for (const key of present) {
    if (!permitted.has(key)) fail(at + "." + key + " is not permitted by " + schemaName);
  }
  return record;
};

const isPlainObject = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const canonicalEncode = (value, at) => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("Non-finite number at " + at);
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((entry, index) => canonicalEncode(entry, at + "[" + String(index) + "]")).join(",") + "]";
  }
  if (typeof value === "object" && value !== null) {
    if (!isPlainObject(value)) fail("Only plain JSON objects can be canonicalized at " + at);
    const entries = Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => {
        const entry = value[key];
        if (entry === undefined) fail("Undefined value at " + at + "." + key);
        return JSON.stringify(key) + ":" + canonicalEncode(entry, at + "." + key);
      });
    return "{" + entries.join(",") + "}";
  }
  fail("Unsupported JSON value at " + at);
};

export const canonicalJsonV1 = (value) => canonicalEncode(value, "$");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const canonicalIdentity = (value, schemaVersion) => ({
  algorithm: "sha256",
  digest: sha256(Buffer.from(canonicalJsonV1(value), "utf8")),
  schemaVersion,
  canonicalizationVersion: CANONICALIZATION
});

export const deterministicIdV1 = (prefix, value) =>
  prefix + "_" + canonicalIdentity(value, "evleda.id." + prefix + ".v1").digest.slice(0, 24);

const canonicalEqual = (left, right) => canonicalJsonV1(left) === canonicalJsonV1(right);
const pathCompare = (left, right) => left.localeCompare(right, "en");
const collisionKey = (relativePath) => relativePath.normalize("NFC").toLocaleLowerCase("en-US");

const assertStrictlySortedStrings = (values, at) => {
  let prior;
  for (const [index, value] of values.entries()) {
    stringAt(value, at + "[" + String(index) + "]", { max: 4096 });
    if (prior !== undefined && pathCompare(prior, value) >= 0) {
      fail(at + " must be unique and strictly sorted by English-locale order");
    }
    prior = value;
  }
};

const validateContentIdentity = (value, at) => {
  const record = exactKeys(value, ["algorithm", "digest", "size"], [], at);
  if (record.algorithm !== "sha256") fail(at + ".algorithm must be sha256");
  stringAt(record.digest, at + ".digest", { max: 64, pattern: DIGEST });
  safeIntegerAt(record.size, at + ".size");
  return record;
};

const validateCanonicalIdentity = (value, at, expectedSchema) => {
  const record = exactKeys(
    value,
    ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"],
    [],
    at
  );
  if (record.algorithm !== "sha256") fail(at + ".algorithm must be sha256");
  stringAt(record.digest, at + ".digest", { max: 64, pattern: DIGEST });
  stringAt(record.schemaVersion, at + ".schemaVersion", { max: 128 });
  if (expectedSchema !== undefined && record.schemaVersion !== expectedSchema) {
    fail(at + ".schemaVersion must be " + expectedSchema);
  }
  if (record.canonicalizationVersion !== CANONICALIZATION) {
    fail(at + ".canonicalizationVersion must be " + CANONICALIZATION);
  }
  return record;
};

const validateExactIdentity = (value, at) => {
  const record = objectAt(value, at);
  return Object.hasOwn(record, "size")
    ? validateContentIdentity(record, at)
    : validateCanonicalIdentity(record, at);
};

const validateTool = (value, at) => {
  const record = exactKeys(
    value,
    ["name", "version", "adapter"],
    ["executablePath", "executableDigest", "capabilityProfile"],
    at
  );
  stringAt(record.name, at + ".name", { max: 256 });
  stringAt(record.version, at + ".version", { max: 256 });
  if (!ADAPTERS.has(record.adapter)) fail(at + ".adapter is unsupported");
  for (const key of ["executablePath", "capabilityProfile"]) {
    if (record[key] !== undefined) stringAt(record[key], at + "." + key, { max: 4096 });
  }
  if (record.executableDigest !== undefined) {
    stringAt(record.executableDigest, at + ".executableDigest", { max: 64, pattern: DIGEST });
  }
  return record;
};

const validateAssumption = (value, at) => {
  const record = exactKeys(value, ["id", "statement", "severity", "sourceRequirementIds"], [], at);
  stringAt(record.id, at + ".id", { max: 256 });
  stringAt(record.statement, at + ".statement", { max: 16_384 });
  if (!new Set(["information", "warning", "blocking"]).has(record.severity)) {
    fail(at + ".severity is unsupported");
  }
  arrayAt(record.sourceRequirementIds, at + ".sourceRequirementIds").forEach((id, index) =>
    stringAt(id, at + ".sourceRequirementIds[" + String(index) + "]", { max: 256 })
  );
  return record;
};

const validateActor = (value, at) => {
  const record = exactKeys(value, ["type", "id", "displayName", "role"], [], at);
  if (record.type !== "human") fail(at + ".type must be human");
  stringAt(record.id, at + ".id", { max: 256 });
  stringAt(record.displayName, at + ".displayName", { max: 1024 });
  if (!new Set(["requirements_reviewer", "hardware_qualifier", "release_authority"]).has(record.role)) {
    fail(at + ".role is unsupported");
  }
  return record;
};

const validateArtifactPath = (value, at) => {
  const relativePath = stringAt(value, at, { max: 4096 });
  if (relativePath !== relativePath.normalize("NFC")) fail(at + " must be NFC-normalized");
  if (relativePath.includes("\\")) fail(at + " must use forward slashes");
  if (relativePath.startsWith("/") || /^[a-z]:/iu.test(relativePath) || relativePath.startsWith("//")) {
    fail(at + " must be relative");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(at + " contains an empty or traversal segment");
  }
  for (const segment of segments) {
    if (
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      ILLEGAL_WINDOWS_CHARS.test(segment) ||
      WINDOWS_DEVICE.test(segment)
    ) {
      fail(at + " contains a non-portable or reserved segment");
    }
  }
  if (collisionKey(relativePath) === collisionKey(MANIFEST_NAME)) {
    fail(at + " must not list " + MANIFEST_NAME + "; the manifest cannot self-hash");
  }
  return relativePath;
};

const validatePolicy = (manifest) => {
  if (!new Set(["candidate", "prototype"]).has(manifest.bundleKind)) {
    fail("$.bundleKind must be candidate or prototype");
  }
  if (!LIFECYCLES.has(manifest.lifecycle)) fail("$.lifecycle is unsupported");
  const required =
    manifest.bundleKind === "candidate"
      ? { lifecycle: "candidate", warning: "CANDIDATE — NOT FOR MANUFACTURING" }
      : { lifecycle: "qualified", warning: "PROTOTYPE — NOT PRODUCTION RELEASED" };
  if (manifest.lifecycle !== required.lifecycle || manifest.warning !== required.warning) {
    fail(
      "Bundle policy mismatch: " +
        manifest.bundleKind +
        " requires lifecycle " +
        required.lifecycle +
        " and warning " +
        JSON.stringify(required.warning)
    );
  }
};

const validateLiveRegenerationPolicy = (value, at = "$.liveRegenerationPolicy") => {
  const policy = exactKeys(
    value,
    ["scope", "claim", "reproducible"],
    [],
    at
  );
  if (policy.scope !== "live_model_or_research") {
    fail(at + ".scope must be live_model_or_research");
  }
  if (policy.claim !== "traceable") {
    fail(at + ".claim must be traceable");
  }
  if (policy.reproducible !== false) {
    fail(at + ".reproducible must be false");
  }
  return policy;
};

const validateLegacyManifest = (value) => {
  const manifest = exactKeys(
    value,
    [
      "schemaVersion",
      "canonicalizationVersion",
      "bundleKind",
      "lifecycle",
      "projectId",
      "runId",
      "designRevisionId",
      "revisionManifest",
      "evidenceRoot",
      "warning",
      "artifacts",
      "toolchain",
      "unresolvedAssumptions"
    ],
    ["createdAt"],
    "$",
    MANIFEST_SCHEMA_V1
  );
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_V1) fail("$.schemaVersion must be " + MANIFEST_SCHEMA_V1);
  if (manifest.canonicalizationVersion !== CANONICALIZATION) fail("$.canonicalizationVersion must be " + CANONICALIZATION);
  validatePolicy(manifest);
  for (const key of ["projectId", "runId", "designRevisionId"]) stringAt(manifest[key], "$." + key, { max: 256 });
  validateCanonicalIdentity(manifest.revisionManifest, "$.revisionManifest");
  validateCanonicalIdentity(manifest.evidenceRoot, "$.evidenceRoot");
  if (manifest.createdAt !== undefined) nullableTimestampAt(manifest.createdAt, "$.createdAt", { required: true });
  const toolchain = arrayAt(manifest.toolchain, "$.toolchain");
  if (toolchain.length === 0 || toolchain.length > 256) fail("$.toolchain must contain 1-256 tools");
  toolchain.forEach((tool, index) => validateTool(tool, "$.toolchain[" + String(index) + "]"));
  const assumptions = arrayAt(manifest.unresolvedAssumptions, "$.unresolvedAssumptions");
  if (assumptions.length > MAX_EVIDENCE) fail("$.unresolvedAssumptions exceeds the limit");
  assumptions.forEach((entry, index) => validateAssumption(entry, "$.unresolvedAssumptions[" + String(index) + "]"));
  const artifacts = arrayAt(manifest.artifacts, "$.artifacts");
  if (artifacts.length > MAX_ARTIFACTS) fail("$.artifacts exceeds the limit");
  const seen = new Map();
  let previous;
  for (const [index, valueAtIndex] of artifacts.entries()) {
    const at = "$.artifacts[" + String(index) + "]";
    const artifact = exactKeys(
      valueAtIndex,
      ["path", "logicalName", "mediaType", "identity", "stage", "validationStatus", "sourceArtifactId", "projectId", "runId", "designRevisionId"],
      [],
      at,
      MANIFEST_SCHEMA_V1
    );
    const artifactPath = validateArtifactPath(artifact.path, at + ".path");
    stringAt(artifact.logicalName, at + ".logicalName", { max: 1024 });
    stringAt(artifact.mediaType, at + ".mediaType", { max: 256 });
    validateContentIdentity(artifact.identity, at + ".identity");
    if (!STAGES.has(artifact.stage)) fail(at + ".stage is unsupported");
    if (!VALIDATION_STATUSES.has(artifact.validationStatus)) fail(at + ".validationStatus is unsupported");
    stringAt(artifact.sourceArtifactId, at + ".sourceArtifactId", { max: 256 });
    for (const key of ["projectId", "runId", "designRevisionId"]) {
      stringAt(artifact[key], at + "." + key, { max: 256 });
      if (artifact[key] !== manifest[key]) fail(at + "." + key + " does not match the bundle");
    }
    if (previous !== undefined && pathCompare(previous, artifactPath) >= 0) {
      fail("$.artifacts must be strictly sorted by English-locale path order");
    }
    previous = artifactPath;
    const key = collisionKey(artifactPath);
    if (seen.has(key)) fail(at + ".path collides with " + seen.get(key));
    seen.set(key, artifactPath);
  }
  return manifest;
};

const validateProvenanceArtifact = (value, at, manifest, bundleTool) => {
  const artifact = exactKeys(
    value,
    [
      "path", "logicalName", "mediaType", "identity", "stage", "validationStatus",
      "sourceArtifactId", "sourceKind", "sourceDesignRevisionId", "projectId", "runId",
      "designRevisionId", "exactInputs", "derivedFrom", "tool", "unresolvedAssumptions",
      "lifecycle", "createdAt", "staleAt"
    ],
    ["generationRole"],
    at
  );
  validateArtifactPath(artifact.path, at + ".path");
  stringAt(artifact.logicalName, at + ".logicalName", { max: 1024 });
  stringAt(artifact.mediaType, at + ".mediaType", { max: 256 });
  validateContentIdentity(artifact.identity, at + ".identity");
  if (!STAGES.has(artifact.stage)) fail(at + ".stage is unsupported");
  if (!VALIDATION_STATUSES.has(artifact.validationStatus)) fail(at + ".validationStatus is unsupported");
  stringAt(artifact.sourceArtifactId, at + ".sourceArtifactId", { max: 256 });
  if (!new Set(["stored_artifact", "bundle_generated"]).has(artifact.sourceKind)) fail(at + ".sourceKind is unsupported");
  stringAt(artifact.sourceDesignRevisionId, at + ".sourceDesignRevisionId", { max: 256 });
  for (const key of ["projectId", "runId", "designRevisionId"]) {
    stringAt(artifact[key], at + "." + key, { max: 256 });
    if (artifact[key] !== manifest[key]) fail(at + "." + key + " does not match the selected bundle identity");
  }
  arrayAt(artifact.exactInputs, at + ".exactInputs").forEach((identity, index) =>
    validateExactIdentity(identity, at + ".exactInputs[" + String(index) + "]")
  );
  assertStrictlySortedStrings(arrayAt(artifact.derivedFrom, at + ".derivedFrom"), at + ".derivedFrom");
  validateTool(artifact.tool, at + ".tool");
  arrayAt(artifact.unresolvedAssumptions, at + ".unresolvedAssumptions").forEach((entry, index) =>
    validateAssumption(entry, at + ".unresolvedAssumptions[" + String(index) + "]")
  );
  if (!LIFECYCLES.has(artifact.lifecycle)) fail(at + ".lifecycle is unsupported");
  nullableTimestampAt(artifact.createdAt, at + ".createdAt");
  nullableTimestampAt(artifact.staleAt, at + ".staleAt");
  if (artifact.sourceKind === "stored_artifact") {
    if (artifact.generationRole !== undefined) fail(at + ".generationRole is forbidden for stored artifacts");
    if (artifact.createdAt === null) fail(at + ".createdAt is required for stored artifacts");
  } else {
    if (!GENERATED_ROLES.has(artifact.generationRole)) fail(at + ".generationRole is required and unsupported");
    if (artifact.createdAt !== null || artifact.staleAt !== null) fail(at + " bundle-generated timestamps must be null");
    if (
      artifact.stage !== "manufacturing_package" ||
      artifact.validationStatus !== "pass" ||
      artifact.sourceDesignRevisionId !== manifest.designRevisionId ||
      !canonicalEqual(artifact.tool, bundleTool)
    ) {
      fail(at + " has invalid generated-artifact provenance");
    }
    const role = GENERATED_ROLES.get(artifact.generationRole);
    if (role.path !== artifact.path || role.logicalName !== artifact.logicalName || role.mediaType !== artifact.mediaType) {
      fail(at + " does not match the fixed contract for " + artifact.generationRole);
    }
  }
  return artifact;
};

const validateProvenanceManifest = (value, schemaVersion) => {
  const isV3 = schemaVersion === MANIFEST_SCHEMA_V3;
  const manifest = exactKeys(
    value,
    [
      "schemaVersion", "canonicalizationVersion", "bundleKind", "lifecycle", "projectId",
      "runId", "designRevisionId", "designRevisionOrdinal", "revisionManifest",
      "revisionRecordPath", "evidenceRoot", "evidenceInventoryPath", "warning",
      "artifacts", "toolchain", "unresolvedAssumptions",
      ...(isV3
        ? ["liveRegenerationPolicy", "liveRegenerationPolicyIdentity", "exactInputs"]
        : [])
    ],
    [],
    "$",
    schemaVersion
  );
  if (manifest.schemaVersion !== schemaVersion) fail("$.schemaVersion must be " + schemaVersion);
  if (manifest.canonicalizationVersion !== CANONICALIZATION) fail("$.canonicalizationVersion must be " + CANONICALIZATION);
  validatePolicy(manifest);
  for (const key of ["projectId", "runId", "designRevisionId"]) stringAt(manifest[key], "$." + key, { max: 256 });
  safeIntegerAt(manifest.designRevisionOrdinal, "$.designRevisionOrdinal", { positive: true });
  validateCanonicalIdentity(manifest.revisionManifest, "$.revisionManifest", REVISION_SCHEMA);
  validateCanonicalIdentity(manifest.evidenceRoot, "$.evidenceRoot", EVIDENCE_ROOT_SCHEMA);
  if (manifest.revisionRecordPath !== REVISION_RECORD_PATH) fail("$.revisionRecordPath must be " + REVISION_RECORD_PATH);
  if (manifest.evidenceInventoryPath !== EVIDENCE_INVENTORY_PATH) fail("$.evidenceInventoryPath must be " + EVIDENCE_INVENTORY_PATH);
  stringAt(manifest.warning, "$.warning", { max: 4096 });
  if (isV3) {
    const policy = validateLiveRegenerationPolicy(manifest.liveRegenerationPolicy);
    const policyIdentity = validateCanonicalIdentity(
      manifest.liveRegenerationPolicyIdentity,
      "$.liveRegenerationPolicyIdentity",
      LIVE_REGENERATION_POLICY_SCHEMA
    );
    const recomputedPolicyIdentity = canonicalIdentity(policy, LIVE_REGENERATION_POLICY_SCHEMA);
    if (!canonicalEqual(policyIdentity, recomputedPolicyIdentity)) {
      fail("Live-regeneration policy identity does not match $.liveRegenerationPolicy");
    }
    const exactInputs = arrayAt(manifest.exactInputs, "$.exactInputs");
    exactInputs.forEach((identity, index) =>
      validateExactIdentity(identity, "$.exactInputs[" + String(index) + "]")
    );
    if (
      !canonicalEqual(
        exactInputs,
        [manifest.revisionManifest, manifest.evidenceRoot, policyIdentity]
      )
    ) {
      fail(
        "$.exactInputs must exactly equal [$.revisionManifest, $.evidenceRoot, $.liveRegenerationPolicyIdentity]"
      );
    }
  }
  const artifacts = arrayAt(manifest.artifacts, "$.artifacts");
  if (artifacts.length === 0 || artifacts.length > MAX_ARTIFACTS) fail("$.artifacts must contain 1-" + String(MAX_ARTIFACTS) + " entries");
  const paths = new Map();
  const sourceIds = new Map();
  let previous;
  for (const [index, valueAtIndex] of artifacts.entries()) {
    const at = "$.artifacts[" + String(index) + "]";
    const artifact = validateProvenanceArtifact(
      valueAtIndex,
      at,
      manifest,
      isV3 ? BUNDLE_TOOL_V3 : BUNDLE_TOOL_V2
    );
    if (previous !== undefined && pathCompare(previous, artifact.path) >= 0) {
      fail("$.artifacts must be strictly sorted by English-locale path order");
    }
    previous = artifact.path;
    const key = collisionKey(artifact.path);
    if (paths.has(key)) fail(at + ".path collides with " + paths.get(key));
    paths.set(key, artifact.path);
    if (sourceIds.has(artifact.sourceArtifactId)) fail(at + ".sourceArtifactId duplicates " + sourceIds.get(artifact.sourceArtifactId));
    sourceIds.set(artifact.sourceArtifactId, artifact.path);
  }
  const toolchain = arrayAt(manifest.toolchain, "$.toolchain");
  if (toolchain.length === 0 || toolchain.length > 256) fail("$.toolchain must contain 1-256 tools");
  toolchain.forEach((tool, index) => validateTool(tool, "$.toolchain[" + String(index) + "]"));
  const assumptions = arrayAt(manifest.unresolvedAssumptions, "$.unresolvedAssumptions");
  if (assumptions.length > MAX_EVIDENCE) fail("$.unresolvedAssumptions exceeds the limit");
  assumptions.forEach((entry, index) => validateAssumption(entry, "$.unresolvedAssumptions[" + String(index) + "]"));
  return manifest;
};

const validateV3Manifest = (value) => validateProvenanceManifest(value, MANIFEST_SCHEMA_V3);
const validateLegacyV2Manifest = (value) => validateProvenanceManifest(value, MANIFEST_SCHEMA_V2);

const validateRevisionArtifact = (value, at, projectId, runId) => {
  const record = exactKeys(
    value,
    [
      "id", "projectId", "runId", "stage", "logicalName", "mediaType", "blob",
      "exactInputs", "derivedFrom", "tool", "validationStatus", "unresolvedAssumptions",
      "lifecycle", "createdAt", "staleAt"
    ],
    ["designRevisionId"],
    at,
    REVISION_SCHEMA
  );
  stringAt(record.id, at + ".id", { max: 256 });
  if (record.projectId !== projectId || record.runId !== runId) fail(at + " crosses project or run ownership");
  if (record.designRevisionId !== undefined) stringAt(record.designRevisionId, at + ".designRevisionId", { max: 256 });
  if (!STAGES.has(record.stage)) fail(at + ".stage is unsupported");
  stringAt(record.logicalName, at + ".logicalName", { max: 1024 });
  stringAt(record.mediaType, at + ".mediaType", { max: 256 });
  validateContentIdentity(record.blob, at + ".blob");
  arrayAt(record.exactInputs, at + ".exactInputs").forEach((identity, index) =>
    validateExactIdentity(identity, at + ".exactInputs[" + String(index) + "]")
  );
  assertStrictlySortedStrings(arrayAt(record.derivedFrom, at + ".derivedFrom"), at + ".derivedFrom");
  validateTool(record.tool, at + ".tool");
  if (!VALIDATION_STATUSES.has(record.validationStatus)) fail(at + ".validationStatus is unsupported");
  arrayAt(record.unresolvedAssumptions, at + ".unresolvedAssumptions").forEach((entry, index) =>
    validateAssumption(entry, at + ".unresolvedAssumptions[" + String(index) + "]")
  );
  if (!LIFECYCLES.has(record.lifecycle)) fail(at + ".lifecycle is unsupported");
  nullableTimestampAt(record.createdAt, at + ".createdAt", { required: true });
  nullableTimestampAt(record.staleAt, at + ".staleAt");
  return record;
};

const validateEvidenceProjection = (value, at, projectId, runId, allowMissingRevision) => {
  const required = [
    "id", "projectId", "runId", "stage", "evidenceClass", "claim", "subjectDigests",
    "rawArtifactId", "parsedArtifactId", "exactInputs", "tool", "validationStatus",
    "unresolvedAssumptions", "lifecycle", "createdAt", "validUntil", "staleAt"
  ];
  if (!allowMissingRevision) required.splice(3, 0, "designRevisionId");
  const record = exactKeys(value, required, allowMissingRevision ? ["designRevisionId"] : [], at, EVIDENCE_ROOT_SCHEMA);
  stringAt(record.id, at + ".id", { max: 256 });
  if (record.projectId !== projectId || record.runId !== runId) fail(at + " crosses project or run ownership");
  if (record.designRevisionId !== undefined) stringAt(record.designRevisionId, at + ".designRevisionId", { max: 256 });
  if (!STAGES.has(record.stage)) fail(at + ".stage is unsupported");
  if (!EVIDENCE_CLASSES.has(record.evidenceClass)) fail(at + ".evidenceClass is unsupported");
  stringAt(record.claim, at + ".claim", { max: 65_536 });
  const subjects = arrayAt(record.subjectDigests, at + ".subjectDigests");
  subjects.forEach((digest, index) => stringAt(digest, at + ".subjectDigests[" + String(index) + "]", { max: 64, pattern: DIGEST }));
  assertStrictlySortedStrings(subjects, at + ".subjectDigests");
  for (const key of ["rawArtifactId", "parsedArtifactId"]) {
    if (record[key] !== null) stringAt(record[key], at + "." + key, { max: 256 });
  }
  arrayAt(record.exactInputs, at + ".exactInputs").forEach((identity, index) =>
    validateExactIdentity(identity, at + ".exactInputs[" + String(index) + "]")
  );
  validateTool(record.tool, at + ".tool");
  if (!VALIDATION_STATUSES.has(record.validationStatus)) fail(at + ".validationStatus is unsupported");
  arrayAt(record.unresolvedAssumptions, at + ".unresolvedAssumptions").forEach((entry, index) =>
    validateAssumption(entry, at + ".unresolvedAssumptions[" + String(index) + "]")
  );
  if (!LIFECYCLES.has(record.lifecycle)) fail(at + ".lifecycle is unsupported");
  nullableTimestampAt(record.createdAt, at + ".createdAt", { required: true });
  nullableTimestampAt(record.validUntil, at + ".validUntil");
  nullableTimestampAt(record.staleAt, at + ".staleAt");
  return record;
};

const validateRevisionRecord = (value, manifest) => {
  const record = objectAt(value, "$revision.record");
  const common = ["schemaVersion", "projectId", "runId", "parentRevisionIds", "requirements", "artifacts", "evidence"];
  const variants = ["approval", "stage", "operation"].filter((key) => Object.hasOwn(record, key));
  if (variants.length !== 1) fail("$revision.record must contain exactly one revision variant");
  if (variants[0] === "approval") {
    exactKeys(record, common.concat(["approval"]), [], "$revision.record", REVISION_SCHEMA);
  } else if (variants[0] === "stage") {
    exactKeys(record, common.concat(["ordinal", "stage", "attempt"]), [], "$revision.record", REVISION_SCHEMA);
    safeIntegerAt(record.ordinal, "$revision.record.ordinal", { positive: true });
    if (record.ordinal !== manifest.designRevisionOrdinal) fail("$revision.record.ordinal does not match the bundle");
    if (!STAGES.has(record.stage)) fail("$revision.record.stage is unsupported");
    const attempt = exactKeys(record.attempt, ["id", "number", "fencingEpoch", "inputManifest", "outputIdentity"], [], "$revision.record.attempt", REVISION_SCHEMA);
    stringAt(attempt.id, "$revision.record.attempt.id", { max: 256 });
    safeIntegerAt(attempt.number, "$revision.record.attempt.number", { positive: true });
    safeIntegerAt(attempt.fencingEpoch, "$revision.record.attempt.fencingEpoch");
    validateCanonicalIdentity(attempt.inputManifest, "$revision.record.attempt.inputManifest");
    validateCanonicalIdentity(attempt.outputIdentity, "$revision.record.attempt.outputIdentity");
  } else {
    exactKeys(record, common.concat(["ordinal", "operation", "sourceRevision"]), [], "$revision.record", REVISION_SCHEMA);
    safeIntegerAt(record.ordinal, "$revision.record.ordinal", { positive: true });
    if (record.ordinal !== manifest.designRevisionOrdinal) fail("$revision.record.ordinal does not match the bundle");
    if (!new Set(["generate_bringup_plan", "generate_firmware_scaffold"]).has(record.operation)) {
      fail("$revision.record.operation is unsupported");
    }
    validateCanonicalIdentity(record.sourceRevision, "$revision.record.sourceRevision", REVISION_SCHEMA);
  }
  if (record.schemaVersion !== REVISION_SCHEMA) fail("$revision.record.schemaVersion must be " + REVISION_SCHEMA);
  if (record.projectId !== manifest.projectId || record.runId !== manifest.runId) fail("$revision.record crosses project or run ownership");
  assertStrictlySortedStrings(arrayAt(record.parentRevisionIds, "$revision.record.parentRevisionIds"), "$revision.record.parentRevisionIds");
  validateCanonicalIdentity(record.requirements, "$revision.record.requirements");
  if (variants[0] === "approval") {
    const approval = exactKeys(record.approval, ["id", "subjectDigest", "actor", "policyVersion"], [], "$revision.record.approval", REVISION_SCHEMA);
    stringAt(approval.id, "$revision.record.approval.id", { max: 256 });
    stringAt(approval.subjectDigest, "$revision.record.approval.subjectDigest", { max: 64, pattern: DIGEST });
    validateActor(approval.actor, "$revision.record.approval.actor");
    stringAt(approval.policyVersion, "$revision.record.approval.policyVersion", { max: 256 });
  }
  const artifacts = arrayAt(record.artifacts, "$revision.record.artifacts");
  const artifactIds = new Set();
  artifacts.forEach((entry, index) => {
    const parsed = validateRevisionArtifact(entry, "$revision.record.artifacts[" + String(index) + "]", manifest.projectId, manifest.runId);
    if (artifactIds.has(parsed.id)) fail("$revision.record.artifacts contains duplicate ID " + parsed.id);
    artifactIds.add(parsed.id);
  });
  const evidence = arrayAt(record.evidence, "$revision.record.evidence");
  const evidenceIds = new Set();
  evidence.forEach((entry, index) => {
    const parsed = validateEvidenceProjection(entry, "$revision.record.evidence[" + String(index) + "]", manifest.projectId, manifest.runId, true);
    if (evidenceIds.has(parsed.id)) fail("$revision.record.evidence contains duplicate ID " + parsed.id);
    evidenceIds.add(parsed.id);
  });
  return record;
};

const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
};

const assertRegularConfinedFile = async (rootReal, filePath, displayPath) => {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink()) fail(displayPath + " is a symbolic link or junction");
  if (!metadata.isFile()) fail(displayPath + " is not a regular file");
  const actualReal = await realpath(filePath);
  if (!isWithin(rootReal, actualReal)) fail(displayPath + " resolves outside the bundle root");
  return metadata;
};

const walkFiles = async (root, rootReal) => {
  const files = [];
  const visit = async (directory, relativeDirectory) => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const relative = relativeDirectory === "" ? entry.name : relativeDirectory + "/" + entry.name;
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail(relative + " is a symbolic link or junction");
      const entryReal = await realpath(absolute);
      if (!isWithin(rootReal, entryReal)) fail(relative + " resolves outside the bundle root");
      if (metadata.isDirectory()) await visit(absolute, relative);
      else if (metadata.isFile()) files.push(relative);
      else fail(relative + " is not a regular file or directory");
    }
  };
  await visit(root, "");
  return files;
};

const hashFile = async (filePath) => {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { algorithm: "sha256", digest: hash.digest("hex"), size: bytes };
};

const decodeJsonBytes = (bytes, displayPath) => {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(displayPath + " is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(displayPath + " is not valid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
};

const readCanonicalJsonFile = async (rootReal, filePath, displayPath, limit = MAX_PROVENANCE_BYTES) => {
  const before = await assertRegularConfinedFile(rootReal, filePath, displayPath);
  if (before.size > limit) fail(displayPath + " exceeds " + String(limit) + " bytes");
  const bytes = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail(displayPath + " changed while it was being verified");
  const parsed = decodeJsonBytes(bytes, displayPath);
  const canonical = Buffer.from(canonicalJsonV1(parsed) + "\n", "utf8");
  if (!Buffer.from(bytes).equals(canonical)) fail(displayPath + " must use exact " + CANONICALIZATION + " bytes followed by one newline");
  return parsed;
};

const normalizedRevisionArtifact = (record, selectedRevisionId) => ({
  ...record,
  designRevisionId: record.designRevisionId === undefined ? selectedRevisionId : record.designRevisionId
});

const manifestArtifactProjection = (artifact) => ({
  id: artifact.sourceArtifactId,
  projectId: artifact.projectId,
  runId: artifact.runId,
  designRevisionId: artifact.sourceDesignRevisionId,
  stage: artifact.stage,
  logicalName: artifact.logicalName,
  mediaType: artifact.mediaType,
  blob: artifact.identity,
  exactInputs: artifact.exactInputs,
  derivedFrom: artifact.derivedFrom,
  tool: artifact.tool,
  validationStatus: artifact.validationStatus,
  unresolvedAssumptions: artifact.unresolvedAssumptions,
  lifecycle: artifact.lifecycle,
  createdAt: artifact.createdAt,
  staleAt: artifact.staleAt
});

const normalizedRevisionEvidence = (record, selectedRevisionId) => ({
  ...record,
  designRevisionId: record.designRevisionId === undefined ? selectedRevisionId : record.designRevisionId
});

const verifyAggregateBindings = (manifest, evidence) => {
  const tools = new Map();
  const addTool = (tool, at) => {
    const key = canonicalIdentity(tool, "evleda.tool-identity.v1").digest;
    const existing = tools.get(key);
    if (existing !== undefined && !canonicalEqual(existing, tool)) fail(at + " collides with a different tool identity");
    tools.set(key, tool);
  };
  manifest.artifacts.forEach((artifact, index) => addTool(artifact.tool, "$.artifacts[" + String(index) + "].tool"));
  evidence.forEach((entry, index) => addTool(entry.tool, "$evidence.evidence[" + String(index) + "].tool"));
  const expectedTools = [...tools.entries()].sort(([left], [right]) => pathCompare(left, right)).map(([, tool]) => tool);
  if (!canonicalEqual(expectedTools, manifest.toolchain)) fail("$.toolchain is not the exact provenance tool union");

  const assumptions = new Map();
  const addAssumption = (assumption, at) => {
    const existing = assumptions.get(assumption.id);
    if (existing !== undefined && !canonicalEqual(existing, assumption)) fail(at + " conflicts with assumption ID " + assumption.id);
    assumptions.set(assumption.id, assumption);
  };
  manifest.artifacts.forEach((artifact, index) =>
    artifact.unresolvedAssumptions.forEach((entry) => addAssumption(entry, "$.artifacts[" + String(index) + "]"))
  );
  evidence.forEach((entry, index) =>
    entry.unresolvedAssumptions.forEach((entry) => addAssumption(entry, "$evidence.evidence[" + String(index) + "]"))
  );
  const expectedAssumptions = [...assumptions.values()].sort((left, right) => pathCompare(left.id, right.id));
  if (!canonicalEqual(expectedAssumptions, manifest.unresolvedAssumptions)) fail("$.unresolvedAssumptions is not the exact provenance assumption union");
};

const verifyProvenance = async (root, rootReal, manifest, options) => {
  const isV3 = manifest.schemaVersion === MANIFEST_SCHEMA_V3;
  const revisionPath = path.join(root, ...manifest.revisionRecordPath.split("/"));
  const evidencePath = path.join(root, ...manifest.evidenceInventoryPath.split("/"));
  const revisionEnvelope = exactKeys(
    await readCanonicalJsonFile(rootReal, revisionPath, manifest.revisionRecordPath),
    ["schemaVersion", "canonicalizationVersion", "designRevisionId", "ordinal", "revisionManifest", "record"],
    [],
    "$revision",
    REVISION_RECORD_SCHEMA
  );
  if (revisionEnvelope.schemaVersion !== REVISION_RECORD_SCHEMA) fail("$revision.schemaVersion must be " + REVISION_RECORD_SCHEMA);
  if (revisionEnvelope.canonicalizationVersion !== CANONICALIZATION) fail("$revision.canonicalizationVersion must be " + CANONICALIZATION);
  if (revisionEnvelope.designRevisionId !== manifest.designRevisionId || revisionEnvelope.ordinal !== manifest.designRevisionOrdinal) {
    fail("$revision does not match the selected design revision");
  }
  safeIntegerAt(revisionEnvelope.ordinal, "$revision.ordinal", { positive: true });
  validateCanonicalIdentity(revisionEnvelope.revisionManifest, "$revision.revisionManifest", REVISION_SCHEMA);
  if (!canonicalEqual(revisionEnvelope.revisionManifest, manifest.revisionManifest)) fail("$revision.revisionManifest does not match $.revisionManifest");
  const revisionRecord = validateRevisionRecord(revisionEnvelope.record, manifest);
  const recomputedRevision = canonicalIdentity(revisionRecord, REVISION_SCHEMA);
  if (!canonicalEqual(recomputedRevision, manifest.revisionManifest)) {
    fail("Revision root mismatch: canonical revision record does not reproduce $.revisionManifest");
  }
  const recomputedRevisionId = deterministicIdV1("revision", {
    runId: manifest.runId,
    ordinal: manifest.designRevisionOrdinal,
    manifest: recomputedRevision.digest
  });
  if (recomputedRevisionId !== manifest.designRevisionId) fail("Design revision ID does not match the recomputed revision root");

  const evidenceEnvelope = exactKeys(
    await readCanonicalJsonFile(rootReal, evidencePath, manifest.evidenceInventoryPath),
    ["schemaVersion", "canonicalizationVersion", "evidenceRoot", "evidence"],
    [],
    "$evidence",
    EVIDENCE_INVENTORY_SCHEMA
  );
  if (evidenceEnvelope.schemaVersion !== EVIDENCE_INVENTORY_SCHEMA) fail("$evidence.schemaVersion must be " + EVIDENCE_INVENTORY_SCHEMA);
  if (evidenceEnvelope.canonicalizationVersion !== CANONICALIZATION) fail("$evidence.canonicalizationVersion must be " + CANONICALIZATION);
  validateCanonicalIdentity(evidenceEnvelope.evidenceRoot, "$evidence.evidenceRoot", EVIDENCE_ROOT_SCHEMA);
  if (!canonicalEqual(evidenceEnvelope.evidenceRoot, manifest.evidenceRoot)) fail("$evidence.evidenceRoot does not match $.evidenceRoot");
  const evidence = arrayAt(evidenceEnvelope.evidence, "$evidence.evidence");
  if (evidence.length > MAX_EVIDENCE) fail("$evidence.evidence exceeds the limit");
  let previousEvidenceId;
  const evidenceById = new Map();
  evidence.forEach((entry, index) => {
    const parsed = validateEvidenceProjection(entry, "$evidence.evidence[" + String(index) + "]", manifest.projectId, manifest.runId, false);
    if (previousEvidenceId !== undefined && pathCompare(previousEvidenceId, parsed.id) >= 0) {
      fail("$evidence.evidence must be unique and strictly sorted by ID");
    }
    previousEvidenceId = parsed.id;
    evidenceById.set(parsed.id, parsed);
  });
  const recomputedEvidence = canonicalIdentity([...evidence].sort((left, right) => pathCompare(left.id, right.id)), EVIDENCE_ROOT_SCHEMA);
  if (!canonicalEqual(recomputedEvidence, manifest.evidenceRoot)) {
    fail("Evidence root mismatch: canonical evidence projection does not reproduce $.evidenceRoot");
  }

  const entriesBySourceId = new Map(manifest.artifacts.map((entry) => [entry.sourceArtifactId, entry]));
  const storedEntries = manifest.artifacts.filter((entry) => entry.sourceKind === "stored_artifact");
  const revisionArtifactIds = new Set();
  for (const record of revisionRecord.artifacts) {
    revisionArtifactIds.add(record.id);
    const entry = entriesBySourceId.get(record.id);
    if (entry === undefined || entry.sourceKind !== "stored_artifact") fail("Revision artifact has no stored bundle entry: " + record.id);
    if (!canonicalEqual(normalizedRevisionArtifact(record, manifest.designRevisionId), manifestArtifactProjection(entry))) {
      fail("Stored bundle provenance does not match revision record for artifact " + record.id);
    }
  }

  const referencedArtifactIds = new Set();
  for (const entry of evidence) {
    for (const key of ["rawArtifactId", "parsedArtifactId"]) {
      const artifactId = entry[key];
      if (artifactId !== null) {
        referencedArtifactIds.add(artifactId);
        const artifact = entriesBySourceId.get(artifactId);
        if (artifact === undefined || artifact.sourceKind !== "stored_artifact") {
          fail("Evidence " + entry.id + " references missing stored artifact " + artifactId);
        }
      }
    }
  }
  for (const entry of storedEntries) {
    if (!revisionArtifactIds.has(entry.sourceArtifactId) && !referencedArtifactIds.has(entry.sourceArtifactId)) {
      fail("Stored artifact is neither in the revision nor referenced by evidence: " + entry.sourceArtifactId);
    }
    for (const parentId of entry.derivedFrom) {
      const parent = entriesBySourceId.get(parentId);
      if (parent === undefined || parent.sourceKind !== "stored_artifact") {
        fail("Artifact " + entry.sourceArtifactId + " has unresolved derivedFrom edge " + parentId);
      }
    }
  }

  const revisionEvidenceIds = new Set();
  for (const record of revisionRecord.evidence) {
    revisionEvidenceIds.add(record.id);
    const entry = evidenceById.get(record.id);
    if (entry === undefined) fail("Revision evidence is absent from evidence inventory: " + record.id);
    if (!canonicalEqual(normalizedRevisionEvidence(record, manifest.designRevisionId), entry)) {
      fail("Evidence inventory does not match revision record for evidence " + record.id);
    }
  }
  for (const entry of evidence) {
    if (!revisionEvidenceIds.has(entry.id) && entry.designRevisionId !== manifest.designRevisionId) {
      fail("Post-revision evidence must bind the selected design revision: " + entry.id);
    }
  }

  const generatedByRole = new Map();
  for (const entry of manifest.artifacts.filter((artifact) => artifact.sourceKind === "bundle_generated")) {
    if (generatedByRole.has(entry.generationRole)) fail("Duplicate bundle-generated role " + entry.generationRole);
    generatedByRole.set(entry.generationRole, entry);
    const expectedId = deterministicIdV1("bundle_artifact", {
      source: "evleda_bundle_generator",
      bundleKind: manifest.bundleKind,
      role: entry.generationRole,
      projectId: manifest.projectId,
      runId: manifest.runId,
      designRevisionId: manifest.designRevisionId,
      revisionManifest: manifest.revisionManifest,
      evidenceRoot: manifest.evidenceRoot,
      ...(isV3
        ? { liveRegenerationPolicyIdentity: manifest.liveRegenerationPolicyIdentity }
        : {}),
      identity: entry.identity
    });
    if (entry.sourceArtifactId !== expectedId) fail("Generated artifact ID does not match role " + entry.generationRole);
    const expectedExactInputs = isV3
      ? [manifest.revisionManifest, manifest.evidenceRoot, manifest.liveRegenerationPolicyIdentity]
      : [manifest.revisionManifest, manifest.evidenceRoot];
    if (!canonicalEqual(entry.exactInputs, expectedExactInputs)) {
      fail("Generated artifact exactInputs are incomplete for role " + entry.generationRole);
    }
  }
  for (const role of GENERATED_ROLES.keys()) if (!generatedByRole.has(role)) fail("Missing bundle-generated role " + role);
  const expectedRevisionDerived = [...revisionArtifactIds].sort(pathCompare);
  if (!canonicalEqual(generatedByRole.get("revision_record").derivedFrom, expectedRevisionDerived)) {
    fail("Revision-record derivedFrom list does not match revision artifacts");
  }
  const expectedEvidenceDerived = [...referencedArtifactIds].sort(pathCompare);
  if (!canonicalEqual(generatedByRole.get("evidence_inventory").derivedFrom, expectedEvidenceDerived)) {
    fail("Evidence-inventory derivedFrom list does not match artifact references");
  }
  if (
    generatedByRole.get("cover").derivedFrom.length !== 0 ||
    generatedByRole.get("readme").derivedFrom.length !== 0 ||
    generatedByRole.get("warning").derivedFrom.length !== 0
  ) {
    fail("Cover, README, and warning entries must not declare derived artifacts");
  }
  const coverEntry = generatedByRole.get("cover");
  const expectedCoverBytes = lifecycleCoverBytes(manifest.warning, manifest.lifecycle);
  const expectedCoverIdentity = {
    algorithm: "sha256",
    digest: sha256(expectedCoverBytes),
    size: expectedCoverBytes.length
  };
  if (!canonicalEqual(coverEntry.identity, expectedCoverIdentity)) {
    fail("Lifecycle cover does not visibly render the exact bundle warning and lifecycle");
  }
  const coverBytes = await readFile(path.join(root, ...coverEntry.path.split("/")));
  if (!coverBytes.equals(expectedCoverBytes)) {
    fail("Lifecycle cover does not visibly render the exact bundle warning and lifecycle");
  }

  verifyAggregateBindings(manifest, evidence);
  if (options.expectedRevisionManifest !== undefined && options.expectedRevisionManifest !== recomputedRevision.digest) {
    fail("Trusted expected revision manifest does not match the bundle");
  }
  if (options.expectedEvidenceRoot !== undefined && options.expectedEvidenceRoot !== recomputedEvidence.digest) {
    fail("Trusted expected evidence root does not match the bundle");
  }
  return { recomputedRevision, recomputedEvidence };
};

const validateExpectedDigest = (value, name) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DIGEST.test(value)) fail(name + " must be a lowercase SHA-256 digest");
  return value;
};

export const verifyBundle = async (
  inputPath,
  {
    allowLegacyV1 = false,
    allowLegacyV2 = false,
    expectedRevisionManifest,
    expectedEvidenceRoot
  } = {}
) => {
  const options = {
    allowLegacyV1: allowLegacyV1 === true,
    allowLegacyV2: allowLegacyV2 === true,
    expectedRevisionManifest: validateExpectedDigest(expectedRevisionManifest, "expectedRevisionManifest"),
    expectedEvidenceRoot: validateExpectedDigest(expectedEvidenceRoot, "expectedEvidenceRoot")
  };
  const input = path.resolve(inputPath);
  const inputMetadata = await lstat(input);
  if (inputMetadata.isSymbolicLink()) fail("The supplied bundle path must not be a symbolic link or junction");
  let root;
  let manifestPath;
  if (inputMetadata.isDirectory()) {
    root = input;
    manifestPath = path.join(root, MANIFEST_NAME);
  } else if (inputMetadata.isFile() && path.basename(input) === MANIFEST_NAME) {
    root = path.dirname(input);
    manifestPath = input;
  } else {
    fail("Supply a bundle directory or its root " + MANIFEST_NAME);
  }

  const rootReal = await realpath(root);
  const manifestMetadata = await assertRegularConfinedFile(rootReal, manifestPath, MANIFEST_NAME);
  if (manifestMetadata.size > MAX_MANIFEST_BYTES) fail(MANIFEST_NAME + " exceeds " + String(MAX_MANIFEST_BYTES) + " bytes");
  const manifestBytes = await readFile(manifestPath);
  const parsed = decodeJsonBytes(manifestBytes, MANIFEST_NAME);
  const schema = isRecord(parsed) ? parsed.schemaVersion : undefined;
  let manifest;
  let assurance;
  if (schema === MANIFEST_SCHEMA_V3) {
    const canonicalManifestBytes = Buffer.from(canonicalJsonV1(parsed) + "\n", "utf8");
    if (!Buffer.from(manifestBytes).equals(canonicalManifestBytes)) {
      fail(MANIFEST_NAME + " must use exact " + CANONICALIZATION + " bytes followed by one newline");
    }
    manifest = validateV3Manifest(parsed);
    assurance = "provenance_roots";
  } else if (schema === MANIFEST_SCHEMA_V2) {
    if (!options.allowLegacyV2) {
      fail(
        "Legacy " + MANIFEST_SCHEMA_V2 +
          " has no live-regeneration policy label or identity, and no policy is inferred; " +
          "use --allow-legacy-v2 for an explicit downgraded check"
      );
    }
    const canonicalManifestBytes = Buffer.from(canonicalJsonV1(parsed) + "\n", "utf8");
    if (!Buffer.from(manifestBytes).equals(canonicalManifestBytes)) {
      fail(MANIFEST_NAME + " must use exact " + CANONICALIZATION + " bytes followed by one newline");
    }
    manifest = validateLegacyV2Manifest(parsed);
    assurance = "provenance_roots_without_live_policy";
  } else if (schema === MANIFEST_SCHEMA_V1) {
    if (!options.allowLegacyV1) {
      fail("Legacy " + MANIFEST_SCHEMA_V1 + " can verify byte inventory only; use --allow-legacy-v1 for an explicit downgraded check");
    }
    if (options.expectedRevisionManifest !== undefined || options.expectedEvidenceRoot !== undefined) {
      fail("Trusted expected roots cannot be verified from a legacy v1 bundle");
    }
    manifest = validateLegacyManifest(parsed);
    assurance = "byte_integrity_only";
  } else {
    fail("$.schemaVersion must be " + MANIFEST_SCHEMA_V3);
  }

  const actualFiles = await walkFiles(root, rootReal);
  const actualByCollision = new Map();
  for (const relative of actualFiles) {
    const portable = relative.split(path.sep).join("/");
    if (collisionKey(portable) === collisionKey(MANIFEST_NAME)) {
      if (portable !== MANIFEST_NAME) fail("The root manifest name differs by case or normalization: " + portable);
      continue;
    }
    validateArtifactPath(portable, "filesystem path " + JSON.stringify(portable));
    const key = collisionKey(portable);
    const prior = actualByCollision.get(key);
    if (prior !== undefined) fail("Filesystem paths " + prior + " and " + portable + " collide by case/Unicode");
    actualByCollision.set(key, portable);
  }
  const expected = new Map(manifest.artifacts.map((artifact) => [collisionKey(artifact.path), artifact]));
  for (const [key, artifact] of expected) {
    const actualRelative = actualByCollision.get(key);
    if (actualRelative === undefined) fail("Manifest artifact is missing: " + artifact.path);
    if (actualRelative !== artifact.path) fail("Filesystem case/normalization differs from manifest: " + artifact.path + " vs " + actualRelative);
  }
  for (const [key, actualRelative] of actualByCollision) {
    if (!expected.has(key)) fail("Bundle contains an unlisted extra file: " + actualRelative);
  }

  let totalBytes = 0;
  for (const artifact of manifest.artifacts) {
    const absolute = path.join(root, ...artifact.path.split("/"));
    const before = await assertRegularConfinedFile(rootReal, absolute, artifact.path);
    const actual = await hashFile(absolute);
    const after = await stat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail("Artifact changed while it was being verified: " + artifact.path);
    if (actual.size !== artifact.identity.size || actual.digest !== artifact.identity.digest) {
      fail(
        "Artifact identity mismatch for " + artifact.path + ": expected " +
        artifact.identity.digest + "/" + String(artifact.identity.size) + ", received " +
        actual.digest + "/" + String(actual.size)
      );
    }
    totalBytes += actual.size;
  }

  const roots = assurance === "byte_integrity_only"
    ? undefined
    : await verifyProvenance(root, rootReal, manifest, options);
  return {
    assurance,
    bundleKind: manifest.bundleKind,
    lifecycle: manifest.lifecycle,
    projectId: manifest.projectId,
    runId: manifest.runId,
    designRevisionId: manifest.designRevisionId,
    artifactCount: manifest.artifacts.length,
    artifactBytes: totalBytes,
    ...(roots === undefined ? {} : {
      revisionManifestDigest: roots.recomputedRevision.digest,
      evidenceRootDigest: roots.recomputedEvidence.digest
    })
  };
};

const parseCli = (arguments_) => {
  const options = {};
  let inputPath;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-legacy-v1") {
      options.allowLegacyV1 = true;
    } else if (argument === "--allow-legacy-v2") {
      options.allowLegacyV2 = true;
    } else if (argument === "--expected-revision-manifest" || argument === "--expected-evidence-root") {
      const value = arguments_[index + 1];
      if (value === undefined) fail(argument + " requires a digest");
      index += 1;
      if (argument === "--expected-revision-manifest") options.expectedRevisionManifest = value;
      else options.expectedEvidenceRoot = value;
    } else if (argument.startsWith("--")) {
      fail("Unknown option " + argument);
    } else if (inputPath === undefined) {
      inputPath = argument;
    } else {
      fail("Only one bundle path may be supplied");
    }
  }
  if (inputPath === undefined) fail("A bundle path is required");
  return { inputPath, options };
};

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  const invoked = path.resolve(process.argv[1]);
  const current = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? invoked.toLocaleLowerCase("en-US") === current.toLocaleLowerCase("en-US")
    : invoked === current;
})();

if (isMain) {
  try {
    const cli = parseCli(process.argv.slice(2));
    const result = await verifyBundle(cli.inputPath, cli.options);
    if (result.assurance === "byte_integrity_only") {
      console.warn("WARNING: legacy bundle verified at byte_integrity_only assurance; roots were not recomputed.");
      console.log("Legacy bundle byte integrity verified: " + String(result.artifactCount) + " artifacts, " + String(result.artifactBytes) + " bytes.");
    } else {
      if (result.assurance === "provenance_roots_without_live_policy") {
        console.warn(
          "WARNING: legacy v2 bundle has no live-regeneration policy label or identity; no policy was inferred."
        );
        console.log(
          "Legacy v2 bundle provenance roots verified without live-policy binding: " +
            String(result.artifactCount) + " artifacts, " + String(result.artifactBytes) + " bytes, " +
            result.bundleKind + "/" + result.lifecycle + "."
        );
      } else {
        console.log(
          "Bundle provenance verified: " + String(result.artifactCount) + " artifacts, " +
          String(result.artifactBytes) + " bytes, " + result.bundleKind + "/" + result.lifecycle + "."
        );
      }
      console.log("Revision manifest: " + result.revisionManifestDigest);
      console.log("Evidence root: " + result.evidenceRootDigest);
    }
    console.log("This verifies internal inventory, byte identity, and declared provenance only; it is not proof of authenticity, safety, qualification, or release.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Bundle verification failed: " + message);
    process.exitCode = error instanceof VerificationError ? 2 : 1;
  }
}

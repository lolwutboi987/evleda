import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = path.join(packageRoot, "tests", "fixtures", "codex-cli-0.153.4-no-model-tool-profile.json");
const preflightEvidencePath = path.join(packageRoot, "tests", "fixtures", "codex-cli-0.153.4-config-preflight-transcripts.json");
const astraEvidencePath = path.join(packageRoot, "tests", "fixtures", "codex-cli-0.153.4-gpt-6-astra-no-model-tool-profile.json");
const sourcePath = path.join(packageRoot, "src", "harness", "cli-providers.ts");
const compositionSourcePath = path.join(packageRoot, "src", "flux", "production-composition.ts");
const [evidenceText, preflightEvidenceText, source, compositionSource, astraEvidenceText] = await Promise.all([
  readFile(evidencePath, "utf8"),
  readFile(preflightEvidencePath, "utf8"),
  readFile(sourcePath, "utf8"),
  readFile(compositionSourcePath, "utf8"),
  readFile(astraEvidencePath, "utf8"),
]);
const evidenceDigest = createHash("sha256").update(evidenceText, "utf8").digest("hex");

const fail = (message) => { throw new Error(`Codex CLI evidence verification failed: ${message}`); };
let evidence;
try { evidence = JSON.parse(evidenceText); } catch { fail("evidence is not JSON"); }

const exactKeys = (value, keys, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} has missing or extra fields`);
  }
};

exactKeys(evidence, [
  "schemaVersion", "captureDate", "captureBoundary", "executable", "model",
  "environmentPolicy", "isolationArguments", "originalInventoryCanonicalJson",
  "originalInventorySha256", "inventoryCanonicalJson", "inventory", "inventorySha256",
  "derivedCapabilityProfile",
], "root");
if (evidence.schemaVersion !== "evleda.codex-cli-no-model-tool-profile-evidence.v2") fail("schema version drifted");
if (evidenceDigest !== "95c5e74b5bf8744d5145c28fc0338517da65c0ca84aa0cd27e9f2b3bf370ae7a") fail("evidence artifact bytes drifted");
if (evidence.captureDate !== "2026-09-07") fail("capture date drifted");
if (evidence.captureBoundary !== "local-fake-responses-request-before-model-io") fail("capture boundary drifted");
if (evidence.model !== "gpt-5.6-sol") fail("captured model drifted");
exactKeys(evidence.executable, ["algorithm", "digest", "size", "version"], "executable");
if (evidence.executable.algorithm !== "sha256"
  || evidence.executable.digest !== "a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6"
  || evidence.executable.size !== 295408944
  || evidence.executable.version !== "codex-cli 0.153.4") fail("executable identity drifted");
exactKeys(evidence.environmentPolicy, [
  "source", "apiCredentialPresent", "externalModelRequestCompleted", "captureEndpoint",
], "environment policy");
if (evidence.environmentPolicy.source !== "production-child-allowlist"
  || evidence.environmentPolicy.apiCredentialPresent !== false
  || evidence.environmentPolicy.externalModelRequestCompleted !== false
  || evidence.environmentPolicy.captureEndpoint !== "loopback-fake-responses") fail("capture policy drifted");
if (!Array.isArray(evidence.isolationArguments)
  || evidence.isolationArguments.some((entry) => typeof entry !== "string")) fail("isolation arguments are malformed");
const originalInventoryDigest = createHash("sha256").update(evidence.originalInventoryCanonicalJson, "utf8").digest("hex");
if (originalInventoryDigest !== evidence.originalInventorySha256
  || originalInventoryDigest !== "e05f4d1a88a9b58adca4e475fe2c5a2cadabe15a354d5712d5a98a12f1c60b62") {
  fail("original captured inventory digest drifted");
}
if (JSON.stringify(evidence.inventory) !== evidence.inventoryCanonicalJson) fail("canonical inventory text drifted");
const inventoryDigest = createHash("sha256").update(evidence.inventoryCanonicalJson, "utf8").digest("hex");
if (inventoryDigest !== evidence.inventorySha256
  || inventoryDigest !== "72e35cf8ba0499e9868c26b19bdfbcbc75241e0c47b019dce15b70d1ca90a926") {
  fail("inventory digest drifted");
}
const namespaceTools = evidence.inventory.namespaces.flatMap((namespace) =>
  namespace.tools.map((tool) => tool.type === "custom" ? `${namespace.name}.${tool.name}` : tool.name));
const names = new Set([...namespaceTools, ...evidence.inventory.nestedHeadings]);
const derivedCapabilityProfile = {
  responsesRequestToolsFieldPresent: evidence.inventory.responsesRequestToolsFieldPresent,
  responsesRequestAdditionalToolsFieldPresent: evidence.inventory.responsesRequestAdditionalToolsFieldPresent,
  namespacedTools: namespaceTools,
  nestedExecTools: evidence.inventory.nestedHeadings,
  viewImage: names.has("view_image"),
  webSearch: names.has("web_search"),
  mcpResources: [...names].some((name) => name.startsWith("list_mcp_") || name === "read_mcp_resource"),
  pluginInstall: names.has("request_plugin_install"),
  collaboration: [...names].some((name) => name.startsWith("collaboration.")),
  requestUserInput: names.has("request_user_input"),
  writeSandbox: "read-only",
};
if (JSON.stringify(derivedCapabilityProfile) !== JSON.stringify(evidence.derivedCapabilityProfile)) {
  fail("derived capability profile does not match captured inventory");
}

const argumentBlock = source.match(
  /export const CODEX_CLI_ISOLATION_ARGUMENTS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\);/u,
);
if (argumentBlock === null) fail("source isolation arguments were not found");
const sourceArguments = [...argumentBlock[1].matchAll(/"(?:\\.|[^"\\])*"/gu)].map((match) => JSON.parse(match[0]));
if (JSON.stringify(sourceArguments) !== JSON.stringify(evidence.isolationArguments)) {
  fail("source isolation arguments do not match captured evidence");
}
if (!source.includes(`export const CODEX_CLI_PINNED_VERSION = ${JSON.stringify(evidence.executable.version)} as const;`)
  || !source.includes(`export const CODEX_CLI_CAPTURED_MODEL = ${JSON.stringify(evidence.model)} as const;`)
  || !source.includes(`originalInventorySha256: ${JSON.stringify(evidence.originalInventorySha256)} as const`)
  || !source.includes(`inventorySha256: ${JSON.stringify(evidence.inventorySha256)} as const`)
  || !source.includes(`inventoryCanonicalJson: ${JSON.stringify(evidence.inventoryCanonicalJson)} as const`)) {
  fail("source capability binding does not match captured evidence");
}
if (!source.includes(`digest: ${JSON.stringify(evidence.executable.digest)}`)
  || !source.includes("size: 295_408_944")) fail("source executable evidence pin drifted");
for (const [key, value] of Object.entries(evidence.derivedCapabilityProfile)) {
  const rendered = Array.isArray(value) ? JSON.stringify(value).replaceAll(",", ", ") : JSON.stringify(value);
  if (!source.includes(`${key}: ${rendered}`) && !source.includes(`${key}: Object.freeze(${rendered} as const)`)) {
    fail(`source derived capability field ${key} drifted`);
  }
}
if (/(?:[A-Za-z]:[\\/]|\\\\|file:|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\bBearer\s+)/iu.test(evidenceText)) {
  fail("evidence contains path-like or credential-like text");
}

let preflightEvidence;
try { preflightEvidence = JSON.parse(preflightEvidenceText); } catch { fail("preflight evidence is not JSON"); }
exactKeys(preflightEvidence, [
  "schemaVersion", "captureDate", "executable", "model", "toolProfileEvidenceIdentity",
  "outputSchemaIdentity", "requirements", "argumentShape", "allowedStderr",
], "preflight evidence root");
if (preflightEvidence.schemaVersion !== "evleda.codex-cli-config-preflight-transcript-evidence.v1"
  || preflightEvidence.captureDate !== "2026-09-07"
  || createHash("sha256").update(preflightEvidenceText, "utf8").digest("hex")
    !== "928f48c04819cc480aaaaf57d96010b5a9a411b5d8631c2a20fa0e83a919ca70") {
  fail("preflight evidence identity drifted");
}
if (JSON.stringify(preflightEvidence.executable) !== JSON.stringify(evidence.executable)
  || preflightEvidence.model !== evidence.model
  || preflightEvidence.toolProfileEvidenceIdentity.digest !== evidenceDigest
  || preflightEvidence.toolProfileEvidenceIdentity.size !== Buffer.byteLength(evidenceText, "utf8")) {
  fail("preflight evidence authority binding drifted");
}
if (preflightEvidence.outputSchemaIdentity.digest !== "dc8e5ef46c5eb7e6b62ea72d9fa6221e7532feb8d7064d854371a2dd4083e1be"
  || preflightEvidence.outputSchemaIdentity.schemaVersion !== "evleda.harness-cli-turn-envelope.v3") {
  fail("preflight output schema binding drifted");
}
if (JSON.stringify(preflightEvidence.requirements) !== JSON.stringify({
  exitCode: 1,
  terminationSignal: null,
  stdoutIdentity: {
    algorithm: "sha256",
    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    size: 0,
  },
  outputFile: "absent",
  schemaAfterProbe: "exact",
  stdin: "closed-without-prompt",
  externalModelRequestCompleted: false,
})) fail("preflight requirements drifted");
if (!Array.isArray(preflightEvidence.allowedStderr) || preflightEvidence.allowedStderr.length !== 2) {
  fail("preflight transcript set is not exactly bounded");
}
const transcriptSourceBlock = compositionSource.match(
  /export const FLUX_CODEX_CONFIG_PREFLIGHT_TRANSCRIPTS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\);/u,
);
if (transcriptSourceBlock === null
  || [...transcriptSourceBlock[1].matchAll(/kind:\s*"/gu)].length !== preflightEvidence.allowedStderr.length) {
  fail("source preflight transcript set is not exactly bounded");
}
for (const transcript of preflightEvidence.allowedStderr) {
  const digest = createHash("sha256").update(transcript.text, "utf8").digest("hex");
  if (transcript.identity.algorithm !== "sha256"
    || transcript.identity.digest !== digest
    || transcript.identity.size !== Buffer.byteLength(transcript.text, "utf8")
    || !transcriptSourceBlock[1].includes(`kind: ${JSON.stringify(transcript.kind)} as const`)
    || !transcriptSourceBlock[1].includes(`text: ${JSON.stringify(transcript.text)} as const`)
    || !transcriptSourceBlock[1].includes(`digest: ${JSON.stringify(digest)}`)) {
    fail(`preflight transcript ${transcript.kind} drifted`);
  }
}
if (/(?:[A-Za-z]:[\\/]|\\\\|file:|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\bBearer\s+)/iu.test(preflightEvidenceText)) {
  fail("preflight evidence contains path-like or credential-like text");
}

// Astra is additive evidence. The historical Sol artifact, profile, and no-prompt transcripts above stay pinned.
let astra;
try { astra = JSON.parse(astraEvidenceText); } catch { fail("Astra evidence is not JSON"); }
exactKeys(astra, [
  "schemaVersion", "captureDate", "captureBoundary", "executable", "model", "environmentPolicy", "isolationArguments",
  "toolInventoryLocation", "inventoryCanonicalJson", "inventory", "inventorySha256", "derivedCapabilityProfile",
  "outputSchemaIdentity", "observedRequestSettings", "captureOnlyArgumentOverrides", "provenance",
], "Astra root");
if (astra.schemaVersion !== "evleda.codex-cli-no-model-tool-profile-evidence.v3" || astra.captureDate !== "2026-09-09"
  || astra.captureBoundary !== "local-fake-responses-request-before-model-io" || astra.model !== "gpt-6-astra"
  || createHash("sha256").update(astraEvidenceText, "utf8").digest("hex") !== "2045fd617331237da3effb0560e5de0af08e745f55964dc0c023d5c2bcd9c504"
  || Buffer.byteLength(astraEvidenceText, "utf8") !== 8343) fail("Astra evidence artifact identity drifted");
if (JSON.stringify(astra.executable) !== JSON.stringify(evidence.executable)
  || JSON.stringify(astra.isolationArguments) !== JSON.stringify(sourceArguments)) fail("Astra binary or isolation authority drifted");
if (JSON.stringify(astra.environmentPolicy) !== JSON.stringify({
  source: "production-child-allowlist", apiCredentialPresent: false, externalModelRequestCompleted: false,
  captureEndpoint: "loopback-fake-responses", configRoot: "fresh-empty-private", proxyVariablesPresent: false,
})) fail("Astra capture environment policy drifted");
const astraInventoryDigest = createHash("sha256").update(astra.inventoryCanonicalJson, "utf8").digest("hex");
if (astraInventoryDigest !== "50b441dad797ab840c90c3185d680d0a029fadad930f195c6e368b3a985def0d"
  || astraInventoryDigest !== astra.inventorySha256 || JSON.stringify(astra.inventory) !== astra.inventoryCanonicalJson
  || astra.inventory.model !== astra.model || astra.toolInventoryLocation !== "request.input[type=additional_tools].tools") fail("Astra inventory authority drifted");
const astraNamespacedTools = astra.inventory.namespaces.flatMap((namespace) => namespace.tools.map((tool) => tool.type === "custom" ? `${namespace.name}.${tool.name}` : tool.name));
const astraFullyQualifiedTools = astra.inventory.namespaces.flatMap((namespace) => namespace.tools.map((tool) => `${namespace.name}.${tool.name}`));
const astraNames = new Set([...astraNamespacedTools, ...astra.inventory.nestedHeadings]);
const astraDerived = {
  responsesRequestToolsFieldPresent: astra.inventory.responsesRequestToolsFieldPresent,
  responsesRequestAdditionalToolsFieldPresent: astra.inventory.responsesRequestAdditionalToolsFieldPresent,
  namespacedTools: astraNamespacedTools,
  nestedExecTools: astra.inventory.nestedHeadings,
  viewImage: astraNames.has("view_image"), webSearch: astraNames.has("web_search"),
  mcpResources: [...astraNames].some((name) => name.startsWith("list_mcp_") || name === "read_mcp_resource"),
  pluginInstall: astraNames.has("request_plugin_install"), collaboration: astraFullyQualifiedTools.some((name) => name.startsWith("collaboration.")),
  requestUserInput: astraNames.has("request_user_input") || astraNames.has("request_user_input_async"), writeSandbox: "read-only",
  fullyQualifiedTools: astraFullyQualifiedTools,
  clockSleep: astraFullyQualifiedTools.includes("clock.sleep"), clockCurrentTime: astraNames.has("clock__curr_time"),
};
if (JSON.stringify(astraDerived) !== JSON.stringify(astra.derivedCapabilityProfile)) fail("Astra derived capabilities differ from its captured inventory");
if (astra.outputSchemaIdentity.digest !== preflightEvidence.outputSchemaIdentity.digest
  || astra.outputSchemaIdentity.schemaVersion !== preflightEvidence.outputSchemaIdentity.schemaVersion
  || astra.outputSchemaIdentity.canonicalizationVersion !== preflightEvidence.outputSchemaIdentity.canonicalizationVersion
  || astra.outputSchemaIdentity.algorithm !== "sha256" || astra.outputSchemaIdentity.size !== 594) fail("Astra output schema authority drifted");
if (JSON.stringify(astra.observedRequestSettings) !== JSON.stringify({
  reasoningFieldPresent: true, reasoning: { effort: "low", context: "all_turns" }, textVerbosity: "low",
  strictOutputSchema: true, schemaName: "codex_output_schema", toolChoice: "auto", parallelToolCalls: false,
  store: false, stream: true, include: ["reasoning.encrypted_content"], unsupportedSamplingFieldsPresent: [], serviceTierFieldPresent: false,
})) fail("Astra observed request settings drifted");
if (astra.provenance.accountModelAccessProven !== false || astra.provenance.noExplicitReasoningEffortArgument !== true
  || astra.provenance.noUserConfigurationFallback !== true || astra.provenance.noGlobalConfigurationChange !== true
  || astra.provenance.historicalSolEvidenceIdentity.digest !== evidenceDigest
  || astra.provenance.historicalSolEvidenceIdentity.size !== Buffer.byteLength(evidenceText, "utf8")
  || astra.provenance.solControlInventorySha256 !== inventoryDigest
  || astra.provenance.solControlReproducesHistoricalInventoryExactly !== true) fail("Astra capture provenance or Sol control drifted");
const astraProfileBlock = source.match(/export const CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE = Object\.freeze\(\{([\s\S]*?)\n\}\);/u)?.[1];
if (astraProfileBlock === undefined
  || !source.includes(`export const CODEX_CLI_ASTRA_CAPTURED_MODEL = ${JSON.stringify(astra.model)} as const;`)
  || !astraProfileBlock.includes('schemaVersion: "evleda.codex-cli-captured-tool-profile.v3" as const')
  || !astraProfileBlock.includes("model: CODEX_CLI_ASTRA_CAPTURED_MODEL,")
  || !astraProfileBlock.includes(`inventorySha256: ${JSON.stringify(astraInventoryDigest)} as const`)
  || !astraProfileBlock.includes(`inventoryCanonicalJson: ${JSON.stringify(astra.inventoryCanonicalJson)} as const`)
  || !astraProfileBlock.includes(`toolInventoryLocation: ${JSON.stringify(astra.toolInventoryLocation)} as const`)
  || !astraProfileBlock.includes(`toolChoice: ${JSON.stringify(astra.inventory.toolChoice)} as const`)) fail("Astra source capture binding drifted");
for (const [key, value] of Object.entries(astraDerived)) {
  const rendered = Array.isArray(value) ? JSON.stringify(value).replaceAll(",", ", ") : JSON.stringify(value);
  if (!astraProfileBlock.includes(`${key}: ${rendered} as const`) && !astraProfileBlock.includes(`${key}: Object.freeze(${rendered} as const)`)) fail(`Astra source derived capability field ${key} drifted`);
}
const modelMap = source.match(/const CODEX_CLI_CAPTURED_TOOL_PROFILES = Object\.freeze\(\{([\s\S]*?)\n\}\);/u)?.[1];
if (modelMap === undefined || [...modelMap.matchAll(/\]:/gu)].length !== 2
  || !modelMap.includes("[CODEX_CLI_CAPTURED_MODEL]: CODEX_CLI_CAPTURED_TOOL_PROFILE,")
  || !modelMap.includes("[CODEX_CLI_ASTRA_CAPTURED_MODEL]: CODEX_CLI_ASTRA_CAPTURED_TOOL_PROFILE,")) fail("Captured model lookup differs from the two explicit receipts");
if (/(?:[A-Za-z]:[\\/]|\\\\|file:|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}|\bBearer\s+)/iu.test(astraEvidenceText)) fail("Astra evidence contains native paths or credential-like text");

console.log(
  `Verified Codex CLI no-model tool-profile evidence sha256:${inventoryDigest}: `
  + `${evidence.inventory.namespaces[0].tools.length} residual namespaced tools, `
  + `${evidence.inventory.nestedHeadings.length} nested heading.`,
);
console.log(
  `Verified Codex CLI config-preflight evidence: ${preflightEvidence.allowedStderr.length} exact transcripts, `
  + "empty stdout, exact schema, absent output, no model I/O.",
);
console.log(`Verified additive Astra no-model evidence sha256:${astraInventoryDigest}: exact residual input/clock capabilities; account access remains unproven.`);

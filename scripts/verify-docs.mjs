#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.EVLEDA_DOCS_VERIFY_ROOT === undefined
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  : path.resolve(process.env.EVLEDA_DOCS_VERIFY_ROOT);
const operations = [
  "create_project",
  "start_design_run",
  "get_run_status",
  "inspect_requirements",
  "approve_requirements",
  "resume_run",
  "list_artifacts",
  "inspect_evidence",
  "inspect_engineering_practices",
  "rerun_stage",
  "export_candidate_bundle",
  "export_prototype_bundle",
  "generate_bringup_plan",
  "generate_firmware_scaffold"
];
const canonicalRestRoutes = [
  "POST /api/v1/projects",
  "POST /api/v1/projects/{projectId}/runs",
  "GET /api/v1/runs/{runId}",
  "GET /api/v1/runs/{runId}/requirements",
  "POST /api/v1/runs/{runId}/requirements/approval",
  "POST /api/v1/runs/{runId}/resume",
  "GET /api/v1/runs/{runId}/artifacts",
  "GET /api/v1/runs/{runId}/evidence",
  "GET /api/v1/runs/{runId}/engineering-practices",
  "POST /api/v1/runs/{runId}/stages/{stage}/rerun",
  "POST /api/v1/revisions/{revisionId}/exports/candidate",
  "POST /api/v1/revisions/{revisionId}/exports/prototype",
  "POST /api/v1/revisions/{revisionId}/generations/bringup-plan",
  "POST /api/v1/revisions/{revisionId}/generations/firmware-scaffold"
];
const localHumanRoutes = [
  "POST /api/v1/revisions/{revisionId}/external-evidence",
  "POST /api/v1/revisions/{revisionId}/qualification",
  "POST /api/v1/revisions/{revisionId}/manufacturing-release",
  "POST /api/v1/attestations/{approvalId}/revocation"
];
const stages = [
  "requirements",
  "system_architecture",
  "component_selection",
  "schematic",
  "firmware_contract",
  "simulation_checks",
  "pcb_placement_routing",
  "manufacturing_package",
  "bringup_package"
];
const requiredDocuments = [
  "README.md",
  "HANDOFF.md",
  "docs/product-contract.md",
  "docs/architecture.md",
  "docs/api.md",
  "docs/security-model.md",
  "docs/acceptance-matrix.md",
  "docs/pcb-engineering-practices.md",
  "docs/agent-pcb-design-instructions.md"
];

const errors = [];
const read = async (relative) => {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    errors.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
};

const documents = new Map();
for (const relative of requiredDocuments) documents.set(relative, await read(relative));

const operationSource = await read("src/contracts/operations.ts");
const operationBlock = operationSource.match(
  /export const OPERATION_NAMES = \[(?<body>[\s\S]*?)\] as const;/u
);
const implementationOperations = operationBlock === null
  ? []
  : [...operationBlock.groups.body.matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]);
if (JSON.stringify(implementationOperations) !== JSON.stringify(operations)) {
  errors.push(
    `Documentation verifier operation inventory differs from src/contracts/operations.ts: ` +
    `${operations.length} documented versus ${implementationOperations.length} implemented`
  );
}

const apiServerSource = await read("src/api/server.ts");
const routeBlock = apiServerSource.match(
  /export const API_OPERATION_ROUTES = \[(?<body>[\s\S]*?)\] as const;/u
);
const implementationRoutes = routeBlock === null
  ? []
  : [...routeBlock.groups.body.matchAll(
      /\["(GET|POST)",\s*"([^"]+)",\s*"([a-z0-9_]+)"\]/gu
    )].map((match) => ({
      operation: match[3],
      route: `${match[1]} ${match[2].replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}")}`
    }));
if (
  JSON.stringify(implementationRoutes.map((entry) => entry.operation)) !==
  JSON.stringify(operations)
) {
  errors.push("API operation routes differ from the authoritative operation inventory");
}
if (
  JSON.stringify(implementationRoutes.map((entry) => entry.route)) !==
  JSON.stringify(canonicalRestRoutes)
) {
  errors.push("Documentation verifier REST routes differ from src/api/server.ts");
}

const api = documents.get("docs/api.md") ?? "";
for (const operation of operations) {
  const headings = [...api.matchAll(new RegExp("^### `" + operation + "`$", "gmu"))];
  if (headings.length !== 1) {
    errors.push(`docs/api.md must contain exactly one level-three heading for ${operation}; found ${headings.length}`);
  }
}
const operationHeadings = [...api.matchAll(/^### `([a-z0-9_]+)`$/gmu)].map((match) => match[1]);
const unexpectedOperations = operationHeadings.filter((operation) => !operations.includes(operation));
if (operationHeadings.length !== operations.length || unexpectedOperations.length > 0) {
  errors.push(
    `docs/api.md public operation headings must be exactly the ${operations.length}-operation contract; found ${operationHeadings.length}`
  );
}
for (const operation of operations) {
  const rows = [...api.matchAll(new RegExp("^\\| `" + operation + "` \\|", "gmu"))];
  if (rows.length !== 1) {
    errors.push(`docs/api.md must contain exactly one operation-table row for ${operation}; found ${rows.length}`);
  }
}
if (!api.includes("/api/v1")) errors.push("docs/api.md must document the /api/v1 REST root");
for (const route of [...canonicalRestRoutes, ...localHumanRoutes]) {
  if (!api.includes(route)) errors.push(`docs/api.md is missing canonical route: ${route}`);
}
for (const obsolete of [
  "/api/v1/runs/{runId}/evidence/{evidenceId}",
  "/api/v1/runs/{runId}/exports/candidate",
  "/api/v1/runs/{runId}/exports/prototype",
  "/api/v1/runs/{runId}/bringup-plan",
  "/api/v1/runs/{runId}/firmware-scaffold"
]) {
  if (api.includes(obsolete)) errors.push(`docs/api.md contains obsolete route: ${obsolete}`);
}

for (const [relative, content] of documents) {
  for (const line of content.split(/\r?\n/u)) {
    if (/\b(?:TBD|FIXME)\b/u.test(line)) {
      errors.push(`${relative} contains an unresolved placeholder: ${line.trim()}`);
    }
    if (/\bTODO\b/u.test(line) && !/\b(?:P2\s+TODO|1\s+todo|it\.todo)\b/iu.test(line)) {
      errors.push(`${relative} contains an unresolved placeholder: ${line.trim()}`);
    }
  }
  if (relative !== "docs/acceptance-matrix.md" && /\b(?:safe|certified)\b/iu.test(content)) {
    // These words are permitted only as explicit non-claims. Catch affirmative-looking phrasing manually below.
    for (const line of content.split(/\r?\n/u)) {
      if (/\b(?:is|are|proves?|guarantees?)\s+(?:electrically\s+)?safe\b/iu.test(line)) {
        errors.push(`${relative} contains an affirmative safety claim: ${line.trim()}`);
      }
    }
  }
}

const architecture = documents.get("docs/architecture.md") ?? "";
const product = documents.get("docs/product-contract.md") ?? "";
for (const stage of stages) {
  if (!architecture.includes(`\`${stage}\``)) errors.push(`docs/architecture.md is missing stage ${stage}`);
  if (!product.includes(`\`${stage}\``)) errors.push(`docs/product-contract.md is missing stage ${stage}`);
}

const combined = [...documents.values()].join("\n");
const normalizeWhitespace = (value) => value.replace(/\s+/gu, " ").trim();
const apiNormalized = normalizeWhitespace(api);
const apiSection = (heading, nextHeading) => {
  const start = api.indexOf(heading);
  const end = start < 0 ? -1 : api.indexOf(nextHeading, start + heading.length);
  return start < 0 || end < 0 ? "" : api.slice(start, end);
};
const engineeringApiSection = normalizeWhitespace(
  apiSection("### `inspect_engineering_practices`", "### `rerun_stage`")
);
const firmwareApiSection = normalizeWhitespace(
  apiSection("### `generate_firmware_scaffold`", "## Local-human-only REST operations")
);
const physicalApiSection = normalizeWhitespace(
  apiSection("### Submit external physical evidence", "### Qualify a revision")
);
for (const literal of [
  "revisionId: string | null",
  "null` before any head"
]) {
  if (!engineeringApiSection.includes(literal)) {
    errors.push(`docs/api.md engineering inspection section is missing: ${literal}`);
  }
}
for (const literal of [
  "current implementation supports only `c`; `cpp` or `rust` returns `GATE_FAILED`"
]) {
  if (!firmwareApiSection.includes(literal)) {
    errors.push(`docs/api.md firmware section is missing current availability text: ${literal}`);
  }
}
for (const literal of [
  "targetBuildReport",
  "targetBinary",
  "required_capture",
  "supporting_attachment",
  "The legacy `firmwareBuild` binding and `raw_observation` role are accepted only when inspecting or exactly replaying the legacy physical-v2 shape; a fresh v3-eligible submission using them fails closed."
]) {
  if (!physicalApiSection.includes(literal)) {
    errors.push(`docs/api.md external-evidence section is missing current boundary text: ${literal}`);
  }
}
for (const legacyExample of ['"firmwareBuild":', '"raw_observation"']) {
  if (physicalApiSection.includes(legacyExample)) {
    errors.push(`docs/api.md current request example contains legacy-only shape: ${legacyExample}`);
  }
}
if (!apiNormalized.includes("system-architecture decision IR/compiler is likewise isolated Phase-A infrastructure")) {
  errors.push("docs/api.md must state that the system-architecture IR/compiler is isolated Phase-A infrastructure");
}
for (const warning of [
  "CANDIDATE — NOT FOR MANUFACTURING",
  "PROTOTYPE — NOT PRODUCTION RELEASED",
  "evleda.bundle-manifest.v3",
  "evleda.bundle-export-replay.v2",
  "evleda.live-regeneration-policy.v1",
  "deterministic-zip-v3",
  "evleda-c14n-json-v1"
]) {
  if (!combined.includes(warning)) errors.push(`Documentation is missing required literal: ${warning}`);
}

for (const [relative, content] of documents) {
  if (/\b(?:thirteen|13)[ -](?:operation|tool)/iu.test(content)) {
    errors.push(`${relative} contains stale thirteen-operation wording`);
  }
  if (/(?:new|fresh|current)(?: candidate and prototype)? exports use[^\n]*evleda\.bundle-manifest\.v2/iu.test(content)) {
    errors.push(`${relative} still presents bundle-manifest v2 as the current export schema`);
  }
  if (/manifest (?:has|uses)[^\n]*evleda\.bundle-manifest\.v2/iu.test(content)) {
    errors.push(`${relative} still presents bundle-manifest v2 as current`);
  }
  if (/zero[^\n]{0,60}routing findings/iu.test(content)) {
    errors.push(`${relative} conflates the expected-negative reference fixture with clean routing`);
  }
}

for (const literal of [
  "--allow-legacy-v2",
  "provenance_roots_without_live_policy",
  "expected-negative",
  "BLOCKED_DIAGNOSTIC",
  "ROUTE_STYLE",
  "BACKTRACK",
  "proposal_only",
  "not_evaluated",
  "state.invocations",
  "verified-private-toolchain-closure",
  "evleda.physical-acceptance.v2",
  "evleda.physical-measurements.v2",
  "evleda.human-physical-evidence.v3"
]) {
  if (!combined.includes(literal)) errors.push(`Documentation is missing current-contract literal: ${literal}`);
}

for (const relative of [
  "README.md",
  "HANDOFF.md",
  "docs/product-contract.md",
  "docs/architecture.md",
  "docs/api.md",
  "docs/security-model.md",
  "docs/acceptance-matrix.md"
]) {
  const content = documents.get(relative) ?? "";
  for (const literal of ["evleda.bundle-manifest.v3", "evleda.bundle-export-replay.v2"]) {
    if (!content.includes(literal)) errors.push(`${relative} is missing current bundle contract: ${literal}`);
  }
}

const nativePracticeRelations = new Map([
  ["README.md", "Native cleanliness and EvlEDA's route-practice policy are separate checks"],
  ["HANDOFF.md", "Those native-clean results intentionally coexist with an `expected_negative` proof-fixture result under the independent EvlEDA route-quality policy"],
  ["docs/product-contract.md", "Native KiCad DRC can pass while the separate EvlEDA engineering-practice analyzer reports blocking `ROUTE_STYLE` and `BACKTRACK` findings"],
  ["docs/architecture.md", "Native DRC success does not clear or override a failed, unknown, or not-run practice rule"],
  ["docs/api.md", "Native DRC pass does not imply EvlEDA-practice pass"],
  ["docs/security-model.md", "The source-bound EvlEDA engineering-practice analyzer is a separate `evleda_check`; neither result substitutes for the other"],
  ["docs/acceptance-matrix.md", "its clean native DRC can coexist with blocking EvlEDA `ROUTE_STYLE` and `BACKTRACK` practice findings"]
]);
for (const [relative, relation] of nativePracticeRelations) {
  if (!normalizeWhitespace(documents.get(relative) ?? "").includes(relation)) {
    errors.push(`${relative} is missing the required non-substitution relation between native DRC and EvlEDA practice`);
  }
}

const requireDocumentRelations = (label, relations) => {
  for (const [relative, relation] of relations) {
    if (!normalizeWhitespace(documents.get(relative) ?? "").includes(relation)) {
      errors.push(`${relative} is missing the required ${label} relation`);
    }
  }
};

requireDocumentRelations("broad-goal/constrained-current", new Map([
  ["README.md", "It does not yet generate arbitrary hardware topology."],
  ["HANDOFF.md", "It does not yet generate arbitrary topology."],
  ["docs/product-contract.md", "v0 does not generate arbitrary validated topologies"],
  ["docs/architecture.md", "it does not yet generate arbitrary validated topologies"],
  ["docs/acceptance-matrix.md", "broad agentic hardware-development goal from the narrower constrained current implementation"]
]));

requireDocumentRelations("unimplemented invocation-ledger", new Map([
  ["README.md", "no production application writer populates the state schema's reserved `ToolInvocationRecord` map"],
  ["HANDOFF.md", "reserved first-class invocation map has no production writer"],
  ["docs/product-contract.md", "application workflows have no writer for the first-class invocation ledger"],
  ["docs/architecture.md", "application write paths do not populate them; W-08 therefore remains unverified"],
  ["docs/security-model.md", "`state.invocations` map has no application production writer and is not yet a first-class durable invocation ledger"],
  ["docs/acceptance-matrix.md", "no production writer populates `state.invocations`"]
]));

requireDocumentRelations("unintegrated Phase-A", new Map([
  ["README.md", "That subsystem is not wired into the application factory/service, REST, MCP, or React UI, and production composition has no default live provider."],
  ["HANDOFF.md", "They are not wired into the application factory/service, REST, MCP, or UI, and there is no default live provider."],
  ["docs/product-contract.md", "This subsystem is not yet composed into the application or factory, exposed through REST or MCP, surfaced in a UI, or backed by a default provider."],
  ["docs/architecture.md", "The coordinator is not a fifteenth shared application operation. It is not composed into the application or factory, exposed by REST or MCP, surfaced in the UI, or supplied with a default provider."],
  ["docs/api.md", "The standalone design-agent coordinator is not a fifteenth REST/MCP operation and is not composed into the application command layer."],
  ["docs/security-model.md", "implemented Phase-A scaffolding and architecture IR, but is not wired into the application factory, REST, MCP, or UI and has no default live provider."],
  ["docs/acceptance-matrix.md", "Production stage execution uses the agent stack through a reviewed default live provider"]
]));

requireDocumentRelations("incomplete physical acceptance/no current release", new Map([
  ["README.md", "The canonical Rev-A repository has no real built-board acceptance record, hardware qualification, or manufacturing release."],
  ["HANDOFF.md", "the canonical reference has no real physical-acceptance record, qualification, or release."],
  ["docs/product-contract.md", "Production policy is still incomplete, and no current Rev-A record is qualified or release-authorized."],
  ["docs/architecture.md", "production collection and acceptance policy remain incomplete. Validator support alone does not qualify hardware, and no current Rev-A fixture is qualified or release-authorized."],
  ["docs/api.md", "No real current-board physical record, qualification, or manufacturing release is claimed."],
  ["docs/security-model.md", "No real Rev-A physical record, qualification, or manufacturing release exists."],
  ["docs/acceptance-matrix.md", "`approvalStatus: incomplete`; no real current qualification or manufacturing release exists."]
]));

const architectureNormalized = normalizeWhitespace(architecture);
const phaseAgentStart = architecture.indexOf("## Standalone Phase-A design-agent boundary");
const phaseAgentEnd = phaseAgentStart < 0
  ? -1
  : architecture.indexOf("## KiCad-MCP sidecar boundary", phaseAgentStart);
const phaseAgentNormalized = phaseAgentStart < 0 || phaseAgentEnd < 0
  ? ""
  : normalizeWhitespace(architecture.slice(phaseAgentStart, phaseAgentEnd));
for (const literal of [
  "requirements_analyst",
  "system_architect",
  "component_engineer",
  "schematic_engineer",
  "firmware_contract_engineer",
  "simulation_engineer",
  "pcb_layout_engineer",
  "manufacturing_engineer",
  "bringup_engineer",
  "evleda.design-agent-prompt-pack.v2",
  "evleda.design-agent-proposal.v2",
  "evleda.design-agent-proposal-output-contract.v2",
  "evleda.design-agent-result.v2",
  "evleda.design-agent-replay.v2",
  "not composed into the application or factory",
  "not a fifteenth shared application operation"
]) {
  if (!phaseAgentNormalized.includes(literal)) {
    errors.push(`docs/architecture.md is missing Phase-A boundary text: ${literal}`);
  }
}
for (const literal of [
  "original unlabeled manifest-v2/replay-v1 pair",
  "evleda.bundle-export-replay.v1",
  'result.manifest.schemaVersion === "evleda.bundle-manifest.v2"',
  "exactInputs` are exactly `[revisionManifest, evidenceRoot]",
  "v2 manifest has no manifest-level `exactInputs`",
  "neither the result nor manifest has policy fields",
  "deterministic-zip-v2",
  "Replay returns the historical result unchanged, without synthesizing policy",
  "Labeled v2, crossed receipt/manifest versions, and hybrids fail closed",
  "evleda.bundle-manifest.v3` returns `provenance_roots` with no downgrade warning",
  "evleda.bundle-manifest.v2` requires `--allow-legacy-v2`, returns `provenance_roots_without_live_policy`",
  "WARNING: legacy v2 bundle has no live-regeneration policy label or identity; no policy was inferred.",
  "evleda.bundle-manifest.v1` requires `--allow-legacy-v1`, returns `byte_integrity_only`",
  "WARNING: legacy bundle verified at byte_integrity_only assurance; roots were not recomputed."
]) {
  if (!architectureNormalized.includes(literal)) {
    errors.push(`docs/architecture.md is missing exact legacy compatibility text: ${literal}`);
  }
}
const securityNormalized = normalizeWhitespace(documents.get("docs/security-model.md") ?? "");
if (!securityNormalized.includes("as-built-record age at 90 days")) {
  errors.push("docs/security-model.md must document the enforced 90-day as-built-record age limit");
}
for (const relative of [
  "README.md",
  "HANDOFF.md",
  "docs/product-contract.md",
  "docs/architecture.md",
  "docs/api.md",
  "docs/security-model.md"
]) {
  if (!(documents.get(relative) ?? "").includes("deterministic-zip-v3")) {
    errors.push(`${relative} is missing the current deterministic-zip-v3 profile`);
  }
}
for (const relative of [
  "README.md",
  "HANDOFF.md",
  "docs/product-contract.md",
  "docs/architecture.md",
  "docs/api.md",
  "docs/security-model.md",
  "docs/acceptance-matrix.md"
]) {
  const content = documents.get(relative) ?? "";
  if (!content.includes("expected-negative") || !content.includes("BLOCKED_DIAGNOSTIC")) {
    errors.push(`${relative} must preserve the expected-negative BLOCKED_DIAGNOSTIC reference status`);
  }
  for (const literal of ["native", "DRC", "EvlEDA", "practice"]) {
    if (!content.includes(literal)) {
      errors.push(`${relative} is missing native-DRC/EvlEDA-practice separation text: ${literal}`);
    }
  }
}
for (const securityLiteral of [
  "X-EvlEDA-Human-Credential",
  "EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL",
  "EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL",
  "EVLEDA_MANUFACTURING_RELEASE_CREDENTIAL",
  "createHumanCredentialBindings",
  "effectiveLifecycle",
  "activeAttestations"
]) {
  if (!combined.includes(securityLiteral)) {
    errors.push(`Documentation is missing human-boundary literal: ${securityLiteral}`);
  }
}
if (combined.includes("X-EvlEDA-Human-Approval-Token")) {
  errors.push("Documentation still advertises the obsolete shared human approval header");
}

const matrix = documents.get("docs/acceptance-matrix.md") ?? "";
for (const status of ["SOFTWARE-COMPLETE", "UNVERIFIED", "HARDWARE/HUMAN-ONLY"]) {
  if (!matrix.includes(status)) errors.push(`docs/acceptance-matrix.md is missing status ${status}`);
}
const acceptanceRows = [...matrix.matchAll(
  /^\| ([A-Z]+-\d{2}) \| ([^|]*) \| ([^|]*) \| (SOFTWARE-COMPLETE|UNVERIFIED|HARDWARE\/HUMAN-ONLY) \|$/gmu
)].map((match) => ({
  id: match[1],
  requirement: match[2].trim(),
  evidence: match[3].trim(),
  status: match[4]
}));
const rowById = new Map(acceptanceRows.map((row) => [row.id, row]));
const ids = acceptanceRows.map((row) => row.id);
const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
if (duplicateIds.length > 0) errors.push(`Acceptance IDs are duplicated: ${duplicateIds.join(", ")}`);
if (ids.length < 60) errors.push(`Acceptance matrix is unexpectedly incomplete: only ${ids.length} requirement rows`);

const requireAcceptance = (id, status, requiredText) => {
  const row = rowById.get(id);
  if (row === undefined) {
    errors.push(`Acceptance matrix is missing required row ${id}`);
    return;
  }
  if (row.status !== status) {
    errors.push(`Acceptance row ${id} must be ${status}; found ${row.status}`);
  }
  const rowText = `${row.requirement} ${row.evidence}`;
  for (const text of requiredText) {
    if (!rowText.includes(text)) errors.push(`Acceptance row ${id} is missing required text: ${text}`);
  }
};

requireAcceptance("P-14", "UNVERIFIED", ["approvalStatus", "approved", "qualification", "release"]);
requireAcceptance("P-15", "SOFTWARE-COMPLETE", ["broad agentic", "narrower constrained", "unintegrated Phase-A"]);
requireAcceptance("W-03", "SOFTWARE-COMPLETE", ["Every-content-boundary application fault injection", "partial stage output never becomes current"]);
requireAcceptance("W-08", "UNVERIFIED", ["no production writer populates `state.invocations`", "end-to-end success/failure/timeout/restart"]);
requireAcceptance("C-18", "SOFTWARE-COMPLETE", ["fourteen"]);
requireAcceptance("C-20", "SOFTWARE-COMPLETE", ["Phase-A agent scaffolding", "system-architecture decision IR", "deterministic-validator", "replay boundaries"]);
requireAcceptance("C-21", "UNVERIFIED", ["default live provider", "application", "API/MCP", "UI"]);
requireAcceptance("A-22", "SOFTWARE-COMPLETE", ["inspect_engineering_practices"]);
requireAcceptance("E-08", "SOFTWARE-COMPLETE", ["traceable", "not reproducible"]);
requireAcceptance("E-11", "SOFTWARE-COMPLETE", ["strict v2 contracts", "strict v3", "legacy physical v2", "candidate-only"]);
requireAcceptance("K-08", "SOFTWARE-COMPLETE", ["evleda.bundle-manifest.v3"]);
requireAcceptance("K-11", "SOFTWARE-COMPLETE", ["Native KiCad DRC", "engineering-practice"]);
requireAcceptance("T-03", "SOFTWARE-COMPLETE", ["transition"]);
requireAcceptance("T-15", "SOFTWARE-COMPLETE", ["scripts/check.mjs"]);
requireAcceptance("T-17", "SOFTWARE-COMPLETE", ["candidate-only", "private toolchain closure", "LTO/linker plugins disabled", "no flash or release authority"]);

const matrixNormalized = normalizeWhitespace(matrix);
for (const literal of [
  "Current P-14 truth: the reference physical-acceptance policy still reports `approvalStatus: incomplete`; no real current qualification or manufacturing release exists.",
  "Durable file locks bind PID plus OS process-start identity on Windows, Linux, macOS, and FreeBSD. Other platforms, including AIX and Solaris, are outside the durable-lock support boundary and reject admission before helper execution or claim creation. Legacy v1 PID-only locks remain conservatively readable during recovery; they are never upgraded by guessing an incarnation."
]) {
  if (!matrixNormalized.includes(literal)) errors.push(`Acceptance matrix is missing exact status caveat: ${literal}`);
}

const readme = documents.get("README.md") ?? "";
const handoff = documents.get("HANDOFF.md") ?? "";
const settledCountPatterns = [
  ["full check", /65\/65[^.]{0,120}929 pass(?:ed)?[^.]{0,80}1 (?:intentional )?skip[^.]{0,80}1 todo[^.]{0,80}0 fail/iu],
  ["UI typecheck and Vitest", /UI (?:TypeScript|`tsc`)[^.]{0,50}pass(?:ed|es)?[^.]{0,80}UI Vitest[^.]{0,50}10\/10[^.]{0,50}33\/33/iu],
  ["Playwright", /Playwright[^.]{0,80}5\/5/iu],
  ["real KiCad/reference", /KiCad\/reference[^.]{0,80}4\/4[^.]{0,80}76\/76/iu],
  ["Arm firmware", /32 pass(?:ed)?[^.]{0,120}1 intentional[^.]{0,120}EVLEDA_FIRMWARE_CC/iu],
  ["audited kicad-mcp", /kicad-mcp[^.]{0,80}5\/5/iu],
  ["focused evidence/bundle", /evidence(?: and |\/)bundle[^.]{0,100}3\/3[^.]{0,80}43\/43/iu],
  ["standalone bundle adversarial", /(?:bundle(?:-verifier)? adversarial[^.]{0,100}35\/35|35\/35[^.]{0,100}bundle(?:-verifier)? adversarial)/iu],
  ["production build", /(?:production build[^.]{0,80}92[- ]modules?|92[- ]modules?[^.]{0,80}production build)/iu]
];
for (const [relative, content] of [
  ["README.md", readme],
  ["HANDOFF.md", handoff],
  ["docs/acceptance-matrix.md", matrix]
]) {
  if (!content.includes("2026-09-05")) errors.push(`${relative} is missing the settled verification date`);
  const normalized = normalizeWhitespace(content);
  for (const [label, pattern] of settledCountPatterns) {
    if (!pattern.test(normalized)) errors.push(`${relative} is missing settled ${label} counts`);
  }
}
for (const stale of [
  /43 Vitest files/iu,
  /334 pass/iu,
  /bundle[^\n]*14\/14/iu,
  /Playwright[^\n]*4\/4/iu,
  /reference KiCad[^\n]*37\/37/iu
]) {
  if (stale.test(`${handoff}\n${matrix}`)) errors.push(`Documentation contains a stale verification count: ${stale}`);
}

const pcbReport = documents.get("docs/pcb-engineering-practices.md") ?? "";
const pcbInstructions = documents.get("docs/agent-pcb-design-instructions.md") ?? "";
if (!pcbReport.includes("agent-pcb-design-instructions.md")) {
  errors.push("PCB engineering report must link to the agent PCB instructions");
}
if (!pcbInstructions.includes("pcb-engineering-practices.md")) {
  errors.push("Agent PCB instructions must link to the engineering report");
}
for (const literal of [
  "PASS",
  "FAIL",
  "UNKNOWN",
  "NOT_RUN",
  "fabricator confirmation",
  "human review",
  "physical test",
  "proof fixture"
]) {
  if (!pcbReport.includes(literal) || !pcbInstructions.includes(literal)) {
    errors.push(`Both PCB practice documents must contain: ${literal}`);
  }
}
if (!/agent(?: text|-authored prose)[^\n]{0,80}(?:never|cannot)[^\n]{0,80}(?:close|authorize)/iu.test(
  `${pcbReport}\n${pcbInstructions}`
)) {
  errors.push("PCB practice documents must state that agent prose cannot close authority gates");
}
for (const literal of [
  "no default live provider",
  "not wired",
  "PID",
  "incomplete",
  "native DRC",
  "EvlEDA"
]) {
  if (!combined.includes(literal)) errors.push(`Documentation is missing reconciliation boundary: ${literal}`);
}
if (!readme.includes("expected-negative") || !readme.includes("BLOCKED_DIAGNOSTIC")) {
  errors.push("README must identify Rev-A as an expected-negative BLOCKED_DIAGNOSTIC proof fixture");
}

const workflow = await read(".github/workflows/ci.yml");
if (workflow !== "") {
  if (/pull_request_target\s*:/u.test(workflow)) errors.push("CI must not use pull_request_target");
  if (!/^permissions:\s*\r?\n\s+contents:\s+read\s*$/mu.test(workflow)) {
    errors.push("CI must declare top-level contents: read permissions");
  }
  for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gmu)) {
    if (!/@[0-9a-f]{40}$/u.test(match[1])) errors.push(`CI action is not pinned by full commit: ${match[1]}`);
  }
}

if (errors.length > 0) {
  console.error("Documentation contract verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 2;
} else {
  console.log(
    `Documentation contract verified: ${operations.length} operations, ` +
    `${stages.length} stages, ${ids.length} acceptance rows, ` +
    `bundle manifest v3, replay v2, and W-03 software-complete.`
  );
}

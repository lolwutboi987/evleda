import type {
  ApprovalInput,
  ArtifactRecord,
  DesignRevisionSummary,
  DesignRun,
  EngineeringPracticeInspectionResult,
  EvidenceRecord,
  LifecycleState,
  Project,
  QualificationInput,
  RequirementsDocument,
  StageKey
} from "./model";

const API_ROOT = "/api/v1";

export class ApiUnavailableError extends Error {
  constructor(message = "The local EvlEDA API is unavailable.") {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

export class ApiResponseError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.details = details;
  }
}

interface ExportReceipt {
  readonly fileName: string;
  readonly message: string;
}

export interface CreatedProjectResult {
  readonly project: Project;
  readonly stateRevision: number;
}

export interface RunStatusResult {
  readonly project?: Project | undefined;
  readonly run: DesignRun;
  readonly stateRevision: number;
  readonly currentStage?: StageKey | undefined;
  readonly headRevision?: DesignRevisionSummary | undefined;
  readonly effectiveLifecycle?: LifecycleState | undefined;
  readonly activeAttestations: readonly {
    readonly kind: string;
    readonly designRevisionId?: string | undefined;
    readonly subjectDigest: string;
    readonly evidenceRootDigest?: string | undefined;
    readonly qualificationApprovalId?: string | undefined;
  }[];
}

export interface EvidenceInspectionResult {
  readonly evidence: readonly EvidenceRecord[];
  readonly evidenceRootDigest?: string | undefined;
}

export const ARTIFACT_PREVIEW_LIMITS = {
  textBytes: 1_048_576,
  imageBytes: 8_388_608
} as const;

export type ArtifactPreview =
  | {
      readonly kind: "text" | "json";
      readonly mediaType: string;
      readonly size: number;
      readonly text: string;
    }
  | {
      readonly kind: "image";
      readonly mediaType: string;
      readonly size: number;
      readonly blob: Blob;
    };

export type ArtifactPreviewPolicy =
  | { readonly previewable: true; readonly kind: ArtifactPreview["kind"]; readonly maxBytes: number }
  | { readonly previewable: false; readonly reason: string };

const encoded = (value: string): string => encodeURIComponent(value);

const withQuery = (path: string, values: Readonly<Record<string, string | undefined>>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
};

const normalizedMediaType = (mediaType: string): string =>
  mediaType.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";

const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/x-c",
  "text/x-c++src",
  "text/x-python",
  "text/xml",
  "text/yaml"
]);

const IMAGE_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export const artifactPreviewPolicy = (artifact: ArtifactRecord): ArtifactPreviewPolicy => {
  const mediaType = normalizedMediaType(artifact.mediaType);
  const json = mediaType === "application/json" || mediaType.endsWith("+json");
  const text = TEXT_MEDIA_TYPES.has(mediaType);
  const image = IMAGE_MEDIA_TYPES.has(mediaType);
  const kind: ArtifactPreview["kind"] | undefined = json ? "json" : text ? "text" : image ? "image" : undefined;
  if (!kind) {
    return {
      previewable: false,
      reason: "Preview is limited to approved text, JSON, and raster-image media types."
    };
  }
  const maxBytes = kind === "image" ? ARTIFACT_PREVIEW_LIMITS.imageBytes : ARTIFACT_PREVIEW_LIMITS.textBytes;
  if (!Number.isSafeInteger(artifact.blob.size) || artifact.blob.size < 0 || artifact.blob.size > maxBytes) {
    return {
      previewable: false,
      reason: `Preview is disabled because this ${artifact.blob.size.toLocaleString()}-byte artifact exceeds the ${maxBytes.toLocaleString()}-byte ${kind === "image" ? "image" : "text"} limit.`
    };
  }
  return { previewable: true, kind, maxBytes };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageFromPayload = (payload: unknown, fallback: string): string => {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (!isRecord(payload)) return fallback;
  for (const key of ["message", "error", "detail", "title"]) {
    const candidate = payload[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return fallback;
};

const parseBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => undefined);
  }
  return response.text().catch(() => undefined);
};

const fetchChecked = async (path: string, init?: RequestInit): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: {
        Accept: "application/json, application/zip, application/octet-stream",
        ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init?.headers
      }
    });
  } catch (error) {
    throw new ApiUnavailableError(error instanceof Error ? error.message : undefined);
  }

  if (response.status === 503) {
    const payload = await parseBody(response);
    throw new ApiUnavailableError(
      messageFromPayload(payload, "The local EvlEDA API reported that it is unavailable.")
    );
  }
  if (!response.ok) {
    const payload = await parseBody(response);
    throw new ApiResponseError(
      response.status,
      messageFromPayload(payload, `EvlEDA API request failed (${response.status}).`),
      payload
    );
  }
  return response;
};

const requestJson = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetchChecked(path, init);
  return parseBody(response);
};

const idempotencyKey = (operation: string): string => {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${operation}-${random}`;
};

const postJson = async (
  path: string,
  body: object = {},
  operation = "operation",
  humanCredential?: string
): Promise<unknown> =>
  requestJson(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Idempotency-Key": idempotencyKey(operation),
      ...(humanCredential
        ? { "X-EvlEDA-Human-Credential": humanCredential }
        : {})
    }
  });

const unwrap = (value: unknown, preferredKey?: string): unknown => {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) return current;
    if (preferredKey && current[preferredKey] !== undefined) return current[preferredKey];
    const nested = current.data ?? current.result;
    if (nested === undefined) return current;
    current = nested;
  }
  return current;
};

const unwrapArray = <T>(value: unknown, preferredKey: string): readonly T[] => {
  const unwrapped = unwrap(value, preferredKey);
  if (Array.isArray(unwrapped)) return unwrapped as readonly T[];
  if (isRecord(unwrapped) && Array.isArray(unwrapped.items)) return unwrapped.items as readonly T[];
  return [];
};

const unwrapObject = <T>(value: unknown, preferredKey: string): T =>
  unwrap(value, preferredKey) as T;

const engineeringContractError = (field: string): never => {
  throw new Error(`Engineering practice inspection response is invalid at ${field}.`);
};

const requireRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) engineeringContractError(field);
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string") engineeringContractError(field);
  return value as string;
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") engineeringContractError(field);
  return value as boolean;
};

const requireNonNegativeInteger = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) engineeringContractError(field);
  return value as number;
};

const requireStringArray = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    engineeringContractError(field);
  }
  return value as readonly string[];
};

const requireArray = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) engineeringContractError(field);
  return value as readonly unknown[];
};

const requireLiteral = <Value extends string | boolean>(
  value: unknown,
  expected: readonly Value[],
  field: string
): Value => {
  if (!expected.some((entry) => entry === value)) engineeringContractError(field);
  return value as Value;
};

const requireNullableString = (value: unknown, field: string): string | null =>
  value === null ? null : requireString(value, field);

const validateContentIdentity = (value: unknown, field: string): void => {
  const record = requireRecord(value, field);
  requireLiteral(record.algorithm, ["sha256"] as const, `${field}.algorithm`);
  requireString(record.digest, `${field}.digest`);
  requireNonNegativeInteger(record.size, `${field}.size`);
};

const validateCanonicalIdentity = (value: unknown, field: string): void => {
  const record = requireRecord(value, field);
  requireLiteral(record.algorithm, ["sha256"] as const, `${field}.algorithm`);
  requireString(record.digest, `${field}.digest`);
  requireString(record.schemaVersion, `${field}.schemaVersion`);
  requireString(record.canonicalizationVersion, `${field}.canonicalizationVersion`);
};

const validateExactIdentity = (value: unknown, field: string): void => {
  const record = requireRecord(value, field);
  if ("size" in record) validateContentIdentity(record, field);
  else validateCanonicalIdentity(record, field);
};

const validateNullableIdentity = (
  value: unknown,
  field: string,
  validate: (candidate: unknown, candidateField: string) => void
): void => {
  if (value !== null) validate(value, field);
};

const validateToolIdentity = (value: unknown, field: string): void => {
  const record = requireRecord(value, field);
  requireString(record.name, `${field}.name`);
  requireString(record.version, `${field}.version`);
  requireString(record.adapter, `${field}.adapter`);
  for (const optional of ["executablePath", "executableDigest", "capabilityProfile"] as const) {
    if (record[optional] !== undefined) requireString(record[optional], `${field}.${optional}`);
  }
};

const validateEngineeringCheck = (
  value: unknown,
  field: string,
  evidenceClass: "kicad_native" | "evleda_check"
): Record<string, unknown> => {
  const record = requireRecord(value, field);
  requireLiteral(record.machineStatus, ["PASS", "FAIL", "UNKNOWN", "NOT_RUN"] as const, `${field}.machineStatus`);
  requireLiteral(record.evidenceClass, [evidenceClass] as const, `${field}.evidenceClass`);
  requireString(record.reasonCode, `${field}.reasonCode`);
  requireString(record.message, `${field}.message`);
  requireBoolean(record.current, `${field}.current`);
  requireNullableString(record.artifactId, `${field}.artifactId`);
  requireNullableString(record.evidenceId, `${field}.evidenceId`);
  validateNullableIdentity(record.reportIdentity, `${field}.reportIdentity`, validateContentIdentity);
  if (record.tool !== null) validateToolIdentity(record.tool, `${field}.tool`);
  requireNullableString(record.evaluatedAt, `${field}.evaluatedAt`);
  return record;
};

const validateEngineeringRule = (value: unknown, field: string): void => {
  const record = requireRecord(value, field);
  requireString(record.ruleId, `${field}.ruleId`);
  requireString(record.title, `${field}.title`);
  const applicability = requireLiteral(
    record.applicability,
    ["APPLICABLE", "NOT_APPLICABLE", "UNKNOWN"] as const,
    `${field}.applicability`
  );
  if (record.machineStatus === null) {
    if (applicability !== "NOT_APPLICABLE") engineeringContractError(`${field}.machineStatus`);
  } else {
    requireLiteral(
      record.machineStatus,
      ["PASS", "FAIL", "UNKNOWN", "NOT_RUN"] as const,
      `${field}.machineStatus`
    );
  }
  requireBoolean(record.blocking, `${field}.blocking`);
  requireStringArray(record.decisionClasses, `${field}.decisionClasses`);
  requireString(record.reasonCode, `${field}.reasonCode`);
  requireStringArray(record.sourceIds, `${field}.sourceIds`);
  const exactInputs = requireArray(record.exactInputIdentities, `${field}.exactInputIdentities`);
  exactInputs.forEach((identity, index) => validateExactIdentity(identity, `${field}.exactInputIdentities[${index}]`));
  const checkerResults = requireArray(record.checkerResultIdentities, `${field}.checkerResultIdentities`);
  checkerResults.forEach((identity, index) => validateExactIdentity(identity, `${field}.checkerResultIdentities[${index}]`));
  requireStringArray(record.findingIds, `${field}.findingIds`);
  requireStringArray(record.externalGateIds, `${field}.externalGateIds`);
};

const validateEngineeringFinding = (value: unknown, field: string): void => {
  const record = requireRecord(value, field);
  requireString(record.findingId, `${field}.findingId`);
  requireStringArray(record.ruleIds, `${field}.ruleIds`);
  requireLiteral(record.machineStatus, ["FAIL", "UNKNOWN", "NOT_RUN"] as const, `${field}.machineStatus`);
  requireLiteral(record.severity, ["advisory", "warning", "error"] as const, `${field}.severity`);
  requireString(record.message, `${field}.message`);
  requireRecord(record.observed, `${field}.observed`);
  requireRecord(record.required, `${field}.required`);
  requireStringArray(record.assumptions, `${field}.assumptions`);
  requireStringArray(record.sourceIds, `${field}.sourceIds`);
  requireStringArray(record.externalGateIds, `${field}.externalGateIds`);
  const locations = requireArray(record.locations, `${field}.locations`);
  locations.forEach((location, index) => {
    const locationField = `${field}.locations[${index}]`;
    const candidate = requireRecord(location, locationField);
    requireString(candidate.artifactId, `${locationField}.artifactId`);
    validateContentIdentity(candidate.artifactIdentity, `${locationField}.artifactIdentity`);
    requireString(candidate.sourcePath, `${locationField}.sourcePath`);
    requireString(candidate.form, `${locationField}.form`);
    requireNonNegativeInteger(candidate.ordinal, `${locationField}.ordinal`);
    requireNullableString(candidate.uuid, `${locationField}.uuid`);
    requireNonNegativeInteger(candidate.startOffset, `${locationField}.startOffset`);
    requireNonNegativeInteger(candidate.endOffset, `${locationField}.endOffset`);
    requireNonNegativeInteger(candidate.line, `${locationField}.line`);
    requireNonNegativeInteger(candidate.column, `${locationField}.column`);
    requireRecord(candidate.geometry, `${locationField}.geometry`);
  });
  const remediation = requireRecord(record.remediation, `${field}.remediation`);
  requireLiteral(remediation.authority, ["advisory_only"] as const, `${field}.remediation.authority`);
  requireLiteral(remediation.requiresNewRevision, [true] as const, `${field}.remediation.requiresNewRevision`);
  requireString(remediation.summary, `${field}.remediation.summary`);
  requireStringArray(remediation.steps, `${field}.remediation.steps`);
  requireStringArray(remediation.verification, `${field}.remediation.verification`);
  requireStringArray(remediation.rerunRuleIds, `${field}.remediation.rerunRuleIds`);
  requireStringArray(remediation.rerunStages, `${field}.remediation.rerunStages`);
};

const normalizeEngineeringPracticeInspection = (value: unknown): EngineeringPracticeInspectionResult => {
  const result = unwrap(value);
  const record = requireRecord(result, "result");
  requireLiteral(
    record.schemaVersion,
    ["evleda.engineering-practice-inspection.v1"] as const,
    "result.schemaVersion"
  );
  requireString(record.projectId, "result.projectId");
  requireString(record.runId, "result.runId");
  requireNullableString(record.revisionId, "result.revisionId");
  requireBoolean(record.isHeadRevision, "result.isHeadRevision");

  const fixture = requireRecord(record.proofFixture, "result.proofFixture");
  requireLiteral(fixture.purpose, ["full_stack_engineering_proof_fixture"] as const, "result.proofFixture.purpose");
  requireLiteral(fixture.classification, ["candidate_only"] as const, "result.proofFixture.classification");
  requireLiteral(fixture.reportEstablishesQualification, [false] as const, "result.proofFixture.reportEstablishesQualification");
  requireLiteral(fixture.reportAuthorizesManufacturing, [false] as const, "result.proofFixture.reportAuthorizesManufacturing");
  requireLiteral(fixture.reportAuthorizesRelease, [false] as const, "result.proofFixture.reportAuthorizesRelease");

  const disposition = requireRecord(record.disposition, "result.disposition");
  requireLiteral(disposition.status, ["PROVISIONAL_POC", "BLOCKED_DIAGNOSTIC"] as const, "result.disposition.status");
  requireStringArray(disposition.reasonCodes, "result.disposition.reasonCodes");
  requireStringArray(disposition.machineBlockerRuleIds, "result.disposition.machineBlockerRuleIds");
  requireStringArray(disposition.openExternalGateIds, "result.disposition.openExternalGateIds");

  const bindings = requireRecord(record.bindings, "result.bindings");
  for (const name of [
    "revisionManifest",
    "requirementsIdentity",
    "practiceCatalogIdentity",
    "routeQualityPolicyIdentity",
    "routeQualityRuleDeckIdentity",
    "proofFixturePolicyIdentity",
    "analyzerProfileIdentity",
    "constraintBindingIdentity"
  ] as const) {
    validateNullableIdentity(bindings[name], `result.bindings.${name}`, validateCanonicalIdentity);
  }
  validateCanonicalIdentity(bindings.evidenceRootIdentity, "result.bindings.evidenceRootIdentity");
  validateNullableIdentity(
    bindings.routeQualityPolicyCaptureIdentity,
    "result.bindings.routeQualityPolicyCaptureIdentity",
    validateContentIdentity
  );
  validateNullableIdentity(bindings.nativeBoardIdentity, "result.bindings.nativeBoardIdentity", validateContentIdentity);

  const checks = requireRecord(record.checks, "result.checks");
  validateEngineeringCheck(checks.nativeDrc, "result.checks.nativeDrc", "kicad_native");
  const practice = validateEngineeringCheck(checks.evledaPractice, "result.checks.evledaPractice", "evleda_check");
  if (practice.analysisOutcome !== null) {
    requireLiteral(practice.analysisOutcome, ["pass", "review", "fail"] as const, "result.checks.evledaPractice.analysisOutcome");
  }
  requireBoolean(practice.reviewRequired, "result.checks.evledaPractice.reviewRequired");
  requireNonNegativeInteger(practice.advisoryCount, "result.checks.evledaPractice.advisoryCount");

  const coverage = requireRecord(record.coverage, "result.coverage");
  requireBoolean(coverage.inventoryComplete, "result.coverage.inventoryComplete");
  for (const name of [
    "expectedRuleCount",
    "evaluatedRuleCount",
    "applicableRuleCount",
    "notApplicableRuleCount"
  ] as const) {
    requireNonNegativeInteger(coverage[name], `result.coverage.${name}`);
  }
  const statusCounts = requireRecord(coverage.statusCounts, "result.coverage.statusCounts");
  for (const status of ["PASS", "FAIL", "UNKNOWN", "NOT_RUN"] as const) {
    requireNonNegativeInteger(statusCounts[status], `result.coverage.statusCounts.${status}`);
  }
  requireStringArray(coverage.missingRuleIds, "result.coverage.missingRuleIds");
  requireStringArray(coverage.unexpectedRuleIds, "result.coverage.unexpectedRuleIds");

  const rules = requireArray(record.rules, "result.rules");
  rules.forEach((rule, index) => validateEngineeringRule(rule, `result.rules[${index}]`));
  const advisories = requireArray(record.advisories, "result.advisories");
  advisories.forEach((advisory, index) => {
    const field = `result.advisories[${index}]`;
    const candidate = requireRecord(advisory, field);
    requireString(candidate.advisoryId, `${field}.advisoryId`);
    requireStringArray(candidate.ruleIds, `${field}.ruleIds`);
    requireLiteral(candidate.severity, ["advisory", "warning"] as const, `${field}.severity`);
    requireString(candidate.message, `${field}.message`);
    requireStringArray(candidate.sourceIds, `${field}.sourceIds`);
    requireStringArray(candidate.findingIds, `${field}.findingIds`);
    requireStringArray(candidate.externalGateIds, `${field}.externalGateIds`);
  });

  const externalGates = requireArray(record.outstandingExternalGates, "result.outstandingExternalGates");
  externalGates.forEach((gate, index) => {
    const field = `result.outstandingExternalGates[${index}]`;
    const candidate = requireRecord(gate, field);
    requireString(candidate.gateId, `${field}.gateId`);
    requireString(candidate.ruleId, `${field}.ruleId`);
    requireLiteral(candidate.owner, ["fabricator", "human", "physical"] as const, `${field}.owner`);
    requireLiteral(candidate.status, ["OPEN", "UNKNOWN"] as const, `${field}.status`);
    requireString(candidate.reasonCode, `${field}.reasonCode`);
    requireString(candidate.message, `${field}.message`);
    requireStringArray(candidate.subjectIds, `${field}.subjectIds`);
    requireStringArray(candidate.sourceIds, `${field}.sourceIds`);
    const exactInputIdentities = requireArray(candidate.exactInputIdentities, `${field}.exactInputIdentities`);
    exactInputIdentities.forEach((identity, identityIndex) =>
      validateExactIdentity(identity, `${field}.exactInputIdentities[${identityIndex}]`)
    );
    requireStringArray(candidate.evidenceIds, `${field}.evidenceIds`);
  });

  const gateSummary = requireRecord(record.gateSummary, "result.gateSummary");
  for (const name of ["machineBlockers", "fabricatorOpen", "humanOpen", "physicalOpen"] as const) {
    requireNonNegativeInteger(gateSummary[name], `result.gateSummary.${name}`);
  }

  const findings = requireRecord(record.findings, "result.findings");
  requireNonNegativeInteger(findings.total, "result.findings.total");
  const findingItems = requireArray(findings.items, "result.findings.items");
  findingItems.forEach((finding, index) => validateEngineeringFinding(finding, `result.findings.items[${index}]`));
  requireNullableString(findings.nextCursor, "result.findings.nextCursor");

  const sources = requireArray(record.sources, "result.sources");
  sources.forEach((source, index) => {
    const field = `result.sources[${index}]`;
    const candidate = requireRecord(source, field);
    requireString(candidate.sourceId, `${field}.sourceId`);
    requireString(candidate.title, `${field}.title`);
    requireString(candidate.publisher, `${field}.publisher`);
    requireString(candidate.revision, `${field}.revision`);
    const date = requireRecord(candidate.date, `${field}.date`);
    requireLiteral(date.kind, ["published", "revised", "accessed"] as const, `${field}.date.kind`);
    requireString(date.value, `${field}.date.value`);
    const url = candidate.url === null ? null : requireString(candidate.url, `${field}.url`);
    if (url !== null) {
      try {
        if (new URL(url).protocol !== "https:") engineeringContractError(`${field}.url`);
      } catch {
        engineeringContractError(`${field}.url`);
      }
    }
    const authority = requireLiteral(
      candidate.authority,
      [
        "standards_body",
        "component_manufacturer",
        "connector_manufacturer",
        "protection_manufacturer",
        "fabricator",
        "internal_policy"
      ] as const,
      `${field}.authority`
    );
    const accessScope = requireLiteral(
      candidate.accessScope,
      ["public_full_text", "public_scope_or_toc", "live_capability_page", "embedded_snapshot"] as const,
      `${field}.accessScope`
    );
    const normativeStatus = requireLiteral(
      candidate.normativeStatus,
      [
        "current",
        "unmaintained_reference",
        "manufacturer_guidance",
        "fabricator_specific",
        "internal_product_policy"
      ] as const,
      `${field}.normativeStatus`
    );
    validateNullableIdentity(candidate.captureIdentity, `${field}.captureIdentity`, validateContentIdentity);
    if (candidate.locator !== null) {
      const locator = requireRecord(candidate.locator, `${field}.locator`);
      requireString(locator.kind, `${field}.locator.kind`);
      requireString(locator.value, `${field}.locator.value`);
    }
    validateNullableIdentity(candidate.excerptIdentity, `${field}.excerptIdentity`, validateContentIdentity);
    const captureComplete = requireBoolean(candidate.captureComplete, `${field}.captureComplete`);
    const completeFromParts =
      candidate.captureIdentity !== null &&
      candidate.locator !== null &&
      candidate.excerptIdentity !== null;
    if (captureComplete !== completeFromParts) engineeringContractError(`${field}.captureComplete`);
    const internalPolicyTuple =
      url === null &&
      accessScope === "embedded_snapshot" &&
      normativeStatus === "internal_product_policy" &&
      captureComplete;
    if ((authority === "internal_policy") !== internalPolicyTuple) {
      engineeringContractError(`${field}.authority`);
    }
    if (authority !== "internal_policy" && url === null) engineeringContractError(`${field}.url`);
  });
  validateCanonicalIdentity(record.identity, "result.identity");
  return record as unknown as EngineeringPracticeInspectionResult;
};

const normalizeCreatedProject = (value: unknown): CreatedProjectResult => {
  const result = unwrap(value);
  const record = isRecord(result) ? result : {};
  const project = (record.project ?? result) as Project;
  return {
    project,
    stateRevision: typeof record.stateRevision === "number" ? record.stateRevision : project.revision ?? 0
  };
};

const normalizeRunStatus = (value: unknown): RunStatusResult => {
  const result = unwrap(value);
  const record = isRecord(result) ? result : {};
  const run = (record.run ?? result) as DesignRun;
  const project = isRecord(record.project) ? (record.project as unknown as Project) : undefined;
  const currentStage =
    typeof record.currentStage === "string" ? (record.currentStage as StageKey) : undefined;
  const headRevision = isRecord(record.headRevision)
    ? (record.headRevision as unknown as DesignRevisionSummary)
    : undefined;
  const effectiveLifecycle =
    typeof record.effectiveLifecycle === "string"
      ? (record.effectiveLifecycle as LifecycleState)
      : undefined;
  const activeAttestations = Array.isArray(record.activeAttestations)
    ? (record.activeAttestations as RunStatusResult["activeAttestations"])
    : [];
  return {
    ...(project ? { project } : {}),
    run,
    stateRevision: typeof record.stateRevision === "number" ? record.stateRevision : run.revision ?? 0,
    ...(currentStage ? { currentStage } : {}),
    ...(headRevision ? { headRevision } : {}),
    ...(effectiveLifecycle ? { effectiveLifecycle } : {}),
    activeAttestations
  };
};

const normalizeEvidenceInspection = (value: unknown): EvidenceInspectionResult => {
  const result = unwrap(value);
  const record = isRecord(result) ? result : {};
  const evidence = Array.isArray(record.evidence)
    ? (record.evidence as readonly EvidenceRecord[])
    : [];
  const evidenceRoot = isRecord(record.evidenceRoot) ? record.evidenceRoot : undefined;
  return {
    evidence,
    ...(evidenceRoot && typeof evidenceRoot.digest === "string"
      ? { evidenceRootDigest: evidenceRoot.digest }
      : {})
  };
};

const optional404 = async <T>(request: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ApiResponseError && error.status === 404) return fallback;
    throw error;
  }
};

const fileNameFromDisposition = (header: string | null, fallback: string): string => {
  const encodedMatch = /filename\*=UTF-8''([^;]+)/iu.exec(header ?? "");
  if (encodedMatch?.[1]) return decodeURIComponent(encodedMatch[1]);
  const plainMatch = /filename="?([^";]+)"?/iu.exec(header ?? "");
  return plainMatch?.[1] ?? fallback;
};

const readBoundedBytes = async (response: Response, maximumBytes: number): Promise<Uint8Array> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Artifact response exceeds the ${maximumBytes.toLocaleString()}-byte preview limit.`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`Artifact response exceeds the ${maximumBytes.toLocaleString()}-byte preview limit.`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error(`Artifact response exceeds the ${maximumBytes.toLocaleString()}-byte preview limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const saveBlob = (blob: Blob, fileName: string): void => {
  const blobUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = fileName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
};

const saveBase64 = (base64: string, fileName: string, mediaType: string): void => {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  saveBlob(new Blob([bytes], { type: mediaType }), fileName);
};

const downloadResponse = async (
  path: string,
  fallbackName: string,
  body: object
): Promise<ExportReceipt> => {
  const response = await fetchChecked(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": idempotencyKey("export-bundle") }
  });
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => undefined);
    const record = unwrap(payload);
    if (isRecord(record)) {
      const bytesBase64 = record.bytesBase64;
      const fileName = typeof record.fileName === "string" ? record.fileName : fallbackName;
      if (typeof bytesBase64 === "string") {
        saveBase64(
          bytesBase64,
          fileName,
          typeof record.mediaType === "string" ? record.mediaType : "application/zip"
        );
        return { fileName, message: `${fileName} downloaded.` };
      }
      const downloadUrl = record.downloadUrl ?? record.url ?? record.path;
      if (typeof downloadUrl === "string" && downloadUrl.trim()) {
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = fallbackName;
        anchor.click();
        return { fileName: fallbackName, message: `Bundle prepared at ${downloadUrl}.` };
      }
    }
    return {
      fileName: fallbackName,
      message: messageFromPayload(record, "Bundle export completed; the API returned its receipt as JSON.")
    };
  }

  const blob = await response.blob();
  const fileName = fileNameFromDisposition(response.headers.get("content-disposition"), fallbackName);
  saveBlob(blob, fileName);
  return { fileName, message: `${fileName} downloaded.` };
};

export const api = {
  listProjects: async (): Promise<readonly Project[]> =>
    unwrapArray<Project>(await requestJson("/projects"), "projects"),

  createProject: async (name: string, description: string): Promise<CreatedProjectResult> =>
    normalizeCreatedProject(
      await postJson("/projects", {
        name,
        description: description.slice(0, 4_000)
      }, "create-project")
    ),

  startRun: async (
    projectId: string,
    prompt: string,
    expectedRevision: number
  ): Promise<RunStatusResult> =>
    normalizeRunStatus(
      await postJson(`/projects/${encoded(projectId)}/runs`, {
        prompt,
        configuration: {},
        expectedRevision
      }, "start-run")
    ),

  getRunStatus: async (runId: string): Promise<RunStatusResult> =>
    normalizeRunStatus(await requestJson(`/runs/${encoded(runId)}`)),

  getRequirements: async (runId: string): Promise<RequirementsDocument | undefined> =>
    optional404(
      requestJson(`/runs/${encoded(runId)}/requirements`).then((value) =>
        unwrapObject<RequirementsDocument>(value, "requirements")
      ),
      undefined
    ),

  approveRequirements: async (
    runId: string,
    input: ApprovalInput,
    expectedRevision: number
  ): Promise<RunStatusResult> =>
    postJson(`/runs/${encoded(runId)}/requirements/approval`, {
      requirementsDigest: input.subjectDigest,
      scope: "Current requirements document only",
      rationale: input.rationale,
      expectedRevision
    }, "approve-requirements", input.capabilityToken).then(normalizeRunStatus),

  resumeRun: async (runId: string, expectedRevision: number): Promise<RunStatusResult> =>
    postJson(`/runs/${encoded(runId)}/resume`, {
      expectedRevision
    }, "resume-run").then(normalizeRunStatus),

  listArtifacts: async (
    runId: string,
    options: { readonly revisionId?: string; readonly includeStale?: boolean } = {}
  ): Promise<readonly ArtifactRecord[]> =>
    optional404(
      requestJson(
        withQuery(`/runs/${encoded(runId)}/artifacts`, {
          revisionId: options.revisionId,
          includeStale: options.includeStale === true ? "true" : undefined
        })
      ).then((value) =>
        unwrapArray<ArtifactRecord>(value, "artifacts")
      ),
      []
    ),

  inspectEvidence: async (
    runId: string,
    revisionId?: string,
    includeStale = false
  ): Promise<EvidenceInspectionResult> =>
    optional404(
      requestJson(
        withQuery(`/runs/${encoded(runId)}/evidence`, {
          revisionId,
          includeStale: includeStale ? "true" : undefined
        })
      ).then(normalizeEvidenceInspection),
      { evidence: [] }
    ),

  listEvidence: async (runId: string): Promise<readonly EvidenceRecord[]> =>
    api.inspectEvidence(runId).then((inspection) => inspection.evidence),

  inspectEngineeringPractices: async (
    runId: string,
    options: {
      readonly revisionId?: string;
      readonly findingCursor?: string;
      readonly findingLimit?: number;
    } = {}
  ): Promise<EngineeringPracticeInspectionResult> =>
    requestJson(
      withQuery(`/runs/${encoded(runId)}/engineering-practices`, {
        revisionId: options.revisionId,
        findingCursor: options.findingCursor,
        findingLimit: options.findingLimit?.toString()
      })
    ).then(normalizeEngineeringPracticeInspection),

  artifactContentUrl: (artifactId: string): string =>
    `${API_ROOT}/artifacts/${encoded(artifactId)}/content`,

  previewArtifact: async (artifact: ArtifactRecord): Promise<ArtifactPreview> => {
    const policy = artifactPreviewPolicy(artifact);
    if (!policy.previewable) throw new Error(policy.reason);
    const response = await fetchChecked(`/artifacts/${encoded(artifact.id)}/content`, {
      headers: { Accept: artifact.mediaType }
    });
    const responseMediaType = normalizedMediaType(response.headers.get("content-type") ?? "");
    const expectedMediaType = normalizedMediaType(artifact.mediaType);
    if (responseMediaType !== expectedMediaType) {
      throw new Error(
        `Artifact response type ${responseMediaType || "(missing)"} does not match ${expectedMediaType}.`
      );
    }
    const expectedEtag = `"sha256:${artifact.blob.digest}"`;
    if (response.headers.get("etag") !== expectedEtag) {
      throw new Error("Artifact response identity does not match the selected content record.");
    }
    const bytes = await readBoundedBytes(response, policy.maxBytes);
    if (bytes.byteLength !== artifact.blob.size) {
      throw new Error(
        `Artifact response size ${bytes.byteLength.toLocaleString()} does not match the recorded ${artifact.blob.size.toLocaleString()} bytes.`
      );
    }
    if (policy.kind === "image") {
      const imageBytes = Uint8Array.from(bytes);
      return {
        kind: "image",
        mediaType: expectedMediaType,
        size: bytes.byteLength,
        blob: new Blob([imageBytes.buffer], { type: expectedMediaType })
      };
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Artifact text is not valid UTF-8 and cannot be previewed safely.");
    }
    if (policy.kind === "json") {
      try {
        decoded = JSON.stringify(JSON.parse(decoded), null, 2);
      } catch {
        throw new Error("Artifact declares JSON content but its bytes are not valid JSON.");
      }
    }
    return {
      kind: policy.kind,
      mediaType: expectedMediaType,
      size: bytes.byteLength,
      text: decoded
    };
  },

  rerunStage: async (
    runId: string,
    stage: StageKey,
    expectedRevision: number
  ): Promise<RunStatusResult> =>
    postJson(`/runs/${encoded(runId)}/stages/${encoded(stage)}/rerun`, {
      reason: "Operator requested a fresh attempt after reviewing the recorded blocker.",
      expectedRevision
    }, "rerun-stage").then(normalizeRunStatus),

  exportCandidate: async (revisionId: string, expectedRevision: number): Promise<ExportReceipt> =>
    downloadResponse(
      `/revisions/${encoded(revisionId)}/exports/candidate`,
      `evleda-${revisionId}-candidate.zip`,
      { expectedRevision }
    ),

  exportPrototype: async (revisionId: string, expectedRevision: number): Promise<ExportReceipt> =>
    downloadResponse(
      `/revisions/${encoded(revisionId)}/exports/prototype`,
      `evleda-${revisionId}-prototype.zip`,
      { expectedRevision }
    ),

  qualifyRevision: async (
    revisionId: string,
    requirementsDigest: string,
    evidenceRootDigest: string,
    input: QualificationInput,
    expectedRevision: number
  ): Promise<unknown> =>
    postJson(
      `/revisions/${encoded(revisionId)}/qualification`,
      {
        requirementsDigest,
        evidenceRootDigest,
        scope: input.scope,
        rationale: input.rationale,
        expectedRevision
      },
      "qualify-revision",
      input.capabilityToken
    ),

  generateBringupPlan: async (revisionId: string, expectedRevision: number): Promise<unknown> =>
    postJson(`/revisions/${encoded(revisionId)}/generations/bringup-plan`, {
      expectedRevision
    }, "generate-bringup"),

  generateFirmwareScaffold: async (revisionId: string, expectedRevision: number): Promise<unknown> =>
    postJson(`/revisions/${encoded(revisionId)}/generations/firmware-scaffold`, {
      language: "c",
      expectedRevision
    }, "generate-firmware")
};

export const isApiUnavailable = (error: unknown): error is ApiUnavailableError =>
  error instanceof ApiUnavailableError;

export const userFacingError = (error: unknown): string =>
  error instanceof Error ? error.message : "An unknown local API error occurred.";

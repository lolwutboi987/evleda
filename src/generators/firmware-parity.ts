import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  REFERENCE_CONNECTIVITY_ANALYZER_ID,
  REFERENCE_CONNECTIVITY_ANALYZER_TOOL,
  REFERENCE_KICAD_REPORT_SCHEMA
} from "../integrations/reference-kicad-backend.js";
import {
  FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA,
  FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA,
  deriveFirmwareParityNodes,
  firmwareParityMappingModel,
  firmwareParityMappingModelIdentity,
  type FirmwareParityNativeNode,
  type KicadNetlistNode
} from "../knowledge/firmware-parity-model.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../knowledge/reference-controller-native-contract.js";
import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import {
  parseAndValidateReferenceSchematicIntentV2Bytes,
  ReferenceSchematicIntentError,
  type ReferenceSchematicIntentV2
} from "../knowledge/reference-schematic-intent.js";
import {
  UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA,
  type ArtifactDraft,
  type CandidateStageContext,
  type StageExecutionResult,
  type UpstreamStageSourceRevisionBinding
} from "../workflow/contracts.js";
import {
  compareCodeUnits,
  expectedSourceRevisionDigest,
  isExactInputIdentity
} from "./draft-utils.js";

const SCHEMATIC_INTENT_LOGICAL_NAME = "schematic/schematic-intent.json";
export const SCHEMATIC_PIN_MAP_LOGICAL_NAME = "schematic/generated-pin-map.json";
export const LEGACY_SCHEMATIC_PIN_MAP_SCHEMA = "evleda.generated-schematic-pin-map.v1";
export const CURRENT_SCHEMATIC_PIN_MAP_SCHEMA = "evleda.generated-schematic-pin-map.v2";

export interface FirmwareParityFinding {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface FirmwareParityReport {
  readonly schemaVersion: "evleda.firmware-schematic-parity-report.v1";
  readonly classification: "candidate-only";
  readonly lifecycle: "candidate";
  readonly releaseAuthorized: false;
  readonly qualificationEstablished: false;
  readonly status: "pass" | "fail" | "unsupported";
  readonly sourceRevision: {
    readonly projectId: string;
    readonly runId: string;
    readonly designRevisionId: string;
    readonly schematicInputDesignRevisionId: string | null;
    readonly schematicCommittedDesignRevisionId: string | null;
    readonly schematicSourceRevisionBindingIdentity: CanonicalIdentity | null;
    readonly requirementsIdentity: CanonicalIdentity;
    readonly profileIdentity: CanonicalIdentity;
    readonly schematicStageOutputIdentity: CanonicalIdentity | null;
    readonly schematicSourceRevisionDigest: string | null;
    readonly schematicIntentIdentity: ContentIdentity | null;
    readonly generatedPinMapIdentity: ContentIdentity | null;
    readonly firmwareContractIdentity: ContentIdentity;
    readonly firmwareHeaderIdentity: ContentIdentity;
    readonly paritySourceIdentity: CanonicalIdentity;
  };
  readonly coverage: {
    readonly firmwarePinAssignments: number;
    readonly comparedPinAssignments: number;
    readonly firmwareResourceAssignments: number;
    readonly comparedResourceAssignments: number;
    readonly firmwareProtocolAssignments: number;
    readonly comparedProtocolAssignments: number;
    readonly headerPinMacros: number;
    readonly boundNativeArtifactCount: number;
  };
  readonly validationBoundaries: {
    readonly nativeMcuPinMapping: {
      readonly machineStatus: "PASS" | "FAIL" | "UNKNOWN";
      readonly scope: string;
    };
    readonly resetBiasImplementation: {
      readonly machineStatus: "NOT_RUN";
      readonly reason: string;
    };
    readonly protocolImplementation: {
      readonly machineStatus: "NOT_RUN";
      readonly reason: string;
    };
    readonly resourceImplementation: {
      readonly machineStatus: "NOT_RUN";
      readonly reason: string;
    };
  };
  readonly findingCount: number;
  readonly findings: readonly FirmwareParityFinding[];
  readonly limitations: readonly string[];
}

interface ValidateFirmwareParityOptions {
  readonly context: CandidateStageContext;
  readonly profile: ReferenceControllerProfile;
  readonly contractArtifact: ArtifactDraft;
  readonly headerArtifact: ArtifactDraft;
}

interface AssignmentCounts {
  readonly firmware: number;
  readonly compared: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonArtifact = (
  artifact: ArtifactDraft | undefined,
  label: string,
  findings: FirmwareParityFinding[]
): Record<string, unknown> | undefined => {
  if (artifact === undefined) return undefined;
  const actualIdentity = contentIdentity(artifact.content);
  if (
    actualIdentity.digest !== artifact.identity.digest ||
    actualIdentity.size !== artifact.identity.size
  ) {
    findings.push({
      code: "ARTIFACT_IDENTITY_MISMATCH",
      path: artifact.logicalName,
      message: `${label} bytes do not match the declared content identity.`,
      expected: artifact.identity,
      actual: actualIdentity
    });
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(artifact.content).toString("utf8")) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // The deterministic finding below is sufficient and does not echo untrusted parser text.
  }
  findings.push({
    code: "ARTIFACT_JSON_INVALID",
    path: artifact.logicalName,
    message: `${label} is not a JSON object.`
  });
  return undefined;
};

const parseCurrentSchematicIntent = (
  artifact: ArtifactDraft | undefined,
  options: ValidateFirmwareParityOptions,
  schematicInputDesignRevisionId: string | null,
  findings: FirmwareParityFinding[]
): ReferenceSchematicIntentV2 | undefined => {
  if (artifact === undefined || schematicInputDesignRevisionId === null) return undefined;
  try {
    return parseAndValidateReferenceSchematicIntentV2Bytes(
      artifact.content,
      artifact.identity,
      {
        profile: options.profile,
        requirementsDigest: options.context.requirements.identity.digest,
        designRevisionId: schematicInputDesignRevisionId
      }
    );
  } catch (error) {
    const code =
      error instanceof ReferenceSchematicIntentError &&
      error.code === "REFERENCE_SCHEMATIC_INTENT_UPGRADE_REQUIRED"
        ? "SCHEMATIC_INTENT_UPGRADE_REQUIRED"
        : error instanceof ReferenceSchematicIntentError &&
            error.code === "REFERENCE_SCHEMATIC_INTENT_UNSUPPORTED_SCHEMA"
          ? "SCHEMATIC_INTENT_UNSUPPORTED_SCHEMA"
          : "SCHEMATIC_INTENT_INVALID";
    findings.push({
      code,
      path: SCHEMATIC_INTENT_LOGICAL_NAME,
      message:
        code === "SCHEMATIC_INTENT_UPGRADE_REQUIRED"
          ? "Legacy schematic intent v1 cannot satisfy current firmware parity; explicitly rerun the schematic stage."
          : code === "SCHEMATIC_INTENT_UNSUPPORTED_SCHEMA"
            ? "Schematic intent uses an unsupported schema version."
            : "Schematic intent is not the exact current canonical Rev-A v2 document."
    });
    return undefined;
  }
};

const sameIdentity = (
  left: ContentIdentity | CanonicalIdentity,
  right: ContentIdentity | CanonicalIdentity
): boolean => canonicalJson(left) === canonicalJson(right);

const asContentIdentity = (value: unknown): ContentIdentity | undefined => {
  if (!isRecord(value) || !("size" in value)) return undefined;
  const identity = value as unknown as ContentIdentity;
  return isExactInputIdentity(identity) ? identity : undefined;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const orderedExpected = [...expected].sort(compareCodeUnits);
  return actual.length === orderedExpected.length &&
    actual.every((key, index) => key === orderedExpected[index]);
};

const safeLineageId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value);

const closedCanonicalIdentity = (
  value: unknown,
  expectedSchema?: string
): CanonicalIdentity | undefined => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.schemaVersion !== "string" ||
    value.schemaVersion.length === 0 ||
    value.schemaVersion.length > 160 ||
    (expectedSchema !== undefined && value.schemaVersion !== expectedSchema) ||
    value.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) {
    return undefined;
  }
  return {
    algorithm: "sha256",
    digest: value.digest,
    schemaVersion: value.schemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1"
  };
};

const closedContentIdentity = (value: unknown): ContentIdentity | undefined => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["algorithm", "digest", "size"]) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > 64 * 1024 * 1024
  ) {
    return undefined;
  }
  return { algorithm: "sha256", digest: value.digest, size: value.size };
};

const authenticatedSourceRevisionBinding = (
  context: CandidateStageContext,
  requestedStage: Exclude<StageExecutionResult["stage"], "requirements">,
  findings: FirmwareParityFinding[]
): UpstreamStageSourceRevisionBinding | undefined => {
  const bindings = context.upstreamSourceRevisionBindings as readonly unknown[];
  const expectedResults = context.upstream.filter(
    (entry): entry is StageExecutionResult<Exclude<StageExecutionResult["stage"], "requirements">> =>
      entry.stage !== "requirements"
  );
  if (
    !Array.isArray(bindings) ||
    bindings.length > 8 ||
    bindings.length !== expectedResults.length
  ) {
    findings.push({
      code: "UPSTREAM_SOURCE_REVISION_BINDINGS_INVALID",
      path: "upstreamSourceRevisionBindings",
      message:
        "Application-owned source-revision bindings must cover every supplied non-requirements predecessor exactly once and contain no extras."
    });
    return undefined;
  }
  const seen = new Set<string>();
  let requested: UpstreamStageSourceRevisionBinding | undefined;
  let valid = true;
  for (let index = 0; index < bindings.length; index += 1) {
    const raw = bindings[index];
    const expectedResult = expectedResults[index]!;
    if (
      !isRecord(raw) ||
      !exactKeys(raw, [
        "schemaVersion",
        "projectId",
        "runId",
        "stage",
        "attemptId",
        "stageInputManifest",
        "stageOutputIdentity",
        "provisionIdentity",
        "provisionManifestBlob",
        "sourceRevision",
        "committedRevision",
        "identity"
      ]) ||
      raw.schemaVersion !== UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA ||
      !safeLineageId(raw.projectId) ||
      !safeLineageId(raw.runId) ||
      !safeLineageId(raw.attemptId) ||
      raw.projectId !== context.projectId ||
      raw.runId !== context.runId ||
      raw.stage !== expectedResult.stage ||
      raw.stage === "requirements" ||
      seen.has(raw.stage as string)
    ) {
      valid = false;
      continue;
    }
    const stage = raw.stage as Exclude<StageExecutionResult["stage"], "requirements">;
    seen.add(stage);
    const stageInputManifest = closedCanonicalIdentity(
      raw.stageInputManifest,
      `evleda.stage-input.${stage}.v1`
    );
    const stageOutputIdentity = closedCanonicalIdentity(
      raw.stageOutputIdentity,
      `evleda.stage-result.${stage}.v1`
    );
    const provisionIdentity = closedCanonicalIdentity(
      raw.provisionIdentity,
      "evleda.stage-provision.v1"
    );
    const provisionManifestBlob = closedContentIdentity(raw.provisionManifestBlob);
    const sourceRevision = isRecord(raw.sourceRevision) &&
      exactKeys(raw.sourceRevision, ["id", "manifest"]) &&
      safeLineageId(raw.sourceRevision.id)
      ? {
          id: raw.sourceRevision.id,
          manifest: closedCanonicalIdentity(
            raw.sourceRevision.manifest,
            "evleda.design-revision.v1"
          )
        }
      : undefined;
    const committedRevision = isRecord(raw.committedRevision) &&
      exactKeys(raw.committedRevision, ["id", "manifest"]) &&
      safeLineageId(raw.committedRevision.id)
      ? {
          id: raw.committedRevision.id,
          manifest: closedCanonicalIdentity(
            raw.committedRevision.manifest,
            "evleda.design-revision.v1"
          )
        }
      : undefined;
    const identity = closedCanonicalIdentity(
      raw.identity,
      UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA
    );
    if (
      stageInputManifest === undefined ||
      stageOutputIdentity === undefined ||
      provisionIdentity === undefined ||
      provisionManifestBlob === undefined ||
      sourceRevision?.manifest === undefined ||
      committedRevision?.manifest === undefined ||
      identity === undefined ||
      sourceRevision.id === committedRevision.id ||
      canonicalJson(stageOutputIdentity) !== canonicalJson(expectedResult.outputIdentity)
    ) {
      valid = false;
      continue;
    }
    const payload = {
      schemaVersion: UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA,
      projectId: raw.projectId,
      runId: raw.runId,
      stage,
      attemptId: raw.attemptId,
      stageInputManifest,
      stageOutputIdentity,
      provisionIdentity,
      provisionManifestBlob,
      sourceRevision: { id: sourceRevision.id, manifest: sourceRevision.manifest },
      committedRevision: { id: committedRevision.id, manifest: committedRevision.manifest }
    };
    if (
      canonicalJson(
        canonicalIdentity(payload, UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA)
      ) !== canonicalJson(identity)
    ) {
      valid = false;
      continue;
    }
    if (stage === requestedStage) {
      requested = { ...payload, identity };
    }
  }
  if (!valid || seen.size !== expectedResults.length || requested === undefined) {
    findings.push({
      code: "UPSTREAM_SOURCE_REVISION_BINDINGS_INVALID",
      path: "upstreamSourceRevisionBindings",
      message:
        "Application-owned source-revision bindings are missing, duplicated, reordered, open, detached, or do not reproduce their canonical identities."
    });
    return undefined;
  }
  return requested;
};

const approvedConnectivityAnalyzer = (tool: unknown): boolean =>
  isRecord(tool) && canonicalJson(tool) === canonicalJson(REFERENCE_CONNECTIVITY_ANALYZER_TOOL);

const hasExactInput = (
  artifact: ArtifactDraft,
  expected: ContentIdentity | CanonicalIdentity
): boolean => artifact.exactInputs.some((identity) => sameIdentity(identity, expected));

const valueAt = (record: Record<string, unknown> | undefined, name: string): unknown =>
  record?.[name];

const compareScalar = (
  path: string,
  expected: unknown,
  actual: unknown,
  findings: FirmwareParityFinding[]
): void => {
  const comparableExpected = expected === undefined ? null : expected;
  const comparableActual = actual === undefined ? null : actual;
  if (canonicalJson(comparableExpected) !== canonicalJson(comparableActual)) {
    findings.push({
      code: "REVISION_BINDING_MISMATCH",
      path,
      message: `${path} does not match the exact firmware-stage revision binding.`,
      expected: comparableExpected,
      actual: comparableActual
    });
  }
};

const compareProfileValue = (
  path: string,
  expected: unknown,
  actual: unknown,
  findings: FirmwareParityFinding[]
): void => {
  const comparableActual = actual === undefined ? null : actual;
  if (canonicalJson(expected) !== canonicalJson(comparableActual)) {
    findings.push({
      code: "FIRMWARE_PROFILE_CONTRACT_MISMATCH",
      path,
      message: `${path} does not match the exact reference profile bound to this stage.`,
      expected,
      actual: comparableActual
    });
  }
};

const assignmentMap = (
  value: unknown,
  keyName: string,
  path: string,
  side: "firmware" | "schematic",
  findings: FirmwareParityFinding[]
): Map<string, Record<string, unknown>> => {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) {
    findings.push({
      code: "ASSIGNMENT_COLLECTION_INVALID",
      path,
      message: `${side} ${path} must be an array.`
    });
    return result;
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry[keyName] !== "string" || entry[keyName].length === 0) {
      findings.push({
        code: "ASSIGNMENT_INVALID",
        path: `${path}[${index.toString()}]`,
        message: `${side} assignment must be an object with a non-empty ${keyName}.`
      });
      continue;
    }
    const key = entry[keyName];
    if (result.has(key)) {
      findings.push({
        code: "ASSIGNMENT_DUPLICATE",
        path: `${path}.${key}`,
        message: `${side} contains more than one assignment for ${key}.`
      });
      continue;
    }
    result.set(key, entry);
  }
  return result;
};

const compareAssignmentGroup = (
  firmwareValue: unknown,
  schematicValue: unknown,
  keyName: string,
  path: string,
  findings: FirmwareParityFinding[]
): AssignmentCounts => {
  const firmware = assignmentMap(firmwareValue, keyName, path, "firmware", findings);
  const schematic = assignmentMap(schematicValue, keyName, path, "schematic", findings);
  let compared = 0;
  const keys = [...new Set([...firmware.keys(), ...schematic.keys()])].sort(compareCodeUnits);
  for (const key of keys) {
    const firmwareAssignment = firmware.get(key);
    const schematicAssignment = schematic.get(key);
    if (firmwareAssignment === undefined) {
      findings.push({
        code: "ASSIGNMENT_EXTRA_ON_SCHEMATIC",
        path: `${path}.${key}`,
        message: `Schematic pin-map evidence contains ${key}, but the firmware contract does not.`,
        actual: schematicAssignment
      });
      continue;
    }
    if (schematicAssignment === undefined) {
      findings.push({
        code: "ASSIGNMENT_MISSING_ON_SCHEMATIC",
        path: `${path}.${key}`,
        message: `Firmware assignment ${key} is absent from schematic pin-map evidence.`,
        expected: firmwareAssignment
      });
      continue;
    }
    compared += 1;
    if (canonicalJson(firmwareAssignment) !== canonicalJson(schematicAssignment)) {
      findings.push({
        code: "ASSIGNMENT_MISMATCH",
        path: `${path}.${key}`,
        message: `Firmware and schematic pin-map assignments differ for ${key}.`,
        expected: firmwareAssignment,
        actual: schematicAssignment
      });
    }
  }
  return { firmware: firmware.size, compared };
};

const sourceProvenFirmwarePinClaims = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((entry) =>
        isRecord(entry)
          ? {
              signal: entry.signal ?? null,
              physicalPin: entry.physicalPin ?? null,
              mcuPin: entry.mcuPin ?? null
            }
          : entry
      )
    : value;

const SOURCE_PROVEN_PIN_MAPPING_KEYS = [
  "mcuPin",
  "nativeNetName",
  "physicalPin",
  "pinFunction",
  "pinType",
  "reference",
  "signal"
] as const;

const exactSourceProvenPinMappings = (
  value: unknown,
  findings: FirmwareParityFinding[]
): readonly FirmwareParityNativeNode[] => {
  if (!Array.isArray(value)) {
    findings.push({
      code: "PIN_MAPPING_COLLECTION_INVALID",
      path: "schematicPinMap.pinMappings",
      message: "Current schematic pin-map evidence must contain a pinMappings array."
    });
    return [];
  }
  const mappings: FirmwareParityNativeNode[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `schematicPinMap.pinMappings[${index.toString()}]`;
    const keys = isRecord(entry) ? Object.keys(entry).sort(compareCodeUnits) : [];
    if (
      !isRecord(entry) ||
      canonicalJson(keys) !== canonicalJson(SOURCE_PROVEN_PIN_MAPPING_KEYS) ||
      typeof entry.signal !== "string" ||
      entry.signal.length === 0 ||
      typeof entry.reference !== "string" ||
      entry.reference.length === 0 ||
      !Number.isSafeInteger(entry.physicalPin) ||
      (entry.physicalPin as number) <= 0 ||
      typeof entry.mcuPin !== "string" ||
      entry.mcuPin.length === 0 ||
      typeof entry.pinFunction !== "string" ||
      entry.pinFunction.length === 0 ||
      typeof entry.pinType !== "string" ||
      entry.pinType.length === 0 ||
      typeof entry.nativeNetName !== "string" ||
      entry.nativeNetName.length === 0
    ) {
      findings.push({
        code: "PIN_MAPPING_SCHEMA_INVALID",
        path,
        message:
          "A source-proven pin mapping must contain exactly signal, reference, physicalPin, mcuPin, pinFunction, pinType, and nativeNetName."
      });
      continue;
    }
    mappings.push(entry as unknown as FirmwareParityNativeNode);
  }
  return mappings;
};

const cIdentifier = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_]/gu, "_").toUpperCase();

const headerPinMap = (
  headerArtifact: ArtifactDraft,
  findings: FirmwareParityFinding[]
): Map<string, string> => {
  const actualIdentity = contentIdentity(headerArtifact.content);
  if (
    actualIdentity.digest !== headerArtifact.identity.digest ||
    actualIdentity.size !== headerArtifact.identity.size
  ) {
    findings.push({
      code: "ARTIFACT_IDENTITY_MISMATCH",
      path: headerArtifact.logicalName,
      message: "Firmware header bytes do not match their declared content identity.",
      expected: headerArtifact.identity,
      actual: actualIdentity
    });
    return new Map();
  }
  const source = Buffer.from(headerArtifact.content).toString("utf8");
  const pins = new Map<string, string>();
  for (const match of source.matchAll(/^#define EVL_PIN_([A-Z0-9_]+) "([^"\r\n]+)"$/gmu)) {
    const name = match[1]!;
    if (pins.has(name)) {
      findings.push({
        code: "HEADER_PIN_MACRO_DUPLICATE",
        path: `firmwareHeader.pins.${name}`,
        message: `Firmware header defines EVL_PIN_${name} more than once.`
      });
    } else {
      pins.set(name, match[2]!);
    }
  }
  return pins;
};

const compareHeaderPins = (
  contractPins: unknown,
  headerPins: Map<string, string>,
  findings: FirmwareParityFinding[]
): void => {
  if (!Array.isArray(contractPins)) return;
  const expected = new Map<string, string>();
  for (const pin of contractPins) {
    if (isRecord(pin) && typeof pin.signal === "string" && typeof pin.mcuPin === "string") {
      expected.set(cIdentifier(pin.signal), pin.mcuPin);
    }
  }
  const names = [...new Set([...expected.keys(), ...headerPins.keys()])].sort(compareCodeUnits);
  for (const name of names) {
    const expectedPin = expected.get(name);
    const actualPin = headerPins.get(name);
    if (expectedPin !== actualPin) {
      findings.push({
        code: "HEADER_PIN_MACRO_MISMATCH",
        path: `firmwareHeader.pins.${name}`,
        message: `EVL_PIN_${name} does not exactly match the generated firmware contract.`,
        expected: expectedPin ?? null,
        actual: actualPin ?? null
      });
    }
  }
};

const exactArtifact = (
  result: StageExecutionResult | undefined,
  logicalName: string,
  findings: FirmwareParityFinding[]
): ArtifactDraft | undefined => {
  const matches = result?.artifacts.filter((artifact) => artifact.logicalName === logicalName) ?? [];
  if (matches.length !== 1) {
    findings.push({
      code: matches.length === 0 ? "SCHEMATIC_EVIDENCE_MISSING" : "SCHEMATIC_EVIDENCE_DUPLICATE",
      path: logicalName,
      message: `Expected exactly one ${logicalName} artifact, found ${matches.length.toString()}.`
    });
    return undefined;
  }
  return matches[0];
};

const validNativeBindings = (
  pinMap: Record<string, unknown> | undefined,
  pinMapArtifact: ArtifactDraft | undefined,
  schematic: StageExecutionResult | undefined,
  findings: FirmwareParityFinding[]
): number => {
  const bindings = pinMap?.nativeArtifactBindings;
  if (!Array.isArray(bindings) || bindings.length === 0) {
    findings.push({
      code: "NATIVE_SCHEMATIC_BINDING_MISSING",
      path: "schematicPinMap.nativeArtifactBindings",
      message: "Generated pin-map evidence is not bound to any exact KiCad-native artifact."
    });
    return 0;
  }
  let valid = 0;
  const seenLogicalNames = new Set<string>();
  for (const [index, binding] of bindings.entries()) {
    const pathName = `schematicPinMap.nativeArtifactBindings[${index.toString()}]`;
    if (
      !isRecord(binding) ||
      typeof binding.logicalName !== "string" ||
      binding.logicalName.length === 0 ||
      !isRecord(binding.identity) ||
      !isRecord(binding.tool) ||
      binding.validationStatus !== "pass"
    ) {
      findings.push({
        code: "NATIVE_SCHEMATIC_BINDING_INVALID",
        path: pathName,
        message: "Native schematic binding must contain a logical name and exact identity."
      });
      continue;
    }
    if (seenLogicalNames.has(binding.logicalName)) {
      findings.push({
        code: "NATIVE_SCHEMATIC_BINDING_DUPLICATE",
        path: pathName,
        message: `Native artifact ${binding.logicalName} is bound more than once.`
      });
      continue;
    }
    seenLogicalNames.add(binding.logicalName);
    const matches =
      schematic?.artifacts.filter(
        (artifact) =>
          artifact.logicalName === binding.logicalName &&
          canonicalJson(artifact.identity) === canonicalJson(binding.identity) &&
          canonicalJson(artifact.tool) === canonicalJson(binding.tool) &&
          (artifact.tool.adapter === "kicad_cli" || artifact.tool.adapter === "kicad_mcp") &&
          artifact.validationStatus === "pass" &&
          contentIdentity(artifact.content).digest === artifact.identity.digest &&
          contentIdentity(artifact.content).size === artifact.identity.size
      ) ?? [];
    const exactInputBound =
      matches.length === 1 &&
      pinMapArtifact !== undefined &&
      hasExactInput(pinMapArtifact, matches[0]!.identity);
    if (matches.length !== 1 || !exactInputBound) {
      findings.push({
        code: "NATIVE_SCHEMATIC_BINDING_STALE",
        path: pathName,
        message: `${binding.logicalName} does not bind exactly one passing, content-verified KiCad-native artifact and pin-map exact input.`,
        actual: binding
      });
    } else {
      valid += 1;
    }
  }
  return valid;
};

const validateAnalyzedConnectivitySource = (
  normalization: Record<string, unknown> | undefined,
  pinMap: Record<string, unknown> | undefined,
  pinMapArtifact: ArtifactDraft | undefined,
  schematic: StageExecutionResult | undefined,
  expectedSourceDigest: string | null,
  profileIdentity: CanonicalIdentity,
  mappingModelIdentity: CanonicalIdentity,
  findings: FirmwareParityFinding[]
): void => {
  const sourceReportLogicalName =
    isRecord(normalization) && typeof normalization.sourceReportLogicalName === "string"
      ? normalization.sourceReportLogicalName
      : null;
  const sourceReportIdentity =
    isRecord(normalization) ? asContentIdentity(normalization.sourceReportIdentity) : undefined;
  const nativeNetlistLogicalName =
    isRecord(normalization) && typeof normalization.nativeNetlistLogicalName === "string"
      ? normalization.nativeNetlistLogicalName
      : null;
  const nativeNetlistIdentity =
    isRecord(normalization) ? asContentIdentity(normalization.nativeNetlistIdentity) : undefined;
  const analyzerMetadataValid =
    isRecord(normalization) &&
    normalization.analyzerId === REFERENCE_CONNECTIVITY_ANALYZER_ID &&
    approvedConnectivityAnalyzer(normalization.analyzerTool);

  const sourceReportMatches =
    sourceReportLogicalName === null || sourceReportIdentity === undefined
      ? []
      : schematic?.artifacts.filter(
          (artifact) =>
            artifact.logicalName === sourceReportLogicalName &&
            sameIdentity(artifact.identity, sourceReportIdentity)
        ) ?? [];
  const sourceReportArtifact = sourceReportMatches[0];
  const sourceEvidence =
    sourceReportArtifact === undefined
      ? []
      : schematic?.evidence.filter(
          (entry) =>
            entry.rawArtifactLogicalName === sourceReportArtifact.logicalName ||
            entry.parsedArtifactLogicalName === sourceReportArtifact.logicalName
        ) ?? [];
  const sourceEvidenceRecord = sourceEvidence[0];
  const sourceEnvelope = parseJsonArtifact(
    sourceReportArtifact,
    "Approved EvlEDA connectivity report",
    findings
  );
  const sourcePayload =
    isRecord(sourceEnvelope) && isRecord(sourceEnvelope.payload)
      ? sourceEnvelope.payload
      : undefined;
  const sourceParity =
    isRecord(sourcePayload) && isRecord(sourcePayload.firmwareParity)
      ? sourcePayload.firmwareParity
      : undefined;
  const sourceAuthority =
    isRecord(sourceEnvelope) && isRecord(sourceEnvelope.authority)
      ? sourceEnvelope.authority
      : undefined;
  const sourceAuthorityIdentity = isRecord(sourceAuthority)
    ? canonicalIdentity(sourceAuthority, "evleda.kicad-analyzer-report-authority.v2")
    : undefined;
  const sourceInputBindings =
    isRecord(sourceAuthority) && Array.isArray(sourceAuthority.inputBindings)
      ? sourceAuthority.inputBindings
      : [];
  const parsedSourceBindings = sourceInputBindings.filter(
    (binding): binding is Record<string, unknown> & {
      readonly kind: "artifact" | "native_report" | "source";
      readonly logicalName: string;
      readonly identity: ContentIdentity;
    } =>
      isRecord(binding) &&
      (binding.kind === "artifact" ||
        binding.kind === "native_report" ||
        binding.kind === "source") &&
      typeof binding.logicalName === "string" &&
      binding.logicalName.length > 0 &&
      asContentIdentity(binding.identity) !== undefined
  );
  const sourceBindingKeys = parsedSourceBindings.map(
    (binding) => `${binding.kind}:${binding.logicalName}`
  );
  const expectedSourceDerivedFrom = [
    ...new Set(
      parsedSourceBindings
        .filter((binding) => binding.kind !== "source")
        .map((binding) => binding.logicalName)
    )
  ].sort(compareCodeUnits);
  const nativeNetlistBindings = parsedSourceBindings.filter(
    (binding) =>
      binding.kind === "native_report" &&
      binding.logicalName === nativeNetlistLogicalName &&
      nativeNetlistIdentity !== undefined &&
      sameIdentity(binding.identity, nativeNetlistIdentity)
  );

  const sourceProvenanceValid =
    sourceReportLogicalName !== null &&
    sourceReportIdentity !== undefined &&
    sourceReportMatches.length === 1 &&
    sourceReportArtifact !== undefined &&
    sourceReportArtifact.validationStatus === "pass" &&
    approvedConnectivityAnalyzer(sourceReportArtifact.tool) &&
    sameIdentity(contentIdentity(sourceReportArtifact.content), sourceReportIdentity) &&
    analyzerMetadataValid &&
    sourceEvidence.length === 1 &&
    sourceEvidenceRecord !== undefined &&
    sourceEvidenceRecord.evidenceClass === "evleda_check" &&
    sourceEvidenceRecord.rawArtifactLogicalName === undefined &&
    sourceEvidenceRecord.parsedArtifactLogicalName === sourceReportLogicalName &&
    sourceEvidenceRecord.validationStatus === "pass" &&
    approvedConnectivityAnalyzer(sourceEvidenceRecord.tool) &&
    canonicalJson(sourceEvidenceRecord.subjectDigests) ===
      canonicalJson([sourceReportIdentity.digest]) &&
    canonicalJson(sourceEvidenceRecord.exactInputs) ===
      canonicalJson(sourceReportArtifact.exactInputs) &&
    pinMapArtifact !== undefined &&
    hasExactInput(pinMapArtifact, sourceReportIdentity) &&
    pinMapArtifact.derivedFrom.includes(sourceReportLogicalName) &&
    isRecord(sourceEnvelope) &&
    sourceEnvelope.schemaVersion === REFERENCE_KICAD_REPORT_SCHEMA &&
    sourceEnvelope.kind === "connectivity" &&
    sourceEnvelope.validationStatus === "pass" &&
    sourceEnvelope.sourceRevisionDigest === expectedSourceDigest &&
    isRecord(sourceAuthority) &&
    sourceAuthority.kind === "evleda_analyzer" &&
    sourceAuthority.analyzerId === REFERENCE_CONNECTIVITY_ANALYZER_ID &&
    approvedConnectivityAnalyzer(sourceAuthority.tool) &&
    sourceAuthorityIdentity !== undefined &&
    hasExactInput(sourceReportArtifact, sourceAuthorityIdentity) &&
    parsedSourceBindings.length === sourceInputBindings.length &&
    new Set(sourceBindingKeys).size === sourceBindingKeys.length &&
    canonicalJson(sourceReportArtifact.derivedFrom) ===
      canonicalJson(expectedSourceDerivedFrom) &&
    parsedSourceBindings.every((binding) =>
      hasExactInput(sourceReportArtifact, binding.identity)
    ) &&
    hasExactInput(sourceReportArtifact, profileIdentity) &&
    nativeNetlistBindings.length === 1;
  if (!sourceProvenanceValid) {
    findings.push({
      code: "ANALYZED_CONNECTIVITY_PROVENANCE_INVALID",
      path: "schematicPinMap.normalization",
      message:
        "Firmware parity requires one passing evleda_check connectivity report from the exact approved analyzer, with no agent_claim or kicad_native substitution."
    });
  }

  const nativeNetlistMatches =
    nativeNetlistLogicalName === null || nativeNetlistIdentity === undefined
      ? []
      : schematic?.artifacts.filter(
          (artifact) =>
            artifact.logicalName === nativeNetlistLogicalName &&
            sameIdentity(artifact.identity, nativeNetlistIdentity)
        ) ?? [];
  const nativeNetlistArtifact = nativeNetlistMatches[0];
  const nativeNetlistEvidence =
    nativeNetlistArtifact === undefined
      ? []
      : schematic?.evidence.filter(
          (entry) =>
            entry.rawArtifactLogicalName === nativeNetlistArtifact.logicalName ||
            entry.parsedArtifactLogicalName === nativeNetlistArtifact.logicalName
        ) ?? [];
  const nativeNetlistEvidenceRecord = nativeNetlistEvidence[0];
  const nativeNetlistValid =
    nativeNetlistLogicalName !== null &&
    nativeNetlistIdentity !== undefined &&
    nativeNetlistIdentity.size > 0 &&
    nativeNetlistMatches.length === 1 &&
    nativeNetlistArtifact !== undefined &&
    nativeNetlistArtifact.validationStatus === "pass" &&
    nativeNetlistArtifact.tool.adapter === "kicad_cli" &&
    sameIdentity(contentIdentity(nativeNetlistArtifact.content), nativeNetlistIdentity) &&
    nativeNetlistEvidence.length === 1 &&
    nativeNetlistEvidenceRecord !== undefined &&
    nativeNetlistEvidenceRecord.evidenceClass === "kicad_native" &&
    nativeNetlistEvidenceRecord.rawArtifactLogicalName === nativeNetlistLogicalName &&
    nativeNetlistEvidenceRecord.parsedArtifactLogicalName === undefined &&
    nativeNetlistEvidenceRecord.validationStatus === "pass" &&
    canonicalJson(nativeNetlistEvidenceRecord.tool) ===
      canonicalJson(nativeNetlistArtifact.tool) &&
    canonicalJson(nativeNetlistEvidenceRecord.subjectDigests) ===
      canonicalJson([nativeNetlistIdentity.digest]) &&
    canonicalJson(nativeNetlistEvidenceRecord.exactInputs) ===
      canonicalJson(nativeNetlistArtifact.exactInputs) &&
    pinMapArtifact !== undefined &&
    hasExactInput(pinMapArtifact, nativeNetlistIdentity) &&
    pinMapArtifact.derivedFrom.includes(nativeNetlistLogicalName) &&
    sourceReportArtifact !== undefined &&
    hasExactInput(sourceReportArtifact, nativeNetlistIdentity) &&
    sourceReportArtifact.derivedFrom.includes(nativeNetlistLogicalName);
  if (!nativeNetlistValid) {
    findings.push({
      code: "NATIVE_NETLIST_PROVENANCE_INVALID",
      path: "schematicPinMap.normalization.nativeNetlistIdentity",
      message:
        "The approved connectivity check must bind one content-verified, passing kicad_native schematic-netlist report and its raw evidence."
    });
  }

  const sourceReportedNetlist =
    isRecord(sourcePayload) ? asContentIdentity(sourcePayload.schematicNetlist) : undefined;
  const sourceDerivation =
    isRecord(sourceParity) && isRecord(sourceParity.derivation)
      ? sourceParity.derivation
      : undefined;
  const sourceDerivedNetlist =
    isRecord(sourceDerivation)
      ? asContentIdentity(sourceDerivation.nativeNetlistIdentity)
      : undefined;
  const sourceMappingIdentity =
    isRecord(sourceDerivation) && isRecord(sourceDerivation.mappingModelIdentity)
      ? (sourceDerivation.mappingModelIdentity as unknown as CanonicalIdentity)
      : undefined;
  const sourceProfileIdentity =
    isRecord(sourceParity) && isRecord(sourceParity.profileIdentity)
      ? (sourceParity.profileIdentity as unknown as CanonicalIdentity)
      : undefined;
  const pinMapDerivation =
    isRecord(normalization) && isRecord(normalization.derivation)
      ? normalization.derivation
      : undefined;
  const pinMapPayloadValid =
    isRecord(sourceParity) &&
    sourceParity.schemaVersion === FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA &&
    sourceParity.nativeNodeLevel === true &&
    sourceParity.sourceRevisionDigest === expectedSourceDigest &&
    sourceParity.profileId === pinMap?.profileId &&
    sourceParity.boardRevision === pinMap?.boardRevision &&
    sourceReportedNetlist !== undefined &&
    sourceDerivedNetlist !== undefined &&
    nativeNetlistIdentity !== undefined &&
    sameIdentity(sourceReportedNetlist, nativeNetlistIdentity) &&
    sameIdentity(sourceDerivedNetlist, nativeNetlistIdentity) &&
    sourceMappingIdentity !== undefined &&
    sameIdentity(sourceMappingIdentity, mappingModelIdentity) &&
    sourceProfileIdentity !== undefined &&
    sameIdentity(sourceProfileIdentity, profileIdentity) &&
    pinMapArtifact !== undefined &&
    hasExactInput(pinMapArtifact, mappingModelIdentity) &&
    canonicalJson(sourceDerivation) === canonicalJson(pinMapDerivation) &&
    canonicalJson(sourceParity.nativeNodes) === canonicalJson(pinMap?.pinMappings ?? null);
  if (!pinMapPayloadValid) {
    findings.push({
      code: "ANALYZED_CONNECTIVITY_PAYLOAD_MISMATCH",
      path: "schematicPinMap",
      message:
        "Generated source-proven pin mappings must exactly match the approved analyzer native nodes and the consumer-recomputed profile/mapping-model identities."
    });
  }
};

export const validateFirmwareSchematicParity = (
  options: ValidateFirmwareParityOptions
): FirmwareParityReport => {
  const findings: FirmwareParityFinding[] = [];
  const profileIdentity = canonicalIdentity(options.profile, "evleda.reference-profile.v1");
  const trustedMappingModel = firmwareParityMappingModel(options.profile);
  const trustedMappingModelIdentity = firmwareParityMappingModelIdentity(options.profile);
  const schematicResults = options.context.upstream.filter((entry) => entry.stage === "schematic");
  if (schematicResults.length !== 1 || schematicResults[0]?.executionStatus !== "succeeded") {
    findings.push({
      code: "SCHEMATIC_STAGE_IDENTITY_INVALID",
      path: "schematicStage",
      message:
        "Firmware parity requires exactly one successful immutable schematic stage result for this run."
    });
  }
  const schematic = schematicResults.length === 1 ? schematicResults[0] : undefined;
  const schematicIntentArtifact = exactArtifact(
    schematic,
    SCHEMATIC_INTENT_LOGICAL_NAME,
    findings
  );
  const generatedPinMapArtifact = exactArtifact(
    schematic,
    SCHEMATIC_PIN_MAP_LOGICAL_NAME,
    findings
  );
  const contract = parseJsonArtifact(options.contractArtifact, "Firmware contract", findings);
  const generatedPinMap = parseJsonArtifact(
    generatedPinMapArtifact,
    "Generated schematic pin-map evidence",
    findings
  );
  const schematicSourceRevisionBinding = authenticatedSourceRevisionBinding(
    options.context,
    "schematic",
    findings
  );
  const claimedSchematicInputDesignRevisionId =
    typeof valueAt(generatedPinMap, "designRevisionId") === "string" &&
    (valueAt(generatedPinMap, "designRevisionId") as string).length > 0
      ? (valueAt(generatedPinMap, "designRevisionId") as string)
      : null;
  const schematicInputDesignRevisionId =
    schematicSourceRevisionBinding?.sourceRevision.id ?? null;
  if (claimedSchematicInputDesignRevisionId === null) {
    findings.push({
      code: "SCHEMATIC_REVISION_ID_MISSING",
      path: "schematicPinMap.designRevisionId",
      message: "Generated schematic pin-map evidence lacks its input design revision ID."
    });
  }
  if (schematicSourceRevisionBinding !== undefined) {
    compareScalar(
      "schematicPinMap.designRevisionId",
      schematicSourceRevisionBinding.sourceRevision.id,
      claimedSchematicInputDesignRevisionId,
      findings
    );
    compareScalar(
      "schematicSourceRevisionBinding.committedRevision.id",
      options.context.designRevisionId,
      schematicSourceRevisionBinding.committedRevision.id,
      findings
    );
    compareScalar(
      "schematicSourceRevisionBinding.stageOutputIdentity",
      schematic?.outputIdentity ?? null,
      schematicSourceRevisionBinding.stageOutputIdentity,
      findings
    );
  }
  parseCurrentSchematicIntent(
    schematicIntentArtifact,
    options,
    schematicInputDesignRevisionId,
    findings
  );

  compareScalar(
    "firmwareContract.schemaVersion",
    "evleda.firmware-contract.v1",
    valueAt(contract, "schemaVersion"),
    findings
  );
  const pinMapSchemaVersion = valueAt(generatedPinMap, "schemaVersion");
  if (pinMapSchemaVersion === LEGACY_SCHEMATIC_PIN_MAP_SCHEMA) {
    findings.push({
      code: "SCHEMATIC_PIN_MAP_UPGRADE_REQUIRED",
      path: "schematicPinMap.schemaVersion",
      message:
        "Legacy generated schematic pin-map v1 is replay-only and cannot satisfy current firmware parity; explicitly rerun the schematic stage to generate v2."
    });
  } else if (pinMapSchemaVersion !== CURRENT_SCHEMATIC_PIN_MAP_SCHEMA) {
    findings.push({
      code: "SCHEMATIC_PIN_MAP_UNSUPPORTED_SCHEMA",
      path: "schematicPinMap.schemaVersion",
      message: "Generated schematic pin-map uses an unsupported schema version.",
      expected: CURRENT_SCHEMATIC_PIN_MAP_SCHEMA,
      actual: pinMapSchemaVersion ?? null
    });
  }
  const unboundLegacyClaimFields = ["pins", "resources", "protocols"].filter(
    (field) =>
      generatedPinMap !== undefined &&
      Object.prototype.hasOwnProperty.call(generatedPinMap, field)
  );
  if (unboundLegacyClaimFields.length > 0) {
    findings.push({
      code: "SCHEMATIC_PIN_MAP_UNBOUND_CLAIMS_PRESENT",
      path: "schematicPinMap",
      message:
        "Current pin-map evidence cannot carry legacy pin prose or unbound resource/protocol implementation claims.",
      actual: unboundLegacyClaimFields
    });
  }
  compareScalar(
    "schematicPinMap.classification",
    "candidate-only",
    valueAt(generatedPinMap, "classification"),
    findings
  );
  compareScalar(
    "schematicPinMap.releaseAuthorized",
    false,
    valueAt(generatedPinMap, "releaseAuthorized"),
    findings
  );

  if (schematicIntentArtifact !== undefined) {
    if (!hasExactInput(schematicIntentArtifact, options.context.requirements.identity)) {
      findings.push({
        code: "SCHEMATIC_REQUIREMENTS_INPUT_MISSING",
        path: "schematicIntent.exactInputs",
        message: "Schematic intent does not bind the current exact requirements identity."
      });
    }
    if (!hasExactInput(schematicIntentArtifact, profileIdentity)) {
      findings.push({
        code: "SCHEMATIC_PROFILE_INPUT_MISSING",
        path: "schematicIntent.exactInputs",
        message: "Schematic intent does not bind the current exact reference-profile identity."
      });
    }
    if (
      !hasExactInput(
        schematicIntentArtifact,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
      )
    ) {
      findings.push({
        code: "SCHEMATIC_NATIVE_CONTRACT_INPUT_MISSING",
        path: "schematicIntent.exactInputs",
        message: "Schematic intent does not bind the reviewed native-contract semantic identity."
      });
    }
    if (
      !hasExactInput(
        schematicIntentArtifact,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
      )
    ) {
      findings.push({
        code: "SCHEMATIC_NATIVE_CONTRACT_BYTES_INPUT_MISSING",
        path: "schematicIntent.exactInputs",
        message: "Schematic intent does not bind the exact reviewed native-contract bytes."
      });
    }
  }
  if (generatedPinMapArtifact !== undefined) {
    if (!hasExactInput(generatedPinMapArtifact, options.context.requirements.identity)) {
      findings.push({
        code: "PIN_MAP_REQUIREMENTS_INPUT_MISSING",
        path: "schematicPinMap.exactInputs",
        message: "Generated pin-map evidence does not bind the current requirements identity."
      });
    }
    if (!hasExactInput(generatedPinMapArtifact, profileIdentity)) {
      findings.push({
        code: "PIN_MAP_PROFILE_INPUT_MISSING",
        path: "schematicPinMap.exactInputs",
        message: "Generated pin-map evidence does not bind the current reference-profile identity."
      });
    }
    if (
      !hasExactInput(
        generatedPinMapArtifact,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
      )
    ) {
      findings.push({
        code: "PIN_MAP_NATIVE_CONTRACT_INPUT_MISSING",
        path: "schematicPinMap.exactInputs",
        message: "Generated pin-map evidence does not bind the native-contract semantic identity."
      });
    }
    if (
      !hasExactInput(
        generatedPinMapArtifact,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
      )
    ) {
      findings.push({
        code: "PIN_MAP_NATIVE_CONTRACT_BYTES_INPUT_MISSING",
        path: "schematicPinMap.exactInputs",
        message: "Generated pin-map evidence does not bind the exact native-contract bytes."
      });
    }
  }
  if (!hasExactInput(options.contractArtifact, options.context.requirements.identity)) {
    findings.push({
      code: "FIRMWARE_REQUIREMENTS_INPUT_MISSING",
      path: "firmwareContract.exactInputs",
      message: "Firmware contract does not bind the current exact requirements identity."
    });
  }
  if (!hasExactInput(options.contractArtifact, profileIdentity)) {
    findings.push({
      code: "FIRMWARE_PROFILE_INPUT_MISSING",
      path: "firmwareContract.exactInputs",
      message: "Firmware contract does not bind the current exact reference-profile identity."
    });
  }
  if (!hasExactInput(options.headerArtifact, options.context.requirements.identity)) {
    findings.push({
      code: "FIRMWARE_HEADER_REQUIREMENTS_INPUT_MISSING",
      path: "firmwareHeader.exactInputs",
      message: "Firmware header does not bind the current exact requirements identity."
    });
  }
  if (!hasExactInput(options.headerArtifact, profileIdentity)) {
    findings.push({
      code: "FIRMWARE_HEADER_PROFILE_INPUT_MISSING",
      path: "firmwareHeader.exactInputs",
      message: "Firmware header does not bind the current exact reference-profile identity."
    });
  }
  if (!options.headerArtifact.derivedFrom.includes(options.contractArtifact.logicalName)) {
    findings.push({
      code: "FIRMWARE_HEADER_PROVENANCE_MISSING",
      path: "firmwareHeader.derivedFrom",
      message: "Firmware header does not declare derivation from the exact firmware contract."
    });
  }
  if (
    generatedPinMapArtifact !== undefined &&
    !hasExactInput(options.contractArtifact, generatedPinMapArtifact.identity)
  ) {
    findings.push({
      code: "FIRMWARE_PIN_MAP_INPUT_MISSING",
      path: "firmwareContract.exactInputs",
      message: "Firmware contract does not bind the exact generated schematic pin-map artifact."
    });
  }

  compareScalar("profileId", options.profile.profileId, valueAt(contract, "profileId"), findings);
  compareScalar(
    "schematicPinMap.profileId",
    options.profile.profileId,
    valueAt(generatedPinMap, "profileId"),
    findings
  );
  compareScalar(
    "boardRevision",
    options.profile.boardRevision,
    valueAt(contract, "boardRevision"),
    findings
  );
  compareScalar(
    "schematicPinMap.boardRevision",
    options.profile.boardRevision,
    valueAt(generatedPinMap, "boardRevision"),
    findings
  );
  compareScalar(
    "requirementsDigest",
    options.context.requirements.identity.digest,
    valueAt(contract, "requirementsDigest"),
    findings
  );
  const revisionBinding = valueAt(contract, "revisionBinding");
  compareScalar(
    "firmwareContract.revisionBinding.projectId",
    options.context.projectId,
    isRecord(revisionBinding) ? revisionBinding.projectId : undefined,
    findings
  );
  compareScalar(
    "firmwareContract.revisionBinding.runId",
    options.context.runId,
    isRecord(revisionBinding) ? revisionBinding.runId : undefined,
    findings
  );
  compareScalar(
    "firmwareContract.revisionBinding.designRevisionId",
    options.context.designRevisionId,
    isRecord(revisionBinding) ? revisionBinding.designRevisionId : undefined,
    findings
  );
  compareScalar(
    "firmwareContract.revisionBinding.requirementsDigest",
    options.context.requirements.identity.digest,
    isRecord(revisionBinding) ? revisionBinding.requirementsDigest : undefined,
    findings
  );
  compareScalar(
    "firmwareContract.revisionBinding.generatedSchematicPinMapIdentity",
    generatedPinMapArtifact?.identity ?? null,
    isRecord(revisionBinding) ? revisionBinding.generatedSchematicPinMapIdentity : undefined,
    findings
  );
  compareScalar(
    "schematicPinMap.requirementsIdentity",
    options.context.requirements.identity,
    valueAt(generatedPinMap, "requirementsIdentity"),
    findings
  );
  compareScalar(
    "schematicPinMap.profileIdentity",
    profileIdentity,
    valueAt(generatedPinMap, "profileIdentity"),
    findings
  );
  compareScalar(
    "schematicPinMap.projectId",
    options.context.projectId,
    valueAt(generatedPinMap, "projectId"),
    findings
  );
  compareScalar(
    "schematicPinMap.runId",
    options.context.runId,
    valueAt(generatedPinMap, "runId"),
    findings
  );
  const normalization = valueAt(generatedPinMap, "normalization");
  const nativeParityUnsupported =
    isRecord(normalization) && normalization.status === "unsupported";
  if (!isRecord(normalization) || normalization.status !== "pass") {
    findings.push({
      code: "NATIVE_PIN_MAP_NOT_PASSING",
      path: "schematicPinMap.normalization",
      message:
        "Generated schematic pin-map evidence must contain a passing exact-analyzer normalization bound to native node-level report bytes.",
      expected: { status: "pass" },
      actual: normalization === undefined ? null : normalization
    });
  }
  if (
    isRecord(normalization) &&
    generatedPinMapArtifact?.validationStatus !== normalization.status
  ) {
    findings.push({
      code: "PIN_MAP_STATUS_MISMATCH",
      path: "schematicPinMap.validationStatus",
      message: "Generated pin-map artifact status does not match its normalization report status.",
      expected: isRecord(normalization) ? normalization.status ?? null : null,
      actual: generatedPinMapArtifact?.validationStatus ?? null
    });
  }
  const pinMapValidationBoundaries = valueAt(generatedPinMap, "validationBoundaries");
  const nativeMcuPinMappingBoundary = isRecord(pinMapValidationBoundaries)
    ? pinMapValidationBoundaries.nativeMcuPinMapping
    : undefined;
  const resetBiasBoundary = isRecord(pinMapValidationBoundaries)
    ? pinMapValidationBoundaries.resetBiasImplementation
    : undefined;
  const protocolBoundary = isRecord(pinMapValidationBoundaries)
    ? pinMapValidationBoundaries.protocolImplementation
    : undefined;
  const resourceBoundary = isRecord(pinMapValidationBoundaries)
    ? pinMapValidationBoundaries.resourceImplementation
    : undefined;
  compareScalar(
    "schematicPinMap.validationBoundaries.nativeMcuPinMapping.machineStatus",
    isRecord(normalization) && normalization.status === "pass"
      ? "PASS"
      : isRecord(normalization) && normalization.status === "unsupported"
        ? "UNKNOWN"
        : "FAIL",
    isRecord(nativeMcuPinMappingBoundary)
      ? nativeMcuPinMappingBoundary.machineStatus
      : undefined,
    findings
  );
  compareScalar(
    "schematicPinMap.validationBoundaries.resetBiasImplementation.machineStatus",
    "NOT_RUN",
    isRecord(resetBiasBoundary) ? resetBiasBoundary.machineStatus : undefined,
    findings
  );
  compareScalar(
    "schematicPinMap.validationBoundaries.protocolImplementation.machineStatus",
    "NOT_RUN",
    isRecord(protocolBoundary) ? protocolBoundary.machineStatus : undefined,
    findings
  );
  compareScalar(
    "schematicPinMap.validationBoundaries.resourceImplementation.machineStatus",
    "NOT_RUN",
    isRecord(resourceBoundary) ? resourceBoundary.machineStatus : undefined,
    findings
  );
  const derivation = isRecord(normalization) ? normalization.derivation : undefined;
  const nativeNetlistIdentity =
    isRecord(derivation) && isRecord(derivation.nativeNetlistIdentity)
      ? (derivation.nativeNetlistIdentity as unknown as ContentIdentity | CanonicalIdentity)
      : undefined;
  const mappingModelIdentity =
    isRecord(derivation) && isRecord(derivation.mappingModelIdentity)
      ? (derivation.mappingModelIdentity as unknown as ContentIdentity | CanonicalIdentity)
      : undefined;
  const pinMappingValue = valueAt(generatedPinMap, "pinMappings");
  const pinMappings = exactSourceProvenPinMappings(pinMappingValue, findings);
  const rederivedNodes = deriveFirmwareParityNodes(
    pinMappings.map(
      (node): KicadNetlistNode => ({
        reference: node.reference,
        pin: node.physicalPin.toString(),
        pinFunction: node.pinFunction,
        pinType: node.pinType,
        netName: node.nativeNetName
      })
    ),
    options.profile
  );
  if (
    !isRecord(derivation) ||
    derivation.method !== "kicad-netlist-nodes-plus-pinned-mcu-capabilities" ||
    nativeNetlistIdentity === undefined ||
    mappingModelIdentity === undefined ||
    !isExactInputIdentity(nativeNetlistIdentity) ||
    !isExactInputIdentity(mappingModelIdentity) ||
    !("schemaVersion" in mappingModelIdentity) ||
    mappingModelIdentity.schemaVersion !== FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA ||
    canonicalJson(mappingModelIdentity) !== canonicalJson(trustedMappingModelIdentity) ||
    generatedPinMapArtifact === undefined ||
    !hasExactInput(generatedPinMapArtifact, nativeNetlistIdentity) ||
    !hasExactInput(generatedPinMapArtifact, mappingModelIdentity)
  ) {
    findings.push({
      code: "NATIVE_PIN_MAP_DERIVATION_INVALID",
      path: "schematicPinMap.normalization.derivation",
      message:
        "Passing pin-map evidence must bind the consumer-recomputed native-netlist and pinned MCU-capability model identities as artifact inputs."
    });
  }
  if (
    !Array.isArray(pinMappingValue) ||
    pinMappings.length !== pinMappingValue.length ||
    pinMappings.length !== trustedMappingModel.pins.length ||
    rederivedNodes.findings.length > 0 ||
    canonicalJson(pinMappings) !== canonicalJson(rederivedNodes.nodes) ||
    trustedMappingModel.missingSignalMappings.length > 0
  ) {
    findings.push({
      code: "NATIVE_PIN_NODE_COVERAGE_INVALID",
      path: "schematicPinMap.pinMappings",
      message:
        "Native node evidence does not independently re-derive every firmware pin from the trusted mapping model.",
      expected: trustedMappingModel.pins.length,
      actual: pinMappings.length
    });
  }

  compareProfileValue(
    "firmwareContract.sourceProvenPinClaims",
    sourceProvenFirmwarePinClaims(options.profile.pins),
    sourceProvenFirmwarePinClaims(valueAt(contract, "pins")),
    findings
  );

  const pinCounts = compareAssignmentGroup(
    sourceProvenFirmwarePinClaims(valueAt(contract, "pins")),
    sourceProvenFirmwarePinClaims(pinMappings),
    "signal",
    "pinMappings",
    findings
  );
  const firmwareResources = valueAt(contract, "timersIrqsAndDma");
  const firmwareProtocols = valueAt(contract, "protocols");
  const resourceCounts: AssignmentCounts = {
    firmware: Array.isArray(firmwareResources) ? firmwareResources.length : 0,
    compared: 0
  };
  const protocolCounts: AssignmentCounts = {
    firmware: Array.isArray(firmwareProtocols) ? firmwareProtocols.length : 0,
    compared: 0
  };

  const headerPins = headerPinMap(options.headerArtifact, findings);
  compareHeaderPins(valueAt(contract, "pins"), headerPins, findings);

  const expectedSchematicSourceDigest =
    schematicIntentArtifact === undefined
      ? null
      : expectedSourceRevisionDigest(
          "schematic",
          schematicIntentArtifact.exactInputs.filter(
            (identity) =>
              !("schemaVersion" in identity) ||
              identity.schemaVersion !== "evleda.stage-input.schematic.v1"
          )
        );
  if (expectedSchematicSourceDigest !== null) {
    compareScalar(
      "schematicPinMap.schematicSourceRevisionDigest",
      expectedSchematicSourceDigest,
      valueAt(generatedPinMap, "schematicSourceRevisionDigest"),
      findings
    );
  }
  const nativeBindingCount = validNativeBindings(
    generatedPinMap,
    generatedPinMapArtifact,
    schematic,
    findings
  );
  validateAnalyzedConnectivitySource(
    isRecord(normalization) ? normalization : undefined,
    generatedPinMap,
    generatedPinMapArtifact,
    schematic,
    expectedSchematicSourceDigest,
    profileIdentity,
    trustedMappingModelIdentity,
    findings
  );

  const paritySourceIdentity = canonicalIdentity(
    {
      projectId: options.context.projectId,
      runId: options.context.runId,
      designRevisionId: options.context.designRevisionId,
      schematicInputDesignRevisionId,
      schematicCommittedDesignRevisionId:
        schematicSourceRevisionBinding?.committedRevision.id ?? null,
      schematicSourceRevisionBindingIdentity:
        schematicSourceRevisionBinding?.identity ?? null,
      requirementsIdentity: options.context.requirements.identity,
      profileIdentity,
      schematicStageOutputIdentity: schematic?.outputIdentity ?? null,
      schematicSourceRevisionDigest: expectedSchematicSourceDigest,
      schematicIntentIdentity: schematicIntentArtifact?.identity ?? null,
      generatedPinMapIdentity: generatedPinMapArtifact?.identity ?? null,
      firmwareContractIdentity: options.contractArtifact.identity,
      firmwareHeaderIdentity: options.headerArtifact.identity
    },
    "evleda.firmware-parity-source.v1"
  );
  const orderedFindings = [...findings].sort((left, right) => {
    const byPath = compareCodeUnits(left.path, right.path);
    return byPath === 0 ? compareCodeUnits(left.code, right.code) : byPath;
  });
  const reportStatus =
    orderedFindings.length === 0
      ? "pass"
      : nativeParityUnsupported
        ? "unsupported"
        : "fail";
  return {
    schemaVersion: "evleda.firmware-schematic-parity-report.v1",
    classification: "candidate-only",
    lifecycle: "candidate",
    releaseAuthorized: false,
    qualificationEstablished: false,
    status: reportStatus,
    sourceRevision: {
      projectId: options.context.projectId,
      runId: options.context.runId,
      designRevisionId: options.context.designRevisionId,
      schematicInputDesignRevisionId,
      schematicCommittedDesignRevisionId:
        schematicSourceRevisionBinding?.committedRevision.id ?? null,
      schematicSourceRevisionBindingIdentity:
        schematicSourceRevisionBinding?.identity ?? null,
      requirementsIdentity: options.context.requirements.identity,
      profileIdentity,
      schematicStageOutputIdentity: schematic?.outputIdentity ?? null,
      schematicSourceRevisionDigest: expectedSchematicSourceDigest,
      schematicIntentIdentity: schematicIntentArtifact?.identity ?? null,
      generatedPinMapIdentity: generatedPinMapArtifact?.identity ?? null,
      firmwareContractIdentity: options.contractArtifact.identity,
      firmwareHeaderIdentity: options.headerArtifact.identity,
      paritySourceIdentity
    },
    coverage: {
      firmwarePinAssignments: pinCounts.firmware,
      comparedPinAssignments: pinCounts.compared,
      firmwareResourceAssignments: resourceCounts.firmware,
      comparedResourceAssignments: resourceCounts.compared,
      firmwareProtocolAssignments: protocolCounts.firmware,
      comparedProtocolAssignments: protocolCounts.compared,
      headerPinMacros: headerPins.size,
      boundNativeArtifactCount: nativeBindingCount
    },
    validationBoundaries: {
      nativeMcuPinMapping: {
        machineStatus:
          reportStatus === "pass" ? "PASS" : reportStatus === "fail" ? "FAIL" : "UNKNOWN",
        scope:
          "Native MCU signal, reference, physical pin, MCU pin, pin function, pin type, and native net mapping only."
      },
      resetBiasImplementation: {
        machineStatus: "NOT_RUN",
        reason:
          "No separately bound topology-derived reset-bias inspection is part of this firmware parity report."
      },
      protocolImplementation: {
        machineStatus: "NOT_RUN",
        reason:
          "Native connectivity does not prove protocol configuration or runtime behavior."
      },
      resourceImplementation: {
        machineStatus: "NOT_RUN",
        reason:
          "Native connectivity does not prove timer, IRQ, DMA, or runtime resource configuration."
      }
    },
    findingCount: orderedFindings.length,
    findings: orderedFindings,
    limitations: [
      "This report proves deterministic candidate consistency between generated artifacts; it is not safety, qualification, fabrication, or manufacturing-release evidence.",
      "Schematic input-revision claims are accepted only when they match the application-derived persisted provision, attempt fence, stage output, and committed revision ancestry binding.",
      "A pass is limited to source-proven native MCU pin mapping from the exact approved EvlEDA analyzer and direct kicad_native netlist bytes.",
      "Reset-bias networks, protocol implementation, and timer, IRQ, DMA, or other resource implementation remain NOT_RUN unless separately inspected and bound.",
      "Firmware compilation, target-MCU behavior, HIL behavior, and physical fault paths are separate validation boundaries."
    ]
  };
};

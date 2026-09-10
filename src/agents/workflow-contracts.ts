import { types as nodeTypes } from "node:util";
import { canonicalIdentity, constantTimeDigestEqual } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import { STAGE_ORDER, type StageKey } from "../domain/stages.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { PCB_ENGINEERING_PRACTICE_SCHEMA } from "../knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_LIVE_POLICY_SCHEMA,
  DESIGN_AGENT_MODEL_SCHEMA,
  DESIGN_AGENT_PROMPT_PACK_SCHEMA,
  DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA,
  DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
  DESIGN_AGENT_PROVIDER_SCHEMA,
  DESIGN_AGENT_REFERENCE_INDEX_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_SETTINGS_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
  DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA,
  type DesignAgentTrustAnchors
} from "./contracts.js";
import {
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA,
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
} from "./deterministic-validator-registry.js";
import { DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA } from "./production-model-policy.js";

export const DESIGN_AGENT_RUN_BINDING_SCHEMA =
  "evleda.design-agent-run-binding.v1" as const;
export const DESIGN_AGENT_STAGE_SUBJECT_SCHEMA =
  "evleda.design-agent-stage-subject.v1" as const;
export const DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA =
  "evleda.design-agent-attempt-checkpoint.v1" as const;
export const DESIGN_AGENT_VALIDATOR_HANDOFF_BINDING_SCHEMA =
  "evleda.design-agent-validator-handoff-binding.v1" as const;
export const DESIGN_AGENT_RESERVED_ARTIFACT_PREFIX = "agents/" as const;
export const DESIGN_AGENT_RUN_SCOPE = "candidate_stages_v1" as const;

export interface DesignAgentOffRunBinding {
  readonly schemaVersion: typeof DESIGN_AGENT_RUN_BINDING_SCHEMA;
  readonly mode: "off";
  readonly scope: typeof DESIGN_AGENT_RUN_SCOPE;
  readonly identity: CanonicalIdentity;
}

export interface DesignAgentProposalRequiredRunBinding {
  readonly schemaVersion: typeof DESIGN_AGENT_RUN_BINDING_SCHEMA;
  readonly mode: "proposal_required";
  readonly scope: typeof DESIGN_AGENT_RUN_SCOPE;
  readonly trustManifestId: string;
  readonly trustManifestIdentity: CanonicalIdentity;
  readonly trustAnchors: DesignAgentTrustAnchors;
  readonly instructionIdentity: ContentIdentity;
  readonly practiceCatalogIdentity: CanonicalIdentity;
  readonly providerIdentity: CanonicalIdentity;
  readonly providerExecutableIdentity: ContentIdentity;
  readonly modelIdentity: CanonicalIdentity;
  readonly modelPolicyIdentity: CanonicalIdentity;
  readonly settingsIdentity: CanonicalIdentity;
  readonly validatorRegistryIdentity: CanonicalIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly outputContractBytesIdentity: ContentIdentity;
  readonly regenerationPolicyIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}

export type DesignAgentRunBinding =
  | DesignAgentOffRunBinding
  | DesignAgentProposalRequiredRunBinding;

export type DesignAgentRunBindingInput =
  | { readonly mode: "off"; readonly scope: typeof DESIGN_AGENT_RUN_SCOPE }
  | Omit<
      DesignAgentProposalRequiredRunBinding,
      "schemaVersion" | "identity"
    >;

export interface DesignAgentStageSubject {
  readonly schemaVersion: typeof DESIGN_AGENT_STAGE_SUBJECT_SCHEMA;
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly stage: Exclude<StageKey, "requirements">;
  readonly inputManifest: CanonicalIdentity;
  readonly provisionIdentity: CanonicalIdentity;
  readonly provisionManifestBlob: ContentIdentity;
  readonly requirementsIdentity: CanonicalIdentity;
  readonly runConfigurationIdentity: CanonicalIdentity;
  readonly workflowVersion: string;
  readonly identity: CanonicalIdentity;
}

export type DesignAgentStageSubjectInput = Omit<
  DesignAgentStageSubject,
  "schemaVersion" | "identity"
>;

export interface DesignAgentLiveAttemptCapture {
  readonly acquisitionMode: "live_traceable";
  readonly capturedAttemptId: string;
}

export interface DesignAgentReplayAttemptCapture {
  readonly acquisitionMode: "frozen_exact_replay";
  readonly capturedAttemptId: string;
  readonly replayingAttemptId: string;
}

export type DesignAgentAttemptCapture =
  | DesignAgentLiveAttemptCapture
  | DesignAgentReplayAttemptCapture;

export interface DesignAgentAttemptCheckpoint {
  readonly schemaVersion: typeof DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA;
  readonly capture: DesignAgentAttemptCapture;
  readonly subject: DesignAgentStageSubject;
  readonly runBinding: DesignAgentProposalRequiredRunBinding;
  readonly requestIdentity: CanonicalIdentity;
  readonly promptPackIdentity: CanonicalIdentity;
  readonly resultIdentity: CanonicalIdentity;
  readonly structuredProposalIdentity: CanonicalIdentity;
  readonly untrustedNarrativeIdentity: CanonicalIdentity;
  readonly rawOutputIdentity: ContentIdentity;
  readonly trustManifestIdentity: CanonicalIdentity;
  readonly instructionIdentity: ContentIdentity;
  readonly practiceCatalogIdentity: CanonicalIdentity;
  readonly providerIdentity: CanonicalIdentity;
  readonly providerExecutableIdentity: ContentIdentity;
  readonly modelIdentity: CanonicalIdentity;
  readonly modelPolicyIdentity: CanonicalIdentity;
  readonly settingsIdentity: CanonicalIdentity;
  readonly referenceIndexIdentity: CanonicalIdentity;
  readonly validatorRegistryIdentity: CanonicalIdentity;
  readonly validatorPlanIdentity: CanonicalIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly outputContractBytesIdentity: ContentIdentity;
  readonly replayIdentity: CanonicalIdentity;
  /** Internal CAS blob containing the full frozen replay. Never export these bytes. */
  readonly replayBlob: ContentIdentity;
  readonly receiptId: string;
  readonly receiptIdentity: CanonicalIdentity;
  readonly validatorHandoffIdentity: CanonicalIdentity;
  readonly regenerationPolicyIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}

export type DesignAgentAttemptCheckpointInput = Omit<
  DesignAgentAttemptCheckpoint,
  "schemaVersion" | "identity"
>;

export interface DesignAgentAttemptCheckpointExpectation {
  readonly subject: DesignAgentStageSubject;
  readonly runBinding: DesignAgentProposalRequiredRunBinding;
}

export class DesignAgentWorkflowContractError extends DomainError {
  public constructor(
    public readonly failureCode: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super("INVALID_ARGUMENT", message, { failureCode, ...details }, false);
    this.name = "DesignAgentWorkflowContractError";
  }
}

const reject = (
  failureCode: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never => {
  throw new DesignAgentWorkflowContractError(failureCode, message, details);
};

const deepFreeze = <Value>(value: Value, seen = new Set<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

interface SnapshotState {
  nodes: number;
  stringBytes: number;
  readonly active: Set<object>;
}

const SNAPSHOT_MAXIMUM_DEPTH = 12;
const SNAPSHOT_MAXIMUM_NODES = 4_096;
const SNAPSHOT_MAXIMUM_STRING_BYTES = 256 * 1024;

/** Copies an untrusted graph before any semantic field is read. */
const snapshotPlainData = (value: unknown, label: string): unknown => {
  const state: SnapshotState = { nodes: 0, stringBytes: 0, active: new Set<object>() };
  const visit = (candidate: unknown, depth: number, path: string): unknown => {
    state.nodes += 1;
    if (state.nodes > SNAPSHOT_MAXIMUM_NODES || depth > SNAPSHOT_MAXIMUM_DEPTH) {
      reject("AGENT_WORKFLOW_CONTRACT_INPUT_TOO_LARGE", `${label} exceeds its graph limit`);
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return candidate;
    }
    if (typeof candidate === "string") {
      state.stringBytes += Buffer.byteLength(candidate, "utf8");
      if (state.stringBytes > SNAPSHOT_MAXIMUM_STRING_BYTES) {
        reject("AGENT_WORKFLOW_CONTRACT_INPUT_TOO_LARGE", `${label} exceeds its string limit`);
      }
      return candidate;
    }
    if (typeof candidate !== "object" || candidate === null || nodeTypes.isProxy(candidate)) {
      reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${path} must be plain data`);
    }
    const objectCandidate = candidate as object;
    if (state.active.has(objectCandidate)) {
      reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${label} contains a cycle`);
    }
    state.active.add(objectCandidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${path} must be a plain array`);
        }
        if (candidate.length > SNAPSHOT_MAXIMUM_NODES - state.nodes) {
          reject("AGENT_WORKFLOW_CONTRACT_INPUT_TOO_LARGE", `${path} exceeds its array-width limit`);
        }
        let enumerableOwnKeyCount = 0;
        for (const key in candidate) {
          if (!Object.hasOwn(candidate, key)) {
            reject(
              "AGENT_WORKFLOW_CONTRACT_INPUT_INVALID",
              `${path} inherits an enumerable authority field`
            );
          }
          enumerableOwnKeyCount += 1;
          state.stringBytes += Buffer.byteLength(key, "utf8");
          const index = Number(key);
          if (
            enumerableOwnKeyCount > SNAPSHOT_MAXIMUM_NODES - state.nodes ||
            state.stringBytes > SNAPSHOT_MAXIMUM_STRING_BYTES ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= candidate.length ||
            String(index) !== key
          ) {
            reject(
              "AGENT_WORKFLOW_CONTRACT_INPUT_INVALID",
              `${path} must be a bounded dense array without enumerable named properties`
            );
          }
        }
        if (enumerableOwnKeyCount !== candidate.length) {
          reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${path} must be a dense array`);
        }
        const copy: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${path} must contain data entries`);
          }
          copy.push(visit(descriptor!.value, depth + 1, `${path}[${index}]`));
        }
        return copy;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${path} must be a plain object`);
      }
      const copy = Object.create(null) as Record<string, unknown>;
      let enumerableOwnKeyCount = 0;
      for (const key in candidate as Record<string, unknown>) {
        if (!Object.hasOwn(objectCandidate, key)) {
          reject(
            "AGENT_WORKFLOW_CONTRACT_INPUT_INVALID",
            `${path} inherits an enumerable authority field`
          );
        }
        enumerableOwnKeyCount += 1;
        state.stringBytes += Buffer.byteLength(key, "utf8");
        if (
          enumerableOwnKeyCount > SNAPSHOT_MAXIMUM_NODES - state.nodes ||
          state.stringBytes > SNAPSHOT_MAXIMUM_STRING_BYTES
        ) {
          reject("AGENT_WORKFLOW_CONTRACT_INPUT_TOO_LARGE", `${path} exceeds its object-width limit`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(objectCandidate, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${path}.${key} must be a data property`);
        }
        copy[key] = visit(descriptor!.value, depth + 1, `${path}.${key}`);
      }
      // Hidden and symbol metadata is deliberately outside the enumerable JSON authority surface.
      // Avoiding ownKeys/getOwnPropertyNames also prevents attacker-controlled unbounded key lists.
      return copy;
    } finally {
      state.active.delete(objectCandidate);
    }
  };
  return deepFreeze(visit(value, 0, label));
};

const exactRecord = (
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${label} must be a plain object`);
  }
  const objectValue = value as object;
  const actual = Object.keys(objectValue).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${label} contains missing or unknown fields`, {
      actual,
      expected
    });
  }
  return value as Readonly<Record<string, unknown>>;
};

const plainRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("AGENT_WORKFLOW_CONTRACT_INPUT_INVALID", `${label} must be a plain object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const identifier = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u.test(value)
  ) {
    reject("AGENT_WORKFLOW_CONTRACT_IDENTIFIER_INVALID", `${label} must be a bounded identifier`);
  }
  return value as string;
};

const canonical = (value: unknown, label: string): CanonicalIdentity => {
  const record = exactRecord(
    value,
    ["algorithm", "canonicalizationVersion", "digest", "schemaVersion"],
    label
  );
  if (
    record.algorithm !== "sha256" ||
    record.canonicalizationVersion !== "evleda-c14n-json-v1" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    typeof record.schemaVersion !== "string" ||
    record.schemaVersion.length === 0
  ) {
    reject("AGENT_WORKFLOW_CONTRACT_IDENTITY_INVALID", `${label} is not a canonical identity`);
  }
  return deepFreeze({
    algorithm: "sha256" as const,
    digest: record.digest as string,
    schemaVersion: record.schemaVersion as string,
    canonicalizationVersion: "evleda-c14n-json-v1" as const
  });
};

const canonicalForSchema = (
  value: unknown,
  label: string,
  schemaVersion: string
): CanonicalIdentity => {
  const identity = canonical(value, label);
  if (identity.schemaVersion !== schemaVersion) {
    reject("AGENT_WORKFLOW_CONTRACT_IDENTITY_INVALID", `${label} has an unsupported schema`);
  }
  return identity;
};

const content = (value: unknown, label: string): ContentIdentity => {
  const record = exactRecord(value, ["algorithm", "digest", "size"], label);
  if (
    record.algorithm !== "sha256" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0
  ) {
    reject("AGENT_WORKFLOW_CONTRACT_IDENTITY_INVALID", `${label} is not a content identity`);
  }
  return deepFreeze({
    algorithm: "sha256" as const,
    digest: record.digest as string,
    size: record.size as number
  });
};

const trustAnchors = (value: unknown, label: string): DesignAgentTrustAnchors => {
  const record = exactRecord(
    value,
    ["instruction", "practiceCatalog", "provider", "modelFamily", "outputContract"],
    label
  );
  return deepFreeze({
    instruction: identifier(record.instruction, `${label}.instruction`),
    practiceCatalog: identifier(record.practiceCatalog, `${label}.practiceCatalog`),
    provider: identifier(record.provider, `${label}.provider`),
    modelFamily: identifier(record.modelFamily, `${label}.modelFamily`),
    outputContract: identifier(record.outputContract, `${label}.outputContract`)
  });
};

const canonicalIdentitiesEqual = (left: CanonicalIdentity, right: CanonicalIdentity): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.canonicalizationVersion === right.canonicalizationVersion &&
  constantTimeDigestEqual(left.digest, right.digest);

const contentIdentitiesEqual = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.size === right.size && constantTimeDigestEqual(left.digest, right.digest);

const requireCanonicalMatch = (
  actual: CanonicalIdentity,
  expected: CanonicalIdentity,
  relation: string
): void => {
  if (!canonicalIdentitiesEqual(actual, expected)) {
    reject(
      "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH",
      `checkpoint ${relation} does not match its immutable run binding`
    );
  }
};

const requireContentMatch = (
  actual: ContentIdentity,
  expected: ContentIdentity,
  relation: string
): void => {
  if (!contentIdentitiesEqual(actual, expected)) {
    reject(
      "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH",
      `checkpoint ${relation} does not match its immutable run binding`
    );
  }
};

const requireRecordIdentity = (
  record: Readonly<Record<string, unknown>>,
  schemaVersion: string,
  label: string
): CanonicalIdentity => {
  const supplied = canonical(record.identity, `${label}.identity`);
  const payload = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== "identity") payload[key] = record[key];
  const reproduced = canonicalIdentity(payload, schemaVersion);
  if (!canonicalIdentitiesEqual(supplied, reproduced) || supplied.schemaVersion !== schemaVersion) {
    reject("AGENT_WORKFLOW_CONTRACT_IDENTITY_MISMATCH", `${label} identity does not reproduce`);
  }
  return supplied;
};

const normalizeLogicalSegments = (logicalName: string): readonly string[] => {
  const stack: string[] = [];
  for (const segment of logicalName.replaceAll("\\", "/").split("/")) {
    const withoutTrailingSpaces = segment.replace(/ +$/u, "");
    if (withoutTrailingSpaces === "" || withoutTrailingSpaces === ".") continue;
    if (withoutTrailingSpaces === "..") {
      stack.pop();
      continue;
    }
    const windowsNormalized = withoutTrailingSpaces.replace(/\.+$/u, "");
    if (windowsNormalized !== "") stack.push(windowsNormalized);
  }
  return stack;
};

export const isReservedDesignAgentArtifactLogicalName = (value: unknown): boolean =>
  typeof value === "string" &&
  value.length <= 240 &&
  normalizeLogicalSegments(value)[0]?.toLocaleLowerCase("en-US") === "agents";

const RUN_PROPOSAL_KEYS = [
  "mode", "scope", "trustManifestId", "trustManifestIdentity", "trustAnchors",
  "instructionIdentity", "practiceCatalogIdentity", "providerIdentity",
  "providerExecutableIdentity", "modelIdentity", "modelPolicyIdentity", "settingsIdentity",
  "validatorRegistryIdentity",
  "outputContractIdentity", "outputContractBytesIdentity",
  "regenerationPolicyIdentity"
] as const;

const proposalRunPayload = (
  record: Readonly<Record<string, unknown>>
): Omit<DesignAgentProposalRequiredRunBinding, "identity"> => ({
  schemaVersion: DESIGN_AGENT_RUN_BINDING_SCHEMA,
  mode: "proposal_required",
  scope: DESIGN_AGENT_RUN_SCOPE,
  trustManifestId: identifier(record.trustManifestId, "runBinding.trustManifestId"),
  trustManifestIdentity: canonicalForSchema(
    record.trustManifestIdentity,
    "runBinding.trustManifestIdentity",
    DESIGN_AGENT_TRUST_MANIFEST_SCHEMA
  ),
  trustAnchors: trustAnchors(record.trustAnchors, "runBinding.trustAnchors"),
  instructionIdentity: content(record.instructionIdentity, "runBinding.instructionIdentity"),
  practiceCatalogIdentity: canonicalForSchema(
    record.practiceCatalogIdentity,
    "runBinding.practiceCatalogIdentity",
    PCB_ENGINEERING_PRACTICE_SCHEMA
  ),
  providerIdentity: canonicalForSchema(
    record.providerIdentity,
    "runBinding.providerIdentity",
    DESIGN_AGENT_PROVIDER_SCHEMA
  ),
  providerExecutableIdentity: content(record.providerExecutableIdentity, "runBinding.providerExecutableIdentity"),
  modelIdentity: canonicalForSchema(
    record.modelIdentity,
    "runBinding.modelIdentity",
    DESIGN_AGENT_MODEL_SCHEMA
  ),
  modelPolicyIdentity: canonicalForSchema(
    record.modelPolicyIdentity,
    "runBinding.modelPolicyIdentity",
    DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA
  ),
  settingsIdentity: canonicalForSchema(
    record.settingsIdentity,
    "runBinding.settingsIdentity",
    DESIGN_AGENT_SETTINGS_SCHEMA
  ),
  validatorRegistryIdentity: canonicalForSchema(
    record.validatorRegistryIdentity,
    "runBinding.validatorRegistryIdentity",
    DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
  ),
  outputContractIdentity: canonicalForSchema(
    record.outputContractIdentity,
    "runBinding.outputContractIdentity",
    DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA
  ),
  outputContractBytesIdentity: content(record.outputContractBytesIdentity, "runBinding.outputContractBytesIdentity"),
  regenerationPolicyIdentity: canonicalForSchema(
    record.regenerationPolicyIdentity,
    "runBinding.regenerationPolicyIdentity",
    DESIGN_AGENT_LIVE_POLICY_SCHEMA
  )
});

export const createDesignAgentRunBinding = (
  input: DesignAgentRunBindingInput
): DesignAgentRunBinding => {
  const snapshot = snapshotPlainData(input, "runBinding");
  const root = plainRecord(snapshot, "runBinding");
  const modeRecord = exactRecord(
    root,
    root.mode === "off" ? ["mode", "scope"] : RUN_PROPOSAL_KEYS,
    "runBinding"
  );
  if (modeRecord.mode === "off") {
    if (modeRecord.scope !== DESIGN_AGENT_RUN_SCOPE) {
      reject("AGENT_WORKFLOW_RUN_SCOPE_INVALID", "runBinding.scope is unsupported");
    }
    const payload = {
      schemaVersion: DESIGN_AGENT_RUN_BINDING_SCHEMA,
      mode: "off" as const,
      scope: DESIGN_AGENT_RUN_SCOPE
    };
    return deepFreeze({ ...payload, identity: canonicalIdentity(payload, DESIGN_AGENT_RUN_BINDING_SCHEMA) });
  }
  if (modeRecord.mode !== "proposal_required") {
    reject("AGENT_WORKFLOW_RUN_MODE_INVALID", "runBinding.mode must be explicit");
  }
  if (modeRecord.scope !== DESIGN_AGENT_RUN_SCOPE) {
    reject("AGENT_WORKFLOW_RUN_SCOPE_INVALID", "runBinding.scope is unsupported");
  }
  const payload = proposalRunPayload(modeRecord);
  return deepFreeze({ ...payload, identity: canonicalIdentity(payload, DESIGN_AGENT_RUN_BINDING_SCHEMA) });
};

export const bindDesignAgentRunBinding = (value: unknown): DesignAgentRunBinding => {
  const snapshot = snapshotPlainData(value, "runBinding");
  const root = plainRecord(snapshot, "runBinding");
  const mode = root.mode;
  const record = exactRecord(
    root,
    mode === "off"
      ? ["schemaVersion", "mode", "scope", "identity"]
      : ["schemaVersion", ...RUN_PROPOSAL_KEYS, "identity"],
    "runBinding"
  );
  if (record.schemaVersion !== DESIGN_AGENT_RUN_BINDING_SCHEMA) {
    reject("AGENT_WORKFLOW_RUN_BINDING_SCHEMA_INVALID", "runBinding schema is unsupported");
  }
  requireRecordIdentity(record, DESIGN_AGENT_RUN_BINDING_SCHEMA, "runBinding");
  const input = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "schemaVersion" && key !== "identity") input[key] = record[key];
  }
  return createDesignAgentRunBinding(input as DesignAgentRunBindingInput);
};

const SUBJECT_KEYS = [
  "projectId", "runId", "designRevisionId", "stage", "inputManifest",
  "provisionIdentity", "provisionManifestBlob", "requirementsIdentity",
  "runConfigurationIdentity", "workflowVersion"
] as const;

export const createDesignAgentStageSubject = (
  input: DesignAgentStageSubjectInput
): DesignAgentStageSubject => {
  const record = exactRecord(snapshotPlainData(input, "stageSubject"), SUBJECT_KEYS, "stageSubject");
  if (typeof record.stage !== "string" || record.stage === "requirements" || !STAGE_ORDER.includes(record.stage as StageKey)) {
    reject("AGENT_WORKFLOW_STAGE_INVALID", "stageSubject.stage must be a post-approval workflow stage");
  }
  const selectedStage = record.stage as Exclude<StageKey, "requirements">;
  const payload = {
    schemaVersion: DESIGN_AGENT_STAGE_SUBJECT_SCHEMA,
    projectId: identifier(record.projectId, "stageSubject.projectId"),
    runId: identifier(record.runId, "stageSubject.runId"),
    designRevisionId: identifier(record.designRevisionId, "stageSubject.designRevisionId"),
    stage: selectedStage,
    inputManifest: canonicalForSchema(
      record.inputManifest,
      "stageSubject.inputManifest",
      `evleda.stage-input.${selectedStage}.v1`
    ),
    provisionIdentity: canonicalForSchema(
      record.provisionIdentity,
      "stageSubject.provisionIdentity",
      "evleda.stage-provision.v1"
    ),
    provisionManifestBlob: content(record.provisionManifestBlob, "stageSubject.provisionManifestBlob"),
    requirementsIdentity: canonicalForSchema(
      record.requirementsIdentity,
      "stageSubject.requirementsIdentity",
      "evleda.requirements.v1"
    ),
    runConfigurationIdentity: canonicalForSchema(
      record.runConfigurationIdentity,
      "stageSubject.runConfigurationIdentity",
      "evleda.run-configuration.v1"
    ),
    workflowVersion: identifier(record.workflowVersion, "stageSubject.workflowVersion")
  };
  return deepFreeze({ ...payload, identity: canonicalIdentity(payload, DESIGN_AGENT_STAGE_SUBJECT_SCHEMA) });
};

export const bindDesignAgentStageSubject = (value: unknown): DesignAgentStageSubject => {
  const record = exactRecord(
    snapshotPlainData(value, "stageSubject"),
    ["schemaVersion", ...SUBJECT_KEYS, "identity"],
    "stageSubject"
  );
  if (record.schemaVersion !== DESIGN_AGENT_STAGE_SUBJECT_SCHEMA) {
    reject("AGENT_WORKFLOW_STAGE_SUBJECT_SCHEMA_INVALID", "stageSubject schema is unsupported");
  }
  requireRecordIdentity(record, DESIGN_AGENT_STAGE_SUBJECT_SCHEMA, "stageSubject");
  const input = Object.create(null) as Record<string, unknown>;
  for (const key of SUBJECT_KEYS) input[key] = record[key];
  return createDesignAgentStageSubject(input as unknown as DesignAgentStageSubjectInput);
};

// Checkpoint parsing is appended below; these constants make the compile-time surface available
// while retaining one closed field list for creation and binding.
const CHECKPOINT_CANONICAL_FIELDS = [
  "requestIdentity", "promptPackIdentity", "resultIdentity", "structuredProposalIdentity",
  "untrustedNarrativeIdentity", "trustManifestIdentity", "practiceCatalogIdentity",
  "providerIdentity", "modelIdentity", "modelPolicyIdentity", "settingsIdentity", "referenceIndexIdentity",
  "validatorRegistryIdentity", "validatorPlanIdentity",
  "outputContractIdentity", "replayIdentity", "receiptIdentity", "validatorHandoffIdentity",
  "regenerationPolicyIdentity"
] as const;
const CHECKPOINT_CONTENT_FIELDS = [
  "rawOutputIdentity", "instructionIdentity", "providerExecutableIdentity",
  "outputContractBytesIdentity", "replayBlob"
] as const;
const CHECKPOINT_KEYS = [
  "capture", "subject", "runBinding", ...CHECKPOINT_CANONICAL_FIELDS,
  ...CHECKPOINT_CONTENT_FIELDS, "receiptId"
] as const;

const captureSnapshot = (value: unknown): DesignAgentAttemptCapture => {
  const candidate = plainRecord(value, "checkpoint.capture");
  const record = exactRecord(
    value,
    candidate.acquisitionMode === "live_traceable"
      ? ["acquisitionMode", "capturedAttemptId"]
      : ["acquisitionMode", "capturedAttemptId", "replayingAttemptId"],
    "checkpoint.capture"
  );
  const capturedAttemptId = identifier(record.capturedAttemptId, "checkpoint.capture.capturedAttemptId");
  if (record.acquisitionMode === "live_traceable") {
    return deepFreeze({ acquisitionMode: "live_traceable" as const, capturedAttemptId });
  }
  if (record.acquisitionMode !== "frozen_exact_replay") {
    reject("AGENT_WORKFLOW_CAPTURE_MODE_INVALID", "checkpoint capture mode is unsupported");
  }
  return deepFreeze({
    acquisitionMode: "frozen_exact_replay" as const,
    capturedAttemptId,
    replayingAttemptId: identifier(record.replayingAttemptId, "checkpoint.capture.replayingAttemptId")
  });
};

export const createDesignAgentAttemptCheckpoint = (
  input: DesignAgentAttemptCheckpointInput
): DesignAgentAttemptCheckpoint => {
  const record = exactRecord(snapshotPlainData(input, "checkpoint"), CHECKPOINT_KEYS, "checkpoint");
  const subject = bindDesignAgentStageSubject(record.subject);
  const runBinding = bindDesignAgentRunBinding(record.runBinding);
  if (runBinding.mode !== "proposal_required") {
    reject("AGENT_WORKFLOW_CHECKPOINT_MODE_INVALID", "checkpoint requires proposal-required binding");
  }
  const proposalRunBinding = runBinding as DesignAgentProposalRequiredRunBinding;
  const fixedCanonical = {
    trustManifestIdentity: canonical(record.trustManifestIdentity, "checkpoint.trustManifestIdentity"),
    practiceCatalogIdentity: canonical(record.practiceCatalogIdentity, "checkpoint.practiceCatalogIdentity"),
    providerIdentity: canonical(record.providerIdentity, "checkpoint.providerIdentity"),
    modelIdentity: canonical(record.modelIdentity, "checkpoint.modelIdentity"),
    modelPolicyIdentity: canonical(record.modelPolicyIdentity, "checkpoint.modelPolicyIdentity"),
    settingsIdentity: canonical(record.settingsIdentity, "checkpoint.settingsIdentity"),
    validatorRegistryIdentity: canonicalForSchema(
      record.validatorRegistryIdentity,
      "checkpoint.validatorRegistryIdentity",
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
    ),
    outputContractIdentity: canonical(record.outputContractIdentity, "checkpoint.outputContractIdentity"),
    regenerationPolicyIdentity: canonical(record.regenerationPolicyIdentity, "checkpoint.regenerationPolicyIdentity")
  };
  const fixedContent = {
    instructionIdentity: content(record.instructionIdentity, "checkpoint.instructionIdentity"),
    providerExecutableIdentity: content(record.providerExecutableIdentity, "checkpoint.providerExecutableIdentity"),
    outputContractBytesIdentity: content(record.outputContractBytesIdentity, "checkpoint.outputContractBytesIdentity")
  };
  requireCanonicalMatch(fixedCanonical.trustManifestIdentity, proposalRunBinding.trustManifestIdentity, "trust manifest");
  requireContentMatch(fixedContent.instructionIdentity, proposalRunBinding.instructionIdentity, "instruction");
  requireCanonicalMatch(fixedCanonical.practiceCatalogIdentity, proposalRunBinding.practiceCatalogIdentity, "practice catalog");
  requireCanonicalMatch(fixedCanonical.providerIdentity, proposalRunBinding.providerIdentity, "provider");
  requireContentMatch(fixedContent.providerExecutableIdentity, proposalRunBinding.providerExecutableIdentity, "provider executable");
  requireCanonicalMatch(fixedCanonical.modelIdentity, proposalRunBinding.modelIdentity, "model");
  requireCanonicalMatch(fixedCanonical.modelPolicyIdentity, proposalRunBinding.modelPolicyIdentity, "model policy");
  requireCanonicalMatch(fixedCanonical.settingsIdentity, proposalRunBinding.settingsIdentity, "settings");
  requireCanonicalMatch(
    fixedCanonical.validatorRegistryIdentity,
    proposalRunBinding.validatorRegistryIdentity,
    "validator registry"
  );
  requireCanonicalMatch(fixedCanonical.outputContractIdentity, proposalRunBinding.outputContractIdentity, "output contract");
  requireContentMatch(fixedContent.outputContractBytesIdentity, proposalRunBinding.outputContractBytesIdentity, "output-contract bytes");
  requireCanonicalMatch(fixedCanonical.regenerationPolicyIdentity, proposalRunBinding.regenerationPolicyIdentity, "regeneration policy");
  const replayIdentity = canonicalForSchema(
    record.replayIdentity,
    "checkpoint.replayIdentity",
    DESIGN_AGENT_REPLAY_SCHEMA
  );
  const receiptId = identifier(record.receiptId, "checkpoint.receiptId");
  if (receiptId !== `replay_${replayIdentity.digest}`) {
    reject(
      "AGENT_WORKFLOW_CHECKPOINT_RECEIPT_MISMATCH",
      "checkpoint receipt ID is not derived from its full replay identity"
    );
  }

  const payload: Omit<DesignAgentAttemptCheckpoint, "identity"> = {
    schemaVersion: DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA,
    capture: captureSnapshot(record.capture),
    subject,
    runBinding: proposalRunBinding,
    requestIdentity: canonicalForSchema(
      record.requestIdentity,
      "checkpoint.requestIdentity",
      DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA
    ),
    promptPackIdentity: canonicalForSchema(
      record.promptPackIdentity,
      "checkpoint.promptPackIdentity",
      DESIGN_AGENT_PROMPT_PACK_SCHEMA
    ),
    resultIdentity: canonicalForSchema(
      record.resultIdentity,
      "checkpoint.resultIdentity",
      DESIGN_AGENT_RESULT_SCHEMA
    ),
    structuredProposalIdentity: canonicalForSchema(
      record.structuredProposalIdentity,
      "checkpoint.structuredProposalIdentity",
      DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
    ),
    untrustedNarrativeIdentity: canonicalForSchema(
      record.untrustedNarrativeIdentity,
      "checkpoint.untrustedNarrativeIdentity",
      DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA
    ),
    rawOutputIdentity: content(record.rawOutputIdentity, "checkpoint.rawOutputIdentity"),
    trustManifestIdentity: fixedCanonical.trustManifestIdentity,
    instructionIdentity: fixedContent.instructionIdentity,
    practiceCatalogIdentity: fixedCanonical.practiceCatalogIdentity,
    providerIdentity: fixedCanonical.providerIdentity,
    providerExecutableIdentity: fixedContent.providerExecutableIdentity,
    modelIdentity: fixedCanonical.modelIdentity,
    modelPolicyIdentity: fixedCanonical.modelPolicyIdentity,
    settingsIdentity: fixedCanonical.settingsIdentity,
    referenceIndexIdentity: canonicalForSchema(
      record.referenceIndexIdentity,
      "checkpoint.referenceIndexIdentity",
      DESIGN_AGENT_REFERENCE_INDEX_SCHEMA
    ),
    validatorRegistryIdentity: fixedCanonical.validatorRegistryIdentity,
    validatorPlanIdentity: canonicalForSchema(
      record.validatorPlanIdentity,
      "checkpoint.validatorPlanIdentity",
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA
    ),
    outputContractIdentity: fixedCanonical.outputContractIdentity,
    outputContractBytesIdentity: fixedContent.outputContractBytesIdentity,
    replayIdentity,
    replayBlob: content(record.replayBlob, "checkpoint.replayBlob"),
    receiptId,
    receiptIdentity: canonicalForSchema(
      record.receiptIdentity,
      "checkpoint.receiptIdentity",
      DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA
    ),
    validatorHandoffIdentity: canonicalForSchema(
      record.validatorHandoffIdentity,
      "checkpoint.validatorHandoffIdentity",
      DESIGN_AGENT_VALIDATOR_HANDOFF_BINDING_SCHEMA
    ),
    regenerationPolicyIdentity: fixedCanonical.regenerationPolicyIdentity
  };
  return deepFreeze({ ...payload, identity: canonicalIdentity(payload, DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA) });
};

export const bindDesignAgentAttemptCheckpoint = (
  value: unknown,
  expected?: DesignAgentAttemptCheckpointExpectation
): DesignAgentAttemptCheckpoint => {
  let expectation: DesignAgentAttemptCheckpointExpectation | undefined;
  if (expected !== undefined) {
    const expectedRecord = exactRecord(
      snapshotPlainData(expected, "checkpointExpectation"),
      ["subject", "runBinding"],
      "checkpointExpectation"
    );
    const expectedRunBinding = bindDesignAgentRunBinding(expectedRecord.runBinding);
    if (expectedRunBinding.mode !== "proposal_required") {
      reject(
        "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH",
        "checkpoint expectation requires a proposal-required run binding"
      );
    }
    expectation = deepFreeze({
      subject: bindDesignAgentStageSubject(expectedRecord.subject),
      runBinding: expectedRunBinding as DesignAgentProposalRequiredRunBinding
    });
  }
  const record = exactRecord(
    snapshotPlainData(value, "checkpoint"),
    ["schemaVersion", ...CHECKPOINT_KEYS, "identity"],
    "checkpoint"
  );
  if (record.schemaVersion !== DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA) {
    reject("AGENT_WORKFLOW_CHECKPOINT_SCHEMA_INVALID", "checkpoint schema is unsupported");
  }
  requireRecordIdentity(record, DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA, "checkpoint");
  const input = Object.create(null) as Record<string, unknown>;
  for (const key of CHECKPOINT_KEYS) input[key] = record[key];
  const checkpoint = createDesignAgentAttemptCheckpoint(
    input as unknown as DesignAgentAttemptCheckpointInput
  );
  if (expectation !== undefined) {
    if (!canonicalIdentitiesEqual(checkpoint.subject.identity, expectation.subject.identity)) {
      reject("AGENT_WORKFLOW_CHECKPOINT_SUBJECT_MISMATCH", "checkpoint stable subject does not match");
    }
    if (
      !canonicalIdentitiesEqual(checkpoint.runBinding.identity, expectation.runBinding.identity)
    ) {
      reject("AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH", "checkpoint run binding does not match");
    }
  }
  return checkpoint;
};

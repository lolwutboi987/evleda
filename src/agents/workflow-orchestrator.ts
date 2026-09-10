import { types as nodeTypes } from "node:util";
import {
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA,
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA,
  type DesignAgentDeterministicValidatorPlan,
  type DesignAgentDeterministicValidatorPlanInput,
  type DesignAgentDeterministicValidatorRegistry,
  type DesignAgentDeterministicValidatorRegistrySnapshot
} from "./deterministic-validator-registry.js";
import {
  canonicalIdentity,
  canonicalJson,
  constantTimeDigestEqual,
  contentIdentity
} from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  DESIGN_AGENT_LIMITS,
  DESIGN_AGENT_PROMPT_PACK_SCHEMA,
  DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
  DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
  DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA,
  type DesignAgentProposalResult,
  type DesignAgentReplayExpectation,
  type DesignAgentRunInput,
  type FrozenDesignAgentReplay
} from "./contracts.js";
import { deepFreezeProductionValue } from "./production-boundary.js";
import {
  DESIGN_AGENT_VALIDATOR_HANDOFF_BINDING_SCHEMA,
  bindDesignAgentAttemptCheckpoint,
  bindDesignAgentRunBinding,
  bindDesignAgentStageSubject,
  createDesignAgentAttemptCheckpoint,
  type DesignAgentAttemptCheckpoint,
  type DesignAgentProposalRequiredRunBinding,
  type DesignAgentStageSubject
} from "./workflow-contracts.js";

const FAILURE = "AGENT_WORKFLOW_ORCHESTRATOR_INVALID" as const;
const JSON_LIMITS = Object.freeze({
  maximumDepth: DESIGN_AGENT_LIMITS.replayGraphDepth,
  maximumNodes: DESIGN_AGENT_LIMITS.replayGraphNodes,
  maximumStringBytes: DESIGN_AGENT_LIMITS.replayStringBytes,
  maximumAggregateStringBytes: DESIGN_AGENT_LIMITS.replayStringBytes
});
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer"
)?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength"
)?.get;
const typedArraySet = Uint8Array.prototype.set;
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export type DesignAgentWorkflowIntent = "resume" | "explicit_rerun";
export type DesignAgentWorkflowAcquisition =
  | "off"
  | "live_traceable"
  | "frozen_exact_replay";

export interface DesignAgentWorkflowCoordinatorPort {
  /** Current host-authenticated fixed binding; it must exactly match the immutable run binding. */
  readonly runBinding: DesignAgentProposalRequiredRunBinding;
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
  replay(replay: unknown, expectation: DesignAgentReplayExpectation): Promise<unknown>;
}

/** Internal-only CAS boundary. Implementations must not publish archived replay bytes. */
export interface DesignAgentReplayArchivePort {
  put(bytes: Uint8Array | string, expected?: ContentIdentity): Promise<unknown>;
  get(identity: ContentIdentity): Promise<unknown>;
}

export type DesignAgentWorkflowValidatorRegistryPort =
  DesignAgentDeterministicValidatorRegistry;

export interface DesignAgentWorkflowOffRequest {
  readonly mode: "off";
}

export interface DesignAgentWorkflowProposalRequest {
  readonly mode: "proposal_required";
  readonly intent: DesignAgentWorkflowIntent;
  readonly attemptId: string;
  readonly runBinding: DesignAgentProposalRequiredRunBinding;
  readonly subject: DesignAgentStageSubject;
  readonly input: DesignAgentRunInput;
  /** Required to be explicit. It is deliberately ignored for an explicit rerun. */
  readonly priorCheckpoint: DesignAgentAttemptCheckpoint | null;
}

export type DesignAgentWorkflowRequest =
  | DesignAgentWorkflowOffRequest
  | DesignAgentWorkflowProposalRequest;

export interface DesignAgentWorkflowOffResult {
  readonly mode: "off";
  readonly acquisition: "off";
  readonly result: null;
  readonly checkpoint: null;
}

export interface DesignAgentWorkflowProposalResult {
  readonly mode: "proposal_required";
  readonly acquisition: "live_traceable" | "frozen_exact_replay";
  readonly result: DesignAgentProposalResult;
  readonly validatorPlan: DesignAgentDeterministicValidatorPlan;
  readonly checkpoint: DesignAgentAttemptCheckpoint;
}

export type DesignAgentWorkflowResult =
  | DesignAgentWorkflowOffResult
  | DesignAgentWorkflowProposalResult;

export class DesignAgentWorkflowOrchestratorError extends DomainError {
  public constructor(
    code: ConstructorParameters<typeof DomainError>[0],
    public readonly failureCode: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code, message, { failureCode, ...details }, false);
    this.name = "DesignAgentWorkflowOrchestratorError";
  }
}

function reject(
  code: ConstructorParameters<typeof DomainError>[0],
  failureCode: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new DesignAgentWorkflowOrchestratorError(code, failureCode, message, details);
}

interface SnapshotState {
  nodes: number;
  aggregateStringBytes: number;
  readonly active: Set<object>;
}

/**
 * Copies only the bounded enumerable JSON authority surface. Hidden and symbol carrier metadata is
 * never enumerated, read, or copied; inherited enumerable data is rejected immediately.
 */
const snapshotPlainJson = (
  value: unknown,
  limits: typeof JSON_LIMITS,
  failureCode: string,
  label: string
): unknown => {
  const state: SnapshotState = { nodes: 0, aggregateStringBytes: 0, active: new Set() };
  const visit = (candidate: unknown, depth: number, path: string): unknown => {
    state.nodes += 1;
    if (state.nodes > limits.maximumNodes || depth > limits.maximumDepth) {
      reject("INVALID_ARGUMENT", failureCode, `${label} exceeds its bounded graph limit`);
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const bytes = Buffer.byteLength(candidate, "utf8");
      state.aggregateStringBytes += bytes;
      if (
        bytes > limits.maximumStringBytes ||
        state.aggregateStringBytes > limits.maximumAggregateStringBytes
      ) {
        reject("INVALID_ARGUMENT", failureCode, `${label} exceeds its string byte limit`);
      }
      return candidate;
    }
    if (candidate === null || typeof candidate !== "object" || nodeTypes.isProxy(candidate)) {
      reject("INVALID_ARGUMENT", failureCode, `${path} is not plain JSON data`);
    }
    if (state.active.has(candidate)) {
      reject("INVALID_ARGUMENT", failureCode, `${label} contains a cycle`);
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype) {
        reject("INVALID_ARGUMENT", failureCode, `${path} must be a plain array`);
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      reject("INVALID_ARGUMENT", failureCode, `${path} must be a plain object`);
    }

    state.active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > limits.maximumNodes - state.nodes
        ) {
          reject("INVALID_ARGUMENT", failureCode, `${path} exceeds its bounded array width`);
        }
        const length = lengthDescriptor.value as number;
        let enumerableOwnKeys = 0;
        for (const key in candidate) {
          if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
            reject("INVALID_ARGUMENT", failureCode, `${path} contains inherited enumerable data`);
          }
          enumerableOwnKeys += 1;
          state.aggregateStringBytes += Buffer.byteLength(key, "utf8");
          const index = Number(key);
          if (
            enumerableOwnKeys > length ||
            state.aggregateStringBytes > limits.maximumAggregateStringBytes ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= length ||
            String(index) !== key
          ) {
            reject("INVALID_ARGUMENT", failureCode, `${path} must be a bounded dense array`);
          }
        }
        if (enumerableOwnKeys !== length) {
          reject("INVALID_ARGUMENT", failureCode, `${path} must be a dense enumerable array`);
        }
        const copy: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
            reject("INVALID_ARGUMENT", failureCode, `${path} contains a non-data array entry`);
          }
          copy.push(visit(descriptor.value, depth + 1, `${path}[${index}]`));
        }
        return copy;
      }

      const copy = Object.create(null) as Record<string, unknown>;
      let enumerableOwnKeys = 0;
      for (const key in candidate as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
          reject("INVALID_ARGUMENT", failureCode, `${path} contains inherited enumerable data`);
        }
        enumerableOwnKeys += 1;
        state.aggregateStringBytes += Buffer.byteLength(key, "utf8");
        if (
          enumerableOwnKeys > limits.maximumNodes - state.nodes ||
          state.aggregateStringBytes > limits.maximumAggregateStringBytes
        ) {
          reject("INVALID_ARGUMENT", failureCode, `${path} exceeds its bounded object width`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          reject("INVALID_ARGUMENT", failureCode, `${path}.${key} must be an enumerable data property`);
        }
        copy[key] = visit(descriptor.value, depth + 1, `${path}.${key}`);
      }
      return copy;
    } finally {
      state.active.delete(candidate);
    }
  };
  return deepFreezeProductionValue(visit(value, 0, label));
};

const OFF_RESULT: DesignAgentWorkflowOffResult = deepFreezeProductionValue({
  mode: "off",
  acquisition: "off",
  result: null,
  checkpoint: null
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactRecord = (
  value: unknown,
  expectedKeys: readonly string[],
  failureCode: string,
  label: string
): Record<string, unknown> => {
  if (!isPlainRecord(value)) {
    reject("INVALID_ARGUMENT", failureCode, `${label} must be a non-proxy plain object`);
  }
  const expected = new Set(expectedKeys);
  const seen = new Set<string>();
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || !expected.has(key) || seen.has(key)) {
      reject("INVALID_ARGUMENT", failureCode, `${label} contains an unknown enumerable field`);
    }
    seen.add(key);
    if (seen.size > expectedKeys.length) {
      reject("INVALID_ARGUMENT", failureCode, `${label} exceeds its closed field count`);
    }
  }
  if (seen.size !== expectedKeys.length) {
    reject("INVALID_ARGUMENT", failureCode, `${label} contains missing fields`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      reject("INVALID_ARGUMENT", failureCode, `${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
};

const boundedExactRecord = exactRecord;

const dataField = (
  value: Record<string, unknown>,
  key: string,
  failureCode: string,
  label: string
): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
    reject("INVALID_ARGUMENT", failureCode, `${label}.${key} must be an enumerable data property`);
  }
  return descriptor.value;
};

const snapshotCanonicalIdentity = (
  value: unknown,
  failureCode: string,
  label: string,
  expectedSchema?: string
): CanonicalIdentity => {
  const record = exactRecord(
    value,
    ["algorithm", "canonicalizationVersion", "digest", "schemaVersion"],
    failureCode,
    label
  );
  if (
    record.algorithm !== "sha256" ||
    record.canonicalizationVersion !== "evleda-c14n-json-v1" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    typeof record.schemaVersion !== "string" ||
    record.schemaVersion.length === 0 ||
    (expectedSchema !== undefined && record.schemaVersion !== expectedSchema)
  ) {
    reject("DIGEST_MISMATCH", failureCode, `${label} is not the expected canonical identity`);
  }
  return deepFreezeProductionValue({
    algorithm: "sha256" as const,
    digest: record.digest,
    schemaVersion: record.schemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1" as const
  });
};

const snapshotContentIdentity = (
  value: unknown,
  failureCode: string,
  label: string
): ContentIdentity => {
  const record = exactRecord(value, ["algorithm", "digest", "size"], failureCode, label);
  if (
    record.algorithm !== "sha256" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0
  ) {
    reject("DIGEST_MISMATCH", failureCode, `${label} is not a valid content identity`);
  }
  return Object.freeze({
    algorithm: "sha256" as const,
    digest: record.digest,
    size: record.size as number
  });
};

const canonicalIdentitiesEqual = (
  left: CanonicalIdentity,
  right: CanonicalIdentity
): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.canonicalizationVersion === right.canonicalizationVersion &&
  constantTimeDigestEqual(left.digest, right.digest);

const contentIdentitiesEqual = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.size === right.size && constantTimeDigestEqual(left.digest, right.digest);

const requireCanonicalIdentity = (
  actual: CanonicalIdentity,
  expected: CanonicalIdentity,
  failureCode: string,
  message: string
): void => {
  if (!canonicalIdentitiesEqual(actual, expected)) {
    reject("DIGEST_MISMATCH", failureCode, message, {
      expectedSchemaVersion: expected.schemaVersion,
      expectedDigest: expected.digest,
      actualSchemaVersion: actual.schemaVersion,
      actualDigest: actual.digest
    });
  }
};

const requireContentIdentity = (
  actual: ContentIdentity,
  expected: ContentIdentity,
  failureCode: string,
  message: string
): void => {
  if (!contentIdentitiesEqual(actual, expected)) {
    reject("DIGEST_MISMATCH", failureCode, message, {
      expectedDigest: expected.digest,
      expectedSize: expected.size,
      actualDigest: actual.digest,
      actualSize: actual.size
    });
  }
};

const withoutIdentity = (record: Record<string, unknown>): Record<string, unknown> => {
  const payload = Object.create(null) as Record<string, unknown>;
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key) && key !== "identity") {
      payload[key] = record[key];
    }
  }
  return payload;
};

const requireRecordIdentity = (
  record: Record<string, unknown>,
  schemaVersion: string,
  failureCode: string,
  label: string
): CanonicalIdentity => {
  const identity = snapshotCanonicalIdentity(
    dataField(record, "identity", failureCode, label),
    failureCode,
    `${label}.identity`,
    schemaVersion
  );
  requireCanonicalIdentity(
    identity,
    canonicalIdentity(withoutIdentity(record), schemaVersion),
    failureCode,
    `${label} canonical identity does not reproduce`
  );
  return identity;
};

const boundedIdentifier = (value: unknown, failureCode: string, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u.test(value)
  ) {
    reject("INVALID_ARGUMENT", failureCode, `${label} is not a bounded identifier`);
  }
  return value;
};

interface InspectedCoordinator {
  readonly runBinding: DesignAgentProposalRequiredRunBinding;
  readonly execute: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
  readonly replay: (replay: unknown, expectation: DesignAgentReplayExpectation) => Promise<unknown>;
}

interface InspectedReplayArchive {
  readonly put: (bytes: Uint8Array | string, expected?: ContentIdentity) => Promise<unknown>;
  readonly get: (identity: ContentIdentity) => Promise<unknown>;
}

interface InspectedValidatorRegistry {
  readonly identity: CanonicalIdentity;
  readonly snapshot: DesignAgentDeterministicValidatorRegistrySnapshot;
  readonly plan: (
    input: DesignAgentDeterministicValidatorPlanInput
  ) => DesignAgentDeterministicValidatorPlan;
}

const inspectCoordinator = (
  value: unknown,
  expectedRunBinding: DesignAgentProposalRequiredRunBinding
): InspectedCoordinator => {
  const port = boundedExactRecord(
    value,
    ["execute", "replay", "runBinding"],
    "AGENT_WORKFLOW_COORDINATOR_PORT_INVALID",
    "workflowCoordinator"
  );
  const execute = dataField(
    port,
    "execute",
    "AGENT_WORKFLOW_COORDINATOR_PORT_INVALID",
    "workflowCoordinator"
  );
  const replay = dataField(
    port,
    "replay",
    "AGENT_WORKFLOW_COORDINATOR_PORT_INVALID",
    "workflowCoordinator"
  );
  if (
    typeof execute !== "function" ||
    nodeTypes.isProxy(execute) ||
    typeof replay !== "function" ||
    nodeTypes.isProxy(replay)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_WORKFLOW_COORDINATOR_PORT_INVALID",
      "Workflow coordinator methods must be non-proxy functions"
    );
  }
  const runBinding = bindDesignAgentRunBinding(dataField(
    port,
    "runBinding",
    "AGENT_WORKFLOW_COORDINATOR_PORT_INVALID",
    "workflowCoordinator"
  ));
  if (runBinding.mode !== "proposal_required") {
    reject(
      "POLICY_DENIED",
      "AGENT_WORKFLOW_COORDINATOR_BINDING_DRIFT",
      "Workflow coordinator does not attest a proposal-required fixed binding"
    );
  }
  requireCanonicalIdentity(
    runBinding.identity,
    expectedRunBinding.identity,
    "AGENT_WORKFLOW_COORDINATOR_BINDING_DRIFT",
    "Workflow coordinator fixed binding differs from the immutable run binding"
  );
  return Object.freeze({
    runBinding,
    execute: async (input: unknown, signal?: AbortSignal) =>
      await Reflect.apply(execute, value, [input, signal]),
    replay: async (replayValue: unknown, expectation: DesignAgentReplayExpectation) =>
      await Reflect.apply(replay, value, [replayValue, expectation])
  });
};

const inspectReplayArchive = (value: unknown): InspectedReplayArchive => {
  const port = boundedExactRecord(
    value,
    ["get", "put"],
    "AGENT_WORKFLOW_REPLAY_ARCHIVE_PORT_INVALID",
    "replayArchive"
  );
  const put = dataField(
    port,
    "put",
    "AGENT_WORKFLOW_REPLAY_ARCHIVE_PORT_INVALID",
    "replayArchive"
  );
  const get = dataField(
    port,
    "get",
    "AGENT_WORKFLOW_REPLAY_ARCHIVE_PORT_INVALID",
    "replayArchive"
  );
  if (
    typeof put !== "function" ||
    nodeTypes.isProxy(put) ||
    typeof get !== "function" ||
    nodeTypes.isProxy(get)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_WORKFLOW_REPLAY_ARCHIVE_PORT_INVALID",
      "Replay archive methods must be non-proxy functions"
    );
  }
  return Object.freeze({
    put: async (bytes: Uint8Array | string, expected?: ContentIdentity) =>
      await Reflect.apply(put, value, [bytes, expected]),
    get: async (identity: ContentIdentity) => await Reflect.apply(get, value, [identity])
  });
};

const inspectValidatorRegistry = (
  value: unknown,
  expectedRunBinding: DesignAgentProposalRequiredRunBinding
): InspectedValidatorRegistry => {
  const registry = boundedExactRecord(
    value,
    [
      "authority",
      "mandatoryValidatorIds",
      "plan",
      "registeredValidatorIds",
      "resolve",
      "snapshot"
    ],
    "AGENT_WORKFLOW_VALIDATOR_REGISTRY_PORT_INVALID",
    "validatorRegistry"
  );
  if (registry.authority !== "host_owned_workflow_policy") {
    reject(
      "POLICY_DENIED",
      "AGENT_WORKFLOW_VALIDATOR_REGISTRY_PORT_INVALID",
      "Validator registry does not carry host-owned workflow-policy authority"
    );
  }
  for (const methodName of [
    "mandatoryValidatorIds",
    "plan",
    "registeredValidatorIds",
    "resolve",
    "snapshot"
  ] as const) {
    const method = dataField(
      registry,
      methodName,
      "AGENT_WORKFLOW_VALIDATOR_REGISTRY_PORT_INVALID",
      "validatorRegistry"
    );
    if (typeof method !== "function" || nodeTypes.isProxy(method)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_WORKFLOW_VALIDATOR_REGISTRY_PORT_INVALID",
        `Validator registry ${methodName} must be a non-proxy data method`
      );
    }
  }
  const snapshotMethod = registry.snapshot as () => unknown;
  let snapshotValue: unknown;
  try {
    snapshotValue = Reflect.apply(snapshotMethod, value, []);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_WORKFLOW_VALIDATOR_REGISTRY_SNAPSHOT_FAILED",
      "Host-owned validator registry failed to return its immutable snapshot"
    );
  }
  const snapshot = snapshotPlainJson(
    snapshotValue,
    JSON_LIMITS,
    "AGENT_WORKFLOW_VALIDATOR_REGISTRY_SNAPSHOT_INVALID",
    "validatorRegistry.snapshot"
  );
  const snapshotRecord = exactRecord(
    snapshot,
    [
      "authority",
      "identity",
      "mandatoryCoverage",
      "outdatedValidatorIds",
      "schemaVersion",
      "validators"
    ],
    "AGENT_WORKFLOW_VALIDATOR_REGISTRY_SNAPSHOT_INVALID",
    "validatorRegistry.snapshot"
  );
  if (
    snapshotRecord.schemaVersion !== DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA ||
    snapshotRecord.authority !== "host_owned_workflow_policy"
  ) {
    reject(
      "POLICY_DENIED",
      "AGENT_WORKFLOW_VALIDATOR_REGISTRY_SNAPSHOT_INVALID",
      "Validator registry snapshot schema or authority is invalid"
    );
  }
  const identity = requireRecordIdentity(
    snapshotRecord,
    DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA,
    "AGENT_WORKFLOW_VALIDATOR_REGISTRY_SNAPSHOT_INVALID",
    "validatorRegistry.snapshot"
  );
  requireCanonicalIdentity(
    identity,
    expectedRunBinding.validatorRegistryIdentity,
    "AGENT_WORKFLOW_VALIDATOR_REGISTRY_DRIFT",
    "Current host validator registry differs from the immutable run binding"
  );
  const planMethod = registry.plan as (
    input: DesignAgentDeterministicValidatorPlanInput
  ) => DesignAgentDeterministicValidatorPlan;
  const normalizedSnapshot = deepFreezeProductionValue(
    JSON.parse(canonicalJson(snapshotRecord)) as DesignAgentDeterministicValidatorRegistrySnapshot
  );
  return Object.freeze({
    identity,
    snapshot: normalizedSnapshot,
    plan: (input: DesignAgentDeterministicValidatorPlanInput) =>
      Reflect.apply(planMethod, value, [input])
  });
};

interface SnapshotProposalRequest {
  readonly intent: DesignAgentWorkflowIntent;
  readonly attemptId: string;
  readonly runBinding: DesignAgentProposalRequiredRunBinding;
  readonly subject: DesignAgentStageSubject;
  readonly input: DesignAgentRunInput;
  readonly priorCheckpoint: DesignAgentAttemptCheckpoint | null;
}

const RUN_INPUT_KEYS = [
  "context",
  "instructionDocument",
  "model",
  "practiceCatalog",
  "practiceCatalogLogicalName",
  "referenceIndex",
  "role",
  "settings",
  "sourcePrompt",
  "stage",
  "trustAnchors"
] as const;

const validateInputAgainstRunBinding = (
  inputValue: unknown,
  runBinding: DesignAgentProposalRequiredRunBinding,
  subject: DesignAgentStageSubject
): DesignAgentRunInput => {
  const input = exactRecord(
    inputValue,
    RUN_INPUT_KEYS,
    "AGENT_WORKFLOW_INPUT_INVALID",
    "workflowRequest.input"
  );
  if (input.stage !== subject.stage) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_WORKFLOW_SUBJECT_INPUT_MISMATCH",
      "Agent input stage must match the stable stage subject"
    );
  }
  if (canonicalJson(input.trustAnchors) !== canonicalJson(runBinding.trustAnchors)) {
    reject(
      "POLICY_DENIED",
      "AGENT_WORKFLOW_INPUT_BINDING_DRIFT",
      "Agent input trust anchors differ from the immutable run binding"
    );
  }
  const instruction = exactRecord(
    input.instructionDocument,
    ["content", "identity", "kind", "logicalName"],
    "AGENT_WORKFLOW_INPUT_INVALID",
    "workflowRequest.input.instructionDocument"
  );
  if (typeof instruction.content !== "string") {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_WORKFLOW_INPUT_INVALID",
      "Agent instruction content must be text"
    );
  }
  const instructionIdentity = snapshotContentIdentity(
    instruction.identity,
    "AGENT_WORKFLOW_INPUT_INVALID",
    "workflowRequest.input.instructionDocument.identity"
  );
  requireContentIdentity(
    instructionIdentity,
    contentIdentity(instruction.content),
    "AGENT_WORKFLOW_INPUT_BINDING_DRIFT",
    "Agent instruction bytes do not reproduce their identity"
  );
  requireContentIdentity(
    instructionIdentity,
    runBinding.instructionIdentity,
    "AGENT_WORKFLOW_INPUT_BINDING_DRIFT",
    "Agent instruction identity differs from the immutable run binding"
  );
  const practiceCatalog = isPlainRecord(input.practiceCatalog)
    ? input.practiceCatalog
    : reject(
        "INVALID_ARGUMENT",
        "AGENT_WORKFLOW_INPUT_INVALID",
        "Agent practice catalog must be a plain object"
      );
  requireCanonicalIdentity(
    snapshotCanonicalIdentity(
      dataField(
        practiceCatalog,
        "identity",
        "AGENT_WORKFLOW_INPUT_INVALID",
        "workflowRequest.input.practiceCatalog"
      ),
      "AGENT_WORKFLOW_INPUT_INVALID",
      "workflowRequest.input.practiceCatalog.identity"
    ),
    runBinding.practiceCatalogIdentity,
    "AGENT_WORKFLOW_INPUT_BINDING_DRIFT",
    "Agent practice-catalog identity differs from the immutable run binding"
  );
  const model = exactRecord(
    input.model,
    ["identity", "model", "provider", "version"],
    "AGENT_WORKFLOW_INPUT_INVALID",
    "workflowRequest.input.model"
  );
  requireCanonicalIdentity(
    snapshotCanonicalIdentity(
      model.identity,
      "AGENT_WORKFLOW_INPUT_INVALID",
      "workflowRequest.input.model.identity"
    ),
    runBinding.modelIdentity,
    "AGENT_WORKFLOW_INPUT_BINDING_DRIFT",
    "Agent model identity differs from the immutable run binding"
  );
  const settings = exactRecord(
    input.settings,
    ["identity", "value"],
    "AGENT_WORKFLOW_INPUT_INVALID",
    "workflowRequest.input.settings"
  );
  requireCanonicalIdentity(
    snapshotCanonicalIdentity(
      settings.identity,
      "AGENT_WORKFLOW_INPUT_INVALID",
      "workflowRequest.input.settings.identity"
    ),
    runBinding.settingsIdentity,
    "AGENT_WORKFLOW_INPUT_BINDING_DRIFT",
    "Agent settings identity differs from the immutable run binding"
  );
  return input as unknown as DesignAgentRunInput;
};

const snapshotRequest = (
  requestValue: unknown
): DesignAgentWorkflowOffRequest | SnapshotProposalRequest => {
  if (!isPlainRecord(requestValue)) {
    reject("INVALID_ARGUMENT", "AGENT_WORKFLOW_REQUEST_INVALID", "Workflow request must be a plain object");
  }
  const modeDescriptor = Object.getOwnPropertyDescriptor(requestValue, "mode");
  if (
    modeDescriptor === undefined ||
    !("value" in modeDescriptor) ||
    modeDescriptor.enumerable !== true
  ) {
    reject("INVALID_ARGUMENT", "AGENT_WORKFLOW_REQUEST_INVALID", "Workflow mode must be an own data property");
  }

  if (modeDescriptor.value === "off") {
    boundedExactRecord(requestValue, ["mode"], "AGENT_WORKFLOW_REQUEST_INVALID", "workflowRequest");
    return OFF_RESULT;
  }
  if (modeDescriptor.value !== "proposal_required") {
    reject("INVALID_ARGUMENT", "AGENT_WORKFLOW_MODE_INVALID", "Workflow mode must be explicit");
  }
  const request = boundedExactRecord(
    requestValue,
    ["attemptId", "input", "intent", "mode", "priorCheckpoint", "runBinding", "subject"],
    "AGENT_WORKFLOW_REQUEST_INVALID",
    "workflowRequest"
  );
  const intent = dataField(request, "intent", "AGENT_WORKFLOW_REQUEST_INVALID", "workflowRequest");
  if (intent !== "resume" && intent !== "explicit_rerun") {
    reject("INVALID_ARGUMENT", "AGENT_WORKFLOW_INTENT_INVALID", "Workflow intent must be explicit");
  }
  const attemptId = boundedIdentifier(
    dataField(request, "attemptId", "AGENT_WORKFLOW_REQUEST_INVALID", "workflowRequest"),
    "AGENT_WORKFLOW_REQUEST_INVALID",
    "workflowRequest.attemptId"
  );
  const runBinding = bindDesignAgentRunBinding(
    dataField(request, "runBinding", "AGENT_WORKFLOW_REQUEST_INVALID", "workflowRequest")
  );
  if (runBinding.mode !== "proposal_required") {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_WORKFLOW_BINDING_MODE_MISMATCH",
      "Proposal orchestration requires a proposal-required run binding"
    );
  }
  const subject = bindDesignAgentStageSubject(
    dataField(request, "subject", "AGENT_WORKFLOW_REQUEST_INVALID", "workflowRequest")
  );
  const input = snapshotPlainJson(
    dataField(request, "input", "AGENT_WORKFLOW_REQUEST_INVALID", "workflowRequest"),
    JSON_LIMITS,
    "AGENT_WORKFLOW_INPUT_INVALID",
    "workflowRequest.input"
  );
  const boundInput = validateInputAgainstRunBinding(input, runBinding, subject);

  let priorCheckpoint: DesignAgentAttemptCheckpoint | null = null;
  if (intent === "resume") {
    const checkpointValue = dataField(
      request,
      "priorCheckpoint",
      "AGENT_WORKFLOW_REQUEST_INVALID",
      "workflowRequest"
    );
    priorCheckpoint = checkpointValue === null
      ? null
      : bindDesignAgentAttemptCheckpoint(checkpointValue, { subject, runBinding });
  }

  return deepFreezeProductionValue({
    intent,
    attemptId,
    runBinding,
    subject,
    input: boundInput,
    priorCheckpoint
  });
};

const RESULT_KEYS = [
  "classification",
  "contextInputIdentities",
  "evidenceClass",
  "identity",
  "instructionIdentity",
  "modelIdentity",
  "outputContractBytesIdentity",
  "outputContractIdentity",
  "practiceCatalogIdentity",
  "promptPackIdentity",
  "providerIdentity",
  "rawOutputIdentity",
  "referenceIndexIdentity",
  "regenerationPolicy",
  "regenerationPolicyIdentity",
  "requestIdentity",
  "role",
  "schemaVersion",
  "settingsIdentity",
  "sourcePromptIdentity",
  "stage",
  "structuredProposal",
  "structuredProposalIdentity",
  "trustAnchors",
  "trustManifestIdentity",
  "untrustedNarrative",
  "untrustedNarrativeIdentity",
  "validationDisposition",
  "validatorHandoff"
] as const;

interface ValidatedProposalResult {
  readonly value: DesignAgentProposalResult;
  readonly identity: CanonicalIdentity;
  readonly validatorHandoffIdentity: CanonicalIdentity;
}

const validateProposalResult = (value: unknown, label: string): ValidatedProposalResult => {
  const result = exactRecord(value, RESULT_KEYS, FAILURE, label);
  if (result.schemaVersion !== DESIGN_AGENT_RESULT_SCHEMA) {
    reject("DIGEST_MISMATCH", FAILURE, `${label} has an unsupported schema`);
  }
  const identity = requireRecordIdentity(result, DESIGN_AGENT_RESULT_SCHEMA, FAILURE, label);
  const structuredProposalIdentity = snapshotCanonicalIdentity(
    result.structuredProposalIdentity,
    FAILURE,
    `${label}.structuredProposalIdentity`,
    DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
  );
  requireCanonicalIdentity(
    structuredProposalIdentity,
    canonicalIdentity(result.structuredProposal, DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA),
    FAILURE,
    `${label} structured proposal identity does not reproduce`
  );
  const narrativeIdentity = snapshotCanonicalIdentity(
    result.untrustedNarrativeIdentity,
    FAILURE,
    `${label}.untrustedNarrativeIdentity`,
    DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA
  );
  requireCanonicalIdentity(
    narrativeIdentity,
    canonicalIdentity(result.untrustedNarrative, DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA),
    FAILURE,
    `${label} narrative identity does not reproduce`
  );
  const validatorHandoffIdentity = deepFreezeProductionValue(
    canonicalIdentity(result.validatorHandoff, DESIGN_AGENT_VALIDATOR_HANDOFF_BINDING_SCHEMA)
  );
  return deepFreezeProductionValue({
    value: result as unknown as DesignAgentProposalResult,
    identity,
    validatorHandoffIdentity
  });
};

const PROMPT_PACK_KEYS = [
  "context",
  "exactInputs",
  "identity",
  "instructionDocument",
  "model",
  "outputContract",
  "practiceCatalog",
  "practiceCatalogLogicalName",
  "referenceIndex",
  "role",
  "roleObjective",
  "schemaVersion",
  "settings",
  "sourcePrompt",
  "stage",
  "trustAnchors",
  "trustManifestIdentity"
] as const;

interface ValidatedReplay {
  readonly replay: FrozenDesignAgentReplay;
  readonly replayIdentity: CanonicalIdentity;
  readonly result: DesignAgentProposalResult;
  readonly resultIdentity: CanonicalIdentity;
  readonly validatorHandoffIdentity: CanonicalIdentity;
}

const validateReplay = (value: unknown, label: string): ValidatedReplay => {
  const replay = exactRecord(
    value,
    ["identity", "request", "response", "result", "schemaVersion"],
    FAILURE,
    label
  );
  if (replay.schemaVersion !== DESIGN_AGENT_REPLAY_SCHEMA) {
    reject("DIGEST_MISMATCH", FAILURE, `${label} has an unsupported schema`);
  }
  const replayIdentity = requireRecordIdentity(replay, DESIGN_AGENT_REPLAY_SCHEMA, FAILURE, label);
  const request = exactRecord(
    replay.request,
    ["promptPack", "provider", "requestIdentity", "schemaVersion"],
    FAILURE,
    `${label}.request`
  );
  if (request.schemaVersion !== DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA) {
    reject("DIGEST_MISMATCH", FAILURE, `${label}.request has an unsupported schema`);
  }
  const promptPack = exactRecord(
    request.promptPack,
    PROMPT_PACK_KEYS,
    FAILURE,
    `${label}.request.promptPack`
  );
  if (promptPack.schemaVersion !== DESIGN_AGENT_PROMPT_PACK_SCHEMA) {
    reject("DIGEST_MISMATCH", FAILURE, `${label}.request.promptPack has an unsupported schema`);
  }
  const promptPackIdentity = requireRecordIdentity(
    promptPack,
    DESIGN_AGENT_PROMPT_PACK_SCHEMA,
    FAILURE,
    `${label}.request.promptPack`
  );
  const requestIdentity = snapshotCanonicalIdentity(
    request.requestIdentity,
    FAILURE,
    `${label}.request.requestIdentity`,
    DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA
  );
  requireCanonicalIdentity(
    requestIdentity,
    canonicalIdentity(
      {
        schemaVersion: request.schemaVersion,
        provider: request.provider,
        promptPack: request.promptPack
      },
      DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA
    ),
    FAILURE,
    `${label}.request identity does not reproduce`
  );

  const response = exactRecord(
    replay.response,
    [
      "modelIdentity",
      "outputContractBytesIdentity",
      "outputContractIdentity",
      "promptPackIdentity",
      "providerIdentity",
      "rawOutput",
      "requestIdentity",
      "role",
      "schemaVersion",
      "settingsIdentity",
      "stage"
    ],
    FAILURE,
    `${label}.response`
  );
  if (
    response.schemaVersion !== DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA ||
    typeof response.rawOutput !== "string"
  ) {
    reject("DIGEST_MISMATCH", FAILURE, `${label}.response is invalid`);
  }
  const result = validateProposalResult(replay.result, `${label}.result`);

  const linkedCanonicalIdentities: readonly [unknown, unknown, string, string?][] = [
    [request.requestIdentity, result.value.requestIdentity, "request identity", DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA],
    [promptPack.identity, result.value.promptPackIdentity, "prompt-pack identity", DESIGN_AGENT_PROMPT_PACK_SCHEMA],
    [response.requestIdentity, request.requestIdentity, "response request identity", DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA],
    [response.promptPackIdentity, promptPack.identity, "response prompt-pack identity", DESIGN_AGENT_PROMPT_PACK_SCHEMA],
    [response.providerIdentity, result.value.providerIdentity, "provider identity"],
    [response.modelIdentity, result.value.modelIdentity, "model identity"],
    [response.settingsIdentity, result.value.settingsIdentity, "settings identity"],
    [response.outputContractIdentity, result.value.outputContractIdentity, "output-contract identity"]
  ];
  for (const [leftValue, rightValue, relation, expectedSchema] of linkedCanonicalIdentities) {
    const left = snapshotCanonicalIdentity(leftValue, FAILURE, `${label}.${relation}.left`, expectedSchema);
    const right = snapshotCanonicalIdentity(rightValue, FAILURE, `${label}.${relation}.right`, expectedSchema);
    requireCanonicalIdentity(left, right, FAILURE, `${label} has a mismatched ${relation}`);
  }
  const responseOutputBytes = snapshotContentIdentity(
    response.outputContractBytesIdentity,
    FAILURE,
    `${label}.response.outputContractBytesIdentity`
  );
  const resultOutputBytes = snapshotContentIdentity(
    result.value.outputContractBytesIdentity,
    FAILURE,
    `${label}.result.outputContractBytesIdentity`
  );
  requireContentIdentity(
    responseOutputBytes,
    resultOutputBytes,
    FAILURE,
    `${label} has mismatched output-contract bytes`
  );
  const rawOutputIdentity = snapshotContentIdentity(
    result.value.rawOutputIdentity,
    FAILURE,
    `${label}.result.rawOutputIdentity`
  );
  requireContentIdentity(
    rawOutputIdentity,
    contentIdentity(response.rawOutput),
    FAILURE,
    `${label} raw output does not match the result binding`
  );
  if (
    response.stage !== result.value.stage ||
    response.role !== result.value.role ||
    promptPack.stage !== result.value.stage ||
    promptPack.role !== result.value.role
  ) {
    reject("DIGEST_MISMATCH", FAILURE, `${label} stage or role bindings do not match`);
  }

  return deepFreezeProductionValue({
    replay: replay as unknown as FrozenDesignAgentReplay,
    replayIdentity,
    result: result.value,
    resultIdentity: result.identity,
    validatorHandoffIdentity: result.validatorHandoffIdentity
  });
};

interface ValidatedLiveExecution extends ValidatedReplay {
  readonly receiptId: string;
  readonly receiptIdentity: CanonicalIdentity;
}

const validateLiveExecution = (value: unknown): ValidatedLiveExecution => {
  const snapshot = snapshotPlainJson(
    value,
    JSON_LIMITS,
    "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID",
    "liveExecution"
  );
  const execution = exactRecord(
    snapshot,
    ["mode", "replay", "replayReceipt", "result"],
    "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID",
    "liveExecution"
  );
  if (execution.mode !== "live_traceable") {
    reject("DIGEST_MISMATCH", "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID", "Coordinator did not return a live capture");
  }
  const replay = validateReplay(execution.replay, "liveExecution.replay");
  if (canonicalJson(execution.result) !== canonicalJson(replay.result)) {
    reject("DIGEST_MISMATCH", "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID", "Live result differs from archived replay result");
  }
  const receipt = exactRecord(
    execution.replayReceipt,
    [
      "identity",
      "promptPackIdentity",
      "providerIdentity",
      "receiptId",
      "replayIdentity",
      "schemaVersion",
      "trustManifestIdentity"
    ],
    "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID",
    "liveExecution.replayReceipt"
  );
  if (receipt.schemaVersion !== DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA) {
    reject("DIGEST_MISMATCH", "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID", "Replay receipt schema is unsupported");
  }
  const receiptIdentity = requireRecordIdentity(
    receipt,
    DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
    "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID",
    "liveExecution.replayReceipt"
  );
  const receiptId = boundedIdentifier(
    receipt.receiptId,
    "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID",
    "liveExecution.replayReceipt.receiptId"
  );
  if (receiptId !== `replay_${replay.replayIdentity.digest}`) {
    reject("DIGEST_MISMATCH", "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID", "Replay receipt ID is not derived from replay identity");
  }
  requireCanonicalIdentity(
    snapshotCanonicalIdentity(receipt.replayIdentity, FAILURE, "receipt.replayIdentity", DESIGN_AGENT_REPLAY_SCHEMA),
    replay.replayIdentity,
    "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID",
    "Replay receipt does not bind the full replay"
  );
  for (const [receiptValue, resultValue, relation] of [
    [receipt.trustManifestIdentity, replay.result.trustManifestIdentity, "trust manifest"],
    [receipt.providerIdentity, replay.result.providerIdentity, "provider"],
    [receipt.promptPackIdentity, replay.result.promptPackIdentity, "prompt pack"]
  ] as const) {
    requireCanonicalIdentity(
      snapshotCanonicalIdentity(receiptValue, FAILURE, `receipt.${relation}`),
      snapshotCanonicalIdentity(resultValue, FAILURE, `result.${relation}`),
      "AGENT_WORKFLOW_LIVE_EXECUTION_INVALID",
      `Replay receipt does not bind the ${relation}`
    );
  }
  return deepFreezeProductionValue({ ...replay, receiptId, receiptIdentity });
};

const validateCheckpointReplay = (
  replay: ValidatedReplay,
  checkpoint: DesignAgentAttemptCheckpoint
): void => {
  const canonicalBindings: readonly [CanonicalIdentity, CanonicalIdentity, string][] = [
    [replay.replayIdentity, checkpoint.replayIdentity, "replay"],
    [replay.resultIdentity, checkpoint.resultIdentity, "result"],
    [replay.result.requestIdentity, checkpoint.requestIdentity, "request"],
    [replay.result.promptPackIdentity, checkpoint.promptPackIdentity, "prompt pack"],
    [replay.result.structuredProposalIdentity, checkpoint.structuredProposalIdentity, "structured proposal"],
    [replay.result.untrustedNarrativeIdentity, checkpoint.untrustedNarrativeIdentity, "untrusted narrative"],
    [replay.result.trustManifestIdentity, checkpoint.trustManifestIdentity, "trust manifest"],
    [replay.result.practiceCatalogIdentity, checkpoint.practiceCatalogIdentity, "practice catalog"],
    [replay.result.providerIdentity, checkpoint.providerIdentity, "provider"],
    [replay.result.modelIdentity, checkpoint.modelIdentity, "model"],
    [replay.result.settingsIdentity, checkpoint.settingsIdentity, "settings"],
    [replay.result.referenceIndexIdentity, checkpoint.referenceIndexIdentity, "reference index"],
    [replay.result.outputContractIdentity, checkpoint.outputContractIdentity, "output contract"],
    [replay.result.regenerationPolicyIdentity, checkpoint.regenerationPolicyIdentity, "regeneration policy"],
    [replay.validatorHandoffIdentity, checkpoint.validatorHandoffIdentity, "validator handoff"]
  ];
  for (const [actual, expected, relation] of canonicalBindings) {
    requireCanonicalIdentity(
      actual,
      expected,
      "AGENT_WORKFLOW_CHECKPOINT_REPLAY_MISMATCH",
      `Archived replay does not match checkpoint ${relation}`
    );
  }
  for (const [actual, expected, relation] of [
    [replay.result.rawOutputIdentity, checkpoint.rawOutputIdentity, "raw output"],
    [replay.result.instructionIdentity, checkpoint.instructionIdentity, "instruction"],
    [replay.result.outputContractBytesIdentity, checkpoint.outputContractBytesIdentity, "output-contract bytes"]
  ] as const) {
    requireContentIdentity(
      actual,
      expected,
      "AGENT_WORKFLOW_CHECKPOINT_REPLAY_MISMATCH",
      `Archived replay does not match checkpoint ${relation}`
    );
  }
};

const validateResultAgainstRunBinding = (
  result: DesignAgentProposalResult,
  runBinding: DesignAgentProposalRequiredRunBinding,
  subject: DesignAgentStageSubject
): void => {
  if (
    result.stage !== subject.stage ||
    canonicalJson(result.trustAnchors) !== canonicalJson(runBinding.trustAnchors)
  ) {
    reject(
      "POLICY_DENIED",
      "AGENT_WORKFLOW_RESULT_BINDING_DRIFT",
      "Coordinator result stage or trust anchors differ from the immutable workflow binding"
    );
  }
  for (const [actual, expected, relation] of [
    [result.trustManifestIdentity, runBinding.trustManifestIdentity, "trust manifest"],
    [result.practiceCatalogIdentity, runBinding.practiceCatalogIdentity, "practice catalog"],
    [result.providerIdentity, runBinding.providerIdentity, "provider"],
    [result.modelIdentity, runBinding.modelIdentity, "model"],
    [result.settingsIdentity, runBinding.settingsIdentity, "settings"],
    [result.outputContractIdentity, runBinding.outputContractIdentity, "output contract"],
    [result.regenerationPolicyIdentity, runBinding.regenerationPolicyIdentity, "regeneration policy"]
  ] as const) {
    requireCanonicalIdentity(
      actual,
      expected,
      "AGENT_WORKFLOW_RESULT_BINDING_DRIFT",
      `Coordinator result ${relation} differs from the immutable run binding`
    );
  }
  for (const [actual, expected, relation] of [
    [result.instructionIdentity, runBinding.instructionIdentity, "instruction"],
    [result.outputContractBytesIdentity, runBinding.outputContractBytesIdentity, "output-contract bytes"]
  ] as const) {
    requireContentIdentity(
      actual,
      expected,
      "AGENT_WORKFLOW_RESULT_BINDING_DRIFT",
      `Coordinator result ${relation} differs from the immutable run binding`
    );
  }
};

const planDeterministicValidators = (
  registry: InspectedValidatorRegistry,
  result: DesignAgentProposalResult
): DesignAgentDeterministicValidatorPlan => {
  if (
    canonicalJson(result.structuredProposal.validatorRequests) !==
    canonicalJson(result.validatorHandoff.requestedValidators)
  ) {
    reject(
      "DIGEST_MISMATCH",
      "AGENT_WORKFLOW_VALIDATOR_HANDOFF_MISMATCH",
      "Proposal validator requests differ from the coordinator handoff"
    );
  }
  const requestedValidatorIds = result.structuredProposal.validatorRequests.map(
    (request) => request.validatorId
  );
  let planValue: unknown;
  try {
    planValue = registry.plan({
      stage: result.stage,
      role: result.role,
      requestedValidatorIds
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_WORKFLOW_VALIDATOR_PLANNING_FAILED",
      "Host-owned validator registry failed without a contract-bound plan"
    );
  }
  const snapshot = snapshotPlainJson(
    planValue,
    JSON_LIMITS,
    "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
    "validatorPlan"
  );
  const plan = exactRecord(
    snapshot,
    [
      "authority",
      "identity",
      "mandatoryValidatorIds",
      "registryIdentity",
      "requestedValidatorIds",
      "role",
      "schemaVersion",
      "stage",
      "validatorIds",
      "validators"
    ],
    "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
    "validatorPlan"
  );
  if (
    plan.schemaVersion !== DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA ||
    plan.authority !== "host_owned_workflow_policy" ||
    plan.stage !== result.stage ||
    plan.role !== result.role
  ) {
    reject(
      "DIGEST_MISMATCH",
      "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
      "Validator plan schema, authority, stage, or role is invalid"
    );
  }
  const identity = requireRecordIdentity(
    plan,
    DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA,
    "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
    "validatorPlan"
  );
  requireCanonicalIdentity(
    snapshotCanonicalIdentity(
      plan.registryIdentity,
      "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
      "validatorPlan.registryIdentity",
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
    ),
    registry.identity,
    "AGENT_WORKFLOW_VALIDATOR_REGISTRY_DRIFT",
    "Validator plan was produced by a different registry"
  );
  const requested = [...new Set(requestedValidatorIds)].sort(compareText);
  const coverage = registry.snapshot.mandatoryCoverage.find(
    (candidate) => candidate.stage === result.stage && candidate.role === result.role
  );
  if (coverage === undefined) {
    reject(
      "POLICY_DENIED",
      "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
      "Pinned validator-registry snapshot has no mandatory coverage for this stage and role"
    );
  }
  const mandatory = [...coverage.validatorIds];
  const validatorIds = [...new Set([...mandatory, ...requested])].sort(compareText);
  const descriptorById = new Map(
    registry.snapshot.validators.map((descriptor) => [descriptor.validatorId, descriptor])
  );
  const outdated = new Set<string>(registry.snapshot.outdatedValidatorIds);
  for (const validatorId of requested) {
    if (outdated.has(validatorId)) {
      reject(
        "POLICY_DENIED",
        "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED",
        "Known outdated validator IDs are rejected and are never aliased",
        { validatorId }
      );
    }
  }
  const mandatorySet = new Set(mandatory);
  const requestedSet = new Set(requested);
  const validators = validatorIds.map((validatorId) => {
    const descriptor = descriptorById.get(validatorId);
    if (
      descriptor === undefined ||
      !descriptor.applicability.some(
        (candidate) => candidate.stage === result.stage && candidate.role === result.role
      )
    ) {
      reject(
        "POLICY_DENIED",
        "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
        "Pinned validator-registry snapshot cannot resolve an applicable planned validator",
        { validatorId, stage: result.stage, role: result.role }
      );
    }
    const mandatorySelection = mandatorySet.has(validatorId);
    const requestedSelection = requestedSet.has(validatorId);
    return {
      validatorId,
      descriptorIdentity: descriptor.identity,
      selection: mandatorySelection && requestedSelection
        ? "host_mandatory_and_model_requested" as const
        : mandatorySelection
          ? "host_mandatory" as const
          : "model_requested" as const
    };
  });
  const expectedPayload = {
    schemaVersion: DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA,
    stage: result.stage,
    role: result.role,
    authority: "host_owned_workflow_policy" as const,
    requestedValidatorIds: requested,
    mandatoryValidatorIds: mandatory,
    validatorIds,
    validators,
    registryIdentity: registry.identity
  };
  const expectedPlan: DesignAgentDeterministicValidatorPlan = {
    ...expectedPayload,
    identity: canonicalIdentity(
      expectedPayload,
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA
    )
  };
  if (canonicalJson({ ...plan, identity }) !== canonicalJson(expectedPlan)) {
    reject(
      "DIGEST_MISMATCH",
      "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID",
      "Validator registry plan does not exactly reproduce from its pinned snapshot"
    );
  }
  return deepFreezeProductionValue(expectedPlan);
};

const validateCheckpointAgainstRunBinding = (
  checkpoint: DesignAgentAttemptCheckpoint,
  runBinding: DesignAgentProposalRequiredRunBinding
): void => {
  requireCanonicalIdentity(
    checkpoint.runBinding.identity,
    runBinding.identity,
    "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH",
    "Checkpoint embeds a different run binding"
  );
  for (const [actual, expected, relation] of [
    [checkpoint.trustManifestIdentity, runBinding.trustManifestIdentity, "trust manifest"],
    [checkpoint.practiceCatalogIdentity, runBinding.practiceCatalogIdentity, "practice catalog"],
    [checkpoint.providerIdentity, runBinding.providerIdentity, "provider"],
    [checkpoint.modelIdentity, runBinding.modelIdentity, "model"],
    [checkpoint.modelPolicyIdentity, runBinding.modelPolicyIdentity, "model policy"],
    [checkpoint.validatorRegistryIdentity, runBinding.validatorRegistryIdentity, "validator registry"],
    [checkpoint.settingsIdentity, runBinding.settingsIdentity, "settings"],
    [checkpoint.outputContractIdentity, runBinding.outputContractIdentity, "output contract"],
    [checkpoint.regenerationPolicyIdentity, runBinding.regenerationPolicyIdentity, "regeneration policy"]
  ] as const) {
    requireCanonicalIdentity(
      actual,
      expected,
      "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH",
      `Checkpoint ${relation} differs from the immutable run binding`
    );
  }
  for (const [actual, expected, relation] of [
    [checkpoint.instructionIdentity, runBinding.instructionIdentity, "instruction"],
    [checkpoint.providerExecutableIdentity, runBinding.providerExecutableIdentity, "provider executable"],
    [checkpoint.outputContractBytesIdentity, runBinding.outputContractBytesIdentity, "output-contract bytes"]
  ] as const) {
    requireContentIdentity(
      actual,
      expected,
      "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH",
      `Checkpoint ${relation} differs from the immutable run binding`
    );
  }
};

const replayBytes = (replay: FrozenDesignAgentReplay): Buffer =>
  Buffer.from(`${canonicalJson(replay)}\n`, "utf8");

const snapshotArchiveBytes = (value: unknown, failureCode: string, label: string): Buffer => {
  if (typeof value === "string") {
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength > DESIGN_AGENT_LIMITS.replayStringBytes) {
      reject("ARTIFACT_INTEGRITY_ERROR", failureCode, `${label} exceeds its byte limit`);
    }
    return Buffer.from(value, "utf8");
  }
  if (
    nodeTypes.isProxy(value) ||
    !nodeTypes.isUint8Array(value) ||
    typedArrayBufferGetter === undefined ||
    typedArrayByteLengthGetter === undefined
  ) {
    reject("ARTIFACT_INTEGRITY_ERROR", failureCode, `${label} did not return immutable bytes`);
  }
  let backing: ArrayBufferLike;
  let byteLength: number;
  try {
    backing = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBufferLike;
    byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
  } catch {
    reject("ARTIFACT_INTEGRITY_ERROR", failureCode, `${label} returned invalid typed-array bytes`);
  }
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    backing instanceof SharedArrayBuffer
  ) {
    reject("ARTIFACT_INTEGRITY_ERROR", failureCode, `${label} cannot use shared backing memory`);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > DESIGN_AGENT_LIMITS.replayStringBytes) {
    reject("ARTIFACT_INTEGRITY_ERROR", failureCode, `${label} exceeds its byte limit`);
  }
  const copy = Buffer.alloc(byteLength);
  try {
    Reflect.apply(typedArraySet, copy, [value, 0]);
  } catch {
    reject("ARTIFACT_INTEGRITY_ERROR", failureCode, `${label} changed while its bytes were copied`);
  }
  return copy;
};

const parseCanonicalReplayBytes = (
  bytes: Buffer,
  expectedBlob: ContentIdentity
): ValidatedReplay => {
  requireContentIdentity(
    contentIdentity(bytes),
    expectedBlob,
    "AGENT_WORKFLOW_REPLAY_BLOB_MISMATCH",
    "Replay archive returned bytes that do not match the checkpoint blob"
  );
  if (bytes.length > DESIGN_AGENT_LIMITS.replayStringBytes) {
    reject("ARTIFACT_INTEGRITY_ERROR", "AGENT_WORKFLOW_REPLAY_BLOB_INVALID", "Archived replay exceeds its fixed byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    reject("ARTIFACT_INTEGRITY_ERROR", "AGENT_WORKFLOW_REPLAY_BLOB_INVALID", "Archived replay is not JSON");
  }
  const snapshot = snapshotPlainJson(
    parsed,
    JSON_LIMITS,
    "AGENT_WORKFLOW_REPLAY_BLOB_INVALID",
    "archivedReplay"
  );
  const expectedBytes = Buffer.from(`${canonicalJson(snapshot)}\n`, "utf8");
  if (!bytes.equals(expectedBytes)) {
    reject("ARTIFACT_INTEGRITY_ERROR", "AGENT_WORKFLOW_REPLAY_BLOB_NOT_CANONICAL", "Archived replay bytes are not the exact canonical encoding");
  }
  return validateReplay(snapshot, "archivedReplay");
};

const checkpointInput = (
  capture: DesignAgentAttemptCheckpoint["capture"],
  request: SnapshotProposalRequest,
  replay: ValidatedReplay,
  validatorPlan: DesignAgentDeterministicValidatorPlan,
  replayBlob: ContentIdentity,
  receiptId: string,
  receiptIdentity: CanonicalIdentity
) => ({
  capture,
  subject: request.subject,
  runBinding: request.runBinding,
  requestIdentity: replay.result.requestIdentity,
  promptPackIdentity: replay.result.promptPackIdentity,
  resultIdentity: replay.resultIdentity,
  structuredProposalIdentity: replay.result.structuredProposalIdentity,
  untrustedNarrativeIdentity: replay.result.untrustedNarrativeIdentity,
  rawOutputIdentity: replay.result.rawOutputIdentity,
  trustManifestIdentity: replay.result.trustManifestIdentity,
  instructionIdentity: replay.result.instructionIdentity,
  practiceCatalogIdentity: replay.result.practiceCatalogIdentity,
  providerIdentity: replay.result.providerIdentity,
  providerExecutableIdentity: request.runBinding.providerExecutableIdentity,
  modelIdentity: replay.result.modelIdentity,
  modelPolicyIdentity: request.runBinding.modelPolicyIdentity,
  validatorRegistryIdentity: request.runBinding.validatorRegistryIdentity,
  validatorPlanIdentity: validatorPlan.identity,
  settingsIdentity: replay.result.settingsIdentity,
  referenceIndexIdentity: replay.result.referenceIndexIdentity,
  outputContractIdentity: replay.result.outputContractIdentity,
  outputContractBytesIdentity: replay.result.outputContractBytesIdentity,
  replayIdentity: replay.replayIdentity,
  replayBlob,
  receiptId,
  receiptIdentity,
  validatorHandoffIdentity: replay.validatorHandoffIdentity,
  regenerationPolicyIdentity: replay.result.regenerationPolicyIdentity
});

/**
 * Isolated capture/replay policy. Dependencies are intentionally retained as opaque values and are
 * not inspected until a proposal-required call has been snapshotted. Thus off mode remains usable
 * in production compositions with no live provider or replay archive configured.
 */
export class DesignAgentWorkflowOrchestrator {
  readonly #coordinatorValue: unknown;
  readonly #replayArchiveValue: unknown;
  readonly #validatorRegistryValue: unknown;

  public constructor(
    coordinator: DesignAgentWorkflowCoordinatorPort | null = null,
    replayArchive: DesignAgentReplayArchivePort | null = null,
    validatorRegistry: DesignAgentWorkflowValidatorRegistryPort | null = null
  ) {
    this.#coordinatorValue = coordinator;
    this.#replayArchiveValue = replayArchive;
    this.#validatorRegistryValue = validatorRegistry;
    Object.freeze(this);
  }

  public async run(
    requestValue: DesignAgentWorkflowRequest,
    signal?: AbortSignal
  ): Promise<DesignAgentWorkflowResult> {
    const request = snapshotRequest(requestValue);
    if ("mode" in request) return OFF_RESULT;

    if (
      this.#coordinatorValue === null ||
      this.#replayArchiveValue === null ||
      this.#validatorRegistryValue === null
    ) {
      reject(
        "CAPABILITY_REQUIRED",
        "AGENT_WORKFLOW_CAPABILITY_REQUIRED",
        "Proposal-required mode needs a configured coordinator, replay archive, and validator registry"
      );
    }
    const validatorRegistry = inspectValidatorRegistry(
      this.#validatorRegistryValue,
      request.runBinding
    );
    const coordinator = inspectCoordinator(this.#coordinatorValue, request.runBinding);
    const archive = inspectReplayArchive(this.#replayArchiveValue);

    if (request.intent === "resume" && request.priorCheckpoint !== null) {
      return await this.#replay(
        request,
        request.priorCheckpoint,
        coordinator,
        archive,
        validatorRegistry
      );
    }
    return await this.#captureLive(request, coordinator, archive, validatorRegistry, signal);
  }

  async #captureLive(
    request: SnapshotProposalRequest,
    coordinator: InspectedCoordinator,
    archive: InspectedReplayArchive,
    validatorRegistry: InspectedValidatorRegistry,
    signal?: AbortSignal
  ): Promise<DesignAgentWorkflowProposalResult> {
    let executionValue: unknown;
    try {
      executionValue = await coordinator.execute(request.input, signal);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_WORKFLOW_COORDINATOR_EXECUTION_FAILED",
        "Design-agent coordinator failed without a contract-bound live result"
      );
    }
    const execution = validateLiveExecution(executionValue);
    validateResultAgainstRunBinding(execution.result, request.runBinding, request.subject);
    const validatorPlan = planDeterministicValidators(validatorRegistry, execution.result);
    const bytes = replayBytes(execution.replay);
    const expectedBlob = deepFreezeProductionValue(contentIdentity(bytes));
    const checkpoint = createDesignAgentAttemptCheckpoint(
      checkpointInput(
        {
          acquisitionMode: "live_traceable",
          capturedAttemptId: request.attemptId
        },
        request,
        execution,
        validatorPlan,
        expectedBlob,
        execution.receiptId,
        execution.receiptIdentity
      )
    );

    let storedValue: unknown;
    try {
      storedValue = await archive.put(Buffer.from(bytes), expectedBlob);
    } catch {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_WORKFLOW_REPLAY_ARCHIVE_WRITE_FAILED",
        "Full replay archive failed before the capture checkpoint could be returned"
      );
    }
    const stored = snapshotContentIdentity(
      storedValue,
      "AGENT_WORKFLOW_REPLAY_ARCHIVE_WRITE_MISMATCH",
      "replayArchive.put result"
    );
    requireContentIdentity(
      stored,
      expectedBlob,
      "AGENT_WORKFLOW_REPLAY_ARCHIVE_WRITE_MISMATCH",
      "Replay archive returned an identity for different bytes"
    );
    await this.#verifyArchiveReadback(archive, stored, bytes);

    return deepFreezeProductionValue({
      mode: "proposal_required" as const,
      acquisition: "live_traceable" as const,
      result: execution.result,
      validatorPlan,
      checkpoint
    });
  }

  async #verifyArchiveReadback(
    archive: InspectedReplayArchive,
    identity: ContentIdentity,
    expectedBytes: Buffer
  ): Promise<void> {
    let value: unknown;
    try {
      value = await archive.get(identity);
    } catch {
      reject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_WORKFLOW_REPLAY_ARCHIVE_READBACK_FAILED",
        "Replay archive could not read back a newly stored full replay"
      );
    }
    if (value === undefined || value === null) {
      reject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_WORKFLOW_REPLAY_ARCHIVE_READBACK_FAILED",
        "Replay archive did not retain a newly stored full replay"
      );
    }
    const readback = snapshotArchiveBytes(
      value,
      "AGENT_WORKFLOW_REPLAY_ARCHIVE_READBACK_FAILED",
      "replayArchive readback"
    );
    if (!readback.equals(expectedBytes)) {
      reject(
        "ARTIFACT_INTEGRITY_ERROR",
        "AGENT_WORKFLOW_REPLAY_ARCHIVE_READBACK_MISMATCH",
        "Replay archive readback differs from the captured canonical replay"
      );
    }
  }

  async #replay(
    request: SnapshotProposalRequest,
    prior: DesignAgentAttemptCheckpoint,
    coordinator: InspectedCoordinator,
    archive: InspectedReplayArchive,
    validatorRegistry: InspectedValidatorRegistry
  ): Promise<DesignAgentWorkflowProposalResult> {
    validateCheckpointAgainstRunBinding(prior, request.runBinding);
    let archiveValue: unknown;
    try {
      archiveValue = await archive.get(prior.replayBlob);
    } catch (error) {
      if (error instanceof DomainError && error.code === "NOT_FOUND") {
        reject(
          "DIGEST_MISMATCH",
          "AGENT_WORKFLOW_REPLAY_BLOB_NOT_FOUND",
          "Checkpoint-bound full replay is missing from the internal archive"
        );
      }
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_WORKFLOW_REPLAY_ARCHIVE_READ_FAILED",
        "Full replay archive failed while resolving a checkpoint"
      );
    }
    if (archiveValue === undefined || archiveValue === null) {
      reject(
        "DIGEST_MISMATCH",
        "AGENT_WORKFLOW_REPLAY_BLOB_NOT_FOUND",
        "Checkpoint-bound full replay is missing from the internal archive"
      );
    }
    const archived = parseCanonicalReplayBytes(
      snapshotArchiveBytes(
        archiveValue,
        "AGENT_WORKFLOW_REPLAY_BLOB_INVALID",
        "replayArchive.get result"
      ),
      prior.replayBlob
    );
    validateCheckpointReplay(archived, prior);

    let executionValue: unknown;
    try {
      executionValue = await coordinator.replay(archived.replay, {
        receiptId: prior.receiptId,
        input: request.input
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_WORKFLOW_COORDINATOR_REPLAY_FAILED",
        "Coordinator failed to authenticate the checkpoint-bound replay"
      );
    }
    const executionSnapshot = snapshotPlainJson(
      executionValue,
      JSON_LIMITS,
      "AGENT_WORKFLOW_REPLAY_EXECUTION_INVALID",
      "replayExecution"
    );
    const execution = exactRecord(
      executionSnapshot,
      ["mode", "receiptId", "receiptIdentity", "replayIdentity", "result"],
      "AGENT_WORKFLOW_REPLAY_EXECUTION_INVALID",
      "replayExecution"
    );
    if (execution.mode !== "frozen_exact_replay" || execution.receiptId !== prior.receiptId) {
      reject("DIGEST_MISMATCH", "AGENT_WORKFLOW_REPLAY_EXECUTION_INVALID", "Coordinator returned a different replay mode or receipt");
    }
    requireCanonicalIdentity(
      snapshotCanonicalIdentity(execution.replayIdentity, FAILURE, "replayExecution.replayIdentity", DESIGN_AGENT_REPLAY_SCHEMA),
      prior.replayIdentity,
      "AGENT_WORKFLOW_REPLAY_EXECUTION_INVALID",
      "Coordinator replay identity differs from the checkpoint"
    );
    requireCanonicalIdentity(
      snapshotCanonicalIdentity(execution.receiptIdentity, FAILURE, "replayExecution.receiptIdentity", DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA),
      prior.receiptIdentity,
      "AGENT_WORKFLOW_REPLAY_EXECUTION_INVALID",
      "Coordinator resolved a different compact replay receipt"
    );
    if (canonicalJson(execution.result) !== canonicalJson(archived.result)) {
      reject("DIGEST_MISMATCH", "AGENT_WORKFLOW_REPLAY_EXECUTION_INVALID", "Coordinator replay result does not reconstruct exactly");
    }
    const validatorPlan = planDeterministicValidators(validatorRegistry, archived.result);
    requireCanonicalIdentity(
      validatorPlan.identity,
      prior.validatorPlanIdentity,
      "AGENT_WORKFLOW_VALIDATOR_PLAN_DRIFT",
      "Recomputed validator plan differs from the checkpoint"
    );

    const checkpoint = createDesignAgentAttemptCheckpoint(
      checkpointInput(
        {
          acquisitionMode: "frozen_exact_replay",
          capturedAttemptId: prior.capture.capturedAttemptId,
          replayingAttemptId: request.attemptId
        },
        request,
        archived,
        validatorPlan,
        prior.replayBlob,
        prior.receiptId,
        prior.receiptIdentity
      )
    );
    return deepFreezeProductionValue({
      mode: "proposal_required" as const,
      acquisition: "frozen_exact_replay" as const,
      result: archived.result,
      validatorPlan,
      checkpoint
    });
  }
}

import { types as nodeTypes } from "node:util";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { approvalRecordSchema, requirementsDocumentSchema } from "../contracts/results.js";
import { DomainError } from "../domain/errors.js";
import { STAGE_ORDER, stageIndex, type StageKey } from "../domain/stages.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  ApprovalRecord,
  RequirementsDocument
} from "../domain/types.js";
import {
  PCB_ENGINEERING_PRACTICE_SCHEMA,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
  type PcbEngineeringPracticeCatalog
} from "../knowledge/pcb-engineering-practices.js";
import {
  CURRENT_SCHEMATIC_INTENT_SCHEMA,
  validateAndSnapshotReferenceSchematicIntentV2Shape
} from "../knowledge/reference-schematic-intent.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../knowledge/reference-controller-native-contract.js";
import {
  CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
  REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES,
  validateAndSnapshotReferenceSystemArchitectureV2Shape
} from "../knowledge/reference-system-architecture.js";
import type { StageExecutionResult } from "../workflow/contracts.js";
import {
  DESIGN_AGENT_CATALOG_LOGICAL_NAME,
  DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
  DESIGN_AGENT_LIMITS,
  type BoundAgentStructuredDocument,
  type BoundAgentTextDocument,
  type BoundDesignAgentModel,
  type BoundDesignAgentSettings,
  type DesignAgentRunInput,
  type DesignAgentTrustAnchors,
  type JsonValue
} from "./contracts.js";
import {
  bindAgentStructuredDocument,
  bindAgentTextDocument,
  bindDesignAgentModel,
  bindDesignAgentReferenceIndex,
  bindDesignAgentSettings
} from "./coordinator.js";
import {
  DESIGN_AGENT_RESERVED_ARTIFACT_PREFIX,
  DESIGN_AGENT_STAGE_SUBJECT_SCHEMA,
  bindDesignAgentRunBinding,
  bindDesignAgentStageSubject,
  isReservedDesignAgentArtifactLogicalName,
  type DesignAgentProposalRequiredRunBinding,
  type DesignAgentStageSubject
} from "./workflow-contracts.js";
import { roleForStage } from "./roles.js";

export const DESIGN_AGENT_WORKFLOW_SUBJECT_LOGICAL_NAME =
  "workflow/design-agent-subject.json" as const;
export const DESIGN_AGENT_REQUIREMENTS_LOGICAL_NAME = "workflow/requirements.json" as const;
export const DESIGN_AGENT_SOURCE_PROMPT_LOGICAL_NAME = "workflow/source-prompt.txt" as const;
export const DESIGN_AGENT_CONTEXT_INVENTORY_LOGICAL_NAME =
  "workflow/context-inventory.json" as const;
export const DESIGN_AGENT_CONTEXT_INVENTORY_SCHEMA =
  "evleda.design-agent-context-inventory.v1" as const;
export const DESIGN_AGENT_UPSTREAM_BINDING_SCHEMA =
  "evleda.design-agent-upstream-binding.v1" as const;
export const DESIGN_AGENT_FILTERED_UPSTREAM_SCHEMA =
  "evleda.design-agent-filtered-upstream.v1" as const;
export {
  DESIGN_AGENT_RESERVED_ARTIFACT_PREFIX,
  isReservedDesignAgentArtifactLogicalName
} from "./workflow-contracts.js";
export const DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS = Object.freeze({
  inputGraphNodes: Math.min(DESIGN_AGENT_LIMITS.inputGraphNodes, 50_000),
  retainedArtifactBytes: 16 * 1024 * 1024,
  retainedAggregateArtifactBytes: 64 * 1024 * 1024
} as const);

const REQUIREMENTS_SCHEMA = "evleda.requirements.v1" as const;
const MAX_REFERENCE_IDS = 4_096;
const EVIDENCE_CLASSES = new Set([
  "agent_claim",
  "evleda_check",
  "kicad_native",
  "human_physical"
]);

export class DesignAgentWorkflowContextError extends DomainError {
  public constructor(
    public readonly failureCode: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super("INVALID_ARGUMENT", message, { failureCode, ...details }, false);
    this.name = "DesignAgentWorkflowContextError";
  }
}

const reject = (
  failureCode: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never => {
  throw new DesignAgentWorkflowContextError(failureCode, message, details);
};

const deepFreeze = <Value>(value: Value, seen = new Set<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  // Typed-array elements cannot be frozen. They are safe here only when freshly copied.
  if (nodeTypes.isUint8Array(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  failureCode: string,
  message: string
): Record<string, unknown> => {
  if (!isRecord(value)) reject(failureCode, message);
  return value as Record<string, unknown>;
};

const requireDataDescriptor = (
  object: object,
  key: PropertyKey,
  failureCode: string,
  message: string
): PropertyDescriptor & { readonly value: unknown } => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !("value" in descriptor)) reject(failureCode, message);
  return descriptor as PropertyDescriptor & { readonly value: unknown };
};

const readEnumerableData = (
  object: Record<string, unknown>,
  key: string,
  label: string
): unknown => {
  const descriptor = requireDataDescriptor(
    object,
    key,
    "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN",
    `${label}.${key} must be a data property`
  );
  if (!descriptor.enumerable) {
    reject(
      "AGENT_CONTEXT_INPUT_NON_ENUMERABLE_FORBIDDEN",
      `${label}.${key} must be enumerable`
    );
  }
  return descriptor.value;
};

const safeArrayLength = (value: readonly unknown[], label: string): number => {
  const descriptor = requireDataDescriptor(
    value,
    "length",
    "AGENT_CONTEXT_INPUT_ARRAY_INVALID",
    `${label}.length must be a data property`
  );
  if (!Number.isSafeInteger(descriptor.value) || (descriptor.value as number) < 0) {
    reject("AGENT_CONTEXT_INPUT_ARRAY_INVALID", `${label} has an invalid length`);
  }
  return descriptor.value as number;
};

const safeArrayEntry = (
  value: readonly unknown[],
  index: number,
  label: string
): unknown => {
  const descriptor = requireDataDescriptor(
    value,
    String(index),
    "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN",
    `${label}[${index}] must be a data property`
  );
  if (!descriptor.enumerable) {
    reject(
      "AGENT_CONTEXT_INPUT_NON_ENUMERABLE_FORBIDDEN",
      `${label}[${index}] must be enumerable`
    );
  }
  return descriptor.value;
};

const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void => {
  const allowed = new Set([...required, ...optional]);
  const unknown: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      reject(
        "AGENT_CONTEXT_INPUT_INHERITED_ENUMERABLE_FORBIDDEN",
        `${label} inherits an enumerable property`,
        { label, key }
      );
    }
    if (!allowed.has(key) && unknown.length < 16) unknown.push(key);
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0 || unknown.length > 0) {
    reject("AGENT_CONTEXT_INPUT_UNKNOWN_FIELD", `${label} contains missing or unknown fields`, {
      label,
      missing,
      unknown,
      allowed: [...allowed].sort()
    });
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      reject(
        "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN",
        `${label}.${key} must be an enumerable data property`,
        { label, key }
      );
    }
  }
};

interface GraphState {
  nodes: number;
  stringBytes: number;
  readonly active: Set<object>;
}

const SAFE_UINT8_ARRAY = Uint8Array;
const SAFE_UINT8_ARRAY_PROTOTYPE = SAFE_UINT8_ARRAY.prototype;
const SAFE_BUFFER_PROTOTYPE = Buffer.prototype;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(SAFE_UINT8_ARRAY_PROTOTYPE) as object;
const TYPED_ARRAY_SET = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "set"
)!.value as (source: ArrayLike<number>, offset?: number) => void;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer"
)!.get!;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset"
)!.get!;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength"
)!.get!;

const byteArrayParts = (
  value: Uint8Array
): { readonly buffer: ArrayBuffer; readonly byteOffset: number; readonly byteLength: number } => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== SAFE_UINT8_ARRAY_PROTOTYPE && prototype !== SAFE_BUFFER_PROTOTYPE) {
    reject("AGENT_CONTEXT_ARTIFACT_BYTES_INVALID", "Artifact bytes must not use a typed-array subclass");
  }
  try {
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBufferLike;
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []) as number;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    if (!nodeTypes.isArrayBuffer(buffer)) {
      reject(
        "AGENT_CONTEXT_ARTIFACT_BYTES_INVALID",
        "Shared or non-ArrayBuffer artifact storage is forbidden"
      );
    }
    return { buffer: buffer as ArrayBuffer, byteOffset, byteLength };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return reject(
      "AGENT_CONTEXT_ARTIFACT_BYTES_INVALID",
      "Artifact byte storage is detached or invalid"
    );
  }
};

const copyByteArray = (value: Uint8Array): Uint8Array => {
  try {
    const { buffer, byteOffset, byteLength } = byteArrayParts(value);
    const copy = new SAFE_UINT8_ARRAY(byteLength);
    Reflect.apply(TYPED_ARRAY_SET, copy, [
      new SAFE_UINT8_ARRAY(buffer, byteOffset, byteLength)
    ]);
    return copy;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    return reject(
      "AGENT_CONTEXT_ARTIFACT_BYTES_INVALID",
      "Artifact byte storage changed or detached during capture"
    );
  }
};

const accountString = (value: string, state: GraphState): void => {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > DESIGN_AGENT_LIMITS.inputStringBytes) {
    reject("AGENT_CONTEXT_INPUT_STRING_LIMIT_EXCEEDED", "A workflow-context string is too large");
  }
  state.stringBytes += bytes;
  if (state.stringBytes > DESIGN_AGENT_LIMITS.inputStringBytes) {
    reject(
      "AGENT_CONTEXT_INPUT_AGGREGATE_BYTE_LIMIT_EXCEEDED",
      "Workflow-context aggregate string bytes exceed the input limit"
    );
  }
};

/**
 * Inspect the complete caller graph before reading semantic fields. Binary artifact bodies are
 * leaves: they are copied only after an exact allowlist match and an early byte-limit check.
 */
const assertStaticInputGraph = (
  value: unknown,
  depth = 0,
  state: GraphState = { nodes: 0, stringBytes: 0, active: new Set<object>() }
): void => {
  if (depth > DESIGN_AGENT_LIMITS.inputGraphDepth) {
    reject("AGENT_CONTEXT_INPUT_DEPTH_EXCEEDED", "Workflow-context input exceeds its depth limit");
  }
  state.nodes += 1;
  if (state.nodes > DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.inputGraphNodes) {
    reject("AGENT_CONTEXT_INPUT_NODE_LIMIT_EXCEEDED", "Workflow-context input exceeds its node limit");
  }

  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    accountString(value, state);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      reject("AGENT_CONTEXT_INPUT_NON_JSON_VALUE", "Workflow-context numbers must be finite");
    }
    return;
  }
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (nodeTypes.isProxy(value)) {
      reject("AGENT_CONTEXT_INPUT_PROXY_FORBIDDEN", "Proxy values are forbidden in workflow context");
    }
  }
  if (typeof value !== "object" || value === null) {
    reject(
      "AGENT_CONTEXT_INPUT_NON_JSON_VALUE",
      "Functions, symbols, bigint values, and undefined are forbidden in workflow context"
    );
  }
  if (nodeTypes.isUint8Array(value)) {
    byteArrayParts(value);
    return;
  }

  const object = value as object;
  if (state.active.has(object)) {
    reject("AGENT_CONTEXT_INPUT_CYCLE_FORBIDDEN", "Cycles are forbidden in workflow context");
  }
  state.active.add(object);
  try {
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      reject(
        "AGENT_CONTEXT_INPUT_PLAIN_DATA_REQUIRED",
        "Workflow context accepts only plain objects, arrays, primitives, and artifact bytes"
      );
    }
    if (array) {
      const lengthDescriptor = requireDataDescriptor(
        object,
        "length",
        "AGENT_CONTEXT_INPUT_ARRAY_INVALID",
        "Array length must be a data property"
      );
      const length = lengthDescriptor.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.inputGraphNodes
      ) {
        reject("AGENT_CONTEXT_INPUT_NODE_LIMIT_EXCEEDED", "Workflow-context array is too large");
      }
      let indices = 0;
      for (const key in object as unknown as readonly unknown[]) {
        if (!Object.hasOwn(object, key)) {
          reject(
            "AGENT_CONTEXT_INPUT_INHERITED_ENUMERABLE_FORBIDDEN",
            "Workflow-context arrays cannot inherit enumerable properties",
            { key }
          );
        }
        accountString(key, state);
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
          reject("AGENT_CONTEXT_INPUT_ARRAY_INVALID", "Arrays cannot contain holes or custom properties");
        }
        const descriptor = requireDataDescriptor(
          object,
          key,
          "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN",
          "Accessors are forbidden in workflow context"
        );
        if (!descriptor.enumerable) {
          reject(
            "AGENT_CONTEXT_INPUT_NON_ENUMERABLE_FORBIDDEN",
            "Non-enumerable data properties are forbidden in workflow context"
          );
        }
        assertStaticInputGraph(descriptor.value, depth + 1, state);
        indices += 1;
      }
      if (indices !== length) {
        reject("AGENT_CONTEXT_INPUT_ARRAY_INVALID", "Sparse arrays are forbidden in workflow context");
      }
      return;
    }

    for (const key in object as Record<string, unknown>) {
      if (!Object.hasOwn(object, key)) {
        reject(
          "AGENT_CONTEXT_INPUT_INHERITED_ENUMERABLE_FORBIDDEN",
          "Workflow-context objects cannot inherit enumerable properties",
          { key }
        );
      }
      accountString(key, state);
      const descriptor = requireDataDescriptor(
        object,
        key,
        "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN",
        "Accessors are forbidden in workflow context"
      );
      if (!descriptor.enumerable) {
        reject(
          "AGENT_CONTEXT_INPUT_NON_ENUMERABLE_FORBIDDEN",
          "Non-enumerable data properties are forbidden in workflow context"
        );
      }
      assertStaticInputGraph(descriptor.value, depth + 1, state);
    }
  } finally {
    state.active.delete(object);
  }
};

const snapshotEnumerableGraph = (
  value: unknown,
  label: string,
  allowBinary: boolean,
  depth = 0,
  state: GraphState = { nodes: 0, stringBytes: 0, active: new Set<object>() }
): unknown => {
  if (depth > DESIGN_AGENT_LIMITS.inputGraphDepth) {
    reject("AGENT_CONTEXT_SNAPSHOT_DEPTH_EXCEEDED", `${label} exceeds its snapshot depth limit`);
  }
  state.nodes += 1;
  if (state.nodes > DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.inputGraphNodes) {
    reject("AGENT_CONTEXT_SNAPSHOT_NODE_LIMIT_EXCEEDED", `${label} exceeds its snapshot node limit`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    accountString(value, state);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      reject("AGENT_CONTEXT_SNAPSHOT_NON_JSON_VALUE", `${label} contains a non-finite number`);
    }
    return value;
  }
  if (nodeTypes.isUint8Array(value)) {
    if (allowBinary) return copyByteArray(value);
    reject("AGENT_CONTEXT_SNAPSHOT_NON_JSON_VALUE", `${label} must not contain binary data`);
  }
  if (typeof value !== "object" || value === null) {
    reject("AGENT_CONTEXT_SNAPSHOT_NON_JSON_VALUE", `${label} must contain only plain JSON data`);
  }
  const object = value as object;
  if (nodeTypes.isProxy(object)) {
    reject("AGENT_CONTEXT_INPUT_PROXY_FORBIDDEN", `${label} contains a proxy`);
  }
  if (state.active.has(object)) {
    reject("AGENT_CONTEXT_INPUT_CYCLE_FORBIDDEN", `${label} contains a cycle`);
  }
  state.active.add(object);
  try {
    if (Array.isArray(object)) {
      const lengthDescriptor = requireDataDescriptor(
        object,
        "length",
        "AGENT_CONTEXT_INPUT_ARRAY_INVALID",
        `${label} array length must be a data property`
      );
      const length = lengthDescriptor.value;
      if (
        !Number.isSafeInteger(length) ||
        (length as number) < 0 ||
        (length as number) > DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.inputGraphNodes
      ) {
        reject("AGENT_CONTEXT_INPUT_ARRAY_INVALID", `${label} has an invalid array length`);
      }
      const result: unknown[] = new Array(length as number);
      let indices = 0;
      for (const key in object as unknown as readonly unknown[]) {
        if (!Object.hasOwn(object, key)) {
          reject(
            "AGENT_CONTEXT_INPUT_INHERITED_ENUMERABLE_FORBIDDEN",
            `${label} inherits an enumerable property`,
            { key }
          );
        }
        accountString(key, state);
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= (length as number)) {
          reject("AGENT_CONTEXT_INPUT_ARRAY_INVALID", `${label} arrays cannot have custom properties`);
        }
        const descriptor = requireDataDescriptor(
          object,
          key,
          "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN",
          `${label} contains an accessor`
        );
        result[Number(key)] = snapshotEnumerableGraph(
          descriptor.value,
          `${label}[${key}]`,
          allowBinary,
          depth + 1,
          state
        );
        indices += 1;
      }
      if (indices !== (length as number)) {
        reject("AGENT_CONTEXT_INPUT_ARRAY_INVALID", `${label} arrays cannot contain holes`);
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      reject("AGENT_CONTEXT_INPUT_PLAIN_DATA_REQUIRED", `${label} must use a plain prototype`);
    }
    const result: Record<string, unknown> = {};
    for (const key in object as Record<string, unknown>) {
      if (!Object.hasOwn(object, key)) {
        reject(
          "AGENT_CONTEXT_INPUT_INHERITED_ENUMERABLE_FORBIDDEN",
          `${label} inherits an enumerable property`,
          { key }
        );
      }
      accountString(key, state);
      const descriptor = requireDataDescriptor(
        object,
        key,
        "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN",
        `${label} contains an accessor`
      );
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotEnumerableGraph(
          descriptor.value,
          `${label}.${key}`,
          allowBinary,
          depth + 1,
          state
        )
      });
    }
    return Object.freeze(result);
  } finally {
    state.active.delete(object);
  }
};

const snapshotPlainJson = (value: unknown, label: string): JsonValue =>
  snapshotEnumerableGraph(value, label, false) as JsonValue;

const assertBoundedIdentifier = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u.test(value)
  ) {
    reject("AGENT_CONTEXT_IDENTIFIER_INVALID", `${label} must be a bounded identifier`, { label });
  }
  return value as string;
};

const contentIdentitySnapshot = (value: unknown, label: string): ContentIdentity => {
  const record = requireRecord(
    value,
    "AGENT_CONTEXT_IDENTITY_INVALID",
    `${label} must be a content identity`
  );
  exactKeys(record, ["algorithm", "digest", "size"], [], label);
  if (
    record.algorithm !== "sha256" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0
  ) {
    reject("AGENT_CONTEXT_IDENTITY_INVALID", `${label} has invalid content-identity fields`, { label });
  }
  return deepFreeze({
    algorithm: "sha256" as const,
    digest: record.digest as string,
    size: record.size as number
  });
};

const canonicalIdentitySnapshot = (value: unknown, label: string): CanonicalIdentity => {
  const record = requireRecord(
    value,
    "AGENT_CONTEXT_IDENTITY_INVALID",
    `${label} must be a canonical identity`
  );
  exactKeys(
    record,
    ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"],
    [],
    label
  );
  if (
    record.algorithm !== "sha256" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    typeof record.schemaVersion !== "string" ||
    record.schemaVersion.length < 1 ||
    record.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) {
    reject("AGENT_CONTEXT_IDENTITY_INVALID", `${label} has invalid canonical-identity fields`, { label });
  }
  return deepFreeze({
    algorithm: "sha256" as const,
    digest: record.digest as string,
    schemaVersion: record.schemaVersion as string,
    canonicalizationVersion: "evleda-c14n-json-v1" as const
  });
};

const sameIdentity = (
  left: ContentIdentity | CanonicalIdentity,
  right: ContentIdentity | CanonicalIdentity
): boolean => canonicalJson(left) === canonicalJson(right);

const boundTextSnapshot = (
  value: unknown,
  label: string,
  maximumBytes: number,
  expectedLogicalName?: string
): BoundAgentTextDocument => {
  const record = requireRecord(
    value,
    "AGENT_CONTEXT_TEXT_DOCUMENT_INVALID",
    `${label} must be a bound text document`
  );
  exactKeys(record, ["kind", "logicalName", "content", "identity"], [], label);
  if (
    record.kind !== "text" ||
    typeof record.logicalName !== "string" ||
    typeof record.content !== "string"
  ) {
    reject("AGENT_CONTEXT_TEXT_DOCUMENT_INVALID", `${label} is not a bound text document`);
  }
  if (expectedLogicalName !== undefined && record.logicalName !== expectedLogicalName) {
    reject("AGENT_CONTEXT_TEXT_DOCUMENT_INVALID", `${label} uses an unexpected logical name`);
  }
  if (Buffer.byteLength(record.content as string, "utf8") > maximumBytes) {
    reject("AGENT_CONTEXT_TEXT_DOCUMENT_TOO_LARGE", `${label} exceeds its byte limit`);
  }
  const suppliedIdentity = contentIdentitySnapshot(record.identity, `${label}.identity`);
  const rebound = bindAgentTextDocument(record.logicalName, record.content);
  if (!sameIdentity(suppliedIdentity, rebound.identity)) {
    reject("AGENT_CONTEXT_TEXT_DOCUMENT_IDENTITY_MISMATCH", `${label} identity does not reproduce`);
  }
  return rebound;
};

const boundModelSnapshot = (value: unknown): BoundDesignAgentModel => {
  const record = requireRecord(value, "AGENT_CONTEXT_MODEL_INVALID", "model must be a bound model");
  exactKeys(record, ["provider", "model", "version", "identity"], [], "model");
  const rebound = bindDesignAgentModel({
    provider: record.provider,
    model: record.model,
    version: record.version
  });
  const supplied = canonicalIdentitySnapshot(record.identity, "model.identity");
  if (!sameIdentity(supplied, rebound.identity)) {
    reject("AGENT_CONTEXT_MODEL_IDENTITY_MISMATCH", "Model identity does not reproduce");
  }
  return rebound;
};

const boundSettingsSnapshot = (value: unknown): BoundDesignAgentSettings => {
  const record = requireRecord(
    value,
    "AGENT_CONTEXT_SETTINGS_INVALID",
    "settings must be bound settings"
  );
  exactKeys(record, ["value", "identity"], [], "settings");
  const rebound = bindDesignAgentSettings(snapshotPlainJson(record.value, "settings.value"));
  const supplied = canonicalIdentitySnapshot(record.identity, "settings.identity");
  if (!sameIdentity(supplied, rebound.identity)) {
    reject("AGENT_CONTEXT_SETTINGS_IDENTITY_MISMATCH", "Settings identity does not reproduce");
  }
  assertContextDocumentSafe(rebound.value);
  assertNoConfidentialJson(rebound.value, "settings");
  const settingsValue = requireRecord(
    rebound.value,
    "AGENT_CONTEXT_SETTINGS_POLICY_INVALID",
    "settings.value must be the closed Phase-A settings object"
  );
  exactKeys(
    settingsValue,
    ["temperature", "maximumOutputBytes"],
    [],
    "settings.value"
  );
  if (
    settingsValue.temperature !== 0 ||
    settingsValue.maximumOutputBytes !== DESIGN_AGENT_LIMITS.providerOutputBytes
  ) {
    reject(
      "AGENT_CONTEXT_SETTINGS_POLICY_INVALID",
      "Phase-A agent settings must use deterministic temperature and the fixed output bound"
    );
  }
  return rebound;
};

const trustAnchorsSnapshot = (value: unknown): DesignAgentTrustAnchors => {
  const record = requireRecord(
    value,
    "AGENT_CONTEXT_TRUST_ANCHORS_INVALID",
    "trustAnchors must be a plain object"
  );
  const keys = ["instruction", "practiceCatalog", "provider", "modelFamily", "outputContract"] as const;
  exactKeys(record, keys, [], "trustAnchors");
  return deepFreeze({
    instruction: assertBoundedIdentifier(record.instruction, "trustAnchors.instruction"),
    practiceCatalog: assertBoundedIdentifier(
      record.practiceCatalog,
      "trustAnchors.practiceCatalog"
    ),
    provider: assertBoundedIdentifier(record.provider, "trustAnchors.provider"),
    modelFamily: assertBoundedIdentifier(record.modelFamily, "trustAnchors.modelFamily"),
    outputContract: assertBoundedIdentifier(
      record.outputContract,
      "trustAnchors.outputContract"
    )
  });
};

const requirementsSnapshot = (
  value: unknown,
  sourcePrompt: BoundAgentTextDocument,
  subject: DesignAgentStageSubject
): { readonly document: RequirementsDocument; readonly context: BoundAgentStructuredDocument } => {
  const bound = bindAgentStructuredDocument(
    DESIGN_AGENT_REQUIREMENTS_LOGICAL_NAME,
    REQUIREMENTS_SCHEMA,
    value
  );
  const snapshot = requireRecord(
    bound.value,
    "AGENT_CONTEXT_REQUIREMENTS_INVALID",
    "requirements must be a structured document"
  ) as Record<string, JsonValue>;
  const validation = requirementsDocumentSchema.safeParse(snapshot);
  if (!validation.success) {
    reject("AGENT_CONTEXT_REQUIREMENTS_INVALID", "requirements fails its closed runtime schema", {
      issues: validation.error.issues.slice(0, 16).map((issue) => ({
        code: issue.code,
        path: issue.path.map(String)
      }))
    });
  }
  const document = deepFreeze(validation.data) as RequirementsDocument;
  if (document.approvalId === undefined) {
    reject(
      "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_REQUIRED",
      "Agent workflow context requires an approved requirements document"
    );
  }
  assertBoundedIdentifier(document.approvalId, "requirements.approvalId");
  exactKeys(
    snapshot,
    [
      "schemaVersion",
      "identity",
      "sourcePrompt",
      "requirements",
      "constraints",
      "exclusions",
      "unresolvedAssumptions"
    ],
    ["approvalId"],
    "requirements"
  );
  if (snapshot.schemaVersion !== REQUIREMENTS_SCHEMA || !Array.isArray(snapshot.requirements)) {
    reject("AGENT_CONTEXT_REQUIREMENTS_INVALID", "requirements has an invalid schema or requirement list");
  }
  if (!isRecord(snapshot.constraints) || !Array.isArray(snapshot.exclusions) || !Array.isArray(snapshot.unresolvedAssumptions)) {
    reject("AGENT_CONTEXT_REQUIREMENTS_INVALID", "requirements has invalid structured fields");
  }
  const suppliedIdentity = canonicalIdentitySnapshot(document.identity, "requirements.identity");
  const suppliedSource = contentIdentitySnapshot(document.sourcePrompt, "requirements.sourcePrompt");
  const { identity: _identity, approvalId: _approvalId, ...identityPayload } = document;
  const recomputed = canonicalIdentity(identityPayload, REQUIREMENTS_SCHEMA);
  if (!sameIdentity(suppliedIdentity, recomputed)) {
    reject("AGENT_CONTEXT_REQUIREMENTS_IDENTITY_MISMATCH", "Requirements identity does not reproduce");
  }
  if (!sameIdentity(suppliedSource, sourcePrompt.identity)) {
    reject("AGENT_CONTEXT_SOURCE_PROMPT_MISMATCH", "Requirements do not bind the supplied source prompt");
  }
  if (!sameIdentity(suppliedIdentity, subject.requirementsIdentity)) {
    reject("AGENT_CONTEXT_SUBJECT_REQUIREMENTS_MISMATCH", "Subject and requirements identities differ");
  }
  const seen = new Set<string>();
  for (const [index, entry] of document.requirements.entries()) {
    if (!isRecord(entry)) {
      reject("AGENT_CONTEXT_REQUIREMENTS_INVALID", `requirements.requirements[${index}] must be an object`);
    }
    const id = assertBoundedIdentifier(
      entry.id,
      `requirements.requirements[${index}].id`
    );
    if (seen.has(id)) {
      reject("AGENT_CONTEXT_REQUIREMENTS_INVALID", "Requirement identifiers must be unique");
    }
    seen.add(id);
  }
  return deepFreeze({
    document,
    context: bindAgentStructuredDocument(
      DESIGN_AGENT_REQUIREMENTS_LOGICAL_NAME,
      REQUIREMENTS_SCHEMA,
      document
    )
  });
};

export interface DesignAgentRequirementsApprovalBinding {
  readonly id: string;
  readonly subjectDigest: string;
  readonly policyVersion: string;
}

const requirementsApprovalSnapshot = (
  value: unknown,
  requirements: RequirementsDocument,
  subject: DesignAgentStageSubject
): DesignAgentRequirementsApprovalBinding => {
  const snapshot = snapshotPlainJson(value, "requirementsApproval");
  const validation = approvalRecordSchema.safeParse(snapshot);
  if (!validation.success) {
    reject(
      "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_INVALID",
      "requirementsApproval fails its closed runtime schema"
    );
  }
  const approval = validation.data as ApprovalRecord;
  if (
    approval.kind !== "requirements" ||
    approval.projectId !== subject.projectId ||
    approval.runId !== subject.runId ||
    approval.designRevisionId !== undefined ||
    approval.evidenceRootDigest !== undefined ||
    approval.qualificationApprovalId !== undefined ||
    approval.actor.type !== "human" ||
    approval.actor.role !== "requirements_reviewer" ||
    approval.revokedAt !== undefined ||
    approval.expiresAt !== undefined
  ) {
    reject(
      "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_INVALID",
      "requirementsApproval is not a current run-bound human requirements approval"
    );
  }
  const binding = deepFreeze({
    id: assertBoundedIdentifier(approval.id, "requirementsApproval.id"),
    subjectDigest: assertBoundedIdentifier(
      approval.subjectDigest,
      "requirementsApproval.subjectDigest"
    ),
    policyVersion: assertBoundedIdentifier(
      approval.policyVersion,
      "requirementsApproval.policyVersion"
    )
  });
  if (!/^[0-9a-f]{64}$/u.test(binding.subjectDigest)) {
    reject(
      "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_INVALID",
      "requirementsApproval.subjectDigest must be a SHA-256 digest"
    );
  }
  if (
    requirements.approvalId !== binding.id ||
    requirements.identity.digest !== binding.subjectDigest
  ) {
    reject(
      "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_MISMATCH",
      "Requirements approval does not bind the exact approved requirements document"
    );
  }
  return binding;
};

export interface DesignAgentExpectedUpstreamBinding {
  readonly stage: StageKey;
  readonly outputIdentity: CanonicalIdentity;
}

interface BoundExpectedUpstreamBindings {
  readonly bindings: readonly DesignAgentExpectedUpstreamBinding[];
  readonly identity: CanonicalIdentity;
}

const expectedUpstreamBindingsSnapshot = (
  value: unknown,
  targetStage: Exclude<StageKey, "requirements">,
  subjectIdentity: CanonicalIdentity
): BoundExpectedUpstreamBindings => {
  if (!Array.isArray(value)) {
    reject("AGENT_CONTEXT_UPSTREAM_BINDING_INVALID", "upstreamBindings must be an array");
  }
  const bindingValues = value as readonly unknown[];
  const bindingCount = safeArrayLength(bindingValues, "upstreamBindings");
  const expectedStages = STAGE_ORDER.slice(1, stageIndex(targetStage));
  if (bindingCount !== expectedStages.length) {
    reject(
      "AGENT_CONTEXT_UPSTREAM_BINDING_INVALID",
      "upstreamBindings must cover every predecessor stage exactly once"
    );
  }
  const bindings: DesignAgentExpectedUpstreamBinding[] = [];
  for (let index = 0; index < bindingCount; index += 1) {
    const entry = safeArrayEntry(bindingValues, index, "upstreamBindings");
    const record = requireRecord(
      entry,
      "AGENT_CONTEXT_UPSTREAM_BINDING_INVALID",
      `upstreamBindings[${index}] must be an object`
    );
    exactKeys(record, ["stage", "outputIdentity"], [], `upstreamBindings[${index}]`);
    if (record.stage !== expectedStages[index]) {
      reject(
        "AGENT_CONTEXT_UPSTREAM_BINDING_INVALID",
        "upstreamBindings are not in exact workflow predecessor order",
        { index, expectedStage: expectedStages[index], actualStage: record.stage }
      );
    }
    bindings.push(deepFreeze({
      stage: record.stage as StageKey,
      outputIdentity: canonicalIdentitySnapshot(
        record.outputIdentity,
        `upstreamBindings[${index}].outputIdentity`
      )
    }));
  }
  const payload = deepFreeze({
    schemaVersion: DESIGN_AGENT_UPSTREAM_BINDING_SCHEMA,
    subjectIdentity,
    bindings
  });
  return deepFreeze({
    bindings,
    identity: canonicalIdentity(payload, DESIGN_AGENT_UPSTREAM_BINDING_SCHEMA)
  });
};

export interface DesignAgentContextArtifactDescriptor {
  readonly sourceStage: Exclude<StageKey, "requirements">;
  readonly logicalName: string;
  readonly mediaType: "application/json";
  readonly schemaVersion: string;
  readonly validationStatus: "pass" | "not_run";
}

const descriptor = (
  sourceStage: DesignAgentContextArtifactDescriptor["sourceStage"],
  logicalName: string,
  schemaVersion: string,
  validationStatus: DesignAgentContextArtifactDescriptor["validationStatus"]
): DesignAgentContextArtifactDescriptor => ({
  sourceStage,
  logicalName,
  mediaType: "application/json",
  schemaVersion,
  validationStatus
});

const ARCHITECTURE = descriptor(
  "system_architecture",
  "architecture/system-architecture.json",
  CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
  "pass"
);
const SELECTION = descriptor(
  "component_selection",
  "components/selection.json",
  "evleda.component-selection.v1",
  "pass"
);
const FOOTPRINT_MAP = descriptor(
  "component_selection",
  "components/footprint-map.json",
  "evleda.footprint-map.v1",
  "pass"
);
const SCHEMATIC_INTENT = descriptor(
  "schematic",
  "schematic/schematic-intent.json",
  CURRENT_SCHEMATIC_INTENT_SCHEMA,
  "not_run"
);
const FIRMWARE_CONTRACT = descriptor(
  "firmware_contract",
  "firmware/board-contract.json",
  "evleda.firmware-contract.v1",
  "pass"
);
const SIMULATION_PLAN = descriptor(
  "simulation_checks",
  "simulation/coverage-plan.json",
  "evleda.simulation-coverage-plan.v1",
  "not_run"
);
const PCB_LAYOUT_PLAN = descriptor(
  "pcb_placement_routing",
  "pcb/layout-routing-plan.json",
  "evleda.pcb-layout-plan.v2",
  "not_run"
);
const MANUFACTURING_PLAN = descriptor(
  "manufacturing_package",
  "manufacturing/manufacturing-plan.json",
  "evleda.manufacturing-plan.v1",
  "not_run"
);

export const DESIGN_AGENT_PRIMARY_ARTIFACT_BY_STAGE = deepFreeze({
  requirements: {
    logicalName: "requirements/requirements.json",
    mediaType: "application/json"
  },
  system_architecture: {
    logicalName: ARCHITECTURE.logicalName,
    mediaType: ARCHITECTURE.mediaType
  },
  component_selection: {
    logicalName: SELECTION.logicalName,
    mediaType: SELECTION.mediaType
  },
  schematic: {
    logicalName: SCHEMATIC_INTENT.logicalName,
    mediaType: SCHEMATIC_INTENT.mediaType
  },
  firmware_contract: {
    logicalName: FIRMWARE_CONTRACT.logicalName,
    mediaType: FIRMWARE_CONTRACT.mediaType
  },
  simulation_checks: {
    logicalName: SIMULATION_PLAN.logicalName,
    mediaType: SIMULATION_PLAN.mediaType
  },
  pcb_placement_routing: {
    logicalName: PCB_LAYOUT_PLAN.logicalName,
    mediaType: PCB_LAYOUT_PLAN.mediaType
  },
  manufacturing_package: {
    logicalName: MANUFACTURING_PLAN.logicalName,
    mediaType: MANUFACTURING_PLAN.mediaType
  },
  bringup_package: {
    logicalName: "bringup/bringup-plan.json",
    mediaType: "application/json"
  }
} as const satisfies Readonly<
  Record<StageKey, { readonly logicalName: string; readonly mediaType: string }>
>);

export const DESIGN_AGENT_CONTEXT_ARTIFACT_ALLOWLIST_BY_STAGE: Readonly<
  Record<Exclude<StageKey, "requirements">, readonly DesignAgentContextArtifactDescriptor[]>
> = deepFreeze({
  system_architecture: [],
  component_selection: [ARCHITECTURE],
  schematic: [ARCHITECTURE, SELECTION, FOOTPRINT_MAP],
  firmware_contract: [ARCHITECTURE, SELECTION, FOOTPRINT_MAP, SCHEMATIC_INTENT],
  simulation_checks: [
    ARCHITECTURE,
    SELECTION,
    FOOTPRINT_MAP,
    SCHEMATIC_INTENT,
    FIRMWARE_CONTRACT
  ],
  pcb_placement_routing: [
    ARCHITECTURE,
    SELECTION,
    FOOTPRINT_MAP,
    SCHEMATIC_INTENT,
    FIRMWARE_CONTRACT,
    SIMULATION_PLAN
  ],
  manufacturing_package: [
    ARCHITECTURE,
    SELECTION,
    FOOTPRINT_MAP,
    SCHEMATIC_INTENT,
    FIRMWARE_CONTRACT,
    SIMULATION_PLAN,
    PCB_LAYOUT_PLAN
  ],
  bringup_package: [
    ARCHITECTURE,
    SELECTION,
    FOOTPRINT_MAP,
    SCHEMATIC_INTENT,
    FIRMWARE_CONTRACT,
    SIMULATION_PLAN,
    PCB_LAYOUT_PLAN,
    MANUFACTURING_PLAN
  ]
} as const);

const safeLogicalName = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

export const isDesignAgentContextArtifactAllowed = (
  targetStage: Exclude<StageKey, "requirements">,
  sourceStage: StageKey,
  logicalName: string,
  mediaType: string
): boolean =>
  DESIGN_AGENT_CONTEXT_ARTIFACT_ALLOWLIST_BY_STAGE[targetStage].some(
    (entry) =>
      entry.sourceStage === sourceStage &&
      entry.logicalName === logicalName &&
      entry.mediaType === mediaType
  );

const allowedDescriptor = (
  targetStage: Exclude<StageKey, "requirements">,
  sourceStage: StageKey,
  logicalName: string,
  mediaType: string
): DesignAgentContextArtifactDescriptor | undefined =>
  DESIGN_AGENT_CONTEXT_ARTIFACT_ALLOWLIST_BY_STAGE[targetStage].find(
    (entry) =>
      entry.sourceStage === sourceStage &&
      entry.logicalName === logicalName &&
      entry.mediaType === mediaType
  );

const SENSITIVE_EXACT_KEYS = new Set([
  "path",
  "paths",
  "absolute_path",
  "host_path",
  "local_path",
  "file_path",
  "filesystem_path",
  "executable_path",
  "working_directory",
  "cwd",
  "root",
  "workspace_root",
  "workspace_path",
  "environment",
  "env",
  "authorization",
  "authorization_header",
  "proxy_authorization",
  "provider_evidence",
  "provider_response",
  "raw_provider_response",
  "provider_output",
  "raw_provider_output",
  "model_output",
  "raw_model_output",
  "untrusted_narrative",
  "physical_evidence",
  "physical_evidence_blob",
  "blob",
  "bytes_base64",
  "content_base64",
  "data_base64",
  "base64"
]);

const sensitiveKey = (key: string): boolean => {
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[.\-\s]+/gu, "_")
    .toLocaleLowerCase("en-US");
  return (
    SENSITIVE_EXACT_KEYS.has(normalized) ||
    /(?:^|_)(?:provider_evidence|provider_response|provider_output|model_output|untrusted_narrative|physical_evidence|base64)(?:_|$)/u.test(normalized) ||
    /(?:^|_)blob(?:_|$)/u.test(normalized) ||
    /^(?:credential|credentials|secret|secrets|password|passwd|token|tokens|access_token|auth_token|api_key|private_key|cookie|cookies)(?:_|$)/u.test(normalized) ||
    /(?:^|_)(?:credential|credentials|secret|secrets|password|passwd|token|tokens|access_token|auth_token|api_key|private_key|cookie|cookies)$/u.test(normalized)
  );
};

const absoluteHostPath = (value: string): boolean =>
  value.startsWith("/") ||
  value.startsWith("\\") ||
  /^[A-Za-z]:[\\/]/u.test(value) ||
  /^file:\/\//iu.test(value);

const SECRET_ASSIGNMENT_PATTERN =
  /(?:^|[\s,;{(/])(?:[A-Za-z0-9]+[_ -])?(?:api[_ -]?(?:key|token)|access[_ -]?token|auth[_ -]?token|password|passwd|client[_ -]?secret|private[_ -]?key|secret)\s*(?:=|:)\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;]{4,})/iu;
const AMBIGUOUS_TOKEN_ASSIGNMENT_PATTERN =
  /(?:^|[\s,;{(/])(?:[A-Za-z0-9]+[_ -])?token\s*(?:=|:)\s*(?:"([^"\r\n]{1,160})"|'([^'\r\n]{1,160})'|([^,;\r\n]{1,160}))/iu;
const NON_SECRET_TOKEN_SENTINELS = new Set([
  "disabled",
  "required",
  "none",
  "not required",
  "unsupported",
  "unconfigured",
  "redacted",
  "omitted",
  "false"
]);
const BEARER_SECRET_PATTERN = /(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/iu;
const BASIC_SECRET_PATTERN = /(?:^|\s)Basic\s+[A-Za-z0-9+/=]{8,}/iu;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu;
const EMBEDDED_HOST_PATH_PATTERN =
  /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|\\[^\\/\s]+[\\/][^\\/\s]+|\\[^\\/\s]+(?=[\s"')]|$)|\\(?:Users|Windows|ProgramData|Program Files|Documents and Settings)(?:[\\/]|$)|file:\/\/|\/(?:home|Users|etc|var|tmp|opt|root|usr)(?=\/|[\s"')]|$)(?:\/[^\s]*)?|\/(?:[^/\s]+\/)+[^/\s]+|\/[^/\s]+(?=[\s"')]|$))/iu;

const hasSecretAssignment = (value: string): boolean => {
  if (SECRET_ASSIGNMENT_PATTERN.test(value)) return true;
  const token = AMBIGUOUS_TOKEN_ASSIGNMENT_PATTERN.exec(value);
  if (token === null) return false;
  const assigned = (token[1] ?? token[2] ?? token[3] ?? "")
    .trim()
    .replace(/[.!?]+$/u, "")
    .toLocaleLowerCase("en-US");
  return !NON_SECRET_TOKEN_SENTINELS.has(assigned);
};

const assertNoConfidentialText = (value: string, label: string): void => {
  const family = hasSecretAssignment(value)
    ? "secret_assignment"
    : BEARER_SECRET_PATTERN.test(value)
      ? "bearer_credential"
      : BASIC_SECRET_PATTERN.test(value)
        ? "basic_credential"
        : PRIVATE_KEY_PATTERN.test(value)
          ? "private_key_material"
          : EMBEDDED_HOST_PATH_PATTERN.test(value)
            ? "absolute_host_path"
            : undefined;
  if (family !== undefined) {
    reject(
      "AGENT_CONTEXT_CONFIDENTIAL_INPUT_FORBIDDEN",
      `${label} contains confidential or host-local material`,
      { label, family }
    );
  }
};

const assertNoConfidentialJson = (value: JsonValue, label: string): void => {
  if (typeof value === "string") {
    assertNoConfidentialText(value, label);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoConfidentialJson(entry, `${label}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertNoConfidentialText(key, `${label}.key`);
    assertNoConfidentialJson(entry, `${label}.${key}`);
  }
};

const assertContextDocumentSafe = (value: JsonValue, path = "$"): void => {
  if (typeof value === "string") {
    if (absoluteHostPath(value)) {
      reject("AGENT_CONTEXT_ABSOLUTE_PATH_FORBIDDEN", "Allowlisted context contains an absolute host path", {
        path
      });
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertContextDocumentSafe(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (sensitiveKey(key)) {
      reject("AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN", "Allowlisted context contains a sensitive field", {
        path: `${path}.${key}`
      });
    }
    assertContextDocumentSafe(entry, `${path}.${key}`);
  }
};

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const requireArchitectureNativeContractExactInputs = (
  artifact: Record<string, unknown>,
  label: string
): void => {
  const value = readEnumerableData(artifact, "exactInputs", label);
  if (!Array.isArray(value)) {
    reject(
      "AGENT_CONTEXT_ARTIFACT_EXACT_INPUT_MISMATCH",
      `${label}.exactInputs must bind the reviewed native contract`
    );
  }
  const inputs = value as readonly unknown[];
  const count = safeArrayLength(inputs, `${label}.exactInputs`);
  const identities = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    identities.add(
      canonicalJson(
        snapshotPlainJson(
          safeArrayEntry(inputs, index, `${label}.exactInputs`),
          `${label}.exactInputs[${index}]`
        )
      )
    );
  }
  if (
    !identities.has(canonicalJson(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY)) ||
    !identities.has(
      canonicalJson(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY)
    )
  ) {
    reject(
      "AGENT_CONTEXT_ARTIFACT_EXACT_INPUT_MISMATCH",
      `${label}.exactInputs must contain both exact reviewed native-contract identities`
    );
  }
};

const decodeAllowlistedArtifact = (
  artifact: Record<string, unknown>,
  descriptorValue: DesignAgentContextArtifactDescriptor,
  label: string
): JsonValue => {
  const tool = requireRecord(
    readEnumerableData(artifact, "tool", label),
    "AGENT_CONTEXT_ARTIFACT_DESCRIPTOR_MISMATCH",
    `${label}.tool must match the closed deterministic-context descriptor`
  );
  exactKeys(
    tool,
    ["name", "version", "adapter", "capabilityProfile"],
    [],
    `${label}.tool`
  );
  const validationStatus = readEnumerableData(artifact, "validationStatus", label);
  if (
    tool.name !== "evleda-deterministic-generators" ||
    tool.version !== "0.1.0" ||
    tool.adapter !== "evleda" ||
    tool.capabilityProfile !== "robotics-controller-v0" ||
    validationStatus !== descriptorValue.validationStatus
  ) {
    reject(
      "AGENT_CONTEXT_ARTIFACT_DESCRIPTOR_MISMATCH",
      `${label} metadata is inconsistent with the allowlisted deterministic context shape`
    );
  }
  const content = readEnumerableData(artifact, "content", label);
  if (!nodeTypes.isUint8Array(content)) {
    reject("AGENT_CONTEXT_ARTIFACT_BYTES_INVALID", `${label}.content must be bytes`);
  }
  const contentBytes = content as Uint8Array;
  const contentParts = byteArrayParts(contentBytes);
  const maximumContentBytes =
    descriptorValue.schemaVersion === CURRENT_SYSTEM_ARCHITECTURE_SCHEMA
      ? REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES
      : DESIGN_AGENT_LIMITS.contextDocumentBytes;
  if (contentParts.byteLength > maximumContentBytes) {
    reject("AGENT_CONTEXT_ARTIFACT_TOO_LARGE", `${label} exceeds the context-document byte limit`);
  }
  const bytes = copyByteArray(contentBytes);
  const actualIdentity = contentIdentity(bytes);
  const expectedIdentity = contentIdentitySnapshot(
    readEnumerableData(artifact, "identity", label),
    `${label}.identity`
  );
  if (!sameIdentity(actualIdentity, expectedIdentity)) {
    reject("AGENT_CONTEXT_ARTIFACT_IDENTITY_MISMATCH", `${label} content identity does not reproduce`);
  }
  let text = "";
  try {
    text = decoder.decode(bytes);
  } catch {
    reject("AGENT_CONTEXT_ARTIFACT_UTF8_INVALID", `${label} is not valid UTF-8`);
  }
  const reencoded = Buffer.from(text, "utf8");
  if (!Buffer.from(bytes).equals(reencoded)) {
    reject(
      "AGENT_CONTEXT_ARTIFACT_UTF8_INVALID",
      `${label} does not have an exact UTF-8 round trip`
    );
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    reject("AGENT_CONTEXT_ARTIFACT_JSON_INVALID", `${label} is not valid JSON`);
  }
  const rebound = bindAgentStructuredDocument(
    `workflow/upstream/${descriptorValue.logicalName}`,
    descriptorValue.schemaVersion,
    parsed
  );
  if (!isRecord(rebound.value) || rebound.value.schemaVersion !== descriptorValue.schemaVersion) {
    reject("AGENT_CONTEXT_ARTIFACT_SCHEMA_MISMATCH", `${label} has an unexpected schema version`);
  }
  if (`${canonicalJson(rebound.value)}\n` !== text) {
    reject(
      "AGENT_CONTEXT_ARTIFACT_NOT_CANONICAL",
      `${label} must contain canonical JSON with one trailing newline`
    );
  }
  if (descriptorValue.schemaVersion === CURRENT_SYSTEM_ARCHITECTURE_SCHEMA) {
    // Preserve the security-specific rejection family for forbidden material while still
    // requiring the complete deterministic v2 architecture before it enters agent context.
    assertContextDocumentSafe(rebound.value);
    assertNoConfidentialJson(rebound.value, label);
    try {
      validateAndSnapshotReferenceSystemArchitectureV2Shape(rebound.value);
    } catch {
      reject(
        "AGENT_CONTEXT_ARTIFACT_SCHEMA_MISMATCH",
        `${label} is not the exact current system-architecture v2 shape`
      );
    }
    requireArchitectureNativeContractExactInputs(artifact, label);
  }
  if (descriptorValue.schemaVersion === CURRENT_SCHEMATIC_INTENT_SCHEMA) {
    try {
      validateAndSnapshotReferenceSchematicIntentV2Shape(rebound.value);
    } catch {
      reject(
        "AGENT_CONTEXT_ARTIFACT_SCHEMA_MISMATCH",
        `${label} is not the exact current schematic-intent v2 shape`
      );
    }
  }
  assertContextDocumentSafe(rebound.value);
  assertNoConfidentialJson(rebound.value, label);
  return rebound.value;
};

const TARGET_SCALAR_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  component: "component",
  controller: "controller",
  id: "id",
  item: "coverage",
  key: "component",
  logicalName: "artifact",
  mcuPin: "pin",
  name: "name",
  net: "net",
  owner: "owner",
  peripheral: "peripheral",
  pin: "pin",
  profileId: "profile",
  protocol: "protocol",
  rail: "rail",
  resource: "resource",
  signal: "signal"
});
const TARGET_ARRAY_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  appliesTo: "target",
  consumers: "consumer",
  inputs: "input",
  interfaceSelections: "interface",
  layoutConstraintIds: "constraint",
  names: "name",
  nets: "net",
  outputs: "output",
  pins: "pin",
  protection: "protection",
  referenceDesignators: "component",
  requiredNets: "net",
  signals: "signal",
  targetIds: "target"
});

const maybeAddTarget = (value: unknown, targets: Set<string>, prefix: string): void => {
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u.test(value)) {
    const identifier = `${prefix}:${value}`;
    if (identifier.length > 160) return;
    targets.add(identifier);
    if (targets.size > MAX_REFERENCE_IDS) {
      reject("AGENT_CONTEXT_REFERENCE_LIMIT_EXCEEDED", "Derived target index exceeds its limit");
    }
  }
};

const collectTargets = (value: JsonValue, targets: Set<string>): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectTargets(entry, targets));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const scalarPrefix = TARGET_SCALAR_PREFIXES[key];
    if (scalarPrefix !== undefined) maybeAddTarget(entry, targets, scalarPrefix);
    const arrayPrefix = TARGET_ARRAY_PREFIXES[key];
    if (arrayPrefix !== undefined && Array.isArray(entry)) {
      entry.forEach((candidate) => maybeAddTarget(candidate, targets, arrayPrefix));
    }
    collectTargets(entry, targets);
  }
};

const snapshotUpstreamArtifact = (
  artifactValue: unknown,
  targetStage: Exclude<StageKey, "requirements">,
  sourceStage: StageKey,
  index: number,
  targets: Set<string>
): Readonly<Record<string, JsonValue>> | undefined => {
  const artifactRecord = requireRecord(
    artifactValue,
    "AGENT_CONTEXT_UPSTREAM_INVALID",
    `upstream artifact ${index} must be an object`
  );
  const logicalName = readEnumerableData(artifactRecord, "logicalName", "upstream.artifact");
  const mediaType = readEnumerableData(artifactRecord, "mediaType", "upstream.artifact");
  if (typeof logicalName !== "string" || typeof mediaType !== "string") {
    reject("AGENT_CONTEXT_UPSTREAM_INVALID", `upstream artifact ${index} has unsafe metadata`);
  }
  const safeName = logicalName as string;
  const safeMediaType = mediaType as string;
  if (isReservedDesignAgentArtifactLogicalName(safeName)) return undefined;
  if (!safeLogicalName(safeName) || safeMediaType.length < 1 || safeMediaType.length > 160) {
    reject("AGENT_CONTEXT_UPSTREAM_INVALID", `upstream artifact ${index} has unsafe metadata`);
  }
  assertNoConfidentialText(safeName, `upstream.artifacts[${index}].logicalName`);
  assertNoConfidentialText(safeMediaType, `upstream.artifacts[${index}].mediaType`);
  const identity = contentIdentitySnapshot(
    readEnumerableData(artifactRecord, "identity", "upstream.artifact"),
    `upstream.artifacts[${index}].identity`
  );
  maybeAddTarget(safeName, targets, "artifact");
  const allowed = allowedDescriptor(targetStage, sourceStage, safeName, safeMediaType);
  const metadata: Record<string, JsonValue> = {
    logicalName: safeName,
    mediaType: safeMediaType,
    identity: identity as unknown as JsonValue
  };
  if (allowed !== undefined) {
    const content = decodeAllowlistedArtifact(
      artifactRecord,
      allowed,
      `${sourceStage}:${safeName}`
    );
    metadata.contextDocument = {
      kind: "structured",
      schemaVersion: allowed.schemaVersion,
      sourceIdentity: identity as unknown as JsonValue,
      value: content
    };
    collectTargets(content, targets);
  }
  return deepFreeze(metadata);
};

const computeStageResultOutputIdentity = (
  resultRecord: Record<string, unknown>,
  label: string
): CanonicalIdentity => {
  exactKeys(
    resultRecord,
    [
      "schemaVersion",
      "stage",
      "executionStatus",
      "artifacts",
      "evidence",
      "blockers",
      "outputIdentity"
    ],
    ["requirementsDocument"],
    label
  );
  const stage = readEnumerableData(resultRecord, "stage", label);
  const artifactsValue = readEnumerableData(resultRecord, "artifacts", label);
  const schemaVersion = readEnumerableData(resultRecord, "schemaVersion", label);
  const executionStatusValue = readEnumerableData(resultRecord, "executionStatus", label);
  const evidenceValue = readEnumerableData(resultRecord, "evidence", label);
  const blockersValue = readEnumerableData(resultRecord, "blockers", label);
  if (
    schemaVersion !== "evleda.stage-result.v1" ||
    typeof stage !== "string" ||
    stageIndex(stage as StageKey) < 0 ||
    !Array.isArray(artifactsValue) ||
    !Array.isArray(evidenceValue) ||
    !Array.isArray(blockersValue) ||
    (executionStatusValue !== "succeeded" && executionStatusValue !== "blocked")
  ) {
    reject("AGENT_CONTEXT_UPSTREAM_INVALID", `${label} has invalid stage-result metadata`);
  }
  const artifactArray = artifactsValue as readonly unknown[];
  const artifactCount = safeArrayLength(artifactArray, `${label}.artifacts`);
  const artifacts: unknown[] = [];
  for (let index = 0; index < artifactCount; index += 1) {
    const entry = safeArrayEntry(artifactArray, index, `${label}.artifacts`);
    const artifact = requireRecord(
      entry,
      "AGENT_CONTEXT_UPSTREAM_INVALID",
      `${label}.artifacts[${index}] must be an object`
    );
    artifacts.push({
      logicalName: snapshotPlainJson(
        readEnumerableData(artifact, "logicalName", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].logicalName`
      ),
      mediaType: snapshotPlainJson(
        readEnumerableData(artifact, "mediaType", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].mediaType`
      ),
      identity: snapshotPlainJson(
        readEnumerableData(artifact, "identity", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].identity`
      ),
      exactInputs: snapshotPlainJson(
        readEnumerableData(artifact, "exactInputs", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].exactInputs`
      ),
      derivedFrom: snapshotPlainJson(
        readEnumerableData(artifact, "derivedFrom", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].derivedFrom`
      ),
      tool: snapshotPlainJson(
        readEnumerableData(artifact, "tool", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].tool`
      ),
      validationStatus: snapshotPlainJson(
        readEnumerableData(artifact, "validationStatus", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].validationStatus`
      ),
      unresolvedAssumptions: snapshotPlainJson(
        readEnumerableData(artifact, "unresolvedAssumptions", `${label}.artifacts[${index}]`),
        `${label}.artifacts[${index}].unresolvedAssumptions`
      )
    });
  }
  const evidence = snapshotPlainJson(evidenceValue, `${label}.evidence`);
  const blockers = snapshotPlainJson(blockersValue, `${label}.blockers`);
  const evidenceArray = evidence as readonly JsonValue[];
  for (const [index, evidenceEntry] of evidenceArray.entries()) {
    if (!isRecord(evidenceEntry) || !EVIDENCE_CLASSES.has(String(evidenceEntry.evidenceClass))) {
      reject(
        "AGENT_CONTEXT_UPSTREAM_EVIDENCE_CLASS_INVALID",
        `${label}.evidence[${index}] has an unknown evidence class`
      );
    }
  }
  const blockerArray = blockers as readonly JsonValue[];
  const expectedExecutionStatus = blockerArray.length === 0 ? "succeeded" : "blocked";
  if (executionStatusValue !== expectedExecutionStatus) {
    reject(
      "AGENT_CONTEXT_UPSTREAM_STATUS_INVALID",
      `${label} execution status does not match its blocker set`
    );
  }
  let previousBlocker: { readonly code: string; readonly message: string } | undefined;
  for (const [index, blockerValue] of blockerArray.entries()) {
    if (!isRecord(blockerValue)) {
      reject("AGENT_CONTEXT_UPSTREAM_INVALID", `${label}.blockers[${index}] must be an object`);
    }
    const blockerRecord = blockerValue as Record<string, JsonValue>;
    const code = blockerRecord.code;
    const message = blockerRecord.message;
    if (typeof code !== "string" || typeof message !== "string") {
      reject(
        "AGENT_CONTEXT_UPSTREAM_INVALID",
        `${label}.blockers[${index}] must contain code and message strings`
      );
    }
    const safeCode = code as string;
    const safeMessage = message as string;
    if (
      previousBlocker !== undefined &&
      (previousBlocker.code > safeCode ||
        (previousBlocker.code === safeCode && previousBlocker.message > safeMessage))
    ) {
      reject(
        "AGENT_CONTEXT_UPSTREAM_BLOCKER_ORDER_INVALID",
        `${label} blockers are not in canonical code/message order`
      );
    }
    previousBlocker = { code: safeCode, message: safeMessage };
  }
  const manifestPayload: Record<string, JsonValue> = {
    schemaVersion: "evleda.stage-result.v1",
    stage: stage as string,
    executionStatus: executionStatusValue as "succeeded" | "blocked",
    artifacts: artifacts as unknown as JsonValue,
    evidence,
    blockers
  };
  if (Object.hasOwn(resultRecord, "requirementsDocument")) {
    const document = requireRecord(
      readEnumerableData(resultRecord, "requirementsDocument", label),
      "AGENT_CONTEXT_UPSTREAM_INVALID",
      `${label}.requirementsDocument must be an object`
    );
    manifestPayload.requirementsIdentity = snapshotPlainJson(
      readEnumerableData(document, "identity", `${label}.requirementsDocument`),
      `${label}.requirementsDocument.identity`
    );
  }
  const expected = canonicalIdentity(
    manifestPayload,
    `evleda.stage-result.${stage as StageKey}.v1`
  );
  return expected;
};

const stageResultOutputIdentity = (
  resultRecord: Record<string, unknown>,
  label: string
): CanonicalIdentity => {
  const expected = computeStageResultOutputIdentity(resultRecord, label);
  const supplied = canonicalIdentitySnapshot(
    readEnumerableData(resultRecord, "outputIdentity", label),
    `${label}.outputIdentity`
  );
  if (!sameIdentity(supplied, expected)) {
    reject(
      "AGENT_CONTEXT_UPSTREAM_OUTPUT_IDENTITY_MISMATCH",
      `${label} does not reproduce its full stage-result output identity`
    );
  }
  return supplied;
};

const buildContextInventory = (
  targetStage: Exclude<StageKey, "requirements">,
  runBindingIdentity: CanonicalIdentity,
  requirementsApproval: DesignAgentRequirementsApprovalBinding,
  expectedBindings: BoundExpectedUpstreamBindings,
  upstreamValue: unknown,
  targets: Set<string>
): BoundAgentStructuredDocument => {
  if (!Array.isArray(upstreamValue)) {
    reject("AGENT_CONTEXT_UPSTREAM_INVALID", "upstream must be an array");
  }
  const upstreamArray = upstreamValue as readonly unknown[];
  const upstreamCount = safeArrayLength(upstreamArray, "upstream");
  const candidateUpstream: unknown[] = [];
  let sawRequirements = false;
  for (let index = 0; index < upstreamCount; index += 1) {
    const resultValue = safeArrayEntry(upstreamArray, index, "upstream");
    const result = requireRecord(
      resultValue,
      "AGENT_CONTEXT_UPSTREAM_INVALID",
      `upstream[${index}] must be an object`
    );
    const stage = readEnumerableData(result, "stage", `upstream[${index}]`);
    if (stage === "requirements") {
      if (sawRequirements || candidateUpstream.length > 0) {
        reject(
          "AGENT_CONTEXT_UPSTREAM_INVALID",
          "An optional requirements result may appear only once before candidate predecessors"
        );
      }
      sawRequirements = true;
      continue;
    }
    candidateUpstream.push(resultValue);
  }
  if (candidateUpstream.length !== expectedBindings.bindings.length) {
    reject(
      "AGENT_CONTEXT_UPSTREAM_BINDING_MISMATCH",
      "Upstream results do not match the host-supplied predecessor binding count"
    );
  }
  const upstream: Array<Readonly<Record<string, JsonValue>>> = [];
  for (let resultIndex = 0; resultIndex < candidateUpstream.length; resultIndex += 1) {
    const resultValue = candidateUpstream[resultIndex];
    const resultRecord = requireRecord(
      resultValue,
      "AGENT_CONTEXT_UPSTREAM_INVALID",
      `upstream[${resultIndex}] must be an object`
    );
    const sourceStageValue = readEnumerableData(resultRecord, "stage", `upstream[${resultIndex}]`);
    const executionStatus = readEnumerableData(
      resultRecord,
      "executionStatus",
      `upstream[${resultIndex}]`
    );
    const artifactValues = readEnumerableData(
      resultRecord,
      "artifacts",
      `upstream[${resultIndex}]`
    );
    if (
      readEnumerableData(resultRecord, "schemaVersion", `upstream[${resultIndex}]`) !==
        "evleda.stage-result.v1" ||
      typeof sourceStageValue !== "string" ||
      executionStatus !== "succeeded" ||
      !Array.isArray(artifactValues)
    ) {
      reject("AGENT_CONTEXT_UPSTREAM_INVALID", `upstream[${resultIndex}] has invalid stage metadata`);
    }
    const sourceStage = sourceStageValue as StageKey;
    const expectedBinding = expectedBindings.bindings[resultIndex]!;
    if (sourceStage !== expectedBinding.stage) {
      reject(
        "AGENT_CONTEXT_UPSTREAM_BINDING_MISMATCH",
        "Upstream results are not in the exact host-bound predecessor order",
        { resultIndex, expectedStage: expectedBinding.stage, actualStage: sourceStage }
      );
    }
    const outputIdentity = stageResultOutputIdentity(resultRecord, `upstream[${resultIndex}]`);
    if (!sameIdentity(outputIdentity, expectedBinding.outputIdentity)) {
      reject(
        "AGENT_CONTEXT_UPSTREAM_BINDING_MISMATCH",
        "Upstream output identity does not match the separately supplied host binding",
        { resultIndex, stage: sourceStage }
      );
    }
    const primary = DESIGN_AGENT_PRIMARY_ARTIFACT_BY_STAGE[sourceStage];
    const artifactArray = artifactValues as readonly unknown[];
    const artifactCount = safeArrayLength(artifactArray, `upstream[${resultIndex}].artifacts`);
    let primaryCount = 0;
    for (let artifactIndex = 0; artifactIndex < artifactCount; artifactIndex += 1) {
      const artifactValue = safeArrayEntry(
        artifactArray,
        artifactIndex,
        `upstream[${resultIndex}].artifacts`
      );
      const artifact = requireRecord(
        artifactValue,
        "AGENT_CONTEXT_UPSTREAM_INVALID",
        `upstream[${resultIndex}] artifact must be an object`
      );
      if (
        readEnumerableData(artifact, "logicalName", `upstream[${resultIndex}].artifact`) ===
          primary.logicalName &&
        readEnumerableData(artifact, "mediaType", `upstream[${resultIndex}].artifact`) ===
          primary.mediaType
      ) {
        primaryCount += 1;
      }
    }
    if (primaryCount !== 1) {
      reject(
        "AGENT_CONTEXT_PRIMARY_ARTIFACT_REQUIRED",
        "Every predecessor result must contain exactly one primary deterministic artifact",
        { resultIndex, stage: sourceStage, logicalName: primary.logicalName, primaryCount }
      );
    }
    const logicalNames = new Set<string>();
    const artifacts: Array<Readonly<Record<string, JsonValue>>> = [];
    for (let artifactIndex = 0; artifactIndex < artifactCount; artifactIndex += 1) {
      const artifact = safeArrayEntry(
        artifactArray,
        artifactIndex,
        `upstream[${resultIndex}].artifacts`
      );
      const snapshot = snapshotUpstreamArtifact(
        artifact,
        targetStage,
        sourceStage,
        artifactIndex,
        targets
      );
      if (snapshot === undefined) continue;
      const logicalName = snapshot.logicalName as string;
      const folded = logicalName.toLocaleLowerCase("en-US");
      if (logicalNames.has(folded)) {
        reject("AGENT_CONTEXT_UPSTREAM_INVALID", "Upstream artifact logical names must be unique");
      }
      logicalNames.add(folded);
      artifacts.push(snapshot);
    }
    artifacts.sort((left, right) => {
      const leftName = left.logicalName as string;
      const rightName = right.logicalName as string;
      return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    });
    upstream.push({
      stage: sourceStage,
      executionStatus: "succeeded" as const,
      outputIdentity: outputIdentity as unknown as JsonValue,
      artifacts
    });
  }
  return bindAgentStructuredDocument(
    DESIGN_AGENT_CONTEXT_INVENTORY_LOGICAL_NAME,
    DESIGN_AGENT_CONTEXT_INVENTORY_SCHEMA,
    {
      schemaVersion: DESIGN_AGENT_CONTEXT_INVENTORY_SCHEMA,
      targetStage,
      runBindingIdentity,
      requirementsApproval,
      upstreamBindingIdentity: expectedBindings.identity,
      bindingAssessment: "consistency_only_non_authoritative",
      requiredAuthority: "application_authenticated_persisted_attempt_bindings_and_approval",
      upstream
    }
  );
};

export interface SafeDesignAgentWorkflowInputSeed {
  readonly subject: DesignAgentStageSubject;
  readonly runBinding: DesignAgentProposalRequiredRunBinding;
  readonly instructionDocument: BoundAgentTextDocument;
  readonly trustAnchors: DesignAgentTrustAnchors;
  readonly sourcePrompt: BoundAgentTextDocument;
  readonly practiceCatalog: PcbEngineeringPracticeCatalog;
  readonly model: BoundDesignAgentModel;
  readonly settings: BoundDesignAgentSettings;
  readonly requirements: RequirementsDocument;
  readonly requirementsApproval: ApprovalRecord;
  readonly upstreamBindings: readonly DesignAgentExpectedUpstreamBinding[];
  readonly upstream: readonly StageExecutionResult[];
}

const INPUT_KEYS = [
  "subject",
  "runBinding",
  "instructionDocument",
  "trustAnchors",
  "sourcePrompt",
  "practiceCatalog",
  "model",
  "settings",
  "requirements",
  "requirementsApproval",
  "upstreamBindings",
  "upstream"
] as const;

export const buildSafeDesignAgentWorkflowInput = (input: unknown): DesignAgentRunInput => {
  assertStaticInputGraph(input);
  const record = requireRecord(
    input,
    "AGENT_CONTEXT_INPUT_INVALID",
    "Workflow-context input must be a plain object"
  );
  exactKeys(record, INPUT_KEYS, [], "input");

  const subject = bindDesignAgentStageSubject(snapshotPlainJson(record.subject, "subject"));
  const parsedRunBinding = bindDesignAgentRunBinding(
    snapshotPlainJson(record.runBinding, "runBinding")
  );
  if (parsedRunBinding.mode !== "proposal_required") {
    reject(
      "AGENT_CONTEXT_RUN_BINDING_REQUIRED",
      "Workflow context requires a proposal_required run binding"
    );
  }
  const runBinding = parsedRunBinding as DesignAgentProposalRequiredRunBinding;
  const instructionDocument = boundTextSnapshot(
    record.instructionDocument,
    "instructionDocument",
    DESIGN_AGENT_LIMITS.instructionBytes,
    DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME
  );
  const sourcePrompt = boundTextSnapshot(
    record.sourcePrompt,
    "sourcePrompt",
    DESIGN_AGENT_LIMITS.sourcePromptBytes,
    DESIGN_AGENT_SOURCE_PROMPT_LOGICAL_NAME
  );
  const requirements = requirementsSnapshot(
    snapshotPlainJson(record.requirements, "requirements"),
    sourcePrompt,
    subject
  );
  assertNoConfidentialText(sourcePrompt.content, "sourcePrompt");
  assertContextDocumentSafe(requirements.document as unknown as JsonValue);
  assertNoConfidentialJson(
    requirements.document as unknown as JsonValue,
    "requirements"
  );
  const requirementsApproval = requirementsApprovalSnapshot(
    record.requirementsApproval,
    requirements.document,
    subject
  );
  const expectedUpstreamBindings = expectedUpstreamBindingsSnapshot(
    record.upstreamBindings,
    subject.stage,
    subject.identity
  );
  const trustAnchors = trustAnchorsSnapshot(record.trustAnchors);
  let practiceCatalog: PcbEngineeringPracticeCatalog | undefined;
  try {
    practiceCatalog = validateAndSnapshotPcbEngineeringPracticeCatalog(
      snapshotPlainJson(record.practiceCatalog, "practiceCatalog")
    );
  } catch {
    reject("AGENT_CONTEXT_CATALOG_INVALID", "practiceCatalog is not a valid exact catalog snapshot");
  }
  if (practiceCatalog === undefined || practiceCatalog.schemaVersion !== PCB_ENGINEERING_PRACTICE_SCHEMA) {
    reject("AGENT_CONTEXT_CATALOG_INVALID", "practiceCatalog uses an unexpected schema");
  }
  const safePracticeCatalog = practiceCatalog as PcbEngineeringPracticeCatalog;
  const model = boundModelSnapshot(record.model);
  const settings = boundSettingsSnapshot(record.settings);
  assertNoConfidentialText(instructionDocument.content, "instructionDocument");

  const requireRunBindingIdentity = (
    actual: ContentIdentity | CanonicalIdentity,
    expected: ContentIdentity | CanonicalIdentity,
    field: string
  ): void => {
    if (!sameIdentity(actual, expected)) {
      reject(
        "AGENT_CONTEXT_RUN_BINDING_MISMATCH",
        `Workflow input ${field} does not match the immutable run binding`,
        { field }
      );
    }
  };
  if (canonicalJson(trustAnchors) !== canonicalJson(runBinding.trustAnchors)) {
    reject(
      "AGENT_CONTEXT_RUN_BINDING_MISMATCH",
      "Workflow input trust anchors do not match the immutable run binding",
      { field: "trustAnchors" }
    );
  }
  requireRunBindingIdentity(
    instructionDocument.identity,
    runBinding.instructionIdentity,
    "instructionIdentity"
  );
  requireRunBindingIdentity(
    safePracticeCatalog.identity,
    runBinding.practiceCatalogIdentity,
    "practiceCatalogIdentity"
  );
  requireRunBindingIdentity(model.identity, runBinding.modelIdentity, "modelIdentity");
  requireRunBindingIdentity(settings.identity, runBinding.settingsIdentity, "settingsIdentity");

  const targets = new Set<string>();
  maybeAddTarget(subject.stage, targets, "stage");
  const requirementIds = requirements.document.requirements.map((requirement) => requirement.id).sort();
  if (requirementIds.length > MAX_REFERENCE_IDS) {
    reject("AGENT_CONTEXT_REFERENCE_LIMIT_EXCEEDED", "Requirement reference index exceeds its limit");
  }
  for (const key in requirements.document.constraints) {
    if (!Object.hasOwn(requirements.document.constraints, key)) {
      reject(
        "AGENT_CONTEXT_INPUT_INHERITED_ENUMERABLE_FORBIDDEN",
        "Requirements constraints inherit an enumerable property",
        { key }
      );
    }
    maybeAddTarget(key, targets, "constraint");
  }

  const subjectContext = bindAgentStructuredDocument(
    DESIGN_AGENT_WORKFLOW_SUBJECT_LOGICAL_NAME,
    DESIGN_AGENT_STAGE_SUBJECT_SCHEMA,
    subject
  );
  const inventoryContext = buildContextInventory(
    subject.stage,
    runBinding.identity,
    requirementsApproval,
    expectedUpstreamBindings,
    record.upstream,
    targets
  );
  const referenceIndex = bindDesignAgentReferenceIndex({
    requirementIds,
    targetIds: [...targets].sort()
  });
  const context = [subjectContext, requirements.context, inventoryContext] as const;
  const contextBytes = context.reduce(
    (total, document) => total + Buffer.byteLength(canonicalJson(document.value), "utf8"),
    0
  );
  if (contextBytes > DESIGN_AGENT_LIMITS.totalContextBytes) {
    reject("AGENT_CONTEXT_LIMIT_EXCEEDED", "Assembled workflow context exceeds its aggregate byte limit");
  }

  return deepFreeze({
    stage: subject.stage,
    role: roleForStage(subject.stage),
    instructionDocument,
    trustAnchors,
    sourcePrompt,
    practiceCatalogLogicalName: DESIGN_AGENT_CATALOG_LOGICAL_NAME,
    practiceCatalog: safePracticeCatalog,
    model,
    settings,
    referenceIndex,
    context
  });
};

/**
 * Remove application-owned proposal artifacts from the view passed to later deterministic stages.
 * The wrapper retains the authenticated source identity while its projected result receives a
 * separately reproducing identity.
 */
export interface FilteredDesignAgentUpstream<K extends StageKey = StageKey> {
  readonly schemaVersion: typeof DESIGN_AGENT_FILTERED_UPSTREAM_SCHEMA;
  readonly sourceCompositeOutputIdentity: CanonicalIdentity;
  readonly result: StageExecutionResult<K>;
  readonly identity: CanonicalIdentity;
}

export const filterAgentProvenanceFromUpstream = <K extends StageKey>(
  result: StageExecutionResult<K>
): FilteredDesignAgentUpstream<K> => {
  assertStaticInputGraph(result);
  const resultRecord = requireRecord(
    result,
    "AGENT_CONTEXT_UPSTREAM_INVALID",
    "upstreamStageResult must be an object"
  );
  exactKeys(
    resultRecord,
    [
      "schemaVersion",
      "stage",
      "executionStatus",
      "artifacts",
      "evidence",
      "blockers",
      "outputIdentity"
    ],
    ["requirementsDocument"],
    "upstreamStageResult"
  );
  const originalOutputIdentity = stageResultOutputIdentity(
    resultRecord,
    "upstreamStageResult"
  );
  const artifactValues = readEnumerableData(
    resultRecord,
    "artifacts",
    "upstreamStageResult"
  );
  const evidenceValues = readEnumerableData(
    resultRecord,
    "evidence",
    "upstreamStageResult"
  );
  if (!Array.isArray(artifactValues) || !Array.isArray(evidenceValues)) {
    reject(
      "AGENT_CONTEXT_UPSTREAM_INVALID",
      "upstreamStageResult artifacts and evidence must be arrays"
    );
  }
  const removedDigests = new Set<string>();
  const retainedArtifacts: unknown[] = [];
  let retainedBytes = 0;
  const artifactArray = artifactValues as readonly unknown[];
  const artifactCount = safeArrayLength(artifactArray, "upstreamStageResult.artifacts");
  for (let index = 0; index < artifactCount; index += 1) {
    const artifactValue = safeArrayEntry(
      artifactArray,
      index,
      "upstreamStageResult.artifacts"
    );
    const artifact = requireRecord(
      artifactValue,
      "AGENT_CONTEXT_UPSTREAM_INVALID",
      `upstreamStageResult.artifacts[${index}] must be an object`
    );
    const logicalName = readEnumerableData(
      artifact,
      "logicalName",
      `upstreamStageResult.artifacts[${index}]`
    );
    if (typeof logicalName !== "string") {
      reject("AGENT_CONTEXT_UPSTREAM_INVALID", "Artifact logicalName must be a string");
    }
    const identity = contentIdentitySnapshot(
      readEnumerableData(artifact, "identity", `upstreamStageResult.artifacts[${index}]`),
      `upstreamStageResult.artifacts[${index}].identity`
    );
    if (isReservedDesignAgentArtifactLogicalName(logicalName)) {
      removedDigests.add(identity.digest);
      continue;
    }
    const mediaType = readEnumerableData(
      artifact,
      "mediaType",
      `upstreamStageResult.artifacts[${index}]`
    );
    if (
      !safeLogicalName(logicalName) ||
      typeof mediaType !== "string" ||
      mediaType.length < 1 ||
      mediaType.length > 160
    ) {
      reject(
        "AGENT_CONTEXT_UPSTREAM_INVALID",
        "Retained artifact metadata is not a safe bounded logical reference"
      );
    }
    const safeRetainedName = logicalName as string;
    const safeRetainedMediaType = mediaType as string;
    assertNoConfidentialText(
      safeRetainedName,
      `upstreamStageResult.artifacts[${index}].logicalName`
    );
    assertNoConfidentialText(
      safeRetainedMediaType,
      `upstreamStageResult.artifacts[${index}].mediaType`
    );
    exactKeys(
      artifact,
      [
        "logicalName",
        "mediaType",
        "content",
        "identity",
        "exactInputs",
        "derivedFrom",
        "tool",
        "validationStatus",
        "unresolvedAssumptions"
      ],
      [],
      `upstreamStageResult.artifacts[${index}]`
    );
    const content = readEnumerableData(
      artifact,
      "content",
      `upstreamStageResult.artifacts[${index}]`
    );
  if (!nodeTypes.isUint8Array(content)) {
      reject("AGENT_CONTEXT_ARTIFACT_BYTES_INVALID", "Retained artifact content must be bytes");
    }
    const byteLength = byteArrayParts(content as Uint8Array).byteLength;
    if (byteLength > DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.retainedArtifactBytes) {
      reject(
        "AGENT_CONTEXT_RETAINED_ARTIFACT_TOO_LARGE",
        "A retained upstream artifact exceeds the downstream byte limit",
        { logicalName, byteLength }
      );
    }
    retainedBytes += byteLength;
    if (retainedBytes > DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.retainedAggregateArtifactBytes) {
      reject(
        "AGENT_CONTEXT_RETAINED_ARTIFACT_AGGREGATE_TOO_LARGE",
        "Retained upstream artifact bytes exceed the downstream aggregate limit",
        { retainedBytes }
      );
    }
    retainedArtifacts.push({
      logicalName: safeRetainedName,
      mediaType: safeRetainedMediaType,
      content,
      identity,
      exactInputs: snapshotPlainJson(
        readEnumerableData(artifact, "exactInputs", `upstreamStageResult.artifacts[${index}]`),
        `upstreamStageResult.artifacts[${index}].exactInputs`
      ),
      derivedFrom: snapshotPlainJson(
        readEnumerableData(artifact, "derivedFrom", `upstreamStageResult.artifacts[${index}]`),
        `upstreamStageResult.artifacts[${index}].derivedFrom`
      ),
      tool: snapshotPlainJson(
        readEnumerableData(artifact, "tool", `upstreamStageResult.artifacts[${index}]`),
        `upstreamStageResult.artifacts[${index}].tool`
      ),
      validationStatus: snapshotPlainJson(
        readEnumerableData(
          artifact,
          "validationStatus",
          `upstreamStageResult.artifacts[${index}]`
        ),
        `upstreamStageResult.artifacts[${index}].validationStatus`
      ),
      unresolvedAssumptions: snapshotPlainJson(
        readEnumerableData(
          artifact,
          "unresolvedAssumptions",
          `upstreamStageResult.artifacts[${index}]`
        ),
        `upstreamStageResult.artifacts[${index}].unresolvedAssumptions`
      )
    });
  }

  const evidenceArray = evidenceValues as readonly unknown[];
  const evidenceCount = safeArrayLength(evidenceArray, "upstreamStageResult.evidence");
  const retainedEvidence: JsonValue[] = [];
  for (let index = 0; index < evidenceCount; index += 1) {
    const entryValue = safeArrayEntry(evidenceArray, index, "upstreamStageResult.evidence");
    const entry = requireRecord(
      entryValue,
      "AGENT_CONTEXT_UPSTREAM_INVALID",
      `upstreamStageResult.evidence[${index}] must be an object`
    );
    exactKeys(
      entry,
      [
        "evidenceClass",
        "claim",
        "subjectDigests",
        "exactInputs",
        "tool",
        "validationStatus",
        "unresolvedAssumptions"
      ],
      ["rawArtifactLogicalName", "parsedArtifactLogicalName"],
      `upstreamStageResult.evidence[${index}]`
    );
    const evidenceClass = readEnumerableData(
      entry,
      "evidenceClass",
      `upstreamStageResult.evidence[${index}]`
    );
    if (typeof evidenceClass !== "string" || !EVIDENCE_CLASSES.has(evidenceClass)) {
      reject(
        "AGENT_CONTEXT_UPSTREAM_EVIDENCE_CLASS_INVALID",
        "Filtered upstream evidence has an unknown evidence class"
      );
    }
    const raw = Object.hasOwn(entry, "rawArtifactLogicalName")
      ? readEnumerableData(entry, "rawArtifactLogicalName", `upstreamStageResult.evidence[${index}]`)
      : undefined;
    const parsed = Object.hasOwn(entry, "parsedArtifactLogicalName")
      ? readEnumerableData(
          entry,
          "parsedArtifactLogicalName",
          `upstreamStageResult.evidence[${index}]`
        )
      : undefined;
    const directLink =
      isReservedDesignAgentArtifactLogicalName(raw) ||
      isReservedDesignAgentArtifactLogicalName(parsed);
    let keep = !directLink;
    const subjects = readEnumerableData(
      entry,
      "subjectDigests",
      `upstreamStageResult.evidence[${index}]`
    );
    if (!Array.isArray(subjects)) {
      reject("AGENT_CONTEXT_UPSTREAM_INVALID", "Evidence subjectDigests must be an array");
    }
    const subjectArray = subjects as readonly unknown[];
    const subjectCount = safeArrayLength(
      subjectArray,
      `upstreamStageResult.evidence[${index}].subjectDigests`
    );
    for (let subjectIndex = 0; subjectIndex < subjectCount; subjectIndex += 1) {
      const digest = safeArrayEntry(
        subjectArray,
        subjectIndex,
        `upstreamStageResult.evidence[${index}].subjectDigests`
      );
      if (typeof digest === "string" && removedDigests.has(digest)) {
        keep = false;
        break;
      }
    }
    if (keep) {
      retainedEvidence.push(
        snapshotPlainJson(entry, `upstreamStageResult.evidence[${index}]`)
      );
    }
  }
  const copiedArtifacts: unknown[] = [];
  for (let index = 0; index < retainedArtifacts.length; index += 1) {
    const artifactValue = retainedArtifacts[index]!;
    const artifact = artifactValue as Record<string, unknown>;
    const originalContent = artifact.content as Uint8Array;
    const copiedContent = copyByteArray(originalContent);
    const identity = artifact.identity as ContentIdentity;
    const actualIdentity = contentIdentity(copiedContent);
    if (!sameIdentity(actualIdentity, identity)) {
      reject(
        "AGENT_CONTEXT_ARTIFACT_IDENTITY_MISMATCH",
        "Retained artifact bytes do not reproduce their declared identity",
        { index, logicalName: artifact.logicalName }
      );
    }
    copiedArtifacts.push(deepFreeze({ ...artifact, content: copiedContent }));
  }
  const blockers = snapshotPlainJson(
    readEnumerableData(resultRecord, "blockers", "upstreamStageResult"),
    "upstreamStageResult.blockers"
  );
  const filteredValue: Record<string, unknown> = {
    schemaVersion: readEnumerableData(resultRecord, "schemaVersion", "upstreamStageResult"),
    stage: readEnumerableData(resultRecord, "stage", "upstreamStageResult"),
    executionStatus: readEnumerableData(
      resultRecord,
      "executionStatus",
      "upstreamStageResult"
    ),
    artifacts: copiedArtifacts,
    evidence: retainedEvidence,
    blockers,
    outputIdentity: originalOutputIdentity
  };
  if (Object.hasOwn(resultRecord, "requirementsDocument")) {
    filteredValue.requirementsDocument = snapshotPlainJson(
      readEnumerableData(resultRecord, "requirementsDocument", "upstreamStageResult"),
      "upstreamStageResult.requirementsDocument"
    );
  }
  const filteredOutputIdentity = computeStageResultOutputIdentity(
    filteredValue,
    "filteredUpstreamStageResult"
  );
  filteredValue.outputIdentity = filteredOutputIdentity;
  const filteredResult = deepFreeze(filteredValue) as unknown as StageExecutionResult<K>;
  const wrapperPayload = {
    schemaVersion: DESIGN_AGENT_FILTERED_UPSTREAM_SCHEMA,
    sourceCompositeOutputIdentity: originalOutputIdentity,
    filteredOutputIdentity
  };
  return deepFreeze({
    schemaVersion: DESIGN_AGENT_FILTERED_UPSTREAM_SCHEMA,
    sourceCompositeOutputIdentity: originalOutputIdentity,
    result: filteredResult,
    identity: canonicalIdentity(wrapperPayload, DESIGN_AGENT_FILTERED_UPSTREAM_SCHEMA)
  });
};

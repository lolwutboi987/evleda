import { types as nodeTypes } from "node:util";
import {
  canonicalIdentity,
  canonicalJson,
  constantTimeDigestEqual,
  contentIdentity
} from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import { STAGE_ORDER, type StageKey } from "../domain/stages.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  PCB_ENGINEERING_PRACTICE_SCHEMA,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
  type PcbEngineeringPracticeCatalog
} from "../knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_CATALOG_LOGICAL_NAME,
  DESIGN_AGENT_FORBIDDEN_AUTHORITY_TERMS,
  DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
  DESIGN_AGENT_LIMITS,
  DESIGN_AGENT_LIVE_REGENERATION_POLICY,
  DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY,
  DESIGN_AGENT_MODEL_SCHEMA,
  DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME,
  DESIGN_AGENT_PROMPT_PACK_SCHEMA,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  DESIGN_AGENT_PROPOSAL_SCHEMA,
  DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
  DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA,
  DESIGN_AGENT_PROVIDER_SCHEMA,
  DESIGN_AGENT_REFERENCE_INDEX_LOGICAL_NAME,
  DESIGN_AGENT_REFERENCE_INDEX_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_SETTINGS_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
  DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA,
  validateDesignAgentProposal,
  type BoundAgentContextDocument,
  type BoundAgentStructuredDocument,
  type BoundAgentTextDocument,
  type BoundDesignAgentModel,
  type BoundDesignAgentProvider,
  type BoundDesignAgentReferenceIndex,
  type BoundDesignAgentSettings,
  type AgentTrustStorePort,
  type DesignAgentCoordinatorPrerequisites,
  type DesignAgentDeploymentMode,
  type DesignAgentLiveExecution,
  type DesignAgentPort,
  type DesignAgentPromptPack,
  type DesignAgentProductionCoordinatorPrerequisites,
  type DesignAgentProposal,
  type DesignAgentProposalResult,
  type DesignAgentProviderRequest,
  type DesignAgentProviderResponse,
  type DesignAgentReplayExecution,
  type DesignAgentReplayExpectation,
  type DesignAgentReplayReceipt,
  type DesignAgentReplayReceiptStore,
  type DesignAgentRunInput,
  type DesignAgentStructuredProposal,
  type DesignAgentTrustAnchors,
  type DesignAgentTrustManifest,
  type DesignAgentUntrustedNarrative,
  type DesignAgentValidatorHandoff,
  type FrozenDesignAgentReplay,
  type JsonValue
} from "./contracts.js";
import {
  DESIGN_AGENT_PROPOSAL_KINDS_BY_ROLE,
  DESIGN_AGENT_ROLE_OBJECTIVES,
  DESIGN_AGENT_ROLES,
  DESIGN_AGENT_VALIDATOR_IDS_BY_ROLE,
  roleMatchesStage,
  type DesignAgentRole
} from "./roles.js";

export class DesignAgentCoordinatorError extends DomainError {
  public constructor(
    code: ConstructorParameters<typeof DomainError>[0],
    public readonly failureCode: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code, message, { failureCode, ...details }, false);
    this.name = "DesignAgentCoordinatorError";
  }
}

function reject(
  code: ConstructorParameters<typeof DomainError>[0],
  failureCode: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new DesignAgentCoordinatorError(code, failureCode, message, details);
}

interface GraphLimits {
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumStringBytes: number;
  readonly maximumAggregateStringBytes: number;
}

interface GraphState {
  nodes: number;
  stringBytes: number;
  readonly active: Set<object>;
}

const INPUT_GRAPH_LIMITS: GraphLimits = {
  maximumDepth: DESIGN_AGENT_LIMITS.inputGraphDepth,
  maximumNodes: DESIGN_AGENT_LIMITS.inputGraphNodes,
  maximumStringBytes: DESIGN_AGENT_LIMITS.inputStringBytes,
  maximumAggregateStringBytes: DESIGN_AGENT_LIMITS.inputStringBytes
};

const DOCUMENT_GRAPH_LIMITS: GraphLimits = {
  maximumDepth: DESIGN_AGENT_LIMITS.documentGraphDepth,
  maximumNodes: DESIGN_AGENT_LIMITS.documentGraphNodes,
  maximumStringBytes: DESIGN_AGENT_LIMITS.contextDocumentBytes,
  maximumAggregateStringBytes: DESIGN_AGENT_LIMITS.totalContextBytes
};

const REPLAY_GRAPH_LIMITS: GraphLimits = {
  maximumDepth: DESIGN_AGENT_LIMITS.replayGraphDepth,
  maximumNodes: DESIGN_AGENT_LIMITS.replayGraphNodes,
  maximumStringBytes: DESIGN_AGENT_LIMITS.replayStringBytes,
  maximumAggregateStringBytes: DESIGN_AGENT_LIMITS.replayStringBytes
};

function graphFailure(boundary: string, suffix: string, message: string): never {
  reject("INVALID_ARGUMENT", `AGENT_${boundary}_${suffix}`, message, { boundary });
}

const accountString = (
  value: string,
  boundary: string,
  limits: GraphLimits,
  state: GraphState
): string => {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > limits.maximumStringBytes) {
    graphFailure(boundary, "STRING_LIMIT_EXCEEDED", "A string exceeds the boundary byte limit");
  }
  state.stringBytes += bytes;
  if (state.stringBytes > limits.maximumAggregateStringBytes) {
    graphFailure(
      boundary,
      "AGGREGATE_BYTE_LIMIT_EXCEEDED",
      "Aggregate string bytes exceed the boundary limit"
    );
  }
  return value;
};

const arrayIndexFromKey = (key: string, length: number): number | undefined => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
    ? index
    : undefined;
};

const clonePlainGraph = <Value>(
  value: Value,
  boundary: string,
  limits: GraphLimits,
  depth = 0,
  state: GraphState = { nodes: 0, stringBytes: 0, active: new Set<object>() }
): Value => {
  if (depth > limits.maximumDepth) {
    graphFailure(boundary, "DEPTH_EXCEEDED", "The plain-data graph exceeds its depth limit");
  }
  state.nodes += 1;
  if (state.nodes > limits.maximumNodes) {
    graphFailure(boundary, "NODE_LIMIT_EXCEEDED", "The plain-data graph exceeds its node limit");
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return accountString(value, boundary, limits, state) as Value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      graphFailure(boundary, "NON_JSON_VALUE", "Plain data cannot contain a non-finite number");
    }
    return value;
  }

  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (nodeTypes.isProxy(value)) {
      graphFailure(boundary, "PROXY_FORBIDDEN", "Proxy values are forbidden at this boundary");
    }
  }
  if (typeof value !== "object" || value === null) {
    graphFailure(boundary, "NON_JSON_VALUE", "Only plain JSON data is accepted at this boundary");
  }

  const object = value as object;
  if (state.active.has(object)) {
    graphFailure(boundary, "CYCLE_FORBIDDEN", "Cycles are forbidden at this boundary");
  }
  state.active.add(object);
  try {
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      graphFailure(
        boundary,
        "PLAIN_DATA_REQUIRED",
        "Only objects with a plain object or array prototype are accepted"
      );
    }

    const keys = Reflect.ownKeys(object);
    if (keys.some((key) => typeof key === "symbol")) {
      graphFailure(boundary, "SYMBOL_KEY_FORBIDDEN", "Symbol keys are forbidden at this boundary");
    }

    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
        graphFailure(boundary, "ARRAY_INVALID", "Array length must be an own data property");
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > limits.maximumNodes) {
        graphFailure(boundary, "NODE_LIMIT_EXCEEDED", "Array length exceeds the boundary limit");
      }
      const result: unknown[] = new Array(length);
      let indexCount = 0;
      for (const rawKey of keys) {
        const key = rawKey as string;
        if (key === "length") continue;
        accountString(key, boundary, limits, state);
        const index = arrayIndexFromKey(key, length);
        if (index === undefined) {
          graphFailure(boundary, "ARRAY_INVALID", "Arrays cannot contain holes or custom properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          graphFailure(boundary, "ACCESSOR_FORBIDDEN", "Accessors are forbidden at this boundary");
        }
        if (!descriptor.enumerable) {
          graphFailure(
            boundary,
            "NON_ENUMERABLE_FORBIDDEN",
            "Non-enumerable data properties are forbidden at this boundary"
          );
        }
        result[index] = clonePlainGraph(
          descriptor.value,
          boundary,
          limits,
          depth + 1,
          state
        );
        indexCount += 1;
      }
      if (indexCount !== length) {
        graphFailure(boundary, "ARRAY_INVALID", "Sparse arrays are forbidden at this boundary");
      }
      return Object.freeze(result) as Value;
    }

    const result = Object.create(prototype === null ? null : Object.prototype) as Record<
      string,
      unknown
    >;
    for (const rawKey of keys) {
      const key = rawKey as string;
      accountString(key, boundary, limits, state);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        graphFailure(boundary, "ACCESSOR_FORBIDDEN", "Accessors are forbidden at this boundary");
      }
      if (!descriptor.enumerable) {
        graphFailure(
          boundary,
          "NON_ENUMERABLE_FORBIDDEN",
          "Non-enumerable data properties are forbidden at this boundary"
        );
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: clonePlainGraph(descriptor.value, boundary, limits, depth + 1, state),
        writable: true
      });
    }
    return Object.freeze(result) as Value;
  } finally {
    state.active.delete(object);
  }
};

const deepFreeze = <Value>(value: Value, seen = new Set<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  failureCode: string,
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    reject("INVALID_ARGUMENT", failureCode, `${label} contains missing or unknown fields`, {
      actual,
      expected: wanted
    });
  }
};

const boundedIdentifier = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u.test(value)
  ) {
    reject("INVALID_ARGUMENT", "AGENT_INPUT_INVALID", `${label} must be a bounded identifier`);
  }
  return value;
};

const boundedString = (value: unknown, label: string, maximumBytes: number): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    reject("INVALID_ARGUMENT", "AGENT_INPUT_INVALID", `${label} must be a non-empty bounded string`);
  }
  return value;
};

const CONTENT_IDENTITY_KEYS = ["algorithm", "digest", "size"] as const;
const CANONICAL_IDENTITY_KEYS = [
  "algorithm",
  "digest",
  "schemaVersion",
  "canonicalizationVersion"
] as const;

const assertContentIdentity = (value: unknown, label: string): ContentIdentity => {
  if (!isRecord(value)) {
    reject("INVALID_ARGUMENT", "AGENT_IDENTITY_INVALID", `${label} must be a content identity`);
  }
  exactKeys(value, CONTENT_IDENTITY_KEYS, "AGENT_IDENTITY_INVALID", label);
  if (
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    reject("INVALID_ARGUMENT", "AGENT_IDENTITY_INVALID", `${label} has invalid identity fields`);
  }
  return value as unknown as ContentIdentity;
};

const assertCanonicalIdentity = (
  value: unknown,
  label: string,
  expectedSchemaVersion?: string
): CanonicalIdentity => {
  if (!isRecord(value)) {
    reject("INVALID_ARGUMENT", "AGENT_IDENTITY_INVALID", `${label} must be a canonical identity`);
  }
  exactKeys(value, CANONICAL_IDENTITY_KEYS, "AGENT_IDENTITY_INVALID", label);
  if (
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.schemaVersion !== "string" ||
    value.schemaVersion.length === 0 ||
    value.canonicalizationVersion !== "evleda-c14n-json-v1" ||
    (expectedSchemaVersion !== undefined && value.schemaVersion !== expectedSchemaVersion)
  ) {
    reject("INVALID_ARGUMENT", "AGENT_IDENTITY_INVALID", `${label} has invalid identity fields`);
  }
  return value as unknown as CanonicalIdentity;
};

const identitiesEqual = (
  left: ContentIdentity | CanonicalIdentity,
  right: ContentIdentity | CanonicalIdentity
): boolean =>
  left.algorithm === right.algorithm &&
  constantTimeDigestEqual(left.digest, right.digest) &&
  canonicalJson(left) === canonicalJson(right);

const requireIdentity = (
  actual: ContentIdentity | CanonicalIdentity,
  expected: ContentIdentity | CanonicalIdentity,
  failureCode: string,
  message: string,
  code: ConstructorParameters<typeof DomainError>[0] = "DIGEST_MISMATCH"
): void => {
  if (!identitiesEqual(actual, expected)) reject(code, failureCode, message);
};

const freezeIdentity = <Identity extends ContentIdentity | CanonicalIdentity>(
  identity: Identity
): Identity => deepFreeze(identity);

export const bindAgentTextDocument = (
  logicalNameValue: unknown,
  contentValue: unknown
): BoundAgentTextDocument => {
  const logicalName = boundedString(logicalNameValue, "logicalName", 1_024);
  const content = boundedString(
    contentValue,
    "content",
    DESIGN_AGENT_LIMITS.contextDocumentBytes
  );
  return deepFreeze({
    kind: "text" as const,
    logicalName,
    content,
    identity: freezeIdentity(contentIdentity(content))
  });
};

export const bindAgentStructuredDocument = (
  logicalNameValue: unknown,
  schemaVersionValue: unknown,
  value: unknown
): BoundAgentStructuredDocument => {
  const logicalName = boundedString(logicalNameValue, "logicalName", 1_024);
  const schemaVersion = boundedIdentifier(schemaVersionValue, "schemaVersion");
  const snapshot = clonePlainGraph(value, "DOCUMENT", DOCUMENT_GRAPH_LIMITS) as JsonValue;
  const bytes = canonicalJson(snapshot);
  if (Buffer.byteLength(bytes, "utf8") > DESIGN_AGENT_LIMITS.contextDocumentBytes) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DOCUMENT_TOO_LARGE",
      "Structured document canonical bytes exceed the document limit"
    );
  }
  return deepFreeze({
    kind: "structured" as const,
    logicalName,
    schemaVersion,
    value: snapshot,
    identity: freezeIdentity(canonicalIdentity(snapshot, schemaVersion))
  });
};

export const bindDesignAgentModel = (value: unknown): BoundDesignAgentModel => {
  const snapshot = clonePlainGraph(value, "INPUT", INPUT_GRAPH_LIMITS);
  if (!isRecord(snapshot)) {
    reject("INVALID_ARGUMENT", "AGENT_MODEL_INVALID", "Model descriptor must be a plain object");
  }
  exactKeys(snapshot, ["provider", "model", "version"], "AGENT_MODEL_INVALID", "model");
  const payload = {
    provider: boundedIdentifier(snapshot.provider, "model.provider"),
    model: boundedIdentifier(snapshot.model, "model.model"),
    version: boundedIdentifier(snapshot.version, "model.version")
  };
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_MODEL_SCHEMA))
  });
};

export const bindDesignAgentSettings = (value: unknown): BoundDesignAgentSettings => {
  const snapshot = clonePlainGraph(value, "INPUT", INPUT_GRAPH_LIMITS) as JsonValue;
  const bytes = canonicalJson(snapshot);
  if (Buffer.byteLength(bytes, "utf8") > DESIGN_AGENT_LIMITS.settingsBytes) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_SETTINGS_TOO_LARGE",
      "Settings canonical bytes exceed the settings limit"
    );
  }
  return deepFreeze({
    value: snapshot,
    identity: freezeIdentity(canonicalIdentity(snapshot, DESIGN_AGENT_SETTINGS_SCHEMA))
  });
};

export const bindDesignAgentProvider = (value: unknown): BoundDesignAgentProvider => {
  const snapshot = clonePlainGraph(value, "INPUT", INPUT_GRAPH_LIMITS);
  if (!isRecord(snapshot)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_PROVIDER_INVALID",
      "Provider descriptor must be a plain object"
    );
  }
  exactKeys(
    snapshot,
    ["providerId", "implementationVersion"],
    "AGENT_PROVIDER_INVALID",
    "provider"
  );
  const payload = {
    providerId: boundedIdentifier(snapshot.providerId, "provider.providerId"),
    implementationVersion: boundedIdentifier(
      snapshot.implementationVersion,
      "provider.implementationVersion"
    )
  };
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_PROVIDER_SCHEMA))
  });
};

const uniqueIdentifiers = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value)) {
    reject("INVALID_ARGUMENT", "AGENT_REFERENCE_INDEX_INVALID", `${label} must be an array`);
  }
  const seen = new Set<string>();
  const result = value.map((entry, index) => {
    const identifier = boundedIdentifier(entry, `${label}[${index}]`);
    if (seen.has(identifier)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_REFERENCE_INDEX_INVALID",
        `${label} cannot contain duplicate identifiers`
      );
    }
    seen.add(identifier);
    return identifier;
  });
  return Object.freeze(result);
};

export const bindDesignAgentReferenceIndex = (
  value: unknown
): BoundDesignAgentReferenceIndex => {
  const snapshot = clonePlainGraph(value, "INPUT", INPUT_GRAPH_LIMITS);
  if (!isRecord(snapshot)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_REFERENCE_INDEX_INVALID",
      "Reference index input must be a plain object"
    );
  }
  exactKeys(
    snapshot,
    ["requirementIds", "targetIds"],
    "AGENT_REFERENCE_INDEX_INVALID",
    "referenceIndex"
  );
  const payload = {
    schemaVersion: DESIGN_AGENT_REFERENCE_INDEX_SCHEMA,
    logicalName: DESIGN_AGENT_REFERENCE_INDEX_LOGICAL_NAME,
    requirementIds: uniqueIdentifiers(snapshot.requirementIds, "referenceIndex.requirementIds"),
    targetIds: uniqueIdentifiers(snapshot.targetIds, "referenceIndex.targetIds")
  };
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_REFERENCE_INDEX_SCHEMA))
  });
};

const TRUST_MANIFEST_PAYLOAD_KEYS = [
  "manifestId",
  "instructions",
  "practiceCatalogs",
  "providers",
  "modelFamilies",
  "outputContracts"
] as const;

const boundedNonEmptyArray = (
  value: unknown,
  label: string,
  maximum = 64
): readonly unknown[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_MANIFEST_INVALID",
      `${label} must be a non-empty bounded array`
    );
  }
  return value;
};

const uniqueAnchor = (anchor: string, anchors: Set<string>, label: string): void => {
  if (anchors.has(anchor)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_MANIFEST_INVALID",
      `${label} contains a duplicate anchor`
    );
  }
  anchors.add(anchor);
};

const normalizeTrustManifestPayload = (
  value: unknown
): Omit<DesignAgentTrustManifest, "identity"> => {
  if (!isRecord(value)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_MANIFEST_INVALID",
      "Trust-manifest payload must be a plain object"
    );
  }
  exactKeys(
    value,
    TRUST_MANIFEST_PAYLOAD_KEYS,
    "AGENT_TRUST_MANIFEST_INVALID",
    "trustManifest"
  );
  const manifestId = boundedIdentifier(value.manifestId, "trustManifest.manifestId");

  const instructionAnchors = new Set<string>();
  const instructions = boundedNonEmptyArray(
    value.instructions,
    "trustManifest.instructions"
  ).map((entry, index) => {
    if (!isRecord(entry)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        `trustManifest.instructions[${index}] must be an object`
      );
    }
    exactKeys(
      entry,
      ["anchor", "logicalName", "identity"],
      "AGENT_TRUST_MANIFEST_INVALID",
      `trustManifest.instructions[${index}]`
    );
    const anchor = boundedIdentifier(entry.anchor, `trustManifest.instructions[${index}].anchor`);
    uniqueAnchor(anchor, instructionAnchors, "trustManifest.instructions");
    if (entry.logicalName !== DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        "Trust manifest pins an invalid instruction logical name"
      );
    }
    return deepFreeze({
      anchor,
      logicalName: DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
      identity: assertContentIdentity(
        entry.identity,
        `trustManifest.instructions[${index}].identity`
      )
    });
  });

  const catalogAnchors = new Set<string>();
  const practiceCatalogs = boundedNonEmptyArray(
    value.practiceCatalogs,
    "trustManifest.practiceCatalogs"
  ).map((entry, index) => {
    if (!isRecord(entry)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        `trustManifest.practiceCatalogs[${index}] must be an object`
      );
    }
    exactKeys(
      entry,
      ["anchor", "logicalName", "identity"],
      "AGENT_TRUST_MANIFEST_INVALID",
      `trustManifest.practiceCatalogs[${index}]`
    );
    const anchor = boundedIdentifier(
      entry.anchor,
      `trustManifest.practiceCatalogs[${index}].anchor`
    );
    uniqueAnchor(anchor, catalogAnchors, "trustManifest.practiceCatalogs");
    if (entry.logicalName !== DESIGN_AGENT_CATALOG_LOGICAL_NAME) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        "Trust manifest pins an invalid catalog logical name"
      );
    }
    return deepFreeze({
      anchor,
      logicalName: DESIGN_AGENT_CATALOG_LOGICAL_NAME,
      identity: assertCanonicalIdentity(
        entry.identity,
        `trustManifest.practiceCatalogs[${index}].identity`,
        PCB_ENGINEERING_PRACTICE_SCHEMA
      )
    });
  });

  const providerAnchors = new Set<string>();
  const providers = boundedNonEmptyArray(
    value.providers,
    "trustManifest.providers"
  ).map((entry, index) => {
    if (!isRecord(entry)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        `trustManifest.providers[${index}] must be an object`
      );
    }
    exactKeys(
      entry,
      ["anchor", "providerId", "identity"],
      "AGENT_TRUST_MANIFEST_INVALID",
      `trustManifest.providers[${index}]`
    );
    const anchor = boundedIdentifier(entry.anchor, `trustManifest.providers[${index}].anchor`);
    uniqueAnchor(anchor, providerAnchors, "trustManifest.providers");
    return deepFreeze({
      anchor,
      providerId: boundedIdentifier(
        entry.providerId,
        `trustManifest.providers[${index}].providerId`
      ),
      identity: assertCanonicalIdentity(
        entry.identity,
        `trustManifest.providers[${index}].identity`,
        DESIGN_AGENT_PROVIDER_SCHEMA
      )
    });
  });

  const familyAnchors = new Set<string>();
  const modelFamilies = boundedNonEmptyArray(
    value.modelFamilies,
    "trustManifest.modelFamilies"
  ).map((entry, index) => {
    if (!isRecord(entry)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        `trustManifest.modelFamilies[${index}] must be an object`
      );
    }
    exactKeys(
      entry,
      ["anchor", "providerAnchor", "family", "modelIds"],
      "AGENT_TRUST_MANIFEST_INVALID",
      `trustManifest.modelFamilies[${index}]`
    );
    const anchor = boundedIdentifier(
      entry.anchor,
      `trustManifest.modelFamilies[${index}].anchor`
    );
    uniqueAnchor(anchor, familyAnchors, "trustManifest.modelFamilies");
    const providerAnchor = boundedIdentifier(
      entry.providerAnchor,
      `trustManifest.modelFamilies[${index}].providerAnchor`
    );
    if (!providerAnchors.has(providerAnchor)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        "A model family references an unknown provider anchor"
      );
    }
    const modelIds = uniqueIdentifiers(
      entry.modelIds,
      `trustManifest.modelFamilies[${index}].modelIds`
    );
    if (modelIds.length === 0) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        "A model family must pin at least one exact model identifier"
      );
    }
    return deepFreeze({
      anchor,
      providerAnchor,
      family: boundedIdentifier(entry.family, `trustManifest.modelFamilies[${index}].family`),
      modelIds
    });
  });

  const outputAnchors = new Set<string>();
  const outputContracts = boundedNonEmptyArray(
    value.outputContracts,
    "trustManifest.outputContracts"
  ).map((entry, index) => {
    if (!isRecord(entry)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        `trustManifest.outputContracts[${index}] must be an object`
      );
    }
    exactKeys(
      entry,
      ["anchor", "logicalName", "bytesIdentity", "canonicalIdentity"],
      "AGENT_TRUST_MANIFEST_INVALID",
      `trustManifest.outputContracts[${index}]`
    );
    const anchor = boundedIdentifier(
      entry.anchor,
      `trustManifest.outputContracts[${index}].anchor`
    );
    uniqueAnchor(anchor, outputAnchors, "trustManifest.outputContracts");
    if (entry.logicalName !== DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_MANIFEST_INVALID",
        "Trust manifest pins an obsolete output-contract logical name"
      );
    }
    const bytesIdentity = assertContentIdentity(
      entry.bytesIdentity,
      `trustManifest.outputContracts[${index}].bytesIdentity`
    );
    const contractIdentity = assertCanonicalIdentity(
      entry.canonicalIdentity,
      `trustManifest.outputContracts[${index}].canonicalIdentity`,
      DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY.schemaVersion
    );
    requireIdentity(
      bytesIdentity,
      DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
      "AGENT_TRUST_MANIFEST_INVALID",
      "Trust manifest must pin the exact current output-contract bytes",
      "INVALID_ARGUMENT"
    );
    requireIdentity(
      contractIdentity,
      DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
      "AGENT_TRUST_MANIFEST_INVALID",
      "Trust manifest must pin the exact current output-contract identity",
      "INVALID_ARGUMENT"
    );
    return deepFreeze({
      anchor,
      logicalName: DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME,
      bytesIdentity,
      canonicalIdentity: contractIdentity
    });
  });

  return deepFreeze({
    schemaVersion: DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
    manifestId,
    instructions: Object.freeze(instructions),
    practiceCatalogs: Object.freeze(practiceCatalogs),
    providers: Object.freeze(providers),
    modelFamilies: Object.freeze(modelFamilies),
    outputContracts: Object.freeze(outputContracts)
  });
};

export const bindDesignAgentTrustManifest = (value: unknown): DesignAgentTrustManifest => {
  const snapshot = clonePlainGraph(value, "INPUT", INPUT_GRAPH_LIMITS);
  const payload = normalizeTrustManifestPayload(snapshot);
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_TRUST_MANIFEST_SCHEMA))
  });
};

const validateTrustManifest = (value: unknown): DesignAgentTrustManifest => {
  const snapshot = clonePlainGraph(value, "INPUT", INPUT_GRAPH_LIMITS);
  if (!isRecord(snapshot)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_MANIFEST_INVALID",
      "Trust manifest must be a bound plain object"
    );
  }
  exactKeys(
    snapshot,
    [...TRUST_MANIFEST_PAYLOAD_KEYS, "schemaVersion", "identity"],
    "AGENT_TRUST_MANIFEST_INVALID",
    "trustManifest"
  );
  if (snapshot.schemaVersion !== DESIGN_AGENT_TRUST_MANIFEST_SCHEMA) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_MANIFEST_INVALID",
      "Trust manifest has an unsupported schema version"
    );
  }
  const payloadInput = {
    manifestId: snapshot.manifestId,
    instructions: snapshot.instructions,
    practiceCatalogs: snapshot.practiceCatalogs,
    providers: snapshot.providers,
    modelFamilies: snapshot.modelFamilies,
    outputContracts: snapshot.outputContracts
  };
  const payload = normalizeTrustManifestPayload(payloadInput);
  const identity = assertCanonicalIdentity(
    snapshot.identity,
    "trustManifest.identity",
    DESIGN_AGENT_TRUST_MANIFEST_SCHEMA
  );
  requireIdentity(
    identity,
    canonicalIdentity(payload, DESIGN_AGENT_TRUST_MANIFEST_SCHEMA),
    "AGENT_TRUST_MANIFEST_INVALID",
    "Trust-manifest identity does not reproduce",
    "INVALID_ARGUMENT"
  );
  return deepFreeze({ ...payload, identity });
};

export const createInMemoryDesignAgentTrustStoreForTest = (
  manifestValues: readonly DesignAgentTrustManifest[]
): AgentTrustStorePort => {
  const snapshot = clonePlainGraph(manifestValues, "INPUT", INPUT_GRAPH_LIMITS);
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_STORE_INVALID",
      "The test/development trust store requires at least one bound manifest"
    );
  }
  const records = new Map<string, DesignAgentTrustManifest>();
  for (const value of snapshot) {
    const manifest = validateTrustManifest(value);
    if (records.has(manifest.manifestId)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_STORE_INVALID",
        "The test/development trust store cannot contain duplicate manifest IDs"
      );
    }
    records.set(manifest.manifestId, manifest);
  }
  const resolve = (manifestId: string): unknown => records.get(manifestId);
  return Object.freeze({
    authority: "in_memory_test_or_development_only" as const,
    resolve
  });
};

interface InspectedTrustStore {
  readonly authority: AgentTrustStorePort["authority"];
  readonly resolve: (manifestId: string) => unknown;
}

const inspectTrustStore = (storeValue: unknown): InspectedTrustStore => {
  if (
    storeValue === null ||
    typeof storeValue !== "object" ||
    nodeTypes.isProxy(storeValue) ||
    (Object.getPrototypeOf(storeValue) !== Object.prototype &&
      Object.getPrototypeOf(storeValue) !== null)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_STORE_INVALID",
      "Agent trust store must be a non-proxy plain object"
    );
  }
  const keys = Reflect.ownKeys(storeValue);
  if (
    keys.some((key) => typeof key === "symbol") ||
    canonicalJson((keys as string[]).sort()) !== canonicalJson(["authority", "resolve"])
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_STORE_INVALID",
      "Agent trust store contains missing or unknown fields"
    );
  }
  const authorityDescriptor = Object.getOwnPropertyDescriptor(storeValue, "authority");
  const resolveDescriptor = Object.getOwnPropertyDescriptor(storeValue, "resolve");
  for (const descriptor of [authorityDescriptor, resolveDescriptor]) {
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_STORE_INVALID",
        "Agent trust-store fields must be enumerable data properties"
      );
    }
  }
  const authority = authorityDescriptor!.value;
  const resolve = resolveDescriptor!.value;
  if (
    (authority !== "authenticated_production" &&
      authority !== "in_memory_test_or_development_only") ||
    typeof resolve !== "function" ||
    nodeTypes.isProxy(resolve)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_STORE_INVALID",
      "Agent trust-store authority or resolver is invalid"
    );
  }
  return {
    authority,
    resolve: (manifestId) => Reflect.apply(resolve, storeValue, [manifestId]) as unknown
  };
};

const validateTextDocument = (
  value: unknown,
  label: string,
  maximumContentBytes: number,
  expectedLogicalName?: string
): BoundAgentTextDocument => {
  if (!isRecord(value)) {
    reject("INVALID_ARGUMENT", "AGENT_DOCUMENT_INVALID", `${label} must be a text document`);
  }
  if (!hasOwn(value, "identity")) {
    reject(
      "INVALID_ARGUMENT",
      label === "instructionDocument"
        ? "AGENT_INSTRUCTION_IDENTITY_REQUIRED"
        : "AGENT_DOCUMENT_IDENTITY_REQUIRED",
      `${label} requires an exact content identity`
    );
  }
  exactKeys(
    value,
    ["kind", "logicalName", "content", "identity"],
    "AGENT_DOCUMENT_INVALID",
    label
  );
  if (value.kind !== "text") {
    reject("INVALID_ARGUMENT", "AGENT_DOCUMENT_INVALID", `${label}.kind must be text`);
  }
  const logicalName = boundedString(value.logicalName, `${label}.logicalName`, 1_024);
  if (expectedLogicalName !== undefined && logicalName !== expectedLogicalName) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DOCUMENT_LOGICAL_NAME_MISMATCH",
      `${label} has the wrong logical name`
    );
  }
  const content = boundedString(value.content, `${label}.content`, maximumContentBytes);
  const identity = assertContentIdentity(value.identity, `${label}.identity`);
  requireIdentity(
    identity,
    contentIdentity(content),
    label === "instructionDocument"
      ? "AGENT_INSTRUCTION_IDENTITY_MISMATCH"
      : "AGENT_DOCUMENT_IDENTITY_MISMATCH",
    `${label} identity does not reproduce its captured text bytes`,
    "INVALID_ARGUMENT"
  );
  return value as unknown as BoundAgentTextDocument;
};

const validateStructuredDocument = (
  value: unknown,
  label: string
): BoundAgentStructuredDocument => {
  if (!isRecord(value)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DOCUMENT_INVALID",
      `${label} must be a structured document`
    );
  }
  exactKeys(
    value,
    ["kind", "logicalName", "schemaVersion", "value", "identity"],
    "AGENT_DOCUMENT_INVALID",
    label
  );
  if (value.kind !== "structured") {
    reject("INVALID_ARGUMENT", "AGENT_DOCUMENT_INVALID", `${label}.kind must be structured`);
  }
  boundedString(value.logicalName, `${label}.logicalName`, 1_024);
  const schemaVersion = boundedIdentifier(value.schemaVersion, `${label}.schemaVersion`);
  const canonicalBytes = canonicalJson(value.value);
  if (Buffer.byteLength(canonicalBytes, "utf8") > DESIGN_AGENT_LIMITS.contextDocumentBytes) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DOCUMENT_TOO_LARGE",
      `${label} exceeds the structured-document byte limit`
    );
  }
  const identity = assertCanonicalIdentity(value.identity, `${label}.identity`, schemaVersion);
  requireIdentity(
    identity,
    canonicalIdentity(value.value, schemaVersion),
    "AGENT_DOCUMENT_IDENTITY_MISMATCH",
    `${label} identity does not reproduce its captured value`,
    "INVALID_ARGUMENT"
  );
  return value as unknown as BoundAgentStructuredDocument;
};

const validateModel = (value: unknown): BoundDesignAgentModel => {
  if (!isRecord(value)) {
    reject("INVALID_ARGUMENT", "AGENT_MODEL_INVALID", "model must be a bound model descriptor");
  }
  exactKeys(
    value,
    ["provider", "model", "version", "identity"],
    "AGENT_MODEL_INVALID",
    "model"
  );
  const payload = {
    provider: boundedIdentifier(value.provider, "model.provider"),
    model: boundedIdentifier(value.model, "model.model"),
    version: boundedIdentifier(value.version, "model.version")
  };
  const identity = assertCanonicalIdentity(value.identity, "model.identity", DESIGN_AGENT_MODEL_SCHEMA);
  requireIdentity(
    identity,
    canonicalIdentity(payload, DESIGN_AGENT_MODEL_SCHEMA),
    "AGENT_MODEL_IDENTITY_MISMATCH",
    "Model identity does not reproduce",
    "INVALID_ARGUMENT"
  );
  return value as unknown as BoundDesignAgentModel;
};

const validateSettings = (value: unknown): BoundDesignAgentSettings => {
  if (!isRecord(value)) {
    reject("INVALID_ARGUMENT", "AGENT_SETTINGS_INVALID", "settings must be a bound descriptor");
  }
  exactKeys(value, ["value", "identity"], "AGENT_SETTINGS_INVALID", "settings");
  const bytes = canonicalJson(value.value);
  if (Buffer.byteLength(bytes, "utf8") > DESIGN_AGENT_LIMITS.settingsBytes) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_SETTINGS_TOO_LARGE",
      "Settings canonical bytes exceed the settings limit"
    );
  }
  const identity = assertCanonicalIdentity(
    value.identity,
    "settings.identity",
    DESIGN_AGENT_SETTINGS_SCHEMA
  );
  requireIdentity(
    identity,
    canonicalIdentity(value.value, DESIGN_AGENT_SETTINGS_SCHEMA),
    "AGENT_SETTINGS_IDENTITY_MISMATCH",
    "Settings identity does not reproduce",
    "INVALID_ARGUMENT"
  );
  return value as unknown as BoundDesignAgentSettings;
};

const validateProvider = (value: unknown, label = "provider"): BoundDesignAgentProvider => {
  if (!isRecord(value)) {
    reject("INVALID_ARGUMENT", "AGENT_PROVIDER_INVALID", `${label} must be a bound provider`);
  }
  exactKeys(
    value,
    ["providerId", "implementationVersion", "identity"],
    "AGENT_PROVIDER_INVALID",
    label
  );
  const payload = {
    providerId: boundedIdentifier(value.providerId, `${label}.providerId`),
    implementationVersion: boundedIdentifier(
      value.implementationVersion,
      `${label}.implementationVersion`
    )
  };
  const identity = assertCanonicalIdentity(
    value.identity,
    `${label}.identity`,
    DESIGN_AGENT_PROVIDER_SCHEMA
  );
  requireIdentity(
    identity,
    canonicalIdentity(payload, DESIGN_AGENT_PROVIDER_SCHEMA),
    "AGENT_PROVIDER_IDENTITY_MISMATCH",
    `${label} identity does not reproduce`,
    "INVALID_ARGUMENT"
  );
  return value as unknown as BoundDesignAgentProvider;
};

const validateReferenceIndex = (value: unknown): BoundDesignAgentReferenceIndex => {
  if (!isRecord(value)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_REFERENCE_INDEX_INVALID",
      "referenceIndex must be a bound reference index"
    );
  }
  exactKeys(
    value,
    ["schemaVersion", "logicalName", "requirementIds", "targetIds", "identity"],
    "AGENT_REFERENCE_INDEX_INVALID",
    "referenceIndex"
  );
  if (
    value.schemaVersion !== DESIGN_AGENT_REFERENCE_INDEX_SCHEMA ||
    value.logicalName !== DESIGN_AGENT_REFERENCE_INDEX_LOGICAL_NAME
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_REFERENCE_INDEX_INVALID",
      "referenceIndex schema or logical name is invalid"
    );
  }
  const requirementIds = uniqueIdentifiers(
    value.requirementIds,
    "referenceIndex.requirementIds"
  );
  const targetIds = uniqueIdentifiers(value.targetIds, "referenceIndex.targetIds");
  const payload = {
    schemaVersion: DESIGN_AGENT_REFERENCE_INDEX_SCHEMA,
    logicalName: DESIGN_AGENT_REFERENCE_INDEX_LOGICAL_NAME,
    requirementIds,
    targetIds
  };
  const identity = assertCanonicalIdentity(
    value.identity,
    "referenceIndex.identity",
    DESIGN_AGENT_REFERENCE_INDEX_SCHEMA
  );
  requireIdentity(
    identity,
    canonicalIdentity(payload, DESIGN_AGENT_REFERENCE_INDEX_SCHEMA),
    "AGENT_REFERENCE_INDEX_IDENTITY_MISMATCH",
    "Reference-index identity does not reproduce",
    "INVALID_ARGUMENT"
  );
  return value as unknown as BoundDesignAgentReferenceIndex;
};

const RUN_INPUT_KEYS = [
  "stage",
  "role",
  "instructionDocument",
  "trustAnchors",
  "sourcePrompt",
  "practiceCatalogLogicalName",
  "practiceCatalog",
  "model",
  "settings",
  "referenceIndex",
  "context"
] as const;

const validateTrustAnchors = (value: unknown): DesignAgentTrustAnchors => {
  if (!isRecord(value)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_ANCHOR_INVALID",
      "Run input must reference constructor-pinned trust anchors"
    );
  }
  exactKeys(
    value,
    ["instruction", "practiceCatalog", "provider", "modelFamily", "outputContract"],
    "AGENT_TRUST_ANCHOR_INVALID",
    "trustAnchors"
  );
  return deepFreeze({
    instruction: boundedIdentifier(value.instruction, "trustAnchors.instruction"),
    practiceCatalog: boundedIdentifier(
      value.practiceCatalog,
      "trustAnchors.practiceCatalog"
    ),
    provider: boundedIdentifier(value.provider, "trustAnchors.provider"),
    modelFamily: boundedIdentifier(value.modelFamily, "trustAnchors.modelFamily"),
    outputContract: boundedIdentifier(
      value.outputContract,
      "trustAnchors.outputContract"
    )
  });
};

const snapshotRunInput = (input: unknown): DesignAgentRunInput => {
  const snapshot = clonePlainGraph(input, "INPUT", INPUT_GRAPH_LIMITS);
  if (!isRecord(snapshot)) {
    reject("INVALID_ARGUMENT", "AGENT_INPUT_INVALID", "Agent run input must be a plain object");
  }
  if (!hasOwn(snapshot, "trustAnchors")) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_ANCHOR_REQUIRED",
      "Constructor-pinned trust anchors are required"
    );
  }
  exactKeys(snapshot, RUN_INPUT_KEYS, "AGENT_INPUT_UNKNOWN_FIELD", "input");

  if (typeof snapshot.stage !== "string" || !STAGE_ORDER.includes(snapshot.stage as StageKey)) {
    reject("INVALID_ARGUMENT", "AGENT_STAGE_INVALID", "Agent stage is not in the closed stage set");
  }
  if (typeof snapshot.role !== "string" || !DESIGN_AGENT_ROLES.includes(snapshot.role as DesignAgentRole)) {
    reject("INVALID_ARGUMENT", "AGENT_ROLE_INVALID", "Agent role is not in the closed role set");
  }
  const stage = snapshot.stage as StageKey;
  const role = snapshot.role as DesignAgentRole;
  if (!roleMatchesStage(stage, role)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_STAGE_ROLE_MISMATCH",
      "The requested specialist role does not match the workflow stage"
    );
  }

  const instructionDocument = validateTextDocument(
    snapshot.instructionDocument,
    "instructionDocument",
    DESIGN_AGENT_LIMITS.instructionBytes,
    DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME
  );
  const trustAnchors = validateTrustAnchors(snapshot.trustAnchors);

  const sourcePrompt = validateTextDocument(
    snapshot.sourcePrompt,
    "sourcePrompt",
    DESIGN_AGENT_LIMITS.sourcePromptBytes
  );
  if (snapshot.practiceCatalogLogicalName !== DESIGN_AGENT_CATALOG_LOGICAL_NAME) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_CATALOG_LOGICAL_NAME_MISMATCH",
      "The practice catalog must use the closed logical name"
    );
  }

  let practiceCatalog: PcbEngineeringPracticeCatalog;
  try {
    practiceCatalog = validateAndSnapshotPcbEngineeringPracticeCatalog(snapshot.practiceCatalog);
  } catch {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_CATALOG_INVALID",
      "The practice catalog is not a valid closed catalog snapshot"
    );
  }
  const model = validateModel(snapshot.model);
  const settings = validateSettings(snapshot.settings);
  const referenceIndex = validateReferenceIndex(snapshot.referenceIndex);

  if (!Array.isArray(snapshot.context) || snapshot.context.length > DESIGN_AGENT_LIMITS.contextDocuments) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_CONTEXT_LIMIT_EXCEEDED",
      "Context must be an array within the document-count limit"
    );
  }
  let contextBytes = 0;
  const logicalNames = new Set<string>();
  const context = snapshot.context.map((entry, index): BoundAgentContextDocument => {
    if (!isRecord(entry)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DOCUMENT_INVALID",
        `context[${index}] must be a bound document`
      );
    }
    const document =
      entry.kind === "text"
        ? validateTextDocument(
            entry,
            `context[${index}]`,
            DESIGN_AGENT_LIMITS.contextDocumentBytes
          )
        : validateStructuredDocument(entry, `context[${index}]`);
    if (logicalNames.has(document.logicalName)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_CONTEXT_DUPLICATE_LOGICAL_NAME",
        "Context logical names must be unique"
      );
    }
    logicalNames.add(document.logicalName);
    contextBytes += Buffer.byteLength(
      document.kind === "text" ? document.content : canonicalJson(document.value),
      "utf8"
    );
    return document;
  });
  if (contextBytes > DESIGN_AGENT_LIMITS.totalContextBytes) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_CONTEXT_LIMIT_EXCEEDED",
      "Aggregate context bytes exceed the context limit"
    );
  }

  return deepFreeze({
    stage,
    role,
    instructionDocument,
    trustAnchors,
    sourcePrompt,
    practiceCatalogLogicalName: DESIGN_AGENT_CATALOG_LOGICAL_NAME,
    practiceCatalog,
    model,
    settings,
    referenceIndex,
    context
  });
};

interface ResolvedRunTrust {
  readonly instruction: DesignAgentTrustManifest["instructions"][number];
  readonly practiceCatalog: DesignAgentTrustManifest["practiceCatalogs"][number];
  readonly provider: DesignAgentTrustManifest["providers"][number];
  readonly modelFamily: DesignAgentTrustManifest["modelFamilies"][number];
  readonly outputContract: DesignAgentTrustManifest["outputContracts"][number];
}

const resolveRunTrust = (
  manifest: DesignAgentTrustManifest,
  input: DesignAgentRunInput
): ResolvedRunTrust => {
  const instruction = manifest.instructions.find(
    (entry) => entry.anchor === input.trustAnchors.instruction
  );
  const practiceCatalog = manifest.practiceCatalogs.find(
    (entry) => entry.anchor === input.trustAnchors.practiceCatalog
  );
  const provider = manifest.providers.find(
    (entry) => entry.anchor === input.trustAnchors.provider
  );
  const modelFamily = manifest.modelFamilies.find(
    (entry) => entry.anchor === input.trustAnchors.modelFamily
  );
  const outputContract = manifest.outputContracts.find(
    (entry) => entry.anchor === input.trustAnchors.outputContract
  );
  if (
    instruction === undefined ||
    practiceCatalog === undefined ||
    provider === undefined ||
    modelFamily === undefined ||
    outputContract === undefined
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_TRUST_ANCHOR_NOT_FOUND",
      "A run input references an anchor absent from the constructor-pinned trust manifest"
    );
  }
  requireIdentity(
    input.instructionDocument.identity,
    instruction.identity,
    "AGENT_INSTRUCTION_IDENTITY_MISMATCH",
    "Instruction bytes do not match the constructor-pinned trust root",
    "INVALID_ARGUMENT"
  );
  requireIdentity(
    input.practiceCatalog.identity,
    practiceCatalog.identity,
    "AGENT_CATALOG_IDENTITY_MISMATCH",
    "Practice catalog does not match the constructor-pinned trust root",
    "INVALID_ARGUMENT"
  );
  if (
    provider.providerId !== input.model.provider ||
    modelFamily.providerAnchor !== provider.anchor ||
    !modelFamily.modelIds.includes(input.model.model)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_MODEL_FAMILY_NOT_ALLOWED",
      "Model/provider selection is outside the constructor-pinned model family"
    );
  }
  requireIdentity(
    outputContract.bytesIdentity,
    DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
    "AGENT_OUTPUT_CONTRACT_MISMATCH",
    "Trust anchor does not resolve to the exact current output-contract bytes",
    "INVALID_ARGUMENT"
  );
  requireIdentity(
    outputContract.canonicalIdentity,
    DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
    "AGENT_OUTPUT_CONTRACT_MISMATCH",
    "Trust anchor does not resolve to the exact current output-contract identity",
    "INVALID_ARGUMENT"
  );
  return { instruction, practiceCatalog, provider, modelFamily, outputContract };
};

export const buildDesignAgentPromptPack = (
  input: unknown,
  trustManifestValue: unknown
): DesignAgentPromptPack => {
  const snapshot = snapshotRunInput(input);
  const trustManifest = validateTrustManifest(trustManifestValue);
  const trust = resolveRunTrust(trustManifest, snapshot);
  const outputContract = deepFreeze({
    logicalName: DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME,
    mediaType: "application/schema+json" as const,
    content: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES,
    identity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
    canonicalIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
  });
  const exactInputs = Object.freeze([
    snapshot.instructionDocument.identity,
    snapshot.sourcePrompt.identity,
    snapshot.practiceCatalog.identity,
    snapshot.model.identity,
    snapshot.settings.identity,
    snapshot.referenceIndex.identity,
    trustManifest.identity,
    trust.provider.identity,
    outputContract.identity,
    outputContract.canonicalIdentity,
    ...snapshot.context.map((entry) => entry.identity)
  ]);
  const payload = {
    schemaVersion: DESIGN_AGENT_PROMPT_PACK_SCHEMA,
    stage: snapshot.stage,
    role: snapshot.role,
    roleObjective: DESIGN_AGENT_ROLE_OBJECTIVES[snapshot.role],
    instructionDocument: snapshot.instructionDocument,
    trustManifestIdentity: trustManifest.identity,
    trustAnchors: snapshot.trustAnchors,
    sourcePrompt: snapshot.sourcePrompt,
    practiceCatalogLogicalName: snapshot.practiceCatalogLogicalName,
    practiceCatalog: snapshot.practiceCatalog,
    model: snapshot.model,
    settings: snapshot.settings,
    referenceIndex: snapshot.referenceIndex,
    context: snapshot.context,
    outputContract,
    exactInputs
  };
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_PROMPT_PACK_SCHEMA))
  });
};

class StrictJsonParser {
  readonly #text: string;
  #index = 0;
  #entries = 0;

  public constructor(text: string) {
    this.#text = text;
  }

  public parse(): unknown {
    this.#skipWhitespace();
    const result = this.#parseValue(1);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) this.#malformed();
    return result;
  }

  #malformed(message = "Provider output is not strict JSON"): never {
    reject("TOOL_RESULT_INCONCLUSIVE", "AGENT_OUTPUT_MALFORMED", message);
  }

  #limit(failureCode: string, message: string): never {
    reject("TOOL_RESULT_INCONCLUSIVE", failureCode, message);
  }

  #skipWhitespace(): void {
    while (this.#index < this.#text.length && /[\u0009\u000a\u000d\u0020]/u.test(this.#text[this.#index]!)) {
      this.#index += 1;
    }
  }

  #parseValue(depth: number): unknown {
    if (depth > DESIGN_AGENT_LIMITS.outputJsonDepth) {
      this.#limit("AGENT_OUTPUT_DEPTH_EXCEEDED", "Provider JSON exceeds the nesting-depth limit");
    }
    const character = this.#text[this.#index];
    if (character === '"') return this.#parseString();
    if (character === "{") return this.#parseObject(depth);
    if (character === "[") return this.#parseArray(depth);
    if (character === "t" && this.#consumeLiteral("true")) return true;
    if (character === "f" && this.#consumeLiteral("false")) return false;
    if (character === "n" && this.#consumeLiteral("null")) return null;
    if (character === "-" || (character !== undefined && /[0-9]/u.test(character))) {
      return this.#parseNumber();
    }
    return this.#malformed();
  }

  #consumeLiteral(literal: string): boolean {
    if (!this.#text.startsWith(literal, this.#index)) return false;
    this.#index += literal.length;
    return true;
  }

  #parseString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const character = this.#text[this.#index]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.#text.slice(start, this.#index)) as string;
        } catch {
          return this.#malformed();
        }
      }
      if (code < 0x20) return this.#malformed();
      if (character === "\\") {
        this.#index += 1;
        const escape = this.#text[this.#index];
        if (escape === undefined || !/["\\/bfnrtu]/u.test(escape)) return this.#malformed();
        if (escape === "u") {
          const digits = this.#text.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) return this.#malformed();
          this.#index += 4;
        }
      }
      this.#index += 1;
    }
    return this.#malformed();
  }

  #parseNumber(): number {
    const remainder = this.#text.slice(this.#index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remainder);
    if (match === null) return this.#malformed();
    this.#index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) {
      this.#limit("AGENT_OUTPUT_NUMBER_INVALID", "Provider JSON contains a non-finite number");
    }
    return number;
  }

  #entry(): void {
    this.#entries += 1;
    if (this.#entries > DESIGN_AGENT_LIMITS.outputJsonEntries) {
      this.#limit("AGENT_OUTPUT_ENTRY_LIMIT_EXCEEDED", "Provider JSON exceeds the entry limit");
    }
  }

  #parseArray(depth: number): readonly unknown[] {
    this.#index += 1;
    this.#skipWhitespace();
    const result: unknown[] = [];
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      this.#entry();
      result.push(this.#parseValue(depth + 1));
      this.#skipWhitespace();
      const separator = this.#text[this.#index];
      this.#index += 1;
      if (separator === "]") return result;
      if (separator !== ",") return this.#malformed();
      this.#skipWhitespace();
    }
  }

  #parseObject(depth: number): Readonly<Record<string, unknown>> {
    this.#index += 1;
    this.#skipWhitespace();
    const result = Object.create(null) as Record<string, unknown>;
    const members = new Set<string>();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      if (this.#text[this.#index] !== '"') return this.#malformed();
      const key = this.#parseString();
      if (members.has(key)) {
        reject(
          "TOOL_RESULT_INCONCLUSIVE",
          "AGENT_OUTPUT_DUPLICATE_MEMBER",
          "Provider JSON contains a duplicate object member"
        );
      }
      members.add(key);
      this.#entry();
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ":") return this.#malformed();
      this.#index += 1;
      this.#skipWhitespace();
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: this.#parseValue(depth + 1),
        writable: true
      });
      this.#skipWhitespace();
      const separator = this.#text[this.#index];
      this.#index += 1;
      if (separator === "}") return result;
      if (separator !== ",") return this.#malformed();
      this.#skipWhitespace();
    }
  }
}

const AUTHORITY_ADJACENT_ALLOWED_KEYS = new Set([
  "authorityDisposition",
  "classification",
  "outcomeClaim",
  "validatorId",
  "validatorRequests",
  "validatorRequestDetails"
]);
const AUTHORITY_FIELD_PATTERN =
  /pass|validat|verif|approv|qualif|releas|authoriz|certif|compli|safe|evidence|lifecycle|manufactur/iu;

const normalizedWords = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .toLowerCase()
    .replace(/[_\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const AUTHORITY_TERMS_NORMALIZED = DESIGN_AGENT_FORBIDDEN_AUTHORITY_TERMS.map(normalizedWords);

const AUTHORITY_ASSERTION_PATTERNS = Object.freeze([
  /\bpass(?:es|ed|ing)?\b/u,
  /\bsucceed(?:s|ed|ing)?\b|\bsuccess(?:ful|fully)?\b/u,
  /\bvalidat(?:e|es|ed|ing|ion)\b|\bverif(?:y|ies|ied|ying|ication)\b/u,
  /\bapprov(?:e|es|ed|ing|al)\b|\bwaiv(?:e|es|ed|ing|er)\b/u,
  /\bqualif(?:y|ies|ied|ying|ication)\b|\bcertif(?:y|ies|ied|ying|ication)\b/u,
  /\bauthoriz(?:e|es|ed|ing|ation)\b|\breleas(?:e|es|ed|ing|able)\b/u,
  /\bready\b/u,
  /\b(?:may|can|ready to|cleared to)\s+ship\b|\bship(?:s|ped|ping|ment)?\b/u,
  /\bproduction\b|\bmanufacturable\b/u,
  /\b(?:ready|suitable|fit|cleared)\b(?:\s+\w+){0,5}\s+\b(?:fab|fabrication|manufacture|manufacturing|production)\b/u,
  /\b(?:fab|fabrication|manufacture|manufacturing|production)\b(?:\s+\w+){0,5}\s+\bready\b/u,
  /\bconform(?:s|ed|ing|ance)?\b|\bcompli(?:es|ed|ant|ance)\b/u,
  /\b(?:meet|meets|met|satisfy|satisfies|satisfied)\b(?:\s+\w+){0,8}\s+\b(?:all|every)\s+requirements?\b/u,
  /\b(?:drc|erc)\b(?:\s+\w+){0,6}\s+\b(?:clean|pass(?:es|ed)?|success(?:ful)?|zero)\b/u,
  /\b(?:safe|safety certified)\b/u
] as const);

const AUTHORITY_COMPACT_PATTERNS = Object.freeze([
  /(?:drc|erc)(?:passes|passed|clean|success)/u,
  /readyfor(?:fab|fabrication|manufacture|manufacturing|production)/u,
  /(?:fab|fabrication|manufacture|manufacturing|production)ready/u,
  /conformstoeveryrequirements?/u,
  /mayship/u,
  /approvalgranted|waiveraccepted|validatedforproduction/u
] as const);

const containsAuthorityTerm = (value: string): boolean => {
  const words = normalizedWords(value);
  const normalized = ` ${words} `;
  const compact = words.replace(/\s+/gu, "");
  return (
    AUTHORITY_TERMS_NORMALIZED.some((term) => normalized.includes(` ${term} `)) ||
    AUTHORITY_ASSERTION_PATTERNS.some((pattern) => pattern.test(words)) ||
    AUTHORITY_COMPACT_PATTERNS.some((pattern) => pattern.test(compact))
  );
};

const assertNoModelAuthority = (value: unknown): void => {
  if (typeof value === "string") {
    if (containsAuthorityTerm(value)) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_AUTHORITY_LANGUAGE_FORBIDDEN",
        "Model output contains forbidden pass, evidence, qualification, or release language"
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoModelAuthority(entry);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (!AUTHORITY_ADJACENT_ALLOWED_KEYS.has(key) && AUTHORITY_FIELD_PATTERN.test(key)) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_AUTHORITY_FIELD_FORBIDDEN",
        "Model output contains a forbidden authority field"
      );
    }
    assertNoModelAuthority(entry);
  }
};

const assertUniqueReferences = (
  values: readonly string[],
  allowed: ReadonlySet<string>,
  failureCode: string,
  label: string
): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value) || !allowed.has(value)) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        failureCode,
        `${label} contains a duplicate or unresolved reference`
      );
    }
    seen.add(value);
  }
};

const parseProposal = (rawOutput: string, promptPack: DesignAgentPromptPack): DesignAgentProposal => {
  if (Buffer.byteLength(rawOutput, "utf8") > DESIGN_AGENT_LIMITS.providerOutputBytes) {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_OUTPUT_TOO_LARGE",
      "Provider output exceeds the exact byte limit"
    );
  }
  const parsed = new StrictJsonParser(rawOutput).parse();
  assertNoModelAuthority(parsed);
  const validated = validateDesignAgentProposal(parsed);
  if (!validated.success) {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_OUTPUT_SCHEMA_INVALID",
      "Provider output does not satisfy the closed proposal schema",
      {
        issues: validated.issues
      }
    );
  }
  const proposal = validated.data;
  const structured = proposal.structuredProposal;
  if (structured.stage !== promptPack.stage || structured.role !== promptPack.role) {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_STAGE_ROLE_MISMATCH",
      "Provider proposal stage and role must match the prompt pack"
    );
  }

  const requirementIds = new Set(promptPack.referenceIndex.requirementIds);
  const targetIds = new Set(promptPack.referenceIndex.targetIds);
  const practiceIds = new Set(promptPack.practiceCatalog.rules.map((rule) => rule.id));
  const proposalIds = new Set<string>();
  const structuredProposalIds = new Set<string>();
  const assumptionIds = new Set<string>();
  const questionIds = new Set<string>();
  const recordId = (id: string): void => {
    if (proposalIds.has(id)) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_OUTPUT_DUPLICATE_ID",
        "Proposal, assumption, and question identifiers must be globally unique"
      );
    }
    proposalIds.add(id);
  };

  const allowedKinds = DESIGN_AGENT_PROPOSAL_KINDS_BY_ROLE[promptPack.role] as readonly string[];
  for (const item of structured.proposals) {
    recordId(item.id);
    structuredProposalIds.add(item.id);
    if (!allowedKinds.includes(item.kind)) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_PROPOSAL_KIND_FORBIDDEN",
        "Proposal kind is not allowed for this specialist role"
      );
    }
    assertUniqueReferences(
      item.targetIds,
      targetIds,
      "AGENT_TARGET_REFERENCE_INVALID",
      "proposal.targetIds"
    );
    assertUniqueReferences(
      item.sourceRequirementIds,
      requirementIds,
      "AGENT_REQUIREMENT_REFERENCE_INVALID",
      "proposal.sourceRequirementIds"
    );
    assertUniqueReferences(
      item.practiceIds,
      practiceIds,
      "AGENT_PRACTICE_REFERENCE_INVALID",
      "proposal.practiceIds"
    );
  }
  for (const assumption of structured.assumptions) {
    recordId(assumption.id);
    assumptionIds.add(assumption.id);
    assertUniqueReferences(
      assumption.sourceRequirementIds,
      requirementIds,
      "AGENT_REQUIREMENT_REFERENCE_INVALID",
      "assumption.sourceRequirementIds"
    );
  }
  for (const question of structured.questions) {
    recordId(question.id);
    questionIds.add(question.id);
    assertUniqueReferences(
      question.sourceRequirementIds,
      requirementIds,
      "AGENT_REQUIREMENT_REFERENCE_INVALID",
      "question.sourceRequirementIds"
    );
  }
  const allowedValidators = new Set<string>(
    DESIGN_AGENT_VALIDATOR_IDS_BY_ROLE[promptPack.role] as readonly string[]
  );
  const requestedValidators = new Set<string>();
  for (const request of structured.validatorRequests) {
    if (!allowedValidators.has(request.validatorId) || requestedValidators.has(request.validatorId)) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_VALIDATOR_NOT_ALLOWED",
        "Validator requests must be unique members of the role allowlist"
      );
    }
    requestedValidators.add(request.validatorId);
    assertUniqueReferences(
      request.targetIds,
      targetIds,
      "AGENT_TARGET_REFERENCE_INVALID",
      "validatorRequest.targetIds"
    );
  }

  const requireExactNarrativeReferences = (
    actualValues: readonly string[],
    expectedValues: ReadonlySet<string>,
    label: string
  ): void => {
    const actual = new Set(actualValues);
    if (
      actual.size !== actualValues.length ||
      actual.size !== expectedValues.size ||
      [...expectedValues].some((identifier) => !actual.has(identifier))
    ) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_UNTRUSTED_NARRATIVE_BINDING_INVALID",
        `${label} must bind one-to-one to closed structured identifiers`
      );
    }
  };
  requireExactNarrativeReferences(
    proposal.untrustedNarrative.proposalDetails.map((entry) => entry.proposalId),
    structuredProposalIds,
    "untrustedNarrative.proposalDetails"
  );
  requireExactNarrativeReferences(
    proposal.untrustedNarrative.assumptionDetails.map((entry) => entry.assumptionId),
    assumptionIds,
    "untrustedNarrative.assumptionDetails"
  );
  requireExactNarrativeReferences(
    proposal.untrustedNarrative.questionDetails.map((entry) => entry.questionId),
    questionIds,
    "untrustedNarrative.questionDetails"
  );
  requireExactNarrativeReferences(
    proposal.untrustedNarrative.validatorRequestDetails.map((entry) => entry.validatorId),
    requestedValidators,
    "untrustedNarrative.validatorRequestDetails"
  );
  return deepFreeze(proposal);
};

const buildProviderRequest = (
  provider: BoundDesignAgentProvider,
  promptPack: DesignAgentPromptPack
): DesignAgentProviderRequest => {
  const payload = {
    schemaVersion: DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
    provider,
    promptPack
  };
  return deepFreeze({
    schemaVersion: payload.schemaVersion,
    requestIdentity: freezeIdentity(
      canonicalIdentity(payload, DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA)
    ),
    provider,
    promptPack
  });
};

const PROVIDER_RESPONSE_KEYS = [
  "schemaVersion",
  "requestIdentity",
  "promptPackIdentity",
  "providerIdentity",
  "modelIdentity",
  "settingsIdentity",
  "outputContractIdentity",
  "outputContractBytesIdentity",
  "stage",
  "role",
  "rawOutput"
] as const;

const validateProviderResponse = (
  value: unknown,
  request: DesignAgentProviderRequest
): DesignAgentProviderResponse => {
  let snapshot: unknown;
  try {
    snapshot = clonePlainGraph(value, "PROVIDER_RESPONSE", INPUT_GRAPH_LIMITS);
  } catch (error) {
    if (
      error instanceof DesignAgentCoordinatorError &&
      error.failureCode.startsWith("AGENT_PROVIDER_RESPONSE_")
    ) {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        error.failureCode,
        "Provider response violated the plain-data boundary"
      );
    }
    throw error;
  }
  if (!isRecord(snapshot)) {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_PROVIDER_RESPONSE_INVALID",
      "Provider response must be a plain object"
    );
  }
  exactKeys(
    snapshot,
    PROVIDER_RESPONSE_KEYS,
    "AGENT_PROVIDER_RESPONSE_INVALID",
    "providerResponse"
  );
  if (snapshot.schemaVersion !== DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA) {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_PROVIDER_RESPONSE_INVALID",
      "Provider response schema version is invalid"
    );
  }
  if (snapshot.stage !== request.promptPack.stage || snapshot.role !== request.promptPack.role) {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_STAGE_ROLE_MISMATCH",
      "Provider response stage and role must match the request"
    );
  }
  if (typeof snapshot.rawOutput !== "string") {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_PROVIDER_RESPONSE_INVALID",
      "Provider raw output must be a string"
    );
  }
  if (Buffer.byteLength(snapshot.rawOutput, "utf8") > DESIGN_AGENT_LIMITS.providerOutputBytes) {
    reject(
      "TOOL_RESULT_INCONCLUSIVE",
      "AGENT_OUTPUT_TOO_LARGE",
      "Provider output exceeds the exact byte limit"
    );
  }

  const comparisons: readonly [unknown, ContentIdentity | CanonicalIdentity, string][] = [
    [snapshot.requestIdentity, request.requestIdentity, "requestIdentity"],
    [snapshot.promptPackIdentity, request.promptPack.identity, "promptPackIdentity"],
    [snapshot.providerIdentity, request.provider.identity, "providerIdentity"],
    [snapshot.modelIdentity, request.promptPack.model.identity, "modelIdentity"],
    [snapshot.settingsIdentity, request.promptPack.settings.identity, "settingsIdentity"],
    [
      snapshot.outputContractIdentity,
      request.promptPack.outputContract.canonicalIdentity,
      "outputContractIdentity"
    ],
    [
      snapshot.outputContractBytesIdentity,
      request.promptPack.outputContract.identity,
      "outputContractBytesIdentity"
    ]
  ];
  for (const [actualValue, expected, label] of comparisons) {
    const actual = hasOwn(expected, "size")
      ? assertContentIdentity(actualValue, `providerResponse.${label}`)
      : assertCanonicalIdentity(
          actualValue,
          `providerResponse.${label}`,
          (expected as CanonicalIdentity).schemaVersion
        );
    requireIdentity(
      actual,
      expected,
      "AGENT_PROVIDER_RESPONSE_MISMATCH",
      `Provider response ${label} does not match its request`,
      "TOOL_RESULT_INCONCLUSIVE"
    );
  }
  return snapshot as unknown as DesignAgentProviderResponse;
};

const buildProposalResult = (
  request: DesignAgentProviderRequest,
  response: DesignAgentProviderResponse,
  proposal: DesignAgentProposal
): DesignAgentProposalResult => {
  const structuredProposal = deepFreeze(
    proposal.structuredProposal as DesignAgentStructuredProposal
  );
  const structuredProposalIdentity = freezeIdentity(
    canonicalIdentity(structuredProposal, DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA)
  );
  const capturedUntrustedNarrative = deepFreeze(
    proposal.untrustedNarrative as DesignAgentUntrustedNarrative
  );
  const untrustedNarrativeIdentity = freezeIdentity(
    canonicalIdentity(
      capturedUntrustedNarrative,
      DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA
    )
  );
  const validatorHandoff: DesignAgentValidatorHandoff = deepFreeze({
    required: true as const,
    state: "pending" as const,
    authority: "deterministic_validators_and_native_tools_only" as const,
    requestedValidators: structuredProposal.validatorRequests,
    exactInputs: Object.freeze([
      request.promptPack.identity,
      request.promptPack.trustManifestIdentity,
      request.provider.identity,
      request.promptPack.practiceCatalog.identity,
      request.promptPack.model.identity,
      request.promptPack.settings.identity,
      request.promptPack.referenceIndex.identity,
      request.promptPack.outputContract.canonicalIdentity,
      structuredProposalIdentity
    ])
  });
  const payload = {
    schemaVersion: DESIGN_AGENT_RESULT_SCHEMA,
    stage: request.promptPack.stage,
    role: request.promptPack.role,
    classification: "proposal_only" as const,
    evidenceClass: "agent_claim" as const,
    validationDisposition: "not_evaluated" as const,
    promptPackIdentity: request.promptPack.identity,
    requestIdentity: request.requestIdentity,
    instructionIdentity: request.promptPack.instructionDocument.identity,
    trustManifestIdentity: request.promptPack.trustManifestIdentity,
    trustAnchors: request.promptPack.trustAnchors,
    sourcePromptIdentity: request.promptPack.sourcePrompt.identity,
    practiceCatalogIdentity: request.promptPack.practiceCatalog.identity,
    providerIdentity: request.provider.identity,
    modelIdentity: request.promptPack.model.identity,
    settingsIdentity: request.promptPack.settings.identity,
    referenceIndexIdentity: request.promptPack.referenceIndex.identity,
    outputContractIdentity: request.promptPack.outputContract.canonicalIdentity,
    outputContractBytesIdentity: request.promptPack.outputContract.identity,
    contextInputIdentities: Object.freeze(
      request.promptPack.context.map((entry) => entry.identity)
    ),
    rawOutputIdentity: freezeIdentity(contentIdentity(response.rawOutput)),
    structuredProposal,
    structuredProposalIdentity,
    untrustedNarrative: capturedUntrustedNarrative,
    untrustedNarrativeIdentity,
    validatorHandoff,
    regenerationPolicy: DESIGN_AGENT_LIVE_REGENERATION_POLICY,
    regenerationPolicyIdentity: DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY
  };
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_RESULT_SCHEMA))
  });
};

const buildReplay = (
  request: DesignAgentProviderRequest,
  response: DesignAgentProviderResponse,
  result: DesignAgentProposalResult
): FrozenDesignAgentReplay => {
  const payload = {
    schemaVersion: DESIGN_AGENT_REPLAY_SCHEMA,
    request,
    response,
    result
  };
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_REPLAY_SCHEMA))
  });
};

const buildReplayReceipt = (replay: FrozenDesignAgentReplay): DesignAgentReplayReceipt => {
  const payload = {
    schemaVersion: DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
    receiptId: `replay_${replay.identity.digest}`,
    replayIdentity: replay.identity,
    trustManifestIdentity: replay.result.trustManifestIdentity,
    providerIdentity: replay.result.providerIdentity,
    promptPackIdentity: replay.result.promptPackIdentity
  };
  return deepFreeze({
    ...payload,
    identity: freezeIdentity(canonicalIdentity(payload, DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA))
  });
};

const validateReplayReceipt = (
  value: unknown,
  expectedReceiptId?: string
): DesignAgentReplayReceipt => {
  const snapshot = clonePlainGraph(value, "REPLAY_RECEIPT", INPUT_GRAPH_LIMITS);
  if (!isRecord(snapshot)) {
    reject(
      "DIGEST_MISMATCH",
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt resolver returned no valid receipt"
    );
  }
  exactKeys(
    snapshot,
    [
      "schemaVersion",
      "receiptId",
      "replayIdentity",
      "trustManifestIdentity",
      "providerIdentity",
      "promptPackIdentity",
      "identity"
    ],
    "AGENT_REPLAY_RECEIPT_INVALID",
    "replayReceipt"
  );
  if (snapshot.schemaVersion !== DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA) {
    reject(
      "DIGEST_MISMATCH",
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt has an unsupported schema version"
    );
  }
  const receiptId = boundedIdentifier(snapshot.receiptId, "replayReceipt.receiptId");
  if (expectedReceiptId !== undefined && receiptId !== expectedReceiptId) {
    reject(
      "DIGEST_MISMATCH",
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay resolver returned a different receipt ID"
    );
  }
  const payload = {
    schemaVersion: DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
    receiptId,
    replayIdentity: assertCanonicalIdentity(
      snapshot.replayIdentity,
      "replayReceipt.replayIdentity",
      DESIGN_AGENT_REPLAY_SCHEMA
    ),
    trustManifestIdentity: assertCanonicalIdentity(
      snapshot.trustManifestIdentity,
      "replayReceipt.trustManifestIdentity",
      DESIGN_AGENT_TRUST_MANIFEST_SCHEMA
    ),
    providerIdentity: assertCanonicalIdentity(
      snapshot.providerIdentity,
      "replayReceipt.providerIdentity",
      DESIGN_AGENT_PROVIDER_SCHEMA
    ),
    promptPackIdentity: assertCanonicalIdentity(
      snapshot.promptPackIdentity,
      "replayReceipt.promptPackIdentity",
      DESIGN_AGENT_PROMPT_PACK_SCHEMA
    )
  };
  const identity = assertCanonicalIdentity(
    snapshot.identity,
    "replayReceipt.identity",
    DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA
  );
  requireIdentity(
    identity,
    canonicalIdentity(payload, DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA),
    "AGENT_REPLAY_RECEIPT_INVALID",
    "Replay receipt identity does not reproduce"
  );
  return deepFreeze({ ...payload, identity });
};

export const createInMemoryDesignAgentReplayReceiptStoreForTest =
  (): DesignAgentReplayReceiptStore => {
    const records = new Map<string, DesignAgentReplayReceipt>();
    const append = async (receiptValue: DesignAgentReplayReceipt): Promise<void> => {
      const receipt = validateReplayReceipt(receiptValue);
      const existing = records.get(receipt.receiptId);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(receipt)) {
        reject(
          "DIGEST_MISMATCH",
          "AGENT_REPLAY_RECEIPT_CONFLICT",
          "Append-only replay receipt ID already binds different content"
        );
      }
      if (existing === undefined) records.set(receipt.receiptId, receipt);
    };
    const resolve = async (receiptId: string): Promise<unknown> => records.get(receiptId);
    return Object.freeze({
      authority: "in_memory_test_or_development_only" as const,
      append,
      resolve
    });
  };

interface InspectedReceiptStore {
  readonly authority: DesignAgentReplayReceiptStore["authority"];
  readonly append: (receipt: DesignAgentReplayReceipt) => Promise<void>;
  readonly resolve: (receiptId: string) => Promise<unknown>;
}

const inspectReceiptStore = (storeValue: unknown): InspectedReceiptStore => {
  if (
    storeValue === null ||
    typeof storeValue !== "object" ||
    nodeTypes.isProxy(storeValue) ||
    (Object.getPrototypeOf(storeValue) !== Object.prototype &&
      Object.getPrototypeOf(storeValue) !== null)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_REPLAY_RECEIPT_STORE_INVALID",
      "Replay receipt store must be a non-proxy plain object"
    );
  }
  const keys = Reflect.ownKeys(storeValue);
  if (
    keys.some((key) => typeof key === "symbol") ||
    canonicalJson((keys as string[]).sort()) !==
      canonicalJson(["append", "authority", "resolve"])
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_REPLAY_RECEIPT_STORE_INVALID",
      "Replay receipt store contains missing or unknown methods"
    );
  }
  const appendDescriptor = Object.getOwnPropertyDescriptor(storeValue, "append");
  const resolveDescriptor = Object.getOwnPropertyDescriptor(storeValue, "resolve");
  const authorityDescriptor = Object.getOwnPropertyDescriptor(storeValue, "authority");
  for (const descriptor of [appendDescriptor, resolveDescriptor, authorityDescriptor]) {
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_REPLAY_RECEIPT_STORE_INVALID",
        "Replay receipt store methods must be enumerable data properties"
      );
    }
  }
  const append = appendDescriptor!.value;
  const resolve = resolveDescriptor!.value;
  const authority = authorityDescriptor!.value;
  if (
    (authority !== "durable_append_only_production" &&
      authority !== "in_memory_test_or_development_only") ||
    typeof append !== "function" ||
    nodeTypes.isProxy(append) ||
    typeof resolve !== "function" ||
    nodeTypes.isProxy(resolve)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_REPLAY_RECEIPT_STORE_INVALID",
      "Replay receipt store methods must be non-proxy functions"
    );
  }
  return {
    authority,
    append: async (receipt) => {
      await Reflect.apply(append, storeValue, [receipt]);
    },
    resolve: async (receiptId) => await Reflect.apply(resolve, storeValue, [receiptId])
  };
};

interface InspectedCoordinatorPrerequisites {
  readonly deploymentMode: DesignAgentDeploymentMode;
  readonly trustManifestId: string;
  readonly trustStore: InspectedTrustStore;
  readonly replayReceiptStore: InspectedReceiptStore;
}

const inspectCoordinatorPrerequisites = (
  value: unknown
): InspectedCoordinatorPrerequisites => {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_COORDINATOR_PREREQUISITES_INVALID",
      "Coordinator prerequisites must be a non-proxy plain object"
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key === "symbol") ||
    canonicalJson((keys as string[]).sort()) !==
      canonicalJson([
        "deploymentMode",
        "replayReceiptStore",
        "trustManifestId",
        "trustStore"
      ])
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_COORDINATOR_PREREQUISITES_INVALID",
      "Coordinator prerequisites contain missing or unknown fields"
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_COORDINATOR_PREREQUISITES_INVALID",
        "Coordinator prerequisite fields must be enumerable data properties"
      );
    }
  }
  const deploymentMode = descriptors.deploymentMode!.value;
  if (deploymentMode !== "production" && deploymentMode !== "test_or_development") {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_COORDINATOR_PREREQUISITES_INVALID",
      "Coordinator deployment mode must be explicit"
    );
  }
  return {
    deploymentMode,
    trustManifestId: boundedIdentifier(
      descriptors.trustManifestId!.value,
      "prerequisites.trustManifestId"
    ),
    trustStore: inspectTrustStore(descriptors.trustStore!.value),
    replayReceiptStore: inspectReceiptStore(descriptors.replayReceiptStore!.value)
  };
};

const assertProductionAuthorities = (
  prerequisites: InspectedCoordinatorPrerequisites
): void => {
  if (
    prerequisites.trustStore.authority !== "authenticated_production" ||
    prerequisites.replayReceiptStore.authority !== "durable_append_only_production"
  ) {
    reject(
      "POLICY_DENIED",
      "AGENT_PRODUCTION_TRUST_PREREQUISITE_REQUIRED",
      "Production coordinator requires an authenticated trust store and durable append-only receipt store"
    );
  }
};

export function assertProductionDesignAgentCoordinatorPrerequisites(
  value: unknown
): asserts value is DesignAgentProductionCoordinatorPrerequisites {
  const prerequisites = inspectCoordinatorPrerequisites(value);
  if (prerequisites.deploymentMode !== "production") {
    reject(
      "POLICY_DENIED",
      "AGENT_PRODUCTION_TRUST_PREREQUISITE_REQUIRED",
      "Production prerequisite guard requires deploymentMode=production"
    );
  }
  assertProductionAuthorities(prerequisites);
}

interface InspectedPort {
  readonly provider: BoundDesignAgentProvider;
  readonly generate: (request: DesignAgentProviderRequest, signal?: AbortSignal) => Promise<unknown>;
}

const inspectPort = (portValue: unknown): InspectedPort => {
  if (
    portValue === null ||
    typeof portValue !== "object" ||
    nodeTypes.isProxy(portValue)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_PROVIDER_PORT_INVALID",
      "Agent provider port must be a non-proxy plain object"
    );
  }
  const prototype = Object.getPrototypeOf(portValue);
  if (prototype !== Object.prototype && prototype !== null) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_PROVIDER_PORT_INVALID",
      "Agent provider port must have a plain object prototype"
    );
  }
  const keys = Reflect.ownKeys(portValue);
  if (keys.some((key) => typeof key === "symbol")) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_PROVIDER_PORT_INVALID",
      "Agent provider port cannot contain symbol keys"
    );
  }
  const names = (keys as string[]).sort();
  if (canonicalJson(names) !== canonicalJson(["generate", "provider"])) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_PROVIDER_PORT_INVALID",
      "Agent provider port contains missing or unknown fields"
    );
  }
  const providerDescriptor = Object.getOwnPropertyDescriptor(portValue, "provider");
  const generateDescriptor = Object.getOwnPropertyDescriptor(portValue, "generate");
  for (const descriptor of [providerDescriptor, generateDescriptor]) {
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_PROVIDER_PORT_INVALID",
        "Agent provider port properties must be enumerable data properties"
      );
    }
  }
  const checkedProviderDescriptor = providerDescriptor!;
  const checkedGenerateDescriptor = generateDescriptor!;
  const generate = checkedGenerateDescriptor.value;
  if (typeof generate !== "function" || nodeTypes.isProxy(generate)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_PROVIDER_PORT_INVALID",
      "Agent provider generate must be a non-proxy function"
    );
  }
  const providerSnapshot = clonePlainGraph(
    checkedProviderDescriptor.value,
    "INPUT",
    INPUT_GRAPH_LIMITS
  );
  const provider = validateProvider(providerSnapshot);
  return {
    provider,
    generate: async (request, signal) =>
      (await Reflect.apply(generate, portValue, [request, signal])) as unknown
  };
};

function replayMismatch(message: string): never {
  reject("DIGEST_MISMATCH", "AGENT_REPLAY_MISMATCH", message);
}

export class DesignAgentCoordinator {
  readonly #provider: BoundDesignAgentProvider;
  readonly #generate: InspectedPort["generate"];
  readonly #trustManifest: DesignAgentTrustManifest;
  readonly #replayReceipts: InspectedReceiptStore;

  /**
   * Host-composition boundary. Invocation data must never supply these prerequisites. Production
   * must inject authenticated manifest resolution and durable append-only replay receipts.
   */
  public constructor(
    port: DesignAgentPort,
    prerequisitesValue: DesignAgentCoordinatorPrerequisites
  ) {
    const inspected = inspectPort(port);
    const prerequisites = inspectCoordinatorPrerequisites(prerequisitesValue);
    if (prerequisites.deploymentMode === "production") {
      assertProductionAuthorities(prerequisites);
    }
    let trustManifestValue: unknown;
    try {
      trustManifestValue = prerequisites.trustStore.resolve(prerequisites.trustManifestId);
    } catch {
      reject(
        "POLICY_DENIED",
        "AGENT_TRUST_MANIFEST_RESOLUTION_FAILED",
        "Constructor-injected trust store failed to resolve the configured manifest"
      );
    }
    if (trustManifestValue === undefined) {
      reject(
        "POLICY_DENIED",
        "AGENT_TRUST_MANIFEST_NOT_FOUND",
        "Constructor-injected trust store has no configured manifest for this ID"
      );
    }
    const trustedManifest = validateTrustManifest(trustManifestValue);
    if (trustedManifest.manifestId !== prerequisites.trustManifestId) {
      reject(
        "POLICY_DENIED",
        "AGENT_TRUST_MANIFEST_RESOLUTION_FAILED",
        "Trust store resolved a manifest with a different ID"
      );
    }
    const providerIsPinned = trustedManifest.providers.some(
      (provider) =>
        provider.providerId === inspected.provider.providerId &&
        identitiesEqual(provider.identity, inspected.provider.identity)
    );
    if (!providerIsPinned) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_PROVIDER_NOT_TRUSTED",
        "Provider adapter is absent from the constructor-pinned trust manifest"
      );
    }
    this.#provider = inspected.provider;
    this.#generate = inspected.generate;
    this.#trustManifest = trustedManifest;
    this.#replayReceipts = prerequisites.replayReceiptStore;
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<DesignAgentLiveExecution> {
    const promptPack = buildDesignAgentPromptPack(input, this.#trustManifest);
    const trustedProvider = this.#trustManifest.providers.find(
      (provider) => provider.anchor === promptPack.trustAnchors.provider
    );
    if (trustedProvider === undefined) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_TRUST_ANCHOR_NOT_FOUND",
        "Provider trust anchor is absent from the constructor manifest"
      );
    }
    requireIdentity(
      this.#provider.identity,
      trustedProvider.identity,
      "AGENT_PROVIDER_IDENTITY_MISMATCH",
      "Provider adapter does not match the constructor-pinned identity",
      "INVALID_ARGUMENT"
    );
    if (
      this.#provider.providerId !== trustedProvider.providerId ||
      this.#provider.providerId !== promptPack.model.provider
    ) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_PROVIDER_MODEL_MISMATCH",
        "Provider identifier must exactly match model.provider"
      );
    }
    const request = buildProviderRequest(this.#provider, promptPack);
    let providerValue: unknown;
    try {
      providerValue = await this.#generate(request, signal);
    } catch {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_PROVIDER_FAILED",
        "The design-agent provider failed without producing a contract-bound response"
      );
    }
    const response = validateProviderResponse(providerValue, request);
    const proposal = parseProposal(response.rawOutput, promptPack);
    const result = buildProposalResult(request, response, proposal);
    const replay = buildReplay(request, response, result);
    const replayReceipt = buildReplayReceipt(replay);
    try {
      await this.#replayReceipts.append(replayReceipt);
    } catch (error) {
      if (error instanceof DesignAgentCoordinatorError) throw error;
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_REPLAY_RECEIPT_STORE_FAILED",
        "Append-only replay receipt storage failed"
      );
    }
    return deepFreeze({
      mode: "live_traceable" as const,
      result,
      replay,
      replayReceipt
    });
  }

  public async replay(
    replayValue: unknown,
    expectationValue: DesignAgentReplayExpectation
  ): Promise<DesignAgentReplayExecution> {
    if (expectationValue === undefined) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_REPLAY_EXPECTATION_REQUIRED",
        "Frozen replay requires a trusted receipt ID and exact input"
      );
    }
    const expectation = clonePlainGraph(
      expectationValue as unknown,
      "REPLAY_EXPECTATION",
      INPUT_GRAPH_LIMITS
    );
    if (!isRecord(expectation)) replayMismatch("Replay expectation must be a plain object");
    exactKeys(
      expectation,
      ["receiptId", "input"],
      "AGENT_REPLAY_MISMATCH",
      "replayExpectation"
    );
    const receiptId = boundedIdentifier(expectation.receiptId, "replayExpectation.receiptId");
    const replaySnapshot = clonePlainGraph(replayValue, "REPLAY", REPLAY_GRAPH_LIMITS);
    if (!isRecord(replaySnapshot)) replayMismatch("Frozen replay must be a plain object");
    exactKeys(
      replaySnapshot,
      ["schemaVersion", "request", "response", "result", "identity"],
      "AGENT_REPLAY_MISMATCH",
      "replay"
    );
    if (replaySnapshot.schemaVersion !== DESIGN_AGENT_REPLAY_SCHEMA) {
      replayMismatch("Frozen replay has an unsupported schema version");
    }
    const embeddedReplayIdentity = assertCanonicalIdentity(
      replaySnapshot.identity,
      "replay.identity",
      DESIGN_AGENT_REPLAY_SCHEMA
    );
    const replayPayload = {
      schemaVersion: replaySnapshot.schemaVersion,
      request: replaySnapshot.request,
      response: replaySnapshot.response,
      result: replaySnapshot.result
    };
    requireIdentity(
      embeddedReplayIdentity,
      canonicalIdentity(replayPayload, DESIGN_AGENT_REPLAY_SCHEMA),
      "AGENT_REPLAY_MISMATCH",
      "Frozen replay outer identity does not reproduce"
    );

    let receiptValue: unknown;
    try {
      receiptValue = await this.#replayReceipts.resolve(receiptId);
    } catch {
      reject(
        "TOOL_RESULT_INCONCLUSIVE",
        "AGENT_REPLAY_RECEIPT_STORE_FAILED",
        "Replay receipt resolution failed"
      );
    }
    if (receiptValue === undefined) {
      reject(
        "DIGEST_MISMATCH",
        "AGENT_REPLAY_RECEIPT_NOT_FOUND",
        "No append-only replay receipt exists for the supplied receipt ID"
      );
    }
    const receipt = validateReplayReceipt(receiptValue, receiptId);
    requireIdentity(
      receipt.trustManifestIdentity,
      this.#trustManifest.identity,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt belongs to a different trust manifest"
    );
    requireIdentity(
      receipt.providerIdentity,
      this.#provider.identity,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt belongs to a different provider adapter"
    );

    requireIdentity(
      embeddedReplayIdentity,
      receipt.replayIdentity,
      "AGENT_REPLAY_MISMATCH",
      "Frozen replay does not match its append-only trusted receipt"
    );
    const promptPack = buildDesignAgentPromptPack(expectation.input, this.#trustManifest);
    if (this.#provider.providerId !== promptPack.model.provider) {
      replayMismatch("Replay provider identifier does not match model.provider");
    }
    requireIdentity(
      receipt.promptPackIdentity,
      promptPack.identity,
      "AGENT_REPLAY_RECEIPT_INVALID",
      "Replay receipt does not bind the reconstructed prompt pack"
    );
    const expectedRequest = buildProviderRequest(this.#provider, promptPack);
    if (canonicalJson(replaySnapshot.request) !== canonicalJson(expectedRequest)) {
      replayMismatch("Frozen replay request does not match the exact expected prompt inputs");
    }
    const response = validateProviderResponse(replaySnapshot.response, expectedRequest);
    const proposal = parseProposal(response.rawOutput, promptPack);
    const result = buildProposalResult(expectedRequest, response, proposal);
    if (canonicalJson(replaySnapshot.result) !== canonicalJson(result)) {
      replayMismatch("Frozen replay result does not reconstruct exactly");
    }
    const reconstructedReplay = buildReplay(expectedRequest, response, result);
    if (canonicalJson(replaySnapshot) !== canonicalJson(reconstructedReplay)) {
      replayMismatch("Frozen replay does not reconstruct exactly");
    }
    return deepFreeze({
      mode: "frozen_exact_replay" as const,
      result,
      replayIdentity: receipt.replayIdentity,
      receiptId: receipt.receiptId,
      receiptIdentity: receipt.identity
    });
  }
}

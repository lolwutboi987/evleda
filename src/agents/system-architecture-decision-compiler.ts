import { types as nodeTypes } from "node:util";
import { requirementsDocumentSchema, approvalRecordSchema } from "../contracts/results.js";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { ApprovalRecord, CanonicalIdentity, ContentIdentity, Requirement, RequirementsDocument } from "../domain/types.js";
import {
  PCB_ENGINEERING_PRACTICE_SCHEMA,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
  type PcbEngineeringPracticeCatalog
} from "../knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
} from "./contracts.js";
import * as contract from "./system-architecture-decision-contract.js";
import type {
  CompiledSystemArchitectureNode,
  CompiledSystemArchitectureParameter,
  ResolvedSystemArchitectureProposal,
  ResolvedSystemArchitectureProposalPayload,
  SystemArchitectureAllocationTargetKind,
  SystemArchitectureDecisionBinding,
  SystemArchitectureDecisionBindingPayload,
  SystemArchitectureDecisionCompilation,
  SystemArchitectureDecisionCompilationPayload,
  SystemArchitectureDecisionCompiler,
  SystemArchitectureDecisionCompilerProvision,
  SystemArchitectureDecisionExpectedIdentities,
  SystemArchitectureDecisionIssue,
  SystemArchitectureDecisionIssueCode,
  SystemArchitectureDecisionOperation,
  SystemArchitectureDecisionRegistry,
  SystemArchitectureDecisionRegistryPayload,
  SystemArchitectureGraph,
  SystemArchitectureGraphPayload,
  SystemArchitectureIr,
  SystemArchitectureIrAllocation,
  SystemArchitectureIrConnection,
  SystemArchitectureIrNode,
  SystemArchitectureIrParameter,
  SystemArchitectureIrPath,
  SystemArchitectureIrPayload,
  SystemArchitectureIrPort,
  SystemArchitectureIrPracticeAllocation,
  SystemArchitectureIrSafeState,
  SystemArchitectureOption,
  SystemArchitectureOptionCatalog,
  SystemArchitectureOptionCatalogPayload,
  SystemArchitectureOptionPracticeRequirement,
  SystemArchitectureParameterDomain,
  SystemArchitectureParameterUnit,
  SystemArchitecturePortTemplate,
  SystemArchitectureRequirementAllocationPolicy,
  SystemArchitectureSafeStateTuple,
  SystemArchitectureSelectedOption,
  SystemArchitectureTopologyCatalog,
  SystemArchitectureTopologyCatalogPayload,
  SystemArchitectureTopologyEdgeTemplate,
  SystemArchitectureTopologyPathEndpoint,
  SystemArchitectureTopologyPathPolicy,
  SystemArchitectureTopologyRoleTemplate,
  SystemArchitectureTopologySafeStatePolicy,
  SystemArchitectureTopologyTemplate
} from "./system-architecture-decision-contract.js";

type PlainRecord = Record<string, unknown>;
type Reject = (message: string, details?: Readonly<Record<string, unknown>>) => never;

const rejectInput: Reject = (message, details = {}) => {
  throw new DomainError("INVALID_ARGUMENT", message, details);
};
const rejectArtifact: Reject = (message, details = {}) => {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", message, details);
};
const rejectPolicy: Reject = (message, details = {}) => {
  throw new DomainError("POLICY_DENIED", message, details);
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const isRecord = (value: unknown): value is PlainRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface PlainGraphBudget {
  containers: number;
  primitives: number;
  ownProperties: number;
  utf8Bytes: number;
}

interface PlainGraphLimits {
  readonly containers: number;
  readonly primitives: number;
  readonly ownProperties: number;
  readonly utf8Bytes: number;
}

const INPUT_GRAPH_LIMITS: PlainGraphLimits = Object.freeze({
  containers: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.graphContainers,
  primitives: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.graphPrimitives,
  ownProperties: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.graphOwnProperties,
  utf8Bytes: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.totalUtf8Bytes
});
const ARTIFACT_GRAPH_LIMITS: PlainGraphLimits = Object.freeze({
  containers: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.artifactGraphContainers,
  primitives: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.artifactGraphPrimitives,
  ownProperties: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.artifactGraphOwnProperties,
  utf8Bytes: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.artifactTotalUtf8Bytes
});

const graphBudget = (): PlainGraphBudget => ({
  containers: 0,
  primitives: 0,
  ownProperties: 0,
  utf8Bytes: 0
});

const spendUtf8 = (
  value: string,
  kind: "property key" | "string value",
  field: string,
  budget: PlainGraphBudget,
  reject: Reject,
  limits: PlainGraphLimits
): void => {
  const bytes = Buffer.byteLength(value, "utf8");
  const perValueLimit = kind === "property key"
    ? contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.propertyKeyBytes
    : contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.stringValueBytes;
  if (bytes > perValueLimit) reject(`System architecture ${kind} exceeds its UTF-8 byte limit`, { field, bytes });
  budget.utf8Bytes += bytes;
  if (budget.utf8Bytes > limits.utf8Bytes) {
    reject("System architecture data exceeds the aggregate UTF-8 byte limit", { field });
  }
};

const spendPrimitive = (
  value: unknown,
  field: string,
  budget: PlainGraphBudget,
  reject: Reject,
  stringKind: "property key" | "string value" = "string value",
  limits: PlainGraphLimits = INPUT_GRAPH_LIMITS
): void => {
  budget.primitives += 1;
  if (budget.primitives > limits.primitives) {
    reject("System architecture data exceeds the primitive-value limit", { field });
  }
  if (typeof value === "string") spendUtf8(value, stringKind, field, budget, reject, limits);
};

const assertPlainDataGraph = (
  value: unknown,
  field: string,
  reject: Reject,
  budget: PlainGraphBudget = graphBudget(),
  seen = new Set<object>(),
  depth = 0,
  limits: PlainGraphLimits = INPUT_GRAPH_LIMITS
): void => {
  if (depth > contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.graphDepth) {
    reject("System architecture data exceeds the maximum depth", { field });
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      reject("System architecture numeric data must be finite", { field });
    }
    spendPrimitive(value, field, budget, reject, "string value", limits);
    return;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    reject("System architecture data must be non-proxy plain JSON data", { field });
  }
  budget.containers += 1;
  if (budget.containers > limits.containers) {
    reject("System architecture data exceeds the container limit", { field });
  }
  if (seen.has(value)) reject("System architecture data must not contain cycles or aliases", { field });
  seen.add(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && (!array && prototype !== null)) {
    reject("System architecture data must have a plain prototype", { field });
  }
  if (array && value.length > contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.propertiesPerObject) {
    reject("System architecture array exceeds the property-width limit", { field });
  }

  const enumerableKeys = new Set<string>();
  let enumerableCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    enumerableCount += 1;
    if (enumerableCount > contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.propertiesPerObject) {
      reject("System architecture object exceeds the property-width limit", { field });
    }
    spendPrimitive(key, field, budget, reject, "property key", limits);
    budget.ownProperties += 1;
    if (budget.ownProperties > limits.ownProperties) {
      reject("System architecture data exceeds the aggregate own-property limit", { field });
    }
    enumerableKeys.add(key);
  }
  if (array) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) reject("System architecture arrays must not be sparse", { field });
    }
  }
  const ownKeys = Reflect.ownKeys(value);
  const ordinaryOwnKeyCount = array ? ownKeys.length - 1 : ownKeys.length;
  if (ordinaryOwnKeyCount > contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.propertiesPerObject) {
    reject("System architecture object exceeds the own-property limit", { field });
  }
  for (const keyValue of ownKeys) {
    if (typeof keyValue === "symbol") reject("System architecture data cannot contain symbol keys", { field });
    const key = keyValue as string;
    if (array && key === "length") continue;
    if (!enumerableKeys.has(key)) {
      spendPrimitive(key, field, budget, reject, "property key", limits);
      budget.ownProperties += 1;
      if (budget.ownProperties > limits.ownProperties) {
        reject("System architecture data exceeds the aggregate own-property limit", { field });
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      reject("System architecture data cannot contain accessors", { field });
    }
    if (!descriptor.enumerable) reject("System architecture data cannot contain non-enumerable fields", { field });
    if (array) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
        reject("System architecture arrays cannot contain named fields", { field });
      }
    }
    assertPlainDataGraph(descriptor.value, `${field}.${key}`, reject, budget, seen, depth + 1, limits);
  }
  seen.delete(value);
};

const deepFreeze = <Value>(value: Value, seen = new Set<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

const detached = (
  value: unknown,
  field: string,
  reject: Reject = rejectInput,
  budget: PlainGraphBudget = graphBudget(),
  limits: PlainGraphLimits = INPUT_GRAPH_LIMITS
): unknown => {
  assertPlainDataGraph(value, field, reject, budget, new Set<object>(), 0, limits);
  try {
    return structuredClone(value);
  } catch {
    reject("System architecture data could not be snapshotted", { field });
  }
};

const exactKeys = (record: PlainRecord, expected: readonly string[], field: string, reject: Reject): void => {
  const actual = Object.keys(record).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    reject("System architecture data contains missing or unknown fields", { field, actual, expected: wanted });
  }
};

const recordAt = (value: unknown, expected: readonly string[], field: string, reject: Reject = rejectInput): PlainRecord => {
  if (!isRecord(value)) reject("System architecture record is invalid", { field });
  exactKeys(value, expected, field, reject);
  return value;
};

const identifier = (value: unknown, field: string, reject: Reject = rejectInput): string => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 96 ||
      !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    reject("System architecture identifier is invalid", { field });
  }
  return value;
};

const versionToken = (value: unknown, field: string, reject: Reject = rejectInput): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 96 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/u.test(value)
  ) {
    reject("System architecture implementation-version token is invalid", { field });
  }
  return value;
};

const enumValue = <Value extends string>(value: unknown, allowed: readonly Value[], field: string, reject: Reject = rejectInput): Value => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    reject("System architecture enum value is invalid", { field, value });
  }
  return value as Value;
};

const safeInteger = (value: unknown, field: string, minimum: number, maximum: number, reject: Reject = rejectInput): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    reject("System architecture integer is invalid", { field, value, minimum, maximum });
  }
  return value;
};

const exactIntegerDifferenceIsMultiple = (value: number, base: number, step: number): boolean =>
  (BigInt(value) - BigInt(base)) % BigInt(step) === 0n;

const arrayAt = (value: unknown, field: string, maximum: number, minimum = 0, reject: Reject = rejectInput): readonly unknown[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    reject("System architecture array length is invalid", { field, minimum, maximum });
  }
  return value;
};

const identifierList = (value: unknown, field: string, maximum: number, minimum = 0, reject: Reject = rejectInput): readonly string[] => {
  const result = arrayAt(value, field, maximum, minimum, reject).map((entry, index) =>
    identifier(entry, `${field}[${String(index)}]`, reject));
  if (new Set(result).size !== result.length) reject("System architecture identifier list contains duplicates", { field });
  return result;
};

const identifierSet = (value: unknown, field: string, maximum: number, minimum = 0, reject: Reject = rejectInput): readonly string[] =>
  [...identifierList(value, field, maximum, minimum, reject)].sort(compareText);

const enumSet = <Value extends string>(value: unknown, allowed: readonly Value[], field: string, maximum: number, minimum = 0, reject: Reject = rejectInput): readonly Value[] => {
  const result = arrayAt(value, field, maximum, minimum, reject).map((entry, index) =>
    enumValue(entry, allowed, `${field}[${String(index)}]`, reject));
  if (new Set(result).size !== result.length) reject("System architecture enum set contains duplicates", { field });
  return result.sort(compareText);
};

const canonicalIdentityAt = (value: unknown, field: string, expectedSchema?: string, reject: Reject = rejectInput): CanonicalIdentity => {
  const record = recordAt(value, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"], field, reject);
  if (record.algorithm !== "sha256" || typeof record.digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.digest) ||
      typeof record.schemaVersion !== "string" || Buffer.byteLength(record.schemaVersion, "utf8") > 128 ||
      record.canonicalizationVersion !== "evleda-c14n-json-v1" ||
      (expectedSchema !== undefined && record.schemaVersion !== expectedSchema)) {
    reject("System architecture canonical identity is invalid", { field, expectedSchema });
  }
  return deepFreeze({
    algorithm: "sha256" as const,
    digest: record.digest,
    schemaVersion: record.schemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1" as const
  });
};

const contentIdentityAt = (
  value: unknown,
  field: string,
  reject: Reject = rejectInput,
  minimumSize = 0,
  maximumSize = Number.MAX_SAFE_INTEGER
): ContentIdentity => {
  const record = recordAt(value, ["algorithm", "digest", "size"], field, reject);
  if (
    record.algorithm !== "sha256" ||
    typeof record.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.digest) ||
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size < minimumSize ||
    record.size > maximumSize
  ) {
    reject("System architecture content identity is invalid", { field });
  }
  return deepFreeze({ algorithm: "sha256" as const, digest: record.digest, size: record.size });
};

const identitiesEqual = (left: CanonicalIdentity, right: CanonicalIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const requireIdentity = (actual: CanonicalIdentity, expected: CanonicalIdentity, field: string, reject: Reject): void => {
  if (!identitiesEqual(actual, expected)) reject("System architecture identity does not match its pinned value", { field, actual, expected });
};

const withVerifiedIdentity = <Payload extends object>(record: PlainRecord, payload: Payload, schema: string, field: string, reject: Reject): Payload & { readonly identity: CanonicalIdentity } => {
  const expected = deepFreeze(canonicalIdentity(payload, schema));
  requireIdentity(canonicalIdentityAt(record.identity, `${field}.identity`, schema, reject), expected, field, reject);
  return deepFreeze({ ...payload, identity: expected });
};

const requirementIds = (value: unknown, field: string, reject: Reject = rejectInput): readonly string[] =>
  identifierSet(
    value,
    field,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.referencesPerRecord,
    1,
    reject
  );

const safeStateTupleKey = (tuple: SystemArchitectureSafeStateTuple): string =>
  `${tuple.trigger}\u0000${tuple.action}\u0000${tuple.mechanism}\u0000${tuple.releaseCondition}`;

const normalizeSafeStateTuple = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureSafeStateTuple => {
  const record = recordAt(
    value,
    ["trigger", "action", "mechanism", "releaseCondition"],
    field,
    reject
  );
  return {
    trigger: enumValue(
      record.trigger,
      contract.SYSTEM_ARCHITECTURE_SAFE_STATE_TRIGGERS,
      `${field}.trigger`,
      reject
    ),
    action: enumValue(
      record.action,
      contract.SYSTEM_ARCHITECTURE_SAFE_STATE_ACTIONS,
      `${field}.action`,
      reject
    ),
    mechanism: enumValue(
      record.mechanism,
      contract.SYSTEM_ARCHITECTURE_SAFE_STATE_MECHANISMS,
      `${field}.mechanism`,
      reject
    ),
    releaseCondition: enumValue(
      record.releaseCondition,
      contract.SYSTEM_ARCHITECTURE_SAFE_STATE_RELEASE_CONDITIONS,
      `${field}.releaseCondition`,
      reject
    )
  };
};

const normalizePortTemplate = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitecturePortTemplate => {
  const record = recordAt(value, [
    "key",
    "direction",
    "type",
    "protocol",
    "minimumConnections",
    "maximumConnections",
    "compatibilityParameterKeys",
    "allowedSafeStateTuples"
  ], field, reject);
  const minimumConnections = safeInteger(
    record.minimumConnections,
    `${field}.minimumConnections`,
    0,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
    reject
  );
  const maximumConnections = safeInteger(
    record.maximumConnections,
    `${field}.maximumConnections`,
    0,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
    reject
  );
  if (minimumConnections > maximumConnections) {
    reject("Port-template connection bounds are reversed", { field });
  }
  const tuples = arrayAt(
    record.allowedSafeStateTuples,
    `${field}.allowedSafeStateTuples`,
    contract.SYSTEM_ARCHITECTURE_SAFE_STATE_TRIGGERS.length *
      contract.SYSTEM_ARCHITECTURE_SAFE_STATE_ACTIONS.length *
      contract.SYSTEM_ARCHITECTURE_SAFE_STATE_MECHANISMS.length *
      contract.SYSTEM_ARCHITECTURE_SAFE_STATE_RELEASE_CONDITIONS.length,
    0,
    reject
  ).map((entry, index) =>
    normalizeSafeStateTuple(entry, `${field}.allowedSafeStateTuples[${String(index)}]`, reject)
  );
  const tupleKeys = tuples.map(safeStateTupleKey);
  if (new Set(tupleKeys).size !== tupleKeys.length) {
    reject("Port template contains a duplicate safe-state tuple", { field });
  }
  tuples.sort((left, right) => compareText(safeStateTupleKey(left), safeStateTupleKey(right)));
  return {
    key: identifier(record.key, `${field}.key`, reject),
    direction: enumValue(
      record.direction,
      contract.SYSTEM_ARCHITECTURE_PORT_DIRECTIONS,
      `${field}.direction`,
      reject
    ),
    type: enumValue(record.type, contract.SYSTEM_ARCHITECTURE_PORT_TYPES, `${field}.type`, reject),
    protocol: enumValue(
      record.protocol,
      contract.SYSTEM_ARCHITECTURE_PROTOCOLS,
      `${field}.protocol`,
      reject
    ),
    minimumConnections,
    maximumConnections,
    compatibilityParameterKeys: identifierSet(
      record.compatibilityParameterKeys,
      `${field}.compatibilityParameterKeys`,
      contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.parameterDomainsPerOption,
      0,
      reject
    ),
    allowedSafeStateTuples: tuples
  };
};

const normalizeParameterDomain = (
  value: unknown,
  field: string,
  portTemplateKeys: ReadonlySet<string>,
  reject: Reject
): SystemArchitectureParameterDomain => {
  const record = recordAt(value, [
    "key", "targetKind", "targetTemplateKey", "unit", "minimum", "maximum", "step", "required", "allowedRequirementSources"
  ], field, reject);
  const targetKind = enumValue(record.targetKind, ["node", "port"] as const, `${field}.targetKind`, reject);
  const targetTemplateKey = record.targetTemplateKey === null
    ? null
    : identifier(record.targetTemplateKey, `${field}.targetTemplateKey`, reject);
  if (
    (targetKind === "node" && targetTemplateKey !== null) ||
    (targetKind === "port" && (targetTemplateKey === null || !portTemplateKeys.has(targetTemplateKey)))
  ) {
    reject("Parameter domain target does not resolve to its option", { field });
  }
  const minimum = safeInteger(
    record.minimum,
    `${field}.minimum`,
    -9_000_000_000_000_000,
    9_000_000_000_000_000,
    reject
  );
  const maximum = safeInteger(
    record.maximum,
    `${field}.maximum`,
    -9_000_000_000_000_000,
    9_000_000_000_000_000,
    reject
  );
  const step = safeInteger(
    record.step,
    `${field}.step`,
    1,
    9_000_000_000_000_000,
    reject
  );
  if (minimum > maximum || !exactIntegerDifferenceIsMultiple(maximum, minimum, step)) {
    reject("Parameter domain bounds or step are invalid", { field });
  }
  if (typeof record.required !== "boolean") reject("Parameter-domain required flag is invalid", { field });
  const allowedRequirementSources = arrayAt(
    record.allowedRequirementSources,
    `${field}.allowedRequirementSources`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.referencesPerRecord,
    1,
    reject
  ).map((entry, index) => {
    const sourceField = `${field}.allowedRequirementSources[${String(index)}]`;
    const source = recordAt(entry, ["normalizedConstraintKey", "category", "priority"], sourceField, reject);
    return {
      normalizedConstraintKey: identifier(source.normalizedConstraintKey, `${sourceField}.normalizedConstraintKey`, reject),
      category: enumValue(source.category, REQUIREMENT_CATEGORIES, `${sourceField}.category`, reject),
      priority: enumValue(source.priority, REQUIREMENT_PRIORITIES, `${sourceField}.priority`, reject)
    };
  });
  const sourceKeys = allowedRequirementSources.map((source) =>
    `${source.normalizedConstraintKey}\u0000${source.category}\u0000${source.priority}`
  );
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    reject("Parameter domain contains duplicate requirement-source selectors", { field });
  }
  allowedRequirementSources.sort((left, right) => compareText(
    `${left.normalizedConstraintKey}\u0000${left.category}\u0000${left.priority}`,
    `${right.normalizedConstraintKey}\u0000${right.category}\u0000${right.priority}`
  ));
  return {
    key: identifier(record.key, `${field}.key`, reject),
    targetKind,
    targetTemplateKey,
    unit: enumValue(record.unit, contract.SYSTEM_ARCHITECTURE_PARAMETER_UNITS, `${field}.unit`, reject),
    minimum,
    maximum,
    step,
    required: record.required,
    allowedRequirementSources
  };
};

const normalizeOptionPracticeRequirement = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureOptionPracticeRequirement => {
  const record = recordAt(
    value,
    ["practiceId", "scope", "allowedTargetKinds", "allowedPathKinds"],
    field,
    reject
  );
  if (record.scope !== "per_node") reject("Option practice scope must be per_node", { field });
  const targetKinds = enumSet(
    record.allowedTargetKinds,
    contract.SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS,
    `${field}.allowedTargetKinds`,
    contract.SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS.length,
    1,
    reject
  );
  const pathKinds = enumSet(
    record.allowedPathKinds,
    contract.SYSTEM_ARCHITECTURE_PATH_KINDS,
    `${field}.allowedPathKinds`,
    contract.SYSTEM_ARCHITECTURE_PATH_KINDS.length,
    0,
    reject
  );
  if (targetKinds.includes("path") !== (pathKinds.length > 0)) {
    reject("Option practice path kinds must be present exactly when path targets are allowed", { field });
  }
  return {
    practiceId: identifier(record.practiceId, `${field}.practiceId`, reject),
    scope: "per_node",
    allowedTargetKinds: targetKinds,
    allowedPathKinds: pathKinds
  };
};

const normalizeOption = (value: unknown, field: string, reject: Reject): SystemArchitectureOption => {
  const record = recordAt(
    value,
    ["id", "nodeKind", "portTemplates", "parameterDomains", "requiredPractices"],
    field,
    reject
  );
  const portTemplates = arrayAt(
    record.portTemplates,
    `${field}.portTemplates`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.portTemplatesPerOption,
    1,
    reject
  ).map((entry, index) => normalizePortTemplate(entry, `${field}.portTemplates[${String(index)}]`, reject));
  const portKeys = portTemplates.map(({ key }) => key);
  if (new Set(portKeys).size !== portKeys.length) reject("Option has duplicate port-template keys", { field });
  portTemplates.sort((left, right) => compareText(left.key, right.key));
  const portKeySet = new Set(portKeys);
  const parameterDomains = arrayAt(
    record.parameterDomains,
    `${field}.parameterDomains`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.parameterDomainsPerOption,
    0,
    reject
  ).map((entry, index) => normalizeParameterDomain(
    entry,
    `${field}.parameterDomains[${String(index)}]`,
    portKeySet,
    reject
  ));
  const domainKeys = parameterDomains.map((entry) =>
    `${entry.targetKind}\u0000${entry.targetTemplateKey ?? ""}\u0000${entry.key}`
  );
  if (new Set(domainKeys).size !== domainKeys.length) reject("Option has duplicate parameter domains", { field });
  parameterDomains.sort((left, right) => compareText(
    `${left.targetKind}\u0000${left.targetTemplateKey ?? ""}\u0000${left.key}`,
    `${right.targetKind}\u0000${right.targetTemplateKey ?? ""}\u0000${right.key}`
  ));
  const domainKeysByPort = new Map<string, Set<string>>();
  for (const domain of parameterDomains) {
    if (domain.targetKind !== "port" || domain.targetTemplateKey === null) continue;
    const keys = domainKeysByPort.get(domain.targetTemplateKey) ?? new Set<string>();
    keys.add(domain.key);
    domainKeysByPort.set(domain.targetTemplateKey, keys);
  }
  for (const template of portTemplates) {
    const domainKeysForPort = domainKeysByPort.get(template.key) ?? new Set<string>();
    if (template.compatibilityParameterKeys.some((key) => !domainKeysForPort.has(key))) {
      reject("Port compatibility key lacks a matching parameter domain", { field, templateKey: template.key });
    }
  }
  const requiredPractices = arrayAt(
    record.requiredPractices,
    `${field}.requiredPractices`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.practicesPerOption,
    0,
    reject
  ).map((entry, index) => normalizeOptionPracticeRequirement(
    entry,
    `${field}.requiredPractices[${String(index)}]`,
    reject
  ));
  const practiceIds = requiredPractices.map(({ practiceId }) => practiceId);
  if (new Set(practiceIds).size !== practiceIds.length) reject("Option has duplicate required practices", { field });
  requiredPractices.sort((left, right) => compareText(left.practiceId, right.practiceId));
  return {
    id: identifier(record.id, `${field}.id`, reject),
    nodeKind: enumValue(record.nodeKind, contract.SYSTEM_ARCHITECTURE_NODE_KINDS, `${field}.nodeKind`, reject),
    portTemplates,
    parameterDomains,
    requiredPractices
  };
};

const snapshotSystemArchitectureOptionCatalog = (value: unknown, reject: Reject): SystemArchitectureOptionCatalog => {
  const snapshot = detached(value, "optionCatalog", reject);
  const record = recordAt(snapshot, ["schemaVersion", "options", "identity"], "optionCatalog", reject);
  if (record.schemaVersion !== contract.SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA) {
    reject("System architecture option-catalog schema is invalid");
  }
  const options = arrayAt(
    record.options,
    "optionCatalog.options",
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.options,
    1,
    reject
  ).map((entry, index) => normalizeOption(entry, `optionCatalog.options[${String(index)}]`, reject));
  const ids = options.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) reject("Option catalog contains duplicate option IDs");
  options.sort((left, right) => compareText(left.id, right.id));
  const payload: SystemArchitectureOptionCatalogPayload = {
    schemaVersion: contract.SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA,
    options
  };
  return withVerifiedIdentity(
    record,
    payload,
    contract.SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA,
    "optionCatalog",
    reject
  );
};

export const validateAndSnapshotSystemArchitectureOptionCatalog = (
  value: unknown
): SystemArchitectureOptionCatalog => snapshotSystemArchitectureOptionCatalog(value, rejectInput);

const snapshotSystemArchitectureDecisionRegistry = (
  value: unknown,
  reject: Reject
): SystemArchitectureDecisionRegistry => {
  const snapshot = detached(value, "registry", reject);
  const record = recordAt(
    snapshot,
    ["schemaVersion", "enabledOperations", "compiler", "validators", "identity"],
    "registry",
    reject
  );
  if (record.schemaVersion !== contract.SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA) {
    reject("System architecture decision-registry schema is invalid");
  }
  const compilerRecord = recordAt(
    record.compiler,
    ["compilerId", "implementationVersion", "implementationContentIdentity"],
    "registry.compiler",
    reject
  );
  if (compilerRecord.compilerId !== "evleda.system-architecture.decision-compiler.v1") {
    reject("System architecture registry compiler ID is unsupported");
  }
  const validators = arrayAt(
    record.validators,
    "registry.validators",
    contract.SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS.length,
    contract.SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS.length,
    reject
  ).map((entry, index) => {
    const field = `registry.validators[${String(index)}]`;
    const validator = recordAt(
      entry,
      ["validatorId", "implementationVersion", "implementationContentIdentity"],
      field,
      reject
    );
    return {
      validatorId: enumValue(
        validator.validatorId,
        contract.SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS,
        `${field}.validatorId`,
        reject
      ),
      implementationVersion: versionToken(
        validator.implementationVersion,
        `${field}.implementationVersion`,
        reject
      ),
      implementationContentIdentity: contentIdentityAt(
        validator.implementationContentIdentity,
        `${field}.implementationContentIdentity`,
        reject,
        1,
        contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.implementationBytes
      )
    };
  });
  const validatorIds = validators.map(({ validatorId }) => validatorId);
  if (
    new Set(validatorIds).size !== validatorIds.length ||
    contract.SYSTEM_ARCHITECTURE_MANDATORY_VALIDATOR_IDS.some((id) => !validatorIds.includes(id))
  ) {
    reject("System architecture registry must bind every mandatory validator exactly once");
  }
  validators.sort((left, right) => compareText(left.validatorId, right.validatorId));
  const payload: SystemArchitectureDecisionRegistryPayload = {
    schemaVersion: contract.SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA,
    enabledOperations: enumSet(
      record.enabledOperations,
      contract.SYSTEM_ARCHITECTURE_DECISION_OPERATIONS,
      "registry.enabledOperations",
      contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.operations,
      0,
      reject
    ),
    compiler: {
      compilerId: "evleda.system-architecture.decision-compiler.v1",
      implementationVersion: versionToken(
        compilerRecord.implementationVersion,
        "registry.compiler.implementationVersion",
        reject
      ),
      implementationContentIdentity: contentIdentityAt(
        compilerRecord.implementationContentIdentity,
        "registry.compiler.implementationContentIdentity",
        reject,
        1,
        contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.implementationBytes
      )
    },
    validators
  };
  return withVerifiedIdentity(
    record,
    payload,
    contract.SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA,
    "registry",
    reject
  );
};

export const validateAndSnapshotSystemArchitectureDecisionRegistry = (
  value: unknown
): SystemArchitectureDecisionRegistry => snapshotSystemArchitectureDecisionRegistry(value, rejectInput);

const REQUIREMENT_CATEGORIES = Object.freeze([
  "power",
  "compute",
  "actuator",
  "sensor",
  "communication",
  "mechanical",
  "environment",
  "safety",
  "firmware",
  "manufacturing"
] as const);
const REQUIREMENT_PRIORITIES = Object.freeze(["must", "should", "could"] as const);

const normalizeTopologyRole = (
  value: unknown,
  field: string,
  optionIds: ReadonlySet<string>,
  reject: Reject
): SystemArchitectureTopologyRoleTemplate => {
  const record = recordAt(
    value,
    ["id", "allowedOptionIds", "minimumInstances", "maximumInstances"],
    field,
    reject
  );
  const minimumInstances = safeInteger(
    record.minimumInstances,
    `${field}.minimumInstances`,
    0,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.nodes,
    reject
  );
  const maximumInstances = safeInteger(
    record.maximumInstances,
    `${field}.maximumInstances`,
    1,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.nodes,
    reject
  );
  if (minimumInstances > maximumInstances) reject("Topology-role instance bounds are reversed", { field });
  const allowedOptionIds = identifierSet(
    record.allowedOptionIds,
    `${field}.allowedOptionIds`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.options,
    1,
    reject
  );
  if (allowedOptionIds.some((id) => !optionIds.has(id))) {
    reject("Topology role references an option outside the pinned option catalog", { field });
  }
  return {
    id: identifier(record.id, `${field}.id`, reject),
    allowedOptionIds,
    minimumInstances,
    maximumInstances
  };
};

const normalizeTopologyEdge = (
  value: unknown,
  field: string,
  roleIds: ReadonlySet<string>,
  reject: Reject
): SystemArchitectureTopologyEdgeTemplate => {
  const record = recordAt(value, [
    "id",
    "driverRoleId",
    "driverPortTemplateKey",
    "receiverRoleId",
    "receiverPortTemplateKey",
    "type",
    "protocol",
    "minimumConnections",
    "maximumConnections",
    "maximumFanoutPerDriverPort",
    "maximumFaninPerReceiverPort",
    "requiredPathPolicyIds"
  ], field, reject);
  const driverRoleId = identifier(record.driverRoleId, `${field}.driverRoleId`, reject);
  const receiverRoleId = identifier(record.receiverRoleId, `${field}.receiverRoleId`, reject);
  if (!roleIds.has(driverRoleId) || !roleIds.has(receiverRoleId)) {
    reject("Topology edge references an unknown topology role", { field });
  }
  const minimumConnections = safeInteger(
    record.minimumConnections,
    `${field}.minimumConnections`,
    0,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
    reject
  );
  const maximumConnections = safeInteger(
    record.maximumConnections,
    `${field}.maximumConnections`,
    1,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
    reject
  );
  if (minimumConnections > maximumConnections) reject("Topology-edge cardinality bounds are reversed", { field });
  return {
    id: identifier(record.id, `${field}.id`, reject),
    driverRoleId,
    driverPortTemplateKey: identifier(record.driverPortTemplateKey, `${field}.driverPortTemplateKey`, reject),
    receiverRoleId,
    receiverPortTemplateKey: identifier(record.receiverPortTemplateKey, `${field}.receiverPortTemplateKey`, reject),
    type: enumValue(record.type, contract.SYSTEM_ARCHITECTURE_PORT_TYPES, `${field}.type`, reject),
    protocol: enumValue(record.protocol, contract.SYSTEM_ARCHITECTURE_PROTOCOLS, `${field}.protocol`, reject),
    minimumConnections,
    maximumConnections,
    maximumFanoutPerDriverPort: safeInteger(
      record.maximumFanoutPerDriverPort,
      `${field}.maximumFanoutPerDriverPort`,
      1,
      contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
      reject
    ),
    maximumFaninPerReceiverPort: safeInteger(
      record.maximumFaninPerReceiverPort,
      `${field}.maximumFaninPerReceiverPort`,
      1,
      contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
      reject
    ),
    requiredPathPolicyIds: identifierSet(
      record.requiredPathPolicyIds,
      `${field}.requiredPathPolicyIds`,
      contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.pathPoliciesPerTopology,
      1,
      reject
    )
  };
};

const normalizePathEndpoint = (
  value: unknown,
  field: string,
  roleIds: ReadonlySet<string>,
  reject: Reject
): SystemArchitectureTopologyPathEndpoint => {
  const record = recordAt(value, ["roleId", "portTemplateKey"], field, reject);
  const roleId = identifier(record.roleId, `${field}.roleId`, reject);
  if (!roleIds.has(roleId)) reject("Path endpoint references an unknown topology role", { field });
  return {
    roleId,
    portTemplateKey: identifier(record.portTemplateKey, `${field}.portTemplateKey`, reject)
  };
};

const normalizePathPolicy = (
  value: unknown,
  field: string,
  roleIds: ReadonlySet<string>,
  reject: Reject
): SystemArchitectureTopologyPathPolicy => {
  const record = recordAt(value, [
    "id", "kind", "type", "protocol", "start", "end", "orderedEdgeTemplateIds", "minimumPaths", "maximumPaths"
  ], field, reject);
  const minimumPaths = safeInteger(
    record.minimumPaths,
    `${field}.minimumPaths`,
    0,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.paths,
    reject
  );
  const maximumPaths = safeInteger(
    record.maximumPaths,
    `${field}.maximumPaths`,
    1,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.paths,
    reject
  );
  if (minimumPaths > maximumPaths) reject("Path-policy cardinality bounds are reversed", { field });
  const orderedEdgeTemplateIds = arrayAt(
    record.orderedEdgeTemplateIds,
    `${field}.orderedEdgeTemplateIds`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
    1,
    reject
  ).map((entry, index) => identifier(entry, `${field}.orderedEdgeTemplateIds[${String(index)}]`, reject));
  return {
    id: identifier(record.id, `${field}.id`, reject),
    kind: enumValue(record.kind, contract.SYSTEM_ARCHITECTURE_PATH_KINDS, `${field}.kind`, reject),
    type: enumValue(record.type, contract.SYSTEM_ARCHITECTURE_PORT_TYPES, `${field}.type`, reject),
    protocol: enumValue(record.protocol, contract.SYSTEM_ARCHITECTURE_PROTOCOLS, `${field}.protocol`, reject),
    start: normalizePathEndpoint(record.start, `${field}.start`, roleIds, reject),
    end: normalizePathEndpoint(record.end, `${field}.end`, roleIds, reject),
    orderedEdgeTemplateIds,
    minimumPaths,
    maximumPaths
  };
};

const normalizeTopologySafeStatePolicy = (
  value: unknown,
  field: string,
  roleIds: ReadonlySet<string>,
  reject: Reject
): SystemArchitectureTopologySafeStatePolicy => {
  const record = recordAt(value, [
    "roleId", "portTemplateKey", "trigger", "action", "mechanism", "releaseCondition", "required"
  ], field, reject);
  const roleId = identifier(record.roleId, `${field}.roleId`, reject);
  if (!roleIds.has(roleId)) reject("Safe-state policy references an unknown topology role", { field });
  if (typeof record.required !== "boolean") reject("Safe-state policy required flag is invalid", { field });
  const tuple = normalizeSafeStateTuple({
    trigger: record.trigger,
    action: record.action,
    mechanism: record.mechanism,
    releaseCondition: record.releaseCondition
  }, `${field}.tuple`, reject);
  return {
    roleId,
    portTemplateKey: identifier(record.portTemplateKey, `${field}.portTemplateKey`, reject),
    ...tuple,
    required: record.required
  };
};

const normalizeRequirementAllocationPolicy = (
  value: unknown,
  field: string,
  roleIds: ReadonlySet<string>,
  reject: Reject
): SystemArchitectureRequirementAllocationPolicy => {
  const record = recordAt(value, [
    "category",
    "priority",
    "allowedTargetKinds",
    "allowedTopologyRoleIds",
    "allowedPathKinds",
    "minimumAllocations",
    "maximumAllocations"
  ], field, reject);
  const allowedTargetKinds = enumSet(
    record.allowedTargetKinds,
    contract.SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS,
    `${field}.allowedTargetKinds`,
    contract.SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS.length,
    1,
    reject
  );
  const allowedTopologyRoleIds = identifierSet(
    record.allowedTopologyRoleIds,
    `${field}.allowedTopologyRoleIds`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.rolesPerTopology,
    1,
    reject
  );
  if (allowedTopologyRoleIds.some((roleId) => !roleIds.has(roleId))) {
    reject("Requirement-allocation policy references an unknown topology role", { field });
  }
  const allowedPathKinds = enumSet(
    record.allowedPathKinds,
    contract.SYSTEM_ARCHITECTURE_PATH_KINDS,
    `${field}.allowedPathKinds`,
    contract.SYSTEM_ARCHITECTURE_PATH_KINDS.length,
    0,
    reject
  );
  if (allowedTargetKinds.includes("path") !== (allowedPathKinds.length > 0)) {
    reject("Requirement-allocation path kinds must be present exactly when path targets are allowed", { field });
  }
  const minimumAllocations = safeInteger(
    record.minimumAllocations,
    `${field}.minimumAllocations`,
    1,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.allocations,
    reject
  );
  const maximumAllocations = safeInteger(
    record.maximumAllocations,
    `${field}.maximumAllocations`,
    1,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.allocations,
    reject
  );
  if (minimumAllocations > maximumAllocations) reject("Requirement-allocation bounds are reversed", { field });
  return {
    category: enumValue(record.category, REQUIREMENT_CATEGORIES, `${field}.category`, reject),
    priority: enumValue(record.priority, REQUIREMENT_PRIORITIES, `${field}.priority`, reject),
    allowedTargetKinds,
    allowedTopologyRoleIds,
    allowedPathKinds,
    minimumAllocations,
    maximumAllocations
  };
};

const assertRolePortCompatibility = (
  role: SystemArchitectureTopologyRoleTemplate,
  portKey: string,
  direction: "driver" | "receiver" | "either",
  type: SystemArchitectureTopologyEdgeTemplate["type"] | null,
  protocol: SystemArchitectureTopologyEdgeTemplate["protocol"] | null,
  optionPortsById: ReadonlyMap<string, ReadonlyMap<string, SystemArchitecturePortTemplate>>,
  memo: Set<string>,
  budget: SemanticBudget,
  field: string,
  reject: Reject
): void => {
  const memoKey = `${role.id}\u0000${portKey}\u0000${direction}\u0000${type ?? ""}\u0000${protocol ?? ""}`;
  if (memo.has(memoKey)) return;
  for (const optionId of role.allowedOptionIds) {
    budget.spend();
    const template = optionPortsById.get(optionId)?.get(portKey);
    if (template === undefined) reject("Topology role port is not implemented by every allowed option", { field, optionId, portKey });
    if (direction === "driver" && template.direction === "input") {
      reject("Topology driver port cannot be input-only", { field, optionId, portKey });
    }
    if (direction === "receiver" && template.direction === "output") {
      reject("Topology receiver port cannot be output-only", { field, optionId, portKey });
    }
    if ((type !== null && template.type !== type) || (protocol !== null && template.protocol !== protocol)) {
      reject("Topology role port type or protocol differs across allowed options", { field, optionId, portKey });
    }
  }
  memo.add(memoKey);
};

const normalizeTopology = (
  value: unknown,
  field: string,
  optionsById: ReadonlyMap<string, SystemArchitectureOption>,
  optionPortsById: ReadonlyMap<string, ReadonlyMap<string, SystemArchitecturePortTemplate>>,
  safeTuplesByOptionPort: ReadonlyMap<string, ReadonlySet<string>>,
  work: SemanticBudget,
  reject: Reject
): SystemArchitectureTopologyTemplate => {
  const record = recordAt(value, [
    "id", "roles", "edges", "pathPolicies", "safeStatePolicies", "requirementAllocationPolicies"
  ], field, reject);
  const roles = arrayAt(
    record.roles,
    `${field}.roles`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.rolesPerTopology,
    1,
    reject
  ).map((entry, index) => normalizeTopologyRole(
    entry,
    `${field}.roles[${String(index)}]`,
    new Set(optionsById.keys()),
    reject
  ));
  const roleIds = roles.map(({ id }) => id);
  if (new Set(roleIds).size !== roleIds.length) reject("Topology contains duplicate role IDs", { field });
  roles.sort((left, right) => compareText(left.id, right.id));
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const compatibilityMemo = new Set<string>();

  const edges = arrayAt(
    record.edges,
    `${field}.edges`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.edgesPerTopology,
    0,
    reject
  ).map((entry, index) => normalizeTopologyEdge(
    entry,
    `${field}.edges[${String(index)}]`,
    new Set(roleIds),
    reject
  ));
  const edgeIds = edges.map(({ id }) => id);
  if (new Set(edgeIds).size !== edgeIds.length) reject("Topology contains duplicate edge-template IDs", { field });
  edges.sort((left, right) => compareText(left.id, right.id));
  const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const edge of edges) {
    assertRolePortCompatibility(
      rolesById.get(edge.driverRoleId)!,
      edge.driverPortTemplateKey,
      "driver",
      edge.type,
      edge.protocol,
      optionPortsById,
      compatibilityMemo,
      work,
      `${field}.edges.${edge.id}.driver`,
      reject
    );
    assertRolePortCompatibility(
      rolesById.get(edge.receiverRoleId)!,
      edge.receiverPortTemplateKey,
      "receiver",
      edge.type,
      edge.protocol,
      optionPortsById,
      compatibilityMemo,
      work,
      `${field}.edges.${edge.id}.receiver`,
      reject
    );
  }

  const pathPolicies = arrayAt(
    record.pathPolicies,
    `${field}.pathPolicies`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.pathPoliciesPerTopology,
    0,
    reject
  ).map((entry, index) => normalizePathPolicy(
    entry,
    `${field}.pathPolicies[${String(index)}]`,
    new Set(roleIds),
    reject
  ));
  const pathPolicyIds = pathPolicies.map(({ id }) => id);
  if (new Set(pathPolicyIds).size !== pathPolicyIds.length) reject("Topology contains duplicate path-policy IDs", { field });
  pathPolicies.sort((left, right) => compareText(left.id, right.id));
  const pathPoliciesById = new Map(pathPolicies.map((policy) => [policy.id, policy]));
  const edgeIdsByPathPolicy = new Map<string, ReadonlySet<string>>();
  for (const policy of pathPolicies) {
    work.spend(policy.orderedEdgeTemplateIds.length * 3 + 1);
    const sequence = policy.orderedEdgeTemplateIds.map((id) => edgesById.get(id));
    if (sequence.some((edge) => edge === undefined)) reject("Path policy references an unknown edge template", { field, pathPolicyId: policy.id });
    const concrete = sequence as readonly SystemArchitectureTopologyEdgeTemplate[];
    if (concrete.some((edge) => edge.type !== policy.type || edge.protocol !== policy.protocol)) {
      reject("Path policy mixes edge types or protocols", { field, pathPolicyId: policy.id });
    }
    const first = concrete[0]!;
    const last = concrete[concrete.length - 1]!;
    if (
      first.driverRoleId !== policy.start.roleId ||
      first.driverPortTemplateKey !== policy.start.portTemplateKey ||
      last.receiverRoleId !== policy.end.roleId ||
      last.receiverPortTemplateKey !== policy.end.portTemplateKey
    ) {
      reject("Path-policy endpoints do not match its exact edge sequence", { field, pathPolicyId: policy.id });
    }
    if (policy.kind === "high_di_dt_loop" && policy.start.roleId !== policy.end.roleId) {
      reject("High-di/dt loop policy must close on the same topology role", {
        field,
        pathPolicyId: policy.id
      });
    }
    for (let index = 1; index < concrete.length; index += 1) {
      if (concrete[index - 1]!.receiverRoleId !== concrete[index]!.driverRoleId) {
        reject("Path-policy edge sequence has an unreviewed internal role hop", { field, pathPolicyId: policy.id });
      }
    }
    edgeIdsByPathPolicy.set(policy.id, new Set(policy.orderedEdgeTemplateIds));
  }
  for (const edge of edges) {
    for (const policyId of edge.requiredPathPolicyIds) {
      work.spend();
      const policy = pathPoliciesById.get(policyId);
      if (policy === undefined || !edgeIdsByPathPolicy.get(policyId)?.has(edge.id)) {
        reject("Edge required-path policy is missing or does not contain the edge", { field, edgeId: edge.id, policyId });
      }
    }
  }

  const safeStatePolicies = arrayAt(
    record.safeStatePolicies,
    `${field}.safeStatePolicies`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.safeStatePoliciesPerTopology,
    0,
    reject
  ).map((entry, index) => normalizeTopologySafeStatePolicy(
    entry,
    `${field}.safeStatePolicies[${String(index)}]`,
    new Set(roleIds),
    reject
  ));
  // Without an explicit multi-action/group model, one role/port/trigger has one reviewed state.
  const safePolicyKeys = safeStatePolicies.map((policy) =>
    `${policy.roleId}\u0000${policy.portTemplateKey}\u0000${policy.trigger}`
  );
  if (new Set(safePolicyKeys).size !== safePolicyKeys.length) reject("Topology contains duplicate safe-state policies", { field });
  safeStatePolicies.sort((left, right) => compareText(
    `${left.roleId}\u0000${left.portTemplateKey}\u0000${left.trigger}`,
    `${right.roleId}\u0000${right.portTemplateKey}\u0000${right.trigger}`
  ));
  const safeCompatibilityMemo = new Set<string>();
  for (const policy of safeStatePolicies) {
    const role = rolesById.get(policy.roleId)!;
    assertRolePortCompatibility(
      role,
      policy.portTemplateKey,
      "either",
      null,
      null,
      optionPortsById,
      compatibilityMemo,
      work,
      field,
      reject
    );
    const safeMemoKey = `${role.id}\u0000${policy.portTemplateKey}\u0000${safeStateTupleKey(policy)}`;
    if (safeCompatibilityMemo.has(safeMemoKey)) continue;
    for (const optionId of role.allowedOptionIds) {
      work.spend();
      if (!safeTuplesByOptionPort.get(`${optionId}\u0000${policy.portTemplateKey}`)?.has(safeStateTupleKey(policy))) {
        reject("Topology safe-state tuple is not allowed by every role option", { field, optionId, roleId: role.id });
      }
    }
    safeCompatibilityMemo.add(safeMemoKey);
  }

  const allocationPolicies = arrayAt(
    record.requirementAllocationPolicies,
    `${field}.requirementAllocationPolicies`,
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.allocationPoliciesPerTopology,
    0,
    reject
  ).map((entry, index) => normalizeRequirementAllocationPolicy(
    entry,
    `${field}.requirementAllocationPolicies[${String(index)}]`,
    new Set(roleIds),
    reject
  ));
  const allocationPolicyKeys = allocationPolicies.map((policy) => `${policy.category}\u0000${policy.priority}`);
  if (new Set(allocationPolicyKeys).size !== allocationPolicyKeys.length) {
    reject("Topology contains duplicate category/priority allocation policies", { field });
  }
  allocationPolicies.sort((left, right) => compareText(
    `${left.category}\u0000${left.priority}`,
    `${right.category}\u0000${right.priority}`
  ));
  return {
    id: identifier(record.id, `${field}.id`, reject),
    roles,
    edges,
    pathPolicies,
    safeStatePolicies,
    requirementAllocationPolicies: allocationPolicies
  };
};

const snapshotSystemArchitectureTopologyCatalog = (
  value: unknown,
  optionCatalog: SystemArchitectureOptionCatalog,
  reject: Reject
): SystemArchitectureTopologyCatalog => {
  const snapshot = detached(value, "topologyCatalog", reject);
  const record = recordAt(snapshot, ["schemaVersion", "topologies", "identity"], "topologyCatalog", reject);
  if (record.schemaVersion !== contract.SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA) {
    reject("System architecture topology-catalog schema is invalid");
  }
  const optionsById = new Map(optionCatalog.options.map((option) => [option.id, option]));
  const work = new SemanticBudget(reject);
  work.spend(optionCatalog.options.reduce(
    (sum, option) => sum + option.portTemplates.length +
      option.portTemplates.reduce((tupleSum, port) => tupleSum + port.allowedSafeStateTuples.length, 0),
    0
  ));
  const optionPortsById = new Map<string, ReadonlyMap<string, SystemArchitecturePortTemplate>>(
    optionCatalog.options.map((option) => [
      option.id,
      new Map(option.portTemplates.map((port) => [port.key, port]))
    ])
  );
  const safeTuplesByOptionPort = new Map<string, ReadonlySet<string>>();
  for (const option of optionCatalog.options) {
    for (const port of option.portTemplates) {
      safeTuplesByOptionPort.set(
        `${option.id}\u0000${port.key}`,
        new Set(port.allowedSafeStateTuples.map(safeStateTupleKey))
      );
    }
  }
  const topologies = arrayAt(
    record.topologies,
    "topologyCatalog.topologies",
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.topologies,
    1,
    reject
  ).map((entry, index) => normalizeTopology(
    entry,
    `topologyCatalog.topologies[${String(index)}]`,
    optionsById,
    optionPortsById,
    safeTuplesByOptionPort,
    work,
    reject
  ));
  const ids = topologies.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) reject("Topology catalog contains duplicate topology IDs");
  topologies.sort((left, right) => compareText(left.id, right.id));
  const payload: SystemArchitectureTopologyCatalogPayload = {
    schemaVersion: contract.SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA,
    topologies
  };
  return withVerifiedIdentity(
    record,
    payload,
    contract.SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA,
    "topologyCatalog",
    reject
  );
};

export const validateAndSnapshotSystemArchitectureTopologyCatalog = (
  value: unknown,
  optionCatalogValue: unknown
): SystemArchitectureTopologyCatalog => {
  const options = snapshotSystemArchitectureOptionCatalog(optionCatalogValue, rejectInput);
  return snapshotSystemArchitectureTopologyCatalog(value, options, rejectInput);
};

const snapshotRequirementsDocument = (
  value: unknown,
  reject: Reject
): RequirementsDocument => {
  const snapshot = detached(value, "requirementsDocument", reject);
  const parsed = requirementsDocumentSchema.safeParse(snapshot);
  if (!parsed.success) {
    reject("Requirements document fails its closed runtime schema", {
      issues: parsed.error.issues.slice(0, 16).map((issue) => ({
        code: issue.code,
        path: issue.path.map(String)
      }))
    });
  }
  const document = parsed.data as RequirementsDocument;
  if (
    document.requirements.length === 0 ||
    document.requirements.length > contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.requirements ||
    document.approvalId === undefined
  ) {
    reject("System architecture requires a bounded approved requirements document");
  }
  identifier(document.approvalId, "requirementsDocument.approvalId", reject);
  const requirementIdSet = new Set<string>();
  for (const [index, requirement] of document.requirements.entries()) {
    const id = identifier(requirement.id, `requirementsDocument.requirements[${String(index)}].id`, reject);
    if (requirementIdSet.has(id)) reject("Requirements document contains duplicate requirement IDs", { id });
    requirementIdSet.add(id);
    if (requirement.sourceSpans.some((span) => span.end < span.start)) {
      reject("Requirement source span has reversed bounds", { id });
    }
  }
  for (const [key, entry] of Object.entries(document.constraints)) {
    if (
      Buffer.byteLength(key, "utf8") > 96 ||
      !/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(key) ||
      Buffer.byteLength(entry, "utf8") > 256
    ) {
      reject("Requirements normalized constraint entry is invalid", { key });
    }
  }
  const { identity: _identity, approvalId: _approvalId, ...identityPayload } = document;
  const expectedIdentity = deepFreeze(canonicalIdentity(identityPayload, "evleda.requirements.v1"));
  requireIdentity(
    canonicalIdentityAt(document.identity, "requirementsDocument.identity", "evleda.requirements.v1", reject),
    expectedIdentity,
    "requirementsDocument.identity",
    reject
  );
  return deepFreeze(document);
};

const snapshotRequirementsApproval = (
  value: unknown,
  reject: Reject
): ApprovalRecord => {
  const snapshot = detached(value, "requirementsApproval", reject);
  const parsed = approvalRecordSchema.safeParse(snapshot);
  if (!parsed.success) {
    reject("Requirements approval fails its closed runtime schema", {
      issues: parsed.error.issues.slice(0, 16).map((issue) => ({
        code: issue.code,
        path: issue.path.map(String)
      }))
    });
  }
  return deepFreeze(parsed.data as ApprovalRecord);
};

const approvalIdentity = (approval: ApprovalRecord): CanonicalIdentity => deepFreeze(
  canonicalIdentity(approval, contract.SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA)
);

const verificationInstant = (value: unknown): { readonly source: string; readonly epochMs: number } => {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    rejectInput("Provision verification time must be a bounded ISO timestamp");
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== value) {
    rejectInput("Provision verification time is invalid");
  }
  return deepFreeze({ source: value, epochMs });
};

const assertApprovalLocallyValid = (
  approval: ApprovalRecord,
  requirements: RequirementsDocument,
  verificationTime: { readonly epochMs: number }
): void => {
  if (
    approval.kind !== "requirements" ||
    approval.id !== requirements.approvalId ||
    approval.subjectDigest !== requirements.identity.digest ||
    approval.actor.type !== "human" ||
    approval.actor.role !== "requirements_reviewer" ||
    approval.revokedAt !== undefined ||
    Date.parse(approval.createdAt) > verificationTime.epochMs ||
    (approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= verificationTime.epochMs)
  ) {
    rejectPolicy("Requirements approval is missing, revoked, expired, future-dated, or not bound to the exact requirements document");
  }
};

interface InspectedProvision {
  readonly requirementsDocument: unknown;
  readonly requirementsApproval: unknown;
  readonly optionCatalog: unknown;
  readonly topologyCatalog: unknown;
  readonly pcbPracticeCatalog: unknown;
  readonly registry: unknown;
  readonly expectedIdentities: unknown;
  readonly verificationTime: unknown;
  readonly authenticateRequirementsApproval: (
    approval: ApprovalRecord,
    requirements: RequirementsDocument
  ) => void;
  readonly resolveAuthenticatedProposal: (receiptId: string) => Promise<unknown>;
}

const inspectProvision = (value: unknown): InspectedProvision => {
  if (!isRecord(value) || nodeTypes.isProxy(value)) {
    rejectInput("System architecture compiler provision must be a plain non-proxy object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    rejectInput("System architecture compiler provision must have a plain prototype");
  }
  const expectedKeys = [
    "requirementsDocument",
    "requirementsApproval",
    "optionCatalog",
    "topologyCatalog",
    "pcbPracticeCatalog",
    "registry",
    "expectedIdentities",
    "verificationTime",
    "authenticateRequirementsApproval",
    "resolveAuthenticatedProposal"
  ].sort(compareText);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key === "symbol") ||
    canonicalJson((ownKeys as string[]).sort(compareText)) !== canonicalJson(expectedKeys)
  ) {
    rejectInput("System architecture compiler provision contains missing or unknown fields");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      rejectInput("System architecture compiler provision fields must be enumerable data properties", { field: key });
    }
  }
  const authenticate = descriptors.authenticateRequirementsApproval!.value;
  const resolve = descriptors.resolveAuthenticatedProposal!.value;
  if (
    typeof authenticate !== "function" ||
    typeof resolve !== "function" ||
    nodeTypes.isProxy(authenticate) ||
    nodeTypes.isProxy(resolve)
  ) {
    rejectInput("System architecture compiler provision requires ordinary verifier closures");
  }
  return {
    requirementsDocument: descriptors.requirementsDocument!.value,
    requirementsApproval: descriptors.requirementsApproval!.value,
    optionCatalog: descriptors.optionCatalog!.value,
    topologyCatalog: descriptors.topologyCatalog!.value,
    pcbPracticeCatalog: descriptors.pcbPracticeCatalog!.value,
    registry: descriptors.registry!.value,
    expectedIdentities: descriptors.expectedIdentities!.value,
    verificationTime: descriptors.verificationTime!.value,
    authenticateRequirementsApproval: (approval, requirements) => {
      const result = Reflect.apply(authenticate, undefined, [approval, requirements]) as unknown;
      if (result !== undefined) {
        rejectPolicy("Requirements approval authenticator must be an opaque throw-or-return-void capability");
      }
    },
    resolveAuthenticatedProposal: async (receiptId) => await Reflect.apply(resolve, undefined, [receiptId]) as unknown
  };
};

const normalizeSelectedOption = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureSelectedOption => {
  const record = recordAt(value, ["optionId"], field, reject);
  return { optionId: identifier(record.optionId, `${field}.optionId`, reject) };
};

const normalizeIrNode = (value: unknown, field: string, reject: Reject): SystemArchitectureIrNode => {
  const record = recordAt(value, ["id", "topologyRoleId", "optionId", "requirementIds"], field, reject);
  return {
    id: identifier(record.id, `${field}.id`, reject),
    topologyRoleId: identifier(record.topologyRoleId, `${field}.topologyRoleId`, reject),
    optionId: identifier(record.optionId, `${field}.optionId`, reject),
    requirementIds: requirementIds(record.requirementIds, `${field}.requirementIds`, reject)
  };
};

const normalizeIrPort = (value: unknown, field: string, reject: Reject): SystemArchitectureIrPort => {
  const record = recordAt(value, [
    "id", "nodeId", "templateKey", "direction", "type", "protocol", "requirementIds"
  ], field, reject);
  return {
    id: identifier(record.id, `${field}.id`, reject),
    nodeId: identifier(record.nodeId, `${field}.nodeId`, reject),
    templateKey: identifier(record.templateKey, `${field}.templateKey`, reject),
    direction: enumValue(record.direction, contract.SYSTEM_ARCHITECTURE_PORT_DIRECTIONS, `${field}.direction`, reject),
    type: enumValue(record.type, contract.SYSTEM_ARCHITECTURE_PORT_TYPES, `${field}.type`, reject),
    protocol: enumValue(record.protocol, contract.SYSTEM_ARCHITECTURE_PROTOCOLS, `${field}.protocol`, reject),
    requirementIds: requirementIds(record.requirementIds, `${field}.requirementIds`, reject)
  };
};

const normalizeIrConnection = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureIrConnection => {
  const record = recordAt(value, [
    "id", "edgeTemplateId", "type", "protocol", "driverPortId", "receiverPortId", "requirementIds"
  ], field, reject);
  const driverPortId = identifier(record.driverPortId, `${field}.driverPortId`, reject);
  const receiverPortId = identifier(record.receiverPortId, `${field}.receiverPortId`, reject);
  if (driverPortId === receiverPortId) reject("Connection cannot use the same port as driver and receiver", { field });
  return {
    id: identifier(record.id, `${field}.id`, reject),
    edgeTemplateId: identifier(record.edgeTemplateId, `${field}.edgeTemplateId`, reject),
    type: enumValue(record.type, contract.SYSTEM_ARCHITECTURE_PORT_TYPES, `${field}.type`, reject),
    protocol: enumValue(record.protocol, contract.SYSTEM_ARCHITECTURE_PROTOCOLS, `${field}.protocol`, reject),
    driverPortId,
    receiverPortId,
    requirementIds: requirementIds(record.requirementIds, `${field}.requirementIds`, reject)
  };
};

const normalizeIrAllocation = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureIrAllocation => {
  const record = recordAt(value, ["id", "requirementId", "targetKind", "targetId"], field, reject);
  return {
    id: identifier(record.id, `${field}.id`, reject),
    requirementId: identifier(record.requirementId, `${field}.requirementId`, reject),
    targetKind: enumValue(
      record.targetKind,
      contract.SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS,
      `${field}.targetKind`,
      reject
    ),
    targetId: identifier(record.targetId, `${field}.targetId`, reject)
  };
};

const normalizeIrParameter = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureIrParameter => {
  const record = recordAt(value, [
    "id", "nodeId", "optionId", "targetKind", "targetId", "parameterKey", "requirementIds", "source"
  ], field, reject);
  const source = recordAt(
    record.source,
    ["valueSource", "requirementId", "normalizedConstraintKey"],
    `${field}.source`,
    reject
  );
  if (source.valueSource !== "approved_requirement") {
    reject("Architecture parameter source is not an approved requirement", { field });
  }
  return {
    id: identifier(record.id, `${field}.id`, reject),
    nodeId: identifier(record.nodeId, `${field}.nodeId`, reject),
    optionId: identifier(record.optionId, `${field}.optionId`, reject),
    targetKind: enumValue(record.targetKind, ["node", "port"] as const, `${field}.targetKind`, reject),
    targetId: identifier(record.targetId, `${field}.targetId`, reject),
    parameterKey: identifier(record.parameterKey, `${field}.parameterKey`, reject),
    requirementIds: requirementIds(record.requirementIds, `${field}.requirementIds`, reject),
    source: {
      valueSource: "approved_requirement",
      requirementId: identifier(source.requirementId, `${field}.source.requirementId`, reject),
      normalizedConstraintKey: identifier(
        source.normalizedConstraintKey,
        `${field}.source.normalizedConstraintKey`,
        reject
      )
    }
  };
};

const normalizeIrSafeState = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureIrSafeState => {
  const record = recordAt(value, [
    "id", "nodeId", "targetPortId", "trigger", "action", "mechanism", "releaseCondition", "requirementIds"
  ], field, reject);
  const tuple = normalizeSafeStateTuple({
    trigger: record.trigger,
    action: record.action,
    mechanism: record.mechanism,
    releaseCondition: record.releaseCondition
  }, `${field}.tuple`, reject);
  return {
    id: identifier(record.id, `${field}.id`, reject),
    nodeId: identifier(record.nodeId, `${field}.nodeId`, reject),
    targetPortId: identifier(record.targetPortId, `${field}.targetPortId`, reject),
    ...tuple,
    requirementIds: requirementIds(record.requirementIds, `${field}.requirementIds`, reject)
  };
};

const normalizeIrPath = (value: unknown, field: string, reject: Reject): SystemArchitectureIrPath => {
  const record = recordAt(value, [
    "id",
    "pathPolicyId",
    "kind",
    "type",
    "protocol",
    "startPortId",
    "endPortId",
    "orderedConnectionIds",
    "requirementIds"
  ], field, reject);
  return {
    id: identifier(record.id, `${field}.id`, reject),
    pathPolicyId: identifier(record.pathPolicyId, `${field}.pathPolicyId`, reject),
    kind: enumValue(record.kind, contract.SYSTEM_ARCHITECTURE_PATH_KINDS, `${field}.kind`, reject),
    type: enumValue(record.type, contract.SYSTEM_ARCHITECTURE_PORT_TYPES, `${field}.type`, reject),
    protocol: enumValue(record.protocol, contract.SYSTEM_ARCHITECTURE_PROTOCOLS, `${field}.protocol`, reject),
    startPortId: identifier(record.startPortId, `${field}.startPortId`, reject),
    endPortId: identifier(record.endPortId, `${field}.endPortId`, reject),
    orderedConnectionIds: identifierList(
      record.orderedConnectionIds,
      `${field}.orderedConnectionIds`,
      contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections,
      1,
      reject
    ),
    requirementIds: requirementIds(record.requirementIds, `${field}.requirementIds`, reject)
  };
};

const normalizeIrPracticeAllocation = (
  value: unknown,
  field: string,
  reject: Reject
): SystemArchitectureIrPracticeAllocation => {
  const record = recordAt(value, ["id", "practiceId", "targetKind", "targetId"], field, reject);
  return {
    id: identifier(record.id, `${field}.id`, reject),
    practiceId: identifier(record.practiceId, `${field}.practiceId`, reject),
    targetKind: enumValue(
      record.targetKind,
      contract.SYSTEM_ARCHITECTURE_ALLOCATION_TARGET_KINDS,
      `${field}.targetKind`,
      reject
    ),
    targetId: identifier(record.targetId, `${field}.targetId`, reject)
  };
};

const sortedRecords = <Value extends { readonly id: string }>(records: Value[]): readonly Value[] =>
  records.sort((left, right) => compareText(left.id, right.id));

const snapshotSystemArchitectureIr = (value: unknown, reject: Reject): SystemArchitectureIr => {
  const snapshot = detached(value, "ir", reject);
  const record = recordAt(snapshot, [
    "schemaVersion",
    "stage",
    "role",
    "classification",
    "authorityDisposition",
    "topologyTemplateId",
    "requirementsIdentity",
    "requirementsApprovalIdentity",
    "optionCatalogIdentity",
    "topologyCatalogIdentity",
    "pcbPracticeCatalogIdentity",
    "registryIdentity",
    "outputContractIdentity",
    "selectedOptions",
    "nodes",
    "ports",
    "connections",
    "allocations",
    "parameters",
    "safeStates",
    "paths",
    "practiceAllocations",
    "identity"
  ], "ir", reject);
  if (
    record.schemaVersion !== contract.SYSTEM_ARCHITECTURE_IR_SCHEMA ||
    record.stage !== "system_architecture" ||
    record.role !== "system_architect" ||
    record.classification !== "proposal_only" ||
    record.authorityDisposition !== "none"
  ) {
    reject("System architecture IR authority envelope is invalid");
  }
  const selectedOptions = arrayAt(
    record.selectedOptions,
    "ir.selectedOptions",
    contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.selectedOptions,
    1,
    reject
  ).map((entry, index) => normalizeSelectedOption(entry, `ir.selectedOptions[${String(index)}]`, reject));
  const selectedIds = selectedOptions.map(({ optionId }) => optionId);
  if (new Set(selectedIds).size !== selectedIds.length) reject("IR selected options contain duplicates");
  selectedOptions.sort((left, right) => compareText(left.optionId, right.optionId));
  const payload: SystemArchitectureIrPayload = {
    schemaVersion: contract.SYSTEM_ARCHITECTURE_IR_SCHEMA,
    stage: "system_architecture",
    role: "system_architect",
    classification: "proposal_only",
    authorityDisposition: "none",
    topologyTemplateId: identifier(record.topologyTemplateId, "ir.topologyTemplateId", reject),
    requirementsIdentity: canonicalIdentityAt(record.requirementsIdentity, "ir.requirementsIdentity", "evleda.requirements.v1", reject),
    requirementsApprovalIdentity: canonicalIdentityAt(
      record.requirementsApprovalIdentity,
      "ir.requirementsApprovalIdentity",
      contract.SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA,
      reject
    ),
    optionCatalogIdentity: canonicalIdentityAt(
      record.optionCatalogIdentity,
      "ir.optionCatalogIdentity",
      contract.SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA,
      reject
    ),
    topologyCatalogIdentity: canonicalIdentityAt(
      record.topologyCatalogIdentity,
      "ir.topologyCatalogIdentity",
      contract.SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA,
      reject
    ),
    pcbPracticeCatalogIdentity: canonicalIdentityAt(
      record.pcbPracticeCatalogIdentity,
      "ir.pcbPracticeCatalogIdentity",
      PCB_ENGINEERING_PRACTICE_SCHEMA,
      reject
    ),
    registryIdentity: canonicalIdentityAt(
      record.registryIdentity,
      "ir.registryIdentity",
      contract.SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA,
      reject
    ),
    outputContractIdentity: canonicalIdentityAt(
      record.outputContractIdentity,
      "ir.outputContractIdentity",
      DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA,
      reject
    ),
    selectedOptions,
    nodes: sortedRecords(arrayAt(record.nodes, "ir.nodes", contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.nodes, 1, reject)
      .map((entry, index) => normalizeIrNode(entry, `ir.nodes[${String(index)}]`, reject))),
    ports: sortedRecords(arrayAt(record.ports, "ir.ports", contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.ports, 1, reject)
      .map((entry, index) => normalizeIrPort(entry, `ir.ports[${String(index)}]`, reject))),
    connections: sortedRecords(arrayAt(record.connections, "ir.connections", contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.connections, 0, reject)
      .map((entry, index) => normalizeIrConnection(entry, `ir.connections[${String(index)}]`, reject))),
    allocations: sortedRecords(arrayAt(record.allocations, "ir.allocations", contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.allocations, 1, reject)
      .map((entry, index) => normalizeIrAllocation(entry, `ir.allocations[${String(index)}]`, reject))),
    parameters: sortedRecords(arrayAt(record.parameters, "ir.parameters", contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.parameters, 0, reject)
      .map((entry, index) => normalizeIrParameter(entry, `ir.parameters[${String(index)}]`, reject))),
    safeStates: sortedRecords(arrayAt(record.safeStates, "ir.safeStates", contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.safeStates, 0, reject)
      .map((entry, index) => normalizeIrSafeState(entry, `ir.safeStates[${String(index)}]`, reject))),
    paths: sortedRecords(arrayAt(record.paths, "ir.paths", contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.paths, 0, reject)
      .map((entry, index) => normalizeIrPath(entry, `ir.paths[${String(index)}]`, reject))),
    practiceAllocations: sortedRecords(arrayAt(
      record.practiceAllocations,
      "ir.practiceAllocations",
      contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.practiceAllocations,
      0,
      reject
    ).map((entry, index) => normalizeIrPracticeAllocation(
      entry,
      `ir.practiceAllocations[${String(index)}]`,
      reject
    )))
  };
  return withVerifiedIdentity(record, payload, contract.SYSTEM_ARCHITECTURE_IR_SCHEMA, "ir", reject);
};

export const validateAndSnapshotSystemArchitectureIr = (value: unknown): SystemArchitectureIr =>
  snapshotSystemArchitectureIr(value, rejectInput);

const snapshotDecisionRequest = (value: unknown): string => {
  const snapshot = detached(value, "request");
  const record = recordAt(snapshot, ["receiptId"], "request", rejectInput);
  return identifier(record.receiptId, "request.receiptId");
};

const snapshotResolvedProposal = (
  value: unknown,
  requestedReceiptId: string,
  reject: Reject
): ResolvedSystemArchitectureProposal => {
  const snapshot = detached(value, "resolvedProposal", reject);
  const record = recordAt(snapshot, [
    "schemaVersion",
    "receiptId",
    "replayReceiptIdentity",
    "replayIdentity",
    "proposalResultIdentity",
    "structuredProposalIdentity",
    "outputContractIdentity",
    "irIdentity",
    "irSnapshot",
    "identity"
  ], "resolvedProposal", reject);
  if (record.schemaVersion !== contract.SYSTEM_ARCHITECTURE_PROPOSAL_RESOLUTION_SCHEMA) {
    reject("Resolved architecture proposal schema is invalid");
  }
  const receiptId = identifier(record.receiptId, "resolvedProposal.receiptId", reject);
  const replayIdentity = canonicalIdentityAt(
    record.replayIdentity,
    "resolvedProposal.replayIdentity",
    DESIGN_AGENT_REPLAY_SCHEMA,
    reject
  );
  if (receiptId !== requestedReceiptId || receiptId !== `replay_${replayIdentity.digest}`) {
    reject("Resolved architecture proposal does not bind the requested replay receipt", {
      requestedReceiptId,
      receiptId
    });
  }
  const ir = snapshotSystemArchitectureIr(record.irSnapshot, reject);
  const irIdentity = canonicalIdentityAt(
    record.irIdentity,
    "resolvedProposal.irIdentity",
    contract.SYSTEM_ARCHITECTURE_IR_SCHEMA,
    reject
  );
  requireIdentity(ir.identity, irIdentity, "resolvedProposal.irIdentity", reject);
  const payload: ResolvedSystemArchitectureProposalPayload = {
    schemaVersion: contract.SYSTEM_ARCHITECTURE_PROPOSAL_RESOLUTION_SCHEMA,
    receiptId,
    replayReceiptIdentity: canonicalIdentityAt(
      record.replayReceiptIdentity,
      "resolvedProposal.replayReceiptIdentity",
      DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
      reject
    ),
    replayIdentity,
    proposalResultIdentity: canonicalIdentityAt(
      record.proposalResultIdentity,
      "resolvedProposal.proposalResultIdentity",
      DESIGN_AGENT_RESULT_SCHEMA,
      reject
    ),
    structuredProposalIdentity: canonicalIdentityAt(
      record.structuredProposalIdentity,
      "resolvedProposal.structuredProposalIdentity",
      DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
      reject
    ),
    outputContractIdentity: canonicalIdentityAt(
      record.outputContractIdentity,
      "resolvedProposal.outputContractIdentity",
      DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA,
      reject
    ),
    irIdentity,
    irSnapshot: ir
  };
  return withVerifiedIdentity(
    record,
    payload,
    contract.SYSTEM_ARCHITECTURE_PROPOSAL_RESOLUTION_SCHEMA,
    "resolvedProposal",
    reject
  );
};

interface PinnedProvision {
  readonly requirements: RequirementsDocument;
  readonly approval: ApprovalRecord;
  readonly optionCatalog: SystemArchitectureOptionCatalog;
  readonly topologyCatalog: SystemArchitectureTopologyCatalog;
  readonly pcbPracticeCatalog: PcbEngineeringPracticeCatalog;
  readonly registry: SystemArchitectureDecisionRegistry;
  readonly identities: SystemArchitectureDecisionExpectedIdentities;
  readonly constraintOwners: ReadonlyMap<string, string>;
  readonly resolveProposal: (receiptId: string) => Promise<unknown>;
}

const snapshotExpectedIdentities = (value: unknown): SystemArchitectureDecisionExpectedIdentities => {
  const snapshot = detached(value, "provision.expectedIdentities");
  const record = recordAt(snapshot, [
    "requirementsIdentity",
    "requirementsApprovalIdentity",
    "optionCatalogIdentity",
    "topologyCatalogIdentity",
    "pcbPracticeCatalogIdentity",
    "registryIdentity",
    "outputContractIdentity"
  ], "provision.expectedIdentities", rejectInput);
  return deepFreeze({
    requirementsIdentity: canonicalIdentityAt(record.requirementsIdentity, "expected.requirementsIdentity", "evleda.requirements.v1"),
    requirementsApprovalIdentity: canonicalIdentityAt(record.requirementsApprovalIdentity, "expected.requirementsApprovalIdentity", contract.SYSTEM_ARCHITECTURE_APPROVAL_IDENTITY_SCHEMA),
    optionCatalogIdentity: canonicalIdentityAt(record.optionCatalogIdentity, "expected.optionCatalogIdentity", contract.SYSTEM_ARCHITECTURE_OPTION_CATALOG_SCHEMA),
    topologyCatalogIdentity: canonicalIdentityAt(record.topologyCatalogIdentity, "expected.topologyCatalogIdentity", contract.SYSTEM_ARCHITECTURE_TOPOLOGY_CATALOG_SCHEMA),
    pcbPracticeCatalogIdentity: canonicalIdentityAt(record.pcbPracticeCatalogIdentity, "expected.pcbPracticeCatalogIdentity", PCB_ENGINEERING_PRACTICE_SCHEMA),
    registryIdentity: canonicalIdentityAt(record.registryIdentity, "expected.registryIdentity", contract.SYSTEM_ARCHITECTURE_DECISION_REGISTRY_SCHEMA),
    outputContractIdentity: canonicalIdentityAt(record.outputContractIdentity, "expected.outputContractIdentity", DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA)
  });
};

interface ConstraintOwnerIndex {
  readonly owners: ReadonlyMap<string, string>;
  readonly ambiguous: ReadonlySet<string>;
}

const deriveConstraintOwners = (requirements: RequirementsDocument): ConstraintOwnerIndex => {
  const candidates = new Map<string, Set<string>>();
  const add = (key: string, requirementId: string): void => {
    const owners = candidates.get(key) ?? new Set<string>();
    owners.add(requirementId);
    candidates.set(key, owners);
  };
  for (const requirement of requirements.requirements) {
    const normalized = requirement.normalizedValue;
    if (normalized === undefined) continue;
    const voltage = /^(-?(?:0|[1-9][0-9]*)):(-?(?:0|[1-9][0-9]*)):mV$/u.exec(normalized);
    if (
      voltage !== null &&
      requirements.constraints.input_voltage_min_mv === voltage[1] &&
      requirements.constraints.input_voltage_max_mv === voltage[2]
    ) {
      add("input_voltage_min_mv", requirement.id);
      add("input_voltage_max_mv", requirement.id);
    }
    const channels = /^(-?(?:0|[1-9][0-9]*)):channels$/u.exec(normalized);
    if (channels !== null && requirements.constraints.motor_channels === channels[1]) {
      add("motor_channels", requirement.id);
    }
    const motorCurrent = /^(-?(?:0|[1-9][0-9]*)):mA:rms:per_channel$/u.exec(normalized);
    if (motorCurrent !== null && requirements.constraints.motor_current_rms_ma === motorCurrent[1]) {
      add("motor_current_rms_ma", requirement.id);
    }
  }
  const owners = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, ids] of candidates) {
    if (ids.size === 1) owners.set(key, [...ids][0]!);
    else ambiguous.add(key);
  }
  return { owners, ambiguous };
};

const snapshotProvision = (
  provisionValue: SystemArchitectureDecisionCompilerProvision
): PinnedProvision => {
  // Capture every descriptor before invoking either opaque authority closure.
  const provision = inspectProvision(provisionValue);
  const identities = snapshotExpectedIdentities(provision.expectedIdentities);
  const requirements = snapshotRequirementsDocument(provision.requirementsDocument, rejectInput);
  const approval = snapshotRequirementsApproval(provision.requirementsApproval, rejectInput);
  const optionCatalog = snapshotSystemArchitectureOptionCatalog(provision.optionCatalog, rejectInput);
  const topologyCatalog = snapshotSystemArchitectureTopologyCatalog(
    provision.topologyCatalog,
    optionCatalog,
    rejectInput
  );
  // Apply this module's aggregate/key/primitive budget before the catalog's own strict validator.
  assertPlainDataGraph(provision.pcbPracticeCatalog, "pcbPracticeCatalog", rejectInput);
  const pcbPracticeCatalog = validateAndSnapshotPcbEngineeringPracticeCatalog(
    provision.pcbPracticeCatalog
  );
  const registry = snapshotSystemArchitectureDecisionRegistry(provision.registry, rejectInput);
  const constraintOwnerIndex = deriveConstraintOwners(requirements);

  requireIdentity(requirements.identity, identities.requirementsIdentity, "requirements", rejectPolicy);
  const computedApprovalIdentity = approvalIdentity(approval);
  requireIdentity(
    computedApprovalIdentity,
    identities.requirementsApprovalIdentity,
    "requirementsApproval",
    rejectPolicy
  );
  requireIdentity(optionCatalog.identity, identities.optionCatalogIdentity, "optionCatalog", rejectPolicy);
  requireIdentity(topologyCatalog.identity, identities.topologyCatalogIdentity, "topologyCatalog", rejectPolicy);
  requireIdentity(
    pcbPracticeCatalog.identity,
    identities.pcbPracticeCatalogIdentity,
    "pcbPracticeCatalog",
    rejectPolicy
  );
  requireIdentity(registry.identity, identities.registryIdentity, "registry", rejectPolicy);
  requireIdentity(
    identities.outputContractIdentity,
    DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
    "outputContract",
    rejectPolicy
  );

  const verificationTime = verificationInstant(provision.verificationTime);
  assertApprovalLocallyValid(approval, requirements, verificationTime);
  try {
    provision.authenticateRequirementsApproval(approval, requirements);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    rejectPolicy("Host requirements-approval authenticator rejected the pinned record");
  }

  const practiceIds = new Set(pcbPracticeCatalog.rules.map(({ id }) => id));
  const requirementById = new Map(requirements.requirements.map((requirement) => [requirement.id, requirement]));
  for (const option of optionCatalog.options) {
    for (const domain of option.parameterDomains) {
      for (const source of domain.allowedRequirementSources) {
        if (constraintOwnerIndex.ambiguous.has(source.normalizedConstraintKey)) {
          rejectPolicy("Parameter-domain constraint key has ambiguous originating requirements", {
            optionId: option.id,
            constraintKey: source.normalizedConstraintKey
          });
        }
        const ownerId = constraintOwnerIndex.owners.get(source.normalizedConstraintKey);
        const owner = requirementById.get(ownerId ?? "");
        if (
          owner === undefined ||
          owner.category !== source.category ||
          owner.priority !== source.priority
        ) {
          rejectPolicy("Parameter-domain constraint key has no exact compatible originating requirement", {
            optionId: option.id,
            constraintKey: source.normalizedConstraintKey
          });
        }
      }
    }
    for (const practice of option.requiredPractices) {
      if (!practiceIds.has(practice.practiceId)) {
        rejectPolicy("Option catalog references a practice outside the full pinned PCB catalog", {
          optionId: option.id,
          practiceId: practice.practiceId
        });
      }
    }
  }
  return deepFreeze({
    requirements,
    approval,
    optionCatalog,
    topologyCatalog,
    pcbPracticeCatalog,
    registry,
    identities,
    constraintOwners: constraintOwnerIndex.owners,
    resolveProposal: provision.resolveAuthenticatedProposal
  });
};

class SemanticBudget {
  private used = 0;

  public constructor(private readonly reject: Reject = rejectInput) {}

  public spend(amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) this.reject("Semantic work increment is invalid");
    this.used += amount;
    if (this.used > contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.semanticOperations) {
      this.reject("System architecture semantic operation budget exceeded", {
        limit: contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.semanticOperations
      });
    }
  }
}

class IssueAccumulator {
  private readonly values = new Map<string, SystemArchitectureDecisionIssue>();

  public constructor(private readonly budget: SemanticBudget) {}

  public add(
    code: SystemArchitectureDecisionIssueCode,
    entityId: string | null,
    requirementIdValues: readonly string[] = []
  ): void {
    this.budget.spend();
    const ids = [...new Set(requirementIdValues)].sort(compareText);
    const key = `${code}\u0000${entityId ?? ""}\u0000${ids.join("\u0000")}`;
    if (!this.values.has(key)) {
      if (this.values.size >= contract.SYSTEM_ARCHITECTURE_DECISION_LIMITS.issues) {
        rejectInput("System architecture issue limit exceeded");
      }
      this.values.set(key, { code, entityId, requirementIds: ids });
    }
  }

  public list(): readonly SystemArchitectureDecisionIssue[] {
    return [...this.values.values()].sort((left, right) => compareText(
      `${left.code}\u0000${left.entityId ?? ""}\u0000${left.requirementIds.join("\u0000")}`,
      `${right.code}\u0000${right.entityId ?? ""}\u0000${right.requirementIds.join("\u0000")}`
    ));
  }
}

const requiredOperationsFor = (ir: SystemArchitectureIr): readonly SystemArchitectureDecisionOperation[] => {
  const operations: SystemArchitectureDecisionOperation[] = [
    "select_topology",
    "select_option",
    "instantiate_node",
    "declare_port",
    "allocate_requirement"
  ];
  if (ir.connections.length > 0) operations.push("connect_ports");
  if (ir.parameters.length > 0) operations.push("bind_parameter");
  if (ir.safeStates.length > 0) operations.push("declare_safe_state");
  if (ir.paths.length > 0) operations.push("declare_path");
  if (ir.practiceAllocations.length > 0) operations.push("allocate_practice");
  return [...new Set(operations)].sort(compareText);
};

const parseRequirementConstraint = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || Object.is(number, -0)) return null;
  return number;
};

const PARAMETER_UNIT_CONSTRAINT_SUFFIX: Readonly<Record<SystemArchitectureParameterUnit, string | null>> =
  Object.freeze({
    count: null,
    millivolt: "_mv",
    milliampere: "_ma",
    milliwatt: "_mw",
    hertz: "_hz",
    nanosecond: "_ns",
    micrometre: "_um",
    degree_celsius: "_c"
  });

const subsetOf = (
  values: readonly string[],
  allowed: ReadonlySet<string>,
  budget: SemanticBudget
): boolean => {
  budget.spend(values.length);
  return values.every((value) => allowed.has(value));
};

const compileFromPinned = (
  pinned: PinnedProvision,
  resolution: ResolvedSystemArchitectureProposal
): SystemArchitectureDecisionCompilation => {
  const budget = new SemanticBudget();
  const issues = new IssueAccumulator(budget);
  const ir = resolution.irSnapshot;
  const identityPairs: readonly (readonly [CanonicalIdentity, CanonicalIdentity])[] = [
    [ir.requirementsIdentity, pinned.identities.requirementsIdentity],
    [ir.requirementsApprovalIdentity, pinned.identities.requirementsApprovalIdentity],
    [ir.optionCatalogIdentity, pinned.identities.optionCatalogIdentity],
    [ir.topologyCatalogIdentity, pinned.identities.topologyCatalogIdentity],
    [ir.pcbPracticeCatalogIdentity, pinned.identities.pcbPracticeCatalogIdentity],
    [ir.registryIdentity, pinned.identities.registryIdentity],
    [ir.outputContractIdentity, pinned.identities.outputContractIdentity],
    [resolution.outputContractIdentity, pinned.identities.outputContractIdentity]
  ];
  for (const [actual, expected] of identityPairs) {
    budget.spend();
    if (!identitiesEqual(actual, expected)) issues.add("INPUT_IDENTITY_MISMATCH", null);
  }

  budget.spend(pinned.topologyCatalog.topologies.length);
  const topologiesById = new Map(pinned.topologyCatalog.topologies.map((entry) => [entry.id, entry]));
  const topology = topologiesById.get(ir.topologyTemplateId);
  if (topology === undefined) issues.add("TOPOLOGY_TEMPLATE_MISSING", ir.topologyTemplateId);
  const roles = new Map((topology?.roles ?? []).map((role) => [role.id, role]));
  budget.spend([...roles.values()].reduce((sum, role) => sum + role.allowedOptionIds.length, 0));
  const allowedOptionsByRole = new Map(
    [...roles].map(([id, role]) => [id, new Set(role.allowedOptionIds)])
  );
  const edgeTemplates = new Map((topology?.edges ?? []).map((edge) => [edge.id, edge]));
  const pathPolicies = new Map((topology?.pathPolicies ?? []).map((policy) => [policy.id, policy]));
  const options = new Map(pinned.optionCatalog.options.map((option) => [option.id, option]));
  const requirements = new Map(pinned.requirements.requirements.map((requirement) => [requirement.id, requirement]));
  const nodes = new Map(ir.nodes.map((node) => [node.id, node]));
  const ports = new Map(ir.ports.map((port) => [port.id, port]));
  const connections = new Map(ir.connections.map((connection) => [connection.id, connection]));
  const parameters = new Map(ir.parameters.map((parameter) => [parameter.id, parameter]));
  const safeStates = new Map(ir.safeStates.map((state) => [state.id, state]));
  const paths = new Map(ir.paths.map((path) => [path.id, path]));
  const portTemplatesByOption = new Map<string, ReadonlyMap<string, SystemArchitecturePortTemplate>>();
  const parameterDomainsByOption = new Map<string, ReadonlyMap<string, SystemArchitectureParameterDomain>>();
  for (const option of pinned.optionCatalog.options) {
    budget.spend(option.portTemplates.length + option.parameterDomains.length);
    portTemplatesByOption.set(option.id, new Map(option.portTemplates.map((port) => [port.key, port])));
    parameterDomainsByOption.set(option.id, new Map(option.parameterDomains.map((domain) => [
      `${domain.targetKind}\u0000${domain.targetTemplateKey ?? ""}\u0000${domain.key}`,
      domain
    ])));
  }

  const globalIds = new Map<string, string>();
  const register = (id: string, kind: string, requirementIdValues: readonly string[] = []): void => {
    budget.spend();
    if (globalIds.has(id)) issues.add("GLOBAL_ID_DUPLICATE", id, requirementIdValues);
    else globalIds.set(id, kind);
  };
  for (const node of ir.nodes) register(node.id, "node", node.requirementIds);
  for (const port of ir.ports) register(port.id, "port", port.requirementIds);
  for (const connection of ir.connections) register(connection.id, "connection", connection.requirementIds);
  for (const allocation of ir.allocations) register(allocation.id, "allocation", [allocation.requirementId]);
  for (const parameter of ir.parameters) register(parameter.id, "parameter", parameter.requirementIds);
  for (const state of ir.safeStates) register(state.id, "safe_state", state.requirementIds);
  for (const path of ir.paths) register(path.id, "path", path.requirementIds);
  for (const allocation of ir.practiceAllocations) register(allocation.id, "practice_allocation");

  const selectedOptionIds = new Set(ir.selectedOptions.map(({ optionId }) => optionId));
  const usedOptionIds = new Set(ir.nodes.map(({ optionId }) => optionId));
  for (const optionId of selectedOptionIds) {
    budget.spend();
    if (!options.has(optionId)) issues.add("CATALOG_OPTION_MISSING", optionId);
    if (!usedOptionIds.has(optionId)) issues.add("OPTION_UNUSED", optionId);
  }
  for (const node of ir.nodes) {
    budget.spend();
    if (!selectedOptionIds.has(node.optionId)) issues.add("OPTION_NOT_SELECTED", node.id, node.requirementIds);
    const option = options.get(node.optionId);
    if (option === undefined) issues.add("CATALOG_OPTION_MISSING", node.id, node.requirementIds);
    const role = roles.get(node.topologyRoleId);
    if (role === undefined) issues.add("TOPOLOGY_ROLE_MISSING", node.id, node.requirementIds);
    else if (!allowedOptionsByRole.get(role.id)!.has(node.optionId)) {
      issues.add("TOPOLOGY_ROLE_OPTION_FORBIDDEN", node.id, node.requirementIds);
    }
    for (const requirementId of node.requirementIds) {
      if (!requirements.has(requirementId)) issues.add("REQUIREMENT_REFERENCE_MISSING", node.id, [requirementId]);
    }
  }
  const roleInstanceCounts = new Map<string, number>();
  for (const node of ir.nodes) {
    budget.spend();
    roleInstanceCounts.set(node.topologyRoleId, (roleInstanceCounts.get(node.topologyRoleId) ?? 0) + 1);
  }
  for (const role of topology?.roles ?? []) {
    budget.spend();
    const count = roleInstanceCounts.get(role.id) ?? 0;
    if (count < role.minimumInstances || count > role.maximumInstances) {
      issues.add("TOPOLOGY_ROLE_CARDINALITY_INVALID", role.id);
    }
  }

  const portTemplatesByPort = new Map<string, SystemArchitecturePortTemplate>();
  const portByNodeTemplate = new Map<string, SystemArchitectureIrPort>();
  for (const port of ir.ports) {
    budget.spend();
    const node = nodes.get(port.nodeId);
    if (node === undefined) {
      issues.add("PORT_TEMPLATE_MISSING", port.id, port.requirementIds);
      continue;
    }
    const option = options.get(node.optionId);
    const template = option === undefined
      ? undefined
      : portTemplatesByOption.get(option.id)?.get(port.templateKey);
    if (template === undefined) {
      issues.add("PORT_TEMPLATE_MISSING", port.id, port.requirementIds);
      continue;
    }
    portTemplatesByPort.set(port.id, template);
    const nodeTemplateKey = `${node.id}\u0000${template.key}`;
    if (portByNodeTemplate.has(nodeTemplateKey)) issues.add("PORT_TEMPLATE_DUPLICATE", port.id, port.requirementIds);
    else portByNodeTemplate.set(nodeTemplateKey, port);
    if (port.direction !== template.direction) issues.add("PORT_DIRECTION_MISMATCH", port.id, port.requirementIds);
    if (port.type !== template.type) issues.add("PORT_TYPE_MISMATCH", port.id, port.requirementIds);
    if (port.protocol !== template.protocol) issues.add("PORT_PROTOCOL_MISMATCH", port.id, port.requirementIds);
    if (!subsetOf(port.requirementIds, new Set(node.requirementIds), budget)) {
      issues.add("REQUIREMENT_PROPAGATION_MISMATCH", port.id, port.requirementIds);
    }
    for (const requirementId of port.requirementIds) {
      if (!requirements.has(requirementId)) issues.add("REQUIREMENT_REFERENCE_MISSING", port.id, [requirementId]);
    }
  }
  for (const node of ir.nodes) {
    const option = options.get(node.optionId);
    for (const template of option?.portTemplates ?? []) {
      budget.spend();
      if (!portByNodeTemplate.has(`${node.id}\u0000${template.key}`)) {
        issues.add("PORT_TEMPLATE_MISSING", node.id, node.requirementIds);
      }
    }
  }

  const connectionCountsByPort = new Map<string, number>();
  const connectionCountsByEdge = new Map<string, number>();
  const fanoutCounts = new Map<string, number>();
  const faninCounts = new Map<string, number>();
  const endpointPairs = new Set<string>();
  for (const connection of ir.connections) {
    budget.spend();
    const driver = ports.get(connection.driverPortId);
    const receiver = ports.get(connection.receiverPortId);
    const edge = edgeTemplates.get(connection.edgeTemplateId);
    if (driver === undefined || receiver === undefined) {
      issues.add("CONNECTION_ENDPOINT_MISSING", connection.id, connection.requirementIds);
      continue;
    }
    connectionCountsByPort.set(driver.id, (connectionCountsByPort.get(driver.id) ?? 0) + 1);
    connectionCountsByPort.set(receiver.id, (connectionCountsByPort.get(receiver.id) ?? 0) + 1);
    const pair = `${driver.id}\u0000${receiver.id}`;
    if (endpointPairs.has(pair)) issues.add("CONNECTION_DUPLICATE_ENDPOINT", connection.id, connection.requirementIds);
    endpointPairs.add(pair);
    if (edge === undefined) {
      issues.add("CONNECTION_EDGE_TEMPLATE_MISSING", connection.id, connection.requirementIds);
      continue;
    }
    connectionCountsByEdge.set(edge.id, (connectionCountsByEdge.get(edge.id) ?? 0) + 1);
    const driverNode = nodes.get(driver.nodeId);
    const receiverNode = nodes.get(receiver.nodeId);
    if (
      driverNode === undefined ||
      receiverNode === undefined ||
      driverNode.topologyRoleId !== edge.driverRoleId ||
      receiverNode.topologyRoleId !== edge.receiverRoleId ||
      driver.templateKey !== edge.driverPortTemplateKey ||
      receiver.templateKey !== edge.receiverPortTemplateKey ||
      driver.direction === "input" ||
      receiver.direction === "output"
    ) {
      issues.add("CONNECTION_EDGE_FORBIDDEN", connection.id, connection.requirementIds);
    }
    if (connection.type !== edge.type || driver.type !== edge.type || receiver.type !== edge.type) {
      issues.add("CONNECTION_TYPE_MISMATCH", connection.id, connection.requirementIds);
    }
    if (
      connection.protocol !== edge.protocol ||
      driver.protocol !== edge.protocol ||
      receiver.protocol !== edge.protocol
    ) {
      issues.add("CONNECTION_PROTOCOL_MISMATCH", connection.id, connection.requirementIds);
    }
    const fanoutKey = `${edge.id}\u0000${driver.id}`;
    const faninKey = `${edge.id}\u0000${receiver.id}`;
    fanoutCounts.set(fanoutKey, (fanoutCounts.get(fanoutKey) ?? 0) + 1);
    faninCounts.set(faninKey, (faninCounts.get(faninKey) ?? 0) + 1);
    if ((fanoutCounts.get(fanoutKey) ?? 0) > edge.maximumFanoutPerDriverPort) {
      issues.add("CONNECTION_FANOUT_INVALID", connection.id, connection.requirementIds);
    }
    if ((faninCounts.get(faninKey) ?? 0) > edge.maximumFaninPerReceiverPort) {
      issues.add("CONNECTION_FANIN_INVALID", connection.id, connection.requirementIds);
    }
    const driverRequirements = new Set(driver.requirementIds);
    const receiverRequirements = new Set(receiver.requirementIds);
    if (
      !subsetOf(connection.requirementIds, driverRequirements, budget) ||
      !subsetOf(connection.requirementIds, receiverRequirements, budget)
    ) {
      issues.add("REQUIREMENT_PROPAGATION_MISMATCH", connection.id, connection.requirementIds);
    }
    for (const requirementId of connection.requirementIds) {
      if (!requirements.has(requirementId)) issues.add("REQUIREMENT_REFERENCE_MISSING", connection.id, [requirementId]);
    }
  }
  for (const port of ir.ports) {
    budget.spend();
    const template = portTemplatesByPort.get(port.id);
    const count = connectionCountsByPort.get(port.id) ?? 0;
    if (template !== undefined && (count < template.minimumConnections || count > template.maximumConnections)) {
      issues.add("PORT_CARDINALITY_INVALID", port.id, port.requirementIds);
    }
  }
  for (const edge of topology?.edges ?? []) {
    budget.spend();
    const count = connectionCountsByEdge.get(edge.id) ?? 0;
    if (count < edge.minimumConnections || count > edge.maximumConnections) {
      issues.add("CONNECTION_EDGE_CARDINALITY_INVALID", edge.id);
    }
  }

  const pathCoverage = new Map<string, Set<string>>();
  const pathCountsByPolicy = new Map<string, number>();
  budget.spend(ir.connections.reduce((sum, connection) => sum + connection.requirementIds.length, 0));
  const connectionRequirementSets = new Map(
    ir.connections.map((connection) => [connection.id, new Set(connection.requirementIds)])
  );
  for (const path of ir.paths) {
    budget.spend(path.orderedConnectionIds.length + 1);
    const policy = pathPolicies.get(path.pathPolicyId);
    if (policy === undefined) {
      issues.add("PATH_POLICY_MISSING", path.id, path.requirementIds);
      continue;
    }
    pathCountsByPolicy.set(policy.id, (pathCountsByPolicy.get(policy.id) ?? 0) + 1);
    if (path.kind !== policy.kind) issues.add("PATH_KIND_MISMATCH", path.id, path.requirementIds);
    if (path.type !== policy.type) issues.add("PATH_TYPE_MISMATCH", path.id, path.requirementIds);
    if (path.protocol !== policy.protocol) issues.add("PATH_PROTOCOL_MISMATCH", path.id, path.requirementIds);
    const members = path.orderedConnectionIds.map((id) => connections.get(id));
    budget.spend(members.length);
    if (members.some((member) => member === undefined)) {
      issues.add("PATH_CONNECTION_MISSING", path.id, path.requirementIds);
      continue;
    }
    const concrete = members as readonly SystemArchitectureIrConnection[];
    budget.spend(concrete.length);
    if (
      concrete.length !== policy.orderedEdgeTemplateIds.length ||
      concrete.some((member, index) => member.edgeTemplateId !== policy.orderedEdgeTemplateIds[index])
    ) {
      issues.add("PATH_EDGE_SEQUENCE_MISMATCH", path.id, path.requirementIds);
    }
    const first = concrete[0]!;
    const last = concrete[concrete.length - 1]!;
    const startPort = ports.get(first.driverPortId);
    const endPort = ports.get(last.receiverPortId);
    const startNode = startPort === undefined ? undefined : nodes.get(startPort.nodeId);
    const endNode = endPort === undefined ? undefined : nodes.get(endPort.nodeId);
    if (
      path.startPortId !== first.driverPortId ||
      path.endPortId !== last.receiverPortId ||
      startPort?.templateKey !== policy.start.portTemplateKey ||
      startNode?.topologyRoleId !== policy.start.roleId ||
      endPort?.templateKey !== policy.end.portTemplateKey ||
      endNode?.topologyRoleId !== policy.end.roleId
    ) {
      issues.add("PATH_ENDPOINT_MISMATCH", path.id, path.requirementIds);
    }
    if (path.kind === "high_di_dt_loop" && startNode?.id !== endNode?.id) {
      issues.add("PATH_LOOP_NOT_CLOSED", path.id, path.requirementIds);
    }
    for (let index = 1; index < concrete.length; index += 1) {
      const previousReceiver = ports.get(concrete[index - 1]!.receiverPortId);
      const nextDriver = ports.get(concrete[index]!.driverPortId);
      if (previousReceiver === undefined || nextDriver === undefined || previousReceiver.nodeId !== nextDriver.nodeId) {
        issues.add("PATH_INTERNAL_HOP_MISMATCH", path.id, path.requirementIds);
      }
    }
    for (const member of concrete) {
      let coverage = pathCoverage.get(member.id);
      if (coverage === undefined) {
        coverage = new Set<string>();
        pathCoverage.set(member.id, coverage);
      }
      coverage.add(policy.id);
    }
    let propagationMismatch = false;
    for (const requirementId of path.requirementIds) {
      for (const member of concrete) {
        budget.spend();
        if (!connectionRequirementSets.get(member.id)!.has(requirementId)) propagationMismatch = true;
      }
    }
    if (propagationMismatch) {
      issues.add("REQUIREMENT_PROPAGATION_MISMATCH", path.id, path.requirementIds);
    }
    for (const requirementId of path.requirementIds) {
      if (!requirements.has(requirementId)) issues.add("REQUIREMENT_REFERENCE_MISSING", path.id, [requirementId]);
    }
  }
  for (const policy of topology?.pathPolicies ?? []) {
    budget.spend();
    const count = pathCountsByPolicy.get(policy.id) ?? 0;
    if (count < policy.minimumPaths || count > policy.maximumPaths) {
      issues.add("PATH_CARDINALITY_INVALID", policy.id);
    }
  }
  for (const connection of ir.connections) {
    budget.spend();
    const edge = edgeTemplates.get(connection.edgeTemplateId);
    const coverage = pathCoverage.get(connection.id) ?? new Set<string>();
    budget.spend(edge?.requiredPathPolicyIds.length ?? 0);
    if (coverage.size === 0 || edge?.requiredPathPolicyIds.some((id) => !coverage.has(id))) {
      issues.add("CONNECTION_PATH_COVERAGE_MISSING", connection.id, connection.requirementIds);
    }
  }

  const topologySafePolicies = new Set((topology?.safeStatePolicies ?? []).map((policy) =>
    `${policy.roleId}\u0000${policy.portTemplateKey}\u0000${safeStateTupleKey(policy)}`
  ));
  budget.spend(topology?.safeStatePolicies.length ?? 0);
  const allowedSafeTupleKeysByPort = new Map<string, ReadonlySet<string>>();
  for (const [portId, template] of portTemplatesByPort) {
    budget.spend(template.allowedSafeStateTuples.length);
    allowedSafeTupleKeysByPort.set(
      portId,
      new Set(template.allowedSafeStateTuples.map(safeStateTupleKey))
    );
  }
  const safeStateKeys = new Set<string>();
  for (const state of ir.safeStates) {
    budget.spend();
    const node = nodes.get(state.nodeId);
    const port = ports.get(state.targetPortId);
    if (port === undefined) {
      issues.add("SAFE_STATE_TARGET_MISSING", state.id, state.requirementIds);
      continue;
    }
    if (node === undefined || port.nodeId !== state.nodeId) {
      issues.add("SAFE_STATE_NODE_MISMATCH", state.id, state.requirementIds);
      continue;
    }
    const template = portTemplatesByPort.get(port.id);
    const tupleKey = safeStateTupleKey(state);
    if (template === undefined || !allowedSafeTupleKeysByPort.get(port.id)?.has(tupleKey)) {
      issues.add("SAFE_STATE_TUPLE_NOT_ALLOWED", state.id, state.requirementIds);
    }
    if (!topologySafePolicies.has(`${node.topologyRoleId}\u0000${port.templateKey}\u0000${tupleKey}`)) {
      issues.add("SAFE_STATE_TOPOLOGY_POLICY_MISSING", state.id, state.requirementIds);
    }
    const instanceKey = `${port.id}\u0000${state.trigger}`;
    if (safeStateKeys.has(instanceKey)) issues.add("SAFE_STATE_DUPLICATE", state.id, state.requirementIds);
    safeStateKeys.add(instanceKey);
    if (
      !subsetOf(state.requirementIds, new Set(node.requirementIds), budget) ||
      !subsetOf(state.requirementIds, new Set(port.requirementIds), budget)
    ) {
      issues.add("REQUIREMENT_PROPAGATION_MISMATCH", state.id, state.requirementIds);
    }
    for (const requirementId of state.requirementIds) {
      if (!requirements.has(requirementId)) issues.add("REQUIREMENT_REFERENCE_MISSING", state.id, [requirementId]);
    }
  }
  for (const policy of topology?.safeStatePolicies ?? []) {
    if (!policy.required) continue;
    for (const node of ir.nodes) {
      if (node.topologyRoleId !== policy.roleId) continue;
      budget.spend();
      const port = portByNodeTemplate.get(`${node.id}\u0000${policy.portTemplateKey}`);
      if (port === undefined || !safeStateKeys.has(`${port.id}\u0000${policy.trigger}`)) {
        issues.add("SAFE_STATE_TOPOLOGY_POLICY_MISSING", node.id, node.requirementIds);
      }
    }
  }

  const compiledParameterById = new Map<string, CompiledSystemArchitectureParameter>();
  const parameterByTargetKey = new Map<string, CompiledSystemArchitectureParameter>();
  for (const parameter of ir.parameters) {
    budget.spend();
    const node = nodes.get(parameter.nodeId);
    const option = options.get(parameter.optionId);
    if (node === undefined || option === undefined || node.optionId !== parameter.optionId) {
      issues.add("PARAMETER_TARGET_MISMATCH", parameter.id, parameter.requirementIds);
      continue;
    }
    const targetPort = parameter.targetKind === "port" ? ports.get(parameter.targetId) : undefined;
    if (
      (parameter.targetKind === "node" && parameter.targetId !== node.id) ||
      (parameter.targetKind === "port" && (targetPort === undefined || targetPort.nodeId !== node.id))
    ) {
      issues.add("PARAMETER_TARGET_MISMATCH", parameter.id, parameter.requirementIds);
      continue;
    }
    const domain = parameterDomainsByOption.get(option.id)?.get(
      `${parameter.targetKind}\u0000${parameter.targetKind === "port" ? targetPort!.templateKey : ""}\u0000${parameter.parameterKey}`
    );
    if (domain === undefined) {
      issues.add("PARAMETER_DOMAIN_MISSING", parameter.id, parameter.requirementIds);
      continue;
    }
    const sourceRequirement = requirements.get(parameter.source.requirementId);
    if (sourceRequirement === undefined) {
      issues.add("REQUIREMENT_REFERENCE_MISSING", parameter.id, [parameter.source.requirementId]);
      continue;
    }
    budget.spend(parameter.requirementIds.length);
    if (!parameter.requirementIds.includes(parameter.source.requirementId)) {
      issues.add("PARAMETER_SOURCE_REQUIREMENT_MISMATCH", parameter.id, parameter.requirementIds);
    }
    budget.spend(domain.allowedRequirementSources.length);
    const sourceAllowed = domain.allowedRequirementSources.some((source) =>
      source.normalizedConstraintKey === parameter.source.normalizedConstraintKey &&
      source.category === sourceRequirement.category &&
      source.priority === sourceRequirement.priority
    );
    const requiredSuffix = PARAMETER_UNIT_CONSTRAINT_SUFFIX[domain.unit];
    if (
      !sourceAllowed ||
      (requiredSuffix !== null && !parameter.source.normalizedConstraintKey.endsWith(requiredSuffix))
    ) {
      issues.add("PARAMETER_SOURCE_REQUIREMENT_MISMATCH", parameter.id, parameter.requirementIds);
    }
    if (
      pinned.constraintOwners.get(parameter.source.normalizedConstraintKey) !==
      parameter.source.requirementId
    ) {
      issues.add("PARAMETER_CONSTRAINT_OWNER_MISMATCH", parameter.id, parameter.requirementIds);
    }
    const constraint = parseRequirementConstraint(
      pinned.requirements.constraints[parameter.source.normalizedConstraintKey]
    );
    if (constraint === null) {
      issues.add("PARAMETER_CONSTRAINT_MISSING", parameter.id, parameter.requirementIds);
      continue;
    }
    if (
      constraint < domain.minimum ||
      constraint > domain.maximum ||
      !exactIntegerDifferenceIsMultiple(constraint, domain.minimum, domain.step)
    ) {
      issues.add("PARAMETER_DOMAIN_MISMATCH", parameter.id, parameter.requirementIds);
      continue;
    }
    const targetKey = `${parameter.targetKind}\u0000${parameter.targetId}\u0000${parameter.parameterKey}`;
    if (parameterByTargetKey.has(targetKey)) {
      issues.add("PARAMETER_DUPLICATE_BINDING", parameter.id, parameter.requirementIds);
      continue;
    }
    const compiled: CompiledSystemArchitectureParameter = {
      ...parameter,
      value: constraint,
      unit: domain.unit
    };
    compiledParameterById.set(parameter.id, compiled);
    parameterByTargetKey.set(targetKey, compiled);
    const parentRequirements = new Set(node.requirementIds);
    if (
      !subsetOf(parameter.requirementIds, parentRequirements, budget) ||
      (targetPort !== undefined && !subsetOf(parameter.requirementIds, new Set(targetPort.requirementIds), budget))
    ) {
      issues.add("REQUIREMENT_PROPAGATION_MISMATCH", parameter.id, parameter.requirementIds);
    }
    for (const requirementId of parameter.requirementIds) {
      if (!requirements.has(requirementId)) issues.add("REQUIREMENT_REFERENCE_MISSING", parameter.id, [requirementId]);
    }
  }
  for (const node of ir.nodes) {
    const option = options.get(node.optionId);
    for (const domain of option?.parameterDomains ?? []) {
      if (!domain.required) continue;
      budget.spend();
      const targetId = domain.targetKind === "node"
        ? node.id
        : portByNodeTemplate.get(`${node.id}\u0000${domain.targetTemplateKey ?? ""}`)?.id;
      if (
        targetId === undefined ||
        !parameterByTargetKey.has(`${domain.targetKind}\u0000${targetId}\u0000${domain.key}`)
      ) {
        issues.add("PARAMETER_REQUIRED_BINDING_MISSING", node.id, node.requirementIds);
      }
    }
  }
  for (const connection of ir.connections) {
    budget.spend();
    const driverTemplate = portTemplatesByPort.get(connection.driverPortId);
    const receiverTemplate = portTemplatesByPort.get(connection.receiverPortId);
    if (driverTemplate === undefined || receiverTemplate === undefined) continue;
    const compatibilityKeys = new Set([
      ...driverTemplate.compatibilityParameterKeys,
      ...receiverTemplate.compatibilityParameterKeys
    ]);
    for (const key of compatibilityKeys) {
      budget.spend();
      const driver = parameterByTargetKey.get(`port\u0000${connection.driverPortId}\u0000${key}`);
      const receiver = parameterByTargetKey.get(`port\u0000${connection.receiverPortId}\u0000${key}`);
      if (driver === undefined || receiver === undefined) {
        issues.add("PORT_COMPATIBILITY_PARAMETER_MISSING", connection.id, connection.requirementIds);
      } else if (driver.value !== receiver.value || driver.unit !== receiver.unit) {
        issues.add("PORT_COMPATIBILITY_PARAMETER_MISMATCH", connection.id, connection.requirementIds);
      }
    }
  }

  const targetExists = (kind: SystemArchitectureAllocationTargetKind, id: string): boolean => {
    switch (kind) {
      case "node": return nodes.has(id);
      case "port": return ports.has(id);
      case "connection": return connections.has(id);
      case "parameter": return parameters.has(id);
      case "safe_state": return safeStates.has(id);
      case "path": return paths.has(id);
    }
  };
  const targetRequirementIds = (
    kind: SystemArchitectureAllocationTargetKind,
    id: string
  ): readonly string[] | undefined => {
    switch (kind) {
      case "node": return nodes.get(id)?.requirementIds;
      case "port": return ports.get(id)?.requirementIds;
      case "connection": return connections.get(id)?.requirementIds;
      case "parameter": return parameters.get(id)?.requirementIds;
      case "safe_state": return safeStates.get(id)?.requirementIds;
      case "path": return paths.get(id)?.requirementIds;
    }
  };
  const targetNodeCache = new Map<string, ReadonlySet<string>>();
  const targetNodeIds = (
    kind: SystemArchitectureAllocationTargetKind,
    id: string
  ): ReadonlySet<string> => {
    const key = `${kind}\u0000${id}`;
    const cached = targetNodeCache.get(key);
    if (cached !== undefined) return cached;
    budget.spend();
    const result = new Set<string>();
    if (kind === "node") result.add(id);
    else if (kind === "port") {
      const nodeId = ports.get(id)?.nodeId;
      if (nodeId !== undefined) result.add(nodeId);
    } else if (kind === "connection") {
      const connection = connections.get(id);
      const driverNodeId = ports.get(connection?.driverPortId ?? "")?.nodeId;
      const receiverNodeId = ports.get(connection?.receiverPortId ?? "")?.nodeId;
      if (driverNodeId !== undefined) result.add(driverNodeId);
      if (receiverNodeId !== undefined) result.add(receiverNodeId);
    } else if (kind === "parameter") {
      const nodeId = parameters.get(id)?.nodeId;
      if (nodeId !== undefined) result.add(nodeId);
    } else if (kind === "safe_state") {
      const nodeId = safeStates.get(id)?.nodeId;
      if (nodeId !== undefined) result.add(nodeId);
    } else {
      const path = paths.get(id);
      for (const connectionId of path?.orderedConnectionIds ?? []) {
        budget.spend();
        for (const nodeId of targetNodeIds("connection", connectionId)) result.add(nodeId);
      }
    }
    const frozenResult = new Set(result);
    targetNodeCache.set(key, frozenResult);
    return frozenResult;
  };
  const targetRoleCache = new Map<string, ReadonlySet<string>>();
  const targetRoleIds = (
    kind: SystemArchitectureAllocationTargetKind,
    id: string
  ): ReadonlySet<string> => {
    const key = `${kind}\u0000${id}`;
    const cached = targetRoleCache.get(key);
    if (cached !== undefined) return cached;
    budget.spend();
    const targetNodes = targetNodeIds(kind, id);
    budget.spend(targetNodes.size);
    const resolved = new Set(
      [...targetNodes]
      .map((nodeId) => nodes.get(nodeId)?.topologyRoleId)
      .filter((roleId): roleId is string => roleId !== undefined)
    );
    targetRoleCache.set(key, resolved);
    return resolved;
  };

  const allocationExactKeys = new Set<string>();
  const allocationsByRequirement = new Map<string, SystemArchitectureIrAllocation[]>();
  for (const allocation of ir.allocations) {
    budget.spend();
    const targetRequirements = targetRequirementIds(allocation.targetKind, allocation.targetId);
    if (!requirements.has(allocation.requirementId)) {
      issues.add("REQUIREMENT_REFERENCE_MISSING", allocation.id, [allocation.requirementId]);
    }
    if (targetRequirements === undefined) {
      issues.add("ALLOCATION_TARGET_MISSING", allocation.id, [allocation.requirementId]);
    } else {
      budget.spend(targetRequirements.length);
      if (!targetRequirements.includes(allocation.requirementId)) {
        issues.add("ALLOCATION_REQUIREMENT_MISMATCH", allocation.id, [allocation.requirementId]);
      }
    }
    const exactAllocationKey = `${allocation.requirementId}\u0000${allocation.targetKind}\u0000${allocation.targetId}`;
    if (allocationExactKeys.has(exactAllocationKey)) {
      issues.add("ALLOCATION_DUPLICATE", allocation.id, [allocation.requirementId]);
    }
    allocationExactKeys.add(exactAllocationKey);
    const list = allocationsByRequirement.get(allocation.requirementId) ?? [];
    list.push(allocation);
    allocationsByRequirement.set(allocation.requirementId, list);
  }
  const requirementEntities: readonly {
    readonly kind: SystemArchitectureAllocationTargetKind;
    readonly id: string;
    readonly requirementIds: readonly string[];
  }[] = [
    ...ir.nodes.map(({ id, requirementIds: ids }) => ({ kind: "node" as const, id, requirementIds: ids })),
    ...ir.ports.map(({ id, requirementIds: ids }) => ({ kind: "port" as const, id, requirementIds: ids })),
    ...ir.connections.map(({ id, requirementIds: ids }) => ({ kind: "connection" as const, id, requirementIds: ids })),
    ...ir.parameters.map(({ id, requirementIds: ids }) => ({ kind: "parameter" as const, id, requirementIds: ids })),
    ...ir.safeStates.map(({ id, requirementIds: ids }) => ({ kind: "safe_state" as const, id, requirementIds: ids })),
    ...ir.paths.map(({ id, requirementIds: ids }) => ({ kind: "path" as const, id, requirementIds: ids }))
  ];
  for (const entity of requirementEntities) {
    for (const requirementId of entity.requirementIds) {
      budget.spend();
      if (!allocationExactKeys.has(`${requirementId}\u0000${entity.kind}\u0000${entity.id}`)) {
        issues.add("ALLOCATION_REQUIREMENT_MISMATCH", entity.id, [requirementId]);
      }
    }
  }
  const allocationPolicies = new Map((topology?.requirementAllocationPolicies ?? []).map((policy) => [
    `${policy.category}\u0000${policy.priority}`,
    policy
  ]));
  budget.spend([...allocationPolicies.values()].reduce(
    (sum, policy) => sum + policy.allowedTopologyRoleIds.length,
    0
  ));
  const allocationAllowedRoleSets = new Map(
    [...allocationPolicies].map(([key, policy]) => [key, new Set(policy.allowedTopologyRoleIds)])
  );
  for (const requirement of pinned.requirements.requirements) {
    budget.spend();
    const allocations = allocationsByRequirement.get(requirement.id) ?? [];
    if (allocations.length === 0) issues.add("REQUIREMENT_UNALLOCATED", null, [requirement.id]);
    const policy = allocationPolicies.get(`${requirement.category}\u0000${requirement.priority}`);
    if (policy === undefined) {
      issues.add("REQUIREMENT_ALLOCATION_POLICY_MISSING", null, [requirement.id]);
      continue;
    }
    if (allocations.length < policy.minimumAllocations || allocations.length > policy.maximumAllocations) {
      issues.add("REQUIREMENT_ALLOCATION_CARDINALITY_INVALID", null, [requirement.id]);
    }
    for (const allocation of allocations) {
      budget.spend();
      const rolesForTarget = targetRoleIds(allocation.targetKind, allocation.targetId);
      budget.spend(rolesForTarget.size);
      const allowedRoles = allocationAllowedRoleSets.get(`${requirement.category}\u0000${requirement.priority}`)!;
      const allowedRole = [...rolesForTarget].some((roleId) => allowedRoles.has(roleId));
      budget.spend(policy.allowedTargetKinds.length + policy.allowedPathKinds.length);
      const pathKindAllowed = allocation.targetKind !== "path" ||
        policy.allowedPathKinds.includes(paths.get(allocation.targetId)?.kind ?? "signal");
      if (
        !policy.allowedTargetKinds.includes(allocation.targetKind) ||
        !allowedRole ||
        !pathKindAllowed
      ) {
        issues.add("REQUIREMENT_ALLOCATION_TARGET_FORBIDDEN", allocation.id, [requirement.id]);
      }
    }
  }

  const practiceIds = new Set(pinned.pcbPracticeCatalog.rules.map(({ id }) => id));
  const practiceAllocationTokensByNode = new Map<string, Set<string>>();
  const exactPracticeAllocations = new Set<string>();
  for (const allocation of ir.practiceAllocations) {
    budget.spend();
    const exactPracticeKey = `${allocation.practiceId}\u0000${allocation.targetKind}\u0000${allocation.targetId}`;
    if (exactPracticeAllocations.has(exactPracticeKey)) {
      issues.add("PRACTICE_ALLOCATION_DUPLICATE", allocation.id);
    }
    exactPracticeAllocations.add(exactPracticeKey);
    if (!practiceIds.has(allocation.practiceId)) {
      issues.add("PRACTICE_REFERENCE_MISSING", allocation.id);
      continue;
    }
    if (!targetExists(allocation.targetKind, allocation.targetId)) {
      issues.add("ALLOCATION_TARGET_MISSING", allocation.id);
      continue;
    }
    for (const nodeId of targetNodeIds(allocation.targetKind, allocation.targetId)) {
      budget.spend();
      const key = `${allocation.practiceId}\u0000${nodeId}`;
      const tokens = practiceAllocationTokensByNode.get(key) ?? new Set<string>();
      tokens.add(allocation.targetKind === "path"
        ? `path:${paths.get(allocation.targetId)?.kind ?? "unknown"}`
        : allocation.targetKind);
      practiceAllocationTokensByNode.set(key, tokens);
    }
  }
  const practiceRequirementsByNode = new Map<
    string,
    ReadonlyMap<string, SystemArchitectureOptionPracticeRequirement>
  >();
  for (const node of ir.nodes) {
    const option = options.get(node.optionId);
    budget.spend(option?.requiredPractices.length ?? 0);
    practiceRequirementsByNode.set(
      node.id,
      new Map((option?.requiredPractices ?? []).map((practice) => [practice.practiceId, practice]))
    );
    for (const practice of option?.requiredPractices ?? []) {
      const tokens = practiceAllocationTokensByNode.get(`${practice.practiceId}\u0000${node.id}`) ?? new Set<string>();
      budget.spend(practice.allowedTargetKinds.length + practice.allowedPathKinds.length);
      const valid = practice.allowedTargetKinds.some((kind) =>
        kind === "path"
          ? practice.allowedPathKinds.some((pathKind) => tokens.has(`path:${pathKind}`))
          : tokens.has(kind)
      );
      if (!valid) issues.add("PRACTICE_UNALLOCATED", node.id);
    }
  }
  for (const allocation of ir.practiceAllocations) {
    const touchedNodes = targetNodeIds(allocation.targetKind, allocation.targetId);
    budget.spend(touchedNodes.size);
    let permitted = false;
    for (const nodeId of touchedNodes) {
      const practice = practiceRequirementsByNode.get(nodeId)?.get(allocation.practiceId);
      if (practice === undefined) continue;
      budget.spend(practice.allowedTargetKinds.length + practice.allowedPathKinds.length);
      if (
        practice.allowedTargetKinds.includes(allocation.targetKind) &&
        (allocation.targetKind !== "path" ||
          practice.allowedPathKinds.includes(paths.get(allocation.targetId)?.kind ?? "signal"))
      ) {
        permitted = true;
        break;
      }
    }
    if (!permitted) issues.add("PRACTICE_ALLOCATION_TARGET_FORBIDDEN", allocation.id);
  }

  const enabledOperations = new Set(pinned.registry.enabledOperations);
  for (const operation of requiredOperationsFor(ir)) {
    budget.spend();
    if (!enabledOperations.has(operation)) issues.add("REGISTRY_OPERATION_DISABLED", operation);
  }

  const issueList = issues.list();
  let graph: SystemArchitectureGraph | null = null;
  if (issueList.length === 0) {
    const compiledNodes: readonly CompiledSystemArchitectureNode[] = ir.nodes.map((node) => ({
      ...node,
      nodeKind: options.get(node.optionId)!.nodeKind
    }));
    const compiledParameters = ir.parameters.map((parameter) => compiledParameterById.get(parameter.id)!);
    const graphPayload: SystemArchitectureGraphPayload = {
      schemaVersion: contract.SYSTEM_ARCHITECTURE_GRAPH_SCHEMA,
      stage: "system_architecture",
      role: "system_architect",
      classification: "proposal_only",
      lifecycle: "candidate",
      authority: "none",
      receiptId: resolution.receiptId,
      proposalResolutionIdentity: resolution.identity,
      replayReceiptIdentity: resolution.replayReceiptIdentity,
      replayIdentity: resolution.replayIdentity,
      proposalResultIdentity: resolution.proposalResultIdentity,
      structuredProposalIdentity: resolution.structuredProposalIdentity,
      requirementsIdentity: pinned.identities.requirementsIdentity,
      requirementsApprovalIdentity: pinned.identities.requirementsApprovalIdentity,
      optionCatalogIdentity: pinned.identities.optionCatalogIdentity,
      topologyCatalogIdentity: pinned.identities.topologyCatalogIdentity,
      pcbPracticeCatalogIdentity: pinned.identities.pcbPracticeCatalogIdentity,
      registryIdentity: pinned.identities.registryIdentity,
      compilerImplementationContentIdentity:
        pinned.registry.compiler.implementationContentIdentity,
      outputContractIdentity: pinned.identities.outputContractIdentity,
      irIdentity: ir.identity,
      topologyTemplateId: ir.topologyTemplateId,
      selectedOptions: ir.selectedOptions,
      nodes: compiledNodes,
      ports: ir.ports,
      connections: ir.connections,
      allocations: ir.allocations,
      parameters: compiledParameters,
      safeStates: ir.safeStates,
      paths: ir.paths,
      practiceAllocations: ir.practiceAllocations
    };
    graph = deepFreeze({
      ...graphPayload,
      identity: deepFreeze(canonicalIdentity(graphPayload, contract.SYSTEM_ARCHITECTURE_GRAPH_SCHEMA))
    });
  }
  const payload: SystemArchitectureDecisionCompilationPayload = {
    schemaVersion: contract.SYSTEM_ARCHITECTURE_DECISION_COMPILATION_SCHEMA,
    classification: "proposal_only",
    lifecycle: "candidate",
    authority: "none",
    disposition: issueList.length === 0 ? "accepted" : "rejected",
    receiptId: resolution.receiptId,
    proposalResolutionIdentity: resolution.identity,
    replayReceiptIdentity: resolution.replayReceiptIdentity,
    replayIdentity: resolution.replayIdentity,
    proposalResultIdentity: resolution.proposalResultIdentity,
    structuredProposalIdentity: resolution.structuredProposalIdentity,
    requirementsIdentity: pinned.identities.requirementsIdentity,
    requirementsApprovalIdentity: pinned.identities.requirementsApprovalIdentity,
    optionCatalogIdentity: pinned.identities.optionCatalogIdentity,
    topologyCatalogIdentity: pinned.identities.topologyCatalogIdentity,
    pcbPracticeCatalogIdentity: pinned.identities.pcbPracticeCatalogIdentity,
    registryIdentity: pinned.identities.registryIdentity,
    compilerImplementationContentIdentity:
      pinned.registry.compiler.implementationContentIdentity,
    outputContractIdentity: pinned.identities.outputContractIdentity,
    irIdentity: ir.identity,
    issues: issueList,
    graph,
    graphIdentity: graph?.identity ?? null
  };
  const compilation = deepFreeze({
    ...payload,
    identity: deepFreeze(canonicalIdentity(payload, contract.SYSTEM_ARCHITECTURE_DECISION_COMPILATION_SCHEMA))
  });
  assertPlainDataGraph(
    compilation,
    "emittedCompilation",
    rejectPolicy,
    graphBudget(),
    new Set<object>(),
    0,
    ARTIFACT_GRAPH_LIMITS
  );
  return compilation;
};

const resolvePinnedProposal = async (
  pinned: PinnedProvision,
  receiptId: string
): Promise<ResolvedSystemArchitectureProposal> => {
  let resolved: unknown;
  try {
    resolved = await pinned.resolveProposal(receiptId);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    rejectPolicy("Authenticated architecture proposal resolver rejected the receipt", { receiptId });
  }
  const proposal = snapshotResolvedProposal(resolved, receiptId, rejectArtifact);
  requireIdentity(
    proposal.outputContractIdentity,
    pinned.identities.outputContractIdentity,
    "resolvedProposal.outputContractIdentity",
    rejectPolicy
  );
  return proposal;
};

const bindingFromPinned = (
  pinned: PinnedProvision,
  resolution: ResolvedSystemArchitectureProposal
): SystemArchitectureDecisionBinding => {
  const compilation = compileFromPinned(pinned, resolution);
  if (compilation.disposition !== "accepted" || compilation.graph === null) {
    throw new DomainError(
      "GATE_FAILED",
      "Rejected system architecture cannot produce a consumable decision binding",
      { issueCodes: compilation.issues.map(({ code }) => code) }
    );
  }
  const payload: SystemArchitectureDecisionBindingPayload = {
    schemaVersion: contract.SYSTEM_ARCHITECTURE_DECISION_BINDING_SCHEMA,
    requirementsSnapshot: pinned.requirements,
    requirementsIdentity: pinned.identities.requirementsIdentity,
    requirementsApprovalSnapshot: pinned.approval,
    requirementsApprovalIdentity: pinned.identities.requirementsApprovalIdentity,
    optionCatalogSnapshot: pinned.optionCatalog,
    optionCatalogIdentity: pinned.identities.optionCatalogIdentity,
    topologyCatalogSnapshot: pinned.topologyCatalog,
    topologyCatalogIdentity: pinned.identities.topologyCatalogIdentity,
    pcbPracticeCatalogSnapshot: pinned.pcbPracticeCatalog,
    pcbPracticeCatalogIdentity: pinned.identities.pcbPracticeCatalogIdentity,
    registrySnapshot: pinned.registry,
    registryIdentity: pinned.identities.registryIdentity,
    compilerImplementationContentIdentity:
      pinned.registry.compiler.implementationContentIdentity,
    outputContractIdentity: pinned.identities.outputContractIdentity,
    proposalResolutionSnapshot: resolution,
    proposalResolutionIdentity: resolution.identity,
    irSnapshot: resolution.irSnapshot,
    irIdentity: resolution.irIdentity,
    compilation,
    compilationIdentity: compilation.identity
  };
  const binding = deepFreeze({
    ...payload,
    identity: deepFreeze(canonicalIdentity(payload, contract.SYSTEM_ARCHITECTURE_DECISION_BINDING_SCHEMA))
  });
  assertPlainDataGraph(
    binding,
    "emittedBinding",
    rejectPolicy,
    graphBudget(),
    new Set<object>(),
    0,
    ARTIFACT_GRAPH_LIMITS
  );
  return binding;
};

const validateWholeObject = <Value>(
  value: unknown,
  expected: Value,
  field: string
): Value => {
  const snapshot = detached(value, field, rejectArtifact, graphBudget(), ARTIFACT_GRAPH_LIMITS);
  if (canonicalJson(snapshot) !== canonicalJson(expected)) {
    rejectArtifact(`System architecture ${field} differs from exact provision-pinned recompilation`);
  }
  return expected;
};

/**
 * Host-composition boundary. This factory does not mint authentication: it captures verifier
 * closures supplied by the trusted host, and no per-run request can replace them or any root.
 */
export const createProvisionPinnedSystemArchitectureDecisionCompiler = (
  provision: SystemArchitectureDecisionCompilerProvision
): SystemArchitectureDecisionCompiler => {
  const pinned = snapshotProvision(provision);
  const compile = async (
    requestValue: contract.SystemArchitectureDecisionRequest
  ): Promise<SystemArchitectureDecisionCompilation> => {
    const receiptId = snapshotDecisionRequest(requestValue);
    return compileFromPinned(pinned, await resolvePinnedProposal(pinned, receiptId));
  };
  const compileBinding = async (
    requestValue: contract.SystemArchitectureDecisionRequest
  ): Promise<SystemArchitectureDecisionBinding> => {
    const receiptId = snapshotDecisionRequest(requestValue);
    return bindingFromPinned(pinned, await resolvePinnedProposal(pinned, receiptId));
  };
  const validateCompilation = async (
    value: unknown,
    requestValue: contract.SystemArchitectureDecisionRequest
  ): Promise<SystemArchitectureDecisionCompilation> => {
    // Snapshot both caller-controlled values before the first await.
    const candidate = detached(
      value,
      "compilation",
      rejectArtifact,
      graphBudget(),
      ARTIFACT_GRAPH_LIMITS
    );
    const receiptId = snapshotDecisionRequest(requestValue);
    const expected = compileFromPinned(pinned, await resolvePinnedProposal(pinned, receiptId));
    return validateWholeObject(candidate, expected, "compilation");
  };
  const validateBinding = async (value: unknown): Promise<SystemArchitectureDecisionBinding> => {
    const candidate = detached(
      value,
      "binding",
      rejectArtifact,
      graphBudget(),
      ARTIFACT_GRAPH_LIMITS
    );
    const record = recordAt(candidate, [
      "schemaVersion",
      "requirementsSnapshot",
      "requirementsIdentity",
      "requirementsApprovalSnapshot",
      "requirementsApprovalIdentity",
      "optionCatalogSnapshot",
      "optionCatalogIdentity",
      "topologyCatalogSnapshot",
      "topologyCatalogIdentity",
      "pcbPracticeCatalogSnapshot",
      "pcbPracticeCatalogIdentity",
      "registrySnapshot",
      "registryIdentity",
      "compilerImplementationContentIdentity",
      "outputContractIdentity",
      "proposalResolutionSnapshot",
      "proposalResolutionIdentity",
      "irSnapshot",
      "irIdentity",
      "compilation",
      "compilationIdentity",
      "identity"
    ], "binding", rejectArtifact);
    if (record.schemaVersion !== contract.SYSTEM_ARCHITECTURE_DECISION_BINDING_SCHEMA) {
      rejectArtifact("System architecture binding schema is invalid");
    }
    const resolutionRecord = recordAt(
      record.proposalResolutionSnapshot,
      [
        "schemaVersion",
        "receiptId",
        "replayReceiptIdentity",
        "replayIdentity",
        "proposalResultIdentity",
        "structuredProposalIdentity",
        "outputContractIdentity",
        "irIdentity",
        "irSnapshot",
        "identity"
      ],
      "binding.proposalResolutionSnapshot",
      rejectArtifact
    );
    const receiptId = identifier(
      resolutionRecord.receiptId,
      "binding.proposalResolutionSnapshot.receiptId",
      rejectArtifact
    );
    const expected = bindingFromPinned(pinned, await resolvePinnedProposal(pinned, receiptId));
    return validateWholeObject(candidate, expected, "binding");
  };
  return Object.freeze({
    pinnedIdentities: pinned.identities,
    compile,
    compileBinding,
    validateCompilation,
    validateBinding
  });
};

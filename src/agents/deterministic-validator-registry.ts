import { types as nodeTypes } from "node:util";

import { canonicalIdentity } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import { STAGE_ORDER, type StageKey } from "../domain/stages.js";
import type { CanonicalIdentity } from "../domain/types.js";
import {
  DESIGN_AGENT_ROLE_BY_STAGE,
  DESIGN_AGENT_ROLES,
  type DesignAgentRole
} from "./roles.js";

export const DESIGN_AGENT_DETERMINISTIC_VALIDATOR_DESCRIPTOR_SCHEMA =
  "evleda.design-agent-deterministic-validator-descriptor.v1" as const;
export const DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA =
  "evleda.design-agent-deterministic-validator-registry.v1" as const;
export const DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA =
  "evleda.design-agent-deterministic-validator-plan.v1" as const;

/**
 * This is the only validator contract implemented for the Phase-A proposal boundary. It describes
 * the closed-schema and reference checks already performed during proposal capture. It is not a
 * design, electrical, lifecycle, native-tool, manufacturing, qualification, or release validator.
 */
export const DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID =
  "evleda.design-agent.structured-reference-validator.v1" as const;
export const DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE =
  "closed_schema_and_reference_integrity_only" as const;

/** Known stale IDs are denied explicitly and are never aliases for a registered implementation. */
export const DESIGN_AGENT_OUTDATED_VALIDATOR_IDS = deepFreeze([
  "evleda.pcb-practice-analyzer.v1"
] as const);

export const DESIGN_AGENT_VALIDATOR_ESTABLISHES = deepFreeze([
  "closed_proposal_schema",
  "stage_role_binding",
  "role_proposal_kind_binding",
  "identifier_uniqueness",
  "closed_requirement_reference_resolution",
  "closed_practice_reference_resolution",
  "closed_target_reference_resolution",
  "narrative_structured_identifier_binding"
] as const);

export const DESIGN_AGENT_VALIDATOR_DOES_NOT_ESTABLISH = deepFreeze([
  "electrical_correctness",
  "whole_design_validation",
  "native_tool_execution",
  "physical_validation",
  "evidence_lifecycle_transition",
  "approval",
  "qualification",
  "release"
] as const);

export interface DesignAgentValidatorApplicability {
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
}

export interface DesignAgentDeterministicValidatorRegistration {
  readonly validatorId: string;
  readonly implementationVersion: string;
  readonly scope: typeof DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE;
  readonly applicability: readonly DesignAgentValidatorApplicability[];
}

export interface DesignAgentMandatoryValidatorCoverage {
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
  readonly validatorIds: readonly string[];
}

export interface DesignAgentDeterministicValidatorRegistryConfiguration {
  /**
   * The authority surface is enumerable string-keyed JSON data only. Hidden/symbol carrier
   * metadata is outside that surface and is never read or copied.
   */
  readonly registrations: readonly DesignAgentDeterministicValidatorRegistration[];
  readonly mandatoryCoverage: readonly DesignAgentMandatoryValidatorCoverage[];
}

export interface DesignAgentDeterministicValidatorDescriptor
  extends DesignAgentDeterministicValidatorRegistration {
  readonly schemaVersion: typeof DESIGN_AGENT_DETERMINISTIC_VALIDATOR_DESCRIPTOR_SCHEMA;
  readonly authority: "host_owned_scope_limited_deterministic_validator";
  readonly establishes: typeof DESIGN_AGENT_VALIDATOR_ESTABLISHES;
  readonly doesNotEstablish: typeof DESIGN_AGENT_VALIDATOR_DOES_NOT_ESTABLISH;
  readonly identity: CanonicalIdentity;
}

export interface DesignAgentDeterministicValidatorRegistrySnapshot {
  readonly schemaVersion: typeof DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA;
  readonly authority: "host_owned_workflow_policy";
  readonly validators: readonly DesignAgentDeterministicValidatorDescriptor[];
  readonly mandatoryCoverage: readonly DesignAgentMandatoryValidatorCoverage[];
  readonly outdatedValidatorIds: typeof DESIGN_AGENT_OUTDATED_VALIDATOR_IDS;
  readonly identity: CanonicalIdentity;
}

export interface DesignAgentDeterministicValidatorPlanInput {
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
  /** Advisory selection only. It can add known applicable validators but cannot remove policy. */
  readonly requestedValidatorIds: readonly string[];
}

export interface DesignAgentDeterministicValidatorPlanEntry {
  readonly validatorId: string;
  readonly descriptorIdentity: CanonicalIdentity;
  readonly selection:
    | "host_mandatory"
    | "model_requested"
    | "host_mandatory_and_model_requested";
}

export interface DesignAgentDeterministicValidatorPlan {
  readonly schemaVersion: typeof DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA;
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
  readonly authority: "host_owned_workflow_policy";
  readonly requestedValidatorIds: readonly string[];
  readonly mandatoryValidatorIds: readonly string[];
  readonly validatorIds: readonly string[];
  readonly validators: readonly DesignAgentDeterministicValidatorPlanEntry[];
  readonly registryIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}

export interface DesignAgentDeterministicValidatorRegistry {
  readonly authority: "host_owned_workflow_policy";
  snapshot(): DesignAgentDeterministicValidatorRegistrySnapshot;
  registeredValidatorIds(): readonly string[];
  mandatoryValidatorIds(stage: StageKey, role: DesignAgentRole): readonly string[];
  resolve(
    validatorId: string,
    stage: StageKey,
    role: DesignAgentRole
  ): DesignAgentDeterministicValidatorDescriptor;
  plan(input: DesignAgentDeterministicValidatorPlanInput): DesignAgentDeterministicValidatorPlan;
}

export class DesignAgentDeterministicValidatorRegistryError extends DomainError {
  public constructor(
    code: ConstructorParameters<typeof DomainError>[0],
    public readonly failureCode: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(code, message, { failureCode, ...details }, false);
    this.name = "DesignAgentDeterministicValidatorRegistryError";
  }
}

const reject = (
  code: ConstructorParameters<typeof DomainError>[0],
  failureCode: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never => {
  throw new DesignAgentDeterministicValidatorRegistryError(
    code,
    failureCode,
    message,
    details
  );
};

function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

interface SnapshotState {
  nodes: number;
  stringBytes: number;
  readonly active: Set<object>;
}

const SNAPSHOT_MAXIMUM_DEPTH = 12;
const SNAPSHOT_MAXIMUM_NODES = 4_096;
const SNAPSHOT_MAXIMUM_STRING_BYTES = 256 * 1024;
const MAXIMUM_VALIDATORS = 64;
const MAXIMUM_REQUESTED_VALIDATORS = 64;

/**
 * Snapshot the complete enumerable JSON authority surface before interpreting any field. Proxies,
 * non-plain prototypes, authoritative accessors, and enumerable unknown fields are rejected.
 * Hidden/symbol carrier metadata is outside the surface and is never enumerated, read, or copied.
 */
const snapshotPlainData = (value: unknown, label: string): unknown => {
  const state: SnapshotState = { nodes: 0, stringBytes: 0, active: new Set<object>() };

  const visit = (candidate: unknown, depth: number, path: string): unknown => {
    state.nodes += 1;
    if (state.nodes > SNAPSHOT_MAXIMUM_NODES || depth > SNAPSHOT_MAXIMUM_DEPTH) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
        `${label} exceeds its bounded plain-data limits`
      );
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
        reject(
          "INVALID_ARGUMENT",
          "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
          `${label} exceeds its bounded string-data limit`
        );
      }
      return candidate;
    }
    if (typeof candidate !== "object" || candidate === null || nodeTypes.isProxy(candidate)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
        `${path} must be plain data`
      );
    }
    const objectCandidate = candidate as object;
    if (state.active.has(objectCandidate)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
        `${label} must not contain cycles`
      );
    }

    state.active.add(objectCandidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          reject(
            "INVALID_ARGUMENT",
            "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
            `${path} must be a plain array`
          );
        }
        if (candidate.length > SNAPSHOT_MAXIMUM_NODES - state.nodes) {
          reject(
            "INVALID_ARGUMENT",
            "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
            `${path} exceeds its bounded array width`
          );
        }
        let enumerableOwnKeyCount = 0;
        for (const key in candidate) {
          if (!Object.hasOwn(candidate, key)) {
            reject(
              "INVALID_ARGUMENT",
              "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
              `${path} must not contain inherited enumerable data`
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
              "INVALID_ARGUMENT",
              "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
              `${path} must be a bounded dense array without enumerable named properties`
            );
          }
        }
        if (enumerableOwnKeyCount !== candidate.length) {
          reject(
            "INVALID_ARGUMENT",
            "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
            `${path} must be a dense array of enumerable data entries`
          );
        }
        const copy: unknown[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            reject(
              "INVALID_ARGUMENT",
              "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
              `${path} must contain only enumerable data entries`
            );
          }
          copy.push(visit(descriptor!.value, depth + 1, `${path}[${index}]`));
        }
        return copy;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        reject(
          "INVALID_ARGUMENT",
          "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
          `${path} must be a plain object`
        );
      }
      const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let enumerableOwnKeyCount = 0;
      for (const key in candidate as Record<string, unknown>) {
        if (!Object.hasOwn(objectCandidate, key)) {
          reject(
            "INVALID_ARGUMENT",
            "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
            `${path} must not contain inherited enumerable data`
          );
        }
        enumerableOwnKeyCount += 1;
        state.stringBytes += Buffer.byteLength(key, "utf8");
        if (
          enumerableOwnKeyCount > SNAPSHOT_MAXIMUM_NODES - state.nodes ||
          state.stringBytes > SNAPSHOT_MAXIMUM_STRING_BYTES
        ) {
          reject(
            "INVALID_ARGUMENT",
            "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
            `${path} exceeds its bounded object width or key-byte limit`
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          reject(
            "INVALID_ARGUMENT",
            "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
            `${path}.${key} must be an enumerable data property`
          );
        }
        copy[key] = visit(descriptor!.value, depth + 1, `${path}.${key}`);
      }
      // Non-enumerable and symbol metadata is deliberately outside the enumerable JSON authority
      // surface. JavaScript has no bounded streaming API for those key classes, so enumerating them
      // would let an input force an unbounded key-list allocation. We never inspect, invoke, retain,
      // or copy them; the detached snapshot contains only the bounded enumerable data above.
      return copy;
    } finally {
      state.active.delete(objectCandidate);
    }
  };

  return deepFreeze(visit(value, 0, label));
};

const exactRecord = (
  value: unknown,
  keys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
      `${label} must be a plain object`
    );
  }
  const recordValue = value as object;
  const actual = Object.keys(recordValue).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
      `${label} contains missing or unknown fields`,
      { actual, expected }
    );
  }
  return value as Readonly<Record<string, unknown>>;
};

const boundedArray = (
  value: unknown,
  maximumLength: number,
  label: string,
  allowEmpty = false
): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > maximumLength || (!allowEmpty && value.length === 0)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
      `${label} must be a bounded${allowEmpty ? "" : " non-empty"} array`
    );
  }
  return value as readonly unknown[];
};

const identifier = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u.test(value)
  ) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_INPUT_INVALID",
      `${label} must be a bounded identifier`
    );
  }
  return value as string;
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const stages = new Set<string>(STAGE_ORDER);
const roles = new Set<string>(DESIGN_AGENT_ROLES);
const outdatedIds = new Set<string>(DESIGN_AGENT_OUTDATED_VALIDATOR_IDS);

const stage = (value: unknown, label: string): StageKey => {
  if (typeof value !== "string" || !stages.has(value)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_STAGE_INVALID",
      `${label} is not a registered workflow stage`
    );
  }
  return value as StageKey;
};

const role = (value: unknown, label: string): DesignAgentRole => {
  if (typeof value !== "string" || !roles.has(value)) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_ROLE_INVALID",
      `${label} is not a registered design-agent role`
    );
  }
  return value as DesignAgentRole;
};

const pairKey = (value: DesignAgentValidatorApplicability): string =>
  `${value.stage}\u0000${value.role}`;

const assertStageRolePair = (
  selectedStage: StageKey,
  selectedRole: DesignAgentRole,
  label: string
): void => {
  if (DESIGN_AGENT_ROLE_BY_STAGE[selectedStage] !== selectedRole) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_STAGE_ROLE_MISMATCH",
      `${label} is not an exact workflow stage/role pair`,
      { stage: selectedStage, role: selectedRole }
    );
  }
};

const parseApplicability = (
  value: unknown,
  label: string
): readonly DesignAgentValidatorApplicability[] => {
  const entries = boundedArray(value, STAGE_ORDER.length, label);
  const seen = new Set<string>();
  const parsed = entries.map((entry, index) => {
    const record = exactRecord(entry, ["stage", "role"], `${label}[${index}]`);
    const selectedStage = stage(record.stage, `${label}[${index}].stage`);
    const selectedRole = role(record.role, `${label}[${index}].role`);
    assertStageRolePair(selectedStage, selectedRole, `${label}[${index}]`);
    const result = { stage: selectedStage, role: selectedRole };
    const key = pairKey(result);
    if (seen.has(key)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_APPLICABILITY_DUPLICATE",
        `${label} contains a duplicate stage/role pair`,
        result
      );
    }
    seen.add(key);
    return result;
  });
  return deepFreeze(parsed.sort((left, right) => {
    const stageDifference = STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage);
    return stageDifference !== 0 ? stageDifference : compareText(left.role, right.role);
  }));
};

const descriptorFor = (
  value: unknown,
  index: number
): DesignAgentDeterministicValidatorDescriptor => {
  const label = `configuration.registrations[${index}]`;
  const record = exactRecord(
    value,
    ["validatorId", "implementationVersion", "scope", "applicability"],
    label
  );
  const validatorId = identifier(record.validatorId, `${label}.validatorId`);
  if (outdatedIds.has(validatorId)) {
    reject(
      "POLICY_DENIED",
      "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED",
      "A known outdated validator ID cannot be registered or aliased",
      { validatorId }
    );
  }
  const implementationVersion = identifier(
    record.implementationVersion,
    `${label}.implementationVersion`
  );
  if (record.scope !== DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_SCOPE_INVALID",
      "The Phase-A registry accepts only the implemented scope-limited proposal validator",
      { validatorId }
    );
  }
  const applicability = parseApplicability(record.applicability, `${label}.applicability`);
  const payload = {
    schemaVersion: DESIGN_AGENT_DETERMINISTIC_VALIDATOR_DESCRIPTOR_SCHEMA,
    validatorId,
    implementationVersion,
    scope: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
    authority: "host_owned_scope_limited_deterministic_validator" as const,
    applicability,
    establishes: DESIGN_AGENT_VALIDATOR_ESTABLISHES,
    doesNotEstablish: DESIGN_AGENT_VALIDATOR_DOES_NOT_ESTABLISH
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(
      payload,
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_DESCRIPTOR_SCHEMA
    )
  });
};

const parseValidatorIds = (
  value: unknown,
  label: string,
  allowEmpty: boolean
): readonly string[] => {
  const values = boundedArray(value, MAXIMUM_REQUESTED_VALIDATORS, label, allowEmpty);
  const parsed = values.map((entry, index) => identifier(entry, `${label}[${index}]`));
  const seen = new Set<string>();
  for (const validatorId of parsed) {
    if (seen.has(validatorId)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_REQUEST_DUPLICATE",
        `${label} contains a duplicate validator ID`,
        { validatorId }
      );
    }
    seen.add(validatorId);
  }
  return deepFreeze(parsed.sort(compareText));
};

const candidateStageRolePairs = STAGE_ORDER.slice(1).map((selectedStage) => ({
  stage: selectedStage,
  role: DESIGN_AGENT_ROLE_BY_STAGE[selectedStage]
}));

/** The initial agent workflow truthfully covers only the eight post-approval candidate stages. */
export const DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS = deepFreeze(candidateStageRolePairs);

const parseMandatoryCoverage = (
  value: unknown,
  validators: ReadonlyMap<string, DesignAgentDeterministicValidatorDescriptor>
): readonly DesignAgentMandatoryValidatorCoverage[] => {
  const entries = boundedArray(
    value,
    DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.length,
    "configuration.mandatoryCoverage"
  );
  const expectedPairs = new Set(DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.map(pairKey));
  const seenPairs = new Set<string>();
  const parsed = entries.map((entry, index) => {
    const label = `configuration.mandatoryCoverage[${index}]`;
    const record = exactRecord(entry, ["stage", "role", "validatorIds"], label);
    const selectedStage = stage(record.stage, `${label}.stage`);
    const selectedRole = role(record.role, `${label}.role`);
    assertStageRolePair(selectedStage, selectedRole, label);
    const pair = { stage: selectedStage, role: selectedRole };
    const key = pairKey(pair);
    if (!expectedPairs.has(key)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_POLICY_STAGE_UNSUPPORTED",
        "Mandatory Phase-A coverage may contain only post-approval candidate stages",
        pair
      );
    }
    if (seenPairs.has(key)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_POLICY_DUPLICATE",
        "Mandatory validator policy contains a duplicate stage/role pair",
        pair
      );
    }
    seenPairs.add(key);
    const validatorIds = parseValidatorIds(record.validatorIds, `${label}.validatorIds`, false);
    for (const validatorId of validatorIds) {
      if (outdatedIds.has(validatorId)) {
        reject(
          "POLICY_DENIED",
          "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED",
          "Mandatory policy names a known outdated validator ID",
          { validatorId, ...pair }
        );
      }
      const validator = validators.get(validatorId);
      if (validator === undefined) {
        reject(
          "INVALID_ARGUMENT",
          "AGENT_DETERMINISTIC_VALIDATOR_POLICY_UNREGISTERED",
          "Mandatory policy names an unregistered validator implementation",
          { validatorId, ...pair }
        );
      }
      if (!validator!.applicability.some((applicable) => pairKey(applicable) === key)) {
        reject(
          "INVALID_ARGUMENT",
          "AGENT_DETERMINISTIC_VALIDATOR_POLICY_NOT_APPLICABLE",
          "Mandatory policy names a validator outside its exact stage/role applicability",
          { validatorId, ...pair }
        );
      }
    }
    return { ...pair, validatorIds };
  });

  const missingPairs = DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.filter(
    (pair) => !seenPairs.has(pairKey(pair))
  );
  if (missingPairs.length > 0) {
    reject(
      "INVALID_ARGUMENT",
      "AGENT_DETERMINISTIC_VALIDATOR_POLICY_INCOMPLETE",
      "Host-owned mandatory validator policy must cover every proposal stage/role pair",
      { missingPairs }
    );
  }

  return deepFreeze(parsed.sort((left, right) =>
    STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage)
  ));
};

const parseConfiguration = (
  input: unknown
): {
  readonly validators: readonly DesignAgentDeterministicValidatorDescriptor[];
  readonly mandatoryCoverage: readonly DesignAgentMandatoryValidatorCoverage[];
} => {
  const snapshot = snapshotPlainData(input, "configuration");
  const root = exactRecord(snapshot, ["registrations", "mandatoryCoverage"], "configuration");
  const registrations = boundedArray(
    root.registrations,
    MAXIMUM_VALIDATORS,
    "configuration.registrations"
  );
  const validators = registrations.map(descriptorFor).sort((left, right) =>
    compareText(left.validatorId, right.validatorId)
  );
  const validatorById = new Map<string, DesignAgentDeterministicValidatorDescriptor>();
  for (const validator of validators) {
    if (validatorById.has(validator.validatorId)) {
      reject(
        "INVALID_ARGUMENT",
        "AGENT_DETERMINISTIC_VALIDATOR_REGISTRATION_DUPLICATE",
        "A validator ID must resolve to exactly one implementation",
        { validatorId: validator.validatorId }
      );
    }
    validatorById.set(validator.validatorId, validator);
  }
  const mandatoryCoverage = parseMandatoryCoverage(root.mandatoryCoverage, validatorById);
  return deepFreeze({ validators, mandatoryCoverage });
};

const resolveStageRole = (
  selectedStage: unknown,
  selectedRole: unknown,
  label: string
): DesignAgentValidatorApplicability => {
  const parsedStage = stage(selectedStage, `${label}.stage`);
  const parsedRole = role(selectedRole, `${label}.role`);
  assertStageRolePair(parsedStage, parsedRole, label);
  return { stage: parsedStage, role: parsedRole };
};

const assertNotOutdated = (validatorId: string): void => {
  if (outdatedIds.has(validatorId)) {
    reject(
      "POLICY_DENIED",
      "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED",
      "Known outdated validator IDs are rejected and are never aliased",
      { validatorId }
    );
  }
};

/**
 * Creates a host-composition registry. The entire configuration is detached before validation, and
 * mandatory coverage is immutable workflow policy rather than a property of model output.
 */
export const createDesignAgentDeterministicValidatorRegistry = (
  input: unknown
): DesignAgentDeterministicValidatorRegistry => {
  const { validators, mandatoryCoverage } = parseConfiguration(input);
  const validatorById = new Map(validators.map((validator) => [validator.validatorId, validator]));
  const coverageByPair = new Map(
    mandatoryCoverage.map((coverage) => [pairKey(coverage), coverage.validatorIds])
  );
  const snapshotPayload = {
    schemaVersion: DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA,
    authority: "host_owned_workflow_policy" as const,
    validators,
    mandatoryCoverage,
    outdatedValidatorIds: DESIGN_AGENT_OUTDATED_VALIDATOR_IDS
  };
  const registrySnapshot: DesignAgentDeterministicValidatorRegistrySnapshot = deepFreeze({
    ...snapshotPayload,
    identity: canonicalIdentity(
      snapshotPayload,
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
    )
  });
  const registeredIds = deepFreeze(validators.map((validator) => validator.validatorId));

  const mandatoryValidatorIds = (
    selectedStage: StageKey,
    selectedRole: DesignAgentRole
  ): readonly string[] => {
    const pair = resolveStageRole(selectedStage, selectedRole, "validatorPolicy");
    const required = coverageByPair.get(pairKey(pair));
    if (required === undefined) {
      reject(
        "POLICY_DENIED",
        "AGENT_DETERMINISTIC_VALIDATOR_POLICY_NOT_CONFIGURED",
        "No mandatory validator policy is configured for this stage/role pair",
        { ...pair }
      );
    }
    return required!;
  };

  const resolve = (
    validatorIdValue: string,
    selectedStage: StageKey,
    selectedRole: DesignAgentRole
  ): DesignAgentDeterministicValidatorDescriptor => {
    const validatorId = identifier(validatorIdValue, "validatorId");
    assertNotOutdated(validatorId);
    const pair = resolveStageRole(selectedStage, selectedRole, "validatorResolution");
    const validator = validatorById.get(validatorId);
    if (validator === undefined) {
      reject(
        "POLICY_DENIED",
        "AGENT_DETERMINISTIC_VALIDATOR_UNREGISTERED",
        "Validator ID has no exact registered implementation",
        { validatorId, ...pair }
      );
    }
    if (!validator!.applicability.some((applicable) => pairKey(applicable) === pairKey(pair))) {
      reject(
        "POLICY_DENIED",
        "AGENT_DETERMINISTIC_VALIDATOR_NOT_APPLICABLE",
        "Validator implementation is not applicable to the exact stage/role pair",
        { validatorId, ...pair }
      );
    }
    return validator!;
  };

  const plan = (inputValue: DesignAgentDeterministicValidatorPlanInput): DesignAgentDeterministicValidatorPlan => {
    const snapshot = snapshotPlainData(inputValue, "validatorPlan");
    const record = exactRecord(
      snapshot,
      ["stage", "role", "requestedValidatorIds"],
      "validatorPlan"
    );
    const pair = resolveStageRole(record.stage, record.role, "validatorPlan");
    const requestedValidatorIds = parseValidatorIds(
      record.requestedValidatorIds,
      "validatorPlan.requestedValidatorIds",
      true
    );
    const mandatoryIds = mandatoryValidatorIds(pair.stage, pair.role);
    for (const validatorId of requestedValidatorIds) {
      resolve(validatorId, pair.stage, pair.role);
    }
    const mandatorySet = new Set(mandatoryIds);
    const requestedSet = new Set(requestedValidatorIds);
    const validatorIds = deepFreeze(
      [...new Set([...mandatoryIds, ...requestedValidatorIds])].sort(compareText)
    );
    const planValidators = deepFreeze(validatorIds.map((validatorId) => {
      const descriptor = resolve(validatorId, pair.stage, pair.role);
      const mandatory = mandatorySet.has(validatorId);
      const requested = requestedSet.has(validatorId);
      return {
        validatorId,
        descriptorIdentity: descriptor.identity,
        selection: mandatory && requested
          ? "host_mandatory_and_model_requested" as const
          : mandatory
            ? "host_mandatory" as const
            : "model_requested" as const
      };
    }));
    const payload = {
      schemaVersion: DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA,
      stage: pair.stage,
      role: pair.role,
      authority: "host_owned_workflow_policy" as const,
      requestedValidatorIds,
      mandatoryValidatorIds: mandatoryIds,
      validatorIds,
      validators: planValidators,
      registryIdentity: registrySnapshot.identity
    };
    return deepFreeze({
      ...payload,
      identity: canonicalIdentity(payload, DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA)
    });
  };

  return Object.freeze({
    authority: "host_owned_workflow_policy" as const,
    snapshot: Object.freeze(() => registrySnapshot),
    registeredValidatorIds: Object.freeze(() => registeredIds),
    mandatoryValidatorIds: Object.freeze(mandatoryValidatorIds),
    resolve: Object.freeze(resolve),
    plan: Object.freeze(plan)
  });
};

const defaultRegistration: DesignAgentDeterministicValidatorRegistration = deepFreeze({
  validatorId: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
  implementationVersion: "1.0.0",
  scope: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
  applicability: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS
});

const defaultMandatoryCoverage: readonly DesignAgentMandatoryValidatorCoverage[] = deepFreeze(
  DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.map((pair) => ({
    ...pair,
    validatorIds: [DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID]
  }))
);

export const createDefaultDesignAgentDeterministicValidatorRegistry =
  (): DesignAgentDeterministicValidatorRegistry =>
    createDesignAgentDeterministicValidatorRegistry({
      registrations: [defaultRegistration],
      mandatoryCoverage: defaultMandatoryCoverage
    });

export const DEFAULT_DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY =
  createDefaultDesignAgentDeterministicValidatorRegistry();

import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { types as nodeTypes } from "node:util";
import {
  PCB_ENGINEERING_CHECKER_IDS,
  PCB_ENGINEERING_ENFORCEMENT_CLASSES,
  PCB_ENGINEERING_MODEL_IDS,
  PCB_ENGINEERING_PRACTICE_CATALOG,
  PCB_ENGINEERING_REQUIRED_INPUTS,
  PCB_ENGINEERING_SCOPE_PREDICATES,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
  type PcbEngineeringCheckerId,
  type PcbEngineeringEnforcementClass,
  type PcbEngineeringModelId,
  type PcbEngineeringPracticeCatalog,
  type PcbEngineeringPracticeRule,
  type PcbEngineeringRequiredInput,
  type PcbEngineeringScopePredicate
} from "../knowledge/pcb-engineering-practices.js";

export const ENGINEERING_CONSTRAINT_SET_SCHEMA =
  "evleda.engineering-constraint-set.v1" as const;

export const ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA =
  "evleda.engineering-constraint-context.v1" as const;

export const ENGINEERING_CONSTRAINT_BINDING_SCHEMA =
  "evleda.engineering-constraint-binding.v1" as const;

export const ENGINEERING_RULE_APPLICABILITIES = [
  "applicable",
  "not_applicable",
  "unresolved"
] as const;

export type EngineeringRuleApplicability =
  (typeof ENGINEERING_RULE_APPLICABILITIES)[number];

export const ENGINEERING_GATE_STATUSES = [
  "pass",
  "fail",
  "unresolved",
  "not_applicable"
] as const;

export type EngineeringGateStatus = (typeof ENGINEERING_GATE_STATUSES)[number];

export const ENGINEERING_GATE_OWNERS = [
  "machine",
  "fabricator",
  "human",
  "physical"
] as const;

export type EngineeringGateOwner = (typeof ENGINEERING_GATE_OWNERS)[number];

export type EngineeringEvidenceIdentity = CanonicalIdentity | ContentIdentity;

export interface EngineeringScopeFact {
  readonly predicate: PcbEngineeringScopePredicate;
  readonly value: boolean;
  readonly identity: EngineeringEvidenceIdentity;
}

/**
 * One upstream canonical value per required input is the normal form. Supplying
 * two different identities for the same input intentionally makes that input
 * conflicting; upstream evidence must reconcile sources rather than letting
 * this compiler choose one.
 */
export interface EngineeringInputBinding {
  readonly inputId: PcbEngineeringRequiredInput;
  readonly identity: EngineeringEvidenceIdentity;
}

export interface EngineeringCheckerResult {
  readonly ruleId: string;
  readonly checkerId: PcbEngineeringCheckerId;
  readonly status: Exclude<EngineeringGateStatus, "not_applicable">;
  readonly resultIdentity: EngineeringEvidenceIdentity;
  readonly exactInputIdentities: readonly EngineeringEvidenceIdentity[];
  readonly sourceIds: readonly string[];
  readonly numericClaimIds: readonly string[];
  readonly modelIds: readonly PcbEngineeringModelId[];
}

export interface EngineeringConstraintContext {
  readonly schemaVersion: typeof ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA;
  readonly scopeFacts: readonly EngineeringScopeFact[];
  readonly inputBindings: readonly EngineeringInputBinding[];
  readonly checkerResults: readonly EngineeringCheckerResult[];
}

export interface EngineeringRequiredInputEvaluation {
  readonly inputId: PcbEngineeringRequiredInput;
  readonly status: "bound" | "missing" | "conflicting";
  readonly identities: readonly EngineeringEvidenceIdentity[];
}

export interface EngineeringGateResult {
  readonly enforcementClass: PcbEngineeringEnforcementClass;
  readonly owner: EngineeringGateOwner;
  readonly status: EngineeringGateStatus;
  readonly code: EngineeringGateCode;
  readonly subjectIds: readonly string[];
  readonly checkerResultIdentities: readonly EngineeringEvidenceIdentity[];
}

export const ENGINEERING_GATE_CODES = [
  "ENGINEERING_GATE_NOT_APPLICABLE",
  "ENGINEERING_SCOPE_UNRESOLVED",
  "ENGINEERING_REQUIRED_INPUT_MISSING",
  "ENGINEERING_REQUIRED_INPUT_CONFLICT",
  "ENGINEERING_CHECKER_RESULT_MISSING",
  "ENGINEERING_CHECKER_RESULT_CONFLICT",
  "ENGINEERING_CHECKER_CONTEXT_MISMATCH",
  "ENGINEERING_CHECKER_UNAVAILABLE",
  "ENGINEERING_CHECKER_NON_GATING_EVIDENCE",
  "ENGINEERING_CHECK_FAILED",
  "ENGINEERING_CHECK_UNRESOLVED",
  "ENGINEERING_CHECK_PASSED",
  "ENGINEERING_FABRICATOR_CONFIRMATION_REQUIRED",
  "ENGINEERING_HUMAN_REVIEW_REQUIRED",
  "ENGINEERING_PHYSICAL_VALIDATION_REQUIRED"
] as const;

export type EngineeringGateCode = (typeof ENGINEERING_GATE_CODES)[number];

export interface EngineeringConstraintEvaluation {
  readonly ruleId: string;
  readonly applicability: EngineeringRuleApplicability;
  readonly matchedScopeFacts: readonly EngineeringScopeFact[];
  readonly unresolvedScopePredicates: readonly PcbEngineeringScopePredicate[];
  readonly falseScopePredicates: readonly PcbEngineeringScopePredicate[];
  readonly requiredInputs: readonly EngineeringRequiredInputEvaluation[];
  readonly enforcementClasses: readonly PcbEngineeringEnforcementClass[];
  readonly checkerIds: readonly PcbEngineeringCheckerId[];
  readonly modelIds: readonly PcbEngineeringModelId[];
  readonly sourceIds: readonly string[];
  readonly numericClaimIds: readonly string[];
  readonly gateResults: readonly EngineeringGateResult[];
}

export interface EngineeringConstraintBlocker {
  readonly id: string;
  readonly code: EngineeringGateCode;
  readonly ruleId: string;
  readonly enforcementClass: PcbEngineeringEnforcementClass;
  readonly owner: EngineeringGateOwner;
  readonly subjectIds: readonly string[];
}

export interface EngineeringConstraintCoverage {
  readonly catalogRuleCount: number;
  readonly evaluationCount: number;
  readonly catalogRuleIds: readonly string[];
  readonly evaluatedRuleIds: readonly string[];
  readonly missingRuleIds: readonly string[];
  readonly unexpectedRuleIds: readonly string[];
  readonly applicableCount: number;
  readonly notApplicableCount: number;
  readonly unresolvedCount: number;
  readonly complete: boolean;
}

export interface EngineeringConstraintSetPayload {
  readonly schemaVersion: typeof ENGINEERING_CONSTRAINT_SET_SCHEMA;
  readonly catalogIdentity: CanonicalIdentity;
  readonly contextIdentity: CanonicalIdentity;
  readonly scopeFacts: readonly EngineeringScopeFact[];
  readonly inputBindings: readonly EngineeringInputBinding[];
  readonly evaluations: readonly EngineeringConstraintEvaluation[];
  readonly coverage: EngineeringConstraintCoverage;
  readonly blockers: readonly EngineeringConstraintBlocker[];
}

export interface EngineeringConstraintSet extends EngineeringConstraintSetPayload {
  readonly identity: CanonicalIdentity;
}

export interface EngineeringCheckerEvidenceSnapshot {
  readonly snapshot: EngineeringCheckerResult;
  readonly identity: EngineeringEvidenceIdentity;
}

export interface EngineeringConstraintBindingPayload {
  readonly schemaVersion: typeof ENGINEERING_CONSTRAINT_BINDING_SCHEMA;
  readonly catalogSnapshot: PcbEngineeringPracticeCatalog;
  readonly catalogIdentity: CanonicalIdentity;
  readonly contextSnapshot: EngineeringConstraintContext;
  readonly contextIdentity: CanonicalIdentity;
  readonly checkerEvidence: readonly EngineeringCheckerEvidenceSnapshot[];
  readonly compiledConstraintSet: EngineeringConstraintSet;
  readonly compiledConstraintSetIdentity: CanonicalIdentity;
}

export interface EngineeringConstraintBinding extends EngineeringConstraintBindingPayload {
  readonly identity: CanonicalIdentity;
}

const compareCodePoint = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type RejectPlainData = (
  message: string,
  details?: Readonly<Record<string, unknown>>
) => never;

function rejectContext(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new DomainError("INVALID_ARGUMENT", message, details);
}

function rejectConstraintSet(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", message, details);
}

const assertPlainDataGraph = (
  value: unknown,
  field: string,
  reject: RejectPlainData,
  seen = new Set<object>()
): void => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    reject("Engineering data must be accessor-free, non-proxy plain JSON data", { field });
  }
  if (seen.has(value)) {
    reject("Engineering data must not contain cycles", { field });
  }
  seen.add(value);
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) {
    reject("Engineering data must have a plain object or array prototype", { field });
  }
  if (isArray) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        reject("Engineering data arrays must not be sparse", {
          field: `${field}[${index.toString()}]`
        });
      }
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      reject("Engineering data must not contain symbol keys", { field });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      reject("Engineering data must not contain accessors", { field: `${field}.${key}` });
    }
    if (isArray && key === "length") continue;
    if (isArray) {
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        index.toString() !== key
      ) {
        reject("Engineering data arrays must contain only canonical index fields", {
          field: `${field}.${key}`
        });
      }
    }
    if (!descriptor.enumerable) {
      reject("Engineering data must not contain non-enumerable fields", {
        field: `${field}.${key}`
      });
    }
    assertPlainDataGraph(descriptor.value, `${field}.${key}`, reject, seen);
  }
  seen.delete(value);
};

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
};

const detachedFrozen = <Value>(value: Value): Value => deepFreeze(structuredClone(value));

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
  reject: RejectPlainData = rejectContext
): void => {
  const actual = Object.keys(value).sort(compareCodePoint);
  const wanted = [...expected].sort(compareCodePoint);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    reject("Engineering data contains missing or unknown fields", { field, actual, expected: wanted });
  }
};

const identityKey = (identity: EngineeringEvidenceIdentity): string => canonicalJson(identity);

const uniqueSortedStrings = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(compareCodePoint);

const uniqueSortedIdentities = (
  values: readonly EngineeringEvidenceIdentity[]
): readonly EngineeringEvidenceIdentity[] => {
  const byKey = new Map<string, EngineeringEvidenceIdentity>();
  for (const identity of values) byKey.set(identityKey(identity), identity);
  return [...byKey.entries()]
    .sort(([left], [right]) => compareCodePoint(left, right))
    .map(([, identity]) => identity);
};

const exactStringSet = (left: readonly string[], right: readonly string[]): boolean =>
  canonicalJson(uniqueSortedStrings(left)) === canonicalJson(uniqueSortedStrings(right));

const exactIdentitySet = (
  left: readonly EngineeringEvidenceIdentity[],
  right: readonly EngineeringEvidenceIdentity[]
): boolean =>
  canonicalJson(uniqueSortedIdentities(left)) === canonicalJson(uniqueSortedIdentities(right));

const assertIdentity = (value: unknown, field: string): void => {
  if (
    !isRecord(value) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest)
  ) {
    rejectContext("Engineering evidence identity is invalid", { field, value });
  }
  const keys = Object.keys(value).sort(compareCodePoint);
  if ("size" in value) {
    if (
      canonicalJson(keys) !== canonicalJson(["algorithm", "digest", "size"]) ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0
    ) {
      rejectContext("Engineering content identity is invalid", { field, value });
    }
    return;
  }
  if (
    canonicalJson(keys) !==
      canonicalJson(["algorithm", "canonicalizationVersion", "digest", "schemaVersion"]) ||
    typeof value.schemaVersion !== "string" ||
    value.schemaVersion.length === 0 ||
    value.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) {
    rejectContext("Engineering canonical identity is invalid", { field, value });
  }
};

const normalizeScopeFacts = (
  facts: readonly EngineeringScopeFact[]
): readonly EngineeringScopeFact[] => {
  const normalized = new Map<string, EngineeringScopeFact>();
  for (const [index, fact] of facts.entries()) {
    if (
      !isRecord(fact) ||
      !(PCB_ENGINEERING_SCOPE_PREDICATES as readonly string[]).includes(fact.predicate) ||
      typeof fact.value !== "boolean"
    ) {
      rejectContext("Engineering scope fact is invalid", { index, fact });
    }
    exactKeys(fact, ["predicate", "value", "identity"], `scopeFacts[${index.toString()}]`);
    assertIdentity(fact.identity, `scopeFacts[${index.toString()}].identity`);
    const exact: EngineeringScopeFact = {
      predicate: fact.predicate,
      value: fact.value,
      identity: fact.identity
    };
    normalized.set(canonicalJson(exact), exact);
  }
  return [...normalized.values()].sort((left, right) =>
    compareCodePoint(
      `${left.predicate}\u0000${left.value ? "1" : "0"}\u0000${identityKey(left.identity)}`,
      `${right.predicate}\u0000${right.value ? "1" : "0"}\u0000${identityKey(right.identity)}`
    )
  );
};

const normalizeInputBindings = (
  bindings: readonly EngineeringInputBinding[]
): readonly EngineeringInputBinding[] => {
  const normalized = new Map<string, EngineeringInputBinding>();
  for (const [index, binding] of bindings.entries()) {
    if (
      !isRecord(binding) ||
      !(PCB_ENGINEERING_REQUIRED_INPUTS as readonly string[]).includes(binding.inputId)
    ) {
      rejectContext("Engineering required-input binding is invalid", { index, binding });
    }
    exactKeys(binding, ["inputId", "identity"], `inputBindings[${index.toString()}]`);
    assertIdentity(binding.identity, `inputBindings[${index.toString()}].identity`);
    const exact: EngineeringInputBinding = {
      inputId: binding.inputId,
      identity: binding.identity
    };
    normalized.set(canonicalJson(exact), exact);
  }
  return [...normalized.values()].sort((left, right) =>
    compareCodePoint(
      `${left.inputId}\u0000${identityKey(left.identity)}`,
      `${right.inputId}\u0000${identityKey(right.identity)}`
    )
  );
};

const normalizeCheckerResults = (
  values: readonly EngineeringCheckerResult[],
  catalogSnapshot: PcbEngineeringPracticeCatalog
): readonly EngineeringCheckerResult[] => {
  const ruleById = new Map(catalogSnapshot.rules.map((rule) => [rule.id, rule]));
  const normalized = new Map<string, EngineeringCheckerResult>();
  for (const [index, candidate] of values.entries()) {
    if (!isRecord(candidate)) {
      rejectContext("Engineering checker result is invalid", { index });
    }
    exactKeys(
      candidate,
      [
        "ruleId",
        "checkerId",
        "status",
        "resultIdentity",
        "exactInputIdentities",
        "sourceIds",
        "numericClaimIds",
        "modelIds"
      ],
      `checkerResults[${index.toString()}]`
    );
    const rule = typeof candidate.ruleId === "string" ? ruleById.get(candidate.ruleId) : undefined;
    if (rule === undefined) {
      rejectContext("Engineering checker result names an unknown rule", {
        index,
        ruleId: candidate.ruleId
      });
    }
    if (
      typeof candidate.checkerId !== "string" ||
      !(PCB_ENGINEERING_CHECKER_IDS as readonly string[]).includes(candidate.checkerId) ||
      !rule.checkerIds.includes(candidate.checkerId as PcbEngineeringCheckerId)
    ) {
      rejectContext("Engineering checker dispatch is not allowlisted for the rule", {
        index,
        ruleId: rule.id,
        checkerId: candidate.checkerId
      });
    }
    if (!(["pass", "fail", "unresolved"] as readonly unknown[]).includes(candidate.status)) {
      rejectContext("Engineering checker result has an invalid status", {
        index,
        status: candidate.status
      });
    }
    if (
      !Array.isArray(candidate.exactInputIdentities) ||
      !Array.isArray(candidate.sourceIds) ||
      !Array.isArray(candidate.numericClaimIds) ||
      !Array.isArray(candidate.modelIds)
    ) {
      rejectContext("Engineering checker result bindings must be arrays", { index });
    }
    assertIdentity(candidate.resultIdentity, `checkerResults[${index.toString()}].resultIdentity`);
    for (const [identityIndex, identity] of candidate.exactInputIdentities.entries()) {
      assertIdentity(
        identity,
        `checkerResults[${index.toString()}].exactInputIdentities[${identityIndex.toString()}]`
      );
    }
    if (
      candidate.sourceIds.some((sourceId) => typeof sourceId !== "string") ||
      candidate.numericClaimIds.some((claimId) => typeof claimId !== "string") ||
      candidate.modelIds.some(
        (modelId) =>
          typeof modelId !== "string" ||
          !(PCB_ENGINEERING_MODEL_IDS as readonly string[]).includes(modelId)
      )
    ) {
      rejectContext("Engineering checker result contains an unknown dispatch or binding ID", {
        index
      });
    }
    const exact: EngineeringCheckerResult = {
      ruleId: rule.id,
      checkerId: candidate.checkerId as PcbEngineeringCheckerId,
      status: candidate.status as EngineeringCheckerResult["status"],
      resultIdentity: candidate.resultIdentity as EngineeringEvidenceIdentity,
      exactInputIdentities: uniqueSortedIdentities(
        candidate.exactInputIdentities as EngineeringEvidenceIdentity[]
      ),
      sourceIds: uniqueSortedStrings(candidate.sourceIds as string[]),
      numericClaimIds: uniqueSortedStrings(candidate.numericClaimIds as string[]),
      modelIds: uniqueSortedStrings(candidate.modelIds as string[]) as PcbEngineeringModelId[]
    };
    normalized.set(canonicalJson(exact), exact);
  }
  return [...normalized.values()].sort((left, right) =>
    compareCodePoint(
      `${left.ruleId}\u0000${left.checkerId}\u0000${identityKey(left.resultIdentity)}\u0000${canonicalJson(left)}`,
      `${right.ruleId}\u0000${right.checkerId}\u0000${identityKey(right.resultIdentity)}\u0000${canonicalJson(right)}`
    )
  );
};

const validateContextAgainstCatalogSnapshot = (
  value: unknown,
  catalogSnapshot: PcbEngineeringPracticeCatalog
): EngineeringConstraintContext => {
  assertPlainDataGraph(value, "context", rejectContext);
  const detached = detachedFrozen(value);
  if (!isRecord(detached)) {
    rejectContext("Engineering constraint context must be an object");
  }
  exactKeys(
    detached,
    ["schemaVersion", "scopeFacts", "inputBindings", "checkerResults"],
    "context"
  );
  if (
    detached.schemaVersion !== ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA ||
    !Array.isArray(detached.scopeFacts) ||
    !Array.isArray(detached.inputBindings) ||
    !Array.isArray(detached.checkerResults)
  ) {
    rejectContext("Engineering constraint context has an invalid closed schema");
  }
  return deepFreeze({
    schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
    scopeFacts: normalizeScopeFacts(detached.scopeFacts as EngineeringScopeFact[]),
    inputBindings: normalizeInputBindings(detached.inputBindings as EngineeringInputBinding[]),
    checkerResults: normalizeCheckerResults(
      detached.checkerResults as EngineeringCheckerResult[],
      catalogSnapshot
    )
  });
};

export const validateAndSnapshotEngineeringConstraintContext = (
  value: unknown,
  catalog: unknown
): EngineeringConstraintContext => {
  const catalogSnapshot = validateAndSnapshotPcbEngineeringPracticeCatalog(catalog);
  return validateContextAgainstCatalogSnapshot(value, catalogSnapshot);
};

export const engineeringConstraintContextIdentity = (
  contextSnapshot: EngineeringConstraintContext
): CanonicalIdentity =>
  canonicalIdentity(contextSnapshot, ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA);

const requiredInputEvaluations = (
  rule: PcbEngineeringPracticeRule,
  bindings: readonly EngineeringInputBinding[]
): readonly EngineeringRequiredInputEvaluation[] =>
  [...rule.requiredInputs]
    .sort(compareCodePoint)
    .map((inputId): EngineeringRequiredInputEvaluation => {
      const identities = uniqueSortedIdentities(
        bindings.filter((binding) => binding.inputId === inputId).map((binding) => binding.identity)
      );
      return {
        inputId,
        status: identities.length === 0 ? "missing" : identities.length === 1 ? "bound" : "conflicting",
        identities
      };
    });

interface MachineResolution {
  readonly status: Exclude<EngineeringGateStatus, "not_applicable">;
  readonly code: EngineeringGateCode;
  readonly subjectIds: readonly string[];
  readonly checkerResultIdentities: readonly EngineeringEvidenceIdentity[];
}

const PERMANENTLY_UNAVAILABLE_CHECKERS: ReadonlySet<PcbEngineeringCheckerId> = new Set([
  "licensed_ipc2152_lookup_required_v1"
]);

const PHASE_ONE_NON_GATING_CHECKERS: ReadonlySet<PcbEngineeringCheckerId> = new Set([
  "hot_copper_resistance_v1",
  "copper_voltage_drop_v1",
  "copper_i2r_loss_v1",
  "via_barrel_resistance_v1"
]);

const resolveMachineGate = (
  rule: PcbEngineeringPracticeRule,
  applicability: EngineeringRuleApplicability,
  unresolvedScopePredicates: readonly PcbEngineeringScopePredicate[],
  inputs: readonly EngineeringRequiredInputEvaluation[],
  checkerResults: readonly EngineeringCheckerResult[]
): MachineResolution | { readonly status: "not_applicable"; readonly code: EngineeringGateCode; readonly subjectIds: readonly string[]; readonly checkerResultIdentities: readonly EngineeringEvidenceIdentity[] } => {
  if (applicability === "not_applicable") {
    return {
      status: "not_applicable",
      code: "ENGINEERING_GATE_NOT_APPLICABLE",
      subjectIds: [],
      checkerResultIdentities: []
    };
  }
  if (applicability === "unresolved") {
    return {
      status: "unresolved",
      code: "ENGINEERING_SCOPE_UNRESOLVED",
      subjectIds: unresolvedScopePredicates,
      checkerResultIdentities: []
    };
  }

  const conflictingInputs = inputs
    .filter((input) => input.status === "conflicting")
    .map((input) => input.inputId);
  if (conflictingInputs.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_REQUIRED_INPUT_CONFLICT",
      subjectIds: conflictingInputs,
      checkerResultIdentities: []
    };
  }
  const missingInputs = inputs
    .filter((input) => input.status === "missing")
    .map((input) => input.inputId);
  if (missingInputs.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_REQUIRED_INPUT_MISSING",
      subjectIds: missingInputs,
      checkerResultIdentities: []
    };
  }

  const unavailable = rule.checkerIds.filter((checkerId) =>
    PERMANENTLY_UNAVAILABLE_CHECKERS.has(checkerId)
  );
  if (unavailable.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_CHECKER_UNAVAILABLE",
      subjectIds: [...unavailable].sort(compareCodePoint),
      checkerResultIdentities: []
    };
  }

  const resultsByChecker = new Map<PcbEngineeringCheckerId, readonly EngineeringCheckerResult[]>();
  for (const checkerId of rule.checkerIds) {
    resultsByChecker.set(
      checkerId,
      checkerResults.filter(
        (result) => result.ruleId === rule.id && result.checkerId === checkerId
      )
    );
  }
  const missingCheckers = [...resultsByChecker.entries()]
    .filter(([, results]) => results.length === 0)
    .map(([checkerId]) => checkerId)
    .sort(compareCodePoint);
  if (missingCheckers.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_CHECKER_RESULT_MISSING",
      subjectIds: missingCheckers,
      checkerResultIdentities: []
    };
  }
  const conflictingCheckers = [...resultsByChecker.entries()]
    .filter(([, results]) => results.length > 1)
    .map(([checkerId]) => checkerId)
    .sort(compareCodePoint);
  if (conflictingCheckers.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_CHECKER_RESULT_CONFLICT",
      subjectIds: conflictingCheckers,
      checkerResultIdentities: uniqueSortedIdentities(
        conflictingCheckers.flatMap((checkerId) =>
          (resultsByChecker.get(checkerId) ?? []).map((result) => result.resultIdentity)
        )
      )
    };
  }

  const results = rule.checkerIds.map((checkerId) => resultsByChecker.get(checkerId)![0]!);
  const expectedInputs = inputs.flatMap((input) => input.identities);
  const expectedSources = [...rule.sourceIds];
  const expectedClaims = rule.numericClaims.map((claim) => claim.id);
  const expectedModels = [...rule.modelIds];
  const mismatched = results
    .filter(
      (result) =>
        !exactIdentitySet(result.exactInputIdentities, expectedInputs) ||
        !exactStringSet(result.sourceIds, expectedSources) ||
        !exactStringSet(result.numericClaimIds, expectedClaims) ||
        !exactStringSet(result.modelIds, expectedModels)
    )
    .map((result) => result.checkerId)
    .sort(compareCodePoint);
  const resultIdentities = uniqueSortedIdentities(results.map((result) => result.resultIdentity));
  if (mismatched.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_CHECKER_CONTEXT_MISMATCH",
      subjectIds: mismatched,
      checkerResultIdentities: resultIdentities
    };
  }

  const failed = results
    .filter((result) => result.status === "fail")
    .map((result) => result.checkerId)
    .sort(compareCodePoint);
  if (failed.length > 0) {
    return {
      status: "fail",
      code: "ENGINEERING_CHECK_FAILED",
      subjectIds: failed,
      checkerResultIdentities: resultIdentities
    };
  }
  const unresolved = results
    .filter((result) => result.status === "unresolved")
    .map((result) => result.checkerId)
    .sort(compareCodePoint);
  if (unresolved.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_CHECK_UNRESOLVED",
      subjectIds: unresolved,
      checkerResultIdentities: resultIdentities
    };
  }
  const nonGating = rule.checkerIds
    .filter((checkerId) => PHASE_ONE_NON_GATING_CHECKERS.has(checkerId))
    .sort(compareCodePoint);
  if (nonGating.length > 0) {
    return {
      status: "unresolved",
      code: "ENGINEERING_CHECKER_NON_GATING_EVIDENCE",
      subjectIds: nonGating,
      checkerResultIdentities: resultIdentities
    };
  }
  return {
    status: "pass",
    code: "ENGINEERING_CHECK_PASSED",
    subjectIds: [...rule.checkerIds].sort(compareCodePoint),
    checkerResultIdentities: resultIdentities
  };
};

const externalCode = (owner: Exclude<EngineeringGateOwner, "machine">): EngineeringGateCode => {
  if (owner === "fabricator") return "ENGINEERING_FABRICATOR_CONFIRMATION_REQUIRED";
  if (owner === "human") return "ENGINEERING_HUMAN_REVIEW_REQUIRED";
  return "ENGINEERING_PHYSICAL_VALIDATION_REQUIRED";
};

const ownersForEnforcementClass = (
  enforcementClass: PcbEngineeringEnforcementClass
): readonly EngineeringGateOwner[] => {
  if (enforcementClass === "fabricator_confirmation") return ["fabricator"];
  if (enforcementClass === "human_physical_gate") return ["human", "physical"];
  return ["machine"];
};

const gateResultsFor = (
  rule: PcbEngineeringPracticeRule,
  applicability: EngineeringRuleApplicability,
  machine: ReturnType<typeof resolveMachineGate>
): readonly EngineeringGateResult[] =>
  rule.enforcementClasses
    .flatMap((enforcementClass): readonly EngineeringGateResult[] =>
      ownersForEnforcementClass(enforcementClass).map((owner): EngineeringGateResult => {
        if (owner === "machine") {
          return {
            enforcementClass,
            owner,
            ...machine
          };
        }
        if (applicability === "not_applicable") {
          return {
            enforcementClass,
            owner,
            status: "not_applicable",
            code: "ENGINEERING_GATE_NOT_APPLICABLE",
            subjectIds: [],
            checkerResultIdentities: []
          };
        }
        if (applicability === "unresolved") {
          return {
            enforcementClass,
            owner,
            status: "unresolved",
            code: "ENGINEERING_SCOPE_UNRESOLVED",
            subjectIds: machine.subjectIds,
            checkerResultIdentities: []
          };
        }
        return {
          enforcementClass,
          owner,
          status: "unresolved",
          code: externalCode(owner),
          subjectIds: [rule.id],
          checkerResultIdentities: []
        };
      })
    )
    .sort((left, right) =>
      compareCodePoint(
        `${left.enforcementClass}\u0000${left.owner}`,
        `${right.enforcementClass}\u0000${right.owner}`
      )
    );

const shouldBlock = (gate: EngineeringGateResult): boolean => {
  if (gate.status === "not_applicable" || gate.status === "pass") return false;
  if (gate.enforcementClass === "advisory" && gate.owner === "machine") return false;
  return true;
};

const blockerFor = (
  evaluation: EngineeringConstraintEvaluation,
  gate: EngineeringGateResult
): EngineeringConstraintBlocker => ({
  id: [
    gate.code,
    evaluation.ruleId,
    gate.enforcementClass,
    gate.owner,
    ...gate.subjectIds
  ].join(":"),
  code: gate.code,
  ruleId: evaluation.ruleId,
  enforcementClass: gate.enforcementClass,
  owner: gate.owner,
  subjectIds: gate.subjectIds
});

const evaluationFor = (
  rule: PcbEngineeringPracticeRule,
  scopeFacts: readonly EngineeringScopeFact[],
  inputBindings: readonly EngineeringInputBinding[],
  checkerResults: readonly EngineeringCheckerResult[]
): EngineeringConstraintEvaluation => {
  const predicates = [...rule.scopePredicates].sort(compareCodePoint);
  const matchedScopeFacts = scopeFacts.filter((fact) => predicates.includes(fact.predicate));
  const missingScopePredicates: PcbEngineeringScopePredicate[] = [];
  const conflictingScopePredicates: PcbEngineeringScopePredicate[] = [];
  const falseScopePredicates: PcbEngineeringScopePredicate[] = [];
  for (const predicate of predicates) {
    const values = new Set(
      matchedScopeFacts.filter((fact) => fact.predicate === predicate).map((fact) => fact.value)
    );
    if (values.size === 0) missingScopePredicates.push(predicate);
    else if (values.size > 1) conflictingScopePredicates.push(predicate);
    else if (values.has(false)) falseScopePredicates.push(predicate);
  }
  const unresolvedScopePredicates = [
    ...missingScopePredicates,
    ...conflictingScopePredicates
  ].sort(compareCodePoint);
  const applicability: EngineeringRuleApplicability =
    unresolvedScopePredicates.length > 0
      ? "unresolved"
      : falseScopePredicates.length > 0
        ? "not_applicable"
        : "applicable";
  const requiredInputs = requiredInputEvaluations(rule, inputBindings);
  const machine = resolveMachineGate(
    rule,
    applicability,
    unresolvedScopePredicates,
    requiredInputs,
    checkerResults
  );
  return {
    ruleId: rule.id,
    applicability,
    matchedScopeFacts,
    unresolvedScopePredicates,
    falseScopePredicates,
    requiredInputs,
    enforcementClasses: [...rule.enforcementClasses].sort(compareCodePoint),
    checkerIds: [...rule.checkerIds].sort(compareCodePoint),
    modelIds: [...rule.modelIds].sort(compareCodePoint),
    sourceIds: [...rule.sourceIds].sort(compareCodePoint),
    numericClaimIds: rule.numericClaims.map((claim) => claim.id).sort(compareCodePoint),
    gateResults: gateResultsFor(rule, applicability, machine)
  };
};

const compileFromSnapshots = (
  contextSnapshot: EngineeringConstraintContext,
  catalogSnapshot: PcbEngineeringPracticeCatalog
): EngineeringConstraintSet => {
  const { scopeFacts, inputBindings, checkerResults } = contextSnapshot;
  const contextIdentity = engineeringConstraintContextIdentity(contextSnapshot);
  const evaluations = [...catalogSnapshot.rules]
    .sort((left, right) => compareCodePoint(left.id, right.id))
    .map((rule) => evaluationFor(rule, scopeFacts, inputBindings, checkerResults));
  const catalogRuleIds = catalogSnapshot.rules.map((rule) => rule.id).sort(compareCodePoint);
  const evaluatedRuleIds = evaluations.map((evaluation) => evaluation.ruleId);
  const missingRuleIds = catalogRuleIds.filter((ruleId) => !evaluatedRuleIds.includes(ruleId));
  const unexpectedRuleIds = evaluatedRuleIds.filter((ruleId) => !catalogRuleIds.includes(ruleId));
  const coverage: EngineeringConstraintCoverage = {
    catalogRuleCount: catalogRuleIds.length,
    evaluationCount: evaluatedRuleIds.length,
    catalogRuleIds,
    evaluatedRuleIds,
    missingRuleIds,
    unexpectedRuleIds,
    applicableCount: evaluations.filter((entry) => entry.applicability === "applicable").length,
    notApplicableCount: evaluations.filter((entry) => entry.applicability === "not_applicable").length,
    unresolvedCount: evaluations.filter((entry) => entry.applicability === "unresolved").length,
    complete:
      missingRuleIds.length === 0 &&
      unexpectedRuleIds.length === 0 &&
      catalogRuleIds.length === evaluatedRuleIds.length
  };
  const blockers = evaluations
    .flatMap((evaluation) =>
      evaluation.gateResults
        .filter(shouldBlock)
        .map((gate) => blockerFor(evaluation, gate))
    )
    .sort((left, right) => compareCodePoint(left.id, right.id));
  const payload: EngineeringConstraintSetPayload = {
    schemaVersion: ENGINEERING_CONSTRAINT_SET_SCHEMA,
    catalogIdentity: catalogSnapshot.identity,
    contextIdentity,
    scopeFacts,
    inputBindings,
    evaluations,
    coverage,
    blockers
  };
  const compiled: EngineeringConstraintSet = {
    ...payload,
    identity: canonicalIdentity(payload, ENGINEERING_CONSTRAINT_SET_SCHEMA)
  };
  assertConstraintSetShape(compiled);
  return deepFreeze(compiled);
};

export const compileEngineeringConstraintSet = (
  context: unknown,
  catalog: unknown = PCB_ENGINEERING_PRACTICE_CATALOG
): EngineeringConstraintSet => {
  const catalogSnapshot = validateAndSnapshotPcbEngineeringPracticeCatalog(catalog);
  const contextSnapshot = validateContextAgainstCatalogSnapshot(context, catalogSnapshot);
  return compileFromSnapshots(contextSnapshot, catalogSnapshot);
};

const sortedBy = <T>(
  values: readonly T[],
  key: (value: T) => string
): boolean =>
  values.every(
    (value, index) => index === 0 || compareCodePoint(key(values[index - 1]!), key(value)) <= 0
  );

function assertConstraintSetShape(
  value: unknown
): asserts value is EngineeringConstraintSet {
  if (!isRecord(value) || value.schemaVersion !== ENGINEERING_CONSTRAINT_SET_SCHEMA) {
    rejectConstraintSet("Engineering constraint set has an invalid schema version");
  }
  const expectedTopLevelKeys = [
    "blockers",
    "catalogIdentity",
    "contextIdentity",
    "coverage",
    "evaluations",
    "identity",
    "inputBindings",
    "schemaVersion",
    "scopeFacts"
  ];
  if (canonicalJson(Object.keys(value).sort(compareCodePoint)) !== canonicalJson(expectedTopLevelKeys)) {
    rejectConstraintSet("Engineering constraint set contains missing or unknown fields");
  }
  try {
    assertIdentity(value.catalogIdentity, "catalogIdentity");
    assertIdentity(value.contextIdentity, "contextIdentity");
    assertIdentity(value.identity, "identity");
  } catch (error) {
    if (error instanceof DomainError) {
      rejectConstraintSet("Engineering constraint set contains an invalid identity", error.details);
    }
    throw error;
  }
  if (
    !Array.isArray(value.scopeFacts) ||
    !Array.isArray(value.inputBindings) ||
    !Array.isArray(value.evaluations) ||
    !Array.isArray(value.blockers) ||
    !isRecord(value.coverage)
  ) {
    rejectConstraintSet("Engineering constraint set arrays or coverage are invalid");
  }
  try {
    const normalizedScopeFacts = normalizeScopeFacts(
      value.scopeFacts as unknown as EngineeringScopeFact[]
    );
    const normalizedInputBindings = normalizeInputBindings(
      value.inputBindings as unknown as EngineeringInputBinding[]
    );
    if (
      canonicalJson(normalizedScopeFacts) !== canonicalJson(value.scopeFacts) ||
      canonicalJson(normalizedInputBindings) !== canonicalJson(value.inputBindings)
    ) {
      rejectConstraintSet("Engineering context bindings are not uniquely and deterministically sorted");
    }
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_ARGUMENT") {
      rejectConstraintSet("Engineering constraint set contains invalid context bindings", error.details);
    }
    throw error;
  }
  const evaluations = value.evaluations as unknown[];
  const blockers = value.blockers as unknown[];
  if (
    !evaluations.every(isRecord) ||
    !blockers.every(isRecord) ||
    !sortedBy(evaluations as Record<string, unknown>[], (entry) => String(entry.ruleId)) ||
    !sortedBy(blockers as Record<string, unknown>[], (entry) => String(entry.id))
  ) {
    rejectConstraintSet("Engineering constraint set records are not deterministically sorted");
  }
  const ruleIds = (evaluations as Record<string, unknown>[]).map((entry) => entry.ruleId);
  if (
    ruleIds.some((ruleId) => typeof ruleId !== "string") ||
    new Set(ruleIds).size !== ruleIds.length
  ) {
    rejectConstraintSet("Engineering constraint evaluations have invalid or duplicate rule IDs");
  }
  for (const evaluation of evaluations as Record<string, unknown>[]) {
    if (
      !(ENGINEERING_RULE_APPLICABILITIES as readonly unknown[]).includes(
        evaluation.applicability
      ) ||
      !Array.isArray(evaluation.enforcementClasses) ||
      !Array.isArray(evaluation.checkerIds) ||
      !Array.isArray(evaluation.modelIds) ||
      !Array.isArray(evaluation.sourceIds) ||
      !Array.isArray(evaluation.numericClaimIds) ||
      !Array.isArray(evaluation.matchedScopeFacts) ||
      !Array.isArray(evaluation.unresolvedScopePredicates) ||
      !Array.isArray(evaluation.falseScopePredicates) ||
      !Array.isArray(evaluation.requiredInputs) ||
      !Array.isArray(evaluation.gateResults)
    ) {
      rejectConstraintSet("Engineering constraint evaluation is malformed", {
        ruleId: evaluation.ruleId
      });
    }
    const enforcementClasses = evaluation.enforcementClasses as unknown[];
    if (
      enforcementClasses.some(
        (entry) =>
          typeof entry !== "string" ||
          !(PCB_ENGINEERING_ENFORCEMENT_CLASSES as readonly string[]).includes(entry)
      ) ||
      new Set(enforcementClasses).size !== enforcementClasses.length ||
      !sortedBy(enforcementClasses as string[], (entry) => entry)
    ) {
      rejectConstraintSet("Engineering evaluation enforcement classes are invalid", {
        ruleId: evaluation.ruleId
      });
    }
    const gateResults = evaluation.gateResults as unknown[];
    if (!gateResults.every(isRecord)) {
      rejectConstraintSet("Engineering gate result is malformed", {
        ruleId: evaluation.ruleId
      });
    }
    const seenGateOwners = new Set<string>();
    for (const gate of gateResults as Record<string, unknown>[]) {
      if (
        !(PCB_ENGINEERING_ENFORCEMENT_CLASSES as readonly unknown[]).includes(
          gate.enforcementClass
        ) ||
        !(ENGINEERING_GATE_OWNERS as readonly unknown[]).includes(gate.owner) ||
        !(ENGINEERING_GATE_STATUSES as readonly unknown[]).includes(gate.status) ||
        !(ENGINEERING_GATE_CODES as readonly unknown[]).includes(gate.code) ||
        !Array.isArray(gate.subjectIds) ||
        gate.subjectIds.some((subjectId) => typeof subjectId !== "string") ||
        !Array.isArray(gate.checkerResultIdentities)
      ) {
        rejectConstraintSet("Engineering gate result is malformed", {
          ruleId: evaluation.ruleId
        });
      }
      const enforcementClass = gate.enforcementClass as PcbEngineeringEnforcementClass;
      const owner = gate.owner as EngineeringGateOwner;
      if (
        !enforcementClasses.includes(enforcementClass) ||
        !ownersForEnforcementClass(enforcementClass).includes(owner)
      ) {
        rejectConstraintSet("Engineering gate result has the wrong owner", {
          ruleId: evaluation.ruleId,
          enforcementClass,
          owner
        });
      }
      const gateOwnerKey = `${enforcementClass}\u0000${owner}`;
      if (seenGateOwners.has(gateOwnerKey)) {
        rejectConstraintSet("Engineering gate result is duplicated", {
          ruleId: evaluation.ruleId,
          enforcementClass,
          owner
        });
      }
      seenGateOwners.add(gateOwnerKey);
      for (const [index, identity] of gate.checkerResultIdentities.entries()) {
        try {
          assertIdentity(
            identity,
            `evaluations.${String(evaluation.ruleId)}.gateResults.${gateOwnerKey}.checkerResultIdentities[${index.toString()}]`
          );
        } catch (error) {
          if (error instanceof DomainError && error.code === "INVALID_ARGUMENT") {
            rejectConstraintSet("Engineering gate result identity is invalid", error.details);
          }
          throw error;
        }
      }
      if (gate.owner !== "machine" && gate.status === "pass") {
        rejectConstraintSet("External engineering gates cannot become machine pass", {
          ruleId: evaluation.ruleId,
          owner: gate.owner
        });
      }
      if (
        (evaluation.applicability === "not_applicable" &&
          gate.status !== "not_applicable") ||
        (evaluation.applicability !== "not_applicable" &&
          gate.status === "not_applicable")
      ) {
        rejectConstraintSet("Engineering gate status contradicts rule applicability", {
          ruleId: evaluation.ruleId,
          applicability: evaluation.applicability,
          status: gate.status
        });
      }
      if (
        gate.status === "unresolved" &&
        (gate.enforcementClass === "hard_gate" ||
          gate.enforcementClass === "calculation_gate") &&
        !blockers.some(
          (blocker) =>
            blocker.ruleId === evaluation.ruleId &&
            blocker.enforcementClass === gate.enforcementClass &&
            blocker.owner === gate.owner &&
            blocker.code === gate.code
        )
      ) {
        rejectConstraintSet("Unresolved hard or calculation gate lacks a stable blocker", {
          ruleId: evaluation.ruleId,
          enforcementClass: gate.enforcementClass
        });
      }
    }
    const expectedGateOwnerKeys = (enforcementClasses as PcbEngineeringEnforcementClass[])
      .flatMap((enforcementClass) =>
        ownersForEnforcementClass(enforcementClass).map(
          (owner) => `${enforcementClass}\u0000${owner}`
        )
      )
      .sort(compareCodePoint);
    if (
      canonicalJson([...seenGateOwners].sort(compareCodePoint)) !==
      canonicalJson(expectedGateOwnerKeys)
    ) {
      rejectConstraintSet("Engineering evaluation does not cover every gate owner", {
        ruleId: evaluation.ruleId
      });
    }
  }
  const coverage = value.coverage;
  if (
    coverage.evaluationCount !== evaluations.length ||
    coverage.catalogRuleCount !== evaluations.length ||
    coverage.complete !== true ||
    !Array.isArray(coverage.catalogRuleIds) ||
    !Array.isArray(coverage.evaluatedRuleIds) ||
    canonicalJson(coverage.catalogRuleIds) !== canonicalJson(ruleIds) ||
    canonicalJson(coverage.evaluatedRuleIds) !== canonicalJson(ruleIds) ||
    !Array.isArray(coverage.missingRuleIds) ||
    coverage.missingRuleIds.length !== 0 ||
    !Array.isArray(coverage.unexpectedRuleIds) ||
    coverage.unexpectedRuleIds.length !== 0
  ) {
    rejectConstraintSet("Engineering constraint coverage is incomplete or inconsistent");
  }
  const identity = value.identity;
  const { identity: _identity, ...payload } = value;
  const recomputed = canonicalIdentity(payload, ENGINEERING_CONSTRAINT_SET_SCHEMA);
  if (canonicalJson(identity) !== canonicalJson(recomputed)) {
    rejectConstraintSet("Engineering constraint set identity does not reproduce", {
      expected: identity,
      actual: recomputed
    });
  }
}

export const validateAndSnapshotEngineeringConstraintSet = (
  value: unknown,
  context: unknown,
  catalog: unknown
): EngineeringConstraintSet => {
  assertPlainDataGraph(value, "constraintSet", rejectConstraintSet);
  const candidate = detachedFrozen(value);
  assertConstraintSetShape(candidate);
  const catalogSnapshot = validateAndSnapshotPcbEngineeringPracticeCatalog(catalog);
  const contextSnapshot = validateContextAgainstCatalogSnapshot(context, catalogSnapshot);
  const expected = compileFromSnapshots(contextSnapshot, catalogSnapshot);
  if (canonicalJson(candidate) !== canonicalJson(expected)) {
    rejectConstraintSet(
      "Engineering constraint set does not reproduce from the exact catalog and context snapshots",
      {
        expectedIdentity: expected.identity,
        actualIdentity: (candidate as EngineeringConstraintSet).identity
      }
    );
  }
  return expected;
};

const bindingFromSnapshots = (
  contextSnapshot: EngineeringConstraintContext,
  catalogSnapshot: PcbEngineeringPracticeCatalog
): EngineeringConstraintBinding => {
  const compiledConstraintSet = compileFromSnapshots(contextSnapshot, catalogSnapshot);
  const checkerEvidence: readonly EngineeringCheckerEvidenceSnapshot[] =
    contextSnapshot.checkerResults.map((snapshot) => ({
      snapshot,
      identity: snapshot.resultIdentity
    }));
  const payload: EngineeringConstraintBindingPayload = {
    schemaVersion: ENGINEERING_CONSTRAINT_BINDING_SCHEMA,
    catalogSnapshot,
    catalogIdentity: catalogSnapshot.identity,
    contextSnapshot,
    contextIdentity: engineeringConstraintContextIdentity(contextSnapshot),
    checkerEvidence,
    compiledConstraintSet,
    compiledConstraintSetIdentity: compiledConstraintSet.identity
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, ENGINEERING_CONSTRAINT_BINDING_SCHEMA)
  });
};

export const compileEngineeringConstraintBinding = (
  context: unknown,
  catalog: unknown = PCB_ENGINEERING_PRACTICE_CATALOG
): EngineeringConstraintBinding => {
  const catalogSnapshot = validateAndSnapshotPcbEngineeringPracticeCatalog(catalog);
  const contextSnapshot = validateContextAgainstCatalogSnapshot(context, catalogSnapshot);
  return bindingFromSnapshots(contextSnapshot, catalogSnapshot);
};

export const validateAndSnapshotEngineeringConstraintBinding = (
  value: unknown
): EngineeringConstraintBinding => {
  assertPlainDataGraph(value, "binding", rejectConstraintSet);
  const candidate = detachedFrozen(value);
  if (!isRecord(candidate)) {
    rejectConstraintSet("Engineering constraint binding must be an object");
  }
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "catalogSnapshot",
      "catalogIdentity",
      "contextSnapshot",
      "contextIdentity",
      "checkerEvidence",
      "compiledConstraintSet",
      "compiledConstraintSetIdentity",
      "identity"
    ],
    "binding",
    rejectConstraintSet
  );
  if (candidate.schemaVersion !== ENGINEERING_CONSTRAINT_BINDING_SCHEMA) {
    rejectConstraintSet("Engineering constraint binding has an invalid schema version");
  }
  const catalogSnapshot = validateAndSnapshotPcbEngineeringPracticeCatalog(
    candidate.catalogSnapshot
  );
  const contextSnapshot = validateContextAgainstCatalogSnapshot(
    candidate.contextSnapshot,
    catalogSnapshot
  );
  const expected = bindingFromSnapshots(contextSnapshot, catalogSnapshot);
  if (canonicalJson(candidate) !== canonicalJson(expected)) {
    rejectConstraintSet(
      "Engineering constraint binding does not reproduce from its exact snapshots and evidence",
      {
        expectedIdentity: expected.identity,
        actualIdentity: candidate.identity
      }
    );
  }
  return expected;
};

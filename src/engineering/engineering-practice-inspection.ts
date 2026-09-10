import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  ToolIdentity,
  ValidationStatus
} from "../domain/types.js";
import type {
  EngineeringConstraintBinding,
  EngineeringConstraintEvaluation,
  EngineeringEvidenceIdentity,
  EngineeringGateResult
} from "./constraint-compiler.js";
import type {
  PcbEngineeringPracticeCatalog,
  PcbEngineeringPracticeRule
} from "../knowledge/pcb-engineering-practices.js";
import type {
  PcbPracticeAnalysis,
  PcbPracticeFinding
} from "../integrations/pcb-practice-analyzer.js";
import type {
  EngineeringAdvisoryProjection,
  EngineeringCheckSummary,
  EngineeringExternalGateProjection,
  EngineeringFindingProjection,
  EngineeringMachineStatus,
  EngineeringPracticeInspectionResult,
  EngineeringRuleProjection,
  EngineeringSourceProjection
} from "../application/results.js";
import { PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES } from "../workflow/contracts.js";

export const ENGINEERING_PRACTICE_INSPECTION_SCHEMA =
  "evleda.engineering-practice-inspection.v1" as const;

const ENGINEERING_FINDING_CURSOR_SCHEMA =
  "evleda.engineering-practice-finding-cursor.v1" as const;

// The only currently supported capability evidence contract is explicitly
// self-attested/non-gating. A future trusted contract must change this server-
// owned authority decision before any supplied profile can enable POC.
const CURRENT_FABRICATION_PROFILE_AUTHORITY_IS_GATING = false as const;

export interface EngineeringInspectionExecution {
  readonly validationStatus: ValidationStatus;
  /** Domain-normalized status derived from a strictly reproduced report, when richer than ValidationStatus. */
  readonly machineStatus?: EngineeringMachineStatus;
  readonly current: boolean;
  readonly artifactId: string;
  readonly evidenceId: string;
  readonly reportIdentity: ContentIdentity;
  readonly tool: ToolIdentity;
  readonly evaluatedAt: string;
}

export interface VerifiedReferenceFabricationProfile {
  readonly profileArtifactIdentity: ContentIdentity;
  readonly capabilitySnapshotIdentity: ContentIdentity;
  readonly serviceAndOrderOptionsIdentity: CanonicalIdentity;
  readonly stackupIdentity: CanonicalIdentity;
  readonly evidenceId: string;
  readonly tool: ToolIdentity;
  readonly evaluatedAt: string;
  readonly sourceCaptureIdentity: ContentIdentity;
  readonly sourceLocator: { readonly kind: string; readonly value: string };
  readonly sourceExcerptIdentity: ContentIdentity;
}

export interface EngineeringPracticeInspectionBuildInput {
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string | null;
  readonly isHeadRevision: boolean;
  readonly revisionManifest: CanonicalIdentity | null;
  readonly requirementsIdentity: CanonicalIdentity | null;
  readonly evidenceRootIdentity: CanonicalIdentity;
  readonly practiceCatalog: PcbEngineeringPracticeCatalog | null;
  readonly routeQualityPolicy: Readonly<Record<string, unknown>> | null;
  readonly routeQualityPolicyIdentity: CanonicalIdentity | null;
  readonly routeQualityPolicyCaptureIdentity: ContentIdentity | null;
  readonly routeQualityRuleDeck: Readonly<Record<string, unknown>> | null;
  readonly routeQualityRuleDeckIdentity: CanonicalIdentity | null;
  readonly proofFixturePolicyIdentity: CanonicalIdentity | null;
  readonly analyzerProfileIdentity: CanonicalIdentity | null;
  readonly constraintBinding: EngineeringConstraintBinding | null;
  readonly authoritativeScopeFactIdentities: readonly EngineeringEvidenceIdentity[];
  readonly authoritativeCheckerResultIdentities: readonly EngineeringEvidenceIdentity[];
  readonly verifiedReferenceFabricationProfile: VerifiedReferenceFabricationProfile | null;
  readonly nativeBoard:
    | {
        readonly artifactId: string;
        readonly identity: ContentIdentity;
      }
    | null;
  readonly nativeDrc: EngineeringInspectionExecution | null;
  readonly evledaPractice:
    | (EngineeringInspectionExecution & {
        readonly analysis: PcbPracticeAnalysis;
        readonly reviewRequired?: boolean;
      })
    | null;
  readonly findingCursor?: string;
  readonly findingLimit: number;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const uniqueSorted = <Value extends string>(values: readonly Value[]): readonly Value[] =>
  [...new Set(values)].sort(compareText);

const sameIdentity = (
  left: ContentIdentity | CanonicalIdentity,
  right: ContentIdentity | CanonicalIdentity
): boolean => canonicalJson(left) === canonicalJson(right);

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const reasonMessage = (code: string): string => {
  const messages: Readonly<Record<string, string>> = {
    ENGINEERING_GATE_NOT_APPLICABLE:
      "The bound scope facts prove this rule does not apply to the selected revision.",
    ENGINEERING_SCOPE_UNRESOLVED:
      "The bound scope facts do not establish whether this rule applies.",
    ENGINEERING_REQUIRED_INPUT_MISSING:
      "At least one required engineering input is absent from the bound context.",
    ENGINEERING_REQUIRED_INPUT_CONFLICT:
      "The bound context contains conflicting identities for a required engineering input.",
    ENGINEERING_CHECKER_RESULT_MISSING:
      "All prerequisites are bound, but the required checker has not produced a current result.",
    ENGINEERING_CHECKER_RESULT_CONFLICT:
      "More than one checker result claims authority for the same rule and checker.",
    ENGINEERING_CHECKER_CONTEXT_MISMATCH:
      "The checker output is not bound to the exact current inputs, sources, claims, and models.",
    ENGINEERING_CHECKER_UNAVAILABLE:
      "The required deterministic checker is unavailable in the supported execution envelope.",
    ENGINEERING_CHECKER_NON_GATING_EVIDENCE:
      "The available checker output is explicitly non-gating and cannot establish a machine pass.",
    ENGINEERING_CHECK_FAILED:
      "The exact bound checker result failed this engineering rule.",
    ENGINEERING_CHECK_UNRESOLVED:
      "The exact bound checker result is inconclusive.",
    ENGINEERING_CHECK_PASSED:
      "Every required current checker passed against the exact bound inputs.",
    ENGINEERING_SOURCE_CAPTURE_INCOMPLETE:
      "A hard numeric claim lacks an immutable source capture, locator, or excerpt identity.",
    ENGINEERING_CONSTRAINT_BINDING_NOT_RUN:
      "No full engineering constraint compilation was bound to this PCB-practice execution.",
    ENGINEERING_CHECKER_AUTHORITY_UNVERIFIED:
      "A claimed passing checker result does not resolve to current authoritative evidence, artifact bytes, approved tool capability, exact inputs, time, and board binding.",
    ENGINEERING_SCOPE_AUTHORITY_UNVERIFIED:
      "Rule applicability is not proven by independently authoritative current scope-fact evidence.",
    EVLEDA_PRACTICE_GEOMETRY_COVERAGE_INCOMPLETE:
      "The current EvlEDA analyzer does not cover every board geometry form and cannot establish a complete machine pass.",
    POLICY_RULE_PASSED:
      "The current EvlEDA practice execution found no violation of this bound policy rule.",
    POLICY_RULE_FAILED:
      "The current EvlEDA practice execution found a violation of this bound policy rule.",
    POLICY_RULE_COVERAGE_UNKNOWN:
      "The current EvlEDA practice execution could not completely evaluate this bound policy rule.",
    POLICY_RULE_NOT_RUN:
      "No current EvlEDA practice execution evaluated this bound policy rule."
  };
  return messages[code] ?? code;
};

export const normalizeEngineeringMachineStatus = (
  status: ValidationStatus
): EngineeringMachineStatus => {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "not_run":
      return "NOT_RUN";
    case "error":
    case "unsupported":
    case "stale":
    case "revoked":
    case "waived":
      return "UNKNOWN";
  }
};

const missingCheck = <EvidenceClass extends "kicad_native" | "evleda_check">(
  evidenceClass: EvidenceClass,
  reasonCode: string,
  message: string
): EngineeringCheckSummary & { readonly evidenceClass: EvidenceClass } => ({
  evidenceClass,
  machineStatus: "NOT_RUN",
  reasonCode,
  message,
  current: false,
  artifactId: null,
  evidenceId: null,
  reportIdentity: null,
  tool: null,
  evaluatedAt: null
});

const executionCheck = <EvidenceClass extends "kicad_native" | "evleda_check">(
  evidenceClass: EvidenceClass,
  execution: EngineeringInspectionExecution
): EngineeringCheckSummary & { readonly evidenceClass: EvidenceClass } => {
  const normalized = execution.machineStatus ??
    normalizeEngineeringMachineStatus(execution.validationStatus);
  if (normalized === "NOT_RUN") {
    return missingCheck(
      evidenceClass,
      evidenceClass === "kicad_native" ? "NATIVE_DRC_NOT_RUN" : "EVLEDA_PRACTICE_NOT_RUN",
      `${evidenceClass === "kicad_native" ? "Native DRC" : "EvlEDA PCB-practice analysis"} has no valid current execution result.`
    );
  }
  const machineStatus = execution.current ? normalized : "UNKNOWN";
  return {
    evidenceClass,
    machineStatus,
    reasonCode: execution.current
      ? `${evidenceClass === "kicad_native" ? "NATIVE_DRC" : "EVLEDA_PRACTICE"}_${machineStatus}`
      : `${evidenceClass === "kicad_native" ? "NATIVE_DRC" : "EVLEDA_PRACTICE"}_NON_CURRENT`,
    message: execution.current
      ? `${evidenceClass === "kicad_native" ? "Native DRC" : "EvlEDA PCB-practice analysis"} reported ${machineStatus}.`
      : "The execution does not bind the selected revision as a current exact input.",
    current: execution.current,
    artifactId: execution.artifactId,
    evidenceId: execution.evidenceId,
    reportIdentity: execution.reportIdentity,
    tool: execution.tool,
    evaluatedAt: execution.evaluatedAt
  };
};

const sourceProjection = (
  source: PcbEngineeringPracticeCatalog["sources"][number]
): EngineeringSourceProjection => ({
  sourceId: source.id,
  title: source.title,
  publisher: source.publisher,
  revision: source.revision,
  date: source.date,
  url: source.url,
  authority: source.authority,
  accessScope: source.accessScope,
  normativeStatus: source.normativeStatus,
  // The v1 catalog deliberately stores metadata, not captured source bytes.
  // Never turn a URL or publisher label into immutable numeric authority.
  captureIdentity: null,
  locator: null,
  excerptIdentity: null,
  captureComplete: false
});

const ROUTE_QUALITY_POLICY_SOURCE_ID = "evleda-route-quality-policy" as const;

const routeQualityPolicySourceProjection = (
  policy: Readonly<Record<string, unknown>>,
  captureIdentity: ContentIdentity
): EngineeringSourceProjection => {
  const publication = recordValue(policy.publication);
  return {
    sourceId: ROUTE_QUALITY_POLICY_SOURCE_ID,
    title: "EvlEDA PCB Route Quality Policy",
    publisher: stringValue(policy.publisher) ?? "EvlEDA",
    revision: stringValue(policy.schemaVersion) ?? "evleda.pcb-route-quality.v1",
    date: {
      kind: "published",
      value: stringValue(publication?.publishedAt) ?? "2026-09-05"
    },
    url: null,
    authority: "internal_policy",
    accessScope: "embedded_snapshot",
    normativeStatus: "internal_product_policy",
    captureIdentity,
    locator: { kind: "json_pointer", value: "/" },
    excerptIdentity: captureIdentity,
    captureComplete: true
  };
};

const findingSourceIds = (
  finding: PcbPracticeFinding,
  catalog: PcbEngineeringPracticeCatalog | null,
  routePolicyRuleIds: ReadonlySet<string>
): readonly string[] => uniqueSorted([
  ...(catalog?.rules
    .filter((rule) => finding.sourceRuleIds.includes(rule.id))
    .flatMap((rule) => rule.sourceIds) ?? []),
  ...(finding.sourceRuleIds.some((ruleId) => routePolicyRuleIds.has(ruleId))
    ? [ROUTE_QUALITY_POLICY_SOURCE_ID]
    : [])
]);

const machineGateFor = (
  evaluation: EngineeringConstraintEvaluation
): EngineeringGateResult | null => {
  const machine = evaluation.gateResults.filter((gate) => gate.owner === "machine");
  if (machine.length === 0) return null;
  const ranked = [...machine].sort((left, right) => {
    const rank = { fail: 0, unresolved: 1, pass: 2, not_applicable: 3 } as const;
    return rank[left.status] - rank[right.status] || compareText(left.code, right.code);
  });
  return ranked[0] ?? null;
};

const statusForMachineGate = (
  gate: EngineeringGateResult,
  evaluation: EngineeringConstraintEvaluation
): EngineeringMachineStatus | null => {
  if (gate.status === "not_applicable") return null;
  if (gate.status === "pass") return "PASS";
  if (gate.status === "fail") return "FAIL";
  if (
    gate.code === "ENGINEERING_CHECKER_RESULT_MISSING" &&
    evaluation.requiredInputs.every((input) => input.status === "bound")
  ) {
    return "NOT_RUN";
  }
  return "UNKNOWN";
};

const exactInputsFor = (
  evaluation: EngineeringConstraintEvaluation
): readonly (ContentIdentity | CanonicalIdentity)[] => {
  const values = [
    ...evaluation.matchedScopeFacts.map((fact) => fact.identity),
    ...evaluation.requiredInputs.flatMap((input) => input.identities)
  ];
  return [...values].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
};

const externalGateId = (gate: EngineeringGateResult, ruleId: string): string =>
  [gate.code, ruleId, gate.enforcementClass, gate.owner, ...gate.subjectIds].join(":");

const externalGateProjection = (
  gate: EngineeringGateResult,
  evaluation: EngineeringConstraintEvaluation,
  evidenceIds: readonly string[]
): EngineeringExternalGateProjection => ({
  gateId: externalGateId(gate, evaluation.ruleId),
  ruleId: evaluation.ruleId,
  owner: gate.owner as EngineeringExternalGateProjection["owner"],
  status: gate.status === "fail" ? "OPEN" : "UNKNOWN",
  reasonCode: gate.code,
  message: reasonMessage(gate.code),
  subjectIds: gate.subjectIds,
  sourceIds: evaluation.sourceIds,
  exactInputIdentities: exactInputsFor(evaluation),
  evidenceIds
});

const ruleTitle = (ruleId: string): string =>
  ruleId
    .split(/[._-]+/u)
    .filter((part) => part.length > 0 && part !== "pcb")
    .map((part) => part.charAt(0).toLocaleUpperCase("en-US") + part.slice(1))
    .join(" ");

const sourceCaptureIncomplete = (
  rule: PcbEngineeringPracticeRule,
  sources: readonly EngineeringSourceProjection[]
): boolean => {
  if (rule.numericClaims.length === 0) return false;
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  return rule.numericClaims.some((claim) =>
    claim.sourceIds.some((sourceId) => byId.get(sourceId)?.captureComplete !== true)
  );
};

interface RuleProjectionResult {
  readonly rules: readonly EngineeringRuleProjection[];
  readonly externalGates: readonly EngineeringExternalGateProjection[];
  readonly missingRuleIds: readonly string[];
  readonly unexpectedRuleIds: readonly string[];
}

const catalogRuleProjections = (
  catalog: PcbEngineeringPracticeCatalog,
  binding: EngineeringConstraintBinding | null,
  sources: readonly EngineeringSourceProjection[],
  evidenceIds: readonly string[],
  practiceCurrent: boolean,
  authoritativeScopeFactIdentities: readonly EngineeringEvidenceIdentity[],
  authoritativeCheckerResultIdentities: readonly EngineeringEvidenceIdentity[]
): RuleProjectionResult => {
  const evaluations = binding?.compiledConstraintSet.evaluations ?? [];
  const byRule = new Map(evaluations.map((evaluation) => [evaluation.ruleId, evaluation]));
  const catalogIds = new Set(catalog.rules.map((rule) => rule.id));
  const unexpectedRuleIds = uniqueSorted(
    evaluations.map((evaluation) => evaluation.ruleId).filter((ruleId) => !catalogIds.has(ruleId))
  );
  const missingRuleIds = uniqueSorted(
    catalog.rules.map((rule) => rule.id).filter((ruleId) => !byRule.has(ruleId))
  );
  const externalGates: EngineeringExternalGateProjection[] = [];
  const rules = [...catalog.rules]
    .sort((left, right) => compareText(left.id, right.id))
    .map((rule): EngineeringRuleProjection => {
      const blocking = rule.enforcementClasses.some(
        (value) => value === "hard_gate" || value === "calculation_gate"
      );
      const evaluation = byRule.get(rule.id);
      if (evaluation === undefined) {
        return {
          ruleId: rule.id,
          title: ruleTitle(rule.id),
          applicability: "UNKNOWN",
          machineStatus: binding === null ? "UNKNOWN" : "NOT_RUN",
          blocking,
          decisionClasses: rule.enforcementClasses,
          reasonCode:
            binding === null
              ? "ENGINEERING_CONSTRAINT_BINDING_NOT_RUN"
              : "ENGINEERING_CHECKER_RESULT_MISSING",
          sourceIds: rule.sourceIds,
          exactInputIdentities: [],
          checkerResultIdentities: [],
          findingIds: [],
          externalGateIds: []
        };
      }
      const machine = machineGateFor(evaluation);
      const scopeAuthorityVerified =
        evaluation.matchedScopeFacts.length > 0 &&
        evaluation.matchedScopeFacts.every((fact) =>
          authoritativeScopeFactIdentities.some((trusted) =>
            sameIdentity(fact.identity, trusted)
          )
        );
      const applicability = !practiceCurrent || !scopeAuthorityVerified
        ? "UNKNOWN" as const
        :
        evaluation.applicability === "applicable"
          ? "APPLICABLE" as const
          : evaluation.applicability === "not_applicable"
            ? "NOT_APPLICABLE" as const
            : "UNKNOWN" as const;
      let machineStatus = machine === null ? "UNKNOWN" as const : statusForMachineGate(machine, evaluation);
      let reasonCode: string = machine?.code ?? "ENGINEERING_CHECKER_RESULT_MISSING";
      if (!practiceCurrent) {
        machineStatus = "UNKNOWN";
        reasonCode = "EVLEDA_PRACTICE_NON_CURRENT";
      }
      if (!scopeAuthorityVerified) {
        machineStatus = "UNKNOWN";
        reasonCode = "ENGINEERING_SCOPE_AUTHORITY_UNVERIFIED";
      }
      if (machineStatus === "PASS" && sourceCaptureIncomplete(rule, sources)) {
        machineStatus = "UNKNOWN";
        reasonCode = "ENGINEERING_SOURCE_CAPTURE_INCOMPLETE";
      }
      if (
        machineStatus === "PASS" &&
        blocking &&
        (machine === null ||
          machine.checkerResultIdentities.length === 0 ||
          machine.checkerResultIdentities.some(
            (identity) =>
              !authoritativeCheckerResultIdentities.some((trusted) =>
                sameIdentity(identity, trusted)
              )
          ))
      ) {
        machineStatus = "UNKNOWN";
        reasonCode = "ENGINEERING_CHECKER_AUTHORITY_UNVERIFIED";
      }
      const projectedExternal = evaluation.gateResults
        .filter((gate) => gate.owner !== "machine")
        .map((gate): EngineeringGateResult =>
          !scopeAuthorityVerified &&
          (gate.status === "not_applicable" || gate.status === "pass")
            ? {
                ...gate,
                status: "unresolved",
                code: "ENGINEERING_SCOPE_UNRESOLVED",
                subjectIds: evaluation.unresolvedScopePredicates.length > 0
                  ? evaluation.unresolvedScopePredicates
                  : evaluation.falseScopePredicates
              }
            : gate
        )
        .filter((gate) => gate.status !== "pass" && gate.status !== "not_applicable")
        .map((gate) => externalGateProjection(gate, evaluation, evidenceIds));
      externalGates.push(...projectedExternal);
      return {
        ruleId: rule.id,
        title: ruleTitle(rule.id),
        applicability,
        machineStatus,
        blocking,
        decisionClasses: evaluation.enforcementClasses,
        reasonCode,
        sourceIds: evaluation.sourceIds,
        exactInputIdentities: exactInputsFor(evaluation),
        checkerResultIdentities: machine?.checkerResultIdentities ?? [],
        findingIds: [],
        externalGateIds: projectedExternal.map((gate) => gate.gateId)
      };
    });
  return { rules, externalGates, missingRuleIds, unexpectedRuleIds };
};

interface PolicyRule {
  readonly ruleId: string;
  readonly title: string;
  readonly decisionClasses: readonly string[];
}

const routePolicyRules = (
  ruleDeck: Readonly<Record<string, unknown>> | null
): readonly PolicyRule[] => {
  if (ruleDeck === null || !Array.isArray(ruleDeck.rules)) return [];
  const rules: PolicyRule[] = [];
  for (const value of ruleDeck.rules) {
    const record = recordValue(value);
    const ruleId = stringValue(record?.ruleId);
    const enforcement = stringValue(record?.enforcement);
    if (ruleId === null || enforcement === null) continue;
    rules.push({
      ruleId,
      title: ruleTitle(ruleId),
      decisionClasses: [enforcement]
    });
  }
  return [...new Map(rules.map((rule) => [rule.ruleId, rule])).values()].sort((left, right) =>
    compareText(left.ruleId, right.ruleId)
  );
};

const analyzerFindingGateIds = (finding: PcbPracticeFinding): readonly string[] =>
  finding.gates.map((gate) => `PCB_PRACTICE_FINDING:${finding.id}:${gate}`).sort(compareText);

const analyzerFindingExternalGates = (
  analysis: PcbPracticeAnalysis,
  evidenceIds: readonly string[],
  catalog: PcbEngineeringPracticeCatalog | null,
  routePolicyRuleIds: ReadonlySet<string>
): readonly EngineeringExternalGateProjection[] =>
  analysis.findings.flatMap((finding) =>
    finding.gates.map((gate): EngineeringExternalGateProjection => ({
      gateId: `PCB_PRACTICE_FINDING:${finding.id}:${gate}`,
      ruleId: finding.sourceRuleIds[0] ?? finding.code,
      owner: gate === "fabricator-confirmation" ? "fabricator" : "human",
      status: "OPEN",
      reasonCode:
        gate === "fabricator-confirmation"
          ? "PCB_PRACTICE_FABRICATOR_CONFIRMATION_REQUIRED"
          : "PCB_PRACTICE_HUMAN_REVIEW_REQUIRED",
      message: finding.message,
      subjectIds: [finding.id],
      sourceIds: findingSourceIds(finding, catalog, routePolicyRuleIds),
      exactInputIdentities: [],
      evidenceIds
    }))
  );

const remediationFor = (
  findingId: string,
  ruleIds: readonly string[],
  message: string
): EngineeringFindingProjection["remediation"] => ({
  authority: "advisory_only",
  requiresNewRevision: true,
  summary: `Create a new candidate revision that resolves ${findingId}; this guidance does not waive or rewrite the recorded result.`,
  steps: [
    `Review the exact observation and bound requirement: ${message}`,
    "Change only the candidate design or its source-bound engineering inputs in a new immutable revision.",
    "Preserve the original finding and evidence; an agent claim or waiver cannot turn it into a pass."
  ],
  verification: [
    "Rerun native KiCad DRC against the revised board bytes.",
    "Rerun the deterministic EvlEDA PCB-practice analyzer and every listed engineering rule."
  ],
  rerunRuleIds: ruleIds,
  rerunStages: ["pcb_placement_routing"]
});

const analyzerFindingProjection = (
  finding: PcbPracticeFinding,
  board: NonNullable<EngineeringPracticeInspectionBuildInput["nativeBoard"]>,
  catalog: PcbEngineeringPracticeCatalog | null,
  routePolicyRuleIds: ReadonlySet<string>
): EngineeringFindingProjection => ({
  findingId: finding.id,
  ruleIds: finding.sourceRuleIds.length > 0 ? finding.sourceRuleIds : [finding.code],
  machineStatus:
    finding.severity === "error" &&
    !(PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES as readonly string[]).includes(finding.code)
      ? "FAIL"
      : "UNKNOWN",
  severity: finding.severity,
  message: finding.message,
  observed: finding.observed,
  required: finding.required,
  assumptions: finding.assumptions,
  sourceIds: findingSourceIds(finding, catalog, routePolicyRuleIds),
  externalGateIds: analyzerFindingGateIds(finding),
  locations: finding.evidence.map((evidence) => ({
    artifactId: board.artifactId,
    artifactIdentity: board.identity,
    sourcePath: evidence.location.sourcePath,
    form: evidence.location.form,
    ordinal: evidence.location.ordinal,
    uuid: evidence.location.uuid,
    startOffset: evidence.location.startOffset,
    endOffset: evidence.location.endOffset,
    line: evidence.location.line,
    column: evidence.location.column,
    geometry: evidence.geometry
  })),
  remediation: remediationFor(
    finding.id,
    finding.sourceRuleIds.length > 0 ? finding.sourceRuleIds : [finding.code],
    finding.message
  )
});

const syntheticRuleFinding = (rule: EngineeringRuleProjection): EngineeringFindingProjection => ({
  findingId: `engineering-rule:${rule.ruleId}:${rule.machineStatus ?? "NOT_APPLICABLE"}`,
  ruleIds: [rule.ruleId],
  machineStatus: rule.machineStatus === "FAIL"
    ? "FAIL"
    : rule.machineStatus === "NOT_RUN"
      ? "NOT_RUN"
      : "UNKNOWN",
  severity: rule.machineStatus === "FAIL" ? "error" : "warning",
  message: reasonMessage(rule.reasonCode),
  observed: { machineStatus: rule.machineStatus, reasonCode: rule.reasonCode },
  required: { machineStatus: "PASS" },
  assumptions: [],
  sourceIds: rule.sourceIds,
  externalGateIds: rule.externalGateIds,
  locations: [],
  remediation: remediationFor(
    `engineering-rule:${rule.ruleId}`,
    [rule.ruleId],
    reasonMessage(rule.reasonCode)
  )
});

const missingInventoryRule = (
  ruleId: string,
  title: string,
  reasonCode: string
): EngineeringRuleProjection => ({
  ruleId,
  title,
  applicability: "UNKNOWN",
  machineStatus: "NOT_RUN",
  blocking: true,
  decisionClasses: ["inventory_gate"],
  reasonCode,
  sourceIds: [],
  exactInputIdentities: [],
  checkerResultIdentities: [],
  findingIds: [],
  externalGateIds: []
});

const updateRuleFindingIds = (
  rules: readonly EngineeringRuleProjection[],
  findings: readonly EngineeringFindingProjection[]
): readonly EngineeringRuleProjection[] =>
  rules.map((rule) => {
    const matching = findings.filter((finding) => finding.ruleIds.includes(rule.ruleId));
    const failure = matching.some((finding) => finding.machineStatus === "FAIL");
    const incomplete = matching.some(
      (finding) => finding.severity === "error" && finding.machineStatus === "UNKNOWN"
    );
    return {
      ...rule,
      ...(failure
        ? {
            applicability: "APPLICABLE" as const,
            machineStatus: "FAIL" as const,
            blocking: true,
            reasonCode: "POLICY_RULE_FAILED"
          }
        : incomplete
          ? {
              applicability: "APPLICABLE" as const,
              machineStatus: "UNKNOWN" as const,
              blocking: true,
              reasonCode: "POLICY_RULE_COVERAGE_UNKNOWN"
            }
          : {}),
      findingIds: matching.map((finding) => finding.findingId).sort(compareText),
      externalGateIds: uniqueSorted([
        ...rule.externalGateIds,
        ...matching.flatMap((finding) => finding.externalGateIds)
      ])
    };
  });

const routeRuleProjections = (
  ruleDeck: Readonly<Record<string, unknown>> | null,
  ruleDeckIdentity: CanonicalIdentity | null,
  practice: EngineeringPracticeInspectionBuildInput["evledaPractice"]
): readonly EngineeringRuleProjection[] => {
  const findings = practice?.analysis.findings ?? [];
  return routePolicyRules(ruleDeck).map((rule): EngineeringRuleProjection => {
    const matching = findings.filter((finding) => finding.sourceRuleIds.includes(rule.ruleId));
    const machineStatus: EngineeringMachineStatus =
      practice === null
        ? "NOT_RUN"
        : !practice.current
          ? "UNKNOWN"
          : matching.some(
                (finding) =>
                  finding.severity === "error" &&
                  !(PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES as readonly string[]).includes(
                    finding.code
                  )
              )
            ? "FAIL"
            : matching.some((finding) =>
                (PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES as readonly string[]).includes(
                  finding.code
                )
              )
              ? "UNKNOWN"
              : "PASS";
    return {
      ruleId: rule.ruleId,
      title: rule.title,
      applicability: "APPLICABLE",
      machineStatus,
      blocking: true,
      decisionClasses: rule.decisionClasses,
      reasonCode:
        machineStatus === "PASS"
          ? "POLICY_RULE_PASSED"
          : machineStatus === "FAIL"
            ? "POLICY_RULE_FAILED"
            : machineStatus === "NOT_RUN"
              ? "POLICY_RULE_NOT_RUN"
              : practice?.current === true
                ? "POLICY_RULE_COVERAGE_UNKNOWN"
                : "EVLEDA_PRACTICE_NON_CURRENT",
      sourceIds: [ROUTE_QUALITY_POLICY_SOURCE_ID],
      exactInputIdentities:
        ruleDeckIdentity === null || practice === null
          ? []
          : [ruleDeckIdentity, practice.reportIdentity],
      checkerResultIdentities:
        practice === null ? [] : [practice.reportIdentity],
      findingIds: matching.map((finding) => finding.id).sort(compareText),
      externalGateIds: uniqueSorted(matching.flatMap(analyzerFindingGateIds))
    };
  });
};

const analyzerRuleProjections = (
  knownRuleIds: ReadonlySet<string>,
  practice: EngineeringPracticeInspectionBuildInput["evledaPractice"],
  board: EngineeringPracticeInspectionBuildInput["nativeBoard"],
  catalog: PcbEngineeringPracticeCatalog | null,
  routePolicyRuleIds: ReadonlySet<string>
): readonly EngineeringRuleProjection[] => {
  if (practice === null) return [];
  const ruleIds = uniqueSorted(
    practice.analysis.findings.flatMap((finding) =>
      finding.sourceRuleIds.length > 0 ? finding.sourceRuleIds : [finding.code]
    )
  ).filter((ruleId) => !knownRuleIds.has(ruleId));
  return ruleIds.map((ruleId): EngineeringRuleProjection => {
    const matching = practice.analysis.findings.filter((finding) =>
      (finding.sourceRuleIds.length > 0 ? finding.sourceRuleIds : [finding.code]).includes(ruleId)
    );
    const hardFailure = matching.some(
      (finding) =>
        finding.severity === "error" &&
        !(PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES as readonly string[]).includes(finding.code)
    );
    const coverageUnknown = matching.some((finding) =>
      (PCB_PRACTICE_INCOMPLETE_COVERAGE_CODES as readonly string[]).includes(finding.code)
    );
    const blocking = matching.some((finding) => finding.severity === "error");
    const machineStatus: EngineeringMachineStatus = !practice.current
      ? "UNKNOWN"
      : hardFailure
        ? "FAIL"
        : "UNKNOWN";
    return {
      ruleId,
      title: ruleTitle(ruleId),
      applicability: practice.current ? "APPLICABLE" : "UNKNOWN",
      machineStatus,
      blocking,
      decisionClasses: [
        blocking ? "deterministic_analyzer_gate" : "deterministic_analyzer_advisory"
      ],
      reasonCode: !practice.current
        ? "EVLEDA_PRACTICE_NON_CURRENT"
        : hardFailure
          ? "POLICY_RULE_FAILED"
          : coverageUnknown
            ? "POLICY_RULE_COVERAGE_UNKNOWN"
            : "ENGINEERING_CHECK_UNRESOLVED",
      sourceIds: uniqueSorted(
        matching.flatMap((finding) =>
          findingSourceIds(finding, catalog, routePolicyRuleIds)
        )
      ),
      exactInputIdentities: [
        practice.reportIdentity,
        ...(board === null ? [] : [board.identity])
      ],
      checkerResultIdentities: [practice.reportIdentity],
      findingIds: matching.map((finding) => finding.id).sort(compareText),
      externalGateIds: uniqueSorted(matching.flatMap(analyzerFindingGateIds))
    };
  });
};

const completeBoardGeometryCoverageRule = (
  practice: EngineeringPracticeInspectionBuildInput["evledaPractice"],
  board: EngineeringPracticeInspectionBuildInput["nativeBoard"]
): EngineeringRuleProjection => {
  const complete =
    practice !== null &&
    practice.current &&
    (practice.analysis.summary as Readonly<Record<string, unknown>>)
      .completeBoardGeometryCoverage === true;
  return {
    ruleId: "evleda.pcb.complete-board-geometry-coverage",
    title: "Complete Board Geometry Coverage",
    applicability: practice === null || !practice.current ? "UNKNOWN" : "APPLICABLE",
    machineStatus: practice === null ? "NOT_RUN" : complete ? "PASS" : "UNKNOWN",
    blocking: true,
    decisionClasses: ["deterministic_analyzer_coverage_gate"],
    reasonCode: practice === null
      ? "POLICY_RULE_NOT_RUN"
      : complete
        ? "ENGINEERING_CHECK_PASSED"
        : "EVLEDA_PRACTICE_GEOMETRY_COVERAGE_INCOMPLETE",
    sourceIds: [],
    exactInputIdentities: practice === null
      ? []
      : [practice.reportIdentity, ...(board === null ? [] : [board.identity])],
    checkerResultIdentities: practice === null ? [] : [practice.reportIdentity],
    findingIds: [],
    externalGateIds: []
  };
};

interface FindingCursorBody {
  readonly schemaVersion: typeof ENGINEERING_FINDING_CURSOR_SCHEMA;
  readonly anchorIdentity: CanonicalIdentity;
  readonly findingInventoryIdentity: CanonicalIdentity;
  readonly offset: number;
}

const cursorRecord = (
  anchorIdentity: CanonicalIdentity,
  findingInventoryIdentity: CanonicalIdentity,
  offset: number
): FindingCursorBody => {
  return {
    schemaVersion: ENGINEERING_FINDING_CURSOR_SCHEMA,
    anchorIdentity,
    findingInventoryIdentity,
    offset
  };
};

/**
 * A cursor is an identity-bound, bounded offset document, not an authorization
 * token. Its contents are intentionally not presented as secret or signed.
 */
const encodeCursor = (record: FindingCursorBody): string =>
  Buffer.from(canonicalJson(record), "utf8").toString("base64url");

const parseCursor = (
  value: string,
  anchorIdentity: CanonicalIdentity,
  findingInventoryIdentity: CanonicalIdentity,
  total: number
): number => {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 2_048) throw new Error("shape");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("encoding");
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    const record = recordValue(parsed);
    if (
      record === null ||
      decoded.toString("utf8") !== canonicalJson(record) ||
      Object.keys(record).sort().join(",") !==
        "anchorIdentity,findingInventoryIdentity,offset,schemaVersion" ||
      record.schemaVersion !== ENGINEERING_FINDING_CURSOR_SCHEMA ||
      !Number.isSafeInteger(record.offset) ||
      (record.offset as number) <= 0 ||
      (record.offset as number) >= total ||
      canonicalJson(record.anchorIdentity) !== canonicalJson(anchorIdentity) ||
      canonicalJson(record.findingInventoryIdentity) !== canonicalJson(findingInventoryIdentity)
    ) {
      throw new Error("binding");
    }
    return record.offset as number;
  } catch {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Finding cursor is malformed, expired, or bound to a different engineering report",
      { parameter: "findingCursor" }
    );
  }
};

const referenceFabricationProfileFrozen = (
  binding: EngineeringConstraintBinding | null,
  verified: VerifiedReferenceFabricationProfile | null
): boolean => {
  if (binding === null || verified === null) return false;
  if (!CURRENT_FABRICATION_PROFILE_AUTHORITY_IS_GATING) return false;
  const exactBoundIdentity = (
    inputId: "fabricator_capability_snapshot_identity" | "fabricator_service_and_order_options" | "stackup_identity",
    expected: EngineeringEvidenceIdentity
  ): boolean => {
    const context = binding.contextSnapshot.inputBindings.filter(
      (entry) => entry.inputId === inputId
    );
    const compiled = binding.compiledConstraintSet.inputBindings.filter(
      (entry) => entry.inputId === inputId
    );
    return context.length === 1 &&
      compiled.length === 1 &&
      sameIdentity(context[0]!.identity, expected) &&
      sameIdentity(compiled[0]!.identity, expected);
  };
  return (
    verified.evidenceId.length > 0 &&
    verified.tool.adapter !== "human" &&
    verified.tool.name.length > 0 &&
    verified.tool.version.length > 0 &&
    Number.isFinite(Date.parse(verified.evaluatedAt)) &&
    verified.sourceLocator.kind.length > 0 &&
    verified.sourceLocator.value.length > 0 &&
    exactBoundIdentity(
      "fabricator_capability_snapshot_identity",
      verified.capabilitySnapshotIdentity
    ) &&
    exactBoundIdentity(
      "fabricator_service_and_order_options",
      verified.serviceAndOrderOptionsIdentity
    ) &&
    exactBoundIdentity("stackup_identity", verified.stackupIdentity)
  );
};

const dispositionReasons = (
  input: EngineeringPracticeInspectionBuildInput,
  nativeDrc: EngineeringPracticeInspectionResult["checks"]["nativeDrc"],
  practice: EngineeringPracticeInspectionResult["checks"]["evledaPractice"],
  inventoryComplete: boolean,
  rules: readonly EngineeringRuleProjection[],
  allBindingsPresent: boolean,
  fabricationProfileFrozen: boolean
): readonly string[] => {
  const reasons: string[] = [];
  if (input.revisionId === null) reasons.push("NO_SELECTED_REVISION");
  if (input.revisionId !== null && !input.isHeadRevision) reasons.push("HISTORICAL_NON_HEAD_REVISION");
  if (nativeDrc.machineStatus !== "PASS") reasons.push(nativeDrc.reasonCode);
  if (practice.machineStatus !== "PASS") reasons.push(practice.reasonCode);
  if (!inventoryComplete) reasons.push("ENGINEERING_RULE_INVENTORY_INCOMPLETE");
  if (rules.length === 0) reasons.push("ENGINEERING_RULE_INVENTORY_EMPTY");
  if (rules.some((rule) => rule.blocking && rule.applicability === "UNKNOWN")) {
    reasons.push("ENGINEERING_APPLICABILITY_UNKNOWN");
  }
  if (rules.some((rule) => rule.blocking && rule.machineStatus === "FAIL")) {
    reasons.push("MACHINE_RULE_FAILED");
  }
  if (rules.some((rule) => rule.blocking && rule.machineStatus === "UNKNOWN")) {
    reasons.push("MACHINE_RULE_UNKNOWN");
  }
  if (rules.some((rule) => rule.blocking && rule.machineStatus === "NOT_RUN")) {
    reasons.push("MACHINE_RULE_NOT_RUN");
  }
  if (!allBindingsPresent) reasons.push("FROZEN_ENGINEERING_BINDING_INCOMPLETE");
  if (!fabricationProfileFrozen) {
    const identityOnlyClaim = input.constraintBinding?.contextSnapshot.inputBindings.some(
      (entry) => entry.inputId === "fabricator_capability_snapshot_identity"
    ) === true;
    reasons.push(
      identityOnlyClaim
        ? "REFERENCE_FABRICATION_PROFILE_NOT_TRUSTED"
        : "REFERENCE_FABRICATION_PROFILE_NOT_FROZEN"
    );
  }
  return reasons.length === 0 ? ["COMPLETE_CURRENT_MACHINE_PASS"] : uniqueSorted(reasons);
};

export const buildEngineeringPracticeInspection = (
  input: EngineeringPracticeInspectionBuildInput
): EngineeringPracticeInspectionResult => {
  if (!Number.isSafeInteger(input.findingLimit) || input.findingLimit < 1 || input.findingLimit > 100) {
    throw new DomainError("INVALID_ARGUMENT", "findingLimit must be an integer from 1 through 100", {
      parameter: "findingLimit",
      minimum: 1,
      maximum: 100
    });
  }
  const nativeDrc = input.nativeDrc === null
    ? missingCheck("kicad_native", "NATIVE_DRC_NOT_RUN", "Native KiCad DRC has not run for this selected revision.")
    : executionCheck("kicad_native", input.nativeDrc);
  const practiceBase = input.evledaPractice === null
    ? missingCheck(
        "evleda_check",
        "EVLEDA_PRACTICE_NOT_RUN",
        "EvlEDA PCB-practice analysis has not run for this selected revision."
      )
    : executionCheck("evleda_check", input.evledaPractice);
  const analysis = input.evledaPractice?.analysis ?? null;
  const routePolicyRuleIds = new Set(
    routePolicyRules(input.routeQualityRuleDeck).map((rule) => rule.ruleId)
  );
  const advisories: readonly EngineeringAdvisoryProjection[] = (analysis?.findings ?? [])
    .filter((finding) => finding.severity === "advisory" || finding.severity === "warning")
    .map((finding) => ({
      advisoryId: `pcb-practice-advisory:${finding.id}`,
      ruleIds: finding.sourceRuleIds.length > 0 ? finding.sourceRuleIds : [finding.code],
      severity: finding.severity as "advisory" | "warning",
      message: finding.message,
      sourceIds: findingSourceIds(finding, input.practiceCatalog, routePolicyRuleIds),
      findingIds: [finding.id],
      externalGateIds: analyzerFindingGateIds(finding)
    }));
  const geometryCoverageComplete =
    analysis !== null &&
    (analysis.summary as Readonly<Record<string, unknown>>).completeBoardGeometryCoverage === true;
  const evledaPractice: EngineeringPracticeInspectionResult["checks"]["evledaPractice"] = {
    ...practiceBase,
    evidenceClass: "evleda_check",
    ...(analysis !== null && !geometryCoverageComplete
      ? {
          machineStatus: "UNKNOWN" as const,
          reasonCode: "EVLEDA_PRACTICE_GEOMETRY_COVERAGE_INCOMPLETE",
          message:
            "The current analyzer does not cover every board geometry form, so its result cannot establish a complete machine pass."
        }
      : {}),
    analysisOutcome: analysis?.outcome ?? null,
    reviewRequired:
      input.evledaPractice?.reviewRequired === true ||
      analysis?.outcome === "review" ||
      analysis?.summary.humanReviewRequired === true ||
      analysis?.summary.fabricatorConfirmationRequired === true ||
      advisories.length > 0 || !geometryCoverageComplete,
    advisoryCount: advisories.filter((entry) => entry.severity === "advisory").length
  };
  const sources: readonly EngineeringSourceProjection[] = [
    ...(input.practiceCatalog === null
    ? []
    : [...input.practiceCatalog.sources]
        .sort((left, right) => compareText(left.id, right.id))
        .map(sourceProjection)),
    ...(input.routeQualityPolicy === null || input.routeQualityPolicyCaptureIdentity === null
      ? []
      : [
          routeQualityPolicySourceProjection(
            input.routeQualityPolicy,
            input.routeQualityPolicyCaptureIdentity
          )
        ])
  ];
  const catalogProjection = input.practiceCatalog === null
    ? {
        rules: [
          missingInventoryRule(
            "evleda.practice-catalog.bound-rule-inventory",
            "Bound Engineering Practice Catalog Inventory",
            "ENGINEERING_PRACTICE_CATALOG_NOT_RUN"
          )
        ],
        externalGates: [],
        missingRuleIds: ["evleda.practice-catalog.bound-rule-inventory"],
        unexpectedRuleIds: []
      }
    : catalogRuleProjections(
        input.practiceCatalog,
        input.constraintBinding,
        sources,
        input.evledaPractice === null ? [] : [input.evledaPractice.evidenceId],
        input.evledaPractice?.current === true,
        input.authoritativeScopeFactIdentities,
        input.authoritativeCheckerResultIdentities
      );
  const policyRules = routeRuleProjections(
    input.routeQualityRuleDeck,
    input.routeQualityRuleDeckIdentity,
    input.evledaPractice
  );
  const analyzerExternal = analysis === null
    ? []
    : analyzerFindingExternalGates(
        analysis,
        input.evledaPractice === null ? [] : [input.evledaPractice.evidenceId],
        input.practiceCatalog,
        routePolicyRuleIds
      );
  const externalById = new Map(
    [...catalogProjection.externalGates, ...analyzerExternal].map((gate) => [gate.gateId, gate])
  );
  const outstandingExternalGates = [...externalById.values()].sort((left, right) =>
    compareText(left.gateId, right.gateId)
  );
  const analyzerFindings =
    analysis === null || input.nativeBoard === null
      ? []
      : analysis.findings.map((finding) =>
          analyzerFindingProjection(
            finding,
            input.nativeBoard!,
            input.practiceCatalog,
            routePolicyRuleIds
          )
        );
  const inventoryPolicyRules = policyRules.length === 0
    ? [
        missingInventoryRule(
          "evleda.route-quality.bound-rule-inventory",
          "Bound Route Quality Rule Inventory",
          "ENGINEERING_ROUTE_QUALITY_RULE_DECK_NOT_RUN"
        )
      ]
    : policyRules;
  const geometryCoverageRule = completeBoardGeometryCoverageRule(
    input.evledaPractice,
    input.nativeBoard
  );
  const knownRuleIds = new Set(
    [...catalogProjection.rules, ...inventoryPolicyRules, geometryCoverageRule]
      .map((rule) => rule.ruleId)
  );
  const analysisRules = analyzerRuleProjections(
    knownRuleIds,
    input.evledaPractice,
    input.nativeBoard,
    input.practiceCatalog,
    routePolicyRuleIds
  );
  const rawRules = [
    ...catalogProjection.rules,
    ...inventoryPolicyRules,
    geometryCoverageRule,
    ...analysisRules
  ].sort((left, right) =>
    compareText(left.ruleId, right.ruleId)
  );
  const allRuleIds = rawRules.map((rule) => rule.ruleId);
  if (new Set(allRuleIds).size !== allRuleIds.length) {
    throw new DomainError(
      "ARTIFACT_INTEGRITY_ERROR",
      "Bound engineering catalogs and analyzer rules contain duplicate rule authority",
      {
        duplicateRuleIds: uniqueSorted(
          allRuleIds.filter((id, index) => allRuleIds.indexOf(id) !== index)
        )
      }
    );
  }
  const syntheticFindings = rawRules
    .filter(
      (rule) =>
        rule.applicability !== "NOT_APPLICABLE" &&
        rule.machineStatus !== "PASS" &&
        !analyzerFindings.some((finding) => finding.ruleIds.includes(rule.ruleId))
    )
    .map(syntheticRuleFinding);
  const allFindings = [...analyzerFindings, ...syntheticFindings].sort((left, right) =>
    compareText(left.findingId, right.findingId)
  );
  const rules = updateRuleFindingIds(rawRules, allFindings);
  const missingRuleIds = uniqueSorted([
    ...catalogProjection.missingRuleIds,
    ...(input.routeQualityRuleDeck === null || policyRules.length === 0
      ? ["evleda.route-quality.bound-rule-inventory"]
      : []),
    ...(input.evledaPractice === null
      ? ["evleda.pcb.complete-board-geometry-coverage"]
      : [])
  ]);
  const unexpectedRuleIds = catalogProjection.unexpectedRuleIds;
  const inventoryComplete =
    input.revisionId !== null &&
    input.practiceCatalog !== null &&
    input.constraintBinding !== null &&
    input.routeQualityRuleDeck !== null &&
    policyRules.length > 0 &&
    missingRuleIds.length === 0 &&
    unexpectedRuleIds.length === 0;
  const statusCounts: Record<EngineeringMachineStatus, number> = {
    PASS: 0,
    FAIL: 0,
    UNKNOWN: 0,
    NOT_RUN: 0
  };
  for (const rule of rules) {
    if (rule.machineStatus !== null) statusCounts[rule.machineStatus] += 1;
  }
  const machineBlockerRuleIds = rules
    .filter(
      (rule) =>
        rule.blocking &&
        rule.applicability !== "NOT_APPLICABLE" &&
        rule.machineStatus !== "PASS"
    )
    .map((rule) => rule.ruleId)
    .sort(compareText);
  const bindings: EngineeringPracticeInspectionResult["bindings"] = {
    revisionManifest: input.revisionManifest,
    requirementsIdentity: input.requirementsIdentity,
    evidenceRootIdentity: input.evidenceRootIdentity,
    practiceCatalogIdentity: input.practiceCatalog?.identity ?? null,
    routeQualityPolicyIdentity: input.routeQualityPolicyIdentity,
    routeQualityPolicyCaptureIdentity: input.routeQualityPolicyCaptureIdentity,
    routeQualityRuleDeckIdentity: input.routeQualityRuleDeckIdentity,
    proofFixturePolicyIdentity: input.proofFixturePolicyIdentity,
    analyzerProfileIdentity: input.analyzerProfileIdentity,
    constraintBindingIdentity: input.constraintBinding?.identity ?? null,
    nativeBoardIdentity: input.nativeBoard?.identity ?? null
  };
  const allBindingsPresent = Object.values(bindings).every((binding) => binding !== null);
  const fabricationProfileFrozen = referenceFabricationProfileFrozen(
    input.constraintBinding,
    input.verifiedReferenceFabricationProfile
  );
  const reasons = dispositionReasons(
    input,
    nativeDrc,
    evledaPractice,
    inventoryComplete,
    rules,
    allBindingsPresent,
    fabricationProfileFrozen
  );
  const pocEligible = reasons.length === 1 && reasons[0] === "COMPLETE_CURRENT_MACHINE_PASS";
  const anchorIdentity = canonicalIdentity(
    {
      projectId: input.projectId,
      runId: input.runId,
      revisionId: input.revisionId,
      bindings,
      nativeDrc: {
        reportIdentity: nativeDrc.reportIdentity,
        evidenceId: nativeDrc.evidenceId
      },
      evledaPractice: {
        reportIdentity: evledaPractice.reportIdentity,
        evidenceId: evledaPractice.evidenceId
      }
    },
    "evleda.engineering-practice-page-anchor.v1"
  );
  const findingInventoryIdentity = canonicalIdentity(
    allFindings,
    "evleda.engineering-practice-finding-inventory.v1"
  );
  const offset = input.findingCursor === undefined
    ? 0
    : parseCursor(
        input.findingCursor,
        anchorIdentity,
        findingInventoryIdentity,
        allFindings.length
      );
  const items = allFindings.slice(offset, offset + input.findingLimit);
  const nextOffset = offset + items.length;
  const nextCursor = nextOffset < allFindings.length
    ? encodeCursor(cursorRecord(anchorIdentity, findingInventoryIdentity, nextOffset))
    : null;
  const payload = {
    schemaVersion: ENGINEERING_PRACTICE_INSPECTION_SCHEMA,
    projectId: input.projectId,
    runId: input.runId,
    revisionId: input.revisionId,
    isHeadRevision: input.isHeadRevision,
    proofFixture: {
      purpose: "full_stack_engineering_proof_fixture" as const,
      classification: "candidate_only" as const,
      reportEstablishesQualification: false as const,
      reportAuthorizesManufacturing: false as const,
      reportAuthorizesRelease: false as const
    },
    disposition: {
      status: pocEligible ? "PROVISIONAL_POC" as const : "BLOCKED_DIAGNOSTIC" as const,
      reasonCodes: reasons,
      machineBlockerRuleIds,
      openExternalGateIds: outstandingExternalGates.map((gate) => gate.gateId)
    },
    bindings,
    checks: { nativeDrc, evledaPractice },
    coverage: {
      inventoryComplete,
      expectedRuleCount: rules.length,
      evaluatedRuleCount: rules.length - missingRuleIds.filter((id) => rules.some((rule) => rule.ruleId === id)).length,
      applicableRuleCount: rules.filter((rule) => rule.applicability === "APPLICABLE").length,
      notApplicableRuleCount: rules.filter((rule) => rule.applicability === "NOT_APPLICABLE").length,
      statusCounts,
      missingRuleIds: missingRuleIds.filter((id) => rules.some((rule) => rule.ruleId === id)),
      unexpectedRuleIds
    },
    rules,
    advisories,
    outstandingExternalGates,
    gateSummary: {
      machineBlockers: machineBlockerRuleIds.length,
      fabricatorOpen: outstandingExternalGates.filter((gate) => gate.owner === "fabricator").length,
      humanOpen: outstandingExternalGates.filter((gate) => gate.owner === "human").length,
      physicalOpen: outstandingExternalGates.filter((gate) => gate.owner === "physical").length
    },
    findings: {
      total: allFindings.length,
      items,
      nextCursor
    },
    sources
  } satisfies Omit<EngineeringPracticeInspectionResult, "identity">;
  return {
    ...payload,
    identity: canonicalIdentity(payload, ENGINEERING_PRACTICE_INSPECTION_SCHEMA)
  };
};

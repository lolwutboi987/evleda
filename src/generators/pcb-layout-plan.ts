import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type {
  CanonicalIdentity,
  ContentIdentity,
  ValidationStatus
} from "../domain/types.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  type PcbEngineeringRequiredInput,
  type PcbEngineeringSourceId
} from "../knowledge/pcb-engineering-practices.js";
import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";

type ExactInputIdentity = ContentIdentity | CanonicalIdentity;

export const PCB_LAYOUT_PLAN_SCHEMA = "evleda.pcb-layout-plan.v2" as const;
export const PCB_ROUTE_QUALITY_POLICY_SCHEMA = "evleda.pcb-route-quality.v1" as const;
export const PCB_LAYOUT_QUALITY_POLICY_SCHEMA = PCB_ROUTE_QUALITY_POLICY_SCHEMA;
export const PCB_ROUTE_QUALITY_RULE_DECK_SCHEMA =
  "evleda.pcb-route-quality-rule-deck.v1" as const;
export const REV_A_PROOF_FIXTURE_POLICY_SCHEMA =
  "evleda.pcb-proof-fixture-policy.v1" as const;
export const PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA =
  "evleda.pcb-electrical-sizing-evidence.v1" as const;
export const PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME =
  "simulation/reports/pcb-electrical-sizing.json" as const;
export const PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING =
  "PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING" as const;

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
};

export const REV_A_NATIVE_DRC_RULES_IDENTITY: ContentIdentity = Object.freeze({
  algorithm: "sha256",
  digest: "694a9451cefe7811e33bb92d6f3bbe67c47330bbd3790cf0f7417b6addf188bd",
  size: 987
});

export const REV_A_NATIVE_BOARD_STATISTICS_IDENTITY: ContentIdentity = Object.freeze({
  algorithm: "sha256",
  digest: "79438b4a8b241e2662c6b48c90ac2ce0834a3c317e266d9b4005cec2157b5876",
  size: 4104
});

const REV_A_PROOF_FIXTURE_POLICY_PAYLOAD = deepFreeze({
  schemaVersion: REV_A_PROOF_FIXTURE_POLICY_SCHEMA,
  policyId: "evleda.fixture.robotics-controller-rev-a.mechanical.v1",
  applicability: {
    profileId: "robotics-controller-v0",
    boardRevision: "EVL-RC-G0-REV-A",
    purpose: "proof_fixture_diagnostics_only",
    transferableToOtherProfiles: false
  },
  review: {
    status: "reviewed_fixture_policy",
    reviewedAt: "2026-09-05",
    scope: "Reuse the observed outline only for the exact Rev-A proof fixture.",
    doesNotEstablish: [
      "user-approved product mechanics",
      "enclosure fit",
      "connector accessibility",
      "fabrication release"
    ]
  },
  mechanicalEnvelope: {
    widthMm: 60,
    heightMm: 45,
    basis: "observed_native_board_geometry"
  },
  observation: {
    logicalName:
      "reference-designs/robotics-controller-v0/validation/runs/20260905T041400.496613Z-8b7f124253b42c31/outputs/board-statistics.json",
    identity: REV_A_NATIVE_BOARD_STATISTICS_IDENTITY,
    observedSourceDigest: "77190c9c108cb550b31db5d21724f7bdf962b40484db024534bd3ce83b5d230b",
    tool: { name: "KiCad", version: "10.0.3", report: "board statistics" }
  }
});

export const REV_A_PROOF_FIXTURE_POLICY = deepFreeze({
  ...REV_A_PROOF_FIXTURE_POLICY_PAYLOAD,
  identity: canonicalIdentity(
    REV_A_PROOF_FIXTURE_POLICY_PAYLOAD,
    REV_A_PROOF_FIXTURE_POLICY_SCHEMA
  )
});

const ROUTE_QUALITY_EXCEPTION_BINDINGS = Object.freeze([
  "exception_id",
  "policy_and_rule_identity",
  "board_revision",
  "net_and_primitive_ids",
  "permitted_geometry",
  "reason_and_considered_alternatives",
  "clearance_return_and_coupling_evidence",
  "owner",
  "scope_or_expiry"
] as const);

const PCB_ROUTE_QUALITY_RULE_DECK_PAYLOAD = deepFreeze({
  schemaVersion: PCB_ROUTE_QUALITY_RULE_DECK_SCHEMA,
  ruleDeckId: "evleda.pcb-route-quality.default-rule-deck.v1",
  coordinateUnits: "millimetres",
  geometryPrecision: "bind_exact_native_primitives_and_parser_precision",
  rules: [
    {
      ruleId: "ROUTE_STYLE",
      enforcement: "hard_internal_product_quality_gate",
      straightJunctionMaximumUnsignedDirectionChangeDeg: 45,
      angularComparisonToleranceDeg: 0.01,
      lineArcAndArcArcTangentToleranceDeg: 0.01,
      acceptedGeometry: [
        "straight continuation",
        "straight-segment direction change no greater than the bound maximum",
        "tangent-continuous line/arc or arc/arc junction"
      ],
      violationDisposition: "block_candidate_stage"
    },
    {
      ruleId: "BACKTRACK",
      enforcement: "hard_internal_product_quality_gate",
      prohibitedWithoutAuthorizedException: [
        "gratuitous 180-degree U-turn or backtrack",
        "connected route reversal",
        "self-crossing detour",
        "avoidable added path length"
      ],
      requiredEvaluationInputs: [
        "route endpoints",
        "obstacles and keepouts",
        "net class",
        "primitive IDs",
        "shortest legal alternatives",
        "return, clearance, and coupling effects"
      ],
      violationDisposition: "block_candidate_stage"
    }
  ],
  exceptionAuthorization: {
    defaultDisposition: "no_exception",
    acceptedAuthorities: [
      "pre_authorized_source_bound_policy_rule",
      "separately_authenticated_human_approval_identity"
    ],
    authorityRequirements: {
      preAuthorizedPolicyRule: [
        "canonical exception-rule identity",
        "immutable source identity",
        "explicit ROUTE_STYLE or BACKTRACK applicability"
      ],
      authenticatedHumanApproval: [
        "canonical approval identity",
        "authenticated human actor and capability",
        "exact board, net, primitive, and permitted-deviation scope"
      ]
    },
    requiredBindings: ROUTE_QUALITY_EXCEPTION_BINDINGS,
    rejectedAuthorities: ["agent_annotation", "agent_claim", "open_exception_request"]
  }
});

export const PCB_ROUTE_QUALITY_RULE_DECK = deepFreeze({
  ...PCB_ROUTE_QUALITY_RULE_DECK_PAYLOAD,
  identity: canonicalIdentity(
    PCB_ROUTE_QUALITY_RULE_DECK_PAYLOAD,
    PCB_ROUTE_QUALITY_RULE_DECK_SCHEMA
  )
});

const PCB_LAYOUT_QUALITY_POLICY_PAYLOAD = deepFreeze({
  schemaVersion: PCB_LAYOUT_QUALITY_POLICY_SCHEMA,
  policyId: PCB_ROUTE_QUALITY_POLICY_SCHEMA,
  publisher: "EvlEDA",
  publication: {
    publishedAt: "2026-09-05",
    mediaType: "application/json",
    serialization: "evleda-c14n-json-v1 with one trailing newline",
    captureTool: "evleda-deterministic-generators"
  },
  classification: "reviewed_internal_product_quality_policy",
  practiceCatalogIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
  ruleDeckIdentity: PCB_ROUTE_QUALITY_RULE_DECK.identity,
  routeStyle: {
    ruleId: "ROUTE_STYLE",
    enforcement: "hard_internal_product_quality_gate",
    maximumUnsignedDirectionChangeDeg: 45,
    angularComparisonToleranceDeg: 0.01,
    lineArcAndArcArcTangentToleranceDeg: 0.01,
    attributionBoundary:
      "This numerical geometry threshold is EvlEDA product policy, not a universal signal-integrity, electrical-safety, or fabrication law."
  },
  backtrack: {
    ruleId: "BACKTRACK",
    enforcement: "hard_internal_product_quality_gate",
    attributionBoundary:
      "Only gratuitous backtracking is a product-quality failure; a 180-degree structure is not thereby declared universally electrically unsafe."
  },
  bendSi: {
    ruleId: "BEND_SI",
    defaultEnforcement: "profile_scoped_only",
    activation:
      "A hard electrical bend limit exists only when an exact net/interface profile and applicable source evidence require it."
  },
  exceptionAuthorization: {
    acceptedAuthorities: [
      "pre_authorized_source_bound_policy_rule",
      "separately_authenticated_human_approval_identity"
    ],
    authorityRequirements:
      PCB_ROUTE_QUALITY_RULE_DECK_PAYLOAD.exceptionAuthorization.authorityRequirements,
    requiredBindings: ROUTE_QUALITY_EXCEPTION_BINDINGS,
    rejectedAuthorities: ["agent_annotation", "agent_claim", "open_exception_request"],
    agentAuthority: "none"
  },
  returnPathPolicy: {
    ruleId: "pcb.return.continuous-reference-path",
    sourceIds: ["ti-motor-driver-layout-slva959b", "adi-an-1109"] as const
  },
  hotLoopPolicy: {
    ruleId: "pcb.power.hot-loop.compact-source-bound",
    sourceIds: ["ti-motor-driver-layout-slva959b", "ti-led-driver-layout-snva766"] as const
  },
  differentialPairPolicy: {
    ruleId: "pcb.signal.differential-pair.stackup-bound",
    sourceIds: ["jlcpcb-impedance-calculator-guide-2026", "wurth-basic-design-guide-2025"] as const
  },
  dfmPolicy: {
    ruleId: "pcb.dfm.exact-process-profile",
    sourceIds: [
      "ipc-2231-2019",
      "jlcpcb-manufacturing-capabilities-2026",
      "wurth-basic-design-guide-2025"
    ] as const
  }
});

export const PCB_LAYOUT_QUALITY_POLICY = deepFreeze({
  ...PCB_LAYOUT_QUALITY_POLICY_PAYLOAD,
  captureIdentity: contentIdentity(`${canonicalJson(PCB_LAYOUT_QUALITY_POLICY_PAYLOAD)}\n`),
  identity: canonicalIdentity(
    PCB_LAYOUT_QUALITY_POLICY_PAYLOAD,
    PCB_LAYOUT_QUALITY_POLICY_SCHEMA
  )
});

export const PCB_ROUTE_QUALITY_POLICY_CANONICAL_BYTES =
  `${canonicalJson(PCB_LAYOUT_QUALITY_POLICY_PAYLOAD)}\n`;

export const PCB_TRACE_SIZING_PRACTICE_RULE_IDS = Object.freeze([
  "pcb.trace.ampacity.ipc2152-input-gate",
  "pcb.trace.hot-resistance-voltage-drop-i2r",
  "pcb.copper.finished-geometry-fabricator-binding"
] as const);

export const PCB_LAYOUT_PRACTICE_RULE_IDS = Object.freeze([
  ...PCB_TRACE_SIZING_PRACTICE_RULE_IDS,
  "pcb.via.barrel-resistance-only",
  "pcb.component.thermal-model-and-hot-soak",
  "pcb.thermal-relief.package-and-process-specific",
  "pcb.stackup.exact-fabricator-capability-binding",
  "pcb.interconnect.drill-ring-aspect-and-microvia",
  "pcb.land-pattern.exact-orderable-package-source",
  "pcb.dfm.parameterized-fab-and-assembly-review"
] as const);

const sourceIdsForRules = (ruleIds: readonly string[]): readonly PcbEngineeringSourceId[] => {
  const selected = PCB_ENGINEERING_PRACTICE_CATALOG.rules.filter((rule) =>
    ruleIds.includes(rule.id)
  );
  if (selected.length !== ruleIds.length) {
    const found = new Set(selected.map((rule) => rule.id));
    throw new Error(
      `PCB layout policy references unknown practice rules: ${ruleIds
        .filter((ruleId) => !found.has(ruleId))
        .join(", ")}`
    );
  }
  return [...new Set(selected.flatMap((rule) => rule.sourceIds))].sort();
};

const requiredInputsForRules = (
  ruleIds: readonly string[]
): readonly PcbEngineeringRequiredInput[] =>
  [...new Set(
    PCB_ENGINEERING_PRACTICE_CATALOG.rules
      .filter((rule) => ruleIds.includes(rule.id))
      .flatMap((rule) => rule.requiredInputs)
  )].sort();

export const PCB_TRACE_SIZING_REQUIRED_INPUTS = Object.freeze(
  requiredInputsForRules(PCB_TRACE_SIZING_PRACTICE_RULE_IDS)
);

export const PCB_LAYOUT_SOURCE_IDS = Object.freeze(
  sourceIdsForRules(PCB_LAYOUT_PRACTICE_RULE_IDS)
);

export const PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS = Object.freeze([
  "BatteryInput",
  "MotorPower"
] as const);

type RequiredSizingNetClassId =
  (typeof PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS)[number];

interface ResolvedSizingInput {
  readonly id: PcbEngineeringRequiredInput;
  readonly value: string | number | boolean;
  readonly unit: string | null;
  readonly sourceIdentity: ExactInputIdentity;
}

interface PassingEngineeringCheck {
  readonly status: "pass";
  readonly methodId: string;
  readonly modelIdentity: ExactInputIdentity;
  readonly evaluatedValue: number;
  readonly limitValue: number;
  readonly unit: string;
}

export interface PcbElectricalSizingEvaluation {
  readonly netClassId: RequiredSizingNetClassId;
  readonly electricalMinimumTrackWidthMm: number;
  readonly sourceRuleIds: readonly string[];
  readonly resolvedInputs: readonly ResolvedSizingInput[];
  readonly ampacity: PassingEngineeringCheck;
  readonly voltageDrop: PassingEngineeringCheck;
  readonly thermal: PassingEngineeringCheck;
}

interface PcbElectricalSizingEvidencePayload {
  readonly schemaVersion: typeof PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA;
  readonly profileId: string;
  readonly boardRevision: string;
  readonly status: "pass";
  readonly practiceCatalogIdentity: CanonicalIdentity;
  readonly qualityPolicyIdentity: CanonicalIdentity;
  readonly mechanicalPolicyIdentity: CanonicalIdentity;
  readonly evaluations: readonly PcbElectricalSizingEvaluation[];
}

export type PcbElectricalSizingResolution =
  | {
      readonly status: "unresolved";
      readonly blockerCode: typeof PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING;
      readonly reason: "missing" | "ambiguous" | "invalid";
      readonly detail: string;
      readonly acceptedArtifactIdentity: null;
      readonly evaluations: readonly [];
    }
  | {
      readonly status: "resolved";
      readonly blockerCode: null;
      readonly reason: null;
      readonly detail: string;
      readonly acceptedArtifactIdentity: ContentIdentity;
      readonly evaluations: readonly PcbElectricalSizingEvaluation[];
    };

export interface PcbElectricalSizingSource {
  readonly artifacts: readonly {
    readonly logicalName: string;
    readonly content: Uint8Array;
    readonly identity: ContentIdentity;
    readonly exactInputs: readonly ExactInputIdentity[];
    readonly validationStatus: ValidationStatus;
  }[];
  readonly evidence: readonly {
    readonly evidenceClass: "agent_claim" | "evleda_check" | "kicad_native" | "human_physical";
    readonly validationStatus: ValidationStatus;
    readonly subjectDigests: readonly string[];
    readonly parsedArtifactLogicalName?: string;
    readonly exactInputs: readonly ExactInputIdentity[];
  }[];
}

type UnresolvedSizingReason = Extract<
  PcbElectricalSizingResolution,
  { readonly status: "unresolved" }
>["reason"];

const unresolvedSizing = (
  reason: UnresolvedSizingReason,
  detail: string
): PcbElectricalSizingResolution => ({
  status: "unresolved",
  blockerCode: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
  reason,
  detail,
  acceptedArtifactIdentity: null,
  evaluations: []
});

export const missingPcbElectricalSizingResolution = (): PcbElectricalSizingResolution =>
  unresolvedSizing(
    "missing",
    `No ${PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA} artifact is bound to the successful simulation stage.`
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isContentIdentity = (value: unknown): value is ContentIdentity =>
  isRecord(value) &&
  hasOnlyKeys(value, ["algorithm", "digest", "size"]) &&
  value.algorithm === "sha256" &&
  typeof value.digest === "string" &&
  /^[0-9a-f]{64}$/u.test(value.digest) &&
  typeof value.size === "number" &&
  Number.isSafeInteger(value.size) &&
  value.size >= 0;

const isCanonicalIdentity = (value: unknown): value is CanonicalIdentity =>
  isRecord(value) &&
  hasOnlyKeys(value, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) &&
  value.algorithm === "sha256" &&
  typeof value.digest === "string" &&
  /^[0-9a-f]{64}$/u.test(value.digest) &&
  typeof value.schemaVersion === "string" &&
  value.schemaVersion.length > 0 &&
  value.canonicalizationVersion === "evleda-c14n-json-v1";

const isExactIdentity = (value: unknown): value is ExactInputIdentity =>
  isContentIdentity(value) || isCanonicalIdentity(value);

const sameIdentity = (left: ExactInputIdentity, right: ExactInputIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const identitiesContain = (
  identities: readonly ExactInputIdentity[],
  expected: ExactInputIdentity
): boolean => identities.some((identity) => sameIdentity(identity, expected));

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const finitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const validResolvedInput = (value: unknown): value is ResolvedSizingInput => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "value", "unit", "sourceIdentity"]) ||
    typeof value.id !== "string" ||
    !(PCB_TRACE_SIZING_REQUIRED_INPUTS as readonly string[]).includes(value.id) ||
    !isExactIdentity(value.sourceIdentity)
  ) {
    return false;
  }
  const resolvedValue = value.value;
  const validValue =
    (typeof resolvedValue === "number" && Number.isFinite(resolvedValue)) ||
    (typeof resolvedValue === "string" && resolvedValue.trim().length > 0) ||
    typeof resolvedValue === "boolean";
  return (
    validValue &&
    (value.unit === null || (typeof value.unit === "string" && value.unit.trim().length > 0))
  );
};

const allowedMethods = {
  ampacity: new Set([
    "licensed-ipc-2152-revision-pinned-lookup",
    "qualified-current-temperature-model"
  ]),
  voltageDrop: new Set(["evleda-hot-copper-resistance-v1"]),
  thermal: new Set(["qualified-electrothermal-model", "licensed-ipc-2152-revision-pinned-lookup"])
} as const;

const validPassingCheck = (
  value: unknown,
  kind: keyof typeof allowedMethods
): value is PassingEngineeringCheck =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "status",
    "methodId",
    "modelIdentity",
    "evaluatedValue",
    "limitValue",
    "unit"
  ]) &&
  value.status === "pass" &&
  typeof value.methodId === "string" &&
  allowedMethods[kind].has(value.methodId as never) &&
  isExactIdentity(value.modelIdentity) &&
  finiteNonnegative(value.evaluatedValue) &&
  finitePositive(value.limitValue) &&
  value.evaluatedValue <= value.limitValue &&
  typeof value.unit === "string" &&
  value.unit.trim().length > 0;

const validEvaluation = (value: unknown): value is PcbElectricalSizingEvaluation => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "netClassId",
      "electricalMinimumTrackWidthMm",
      "sourceRuleIds",
      "resolvedInputs",
      "ampacity",
      "voltageDrop",
      "thermal"
    ]) ||
    typeof value.netClassId !== "string" ||
    !(PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS as readonly string[]).includes(
      value.netClassId
    ) ||
    !finitePositive(value.electricalMinimumTrackWidthMm) ||
    !Array.isArray(value.sourceRuleIds) ||
    canonicalJson([...value.sourceRuleIds].sort()) !==
      canonicalJson([...PCB_TRACE_SIZING_PRACTICE_RULE_IDS].sort()) ||
    !Array.isArray(value.resolvedInputs) ||
    value.resolvedInputs.length !== PCB_TRACE_SIZING_REQUIRED_INPUTS.length ||
    !value.resolvedInputs.every(validResolvedInput) ||
    !validPassingCheck(value.ampacity, "ampacity") ||
    !validPassingCheck(value.voltageDrop, "voltageDrop") ||
    !validPassingCheck(value.thermal, "thermal")
  ) {
    return false;
  }
  const inputIds = value.resolvedInputs.map((input) => input.id).sort();
  return canonicalJson(inputIds) === canonicalJson([...PCB_TRACE_SIZING_REQUIRED_INPUTS].sort());
};

const parseSizingPayload = (
  content: Uint8Array,
  profile: ReferenceControllerProfile
): PcbElectricalSizingEvidencePayload | null => {
  if (content.byteLength === 0 || content.byteLength > 131_072) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, [
      "schemaVersion",
      "profileId",
      "boardRevision",
      "status",
      "practiceCatalogIdentity",
      "qualityPolicyIdentity",
      "mechanicalPolicyIdentity",
      "evaluations"
    ]) ||
    parsed.schemaVersion !== PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA ||
    parsed.profileId !== profile.profileId ||
    parsed.boardRevision !== profile.boardRevision ||
    parsed.status !== "pass" ||
    !isCanonicalIdentity(parsed.practiceCatalogIdentity) ||
    !sameIdentity(parsed.practiceCatalogIdentity, PCB_ENGINEERING_PRACTICE_CATALOG.identity) ||
    !isCanonicalIdentity(parsed.qualityPolicyIdentity) ||
    !sameIdentity(parsed.qualityPolicyIdentity, PCB_LAYOUT_QUALITY_POLICY.identity) ||
    !isCanonicalIdentity(parsed.mechanicalPolicyIdentity) ||
    !sameIdentity(parsed.mechanicalPolicyIdentity, REV_A_PROOF_FIXTURE_POLICY.identity) ||
    !Array.isArray(parsed.evaluations) ||
    parsed.evaluations.length !== PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS.length ||
    !parsed.evaluations.every(validEvaluation)
  ) {
    return null;
  }
  const netClassIds = parsed.evaluations.map((entry) => entry.netClassId).sort();
  if (
    canonicalJson(netClassIds) !==
    canonicalJson([...PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS].sort())
  ) {
    return null;
  }
  return parsed as unknown as PcbElectricalSizingEvidencePayload;
};

export const resolvePcbElectricalSizingEvidence = (
  profile: ReferenceControllerProfile,
  source: PcbElectricalSizingSource | undefined
): PcbElectricalSizingResolution => {
  if (source === undefined) return missingPcbElectricalSizingResolution();
  const matching = source.artifacts.filter(
    (artifact) => artifact.logicalName === PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME
  );
  if (matching.length === 0) return missingPcbElectricalSizingResolution();
  if (matching.length !== 1) {
    return unresolvedSizing(
      "ambiguous",
      `Expected exactly one ${PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME} artifact, found ${matching.length.toString()}.`
    );
  }
  const artifact = matching[0]!;
  const recomputed = contentIdentity(artifact.content);
  const validArtifactBinding =
    artifact.validationStatus === "pass" &&
    sameIdentity(recomputed, artifact.identity) &&
    identitiesContain(artifact.exactInputs, PCB_ENGINEERING_PRACTICE_CATALOG.identity) &&
    identitiesContain(artifact.exactInputs, PCB_LAYOUT_QUALITY_POLICY.identity) &&
    identitiesContain(artifact.exactInputs, REV_A_PROOF_FIXTURE_POLICY.identity);
  const supportingEvidence = source.evidence.filter(
    (entry) =>
      entry.evidenceClass === "evleda_check" &&
      entry.validationStatus === "pass" &&
      entry.parsedArtifactLogicalName === artifact.logicalName &&
      entry.subjectDigests.includes(artifact.identity.digest) &&
      identitiesContain(entry.exactInputs, PCB_ENGINEERING_PRACTICE_CATALOG.identity) &&
      identitiesContain(entry.exactInputs, PCB_LAYOUT_QUALITY_POLICY.identity) &&
      identitiesContain(entry.exactInputs, REV_A_PROOF_FIXTURE_POLICY.identity)
  );
  const payload = parseSizingPayload(artifact.content, profile);
  if (!validArtifactBinding || supportingEvidence.length !== 1 || payload === null) {
    return unresolvedSizing(
      "invalid",
      "The supplied sizing artifact is stale, malformed, incompletely evaluated, or lacks one exact EvlEDA-check evidence binding."
    );
  }
  return {
    status: "resolved",
    blockerCode: null,
    reason: null,
    detail:
      "Both required high-current net classes have source-bound ampacity, voltage-drop, and thermal evaluations.",
    acceptedArtifactIdentity: artifact.identity,
    evaluations: payload.evaluations
  };
};

const fixtureMechanicalEnvelope = (profile: ReferenceControllerProfile) => {
  const applicable =
    profile.profileId === REV_A_PROOF_FIXTURE_POLICY.applicability.profileId &&
    profile.boardRevision === REV_A_PROOF_FIXTURE_POLICY.applicability.boardRevision;
  return applicable
    ? {
        status: "reviewed_proof_fixture_observation" as const,
        widthMm: REV_A_PROOF_FIXTURE_POLICY.mechanicalEnvelope.widthMm,
        heightMm: REV_A_PROOF_FIXTURE_POLICY.mechanicalEnvelope.heightMm,
        fixturePolicyId: REV_A_PROOF_FIXTURE_POLICY.policyId,
        fixturePolicyIdentity: REV_A_PROOF_FIXTURE_POLICY.identity,
        applicability: "exact_profile_and_board_revision_only" as const,
        productMechanicalApproval: false as const
      }
    : {
        status: "unresolved" as const,
        widthMm: null,
        heightMm: null,
        fixturePolicyId: null,
        fixturePolicyIdentity: null,
        applicability: "approved_mechanical_policy_required" as const,
        productMechanicalApproval: false as const
      };
};

const explicitHardBendSiConstraint = (profile: ReferenceControllerProfile) =>
  profile.layoutConstraints.find((constraint) => {
    const id = constraint.id.toLowerCase();
    const rule = constraint.rule.toLowerCase();
    const identifiesBendRule =
      id === "layout_bend_si_45" ||
      id === "layout_bend_si" ||
      id === "layout_minimum_interior_angle_135" ||
      (/(?:bend_si|signal_integrity_bend)/u.test(id) && /(?:45|135)/u.test(rule));
    const isMandatory = /\b(?:must|shall|required|only|maximum|minimum)\b/u.test(rule);
    return identifiesBendRule && isMandatory;
  });

const configuredNativeMinimum = (
  ruleName: "Battery-input copper" | "Motor and VM copper",
  minimumTrackWidthMm: 0.8 | 0.3
) => ({
  status: "observed_native_configuration" as const,
  ruleName,
  minimumTrackWidthMm,
  source: {
    logicalName: "reference-designs/robotics-controller-v0/robotics-controller-v0.kicad_dru",
    identity: REV_A_NATIVE_DRC_RULES_IDENTITY
  },
  interpretation: "native_drc_minimum_only" as const,
  electricalAdequacyEstablished: false as const
});

const evaluationFor = (
  resolution: PcbElectricalSizingResolution,
  netClassId: RequiredSizingNetClassId
): PcbElectricalSizingEvaluation | null =>
  resolution.status === "resolved"
    ? resolution.evaluations.find((evaluation) => evaluation.netClassId === netClassId) ?? null
    : null;

const netClassPlan = (
  resolution: PcbElectricalSizingResolution,
  options: {
    readonly id: RequiredSizingNetClassId;
    readonly nets: readonly string[];
    readonly ruleName: "Battery-input copper" | "Motor and VM copper";
    readonly configuredMinimumTrackWidthMm: 0.8 | 0.3;
  }
) => {
  const evaluation = evaluationFor(resolution, options.id);
  return {
    id: options.id,
    nets: options.nets,
    nativeConfiguredMinimum: configuredNativeMinimum(
      options.ruleName,
      options.configuredMinimumTrackWidthMm
    ),
    electricalMinimum:
      evaluation === null
        ? {
            status: "unresolved" as const,
            minimumTrackWidthMm: null,
            blockerCode: PCB_TRACE_WIDTH_ELECTRICAL_BASIS_MISSING,
            requiredPracticeRuleIds: PCB_TRACE_SIZING_PRACTICE_RULE_IDS
          }
        : {
            status: "resolved_by_bound_evidence" as const,
            minimumTrackWidthMm: evaluation.electricalMinimumTrackWidthMm,
            blockerCode: null,
            requiredPracticeRuleIds: evaluation.sourceRuleIds,
            evidenceArtifactIdentity: resolution.acceptedArtifactIdentity
          },
    effectiveDesignMinimumTrackWidthMm:
      evaluation === null ? null : evaluation.electricalMinimumTrackWidthMm,
    compositionRule:
      "A future rule compiler must use the governing maximum of electrical, impedance, reliability, and exact-fabricator constraints; a native configured minimum cannot satisfy that calculation."
  };
};

export const pcbLayoutPlanExactPolicyInputs = (
  resolution: PcbElectricalSizingResolution
): readonly ExactInputIdentity[] => [
  PCB_ENGINEERING_PRACTICE_CATALOG.identity,
  PCB_LAYOUT_QUALITY_POLICY.identity,
  PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
  PCB_ROUTE_QUALITY_RULE_DECK.identity,
  REV_A_PROOF_FIXTURE_POLICY.identity,
  REV_A_NATIVE_DRC_RULES_IDENTITY,
  REV_A_NATIVE_BOARD_STATISTICS_IDENTITY,
  ...(resolution.status === "resolved" ? [resolution.acceptedArtifactIdentity] : [])
];

export const buildPcbLayoutPlan = (
  profile: ReferenceControllerProfile,
  sizing: PcbElectricalSizingResolution = missingPcbElectricalSizingResolution()
) => {
  const hardBendSiConstraint = explicitHardBendSiConstraint(profile);
  const mechanicalEnvelope = fixtureMechanicalEnvelope(profile);
  return {
    schemaVersion: PCB_LAYOUT_PLAN_SCHEMA,
    planId: `pcb-layout-plan:${profile.profileId}:${profile.boardRevision}`,
    profileId: profile.profileId,
    boardRevision: profile.boardRevision,
    lifecycle: "candidate" as const,
    purpose: "diagnostic_proof_fixture_plan_not_product_or_manufacturing_release" as const,
    practiceBinding: {
      catalogSchemaVersion: PCB_ENGINEERING_PRACTICE_CATALOG.schemaVersion,
      catalogIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
      applicableCatalogRuleIds: PCB_LAYOUT_PRACTICE_RULE_IDS,
      sourceIds: PCB_LAYOUT_SOURCE_IDS,
      qualityPolicyId: PCB_LAYOUT_QUALITY_POLICY.policyId,
      qualityPolicyIdentity: PCB_LAYOUT_QUALITY_POLICY.identity,
      qualityPolicyCaptureIdentity: PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
      routeQualityRuleDeckId: PCB_ROUTE_QUALITY_RULE_DECK.ruleDeckId,
      routeQualityRuleDeckIdentity: PCB_ROUTE_QUALITY_RULE_DECK.identity
    },
    board: {
      mechanicalEnvelope,
      stackup: profile.stackup,
      finishedCopperGeometry: {
        status: "unresolved_fabricator_binding" as const,
        nominalCopperWeightUsedAsElectricalEvidence: false as const,
        requiredPracticeRuleId: "pcb.copper.finished-geometry-fabricator-binding"
      }
    },
    placementRegions: [
      {
        id: "input_power",
        edge: "left",
        contains: [
          "battery connector",
          "fuse",
          "reverse-polarity stage",
          "TVS",
          "bulk capacitance"
        ]
      },
      {
        id: "motor_a",
        edge: "upper/right",
        contains: ["DRV8874 A", "local ceramics", "IPROPI/VREF network", "motor A connector"]
      },
      {
        id: "motor_b",
        edge: "lower/right",
        contains: ["DRV8874 B", "local ceramics", "IPROPI/VREF network", "motor B connector"]
      },
      {
        id: "buck",
        edge: "left-center",
        contains: ["LMR51420", "input capacitors", "inductor", "output capacitors"]
      },
      {
        id: "logic",
        edge: "center",
        contains: ["TLV75533", "STM32G0B1", "SWD", "board-revision network"]
      },
      {
        id: "external_interfaces",
        edge: "connector edges",
        contains: ["USB", "CAN", "sensor", "encoder", "UART", "I2C", "SPI"]
      }
    ],
    electricalSizing: {
      status: sizing.status,
      blockerCode: sizing.blockerCode,
      detail: sizing.detail,
      acceptedArtifactSchema: PCB_ELECTRICAL_SIZING_EVIDENCE_SCHEMA,
      acceptedArtifactLogicalName: PCB_ELECTRICAL_SIZING_EVIDENCE_LOGICAL_NAME,
      acceptedArtifactIdentity: sizing.acceptedArtifactIdentity,
      requiredNetClassIds: PCB_ELECTRICAL_SIZING_REQUIRED_NET_CLASS_IDS,
      requiredPracticeRuleIds: PCB_TRACE_SIZING_PRACTICE_RULE_IDS,
      requiredInputs: PCB_TRACE_SIZING_REQUIRED_INPUTS,
      availableProfileContext: {
        inputVoltageMv: profile.inputVoltageMv,
        motorRmsCurrentMaPerChannel: profile.motor.rmsCurrentMaPerChannel,
        motorCurrentChopMaPerChannel: profile.motor.currentChopMaPerChannel,
        stackup: profile.stackup
      },
      evidenceBoundary:
        "Profile values and configured KiCad widths do not establish ampacity, hot voltage drop, I-squared-R loss, or temperature rise."
    },
    netClasses: [
      netClassPlan(sizing, {
        id: "BatteryInput",
        nets: ["VBAT_RAW", "VBAT_FUSED"],
        ruleName: "Battery-input copper",
        configuredMinimumTrackWidthMm: 0.8
      }),
      netClassPlan(sizing, {
        id: "MotorPower",
        nets: ["VM", "M1_OUT1", "M1_OUT2", "M2_OUT1", "M2_OUT2"],
        ruleName: "Motor and VM copper",
        configuredMinimumTrackWidthMm: 0.3
      })
    ],
    routeQualityPolicy: {
      policyId: PCB_LAYOUT_QUALITY_POLICY.policyId,
      policyIdentity: PCB_LAYOUT_QUALITY_POLICY.identity,
      policyCaptureIdentity: PCB_LAYOUT_QUALITY_POLICY.captureIdentity,
      ruleDeckId: PCB_ROUTE_QUALITY_RULE_DECK.ruleDeckId,
      ruleDeckIdentity: PCB_ROUTE_QUALITY_RULE_DECK.identity,
      classification:
        "hard_internal_product_quality_policy_not_universal_si_or_fabrication_law" as const,
      routeStyle: {
        ruleId: PCB_LAYOUT_QUALITY_POLICY.routeStyle.ruleId,
        enforcement: PCB_LAYOUT_QUALITY_POLICY.routeStyle.enforcement,
        maximumUnsignedDirectionChangeDeg:
          PCB_LAYOUT_QUALITY_POLICY.routeStyle.maximumUnsignedDirectionChangeDeg,
        angularComparisonToleranceDeg:
          PCB_LAYOUT_QUALITY_POLICY.routeStyle.angularComparisonToleranceDeg,
        lineArcAndArcArcTangentToleranceDeg:
          PCB_LAYOUT_QUALITY_POLICY.routeStyle.lineArcAndArcArcTangentToleranceDeg,
        acceptedGeometry: PCB_ROUTE_QUALITY_RULE_DECK.rules[0]!.acceptedGeometry,
        violationDisposition: "block_candidate_stage" as const
      },
      backtrack: {
        ruleId: PCB_LAYOUT_QUALITY_POLICY.backtrack.ruleId,
        enforcement: PCB_LAYOUT_QUALITY_POLICY.backtrack.enforcement,
        prohibitedWithoutAuthorizedException:
          PCB_ROUTE_QUALITY_RULE_DECK.rules[1]!.prohibitedWithoutAuthorizedException,
        requiredEvaluationInputs:
          PCB_ROUTE_QUALITY_RULE_DECK.rules[1]!.requiredEvaluationInputs,
        violationDisposition: "block_candidate_stage" as const,
        electricalSafetyClaim: false as const
      },
      exceptionAuthorization: PCB_LAYOUT_QUALITY_POLICY.exceptionAuthorization,
      proofFixtureExpectation: {
        profileId: REV_A_PROOF_FIXTURE_POLICY.applicability.profileId,
        boardRevision: REV_A_PROOF_FIXTURE_POLICY.applicability.boardRevision,
        expectedOutcome: "expected_negative" as const,
        expectedFailingRuleIds: ["ROUTE_STYLE", "BACKTRACK"],
        nativeDrcPassCanCoexist: true as const,
        disposition:
          "Retain Rev-A as a diagnostic negative fixture until a bound analyzer report proves compliant regenerated geometry."
      }
    },
    bendSiPolicy: {
      ruleId: PCB_LAYOUT_QUALITY_POLICY.bendSi.ruleId,
      enforcement:
        hardBendSiConstraint === undefined
          ? "not_applicable_without_profile_rule"
          : "hard_profile_scoped_electrical_gate",
      profileConstraintId: hardBendSiConstraint?.id ?? null,
      requiredBinding:
        "Exact net/interface profile, stackup, impedance target, source-bound bend limit, and applicable source evidence.",
      independenceBoundary:
        "BEND_SI is independent of ROUTE_STYLE and BACKTRACK; route quality does not establish electrical safety or SI adequacy."
    },
    viaPolicy: {
      policyRuleIds: [
        "pcb.via.barrel-resistance-only",
        "pcb.interconnect.drill-ring-aspect-and-microvia"
      ],
      sourceIds: [
        "ti-motor-driver-layout-slva959b",
        "ti-led-driver-layout-snva766",
        "adi-an-1109",
        "ipc-microvia-reliability-warning-2019"
      ],
      requiredChecks: [
        "exact pad, finished hole, plating, annular ring, aspect ratio, and permitted layer span",
        "current-entry geometry and unequal current sharing",
        "return-via placement for signal layer transitions",
        "thermal-via package and assembly treatment",
        "microvia stacking, filling, capping, coupon, and fabricator approval"
      ],
      currentCapacity: {
        status: "not_established" as const,
        universalCurrentPerViaAllowed: false as const,
        requiredPracticeRuleId: "pcb.via.barrel-resistance-only"
      },
      profileConstraintIds: profile.layoutConstraints
        .filter((constraint) => /via|powerpad/u.test(constraint.id))
        .map((constraint) => constraint.id)
    },
    returnPathPolicy: {
      policyRuleId: PCB_LAYOUT_QUALITY_POLICY.returnPathPolicy.ruleId,
      sourceIds: PCB_LAYOUT_QUALITY_POLICY.returnPathPolicy.sourceIds,
      requirements: [
        "Route signals over an identified continuous reference path.",
        "Do not cross a reference-plane void or split without a source-bound transition strategy.",
        "Place a return via beside a signal via when the reference layer changes and the resolved policy requires one.",
        "Keep motor, buck, USB, CAN, encoder, and sense return-current interactions reviewable."
      ],
      verification:
        "Analyze the exact routed copper plus filled zones; a declared plane name alone cannot pass return continuity.",
      profileConstraintIds: profile.layoutConstraints
        .filter((constraint) => /motor_loop|usb|sense|decoupling/u.test(constraint.id))
        .map((constraint) => constraint.id)
    },
    hotLoopPolicy: {
      policyRuleId: PCB_LAYOUT_QUALITY_POLICY.hotLoopPolicy.ruleId,
      sourceIds: PCB_LAYOUT_QUALITY_POLICY.hotLoopPolicy.sourceIds,
      definedLoops: [
        {
          id: "buck_input_hot_loop",
          endpointIntent: ["U2 VIN/GND", "C2", "C3"],
          switchNode: "SW_5V",
          quantitativeLimitStatus: "source_bound_limit_not_yet_resolved"
        },
        {
          id: "motor_a_bridge_loop",
          endpointIntent: ["U6 VM/GND", "C20", "C21", "M1_OUT1", "M1_OUT2"],
          switchNode: "M1_OUT1/M1_OUT2",
          quantitativeLimitStatus: "source_bound_limit_not_yet_resolved"
        },
        {
          id: "motor_b_bridge_loop",
          endpointIntent: ["U7 VM/GND", "C25", "C26", "M2_OUT1", "M2_OUT2"],
          switchNode: "M2_OUT1/M2_OUT2",
          quantitativeLimitStatus: "source_bound_limit_not_yet_resolved"
        }
      ],
      verification:
        "Verify exact pads and local capacitors, loop perimeter/area, switch-node copper, and return path; connectivity alone is insufficient.",
      profileConstraintIds: profile.layoutConstraints
        .filter((constraint) => /motor_loop|buck/u.test(constraint.id))
        .map((constraint) => constraint.id)
    },
    differentialPairPolicy: {
      policyRuleId: PCB_LAYOUT_QUALITY_POLICY.differentialPairPolicy.ruleId,
      sourceIds: PCB_LAYOUT_QUALITY_POLICY.differentialPairPolicy.sourceIds,
      pairs: [
        {
          id: "usb_connector_to_protection",
          positiveNet: "USB_DP_CONN",
          negativeNet: "USB_DM_CONN",
          boundary: "J3 to USBLC6-2SC6",
          targetImpedanceOhm: null,
          geometryStatus: "unresolved_exact_fabricated_stackup_and_solver"
        },
        {
          id: "usb_protection_to_mcu",
          positiveNet: "USB_DP",
          negativeNet: "USB_DM",
          boundary: "USBLC6-2SC6 to STM32G0B1",
          targetImpedanceOhm: null,
          geometryStatus: "unresolved_exact_fabricated_stackup_and_solver"
        },
        {
          id: "can_bus_pair",
          positiveNet: "CANH",
          negativeNet: "CANL",
          boundary: "TCAN3413 to connector/termination",
          targetImpedanceOhm: null,
          geometryStatus: "pair_geometry_and_stub_contract_unresolved"
        }
      ],
      requiredChecks: [
        "pair topology and protection-device boundary",
        "width, gap, skew, coupled length, uncoupled length, and symmetric transitions",
        "reference-path continuity",
        "fabricator-confirmed impedance geometry where controlled impedance is required"
      ],
      evidenceBoundary:
        "No width, gap, or impedance value is inferred from a protocol name or nominal stackup."
    },
    dfmPolicy: {
      catalogRuleId: "pcb.dfm.parameterized-fab-and-assembly-review",
      policyRuleId: PCB_LAYOUT_QUALITY_POLICY.dfmPolicy.ruleId,
      sourceIds: PCB_LAYOUT_QUALITY_POLICY.dfmPolicy.sourceIds,
      status: "fabricator_and_assembler_confirmation_required" as const,
      checks: [
        "copper width/spacing and copper-to-edge",
        "drill, slot, annular ring, hole-to-copper, aspect ratio, and via construction",
        "solder-mask web/expansion and paste/stencil treatment",
        "component clearance, polarity, fiducials, test access, panelization, and assembly access",
        "processed CAM output against the selected service and order options"
      ],
      autonomyBoundary:
        "The agent may report findings and propose changes; it may not silently resize features or authorize manufacturing."
    },
    routingOrder: [
      "Bind the exact mechanical policy, holes, keepouts, connector constraints, protection, and fabricated stackup.",
      "Resolve current, hot resistance, voltage drop, temperature rise, copper geometry, and via evidence before choosing electrical widths.",
      "Place and route each motor and buck high-di/dt loop with a reviewable continuous return.",
      "Complete plane and power-distribution intent before sensitive signals.",
      "Route explicitly declared differential-pair sections with symmetric transitions and uninterrupted return paths.",
      "Route sense and analog nets away from switch nodes and motor current returns.",
      "Enforce ROUTE_STYLE: use straight segments, no more than 45-degree direction changes, or tangent-continuous arcs under the bound internal policy.",
      "Enforce BACKTRACK: block gratuitous U-turns, reversals, self-crossing detours, and avoidable added length unless an authenticated exception input already applies.",
      "Run native DRC and separate EvlEDA geometry/practice/DFM checks, preserving unresolved hard inputs."
    ],
    profileConstraints: profile.layoutConstraints,
    requiredNativeEvidence: ["drc", "schematic_parity", "connectivity", "geometry"],
    requiredDerivedEvidence: [
      "routing bends/reversals",
      "trace/via rule binding",
      "return-path continuity",
      "hot-loop geometry",
      "differential-pair geometry",
      "DFM coverage"
    ],
    nativeSourcePolicy:
      "Only the configured KiCad backend may produce native board/render bytes or direct native pass evidence.",
    releaseAuthorized: false as const
  };
};

export const planValidationStatus = (_sizing: PcbElectricalSizingResolution): ValidationStatus =>
  "not_run";

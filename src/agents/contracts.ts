import { z } from "zod";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity, LiveRegenerationPolicy } from "../domain/types.js";
import { STAGE_ORDER, type StageKey } from "../domain/stages.js";
import type { PcbEngineeringPracticeCatalog } from "../knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_PROPOSAL_KINDS_BY_ROLE,
  DESIGN_AGENT_ROLES,
  DESIGN_AGENT_VALIDATOR_IDS_BY_ROLE,
  type DesignAgentRole
} from "./roles.js";

const deepFreeze = <Value>(value: Value, seen = new Set<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};

export const DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME =
  "docs/agent-pcb-design-instructions.md" as const;
export const DESIGN_AGENT_CATALOG_LOGICAL_NAME =
  "engineering/pcb-engineering-practices.json" as const;
export const DESIGN_AGENT_REFERENCE_INDEX_LOGICAL_NAME =
  "engineering/design-agent-reference-index.json" as const;
export const DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME =
  "schemas/design-agent-proposal-output-contract.v2.json" as const;

export const DESIGN_AGENT_MODEL_SCHEMA = "evleda.design-agent-model.v1" as const;
export const DESIGN_AGENT_PROVIDER_SCHEMA = "evleda.design-agent-provider.v1" as const;
export const DESIGN_AGENT_SETTINGS_SCHEMA = "evleda.design-agent-settings.v1" as const;
export const DESIGN_AGENT_REFERENCE_INDEX_SCHEMA =
  "evleda.design-agent-reference-index.v1" as const;
export const DESIGN_AGENT_PROMPT_PACK_SCHEMA = "evleda.design-agent-prompt-pack.v2" as const;
export const DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA =
  "evleda.design-agent-provider-request.v2" as const;
export const DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA =
  "evleda.design-agent-provider-response.v2" as const;
export const DESIGN_AGENT_PROPOSAL_SCHEMA = "evleda.design-agent-proposal.v2" as const;
export const DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA =
  "evleda.design-agent-structured-proposal.v1" as const;
export const DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA =
  "evleda.design-agent-untrusted-narrative.v1" as const;
export const DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA =
  "evleda.design-agent-proposal-output-contract.v2" as const;
export const DESIGN_AGENT_RESULT_SCHEMA = "evleda.design-agent-result.v2" as const;
export const DESIGN_AGENT_REPLAY_SCHEMA = "evleda.design-agent-replay.v2" as const;
export const DESIGN_AGENT_TRUST_MANIFEST_SCHEMA =
  "evleda.design-agent-trust-manifest.v1" as const;
export const DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA =
  "evleda.design-agent-replay-receipt.v1" as const;
export const DESIGN_AGENT_LIVE_POLICY_SCHEMA =
  "evleda.live-regeneration-policy.v1" as const;

export const DESIGN_AGENT_LIMITS = deepFreeze({
  instructionBytes: 256 * 1024,
  sourcePromptBytes: 200 * 1024,
  settingsBytes: 128 * 1024,
  contextDocumentBytes: 2 * 1024 * 1024,
  totalContextBytes: 8 * 1024 * 1024,
  contextDocuments: 64,
  providerOutputBytes: 256 * 1024,
  outputJsonDepth: 24,
  outputJsonEntries: 8_192,
  inputGraphDepth: 48,
  inputGraphNodes: 250_000,
  inputStringBytes: 16 * 1024 * 1024,
  documentGraphDepth: 32,
  documentGraphNodes: 100_000,
  replayGraphDepth: 64,
  replayGraphNodes: 500_000,
  replayStringBytes: 32 * 1024 * 1024,
  proposals: 128,
  assumptions: 128,
  questions: 64,
  validatorRequests: 64
} as const);

export const DESIGN_AGENT_LIVE_REGENERATION_POLICY: LiveRegenerationPolicy = deepFreeze({
  scope: "live_model_or_research",
  claim: "traceable",
  reproducible: false
});

export const DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY = deepFreeze(
  canonicalIdentity(
    DESIGN_AGENT_LIVE_REGENERATION_POLICY,
    DESIGN_AGENT_LIVE_POLICY_SCHEMA
  )
);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface BoundAgentTextDocument {
  readonly kind: "text";
  readonly logicalName: string;
  readonly content: string;
  readonly identity: ContentIdentity;
}

export interface BoundAgentStructuredDocument {
  readonly kind: "structured";
  readonly logicalName: string;
  readonly schemaVersion: string;
  readonly value: JsonValue;
  readonly identity: CanonicalIdentity;
}

export type BoundAgentContextDocument =
  | BoundAgentTextDocument
  | BoundAgentStructuredDocument;

export interface BoundDesignAgentModel {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly identity: CanonicalIdentity;
}

export interface BoundDesignAgentSettings {
  readonly value: JsonValue;
  readonly identity: CanonicalIdentity;
}

export interface BoundDesignAgentProvider {
  readonly providerId: string;
  readonly implementationVersion: string;
  readonly identity: CanonicalIdentity;
}

export interface BoundDesignAgentReferenceIndex {
  readonly schemaVersion: typeof DESIGN_AGENT_REFERENCE_INDEX_SCHEMA;
  readonly logicalName: typeof DESIGN_AGENT_REFERENCE_INDEX_LOGICAL_NAME;
  readonly requirementIds: readonly string[];
  readonly targetIds: readonly string[];
  readonly identity: CanonicalIdentity;
}

export interface DesignAgentTrustAnchors {
  readonly instruction: string;
  readonly practiceCatalog: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly outputContract: string;
}

/**
 * Deployment/configuration trust root. It must be provisioned independently of every run input
 * and model response; accepting this object from an invocation would defeat its purpose.
 */
export interface DesignAgentTrustManifest {
  readonly schemaVersion: typeof DESIGN_AGENT_TRUST_MANIFEST_SCHEMA;
  readonly manifestId: string;
  readonly instructions: readonly {
    readonly anchor: string;
    readonly logicalName: typeof DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME;
    readonly identity: ContentIdentity;
  }[];
  readonly practiceCatalogs: readonly {
    readonly anchor: string;
    readonly logicalName: typeof DESIGN_AGENT_CATALOG_LOGICAL_NAME;
    readonly identity: CanonicalIdentity;
  }[];
  readonly providers: readonly {
    readonly anchor: string;
    readonly providerId: string;
    readonly identity: CanonicalIdentity;
  }[];
  readonly modelFamilies: readonly {
    readonly anchor: string;
    readonly providerAnchor: string;
    readonly family: string;
    readonly modelIds: readonly string[];
  }[];
  readonly outputContracts: readonly {
    readonly anchor: string;
    readonly logicalName: typeof DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME;
    readonly bytesIdentity: ContentIdentity;
    readonly canonicalIdentity: CanonicalIdentity;
  }[];
  readonly identity: CanonicalIdentity;
}

export type DesignAgentDeploymentMode = "production" | "test_or_development";

/**
 * Trusted host-composition port; production implementations authenticate their configured records.
 * This port and its authority marker must never be constructible from an invocation payload.
 */
export interface AgentTrustStorePort {
  readonly authority: "authenticated_production" | "in_memory_test_or_development_only";
  resolve(manifestId: string): unknown;
}

export interface DesignAgentRunInput {
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
  readonly instructionDocument: BoundAgentTextDocument;
  /** Opaque references resolved only through the constructor-injected trust manifest. */
  readonly trustAnchors: DesignAgentTrustAnchors;
  readonly sourcePrompt: BoundAgentTextDocument;
  readonly practiceCatalogLogicalName: typeof DESIGN_AGENT_CATALOG_LOGICAL_NAME;
  readonly practiceCatalog: PcbEngineeringPracticeCatalog;
  readonly model: BoundDesignAgentModel;
  readonly settings: BoundDesignAgentSettings;
  readonly referenceIndex: BoundDesignAgentReferenceIndex;
  readonly context: readonly BoundAgentContextDocument[];
}

export const DESIGN_AGENT_PROPOSAL_KINDS = deepFreeze([
  "requirement",
  "architecture",
  "component",
  "schematic",
  "firmware_contract",
  "simulation",
  "placement",
  "routing",
  "manufacturing",
  "bringup",
  "research",
  "clarification"
] as const);

const shortIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$/u);
const boundedLine = z.string().trim().min(1).max(1_000);
const boundedParagraph = z.string().trim().min(1).max(8_000);

const designAgentProposalItemSchema = z.object({
  id: shortIdentifier,
  kind: z.enum(DESIGN_AGENT_PROPOSAL_KINDS),
  outcomeClaim: z.literal("none"),
  targetIds: z.array(shortIdentifier).max(32),
  sourceRequirementIds: z.array(shortIdentifier).max(64),
  practiceIds: z.array(shortIdentifier).max(64)
}).strict();

const designAgentProposalAssumptionSchema = z.object({
  id: shortIdentifier,
  severity: z.enum(["information", "warning", "blocking"]),
  sourceRequirementIds: z.array(shortIdentifier).max(64)
}).strict();

const designAgentProposalQuestionSchema = z.object({
  id: shortIdentifier,
  blocking: z.boolean(),
  sourceRequirementIds: z.array(shortIdentifier).max(64)
}).strict();

const designAgentValidatorRequestSchema = z.object({
  validatorId: shortIdentifier,
  targetIds: z.array(shortIdentifier).min(1).max(32)
}).strict();

const designAgentUntrustedNarrativeSchema = z.object({
  schemaVersion: z.literal(DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA),
  classification: z.literal("agent_claim"),
  disposition: z.literal("display_and_audit_only_never_authority"),
  summary: boundedParagraph,
  proposalDetails: z.array(z.object({
    proposalId: shortIdentifier,
    title: boundedLine,
    proposedChange: boundedParagraph,
    rationale: boundedParagraph,
    risks: z.array(boundedLine).max(32)
  }).strict()).max(DESIGN_AGENT_LIMITS.proposals),
  assumptionDetails: z.array(z.object({
    assumptionId: shortIdentifier,
    statement: boundedParagraph
  }).strict()).max(DESIGN_AGENT_LIMITS.assumptions),
  questionDetails: z.array(z.object({
    questionId: shortIdentifier,
    question: boundedParagraph
  }).strict()).max(DESIGN_AGENT_LIMITS.questions),
  validatorRequestDetails: z.array(z.object({
    validatorId: shortIdentifier,
    reason: boundedParagraph
  }).strict()).max(DESIGN_AGENT_LIMITS.validatorRequests),
  limitations: z.array(boundedLine).min(1).max(64)
}).strict();

const designAgentStructuredProposalSchema = z.object({
  schemaVersion: z.literal(DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA),
  stage: z.enum(STAGE_ORDER),
  role: z.enum(DESIGN_AGENT_ROLES),
  classification: z.literal("proposal_only"),
  authorityDisposition: z.literal("none"),
  proposals: z.array(designAgentProposalItemSchema).max(DESIGN_AGENT_LIMITS.proposals),
  assumptions: z.array(designAgentProposalAssumptionSchema).max(DESIGN_AGENT_LIMITS.assumptions),
  questions: z.array(designAgentProposalQuestionSchema).max(DESIGN_AGENT_LIMITS.questions),
  validatorRequests: z.array(designAgentValidatorRequestSchema)
    .min(1)
    .max(DESIGN_AGENT_LIMITS.validatorRequests)
}).strict();

const designAgentProposalSchema = z.object({
  schemaVersion: z.literal(DESIGN_AGENT_PROPOSAL_SCHEMA),
  structuredProposal: designAgentStructuredProposalSchema,
  untrustedNarrative: designAgentUntrustedNarrativeSchema
}).strict();

export type DesignAgentProposal = z.infer<typeof designAgentProposalSchema>;
export type DesignAgentStructuredProposal = DesignAgentProposal["structuredProposal"];
export type DesignAgentUntrustedNarrative = DesignAgentProposal["untrustedNarrative"];

export type DesignAgentProposalValidation =
  | { readonly success: true; readonly data: DesignAgentProposal }
  | {
      readonly success: false;
      readonly issues: readonly {
        readonly code: string;
        readonly path: readonly string[];
        readonly message: string;
      }[];
    };

/** The mutable Zod object stays module-private; callers receive only detached validation data. */
export const validateDesignAgentProposal = Object.freeze((value: unknown): DesignAgentProposalValidation => {
  const result = designAgentProposalSchema.safeParse(value);
  if (result.success) {
    return deepFreeze({ success: true as const, data: structuredClone(result.data) });
  }
  return deepFreeze({
    success: false,
    issues: result.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
      message: issue.message
    }))
  });
});

export const DESIGN_AGENT_FORBIDDEN_AUTHORITY_TERMS = deepFreeze([
  "pass", "passed", "passing", "validated", "validation complete", "verified",
  "approved", "approval", "qualified", "qualification", "released", "release",
  "authorized", "authorization", "certified", "certification", "safe", "compliant",
  "compliance", "manufacturable", "manufacture ready", "manufacturing ready",
  "fabrication ready", "production ready", "drc clean", "erc clean", "zero findings",
  "no violations", "native evidence", "human evidence", "physical evidence"
] as const);

export const DESIGN_AGENT_FORBIDDEN_AUTHORITY_ASSERTION_FAMILIES = deepFreeze([
  "pass_or_success",
  "drc_or_erc_clean_pass_or_zero_findings",
  "validation_or_verification",
  "approval_or_waiver",
  "qualification_or_certification",
  "authorization_or_release",
  "safe_or_compliant",
  "ready_for_fabrication_manufacturing_or_production",
  "shipment_or_production",
  "conformance_or_requirement_satisfaction",
  "native_or_physical_evidence_authority"
] as const);

export const DESIGN_AGENT_FORBIDDEN_AUTHORITY_ASSERTION_EXAMPLES = deepFreeze([
  "deterministic checks succeeded",
  "ready for fab",
  "ready for fabrication",
  "ready for manufacturing",
  "conforms to every requirement",
  "may ship",
  "DRC_PASSES",
  "approval granted",
  "waiver accepted",
  "validated for production"
] as const);

const runtimeJsonSchema = z.toJSONSchema(designAgentProposalSchema, {
  target: "draft-2020-12",
  io: "output"
});

export const DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT = deepFreeze({
  schemaVersion: DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA,
  runtimeSchema: runtimeJsonSchema,
  semanticPolicy: {
    stageRoleBinding: true,
    allowedProposalKindsByRole: DESIGN_AGENT_PROPOSAL_KINDS_BY_ROLE,
    allowedValidatorIdsByRole: DESIGN_AGENT_VALIDATOR_IDS_BY_ROLE,
    requirementPracticeAndTargetReferencesMustResolve: true,
    duplicateJsonObjectMembersRejected: true,
    obviousAuthorityLanguageRejectedAsDefenseInDepthOnly: true,
    semanticAbsenceOfAuthorityLanguageIsNotClaimed: true,
    allModelProseQuarantinedAsUntrustedNarrativeAgentClaim: true,
    untrustedNarrativeCannotAffectStructuredHandoffOrStatus: true,
    structuredHandoffUsesClosedReferencesAndEnumsOnly: true,
    forbiddenAuthorityTerms: DESIGN_AGENT_FORBIDDEN_AUTHORITY_TERMS,
    forbiddenAuthorityAssertionFamilies: DESIGN_AGENT_FORBIDDEN_AUTHORITY_ASSERTION_FAMILIES,
    forbiddenAuthorityAssertionExamples: DESIGN_AGENT_FORBIDDEN_AUTHORITY_ASSERTION_EXAMPLES,
    providerMaySetValidationEvidenceLifecycleOrRelease: false,
    deterministicValidatorHandoffRequired: true
  },
  limits: DESIGN_AGENT_LIMITS
} as const);

export const DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES = canonicalJson(
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT
);
export const DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY = deepFreeze(
  contentIdentity(DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES)
);
export const DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY = deepFreeze(
  canonicalIdentity(
    DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT,
    DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA
  )
);

export interface DesignAgentPromptPack {
  readonly schemaVersion: typeof DESIGN_AGENT_PROMPT_PACK_SCHEMA;
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
  readonly roleObjective: string;
  readonly instructionDocument: BoundAgentTextDocument;
  readonly trustManifestIdentity: CanonicalIdentity;
  readonly trustAnchors: DesignAgentTrustAnchors;
  readonly sourcePrompt: BoundAgentTextDocument;
  readonly practiceCatalogLogicalName: typeof DESIGN_AGENT_CATALOG_LOGICAL_NAME;
  readonly practiceCatalog: PcbEngineeringPracticeCatalog;
  readonly model: BoundDesignAgentModel;
  readonly settings: BoundDesignAgentSettings;
  readonly referenceIndex: BoundDesignAgentReferenceIndex;
  readonly context: readonly BoundAgentContextDocument[];
  readonly outputContract: {
    readonly logicalName: typeof DESIGN_AGENT_OUTPUT_CONTRACT_LOGICAL_NAME;
    readonly mediaType: "application/schema+json";
    readonly content: string;
    readonly identity: ContentIdentity;
    readonly canonicalIdentity: CanonicalIdentity;
  };
  readonly exactInputs: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly identity: CanonicalIdentity;
}

export interface DesignAgentProviderRequest {
  readonly schemaVersion: typeof DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA;
  readonly requestIdentity: CanonicalIdentity;
  readonly provider: BoundDesignAgentProvider;
  readonly promptPack: DesignAgentPromptPack;
}

export interface DesignAgentProviderResponse {
  readonly schemaVersion: typeof DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA;
  readonly requestIdentity: CanonicalIdentity;
  readonly promptPackIdentity: CanonicalIdentity;
  readonly providerIdentity: CanonicalIdentity;
  readonly modelIdentity: CanonicalIdentity;
  readonly settingsIdentity: CanonicalIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly outputContractBytesIdentity: ContentIdentity;
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
  readonly rawOutput: string;
}

export interface DesignAgentValidatorHandoff {
  readonly required: true;
  readonly state: "pending";
  readonly authority: "deterministic_validators_and_native_tools_only";
  readonly requestedValidators: DesignAgentStructuredProposal["validatorRequests"];
  readonly exactInputs: readonly CanonicalIdentity[];
}

export interface DesignAgentProposalResult {
  readonly schemaVersion: typeof DESIGN_AGENT_RESULT_SCHEMA;
  readonly stage: StageKey;
  readonly role: DesignAgentRole;
  readonly classification: "proposal_only";
  readonly evidenceClass: "agent_claim";
  readonly validationDisposition: "not_evaluated";
  readonly promptPackIdentity: CanonicalIdentity;
  readonly requestIdentity: CanonicalIdentity;
  readonly instructionIdentity: ContentIdentity;
  readonly trustManifestIdentity: CanonicalIdentity;
  readonly trustAnchors: DesignAgentTrustAnchors;
  readonly sourcePromptIdentity: ContentIdentity;
  readonly practiceCatalogIdentity: CanonicalIdentity;
  readonly providerIdentity: CanonicalIdentity;
  readonly modelIdentity: CanonicalIdentity;
  readonly settingsIdentity: CanonicalIdentity;
  readonly referenceIndexIdentity: CanonicalIdentity;
  readonly outputContractIdentity: CanonicalIdentity;
  readonly outputContractBytesIdentity: ContentIdentity;
  readonly contextInputIdentities: readonly (ContentIdentity | CanonicalIdentity)[];
  readonly rawOutputIdentity: ContentIdentity;
  /** Closed fields permitted to drive deterministic validator handoff. */
  readonly structuredProposal: DesignAgentStructuredProposal;
  readonly structuredProposalIdentity: CanonicalIdentity;
  /** Model prose retained only for display/audit; consumers must never derive status from it. */
  readonly untrustedNarrative: DesignAgentUntrustedNarrative;
  readonly untrustedNarrativeIdentity: CanonicalIdentity;
  readonly validatorHandoff: DesignAgentValidatorHandoff;
  readonly regenerationPolicy: LiveRegenerationPolicy;
  readonly regenerationPolicyIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}

export interface FrozenDesignAgentReplay {
  readonly schemaVersion: typeof DESIGN_AGENT_REPLAY_SCHEMA;
  readonly request: DesignAgentProviderRequest;
  readonly response: DesignAgentProviderResponse;
  readonly result: DesignAgentProposalResult;
  readonly identity: CanonicalIdentity;
}

export interface DesignAgentReplayReceipt {
  readonly schemaVersion: typeof DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA;
  readonly receiptId: string;
  readonly replayIdentity: CanonicalIdentity;
  readonly trustManifestIdentity: CanonicalIdentity;
  readonly providerIdentity: CanonicalIdentity;
  readonly promptPackIdentity: CanonicalIdentity;
  readonly identity: CanonicalIdentity;
}

/**
 * Constructor-injected append-only authority for replay admission. Production composition must
 * inject durable trusted storage; implementations must never replace a receipt ID with different
 * bytes and must resolve the exact originally appended record.
 */
export interface DesignAgentReplayReceiptStore {
  readonly authority:
    | "durable_append_only_production"
    | "in_memory_test_or_development_only";
  append(receipt: DesignAgentReplayReceipt): Promise<void>;
  resolve(receiptId: string): Promise<unknown>;
}

export interface DesignAgentProductionCoordinatorPrerequisites {
  readonly deploymentMode: "production";
  readonly trustManifestId: string;
  readonly trustStore: AgentTrustStorePort & {
    readonly authority: "authenticated_production";
  };
  readonly replayReceiptStore: DesignAgentReplayReceiptStore & {
    readonly authority: "durable_append_only_production";
  };
}

export interface DesignAgentTestCoordinatorPrerequisites {
  readonly deploymentMode: "test_or_development";
  readonly trustManifestId: string;
  readonly trustStore: AgentTrustStorePort;
  readonly replayReceiptStore: DesignAgentReplayReceiptStore;
}

export type DesignAgentCoordinatorPrerequisites =
  | DesignAgentProductionCoordinatorPrerequisites
  | DesignAgentTestCoordinatorPrerequisites;

export interface DesignAgentLiveExecution {
  readonly mode: "live_traceable";
  readonly result: DesignAgentProposalResult;
  readonly replay: FrozenDesignAgentReplay;
  readonly replayReceipt: DesignAgentReplayReceipt;
}

export interface DesignAgentReplayExecution {
  readonly mode: "frozen_exact_replay";
  readonly result: DesignAgentProposalResult;
  readonly replayIdentity: CanonicalIdentity;
  readonly receiptId: string;
  readonly receiptIdentity: CanonicalIdentity;
}

export interface DesignAgentReplayExpectation {
  /** Opaque receipt ID resolved through the constructor-injected append-only store. */
  readonly receiptId: string;
  readonly input: DesignAgentRunInput;
}

/** Provider-neutral boundary; compile-time conformance grants no authority. */
export interface DesignAgentPort {
  readonly provider: BoundDesignAgentProvider;
  generate(request: DesignAgentProviderRequest, signal?: AbortSignal): Promise<unknown>;
}

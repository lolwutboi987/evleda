import { describe, expect, it, vi } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  DESIGN_AGENT_LIVE_REGENERATION_POLICY,
  DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY,
  DESIGN_AGENT_MODEL_SCHEMA,
  DESIGN_AGENT_PROMPT_PACK_SCHEMA,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
  DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA,
  DESIGN_AGENT_PROVIDER_SCHEMA,
  DESIGN_AGENT_REFERENCE_INDEX_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_SETTINGS_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
  DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA,
  type DesignAgentReplayReceipt,
  type DesignAgentRunInput,
  type DesignAgentTrustAnchors,
  type FrozenDesignAgentReplay
} from "../../src/agents/contracts.js";
import { DesignAgentCoordinatorError } from "../../src/agents/coordinator.js";
import {
  DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS,
  DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
  DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
  createDesignAgentDeterministicValidatorRegistry,
  createDefaultDesignAgentDeterministicValidatorRegistry
} from "../../src/agents/deterministic-validator-registry.js";
import { DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA } from "../../src/agents/production-model-policy.js";
import {
  DesignAgentWorkflowOrchestrator,
  type DesignAgentReplayArchivePort,
  type DesignAgentWorkflowCoordinatorPort,
  type DesignAgentWorkflowProposalRequest,
  type DesignAgentWorkflowValidatorRegistryPort
} from "../../src/agents/workflow-orchestrator.js";
import {
  createDesignAgentRunBinding,
  createDesignAgentStageSubject,
  type DesignAgentAttemptCheckpoint,
  type DesignAgentProposalRequiredRunBinding,
  type DesignAgentStageSubject
} from "../../src/agents/workflow-contracts.js";
import { PCB_ENGINEERING_PRACTICE_SCHEMA } from "../../src/knowledge/pcb-engineering-practices.js";

const deeplyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== "object" || value === null || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => !("value" in descriptor) || deeplyFrozen(descriptor.value, seen)
  );
};

const TRUST_MANIFEST_IDENTITY = canonicalIdentity(
  { manifest: "workflow-fixture" },
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA
);
const INSTRUCTION_IDENTITY = contentIdentity("fixture design-agent instructions");
const PRACTICE_CATALOG_IDENTITY = canonicalIdentity(
  { catalog: "workflow-fixture" },
  PCB_ENGINEERING_PRACTICE_SCHEMA
);
const PROVIDER_IDENTITY = canonicalIdentity(
  { providerId: "fixture-provider", implementationVersion: "1.0.0" },
  DESIGN_AGENT_PROVIDER_SCHEMA
);
const PROVIDER_EXECUTABLE_IDENTITY = contentIdentity("fixture-provider-executable");
const MODEL_IDENTITY = canonicalIdentity(
  { provider: "fixture-provider", model: "fixture-model", version: "2026-09-05" },
  DESIGN_AGENT_MODEL_SCHEMA
);
const SETTINGS_IDENTITY = canonicalIdentity({ temperature: 0 }, DESIGN_AGENT_SETTINGS_SCHEMA);
const MODEL_POLICY_IDENTITY = canonicalIdentity(
  { providers: [{ provider: PROVIDER_IDENTITY, models: [MODEL_IDENTITY] }] },
  DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA
);
const REFERENCE_INDEX_IDENTITY = canonicalIdentity(
  { requirementIds: ["req_power"], targetIds: ["power_tree"] },
  DESIGN_AGENT_REFERENCE_INDEX_SCHEMA
);
const SOURCE_PROMPT_IDENTITY = contentIdentity("Design a bounded controller candidate.");
const TRUST_ANCHORS = Object.freeze({
  instruction: "instruction-main",
  practiceCatalog: "catalog-main",
  provider: "provider-main",
  modelFamily: "model-main",
  outputContract: "output-main"
});
const VALIDATOR_REGISTRY = createDefaultDesignAgentDeterministicValidatorRegistry();
const VALIDATOR_REGISTRY_IDENTITY = VALIDATOR_REGISTRY.snapshot().identity;

const makeRunBinding = (
  overrides: Partial<Omit<
    DesignAgentProposalRequiredRunBinding,
    "identity" | "mode" | "schemaVersion" | "scope"
  >> = {}
): DesignAgentProposalRequiredRunBinding => {
  const binding = createDesignAgentRunBinding({
    mode: "proposal_required",
    scope: "candidate_stages_v1",
    trustManifestId: "workflow-fixture-manifest",
    trustManifestIdentity: TRUST_MANIFEST_IDENTITY,
    trustAnchors: TRUST_ANCHORS,
    instructionIdentity: INSTRUCTION_IDENTITY,
    practiceCatalogIdentity: PRACTICE_CATALOG_IDENTITY,
    providerIdentity: PROVIDER_IDENTITY,
    providerExecutableIdentity: PROVIDER_EXECUTABLE_IDENTITY,
    modelIdentity: MODEL_IDENTITY,
    modelPolicyIdentity: MODEL_POLICY_IDENTITY,
    validatorRegistryIdentity: VALIDATOR_REGISTRY_IDENTITY,
    settingsIdentity: SETTINGS_IDENTITY,
    outputContractIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
    outputContractBytesIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
    regenerationPolicyIdentity: DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY,
    ...overrides
  });
  if (binding.mode !== "proposal_required") throw new Error("fixture binding mode drifted");
  return binding;
};

const makeSubject = (
  inputManifest = canonicalIdentity(
    { stage: "system_architecture", revision: 1 },
    "evleda.stage-input.system_architecture.v1"
  )
): DesignAgentStageSubject =>
  createDesignAgentStageSubject({
    projectId: "project_fixture",
    runId: "run_fixture",
    designRevisionId: "revision_fixture",
    stage: "system_architecture",
    inputManifest,
    provisionIdentity: canonicalIdentity(
      { provision: "fixture" },
      "evleda.stage-provision.v1"
    ),
    provisionManifestBlob: contentIdentity("fixture provision manifest"),
    requirementsIdentity: canonicalIdentity(
      { requirements: "fixture" },
      "evleda.requirements.v1"
    ),
    runConfigurationIdentity: canonicalIdentity(
      { configuration: "fixture" },
      "evleda.run-configuration.v1"
    ),
    workflowVersion: "workflow-fixture-v1"
  });

const makeInput = (): DesignAgentRunInput => ({
  stage: "system_architecture",
  role: "system_architect",
  instructionDocument: {
    kind: "text",
    logicalName: "docs/agent-pcb-design-instructions.md",
    content: "fixture design-agent instructions",
    identity: INSTRUCTION_IDENTITY
  },
  trustAnchors: TRUST_ANCHORS,
  sourcePrompt: {
    kind: "text",
    logicalName: "requirements/source-prompt.txt",
    content: "Design a bounded controller candidate.",
    identity: SOURCE_PROMPT_IDENTITY
  },
  practiceCatalogLogicalName: "engineering/pcb-engineering-practices.json",
  practiceCatalog: {
    schemaVersion: PCB_ENGINEERING_PRACTICE_SCHEMA,
    identity: PRACTICE_CATALOG_IDENTITY
  },
  model: {
    provider: "fixture-provider",
    model: "fixture-model",
    version: "2026-09-05",
    identity: MODEL_IDENTITY
  },
  settings: { value: { temperature: 0 }, identity: SETTINGS_IDENTITY },
  referenceIndex: {
    schemaVersion: "evleda.design-agent-reference-index.v1",
    logicalName: "engineering/design-agent-reference-index.json",
    requirementIds: ["req_power"],
    targetIds: ["power_tree"],
    identity: REFERENCE_INDEX_IDENTITY
  },
  context: []
} as unknown as DesignAgentRunInput);

const withIdentity = <Value extends Record<string, unknown>>(
  payload: Value,
  schemaVersion: string
): Value & { readonly identity: ReturnType<typeof canonicalIdentity> } => ({
  ...payload,
  identity: canonicalIdentity(payload, schemaVersion)
});

const makeLiveExecution = (
  generation: number,
  resultTrustAnchors: DesignAgentTrustAnchors = TRUST_ANCHORS,
  requestedValidatorIds: readonly string[] = [DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID]
) => {
  const instructionDocument = {
    kind: "text" as const,
    logicalName: "docs/agent-pcb-design-instructions.md",
    content: "fixture design-agent instructions",
    identity: INSTRUCTION_IDENTITY
  };
  const sourcePrompt = {
    kind: "text" as const,
    logicalName: "requirements/source-prompt.txt",
    content: "Design a bounded controller candidate.",
    identity: SOURCE_PROMPT_IDENTITY
  };
  const model = {
    provider: "fixture-provider",
    model: "fixture-model",
    version: "2026-09-05",
    identity: MODEL_IDENTITY
  };
  const settings = { value: { temperature: 0 }, identity: SETTINGS_IDENTITY };
  const referenceIndex = {
    schemaVersion: "evleda.design-agent-reference-index.v1",
    logicalName: "engineering/design-agent-reference-index.json",
    requirementIds: ["req_power"],
    targetIds: ["power_tree"],
    identity: REFERENCE_INDEX_IDENTITY
  };
  const provider = {
    providerId: "fixture-provider",
    implementationVersion: "1.0.0",
    identity: PROVIDER_IDENTITY
  };
  const outputContract = {
    logicalName: "schemas/design-agent-proposal-output-contract.v2.json",
    mediaType: "application/schema+json" as const,
    content: "{}",
    identity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
    canonicalIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
  };
  const promptPackPayload = {
    schemaVersion: DESIGN_AGENT_PROMPT_PACK_SCHEMA,
    stage: "system_architecture" as const,
    role: "system_architect" as const,
    roleObjective: "Propose a candidate architecture without granting authority.",
    instructionDocument,
    trustManifestIdentity: TRUST_MANIFEST_IDENTITY,
    trustAnchors: TRUST_ANCHORS,
    sourcePrompt,
    practiceCatalogLogicalName: "engineering/pcb-engineering-practices.json" as const,
    practiceCatalog: {
      schemaVersion: PCB_ENGINEERING_PRACTICE_SCHEMA,
      identity: PRACTICE_CATALOG_IDENTITY
    },
    model,
    settings,
    referenceIndex,
    context: [],
    outputContract,
    exactInputs: [
      INSTRUCTION_IDENTITY,
      SOURCE_PROMPT_IDENTITY,
      PRACTICE_CATALOG_IDENTITY,
      MODEL_IDENTITY,
      SETTINGS_IDENTITY,
      REFERENCE_INDEX_IDENTITY,
      DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
      DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
    ]
  };
  const promptPack = withIdentity(promptPackPayload, DESIGN_AGENT_PROMPT_PACK_SCHEMA);
  const requestPayload = {
    schemaVersion: DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
    provider,
    promptPack
  };
  const request = {
    schemaVersion: DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
    requestIdentity: canonicalIdentity(requestPayload, DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA),
    provider,
    promptPack
  };
  const rawOutput = JSON.stringify({ generation, proposal: "fixture" });
  const response = {
    schemaVersion: DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA,
    requestIdentity: request.requestIdentity,
    promptPackIdentity: promptPack.identity,
    providerIdentity: PROVIDER_IDENTITY,
    modelIdentity: MODEL_IDENTITY,
    settingsIdentity: SETTINGS_IDENTITY,
    outputContractIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
    outputContractBytesIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
    stage: "system_architecture" as const,
    role: "system_architect" as const,
    rawOutput
  };
  const structuredProposal = {
    schemaVersion: DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
    stage: "system_architecture" as const,
    role: "system_architect" as const,
    classification: "proposal_only" as const,
    authorityDisposition: "none" as const,
    proposals: [],
    assumptions: [],
    questions: [],
    validatorRequests: requestedValidatorIds.map((validatorId) => ({
      validatorId,
      targetIds: ["power_tree"]
    }))
  };
  const untrustedNarrative = {
    schemaVersion: DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA,
    classification: "agent_claim" as const,
    disposition: "display_and_audit_only_never_authority" as const,
    summary: `Fixture proposal generation ${generation}.`,
    proposalDetails: [],
    assumptionDetails: [],
    questionDetails: [],
    validatorRequestDetails: requestedValidatorIds.map((validatorId) => ({
      validatorId,
      reason: "A deterministic validator remains required."
    })),
    limitations: ["No deterministic validation has run."]
  };
  const validatorHandoff = {
    required: true as const,
    state: "pending" as const,
    authority: "deterministic_validators_and_native_tools_only" as const,
    requestedValidators: structuredProposal.validatorRequests,
    exactInputs: [
      request.requestIdentity,
      promptPack.identity,
      canonicalIdentity(structuredProposal, DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA)
    ]
  };
  const resultPayload = {
    schemaVersion: DESIGN_AGENT_RESULT_SCHEMA,
    stage: "system_architecture" as const,
    role: "system_architect" as const,
    classification: "proposal_only" as const,
    evidenceClass: "agent_claim" as const,
    validationDisposition: "not_evaluated" as const,
    promptPackIdentity: promptPack.identity,
    requestIdentity: request.requestIdentity,
    instructionIdentity: INSTRUCTION_IDENTITY,
    trustManifestIdentity: TRUST_MANIFEST_IDENTITY,
    trustAnchors: resultTrustAnchors,
    sourcePromptIdentity: SOURCE_PROMPT_IDENTITY,
    practiceCatalogIdentity: PRACTICE_CATALOG_IDENTITY,
    providerIdentity: PROVIDER_IDENTITY,
    modelIdentity: MODEL_IDENTITY,
    settingsIdentity: SETTINGS_IDENTITY,
    referenceIndexIdentity: REFERENCE_INDEX_IDENTITY,
    outputContractIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
    outputContractBytesIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
    contextInputIdentities: [],
    rawOutputIdentity: contentIdentity(rawOutput),
    structuredProposal,
    structuredProposalIdentity: canonicalIdentity(
      structuredProposal,
      DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
    ),
    untrustedNarrative,
    untrustedNarrativeIdentity: canonicalIdentity(
      untrustedNarrative,
      DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA
    ),
    validatorHandoff,
    regenerationPolicy: DESIGN_AGENT_LIVE_REGENERATION_POLICY,
    regenerationPolicyIdentity: DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY
  };
  const result = withIdentity(resultPayload, DESIGN_AGENT_RESULT_SCHEMA);
  const replayPayload = {
    schemaVersion: DESIGN_AGENT_REPLAY_SCHEMA,
    request,
    response,
    result
  };
  const replay = withIdentity(
    replayPayload,
    DESIGN_AGENT_REPLAY_SCHEMA
  ) as unknown as FrozenDesignAgentReplay;
  const receiptPayload = {
    schemaVersion: DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
    receiptId: `replay_${replay.identity.digest}`,
    replayIdentity: replay.identity,
    trustManifestIdentity: TRUST_MANIFEST_IDENTITY,
    providerIdentity: PROVIDER_IDENTITY,
    promptPackIdentity: promptPack.identity
  };
  const replayReceipt = withIdentity(
    receiptPayload,
    DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA
  ) as DesignAgentReplayReceipt;
  return {
    mode: "live_traceable" as const,
    result,
    replay,
    replayReceipt
  };
};

interface FakeCoordinatorFixture {
  readonly port: DesignAgentWorkflowCoordinatorPort;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly replay: ReturnType<typeof vi.fn>;
  readonly receipts: Map<string, DesignAgentReplayReceipt>;
}

const makeCoordinator = (
  runBinding: DesignAgentProposalRequiredRunBinding = makeRunBinding()
): FakeCoordinatorFixture => {
  const receipts = new Map<string, DesignAgentReplayReceipt>();
  let generation = 0;
  const execute = vi.fn(async () => {
    generation += 1;
    const live = makeLiveExecution(generation);
    receipts.set(live.replayReceipt.receiptId, structuredClone(live.replayReceipt));
    return live;
  });
  const replay = vi.fn(async (replayValue: unknown, expectation: { readonly receiptId: string }) => {
    const frozen = replayValue as FrozenDesignAgentReplay;
    const receipt = receipts.get(expectation.receiptId);
    if (receipt === undefined) {
      throw new DesignAgentCoordinatorError(
        "DIGEST_MISMATCH",
        "AGENT_REPLAY_RECEIPT_NOT_FOUND",
        "fixture compact receipt is missing"
      );
    }
    if (
      receipt.replayIdentity.digest !== frozen.identity.digest ||
      receipt.trustManifestIdentity.digest !== TRUST_MANIFEST_IDENTITY.digest ||
      receipt.providerIdentity.digest !== PROVIDER_IDENTITY.digest
    ) {
      throw new DesignAgentCoordinatorError(
        "DIGEST_MISMATCH",
        "AGENT_REPLAY_RECEIPT_INVALID",
        "fixture compact receipt does not bind replay trust"
      );
    }
    return {
      mode: "frozen_exact_replay" as const,
      result: frozen.result,
      replayIdentity: frozen.identity,
      receiptId: receipt.receiptId,
      receiptIdentity: receipt.identity
    };
  });
  return { port: { runBinding, execute, replay }, execute, replay, receipts };
};

interface FakeArchiveFixture {
  readonly port: DesignAgentReplayArchivePort;
  readonly put: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly blobs: Map<string, Buffer>;
}

const makeArchive = (): FakeArchiveFixture => {
  const blobs = new Map<string, Buffer>();
  const put = vi.fn(async (bytesValue: Uint8Array | string, expected?: ReturnType<typeof contentIdentity>) => {
    const bytes = typeof bytesValue === "string"
      ? Buffer.from(bytesValue, "utf8")
      : Buffer.from(bytesValue);
    const actual = contentIdentity(bytes);
    if (expected !== undefined && canonicalJson(actual) !== canonicalJson(expected)) {
      throw new DomainError("DIGEST_MISMATCH", "fixture archive expected different bytes");
    }
    blobs.set(actual.digest, Buffer.from(bytes));
    return actual;
  });
  const get = vi.fn(async (identity: ReturnType<typeof contentIdentity>) => {
    const bytes = blobs.get(identity.digest);
    if (bytes === undefined) throw new DomainError("NOT_FOUND", "fixture archive blob missing");
    return Buffer.from(bytes);
  });
  return { port: { put, get }, put, get, blobs };
};

const makeRequest = (
  options: Partial<DesignAgentWorkflowProposalRequest> = {}
): DesignAgentWorkflowProposalRequest => ({
  mode: "proposal_required",
  intent: "resume",
  attemptId: "attempt_1",
  runBinding: makeRunBinding(),
  subject: makeSubject(),
  input: makeInput(),
  priorCheckpoint: null,
  ...options
});

const capture = async () => {
  const coordinator = makeCoordinator();
  const archive = makeArchive();
  const orchestrator = new DesignAgentWorkflowOrchestrator(
    coordinator.port,
    archive.port,
    VALIDATOR_REGISTRY
  );
  const result = await orchestrator.run(makeRequest());
  if (result.mode !== "proposal_required") throw new Error("fixture capture unexpectedly off");
  return { coordinator, archive, orchestrator, result };
};

describe("DesignAgentWorkflowOrchestrator", () => {
  it("keeps off mode inert without inspecting any configured dependency", async () => {
    let traps = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      get: () => {
        traps += 1;
        throw new Error("dependency must remain opaque");
      },
      getOwnPropertyDescriptor: () => {
        traps += 1;
        throw new Error("dependency must remain opaque");
      },
      getPrototypeOf: () => {
        traps += 1;
        throw new Error("dependency must remain opaque");
      },
      ownKeys: () => {
        traps += 1;
        throw new Error("dependency must remain opaque");
      }
    });
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      hostile as DesignAgentWorkflowCoordinatorPort,
      hostile as DesignAgentReplayArchivePort,
      hostile as DesignAgentWorkflowValidatorRegistryPort
    );

    const result = await orchestrator.run({ mode: "off" });

    expect(result).toStrictEqual({
      mode: "off",
      acquisition: "off",
      result: null,
      checkpoint: null
    });
    expect(traps).toBe(0);
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("requires both capabilities only after a proposal-required request is snapshotted", async () => {
    const orchestrator = new DesignAgentWorkflowOrchestrator();
    await expect(orchestrator.run(makeRequest())).rejects.toMatchObject({
      code: "CAPABILITY_REQUIRED",
      failureCode: "AGENT_WORKFLOW_CAPABILITY_REQUIRED"
    });
  });

  it.each([
    ["trust anchors", (input: Record<string, any>) => {
      input.trustAnchors = { ...TRUST_ANCHORS, instruction: "different-instruction" };
    }],
    ["instruction", (input: Record<string, any>) => {
      input.instructionDocument.content = "different instructions";
      input.instructionDocument.identity = contentIdentity("different instructions");
    }],
    ["practice catalog", (input: Record<string, any>) => {
      input.practiceCatalog.identity = canonicalIdentity(
        { catalog: "different" },
        PCB_ENGINEERING_PRACTICE_SCHEMA
      );
    }],
    ["model", (input: Record<string, any>) => {
      input.model.identity = canonicalIdentity({ model: "different" }, DESIGN_AGENT_MODEL_SCHEMA);
    }],
    ["settings", (input: Record<string, any>) => {
      input.settings.identity = canonicalIdentity({ temperature: 1 }, DESIGN_AGENT_SETTINGS_SCHEMA);
    }]
  ])("rejects %s input drift before inspecting or calling the coordinator", async (_label, mutate) => {
    const runBinding = makeRunBinding();
    const input = structuredClone(makeInput()) as unknown as Record<string, any>;
    mutate(input);
    const coordinator = makeCoordinator(runBinding);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      coordinator.port,
      archive.port,
      VALIDATOR_REGISTRY
    );

    await expect(orchestrator.run(makeRequest({
      runBinding,
      input: input as unknown as DesignAgentRunInput
    }))).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_INPUT_BINDING_DRIFT" });
    expect(coordinator.execute).not.toHaveBeenCalled();
    expect(coordinator.replay).not.toHaveBeenCalled();
    expect(archive.put).not.toHaveBeenCalled();
    expect(archive.get).not.toHaveBeenCalled();
  });

  it.each([
    ["trust manifest", {
      trustManifestIdentity: canonicalIdentity(
        { manifest: "different" },
        DESIGN_AGENT_TRUST_MANIFEST_SCHEMA
      )
    }],
    ["provider", {
      providerIdentity: canonicalIdentity(
        { providerId: "different-provider" },
        DESIGN_AGENT_PROVIDER_SCHEMA
      )
    }],
    ["provider executable", {
      providerExecutableIdentity: contentIdentity("different-provider-executable")
    }],
    ["model policy", {
      modelPolicyIdentity: canonicalIdentity(
        { providers: [] },
        DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA
      )
    }],
    ["output contract", {
      outputContractIdentity: canonicalIdentity(
        { outputContract: "different" },
        DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY.schemaVersion
      )
    }],
    ["regeneration policy", {
      regenerationPolicyIdentity: canonicalIdentity(
        { policy: "different" },
        DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY.schemaVersion
      )
    }]
  ] as const)("rejects current host %s drift before a provider or archive call", async (_label, overrides) => {
    const runBinding = makeRunBinding();
    const coordinator = makeCoordinator(makeRunBinding(overrides));
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      coordinator.port,
      archive.port,
      VALIDATOR_REGISTRY
    );

    await expect(orchestrator.run(makeRequest({ runBinding }))).rejects.toMatchObject({
      failureCode: "AGENT_WORKFLOW_COORDINATOR_BINDING_DRIFT"
    });
    expect(coordinator.execute).not.toHaveBeenCalled();
    expect(coordinator.replay).not.toHaveBeenCalled();
    expect(archive.put).not.toHaveBeenCalled();
    expect(archive.get).not.toHaveBeenCalled();
  });

  it("rejects a self-consistent replay result whose trust anchors drift from the run binding", async () => {
    const runBinding = makeRunBinding();
    const execute = vi.fn(async () => makeLiveExecution(1, {
      ...TRUST_ANCHORS,
      instruction: "different-instruction"
    }));
    const replay = vi.fn(async () => undefined);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      { runBinding, execute, replay },
      archive.port,
      VALIDATOR_REGISTRY
    );

    await expect(orchestrator.run(makeRequest({ runBinding }))).rejects.toMatchObject({
      failureCode: "AGENT_WORKFLOW_RESULT_BINDING_DRIFT"
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(archive.put).not.toHaveBeenCalled();
  });

  it("rejects a known outdated validator ID through the orchestration boundary", async () => {
    const runBinding = makeRunBinding();
    const execute = vi.fn(async () => makeLiveExecution(
      1,
      TRUST_ANCHORS,
      ["evleda.pcb-practice-analyzer.v1"]
    ));
    const replay = vi.fn(async () => undefined);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      { runBinding, execute, replay },
      archive.port,
      VALIDATOR_REGISTRY
    );

    await expect(orchestrator.run(makeRequest({ runBinding }))).rejects.toMatchObject({
      failureCode: "AGENT_DETERMINISTIC_VALIDATOR_OUTDATED"
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(archive.put).not.toHaveBeenCalled();
  });

  it("unions host-mandatory validators even when the model requests none", async () => {
    const runBinding = makeRunBinding();
    const execute = vi.fn(async () => makeLiveExecution(1, TRUST_ANCHORS, []));
    const replay = vi.fn(async () => undefined);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      { runBinding, execute, replay },
      archive.port,
      VALIDATOR_REGISTRY
    );

    const result = await orchestrator.run(makeRequest({ runBinding }));
    if (result.mode !== "proposal_required") throw new Error("fixture result unexpectedly off");
    expect(result.validatorPlan.requestedValidatorIds).toEqual([]);
    expect(result.validatorPlan.mandatoryValidatorIds).toContain(
      DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
    );
    expect(result.validatorPlan.validatorIds).toContain(
      DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID
    );
    expect(result.checkpoint.validatorPlanIdentity).toStrictEqual(
      result.validatorPlan.identity
    );
  });

  it("blocks validator-registry drift before provider/archive work and never falls back", async () => {
    const runBinding = makeRunBinding();
    const driftedRegistry = createDesignAgentDeterministicValidatorRegistry({
      registrations: [
        {
          validatorId: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID,
          implementationVersion: "1.0.0",
          scope: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
          applicability: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS
        },
        {
          validatorId: "fixture.additional-structured-reference-validator.v1",
          implementationVersion: "1.0.0",
          scope: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
          applicability: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS
        }
      ],
      mandatoryCoverage: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.map((pair) => ({
        ...pair,
        validatorIds: [DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_ID]
      }))
    });
    const coordinator = makeCoordinator(runBinding);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      coordinator.port,
      archive.port,
      driftedRegistry
    );

    await expect(orchestrator.run(makeRequest({ runBinding }))).rejects.toMatchObject({
      failureCode: "AGENT_WORKFLOW_VALIDATOR_REGISTRY_DRIFT"
    });
    expect(coordinator.execute).not.toHaveBeenCalled();
    expect(coordinator.replay).not.toHaveBeenCalled();
    expect(archive.put).not.toHaveBeenCalled();
    expect(archive.get).not.toHaveBeenCalled();
  });

  it("reconstructs the complete validator plan from the pinned snapshot", async () => {
    const runBinding = makeRunBinding();
    const faultyRegistry: DesignAgentWorkflowValidatorRegistryPort = {
      ...VALIDATOR_REGISTRY,
      plan: (input) => {
        const valid = VALIDATOR_REGISTRY.plan(input);
        const payload = {
          schemaVersion: valid.schemaVersion,
          stage: valid.stage,
          role: valid.role,
          authority: valid.authority,
          requestedValidatorIds: valid.requestedValidatorIds,
          mandatoryValidatorIds: [],
          validatorIds: valid.validatorIds,
          validators: valid.validators.map((validator) => ({
            ...validator,
            selection: "model_requested" as const
          })),
          registryIdentity: valid.registryIdentity
        };
        return {
          ...payload,
          identity: canonicalIdentity(payload, valid.schemaVersion)
        };
      }
    };
    const coordinator = makeCoordinator(runBinding);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      coordinator.port,
      archive.port,
      faultyRegistry
    );

    await expect(orchestrator.run(makeRequest({ runBinding }))).rejects.toMatchObject({
      failureCode: "AGENT_WORKFLOW_VALIDATOR_PLAN_INVALID"
    });
    expect(coordinator.execute).toHaveBeenCalledTimes(1);
    expect(archive.put).not.toHaveBeenCalled();
  });

  it("uses the registry's canonical code-unit ordering for validator IDs", async () => {
    const upperId = "Z.validator.v1";
    const lowerId = "a.validator.v1";
    const mixedRegistry = createDesignAgentDeterministicValidatorRegistry({
      registrations: [upperId, lowerId].map((validatorId) => ({
        validatorId,
        implementationVersion: "1.0.0",
        scope: DESIGN_AGENT_STRUCTURED_REFERENCE_VALIDATOR_SCOPE,
        applicability: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS
      })),
      mandatoryCoverage: DESIGN_AGENT_PROPOSAL_STAGE_ROLE_PAIRS.map((pair) => ({
        ...pair,
        validatorIds: [upperId]
      }))
    });
    const runBinding = makeRunBinding({
      validatorRegistryIdentity: mixedRegistry.snapshot().identity
    });
    const execute = vi.fn(async () => makeLiveExecution(1, TRUST_ANCHORS, [lowerId]));
    const replay = vi.fn(async () => undefined);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      { runBinding, execute, replay },
      archive.port,
      mixedRegistry
    );

    const result = await orchestrator.run(makeRequest({ runBinding }));
    if (result.mode !== "proposal_required") throw new Error("fixture result unexpectedly off");
    expect(result.validatorPlan.validatorIds).toEqual([upperId, lowerId]);
  });

  it("captures a live proposal, archives exact canonical replay bytes, and returns only a compact checkpoint", async () => {
    const { coordinator, archive, result } = await capture();

    expect(result.acquisition).toBe("live_traceable");
    expect(result.checkpoint.capture).toStrictEqual({
      acquisitionMode: "live_traceable",
      capturedAttemptId: "attempt_1"
    });
    expect(result.validatorPlan.identity).toStrictEqual(result.checkpoint.validatorPlanIdentity);
    expect(result.validatorPlan.registryIdentity).toStrictEqual(
      result.checkpoint.validatorRegistryIdentity
    );
    expect(coordinator.execute).toHaveBeenCalledTimes(1);
    expect(coordinator.replay).not.toHaveBeenCalled();
    expect(archive.put).toHaveBeenCalledTimes(1);
    expect(archive.get).toHaveBeenCalledTimes(1);
    const stored = archive.blobs.get(result.checkpoint.replayBlob.digest);
    expect(stored).toBeDefined();
    expect(contentIdentity(stored!)).toStrictEqual(result.checkpoint.replayBlob);
    expect(stored!.at(-1)).toBe(0x0a);
    const parsed = JSON.parse(stored!.toString("utf8"));
    expect(stored!.toString("utf8")).toBe(`${canonicalJson(parsed)}\n`);
    expect(result).not.toHaveProperty("replay");
    expect(deeplyFrozen(result)).toBe(true);
  });

  it("uses an exact stable-subject checkpoint replay without another live provider call", async () => {
    const fixture = await capture();
    const replayed = await fixture.orchestrator.run(makeRequest({
      attemptId: "attempt_2",
      priorCheckpoint: fixture.result.checkpoint
    }));
    if (replayed.mode !== "proposal_required") throw new Error("fixture replay unexpectedly off");

    expect(replayed.acquisition).toBe("frozen_exact_replay");
    expect(replayed.result).toStrictEqual(fixture.result.result);
    expect(replayed.checkpoint.capture).toStrictEqual({
      acquisitionMode: "frozen_exact_replay",
      capturedAttemptId: "attempt_1",
      replayingAttemptId: "attempt_2"
    });
    expect(replayed.checkpoint.replayBlob).toStrictEqual(fixture.result.checkpoint.replayBlob);
    expect(replayed.checkpoint.receiptId).toBe(fixture.result.checkpoint.receiptId);
    expect(replayed.validatorPlan).toStrictEqual(fixture.result.validatorPlan);
    expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.replay).toHaveBeenCalledTimes(1);
    expect(fixture.archive.put).toHaveBeenCalledTimes(1);
    expect(deeplyFrozen(replayed)).toBe(true);
  });

  it("copies archive typed-array bytes without reading instance accessors and rejects shared storage", async () => {
    const fixture = await capture();
    const stored = fixture.archive.blobs.get(fixture.result.checkpoint.replayBlob.digest)!;
    const accessorBacked = new Uint8Array(stored);
    let accessorReads = 0;
    for (const key of ["buffer", "byteLength", "byteOffset", "length"] as const) {
      Object.defineProperty(accessorBacked, key, {
        configurable: true,
        get: () => {
          accessorReads += 1;
          throw new Error(`archive byte accessor ${key} must not be read`);
        }
      });
    }
    Object.defineProperty(accessorBacked, Symbol.iterator, {
      configurable: true,
      get: () => {
        accessorReads += 1;
        throw new Error("archive byte iterator must not be read");
      }
    });
    fixture.archive.get.mockImplementationOnce(async () => accessorBacked);

    await expect(fixture.orchestrator.run(makeRequest({
      attemptId: "attempt_2",
      priorCheckpoint: fixture.result.checkpoint
    }))).resolves.toMatchObject({ acquisition: "frozen_exact_replay" });
    expect(accessorReads).toBe(0);

    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(stored.length));
      shared.set(stored);
      fixture.archive.get.mockImplementationOnce(async () => shared);
      await expect(fixture.orchestrator.run(makeRequest({
        attemptId: "attempt_3",
        priorCheckpoint: fixture.result.checkpoint
      }))).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_REPLAY_BLOB_INVALID" });
    }
  });

  it("always captures a fresh explicit rerun and ignores even a hostile prior checkpoint value", async () => {
    const fixture = await capture();
    const hostileCheckpoint = new Proxy({}, {
      get: () => {
        throw new Error("explicit rerun must ignore prior checkpoint");
      },
      ownKeys: () => {
        throw new Error("explicit rerun must ignore prior checkpoint");
      }
    });
    const rerun = await fixture.orchestrator.run(makeRequest({
      intent: "explicit_rerun",
      attemptId: "attempt_2",
      priorCheckpoint: hostileCheckpoint as unknown as DesignAgentAttemptCheckpoint
    }));
    if (rerun.mode !== "proposal_required") throw new Error("fixture rerun unexpectedly off");

    expect(rerun.acquisition).toBe("live_traceable");
    expect(rerun.checkpoint.capture).toStrictEqual({
      acquisitionMode: "live_traceable",
      capturedAttemptId: "attempt_2"
    });
    expect(rerun.result.identity).not.toStrictEqual(fixture.result.result.identity);
    expect(fixture.coordinator.execute).toHaveBeenCalledTimes(2);
    expect(fixture.coordinator.replay).not.toHaveBeenCalled();
    expect(fixture.archive.put).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a missing or corrupted full replay and never falls back to live", async () => {
    const missing = await capture();
    missing.archive.blobs.delete(missing.result.checkpoint.replayBlob.digest);
    await expect(missing.orchestrator.run(makeRequest({
      attemptId: "attempt_2",
      priorCheckpoint: missing.result.checkpoint
    }))).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_REPLAY_BLOB_NOT_FOUND" });
    expect(missing.coordinator.execute).toHaveBeenCalledTimes(1);
    expect(missing.coordinator.replay).not.toHaveBeenCalled();

    const corrupted = await capture();
    corrupted.archive.blobs.set(
      corrupted.result.checkpoint.replayBlob.digest,
      Buffer.from("{\"corrupted\":true}\n")
    );
    await expect(corrupted.orchestrator.run(makeRequest({
      attemptId: "attempt_2",
      priorCheckpoint: corrupted.result.checkpoint
    }))).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_REPLAY_BLOB_MISMATCH" });
    expect(corrupted.coordinator.execute).toHaveBeenCalledTimes(1);
    expect(corrupted.coordinator.replay).not.toHaveBeenCalled();
  });

  it("fails closed on missing or mismatched compact receipts", async () => {
    const missing = await capture();
    missing.coordinator.receipts.delete(missing.result.checkpoint.receiptId);
    await expect(missing.orchestrator.run(makeRequest({
      attemptId: "attempt_2",
      priorCheckpoint: missing.result.checkpoint
    }))).rejects.toMatchObject({ failureCode: "AGENT_REPLAY_RECEIPT_NOT_FOUND" });
    expect(missing.coordinator.execute).toHaveBeenCalledTimes(1);

    const mismatched = await capture();
    const receipt = mismatched.coordinator.receipts.get(mismatched.result.checkpoint.receiptId)!;
    mismatched.coordinator.receipts.set(receipt.receiptId, {
      ...receipt,
      providerIdentity: canonicalIdentity(
        { providerId: "different-provider" },
        DESIGN_AGENT_PROVIDER_SCHEMA
      )
    });
    await expect(mismatched.orchestrator.run(makeRequest({
      attemptId: "attempt_2",
      priorCheckpoint: mismatched.result.checkpoint
    }))).rejects.toMatchObject({ failureCode: "AGENT_REPLAY_RECEIPT_INVALID" });
    expect(mismatched.coordinator.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects stable-subject or trust drift before archive/provider use", async () => {
    const fixture = await capture();
    const callsBefore = fixture.archive.get.mock.calls.length;
    const changedSubject = makeSubject(canonicalIdentity(
      { stage: "system_architecture", revision: 2 },
      "evleda.stage-input.system_architecture.v1"
    ));
    await expect(fixture.orchestrator.run(makeRequest({
      attemptId: "attempt_2",
      subject: changedSubject,
      priorCheckpoint: fixture.result.checkpoint
    }))).rejects.toBeInstanceOf(DomainError);
    expect(fixture.archive.get).toHaveBeenCalledTimes(callsBefore);
    expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.replay).not.toHaveBeenCalled();

    const changedBinding = makeRunBinding({
      providerExecutableIdentity: contentIdentity("different-provider-executable")
    });
    await expect(fixture.orchestrator.run(makeRequest({
      attemptId: "attempt_3",
      runBinding: changedBinding,
      priorCheckpoint: fixture.result.checkpoint
    }))).rejects.toBeInstanceOf(DomainError);
    expect(fixture.archive.get).toHaveBeenCalledTimes(callsBefore);
    expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.replay).not.toHaveBeenCalled();
  });

  it("snapshots request data before awaiting the coordinator", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observedInput: unknown;
    const receipts = new Map<string, DesignAgentReplayReceipt>();
    const execute = vi.fn(async (input: unknown) => {
      observedInput = input;
      await gate;
      const live = makeLiveExecution(1);
      receipts.set(live.replayReceipt.receiptId, live.replayReceipt);
      return live;
    });
    const replay = vi.fn(async () => undefined);
    const archive = makeArchive();
    const runBinding = makeRunBinding();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      { runBinding, execute, replay },
      archive.port,
      VALIDATOR_REGISTRY
    );
    const mutableInput = structuredClone(makeInput()) as unknown as {
      instructionDocument: { content: string };
    };

    const pending = orchestrator.run(makeRequest({
      input: mutableInput as unknown as DesignAgentRunInput,
      runBinding
    }));
    mutableInput.instructionDocument.content = "mutated-after-call";
    release();
    await pending;

    expect(observedInput).toMatchObject({
      instructionDocument: { content: "fixture design-agent instructions" }
    });
    expect(deeplyFrozen(observedInput)).toBe(true);
  });

  it("rejects proxy and accessor request graphs without invoking their traps", async () => {
    const fixture = await capture();
    let proxyReads = 0;
    const proxy = new Proxy({}, {
      get: () => {
        proxyReads += 1;
        throw new Error("request proxy trap must not run");
      },
      getPrototypeOf: () => {
        proxyReads += 1;
        throw new Error("request proxy trap must not run");
      }
    });
    await expect(fixture.orchestrator.run(
      proxy as unknown as DesignAgentWorkflowProposalRequest
    )).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_REQUEST_INVALID" });
    expect(proxyReads).toBe(0);

    let accessorReads = 0;
    const accessorRequest: Record<string, unknown> = { ...makeRequest() };
    Object.defineProperty(accessorRequest, "input", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return makeInput();
      }
    });
    await expect(fixture.orchestrator.run(
      accessorRequest as unknown as DesignAgentWorkflowProposalRequest
    )).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_REQUEST_INVALID" });
    expect(accessorReads).toBe(0);
  });

  it("bounds request and port inspection without reading hidden, symbol, unknown, or inherited accessors", async () => {
    const runBinding = makeRunBinding();
    const coordinator = makeCoordinator(runBinding);
    const archive = makeArchive();
    const orchestrator = new DesignAgentWorkflowOrchestrator(
      coordinator.port,
      archive.port,
      VALIDATOR_REGISTRY
    );
    let reads = 0;

    const hiddenRequest = { ...makeRequest({ runBinding }) } as Record<PropertyKey, unknown>;
    for (let index = 0; index < 2_048; index += 1) {
      Object.defineProperty(hiddenRequest, `hidden_${index}`, {
        enumerable: false,
        get: () => {
          reads += 1;
          throw new Error("hidden request property must not be read");
        }
      });
      Object.defineProperty(hiddenRequest, Symbol(`hidden_${index}`), {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error("symbol request property must not be read");
        }
      });
    }
    await expect(orchestrator.run(
      hiddenRequest as unknown as DesignAgentWorkflowProposalRequest
    )).resolves.toMatchObject({ acquisition: "live_traceable" });
    expect(reads).toBe(0);

    const nestedInput = structuredClone(makeInput()) as unknown as Record<string, any>;
    for (let index = 0; index < 2_048; index += 1) {
      Object.defineProperty(nestedInput.model, `hidden_${index}`, {
        enumerable: false,
        get: () => {
          reads += 1;
          throw new Error("hidden nested property must not be read");
        }
      });
      Object.defineProperty(nestedInput.model, Symbol(`hidden_${index}`), {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error("symbol nested property must not be read");
        }
      });
    }
    await expect(orchestrator.run(makeRequest({
      runBinding,
      input: nestedInput as DesignAgentRunInput
    }))).resolves.toMatchObject({ acquisition: "live_traceable" });
    expect(reads).toBe(0);

    const namedRequest = Object.assign(Object.create(null), makeRequest({ runBinding })) as Record<
      PropertyKey,
      unknown
    >;
    for (let index = 0; index < 2_048; index += 1) {
      Object.defineProperty(namedRequest, `unknown_${index}`, {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error("unknown request property must not be read");
        }
      });
    }
    await expect(orchestrator.run(
      namedRequest as unknown as DesignAgentWorkflowProposalRequest
    )).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_REQUEST_INVALID" });
    expect(reads).toBe(0);

    const inheritedPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inheritedPrototype, "inherited", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("inherited request property must not be read");
      }
    });
    const inheritedRequest = Object.assign(
      Object.create(inheritedPrototype),
      makeRequest({ runBinding })
    );
    await expect(orchestrator.run(
      inheritedRequest as DesignAgentWorkflowProposalRequest
    )).rejects.toMatchObject({ failureCode: "AGENT_WORKFLOW_REQUEST_INVALID" });
    expect(reads).toBe(0);

    const noisyPort = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(noisyPort, "unknown", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("unknown port property must not be read");
      }
    });
    Object.assign(noisyPort, coordinator.port);
    const noisyOrchestrator = new DesignAgentWorkflowOrchestrator(
      noisyPort as unknown as DesignAgentWorkflowCoordinatorPort,
      archive.port,
      VALIDATOR_REGISTRY
    );
    await expect(noisyOrchestrator.run(makeRequest({ runBinding }))).rejects.toMatchObject({
      failureCode: "AGENT_WORKFLOW_COORDINATOR_PORT_INVALID"
    });
    expect(reads).toBe(0);
  });
});

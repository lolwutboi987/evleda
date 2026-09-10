import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { PCB_ENGINEERING_PRACTICE_SCHEMA } from "../../src/knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_LIVE_POLICY_SCHEMA,
  DESIGN_AGENT_MODEL_SCHEMA,
  DESIGN_AGENT_PROMPT_PACK_SCHEMA,
  DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA,
  DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA,
  DESIGN_AGENT_PROVIDER_SCHEMA,
  DESIGN_AGENT_REFERENCE_INDEX_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_SETTINGS_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
  DESIGN_AGENT_TRUST_MANIFEST_SCHEMA,
  DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA
} from "../../src/agents/contracts.js";
import { DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA } from "../../src/agents/production-model-policy.js";
import {
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA,
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
} from "../../src/agents/deterministic-validator-registry.js";
import {
  DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA,
  DESIGN_AGENT_RESERVED_ARTIFACT_PREFIX,
  DESIGN_AGENT_RUN_BINDING_SCHEMA,
  DESIGN_AGENT_RUN_SCOPE,
  DESIGN_AGENT_STAGE_SUBJECT_SCHEMA,
  DESIGN_AGENT_VALIDATOR_HANDOFF_BINDING_SCHEMA,
  bindDesignAgentAttemptCheckpoint,
  bindDesignAgentRunBinding,
  bindDesignAgentStageSubject,
  createDesignAgentAttemptCheckpoint,
  createDesignAgentRunBinding,
  createDesignAgentStageSubject,
  isReservedDesignAgentArtifactLogicalName,
  type DesignAgentAttemptCheckpointInput,
  type DesignAgentProposalRequiredRunBinding,
  type DesignAgentRunBindingInput,
  type DesignAgentStageSubject,
  type DesignAgentStageSubjectInput
} from "../../src/agents/workflow-contracts.js";

const deeplyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== "object" || value === null || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => !("value" in descriptor) || deeplyFrozen(descriptor.value, seen)
  );
};

const boundIdentity = (label: string, schemaVersion: string) =>
  canonicalIdentity({ label }, schemaVersion);

const TRUST_MANIFEST_IDENTITY = boundIdentity("trust-manifest", DESIGN_AGENT_TRUST_MANIFEST_SCHEMA);
const INSTRUCTION_IDENTITY = contentIdentity("workflow instructions");
const PRACTICE_CATALOG_IDENTITY = boundIdentity(
  "practice-catalog",
  PCB_ENGINEERING_PRACTICE_SCHEMA
);
const PROVIDER_IDENTITY = boundIdentity("provider", DESIGN_AGENT_PROVIDER_SCHEMA);
const PROVIDER_EXECUTABLE_IDENTITY = contentIdentity("provider executable");
const MODEL_IDENTITY = boundIdentity("model", DESIGN_AGENT_MODEL_SCHEMA);
const MODEL_POLICY_IDENTITY = boundIdentity(
  "model-policy",
  DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA
);
const SETTINGS_IDENTITY = boundIdentity("settings", DESIGN_AGENT_SETTINGS_SCHEMA);
const VALIDATOR_REGISTRY_IDENTITY = boundIdentity(
  "validator-registry",
  DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
);
const OUTPUT_CONTRACT_IDENTITY = boundIdentity(
  "output-contract",
  DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA
);
const OUTPUT_CONTRACT_BYTES_IDENTITY = contentIdentity("output contract bytes");
const REGENERATION_POLICY_IDENTITY = boundIdentity(
  "regeneration-policy",
  DESIGN_AGENT_LIVE_POLICY_SCHEMA
);

const RUN_INPUT: DesignAgentRunBindingInput = {
  mode: "proposal_required",
  scope: DESIGN_AGENT_RUN_SCOPE,
  trustManifestId: "manifest_fixture",
  trustManifestIdentity: TRUST_MANIFEST_IDENTITY,
  trustAnchors: {
    instruction: "instruction_fixture",
    practiceCatalog: "catalog_fixture",
    provider: "provider_fixture",
    modelFamily: "model_family_fixture",
    outputContract: "output_fixture"
  },
  instructionIdentity: INSTRUCTION_IDENTITY,
  practiceCatalogIdentity: PRACTICE_CATALOG_IDENTITY,
  providerIdentity: PROVIDER_IDENTITY,
  providerExecutableIdentity: PROVIDER_EXECUTABLE_IDENTITY,
  modelIdentity: MODEL_IDENTITY,
  modelPolicyIdentity: MODEL_POLICY_IDENTITY,
  settingsIdentity: SETTINGS_IDENTITY,
  validatorRegistryIdentity: VALIDATOR_REGISTRY_IDENTITY,
  outputContractIdentity: OUTPUT_CONTRACT_IDENTITY,
  outputContractBytesIdentity: OUTPUT_CONTRACT_BYTES_IDENTITY,
  regenerationPolicyIdentity: REGENERATION_POLICY_IDENTITY
};

const makeRunBinding = (
  overrides: Readonly<Record<string, unknown>> = {}
): DesignAgentProposalRequiredRunBinding => {
  const binding = createDesignAgentRunBinding({
    ...RUN_INPUT,
    ...overrides
  } as DesignAgentRunBindingInput);
  if (binding.mode !== "proposal_required") throw new Error("fixture binding unexpectedly off");
  return binding;
};

const SUBJECT_INPUT: DesignAgentStageSubjectInput = {
  projectId: "project_fixture",
  runId: "run_fixture",
  designRevisionId: "revision_fixture",
  stage: "system_architecture",
  inputManifest: boundIdentity("stage-input", "evleda.stage-input.system_architecture.v1"),
  provisionIdentity: boundIdentity("provision", "evleda.stage-provision.v1"),
  provisionManifestBlob: contentIdentity("provision manifest"),
  requirementsIdentity: boundIdentity("requirements", "evleda.requirements.v1"),
  runConfigurationIdentity: boundIdentity("run-configuration", "evleda.run-configuration.v1"),
  workflowVersion: "workflow_fixture_v1"
};

const makeSubject = (
  overrides: Readonly<Record<string, unknown>> = {}
): DesignAgentStageSubject =>
  createDesignAgentStageSubject({
    ...SUBJECT_INPUT,
    ...overrides
  } as DesignAgentStageSubjectInput);

const checkpointInput = (
  runBinding = makeRunBinding(),
  subject = makeSubject(),
  overrides: Readonly<Record<string, unknown>> = {}
): DesignAgentAttemptCheckpointInput => {
  const replayIdentity = boundIdentity("replay", DESIGN_AGENT_REPLAY_SCHEMA);
  return {
    capture: { acquisitionMode: "live_traceable", capturedAttemptId: "attempt_1" },
    subject,
    runBinding,
    requestIdentity: boundIdentity("request", DESIGN_AGENT_PROVIDER_REQUEST_SCHEMA),
    promptPackIdentity: boundIdentity("prompt-pack", DESIGN_AGENT_PROMPT_PACK_SCHEMA),
    resultIdentity: boundIdentity("result", DESIGN_AGENT_RESULT_SCHEMA),
    structuredProposalIdentity: boundIdentity(
      "structured-proposal",
      DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
    ),
    untrustedNarrativeIdentity: boundIdentity(
      "untrusted-narrative",
      DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA
    ),
    rawOutputIdentity: contentIdentity("raw provider output"),
    trustManifestIdentity: runBinding.trustManifestIdentity,
    instructionIdentity: runBinding.instructionIdentity,
    practiceCatalogIdentity: runBinding.practiceCatalogIdentity,
    providerIdentity: runBinding.providerIdentity,
    providerExecutableIdentity: runBinding.providerExecutableIdentity,
    modelIdentity: runBinding.modelIdentity,
    modelPolicyIdentity: runBinding.modelPolicyIdentity,
    settingsIdentity: runBinding.settingsIdentity,
    referenceIndexIdentity: boundIdentity("reference-index", DESIGN_AGENT_REFERENCE_INDEX_SCHEMA),
    validatorRegistryIdentity: runBinding.validatorRegistryIdentity,
    validatorPlanIdentity: boundIdentity(
      "validator-plan",
      DESIGN_AGENT_DETERMINISTIC_VALIDATOR_PLAN_SCHEMA
    ),
    outputContractIdentity: runBinding.outputContractIdentity,
    outputContractBytesIdentity: runBinding.outputContractBytesIdentity,
    replayIdentity,
    replayBlob: contentIdentity("full frozen replay bytes"),
    receiptId: `replay_${replayIdentity.digest}`,
    receiptIdentity: boundIdentity("receipt", DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA),
    validatorHandoffIdentity: boundIdentity(
      "validator-handoff",
      DESIGN_AGENT_VALIDATOR_HANDOFF_BINDING_SCHEMA
    ),
    regenerationPolicyIdentity: runBinding.regenerationPolicyIdentity,
    ...overrides
  } as DesignAgentAttemptCheckpointInput;
};

describe("design-agent run bindings", () => {
  it("binds a closed, explicit off record and its eight-stage scope", () => {
    const binding = createDesignAgentRunBinding({
      mode: "off",
      scope: DESIGN_AGENT_RUN_SCOPE
    });

    expect(binding).toStrictEqual({
      schemaVersion: DESIGN_AGENT_RUN_BINDING_SCHEMA,
      mode: "off",
      scope: "candidate_stages_v1",
      identity: canonicalIdentity(
        {
          schemaVersion: DESIGN_AGENT_RUN_BINDING_SCHEMA,
          mode: "off",
          scope: "candidate_stages_v1"
        },
        DESIGN_AGENT_RUN_BINDING_SCHEMA
      )
    });
    expect(bindDesignAgentRunBinding(binding)).toStrictEqual(binding);
    expect(deeplyFrozen(binding)).toBe(true);
    expect(() => createDesignAgentRunBinding({ mode: "off" } as never)).toThrow();
    expect(() =>
      createDesignAgentRunBinding({ mode: "off", scope: "all_stages" } as never)
    ).toThrow();
  });

  it("captures every immutable provider binding but no stage-specific reference index", () => {
    const mutable = {
      ...RUN_INPUT,
      trustAnchors: { ...RUN_INPUT.trustAnchors }
    } as any;
    const binding = createDesignAgentRunBinding(mutable);
    mutable.trustManifestId = "mutated_after_capture";
    mutable.trustAnchors.provider = "mutated_after_capture";

    expect(binding.mode).toBe("proposal_required");
    expect(binding).toMatchObject({
      scope: "candidate_stages_v1",
      trustManifestId: "manifest_fixture",
      modelPolicyIdentity: MODEL_POLICY_IDENTITY
    });
    expect(binding).not.toHaveProperty("referenceIndexIdentity");
    expect(binding).not.toHaveProperty("validatorPlanIdentity");
    expect(bindDesignAgentRunBinding(binding)).toStrictEqual(binding);
    expect(deeplyFrozen(binding)).toBe(true);
  });

  it("rejects unknown enumerable binding fields and non-reproducing identities", () => {
    expect(() =>
      createDesignAgentRunBinding({ ...RUN_INPUT, referenceIndexIdentity: boundIdentity("x", "x.v1") } as never)
    ).toThrow();

    const binding = makeRunBinding();
    expect(() =>
      bindDesignAgentRunBinding({
        ...binding,
        identity: { ...binding.identity, digest: "0".repeat(64) }
      })
    ).toThrow();
  });
});

describe("stable stage subjects", () => {
  it("binds only stable stage inputs and excludes attempt identity", () => {
    const subject = makeSubject();
    expect(subject.schemaVersion).toBe(DESIGN_AGENT_STAGE_SUBJECT_SCHEMA);
    expect(subject).not.toHaveProperty("attemptId");
    expect(bindDesignAgentStageSubject(subject)).toStrictEqual(subject);
    expect(deeplyFrozen(subject)).toBe(true);

    expect(() =>
      createDesignAgentStageSubject({ ...SUBJECT_INPUT, attemptId: "attempt_1" } as never)
    ).toThrow();
    expect(() =>
      createDesignAgentStageSubject({ ...SUBJECT_INPUT, stage: "requirements" } as never)
    ).toThrow();
  });
});

describe("attempt checkpoints", () => {
  it("binds the stable subject, compact receipt, and internal full-replay blob", () => {
    const checkpoint = createDesignAgentAttemptCheckpoint(checkpointInput());

    expect(checkpoint.schemaVersion).toBe(DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA);
    expect(checkpoint.capture).toStrictEqual({
      acquisitionMode: "live_traceable",
      capturedAttemptId: "attempt_1"
    });
    expect(checkpoint.replayBlob).toStrictEqual(contentIdentity("full frozen replay bytes"));
    expect(checkpoint.receiptId).toBe(`replay_${checkpoint.replayIdentity.digest}`);
    expect(checkpoint).not.toHaveProperty("replay");
    expect(deeplyFrozen(checkpoint)).toBe(true);
    expect(bindDesignAgentAttemptCheckpoint(checkpoint, {
      subject: checkpoint.subject,
      runBinding: checkpoint.runBinding
    })).toStrictEqual(checkpoint);
  });

  it("tracks replay attempts without changing the stable subject", () => {
    const live = createDesignAgentAttemptCheckpoint(checkpointInput());
    const replayed = createDesignAgentAttemptCheckpoint(checkpointInput(
      live.runBinding,
      live.subject,
      {
        capture: {
          acquisitionMode: "frozen_exact_replay",
          capturedAttemptId: "attempt_1",
          replayingAttemptId: "attempt_2"
        }
      }
    ));

    expect(replayed.capture).toStrictEqual({
      acquisitionMode: "frozen_exact_replay",
      capturedAttemptId: "attempt_1",
      replayingAttemptId: "attempt_2"
    });
    expect(replayed.subject.identity).toStrictEqual(live.subject.identity);
    expect(replayed.identity).not.toStrictEqual(live.identity);
  });

  it.each([
    ["trustManifestIdentity", () => boundIdentity("other", DESIGN_AGENT_TRUST_MANIFEST_SCHEMA)],
    ["instructionIdentity", () => contentIdentity("other instruction")],
    ["practiceCatalogIdentity", () => boundIdentity("other", PCB_ENGINEERING_PRACTICE_SCHEMA)],
    ["providerIdentity", () => boundIdentity("other", DESIGN_AGENT_PROVIDER_SCHEMA)],
    ["providerExecutableIdentity", () => contentIdentity("other executable")],
    ["modelIdentity", () => boundIdentity("other", DESIGN_AGENT_MODEL_SCHEMA)],
    ["modelPolicyIdentity", () => boundIdentity("other", DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA)],
    ["settingsIdentity", () => boundIdentity("other", DESIGN_AGENT_SETTINGS_SCHEMA)],
    ["validatorRegistryIdentity", () => boundIdentity("other", DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA)],
    ["outputContractIdentity", () => boundIdentity("other", DESIGN_AGENT_PROPOSAL_OUTPUT_SCHEMA)],
    ["outputContractBytesIdentity", () => contentIdentity("other output contract")],
    ["regenerationPolicyIdentity", () => boundIdentity("other", DESIGN_AGENT_LIVE_POLICY_SCHEMA)]
  ])("rejects checkpoint/run-binding drift in %s", (field, other) => {
    expect(() =>
      createDesignAgentAttemptCheckpoint(checkpointInput(
        makeRunBinding(),
        makeSubject(),
        { [field]: other() }
      ))
    ).toThrowError(expect.objectContaining({
      failureCode: "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH"
    }));
  });

  it("rejects rehashed semantic drift and expectation drift", () => {
    const checkpoint = createDesignAgentAttemptCheckpoint(checkpointInput());
    const { identity: _identity, ...payload } = checkpoint;
    const inconsistentPayload = {
      ...payload,
      providerIdentity: boundIdentity("other-provider", DESIGN_AGENT_PROVIDER_SCHEMA)
    };
    const inconsistent = {
      ...inconsistentPayload,
      identity: canonicalIdentity(inconsistentPayload, DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA)
    };
    expect(() => bindDesignAgentAttemptCheckpoint(inconsistent)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH" })
    );

    const inconsistentRegistryPayload = {
      ...payload,
      validatorRegistryIdentity: boundIdentity(
        "other-registry",
        DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY_SCHEMA
      )
    };
    const inconsistentRegistry = {
      ...inconsistentRegistryPayload,
      identity: canonicalIdentity(
        inconsistentRegistryPayload,
        DESIGN_AGENT_ATTEMPT_CHECKPOINT_SCHEMA
      )
    };
    expect(() => bindDesignAgentAttemptCheckpoint(inconsistentRegistry)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_WORKFLOW_CHECKPOINT_RUN_BINDING_MISMATCH" })
    );

    expect(() => createDesignAgentAttemptCheckpoint(checkpointInput(
      checkpoint.runBinding,
      checkpoint.subject,
      { validatorPlanIdentity: boundIdentity("wrong-plan", "fixture.wrong-plan.v1") }
    ))).toThrow();

    const otherSubject = makeSubject({
      inputManifest: boundIdentity("different-input", "evleda.stage-input.system_architecture.v1")
    });
    expect(() => bindDesignAgentAttemptCheckpoint(checkpoint, {
      subject: otherSubject,
      runBinding: checkpoint.runBinding
    })).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_WORKFLOW_CHECKPOINT_SUBJECT_MISMATCH" })
    );
  });
});

describe("plain-data boundary and reserved artifact namespace", () => {
  it("rejects proxies and accessors without invoking their traps", () => {
    let reads = 0;
    const proxy = new Proxy({}, {
      get: () => {
        reads += 1;
        throw new Error("trap");
      },
      getPrototypeOf: () => {
        reads += 1;
        throw new Error("trap");
      },
      ownKeys: () => {
        reads += 1;
        throw new Error("trap");
      }
    });
    expect(() => createDesignAgentRunBinding(proxy as never)).toThrow();
    expect(reads).toBe(0);

    const hostileArray: unknown[] = [];
    Object.defineProperty(hostileArray, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        throw new Error("trap");
      }
    });
    hostileArray.length = 1;
    expect(() => createDesignAgentRunBinding({
      mode: "off",
      scope: DESIGN_AGENT_RUN_SCOPE,
      hostileArray
    } as never)).toThrow();
    expect(reads).toBe(0);
  });

  it("ignores hidden/symbol carrier metadata and rejects inherited enumerable authority", () => {
    let reads = 0;
    const input: Record<PropertyKey, unknown> = {
      mode: "off",
      scope: DESIGN_AGENT_RUN_SCOPE
    };
    Object.defineProperty(input, "hidden", {
      enumerable: false,
      get: () => {
        reads += 1;
        throw new Error("hidden trap")
      }
    });
    input[Symbol("carrier")] = "ignored";
    expect(createDesignAgentRunBinding(input as never).mode).toBe("off");
    expect(reads).toBe(0);

    const inherited = Object.create({ polluted: true }) as Record<string, unknown>;
    inherited.mode = "off";
    inherited.scope = DESIGN_AGENT_RUN_SCOPE;
    expect(() => createDesignAgentRunBinding(inherited as never)).toThrow();
  });

  it("bounds enumerable authority width before exact-field validation", () => {
    const oversized: Record<string, unknown> = {
      mode: "off",
      scope: DESIGN_AGENT_RUN_SCOPE
    };
    for (let index = 0; index < 4_100; index += 1) oversized[`extra_${index}`] = index;
    expect(() => createDesignAgentRunBinding(oversized as never)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_WORKFLOW_CONTRACT_INPUT_TOO_LARGE" })
    );
  });

  it.each([
    "agents/system_architecture/provider-output.json",
    "Agents/system_architecture/proposal-result.json",
    "agents\\system_architecture\\replay-receipt.json",
    "safe/../agents/system_architecture/validator-handoff.json",
    "./agents/system_architecture/proposal-result.json",
    "/agents/system_architecture/proposal-result.json",
    "agents./system_architecture/proposal-result.json",
    "agents /system_architecture/proposal-result.json",
    "safe/.. /agents./system_architecture/proposal-result.json"
  ])("recognizes reserved namespace variant %s", (logicalName) => {
    expect(isReservedDesignAgentArtifactLogicalName(logicalName)).toBe(true);
  });

  it("does not reserve ordinary artifact paths", () => {
    expect(DESIGN_AGENT_RESERVED_ARTIFACT_PREFIX).toBe("agents/");
    expect(isReservedDesignAgentArtifactLogicalName("architecture/system-architecture.json")).toBe(false);
    expect(isReservedDesignAgentArtifactLogicalName("agents-adjacent/result.json")).toBe(false);
    expect(isReservedDesignAgentArtifactLogicalName(`ordinary/${"x".repeat(241)}`)).toBe(false);
    expect(isReservedDesignAgentArtifactLogicalName(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
  DESIGN_AGENT_LIMITS,
  DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  type DesignAgentTrustAnchors
} from "../../src/agents/contracts.js";
import {
  bindAgentTextDocument,
  bindDesignAgentModel,
  bindDesignAgentSettings
} from "../../src/agents/coordinator.js";
import {
  DESIGN_AGENT_CONTEXT_INVENTORY_LOGICAL_NAME,
  DESIGN_AGENT_REQUIREMENTS_LOGICAL_NAME,
  DESIGN_AGENT_SOURCE_PROMPT_LOGICAL_NAME,
  DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS,
  DESIGN_AGENT_WORKFLOW_SUBJECT_LOGICAL_NAME,
  buildSafeDesignAgentWorkflowInput,
  filterAgentProvenanceFromUpstream,
  isDesignAgentContextArtifactAllowed,
  isReservedDesignAgentArtifactLogicalName
} from "../../src/agents/workflow-context.js";
import {
  DESIGN_AGENT_RUN_SCOPE,
  createDesignAgentRunBinding,
  createDesignAgentStageSubject,
  type DesignAgentProposalRequiredRunBinding,
  type DesignAgentRunBindingInput
} from "../../src/agents/workflow-contracts.js";
import { DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA } from "../../src/agents/production-model-policy.js";
import { DEFAULT_DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY } from "../../src/agents/deterministic-validator-registry.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import { PCB_ENGINEERING_PRACTICE_CATALOG } from "../../src/knowledge/pcb-engineering-practices.js";
import {
  CURRENT_SCHEMATIC_INTENT_SCHEMA,
  LEGACY_SCHEMATIC_INTENT_SCHEMA,
  buildReferenceSchematicIntent
} from "../../src/knowledge/reference-schematic-intent.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../../src/knowledge/reference-controller-native-contract.js";
import {
  CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
  LEGACY_SYSTEM_ARCHITECTURE_SCHEMA,
  REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES,
  buildReferenceSystemArchitecture
} from "../../src/knowledge/reference-system-architecture.js";
import {
  artifactDraft,
  evidenceDraft,
  finalizeStageResult,
  jsonArtifactDraft
} from "../../src/generators/draft-utils.js";
import {
  PCB_LAYOUT_PLAN_SCHEMA,
  buildPcbLayoutPlan
} from "../../src/generators/pcb-layout-plan.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import { STAGE_ORDER, stageIndex, type StageKey } from "../../src/domain/stages.js";
import type { StageExecutionResult } from "../../src/workflow/contracts.js";

const PROMPT = `
Build a two-channel brushed motor controller for a 7-16.8 V DC battery.
Each motor is limited to 0.5 A RMS. Provide USB-C, CAN, UART, I2C, SPI,
two quadrature encoders, and SWD programming.
`;

const INSTRUCTION = bindAgentTextDocument(
  DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
  "Produce proposals only. Preserve every deterministic validation boundary."
);
const SOURCE_PROMPT = bindAgentTextDocument(DESIGN_AGENT_SOURCE_PROMPT_LOGICAL_NAME, PROMPT);
const REQUIREMENTS = {
  ...parseRequirements(PROMPT).document,
  approvalId: "approval_fixture"
} as const;
const REQUIREMENTS_APPROVAL = {
  id: "approval_fixture",
  kind: "requirements" as const,
  projectId: "project_fixture",
  runId: "run_fixture",
  subjectDigest: REQUIREMENTS.identity.digest,
  policyVersion: "policy-v1",
  actor: {
    type: "human" as const,
    id: "reviewer_fixture",
    displayName: "Fixture Reviewer",
    role: "requirements_reviewer" as const
  },
  scope: "Approve the exact parsed requirements for candidate design work.",
  rationale: "Fixture approval for deterministic context tests.",
  createdAt: "2026-09-05T00:00:00.000Z"
};
const MODEL = bindDesignAgentModel({
  provider: "fixture-provider",
  model: "fixture-model",
  version: "2026-09-05"
});
const SETTINGS = bindDesignAgentSettings({
  temperature: 0,
  maximumOutputBytes: DESIGN_AGENT_LIMITS.providerOutputBytes
});
const TRUST_ANCHORS: DesignAgentTrustAnchors = {
  instruction: "instruction-v1",
  practiceCatalog: "pcb-practices-v1",
  provider: "fixture-provider-v1",
  modelFamily: "fixture-model-family-v1",
  outputContract: "proposal-output-v2"
};

const runBindingInput = (
  overrides: Partial<Extract<DesignAgentRunBindingInput, { mode: "proposal_required" }>> = {}
): Extract<DesignAgentRunBindingInput, { mode: "proposal_required" }> => ({
  mode: "proposal_required",
  scope: DESIGN_AGENT_RUN_SCOPE,
  trustManifestId: "fixture-trust-manifest-v1",
  trustManifestIdentity: canonicalIdentity(
    { manifestId: "fixture-trust-manifest-v1" },
    "evleda.design-agent-trust-manifest.v1"
  ),
  trustAnchors: TRUST_ANCHORS,
  instructionIdentity: INSTRUCTION.identity,
  practiceCatalogIdentity: PCB_ENGINEERING_PRACTICE_CATALOG.identity,
  providerIdentity: canonicalIdentity(
    { providerId: "fixture-provider", implementationVersion: "v1" },
    "evleda.design-agent-provider.v1"
  ),
  providerExecutableIdentity: contentIdentity("fixture-provider-executable"),
  modelIdentity: MODEL.identity,
  modelPolicyIdentity: canonicalIdentity(
    { policy: "fixture-model-policy" },
    DESIGN_AGENT_PRODUCTION_MODEL_POLICY_SCHEMA
  ),
  settingsIdentity: SETTINGS.identity,
  validatorRegistryIdentity:
    DEFAULT_DESIGN_AGENT_DETERMINISTIC_VALIDATOR_REGISTRY.snapshot().identity,
  outputContractIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  outputContractBytesIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
  regenerationPolicyIdentity: DESIGN_AGENT_LIVE_REGENERATION_POLICY_IDENTITY,
  ...overrides
});

const makeRunBinding = (
  overrides: Partial<Extract<DesignAgentRunBindingInput, { mode: "proposal_required" }>> = {}
): DesignAgentProposalRequiredRunBinding =>
  createDesignAgentRunBinding(runBindingInput(overrides)) as DesignAgentProposalRequiredRunBinding;

const RUN_BINDING = makeRunBinding();

const exactInput = canonicalIdentity({ fixture: true }, "fixture.input.v1");

const subjectFor = (
  stage: Exclude<StageKey, "requirements"> = "component_selection",
  requirementsIdentity = REQUIREMENTS.identity
) =>
  createDesignAgentStageSubject({
    projectId: "project_fixture",
    runId: "run_fixture",
    designRevisionId: "revision_fixture",
    stage,
    inputManifest: canonicalIdentity({ stage }, `evleda.stage-input.${stage}.v1`),
    provisionIdentity: canonicalIdentity({ stage }, "evleda.stage-provision.v1"),
    provisionManifestBlob: contentIdentity(`provision:${stage}`),
    requirementsIdentity,
    runConfigurationIdentity: canonicalIdentity({ mode: "proposal_required" }, "evleda.run-configuration.v1"),
    workflowVersion: "evleda-workflow-v1"
  });

const architectureArtifact = (extra: Readonly<Record<string, unknown>> = {}) =>
  jsonArtifactDraft({
    logicalName: "architecture/system-architecture.json",
    value: {
      ...buildReferenceSystemArchitecture(ROBOTICS_CONTROLLER_V0),
      ...extra
    },
    exactInputs: [
      exactInput,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
    ],
    validationStatus: "pass"
  });

const unknownArtifact = (secret = "must-not-enter-context") =>
  jsonArtifactDraft({
    logicalName: "diagnostics/unapproved-provider-record.json",
    value: {
      schemaVersion: "fixture.provider-evidence.v1",
      providerEvidence: { apiToken: secret, workspacePath: "C:\\private\\fixture" }
    },
    exactInputs: [exactInput],
    validationStatus: "not_run"
  });

const architectureResult = (
  artifacts = [architectureArtifact(), unknownArtifact()]
): StageExecutionResult<"system_architecture"> =>
  finalizeStageResult("system_architecture", artifacts, [], []);

const minimalPrimaryArtifact = (
  logicalName: string,
  schemaVersion: string,
  validationStatus: "pass" | "not_run" = "pass"
) =>
  jsonArtifactDraft({
    logicalName,
    value: { schemaVersion, fixtureId: logicalName },
    exactInputs: [exactInput],
    validationStatus
  });

const primaryResult = (stage: Exclude<StageKey, "requirements" | "bringup_package">): StageExecutionResult => {
  switch (stage) {
    case "system_architecture":
      return architectureResult();
    case "component_selection":
      return finalizeStageResult(
        stage,
        [minimalPrimaryArtifact("components/selection.json", "evleda.component-selection.v1")],
        [],
        []
      );
    case "schematic":
      return finalizeStageResult(
        stage,
        [
          jsonArtifactDraft({
            logicalName: "schematic/schematic-intent.json",
            value: buildReferenceSchematicIntent(
              ROBOTICS_CONTROLLER_V0,
              REQUIREMENTS.identity.digest,
              "revision_fixture"
            ),
            exactInputs: [exactInput],
            validationStatus: "not_run"
          })
        ],
        [],
        []
      );
    case "firmware_contract":
      return finalizeStageResult(
        stage,
        [
          minimalPrimaryArtifact(
            "firmware/board-contract.json",
            "evleda.firmware-contract.v1"
          )
        ],
        [],
        []
      );
    case "simulation_checks":
      return finalizeStageResult(
        stage,
        [
          minimalPrimaryArtifact(
            "simulation/coverage-plan.json",
            "evleda.simulation-coverage-plan.v1",
            "not_run"
          )
        ],
        [],
        []
      );
    case "pcb_placement_routing":
      return finalizeStageResult(
        stage,
        [
          minimalPrimaryArtifact(
            "pcb/layout-routing-plan.json",
            PCB_LAYOUT_PLAN_SCHEMA,
            "not_run"
          )
        ],
        [],
        []
      );
    case "manufacturing_package":
      return finalizeStageResult(
        stage,
        [
          minimalPrimaryArtifact(
            "manufacturing/manufacturing-plan.json",
            "evleda.manufacturing-plan.v1",
            "not_run"
          )
        ],
        [],
        []
      );
  }
};

const defaultUpstream = (
  targetStage: Exclude<StageKey, "requirements">
): readonly StageExecutionResult[] =>
  STAGE_ORDER.slice(1, stageIndex(targetStage)).map((stage) =>
    primaryResult(stage as Exclude<StageKey, "requirements" | "bringup_package">)
  );

const makeSeed = (
  stage: Exclude<StageKey, "requirements"> = "component_selection",
  upstream: readonly StageExecutionResult[] = defaultUpstream(stage)
) => ({
  subject: subjectFor(stage),
  runBinding: RUN_BINDING,
  instructionDocument: INSTRUCTION,
  trustAnchors: TRUST_ANCHORS,
  sourcePrompt: SOURCE_PROMPT,
  practiceCatalog: PCB_ENGINEERING_PRACTICE_CATALOG,
  model: MODEL,
  settings: SETTINGS,
  requirements: REQUIREMENTS,
  requirementsApproval: REQUIREMENTS_APPROVAL,
  upstreamBindings: upstream
    .filter((result) => result.stage !== "requirements")
    .map((result) => ({ stage: result.stage, outputIdentity: result.outputIdentity })),
  upstream
});

const makeSeedForPrompt = (prompt: string) => {
  const sourcePrompt = bindAgentTextDocument(DESIGN_AGENT_SOURCE_PROMPT_LOGICAL_NAME, prompt);
  const requirements = {
    ...parseRequirements(prompt).document,
    approvalId: "approval_fixture"
  } as const;
  return {
    ...makeSeed(),
    subject: subjectFor("component_selection", requirements.identity),
    sourcePrompt,
    requirements,
    requirementsApproval: {
      ...REQUIREMENTS_APPROVAL,
      subjectDigest: requirements.identity.digest
    }
  };
};

const makeSeedForRequirements = (mutate: (document: Record<string, any>) => void) => {
  const mutable = structuredClone(REQUIREMENTS) as Record<string, any>;
  mutate(mutable);
  const { identity: _identity, approvalId: _approvalId, ...identityPayload } = mutable;
  const requirements = {
    ...identityPayload,
    identity: canonicalIdentity(identityPayload, "evleda.requirements.v1"),
    approvalId: REQUIREMENTS.approvalId
  };
  return {
    ...makeSeed(),
    subject: subjectFor("component_selection", requirements.identity),
    requirements,
    requirementsApproval: {
      ...REQUIREMENTS_APPROVAL,
      subjectDigest: requirements.identity.digest
    }
  };
};

const inventoryValue = (input: ReturnType<typeof buildSafeDesignAgentWorkflowInput>) => {
  const document = input.context.find(
    (entry) => entry.logicalName === DESIGN_AGENT_CONTEXT_INVENTORY_LOGICAL_NAME
  );
  expect(document?.kind).toBe("structured");
  return (document as Extract<(typeof input.context)[number], { kind: "structured" }>).value as any;
};

describe("safe design-agent workflow context", () => {
  it("assembles only the fixed subject, approved requirements, and metadata inventory documents", () => {
    const input = buildSafeDesignAgentWorkflowInput(makeSeed());

    expect(input.stage).toBe("component_selection");
    expect(input.role).toBe("component_engineer");
    expect(input.context.map((entry) => entry.logicalName)).toEqual([
      DESIGN_AGENT_WORKFLOW_SUBJECT_LOGICAL_NAME,
      DESIGN_AGENT_REQUIREMENTS_LOGICAL_NAME,
      DESIGN_AGENT_CONTEXT_INVENTORY_LOGICAL_NAME
    ]);
    expect(input.context[0]).toMatchObject({
      kind: "structured",
      value: {
        projectId: "project_fixture",
        runId: "run_fixture",
        stage: "component_selection"
      }
    });
    const subjectDocument = input.context[0]!;
    expect(subjectDocument.kind).toBe("structured");
    expect(subjectDocument.kind === "structured" ? subjectDocument.value : null).not.toHaveProperty(
      "attemptId"
    );
    expect(input.context[1]).toMatchObject({
      kind: "structured",
      value: {
        schemaVersion: "evleda.requirements.v1",
        identity: REQUIREMENTS.identity,
        requirements: REQUIREMENTS.requirements
      }
    });

    const inventory = inventoryValue(input);
    expect(inventory.runBindingIdentity).toStrictEqual(RUN_BINDING.identity);
    expect(inventory.bindingAssessment).toBe("consistency_only_non_authoritative");
    expect(inventory.requiredAuthority).toBe(
      "application_authenticated_persisted_attempt_bindings_and_approval"
    );
    expect(inventory.requirementsApproval).toEqual({
      id: REQUIREMENTS_APPROVAL.id,
      subjectDigest: REQUIREMENTS_APPROVAL.subjectDigest,
      policyVersion: REQUIREMENTS_APPROVAL.policyVersion
    });
    expect(canonicalJson(inventory)).not.toContain(REQUIREMENTS_APPROVAL.actor.id);
    expect(canonicalJson(inventory)).not.toContain(REQUIREMENTS_APPROVAL.actor.displayName);
    expect(canonicalJson(inventory)).not.toContain(REQUIREMENTS_APPROVAL.rationale);
    expect(inventory.upstream).toHaveLength(1);
    expect(inventory.upstream[0]).toMatchObject({
      stage: "system_architecture",
      outputIdentity: architectureResult().outputIdentity,
      artifacts: [
        {
          logicalName: "architecture/system-architecture.json",
          mediaType: "application/json",
          contextDocument: {
            kind: "structured",
            schemaVersion: CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
            value: {
              schemaVersion: CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
              profileId: "robotics-controller-v0"
            }
          }
        },
        {
          logicalName: "diagnostics/unapproved-provider-record.json",
          mediaType: "application/json"
        }
      ]
    });
    expect(inventory.upstream[0].artifacts[1]).not.toHaveProperty("contextDocument");
    expect(canonicalJson(inventory)).not.toContain("must-not-enter-context");
    expect(canonicalJson(inventory)).not.toContain("providerEvidence");
    expect(canonicalJson(inventory)).not.toContain("C:\\\\private");

    expect(input.referenceIndex.requirementIds).toEqual(
      [...REQUIREMENTS.requirements.map((requirement) => requirement.id)].sort()
    );
    expect(input.referenceIndex.targetIds).toEqual(
      expect.arrayContaining([
        "stage:component_selection",
        "id:protected_input",
        "input:VBAT_PROTECTED",
        "output:VBAT_PROTECTED",
        "artifact:architecture/system-architecture.json",
        "artifact:diagnostics/unapproved-provider-record.json"
      ])
    );
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.context)).toBe(true);
  });

  it("uses an exact per-target-stage artifact allowlist", () => {
    expect(
      isDesignAgentContextArtifactAllowed(
        "component_selection",
        "system_architecture",
        "architecture/system-architecture.json",
        "application/json"
      )
    ).toBe(true);
    expect(
      isDesignAgentContextArtifactAllowed(
        "system_architecture",
        "system_architecture",
        "architecture/system-architecture.json",
        "application/json"
      )
    ).toBe(false);
    expect(
      isDesignAgentContextArtifactAllowed(
        "component_selection",
        "system_architecture",
        "architecture/system-architecture.json",
        "text/markdown"
      )
    ).toBe(false);
    expect(
      isDesignAgentContextArtifactAllowed(
        "component_selection",
        "system_architecture",
        "architecture/other.json",
        "application/json"
      )
    ).toBe(false);
  });

  it("does not reinterpret legacy architecture or schematic-intent artifacts as current context", () => {
    const legacyArchitecture = architectureResult([
      architectureArtifact({ schemaVersion: LEGACY_SYSTEM_ARCHITECTURE_SCHEMA })
    ]);
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [legacyArchitecture])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_SCHEMA_MISMATCH" })
    );

    const legacySchematic = finalizeStageResult(
      "schematic",
      [
        minimalPrimaryArtifact(
          "schematic/schematic-intent.json",
          LEGACY_SCHEMATIC_INTENT_SCHEMA,
          "not_run"
        )
      ],
      [],
      []
    );
    const firmwareUpstream = defaultUpstream("firmware_contract").map((result) =>
      result.stage === "schematic" ? legacySchematic : result
    );
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("firmware_contract", firmwareUpstream)
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_SCHEMA_MISMATCH" })
    );

    const currentIntent = buildReferenceSchematicIntent(
      ROBOTICS_CONTROLLER_V0,
      REQUIREMENTS.identity.digest,
      "revision_fixture"
    );
    const {
      functionalGroups: _functionalGroups,
      nativeContractBinding: _nativeContractBinding,
      schematicStructure: _schematicStructure,
      ...legacyBody
    } = currentIntent;
    const relabelledLegacy = finalizeStageResult(
      "schematic",
      [
        jsonArtifactDraft({
          logicalName: "schematic/schematic-intent.json",
          value: {
            ...legacyBody,
            schemaVersion: CURRENT_SCHEMATIC_INTENT_SCHEMA,
            hierarchicalSheets: [{ name: "root" }]
          },
          exactInputs: [exactInput],
          validationStatus: "not_run"
        })
      ],
      [],
      []
    );
    const relabelledUpstream = defaultUpstream("firmware_contract").map((result) =>
      result.stage === "schematic" ? relabelledLegacy : result
    );
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("firmware_contract", relabelledUpstream)
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_SCHEMA_MISMATCH" })
    );
  });

  it("requires the full current architecture instead of trusting a relabelled minimal v2 object", () => {
    const relabelledMinimal = jsonArtifactDraft({
      logicalName: "architecture/system-architecture.json",
      value: {
        schemaVersion: CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
        profileId: "robotics-controller-v0",
        functionalBlocks: [{ id: "protected_input" }]
      },
      exactInputs: [
        exactInput,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
        REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
      ],
      validationStatus: "pass"
    });
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([relabelledMinimal])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_SCHEMA_MISMATCH" })
    );
  });

  it.each([
    {
      name: "semantic",
      omittedDigest: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY.digest
    },
    {
      name: "content",
      omittedDigest: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.digest
    }
  ])("requires the native-contract $name identity in architecture exactInputs", ({ omittedDigest }) => {
    const artifact = architectureArtifact();
    const missingBinding = {
      ...artifact,
      exactInputs: artifact.exactInputs.filter((identity) => identity.digest !== omittedDigest)
    };
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([missingBinding])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_EXACT_INPUT_MISMATCH" })
    );
  });

  it("enforces the architecture-specific byte cap before identity reproduction", () => {
    const artifact = architectureArtifact();
    const oversized = {
      ...artifact,
      content: new Uint8Array(REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES + 1),
      identity: {
        algorithm: "sha256" as const,
        digest: "0".repeat(64),
        size: REFERENCE_SYSTEM_ARCHITECTURE_MAX_BYTES + 1
      }
    };
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([oversized])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_TOO_LARGE" })
    );
  });

  it.each([
    {
      logicalName: "diagnostics/api_key=private-fixture-token.json",
      mediaType: "application/json"
    },
    {
      logicalName: "diagnostics/unknown.json",
      mediaType: "application/json; api_key=private-fixture-token"
    }
  ])("rejects confidential unknown-artifact metadata", ({ logicalName, mediaType }) => {
    const unknown = artifactDraft({
      logicalName,
      mediaType,
      content: "{}\n",
      exactInputs: [exactInput],
      validationStatus: "not_run"
    });
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([architectureArtifact(), unknown])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_CONFIDENTIAL_INPUT_FORBIDDEN" })
    );
  });

  it("requires exact predecessor order while normalizing artifact inventory order", () => {
    const component = finalizeStageResult(
      "component_selection",
      [
        jsonArtifactDraft({
          logicalName: "components/selection.json",
          value: {
            schemaVersion: "evleda.component-selection.v1",
            components: [{ key: "mcu", selectedPartNumber: "STM32G0B1CET6" }]
          },
          exactInputs: [exactInput],
          validationStatus: "pass"
        })
      ],
      [],
      []
    );
    const architecture = architectureResult([
      unknownArtifact("still-private"),
      architectureArtifact()
    ]);
    expect(() =>
      buildSafeDesignAgentWorkflowInput(makeSeed("schematic", [component, architecture]))
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_UPSTREAM_BINDING_INVALID" })
    );
    const input = buildSafeDesignAgentWorkflowInput(
      makeSeed("schematic", [architecture, component])
    );

    const inventory = inventoryValue(input);
    expect(inventory.upstream.map((entry: any) => entry.stage)).toEqual([
      "system_architecture",
      "component_selection"
    ]);
    expect(inventory.upstream.map((entry: any) => entry.outputIdentity)).toEqual([
      architecture.outputIdentity,
      component.outputIdentity
    ]);
    expect(inventory.upstream[0].artifacts.map((entry: any) => entry.logicalName)).toEqual([
      "architecture/system-architecture.json",
      "diagnostics/unapproved-provider-record.json"
    ]);
  });

  it.each(["attemptId", "stageContext", "providerEvidence", "environment", "contextDocuments"])(
    "rejects undeclared root field %s",
    (field) => {
      expect(() =>
        buildSafeDesignAgentWorkflowInput({ ...makeSeed(), [field]: { injected: true } })
      ).toThrowError(
        expect.objectContaining({ failureCode: "AGENT_CONTEXT_INPUT_UNKNOWN_FIELD" })
      );
    }
  );

  it("rejects accessors without invoking them", () => {
    const seed = makeSeed() as Record<string, unknown>;
    let calls = 0;
    Object.defineProperty(seed, "upstream", {
      enumerable: true,
      get: () => {
        calls += 1;
        return [];
      }
    });

    expect(() => buildSafeDesignAgentWorkflowInput(seed)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_INPUT_ACCESSOR_FORBIDDEN" })
    );
    expect(calls).toBe(0);
  });

  it("ignores never-read hidden and symbol metadata without invoking it", () => {
    const seed = makeSeed() as Record<PropertyKey, unknown>;
    let calls = 0;
    Object.defineProperty(seed, "hiddenMetadata", {
      configurable: true,
      enumerable: false,
      get: () => {
        calls += 1;
        return "must-not-be-read";
      }
    });
    Object.defineProperty(seed, Symbol("symbolMetadata"), {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1;
        return () => "must-not-be-read";
      }
    });
    for (let index = 0; index < 5_000; index += 1) {
      Object.defineProperty(seed, `hidden_${index.toString()}`, {
        enumerable: false,
        value: index
      });
      seed[Symbol(`metadata_${index.toString()}`)] = index;
    }

    const input = buildSafeDesignAgentWorkflowInput(seed);
    expect(input.stage).toBe("component_selection");
    expect(calls).toBe(0);
    expect(canonicalJson(input)).not.toContain("hiddenMetadata");
    expect(canonicalJson(input)).not.toContain("symbolMetadata");
  });

  it("rejects inherited enumerable pollution before reading its value", () => {
    const seed = makeSeed();
    let calls = 0;
    Object.defineProperty(Object.prototype, "inheritedContextBomb", {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1;
        return "must-not-be-read";
      }
    });
    let caught: unknown;
    try {
      try {
        buildSafeDesignAgentWorkflowInput(seed);
      } catch (error) {
        caught = error;
      }
    } finally {
      delete (Object.prototype as Record<string, unknown>).inheritedContextBomb;
    }
    expect(caught).toMatchObject({
      failureCode: "AGENT_CONTEXT_INPUT_INHERITED_ENUMERABLE_FORBIDDEN"
    });
    expect(calls).toBe(0);
  });

  it("rejects an enumerable named-property bomb at the streaming node bound", () => {
    const bomb: Record<string, null> = {};
    for (
      let index = 0;
      index <= DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.inputGraphNodes;
      index += 1
    ) {
      bomb[`field_${index.toString()}`] = null;
    }

    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), namedPropertyBomb: bomb })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_INPUT_NODE_LIMIT_EXCEEDED" })
    );
  });

  it("rejects proxies and functions anywhere in the supplied graph", () => {
    expect(() =>
      buildSafeDesignAgentWorkflowInput({
        ...makeSeed(),
        upstream: new Proxy([architectureResult()], {})
      })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_INPUT_PROXY_FORBIDDEN" })
    );

    const result = architectureResult();
    const unsafeResult = {
      ...result,
      evidence: [
        {
          evidenceClass: "agent_claim",
          claim: "fixture",
          subjectDigests: [],
          exactInputs: [],
          tool: { generate: () => "unsafe" },
          validationStatus: "not_run",
          unresolvedAssumptions: []
        }
      ]
    };
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), upstream: [unsafeResult] })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_INPUT_NON_JSON_VALUE" })
    );
  });

  it.each([
    {
      name: "credential fields",
      extra: { apiToken: "private-token" },
      failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN"
    },
    {
      name: "path fields",
      extra: { workspacePath: "relative/but-private" },
      failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN"
    },
    {
      name: "absolute host paths",
      extra: { opaqueValue: "C:\\Users\\fixture\\private.json" },
      failureCode: "AGENT_CONTEXT_ABSOLUTE_PATH_FORBIDDEN"
    },
    {
      name: "secret assignments under an innocuous key",
      extra: { note: "api-key = private-fixture-token" },
      failureCode: "AGENT_CONTEXT_CONFIDENTIAL_INPUT_FORBIDDEN"
    },
    {
      name: "embedded host paths under an innocuous key",
      extra: { note: "Read C:\\Users\\fixture\\private.json" },
      failureCode: "AGENT_CONTEXT_CONFIDENTIAL_INPUT_FORBIDDEN"
    },
    {
      name: "provider, model, physical, or base64 carrier fields",
      extra: {
        providerEvidence: { summary: "opaque provider material" },
        rawProviderResponse: "opaque response",
        physicalEvidence: "opaque physical record",
        bytesBase64: "QUJDRA=="
      },
      failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN"
    }
  ])("rejects $name in otherwise allowlisted content", ({ extra, failureCode }) => {
    const result = architectureResult([architectureArtifact(extra)]);
    expect(() => buildSafeDesignAgentWorkflowInput(makeSeed("component_selection", [result]))).toThrowError(
      expect.objectContaining({ failureCode })
    );
  });

  it.each([
    "externalProviderEvidence",
    "capturedPhysicalEvidence",
    "imageBase64",
    "payloadBase64",
    "Authorization"
  ])("rejects unrestricted evidence/blob carrier key variant %s", (key) => {
    const result = architectureResult([
      architectureArtifact({ [key]: "opaque-fixture-material" })
    ]);
    expect(() =>
      buildSafeDesignAgentWorkflowInput(makeSeed("component_selection", [result]))
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN" })
    );
  });

  it.each([
    `${PROMPT}\napi_key = sk-fixture-secret-value`,
    `${PROMPT}\napi_token = fixture-secret-value`,
    `${PROMPT}\ntoken = fixture-secret-value`,
    `${PROMPT}\nopenai_api_key = fixture-secret-value`,
    `${PROMPT}\nAuthorization: Bearer fixture.token.value`,
    `${PROMPT}\nAuthorization: Basic dXNlcjpwYXNz`,
    `${PROMPT}\n-----BEGIN PRIVATE KEY-----`,
    `${PROMPT}\nRead C:\\Users\\pc\\private\\board.json`,
    `${PROMPT}\nRead \\\\server\\share\\private.json`,
    `${PROMPT}\nRead \\Users\\pc\\private\\board.json`,
    `${PROMPT}\nRead \\private\\board.json`,
    `${PROMPT}\nRead \\secret`,
    `${PROMPT}\nRead /tmp`,
    `${PROMPT}\nRead /home/fixture/private.json`,
    `${PROMPT}\nRead file:///C:/Users/pc/private.json`
  ])("rejects confidential source-prompt material without echoing it", (prompt) => {
    expect(() => buildSafeDesignAgentWorkflowInput(makeSeedForPrompt(prompt))).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_CONFIDENTIAL_INPUT_FORBIDDEN" })
    );
  });

  it("does not reject ordinary security terminology or engineering slash notation", () => {
    const prompt = `${PROMPT}
Use token-based accounting and authorization logic. Basic motor control remains candidate-only.
Authorization: required before release.
release authorization: required.
token = disabled.
Verify 0.5 A RMS/channel.`;
    expect(buildSafeDesignAgentWorkflowInput(makeSeedForPrompt(prompt)).stage).toBe(
      "component_selection"
    );
  });

  it.each([
    "api_key = nested-fixture-secret",
    "Use C:\\Users\\pc\\private\\requirements.json",
    "Use \\Users\\pc\\private\\requirements.json",
    "Use /etc/passwd"
  ])("rejects confidential material nested only in requirements: %s", (value) => {
    const seed = makeSeedForRequirements((document) => {
      document.constraints.confidential_fixture = value;
    });
    expect(() => buildSafeDesignAgentWorkflowInput(seed)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_CONFIDENTIAL_INPUT_FORBIDDEN" })
    );
  });

  it.each([
    {
      value: {
        temperature: 0,
        maximumOutputBytes: DESIGN_AGENT_LIMITS.providerOutputBytes,
        APIKey: "private-fixture-token"
      },
      failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN"
    },
    {
      value: {
        temperature: 0,
        maximumOutputBytes: DESIGN_AGENT_LIMITS.providerOutputBytes,
        environment: { HOME: "C:\\Users\\pc" }
      },
      failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN"
    },
    {
      value: {
        temperature: 0,
        maximumOutputBytes: DESIGN_AGENT_LIMITS.providerOutputBytes,
        credentialValue: "private-fixture-token"
      },
      failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN"
    },
    {
      value: {
        temperature: 0,
        maximumOutputBytes: DESIGN_AGENT_LIMITS.providerOutputBytes,
        note: "Read C:\\Users\\pc\\private\\settings.json"
      },
      failureCode: "AGENT_CONTEXT_CONFIDENTIAL_INPUT_FORBIDDEN"
    }
  ])("rejects confidential or non-closed provider settings", ({ value, failureCode }) => {
    const settings = bindDesignAgentSettings(value);
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), settings })
    ).toThrowError(expect.objectContaining({ failureCode }));
  });

  it("requires exact, valid UTF-8 canonical JSON bytes for allowlisted artifact content", () => {
    const value = {
      schemaVersion: CURRENT_SYSTEM_ARCHITECTURE_SCHEMA,
      functionalBlocks: [{ id: "controller" }]
    };
    const nonCanonicalText = JSON.stringify(value, null, 2);
    const nonCanonical = artifactDraft({
      logicalName: "architecture/system-architecture.json",
      mediaType: "application/json",
      content: nonCanonicalText,
      exactInputs: [exactInput],
      validationStatus: "pass"
    });
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([nonCanonical])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_NOT_CANONICAL" })
    );

    const invalidUtf8 = artifactDraft({
      logicalName: "architecture/system-architecture.json",
      mediaType: "application/json",
      content: Uint8Array.from([0xff, 0xfe]),
      exactInputs: [exactInput],
      validationStatus: "pass"
    });
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([invalidUtf8])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_UTF8_INVALID" })
    );

    const valid = architectureArtifact();
    const rebound = { ...valid, identity: contentIdentity("different") };
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([rebound])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_IDENTITY_MISMATCH" })
    );
  });

  it("rejects producing-tool metadata inconsistent with the closed context descriptor", () => {
    const artifact = {
      ...architectureArtifact(),
      tool: {
        name: "caller-supplied-generator",
        version: "1.0.0",
        adapter: "external" as const,
        capabilityProfile: "robotics-controller-v0"
      }
    };
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [architectureResult([artifact])])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_DESCRIPTOR_MISMATCH" })
    );
  });

  it("copies allowlisted bytes without invoking an instance Symbol.iterator getter", () => {
    const artifact = architectureArtifact();
    let calls = 0;
    Object.defineProperty(artifact.content, Symbol.iterator, {
      configurable: true,
      get: () => {
        calls += 1;
        return function* unsafeIterator() {
          yield 0;
        };
      }
    });

    const input = buildSafeDesignAgentWorkflowInput(
      makeSeed("component_selection", [architectureResult([artifact])])
    );
    expect(input.stage).toBe("component_selection");
    expect(calls).toBe(0);
  });

  it("accepts the real PCB layout plan's return-path and engineering-authorization fields", () => {
    const pcbPlan = jsonArtifactDraft({
      logicalName: "pcb/layout-routing-plan.json",
      value: buildPcbLayoutPlan(ROBOTICS_CONTROLLER_V0),
      exactInputs: [exactInput],
      validationStatus: "not_run"
    });
    const upstream = [...defaultUpstream("manufacturing_package")];
    upstream[upstream.length - 1] = finalizeStageResult(
      "pcb_placement_routing",
      [pcbPlan],
      [],
      []
    );

    const input = buildSafeDesignAgentWorkflowInput(makeSeed("manufacturing_package", upstream));
    const inventory = canonicalJson(inventoryValue(input));
    expect(inventory).toContain("returnPathPolicy");
    expect(inventory).toContain("exceptionAuthorization");
  });

  it("rejects oversized instruction bytes rather than truncating them", () => {
    const oversized = bindAgentTextDocument(
      DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
      "x".repeat(DESIGN_AGENT_LIMITS.instructionBytes + 1)
    );
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), instructionDocument: oversized })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_TEXT_DOCUMENT_TOO_LARGE" })
    );
  });

  it.each([
    "C:\\Users\\pc\\source-prompt.txt",
    "workflow/api_key=private-fixture-token.txt"
  ])("requires the fixed safe source-prompt logical name", (logicalName) => {
    const sourcePrompt = bindAgentTextDocument(logicalName, PROMPT);
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), sourcePrompt })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_TEXT_DOCUMENT_INVALID" })
    );
  });

  it("requires the requirements, source prompt, and stable subject to share exact identities", () => {
    const otherPrompt = bindAgentTextDocument(
      DESIGN_AGENT_SOURCE_PROMPT_LOGICAL_NAME,
      `${PROMPT}\nAdd Ethernet.`
    );
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), sourcePrompt: otherPrompt })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_SOURCE_PROMPT_MISMATCH" })
    );

    const wrongSubject = createDesignAgentStageSubject({
      projectId: "project_fixture",
      runId: "run_fixture",
      designRevisionId: "revision_fixture",
      stage: "component_selection",
      inputManifest: canonicalIdentity({ changed: true }, "evleda.stage-input.component_selection.v1"),
      provisionIdentity: canonicalIdentity({ changed: true }, "evleda.stage-provision.v1"),
      provisionManifestBlob: contentIdentity("different-provision"),
      requirementsIdentity: canonicalIdentity({ wrong: true }, "evleda.requirements.v1"),
      runConfigurationIdentity: canonicalIdentity({ mode: "proposal_required" }, "evleda.run-configuration.v1"),
      workflowVersion: "evleda-workflow-v1"
    });
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), subject: wrongSubject })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_SUBJECT_REQUIREMENTS_MISMATCH" })
    );
  });

  it("requires approved requirements and an exact proposal-required run binding", () => {
    const { approvalId: _approvalId, ...unapproved } = REQUIREMENTS;
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), requirements: unapproved })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_REQUIRED" })
    );

    const mismatchedModelBinding = makeRunBinding({
      modelIdentity: canonicalIdentity(
        { provider: "fixture-provider", model: "other-model", version: "2026-09-05" },
        "evleda.design-agent-model.v1"
      )
    });
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), runBinding: mismatchedModelBinding })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_RUN_BINDING_MISMATCH" })
    );

    const offBinding = createDesignAgentRunBinding({ mode: "off", scope: DESIGN_AGENT_RUN_SCOPE });
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), runBinding: offBinding })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_RUN_BINDING_REQUIRED" })
    );
  });

  it.each([
    {
      approval: {
        ...REQUIREMENTS_APPROVAL,
        actor: { ...REQUIREMENTS_APPROVAL.actor, role: "hardware_qualifier" as const }
      },
      failureCode: "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_INVALID"
    },
    {
      approval: { ...REQUIREMENTS_APPROVAL, runId: "another_run" },
      failureCode: "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_INVALID"
    },
    {
      approval: { ...REQUIREMENTS_APPROVAL, subjectDigest: "b".repeat(64) },
      failureCode: "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_MISMATCH"
    },
    {
      approval: {
        ...REQUIREMENTS_APPROVAL,
        revokedAt: "2026-09-05T01:00:00.000Z"
      },
      failureCode: "AGENT_CONTEXT_REQUIREMENTS_APPROVAL_INVALID"
    }
  ])("rejects a spoofed, mismatched, or revoked requirements approval", ({ approval, failureCode }) => {
    expect(() =>
      buildSafeDesignAgentWorkflowInput({ ...makeSeed(), requirementsApproval: approval })
    ).toThrowError(expect.objectContaining({ failureCode }));
  });

  it("rejects sensitive requirements keys even without assignment-shaped values", () => {
    const seed = makeSeedForRequirements((document) => {
      document.constraints.APIKey = "private-fixture-token";
    });
    expect(() => buildSafeDesignAgentWorkflowInput(seed)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_SENSITIVE_FIELD_FORBIDDEN" })
    );
  });

  it("requires every prior candidate stage to have succeeded", () => {
    const blockedArchitecture: StageExecutionResult<"system_architecture"> = {
      ...architectureResult(),
      executionStatus: "blocked"
    };
    expect(() =>
      buildSafeDesignAgentWorkflowInput(
        makeSeed("component_selection", [blockedArchitecture])
      )
    ).toThrowError(expect.objectContaining({ failureCode: "AGENT_CONTEXT_UPSTREAM_INVALID" }));

    expect(() =>
      buildSafeDesignAgentWorkflowInput(makeSeed("schematic", [architectureResult()]))
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_UPSTREAM_BINDING_INVALID" })
    );
  });

  it("reproduces each upstream result and compares it with the separate host binding", () => {
    const valid = architectureResult([architectureArtifact()]);
    const tampered = {
      ...valid,
      artifacts: [{ ...valid.artifacts[0]!, validationStatus: "not_run" as const }]
    };
    expect(() =>
      buildSafeDesignAgentWorkflowInput(makeSeed("component_selection", [tampered]))
    ).toThrowError(
      expect.objectContaining({
        failureCode: "AGENT_CONTEXT_UPSTREAM_OUTPUT_IDENTITY_MISMATCH"
      })
    );

    const seed = makeSeed("component_selection", [valid]);
    expect(() =>
      buildSafeDesignAgentWorkflowInput({
        ...seed,
        upstreamBindings: [
          {
            stage: "system_architecture",
            outputIdentity: canonicalIdentity(
              { persistedAttempt: "different" },
              "evleda.stage-result.system_architecture.v1"
            )
          }
        ]
      })
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_UPSTREAM_BINDING_MISMATCH" })
    );
  });

  it("rejects an internally consistent succeeded predecessor without its primary artifact", () => {
    const noPrimary = architectureResult([unknownArtifact("not-included")]);
    expect(() =>
      buildSafeDesignAgentWorkflowInput(makeSeed("component_selection", [noPrimary]))
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_PRIMARY_ARTIFACT_REQUIRED" })
    );
  });
});

describe("agent provenance downstream filtering", () => {
  it.each([
    "agents/system_architecture/proposal-result.json",
    "Agents/system_architecture/proposal-result.json",
    "agents\\system_architecture\\proposal-result.json",
    "safe/../agents/system_architecture/proposal-result.json",
    "./agents/system_architecture/proposal-result.json"
  ])("recognizes reserved namespace variant %s", (logicalName) => {
    expect(isReservedDesignAgentArtifactLogicalName(logicalName)).toBe(true);
  });

  it("removes reserved artifacts and their links while retaining the composite output identity", () => {
    const ordinary = architectureArtifact();
    const proposal = jsonArtifactDraft({
      logicalName: "agents/system_architecture/proposal-result.json",
      value: { schemaVersion: "evleda.design-agent-result.v2", narrative: "untrusted prose" },
      exactInputs: [exactInput],
      validationStatus: "not_run"
    });
    const evidence = [
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "proposal bytes",
        subjectDigests: [proposal.identity.digest],
        rawArtifactLogicalName: proposal.logicalName,
        exactInputs: [exactInput],
        validationStatus: "not_run"
      }),
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "digest-linked proposal",
        subjectDigests: [proposal.identity.digest],
        exactInputs: [exactInput],
        validationStatus: "not_run"
      }),
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim: "direct dangling link must not survive",
        subjectDigests: [ordinary.identity.digest],
        parsedArtifactLogicalName: proposal.logicalName,
        exactInputs: [exactInput],
        validationStatus: "pass"
      }),
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim: "a non-agent digest reference remains metadata-only",
        subjectDigests: [proposal.identity.digest],
        exactInputs: [exactInput],
        validationStatus: "pass"
      }),
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "an unrelated deterministic advisory remains",
        subjectDigests: [ordinary.identity.digest],
        exactInputs: [exactInput],
        validationStatus: "not_run"
      })
    ];
    const result = finalizeStageResult(
      "system_architecture",
      [ordinary, proposal],
      evidence,
      []
    );
    const originalIdentity = result.outputIdentity;
    const projection = filterAgentProvenanceFromUpstream(result);
    const filtered = projection.result;
    const expected = finalizeStageResult(
      "system_architecture",
      [ordinary],
      [evidence[4]!],
      []
    );

    expect(projection.sourceCompositeOutputIdentity).toStrictEqual(originalIdentity);
    expect(filtered.outputIdentity).toStrictEqual(expected.outputIdentity);
    expect(filtered.outputIdentity.digest).not.toBe(originalIdentity.digest);
    expect(filtered.artifacts.map((artifact) => artifact.logicalName)).toEqual([
      ordinary.logicalName
    ]);
    expect(filtered.evidence.map((entry) => entry.claim)).toEqual([
      "an unrelated deterministic advisory remains"
    ]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.evidence).toHaveLength(5);
    expect(projection.identity).toStrictEqual(
      canonicalIdentity(
        {
          schemaVersion: "evleda.design-agent-filtered-upstream.v1",
          sourceCompositeOutputIdentity: originalIdentity,
          filteredOutputIdentity: filtered.outputIdentity
        },
        "evleda.design-agent-filtered-upstream.v1"
      )
    );
  });

  it("returns a detached frozen result even when no application-owned provenance exists", () => {
    const result = architectureResult([architectureArtifact()]);
    const projection = filterAgentProvenanceFromUpstream(result);
    const filtered = projection.result;
    const originalFirstByte = filtered.artifacts[0]!.content[0];
    result.artifacts[0]!.content[0] = (originalFirstByte ?? 0) ^ 0xff;
    (result.artifacts[0] as { logicalName: string }).logicalName = "mutated/after-filter.json";

    expect(filtered).not.toBe(result);
    expect(projection.sourceCompositeOutputIdentity).toStrictEqual(result.outputIdentity);
    expect(filtered).toStrictEqual({
      ...architectureResult([architectureArtifact()]),
      artifacts: [architectureArtifact()]
    });
    expect(filtered.artifacts[0]!.logicalName).toBe("architecture/system-architecture.json");
    expect(filtered.artifacts[0]!.content[0]).toBe(originalFirstByte);
    expect(Object.isFrozen(filtered)).toBe(true);
    expect(Object.isFrozen(filtered.artifacts)).toBe(true);
    expect(Object.isFrozen(filtered.artifacts[0])).toBe(true);
  });

  it("rejects a forged original output identity before filtering", () => {
    const result = architectureResult([architectureArtifact()]);
    const forged = {
      ...result,
      outputIdentity: canonicalIdentity(
        { forged: true },
        "evleda.stage-result.system_architecture.v1"
      )
    };
    expect(() => filterAgentProvenanceFromUpstream(forged)).toThrowError(
      expect.objectContaining({
        failureCode: "AGENT_CONTEXT_UPSTREAM_OUTPUT_IDENTITY_MISMATCH"
      })
    );
  });

  it("rejects unknown evidence classes and retained content-identity substitution", () => {
    const artifact = architectureArtifact();
    const unknownEvidence = {
      ...evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "fixture",
        subjectDigests: [artifact.identity.digest],
        exactInputs: [exactInput],
        validationStatus: "not_run"
      }),
      evidenceClass: "provider_pass"
    };
    const unknownClassResult = finalizeStageResult(
      "system_architecture",
      [artifact],
      [unknownEvidence as any],
      []
    );
    expect(() => filterAgentProvenanceFromUpstream(unknownClassResult)).toThrowError(
      expect.objectContaining({
        failureCode: "AGENT_CONTEXT_UPSTREAM_EVIDENCE_CLASS_INVALID"
      })
    );

    const replacedBytes = {
      ...artifact,
      content: Uint8Array.from([1, 2, 3, 4])
    };
    const substituted = finalizeStageResult(
      "system_architecture",
      [replacedBytes],
      [],
      []
    );
    expect(() => filterAgentProvenanceFromUpstream(substituted)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_ARTIFACT_IDENTITY_MISMATCH" })
    );
  });

  it("drops oversized reserved bytes before copying and ignores hidden binary metadata", () => {
    const reserved = artifactDraft({
      logicalName: "agents/system_architecture/provider-output.json",
      mediaType: "application/json",
      content: new Uint8Array(
        DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.retainedArtifactBytes + 1
      ),
      exactInputs: [exactInput],
      validationStatus: "not_run"
    });
    const hiddenBytes = new Uint8Array(1024);
    let hiddenIteratorCalls = 0;
    Object.defineProperty(hiddenBytes, Symbol.iterator, {
      configurable: true,
      get: () => {
        hiddenIteratorCalls += 1;
        return function* hiddenIterator() {
          yield 0;
        };
      }
    });
    Object.defineProperty(reserved, "hiddenBytes", {
      enumerable: false,
      value: hiddenBytes
    });
    const result = finalizeStageResult("system_architecture", [reserved], [], []);
    const filtered = filterAgentProvenanceFromUpstream(result).result;

    expect(filtered.artifacts).toEqual([]);
    expect(hiddenIteratorCalls).toBe(0);
  });

  it("rejects retained per-artifact and aggregate binary excess before any copy", () => {
    const tooLarge = artifactDraft({
      logicalName: "diagnostics/too-large.bin",
      mediaType: "application/octet-stream",
      content: new Uint8Array(
        DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.retainedArtifactBytes + 1
      ),
      exactInputs: [exactInput],
      validationStatus: "not_run"
    });
    expect(() =>
      filterAgentProvenanceFromUpstream(
        finalizeStageResult("system_architecture", [tooLarge], [], [])
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_CONTEXT_RETAINED_ARTIFACT_TOO_LARGE" })
    );

    const sharedContent = new Uint8Array(
      DESIGN_AGENT_WORKFLOW_CONTEXT_LIMITS.retainedArtifactBytes
    );
    const base = artifactDraft({
      logicalName: "diagnostics/chunk-0.bin",
      mediaType: "application/octet-stream",
      content: sharedContent,
      exactInputs: [exactInput],
      validationStatus: "not_run"
    });
    const artifacts = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      logicalName: `diagnostics/chunk-${index.toString()}.bin`
    }));
    const result = finalizeStageResult("system_architecture", artifacts, [], []);
    let caught: unknown;
    try {
      filterAgentProvenanceFromUpstream(result);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      failureCode: "AGENT_CONTEXT_RETAINED_ARTIFACT_AGGREGATE_TOO_LARGE"
    });
  });

  it("does not invoke shadowed array iteration methods", () => {
    const artifact = architectureArtifact();
    const linked = evidenceDraft({
      evidenceClass: "agent_claim",
      claim: "ordinary advisory",
      subjectDigests: [artifact.identity.digest],
      exactInputs: [exactInput],
      validationStatus: "not_run"
    });
    const result = finalizeStageResult("system_architecture", [artifact], [linked], []);
    let calls = 0;
    for (const [array, key] of [
      [result.artifacts, "entries"],
      [result.evidence, "filter"],
      [result.evidence[0]!.subjectDigests, "some"]
    ] as const) {
      Object.defineProperty(array, key, {
        configurable: true,
        enumerable: false,
        get: () => {
          calls += 1;
          throw new Error("shadowed method must not be read");
        }
      });
    }
    const filtered = filterAgentProvenanceFromUpstream(result).result;
    expect(filtered.artifacts).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it("uses captured typed-array intrinsics after prototype mutation", () => {
    const result = architectureResult([architectureArtifact()]);
    const originalSet = Uint8Array.prototype.set;
    let calls = 0;
    Object.defineProperty(Uint8Array.prototype, "set", {
      configurable: true,
      writable: true,
      value: () => {
        calls += 1;
        throw new Error("mutated typed-array prototype must not execute");
      }
    });
    let filtered: StageExecutionResult | undefined;
    try {
      filtered = filterAgentProvenanceFromUpstream(result).result;
    } finally {
      Object.defineProperty(Uint8Array.prototype, "set", {
        configurable: true,
        writable: true,
        value: originalSet
      });
    }
    expect(filtered?.artifacts).toHaveLength(1);
    expect(calls).toBe(0);
  });
});

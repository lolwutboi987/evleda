import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as agentExports from "../../src/agents/index.js";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { STAGE_ORDER } from "../../src/domain/stages.js";
import { PCB_ENGINEERING_PRACTICE_CATALOG } from "../../src/knowledge/pcb-engineering-practices.js";
import {
  DESIGN_AGENT_CATALOG_LOGICAL_NAME,
  DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
  DESIGN_AGENT_LIMITS,
  DESIGN_AGENT_LIVE_REGENERATION_POLICY,
  DESIGN_AGENT_PROPOSAL_KINDS_BY_ROLE,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
  DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
  DESIGN_AGENT_PROPOSAL_SCHEMA,
  DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA,
  DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA,
  DESIGN_AGENT_REPLAY_SCHEMA,
  DESIGN_AGENT_RESULT_SCHEMA,
  DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
  DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA,
  DESIGN_AGENT_ROLE_BY_STAGE,
  DESIGN_AGENT_ROLE_OBJECTIVES,
  DESIGN_AGENT_VALIDATOR_IDS_BY_ROLE,
  DesignAgentCoordinator,
  assertProductionDesignAgentCoordinatorPrerequisites,
  bindAgentStructuredDocument,
  bindAgentTextDocument,
  bindDesignAgentModel,
  bindDesignAgentProvider,
  bindDesignAgentReferenceIndex,
  bindDesignAgentSettings,
  bindDesignAgentTrustManifest,
  buildDesignAgentPromptPack,
  createInMemoryDesignAgentReplayReceiptStoreForTest,
  createInMemoryDesignAgentTrustStoreForTest,
  type DesignAgentPort,
  type DesignAgentCoordinatorPrerequisites,
  type DesignAgentProviderRequest,
  type DesignAgentReplayReceiptStore,
  type DesignAgentRunInput,
  type FrozenDesignAgentReplay
} from "../../src/agents/index.js";

const INSTRUCTION_PATH = fileURLToPath(
  new URL("../../docs/agent-pcb-design-instructions.md", import.meta.url)
);
const INSTRUCTION_TEXT = await readFile(INSTRUCTION_PATH, "utf8");

const validProposal = (request: DesignAgentProviderRequest): Record<string, unknown> => ({
  schemaVersion: DESIGN_AGENT_PROPOSAL_SCHEMA,
  structuredProposal: {
    schemaVersion: DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA,
    stage: request.promptPack.stage,
    role: request.promptPack.role,
    classification: "proposal_only",
    authorityDisposition: "none",
    proposals: [
      {
        id: "proposal_route_01",
        kind: "routing",
        outcomeClaim: "none",
        targetIds: ["USB_DP", "USB_DM", "VBAT_PROTECTED"],
        sourceRequirementIds: ["req_usb", "req_power"],
        practiceIds: [
          "pcb.trace.hot-resistance-voltage-drop-i2r",
          "pcb.stackup.exact-fabricator-capability-binding"
        ]
      }
    ],
    assumptions: [
      {
        id: "assumption_stackup",
        severity: "blocking",
        sourceRequirementIds: ["req_usb"]
      }
    ],
    questions: [
      {
        id: "question_fab",
        blocking: true,
        sourceRequirementIds: ["req_usb"]
      }
    ],
    validatorRequests: [
      {
        validatorId: "evleda.pcb-practice-analyzer.v1",
        targetIds: ["USB_DP", "USB_DM", "VBAT_PROTECTED"]
      }
    ]
  },
  untrustedNarrative: {
    schemaVersion: DESIGN_AGENT_UNTRUSTED_NARRATIVE_SCHEMA,
    classification: "agent_claim",
    disposition: "display_and_audit_only_never_authority",
    summary: "Propose a compact, source-bound routing plan and preserve unresolved checks.",
    proposalDetails: [
      {
        proposalId: "proposal_route_01",
        title: "Constrain critical routes",
        proposedChange:
          "Route the declared pair and power loops from the bound schematic-layout contract.",
        rationale: "The exact practice catalog requires explicit geometry and return-path checks.",
        risks: ["Stackup and fabricator impedance confirmation remain unresolved."]
      }
    ],
    assumptionDetails: [
      {
        assumptionId: "assumption_stackup",
        statement: "The final fabricated impedance stackup is not yet selected."
      }
    ],
    questionDetails: [
      {
        questionId: "question_fab",
        question: "Which exact fabrication service and stackup revision should be bound?"
      }
    ],
    validatorRequestDetails: [
      {
        validatorId: "evleda.pcb-practice-analyzer.v1",
        reason: "Only the deterministic analyzer and native KiCad tools can evaluate the proposal."
      }
    ],
    limitations: ["Deterministic and physical checks remain outside this proposal."]
  }
});

const validResponse = (
  request: DesignAgentProviderRequest,
  rawOutput = JSON.stringify(validProposal(request))
) => ({
  schemaVersion: DESIGN_AGENT_PROVIDER_RESPONSE_SCHEMA,
  requestIdentity: request.requestIdentity,
  promptPackIdentity: request.promptPack.identity,
  providerIdentity: request.provider.identity,
  modelIdentity: request.promptPack.model.identity,
  settingsIdentity: request.promptPack.settings.identity,
  outputContractIdentity: request.promptPack.outputContract.canonicalIdentity,
  outputContractBytesIdentity: request.promptPack.outputContract.identity,
  stage: request.promptPack.stage,
  role: request.promptPack.role,
  rawOutput
});

const FIXTURE_PROVIDER = bindDesignAgentProvider({
  providerId: "fixture-provider",
  implementationVersion: "1.0.0"
});

const FIXTURE_TRUST_ANCHORS = Object.freeze({
  instruction: "instruction-main",
  practiceCatalog: "catalog-main",
  provider: "provider-fixture",
  modelFamily: "model-family-fixture",
  outputContract: "output-contract-current"
});

const FIXTURE_TRUST_MANIFEST = bindDesignAgentTrustManifest({
  manifestId: "fixture-trust-manifest",
  instructions: [
    {
      anchor: FIXTURE_TRUST_ANCHORS.instruction,
      logicalName: DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
      identity: contentIdentity(INSTRUCTION_TEXT)
    }
  ],
  practiceCatalogs: [
    {
      anchor: FIXTURE_TRUST_ANCHORS.practiceCatalog,
      logicalName: DESIGN_AGENT_CATALOG_LOGICAL_NAME,
      identity: PCB_ENGINEERING_PRACTICE_CATALOG.identity
    }
  ],
  providers: [
    {
      anchor: FIXTURE_TRUST_ANCHORS.provider,
      providerId: FIXTURE_PROVIDER.providerId,
      identity: FIXTURE_PROVIDER.identity
    }
  ],
  modelFamilies: [
    {
      anchor: FIXTURE_TRUST_ANCHORS.modelFamily,
      providerAnchor: FIXTURE_TRUST_ANCHORS.provider,
      family: "fixture-family",
      modelIds: ["fixture-model"]
    }
  ],
  outputContracts: [
    {
      anchor: FIXTURE_TRUST_ANCHORS.outputContract,
      logicalName: "schemas/design-agent-proposal-output-contract.v2.json",
      bytesIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
      canonicalIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
    }
  ]
});

const makePort = (
  responder: (request: DesignAgentProviderRequest) => unknown = (request) => validResponse(request)
): DesignAgentPort & { readonly generate: ReturnType<typeof vi.fn> } => {
  const generate = vi.fn(async (request: DesignAgentProviderRequest) => responder(request));
  return {
    provider: FIXTURE_PROVIDER,
    generate
  };
};

const makeCoordinator = (
  port: DesignAgentPort = makePort(),
  trustManifest = FIXTURE_TRUST_MANIFEST,
  replayReceipts: DesignAgentReplayReceiptStore =
    createInMemoryDesignAgentReplayReceiptStoreForTest()
): DesignAgentCoordinator =>
  new DesignAgentCoordinator(
    port,
    {
      deploymentMode: "test_or_development",
      trustManifestId: trustManifest.manifestId,
      trustStore: createInMemoryDesignAgentTrustStoreForTest([trustManifest]),
      replayReceiptStore: replayReceipts
    }
  );

const makeInput = async (): Promise<DesignAgentRunInput> => {
  return {
    stage: "pcb_placement_routing",
    role: "pcb_layout_engineer",
    instructionDocument: bindAgentTextDocument(
      DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
      INSTRUCTION_TEXT
    ),
    trustAnchors: FIXTURE_TRUST_ANCHORS,
    sourcePrompt: bindAgentTextDocument(
      "prompt/source.txt",
      "Design a low-voltage controller and preserve every unresolved PCB engineering gate."
    ),
    practiceCatalogLogicalName: DESIGN_AGENT_CATALOG_LOGICAL_NAME,
    practiceCatalog: PCB_ENGINEERING_PRACTICE_CATALOG,
    model: bindDesignAgentModel({
      provider: "fixture-provider",
      model: "fixture-model",
      version: "2026-09-05"
    }),
    settings: bindDesignAgentSettings({
      temperature: 0,
      maximumOutputBytes: DESIGN_AGENT_LIMITS.providerOutputBytes
    }),
    referenceIndex: bindDesignAgentReferenceIndex({
      requirementIds: ["req_usb", "req_power"],
      targetIds: ["USB_DP", "USB_DM", "VBAT_PROTECTED"]
    }),
    context: [
      bindAgentStructuredDocument(
        "requirements/approved.json",
        "evleda.requirements-fixture.v1",
        { requirementsDigest: "a".repeat(64), approved: true }
      ),
      bindAgentTextDocument(
        "schematic/layout-contract.txt",
        "USB_DP/USB_DM are a declared pair; deterministic geometry validation is required."
      )
    ]
  };
};

describe("DesignAgentCoordinator", () => {
  it("defines one bounded specialist role and objective for each of the nine workflow stages", () => {
    expect(STAGE_ORDER).toHaveLength(9);
    expect(Object.keys(DESIGN_AGENT_ROLE_BY_STAGE)).toEqual([...STAGE_ORDER]);
    expect(new Set(Object.values(DESIGN_AGENT_ROLE_BY_STAGE)).size).toBe(9);
    for (const stage of STAGE_ORDER) {
      const role = DESIGN_AGENT_ROLE_BY_STAGE[stage];
      expect(DESIGN_AGENT_ROLE_OBJECTIVES[role].length).toBeGreaterThan(40);
    }
  });

  it("binds every prompt-pack input and labels a live result as traceable agent proposal only", async () => {
    const port = makePort();
    const input = await makeInput();
    const execution = await makeCoordinator(port).execute(input);

    expect(port.generate).toHaveBeenCalledTimes(1);
    expect(execution.mode).toBe("live_traceable");
    expect(execution.result).toMatchObject({
      stage: input.stage,
      role: input.role,
      classification: "proposal_only",
      evidenceClass: "agent_claim",
      validationDisposition: "not_evaluated",
      instructionIdentity: input.instructionDocument.identity,
      trustManifestIdentity: FIXTURE_TRUST_MANIFEST.identity,
      trustAnchors: FIXTURE_TRUST_ANCHORS,
      sourcePromptIdentity: input.sourcePrompt.identity,
      practiceCatalogIdentity: input.practiceCatalog.identity,
      providerIdentity: FIXTURE_PROVIDER.identity,
      modelIdentity: input.model.identity,
      settingsIdentity: input.settings.identity,
      regenerationPolicy: DESIGN_AGENT_LIVE_REGENERATION_POLICY,
      validatorHandoff: {
        required: true,
        state: "pending",
        authority: "deterministic_validators_and_native_tools_only"
      }
    });
    expect(execution.result).not.toHaveProperty("lifecycle");
    expect(execution.result).not.toHaveProperty("releaseAuthorized");
    expect(execution.replay.request.promptPack.exactInputs).toEqual([
      input.instructionDocument.identity,
      input.sourcePrompt.identity,
      input.practiceCatalog.identity,
      input.model.identity,
      input.settings.identity,
      input.referenceIndex.identity,
      FIXTURE_TRUST_MANIFEST.identity,
      FIXTURE_PROVIDER.identity,
      DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
      DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY,
      ...execution.replay.request.promptPack.context.map((entry) => entry.identity)
    ]);
    expect(execution.result.rawOutputIdentity).toEqual(
      contentIdentity(execution.replay.response.rawOutput)
    );
    expect(execution.result.structuredProposal.schemaVersion).toBe(
      DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA
    );
    expect(execution.result.structuredProposalIdentity.schemaVersion).toBe(
      execution.result.structuredProposal.schemaVersion
    );
    expect(execution.result.untrustedNarrativeIdentity.schemaVersion).toBe(
      execution.result.untrustedNarrative.schemaVersion
    );
    expect(
      (DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT.runtimeSchema as Record<string, any>)
        .properties.structuredProposal.properties.schemaVersion.const
    ).toBe(DESIGN_AGENT_STRUCTURED_PROPOSAL_SCHEMA);
    expect(execution.replay.request.promptPack.outputContract).toEqual({
      logicalName: "schemas/design-agent-proposal-output-contract.v2.json",
      mediaType: "application/schema+json",
      content: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES,
      identity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY,
      canonicalIdentity: DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY
    });
    expect(execution.replay.schemaVersion).toBe(DESIGN_AGENT_REPLAY_SCHEMA);
    expect(execution.replayReceipt.replayIdentity).toStrictEqual(execution.replay.identity);
    expect(execution.replayReceipt.trustManifestIdentity).toStrictEqual(
      FIXTURE_TRUST_MANIFEST.identity
    );
  });

  it.each([
    {
      name: "a forged deterministic pass",
      mutate: (proposal: Record<string, any>) => {
        proposal.validationStatus = "pass";
      }
    },
    {
      name: "a forged manufacturing release",
      mutate: (proposal: Record<string, any>) => {
        proposal.structuredProposal.proposals[0].releaseAuthorized = true;
      }
    },
    {
      name: "a forged evidence class",
      mutate: (proposal: Record<string, any>) => {
        proposal.evidenceClass = "kicad_native";
      }
    }
  ])("rejects $name anywhere in model output", async ({ mutate }) => {
    const port = makePort((request) => {
      const proposal = validProposal(request) as Record<string, any>;
      mutate(proposal);
      return validResponse(request, JSON.stringify(proposal));
    });

    await expect(makeCoordinator(port).execute(await makeInput())).rejects.toMatchObject({
      failureCode: "AGENT_AUTHORITY_FIELD_FORBIDDEN",
      code: "TOOL_RESULT_INCONCLUSIVE"
    });
  });

  it("requires the exact instruction-document identity", async () => {
    const input = structuredClone(await makeInput()) as Record<string, any>;
    delete input.instructionDocument.identity;
    const port = makePort();

    await expect(
      makeCoordinator(port).execute(input as DesignAgentRunInput)
    ).rejects.toMatchObject({
      failureCode: "AGENT_INSTRUCTION_IDENTITY_REQUIRED"
    });
    expect(port.generate).not.toHaveBeenCalled();
  });

  it("recomputes captured instruction bytes against both embedded and trusted identities", async () => {
    const input = structuredClone(await makeInput()) as Record<string, any>;
    input.instructionDocument.content += "\nforged after binding";
    const port = makePort();

    await expect(makeCoordinator(port).execute(input)).rejects.toMatchObject({
      failureCode: "AGENT_INSTRUCTION_IDENTITY_MISMATCH",
      code: "INVALID_ARGUMENT"
    });
    expect(port.generate).not.toHaveBeenCalled();
  });

  it("rejects oversized provider output before JSON parsing", async () => {
    const port = makePort((request) =>
      validResponse(request, "x".repeat(DESIGN_AGENT_LIMITS.providerOutputBytes + 1))
    );

    await expect(makeCoordinator(port).execute(await makeInput())).rejects.toMatchObject({
      failureCode: "AGENT_OUTPUT_TOO_LARGE",
      code: "TOOL_RESULT_INCONCLUSIVE"
    });
  });

  it("rejects malformed and schema-invalid provider output", async () => {
    const malformed = makePort((request) => validResponse(request, "{"));
    await expect(
      makeCoordinator(malformed).execute(await makeInput())
    ).rejects.toMatchObject({ failureCode: "AGENT_OUTPUT_MALFORMED" });

    const invalid = makePort((request) =>
      validResponse(
        request,
        JSON.stringify({
          schemaVersion: DESIGN_AGENT_PROPOSAL_SCHEMA,
          stage: request.promptPack.stage,
          role: request.promptPack.role,
          classification: "proposal_only"
        })
      )
    );
    await expect(
      makeCoordinator(invalid).execute(await makeInput())
    ).rejects.toMatchObject({ failureCode: "AGENT_OUTPUT_SCHEMA_INVALID" });
  });

  it("rejects role/stage mismatches before and after the provider boundary", async () => {
    const input = { ...(await makeInput()), role: "system_architect" as const };
    const neverCalled = makePort();
    await expect(makeCoordinator(neverCalled).execute(input)).rejects.toMatchObject({
      failureCode: "AGENT_STAGE_ROLE_MISMATCH",
      code: "INVALID_ARGUMENT"
    });
    expect(neverCalled.generate).not.toHaveBeenCalled();

    const mismatchedResponse = makePort((request) => ({
      ...validResponse(request),
      role: "system_architect"
    }));
    await expect(
      makeCoordinator(mismatchedResponse).execute(await makeInput())
    ).rejects.toMatchObject({ failureCode: "AGENT_STAGE_ROLE_MISMATCH" });
  });

  it("rejects frozen replay against different exact prompt inputs", async () => {
    const port = makePort();
    const coordinator = makeCoordinator(port);
    const input = await makeInput();
    const execution = await coordinator.execute(input);
    const changed = {
      ...input,
      sourcePrompt: bindAgentTextDocument(
        input.sourcePrompt.logicalName,
        `${input.sourcePrompt.content}\nChange the supply envelope.`
      )
    };

    await expect(
      coordinator.replay(execution.replay, {
        receiptId: execution.replayReceipt.receiptId,
        input: changed
      })
    ).rejects.toMatchObject({
        failureCode: "AGENT_REPLAY_RECEIPT_INVALID",
        code: "DIGEST_MISMATCH"
      });
  });

  it("rejects instruction bytes not pinned by the constructor trust manifest", async () => {
    const port = makePort();
    const coordinator = makeCoordinator(port);
    const input = await makeInput();
    const live = await coordinator.execute(input);
    const amendedInput: DesignAgentRunInput = {
      ...input,
      instructionDocument: bindAgentTextDocument(
        DESIGN_AGENT_INSTRUCTION_LOGICAL_NAME,
        `${input.instructionDocument.content}\n\nAmended instruction: preserve this new exact byte binding.\n`
      )
    };

    expect(amendedInput.instructionDocument.identity).not.toStrictEqual(
      input.instructionDocument.identity
    );
    expect(() => buildDesignAgentPromptPack(amendedInput, FIXTURE_TRUST_MANIFEST)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_INSTRUCTION_IDENTITY_MISMATCH" })
    );
    await expect(
      coordinator.replay(live.replay, {
        receiptId: live.replayReceipt.receiptId,
        input: amendedInput
      })
    ).rejects.toMatchObject({ failureCode: "AGENT_INSTRUCTION_IDENTITY_MISMATCH" });
    expect(port.generate).toHaveBeenCalledTimes(1);
  });

  it("detects a forged replay result even if the outer replay identity is recomputed", async () => {
    const coordinator = makeCoordinator(makePort());
    const input = await makeInput();
    const execution = await coordinator.execute(input);
    const tampered = structuredClone(execution.replay) as Record<string, any>;
    tampered.result.evidenceClass = "evleda_check";
    tampered.identity = canonicalIdentity(
      {
        schemaVersion: tampered.schemaVersion,
        request: tampered.request,
        response: tampered.response,
        result: tampered.result
      },
      DESIGN_AGENT_REPLAY_SCHEMA
    );

    await expect(
      coordinator.replay(tampered as FrozenDesignAgentReplay, {
        receiptId: execution.replayReceipt.receiptId,
        input
      })
    ).rejects.toMatchObject({ failureCode: "AGENT_REPLAY_MISMATCH" });
  });

  it("reconstructs an exact frozen result without another provider call", async () => {
    const port = makePort();
    const coordinator = makeCoordinator(port);
    const input = await makeInput();
    const live = await coordinator.execute(input);
    const replayed = await coordinator.replay(live.replay, {
      receiptId: live.replayReceipt.receiptId,
      input
    });

    expect(port.generate).toHaveBeenCalledTimes(1);
    expect(replayed.mode).toBe("frozen_exact_replay");
    expect(replayed.result).toStrictEqual(live.result);
    expect(replayed.replayIdentity).toStrictEqual(live.replay.identity);
    expect(replayed.result.identity).toStrictEqual(live.result.identity);
  });

  it.each([
    {
      name: "accessor",
      expectedFailure: "AGENT_INPUT_ACCESSOR_FORBIDDEN",
      mutate: (input: Record<string, unknown>, observed: { count: number }) => {
        Object.defineProperty(input, "stage", {
          configurable: true,
          enumerable: true,
          get: () => {
            observed.count += 1;
            return "pcb_placement_routing";
          }
        });
      }
    },
    {
      name: "non-enumerable field",
      expectedFailure: "AGENT_INPUT_NON_ENUMERABLE_FORBIDDEN",
      mutate: (input: Record<string, unknown>) => {
        Object.defineProperty(input, "hidden", { enumerable: false, value: true });
      }
    },
    {
      name: "symbol field",
      expectedFailure: "AGENT_INPUT_SYMBOL_KEY_FORBIDDEN",
      mutate: (input: Record<string, unknown>) => {
        input[Symbol("hidden") as unknown as string] = true;
      }
    },
    {
      name: "cycle",
      expectedFailure: "AGENT_INPUT_CYCLE_FORBIDDEN",
      mutate: (input: Record<string, unknown>) => {
        input.cycle = input;
      }
    }
  ])("rejects a plain-input $name before provider execution", async ({ mutate, expectedFailure }) => {
    const input = (await makeInput()) as unknown as Record<string, unknown>;
    const observed = { count: 0 };
    mutate(input, observed);
    const port = makePort();

    await expect(makeCoordinator(port).execute(input)).rejects.toMatchObject({
      failureCode: expectedFailure,
      code: "INVALID_ARGUMENT"
    });
    expect(observed.count).toBe(0);
    expect(port.generate).not.toHaveBeenCalled();
  });

  it("rejects proxy and unknown-field inputs without consulting the provider", async () => {
    const input = await makeInput();
    let reads = 0;
    const proxy = new Proxy(input, {
      get: () => {
        reads += 1;
        throw new Error("proxy trap must not run");
      }
    });
    const proxyPort = makePort();
    await expect(makeCoordinator(proxyPort).execute(proxy)).rejects.toMatchObject({
      failureCode: "AGENT_INPUT_PROXY_FORBIDDEN"
    });
    expect(reads).toBe(0);
    expect(proxyPort.generate).not.toHaveBeenCalled();

    const unknownPort = makePort();
    await expect(
      makeCoordinator(unknownPort).execute({ ...input, undeclared: true })
    ).rejects.toMatchObject({ failureCode: "AGENT_INPUT_UNKNOWN_FIELD" });
    expect(unknownPort.generate).not.toHaveBeenCalled();
  });

  it("does not invoke provider-port or provider-response getters", async () => {
    let portGetterCalls = 0;
    const accessorPort: Record<string, unknown> = {
      generate: async () => undefined
    };
    Object.defineProperty(accessorPort, "provider", {
      enumerable: true,
      get: () => {
        portGetterCalls += 1;
        return FIXTURE_PROVIDER;
      }
    });
    expect(() => makeCoordinator(accessorPort as unknown as DesignAgentPort)).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_PROVIDER_PORT_INVALID" })
    );
    expect(portGetterCalls).toBe(0);

    let responseGetterCalls = 0;
    const responsePort = makePort((request) => {
      const response = validResponse(request) as Record<string, unknown>;
      Object.defineProperty(response, "rawOutput", {
        configurable: true,
        enumerable: true,
        get: () => {
          responseGetterCalls += 1;
          return JSON.stringify(validProposal(request));
        }
      });
      return response;
    });
    await expect(
      makeCoordinator(responsePort).execute(await makeInput())
    ).rejects.toMatchObject({
      failureCode: "AGENT_PROVIDER_RESPONSE_ACCESSOR_FORBIDDEN",
      code: "TOOL_RESULT_INCONCLUSIVE"
    });
    expect(responseGetterCalls).toBe(0);
  });

  it("captures the run input before awaiting the provider", async () => {
    let releaseProvider!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const port = makePort(async (request) => {
      await gate;
      return validResponse(request);
    });
    const input = await makeInput();
    const expectedSourceIdentity = input.sourcePrompt.identity;
    const pending = makeCoordinator(port).execute(input);
    (input as unknown as { sourcePrompt: unknown }).sourcePrompt = bindAgentTextDocument(
      "prompt/source.txt",
      "A caller mutation after execution began must not enter the provider request."
    );
    releaseProvider();

    const execution = await pending;
    expect(execution.result.sourcePromptIdentity).toStrictEqual(expectedSourceIdentity);
  });

  it("rejects document depth, node, and aggregate byte excess before canonicalization", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index <= DESIGN_AGENT_LIMITS.documentGraphDepth; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    expect(() =>
      bindAgentStructuredDocument("context/deep.json", "fixture.deep.v1", deep)
    ).toThrowError(expect.objectContaining({ failureCode: "AGENT_DOCUMENT_DEPTH_EXCEEDED" }));

    expect(() =>
      bindAgentStructuredDocument(
        "context/nodes.json",
        "fixture.nodes.v1",
        Array.from({ length: DESIGN_AGENT_LIMITS.documentGraphNodes }, () => null)
      )
    ).toThrowError(expect.objectContaining({ failureCode: "AGENT_DOCUMENT_NODE_LIMIT_EXCEEDED" }));

    const chunkBytes = Math.floor(DESIGN_AGENT_LIMITS.totalContextBytes / 5) + 1;
    expect(() =>
      bindAgentStructuredDocument(
        "context/bytes.json",
        "fixture.bytes.v1",
        Array.from({ length: 5 }, () => "x".repeat(chunkBytes))
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_DOCUMENT_AGGREGATE_BYTE_LIMIT_EXCEEDED" })
    );
  });

  it("rejects duplicate JSON members before schema validation", async () => {
    const port = makePort((request) => {
      const raw = JSON.stringify(validProposal(request)).replace(
        /^\{/u,
        `{"schemaVersion":"${DESIGN_AGENT_PROPOSAL_SCHEMA}",`
      );
      return validResponse(request, raw);
    });
    await expect(makeCoordinator(port).execute(await makeInput())).rejects.toMatchObject({
      failureCode: "AGENT_OUTPUT_DUPLICATE_MEMBER",
      code: "TOOL_RESULT_INCONCLUSIVE"
    });
  });

  it("rejects obvious authority language as a defense-in-depth filter", async () => {
    const port = makePort((request) => {
      const proposal = validProposal(request) as Record<string, any>;
      proposal.untrustedNarrative.proposalDetails[0].risks = [
        "The proposed route is verified and passed native DRC."
      ];
      return validResponse(request, JSON.stringify(proposal));
    });
    await expect(makeCoordinator(port).execute(await makeInput())).rejects.toMatchObject({
      failureCode: "AGENT_AUTHORITY_LANGUAGE_FORBIDDEN",
      code: "TOOL_RESULT_INCONCLUSIVE"
    });
  });

  it.each([
    ["deterministic checks succeeded", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.summary = text;
    }],
    ["ready for fab", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.proposalDetails[0].title = text;
    }],
    ["ready for fabrication", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.proposalDetails[0].proposedChange = text;
    }],
    ["ready for manufacturing", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.proposalDetails[0].rationale = text;
    }],
    ["conforms to every requirement", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.proposalDetails[0].risks = [text];
    }],
    ["may ship", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.questionDetails[0].question = text;
    }],
    ["DRC_PASSES", (proposal: Record<string, any>, text: string) => {
      proposal.structuredProposal.proposals[0].targetIds = [text];
    }],
    ["approval granted", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.limitations = [text];
    }],
    ["waiver accepted", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.assumptionDetails[0].statement = text;
    }],
    ["validated for production", (proposal: Record<string, any>, text: string) => {
      proposal.untrustedNarrative.proposalDetails[0].risks = [text];
    }]
  ])("rejects semantic authority assertion %s in any string/target", async (text, mutate) => {
    const port = makePort((request) => {
      const proposal = validProposal(request) as Record<string, any>;
      mutate(proposal, text);
      return validResponse(request, JSON.stringify(proposal));
    });
    await expect(makeCoordinator(port).execute(await makeInput())).rejects.toMatchObject({
      failureCode: "AGENT_AUTHORITY_LANGUAGE_FORBIDDEN",
      code: "TOOL_RESULT_INCONCLUSIVE"
    });
  });

  it("quarantines undetected authority-like prose from every structured decision surface", async () => {
    const baseline = await makeCoordinator(makePort()).execute(await makeInput());
    const phrases = [
      "All checks are green.",
      "Every requirement is fulfilled.",
      "The board has no errors.",
      "Gerbers can go to fabrication."
    ];

    for (const phrase of phrases) {
      const port = makePort((request) => {
        const proposal = validProposal(request) as Record<string, any>;
        proposal.untrustedNarrative.summary = phrase;
        return validResponse(request, JSON.stringify(proposal));
      });
      const execution = await makeCoordinator(port).execute(await makeInput());

      expect(execution.result.untrustedNarrative).toMatchObject({
        classification: "agent_claim",
        disposition: "display_and_audit_only_never_authority",
        summary: phrase
      });
      expect(execution.result.structuredProposal).not.toHaveProperty("summary");
      expect(execution.result.structuredProposal).not.toHaveProperty("untrustedNarrative");
      expect(execution.result.structuredProposalIdentity).toStrictEqual(
        baseline.result.structuredProposalIdentity
      );
      expect(execution.result.validatorHandoff).toStrictEqual(
        baseline.result.validatorHandoff
      );
      expect(execution.result.validationDisposition).toBe("not_evaluated");
      expect(execution.result.validatorHandoff.requestedValidators[0]).toEqual({
        validatorId: "evleda.pcb-practice-analyzer.v1",
        targetIds: ["USB_DP", "USB_DM", "VBAT_PROTECTED"]
      });
    }
  });

  it("keeps the mutable proposal schema private behind a captured validator", async () => {
    expect(agentExports).not.toHaveProperty("designAgentProposalSchema");
    expect(agentExports).not.toHaveProperty("designAgentProposalItemSchema");
    expect(Object.isFrozen(agentExports.validateDesignAgentProposal)).toBe(true);
    expect(Object.isFrozen(DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT.runtimeSchema)).toBe(true);

    const port = makePort((request) => {
      const invalid = validProposal(request) as Record<string, any>;
      delete invalid.structuredProposal.authorityDisposition;
      return validResponse(request, JSON.stringify(invalid));
    });
    await expect(makeCoordinator(port).execute(await makeInput())).rejects.toMatchObject({
      failureCode: "AGENT_OUTPUT_SCHEMA_INVALID"
    });
  });

  it.each([
    {
      expectedFailure: "AGENT_PROPOSAL_KIND_FORBIDDEN",
      mutate: (proposal: Record<string, any>) => {
        proposal.structuredProposal.proposals[0].kind = "architecture";
      }
    },
    {
      expectedFailure: "AGENT_VALIDATOR_NOT_ALLOWED",
      mutate: (proposal: Record<string, any>) => {
        proposal.structuredProposal.validatorRequests[0].validatorId =
          "evleda.requirements-validator.v1";
      }
    },
    {
      expectedFailure: "AGENT_TARGET_REFERENCE_INVALID",
      mutate: (proposal: Record<string, any>) => {
        proposal.structuredProposal.proposals[0].targetIds = ["UNBOUND_TARGET"];
      }
    },
    {
      expectedFailure: "AGENT_REQUIREMENT_REFERENCE_INVALID",
      mutate: (proposal: Record<string, any>) => {
        proposal.structuredProposal.proposals[0].sourceRequirementIds = [
          "unbound_requirement"
        ];
      }
    },
    {
      expectedFailure: "AGENT_PRACTICE_REFERENCE_INVALID",
      mutate: (proposal: Record<string, any>) => {
        proposal.structuredProposal.proposals[0].practiceIds = ["unbound.practice"];
      }
    }
  ])("enforces the closed semantic maps ($expectedFailure)", async ({ mutate, expectedFailure }) => {
    const port = makePort((request) => {
      const proposal = validProposal(request) as Record<string, any>;
      mutate(proposal);
      return validResponse(request, JSON.stringify(proposal));
    });
    await expect(makeCoordinator(port).execute(await makeInput())).rejects.toMatchObject({
      failureCode: expectedFailure,
      code: "TOOL_RESULT_INCONCLUSIVE"
    });
  });

  it("uses only constructor-pinned trust roots and model families", async () => {
    const input = await makeInput();
    const injectionPort = makePort();
    await expect(
      makeCoordinator(injectionPort).execute({
        ...input,
        trustedPracticeCatalogIdentity: input.practiceCatalog.identity
      })
    ).rejects.toMatchObject({ failureCode: "AGENT_INPUT_UNKNOWN_FIELD" });
    expect(injectionPort.generate).not.toHaveBeenCalled();

    const forgedCatalog = structuredClone(input.practiceCatalog) as Record<string, any>;
    forgedCatalog.limitations = [...forgedCatalog.limitations, "Locally self-minted catalog."];
    const { identity: _discardedIdentity, ...forgedCatalogPayload } = forgedCatalog;
    forgedCatalog.identity = canonicalIdentity(
      forgedCatalogPayload,
      input.practiceCatalog.schemaVersion
    );
    const catalogPort = makePort();
    await expect(
      makeCoordinator(catalogPort).execute({
        ...input,
        practiceCatalog: forgedCatalog
      })
    ).rejects.toMatchObject({ failureCode: "AGENT_CATALOG_INVALID" });
    expect(catalogPort.generate).not.toHaveBeenCalled();

    const modelPort = makePort();
    await expect(
      makeCoordinator(modelPort).execute({
        ...input,
        model: bindDesignAgentModel({
          provider: "fixture-provider",
          model: "self-minted-model",
          version: "2026-09-05"
        })
      })
    ).rejects.toMatchObject({ failureCode: "AGENT_MODEL_FAMILY_NOT_ALLOWED" });
    expect(modelPort.generate).not.toHaveBeenCalled();

    const anchorPort = makePort();
    await expect(
      makeCoordinator(anchorPort).execute({
        ...input,
        trustAnchors: { ...input.trustAnchors, provider: "caller-minted-provider-anchor" }
      })
    ).rejects.toMatchObject({ failureCode: "AGENT_TRUST_ANCHOR_NOT_FOUND" });
    expect(anchorPort.generate).not.toHaveBeenCalled();
  });

  it("fails production construction unless trust and receipt stores declare production authority", async () => {
    const testTrustStore = createInMemoryDesignAgentTrustStoreForTest([
      FIXTURE_TRUST_MANIFEST
    ]);
    const testReceipts = createInMemoryDesignAgentReplayReceiptStoreForTest();
    const rejectedPrerequisites = {
      deploymentMode: "production" as const,
      trustManifestId: FIXTURE_TRUST_MANIFEST.manifestId,
      trustStore: testTrustStore,
      replayReceiptStore: testReceipts
    };
    expect(() =>
      assertProductionDesignAgentCoordinatorPrerequisites(rejectedPrerequisites)
    ).toThrowError(
      expect.objectContaining({
        failureCode: "AGENT_PRODUCTION_TRUST_PREREQUISITE_REQUIRED",
        code: "POLICY_DENIED"
      })
    );
    expect(() =>
      new DesignAgentCoordinator(
        makePort(),
        rejectedPrerequisites as unknown as DesignAgentCoordinatorPrerequisites
      )
    ).toThrowError(
      expect.objectContaining({ failureCode: "AGENT_PRODUCTION_TRUST_PREREQUISITE_REQUIRED" })
    );

    const productionTrustStore = {
      authority: "authenticated_production" as const,
      resolve: (manifestId: string) => testTrustStore.resolve(manifestId)
    };
    const productionReceipts = {
      authority: "durable_append_only_production" as const,
      append: async (receipt: Parameters<typeof testReceipts.append>[0]) =>
        await testReceipts.append(receipt),
      resolve: async (receiptId: string) => await testReceipts.resolve(receiptId)
    };
    const productionPrerequisites = {
      deploymentMode: "production" as const,
      trustManifestId: FIXTURE_TRUST_MANIFEST.manifestId,
      trustStore: productionTrustStore,
      replayReceiptStore: productionReceipts
    };
    expect(() =>
      assertProductionDesignAgentCoordinatorPrerequisites(productionPrerequisites)
    ).not.toThrow();
    const execution = await new DesignAgentCoordinator(
      makePort(),
      productionPrerequisites
    ).execute(await makeInput());
    expect(execution.replayReceipt.trustManifestIdentity).toStrictEqual(
      FIXTURE_TRUST_MANIFEST.identity
    );
  });

  it("requires a receipt from the constructor-injected append-only replay store", async () => {
    const coordinator = makeCoordinator(makePort());
    const input = await makeInput();
    const live = await coordinator.execute(input);

    await expect(
      coordinator.replay(live.replay, { receiptId: "caller_minted_receipt", input })
    ).rejects.toMatchObject({
      failureCode: "AGENT_REPLAY_RECEIPT_NOT_FOUND",
      code: "DIGEST_MISMATCH"
    });
    await expect(
      (coordinator.replay as unknown as (replay: unknown) => Promise<unknown>)(live.replay)
    ).rejects.toMatchObject({ failureCode: "AGENT_REPLAY_EXPECTATION_REQUIRED" });

    await expect(
      makeCoordinator(makePort()).replay(live.replay, {
        receiptId: live.replayReceipt.receiptId,
        input
      })
    ).rejects.toMatchObject({ failureCode: "AGENT_REPLAY_RECEIPT_NOT_FOUND" });

    await expect(
      coordinator.replay(
        { ...live.replay, undeclared: true },
        { receiptId: live.replayReceipt.receiptId, input }
      )
    ).rejects.toMatchObject({ failureCode: "AGENT_REPLAY_MISMATCH" });
  });

  it("does not overwrite an append-only replay receipt with a conflicting binding", async () => {
    const receipts = createInMemoryDesignAgentReplayReceiptStoreForTest();
    const coordinator = makeCoordinator(makePort(), FIXTURE_TRUST_MANIFEST, receipts);
    const live = await coordinator.execute(await makeInput());
    const tampered = structuredClone(live.replayReceipt) as Record<string, any>;
    tampered.promptPackIdentity = canonicalIdentity(
      { callerMinted: true },
      live.replayReceipt.promptPackIdentity.schemaVersion
    );
    const { identity: _discarded, ...payload } = tampered;
    tampered.identity = canonicalIdentity(payload, DESIGN_AGENT_REPLAY_RECEIPT_SCHEMA);

    await expect(receipts.append(tampered as typeof live.replayReceipt)).rejects.toMatchObject({
      failureCode: "AGENT_REPLAY_RECEIPT_CONFLICT",
      code: "DIGEST_MISMATCH"
    });
    const replayed = await coordinator.replay(live.replay, {
      receiptId: live.replayReceipt.receiptId,
      input: await makeInput()
    });
    expect(replayed.receiptIdentity).toStrictEqual(live.replayReceipt.identity);
  });

  it("snapshots replay and expectation before awaiting a delayed receipt resolver", async () => {
    const backing = createInMemoryDesignAgentReplayReceiptStoreForTest();
    let enterResolve!: () => void;
    const resolverEntered = new Promise<void>((resolve) => {
      enterResolve = resolve;
    });
    let releaseResolve!: () => void;
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const delayedReceipts: DesignAgentReplayReceiptStore = {
      authority: "in_memory_test_or_development_only",
      append: async (receipt) => await backing.append(receipt),
      resolve: async (receiptId) => {
        enterResolve();
        await resolverGate;
        return await backing.resolve(receiptId);
      }
    };
    const coordinator = makeCoordinator(makePort(), FIXTURE_TRUST_MANIFEST, delayedReceipts);
    const input = await makeInput();
    const live = await coordinator.execute(input);
    const mutableReplay = structuredClone(live.replay) as Record<string, any>;
    mutableReplay.response.rawOutput = "{}";
    mutableReplay.result.rawOutputIdentity = contentIdentity("{}");
    const { identity: _oldResultIdentity, ...resultPayload } = mutableReplay.result;
    mutableReplay.result.identity = canonicalIdentity(resultPayload, DESIGN_AGENT_RESULT_SCHEMA);
    const { identity: _oldReplayIdentity, ...replayPayload } = mutableReplay;
    mutableReplay.identity = canonicalIdentity(replayPayload, DESIGN_AGENT_REPLAY_SCHEMA);

    const pendingReplay = coordinator.replay(mutableReplay, {
      receiptId: live.replayReceipt.receiptId,
      input
    });
    await resolverEntered;
    Object.assign(mutableReplay, structuredClone(live.replay));
    releaseResolve();

    await expect(pendingReplay).rejects.toMatchObject({
      failureCode: "AGENT_REPLAY_MISMATCH",
      code: "DIGEST_MISMATCH"
    });
  });

  it("deep-freezes exported role maps, output descriptors, and execution records", async () => {
    const deeplyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
      if (typeof value !== "object" || value === null) return true;
      if (seen.has(value)) return true;
      if (!Object.isFrozen(value)) return false;
      seen.add(value);
      return Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (descriptor) => !("value" in descriptor) || deeplyFrozen(descriptor.value, seen)
      );
    };
    const execution = await makeCoordinator(makePort()).execute(await makeInput());
    expect(deeplyFrozen(DESIGN_AGENT_ROLE_BY_STAGE)).toBe(true);
    expect(deeplyFrozen(DESIGN_AGENT_ROLE_OBJECTIVES)).toBe(true);
    expect(deeplyFrozen(DESIGN_AGENT_PROPOSAL_KINDS_BY_ROLE)).toBe(true);
    expect(deeplyFrozen(DESIGN_AGENT_VALIDATOR_IDS_BY_ROLE)).toBe(true);
    expect(deeplyFrozen(DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT)).toBe(true);
    expect(deeplyFrozen(DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_BYTES_IDENTITY)).toBe(true);
    expect(deeplyFrozen(DESIGN_AGENT_PROPOSAL_OUTPUT_CONTRACT_IDENTITY)).toBe(true);
    expect(deeplyFrozen(FIXTURE_TRUST_MANIFEST)).toBe(true);
    expect(deeplyFrozen(execution.replayReceipt)).toBe(true);
    expect(deeplyFrozen(execution)).toBe(true);
  });
});

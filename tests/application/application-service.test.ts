import { access, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { MCP_CONTEXT, localHumanContext } from "../../src/contracts/capabilities.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { artifactDraft, finalizeStageResult } from "../../src/generators/draft-utils.js";
import type { StageKey } from "../../src/domain/stages.js";
import type { ContentIdentity } from "../../src/domain/types.js";
import type { EvlEdaState, MutableEvlEdaState } from "../../src/persistence/state-store.js";
import type { ContentStorePort, StateStorePort } from "../../src/application/ports.js";
import type {
  StageContextByKey,
  StageExecutionResult,
  StageRegistryContract
} from "../../src/workflow/contracts.js";
import {
  submitExternalEvidenceInputSchema,
  type SubmitExternalEvidenceInput
} from "../../src/contracts/operations.js";
import {
  bundleManifestSchema,
  externalEvidenceResultSchema,
  operationResultSchemas
} from "../../src/contracts/results.js";
import {
  createApprovedRun,
  createCompletedRun,
  disposeApplicationRoots,
  fixtureRegistry,
  makeApplication,
  physicalEvidenceInput,
  qualifier,
  reviewer,
  validPrompt
} from "./helpers.js";

afterEach(disposeApplicationRoots);

class BeforeTransactionStateStore implements StateStorePort {
  readonly root: string;
  #beforeTransaction: ((state: MutableEvlEdaState) => void | Promise<void>) | undefined;

  public constructor(private readonly base: StateStorePort) {
    this.root = base.root;
  }

  public arm(beforeTransaction: (state: MutableEvlEdaState) => void | Promise<void>): void {
    this.#beforeTransaction = beforeTransaction;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public read(): Promise<EvlEdaState> {
    return this.base.read();
  }

  public transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    const beforeTransaction = this.#beforeTransaction;
    this.#beforeTransaction = undefined;
    return this.base.transaction(expectedRevision, async (state) => {
      await beforeTransaction?.(state);
      return mutate(state);
    });
  }
}

class OneShotFaultingContentStore implements ContentStorePort {
  readonly root: string;
  #remainingCalls: number | undefined;
  readonly #inFlight = new Set<Promise<unknown>>();

  public constructor(private readonly base: ContentStorePort) {
    this.root = base.root;
  }

  public arm(relativeCall: number): void {
    this.#remainingCalls = relativeCall;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public async put(bytes: Uint8Array | string, expected?: ContentIdentity): Promise<ContentIdentity> {
    this.#trip();
    const pending = this.base.put(bytes, expected);
    this.#inFlight.add(pending);
    try {
      return await pending;
    } finally {
      this.#inFlight.delete(pending);
    }
  }

  public async settle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  public putJson(value: unknown): Promise<ContentIdentity> {
    return this.put(`${canonicalJson(value)}\n`);
  }

  public get(identity: ContentIdentity): Promise<Buffer> {
    return this.base.get(identity);
  }

  public verify(identity: ContentIdentity): Promise<boolean> {
    return this.base.verify(identity);
  }

  #trip(): void {
    if (this.#remainingCalls === undefined) return;
    this.#remainingCalls -= 1;
    if (this.#remainingCalls === 0) {
      this.#remainingCalls = undefined;
      throw new Error("simulated content publication failure");
    }
  }
}

class OneShotAbortingStateStore implements StateStorePort {
  readonly root: string;
  #armed = false;

  public constructor(private readonly base: StateStorePort) {
    this.root = base.root;
  }

  public arm(): void {
    this.#armed = true;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public read(): Promise<EvlEdaState> {
    return this.base.read();
  }

  public transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    if (!this.#armed) return this.base.transaction(expectedRevision, mutate);
    this.#armed = false;
    return this.base.transaction<Result>(expectedRevision, async (state) => {
      await mutate(state);
      throw new Error("simulated state transaction abort before replacement");
    });
  }
}

const releaseAuthority = {
  type: "human" as const,
  id: "release-lifecycle",
  displayName: "Release Authority",
  role: "release_authority" as const
};

type SchematicReportMutation = (
  result: StageExecutionResult<"schematic">
) => StageExecutionResult<"schematic">;

const schematicReportEvidence = (
  result: StageExecutionResult<"schematic">,
  kind: "erc" | "connectivity"
) => {
  const marker = kind === "erc" ? `kicad-cli ${kind} output` : ` ${kind} check`;
  const index = result.evidence.findIndex((entry) => entry.claim.includes(marker));
  if (index < 0) throw new Error(`Missing ${kind} report evidence fixture`);
  return { entry: result.evidence[index]!, index };
};

const finalizeSchematicMutation = (
  result: StageExecutionResult<"schematic">,
  artifacts = result.artifacts,
  evidence = result.evidence
): StageExecutionResult<"schematic"> =>
  finalizeStageResult("schematic", artifacts, evidence, []);

const reportGateMutations: readonly {
  readonly name: string;
  readonly mutate: SchematicReportMutation;
}[] = [
  {
    name: "native evidence without its raw CLI output link",
    mutate: (result) => {
      const { entry, index } = schematicReportEvidence(result, "erc");
      const { rawArtifactLogicalName: _raw, ...withoutRaw } = entry;
      const evidence = [...result.evidence];
      evidence[index] = withoutRaw;
      return finalizeSchematicMutation(result, result.artifacts, evidence);
    }
  },
  {
    name: "derived evidence without its parsed report link",
    mutate: (result) => {
      const { entry, index } = schematicReportEvidence(result, "connectivity");
      const { parsedArtifactLogicalName: _parsed, ...withoutParsed } = entry;
      const evidence = [...result.evidence];
      evidence[index] = withoutParsed;
      return finalizeSchematicMutation(result, result.artifacts, evidence);
    }
  },
  {
    name: "a mixed raw-and-parsed derived report",
    mutate: (result) => {
      const { entry, index } = schematicReportEvidence(result, "connectivity");
      const evidence = [...result.evidence];
      evidence[index] = {
        ...entry,
        rawArtifactLogicalName: entry.parsedArtifactLogicalName!
      };
      return finalizeSchematicMutation(result, result.artifacts, evidence);
    }
  },
  {
    name: "duplicate authoritative reports for one stage and kind",
    mutate: (result) => {
      const { entry } = schematicReportEvidence(result, "connectivity");
      return finalizeSchematicMutation(result, result.artifacts, [
        ...result.evidence,
        entry
      ]);
    }
  },
  {
    name: "an internally bound but unapproved analyzer identity",
    mutate: (result) => {
      const { entry, index } = schematicReportEvidence(result, "connectivity");
      const artifactIndex = result.artifacts.findIndex(
        (artifact) => artifact.logicalName === entry.parsedArtifactLogicalName
      );
      const artifact = result.artifacts[artifactIndex]!;
      const document = JSON.parse(Buffer.from(artifact.content).toString("utf8")) as Record<
        string,
        any
      >;
      const arbitraryTool = {
        name: "Unapproved fixture analyzer",
        version: "0.2.0",
        adapter: "evleda" as const,
        capabilityProfile: "unapproved.fixture.connectivity.v2"
      };
      document.authority = {
        ...document.authority,
        analyzerId: arbitraryTool.capabilityProfile,
        tool: arbitraryTool
      };
      const authorityIdentity = canonicalIdentity(
        document.authority,
        "evleda.kicad-analyzer-report-authority.v2"
      );
      const exactInputs = artifact.exactInputs.map((identity) =>
        "schemaVersion" in identity &&
        identity.schemaVersion === "evleda.kicad-analyzer-report-authority.v2"
          ? authorityIdentity
          : identity
      );
      const content = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
      const replacement = {
        ...artifact,
        content,
        identity: contentIdentity(content),
        exactInputs,
        tool: arbitraryTool
      };
      const artifacts = [...result.artifacts];
      artifacts[artifactIndex] = replacement;
      const evidence = [...result.evidence];
      evidence[index] = {
        ...entry,
        claim: `EvlEDA ${arbitraryTool.capabilityProfile} connectivity check over exact native inputs for source revision ${String(document.sourceRevisionDigest)}.`,
        subjectDigests: [replacement.identity.digest],
        exactInputs,
        tool: arbitraryTool
      };
      return finalizeSchematicMutation(result, artifacts, evidence);
    }
  },
  {
    name: "a legacy v1 derived report envelope",
    mutate: (result) => {
      const { entry, index } = schematicReportEvidence(result, "connectivity");
      const artifactIndex = result.artifacts.findIndex(
        (artifact) => artifact.logicalName === entry.parsedArtifactLogicalName
      );
      const artifact = result.artifacts[artifactIndex]!;
      const document = JSON.parse(Buffer.from(artifact.content).toString("utf8")) as Record<
        string,
        unknown
      >;
      document.schemaVersion = "evleda.reference-kicad-report.v1";
      const content = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
      const replacement = {
        ...artifact,
        content,
        identity: contentIdentity(content)
      };
      const artifacts = [...result.artifacts];
      artifacts[artifactIndex] = replacement;
      const evidence = [...result.evidence];
      evidence[index] = {
        ...entry,
        subjectDigests: [replacement.identity.digest]
      };
      return finalizeSchematicMutation(result, artifacts, evidence);
    }
  }
];

const rewritePhysicalJsonSource = (
  input: SubmitExternalEvidenceInput,
  role: SubmitExternalEvidenceInput["sourceBlobs"][number]["role"],
  mutate: (value: Record<string, any>) => void
): SubmitExternalEvidenceInput => {
  const changed = structuredClone(input);
  const source = changed.sourceBlobs.find((candidate) => candidate.role === role);
  if (source === undefined) throw new Error(`Missing ${role} source fixture`);
  const value = JSON.parse(Buffer.from(source.bytesBase64, "base64").toString("utf8")) as Record<string, any>;
  mutate(value);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  source.identity = contentIdentity(bytes);
  source.bytesBase64 = bytes.toString("base64");
  return changed;
};

describe("ApplicationService policies", () => {
  it("preflights a project write target before creating directories", async () => {
    let escapedProject = "";
    const service = await makeApplication(fixtureRegistry, undefined, {
      prepareWorkspace: async (workspaceRoot) => {
        const outsideRoot = path.join(path.dirname(workspaceRoot), "outside-workspace");
        await mkdir(outsideRoot, { recursive: true });
        await symlink(
          outsideRoot,
          path.join(workspaceRoot, "projects"),
          process.platform === "win32" ? "junction" : "dir"
        );
        escapedProject = path.join(outsideRoot, "escaped-project");
      }
    });

    await expect(
      service.createProject({
        name: "Escaped project",
        workspace: "escaped-project",
        idempotencyKey: "create-escaped-project"
      })
    ).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(access(escapedProject)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds exact prompt and configuration identities and reproduces every source span", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "Identity coverage",
      idempotencyKey: "create-identity-coverage"
    });
    const configuration = { profile: "robotics-controller-v0", mode: "candidate" };
    const started = await service.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration,
      expectedRevision: project.project.revision,
      idempotencyKey: "start-identity-coverage"
    });
    const inspection = await service.inspectRequirements({ runId: started.run.id });

    expect(started.run.sourcePrompt).toEqual(contentIdentity(validPrompt));
    expect(started.run.configuration).toEqual(
      canonicalIdentity(
        {
          configuration,
          policyVersion: "evleda.policy.v1",
          workflowVersion: "evleda.workflow.v1"
        },
        "evleda.run-configuration.v1"
      )
    );
    expect(inspection.requirements.sourcePrompt).toEqual(started.run.sourcePrompt);
    const { identity, approvalId: _approvalId, ...identityPayload } = inspection.requirements;
    expect(identity).toEqual(canonicalIdentity(identityPayload, inspection.requirements.schemaVersion));
    for (const requirement of inspection.requirements.requirements) {
      expect(requirement.sourceSpans.length, requirement.id).toBeGreaterThan(0);
      for (const span of requirement.sourceSpans) {
        expect(validPrompt.slice(span.start, span.end), requirement.id).toBe(span.excerpt);
      }
    }

    const artifacts = await service.listArtifacts({ runId: started.run.id, includeStale: true });
    const evidence = await service.inspectEvidence({ runId: started.run.id, includeStale: true });
    const engineering = await service.inspectEngineeringPractices({ runId: started.run.id });
    expect(artifacts).toMatchObject({ revisionId: null, artifacts: [] });
    expect(evidence).toMatchObject({ revisionId: null, evidence: [] });
    expect(operationResultSchemas.list_artifacts.safeParse(artifacts).success).toBe(true);
    expect(operationResultSchemas.inspect_evidence.safeParse(evidence).success).toBe(true);
    expect(operationResultSchemas.inspect_engineering_practices.safeParse(engineering).success).toBe(true);
    expect(engineering).toMatchObject({
      revisionId: null,
      isHeadRevision: false,
      disposition: { status: "BLOCKED_DIAGNOSTIC" },
      checks: {
        nativeDrc: { evidenceClass: "kicad_native", machineStatus: "NOT_RUN" },
        evledaPractice: { evidenceClass: "evleda_check", machineStatus: "NOT_RUN" }
      },
      proofFixture: {
        classification: "candidate_only",
        reportEstablishesQualification: false,
        reportAuthorizesManufacturing: false,
        reportAuthorizesRelease: false
      }
    });
    expect(
      operationResultSchemas.list_artifacts.safeParse({
        projectId: artifacts.projectId,
        runId: artifacts.runId,
        artifacts: artifacts.artifacts
      }).success
    ).toBe(false);
  });

  it("persists an ambiguous requirements run as blocked", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "Ambiguous",
      idempotencyKey: "create-ambiguous-01"
    });
    const status = await service.startDesignRun({
      projectId: project.project.id,
      prompt: "Build a two motor controller at 0.5 A RMS.",
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "start-ambiguous-001"
    });

    expect(status.run.state).toBe("blocked");
    expect(status.currentStage).toBe("requirements");
    expect(status.blockers.map((blocker) => blocker.code)).toContain(
      "ASSUMPTION_MISSING_SUPPLY_VOLTAGE"
    );
  });

  it("revalidates a self-contained PCB-practice report from selected-revision CAS bytes", async () => {
    const diagnosticRegistry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(
        stage: K,
        context: StageContextByKey[K]
      ): Promise<StageExecutionResult<K>> => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage !== "pcb_placement_routing") return result;
        const pcbResult = result as StageExecutionResult<"pcb_placement_routing">;
        const reportIndex = pcbResult.artifacts.findIndex(
          (artifact) => artifact.logicalName === "reports/kicad/pcb/pcb-practices.json"
        );
        const evidenceIndex = pcbResult.evidence.findIndex((entry) =>
          entry.claim.includes(" pcb_practices check")
        );
        const report = pcbResult.artifacts[reportIndex]!;
        const reportDocument = JSON.parse(
          new TextDecoder().decode(report.content)
        ) as Record<string, unknown>;
        const reportBytes = `${canonicalJson({
          ...reportDocument,
          validationStatus: "fail"
        })}\n`;
        const replacement = artifactDraft({
          logicalName: report.logicalName,
          mediaType: report.mediaType,
          content: reportBytes,
          exactInputs: report.exactInputs,
          derivedFrom: report.derivedFrom,
          tool: report.tool,
          validationStatus: "fail",
          unresolvedAssumptions: report.unresolvedAssumptions
        });
        const artifacts = [...pcbResult.artifacts];
        artifacts[reportIndex] = replacement;
        const evidence = [...pcbResult.evidence];
        evidence[evidenceIndex] = {
          ...evidence[evidenceIndex]!,
          subjectDigests: [replacement.identity.digest],
          validationStatus: "fail"
        };
        return finalizeStageResult(
          "pcb_placement_routing",
          artifacts,
          evidence,
          [{
            code: "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
            message: "The phase-1 analyzer does not cover every board geometry form.",
            affectedInputDigests: [pcbResult.outputIdentity.digest],
            requiredAction: "Extend and validate exhaustive board-geometry coverage before POC.",
            retryable: false
          }]
        ) as StageExecutionResult<K>;
      }
    };
    const service = await makeApplication(diagnosticRegistry);
    const approved = await createApprovedRun(service);
    const diagnostic = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "engineering-diagnostic-resume-0001"
    });
    const revision = diagnostic.headRevision!;
    expect(diagnostic.run.state).toBe("blocked");

    const inspection = await service.inspectEngineeringPractices({
      runId: diagnostic.run.id,
      revisionId: revision.id,
      findingLimit: 50
    });

    expect(operationResultSchemas.inspect_engineering_practices.safeParse(inspection).success)
      .toBe(true);
    expect(inspection.revisionId).toBe(revision.id);
    expect(inspection.isHeadRevision).toBe(true);
    expect(inspection.checks.nativeDrc).toMatchObject({
      evidenceClass: "kicad_native",
      machineStatus: "PASS",
      current: true
    });
    expect(inspection.checks.evledaPractice).toMatchObject({
      evidenceClass: "evleda_check",
      machineStatus: "UNKNOWN",
      current: true,
      analysisOutcome: "pass"
    });
    expect(inspection.bindings).toMatchObject({
      revisionManifest: revision.manifest,
      practiceCatalogIdentity: expect.any(Object),
      routeQualityPolicyIdentity: expect.any(Object),
      routeQualityRuleDeckIdentity: expect.any(Object),
      proofFixturePolicyIdentity: expect.any(Object),
      analyzerProfileIdentity: expect.any(Object),
      constraintBindingIdentity: expect.any(Object),
      nativeBoardIdentity: expect.any(Object)
    });
    expect(inspection.coverage.inventoryComplete).toBe(true);
    expect(inspection.coverage.expectedRuleCount).toBe(inspection.rules.length);
    expect(inspection.coverage.missingRuleIds).toEqual([]);
    expect(inspection.coverage.unexpectedRuleIds).toEqual([]);
    expect(inspection.sources).toContainEqual(
      expect.objectContaining({
        sourceId: "evleda-route-quality-policy",
        url: null,
        authority: "internal_policy",
        accessScope: "embedded_snapshot",
        normativeStatus: "internal_product_policy",
        captureComplete: true
      })
    );
    expect(
      inspection.rules.find((rule) => rule.ruleId === "ROUTE_STYLE")?.sourceIds
    ).toContain("evleda-route-quality-policy");
    expect(inspection.disposition.status).toBe("BLOCKED_DIAGNOSTIC");
    expect(inspection.disposition.reasonCodes).toContain(
      "EVLEDA_PRACTICE_GEOMETRY_COVERAGE_INCOMPLETE"
    );
    expect(inspection.disposition.reasonCodes).toContain(
      "REFERENCE_FABRICATION_PROFILE_NOT_TRUSTED"
    );
    expect(inspection.outstandingExternalGates.length).toBeGreaterThan(0);
    expect(inspection.proofFixture.reportAuthorizesManufacturing).toBe(false);
    expect(inspection.proofFixture.reportAuthorizesRelease).toBe(false);
  }, 60_000);

  it("persists every excluded-use request as a requirements blocker with no downstream attempt", async () => {
    const service = await makeApplication();
    const cases = [
      ["mains", "Power the controller directly from 120 V AC mains.", "ASSUMPTION_EXCLUDED_MAINS"],
      ["battery", "Include an onboard battery charger and BMS.", "ASSUMPTION_EXCLUDED_BATTERY_CHARGING_OR_BMS"],
      ["safety", "Make the motor control safety-rated to SIL 2.", "ASSUMPTION_EXCLUDED_SAFETY_RATED"],
      ["human", "Use the controller in a human-carrying vehicle.", "ASSUMPTION_EXCLUDED_HUMAN_CARRYING"],
      ["medical", "Use the controller as a medical device.", "ASSUMPTION_EXCLUDED_MEDICAL"],
      ["certified", "Provide certified electrical protection.", "ASSUMPTION_EXCLUDED_CERTIFIED_PROTECTION"],
      ["motor-safety", "Provide safe torque off for both motors.", "ASSUMPTION_EXCLUDED_MOTOR_SAFETY"],
      ["auto-release", "Automatically release the generated design for manufacturing.", "ASSUMPTION_EXCLUDED_AUTONOMOUS_RELEASE"]
    ] as const;

    for (const [name, request, blockerCode] of cases) {
      const project = await service.createProject({
        name: `Excluded ${name}`,
        idempotencyKey: `create-excluded-${name}`
      });
      const status = await service.startDesignRun({
        projectId: project.project.id,
        prompt: `${validPrompt}\n${request}`,
        configuration: {},
        expectedRevision: project.project.revision,
        idempotencyKey: `start-excluded-${name}`
      });

      expect(status.run.state, request).toBe("blocked");
      expect(status.currentStage, request).toBe("requirements");
      expect(status.blockers.map((blocker) => blocker.code), request).toContain(blockerCode);
      expect(
        Object.entries(status.run.attempts)
          .filter(([stage]) => stage !== "requirements")
          .every(([, attempts]) => attempts.length === 0),
        request
      ).toBe(true);
    }
  }, 60_000);

  it("never makes partial stage output current across every content commit boundary", async () => {
    let systemArtifactIdentities: readonly ContentIdentity[] = [];
    const multiArtifactRegistry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage !== "system_architecture") return result;
        const source = result.artifacts[0]!;
        const companion = artifactDraft({
          logicalName: "architecture/system-architecture-summary.json",
          mediaType: "application/json",
          content: `${canonicalJson({ schemaVersion: "evleda.test-architecture-summary.v1" })}\n`,
          exactInputs: source.exactInputs,
          tool: source.tool,
          validationStatus: "pass"
        });
        systemArtifactIdentities = [...result.artifacts, companion].map((artifact) => artifact.identity);
        return finalizeStageResult(
          stage,
          [...result.artifacts, companion],
          result.evidence,
          []
        ) as typeof result;
      }
    };
    for (const boundary of [
      { call: 1, phase: "provision manifest", rejects: true },
      { call: 2, phase: "first artifact publication", rejects: false },
      { call: 3, phase: "second artifact publication after a partial CAS batch", rejects: false },
      { call: 4, phase: "revision manifest", rejects: false }
    ] as const) {
      let faulting: OneShotFaultingContentStore | undefined;
      let durableContent: ContentStorePort | undefined;
      systemArtifactIdentities = [];
      const service = await makeApplication(multiArtifactRegistry, undefined, {
        decorateContent: (content) => {
          durableContent = content;
          faulting = new OneShotFaultingContentStore(content);
          return faulting;
        }
      });
      const approved = await createApprovedRun(service);
      const parentRevisionId = approved.headRevision!.id;
      faulting!.arm(boundary.call);
      const resume = service.resumeRun({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        idempotencyKey: `fault-content-boundary-${boundary.call}`
      });
      if (boundary.rejects) {
        await expect(resume, boundary.phase).rejects.toThrow(/simulated content publication failure/iu);
      } else {
        await expect(resume, boundary.phase).resolves.toMatchObject({ run: { state: "blocked" } });
      }

      const status = await service.getRunStatus({ runId: approved.run.id });
      expect(status.headRevision?.id, boundary.phase).toBe(parentRevisionId);
      const attempt = status.run.attempts.system_architecture.at(-1);
      if (boundary.call === 1) {
        expect(attempt, boundary.phase).toBeUndefined();
        expect(status.run.state, boundary.phase).toBe("queued");
      } else {
        expect(attempt?.state, boundary.phase).toBe("blocked");
        expect(attempt?.blockers.map((blocker) => blocker.code), boundary.phase).toContain(
          "ARTIFACT_INTEGRITY_ERROR"
        );
        expect(
          attempt?.artifactIds.every((id) => !status.headRevision!.artifactIds.includes(id)),
          boundary.phase
        ).toBe(true);
      }
      await faulting!.settle();
      if (boundary.call === 2) {
        await expect(durableContent!.verify(systemArtifactIdentities[0]!)).rejects.toMatchObject({
          code: "NOT_FOUND"
        });
        await expect(durableContent!.verify(systemArtifactIdentities[1]!)).resolves.toBe(true);
      }
      if (boundary.call === 3) {
        await expect(durableContent!.verify(systemArtifactIdentities[0]!)).resolves.toBe(true);
        await expect(durableContent!.verify(systemArtifactIdentities[1]!)).rejects.toMatchObject({
          code: "NOT_FOUND"
        });
      }
    }
  }, 60_000);

  it("does not publish a partial revision when the state transaction aborts before replacement", async () => {
    let faulting!: OneShotAbortingStateStore;
    const registry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, stageContext: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, stageContext);
        if (stage === "system_architecture") faulting.arm();
        return result;
      }
    };
    const service = await makeApplication(registry, undefined, {
      decorateState: (state) => {
        faulting = new OneShotAbortingStateStore(state);
        return faulting;
      }
    });
    const approved = await createApprovedRun(service);
    const before = await faulting.read();
    const parentRevisionId = approved.headRevision!.id;

    const blocked = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "fault-state-transaction-before-replacement"
    });

    const after = await faulting.read();
    const attempt = blocked.run.attempts.system_architecture.at(-1)!;
    expect(blocked.run.state).toBe("blocked");
    expect(blocked.headRevision?.id).toBe(parentRevisionId);
    expect(blocked.project.headRevisionId).toBe(parentRevisionId);
    expect(attempt.state).toBe("blocked");
    expect(attempt.artifactIds).toEqual([]);
    expect(attempt.evidenceIds).toEqual([]);
    expect(attempt.outputIdentity).toBeUndefined();
    expect(attempt.blockers.map((blocker) => blocker.code)).toContain(
      "ARTIFACT_INTEGRITY_ERROR"
    );
    expect(after.revisions).toEqual(before.revisions);
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.invocations).toEqual(before.invocations);
    expect(
      Object.values(after.auditOutbox).some(
        (event) =>
          event.type === "stage.succeeded" &&
          (event.payload as { readonly attemptId?: string }).attemptId === attempt.id
      )
    ).toBe(false);
    expect(
      Object.values(after.auditOutbox).some(
        (event) =>
          event.type === "stage.blocked" &&
          (event.payload as { readonly attemptId?: string }).attemptId === attempt.id
      )
    ).toBe(true);
  });

  it("requires a trusted human context and an exact digest for approval", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "Policy",
      idempotencyKey: "create-policy-00001"
    });
    const status = await service.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "start-policy-000001"
    });
    const requirements = await service.inspectRequirements({ runId: status.run.id });
    const input = {
      runId: status.run.id,
      requirementsDigest: requirements.requirementsDigest,
      actor: reviewer,
      rationale: "Reviewed.",
      scope: "exact requirements document",
      expectedRevision: status.run.revision,
      idempotencyKey: "approve-policy-0001"
    } as const;

    await expect(service.approveRequirements(input, MCP_CONTEXT)).rejects.toMatchObject({
      code: "CAPABILITY_REQUIRED"
    });
    await expect(
      service.approveRequirements(
        { ...input, requirementsDigest: "0".repeat(64), idempotencyKey: "approve-policy-0002" },
        localHumanContext(reviewer, "requirements_approval")
      )
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await service.getRunStatus({ runId: status.run.id })).run.revision).toBe(0);
  });

  it("keeps requirements approval candidate-only and rejects fresh terminal resumes without mutation", async () => {
    const service = await makeApplication();
    const approved = await createApprovedRun(service);
    expect({
      run: approved.run.lifecycle,
      revision: approved.headRevision?.lifecycle,
      effective: approved.effectiveLifecycle
    }).toEqual({ run: "candidate", revision: "candidate", effective: "candidate" });

    const resumeInput = {
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "resume-terminal-replay"
    } as const;
    const completed = await service.resumeRun(resumeInput);
    const beforeReplay = await service.getRunStatus({ runId: completed.run.id });
    const replayed = await service.resumeRun(resumeInput);
    expect(replayed.stateRevision).toBe(beforeReplay.stateRevision);
    expect(replayed.run.revision).toBe(beforeReplay.run.revision);

    await expect(
      service.resumeRun({
        runId: completed.run.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "resume-completed-fresh-key"
      })
    ).rejects.toMatchObject({
      code: "GATE_FAILED",
      details: { runId: completed.run.id, state: "completed" }
    });
    const afterRejected = await service.getRunStatus({ runId: completed.run.id });
    expect(afterRejected.stateRevision).toBe(beforeReplay.stateRevision);
    expect(afterRejected.run).toEqual(beforeReplay.run);
  });

  it("executes stages in order and creates a complete candidate-only head", async () => {
    const service = await makeApplication();
    const status = await createCompletedRun(service);

    expect(status.run.state).toBe("completed");
    expect(status.run.lifecycle).toBe("candidate");
    expect(status.headRevision?.lifecycle).toBe("candidate");
    expect(status.nextStage).toBeUndefined();
    expect(
      Object.values(status.run.attempts).every((attempts) =>
        attempts.some((attempt) => attempt.state === "succeeded")
      )
    ).toBe(true);
  });

  it("rejects partial candidate export with a stable gate failure", async () => {
    const service = await makeApplication();
    const approved = await createApprovedRun(service);
    const revisionId = approved.headRevision!.id;
    const envelope = await service.dispatch("export_candidate_bundle", {
      revisionId,
      expectedRevision: approved.run.revision,
      idempotencyKey: "partial-export-0001"
    });

    expect(envelope).toMatchObject({ ok: false, error: { code: "GATE_FAILED" } });
  });

  it("produces byte-identical complete candidate ZIPs with bound manifests", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const beforeFirst = await service.getRunStatus({ runId: completed.run.id });
    const first = await service.exportCandidateBundle({
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-export-001"
    });
    const afterFirst = await service.getRunStatus({ runId: completed.run.id });
    expect({
      run: afterFirst.run.lifecycle,
      revision: afterFirst.headRevision?.lifecycle,
      effective: afterFirst.effectiveLifecycle
    }).toEqual({
      run: beforeFirst.run.lifecycle,
      revision: beforeFirst.headRevision?.lifecycle,
      effective: beforeFirst.effectiveLifecycle
    });
    const second = await service.exportCandidateBundle({
      revisionId: completed.headRevision!.id,
      expectedRevision: afterFirst.run.revision,
      idempotencyKey: "candidate-export-002"
    });

    expect(first.identity).toEqual(second.identity);
    expect(first.bytesBase64).toBe(second.bytesBase64);
    expect(first.fileName).toContain("NOT-FOR-MANUFACTURING");
    expect(bundleManifestSchema.parse(first.manifest).bundleKind).toBe("candidate");
    const files = unzipSync(Buffer.from(first.bytesBase64, "base64"));
    const rootName = Object.keys(files)[0]!.split("/")[0]!;
    expect(Buffer.from(files[`${rootName}/WARNING.txt`]!).toString("utf8")).toBe(
      "CANDIDATE — NOT FOR MANUFACTURING\n"
    );
    expect(Buffer.from(files[`${rootName}/README.md`]!).toString("utf8")).toContain(
      "# CANDIDATE — NOT FOR MANUFACTURING"
    );
    const coverName = Object.keys(files).find((name) => name.endsWith("/COVER.svg"));
    expect(coverName).toBeDefined();
    const coverText = Buffer.from(files[coverName!]!).toString("utf8");
    expect(coverText).toMatch(
      /<text[^>]*>CANDIDATE — NOT FOR MANUFACTURING<\/text>/u
    );
    expect(coverText).toMatch(/<text[^>]*>Lifecycle: candidate<\/text>/u);
    const coverArtifact = first.manifest.artifacts.find(
      (artifact) => artifact.generationRole === "cover"
    );
    expect(coverArtifact).toMatchObject({
      path: "COVER.svg",
      logicalName: "bundle/COVER.svg",
      mediaType: "image/svg+xml; charset=utf-8",
      sourceKind: "bundle_generated",
      sourceDesignRevisionId: first.designRevisionId,
      designRevisionId: first.designRevisionId,
      exactInputs: [
        first.manifest.revisionManifest,
        first.manifest.evidenceRoot,
        first.manifest.liveRegenerationPolicyIdentity
      ],
      derivedFrom: [],
      lifecycle: "candidate",
      createdAt: null,
      staleAt: null
    });
    const sourceRender = first.manifest.artifacts.find(
      (artifact) => artifact.logicalName === "renders/controller.svg"
    );
    expect(sourceRender).toMatchObject({
      sourceKind: "stored_artifact",
      mediaType: "image/svg+xml"
    });
    expect(sourceRender?.generationRole).toBeUndefined();
    const archivedRender = files[`${rootName}/${sourceRender!.path}`];
    const committedRender = await service.readArtifact(sourceRender!.sourceArtifactId);
    expect(Buffer.from(archivedRender!)).toEqual(Buffer.from(committedRender.bytes));
    expect(first.manifest.artifacts).toEqual(
      [...first.manifest.artifacts].sort((left, right) => left.path.localeCompare(right.path, "en"))
    );
    expect(first.manifest.artifacts.some((artifact) => artifact.logicalName.includes("/"))).toBe(true);
  });

  it("does not accept spoofed agent claims as KiCad-native export gates", async () => {
    const spoofedRegistry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: (stage) => fixtureRegistry.has(stage),
      get: <K extends StageKey>(stage: K) => fixtureRegistry.get(stage),
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage !== "schematic") return result;
        const evidence = result.evidence.map((entry) => ({
          ...entry,
          evidenceClass: "agent_claim" as const,
          tool: { name: "untrusted-agent", version: "1", adapter: "evleda" as const }
        }));
        return finalizeStageResult(stage, result.artifacts, evidence, []) as typeof result;
      }
    };
    const service = await makeApplication(spoofedRegistry);
    const completed = await createCompletedRun(service);
    await expect(
      service.exportCandidateBundle({
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "spoofed-native-gates"
      })
    ).rejects.toMatchObject({ code: "GATE_FAILED" });
  });

  it.each(reportGateMutations)("rejects $name at the completion/export gate", async ({
    name,
    mutate
  }) => {
    const mutatedRegistry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: (stage) => fixtureRegistry.has(stage),
      get: <K extends StageKey>(stage: K) => fixtureRegistry.get(stage),
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        return (stage === "schematic"
          ? mutate(result as StageExecutionResult<"schematic">)
          : result) as StageExecutionResult<K>;
      }
    };
    const service = await makeApplication(mutatedRegistry);
    const completed = await createCompletedRun(service);
    await expect(
      service.exportCandidateBundle({
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: `report-v2-gate-${name.replaceAll(/[^a-z0-9]+/giu, "-")}`
      })
    ).rejects.toMatchObject({ code: "GATE_FAILED" });
  });

  it("requires the approved PCB-practices check for PCB export eligibility", async () => {
    const missingPracticeRegistry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: (stage) => fixtureRegistry.has(stage),
      get: <K extends StageKey>(stage: K) => fixtureRegistry.get(stage),
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage !== "pcb_placement_routing") return result;
        return finalizeStageResult(
          stage,
          result.artifacts.filter(
            (artifact) => !artifact.logicalName.includes("pcb-practices")
          ),
          result.evidence.filter((entry) => !entry.claim.includes(" pcb_practices check")),
          result.blockers
        ) as StageExecutionResult<K>;
      }
    };
    const service = await makeApplication(missingPracticeRegistry);
    const completed = await createCompletedRun(service);
    await expect(
      service.exportCandidateBundle({
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "missing-pcb-practices-report"
      })
    ).rejects.toMatchObject({
      code: "GATE_FAILED",
      details: {
        missingDerivedReports: ["pcb_placement_routing:pcb_practices"]
      }
    });
  });

  it("rejects a coherently re-bound PCB-practices report for different board bytes", async () => {
    const differentBoardRegistry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: (stage) => fixtureRegistry.has(stage),
      get: <K extends StageKey>(stage: K) => fixtureRegistry.get(stage),
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage !== "pcb_placement_routing") return result;
        const evidenceIndex = result.evidence.findIndex((entry) =>
          entry.claim.includes(" pcb_practices check")
        );
        const entry = result.evidence[evidenceIndex]!;
        const artifactIndex = result.artifacts.findIndex(
          (artifact) => artifact.logicalName === entry.parsedArtifactLogicalName
        );
        const artifact = result.artifacts[artifactIndex]!;
        const document = JSON.parse(Buffer.from(artifact.content).toString("utf8")) as Record<
          string,
          any
        >;
        const previousPcbSource = document.authority.inputBindings.find(
          (binding: Record<string, any>) =>
            binding.kind === "source" && String(binding.logicalName).endsWith(".kicad_pcb")
        );
        if (previousPcbSource === undefined) {
          throw new Error("PCB-practices fixture lacks its board source binding");
        }
        const differentBoardIdentity = contentIdentity("coherent-different-kicad-pcb-bytes");
        document.authority = {
          ...document.authority,
          inputBindings: document.authority.inputBindings.map(
            (binding: Record<string, any>) =>
              binding === previousPcbSource
                ? { ...binding, identity: differentBoardIdentity }
                : binding
          )
        };
        const authorityIdentity = canonicalIdentity(
          document.authority,
          "evleda.kicad-analyzer-report-authority.v2"
        );
        const exactInputs = artifact.exactInputs.map((identity) => {
          if (
            "schemaVersion" in identity &&
            identity.schemaVersion === "evleda.kicad-analyzer-report-authority.v2"
          ) {
            return authorityIdentity;
          }
          return canonicalJson(identity) === canonicalJson(previousPcbSource.identity)
            ? differentBoardIdentity
            : identity;
        });
        const content = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
        const replacement = {
          ...artifact,
          content,
          identity: contentIdentity(content),
          exactInputs
        };
        const artifacts = [...result.artifacts];
        artifacts[artifactIndex] = replacement;
        const evidence = [...result.evidence];
        evidence[evidenceIndex] = {
          ...entry,
          subjectDigests: [replacement.identity.digest],
          exactInputs
        };
        return finalizeStageResult(stage, artifacts, evidence, result.blockers) as StageExecutionResult<K>;
      }
    };
    const service = await makeApplication(differentBoardRegistry);
    const completed = await createCompletedRun(service);
    await expect(
      service.exportCandidateBundle({
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "different-pcb-practices-source-bytes"
      })
    ).rejects.toMatchObject({ code: "GATE_FAILED" });
  });

  it("rejects non-NFC and platform-illegal artifact paths at export", async () => {
    const unsafeRegistry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: (stage) => fixtureRegistry.has(stage),
      get: <K extends StageKey>(stage: K) => fixtureRegistry.get(stage),
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage !== "bringup_package") return result;
        const candidate = context as StageContextByKey["bringup_package"];
        const unsafe = artifactDraft({
          logicalName: "bringup/ba\u0301d?.txt",
          mediaType: "text/plain",
          content: "unsafe path fixture",
          exactInputs: [candidate.requirements.identity],
          validationStatus: "pass"
        });
        return finalizeStageResult(stage, [...result.artifacts, unsafe], result.evidence, []) as typeof result;
      }
    };
    const service = await makeApplication(unsafeRegistry);
    const completed = await createCompletedRun(service);
    await expect(
      service.exportCandidateBundle({
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "unsafe-path-export"
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
  });

  it("reruns by appending a branch and staling descendants without overwriting history", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const originalHead = completed.headRevision!.id;
    const input = {
      runId: completed.run.id,
      stage: "firmware_contract" as const,
      reason: "Regenerate the hardware/firmware binding.",
      expectedRevision: completed.run.revision,
      idempotencyKey: "rerun-firmware-0001"
    };
    const rerun = await service.rerunStage(input);
    expect(rerun.run.state).toBe("queued");
    expect(rerun.headRevision!.id).not.toBe(originalHead);
    expect(rerun.run.attempts.firmware_contract.filter((attempt) => attempt.state === "stale")).toHaveLength(1);
    expect(rerun.run.attempts.firmware_contract.filter((attempt) => attempt.state === "succeeded")).toHaveLength(1);
    expect(
      rerun.run.attempts.simulation_checks.every((attempt) => attempt.state === "stale")
    ).toBe(true);
    const currentArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      includeStale: true
    });
    const explicitCurrentArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      revisionId: rerun.headRevision!.id,
      includeStale: true
    });
    expect(currentArtifacts.revisionId).toBe(rerun.headRevision!.id);
    expect(currentArtifacts.artifacts).toEqual(explicitCurrentArtifacts.artifacts);
    expect(currentArtifacts.artifacts.every((artifact) => artifact.staleAt === undefined)).toBe(true);

    const historicalArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      revisionId: originalHead,
      includeStale: true
    });
    expect(historicalArtifacts.artifacts.some((artifact) => artifact.staleAt !== undefined)).toBe(true);

    const currentEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      includeStale: true
    });
    const explicitCurrentEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: rerun.headRevision!.id,
      includeStale: true
    });
    expect(currentEvidence.revisionId).toBe(rerun.headRevision!.id);
    expect(currentEvidence.evidence).toEqual(explicitCurrentEvidence.evidence);
    expect(currentEvidence.evidenceRoot).toEqual(explicitCurrentEvidence.evidenceRoot);
    expect(currentEvidence.evidence.every((entry) => entry.staleAt === undefined)).toBe(true);
    const historicalEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: originalHead,
      includeStale: true
    });
    const staleHistoricalEvidence = historicalEvidence.evidence.find(
      (entry) => entry.staleAt !== undefined
    );
    expect(staleHistoricalEvidence).toBeDefined();
    await expect(
      service.inspectEvidence({
        runId: completed.run.id,
        evidenceId: staleHistoricalEvidence!.id,
        includeStale: true
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const replay = await service.rerunStage(input);
    expect(replay.headRevision!.id).toBe(rerun.headRevision!.id);
    expect(replay.run.attempts.firmware_contract).toHaveLength(
      rerun.run.attempts.firmware_contract.length
    );
  });

  it("keeps bring-up candidate generation separate while exporting exact committed firmware without moving heads", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const bringup = await service.generateBringupPlan({
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "generate-bringup-001"
    });
    expect(bringup.workflowStage).toBe("bringup_package");
    expect(bringup.revision.parentRevisionIds).toEqual([completed.headRevision!.id]);
    expect(bringup.revision.lifecycle).toBe("candidate");

    const status = await service.getRunStatus({ runId: completed.run.id });
    const firmware = await service.generateFirmwareScaffold({
      revisionId: bringup.revision.id,
      language: "c",
      expectedRevision: status.run.revision,
      idempotencyKey: "generate-firmware-01"
    });
    expect(firmware.artifact.mediaType).toBe("application/zip");
    expect(firmware.revision.id).toBe(bringup.revision.id);
    expect(firmware.artifact.designRevisionId).toBe(bringup.revision.id);
    const after = await service.getRunStatus({ runId: completed.run.id });
    expect(after.headRevision!.id).toBe(bringup.revision.id);
    expect(after.project.headRevisionId).toBe(bringup.revision.id);
    expect(after.run.revision).toBe(status.run.revision);
    expect(after.effectiveLifecycle).toBe("candidate");
    const archive = unzipSync((await service.readArtifact(firmware.artifact.id)).bytes);
    expect(Object.keys(archive).sort()).toEqual([
      "firmware/CMakeLists.txt",
      "firmware/board-contract.json",
      "firmware/build/evleda-stm32g0b1cet6-candidate.bin",
      "firmware/build/evleda-stm32g0b1cet6-candidate.elf",
      "firmware/build/evleda-stm32g0b1cet6-candidate.map",
      "firmware/include/board_contract.h",
      "firmware/reports/compile-validation.json",
      "firmware/reports/schematic-pin-map-parity.json",
      "firmware/reports/stm32g0-target-build.json",
      "firmware/src/board_contract.c",
      "firmware/target/STM32G0B1CET6.ld",
      "firmware/target/platform_stm32g0b1.c",
      "firmware/target/startup_stm32g0b1.s",
      "firmware/tests/board_contract_validation.c",
      "provenance/firmware-stage-export.json"
    ]);
    const committed = await service.listArtifacts({
      runId: completed.run.id,
      revisionId: bringup.revision.id,
      stage: "firmware_contract",
      includeStale: false
    });
    for (const source of committed.artifacts.filter((artifact) => artifact.id !== firmware.artifact.id)) {
      expect(Buffer.from(archive[source.logicalName]!)).toEqual(
        (await service.readArtifact(source.id)).bytes
      );
    }
    const replay = await service.generateFirmwareScaffold({
      revisionId: bringup.revision.id,
      language: "c",
      expectedRevision: status.run.revision,
      idempotencyKey: "generate-firmware-01"
    });
    expect(replay.artifact.id).toBe(firmware.artifact.id);

    const beforeDistinctKey = await service.getRunStatus({ runId: completed.run.id });
    const deduplicated = await service.generateFirmwareScaffold({
      revisionId: bringup.revision.id,
      language: "c",
      expectedRevision: beforeDistinctKey.run.revision,
      idempotencyKey: "generate-firmware-02"
    });
    expect(deduplicated.artifact).toEqual(firmware.artifact);
    expect(deduplicated.revision).toEqual(firmware.revision);
    const afterDistinctKey = await service.getRunStatus({ runId: completed.run.id });
    expect(afterDistinctKey.run.revision).toBe(beforeDistinctKey.run.revision);
    expect(afterDistinctKey.headRevision?.id).toBe(beforeDistinctKey.headRevision?.id);
    expect(afterDistinctKey.project.headRevisionId).toBe(beforeDistinctKey.project.headRevisionId);
  });

  it("rejects bring-up generation from a historical revision without creating another revision", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const firstRevisionId = completed.headRevision!.id;
    const bringupInput = {
      revisionId: firstRevisionId,
      expectedRevision: completed.run.revision,
      idempotencyKey: "generate-bringup-current-head"
    } as const;
    const bringup = await service.generateBringupPlan(bringupInput);
    const firstBytes = await service.readArtifact(bringup.artifact.id);
    const beforeReplay = await service.getRunStatus({ runId: completed.run.id });
    const replay = await service.generateBringupPlan(bringupInput);
    expect(replay).toEqual(bringup);
    expect(await service.readArtifact(replay.artifact.id)).toEqual(firstBytes);
    const afterReplay = await service.getRunStatus({ runId: completed.run.id });
    expect(afterReplay.stateRevision).toBe(beforeReplay.stateRevision);
    expect(afterReplay.run.revision).toBe(beforeReplay.run.revision);

    const beforeRejected = afterReplay;
    const beforeArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      includeStale: true
    });

    await expect(
      service.generateBringupPlan({
        revisionId: firstRevisionId,
        expectedRevision: beforeRejected.run.revision,
        idempotencyKey: "generate-bringup-historical-head"
      })
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        revisionId: firstRevisionId,
        runHeadRevisionId: bringup.revision.id,
        projectHeadRevisionId: bringup.revision.id
      }
    });

    const afterRejected = await service.getRunStatus({ runId: completed.run.id });
    const afterArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      includeStale: true
    });
    expect(afterRejected.stateRevision).toBe(beforeRejected.stateRevision);
    expect(afterRejected.run.revision).toBe(beforeRejected.run.revision);
    expect(afterRejected.headRevision?.id).toBe(bringup.revision.id);
    expect(afterRejected.project.headRevisionId).toBe(bringup.revision.id);
    expect(afterArtifacts).toEqual(beforeArtifacts);
  });

  it("replays an exact firmware key after head advancement while rejecting conflicting or new historical requests", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const firstRevisionId = completed.headRevision!.id;
    const firmwareInput = {
      revisionId: firstRevisionId,
      language: "c" as const,
      expectedRevision: completed.run.revision,
      idempotencyKey: "firmware-historical-exact-replay"
    };
    const firmware = await service.generateFirmwareScaffold(firmwareInput);
    const firmwareBytes = await service.readArtifact(firmware.artifact.id);
    const beforeAdvance = await service.getRunStatus({ runId: completed.run.id });
    const bringup = await service.generateBringupPlan({
      revisionId: firstRevisionId,
      expectedRevision: beforeAdvance.run.revision,
      idempotencyKey: "firmware-replay-advance-head"
    });
    const beforeReplay = await service.getRunStatus({ runId: completed.run.id });

    const replay = await service.generateFirmwareScaffold(firmwareInput);
    expect(replay).toEqual(firmware);
    expect(await service.readArtifact(replay.artifact.id)).toEqual(firmwareBytes);
    const afterReplay = await service.getRunStatus({ runId: completed.run.id });
    expect(afterReplay.stateRevision).toBe(beforeReplay.stateRevision);
    expect(afterReplay.run.revision).toBe(beforeReplay.run.revision);
    expect(afterReplay.headRevision?.id).toBe(bringup.revision.id);
    expect(afterReplay.project.headRevisionId).toBe(bringup.revision.id);

    await expect(
      service.generateFirmwareScaffold({
        ...firmwareInput,
        revisionId: bringup.revision.id
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.generateFirmwareScaffold({
        revisionId: firstRevisionId,
        language: "c",
        expectedRevision: beforeReplay.run.revision,
        idempotencyKey: "firmware-historical-new-key"
      })
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        revisionId: firstRevisionId,
        runHeadRevisionId: bringup.revision.id,
        projectHeadRevisionId: bringup.revision.id
      }
    });
    const afterRejected = await service.getRunStatus({ runId: completed.run.id });
    expect(afterRejected.stateRevision).toBe(beforeReplay.stateRevision);
    expect(afterRejected.run).toEqual(beforeReplay.run);
    expect(afterRejected.headRevision).toEqual(beforeReplay.headRevision);
  });

  it("fails closed when an exact committed firmware stage or requested language is absent", async () => {
    const service = await makeApplication();
    const approved = await createApprovedRun(service);
    await expect(service.generateFirmwareScaffold({
      revisionId: approved.headRevision!.id,
      language: "c",
      expectedRevision: approved.run.revision,
      idempotencyKey: "firmware-export-before-stage"
    })).rejects.toMatchObject({ code: "GATE_FAILED" });

    const completed = await service.resumeRun({
      runId: approved.run.id,
      expectedRevision: approved.run.revision,
      idempotencyKey: "firmware-export-language-run"
    });
    await expect(service.generateFirmwareScaffold({
      revisionId: completed.headRevision!.id,
      language: "rust",
      expectedRevision: completed.run.revision,
      idempotencyKey: "firmware-export-rust-absent"
    })).rejects.toMatchObject({ code: "GATE_FAILED" });
  });

  it.each(["head", "approval", "input_manifest"] as const)(
    "rejects stage commit when the frozen %s fence changes inside the commit transaction",
    async (changedFence) => {
      let guardedState!: BeforeTransactionStateStore;
      const registry: StageRegistryContract = {
        ...fixtureRegistry,
        execute: async <K extends StageKey>(stage: K, stageContext: StageContextByKey[K]) => {
          const result = await fixtureRegistry.execute(stage, stageContext);
          if (stage === "system_architecture") {
            guardedState.arm((state) => {
              const run = state.runs[(stageContext as { readonly runId: string }).runId]!;
              if (changedFence === "approval") {
                const approvalId = run.requirements!.approvalId!;
                state.approvals[approvalId] = {
                  ...state.approvals[approvalId]!,
                  revokedAt: "2026-09-03T12:00:00.000Z"
                };
              } else if (changedFence === "input_manifest") {
                const attempts = { ...run.attempts } as Record<StageKey, readonly typeof run.attempts[StageKey][number][]>;
                attempts.system_architecture = attempts.system_architecture.map((attempt) =>
                  attempt.state === "running"
                    ? {
                        ...attempt,
                        inputManifest: canonicalIdentity(
                          { tampered: true },
                          "evleda.stage-input.system_architecture.v1"
                        )
                      }
                    : attempt
                );
                state.runs[run.id] = { ...run, attempts };
              } else {
                const parent = state.revisions[run.headRevisionId!]!;
                const concurrentId = "revision_concurrent_fence_change";
                state.revisions[concurrentId] = {
                  ...parent,
                  id: concurrentId,
                  ordinal: parent.ordinal + 100,
                  parentRevisionIds: [parent.id]
                };
                state.runs[run.id] = { ...run, headRevisionId: concurrentId };
                const project = state.projects[run.projectId]!;
                state.projects[project.id] = { ...project, headRevisionId: concurrentId };
              }
            });
          }
          return result;
        }
      };
      const service = await makeApplication(registry, undefined, {
        decorateState: (state) => {
          guardedState = new BeforeTransactionStateStore(state);
          return guardedState;
        }
      });
      const approved = await createApprovedRun(service);
      const parentId = approved.headRevision!.id;
      const blocked = await service.resumeRun({
        runId: approved.run.id,
        expectedRevision: approved.run.revision,
        idempotencyKey: `stage-fence-${changedFence}`
      });

      expect(blocked.run.state).toBe("blocked");
      expect(blocked.headRevision!.id).toBe(parentId);
      expect(blocked.run.attempts.system_architecture.at(-1)!.state).toBe("blocked");
      expect(blocked.blockers.map((blocker) => blocker.code)).toContain("REVISION_CONFLICT");
    }
  );

  it("deduplicates durable retries and rejects key reuse with a different request", async () => {
    const service = await makeApplication();
    const input = { name: "Dedupe", idempotencyKey: "dedupe-project-001" } as const;
    const first = await service.createProject(input);
    const second = await service.createProject(input);
    expect(second.project.id).toBe(first.project.id);
    await expect(
      service.createProject({ name: "Different", idempotencyKey: input.idempotencyKey })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await service.listProjects()).toHaveLength(1);
  });

  it("requires passing exact physical evidence before qualification and prototype export", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    await expect(
      service.exportPrototypeBundle({
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "prototype-denied-01"
      })
    ).rejects.toMatchObject({ code: "EXTERNAL_ACCEPTANCE_REQUIRED" });

    const inspected = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: completed.headRevision!.id,
      includeStale: false
    });
    await expect(
      service.qualifyRevision(
        {
          revisionId: completed.headRevision!.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: inspected.evidenceRoot.digest,
          actor: qualifier,
          rationale: "Attempted qualification without bench evidence.",
          scope: "one controlled prototype",
          expectedRevision: completed.run.revision,
          idempotencyKey: "qualify-no-physical"
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "EXTERNAL_ACCEPTANCE_REQUIRED" });
    const physicalInput = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "prototype-physical-01",
      "PROTOTYPE-001"
    );
    const physical = await service.submitExternalEvidence(
      physicalInput,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const qualification = await service.qualifyRevision(
      {
        revisionId: completed.headRevision!.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Exact candidate documentation reviewed for one controlled prototype.",
        scope: "one controlled prototype",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "qualify-prototype-1"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const beforePrototypeExport = await service.getRunStatus({ runId: completed.run.id });
    const bundle = await service.exportPrototypeBundle({
      revisionId: completed.headRevision!.id,
      expectedRevision: beforePrototypeExport.run.revision,
      idempotencyKey: "prototype-export-01"
    });
    const afterPrototypeExport = await service.getRunStatus({ runId: completed.run.id });
    expect({
      run: afterPrototypeExport.run.lifecycle,
      revision: afterPrototypeExport.headRevision?.lifecycle,
      effective: afterPrototypeExport.effectiveLifecycle
    }).toEqual({
      run: beforePrototypeExport.run.lifecycle,
      revision: beforePrototypeExport.headRevision?.lifecycle,
      effective: beforePrototypeExport.effectiveLifecycle
    });
    expect(bundle.lifecycle).toBe("qualified");
    expect(bundle.manifest.warning).toBe("PROTOTYPE — NOT PRODUCTION RELEASED");
    const files = unzipSync(Buffer.from(bundle.bytesBase64, "base64"));
    const rootName = Object.keys(files)[0]!.split("/")[0]!;
    expect(Buffer.from(files[`${rootName}/WARNING.txt`]!).toString("utf8")).toBe(
      "PROTOTYPE — NOT PRODUCTION RELEASED\n"
    );
    expect(Buffer.from(files[`${rootName}/README.md`]!).toString("utf8")).toContain(
      "# PROTOTYPE — NOT PRODUCTION RELEASED"
    );
    const coverName = Object.keys(files).find((name) => name.endsWith("/COVER.svg"));
    expect(coverName).toBeDefined();
    const coverText = Buffer.from(files[coverName!]!).toString("utf8");
    expect(coverText).toMatch(
      /<text[^>]*>PROTOTYPE — NOT PRODUCTION RELEASED<\/text>/u
    );
    expect(coverText).toMatch(/<text[^>]*>Lifecycle: qualified<\/text>/u);
    expect(coverText).toMatch(/<text[^>]*>CONTROLLED PROTOTYPE ONLY<\/text>/u);
    expect(bundle.manifest.artifacts.find(
      (artifact) => artifact.generationRole === "cover"
    )).toMatchObject({
      path: "COVER.svg",
      sourceKind: "bundle_generated",
      lifecycle: "qualified",
      createdAt: null,
      staleAt: null
    });
  });

  it("keeps release external, exact, separately authorized, and revocable", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "physical-evidence-1",
      "EVL-001"
    );
    const physical = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(physical.overallVerdict).toBe("pass");
    expect(physical.evidence.validationStatus).toBe("pass");
    expect(physical.rawArtifact.lifecycle).toBe("candidate");
    expect(physical.parsedArtifact.lifecycle).toBe("candidate");
    expect(externalEvidenceResultSchema.parse(physical)).toEqual(physical);
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const qualification = await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Physical evidence and exact candidate reviewed.",
        scope: "reference board EVL-001 only",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "qualify-physical-01"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const releaseAuthority = {
      type: "human" as const,
      id: "release-1",
      displayName: "Release Authority",
      role: "release_authority" as const
    };
    const afterQualification = await service.getRunStatus({ runId: completed.run.id });
    const release = await service.authorizeManufacturingRelease(
      {
        revisionId: revision.id,
        subjectDigest: revision.manifest.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        qualificationApprovalId: qualification.approval.id,
        actor: releaseAuthority,
        scope: "exact reference build only",
        rationale: "Independent release review completed.",
        expectedRevision: afterQualification.run.revision,
        idempotencyKey: "manufacturing-release-1"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    expect(release.effectiveLifecycle).toBe("release_authorized");
    expect((await service.getRunStatus({ runId: completed.run.id })).run.lifecycle).toBe("candidate");

    const beforeArchiveCheck = await service.getRunStatus({ runId: completed.run.id });
    const candidateBundle = await service.exportCandidateBundle({
      revisionId: revision.id,
      expectedRevision: beforeArchiveCheck.run.revision,
      idempotencyKey: "physical-source-archive-check"
    });
    const outerArchive = unzipSync(Buffer.from(candidateBundle.bytesBase64, "base64"));
    const rawArchivePath = Object.keys(outerArchive).find(
      (entry) => entry.includes(`/${physical.rawArtifact.id}/`) && entry.endsWith("-sources.zip")
    );
    expect(rawArchivePath).toBeDefined();
    const sourceArchive = unzipSync(outerArchive[rawArchivePath!]!);
    const sourcePaths = Object.keys(sourceArchive).filter((entry) => entry !== "manifest.json");
    expect(sourcePaths.every((entry) => /^sources\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/u.test(entry))).toBe(true);
    expect(new Set(sourcePaths).size).toBe(sourcePaths.length);

    const beforeRevoke = await service.getRunStatus({ runId: completed.run.id });
    const revoked = await service.revokeAttestation(
      {
        approvalId: release.approval.id,
        actor: releaseAuthority,
        reason: "Fixture calibration was withdrawn.",
        expectedRevision: beforeRevoke.run.revision,
        idempotencyKey: "revoke-release-0001"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    expect(revoked.effectiveLifecycle).toBe("qualified");
    expect(revoked.approval.revokedAt).toBeDefined();
    expect(qualification.approval.revokedAt).toBeUndefined();
  });

  it("rejects arbitrary, incomplete, duplicate, and invalid physical observation declarations", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "physical-schema-adversarial",
      "SCHEMA-001"
    );
    const withCallerVerdict = { ...input, verdict: "pass", measurements: {} };
    expect(submitExternalEvidenceInputSchema.safeParse(withCallerVerdict).success).toBe(false);

    const submit = (candidate: SubmitExternalEvidenceInput) =>
      service.submitExternalEvidence(
        candidate,
        localHumanContext(qualifier, "hardware_qualification")
      );
    const missingCategory = rewritePhysicalJsonSource(input, "parsed_measurement_record", (record) => {
      record.caseExecutions = record.caseExecutions.filter(
        (execution: { caseId: string }) => execution.caseId !== "sensor-power-normal"
      );
    });
    await expect(submit(missingCategory)).rejects.toMatchObject({ code: "EVIDENCE_MISSING" });

    const duplicateObservation = rewritePhysicalJsonSource(input, "parsed_measurement_record", (record) => {
      const execution = record.caseExecutions.find(
        (candidate: { observations: unknown[] }) => candidate.observations.length > 1
      );
      execution.observations[1].testId = execution.observations[0].testId;
    });
    await expect(submit(duplicateObservation)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const invalidUnit = rewritePhysicalJsonSource(input, "parsed_measurement_record", (record) => {
      record.caseExecutions
        .flatMap((execution: { observations: unknown[] }) => execution.observations)
        .find((observation: { kind: string }) => observation.kind === "numeric_range").unit = "volts-ish";
    });
    await expect(submit(invalidUnit)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const callerLimits = rewritePhysicalJsonSource(input, "parsed_measurement_record", (record) => {
      const numeric = record.caseExecutions
        .flatMap((execution: { observations: unknown[] }) => execution.observations)
        .find(
        (observation: { kind: string }) => observation.kind === "numeric_range"
      );
      numeric.minimum = -1_000_000;
      numeric.maximum = 1_000_000;
    });
    await expect(submit(callerLimits)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      completed.run.revision
    );
  });

  it("verifies source bytes and exact current-head artifact identities before committing", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "physical-integrity-adversarial",
      "INTEGRITY-001"
    );
    const corruptSource = structuredClone(input);
    const sourceBytes = Buffer.from(corruptSource.sourceBlobs[2]!.bytesBase64, "base64");
    sourceBytes[0] = sourceBytes[0]! ^ 1;
    corruptSource.sourceBlobs[2]!.bytesBase64 = sourceBytes.toString("base64");
    await expect(
      service.submitExternalEvidence(
        corruptSource,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });

    const wrongIdentity = structuredClone(input);
    wrongIdentity.artifactBindings.bom.identity.digest = "0".repeat(64);
    await expect(
      service.submitExternalEvidence(
        wrongIdentity,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });

    const missingArtifact = structuredClone(input);
    missingArtifact.artifactBindings.bom.artifactId = "artifact_missing_physical_bom";
    await expect(
      service.submitExternalEvidence(
        missingArtifact,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "EVIDENCE_STALE" });

    const listed = await service.listArtifacts({
      runId: completed.run.id,
      revisionId: completed.headRevision!.id,
      includeStale: false
    });
    const bindingFor = (logicalName: string) => {
      const artifact = listed.artifacts.find((candidate) => candidate.logicalName === logicalName)!;
      return { artifactId: artifact.id, identity: artifact.blob };
    };
    const looseFirmwareRole = structuredClone(input);
    looseFirmwareRole.artifactBindings.targetBuildReport = bindingFor("firmware/board-contract.json");
    await expect(
      service.submitExternalEvidence(
        looseFirmwareRole,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const incompleteCam = structuredClone(input);
    incompleteCam.artifactBindings.cam.artifacts[0] = bindingFor(
      "reports/kicad/manufacturing/drc.json"
    );
    await expect(
      service.submitExternalEvidence(
        incompleteCam,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const duplicateSourceIdentity = structuredClone(input);
    const firmwareSource = duplicateSourceIdentity.sourceBlobs.find(
      (source) => source.role === "flashed_firmware_binary"
    )!;
    const rawSource = duplicateSourceIdentity.sourceBlobs.find(
      (source) => source.role === "required_capture"
    )!;
    rawSource.identity = firmwareSource.identity;
    rawSource.bytesBase64 = firmwareSource.bytesBase64;
    expect(submitExternalEvidenceInputSchema.safeParse(duplicateSourceIdentity).success).toBe(false);
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      completed.run.revision
    );
  });

  it("records derived failures but excludes any failed observation from qualification", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const failed = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        completed.headRevision!.id,
        completed.run.revision,
        "physical-derived-failure",
        "FAILED-001",
        "rails"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(failed.overallVerdict).toBe("fail");
    expect(failed.categoryVerdicts.rails).toBe("fail");
    expect(failed.evidence.validationStatus).toBe("fail");
    const status = await service.getRunStatus({ runId: completed.run.id });
    await expect(
      service.qualifyRevision(
        {
          revisionId: completed.headRevision!.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: failed.evidenceRoot.digest,
          actor: qualifier,
          rationale: "A failed observation must never qualify.",
          scope: "failed physical record",
          expectedRevision: status.run.revision,
          idempotencyKey: "qualify-failed-physical"
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "GATE_FAILED" });
  });

  it("enforces policy-owned session and calibration freshness plus instrument capabilities", async () => {
    let current = new Date("2026-09-03T12:00:00.000Z");
    const service = await makeApplication(fixtureRegistry, undefined, { now: () => current });
    const completed = await createCompletedRun(service);
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "physical-policy-windows",
      "POLICY-001"
    );
    const missingCapability = rewritePhysicalJsonSource(
      input,
      "instrument_calibration",
      (record) => {
        record.capabilities = record.capabilities.filter(
          (capability: { capability: string }) => capability.capability !== "temperature"
        );
      }
    );
    await expect(
      service.submitExternalEvidence(
        missingCapability,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "GATE_FAILED" });

    const excessiveDuration = rewritePhysicalJsonSource(
      input,
      "parsed_measurement_record",
      (record) => { record.startedAt = "2026-09-01T00:00:00.000Z"; }
    );
    await expect(
      service.submitExternalEvidence(
        excessiveDuration,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "GATE_FAILED" });

    current = new Date("2026-09-20T12:00:00.000Z");
    await expect(
      service.submitExternalEvidence(
        input,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "EVIDENCE_STALE" });
    expect(
      submitExternalEvidenceInputSchema.safeParse({
        ...input,
        validUntil: "2099-01-01T00:00:00.000Z"
      }).success
    ).toBe(false);
  });

  it("replays the exact external evidence result after state changes", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "physical-idempotent-replay",
      "REPLAY-001"
    );
    const first = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    await service.qualifyRevision(
      {
        revisionId: completed.headRevision!.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: first.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Advance state before replaying the physical submission.",
        scope: "idempotency fixture",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "physical-replay-qualification"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const replay = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(replay).toEqual(first);
  });

  it("rejects an expired physical record before qualification", async () => {
    let current = new Date("2026-09-03T12:00:00.000Z");
    const service = await makeApplication(fixtureRegistry, undefined, { now: () => current });
    const completed = await createCompletedRun(service);
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "physical-expiry-record",
      "EXPIRY-001"
    );
    const physical = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    current = new Date("2026-11-05T00:00:00.000Z");
    const status = await service.getRunStatus({ runId: completed.run.id });
    await expect(
      service.qualifyRevision(
        {
          revisionId: completed.headRevision!.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          actor: qualifier,
          rationale: "Expired evidence must not qualify.",
          scope: "expiry fixture",
          expectedRevision: status.run.revision,
          idempotencyKey: "qualify-expired-physical"
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "GATE_FAILED" });
  });

  it("demotes stale qualification and release attestations after the complete evidence root changes", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const firstEvidence = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        completed.run.revision,
        "root-change-physical-0001",
        "ROOT-A"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterEvidence = await service.getRunStatus({ runId: completed.run.id });
    const qualification = await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: firstEvidence.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Reviewed root A.",
        scope: "root A only",
        expectedRevision: afterEvidence.run.revision,
        idempotencyKey: "root-change-qualify-0001"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterQualification = await service.getRunStatus({ runId: completed.run.id });
    const release = await service.authorizeManufacturingRelease(
      {
        revisionId: revision.id,
        subjectDigest: revision.manifest.digest,
        evidenceRootDigest: firstEvidence.evidenceRoot.digest,
        qualificationApprovalId: qualification.approval.id,
        actor: releaseAuthority,
        scope: "root A only",
        rationale: "Release review for root A.",
        expectedRevision: afterQualification.run.revision,
        idempotencyKey: "root-change-release-0001"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    expect(release.effectiveLifecycle).toBe("release_authorized");

    const beforeChangedEvidence = await service.getRunStatus({ runId: completed.run.id });
    const changedEvidence = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        beforeChangedEvidence.run.revision,
        "root-change-physical-0002",
        "ROOT-B-FAILED",
        "rails"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(changedEvidence.evidenceRoot.digest).not.toBe(firstEvidence.evidenceRoot.digest);

    const demoted = await service.getRunStatus({ runId: completed.run.id });
    expect(demoted.effectiveLifecycle).toBe("candidate");
    expect(demoted.activeAttestations.map((approval) => approval.kind)).toEqual(["requirements"]);
    await expect(
      service.exportPrototypeBundle({
        revisionId: revision.id,
        expectedRevision: demoted.run.revision,
        idempotencyKey: "root-change-prototype-0001"
      })
    ).rejects.toMatchObject({ code: "GATE_FAILED" });

    const revoked = await service.revokeAttestation(
      {
        approvalId: release.approval.id,
        actor: releaseAuthority,
        reason: "The bound evidence root is no longer current.",
        expectedRevision: demoted.run.revision,
        idempotencyKey: "root-change-revoke-0001"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    expect(revoked.effectiveLifecycle).toBe("candidate");
  });

  it("does not revive a release when a revoked qualification is replaced at the same root", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const physical = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        completed.run.revision,
        "dependency-physical-0001",
        "DEPENDENCY"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const originalQualification = await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Original qualification.",
        scope: "exact root",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "dependency-qualify-0001"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterOriginalQualification = await service.getRunStatus({ runId: completed.run.id });
    const originalRelease = await service.authorizeManufacturingRelease(
      {
        revisionId: revision.id,
        subjectDigest: revision.manifest.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        qualificationApprovalId: originalQualification.approval.id,
        actor: releaseAuthority,
        scope: "exact root",
        rationale: "Original release.",
        expectedRevision: afterOriginalQualification.run.revision,
        idempotencyKey: "dependency-release-0001"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    const beforeQualificationRevocation = await service.getRunStatus({ runId: completed.run.id });
    await service.revokeAttestation(
      {
        approvalId: originalQualification.approval.id,
        actor: qualifier,
        reason: "Qualification review withdrawn.",
        expectedRevision: beforeQualificationRevocation.run.revision,
        idempotencyKey: "dependency-revoke-0001"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterRevocation = await service.getRunStatus({ runId: completed.run.id });
    const replacementQualification = await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Replacement qualification review.",
        scope: "exact root",
        expectedRevision: afterRevocation.run.revision,
        idempotencyKey: "dependency-qualify-0002"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );

    const replacementStatus = await service.getRunStatus({ runId: completed.run.id });
    expect(replacementStatus.effectiveLifecycle).toBe("qualified");
    expect(replacementStatus.activeAttestations.map((approval) => approval.id)).not.toContain(
      originalRelease.approval.id
    );
    await expect(
      service.authorizeManufacturingRelease(
        {
          revisionId: revision.id,
          subjectDigest: revision.manifest.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          qualificationApprovalId: originalQualification.approval.id,
          actor: releaseAuthority,
          scope: "exact root",
          rationale: "Must not reuse a revoked dependency.",
          expectedRevision: replacementStatus.run.revision,
          idempotencyKey: "dependency-release-denied"
        },
        localHumanContext(releaseAuthority, "manufacturing_release")
      )
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const replacementRelease = await service.authorizeManufacturingRelease(
      {
        revisionId: revision.id,
        subjectDigest: revision.manifest.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        qualificationApprovalId: replacementQualification.approval.id,
        actor: releaseAuthority,
        scope: "exact root",
        rationale: "Fresh release review for the replacement qualification.",
        expectedRevision: replacementStatus.run.revision,
        idempotencyKey: "dependency-release-0002"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    expect(replacementRelease.effectiveLifecycle).toBe("release_authorized");
  });

  it("recomputes qualification and release eligibility from the locked transaction state", async () => {
    let guardedState!: BeforeTransactionStateStore;
    const fixedNow = new Date("2026-09-03T12:00:00.000Z");
    const service = await makeApplication(fixtureRegistry, undefined, {
      decorateState: (state) => {
        guardedState = new BeforeTransactionStateStore(state);
        return guardedState;
      },
      now: () => fixedNow
    });
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const physical = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        completed.run.revision,
        "transaction-physical-0001",
        "TRANSACTION"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const addConcurrentEvidence = (state: MutableEvlEdaState): void => {
      const currentRevision = state.revisions[revision.id]!;
      const source = state.evidence[currentRevision.evidenceIds[0]!]!;
      state.evidence.evidence_transaction_race = {
        ...source,
        id: "evidence_transaction_race",
        designRevisionId: revision.id,
        claim: "Transaction-local evidence root changed"
      };
    };

    guardedState.arm(addConcurrentEvidence);
    await expect(
      service.qualifyRevision(
        {
          revisionId: revision.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          actor: qualifier,
          rationale: "Stale preliminary root must not commit.",
          scope: "exact root",
          expectedRevision: afterPhysical.run.revision,
          idempotencyKey: "transaction-qualify-race"
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      Object.values((await guardedState.read()).approvals).filter(
        (approval) => approval.kind === "qualification"
      )
    ).toHaveLength(0);

    const qualification = await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Current root reviewed.",
        scope: "exact root",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "transaction-qualify-good"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterQualification = await service.getRunStatus({ runId: completed.run.id });

    guardedState.arm((state) => {
      const current = state.approvals[qualification.approval.id]!;
      state.approvals[qualification.approval.id] = {
        ...current,
        expiresAt: fixedNow.toISOString()
      };
    });
    await expect(
      service.authorizeManufacturingRelease(
        {
          revisionId: revision.id,
          subjectDigest: revision.manifest.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          qualificationApprovalId: qualification.approval.id,
          actor: releaseAuthority,
          scope: "exact root",
          rationale: "Expired qualification must fail in-lock.",
          expectedRevision: afterQualification.run.revision,
          idempotencyKey: "transaction-release-expired"
        },
        localHumanContext(releaseAuthority, "manufacturing_release")
      )
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    guardedState.arm(addConcurrentEvidence);
    await expect(
      service.authorizeManufacturingRelease(
        {
          revisionId: revision.id,
          subjectDigest: revision.manifest.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          qualificationApprovalId: qualification.approval.id,
          actor: releaseAuthority,
          scope: "exact root",
          rationale: "Stale preliminary release root must not commit.",
          expectedRevision: afterQualification.run.revision,
          idempotencyKey: "transaction-release-race"
        },
        localHumanContext(releaseAuthority, "manufacturing_release")
      )
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      Object.values((await guardedState.read()).approvals).filter(
        (approval) => approval.kind === "manufacturing_release"
      )
    ).toHaveLength(0);
  });
});

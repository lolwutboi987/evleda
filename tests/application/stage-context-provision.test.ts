import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { DomainError } from "../../src/domain/errors.js";
import { STAGE_ORDER, type StageKey } from "../../src/domain/stages.js";
import type {
  StageContextProvider,
  StageContextProviderRequest,
  StageContextProvision,
  StateStorePort,
} from "../../src/application/ports.js";
import {
  STAGE_CONTEXT_ENRICHMENT_SCHEMA,
  STAGE_PROVISION_SCHEMA
} from "../../src/application/ports.js";
import type {
  CandidateStageContext,
  StageContextByKey,
  StageExecutionResult,
  StageRegistryContract
} from "../../src/workflow/contracts.js";
import { UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA } from "../../src/workflow/contracts.js";
import {
  artifactDraft,
  evidenceDraft,
  finalizeStageResult
} from "../../src/generators/draft-utils.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";
import type { EvlEdaState, MutableEvlEdaState } from "../../src/persistence/state-store.js";
import {
  createApprovedRun,
  createCompletedRun,
  disposeApplicationRoots,
  fixtureRegistry,
  makeApplication
} from "./helpers.js";

afterEach(disposeApplicationRoots);

class ReadOverlayStateStore implements StateStorePort {
  public readonly root: string;

  public constructor(
    private readonly base: StateStorePort,
    private readonly overlay: (state: MutableEvlEdaState) => void,
  ) {
    this.root = base.root;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public async read(): Promise<EvlEdaState> {
    const snapshot = structuredClone(await this.base.read()) as MutableEvlEdaState;
    this.overlay(snapshot);
    return snapshot as unknown as EvlEdaState;
  }

  public transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>,
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    return this.base.transaction(expectedRevision, mutate);
  }
}

const provisionFor = (
  request: StageContextProviderRequest,
  variant: string
): StageContextProvision => {
  const provisionManifest = {
    schemaVersion: STAGE_PROVISION_SCHEMA,
    request: {
      projectId: request.project.id,
      projectPolicyVersion: request.project.policyVersion,
      runId: request.run.id,
      workflowVersion: request.run.workflowVersion,
      configuration: request.run.configuration,
      revisionId: request.revision.id,
      revisionManifest: request.revision.manifest,
      stage: request.stage
    },
    enrichmentIdentity: canonicalIdentity(
      {
        profile: null,
        curatedDatasheets: null,
        sourcing: null,
        lifecycleObservations: null,
        pinPadMappingReviews: null,
        footprintLibrary: null,
        firmwareCompileConfiguration: null,
        firmwareTargetBuildConfiguration: null
      },
      STAGE_CONTEXT_ENRICHMENT_SCHEMA
    ),
    backends: { kicad: null, simulation: null, firmwareCompile: null, firmwareTargetBuild: null },
    providerEvidence: { fixture: "application-stage-context", variant }
  } as const;
  return {
    provisionManifest,
    provisionIdentity: canonicalIdentity(provisionManifest, STAGE_PROVISION_SCHEMA)
  };
};

const alwaysBlockedRegistry = (): StageRegistryContract => ({
  orderedStages: () => fixtureRegistry.orderedStages(),
  has: (stage) => fixtureRegistry.has(stage),
  get: <K extends StageKey>(stage: K) => ({
    stage,
    execute: async (context: StageContextByKey[K]): Promise<StageExecutionResult<K>> => {
      if (stage === "requirements") {
        throw new Error("Requirements are handled by the application service");
      }
      const candidate = context as CandidateStageContext;
      return finalizeStageResult(
        stage,
        [],
        [],
        [
          {
            code: "FIXTURE_STAGE_BLOCKED",
            message: "Keep the first candidate stage available for another provisioning attempt.",
            affectedInputDigests: [candidate.requirements.identity.digest],
            requiredAction: "Retry the fixture stage.",
            retryable: true
          }
        ]
      ) as StageExecutionResult<K>;
    }
  }),
  execute: async <K extends StageKey>(
    stage: K,
    context: StageContextByKey[K]
  ): Promise<StageExecutionResult<K>> => alwaysBlockedRegistry().get(stage).execute(context)
});

const resume = async (
  service: Awaited<ReturnType<typeof makeApplication>>,
  runId: string,
  expectedRevision: number,
  suffix: string
) =>
  service.resumeRun({
    runId,
    expectedRevision,
    idempotencyKey: `stage-context-resume-${suffix}`
  });

describe("ApplicationService stage-context provisioning", () => {
  it("requests context once for every candidate stage using the current project, run, and head revision", async () => {
    const requests: StageContextProviderRequest[] = [];
    const provider: StageContextProvider = {
      provide: async (request) => {
        requests.push(request);
        return provisionFor(request, request.stage);
      }
    };
    const service = await makeApplication(fixtureRegistry, provider);

    const completed = await createCompletedRun(service);

    expect(completed.run.state).toBe("completed");
    expect(requests.map(({ stage }) => stage)).toEqual(STAGE_ORDER.slice(1));
    expect(new Set(requests.map(({ project }) => project.id))).toEqual(
      new Set([completed.project.id])
    );
    expect(new Set(requests.map(({ run }) => run.id))).toEqual(new Set([completed.run.id]));
    expect(requests.every(({ project, run }) => run.projectId === project.id)).toBe(true);
    expect(requests.every(({ revision, run }) => revision.id === run.headRevisionId)).toBe(true);
    expect(new Set(requests.map(({ revision }) => revision.id)).size).toBe(requests.length);
    for (const stage of STAGE_ORDER.slice(1)) {
      const attempt = completed.run.attempts[stage].at(-1)!;
      expect(attempt.provisionIdentity).toEqual(expect.objectContaining({
        schemaVersion: STAGE_PROVISION_SCHEMA
      }));
      expect(attempt.provisionManifestBlob).toEqual(expect.objectContaining({
        algorithm: "sha256",
        size: expect.any(Number)
      }));
      expect(attempt.outputIdentity).toEqual(expect.objectContaining({
        schemaVersion: `evleda.stage-result.${stage}.v1`
      }));
      expect(attempt.executionFence?.inputManifest).toEqual(attempt.inputManifest);
    }
  });

  it("keeps the input manifest stable for the same provision and changes it when only the provision changes", async () => {
    const variants = ["stable", "stable", "changed"];
    let call = 0;
    const provider: StageContextProvider = {
      provide: async (request) => provisionFor(request, variants[call++]!)
    };
    const service = await makeApplication(alwaysBlockedRegistry(), provider);
    const approved = await createApprovedRun(service);

    const first = await resume(service, approved.run.id, approved.run.revision, "identity-01");
    const second = await resume(service, first.run.id, first.run.revision, "identity-02");
    const third = await resume(service, second.run.id, second.run.revision, "identity-03");

    const attempts = third.run.attempts.system_architecture;
    expect(attempts).toHaveLength(3);
    expect(attempts[0]!.inputManifest).toEqual(attempts[1]!.inputManifest);
    expect(attempts[2]!.inputManifest).not.toEqual(attempts[1]!.inputManifest);
  });

  it.each([
    ["algorithm", { algorithm: "sha512" }],
    ["digest", { digest: "A".repeat(64) }],
    ["schema", { schemaVersion: "evleda.stage-provision.v2" }],
    [
      "canonicalization",
      {
        canonicalizationVersion: "different-canonicalization"
      }
    ]
  ])("blocks before executor dispatch for an invalid provision %s", async (_field, invalid) => {
    const execute = vi.fn();
    const registry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: () => true,
      get: <K extends StageKey>(stage: K) => ({
        stage,
        execute: execute as (context: StageContextByKey[K]) => Promise<StageExecutionResult<K>>
      }),
      execute: execute as StageRegistryContract["execute"]
    };
    const provider: StageContextProvider = {
      provide: async (request) => {
        const valid = provisionFor(request, `bad-${_field}`);
        return {
          ...valid,
          provisionIdentity: { ...valid.provisionIdentity, ...invalid }
        } as unknown as StageContextProvision;
      }
    };
    const service = await makeApplication(registry, provider);
    const approved = await createApprovedRun(service);

    const blocked = await resume(service, approved.run.id, approved.run.revision, `invalid-${_field}`);

    expect(execute).not.toHaveBeenCalled();
    expect(blocked.run.state).toBe("blocked");
    expect(blocked.blockers).toEqual([
      expect.objectContaining({
        code: "TOOL_RESULT_INCONCLUSIVE",
        stage: "system_architecture",
        retryable: true
      })
    ]);
    const attempt = blocked.run.attempts.system_architecture.at(-1)!;
    expect(attempt.blockers[0]!.affectedInputDigests).toHaveLength(2);
    expect(attempt.blockers[0]!.affectedInputDigests).toContain(attempt.inputManifest.digest);
    expect(attempt.blockers[0]!.affectedInputDigests.every((digest) => /^[0-9a-f]{64}$/u.test(digest))).toBe(true);
  });

  it.each([
    {
      name: "typed retryable failure",
      error: new DomainError(
        "EVIDENCE_STALE",
        "The captured stage-context evidence is stale.",
        { snapshot: "fixture" },
        true
      ),
      code: "EVIDENCE_STALE",
      message: "The captured stage-context evidence is stale."
    },
    {
      name: "unexpected failure",
      error: new Error("fixture parser failure"),
      code: "TOOLCHAIN_UNAVAILABLE",
      message: "Stage context provisioning failed for system_architecture."
    }
  ])("persists $name as a retryable provisioning blocker", async ({ error, code, message }) => {
    const execute = vi.fn();
    const registry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: () => true,
      get: <K extends StageKey>(stage: K) => ({
        stage,
        execute: execute as (context: StageContextByKey[K]) => Promise<StageExecutionResult<K>>
      }),
      execute: execute as StageRegistryContract["execute"]
    };
    const provider: StageContextProvider = {
      provide: async () => {
        throw error;
      }
    };
    const service = await makeApplication(registry, provider);
    const approved = await createApprovedRun(service);

    const blocked = await resume(service, approved.run.id, approved.run.revision, `failure-${code}`);

    expect(execute).not.toHaveBeenCalled();
    expect(blocked.blockers).toEqual([
      expect.objectContaining({ code, message, stage: "system_architecture", retryable: true })
    ]);
    const attempt = blocked.run.attempts.system_architecture.at(-1)!;
    expect(attempt.state).toBe("blocked");
    expect(attempt.blockers[0]!.affectedInputDigests).toHaveLength(2);
    expect(attempt.blockers[0]!.affectedInputDigests).toContain(attempt.inputManifest.digest);
  });

  it("rejects enrichment that is not represented by the canonical provision manifest", async () => {
    const execute = vi.fn();
    const registry: StageRegistryContract = {
      ...alwaysBlockedRegistry(),
      execute: execute as StageRegistryContract["execute"]
    };
    const provider: StageContextProvider = {
      provide: async (request) => ({
        ...provisionFor(request, "detached-enrichment"),
        profile: ROBOTICS_CONTROLLER_V0
      })
    };
    const service = await makeApplication(registry, provider);
    const approved = await createApprovedRun(service);
    const blocked = await resume(
      service,
      approved.run.id,
      approved.run.revision,
      "detached-enrichment"
    );

    expect(execute).not.toHaveBeenCalled();
    expect(blocked.blockers).toEqual([
      expect.objectContaining({ code: "TOOL_RESULT_INCONCLUSIVE", retryable: true })
    ]);
  });

  it("rejects a stage result whose declared output identity does not reproduce its bytes and claims", async () => {
    const base = alwaysBlockedRegistry();
    const registry: StageRegistryContract = {
      ...base,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await base.execute(stage, context);
        return {
          ...result,
          outputIdentity: { ...result.outputIdentity, digest: "0".repeat(64) }
        } as StageExecutionResult<K>;
      }
    };
    const service = await makeApplication(registry, {
      provide: async (request) => provisionFor(request, "output-identity-tamper")
    });
    const approved = await createApprovedRun(service);
    const blocked = await resume(
      service,
      approved.run.id,
      approved.run.revision,
      "output-identity-tamper"
    );
    const attempt = blocked.run.attempts.system_architecture.at(-1)!;

    expect(attempt.state).toBe("blocked");
    expect(attempt.outputIdentity).toBeUndefined();
    expect(attempt.artifactIds).toEqual([]);
    expect(attempt.blockers.map((entry) => entry.code)).toContain("DIGEST_MISMATCH");
  });

  it("reconstructs every upstream stage with the exact output identity stored on its attempt", async () => {
    const returned = new Map<StageKey, StageExecutionResult>();
    const reconstructedSourceBindings: {
      readonly targetStage: Exclude<StageKey, "requirements">;
      readonly targetDesignRevisionId: string;
      readonly bindings: CandidateStageContext["upstreamSourceRevisionBindings"];
    }[] = [];
    const reconstructedLineage: {
      readonly stage: StageKey;
      readonly actual: readonly { readonly logicalName: string; readonly derivedFrom: readonly string[] }[];
      readonly expected: readonly { readonly logicalName: string; readonly derivedFrom: readonly string[] }[];
    }[] = [];
    const registry: StageRegistryContract = {
      ...fixtureRegistry,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        if (stage !== "requirements") {
          const candidate = context as CandidateStageContext;
          reconstructedSourceBindings.push({
            targetStage: stage,
            targetDesignRevisionId: candidate.designRevisionId,
            bindings: structuredClone(candidate.upstreamSourceRevisionBindings)
          });
          for (const upstream of candidate.upstream) {
            if (upstream.stage === "requirements") continue;
            const original = returned.get(upstream.stage);
            expect(upstream.outputIdentity).toEqual(original?.outputIdentity);
            reconstructedLineage.push({
              stage: upstream.stage,
              actual: upstream.artifacts.map((artifact) => ({
                logicalName: artifact.logicalName,
                derivedFrom: artifact.derivedFrom,
              })),
              expected: original?.artifacts.map((artifact) => ({
                logicalName: artifact.logicalName,
                derivedFrom: artifact.derivedFrom,
              })) ?? [],
            });
          }
        }
        const result = await fixtureRegistry.execute(stage, context);
        returned.set(stage, result);
        return result;
      }
    };
    const service = await makeApplication(registry, {
      provide: async (request) => provisionFor(request, `reconstruct-${request.stage}`)
    });
    const completed = await createCompletedRun(service);

    expect(completed.run.state).toBe("completed");
    for (const stage of STAGE_ORDER.slice(1)) {
      expect(completed.run.attempts[stage].at(-1)!.outputIdentity).toEqual(
        returned.get(stage)!.outputIdentity
      );
    }
    for (const lineage of reconstructedLineage) {
      expect(lineage.actual, lineage.stage).toEqual(lineage.expected);
    }
    const listed = await service.listArtifacts({
      runId: completed.run.id,
      includeStale: true
    });
    for (const captured of reconstructedSourceBindings) {
      const expectedStages = STAGE_ORDER.slice(1, STAGE_ORDER.indexOf(captured.targetStage));
      expect(captured.bindings.map((binding) => binding.stage)).toEqual(expectedStages);
      expect(new Set(captured.bindings.map((binding) => binding.stage)).size).toBe(
        captured.bindings.length
      );
      const immediate = captured.bindings.at(-1);
      if (immediate !== undefined) {
        expect(immediate.committedRevision.id).toBe(captured.targetDesignRevisionId);
      }
      for (const binding of captured.bindings) {
        const attempt = completed.run.attempts[binding.stage].find(
          (candidate) => candidate.id === binding.attemptId
        )!;
        expect(binding.sourceRevision.id).toBe(attempt.executionFence?.parentRevisionId);
        expect(binding.stageInputManifest).toEqual(attempt.inputManifest);
        expect(binding.stageOutputIdentity).toEqual(attempt.outputIdentity);
        expect(
          listed.artifacts.find((artifact) => attempt.artifactIds.includes(artifact.id))
            ?.designRevisionId
        ).toBe(binding.committedRevision.id);
        const { identity: _identity, ...payload } = binding;
        expect(binding.identity).toEqual(
          canonicalIdentity(payload, UPSTREAM_STAGE_SOURCE_REVISION_BINDING_SCHEMA)
        );
      }
    }
  });

  it.each([
    ["relabelled attempt", "relabel", "component_selection"],
    ["cross-run artifact", "cross-run", "component_selection"],
    ["cross-attempt output", "cross-attempt", "schematic"]
  ] as const)(
    "fails closed before target dispatch for a %s in reconstructed upstream lineage",
    async (_name, variant, targetStage) => {
      let providerCalls = 0;
      let executorCalls = 0;
      const registry: StageRegistryContract = {
        ...fixtureRegistry,
        execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
          if (stage === targetStage) executorCalls += 1;
          return fixtureRegistry.execute(stage, context);
        }
      };
      const service = await makeApplication(registry, {
        provide: async (request) => {
          if (request.stage === targetStage) providerCalls += 1;
          return provisionFor(request, `upstream-binding-${variant}`);
        }
      }, {
        decorateState: (base) => new ReadOverlayStateStore(base, (state) => {
          const run = Object.values(state.runs).find((candidate) =>
            candidate.attempts.system_architecture.some(
              (attempt) => attempt.state === "succeeded"
            )
          );
          const systemAttempt = run?.attempts.system_architecture.findLast(
            (attempt) => attempt.state === "succeeded"
          );
          if (run === undefined || systemAttempt === undefined) return;
          if (variant === "relabel") {
            (systemAttempt as { stage: StageKey }).stage = "component_selection";
            return;
          }
          if (variant === "cross-run") {
            const artifactId = systemAttempt.artifactIds[0];
            const artifact = artifactId === undefined ? undefined : state.artifacts[artifactId];
            if (artifactId !== undefined && artifact !== undefined) {
              state.artifacts[artifactId] = {
                ...artifact,
                runId: "run_foreign_source_revision_binding"
              };
            }
            return;
          }
          const componentAttempt = run.attempts.component_selection.findLast(
            (attempt) => attempt.state === "succeeded"
          );
          if (componentAttempt?.outputIdentity !== undefined) {
            (systemAttempt as { outputIdentity: typeof componentAttempt.outputIdentity })
              .outputIdentity = componentAttempt.outputIdentity;
          }
        })
      });
      const approved = await createApprovedRun(service);

      await expect(resume(
        service,
        approved.run.id,
        approved.run.revision,
        `upstream-binding-${variant}`
      )).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
      expect(providerCalls).toBe(0);
      expect(executorCalls).toBe(0);
    }
  );

  it.each(["missing", "foreign-run"] as const)(
    "fails closed before provider or executor dispatch for a %s persisted lineage dependency",
    async (variant) => {
      let providerCalls = 0;
      let executorCalls = 0;
      const registry: StageRegistryContract = {
        ...fixtureRegistry,
        execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
          if (stage === "component_selection") executorCalls += 1;
          return fixtureRegistry.execute(stage, context);
        },
      };
      const provider: StageContextProvider = {
        provide: async (request) => {
          if (request.stage === "component_selection") providerCalls += 1;
          return provisionFor(request, `lineage-${variant}`);
        },
      };
      const service = await makeApplication(registry, provider, {
        decorateState: (base) => new ReadOverlayStateStore(base, (state) => {
          const run = Object.values(state.runs).find((candidate) =>
            candidate.attempts.system_architecture.some((attempt) => attempt.state === "succeeded")
          );
          const attempt = run?.attempts.system_architecture.findLast(
            (candidate) => candidate.state === "succeeded",
          );
          const artifactId = attempt?.artifactIds[0];
          const artifact = artifactId === undefined ? undefined : state.artifacts[artifactId];
          if (artifact === undefined || artifactId === undefined) return;
          const dependencyId = variant === "missing" ? "artifact_missing_lineage" : "artifact_foreign_lineage";
          if (variant === "foreign-run") {
            state.artifacts[dependencyId] = {
              ...artifact,
              id: dependencyId,
              projectId: "project_foreign_lineage",
              runId: "run_foreign_lineage",
              designRevisionId: "revision_foreign_lineage",
              derivedFrom: [],
            };
          }
          state.artifacts[artifactId] = { ...artifact, derivedFrom: [dependencyId] };
        }),
      });
      const approved = await createApprovedRun(service);

      await expect(resume(
        service,
        approved.run.id,
        approved.run.revision,
        `lineage-${variant}`,
      )).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
      expect(providerCalls).toBe(0);
      expect(executorCalls).toBe(0);
    },
  );

  it("retains exact blocked diagnostics on the current candidate without creating a successful revision", async () => {
    const base = alwaysBlockedRegistry();
    const registry: StageRegistryContract = {
      ...base,
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
      if (stage === "requirements") throw new Error("Requirements are application-owned");
      const candidate = context as CandidateStageContext;
      const report = artifactDraft({
        logicalName: "diagnostics/system-architecture-check.json",
        mediaType: "application/json",
        content: '{"status":"fail"}\n',
        exactInputs: [candidate.requirements.identity],
        validationStatus: "fail"
      });
      return finalizeStageResult(
        stage,
        [report],
        [
          evidenceDraft({
            evidenceClass: "evleda_check",
            claim: "The deterministic architecture diagnostic failed.",
            subjectDigests: [report.identity.digest],
            parsedArtifactLogicalName: report.logicalName,
            exactInputs: [candidate.requirements.identity],
            validationStatus: "fail"
          })
        ],
        [
          {
            code: "FIXTURE_DIAGNOSTIC_FAILED",
            message: "The fixture diagnostic failed.",
            affectedInputDigests: [candidate.requirements.identity.digest],
            requiredAction: "Correct the fixture input and rerun.",
            retryable: true
          }
        ]
      ) as StageExecutionResult<K>;
      }
    };
    const service = await makeApplication(registry, {
      provide: async (request) => provisionFor(request, "blocked-diagnostics")
    });
    const approved = await createApprovedRun(service);
    const parentId = approved.headRevision!.id;
    const blocked = await resume(
      service,
      approved.run.id,
      approved.run.revision,
      "blocked-diagnostics"
    );
    const attempt = blocked.run.attempts.system_architecture.at(-1)!;
    const listed = await service.listArtifacts({
      runId: blocked.run.id,
      revisionId: parentId,
      includeStale: true
    });
    const inspected = await service.inspectEvidence({
      runId: blocked.run.id,
      revisionId: parentId,
      includeStale: true
    });

    expect(blocked.headRevision!.id).toBe(parentId);
    expect(attempt.outputIdentity).toBeDefined();
    expect(attempt.artifactIds).toHaveLength(1);
    expect(attempt.evidenceIds.length).toBeGreaterThanOrEqual(2);
    expect(listed.artifacts).toContainEqual(expect.objectContaining({
      id: attempt.artifactIds[0],
      designRevisionId: parentId,
      lifecycle: "candidate",
      validationStatus: "fail"
    }));
    expect(inspected.evidence.filter((entry) =>
      attempt.evidenceIds.includes(entry.id) && entry.validationStatus === "fail"
    ).length).toBeGreaterThanOrEqual(2);
  });
});

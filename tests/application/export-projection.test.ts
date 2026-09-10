import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import type { StateStorePort } from "../../src/application/ports.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import type { StageKey } from "../../src/domain/stages.js";
import type { EvlEdaState, MutableEvlEdaState } from "../../src/persistence/state-store.js";
import { finalizeStageResult } from "../../src/generators/draft-utils.js";
import type { StageContextByKey, StageRegistryContract } from "../../src/workflow/contracts.js";
import {
  createCompletedRun,
  disposeApplicationRoots,
  fixtureRegistry,
  makeApplication,
  physicalEvidenceInput,
  qualifier
} from "./helpers.js";

class ProjectedReadStateStore implements StateStorePort {
  readonly root: string;
  #project: ((state: MutableEvlEdaState) => void) | undefined;

  public constructor(private readonly base: StateStorePort) {
    this.root = base.root;
  }

  public setProjection(project: (state: MutableEvlEdaState) => void): void {
    this.#project = project;
  }

  public clearProjection(): void {
    this.#project = undefined;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public async read(): Promise<EvlEdaState> {
    const snapshot = await this.base.read();
    if (this.#project === undefined) return snapshot;
    const projected = structuredClone(snapshot) as MutableEvlEdaState;
    this.#project(projected);
    return projected as EvlEdaState;
  }

  public transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    return this.base.transaction(expectedRevision, mutate);
  }
}

const makeProjectedApplication = async (registry: StageRegistryContract = fixtureRegistry) => {
  let state!: ProjectedReadStateStore;
  const service = await makeApplication(registry, undefined, {
    decorateState: (base) => {
      state = new ProjectedReadStateStore(base);
      return state;
    }
  });
  return { service, state };
};

const sorted = (values: readonly string[]): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right, "en"));

afterEach(disposeApplicationRoots);

describe("complete export and qualification projection", () => {
  it("fails closed for a legacy revision whose canonical manifest preimage was never persisted", async () => {
    const { service, state } = await makeProjectedApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    state.setProjection((snapshot) => {
      const current = snapshot.revisions[revision.id]!;
      const { manifestRecordBlob: _legacyMissingRecord, ...legacy } = current;
      snapshot.revisions[revision.id] = legacy;
    });

    await expect(
      service.exportCandidateBundle({
        revisionId: revision.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: "projection-legacy-revision-denied"
      })
    ).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      details: { revisionId: revision.id }
    });
  });

  it("rejects failed post-revision physical evidence and its referenced artifacts", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const failed = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        completed.run.revision,
        "projection-failed-physical",
        "PROJECTION-FAIL",
        "rails"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    const status = await service.getRunStatus({ runId: completed.run.id });
    const expectedArtifactIds = sorted([failed.rawArtifact.id, failed.parsedArtifact.id]);
    const expectedDetails = {
      artifactIds: expectedArtifactIds,
      evidenceIds: [failed.evidence.id]
    };

    await expect(
      service.exportCandidateBundle({
        revisionId: revision.id,
        expectedRevision: status.run.revision,
        idempotencyKey: "projection-export-failed-physical"
      })
    ).rejects.toMatchObject({ code: "GATE_FAILED", details: expectedDetails });

    await expect(
      service.qualifyRevision(
        {
          revisionId: revision.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: failed.evidenceRoot.digest,
          actor: qualifier,
          rationale: "A failed complete projection cannot be qualified.",
          scope: "failed projection",
          expectedRevision: status.run.revision,
          idempotencyKey: "projection-qualify-failed-physical"
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "GATE_FAILED", details: expectedDetails });
  });

  it("vetoes failed, stale, blocking, expired, dangling, and cross-run projected records", async () => {
    const { service, state } = await makeProjectedApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const physical = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        completed.run.revision,
        "projection-corruption-source",
        "PROJECTION-CORRUPTION"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    const status = await service.getRunStatus({ runId: completed.run.id });
    let key = 0;
    const expectFailure = async (
      project: (snapshot: MutableEvlEdaState) => void,
      expected: Readonly<Record<string, unknown>>
    ): Promise<void> => {
      state.setProjection(project);
      try {
        await expect(
          service.exportCandidateBundle({
            revisionId: revision.id,
            expectedRevision: status.run.revision,
            idempotencyKey: `projection-corruption-export-${String(key += 1)}`
          })
        ).rejects.toMatchObject(expected);
      } finally {
        state.clearProjection();
      }
    };

    await expectFailure(
      (snapshot) => {
        const artifact = snapshot.artifacts[physical.rawArtifact.id]!;
        snapshot.artifacts[artifact.id] = { ...artifact, validationStatus: "fail" };
      },
      {
        code: "GATE_FAILED",
        details: { artifactIds: [physical.rawArtifact.id], evidenceIds: [] }
      }
    );
    await expectFailure(
      (snapshot) => {
        const artifact = snapshot.artifacts[physical.parsedArtifact.id]!;
        snapshot.artifacts[artifact.id] = {
          ...artifact,
          unresolvedAssumptions: [
            {
              id: "projection-blocking-artifact",
              statement: "Projected parsed evidence is unresolved.",
              severity: "blocking",
              sourceRequirementIds: []
            }
          ]
        };
      },
      {
        code: "GATE_FAILED",
        details: { artifactIds: [physical.parsedArtifact.id], evidenceIds: [] }
      }
    );
    await expectFailure(
      (snapshot) => {
        const artifact = snapshot.artifacts[physical.rawArtifact.id]!;
        snapshot.artifacts[artifact.id] = {
          ...artifact,
          staleAt: "2026-09-04T00:00:00.000Z"
        };
      },
      {
        code: "GATE_FAILED",
        details: { artifactIds: [physical.rawArtifact.id], evidenceIds: [] }
      }
    );
    await expectFailure(
      (snapshot) => {
        const evidence = snapshot.evidence[physical.evidence.id]!;
        snapshot.evidence[evidence.id] = {
          ...evidence,
          validUntil: "2000-01-01T00:00:00.000Z"
        };
      },
      {
        code: "GATE_FAILED",
        details: { artifactIds: [], evidenceIds: [physical.evidence.id] }
      }
    );
    await expectFailure(
      (snapshot) => {
        const evidence = snapshot.evidence[physical.evidence.id]!;
        snapshot.evidence[evidence.id] = {
          ...evidence,
          evidenceClass: "evleda_check",
          validationStatus: "not_run"
        };
      },
      {
        code: "GATE_FAILED",
        details: { artifactIds: [], evidenceIds: [physical.evidence.id] }
      }
    );
    await expectFailure(
      (snapshot) => {
        const evidence = snapshot.evidence[physical.evidence.id]!;
        snapshot.evidence[evidence.id] = {
          ...evidence,
          unresolvedAssumptions: [
            {
              id: "projection-blocking-evidence",
              statement: "Projected evidence is unresolved.",
              severity: "blocking",
              sourceRequirementIds: []
            }
          ]
        };
      },
      {
        code: "GATE_FAILED",
        details: { artifactIds: [], evidenceIds: [physical.evidence.id] }
      }
    );
    await expectFailure(
      (snapshot) => {
        const evidence = snapshot.evidence[physical.evidence.id]!;
        snapshot.evidence[evidence.id] = {
          ...evidence,
          rawArtifactId: "artifact_projection_missing"
        };
      },
      {
        code: "ARTIFACT_INTEGRITY_ERROR",
        details: { artifactId: "artifact_projection_missing", revisionId: revision.id }
      }
    );
    await expectFailure(
      (snapshot) => {
        const artifact = snapshot.artifacts[physical.rawArtifact.id]!;
        snapshot.artifacts[artifact.id] = { ...artifact, runId: "run_projection_other" };
      },
      {
        code: "ARTIFACT_INTEGRITY_ERROR",
        details: { artifactId: physical.rawArtifact.id, artifactRunId: "run_projection_other" }
      }
    );
    await expectFailure(
      (snapshot) => {
        const evidence = snapshot.evidence[physical.evidence.id]!;
        snapshot.evidence[evidence.id] = { ...evidence, runId: "run_projection_other" };
      },
      {
        code: "ARTIFACT_INTEGRITY_ERROR",
        details: { evidenceId: physical.evidence.id, revisionId: revision.id }
      }
    );
  });

  it("serializes exactly one passing projected evidence and artifact closure", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const physical = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        completed.run.revision,
        "projection-positive-physical",
        "PROJECTION-PASS"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    const status = await service.getRunStatus({ runId: completed.run.id });
    const bundle = await service.exportCandidateBundle({
      revisionId: revision.id,
      expectedRevision: status.run.revision,
      idempotencyKey: "projection-positive-export"
    });
    const files = unzipSync(Buffer.from(bundle.bytesBase64, "base64"));
    const evidencePath = Object.keys(files).find((name) => name.endsWith("/evidence/evidence.json"));
    expect(evidencePath).toBeDefined();
    const inventory = JSON.parse(Buffer.from(files[evidencePath!]!).toString("utf8")) as {
      readonly evidence: readonly { readonly id: string }[];
    };

    expect(inventory.evidence.filter((entry) => entry.id === physical.evidence.id)).toHaveLength(1);
    expect(
      bundle.manifest.artifacts.filter((entry) => entry.sourceArtifactId === physical.rawArtifact.id)
    ).toHaveLength(1);
    expect(
      bundle.manifest.artifacts.filter((entry) => entry.sourceArtifactId === physical.parsedArtifact.id)
    ).toHaveLength(1);
    expect(bundle.exactInputs[1]).toEqual(physical.evidenceRoot);
  });

  it("does not let detached passing records satisfy active-stage export requirements", async () => {
    const missingCamRegistry: StageRegistryContract = {
      orderedStages: () => fixtureRegistry.orderedStages(),
      has: (stage) => fixtureRegistry.has(stage),
      get: <K extends StageKey>(stage: K) => fixtureRegistry.get(stage),
      execute: async <K extends StageKey>(stage: K, context: StageContextByKey[K]) => {
        const result = await fixtureRegistry.execute(stage, context);
        if (stage !== "manufacturing_package") return result;
        const artifacts = result.artifacts.filter(
          (artifact) => !/cam[-_]?manifest/iu.test(artifact.logicalName)
        );
        const evidence = result.evidence.filter(
          (entry) =>
            (entry.rawArtifactLogicalName === undefined ||
              !/cam[-_]?manifest/iu.test(entry.rawArtifactLogicalName)) &&
            (entry.parsedArtifactLogicalName === undefined ||
              !/cam[-_]?manifest/iu.test(entry.parsedArtifactLogicalName))
        );
        return finalizeStageResult(stage, artifacts, evidence, result.blockers) as typeof result;
      }
    };
    const { service, state } = await makeProjectedApplication(missingCamRegistry);
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    state.setProjection((snapshot) => {
      const sourceEvidence = Object.values(snapshot.evidence).find(
        (entry) => entry.stage === "manufacturing_package" && entry.evidenceClass === "kicad_native"
      )!;
      const sourceArtifact = snapshot.artifacts[sourceEvidence.rawArtifactId!]!;
      const artifactId = "artifact_detached_cam_manifest";
      const evidenceId = "evidence_detached_cam_manifest";
      snapshot.artifacts[artifactId] = {
        ...sourceArtifact,
        id: artifactId,
        designRevisionId: revision.id,
        logicalName: "reports/detached-cam-manifest.txt"
      };
      snapshot.evidence[evidenceId] = {
        ...sourceEvidence,
        id: evidenceId,
        designRevisionId: revision.id,
        claim: "Detached passing CAM manifest claim",
        rawArtifactId: artifactId,
        subjectDigests: [sourceArtifact.blob.digest]
      };
    });
    try {
      await expect(
        service.exportCandidateBundle({
          revisionId: revision.id,
          expectedRevision: completed.run.revision,
          idempotencyKey: "projection-detached-positive-export"
        })
      ).rejects.toMatchObject({
        code: "GATE_FAILED",
        details: {
          missingInventory: ["CAM manifest"],
          missingDerivedReports: ["manufacturing_package:cam_manifest"]
        }
      });
    } finally {
      state.clearProjection();
    }
  });
});

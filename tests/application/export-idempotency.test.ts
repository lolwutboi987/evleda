import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationService } from "../../src/application/application-service.js";
import type {
  BundleExportResult,
  CurrentBundleExportResult,
  LegacyBundleExportResult
} from "../../src/application/results.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import {
  currentBundleExportResultSchema,
  legacyBundleExportResultSchema
} from "../../src/contracts/results.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { deterministicId } from "../../src/core/ids.js";
import type { AuditLogPort } from "../../src/application/ports.js";
import type { AuditOutboxSnapshot } from "../../src/persistence/audit-log.js";
import { HashChainAuditLog } from "../../src/persistence/audit-log.js";
import { FileContentStore } from "../../src/persistence/content-store.js";
import { AtomicStateStore } from "../../src/persistence/state-store.js";
import {
  createCompletedRun,
  fixtureRegistry,
  physicalEvidenceInput,
  qualifier
} from "./helpers.js";

const roots: string[] = [];
const fixedNow = () => new Date("2026-09-04T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
    )
  );
});

const storesAt = (root: string) => ({
  state: new AtomicStateStore(path.join(root, "state")),
  content: new FileContentStore(path.join(root, "content")),
  audit: new HashChainAuditLog(path.join(root, "audit"))
});

type Stores = ReturnType<typeof storesAt>;

const serviceAt = async (
  root: string,
  stores: Stores = storesAt(root),
  audit: AuditLogPort | null = stores.audit
): Promise<ApplicationService> => {
  const service = new ApplicationService(
    {
      state: stores.state,
      content: stores.content,
      stages: fixtureRegistry,
      ...(audit === null ? {} : { audit })
    },
    { workspaceRoot: path.join(root, "workspaces"), now: fixedNow }
  );
  await service.initialize();
  return service;
};

const harness = async (withAudit = true) => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-export-idempotency-"));
  roots.push(root);
  const stores = storesAt(root);
  const service = await serviceAt(root, stores, withAudit ? stores.audit : null);
  return { root, stores, service };
};

const withoutBytes = (result: BundleExportResult): Omit<BundleExportResult, "bytesBase64"> => {
  const { bytesBase64: _bytesBase64, ...metadata } = result;
  return metadata;
};

const archivedManifest = (result: BundleExportResult): unknown => {
  const rootName = result.fileName.slice(0, -4);
  const archive = unzipSync(Buffer.from(result.bytesBase64, "base64"));
  const manifestBytes = archive[`${rootName}/bundle-manifest.json`];
  if (manifestBytes === undefined) throw new Error("Bundle archive has no manifest entry");
  return JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
};

const LEGACY_BUNDLE_TOOL = {
  name: "evleda-deterministic-bundler",
  version: "0.1.0",
  adapter: "evleda" as const,
  capabilityProfile: "deterministic-zip-v2"
};

const asLegacyBundle = (current: CurrentBundleExportResult): LegacyBundleExportResult => {
  const legacyInputs = [current.manifest.revisionManifest, current.manifest.evidenceRoot] as const;
  const artifacts = current.manifest.artifacts.map((artifact) => {
    if (artifact.sourceKind !== "bundle_generated") return artifact;
    return {
      ...artifact,
      exactInputs: legacyInputs,
      tool: LEGACY_BUNDLE_TOOL,
      sourceArtifactId: deterministicId("bundle_artifact", {
        source: "evleda_bundle_generator",
        bundleKind: current.manifest.bundleKind,
        role: artifact.generationRole,
        projectId: current.manifest.projectId,
        runId: current.manifest.runId,
        designRevisionId: current.manifest.designRevisionId,
        revisionManifest: current.manifest.revisionManifest,
        evidenceRoot: current.manifest.evidenceRoot,
        identity: artifact.identity
      })
    };
  });
  const toolchain = current.manifest.toolchain
    .map((tool) =>
      tool.name === LEGACY_BUNDLE_TOOL.name && tool.adapter === LEGACY_BUNDLE_TOOL.adapter
        ? LEGACY_BUNDLE_TOOL
        : tool
    )
    .sort((left, right) =>
      canonicalIdentity(left, "evleda.tool-identity.v1").digest.localeCompare(
        canonicalIdentity(right, "evleda.tool-identity.v1").digest,
        "en"
      )
    );
  const {
    exactInputs: _manifestInputs,
    liveRegenerationPolicy: _manifestPolicy,
    liveRegenerationPolicyIdentity: _manifestPolicyIdentity,
    ...manifestBase
  } = current.manifest;
  const manifest = {
    ...manifestBase,
    schemaVersion: "evleda.bundle-manifest.v2" as const,
    artifacts,
    toolchain
  };
  const rootName = current.fileName.slice(0, -4);
  const archive = unzipSync(Buffer.from(current.bytesBase64, "base64"));
  const files: Zippable = { ...archive };
  files[`${rootName}/bundle-manifest.json`] = Buffer.from(
    `${canonicalJson(manifest)}\n`,
    "utf8"
  );
  const bytes = zipSync(files, { level: 9 });
  const {
    exactInputs: _resultInputs,
    liveRegenerationPolicy: _resultPolicy,
    liveRegenerationPolicyIdentity: _resultPolicyIdentity,
    ...resultBase
  } = current;
  return legacyBundleExportResultSchema.parse({
    ...resultBase,
    identity: contentIdentity(bytes),
    bytesBase64: Buffer.from(bytes).toString("base64"),
    manifest,
    exactInputs: legacyInputs,
    tool: LEGACY_BUNDLE_TOOL
  }) as unknown as LegacyBundleExportResult;
};

const exportRecord = async (
  stores: Stores,
  operation: "export_candidate_bundle" | "export_prototype_bundle",
  key: string
) => {
  const state = await stores.state.read();
  const matches = Object.entries(state.idempotency).filter(
    ([, record]) => record.operation === operation && record.key === key
  );
  expect(matches).toHaveLength(1);
  return { state, storageKey: matches[0]![0], record: matches[0]![1] };
};

describe("bundle export idempotency", () => {
  it("persists a failed requirements blocker without inventing an invocation", async () => {
    const { root, stores, service } = await harness();
    const project = await service.createProject({
      name: "Blocked invocation",
      idempotencyKey: "blocked-invocation-project"
    });
    const blocked = await service.startDesignRun({
      projectId: project.project.id,
      prompt: "Build a two-motor controller at 0.5 A RMS.",
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "blocked-invocation-run"
    });
    expect(blocked.run.state).toBe("blocked");
    expect(blocked.blockers.map((blocker) => blocker.code)).toContain(
      "ASSUMPTION_MISSING_SUPPLY_VOLTAGE"
    );

    expect((await stores.state.read()).invocations).toEqual({});
    const restarted = await serviceAt(root);
    expect((await restarted.getRunStatus({ runId: blocked.run.id })).blockers).toEqual(blocked.blockers);
    expect((await stores.state.read()).invocations).toEqual({});
  });

  it("persists a compact candidate receipt and replays it after evidence changes and restart", async () => {
    const { root, stores, service } = await harness();
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-evidence-0001"
    } as const;
    const first = await service.exportCandidateBundle(input);
    expect(first.tool.capabilityProfile).toBe("deterministic-zip-v3");
    expect(first.manifest.schemaVersion).toBe("evleda.bundle-manifest.v3");
    expect(archivedManifest(first)).toStrictEqual(first.manifest);
    expect(
      first.manifest.artifacts
        .filter((artifact) => artifact.sourceKind === "bundle_generated")
        .every((artifact) => artifact.tool.capabilityProfile === "deterministic-zip-v3")
    ).toBe(true);
    const completedState = await stores.state.read();
    expect(completedState.invocations).toEqual({});
    expect(Object.values(completedState.projects)).not.toHaveLength(0);
    expect(Object.values(completedState.runs)).not.toHaveLength(0);
    expect(Object.values(completedState.revisions)).not.toHaveLength(0);
    expect(Object.values(completedState.artifacts)).not.toHaveLength(0);
    expect(Object.values(completedState.evidence)).not.toHaveLength(0);
    expect(Object.values(completedState.approvals)).not.toHaveLength(0);
    expect(Object.values(completedState.idempotency)).not.toHaveLength(0);
    expect(completed.run.requirements?.constraints).toMatchObject({
      input_voltage_min_mv: "7000",
      input_voltage_max_mv: "16800",
      motor_channels: "2",
      motor_current_rms_ma: "500"
    });
    expect(Object.values(completedState.artifacts).some(
      (artifact) => artifact.logicalName === "components/core-bom.csv"
    )).toBe(true);
    const receipt = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    expect(receipt.storageKey).not.toBe(input.idempotencyKey);
    expect(receipt.record.result).toStrictEqual({
      schemaVersion: "evleda.bundle-export-replay.v2",
      result: withoutBytes(first)
    });
    expect(JSON.stringify(receipt.record.result)).not.toContain(first.bytesBase64);

    const afterExport = await service.getRunStatus({ runId: completed.run.id });
    const physical = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      afterExport.run.revision,
      "candidate-replay-physical-0001",
      "REPLAY-CANDIDATE"
    );
    await service.submitExternalEvidence(
      physical,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const changedEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: completed.headRevision!.id,
      includeStale: false
    });
    expect(changedEvidence.evidenceRoot.digest).not.toBe(first.manifest.evidenceRoot.digest);

    const beforeReplayState = await stores.state.read();
    const beforeReplayEvents = await stores.audit.readAndVerify();
    const restarted = await serviceAt(root);
    const replay = await restarted.exportCandidateBundle(input);

    expect(replay).toStrictEqual(first);
    expect((await stores.state.read()).invocations).toEqual({});
    expect(contentIdentity(Buffer.from(replay.bytesBase64, "base64"))).toStrictEqual(first.identity);
    expect((await stores.state.read()).revision).toBe(beforeReplayState.revision);
    expect((await stores.audit.readAndVerify())).toHaveLength(beforeReplayEvents.length);
  }, 60_000);

  it("replays an original unlabeled v2 bundle from a v1 receipt without relabeling", async () => {
    const { root, stores, service } = await harness(false);
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-unlabeled-v2"
    } as const;
    const current = currentBundleExportResultSchema.parse(
      await service.exportCandidateBundle(input)
    ) as unknown as CurrentBundleExportResult;
    const legacy = asLegacyBundle(current);
    await stores.content.put(Buffer.from(legacy.bytesBase64, "base64"), legacy.identity);
    const committed = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    await stores.state.transaction(undefined, (state) => {
      state.idempotency[committed.storageKey] = {
        ...committed.record,
        result: {
          schemaVersion: "evleda.bundle-export-replay.v1",
          result: withoutBytes(legacy)
        }
      };
    });
    const beforeReplay = await stores.state.read();

    const restarted = await serviceAt(root, stores, null);
    const replay = await restarted.exportCandidateBundle(input);

    expect(replay.bytesBase64).toBe(legacy.bytesBase64);
    expect(withoutBytes(replay)).toStrictEqual(withoutBytes(legacy));
    expect(replay.manifest.schemaVersion).toBe("evleda.bundle-manifest.v2");
    expect(replay.tool.capabilityProfile).toBe("deterministic-zip-v2");
    expect(archivedManifest(replay)).toStrictEqual(replay.manifest);
    expect(contentIdentity(Buffer.from(replay.bytesBase64, "base64"))).toStrictEqual(
      replay.identity
    );
    expect(
      replay.manifest.artifacts
        .filter((artifact) => artifact.sourceKind === "bundle_generated")
        .every((artifact) => artifact.tool.capabilityProfile === "deterministic-zip-v2")
    ).toBe(true);
    expect("liveRegenerationPolicy" in replay).toBe(false);
    expect("liveRegenerationPolicy" in replay.manifest).toBe(false);
    expect(await stores.state.read()).toStrictEqual(beforeReplay);
  });

  it("rejects crossed replay, manifest, and ZIP profiles without rewriting or upcasting", async () => {
    const { stores, service } = await harness(false);
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-version-matrix"
    } as const;
    const current = currentBundleExportResultSchema.parse(
      await service.exportCandidateBundle(input)
    ) as unknown as CurrentBundleExportResult;
    const legacy = asLegacyBundle(current);
    await stores.content.put(Buffer.from(legacy.bytesBase64, "base64"), legacy.identity);
    const committed = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    const currentStored = withoutBytes(current);
    const legacyStored = withoutBytes(legacy);

    const currentWithZip2 = structuredClone(currentStored) as Record<string, any>;
    currentWithZip2.tool.capabilityProfile = "deterministic-zip-v2";
    const currentWithArtifactZip2 = structuredClone(currentStored) as Record<string, any>;
    currentWithArtifactZip2.manifest.artifacts.find(
      (artifact: Record<string, any>) => artifact.sourceKind === "bundle_generated"
    ).tool.capabilityProfile = "deterministic-zip-v2";
    const legacyWithZip3 = structuredClone(legacyStored) as Record<string, any>;
    legacyWithZip3.tool.capabilityProfile = "deterministic-zip-v3";
    const legacyWithArtifactZip3 = structuredClone(legacyStored) as Record<string, any>;
    legacyWithArtifactZip3.manifest.artifacts.find(
      (artifact: Record<string, any>) => artifact.sourceKind === "bundle_generated"
    ).tool.capabilityProfile = "deterministic-zip-v3";
    const currentManifestRelabeledV2 = structuredClone(currentStored) as Record<string, any>;
    currentManifestRelabeledV2.manifest.schemaVersion = "evleda.bundle-manifest.v2";
    const legacyManifestRelabeledV3 = structuredClone(legacyStored) as Record<string, any>;
    legacyManifestRelabeledV3.manifest.schemaVersion = "evleda.bundle-manifest.v3";

    const invalidReceipts: readonly (readonly [string, unknown])[] = [
      ["replay-v1-current-v3-zip3", {
        schemaVersion: "evleda.bundle-export-replay.v1",
        result: currentStored
      }],
      ["replay-v2-legacy-v2-zip2", {
        schemaVersion: "evleda.bundle-export-replay.v2",
        result: legacyStored
      }],
      ["replay-v2-current-v3-zip2", {
        schemaVersion: "evleda.bundle-export-replay.v2",
        result: currentWithZip2
      }],
      ["replay-v2-current-v3-artifact-zip2", {
        schemaVersion: "evleda.bundle-export-replay.v2",
        result: currentWithArtifactZip2
      }],
      ["replay-v1-legacy-v2-zip3", {
        schemaVersion: "evleda.bundle-export-replay.v1",
        result: legacyWithZip3
      }],
      ["replay-v1-legacy-v2-artifact-zip3", {
        schemaVersion: "evleda.bundle-export-replay.v1",
        result: legacyWithArtifactZip3
      }],
      ["replay-v2-current-relabeled-v2", {
        schemaVersion: "evleda.bundle-export-replay.v2",
        result: currentManifestRelabeledV2
      }],
      ["replay-v1-legacy-relabeled-v3", {
        schemaVersion: "evleda.bundle-export-replay.v1",
        result: legacyManifestRelabeledV3
      }]
    ];

    for (const [name, invalidReceipt] of invalidReceipts) {
      await stores.state.transaction(undefined, (state) => {
        state.idempotency[committed.storageKey] = {
          ...committed.record,
          result: invalidReceipt
        };
      });
      const beforeReplay = await stores.state.read();
      await expect(service.exportCandidateBundle(input), name).rejects.toMatchObject({
        code: "ARTIFACT_INTEGRITY_ERROR"
      });
      expect(await stores.state.read(), name).toStrictEqual(beforeReplay);
    }
  }, 60_000);

  it("rejects coherently rebuilt v3 archives with missing, extra, or crossed bundlers", async () => {
    const { root, stores, service } = await harness(false);
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-coherent-toolchain-hybrid"
    } as const;
    const current = currentBundleExportResultSchema.parse(
      await service.exportCandidateBundle(input)
    ) as unknown as CurrentBundleExportResult;
    const rootName = current.fileName.slice(0, -4);
    const committed = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    const restarted = await serviceAt(root, stores, null);
    const hybridCases: readonly (readonly [
      string,
      (manifest: Record<string, any>) => void
    ])[] = [
      ["missing", (manifest) => {
        manifest.toolchain = manifest.toolchain.filter(
          (tool: Record<string, any>) => tool.name !== "evleda-deterministic-bundler"
        );
      }],
      ["extra", (manifest) => {
        manifest.toolchain.push({ ...LEGACY_BUNDLE_TOOL });
      }],
      ["crossed", (manifest) => {
        const bundler = manifest.toolchain.find(
          (tool: Record<string, any>) => tool.name === "evleda-deterministic-bundler"
        );
        if (bundler === undefined) throw new Error("Current fixture has no bundle tool");
        Object.assign(bundler, LEGACY_BUNDLE_TOOL);
      }]
    ];

    for (const [name, mutateManifest] of hybridCases) {
      const hybrid = structuredClone(current) as unknown as Record<string, any>;
      mutateManifest(hybrid.manifest);
      hybrid.manifest.toolchain.sort((left: Record<string, any>, right: Record<string, any>) =>
        canonicalIdentity(left, "evleda.tool-identity.v1").digest.localeCompare(
          canonicalIdentity(right, "evleda.tool-identity.v1").digest,
          "en"
        )
      );
      const archive: Zippable = {
        ...unzipSync(Buffer.from(current.bytesBase64, "base64"))
      };
      archive[`${rootName}/bundle-manifest.json`] = Buffer.from(
        `${canonicalJson(hybrid.manifest)}\n`,
        "utf8"
      );
      const hybridBytes = zipSync(archive, { level: 9 });
      hybrid.identity = contentIdentity(hybridBytes);
      hybrid.bytesBase64 = Buffer.from(hybridBytes).toString("base64");
      await stores.content.put(hybridBytes, hybrid.identity);
      await stores.state.transaction(undefined, (state) => {
        state.idempotency[committed.storageKey] = {
          ...committed.record,
          result: {
            schemaVersion: "evleda.bundle-export-replay.v2",
            result: withoutBytes(hybrid as unknown as BundleExportResult)
          }
        };
      });
      const beforeReplay = await stores.state.read();

      await expect(restarted.exportCandidateBundle(input), name).rejects.toMatchObject({
        code: "ARTIFACT_INTEGRITY_ERROR"
      });
      expect(await stores.state.read(), name).toStrictEqual(beforeReplay);
    }
  }, 60_000);

  it("replays an exported candidate after head advancement and conflicts before resource lookup", async () => {
    const { stores, service } = await harness();
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-stale-head-0001"
    } as const;
    const first = await service.exportCandidateBundle(input);
    const afterExport = await service.getRunStatus({ runId: completed.run.id });
    await service.generateBringupPlan({
      revisionId: completed.headRevision!.id,
      expectedRevision: afterExport.run.revision,
      idempotencyKey: "candidate-replay-advance-head"
    });
    const advanced = await service.getRunStatus({ runId: completed.run.id });
    expect(advanced.headRevision?.id).not.toBe(input.revisionId);
    const stateRevision = (await stores.state.read()).revision;

    await expect(service.exportCandidateBundle(input)).resolves.toStrictEqual(first);
    expect((await stores.state.read()).revision).toBe(stateRevision);
    await expect(
      service.exportCandidateBundle({ ...input, revisionId: "revision_does_not_exist" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.exportCandidateBundle({ ...input, expectedRevision: input.expectedRevision + 1 })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  }, 60_000);

  it("replays a prototype after qualification revocation and restart", async () => {
    const { root, stores, service } = await harness();
    const completed = await createCompletedRun(service);
    const physical = await service.submitExternalEvidence(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        completed.headRevision!.id,
        completed.run.revision,
        "prototype-replay-physical-0001",
        "REPLAY-PROTOTYPE"
      ),
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const qualification = await service.qualifyRevision(
      {
        revisionId: completed.headRevision!.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Qualification for exact prototype replay coverage.",
        scope: "one replay test prototype",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "prototype-replay-qualification"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const qualified = await service.getRunStatus({ runId: completed.run.id });
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: qualified.run.revision,
      idempotencyKey: "prototype-replay-revoked-0001"
    } as const;
    const first = await service.exportPrototypeBundle(input);
    const afterExport = await service.getRunStatus({ runId: completed.run.id });
    await service.revokeAttestation(
      {
        approvalId: qualification.approval.id,
        actor: qualifier,
        reason: "Exercise exact replay after qualification revocation.",
        expectedRevision: afterExport.run.revision,
        idempotencyKey: "prototype-replay-revoke-0001"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect((await service.getRunStatus({ runId: completed.run.id })).effectiveLifecycle).toBe(
      "candidate"
    );
    const stateRevision = (await stores.state.read()).revision;

    const restarted = await serviceAt(root);
    await expect(restarted.exportPrototypeBundle(input)).resolves.toStrictEqual(first);
    expect((await stores.state.read()).revision).toBe(stateRevision);
  }, 60_000);

  it("serializes concurrent same-key exports to one committed receipt and response", async () => {
    const { root, stores, service } = await harness();
    const completed = await createCompletedRun(service);
    const second = await serviceAt(root);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-concurrent-0001"
    } as const;
    const before = await stores.state.read();
    const beforeRunRevision = before.runs[completed.run.id]!.revision;
    const [left, right] = await Promise.all([
      service.exportCandidateBundle(input),
      second.exportCandidateBundle(input)
    ]);
    const after = await stores.state.read();
    const receipt = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    const exportEvents = (await stores.audit.readAndVerify()).filter(
      (entry) => entry.event.type === "bundle.candidate_exported"
    );

    expect(left).toStrictEqual(right);
    expect(receipt.record.result).toStrictEqual({
      schemaVersion: "evleda.bundle-export-replay.v2",
      result: withoutBytes(left)
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.runs[completed.run.id]!.revision).toBe(beforeRunRevision + 1);
    expect(exportEvents).toHaveLength(1);
  }, 60_000);

  it("recovers a committed receipt after audit delivery fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evleda-export-audit-failure-"));
    roots.push(root);
    const stores = storesAt(root);
    let armed = false;
    let failed = false;
    const failingAudit: AuditLogPort = {
      root: stores.audit.root,
      append: (event) => stores.audit.append(event),
      readAndVerify: () => stores.audit.readAndVerify(),
      drain: async (loadSnapshot: () => Promise<AuditOutboxSnapshot>) => {
        const snapshot = await loadSnapshot();
        const containsExport = Object.values(snapshot.outbox).some(
          (event) => event.type === "bundle.candidate_exported"
        );
        if (armed && containsExport && !failed) {
          failed = true;
          throw new Error("simulated export audit delivery failure");
        }
        return stores.audit.drain(async () => snapshot);
      }
    };
    const service = await serviceAt(root, stores, failingAudit);
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-audit-failure"
    } as const;
    armed = true;
    await expect(service.exportCandidateBundle(input)).rejects.toThrow(
      /simulated export audit delivery failure/u
    );
    const committed = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    const receipt = committed.record.result as {
      readonly schemaVersion: string;
      readonly result: Omit<BundleExportResult, "bytesBase64">;
    };
    const committedRevision = committed.state.revision;

    const recovered = await serviceAt(root);
    const replay = await recovered.exportCandidateBundle(input);
    expect(receipt.schemaVersion).toBe("evleda.bundle-export-replay.v2");
    expect(withoutBytes(replay)).toStrictEqual(receipt.result);
    expect(Buffer.from(replay.bytesBase64, "base64")).toStrictEqual(
      await stores.content.get(receipt.result.identity)
    );
    expect((await stores.state.read()).revision).toBe(committedRevision);
    expect(
      (await stores.audit.readAndVerify()).filter(
        (entry) => entry.event.type === "bundle.candidate_exported"
      )
    ).toHaveLength(1);
  }, 60_000);

  it.each(["missing", "corrupt"] as const)(
    "fails closed when committed replay bytes are %s",
    async (mode) => {
      const { stores, service } = await harness();
      const completed = await createCompletedRun(service);
      const input = {
        revisionId: completed.headRevision!.id,
        expectedRevision: completed.run.revision,
        idempotencyKey: `candidate-replay-${mode}-bytes`
      } as const;
      const first = await service.exportCandidateBundle(input);
      const blobPath = stores.content.pathFor(first.identity);
      if (mode === "missing") {
        await rm(blobPath, { force: true });
      } else {
        await writeFile(blobPath, "corrupt replay bytes", "utf8");
      }
      const before = await stores.state.read();

      await expect(service.exportCandidateBundle(input)).rejects.toMatchObject({
        code: "ARTIFACT_INTEGRITY_ERROR"
      });
      expect((await stores.state.read()).revision).toBe(before.revision);
    }
  );

  it("rejects a legacy export descriptor instead of rebuilding", async () => {
    const { stores, service } = await harness(false);
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-legacy-receipt"
    } as const;
    const first = await service.exportCandidateBundle(input);
    const committed = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    await stores.state.transaction(undefined, (state) => {
      delete state.idempotency[committed.storageKey];
      state.idempotency[input.idempotencyKey] = {
        ...committed.record,
        result: { runId: completed.run.id, bundleIdentity: first.identity }
      };
    });
    const before = await stores.state.read();

    await expect(service.exportCandidateBundle(input)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    expect((await stores.state.read()).revision).toBe(before.revision);
  });

  it("rejects a malformed current-version replay receipt instead of rebuilding", async () => {
    const { stores, service } = await harness(false);
    const completed = await createCompletedRun(service);
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: "candidate-replay-malformed-receipt"
    } as const;
    await service.exportCandidateBundle(input);
    const committed = await exportRecord(stores, "export_candidate_bundle", input.idempotencyKey);
    await stores.state.transaction(undefined, (state) => {
      state.idempotency[committed.storageKey] = {
        ...committed.record,
        result: {
          schemaVersion: "evleda.bundle-export-replay.v2",
          result: { fileName: 42 }
        }
      };
    });
    const before = await stores.state.read();

    await expect(service.exportCandidateBundle(input)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    expect((await stores.state.read()).revision).toBe(before.revision);
  });

  it("scopes the same raw key independently by operation", async () => {
    const { stores, service } = await harness();
    const completed = await createCompletedRun(service);
    const key = "shared-operation-scope-key";
    const input = {
      revisionId: completed.headRevision!.id,
      expectedRevision: completed.run.revision,
      idempotencyKey: key
    } as const;
    const bundle = await service.exportCandidateBundle(input);
    const created = await service.createProject({ name: "Operation scoped key", idempotencyKey: key });
    const matchingRecords = Object.values((await stores.state.read()).idempotency).filter(
      (record) => record.key === key
    );

    expect(created.project.name).toBe("Operation scoped key");
    expect(new Set(matchingRecords.map((record) => record.operation))).toStrictEqual(
      new Set(["create_project", "export_candidate_bundle"])
    );
    await expect(service.exportCandidateBundle(input)).resolves.toStrictEqual(bundle);
  });
});

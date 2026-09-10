import { afterEach, describe, expect, it } from "vitest";

import type { ApplicationService } from "../../src/application/application-service.js";
import type { ContentStorePort, StateStorePort } from "../../src/application/ports.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import {
  physicalAcceptanceContractSchema,
  physicalAsBuiltRecordSchema,
  physicalFirmwareFlashRecordSchema,
  physicalInstrumentCalibrationRecordSchema,
  physicalMeasurementRecordSchema,
  submitExternalEvidenceCurrentInputSchema,
  submitExternalEvidenceLegacyInputSchema,
  type PhysicalAcceptanceContract,
  type SubmitExternalEvidenceCurrentInput,
  type SubmitExternalEvidenceInput
} from "../../src/contracts/operations.js";
import { externalEvidenceResultSchema } from "../../src/contracts/results.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import { DomainError } from "../../src/domain/errors.js";
import type { CanonicalIdentity, ContentIdentity } from "../../src/domain/types.js";
import type {
  EvlEdaState,
  MutableEvlEdaState
} from "../../src/persistence/state-store.js";
import {
  createCompletedRun,
  disposeApplicationRoots,
  fixtureRegistry,
  makeApplication as makeApplicationWithClock,
  qualifier
} from "./helpers.js";

afterEach(disposeApplicationRoots);

// Physical records below describe the September 3 fixture session. Keep normal
// admission independent of wall-clock age; explicit expiry-test clocks win.
const makeApplication: typeof makeApplicationWithClock = (registry, stageContext, options = {}) =>
  makeApplicationWithClock(registry, stageContext, {
    ...options,
    now: options.now ?? (() => new Date("2026-09-03T12:00:00.000Z"))
  });

class ReadProjectingStateStore implements StateStorePort {
  public readonly root: string;
  public projection: ((state: EvlEdaState) => EvlEdaState) | undefined;

  public constructor(private readonly base: StateStorePort) {
    this.root = base.root;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public async read(): Promise<EvlEdaState> {
    const state = await this.base.read();
    return this.projection?.(state) ?? state;
  }

  public transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<{ readonly state: EvlEdaState; readonly result: Result }> {
    if (this.projection === undefined) return this.base.transaction(expectedRevision, mutate);
    return this.base.transaction<Result>(expectedRevision, async (state) => {
      const projected = this.projection!(structuredClone(state)) as MutableEvlEdaState;
      await mutate(projected);
      throw new Error("Projected corrupt state unexpectedly reached the commit boundary");
    });
  }
}

class SelectivelyMissingContentStore implements ContentStorePort {
  public readonly root: string;
  public readonly missingDigests = new Set<string>();

  public constructor(private readonly base: ContentStorePort) {
    this.root = base.root;
  }

  public initialize(): Promise<void> {
    return this.base.initialize();
  }

  public put(bytes: Uint8Array | string, expected?: ContentIdentity): Promise<ContentIdentity> {
    return this.base.put(bytes, expected);
  }

  public putJson(value: unknown): Promise<ContentIdentity> {
    return this.base.putJson(value);
  }

  public get(identity: ContentIdentity): Promise<Buffer> {
    if (this.missingDigests.has(identity.digest)) {
      return Promise.reject(new DomainError("NOT_FOUND", "Injected missing content object"));
    }
    return this.base.get(identity);
  }

  public async verify(identity: ContentIdentity): Promise<boolean> {
    await this.get(identity);
    return true;
  }
}

const sortedIds = <Value extends { readonly id: string }>(values: readonly Value[]): readonly string[] =>
  values.map(({ id }) => id).sort((left, right) => left.localeCompare(right, "en"));

const releaseAuthority = {
  type: "human" as const,
  id: "physical-release-authority",
  displayName: "Independent Release Authority",
  role: "release_authority" as const
};

type MutableJson = Record<string, unknown>;

interface MutableSourceBlob {
  role: string;
  identity: ReturnType<typeof contentIdentity>;
  bytesBase64: string;
}

const mutableObject = (value: unknown, label: string): MutableJson => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as MutableJson;
};

const rewritePhysicalJsonSource = (
  input: SubmitExternalEvidenceInput,
  role: string,
  mutate: (record: MutableJson) => void
): SubmitExternalEvidenceInput => {
  const cloned = structuredClone(input) as unknown as {
    sourceBlobs: MutableSourceBlob[];
  };
  const source = cloned.sourceBlobs.find((candidate) => candidate.role === role);
  if (source === undefined) throw new Error(`Missing ${role} fixture source`);
  const record = mutableObject(
    JSON.parse(Buffer.from(source.bytesBase64, "base64").toString("utf8")),
    `${role} record`
  );
  mutate(record);
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
  source.identity = contentIdentity(bytes);
  source.bytesBase64 = bytes.toString("base64");
  return cloned as unknown as SubmitExternalEvidenceInput;
};

const replaceUploadedFirmware = (
  input: SubmitExternalEvidenceInput,
  bytes: Buffer
): SubmitExternalEvidenceInput => {
  const cloned = structuredClone(input) as unknown as {
    sourceBlobs: MutableSourceBlob[];
  };
  const source = cloned.sourceBlobs.find(
    (candidate) => candidate.role === "flashed_firmware_binary"
  );
  if (source === undefined) throw new Error("Missing flashed firmware fixture source");
  const identity = contentIdentity(bytes);
  source.identity = identity;
  source.bytesBase64 = bytes.toString("base64");
  let rewritten = cloned as unknown as SubmitExternalEvidenceInput;
  for (const role of ["firmware_flash_record", "parsed_measurement_record"]) {
    rewritten = rewritePhysicalJsonSource(rewritten, role, (record) => {
      record.firmwareBinaryIdentity = identity;
    });
  }
  return rewritten;
};

const corruptDigest = (value: unknown, label: string): void => {
  mutableObject(value, label).digest = "f".repeat(64);
};

const mutableArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be an array`);
  return value;
};

const assemblyOperator = {
  type: "human" as const,
  id: "assembly-operator-release-fixture",
  displayName: "Assembly Operator",
  role: "assembly_operator" as const
};

const measurementOperator = {
  type: "human" as const,
  id: "measurement-operator-release-fixture",
  displayName: "Measurement Operator",
  role: "measurement_operator" as const
};

interface TargetBuildReportFixture {
  readonly status: string;
  readonly code: string;
  readonly sourceRevision: {
    readonly projectId: string;
    readonly runId: string;
    readonly designRevisionId: string;
    readonly targetBuildSourceIdentity: CanonicalIdentity;
    readonly generatedSources: readonly {
      readonly logicalName: string;
      readonly identity: ContentIdentity;
    }[];
  };
  readonly toolchain: {
    readonly provisionedConfigurationIdentity: CanonicalIdentity;
    readonly toolchainIdentity: CanonicalIdentity;
  };
  readonly outputs: readonly {
    readonly kind: string;
    readonly logicalName: string;
    readonly identity: ContentIdentity;
  }[];
}

const currentPhysicalEvidenceInput = async (
  service: ApplicationService,
  runId: string,
  revisionId: string,
  expectedRevision: number,
  idempotencyKey: string,
  boardSerial: string
): Promise<SubmitExternalEvidenceCurrentInput> => {
  const listed = await service.listArtifacts({ runId, revisionId, includeStale: false });
  const findArtifact = (logicalName: string) => {
    const artifact = listed.artifacts.find((candidate) => candidate.logicalName === logicalName);
    if (artifact === undefined) throw new Error(`Missing current physical fixture artifact ${logicalName}`);
    return artifact;
  };
  const bindingFor = (logicalName: string) => {
    const artifact = findArtifact(logicalName);
    return { artifactId: artifact.id, identity: artifact.blob };
  };
  const readJson = async <Value>(logicalName: string): Promise<Value> => {
    const artifact = findArtifact(logicalName);
    return JSON.parse((await service.readArtifact(artifact.id)).bytes.toString("utf8")) as Value;
  };
  const status = await service.getRunStatus({ runId });
  if (status.headRevision?.id !== revisionId) throw new Error("Physical fixture revision is not current");
  const inspected = await service.inspectEvidence({ runId, revisionId, includeStale: false });
  const acceptance = physicalAcceptanceContractSchema.parse(
    await readJson<unknown>("bringup/physical-acceptance.json")
  );
  const targetReport = await readJson<TargetBuildReportFixture>(
    "firmware/reports/stm32g0-target-build.json"
  );
  if (
    targetReport.status !== "pass" ||
    targetReport.code !== "FIRMWARE_TARGET_CROSS_BUILD_PASSED"
  ) {
    throw new Error("Physical fixture requires a passing target-build report");
  }
  const targetOutput = targetReport.outputs.find((output) => output.kind === "bin");
  if (targetOutput === undefined) throw new Error("Target-build fixture omits the BIN output");
  const targetBinaryArtifact = findArtifact(targetOutput.logicalName);
  if (canonicalJson(targetBinaryArtifact.blob) !== canonicalJson(targetOutput.identity)) {
    throw new Error("Target-build fixture BIN artifact does not match its report");
  }
  const targetBinaryBytes = (await service.readArtifact(targetBinaryArtifact.id)).bytes;
  const targetBinaryIdentity = contentIdentity(targetBinaryBytes);
  const suffix = idempotencyKey;
  const asBuiltSourceId = `as-built-${suffix}`;
  const firmwareBinarySourceId = `firmware-binary-${suffix}`;
  const firmwareFlashSourceId = `firmware-flash-${suffix}`;
  const calibrationSourceId = `calibration-${suffix}`;
  const measurementSourceId = `measurements-${suffix}`;
  const instrumentId = `instrument-${suffix}`;
  const bom = bindingFor("manufacturing/bom.csv");
  const camManifest = bindingFor("manufacturing/cam-manifest.json");
  const targetBuildReport = bindingFor("firmware/reports/stm32g0-target-build.json");
  const targetBinary = { artifactId: targetBinaryArtifact.id, identity: targetBinaryArtifact.blob };
  const bringupProcedure = bindingFor("bringup/bringup-plan.json");
  const acceptanceArtifact = bindingFor("bringup/physical-acceptance.json");
  const provenance = {
    targetBuildReportArtifact: targetBuildReport,
    targetBinaryArtifact: targetBinary,
    projectId: targetReport.sourceRevision.projectId,
    runId: targetReport.sourceRevision.runId,
    designRevisionId: targetReport.sourceRevision.designRevisionId,
    targetBuildSourceIdentity: targetReport.sourceRevision.targetBuildSourceIdentity,
    targetSourceRevisionDigest: targetReport.sourceRevision.targetBuildSourceIdentity.digest,
    targetConfigurationIdentity: targetReport.toolchain.provisionedConfigurationIdentity,
    targetToolchainIdentity: targetReport.toolchain.toolchainIdentity,
    targetCompiledSources: targetReport.sourceRevision.generatedSources
  };
  const capabilityUnits = new Map<string, Set<string>>([["programmer", new Set()]]);
  for (const test of acceptance.tests) {
    const units = capabilityUnits.get(test.instrumentCapability) ?? new Set<string>();
    if (test.kind === "numeric_range") units.add(test.unit);
    capabilityUnits.set(test.instrumentCapability, units);
  }
  for (const testCase of acceptance.cases) {
    for (const capture of testCase.captureRequirements) {
      if (!capabilityUnits.has(capture.instrumentCapability)) {
        capabilityUnits.set(capture.instrumentCapability, new Set());
      }
    }
  }
  const calibrationRecord = physicalInstrumentCalibrationRecordSchema.parse({
    schemaVersion: "evleda.instrument-calibration.v1",
    instrumentId,
    manufacturer: "EvlEDA fixture vendor",
    model: "CALIBRATED-COMBO",
    serial: `serial-${boardSerial}`,
    calibratedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-12-31T00:00:00.000Z",
    capabilities: [...capabilityUnits]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([capability, units]) => ({ capability, units: [...units].sort() }))
  });
  const asBuiltRecord = physicalAsBuiltRecordSchema.parse({
    schemaVersion: "evleda.as-built-record.v2",
    boardSerial,
    assemblyLot: `lot-${boardSerial}`,
    assemblyOperator,
    completedAt: "2026-09-02T12:00:00.000Z",
    revisionManifestDigest: status.headRevision.manifest.digest,
    bomArtifact: bom,
    camManifestArtifact: camManifest,
    substitutions: []
  });
  const firmwareFlashRecord = physicalFirmwareFlashRecordSchema.parse({
    schemaVersion: "evleda.firmware-flash-record.v2",
    boardSerial,
    flashedAt: "2026-09-03T00:00:01.000Z",
    ...provenance,
    firmwareBinarySourceId,
    firmwareBinaryIdentity: targetBinaryIdentity,
    programmerInstrumentId: instrumentId
  });
  const captureSources: {
    id: string;
    role: "required_capture";
    mediaType: SubmitExternalEvidenceCurrentInput["sourceBlobs"][number]["mediaType"];
    bytes: Buffer;
    capturedAt: string;
  }[] = [];
  let cursor = Date.parse("2026-09-03T00:00:00.000Z");
  const caseExecutions = acceptance.cases.map((testCase) => {
    const startedAtMs = cursor;
    const completedAtMs = startedAtMs + Math.max(testCase.minimumDurationMs, 1_000);
    cursor = completedAtMs;
    const observedAt = new Date(startedAtMs + Math.max(1, Math.floor((completedAtMs - startedAtMs) / 2))).toISOString();
    const captureBindings = testCase.captureRequirements.map((capture) => {
      const sourceId = `${testCase.caseId}-${capture.captureRequirementId}-source`;
      captureSources.push({
        id: sourceId,
        role: "required_capture",
        mediaType: capture.allowedMediaTypes[0]!,
        bytes: Buffer.from(`raw capture ${boardSerial} ${sourceId}`, "utf8"),
        capturedAt: observedAt
      });
      return {
        captureRequirementId: capture.captureRequirementId,
        sourceId,
        instrumentId,
        sampleCount: capture.minimumSamples ?? 1
      };
    });
    const observations = acceptance.tests
      .filter((test) => test.caseId === testCase.caseId)
      .map((test) => {
        const capture = testCase.captureRequirements.find(
          (requirement) => requirement.instrumentCapability === test.instrumentCapability
        ) ?? testCase.captureRequirements[0]!;
        return test.kind === "numeric_range"
          ? {
              testId: test.id,
              instrumentId,
              captureRequirementId: capture.captureRequirementId,
              observedAt,
              kind: "numeric_range" as const,
              value: (test.minimum + test.maximum) / 2,
              unit: test.unit
            }
          : {
              testId: test.id,
              instrumentId,
              captureRequirementId: capture.captureRequirementId,
              observedAt,
              kind: "expected_value" as const,
              observed: test.expected
            };
      });
    return {
      caseId: testCase.caseId,
      procedureStepId: testCase.procedureStepId,
      endpointId: testCase.endpointId,
      operatorId: measurementOperator.id,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      actualConditions: testCase.requiredConditions.map((condition) =>
        condition.kind === "exact"
          ? { conditionId: condition.conditionId, kind: "exact" as const, observed: condition.expected }
          : {
              conditionId: condition.conditionId,
              kind: "numeric" as const,
              unit: condition.unit,
              value: (condition.minimum + condition.maximum) / 2
            }
      ),
      captureBindings,
      observations
    };
  });
  const measurementRecord = physicalMeasurementRecordSchema.parse({
    schemaVersion: "evleda.physical-measurements.v2",
    boardSerial,
    bringupProcedureArtifact: bringupProcedure,
    acceptanceArtifact,
    ...provenance,
    firmwareBinarySourceId,
    firmwareBinaryIdentity: targetBinaryIdentity,
    environment: {
      location: "EvlEDA guarded bench fixture",
      fixtureId: `fixture-${suffix}`,
      supply: "current-limited isolated bench supply",
      ambientTemperatureC: 23.5,
      relativeHumidityPercent: 45
    },
    operators: [measurementOperator],
    startedAt: new Date(Date.parse("2026-09-03T00:00:00.000Z")).toISOString(),
    completedAt: new Date(cursor).toISOString(),
    caseExecutions
  });
  const jsonBytes = (value: unknown): Buffer => Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const source = (
    id: string,
    role: SubmitExternalEvidenceCurrentInput["sourceBlobs"][number]["role"],
    mediaType: SubmitExternalEvidenceCurrentInput["sourceBlobs"][number]["mediaType"],
    bytes: Buffer,
    capturedAt: string
  ): SubmitExternalEvidenceCurrentInput["sourceBlobs"][number] => ({
    id,
    role,
    mediaType,
    identity: contentIdentity(bytes),
    bytesBase64: bytes.toString("base64"),
    capturedAt
  });

  return submitExternalEvidenceCurrentInputSchema.parse({
    revisionId,
    revisionManifestDigest: status.headRevision.manifest.digest,
    evidenceRootDigest: inspected.evidenceRoot.digest,
    actor: qualifier,
    artifactBindings: {
      bom,
      cam: {
        manifest: camManifest,
        artifacts: [
          bindingFor("manufacturing/gerbers/controller-F_Cu.gbr"),
          bindingFor("manufacturing/drill/controller.drl"),
          bindingFor("manufacturing/positions.csv")
        ]
      },
      targetBuildReport,
      targetBinary,
      bringupProcedure,
      acceptance: acceptanceArtifact
    },
    sourceBlobs: [
      source(asBuiltSourceId, "as_built_record", "application/json", jsonBytes(asBuiltRecord), asBuiltRecord.completedAt),
      source(firmwareBinarySourceId, "flashed_firmware_binary", "application/octet-stream", targetBinaryBytes, firmwareFlashRecord.flashedAt),
      source(firmwareFlashSourceId, "firmware_flash_record", "application/json", jsonBytes(firmwareFlashRecord), firmwareFlashRecord.flashedAt),
      source(calibrationSourceId, "instrument_calibration", "application/json", jsonBytes(calibrationRecord), calibrationRecord.calibratedAt),
      ...captureSources.map((capture) => source(capture.id, capture.role, capture.mediaType, capture.bytes, capture.capturedAt)),
      source(measurementSourceId, "parsed_measurement_record", "application/json", jsonBytes(measurementRecord), measurementRecord.completedAt)
    ],
    asBuiltRecordSourceId: asBuiltSourceId,
    flashedFirmwareBinarySourceId: firmwareBinarySourceId,
    firmwareFlashRecordSourceId: firmwareFlashSourceId,
    measurementRecordSourceId: measurementSourceId,
    instruments: [{ id: instrumentId, calibrationSourceId }],
    rationale: `Guarded current physical evidence for ${boardSerial}.`,
    expectedRevision,
    idempotencyKey
  });
};

const legacySubmissionFromCurrent = async (
  service: ApplicationService,
  runId: string,
  revisionId: string,
  current: SubmitExternalEvidenceCurrentInput
): Promise<SubmitExternalEvidenceInput> => {
  const listed = await service.listArtifacts({ runId, revisionId, includeStale: false });
  const hostCompile = listed.artifacts.find(
    (artifact) => artifact.logicalName === "firmware/reports/compile-validation.json"
  );
  if (hostCompile === undefined) throw new Error("Missing legacy host-compile binding fixture");
  return {
    ...current,
    artifactBindings: {
      bom: current.artifactBindings.bom,
      cam: current.artifactBindings.cam,
      firmwareBuild: { artifactId: hostCompile.id, identity: hostCompile.blob },
      bringupProcedure: current.artifactBindings.bringupProcedure,
      acceptance: current.artifactBindings.acceptance
    },
    sourceBlobs: current.sourceBlobs.map((source) =>
      source.role === "required_capture" || source.role === "supporting_attachment"
        ? { ...source, role: "raw_observation" as const }
        : source
    )
  } as unknown as SubmitExternalEvidenceInput;
};

describe("physical evidence release boundary", () => {
  it("rejects the original caller-hash and empty-measurement exploit without mutating state", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const beforeStatus = await service.getRunStatus({ runId: completed.run.id });
    const beforeArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    const beforeEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    const callerHash = (name: string) => contentIdentity(`never-stored-${name}`);
    const exploit = {
      revisionId: revision.id,
      actor: qualifier,
      boardSerial: "AUDIT-SPOOF-001",
      assemblyBuild: callerHash("assembly"),
      camBundle: callerHash("cam"),
      bom: callerHash("bom"),
      firmware: callerHash("firmware"),
      procedure: callerHash("procedure"),
      instruments: [{ id: "DMM-NOT-CALIBRATED", calibration: callerHash("calibration") }],
      measurements: {},
      verdict: "pass",
      rationale: "A caller-authored aggregate verdict must never become physical evidence.",
      expectedRevision: beforeStatus.run.revision,
      idempotencyKey: "reject-original-physical-evidence-exploit"
    } as unknown as SubmitExternalEvidenceInput;

    await expect(
      service.submitExternalEvidence(
        exploit,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toBeDefined();

    const afterStatus = await service.getRunStatus({ runId: completed.run.id });
    const afterArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    const afterEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    expect(afterStatus.run.revision).toBe(beforeStatus.run.revision);
    expect(afterStatus.effectiveLifecycle).toBe("candidate");
    expect(sortedIds(afterArtifacts.artifacts)).toEqual(sortedIds(beforeArtifacts.artifacts));
    expect(sortedIds(afterEvidence.evidence)).toEqual(sortedIds(beforeEvidence.evidence));
    expect(afterEvidence.evidenceRoot).toEqual(beforeEvidence.evidenceRoot);
  });

  it("qualifies and releases only a complete current v2 procedure record at the current evidence root", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const input = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "current-physical-evidence-v2",
      "CURRENT-V2-001"
    );
    const physical = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(physical.overallVerdict).toBe("pass");
    expect(physical.evidence.validationStatus).toBe("pass");
    expect(physical.rawArtifact.lifecycle).toBe("candidate");
    expect(physical.parsedArtifact.lifecycle).toBe("candidate");

    const parsedRecord = JSON.parse(
      (await service.readArtifact(physical.parsedArtifact.id)).bytes.toString("utf8")
    ) as {
      readonly schemaVersion: string;
      readonly acceptanceContract: { readonly schemaVersion: string; readonly cases: readonly unknown[] };
      readonly asBuiltRecord: {
        readonly schemaVersion: string;
        readonly assemblyOperator: { readonly id: string };
      };
      readonly firmwareFlashRecord: { readonly schemaVersion: string };
      readonly measurementRecord: {
        readonly schemaVersion: string;
        readonly operators: readonly { readonly id: string }[];
        readonly caseExecutions: readonly unknown[];
      };
    };
    expect(parsedRecord.schemaVersion).toBe("evleda.human-physical-evidence.v3");
    expect(parsedRecord.acceptanceContract.schemaVersion).toBe("evleda.physical-acceptance.v2");
    expect(parsedRecord.asBuiltRecord.schemaVersion).toBe("evleda.as-built-record.v2");
    expect(parsedRecord.firmwareFlashRecord.schemaVersion).toBe("evleda.firmware-flash-record.v2");
    expect(parsedRecord.measurementRecord.schemaVersion).toBe("evleda.physical-measurements.v2");
    expect(parsedRecord.acceptanceContract.cases.length).toBeGreaterThan(0);
    expect(parsedRecord.measurementRecord.caseExecutions).toHaveLength(
      parsedRecord.acceptanceContract.cases.length
    );
    expect(parsedRecord.measurementRecord.operators.map(({ id }) => id)).not.toContain(
      parsedRecord.asBuiltRecord.assemblyOperator.id
    );

    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const qualification = await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Reviewed every bound v2 procedure case and its raw captures.",
        scope: "CURRENT-V2-001 only",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "qualify-current-physical-v2"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(
      (await service.getRunStatus({ runId: completed.run.id })).effectiveLifecycle
    ).toBe("qualified");

    const afterQualification = await service.getRunStatus({ runId: completed.run.id });
    const release = await service.authorizeManufacturingRelease(
      {
        revisionId: revision.id,
        subjectDigest: revision.manifest.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        qualificationApprovalId: qualification.approval.id,
        actor: releaseAuthority,
        scope: "CURRENT-V2-001 exact build only",
        rationale: "Independent release review accepted the current exact evidence root.",
        expectedRevision: afterQualification.run.revision,
        idempotencyKey: "release-current-physical-v2"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    expect(release.effectiveLifecycle).toBe("release_authorized");
    expect(
      await service.submitExternalEvidence(
        input,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).toEqual(physical);
  });

  it("rejects firmware bytes or flash provenance detached from the exact target build", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const firmwareArtifacts = await service.listArtifacts({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: false
    });
    const hostCompile = firmwareArtifacts.artifacts.find(
      (artifact) => artifact.logicalName === "firmware/reports/compile-validation.json"
    );
    if (hostCompile === undefined) throw new Error("Missing host-compile fixture report");
    expect(
      JSON.parse((await service.readArtifact(hostCompile.id)).bytes.toString("utf8"))
    ).toMatchObject({ status: "pass" });
    const beforeEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    const base = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "target-firmware-binding-v2",
      "TARGET-BINDING-001"
    );
    const mutations: readonly [string, (record: MutableJson) => void][] = [
      ["target build report", (record) => {
        const binding = mutableObject(record.targetBuildReportArtifact, "target build report binding");
        corruptDigest(binding.identity, "target build report identity");
      }],
      ["target BIN artifact", (record) => {
        const binding = mutableObject(record.targetBinaryArtifact, "target BIN binding");
        corruptDigest(binding.identity, "target BIN identity");
      }],
      ["target source revision", (record) => {
        record.targetSourceRevisionDigest = "e".repeat(64);
      }],
      ["target configuration", (record) => {
        corruptDigest(record.targetConfigurationIdentity, "target configuration identity");
      }],
      ["target toolchain", (record) => {
        corruptDigest(record.targetToolchainIdentity, "target toolchain identity");
      }],
      ["target compiled source", (record) => {
        const sources = mutableArray(record.targetCompiledSources, "target compiled sources");
        const first = mutableObject(sources[0], "target compiled source");
        corruptDigest(first.identity, "target compiled source identity");
      }]
    ];
    const candidates: readonly [string, SubmitExternalEvidenceInput, string][] = [
      [
        "uploaded firmware bytes",
        replaceUploadedFirmware(base, Buffer.from("unrelated host-validation output", "utf8")),
        "INVALID_ARGUMENT"
      ],
      ...mutations.map(([label, mutate]): [string, SubmitExternalEvidenceInput, string] => [
        label,
        rewritePhysicalJsonSource(base, "firmware_flash_record", mutate),
        label === "target BIN artifact" ? "INVALID_ARGUMENT" : "DIGEST_MISMATCH"
      ])
    ];

    for (const [label, candidate, code] of candidates) {
      await expect(
        service.submitExternalEvidence(
          candidate,
          localHumanContext(qualifier, "hardware_qualification")
        ),
        label
      ).rejects.toMatchObject({ code });
      expect((await service.getRunStatus({ runId: completed.run.id })).run.revision, label).toBe(
        completed.run.revision
      );
    }
    const afterEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    expect(afterEvidence.evidenceRoot).toEqual(beforeEvidence.evidenceRoot);
    expect(sortedIds(afterEvidence.evidence)).toEqual(sortedIds(beforeEvidence.evidence));
  });

  it("rejects aggregate booleans that omit the required procedure-case executions", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const base = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "reject-aggregate-measurements-v2",
      "AGGREGATE-001"
    );
    const aggregateOnly = rewritePhysicalJsonSource(
      base,
      "parsed_measurement_record",
      (record) => {
        delete record.caseExecutions;
        record.categoryPassed = {
          rails: true,
          programming: true,
          communications: true,
          sensors: true,
          actuators: true,
          thermal: true,
          fault_reset: true
        };
        record.overallPassed = true;
      }
    );

    await expect(
      service.submitExternalEvidence(
        aggregateOnly,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const after = await service.getRunStatus({ runId: completed.run.id });
    expect(after.run.revision).toBe(completed.run.revision);
    expect(after.effectiveLifecycle).toBe("candidate");
  });

  it.each(["condition", "duration"] as const)(
    "persists a derived fail for an in-schema %s policy violation",
    async (violation) => {
      const service = await makeApplication();
      const completed = await createCompletedRun(service);
      const revision = completed.headRevision!;
      const base = await currentPhysicalEvidenceInput(
        service,
        completed.run.id,
        revision.id,
        completed.run.revision,
        `derived-${violation}-failure-v2`,
        `POLICY-${violation}`
      );
      let candidate: SubmitExternalEvidenceInput;
      if (violation === "condition") {
        candidate = rewritePhysicalJsonSource(base, "parsed_measurement_record", (record) => {
          const execution = mutableObject(
            mutableArray(record.caseExecutions, "case executions")[0],
            "case execution"
          );
          const condition = mutableObject(
            mutableArray(execution.actualConditions, "actual conditions")[0],
            "actual condition"
          );
          if (condition.kind === "numeric") {
            condition.value = Number(condition.value) + 1_000_000;
          } else {
            condition.observed = condition.observed === true ? false : true;
          }
        });
      } else {
        const captureSourceIds: string[] = [];
        let adjustedCaptureTime = "";
        candidate = rewritePhysicalJsonSource(base, "parsed_measurement_record", (record) => {
          const execution = mutableObject(
            mutableArray(record.caseExecutions, "case executions")[0],
            "case execution"
          );
          adjustedCaptureTime = new Date(Date.parse(String(execution.startedAt)) + 1).toISOString();
          execution.completedAt = adjustedCaptureTime;
          for (const observation of mutableArray(execution.observations, "observations")) {
            mutableObject(observation, "observation").observedAt = adjustedCaptureTime;
          }
          for (const binding of mutableArray(execution.captureBindings, "capture bindings")) {
            captureSourceIds.push(String(mutableObject(binding, "capture binding").sourceId));
          }
        });
        const mutableCandidate = candidate as unknown as { sourceBlobs: MutableSourceBlob[] };
        for (const source of mutableCandidate.sourceBlobs) {
          if (captureSourceIds.includes(String((source as unknown as { id: string }).id))) {
            (source as unknown as { capturedAt: string }).capturedAt = adjustedCaptureTime;
          }
        }
      }

      const physical = await service.submitExternalEvidence(
        candidate,
        localHumanContext(qualifier, "hardware_qualification")
      );
      expect(physical.overallVerdict).toBe("fail");
      expect(externalEvidenceResultSchema.parse(physical).overallVerdict).toBe("fail");
      expect(physical.evidence.validationStatus).toBe("fail");
      expect(physical.evidence.lifecycle).toBe("candidate");
      const record = JSON.parse(
        (await service.readArtifact(physical.parsedArtifact.id)).bytes.toString("utf8")
      ) as { readonly results: { readonly cases: readonly { readonly verdict: string }[] } };
      expect(record.results.cases.some(({ verdict }) => verdict === "fail")).toBe(true);
    }
  );

  it("rejects missing capture evidence and missing, unknown, or unused measurement operators", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const base = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "structural-physical-errors-v2",
      "STRUCTURAL-001"
    );
    const missingCapture = structuredClone(base) as SubmitExternalEvidenceCurrentInput;
    const captureIndex = missingCapture.sourceBlobs.findIndex(
      (source) => source.role === "required_capture"
    );
    if (captureIndex < 0) throw new Error("Physical fixture has no required capture source");
    const missingCaptureCandidate = {
      ...missingCapture,
      sourceBlobs: missingCapture.sourceBlobs.filter((_, index) => index !== captureIndex)
    } as SubmitExternalEvidenceInput;
    const missingOperators = rewritePhysicalJsonSource(
      base,
      "parsed_measurement_record",
      (record) => { record.operators = []; }
    );
    const unknownOperator = rewritePhysicalJsonSource(
      base,
      "parsed_measurement_record",
      (record) => {
        const execution = mutableObject(
          mutableArray(record.caseExecutions, "case executions")[0],
          "case execution"
        );
        execution.operatorId = "unknown-measurement-operator";
      }
    );
    const unusedOperator = rewritePhysicalJsonSource(
      base,
      "parsed_measurement_record",
      (record) => {
        mutableArray(record.operators, "measurement operators").push({
          type: "human",
          id: "unused-measurement-operator",
          displayName: "Unused Measurement Operator",
          role: "measurement_operator"
        });
      }
    );
    const cases: readonly [string, SubmitExternalEvidenceInput, string][] = [
      ["missing capture source", missingCaptureCandidate, "EVIDENCE_MISSING"],
      ["missing operators", missingOperators, "INVALID_ARGUMENT"],
      ["unknown operator", unknownOperator, "INVALID_ARGUMENT"],
      ["unused operator", unusedOperator, "INVALID_ARGUMENT"]
    ];
    const beforeEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    for (const [label, candidate, code] of cases) {
      await expect(
        service.submitExternalEvidence(
          candidate,
          localHumanContext(qualifier, "hardware_qualification")
        ),
        label
      ).rejects.toMatchObject({ code });
      expect((await service.getRunStatus({ runId: completed.run.id })).run.revision, label).toBe(
        completed.run.revision
      );
    }
    const afterEvidence = await service.inspectEvidence({
      runId: completed.run.id,
      revisionId: revision.id,
      includeStale: true
    });
    expect(afterEvidence.evidenceRoot).toEqual(beforeEvidence.evidenceRoot);
    expect(sortedIds(afterEvidence.evidence)).toEqual(sortedIds(beforeEvidence.evidence));
  });

  it.each([
    "rails",
    "programming",
    "communications",
    "sensors",
    "actuators",
    "thermal",
    "fault_reset"
  ] as const)("keeps a derived %s failure candidate-only and nonqualifying", async (category) => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const base = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      `derived-${category}-failure-v2`,
      `FAILED-${category}`
    );
    const acceptanceArtifact = base.artifactBindings.acceptance.artifactId;
    const acceptance = physicalAcceptanceContractSchema.parse(
      JSON.parse((await service.readArtifact(acceptanceArtifact)).bytes.toString("utf8"))
    );
    const test = acceptance.tests.find((candidate) => candidate.category === category)!;
    const failed = rewritePhysicalJsonSource(
      base,
      "parsed_measurement_record",
      (record) => {
        const execution = mutableArray(record.caseExecutions, "case executions")
          .map((candidate) => mutableObject(candidate, "case execution"))
          .find((candidate) => candidate.caseId === test.caseId)!;
        const observation = mutableArray(execution.observations, "observations")
          .map((candidate) => mutableObject(candidate, "observation"))
          .find((candidate) => candidate.testId === test.id)!;
        if (test.kind === "numeric_range") {
          observation.value = test.maximum + 1;
        } else {
          observation.observed = typeof test.expected === "boolean"
            ? !test.expected
            : `${test.expected}-wrong`;
        }
      }
    );

    const physical = await service.submitExternalEvidence(
      failed,
      localHumanContext(qualifier, "hardware_qualification")
    );
    expect(physical.categoryVerdicts[category]).toBe("fail");
    expect(physical.overallVerdict).toBe("fail");
    expect(physical.evidence.validationStatus).toBe("fail");
    expect(physical.evidence.lifecycle).toBe("candidate");
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    await expect(
      service.qualifyRevision(
        {
          revisionId: revision.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          actor: qualifier,
          rationale: "A failed physical category must not qualify.",
          scope: `${category} failure fixture`,
          expectedRevision: afterPhysical.run.revision,
          idempotencyKey: `reject-${category}-qualification-v2`
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "GATE_FAILED" });
  });

  it("keeps a structurally valid legacy submission nonqualifying and state-neutral", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const current = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "legacy-nonqualifying-v1",
      "LEGACY-001"
    );
    const legacy = await legacySubmissionFromCurrent(
      service,
      completed.run.id,
      revision.id,
      current
    );
    const before = await service.getRunStatus({ runId: completed.run.id });

    await expect(
      service.submitExternalEvidence(
        legacy,
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({
      code: "GATE_FAILED",
      message: expect.stringMatching(/legacy physical evidence.*cannot create/iu)
    });
    const after = await service.getRunStatus({ runId: completed.run.id });
    expect(after.run.revision).toBe(before.run.revision);
    expect(after.effectiveLifecycle).toBe("candidate");
  });

  it("replays a pre-existing same-key receipt for a canonical legacy request before admission", async () => {
    let projectingState!: ReadProjectingStateStore;
    const service = await makeApplication(fixtureRegistry, undefined, {
      decorateState: (state) => {
        projectingState = new ReadProjectingStateStore(state);
        return projectingState;
      }
    });
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const current = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "legacy-exact-replay-receipt",
      "LEGACY-REPLAY-001"
    );
    const originalReceipt = await service.submitExternalEvidence(
      current,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const legacy = submitExternalEvidenceLegacyInputSchema.parse(
      await legacySubmissionFromCurrent(
        service,
        completed.run.id,
        revision.id,
        current
      )
    );
    const canonicalRequest = structuredClone(legacy) as unknown as MutableJson;
    delete canonicalRequest.idempotencyKey;
    const legacyRequestDigest = canonicalIdentity(
      { operation: "submit_external_evidence", input: canonicalRequest },
      "evleda.application-command.v1"
    ).digest;
    const storageKey = `idempotency_scope_${canonicalIdentity(
      { operation: "submit_external_evidence", idempotencyKey: legacy.idempotencyKey },
      "evleda.idempotency-scope.v1"
    ).digest}`;
    projectingState.projection = (state) => {
      const projected = structuredClone(state) as MutableEvlEdaState;
      const receipt = projected.idempotency[storageKey];
      if (receipt === undefined) throw new Error("Missing stored physical evidence receipt");
      projected.idempotency[storageKey] = {
        ...receipt,
        requestDigest: legacyRequestDigest
      };
      return projected;
    };
    const beforeReplay = await service.getRunStatus({ runId: completed.run.id });

    const replay = await service.submitExternalEvidence(
      legacy,
      localHumanContext(qualifier, "hardware_qualification")
    );

    expect(replay).toEqual(originalReceipt);
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      beforeReplay.run.revision
    );
  });

  it.each([
    {
      name: "firmware execution fence",
      expectedCode: "ARTIFACT_INTEGRITY_ERROR",
      tamper: (state: MutableEvlEdaState, input: SubmitExternalEvidenceCurrentInput) => {
        const run = state.runs[state.revisions[input.revisionId]!.runId]!;
        const attempts = [...run.attempts.firmware_contract];
        const index = attempts.findIndex((attempt) =>
          attempt.artifactIds.includes(input.artifactBindings.targetBuildReport.artifactId)
        );
        const attempt = attempts[index]!;
        attempts[index] = {
          ...attempt,
          executionFence: { ...attempt.executionFence!, parentRevisionId: "revision_tampered_fence" }
        };
        state.runs[run.id] = {
          ...run,
          attempts: { ...run.attempts, firmware_contract: attempts }
        };
      }
    },
    {
      name: "target report compiler identity",
      expectedCode: "EXTERNAL_ACCEPTANCE_REQUIRED",
      tamper: (state: MutableEvlEdaState, input: SubmitExternalEvidenceCurrentInput) => {
        const id = input.artifactBindings.targetBuildReport.artifactId;
        const artifact = state.artifacts[id]!;
        state.artifacts[id] = {
          ...artifact,
          tool: { ...artifact.tool, executableDigest: "0".repeat(64) }
        };
      }
    },
    {
      name: "target BIN compiler identity",
      expectedCode: "EXTERNAL_ACCEPTANCE_REQUIRED",
      tamper: (state: MutableEvlEdaState, input: SubmitExternalEvidenceCurrentInput) => {
        const id = input.artifactBindings.targetBinary.artifactId;
        const artifact = state.artifacts[id]!;
        state.artifacts[id] = {
          ...artifact,
          tool: { ...artifact.tool, executableDigest: "f".repeat(64) }
        };
      }
    },
    ...[
      "evleda.firmware-target-build-source.v1",
      "evleda.firmware-target-build-backend-config.v1",
      "evleda.arm-gnu-toolchain-identity.v1"
    ].map((schemaVersion) => ({
      name: `${schemaVersion} exact input`,
      expectedCode: "ARTIFACT_INTEGRITY_ERROR",
      tamper: (state: MutableEvlEdaState, input: SubmitExternalEvidenceCurrentInput) => {
        const id = input.artifactBindings.targetBuildReport.artifactId;
        const artifact = state.artifacts[id]!;
        state.artifacts[id] = {
          ...artifact,
          exactInputs: artifact.exactInputs.filter(
            (identity) => !("schemaVersion" in identity && identity.schemaVersion === schemaVersion)
          )
        };
      }
    }))
  ])("rejects persisted $name tampering before qualification", async ({ name, expectedCode, tamper }) => {
    let projectingState!: ReadProjectingStateStore;
    const service = await makeApplication(fixtureRegistry, undefined, {
      decorateState: (state) => {
        projectingState = new ReadProjectingStateStore(state);
        return projectingState;
      }
    });
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const keySuffix = name.replace(/[^a-z0-9]+/giu, "-").toLocaleLowerCase("en-US");
    const input = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      `persisted-target-tamper-${keySuffix}`,
      "PERSISTED-TAMPER-001"
    );
    const physical = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const before = await service.getRunStatus({ runId: completed.run.id });
    projectingState.projection = (state) => {
      const projected = structuredClone(state) as MutableEvlEdaState;
      tamper(projected, input);
      return projected;
    };

    await expect(
      service.qualifyRevision(
        {
          revisionId: revision.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          actor: qualifier,
          rationale: "Persisted target provenance tampering must fail closed.",
          scope: "persisted tamper fixture",
          expectedRevision: before.run.revision,
          idempotencyKey: `reject-persisted-target-tamper-${keySuffix}`
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: expectedCode });
    projectingState.projection = undefined;
    const state = await projectingState.read();
    expect(Object.values(state.approvals).filter((approval) => approval.kind === "qualification"))
      .toHaveLength(0);
  });

  it("fails closed when a stored physical source disappears before qualification", async () => {
    let content!: SelectivelyMissingContentStore;
    const service = await makeApplication(fixtureRegistry, undefined, {
      decorateContent: (base) => {
        content = new SelectivelyMissingContentStore(base);
        return content;
      }
    });
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const input = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "missing-cas-before-qualification",
      "MISSING-CAS-001"
    );
    const physical = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const before = await service.getRunStatus({ runId: completed.run.id });
    const measurementSource = input.sourceBlobs.find(
      (source) => source.role === "parsed_measurement_record"
    )!;
    content.missingDigests.add(measurementSource.identity.digest);
    await expect(
      service.qualifyRevision(
        {
          revisionId: revision.id,
          requirementsDigest: completed.run.requirements!.identity.digest,
          evidenceRootDigest: physical.evidenceRoot.digest,
          actor: qualifier,
          rationale: "Missing source bytes must fail closed.",
          scope: "missing CAS fixture",
          expectedRevision: before.run.revision,
          idempotencyKey: "reject-missing-cas-qualification"
        },
        localHumanContext(qualifier, "hardware_qualification")
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    content.missingDigests.clear();
    const after = await service.getRunStatus({ runId: completed.run.id });
    expect(after.run.revision).toBe(before.run.revision);
    expect(after.effectiveLifecycle).toBe("candidate");
    expect(after.activeAttestations.map((approval) => approval.kind)).toEqual(["requirements"]);
  });

  it("demotes qualification and release after calibration or evidence expiry", async () => {
    let current = new Date("2026-09-03T12:00:00.000Z");
    const service = await makeApplication(fixtureRegistry, undefined, { now: () => current });
    const completed = await createCompletedRun(service);
    const revision = completed.headRevision!;
    const input = await currentPhysicalEvidenceInput(
      service,
      completed.run.id,
      revision.id,
      completed.run.revision,
      "post-release-calibration-expiry",
      "EXPIRY-RELEASE-001"
    );
    const physical = await service.submitExternalEvidence(
      input,
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const qualification = await service.qualifyRevision(
      {
        revisionId: revision.id,
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        actor: qualifier,
        rationale: "Current exact physical record reviewed.",
        scope: "expiry fixture",
        expectedRevision: afterPhysical.run.revision,
        idempotencyKey: "expiry-fixture-qualification"
      },
      localHumanContext(qualifier, "hardware_qualification")
    );
    const afterQualification = await service.getRunStatus({ runId: completed.run.id });
    const release = await service.authorizeManufacturingRelease(
      {
        revisionId: revision.id,
        subjectDigest: revision.manifest.digest,
        evidenceRootDigest: physical.evidenceRoot.digest,
        qualificationApprovalId: qualification.approval.id,
        actor: releaseAuthority,
        scope: "expiry fixture",
        rationale: "Independent release review completed.",
        expectedRevision: afterQualification.run.revision,
        idempotencyKey: "expiry-fixture-release"
      },
      localHumanContext(releaseAuthority, "manufacturing_release")
    );
    expect(release.effectiveLifecycle).toBe("release_authorized");

    current = new Date("2027-01-01T00:00:00.000Z");
    const expired = await service.getRunStatus({ runId: completed.run.id });
    expect(expired.effectiveLifecycle).toBe("candidate");
    expect(expired.activeAttestations.map((approval) => approval.kind)).toEqual(["requirements"]);
  });
});

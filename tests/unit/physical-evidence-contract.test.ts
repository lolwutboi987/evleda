import { describe, expect, it } from "vitest";

import {
  PHYSICAL_OBSERVATION_CATEGORIES,
  bringupPlanSchema,
  physicalAcceptanceContractSchema,
  physicalAsBuiltRecordSchema,
  physicalFirmwareFlashRecordSchema,
  physicalInstrumentCalibrationRecordSchema,
  physicalMeasurementRecordSchema,
  type PhysicalAcceptanceContract,
  type PhysicalMeasurementRecord
} from "../../src/contracts/operations.js";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import {
  evaluatePhysicalEvidence,
  type PhysicalEvidenceEvaluationInput
} from "../../src/application/physical-evidence.js";
import { physicalAcceptanceContract } from "../../src/generators/bringup-generator.js";
import { ROBOTICS_CONTROLLER_V0 } from "../../src/knowledge/reference-controller-v0.js";

const binding = (label: string) => ({
  artifactId: `artifact-${label}`,
  identity: contentIdentity(`artifact bytes for ${label}`)
});

const measurementOperator = {
  type: "human" as const,
  id: "measurement-operator-001",
  displayName: "Measurement Operator",
  role: "measurement_operator" as const
};

const assemblyOperator = {
  type: "human" as const,
  id: "assembly-operator-001",
  displayName: "Assembly Operator",
  role: "assembly_operator" as const
};

const acceptanceFixture = (): PhysicalAcceptanceContract =>
  physicalAcceptanceContractSchema.parse({
    schemaVersion: "evleda.physical-acceptance.v2",
    procedureSchemaVersion: "evleda.bringup-plan.v2",
    procedureId: "bringup-procedure-001",
    profileId: "physical-fixture-profile",
    boardRevision: "EVL-RC-G0-REV-A",
    lifecycle: "candidate",
    cases: PHYSICAL_OBSERVATION_CATEGORIES.map((category, index) => ({
      caseId: `${category}-case`,
      procedureStepId: `BU-${(index + 1).toString().padStart(2, "0")}`,
      endpointId: `${category}-endpoint`,
      requiredConditions: [{
        conditionId: `${category}-enabled`,
        kind: "exact" as const,
        expected: true
      }],
      minimumDurationMs: 1_000,
      captureRequirements: [{
        captureRequirementId: `${category}-capture`,
        kind: "scalar_measurement" as const,
        description: `Raw ${category} fixture capture`,
        allowedMediaTypes: ["text/csv" as const],
        instrumentCapability: "dc_voltage" as const,
        minimumSamples: 1
      }]
    })),
    tests: PHYSICAL_OBSERVATION_CATEGORIES.map((category) => ({
      id: `${category}-test`,
      caseId: `${category}-case`,
      category,
      quantity: `${category} acceptance quantity`,
      instrumentCapability: "dc_voltage" as const,
      kind: "numeric_range" as const,
      unit: "V" as const,
      minimum: 0,
      maximum: 10
    }))
  });

const measurementFixture = (): PhysicalMeasurementRecord => {
  const acceptance = acceptanceFixture();
  const targetBuildReportArtifact = binding("target-report");
  const targetBinaryArtifact = binding("target-bin");
  const targetCompiledSources = [{
    logicalName: "firmware/src/board_contract.c",
    identity: contentIdentity("target compiled source")
  }];
  return physicalMeasurementRecordSchema.parse({
    schemaVersion: "evleda.physical-measurements.v2",
    boardSerial: "CONTRACT-001",
    bringupProcedureArtifact: binding("bringup-procedure"),
    acceptanceArtifact: binding("acceptance"),
    targetBuildReportArtifact,
    targetBinaryArtifact,
    projectId: "project-physical-contract",
    runId: "run-physical-contract",
    designRevisionId: "revision-physical-contract",
    targetBuildSourceIdentity: canonicalIdentity(
      { fixture: "target-build-source" },
      "evleda.firmware-target-build-source.v1"
    ),
    targetSourceRevisionDigest: "a".repeat(64),
    targetConfigurationIdentity: canonicalIdentity(
      { fixture: "target-configuration" },
      "evleda.firmware-target-build-configuration.v1"
    ),
    targetToolchainIdentity: canonicalIdentity(
      { fixture: "target-toolchain" },
      "evleda.arm-gnu-toolchain-identity.v1"
    ),
    targetCompiledSources,
    firmwareBinarySourceId: "flashed-firmware-source",
    firmwareBinaryIdentity: targetBinaryArtifact.identity,
    environment: {
      location: "Guarded fixture bench",
      fixtureId: "fixture-001",
      supply: "Current-limited isolated supply",
      ambientTemperatureC: 23,
      relativeHumidityPercent: 45
    },
    operators: [measurementOperator],
    startedAt: "2026-09-03T09:00:00.000Z",
    completedAt: "2026-09-03T10:00:00.000Z",
    caseExecutions: acceptance.cases.map((testCase, index) => {
      const test = acceptance.tests.find((candidate) => candidate.caseId === testCase.caseId)!;
      const capture = testCase.captureRequirements[0]!;
      const startedAtMs = Date.parse("2026-09-03T09:00:00.000Z") + index * 2_000;
      const completedAtMs = startedAtMs + 1_000;
      const observedAt = new Date(startedAtMs + 500).toISOString();
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
        captureBindings: [{
          captureRequirementId: capture.captureRequirementId,
          sourceId: `${testCase.caseId}-capture-source`,
          instrumentId: "instrument-001",
          sampleCount: capture.minimumSamples ?? 1
        }],
        observations: [{
          testId: test.id,
          instrumentId: "instrument-001",
          captureRequirementId: capture.captureRequirementId,
          observedAt,
          kind: "numeric_range" as const,
          value: 5,
          unit: "V" as const
        }]
      };
    })
  });
};

const evaluationFixture = (): PhysicalEvidenceEvaluationInput => {
  const acceptanceContract = acceptanceFixture();
  const measurementRecord = measurementFixture();
  const revision = {
    id: measurementRecord.designRevisionId,
    projectId: measurementRecord.projectId,
    runId: measurementRecord.runId,
    ordinal: 9,
    parentRevisionIds: ["revision-physical-parent"],
    manifest: canonicalIdentity(
      { revisionId: measurementRecord.designRevisionId },
      "evleda.revision-manifest.v1"
    ),
    artifactIds: [],
    evidenceIds: [],
    lifecycle: "candidate" as const,
    createdAt: "2026-09-03T08:00:00.000Z"
  };
  const plan = bringupPlanSchema.parse({
    schemaVersion: "evleda.bringup-plan.v2",
    procedureId: acceptanceContract.procedureId,
    profileId: acceptanceContract.profileId,
    boardRevision: acceptanceContract.boardRevision,
    lifecycle: "candidate",
    defaultResult: "NOT_RUN",
    steps: acceptanceContract.cases.map((testCase, index) => ({
      id: testCase.procedureStepId,
      phase: index + 1,
      title: `${testCase.caseId} procedure`,
      preconditions: ["Guarded fixture ready"],
      procedure: ["Execute the bound fixture case"],
      acceptance: ["Evaluate every bound observation"],
      stopConditions: ["Stop on any limit violation"],
      evidence: ["Retain the required raw capture"]
    })),
    cases: acceptanceContract.cases.map((testCase) => ({
      ...testCase,
      title: `${testCase.caseId} procedure case`,
      procedure: ["Execute the exact bound case"]
    })),
    evidenceRequirements: ["Exact case-bound raw evidence"]
  });
  const calibration = physicalInstrumentCalibrationRecordSchema.parse({
    schemaVersion: "evleda.instrument-calibration.v1",
    instrumentId: "instrument-001",
    manufacturer: "Fixture Instruments",
    model: "COMBO-001",
    serial: "INSTRUMENT-001",
    calibratedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-12-31T00:00:00.000Z",
    capabilities: [
      { capability: "programmer", units: [] },
      { capability: "dc_voltage", units: ["V"] }
    ]
  });
  const asBuiltRecord = physicalAsBuiltRecordSchema.parse({
    schemaVersion: "evleda.as-built-record.v2",
    boardSerial: measurementRecord.boardSerial,
    assemblyLot: "lot-contract-001",
    assemblyOperator,
    completedAt: "2026-09-02T12:00:00.000Z",
    revisionManifestDigest: revision.manifest.digest,
    bomArtifact: binding("bom"),
    camManifestArtifact: binding("cam-manifest"),
    substitutions: []
  });
  const firmwareFlashRecord = physicalFirmwareFlashRecordSchema.parse({
    schemaVersion: "evleda.firmware-flash-record.v2",
    boardSerial: measurementRecord.boardSerial,
    flashedAt: "2026-09-03T09:05:00.000Z",
    targetBuildReportArtifact: measurementRecord.targetBuildReportArtifact,
    targetBinaryArtifact: measurementRecord.targetBinaryArtifact,
    projectId: measurementRecord.projectId,
    runId: measurementRecord.runId,
    designRevisionId: measurementRecord.designRevisionId,
    targetBuildSourceIdentity: measurementRecord.targetBuildSourceIdentity,
    targetSourceRevisionDigest: measurementRecord.targetSourceRevisionDigest,
    targetConfigurationIdentity: measurementRecord.targetConfigurationIdentity,
    targetToolchainIdentity: measurementRecord.targetToolchainIdentity,
    targetCompiledSources: measurementRecord.targetCompiledSources,
    firmwareBinarySourceId: measurementRecord.firmwareBinarySourceId,
    firmwareBinaryIdentity: measurementRecord.firmwareBinaryIdentity,
    programmerInstrumentId: "instrument-001"
  });
  const primarySourceIds = {
    asBuiltRecord: "as-built-source",
    flashedFirmwareBinary: measurementRecord.firmwareBinarySourceId,
    firmwareFlashRecord: "firmware-flash-source",
    measurementRecord: "measurement-record-source"
  };
  const requirementById = new Map(
    acceptanceContract.cases.flatMap((testCase) =>
      testCase.captureRequirements.map((requirement) => [
        requirement.captureRequirementId,
        requirement
      ] as const)
    )
  );
  const captureSources = measurementRecord.caseExecutions.flatMap((execution) =>
    execution.captureBindings.map((capture) => {
      const requirement = requirementById.get(capture.captureRequirementId)!;
      return {
        id: capture.sourceId,
        role: "required_capture" as const,
        mediaType: requirement.allowedMediaTypes[0]!,
        identity: contentIdentity(`capture bytes ${capture.sourceId}`),
        capturedAt: new Date(
          (Date.parse(execution.startedAt) + Date.parse(execution.completedAt)) / 2
        ).toISOString()
      };
    })
  );
  return {
    revision,
    bindings: {
      bom: asBuiltRecord.bomArtifact,
      cam: {
        manifest: asBuiltRecord.camManifestArtifact,
        artifacts: [binding("cam-gerber"), binding("cam-drill"), binding("cam-position")]
      },
      targetBuildReport: measurementRecord.targetBuildReportArtifact,
      targetBinary: measurementRecord.targetBinaryArtifact,
      bringupProcedure: measurementRecord.bringupProcedureArtifact,
      acceptance: measurementRecord.acceptanceArtifact
    },
    targetBuild: {
      projectId: measurementRecord.projectId,
      runId: measurementRecord.runId,
      designRevisionId: measurementRecord.designRevisionId,
      reportArtifact: measurementRecord.targetBuildReportArtifact,
      binaryArtifact: measurementRecord.targetBinaryArtifact,
      binaryIdentity: measurementRecord.firmwareBinaryIdentity,
      targetSourceRevisionDigest: measurementRecord.targetSourceRevisionDigest,
      targetBuildSourceIdentity: measurementRecord.targetBuildSourceIdentity,
      targetConfigurationIdentity: measurementRecord.targetConfigurationIdentity,
      targetToolchainIdentity: measurementRecord.targetToolchainIdentity,
      targetCompiledSources: measurementRecord.targetCompiledSources
    },
    plan,
    acceptanceContract,
    sources: [
      {
        id: primarySourceIds.asBuiltRecord,
        role: "as_built_record",
        mediaType: "application/json",
        identity: contentIdentity("as-built record bytes"),
        capturedAt: asBuiltRecord.completedAt
      },
      {
        id: primarySourceIds.flashedFirmwareBinary,
        role: "flashed_firmware_binary",
        mediaType: "application/octet-stream",
        identity: measurementRecord.firmwareBinaryIdentity,
        capturedAt: firmwareFlashRecord.flashedAt
      },
      {
        id: primarySourceIds.firmwareFlashRecord,
        role: "firmware_flash_record",
        mediaType: "application/json",
        identity: contentIdentity("firmware flash record bytes"),
        capturedAt: firmwareFlashRecord.flashedAt
      },
      {
        id: "calibration-source",
        role: "instrument_calibration",
        mediaType: "application/json",
        identity: contentIdentity("calibration record bytes"),
        capturedAt: calibration.calibratedAt
      },
      ...captureSources,
      {
        id: primarySourceIds.measurementRecord,
        role: "parsed_measurement_record",
        mediaType: "application/json",
        identity: contentIdentity("measurement record bytes"),
        capturedAt: measurementRecord.completedAt
      }
    ],
    primarySourceIds,
    asBuiltRecord,
    firmwareFlashRecord,
    measurementRecord,
    instruments: [{
      id: "instrument-001",
      calibrationSourceId: "calibration-source",
      calibration
    }],
    now: new Date("2026-09-03T12:00:00.000Z")
  };
};

type MutableJson = Record<string, unknown>;

const mutableObject = (value: unknown, label: string): MutableJson => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as MutableJson;
};

const mutableArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be an array`);
  return value;
};

const expectEvaluationError = (
  input: PhysicalEvidenceEvaluationInput,
  code: string
): void => {
  try {
    evaluatePhysicalEvidence(input);
    throw new Error("Expected physical evidence evaluation to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

describe("physical evidence v2 contracts", () => {
  it("blocks the incomplete reference policy and requires cases instead of caller aggregates", () => {
    expect(() => physicalAcceptanceContract(ROBOTICS_CONTROLLER_V0)).toThrow(
      /physical acceptance policy is not executable/iu
    );
    const contract = acceptanceFixture();
    expect(contract.schemaVersion).toBe("evleda.physical-acceptance.v2");
    expect(contract.cases.length).toBeGreaterThanOrEqual(PHYSICAL_OBSERVATION_CATEGORIES.length);
    expect(new Set(contract.tests.map(({ category }) => category))).toEqual(
      new Set(PHYSICAL_OBSERVATION_CATEGORIES)
    );
    expect(
      contract.cases.every((testCase) =>
        contract.tests.some((test) => test.caseId === testCase.caseId)
      )
    ).toBe(true);
    expect(physicalAcceptanceContractSchema.parse(contract)).toEqual(contract);

    const { cases: _cases, ...withoutCases } = structuredClone(contract);
    const aggregateOnly = {
      ...withoutCases,
      categoryPassed: Object.fromEntries(
        PHYSICAL_OBSERVATION_CATEGORIES.map((category) => [category, true])
      ),
      overallPassed: true
    };
    expect(physicalAcceptanceContractSchema.safeParse(aggregateOnly).success).toBe(false);
  });

  it("accepts distinct assembly and measurement operators but rejects missing, unknown, or unused operators", () => {
    expect(physicalAsBuiltRecordSchema.safeParse({
      schemaVersion: "evleda.as-built-record.v2",
      boardSerial: "CONTRACT-001",
      assemblyLot: "lot-contract-001",
      assemblyOperator,
      completedAt: "2026-09-02T12:00:00.000Z",
      revisionManifestDigest: "b".repeat(64),
      bomArtifact: binding("bom"),
      camManifestArtifact: binding("cam-manifest"),
      substitutions: []
    }).success).toBe(true);
    expect(measurementOperator.id).not.toBe(assemblyOperator.id);

    const valid = measurementFixture();
    expect(physicalMeasurementRecordSchema.parse(valid)).toEqual(valid);

    expect(physicalMeasurementRecordSchema.safeParse({ ...valid, operators: [] }).success).toBe(false);
    expect(physicalMeasurementRecordSchema.safeParse({
      ...valid,
      caseExecutions: valid.caseExecutions.map((execution, index) =>
        index === 0 ? { ...execution, operatorId: "unknown-measurement-operator" } : execution
      )
    }).success).toBe(false);
    expect(physicalMeasurementRecordSchema.safeParse({
      ...valid,
      operators: [
        ...valid.operators,
        { ...measurementOperator, id: "unused-measurement-operator" }
      ]
    }).success).toBe(false);
  });

  it("rejects structurally incomplete conditions, durations, captures, and observation bindings", () => {
    const valid = measurementFixture();
    const first = valid.caseExecutions[0]!;
    const replaceFirst = (replacement: typeof first): PhysicalMeasurementRecord => ({
      ...valid,
      caseExecutions: [replacement, ...valid.caseExecutions.slice(1)]
    });

    expect(physicalMeasurementRecordSchema.safeParse(replaceFirst({
      ...first,
      actualConditions: []
    })).success).toBe(false);
    expect(physicalMeasurementRecordSchema.safeParse(replaceFirst({
      ...first,
      completedAt: first.startedAt
    })).success).toBe(false);
    expect(physicalMeasurementRecordSchema.safeParse(replaceFirst({
      ...first,
      captureBindings: []
    })).success).toBe(false);
    expect(physicalMeasurementRecordSchema.safeParse(replaceFirst({
      ...first,
      observations: first.observations.map((observation) => ({
        ...observation,
        captureRequirementId: "unbound-capture-requirement"
      }))
    })).success).toBe(false);
  });

  it("derives a pass only from the complete case, capture, and observation set", () => {
    const input = evaluationFixture();
    const evaluated = evaluatePhysicalEvidence(input);
    expect(evaluated.results.cases).toHaveLength(input.acceptanceContract.cases.length);
    expect(evaluated.results.observations).toHaveLength(input.acceptanceContract.tests.length);
    expect(evaluated.results.cases.every(({ verdict }) => verdict === "pass")).toBe(true);
    expect(evaluated.results.observations.every(({ verdict }) => verdict === "pass")).toBe(true);
    expect(evaluated.results.categories).toEqual(
      Object.fromEntries(PHYSICAL_OBSERVATION_CATEGORIES.map((category) => [category, "pass"]))
    );
    expect(evaluated.results.overallVerdict).toBe("pass");
    expect(evaluated.validUntil).toBe("2026-10-03T10:00:00.000Z");
  });

  it("caps evidence validity at calibratedAt plus the maximum calibration age", () => {
    const input = evaluationFixture();
    const calibratedAt = "2025-09-10T00:00:00.000Z";
    const calibration = input.instruments[0]!.calibration as unknown as MutableJson;
    calibration.calibratedAt = calibratedAt;
    calibration.validUntil = "2027-12-31T00:00:00.000Z";
    const calibrationSource = input.sources.find((source) => source.role === "instrument_calibration")! as unknown as MutableJson;
    calibrationSource.capturedAt = calibratedAt;
    const expected = new Date(
      Date.parse(calibratedAt) + 366 * 24 * 60 * 60 * 1_000
    ).toISOString();
    expect(evaluatePhysicalEvidence(input).validUntil).toBe(expected);
  });

  it.each(PHYSICAL_OBSERVATION_CATEGORIES)(
    "derives a failed %s category from one failed exact observation",
    (category) => {
      const input = evaluationFixture();
      const test = input.acceptanceContract.tests.find(
        (candidate) => candidate.category === category
      )!;
      const mutable = input as unknown as MutableJson;
      const measurement = mutableObject(mutable.measurementRecord, "measurement record");
      const executions = mutableArray(measurement.caseExecutions, "case executions");
      const execution = executions
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

      const evaluated = evaluatePhysicalEvidence(input);
      expect(evaluated.results.categories[category]).toBe("fail");
      expect(evaluated.results.overallVerdict).toBe("fail");
      expect(evaluated.results.observations.find(({ testId }) => testId === test.id)).toMatchObject({
        category,
        verdict: "fail"
      });
      expect(evaluated.results.cases.find(({ caseId }) => caseId === test.caseId)).toMatchObject({
        verdict: "fail"
      });
    }
  );

  it("derives case failures for wrong conditions, insufficient duration, or insufficient samples", () => {
    const wrongCondition = evaluationFixture();
    const wrongExecution = mutableObject(
      mutableArray(
        mutableObject(
          (wrongCondition as unknown as MutableJson).measurementRecord,
          "measurement record"
        ).caseExecutions,
        "case executions"
      )[0],
      "case execution"
    );
    const actualCondition = mutableObject(
      mutableArray(wrongExecution.actualConditions, "actual conditions")[0],
      "actual condition"
    );
    actualCondition.observed = actualCondition.observed === true ? false : true;
    expect(evaluatePhysicalEvidence(wrongCondition).results).toMatchObject({
      overallVerdict: "fail"
    });

    const shortDuration = evaluationFixture();
    const shortMutable = shortDuration as unknown as MutableJson;
    const acceptanceCase = mutableObject(
      mutableArray(
        mutableObject(shortMutable.acceptanceContract, "acceptance contract").cases,
        "acceptance cases"
      )[0],
      "acceptance case"
    );
    const planCase = mutableObject(
      mutableArray(mutableObject(shortMutable.plan, "bring-up plan").cases, "plan cases")[0],
      "plan case"
    );
    acceptanceCase.minimumDurationMs = 600_000;
    planCase.minimumDurationMs = 600_000;
    expect(evaluatePhysicalEvidence(shortDuration).results).toMatchObject({
      overallVerdict: "fail"
    });

    const tooFewSamples = evaluationFixture();
    const samplesMutable = tooFewSamples as unknown as MutableJson;
    const sampleAcceptanceCase = mutableObject(
      mutableArray(
        mutableObject(samplesMutable.acceptanceContract, "acceptance contract").cases,
        "acceptance cases"
      )[0],
      "acceptance case"
    );
    const samplePlanCase = mutableObject(
      mutableArray(mutableObject(samplesMutable.plan, "bring-up plan").cases, "plan cases")[0],
      "plan case"
    );
    mutableObject(
      mutableArray(sampleAcceptanceCase.captureRequirements, "capture requirements")[0],
      "capture requirement"
    ).minimumSamples = 2;
    mutableObject(
      mutableArray(samplePlanCase.captureRequirements, "capture requirements")[0],
      "capture requirement"
    ).minimumSamples = 2;
    expect(evaluatePhysicalEvidence(tooFewSamples).results).toMatchObject({
      overallVerdict: "fail"
    });

    const overlapping = evaluationFixture();
    const overlapMutable = overlapping as unknown as MutableJson;
    const overlapExecutions = mutableArray(
      mutableObject(overlapMutable.measurementRecord, "measurement record").caseExecutions,
      "case executions"
    ).map((entry) => mutableObject(entry, "case execution"));
    overlapExecutions[1]!.startedAt = overlapExecutions[0]!.startedAt;
    expect(evaluatePhysicalEvidence(overlapping).results).toMatchObject({
      overallVerdict: "fail"
    });
  });

  it("rejects missing, reused, or role-detached required capture sources", () => {
    const missing = evaluationFixture();
    const missingSourceId = missing.measurementRecord.caseExecutions[0]!.captureBindings[0]!.sourceId;
    expectEvaluationError({
      ...missing,
      sources: missing.sources.filter(({ id }) => id !== missingSourceId)
    }, "EVIDENCE_MISSING");

    const reused = evaluationFixture();
    const firstSourceId = reused.measurementRecord.caseExecutions[0]!.captureBindings[0]!.sourceId;
    const reusedMutable = reused as unknown as MutableJson;
    const executions = mutableArray(
      mutableObject(reusedMutable.measurementRecord, "measurement record").caseExecutions,
      "case executions"
    );
    mutableObject(
      mutableArray(mutableObject(executions[1], "case execution").captureBindings, "capture bindings")[0],
      "capture binding"
    ).sourceId = firstSourceId;
    expectEvaluationError(reused, "EVIDENCE_MISSING");

    const wrongRole = evaluationFixture();
    const wrongRoleSourceId = wrongRole.measurementRecord.caseExecutions[0]!.captureBindings[0]!.sourceId;
    const detachedSources = wrongRole.sources.map((source) =>
      source.id === wrongRoleSourceId
        ? { ...source, role: "supporting_attachment" as const }
        : source
    );
    expectEvaluationError({ ...wrongRole, sources: detachedSources }, "EVIDENCE_MISSING");

    const wrongCapability = evaluationFixture();
    const capabilityMutable = wrongCapability as unknown as MutableJson;
    const acceptanceCase = mutableObject(
      mutableArray(
        mutableObject(capabilityMutable.acceptanceContract, "acceptance contract").cases,
        "acceptance cases"
      )[0],
      "acceptance case"
    );
    const planCase = mutableObject(
      mutableArray(mutableObject(capabilityMutable.plan, "bring-up plan").cases, "plan cases")[0],
      "plan case"
    );
    mutableObject(
      mutableArray(acceptanceCase.captureRequirements, "capture requirements")[0],
      "capture requirement"
    ).instrumentCapability = "programmer";
    mutableObject(
      mutableArray(planCase.captureRequirements, "capture requirements")[0],
      "capture requirement"
    ).instrumentCapability = "programmer";
    expectEvaluationError(wrongCapability, "GATE_FAILED");
  });

  it("rejects reordered procedure cases even when their execution windows remain nonoverlapping", () => {
    const input = evaluationFixture();
    const mutable = input as unknown as MutableJson;
    const executionValues = mutableArray(
      mutableObject(mutable.measurementRecord, "measurement record").caseExecutions,
      "case executions"
    );
    const executions = executionValues.map((entry) => mutableObject(entry, "case execution"));
    const first = structuredClone(executions[0]!);
    const second = structuredClone(executions[1]!);
    const firstWindow = {
      startedAt: String(first.startedAt),
      completedAt: String(first.completedAt)
    };
    const secondWindow = {
      startedAt: String(second.startedAt),
      completedAt: String(second.completedAt)
    };
    const retime = (
      execution: MutableJson,
      window: { readonly startedAt: string; readonly completedAt: string }
    ): void => {
      execution.startedAt = window.startedAt;
      execution.completedAt = window.completedAt;
      const observedAt = new Date(
        (Date.parse(window.startedAt) + Date.parse(window.completedAt)) / 2
      ).toISOString();
      for (const observation of mutableArray(execution.observations, "observations")) {
        mutableObject(observation, "observation").observedAt = observedAt;
      }
      const captureSourceIds = new Set(
        mutableArray(execution.captureBindings, "capture bindings").map((binding) =>
          String(mutableObject(binding, "capture binding").sourceId)
        )
      );
      for (const source of mutableArray(mutable.sources, "sources")) {
        const record = mutableObject(source, "source");
        if (captureSourceIds.has(String(record.id))) record.capturedAt = observedAt;
      }
    };
    executionValues[0] = second;
    executionValues[1] = first;
    retime(second, firstWindow);
    retime(first, secondWindow);
    expect(Date.parse(String(second.completedAt))).toBeLessThanOrEqual(
      Date.parse(String(first.startedAt))
    );
    expectEvaluationError(input, "DIGEST_MISMATCH");
  });
});

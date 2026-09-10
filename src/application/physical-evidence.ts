import { canonicalJson } from "../core/canonical.js";
import {
  PHYSICAL_EVIDENCE_POLICY,
  PHYSICAL_MEASUREMENT_UNITS,
  PHYSICAL_OBSERVATION_CATEGORIES,
  type PhysicalAcceptanceContract,
  type PhysicalAcceptanceTest,
  type PhysicalActualCondition,
  type PhysicalArtifactBindings,
  type PhysicalAsBuiltRecord,
  type PhysicalBringupPlan,
  type PhysicalCategoryVerdicts,
  type PhysicalFirmwareFlashRecord,
  type PhysicalInstrumentCalibrationRecord,
  type PhysicalMeasurementRecord,
  type PhysicalObservationCategory,
  type PhysicalRequiredCondition,
  type PhysicalSourceBlobMetadata
} from "../contracts/operations.js";
import { DomainError } from "../domain/errors.js";
import type { CanonicalIdentity, ContentIdentity, DesignRevision } from "../domain/types.js";

export interface PhysicalTargetBuildBinding {
  readonly projectId: string;
  readonly runId: string;
  /** Parent/head input revision captured by the firmware-stage execution fence. */
  readonly designRevisionId: string;
  readonly reportArtifact: PhysicalArtifactBindings["targetBuildReport"];
  readonly binaryArtifact: PhysicalArtifactBindings["targetBinary"];
  readonly binaryIdentity: ContentIdentity;
  readonly targetSourceRevisionDigest: string;
  readonly targetBuildSourceIdentity: CanonicalIdentity;
  readonly targetConfigurationIdentity: CanonicalIdentity;
  readonly targetToolchainIdentity: CanonicalIdentity;
  readonly targetCompiledSources: readonly {
    readonly logicalName: string;
    readonly identity: ContentIdentity;
  }[];
}

export interface PhysicalInstrumentBinding {
  readonly id: string;
  readonly calibrationSourceId: string;
  readonly calibration: PhysicalInstrumentCalibrationRecord;
}

export interface DerivedPhysicalResultsV3 {
  readonly cases: readonly {
    readonly caseId: string;
    readonly verdict: "pass" | "fail";
  }[];
  readonly observations: readonly {
    readonly testId: string;
    readonly category: PhysicalObservationCategory;
    readonly verdict: "pass" | "fail";
  }[];
  readonly categories: PhysicalCategoryVerdicts;
  readonly overallVerdict: "pass" | "fail";
}

export interface PhysicalEvidenceEvaluationInput {
  readonly revision: DesignRevision;
  readonly bindings: PhysicalArtifactBindings;
  readonly targetBuild: PhysicalTargetBuildBinding;
  readonly plan: PhysicalBringupPlan;
  readonly acceptanceContract: PhysicalAcceptanceContract;
  readonly sources: readonly PhysicalSourceBlobMetadata[];
  readonly primarySourceIds: {
    readonly asBuiltRecord: string;
    readonly flashedFirmwareBinary: string;
    readonly firmwareFlashRecord: string;
    readonly measurementRecord: string;
  };
  readonly asBuiltRecord: PhysicalAsBuiltRecord;
  readonly firmwareFlashRecord: PhysicalFirmwareFlashRecord;
  readonly measurementRecord: PhysicalMeasurementRecord;
  readonly instruments: readonly PhysicalInstrumentBinding[];
  readonly now: Date;
}

export interface PhysicalEvidenceEvaluation {
  readonly results: DerivedPhysicalResultsV3;
  readonly validUntil: string;
}

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const sameContentIdentity = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === right.algorithm && left.digest === right.digest && left.size === right.size;

const folded = (value: string): string => value.toLocaleLowerCase("en-US");

const exactIdSet = (actual: readonly string[], expected: readonly string[], label: string): void => {
  const actualFolded = actual.map(folded).sort();
  const expectedFolded = expected.map(folded).sort();
  if (!sameJson(actualFolded, expectedFolded)) {
    throw new DomainError("EVIDENCE_MISSING", `${label} does not exactly cover the required identifiers`, {
      actual: actualFolded,
      expected: expectedFolded
    });
  }
};

const conditionPasses = (
  required: PhysicalRequiredCondition,
  actual: PhysicalActualCondition | undefined
): boolean => {
  if (actual === undefined) return false;
  if (required.kind === "exact") {
    return actual.kind === "exact" && Object.is(actual.observed, required.expected);
  }
  return actual.kind === "numeric" &&
    actual.unit === required.unit &&
    actual.value >= required.minimum &&
    actual.value <= required.maximum;
};

const observationPasses = (
  test: PhysicalAcceptanceTest,
  observation: PhysicalMeasurementRecord["caseExecutions"][number]["observations"][number]
): boolean => {
  if (test.kind === "numeric_range") {
    return observation.kind === "numeric_range" &&
      observation.unit === test.unit &&
      observation.value >= test.minimum &&
      observation.value <= test.maximum;
  }
  return observation.kind === "expected_value" && Object.is(observation.observed, test.expected);
};

const assertTargetProvenance = (
  actual: Pick<
    PhysicalMeasurementRecord,
    | "projectId"
    | "runId"
    | "designRevisionId"
    | "targetBuildReportArtifact"
    | "targetBinaryArtifact"
    | "targetSourceRevisionDigest"
    | "targetBuildSourceIdentity"
    | "targetConfigurationIdentity"
    | "targetToolchainIdentity"
    | "targetCompiledSources"
  >,
  expected: PhysicalTargetBuildBinding,
  label: string
): void => {
  if (
    actual.projectId !== expected.projectId ||
    actual.runId !== expected.runId ||
    actual.designRevisionId !== expected.designRevisionId ||
    !sameJson(actual.targetBuildReportArtifact, expected.reportArtifact) ||
    !sameJson(actual.targetBinaryArtifact, expected.binaryArtifact) ||
    actual.targetSourceRevisionDigest !== expected.targetSourceRevisionDigest ||
    !sameJson(actual.targetBuildSourceIdentity, expected.targetBuildSourceIdentity) ||
    !sameJson(actual.targetConfigurationIdentity, expected.targetConfigurationIdentity) ||
    !sameJson(actual.targetToolchainIdentity, expected.targetToolchainIdentity) ||
    !sameJson(actual.targetCompiledSources, expected.targetCompiledSources)
  ) {
    throw new DomainError("DIGEST_MISMATCH", `${label} does not reproduce the current target-build provenance`);
  }
};

const instrumentCapability = (
  instrument: PhysicalInstrumentBinding | undefined,
  capability: PhysicalAcceptanceTest["instrumentCapability"],
  observedAt: number,
  requiredUnit?: (typeof PHYSICAL_MEASUREMENT_UNITS)[number]
): boolean => {
  if (instrument === undefined) return false;
  const calibratedAt = Date.parse(instrument.calibration.calibratedAt);
  const validUntil = Date.parse(instrument.calibration.validUntil);
  const available = instrument.calibration.capabilities.find((entry) => entry.capability === capability);
  return available !== undefined &&
    calibratedAt <= observedAt &&
    observedAt - calibratedAt <= PHYSICAL_EVIDENCE_POLICY.maximumCalibrationAgeMs &&
    validUntil > observedAt &&
    (requiredUnit === undefined || available.units.includes(requiredUnit));
};

const procedureCaseProjection = (entry: PhysicalBringupPlan["cases"][number]) => ({
  caseId: entry.caseId,
  procedureStepId: entry.procedureStepId,
  endpointId: entry.endpointId,
  requiredConditions: entry.requiredConditions,
  minimumDurationMs: entry.minimumDurationMs,
  captureRequirements: entry.captureRequirements
});

export const evaluatePhysicalEvidence = (
  input: PhysicalEvidenceEvaluationInput
): PhysicalEvidenceEvaluation => {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const instrumentById = new Map(input.instruments.map((instrument) => [instrument.id, instrument]));
  const primaryRoles = [
    [input.primarySourceIds.asBuiltRecord, "as_built_record"],
    [input.primarySourceIds.flashedFirmwareBinary, "flashed_firmware_binary"],
    [input.primarySourceIds.firmwareFlashRecord, "firmware_flash_record"],
    [input.primarySourceIds.measurementRecord, "parsed_measurement_record"]
  ] as const;
  for (const [sourceId, role] of primaryRoles) {
    if (sourceById.get(sourceId)?.role !== role) {
      throw new DomainError("EVIDENCE_MISSING", `Physical record is missing its ${role} source`, { sourceId });
    }
  }

  if (
    input.plan.schemaVersion !== "evleda.bringup-plan.v2" ||
    input.acceptanceContract.schemaVersion !== "evleda.physical-acceptance.v2" ||
    input.acceptanceContract.procedureSchemaVersion !== input.plan.schemaVersion ||
    input.acceptanceContract.procedureId !== input.plan.procedureId ||
    input.acceptanceContract.profileId !== input.plan.profileId ||
    input.acceptanceContract.boardRevision !== input.plan.boardRevision
  ) {
    throw new DomainError("DIGEST_MISMATCH", "Bring-up plan and acceptance contract disagree");
  }
  exactIdSet(
    input.plan.cases.map((entry) => entry.caseId),
    input.acceptanceContract.cases.map((entry) => entry.caseId),
    "Bring-up plan case set"
  );
  const planCaseById = new Map(input.plan.cases.map((entry) => [entry.caseId, entry]));
  for (const acceptanceCase of input.acceptanceContract.cases) {
    const planCase = planCaseById.get(acceptanceCase.caseId);
    if (planCase === undefined || !sameJson(procedureCaseProjection(planCase), acceptanceCase)) {
      throw new DomainError("DIGEST_MISMATCH", "Acceptance case does not reproduce its procedure case", {
        caseId: acceptanceCase.caseId
      });
    }
  }

  if (
    input.asBuiltRecord.boardSerial !== input.firmwareFlashRecord.boardSerial ||
    input.asBuiltRecord.boardSerial !== input.measurementRecord.boardSerial ||
    input.asBuiltRecord.revisionManifestDigest !== input.revision.manifest.digest ||
    !sameJson(input.asBuiltRecord.bomArtifact, input.bindings.bom) ||
    !sameJson(input.asBuiltRecord.camManifestArtifact, input.bindings.cam.manifest) ||
    !sameJson(input.measurementRecord.bringupProcedureArtifact, input.bindings.bringupProcedure) ||
    !sameJson(input.measurementRecord.acceptanceArtifact, input.bindings.acceptance)
  ) {
    throw new DomainError("DIGEST_MISMATCH", "As-built, procedure, measurement, and current artifact bindings disagree");
  }
  assertTargetProvenance(input.firmwareFlashRecord, input.targetBuild, "Firmware flash record");
  assertTargetProvenance(input.measurementRecord, input.targetBuild, "Physical measurement record");
  const flashedSource = sourceById.get(input.primarySourceIds.flashedFirmwareBinary);
  if (
    flashedSource === undefined ||
    input.firmwareFlashRecord.firmwareBinarySourceId !== input.primarySourceIds.flashedFirmwareBinary ||
    input.measurementRecord.firmwareBinarySourceId !== input.primarySourceIds.flashedFirmwareBinary ||
    !sameContentIdentity(input.firmwareFlashRecord.firmwareBinaryIdentity, input.targetBuild.binaryIdentity) ||
    !sameContentIdentity(input.measurementRecord.firmwareBinaryIdentity, input.targetBuild.binaryIdentity) ||
    !sameContentIdentity(flashedSource.identity, input.targetBuild.binaryIdentity)
  ) {
    throw new DomainError("DIGEST_MISMATCH", "Flashed firmware does not equal the committed target-build BIN");
  }

  const startedAt = Date.parse(input.measurementRecord.startedAt);
  const completedAt = Date.parse(input.measurementRecord.completedAt);
  const now = input.now.getTime();
  if (completedAt > now) {
    throw new DomainError("INVALID_ARGUMENT", "Physical measurement session completes in the future");
  }
  if (completedAt - startedAt > PHYSICAL_EVIDENCE_POLICY.maximumSessionDurationMs) {
    throw new DomainError("GATE_FAILED", "Physical measurement session exceeds the policy duration limit");
  }
  if (now - completedAt > PHYSICAL_EVIDENCE_POLICY.maximumSubmissionAgeMs) {
    throw new DomainError("EVIDENCE_STALE", "Physical measurement session is older than the submission window");
  }
  const asBuiltAt = Date.parse(input.asBuiltRecord.completedAt);
  if (asBuiltAt > startedAt || startedAt - asBuiltAt > PHYSICAL_EVIDENCE_POLICY.maximumAsBuiltAgeMs) {
    throw new DomainError("EVIDENCE_STALE", "As-built record is not current for the measurement session");
  }
  const flashedAt = Date.parse(input.firmwareFlashRecord.flashedAt);
  if (flashedAt < startedAt || flashedAt > completedAt) {
    throw new DomainError("EVIDENCE_STALE", "Firmware flash timestamp is outside the measurement session");
  }

  const programmer = instrumentById.get(input.firmwareFlashRecord.programmerInstrumentId);
  if (!instrumentCapability(programmer, "programmer", flashedAt)) {
    throw new DomainError("GATE_FAILED", "Firmware flash record does not cite a calibrated programmer");
  }

  exactIdSet(
    input.measurementRecord.caseExecutions.map((entry) => entry.caseId),
    input.acceptanceContract.cases.map((entry) => entry.caseId),
    "Measurement case execution set"
  );
  const expectedCaseOrder = input.plan.cases.map((entry) => entry.caseId);
  const actualCaseOrder = input.measurementRecord.caseExecutions.map((entry) => entry.caseId);
  if (!sameJson(actualCaseOrder, expectedCaseOrder)) {
    throw new DomainError("DIGEST_MISMATCH", "Measurement cases do not follow the exact procedure order", {
      actual: actualCaseOrder,
      expected: expectedCaseOrder
    });
  }
  const caseById = new Map(input.acceptanceContract.cases.map((entry) => [entry.caseId, entry]));
  const testsByCase = new Map<string, PhysicalAcceptanceTest[]>();
  for (const test of input.acceptanceContract.tests) {
    const entries = testsByCase.get(test.caseId) ?? [];
    entries.push(test);
    testsByCase.set(test.caseId, entries);
  }

  const operatorIds = new Set(input.measurementRecord.operators.map((operator) => operator.id));
  const referencedSources = new Set<string>([
    input.primarySourceIds.asBuiltRecord,
    input.primarySourceIds.flashedFirmwareBinary,
    input.primarySourceIds.firmwareFlashRecord,
    input.primarySourceIds.measurementRecord,
    ...input.instruments.map((instrument) => instrument.calibrationSourceId)
  ]);
  const usedCaptureSources = new Set<string>();
  const observationResults: Array<DerivedPhysicalResultsV3["observations"][number]> = [];
  const caseResults: Array<DerivedPhysicalResultsV3["cases"][number]> = [];

  let earliestExpiry = completedAt + PHYSICAL_EVIDENCE_POLICY.maximumEvidenceAgeMs;
  for (const instrument of input.instruments) {
    if (
      instrument.calibration.instrumentId !== instrument.id ||
      sourceById.get(instrument.calibrationSourceId)?.role !== "instrument_calibration"
    ) {
      throw new DomainError("DIGEST_MISMATCH", "Instrument calibration source does not bind its instrument", {
        instrumentId: instrument.id
      });
    }
    earliestExpiry = Math.min(earliestExpiry, Date.parse(instrument.calibration.validUntil));
    earliestExpiry = Math.min(
      earliestExpiry,
      Date.parse(instrument.calibration.calibratedAt) + PHYSICAL_EVIDENCE_POLICY.maximumCalibrationAgeMs
    );
  }

  let previousExecutionEnd = startedAt;
  for (const execution of input.measurementRecord.caseExecutions) {
    const contractCase = caseById.get(execution.caseId);
    if (contractCase === undefined) {
      throw new DomainError("EVIDENCE_MISSING", "Measurement references an unknown procedure case", {
        caseId: execution.caseId
      });
    }
    if (
      execution.procedureStepId !== contractCase.procedureStepId ||
      execution.endpointId !== contractCase.endpointId ||
      !operatorIds.has(execution.operatorId)
    ) {
      throw new DomainError("DIGEST_MISMATCH", "Measurement case does not bind its step, endpoint, and operator", {
        caseId: execution.caseId
      });
    }
    exactIdSet(
      execution.actualConditions.map((entry) => entry.conditionId),
      contractCase.requiredConditions.map((entry) => entry.conditionId),
      `Conditions for ${execution.caseId}`
    );
    exactIdSet(
      execution.captureBindings.map((entry) => entry.captureRequirementId),
      contractCase.captureRequirements.map((entry) => entry.captureRequirementId),
      `Captures for ${execution.caseId}`
    );
    const requiredTests = testsByCase.get(execution.caseId) ?? [];
    exactIdSet(
      execution.observations.map((entry) => entry.testId),
      requiredTests.map((entry) => entry.id),
      `Observations for ${execution.caseId}`
    );

    const executionStart = Date.parse(execution.startedAt);
    const executionEnd = Date.parse(execution.completedAt);
    let casePass = executionStart >= startedAt &&
      executionStart >= previousExecutionEnd &&
      executionEnd <= completedAt &&
      executionEnd - executionStart >= contractCase.minimumDurationMs;
    previousExecutionEnd = Math.max(previousExecutionEnd, executionEnd);
    const actualConditionById = new Map(
      execution.actualConditions.map((entry) => [entry.conditionId, entry])
    );
    casePass = casePass && contractCase.requiredConditions.every((condition) =>
      conditionPasses(condition, actualConditionById.get(condition.conditionId))
    );

    const captureById = new Map(
      execution.captureBindings.map((entry) => [entry.captureRequirementId, entry])
    );
    for (const requirement of contractCase.captureRequirements) {
      const binding = captureById.get(requirement.captureRequirementId);
      const source = binding === undefined ? undefined : sourceById.get(binding.sourceId);
      const instrument = binding === undefined ? undefined : instrumentById.get(binding.instrumentId);
      if (
        binding === undefined ||
        source === undefined ||
        source.role !== "required_capture" ||
        !requirement.allowedMediaTypes.includes(source.mediaType) ||
        usedCaptureSources.has(source.id)
      ) {
        throw new DomainError("EVIDENCE_MISSING", "Required physical capture is missing, reused, or has the wrong role/media type", {
          caseId: execution.caseId,
          captureRequirementId: requirement.captureRequirementId
        });
      }
      const capturedAt = Date.parse(source.capturedAt);
      if (capturedAt < executionStart || capturedAt > executionEnd || capturedAt > now) {
        throw new DomainError("EVIDENCE_STALE", "Required physical capture is outside its case execution window", {
          sourceId: source.id
        });
      }
      if (!instrumentCapability(instrument, requirement.instrumentCapability, capturedAt)) {
        throw new DomainError("GATE_FAILED", "Required physical capture lacks a valid calibrated instrument capability", {
          caseId: execution.caseId,
          captureRequirementId: requirement.captureRequirementId
        });
      }
      if (requirement.minimumSamples !== undefined && binding.sampleCount < requirement.minimumSamples) {
        casePass = false;
      }
      usedCaptureSources.add(source.id);
      referencedSources.add(source.id);
    }

    const observationById = new Map(execution.observations.map((entry) => [entry.testId, entry]));
    for (const test of requiredTests) {
      const observation = observationById.get(test.id)!;
      const capture = captureById.get(observation.captureRequirementId);
      const captureRequirement = contractCase.captureRequirements.find(
        (requirement) => requirement.captureRequirementId === observation.captureRequirementId
      );
      const instrument = instrumentById.get(observation.instrumentId);
      const observedAt = Date.parse(observation.observedAt);
      const validTrace = capture !== undefined &&
        captureRequirement !== undefined &&
        captureRequirement.instrumentCapability === test.instrumentCapability &&
        capture.instrumentId === observation.instrumentId &&
        observedAt >= executionStart &&
        observedAt <= executionEnd &&
        instrumentCapability(
          instrument,
          test.instrumentCapability,
          observedAt,
          test.kind === "numeric_range" ? test.unit : undefined
        );
      if (!validTrace) {
        throw new DomainError("GATE_FAILED", "Observation lacks the required calibrated capture binding", {
          caseId: execution.caseId,
          testId: test.id
        });
      }
      const verdict = observationPasses(test, observation) ? "pass" as const : "fail" as const;
      observationResults.push({ testId: test.id, category: test.category, verdict });
      if (verdict === "fail") casePass = false;
    }
    caseResults.push({ caseId: execution.caseId, verdict: casePass ? "pass" : "fail" });
  }

  const requiredCaptureSourceIds = input.sources
    .filter((source) => source.role === "required_capture")
    .map((source) => source.id);
  exactIdSet([...usedCaptureSources], requiredCaptureSourceIds, "Required capture source use");

  for (const source of input.sources) {
    const capturedAt = Date.parse(source.capturedAt);
    if (capturedAt > now) {
      throw new DomainError("INVALID_ARGUMENT", "Physical source is future-dated", { sourceId: source.id });
    }
    if (source.role !== "supporting_attachment" && !referencedSources.has(source.id)) {
      throw new DomainError("INVALID_ARGUMENT", "Physical source is not referenced", { sourceId: source.id });
    }
    const calibrationInstrument = input.instruments.find(
      (instrument) => instrument.calibrationSourceId === source.id
    );
    const inWindow = source.role === "required_capture" || source.role === "supporting_attachment"
      ? capturedAt >= startedAt && capturedAt <= completedAt
      : source.role === "parsed_measurement_record"
        ? capturedAt >= completedAt && capturedAt <= now
        : source.role === "as_built_record"
          ? capturedAt >= asBuiltAt && capturedAt <= startedAt
          : source.role === "flashed_firmware_binary" || source.role === "firmware_flash_record"
            ? capturedAt >= flashedAt && capturedAt <= completedAt
            : source.role === "instrument_calibration" &&
              calibrationInstrument !== undefined &&
              capturedAt >= Date.parse(calibrationInstrument.calibration.calibratedAt) &&
              capturedAt <= startedAt;
    if (!inWindow) {
      throw new DomainError("EVIDENCE_STALE", "Physical source capture time is outside its policy window", {
        sourceId: source.id,
        role: source.role
      });
    }
  }
  if (earliestExpiry <= now) {
    throw new DomainError("EVIDENCE_STALE", "Physical evidence or calibration is already expired");
  }

  const caseResultById = new Map(caseResults.map((entry) => [entry.caseId, entry.verdict]));
  const observationResultById = new Map(
    observationResults.map((entry) => [entry.testId, entry.verdict])
  );
  const categories = Object.fromEntries(
    PHYSICAL_OBSERVATION_CATEGORIES.map((category) => {
      const tests = input.acceptanceContract.tests.filter((entry) => entry.category === category);
      return [
        category,
        tests.length > 0 && tests.every(
          (test) =>
            observationResultById.get(test.id) === "pass" &&
            caseResultById.get(test.caseId) === "pass"
        )
          ? "pass"
          : "fail"
      ];
    })
  ) as unknown as PhysicalCategoryVerdicts;
  const overallVerdict = PHYSICAL_OBSERVATION_CATEGORIES.every(
    (category) => categories[category] === "pass"
  )
    ? "pass" as const
    : "fail" as const;
  return {
    results: {
      cases: caseResults.sort((left, right) => left.caseId.localeCompare(right.caseId, "en")),
      observations: observationResults.sort((left, right) => left.testId.localeCompare(right.testId, "en")),
      categories,
      overallVerdict
    },
    validUntil: new Date(earliestExpiry).toISOString()
  };
};

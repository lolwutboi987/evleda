import { z } from "zod";
import { STAGE_ORDER } from "../domain/stages.js";

export const OPERATION_NAMES = [
  "create_project",
  "start_design_run",
  "get_run_status",
  "inspect_requirements",
  "approve_requirements",
  "resume_run",
  "list_artifacts",
  "inspect_evidence",
  "inspect_engineering_practices",
  "rerun_stage",
  "export_candidate_bundle",
  "export_prototype_bundle",
  "generate_bringup_plan",
  "generate_firmware_scaffold"
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

const identifier = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u, "Invalid identifier");

export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u, "Expected a SHA-256 digest");
export const stageSchema = z.enum(STAGE_ORDER);
export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "Use 16-128 visible ASCII characters");
export const expectedRevisionSchema = z.number().int().nonnegative();

export const humanActorSchema = z
  .object({
    type: z.literal("human"),
    id: identifier,
    displayName: z.string().trim().min(1).max(160),
    role: z.enum(["requirements_reviewer", "hardware_qualifier", "release_authority"])
  })
  .strict();

const existingResourceMutationMetadata = {
  idempotencyKey: idempotencyKeySchema,
  expectedRevision: expectedRevisionSchema
} as const;

export const createProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(4_000).optional(),
    workspace: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u, "Expected one relative project directory name")
      .refine((value) => value !== "." && value !== "..", "Directory traversal is not allowed")
      .refine(
        (value) =>
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(value) &&
          !value.endsWith("."),
        "Reserved project directory name"
      )
      .optional(),
    policyVersion: z.string().trim().min(1).max(120).optional(),
    idempotencyKey: idempotencyKeySchema
  })
  .strict();

export const startDesignRunInputSchema = z
  .object({
    projectId: identifier,
    prompt: z.string().min(1).max(200_000),
    configuration: z.record(z.string(), z.json()).default({}),
    ...existingResourceMutationMetadata
  })
  .strict();

export const getRunStatusInputSchema = z.object({ runId: identifier }).strict();

export const inspectRequirementsInputSchema = z.object({ runId: identifier }).strict();

export const approveRequirementsInputSchema = z
  .object({
    runId: identifier,
    requirementsDigest: digestSchema,
    actor: humanActorSchema.refine((actor) => actor.role === "requirements_reviewer", {
      message: "Requirements actor must have the requirements_reviewer role"
    }),
    rationale: z.string().trim().min(1).max(4_000),
    scope: z.string().trim().min(1).max(500).default("exact requirements document"),
    ...existingResourceMutationMetadata
  })
  .strict();

export const resumeRunInputSchema = z
  .object({
    runId: identifier,
    ...existingResourceMutationMetadata
  })
  .strict();

export const listArtifactsInputSchema = z
  .object({
    runId: identifier,
    revisionId: identifier.optional(),
    stage: stageSchema.optional(),
    includeStale: z.boolean().default(false)
  })
  .strict();

export const inspectEvidenceInputSchema = z
  .object({
    runId: identifier,
    revisionId: identifier.optional(),
    evidenceId: identifier.optional(),
    stage: stageSchema.optional(),
    includeStale: z.boolean().default(false)
  })
  .strict();

export const inspectEngineeringPracticesInputSchema = z
  .object({
    runId: identifier,
    revisionId: identifier.optional(),
    findingCursor: z.string().min(1).max(2_048).optional(),
    findingLimit: z.number().int().min(1).max(100).default(50)
  })
  .strict();

export const rerunStageInputSchema = z
  .object({
    runId: identifier,
    stage: stageSchema,
    reason: z.string().trim().min(1).max(4_000),
    ...existingResourceMutationMetadata
  })
  .strict();

export const exportCandidateBundleInputSchema = z
  .object({
    revisionId: identifier,
    ...existingResourceMutationMetadata
  })
  .strict();

export const exportPrototypeBundleInputSchema = z
  .object({
    revisionId: identifier,
    ...existingResourceMutationMetadata
  })
  .strict();

export const qualifyRevisionInputSchema = z
  .object({
    revisionId: identifier,
    requirementsDigest: digestSchema,
    evidenceRootDigest: digestSchema,
    actor: humanActorSchema.refine((actor) => actor.role === "hardware_qualifier", {
      message: "Qualification actor must have the hardware_qualifier role"
    }),
    scope: z.string().trim().min(1).max(500).default("controlled prototype build"),
    rationale: z.string().trim().min(1).max(4_000),
    ...existingResourceMutationMetadata
  })
  .strict();

export type QualifyRevisionInput = z.input<typeof qualifyRevisionInputSchema>;

const externalContentIdentitySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: digestSchema,
    size: z.number().int().positive()
  })
  .strict();

const externalCanonicalIdentitySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: digestSchema,
    schemaVersion: z.string().trim().min(1).max(160),
    canonicalizationVersion: z.literal("evleda-c14n-json-v1")
  })
  .strict();

export const PHYSICAL_OBSERVATION_CATEGORIES = [
  "rails",
  "programming",
  "communications",
  "sensors",
  "actuators",
  "thermal",
  "fault_reset"
] as const;

export const PHYSICAL_MEASUREMENT_UNITS = [
  "V", "mV", "A", "mA", "uA", "ohm", "kohm", "Mohm", "Hz", "kHz",
  "MHz", "degC", "percent", "s", "ms", "us", "ns", "rpm", "count",
  "dB", "bps", "kbps", "Mbps"
] as const;

export const PHYSICAL_INSTRUMENT_CAPABILITIES = [
  "dc_voltage",
  "dc_current",
  "resistance",
  "programmer",
  "protocol_analyzer",
  "logic_analyzer",
  "current_probe",
  "temperature",
  "oscilloscope",
  "camera"
] as const;

export const PHYSICAL_CAPTURE_KINDS = [
  "visual_inspection",
  "scalar_measurement",
  "waveform",
  "time_series",
  "protocol_trace",
  "programmer_log",
  "event_log"
] as const;

export const PHYSICAL_SOURCE_MEDIA_TYPES = [
  "application/json",
  "application/octet-stream",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "application/pdf"
] as const;

export const PHYSICAL_EVIDENCE_POLICY = {
  schemaVersion: "evleda.physical-evidence-policy.v1",
  maximumSessionDurationMs: 24 * 60 * 60 * 1000,
  maximumSubmissionAgeMs: 7 * 24 * 60 * 60 * 1000,
  maximumEvidenceAgeMs: 30 * 24 * 60 * 60 * 1000,
  maximumAsBuiltAgeMs: 90 * 24 * 60 * 60 * 1000,
  maximumCalibrationAgeMs: 366 * 24 * 60 * 60 * 1000
} as const;

export const EXTERNAL_EVIDENCE_BLOB_MAX_BYTES = 4 * 1024 * 1024;
export const EXTERNAL_EVIDENCE_TOTAL_BLOB_MAX_BYTES = 32 * 1024 * 1024;
export const EXTERNAL_EVIDENCE_REQUEST_MAX_BYTES = 48 * 1024 * 1024;

const physicalTimestampSchema = z.iso.datetime({ offset: true });
const physicalIdentifierSchema = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u, "Invalid physical evidence identifier");
const expectedScalarSchema = z.union([z.boolean(), z.string().trim().min(1).max(500)]);
const canonicalBase64Schema = z
  .string()
  .min(4)
  .max(Math.ceil(EXTERNAL_EVIDENCE_BLOB_MAX_BYTES / 3) * 4)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
    "Expected canonical padded base64"
  );

export const physicalArtifactBindingSchema = z
  .object({ artifactId: identifier, identity: externalContentIdentitySchema })
  .strict();

const physicalCamBindingsSchema = z
  .object({
    manifest: physicalArtifactBindingSchema,
    artifacts: z.array(physicalArtifactBindingSchema).min(3).max(128)
  })
  .strict();

export const physicalArtifactBindingsV1Schema = z
  .object({
    bom: physicalArtifactBindingSchema,
    cam: physicalCamBindingsSchema,
    firmwareBuild: physicalArtifactBindingSchema,
    bringupProcedure: physicalArtifactBindingSchema,
    acceptance: physicalArtifactBindingSchema
  })
  .strict();

export const physicalArtifactBindingsSchema = z
  .object({
    bom: physicalArtifactBindingSchema,
    cam: physicalCamBindingsSchema,
    targetBuildReport: physicalArtifactBindingSchema,
    targetBinary: physicalArtifactBindingSchema,
    bringupProcedure: physicalArtifactBindingSchema,
    acceptance: physicalArtifactBindingSchema
  })
  .strict();

const physicalEnvironmentSchema = z
  .object({
    location: z.string().trim().min(1).max(240),
    fixtureId: physicalIdentifierSchema,
    supply: z.string().trim().min(1).max(240),
    ambientTemperatureC: z.number().finite().min(-80).max(200),
    relativeHumidityPercent: z.number().finite().min(0).max(100),
    notes: z.string().trim().min(1).max(2_000).optional()
  })
  .strict();

const substitutionSchema = z
  .object({
    referenceDesignators: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
    specifiedPart: z.string().trim().min(1).max(240),
    installedPart: z.string().trim().min(1).max(240),
    rationale: z.string().trim().min(1).max(1_000)
  })
  .strict();

const physicalOperatorBase = {
  type: z.literal("human"),
  id: physicalIdentifierSchema,
  displayName: z.string().trim().min(1).max(160)
} as const;

export const physicalAssemblyOperatorSchema = z
  .object({
    ...physicalOperatorBase,
    role: z.literal("assembly_operator")
  })
  .strict();

export const physicalMeasurementOperatorSchema = z
  .object({
    ...physicalOperatorBase,
    role: z.literal("measurement_operator")
  })
  .strict();

export const physicalOperatorSchema = z.discriminatedUnion("role", [
  physicalAssemblyOperatorSchema,
  physicalMeasurementOperatorSchema
]);

const exactRequiredConditionSchema = z
  .object({
    conditionId: physicalIdentifierSchema,
    kind: z.literal("exact"),
    expected: expectedScalarSchema
  })
  .strict();
const numericRequiredConditionSchema = z
  .object({
    conditionId: physicalIdentifierSchema,
    kind: z.literal("numeric_range"),
    unit: z.enum(PHYSICAL_MEASUREMENT_UNITS),
    minimum: z.number().finite(),
    maximum: z.number().finite()
  })
  .strict()
  .refine((condition) => condition.minimum <= condition.maximum, {
    message: "Required-condition minimum exceeds maximum",
    path: ["minimum"]
  });
export const physicalRequiredConditionSchema = z.discriminatedUnion("kind", [
  exactRequiredConditionSchema,
  numericRequiredConditionSchema
]);

const exactActualConditionSchema = z
  .object({
    conditionId: physicalIdentifierSchema,
    kind: z.literal("exact"),
    observed: expectedScalarSchema
  })
  .strict();
const numericActualConditionSchema = z
  .object({
    conditionId: physicalIdentifierSchema,
    kind: z.literal("numeric"),
    unit: z.enum(PHYSICAL_MEASUREMENT_UNITS),
    value: z.number().finite()
  })
  .strict();
export const physicalActualConditionSchema = z.discriminatedUnion("kind", [
  exactActualConditionSchema,
  numericActualConditionSchema
]);

export const physicalCaptureRequirementSchema = z
  .object({
    captureRequirementId: physicalIdentifierSchema,
    kind: z.enum(PHYSICAL_CAPTURE_KINDS),
    description: z.string().trim().min(1).max(500),
    allowedMediaTypes: z.array(z.enum(PHYSICAL_SOURCE_MEDIA_TYPES)).min(1).max(PHYSICAL_SOURCE_MEDIA_TYPES.length),
    instrumentCapability: z.enum(PHYSICAL_INSTRUMENT_CAPABILITIES),
    minimumSamples: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((requirement, context) => {
    if (new Set(requirement.allowedMediaTypes).size !== requirement.allowedMediaTypes.length) {
      context.addIssue({ code: "custom", path: ["allowedMediaTypes"], message: "Duplicate allowed capture media type" });
    }
  });

const bringupStepSchema = z
  .object({
    id: physicalIdentifierSchema,
    phase: z.number().int().positive(),
    title: z.string().trim().min(1).max(240),
    preconditions: z.array(z.string().trim().min(1).max(500)).min(1).max(64),
    procedure: z.array(z.string().trim().min(1).max(1_000)).min(1).max(64),
    acceptance: z.array(z.string().trim().min(1).max(1_000)).min(1).max(64),
    stopConditions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(64),
    evidence: z.array(z.string().trim().min(1).max(500)).min(1).max(64)
  })
  .strict();

const bringupProcedureCaseSchema = z
  .object({
    caseId: physicalIdentifierSchema,
    procedureStepId: physicalIdentifierSchema,
    endpointId: physicalIdentifierSchema,
    title: z.string().trim().min(1).max(240),
    procedure: z.array(z.string().trim().min(1).max(1_000)).min(1).max(64),
    requiredConditions: z.array(physicalRequiredConditionSchema).min(1).max(64),
    minimumDurationMs: z.number().int().positive(),
    captureRequirements: z.array(physicalCaptureRequirementSchema).min(1).max(64)
  })
  .strict()
  .superRefine((entry, context) => {
    const conditionIds = entry.requiredConditions.map((condition) => condition.conditionId.toLocaleLowerCase("en-US"));
    const captureIds = entry.captureRequirements.map((capture) => capture.captureRequirementId.toLocaleLowerCase("en-US"));
    if (new Set(conditionIds).size !== conditionIds.length) {
      context.addIssue({ code: "custom", path: ["requiredConditions"], message: "Duplicate required condition ID" });
    }
    if (new Set(captureIds).size !== captureIds.length) {
      context.addIssue({ code: "custom", path: ["captureRequirements"], message: "Duplicate capture requirement ID" });
    }
  });

const bringupPlanShape = {
  profileId: physicalIdentifierSchema,
  boardRevision: z.string().trim().min(1).max(160),
  lifecycle: z.literal("candidate"),
  defaultResult: z.literal("NOT_RUN"),
  steps: z.array(bringupStepSchema).min(1).max(64),
  evidenceRequirements: z.array(z.string().trim().min(1).max(500)).min(1).max(128)
} as const;

export const bringupPlanV1Schema = z
  .object({ schemaVersion: z.literal("evleda.bringup-plan.v1"), ...bringupPlanShape })
  .strict();

export const bringupPlanSchema = z
  .object({
    schemaVersion: z.literal("evleda.bringup-plan.v2"),
    procedureId: physicalIdentifierSchema,
    ...bringupPlanShape,
    cases: z.array(bringupProcedureCaseSchema).min(1).max(128)
  })
  .strict()
  .superRefine((plan, context) => {
    const stepIds = plan.steps.map((step) => step.id.toLocaleLowerCase("en-US"));
    const caseIds = plan.cases.map((entry) => entry.caseId.toLocaleLowerCase("en-US"));
    if (new Set(stepIds).size !== stepIds.length) {
      context.addIssue({ code: "custom", path: ["steps"], message: "Duplicate bring-up step ID" });
    }
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({ code: "custom", path: ["cases"], message: "Duplicate bring-up case ID" });
    }
    const stepSet = new Set(stepIds);
    for (const [index, entry] of plan.cases.entries()) {
      if (!stepSet.has(entry.procedureStepId.toLocaleLowerCase("en-US"))) {
        context.addIssue({ code: "custom", path: ["cases", index, "procedureStepId"], message: "Bring-up case references an unknown procedure step" });
      }
    }
  });

const physicalAcceptanceV1Base = {
  id: physicalIdentifierSchema,
  category: z.enum(PHYSICAL_OBSERVATION_CATEGORIES),
  quantity: z.string().trim().min(1).max(240),
  instrumentCapability: z.enum(PHYSICAL_INSTRUMENT_CAPABILITIES)
} as const;

const numericAcceptanceTestSchema = z
  .object({
    ...physicalAcceptanceV1Base,
    kind: z.literal("numeric_range"),
    unit: z.enum(PHYSICAL_MEASUREMENT_UNITS),
    minimum: z.number().finite(),
    maximum: z.number().finite()
  })
  .strict();
const expectedAcceptanceTestSchema = z
  .object({
    ...physicalAcceptanceV1Base,
    kind: z.literal("expected_value"),
    expected: expectedScalarSchema
  })
  .strict();
export const physicalAcceptanceTestV1Schema = z.discriminatedUnion("kind", [
  numericAcceptanceTestSchema,
  expectedAcceptanceTestSchema
]);

export const physicalAcceptanceContractV1Schema = z
  .object({
    schemaVersion: z.literal("evleda.physical-acceptance.v1"),
    profileId: physicalIdentifierSchema,
    boardRevision: z.string().trim().min(1).max(160),
    lifecycle: z.literal("candidate"),
    tests: z.array(physicalAcceptanceTestV1Schema).min(PHYSICAL_OBSERVATION_CATEGORIES.length).max(128)
  })
  .strict()
  .superRefine((contract, context) => {
    const ids = new Set<string>();
    for (const [index, test] of contract.tests.entries()) {
      if (ids.has(test.id.toLocaleLowerCase("en-US"))) {
        context.addIssue({ code: "custom", path: ["tests", index, "id"], message: "Duplicate acceptance test ID" });
      }
      ids.add(test.id.toLocaleLowerCase("en-US"));
      if (test.kind === "numeric_range" && test.minimum > test.maximum) {
        context.addIssue({ code: "custom", path: ["tests", index, "minimum"], message: "Acceptance minimum exceeds maximum" });
      }
    }
    for (const category of PHYSICAL_OBSERVATION_CATEGORIES) {
      if (!contract.tests.some((test) => test.category === category)) {
        context.addIssue({ code: "custom", path: ["tests"], message: `Missing acceptance category ${category}` });
      }
    }
  });

const physicalAcceptanceBase = {
  id: physicalIdentifierSchema,
  caseId: physicalIdentifierSchema,
  category: z.enum(PHYSICAL_OBSERVATION_CATEGORIES),
  quantity: z.string().trim().min(1).max(240),
  instrumentCapability: z.enum(PHYSICAL_INSTRUMENT_CAPABILITIES)
} as const;

const numericAcceptanceTestV2Schema = z
  .object({
    ...physicalAcceptanceBase,
    kind: z.literal("numeric_range"),
    unit: z.enum(PHYSICAL_MEASUREMENT_UNITS),
    minimum: z.number().finite(),
    maximum: z.number().finite()
  })
  .strict();
const expectedAcceptanceTestV2Schema = z
  .object({
    ...physicalAcceptanceBase,
    kind: z.literal("expected_value"),
    expected: expectedScalarSchema
  })
  .strict();
export const physicalAcceptanceTestSchema = z.discriminatedUnion("kind", [
  numericAcceptanceTestV2Schema,
  expectedAcceptanceTestV2Schema
]);

export const physicalAcceptanceCaseSchema = z
  .object({
    caseId: physicalIdentifierSchema,
    procedureStepId: physicalIdentifierSchema,
    endpointId: physicalIdentifierSchema,
    requiredConditions: z.array(physicalRequiredConditionSchema).min(1).max(64),
    minimumDurationMs: z.number().int().positive(),
    captureRequirements: z.array(physicalCaptureRequirementSchema).min(1).max(64)
  })
  .strict()
  .superRefine((entry, context) => {
    const conditionIds = entry.requiredConditions.map((condition) => condition.conditionId.toLocaleLowerCase("en-US"));
    const captureIds = entry.captureRequirements.map((capture) => capture.captureRequirementId.toLocaleLowerCase("en-US"));
    if (new Set(conditionIds).size !== conditionIds.length) {
      context.addIssue({ code: "custom", path: ["requiredConditions"], message: "Duplicate required condition ID" });
    }
    if (new Set(captureIds).size !== captureIds.length) {
      context.addIssue({ code: "custom", path: ["captureRequirements"], message: "Duplicate capture requirement ID" });
    }
  });

export const physicalAcceptanceContractSchema = z
  .object({
    schemaVersion: z.literal("evleda.physical-acceptance.v2"),
    procedureSchemaVersion: z.literal("evleda.bringup-plan.v2"),
    procedureId: physicalIdentifierSchema,
    profileId: physicalIdentifierSchema,
    boardRevision: z.string().trim().min(1).max(160),
    lifecycle: z.literal("candidate"),
    cases: z.array(physicalAcceptanceCaseSchema).min(1).max(128),
    tests: z.array(physicalAcceptanceTestSchema).min(PHYSICAL_OBSERVATION_CATEGORIES.length).max(256)
  })
  .strict()
  .superRefine((contract, context) => {
    const caseIds = contract.cases.map((entry) => entry.caseId.toLocaleLowerCase("en-US"));
    const caseSet = new Set(caseIds);
    if (caseSet.size !== caseIds.length) {
      context.addIssue({ code: "custom", path: ["cases"], message: "Duplicate acceptance case ID" });
    }
    const testIds = new Set<string>();
    for (const [index, test] of contract.tests.entries()) {
      const folded = test.id.toLocaleLowerCase("en-US");
      if (testIds.has(folded)) {
        context.addIssue({ code: "custom", path: ["tests", index, "id"], message: "Duplicate acceptance test ID" });
      }
      testIds.add(folded);
      if (!caseSet.has(test.caseId.toLocaleLowerCase("en-US"))) {
        context.addIssue({ code: "custom", path: ["tests", index, "caseId"], message: "Acceptance test references an unknown case" });
      }
      if (test.kind === "numeric_range" && test.minimum > test.maximum) {
        context.addIssue({ code: "custom", path: ["tests", index, "minimum"], message: "Acceptance minimum exceeds maximum" });
      }
    }
    for (const category of PHYSICAL_OBSERVATION_CATEGORIES) {
      if (!contract.tests.some((test) => test.category === category)) {
        context.addIssue({ code: "custom", path: ["tests"], message: `Missing acceptance category ${category}` });
      }
    }
    for (const [index, entry] of contract.cases.entries()) {
      if (!contract.tests.some((test) => test.caseId.toLocaleLowerCase("en-US") === entry.caseId.toLocaleLowerCase("en-US"))) {
        context.addIssue({ code: "custom", path: ["cases", index, "caseId"], message: "Acceptance case has no test" });
      }
    }
  });

const measurementObservationBase = {
  testId: physicalIdentifierSchema,
  instrumentId: physicalIdentifierSchema,
  rawSourceId: physicalIdentifierSchema,
  observedAt: physicalTimestampSchema
} as const;
const numericMeasurementObservationSchema = z
  .object({
    ...measurementObservationBase,
    kind: z.literal("numeric_range"),
    value: z.number().finite(),
    unit: z.enum(PHYSICAL_MEASUREMENT_UNITS)
  })
  .strict();
const expectedMeasurementObservationSchema = z
  .object({
    ...measurementObservationBase,
    kind: z.literal("expected_value"),
    observed: expectedScalarSchema
  })
  .strict();
export const physicalMeasurementObservationV1Schema = z.discriminatedUnion("kind", [
  numericMeasurementObservationSchema,
  expectedMeasurementObservationSchema
]);

export const physicalMeasurementRecordV1Schema = z
  .object({
    schemaVersion: z.literal("evleda.physical-measurements.v1"),
    boardSerial: z.string().trim().min(1).max(160),
    acceptanceArtifact: physicalArtifactBindingSchema,
    firmwareBuildArtifact: physicalArtifactBindingSchema,
    firmwareBinarySourceId: physicalIdentifierSchema,
    firmwareBinaryIdentity: externalContentIdentitySchema,
    environment: physicalEnvironmentSchema,
    startedAt: physicalTimestampSchema,
    completedAt: physicalTimestampSchema,
    observations: z.array(physicalMeasurementObservationV1Schema).min(PHYSICAL_OBSERVATION_CATEGORIES.length).max(128)
  })
  .strict()
  .superRefine((record, context) => {
    const ids = new Set<string>();
    for (const [index, observation] of record.observations.entries()) {
      const folded = observation.testId.toLocaleLowerCase("en-US");
      if (ids.has(folded)) {
        context.addIssue({ code: "custom", path: ["observations", index, "testId"], message: "Duplicate measurement test ID" });
      }
      ids.add(folded);
    }
    if (Date.parse(record.startedAt) > Date.parse(record.completedAt)) {
      context.addIssue({ code: "custom", path: ["completedAt"], message: "Measurement session ends before it starts" });
    }
  });

const targetCompiledSourceSchema = z
  .object({
    logicalName: z.string().trim().min(1).max(240),
    identity: externalContentIdentitySchema
  })
  .strict();

const physicalFirmwareTargetProvenanceShape = {
    projectId: identifier,
    runId: identifier,
    designRevisionId: identifier,
    targetBuildReportArtifact: physicalArtifactBindingSchema,
    targetBinaryArtifact: physicalArtifactBindingSchema,
    targetSourceRevisionDigest: digestSchema,
    targetBuildSourceIdentity: externalCanonicalIdentitySchema,
    targetConfigurationIdentity: externalCanonicalIdentitySchema,
    targetToolchainIdentity: externalCanonicalIdentitySchema,
    targetCompiledSources: z.array(targetCompiledSourceSchema).min(1).max(32)
} as const;

const refineFirmwareTargetProvenance = (
  provenance: z.infer<z.ZodObject<typeof physicalFirmwareTargetProvenanceShape>>,
  context: z.RefinementCtx
): void => {
    const names = provenance.targetCompiledSources.map((source) => source.logicalName);
    const digests = provenance.targetCompiledSources.map((source) => source.identity.digest);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", path: ["targetCompiledSources"], message: "Duplicate target compiled-source logical name" });
    }
    if (new Set(digests).size !== digests.length) {
      context.addIssue({ code: "custom", path: ["targetCompiledSources"], message: "Duplicate target compiled-source identity" });
    }
};

export const physicalFirmwareTargetProvenanceSchema = z
  .object(physicalFirmwareTargetProvenanceShape)
  .strict()
  .superRefine(refineFirmwareTargetProvenance);

const measurementObservationV2Base = {
  testId: physicalIdentifierSchema,
  instrumentId: physicalIdentifierSchema,
  captureRequirementId: physicalIdentifierSchema,
  observedAt: physicalTimestampSchema
} as const;
const numericMeasurementObservationV2Schema = z
  .object({
    ...measurementObservationV2Base,
    kind: z.literal("numeric_range"),
    value: z.number().finite(),
    unit: z.enum(PHYSICAL_MEASUREMENT_UNITS)
  })
  .strict();
const expectedMeasurementObservationV2Schema = z
  .object({
    ...measurementObservationV2Base,
    kind: z.literal("expected_value"),
    observed: expectedScalarSchema
  })
  .strict();
export const physicalMeasurementObservationSchema = z.discriminatedUnion("kind", [
  numericMeasurementObservationV2Schema,
  expectedMeasurementObservationV2Schema
]);

export const physicalCaptureBindingSchema = z
  .object({
    captureRequirementId: physicalIdentifierSchema,
    sourceId: physicalIdentifierSchema,
    instrumentId: physicalIdentifierSchema,
    sampleCount: z.number().int().positive()
  })
  .strict();

export const physicalCaseExecutionSchema = z
  .object({
    caseId: physicalIdentifierSchema,
    procedureStepId: physicalIdentifierSchema,
    endpointId: physicalIdentifierSchema,
    operatorId: physicalIdentifierSchema,
    startedAt: physicalTimestampSchema,
    completedAt: physicalTimestampSchema,
    actualConditions: z.array(physicalActualConditionSchema).min(1).max(64),
    captureBindings: z.array(physicalCaptureBindingSchema).min(1).max(64),
    observations: z.array(physicalMeasurementObservationSchema).min(1).max(256)
  })
  .strict()
  .superRefine((execution, context) => {
    if (Date.parse(execution.startedAt) >= Date.parse(execution.completedAt)) {
      context.addIssue({ code: "custom", path: ["completedAt"], message: "Case execution must have positive duration" });
    }
    const conditionIds = execution.actualConditions.map((condition) => condition.conditionId.toLocaleLowerCase("en-US"));
    const captureIds = execution.captureBindings.map((binding) => binding.captureRequirementId.toLocaleLowerCase("en-US"));
    const testIds = execution.observations.map((observation) => observation.testId.toLocaleLowerCase("en-US"));
    if (new Set(conditionIds).size !== conditionIds.length) {
      context.addIssue({ code: "custom", path: ["actualConditions"], message: "Duplicate actual condition ID" });
    }
    if (new Set(captureIds).size !== captureIds.length) {
      context.addIssue({ code: "custom", path: ["captureBindings"], message: "Duplicate capture requirement binding" });
    }
    if (new Set(testIds).size !== testIds.length) {
      context.addIssue({ code: "custom", path: ["observations"], message: "Duplicate measurement test ID within case execution" });
    }
    const boundCaptures = new Map(
      execution.captureBindings.map((binding) => [
        binding.captureRequirementId.toLocaleLowerCase("en-US"),
        binding
      ])
    );
    for (const [index, observation] of execution.observations.entries()) {
      const binding = boundCaptures.get(observation.captureRequirementId.toLocaleLowerCase("en-US"));
      if (binding === undefined) {
        context.addIssue({ code: "custom", path: ["observations", index, "captureRequirementId"], message: "Observation references an unbound capture requirement" });
      } else if (binding.instrumentId.toLocaleLowerCase("en-US") !== observation.instrumentId.toLocaleLowerCase("en-US")) {
        context.addIssue({ code: "custom", path: ["observations", index, "instrumentId"], message: "Observation instrument does not match its capture binding" });
      }
    }
  });

export const physicalMeasurementRecordSchema = z
  .object({
    schemaVersion: z.literal("evleda.physical-measurements.v2"),
    boardSerial: z.string().trim().min(1).max(160),
    bringupProcedureArtifact: physicalArtifactBindingSchema,
    acceptanceArtifact: physicalArtifactBindingSchema,
    ...physicalFirmwareTargetProvenanceShape,
    firmwareBinarySourceId: physicalIdentifierSchema,
    firmwareBinaryIdentity: externalContentIdentitySchema,
    environment: physicalEnvironmentSchema,
    operators: z.array(physicalMeasurementOperatorSchema).min(1).max(32),
    startedAt: physicalTimestampSchema,
    completedAt: physicalTimestampSchema,
    caseExecutions: z.array(physicalCaseExecutionSchema).min(1).max(128)
  })
  .strict()
  .superRefine((record, context) => {
    refineFirmwareTargetProvenance(record, context);
    if (
      record.firmwareBinaryIdentity.digest !== record.targetBinaryArtifact.identity.digest ||
      record.firmwareBinaryIdentity.size !== record.targetBinaryArtifact.identity.size
    ) {
      context.addIssue({ code: "custom", path: ["firmwareBinaryIdentity"], message: "Firmware binary identity must match the bound target BIN artifact" });
    }
    if (Date.parse(record.startedAt) >= Date.parse(record.completedAt)) {
      context.addIssue({ code: "custom", path: ["completedAt"], message: "Measurement session must have positive duration" });
    }
    const operatorIds = record.operators.map((operator) => operator.id.toLocaleLowerCase("en-US"));
    if (new Set(operatorIds).size !== operatorIds.length) {
      context.addIssue({ code: "custom", path: ["operators"], message: "Duplicate measurement operator ID" });
    }
    const caseIds = record.caseExecutions.map((execution) => execution.caseId.toLocaleLowerCase("en-US"));
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({ code: "custom", path: ["caseExecutions"], message: "Duplicate measurement case execution" });
    }
    const referencedOperators = new Set(record.caseExecutions.map((execution) => execution.operatorId.toLocaleLowerCase("en-US")));
    for (const [index, execution] of record.caseExecutions.entries()) {
      if (!operatorIds.includes(execution.operatorId.toLocaleLowerCase("en-US"))) {
        context.addIssue({ code: "custom", path: ["caseExecutions", index, "operatorId"], message: "Case execution references an unknown measurement operator" });
      }
      if (Date.parse(execution.startedAt) < Date.parse(record.startedAt) || Date.parse(execution.completedAt) > Date.parse(record.completedAt)) {
        context.addIssue({ code: "custom", path: ["caseExecutions", index], message: "Case execution falls outside the measurement session" });
      }
    }
    for (const [index, operator] of record.operators.entries()) {
      if (!referencedOperators.has(operator.id.toLocaleLowerCase("en-US"))) {
        context.addIssue({ code: "custom", path: ["operators", index, "id"], message: "Measurement operator is not bound to a case execution" });
      }
    }
  });

export const physicalAsBuiltRecordV1Schema = z
  .object({
    schemaVersion: z.literal("evleda.as-built-record.v1"),
    boardSerial: z.string().trim().min(1).max(160),
    assemblyLot: z.string().trim().min(1).max(160),
    completedAt: physicalTimestampSchema,
    revisionManifestDigest: digestSchema,
    bomArtifact: physicalArtifactBindingSchema,
    camManifestArtifact: physicalArtifactBindingSchema,
    substitutions: z.array(substitutionSchema).max(200)
  })
  .strict();

export const physicalAsBuiltRecordSchema = z
  .object({
    schemaVersion: z.literal("evleda.as-built-record.v2"),
    boardSerial: z.string().trim().min(1).max(160),
    assemblyLot: z.string().trim().min(1).max(160),
    assemblyOperator: physicalAssemblyOperatorSchema,
    completedAt: physicalTimestampSchema,
    revisionManifestDigest: digestSchema,
    bomArtifact: physicalArtifactBindingSchema,
    camManifestArtifact: physicalArtifactBindingSchema,
    substitutions: z.array(substitutionSchema).max(200)
  })
  .strict();

export const physicalFirmwareFlashRecordV1Schema = z
  .object({
    schemaVersion: z.literal("evleda.firmware-flash-record.v1"),
    boardSerial: z.string().trim().min(1).max(160),
    flashedAt: physicalTimestampSchema,
    firmwareBuildArtifact: physicalArtifactBindingSchema,
    firmwareBinarySourceId: physicalIdentifierSchema,
    firmwareBinaryIdentity: externalContentIdentitySchema,
    programmerInstrumentId: physicalIdentifierSchema
  })
  .strict();

export const physicalFirmwareFlashRecordSchema = z
  .object({
    schemaVersion: z.literal("evleda.firmware-flash-record.v2"),
    boardSerial: z.string().trim().min(1).max(160),
    flashedAt: physicalTimestampSchema,
    ...physicalFirmwareTargetProvenanceShape,
    firmwareBinarySourceId: physicalIdentifierSchema,
    firmwareBinaryIdentity: externalContentIdentitySchema,
    programmerInstrumentId: physicalIdentifierSchema
  })
  .strict()
  .superRefine((record, context) => {
    refineFirmwareTargetProvenance(record, context);
    if (
      record.firmwareBinaryIdentity.digest !== record.targetBinaryArtifact.identity.digest ||
      record.firmwareBinaryIdentity.size !== record.targetBinaryArtifact.identity.size
    ) {
      context.addIssue({ code: "custom", path: ["firmwareBinaryIdentity"], message: "Firmware binary identity must match the bound target BIN artifact" });
    }
  });

const physicalInstrumentCapabilitySchema = z
  .object({
    capability: z.enum(PHYSICAL_INSTRUMENT_CAPABILITIES),
    units: z.array(z.enum(PHYSICAL_MEASUREMENT_UNITS)).max(PHYSICAL_MEASUREMENT_UNITS.length)
  })
  .strict();
export const physicalInstrumentCalibrationRecordSchema = z
  .object({
    schemaVersion: z.literal("evleda.instrument-calibration.v1"),
    instrumentId: physicalIdentifierSchema,
    manufacturer: z.string().trim().min(1).max(160),
    model: z.string().trim().min(1).max(160),
    serial: z.string().trim().min(1).max(160),
    calibratedAt: physicalTimestampSchema,
    validUntil: physicalTimestampSchema,
    capabilities: z.array(physicalInstrumentCapabilitySchema).min(1).max(PHYSICAL_INSTRUMENT_CAPABILITIES.length)
  })
  .strict()
  .superRefine((calibration, context) => {
    if (Date.parse(calibration.calibratedAt) >= Date.parse(calibration.validUntil)) {
      context.addIssue({ code: "custom", path: ["validUntil"], message: "Calibration expiry must follow calibration time" });
    }
    const capabilities = calibration.capabilities.map((entry) => entry.capability);
    if (new Set(capabilities).size !== capabilities.length) {
      context.addIssue({ code: "custom", path: ["capabilities"], message: "Duplicate instrument capability" });
    }
    for (const [index, capability] of calibration.capabilities.entries()) {
      if (new Set(capability.units).size !== capability.units.length) {
        context.addIssue({ code: "custom", path: ["capabilities", index, "units"], message: "Duplicate capability unit" });
      }
    }
  });

export const physicalSourceBlobMetadataV1Schema = z
  .object({
    id: physicalIdentifierSchema,
    role: z.enum([
      "as_built_record",
      "flashed_firmware_binary",
      "firmware_flash_record",
      "instrument_calibration",
      "raw_observation",
      "parsed_measurement_record"
    ]),
    mediaType: z.enum(PHYSICAL_SOURCE_MEDIA_TYPES),
    identity: externalContentIdentitySchema.refine(
      (identity) => identity.size <= EXTERNAL_EVIDENCE_BLOB_MAX_BYTES,
      `Each external evidence blob is limited to ${EXTERNAL_EVIDENCE_BLOB_MAX_BYTES} bytes`
    ),
    capturedAt: physicalTimestampSchema
  })
  .strict();

export const physicalSourceBlobV1Schema = physicalSourceBlobMetadataV1Schema
  .extend({ bytesBase64: canonicalBase64Schema })
  .strict()
  .superRefine((source, context) => {
    const padding = source.bytesBase64.endsWith("==") ? 2 : source.bytesBase64.endsWith("=") ? 1 : 0;
    const decodedSize = (source.bytesBase64.length / 4) * 3 - padding;
    if (decodedSize !== source.identity.size) {
      context.addIssue({ code: "custom", path: ["bytesBase64"], message: "Decoded source byte length does not match identity" });
    }
    const jsonRole = ["as_built_record", "firmware_flash_record", "instrument_calibration", "parsed_measurement_record"].includes(source.role);
    if ((jsonRole && source.mediaType !== "application/json") || (source.role === "flashed_firmware_binary" && source.mediaType !== "application/octet-stream")) {
      context.addIssue({ code: "custom", path: ["mediaType"], message: "Source media type does not match its canonical role" });
    }
  });

export const physicalSourceBlobMetadataSchema = z
  .object({
    id: physicalIdentifierSchema,
    role: z.enum([
      "as_built_record",
      "flashed_firmware_binary",
      "firmware_flash_record",
      "instrument_calibration",
      "required_capture",
      "supporting_attachment",
      "parsed_measurement_record"
    ]),
    mediaType: z.enum(PHYSICAL_SOURCE_MEDIA_TYPES),
    identity: externalContentIdentitySchema.refine(
      (identity) => identity.size <= EXTERNAL_EVIDENCE_BLOB_MAX_BYTES,
      `Each external evidence blob is limited to ${EXTERNAL_EVIDENCE_BLOB_MAX_BYTES} bytes`
    ),
    capturedAt: physicalTimestampSchema
  })
  .strict();

export const physicalSourceBlobSchema = physicalSourceBlobMetadataSchema
  .extend({ bytesBase64: canonicalBase64Schema })
  .strict()
  .superRefine((source, context) => {
    const padding = source.bytesBase64.endsWith("==") ? 2 : source.bytesBase64.endsWith("=") ? 1 : 0;
    const decodedSize = (source.bytesBase64.length / 4) * 3 - padding;
    if (decodedSize !== source.identity.size) {
      context.addIssue({ code: "custom", path: ["bytesBase64"], message: "Decoded source byte length does not match identity" });
    }
    const jsonRole = ["as_built_record", "firmware_flash_record", "instrument_calibration", "parsed_measurement_record"].includes(source.role);
    if ((jsonRole && source.mediaType !== "application/json") || (source.role === "flashed_firmware_binary" && source.mediaType !== "application/octet-stream")) {
      context.addIssue({ code: "custom", path: ["mediaType"], message: "Source media type does not match its canonical role" });
    }
  });

const physicalInstrumentSchema = z
  .object({ id: physicalIdentifierSchema, calibrationSourceId: physicalIdentifierSchema })
  .strict();

const physicalSubmissionV1Shape = {
  actor: humanActorSchema.refine((actor) => actor.role === "hardware_qualifier", {
    message: "Physical evidence submitter must have the hardware_qualifier role"
  }),
  artifactBindings: physicalArtifactBindingsV1Schema,
  sourceBlobs: z.array(physicalSourceBlobV1Schema).min(6).max(512),
  asBuiltRecordSourceId: physicalIdentifierSchema,
  flashedFirmwareBinarySourceId: physicalIdentifierSchema,
  firmwareFlashRecordSourceId: physicalIdentifierSchema,
  measurementRecordSourceId: physicalIdentifierSchema,
  instruments: z.array(physicalInstrumentSchema).min(1).max(32),
  rationale: z.string().trim().min(1).max(4_000)
} as const;

const physicalSubmissionShape = {
  actor: humanActorSchema.refine((actor) => actor.role === "hardware_qualifier", {
    message: "Physical evidence submitter must have the hardware_qualifier role"
  }),
  artifactBindings: physicalArtifactBindingsSchema,
  sourceBlobs: z.array(physicalSourceBlobSchema).min(6).max(512),
  asBuiltRecordSourceId: physicalIdentifierSchema,
  flashedFirmwareBinarySourceId: physicalIdentifierSchema,
  firmwareFlashRecordSourceId: physicalIdentifierSchema,
  measurementRecordSourceId: physicalIdentifierSchema,
  instruments: z.array(physicalInstrumentSchema).min(1).max(32),
  rationale: z.string().trim().min(1).max(4_000)
} as const;

const duplicateFolded = (values: readonly string[]): boolean =>
  new Set(values.map((value) => value.toLocaleLowerCase("en-US"))).size !== values.length;

const refinePhysicalSubmission = (
  submission: {
    readonly artifactBindings: {
      readonly bom: z.infer<typeof physicalArtifactBindingSchema>;
      readonly cam: z.infer<typeof physicalCamBindingsSchema>;
      readonly bringupProcedure: z.infer<typeof physicalArtifactBindingSchema>;
      readonly acceptance: z.infer<typeof physicalArtifactBindingSchema>;
      readonly firmwareBuild?: z.infer<typeof physicalArtifactBindingSchema>;
      readonly targetBuildReport?: z.infer<typeof physicalArtifactBindingSchema>;
      readonly targetBinary?: z.infer<typeof physicalArtifactBindingSchema>;
    };
    readonly sourceBlobs: readonly { readonly id: string; readonly role: string; readonly identity: z.infer<typeof externalContentIdentitySchema> }[];
    readonly asBuiltRecordSourceId: string;
    readonly flashedFirmwareBinarySourceId: string;
    readonly firmwareFlashRecordSourceId: string;
    readonly measurementRecordSourceId: string;
    readonly instruments: readonly z.infer<typeof physicalInstrumentSchema>[];
  },
  context: z.RefinementCtx
): void => {
  const artifactIds = [
    submission.artifactBindings.bom.artifactId,
    submission.artifactBindings.cam.manifest.artifactId,
    ...submission.artifactBindings.cam.artifacts.map((binding) => binding.artifactId),
    ...(submission.artifactBindings.firmwareBuild === undefined ? [] : [submission.artifactBindings.firmwareBuild.artifactId]),
    ...(submission.artifactBindings.targetBuildReport === undefined ? [] : [submission.artifactBindings.targetBuildReport.artifactId]),
    ...(submission.artifactBindings.targetBinary === undefined ? [] : [submission.artifactBindings.targetBinary.artifactId]),
    submission.artifactBindings.bringupProcedure.artifactId,
    submission.artifactBindings.acceptance.artifactId
  ];
  const sourceIds = submission.sourceBlobs.map((source) => source.id);
  const sourceDigests = submission.sourceBlobs.map((source) => source.identity.digest);
  const instrumentIds = submission.instruments.map((instrument) => instrument.id);
  if (duplicateFolded(artifactIds)) context.addIssue({ code: "custom", path: ["artifactBindings"], message: "Duplicate or case-colliding artifact IDs" });
  if (duplicateFolded(sourceIds)) context.addIssue({ code: "custom", path: ["sourceBlobs"], message: "Duplicate or case-colliding source IDs" });
  if (new Set(sourceDigests).size !== sourceDigests.length) context.addIssue({ code: "custom", path: ["sourceBlobs"], message: "Duplicate source identities are ambiguous" });
  if (duplicateFolded(instrumentIds)) context.addIssue({ code: "custom", path: ["instruments"], message: "Duplicate or case-colliding instrument IDs" });
  const total = submission.sourceBlobs.reduce((sum, source) => sum + source.identity.size, 0);
  if (total > EXTERNAL_EVIDENCE_TOTAL_BLOB_MAX_BYTES) context.addIssue({ code: "custom", path: ["sourceBlobs"], message: "External evidence source byte limit exceeded" });

  const sourceById = new Map(submission.sourceBlobs.map((source) => [source.id, source]));
  const required: readonly [string, string, string][] = [
    ["asBuiltRecordSourceId", submission.asBuiltRecordSourceId, "as_built_record"],
    ["flashedFirmwareBinarySourceId", submission.flashedFirmwareBinarySourceId, "flashed_firmware_binary"],
    ["firmwareFlashRecordSourceId", submission.firmwareFlashRecordSourceId, "firmware_flash_record"],
    ["measurementRecordSourceId", submission.measurementRecordSourceId, "parsed_measurement_record"]
  ];
  for (const [path, sourceId, role] of required) {
    if (sourceById.get(sourceId)?.role !== role) context.addIssue({ code: "custom", path: [path], message: `Expected ${role} source` });
  }
  const requiredCaptureRole = submission.artifactBindings.targetBinary === undefined ? "raw_observation" : "required_capture";
  if (!submission.sourceBlobs.some((source) => source.role === requiredCaptureRole)) {
    context.addIssue({ code: "custom", path: ["sourceBlobs"], message: `At least one ${requiredCaptureRole} source is required` });
  }
  const calibrationIds = submission.instruments.map((instrument) => instrument.calibrationSourceId);
  if (duplicateFolded(calibrationIds)) context.addIssue({ code: "custom", path: ["instruments"], message: "Calibration sources cannot be shared" });
  for (const [index, instrument] of submission.instruments.entries()) {
    if (sourceById.get(instrument.calibrationSourceId)?.role !== "instrument_calibration") {
      context.addIssue({ code: "custom", path: ["instruments", index, "calibrationSourceId"], message: "Expected instrument_calibration source" });
    }
  }
};

export const submitExternalEvidenceInputSchema = z
  .union([
    z
      .object({
        revisionId: identifier,
        revisionManifestDigest: digestSchema,
        evidenceRootDigest: digestSchema,
        ...physicalSubmissionShape,
        ...existingResourceMutationMetadata
      })
      .strict()
      .superRefine(refinePhysicalSubmission),
    z
      .object({
        revisionId: identifier,
        revisionManifestDigest: digestSchema,
        evidenceRootDigest: digestSchema,
        ...physicalSubmissionV1Shape,
        ...existingResourceMutationMetadata
      })
      .strict()
      .superRefine(refinePhysicalSubmission)
  ]);

export const submitExternalEvidenceCurrentInputSchema = z
  .object({
    revisionId: identifier,
    revisionManifestDigest: digestSchema,
    evidenceRootDigest: digestSchema,
    ...physicalSubmissionShape,
    ...existingResourceMutationMetadata
  })
  .strict()
  .superRefine(refinePhysicalSubmission);

export const submitExternalEvidenceLegacyInputSchema = z
  .object({
    revisionId: identifier,
    revisionManifestDigest: digestSchema,
    evidenceRootDigest: digestSchema,
    ...physicalSubmissionV1Shape,
    ...existingResourceMutationMetadata
  })
  .strict()
  .superRefine(refinePhysicalSubmission);

export const physicalObservationResultSchema = z
  .object({
    testId: physicalIdentifierSchema,
    category: z.enum(PHYSICAL_OBSERVATION_CATEGORIES),
    verdict: z.enum(["pass", "fail"])
  })
  .strict();

export const physicalCaseResultSchema = z
  .object({
    caseId: physicalIdentifierSchema,
    verdict: z.enum(["pass", "fail"])
  })
  .strict();

export const physicalCategoryVerdictsSchema = z
  .object({
    rails: z.enum(["pass", "fail"]),
    programming: z.enum(["pass", "fail"]),
    communications: z.enum(["pass", "fail"]),
    sensors: z.enum(["pass", "fail"]),
    actuators: z.enum(["pass", "fail"]),
    thermal: z.enum(["pass", "fail"]),
    fault_reset: z.enum(["pass", "fail"])
  })
  .strict();

const storedSourceMetadataV1Schema = physicalSourceBlobMetadataV1Schema
  .extend({
    archivePath: z.string().regex(/^sources\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/u),
    policyValidUntil: physicalTimestampSchema
  })
  .strict();
const storedSourceMetadataSchema = physicalSourceBlobMetadataSchema
  .extend({
    archivePath: z.string().regex(/^sources\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/u),
    policyValidUntil: physicalTimestampSchema
  })
  .strict();
const storedInstrumentSchema = physicalInstrumentSchema
  .extend({ calibration: physicalInstrumentCalibrationRecordSchema })
  .strict();

export const humanPhysicalEvidenceRecordV2Schema = z
  .object({
    schemaVersion: z.literal("evleda.human-physical-evidence.v2"),
    policy: z.object({
      schemaVersion: z.literal(PHYSICAL_EVIDENCE_POLICY.schemaVersion),
      maximumSessionDurationMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumSessionDurationMs),
      maximumSubmissionAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumSubmissionAgeMs),
      maximumEvidenceAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumEvidenceAgeMs),
      maximumAsBuiltAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumAsBuiltAgeMs),
      maximumCalibrationAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumCalibrationAgeMs)
    }).strict(),
    projectId: identifier,
    runId: identifier,
    designRevisionId: identifier,
    runStateRevision: z.number().int().nonnegative(),
    revisionManifest: externalCanonicalIdentitySchema,
    evidenceRootBefore: externalCanonicalIdentitySchema,
    boardSerial: z.string().trim().min(1).max(160),
    artifactBindings: physicalArtifactBindingsV1Schema,
    sourceBlobs: z.array(storedSourceMetadataV1Schema).min(6).max(512),
    primarySourceIds: z.object({
      asBuiltRecord: physicalIdentifierSchema,
      flashedFirmwareBinary: physicalIdentifierSchema,
      firmwareFlashRecord: physicalIdentifierSchema,
      measurementRecord: physicalIdentifierSchema
    }).strict(),
    asBuiltRecord: physicalAsBuiltRecordV1Schema,
    firmwareFlashRecord: physicalFirmwareFlashRecordV1Schema,
    measurementRecord: physicalMeasurementRecordV1Schema,
    acceptanceContract: physicalAcceptanceContractV1Schema,
    instruments: z.array(storedInstrumentSchema).min(1).max(32),
    results: z.object({
      observations: z.array(physicalObservationResultSchema).min(PHYSICAL_OBSERVATION_CATEGORIES.length),
      categories: physicalCategoryVerdictsSchema,
      overallVerdict: z.enum(["pass", "fail"])
    }).strict(),
    actor: humanActorSchema,
    rationale: z.string().trim().min(1).max(4_000),
    recordedAt: physicalTimestampSchema,
    validUntil: physicalTimestampSchema
  })
  .strict();

export const humanPhysicalEvidenceRecordSchema = z
  .object({
    schemaVersion: z.literal("evleda.human-physical-evidence.v3"),
    policy: z.object({
      schemaVersion: z.literal(PHYSICAL_EVIDENCE_POLICY.schemaVersion),
      maximumSessionDurationMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumSessionDurationMs),
      maximumSubmissionAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumSubmissionAgeMs),
      maximumEvidenceAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumEvidenceAgeMs),
      maximumAsBuiltAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumAsBuiltAgeMs),
      maximumCalibrationAgeMs: z.literal(PHYSICAL_EVIDENCE_POLICY.maximumCalibrationAgeMs)
    }).strict(),
    projectId: identifier,
    runId: identifier,
    designRevisionId: identifier,
    runStateRevision: z.number().int().nonnegative(),
    revisionManifest: externalCanonicalIdentitySchema,
    evidenceRootBefore: externalCanonicalIdentitySchema,
    boardSerial: z.string().trim().min(1).max(160),
    artifactBindings: physicalArtifactBindingsSchema,
    sourceBlobs: z.array(storedSourceMetadataSchema).min(6).max(512),
    primarySourceIds: z.object({
      asBuiltRecord: physicalIdentifierSchema,
      flashedFirmwareBinary: physicalIdentifierSchema,
      firmwareFlashRecord: physicalIdentifierSchema,
      measurementRecord: physicalIdentifierSchema
    }).strict(),
    bringupPlan: bringupPlanSchema,
    asBuiltRecord: physicalAsBuiltRecordSchema,
    firmwareFlashRecord: physicalFirmwareFlashRecordSchema,
    measurementRecord: physicalMeasurementRecordSchema,
    acceptanceContract: physicalAcceptanceContractSchema,
    instruments: z.array(storedInstrumentSchema).min(1).max(32),
    results: z.object({
      cases: z.array(physicalCaseResultSchema).min(1),
      observations: z.array(physicalObservationResultSchema).min(PHYSICAL_OBSERVATION_CATEGORIES.length),
      categories: physicalCategoryVerdictsSchema,
      overallVerdict: z.enum(["pass", "fail"])
    }).strict(),
    actor: humanActorSchema.refine((actor) => actor.role === "hardware_qualifier", {
      message: "Physical evidence record actor must have the hardware_qualifier role"
    }),
    rationale: z.string().trim().min(1).max(4_000),
    recordedAt: physicalTimestampSchema,
    validUntil: physicalTimestampSchema
  })
  .strict();

export const authorizeManufacturingReleaseInputSchema = z
  .object({
    revisionId: identifier,
    subjectDigest: digestSchema,
    evidenceRootDigest: digestSchema,
    qualificationApprovalId: identifier,
    actor: humanActorSchema.refine((actor) => actor.role === "release_authority", {
      message: "Manufacturing release actor must have the release_authority role"
    }),
    scope: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(4_000),
    ...existingResourceMutationMetadata
  })
  .strict();

export const revokeAttestationInputSchema = z
  .object({
    approvalId: identifier,
    actor: humanActorSchema,
    reason: z.string().trim().min(1).max(4_000),
    ...existingResourceMutationMetadata
  })
  .strict();

export type SubmitExternalEvidenceInput = z.input<typeof submitExternalEvidenceInputSchema>;
export type SubmitExternalEvidenceCurrentInput = z.input<typeof submitExternalEvidenceCurrentInputSchema>;
export type SubmitExternalEvidenceLegacyInput = z.input<typeof submitExternalEvidenceLegacyInputSchema>;
export type PhysicalObservationCategory = (typeof PHYSICAL_OBSERVATION_CATEGORIES)[number];
export type BringupPlanV1 = z.output<typeof bringupPlanV1Schema>;
export type PhysicalBringupPlan = z.output<typeof bringupPlanSchema>;
export type PhysicalOperator = z.output<typeof physicalOperatorSchema>;
export type PhysicalRequiredCondition = z.output<typeof physicalRequiredConditionSchema>;
export type PhysicalActualCondition = z.output<typeof physicalActualConditionSchema>;
export type PhysicalCaptureRequirement = z.output<typeof physicalCaptureRequirementSchema>;
export type PhysicalAcceptanceCase = z.output<typeof physicalAcceptanceCaseSchema>;
export type PhysicalAcceptanceTest = z.output<typeof physicalAcceptanceTestSchema>;
export type PhysicalCaseExecution = z.output<typeof physicalCaseExecutionSchema>;
export type PhysicalSourceBlobMetadata = z.output<typeof physicalSourceBlobMetadataSchema>;
export type PhysicalSourceBlobMetadataV1 = z.output<typeof physicalSourceBlobMetadataV1Schema>;
export type PhysicalArtifactBindingsV1 = z.output<typeof physicalArtifactBindingsV1Schema>;
export type PhysicalArtifactBindings = z.output<typeof physicalArtifactBindingsSchema>;
export type PhysicalAcceptanceContractV1 = z.output<typeof physicalAcceptanceContractV1Schema>;
export type PhysicalAcceptanceContract = z.output<typeof physicalAcceptanceContractSchema>;
export type PhysicalMeasurementRecordV1 = z.output<typeof physicalMeasurementRecordV1Schema>;
export type PhysicalMeasurementRecord = z.output<typeof physicalMeasurementRecordSchema>;
export type PhysicalAsBuiltRecordV1 = z.output<typeof physicalAsBuiltRecordV1Schema>;
export type PhysicalAsBuiltRecord = z.output<typeof physicalAsBuiltRecordSchema>;
export type PhysicalFirmwareFlashRecordV1 = z.output<typeof physicalFirmwareFlashRecordV1Schema>;
export type PhysicalFirmwareFlashRecord = z.output<typeof physicalFirmwareFlashRecordSchema>;
export type PhysicalInstrumentCalibrationRecord = z.output<typeof physicalInstrumentCalibrationRecordSchema>;
export type PhysicalCategoryVerdicts = z.output<typeof physicalCategoryVerdictsSchema>;
export type HumanPhysicalEvidenceRecordV2 = z.output<typeof humanPhysicalEvidenceRecordV2Schema>;
export type HumanPhysicalEvidenceRecord = z.output<typeof humanPhysicalEvidenceRecordSchema>;
export type AuthorizeManufacturingReleaseInput = z.input<
  typeof authorizeManufacturingReleaseInputSchema
>;
export type RevokeAttestationInput = z.input<typeof revokeAttestationInputSchema>;

export const generateBringupPlanInputSchema = z
  .object({
    revisionId: identifier,
    ...existingResourceMutationMetadata
  })
  .strict();

export const generateFirmwareScaffoldInputSchema = z
  .object({
    revisionId: identifier,
    language: z.enum(["c", "cpp", "rust"]).default("c"),
    ...existingResourceMutationMetadata
  })
  .strict();

export const operationInputSchemas = {
  create_project: createProjectInputSchema,
  start_design_run: startDesignRunInputSchema,
  get_run_status: getRunStatusInputSchema,
  inspect_requirements: inspectRequirementsInputSchema,
  approve_requirements: approveRequirementsInputSchema,
  resume_run: resumeRunInputSchema,
  list_artifacts: listArtifactsInputSchema,
  inspect_evidence: inspectEvidenceInputSchema,
  inspect_engineering_practices: inspectEngineeringPracticesInputSchema,
  rerun_stage: rerunStageInputSchema,
  export_candidate_bundle: exportCandidateBundleInputSchema,
  export_prototype_bundle: exportPrototypeBundleInputSchema,
  generate_bringup_plan: generateBringupPlanInputSchema,
  generate_firmware_scaffold: generateFirmwareScaffoldInputSchema
} as const satisfies Record<OperationName, z.ZodType>;

export interface OperationInputByName {
  readonly create_project: z.input<typeof createProjectInputSchema>;
  readonly start_design_run: z.input<typeof startDesignRunInputSchema>;
  readonly get_run_status: z.input<typeof getRunStatusInputSchema>;
  readonly inspect_requirements: z.input<typeof inspectRequirementsInputSchema>;
  readonly approve_requirements: z.input<typeof approveRequirementsInputSchema>;
  readonly resume_run: z.input<typeof resumeRunInputSchema>;
  readonly list_artifacts: z.input<typeof listArtifactsInputSchema>;
  readonly inspect_evidence: z.input<typeof inspectEvidenceInputSchema>;
  readonly inspect_engineering_practices: z.input<
    typeof inspectEngineeringPracticesInputSchema
  >;
  readonly rerun_stage: z.input<typeof rerunStageInputSchema>;
  readonly export_candidate_bundle: z.input<typeof exportCandidateBundleInputSchema>;
  readonly export_prototype_bundle: z.input<typeof exportPrototypeBundleInputSchema>;
  readonly generate_bringup_plan: z.input<typeof generateBringupPlanInputSchema>;
  readonly generate_firmware_scaffold: z.input<typeof generateFirmwareScaffoldInputSchema>;
}

export type CreateProjectInput = OperationInputByName["create_project"];
export type StartDesignRunInput = OperationInputByName["start_design_run"];
export type GetRunStatusInput = OperationInputByName["get_run_status"];
export type InspectRequirementsInput = OperationInputByName["inspect_requirements"];
export type ApproveRequirementsInput = OperationInputByName["approve_requirements"];
export type ResumeRunInput = OperationInputByName["resume_run"];
export type ListArtifactsInput = OperationInputByName["list_artifacts"];
export type InspectEvidenceInput = OperationInputByName["inspect_evidence"];
export type InspectEngineeringPracticesInput =
  OperationInputByName["inspect_engineering_practices"];
export type RerunStageInput = OperationInputByName["rerun_stage"];
export type ExportCandidateBundleInput = OperationInputByName["export_candidate_bundle"];
export type ExportPrototypeBundleInput = OperationInputByName["export_prototype_bundle"];
export type GenerateBringupPlanInput = OperationInputByName["generate_bringup_plan"];
export type GenerateFirmwareScaffoldInput =
  OperationInputByName["generate_firmware_scaffold"];

export const OPERATION_DESCRIPTIONS: Readonly<Record<OperationName, string>> = {
  create_project: "Create an isolated local EvlEDA project.",
  start_design_run:
    "Parse a design prompt into immutable requirements and stop for human approval or a blocker.",
  get_run_status: "Inspect the persisted execution, evidence, and lifecycle state of a run.",
  inspect_requirements: "Inspect parsed requirements, exact digest, and unresolved assumptions.",
  approve_requirements:
    "Bind human approval to the exact requirements digest. Agent/MCP contexts cannot grant it.",
  resume_run: "Resume ordered candidate stages until completion or the next explicit blocker.",
  list_artifacts:
    "List immutable, evidence-bound artifacts for an explicit revision or the run's current head; includeStale never widens revision scope.",
  inspect_evidence:
    "Inspect evidence and its deterministic root for an explicit revision or the run's current head; includeStale never widens revision scope.",
  inspect_engineering_practices:
    "Inspect exact selected-revision native DRC and EvlEDA PCB-practice evidence, complete machine-rule coverage, external gates, and bounded findings without authorizing manufacture or release.",
  rerun_stage:
    "Append a new attempt from the selected stage, branching history and staling descendants.",
  export_candidate_bundle:
    "Create a deterministic review ZIP conspicuously marked NOT FOR MANUFACTURING.",
  export_prototype_bundle:
    "Create a controlled-prototype ZIP only after exact human qualification.",
  generate_bringup_plan: "Generate a candidate bring-up plan bound to an exact design revision.",
  generate_firmware_scaffold:
    "Export the exact committed candidate firmware-stage artifacts and reports from the current revision."
};

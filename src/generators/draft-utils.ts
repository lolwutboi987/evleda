import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { StageKey } from "../domain/stages.js";
import { STAGE_ORDER, stageIndex } from "../domain/stages.js";
import type { CanonicalIdentity, ContentIdentity, RequirementsDocument, ToolIdentity, UnresolvedAssumption, ValidationStatus } from "../domain/types.js";
import { firmwareResourceConflicts } from "../knowledge/firmware-parity-model.js";
import { REFERENCE_CONTROLLER_V0_LIMITS, ROBOTICS_CONTROLLER_V0, type ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import type { ArtifactDraft, BlockerDraft, CandidateStageContext, EvidenceDraft, ExactInputIdentity, StageExecutionResult } from "../workflow/contracts.js";

export const GENERATOR_TOOL: ToolIdentity = {
  name: "evleda-deterministic-generators",
  version: "0.1.0",
  adapter: "evleda",
  capabilityProfile: "robotics-controller-v0"
};

const encoder = new TextEncoder();

export const textBytes = (value: string): Uint8Array => encoder.encode(value);

export const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const identityKey = (identity: ExactInputIdentity): string =>
  "size" in identity
    ? `${identity.algorithm}:${identity.digest}:content:${identity.size}`
    : `${identity.algorithm}:${identity.digest}:canonical:${identity.schemaVersion}:${identity.canonicalizationVersion}`;

export const sortedIdentities = (
  identities: readonly ExactInputIdentity[]
): readonly ExactInputIdentity[] => {
  const unique = new Map<string, ExactInputIdentity>();
  for (const identity of identities) {
    unique.set(identityKey(identity), identity);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, identity]) => identity);
};

export interface ArtifactDraftOptions {
  readonly logicalName: string;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
  readonly exactInputs: readonly ExactInputIdentity[];
  readonly derivedFrom?: readonly string[];
  readonly tool?: ToolIdentity;
  readonly validationStatus?: ValidationStatus;
  readonly unresolvedAssumptions?: readonly UnresolvedAssumption[];
}

export const artifactDraft = (options: ArtifactDraftOptions): ArtifactDraft => {
  const content =
    typeof options.content === "string"
      ? textBytes(options.content)
      : Uint8Array.from(options.content);
  return {
    logicalName: options.logicalName,
    mediaType: options.mediaType,
    content,
    identity: contentIdentity(content),
    exactInputs: sortedIdentities(options.exactInputs),
    derivedFrom: [...(options.derivedFrom ?? [])].sort(compareCodeUnits),
    tool: options.tool ?? GENERATOR_TOOL,
    validationStatus: options.validationStatus ?? "not_run",
    unresolvedAssumptions: options.unresolvedAssumptions ?? []
  };
};

export const jsonArtifactDraft = (
  options: Omit<ArtifactDraftOptions, "content" | "mediaType"> & { readonly value: unknown }
): ArtifactDraft =>
  artifactDraft({
    ...options,
    mediaType: "application/json",
    content: `${canonicalJson(options.value)}\n`
  });

export interface EvidenceDraftOptions {
  readonly evidenceClass: EvidenceDraft["evidenceClass"];
  readonly claim: string;
  readonly subjectDigests: readonly string[];
  readonly rawArtifactLogicalName?: string;
  readonly parsedArtifactLogicalName?: string;
  readonly exactInputs: readonly ExactInputIdentity[];
  readonly tool?: ToolIdentity;
  readonly validationStatus: ValidationStatus;
  readonly unresolvedAssumptions?: readonly UnresolvedAssumption[];
}

export const evidenceDraft = (options: EvidenceDraftOptions): EvidenceDraft => ({
  evidenceClass: options.evidenceClass,
  claim: options.claim,
  subjectDigests: [...new Set(options.subjectDigests)].sort(compareCodeUnits),
  ...(options.rawArtifactLogicalName === undefined
    ? {}
    : { rawArtifactLogicalName: options.rawArtifactLogicalName }),
  ...(options.parsedArtifactLogicalName === undefined
    ? {}
    : { parsedArtifactLogicalName: options.parsedArtifactLogicalName }),
  exactInputs: sortedIdentities(options.exactInputs),
  tool: options.tool ?? GENERATOR_TOOL,
  validationStatus: options.validationStatus,
  unresolvedAssumptions: options.unresolvedAssumptions ?? []
});

export const blockerDraft = (
  code: string,
  message: string,
  affectedInputs: readonly ExactInputIdentity[],
  requiredAction: string,
  retryable = true
): BlockerDraft => ({
  code,
  message,
  affectedInputDigests: [...new Set(affectedInputs.map((identity) => identity.digest))].sort(
    compareCodeUnits
  ),
  requiredAction,
  retryable
});

export const finalizeStageResult = <K extends StageKey>(
  stage: K,
  artifacts: readonly ArtifactDraft[],
  evidence: readonly EvidenceDraft[],
  blockers: readonly BlockerDraft[],
  requirementsDocument?: RequirementsDocument
): StageExecutionResult<K> => {
  const orderedBlockers = [...blockers].sort((left, right) => {
    const byCode = compareCodeUnits(left.code, right.code);
    return byCode === 0 ? compareCodeUnits(left.message, right.message) : byCode;
  });
  const manifestPayload = {
    schemaVersion: "evleda.stage-result.v1",
    stage,
    executionStatus: orderedBlockers.length === 0 ? "succeeded" : "blocked",
    artifacts: artifacts.map((artifact) => ({
      logicalName: artifact.logicalName,
      mediaType: artifact.mediaType,
      identity: artifact.identity,
      exactInputs: artifact.exactInputs,
      derivedFrom: artifact.derivedFrom,
      tool: artifact.tool,
      validationStatus: artifact.validationStatus,
      unresolvedAssumptions: artifact.unresolvedAssumptions
    })),
    evidence,
    blockers: orderedBlockers,
    ...(requirementsDocument === undefined
      ? {}
      : { requirementsIdentity: requirementsDocument.identity })
  };
  return {
    schemaVersion: "evleda.stage-result.v1",
    stage,
    executionStatus: orderedBlockers.length === 0 ? "succeeded" : "blocked",
    artifacts,
    evidence,
    blockers: orderedBlockers,
    outputIdentity: canonicalIdentity(manifestPayload, `evleda.stage-result.${stage}.v1`),
    ...(requirementsDocument === undefined ? {} : { requirementsDocument })
  };
};

export const profileFor = (context: { readonly profile?: ReferenceControllerProfile }): ReferenceControllerProfile =>
  context.profile ?? ROBOTICS_CONTROLLER_V0;

export const upstreamArtifactIdentities = (
  context: CandidateStageContext
): readonly ContentIdentity[] =>
  context.upstream
    .flatMap((result) => result.artifacts.map((artifact) => artifact.identity))
    .sort((left, right) => compareCodeUnits(left.digest, right.digest));

export const stageExactInputs = (
  context: CandidateStageContext,
  additional: readonly ExactInputIdentity[] = []
): readonly ExactInputIdentity[] =>
  sortedIdentities([
    context.requirements.identity,
    canonicalIdentity(profileFor(context), "evleda.reference-profile.v1"),
    ...upstreamArtifactIdentities(context),
    ...additional
  ]);

export const expectedSourceRevisionDigest = (
  stage: StageKey,
  identities: readonly ExactInputIdentity[]
): string =>
  canonicalIdentity(
    { stage, exactInputs: sortedIdentities(identities) },
    `evleda.stage-input.${stage}.v1`
  ).digest;

export const prerequisiteBlockers = (
  stage: Exclude<StageKey, "requirements">,
  context: CandidateStageContext
): readonly BlockerDraft[] => {
  const blockers: BlockerDraft[] = [];
  const requiredStages = STAGE_ORDER.slice(0, stageIndex(stage));
  for (const requiredStage of requiredStages) {
    const result = context.upstream.find((entry) => entry.stage === requiredStage);
    if (result === undefined) {
      blockers.push(
        blockerDraft(
          "UPSTREAM_STAGE_MISSING",
          `Required upstream stage ${requiredStage} has no supplied immutable result.`,
          [context.requirements.identity],
          `Execute ${requiredStage} successfully and supply its exact stage result before ${stage}.`
        )
      );
    } else if (result.executionStatus !== "succeeded") {
      blockers.push(
        blockerDraft(
          "UPSTREAM_STAGE_BLOCKED",
          `Required upstream stage ${requiredStage} is ${result.executionStatus}.`,
          [result.outputIdentity],
          `Resolve ${requiredStage} blockers and regenerate an immutable successful result.`
        )
      );
    }
  }
  return blockers;
};

export const requirementsApprovalBlockers = (
  context: CandidateStageContext
): readonly BlockerDraft[] => {
  const approval = context.requirementsApproval;
  if (approval === undefined) {
    return [
      blockerDraft(
        "REQUIREMENTS_APPROVAL_MISSING",
        "A human requirements approval bound to the exact requirements digest is required.",
        [context.requirements.identity],
        "Approve the current requirements document with a human requirements_reviewer capability."
      )
    ];
  }

  const valid =
    approval.kind === "requirements" &&
    approval.projectId === context.projectId &&
    approval.runId === context.runId &&
    approval.subjectDigest === context.requirements.identity.digest &&
    approval.actor.type === "human" &&
    approval.actor.role === "requirements_reviewer" &&
    approval.revokedAt === undefined;
  if (valid) {
    return [];
  }
  return [
    blockerDraft(
      "REQUIREMENTS_APPROVAL_STALE",
      "The supplied requirements approval does not bind this project, run, and exact requirements digest.",
      [context.requirements.identity],
      "Create a new requirements approval for the current digest and run."
    )
  ];
};

export const referenceEnvelopeBlockers = (
  context: CandidateStageContext,
  profile: ReferenceControllerProfile
): readonly BlockerDraft[] => {
  const constraints = context.requirements.constraints;
  const blockers: BlockerDraft[] = [];
  const minimum = Number(constraints.input_voltage_min_mv);
  const maximum = Number(constraints.input_voltage_max_mv);
  const channels = Number(constraints.motor_channels);
  const current = Number(constraints.motor_current_rms_ma);
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum !== profile.inputVoltageMv.minimum ||
    maximum !== profile.inputVoltageMv.maximum
  ) {
    blockers.push(
      blockerDraft(
        "REFERENCE_VOLTAGE_MISMATCH",
        `The ${profile.profileId} profile requires exactly ${profile.inputVoltageMv.minimum}-${profile.inputVoltageMv.maximum} mV input.`,
        [context.requirements.identity],
        "Revise and reapprove requirements for the supported 7-16.8 V reference envelope."
      )
    );
  }
  if (channels !== profile.motor.channels) {
    blockers.push(
      blockerDraft(
        "REFERENCE_CHANNEL_COUNT_MISMATCH",
        `The ${profile.profileId} profile requires exactly ${profile.motor.channels} motor channels.`,
        [context.requirements.identity],
        "Revise and reapprove requirements for two motor channels or select a future supported profile."
      )
    );
  }
  if (!Number.isFinite(current) || current <= 0 || current > profile.motor.rmsCurrentMaPerChannel) {
    blockers.push(
      blockerDraft(
        "REFERENCE_MOTOR_CURRENT_MISMATCH",
        `The ${profile.profileId} profile permits at most ${profile.motor.rmsCurrentMaPerChannel} mA RMS per channel.`,
        [context.requirements.identity],
        "Revise and reapprove requirements within the 0.5 A RMS/channel envelope."
      )
    );
  }
  return blockers;
};

export const profileIntegrityBlockers = (
  profile: ReferenceControllerProfile,
  affectedInputs: readonly ExactInputIdentity[]
): readonly BlockerDraft[] => {
  const blockers: BlockerDraft[] = [];
  const requiredComponents = new Map([
    ["mcu", { quantity: 1, partPrefix: "STM32G0B1CET6" }],
    ["motor_driver", { quantity: 2, partPrefix: "DRV8874PWP" }],
    ["buck_5v", { quantity: 1, partPrefix: "LMR51420" }],
    ["ldo_3v3", { quantity: 1, partPrefix: "TLV75533" }],
    ["can_transceiver", { quantity: 1, partPrefix: "TCAN3413" }],
    ["usb_esd", { quantity: 1, partPrefix: "USBLC6-2SC6" }],
    ["encoder_buffer", { quantity: 2, partPrefix: "SN74LVC2G17" }],
    ["sensor_power_switch", { quantity: 1, partPrefix: "TPS2553" }]
  ] as const);
  if (
    profile.schemaVersion !== "evleda.reference-controller.v0" ||
    profile.profileId !== REFERENCE_CONTROLLER_V0_LIMITS.profileId ||
    profile.boardRevision !== REFERENCE_CONTROLLER_V0_LIMITS.boardRevision ||
    !Number.isSafeInteger(profile.inputVoltageMv.minimum) ||
    !Number.isSafeInteger(profile.inputVoltageMv.maximum) ||
    profile.inputVoltageMv.minimum < REFERENCE_CONTROLLER_V0_LIMITS.inputVoltageMv.minimum ||
    profile.inputVoltageMv.maximum > REFERENCE_CONTROLLER_V0_LIMITS.inputVoltageMv.maximum ||
    profile.inputVoltageMv.minimum > profile.inputVoltageMv.maximum ||
    profile.motor.channels !== REFERENCE_CONTROLLER_V0_LIMITS.motor.channels ||
    !Number.isSafeInteger(profile.motor.rmsCurrentMaPerChannel) ||
    profile.motor.rmsCurrentMaPerChannel <= 0 ||
    profile.motor.rmsCurrentMaPerChannel >
      REFERENCE_CONTROLLER_V0_LIMITS.motor.maximumRmsCurrentMaPerChannel ||
    profile.motor.currentChopMaPerChannel !==
      REFERENCE_CONTROLLER_V0_LIMITS.motor.currentChopMaPerChannel ||
    profile.stackup.layerCount !== REFERENCE_CONTROLLER_V0_LIMITS.stackup.layerCount ||
    profile.stackup.layers.length !== REFERENCE_CONTROLLER_V0_LIMITS.stackup.layers.length ||
    profile.stackup.layers.some(
      (layer, index) => layer !== REFERENCE_CONTROLLER_V0_LIMITS.stackup.layers[index]
    ) ||
    profile.interfaceSelections.length !==
      REFERENCE_CONTROLLER_V0_LIMITS.interfaceSelections.length ||
    REFERENCE_CONTROLLER_V0_LIMITS.interfaceSelections.some(
      (selection) => !profile.interfaceSelections.includes(selection)
    ) ||
    profile.parameterValidation.supportStatus !== "supported" ||
    profile.parameterValidation.unsupportedReasons.length > 0
  ) {
    blockers.push(
      blockerDraft(
        "REFERENCE_PROFILE_INVALID",
        `The supplied profile is outside robotics-controller-v0 support: ${profile.parameterValidation.unsupportedReasons.join(", ") || "invalid profile fields"}.`,
        affectedInputs,
        "Use createReferenceControllerProfile with a narrower 7-16.8 V range, two channels, no more than 0.5 A RMS/channel, the fixed 1 A chop circuit, six-layer 1+4+1 HDI stack, and complete v0 interface set; otherwise introduce a separately reviewed profile.",
        false
      )
    );
  }
  for (const [key, expected] of requiredComponents) {
    const matches = profile.components.filter((component) => component.key === key);
    if (
      matches.length !== 1 ||
      matches[0]?.quantity !== expected.quantity ||
      !matches[0].partNumber.startsWith(expected.partPrefix)
    ) {
      blockers.push(
        blockerDraft(
          "REFERENCE_COMPONENT_SET_INVALID",
          `Reference role ${key} must resolve once to ${expected.quantity} x ${expected.partPrefix}.`,
          affectedInputs,
          "Restore the fixed curated component role or create a separately reviewed profile revision.",
          false
        )
      );
    }
  }
  const protocolNames = new Set(profile.protocols.map((protocol) => protocol.name));
  for (const required of ["USB", "CAN", "UART", "I2C", "SPI", "SWD", "ENCODER"] as const) {
    if (!protocolNames.has(required)) {
      blockers.push(
        blockerDraft(
          "REFERENCE_PROTOCOL_MISSING",
          `Reference protocol contract ${required} is missing.`,
          affectedInputs,
          "Restore the complete v0 protocol contract.",
          false
        )
      );
    }
  }
  for (const conflict of firmwareResourceConflicts(profile)) {
    blockers.push(
      blockerDraft(
        "CONFLICTING_GLOBAL_RESOURCE_ASSIGNMENT",
        `${conflict.kind} resource ${conflict.claim} is assigned to multiple owners: ${conflict.owners.join(", ")}.`,
        affectedInputs,
        "Assign every timer, peripheral, IRQ, DMA channel, MCU pin, and normalized resource to one global owner.",
        false
      )
    );
  }
  const resetCriticalOutputs = new Set([
    "MOTOR_A_NSLEEP",
    "MOTOR_B_NSLEEP",
    "MOTOR_A_PWM",
    "MOTOR_B_PWM",
    "MOTOR_A_DIR",
    "MOTOR_B_DIR",
    "SENSOR_PWR_EN",
    "CAN_STB",
    "SPI_CS"
  ]);
  const pins = new Map<string, string>();
  const physicalPins = new Map<number, string>();
  for (const assignment of profile.pins) {
    if (
      !Number.isSafeInteger(assignment.physicalPin) ||
      assignment.physicalPin < 1 ||
      assignment.physicalPin > 48 ||
      !/^(?:P[A-F]\d{1,2})$/u.test(assignment.mcuPin)
    ) {
      blockers.push(
        blockerDraft(
          "PIN_MAP_ENTRY_INVALID",
          `${assignment.signal} has invalid LQFP48 mapping ${assignment.mcuPin}/${assignment.physicalPin}.`,
          affectedInputs,
          "Correct the pin entry against the exact curated MCU datasheet and symbol.",
          false
        )
      );
    }
    const priorSignal = pins.get(assignment.mcuPin);
    if (priorSignal !== undefined) {
      blockers.push(
        blockerDraft(
          "CONFLICTING_PIN_ASSIGNMENT",
          `${assignment.mcuPin} is assigned to both ${priorSignal} and ${assignment.signal}.`,
          affectedInputs,
          "Provide a profile with one functional assignment per MCU pin.",
          false
        )
      );
    }
    pins.set(assignment.mcuPin, assignment.signal);
    const priorPhysical = physicalPins.get(assignment.physicalPin);
    if (priorPhysical !== undefined && priorPhysical !== assignment.mcuPin) {
      blockers.push(
        blockerDraft(
          "CONFLICTING_PHYSICAL_PIN",
          `LQFP48 pin ${assignment.physicalPin} is mapped to both ${priorPhysical} and ${assignment.mcuPin}.`,
          affectedInputs,
          "Correct the package pin map against the curated STM32 source bytes.",
          false
        )
      );
    }
    physicalPins.set(assignment.physicalPin, assignment.mcuPin);
    if (resetCriticalOutputs.has(assignment.signal) && assignment.externalBias === "none") {
      blockers.push(
        blockerDraft(
          "RESET_SAFE_BIAS_MISSING",
          `${assignment.signal} is an output with a safety purpose but no declared external reset bias.`,
          affectedInputs,
          "Define and verify a hardware bias that establishes a safe state before firmware runs.",
          false
        )
      );
    }
  }
  return blockers;
};

export const backendToolIsNative = (tool: ToolIdentity): boolean =>
  tool.adapter === "kicad_cli" || tool.adapter === "kicad_mcp";

export const isSha256Identity = (identity: ContentIdentity): boolean =>
  identity.algorithm === "sha256" &&
  /^[0-9a-f]{64}$/u.test(identity.digest) &&
  Number.isSafeInteger(identity.size) &&
  identity.size >= 0;

export const isExactInputIdentity = (identity: ExactInputIdentity): boolean => {
  if ("size" in identity) {
    return isSha256Identity(identity);
  }
  return (
    identity.algorithm === "sha256" &&
    /^[0-9a-f]{64}$/u.test(identity.digest) &&
    identity.schemaVersion.length > 0 &&
    identity.canonicalizationVersion === "evleda-c14n-json-v1"
  );
};

export const isIsoDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/u.test(value) &&
  !Number.isNaN(Date.parse(value));

export const artifactsForStage = (
  context: CandidateStageContext,
  stage: StageKey
): readonly ArtifactDraft[] =>
  context.upstream.find((result) => result.stage === stage)?.artifacts ?? [];

export const inputManifestIdentity = (
  stage: StageKey,
  inputs: readonly ExactInputIdentity[]
): CanonicalIdentity =>
  canonicalIdentity(
    { stage, exactInputs: sortedIdentities(inputs) },
    `evleda.input-manifest.${stage}.v1`
  );

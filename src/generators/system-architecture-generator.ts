import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../knowledge/reference-controller-native-contract.js";
import { buildReferenceSystemArchitecture } from "../knowledge/reference-system-architecture.js";
import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import type { StageExecutor } from "../workflow/contracts.js";
import {
  artifactDraft,
  evidenceDraft,
  finalizeStageResult,
  jsonArtifactDraft,
  prerequisiteBlockers,
  profileFor,
  profileIntegrityBlockers,
  referenceEnvelopeBlockers,
  requirementsApprovalBlockers,
  stageExactInputs
} from "./draft-utils.js";

export { buildReferenceSystemArchitecture } from "../knowledge/reference-system-architecture.js";

const nativeArchitectureNets = (semanticName: string): readonly string[] => {
  const aliases = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.architectureNetAliases[semanticName];
  if (aliases === undefined || aliases.length === 0) {
    throw new Error(`The reviewed Rev-A contract does not bind architecture net ${semanticName}.`);
  }
  return aliases;
};

const architectureMarkdown = (profile: ReferenceControllerProfile): string =>
  [
    `# ${profile.boardRevision} system architecture`,
    "",
    "CANDIDATE — NOT QUALIFIED OR RELEASED",
    "",
    `Battery input (${(profile.inputVoltageMv.minimum / 1000).toString()}–${(profile.inputVoltageMv.maximum / 1000).toString()} V) reaches native VM through a surface-mount resettable PTC, reverse-polarity stage, and TVS. The LMR51420 native +5V rail feeds only the TLV75533 3.3 V regulator and TPS2553-1 sensor branch as functional IC loads. ${profile.motor.channels.toString()} DRV8874PWP bridges each target ${(profile.motor.rmsCurrentMaPerChannel / 1000).toString()} A RMS with a ${(profile.motor.currentChopMaPerChannel / 1000).toString()} A hardware current-chop setting.`,
    "",
    "The STM32G0B1CET6 owns actuation and all interfaces. TCAN3413 provides CAN, USBLC6-2SC6 protects USB, and two SN74LVC2G17 devices condition two quadrature encoders. Rev-A externally biases motor nSLEEP and sensor enable low and CAN standby high with 100-kohm resistors; motor PWM/DIR and conditioned encoder outputs do not have the previously claimed pull-down networks.",
    "",
    "A generated architecture is an engineering proposal. Component source identities, KiCad-native ERC/DRC/connectivity reports, modeled checks, and physical bring-up remain independent gates.",
    ""
  ].join("\n");

export const systemArchitectureStageExecutor: StageExecutor<"system_architecture"> = {
  stage: "system_architecture",
  async execute(context) {
    const profile = profileFor(context);
    const exactInputs = stageExactInputs(context, [
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
    ]);
    const blockers = [
      ...prerequisiteBlockers("system_architecture", context),
      ...requirementsApprovalBlockers(context),
      ...referenceEnvelopeBlockers(context, profile),
      ...profileIntegrityBlockers(profile, exactInputs)
    ];
    const structuralStatus = blockers.length === 0 ? "pass" : "fail";
    const artifacts = [
      jsonArtifactDraft({
        logicalName: "architecture/system-architecture.json",
        value: buildReferenceSystemArchitecture(profile),
        exactInputs,
        validationStatus: structuralStatus
      }),
      artifactDraft({
        logicalName: "architecture/system-architecture.md",
        mediaType: "text/markdown",
        content: architectureMarkdown(profile),
        exactInputs,
        derivedFrom: ["architecture/system-architecture.json"],
        validationStatus: structuralStatus
      })
    ];
    const evidence = [
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim:
          blockers.length === 0
            ? "The architecture matches the approved deterministic v0 envelope, binds the reviewed Rev-A native vocabulary, and contains unique MCU pin assignments."
            : "The architecture failed an approval, envelope, prerequisite, or pin-integrity gate.",
        subjectDigests: artifacts.map((artifact) => artifact.identity.digest),
        parsedArtifactLogicalName: "architecture/system-architecture.json",
        exactInputs,
        validationStatus: structuralStatus
      }),
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "The architecture is a candidate proposal and has not been electrically or physically qualified.",
        subjectDigests: artifacts.map((artifact) => artifact.identity.digest),
        exactInputs,
        validationStatus: "not_run"
      })
    ];
    return finalizeStageResult("system_architecture", artifacts, evidence, blockers);
  }
};

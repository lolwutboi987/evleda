import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { ContentIdentity, ToolIdentity } from "../domain/types.js";
import {
  REFERENCE_CONNECTIVITY_ANALYZER_ID,
  REFERENCE_CONNECTIVITY_ANALYZER_TOOL,
  REFERENCE_KICAD_REPORT_SCHEMA
} from "../integrations/reference-kicad-backend.js";
import {
  FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA,
  FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA,
  deriveFirmwareParityNodes,
  firmwareParityMappingModel,
  firmwareParityMappingModelIdentity,
  type FirmwareParityNativeNode,
  type KicadNetlistNode
} from "../knowledge/firmware-parity-model.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY
} from "../knowledge/reference-controller-native-contract.js";
import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import { buildReferenceSchematicIntent } from "../knowledge/reference-schematic-intent.js";
import type { ExactInputIdentity, StageExecutor } from "../workflow/contracts.js";
import { runKicadBackend } from "./backend-runner.js";
import { SCHEMATIC_PIN_MAP_LOGICAL_NAME } from "./firmware-parity.js";
import {
  evidenceDraft,
  expectedSourceRevisionDigest,
  finalizeStageResult,
  isExactInputIdentity,
  jsonArtifactDraft,
  prerequisiteBlockers,
  profileFor,
  profileIntegrityBlockers,
  referenceEnvelopeBlockers,
  requirementsApprovalBlockers,
  sortedIdentities,
  stageExactInputs
} from "./draft-utils.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface AnalyzedFirmwareParitySource {
  readonly status: "pass" | "unsupported";
  readonly code: string;
  readonly message: string;
  readonly pinMappings: readonly FirmwareParityNativeNode[];
  readonly reportLogicalName: string | null;
  readonly reportIdentity: ContentIdentity | null;
  readonly analyzerTool: ToolIdentity | null;
  readonly nativeNetlistLogicalName: string | null;
  readonly nativeNetlistIdentity: ContentIdentity | null;
  readonly derivation: Record<string, unknown> | null;
  readonly derivationIdentities: readonly ExactInputIdentity[];
}

const unsupportedFirmwareParitySource = (
  code: string,
  message: string,
  reportLogicalName: string | null = null
): AnalyzedFirmwareParitySource => ({
  status: "unsupported",
  code,
  message,
  pinMappings: [],
  reportLogicalName,
  reportIdentity: null,
  analyzerTool: null,
  nativeNetlistLogicalName: null,
  nativeNetlistIdentity: null,
  derivation: null,
  derivationIdentities: []
});

const asContentIdentity = (value: unknown): ContentIdentity | undefined => {
  if (!isRecord(value) || !("size" in value)) return undefined;
  const identity = value as unknown as ExactInputIdentity;
  return isExactInputIdentity(identity) ? (identity as ContentIdentity) : undefined;
};

const sameIdentity = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const approvedConnectivityAnalyzer = (tool: unknown): boolean =>
  isRecord(tool) && canonicalJson(tool) === canonicalJson(REFERENCE_CONNECTIVITY_ANALYZER_TOOL);

const analyzedFirmwareParitySource = (
  artifacts: Awaited<ReturnType<typeof runKicadBackend>>["artifacts"],
  evidence: Awaited<ReturnType<typeof runKicadBackend>>["evidence"],
  expectedSourceDigest: string,
  profile: ReferenceControllerProfile
): AnalyzedFirmwareParitySource => {
  const connectivityClaims = evidence.filter(
    (entry) =>
      entry.evidenceClass === "evleda_check" &&
      entry.parsedArtifactLogicalName !== undefined &&
      approvedConnectivityAnalyzer(entry.tool)
  );
  if (connectivityClaims.length !== 1) {
    return unsupportedFirmwareParitySource(
      "ANALYZED_PIN_MAP_REPORT_MISSING",
      "Exactly one passing evleda_check connectivity report from the approved EvlEDA analyzer is required."
    );
  }
  const connectivityClaim = connectivityClaims[0]!;
  const logicalName = connectivityClaim.parsedArtifactLogicalName!;
  const matches = artifacts.filter((artifact) => artifact.logicalName === logicalName);
  const reportArtifact = matches[0];
  const tiedEvidence =
    reportArtifact === undefined
      ? []
      : evidence.filter(
          (entry) =>
            entry.rawArtifactLogicalName === logicalName ||
            entry.parsedArtifactLogicalName === logicalName ||
            entry.subjectDigests.includes(reportArtifact.identity.digest)
        );
  if (
    matches.length !== 1 ||
    reportArtifact === undefined ||
    reportArtifact.validationStatus !== "pass" ||
    connectivityClaim.validationStatus !== "pass" ||
    !approvedConnectivityAnalyzer(reportArtifact.tool) ||
    canonicalJson(reportArtifact.tool) !== canonicalJson(connectivityClaim.tool) ||
    tiedEvidence.length !== 1 ||
    tiedEvidence[0] !== connectivityClaim ||
    connectivityClaim.rawArtifactLogicalName !== undefined ||
    canonicalJson(connectivityClaim.subjectDigests) !== canonicalJson([reportArtifact.identity.digest]) ||
    canonicalJson(connectivityClaim.exactInputs) !== canonicalJson(reportArtifact.exactInputs) ||
    contentIdentity(reportArtifact.content).digest !== reportArtifact.identity.digest ||
    contentIdentity(reportArtifact.content).size !== reportArtifact.identity.size
  ) {
    return unsupportedFirmwareParitySource(
      "ANALYZED_PIN_MAP_REPORT_INVALID",
      "The approved EvlEDA connectivity report artifact/evidence binding is missing, duplicated, misclassified, or non-passing.",
      logicalName
    );
  }
  try {
    const report = JSON.parse(Buffer.from(reportArtifact.content).toString("utf8")) as unknown;
    const payload =
      isRecord(report) && isRecord(report.payload) ? report.payload : report;
    const parity = isRecord(payload) ? payload.firmwareParity : undefined;
    const reportedNetlistIdentity =
      isRecord(payload) && isRecord(payload.schematicNetlist)
        ? payload.schematicNetlist
        : undefined;
    const derivation = isRecord(parity) ? parity.derivation : undefined;
    const nativeNetlistIdentity =
      isRecord(derivation) && isRecord(derivation.nativeNetlistIdentity)
        ? derivation.nativeNetlistIdentity
        : undefined;
    const mappingModelIdentity =
      isRecord(derivation) && isRecord(derivation.mappingModelIdentity)
        ? derivation.mappingModelIdentity
        : undefined;
    const reportedProfileIdentity =
      isRecord(parity) && isRecord(parity.profileIdentity)
        ? parity.profileIdentity
        : undefined;
    const reportAuthority = isRecord(report) ? report.authority : undefined;
    const reportAuthorityIdentity = isRecord(reportAuthority)
      ? canonicalIdentity(reportAuthority, "evleda.kicad-analyzer-report-authority.v2")
      : undefined;
    const inputBindings =
      isRecord(reportAuthority) && Array.isArray(reportAuthority.inputBindings)
        ? reportAuthority.inputBindings
        : [];
    const parsedInputBindings = inputBindings.filter(
      (binding): binding is Record<string, unknown> & {
        readonly kind: "artifact" | "native_report" | "source";
        readonly logicalName: string;
        readonly identity: ContentIdentity;
      } =>
        isRecord(binding) &&
        (binding.kind === "artifact" ||
          binding.kind === "native_report" ||
          binding.kind === "source") &&
        typeof binding.logicalName === "string" &&
        binding.logicalName.length > 0 &&
        asContentIdentity(binding.identity) !== undefined
    );
    const trustedModel = firmwareParityMappingModel(profile);
    const trustedMappingIdentity = firmwareParityMappingModelIdentity(profile);
    const trustedProfileIdentity = canonicalIdentity(profile, "evleda.reference-profile.v1");
    const exactNativeNetlistIdentity = asContentIdentity(nativeNetlistIdentity);
    const nativeNetlistBindings = parsedInputBindings.filter(
      (binding) =>
        binding.kind === "native_report" &&
        exactNativeNetlistIdentity !== undefined &&
        sameIdentity(binding.identity, exactNativeNetlistIdentity)
    );
    const nativeNetlistBinding = nativeNetlistBindings[0];
    const nativeNetlistArtifacts =
      nativeNetlistBinding === undefined
        ? []
        : artifacts.filter(
            (artifact) => artifact.logicalName === nativeNetlistBinding.logicalName
          );
    const nativeNetlistArtifact = nativeNetlistArtifacts[0];
    const nativeNetlistEvidence =
      nativeNetlistArtifact === undefined
        ? []
        : evidence.filter(
            (entry) =>
              entry.rawArtifactLogicalName === nativeNetlistArtifact.logicalName ||
              entry.parsedArtifactLogicalName === nativeNetlistArtifact.logicalName ||
              entry.subjectDigests.includes(nativeNetlistArtifact.identity.digest)
          );
    const expectedDerivedFrom = [
      ...new Set(
        parsedInputBindings
          .filter((binding) => binding.kind !== "source")
          .map((binding) => binding.logicalName)
      )
    ].sort((left, right) => left.localeCompare(right, "en"));
    const bindingKeys = parsedInputBindings.map(
      (binding) => `${binding.kind}:${binding.logicalName}`
    );
    const nativeNodes =
      isRecord(parity) && Array.isArray(parity.nativeNodes)
        ? parity.nativeNodes.filter(
            (node): node is FirmwareParityNativeNode =>
              isRecord(node) &&
              typeof node.signal === "string" &&
              typeof node.reference === "string" &&
              Number.isSafeInteger(node.physicalPin) &&
              typeof node.mcuPin === "string" &&
              typeof node.pinFunction === "string" &&
              typeof node.pinType === "string" &&
              typeof node.nativeNetName === "string"
          )
        : [];
    const netlistNodes: readonly KicadNetlistNode[] = nativeNodes.map((node) => ({
      reference: node.reference,
      pin: node.physicalPin.toString(),
      pinFunction: node.pinFunction,
      pinType: node.pinType,
      netName: node.nativeNetName
    }));
    const trustedDerivation = deriveFirmwareParityNodes(netlistNodes, profile);
    if (
      isRecord(parity) &&
      parity.schemaVersion === FIRMWARE_PARITY_NATIVE_SOURCE_SCHEMA &&
      parity.nativeNodeLevel === true &&
      parity.sourceRevisionDigest === expectedSourceDigest &&
      parity.profileId === profile.profileId &&
      parity.boardRevision === profile.boardRevision &&
      reportedProfileIdentity !== undefined &&
      sameIdentity(reportedProfileIdentity, trustedProfileIdentity) &&
      isRecord(report) &&
      report.schemaVersion === REFERENCE_KICAD_REPORT_SCHEMA &&
      report.kind === "connectivity" &&
      report.validationStatus === "pass" &&
      report.sourceRevisionDigest === expectedSourceDigest &&
      isRecord(reportAuthority) &&
      reportAuthority.kind === "evleda_analyzer" &&
      reportAuthority.analyzerId === REFERENCE_CONNECTIVITY_ANALYZER_ID &&
      approvedConnectivityAnalyzer(reportAuthority.tool) &&
      reportAuthorityIdentity !== undefined &&
      reportArtifact.exactInputs.some((identity) =>
        sameIdentity(identity, reportAuthorityIdentity)
      ) &&
      parsedInputBindings.length === inputBindings.length &&
      new Set(bindingKeys).size === bindingKeys.length &&
      canonicalJson(reportArtifact.derivedFrom) === canonicalJson(expectedDerivedFrom) &&
      parsedInputBindings.every((binding) =>
        reportArtifact.exactInputs.some((identity) => sameIdentity(identity, binding.identity))
      ) &&
      reportArtifact.exactInputs.some((identity) => sameIdentity(identity, trustedProfileIdentity)) &&
      isRecord(derivation) &&
      derivation.method === "kicad-netlist-nodes-plus-pinned-mcu-capabilities" &&
      exactNativeNetlistIdentity !== undefined &&
      exactNativeNetlistIdentity.size > 0 &&
      mappingModelIdentity !== undefined &&
      !("size" in mappingModelIdentity) &&
      isExactInputIdentity(mappingModelIdentity as unknown as ExactInputIdentity) &&
      mappingModelIdentity.schemaVersion === FIRMWARE_PARITY_MAPPING_MODEL_SCHEMA &&
      canonicalJson(mappingModelIdentity) === canonicalJson(trustedMappingIdentity) &&
      reportedNetlistIdentity !== undefined &&
      sameIdentity(reportedNetlistIdentity, exactNativeNetlistIdentity) &&
      nativeNetlistBindings.length === 1 &&
      nativeNetlistArtifact !== undefined &&
      nativeNetlistArtifacts.length === 1 &&
      nativeNetlistArtifact.validationStatus === "pass" &&
      nativeNetlistArtifact.tool.adapter === "kicad_cli" &&
      sameIdentity(nativeNetlistArtifact.identity, exactNativeNetlistIdentity) &&
      sameIdentity(contentIdentity(nativeNetlistArtifact.content), exactNativeNetlistIdentity) &&
      nativeNetlistEvidence.length === 1 &&
      nativeNetlistEvidence[0]!.evidenceClass === "kicad_native" &&
      nativeNetlistEvidence[0]!.parsedArtifactLogicalName === undefined &&
      nativeNetlistEvidence[0]!.validationStatus === "pass" &&
      sameIdentity(nativeNetlistEvidence[0]!.tool, nativeNetlistArtifact.tool) &&
      canonicalJson(nativeNetlistEvidence[0]!.subjectDigests) ===
        canonicalJson([exactNativeNetlistIdentity.digest]) &&
      canonicalJson(nativeNetlistEvidence[0]!.exactInputs) ===
        canonicalJson(nativeNetlistArtifact.exactInputs) &&
      Array.isArray(parity.nativeNodes) &&
      nativeNodes.length === parity.nativeNodes.length &&
      nativeNodes.length === trustedModel.pins.length &&
      trustedDerivation.findings.length === 0 &&
      canonicalJson(nativeNodes) === canonicalJson(trustedDerivation.nodes) &&
      trustedModel.missingSignalMappings.length === 0
    ) {
      return {
        status: "pass",
        code: "ANALYZED_PIN_MAP_REPORT_ACCEPTED",
        message:
          "Approved EvlEDA connectivity analysis proves the native MCU reference, physical pin, function, type, and net mapping for each firmware signal.",
        pinMappings: trustedDerivation.nodes,
        reportLogicalName: logicalName,
        reportIdentity: reportArtifact.identity,
        analyzerTool: reportArtifact.tool,
        nativeNetlistLogicalName: nativeNetlistArtifact.logicalName,
        nativeNetlistIdentity: exactNativeNetlistIdentity,
        derivation: {
          method: "kicad-netlist-nodes-plus-pinned-mcu-capabilities",
          nativeNetlistIdentity: exactNativeNetlistIdentity,
          mappingModelIdentity: trustedMappingIdentity
        },
        derivationIdentities: [
          reportArtifact.identity,
          exactNativeNetlistIdentity,
          mappingModelIdentity as unknown as ExactInputIdentity
        ]
      };
    }
  } catch {
    // Return the deterministic unsupported result below without parser-specific text.
  }
  return unsupportedFirmwareParitySource(
    "ANALYZED_PIN_MAP_NORMALIZATION_UNSUPPORTED",
    "Approved EvlEDA connectivity evidence does not contain a valid evleda.kicad-firmware-parity-source.v1 payload bound to exact kicad_native netlist bytes and exact profile/mapping-model identities.",
    logicalName
  );
};

export const schematicStageExecutor: StageExecutor<"schematic"> = {
  stage: "schematic",
  async execute(context) {
    const profile = profileFor(context);
    const exactInputs = stageExactInputs(context, [
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
    ]);
    const initialBlockers = [
      ...prerequisiteBlockers("schematic", context),
      ...requirementsApprovalBlockers(context),
      ...referenceEnvelopeBlockers(context, profile),
      ...profileIntegrityBlockers(profile, exactInputs)
    ];
    const intent = jsonArtifactDraft({
      logicalName: "schematic/schematic-intent.json",
      value: buildReferenceSchematicIntent(
        profile,
        context.requirements.identity.digest,
        context.designRevisionId
      ),
      exactInputs,
      validationStatus: "not_run"
    });
    const initialEvidence = [
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "Schematic intent includes the v0 circuits and invariants but is not KiCad-native evidence.",
        subjectDigests: [intent.identity.digest],
        parsedArtifactLogicalName: intent.logicalName,
        exactInputs,
        validationStatus: "not_run"
      })
    ];
    const backend = await runKicadBackend({
      stage: "schematic",
      context,
      profile,
      exactInputs,
      initialArtifacts: [intent],
      initialEvidence,
      initialBlockers,
      requiredArtifactRoles: ["project", "schematic"],
      requiredReports: ["erc", "connectivity"]
    });
    const nativeArtifacts = backend.artifacts.filter(
      (artifact) => artifact.tool.adapter === "kicad_cli" || artifact.tool.adapter === "kicad_mcp"
    );
    const nativeEvidence = backend.evidence.filter(
      (entry) => entry.evidenceClass === "kicad_native"
    );
    const schematicSourceRevisionDigest = expectedSourceRevisionDigest("schematic", exactInputs);
    const normalizedParity = analyzedFirmwareParitySource(
      backend.artifacts,
      backend.evidence,
      schematicSourceRevisionDigest,
      profile
    );
    const pinMapStatus =
      backend.blockers.length > 0 ? "fail" : normalizedParity.status;
    const pinMapInputs = sortedIdentities([
      ...exactInputs,
      ...nativeArtifacts.map((artifact) => artifact.identity),
      ...normalizedParity.derivationIdentities
    ]);
    const pinMap = jsonArtifactDraft({
      logicalName: SCHEMATIC_PIN_MAP_LOGICAL_NAME,
      value: {
        schemaVersion: "evleda.generated-schematic-pin-map.v2",
        classification: "candidate-only",
        lifecycle: "candidate",
        releaseAuthorized: false,
        qualificationEstablished: false,
        projectId: context.projectId,
        runId: context.runId,
        designRevisionId: context.designRevisionId,
        profileId: profile.profileId,
        boardRevision: profile.boardRevision,
        requirementsIdentity: context.requirements.identity,
        profileIdentity: canonicalIdentity(profile, "evleda.reference-profile.v1"),
        schematicSourceRevisionDigest,
        normalization: {
          status: pinMapStatus,
          code:
            backend.blockers.length > 0
              ? "KICAD_SCHEMATIC_BOUNDARY_BLOCKED"
              : normalizedParity.code,
          message:
            backend.blockers.length > 0
              ? "KiCad schematic generation or required native checks are blocked."
              : normalizedParity.message,
          sourceReportLogicalName: normalizedParity.reportLogicalName,
          sourceReportIdentity: normalizedParity.reportIdentity,
          analyzerId:
            normalizedParity.analyzerTool === null
              ? null
              : REFERENCE_CONNECTIVITY_ANALYZER_ID,
          analyzerTool: normalizedParity.analyzerTool,
          nativeNetlistLogicalName: normalizedParity.nativeNetlistLogicalName,
          nativeNetlistIdentity: normalizedParity.nativeNetlistIdentity,
          derivation: normalizedParity.derivation
        },
        pinMappings: normalizedParity.pinMappings,
        validationBoundaries: {
          nativeMcuPinMapping: {
            machineStatus:
              pinMapStatus === "pass"
                ? "PASS"
                : pinMapStatus === "unsupported"
                  ? "UNKNOWN"
                  : "FAIL",
            scope:
              "Native MCU signal, reference, physical pin, MCU pin, pin function, pin type, and native net mapping only."
          },
          resetBiasImplementation: {
            machineStatus: "NOT_RUN",
            reason:
              "No separately bound topology-derived reset-bias inspection is part of this pin-map artifact."
          },
          protocolImplementation: {
            machineStatus: "NOT_RUN",
            reason:
              "Native connectivity does not prove protocol configuration or runtime behavior."
          },
          resourceImplementation: {
            machineStatus: "NOT_RUN",
            reason:
              "Native connectivity does not prove timer, IRQ, DMA, or runtime resource configuration."
          }
        },
        nativeArtifactBindings: nativeArtifacts.map((artifact) => ({
          logicalName: artifact.logicalName,
          identity: artifact.identity,
          validationStatus: artifact.validationStatus,
          tool: artifact.tool
        })),
        nativeEvidenceBindings: nativeEvidence.map((entry) => ({
          evidenceClass: entry.evidenceClass,
          subjectDigests: entry.subjectDigests,
          ...(entry.rawArtifactLogicalName === undefined
            ? {}
            : { rawArtifactLogicalName: entry.rawArtifactLogicalName }),
          ...(entry.parsedArtifactLogicalName === undefined
            ? {}
            : { parsedArtifactLogicalName: entry.parsedArtifactLogicalName }),
          validationStatus: entry.validationStatus,
          tool: entry.tool
        })),
        limitations: [
          "This is candidate-only generated consistency evidence, not safety, qualification, fabrication, or manufacturing-release evidence.",
          "A pass is limited to source-proven native MCU pin mapping from the exact approved EvlEDA connectivity analyzer and direct kicad_native netlist bytes.",
          "Reset-bias networks, protocol implementation, and timer, IRQ, DMA, or other resource implementation remain NOT_RUN unless separately inspected and bound."
        ]
      },
      exactInputs: pinMapInputs,
      derivedFrom: [
        intent.logicalName,
        ...nativeArtifacts.map((artifact) => artifact.logicalName),
        ...(normalizedParity.reportLogicalName === null
          ? []
          : [normalizedParity.reportLogicalName])
      ],
      validationStatus: pinMapStatus
    });
    const pinMapEvidence = evidenceDraft({
      evidenceClass: "evleda_check",
      claim:
        pinMapStatus === "pass"
          ? "Candidate-only native MCU pin mapping from the approved EvlEDA analyzer is bound to exact passing kicad_native netlist bytes."
          : pinMapStatus === "unsupported"
            ? "Generated schematic pin-map parity is unsupported because approved analyzer output lacks exact native node-level provenance."
            : "Generated pin-map binding is non-passing because the exact KiCad schematic generation/check boundary is blocked.",
      subjectDigests: [
        pinMap.identity.digest,
        ...(normalizedParity.reportIdentity === null
          ? []
          : [normalizedParity.reportIdentity.digest]),
        ...nativeArtifacts.map((artifact) => artifact.identity.digest)
      ],
      parsedArtifactLogicalName: pinMap.logicalName,
      exactInputs: pinMapInputs,
      validationStatus: pinMapStatus
    });
    return finalizeStageResult(
      "schematic",
      [...backend.artifacts, pinMap],
      [...backend.evidence, pinMapEvidence],
      backend.blockers
    );
  }
};

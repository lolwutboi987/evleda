import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { StageKey } from "../domain/stages.js";
import type { CanonicalIdentity, ContentIdentity, ToolIdentity, ValidationStatus } from "../domain/types.js";
import type { ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import { validateAndSnapshotEngineeringConstraintBinding } from "../engineering/constraint-compiler.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
} from "../knowledge/pcb-engineering-practices.js";
import {
  REFERENCE_KICAD_ANALYZER_TOOLS,
  REFERENCE_KICAD_REPORT_SCHEMA,
  referenceKicadRequestBinding,
} from "../integrations/reference-kicad-backend.js";
import {
  PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS,
  analyzeKicadPcbPractices,
  type PcbPracticeAnalysis,
} from "../integrations/pcb-practice-analyzer.js";
import {
  KICAD_NATIVE_REPORT_COMMAND_PREFIXES,
  buildKicadPcbEngineeringDecisionSummary,
} from "../workflow/contracts.js";
import type {
  ArtifactDraft,
  BlockerDraft,
  CandidateStageContext,
  EvidenceDraft,
  ExactInputIdentity,
  KicadArtifactRole,
  KicadBackendReport,
  KicadBackendRequest,
  KicadBackendStage,
  KicadEvledaCheckReport,
  KicadGeneratedArtifact,
  KicadNativeReport,
  KicadNativeReportKind,
  KicadPcbEngineeringRequest,
  KicadPcbSnapshotBinding,
  KicadReportBinding,
  KicadReportInputBinding,
  KicadReportKind,
  SimulationCoverageItem
} from "../workflow/contracts.js";
import {
  artifactDraft,
  backendToolIsNative,
  blockerDraft,
  evidenceDraft,
  expectedSourceRevisionDigest,
  isExactInputIdentity,
  isSha256Identity,
  sortedIdentities,
  upstreamArtifactIdentities
} from "./draft-utils.js";

export interface BackendRunDrafts {
  readonly artifacts: readonly ArtifactDraft[];
  readonly evidence: readonly EvidenceDraft[];
  readonly blockers: readonly BlockerDraft[];
}

interface KicadRunOptions {
  readonly stage: KicadBackendStage;
  readonly context: CandidateStageContext;
  readonly profile: ReferenceControllerProfile;
  readonly exactInputs: readonly ExactInputIdentity[];
  readonly initialArtifacts: readonly ArtifactDraft[];
  readonly initialEvidence?: readonly EvidenceDraft[];
  readonly initialBlockers: readonly BlockerDraft[];
  readonly requiredArtifactRoles: readonly KicadArtifactRole[];
  readonly requiredReports: readonly KicadReportKind[];
  readonly pcbEngineering?: KicadPcbEngineeringRequest;
}

const invalidBackendResult = (
  code: string,
  message: string,
  inputs: readonly ExactInputIdentity[],
  action: string
): BlockerDraft => blockerDraft(code, message, inputs, action);

const safeLogicalName = (value: string): boolean => {
  if (
    value.length === 0 ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\u0000-\u001f]/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

const requiredEvidenceClass = (
  kind: KicadReportKind
): KicadBackendReport["evidenceClass"] =>
  Object.hasOwn(KICAD_NATIVE_REPORT_COMMAND_PREFIXES, kind)
    ? "kicad_native"
    : "evleda_check";

const REQUIRED_DERIVED_ARTIFACT_ROLE: Readonly<
  Partial<Record<KicadReportKind, KicadArtifactRole>>
> = Object.freeze({
  geometry: "pcb",
  pcb_practices: "pcb",
  bom_parity: "bom",
  bom_export: "bom",
  gerber_export: "gerber",
  drill_export: "drill",
  position_export: "position",
  cam_manifest: "cam_manifest"
});

const REQUIRED_DERIVED_NATIVE_REPORTS: Readonly<
  Partial<Record<KicadReportKind, readonly KicadNativeReportKind[]>>
> = Object.freeze({
  connectivity: ["schematic_netlist"],
  schematic_parity: ["drc"],
  geometry: ["board_statistics"],
  pcb_practices: ["drc", "board_statistics"],
  bom_parity: ["schematic_netlist", "board_netlist"],
  bom_export: ["drc"],
  gerber_export: ["drc"],
  drill_export: ["drc"],
  position_export: ["drc"],
  cam_manifest: ["drc", "board_statistics"]
});

const sameIdentity = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === right.algorithm && left.digest === right.digest && left.size === right.size;

const sameExactIdentity = (left: ExactInputIdentity, right: ExactInputIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const exactInputsContain = (
  identities: readonly ExactInputIdentity[],
  expected: ExactInputIdentity,
): boolean => identities.some((identity) => sameExactIdentity(identity, expected));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalSnapshotIdentity = (document: unknown): CanonicalIdentity | null => {
  if (!isRecord(document) || typeof document.schemaVersion !== "string") return null;
  const {
    identity: _identity,
    captureIdentity: _captureIdentity,
    ...payload
  } = document;
  return canonicalIdentity(
    "identity" in document || "captureIdentity" in document ? payload : document,
    document.schemaVersion,
  );
};

const snapshotBindingValid = (
  snapshot: KicadPcbSnapshotBinding<unknown>,
  initialArtifacts: readonly ArtifactDraft[],
  exactInputs: readonly ExactInputIdentity[],
): boolean => {
  const canonical = canonicalSnapshotIdentity(snapshot.document);
  const bytes = Buffer.from(`${canonicalJson(snapshot.document)}\n`, "utf8");
  const content = contentIdentity(bytes);
  const matchingArtifacts = initialArtifacts.filter(
    (artifact) => artifact.logicalName === snapshot.logicalName,
  );
  const embeddedIdentity = isRecord(snapshot.document) && "identity" in snapshot.document
    ? snapshot.document.identity
    : undefined;
  return (
    safeLogicalName(snapshot.logicalName) &&
    bytes.byteLength <= 4_194_304 &&
    canonical !== null &&
    sameExactIdentity(canonical, snapshot.canonicalIdentity) &&
    (embeddedIdentity === undefined ||
      canonicalJson(embeddedIdentity) === canonicalJson(snapshot.canonicalIdentity)) &&
    sameIdentity(content, snapshot.contentIdentity) &&
    matchingArtifacts.length === 1 &&
    matchingArtifacts[0]!.mediaType === "application/json" &&
    Buffer.from(matchingArtifacts[0]!.content).equals(bytes) &&
    sameIdentity(matchingArtifacts[0]!.identity, snapshot.contentIdentity) &&
    exactInputsContain(exactInputs, snapshot.contentIdentity) &&
    exactInputsContain(exactInputs, snapshot.canonicalIdentity)
  );
};

const routePolicyCaptureValid = (
  snapshot: KicadPcbEngineeringRequest["routeQualityPolicy"],
): boolean => {
  if (!isRecord(snapshot.document)) return false;
  const {
    identity: _identity,
    captureIdentity: _captureIdentity,
    ...payload
  } = snapshot.document;
  return sameIdentity(
    contentIdentity(Buffer.from(`${canonicalJson(payload)}\n`, "utf8")),
    snapshot.captureIdentity,
  );
};

const pcbEngineeringRequestError = (
  binding: KicadPcbEngineeringRequest,
  initialArtifacts: readonly ArtifactDraft[],
  exactInputs: readonly ExactInputIdentity[],
  profile: ReferenceControllerProfile,
): string | null => {
  try {
    const catalog = validateAndSnapshotPcbEngineeringPracticeCatalog(
      binding.practiceCatalog.document,
    );
    const planBytes = Buffer.from(`${canonicalJson(binding.layoutPlan.document)}\n`, "utf8");
    const recomputedPlanIdentity = contentIdentity(planBytes);
    const planArtifact = initialArtifacts.filter(
      (artifact) => artifact.logicalName === binding.layoutPlan.logicalName,
    );
    const practiceBinding = isRecord(binding.layoutPlan.document.practiceBinding)
      ? binding.layoutPlan.document.practiceBinding
      : undefined;
    if (
      !safeLogicalName(binding.layoutPlan.logicalName) ||
      binding.layoutPlan.document.schemaVersion !== "evleda.pcb-layout-plan.v2" ||
      binding.layoutPlan.document.profileId !== profile.profileId ||
      binding.layoutPlan.document.boardRevision !== profile.boardRevision ||
      binding.layoutPlan.document.lifecycle !== "candidate" ||
      binding.layoutPlan.document.releaseAuthorized !== false ||
      practiceBinding === undefined ||
      !isExactInputIdentity(
        practiceBinding.catalogIdentity as ExactInputIdentity,
      ) ||
      !sameExactIdentity(
        practiceBinding.catalogIdentity as ExactInputIdentity,
        binding.practiceCatalog.canonicalIdentity,
      ) ||
      !sameIdentity(recomputedPlanIdentity, binding.layoutPlan.contentIdentity) ||
      planArtifact.length !== 1 ||
      planArtifact[0]!.mediaType !== "application/json" ||
      !sameIdentity(contentIdentity(planArtifact[0]!.content), planArtifact[0]!.identity) ||
      !sameIdentity(planArtifact[0]!.identity, binding.layoutPlan.contentIdentity) ||
      !Buffer.from(planArtifact[0]!.content).equals(planBytes) ||
      !snapshotBindingValid(binding.analyzerProfile, initialArtifacts, exactInputs) ||
      !snapshotBindingValid(binding.practiceCatalog, initialArtifacts, exactInputs) ||
      !snapshotBindingValid(binding.routeQualityPolicy, initialArtifacts, exactInputs) ||
      !snapshotBindingValid(binding.routeQualityRuleDeck, initialArtifacts, exactInputs) ||
      !snapshotBindingValid(binding.proofFixturePolicy, initialArtifacts, exactInputs) ||
      binding.analyzerProfile.document.sourceValidation.mode !== "production" ||
      binding.analyzerProfile.document.sourceValidation.supportedBoardVersions.length === 0 ||
      binding.analyzerProfile.document.sourceValidation.supportedBoardVersions.some(
        (version) =>
          !(PCB_PRACTICE_ANALYZER_SUPPORTED_BOARD_VERSIONS as readonly number[]).includes(version),
      ) ||
      !sameExactIdentity(catalog.identity, binding.practiceCatalog.canonicalIdentity) ||
      !sameExactIdentity(
        PCB_ENGINEERING_PRACTICE_CATALOG.identity,
        binding.practiceCatalog.canonicalIdentity,
      ) ||
      canonicalJson(binding.routeQualityPolicy.captureIdentity) !==
        canonicalJson(binding.routeQualityPolicy.document.captureIdentity) ||
      !routePolicyCaptureValid(binding.routeQualityPolicy) ||
      !exactInputsContain(exactInputs, binding.routeQualityPolicy.captureIdentity) ||
      !exactInputsContain(exactInputs, binding.layoutPlan.contentIdentity)
    ) {
      return "PCB engineering request identities do not reproduce from the exact plan artifact, analyzer profile, and practice catalog.";
    }
    if (binding.engineeringConstraintBinding !== null) {
      const trustedConstraintBinding = validateAndSnapshotEngineeringConstraintBinding(
        binding.engineeringConstraintBinding.document,
      );
      if (
        canonicalJson(trustedConstraintBinding) !==
          canonicalJson(binding.engineeringConstraintBinding.document) ||
        !snapshotBindingValid(
          binding.engineeringConstraintBinding,
          initialArtifacts,
          exactInputs,
        ) ||
        !sameExactIdentity(
          trustedConstraintBinding.catalogIdentity,
          binding.practiceCatalog.canonicalIdentity,
        ) ||
        !sameExactIdentity(
          trustedConstraintBinding.identity,
          binding.engineeringConstraintBinding.canonicalIdentity,
        ) ||
        !exactInputsContain(
          exactInputs,
          trustedConstraintBinding.compiledConstraintSetIdentity,
        )
      ) {
        return "Engineering constraint binding is stale, self-attested, or detached from its exact catalog/context/checker-evidence recompile closure.";
      }
    }
    return null;
  } catch {
    return "PCB engineering request contains a malformed or non-reproducible bound document.";
  }
};

const sameToolIdentity = (left: ToolIdentity, right: ToolIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const validToolIdentity = (tool: ToolIdentity): boolean =>
  tool.name.length > 0 && tool.version.length > 0;

const validBinding = (binding: KicadReportBinding): boolean =>
  safeLogicalName(binding.logicalName) && isSha256Identity(binding.identity);

const bindingKey = (binding: KicadReportBinding): string =>
  `${binding.logicalName}:${binding.identity.algorithm}:${binding.identity.digest}:${binding.identity.size}`;

const uniqueBindings = (bindings: readonly KicadReportBinding[]): boolean =>
  new Set(bindings.map(bindingKey)).size === bindings.length;

const commandMatches = (command: readonly string[], prefix: readonly string[]): boolean =>
  command.length > prefix.length && prefix.every((part, index) => command[index] === part);

const commandDeclaresOutput = (command: readonly string[]): boolean => {
  const outputIndex = command.indexOf("--output");
  return outputIndex >= 0 && outputIndex + 1 < command.length && command[outputIndex + 1]!.length > 0;
};

const authorityInputs = (report: KicadBackendReport): readonly ExactInputIdentity[] => [
  ...(report.evidenceClass === "kicad_native"
    ? report.authority.sourceBindings.map((binding) => binding.identity)
    : report.authority.inputBindings.map((binding) => binding.identity)),
  canonicalIdentity(
    report.authority,
    report.evidenceClass === "kicad_native"
      ? "evleda.kicad-cli-report-authority.v2"
      : "evleda.kicad-analyzer-report-authority.v2"
  )
];

const authorityDerivedFrom = (report: KicadBackendReport): readonly string[] =>
  report.evidenceClass === "evleda_check"
    ? report.authority.inputBindings
        .filter((binding) => binding.kind !== "source")
        .map((binding) => binding.logicalName)
    : [];

const parsedPcbPracticeAnalysis = (
  report: KicadEvledaCheckReport,
  request: KicadBackendRequest,
  generatedArtifacts: readonly KicadGeneratedArtifact[],
): PcbPracticeAnalysis | null => {
  try {
    const engineering = request.pcbEngineering;
    if (
      engineering === null ||
      report.kind !== "pcb_practices" ||
      report.mediaType !== "application/json" ||
      report.content.byteLength > 67_108_864 ||
      !sameToolIdentity(
        report.authority.tool,
        REFERENCE_KICAD_ANALYZER_TOOLS.pcb_practices,
      )
    ) {
      return null;
    }
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(report.content),
    ) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.authority) || !isRecord(parsed.payload)) {
      return null;
    }
    const snapshotReference = (snapshot: KicadPcbSnapshotBinding<unknown>) => ({
      logicalName: snapshot.logicalName,
      contentIdentity: snapshot.contentIdentity,
      canonicalIdentity: snapshot.canonicalIdentity,
    });
    const expectedEngineeringInputs = {
      layoutPlan: {
        logicalName: engineering.layoutPlan.logicalName,
        contentIdentity: engineering.layoutPlan.contentIdentity,
      },
      analyzerProfile: snapshotReference(engineering.analyzerProfile),
      practiceCatalog: snapshotReference(engineering.practiceCatalog),
      routeQualityPolicy: {
        ...snapshotReference(engineering.routeQualityPolicy),
        captureIdentity: engineering.routeQualityPolicy.captureIdentity,
      },
      routeQualityRuleDeck: snapshotReference(engineering.routeQualityRuleDeck),
      proofFixturePolicy: snapshotReference(engineering.proofFixturePolicy),
      engineeringConstraintBinding:
        engineering.engineeringConstraintBinding === null
          ? null
          : {
              ...snapshotReference(engineering.engineeringConstraintBinding),
              compiledConstraintSetIdentity:
                engineering.engineeringConstraintBinding.document
                  .compiledConstraintSetIdentity,
            },
    };
    if (
      parsed.schemaVersion !== REFERENCE_KICAD_REPORT_SCHEMA ||
      parsed.kind !== "pcb_practices" ||
      parsed.validationStatus !== report.validationStatus ||
      parsed.releaseAuthorized !== false ||
      parsed.sourceRevisionDigest !== report.sourceRevisionDigest ||
      canonicalJson(parsed.requestBinding) !==
        canonicalJson(referenceKicadRequestBinding(request)) ||
      canonicalJson(parsed.authority) !== canonicalJson(report.authority) ||
      canonicalJson(parsed.payload.engineeringInputs) !==
        canonicalJson(expectedEngineeringInputs)
    ) {
      return null;
    }
    const pcbArtifacts = generatedArtifacts.filter((artifact) => artifact.role === "pcb");
    if (pcbArtifacts.length !== 1) return null;
    const pcbArtifact = pcbArtifacts[0]!;
    const pcbIdentity = contentIdentity(pcbArtifact.content);
    const evaluatedPcbSourceBindings = report.authority.inputBindings.filter(
      (binding) =>
        binding.kind === "source" &&
        binding.logicalName.toLocaleLowerCase("en-US").endsWith(".kicad_pcb") &&
        sameIdentity(binding.identity, pcbIdentity),
    );
    if (evaluatedPcbSourceBindings.length !== 1) return null;
    const requiredArtifactBindings = [
      { logicalName: pcbArtifact.logicalName, identity: pcbIdentity },
      {
        logicalName: engineering.layoutPlan.logicalName,
        identity: engineering.layoutPlan.contentIdentity,
      },
      ...[
        engineering.analyzerProfile,
        engineering.practiceCatalog,
        engineering.routeQualityPolicy,
        engineering.routeQualityRuleDeck,
        engineering.proofFixturePolicy,
        ...(engineering.engineeringConstraintBinding === null
          ? []
          : [engineering.engineeringConstraintBinding]),
      ].map((snapshot) => ({
        logicalName: snapshot.logicalName,
        identity: snapshot.contentIdentity,
      })),
    ];
    if (
      requiredArtifactBindings.some(({ logicalName, identity }) =>
        report.authority.inputBindings.filter(
          (binding) =>
            binding.kind === "artifact" &&
            binding.logicalName === logicalName &&
            sameIdentity(binding.identity, identity),
        ).length !== 1
      )
    ) {
      return null;
    }
    const recomputed = analyzeKicadPcbPractices(
      pcbArtifact.content,
      engineering.analyzerProfile.document,
      { sourcePath: pcbArtifact.logicalName },
    );
    const decisionSummary = buildKicadPcbEngineeringDecisionSummary(
      recomputed,
      engineering.engineeringConstraintBinding?.document ?? null,
    );
    const analysisIdentity = canonicalIdentity(recomputed, recomputed.schemaVersion);
    const expectedValidationStatus =
      decisionSummary.machine.status === "pass" ? "pass" : "fail";
    return report.validationStatus === expectedValidationStatus &&
      canonicalJson(recomputed) === canonicalJson(parsed.payload.analysis) &&
      canonicalJson(analysisIdentity) === canonicalJson(parsed.payload.analysisIdentity) &&
      canonicalJson(decisionSummary) === canonicalJson(parsed.payload.engineeringSummary)
      ? recomputed
      : null;
  } catch {
    return null;
  }
};

export const runKicadBackend = async (
  options: KicadRunOptions
): Promise<BackendRunDrafts> => {
  const artifacts: ArtifactDraft[] = [...options.initialArtifacts];
  const evidence: EvidenceDraft[] = [...(options.initialEvidence ?? [])];
  const blockers: BlockerDraft[] = [...options.initialBlockers];
  if (blockers.length > 0) {
    return { artifacts, evidence, blockers };
  }
  const pcbEngineeringError =
    options.stage === "pcb_placement_routing"
      ? options.pcbEngineering === undefined
        ? "PCB placement/routing requires exact phase-1 engineering-analysis inputs."
        : pcbEngineeringRequestError(
            options.pcbEngineering,
            options.initialArtifacts,
            options.exactInputs,
            options.profile,
          )
      : options.pcbEngineering === undefined
        ? null
        : "PCB engineering-analysis inputs are only valid for the PCB placement/routing stage.";
  if (pcbEngineeringError !== null) {
    blockers.push(
      blockerDraft(
        "PCB_ENGINEERING_REQUEST_INVALID",
        pcbEngineeringError,
        options.exactInputs,
        "Rebuild the v2 KiCad request from the exact current layout-plan bytes, analyzer profile, practice catalog, and any full recompile-validated engineering constraint binding, then rerun.",
        false,
      ),
    );
    return { artifacts, evidence, blockers };
  }
  const backend = options.context.kicadBackend;
  if (backend === undefined) {
    blockers.push(
      blockerDraft(
        "KICAD_BACKEND_MISSING",
        `No KiCad generation backend is available for ${options.stage}.`,
        options.exactInputs,
        "Configure a constrained KiCad CLI or KiCad MCP backend and rerun the stage."
      )
    );
    return { artifacts, evidence, blockers };
  }

  const expectedDigest = expectedSourceRevisionDigest(options.stage, options.exactInputs);
  const request: KicadBackendRequest = {
    schemaVersion: "evleda.kicad-request.v2",
    stage: options.stage,
    expectedSourceRevisionDigest: expectedDigest,
    profile: structuredClone(options.profile),
    requirements: structuredClone(options.context.requirements),
    upstreamArtifactIdentities: structuredClone(upstreamArtifactIdentities(options.context)),
    pcbEngineering:
      options.stage === "pcb_placement_routing"
        ? structuredClone(options.pcbEngineering!)
        : null,
  };
  let result;
  try {
    result = await backend.execute(structuredClone(request));
  } catch {
    blockers.push(
      blockerDraft(
        "KICAD_BACKEND_EXECUTION_FAILED",
        `KiCad backend ${backend.backendId} failed without a valid typed result.`,
        options.exactInputs,
        "Inspect the captured backend invocation, correct the tool failure, and rerun against the same immutable inputs."
      )
    );
    return { artifacts, evidence, blockers };
  }

  const resultSchemaValid =
    result.schemaVersion === "evleda.kicad-result.v2" && result.stage === options.stage;
  if (!resultSchemaValid) {
    blockers.push(
      invalidBackendResult(
        "KICAD_BACKEND_RESULT_INVALID",
        `KiCad backend ${backend.backendId} returned an incompatible stage result.`,
        options.exactInputs,
        "Update the backend adapter to return the authority-discriminated v2 result schema for the requested stage."
      )
    );
  }
  const resultToolValid = backendToolIsNative(result.tool);
  if (!resultToolValid) {
    blockers.push(
      invalidBackendResult(
        "KICAD_TOOL_IDENTITY_INVALID",
        "KiCad-native artifacts must identify a kicad_cli or kicad_mcp tool adapter.",
        options.exactInputs,
        "Return the exact KiCad tool/adapter identity that generated and checked the files."
      )
    );
  }
  const resultSourceValid = result.sourceRevisionDigest === expectedDigest;
  if (!resultSourceValid) {
    blockers.push(
      invalidBackendResult(
        "KICAD_SOURCE_REVISION_STALE",
        `KiCad backend result binds ${result.sourceRevisionDigest}, not expected source ${expectedDigest}.`,
        options.exactInputs,
        "Discard stale output and rerun KiCad generation against the current immutable input manifest."
      )
    );
  }
  const resultEnvelopeValid = resultSchemaValid && resultToolValid && resultSourceValid;

  const logicalNames = new Set<string>(
    options.initialArtifacts.map((artifact) => artifact.logicalName),
  );
  for (const generated of result.artifacts) {
    if (!safeLogicalName(generated.logicalName)) {
      blockers.push(
        invalidBackendResult(
          "KICAD_ARTIFACT_PATH_INVALID",
          "KiCad backend returned an unsafe or non-canonical logical artifact path.",
          options.exactInputs,
          "Return a workspace-relative forward-slash logical path without traversal or control characters."
        )
      );
    }
    if (logicalNames.has(generated.logicalName)) {
      blockers.push(
        invalidBackendResult(
          "KICAD_ARTIFACT_NAME_DUPLICATE",
          `KiCad backend returned duplicate logical artifact ${generated.logicalName}.`,
          options.exactInputs,
          "Return exactly one artifact for each logical path."
        )
      );
    }
    logicalNames.add(generated.logicalName);
    if (generated.content.byteLength === 0) {
      blockers.push(
        invalidBackendResult(
          "KICAD_ARTIFACT_EMPTY",
          `KiCad artifact ${generated.logicalName} is empty.`,
          options.exactInputs,
          "Capture the actual non-empty KiCad/export bytes."
        )
      );
    }
  }
  for (const role of options.requiredArtifactRoles) {
    if (
      !result.artifacts.some(
        (artifact) =>
          artifact.role === role &&
          safeLogicalName(artifact.logicalName) &&
          artifact.content.byteLength > 0
      )
    ) {
      blockers.push(
        invalidBackendResult(
          "KICAD_ARTIFACT_REQUIRED",
          `KiCad backend did not return required ${role} output for ${options.stage}.`,
          options.exactInputs,
          `Generate and return a non-empty ${role} artifact from the pinned KiCad backend.`
        )
      );
    }
  }

  const reportAuthorityValid = new Map<KicadBackendReport, boolean>();
  const pcbPracticeAnalyses = new Map<KicadBackendReport, PcbPracticeAnalysis>();
  const validNativeReports = new Map<string, KicadNativeReport>();
  const generatedArtifactsByName = new Map(
    result.artifacts.map((artifact) => [artifact.logicalName, artifact] as const)
  );
  const inputArtifactBindings = new Map(
    [...options.initialArtifacts, ...result.artifacts].map(
      (artifact) => [artifact.logicalName, contentIdentity(artifact.content)] as const,
    ),
  );
  for (const report of result.reports) {
    let structurallyValid = true;
    if (!safeLogicalName(report.logicalName)) {
      structurallyValid = false;
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_PATH_INVALID",
          "KiCad backend returned an unsafe or non-canonical report path.",
          options.exactInputs,
          "Return a workspace-relative forward-slash report path without traversal or control characters."
        )
      );
    }
    if (logicalNames.has(report.logicalName)) {
      structurallyValid = false;
      blockers.push(
        invalidBackendResult(
          "KICAD_ARTIFACT_NAME_DUPLICATE",
          `KiCad backend reused logical path ${report.logicalName} for more than one output.`,
          options.exactInputs,
          "Return one uniquely named artifact or report per logical path."
        )
      );
    }
    logicalNames.add(report.logicalName);
    if (report.sourceRevisionDigest !== expectedDigest) {
      structurallyValid = false;
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_STALE",
          `${report.kind} report ${report.logicalName} is not bound to the current source revision.`,
          options.exactInputs,
          "Discard the report and rerun the native check against the current isolated source copy."
        )
      );
    }
    if (report.content.byteLength === 0) {
      structurallyValid = false;
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_EMPTY",
          `${report.kind} report ${report.logicalName} is empty.`,
          options.exactInputs,
          "Return the non-empty raw native report bytes."
        )
      );
    }
    if (report.validationStatus !== "pass" && report.kind !== "pcb_practices") {
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_NOT_PASSING",
          `${report.kind} report status is ${report.validationStatus}; it cannot authorize continuation.`,
          options.exactInputs,
          "Resolve the native report findings and rerun; warnings, errors, unsupported, stale, and unknown results do not pass."
        )
      );
    }

    let authorityValid = false;
    try {
      if (report.evidenceClass === "kicad_native") {
        const prefix = KICAD_NATIVE_REPORT_COMMAND_PREFIXES[report.kind];
        authorityValid =
          report.authority.kind === "kicad_cli_output" &&
          report.authority.tool.adapter === "kicad_cli" &&
          validToolIdentity(report.authority.tool) &&
          report.authority.tool.executablePath.length > 0 &&
          /^[0-9a-f]{64}$/u.test(report.authority.tool.executableDigest) &&
          sameToolIdentity(report.authority.tool, result.tool) &&
          report.authority.command.every((part) => typeof part === "string" && part.length > 0) &&
          commandMatches(report.authority.command, prefix) &&
          commandDeclaresOutput(report.authority.command) &&
          sameIdentity(report.authority.outputIdentity, contentIdentity(report.content)) &&
          report.authority.sourceBindings.length > 0 &&
          report.authority.sourceBindings.every(validBinding) &&
          uniqueBindings(report.authority.sourceBindings);
        if (
          authorityValid &&
          structurallyValid &&
          resultEnvelopeValid &&
          report.validationStatus === "pass"
        ) {
          validNativeReports.set(report.logicalName, report);
        }
      } else if (report.evidenceClass === "evleda_check") {
        authorityValid =
          report.authority.kind === "evleda_analyzer" &&
          /^[a-z0-9][a-z0-9._-]*$/u.test(report.authority.analyzerId) &&
          report.authority.tool.adapter === "evleda" &&
          validToolIdentity(report.authority.tool) &&
          report.authority.tool.capabilityProfile === report.authority.analyzerId &&
          report.authority.inputBindings.length > 0 &&
          report.authority.inputBindings.every(validBinding) &&
          uniqueBindings(report.authority.inputBindings) &&
          new Set(
            report.authority.inputBindings.map(
              (binding) => `${binding.kind}:${binding.logicalName}`
            )
          ).size === report.authority.inputBindings.length;
      }
    } catch {
      authorityValid = false;
    }
    reportAuthorityValid.set(
      report,
      authorityValid && structurallyValid && resultEnvelopeValid
    );
    if (!authorityValid) {
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_AUTHORITY_INVALID",
          `${report.kind} report ${report.logicalName} lacks authority matching its claimed provenance.`,
          options.exactInputs,
          "Return direct kicad-cli bytes with exact command/output/source authority, or an EvlEDA check with an identified analyzer and exact input bindings."
        )
      );
    }
  }

  for (const report of result.reports) {
    if (report.evidenceClass !== "evleda_check" || !reportAuthorityValid.get(report)) {
      continue;
    }
    const boundNativeReports: KicadNativeReport[] = [];
    let bindingsValid = true;
    for (const binding of report.authority.inputBindings) {
      if (binding.kind === "artifact") {
        const actual = inputArtifactBindings.get(binding.logicalName);
        if (actual === undefined || !sameIdentity(actual, binding.identity)) {
          bindingsValid = false;
        }
      } else if (binding.kind === "native_report") {
        const nativeReport = validNativeReports.get(binding.logicalName);
        if (
          nativeReport === undefined ||
          nativeReport.evidenceClass !== "kicad_native" ||
          !sameIdentity(contentIdentity(nativeReport.content), binding.identity)
        ) {
          bindingsValid = false;
        } else {
          boundNativeReports.push(nativeReport);
        }
      }
    }
    const requiredArtifactRole = REQUIRED_DERIVED_ARTIFACT_ROLE[report.kind];
    if (
      requiredArtifactRole !== undefined &&
      !report.authority.inputBindings.some((binding) => {
        if (binding.kind !== "artifact") return false;
        const artifact = generatedArtifactsByName.get(binding.logicalName);
        return (
          artifact?.role === requiredArtifactRole &&
          sameIdentity(contentIdentity(artifact.content), binding.identity)
        );
      })
    ) {
      bindingsValid = false;
    }
    if (boundNativeReports.length === 0) {
      bindingsValid = false;
    }
    const requiredNativeKinds = [
      ...(REQUIRED_DERIVED_NATIVE_REPORTS[report.kind] ?? []),
      ...(report.kind === "connectivity" && options.stage !== "schematic"
        ? (["board_netlist"] as const)
        : [])
    ];
    if (
      requiredNativeKinds.some(
        (kind) => !boundNativeReports.some((nativeReport) => nativeReport.kind === kind)
      )
    ) {
      bindingsValid = false;
    }
    const expectedSourceBindings = new Set(
      boundNativeReports.flatMap((nativeReport) =>
        nativeReport.authority.sourceBindings.map(bindingKey)
      )
    );
    const suppliedSourceBindings = new Set(
      report.authority.inputBindings
        .filter(
          (binding): binding is KicadReportInputBinding & { readonly kind: "source" } =>
            binding.kind === "source"
        )
        .map(bindingKey)
    );
    if (
      suppliedSourceBindings.size !== expectedSourceBindings.size ||
      [...expectedSourceBindings].some((binding) => !suppliedSourceBindings.has(binding))
    ) {
      bindingsValid = false;
    }
    if (report.kind === "pcb_practices") {
      const analysis =
        options.stage === "pcb_placement_routing" && options.pcbEngineering !== undefined
          ? parsedPcbPracticeAnalysis(report, request, result.artifacts)
          : null;
      if (analysis === null) {
        bindingsValid = false;
      } else {
        pcbPracticeAnalyses.set(report, analysis);
      }
    }
    reportAuthorityValid.set(report, bindingsValid);
    if (!bindingsValid) {
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_BINDING_INVALID",
          `${report.kind} EvlEDA check does not bind the exact returned native report, artifact, and source identities.`,
          options.exactInputs,
          "Regenerate the derived check from returned native bytes and copy every exact native source binding into its analyzer authority."
        )
      );
    }
  }

  for (const kind of options.requiredReports) {
    const matching = result.reports.filter(
      (report) =>
        report.kind === kind &&
        report.evidenceClass === requiredEvidenceClass(kind) &&
        reportAuthorityValid.get(report) === true &&
        safeLogicalName(report.logicalName) &&
        report.content.byteLength > 0
    );
    if (matching.length === 0) {
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_MISSING",
          `Required authoritative ${kind} report is missing for ${options.stage}.`,
          options.exactInputs,
          `Return exactly one source-bound ${requiredEvidenceClass(kind)} ${kind} report.`
        )
      );
    } else if (matching.length > 1) {
      blockers.push(
        invalidBackendResult(
          "KICAD_REPORT_DUPLICATE",
          `KiCad backend returned multiple authoritative ${kind} reports for one source revision.`,
          options.exactInputs,
          `Return exactly one authoritative ${kind} report for the stage attempt.`
        )
      );
    }
  }

  const authoritativePcbPracticeReports = result.reports.filter(
    (report) =>
      report.kind === "pcb_practices" &&
      report.evidenceClass === "evleda_check" &&
      reportAuthorityValid.get(report) === true,
  );
  let engineeringDecisionSummary: ReturnType<
    typeof buildKicadPcbEngineeringDecisionSummary
  > | null = null;
  let pcbPracticeReportLogicalName: string | null = null;
  if (authoritativePcbPracticeReports.length === 1) {
    const report = authoritativePcbPracticeReports[0]!;
    const analysis = pcbPracticeAnalyses.get(report);
    if (analysis !== undefined) {
      pcbPracticeReportLogicalName = report.logicalName;
      engineeringDecisionSummary = buildKicadPcbEngineeringDecisionSummary(
        analysis,
        options.pcbEngineering?.engineeringConstraintBinding?.document ?? null,
      );
    }
  }
  const engineeringInputs = [
    ...options.exactInputs,
    ...result.artifacts
      .filter((artifact) => artifact.role === "pcb")
      .map((artifact) => contentIdentity(artifact.content)),
  ];
  if (engineeringDecisionSummary?.machine.gateFailed === true) {
    const hardEngineeringIssueCount =
      engineeringDecisionSummary.machine.failedGateIds.length +
      engineeringDecisionSummary.machine.hardFindingIds.length;
    blockers.push(
      blockerDraft(
        "PCB_ENGINEERING_GATE_FAILED",
        `Exact PCB engineering evaluation found ${hardEngineeringIssueCount.toString()} failed machine hard/calculation gate or routed-layout finding(s)${pcbPracticeReportLogicalName === null ? "." : `; the explicit machine/external split and full findings remain in ${pcbPracticeReportLogicalName}.`}`,
        engineeringInputs,
        "Resolve every failed machine hard/calculation gate and hard routed-layout finding against the exact PCB and bound plan/profile, then rerun native DRC and PCB practice analysis. External reviews are tracked separately and agent-authored exceptions are not accepted.",
      ),
    );
  }
  if (engineeringDecisionSummary?.machine.coverageIncomplete === true) {
    blockers.push(
      blockerDraft(
        "PCB_ENGINEERING_COVERAGE_INCOMPLETE",
        `Machine PCB applicability/input/checker or phase-1 routed-geometry coverage is unresolved${pcbPracticeReportLogicalName === null ? "." : `; the explicit coverage and external-gate summary remains in ${pcbPracticeReportLogicalName}.`}`,
        engineeringInputs,
        "Resolve every machine applicability/input/checker gap and replace unsupported or ambiguous routed/outline geometry with analyzable native geometry, or extend and revalidate the deterministic analyzer before rerunning. Do not infer a pass from missing coverage.",
      ),
    );
  }

  const backendPass = blockers.length === 0;
  for (const generated of result.artifacts) {
    if (!safeLogicalName(generated.logicalName) || generated.content.byteLength === 0) {
      continue;
    }
    artifacts.push(
      artifactDraft({
        logicalName: generated.logicalName,
        mediaType: generated.mediaType,
        content: generated.content,
        exactInputs: options.exactInputs,
        derivedFrom: options.initialArtifacts.map((artifact) => artifact.logicalName),
        tool: result.tool,
        validationStatus: backendPass ? "pass" : "fail"
      })
    );
  }
  for (const report of result.reports) {
    if (!safeLogicalName(report.logicalName) || report.content.byteLength === 0) {
      continue;
    }
    const authorityValid = reportAuthorityValid.get(report) === true;
    const reportStatus: ValidationStatus =
      report.sourceRevisionDigest !== expectedDigest
        ? "stale"
        : authorityValid
          ? report.validationStatus
          : "fail";
    const reportInputs = authorityValid
      ? sortedIdentities([...options.exactInputs, ...authorityInputs(report)])
      : options.exactInputs;
    const reportArtifact = artifactDraft({
      logicalName: report.logicalName,
      mediaType: report.mediaType,
      content: report.content,
      exactInputs: reportInputs,
      derivedFrom: authorityValid ? authorityDerivedFrom(report) : [],
      tool: authorityValid ? report.authority.tool : result.tool,
      validationStatus: reportStatus
    });
    artifacts.push(reportArtifact);
    if (authorityValid) {
      evidence.push(
        evidenceDraft({
          evidenceClass: report.evidenceClass,
          claim:
            report.evidenceClass === "kicad_native"
              ? `Direct kicad-cli ${report.kind} output for source revision ${report.sourceRevisionDigest}.`
              : `EvlEDA ${report.authority.analyzerId} ${report.kind} check over exact native inputs for source revision ${report.sourceRevisionDigest}.`,
          subjectDigests: [reportArtifact.identity.digest],
          ...(report.evidenceClass === "kicad_native"
            ? { rawArtifactLogicalName: report.logicalName }
            : { parsedArtifactLogicalName: report.logicalName }),
          exactInputs: reportInputs,
          tool: report.authority.tool,
          validationStatus: reportStatus
        })
      );
    }
  }
  return { artifacts, evidence, blockers };
};

interface SimulationRunOptions {
  readonly stage: Extract<StageKey, "simulation_checks">;
  readonly context: CandidateStageContext;
  readonly profile: ReferenceControllerProfile;
  readonly exactInputs: readonly ExactInputIdentity[];
  readonly initialArtifacts: readonly ArtifactDraft[];
  readonly initialEvidence?: readonly EvidenceDraft[];
  readonly initialBlockers: readonly BlockerDraft[];
  readonly requiredCoverage: readonly SimulationCoverageItem[];
}

export const runSimulationBackend = async (
  options: SimulationRunOptions
): Promise<BackendRunDrafts> => {
  const artifacts: ArtifactDraft[] = [...options.initialArtifacts];
  const evidence: EvidenceDraft[] = [...(options.initialEvidence ?? [])];
  const blockers: BlockerDraft[] = [...options.initialBlockers];
  if (blockers.length > 0) {
    return { artifacts, evidence, blockers };
  }
  const backend = options.context.simulationBackend;
  if (backend === undefined) {
    blockers.push(
      blockerDraft(
        "SIMULATION_BACKEND_MISSING",
        "No modeled-check/simulation backend is available.",
        options.exactInputs,
        "Configure a backend that returns captured model identities and raw reports for every required coverage item."
      )
    );
    return { artifacts, evidence, blockers };
  }
  const expectedDigest = expectedSourceRevisionDigest(options.stage, options.exactInputs);
  let result;
  try {
    result = await backend.execute({
      schemaVersion: "evleda.simulation-request.v1",
      expectedSourceRevisionDigest: expectedDigest,
      profile: options.profile,
      requirements: options.context.requirements,
      upstreamArtifactIdentities: upstreamArtifactIdentities(options.context)
    });
  } catch {
    blockers.push(
      blockerDraft(
        "SIMULATION_BACKEND_EXECUTION_FAILED",
        `Simulation backend ${backend.backendId} failed without a valid typed result.`,
        options.exactInputs,
        "Inspect the captured invocation, correct the tool/model failure, and rerun with identical inputs."
      )
    );
    return { artifacts, evidence, blockers };
  }

  if (result.schemaVersion !== "evleda.simulation-result.v1") {
    blockers.push(
      blockerDraft(
        "SIMULATION_RESULT_INVALID",
        "Simulation backend returned an incompatible result schema.",
        options.exactInputs,
        "Update the adapter to return evleda.simulation-result.v1."
      )
    );
  }
  if (result.sourceRevisionDigest !== expectedDigest) {
    blockers.push(
      blockerDraft(
        "SIMULATION_SOURCE_REVISION_STALE",
        `Simulation result binds ${result.sourceRevisionDigest}, not expected source ${expectedDigest}.`,
        options.exactInputs,
        "Discard stale simulation output and rerun from the current immutable source revision."
      )
    );
  }
  for (const coverageItem of options.requiredCoverage) {
    const reports = result.reports.filter(
      (report) =>
        report.coverageItem === coverageItem &&
        safeLogicalName(report.logicalName) &&
        report.content.byteLength > 0 &&
        isExactInputIdentity(report.modelIdentity)
    );
    if (reports.length === 0) {
      blockers.push(
        blockerDraft(
          "SIMULATION_REPORT_MISSING",
          `Required simulation/model report ${coverageItem} is missing.`,
          options.exactInputs,
          `Run and capture the ${coverageItem} model/check with its exact model identity.`
        )
      );
    } else if (reports.length > 1) {
      blockers.push(
        blockerDraft(
          "SIMULATION_REPORT_DUPLICATE",
          `Multiple authoritative reports were returned for ${coverageItem}.`,
          options.exactInputs,
          "Return exactly one authoritative report per required coverage item."
        )
      );
    }
  }
  const simulationLogicalNames = new Set<string>();
  for (const report of result.reports) {
    if (!safeLogicalName(report.logicalName)) {
      blockers.push(
        blockerDraft(
          "SIMULATION_REPORT_PATH_INVALID",
          "Simulation backend returned an unsafe or non-canonical report path.",
          options.exactInputs,
          "Return a workspace-relative forward-slash report path without traversal or control characters."
        )
      );
    }
    if (simulationLogicalNames.has(report.logicalName)) {
      blockers.push(
        blockerDraft(
          "SIMULATION_REPORT_DUPLICATE",
          `Simulation backend reused logical path ${report.logicalName}.`,
          options.exactInputs,
          "Return one uniquely named report per coverage item."
        )
      );
    }
    simulationLogicalNames.add(report.logicalName);
    if (!isExactInputIdentity(report.modelIdentity)) {
      blockers.push(
        blockerDraft(
          "SIMULATION_MODEL_IDENTITY_INVALID",
          `${report.coverageItem} does not bind a valid exact model identity.`,
          options.exactInputs,
          "Capture the exact model bytes or canonical model configuration identity and rerun."
        )
      );
    }
    if (report.sourceRevisionDigest !== expectedDigest) {
      blockers.push(
        blockerDraft(
          "SIMULATION_REPORT_STALE",
          `${report.coverageItem} report is not bound to the current source revision.`,
          options.exactInputs,
          "Discard the stale report and rerun from current source and model inputs."
        )
      );
    }
    if (report.content.byteLength === 0) {
      blockers.push(
        blockerDraft(
          "SIMULATION_REPORT_EMPTY",
          `${report.coverageItem} report has no captured bytes.`,
          options.exactInputs,
          "Capture and return the raw report bytes."
        )
      );
    }
    if (report.validationStatus !== "pass") {
      blockers.push(
        blockerDraft(
          "SIMULATION_REPORT_NOT_PASSING",
          `${report.coverageItem} status is ${report.validationStatus}; modeled coverage is insufficient.`,
          options.exactInputs,
          "Resolve the model/check failure or explicitly revise the design; unsupported and not-run do not pass."
        )
      );
    }
  }
  for (const report of result.reports) {
    if (
      !safeLogicalName(report.logicalName) ||
      report.content.byteLength === 0 ||
      !isExactInputIdentity(report.modelIdentity)
    ) {
      continue;
    }
    const reportInputs = [...options.exactInputs, report.modelIdentity];
    const reportArtifact = artifactDraft({
      logicalName: report.logicalName,
      mediaType: report.mediaType,
      content: report.content,
      exactInputs: reportInputs,
      derivedFrom: options.initialArtifacts.map((artifact) => artifact.logicalName),
      tool: result.tool,
      validationStatus:
        report.sourceRevisionDigest === expectedDigest ? report.validationStatus : "stale"
    });
    artifacts.push(reportArtifact);
    evidence.push(
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim: `Modeled coverage report for ${report.coverageItem}; model identity is captured but does not replace physical validation.`,
        subjectDigests: [reportArtifact.identity.digest],
        rawArtifactLogicalName: report.logicalName,
        exactInputs: reportInputs,
        tool: result.tool,
        validationStatus:
          report.sourceRevisionDigest === expectedDigest ? report.validationStatus : "stale"
      })
    );
  }
  return { artifacts, evidence, blockers };
};
